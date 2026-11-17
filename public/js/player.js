import {
  api,
  esc,
  episodeCode,
  formatTime,
  icon,
  showToast,
} from './core.js';

const HIDE_DELAY = 3200;
const REPORT_INTERVAL = 10_000;

export class Player {
  constructor({ root, onClose, onProgress } = {}) {
    this.root = root;
    this.onClose = onClose || (() => {});
    this.onProgress = onProgress || (() => {});
    this.visible = false;
    this.currentId = null;
    this.playData = null;
    this.hls = null;
    this.mode = 'direct';
    this.quality = null;
    this.qualities = [];
    this.tracks = [];
    this.subtitleIndex = -1;
    this.forceDirect = false;
    this.resumeTarget = 0;
    this.resumeApplied = false;
    this.autoplay = true;
    this.hideTimer = null;
    this.reportTimer = null;
    this.toastTimer = null;
    this.loadToken = 0;
    this.dragging = false;
    this.dragValue = 0;
    this.lastReportAt = 0;
    this.menuOpen = false;
    this.historyPushed = false;

    this.build();
    this.bind();
  }

  build() {
    this.root.innerHTML = `
      <div class="player" id="player" hidden>
        <video id="player-video" playsinline preload="metadata"></video>

        <div class="player-top">
          <button class="player-back" data-p="close" aria-label="关闭播放器">${icon('arrow-left')}</button>
          <div class="player-heading">
            <strong id="player-title">正在播放</strong>
            <span id="player-subtitle"></span>
          </div>
          <div class="player-top-right">
            <span class="player-quality-badge" id="player-badge">直连</span>
          </div>
        </div>

        <button class="player-big-play" data-p="toggle" id="player-big-play" aria-label="播放">
          ${icon('play', 'fill')}
        </button>

        <div class="player-spinner" id="player-spinner" hidden><span class="spinner"></span></div>

        <div class="player-error" id="player-error" hidden>
          ${icon('info')}
          <h3>无法播放</h3>
          <p id="player-error-text"></p>
          <div class="end-actions">
            <button class="btn btn-primary btn-sm" data-p="retry">${icon('replay')}重试</button>
            <button class="btn btn-ghost btn-sm" data-p="direct" id="player-direct-btn" hidden>使用直连播放</button>
            <button class="btn btn-ghost btn-sm" data-p="close">关闭</button>
          </div>
        </div>

        <div class="player-controls">
          <div class="seek" id="seek">
            <div class="seek-track">
              <div class="seek-buffered" id="seek-buffered"></div>
              <div class="seek-played" id="seek-played"></div>
              <div class="seek-thumb" id="seek-thumb"></div>
            </div>
            <input type="range" id="seek-input" min="0" max="1000" step="1" value="0" aria-label="播放进度">
          </div>
          <div class="control-row">
            <button class="pbtn" data-p="toggle" id="player-play-btn" aria-label="播放/暂停">${icon('play', 'fill')}</button>
            <button class="pbtn" data-p="back10" aria-label="后退 10 秒">${icon('back10')}</button>
            <button class="pbtn" data-p="forward10" aria-label="前进 10 秒">${icon('forward10')}</button>
            <div class="volume">
              <button class="pbtn" data-p="mute" id="player-mute-btn" aria-label="静音">${icon('volume')}</button>
              <input type="range" id="player-volume" min="0" max="1" step="0.02" value="1" aria-label="音量">
            </div>
            <span class="player-time" id="player-time">0:00 / 0:00</span>
            <div class="player-spacer"></div>
            <button class="pbtn text" data-p="subtitles" id="player-subtitle-btn" aria-label="字幕">${icon('subtitles')}<span>字幕</span></button>
            <button class="pbtn text" data-p="quality" id="player-quality-btn" aria-label="画质">${icon('quality')}<span>画质</span></button>
            <button class="pbtn" data-p="pip" aria-label="画中画">${icon('pip')}</button>
            <button class="pbtn" data-p="fullscreen" id="player-fs-btn" aria-label="全屏">${icon('fullscreen')}</button>
          </div>
        </div>

        <div class="player-menu" id="player-subtitle-menu" hidden></div>
        <div class="player-menu" id="player-quality-menu" hidden></div>
        <div class="player-toast" id="player-toast"></div>

        <div class="end-screen" id="player-end" hidden>
          <span class="end-label">播放结束</span>
          <h3 id="player-end-title">已看完</h3>
          <p id="player-end-sub"></p>
          <div class="end-actions" id="player-end-actions"></div>
        </div>
      </div>`;

    const $ = (sel) => this.root.querySelector(sel);
    this.el = $('#player');
    this.video = $('#player-video');
    this.titleEl = $('#player-title');
    this.subtitleEl = $('#player-subtitle');
    this.badgeEl = $('#player-badge');
    this.bigPlay = $('#player-big-play');
    this.playBtn = $('#player-play-btn');
    this.spinner = $('#player-spinner');
    this.errorBox = $('#player-error');
    this.errorText = $('#player-error-text');
    this.directBtn = $('#player-direct-btn');
    this.seek = $('#seek');
    this.seekInput = $('#seek-input');
    this.seekPlayed = $('#seek-played');
    this.seekBuffered = $('#seek-buffered');
    this.seekThumb = $('#seek-thumb');
    this.timeEl = $('#player-time');
    this.volumeInput = $('#player-volume');
    this.muteBtn = $('#player-mute-btn');
    this.subtitleBtn = $('#player-subtitle-btn');
    this.qualityBtn = $('#player-quality-btn');
    this.fsBtn = $('#player-fs-btn');
    this.subtitleMenu = $('#player-subtitle-menu');
    this.qualityMenu = $('#player-quality-menu');
    this.playerToast = $('#player-toast');
    this.endScreen = $('#player-end');
    this.endTitle = $('#player-end-title');
    this.endSub = $('#player-end-sub');
    this.endActions = $('#player-end-actions');
  }

  bind() {
    this.root.addEventListener('click', (event) => {
      const target = event.target.closest('[data-p]');
      if (!target) {
        if (event.target === this.video) this.toggle();
        return;
      }
      const action = target.dataset.p;
      if (action === 'close') this.close();
      else if (action === 'toggle') this.toggle();
      else if (action === 'back10') this.skip(-10);
      else if (action === 'forward10') this.skip(10);
      else if (action === 'mute') this.toggleMute();
      else if (action === 'subtitles') this.toggleSubtitleMenu();
      else if (action === 'quality') this.toggleQualityMenu();
      else if (action === 'pip') this.togglePip();
      else if (action === 'fullscreen') this.toggleFullscreen();
      else if (action === 'retry') this.retry();
      else if (action === 'direct') this.useDirect();
      else if (action === 'next') this.playNext();
      else if (action === 'replay') this.replay();
    });

    this.el.addEventListener('mousemove', () => this.wake());
    this.el.addEventListener('mouseleave', () => this.scheduleHide());

    this.video.addEventListener('loadedmetadata', () => {
      this.applyResume();
      this.applySubtitleMode();
      this.syncTime();
      this.hideSpinner();
    });
    this.video.addEventListener('durationchange', () => this.syncTime());
    this.video.addEventListener('timeupdate', () => {
      if (!this.dragging) this.syncTime();
      this.maybeReport();
    });
    this.video.addEventListener('progress', () => this.syncBuffered());
    this.video.addEventListener('play', () => {
      this.endScreen.hidden = true;
      this.el.classList.remove('idle');
      this.updatePlayState();
      this.scheduleHide();
      this.ensureReportTimer();
    });
    this.video.addEventListener('pause', () => {
      this.updatePlayState();
      this.showControls();
      this.report(true);
    });
    this.video.addEventListener('waiting', () => this.showSpinner());
    this.video.addEventListener('playing', () => {
      this.hideSpinner();
      this.el.classList.remove('idle');
      this.updatePlayState();
    });
    this.video.addEventListener('canplay', () => {
      this.hideSpinner();
      if (this.autoplay && this.video.paused) {
        this.autoplay = false;
        this.tryPlay();
      }
    });
    this.video.addEventListener('seeked', () => {
      this.syncTime();
      if (this.video.paused) this.showControls();
    });
    this.video.addEventListener('ended', () => this.onEnded());
    this.video.addEventListener('error', () => {
      if (this.mode === 'direct' && this.visible && this.video.error) {
        this.showError('浏览器无法直接播放这个文件，可能需要转码。');
      }
    });
    this.video.addEventListener('volumechange', () => this.syncVolume());

    this.seekInput.addEventListener('pointerdown', () => {
      this.dragging = true;
      this.seek.classList.add('dragging');
    });
    this.seekInput.addEventListener('input', () => {
      this.dragging = true;
      const duration = this.video.duration || this.playData?.duration || 0;
      this.dragValue = (Number(this.seekInput.value) / 1000) * duration;
      this.paintSeek(this.dragValue, duration);
      this.timeEl.textContent = `${formatTime(this.dragValue)} / ${formatTime(duration)}`;
    });
    this.seekInput.addEventListener('change', () => {
      this.commitSeek(Number(this.seekInput.value));
      this.endDrag();
    });
    this.seekInput.addEventListener('pointerup', () => {
      if (this.dragging) this.commitSeek(Number(this.seekInput.value));
      this.endDrag();
    });
    this.seekInput.addEventListener('keyup', () => {
      if (this.dragging) this.commitSeek(Number(this.seekInput.value));
      this.endDrag();
    });

    this.volumeInput.addEventListener('input', () => {
      this.video.volume = Number(this.volumeInput.value);
      this.video.muted = this.video.volume === 0;
      this.persistVolume();
    });

    document.addEventListener('fullscreenchange', () => this.syncFullscreenIcon());
    document.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('pagehide', () => this.report(true, true));

    const savedVolume = Number(localStorage.getItem('lumina.volume'));
    this.video.volume = Number.isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 1
      ? savedVolume
      : 0.9;
    this.volumeInput.value = String(this.video.volume);
  }

  // ------------------------------------------------------------------ open

  async open(id, { autoplay = true } = {}) {
    if (!id) return;
    // Keep a history entry while the player is open so the phone's back
    // gesture closes the player instead of leaving the page.
    if (!this.historyPushed) {
      history.pushState({ ...(history.state || {}), luminaPlayer: true }, '', location.href);
      this.historyPushed = true;
    }
    this.loadToken += 1;
    const token = this.loadToken;
    this.visible = true;
    this.currentId = id;
    this.autoplay = autoplay;
    this.forceDirect = false;
    this.resumeApplied = false;
    this.resumeTarget = 0;
    this.lastReportAt = 0;
    this.destroyHls();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.clearTracks();

    this.el.hidden = false;
    document.body.classList.add('player-open');
    this.el.classList.remove('idle');
    this.endScreen.hidden = true;
    this.errorBox.hidden = true;
    this.subtitleMenu.hidden = true;
    this.qualityMenu.hidden = true;
    this.menuOpen = false;
    this.showSpinner();
    this.updatePlayState();
    this.titleEl.textContent = '正在载入…';
    this.subtitleEl.textContent = '';
    this.badgeEl.textContent = '载入中';
    this.timeEl.textContent = '0:00 / 0:00';
    this.paintSeek(0, 0);

    let data;
    try {
      data = await api(`/api/play/${id}`);
    } catch (err) {
      if (token !== this.loadToken || !this.visible) return;
      this.showError(err.message || '无法获取播放信息');
      return;
    }
    if (token !== this.loadToken || !this.visible) return;

    this.playData = data;
    this.titleEl.textContent = data.title || data.item?.title || '正在播放';
    this.subtitleEl.textContent = data.subtitle || data.item?.fileName || '';
    this.duration = Number(data.duration) || 0;

    if (data.progress && !data.progress.completed) {
      const pos = Number(data.progress.position) || 0;
      if (pos > 5 && (!this.duration || pos < this.duration * 0.95)) {
        this.resumeTarget = pos;
      }
    }

    this.buildTracks();

    const direct = data.direct;
    const hls = data.hls;
    if (direct?.compatible) {
      this.startDirect(direct.url);
    } else if (hls && this.canPlayHls()) {
      this.qualities = Array.isArray(hls.qualities) && hls.qualities.length
        ? hls.qualities
        : [720];
      this.quality = this.qualities[0];
      this.startHls(this.quality);
    } else if (direct?.url) {
      this.startDirect(direct.url);
    } else {
      this.showError('这个视频需要转码，但当前无法建立 HLS 播放。');
    }
    this.buildMenus();
  }

  canPlayHls() {
    return Boolean(window.Hls && window.Hls.isSupported());
  }

  startDirect(url) {
    this.mode = 'direct';
    this.badgeEl.textContent = '直连';
    this.qualities = [];
    this.quality = null;
    this.updateQualityButton();
    this.video.src = url;
    this.video.load();
    this.syncVolume();
  }

  startHls(quality) {
    this.mode = 'hls';
    this.quality = quality;
    this.updateQualityButton();
    this.destroyHls();
    this.badgeEl.textContent = `${quality}p`;

    const base = this.playData?.hls?.url;
    if (!base) {
      this.showError('缺少 HLS 播放地址。');
      return;
    }
    const url = `${base}?q=${quality}`;

    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 60,
        backBufferLength: 30,
        manifestLoadingTimeOut: 20_000,
        levelLoadingTimeOut: 30_000,
        fragLoadingTimeOut: 60_000,
      });
      this.hls = hls;
      let recovered = 0;
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        this.applyResume();
        this.applySubtitleMode();
        if (this.autoplay) {
          this.autoplay = false;
          this.tryPlay();
        }
      });
      hls.on(window.Hls.Events.FRAG_LOADED, () => this.hideSpinner());
      hls.on(window.Hls.Events.ERROR, (event, data) => {
        if (!data.fatal) {
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) this.showSpinner();
          return;
        }
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && recovered < 1) {
          recovered += 1;
          hls.startLoad();
          return;
        }
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && recovered < 1) {
          recovered += 1;
          hls.recoverMediaError();
          return;
        }
        this.showError(`转码播放失败：${data.details || data.type || '未知错误'}`);
      });
      hls.loadSource(url);
      hls.attachMedia(this.video);
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.video.src = url;
      this.video.load();
    } else {
      this.showError('当前浏览器不支持 HLS 播放，请使用 Chrome、Edge 或 Safari。');
    }
  }

  destroyHls() {
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* ignore */
      }
      this.hls = null;
    }
  }

  applyResume() {
    if (this.resumeApplied) return;
    this.resumeApplied = true;
    const duration = Number(this.video.duration) || this.duration || 0;
    const target = this.resumeTarget;
    if (target > 2 && (!duration || target < duration - 3)) {
      try {
        this.video.currentTime = target;
      } catch {
        /* ignore */
      }
      this.toast(`已从 ${formatTime(target)} 继续播放`);
    }
    this.resumeTarget = 0;
  }

  tryPlay() {
    const promise = this.video.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {
        this.hideSpinner();
        this.updatePlayState();
        this.showControls();
      });
    }
  }

  // --------------------------------------------------------------- controls

  toggle() {
    if (!this.visible) return;
    this.wake();
    if (this.video.paused) this.tryPlay();
    else this.video.pause();
  }

  skip(seconds) {
    if (!Number.isFinite(this.video.duration)) return;
    this.video.currentTime = Math.min(
      Math.max(0, this.video.currentTime + seconds),
      this.video.duration - 0.1,
    );
    this.wake();
  }

  commitSeek(value) {
    const duration = this.video.duration || this.playData?.duration || 0;
    if (!duration) return;
    const time = (Math.min(1000, Math.max(0, value)) / 1000) * duration;
    try {
      this.video.currentTime = time;
    } catch {
      /* ignore */
    }
    this.syncTime();
    this.wake();
  }

  endDrag() {
    this.dragging = false;
    this.seek.classList.remove('dragging');
  }

  paintSeek(current, duration) {
    const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
    this.seekPlayed.style.width = `${pct}%`;
    this.seekThumb.style.left = `${pct}%`;
    if (document.activeElement !== this.seekInput) {
      this.seekInput.value = String(Math.round(pct * 10));
    }
  }

  syncTime() {
    const duration = Number(this.video.duration) || this.duration || 0;
    const current = Number(this.video.currentTime) || 0;
    this.paintSeek(current, duration);
    this.timeEl.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  }

  syncBuffered() {
    const duration = this.video.duration || 0;
    if (!duration) return;
    let end = 0;
    const buffered = this.video.buffered;
    for (let i = 0; i < buffered.length; i += 1) {
      if (buffered.start(i) <= this.video.currentTime + 0.5) end = buffered.end(i);
    }
    this.seekBuffered.style.width = `${Math.min(100, (end / duration) * 100)}%`;
  }

  updatePlayState() {
    const paused = this.video.paused;
    this.playBtn.innerHTML = icon(paused ? 'play' : 'pause', paused ? 'fill' : 'fill');
    this.bigPlay.hidden = !paused || !this.spinner.hidden;
    if (paused) {
      this.showControls();
    }
  }

  syncVolume() {
    const volume = this.video.muted ? 0 : this.video.volume;
    this.volumeInput.value = String(volume);
    this.muteBtn.innerHTML = icon(this.video.muted || volume === 0 ? 'mute' : 'volume');
    this.muteBtn.classList.toggle('active', this.video.muted);
  }

  persistVolume() {
    try {
      localStorage.setItem('lumina.volume', String(this.video.volume));
    } catch {
      /* ignore */
    }
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    if (!this.video.muted && this.video.volume === 0) this.video.volume = 0.6;
    this.persistVolume();
    this.wake();
  }

  showSpinner() {
    if (!this.errorBox.hidden) return;
    this.spinner.hidden = false;
    this.bigPlay.hidden = true;
  }

  hideSpinner() {
    this.spinner.hidden = true;
    this.updatePlayState();
  }

  wake() {
    this.el.classList.remove('idle');
    this.scheduleHide();
  }

  showControls() {
    this.el.classList.remove('idle');
    if (this.hideTimer) clearTimeout(this.hideTimer);
  }

  scheduleHide() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.video.paused || this.menuOpen || !this.endScreen.hidden) return;
    this.hideTimer = setTimeout(() => {
      if (!this.video.paused && !this.menuOpen && this.endScreen.hidden) {
        this.el.classList.add('idle');
      }
    }, HIDE_DELAY);
  }

  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      this.el.requestFullscreen?.().catch(() => {
        this.toast('当前环境不支持全屏');
      });
    }
    this.wake();
  }

  syncFullscreenIcon() {
    const active = Boolean(document.fullscreenElement);
    this.fsBtn.innerHTML = icon(active ? 'exit-fullscreen' : 'fullscreen');
  }

  togglePip() {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
      return;
    }
    if (this.video.requestPictureInPicture) {
      this.video.requestPictureInPicture().catch(() => this.toast('当前浏览器不允许画中画'));
    } else {
      this.toast('当前浏览器不支持画中画');
    }
  }

  // ---------------------------------------------------------------- subtitles

  clearTracks() {
    for (const track of Array.from(this.video.querySelectorAll('track'))) track.remove();
    this.tracks = [];
    this.subtitleIndex = -1;
  }

  buildTracks() {
    this.clearTracks();
    this.tracks = this.playData?.subtitles || [];
    for (const track of this.tracks) {
      const el = document.createElement('track');
      el.kind = 'subtitles';
      el.label = track.label || '字幕';
      el.srclang = track.lang || 'und';
      el.src = `/api/subtitles/${this.currentId}/${track.id}`;
      el.default = false;
      this.video.appendChild(el);
    }
    const preferred = localStorage.getItem('lumina.subtitle.lang');
    if (preferred) {
      const index = this.tracks.findIndex((t) => t.lang === preferred);
      if (index >= 0) this.subtitleIndex = index;
    }
    this.applySubtitleMode();
  }

  applySubtitleMode() {
    const tracks = this.video.textTracks;
    for (let i = 0; i < tracks.length; i += 1) {
      tracks[i].mode = i === this.subtitleIndex ? 'showing' : 'disabled';
    }
    this.subtitleBtn.classList.toggle('active', this.subtitleIndex >= 0);
    this.subtitleBtn.querySelector('span').textContent = this.subtitleIndex >= 0 ? '字幕开' : '字幕';
  }

  selectSubtitle(index) {
    this.subtitleIndex = index;
    this.applySubtitleMode();
    if (index >= 0 && this.tracks[index]?.lang) {
      try {
        localStorage.setItem('lumina.subtitle.lang', this.tracks[index].lang);
      } catch {
        /* ignore */
      }
    }
    this.closeMenus();
    this.wake();
  }

  toggleSubtitleMenu() {
    const willOpen = this.subtitleMenu.hidden;
    this.closeMenus();
    if (!willOpen) return;
    this.qualityMenu.hidden = true;
    this.subtitleMenu.hidden = false;
    this.menuOpen = true;
    this.showControls();
  }

  // ------------------------------------------------------------------ quality

  buildMenus() {
    const subtitleItems = [
      `<button data-subtitle="-1" class="${this.subtitleIndex < 0 ? 'active' : ''}"><span class="menu-label">关闭字幕</span>${icon('check')}</button>`,
      ...this.tracks.map((track, index) => (
        `<button data-subtitle="${index}" class="${this.subtitleIndex === index ? 'active' : ''}"><span class="menu-label">${esc(track.label)}</span>${icon('check')}</button>`
      )),
    ];
    this.subtitleMenu.innerHTML = `<div class="menu-title">字幕</div>${subtitleItems.join('')}`;
    this.subtitleMenu.querySelectorAll('[data-subtitle]').forEach((btn) => {
      btn.addEventListener('click', () => this.selectSubtitle(Number(btn.dataset.subtitle)));
    });

    const list = this.mode === 'hls' && this.qualities.length
      ? this.qualities.map((q) => (
        `<button data-quality="${q}" class="${this.quality === q ? 'active' : ''}"><span class="menu-label">${q}p</span>${icon('check')}</button>`
      ))
      : [`<button data-quality="direct" class="active"><span class="menu-label">原画（直连）</span>${icon('check')}</button>`];
    this.qualityMenu.innerHTML = `<div class="menu-title">画质</div>${list.join('')}`;
    this.qualityMenu.querySelectorAll('[data-quality]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.quality;
        this.closeMenus();
        if (value === 'direct') return;
        this.switchQuality(Number(value));
      });
    });
    this.updateQualityButton();
  }

  updateQualityButton() {
    const label = this.mode === 'hls' && this.quality ? `${this.quality}p` : '原画';
    this.qualityBtn.querySelector('span').textContent = label;
    this.badgeEl.textContent = this.mode === 'hls' && this.quality ? `${this.quality}p` : '直连';
  }

  toggleQualityMenu() {
    const willOpen = this.qualityMenu.hidden;
    this.closeMenus();
    if (!willOpen) return;
    this.subtitleMenu.hidden = true;
    this.qualityMenu.hidden = false;
    this.menuOpen = true;
    this.showControls();
  }

  closeMenus() {
    this.subtitleMenu.hidden = true;
    this.qualityMenu.hidden = true;
    this.menuOpen = false;
  }

  switchQuality(quality) {
    if (!this.visible || this.mode !== 'hls' || quality === this.quality) return;
    const time = this.video.currentTime;
    const wasPlaying = !this.video.paused;
    this.quality = quality;
    this.buildMenus();
    this.startHls(quality);
    const applyTime = () => {
      if (time > 0) {
        try {
          this.video.currentTime = time;
        } catch {
          /* ignore */
        }
      }
      this.video.removeEventListener('loadedmetadata', applyTime);
    };
    this.video.addEventListener('loadedmetadata', applyTime);
    if (wasPlaying) this.autoplay = true;
    this.toast(`已切换到 ${quality}p`);
    this.wake();
  }

  // ------------------------------------------------------------------ errors

  showError(message) {
    this.hideSpinner();
    this.errorText.textContent = message || '播放时发生未知错误。';
    this.directBtn.hidden = !(this.playData?.direct?.compatible && this.mode !== 'direct');
    this.errorBox.hidden = false;
    this.el.classList.remove('idle');
    this.showControls();
  }

  retry() {
    if (!this.currentId) return;
    this.errorBox.hidden = true;
    this.open(this.currentId, { autoplay: true });
  }

  useDirect() {
    if (!this.currentId) return;
    this.forceDirect = true;
    this.errorBox.hidden = true;
    this.open(this.currentId, { autoplay: true });
  }

  // ------------------------------------------------------------------- ended

  onEnded() {
    this.report(true);
    this.el.classList.remove('idle');
    this.showControls();
    const next = this.playData?.next;
    this.endTitle.textContent = next
      ? `下一集：${next.title}`
      : (this.playData?.item?.kind === 'episode' ? '本集播放结束' : '播放结束');
    this.endSub.textContent = next
      ? `${next.season ? `第 ${next.season} 季 · ` : ''}${episodeCode(next.season, next.episode)}`
      : '感谢观看';
    this.endActions.innerHTML = `
      ${next ? `<button class="btn btn-primary btn-sm" data-p="next">${icon('next', 'fill')}播放下一集</button>` : ''}
      <button class="btn btn-ghost btn-sm" data-p="replay">${icon('replay')}重新播放</button>
      <button class="btn btn-ghost btn-sm" data-p="close">${icon('close')}关闭</button>`;
    this.endScreen.hidden = false;
  }

  playNext() {
    const next = this.playData?.next;
    if (!next) return;
    this.open(next.id, { autoplay: true });
  }

  replay() {
    this.endScreen.hidden = true;
    this.video.currentTime = 0;
    this.tryPlay();
  }

  // ---------------------------------------------------------------- progress

  ensureReportTimer() {
    if (this.reportTimer) return;
    this.reportTimer = setInterval(() => {
      if (this.visible && !this.video.paused) this.report();
    }, REPORT_INTERVAL);
  }

  maybeReport() {
    if (!this.visible) return;
    if (Date.now() - this.lastReportAt < REPORT_INTERVAL) return;
    if (this.video.paused) return;
    this.report();
  }

  report(force = false, useBeacon = false) {
    if (!this.currentId || !this.playData) return;
    if (!force && Date.now() - this.lastReportAt < 3000) return;
    const duration = Number(this.video.duration) || Number(this.playData.duration) || 0;
    const position = this.video.ended ? duration : Number(this.video.currentTime) || 0;
    if (!duration && !position) return;
    this.lastReportAt = Date.now();
    const payload = JSON.stringify({
      id: this.currentId,
      position,
      duration: Math.max(duration, position),
      completed: this.video.ended || (duration > 0 && position / duration >= 0.95),
    });
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon('/api/progress', new Blob([payload], { type: 'application/json' }));
      return;
    }
    api('/api/progress', { method: 'POST', body: payload })
      .then((res) => {
        if (res?.progress) this.onProgress(this.currentId, res.progress);
      })
      .catch(() => {});
  }

  // ------------------------------------------------------------------ close

  close({ fromHistory = false } = {}) {
    if (!this.visible) return;
    const popHistory = !fromHistory && this.historyPushed && history.state?.luminaPlayer;
    this.historyPushed = false;
    this.loadToken += 1;
    this.report(true);
    this.destroyHls();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.clearTracks();
    this.visible = false;
    this.el.hidden = true;
    this.endScreen.hidden = true;
    this.errorBox.hidden = true;
    this.closeMenus();
    document.body.classList.remove('player-open');
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.currentId = null;
    this.playData = null;
    this.onClose();
    if (popHistory) history.back();
  }

  // ---------------------------------------------------------------- keyboard

  onKeyDown(event) {
    if (!this.visible) return;
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    this.wake();

    switch (event.code) {
      case 'Space':
      case 'KeyK':
        event.preventDefault();
        this.toggle();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this.skip(-10);
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.skip(10);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.video.volume = Math.min(1, this.video.volume + 0.1);
        this.video.muted = false;
        this.persistVolume();
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.video.volume = Math.max(0, this.video.volume - 0.1);
        this.persistVolume();
        break;
      case 'KeyF':
        event.preventDefault();
        this.toggleFullscreen();
        break;
      case 'KeyM':
        event.preventDefault();
        this.toggleMute();
        break;
      case 'KeyN':
        if (this.playData?.next) {
          event.preventDefault();
          this.playNext();
        }
        break;
      case 'Escape':
        if (!this.subtitleMenu.hidden || !this.qualityMenu.hidden) {
          event.preventDefault();
          this.closeMenus();
        } else {
          event.preventDefault();
          this.close();
        }
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------- misc

  toast(message) {
    this.playerToast.textContent = message;
    this.playerToast.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.playerToast.classList.remove('show');
    }, 2400);
  }
}
