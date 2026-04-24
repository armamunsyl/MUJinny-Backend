require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const TokenUsage = require('../models/TokenUsage');
const User = require('../models/User');

async function run() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // Aggregate total tokens per firebaseUid from TokenUsage
    const agg = await TokenUsage.aggregate([
        { $match: { userId: { $not: /^anon:/ } } },
        { $group: { _id: '$userId', total: { $sum: '$tokens' } } },
    ]);

    let updated = 0;
    for (const { _id: firebaseUid, total } of agg) {
        const res = await User.updateOne(
            { firebaseUid },
            { $set: { totalTokens: total } }
        );
        if (res.modifiedCount) updated++;
    }

    console.log(`Backfilled totalTokens for ${updated} users (${agg.length} token records processed)`);
    await mongoose.disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });
