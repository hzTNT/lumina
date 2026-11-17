import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'ttml']);

export class MediaTools {
  constructor(config) {
    this.ffmpeg = config.ffmpegResolved;
    this.ffprobe = config.ffprobeResolved;
    this.available = false;
    this.ffprobeAvailable = false;
    this.version = '';
  }

  async init() {
    try {
      const out = await this.run(this.ffmpeg, ['-version'], { timeout: 8000 });
      this.version = out.stdout.split(/\r?\n/)[0] || 'ffmpeg';
      this.available = true;
    } catch (err) {
      console.warn(`[ffmpeg] 未找到可用的 ffmpeg：${err.message}`);
      console.warn('[ffmpeg] 将只能直接播放浏览器原生支持的 MP4/WebM。');
    }
    try {
      await this.run(this.ffprobe, ['-version'], { timeout: 8000 });
      this.ffprobeAvailable = true;
    } catch {
      this.ffprobeAvailable = false;
    }
    return this.available;
  }

  run(bin, args, { timeout = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        reject(err);
        return;
      }
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, timeout);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 24 * 1024 * 1024) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 128 * 1024) stderr = stderr.slice(-128 * 1024);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && !timedOut) {
          resolve({ stdout, stderr });
          return;
        }
        const reason = timedOut ? '超时' : `退出码 ${code}`;
        reject(new Error(`${path.basename(bin)} ${reason}: ${stderr.slice(-1500).trim()}`));
      });
    });
  }

  async probe(file) {
    if (!this.ffprobeAvailable) return null;
    const { stdout } = await this.run(this.ffprobe, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      file,
    ], { timeout: 45000 });

    let json;
    try {
      json = JSON.parse(stdout);
    } catch {
      throw new Error(`ffprobe 输出无法解析：${file}`);
    }

    const streams = json.streams || [];
    const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic))
      || streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const subtitleStreams = streams
      .filter((s) => s.codec_type === 'subtitle' && TEXT_SUB_CODECS.has(String(s.codec_name).toLowerCase()))
      .map((s) => ({
        index: s.index,
        codec: s.codec_name,
        lang: s.tags?.language || '',
        title: s.tags?.title || '',
        forced: Boolean(s.disposition?.forced),
      }));

    let width = Number(video?.width) || 0;
    let height = Number(video?.height) || 0;
    const rotation = Number(
      video?.tags?.rotate
      || (Array.isArray(video?.side_data_list)
        ? video.side_data_list.find((sd) => sd.rotation != null)?.rotation
        : 0)
      || 0,
    );
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];

    const duration = Number(json.format?.duration)
      || Number(video?.duration)
      || 0;

    return {
      duration: Number.isFinite(duration) ? duration : 0,
      width,
      height,
      videoCodec: video?.codec_name || '',
      audioCodec: audio?.codec_name || '',
      container: String(json.format?.format_name || '').split(',')[0],
      formatName: String(json.format?.format_name || ''),
      bitrate: Number(json.format?.bit_rate) || 0,
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      subtitleStreams,
    };
  }

  /**
   * Extract one representative frame as a JPG.
   */
  async generateImage(file, type, outPath, duration = 0) {
    const dims = {
      poster: [480, 720],
      backdrop: [1280, 720],
      thumb: [480, 270],
    }[type] || [480, 720];

    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    const [w, h] = dims;
    const percent = type === 'backdrop' ? 0.32 : 0.22;
    const seek = duration > 2 ? Math.min(duration * percent, 300) : 0;
    const filter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;

    const attempts = seek > 0 ? [seek, 0] : [0];
    let lastError = null;
    for (const ss of attempts) {
      const tmp = `${outPath}.part.jpg`;
      try {
        await this.run(this.ffmpeg, [
          '-hide_banner', '-loglevel', 'error',
          '-ss', ss.toFixed(2),
          '-i', file,
          '-frames:v', '1',
          '-vf', filter,
          '-q:v', '4',
          '-an', '-sn',
          '-y', tmp,
        ], { timeout: 45000 });
        const stat = await fs.promises.stat(tmp).catch(() => null);
        if (stat && stat.size > 0) {
          await fs.promises.rename(tmp, outPath);
          return outPath;
        }
      } catch (err) {
        lastError = err;
      }
      await fs.promises.unlink(tmp).catch(() => {});
    }
    throw lastError || new Error(`无法生成封面：${path.basename(file)}`);
  }

  /**
   * Encode one HLS segment on demand. Writes to a temp file and renames so a
   * half-written segment can never be served.
   */
  async transcodeSegment({ file, outPath, start, duration, height, segmentSeconds, crf, preset }) {
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    const tmp = outPath.replace(/\.ts$/i, '.part.ts');
    let target = Math.max(144, Math.min(Number(height) || 720, 2160));
    target = target % 2 === 0 ? target : target - 1;

    await this.run(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', start.toFixed(3),
      '-i', file,
      '-t', duration.toFixed(3),
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-sn', '-dn',
      '-vf', `scale=-2:${target}`,
      '-c:v', 'libx264',
      '-preset', preset || 'veryfast',
      '-crf', String(crf ?? 23),
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-g', String(Math.max(24, Math.round((segmentSeconds || 6) * 4))),
      '-c:a', 'aac',
      '-b:a', '160k',
      '-ac', '2',
      '-f', 'mpegts',
      '-y', tmp,
    ], { timeout: 180000 });

    const stat = await fs.promises.stat(tmp).catch(() => null);
    if (!stat || stat.size === 0) {
      await fs.promises.unlink(tmp).catch(() => {});
      throw new Error(`转码分段为空：${start}s`);
    }
    await fs.promises.rename(tmp, outPath);
    return outPath;
  }

  async convertSubtitleFile(input, outPath) {
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await this.run(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-i', input,
      '-map', '0:s:0',
      '-f', 'webvtt',
      '-y', outPath,
    ], { timeout: 60000 });
    return outPath;
  }

  async extractEmbeddedSubtitle(file, streamIndex, outPath) {
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await this.run(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-i', file,
      '-map', `0:${streamIndex}`,
      '-f', 'webvtt',
      '-y', outPath,
    ], { timeout: 60000 });
    return outPath;
  }
}
