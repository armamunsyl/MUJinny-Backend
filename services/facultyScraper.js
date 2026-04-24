const axios  = require('axios');
const cheerio = require('cheerio');
const Faculty = require('../models/Faculty');

const BASE    = 'https://www.metrouni.edu.bd';
const DELAY   = 1200;
const RETRIES = 3;

const DEPT_LISTING_URLS = [
    { url: `${BASE}/sites/faculty-members/department-of-computer-science-engineering`,   dept: 'Department of Computer Science & Engineering' },
    { url: `${BASE}/sites/faculty-members/department-of-software-engineering`,           dept: 'Department of Software Engineering' },
    { url: `${BASE}/sites/faculty-members/department-of-data-science`,                  dept: 'Department of Data Science' },
    { url: `${BASE}/sites/faculty-members/department-of-electrical-electronic-engineering`, dept: 'Department of Electrical & Electronic Engineering' },
    { url: `${BASE}/sites/faculty-members/department-of-business-administration`,        dept: 'Department of Business Administration' },
    { url: `${BASE}/sites/faculty-members/department-of-economics`,                     dept: 'Department of Economics' },
    { url: `${BASE}/sites/faculty-members/department-of-law-justice`,                   dept: 'Department of Law & Justice' },
    { url: `${BASE}/sites/faculty-members/department-of-english`,                       dept: 'Department of English' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const httpGet = async (url, attempt = 0) => {
    try {
        const res = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });
        return res.data;
    } catch (err) {
        if (attempt < RETRIES - 1) {
            await sleep(DELAY * (attempt + 2));
            return httpGet(url, attempt + 1);
        }
        throw err;
    }
};

const buildSearchKeys = (faculty) => {
    const parts = [
        faculty.name,
        faculty.designation,
        faculty.department,
        ...(faculty.email || []),
        ...(faculty.phone || []),
        ...(faculty.researchInterests || []),
    ];
    const words = new Set();
    for (const part of parts) {
        if (!part) continue;
        for (const w of part.toLowerCase().split(/[\s,.()\-&]+/)) {
            if (w.length > 1) words.add(w);
        }
    }
    return [...words];
};

const cleanText = (str) =>
    String(str || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();

const discoverProfileUrls = async ({ url, dept }) => {
    console.log(`[scraper] Discovering profiles for: ${dept}`);
    let html;
    try { html = await httpGet(url); }
    catch (e) { console.error(`[scraper] Failed to fetch listing ${url}: ${e.message}`); return []; }

    const $ = cheerio.load(html);
    const profileUrls = new Set();

    $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const full = href.startsWith('http') ? href : `${BASE}${href}`;
        if (/\/sites\/university\/faculty-members\/.+\/\d+/.test(full)) {
            profileUrls.add(full);
        }
    });

    console.log(`[scraper]   → found ${profileUrls.size} profile URLs`);
    return [...profileUrls].map((u) => ({ profileUrl: u, dept }));
};

const scrapeProfile = async ({ profileUrl, dept }) => {
    let html;
    try { html = await httpGet(profileUrl); }
    catch (e) { console.error(`[scraper] Failed to fetch ${profileUrl}: ${e.message}`); return null; }

    const $ = cheerio.load(html);

    const name = cleanText($('h2.text-3xl.font-extrabold').first().text()) ||
                 cleanText($('.hero-title').first().text());

    if (!name) return null;

    const designation = cleanText(
        $('h2.text-3xl.font-extrabold').first().nextAll('div.prose').first().text()
    );

    const photoEl = $('img.faculty-profile-img').first();
    let photoUrl = photoEl.attr('src') || '';
    if (photoUrl && !photoUrl.startsWith('http')) photoUrl = BASE + photoUrl;

    const emailRaw = cleanText($('#email-display').first().text());
    const emails = emailRaw ? [emailRaw.toLowerCase()] : [];

    const phones = [];
    $('a[href^="tel:"]').each((_, el) => {
        const num = cleanText($(el).text() || $(el).attr('href').replace('tel:', ''));
        if (num && !phones.includes(num)) phones.push(num);
    });
    $('p, span, td').each((_, el) => {
        const txt = cleanText($(el).text());
        const m = txt.match(/(?<!\d)(01[3-9]\d{8})(?!\d)/);
        if (m && !phones.includes(m[1])) phones.push(m[1]);
    });

    const bio = cleanText($('#bioCollapse .prose').first().text().replace('Biography details are currently unavailable.', '').trim());

    const education = [];
    $('#eduCollapse .accordion-body li, #eduCollapse .accordion-body p').each((_, el) => {
        const t = cleanText($(el).text());
        if (t && t.length > 4) education.push(t);
    });

    const researchInterests = [];
    $('#interestCollapse .accordion-body span, #interestCollapse .accordion-body li').each((_, el) => {
        const t = cleanText($(el).text());
        if (t && t.length > 1) researchInterests.push(t);
    });

    const publications = [];
    $('#pubCollapse .accordion-body li, #pubCollapse .prose li').each((_, el) => {
        const t = cleanText($(el).text());
        if (t) publications.push(t);
    });

    const awards = [];
    $('#awardsCollapse .accordion-body li, #awardsCollapse .prose').each((_, el) => {
        const t = cleanText($(el).text());
        if (t && t.length > 4) awards.push(t);
    });

    const socialLinks = {};
    $('.social-btn[href], a.social-btn').each((_, el) => {
        const href = $(el).attr('href');
        const title = ($(el).attr('title') || '').toLowerCase();
        if (href && href !== '#' && title !== 'email') socialLinks[title || href] = href;
    });

    const faculty = {
        university: 'Metropolitan University',
        name,
        designation,
        department: dept,
        email: emails,
        phone: phones,
        profileUrl,
        photoUrl,
        bio,
        education,
        researchInterests,
        publications,
        awards,
        socialLinks,
        lastScrapedAt: new Date(),
    };
    faculty.searchKeys = buildSearchKeys(faculty);

    return faculty;
};

const upsertFaculty = async (data) => {
    await Faculty.findOneAndUpdate(
        { profileUrl: data.profileUrl },
        { $set: data },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

const runScrape = async ({ onProgress } = {}) => {
    const results = { discovered: 0, scraped: 0, failed: 0, skipped: 0 };

    let allProfiles = [];
    for (const listing of DEPT_LISTING_URLS) {
        const found = await discoverProfileUrls(listing);
        allProfiles.push(...found);
        await sleep(DELAY);
    }

    const seen = new Set();
    allProfiles = allProfiles.filter((p) => {
        if (seen.has(p.profileUrl)) return false;
        seen.add(p.profileUrl);
        return true;
    });

    results.discovered = allProfiles.length;
    console.log(`[scraper] Total unique profiles to scrape: ${results.discovered}`);

    for (let i = 0; i < allProfiles.length; i++) {
        const { profileUrl, dept } = allProfiles[i];
        try {
            const data = await scrapeProfile({ profileUrl, dept });
            if (data) {
                await upsertFaculty(data);
                results.scraped++;
                console.log(`[scraper] [${i + 1}/${allProfiles.length}] ✓ ${data.name}`);
            } else {
                results.skipped++;
            }
        } catch (err) {
            results.failed++;
            console.error(`[scraper] [${i + 1}/${allProfiles.length}] ✗ ${profileUrl}: ${err.message}`);
        }
        if (onProgress) onProgress({ ...results, current: i + 1, total: allProfiles.length });
        await sleep(DELAY);
    }

    console.log(`[scraper] Done. scraped=${results.scraped} failed=${results.failed} skipped=${results.skipped}`);
    return results;
};

module.exports = { runScrape, scrapeProfile, discoverProfileUrls, buildSearchKeys };
