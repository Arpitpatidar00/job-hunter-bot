/**
 * @module ai
 * @description Cloudflare Workers AI integration for semantic role matching.
 * Uses `@cf/baai/bge-base-en-v1.5` to convert text to 768-dimensional vectors.
 */

import logger from '../core/logger.js';

// ── Embeddings Generation ────────────────────────────────────────────────────

/**
 * Generate a semantic embedding vector for a piece of text.
 * 
 * @param {import('@cloudflare/workers-types').Ai} aiBinding 
 * @param {string} text - The input text (job description or profile specs)
 * @returns {Promise<number[]>} The vector embedding
 */
export async function generateEmbedding(aiBinding, text) {
    if (!aiBinding || !text) return [];

    try {
        const response = await aiBinding.run('@cf/baai/bge-base-en-v1.5', {
            text: [text]
        });

        return response.data[0];
    } catch (err) {
        logger.error(`[AI] Failed to generate embedding: ${err.message}`);
        return [];
    }
}

// ── Math: Cosine Similarity ──────────────────────────────────────────────────

/**
 * Calculate the cosine similarity between two vectors.
 * Returns a value between -1 and 1, where 1 identifies identical direction.
 * 
 * @param {number[]} vecA 
 * @param {number[]} vecB 
 * @returns {number}
 */
export function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
