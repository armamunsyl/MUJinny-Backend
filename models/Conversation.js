const mongoose = require('mongoose');
const { randomUUID } = require('crypto');

const messageSchema = new mongoose.Schema(
    {
        messageId: {
            type: String,
            required: true,
            default: () => randomUUID(),
        },
        role: {
            type: String,
            required: true,
            trim: true,
        },
        content: {
            type: String,
            default: '',
        },
    },
    { _id: false }
);

const conversationSchema = new mongoose.Schema(
    {
        userId: {
            type: String,
            required: true,
            index: true,
        },
        title: {
            type: String,
            default: 'New Chat',
            trim: true,
        },
        messages: {
            type: [messageSchema],
            default: [],
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Conversation', conversationSchema);
