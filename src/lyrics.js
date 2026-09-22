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

function findLyricsPayload(data) {
  if (!data || typeof data !== 'object') return null;
  const lrc = data.syncedLyrics ?? data.lrc ?? data.synced_lyrics ?? data.result?.syncedLyrics ?? data.result?.lrc ?? data.data?.syncedLyrics ?? data.data?.lrc;
  if (typeof lrc === 'string' && lrc.trim()) return { kind: 'lrc', value: lrc };
  const lines = data.lines ?? data.result?.lines ?? data.data?.lines ?? data.lyrics?.lines;
  if (Array.isArray(lines)) return { kind: 'lines', value: lines };
  return null;
}

function simulationLyrics(duration) {
  const d = Math.max(20, Number(duration) || 60);
  return finalizeLyrics([
    { start: Math.min(2, d * 0.05), text: 'KTV automatic lyric preview' },
    { start: Math.min(6, d * 0.15), text: 'Timing provider connected successfully' },
    { start: Math.min(11, d * 0.28), text: 'Words highlight across the current line' },
    { start: Math.min(16, d * 0.42), text: 'Review the timing before adding to KTV' },
  ], d);
}

export async function resolveLyrics({ title, artist, duration, env = process.env }) {
  if (String(env.LYRICS_SIMULATION || '').toLowerCase() === 'true') {
    return { lines: simulationLyrics(duration), source: 'simulation', automatic: true };
  }

  const base = String(env.LYRICS_PROVIDER_URL || '').trim();
  if (!base) {
    throw new Error('Automatic lyrics are not configured yet. Set LYRICS_PROVIDER_URL on Railway.');
  }

  const url = new URL(base);
  url.searchParams.set('title', String(title || ''));
  url.searchParams.set('artist', String(artist || ''));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(2000, Number(env.LYRICS_PROVIDER_TIMEOUT_MS || 12000)));
  const headers = { Accept: 'application/json' };
  if (env.LYRICS_PROVIDER_TOKEN) headers.Authorization = `Bearer ${env.LYRICS_PROVIDER_TOKEN}`;

  let res;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.message || data?.error || `Lyrics provider failed (${res.status}).`;
    throw new Error(String(message));
  }

  const payload = findLyricsPayload(data);
  if (!payload) throw new Error('Lyrics provider returned no synchronized lyrics for this title/artist.');
  const rawLines = payload.kind === 'lrc' ? parseLrc(payload.value) : payload.value;
  const lines = finalizeLyrics(rawLines, duration);
  if (!lines.length) throw new Error('Lyrics were found, but no usable timestamps were returned.');

  return {
    lines,
    source: String(data.source || data.provider || url.hostname || 'configured-provider').slice(0, 80),
    automatic: true,
  };
}
