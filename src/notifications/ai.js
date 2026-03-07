/**
 * @module ai
 * @description Cloudflare Workers AI integration for semantic role matching.
 * Uses `@cf/baai/bge-base-en-v1.5` to convert text to 768-dimensional vectors.
 *
 * Issue 5 fix: Per-invocation subrequest budget (MAX_AI_CALLS_PER_INVOCATION).
 * Issue 6 fix: Retry with backoff for transient model unavailability errors.
 */

import logger from "../core/logger.js";

// ── Subrequest Budget (Issue 5) ───────────────────────────────────────────────
// Cloudflare Workers allow ~50 subrequests per invocation.
// We cap AI calls at 40 to leave headroom for DB / queue calls.
const MAX_AI_CALLS_PER_INVOCATION = 40;
let _aiCallCount = 0;

/** Reset the per-invocation AI call counter. Call once at the start of each evaluateJobs run. */
export function resetAiCallCount() {
  _aiCallCount = 0;
}

/** How many AI calls have been made in the current invocation (for metrics). */
export function getAiCallCount() {
  return _aiCallCount;
}

// ── Internal: sleep helper ────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Embeddings Generation ────────────────────────────────────────────────────

/**
 * Generate a semantic embedding vector for a piece of text.
 *
 * Issue 5: Returns [] immediately if the per-invocation subrequest budget is exhausted.
 * Issue 6: Retries up to 2 times (1s, 2s delay) for transient "model temporarily unavailable" errors.
 *
 * @param {import('@cloudflare/workers-types').Ai} aiBinding
 * @param {string} text - The input text (job description or profile specs)
 * @returns {Promise<number[]>} The vector embedding, or [] on failure / budget exceeded
 */
export async function generateEmbedding(aiBinding, text) {
  if (!aiBinding || !text) return [];

  // Issue 5: Enforce subrequest budget
  if (_aiCallCount >= MAX_AI_CALLS_PER_INVOCATION) {
    logger.warn(
      `[AI] Subrequest budget exhausted (${MAX_AI_CALLS_PER_INVOCATION} calls used). Skipping embedding.`,
    );
    return [];
  }

  // Issue 6: Retry with backoff for transient failures
  const MAX_RETRIES = 2;
  const RETRY_DELAYS_MS = [1000, 2000];

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      _aiCallCount++;
      const response = await aiBinding.run("@cf/baai/bge-base-en-v1.5", {
        text: [text],
      });
      return response.data[0];
    } catch (err) {
      lastErr = err;
      const isTransient =
        err.message?.includes("temporarily unavailable") ||
        err.message?.includes("503") ||
        err.message?.includes("9000");

      if (attempt < MAX_RETRIES && isTransient) {
        const delay = RETRY_DELAYS_MS[attempt];
        logger.warn(
          `[AI] Transient embedding error (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms: ${err.message}`,
        );
        await sleep(delay);
      } else {
        // Non-transient error or retries exhausted — log and give up
        if (isTransient) {
          logger.warn(
            `[AI] Embedding failed after ${MAX_RETRIES + 1} attempts: ${err.message}`,
          );
        } else {
          logger.error(`[AI] Failed to generate embedding: ${err.message}`);
        }
        return [];
      }
    }
  }

  return [];
}

/**
 * Generate semantic embedding vectors for an array of texts in a single subrequest.
 *
 * @param {import('@cloudflare/workers-types').Ai} aiBinding
 * @param {string[]} texts - Array of input texts
 * @returns {Promise<number[][]>} Array of vector embeddings, or array of [] on failure
 */
export async function generateEmbeddingBatch(aiBinding, texts) {
  if (!aiBinding || !texts || texts.length === 0) return [];

  // Issue 5: Enforce subrequest budget
  if (_aiCallCount >= MAX_AI_CALLS_PER_INVOCATION) {
    logger.warn(
      `[AI] Subrequest budget exhausted (${MAX_AI_CALLS_PER_INVOCATION} calls used). Skipping batch embedding.`,
    );
    return texts.map(() => []);
  }

  // Issue 6: Retry with backoff for transient failures
  const MAX_RETRIES = 2;
  const RETRY_DELAYS_MS = [1000, 2000];

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      _aiCallCount++;
      const response = await aiBinding.run("@cf/baai/bge-base-en-v1.5", {
        text: texts,
      });
      return response.data;
    } catch (err) {
      lastErr = err;
      const isTransient =
        err.message?.includes("temporarily unavailable") ||
        err.message?.includes("503") ||
        err.message?.includes("9000");

      if (attempt < MAX_RETRIES && isTransient) {
        const delay = RETRY_DELAYS_MS[attempt];
        logger.warn(
          `[AI] Transient batch embedding error (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms: ${err.message}`,
        );
        await sleep(delay);
      } else {
        // Non-transient error or retries exhausted — log and give up
        if (isTransient) {
          logger.warn(
            `[AI] Batch embedding failed after ${MAX_RETRIES + 1} attempts: ${err.message}`,
          );
        } else {
          logger.error(
            `[AI] Failed to generate batch embedding: ${err.message}`,
          );
        }
        return texts.map(() => []);
      }
    }
  }

  return texts.map(() => []);
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
  if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0)
    return 0;

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
