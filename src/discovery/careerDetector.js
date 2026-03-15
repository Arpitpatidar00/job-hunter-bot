/**
 * @module careerDetector
 * @description Probes company domains for career pages and validates
 * that they contain parseable job listings.
 *
 * When a new company domain is discovered from job URLs, this module:
 * 1. Tests common career URL paths (/careers, /jobs, etc.)
 * 2. Checks for JSON-LD JobPosting schema
 * 3. Checks for job-like links
 * 4. If valid → registers it as a 'career_page' source in source_registry
 *
 * Rate-limited to avoid hammering unknown domains.
 */

import { fetchWithTimeout, rateLimitDomain } from "../connectors/base.js";
import { detectAtsSources } from "./sourceDiscovery.js";
import { registerDiscoveredSource, batchRegisterDiscoveredSources } from "../db/index.js";
import logger from "../core/logger.js";

/** Common career page path suffixes to probe. */
const CAREER_PATHS = [
  "/careers",
  "/jobs",
  "/work-with-us",
  "/open-positions",
  "/join-us",
  "/career",
  "/job-openings",
  "/join",
  "/team",
  "/openings",
  "/hiring",
  "/work",
  "/about/careers",
  "/workwithus",
  "/apply-now",
  "/join-our-team",
];

/**
 * Probe a batch of domains for career pages and register valid ones.
 *
 * @param {D1Database} db - D1 database handle.
 * @param {string[]} domains - Domains to probe (e.g., ['stripe.com', 'vercel.com']).
 * @param {number} [maxProbes=5] - Max domains to probe per cycle (rate limit).
 * @returns {Promise<object[]>} Successfully registered career page sources.
 */
export async function probeDomainsForCareers(db, domains, maxProbes = 15) {
  const registered = [];
  let probed = 0;

  for (const domain of domains) {
    if (probed >= maxProbes) break;

    try {
      const result = await probeSingleDomain(domain);
      probed++;

      if (result) {
        // Register as a career_page source
        const source = {
          url: result.careerUrl,
          type: "career_page",
          name: domainToName(domain),
          enabled: true,
          discovery_origin: "career-probe",
        };

        await registerDiscoveredSource(db, source);
        registered.push(source);

        // Redirect mining: auto-register any ATS sources found in the page
        if (result.atsRedirects && result.atsRedirects.length > 0) {
          const atsSources = detectAtsSources(result.atsRedirects);
          if (atsSources.length > 0) {
            await batchRegisterDiscoveredSources(db, atsSources);
            for (const ats of atsSources) registered.push(ats);
            logger.info(
              `[CareerDetector] Redirect mining: ${domain} → ${atsSources.length} ATS source(s) discovered`,
            );
          }
        }

        // Update domain registry
        await updateDomainStatus(db, domain, {
          status: "active",
          careerUrl: result.careerUrl,
          hasJsonLd: result.hasJsonLd,
          hasJobLinks: result.hasJobLinks,
          jobCount: result.jobCount,
        });

        logger.info(
          `[CareerDetector] ✅ Found career page: ${domain} → ${result.careerUrl} (${result.jobCount} jobs)`,
        );
      } else {
        // Mark domain as dead (no career page found)
        await updateDomainStatus(db, domain, { status: "dead" });
        logger.info(`[CareerDetector] ❌ No career page found: ${domain}`);
      }
    } catch (err) {
      logger.warn(`[CareerDetector] Error probing ${domain}: ${err.message}`);
      await updateDomainStatus(db, domain, { status: "dead" });
    }
  }

  return registered;
}

/**
 * Probe a single domain for a career page.
 *
 * @param {string} domain
 * @returns {Promise<{careerUrl: string, hasJsonLd: boolean, hasJobLinks: boolean, jobCount: number} | null>}
 */
async function probeSingleDomain(domain) {
  // Limit to first 4 paths to control subrequest count (was 16 paths)
  const probePaths = CAREER_PATHS.slice(0, 4);
  for (const path of probePaths) {
    const url = `https://${domain}${path}`;

    try {
      await rateLimitDomain(url, 3000);

      const res = await fetchWithTimeout(
        url,
        {
          headers: {
            Accept: "text/html",
            "User-Agent":
              "JobHunterBot/5.1 (+https://github.com/job-hunter-bot)",
          },
          redirect: "follow",
        },
        10_000,
      );

      if (!res.ok) continue;

      const html = await res.text();

      // Check for JobPosting JSON-LD
      const hasJsonLd =
        /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?JobPosting[\s\S]*?<\/script>/i.test(
          html,
        );

      // Check for job-like links
      const jobLinkCount = countJobLinks(html);

      // Redirect mining: extract ATS URLs from apply/job links
      const atsRedirects = extractAtsRedirects(html);

      if (hasJsonLd || jobLinkCount >= 2) {
        return {
          careerUrl: res.url || url, // Follow redirects
          hasJsonLd,
          hasJobLinks: jobLinkCount > 0,
          jobCount: hasJsonLd ? countJsonLdPostings(html) : jobLinkCount,
          atsRedirects,
        };
      }
    } catch {
      // Timeout or network error, try next path
      continue;
    }
  }

  return null; // No career page found
}

/**
 * Extract ATS platform URLs from anchor hrefs in career page HTML.
 * This implements "redirect mining" — discovering which ATS a company uses
 * by inspecting where their apply buttons link to.
 *
 * @param {string} html
 * @returns {string[]} ATS URLs found in the page
 */
function extractAtsRedirects(html) {
  const atsPatterns = [
    /boards\.greenhouse\.io\/[a-z0-9_-]+/gi,
    /jobs\.lever\.co\/[a-z0-9_-]+/gi,
    /jobs\.ashbyhq\.com\/[a-z0-9_-]+/gi,
    /apply\.workable\.com\/[a-z0-9_-]+/gi,
    /careers\.smartrecruiters\.com\/[a-z0-9_-]+/gi,
    /[a-z0-9_-]+\.recruitee\.com/gi,
    /[a-z0-9_-]+\.teamtailor\.com/gi,
    /jobs\.breezy\.hr\/[a-z0-9_-]+/gi,
  ];

  const urls = new Set();
  for (const pattern of atsPatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      urls.add(`https://${match[0]}`);
    }
  }
  return [...urls];
}

/**
 * Count job-like links in HTML.
 * @param {string} html
 * @returns {number}
 */
function countJobLinks(html) {
  const patterns = [
    /href\s*=\s*["'][^"']*\/jobs?\//gi,
    /href\s*=\s*["'][^"']*\/careers?\//gi,
    /href\s*=\s*["'][^"']*\/positions?\//gi,
    /href\s*=\s*["'][^"']*\/openings?\//gi,
    /href\s*=\s*["'][^"']*\/apply\//gi,
    /href\s*=\s*["'][^"']*job[_-]?id/gi,
  ];

  let count = 0;
  for (const p of patterns) {
    const matches = html.match(p);
    if (matches) count += matches.length;
  }

  return count;
}

/**
 * Count JobPosting entries in JSON-LD blocks.
 * @param {string} html
 * @returns {number}
 */
function countJsonLdPostings(html) {
  const matches = html.match(/["']@type["']\s*:\s*["']JobPosting["']/gi);
  return matches ? matches.length : 0;
}

// ── Domain helpers ──────────────────────────────────────────────────────────

/**
 * Convert a domain to a friendly company name.
 * @param {string} domain
 * @returns {string}
 */
function domainToName(domain) {
  return domain
    .replace(/^www\./, "")
    .split(".")[0]
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Update a domain's status in the domain_registry.
 *
 * @param {D1Database} db
 * @param {string} domain
 * @param {object} update
 */
async function updateDomainStatus(db, domain, update) {
  try {
    // Compute a simple domain quality score (0-1) based on probe results
    const score = Math.min(1, (
      (update.hasJsonLd ? 0.3 : 0) +
      (update.hasJobLinks ? 0.3 : 0) +
      Math.min(0.3, (update.jobCount || 0) * 0.03) +
      (update.atsDetected ? 0.1 : 0)
    ));

    // Schedule next scan based on status
    const scanDays = update.status === 'active' ? 7 : update.status === 'dead' ? 30 : 3;
    const nextScanAt = new Date(Date.now() + scanDays * 86400000).toISOString();

    await db
      .prepare(
        `UPDATE domain_registry
             SET status = ?, career_url = ?, has_json_ld = ?, has_job_links = ?,
                 job_count = ?, last_probed_at = CURRENT_TIMESTAMP,
                 ats_detected = ?, probe_count = COALESCE(probe_count, 0) + 1,
                 score = ?, next_scan_at = ?
             WHERE domain = ?`,
      )
      .bind(
        update.status || "probed",
        update.careerUrl || null,
        update.hasJsonLd ? 1 : 0,
        update.hasJobLinks ? 1 : 0,
        update.jobCount || 0,
        update.atsDetected || null,
        score,
        nextScanAt,
        domain,
      )
      .run();
  } catch (err) {
    logger.warn(
      `[CareerDetector] Failed to update domain ${domain}: ${err.message}`,
    );
  }
}

/**
 * Register a new domain for probing.
 *
 * @param {D1Database} db
 * @param {string} domain
 * @param {string} sourceJobUrl - The job URL that led to discovering this domain.
 */
export async function registerDomain(db, domain, sourceJobUrl, vector = null) {
  try {
    await db
      .prepare(
        `INSERT INTO domain_registry (domain, source_job_url, discovery_vector, last_discovery_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(domain) DO UPDATE SET
               last_discovery_at = CURRENT_TIMESTAMP,
               discovery_vector = COALESCE(excluded.discovery_vector, domain_registry.discovery_vector)`,
      )
      .bind(domain, sourceJobUrl, vector)
      .run();
  } catch (err) {
    logger.warn(
      `[CareerDetector] Failed to register domain ${domain}: ${err.message}`,
    );
  }
}

/**
 * Register multiple new domains for probing in a single batch.
 *
 * @param {D1Database} db
 * @param {Array<{domain: string, sourceJobUrl: string}>} domains
 */
export async function batchRegisterDomains(db, domains) {
  if (!domains || domains.length === 0) return;

  try {
    const stmts = domains.map((d) =>
      db
        .prepare(
          `INSERT INTO domain_registry (domain, source_job_url, discovery_vector, last_discovery_at)
               VALUES (?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(domain) DO UPDATE SET
                 last_discovery_at = CURRENT_TIMESTAMP,
                 discovery_vector = COALESCE(excluded.discovery_vector, domain_registry.discovery_vector)`,
        )
        .bind(d.domain, d.sourceJobUrl, d.vector || null),
    );

    // Execute in batches of 40 (inside D1 batch limits)
    for (let i = 0; i < stmts.length; i += 40) {
      await db.batch(stmts.slice(i, i + 40));
    }
  } catch (err) {
    logger.warn(
      `[CareerDetector] Failed to batch register domains: ${err.message}`,
    );
    // Fall back to individual registration
    for (const d of domains) {
      await registerDomain(db, d.domain, d.sourceJobUrl, d.vector || null);
    }
  }
}

/**
 * Get pending domains from the registry.
 *
 * @param {D1Database} db
 * @param {number} [limit=10]
 * @returns {Promise<string[]>}
 */
export async function getPendingDomains(db, limit = 10) {
  try {
    const result = await db
      .prepare(
        `SELECT domain FROM domain_registry
         WHERE status = 'pending'
            OR (status = 'dead' AND last_probed_at < datetime('now', '-7 days'))
         ORDER BY
           CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
           last_probed_at ASC NULLS FIRST
         LIMIT ?`,
      )
      .bind(limit)
      .all();
    return result.success ? result.results.map((r) => r.domain) : [];
  } catch (err) {
    logger.warn(
      `[CareerDetector] Failed to get pending domains: ${err.message}`,
    );
    return [];
  }
}

/**
 * Re-queue dead domains that haven't been probed in 7+ days.
 * Gives dead domains a second chance — companies may fix broken career pages.
 *
 * @param {D1Database} db
 * @returns {Promise<number>} Number of domains re-queued
 */
export async function requeueDeadDomains(db) {
  try {
    const result = await db.prepare(
      `UPDATE domain_registry
       SET status = 'pending'
       WHERE status = 'dead'
         AND last_probed_at < datetime('now', '-7 days')
         AND probe_count < 3`
    ).run();
    const requeued = result?.meta?.changes || 0;
    if (requeued > 0) {
      logger.info(`[CareerDetector] Re-queued ${requeued} dead domains for retry`);
    }
    return requeued;
  } catch (err) {
    logger.warn(`[CareerDetector] Dead domain re-queue failed: ${err.message}`);
    return 0;
  }
}
