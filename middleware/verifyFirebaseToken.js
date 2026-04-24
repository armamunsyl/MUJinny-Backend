const admin = require('../config/firebaseAdmin');

const verifyFirebaseToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
        }

        const idToken = authHeader.split('Bearer ')[1];

        // Verify the token
        const decodedToken = await admin.auth().verifyIdToken(idToken);

        // Attach the decoded user object to request
        req.user = decodedToken;

        next();
    } catch (error) {
        console.error('Error verifying Firebase token:', error);
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
};

module.exports = verifyFirebaseToken;
