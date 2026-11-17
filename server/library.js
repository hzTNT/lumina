import fs from 'node:fs';
import path from 'node:path';
import {
  VIDEO_MIME,
  TaskQueue,
  cleanTitle,
  findArtFiles,
  findSubtitleFiles,
  idFor,
  isSeasonFolder,
  isVideoFile,
  naturalCompare,
  parseFilename,
  readJson,
  seasonFromFolder,
  seriesTitleFromFolder,
  writeJsonAtomic,
} from './util.js';
import {
  ensureVtt,
  isForcedSuffix,
  languageFromSuffix,
  languageInfo,
} from './subtitles.js';
import { detectAgeRating, normalizeAgeRating, ratingLabel } from './ratings.js';

const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'node_modules', '.git', '.svn',
  '@eadir', '#recycle', 'lost+found', 'data', 'bin', 'runtime', 'public', 'server',
]);

function normKey(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

function sigOf(item) {
  return `${item.size}:${item.mtime}`;
}

function round(n, digits = 3) {
  const m = 10 ** digits;
  return Math.round((Number(n) || 0) * m) / m;
}

function epCompare(a, b) {
  return (a.season - b.season)
    || (a.episode - b.episode)
    || naturalCompare(a.fileName, b.fileName);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export class Library {
  constructor({ config, tools, dataDir }) {
    this.config = config;
    this.tools = tools;
    this.dataDir = dataDir;
    this.libraryFile = path.join(dataDir, 'library.json');
    this.progressFile = path.join(dataDir, 'progress.json');
    this.favoritesFile = path.join(dataDir, 'favorites.json');
    this.metadataFile = path.join(dataDir, 'metadata.json');
    this.ratingsFile = path.join(dataDir, 'ratings.json');
    this.probeFile = path.join(dataDir, 'probe.json');
    this.artDir = path.join(dataDir, 'art');
    this.metadataDir = path.join(dataDir, 'meta-art');
    this.subsDir = path.join(dataDir, 'subs');
    this.transcodeDir = path.join(dataDir, 'transcode');

    this.items = new Map();
    this.series = new Map();
    this.progress = readJson(this.progressFile, {});
    const favoriteData = readJson(this.favoritesFile, { version: 1, users: {} });
    this.favorites = favoriteData && typeof favoriteData === 'object' && favoriteData.users && typeof favoriteData.users === 'object'
      ? favoriteData.users
      : {};
    const metaData = readJson(this.metadataFile, { version: 1, items: {}, series: {} });
    this.metadata = {
      version: 1,
      items: metaData?.items && typeof metaData.items === 'object' ? metaData.items : {},
      series: metaData?.series && typeof metaData.series === 'object' ? metaData.series : {},
    };
    this.ratingOverrides = readJson(this.ratingsFile, { items: {}, series: {} });
    if (!this.ratingOverrides || typeof this.ratingOverrides !== 'object') this.ratingOverrides = { items: {}, series: {} };
    if (!this.ratingOverrides.items) this.ratingOverrides.items = {};
    if (!this.ratingOverrides.series) this.ratingOverrides.series = {};
    this.probeCache = readJson(this.probeFile, {});

    this.scanning = false;
    this.scanPromise = null;
    this.scannedAt = 0;
    this.revision = 1;
    this.probeState = { active: false, done: 0, total: 0 };
    this.probeToken = 0;

    this.payloadCache = null;
    this.artQueue = new TaskQueue(2);
    this.segmentQueue = new TaskQueue(1);
    this.artPending = new Map();
    this.segmentPending = new Map();
    this.probePending = new Map();
    this.subtitlePending = new Map();

    this.scanTimer = null;
    this.cleanupTimer = null;
    this.saveTimer = null;
    this.probeSaveTimer = null;
    this.progressSaveTimer = null;

    for (const dir of [this.dataDir, this.artDir, this.subsDir, this.transcodeDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async init() {
    this.loadCache();
    this.cleanupTranscode().catch(() => {});
    if (this.config.scanOnStart !== false) {
      await this.scan();
    }
    const minutes = Number(this.config.scanIntervalMinutes) || 0;
    if (minutes > 0) {
      this.scanTimer = setInterval(() => {
        this.scan().catch((err) => console.warn(`[scan] ${err.message}`));
      }, minutes * 60 * 1000);
      this.scanTimer.unref?.();
    }
    this.cleanupTimer = setInterval(() => {
      this.cleanupTranscode().catch(() => {});
    }, 6 * 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  stop() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.flushAll();
  }

  // ---------------------------------------------------------------- persistence

  loadCache() {
    const data = readJson(this.libraryFile, null);
    if (!data || !Array.isArray(data.items) || !Array.isArray(data.series)) return;
    const items = new Map();
    for (const item of data.items) {
      if (!item?.id || !item.filePath) continue;
      item._sidecarSubs = Array.isArray(item._sidecarSubs) ? item._sidecarSubs : [];
      if (this.getProbeData(item)) this.applyProbe(item, this.getProbeData(item));
      items.set(item.id, item);
    }
    const series = new Map();
    for (const s of data.series) {
      if (!s?.id) continue;
      s.episodeIds = Array.isArray(s.episodeIds) ? s.episodeIds.filter((id) => items.has(id)) : [];
      if (!s.episodeIds.length) continue;
      series.set(s.id, s);
    }
    this.items = items;
    this.series = series;
    this.scannedAt = data.scannedAt || 0;
    this.payloadCache = null;
    console.log(`[library] 已载入缓存：${this.items.size} 个视频，${this.series.size} 部剧集`);
  }

  saveLibrary() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      writeJsonAtomic(this.libraryFile, {
        version: 2,
        scannedAt: this.scannedAt,
        items: [...this.items.values()],
        series: [...this.series.values()],
      });
    } catch (err) {
      console.warn(`[library] 保存失败：${err.message}`);
    }
  }

  saveLibrarySoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveLibrary();
    }, 1500);
    this.saveTimer.unref?.();
  }

  saveProbeSoon() {
    if (this.probeSaveTimer) return;
    this.probeSaveTimer = setTimeout(() => {
      this.probeSaveTimer = null;
      try {
        writeJsonAtomic(this.probeFile, this.probeCache);
      } catch (err) {
        console.warn(`[probe] 保存失败：${err.message}`);
      }
    }, 1500);
    this.probeSaveTimer.unref?.();
  }

  saveProgressSoon() {
    if (this.progressSaveTimer) return;
    this.progressSaveTimer = setTimeout(() => {
      this.progressSaveTimer = null;
      this.flushProgress();
    }, 400);
    this.progressSaveTimer.unref?.();
  }

  flushProgress() {
    try {
      writeJsonAtomic(this.progressFile, this.progress);
    } catch (err) {
      console.warn(`[progress] 保存失败：${err.message}`);
    }
  }

  flushAll() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.probeSaveTimer) clearTimeout(this.probeSaveTimer);
    if (this.progressSaveTimer) clearTimeout(this.progressSaveTimer);
    this.saveLibrary();
    try { writeJsonAtomic(this.probeFile, this.probeCache); } catch { /* ignore */ }
    this.flushProgress();
  }

  // --------------------------------------------------------------------- scan

  async scan() {
    if (this.scanPromise) return this.scanPromise;
    this.scanning = true;
    this.revision += 1;
    this.scanPromise = (async () => {
      const started = Date.now();
      const records = this.collectFiles();
      this.rebuild(records);
      this.scannedAt = Date.now();
      this.saveLibrary();
      this.scanning = false;
      this.payloadCache = null;
      this.revision += 1;
      const stats = this.stats();
      console.log(
        `[scan] ${((Date.now() - started) / 1000).toFixed(1)}s · `
        + `${stats.movies} 部电影 · ${stats.series} 部剧集 / ${stats.episodes} 集`,
      );
      this.probeAll().catch((err) => console.warn(`[probe] ${err.message}`));
    })();
    try {
      return await this.scanPromise;
    } catch (err) {
      this.scanning = false;
      this.revision += 1;
      throw err;
    } finally {
      this.scanPromise = null;
    }
  }

  collectFiles() {
    const records = [];
    const seen = new Set();
    const walk = (dir, root, library, depth) => {
      if (depth > 14) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const name = entry.name;
        if (name.startsWith('.')) continue;
        const lower = name.toLowerCase();
        const full = path.join(dir, name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(lower)) continue;
          walk(full, root, library, depth + 1);
        } else if (entry.isFile() && isVideoFile(name)) {
          const key = normKey(full);
          if (seen.has(key)) continue;
          let stat;
          try {
            stat = fs.statSync(full);
          } catch {
            continue;
          }
          if (!stat.isFile() || stat.size < 4096) continue;
          seen.add(key);
          records.push({ file: full, root, library, stat });
        }
      }
    };

    for (const library of this.config.libraries || []) {
      if (library.enabled === false) continue;
      const abs = path.resolve(library.path);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        console.warn(`[scan] 媒体库目录不存在：${abs}`);
        continue;
      }
      if (!stat.isDirectory()) {
        console.warn(`[scan] 媒体库不是文件夹：${abs}`);
        continue;
      }
      walk(abs, abs, library, 0);
    }
    return records;
  }

  ratingOverride(kind, id) {
    const bucket = this.ratingOverrides?.[kind] || {};
    return Object.prototype.hasOwnProperty.call(bucket, id) ? bucket[id] : undefined;
  }

  rebuild(records) {
    const newItems = new Map();
    const seriesInfo = new Map();

    for (const rec of records) {
      const parsed = parseFilename(path.basename(rec.file));
      const parent = path.dirname(rec.file);
      const parentName = path.basename(parent);
      const inSeason = isSeasonFolder(parentName);
      const isEpisode = parsed.isEpisode || inSeason;

      if (!isEpisode) {
        const id = idFor('movie', rec.file);
        const art = findArtFiles(parent, parsed.base);
        const item = {
          id,
          kind: 'movie',
          title: parsed.movieTitle || cleanTitle(parsed.base) || path.basename(rec.file),
          year: parsed.year || null,
          filePath: rec.file,
          fileName: path.basename(rec.file),
          rootDir: rec.root,
          libraryId: rec.library?.id || null,
          libraryName: rec.library?.name || '',
          size: rec.stat.size,
          mtime: Math.round(rec.stat.mtimeMs),
          duration: 0,
          width: 0,
          height: 0,
          videoCodec: '',
          audioCodec: '',
          container: '',
          bitrate: 0,
          ageRating: this.ratingOverride('items', id) !== undefined
            ? this.ratingOverride('items', id)
            : detectAgeRating(rec.file, parent),
          ratingSource: this.ratingOverride('items', id) !== undefined ? 'manual' : 'auto',
          _art: art.poster,
          _backdrop: art.backdrop,
          _sidecarSubs: findSubtitleFiles(rec.file),
        };
        this.applyCachedProbe(item);
        newItems.set(id, item);
        continue;
      }

      const seriesDir = inSeason ? path.dirname(parent) : parent;
      const atRoot = normKey(seriesDir) === normKey(rec.root);
      let seriesTitle;
      if (atRoot) {
        seriesTitle = parsed.seriesTitle || parsed.movieTitle || cleanTitle(parentName);
      } else {
        seriesTitle = seriesTitleFromFolder(path.basename(seriesDir))
          || parsed.seriesTitle
          || cleanTitle(path.basename(seriesDir));
      }
      if (!seriesTitle) seriesTitle = '未命名剧集';

      const seriesKey = atRoot ? `root:${seriesTitle.toLowerCase()}` : `dir:${normKey(seriesDir)}`;
      const seriesId = idFor('series', seriesKey);

      let season = parsed.season;
      if (season == null && inSeason) season = seasonFromFolder(parentName);
      if (season == null) season = 1;

      let episodeNumber = parsed.episode;
      if (episodeNumber == null && inSeason) {
        const m = parsed.base.match(/^(\d{1,3})(?:[\s._-]|$)/);
        if (m) episodeNumber = Number(m[1]);
      }

      const id = idFor('episode', rec.file);
      const art = findArtFiles(parent, parsed.base);
      const item = {
        id,
        kind: 'episode',
        title: parsed.episodeTitle || '',
        year: parsed.year || null,
        seriesId,
        seriesTitle,
        season,
        episode: episodeNumber,
        episodeTitle: parsed.episodeTitle || '',
        filePath: rec.file,
        fileName: path.basename(rec.file),
        rootDir: rec.root,
        libraryId: rec.library?.id || null,
        libraryName: rec.library?.name || '',
        size: rec.stat.size,
        mtime: Math.round(rec.stat.mtimeMs),
        duration: 0,
        width: 0,
        height: 0,
        videoCodec: '',
        audioCodec: '',
        container: '',
        bitrate: 0,
        ageRating: this.ratingOverride('items', id) !== undefined
          ? this.ratingOverride('items', id)
          : detectAgeRating(rec.file, seriesDir),
        ratingSource: this.ratingOverride('items', id) !== undefined ? 'manual' : 'auto',
        _art: art.poster,
        _backdrop: art.backdrop,
        _sidecarSubs: findSubtitleFiles(rec.file),
      };
      this.applyCachedProbe(item);
      newItems.set(id, item);

      let series = seriesInfo.get(seriesId);
      if (!series) {
        const rootArt = atRoot ? { poster: null, backdrop: null } : findArtFiles(seriesDir, path.basename(seriesDir));
        series = {
          id: seriesId,
          kind: 'series',
          title: seriesTitle,
          year: parsed.year || null,
          libraryId: rec.library?.id || null,
          libraryName: rec.library?.name || '',
          _dir: atRoot ? null : seriesDir,
          _art: rootArt.poster,
          _backdrop: rootArt.backdrop,
          episodeIds: [],
          mtime: 0,
          addedAt: null,
        };
        seriesInfo.set(seriesId, series);
      }
      series.episodeIds.push(id);
      if (!series.year && parsed.year) series.year = parsed.year;
    }

    for (const series of seriesInfo.values()) {
      const eps = series.episodeIds.map((id) => newItems.get(id)).filter(Boolean);
      eps.sort(epCompare);

      const used = new Map();
      for (const ep of eps) {
        if (!used.has(ep.season)) used.set(ep.season, new Set());
        if (ep.episode != null) used.get(ep.season).add(ep.episode);
      }
      for (const ep of eps) {
        if (ep.episode != null) continue;
        const set = used.get(ep.season);
        let n = 1;
        while (set.has(n)) n += 1;
        ep.episode = n;
        set.add(n);
      }
      eps.sort(epCompare);

      for (const ep of eps) {
        ep.seriesTitle = series.title;
        if (!ep.episodeTitle) ep.episodeTitle = `第 ${ep.episode} 集`;
        ep.title = ep.episodeTitle;
      }

      series.episodeIds = eps.map((ep) => ep.id);
      series.episodeCount = eps.length;
      series.seasonCount = new Set(eps.map((ep) => ep.season)).size;
      series.mtime = Math.max(0, ...eps.map((ep) => ep.mtime));
      series.addedAt = series.mtime ? new Date(series.mtime).toISOString() : null;
      if (!series.year) series.year = eps.find((ep) => ep.year)?.year || null;

      const seriesOverride = this.ratingOverride('series', series.id);
      if (seriesOverride !== undefined) {
        series.ageRating = seriesOverride;
        series.ratingSource = 'manual';
      } else {
        const ratings = eps.map((ep) => ep.ageRating).filter((value) => value !== null && value !== undefined);
        series.ageRating = ratings.length
          ? Math.max(...ratings)
          : detectAgeRating(eps[0].filePath, series._dir || path.dirname(eps[0].filePath));
        series.ratingSource = 'auto';
      }

      for (const ep of eps) {
        if (!series._art && ep._art) series._art = ep._art;
        if (!series._backdrop && ep._backdrop) series._backdrop = ep._backdrop;
      }
      if ((!series._art || !series._backdrop) && series._dir) {
        for (const ep of eps) {
          const dir = path.dirname(ep.filePath);
          const art = findArtFiles(dir, '');
          if (!series._art && art.poster) series._art = art.poster;
          if (!series._backdrop && art.backdrop) series._backdrop = art.backdrop;
        }
      }
      if (!series._art && eps[0]) series._art = eps[0]._art || null;
      if (!series._backdrop && eps[0]) series._backdrop = eps[0]._backdrop || null;
    }

    for (const [id, old] of this.items) {
      const next = newItems.get(id);
      if (!next || next.mtime !== old.mtime || next.filePath !== old.filePath) {
        this.dropTranscode(id);
      }
    }

    this.items = newItems;
    this.series = seriesInfo;
    this.applyStoredMetadata();
    this.payloadCache = null;
  }

  applyCachedProbe(item) {
    const cached = this.probeCache[item.id];
    if (cached && cached.sig === sigOf(item) && cached.data) {
      this.applyProbe(item, cached.data);
    }
  }

  applyProbe(item, data) {
    item.duration = round(data.duration || 0);
    item.width = data.width || 0;
    item.height = data.height || 0;
    item.videoCodec = data.videoCodec || '';
    item.audioCodec = data.audioCodec || '';
    item.container = data.container || '';
    item.bitrate = data.bitrate || 0;
  }

  getProbeData(item) {
    const cached = this.probeCache[item.id];
    if (cached && cached.sig === sigOf(item) && cached.data) return cached.data;
    return null;
  }

  async ensureProbe(item) {
    const existing = this.getProbeData(item);
    if (existing) return existing;
    if (!this.tools.ffprobeAvailable) return null;
    if (this.probePending.has(item.id)) return this.probePending.get(item.id);

    const promise = (async () => {
      let data = null;
      try {
        data = await this.tools.probe(item.filePath);
      } catch (err) {
        console.warn(`[probe] ${item.fileName}: ${err.message}`);
      }
      this.probeCache[item.id] = { sig: sigOf(item), data };
      if (data) this.applyProbe(item, data);
      this.payloadCache = null;
      this.saveProbeSoon();
      return data;
    })();
    this.probePending.set(item.id, promise);
    try {
      return await promise;
    } finally {
      this.probePending.delete(item.id);
    }
  }

  async probeAll() {
    if (!this.tools.ffprobeAvailable) {
      this.probeState = { active: false, done: 0, total: 0 };
      return;
    }
    const token = ++this.probeToken;
    const pending = [...this.items.values()].filter((item) => !this.getProbeData(item));
    if (!pending.length) {
      this.probeState = { active: false, done: 0, total: 0 };
      return;
    }
    this.probeState = { active: true, done: 0, total: pending.length };
    let done = 0;
    const worker = async () => {
      while (pending.length) {
        if (token !== this.probeToken) return;
        const item = pending.shift();
        try {
          await this.ensureProbe(item);
        } catch {
          // ensureProbe already records failures; keep the queue moving.
        }
        done += 1;
        this.probeState.done = done;
        if (done % 4 === 0) {
          this.revision += 1;
          this.payloadCache = null;
          this.saveLibrarySoon();
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (token === this.probeToken) {
      this.probeState = { active: false, done, total: done };
      this.revision += 1;
      this.payloadCache = null;
      this.saveLibrarySoon();
      this.saveProbeSoon();
    }
  }

  // ------------------------------------------------------------------- payload

  stats() {
    let movies = 0;
    let episodes = 0;
    let totalSize = 0;
    let totalDuration = 0;
    for (const item of this.items.values()) {
      totalSize += item.size || 0;
      const probe = this.getProbeData(item);
      totalDuration += probe?.duration || item.duration || 0;
      if (item.kind === 'movie') movies += 1;
      else episodes += 1;
    }
    return {
      movies,
      series: this.series.size,
      episodes,
      totalSize,
      totalDuration: Math.round(totalDuration),
    };
  }

  clientItem(item) {
    const probe = this.getProbeData(item);
    const tracks = this.getSubtitleTracks(item);
    const artV = `${item.mtime}-${item._metaVersion || 0}-${this.revision || 0}`;
    return {
      id: item.id,
      kind: item.kind,
      title: item.kind === 'episode'
        ? (item.episodeTitle || `第 ${item.episode} 集`)
        : item.title,
      year: item.year || null,
      seriesId: item.seriesId || null,
      seriesTitle: item.seriesTitle || null,
      season: item.season ?? null,
      episode: item.episode ?? null,
      episodeTitle: item.episodeTitle || null,
      fileName: item.fileName,
      libraryId: item.libraryId || null,
      libraryName: item.libraryName || '',
      size: item.size,
      mtime: item.mtime,
      addedAt: new Date(item.mtime).toISOString(),
      duration: round(probe?.duration || item.duration || 0),
      width: probe?.width || item.width || 0,
      height: probe?.height || item.height || 0,
      videoCodec: probe?.videoCodec || item.videoCodec || '',
      audioCodec: probe?.audioCodec || item.audioCodec || '',
      container: probe?.container || item.container || '',
      bitrate: probe?.bitrate || item.bitrate || 0,
      ageRating: item.ageRating ?? null,
      ageLabel: ratingLabel(item.ageRating),
      ratingSource: item.ratingSource || 'auto',
      overview: item.overview || '',
      metadataSource: item.metadataSource || null,
      subtitleCount: tracks.length,
      hasProbe: Boolean(probe),
      poster: `/api/art/${item.id}?type=poster&v=${artV}`,
      backdrop: `/api/art/${item.id}?type=backdrop&v=${artV}`,
      thumb: `/api/art/${item.id}?type=thumb&v=${artV}`,
    };
  }

  clientSeries(series, { canView = null } = {}) {
    let eps = series.episodeIds
      .map((id) => this.items.get(id))
      .filter(Boolean)
      .sort(epCompare);
    if (canView) eps = eps.filter((ep) => canView(ep));
    const artV = `${series.mtime}-${series._metaVersion || 0}-${this.revision || 0}`;
    return {
      id: series.id,
      kind: 'series',
      title: series.title,
      year: series.year || null,
      libraryId: series.libraryId || null,
      libraryName: series.libraryName || '',
      ageRating: series.ageRating ?? null,
      ageLabel: ratingLabel(series.ageRating),
      ratingSource: series.ratingSource || 'auto',
      overview: series.overview || '',
      metadataSource: series.metadataSource || null,
      episodeCount: eps.length,
      seasonCount: new Set(eps.map((ep) => ep.season)).size,
      mtime: series.mtime,
      addedAt: series.addedAt || (series.mtime ? new Date(series.mtime).toISOString() : null),
      duration: Math.max(0, ...eps.map((ep) => ep.duration || 0)),
      poster: `/api/art/${series.id}?type=poster&v=${artV}`,
      backdrop: `/api/art/${series.id}?type=backdrop&v=${artV}`,
      episodes: eps.map((ep) => this.clientItem(ep)),
    };
  }

  visibleStats(movies, series) {
    let totalSize = 0;
    let totalDuration = 0;
    let episodes = 0;
    for (const movie of movies) {
      totalSize += movie.size || 0;
      totalDuration += movie.duration || 0;
    }
    for (const show of series) {
      for (const ep of show.episodes) {
        episodes += 1;
        totalSize += ep.size || 0;
        totalDuration += ep.duration || 0;
      }
    }
    return {
      movies: movies.length,
      series: series.length,
      episodes,
      totalSize,
      totalDuration: Math.round(totalDuration),
    };
  }

  getPayload({ canView = null, includeMediaDirs = true } = {}) {
    if (!canView && this.payloadCache) {
      return {
        ...this.payloadCache,
        mediaDirs: includeMediaDirs ? this.payloadCache.mediaDirs : [],
        scanning: this.scanning,
        probe: this.probeState,
        revision: this.revision,
      };
    }

    const movies = [...this.items.values()]
      .filter((item) => item.kind === 'movie' && (!canView || canView(item)))
      .map((item) => this.clientItem(item))
      .sort((a, b) => naturalCompare(a.title, b.title));
    const series = [...this.series.values()]
      .filter((show) => !canView || canView(show))
      .map((show) => this.clientSeries(show, { canView }))
      .filter((show) => show.episodeCount > 0)
      .sort((a, b) => naturalCompare(a.title, b.title));

    const recent = [...movies, ...series]
      .filter((item) => item.addedAt)
      .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))
      .slice(0, 30)
      .map((item) => item.id);

    const payload = {
      name: this.config.serverName,
      version: '1.0.0',
      scannedAt: this.scannedAt,
      stats: canView ? this.visibleStats(movies, series) : this.stats(),
      mediaDirs: includeMediaDirs ? this.config.mediaDirs : [],
      movies,
      series,
      recentIds: recent,
      ffmpeg: this.tools.available,
    };
    if (!canView) this.payloadCache = payload;
    return {
      ...payload,
      scanning: this.scanning,
      probe: this.probeState,
      revision: this.revision,
    };
  }

  setAgeRating(kind, id, value) {
    if (kind !== 'items' && kind !== 'series') {
      const err = new Error('无效的分级对象');
      err.status = 400;
      throw err;
    }
    const target = kind === 'items' ? this.items.get(id) : this.series.get(id);
    if (!target) {
      const err = new Error('媒体不存在');
      err.status = 404;
      throw err;
    }
    if (value !== null && value !== '' && ![0, 7, 13, 16, 18].includes(Number(value))) {
      const err = new Error('年龄分级只能是全年龄、7+、13+、16+、18+ 或未分级');
      err.status = 400;
      throw err;
    }
    const rating = value === null || value === '' ? null : Number(value);
    this.ratingOverrides[kind][id] = rating;
    target.ageRating = rating;
    target.ratingSource = 'manual';
    if (kind === 'items' && target.kind === 'episode') this.refreshSeriesRating(target.seriesId);
    writeJsonAtomic(this.ratingsFile, this.ratingOverrides);
    this.payloadCache = null;
    this.revision += 1;
    return { id, kind, ageRating: rating, ageLabel: ratingLabel(rating) };
  }

  refreshSeriesRating(seriesId) {
    const series = this.series.get(seriesId);
    if (!series) return;
    const override = this.ratingOverride('series', seriesId);
    if (override !== undefined) {
      series.ageRating = override;
      series.ratingSource = 'manual';
      return;
    }
    const ratings = series.episodeIds
      .map((id) => this.items.get(id)?.ageRating)
      .filter((value) => value !== null && value !== undefined);
    series.ageRating = ratings.length ? Math.max(...ratings) : null;
    series.ratingSource = 'auto';
  }

  getItem(id) {
    return this.items.get(id) || null;
  }

  getSeries(id) {
    return this.series.get(id) || null;
  }

  // ----------------------------------------------------------------- favorites

  getFavoriteEntries(userId) {
    if (!userId) return [];
    const list = this.favorites[userId];
    if (!Array.isArray(list)) return [];
    return list.filter((entry) => entry && (entry.kind === 'movie' || entry.kind === 'series') && typeof entry.id === 'string');
  }

  isFavorite(userId, kind, id) {
    return this.getFavoriteEntries(userId).some((entry) => entry.kind === kind && entry.id === id);
  }

  saveFavorites() {
    writeJsonAtomic(this.favoritesFile, { version: 1, users: this.favorites });
  }

  toggleFavorite(userId, kind, id) {
    if (!userId) {
      const err = new Error('请先登录');
      err.status = 401;
      throw err;
    }
    if (kind !== 'movie' && kind !== 'series') {
      const err = new Error('收藏类型不正确');
      err.status = 400;
      throw err;
    }
    if (kind === 'movie') {
      const item = this.items.get(id);
      if (!item || item.kind !== 'movie') {
        const err = new Error('影片不存在');
        err.status = 404;
        throw err;
      }
    } else if (!this.series.get(id)) {
      const err = new Error('剧集不存在');
      err.status = 404;
      throw err;
    }
    const list = Array.isArray(this.favorites[userId]) ? this.favorites[userId] : [];
    const index = list.findIndex((entry) => entry.kind === kind && entry.id === id);
    let favorited;
    if (index >= 0) {
      list.splice(index, 1);
      favorited = false;
    } else {
      list.unshift({ kind, id, addedAt: Date.now() });
      favorited = true;
    }
    this.favorites[userId] = list.slice(0, 5000);
    this.saveFavorites();
    return { favorited, entries: this.getFavoriteEntries(userId) };
  }

  getFavoritePayload(userId, { canView = null } = {}) {
    const movies = [];
    const series = [];
    const entries = [];
    for (const entry of this.getFavoriteEntries(userId)) {
      let entity = null;
      if (entry.kind === 'movie') {
        const item = this.items.get(entry.id);
        if (item && item.kind === 'movie' && (!canView || canView(item))) entity = item;
      } else {
        const show = this.series.get(entry.id);
        if (show && (!canView || canView(show))) entity = show;
      }
      if (!entity) continue;
      entries.push({ kind: entry.kind, id: entry.id, addedAt: entry.addedAt });
      if (entry.kind === 'movie') movies.push(this.clientItem(entity));
      else series.push(this.clientSeries(entity, { canView }));
    }
    return { entries, movies, series };
  }

  removeUserFavorites(userId) {
    if (!userId) return false;
    delete this.favorites[userId];
    this.saveFavorites();
    return true;
  }

  // ------------------------------------------------------------------ metadata

  metadataFor(kind, id) {
    const bucket = kind === 'series' ? this.metadata.series : this.metadata.items;
    return bucket[id] || null;
  }

  saveMetadata() {
    writeJsonAtomic(this.metadataFile, { version: 1, ...this.metadata });
  }

  metadataPath(rel) {
    if (!rel || typeof rel !== 'string') return null;
    if (path.isAbsolute(rel)) return null;
    const abs = path.resolve(this.dataDir, rel);
    const base = path.resolve(this.dataDir);
    if (abs !== base && !abs.startsWith(`${base}${path.sep}`)) return null;
    return fs.existsSync(abs) ? abs : null;
  }

  applyMetadataRecord(entity, record) {
    const kind = entity.kind === 'series' ? 'series' : 'movie';
    const poster = this.metadataPath(record.posterPath);
    const backdrop = this.metadataPath(record.backdropPath);
    entity.overview = String(record.overview || '').slice(0, 4000);
    entity.originalTitle = String(record.originalTitle || '').slice(0, 200);
    if (record.year != null) entity.year = Number(record.year) || null;
    entity.metadataSource = record.source || 'manual';
    entity._metaVersion = Number(record.updatedAt) || 0;
    entity._metaPoster = poster;
    entity._metaBackdrop = backdrop;
    if (kind === 'series') {
      if (record.title) entity.title = String(record.title).slice(0, 200);
      for (const id of entity.episodeIds || []) {
        const ep = this.items.get(id);
        if (ep) {
          ep.seriesTitle = entity.title;
          ep._metaVersion = entity._metaVersion;
        }
      }
    } else {
      if (record.title) entity.title = String(record.title).slice(0, 200);
    }
  }

  applyStoredMetadata() {
    for (const [id, record] of Object.entries(this.metadata.items)) {
      const item = this.items.get(id);
      if (item) this.applyMetadataRecord(item, record);
    }
    for (const [id, record] of Object.entries(this.metadata.series)) {
      const series = this.series.get(id);
      if (series) this.applyMetadataRecord(series, record);
    }
  }

  setMetadata(kind, id, patch = {}) {
    const entity = kind === 'series' ? this.series.get(id) : this.items.get(id);
    if (!entity || (kind !== 'series' && entity.kind !== 'movie')) {
      const err = new Error('影片不存在');
      err.status = 404;
      throw err;
    }
    const bucket = kind === 'series' ? this.metadata.series : this.metadata.items;
    const record = { ...(bucket[id] || {}) };
    if (patch.title !== undefined) record.title = String(patch.title || '').trim().slice(0, 200);
    if (patch.originalTitle !== undefined) record.originalTitle = String(patch.originalTitle || '').trim().slice(0, 200);
    if (patch.year !== undefined) {
      const year = Number(patch.year);
      record.year = Number.isInteger(year) && year >= 1800 && year <= 2200 ? year : null;
    }
    if (patch.overview !== undefined) record.overview = String(patch.overview || '').trim().slice(0, 4000);
    if (patch.posterPath !== undefined) record.posterPath = String(patch.posterPath || '') || null;
    if (patch.backdropPath !== undefined) record.backdropPath = String(patch.backdropPath || '') || null;
    if (patch.source !== undefined) record.source = String(patch.source || '').slice(0, 40);
    if (patch.externalId !== undefined) record.externalId = String(patch.externalId || '').slice(0, 100);
    record.updatedAt = Date.now();
    bucket[id] = record;
    this.applyMetadataRecord(entity, record);
    this.saveMetadata();
    this.payloadCache = null;
    this.revision += 1;
    return record;
  }

  saveOnlineSubtitle(itemId, buffer, lang = 'zh') {
    const item = this.items.get(itemId);
    if (!item) {
      const err = new Error('媒体不存在');
      err.status = 404;
      throw err;
    }
    if (!buffer || !buffer.length) {
      const err = new Error('字幕内容为空');
      err.status = 400;
      throw err;
    }
    const safeLang = String(lang || 'zh').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 12) || 'zh';
    const dir = path.dirname(item.filePath);
    const base = path.basename(item.filePath, path.extname(item.filePath));
    let target = path.join(dir, `${base}.${safeLang}.srt`);
    if (fs.existsSync(target)) target = path.join(dir, `${base}.${safeLang}.online.srt`);
    fs.writeFileSync(target, buffer);
    item._sidecarSubs = findSubtitleFiles(item.filePath);
    this.payloadCache = null;
    this.revision += 1;
    return this.getSubtitleTracks(item).find((track) => track.file === target) || null;
  }

  // ------------------------------------------------------------------ progress

  adoptLegacyProgress(userId) {
    if (!userId || this.legacyProgressMigrated) return;
    const flatKeys = Object.keys(this.progress).filter((key) => {
      const value = this.progress[key];
      return value && typeof value === 'object' && typeof value.position === 'number';
    });
    if (!flatKeys.length) return;
    const bucket = this.progress[userId] && typeof this.progress[userId] === 'object'
      ? this.progress[userId]
      : {};
    for (const key of flatKeys) {
      if (!bucket[key]) bucket[key] = this.progress[key];
      delete this.progress[key];
    }
    this.progress[userId] = bucket;
    this.legacyProgressMigrated = true;
    this.saveProgressSoon();
  }

  getProgress(userId) {
    this.adoptLegacyProgress(userId);
    const bucket = userId ? this.progress[userId] : null;
    return bucket && typeof bucket === 'object' ? bucket : {};
  }

  getProgressFor(userId, id) {
    return this.getProgress(userId)[id] || null;
  }

  setProgress(userId, id, { position, duration, completed } = {}) {
    const item = this.items.get(id);
    if (!item) {
      const err = new Error('媒体不存在');
      err.status = 404;
      throw err;
    }
    const bucket = this.getProgress(userId);
    const prev = bucket[id] || {};
    const total = Number(duration) || (this.getProbeData(item)?.duration || item.duration || prev.duration || 0);
    let pos = Math.max(0, Number(position) || 0);
    if (total > 0) pos = Math.min(pos, total);
    const pct = total > 0 ? pos / total : 0;
    const isComplete = completed === true || (total > 0 && pct >= 0.95);
    if (isComplete && total > 0) pos = total;
    const record = {
      position: round(pos, 2),
      duration: round(total, 2),
      completed: Boolean(isComplete),
      updatedAt: Date.now(),
    };
    if (userId) {
      this.progress[userId] = bucket;
      bucket[id] = record;
    }
    this.saveProgressSoon();
    return record;
  }

  removeProgress(userId, id) {
    if (!userId) return false;
    const bucket = this.getProgress(userId);
    delete bucket[id];
    this.saveProgressSoon();
    return true;
  }

  removeUserProgress(userId) {
    if (!userId) return false;
    delete this.progress[userId];
    this.saveProgressSoon();
    return true;
  }

  // ----------------------------------------------------------------- subtitles

  getSubtitleTracks(item) {
    const tracks = [];
    const base = path.basename(item.filePath, path.extname(item.filePath));
    for (const sub of item._sidecarSubs || []) {
      const rest = sub.stem.slice(base.length).replace(/^[.\s_-]+/, '');
      const info = languageFromSuffix(rest);
      const forced = isForcedSuffix(rest);
      let label = info?.label || (rest ? rest.replace(/[._-]+/g, ' ') : '字幕');
      if (forced) label += '（强制）';
      tracks.push({
        id: `s${tracks.length}`,
        kind: 'sidecar',
        file: sub.file,
        ext: sub.ext,
        label,
        lang: info?.lang || '',
        forced,
      });
    }

    const probe = this.getProbeData(item);
    for (const stream of probe?.subtitleStreams || []) {
      const info = languageInfo(stream.lang);
      let label = stream.title || info?.label || `内嵌字幕 ${stream.index}`;
      if (stream.forced) label += '（强制）';
      tracks.push({
        id: `e${stream.index}`,
        kind: 'embedded',
        streamIndex: stream.index,
        label,
        lang: info?.lang || stream.lang || '',
        codec: stream.codec,
        forced: stream.forced,
      });
    }
    return tracks;
  }

  async getSubtitleFile(id, trackId) {
    const item = this.items.get(id);
    if (!item) {
      const err = new Error('媒体不存在');
      err.status = 404;
      throw err;
    }
    await this.ensureProbe(item);
    const track = this.getSubtitleTracks(item).find((t) => t.id === trackId);
    if (!track) {
      const err = new Error('字幕不存在');
      err.status = 404;
      throw err;
    }
    const key = `${id}:${trackId}:${item.mtime}`;
    if (!this.subtitlePending.has(key)) {
      const promise = ensureVtt({ item, track, tools: this.tools, outDir: this.subsDir });
      this.subtitlePending.set(key, promise);
      promise.finally(() => this.subtitlePending.delete(key)).catch(() => {});
    }
    return this.subtitlePending.get(key);
  }

  // ---------------------------------------------------------------------- play

  isDirectPlayable(item) {
    const ext = path.extname(item.filePath).toLowerCase();
    const video = (item.videoCodec || '').toLowerCase();
    const audio = (item.audioCodec || '').toLowerCase();
    if (!video) return ['.mp4', '.m4v', '.webm'].includes(ext);
    if (ext === '.mp4' || ext === '.m4v') {
      return video === 'h264' && (!audio || ['aac', 'mp3'].includes(audio));
    }
    if (ext === '.webm') {
      return ['vp8', 'vp9', 'av1'].includes(video) && (!audio || ['opus', 'vorbis'].includes(audio));
    }
    return false;
  }

  qualitiesFor(item) {
    const max = Math.min(Number(this.config.transcode.maxHeight) || 1080, 2160);
    const source = item.height || 720;
    const upper = Math.min(max, Math.max(480, source));
    const list = [1080, 720, 480].filter((q) => q <= upper);
    if (!list.length) list.push(480);
    return list;
  }

  nextEpisode(item, canView = null) {
    if (item.kind !== 'episode') return null;
    const series = this.series.get(item.seriesId);
    if (!series) return null;
    const eps = series.episodeIds.map((id) => this.items.get(id)).filter(Boolean).sort(epCompare);
    const index = eps.findIndex((ep) => ep.id === item.id);
    if (index < 0) return null;
    for (let i = index + 1; i < eps.length; i += 1) {
      if (!canView || canView(eps[i])) return eps[i];
    }
    return null;
  }

  prevEpisode(item, canView = null) {
    if (item.kind !== 'episode') return null;
    const series = this.series.get(item.seriesId);
    if (!series) return null;
    const eps = series.episodeIds.map((id) => this.items.get(id)).filter(Boolean).sort(epCompare);
    const index = eps.findIndex((ep) => ep.id === item.id);
    if (index < 0) return null;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (!canView || canView(eps[i])) return eps[i];
    }
    return null;
  }

  async getPlayInfo(id, { canView = null, userId = null } = {}) {
    const item = this.items.get(id);
    if (!item) {
      const err = new Error('媒体不存在');
      err.status = 404;
      throw err;
    }
    if (canView && !canView(item)) {
      const err = new Error('你没有权限观看这部影片');
      err.status = 403;
      throw err;
    }
    const probe = await this.ensureProbe(item);
    const duration = round(probe?.duration || item.duration || 0);
    const tracks = this.getSubtitleTracks(item);
    const ext = path.extname(item.filePath).toLowerCase();
    const next = this.nextEpisode(item, canView);
    const prev = this.prevEpisode(item, canView);
    const directCompatible = this.isDirectPlayable(item);
    const hlsAvailable = this.tools.available
      && this.config.transcode?.enabled !== false
      && duration > 1;

    return {
      item: this.clientItem(item),
      title: item.kind === 'episode'
        ? `${item.seriesTitle} · S${pad2(item.season)}E${pad2(item.episode)}`
        : item.title,
      subtitle: item.kind === 'episode' ? item.episodeTitle : '',
      duration,
      direct: {
        url: `/api/stream/${id}`,
        mime: VIDEO_MIME[ext] || 'application/octet-stream',
        compatible: directCompatible,
      },
      hls: hlsAvailable ? {
        url: `/api/hls/${id}/master.m3u8`,
        qualities: this.qualitiesFor(item),
        segmentSeconds: Number(this.config.transcode.segmentSeconds) || 6,
      } : null,
      subtitles: tracks.map((track) => ({
        id: track.id,
        label: track.label,
        lang: track.lang,
        forced: track.forced,
      })),
      next: next ? {
        id: next.id,
        title: next.episodeTitle || `第 ${next.episode} 集`,
        season: next.season,
        episode: next.episode,
        thumb: `/api/art/${next.id}?type=thumb&v=${next.mtime}`,
      } : null,
      prev: prev ? { id: prev.id, title: prev.episodeTitle || `第 ${prev.episode} 集` } : null,
      progress: this.getProgressFor(userId, id),
      probe: probe ? {
        width: probe.width,
        height: probe.height,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        container: probe.container,
      } : null,
    };
  }

  // ---------------------------------------------------------------------- art

  async getArt(id, type = 'poster') {
    if (!['poster', 'backdrop', 'thumb'].includes(type)) type = 'poster';
    let target = this.items.get(id) || null;
    let series = null;
    if (!target) {
      series = this.series.get(id) || null;
      if (!series) return null;
    }

    const sourceItem = target || this.items.get(series.episodeIds[0]);
    if (!sourceItem) return null;
    const targetMtime = target ? target.mtime : series.mtime;

    const metaOwner = target?.kind === 'episode' ? this.series.get(target.seriesId) : (target || series);
    const metaFile = type === 'backdrop'
      ? metaOwner?._metaBackdrop
      : (metaOwner?._metaPoster || metaOwner?._metaBackdrop);
    if (metaFile && fs.existsSync(metaFile)) return { file: metaFile, source: true };

    let sidecar = null;
    if (target) {
      sidecar = type === 'poster' ? target._art : type === 'backdrop' ? target._backdrop : null;
      if (!sidecar && target.kind === 'episode') {
        const owner = this.series.get(target.seriesId);
        sidecar = type === 'poster' ? owner?._art : owner?._backdrop;
      }
    } else {
      sidecar = type === 'poster' ? series._art : type === 'backdrop' ? series._backdrop : null;
    }
    if (sidecar && fs.existsSync(sidecar)) return { file: sidecar, source: true };

    // A portrait poster is a better backdrop fallback than a video frame.
    if (type === 'backdrop') {
      const posterFallback = metaOwner?._metaPoster || (target ? target._art : series?._art);
      if (posterFallback && fs.existsSync(posterFallback)) {
        return { file: posterFallback, source: true };
      }
    }

    if (!this.tools.available) return null;

    const out = path.join(this.artDir, `${id}-${type}.jpg`);
    const existing = await fs.promises.stat(out).catch(() => null);
    if (existing && existing.size > 0 && existing.mtimeMs >= targetMtime) {
      return { file: out, source: false };
    }

    const key = `${id}:${type}`;
    if (!this.artPending.has(key)) {
      const promise = this.artQueue.run(async () => {
        const duration = this.getProbeData(sourceItem)?.duration || sourceItem.duration || 0;
        await this.tools.generateImage(sourceItem.filePath, type, out, duration);
        return { file: out, source: false };
      });
      this.artPending.set(key, promise);
      promise.finally(() => this.artPending.delete(key)).catch(() => {});
    }
    try {
      return await this.artPending.get(key);
    } catch (err) {
      console.warn(`[art] ${id}/${type}: ${err.message}`);
      return null;
    }
  }

  // --------------------------------------------------------------------- hls

  normalizeQuality(q, item) {
    const allowed = this.qualitiesFor(item);
    const n = Number(q);
    if (allowed.includes(n)) return n;
    return allowed.includes(720) ? 720 : allowed[allowed.length - 1];
  }

  async getHlsPlaylist(id, quality) {
    const item = this.items.get(id);
    if (!item) {
      const err = new Error('媒体不存在');
      err.status = 404;
      throw err;
    }
    const q = this.normalizeQuality(quality, item);
    const probe = await this.ensureProbe(item);
    const duration = probe?.duration || item.duration || 0;
    if (duration < 1) {
      const err = new Error('无法获取视频时长，不能转码播放');
      err.status = 409;
      throw err;
    }
    const segmentSeconds = Number(this.config.transcode.segmentSeconds) || 6;
    const count = Math.ceil(duration / segmentSeconds);
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(segmentSeconds)}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-INDEPENDENT-SEGMENTS',
    ];
    for (let n = 0; n < count; n += 1) {
      const dur = Math.min(segmentSeconds, duration - n * segmentSeconds);
      lines.push(`#EXTINF:${dur.toFixed(3)},`);
      lines.push(`${n}.ts?q=${q}`);
    }
    lines.push('#EXT-X-ENDLIST');
    return { playlist: lines.join('\n'), q, duration };
  }

  async getHlsSegment(id, quality, index) {
    const item = this.items.get(id);
    if (!item) {
      const err = new Error('媒体不存在');
      err.status = 404;
      throw err;
    }
    const q = this.normalizeQuality(quality, item);
    const n = Number(index);
    if (!Number.isInteger(n) || n < 0) {
      const err = new Error('无效的分段');
      err.status = 400;
      throw err;
    }
    const probe = await this.ensureProbe(item);
    const duration = probe?.duration || item.duration || 0;
    if (duration < 1) {
      const err = new Error('无法获取视频时长');
      err.status = 409;
      throw err;
    }
    const segmentSeconds = Number(this.config.transcode.segmentSeconds) || 6;
    const start = n * segmentSeconds;
    if (start >= duration) {
      const err = new Error('分段超出范围');
      err.status = 404;
      throw err;
    }
    const segDuration = Math.min(segmentSeconds, duration - start);
    const out = path.join(this.transcodeDir, id, String(q), `${n}.ts`);
    const existing = await fs.promises.stat(out).catch(() => null);
    if (existing && existing.size > 0) return out;

    const key = `${id}:${q}:${n}`;
    if (!this.segmentPending.has(key)) {
      const promise = this.segmentQueue.run(async () => {
        await this.tools.transcodeSegment({
          file: item.filePath,
          outPath: out,
          start,
          duration: segDuration,
          height: Math.min(q, item.height || q),
          segmentSeconds,
          crf: this.config.transcode.crf,
          preset: this.config.transcode.preset,
        });
        return out;
      });
      this.segmentPending.set(key, promise);
      promise.finally(() => this.segmentPending.delete(key)).catch(() => {});
    }
    return this.segmentPending.get(key);
  }

  async cleanupTranscode() {
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const walk = async (dir, depth = 0) => {
      if (depth > 4) return;
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          const left = await fs.promises.readdir(full).catch(() => ['x']);
          if (!left.length) await fs.promises.rmdir(full).catch(() => {});
        } else {
          const stat = await fs.promises.stat(full).catch(() => null);
          if (stat && now - stat.mtimeMs > maxAge) {
            await fs.promises.unlink(full).catch(() => {});
          }
        }
      }
    };
    await walk(this.transcodeDir);
  }

  dropTranscode(id) {
    const dir = path.join(this.transcodeDir, id);
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  // ----------------------------------------------------------------- settings

  getLibraries() {
    const counts = new Map();
    for (const item of this.items.values()) {
      const key = item.libraryId || '';
      if (!counts.has(key)) counts.set(key, { movies: 0, episodes: 0, series: new Set() });
      const entry = counts.get(key);
      if (item.kind === 'movie') entry.movies += 1;
      if (item.kind === 'episode') {
        entry.episodes += 1;
        if (item.seriesId) entry.series.add(item.seriesId);
      }
    }
    return (this.config.libraries || []).map((library) => {
      const entry = counts.get(library.id);
      return {
        ...library,
        movieCount: entry?.movies || 0,
        episodeCount: entry?.episodes || 0,
        seriesCount: entry?.series.size || 0,
      };
    });
  }

  async setLibraries(libraries) {
    this.config.libraries = libraries;
    this.config.mediaDirs = libraries.filter((library) => library.enabled !== false).map((library) => library.path);
    this.payloadCache = null;
    return this.scan();
  }

  async setMediaDirs(dirs) {
    const existing = this.config.libraries || [];
    const libraries = dirs.map((dir, index) => {
      const old = existing.find((library) => path.resolve(library.path) === path.resolve(dir));
      return old || {
        id: `lib_${Date.now().toString(36)}${index}`,
        name: path.basename(dir) || `媒体库 ${index + 1}`,
        path: path.resolve(dir),
        enabled: true,
        minAge: 0,
        access: 'all',
        userIds: [],
        createdAt: Date.now(),
      };
    });
    return this.setLibraries(libraries);
  }

  getScanStatus() {
    return {
      scanning: this.scanning,
      scannedAt: this.scannedAt,
      probe: this.probeState,
      revision: this.revision,
      stats: this.stats(),
    };
  }
}
