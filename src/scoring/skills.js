/**
 * @module skills
 * @description Centralized dictionaries and regular expressions used by the relevance scoring engine.
 * Extracted here for easier maintenance, scalability, and professional customization.
 */

export const SCORE_LABELS = [
    { min: 88, label: 'Excellent Match', color: '🟢' },
    { min: 72, label: 'Strong Match', color: '🟡' },
    { min: 55, label: 'Moderate Match', color: '🔵' },
    { min: 38, label: 'Weak Match', color: '🟣' },
    { min: 0,  label: 'Poor Match',  color: '🔴' },
];

export const SENIORITY_REGEX = {
    lead:   /\b(vp|vice president|director|c[tse]o|head of engineering|chief)\b/i,
    senior: /\b(staff|principal|lead|senior|sr\.?|expert|architect)\b/i,
    mid:    /\b(mid[- ]?level|intermediate|associate|sde[-\s]?2|ii\b|level\s*2)\b/i,
    junior: /\b(junior|jr\.?|entry[- ]?level|graduate|trainee|intern|sde[-\s]?1|i\b|fresh(?:er)?|0[- ]?(?:to|-)?\s*[12]\s*year)\b/i
};

export const SENIORITY_PREF_REGEX = {
    junior: /junior|entry|fresher|intern|sde\s*1|0[-–\s]?[12]\s*yr|0[-–\s]?[12]\s*year/i,
    mid:    /mid|associate|intermediate|sde\s*2|[23][-–\s]?[45]\s*yr|[23][-–\s]?[45]\s*year/i
};

export const REGION_BONUS_REGEX = /\b(india|worldwide|global|anywhere|asia|remote)\b/i;

export const NON_JS_STACKS = [
    'python', 'ruby', 'golang', 'rust', 'scala', 'elixir', 'kotlin', 'swift', 'cobol', 'mainframe'
];

export const FRONTEND_KEYWORDS = [
    'frontend', 'front-end', 'css only', 'ux designer', 'ui designer'
];

export const BACKEND_KEYWORDS = [
    'backend', 'back-end', 'node', 'express', 'api', 'server', 'database', 'microservice', 'graphql'
];

export const FRONTEND_TITLE_REGEX = /\b(frontend|front-end)\b/i;
