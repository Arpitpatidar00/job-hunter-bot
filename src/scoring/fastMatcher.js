/**
 * @module scoring/fastMatcher
 * @description O(N) single-pass keyword matching using Aho-Corasick Trie.
 * Replaces O(N*M) RegExp loops with single text traversal.
 *
 * Optimization: Builds trie once on Worker initialization, scans in O(N) time.
 */

import logger from "../core/logger.js";
import {
  FRONTEND_KEYWORDS,
  BACKEND_KEYWORDS,
  NON_JS_STACKS,
  SCORE_LABELS,
} from "./skills.js";

/**
 * Lightweight Trie node for FastMatcher
 */
class TrieNode {
  constructor() {
    this.children = new Map(); // using Map for dynamic char set but can use Object
    this.fail = null;
    this.isEnd = false;
    this.payload = null;
    this.output = []; // Contains matches for this node
  }
}

/**
 * FastMatcher - Aho-Corasick Trie implementation
 */
export class FastMatcher {
  constructor(keywords = []) {
    this.root = new TrieNode();
    this.keywordCount = 0;

    if (keywords.length > 0) {
      this.buildTrie(keywords);
    }
  }

  buildTrie(keywords) {
    for (const kw of keywords) {
      if (!kw.word || typeof kw.word !== "string") continue;
      const word = kw.word.toLowerCase().trim();
      if (!word) continue;

      let node = this.root;
      for (const char of word) {
        if (!node.children.has(char)) {
          node.children.set(char, new TrieNode());
        }
        node = node.children.get(char);
      }
      node.isEnd = true;
      // Keep the one with highest weight if dup
      if (!node.payload || kw.weight > node.payload.weight) {
        node.payload = {
          word: word,
          original: kw.word,
          category: kw.category || "skill",
          weight: kw.weight || 1,
        };
      }
      this.keywordCount++;
    }

    this.buildFailureLinks();
    logger.info(
      `[FastMatcher] Built Aho-Corasick trie with ${this.keywordCount} keywords`,
    );
  }

  buildFailureLinks() {
    const queue = [];
    this.root.fail = null;

    for (const [char, child] of this.root.children.entries()) {
      child.fail = this.root;
      queue.push(child);
    }

    while (queue.length > 0) {
      const current = queue.shift();

      for (const [char, child] of current.children.entries()) {
        let failState = current.fail;

        while (failState !== null && !failState.children.has(char)) {
          failState = failState.fail;
        }

        child.fail = failState ? failState.children.get(char) : this.root;

        // Merge outputs so that matching "javascript" also outputs "script" if it's a keyword
        if (child.isEnd) {
          child.output.push(child.payload);
        }
        if (child.fail && child.fail.output) {
          child.output.push(...child.fail.output);
        }

        queue.push(child);
      }
    }
  }

  addKeywords(keywords) {
    this.buildTrie(keywords);
  }

  /**
   * Scan text character by character exactly once in O(N) time.
   */
  scan(text) {
    if (!text || this.keywordCount === 0) {
      return { score: 0, matched: [], matchedCategories: {} };
    }

    const lowerText = text.toLowerCase();
    let node = this.root;
    const matched = [];
    const seenWords = new Set();
    const matchedCategories = {};
    let totalScore = 0;

    for (let i = 0; i < lowerText.length; i++) {
      const char = lowerText[i];

      while (node !== null && !node.children.has(char)) {
        node = node.fail;
      }

      node = node ? node.children.get(char) : this.root;

      if (node.output.length > 0) {
        for (const match of node.output) {
          // Check word boundaries to prevent substring false positives
          const wordLen = match.word.length;
          const endIdx = i;
          const startIdx = i - wordLen + 1;

          const prevChar = startIdx > 0 ? lowerText[startIdx - 1] : " ";
          const nextChar =
            endIdx < lowerText.length - 1 ? lowerText[endIdx + 1] : " ";

          const nonWordRegex = /[^\w+.-]/; // roughly anything not alphanumeric or + . -

          let isWordStart = nonWordRegex.test(prevChar);
          let isWordEnd = nonWordRegex.test(nextChar);

          // Exception: If the keyword itself doesn't end in a period/dash/plus,
          // and the next char IS a period/dash/plus, treat it as a word boundary.
          // This allows "TypeScript." at the end of a sentence to match.
          if (!isWordEnd) {
            const wordEndsWithPunctuation = /[+.-]$/.test(match.word);
            if (!wordEndsWithPunctuation && /[+.-]/.test(nextChar)) {
              isWordEnd = true;
            }
          }
          if (!isWordStart) {
            const wordStartsWithPunctuation = /^[+.-]/.test(match.word);
            if (!wordStartsWithPunctuation && /[+.-]/.test(prevChar)) {
              isWordStart = true;
            }
          }

          if (isWordStart && isWordEnd && !seenWords.has(match.word)) {
            seenWords.add(match.word);
            matched.push(match);
            totalScore += match.weight;
            matchedCategories[match.category] =
              (matchedCategories[match.category] || 0) + 1;
          }
        }
      }
    }

    return {
      score: totalScore,
      matched,
      matchedCategories,
      matchCount: matched.length,
    };
  }

  scanCategories(text, categories) {
    const result = this.scan(text);
    const filtered = {};
    for (const cat of categories) {
      if (result.matchedCategories[cat]) {
        filtered[cat] = result.matched.filter((m) => m.category === cat);
      }
    }
    return filtered;
  }
}

export function buildMatcherFromConfig(config) {
  const keywords = [];

  // Config-based skills
  const mustMatch = config.searchRules?.mustMatch || [];
  const niceToHave = config.searchRules?.niceToHave || [];
  const shouldMatch = config.searchRules?.shouldMatch || [];
  const targetRoles = config.targetRoles || [];
  const exclude = config.searchRules?.exclude || [];
  const locations = [
    ...(config.locationKeywords || []),
    ...(config.filters?.workPreference || []),
    ...(config.filters?.locations || []),
  ];

  // Add config keywords
  for (const word of mustMatch)
    keywords.push({ word, category: "mustMatch", weight: 10 });
  for (const word of niceToHave)
    keywords.push({ word, category: "niceToHave", weight: 5 });
  for (const word of shouldMatch)
    keywords.push({ word, category: "shouldMatch", weight: 3 });
  for (const word of targetRoles)
    keywords.push({ word, category: "targetRole", weight: 30 });
  for (const word of exclude)
    keywords.push({ word, category: "exclude", weight: 0 }); // Hard gate trigger
  for (const word of locations)
    keywords.push({ word, category: "location", weight: 0 });

  // Add static dictionaries from skills.js
  for (const word of FRONTEND_KEYWORDS)
    keywords.push({ word, category: "frontend", weight: 1 });
  for (const word of BACKEND_KEYWORDS)
    keywords.push({ word, category: "backend", weight: 1 });
  for (const word of NON_JS_STACKS)
    keywords.push({ word, category: "nonJsStack", weight: 0 }); // Penalty trigger

  // Also inject synonyms if they exist in config
  const synonyms = config.synonyms || {};
  for (const [key, synList] of Object.entries(synonyms)) {
    // We find if 'key' exists in our keywords, if so we also add its synonyms
    const existing = keywords.find(
      (k) => k.word.toLowerCase() === key.toLowerCase(),
    );
    if (existing) {
      for (const s of synList) {
        keywords.push({
          word: s,
          category: existing.category,
          weight: existing.weight,
        });
      }
    }
  }

  return new FastMatcher(keywords);
}

let _globalMatcher = null;

export function getGlobalMatcher(config) {
  if (!_globalMatcher) {
    _globalMatcher = buildMatcherFromConfig(config);
  }
  return _globalMatcher;
}

export function resetGlobalMatcher() {
  _globalMatcher = null;
}
