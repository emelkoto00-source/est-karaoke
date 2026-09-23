import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { probeDuration } from './audio.js';

function run(bin, args, { cwd, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env,
    });

    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });

    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);

      if (code === 0) {
        resolve();
        return;
      }

      const status = signal
        ? `${bin} was killed by ${signal}`
        : `${bin} exited with code ${code}`;

      reject(new Error(`${status}.${stderr ? `\n${stderr.slice(-6000)}` : ''}`));
    });
  });
}

function safeExtension(originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
  return '.video';
}

export async function prepareUploadedKaraokeVideo({
  input,
  originalName,
  workRoot,
  jobId,
  ffmpeg = 'ffmpeg',
  ffprobe = 'ffprobe',
  bitrate = process.env.OUTPUT_BITRATE || '192k',
}) {
  const workDir = path.join(workRoot, jobId);
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  // Give FFmpeg/OpenCV the original extension when possible. The upload's
  // temporary Multer filename has no extension.
  const videoFile = path.join(
    workDir,
    `uploaded-karaoke${safeExtension(originalName)}`,
  );
  await fs.copyFile(input, videoFile);

  // Probe first. This rejects non-media uploads and lets FFprobe validate the
  // container/codec before we spend time on lyric analysis.
  let videoDuration;
  try {
    videoDuration = await probeDuration(videoFile, ffprobe);
  } catch {
    throw new Error(
      'The uploaded file could not be read as a supported video/audio container. ' +
      'Try MP4, MOV, MKV, WEBM, AVI, M4V, MPEG, WMV, FLV, TS, MTS, or M2TS.'
    );
  }

  if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
    throw new Error('Could not determine the uploaded video duration.');
  }

  const maxSeconds = Math.max(
    60,
    Number(process.env.VIDEO_UPLOAD_MAX_DURATION_SECONDS || 1200),
  );

  if (videoDuration > maxSeconds) {
    throw new Error(
      `Video is ${Math.round(videoDuration)}s. Maximum allowed is ${Math.round(maxSeconds)}s.`
    );
  }

  const audioFile = path.join(workDir, 'uploaded-karaoke-audio.mp3');

  try {
    await run(ffmpeg, [
      '-y',
      '-i', videoFile,
      '-map', '0:a:0',
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', bitrate,
      audioFile,
    ], {
      cwd: workDir,
      timeoutMs: 8 * 60 * 1000,
    });
  } catch (err) {
    const message = err?.message || String(err);
    if (/matches no streams|stream map.*matches no streams|does not contain any stream/i.test(message)) {
      throw new Error('The uploaded video does not contain a usable audio track.');
    }
    throw err;
  }

  const audioDuration = await probeDuration(audioFile, ffprobe);

  return {
    workDir,
    videoFile,
    audioFile,
    videoDuration,
    duration: audioDuration,
  };
}
