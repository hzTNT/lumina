import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { writeJsonAtomic } from './util.js';

const scrypt = promisify(crypto.scrypt);

const SESSION_COOKIE = 'lumina_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const ROLES = new Set(['admin', 'member']);
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_EXTENSIONS = new Set(['jpg', 'png', 'webp', 'gif']);

function now() {
  return Date.now();
}

function ageFromBirthDate(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const birth = new Date(year, month - 1, day);
  if (birth.getFullYear() !== year || birth.getMonth() !== month - 1 || birth.getDate() !== day) return null;
  const today = new Date();
  let age = today.getFullYear() - year;
  const beforeBirthday = today.getMonth() < month - 1
    || (today.getMonth() === month - 1 && today.getDate() < day);
  if (beforeBirthday) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

function normalizeBirthDate(value) {
  if (!value) return '';
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return ageFromBirthDate(text) == null ? null : text;
}

function parseAvatarDataUrl(value) {
  const text = String(value || '').trim();
  const match = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(text);
  if (!match) {
    const err = new Error('头像格式不支持，请选择 JPG、PNG、WebP 或 GIF 图片');
    err.status = 400;
    throw err;
  }
  let ext = match[1].toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (!AVATAR_EXTENSIONS.has(ext)) {
    const err = new Error('头像格式不支持');
    err.status = 400;
    throw err;
  }
  const payload = match[2].replace(/\s+/g, '');
  const buffer = Buffer.from(payload, 'base64');
  if (!buffer.length || buffer.length > AVATAR_MAX_BYTES) {
    const err = new Error('头像大小不能超过 2MB');
    err.status = 400;
    throw err;
  }
  const valid = ext === 'jpg'
    ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    : ext === 'png'
      ? buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : ext === 'gif'
        ? buffer.subarray(0, 4).toString('ascii') === 'GIF8'
        : buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) {
    const err = new Error('头像内容不是有效的图片');
    err.status = 400;
    throw err;
  }
  return { buffer, ext };
}

function validateUsername(value) {
  const username = String(value || '').trim();
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5-]{2,24}$/.test(username)) {
    const err = new Error('用户名需为 2-24 个字符，可使用中英文、数字、下划线或短横线');
    err.status = 400;
    throw err;
  }
  return username;
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 6 || password.length > 200) {
    const err = new Error('密码长度需为 6-200 个字符');
    err.status = 400;
    throw err;
  }
  return password;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function cookieValue(header) {
  return parseCookies(header)[SESSION_COOKIE] || '';
}

function bearerValue(req) {
  const match = /^Bearer\s+([A-Za-z0-9_-]+)$/i.exec(String(req.headers.authorization || ''));
  return match ? match[1] : '';
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = await scrypt(password, salt, 64);
  return {
    salt,
    hash: hash.toString('hex'),
  };
}

async function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) return false;
  try {
    const actual = await scrypt(password, record.salt, 64);
    const expected = Buffer.from(record.hash, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function makeCookie(token, maxAge = SESSION_TTL / 1000) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(maxAge)}`;
}

function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export class UserStore {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'users.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.avatarDir = path.join(dataDir, 'avatars');
    fs.mkdirSync(this.avatarDir, { recursive: true });
    this.users = new Map();
    this.sessions = new Map();
    this.failures = new Map();
    this.allowRegistration = true;
    this.load();
    this.loadSessions();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  load() {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      data = null;
    }
    if (!data || !Array.isArray(data.users)) return;
    for (const raw of data.users) {
      if (!raw?.id || !raw?.username || !raw?.password?.hash) continue;
      this.users.set(raw.id, {
        ...raw,
        disabled: Boolean(raw.disabled),
        allowUnrated: raw.allowUnrated !== false,
      });
    }
    this.allowRegistration = data.allowRegistration !== false;
  }

  save() {
    writeJsonAtomic(this.file, {
      version: 1,
      allowRegistration: this.allowRegistration,
      users: [...this.users.values()],
    });
  }

  loadSessions() {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
    } catch {
      data = null;
    }
    if (!data || !Array.isArray(data.sessions)) return;
    const time = now();
    for (const raw of data.sessions) {
      if (!raw?.token || !raw?.userId || !raw?.expiresAt) continue;
      if (raw.expiresAt <= time) continue;
      const user = this.users.get(raw.userId);
      if (!user || user.disabled) continue;
      this.sessions.set(raw.token, {
        userId: raw.userId,
        createdAt: raw.createdAt || time,
        lastSeen: raw.lastSeen || raw.createdAt || time,
        expiresAt: raw.expiresAt,
        ip: raw.ip || '',
      });
    }
  }

  saveSessions() {
    writeJsonAtomic(this.sessionsFile, {
      version: 1,
      sessions: [...this.sessions.entries()].map(([token, session]) => ({
        token,
        ...session,
      })),
    });
  }

  cleanup() {
    const time = now();
    let sessionsChanged = false;
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= time) {
        this.sessions.delete(token);
        sessionsChanged = true;
      }
    }
    if (sessionsChanged) this.saveSessions();
    for (const [key, value] of this.failures) {
      if (value.resetAt <= time) this.failures.delete(key);
    }
  }

  count() {
    return this.users.size;
  }

  needsSetup() {
    return this.users.size === 0;
  }

  byId(id) {
    return this.users.get(id) || null;
  }

  byUsername(username) {
    const key = String(username || '').trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.username.toLowerCase() === key) return user;
    }
    return null;
  }

  activeAdmins() {
    return [...this.users.values()].filter((user) => user.role === 'admin' && !user.disabled).length;
  }

  allowedAge(user) {
    if (!user) return 0;
    if (user.role === 'admin') return 99;
    const realAge = ageFromBirthDate(user.birthDate);
    return realAge == null ? 18 : Math.min(18, realAge);
  }

  canView(user, entity) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const rating = entity?.ageRating;
    if (rating === null || rating === undefined) return user.allowUnrated !== false;
    return Number(rating) <= this.allowedAge(user);
  }

  avatarFile(userId) {
    const user = this.users.get(userId);
    if (!user || user.disabled || !user.avatar || !AVATAR_EXTENSIONS.has(user.avatar)) return null;
    const file = path.join(this.avatarDir, `${user.id}.${user.avatar}`);
    try {
      if (!fs.statSync(file).isFile()) return null;
    } catch {
      return null;
    }
    const mime = user.avatar === 'jpg' ? 'image/jpeg' : `image/${user.avatar}`;
    return { file, mime };
  }

  avatarUrl(user) {
    if (!user?.avatar) return null;
    return this.avatarFile(user.id) ? `/api/avatar/${user.id}?v=${user.avatarVersion || 0}` : null;
  }

  saveAvatar(user, dataUrl) {
    const { buffer, ext } = parseAvatarDataUrl(dataUrl);
    for (const old of AVATAR_EXTENSIONS) {
      if (old === ext) continue;
      try { fs.rmSync(path.join(this.avatarDir, `${user.id}.${old}`), { force: true }); } catch { /* ignore */ }
    }
    const target = path.join(this.avatarDir, `${user.id}.${ext}`);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, target);
    user.avatar = ext;
    user.avatarVersion = now();
  }

  removeAvatar(user) {
    for (const ext of AVATAR_EXTENSIONS) {
      try { fs.rmSync(path.join(this.avatarDir, `${user.id}.${ext}`), { force: true }); } catch { /* ignore */ }
    }
    delete user.avatar;
    delete user.avatarVersion;
  }

  publicUser(user) {
    if (!user) return null;
    const admin = user.role === 'admin';
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName || user.username,
      role: user.role,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt || null,
      birthDate: user.birthDate || '',
      pendingBirthDate: user.pendingBirthDate || null,
      age: ageFromBirthDate(user.birthDate),
      avatar: this.avatarUrl(user),
      allowUnrated: user.allowUnrated !== false,
      effectiveAge: this.allowedAge(user),
      permissions: {
        manageLibrary: admin,
        manageUsers: admin,
        bypassAge: admin,
      },
    };
  }

  listUsers() {
    return [...this.users.values()]
      .sort((a, b) => {
        if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
        return (a.createdAt || 0) - (b.createdAt || 0);
      })
      .map((user) => this.publicUser(user));
  }

  async createUser(input, { role = 'member', allowUnrated = true, skipRegistrationCheck = false } = {}) {
    const username = validateUsername(input.username);
    const password = validatePassword(input.password);
    if (this.byUsername(username)) {
      const err = new Error('这个用户名已经被占用');
      err.status = 409;
      throw err;
    }
    if (!skipRegistrationCheck && !this.allowRegistration && this.users.size > 0) {
      const err = new Error('管理员已关闭注册');
      err.status = 403;
      throw err;
    }

    const isFirst = this.users.size === 0;
    const birthDate = normalizeBirthDate(input.birthDate);
    if (!birthDate && !isFirst) {
      const err = new Error('出生日期格式应为 YYYY-MM-DD');
      err.status = 400;
      throw err;
    }
    const actualRole = isFirst ? 'admin' : (ROLES.has(role) ? role : 'member');
    const id = `u_${crypto.randomBytes(8).toString('hex')}`;
    const record = {
      id,
      username,
      displayName: String(input.displayName || username).trim().slice(0, 32) || username,
      role: actualRole,
      password: await hashPassword(password),
      birthDate,
      allowUnrated: allowUnrated !== false,
      disabled: false,
      createdAt: now(),
      lastLoginAt: null,
    };
    this.users.set(id, record);
    this.save();
    return { user: record, firstUser: isFirst };
  }

  async register(input) {
    const firstUser = this.needsSetup();
    if (!firstUser && !normalizeBirthDate(input.birthDate)) {
      const err = new Error('请选择有效的出生日期');
      err.status = 400;
      throw err;
    }
    return this.createUser(input, { role: firstUser ? 'admin' : 'member' });
  }

  issueSession(user, req) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, {
      userId: user.id,
      createdAt: now(),
      lastSeen: now(),
      expiresAt: now() + SESSION_TTL,
      ip: req?.socket?.remoteAddress || '',
    });
    user.lastLoginAt = now();
    this.save();
    this.saveSessions();
    return token;
  }

  async login(username, password, req) {
    const key = `${req?.socket?.remoteAddress || ''}|${String(username || '').trim().toLowerCase()}`;
    const time = now();
    const failure = this.failures.get(key);
    if (failure && failure.resetAt > time && failure.count >= 5) {
      const err = new Error(`尝试次数过多，请 ${Math.ceil((failure.resetAt - time) / 60000)} 分钟后再试`);
      err.status = 429;
      throw err;
    }

    const user = this.byUsername(username);
    const valid = user && !user.disabled && await verifyPassword(password, user.password);
    if (!valid) {
      const next = failure && failure.resetAt > time
        ? { count: failure.count + 1, resetAt: failure.resetAt }
        : { count: 1, resetAt: time + 10 * 60 * 1000 };
      this.failures.set(key, next);
      const err = new Error('用户名或密码错误');
      err.status = 401;
      throw err;
    }
    this.failures.delete(key);
    return { user, token: this.issueSession(user, req) };
  }

  userFromRequest(req) {
    const token = cookieValue(req.headers.cookie) || bearerValue(req);
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      this.sessions.delete(token);
      this.saveSessions();
      return null;
    }
    const user = this.users.get(session.userId);
    if (!user || user.disabled) {
      this.sessions.delete(token);
      this.saveSessions();
      return null;
    }
    session.lastSeen = now();
    return user;
  }

  tokenFromRequest(req) {
    return cookieValue(req.headers.cookie) || bearerValue(req);
  }

  logout(req, res) {
    const token = this.tokenFromRequest(req);
    if (token && this.sessions.delete(token)) this.saveSessions();
    return { 'Set-Cookie': clearCookie() };
  }

  logoutCookie() {
    return { 'Set-Cookie': clearCookie() };
  }

  cookieFor(token) {
    return { 'Set-Cookie': makeCookie(token) };
  }

  assertSameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      const err = new Error('请求来源无效');
      err.status = 403;
      throw err;
    }
    if (!req.headers.host || parsed.host !== req.headers.host) {
      const err = new Error('跨站请求被拒绝');
      err.status = 403;
      throw err;
    }
  }

  async changePassword(userId, currentPassword, nextPassword) {
    const user = this.users.get(userId);
    if (!user) {
      const err = new Error('用户不存在');
      err.status = 404;
      throw err;
    }
    if (!await verifyPassword(currentPassword, user.password)) {
      const err = new Error('当前密码不正确');
      err.status = 400;
      throw err;
    }
    user.password = await hashPassword(validatePassword(nextPassword));
    this.save();
    this.revokeUser(userId);
    return true;
  }

  async resetPassword(userId, nextPassword) {
    const user = this.users.get(userId);
    if (!user) {
      const err = new Error('用户不存在');
      err.status = 404;
      throw err;
    }
    user.password = await hashPassword(validatePassword(nextPassword));
    this.save();
    this.revokeUser(userId);
    return true;
  }

  revokeUser(userId) {
    let changed = false;
    for (const [token, session] of this.sessions) {
      if (session.userId === userId) {
        this.sessions.delete(token);
        changed = true;
      }
    }
    if (changed) this.saveSessions();
  }

  updateUser(id, patch, actor) {
    const user = this.users.get(id);
    if (!user) {
      const err = new Error('用户不存在');
      err.status = 404;
      throw err;
    }
    if (patch.username !== undefined && String(patch.username).trim() !== user.username) {
      const err = new Error('用户名创建后不可修改');
      err.status = 400;
      throw err;
    }
    if (patch.role !== undefined) {
      if (!ROLES.has(patch.role)) {
        const err = new Error('无效的角色');
        err.status = 400;
        throw err;
      }
      if (user.role === 'admin' && patch.role !== 'admin' && this.activeAdmins() <= 1) {
        const err = new Error('至少需要保留一名管理员');
        err.status = 400;
        throw err;
      }
      user.role = patch.role;
    }
    if (patch.displayName !== undefined) {
      user.displayName = String(patch.displayName || '').trim().slice(0, 32) || user.username;
    }
    if (patch.birthDate !== undefined) {
      const value = normalizeBirthDate(patch.birthDate);
      if (value === null) {
        const err = new Error('出生日期格式应为 YYYY-MM-DD');
        err.status = 400;
        throw err;
      }
      const changed = value !== (user.birthDate || '');
      user.birthDate = value;
      if (changed) {
        delete user.pendingBirthDate;
        delete user.pendingBirthDateAt;
      }
    }
    if (patch.allowUnrated !== undefined) user.allowUnrated = Boolean(patch.allowUnrated);
    if (patch.disabled !== undefined) {
      const disabled = Boolean(patch.disabled);
      if (disabled && actor?.id === user.id) {
        const err = new Error('不能停用当前登录的账号');
        err.status = 400;
        throw err;
      }
      if (disabled && user.role === 'admin' && this.activeAdmins() <= 1) {
        const err = new Error('至少需要保留一名管理员');
        err.status = 400;
        throw err;
      }
      user.disabled = disabled;
      if (disabled) this.revokeUser(user.id);
    }
    this.save();
    return user;
  }

  updateProfile(userId, patch) {
    const user = this.users.get(userId);
    if (!user) {
      const err = new Error('用户不存在');
      err.status = 404;
      throw err;
    }
    if (patch.username !== undefined && String(patch.username).trim() !== user.username) {
      const err = new Error('用户名创建后不可修改');
      err.status = 400;
      throw err;
    }
    if (patch.displayName !== undefined) {
      const displayName = String(patch.displayName || '').trim().slice(0, 32);
      if (!displayName) {
        const err = new Error('显示名称不能为空');
        err.status = 400;
        throw err;
      }
      user.displayName = displayName;
    }
    if (patch.birthDate !== undefined) {
      const value = normalizeBirthDate(patch.birthDate);
      if (value === null) {
        const err = new Error('出生日期格式应为 YYYY-MM-DD');
        err.status = 400;
        throw err;
      }
      if (user.role === 'admin' || value === (user.birthDate || '')) {
        user.birthDate = value;
        delete user.pendingBirthDate;
        delete user.pendingBirthDateAt;
      } else {
        user.pendingBirthDate = value;
        user.pendingBirthDateAt = now();
      }
    }
    if (patch.cancelBirthDate) {
      delete user.pendingBirthDate;
      delete user.pendingBirthDateAt;
    }
    if (patch.removeAvatar) this.removeAvatar(user);
    if (patch.avatar) this.saveAvatar(user, patch.avatar);
    this.save();
    return user;
  }

  approveBirthDate(userId) {
    const user = this.users.get(userId);
    if (!user) {
      const err = new Error('用户不存在');
      err.status = 404;
      throw err;
    }
    if (!user.pendingBirthDate) {
      const err = new Error('没有待确认的出生日期');
      err.status = 400;
      throw err;
    }
    user.birthDate = user.pendingBirthDate;
    delete user.pendingBirthDate;
    delete user.pendingBirthDateAt;
    this.save();
    return user;
  }

  rejectBirthDate(userId) {
    const user = this.users.get(userId);
    if (!user) {
      const err = new Error('用户不存在');
      err.status = 404;
      throw err;
    }
    delete user.pendingBirthDate;
    delete user.pendingBirthDateAt;
    this.save();
    return user;
  }

  deleteUser(id, actor) {
    const user = this.users.get(id);
    if (!user) {
      const err = new Error('用户不存在');
      err.status = 404;
      throw err;
    }
    if (actor?.id === id) {
      const err = new Error('不能删除当前登录的账号');
      err.status = 400;
      throw err;
    }
    if (user.role === 'admin' && this.activeAdmins() <= 1) {
      const err = new Error('至少需要保留一名管理员');
      err.status = 400;
      throw err;
    }
    this.removeAvatar(user);
    this.users.delete(id);
    this.revokeUser(id);
    this.save();
    return true;
  }

  setAllowRegistration(value) {
    this.allowRegistration = Boolean(value);
    this.save();
    return this.allowRegistration;
  }
}
