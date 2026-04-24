'use strict';

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const router    = express.Router();
const Faculty   = require('../models/Faculty');
const { runScrape } = require('../services/facultyScraper');
const { searchFaculty, getAllFaculty, reloadFacultyData } = require('../services/facultySearch');
const verifyFirebaseToken = require('../middleware/verifyFirebaseToken');

const JSON_DATA_PATH = path.join(__dirname, '..', 'data', 'faculty.json');

// ─── Helper: export DB → faculty.json ───────────────────────────────────────
const exportFacultyToJson = async () => {
    const records = await Faculty.find({}, {
        _id: 0,
        university: 1, name: 1, designation: 1, department: 1,
        email: 1, phone: 1, profileUrl: 1, photoUrl: 1,
        officeLocation: 1, bio: 1, education: 1,
        researchInterests: 1, publications: 1, awards: 1,
        socialLinks: 1, searchKeys: 1, lastScrapedAt: 1,
    }).sort({ department: 1, name: 1 }).lean();

    const out = {
        generatedAt: new Date().toISOString(),
        totalCount:  records.length,
        faculty:     records,
    };
    fs.mkdirSync(path.dirname(JSON_DATA_PATH), { recursive: true });
    fs.writeFileSync(JSON_DATA_PATH, JSON.stringify(out, null, 2), 'utf8');
    console.log(`[faculty] Exported ${records.length} records → faculty.json`);
    return records.length;
};

let scrapeStatus = { running: false, lastRun: null, lastResult: null };

// GET /api/faculty/search?q=jakaria
router.get('/search', (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (!q) return res.status(400).json({ error: 'q is required' });
        const results = searchFaculty(q, Number(req.query.limit) || 5);
        res.json({ results, count: results.length });
    } catch (err) {
        console.error('[faculty] search error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/faculty/list?department=CSE&page=1&limit=20
router.get('/list', (req, res) => {
    try {
        const dept  = String(req.query.department || '').toLowerCase();
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(100, parseInt(req.query.limit) || 20);
        let all = getAllFaculty();
        if (dept) all = all.filter((f) => (f.department || '').toLowerCase().includes(dept));
        const total = all.length;
        const data  = all.slice((page - 1) * limit, page * limit);
        res.json({ total, page, limit, data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/faculty/json  →  serve the raw JSON file
router.get('/json', (_req, res) => {
    if (!fs.existsSync(JSON_DATA_PATH)) {
        return res.status(404).json({ error: 'faculty.json not found. Run /admin/scrape first.' });
    }
    res.setHeader('Content-Type', 'application/json');
    res.sendFile(JSON_DATA_PATH);
});

// GET /api/faculty/stats
router.get('/stats', (_req, res) => {
    try {
        const all = getAllFaculty();
        const byDept = {};
        for (const f of all) {
            const d = f.department || 'Unknown';
            byDept[d] = (byDept[d] || 0) + 1;
        }
        const withPhone = all.filter((f) => f.phone?.length).length;
        const withEmail = all.filter((f) => f.email?.length).length;
        res.json({ total: all.length, byDepartment: byDept, withPhone, withEmail });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/faculty/admin/scrape  (protected)
router.post('/admin/scrape', verifyFirebaseToken, async (req, res) => {
    if (scrapeStatus.running) {
        return res.status(409).json({ error: 'Scrape already in progress', status: scrapeStatus });
    }
    scrapeStatus = { running: true, lastRun: new Date(), lastResult: null };
    res.json({ message: 'Scrape started — faculty.json will be updated on completion', status: scrapeStatus });

    runScrape({ onProgress: (p) => { scrapeStatus.progress = p; } })
        .then(async (result) => {
            // After scrape: export DB → JSON → reload in-memory cache
            try {
                const count = await exportFacultyToJson();
                reloadFacultyData();
                scrapeStatus = { running: false, lastRun: scrapeStatus.lastRun, lastResult: { ...result, jsonExported: count } };
                console.log('[faculty] Scrape + JSON export complete:', scrapeStatus.lastResult);
            } catch (exportErr) {
                console.error('[faculty] JSON export failed after scrape:', exportErr.message);
                scrapeStatus = { running: false, lastRun: scrapeStatus.lastRun, lastResult: { ...result, exportError: exportErr.message } };
            }
        })
        .catch((err) => {
            scrapeStatus = { running: false, lastRun: scrapeStatus.lastRun, lastResult: { error: err.message } };
            console.error('[faculty] Scrape failed:', err.message);
        });
});

// POST /api/faculty/admin/export-json  →  export current DB → JSON without re-scraping
router.post('/admin/export-json', verifyFirebaseToken, async (req, res) => {
    try {
        const count = await exportFacultyToJson();
        reloadFacultyData();
        res.json({ success: true, exported: count, path: JSON_DATA_PATH });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/faculty/admin/scrape/status
router.get('/admin/scrape/status', verifyFirebaseToken, (_req, res) => {
    res.json(scrapeStatus);
});

module.exports = router;
