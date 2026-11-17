import fs from 'node:fs';
import path from 'node:path';

export const AGE_RATINGS = [
  { value: 0, label: '全年龄' },
  { value: 7, label: '7+' },
  { value: 13, label: '13+' },
  { value: 16, label: '16+' },
  { value: 18, label: '18+' },
];

const VALID = new Set(AGE_RATINGS.map((entry) => entry.value));

export function isValidAgeRating(value) {
  return value === null || VALID.has(Number(value));
}

export function normalizeAgeRating(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return VALID.has(n) ? n : null;
}

export function ratingLabel(value) {
  if (value === null || value === undefined) return '未分级';
  const found = AGE_RATINGS.find((entry) => entry.value === Number(value));
  return found ? found.label : '未分级';
}

const TEXT_RULES = [
  [/\b(?:18\+|NC-?17|TV-?MA|RATED\s*R)|限制级|成人级|十八禁/i, 18],
  [/\b16\+|辅导级|輔導級/i, 16],
  [/\b(?:13\+|PG-?13|TV-?14)/i, 13],
  [/\b7\+|TV-?PG\b|保护级|保護級/i, 7],
  [/\b(?:G|TV-?G)\b|普遍级|普遍級|普通级|普通級|全年龄|全年齡/i, 0],
  [/\bR\b/, 18],
  [/\bPG\b/, 7],
];

/**
 * Turn a rating string such as "PG-13", "TV-MA", "[18+]" or "限制级" into
 * one of Lumina's numeric age ratings. Returns undefined when the text has no
 * recognizable rating (so callers can keep looking elsewhere).
 */
export function parseRatingText(text) {
  const value = String(text || '').trim();
  if (!value) return undefined;
  for (const [pattern, rating] of TEXT_RULES) {
    if (pattern.test(value)) return rating;
  }
  return undefined;
}

function readSmall(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 512 * 1024) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function ratingFromNfo(file) {
  const raw = readSmall(file);
  if (!raw) return undefined;
  const match = /<(mpaa|customrating|certification)>([\s\S]*?)<\/\1>/i.exec(raw);
  if (!match) return undefined;
  return parseRatingText(match[2].replace(/<[^>]+>/g, ' '));
}

/**
 * Detect an age rating from a sidecar .rating file, an NFO, or tags in the
 * file name / folder names. Returns null when nothing is found.
 */
export function detectAgeRating(filePath, seriesDir = null) {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));

  const sidecar = readSmall(path.join(dir, `${stem}.rating`));
  if (sidecar) {
    const parsed = parseRatingText(sidecar);
    if (parsed !== undefined) return parsed;
  }

  for (const nfo of [
    path.join(dir, `${stem}.nfo`),
    path.join(dir, 'movie.nfo'),
    seriesDir ? path.join(seriesDir, 'tvshow.nfo') : null,
  ]) {
    if (!nfo) continue;
    const parsed = ratingFromNfo(nfo);
    if (parsed !== undefined) return parsed;
  }

  const haystack = [
    path.basename(filePath),
    path.basename(dir),
    path.basename(path.dirname(dir)),
  ].join(' ');
  const parsed = parseRatingText(haystack);
  return parsed === undefined ? null : parsed;
}
