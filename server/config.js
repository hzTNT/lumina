import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DATA_DIR = path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const CONFIG_PATH = path.join(ROOT, 'config.json');

export const DEFAULTS = {
  serverName: 'Lumina 微光影库',
  host: '0.0.0.0',
  port: 8096,
  mediaDirs: ['./media'],
  libraries: [],
  libraryRevision: 0,
  scanOnStart: true,
  scanIntervalMinutes: 30,
  language: 'zh-CN',
  transcode: {
    enabled: true,
    maxHeight: 1080,
    segmentSeconds: 6,
    crf: 23,
    preset: 'veryfast',
  },
  metadata: {
    provider: 'auto',
    tmdbApiKey: '',
    language: 'zh',
    subtitleLanguage: 'zh',
  },
  ffmpegPath: '',
  ffprobePath: '',
};

function mergeDeep(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = mergeDeep(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function parseArgs() {
  const args = { media: [], port: null, host: null };
  for (const raw of process.argv.slice(2)) {
    if (raw === '--media' || raw === '-m') continue;
    if (raw.startsWith('--media=')) args.media.push(raw.slice(8));
    else if (raw.startsWith('--port=')) args.port = Number(raw.slice(7));
    else if (raw.startsWith('--host=')) args.host = raw.slice(7);
    else if (/^\d+$/.test(raw) && args.port == null) args.port = Number(raw);
  }
  return args;
}

export function resolveBinary(name, configured) {
  if (configured) {
    const p = path.isAbsolute(configured) ? configured : path.resolve(ROOT, configured);
    if (fs.existsSync(p)) return p;
  }
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const local = path.join(ROOT, 'bin', exe);
  if (fs.existsSync(local)) return local;
  return exe;
}

const LIBRARY_ACCESS = new Set(['all', 'selected', 'admins']);
const LIBRARY_AGES = new Set([0, 7, 13, 16, 18]);

function libraryIdFor(absPath) {
  const digest = crypto.createHash('sha1').update(absPath.toLowerCase()).digest('hex');
  return `lib_${digest.slice(0, 10)}`;
}

export function normalizeLibraries(input, fallbackDirs = []) {
  const list = Array.isArray(input) ? input : fallbackDirs.map((dir) => ({ path: dir }));
  const out = [];
  const seenPaths = new Set();
  const seenIds = new Set();
  for (const [index, raw] of list.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const rawPath = String(raw.path || '').trim();
    if (!rawPath) continue;
    const abs = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(ROOT, rawPath);
    const key = abs.toLowerCase();
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);

    let id = typeof raw.id === 'string' && /^lib_[a-z0-9]{6,32}$/.test(raw.id) ? raw.id : libraryIdFor(abs);
    if (seenIds.has(id)) id = `${id}_${index}`;
    seenIds.add(id);

    let name = String(raw.name || '').trim().slice(0, 40);
    if (!name) name = path.basename(abs) || `媒体库 ${index + 1}`;
    const minAge = LIBRARY_AGES.has(Number(raw.minAge)) ? Number(raw.minAge) : 0;
    const access = LIBRARY_ACCESS.has(raw.access) ? raw.access : 'all';
    const userIds = Array.isArray(raw.userIds)
      ? [...new Set(raw.userIds.filter((value) => typeof value === 'string' && value))]
      : [];
    out.push({
      id,
      name,
      path: abs,
      enabled: raw.enabled !== false,
      minAge,
      access,
      userIds: access === 'selected' ? userIds : [],
      createdAt: Number(raw.createdAt) || Date.now(),
    });
  }
  return out;
}

export function libraryPathForConfig(absPath) {
  const rel = path.relative(ROOT, absPath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    ? `./${rel.split(path.sep).join('/')}`
    : absPath;
}

function normalizeMetadata(input = {}) {
  const provider = ['auto', 'tmdb', 'douban', 'tvmaze', 'wikipedia'].includes(input.provider) ? input.provider : 'auto';
  const language = input.language === 'en' ? 'en' : 'zh';
  const subtitleLanguage = String(input.subtitleLanguage || 'zh').trim().slice(0, 12) || 'zh';
  return {
    provider,
    tmdbApiKey: String(input.tmdbApiKey || '').trim(),
    language,
    subtitleLanguage,
  };
}

export function loadConfig() {
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.warn(`[config] 无法解析 config.json，使用默认配置：${err.message}`);
    }
  }

  const cfg = mergeDeep(DEFAULTS, raw);
  const args = parseArgs();

  if (args.port && Number.isFinite(args.port)) cfg.port = args.port;
  if (args.host) cfg.host = args.host;

  let dirs = Array.isArray(cfg.mediaDirs) ? cfg.mediaDirs : [cfg.mediaDirs];
  if (args.media.length) dirs = args.media;

  const resolved = [];
  for (const dir of dirs) {
    if (!dir || typeof dir !== 'string') continue;
    const abs = path.isAbsolute(dir) ? path.normalize(dir) : path.resolve(ROOT, dir);
    if (!resolved.some((d) => d.toLowerCase() === abs.toLowerCase())) resolved.push(abs);
  }
  cfg.mediaDirs = resolved.length ? resolved : [path.join(ROOT, 'media')];
  const hadLibraries = Array.isArray(raw.libraries);
  cfg.libraries = normalizeLibraries(raw.libraries, cfg.mediaDirs);
  cfg.mediaDirs = cfg.libraries.filter((library) => library.enabled).map((library) => library.path);
  cfg.metadata = normalizeMetadata(cfg.metadata);
  cfg.port = Number(cfg.port) || 8096;
  cfg.host = cfg.host || '0.0.0.0';
  cfg.ffmpegResolved = resolveBinary('ffmpeg', cfg.ffmpegPath);
  cfg.ffprobeResolved = resolveBinary('ffprobe', cfg.ffprobePath);

  if (!fs.existsSync(CONFIG_PATH) || !hadLibraries) {
    try {
      persistConfig(cfg);
    } catch (err) {
      console.warn(`[config] 无法写入配置：${err.message}`);
    }
  }

  return cfg;
}

export function persistConfig(cfg) {
  const data = {
    serverName: cfg.serverName,
    host: cfg.host,
    port: cfg.port,
    mediaDirs: (cfg.libraries || []).filter((library) => library.enabled).map((library) => libraryPathForConfig(library.path)),
    libraryRevision: Number(cfg.libraryRevision) || 0,
    libraries: (cfg.libraries || []).map((library) => ({
      id: library.id,
      name: library.name,
      path: libraryPathForConfig(library.path),
      enabled: library.enabled !== false,
      minAge: library.minAge || 0,
      access: library.access || 'all',
      userIds: library.access === 'selected' ? (library.userIds || []) : [],
      createdAt: library.createdAt || Date.now(),
    })),
    scanOnStart: cfg.scanOnStart,
    scanIntervalMinutes: cfg.scanIntervalMinutes,
    language: cfg.language,
    metadata: {
      provider: cfg.metadata?.provider || 'auto',
      tmdbApiKey: cfg.metadata?.tmdbApiKey || '',
      language: cfg.metadata?.language || 'zh',
      subtitleLanguage: cfg.metadata?.subtitleLanguage || 'zh',
    },
    transcode: cfg.transcode,
    ffmpegPath: cfg.ffmpegPath || '',
    ffprobePath: cfg.ffprobePath || '',
  };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function lanAddresses() {
  const out = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const addr of addresses || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push({ name, address: addr.address });
    }
  }
  return out;
}
