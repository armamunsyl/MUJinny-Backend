const express = require('express');
const router  = express.Router();
const verifyFirebaseToken = require('../middleware/verifyFirebaseToken');
const { generatePdf, saveSnapshot, getLatestSnapshot } = require('../controllers/pdfController');

// POST /api/pdf/generate  — stream PDF to browser
router.post('/generate', verifyFirebaseToken, generatePdf);

// POST /api/pdf/snapshot  — save MCQ snapshot for later export
router.post('/snapshot', verifyFirebaseToken, saveSnapshot);

// GET  /api/pdf/snapshot/:chatId — fetch latest MCQ snapshot for a chat
router.get('/snapshot/:chatId', verifyFirebaseToken, getLatestSnapshot);

module.exports = router;
