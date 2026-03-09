/**
 * @module dedup
 * @description Enhanced deduplication utilities for cross-source job clustering.
 *
 * Provides two levels of dedup beyond the basic content_hash:
 *   1. computeSimilarityHash — loose hash (company + title only) for fuzzy grouping
 *   2. clusterDuplicates     — groups a job batch by similarity_hash to detect
 *      cross-source duplicates before they reach the DB insert step
 */

import { normalizeCompany, normalizeTitle } from "./schema.js";

// ── FNV-1a Hash ───────────────────────────────────────────────────────────────

/**
 * Lightweight FNV-1a hash — same impl as schema.js to stay consistent.
 * @param {string} input
 * @returns {string} 8-char hex hash
 */
function fnvHash(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ── Similarity Hash ───────────────────────────────────────────────────────────

/**
 * Compute a loose similarity hash from company + normalized title only
 * (intentionally excludes URL and location so cross-source dupes cluster).
 *
 * @param {string} title
 * @param {string} company
 * @returns {string} 8-char hex hash
 */
export function computeSimilarityHash(title, company) {
  const t = normalizeTitle(title).toLowerCase().replace(/\s+/g, " ").trim();
  const c = normalizeCompany(company).toLowerCase().replace(/\s+/g, " ").trim();
  return fnvHash(`${c}::${t}`);
}

// ── Cross-Source Duplicate Clustering ────────────────────────────────────────

/**
 * @typedef {object} ClusterResult
 * @property {Map<string, object[]>} clusters - Map of similarityHash → jobs
 * @property {object[]} uniqueJobs            - One representative per cluster
 * @property {number}   duplicatesFound       - Total duplicates detected
 */

/**
 * Group a batch of normalized jobs by their similarity_hash.
 * Within each cluster, the job with the earliest pubDate is kept as the
 * canonical representative; the rest are marked as duplicates.
 *
 * Only jobs that have a `similarity_hash` field are clustered. Jobs without
 * one are passed through as unique (safe fallback).
 *
 * @param {object[]} jobs - Array of normalized RawJob objects (with similarity_hash)
 * @returns {ClusterResult}
 */
export function clusterDuplicates(jobs) {
  /** @type {Map<number, object[]>} */
  const clusters = new Map();

  for (const job of jobs) {
    const textToHash = `${job.title || ""} ${job.company || ""} ${job.contentSnippet || job.content || ""}`;
    const hash = generateSimHash(textToHash);

    if (!clusters.has(hash)) clusters.set(hash, []);
    clusters.get(hash).push(job);
  }

  const uniqueJobs = [];
  let duplicatesFound = 0;

  for (const [, group] of clusters) {
    if (group.length === 1) {
      uniqueJobs.push(group[0]);
      continue;
    }

    // Pick the canonical job: prefer earliest pubDate, fallback to first
    const sorted = [...group].sort((a, b) => {
      const da = a.pubDate ? new Date(a.pubDate).getTime() : Infinity;
      const db = b.pubDate ? new Date(b.pubDate).getTime() : Infinity;
      return da - db;
    });

    uniqueJobs.push(sorted[0]);
    duplicatesFound += group.length - 1;
  }

  return { clusters, uniqueJobs, duplicatesFound };
}

// ── Embedding Similarity Guard ────────────────────────────────────────────────

/**
 * Simple cosine similarity between two embedding vectors.
 * Used in the alert-queue worker for high-quality dedup before sending alerts.
 *
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number} Cosine similarity in [0, 1]
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA?.length || vecA.length !== vecB?.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Returns true if two jobs are embedding-level duplicates (similarity ≥ threshold).
 * Only call this from the alert-queue consumer to avoid excess AI API cost.
 *
 * @param {number[]} embeddingA
 * @param {number[]} embeddingB
 * @param {number} [threshold=0.88]
 * @returns {boolean}
 */
export function isDuplicateByEmbedding(
  embeddingA,
  embeddingB,
  threshold = 0.88,
) {
  return cosineSimilarity(embeddingA, embeddingB) >= threshold;
}

// ── SimHash for O(1) Near-Duplicate Detection ───────────────────────────────────

/**
 * Generate a 32-bit SimHash for near-duplicate detection.
 * Uses FNV-1a style hashing on significant words only.
 *
 * This enables O(1) comparison instead of O(N) text comparison.
 *
 * @param {string} text - Input text to hash
 * @returns {number} 32-bit unsigned integer hash
 */
export function generateSimHash(text) {
  if (!text || typeof text !== "string") return 0;

  let hash = 0x811c9dc5;

  // Weight the first 10 words heavily (usually title/company based on clusterDuplicates template text)
  const allWords = text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  const words = allWords.slice(0, 50);

  for (let i = 0; i < words.length; i++) {
    const weight = i < 10 ? 3 : 1; // Heavy weight for title/company

    for (let w = 0; w < weight; w++) {
      for (let j = 0; j < words[i].length; j++) {
        hash ^= words[i].charCodeAt(j);
        hash = Math.imul(hash, 0x01000193);
      }
    }
  }

  return hash >>> 0;
}

/**
 * Compute Hamming distance between two SimHashes.
 * Used to determine if two hashes represent similar content.
 *
 * @param {number} hashA
 * @param {number} hashB
 * @returns {number} Number of differing bits
 */
export function hammingDistance(hashA, hashB) {
  let xor = hashA ^ hashB;
  let distance = 0;
  while (xor !== 0) {
    distance += xor & 1;
    xor >>>= 1;
  }
  return distance;
}

/**
 * Check if two jobs are near-duplicates using SimHash.
 * Returns true if Hamming distance is below threshold.
 *
 * @param {string} textA
 * @param {string} textB
 * @param {number} [maxDistance=5] - Max Hamming distance (lower = stricter)
 * @returns {boolean}
 */
export function isNearDuplicate(textA, textB, maxDistance = 5) {
  const hashA = generateSimHash(textA);
  const hashB = generateSimHash(textB);

  if (hashA === hashB) return true; // Exact match

  return hammingDistance(hashA, hashB) <= maxDistance;
}

/**
 * O(1) near-duplicate check using pre-computed hashes.
 * Use this when you have already computed SimHashes.
 *
 * @param {number} hashA
 * @param {number} hashB
 * @param {number} [maxDistance=5]
 * @returns {boolean}
 */
export function isNearDuplicateHash(hashA, hashB, maxDistance = 5) {
  if (hashA === hashB) return true;
  return hammingDistance(hashA, hashB) <= maxDistance;
}
