import { jest } from "@jest/globals";

// ── Mock all external dependencies BEFORE importing searchExpander ──────────

// Mock logger
jest.unstable_mockModule("../src/core/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock fetchWithTimeout (used by searchMultiBackend)
jest.unstable_mockModule("../src/connectors/base.js", () => ({
  fetchWithTimeout: jest.fn(),
}));

// Mock DB operations
jest.unstable_mockModule("../src/db/index.js", () => ({
  registerDiscoveredSource: jest.fn(() => Promise.resolve()),
}));

// Mock source discovery
jest.unstable_mockModule("../src/discovery/sourceDiscovery.js", () => ({
  detectAtsSources: jest.fn(() => []),
}));

// Mock career detector
jest.unstable_mockModule("../src/discovery/careerDetector.js", () => ({
  registerDomain: jest.fn(() => Promise.resolve()),
}));

// Now import searchExpander with mocks applied
const { runSearchExpansion } = await import(
  "../src/discovery/searchExpander.js"
);
const { default: logger } = await import("../src/core/logger.js");
const { fetchWithTimeout } = await import("../src/connectors/base.js");
const { registerDiscoveredSource } = await import("../src/db/index.js");
const { detectAtsSources } = await import(
  "../src/discovery/sourceDiscovery.js"
);

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockKv({ putBehavior = "success", failCount = 0 } = {}) {
  let callCount = 0;
  const puts = [];

  return {
    get: jest.fn(() => null),
    put: jest.fn(async (key, value, options) => {
      callCount++;
      puts.push({ key, value, options });

      if (putBehavior === "rate-limit" && callCount <= failCount) {
        throw new Error("429 Too Many Requests: KV rate limit exceeded");
      }
      if (putBehavior === "permanent-fail") {
        throw new Error("429 Too Many Requests: KV rate limit exceeded");
      }
      if (putBehavior === "non-retryable-error") {
        throw new Error("500 Internal Server Error");
      }
    }),
    delete: jest.fn(),
    _puts: puts,
  };
}

function createMockDb() {
  return {
    prepare: jest.fn(() => ({
      bind: jest.fn(() => ({
        run: jest.fn(() => ({ success: true })),
        all: jest.fn(() => ({ results: [] })),
        first: jest.fn(() => null),
      })),
    })),
    batch: jest.fn(() => Promise.resolve([{ success: true }])),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Discovery Engine Persistence", () => {
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDb();
    // Default: search backends return no results (we test KV, not search)
    fetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve(""),
    });
  });

  // ── Test 1: KV writes exactly 2 times when sources are discovered ─────

  test("writes DISCOVERY_STATS_KEY and DISCOVERY_SUCCESS_KEY exactly once each when sources are discovered", async () => {
    const kv = createMockKv();

    // Pre-populate: no known URLs so all fallback sources are "new"
    const knownSourceUrls = new Set();

    const result = await runSearchExpansion(
      mockDb,
      ["test query"],
      knownSourceUrls,
      kv,
      1, // maxSearches
      5, // maxDomainsPerSearch
    );

    // Should have registered fallback sources
    expect(result.newAtsSources).toBeGreaterThan(0);

    // Exactly 2 KV writes: stats + success timestamp
    expect(kv.put).toHaveBeenCalledTimes(2);

    // First write: discovery stats
    const statsCall = kv.put.mock.calls[0];
    expect(statsCall[0]).toBe("discovery:last_run_stats");
    const parsedStats = JSON.parse(statsCall[1]);
    expect(parsedStats.attempted).toBe(1);
    expect(parsedStats.discovered).toBeGreaterThan(0);
    expect(parsedStats.fallbackRegistered).toBeGreaterThan(0);
    expect(parsedStats.kvWritesUsed).toBe(0); // Written before increment
    expect(parsedStats).toHaveProperty("domainsQueued");
    expect(statsCall[2]).toEqual({ expirationTtl: 60 * 60 * 48 });

    // Second write: success timestamp
    const successCall = kv.put.mock.calls[1];
    expect(successCall[0]).toBe("discovery:last_success_timestamp");
    expect(successCall[2]).toEqual({ expirationTtl: 60 * 60 * 24 * 7 });
  });

  // ── Test 2: Skips success timestamp when no sources discovered ────────

  test("writes only DISCOVERY_STATS_KEY when no new sources are discovered", async () => {
    const kv = createMockKv();

    // All fallback sources already known
    const knownSourceUrls = new Set([
      "https://boards-api.greenhouse.io/v1/boards/vercel/jobs",
      "https://boards-api.greenhouse.io/v1/boards/stripe/jobs",
      "https://boards-api.greenhouse.io/v1/boards/hashicorp/jobs",
      "https://boards-api.greenhouse.io/v1/boards/discord/jobs",
      "https://boards-api.greenhouse.io/v1/boards/figma/jobs",
      "https://boards-api.greenhouse.io/v1/boards/netlify/jobs",
      "https://api.lever.co/v0/postings/linear",
      "https://api.lever.co/v0/postings/notion",
      "https://api.lever.co/v0/postings/airtable",
      "https://api.lever.co/v0/postings/remote",
      "https://api.lever.co/v0/postings/descript",
      "https://api.ashbyhq.com/posting-api/job-board/retool",
      "https://api.ashbyhq.com/posting-api/job-board/supabase",
      "https://api.ashbyhq.com/posting-api/job-board/cal",
      "https://api.ashbyhq.com/posting-api/job-board/clerk",
      "https://api.ashbyhq.com/posting-api/job-board/dub",
      "https://api.ashbyhq.com/posting-api/job-board/plane",
      "https://apply.workable.com/api/v3/accounts/browserbase/jobs",
    ]);

    const result = await runSearchExpansion(
      mockDb,
      [],
      knownSourceUrls,
      kv,
      0,
      0,
    );

    expect(result.newAtsSources).toBe(0);

    // Only 1 KV write: stats only (no success timestamp)
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(kv.put.mock.calls[0][0]).toBe("discovery:last_run_stats");
  });

  // ── Test 3: Retry on 429 errors with exponential backoff ──────────────

  test("retries KV writes on 429 rate-limit errors with exponential backoff", async () => {
    // Fail first 2 puts with 429, then succeed
    const kv = createMockKv({ putBehavior: "rate-limit", failCount: 2 });
    const knownSourceUrls = new Set();

    const result = await runSearchExpansion(
      mockDb,
      [],
      knownSourceUrls,
      kv,
      0,
      0,
    );

    // Should have succeeded after retries
    // kv.put called: 2 fails + 1 success for stats + 1 success for timestamp (if discovered > 0)
    expect(kv.put.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Verify retry warning was logged
    const retryWarnings = logger.warn.mock.calls.filter(
      (c) => c[0] && c[0].includes("KV write rate-limited"),
    );
    expect(retryWarnings.length).toBe(2);
  }, 30000);

  // ── Test 4: Permanent 429 failure logs error but doesn't crash ────────

  test("logs error after exhausting retries but still returns results", async () => {
    const kv = createMockKv({ putBehavior: "permanent-fail" });
    const knownSourceUrls = new Set();

    // Should NOT throw — function must be resilient
    const result = await runSearchExpansion(
      mockDb,
      [],
      knownSourceUrls,
      kv,
      0,
      0,
    );

    // Function still returns valid results
    expect(result).toHaveProperty("newAtsSources");
    expect(result).toHaveProperty("newDomains");

    // Error was logged (not silently dropped)
    const errorCalls = logger.error.mock.calls.filter(
      (c) => c[0] && c[0].includes("KV write failed after retries"),
    );
    expect(errorCalls.length).toBe(1);
  }, 60000);

  // ── Test 5: Non-retryable errors throw immediately ────────────────────

  test("does not retry non-429 errors (throws immediately)", async () => {
    const kv = createMockKv({ putBehavior: "non-retryable-error" });
    const knownSourceUrls = new Set();

    const result = await runSearchExpansion(
      mockDb,
      [],
      knownSourceUrls,
      kv,
      0,
      0,
    );

    // kv.put called exactly once (no retries for 500 errors)
    expect(kv.put).toHaveBeenCalledTimes(1);

    // Error was still logged
    const errorCalls = logger.error.mock.calls.filter(
      (c) => c[0] && c[0].includes("KV write failed"),
    );
    expect(errorCalls.length).toBe(1);
  });

  // ── Test 6: Stats object has all required fields ──────────────────────

  test("stats object includes all enriched fields", async () => {
    const kv = createMockKv();
    const knownSourceUrls = new Set();

    await runSearchExpansion(mockDb, ["q1", "q2"], knownSourceUrls, kv, 2, 5);

    // Parse the stats written to KV
    const statsCall = kv.put.mock.calls.find(
      (c) => c[0] === "discovery:last_run_stats",
    );
    expect(statsCall).toBeDefined();
    const stats = JSON.parse(statsCall[1]);

    // All required fields present
    expect(stats).toHaveProperty("attempted");
    expect(stats).toHaveProperty("discovered");
    expect(stats).toHaveProperty("failed");
    expect(stats).toHaveProperty("domainsQueued");
    expect(stats).toHaveProperty("fallbackRegistered");
    expect(stats).toHaveProperty("kvWritesUsed");
    expect(stats).toHaveProperty("errors");
    expect(stats).toHaveProperty("timestamp");
    expect(Array.isArray(stats.errors)).toBe(true);
  });

  // ── Test 7: No KV writes when kv is null ──────────────────────────────

  test("gracefully skips KV writes when kv is null", async () => {
    const knownSourceUrls = new Set();

    // Should not throw when kv is null
    const result = await runSearchExpansion(
      mockDb,
      ["test"],
      knownSourceUrls,
      null, // No KV namespace
      1,
      5,
    );

    expect(result).toHaveProperty("newAtsSources");
    expect(result).toHaveProperty("newDomains");
  });

  // ── Test 8: End-of-run summary log is always emitted ──────────────────

  test("emits comprehensive end-of-run summary log", async () => {
    const kv = createMockKv();
    const knownSourceUrls = new Set();

    await runSearchExpansion(mockDb, ["q1"], knownSourceUrls, kv, 1, 5);

    const summaryLogs = logger.info.mock.calls.filter(
      (c) => c[0] && c[0].includes("Expansion complete:"),
    );

    expect(summaryLogs.length).toBe(1);
    const log = summaryLogs[0][0];
    expect(log).toContain("queries=");
    expect(log).toContain("ats=");
    expect(log).toContain("domains=");
    expect(log).toContain("fallbacks=");
    expect(log).toContain("failed=");
    expect(log).toContain("kvWrites=");
  });
});
