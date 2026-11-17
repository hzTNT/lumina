import {
  api,
  debounce,
  episodeCode,
  esc,
  formatBytes,
  formatDuration,
  hueFor,
  icon,
  isBirthday,
  ratio,
  relativeTime,
  showToast,
} from './core.js';
import { Player } from './player.js';

const view = document.getElementById('view');
const searchInput = document.getElementById('search-input');
const scanPill = document.getElementById('scan-pill');
const scanLabel = document.getElementById('scan-label');
const serverState = document.getElementById('server-state');
const serverStateTitle = document.getElementById('server-state-title');
const serverStateSub = document.getElementById('server-state-sub');
const navMovieCount = document.getElementById('nav-movie-count');
const navSeriesCount = document.getElementById('nav-series-count');
const navFavoriteCount = document.getElementById('nav-favorite-count');
const authOverlay = document.getElementById('auth-overlay');
const authPanel = document.getElementById('auth-panel');
const accountBtn = document.getElementById('account-btn');
const accountName = document.getElementById('account-name');
const accountAvatar = document.getElementById('account-avatar');
const accountMenu = document.getElementById('account-menu');
const accountMenuBody = document.getElementById('account-menu-body');
const birthdayBanner = document.getElementById('birthday-banner');

const state = {
  movies: [],
  series: [],
  recentIds: [],
  stats: { movies: 0, series: 0, episodes: 0, totalSize: 0, totalDuration: 0 },
  mediaDirs: [],
  scannedAt: null,
  scanning: false,
  probe: { active: false, done: 0, total: 0 },
  revision: -1,
  progress: {},
  settings: null,
  health: null,
  online: true,
  user: null,
  auth: null,
  users: [],
  allowRegistration: true,
  libraries: [],
  librariesLoaded: false,
  libraryRevision: 0,
  favorites: [],
  favoritesLoaded: false,
  moviesById: new Map(),
  seriesById: new Map(),
  episodesById: new Map(),
};

const seasonChoice = new Map();
let currentRoute = { name: 'home' };
let renderSeq = 0;
let pollTimer = null;
let settingsDirty = false;
let workingLibraries = [];
let player = null;
let authMode = 'login';
let profileDirty = false;
let profileAvatarDraft = null;
let profileAvatarRemoved = false;
let profileSaving = false;
const favoritePending = new Set();

const AGE_OPTIONS = [
  { value: '', label: '不限' },
  { value: '0', label: '全年龄' },
  { value: '7', label: '7+' },
  { value: '13', label: '13+' },
  { value: '16', label: '16+' },
  { value: '18', label: '18+' },
];

function isAdmin() {
  return state.user?.role === 'admin';
}

function ratingChip(entity) {
  const label = entity?.ageLabel || '未分级';
  const tone = entity?.ageRating == null ? 'unrated' : `age-${entity.ageRating}`;
  return `<span class="rating-chip ${tone}">${esc(label)}</span>`;
}

function ageOptions(selected) {
  const normalized = selected === null || selected === undefined ? '' : String(selected);
  return AGE_OPTIONS.map((option) => `<option value="${option.value}" ${option.value === normalized ? 'selected' : ''}>${option.label}</option>`).join('');
}

function libraryAccessOptions(selected) {
  return [
    ['all', '所有成员'],
    ['selected', '指定成员'],
    ['admins', '仅管理员'],
  ].map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
}

function libraryAgeOptions(selected) {
  return [
    [0, '不限'],
    [7, '7 岁以上'],
    [13, '13 岁以上'],
    [16, '16 岁以上'],
    [18, '18 岁以上'],
  ].map(([value, label]) => `<option value="${value}" ${Number(selected) === value ? 'selected' : ''}>${label}</option>`).join('');
}

// --------------------------------------------------------------------- utils

function firstChar(title) {
  const text = String(title || '').trim();
  return text ? Array.from(text)[0] : '?';
}

function avatarMarkup(user, extraClass = '') {
  const src = user?.avatar || '';
  const letter = firstChar(user?.displayName || user?.username || '?');
  return `<span class="avatar ${src ? 'has-image' : ''} ${extraClass}">${src
    ? `<img src="${esc(src)}" alt="">`
    : esc(letter)}</span>`;
}

function qualityLabel(item) {
  const height = Number(item?.height) || 0;
  if (height >= 2000) return '4K';
  if (height >= 1000) return '1080P';
  if (height >= 700) return '720P';
  if (height > 0) return `${height}P`;
  return 'HD';
}

function formatContainer(value) {
  return String(value || '').split(',')[0].toUpperCase() || '—';
}

function progressFor(id) {
  return state.progress[id] || null;
}

function progressPercent(id) {
  const record = progressFor(id);
  const item = state.moviesById.get(id) || state.episodesById.get(id);
  const total = Number(record?.duration) || Number(item?.duration) || 0;
  if (!record || record.completed) return record?.completed ? 100 : 0;
  return ratio(record.position, total);
}

function sortEpisodes(episodes) {
  return [...episodes].sort((a, b) => {
    const seasonDiff = (Number(a.season) || 1) - (Number(b.season) || 1);
    if (seasonDiff) return seasonDiff;
    return (Number(a.episode) || 0) - (Number(b.episode) || 0);
  });
}

function seriesResumeEpisode(series) {
  const candidates = series.episodes
    .filter((ep) => {
      const record = progressFor(ep.id);
      return record && !record.completed && record.position > 5;
    })
    .sort((a, b) => (progressFor(b.id)?.updatedAt || 0) - (progressFor(a.id)?.updatedAt || 0));
  return candidates[0] || null;
}

function seriesTargetEpisode(series) {
  const resume = seriesResumeEpisode(series);
  if (resume) return resume;
  return sortEpisodes(series.episodes)[0] || null;
}

function findItem(id) {
  return state.moviesById.get(id) || state.episodesById.get(id) || state.seriesById.get(id) || null;
}

function favoriteKey(kind, id) {
  return `${kind}:${id}`;
}

function isFavorited(kind, id) {
  return state.favorites.some((entry) => entry.kind === kind && entry.id === id);
}

function favoriteButton(kind, id) {
  const active = isFavorited(kind, id);
  return `<button class="card-fav ${active ? 'active' : ''}" type="button" data-favorite="${kind}:${id}" aria-label="${active ? '取消收藏' : '收藏'}" title="${active ? '取消收藏' : '收藏'}">${icon('heart')}</button>`;
}

function favoriteActionButton(kind, id) {
  const active = isFavorited(kind, id);
  return `<button class="btn btn-ghost fav-action ${active ? 'is-fav' : ''}" type="button" data-favorite="${kind}:${id}">${icon('heart')}${active ? '已收藏' : '收藏'}</button>`;
}

function favoriteItems() {
  return state.favorites
    .map((entry) => ({
      ...entry,
      item: entry.kind === 'series' ? state.seriesById.get(entry.id) : state.moviesById.get(entry.id),
    }))
    .filter((entry) => entry.item);
}

function continueEntries() {
  return Object.entries(state.progress)
    .filter(([, record]) => record && !record.completed && Number(record.position) > 3)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .map(([id, record]) => ({ item: findItem(id), record }))
    .filter((entry) => entry.item);
}

function describe(item) {
  if (item.overview) return item.overview;
  if (item.kind === 'series') {
    return `${item.seasonCount} 季 ${item.episodeCount} 集已收入片库，支持分季浏览、自动连播与字幕。`;
  }
  const bits = [];
  if (item.year) bits.push(`${item.year} 年`);
  if (item.duration) bits.push(`时长 ${formatDuration(item.duration)}`);
  bits.push(`${qualityLabel(item)} 画质`);
  return `来自本地片库的${bits.join('、')}影片，支持随时续播、字幕与多端观看。`;
}

function emptyView({ iconName = 'film', title, text, action = '' }) {
  return `<div class="empty">
    <div class="empty-icon">${icon(iconName)}</div>
    <h2>${esc(title)}</h2>
    <p>${esc(text)}</p>
    ${action}
  </div>`;
}

function errorView(message) {
  return `<div class="empty">
    <div class="empty-icon">${icon('info')}</div>
    <h2>出了点问题</h2>
    <p>${esc(message)}</p>
    <button class="btn btn-primary" data-action="reload">${icon('refresh')}重新加载</button>
  </div>`;
}

function factRow(label, value) {
  return `<div class="fact-row"><span>${esc(label)}</span><strong>${value}</strong></div>`;
}

function infoCard(title, rows) {
  return `<aside class="info-card">
    <h3>${icon('info')}${esc(title)}</h3>
    ${rows.join('')}
  </aside>`;
}

// ---------------------------------------------------------------------- cards

function posterCard(item) {
  const isSeries = item.kind === 'series';
  const href = isSeries ? `#/series/${item.id}` : `#/movie/${item.id}`;
  const pct = isSeries ? 0 : progressPercent(item.id);
  const sub = isSeries
    ? `${item.episodeCount || 0} 集${item.year ? ` · ${item.year}` : ''}`
    : `${item.year ? `${item.year} · ` : ''}${formatDuration(item.duration)}`;
  return `<div class="card" role="link" tabindex="0" data-open="${href}" style="--hue:${hueFor(item.title)}" aria-label="${esc(item.title)}">
    <div class="card-art">
      <span class="card-fallback">${esc(firstChar(item.title))}</span>
      <img src="${item.poster}" alt="" loading="lazy" decoding="async">
      <span class="card-badge">${isSeries ? '剧集' : '电影'}</span>
      ${item.ageRating != null ? `<span class="card-rating">${esc(item.ageLabel || `${item.ageRating}+`)}</span>` : ''}
      ${favoriteButton(isSeries ? 'series' : 'movie', item.id)}
      <button class="card-play" data-${isSeries ? 'play-series' : 'play'}="${item.id}" aria-label="播放 ${esc(item.title)}">${icon('play', 'fill')}</button>
      ${pct > 0 ? `<div class="card-progress"><span style="width:${Math.min(100, pct)}%"></span></div>` : ''}
    </div>
    <div class="card-title">${esc(item.title)}</div>
    <div class="card-sub">${esc(sub)}</div>
  </div>`;
}

function continueCard(item, record) {
  const pct = ratio(record.position, record.duration || item.duration);
  const remaining = Math.max(0, (record.duration || item.duration || 0) - record.position);
  const isEpisode = item.kind === 'episode';
  const title = isEpisode ? item.seriesTitle : item.title;
  const label = isEpisode ? episodeCode(item.season, item.episode) : '电影';
  const sub = isEpisode ? `${episodeCode(item.season, item.episode)} · ${item.title}` : (item.year ? `${item.year} 年` : '本地影片');
  return `<div class="continue-card" role="button" tabindex="0" data-play="${item.id}" style="--hue:${hueFor(title)}" aria-label="继续观看 ${esc(title)}">
    <div class="continue-art">
      <img src="${item.thumb || item.backdrop || item.poster}" alt="" loading="lazy" decoding="async">
      <span class="continue-badge">${esc(label)}</span>
      <span class="continue-play">${icon('play', 'fill')}</span>
      <span class="continue-time">剩余 ${formatDuration(remaining)}</span>
      <div class="card-progress"><span style="width:${Math.min(100, pct)}%"></span></div>
    </div>
    <div class="continue-info">
      <strong>${esc(title)}</strong>
      <span>${esc(sub)}</span>
    </div>
  </div>`;
}

function scroller(id, cards) {
  return `<div class="row-wrap">
    <button class="row-arrow left" data-scroll="${id}" data-dir="-1" aria-label="向左滚动">${icon('chevron-left')}</button>
    <div class="row-scroller" id="${id}">${cards}</div>
    <button class="row-arrow right" data-scroll="${id}" data-dir="1" aria-label="向右滚动">${icon('chevron-right')}</button>
  </div>`;
}

function section(title, sub, cards, link = '') {
  return `<section class="section">
    <div class="section-head">
      <h2>${esc(title)}</h2>
      <span class="section-sub">${esc(sub)}</span>
      ${link ? `<a class="section-link" href="${link}">查看全部 ${icon('chevron-right')}</a>` : ''}
    </div>
    ${scroller(`row-${title}`, cards)}
  </section>`;
}

// ----------------------------------------------------------------------- home

function renderHome() {
  if (!state.movies.length && !state.series.length) {
    return emptyView({
      iconName: 'folder',
      title: '片库还是空的',
      text: '把电影放进 media 文件夹，或者在设置里添加你的视频目录，Lumina 会自动整理海报、剧集和字幕。',
      action: `<a class="btn btn-primary" href="#/settings">${icon('settings')}添加媒体目录</a>`,
    });
  }

  const recent = state.recentIds.map(findItem).filter(Boolean);
  const featured = recent.find((item) => item.kind === 'movie') || recent[0] || state.movies[0] || state.series[0];
  const isSeries = featured.kind === 'series';
  const heroTarget = isSeries ? seriesTargetEpisode(featured) : featured;
  const continues = continueEntries().slice(0, 14);
  const rows = [];

  if (continues.length) {
    rows.push(section(
      '继续观看',
      `${continues.length} 个进行中`,
      continues.map(({ item, record }) => continueCard(item, record)).join(''),
      '#/continue',
    ));
  }
  if (recent.length) {
    rows.push(section('最近添加', '刚刚入库', recent.slice(0, 16).map(posterCard).join('')));
  }
  if (state.movies.length) {
    rows.push(section('电影', `${state.stats.movies || state.movies.length} 部`, state.movies.map(posterCard).join(''), '#/movies'));
  }
  if (state.series.length) {
    rows.push(section('剧集', `${state.stats.series || state.series.length} 部`, state.series.map(posterCard).join(''), '#/series'));
  }

  const meta = isSeries
    ? [featured.year ? `<span>${featured.year}</span>` : '', `<span>${featured.seasonCount} 季 · ${featured.episodeCount} 集</span>`]
    : [
      `<span class="quality-chip">${qualityLabel(featured)}</span>`,
      featured.year ? `<span>${featured.year}</span>` : '',
      `<span>${formatDuration(featured.duration)}</span>`,
      `<span>${esc(formatContainer(featured.container))}</span>`,
    ];

  return `<section class="hero">
    <img class="hero-bg" src="${featured.backdrop || featured.poster}" alt="" decoding="async">
    <div class="hero-content">
      <div class="hero-kicker">${icon('spark')}微光影库 · 今晚看点</div>
      <h1 class="hero-title">${esc(featured.title)}</h1>
      <div class="hero-meta">${meta.filter(Boolean).join('')}</div>
      <p class="hero-desc">${esc(describe(featured))}</p>
      <div class="hero-actions">
        <button class="btn btn-primary" data-${isSeries ? 'play-series' : 'play'}="${isSeries ? featured.id : featured.id}">
          ${icon('play', 'fill')}${featured.kind === 'series' && seriesResumeEpisode(featured) ? '继续观看' : '立即播放'}
        </button>
        <a class="btn btn-ghost" href="${isSeries ? `#/series/${featured.id}` : `#/movie/${featured.id}`}">${icon('info')}查看详情</a>
        ${heroTarget && isSeries ? `<span class="hero-hint">从 ${episodeCode(heroTarget.season, heroTarget.episode)} 开始</span>` : ''}
      </div>
    </div>
  </section>
  ${rows.join('')}`;
}

// --------------------------------------------------------------------- movies

function renderMovies() {
  const head = `<div class="page-head"><h1>电影</h1><p>${state.movies.length} 部影片</p></div>`;
  if (!state.movies.length) {
    return `${head}${emptyView({ title: '还没有电影', text: '把电影文件放进媒体目录，然后重新扫描媒体库。' })}`;
  }
  return `${head}<div class="grid">${state.movies.map(posterCard).join('')}</div>`;
}

function renderSeriesList() {
  const head = `<div class="page-head"><h1>剧集</h1><p>${state.series.length} 部剧集 · ${state.stats.episodes || 0} 集</p></div>`;
  if (!state.series.length) {
    return `${head}${emptyView({ title: '还没有剧集', text: '把剧集放进媒体目录，Lumina 会按文件夹和文件名自动识别季与集。' })}`;
  }
  return `${head}<div class="grid">${state.series.map(posterCard).join('')}</div>`;
}

function renderContinue() {
  const entries = continueEntries();
  const head = `<div class="page-head"><h1>继续观看</h1><p>${entries.length} 个进行中</p></div>`;
  if (!entries.length) {
    return `${head}${emptyView({
      iconName: 'clock',
      title: '没有未看完的内容',
      text: '播放过的影片会出现在这里，下次打开可以直接从上次的位置继续。',
      action: `<a class="btn btn-primary" href="#/home">${icon('home')}去首页看看</a>`,
    })}`;
  }
  return `${head}<div class="continue-grid">${entries.map(({ item, record }) => continueCard(item, record)).join('')}</div>`;
}

function renderFavorites() {
  const entries = favoriteItems();
  const head = `<div class="page-head"><h1>收藏</h1><p>${entries.length} 部已收藏</p></div>`;
  if (!entries.length) {
    return `${head}${emptyView({
      iconName: 'heart',
      title: '还没有收藏',
      text: '在电影或剧集卡片上点一下心形按钮，喜欢的内容就会出现在这里。',
      action: `<a class="btn btn-primary" href="#/movies">${icon('film')}去挑几部</a>`,
    })}`;
  }
  return `${head}<div class="grid">${entries.map((entry) => posterCard(entry.item)).join('')}</div>`;
}

// --------------------------------------------------------------------- search

function renderSearch(query) {
  const q = String(query || '').trim();
  const head = `<div class="page-head"><h1>搜索</h1><p>${q ? `“${esc(q)}”` : '输入关键词查找电影或剧集'}</p></div>`;
  if (!q) {
    return `${head}${emptyView({ iconName: 'search', title: '搜索你的片库', text: '在顶部搜索框输入电影名、剧集名、年份或文件名。' })}`;
  }
  const needle = q.toLowerCase();
  const matches = (...values) => values.some((value) => String(value || '').toLowerCase().includes(needle));
  const movies = state.movies.filter((item) => matches(item.title, item.year, item.fileName));
  const series = state.series.filter((item) => matches(item.title, item.year) || item.episodes.some((ep) => matches(ep.title, ep.fileName, ep.seriesTitle)));
  const episodes = [...state.episodesById.values()].filter((ep) => matches(ep.title, ep.fileName, ep.seriesTitle)).slice(0, 20);

  if (!movies.length && !series.length) {
    return `${head}${emptyView({
      iconName: 'search',
      title: '没有找到相关内容',
      text: `没有与“${q}”匹配的电影或剧集，换个关键词试试。`,
    })}`;
  }

  const parts = [head];
  if (movies.length) {
    parts.push(`<div class="search-results-head"><h2>电影</h2><span>${movies.length} 个结果</span></div><div class="grid">${movies.map(posterCard).join('')}</div>`);
  }
  if (series.length) {
    parts.push(`<div class="search-results-head"><h2>剧集</h2><span>${series.length} 个结果</span></div><div class="grid">${series.map(posterCard).join('')}</div>`);
  }
  if (episodes.length) {
    parts.push(`<div class="search-results-head"><h2>匹配的剧集</h2><span>${episodes.length} 集</span></div><div class="episode-list">${episodes.map(episodeRow).join('')}</div>`);
  }
  return parts.join('');
}

// --------------------------------------------------------------------- detail

function renderMovieDetail(id) {
  const item = state.moviesById.get(id);
  if (!item) return errorView('找不到这部影片，可能已经被移出媒体库。');
  const record = progressFor(id);
  const resume = record && !record.completed && record.position > 5;
  const pct = progressPercent(id);
  const facts = [
    factRow('文件名', esc(item.fileName)),
    factRow('大小', formatBytes(item.size)),
    factRow('时长', formatDuration(item.duration)),
    factRow('分辨率', item.width && item.height ? `${item.width} × ${item.height}` : '—'),
    factRow('视频编码', esc([item.videoCodec, qualityLabel(item)].filter(Boolean).join(' · '))),
    factRow('音频编码', esc(item.audioCodec || '—')),
    factRow('封装格式', esc(formatContainer(item.container))),
    factRow('字幕', item.subtitleCount ? `${item.subtitleCount} 条` : '无'),
    factRow('加入时间', item.addedAt ? new Date(item.addedAt).toLocaleDateString('zh-CN') : '—'),
  ];

  return `<section class="detail-hero">
    <img class="detail-bg" src="${item.backdrop || item.poster}" alt="" decoding="async">
    <div class="detail-inner">
      <img class="detail-poster" src="${item.poster}" alt="${esc(item.title)} 海报" decoding="async">
      <div class="detail-main">
        <div class="detail-kicker">${icon('film')}电影</div>
        <h1 class="detail-title">${esc(item.title)}</h1>
        <div class="detail-meta">
          <span class="quality-chip">${qualityLabel(item)}</span>
          ${ratingChip(item)}
          ${item.year ? `<span>${item.year}</span>` : ''}
          <span>${formatDuration(item.duration)}</span>
          <span>${formatBytes(item.size)}</span>
          <span>${esc(formatContainer(item.container))}</span>
        </div>
        <p class="detail-desc">${esc(describe(item))}</p>
        <div class="detail-tags">
          ${item.videoCodec ? `<span class="tag">${esc(item.videoCodec.toUpperCase())}</span>` : ''}
          ${item.audioCodec ? `<span class="tag">${esc(item.audioCodec.toUpperCase())}</span>` : ''}
          ${item.subtitleCount ? `<span class="tag">${item.subtitleCount} 条字幕</span>` : ''}
          ${pct > 0 && !record?.completed ? `<span class="tag">已看 ${Math.round(pct)}%</span>` : ''}
        </div>
        ${isAdmin() ? `<div class="rating-editor"><span>${icon('shield')}年龄分级</span><select class="field select-sm" data-rating-kind="items" data-rating-id="${item.id}">${ageOptions(item.ageRating)}</select></div>` : ''}
        <div class="detail-actions">
          <button class="btn btn-primary" data-play="${item.id}">${icon('play', 'fill')}${resume ? '继续观看' : '立即播放'}</button>
          ${resume ? `<button class="btn btn-ghost" data-action="restart" data-id="${item.id}">${icon('replay')}从头播放</button>` : ''}
          ${favoriteActionButton('movie', item.id)}
          ${isAdmin() ? `<button class="btn btn-ghost" data-action="open-metadata" data-kind="movie" data-id="${item.id}">${icon('spark')}匹配元数据</button>
          <button class="btn btn-ghost" data-action="open-subtitles" data-id="${item.id}">${icon('subtitles')}在线字幕</button>` : ''}
          <a class="btn btn-ghost" href="#/movies">${icon('arrow-left')}返回电影</a>
        </div>
      </div>
    </div>
  </section>
  <div class="detail-body">
    <div class="info-card">
      <h3>${icon('info')}关于这部影片</h3>
      <p class="detail-desc" style="margin-top:0">${esc(describe(item))}</p>
      ${resume ? `<p class="detail-desc">上次看到 ${formatDuration(record.position)}${record.duration ? ` / ${formatDuration(record.duration)}` : ''}，已为你保留进度。</p>` : ''}
    </div>
    ${infoCard('媒体信息', facts)}
  </div>`;
}

function episodeRow(ep) {
  const record = progressFor(ep.id);
  const pct = progressPercent(ep.id);
  const watched = record?.completed
    ? '<span class="watched">已看完</span>'
    : pct > 0
      ? `<span class="watched">已看 ${Math.round(pct)}%</span>`
      : '';
  return `<div class="episode" role="button" tabindex="0" data-play="${ep.id}" aria-label="播放 ${esc(ep.title)}">
    <div class="ep-thumb" style="--hue:${hueFor(ep.title)}">
      <img src="${ep.thumb}" alt="" loading="lazy" decoding="async">
      <span class="ep-num">${episodeCode(ep.season, ep.episode)}</span>
      ${pct > 0 ? `<div class="card-progress"><span style="width:${Math.min(100, pct)}%"></span></div>` : ''}
    </div>
    <div class="ep-info">
      <h3>${esc(ep.title)}</h3>
      <p>${formatDuration(ep.duration)} · ${formatBytes(ep.size)}${watched ? ` · ${watched}` : ''}</p>
    </div>
    ${isAdmin() ? `<button class="ep-online" data-action="open-subtitles" data-id="${ep.id}" title="在线字幕" aria-label="在线字幕">${icon('subtitles')}</button>` : ''}
    <span class="ep-play">${icon('play', 'fill')}</span>
  </div>`;
}

function renderSeriesDetail(id) {
  const series = state.seriesById.get(id);
  if (!series) return errorView('找不到这部剧集，可能已经被移出媒体库。');
  const episodes = sortEpisodes(series.episodes);
  const seasons = [...new Set(episodes.map((ep) => Number(ep.season) || 1))].sort((a, b) => a - b);
  const resume = seriesResumeEpisode(series);
  let season = seasonChoice.get(series.id);
  if (season == null) season = resume?.season || seasons[0] || 1;
  if (!seasons.includes(Number(season))) season = seasons[0] || 1;
  seasonChoice.set(series.id, Number(season));
  const seasonEpisodes = episodes.filter((ep) => (Number(ep.season) || 1) === Number(season));
  const target = seriesTargetEpisode(series);
  const totalDuration = episodes.reduce((sum, ep) => sum + (Number(ep.duration) || 0), 0);

  const facts = [
    factRow('年份', series.year ? String(series.year) : '—'),
    factRow('季数', `${series.seasonCount} 季`),
    factRow('集数', `${series.episodeCount} 集`),
    factRow('总时长', formatDuration(totalDuration)),
    factRow('加入时间', series.addedAt ? new Date(series.addedAt).toLocaleDateString('zh-CN') : '—'),
  ];

  const seasonTabs = seasons.length > 1
    ? `<div class="season-tabs">${seasons.map((item) => `<button class="season-tab ${Number(season) === item ? 'active' : ''}" data-season="${item}" data-series="${series.id}">第 ${item} 季</button>`).join('')}</div>`
    : '';

  return `<section class="detail-hero">
    <img class="detail-bg" src="${series.backdrop || series.poster}" alt="" decoding="async">
    <div class="detail-inner">
      <img class="detail-poster" src="${series.poster}" alt="${esc(series.title)} 海报" decoding="async">
      <div class="detail-main">
        <div class="detail-kicker">${icon('tv')}剧集</div>
        <h1 class="detail-title">${esc(series.title)}</h1>
        <div class="detail-meta">
          ${ratingChip(series)}
          ${series.year ? `<span>${series.year}</span>` : ''}
          <span>${series.seasonCount} 季</span>
          <span>${series.episodeCount} 集</span>
          <span>共 ${formatDuration(totalDuration)}</span>
        </div>
        <p class="detail-desc">${esc(describe(series))}</p>
        ${isAdmin() ? `<div class="rating-editor"><span>${icon('shield')}年龄分级</span><select class="field select-sm" data-rating-kind="series" data-rating-id="${series.id}">${ageOptions(series.ageRating)}</select></div>` : ''}
        <div class="detail-actions">
          ${target ? `<button class="btn btn-primary" data-play="${target.id}">${icon('play', 'fill')}${resume ? `继续观看 ${episodeCode(target.season, target.episode)}` : '播放第一集'}</button>` : ''}
          ${resume && episodes[0] ? `<button class="btn btn-ghost" data-play="${episodes[0].id}">${icon('replay')}从第一集开始</button>` : ''}
          ${favoriteActionButton('series', series.id)}
          ${isAdmin() ? `<button class="btn btn-ghost" data-action="open-metadata" data-kind="series" data-id="${series.id}">${icon('spark')}匹配元数据</button>` : ''}
          <a class="btn btn-ghost" href="#/series">${icon('arrow-left')}返回剧集</a>
        </div>
      </div>
    </div>
  </section>
  <div class="detail-body">
    <div>
      <div class="episodes-head">
        <h2>剧集</h2>
        <span class="section-sub">${seasons.length} 季 · ${episodes.length} 集</span>
      </div>
      ${seasonTabs}
      <div class="episode-list">${seasonEpisodes.map(episodeRow).join('')}</div>
    </div>
    ${infoCard('剧集信息', facts)}
  </div>`;
}

// ------------------------------------------------------------------- settings

function formatUptime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

function userRow(user) {
  const isSelf = user.id === state.user?.id;
  const role = user.role === 'admin' ? '管理员' : '成员';
  const age = Number.isFinite(user.age) ? user.age : null;
  return `<div class="user-row" data-user-row="${user.id}">
    <div class="user-row-head">
      ${avatarMarkup(user)}
      <div class="user-identity">
        <strong>${esc(user.displayName || user.username)}${isSelf ? ' <span class="self-tag">你</span>' : ''}</strong>
        <span title="用户名创建后不可修改">@${esc(user.username)} · <span class="role-badge ${user.role}">${role}</span></span>
      </div>
      <div class="user-row-actions">
        <button class="icon-btn" data-action="reset-user-password" data-id="${user.id}" title="重置密码" aria-label="重置密码">${icon('key')}</button>
        <button class="icon-btn danger" data-action="delete-user" data-id="${user.id}" title="删除用户" aria-label="删除用户" ${isSelf ? 'disabled' : ''}>${icon('trash')}</button>
      </div>
    </div>
    <div class="user-fields">
      <label>角色
        <select class="field select-sm" data-user-field="role" data-id="${user.id}">
          <option value="member" ${user.role === 'member' ? 'selected' : ''}>成员</option>
          <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>管理员</option>
        </select>
      </label>
      <label>当前年龄
        <span class="user-age">${age == null ? '未填写' : `${age} 岁`}</span>
      </label>
      <label>出生日期
        <input class="field" type="date" value="${esc(user.birthDate || '')}" data-user-field="birthDate" data-id="${user.id}">
      </label>
      <label class="check-field"><input type="checkbox" data-user-field="allowUnrated" data-id="${user.id}" ${user.allowUnrated ? 'checked' : ''}>允许未分级内容</label>
      <button class="btn btn-ghost btn-sm" data-action="save-user" data-id="${user.id}">${icon('check')}保存</button>
    </div>
    ${user.pendingBirthDate ? `<div class="birthdate-request">
      <span>${icon('clock')}申请将出生日期改为 <strong>${esc(user.pendingBirthDate)}</strong></span>
      <button class="btn btn-primary btn-sm" data-action="approve-birthdate" data-id="${user.id}">${icon('check')}同意</button>
      <button class="btn btn-ghost btn-sm" data-action="reject-birthdate" data-id="${user.id}">拒绝</button>
    </div>` : ''}
    <div class="user-meta">
      <span>实际可看：${user.effectiveAge >= 99 ? '全部内容' : `${user.effectiveAge} 岁以下`}</span>
      <span>最近登录：${user.lastLoginAt ? relativeTime(user.lastLoginAt) : '从未'}</span>
      <span>创建于：${user.createdAt ? new Date(user.createdAt).toLocaleDateString('zh-CN') : '—'}</span>
    </div>
  </div>`;
}

function userManagementPanel() {
  const users = state.users || [];
  const open = state.allowRegistration;
  return `<div class="panel" id="user-panel">
    <h2>${icon('users')}用户与权限</h2>
    <p class="hint">管理员可以管理片库与用户；成员的片库会按出生日期计算的年龄自动过滤，不能访问设置和扫描。</p>
    <div class="settings-actions">
      <button class="btn ${open ? 'btn-ghost' : 'btn-primary'} btn-sm" data-action="toggle-registration">
        ${icon(open ? 'lock' : 'users')}${open ? '关闭自助注册' : '开放自助注册'}
      </button>
      <span class="badge ${open ? 'good' : 'warn'}">${open ? '当前允许注册' : '当前仅管理员创建'}</span>
    </div>
    <div class="user-list">${users.map(userRow).join('')}</div>
    <div class="user-add">
      <h3>${icon('user')}添加用户</h3>
      <div class="field-row">
        <input class="field" id="new-user-username" placeholder="用户名" autocomplete="off">
        <input class="field" id="new-user-name" placeholder="显示名称" autocomplete="off">
      </div>
      <div class="field-row">
        <input class="field" id="new-user-password" type="password" placeholder="初始密码（至少 6 位）" autocomplete="new-password">
        <select class="field" id="new-user-role">
          <option value="member">成员</option>
          <option value="admin">管理员</option>
        </select>
      </div>
      <div class="field-row">
        <input class="field" id="new-user-birthdate" type="date" aria-label="出生日期">
        <label class="check-field"><input type="checkbox" id="new-user-unrated" checked>允许未分级</label>
        <button class="btn btn-primary btn-sm" data-action="create-user">${icon('plus')}添加</button>
      </div>
    </div>
  </div>`;
}

function metadataSettingsPanel() {
  const md = state.settings?.metadata || {};
  const hasKey = Boolean(md.hasTmdbKey);
  return `<div class="panel">
    <h2>${icon('search')}网络元数据</h2>
    <p class="hint">按片名联网搜索标题、简介和封面。自动模式优先 TMDB，其次 TVMaze（剧集）、豆瓣；封面来自在线海报，字幕来自 MySubs。</p>
    <div class="field-row">
      <label class="field-label">元数据来源
        <select class="field" id="metadata-provider">
          <option value="auto" ${md.provider === 'auto' ? 'selected' : ''}>自动（推荐）</option>
          <option value="tmdb" ${md.provider === 'tmdb' ? 'selected' : ''}>TMDB（需 Key）</option>
          <option value="tvmaze" ${md.provider === 'tvmaze' ? 'selected' : ''}>TVMaze（剧集）</option>
          <option value="douban" ${md.provider === 'douban' ? 'selected' : ''}>豆瓣</option>
          <option value="wikipedia" ${md.provider === 'wikipedia' ? 'selected' : ''}>维基百科</option>
        </select>
      </label>
      <label class="field-label">字幕语言
        <select class="field" id="metadata-subtitle-language">
          <option value="zh" ${md.subtitleLanguage === 'zh' ? 'selected' : ''}>中文</option>
          <option value="en" ${md.subtitleLanguage === 'en' ? 'selected' : ''}>English</option>
        </select>
      </label>
    </div>
    <label class="field-label">TMDB API Key
      <input class="field" id="metadata-tmdb-key" type="password" autocomplete="off"
        placeholder="${hasKey ? '已配置，留空保持不变' : '可选，填入后可使用中文海报'}">
    </label>
    <div class="settings-actions">
      <button class="btn btn-primary btn-sm" data-action="save-metadata-settings">${icon('check')}保存</button>
      ${hasKey ? `<button class="btn btn-ghost btn-sm" data-action="clear-tmdb-key">${icon('trash')}清除 Key</button>` : ''}
      <span class="badge ${hasKey ? 'good' : 'warn'}">${hasKey ? 'TMDB 已配置' : '未配置 TMDB'}</span>
    </div>
  </div>`;
}

function renderSettings() {
  const settings = state.settings;
  if (!settings) return errorView('无法加载设置，请确认服务正在运行。');
  if (!settingsDirty) workingLibraries = cloneLibraries(state.libraries);

  const port = settings.port || 8096;
  const lanRows = (settings.lan || []).map((entry) => `<div class="status-row">
    <span>${esc(entry.name)}</span>
    <strong><a href="http://${entry.address}:${port}" target="_blank" rel="noreferrer">${entry.address}:${port}</a></strong>
  </div>`).join('');

  const memberUsers = state.users.filter((entry) => entry.role !== 'admin');
  const libraryCards = workingLibraries.length
    ? workingLibraries.map((library, index) => {
      const selectedUsers = new Set(library.userIds || []);
      const choices = memberUsers.length
        ? memberUsers.map((entry) => `<label class="library-user">
            <input type="checkbox" data-lib-user="${esc(entry.id)}" ${library.access === 'selected' && selectedUsers.has(entry.id) ? 'checked' : ''}>
            <span>${esc(entry.displayName || entry.username)}</span>
            <small>@${esc(entry.username)}</small>
          </label>`).join('')
        : '<p class="hint">还没有成员账号。</p>';
      return `<div class="library-card ${library.enabled === false ? 'is-disabled' : ''}" data-library-index="${index}">
        <div class="library-head">
          <span class="library-icon">${icon('folder')}</span>
          <input class="field library-name" data-lib-field="name" value="${esc(library.name || '')}" maxlength="40" aria-label="媒体库名称">
          <label class="library-toggle"><input type="checkbox" data-lib-field="enabled" ${library.enabled !== false ? 'checked' : ''}> 启用</label>
          <button class="icon-btn" type="button" data-action="remove-library" data-index="${index}" title="移除媒体库" aria-label="移除媒体库">${icon('trash')}</button>
        </div>
        <div class="library-path-row">
          <input class="field" data-lib-field="path" value="${esc(library.path || '')}" placeholder="例如 D:\\Movies 或 ./media" spellcheck="false" aria-label="媒体库路径">
          <span class="library-count">${library.movieCount || 0} 部电影 · ${library.seriesCount || 0} 部剧集</span>
        </div>
        <div class="library-options">
          <label class="library-option"><span>访问权限</span>
            <select class="field select-sm" data-lib-field="access">${libraryAccessOptions(library.access || 'all')}</select>
          </label>
          <label class="library-option"><span>最低年龄</span>
            <select class="field select-sm" data-lib-field="minAge">${libraryAgeOptions(library.minAge || 0)}</select>
          </label>
        </div>
        ${library.access === 'selected' ? `<div class="library-members">${choices}</div>` : ''}
        <p class="library-note">管理员始终可访问；成员还需通过影片自身的年龄分级。</p>
      </div>`;
    }).join('')
    : '<p class="hint">还没有媒体库，添加一个包含视频的文件夹。</p>';

  const ffmpegBadge = settings.ffmpeg?.available
    ? '<span class="badge good">可用</span>'
    : '<span class="badge warn">未找到</span>';
  const t = settings.transcode || {};
  const stats = state.stats;

  return `<div class="page-head">
    <h1>设置</h1>
    <p>媒体库、用户、服务器与转码</p>
    <div class="page-actions"><button class="btn btn-primary btn-sm" data-action="scan">${icon('refresh')}重新扫描</button></div>
  </div>
  <div class="settings-grid">
    <div>
      <div class="panel">
        <h2>${icon('folder')}媒体库</h2>
        <p class="hint">每个媒体库可以单独设置访问成员和最低年龄。保存后会自动重新扫描；修改不会移动或删除磁盘上的视频文件。</p>
        <div class="library-list">${libraryCards}</div>
        <div class="settings-actions">
          <button class="btn btn-ghost btn-sm" data-action="add-library">${icon('plus')}添加媒体库</button>
          <button class="btn btn-primary" data-action="save-libraries">${icon('check')}保存并扫描</button>
          <button class="btn btn-ghost" data-action="reset-libraries" ${settingsDirty ? '' : 'disabled'}>${icon('refresh')}还原</button>
          ${settingsDirty ? '<span class="badge warn">有未保存的修改</span>' : ''}
        </div>
      </div>
      ${metadataSettingsPanel()}
      <div class="panel">
        <h2>${icon('grid')}片库概览</h2>
        <div class="status-list">
          <div class="status-row"><span>电影</span><strong>${stats.movies || 0} 部</strong></div>
          <div class="status-row"><span>剧集</span><strong>${stats.series || 0} 部 / ${stats.episodes || 0} 集</strong></div>
          <div class="status-row"><span>占用空间</span><strong>${formatBytes(stats.totalSize)}</strong></div>
          <div class="status-row"><span>总时长</span><strong>${formatDuration(stats.totalDuration)}</strong></div>
          <div class="status-row"><span>上次扫描</span><strong>${relativeTime(state.scannedAt)}</strong></div>
          <div class="status-row"><span>媒体库</span><strong>${workingLibraries.length} 个</strong></div>
        </div>
      </div>
      ${userManagementPanel()}
      <div class="panel">
        <h2>${icon('info')}维护</h2>
        <p class="hint">清空所有影片的观看进度，不会影响视频文件。</p>
        <div class="settings-actions">
          <button class="btn btn-danger btn-sm" data-action="clear-progress">${icon('trash')}清空观看进度</button>
        </div>
      </div>
    </div>
    <div>
      <div class="panel">
        <h2>${icon('logo')}服务器</h2>
        <div class="status-list">
          <div class="status-row"><span>名称</span><strong>${esc(settings.serverName)}</strong></div>
          <div class="status-row"><span>版本</span><strong>${esc(settings.version)}</strong></div>
          <div class="status-row"><span>监听端口</span><strong>${port}</strong></div>
          <div class="status-row"><span>运行时长</span><strong>${formatUptime(state.health?.uptime)}</strong></div>
          <div class="status-row"><span>本机地址</span><strong><a href="http://localhost:${port}" target="_blank" rel="noreferrer">localhost:${port}</a></strong></div>
          ${lanRows}
          <div class="status-row"><span>程序目录</span><strong>${esc(settings.root)}</strong></div>
        </div>
      </div>
      <div class="panel">
        <h2>${icon('quality')}转码</h2>
        <div class="status-list">
          <div class="status-row"><span>FFmpeg</span><strong>${ffmpegBadge}</strong></div>
          <div class="status-row"><span>最高分辨率</span><strong>${t.maxHeight || 1080}p</strong></div>
          <div class="status-row"><span>分段长度</span><strong>${t.segmentSeconds || 6} 秒</strong></div>
          <div class="status-row"><span>编码质量</span><strong>CRF ${t.crf ?? 23} · ${esc(t.preset || 'veryfast')}</strong></div>
          <div class="status-row"><span>转码模式</span><strong>按需分段转码</strong></div>
        </div>
        <p class="hint">MKV / HEVC 等浏览器不支持的格式会在播放时自动分段转码为 HLS；MP4 + H.264 会直接串流，几乎不占 CPU。</p>
      </div>
    </div>
  </div>`;
}

// --------------------------------------------------------------------- profile

function profileAvatarSource() {
  if (profileAvatarRemoved) return '';
  return profileAvatarDraft || state.user?.avatar || '';
}

function renderProfileAvatar() {
  const src = profileAvatarSource();
  const box = document.getElementById('profile-avatar-box');
  if (!box) return;
  box.innerHTML = `
    <span class="avatar profile-avatar ${src ? 'has-image' : ''}">${src
      ? `<img src="${esc(src)}" alt="">`
      : esc(firstChar(state.user?.displayName || state.user?.username || '?'))}</span>
    <div class="profile-avatar-actions">
      <button class="btn btn-ghost btn-sm" type="button" data-action="pick-avatar">${icon('camera')}更换头像</button>
      ${src ? `<button class="btn btn-ghost btn-sm" type="button" data-action="remove-avatar">${icon('trash')}移除</button>` : ''}
    </div>`;
}

function renderProfile() {
  const user = state.user;
  if (!user) return errorView('请先登录。');
  const age = Number.isFinite(user.age) ? `${user.age} 岁` : '未填写';
  const access = user.role === 'admin' ? '全部内容' : `${user.effectiveAge} 岁以下`;
  const pending = user.pendingBirthDate
    ? `<div class="profile-pending">${icon('clock')}
        <span>出生日期修改申请：<strong>${esc(user.pendingBirthDate)}</strong>，等待管理员确认。</span>
        <button class="btn btn-ghost btn-sm" data-action="cancel-birthdate-request">撤销申请</button>
      </div>`
    : '';
  const src = profileAvatarSource();
  return `<div class="profile-page">
    <header class="page-head">
      <h1>个人资料</h1>
      <p class="page-sub">管理你的显示名称、头像和出生日期。</p>
    </header>
    <div class="profile-grid">
      <section class="panel profile-card">
        <h2>${icon('user')}账号资料</h2>
        <div class="profile-avatar-box" id="profile-avatar-box">
          <span class="avatar profile-avatar ${src ? 'has-image' : ''}">${src
            ? `<img src="${esc(src)}" alt="">`
            : esc(firstChar(user.displayName || user.username))}</span>
          <div class="profile-avatar-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-action="pick-avatar">${icon('camera')}更换头像</button>
            ${src ? `<button class="btn btn-ghost btn-sm" type="button" data-action="remove-avatar">${icon('trash')}移除</button>` : ''}
          </div>
        </div>
        <input id="profile-avatar-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
        <div class="profile-fields">
          <label class="field-label">显示名称
            <input class="field" id="profile-display-name" value="${esc(user.displayName || '')}" maxlength="32" autocomplete="nickname">
          </label>
          <label class="field-label">用户名（不可修改）
            <input class="field" value="${esc(user.username)}" title="用户名创建后不可修改" disabled>
          </label>
          <label class="field-label">出生日期
            <input class="field" id="profile-birthdate" type="date" min="1900-01-01" max="${new Date().toISOString().slice(0, 10)}" value="${esc(user.birthDate || '')}" autocomplete="bday">
          </label>
          <label class="field-label">当前年龄
            <span class="user-age">${age} · 可观看 ${access}</span>
          </label>
        </div>
        ${pending}
        <p class="hint">${user.role === 'admin'
          ? '管理员修改出生日期会立即生效。头像支持 JPG、PNG、WebP、GIF，会上传并压缩。'
          : '显示名称和头像会立即更新；出生日期影响年龄限制，成员修改后需要管理员确认。'}</p>
        <div class="profile-actions">
          <button class="btn btn-primary" data-action="save-profile" ${profileSaving ? 'disabled' : ''}>${icon('check')}${profileSaving ? '保存中…' : '保存资料'}</button>
          ${user.role === 'admin' ? '<a class="btn btn-ghost" href="#/settings">前往设置</a>' : ''}
        </div>
      </section>
      <section class="panel profile-card">
        <h2>${icon('key')}账号安全</h2>
        <p class="hint">修改密码后，所有设备上的登录状态会失效，需要重新登录。</p>
        <button class="btn btn-ghost" data-action="change-password">${icon('key')}修改密码</button>
        <div class="profile-meta">
          <span>账号创建：${user.createdAt ? new Date(user.createdAt).toLocaleDateString('zh-CN') : '—'}</span>
          <span>上次登录：${user.lastLoginAt ? relativeTime(user.lastLoginAt) : '—'}</span>
        </div>
      </section>
    </div>
  </div>`;
}

function readAvatarFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('请选择图片文件'));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      reject(new Error('图片不能超过 10MB'));
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const max = 512;
      const scale = Math.min(1, max / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#11161c';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.86));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    image.src = url;
  });
}

async function pickAvatar() {
  document.getElementById('profile-avatar-input')?.click();
}

async function saveProfile() {
  if (profileSaving) return;
  const displayName = document.getElementById('profile-display-name')?.value.trim() || '';
  const birthDate = document.getElementById('profile-birthdate')?.value || '';
  if (!displayName) {
    showToast('显示名称不能为空', 'error');
    return;
  }
  profileSaving = true;
  const button = document.querySelector('[data-action="save-profile"]');
  if (button) button.disabled = true;
  try {
    const body = { displayName, birthDate };
    if (profileAvatarDraft) body.avatar = profileAvatarDraft;
    if (profileAvatarRemoved) body.removeAvatar = true;
    const result = await api('/api/auth/profile', { method: 'POST', body: JSON.stringify(body) });
    state.user = result.user;
    profileDirty = false;
    profileAvatarDraft = null;
    profileAvatarRemoved = false;
    if (isAdmin()) {
      const index = state.users.findIndex((entry) => entry.id === result.user.id);
      if (index >= 0) state.users[index] = result.user;
    }
    updateChrome();
    renderRoute({ scroll: false });
    showToast(result.message || '个人资料已保存');
  } catch (err) {
    showToast(err.message || '保存失败', 'error');
  } finally {
    profileSaving = false;
    const current = document.querySelector('[data-action="save-profile"]');
    if (current) {
      current.disabled = false;
      current.innerHTML = `${icon('check')}保存资料`;
    }
  }
}

async function cancelBirthdateRequest() {
  try {
    const result = await api('/api/auth/profile', {
      method: 'POST',
      body: JSON.stringify({ cancelBirthDate: true }),
    });
    state.user = result.user;
    profileDirty = false;
    showToast('已撤销出生日期修改申请');
    renderRoute({ scroll: false });
  } catch (err) {
    showToast(err.message || '操作失败', 'error');
  }
}

// --------------------------------------------------------------------- router

function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/home';
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const query = new URLSearchParams(queryPart || '');
  if (!parts.length) return { name: 'home' };
  switch (parts[0]) {
    case 'movies':
      return { name: 'movies' };
    case 'series':
      return parts[1] ? { name: 'seriesDetail', id: parts[1] } : { name: 'seriesList' };
    case 'movie':
      return parts[1] ? { name: 'movieDetail', id: parts[1] } : { name: 'movies' };
    case 'continue':
      return { name: 'continue' };
    case 'favorites':
      return { name: 'favorites' };
    case 'search':
      return { name: 'search', query: query.get('q') || '' };
    case 'settings':
      return { name: 'settings' };
    case 'profile':
      return { name: 'profile' };
    case 'home':
    default:
      return { name: 'home' };
  }
}

function routeKey(route) {
  return `${route.name}:${route.id || ''}:${route.query || ''}`;
}

function updateNav(route) {
  let active = route.name;
  if (active === 'movieDetail') active = 'movies';
  if (active === 'seriesDetail') active = 'series';
  if (active === 'search') active = '';
  document.querySelectorAll('[data-nav]').forEach((link) => {
    link.classList.toggle('active', link.dataset.nav === active);
  });
}

function updateSearchInput(route) {
  if (document.activeElement === searchInput) return;
  searchInput.value = route.name === 'search' ? route.query : '';
}

function updateTitle(route) {
  let title = 'Lumina 微光影库';
  if (route.name === 'movieDetail') {
    const item = state.moviesById.get(route.id);
    if (item) title = `${item.title} · Lumina`;
  } else if (route.name === 'seriesDetail') {
    const item = state.seriesById.get(route.id);
    if (item) title = `${item.title} · Lumina`;
  } else if (route.name === 'search' && route.query) {
    title = `搜索 ${route.query} · Lumina`;
  } else if (route.name === 'movies') {
    title = '电影 · Lumina';
  } else if (route.name === 'seriesList') {
    title = '剧集 · Lumina';
  } else if (route.name === 'continue') {
    title = '继续观看 · Lumina';
  } else if (route.name === 'favorites') {
    title = '收藏 · Lumina';
  } else if (route.name === 'settings') {
    title = '设置 · Lumina';
  } else if (route.name === 'profile') {
    title = '个人资料 · Lumina';
  }
  document.title = title;
}

async function renderRoute({ scroll = true } = {}) {
  const token = ++renderSeq;
  const route = parseRoute();
  if (route.name !== 'profile') {
    profileDirty = false;
    profileAvatarDraft = null;
    profileAvatarRemoved = false;
  } else if (profileDirty) {
    return;
  }
  const changed = routeKey(route) !== routeKey(currentRoute);
  currentRoute = route;
  updateNav(route);
  updateSearchInput(route);
  updateTitle(route);
  if (scroll && changed) window.scrollTo(0, 0);

  let html = '';
  try {
    switch (route.name) {
      case 'home':
        html = renderHome();
        break;
      case 'movies':
        html = renderMovies();
        break;
      case 'seriesList':
        html = renderSeriesList();
        break;
      case 'continue':
        html = renderContinue();
        break;
      case 'favorites':
        html = renderFavorites();
        break;
      case 'search':
        html = renderSearch(route.query);
        break;
      case 'movieDetail':
        html = renderMovieDetail(route.id);
        break;
      case 'seriesDetail':
        html = renderSeriesDetail(route.id);
        break;
      case 'profile':
        html = renderProfile();
        break;
      case 'settings':
        if (!isAdmin()) {
          html = errorView('只有管理员可以访问设置。');
          break;
        }
        if (!state.settings) state.settings = await api('/api/settings');
        if (!state.users.length) await loadUsers();
        if (!state.librariesLoaded) await loadLibraries();
        if (!settingsDirty) workingLibraries = cloneLibraries(state.libraries);
        html = renderSettings();
        break;
      default:
        html = errorView('页面不存在。');
    }
  } catch (err) {
    html = errorView(err.message || '页面加载失败');
  }

  if (token !== renderSeq) return;
  view.innerHTML = html;
}

// -------------------------------------------------------------------- chrome

function birthdayDismissKey(user) {
  const today = new Date();
  return `${user.id}:${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
}

function renderBirthdayBanner() {
  if (!birthdayBanner) return;
  const user = state.user;
  if (!user || !isBirthday(user.birthDate)) {
    birthdayBanner.hidden = true;
    delete birthdayBanner.dataset.key;
    return;
  }
  const key = birthdayDismissKey(user);
  if (localStorage.getItem('lumina.birthday.dismissed') === key) {
    birthdayBanner.hidden = true;
    return;
  }
  if (birthdayBanner.dataset.key === key) {
    birthdayBanner.hidden = false;
    return;
  }
  birthdayBanner.dataset.key = key;
  birthdayBanner.innerHTML = `
    <span class="birthday-emoji" aria-hidden="true">🎂</span>
    <div class="birthday-copy">
      <strong>生日快乐，${esc(user.displayName || user.username)}！</strong>
      <small>愿今天的每一部电影，都刚好是你喜欢的。</small>
    </div>
    <button class="birthday-close" type="button" data-action="dismiss-birthday" aria-label="关闭生日祝福">${icon('close')}</button>
  `;
  birthdayBanner.hidden = false;
}

function updateChrome() {
  const admin = isAdmin();
  document.querySelectorAll('[data-admin-only]').forEach((node) => { node.hidden = !admin; });
  document.querySelectorAll('[data-nav="settings"]').forEach((node) => { node.hidden = !admin; });
  renderAccountMenu();
  renderBirthdayBanner();

  const movieCount = state.stats.movies || state.movies.length;
  const seriesCount = state.stats.series || state.series.length;
  navMovieCount.textContent = movieCount ? String(movieCount) : '';
  navSeriesCount.textContent = seriesCount ? String(seriesCount) : '';
  if (navFavoriteCount) {
    const favoriteCount = favoriteItems().length;
    navFavoriteCount.textContent = favoriteCount ? String(favoriteCount) : '';
  }

  if (!state.user) {
    serverState.classList.remove('busy');
    serverStateTitle.textContent = '请先登录';
    serverStateSub.textContent = '登录后查看家庭片库';
    scanLabel.textContent = '就绪';
    return;
  }

  if (!state.online) {
    serverState.classList.remove('busy');
    serverStateTitle.textContent = '连接中断';
    serverStateSub.textContent = '请确认 Lumina 仍在运行';
    scanPill.classList.remove('busy');
    scanLabel.textContent = '离线';
    return;
  }

  serverState.classList.toggle('busy', state.scanning || state.probe?.active);
  serverStateTitle.textContent = state.settings?.serverName || 'Lumina 已连接';
  serverStateSub.textContent = `${movieCount} 部电影 · ${seriesCount} 部剧集`;

  const busy = state.scanning || state.probe?.active;
  scanPill.classList.toggle('busy', Boolean(busy));
  if (state.scanning) scanLabel.textContent = '扫描中';
  else if (state.probe?.active) scanLabel.textContent = `分析 ${state.probe.done || 0}/${state.probe.total || 0}`;
  else scanLabel.textContent = '就绪';
  scanPill.title = state.scanning ? '正在扫描媒体库' : '点击重新扫描媒体库';
}

function applyLibrary(data) {
  state.movies = data.movies || [];
  state.series = data.series || [];
  state.recentIds = data.recentIds || [];
  state.stats = data.stats || state.stats;
  state.mediaDirs = data.mediaDirs || [];
  state.scannedAt = data.scannedAt || null;
  state.scanning = Boolean(data.scanning);
  state.probe = data.probe || { active: false, done: 0, total: 0 };
  state.revision = data.revision;
  state.online = true;

  state.moviesById = new Map(state.movies.map((item) => [item.id, item]));
  state.seriesById = new Map(state.series.map((item) => [item.id, item]));
  state.episodesById = new Map();
  for (const series of state.series) {
    for (const episode of series.episodes || []) state.episodesById.set(episode.id, episode);
  }
}

function markOffline() {
  state.online = false;
  updateChrome();
}

// -------------------------------------------------------------------- actions

async function triggerScan() {
  if (state.scanning) {
    showToast('媒体库正在扫描中');
    return;
  }
  try {
    const result = await api('/api/scan', { method: 'POST' });
    if (result.started) {
      state.scanning = true;
      updateChrome();
      showToast('已开始扫描媒体库');
    } else {
      showToast(result.message || '正在扫描中');
    }
    schedulePoll(600);
  } catch (err) {
    showToast(err.message || '无法启动扫描', 'error');
  }
}

function cloneLibraries(list) {
  return (list || []).map((library) => ({
    ...library,
    userIds: [...(library.userIds || [])],
  }));
}

function addLibrary() {
  workingLibraries.push({
    id: '',
    name: '新媒体库',
    path: '',
    enabled: true,
    minAge: 0,
    access: 'all',
    userIds: [],
    movieCount: 0,
    episodeCount: 0,
    seriesCount: 0,
  });
  settingsDirty = true;
  renderRoute({ scroll: false });
  requestAnimationFrame(() => {
    const cards = [...document.querySelectorAll('[data-library-index]')];
    const input = cards.at(-1)?.querySelector('[data-lib-field="path"]');
    input?.focus();
  });
}

function removeLibrary(index) {
  if (!Number.isInteger(index) || index < 0 || index >= workingLibraries.length) return;
  const library = workingLibraries[index];
  if (library.movieCount || library.episodeCount) {
    if (!window.confirm(`移除“${library.name}”只会取消扫描，不会删除磁盘上的视频文件。继续？`)) return;
  }
  workingLibraries.splice(index, 1);
  settingsDirty = true;
  renderRoute({ scroll: false });
  showToast('已从列表移除，保存后生效');
}

function resetLibraries() {
  workingLibraries = cloneLibraries(state.libraries);
  settingsDirty = false;
  renderRoute({ scroll: false });
  showToast('已还原为当前保存的媒体库');
}

function updateLibraryField(target) {
  const card = target.closest('[data-library-index]');
  const index = Number(card?.dataset.libraryIndex);
  const library = workingLibraries[index];
  if (!library) return;
  const field = target.dataset.libField;
  if (field === 'enabled') library.enabled = target.checked;
  else if (field === 'access') {
    library.access = target.value;
    if (library.access !== 'selected') library.userIds = [];
  } else if (field === 'minAge') library.minAge = Number(target.value) || 0;
  else if (field === 'name' || field === 'path') library[field] = target.value;
  settingsDirty = true;
  if (field === 'enabled' || field === 'access') renderRoute({ scroll: false });
}

function toggleLibraryUser(target) {
  const card = target.closest('[data-library-index]');
  const index = Number(card?.dataset.libraryIndex);
  const library = workingLibraries[index];
  if (!library || library.access !== 'selected') return;
  const id = target.dataset.libUser;
  const set = new Set(library.userIds || []);
  if (target.checked) set.add(id);
  else set.delete(id);
  library.userIds = [...set];
  settingsDirty = true;
}

async function saveLibraries() {
  if (workingLibraries.length === 0 || workingLibraries.every((library) => library.enabled === false)) {
    showToast('至少需要保留一个启用的媒体库', 'error');
    return;
  }
  const payload = workingLibraries.map((library) => ({
    id: library.id || undefined,
    name: String(library.name || '').trim(),
    path: String(library.path || '').trim(),
    enabled: library.enabled !== false,
    minAge: Number(library.minAge) || 0,
    access: library.access || 'all',
    userIds: library.access === 'selected' ? (library.userIds || []) : [],
  }));
  for (const [index, library] of payload.entries()) {
    if (!library.path) {
      showToast(`第 ${index + 1} 个媒体库还没有填写路径`, 'error');
      return;
    }
    if (!library.name) library.name = library.path.split(/[\\/]/).filter(Boolean).pop() || `媒体库 ${index + 1}`;
  }
  const paths = payload.map((library) => library.path.replace(/[\\/]+/g, '/').toLowerCase());
  if (new Set(paths).size !== paths.length) {
    showToast('同一个目录不能添加两次', 'error');
    return;
  }
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await api('/api/libraries', {
        method: 'POST',
        body: JSON.stringify({
          libraries: payload,
          baseRevision: state.libraryRevision,
        }),
      });
      state.libraries = result.libraries || [];
      state.librariesLoaded = true;
      state.libraryRevision = result.revision ?? state.libraryRevision;
      state.settings.mediaDirs = state.libraries.filter((library) => library.enabled).map((library) => library.path);
      state.mediaDirs = [...state.settings.mediaDirs];
      workingLibraries = cloneLibraries(state.libraries);
      settingsDirty = false;
      state.scanning = true;
      updateChrome();
      renderRoute({ scroll: false });
      showToast(attempt > 0 ? '媒体库已保存（已同步最新版本）' : '媒体库已保存，正在重新扫描');
      schedulePoll(600);
      return;
    } catch (err) {
      lastError = err;
      if (err.status === 409 && attempt === 0) {
        try {
          await loadLibraries();
        } catch {
          /* retry with the old revision once; the server will explain if it still conflicts */
        }
        continue;
      }
      break;
    }
  }
  showToast(lastError?.message || '保存失败', 'error');
  if (lastError?.status === 409) {
    try {
      await loadLibraries();
      renderRoute({ scroll: false });
    } catch {
      /* keep current view */
    }
  }
}

async function clearProgress() {
  const ids = Object.keys(state.progress);
  if (!ids.length) {
    showToast('当前没有观看记录');
    return;
  }
  if (!window.confirm(`确定要清空 ${ids.length} 条观看进度吗？此操作不会影响视频文件。`)) return;
  try {
    await Promise.all(ids.map((id) => api(`/api/progress/${id}`, { method: 'DELETE' }).catch(() => null)));
    state.progress = {};
    updateChrome();
    renderRoute({ scroll: false });
    showToast('已清空观看进度');
  } catch (err) {
    showToast(err.message || '清空失败', 'error');
  }
}

async function restartFromBeginning(id) {
  try {
    await api(`/api/progress/${id}`, { method: 'DELETE' });
    delete state.progress[id];
  } catch {
    /* ignore */
  }
  player.open(id);
}

async function refreshUsers() {
  await loadUsers().catch(() => null);
  renderRoute({ scroll: false });
}

async function saveUser(id) {
  const row = document.querySelector(`[data-user-row="${id}"]`);
  if (!row) return;
  try {
    const result = await api(`/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        role: row.querySelector('[data-user-field="role"]')?.value,
        birthDate: row.querySelector('[data-user-field="birthDate"]')?.value || '',
        allowUnrated: Boolean(row.querySelector('[data-user-field="allowUnrated"]')?.checked),
      }),
    });
    if (result.user && result.user.id === state.user?.id) state.user = result.user;
    showToast('用户设置已保存');
    await refreshUsers();
    updateChrome();
  } catch (err) {
    showToast(err.message || '保存失败', 'error');
  }
}

async function decideBirthdate(id, action) {
  try {
    const result = await api(`/api/users/${id}/birthdate`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    if (result.user?.id === state.user?.id) state.user = result.user;
    showToast(action === 'approve' ? '出生日期申请已同意' : '出生日期申请已拒绝');
    await refreshUsers();
    updateChrome();
  } catch (err) {
    showToast(err.message || '操作失败', 'error');
  }
}

async function deleteUser(id) {
  const user = state.users.find((entry) => entry.id === id);
  if (!user) return;
  if (!window.confirm(`确定删除用户「${user.displayName || user.username}」吗？其观看进度也会一并清除。`)) return;
  try {
    await api(`/api/users/${id}`, { method: 'DELETE' });
    showToast('用户已删除');
    await refreshUsers();
  } catch (err) {
    showToast(err.message || '删除失败', 'error');
  }
}

async function resetUserPassword(id) {
  const user = state.users.find((entry) => entry.id === id);
  if (!user) return;
  const password = window.prompt(`为「${user.displayName || user.username}」设置新密码（至少 6 位）`);
  if (!password) return;
  if (password.length < 6) {
    showToast('密码至少 6 位', 'error');
    return;
  }
  try {
    await api(`/api/users/${id}/password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    showToast('密码已重置，该用户需要重新登录');
  } catch (err) {
    showToast(err.message || '重置失败', 'error');
  }
}

async function createUserFromForm() {
  const username = document.getElementById('new-user-username')?.value.trim();
  const displayName = document.getElementById('new-user-name')?.value.trim();
  const password = document.getElementById('new-user-password')?.value;
  const role = document.getElementById('new-user-role')?.value || 'member';
  const birthDate = document.getElementById('new-user-birthdate')?.value || '';
  const allowUnrated = Boolean(document.getElementById('new-user-unrated')?.checked);
  if (!username || !password) {
    showToast('请填写用户名和初始密码', 'error');
    return;
  }
  if (!birthDate) {
    showToast('请选择出生日期', 'error');
    return;
  }
  try {
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: displayName || username,
        password,
        role,
        birthDate,
        allowUnrated,
      }),
    });
    showToast('用户已添加');
    await refreshUsers();
  } catch (err) {
    showToast(err.message || '添加失败', 'error');
  }
}

async function toggleRegistration() {
  try {
    const result = await api('/api/auth/settings', {
      method: 'POST',
      body: JSON.stringify({ allowRegistration: !state.allowRegistration }),
    });
    state.allowRegistration = Boolean(result.allowRegistration);
    showToast(state.allowRegistration ? '已开放自助注册' : '已关闭自助注册');
    renderRoute({ scroll: false });
  } catch (err) {
    showToast(err.message || '设置失败', 'error');
  }
}

async function applyRating(select) {
  const kind = select.dataset.ratingKind;
  const id = select.dataset.ratingId;
  const ageRating = select.value === '' ? null : Number(select.value);
  select.disabled = true;
  try {
    await api('/api/ratings', {
      method: 'POST',
      body: JSON.stringify({ kind, id, ageRating }),
    });
    const library = await api('/api/library');
    applyLibrary(library);
    await renderRoute({ scroll: false });
    showToast(ageRating === null ? '已设为未分级' : `已设为 ${ageRating}+`);
  } catch (err) {
    showToast(err.message || '分级设置失败', 'error');
    select.disabled = false;
  }
}

let metadataContext = null;
let metadataResults = [];
let subtitleContext = null;
let subtitleResults = [];

function closeDialogs() {
  document.getElementById('metadata-modal')?.remove();
  document.getElementById('subtitle-modal')?.remove();
  metadataContext = null;
  subtitleContext = null;
  document.body.classList.remove('modal-open');
}

function dialogShell(id, title, body) {
  document.getElementById(id)?.remove();
  const wrap = document.createElement('div');
  wrap.id = id;
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head">
      <div><span class="modal-kicker">在线资源</span><h2>${esc(title)}</h2></div>
      <button class="icon-btn" type="button" data-close-dialog aria-label="关闭">${icon('close')}</button>
    </div>
    ${body}
  </div>`;
  document.body.append(wrap);
  document.body.classList.add('modal-open');
  return wrap;
}

async function openMetadataDialog(kind, id) {
  const entity = kind === 'series' ? state.seriesById.get(id) : state.moviesById.get(id);
  if (!entity) return;
  metadataContext = { kind, id, query: entity.title, year: entity.year };
  const body = `<form class="dialog-search" id="metadata-search-form">
      <input class="field" id="metadata-query" value="${esc(entity.title)}" placeholder="片名" aria-label="片名">
      <input class="field dialog-year" id="metadata-year" value="${entity.year || ''}" inputmode="numeric" placeholder="年份" aria-label="年份">
      <button class="btn btn-primary" type="submit">${icon('search')}搜索</button>
    </form>
    <p class="hint" id="metadata-source-note">正在搜索…</p>
    <div class="metadata-results" id="metadata-results"></div>`;
  const wrap = dialogShell('metadata-modal', `匹配元数据 · ${entity.title}`, body);
  wrap.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-dialog]') || event.target === wrap) closeDialogs();
    const apply = event.target.closest('[data-apply-metadata]');
    if (apply) applyMetadataResult(Number(apply.dataset.applyMetadata));
  });
  wrap.querySelector('#metadata-search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    searchMetadataModal();
  });
  searchMetadataModal();
}

function proxiedImageUrl(url) {
  return url ? `/api/metadata/image?url=${encodeURIComponent(url)}` : '';
}

function metadataSourceLabel(source) {
  return ({
    tmdb: 'TMDB',
    douban: '豆瓣',
    tvmaze: 'TVMaze',
    wikipedia: '维基百科',
  })[source] || '在线元数据';
}

async function searchMetadataModal() {
  if (!metadataContext) return;
  const results = document.getElementById('metadata-results');
  const note = document.getElementById('metadata-source-note');
  if (!results) return;
  const q = document.getElementById('metadata-query').value.trim();
  const year = document.getElementById('metadata-year').value.trim();
  if (!q) {
    note.textContent = '请输入片名。';
    return;
  }
  results.innerHTML = `<div class="dialog-loading">${icon('spark')}正在联网搜索…</div>`;
  note.textContent = '正在搜索…';
  try {
    const params = new URLSearchParams({ kind: metadataContext.kind, q });
    if (year) params.set('year', year);
    const data = await api(`/api/metadata/search?${params}`);
    metadataResults = data.results || [];
    note.textContent = metadataResults.length
      ? `来源：${metadataSourceLabel(data.source)} · ${metadataResults.length} 个候选`
      : '没有找到候选。可以换个片名，或在设置中配置 TMDB Key。';
    if (!metadataResults.length) {
      results.innerHTML = `<div class="empty compact"><p class="empty-title">没有匹配结果</p><p>换个片名或年份再试。</p></div>`;
      return;
    }
    results.innerHTML = metadataResults.map((item, index) => `<article class="metadata-result">
      <div class="metadata-poster">${item.posterUrl ? `<img src="${esc(proxiedImageUrl(item.posterUrl))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${icon('film')}</span>`}</div>
      <div class="metadata-info">
        <h3>${esc(item.title)}</h3>
        <p class="metadata-meta">${item.year ? `${item.year} 年 · ` : ''}${metadataSourceLabel(data.source)}</p>
        <p class="metadata-overview">${esc(item.overview || '暂无简介')}</p>
      </div>
      <button class="btn btn-primary btn-sm" data-apply-metadata="${index}">应用</button>
    </article>`).join('');
  } catch (err) {
    note.textContent = err.message || '搜索失败';
    results.innerHTML = '';
  }
}

async function applyMetadataResult(index) {
  const item = metadataResults[index];
  if (!item || !metadataContext) return;
  const button = document.querySelector(`[data-apply-metadata="${index}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = '应用中…';
  }
  try {
    const result = await api('/api/metadata/apply', {
      method: 'POST',
      body: JSON.stringify({
        kind: metadataContext.kind,
        id: metadataContext.id,
        title: item.title,
        originalTitle: item.originalTitle,
        year: item.year,
        overview: item.overview,
        posterUrl: item.posterUrl,
        backdropUrl: item.backdropUrl,
        source: item.provider,
        externalId: item.externalId,
      }),
    });
    closeDialogs();
    const library = await api('/api/library');
    applyLibrary(library);
    await renderRoute({ scroll: false });
    showToast(result.warning ? `元数据已应用，但封面下载失败：${result.warning}` : '元数据已应用');
  } catch (err) {
    showToast(err.message || '应用失败', 'error');
    if (button) {
      button.disabled = false;
      button.textContent = '应用';
    }
  }
}

async function openSubtitleDialog(itemId) {
  const item = state.episodesById.get(itemId) || state.moviesById.get(itemId);
  if (!item) return;
  const label = item.seriesTitle
    ? `${item.seriesTitle} · ${episodeCode(item.season, item.episode)}`
    : item.title;
  subtitleContext = { itemId, label };
  const lang = state.settings?.metadata?.subtitleLanguage || 'zh';
  const body = `<div class="dialog-inline">
      <span class="hint">为「${esc(label)}」搜索字幕</span>
      <select class="field select-sm" id="subtitle-language">
        <option value="zh" ${lang === 'zh' ? 'selected' : ''}>中文</option>
        <option value="en" ${lang === 'en' ? 'selected' : ''}>English</option>
      </select>
    </div>
    <p class="hint" id="subtitle-note">正在搜索…</p>
    <div class="subtitle-results" id="subtitle-results"></div>`;
  const wrap = dialogShell('subtitle-modal', '在线字幕', body);
  wrap.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-dialog]') || event.target === wrap) closeDialogs();
    const download = event.target.closest('[data-download-subtitle]');
    if (download) downloadSubtitleResult(Number(download.dataset.downloadSubtitle));
  });
  wrap.querySelector('#subtitle-language').addEventListener('change', loadSubtitleResults);
  loadSubtitleResults();
}

async function loadSubtitleResults() {
  if (!subtitleContext) return;
  const results = document.getElementById('subtitle-results');
  const note = document.getElementById('subtitle-note');
  if (!results) return;
  const lang = document.getElementById('subtitle-language').value;
  results.innerHTML = `<div class="dialog-loading">${icon('subtitles')}正在搜索字幕…</div>`;
  note.textContent = '正在搜索…';
  try {
    const params = new URLSearchParams({ itemId: subtitleContext.itemId, lang });
    const data = await api(`/api/metadata/subtitles?${params}`);
    subtitleResults = data.results || [];
    note.textContent = data.results?.length
      ? `来自 MySubs · ${data.results.length} 条候选`
      : '没有找到字幕，可以换个语言再试。';
    if (!subtitleResults.length) {
      results.innerHTML = `<div class="empty compact"><p class="empty-title">没有找到字幕</p><p>数据源覆盖有限，请换个语言或稍后再试。</p></div>`;
      return;
    }
    results.innerHTML = subtitleResults.map((item, index) => `<article class="subtitle-result">
      <div><strong>${esc(item.label || item.lang)}</strong>
        <p>${item.format || 'SRT'}${item.downloads ? ` · ${item.downloads} 次下载` : ''}${item.season ? ` · S${String(item.season).padStart(2, '0')}E${String(item.episode || 0).padStart(2, '0')}` : ''}</p>
      </div>
      <button class="btn btn-ghost btn-sm" data-download-subtitle="${index}">${icon('subtitles')}下载</button>
    </article>`).join('');
  } catch (err) {
    note.textContent = err.message || '字幕搜索失败';
    results.innerHTML = '';
  }
}

async function downloadSubtitleResult(index) {
  const item = subtitleResults[index];
  if (!item || !subtitleContext) return;
  const button = document.querySelector(`[data-download-subtitle="${index}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = '下载中…';
  }
  try {
    await api('/api/metadata/subtitles', {
      method: 'POST',
      body: JSON.stringify({
        itemId: subtitleContext.itemId,
        subtitleId: item.id,
        lang: document.getElementById('subtitle-language')?.value || 'zh',
      }),
    });
    closeDialogs();
    const library = await api('/api/library');
    applyLibrary(library);
    await renderRoute({ scroll: false });
    showToast('字幕已下载，重新打开播放器即可选择');
  } catch (err) {
    showToast(err.message || '字幕下载失败', 'error');
    if (button) {
      button.disabled = false;
      button.textContent = '下载';
    }
  }
}

async function saveMetadataSettings() {
  const provider = document.getElementById('metadata-provider')?.value;
  const subtitleLanguage = document.getElementById('metadata-subtitle-language')?.value;
  const keyInput = document.getElementById('metadata-tmdb-key');
  const body = { provider, language: 'zh', subtitleLanguage };
  if (keyInput?.value.trim()) body.tmdbApiKey = keyInput.value.trim();
  try {
    const result = await api('/api/settings/metadata', { method: 'POST', body: JSON.stringify(body) });
    state.settings = { ...(state.settings || {}), metadata: result.metadata };
    showToast('网络元数据设置已保存');
    renderRoute({ scroll: false });
  } catch (err) {
    showToast(err.message || '保存失败', 'error');
  }
}

async function clearTmdbKey() {
  try {
    const result = await api('/api/settings/metadata', {
      method: 'POST',
      body: JSON.stringify({ provider: state.settings?.metadata?.provider || 'auto', clearTmdbKey: true }),
    });
    state.settings = { ...(state.settings || {}), metadata: result.metadata };
    showToast('TMDB Key 已清除');
    renderRoute({ scroll: false });
  } catch (err) {
    showToast(err.message || '清除失败', 'error');
  }
}

async function handleAction(element) {
  const action = element.dataset.action;
  if (action === 'scan') return triggerScan();
  if (action === 'dismiss-birthday') {
    if (birthdayBanner?.dataset.key) localStorage.setItem('lumina.birthday.dismissed', birthdayBanner.dataset.key);
    if (birthdayBanner) birthdayBanner.hidden = true;
    return undefined;
  }
  if (action === 'reload') return boot();
  if (action === 'logout') return signOut();
  if (action === 'change-password') return changeOwnPassword();
  if (action === 'save-profile') return saveProfile();
  if (action === 'pick-avatar') return pickAvatar();
  if (action === 'remove-avatar') {
    profileAvatarDraft = null;
    profileAvatarRemoved = true;
    profileDirty = true;
    renderProfileAvatar();
    return undefined;
  }
  if (action === 'cancel-birthdate-request') return cancelBirthdateRequest();
  if (action === 'approve-birthdate') return decideBirthdate(element.dataset.id, 'approve');
  if (action === 'reject-birthdate') return decideBirthdate(element.dataset.id, 'reject');
  if (action === 'toggle-registration') return toggleRegistration();
  if (action === 'save-user') return saveUser(element.dataset.id);
  if (action === 'delete-user') return deleteUser(element.dataset.id);
  if (action === 'reset-user-password') return resetUserPassword(element.dataset.id);
  if (action === 'create-user') return createUserFromForm();
  if (action === 'open-metadata') return openMetadataDialog(element.dataset.kind, element.dataset.id);
  if (action === 'open-subtitles') return openSubtitleDialog(element.dataset.id);
  if (action === 'save-metadata-settings') return saveMetadataSettings();
  if (action === 'clear-tmdb-key') return clearTmdbKey();
  if (action === 'add-library') return addLibrary();
  if (action === 'remove-library') return removeLibrary(Number(element.dataset.index));
  if (action === 'save-libraries') return saveLibraries();
  if (action === 'reset-libraries') return resetLibraries();
  if (action === 'clear-progress') return clearProgress();
  if (action === 'restart') return restartFromBeginning(element.dataset.id);
  return undefined;
}

// ---------------------------------------------------------------------- auth

function authInput(label, name, type = 'text', extra = '', autocomplete = '') {
  const auto = autocomplete || (type === 'password' ? 'current-password' : 'username');
  return `<label class="auth-field"><span>${esc(label)}</span>
    <input name="${name}" type="${type}" ${extra} required autocomplete="${auto}">
  </label>`;
}

function authBirthDateInput() {
  const today = new Date();
  const max = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return `<label class="auth-field"><span>出生日期</span>
    <input name="birthDate" type="date" min="1900-01-01" max="${max}" required autocomplete="bday">
    <small class="auth-field-note">用于计算可观看年龄，并会在生日当天送上祝福。</small>
  </label>`;
}

function renderAuth(notice = '') {
  if (state.auth?.needsSetup) authMode = 'setup';
  const setup = authMode === 'setup';
  const register = authMode === 'register';
  const registering = setup || register;
  const title = setup ? '创建管理员账号' : register ? '注册新账号' : '欢迎回来';
  const subtitle = setup
    ? '这是 Lumina 的第一个账号，将自动成为管理员，可以管理片库与家庭成员的观看权限。'
    : register
      ? '填写出生日期以计算可观看的年龄范围，生日当天还会收到一份小祝福。'
      : '登录后继续观看，你的播放进度会跟随账号保存。';

  document.body.classList.add('auth-locked');
  authOverlay.hidden = false;
  authPanel.innerHTML = `
    <form class="auth-form" data-auth-form="${setup ? 'register' : authMode}">
      <h1>${title}</h1>
      <p class="auth-sub">${subtitle}</p>
      ${notice ? `<p class="auth-notice">${esc(notice)}</p>` : ''}
      ${registering ? authInput('显示名称', 'displayName', 'text', 'maxlength="32" placeholder="例如：网名"', 'nickname') : ''}
      ${authInput('用户名', 'username', 'text', 'minlength="2" maxlength="24" placeholder="2-24 位，中英文/数字/_-"', 'username')}
      ${authInput('密码', 'password', 'password', 'minlength="6" placeholder="至少 6 位"', registering ? 'new-password' : 'current-password')}
      ${registering ? authInput('确认密码', 'confirm', 'password', 'minlength="6" placeholder="再次输入密码"', 'new-password') : ''}
      ${registering ? authBirthDateInput() : ''}
      <p class="auth-error" id="auth-error" role="alert"></p>
      <button class="btn btn-primary auth-submit" type="submit">${setup ? '创建并进入' : register ? '注册并登录' : '登录'}</button>
    </form>
    ${setup ? '' : `<div class="auth-switch">
      ${register
        ? `已有账号？<button type="button" data-auth-mode="login">返回登录</button>`
        : state.auth?.allowRegistration
          ? `还没有账号？<button type="button" data-auth-mode="register">注册一个</button>`
          : `<span class="auth-hint">${icon('lock')}管理员已关闭自助注册，请联系管理员创建账号。</span>`}
    </div>`}
  `;
  requestAnimationFrame(() => authPanel.querySelector('input')?.focus());
}

function authError(message) {
  const node = document.getElementById('auth-error');
  if (node) node.textContent = message;
}

async function submitAuth(form) {
  const mode = form.dataset.authForm;
  const data = Object.fromEntries(new FormData(form));
  if (data.confirm !== undefined && data.password !== data.confirm) {
    authError('两次输入的密码不一致');
    return;
  }
  const submit = form.querySelector('.auth-submit');
  submit.disabled = true;
  submit.textContent = mode === 'login' ? '正在登录…' : '正在创建…';
  authError('');
  try {
    const result = await api(mode === 'login' ? '/api/auth/login' : '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: data.username,
        password: data.password,
        displayName: data.displayName || data.username,
        ...(mode === 'login' ? {} : { birthDate: data.birthDate }),
      }),
    });
    state.user = result.user;
    state.auth = { ...(state.auth || {}), user: result.user, needsSetup: false };
    authOverlay.hidden = true;
    document.body.classList.remove('auth-locked');
    showToast(result.firstUser ? '管理员账号已创建' : mode === 'login' ? '登录成功' : '注册成功');
    await boot();
  } catch (err) {
    authError(err.message || '操作失败，请稍后再试');
  } finally {
    if (authOverlay.hidden) return;
    submit.disabled = false;
    submit.textContent = mode === 'login' ? '登录' : mode === 'register' ? '注册并登录' : '创建并进入';
  }
}

async function loadUsers() {
  if (!isAdmin()) {
    state.users = [];
    return;
  }
  const data = await api('/api/users');
  state.users = data.users || [];
  state.allowRegistration = Boolean(data.allowRegistration);
}

async function loadFavorites() {
  const data = await api('/api/favorites');
  state.favorites = data.entries || [];
  state.favoritesLoaded = true;
}

async function toggleFavorite(kind, id) {
  const key = favoriteKey(kind, id);
  if (favoritePending.has(key)) return;
  favoritePending.add(key);
  try {
    const result = await api('/api/favorites', {
      method: 'POST',
      body: JSON.stringify({ kind, id }),
    });
    await loadFavorites();
    updateChrome();
    await renderRoute({ scroll: false });
    showToast(result.favorited ? '已加入收藏' : '已取消收藏');
  } catch (err) {
    showToast(err.message || '收藏操作失败', 'error');
  } finally {
    favoritePending.delete(key);
  }
}

async function loadLibraries() {
  if (!isAdmin()) {
    state.libraries = [];
    state.librariesLoaded = true;
    return;
  }
  const data = await api('/api/libraries');
  state.libraries = data.libraries || [];
  state.librariesLoaded = true;
  state.libraryRevision = Number(data.revision) || 0;
}

function renderAccountMenu() {
  if (!state.user) {
    accountName.textContent = '登录';
    accountAvatar.classList.remove('has-image');
    accountAvatar.textContent = '?';
    accountMenuBody.innerHTML = '';
    return;
  }
  const user = state.user;
  const role = user.role === 'admin' ? '管理员' : '成员';
  const age = Number.isFinite(user.age) ? `${user.age} 岁` : '年龄未填写';
  const access = user.role === 'admin' ? '可观看全部内容' : `可观看 ${user.effectiveAge} 岁以下`;
  accountName.textContent = user.displayName || user.username;
  accountAvatar.classList.toggle('has-image', Boolean(user.avatar));
  accountAvatar.innerHTML = user.avatar
    ? `<img src="${esc(user.avatar)}" alt="">`
    : esc(firstChar(user.displayName || user.username));
  accountMenuBody.innerHTML = `
    <div class="account-head">
      ${avatarMarkup(user)}
      <div><strong>${esc(user.displayName || user.username)}</strong><span>@${esc(user.username)} · ${role}</span></div>
    </div>
    <div class="account-age">${icon('shield')}${age} · ${access}</div>
    <a class="account-item" href="#/profile" data-close-account>${icon('user')}个人资料</a>
    ${isAdmin() ? `<a class="account-item" href="#/settings" data-close-account>${icon('settings')}设置与用户管理</a>` : ''}
    <button class="account-item" data-action="change-password">${icon('key')}修改密码</button>
    <button class="account-item danger" data-action="logout">${icon('logout')}退出登录</button>
  `;
}

function closeAccountMenu() {
  accountMenu.hidden = true;
  accountBtn.setAttribute('aria-expanded', 'false');
}

async function signOut() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  if (player?.visible) player.close();
  state.user = null;
  state.auth = { needsSetup: false, allowRegistration: state.allowRegistration, user: null };
  state.users = [];
  state.settings = null;
  state.progress = {};
  state.favorites = [];
  state.favoritesLoaded = false;
  state.mediaDirs = [];
  state.libraries = [];
  state.librariesLoaded = false;
  settingsDirty = false;
  workingLibraries = [];
  if (pollTimer) clearTimeout(pollTimer);
  closeAccountMenu();
  updateChrome();
  authMode = 'login';
  renderAuth('已退出登录');
}

async function changeOwnPassword() {
  closeAccountMenu();
  const currentPassword = window.prompt('请输入当前密码');
  if (!currentPassword) return;
  const newPassword = window.prompt('请输入新密码（至少 6 位）');
  if (!newPassword) return;
  if (newPassword.length < 6) {
    showToast('新密码至少 6 位', 'error');
    return;
  }
  try {
    await api('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    showToast('密码已修改，请重新登录');
    state.user = null;
    state.auth = { needsSetup: false, allowRegistration: state.allowRegistration, user: null };
    closeAccountMenu();
    authMode = 'login';
    renderAuth('请使用新密码登录');
  } catch (err) {
    showToast(err.message || '修改失败', 'error');
  }
}

// --------------------------------------------------------------------- boot

async function boot() {
  if (pollTimer) clearTimeout(pollTimer);
  view.innerHTML = `<div class="booting">
    <span class="brand-mark"><svg class="icon"><use href="#i-logo"/></svg></span>
    <span>正在连接微光影库…</span>
  </div>`;
  try {
    if (!state.user) {
      const status = await api('/api/auth/status');
      state.auth = status;
      state.allowRegistration = Boolean(status.allowRegistration);
      if (!status.user) {
        updateChrome();
        renderAuth();
        return;
      }
      state.user = status.user;
    }
    authOverlay.hidden = true;
    document.body.classList.remove('auth-locked');
    const [library, favorites] = await Promise.all([
      api('/api/library'),
      api('/api/favorites'),
    ]);
    applyLibrary(library);
    state.favorites = favorites.entries || [];
    state.favoritesLoaded = true;
    const [progress, health] = await Promise.all([
      api('/api/progress').catch(() => null),
      api('/api/health').catch(() => null),
    ]);
    state.progress = progress?.progress || {};
    state.health = health || null;
    state.settings = null;
    if (isAdmin()) {
      const [settings, userList, libraryList] = await Promise.all([
        api('/api/settings').catch(() => null),
        api('/api/users').catch(() => null),
        api('/api/libraries').catch(() => null),
      ]);
      state.settings = settings || null;
      state.users = userList?.users || [];
      state.libraries = libraryList?.libraries || [];
      state.librariesLoaded = Boolean(libraryList);
      state.libraryRevision = Number(libraryList?.revision) || 0;
      state.allowRegistration = Boolean(userList?.allowRegistration ?? state.allowRegistration);
    }
    if (!settingsDirty) workingLibraries = cloneLibraries(state.libraries);
    updateChrome();
    await renderRoute({ scroll: false });
    schedulePoll(1200);
  } catch (err) {
    if (err.status === 401) {
      state.user = null;
      state.auth = { ...(state.auth || {}), user: null };
      renderAuth('登录状态已过期，请重新登录');
      return;
    }
    markOffline();
    view.innerHTML = `<div class="empty">
      <div class="empty-icon">${icon('info')}</div>
      <h2>连接不上 Lumina</h2>
      <p>${esc(err.message || '请确认服务已经启动，并且手机和电脑在同一个局域网。')}</p>
      <button class="btn btn-primary" data-action="reload">${icon('refresh')}重新连接</button>
    </div>`;
  }
}

function schedulePoll(delay = 5000) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(pollLibrary, delay);
}

async function pollLibrary() {
  try {
    const data = await api('/api/library');
    const changed = data.revision !== state.revision;
    applyLibrary(data);
    if (changed) await loadFavorites().catch(() => {});
    updateChrome();

    if (changed) {
      const active = document.activeElement;
      const editing = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) && view.contains(active);
      const route = currentRoute;
      if (player?.visible) {
        // Defer; the page is hidden behind the player and will refresh on close.
      } else if (route.name === 'settings') {
        if (!settingsDirty) await renderRoute({ scroll: false });
      } else if (!editing) {
        await renderRoute({ scroll: false });
      }
    }
    schedulePoll(state.scanning || state.probe?.active ? 1600 : 5000);
  } catch (err) {
    if (err.status === 401) {
      if (pollTimer) clearTimeout(pollTimer);
      state.user = null;
      state.auth = { ...(state.auth || {}), user: null };
      authMode = 'login';
      renderAuth('登录状态已过期，请重新登录');
      return;
    }
    markOffline();
    schedulePoll(8000);
  }
}

// -------------------------------------------------------------------- events

function bindEvents() {
  window.addEventListener('hashchange', () => renderRoute({ scroll: true }));

  authPanel.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-auth-form]');
    if (!form) return;
    event.preventDefault();
    submitAuth(form);
  });

  authPanel.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-auth-mode]');
    if (!toggle) return;
    authMode = toggle.dataset.authMode === 'register' ? 'register' : 'login';
    renderAuth();
  });

  accountBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = accountMenu.hidden;
    accountMenu.hidden = !open;
    accountBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  accountMenu.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-account]')) {
      closeAccountMenu();
      return;
    }
    const action = event.target.closest('[data-action]');
    if (action) {
      event.preventDefault();
      handleAction(action);
    }
  });

  document.addEventListener('click', (event) => {
    if (!accountMenu.hidden && !event.target.closest('.account-wrap')) closeAccountMenu();
  });

  searchInput.addEventListener('input', debounce(() => {
    const q = searchInput.value.trim();
    location.hash = q ? `#/search?q=${encodeURIComponent(q)}` : '#/home';
  }, 220));

  document.querySelectorAll('.topbar [data-action="scan"]').forEach((button) => {
    button.addEventListener('click', triggerScan);
  });

  view.addEventListener('click', (event) => {
    const favorite = event.target.closest('[data-favorite]');
    if (favorite) {
      event.preventDefault();
      event.stopPropagation();
      const [kind, id] = favorite.dataset.favorite.split(':');
      if (kind && id) toggleFavorite(kind, id);
      return;
    }
    const action = event.target.closest('[data-action]');
    if (action) {
      event.preventDefault();
      handleAction(action);
      return;
    }
    const play = event.target.closest('[data-play]');
    if (play) {
      event.preventDefault();
      player.open(play.dataset.play);
      return;
    }
    const playSeries = event.target.closest('[data-play-series]');
    if (playSeries) {
      event.preventDefault();
      const series = state.seriesById.get(playSeries.dataset.playSeries);
      const target = series ? seriesTargetEpisode(series) : null;
      if (target) player.open(target.id);
      else showToast('这部剧集还没有可播放的集数', 'error');
      return;
    }
    const open = event.target.closest('[data-open]');
    if (open) {
      event.preventDefault();
      location.hash = open.dataset.open;
      return;
    }
    const season = event.target.closest('[data-season]');
    if (season) {
      event.preventDefault();
      seasonChoice.set(season.dataset.series, Number(season.dataset.season));
      renderRoute({ scroll: false });
      return;
    }
    const scroll = event.target.closest('[data-scroll]');
    if (scroll) {
      event.preventDefault();
      const row = document.getElementById(scroll.dataset.scroll);
      if (row) row.scrollBy({ left: Number(scroll.dataset.dir) * row.clientWidth * 0.82, behavior: 'smooth' });
    }
  });

  view.addEventListener('input', (event) => {
    if (event.target.id === 'profile-display-name' || event.target.id === 'profile-birthdate') {
      profileDirty = true;
    }
  });

  view.addEventListener('change', async (event) => {
    if (event.target.id === 'profile-avatar-input') {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        profileAvatarDraft = await readAvatarFile(file);
        profileAvatarRemoved = false;
        profileDirty = true;
        renderProfileAvatar();
      } catch (err) {
        showToast(err.message || '头像读取失败', 'error');
      }
      return;
    }
    const rating = event.target.closest('[data-rating-kind]');
    if (rating) {
      applyRating(rating);
      return;
    }
    const libraryField = event.target.closest('[data-lib-field]');
    if (libraryField) {
      const field = libraryField.dataset.libField;
      updateLibraryField(libraryField);
      if (field !== 'enabled' && field !== 'access') renderRoute({ scroll: false });
      return;
    }
    const libraryUser = event.target.closest('[data-lib-user]');
    if (libraryUser) toggleLibraryUser(libraryUser);
  });

  view.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target.closest('[data-open],[data-play],[data-play-series]');
    if (!target || ['BUTTON', 'A'].includes(target.tagName)) return;
    event.preventDefault();
    target.click();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (metadataContext || subtitleContext)) {
      closeDialogs();
      return;
    }
    if (event.key === 'Escape' && !accountMenu.hidden) {
      closeAccountMenu();
      return;
    }
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (player?.visible) return;
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  });

  document.addEventListener('error', (event) => {
    const img = event.target;
    if (img instanceof HTMLImageElement) {
      img.classList.add('failed');
      img.alt = '';
    }
  }, true);

  player = new Player({
    root: document.getElementById('player-root'),
    onClose: () => {
      if (currentRoute.name === 'settings' && settingsDirty) return;
      renderRoute({ scroll: false });
    },
    onProgress: (id, record) => {
      state.progress[id] = record;
      if (!player?.visible) renderRoute({ scroll: false });
    },
  });

  // Android/iOS back gesture: while the player is open it has its own
  // history entry, so popstate should close it instead of leaving the page.
  window.addEventListener('popstate', () => {
    if (player?.visible) player.close({ fromHistory: true });
  });
}

if (!location.hash) history.replaceState(null, '', '#/home');
bindEvents();
boot();
