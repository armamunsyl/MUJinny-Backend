const mongoose = require('mongoose');

const codeRunSchema = new mongoose.Schema(
    {
        userId: {
            type: String,
            required: true,
            index: true,
        },
        chatId: {
            type: String,
            required: true,
            index: true,
        },
        messageId: {
            type: String,
            required: true,
            index: true,
        },
        runId: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
        language: {
            type: String,
            required: true,
            enum: ['c', 'cpp', 'java', 'python'],
        },
        codeHash: {
            type: String,
            required: true,
        },
        status: {
            type: String,
            required: true,
            default: 'queued',
        },
        exitCode: {
            type: Number,
            default: null,
        },
        stdout: {
            type: String,
            default: '',
        },
        stderr: {
            type: String,
            default: '',
        },
        durationMs: {
            type: Number,
            default: null,
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('CodeRun', codeRunSchema);
