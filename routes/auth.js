const express = require('express');
const router = express.Router();
const verifyFirebaseToken = require('../middleware/verifyFirebaseToken');
const { syncUser } = require('../controllers/authController');

// POST /api/auth/sync
// Protected by verifyFirebaseToken middleware
router.post('/sync', verifyFirebaseToken, syncUser);

module.exports = router;
