import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { JsonStore } from './store.js';
import { normalizeForRoblox } from './audio.js';
import { RobloxClient } from './roblox.js';
import { resolveLyrics } from './lyrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const uploadDir = path.join(root, 'uploads');
const processedDir = path.join(root, 'processed');
const previewDir = path.join(root, 'previews');
const dataFile = path.join(root, 'data', 'state.json');
await Promise.all([
  fs.mkdir(uploadDir, { recursive: true }),
  fs.mkdir(processedDir, { recursive: true }),
  fs.mkdir(previewDir, { recursive: true }),
]);

const store = new JsonStore(dataFile);
await store.load();

const DEFAULT_UPLOADER_ID = 'wan';
const uploaderProfiles = new Map([
  ['wan', {
    id: 'wan',
    name: 'WAN',
    creatorId: String(process.env.ROBLOX_CREATOR_ID || '').trim(),
    creatorType: String(process.env.ROBLOX_CREATOR_TYPE || 'group').trim() || 'group',
    client: new RobloxClient(process.env),
  }],
  ['wan2', {
    id: 'wan2',
    name: 'WAN 2ND',
    creatorId: String(process.env.ROBLOX_CREATOR_ID_WAN2 || '').trim(),
    creatorType: String(process.env.ROBLOX_CREATOR_TYPE_WAN2 || 'group').trim() || 'group',
    client: new RobloxClient({
      ...process.env,
      ROBLOX_API_KEY: process.env.ROBLOX_API_KEY_WAN2 || '',
      ROBLOX_CREATOR_ID: process.env.ROBLOX_CREATOR_ID_WAN2 || '',
      ROBLOX_CREATOR_TYPE: process.env.ROBLOX_CREATOR_TYPE_WAN2 || 'group',
    }),
  }],
]);

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(publicDir, { extensions: ['html'] }));

const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 200);
const upload = multer({ dest: uploadDir, limits: { fileSize: maxUploadMb * 1_000_000, files: 1 } });
const moderationPollMs = Math.max(5, Number(process.env.ROBLOX_MODERATION_POLL_SECONDS || 15)) * 1000;
const speedPresets = Array.from({ length: 20 }, (_, i) => Number((1 + i * 0.1).toFixed(1)));
const FINAL_STAGES = new Set(['in_library', 'declined', 'discarded', 'failed']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function constantEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function bearer(req) { return String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); }
function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected || !constantEqual(bearer(req), expected)) return res.status(401).json({ error: 'Admin password required.' });
  next();
}
function gameAuth(req, res, next) {
  const expected = process.env.GAME_SYNC_TOKEN || '';
  const supplied = bearer(req) || String(req.query.token || '');
  if (!expected || !constantEqual(supplied, expected)) return res.status(401).json({ error: 'Game sync token required.' });
  next();
}
function cleanText(value, max = 100) { return String(value || '').trim().slice(0, max); }
function getUploader(id) { return uploaderProfiles.get(String(id || DEFAULT_UPLOADER_ID)) || uploaderProfiles.get(DEFAULT_UPLOADER_ID); }
function getUploaderClient(job) { return getUploader(job?.uploaderProfile).client; }
function uploaderPublicInfo() {
  return [...uploaderProfiles.values()].map(item => ({
    id: item.id,
    name: item.name,
    creatorId: item.creatorId,
    creatorType: item.creatorType,
    configured: item.client.configured,
  }));
}
function validSpeed(value) {
  const n = Number(value);
  return speedPresets.some(v => Math.abs(v - n) < 1e-9);
}
function approvedPart(job) { return job?.asset?.status === 'approved' || job?.asset?.status === 'accepted'; }
function declinedPart(job) { return job?.asset?.status === 'declined' || job?.asset?.status === 'rejected'; }

async function cleanupJobFiles(job, { keepPreview = false } = {}) {
  if (job?.processedFile) await fs.rm(path.join(processedDir, path.basename(job.processedFile)), { force: true }).catch(() => {});
  if (!keepPreview && job?.previewFile) await fs.rm(path.join(previewDir, path.basename(job.previewFile)), { force: true }).catch(() => {});
}

function publicJob(job) {
  return {
    id: job.id,
    title: job.title,
    artist: job.artist,
    speed: job.speed,
    uploaderProfile: job.uploaderProfile,
    uploaderName: job.uploaderName,
    stage: job.stage,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    duration: job.duration,
    lyricsSource: job.lyricsSource,
    lyricLineCount: Array.isArray(job.lyrics) ? job.lyrics.length : 0,
    lyricsError: job.lyricsError,
    error: job.error,
    asset: job.asset ? {
      assetId: job.asset.assetId,
      status: job.asset.status,
      moderationLabel: job.asset.moderationLabel,
      accessStatus: job.asset.accessStatus,
    } : null,
    previewToken: job.previewToken,
    reviewReadyAt: job.reviewReadyAt,
  };
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'EST Karaoke Automation',
    robloxConfigured: [...uploaderProfiles.values()].some(p => p.client.configured),
    uploaders: uploaderPublicInfo(),
    estUniverseConfigured: Boolean(String(process.env.EST_UNIVERSE_ID || '').trim()),
    lyricsConfigured: true,
    lyricsProvider: 'LRCLIB',
    gameSyncConfigured: Boolean(process.env.GAME_SYNC_TOKEN),
    speedPresets,
  });
});

app.get('/api/jobs', adminAuth, (req, res) => res.json({ jobs: store.state.jobs.map(publicJob) }));
app.get('/api/library', adminAuth, (req, res) => res.json({ songs: store.state.library }));

app.post('/api/jobs/clear', adminAuth, async (req, res) => {
  const finished = store.state.jobs.filter(job => FINAL_STAGES.has(job.stage));
  for (const job of finished) await cleanupJobFiles(job);
  store.state.jobs = store.state.jobs.filter(job => !FINAL_STAGES.has(job.stage));
  await store.save();
  res.json({ ok: true });
});

app.delete('/api/library/:number', adminAuth, async (req, res) => {
  const before = store.state.library.length;
  store.state.library = store.state.library.filter(song => String(song.number) !== String(req.params.number));
  if (before === store.state.library.length) return res.status(404).json({ error: 'Song not found.' });
  await store.save();
  res.json({ ok: true });
});

app.get('/api/game/library', gameAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    version: Date.now(),
    songs: store.state.library.map(song => ({
      Number: String(song.number),
      Title: song.title,
      Artist: song.artist,
      AudioId: `rbxassetid://${song.assetId}`,
      Speed: Number(song.speed) || 1,
      Lyrics: Array.isArray(song.lyrics) ? song.lyrics : [],
      SourceUploader: song.sourceUploader,
      SourceCreatorId: song.sourceCreatorId,
      AddedAt: song.addedAt,
    })),
  });
});

app.get('/api/jobs/:id/preview', async (req, res) => {
  const job = store.state.jobs.find(item => item.id === req.params.id);
  if (!job) return res.status(404).end();
  if (!job.previewToken || !constantEqual(req.query.token, job.previewToken)) return res.status(403).end();
  if (!job.previewFile) return res.status(404).end();
  const file = path.join(previewDir, path.basename(job.previewFile));
  try {
    await fs.access(file);
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(file);
  } catch {
    res.status(404).end();
  }
});

app.get('/api/jobs/:id/lyrics', adminAuth, (req, res) => {
  const job = store.state.jobs.find(item => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json({
    title: job.title,
    artist: job.artist,
    speed: job.speed,
    source: job.lyricsSource || '',
    lines: Array.isArray(job.lyrics) ? job.lyrics : [],
  });
});

app.post('/api/uploads', adminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a karaoke audio file.' });
  const title = cleanText(req.body.title, 100);
  const artist = cleanText(req.body.artist, 100);
  const speed = Number(req.body.speed);
  const uploader = uploaderProfiles.get(cleanText(req.body.uploaderProfile, 20) || DEFAULT_UPLOADER_ID);

  if (!title || !artist) {
    await fs.rm(req.file.path, { force: true }).catch(() => {});
    return res.status(400).json({ error: 'Title and artist are required.' });
  }
  if (!validSpeed(speed)) {
    await fs.rm(req.file.path, { force: true }).catch(() => {});
    return res.status(400).json({ error: 'Speed must be one of the 1.0×–2.9× presets.' });
  }
  if (!uploader) {
    await fs.rm(req.file.path, { force: true }).catch(() => {});
    return res.status(400).json({ error: 'Unknown upload account.' });
  }
  if (!uploader.client.configured) {
    await fs.rm(req.file.path, { force: true }).catch(() => {});
    return res.status(400).json({ error: `${uploader.name} is not configured.` });
  }

  const job = {
    id: crypto.randomUUID(),
    title,
    artist,
    speed,
    uploaderProfile: uploader.id,
    uploaderName: uploader.name,
    uploaderCreatorId: uploader.creatorId,
    stage: 'processing',
    originalName: req.file.originalname,
    createdAt: Date.now(),
    previewToken: crypto.randomBytes(24).toString('hex'),
    asset: null,
    lyrics: [],
  };
  store.state.jobs.unshift(job);
  await store.save();
  res.status(202).json({ job: publicJob(job) });

  processUpload(job, req.file.path).catch(async err => {
    job.stage = 'failed';
    job.error = err.message || String(err);
    job.finishedAt = Date.now();
    await cleanupJobFiles(job);
    await store.save();
    await fs.rm(req.file.path, { force: true }).catch(() => {});
  });
});

app.post('/api/jobs/:id/retry-lyrics', adminAuth, async (req, res) => {
  const job = store.state.jobs.find(item => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (!approvedPart(job)) return res.status(409).json({ error: 'Audio must be approved before lyrics can be retried.' });
  job.stage = 'lyrics';
  job.lyricsError = undefined;
  await store.save();
  res.status(202).json({ job: publicJob(job) });
  resolveLyricsForJob(job).catch(async err => {
    job.stage = 'lyrics_needed';
    job.lyricsError = err.message || String(err);
    await store.save();
  });
});

app.patch('/api/jobs/:id/review', adminAuth, async (req, res) => {
  const job = store.state.jobs.find(item => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.stage !== 'review') return res.status(409).json({ error: 'This song is not waiting for review.' });
  if (req.body.title != null) {
    const title = cleanText(req.body.title, 100);
    if (!title) return res.status(400).json({ error: 'Title cannot be empty.' });
    job.title = title;
  }
  if (req.body.artist != null) {
    const artist = cleanText(req.body.artist, 100);
    if (!artist) return res.status(400).json({ error: 'Artist cannot be empty.' });
    job.artist = artist;
  }
  if (req.body.speed != null) {
    if (!validSpeed(req.body.speed)) return res.status(400).json({ error: 'Invalid speed preset.' });
    job.speed = Number(req.body.speed);
  }
  if (req.body.offset != null) {
    const offset = Number(req.body.offset);
    if (!Number.isFinite(offset) || offset < -30 || offset > 30) return res.status(400).json({ error: 'Offset must be between -30 and +30 seconds.' });
    job.lyricOffset = Number(offset.toFixed(3));
  }
  await store.save();
  res.json({ job: publicJob(job), lyrics: job.lyrics, lyricOffset: job.lyricOffset || 0 });
});

app.post('/api/jobs/:id/proceed', adminAuth, async (req, res) => {
  const job = store.state.jobs.find(item => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.stage !== 'review') return res.status(409).json({ error: 'Review the song first.' });
  if (!Array.isArray(job.lyrics) || !job.lyrics.length) return res.status(409).json({ error: 'This song has no synchronized lyrics yet.' });
  job.stage = 'granting_access';
  job.error = undefined;
  await store.save();
  res.status(202).json({ job: publicJob(job) });

  finalizeIntoLibrary(job).catch(async err => {
    job.stage = 'access_required';
    job.error = err.message || String(err);
    await store.save();
  });
});

app.post('/api/jobs/:id/discard', adminAuth, async (req, res) => {
  const job = store.state.jobs.find(item => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (!['review', 'lyrics_needed'].includes(job.stage)) return res.status(409).json({ error: 'This job cannot be discarded at this stage.' });
  job.stage = 'discarded';
  job.finishedAt = Date.now();
  await cleanupJobFiles(job);
  await store.save();
  res.json({ job: publicJob(job) });
});

async function copyPreview(processedFile, job) {
  const name = `${job.id}.mp3`;
  await fs.copyFile(processedFile, path.join(previewDir, name));
  job.previewFile = name;
}

async function processUpload(job, inputPath) {
  const client = getUploaderClient(job);
  try {
    job.stage = 'processing';
    await store.save();
    const normalized = await normalizeForRoblox({
      input: inputPath,
      outDir: processedDir,
      jobId: job.id,
      ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
      ffprobe: process.env.FFPROBE_BIN || 'ffprobe',
      bitrate: process.env.OUTPUT_BITRATE || '192k',
    });
    job.duration = Number(normalized.duration.toFixed(3));
    job.processedFile = path.basename(normalized.file);
    await copyPreview(normalized.file, job);
    await store.save();

    job.stage = 'uploading';
    await store.save();
    const uploadResult = await client.uploadAudio(normalized.file, `${job.title} - ${job.artist}`, 1);
    job.asset = {
      assetId: String(uploadResult.assetId),
      operationId: uploadResult.operationId || null,
      status: uploadResult.moderation?.status || 'pending',
      moderationLabel: uploadResult.moderation?.label || 'Pending review',
      accessStatus: 'pending',
    };
    await store.save();

    if (job.asset.status === 'approved') {
      await resolveLyricsForJob(job);
      return;
    }
    if (job.asset.status === 'declined') {
      job.stage = 'declined';
      job.error = job.asset.moderationLabel || 'Roblox moderation declined this audio.';
      job.finishedAt = Date.now();
      await cleanupJobFiles(job);
      await store.save();
      return;
    }

    job.stage = 'moderating';
    await store.save();
    monitorModeration(job).catch(err => console.error('[moderation]', err));
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => {});
  }
}

const moderationMonitors = new Set();
async function monitorModeration(job) {
  if (moderationMonitors.has(job.id)) return;
  moderationMonitors.add(job.id);
  const client = getUploaderClient(job);
  try {
    while (job.stage === 'moderating') {
      const result = await client.getModerationStatus(job.asset.assetId, job.asset.operationId).catch(err => ({
        status: 'pending', label: `Status check failed: ${err.message || String(err)}`,
      }));
      job.asset.status = result.status;
      job.asset.moderationLabel = result.label;
      job.asset.lastModerationCheckAt = Date.now();
      await store.save();

      if (result.status === 'approved') {
        await resolveLyricsForJob(job);
        return;
      }
      if (result.status === 'declined') {
        job.stage = 'declined';
        job.error = result.label || 'Roblox moderation declined this audio.';
        job.finishedAt = Date.now();
        await cleanupJobFiles(job);
        await store.save();
        return;
      }
      await sleep(moderationPollMs);
    }
  } finally {
    moderationMonitors.delete(job.id);
  }
}

async function resolveLyricsForJob(job) {
  job.stage = 'lyrics';
  job.lyricsError = undefined;
  await store.save();
  try {
    const result = await resolveLyrics({ title: job.title, artist: job.artist, duration: job.duration });
    job.lyrics = result.lines;
    job.lyricsSource = result.source;
    job.lyricOffset = 0;
    job.stage = 'review';
    job.reviewReadyAt = Date.now();
    await store.save();
  } catch (err) {
    job.stage = 'lyrics_needed';
    job.lyricsError = err.message || String(err);
    await store.save();
  }
}

function shiftedLyrics(job) {
  const offset = Number(job.lyricOffset) || 0;
  if (!offset) return job.lyrics;
  return job.lyrics.map(line => ({
    ...line,
    start: Math.max(0, Number((line.start + offset).toFixed(3))),
    end: Math.max(0, Number((line.end + offset).toFixed(3))),
    words: (line.words || []).map(word => ({
      ...word,
      start: Math.max(0, Number((word.start + offset).toFixed(3))),
      end: Math.max(0, Number((word.end + offset).toFixed(3))),
    })),
  }));
}

async function finalizeIntoLibrary(job) {
  const universeId = String(process.env.EST_UNIVERSE_ID || '').trim();
  if (!universeId) throw new Error('EST_UNIVERSE_ID is missing on Railway.');
  const client = getUploaderClient(job);
  const result = await client.grantUniverseUsePermission(job.asset.assetId, universeId);
  job.asset.accessStatus = 'granted';
  job.asset.accessGrantedAt = Date.now();
  job.asset.accessHttpStatus = result?.status || 200;

  let song = store.state.library.find(item => item.jobId === job.id);
  if (!song) {
    song = {
      jobId: job.id,
      number: store.allocateSongNumber(),
      title: job.title,
      artist: job.artist,
      speed: job.speed,
      assetId: job.asset.assetId,
      lyrics: shiftedLyrics(job),
      lyricsSource: job.lyricsSource,
      sourceUploaderId: job.uploaderProfile,
      sourceUploader: job.uploaderName,
      sourceCreatorId: job.uploaderCreatorId,
      addedAt: Date.now(),
      estUniverseId: universeId,
    };
    store.state.library.unshift(song);
  }

  job.songNumber = song.number;
  job.stage = 'in_library';
  job.finishedAt = Date.now();
  job.error = undefined;
  await cleanupJobFiles(job);
  await store.save();
}

// Resume jobs that were waiting before a deploy/restart.
for (const job of store.state.jobs) {
  if (job.stage === 'moderating') monitorModeration(job).catch(err => console.error('[resume moderation]', err));
}

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`[EST Karaoke] listening on ${port}`));
