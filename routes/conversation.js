const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const { generateResponse } = require('../services/openaiService');
const verifyFirebaseToken = require('../middleware/verifyFirebaseToken');

// Protect all conversation routes
router.use(verifyFirebaseToken);

const cleanTitle = (raw) => {
    let title = raw.replace(/\.{2,}/g, '').trim();
    title = title.replace(/[.,!?;:]+$/, '').trim();
    title = title.split(/\s+/).slice(0, 5).join(' ');
    title = title.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    if (title.length > 40) title = title.substring(0, 40).trim();
    return title;
};

const generateTitle = async (message) => {
    try {
        const prompt = `Generate a short 3 to 5 word conversation title based on this message: "${message}"\nNo punctuation.\nNo quotes.\nCapitalize properly.\nOnly return the title.`;
        const raw = await generateResponse(prompt);
        return cleanTitle(raw);
    } catch {
        return cleanTitle(message);
    }
};

router.post('/', async (req, res) => {
    console.log("Chat route hit");
    try {
        console.log("User UID:", req.user.uid);
        const { message } = req.body;

        let title = "New Chat";
        try {
            title = await generateTitle(message);
        } catch (titleError) {
            console.error("Title generation failed, using fallback:", titleError);
            title = cleanTitle(message);
        }

        try {
            const conversation = await Conversation.create({
                userId: req.user.uid,
                title,
                messages: [{ role: 'user', content: message }],
            });
            res.status(201).json(conversation);
        } catch (dbError) {
            console.error("Database error saving chat:", dbError);
            res.status(500).json({ error: "Failed to save conversation to database" });
        }
    } catch (error) {
        console.error("Global Chat creation error:", error);
        res.status(500).json({ error: error.message });
    }
});

router.get('/', async (req, res) => {
    try {
        console.log("Fetching chats for:", req.user.uid);
        const conversations = await Conversation.find({ userId: req.user.uid })
            .sort({ updatedAt: -1 })
            .select('title createdAt updatedAt');
        res.json(conversations || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const conversation = await Conversation.findById(req.params.id);
        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }
        if (conversation.userId !== req.user.uid) {
            return res.status(403).json({ error: 'Unauthorized: This conversation belongs to someone else' });
        }
        res.json(conversation);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const { message } = req.body;
        let conversation = await Conversation.findById(req.params.id);

        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }
        if (conversation.userId !== req.user.uid) {
            return res.status(403).json({ error: 'Unauthorized: This conversation belongs to someone else' });
        }

        conversation = await Conversation.findByIdAndUpdate(
            req.params.id,
            { $push: { messages: message } },
            { new: true }
        );
        res.json(conversation);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.patch('/:id/rename', async (req, res) => {
    try {
        const { title } = req.body;
        if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
        const conversation = await Conversation.findOneAndUpdate(
            { _id: req.params.id, userId: req.user.uid },
            { title: title.trim() },
            { new: true }
        );
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        res.json(conversation);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const conversation = await Conversation.findOneAndDelete({
            _id: req.params.id,
            userId: req.user.uid
        });
        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found or you do not have permission to delete it' });
        }
        res.json({ message: 'Conversation deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
