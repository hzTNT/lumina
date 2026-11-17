// Lumina API smoke test — run with: runtime\node.exe tools\smoke.mjs [baseUrl]
const BASE = (process.argv[2] || process.env.LUMINA_URL || 'http://127.0.0.1:8096').replace(/\/+$/, '');

let passed = 0;
let failed = 0;
const failures = [];

function ok(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

let authCookie = '';

async function rawFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authCookie) headers.Cookie = authCookie;
  return fetch(`${BASE}${path}`, { ...options, headers });
}

async function json(path, options = {}) {
  const res = await rawFetch(path, options);
  const setCookie = res.headers.getSetCookie?.() || [];
  const cookie = setCookie.find((item) => item.startsWith('lumina_session='));
  if (cookie) authCookie = cookie.split(';')[0];
  const body = await res.json().catch(() => null);
  return { res, body };
}

async function login() {
  const username = process.env.LUMINA_USER || 'admin';
  const password = process.env.LUMINA_PASS || 'secret123';
  const status = await json('/api/auth/status');
  if (status.body?.needsSetup) {
    const { res, body } = await json('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, displayName: '管理员', birthDate: '1990-01-01' }),
    });
    ok(res.status === 200 && body?.user?.role === 'admin', 'first-run admin created');
  } else {
    const { res, body } = await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    ok(res.status === 200 && body?.user, 'logged in');
  }
}

async function main() {
  console.log(`Lumina smoke test → ${BASE}\n`);

  console.log('[health]');
  {
    const { res, body } = await json('/api/health');
    ok(res.status === 200 && body?.ok === true, 'health returns ok');
    ok(body?.ffmpeg === true, 'ffmpeg is available', String(body?.ffmpeg));
  }

  console.log('\n[auth]');
  await login();

  console.log('\n[library]');
  const { res: libRes, body: lib } = await json('/api/library');
  ok(libRes.status === 200, 'library returns 200');
  ok(lib?.movies?.length === 2, `movies = 2 (got ${lib?.movies?.length})`);
  ok(lib?.series?.length === 1, `series = 1 (got ${lib?.series?.length})`);
  ok(lib?.series?.[0]?.episodes?.length === 2, 'series has 2 episodes');
  const mp4 = lib?.movies?.find((m) => m.fileName.endsWith('.mp4'));
  const mkv = lib?.movies?.find((m) => m.fileName.endsWith('.mkv'));
  const episode = lib?.series?.[0]?.episodes?.[0];
  ok(mp4?.title === 'Blade Runner 2049', 'MP4 title parsed correctly', mp4?.title);
  ok(mp4?.year === 2017, 'MP4 year parsed correctly', String(mp4?.year));
  ok(mp4?.videoCodec === 'h264', 'MP4 codec probed', mp4?.videoCodec);
  ok(mkv?.title === '星际漫游', 'MKV Chinese title parsed correctly', mkv?.title);
  ok(mkv?.videoCodec === 'hevc', 'HEVC codec probed', mkv?.videoCodec);
  ok(episode?.season === 1 && episode?.episode === 1, 'episode S01E01 parsed');
  ok(episode?.subtitleCount === 2, 'two sidecar subtitles found', String(episode?.subtitleCount));

  console.log('\n[play info]');
  {
    const { res, body } = await json(`/api/play/${mp4.id}`);
    ok(res.status === 200, 'play info 200');
    ok(body?.direct?.compatible === true, 'MP4 direct-play compatible');
    ok(body?.hls?.qualities?.includes(720), 'HLS qualities include 720p');
    ok(body?.duration === 20, 'duration = 20s', String(body?.duration));
  }
  {
    const { body } = await json(`/api/play/${mkv.id}`);
    ok(body?.direct?.compatible === false, 'HEVC MKV requires HLS');
    ok(body?.probe?.videoCodec === 'hevc', 'HEVC probe in play info');
  }

  console.log('\n[range stream]');
  {
    const res = await rawFetch(`/api/stream/${mp4.id}`, {
      headers: { Range: 'bytes=0-1023' },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    ok(res.status === 206, 'range status 206', String(res.status));
    ok(buf.length === 1024, 'range body length 1024', String(buf.length));
    ok(/^bytes 0-1023\//.test(res.headers.get('content-range') || ''),
      'content-range header', res.headers.get('content-range'));
    ok((res.headers.get('content-type') || '').startsWith('video/mp4'),
      'stream content-type', res.headers.get('content-type'));
  }

  console.log('\n[art]');
  for (const [id, type] of [[mp4.id, 'poster'], [mp4.id, 'backdrop'], [episode.id, 'thumb']]) {
    const res = await rawFetch(`/api/art/${id}?type=${type}`);
    const buf = Buffer.from(await res.arrayBuffer());
    ok(res.status === 200 && buf.length > 1000, `${type} art served (${buf.length} bytes)`);
    ok((res.headers.get('content-type') || '').startsWith('image/'),
      `${type} art is an image`, res.headers.get('content-type'));
  }

  console.log('\n[subtitles]');
  {
    const { body } = await json(`/api/play/${episode.id}`);
    ok(body?.subtitles?.length === 2, 'play info exposes 2 subtitle tracks');
    const labels = body?.subtitles?.map((s) => s.label).join(',');
    ok(labels.includes('中文') && labels.includes('English'), 'subtitle languages labelled', labels);
    const chinese = body?.subtitles?.find((s) => s.lang === 'zh' || s.label?.includes('中文'));
    ok(Boolean(chinese?.id), 'Chinese subtitle track has an id', chinese?.id);
    if (chinese?.id) {
      const res = await rawFetch(`/api/subtitles/${episode.id}/${chinese.id}`);
      const text = await res.text();
      ok(res.status === 200, 'subtitle 200');
      ok((res.headers.get('content-type') || '').startsWith('text/vtt'), 'subtitle is WebVTT');
      ok(text.startsWith('WEBVTT'), 'subtitle starts with WEBVTT');
      ok(text.includes('欢迎来到 Lumina 微光影库'), 'Chinese subtitle decoded correctly');
    }
  }

  console.log('\n[hls]');
  {
    const res = await rawFetch(`/api/hls/${episode.id}/master.m3u8?q=720`);
    const text = await res.text();
    ok(res.status === 200, 'playlist 200');
    ok(text.startsWith('#EXTM3U'), 'playlist has #EXTM3U');
    ok(text.includes('#EXT-X-ENDLIST'), 'playlist is VOD');
    ok(text.includes('0.ts?q=720'), 'playlist references segment 0 at q=720');
  }
  {
    const started = Date.now();
    const res = await rawFetch(`/api/hls/${episode.id}/0.ts?q=720`);
    const buf = Buffer.from(await res.arrayBuffer());
    ok(res.status === 200, 'segment 200');
    ok(buf.length > 10_000, `segment generated (${buf.length} bytes)`);
    ok((res.headers.get('content-type') || '') === 'video/mp2t', 'segment content-type video/mp2t');
    console.log(`         segment took ${((Date.now() - started) / 1000).toFixed(2)}s`);
  }

  console.log('\n[progress]');
  {
    const { res } = await json('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: episode.id, position: 5.5, duration: 12.02 }),
    });
    ok(res.status === 200, 'progress write 200');
    const { body } = await json('/api/progress');
    ok(body?.progress?.[episode.id]?.position === 5.5, 'progress persisted');
    const { body: play } = await json(`/api/play/${episode.id}`);
    ok(play?.progress?.position === 5.5, 'play info includes resume position');
  }

  console.log('\n[settings]');
  {
    const { res, body } = await json('/api/settings');
    ok(res.status === 200 && Array.isArray(body?.mediaDirs), 'settings returns mediaDirs');
    ok(body?.lan?.length >= 1, 'LAN addresses reported');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`failed: ${failures.join(' | ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
