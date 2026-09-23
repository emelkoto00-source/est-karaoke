const splitWords = text => String(text || '').trim().split(/\s+/).filter(Boolean);

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseLrcTimestamp(token) {
  const m = String(token).match(/^(\d+):(\d{1,2})(?:[.:](\d{1,3}))?$/);
  if (!m) return null;
  const minutes = Number(m[1]);
  const seconds = Number(m[2]);
  const fracRaw = m[3] || '';
  const fraction = fracRaw ? Number(`0.${fracRaw.padEnd(3, '0').slice(0, 3)}`) : 0;
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return minutes * 60 + seconds + fraction;
}

export function parseLrc(lrc) {
  const lines = [];
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+:\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]+\]/g, '').trim();
    if (!text) continue;
    for (const stamp of stamps) {
      const start = parseLrcTimestamp(stamp[1]);
      if (start != null) lines.push({ start, text });
    }
  }
  lines.sort((a, b) => a.start - b.start);
  return lines;
}

function normalizeWord(word) {
  if (typeof word === 'string') return { text: word };
  if (!word || typeof word !== 'object') return null;
  const text = String(word.text ?? word.word ?? word.value ?? '').trim();
  if (!text) return null;
  return {
    text,
    start: finite(word.start ?? word.startTime ?? word.startSeconds ?? (finite(word.startTimeMs) != null ? Number(word.startTimeMs) / 1000 : null)),
    end: finite(word.end ?? word.endTime ?? word.endSeconds ?? (finite(word.endTimeMs) != null ? Number(word.endTimeMs) / 1000 : null)),
  };
}

function normalizeProviderLine(line) {
  if (Array.isArray(line)) {
    return { start: finite(line[0]), text: String(line[1] ?? '').trim() };
  }
  if (!line || typeof line !== 'object') return null;
  const start = finite(
    line.start ?? line.time ?? line.startTime ?? line.startSeconds ??
    (finite(line.startTimeMs) != null ? Number(line.startTimeMs) / 1000 : null)
  );
  const end = finite(
    line.end ?? line.finish ?? line.endTime ?? line.endSeconds ??
    (finite(line.endTimeMs) != null ? Number(line.endTimeMs) / 1000 : null)
  );
  const text = String(line.text ?? line.lyric ?? line.wordsText ?? line.content ?? '').trim();
  if (start == null || !text) return null;
  const words = Array.isArray(line.words) ? line.words.map(normalizeWord).filter(Boolean) : undefined;
  return { start, end, text, words };
}

function assignWordTiming(line, end) {
  const existing = Array.isArray(line.words) ? line.words.filter(w => w?.text) : [];
  if (existing.length && existing.every(w => Number.isFinite(w.start) && Number.isFinite(w.end))) {
    return existing.map(w => ({
      text: String(w.text),
      start: Math.max(line.start, Number(w.start)),
      end: Math.max(Number(w.start), Number(w.end)),
    }));
  }

  const words = existing.length ? existing.map(w => String(w.text)) : splitWords(line.text);
  if (!words.length) return [];
  const usableEnd = Math.max(line.start + 0.35, Number(end));
  const span = usableEnd - line.start;
  const weights = words.map(word => Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, '').length || word.length || 1));
  const total = weights.reduce((a, b) => a + b, 0) || words.length;
  let cursor = line.start;
  return words.map((text, index) => {
    const share = span * (weights[index] / total);
    const start = cursor;
    cursor += share;
    return { text, start, end: index === words.length - 1 ? usableEnd : cursor };
  });
}

export function finalizeLyrics(lines, duration = 0) {
  const sorted = (Array.isArray(lines) ? lines : [])
    .map(normalizeProviderLine)
    .filter(Boolean)
    .sort((a, b) => a.start - b.start)
    .slice(0, 600);

  for (let i = 0; i < sorted.length; i++) {
    const line = sorted[i];
    const nextStart = sorted[i + 1]?.start;
    let end = Number.isFinite(line.end) ? line.end : null;
    if (!(end > line.start)) {
      if (Number.isFinite(nextStart) && nextStart > line.start) end = nextStart;
      else if (Number.isFinite(duration) && duration > line.start) end = Math.min(duration, line.start + 6);
      else end = line.start + 4;
    }
    end = Math.max(line.start + 0.25, end);
    line.end = end;
    line.words = assignWordTiming(line, end).slice(0, 80);
  }

  return sorted.map(line => ({
    start: Number(line.start.toFixed(3)),
    end: Number(line.end.toFixed(3)),
    text: line.text.slice(0, 180),
    words: line.words.map(word => ({
      text: String(word.text).slice(0, 60),
      start: Number(Number(word.start).toFixed(3)),
      end: Number(Number(word.end).toFixed(3)),
    }))
  }));
}

function normalizeKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function candidateScore(item, title, artist, duration) {
  const wantedTitle = normalizeKey(title);
  const wantedArtist = normalizeKey(artist);
  const gotTitle = normalizeKey(item?.trackName ?? item?.name);
  const gotArtist = normalizeKey(item?.artistName);

  let score = 0;

  if (gotTitle === wantedTitle) score += 120;
  else if (gotTitle.includes(wantedTitle) || wantedTitle.includes(gotTitle)) score += 55;

  if (gotArtist === wantedArtist) score += 100;
  else if (gotArtist.includes(wantedArtist) || wantedArtist.includes(gotArtist)) score += 45;

  if (typeof item?.syncedLyrics === 'string' && item.syncedLyrics.trim()) score += 80;

  const wantedDuration = Number(duration);
  const gotDuration = Number(item?.duration);
  if (Number.isFinite(wantedDuration) && wantedDuration > 0 &&
      Number.isFinite(gotDuration) && gotDuration > 0) {
    const diff = Math.abs(gotDuration - wantedDuration);
    if (diff <= 1) score += 40;
    else if (diff <= 3) score += 30;
    else if (diff <= 8) score += 15;
    else if (diff > 30) score -= 30;
  }

  return score;
}

function lrclibHeaders(env) {
  const publicUrl = String(env.PUBLIC_BASE_URL || '').trim();
  const configured = String(env.LRCLIB_USER_AGENT || '').trim();
  const userAgent = configured ||
    `EST-Karaoke/1.0${publicUrl ? ` (${publicUrl})` : ''}`;

  return {
    Accept: 'application/json',
    'User-Agent': userAgent,
  };
}

async function lrclibJson(url, env) {
  const controller = new AbortController();
  const timeoutMs = Math.max(2000, Number(env.LRCLIB_TIMEOUT_MS || 12000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: lrclibHeaders(env),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`LRCLIB timed out after ${timeoutMs}ms.`);
    }
    throw new Error(`LRCLIB request failed: ${error?.message || String(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) return null;

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      (data && typeof data === 'object' && (data.message || data.error)) ||
      `HTTP ${response.status}`;
    throw new Error(`LRCLIB request failed (${detail}).`);
  }

  return data;
}

async function searchLrclib({ title, artist, duration, env, includeDuration }) {
  const base = String(env.LRCLIB_BASE_URL || 'https://lrclib.net/api').replace(/\/+$/, '');
  const url = new URL(`${base}/search`);
  url.searchParams.set('track_name', String(title || '').trim());
  url.searchParams.set('artist_name', String(artist || '').trim());

  const seconds = Math.round(Number(duration));
  if (includeDuration && Number.isFinite(seconds) && seconds > 0) {
    url.searchParams.set('duration', String(seconds));
  }

  const data = await lrclibJson(url, env);
  return Array.isArray(data) ? data : [];
}

async function getLrclibById(id, env) {
  if (id == null || id === '') return null;
  const base = String(env.LRCLIB_BASE_URL || 'https://lrclib.net/api').replace(/\/+$/, '');
  return lrclibJson(`${base}/get/${encodeURIComponent(String(id))}`, env);
}

export async function resolveLyrics({ title, artist, duration, env = process.env }) {
  const cleanTitle = String(title || '').trim();
  const cleanArtist = String(artist || '').trim();

  if (!cleanTitle || !cleanArtist) {
    throw new Error('Title and artist are required for automatic LRCLIB lyrics.');
  }

  // First try the most precise LRCLIB search: title + artist + rounded duration.
  // Karaoke versions can differ slightly, so if that is too strict, retry using
  // title + artist only and rank the returned versions locally.
  let results = await searchLrclib({
    title: cleanTitle,
    artist: cleanArtist,
    duration,
    env,
    includeDuration: true,
  });

  if (!results.length) {
    results = await searchLrclib({
      title: cleanTitle,
      artist: cleanArtist,
      duration,
      env,
      includeDuration: false,
    });
  }

  if (!results.length) {
    throw new Error(`LRCLIB found no match for "${cleanTitle}" by "${cleanArtist}".`);
  }

  const ranked = results
    .map(item => ({
      item,
      score: candidateScore(item, cleanTitle, cleanArtist, duration),
    }))
    .sort((a, b) => b.score - a.score);

  let selected = ranked[0]?.item || null;
  if (!selected) {
    throw new Error('LRCLIB returned search results, but none could be selected.');
  }

  // /api/search normally already carries syncedLyrics. Use /api/get/{id}
  // as a full-detail fallback when the search result has no synchronized text.
  if (!(typeof selected.syncedLyrics === 'string' && selected.syncedLyrics.trim())) {
    const detail = await getLrclibById(selected.id, env);
    if (detail && typeof detail === 'object') {
      selected = { ...selected, ...detail };
    }
  }

  const lrc = String(selected.syncedLyrics || '').trim();
  if (!lrc) {
    if (selected.instrumental === true) {
      throw new Error('LRCLIB matched this track as instrumental and returned no synchronized lyrics.');
    }
    throw new Error('LRCLIB found the song, but no synchronized lyrics are available for this version.');
  }

  const rawLines = parseLrc(lrc);
  const lines = finalizeLyrics(rawLines, duration);

  if (!lines.length) {
    throw new Error('LRCLIB returned synchronized lyrics, but EST could not parse usable timestamps.');
  }

  const matchedTitle = String(selected.trackName ?? selected.name ?? cleanTitle).trim();
  const matchedArtist = String(selected.artistName ?? cleanArtist).trim();
  const sourceId = selected.id != null ? ` #${selected.id}` : '';

  return {
    lines,
    source: `LRCLIB${sourceId}`,
    automatic: true,
    provider: 'LRCLIB',
    match: {
      id: selected.id ?? null,
      title: matchedTitle,
      artist: matchedArtist,
      album: selected.albumName ?? null,
      duration: Number.isFinite(Number(selected.duration)) ? Number(selected.duration) : null,
    },
  };
}
