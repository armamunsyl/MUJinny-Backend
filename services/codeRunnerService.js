const { createHash, randomUUID } = require('crypto');
const EventEmitter = require('events');
const { existsSync } = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const CodeRun = require('../models/CodeRun');

const DEFAULT_TIMEOUT_MS = Number(process.env.CODE_RUN_TIMEOUT_MS || 8000);
const DEFAULT_MEMORY_LIMIT = process.env.CODE_RUN_MEMORY || '256m';
const DEFAULT_CPU_LIMIT = process.env.CODE_RUN_CPU || '0.75';
const DEFAULT_PIDS_LIMIT = Number(process.env.CODE_RUN_PIDS || 64);
const DEFAULT_RUNS_PER_MINUTE = Number(process.env.CODE_RUNS_PER_MINUTE || 6);
const DEFAULT_MAX_CONCURRENT_RUNS = Number(process.env.CODE_RUN_MAX_CONCURRENT || 1);
const MAX_CODE_LENGTH = Number(process.env.CODE_RUN_MAX_CODE_LENGTH || 30000);
const MAX_OUTPUT_LENGTH = Number(process.env.CODE_RUN_MAX_OUTPUT_LENGTH || 120000);
const RUN_RETENTION_MS = Number(process.env.CODE_RUN_RETENTION_MS || 10 * 60 * 1000);
const COMMON_DOCKER_PATHS = [
    process.env.CODE_RUNNER_DOCKER_BIN,
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    '/Applications/Docker.app/Contents/Resources/bin/docker',
    path.join(os.homedir(), 'Library/Group Containers/group.com.docker/bin/docker'),
].filter(Boolean);

const FINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'timed_out']);

const LANGUAGE_SPECS = {
    python: {
        label: 'Python',
        image: process.env.CODE_RUNNER_IMAGE_PYTHON || 'python:3.11-alpine',
    },
    c: {
        label: 'C',
        image: process.env.CODE_RUNNER_IMAGE_C || 'gcc:13.2.0',
    },
    cpp: {
        label: 'C++',
        image: process.env.CODE_RUNNER_IMAGE_CPP || 'gcc:13.2.0',
    },
    java: {
        label: 'Java',
        image: process.env.CODE_RUNNER_IMAGE_JAVA || 'eclipse-temurin:21-jdk',
    },
};

const sanitizeOutput = (value = '') =>
    String(value).replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, '');

const extractTextContent = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const textParts = content
            .filter((item) => item && typeof item === 'object' && item.type === 'text')
            .map((item) => item.text || '')
            .filter(Boolean);
        if (textParts.length > 0) return textParts.join('\n');
        return 'Image Upload';
    }
    return '';
};

const shellEscape = (value) => `'${String(value).replace(/'/g, `'\"'\"'`)}'`;

const hashCode = (code) => createHash('sha256').update(code).digest('hex');

const createDockerUnavailableError = (message = 'Docker not installed or not running') => {
    const error = new Error(message);
    error.statusCode = 503;
    error.userFacingMessage = 'Docker not installed or not running';
    error.code = 'DOCKER_UNAVAILABLE';
    return error;
};

const extractJavaEntrypoint = (code) => {
    const publicMatch = code.match(/\bpublic\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    const classMatch = code.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/);
    const mainMatch = code.match(/\bpublic\s+static\s+void\s+main\s*\(/);

    if (!classMatch) {
        const error = new Error('Java code must define a class with a main method.');
        error.userFacingMessage = 'Java code must define a class with a `main` method. Use `public class Main` or another valid class name.';
        error.code = 'JAVA_CLASS_MISSING';
        throw error;
    }

    if (!mainMatch) {
        const error = new Error('Java main method not found');
        error.userFacingMessage = 'Java code needs a `public static void main(String[] args)` method to run.';
        error.code = 'JAVA_MAIN_MISSING';
        throw error;
    }

    const mainClass = publicMatch?.[1] || classMatch[1];
    const fileName = publicMatch?.[1] ? `${publicMatch[1]}.java` : 'Main.java';

    return { mainClass, fileName };
};

const buildExecutionPlan = (language, code) => {
    const spec = LANGUAGE_SPECS[language];
    if (!spec) {
        const error = new Error(`Unsupported language: ${language}`);
        error.code = 'LANGUAGE_UNSUPPORTED';
        throw error;
    }

    if (language === 'python') {
        return {
            ...spec,
            fileName: 'main.py',
            shellCommand: 'ulimit -f 1024 >/dev/null 2>&1 || true\nset -eu\npython3 main.py',
        };
    }

    if (language === 'c') {
        return {
            ...spec,
            fileName: 'main.c',
            shellCommand: 'ulimit -f 1024 >/dev/null 2>&1 || true\nset -eu\ngcc main.c -O2 -std=c11 -o main\n./main',
        };
    }

    if (language === 'cpp') {
        return {
            ...spec,
            fileName: 'main.cpp',
            shellCommand: 'ulimit -f 1024 >/dev/null 2>&1 || true\nset -eu\ng++ main.cpp -O2 -std=c++17 -o main\n./main',
        };
    }

    const javaPlan = extractJavaEntrypoint(code);
    return {
        ...spec,
        fileName: javaPlan.fileName,
        mainClass: javaPlan.mainClass,
        shellCommand: `ulimit -f 1024 >/dev/null 2>&1 || true\nset -eu\njavac ${shellEscape(javaPlan.fileName)}\njava ${shellEscape(javaPlan.mainClass)}`,
    };
};

const createCodeRunner = ({
    spawnImpl = spawn,
    spawnSyncImpl = spawnSync,
    codeRunModel = CodeRun,
    now = () => Date.now(),
    initialDockerStatus = null,
} = {}) => {
    const runs = new Map();
    const eventBus = new EventEmitter();
    const runTimestamps = new Map();
    const dockerStatus = initialDockerStatus || {
        available: false,
        binaryPath: null,
        reason: 'Docker preflight has not run yet.',
        checkedAt: null,
    };

    const resolveDockerBinary = () => {
        if (dockerStatus.binaryPath) return dockerStatus.binaryPath;

        const whichResult = spawnSyncImpl('which', ['docker'], { encoding: 'utf8' });
        if (whichResult.status === 0) {
            const binaryPath = whichResult.stdout.trim();
            if (binaryPath) return binaryPath;
        }

        for (const candidate of COMMON_DOCKER_PATHS) {
            if (candidate && existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    };

    const runDockerSync = (binaryPath, args) =>
        spawnSyncImpl(binaryPath, args, {
            encoding: 'utf8',
        });

    const checkDockerAvailability = ({ force = false } = {}) => {
        if (!force && dockerStatus.checkedAt) {
            return { ...dockerStatus };
        }

        const binaryPath = resolveDockerBinary();
        dockerStatus.checkedAt = now();
        dockerStatus.binaryPath = binaryPath;

        if (!binaryPath) {
            dockerStatus.available = false;
            dockerStatus.reason = 'Docker binary not found. Install Docker Desktop and make sure `docker` is on PATH.';
            return { ...dockerStatus };
        }

        const versionResult = runDockerSync(binaryPath, ['--version']);
        if (versionResult.error || versionResult.status !== 0) {
            dockerStatus.available = false;
            dockerStatus.reason = 'Docker binary found, but `docker --version` failed.';
            return { ...dockerStatus };
        }

        const psResult = runDockerSync(binaryPath, ['ps']);
        if (psResult.error || psResult.status !== 0) {
            dockerStatus.available = false;
            dockerStatus.reason = 'Docker daemon is not running. Open Docker Desktop, wait until it is ready, then restart the backend.';
            return { ...dockerStatus };
        }

        dockerStatus.available = true;
        dockerStatus.reason = '';
        return { ...dockerStatus };
    };

    const ensureDockerAvailability = () => {
        const status = checkDockerAvailability();
        if (!status.available || !status.binaryPath) {
            throw createDockerUnavailableError(status.reason);
        }
        return status;
    };

    const pruneRunHistory = (userId) => {
        const cutoff = now() - 60_000;
        const kept = (runTimestamps.get(userId) || []).filter((ts) => ts >= cutoff);
        runTimestamps.set(userId, kept);
        return kept;
    };

    const getConcurrentRuns = (userId) =>
        [...runs.values()].filter((run) => run.userId === userId && !FINAL_STATUSES.has(run.status)).length;

    const assertRateLimits = (userId) => {
        const timestamps = pruneRunHistory(userId);
        if (timestamps.length >= DEFAULT_RUNS_PER_MINUTE) {
            const error = new Error('Rate limit exceeded');
            error.statusCode = 429;
            error.userFacingMessage = `You can run at most ${DEFAULT_RUNS_PER_MINUTE} code executions per minute.`;
            throw error;
        }

        if (getConcurrentRuns(userId) >= DEFAULT_MAX_CONCURRENT_RUNS) {
            const error = new Error('Concurrent run limit exceeded');
            error.statusCode = 429;
            error.userFacingMessage = 'Only one code execution can run at a time.';
            throw error;
        }

        timestamps.push(now());
        runTimestamps.set(userId, timestamps);
    };

    const broadcast = (run, event) => {
        const payload = {
            ...event,
            ts: event.ts || now(),
            data: event.data !== undefined ? sanitizeOutput(event.data) : '',
        };

        if (payload.type === 'stdout') {
            run.stdout = `${run.stdout}${payload.data}`.slice(-MAX_OUTPUT_LENGTH);
        } else if (payload.type === 'stderr') {
            run.stderr = `${run.stderr}${payload.data}`.slice(-MAX_OUTPUT_LENGTH);
        } else if (payload.type === 'status' && payload.status) {
            run.status = payload.status;
        }

        run.events.push(payload);
        if (run.events.length > 500) run.events.shift();
        eventBus.emit(run.runId, payload);
    };

    const createRunDoc = async (payload) => codeRunModel.create(payload);

    const persistRun = async (run) => {
        const durationMs = run.startedAt ? Math.max(0, now() - run.startedAt) : null;
        run.durationMs = durationMs;

        await codeRunModel.findOneAndUpdate(
            { runId: run.runId },
            {
                status: run.status,
                exitCode: run.exitCode,
                stdout: run.stdout,
                stderr: run.stderr,
                durationMs,
            }
        );
    };

    const spawnCommand = (args, options = {}) =>
        new Promise((resolve, reject) => {
            const status = ensureDockerAvailability();
            const child = spawnImpl(status.binaryPath, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                ...options,
            });

            let stdout = '';
            let stderr = '';

            child.stdout?.on('data', (chunk) => {
                stdout += chunk.toString();
            });

            child.stderr?.on('data', (chunk) => {
                stderr += chunk.toString();
            });

            child.on('error', (error) => {
                if (error.code === 'ENOENT') {
                    reject(createDockerUnavailableError());
                    return;
                }
                reject(error);
            });
            child.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout, stderr, code });
                    return;
                }

                const error = new Error(stderr || stdout || `docker ${args[0]} failed`);
                error.stdout = stdout;
                error.stderr = stderr;
                error.exitCode = code;
                reject(error);
            });

            if (options.input) {
                child.stdin?.write(options.input);
            }
            child.stdin?.end();
        });

    const removeContainer = async (containerName) => {
        if (!containerName) return;
        try {
            await spawnCommand(['rm', '-f', containerName]);
        } catch {}
    };

    const cleanupRunFiles = async (run) => {
        if (run.timeoutHandle) clearTimeout(run.timeoutHandle);
        await removeContainer(run.containerName);
        if (run.workspaceDir) {
            try {
                await fs.rm(run.workspaceDir, { recursive: true, force: true });
            } catch {}
        }
    };

    const finalizeRun = async (run, status, exitCode = null, extra = {}) => {
        if (run.finalized) return;
        run.finalized = true;
        run.status = status;
        run.exitCode = exitCode;

        if (extra.stdout) {
            run.stdout = `${run.stdout}${sanitizeOutput(extra.stdout)}`.slice(-MAX_OUTPUT_LENGTH);
        }
        if (extra.stderr) {
            run.stderr = `${run.stderr}${sanitizeOutput(extra.stderr)}`.slice(-MAX_OUTPUT_LENGTH);
        }

        await persistRun(run);
        broadcast(run, {
            type: 'exit',
            status,
            exitCode,
            data: status === 'completed' ? 'Execution finished.' : `Execution ${status.replace('_', ' ')}.`,
        });

        const evictionTimer = setTimeout(() => {
            runs.delete(run.runId);
        }, RUN_RETENTION_MS);
        evictionTimer.unref?.();
    };

    const createDockerArgs = (run, plan) => [
        'create',
        '--name',
        run.containerName,
        '--network',
        'none',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=64m',
        '--tmpfs',
        '/workspace:rw,exec,nosuid,size=64m',
        '--workdir',
        '/workspace',
        '--memory',
        DEFAULT_MEMORY_LIMIT,
        '--cpus',
        String(DEFAULT_CPU_LIMIT),
        '--pids-limit',
        String(DEFAULT_PIDS_LIMIT),
        '--security-opt',
        'no-new-privileges',
        '--cap-drop',
        'ALL',
        '--user',
        '1000:1000',
        '-i',
        plan.image,
        'sh',
        '-lc',
        plan.shellCommand,
    ];

    const runExecution = async (run) => {
        let closeCode = null;

        try {
            const dockerRuntime = ensureDockerAvailability();
            const plan = buildExecutionPlan(run.language, run.code);
            run.workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mugpt-run-'));
            run.containerName = `mugpt-${run.runId}`;

            await fs.writeFile(path.join(run.workspaceDir, plan.fileName), run.code, 'utf8');

            broadcast(run, { type: 'status', status: 'queued', data: 'Preparing sandbox...' });
            await spawnCommand(createDockerArgs(run, plan));
            await spawnCommand(['cp', `${run.workspaceDir}/.`, `${run.containerName}:/workspace/`]);

            if (run.stopRequested) {
                await finalizeRun(run, 'stopped', null);
                return;
            }

            run.status = 'running';
            await codeRunModel.findOneAndUpdate({ runId: run.runId }, { status: 'running' });
            broadcast(run, { type: 'status', status: 'running', data: `Running ${plan.label}...` });

            const child = spawnImpl(dockerRuntime.binaryPath, ['start', '-a', '-i', run.containerName], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            run.process = child;

            run.timeoutHandle = setTimeout(async () => {
                run.abortReason = 'timed_out';
                broadcast(run, { type: 'status', status: 'timed_out', data: 'Execution timed out.' });
                await removeContainer(run.containerName);
                child.kill('SIGKILL');
            }, DEFAULT_TIMEOUT_MS);
            run.timeoutHandle.unref?.();

            child.stdout?.on('data', (chunk) => {
                broadcast(run, { type: 'stdout', data: chunk.toString() });
            });

            child.stderr?.on('data', (chunk) => {
                broadcast(run, { type: 'stderr', data: chunk.toString() });
            });

            if (run.stdin) {
                child.stdin?.write(run.stdin);
            }
            child.stdin?.end();

            closeCode = await new Promise((resolve, reject) => {
                child.on('error', (error) => {
                    if (error.code === 'ENOENT') {
                        reject(createDockerUnavailableError());
                        return;
                    }
                    reject(error);
                });
                child.on('close', resolve);
            });

            if (run.abortReason === 'timed_out') {
                await finalizeRun(run, 'timed_out', closeCode);
                return;
            }

            if (run.stopRequested) {
                await finalizeRun(run, 'stopped', closeCode);
                return;
            }

            await finalizeRun(run, closeCode === 0 ? 'completed' : 'failed', closeCode);
        } catch (error) {
            if (error.userFacingMessage) {
                broadcast(run, { type: 'stderr', data: `${error.userFacingMessage}\n` });
            } else if (error.stderr || error.message) {
                broadcast(run, { type: 'stderr', data: `${error.stderr || error.message}\n` });
            }

            const finalStatus = run.stopRequested ? 'stopped' : run.abortReason === 'timed_out' ? 'timed_out' : 'failed';
            await finalizeRun(run, finalStatus, closeCode ?? error.exitCode ?? 1);
        } finally {
            await cleanupRunFiles(run);
        }
    };

    const startRun = async ({ userId, chatId, messageId, language, code, stdin = '' }) => {
        ensureDockerAvailability();

        if (!LANGUAGE_SPECS[language]) {
            const error = new Error('Unsupported language');
            error.statusCode = 400;
            throw error;
        }

        if (typeof code !== 'string' || code.trim().length === 0) {
            const error = new Error('Code is required');
            error.statusCode = 400;
            throw error;
        }

        if (code.length > MAX_CODE_LENGTH) {
            const error = new Error(`Code length exceeds ${MAX_CODE_LENGTH} characters`);
            error.statusCode = 400;
            throw error;
        }

        assertRateLimits(userId);

        const runId = randomUUID();
        const run = {
            runId,
            userId,
            chatId,
            messageId,
            language,
            code,
            stdin: typeof stdin === 'string' ? stdin : '',
            codeHash: hashCode(code),
            createdAt: now(),
            startedAt: now(),
            status: 'queued',
            stdout: '',
            stderr: '',
            exitCode: null,
            events: [],
            finalized: false,
            stopRequested: false,
            abortReason: null,
            process: null,
            containerName: null,
            workspaceDir: null,
            timeoutHandle: null,
        };

        await createRunDoc({
            userId,
            chatId,
            messageId,
            runId,
            language,
            codeHash: run.codeHash,
            status: 'queued',
            stdout: '',
            stderr: '',
        });

        runs.set(runId, run);
        runExecution(run).catch(async (error) => {
            if (!run.finalized) {
                broadcast(run, { type: 'stderr', data: `${error.message}\n` });
                await finalizeRun(run, 'failed', 1);
            }
            await cleanupRunFiles(run);
        });

        return { runId };
    };

    const stopRun = async (runId, userId) => {
        const run = runs.get(runId);

        if (!run) {
            const persisted = await codeRunModel.findOne({ runId, userId });
            if (!persisted) {
                const error = new Error('Run not found');
                error.statusCode = 404;
                throw error;
            }

            if (FINAL_STATUSES.has(persisted.status)) {
                return { runId, status: persisted.status };
            }

            const error = new Error('Run is not available in memory');
            error.statusCode = 409;
            throw error;
        }

        if (run.userId !== userId) {
            const error = new Error('Forbidden');
            error.statusCode = 403;
            throw error;
        }

        if (FINAL_STATUSES.has(run.status)) {
            return { runId, status: run.status };
        }

        run.stopRequested = true;
        broadcast(run, { type: 'status', status: 'running', data: 'Stopping execution...' });
        await removeContainer(run.containerName);
        run.process?.kill('SIGKILL');

        return { runId, status: 'stopping' };
    };

    const subscribe = (runId, userId, onEvent) => {
        const run = runs.get(runId);
        if (!run) return null;
        if (run.userId !== userId) {
            const error = new Error('Forbidden');
            error.statusCode = 403;
            throw error;
        }

        run.events.forEach((event) => onEvent(event));
        const listener = (event) => onEvent(event);
        eventBus.on(runId, listener);

        return {
            run,
            unsubscribe: () => eventBus.off(runId, listener),
        };
    };

    const getRun = (runId) => runs.get(runId) || null;

    const getPersistedRun = async (runId, userId) => codeRunModel.findOne({ runId, userId });

    return {
        checkDockerAvailability,
        startRun,
        stopRun,
        subscribe,
        getRun,
        getPersistedRun,
        getRuntimeStatus: () => {
            const status = checkDockerAvailability();
            return {
                enabled: status.available,
                binaryPath: status.binaryPath,
                reason: status.reason,
                checkedAt: status.checkedAt,
            };
        },
    };
};

const codeRunner = createCodeRunner();

module.exports = codeRunner;
module.exports.createCodeRunner = createCodeRunner;
module.exports._internal = {
    LANGUAGE_SPECS,
    buildExecutionPlan,
    extractJavaEntrypoint,
    extractTextContent,
    hashCode,
    sanitizeOutput,
};
