import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  DATA_DIR,
  PUBLIC_DIR,
  ROOT,
  lanAddresses,
  loadConfig,
  normalizeLibraries,
  persistConfig,
} from './config.js';
import { MediaTools } from './ffmpeg.js';
import { Library } from './library.js';
import { UserStore } from './users.js';
import {
  downloadImage,
  downloadSubtitle,
  searchMetadata,
  searchSubtitles,
} from './metadata.js';

const SERVER_VERSION = '1.0.0';
const START_TIME = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.writableEnded) return;
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(data);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return null;
  let start;
  let end;
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Number(endRaw) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= size || end < start) return null;
  end = Math.min(end, size - 1);
  return { start, end, length: end - start + 1 };
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 1024 * 1024) {
  const raw = await readBody(req, limit);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('JSON 格式错误'), { status: 400 });
  }
}

function sendBuffer(req, res, buffer, { status = 200, type = 'application/octet-stream', cache = 'no-store' } = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buffer.length,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(buffer);
}

function sendFile(req, res, file, { type, cache = 'no-store', filename = null } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    sendError(res, 404, '文件不存在');
    return;
  }
  if (!stat.isFile()) {
    sendError(res, 404, '文件不存在');
    return;
  }
  const headers = {
    'Content-Type': type || mimeFor(file),
    'Content-Length': stat.size,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
  };
  if (filename) {
    headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function sendRangeFile(req, res, file, type) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    sendError(res, 404, '文件不存在');
    return;
  }
  if (!stat.isFile()) {
    sendError(res, 404, '文件不存在');
    return;
  }

  const headers = {
    'Content-Type': type || mimeFor(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  };

  const range = req.headers.range;
  if (range) {
    const parsed = parseRange(range, stat.size);
    if (!parsed) {
      res.writeHead(416, {
        'Content-Range': `bytes */${stat.size}`,
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end('请求范围无效');
      return;
    }
    headers['Content-Range'] = `bytes ${parsed.start}-${parsed.end}/${stat.size}`;
    headers['Content-Length'] = parsed.length;
    res.writeHead(206, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file, { start: parsed.start, end: parsed.end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return;
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function serveStatic(req, res, pathname) {
  let rel = pathname.replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  const candidate = path.resolve(PUBLIC_DIR, rel);
  const base = PUBLIC_DIR.toLowerCase();
  const check = candidate.toLowerCase();
  if (check !== base && !check.startsWith(base + path.sep)) {
    sendError(res, 403, '禁止访问');
    return;
  }

  let stat = null;
  try {
    stat = fs.statSync(candidate);
  } catch {
    stat = null;
  }
  if (stat && stat.isFile()) {
    sendFile(req, res, candidate, { cache: 'no-cache' });
    return;
  }

  if (path.extname(rel)) {
    sendError(res, 404, '页面不存在');
    return;
  }

  const fallback = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(fallback)) {
    sendError(res, 503, '前端文件缺失，请重新下载完整的 Lumina 目录');
    return;
  }
  sendFile(req, res, fallback, { type: MIME['.html'], cache: 'no-cache' });
}

function createApp({ config, tools, library, users }) {
  const settingsPayload = () => ({
    serverName: config.serverName,
    version: SERVER_VERSION,
    host: config.host,
    port: config.port,
    mediaDirs: config.mediaDirs,
    scanOnStart: config.scanOnStart,
    scanIntervalMinutes: config.scanIntervalMinutes,
    transcode: config.transcode,
    metadata: {
      provider: config.metadata?.provider || 'auto',
      language: config.metadata?.language || 'zh',
      subtitleLanguage: config.metadata?.subtitleLanguage || 'zh',
      hasTmdbKey: Boolean(config.metadata?.tmdbApiKey),
    },
    ffmpeg: {
      available: tools.available,
      ffprobe: tools.ffprobeAvailable,
      version: tools.version,
      path: tools.ffmpeg,
      ffprobePath: tools.ffprobe,
    },
    lan: lanAddresses(),
    root: ROOT,
  });

  const settingsDir = (dir) => {
    const value = String(dir || '').trim();
    if (!value) return null;
    const abs = path.isAbsolute(value) ? path.normalize(value) : path.resolve(ROOT, value);
    try {
      if (!fs.statSync(abs).isDirectory()) return null;
    } catch {
      return null;
    }
    return abs;
  };

  const effectiveAge = (entity) => {
    if (!entity) return entity;
    let rating = entity.ageRating ?? null;
    if (entity.kind === 'episode' && entity.seriesId) {
      const show = library.getSeries(entity.seriesId);
      if (show?.ageRating !== null && show?.ageRating !== undefined) {
        rating = rating === null ? show.ageRating : Math.max(rating, show.ageRating);
      }
    }
    return { ...entity, ageRating: rating };
  };

  const canViewLibrary = (user, entity) => {
    if (!entity || user?.role === 'admin') return true;
    const libraryId = entity.libraryId;
    if (!libraryId) return true;
    const bucket = (config.libraries || []).find((entry) => entry.id === libraryId);
    if (!bucket || bucket.enabled === false) return false;
    if (bucket.access === 'admins') return false;
    if (bucket.access === 'selected' && !(bucket.userIds || []).includes(user.id)) return false;
    return users.allowedAge(user) >= (Number(bucket.minAge) || 0);
  };

  const canView = (user, entity) => canViewLibrary(user, entity) && users.canView(user, effectiveAge(entity));

  const canViewEntity = (user, id) => {
    const item = library.getItem(id);
    if (item) return canView(user, item) ? item : null;
    const series = library.getSeries(id);
    if (series) return canView(user, series) ? series : null;
    return null;
  };

  const requireAdmin = (user) => {
    if (!user) {
      const err = new Error('请先登录');
      err.status = 401;
      throw err;
    }
    if (user.role !== 'admin') {
      const err = new Error('需要管理员权限');
      err.status = 403;
      throw err;
    }
  };

  return async function handle(req, res) {
    const started = Date.now();
    req.on('error', () => {});
    res.on('error', () => {});

    const host = req.headers.host || 'localhost';
    let url;
    try {
      url = new URL(req.url, `http://${host}`);
    } catch {
      sendError(res, 400, '无效的请求地址');
      return;
    }
    const pathname = decodePathname(url.pathname);
    if (pathname == null) {
      sendError(res, 400, '无效的请求地址');
      return;
    }
    const method = req.method || 'GET';

    try {
      const user = users.userFromRequest(req);
      if (pathname.startsWith('/api/') && method !== 'GET' && method !== 'HEAD') {
        users.assertSameOrigin(req);
      }

      if (pathname === '/api/health' && method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          name: config.serverName,
          version: SERVER_VERSION,
          uptime: Math.round((Date.now() - START_TIME) / 1000),
          ffmpeg: tools.available,
          ffprobe: tools.ffprobeAvailable,
          stats: library.stats(),
          scanning: library.scanning,
          auth: {
            needsSetup: users.needsSetup(),
            users: users.count(),
            allowRegistration: users.allowRegistration,
          },
        });
        return;
      }

      if (pathname === '/api/auth/status' && method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          needsSetup: users.needsSetup(),
          allowRegistration: users.allowRegistration,
          count: users.count(),
          user: user ? users.publicUser(user) : null,
        });
        return;
      }

      if (pathname === '/api/auth/register' && method === 'POST') {
        const body = await readJson(req);
        const result = await users.register(body);
        const token = users.issueSession(result.user, req);
        sendJson(res, 200, {
          ok: true,
          firstUser: result.firstUser,
          user: users.publicUser(result.user),
        }, users.cookieFor(token));
        return;
      }

      if (pathname === '/api/auth/login' && method === 'POST') {
        const body = await readJson(req);
        const result = await users.login(body.username, body.password, req);
        sendJson(res, 200, {
          ok: true,
          user: users.publicUser(result.user),
        }, users.cookieFor(result.token));
        return;
      }

      if (pathname === '/api/auth/logout' && method === 'POST') {
        sendJson(res, 200, { ok: true }, users.logout(req, res));
        return;
      }

      if (!user && pathname.startsWith('/api/')) {
        sendError(res, 401, '请先登录');
        return;
      }

      const avatarMatch = /^\/api\/avatar\/([a-zA-Z0-9_]+)$/.exec(pathname);
      if (avatarMatch && method === 'GET') {
        const avatar = users.avatarFile(avatarMatch[1]);
        if (!avatar) {
          sendError(res, 404, '头像不存在');
          return;
        }
        sendFile(req, res, avatar.file, {
          type: avatar.mime,
          cache: 'private, max-age=31536000, immutable',
        });
        return;
      }

      if (pathname === '/api/auth/profile' && method === 'POST') {
        const body = await readJson(req, 4 * 1024 * 1024);
        const updated = users.updateProfile(user.id, {
          displayName: body.displayName,
          birthDate: body.birthDate,
          avatar: body.avatar,
          removeAvatar: Boolean(body.removeAvatar),
          cancelBirthDate: Boolean(body.cancelBirthDate),
        });
        const pending = Boolean(updated.pendingBirthDate);
        sendJson(res, 200, {
          ok: true,
          user: users.publicUser(updated),
          pendingBirthDate: pending,
          message: pending ? '出生日期修改已提交，等待管理员确认' : '个人资料已保存',
        });
        return;
      }

      if (pathname === '/api/auth/password' && method === 'POST') {
        const body = await readJson(req);
        await users.changePassword(user.id, body.currentPassword, body.newPassword);
        sendJson(res, 200, {
          ok: true,
          message: '密码已修改，请重新登录',
        }, users.logoutCookie());
        return;
      }

      if (pathname === '/api/auth/settings' && method === 'GET') {
        requireAdmin(user);
        sendJson(res, 200, {
          ok: true,
          allowRegistration: users.allowRegistration,
          count: users.count(),
        });
        return;
      }

      if (pathname === '/api/auth/settings' && method === 'POST') {
        requireAdmin(user);
        const body = await readJson(req);
        const allowRegistration = users.setAllowRegistration(body.allowRegistration);
        sendJson(res, 200, { ok: true, allowRegistration });
        return;
      }

      if (pathname === '/api/users' && method === 'GET') {
        requireAdmin(user);
        sendJson(res, 200, {
          ok: true,
          users: users.listUsers(),
          allowRegistration: users.allowRegistration,
        });
        return;
      }

      if (pathname === '/api/users' && method === 'POST') {
        requireAdmin(user);
        const body = await readJson(req);
        const result = await users.createUser(body, {
          role: body.role,
          allowUnrated: body.allowUnrated !== false,
          skipRegistrationCheck: true,
        });
        sendJson(res, 200, { ok: true, user: users.publicUser(result.user) });
        return;
      }

      const userPasswordMatch = /^\/api\/users\/([a-zA-Z0-9_]+)\/password$/.exec(pathname);
      if (userPasswordMatch && method === 'POST') {
        requireAdmin(user);
        const body = await readJson(req);
        await users.resetPassword(userPasswordMatch[1], body.password);
        sendJson(res, 200, { ok: true, message: '密码已重置' });
        return;
      }

      const userBirthdateMatch = /^\/api\/users\/([a-zA-Z0-9_]+)\/birthdate$/.exec(pathname);
      if (userBirthdateMatch && method === 'POST') {
        requireAdmin(user);
        const body = await readJson(req);
        if (body.action === 'approve') {
          const updated = users.approveBirthDate(userBirthdateMatch[1]);
          sendJson(res, 200, { ok: true, user: users.publicUser(updated) });
          return;
        }
        if (body.action === 'reject') {
          const updated = users.rejectBirthDate(userBirthdateMatch[1]);
          sendJson(res, 200, { ok: true, user: users.publicUser(updated) });
          return;
        }
        sendError(res, 400, '无效的操作');
        return;
      }

      const userMatch = /^\/api\/users\/([a-zA-Z0-9_]+)$/.exec(pathname);
      if (userMatch && method === 'PATCH') {
        requireAdmin(user);
        const body = await readJson(req);
        const updated = users.updateUser(userMatch[1], body, user);
        sendJson(res, 200, { ok: true, user: users.publicUser(updated) });
        return;
      }
      if (userMatch && method === 'DELETE') {
        requireAdmin(user);
        users.deleteUser(userMatch[1], user);
        library.removeUserProgress(userMatch[1]);
        library.removeUserFavorites(userMatch[1]);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/ratings' && method === 'POST') {
        requireAdmin(user);
        const body = await readJson(req);
        const result = library.setAgeRating(body.kind, String(body.id || ''), body.ageRating);
        sendJson(res, 200, { ok: true, rating: result });
        return;
      }

      if (pathname === '/api/libraries' && method === 'GET') {
        requireAdmin(user);
        sendJson(res, 200, {
          ok: true,
          libraries: library.getLibraries(),
          revision: Number(config.libraryRevision) || 0,
        });
        return;
      }

      if (pathname === '/api/libraries' && method === 'POST') {
        requireAdmin(user);
        const body = await readJson(req);
        if (process.env.LUMINA_LOG === '1') {
          const peer = req.socket?.remoteAddress || '-';
          console.log(`[libraries] save by ${user.username} from ${peer}: ${JSON.stringify(body.libraries)}`);
        }
        if (!Array.isArray(body.libraries)) {
          sendError(res, 400, '媒体库列表格式不正确');
          return;
        }
        const baseRevision = Number(body.baseRevision);
        if (!Number.isInteger(baseRevision) || baseRevision !== (Number(config.libraryRevision) || 0)) {
          sendError(res, 409, '媒体库设置已在其他页面更新，请刷新页面后重试');
          return;
        }
        const input = body.libraries;
        if (input.length > 64) {
          sendError(res, 400, '媒体库数量过多');
          return;
        }
        const normalized = normalizeLibraries(input, []);
        if (normalized.length !== input.length) {
          sendError(res, 400, '媒体库路径不能为空或重复');
          return;
        }
        if (!normalized.some((entry) => entry.enabled !== false)) {
          sendError(res, 400, '至少需要保留一个启用的媒体库');
          return;
        }
        const invalid = normalized.filter((entry) => !settingsDir(entry.path));
        if (invalid.length) {
          sendError(res, 400, `以下媒体库目录不存在或无法访问：${invalid.map((entry) => entry.path).join('、')}`);
          return;
        }
        const validUserIds = new Set(users.listUsers().map((entry) => entry.id));
        for (const entry of normalized) {
          entry.userIds = entry.userIds.filter((id) => validUserIds.has(id));
        }
        config.libraries = normalized;
        config.libraryRevision = (Number(config.libraryRevision) || 0) + 1;
        persistConfig(config);
        library.config = config;
        await library.setLibraries(normalized);
        sendJson(res, 200, {
          ok: true,
          libraries: library.getLibraries(),
          revision: config.libraryRevision,
          stats: library.stats(),
        });
        return;
      }

      if (pathname === '/api/library' && method === 'GET') {
        const filter = user.role === 'admin' ? null : (entity) => canView(user, entity);
        sendJson(res, 200, library.getPayload({
          canView: filter,
          includeMediaDirs: user.role === 'admin',
        }));
        return;
      }

      if (pathname === '/api/favorites' && method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          ...library.getFavoritePayload(user.id, { canView: (entity) => canView(user, entity) }),
        });
        return;
      }

      if (pathname === '/api/favorites' && method === 'POST') {
        const body = await readJson(req);
        const kind = body.kind === 'series' ? 'series' : body.kind === 'movie' ? 'movie' : '';
        const id = String(body.id || '');
        if (!kind || !id) {
          sendError(res, 400, '缺少收藏类型或媒体 id');
          return;
        }
        const entity = kind === 'movie' ? library.getItem(id) : library.getSeries(id);
        if (!entity || !canView(user, entity)) {
          sendError(res, 404, '影片不存在或不可见');
          return;
        }
        const result = library.toggleFavorite(user.id, kind, id);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (pathname === '/api/scan' && method === 'POST') {
        requireAdmin(user);
        if (library.scanning) {
          sendJson(res, 202, { started: false, scanning: true, message: '正在扫描中' });
          return;
        }
        library.scan().catch((err) => console.warn(`[scan] ${err.message}`));
        sendJson(res, 202, { started: true, scanning: true });
        return;
      }

      if (pathname === '/api/scan/status' && method === 'GET') {
        sendJson(res, 200, library.getScanStatus());
        return;
      }

      if (pathname === '/api/progress' && method === 'GET') {
        sendJson(res, 200, { progress: library.getProgress(user.id) });
        return;
      }

      if (pathname === '/api/progress' && method === 'POST') {
        const body = await readJson(req);
        const id = String(body.id || '');
        if (!id) {
          sendError(res, 400, '缺少媒体 id');
          return;
        }
        const record = library.setProgress(user.id, id, {
          position: body.position,
          duration: body.duration,
          completed: body.completed,
        });
        sendJson(res, 200, { ok: true, progress: record });
        return;
      }

      const progressMatch = /^\/api\/progress\/([a-f0-9]+)$/i.exec(pathname);
      if (progressMatch && method === 'DELETE') {
        library.removeProgress(user.id, progressMatch[1]);
        sendJson(res, 200, { ok: true });
        return;
      }

      const playMatch = /^\/api\/play\/([a-f0-9]+)$/i.exec(pathname);
      if (playMatch && method === 'GET') {
        const filter = user.role === 'admin' ? null : (entity) => canView(user, entity);
        const info = await library.getPlayInfo(playMatch[1], { canView: filter, userId: user.id });
        sendJson(res, 200, info);
        return;
      }

      const streamMatch = /^\/api\/stream\/([a-f0-9]+)$/i.exec(pathname);
      if (streamMatch && (method === 'GET' || method === 'HEAD')) {
        const item = library.getItem(streamMatch[1]);
        if (!item) {
          sendError(res, 404, '媒体不存在');
          return;
        }
        if (!canView(user, item)) {
          sendError(res, 403, '你没有权限观看这部影片');
          return;
        }
        sendRangeFile(req, res, item.filePath, mimeFor(item.filePath));
        return;
      }

      const hlsMasterMatch = /^\/api\/hls\/([a-f0-9]+)\/master\.m3u8$/i.exec(pathname);
      if (hlsMasterMatch && method === 'GET') {
        const item = library.getItem(hlsMasterMatch[1]);
        if (!item) {
          sendError(res, 404, '媒体不存在');
          return;
        }
        if (!canView(user, item)) {
          sendError(res, 403, '你没有权限观看这部影片');
          return;
        }
        const { playlist } = await library.getHlsPlaylist(hlsMasterMatch[1], url.searchParams.get('q'));
        sendBuffer(req, res, Buffer.from(playlist), {
          type: MIME['.m3u8'],
          cache: 'no-cache',
        });
        return;
      }

      const hlsSegmentMatch = /^\/api\/hls\/([a-f0-9]+)\/(\d+)\.ts$/i.exec(pathname);
      if (hlsSegmentMatch && (method === 'GET' || method === 'HEAD')) {
        const item = library.getItem(hlsSegmentMatch[1]);
        if (!item) {
          sendError(res, 404, '媒体不存在');
          return;
        }
        if (!canView(user, item)) {
          sendError(res, 403, '你没有权限观看这部影片');
          return;
        }
        const file = await library.getHlsSegment(
          hlsSegmentMatch[1],
          url.searchParams.get('q'),
          hlsSegmentMatch[2],
        );
        sendFile(req, res, file, {
          type: MIME['.ts'],
          cache: 'private, max-age=604800',
        });
        return;
      }

      const artMatch = /^\/api\/art\/([a-f0-9]+)$/i.exec(pathname);
      if (artMatch && (method === 'GET' || method === 'HEAD')) {
        const entity = canViewEntity(user, artMatch[1]);
        if (!entity) {
          sendError(res, 404, '暂无封面');
          return;
        }
        const art = await library.getArt(artMatch[1], url.searchParams.get('type') || 'poster');
        if (!art) {
          sendJson(res, 404, { error: '暂无封面' }, { 'Cache-Control': 'no-store' });
          return;
        }
        sendFile(req, res, art.file, {
          type: mimeFor(art.file),
          cache: 'private, max-age=86400',
        });
        return;
      }

      const subtitleMatch = /^\/api\/subtitles\/([a-f0-9]+)\/([a-z0-9]+)$/i.exec(pathname);
      if (subtitleMatch && method === 'GET') {
        const item = library.getItem(subtitleMatch[1]);
        if (!item) {
          sendError(res, 404, '媒体不存在');
          return;
        }
        if (!canView(user, item)) {
          sendError(res, 403, '你没有权限观看这部影片');
          return;
        }
        const file = await library.getSubtitleFile(subtitleMatch[1], subtitleMatch[2]);
        sendFile(req, res, file, {
          type: MIME['.vtt'],
          cache: 'private, max-age=86400',
        });
        return;
      }

      if (pathname === '/api/metadata/search' && method === 'GET') {
        requireAdmin(user);
        const query = String(url.searchParams.get('q') || '').trim();
        const kind = url.searchParams.get('kind') === 'series' ? 'series' : 'movie';
        const year = Number(url.searchParams.get('year')) || null;
        if (!query) {
          sendError(res, 400, '请输入要搜索的片名');
          return;
        }
        const result = await searchMetadata({ query, kind, year, config });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (pathname === '/api/metadata/apply' && method === 'POST') {
        requireAdmin(user);
        const body = await readJson(req, 64 * 1024);
        const kind = body.kind === 'series' ? 'series' : 'movie';
        const id = String(body.id || '');
        const entity = kind === 'series' ? library.getSeries(id) : library.getItem(id);
        if (!entity || (kind === 'movie' && entity.kind !== 'movie')) {
          sendError(res, 404, '影片不存在');
          return;
        }
        const title = String(body.title || '').trim().slice(0, 200);
        if (!title) {
          sendError(res, 400, '标题不能为空');
          return;
        }
        let warning = '';
        let posterPath = null;
        let backdropPath = null;
        for (const [type, key] of [['poster', 'posterUrl'], ['backdrop', 'backdropUrl']]) {
          const source = String(body[key] || '').trim();
          if (!source) continue;
          try {
            const image = await downloadImage(source, {
              destDir: library.metadataDir,
              kind,
              id,
              type,
            });
            if (image) {
              const rel = path.relative(DATA_DIR, image.file).split(path.sep).join('/');
              if (type === 'poster') posterPath = rel;
              else backdropPath = rel;
            }
          } catch (err) {
            warning = warning || `封面保存失败：${err.message}`;
          }
        }
        const metadata = library.setMetadata(kind, id, {
          title,
          year: body.year,
          overview: body.overview,
          posterPath: posterPath || undefined,
          backdropPath: backdropPath || undefined,
          source: body.source || 'manual',
          externalId: body.externalId,
        });
        sendJson(res, 200, { ok: true, metadata, warning });
        return;
      }

      if (pathname === '/api/metadata/subtitles' && method === 'GET') {
        requireAdmin(user);
        const itemId = String(url.searchParams.get('itemId') || '');
        const item = itemId ? library.getItem(itemId) : null;
        if (!item) {
          sendError(res, 404, '媒体不存在');
          return;
        }
        const kind = item.kind === 'episode' ? 'series' : 'movie';
        const title = item.kind === 'episode' ? (item.seriesTitle || item.title) : item.title;
        const show = item.kind === 'episode' ? library.getSeries(item.seriesId) : null;
        const result = await searchSubtitles({
          title,
          kind,
          year: show?.year || item.year || null,
          season: item.kind === 'episode' ? item.season : null,
          episode: item.kind === 'episode' ? item.episode : null,
          lang: url.searchParams.get('lang') || config.metadata?.subtitleLanguage || 'zh',
        });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (pathname === '/api/metadata/subtitles' && method === 'POST') {
        requireAdmin(user);
        const body = await readJson(req, 64 * 1024);
        const itemId = String(body.itemId || '');
        const item = library.getItem(itemId);
        if (!item) {
          sendError(res, 404, '媒体不存在');
          return;
        }
        const buffer = await downloadSubtitle(body.subtitleId);
        const track = library.saveOnlineSubtitle(
          itemId,
          buffer,
          body.lang || config.metadata?.subtitleLanguage || 'zh',
        );
        sendJson(res, 200, {
          ok: true,
          track,
          subtitles: library.getSubtitleTracks(item).map((entry) => ({
            id: entry.id,
            label: entry.label,
            lang: entry.lang,
            forced: entry.forced,
          })),
        });
        return;
      }

      if (pathname === '/api/settings/metadata' && method === 'POST') {
        requireAdmin(user);
        const body = await readJson(req, 64 * 1024);
        const next = { ...(config.metadata || {}) };
        if (['auto', 'tmdb', 'wikipedia'].includes(body.provider)) next.provider = body.provider;
        if (body.clearTmdbKey === true) next.tmdbApiKey = '';
        else if (typeof body.tmdbApiKey === 'string' && body.tmdbApiKey.trim()) {
          next.tmdbApiKey = body.tmdbApiKey.trim();
        }
        if (body.language === 'en' || body.language === 'zh') next.language = body.language;
        if (typeof body.subtitleLanguage === 'string' && body.subtitleLanguage.trim()) {
          next.subtitleLanguage = body.subtitleLanguage.trim().slice(0, 12);
        }
        config.metadata = next;
        persistConfig(config);
        sendJson(res, 200, {
          ok: true,
          metadata: {
            provider: next.provider,
            language: next.language,
            subtitleLanguage: next.subtitleLanguage,
            hasTmdbKey: Boolean(next.tmdbApiKey),
          },
        });
        return;
      }

      if (pathname === '/api/settings' && method === 'GET') {
        requireAdmin(user);
        sendJson(res, 200, settingsPayload());
        return;
      }

      if (pathname === '/api/settings/media-dirs' && method === 'POST') {
        requireAdmin(user);
        const body = await readJson(req);
        const input = Array.isArray(body.dirs) ? body.dirs : [];
        if (!input.length) {
          sendError(res, 400, '请至少提供一个媒体目录');
          return;
        }
        const dirs = [];
        const invalid = [];
        for (const raw of input) {
          const abs = settingsDir(raw);
          if (!abs) invalid.push(String(raw));
          else if (!dirs.some((d) => d.toLowerCase() === abs.toLowerCase())) dirs.push(abs);
        }
        if (invalid.length) {
          sendError(res, 400, `以下目录不存在或无法访问：${invalid.join('、')}`);
          return;
        }
        config.mediaDirs = dirs;
        library.config = config;
        await library.setMediaDirs(dirs);
        persistConfig(config);
        sendJson(res, 200, {
          ok: true,
          mediaDirs: config.mediaDirs,
          stats: library.stats(),
        });
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendError(res, 404, '接口不存在');
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        serveStatic(req, res, pathname);
        return;
      }

      sendError(res, 405, '不支持的请求方法');
    } catch (err) {
      const status = Number(err?.status) || 500;
      if (status >= 500) {
        console.error(`[http] ${method} ${pathname} -> ${status}:`, err?.stack || err);
      }
      if (!res.headersSent) sendError(res, status, err?.message || '服务器内部错误');
      else res.destroy();
    } finally {
      if (process.env.LUMINA_LOG === '1') {
        const peer = req.socket?.remoteAddress || '-';
        const ua = String(req.headers['user-agent'] || '-').slice(0, 80);
        console.log(`[http] ${peer} ${method} ${pathname} ${res.statusCode} ${Date.now() - started}ms ua="${ua}"`);
      }
    }
  };
}

async function main() {
  const config = loadConfig();
  console.log('[boot] 正在检查 ffmpeg / ffprobe…');
  const tools = new MediaTools(config);
  await tools.init();

  const users = new UserStore({ dataDir: DATA_DIR });
  const library = new Library({ config, tools, dataDir: DATA_DIR });
  console.log('[boot] 正在载入媒体库…');
  await library.init();

  const app = createApp({ config, tools, library, users });
  const server = http.createServer((req, res) => {
    app(req, res).catch((err) => {
      console.error('[http] 未捕获错误:', err);
      if (!res.headersSent) sendError(res, 500, '服务器内部错误');
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;

  const shutdown = (signal) => {
    console.log(`\n[shutdown] 收到 ${signal}，正在退出…`);
    library.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[boot] 端口 ${config.port} 已被占用。`);
      console.error('       请关闭占用该端口的程序，或修改 config.json 里的 port 后重新启动。\n');
    } else {
      console.error('[boot] 启动失败:', err);
    }
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    const lan = lanAddresses();
    const stats = library.stats();
    const line = '─'.repeat(54);
    console.log(`\n${line}`);
    console.log(`  ${config.serverName}  ·  Lumina ${SERVER_VERSION}`);
    console.log(`${line}`);
    console.log(`  本机访问   http://localhost:${config.port}`);
    for (const { name, address } of lan) {
      console.log(`  局域网     http://${address}:${config.port}   (${name})`);
    }
    console.log(`${line}`);
    console.log(`  媒体目录   ${config.mediaDirs.join('\n             ')}`);
    console.log(`  媒体数量   ${stats.movies} 部电影 · ${stats.series} 部剧集 / ${stats.episodes} 集`);
    console.log(`  用户账号   ${users.needsSetup() ? '尚未创建，打开网页会引导创建管理员' : `${users.count()} 个`}`);
    console.log(`  转码       ${tools.available ? '已启用（MKV/HEVC 按需 HLS）' : '不可用，仅支持浏览器原生格式'}`);
    console.log(`${line}`);
    console.log('  把视频放进媒体目录，网页会自动扫描；按 Ctrl+C 停止服务。\n');
  });
}

main().catch((err) => {
  console.error('[boot] 启动失败:', err);
  process.exit(1);
});
