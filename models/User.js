const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    firebaseUid: { type: String, index: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    studentId: { type: Number, required: true },
    role: { type: String, default: "student", enum: ["student", "admin"] },
    plan: { type: String, default: "free", enum: ["free", "pro", "premium"] },
    batch: { type: Number, required: true },
    sec: {
        type: String,
        required: true,
        validate: {
            validator: function (v) {
                return /^[A-Z]$/.test(v); // Uppercase single letter
            },
            message: props => `${props.value} is not a valid section! Must be a single uppercase letter.`
        }
    },
    gender: { type: String, required: true },
    totalTokens: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    lastPurchased: { type: String, default: "" },
    lastActive: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
