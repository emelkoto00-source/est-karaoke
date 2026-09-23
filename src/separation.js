import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { probeDuration } from './audio.js';

function run(bin, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env,
    });

    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve(stderr);

      const detail = signal
        ? `${bin} was killed by ${signal}`
        : `${bin} exited with code ${code}`;

      const hint = signal === 'SIGKILL'
        ? ' This usually means the container ran out of memory while Demucs/PyTorch was processing the song.'
        : '';

      reject(new Error(`${detail}.${hint}${stderr ? `\n${stderr.slice(-5000)}` : ''}`));
    });
  });
}

async function findFile(root, wantedName) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(full, wantedName).catch(() => null);
      if (nested) return nested;
    } else if (entry.name === wantedName) {
      return full;
    }
  }
  return null;
}

// Demucs is deliberately serialized by default because CPU source separation is
// memory/CPU heavy. This prevents two original-song uploads from exhausting a
// small Railway container at the same time.
let separationChain = Promise.resolve();

async function separateNow({
  input,
  workRoot,
  jobId,
  ffmpeg = 'ffmpeg',
  ffprobe = 'ffprobe',
  demucsPython = process.env.DEMUCS_PYTHON || '/opt/demucs/bin/python',
  model = process.env.DEMUCS_MODEL || 'htdemucs',
  device = process.env.DEMUCS_DEVICE || 'cpu',
}) {
  const workDir = path.join(workRoot, jobId);
  const demucsOut = path.join(workDir, 'demucs');
  const prepared = path.join(workDir, 'source.wav');

  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(demucsOut, { recursive: true });

  // Decode from exactly 0:00 without trimming, padding, tempo changes, or
  // silence removal. Demucs htdemucs operates at 44.1 kHz.
  await run(ffmpeg, [
    '-y',
    '-i', input,
    '-vn',
    '-ar', '44100',
    '-ac', '2',
    '-c:a', 'pcm_f32le',
    prepared,
  ]);

  const originalDuration = await probeDuration(input, ffprobe);
  const preparedDuration = await probeDuration(prepared, ffprobe);

  await run(demucsPython, [
    '-m', 'demucs',
    '-n', model,
    '--two-stems=vocals',
    '-d', device,

    // Railway-safe settings. One worker prevents parallel stem chunks from
    // multiplying PyTorch memory usage. A shorter segment keeps peak working
    // memory lower while preserving the exact source timeline.
    '-j', '1',
    '--shifts', '1',
    '--segment', process.env.DEMUCS_SEGMENT || '7.0',

    '--out', demucsOut,
    prepared,
  ]);

  const instrumental = await findFile(demucsOut, 'no_vocals.wav');
  if (!instrumental) {
    throw new Error('AI separation finished, but Demucs did not create no_vocals.wav.');
  }

  const instrumentalDuration = await probeDuration(instrumental, ffprobe);
  const diffMs = Math.abs(instrumentalDuration - preparedDuration) * 1000;
  const toleranceMs = Math.max(
    20,
    Number(process.env.DEMUCS_DURATION_TOLERANCE_MS || 150),
  );

  if (diffMs > toleranceMs) {
    throw new Error(
      `Instrumental timeline verification failed: source ${preparedDuration.toFixed(3)}s, ` +
      `instrumental ${instrumentalDuration.toFixed(3)}s (${diffMs.toFixed(0)}ms difference).`
    );
  }

  return {
    file: instrumental,
    workDir,
    originalDuration,
    preparedDuration,
    instrumentalDuration,
    timelineDifferenceMs: Number(diffMs.toFixed(3)),
    model,
  };
}

export function createInstrumentalFromOriginal(options) {
  const task = separationChain.then(() => separateNow(options));
  separationChain = task.catch(() => {});
  return task;
}
