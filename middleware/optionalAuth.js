const admin = require('../config/firebaseAdmin');

// Attaches req.user if valid Bearer token is present.
// Otherwise attaches req.anonId from X-Anon-Id header.
const optionalAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        try {
            const idToken = authHeader.split('Bearer ')[1];
            req.user = await admin.auth().verifyIdToken(idToken);
        } catch {
            // invalid token — fall through to anonymous
        }
    }
    if (!req.user) {
        req.anonId = req.headers['x-anon-id'] || null;
    }
    next();
};

module.exports = optionalAuth;
