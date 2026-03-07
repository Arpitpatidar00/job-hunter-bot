/**
 * @module ai-v4
 * @description Cloudflare Workers AI integrations for Job Hunter Bot v4.
 * Features chunked semantic RAG pipeline (MiniLM / BGE).
 */

import logger from "../core/logger.js";
import { cosineSimilarity } from "./ai.js";

// AI Call Tracking limits (prevent hitting 50 subrequests budget per invocation)
const MAX_AI_CALLS_PER_INVOCATION = 48;
let _aiCallCount = 0;

export function resetAiCallCount() {
  _aiCallCount = 0;
}

export { cosineSimilarity };

/**
 * Split text into roughly 200-character chunks with overlap.
 * @param {string} text
 * @param {number} charLimit
 * @param {number} overlapChars
 * @returns {string[]}
 */
export function chunkTexts(text, charLimit = 200, overlapChars = 40) {
  if (!text) return [];

  // Clean text
  const cleanStr = text.replace(/\s+/g, " ").trim();
  if (cleanStr.length <= charLimit) return [cleanStr];

  const chunks = [];
  let i = 0;

  while (i < cleanStr.length) {
    let endObj = i + charLimit;

    // Find natural word boundary
    if (endObj < cleanStr.length) {
      let spaceIdx = cleanStr.lastIndexOf(" ", endObj);
      if (spaceIdx > i + overlapChars) {
        // Ensure we make some progress
        endObj = spaceIdx;
      }
    } else {
      endObj = cleanStr.length;
    }

    const chunk = cleanStr.substring(i, endObj).trim();
    if (chunk) chunks.push(chunk);

    const prevI = i;
    // Move `i` forward but pull back `overlapChars` to maintain context
    i = endObj - overlapChars;
    // Avoid infinite loops on impossible strings
    if (i <= prevI) {
      i = endObj;
    }
  }

  return chunks;
}

/**
 * Generate semantic embedding vectors for an array of CHUNKS in a single subrequest.
 * Caches effectively using Cloudflare KV.
 *
 * @param {import('@cloudflare/workers-types').Ai} aiBinding
 * @param {import('@cloudflare/workers-types').KVNamespace} kvBinding
 * @param {string} jobHash - Identifier for caching
 * @param {string[]} texts - Array of input chunk texts (max 100 for bge model limits)
 * @returns {Promise<number[][]>} Array of vector embeddings
 */
export async function embedChunks(aiBinding, dbBinding, jobHash, texts) {
  if (!aiBinding || !texts || texts.length === 0) return texts.map(() => []);

  // 1. Budget Check
  if (_aiCallCount >= MAX_AI_CALLS_PER_INVOCATION) {
    logger.warn(
      `[AI-v4] Subrequest budget exhausted. Skipping chunk embedding.`,
    );
    return texts.map(() => []);
  }

  // BGE-small supports up to 100 texts in standard plan
  // We limit our texts length up to 100
  const limitedTexts = texts.slice(0, 100);

  const MAX_RETRIES = 2;
  const RETRY_DELAYS_MS = [1000, 2000];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      _aiCallCount++;
      const response = await aiBinding.run("@cf/baai/bge-base-en-v1.5", {
        text: limitedTexts,
      });

      // 2. Store to D1 DB (fallback handled by worker.js immediately after return)
      return response.data;
    } catch (err) {
      const isTransient =
        err.message?.includes("temporarily unavailable") ||
        err.message?.includes("503") ||
        err.message?.includes("9000") ||
        err.message?.includes("Too many requests");

      if (attempt < MAX_RETRIES && isTransient) {
        const delay = RETRY_DELAYS_MS[attempt];
        await sleep(delay);
      } else {
        if (isTransient) {
          logger.warn(
            `[AI-v4] Batch embedding failed after ${MAX_RETRIES + 1} attempts`,
          );
        } else {
          logger.error(`[AI-v4] Failed chunk embedding run: ${err.message}`);
        }
        return texts.map(() => []);
      }
    }
  }
  return texts.map(() => []);
}

/**
 * Retrieve Relevant Chunks directly calculating cosine similarity from DB records
 * @param {import('@cloudflare/workers-types').D1Database} dbBinding
 * @param {number[]} profileVec
 * @param {string} jobHash
 * @param {number} k
 * @returns {Promise<{text: string, sim: number}[]>}
 */
export async function retrieveRelevant(dbBinding, profileVec, jobHash, k = 5) {
  if (!profileVec || profileVec.length === 0) return [];

  try {
    // Retrieve all chunks for this job hash.
    // We calculate cosine similarity in memory rather than forcing D1 to do linear algebra
    // to maintain speed and Cloudflare compatibility. Limit parser chunks to avoid CPU limits.
    const { results } = await dbBinding
      .prepare(
        "SELECT chunk_text, vec_json FROM job_chunks WHERE job_hash = ? LIMIT 5",
      )
      .bind(jobHash)
      .all();

    if (!results || results.length === 0) return [];

    const chunkScores = results.map((r) => {
      let vec = [];
      try {
        vec = JSON.parse(r.vec_json);
      } catch (e) {}
      return {
        text: r.chunk_text,
        vec: vec,
        sim: cosineSimilarity(profileVec, vec),
      };
    });

    // Filter valid vectors, sort by highest similarity, grab top K
    const topK = chunkScores
      .filter((c) => c.vec && c.vec.length > 0)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k);

    return topK.map((c) => ({ text: c.text, sim: c.sim, vec: c.vec }));
  } catch (e) {
    logger.error(`[AI-v4] RAG retrieval failed: ${e.message}`);
    return [];
  }
}
