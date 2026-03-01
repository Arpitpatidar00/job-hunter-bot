/**
 * @module logger
 * @description Clean, structured logger for Cloudflare Workers.
 *
 * Output format:  [LEVEL] message  { optional structured data }
 *
 * Design goals:
 *   • Human-readable in `wrangler tail` / dashboard — no JSON blobs
 *   • Meaningful lifecycle events only — no per-item noise
 *   • Metric counters for end-of-run summary
 *   • Zero dependencies
 */

// ── Metric counters (reset each cron window) ─────────────────────────────────

const _metrics = {
    feedsPolled: 0,
    itemsSeen: 0,
    itemsEvaluated: 0,
    itemsMatched: 0,
    itemsExcluded: 0,
    itemsSkipped: 0,
    alertsSent: 0,
    alertsFailed: 0,
    feedErrors: 0,
};

// ── Core emit ─────────────────────────────────────────────────────────────────

/**
 * Emit a log line.  Format:  [LEVEL] message   { key: value, ... }
 * Structured data is appended inline for quick scanning.
 */
function emit(level, message, data) {
    const prefix = `[${level}]`;
    const suffix = data && Object.keys(data).length > 0
        ? '  ' + Object.entries(data).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
        : '';
    const line = `${prefix} ${message}${suffix}`;

    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
}

// ── Public API ────────────────────────────────────────────────────────────────

const logger = {
    info(message, data) { emit('INFO', message, data); },
    warn(message, data) { emit('WARN', message, data); },
    error(message, data) { emit('ERROR', message, data); },

    /** Increment a named metric counter. */
    metric(name, delta = 1) {
        if (name in _metrics) _metrics[name] += delta;
    },

    /** Snapshot of current metric values. */
    getMetrics() { return { ..._metrics }; },

    /** Reset all metrics (start of each cron run). */
    resetMetrics() {
        for (const key of Object.keys(_metrics)) _metrics[key] = 0;
    },

    /** Log a job that scored above threshold. */
    evaluated(job, scoreResult) {
        const company = job.company || job.creator || '?';
        emit('INFO', `Match: [${scoreResult.score}] ${job.title || 'Untitled'} @ ${company}`, {
            label: scoreResult.label,
            skills: scoreResult.matchedSkills?.join(', ') || '-',
        });
    },

    /** Log a notification delivery result. */
    notified(label, channels) {
        emit('INFO', `Alert sent → ${channels.join(', ')}`, { tier: label });
    },

    /** Print end-of-run summary line. */
    summary() {
        const m = _metrics;
        emit('INFO',
            `Run complete | Feeds: ${m.feedsPolled} | ` +
            `Seen: ${m.itemsSeen} | Evaluated: ${m.itemsEvaluated} | ` +
            `Matched: ${m.itemsMatched} | Excluded: ${m.itemsExcluded} | ` +
            `Alerts: ${m.alertsSent} sent, ${m.alertsFailed} failed`
        );
    },
};

export default logger;
