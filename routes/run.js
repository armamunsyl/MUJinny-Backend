const express = require('express');
const Conversation = require('../models/Conversation');
const verifyFirebaseToken = require('../middleware/verifyFirebaseToken');
const codeRunner = require('../services/codeRunnerService');

const router = express.Router();

router.use(verifyFirebaseToken);

const writeSseEvent = (res, event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
};

router.post('/', async (req, res) => {
    try {
        const { chatId, messageId, language, code, stdin } = req.body;

        if (!chatId || !messageId || !language || typeof code !== 'string') {
            return res.status(400).json({ error: 'chatId, messageId, language, and code are required.' });
        }

        const conversation = await Conversation.findOne({ _id: chatId, userId: req.user.uid });
        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found.' });
        }

        const message = conversation.messages.find((item) => item.messageId === messageId);
        if (!message) {
            return res.status(404).json({ error: 'Message not found in this conversation.' });
        }

        const { runId } = await codeRunner.startRun({
            userId: req.user.uid,
            chatId,
            messageId,
            language,
            code,
            stdin,
        });

        res.status(201).json({ runId });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.userFacingMessage || error.message });
    }
});

router.get('/config', async (_req, res) => {
    try {
        res.json(codeRunner.getRuntimeStatus());
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.userFacingMessage || error.message });
    }
});

router.get('/stream', async (req, res) => {
    try {
        const { runId } = req.query;
        if (!runId) {
            return res.status(400).json({ error: 'runId is required.' });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        const subscription = codeRunner.subscribe(runId, req.user.uid, (event) => {
            writeSseEvent(res, event);
            if (event.type === 'exit') {
                res.end();
            }
        });

        if (!subscription) {
            const persisted = await codeRunner.getPersistedRun(runId, req.user.uid);
            if (!persisted) {
                writeSseEvent(res, { type: 'status', status: 'failed', data: 'Run not found.' });
                res.end();
                return;
            }

            if (persisted.stdout) {
                writeSseEvent(res, { type: 'stdout', data: persisted.stdout, ts: persisted.updatedAt?.getTime?.() || Date.now() });
            }
            if (persisted.stderr) {
                writeSseEvent(res, { type: 'stderr', data: persisted.stderr, ts: persisted.updatedAt?.getTime?.() || Date.now() });
            }
            writeSseEvent(res, {
                type: 'exit',
                data: persisted.status === 'completed' ? 'Execution finished.' : `Execution ${persisted.status.replace('_', ' ')}.`,
                status: persisted.status,
                exitCode: persisted.exitCode,
                ts: persisted.updatedAt?.getTime?.() || Date.now(),
            });
            res.end();
            return;
        }

        req.on('close', () => {
            subscription.unsubscribe();
        });
    } catch (error) {
        if (!res.headersSent) {
            res.status(error.statusCode || 500).json({ error: error.userFacingMessage || error.message });
            return;
        }

        writeSseEvent(res, { type: 'stderr', data: error.userFacingMessage || error.message, ts: Date.now() });
        res.end();
    }
});

router.post('/stop', async (req, res) => {
    try {
        const { runId } = req.body;
        if (!runId) {
            return res.status(400).json({ error: 'runId is required.' });
        }

        const payload = await codeRunner.stopRun(runId, req.user.uid);
        res.json(payload);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.userFacingMessage || error.message });
    }
});

module.exports = router;
