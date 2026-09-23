import { spawn } from 'node:child_process';
import path from 'node:path';

function runCapture(bin, args, { cwd, timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const status = signal ? `${bin} was killed by ${signal}` : `${bin} exited with code ${code}`;
      reject(new Error(`${status}.${stderr ? `\n${stderr.slice(-6000)}` : ''}${stdout ? `\n${stdout.slice(-3000)}` : ''}`));
    });
  });
}

export async function analyzeReferenceTrackSync({
  referenceInstrumental,
  karaokeAudio,
  workDir,
  ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg',
  python = process.env.REFERENCE_SYNC_PYTHON || process.env.DEMUCS_PYTHON || '/opt/demucs/bin/python',
}) {
  const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'audio_reference_sync.py');
  const result = await runCapture(python, [
    script,
    '--reference', referenceInstrumental,
    '--karaoke', karaokeAudio,
    '--ffmpeg', ffmpeg,
    '--fps', String(process.env.REFERENCE_SYNC_FPS || 4),
    '--max-offset', String(process.env.REFERENCE_SYNC_MAX_OFFSET_SECONDS || 90),
  ], {
    cwd: workDir,
    timeoutMs: Math.max(5, Number(process.env.REFERENCE_SYNC_TIMEOUT_MINUTES || 20)) * 60 * 1000,
  });

  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error('Original-track sync analyzer returned unreadable output.');
  }
  if (parsed?.error) throw new Error(parsed.error);
  if (!Array.isArray(parsed?.anchors)) parsed.anchors = [];
  return parsed;
}

function mapOneTime(value, anchors) {
  const t = Number(value);
  if (!Number.isFinite(t) || !anchors.length) return Number.isFinite(t) ? t : 0;

  const pts = anchors
    .map(a => ({ r: Number(a.reference), k: Number(a.karaoke) }))
    .filter(a => Number.isFinite(a.r) && Number.isFinite(a.k))
    .sort((a, b) => a.r - b.r);

  if (!pts.length) return t;
  if (pts.length === 1) return Math.max(0, t + (pts[0].k - pts[0].r));

  const segmentSlope = (a, b) => {
    const dr = b.r - a.r;
    if (Math.abs(dr) < 1e-6) return 1;
    // Avoid a noisy local anchor creating a wild lyric speed warp.
    return Math.max(0.72, Math.min(1.32, (b.k - a.k) / dr));
  };

  if (t <= pts[0].r) {
    const s = segmentSlope(pts[0], pts[1]);
    return Math.max(0, pts[0].k + (t - pts[0].r) * s);
  }

  for (let i = 1; i < pts.length; i += 1) {
    if (t <= pts[i].r) {
      const a = pts[i - 1];
      const b = pts[i];
      const s = segmentSlope(a, b);
      return Math.max(0, a.k + (t - a.r) * s);
    }
  }

  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const s = segmentSlope(a, b);
  return Math.max(0, b.k + (t - b.r) * s);
}

export function applyReferenceTimeMap(lines, anchors) {
  const source = Array.isArray(lines) ? lines : [];
  const mapped = [];
  let previousStart = 0;

  for (const line of source) {
    const originalStart = Number(line?.start);
    const originalEnd = Number(line?.end);
    let start = mapOneTime(Number.isFinite(originalStart) ? originalStart : previousStart, anchors);
    let end = mapOneTime(Number.isFinite(originalEnd) ? originalEnd : start, anchors);

    start = Math.max(previousStart, start);
    end = Math.max(start + 0.03, end);

    const words = (Array.isArray(line?.words) ? line.words : []).map(word => {
      const ws = Number(word?.start);
      const we = Number(word?.end);
      let wordStart = mapOneTime(Number.isFinite(ws) ? ws : start, anchors);
      let wordEnd = mapOneTime(Number.isFinite(we) ? we : wordStart, anchors);
      wordStart = Math.max(start, wordStart);
      wordEnd = Math.max(wordStart + 0.01, wordEnd);
      return {
        ...word,
        start: Number(wordStart.toFixed(3)),
        end: Number(wordEnd.toFixed(3)),
      };
    });

    mapped.push({
      ...line,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      words,
    });
    previousStart = start;
  }

  return mapped;
}
