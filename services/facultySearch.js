'use strict';

const path = require('path');
const fs = require('fs');

// ─── Load JSON data file ────────────────────────────────────────────────────
const DATA_PATH = path.join(__dirname, '..', 'data', 'faculty.json');

let _cache = null;

/**
 * Load (and cache) faculty records from the JSON file.
 * If the file changes on disk (re-scrape), call reloadFacultyData() to refresh.
 */
const loadFacultyData = () => {
    if (_cache) return _cache;
    try {
        const raw = fs.readFileSync(DATA_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        _cache = parsed.faculty || [];
        console.log(`[facultySearch] Loaded ${_cache.length} faculty records from JSON`);
    } catch (e) {
        console.warn('[facultySearch] Could not load faculty.json:', e.message);
        _cache = [];
    }
    return _cache;
};

/** Call this after re-scraping to invalidate the in-memory cache */
const reloadFacultyData = () => {
    _cache = null;
    return loadFacultyData();
};

// ─── Intent detection ────────────────────────────────────────────────────────
const FACULTY_INTENT_RE =
    /\b(sir|maam|ma'am|teacher|faculty|professor|lecturer|dr\.?|prof\.?)\b|email|phone|number|contact|designation|room|office|\bwho is\b|\bkon\b|কে\b|স্যার|ম্যাম|শিক্ষক|অধ্যাপক|প্রভাষক|\b(daw|dao|den|nao|lagbe|chai|chahi|bolun|bolo|info|tottho|details)\b/i;

const isFacultyQuery = (text) => FACULTY_INTENT_RE.test(String(text || ''));

// ─── Normalization helpers ───────────────────────────────────────────────────
const normalize = (s) =>
    String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9\u0980-\u09FF\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

const STOP_WORDS = new Set([
    'sir','maam','madam','teacher','faculty','professor','lecturer','dr','prof',
    'email','phone','number','contact','designation','room','office','the','a','an',
    'is','of','and','or','in','at','for','from','to','who','what','where','how',
    'info','tottho','details','daw','dao','den','nao','lagbe','chai','chahi','bolun','bolo',
    'স্যার','ম্যাম','শিক্ষক','অধ্যাপক','প্রভাষক','কে','কার','কোন','বলুন','দিন','দাও',
    'er','r','ki','koto',
]);

const extractNameTokens = (text) =>
    normalize(text)
        .split(' ')
        .filter((t) => t.length > 1 && !STOP_WORDS.has(t));

// ─── Scoring ────────────────────────────────────────────────────────────────
/**
 * Score a faculty record against the search tokens.
 * Higher = better match.
 */
const scoreRecord = (record, tokens) => {
    let score = 0;
    const nameLower = normalize(record.name);
    const deptLower = normalize(record.department || '');
    const desigLower = normalize(record.designation || '');
    const allKeys = (record.searchKeys || []).map((k) => k.toLowerCase());
    const emailStr = (record.email || []).join(' ').toLowerCase();

    for (const token of tokens) {
        // Exact name word match → highest weight
        if (nameLower.split(' ').includes(token)) score += 10;
        // Partial name match
        else if (nameLower.includes(token)) score += 6;
        // searchKeys exact
        else if (allKeys.includes(token)) score += 5;
        // searchKeys partial
        else if (allKeys.some((k) => k.includes(token))) score += 3;
        // email match
        else if (emailStr.includes(token)) score += 4;
        // dept/designation
        else if (deptLower.includes(token) || desigLower.includes(token)) score += 1;
    }
    return score;
};

// ─── Main search function ────────────────────────────────────────────────────
/**
 * Search faculty from the JSON file.
 * @param {string} queryText
 * @param {number} limit
 * @returns {Array} matched faculty records (plain objects)
 */
const searchFaculty = (queryText, limit = 3) => {
    const records = loadFacultyData();
    const tokens = extractNameTokens(queryText);

    if (tokens.length === 0) return [];

    // Score every record and sort descending
    const scored = records
        .map((r) => ({ record: r, score: scoreRecord(r, tokens) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((x) => x.record);
};

// ─── Format for AI context ──────────────────────────────────────────────────
const formatFacultyContext = (records) => {
    if (!records || records.length === 0) return '';

    const lines = ['[FACULTY DATABASE RECORDS — use this as ground truth]:'];
    for (const r of records) {
        lines.push('---');
        lines.push(`Name: ${r.name}`);
        lines.push(`Designation: ${r.designation || 'N/A'}`);
        lines.push(`Department: ${r.department || 'N/A'}`);
        lines.push(`Email: ${r.email?.length ? r.email.join(', ') : 'Not listed on website'}`);
        lines.push(`Phone: ${r.phone?.length ? r.phone.join(', ') : 'Not listed on website'}`);
        lines.push(`Profile URL: ${r.profileUrl || 'N/A'}`);
        if (r.officeLocation) lines.push(`Office: ${r.officeLocation}`);
        if (r.researchInterests?.length) lines.push(`Research Interests: ${r.researchInterests.join(', ')}`);
        if (r.bio && r.bio.length > 10) lines.push(`Bio: ${r.bio.slice(0, 300)}...`);
        if (r.education?.length) lines.push(`Education: ${r.education.slice(0, 3).join(' | ')}`);
    }
    lines.push('---');
    lines.push('[END FACULTY RECORDS]');
    return lines.join('\n');
};

// ─── Utility: get all records (for admin / listing endpoints) ────────────────
const getAllFaculty = () => loadFacultyData();

module.exports = {
    isFacultyQuery,
    searchFaculty,
    formatFacultyContext,
    getAllFaculty,
    reloadFacultyData,
};
