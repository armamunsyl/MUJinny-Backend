const express = require('express');
const router = express.Router();
const { fetchAvailableModels } = require('../services/openaiService');

router.get('/', async (req, res) => {
    try {
        const models = await fetchAvailableModels();
        res.json(models);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch OpenAI models" });
    }
});

module.exports = router;
