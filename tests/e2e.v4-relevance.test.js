import { scoreJob, MINIMUM_ALERT_SCORE } from "../src/scoring/relevance-v4.js";
import { chunkTexts } from "../src/notifications/ai-v4.js";

describe("Job Hunter Bot V4 E2E Edge Case Tests", () => {
  // Standard test config
  const baseConfig = {
    searchRules: {
      mustMatch: ["react", "node.js"],
      shouldMatch: ["typescript", "aws", "docker"],
      niceToHave: ["graphql", "redis"],
      exclude: ["php", "wordpress"],
    },
    weights: {
      titleMatch: 30,
      skillsMatch: 30,
      techStackMatch: 20,
      locationMatch: 10,
      salaryMatch: 10,
    },
    filters: {
      locations: ["remote"],
      minPrimaryMatches: 1,
    },
    scoringBonuses: {
      fullMernStack: 10,
      awsPresent: 4,
      remoteIndia: 5,
    },
    scoringPenalties: {
      nonJsStack: -15,
      frontendOnlyNoBackend: -5,
    },
    scoring: {
      tfidfWeight: 0.15,
      seniorityPenalty: -8,
      experienceBonus: 5,
    },
  };

  const emptyIdfData = { totalDocs: 1, termCounts: {} };

  describe("V4 Concept 1: Trajectory Overrides", () => {
    test("Penalties applied normally when trajectory is low", () => {
      const job = {
        title: "Python Developer",
        contentSnippet:
          "We need someone to work on our huge Python monolith. Also requires React and Node.js for some microservices.",
      };

      const lowTrajScore = scoreJob(job, baseConfig, emptyIdfData, [], 0.4);
      expect(lowTrajScore.breakdown.penalties).toBeLessThan(0); // Should be -15
      expect(lowTrajScore.reasons.some((r) => r.includes("Non-JS stack"))).toBe(
        true,
      );
    });

    test("Trajectory override completely ignores Non-JS penalties", () => {
      const job = {
        title: "Python Developer",
        contentSnippet:
          "We need someone to work on our huge Python monolith. Also requires React and Node.js for some microservices.",
      };

      // High trajectory fit = 0.9 (e.g. pivoting into a new tech stack gracefully)
      const highTrajScore = scoreJob(job, baseConfig, emptyIdfData, [], 0.9);
      expect(highTrajScore.breakdown.penalties).toBe(0); // Penalty ignored!
      expect(
        highTrajScore.reasons.some((r) =>
          r.includes("Trajectory override: Ignored Non-JS stack"),
        ),
      ).toBe(true);
    });

    test("MustHits=0 caps score at 50 when trajectory is low", () => {
      const genericJobWithNiceHits = {
        title: "Full Stack Developer", // Matches targetRoles
        contentSnippet:
          "Remote work anywhere in India. Big focus on redis, graphql, aws, docker.",
      };

      const configWithRoles = {
        ...baseConfig,
        targetRoles: ["Full Stack Developer"],
      };

      // Give it huge RAG semantic boost to naturally push it over 50 (to ~80)
      const ragMatches = [{ text: "relevant chunk", sim: 0.95, vec: [] }];

      // Trajectory is low, so cap SHOULD apply and bring 80 down to 50
      const lowTrajScore = scoreJob(
        genericJobWithNiceHits,
        configWithRoles,
        emptyIdfData,
        ragMatches,
        0.4,
      );

      expect(lowTrajScore.score).toBeLessThanOrEqual(50);
      expect(
        lowTrajScore.reasons.some((r) => r.includes("score capped at 50")),
      ).toBe(true);
    });

    test("MustHits=0 cap is bypassed when trajectory is high", () => {
      const genericJobWithNiceHits = {
        title: "Full Stack Developer", // Matches targetRoles
        contentSnippet:
          "Remote work anywhere in India. Big focus on redis, graphql, aws, docker.",
      };

      const configWithRoles = {
        ...baseConfig,
        targetRoles: ["Full Stack Developer"],
      };

      const ragMatches = [{ text: "relevant chunk", sim: 0.95, vec: [] }];

      const highTrajScore = scoreJob(
        genericJobWithNiceHits,
        configWithRoles,
        emptyIdfData,
        ragMatches,
        0.9,
      );

      // Since it missed mustMatches ("react"/"node.js"), normally it caps at 50.
      // With trajectory fit 0.9, it should bypass the cap and easily hit ~80+
      expect(highTrajScore.score).toBeGreaterThan(50);
      expect(
        highTrajScore.reasons.some((r) =>
          r.includes("Bypassed must-match cap"),
        ),
      ).toBe(true);
    });
  });

  describe("V4 Concept 2: Hybrid Semantic Boost (RAG)", () => {
    test("Low RAG similarity yields 0 boost", () => {
      const job = { title: "React Dev", contentSnippet: "Node.js required." };
      const ragMatches = [{ text: "chunk", sim: 0.2, vec: [] }];

      const score = scoreJob(job, baseConfig, emptyIdfData, ragMatches, 0.5);
      expect(score.breakdown.semanticBoost).toBe(0);
    });

    test("High RAG similarity provides massive boost blended with trajectory", () => {
      const job = {
        title: "NextJS Architect",
        contentSnippet: "React, Node.js, MERN stack, AWS.",
      };

      // Base semantic similarity (Mean) = 0.9
      const ragMatches = [
        { text: "chunk1", sim: 0.9, vec: [] },
        { text: "chunk2", sim: 0.9, vec: [] },
      ];

      const trajFit = 1.0;
      // Formula: 25 * (0.7 * 0.9 + 0.2 * 0.8 + 0.1 * 1.0) = 25 * (0.63 + 0.16 + 0.10) = 25 * 0.89 = ~22
      const score = scoreJob(
        job,
        baseConfig,
        emptyIdfData,
        ragMatches,
        trajFit,
      );

      expect(score.breakdown.semanticBoost).toBeGreaterThanOrEqual(20);
      expect(score.breakdown.semanticBoost).toBeLessThanOrEqual(25);
      expect(
        score.reasons.some((r) => r.includes("Hybrid Semantic Boost")),
      ).toBe(true);
    });
  });

  describe("V4 Concept 3: Text Chunking", () => {
    test("Splits text into chunks properly respecting char limits and overlap", () => {
      const hugeText = "A".repeat(800); // 800 characters
      // Let's create a realistic text with spaces to allow boundaries
      const words = Array(150).fill("word"); // 150*5 = 750 chars
      const realisticText = words.join(" "); // exactly 749 chars

      const chunks = chunkTexts(realisticText, 200, 40);

      // With 200 limit and 40 overlap, effective progress is ~160 chars.
      // 750 / 160 ~ 5 chunks
      expect(chunks.length).toBeGreaterThan(3);
      expect(chunks.length).toBeLessThan(8);

      // Verify no chunk exceeds the ~200 limit (it might slightly if no spaces exist early enough, but here spaces are frequent)
      chunks.forEach((c) => {
        expect(c.length).toBeLessThanOrEqual(205); // slight padding room
      });

      // Verify overlaps (the start of the second chunk should be contained in the first chunk)
      if (chunks.length >= 2) {
        const overlapSubstr = chunks[1].substring(0, 30);
        expect(chunks[0].includes(overlapSubstr)).toBe(true);
      }
    });
  });
});
