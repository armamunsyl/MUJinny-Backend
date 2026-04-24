const express = require('express');
const router = express.Router();
const verifyAdmin = require('../middleware/verifyAdmin');
const User = require('../models/User');
const TokenUsage = require('../models/TokenUsage');

router.use(verifyAdmin);

const getDhakaDate = (daysAgo = 0) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
};

const last14Days = () => Array.from({ length: 14 }, (_, i) => getDhakaDate(13 - i));

router.get('/stats', async (req, res) => {
    try {
        const [
            totalUsers,
            totalTokensAgg,   // sum of User.totalTokens (always accurate)
            todayTokensAgg,
            modelBreakdown,
            dailyRaw,
            perUserRaw,
            batchUsers,
        ] = await Promise.all([
            User.countDocuments(),

            // Use stored totalTokens on User — always in sync
            User.aggregate([
                { $group: { _id: null, total: { $sum: '$totalTokens' } } },
            ]),

            TokenUsage.aggregate([
                { $match: { userId: { $not: /^anon:/ }, date: getDhakaDate() } },
                { $group: { _id: null, total: { $sum: '$tokens' } } },
            ]),

            TokenUsage.aggregate([
                { $match: { userId: { $not: /^anon:/ } } },
                { $group: { _id: '$model', tokens: { $sum: '$tokens' } } },
                { $sort: { tokens: -1 } },
            ]),

            TokenUsage.aggregate([
                { $match: { date: { $in: last14Days() }, userId: { $not: /^anon:/ } } },
                { $group: { _id: '$date', tokens: { $sum: '$tokens' } } },
            ]),

            // Per-user: use stored totalTokens directly from User
            User.aggregate([
                { $match: { totalTokens: { $gt: 0 } } },
                { $sort: { totalTokens: -1 } },
                { $limit: 100 },
                { $project: { _id: '$firebaseUid', tokens: '$totalTokens', name: 1, email: 1, batch: 1, studentId: 1, lastActive: 1 } },
            ]),

            User.aggregate([
                { $group: { _id: '$batch', count: { $sum: 1 } } },
                { $sort: { _id: 1 } },
            ]),
        ]);

        // Daily usage for last 14 days
        const dailyMap = Object.fromEntries(dailyRaw.map((d) => [d._id, d.tokens]));
        const dailyUsage = last14Days().map((date) => ({ date, tokens: dailyMap[date] || 0 }));

        // perUserRaw already has all fields from the User aggregate above
        const perUser = perUserRaw.map((u) => ({
            tokens: u.tokens,
            name: u.name,
            email: u.email,
            batch: u.batch,
            studentId: u.studentId,
            lastActive: u.lastActive,
        }));

        // Batchwise: sum totalTokens directly from User collection
        const batchTokens = await User.aggregate([
            { $group: { _id: '$batch', tokens: { $sum: '$totalTokens' } } },
        ]);
        const batchTokenMap = Object.fromEntries(batchTokens.map((b) => [b._id, b.tokens]));
        const batchAnalytics = batchUsers.map((b) => ({
            batch: b._id,
            userCount: b.count,
            tokens: batchTokenMap[b._id] || 0,
        }));

        res.json({
            totalUsers,
            totalTokens: totalTokensAgg[0]?.total || 0,   // from User.totalTokens sum
            todayTokens: todayTokensAgg[0]?.total || 0,
            modelBreakdown: modelBreakdown.map((m) => ({ model: m._id, tokens: m.tokens })),
            dailyUsage,
            perUser,
            batchAnalytics,
        });
    } catch (error) {
        console.error('[admin/stats]', error);
        res.status(500).json({ error: error.message });
    }
});

// List all users — totalTokens is stored directly on each User document
router.get('/users', async (req, res) => {
    try {
        const users = await User.find().sort({ createdAt: -1 }).select('-__v').lean();
        // Expose totalTokens as `tokens` for frontend compatibility
        const result = users.map(u => ({ ...u, tokens: u.totalTokens || 0 }));
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
