const BASE = 'http://127.0.0.1:8096';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function cookieFrom(response) {
  const list = response.headers.getSetCookie?.() || [];
  const raw = list.find((item) => item.startsWith('lumina_session=')) || response.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

async function request(path, { method = 'GET', body, cookie = '' } = {}) {  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { response, data, cookie: cookieFrom(response) };
}

function birthdayYearsAgo(years) {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

console.log('auth smoke');
const status = await request('/api/auth/status');
check('status public', status.response.status === 200);
if (!status.data.needsSetup) {
  console.log('\n[auth-smoke] 当前实例已经有账号，跳过测试：该脚本需要全新的 data/，否则会创建测试账号并修改分级数据。');
  process.exit(1);
}
const unauthorized = await request('/api/library');
check('library requires login', unauthorized.response.status === 401);

const reg = await request('/api/auth/register', {
  method: 'POST',
  body: { username: 'admin', password: 'secret123', displayName: '管理员', birthDate: '1990-01-01' },
});
check('first register creates admin', reg.response.status === 200 && reg.data.user.role === 'admin' && reg.data.firstUser === true);
const adminCookie = reg.cookie;
const library = await request('/api/library', { cookie: adminCookie });
check('admin library returns media', library.response.status === 200 && library.data.movies.length === 2 && library.data.series.length === 1);
const progress = await request('/api/progress', { cookie: adminCookie });
check('progress bucket readable', progress.response.status === 200 && typeof progress.data.progress === 'object');

const star = library.data.movies.find((movie) => movie.title.includes('星际'));
check('rating defaults to unrated', star.ageRating === null && star.ageLabel === '未分级');
const setRating = await request('/api/ratings', {
  method: 'POST',
  cookie: adminCookie,
  body: { kind: 'items', id: star.id, ageRating: 18 },
});
check('admin sets 18+ rating', setRating.response.status === 200 && setRating.data.rating.ageRating === 18);

const member = await request('/api/users', {
  method: 'POST',
  cookie: adminCookie,
  body: { username: 'kid', password: 'secret123', displayName: '小朋友', allowUnrated: true, birthDate: birthdayYearsAgo(7) },
});
check('admin creates member', member.response.status === 200 && member.data.user.role === 'member');
const kidId = member.data.user.id;
const kidLogin = await request('/api/auth/login', {
  method: 'POST',
  body: { username: 'kid', password: 'secret123' },
});
check('member login', kidLogin.response.status === 200 && kidLogin.data.user.role === 'member');
const kidCookie = kidLogin.cookie;

const kidLibrary = await request('/api/library', { cookie: kidCookie });
check('18+ movie hidden from child', !kidLibrary.data.movies.some((movie) => movie.id === star.id));
check('unrated movie visible when allowUnrated', kidLibrary.data.movies.some((movie) => movie.title.includes('Blade Runner')));
check('member cannot see media dirs', Array.isArray(kidLibrary.data.mediaDirs) && kidLibrary.data.mediaDirs.length === 0);

const deniedPlay = await request(`/api/play/${star.id}`, { cookie: kidCookie });
check('18+ play info denied', deniedPlay.response.status === 403);
const deniedStream = await request(`/api/stream/${star.id}`, { cookie: kidCookie });
check('18+ stream denied', deniedStream.response.status === 403);
const deniedArt = await request(`/api/art/${star.id}?type=poster`, { cookie: kidCookie });
check('18+ art denied', deniedArt.response.status === 404);

const tighten = await request(`/api/users/${kidId}`, {
  method: 'PATCH',
  cookie: adminCookie,
  body: { allowUnrated: false },
});
check('admin disallows unrated for child', tighten.response.status === 200 && tighten.data.user.allowUnrated === false);
const strictLibrary = await request('/api/library', { cookie: kidCookie });
check('unrated movie hidden when disallowed', strictLibrary.data.movies.length === 0);
check('unrated series hidden when disallowed', strictLibrary.data.series.length === 0);

const scanDenied = await request('/api/scan', { method: 'POST', cookie: kidCookie, body: {} });
check('member cannot scan', scanDenied.response.status === 403);
const settingsDenied = await request('/api/settings', { cookie: kidCookie });
check('member cannot read settings', settingsDenied.response.status === 403);
const usersDenied = await request('/api/users', { cookie: kidCookie });
check('member cannot list users', usersDenied.response.status === 403);

const child = await request('/api/auth/status', { cookie: kidCookie });
check('status exposes session user', child.data.user?.username === 'kid' && child.data.user.age === 7 && child.data.user.effectiveAge === 7);

const logout = await request('/api/auth/logout', { method: 'POST', cookie: kidCookie, body: {} });
check('logout ok', logout.response.status === 200);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
