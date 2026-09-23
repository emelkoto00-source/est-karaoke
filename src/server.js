import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { JsonStore } from './store.js';
import { normalizeForRoblox, probeDuration } from './audio.js';
import { createInstrumentalFromOriginal } from './separation.js';
import { downloadYoutubeKaraoke, analyzeKaraokeVideoSync } from './youtube.js';
import { prepareUploadedKaraokeVideo } from './video_upload.js';
import { RobloxClient } from './roblox.js';
import { resolveLyrics } from './lyrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const uploadDir = path.join(root, 'uploads');
const processedDir = path.join(root, 'processed');
const previewDir = path.join(root, 'previews');
const separationDir = path.join(root, 'separation-work');
const youtubeDir = path.join(root, 'youtube-work');
const videoUploadDir = path.join(root, 'video-upload-work');
const dataFile = path.join(root, 'data', 'state.json');
await Promise.all([
  fs.mkdir(uploadDir, { recursive: true }),
  fs.mkdir(processedDir, { recursive: true }),
  fs.mkdir(previewDir, { recursive: true }),
  fs.mkdir(separationDir, { recursive: true }),
  fs.mkdir(youtubeDir, { recursive: true }),
  fs.mkdir(videoUploadDir, { recursive: true }),
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
const maxVideoUploadMb = Number(process.env.MAX_VIDEO_UPLOAD_MB || 750);
const upload = multer({ dest: uploadDir, limits: { fileSize: maxUploadMb * 1_000_000, files: 1 } });
const videoUpload = multer({ dest: uploadDir, limits: { fileSize: maxVideoUploadMb * 1_000_000, files: 1 } });
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
    audioType: job.audioType || 'karaoke',
    sourceType: job.sourceType || 'upload',
    videoSyncApplied: job.videoSyncApplied === true,
    videoSyncOffset: Number(job.videoSyncOffset) || 0,
    videoSyncSuggestedOffset: Number(job.videoSyncSuggestedOffset) || 0,
    videoSyncConfidence: Number(job.videoSyncConfidence) || 0,
    videoSyncAnchors: Number(job.videoSyncAnchors) || 0,
    youtubeVideoTitle: job.youtubeVideoTitle,
    youtubeChannel: job.youtubeChannel,
    uploadedVideoName: job.uploadedVideoName,
    separationModel: job.separationModel,
    originalDuration: job.originalDuration,
    instrumentalDuration: job.instrumentalDuration,
    timelineDifferenceMs: job.timelineDifferenceMs,
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
    originalAudioSeparation: true,
    separationProvider: 'Demucs',
    separationModel: process.env.DEMUCS_MODEL || 'htdemucs',
    youtubeKaraokeImport: true,
    videoSyncAssist: true,
    videoUploadImport: true,
    maxVideoUploadMb,
    videoSyncMethod: 'karaoke highlight CV + LRCLIB anchor alignment',
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
      LyricOffset: Number(song.lyricOffset) || 0,
      AudioType: song.audioType || 'karaoke',
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
    lyricOffset: Number(job.lyricOffset) || 0,
    videoSyncApplied: job.videoSyncApplied === true,
    videoSyncOffset: Number(job.videoSyncOffset) || 0,
    videoSyncSuggestedOffset: Number(job.videoSyncSuggestedOffset) || 0,
    videoSyncConfidence: Number(job.videoSyncConfidence) || 0,
    videoSyncAnchors: Number(job.videoSyncAnchors) || 0,
    videoSyncReason: job.videoSyncReason || '',
  });
});

app.post('/api/video-import', adminAuth, videoUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Choose a karaoke video file.' });
  }

  const title = cleanText(req.body.title, 100);
  const artist = cleanText(req.body.artist, 100);
  const speed = Number(req.body.speed);
  const uploader = uploaderProfiles.get(
    cleanText(req.body.uploaderProfile, 20) || DEFAULT_UPLOADER_ID
  );

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
    audioType: 'karaoke',
    sourceType: 'video',
    uploadedVideoName: cleanText(req.file.originalname, 240),
    uploaderProfile: uploader.id,
    uploaderName: uploader.name,
    uploaderCreatorId: uploader.creatorId,
    stage: 'video_preparing',
    createdAt: Date.now(),
    previewToken: crypto.randomBytes(24).toString('hex'),
    asset: null,
    lyrics: [],
    lyricOffset: 0,
  };

  store.state.jobs.unshift(job);
  await store.save();
  res.status(202).json({ job: publicJob(job) });

  processUploadedVideo(job, req.file.path, req.file.originalname).catch(async err => {
    job.stage = 'failed';
    job.error = err.message || String(err);
    job.finishedAt = Date.now();
    await cleanupJobFiles(job);
    await store.save();
  });
});

app.post('/api/youtube-import', adminAuth, async (req, res) => {
  const title = cleanText(req.body?.title, 100);
  const artist = cleanText(req.body?.artist, 100);
  const youtubeUrl = cleanText(req.body?.youtubeUrl, 1000);
  const speed = Number(req.body?.speed);
  const uploader = uploaderProfiles.get(
    cleanText(req.body?.uploaderProfile, 20) || DEFAULT_UPLOADER_ID
  );

  if (!title || !artist) {
    return res.status(400).json({ error: 'Title and artist are required.' });
  }
  if (!youtubeUrl) {
    return res.status(400).json({ error: 'Paste a public YouTube karaoke video URL.' });
  }
  if (!validSpeed(speed)) {
    return res.status(400).json({ error: 'Speed must be one of the 1.0×–2.9× presets.' });
  }
  if (!uploader) {
    return res.status(400).json({ error: 'Unknown upload account.' });
  }
  if (!uploader.client.configured) {
    return res.status(400).json({ error: `${uploader.name} is not configured.` });
  }

  const job = {
    id: crypto.randomUUID(),
    title,
    artist,
    speed,
    audioType: 'karaoke',
    sourceType: 'youtube',
    youtubeUrl,
    uploaderProfile: uploader.id,
    uploaderName: uploader.name,
    uploaderCreatorId: uploader.creatorId,
    stage: 'video_fetching',
    createdAt: Date.now(),
    previewToken: crypto.randomBytes(24).toString('hex'),
    asset: null,
    lyrics: [],
    lyricOffset: 0,
  };

  store.state.jobs.unshift(job);
  await store.save();
  res.status(202).json({ job: publicJob(job) });

  processYoutubeImport(job).catch(async err => {
    job.stage = 'failed';
    job.error = err.message || String(err);
    job.finishedAt = Date.now();
    await cleanupJobFiles(job);
    await store.save();
  });
});

app.post('/api/uploads', adminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an audio file.' });
  const title = cleanText(req.body.title, 100);
  const artist = cleanText(req.body.artist, 100);
  const speed = Number(req.body.speed);
  const audioType = cleanText(req.body.audioType, 20).toLowerCase() || 'karaoke';
  const uploader = uploaderProfiles.get(cleanText(req.body.uploaderProfile, 20) || DEFAULT_UPLOADER_ID);

  if (!['original', 'karaoke'].includes(audioType)) {
    await fs.rm(req.file.path, { force: true }).catch(() => {});
    return res.status(400).json({ error: 'Audio type must be Original Audio or Karaoke Audio.' });
  }

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
    audioType,
    sourceType: 'upload',
    uploaderProfile: uploader.id,
    uploaderName: uploader.name,
    uploaderCreatorId: uploader.creatorId,
    stage: audioType === 'original' ? 'separating' : 'processing',
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

  // Apply the exact offset from the final review action atomically.
  // This avoids relying on an earlier PATCH request having already persisted.
  if (req.body?.offset != null) {
    const finalOffset = Number(req.body.offset);
    if (!Number.isFinite(finalOffset) || finalOffset < -30 || finalOffset > 30) {
      return res.status(400).json({ error: 'Offset must be between -30 and +30 seconds.' });
    }
    job.lyricOffset = Number(finalOffset.toFixed(3));
  }

  job.stage = 'granting_access';
  job.error = undefined;
  await store.save();
  res.status(202).json({
    job: publicJob(job),
    lyricOffset: Number(job.lyricOffset) || 0,
  });

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

async function prefetchLyricsForOriginal(job) {
  job.stage = 'lyrics_preflight';
  job.lyricsError = undefined;
  await store.save();

  try {
    const result = await resolveLyrics({
      title: job.title,
      artist: job.artist,
      duration: job.duration,
    });

    job.lyrics = result.lines;
    job.lyricsSource = result.source;
    job.lyricOffset = 0;
    job.lyricsPrefetched = true;
    job.lyricsError = undefined;
    await store.save();
  } catch (err) {
    // Do not throw away a successful instrumental conversion just because
    // LRCLIB did not match on the first attempt. Roblox processing can still
    // continue, and the normal retry-lyrics flow remains available afterward.
    job.lyrics = [];
    job.lyricsPrefetched = false;
    job.lyricsError = err.message || String(err);
    await store.save();
  }
}

async function markApprovedReady(job) {
  if (Array.isArray(job.lyrics) && job.lyrics.length) {
    job.stage = 'review';
    job.reviewReadyAt = Date.now();
    job.error = undefined;
    await store.save();
    return;
  }
  await resolveLyricsForJob(job);
}

async function processUploadedVideo(job, inputPath, originalName) {
  const client = getUploaderClient(job);
  let workDir = null;

  try {
    job.stage = 'video_preparing';
    job.error = undefined;
    await store.save();

    const prepared = await prepareUploadedKaraokeVideo({
      input: inputPath,
      originalName,
      workRoot: videoUploadDir,
      jobId: job.id,
      ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
      ffprobe: process.env.FFPROBE_BIN || 'ffprobe',
      bitrate: process.env.OUTPUT_BITRATE || '192k',
    });

    workDir = prepared.workDir;
    job.duration = Number(prepared.duration.toFixed(3));
    job.originalDuration = job.duration;
    job.instrumentalDuration = job.duration;
    job.timelineDifferenceMs = 0;
    await store.save();

    job.stage = 'video_lyrics';
    job.lyricsError = undefined;
    await store.save();

    const lyricResult = await resolveLyrics({
      title: job.title,
      artist: job.artist,
      duration: job.duration,
    });

    job.lyrics = lyricResult.lines;
    job.lyricsSource = lyricResult.source;
    job.lyricOffset = 0;
    await store.save();

    job.stage = 'video_sync';
    await store.save();

    const sync = await analyzeKaraokeVideoSync({
      videoFile: prepared.videoFile,
      lyrics: job.lyrics,
      workDir: prepared.workDir,
    });

    job.videoSyncApplied = sync.applied === true;
    job.videoSyncOffset = sync.applied ? Number(sync.offset) || 0 : 0;
    job.videoSyncSuggestedOffset = Number(sync.suggestedOffset ?? sync.offset) || 0;
    job.videoSyncConfidence = Number(sync.confidence) || 0;
    job.videoSyncAnchors = Number(sync.matchedAnchors) || 0;
    job.videoSyncDetectedEvents = Number(sync.detectedEvents) || 0;
    job.videoSyncReason = cleanText(sync.reason, 500);

    if (job.videoSyncApplied) {
      job.lyricOffset = Number(job.videoSyncOffset.toFixed(3));
    }
    await store.save();

    job.stage = 'processing';
    await store.save();

    const normalized = await normalizeForRoblox({
      input: prepared.audioFile,
      outDir: processedDir,
      jobId: job.id,
      ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
      ffprobe: process.env.FFPROBE_BIN || 'ffprobe',
      bitrate: process.env.OUTPUT_BITRATE || '192k',
    });

    job.processedDuration = Number(normalized.duration.toFixed(3));
    job.processedFile = path.basename(normalized.file);
    await copyPreview(normalized.file, job);
    await store.save();

    job.stage = 'uploading';
    await store.save();

    const uploadResult = await client.uploadAudio(
      normalized.file,
      `${job.title} - ${job.artist}`,
      1,
    );

    job.asset = {
      assetId: String(uploadResult.assetId),
      operationId: uploadResult.operationId || null,
      status: uploadResult.moderation?.status || 'pending',
      moderationLabel: uploadResult.moderation?.label || 'Pending review',
      accessStatus: 'pending',
    };
    await store.save();

    if (job.asset.status === 'approved') {
      await markApprovedReady(job);
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
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function processYoutubeImport(job) {
  const client = getUploaderClient(job);
  let workDir = null;

  try {
    job.stage = 'video_fetching';
    job.error = undefined;
    await store.save();

    const downloaded = await downloadYoutubeKaraoke({
      url: job.youtubeUrl,
      workRoot: youtubeDir,
      jobId: job.id,
      ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
      ffprobe: process.env.FFPROBE_BIN || 'ffprobe',
    });

    workDir = downloaded.workDir;
    job.youtubeVideoTitle = downloaded.videoTitle;
    job.youtubeChannel = downloaded.channel;
    job.duration = Number(downloaded.duration.toFixed(3));
    job.originalDuration = job.duration;
    job.instrumentalDuration = job.duration;
    job.timelineDifferenceMs = 0;
    await store.save();

    // We fetch LRCLIB before Roblox because the lyric-line timestamps are also
    // the reference sequence used to estimate the karaoke video's added intro.
    job.stage = 'video_lyrics';
    job.lyricsError = undefined;
    await store.save();

    const lyricResult = await resolveLyrics({
      title: job.title,
      artist: job.artist,
      duration: job.duration,
    });

    job.lyrics = lyricResult.lines;
    job.lyricsSource = lyricResult.source;
    job.lyricOffset = 0;
    await store.save();

    job.stage = 'video_sync';
    await store.save();

    const sync = await analyzeKaraokeVideoSync({
      videoFile: downloaded.videoFile,
      lyrics: job.lyrics,
      workDir: downloaded.workDir,
    });

    job.videoSyncApplied = sync.applied === true;
    job.videoSyncOffset = sync.applied ? Number(sync.offset) || 0 : 0;
    job.videoSyncSuggestedOffset = Number(sync.suggestedOffset ?? sync.offset) || 0;
    job.videoSyncConfidence = Number(sync.confidence) || 0;
    job.videoSyncAnchors = Number(sync.matchedAnchors) || 0;
    job.videoSyncDetectedEvents = Number(sync.detectedEvents) || 0;
    job.videoSyncReason = cleanText(sync.reason, 500);

    // Auto-fill Global Lyric Offset only when several independent highlight
    // anchors support the same timeline shift. Review still lets the user
    // adjust/reset this value normally.
    if (job.videoSyncApplied) {
      job.lyricOffset = Number(job.videoSyncOffset.toFixed(3));
    }
    await store.save();

    job.stage = 'processing';
    await store.save();

    const normalized = await normalizeForRoblox({
      input: downloaded.audioFile,
      outDir: processedDir,
      jobId: job.id,
      ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
      ffprobe: process.env.FFPROBE_BIN || 'ffprobe',
      bitrate: process.env.OUTPUT_BITRATE || '192k',
    });

    job.processedDuration = Number(normalized.duration.toFixed(3));
    job.processedFile = path.basename(normalized.file);
    await copyPreview(normalized.file, job);
    await store.save();

    job.stage = 'uploading';
    await store.save();

    const uploadResult = await client.uploadAudio(
      normalized.file,
      `${job.title} - ${job.artist}`,
      1,
    );

    job.asset = {
      assetId: String(uploadResult.assetId),
      operationId: uploadResult.operationId || null,
      status: uploadResult.moderation?.status || 'pending',
      moderationLabel: uploadResult.moderation?.label || 'Pending review',
      accessStatus: 'pending',
    };
    await store.save();

    if (job.asset.status === 'approved') {
      await markApprovedReady(job);
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
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function processUpload(job, inputPath) {
  const client = getUploaderClient(job);
  let separationWorkDir = null;

  try {
    let sourceForRoblox = inputPath;

    if (job.audioType === 'original') {
      job.stage = 'separating';
      job.error = undefined;
      await store.save();

      const separated = await createInstrumentalFromOriginal({
        input: inputPath,
        workRoot: separationDir,
        jobId: job.id,
        ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
        ffprobe: process.env.FFPROBE_BIN || 'ffprobe',
      });

      separationWorkDir = separated.workDir;
      sourceForRoblox = separated.file;
      job.separationModel = separated.model;
      job.originalDuration = Number(separated.originalDuration.toFixed(3));
      job.instrumentalDuration = Number(separated.instrumentalDuration.toFixed(3));
      job.timelineDifferenceMs = separated.timelineDifferenceMs;

      // LRCLIB matching should use the ORIGINAL recording duration, because
      // that is the timeline the synced lyrics are normally authored against.
      job.duration = job.originalDuration;
      await store.save();

      // For original uploads, try LRCLIB immediately after the timeline-safe
      // instrumental is created, as requested.
      await prefetchLyricsForOriginal(job);
    }

    job.stage = 'processing';
    await store.save();

    const normalized = await normalizeForRoblox({
      input: sourceForRoblox,
      outDir: processedDir,
      jobId: job.id,
      ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
      ffprobe: process.env.FFPROBE_BIN || 'ffprobe',
      bitrate: process.env.OUTPUT_BITRATE || '192k',
    });

    // Karaoke uploads keep the existing behavior. For AI-separated originals,
    // preserve the original source duration as the lyric timeline authority.
    if (job.audioType !== 'original') {
      job.duration = Number(normalized.duration.toFixed(3));
      job.originalDuration = job.duration;
      job.instrumentalDuration = job.duration;
      job.timelineDifferenceMs = 0;
    }

    job.processedDuration = Number(normalized.duration.toFixed(3));
    job.processedFile = path.basename(normalized.file);
    await copyPreview(normalized.file, job);
    await store.save();

    job.stage = 'uploading';
    await store.save();

    const uploadResult = await client.uploadAudio(
      normalized.file,
      `${job.title} - ${job.artist}`,
      1,
    );

    job.asset = {
      assetId: String(uploadResult.assetId),
      operationId: uploadResult.operationId || null,
      status: uploadResult.moderation?.status || 'pending',
      moderationLabel: uploadResult.moderation?.label || 'Pending review',
      accessStatus: 'pending',
    };
    await store.save();

    if (job.asset.status === 'approved') {
      await markApprovedReady(job);
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
    if (separationWorkDir) {
      await fs.rm(separationWorkDir, { recursive: true, force: true }).catch(() => {});
    }
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
        await markApprovedReady(job);
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
      lyricOffset: Number(job.lyricOffset) || 0,
      lyricsSource: job.lyricsSource,
      audioType: job.audioType || 'karaoke',
      sourceType: job.sourceType || 'upload',
      videoSyncOffset: Number(job.videoSyncOffset) || 0,
      videoSyncConfidence: Number(job.videoSyncConfidence) || 0,
      separationModel: job.separationModel || null,
      originalDuration: job.originalDuration || job.duration,
      instrumentalDuration: job.instrumentalDuration || job.duration,
      timelineDifferenceMs: Number(job.timelineDifferenceMs) || 0,
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

async function reconcileFinalizedLyricOffsets() {
  let changed = false;

  for (const song of store.state.library) {
    if (!song?.jobId) continue;

    const job = store.state.jobs.find(item => item.id === song.jobId);
    if (!job || !Array.isArray(job.lyrics) || !job.lyrics.length) continue;

    const expectedOffset = Number(job.lyricOffset) || 0;
    const storedOffset = Number(song.lyricOffset) || 0;

    // Repair older library entries created before the final-offset fix.
    // The original job keeps the provider lyrics + chosen offset, so we can
    // safely rebuild the final shifted timing without another LRCLIB request.
    if (Math.abs(expectedOffset - storedOffset) > 0.0005) {
      song.lyrics = shiftedLyrics(job);
      song.lyricOffset = expectedOffset;
      changed = true;
      console.log(`[lyrics] repaired library offset for ${song.number}: ${expectedOffset >= 0 ? '+' : ''}${expectedOffset}s`);
    }
  }

  if (changed) await store.save();
}

reconcileFinalizedLyricOffsets().catch(err => {
  console.error('[lyrics reconcile]', err);
});

// Resume jobs that were waiting before a deploy/restart.
for (const job of store.state.jobs) {
  if (job.stage === 'moderating') monitorModeration(job).catch(err => console.error('[resume moderation]', err));
}

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`[EST Karaoke] listening on ${port}`));
