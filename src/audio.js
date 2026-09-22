import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`${bin} exited ${code}: ${stderr.slice(-4000)}`));
    });
  });
}

export async function probeDuration(file, ffprobe = 'ffprobe') {
  return await new Promise((resolve, reject) => {
    const child = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `ffprobe exited ${code}`));
      const seconds = Number(stdout.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) return reject(new Error('Could not determine audio duration.'));
      resolve(seconds);
    });
  });
}

export async function normalizeForRoblox({ input, outDir, jobId, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', bitrate = '192k' }) {
  await fs.mkdir(outDir, { recursive: true });
  const output = path.join(outDir, `${jobId}.mp3`);
  await run(ffmpeg, ['-y', '-i', input, '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', bitrate, output]);
  const duration = await probeDuration(output, ffprobe);
  return { file: output, duration };
}
