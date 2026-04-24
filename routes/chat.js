const express = require('express');
const { randomUUID } = require('crypto');
const { PDFParse } = require('pdf-parse');
const router = express.Router();
const { generateStreamResponse, generateResponse } = require('../services/openaiService');
const optionalAuth = require('../middleware/optionalAuth');
const verifyFirebaseToken = require('../middleware/verifyFirebaseToken');
const Conversation = require('../models/Conversation');
const { _internal } = require('../services/codeRunnerService');
const { isFacultyQuery, searchFaculty, formatFacultyContext } = require('../services/facultySearch');
const TokenUsage = require('../models/TokenUsage');
const User = require('../models/User');
const PDF_TEXT_LIMIT = Number(process.env.PDF_TEXT_LIMIT || 12000);

// Per-day token limits: logged-in users
const USER_MODEL_LIMITS = {
    'gpt-5.2': 5000,
};

// Per-day token limits: anonymous users (by model param sent from frontend)
const ANON_MODEL_LIMITS = {
    'auto': 5000,
};

const BLOCKED_FOR_ANON = ['gpt-5.2'];

const getTodayDhaka = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });

const getLimits = (isAnon) => isAnon ? ANON_MODEL_LIMITS : USER_MODEL_LIMITS;

const checkDailyLimit = async (trackingId, model, isAnon) => {
    const limits = getLimits(isAnon);
    const limit = limits[model];
    if (!limit) return { allowed: true };
    const date = getTodayDhaka();
    const record = await TokenUsage.findOne({ userId: trackingId, model, date });
    const used = record?.tokens || 0;
    if (used >= limit) return { allowed: false, used, limit };
    return { allowed: true, used, limit };
};

const recordTokenUsage = async (trackingId, model, tokens, isAnon) => {
    const date = getTodayDhaka();
    await TokenUsage.findOneAndUpdate(
        { userId: trackingId, model, date },
        { $inc: { tokens } },
        { upsert: true }
    );
};

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

const normalizeMessage = (message) => ({
    messageId: message?.messageId || randomUUID(),
    role: message?.role === 'ai' ? 'assistant' : message?.role,
    content: _internal.extractTextContent(message?.content),
});

const truncatePdfText = (text) => {
    const normalized = String(text || '')
        .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '') // strip pdf-parse v2 page markers "-- N of M --"
        .replace(/\s+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (normalized.length <= PDF_TEXT_LIMIT) return normalized;
    return `${normalized.slice(0, PDF_TEXT_LIMIT)}\n\n[PDF content truncated]`;
};

const isPdfDocument = (item) => {
    const mimeType = String(item?.mime_type || '').toLowerCase();
    const fileName = String(item?.name || '').toLowerCase();
    return mimeType.includes('pdf') || fileName.endsWith('.pdf');
};

const extractPdfText = async (item) => {
    let parser;
    try {
        const buffer = Buffer.from(item.data || '', 'base64');
        console.log(`[PDF] Extracting "${item.name}", buffer: ${buffer.length} bytes`);

        parser = new PDFParse({ data: buffer });
        const result = await parser.getText();
        const text = truncatePdfText(result.text);

        console.log(`[PDF] Extracted ${text.length} chars`);
        if (text.length > 0) console.log(`[PDF] Preview: ${text.slice(0, 200)}`);

        if (!text || text.trim().length === 0) {
            console.log(`[PDF] No text found — may be a scanned/image PDF`);
            return `The user uploaded a PDF named "${item.name || 'document.pdf'}", but no selectable text could be extracted. It may be a scanned or image-based PDF.`;
        }
        return `The user uploaded a PDF named "${item.name || 'document.pdf'}". The full extracted text is below — use it to answer the user. Do NOT say you cannot access the PDF.\n\nPDF extracted text:\n${text}`;
    } catch (error) {
        console.error(`[PDF] Extraction failed for "${item.name}":`, error.message);
        return `The user uploaded a PDF named "${item.name || 'document.pdf'}", but server-side text extraction failed: ${error.message}`;
    } finally {
        if (parser) { try { await parser.destroy(); } catch {} }
    }
};

const prepareMessageContent = async (content) => {
    if (!Array.isArray(content)) return content;

    const textParts = [];
    const imageParts = [];

    for (const item of content) {
        if (!item || typeof item !== 'object') continue;

        if (item.type === 'text' && item.text) {
            textParts.push(item.text);
            continue;
        }

        if (item.type === 'image_url') {
            imageParts.push(item);
            continue;
        }

        if (item.type === 'document' && isPdfDocument(item)) {
            textParts.push(await extractPdfText(item));
        }
    }

    if (imageParts.length === 0) {
        return textParts.join('\n\n').trim();
    }

    const prepared = [];
    const mergedText = textParts.join('\n\n').trim();
    if (mergedText) {
        prepared.push({ type: 'text', text: mergedText });
    }

    return [...prepared, ...imageParts];
};

const prepareMessages = async (messages) => {
    const prepared = [];

    for (const message of messages) {
        prepared.push({
            ...message,
            role: message?.role === 'ai' ? 'assistant' : message?.role,
            content: await prepareMessageContent(message?.content),
        });
    }

    return prepared;
};

const persistConversation = async ({ userId, conversationId, messages, assistantContent }) => {
    const normalizedMessages = messages.map(normalizeMessage);
    const assistantMessage = {
        messageId: randomUUID(),
        role: 'assistant',
        content: assistantContent,
    };
    const nextMessages = [...normalizedMessages, assistantMessage];
    const firstUserText = normalizedMessages.find((message) => message.role === 'user')?.content || 'New Chat';

    let conversation = null;

    if (conversationId) {
        conversation = await Conversation.findOne({ _id: conversationId, userId });
    }

    if (conversation) {
        conversation.messages = nextMessages;
        if (!conversation.title || conversation.title === 'New Chat') {
            conversation.title = await generateTitle(firstUserText);
        }
        await conversation.save();
    } else {
        conversation = await Conversation.create({
            userId,
            title: await generateTitle(firstUserText),
            messages: nextMessages,
        });
    }

    return {
        conversationId: conversation._id.toString(),
        assistantMessageId: assistantMessage.messageId,
    };
};

router.post('/', optionalAuth, async (req, res) => {
    const isAnon = !req.user;
    const trackingId = req.user?.uid || (req.anonId ? `anon:${req.anonId}` : null);
    console.log(`\x1b[34m[MUJinny] ▶ Chat request received (${isAnon ? `anon:${req.anonId || 'no-id'}` : `user:${req.user.uid}`})\x1b[0m`);
    try {
        const { messages = [], model, conversationId } = req.body;

        // Block restricted models for anonymous users
        if (isAnon && model && BLOCKED_FOR_ANON.includes(model)) {
            return res.status(403).json({
                error: 'login_required',
                message: 'Jinny Deep is only available for logged-in users.',
            });
        }

        // Check daily token limit
        if (trackingId && model) {
            const limitCheck = await checkDailyLimit(trackingId, model, isAnon);
            if (!limitCheck.allowed) {
                return res.status(429).json({
                    error: 'daily_limit_exceeded',
                    message: isAnon
                        ? `Your free quota is exhausted (${limitCheck.limit.toLocaleString()} tokens/day). Please login to continue.`
                        : `Jinny Deep daily limit reached (${limitCheck.used.toLocaleString()} / ${limitCheck.limit.toLocaleString()} tokens used). Resets tomorrow.`,
                    used: limitCheck.used,
                    limit: limitCheck.limit,
                    isAnon,
                });
            }
        }

        const preparedMessages = await prepareMessages(messages);

        // Faculty retrieval: inject JSON records as context if query is about a faculty member
        let facultyContext = '';
        const latestUserMsg = preparedMessages.filter(m => m.role === 'user').pop();
        if (latestUserMsg) {
            const latestText = typeof latestUserMsg.content === 'string'
                ? latestUserMsg.content
                : (Array.isArray(latestUserMsg.content)
                    ? (latestUserMsg.content.find(c => c.type === 'text')?.text || '')
                    : '');
            if (isFacultyQuery(latestText)) {
                try {
                    const records = searchFaculty(latestText, 3);
                    if (records.length > 0) {
                        facultyContext = formatFacultyContext(records);
                        console.log(`[faculty] Injecting ${records.length} record(s) from JSON for: "${latestText.slice(0, 60)}"`);
                    } else {
                        facultyContext = '[FACULTY DATABASE]: No matching faculty record found for this query. Tell the user you could not find this person in the university directory, and suggest they check https://www.metrouni.edu.bd directly.';
                        console.log(`[faculty] No JSON records found for: "${latestText.slice(0, 60)}"`);
                    }
                } catch (err) {
                    console.warn('[faculty] JSON search failed, proceeding without context:', err.message);
                }
            }
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Grab a short preview of the user's message for the log
        const latestUserText = (() => {
            const m = preparedMessages.filter(m => m.role === 'user').pop();
            if (!m) return '(no message)';
            const raw = typeof m.content === 'string' ? m.content
                : Array.isArray(m.content) ? (m.content.find(c => c.type === 'text')?.text || '') : '';
            return raw.slice(0, 80) + (raw.length > 80 ? '…' : '');
        })();

        const stream = await generateStreamResponse(preparedMessages, model, facultyContext);
        const finalModel = stream.modelUsedForPricing || model || "gpt-4.1";

        let usageData = null;
        let fullAssistantResponse = '';
        let chunkCount = 0;

        for await (const chunk of stream) {
            chunkCount++;
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
                fullAssistantResponse += content;
                res.write(content);
            }
            // Log the very last chunk raw (where usage typically appears)
            if (chunk.usage) {
                usageData = chunk.usage;
                console.log('\x1b[90m[MUJinny] Raw usage chunk:\x1b[0m', JSON.stringify(chunk.usage));
            }
        }
        console.log(`\x1b[34m[MUJinny] Stream done — ${chunkCount} chunks, usageData: ${usageData ? 'YES' : 'NO'}\x1b[0m`);

        const PRICING = {
            "gpt-5":        { input: 0.015,  output: 0.06  },
            "gpt-5.2":      { input: 0.008,  output: 0.02  },
            "gpt-5.2-pro":  { input: 0.012,  output: 0.04  },
            "gpt-4.1":      { input: 0.004,  output: 0.01  },
            "gpt-4o":       { input: 0.005,  output: 0.015 },
            "gpt-4.1-mini": { input: 0.001,  output: 0.002 },
            "gpt-4.1-nano": { input: 0.0005, output: 0.001 },
        };
        const BDT_RATE = 125;

        let cost = null;
        if (usageData) {
            const modelPricing = PRICING[finalModel] || PRICING["gpt-4.1"];
            const promptTokens      = usageData.prompt_tokens     || usageData.input_tokens  || 0;
            const completionTokens  = usageData.completion_tokens || usageData.output_tokens || 0;
            const totalTokens       = usageData.total_tokens || (promptTokens + completionTokens);

            const inputCost  = (promptTokens     / 1000) * modelPricing.input;
            const outputCost = (completionTokens / 1000) * modelPricing.output;
            const totalCost  = inputCost + outputCost;
            const totalBDT   = totalCost * BDT_RATE;

            cost = { inputCost, outputCost, totalCost };

            // Record usage for rate-limited models
            const trackingModel = isAnon ? (model || 'auto') : finalModel;
            if (trackingId) await recordTokenUsage(trackingId, trackingModel, totalTokens, isAnon);

            // Persist cumulative token count on the User document
            if (!isAnon && req.user?.uid) {
                User.findOneAndUpdate(
                    { firebaseUid: req.user.uid },
                    { $inc: { totalTokens } }
                ).catch(() => {});
            }

            // Show remaining quota in log
            const limits = getLimits(isAnon);
            const dailyLimit = limits[trackingModel];
            let quotaLine = '';
            if (dailyLimit && trackingId) {
                const todayRecord = await TokenUsage.findOne({ userId: trackingId, model: trackingModel, date: getTodayDhaka() });
                const usedSoFar = todayRecord?.tokens || totalTokens;
                const remaining = Math.max(0, dailyLimit - usedSoFar);
                quotaLine = `\n\x1b[90m  Daily quota  :\x1b[0m ${usedSoFar.toLocaleString()} / ${dailyLimit.toLocaleString()} tokens  \x1b[${remaining < 500 ? '31' : '33'}m(${remaining.toLocaleString()} left)\x1b[0m`;
            }

            console.log([
                '',
                '\x1b[36m┌─────────────────────────────────────────┐',
                `│  \x1b[1mMUJinny Token Usage\x1b[22m                      │`,
                '└─────────────────────────────────────────┘\x1b[0m',
                `\x1b[90m  Msg :\x1b[0m ${latestUserText}`,
                `\x1b[90m  Model:\x1b[0m \x1b[33m${finalModel}\x1b[0m`,
                '',
                `\x1b[90m  Input  tokens :\x1b[0m ${promptTokens.toLocaleString().padStart(8)}   \x1b[90m→\x1b[0m  $${inputCost.toFixed(6)}`,
                `\x1b[90m  Output tokens :\x1b[0m ${completionTokens.toLocaleString().padStart(8)}   \x1b[90m→\x1b[0m  $${outputCost.toFixed(6)}`,
                `\x1b[90m  Total  tokens :\x1b[0m ${totalTokens.toLocaleString().padStart(8)}`,
                '',
                `\x1b[90m  Cost (USD)    :\x1b[0m \x1b[32m$${totalCost.toFixed(6)}\x1b[0m`,
                `\x1b[90m  Cost (BDT)    :\x1b[0m \x1b[32m৳${totalBDT.toFixed(4)}\x1b[0m`,
                quotaLine,
                '\x1b[36m─────────────────────────────────────────\x1b[0m',
                '',
            ].join('\n'));
        } else {
            console.warn(`\x1b[33m[MUJinny] No usage data returned by provider for model: ${finalModel}\x1b[0m`);
        }

        let conversationMetadata = null;
        if (!isAnon) {
            try {
                conversationMetadata = await persistConversation({
                    userId: req.user.uid,
                    conversationId,
                    messages: preparedMessages,
                    assistantContent: fullAssistantResponse,
                });
            } catch (dbError) {
                console.error("Failed to save streaming chat to MongoDB:", dbError);
            }
        }

        res.write(
            `__JSON_METADATA__${JSON.stringify({
                usage: usageData,
                cost,
                ...(conversationMetadata || {}),
            })}`
        );
        res.end();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
