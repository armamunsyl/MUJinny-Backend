const User = require('../models/User');

const syncUser = async (req, res) => {
    try {
        // req.user is populated by the verifyFirebaseToken middleware
        const decodedToken = req.user;

        // Use email from decoded token for security, fallback to body if needed (though token is safer)
        const email = decodedToken.email || req.body.email;

        if (!email) {
            return res.status(400).json({ error: "Email is required" });
        }

        const {
            name,
            studentId,
            batch,
            sec,
            gender
        } = req.body;

        // Check if user exists
        let user = await User.findOne({ email });

        if (user) {
            user.lastActive = new Date();
            if (!user.firebaseUid) user.firebaseUid = decodedToken.uid;
            await user.save({ validateBeforeSave: false });
        } else {
            // Only create if registration fields are present
            if (!name || !studentId || !batch || !sec || !gender) {
                return res.status(404).json({ error: "User not registered" });
            }
            user = new User({
                firebaseUid: decodedToken.uid,
                name,
                email,
                studentId,
                batch,
                sec,
                gender,
                lastActive: new Date(),
                createdAt: new Date()
            });
            await user.save();
        }

        return res.status(200).json(user);

    } catch (error) {
        console.error("Error in syncUser controller:", error);
        return res.status(500).json({ error: "Internal server error during user synchronization" });
    }
};

module.exports = {
    syncUser
};
