const mongoose = require('mongoose');

const exportSchema = new mongoose.Schema(
    {
        userId: { type: String, required: true, index: true },
        chatId: { type: String, required: true, index: true },
        type:   { type: String, default: 'mcq' },
        title:  { type: String, default: 'MCQ Set' },
        content:{ type: String, required: true },
    },
    { timestamps: true }
);

// Fast lookup: latest snapshot for a user+chat
exportSchema.index({ userId: 1, chatId: 1, createdAt: -1 });

module.exports = mongoose.model('Export', exportSchema);
