const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { setTimeout: delay } = require('timers/promises');
const { createCodeRunner } = require('../services/codeRunnerService');

const createFakeModel = () => {
    const docs = [];

    return {
        docs,
        async create(payload) {
            const doc = {
                _id: payload.runId,
                ...payload,
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            docs.push(doc);
            return doc;
        },
        async findOne(query) {
            return (
                docs.find((doc) =>
                    Object.entries(query).every(([key, value]) => doc[key] === value)
                ) || null
            );
        },
        async findOneAndUpdate(query, update) {
            const doc = await this.findOne(query);
            if (!doc) return null;
            Object.assign(doc, update, { updatedAt: new Date() });
            return doc;
        },
    };
};

const createProcess = ({ onEnd, onKill, autoClose = true }) => {
    const process = new EventEmitter();
    process.stdout = new EventEmitter();
    process.stderr = new EventEmitter();

    let stdinBuffer = '';

    process.stdin = {
        write(chunk) {
            stdinBuffer += chunk.toString();
        },
        end() {
            if (autoClose && onEnd) {
                onEnd({ process, stdinBuffer });
            }
        },
    };

    process.kill = () => {
        if (onKill) {
            onKill({ process, stdinBuffer });
        } else {
            setImmediate(() => process.emit('close', 137));
        }
    };

    return process;
};

const waitFor = async (predicate, timeoutMs = 1200) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await delay(10);
    }
    throw new Error('Timed out waiting for condition');
};

const availableDockerStatus = {
    available: true,
    binaryPath: '/usr/bin/docker',
    reason: '',
    checkedAt: Date.now(),
};

test('captures compile errors for C runs', async () => {
    const model = createFakeModel();
    const spawnImpl = (_command, args) => {
        if (args[0] === 'create' || args[0] === 'cp' || args[0] === 'rm') {
            const process = createProcess({
                onEnd: ({ process: child }) => setImmediate(() => child.emit('close', 0)),
            });
            return process;
        }

        if (args[0] === 'start') {
            return createProcess({
                onEnd: ({ process: child }) => {
                    setImmediate(() => {
                        child.stderr.emit('data', Buffer.from('main.c:1: error: expected declaration\n'));
                        child.emit('close', 1);
                    });
                },
            });
        }

        throw new Error(`Unexpected docker command: ${args.join(' ')}`);
    };

    const runner = createCodeRunner({ spawnImpl, codeRunModel: model, initialDockerStatus: availableDockerStatus });
    const { runId } = await runner.startRun({
        userId: 'user-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        language: 'c',
        code: 'int main( { return 0; }',
    });

    await waitFor(() => model.docs[0]?.status === 'failed');

    const run = await runner.getPersistedRun(runId, 'user-1');
    assert.equal(run.status, 'failed');
    assert.match(run.stderr, /error/);
});

test('captures runtime errors for Python runs', async () => {
    const model = createFakeModel();
    const spawnImpl = (_command, args) => {
        if (args[0] === 'create' || args[0] === 'cp' || args[0] === 'rm') {
            return createProcess({
                onEnd: ({ process: child }) => setImmediate(() => child.emit('close', 0)),
            });
        }

        if (args[0] === 'start') {
            return createProcess({
                onEnd: ({ process: child }) => {
                    setImmediate(() => {
                        child.stderr.emit('data', Buffer.from('Traceback (most recent call last):\nZeroDivisionError\n'));
                        child.emit('close', 1);
                    });
                },
            });
        }

        throw new Error(`Unexpected docker command: ${args.join(' ')}`);
    };

    const runner = createCodeRunner({ spawnImpl, codeRunModel: model, initialDockerStatus: availableDockerStatus });
    const { runId } = await runner.startRun({
        userId: 'user-1',
        chatId: 'chat-1',
        messageId: 'msg-2',
        language: 'python',
        code: 'print(1/0)',
    });

    await waitFor(() => model.docs[0]?.status === 'failed');

    const run = await runner.getPersistedRun(runId, 'user-1');
    assert.equal(run.status, 'failed');
    assert.match(run.stderr, /ZeroDivisionError/);
});

test('passes stdin through to the running program', async () => {
    const model = createFakeModel();
    const spawnImpl = (_command, args) => {
        if (args[0] === 'create' || args[0] === 'cp' || args[0] === 'rm') {
            return createProcess({
                onEnd: ({ process: child }) => setImmediate(() => child.emit('close', 0)),
            });
        }

        if (args[0] === 'start') {
            return createProcess({
                onEnd: ({ process: child, stdinBuffer }) => {
                    setImmediate(() => {
                        child.stdout.emit('data', Buffer.from(`echo:${stdinBuffer}`));
                        child.emit('close', 0);
                    });
                },
            });
        }

        throw new Error(`Unexpected docker command: ${args.join(' ')}`);
    };

    const runner = createCodeRunner({ spawnImpl, codeRunModel: model, initialDockerStatus: availableDockerStatus });
    const { runId } = await runner.startRun({
        userId: 'user-1',
        chatId: 'chat-1',
        messageId: 'msg-3',
        language: 'python',
        code: 'print(input())',
        stdin: 'hello from stdin',
    });

    await waitFor(() => model.docs[0]?.status === 'completed');

    const run = await runner.getPersistedRun(runId, 'user-1');
    assert.equal(run.status, 'completed');
    assert.match(run.stdout, /hello from stdin/);
});

test('stops a running execution cleanly', async () => {
    const model = createFakeModel();
    let activeProcess = null;

    const spawnImpl = (_command, args) => {
        if (args[0] === 'create' || args[0] === 'cp' || args[0] === 'rm') {
            return createProcess({
                onEnd: ({ process: child }) => setImmediate(() => child.emit('close', 0)),
            });
        }

        if (args[0] === 'start') {
            activeProcess = createProcess({
                autoClose: false,
                onKill: ({ process: child }) => {
                    setImmediate(() => child.emit('close', 137));
                },
            });
            return activeProcess;
        }

        throw new Error(`Unexpected docker command: ${args.join(' ')}`);
    };

    const runner = createCodeRunner({ spawnImpl, codeRunModel: model, initialDockerStatus: availableDockerStatus });
    const { runId } = await runner.startRun({
        userId: 'user-1',
        chatId: 'chat-1',
        messageId: 'msg-4',
        language: 'python',
        code: 'while True:\n    pass',
    });

    await waitFor(() => activeProcess !== null);
    await runner.stopRun(runId, 'user-1');
    await waitFor(() => model.docs[0]?.status === 'stopped');

    const run = await runner.getPersistedRun(runId, 'user-1');
    assert.equal(run.status, 'stopped');
});
