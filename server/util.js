import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const VIDEO_EXTS = new Set([
  '.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.wmv', '.flv',
  '.ts', '.m2ts', '.mpg', '.mpeg', '.ogv', '.3gp',
]);

export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];
export const SUB_EXTS = new Set(['.srt', '.vtt', '.ass', '.ssa']);

export const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ogv': 'video/ogg',
  '.3gp': 'video/3gpp',
};

export function idFor(...parts) {
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 12);
}

export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function isVideoFile(name) {
  return VIDEO_EXTS.has(path.extname(name).toLowerCase());
}

export function isImageFile(name) {
  return IMAGE_EXTS.includes(path.extname(name).toLowerCase());
}

export function isSeasonFolder(name) {
  const n = String(name).trim();
  return /^(season|series|s)\s*\d{1,2}$/i.test(n)
    || /^第\s*\d{1,2}\s*季$/.test(n)
    || /^specials?$/.test(n.toLowerCase())
    || /^特别篇$|^番外篇?$/.test(n);
}

export function seasonFromFolder(name) {
  const n = String(name).trim();
  if (/^specials?$/i.test(n) || /^特别篇$|^番外篇?$/.test(n)) return 0;
  let m = n.match(/^(?:season|series|s)\s*(\d{1,2})$/i);
  if (m) return Number(m[1]);
  m = n.match(/^第\s*(\d{1,2})\s*季$/);
  if (m) return Number(m[1]);
  return null;
}

export function extractYear(text) {
  const matches = [...String(text).matchAll(/(?:^|[^\d])((?:19|20)\d{2})(?=[^\d]|$)/g)];
  if (!matches.length) return null;
  return Number(matches[matches.length - 1][1]);
}

const RELEASE_TAG_RE = /(?:^|[\s._\-\[\]()])(?:2160p|1080p|1080i|720p|576p|480p|4k|8k|uhd|hdr10\+?|hdr|dv|dolby[ ._-]?vision|atmos|dts(?:[ ._-]?hd)?|truehd|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdtv|dvdrip|dvd|remux|x264|x265|h[ .]?264|h[ .]?265|hevc|avc|aac(?:[ .]?\d[ .]?\d)?|ac3|eac3|ddp?(?:[ .]?\d[ .]?\d)?|flac|opus|10bit|8bit|proper|repack|extended|unrated|remastered|internal|limited|complete|multi|subbed|dubbed|dual[ ._-]?audio)(?=$|[\s._\-\[\]()])/gi;

/**
 * Turn a release-style file/folder name into something presentable.
 * Keeps CJK text, strips quality and release-group noise.
 */
export function cleanTitle(name) {
  let t = String(name || '');
  t = t.replace(/\[[^\]]{0,80}\]/g, ' ');
  t = t.replace(/\{[^}]{0,80}\}/g, ' ');
  t = t.replace(/\(\s*(?:19|20)\d{2}\s*\)/g, ' ');
  t = t.replace(RELEASE_TAG_RE, ' ');
  t = t.replace(/[._]+/g, ' ');
  t = t.replace(/\s+-\s*[A-Za-z0-9@][A-Za-z0-9@._-]{1,24}\s*$/g, ' ');
  t = t.replace(/\s*[-–—]\s*$/g, '');
  t = t.replace(/^[\s\-–—]+|[\s\-–—]+$/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function seriesTitleFromFolder(name) {
  let t = String(name || '');
  t = t.replace(/\[[^\]]*\]/g, ' ');
  t = t.replace(/[._]+/g, ' ');
  t = t.replace(/\s*[\(\[]\s*(?:19|20)\d{2}\s*[\)\]]\s*$/, ' ');
  t = t.replace(/\s+(?:19|20)\d{2}\s*$/, ' ');
  t = t.replace(/\s+(?:season|s)\s*\d{1,2}\s*$/i, ' ');
  t = cleanTitle(t);
  return t;
}

/**
 * Parse a video filename into movie/series/episode hints.
 * Never throws; returns best-effort data.
 */
export function parseFilename(fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, ext ? -ext.length : undefined) || fileName;

  let season = null;
  let episode = null;
  let markerStart = -1;
  let markerEnd = -1;

  const patterns = [
    { re: /\bS(\d{1,2})[\s._-]*E(?:P)?\s*(\d{1,3})\b/i, seasonGroup: 1, episodeGroup: 2 },
    { re: /\b(\d{1,2})x(\d{2,3})\b/, seasonGroup: 1, episodeGroup: 2 },
    { re: /第\s*(\d{1,3})\s*[集话話期]/, seasonGroup: null, episodeGroup: 1 },
    { re: /\bEpisode\s*(\d{1,3})\b/i, seasonGroup: null, episodeGroup: 1 },
    { re: /\bE(?:P)?\s*(\d{1,3})\b/i, seasonGroup: null, episodeGroup: 1 },
    { re: /(?:^|[\s._\-])[-–]\s*(\d{1,3})(?:v\d)?(?=[\s._\[]|$)/, seasonGroup: null, episodeGroup: 1 },
    { re: /^(\d{1,3})$/, seasonGroup: null, episodeGroup: 1 },
  ];

  for (const p of patterns) {
    const m = base.match(p.re);
    if (!m) continue;
    if (p.seasonGroup) season = Number(m[p.seasonGroup]);
    episode = Number(m[p.episodeGroup]);
    markerStart = m.index || 0;
    markerEnd = markerStart + m[0].length;
    break;
  }

  // The last year-looking token is the most reliable release year
  // (handles titles such as "Blade Runner 2049", "2012").
  const yearMatches = [...base.matchAll(/(?:^|[^\d])((?:19|20)\d{2})(?=[^\d]|$)/g)];
  let year = null;
  let yearIndex = -1;
  if (yearMatches.length) {
    const last = yearMatches[yearMatches.length - 1];
    year = Number(last[1]);
    yearIndex = last.index + last[0].indexOf(last[1]);
  }
  // A far-future "year" is almost always part of the title (Blade Runner 2049),
  // not a release year. Keep an explicitly bracketed year either way.
  if (year && year > new Date().getFullYear() + 1
    && !/\(\s*(?:19|20)\d{2}\s*\)/.test(base)
    && !/\[\s*(?:19|20)\d{2}\s*\]/.test(base)) {
    year = null;
    yearIndex = -1;
  }

  const isEpisode = episode !== null;
  const seriesGuess = markerStart > 0 ? cleanTitle(base.slice(0, markerStart)) : '';
  let episodeTitle = markerEnd > 0 ? cleanTitle(base.slice(markerEnd)) : '';

  // An episode title consisting only of numbers is usually a leftover marker.
  if (!episodeTitle || /^\d+$/.test(episodeTitle)) episodeTitle = '';

  let movieTitle = '';
  if (!isEpisode) {
    let cutAt = base.length;
    if (yearIndex > 0) {
      const prefix = base.slice(0, yearIndex).replace(/[\s._\-(\[]+$/, '');
      if (prefix.trim()) cutAt = prefix.length;
    }
    movieTitle = cleanTitle(base.slice(0, cutAt));
    if (!movieTitle) movieTitle = cleanTitle(base);
  }

  return {
    base,
    year,
    season,
    episode,
    isEpisode,
    seriesTitle: seriesGuess,
    movieTitle,
    episodeTitle,
    markerStart,
    markerEnd,
  };
}

/**
 * Find sidecar poster/backdrop images for a folder/item.
 */
export function findArtFiles(dir, baseName) {
  const out = { poster: null, backdrop: null };
  if (!dir) return out;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const pick = (candidates) => {
    for (const candidate of candidates) {
      if (!candidate) continue;
      for (const ext of IMAGE_EXTS) {
        const actual = byLower.get(`${candidate}${ext}`.toLowerCase());
        if (actual) return path.join(dir, actual);
      }
    }
    return null;
  };

  const base = baseName || '';
  out.poster = pick(['poster', 'folder', 'cover', 'movie', 'show', base, `${base}-poster`, `${base}.poster`]);
  out.backdrop = pick(['fanart', 'backdrop', 'background', `${base}-fanart`, `${base}-backdrop`, `${base}.fanart`]);
  return out;
}

/**
 * Find subtitle sidecars that belong to a video file.
 */
export function findSubtitleFiles(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const seen = new Set();
  const results = [];
  const dirs = [dir, path.join(dir, 'Subs'), path.join(dir, 'subs'), path.join(dir, 'Subtitles')];

  for (const d of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(d);
    } catch {
      continue;
    }
    for (const name of names) {
      const ext = path.extname(name).toLowerCase();
      if (!SUB_EXTS.has(ext)) continue;
      const nb = path.basename(name, path.extname(name));
      const matches = nb === base
        || nb.startsWith(`${base}.`)
        || (d !== dir && nb.startsWith(base));
      if (!matches) continue;
      const full = path.join(d, name);
      if (seen.has(full.toLowerCase())) continue;
      seen.add(full.toLowerCase());
      results.push({ file: full, name, stem: nb, ext });
    }
  }

  results.sort((a, b) => naturalCompare(a.name, b.name));
  return results;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    fs.renameSync(tmp, file);
  }
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class TaskQueue {
  constructor(concurrency = 2) {
    this.concurrency = concurrency;
    this.active = 0;
    this.tasks = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.tasks.push({ fn, resolve, reject });
      this._next();
    });
  }

  _next() {
    if (this.active >= this.concurrency) return;
    const task = this.tasks.shift();
    if (!task) return;
    this.active += 1;
    Promise.resolve()
      .then(task.fn)
      .then(task.resolve, task.reject)
      .finally(() => {
        this.active -= 1;
        this._next();
      });
  }
}
