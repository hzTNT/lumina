import fs from 'node:fs';
import path from 'node:path';

const LANG_MAP = {
  zh: { lang: 'zh', label: '中文' },
  chi: { lang: 'zh', label: '中文' },
  zho: { lang: 'zh', label: '中文' },
  chs: { lang: 'zh', label: '简体中文' },
  sc: { lang: 'zh', label: '简体中文' },
  cn: { lang: 'zh', label: '简体中文' },
  'zh-cn': { lang: 'zh-CN', label: '简体中文' },
  'zh-sg': { lang: 'zh-CN', label: '简体中文' },
  'zh-hans': { lang: 'zh-CN', label: '简体中文' },
  简体: { lang: 'zh', label: '简体中文' },
  简中: { lang: 'zh', label: '简体中文' },
  简体中文: { lang: 'zh', label: '简体中文' },
  cht: { lang: 'zh-TW', label: '繁體中文' },
  tc: { lang: 'zh-TW', label: '繁體中文' },
  'zh-tw': { lang: 'zh-TW', label: '繁體中文' },
  'zh-hk': { lang: 'zh-TW', label: '繁體中文' },
  'zh-hant': { lang: 'zh-TW', label: '繁體中文' },
  繁体: { lang: 'zh-TW', label: '繁體中文' },
  繁中: { lang: 'zh-TW', label: '繁體中文' },
  繁體中文: { lang: 'zh-TW', label: '繁體中文' },
  en: { lang: 'en', label: 'English' },
  eng: { lang: 'en', label: 'English' },
  english: { lang: 'en', label: 'English' },
  ja: { lang: 'ja', label: '日本語' },
  jpn: { lang: 'ja', label: '日本語' },
  jp: { lang: 'ja', label: '日本語' },
  ko: { lang: 'ko', label: '한국어' },
  kor: { lang: 'ko', label: '한국어' },
  fr: { lang: 'fr', label: 'Français' },
  fre: { lang: 'fr', label: 'Français' },
  fra: { lang: 'fr', label: 'Français' },
  de: { lang: 'de', label: 'Deutsch' },
  ger: { lang: 'de', label: 'Deutsch' },
  deu: { lang: 'de', label: 'Deutsch' },
  es: { lang: 'es', label: 'Español' },
  spa: { lang: 'es', label: 'Español' },
  ru: { lang: 'ru', label: 'Русский' },
  rus: { lang: 'ru', label: 'Русский' },
  pt: { lang: 'pt', label: 'Português' },
  por: { lang: 'pt', label: 'Português' },
  it: { lang: 'it', label: 'Italiano' },
  ita: { lang: 'it', label: 'Italiano' },
  th: { lang: 'th', label: 'ไทย' },
  tha: { lang: 'th', label: 'ไทย' },
  vi: { lang: 'vi', label: 'Tiếng Việt' },
  vie: { lang: 'vi', label: 'Tiếng Việt' },
};

export function languageInfo(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return null;
  if (LANG_MAP[key]) return LANG_MAP[key];
  const compact = key.replace(/_/g, '-');
  if (LANG_MAP[compact]) return LANG_MAP[compact];
  for (const part of key.split(/[.\-_\s]+/)) {
    if (LANG_MAP[part]) return LANG_MAP[part];
  }
  if (/^zh[-_]?(cn|sg|hans)/i.test(key)) return LANG_MAP['zh-cn'];
  if (/^zh[-_]?(tw|hk|hant)/i.test(key)) return LANG_MAP['zh-tw'];
  if (/^zh/i.test(key)) return LANG_MAP.zh;
  return null;
}

export function languageFromSuffix(rest) {
  const raw = String(rest || '').replace(/^[.\s_-]+/, '');
  if (!raw) return null;
  const cleaned = raw.replace(/\.(forced|default|sdh|cc|hi)$/i, '').trim();
  return languageInfo(cleaned) || languageInfo(cleaned.split(/[.\s_-]+/).filter(Boolean)[0] || '');
}

export function isForcedSuffix(rest) {
  return /(?:^|[.\s_-])forced(?:[.\s_-]|$)/i.test(String(rest || ''));
}

export function decodeSubtitleBuffer(buffer) {
  if (!buffer || !buffer.length) return '';

  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(buffer);
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(buffer);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // Many Chinese subtitle files are GBK/GB18030 or Big5. Pick the decode
    // that yields the most CJK characters and the fewest replacement chars.
    const candidates = [];
    for (const encoding of ['gb18030', 'big5']) {
      try {
        const text = new TextDecoder(encoding, { fatal: false }).decode(buffer);
        const bad = (text.match(/\uFFFD/g) || []).length;
        const cjk = (text.match(/[\u3400-\u9FFF]/g) || []).length;
        candidates.push({ text, score: cjk - bad * 6 });
      } catch {
        // ignore unsupported encoding
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.text || new TextDecoder('utf-8').decode(buffer);
  }
}

export function srtToVtt(input) {
  let text = String(input || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (/^\s*WEBVTT/.test(text)) return text;
  text = text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  text = text.replace(/(\d{1,2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${text.trim()}\n`;
}

/**
 * Make sure a WebVTT file exists for the requested track.
 */
export async function ensureVtt({ item, track, tools, outDir }) {
  await fs.promises.mkdir(outDir, { recursive: true });
  const cacheFile = path.join(outDir, `${item.id}-${track.id}-${item.mtime}.vtt`);
  const existing = await fs.promises.stat(cacheFile).catch(() => null);
  if (existing && existing.size > 0) return cacheFile;

  const tmp = `${cacheFile}.part`;
  try {
    if (track.kind === 'sidecar') {
      const buffer = await fs.promises.readFile(track.file);
      if (track.ext === '.vtt') {
        await fs.promises.writeFile(tmp, decodeSubtitleBuffer(buffer), 'utf8');
      } else if (track.ext === '.srt') {
        await fs.promises.writeFile(tmp, srtToVtt(decodeSubtitleBuffer(buffer)), 'utf8');
      } else {
        if (!tools.available) throw new Error('需要 ffmpeg 转换 ASS/SSA 字幕');
        await tools.convertSubtitleFile(track.file, tmp);
      }
    } else if (track.kind === 'embedded') {
      if (!tools.available) throw new Error('需要 ffmpeg 提取内嵌字幕');
      await tools.extractEmbeddedSubtitle(item.filePath, track.streamIndex, tmp);
    } else {
      throw new Error('未知字幕类型');
    }
    const stat = await fs.promises.stat(tmp).catch(() => null);
    if (!stat || stat.size === 0) throw new Error('字幕内容为空');
    await fs.promises.rename(tmp, cacheFile);
    return cacheFile;
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}
