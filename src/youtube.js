import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { probeDuration } from './audio.js';

const ALLOWED_YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);


async function prepareYoutubeCookies(workDir) {
  const encoded = String(process.env.YOUTUBE_COOKIES_B64 || '').trim();
  const configuredPath = String(process.env.YOUTUBE_COOKIES_FILE || '').trim();

  if (encoded) {
    let decoded;
    try {
      decoded = Buffer.from(encoded, 'base64');
    } catch {
      throw new Error('YOUTUBE_COOKIES_B64 is not valid base64.');
    }

    if (!decoded.length) {
      throw new Error('YOUTUBE_COOKIES_B64 decoded to an empty file.');
    }

    const cookieFile = path.join(workDir, 'youtube-cookies.txt');
    await fs.writeFile(cookieFile, decoded, { mode: 0o600 });
    return cookieFile;
  }

  if (configuredPath) {
    try {
      await fs.access(configuredPath);
      return configuredPath;
    } catch {
      throw new Error(`YOUTUBE_COOKIES_FILE does not exist: ${configuredPath}`);
    }
  }

  return null;
}

function cookieArgs(cookieFile) {
  return cookieFile ? ['--cookies', cookieFile] : [];
}

function makeYoutubeError(err, hasCookies) {
  const message = err?.message || String(err);

  if (/sign in to confirm you.?re not a bot/i.test(message)
      || /use --cookies-from-browser/i.test(message)
      || /authentication/i.test(message)) {
    if (hasCookies) {
      return new Error(
        'YouTube rejected the configured cookies. Refresh YOUTUBE_COOKIES_B64 in Railway with a new cookies.txt export, then retry.'
      );
    }

    return new Error(
      'YouTube blocked Railway anonymous access and requested sign-in. ' +
      'Add YOUTUBE_COOKIES_B64 as a private Railway Variable, then retry. ' +
      'Do not put the cookies in GitHub.'
    );
  }

  return err;
}

function safeYoutubeUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('Enter a valid YouTube URL.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('YouTube URL must use http or https.');
  }

  if (!ALLOWED_YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('Only public youtube.com or youtu.be links are accepted.');
  }

  return parsed.toString();
}

function runCapture(bin, args, {
  cwd,
  timeoutMs = 10 * 60 * 1000,
  maxStdout = 2_000_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > maxStdout) stdout = stdout.slice(-maxStdout);
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const status = signal
        ? `${bin} was killed by ${signal}`
        : `${bin} exited with code ${code}`;

      reject(new Error(
        `${status}.${stderr ? `\n${stderr.slice(-6000)}` : ''}`
      ));
    });
  });
}

async function findDownloadedVideo(workDir) {
  const entries = await fs.readdir(workDir, { withFileTypes: true });
  const candidates = entries
    .filter(e => e.isFile() && /^source\.(mp4|mkv|webm|mov)$/i.test(e.name))
    .map(e => path.join(workDir, e.name));

  if (!candidates.length) return null;

  const stats = await Promise.all(
    candidates.map(async file => ({ file, stat: await fs.stat(file) }))
  );
  stats.sort((a, b) => b.stat.size - a.stat.size);
  return stats[0].file;
}

async function findDownloadedAudio(workDir) {
  const entries = await fs.readdir(workDir, { withFileTypes: true });
  const candidates = entries
    .filter(e => e.isFile() && /^reference\.(mp3|m4a|webm|opus|ogg|wav)$/i.test(e.name))
    .map(e => path.join(workDir, e.name));

  if (!candidates.length) return null;
  const stats = await Promise.all(
    candidates.map(async file => ({ file, stat: await fs.stat(file) }))
  );
  stats.sort((a, b) => b.stat.size - a.stat.size);
  return stats[0].file;
}

export async function downloadYoutubeKaraoke({
  url,
  workRoot,
  jobId,
  ffmpeg = 'ffmpeg',
  ffprobe = 'ffprobe',
  python = process.env.VIDEO_SYNC_PYTHON || process.env.DEMUCS_PYTHON || '/opt/demucs/bin/python',
}) {
  const safeUrl = safeYoutubeUrl(url);
  const workDir = path.join(workRoot, jobId);

  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  const cookieFile = await prepareYoutubeCookies(workDir);
  const authArgs = cookieArgs(cookieFile);

  const maxDuration = Math.max(
    60,
    Number(process.env.YOUTUBE_MAX_DURATION_SECONDS || 900),
  );

  // Metadata first so one pasted URL cannot unexpectedly download a playlist
  // or an extremely long video.
  let metadataResult;
  try {
    metadataResult = await runCapture(python, [
      '-m', 'yt_dlp',
      ...authArgs,
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      safeUrl,
    ], {
      cwd: workDir,
      timeoutMs: 2 * 60 * 1000,
    });
  } catch (err) {
    throw makeYoutubeError(err, Boolean(cookieFile));
  }

  let metadata;
  try {
    metadata = JSON.parse(metadataResult.stdout.trim());
  } catch {
    throw new Error('YouTube metadata could not be read.');
  }

  const duration = Number(metadata.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Could not determine the YouTube video duration.');
  }
  if (duration > maxDuration) {
    throw new Error(
      `YouTube video is ${Math.round(duration)}s. Maximum allowed is ${Math.round(maxDuration)}s.`
    );
  }

  // 720p is plenty for karaoke-text/highlight analysis and greatly reduces
  // Railway bandwidth, disk usage, and frame-analysis CPU cost.
  try {
    await runCapture(python, [
      '-m', 'yt_dlp',
      ...authArgs,
      '--no-playlist',
      '--no-warnings',
      '--no-part',
      '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
      '--merge-output-format', 'mp4',
      '-o', path.join(workDir, 'source.%(ext)s'),
      safeUrl,
    ], {
      cwd: workDir,
      timeoutMs: 12 * 60 * 1000,
    });
  } catch (err) {
    throw makeYoutubeError(err, Boolean(cookieFile));
  }

  const videoFile = await findDownloadedVideo(workDir);
  if (!videoFile) {
    throw new Error('YouTube download finished, but no video file was found.');
  }

  // Extract exactly the karaoke video's own audio. No trimming, silence
  // removal, tempo change, or extra intro is applied.
  const audioFile = path.join(workDir, 'youtube-karaoke-audio.mp3');
  await runCapture(ffmpeg, [
    '-y',
    '-i', videoFile,
    '-map', '0:a:0',
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', process.env.OUTPUT_BITRATE || '192k',
    audioFile,
  ], {
    cwd: workDir,
    timeoutMs: 5 * 60 * 1000,
  });

  const audioDuration = await probeDuration(audioFile, ffprobe);

  return {
    workDir,
    videoFile,
    audioFile,
    duration: audioDuration,
    videoTitle: String(metadata.title || ''),
    channel: String(metadata.channel || metadata.uploader || ''),
    webpageUrl: String(metadata.webpage_url || safeUrl),
  };
}

export async function downloadYoutubeReferenceAudio({
  url,
  workRoot,
  jobId,
  ffmpeg = 'ffmpeg',
  ffprobe = 'ffprobe',
  python = process.env.VIDEO_SYNC_PYTHON || process.env.DEMUCS_PYTHON || '/opt/demucs/bin/python',
}) {
  const safeUrl = safeYoutubeUrl(url);
  const workDir = path.join(workRoot, `${jobId}-reference`);

  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  const cookieFile = await prepareYoutubeCookies(workDir);
  const authArgs = cookieArgs(cookieFile);
  const maxDuration = Math.max(60, Number(process.env.YOUTUBE_REFERENCE_MAX_DURATION_SECONDS || 900));

  let metadataResult;
  try {
    metadataResult = await runCapture(python, [
      '-m', 'yt_dlp',
      ...authArgs,
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      safeUrl,
    ], { cwd: workDir, timeoutMs: 2 * 60 * 1000 });
  } catch (err) {
    throw makeYoutubeError(err, Boolean(cookieFile));
  }

  let metadata;
  try {
    metadata = JSON.parse(metadataResult.stdout.trim());
  } catch {
    throw new Error('Original-reference YouTube metadata could not be read.');
  }

  const duration = Number(metadata.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Could not determine the original-reference YouTube duration.');
  }
  if (duration > maxDuration) {
    throw new Error(`Original-reference YouTube track is ${Math.round(duration)}s. Maximum allowed is ${Math.round(maxDuration)}s.`);
  }

  try {
    await runCapture(python, [
      '-m', 'yt_dlp',
      ...authArgs,
      '--no-playlist',
      '--no-warnings',
      '--no-part',
      '-f', 'ba/b',
      '-o', path.join(workDir, 'reference.%(ext)s'),
      safeUrl,
    ], { cwd: workDir, timeoutMs: 10 * 60 * 1000 });
  } catch (err) {
    throw makeYoutubeError(err, Boolean(cookieFile));
  }

  const downloaded = await findDownloadedAudio(workDir);
  if (!downloaded) throw new Error('Original-reference YouTube download finished, but no audio file was found.');

  // Normalize only the container/codec, never the timeline.
  const audioFile = path.join(workDir, 'reference-original.mp3');
  await runCapture(ffmpeg, [
    '-y', '-i', downloaded, '-vn', '-c:a', 'libmp3lame', '-b:a', process.env.OUTPUT_BITRATE || '192k', audioFile,
  ], { cwd: workDir, timeoutMs: 5 * 60 * 1000 });

  const audioDuration = await probeDuration(audioFile, ffprobe);
  return {
    workDir,
    audioFile,
    duration: audioDuration,
    videoTitle: String(metadata.title || ''),
    channel: String(metadata.channel || metadata.uploader || ''),
    webpageUrl: String(metadata.webpage_url || safeUrl),
  };
}

export async function analyzeKaraokeVideoSync({
  videoFile,
  lyrics,
  workDir,
  python = process.env.VIDEO_SYNC_PYTHON || process.env.DEMUCS_PYTHON || '/opt/demucs/bin/python',
}) {
  if (!Array.isArray(lyrics) || lyrics.length < 2) {
    return {
      applied: false,
      offset: 0,
      confidence: 0,
      matchedAnchors: 0,
      reason: 'Not enough synchronized lyric lines for video-assisted alignment.',
    };
  }

  const lyricsFile = path.join(workDir, 'video-sync-lyrics.json');
  await fs.writeFile(
    lyricsFile,
    JSON.stringify(
      lyrics
        .map(line => ({
          start: Number(line.start),
          text: String(line.text || ''),
        }))
        .filter(line => Number.isFinite(line.start)),
    ),
    'utf8',
  );

  const script = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    'video_sync.py',
  );

  const result = await runCapture(python, [
    script,
    '--video', videoFile,
    '--lyrics', lyricsFile,
    '--sample-fps', String(process.env.VIDEO_SYNC_SAMPLE_FPS || 8),
    '--max-seconds', String(process.env.VIDEO_SYNC_MAX_SECONDS || 240),
  ], {
    cwd: workDir,
    timeoutMs: 8 * 60 * 1000,
  });

  const raw = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Video sync analyzer returned invalid data: ${raw || '(empty)'}`);
  }
}
