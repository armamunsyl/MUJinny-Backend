const admin = require('../config/firebaseAdmin');
const User = require('../models/User');

const verifyAdmin = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
        const user = await User.findOne({ email: new RegExp(`^${decoded.email}$`, 'i') });
        console.log(`[Admin] email: ${decoded.email} | found: ${!!user} | role: ${user?.role}`);
        if (!user || user.role?.toLowerCase() !== 'admin') {
            return res.status(403).json({
                error: 'Admin access required',
                debug: { email: decoded.email, found: !!user, role: user?.role || null }
            });
        }
        req.user = decoded;
        req.adminUser = user;
        next();
    } catch {
        return res.status(401).json({ error: 'Unauthorized' });
    }
};

module.exports = verifyAdmin;
