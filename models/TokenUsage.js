const mongoose = require('mongoose');

const tokenUsageSchema = new mongoose.Schema({
    userId:    { type: String, required: true },
    model:     { type: String, required: true },
    date:      { type: String, required: true }, // "YYYY-MM-DD" in Asia/Dhaka
    tokens:    { type: Number, default: 0 },
});

tokenUsageSchema.index({ userId: 1, model: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('TokenUsage', tokenUsageSchema);
