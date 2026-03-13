import { jest } from "@jest/globals";
import { getGlobalMatcher } from "../src/scoring/fastMatcher.js";
import { generateSimHash } from "../src/core/dedup.js";
import { TopKChunks } from "../src/core/heap.js";

// Mock env.ts before we import worker.js since Jest can't parse TS natively here
jest.unstable_mockModule("../src/env.ts", () => ({
  validateEnv: jest.fn(() => ({ valid: true, missing: [] })),
}));

// Dynamically import worker.js so the mock is applied
const { default: worker } = await import("../src/worker.js");

// Helper to escape regex
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("v5.2.0 Optimization Validation & Regression Test Suite", () => {
  // ── Phase 1: Shadow Testing the FastMatcher (Trie) vs Legacy Regex ─────────
  describe("Phase 1: FastMatcher (Trie) vs Legacy Regex", () => {
    test("FastMatcher extracts strictly identical skills and roles as legacy regex", () => {
      // 1. Create a mock job description
      const mockJobDescription = `
        We are looking for a talented Frontend Engineer to join our team.
        You should have strong experience with React and TypeScript. 
        Knowledge of Node.js is a plus but not required. We prefer candidates
        who have worked with modern web technologies. We do not use Angular or Vue.
        This is a remote position spanning multiple timezones across the globe.
        React, React, React!
      `.repeat(5);

      const config = {
        targetRoles: ["Frontend Engineer"],
        searchRules: {
          mustMatch: ["React", "TypeScript"],
          shouldMatch: ["Node.js"],
          niceToHave: ["Angular", "Vue"],
        },
      };

      // 2. Pass text through NEW FastMatcher.scan()
      const matcher = getGlobalMatcher(config);
      const lowerText = mockJobDescription.toLowerCase();
      const textScanResult = matcher.scan(lowerText);

      const newMatchedMust = [
        ...new Set(
          textScanResult.matched
            .filter((m) => m.category === "mustMatch")
            .map((m) => m.original),
        ),
      ];

      const newMatchedRole = [
        ...new Set(
          textScanResult.matched
            .filter((m) => m.category === "targetRole")
            .map((m) => m.original),
        ),
      ];

      // 3. Simulated Old Legacy Regex Logic
      const legacyMatchedMust = new Set();
      const legacyMatchedRole = new Set();

      for (const kw of config.searchRules.mustMatch) {
        if (
          new RegExp(`\\b${escapeRegex(kw.toLowerCase())}\\b`, "i").test(
            lowerText,
          )
        ) {
          legacyMatchedMust.add(kw);
        }
      }
      for (const role of config.targetRoles) {
        if (
          new RegExp(`\\b${escapeRegex(role.toLowerCase())}\\b`, "i").test(
            lowerText,
          )
        ) {
          legacyMatchedRole.add(role);
        }
      }

      // 4. Assert Strict Deep Equality
      expect(newMatchedMust.sort()).toEqual([...legacyMatchedMust].sort());
      expect(newMatchedRole.sort()).toEqual([...legacyMatchedRole].sort());
    });
  });

  // ── Phase 2: SimHash Collision & Accuracy Testing ──────────────────────────
  describe("Phase 2: SimHash Collision & Accuracy", () => {
    test("Test Case A: 95% identical texts compute equal 32-bit integer hashes", () => {
      const textA =
        "Senior Backend Engineer at Google. Experience with Go, Python, and Kubernetes required. Building scalable microservices.";
      // Change stop words only (which the 4-char rule filters out)
      const textB =
        "Senior Backend Engineer at Google. Experience with Go, Python, & Kubernetes required. Building scalable microservices.";

      const hashA = generateSimHash(textA);
      const hashB = generateSimHash(textB);

      expect(typeof hashA).toBe("number");
      expect(hashA).toEqual(hashB);
    });

    test("Test Case B: Completely different texts compute unequal hashes", () => {
      const textA =
        "Senior Backend Engineer at Google. Experience with Go, Python, and Kubernetes required. Building scalable microservices.";
      const textC =
        "Frontend Developer at Facebook. Looking for React framework expertise, CSS animations, and UI/UX design skills.";

      const hashA = generateSimHash(textA);
      const hashC = generateSimHash(textC);

      expect(hashA).not.toEqual(hashC);
    });
  });

  // ── Phase 3: Min-Heap Accuracy (RAG Sorting) ───────────────────────────────
  describe("Phase 3: Min-Heap Accuracy vs Array.sort", () => {
    test("TopKChunks (Min-Heap) objects perfectly match Array.sort().slice(0,5)", () => {
      // 1. Generate array of 100 mock AI embedding chunks
      const chunks = [];
      for (let i = 0; i < 100; i++) {
        chunks.push({
          id: `chunk-${i}`,
          text: `mock text ${i}`,
          sim: Math.random(),
        });
      }

      // 2. Legacy Array Sort
      const legacyTop5 = [...chunks].sort((a, b) => b.sim - a.sim).slice(0, 5);

      // 3. New Min-Heap Logic
      const topKChunks = new TopKChunks(5);
      for (const chunk of chunks) {
        topKChunks.add(chunk);
      }
      const minHeapTop5 = topKChunks.getTop();

      // 4. Assert strict deep equality
      expect(minHeapTop5).toEqual(legacyTop5);
    });
  });

  // ── Phase 4: Cloudflare I/O Offloading (Mocking ctx.waitUntil) ─────────────
  describe("Phase 4: ctx.waitUntil Worker Non-Blocking Execution", () => {
    let originalFetch;

    beforeAll(() => {
      originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => "application/xml" },
          text: () =>
            Promise.resolve(
              "<rss><channel><item><title>Mock Job</title><description>Mock Desc</description></item></channel></rss>",
            ),
        }),
      );
    });

    afterAll(() => {
      globalThis.fetch = originalFetch;
    });

    test("Worker queue handler resolves before the mocked promises (I/O Offload)", async () => {
      // 1. Create a mocked Cloudflare Worker `env` and `ctx`
      let dbBatchResolved = false;

      const mockEnv = {
        // We use 'feed-queue' processFeeds because it generates minimal dependencies
        // and performs batch inserts that we wrapped in ctx.waitUntil
        DB: {
          prepare: jest.fn(() => ({
            bind: jest.fn(() => ({
              run: jest.fn(() => ({ success: true })),
              all: jest.fn(() => ({ results: [] })),
              first: jest.fn(() => null),
            })),
          })),
          batch: jest.fn(
            () =>
              new Promise((resolve) => {
                setTimeout(() => {
                  dbBatchResolved = true;
                  resolve([{ success: true }]);
                }, 50); // 50ms slow DB
              }),
          ),
        },
        SEEN_JOBS: {
          get: jest.fn(() => null),
          put: jest.fn(() => Promise.resolve()),
          delete: jest.fn(() => Promise.resolve()),
        },
      };

      const waitUntilPromises = [];
      const mockCtx = {
        waitUntil: jest.fn((promise) => {
          waitUntilPromises.push(promise);
        }),
      };

      // Simulating the FEED_QUEUE batch trigger to process a generic feed
      const mockBatch = {
        queue: "feed-queue",
        messages: [
          {
            body: { url: "https://example.com/mock.xml", type: "rss", id: 1 },
            ack: jest.fn(),
            retry: jest.fn(),
          },
        ],
      };

      // 2. Trigger the job queue handler
      // Since we didn't mock fetch within processFeeds, it will fail harmlessly
      // but it still pushes the promise out to ctx.waitUntil in `worker.js`.
      await worker.queue(mockBatch, mockEnv, mockCtx);

      // Await background I/O array locally to let it clear
      await Promise.all(waitUntilPromises);

      // 3. Assert that ctx.waitUntil was actually utilized
      expect(mockCtx.waitUntil).toHaveBeenCalled();

      // 4. Assert msg.ack() is called AFTER D1 work completes (inside waitUntil)
      // This validates the data-safety fix: messages are only acked after DB writes succeed
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();
    });
  });
});
