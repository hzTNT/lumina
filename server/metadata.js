import fs from 'node:fs';
import path from 'node:path';

const USER_AGENT = 'Lumina/1.0 (local media server)';
const IMAGE_HOSTS = new Set([
  'image.tmdb.org',
  'upload.wikimedia.org',
  'thumb.wikimedia.org',
  'static.tvmaze.com',
]);

function cleanText(value, max = 2000) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function yearFromText(text) {
  const value = String(text || '');
  const localized = value.match(/((?:19|20)\d{2})\s*年/);
  if (localized) return Number(localized[1]);
  const parenthesized = value.match(/[（(]((?:19|20)\d{2})[)）]/);
  if (parenthesized) return Number(parenthesized[1]);
  const plain = value.match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/);
  if (plain) return Number(plain[1]);
  return null;
}

function absoluteImage(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    if (!IMAGE_HOSTS.has(parsed.hostname)
      && !parsed.hostname.endsWith('.wikimedia.org')
      && !parsed.hostname.endsWith('.doubanio.com')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function imageHeaders(url) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'image/*' };
  try {
    if (new URL(url).hostname.endsWith('.doubanio.com')) {
      headers.Referer = 'https://movie.douban.com/';
    }
  } catch {}
  return headers;
}

async function fetchJson(url, { referer = '' } = {}) {
  let res;
  try {
    const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
    if (referer) headers.Referer = referer;
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    const err = new Error('无法连接在线服务，请检查网络或代理后重试');
    err.status = 502;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(res.status === 401 ? '在线服务认证失败，请检查 TMDB API Key' : `在线服务返回错误（${res.status}）`);
    err.status = 502;
    throw err;
  }
  return res.json();
}

export async function searchWikipedia({ query, kind = 'movie', year = null, language = 'zh' }) {
  const q = cleanText(query, 100);
  if (!q) return [];
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: `${q} ${kind === 'series' ? '电视剧' : '电影'}`.trim(),
    gsrlimit: '8',
    prop: 'pageimages|extracts|info',
    inprop: 'url',
    exintro: '1',
    explaintext: '1',
    pithumbsize: '600',
    format: 'json',
  });
  const url = `https://${language === 'en' ? 'en' : 'zh'}.wikipedia.org/w/api.php?${params}`;
  const data = await fetchJson(url);
  const pages = Object.values(data?.query?.pages || {});
  pages.sort((a, b) => (a.index || 99) - (b.index || 99));
  return pages.map((page) => {
    const overview = cleanText(page.extract, 1200);
    return {
      provider: 'wikipedia',
      externalId: String(page.pageid || ''),
      title: page.title || q,
      year: yearFromText(overview) || (Number(year) || null),
      overview,
      posterUrl: absoluteImage(page.thumbnail?.source),
      backdropUrl: null,
      sourceUrl: page.fullurl || '',
    };
  }).filter((item) => item.title && (item.overview || item.posterUrl));
}

export async function searchDouban({ query, kind = 'movie', year = null }) {
  const q = cleanText(query, 100);
  if (!q) return [];
  const data = await fetchJson(
    `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(q)}`,
    { referer: 'https://movie.douban.com/' },
  );
  const rows = Array.isArray(data) ? data : [];
  const wanted = kind === 'series' ? 'tv' : 'movie';
  return rows
    .filter((row) => !row.type || row.type === wanted)
    .slice(0, 10)
    .map((row) => ({
      provider: 'douban',
      externalId: String(row.id || ''),
      title: row.title || q,
      originalTitle: row.sub_title || '',
      year: Number(row.year) || null,
      overview: '',
      posterUrl: absoluteImage(row.img),
      backdropUrl: null,
      sourceUrl: row.url || (row.id ? `https://movie.douban.com/subject/${row.id}/` : ''),
    }))
    .filter((item) => item.title && item.posterUrl);
}

export async function searchTvmaze({ query, kind = 'series', year = null }) {
  const q = cleanText(query, 100);
  if (!q || kind !== 'series') return [];
  const data = await fetchJson(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`);
  const rows = Array.isArray(data) ? data : [];
  return rows.slice(0, 10).map((entry) => {
    const show = entry?.show || {};
    return {
      provider: 'tvmaze',
      externalId: String(show.id || ''),
      title: show.name || q,
      originalTitle: show.name || '',
      year: yearFromText(show.premiered) || null,
      overview: cleanText(show.summary, 1500),
      posterUrl: absoluteImage(show.image?.original),
      backdropUrl: null,
      sourceUrl: show.url || '',
    };
  }).filter((item) => item.title && (item.overview || item.posterUrl));
}

export async function searchTmdb({ query, kind = 'movie', year = null, apiKey, language = 'zh-CN' }) {
  const q = cleanText(query, 100);
  if (!q || !apiKey) return [];
  const type = kind === 'series' ? 'tv' : 'movie';
  const params = new URLSearchParams({
    api_key: apiKey,
    language,
    query: q,
    include_adult: 'false',
  });
  if (year) params.set(type === 'tv' ? 'first_air_date_year' : 'year', String(year));
  const data = await fetchJson(`https://api.themoviedb.org/3/search/${type}?${params}`);
  return (data?.results || []).map((row) => ({
    provider: 'tmdb',
    externalId: String(row.id || ''),
    title: row.title || row.name || q,
    originalTitle: row.original_title || row.original_name || '',
    year: yearFromText(row.release_date || row.first_air_date) || null,
    overview: cleanText(row.overview, 1500),
    posterUrl: absoluteImage(row.poster_path ? `https://image.tmdb.org/t/p/w500${row.poster_path}` : null),
    backdropUrl: absoluteImage(row.backdrop_path ? `https://image.tmdb.org/t/p/w1280${row.backdrop_path}` : null),
    sourceUrl: row.id ? `https://www.themoviedb.org/${type}/${row.id}` : '',
  }));
}

export async function searchMetadata({ query, kind = 'movie', year = null, config = {} }) {
  const meta = config.metadata || {};
  const provider = meta.provider || 'auto';
  const language = meta.language || 'zh';
  if (provider === 'tmdb' && !meta.tmdbApiKey) {
    const err = new Error('请先在设置中配置 TMDB API Key');
    err.status = 400;
    throw err;
  }

  const run = async (name) => {
    if (name === 'tmdb') {
      return searchTmdb({
        query, kind, year,
        apiKey: meta.tmdbApiKey,
        language: language === 'en' ? 'en-US' : 'zh-CN',
      });
    }
    if (name === 'douban') return searchDouban({ query, kind, year });
    if (name === 'tvmaze') return searchTvmaze({ query, kind, year });
    return searchWikipedia({ query, kind, year, language });
  };
  const explicit = ['tmdb', 'douban', 'tvmaze', 'wikipedia'].includes(provider);
  const order = explicit
    ? [provider]
    : [
        ...(meta.tmdbApiKey ? ['tmdb'] : []),
        ...(kind === 'series' ? ['tvmaze'] : []),
        'douban',
        'wikipedia',
      ];

  let lastError = null;
  for (const name of order) {
    try {
      const results = await run(name);
      if (results?.length) return { source: name, results };
    } catch (err) {
      lastError = err;
      if (explicit) {
        const wrapped = new Error(`${name === 'tmdb' ? 'TMDB' : name === 'douban' ? '豆瓣' : name === 'tvmaze' ? 'TVMaze' : '维基百科'} 搜索失败：${err.message}`);
        wrapped.status = err.status === 400 ? 400 : 502;
        throw wrapped;
      }
    }
  }
  if (lastError && order.length) {
    const err = new Error('无法连接在线元数据服务，请检查网络或代理后重试');
    err.status = 502;
    throw err;
  }
  return { source: explicit ? provider : 'wikipedia', results: [] };
}

export async function fetchImage(url) {
  const safeUrl = absoluteImage(url);
  if (!safeUrl) {
    const err = new Error('不支持的图片地址');
    err.status = 400;
    throw err;
  }
  let res;
  try {
    res = await fetch(safeUrl, {
      headers: imageHeaders(safeUrl),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error('无法连接封面图服务，请检查网络后重试');
  }
  if (!res.ok) throw new Error(`图片下载失败（${res.status}）`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > 15 * 1024 * 1024) throw new Error('图片过大');
  const contentType = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  if (!/^image\//.test(contentType)) throw new Error('不是图片');
  return { buffer, contentType };
}

export async function downloadImage(url, { destDir, kind, id, type = 'poster' }) {
  const safeUrl = absoluteImage(url);
  if (!safeUrl) return null;
  let res;
  try {
    res = await fetch(safeUrl, {
      headers: imageHeaders(safeUrl),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error('无法连接封面图服务，请检查网络后重试');
  }
  if (!res.ok) throw new Error(`图片下载失败（${res.status}）`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > 15 * 1024 * 1024) throw new Error('图片过大');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > 15 * 1024 * 1024) throw new Error('图片过大');
  let ext = '';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ext = 'jpg';
  else if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = 'png';
  else if (buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') ext = 'webp';
  else if (buffer.length > 6 && buffer.subarray(0, 3).toString('ascii') === 'GIF') ext = 'gif';
  if (!ext) throw new Error('不支持的图片格式');
  fs.mkdirSync(destDir, { recursive: true });
  const name = `meta-${String(kind).replace(/[^a-z]/gi, '')}-${String(id).replace(/[^a-z0-9]/gi, '')}-${type}.${ext}`;
  const file = path.join(destDir, name);
  const temp = `${file}.part`;
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, file);
  return { file, name };
}

function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[\s._\-:：·,，'’"“”()（）[\]【】]/g, '');
}

function subtitleType(kind) {
  return kind === 'series' ? 'tv-series' : 'movie';
}

async function mysubsTitle({ title, kind, year }) {
  const q = cleanText(title, 100);
  if (!q) return null;
  const data = await fetchJson(`https://www.mysubs.org/api/v1/search?q=${encodeURIComponent(q)}`);
  const rows = Array.isArray(data?.data) ? data.data : [];
  const wanted = subtitleType(kind);
  const scored = rows.map((row) => {
    let score = 0;
    if (row.type === wanted) score += 10;
    if (normalizeTitle(row.name) === normalizeTitle(q)) score += 20;
    if (year && Number(row.year) === Number(year)) score += 5;
    return { row, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.row || null;
}

export async function searchSubtitles({
  title, kind = 'movie', year = null, season = null, episode = null, lang = 'zh',
}) {
  const matched = await mysubsTitle({ title, kind, year });
  if (!matched) return { title: null, results: [] };
  const params = new URLSearchParams();
  const language = cleanText(lang, 12) || 'zh';
  if (language !== 'all') params.set('lang', language);
  if (kind === 'series' && season != null && episode != null) {
    params.set('season', String(season));
    params.set('episode', String(episode));
  }
  const data = await fetchJson(`https://www.mysubs.org/api/v1/titles/${encodeURIComponent(matched.slug)}/subtitles?${params}`);
  const results = (Array.isArray(data?.data) ? data.data : []).map((row) => ({
    id: Number(row.id),
    label: row.language?.name || row.language?.code || language,
    lang: row.language?.code || language,
    format: row.file?.format || 'srt',
    downloads: Number(row.download_count) || 0,
    season: row.episode?.season ?? null,
    episode: row.episode?.number ?? null,
    verified: Boolean(row.is_verified),
    url: row.urls?.srt || row.urls?.vtt || '',
  })).filter((row) => Number.isInteger(row.id) && row.id > 0);
  return {
    title: {
      name: matched.name,
      year: matched.year,
      slug: matched.slug,
    },
    results,
  };
}

export async function downloadSubtitle(id) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    const err = new Error('字幕 id 无效');
    err.status = 400;
    throw err;
  }
  let res;
  try {
    res = await fetch(`https://www.mysubs.org/s/${numeric}.srt`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain, application/x-subrip, */*' },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error('无法连接字幕服务，请检查网络后重试');
  }
  if (!res.ok) throw new Error(`字幕下载失败（${res.status}）`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > 5 * 1024 * 1024) throw new Error('字幕文件过大');
  if (!buffer.length) throw new Error('字幕文件为空');
  return buffer;
}
