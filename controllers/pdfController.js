const puppeteer = require('puppeteer');
const { marked }  = require('marked');
const Export      = require('../models/Export');

// ── Configure marked ──────────────────────────────────────────────────────────
marked.setOptions({ gfm: true, breaks: true });

// ── HTML template ─────────────────────────────────────────────────────────────
const buildHtml = (title, markdownContent, dateStr) => {
    const body = marked.parse(markdownContent || '');
    return `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  /* ── Google Fonts: supports Bangla + Latin ── */
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+Bengali:wght@400;600;700&family=Noto+Sans:ital,wght@0,400;0,600;0,700;1,400&family=Noto+Sans+Mono:wght@400;600&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Noto Sans Bengali', 'Noto Sans', 'Arial Unicode MS', sans-serif;
    font-size: 11pt;
    line-height: 1.75;
    color: #1e293b;
    background: #ffffff;
    padding: 0;
  }

  /* ── Header bar ── */
  .pdf-header {
    background: #2563eb;
    color: #fff;
    padding: 12px 48px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .pdf-header .brand { font-size: 13pt; font-weight: 700; letter-spacing: 0.01em; }
  .pdf-header .date  { font-size: 9pt; opacity: 0.92; }

  /* ── Content area ── */
  .pdf-body {
    padding: 32px 48px 48px;
  }

  /* ── Title ── */
  .pdf-title {
    font-size: 19pt;
    font-weight: 700;
    color: #1e293b;
    margin-bottom: 6px;
    line-height: 1.3;
  }
  .pdf-divider {
    height: 2px;
    background: #2563eb;
    margin-bottom: 22px;
    border-radius: 1px;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ── Headings ── */
  h1 { font-size: 16pt; font-weight: 700; margin: 18px 0 8px; color: #0f172a; }
  h2 { font-size: 14pt; font-weight: 700; margin: 16px 0 7px; color: #0f172a; }
  h3 { font-size: 12pt; font-weight: 600; margin: 14px 0 6px; color: #1e293b; }
  h4, h5, h6 { font-size: 11pt; font-weight: 600; margin: 12px 0 5px; color: #1e293b; }

  /* ── Body text ── */
  p { margin-bottom: 9px; }

  /* ── Lists — numbered MCQ questions stay correct ── */
  ol {
    list-style: decimal;
    padding-left: 24px;
    margin: 8px 0 10px;
  }
  ul {
    list-style: disc;
    padding-left: 24px;
    margin: 8px 0 10px;
  }
  ol ol { list-style: lower-alpha; margin: 4px 0; }
  ul ul { list-style: circle;      margin: 4px 0; }
  li {
    margin: 3px 0;
    line-height: 1.65;
  }
  li > p { margin: 0; }

  /* ── MCQ answer line (Answer: …) ── */
  .answer-line {
    color: #166534;
    font-weight: 600;
    margin: 2px 0 10px 8px;
    font-size: 10.5pt;
  }

  /* ── Inline code ── */
  code {
    font-family: 'Noto Sans Mono', 'Courier New', monospace;
    font-size: 9.5pt;
    background: #f1f5f9;
    border-radius: 3px;
    padding: 1px 5px;
    color: #0f172a;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ── Code blocks ── */
  pre {
    background: #0f172a;
    color: #e2e8f0;
    border-radius: 6px;
    padding: 14px 16px;
    margin: 10px 0 14px;
    overflow-x: auto;
    page-break-inside: avoid;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  pre code {
    background: transparent;
    padding: 0;
    color: #e2e8f0;
    font-size: 9pt;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* ── Blockquote ── */
  blockquote {
    border-left: 3px solid #cbd5e1;
    padding-left: 14px;
    color: #475569;
    margin: 8px 0;
    font-style: italic;
  }

  /* ── Table ── */
  table { width: 100%; border-collapse: collapse; margin: 10px 0 14px; }
  th, td { border: 1px solid #e2e8f0; padding: 7px 10px; text-align: left; font-size: 10.5pt; }
  th { background: #f8fafc; font-weight: 600; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  tr:nth-child(even) td { background: #f8fafc; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  /* ── Strong / em ── */
  strong { font-weight: 700; }
  em     { font-style: italic; }

  /* ── Horizontal rule ── */
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 14px 0; }

  /* ── Page break hints ── */
  h1, h2 { page-break-after: avoid; }
  pre, table { page-break-inside: avoid; }

  /* ── Footer (printed via CSS @page) ── */
  @page {
    size: A4;
    margin: 0;
  }
  .pdf-footer {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 36px;
    background: #fff;
    border-top: 1px solid #e2e8f0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 8.5pt;
    color: #94a3b8;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
</style>
</head>
<body>
  <div class="pdf-header">
    <span class="brand">MUJinny Chat Assistant</span>
    <span class="date">${escapeHtml(dateStr)}</span>
  </div>

  <div class="pdf-body">
    <div class="pdf-title">${escapeHtml(title)}</div>
    <div class="pdf-divider"></div>
    ${body}
  </div>

  <div class="pdf-footer">Generated by MUJinny</div>
</body>
</html>`;
};

const escapeHtml = (str) =>
    String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

// ── Puppeteer PDF generator ───────────────────────────────────────────────────
const generatePdfBuffer = async (html) => {
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ],
    });
    try {
        const page = await browser.newPage();
        // Load HTML with network allowed so Google Fonts can load
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0', right: '0', bottom: '36px', left: '0' },
        });
        return pdf;
    } finally {
        await browser.close();
    }
};

// ── Controllers ───────────────────────────────────────────────────────────────

exports.generatePdf = async (req, res) => {
    try {
        const { title = 'MUJinny Export', content = '', options = {} } = req.body;
        if (!String(content).trim()) return res.status(400).json({ error: 'content is required' });

        const { includeAnswers = true } = options;
        let mdContent = content;

        // Strip answer lines if requested
        if (!includeAnswers) {
            mdContent = mdContent
                .split('\n')
                .filter((l) => !/^(answer|ans|উত্তর)\s*[:\-]/i.test(l.trim()))
                .join('\n');
        }

        const dateStr = new Date().toLocaleDateString('en-GB', {
            day: '2-digit', month: 'short', year: 'numeric',
        });

        console.log(`[PDF] Generating "${title}" (${mdContent.length} chars)`);
        const html = buildHtml(title, mdContent, dateStr);
        const pdf  = await generatePdfBuffer(html);
        console.log(`[PDF] Done, ${pdf.length} bytes`);

        const safeTitle = title.replace(/[^a-zA-Z0-9\u0980-\u09FF\s-]/g, '').trim().slice(0, 60) || 'mugpt-export';
        const fileName  = `${safeTitle.replace(/\s+/g, '-').toLowerCase()}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        res.setHeader('Content-Length', pdf.length);
        res.end(pdf);
    } catch (err) {
        console.error('[PDF] generatePdf error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'PDF generation failed: ' + err.message });
    }
};

exports.saveSnapshot = async (req, res) => {
    try {
        const { chatId, title = 'MCQ Set', content, type = 'mcq' } = req.body;
        if (!chatId || !String(content || '').trim()) {
            return res.status(400).json({ error: 'chatId and content required' });
        }
        const snap = await Export.create({ userId: req.user.uid, chatId, title, content, type });
        res.status(201).json({ id: snap._id });
    } catch (err) {
        console.error('[PDF] saveSnapshot error:', err.message);
        res.status(500).json({ error: 'Failed to save snapshot' });
    }
};

exports.getLatestSnapshot = async (req, res) => {
    try {
        const snap = await Export.findOne(
            { userId: req.user.uid, chatId: req.params.chatId },
            { content: 1, title: 1, type: 1, createdAt: 1 },
        ).sort({ createdAt: -1 });

        if (!snap) return res.status(404).json({ error: 'No snapshot found' });
        res.json(snap);
    } catch (err) {
        console.error('[PDF] getLatestSnapshot error:', err.message);
        res.status(500).json({ error: 'Failed to fetch snapshot' });
    }
};
