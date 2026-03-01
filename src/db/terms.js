/**
 * @module db/terms
 * @description TF-IDF term frequency tracking for scoring intelligence.
 */

import logger from '../core/logger.js';

/**
 * Increment global document count and term occurrences.
 *
 * @param {D1Database} db
 * @param {string[]} terms
 */
export async function recordTermFrequencies(db, terms) {
    if (!terms || terms.length === 0) return;

    const uniqueTerms = [...new Set(terms)];

    try {
        await db.prepare(
            `UPDATE scoring_meta SET value = value + 1 WHERE key = 'total_documents'`
        ).run();

        const stmts = uniqueTerms.map(t =>
            db.prepare(
                `INSERT INTO term_frequency (term, document_count) VALUES (?, 1)
                 ON CONFLICT(term) DO UPDATE SET document_count = document_count + 1`
            ).bind(t)
        );

        await db.batch(stmts);
    } catch (err) {
        logger.error(`[D1] Failed to update term frequencies: ${err.message}`);
    }
}

/**
 * Fetch global document frequencies for a list of terms to compute IDF.
 *
 * @param {D1Database} db
 * @param {string[]} terms
 * @returns {Promise<{ totalDocs: number, termCounts: Record<string, number> }>}
 */
export async function getGlobalTermFrequencies(db, terms) {
    if (!terms || terms.length === 0) return { totalDocs: 1, termCounts: {} };

    try {
        const marks = terms.map(() => '?').join(',');

        const [metaRes, termsRes] = await db.batch([
            db.prepare(`SELECT value FROM scoring_meta WHERE key = 'total_documents'`),
            db.prepare(`SELECT term, document_count FROM term_frequency WHERE term IN (${marks})`).bind(...terms)
        ]);

        const totalDocs = metaRes.results?.[0]?.value || 1;
        const termCounts = {};

        for (const row of (termsRes.results || [])) {
            termCounts[row.term] = row.document_count;
        }

        return { totalDocs, termCounts };
    } catch (err) {
        logger.warn(`[D1] Failed to fetch IDF data: ${err.message}`);
        return { totalDocs: 1, termCounts: {} };
    }
}
