/**
 * @module env
 * @description Cloudflare Worker environment type definitions and runtime validation.
 * Secrets come from `env` bindings (set via `wrangler secret put`), NOT process.env.
 */

/**
 * Validate required notification secrets exist in the Worker env.
 * Call this in the Worker's fetch/scheduled handler to fail fast.
 *
 * @param {object} env - Cloudflare Worker env bindings.
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateEnv(env: any): { valid: boolean; missing: string[] } {
    const required = ['DISCORD_WEBHOOK_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
    const missing = required.filter(key => !env[key]);
    return {
        valid: missing.length === 0,
        missing,
    };
}
