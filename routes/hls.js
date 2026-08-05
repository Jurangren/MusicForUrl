const express = require('express');
const router = express.Router();
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const netease = require('../lib/netease');
const qqmusic = require('../lib/qqmusic');
const { decrypt } = require('../lib/crypto');
const { userOps, qqUserOps, playlistOps, playLogOps, uploadCredentialOps, generationHistoryOps } = require('../lib/db');
const { TmpLinkClient } = require('../lib/tmplink');
const { verifyPlaybackToken, isLegacyToken } = require('../lib/playback-token');
const { getOrBindBg } = require('../lib/lite-video-bg');
const { createTextAssets, removeTextAssets, buildVisualFilter } = require('../lib/video-visual');
const { createLyricsAss } = require('../lib/lyrics');
const { detectVideoEncoder } = require('../lib/video-encoder');
const {
  sanitizeOutputFileStem,
  playlistOutputIdentity,
  buildPlaylistOutputFilename,
  buildPlaylistOutputSuffix
} = require('../lib/output-filename');
const { estimateGenerationTiming } = require('../lib/generation-estimate');
const { SerialJobQueue } = require('../lib/serial-job-queue');
const { moveFileSync } = require('../lib/file-move');
const {
  resolveGenerationProfile,
  normalizeGenerationResolution,
  normalizeGenerationFps,
  normalizeGenerationQuality,
  getGenerationAudioBitrate
} = require('../lib/generation-profile');

function isValidNumericId(id) {
  return typeof id === 'string' && /^\d+$/.test(id) && id.length <= 20;
}

function isLikelyToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= 1024;
}

function resolveUserFromAccessToken(token, playlistId, source = 'netease') {
  const raw = String(token || '');
  const sourceName = source === 'qq' ? 'qq' : 'netease';
  const tokenStore = sourceName === 'qq' ? qqUserOps : userOps;
  if (isLegacyToken(raw)) {
    return tokenStore.getByToken.get(raw) || null;
  }

  const verified = verifyPlaybackToken(raw, { playlistId: String(playlistId || '') });
  if (!verified.ok) return null;
  return tokenStore.getById.get(verified.userId) || null;
}

function getSourceFromReq(req) {
  const base = String(req.baseUrl || '');
  if (base.startsWith('/api/qq/hls') || base.startsWith('/api/qq/playlist-video')) return 'qq';
  return 'netease';
}

function getRenderProfileFromReq(req) {
  const query = { ...(req.query || {}) };
  if (query.concurrency == null && process.env.PLAYLIST_GENERATION_CONCURRENCY) {
    query.concurrency = process.env.PLAYLIST_GENERATION_CONCURRENCY;
  }
  return resolveGenerationProfile(query, { allowLiteVideo: true });
}

function getPlaybackOrderFromReq(req) {
  const value = String(req.query?.order || req.body?.order || '').trim().toLowerCase();
  return value === 'shuffle' ? 'shuffle' : 'sequential';
}

function shuffleTracks(tracks) {
  const result = Array.isArray(tracks) ? tracks.slice() : [];
  for (let index = result.length - 1; index > 0; index--) {
    const picked = crypto.randomInt(index + 1);
    [result[index], result[picked]] = [result[picked], result[index]];
  }
  return result;
}

function isLiteVideoMode(mode) {
  return mode === 'lite_video';
}

function isBalancedGenerationMode(mode) {
  return mode === 'fast';
}

function isUltraFastGenerationMode(mode) {
  return mode === 'ultra_fast';
}

function getLyricsForGeneration(adapter, songId, cookie, mode) {
  if (isUltraFastGenerationMode(mode)) return Promise.resolve('');
  return adapter.getLyrics(songId, cookie);
}

function getRenderQuerySuffix(mode, quality, resolution, fps) {
  const profile = resolveGenerationProfile({ mode, quality, resolution, fps }, { allowLiteVideo: true });
  const params = new URLSearchParams();
  if (profile.mode) params.set('mode', profile.mode);
  params.set('quality', profile.quality);
  params.set('resolution', profile.resolution);
  params.set('fps', String(profile.fps));
  return `?${params.toString()}`;
}

function getPlaylistCacheKey(playlistId, source) {
  if (source === 'qq') return `qq:${String(playlistId || '')}`;
  return String(playlistId || '');
}

function getSongIdForTrack(song, source) {
  if (source === 'qq') {
    return String((song && (song.mid || song.id)) || '').trim();
  }
  return String((song && song.id) || '').trim();
}

function isValidSongIdForSource(songId, source) {
  const raw = String(songId || '').trim();
  if (!raw) return false;
  if (source === 'qq') {
    return /^[A-Za-z0-9]+$/.test(raw) && raw.length <= 64;
  }
  return isValidNumericId(raw);
}

function getScopedSongCacheKey(songId, source, mode, quality, resolution, fps, renderContext = null) {
  const sid = String(songId || '').trim();
  const src = source === 'qq' ? 'qq' : 'netease';
  const profile = resolveGenerationProfile({ mode, quality, resolution, fps }, { allowLiteVideo: true });
  const modeKey = isUltraFastGenerationMode(profile.mode)
    ? 'ultra_fast'
    : (isBalancedGenerationMode(profile.mode) ? 'fast' : (isLiteVideoMode(profile.mode) ? 'lite_video' : 'default'));
  const base = `${src}:${modeKey}:${profile.quality}:${profile.resolution}:${profile.fps}fps:${sid}`;
  if (!renderContext || !renderContext.playlistId) return base;
  const identity = JSON.stringify({
    playlistId: String(renderContext.playlistId),
    order: renderContext.order === 'shuffle' ? 'shuffle' : 'sequential',
    currentIndex: Math.max(1, Number(renderContext.currentIndex) || 1),
    totalTracks: Math.max(1, Number(renderContext.totalTracks) || 1),
    collectionName: String(renderContext.collectionName || ''),
    collectionCreator: String(renderContext.collectionCreator || '')
  });
  const contextHash = crypto.createHash('sha1').update(identity).digest('hex').slice(0, 12);
  return `${base}:ctx${contextHash}`;
}

function createSongRenderContext(job, currentIndex, totalTracks) {
  const total = Math.max(1, Number(totalTracks) || 1);
  return {
    playlistId: String(job.playlistId || ''),
    order: job.order === 'shuffle' ? 'shuffle' : 'sequential',
    collectionType: job.collectionType === 'album' ? 'album' : 'playlist',
    collectionName: String(job.playlistName || ''),
    collectionCreator: String(job.playlistCreator || ''),
    currentIndex: Math.max(1, Number(currentIndex) || 1),
    totalTracks: total,
    showCollection: total > 1
  };
}

function getProfileFromSongCacheKey(songCacheKey) {
  const parts = String(songCacheKey || '').split(':');
  const mode = parts[1] === 'ultra_fast'
    ? 'ultra_fast'
    : (parts[1] === 'fast' ? 'fast' : (parts[1] === 'lite_video' ? 'lite_video' : ''));
  return resolveGenerationProfile({
    mode,
    quality: normalizeGenerationQuality(parts[2]),
    resolution: normalizeGenerationResolution(parts[3]),
    fps: normalizeGenerationFps(String(parts[4] || '').replace(/fps$/i, ''), mode)
  }, { allowLiteVideo: true });
}

function getSegmentBasePathForReq(req, token, playlistId) {
  const source = getSourceFromReq(req);
  if (source === 'qq') {
    return `/api/qq/hls/${encodeURIComponent(token)}/${encodeURIComponent(playlistId)}`;
  }
  return `/api/hls/${encodeURIComponent(token)}/${encodeURIComponent(playlistId)}`;
}

function getSourceAdapter(source) {
  if (source === 'qq') {
    return {
      source: 'qq',
      getSongUrl: (songId, cookie, quality) => qqmusic.getSongUrl(String(songId), cookie, quality),
      getLyrics: (songId, cookie) => qqmusic.getLyrics(String(songId), cookie),
      getPlaylistDetail: (playlistId, cookie) => qqmusic.getPlaylistDetail(String(playlistId), cookie),
      toPlayLogPlaylistId: (playlistId) => `qq:${String(playlistId)}`,
      toPlayLogSongId: (songId) => `qq:${String(songId)}`
    };
  }
  return {
    source: 'netease',
    getSongUrl: (songId, cookie, quality) => netease.getSongUrl(String(songId), cookie, quality),
    getLyrics: (songId, cookie) => netease.getLyrics(String(songId), cookie),
    getPlaylistDetail: (playlistId, cookie) => netease.getPlaylistDetail(String(playlistId), cookie),
    toPlayLogPlaylistId: (playlistId) => String(playlistId),
    toPlayLogSongId: (songId) => String(songId)
  };
}

function cachePlaylistDetail(playlistId, source, playlist) {
  if (!playlist) return;
  const ttlSec = parseInt(process.env.CACHE_TTL, 10) || 86400;
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const playlistName = String(playlist.name || '');
  const playlistCreator = String(playlist.creator || '');
  const tracks = Array.isArray(playlist.tracks)
    ? playlist.tracks.map((track) => ({
        ...track,
        _collectionName: playlistName,
        _collectionCreator: playlistCreator
      }))
    : [];
  playlistOps.set.run({
    playlist_id: getPlaylistCacheKey(playlistId, source),
    name: playlistName,
    cover: playlist.cover || '',
    song_count: playlist.songCount || tracks.length || 0,
    songs: JSON.stringify(tracks),
    expires_at: expiresAt
  });
}

function readCachedPlaylistDetail(playlistId, source) {
  const cached = playlistOps.get.get(getPlaylistCacheKey(playlistId, source));
  if (!cached) return null;
  try {
    const tracks = JSON.parse(cached.songs || '[]');
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    return {
      id: String(playlistId),
      name: cached.name || '',
      cover: cached.cover || '',
      creator: tracks[0]?._collectionCreator || '',
      songCount: Number(cached.song_count) || tracks.length,
      tracks
    };
  } catch (_) {
    return null;
  }
}

function isValidSegmentIndex(index) {
  const num = parseInt(index);
  return !isNaN(num) && num >= 0 && num < 10000;
}

function adminAuth(req, res, next) {
  const adminEnabled =
    process.env.HLS_ADMIN_ENABLED === '1' ||
    process.env.HLS_ADMIN_ENABLED === 'true';

  if (!adminEnabled) {
    return res.status(503).json({
      error: '管理接口已禁用',
      message: '需要显式设置 HLS_ADMIN_ENABLED=1 并配置 ADMIN_PASSWORD 才能启用管理接口'
    });
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return res.status(503).json({
      error: '管理接口已禁用',
      message: '请配置 ADMIN_PASSWORD 后再启用管理接口'
    });
  }

  const providedPassword = req.headers['x-admin-password'];
  if (providedPassword !== adminPassword) {
    return res.status(401).json({ error: '管理员密码错误或未提供' });
  }

  next();
}

const HLS_DIR = path.join(__dirname, '..', 'data', 'hls');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');

if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, { recursive: true });
}
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function envNumber(key) {
  const raw = process.env[key];
  if (raw == null || raw === '') return NaN;
  const num = Number(raw);
  return Number.isFinite(num) ? num : NaN;
}

const maxSizeBytesFromEnv = envNumber('HLS_CACHE_MAX_SIZE');
const maxSizeGBFromEnv = envNumber('HLS_CACHE_MAX_SIZE_GB');
const maxAgeHoursFromEnv = envNumber('HLS_CACHE_MAX_AGE_HOURS');
const cleanupIntervalMinutesFromEnv = envNumber('HLS_CACHE_CLEANUP_INTERVAL_MINUTES');
const cleanupTargetRatioFromEnv = envNumber('HLS_CACHE_CLEANUP_TARGET_RATIO');

function parseSegmentDuration() {
  const raw = process.env.HLS_SEGMENT_DURATION;
  if (raw == null || raw === '') return 10;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 10;
  if (n < 4) return 4;
  if (n > 60) return 60;
  return n;
}

const CACHE_CONFIG = {
  maxAge: (Number.isFinite(maxAgeHoursFromEnv) && maxAgeHoursFromEnv > 0)
    ? Math.floor(maxAgeHoursFromEnv * 60 * 60 * 1000)
    : 24 * 60 * 60 * 1000,
  maxSize: (Number.isFinite(maxSizeBytesFromEnv) && maxSizeBytesFromEnv > 0)
    ? Math.floor(maxSizeBytesFromEnv)
    : ((Number.isFinite(maxSizeGBFromEnv) && maxSizeGBFromEnv > 0)
      ? Math.floor(maxSizeGBFromEnv * 1024 * 1024 * 1024)
      : 5 * 1024 * 1024 * 1024),
  cleanupInterval: (Number.isFinite(cleanupIntervalMinutesFromEnv) && cleanupIntervalMinutesFromEnv > 0)
    ? Math.floor(cleanupIntervalMinutesFromEnv * 60 * 1000)
    : 60 * 60 * 1000,
  cleanupToRatio: (Number.isFinite(cleanupTargetRatioFromEnv) && cleanupTargetRatioFromEnv > 0 && cleanupTargetRatioFromEnv < 1)
    ? cleanupTargetRatioFromEnv
    : 0.8,
  autoPreloadCount: parseInt(process.env.HLS_AUTO_PRELOAD_COUNT, 10) || 1,
  segmentDuration: parseSegmentDuration(),
};

const LOG_VERBOSE = process.env.LOG_HLS_VERBOSE === '1' || process.env.LOG_HLS_VERBOSE === 'true';

const CACHE_VERSION = 25;

const DEFAULT_COVER_URL =
  process.env.DEFAULT_COVER_URL ||
  'https://p1.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg';

const COVER_OUTPUT = {
  width: Math.max(640, parseInt(process.env.COVER_WIDTH, 10) || 1920),
  height: Math.max(360, parseInt(process.env.COVER_HEIGHT, 10) || 1080)
};

const COVER_FPS = (() => {
  const raw = process.env.COVER_FPS;
  if (raw == null || raw === '') return 5;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 30) return n;
  return 5;
})();

const VIDEO_VISUAL_FPS = Math.max(
  5,
  Math.min(30, parseInt(process.env.VIDEO_VISUAL_FPS, 10) || COVER_FPS)
);

const HLS_FFMPEG_THREADS = (() => {
  const raw = process.env.HLS_FFMPEG_THREADS;
  if (raw == null || raw === '') return 0;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 64) return n;
  return 0;
})();

function optimizeNeteaseCoverUrl(rawUrl, size = 1080) {
  const url = (rawUrl == null) ? '' : String(rawUrl).trim();
  if (!/^https?:\/\//i.test(url)) return '';
  try {
    const u = new URL(url);
    if (!/^p\d+\.music\.126\.net$/i.test(u.hostname)) return url;
    u.searchParams.set('param', `${size}y${size}`);
    return u.toString();
  } catch (_) {
    return url;
  }
}

function pickCoverUrlForSong(song, playlistCoverUrl) {
  const songCover = song && song.cover ? String(song.cover) : '';
  const base = songCover || playlistCoverUrl || DEFAULT_COVER_URL;
  return optimizeNeteaseCoverUrl(base, 1080) || DEFAULT_COVER_URL;
}

const JOB_LIMITS = {
  maxConcurrentJobs: Math.max(1, Math.min(16, parseInt(process.env.HLS_MAX_CONCURRENT_JOBS, 10) || 16)),
  maxQueueSize: parseInt(process.env.HLS_MAX_QUEUE) || 20,
  downloadTimeout: parseInt(process.env.HLS_DOWNLOAD_TIMEOUT) || 60000,
  downloadMaxSize: parseInt(process.env.HLS_DOWNLOAD_MAX_SIZE) || 100 * 1024 * 1024,
  downloadMaxRedirects: 5,
  ffmpegTimeout: parseInt(process.env.HLS_FFMPEG_TIMEOUT) || 180000,
};

const DEFAULT_DOWNLOAD_ALLOW_PATTERNS = [
  /^m\d+[a-z]*\.music\.126\.net$/i,
  /^p\d+\.music\.126\.net$/i,
  /^music\.126\.net$/i,
  // QQ 音乐域名
  /^[a-z0-9]+\.y\.qq\.com$/i,
  /^y\.gtimg\.cn$/i,
  /^[a-z0-9]+\.stream\.qqmusic\.qq\.com$/i,
  /^dl\.stream\.qqmusic\.qq\.com$/i,
  /^isure\.stream\.qqmusic\.qq\.com$/i,
  /^ws\.stream\.qqmusic\.qq\.com$/i,
  /^[a-z0-9-]+\.mcobj\.com$/i,
];

function parseExtraAllowPatterns() {
  const extra = process.env.HLS_DOWNLOAD_ALLOW_HOSTS;
  if (!extra) return [];
  return extra.split(',').map(s => s.trim()).filter(Boolean).map(pattern => {
    try {
      return new RegExp(pattern, 'i');
    } catch (e) {
      console.warn(`[HLS] 无效的 HLS_DOWNLOAD_ALLOW_HOSTS 模式: ${pattern}`);
      return null;
    }
  }).filter(Boolean);
}

const DOWNLOAD_ALLOW_PATTERNS = [...DEFAULT_DOWNLOAD_ALLOW_PATTERNS, ...parseExtraAllowPatterns()];

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 50 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 50 });

function isDownloadUrlAllowed(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    return { allowed: false, reason: 'Invalid URL' };
  }
  
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { allowed: false, reason: `Protocol not allowed: ${u.protocol}` };
  }
  
  const hostname = u.hostname.toLowerCase();
  const matched = DOWNLOAD_ALLOW_PATTERNS.some(pattern => pattern.test(hostname));
  if (!matched) {
    return { allowed: false, reason: `Host not allowed: ${hostname}` };
  }
  
  return { allowed: true };
}

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  
  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return true;
    }
  
    if (this.queue.length >= JOB_LIMITS.maxQueueSize) {
      return false;
    }
    
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
  
  release() {
    this.current--;
    if (this.queue.length > 0 && this.current < this.max) {
      this.current++;
      const next = this.queue.shift();
      next(true);
    }
  }
  
  get waiting() {
    return this.queue.length;
  }
  
  get running() {
    return this.current;
  }
}

const jobSemaphore = new Semaphore(JOB_LIMITS.maxConcurrentJobs);

const generatingLocks = new Map();
const protectedSongCacheKeys = new Map();

function protectSongCacheForJob(job, songCacheKey) {
  const key = String(songCacheKey || '');
  if (!key) return;
  if (!(job.protectedCacheKeys instanceof Set)) job.protectedCacheKeys = new Set();
  if (job.protectedCacheKeys.has(key)) return;
  job.protectedCacheKeys.add(key);
  protectedSongCacheKeys.set(key, (protectedSongCacheKeys.get(key) || 0) + 1);
}

function releaseProtectedSongCaches(job) {
  if (!(job.protectedCacheKeys instanceof Set)) return;
  for (const key of job.protectedCacheKeys) {
    const remaining = (protectedSongCacheKeys.get(key) || 0) - 1;
    if (remaining > 0) protectedSongCacheKeys.set(key, remaining);
    else protectedSongCacheKeys.delete(key);
  }
  job.protectedCacheKeys.clear();
}

function isSongCacheProtected(songCacheKey) {
  return (protectedSongCacheKeys.get(String(songCacheKey || '')) || 0) > 0;
}

const preloadingPlaylists = new Set();

const playlistGenerationJobs = new Map();
const activePlaylistGenerationJobs = new Map();
const playlistGenerationQueue = new SerialJobQueue();
const playlistUploadQueue = new SerialJobQueue();
const GENERATION_JOB_TTL_MS = 6 * 60 * 60 * 1000;

function isGenerationJobTerminal(job) {
  return ['completed', 'failed', 'cancelled', 'upload_failed'].includes(job?.status);
}

function isGenerationJobActive(job) {
  return ['queued', 'running', 'finalizing', 'cancelling', 'waiting_upload', 'uploading', 'resolving_link'].includes(job?.status);
}

const songSegmentInfo = new Map();
const SEGMENT_INFO_MAX = 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, promise] of generatingLocks.entries()) {
    if (promise._createdAt && now - promise._createdAt > 60 * 60 * 1000) {
      generatingLocks.delete(key);
    }
  }
  
  if (preloadingPlaylists.size > 100) {
    preloadingPlaylists.clear();
  }
  
  if (songSegmentInfo.size > SEGMENT_INFO_MAX) {
    const toDelete = Math.ceil(songSegmentInfo.size * 0.2);
    let deleted = 0;
    for (const key of songSegmentInfo.keys()) {
      if (deleted >= toDelete) break;
      songSegmentInfo.delete(key);
      deleted++;
    }
    console.log(`[HLS] songSegmentInfo 超限，已清理 ${deleted} 条`);
  }

  for (const [jobId, job] of playlistGenerationJobs.entries()) {
    if (isGenerationJobTerminal(job) && now - job.updatedAt > GENERATION_JOB_TTL_MS) {
      playlistGenerationJobs.delete(jobId);
    }
  }
}, 10 * 60 * 1000);

function findFFmpeg() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch (e) {}
  
  if (os.platform() === 'win32') {
    const wingetPath = path.join(
      process.env.LOCALAPPDATA || '',
      'Microsoft', 'WinGet', 'Packages'
    );
    if (fs.existsSync(wingetPath)) {
      const searchFFmpeg = (dir) => {
        try {
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              const result = searchFFmpeg(fullPath);
              if (result) return result;
            } else if (item === 'ffmpeg.exe') {
              return fullPath;
            }
          }
        } catch (e) {}
        return null;
      };
      const found = searchFFmpeg(wingetPath);
      if (found) return found;
    }
    
    const commonPaths = [
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      path.join(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey', 'bin', 'ffmpeg.exe')
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) return p;
    }
  }
  
  return 'ffmpeg';
}

const FFMPEG_PATH = findFFmpeg();
console.log('FFmpeg路径:', FFMPEG_PATH);
const VIDEO_ENCODER = detectVideoEncoder(FFMPEG_PATH);
console.log(`视频编码器: ${VIDEO_ENCODER.label}${VIDEO_ENCODER.hardware ? ' (GPU)' : ' (CPU)'}`);

const TEMP_DIR = path.join(__dirname, '..', 'data', 'temp');
const PLAYLIST_MP4_DIR = path.join(__dirname, '..', 'data', 'playlist-mp4');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}
if (!fs.existsSync(PLAYLIST_MP4_DIR)) {
  fs.mkdirSync(PLAYLIST_MP4_DIR, { recursive: true });
}

function toFsCacheKey(songCacheKey) {
  return encodeURIComponent(String(songCacheKey || ''));
}

function fromFsCacheKey(fsKey) {
  try {
    return decodeURIComponent(String(fsKey || ''));
  } catch (_) {
    return String(fsKey || '');
  }
}

function getSongCacheDir(songCacheKey) {
  return path.join(CACHE_DIR, toFsCacheKey(songCacheKey));
}

function getSegmentPath(songCacheKey, segmentIndex) {
  return path.join(getSongCacheDir(songCacheKey), `seg_${String(segmentIndex).padStart(4, '0')}.ts`);
}

function getSegmentInfoPath(songCacheKey) {
  return path.join(getSongCacheDir(songCacheKey), 'info.json');
}

function getPlaylistMp4Path(source, playlistId, mode = '', quality = 'high', playlistName = '', order = 'sequential', resolution = '1920x1080', fps = 15) {
  const options = {
    name: playlistName,
    source,
    mode,
    quality,
    resolution,
    fps,
    order,
    playlistId,
    version: CACHE_VERSION
  };
  return path.join(PLAYLIST_MP4_DIR, buildPlaylistOutputFilename(options));
}

function findPlaylistMp4Path(source, playlistId, mode = '', quality = 'high', playlistName = '', order = 'sequential', resolution = '1920x1080', fps = 15) {
  const preferred = getPlaylistMp4Path(source, playlistId, mode, quality, playlistName, order, resolution, fps);
  if (fs.existsSync(preferred)) return preferred;
  const options = { source, mode, quality, name: playlistName, resolution, fps, order, playlistId, version: CACHE_VERSION };
  const legacyStorageKey = playlistOutputIdentity(options).replace(/\.mp4$/i, '');
  const legacyPreferred = path.join(PLAYLIST_MP4_DIR, legacyStorageKey, buildPlaylistOutputFilename(options));
  if (fs.existsSync(legacyPreferred)) return legacyPreferred;
  const suffix = buildPlaylistOutputSuffix(options);
  try {
    const matches = fs.readdirSync(PLAYLIST_MP4_DIR)
      .filter((name) => name.endsWith(suffix))
      .map((name) => path.join(PLAYLIST_MP4_DIR, name))
      .filter((filePath) => fs.statSync(filePath).isFile())
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    return matches[0] || preferred;
  } catch (_) {
    return preferred;
  }
}

function isSongCached(songCacheKey) { 
  try { 
    const infoPath = getSegmentInfoPath(songCacheKey); 
    if (!fs.existsSync(infoPath)) return false; 
     
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')); 
    if (info.version !== CACHE_VERSION) return false; 
    const profile = getProfileFromSongCacheKey(songCacheKey);
    if (!info.video || info.video.width !== profile.width || info.video.height !== profile.height) return false;
    if (Number(info.video.fps) !== profile.fps) return false;
    const age = Date.now() - info.timestamp; 
    if (age > CACHE_CONFIG.maxAge) return false; 

    const count = parseInt(info.segmentCount, 10) || 0;
    return count > 0;
  } catch (e) { 
    return false; 
  } 
} 

function getSongSegmentInfo(songId) {
  const key = String(songId);
  const cached = songSegmentInfo.get(key);
  if (cached && cached.version === CACHE_VERSION) return cached;

  try {
    const infoPath = getSegmentInfoPath(key);
    if (!fs.existsSync(infoPath)) return null;
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    if (info.version !== CACHE_VERSION) return null;
    const profile = getProfileFromSongCacheKey(key);
    if (!info.video || info.video.width !== profile.width || info.video.height !== profile.height) return null;
    if (Number(info.video.fps) !== profile.fps) return null;
    songSegmentInfo.set(key, info);
    return info;
  } catch (e) {
    return null;
  }
}

async function statIfValidSegment(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return null;
    if (stat.size <= 1024) return null;
    return stat;
  } catch (e) {
    return null;
  }
}

function formatHttpDate(ms) {
  try {
    return new Date(ms).toUTCString();
  } catch (_) {
    return new Date().toUTCString();
  }
}

function makeWeakEtag(stat) {
  const size = stat?.size || 0;
  const mtimeMs = Math.floor(stat?.mtimeMs || Date.now());
  return `W/\"${size}-${mtimeMs}\"`;
}

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

async function safeReadJson(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function getSongDirSizeBytes(songDir) {
  try {
    const files = await fs.promises.readdir(songDir, { withFileTypes: true });
    let totalSize = 0;
    for (const entry of files) {
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.promises.stat(path.join(songDir, entry.name));
        totalSize += stat.size;
      } catch (_) {}
    }
    return totalSize;
  } catch (e) {
    return 0;
  }
}
 
let cacheCleanupRunning = false; 
let cacheCleanupScheduled = false; 
 
async function cleanupCache(reason = 'interval') { 
  if (cacheCleanupRunning) return; 
  cacheCleanupRunning = true; 
  try { 
    const dirents = await fs.promises.readdir(CACHE_DIR, { withFileTypes: true }); 
    const songInfos = []; 

    for (let i = 0; i < dirents.length; i++) { 
      const entry = dirents[i]; 
      if (!entry.isDirectory()) continue; 
      const songId = fromFsCacheKey(entry.name);
      if (generatingLocks.has(songId) || isSongCacheProtected(songId)) continue;

      // 跳过最近 30 秒内生成的缓存，避免刚生成就被清理的竞态
      const RECENTLY_GENERATED_GRACE_MS = 30 * 1000;

      const songDir = path.join(CACHE_DIR, entry.name); 
      const infoPath = path.join(songDir, 'info.json'); 

      let timestamp = 0; 
      let sizeBytes = 0; 

      const info = await safeReadJson(infoPath); 
      if (info) { 
        timestamp = Number(info.timestamp) || 0; 
        sizeBytes = Number(info.cacheBytes) || 0; 
      } 

      if (!timestamp) {
        try {
          const stat = await fs.promises.stat(songDir);
          timestamp = stat.mtimeMs || 0;
        } catch (_) {
          continue;
        }
      }

      // 跳过刚生成的缓存目录，防止 after-generate cleanup 竞态删除
      if (Date.now() - timestamp < RECENTLY_GENERATED_GRACE_MS) continue;

      songInfos.push({ songId, path: songDir, timestamp, sizeBytes }); 

      if (i > 0 && i % 25 === 0) { 
        await yieldToEventLoop(); 
      } 
    } 

    const now = Date.now(); 
    let deleted = 0; 
    let freedSize = 0; 

    async function deleteSongDir(info) { 
      if (generatingLocks.has(info.songId) || isSongCacheProtected(info.songId)) return 0;
      try { 
        if (!info.sizeBytes) {
          info.sizeBytes = await getSongDirSizeBytes(info.path);
        }
        await fs.promises.rm(info.path, { recursive: true, force: true }); 
        songSegmentInfo.delete(info.songId); 
        deleted++; 
        const freed = Number(info.sizeBytes) || 0; 
        freedSize += freed; 
        return freed; 
      } catch (e) { 
        console.error(`删除过期缓存失败 ${info.songId}:`, e?.message || e); 
        return 0; 
      } 
    } 

    const remaining = []; 
    for (let i = 0; i < songInfos.length; i++) { 
      const info = songInfos[i]; 
      if (now - info.timestamp > CACHE_CONFIG.maxAge) { 
        await deleteSongDir(info); 
      } else { 
        remaining.push(info); 
      } 
      if (i > 0 && i % 20 === 0) await yieldToEventLoop(); 
    } 

    // 计算总大小：优先使用 info.json 里的 cacheBytes，否则才扫描目录
    let totalSize = 0; 
    for (let i = 0; i < remaining.length; i++) { 
      const info = remaining[i]; 
      if (!info.sizeBytes) { 
        info.sizeBytes = await getSongDirSizeBytes(info.path); 
      } 
      totalSize += info.sizeBytes; 
      if (i > 0 && i % 10 === 0) await yieldToEventLoop(); 
    } 

    if (totalSize > CACHE_CONFIG.maxSize) { 
      const targetSize = CACHE_CONFIG.maxSize * CACHE_CONFIG.cleanupToRatio; 
      remaining.sort((a, b) => a.timestamp - b.timestamp); 

      for (let i = 0; i < remaining.length; i++) { 
        if (totalSize <= targetSize) break; 
        const info = remaining[i]; 
        if (generatingLocks.has(info.songId) || isSongCacheProtected(info.songId)) continue;
        const freed = await deleteSongDir(info); 
        totalSize -= freed || 0; 
        if (i > 0 && i % 10 === 0) await yieldToEventLoop(); 
      } 
    } 

    if (deleted > 0) { 
      console.log(`缓存清理完成(${reason})，删除了 ${deleted} 首歌曲缓存，释放 ${(freedSize / 1024 / 1024).toFixed(2)} MB`); 
    } 
  } catch (e) { 
    console.error('缓存清理失败:', e?.message || e); 
  } finally { 
    cacheCleanupRunning = false; 
  } 
} 

function scheduleCacheCleanup(reason = 'scheduled') { 
  if (cacheCleanupScheduled) return; 
  cacheCleanupScheduled = true; 
  setTimeout(() => { 
    cacheCleanupScheduled = false; 
    cleanupCache(reason).catch((e) => {
      console.error('缓存清理失败:', e?.message || e);
    }); 
  }, 1000); 
} 
 
setInterval(() => {
  cleanupCache('interval').catch(() => {});
}, CACHE_CONFIG.cleanupInterval); 
setTimeout(() => scheduleCacheCleanup('startup'), 5000); 

async function generateSongSegments(songCacheKey, audioUrl, coverUrl, songDuration, track = {}, lyricsText = '', onProgress, control = null, renderContext = {}) {
  if (control?.isCancelled?.()) throw generationCancelledError();
  const acquired = await jobSemaphore.acquire();
  if (!acquired) {
    throw new Error('服务繁忙，请稍后重试');
  }
  
  const timestamp = Date.now();
  const safeTempKey = toFsCacheKey(songCacheKey);
  const tempAudio = path.join(TEMP_DIR, `${safeTempKey}_${timestamp}.mp3`);
  const tempCover = path.join(TEMP_DIR, `${safeTempKey}_${timestamp}.jpg`);
  const songCacheDir = getSongCacheDir(songCacheKey);
  const tempM3u8 = path.join(TEMP_DIR, `${safeTempKey}_${timestamp}.m3u8`);
  const tempSegmentPattern = path.join(TEMP_DIR, `${safeTempKey}_${timestamp}_seg_%04d.ts`);
  const visualBase = path.join(TEMP_DIR, `${safeTempKey}_${timestamp}`);
  const renderProfile = getProfileFromSongCacheKey(songCacheKey);
  const balancedMode = isBalancedGenerationMode(renderProfile.mode);
  const ultraFastMode = isUltraFastGenerationMode(renderProfile.mode);
  const staticMode = balancedMode || ultraFastMode;
  const effectiveFps = renderProfile.fps;
  const textAssets = createTextAssets(visualBase, track, '', {
    width: renderProfile.width,
    height: renderProfile.height,
    truncate: staticMode,
    ...renderContext
  });
  const lyricsFile = `${visualBase}_lyrics.ass`;
  const effectiveDuration = Math.max(1, Number(songDuration) || Number(track.duration) || 240);
  const lyricsResult = createLyricsAss(lyricsFile, ultraFastMode ? '' : lyricsText, {
    width: renderProfile.width,
    height: renderProfile.height,
    duration: effectiveDuration,
    hardCut: staticMode
  });
  
  const cleanup = () => {
    fs.unlink(tempAudio, () => {});
    fs.unlink(tempCover, () => {});
    fs.unlink(tempM3u8, () => {});
    removeTextAssets(textAssets);
    fs.unlink(lyricsFile, () => {});
    try {
      const tempFiles = fs.readdirSync(TEMP_DIR);
      for (const f of tempFiles) {
        if (f.startsWith(`${safeTempKey}_${timestamp}_seg_`)) {
          fs.unlinkSync(path.join(TEMP_DIR, f));
        }
      }
    } catch (e) {}
  };
  
  const releaseAndCleanup = () => {
    cleanup();
    jobSemaphore.release();
  };
  
  try {
    if (control?.isCancelled?.()) throw generationCancelledError();
    if (!fs.existsSync(songCacheDir)) {
      fs.mkdirSync(songCacheDir, { recursive: true });
    }
    
    if (LOG_VERBOSE) console.log(`[分片缓存] 正在下载: ${songCacheKey} (并发: ${jobSemaphore.running}/${JOB_LIMITS.maxConcurrentJobs}, 等待: ${jobSemaphore.waiting})`);
    await Promise.all([
      downloadFile(audioUrl, tempAudio),
      downloadFile(coverUrl, tempCover)
    ]);
    if (control?.isCancelled?.()) throw generationCancelledError();
    
    if (LOG_VERBOSE) console.log(`[分片缓存] 正在转码并分片: ${songCacheKey}`);
    
    const info = await runFFmpegTranscode({
      songCacheKey,
      safeTempKey,
      timestamp,
      tempAudio,
      tempCover,
      tempM3u8,
      tempSegmentPattern,
      songCacheDir,
      textAssets,
      lyricsFile,
      duration: effectiveDuration,
      width: renderProfile.width,
      height: renderProfile.height,
      fps: effectiveFps,
      audioBitrate: getGenerationAudioBitrate(renderProfile.quality),
      staticMode,
      ultraFastMode,
      hasLyrics: !ultraFastMode && lyricsResult.cueCount > 0,
      showCollection: textAssets.showCollection,
      onProgress,
      control
    });
    
    scheduleCacheCleanup('after-generate');
    
    releaseAndCleanup();
    return info;
    
  } catch (e) {
    releaseAndCleanup();
    throw e;
  }
}

function runFFmpegTranscode({ songCacheKey, safeTempKey, timestamp, tempAudio, tempCover, tempM3u8, tempSegmentPattern, songCacheDir, textAssets, lyricsFile, duration, width, height, fps, audioBitrate, staticMode, ultraFastMode, hasLyrics, showCollection, onProgress, control }) {
  return new Promise((resolve, reject) => {
    const segmentDuration = CACHE_CONFIG.segmentDuration;
    const frameRate = Math.max(1, Math.round(Number(fps) || VIDEO_VISUAL_FPS));
    const gop = Math.max(1, Math.round(frameRate * segmentDuration));
    let stallTimer = null;
    let ffmpegKilled = false;
    let ffmpegError = '';
    let lastActivityAt = Date.now();

    function markActivity() {
      lastActivityAt = Date.now();
    }
    
    const visualFilter = buildVisualFilter({
      width,
      height,
      fps: frameRate,
      duration,
      textFiles: textAssets.files,
      lyricsFile,
      staticText: staticMode === true,
      disableFade: staticMode === true,
      durationOnly: ultraFastMode === true,
      singleFrame: ultraFastMode === true,
      hasLyrics: ultraFastMode ? false : hasLyrics === true,
      showCollection: showCollection === true
    });

    const ffmpegArgs = [
      '-loop', '1',
      '-framerate', String(frameRate),
      '-i', tempCover,
      '-i', tempAudio,
      '-filter_complex', visualFilter,
      '-map', '[vout]',
      '-map', '1:a:0',
    ];

    if (HLS_FFMPEG_THREADS > 0) {
      ffmpegArgs.push('-filter_complex_threads', String(HLS_FFMPEG_THREADS));
      if (!VIDEO_ENCODER.hardware) ffmpegArgs.push('-threads', String(HLS_FFMPEG_THREADS));
    }

    ffmpegArgs.push(
      ...VIDEO_ENCODER.args,
      '-r', String(frameRate),
      '-g', String(gop),
      '-keyint_min', String(gop),
      '-sc_threshold', '0',
      '-force_key_frames', `expr:gte(t,n_forced*${segmentDuration})`,
      '-c:a', 'aac',
      '-b:a', String(audioBitrate || '192k'),
      '-ar', '44100',
      '-ac', '2',
      '-af', 'aresample=async=1:first_pts=0',
      '-pix_fmt', VIDEO_ENCODER.pixelFormat,
      '-shortest',
      '-f', 'hls',
      '-muxdelay', '0',
      '-muxpreload', '0',
      '-hls_time', String(segmentDuration),
      '-hls_list_size', '0',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', tempSegmentPattern,
      '-y',
      tempM3u8
    );

    const ffmpegProcess = spawn(FFMPEG_PATH, ffmpegArgs);
    control?.registerProcess?.(ffmpegProcess);
    if (control?.isCancelled?.()) {
      try { ffmpegProcess.kill('SIGKILL'); } catch (_) {}
    }
    
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      ffmpegError += output;
      markActivity();
      if (typeof onProgress === 'function') {
        const matches = Array.from(output.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g));
        const match = matches[matches.length - 1];
        if (match) {
          const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
          onProgress(Math.max(0, Math.min(0.99, seconds / Math.max(1, duration))));
        }
      }
    });
    
    // 用“无输出/无进展超时”替代固定总时长超时：弱机器或长歌转码可能超过固定阈值，但只要持续输出进度就不应被杀。
    // JOB_LIMITS.ffmpegTimeout 继续由 HLS_FFMPEG_TIMEOUT 控制（默认 180000ms）。
    stallTimer = setInterval(() => {
      if (ffmpegKilled) return;
      if (Date.now() - lastActivityAt <= JOB_LIMITS.ffmpegTimeout) return;
      ffmpegKilled = true;
      try { ffmpegProcess.kill('SIGKILL'); } catch (_) {}
      console.error(`[分片缓存] FFmpeg无输出超时被终止: ${songCacheKey}`);
    }, 1000);
    
    ffmpegProcess.on('error', (err) => {
      clearInterval(stallTimer);
      control?.unregisterProcess?.(ffmpegProcess);
      reject(control?.isCancelled?.() ? generationCancelledError() : err);
    });
    
    ffmpegProcess.on('close', (code) => {
      clearInterval(stallTimer);
      control?.unregisterProcess?.(ffmpegProcess);

      if (control?.isCancelled?.()) {
        reject(generationCancelledError());
        return;
      }
      
      if (ffmpegKilled) {
        reject(new Error('FFmpeg无输出超时'));
        return;
      }
      
      if (code !== 0) {
        reject(new Error(`FFmpeg退出码: ${code}, 错误: ${ffmpegError.substring(0, 300)}`));
        return;
      }
      
      try {
        const m3u8Content = fs.readFileSync(tempM3u8, 'utf8');
        const segmentDurations = [];
        const lines = m3u8Content.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#EXTINF:')) {
            const duration = parseFloat(lines[i].replace('#EXTINF:', '').split(',')[0]);
            segmentDurations.push(duration);
          }
        }
        
        const tempFiles = fs.readdirSync(TEMP_DIR); 
        const segmentFiles = tempFiles 
          .filter(f => f.startsWith(`${safeTempKey}_${timestamp}_seg_`) && f.endsWith('.ts')) 
          .sort(); 

        let cacheBytes = 0;
        for (let i = 0; i < segmentFiles.length; i++) { 
          const srcPath = path.join(TEMP_DIR, segmentFiles[i]); 
          const destPath = getSegmentPath(songCacheKey, i); 
          try { 
            const stat = fs.statSync(srcPath); 
            cacheBytes += stat.size || 0; 
          } catch (_) {} 
          fs.renameSync(srcPath, destPath); 
        } 
         
        const info = { 
          version: CACHE_VERSION, 
          songId: songCacheKey, 
          segmentCount: segmentFiles.length, 
          segmentDurations: segmentDurations, 
          totalDuration: segmentDurations.reduce((a, b) => a + b, 0), 
          cacheBytes,
          video: { width, height, fps: frameRate },
          timestamp: Date.now() 
        }; 
        fs.writeFileSync(getSegmentInfoPath(songCacheKey), JSON.stringify(info));
        
        songSegmentInfo.set(String(songCacheKey), info);
        
        if (LOG_VERBOSE) console.log(`[分片缓存] 完成: ${songCacheKey}, ${segmentFiles.length}个分片`);
        resolve(info);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function autoPreloadInBackground({ songs, cookie, coverUrl, playlistId, source, mode, quality, resolution, fps }) {
  const adapter = getSourceAdapter(source);
  const firstSongId = getSongIdForTrack(Array.isArray(songs) ? songs[0] : null, source);
  const preloadKey = `${source}:${mode}:${quality}:${resolution}:${fps}:${playlistId}_${firstSongId}`;
  if (preloadingPlaylists.has(preloadKey)) {
    return;
  }
  preloadingPlaylists.add(preloadKey);
  
  const list = Array.isArray(songs) ? songs : [];
  const toPreload = list.slice(0, CACHE_CONFIG.autoPreloadCount);
  console.log(`[自动预加载] 开始预加载 ${toPreload.length} 首歌`);
  
  for (const song of toPreload) {
    const rawSongId = getSongIdForTrack(song, source);
    if (!isValidSongIdForSource(rawSongId, source)) {
      continue;
    }
    const songCacheKey = getScopedSongCacheKey(rawSongId, source, mode, quality, resolution, fps);

    if (isSongCached(songCacheKey)) {
      continue;
    }
    
    if (generatingLocks.has(songCacheKey)) {
      continue;
    }
    
    try {
      const [audioUrl, lyricsText] = await Promise.all([
        adapter.getSongUrl(rawSongId, cookie, quality),
        getLyricsForGeneration(adapter, rawSongId, cookie, mode)
      ]);
      if (!audioUrl) {
        console.log(`[自动预加载] 跳过 ${rawSongId}：无法获取URL`);
        continue;
      }
      
      const perSongCover = isLiteVideoMode(mode) ? coverUrl : pickCoverUrlForSong(song, coverUrl);
      const generatePromise = generateSongSegments(songCacheKey, audioUrl, perSongCover, song.duration, song, lyricsText);
      generatePromise._createdAt = Date.now();
      generatingLocks.set(songCacheKey, generatePromise);
      
      await generatePromise;
      generatingLocks.delete(songCacheKey);
      
      console.log(`[自动预加载] 完成: ${song.name}`);
    } catch (e) {
      generatingLocks.delete(songCacheKey);
      console.error(`[自动预加载] 失败 ${rawSongId}:`, e.message);
    }
  }
  
  preloadingPlaylists.delete(preloadKey);
  console.log(`[自动预加载] 全部完成`);
}

async function preloadNextSongs({ playlistId, currentSongId, cookie, source, mode, quality, resolution, fps }) {
  const adapter = getSourceAdapter(source);
  const playlistCacheKey = getPlaylistCacheKey(playlistId, source);
  try {
    const cached = playlistOps.get.get(playlistCacheKey);
    if (!cached) return;
    
    let songs;
    try {
      songs = JSON.parse(cached.songs);
    } catch (parseErr) {
      console.error(`[边播边缓存] 歌单缓存损坏 ${playlistCacheKey}:`, parseErr.message);
      try { playlistOps.clearExpired.run(); } catch (_) {}
      return;
    }
    if (!Array.isArray(songs)) return;
    
    const coverUrl = cached.cover || DEFAULT_COVER_URL;
    
    const currentIndex = songs.findIndex(s => getSongIdForTrack(s, source) === String(currentSongId));
    if (currentIndex === -1) return;
    
    const nextSongs = songs.slice(currentIndex + 1, currentIndex + 3);
    if (nextSongs.length === 0) return;
    
    const preloadKey = `next:${source}:${mode}:${quality}:${resolution}:${fps}:${currentSongId}`;
    if (preloadingPlaylists.has(preloadKey)) return;
    preloadingPlaylists.add(preloadKey);
    
    if (LOG_VERBOSE) console.log(`[边播边缓存] 预加载接下来 ${nextSongs.length} 首`);
    
    for (const song of nextSongs) {
      const rawSongId = getSongIdForTrack(song, source);
      if (!isValidSongIdForSource(rawSongId, source)) continue;
      const songCacheKey = getScopedSongCacheKey(rawSongId, source, mode, quality, resolution, fps);
      if (isSongCached(songCacheKey) || generatingLocks.has(songCacheKey)) {
        continue;
      }
      
      try {
        const [audioUrl, lyricsText] = await Promise.all([
          adapter.getSongUrl(rawSongId, cookie, quality),
          getLyricsForGeneration(adapter, rawSongId, cookie, mode)
        ]);
        if (!audioUrl) continue;
        
        const perSongCover = isLiteVideoMode(mode) ? coverUrl : pickCoverUrlForSong(song, coverUrl);
        const generatePromise = generateSongSegments(songCacheKey, audioUrl, perSongCover, song.duration, song, lyricsText);
        generatePromise._createdAt = Date.now();
        generatingLocks.set(songCacheKey, generatePromise);
        
        await generatePromise;
        generatingLocks.delete(songCacheKey);
        
        if (LOG_VERBOSE) console.log(`[边播边缓存] 完成: ${song.name}`);
      } catch (e) {
        generatingLocks.delete(songCacheKey);
      }
    }
    
    preloadingPlaylists.delete(preloadKey);
  } catch (e) {
    console.error('[边播边缓存] 错误:', e.message);
  }
}

function downloadFileOnce(url, filePath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount >= JOB_LIMITS.downloadMaxRedirects) {
      return reject(new Error('Too many redirects'));
    }
    
    const urlCheck = isDownloadUrlAllowed(url);
    if (!urlCheck.allowed) {
      return reject(new Error(`Download blocked: ${urlCheck.reason}`));
    }
    
    const isHttps = /^https:/i.test(url);
    const protocol = isHttps ? https : http; 
    const options = { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 
        'Referer': 'https://music.163.com/' 
      }, 
      agent: isHttps ? HTTPS_AGENT : HTTP_AGENT,
      timeout: JOB_LIMITS.downloadTimeout 
    }; 
    
    const req = protocol.get(url, options, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        const redirectLocation = response.headers.location;
        if (!redirectLocation) {
          return reject(new Error('Redirect without location'));
        }

        let redirectUrl = '';
        try {
          redirectUrl = new URL(redirectLocation, url).toString();
        } catch (_) {
          return reject(new Error('Redirect with invalid location'));
        }

        const redirectCheck = isDownloadUrlAllowed(redirectUrl);
        if (!redirectCheck.allowed) {
          return reject(new Error(`Redirect blocked: ${redirectCheck.reason}`));
        }
        
        return downloadFileOnce(redirectUrl, filePath, redirectCount + 1).then(resolve).catch(reject);
      }
      
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      
      const contentLength = parseInt(response.headers['content-length']);
      if (contentLength && contentLength > JOB_LIMITS.downloadMaxSize) {
        req.destroy();
        response.resume();
        return reject(new Error(`File too large: ${contentLength} bytes`));
      }

      const file = fs.createWriteStream(filePath);
      let downloadedSize = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        file.destroy();
        response.destroy();
        fs.unlink(filePath, () => {});
        reject(error);
      };
      file.on('error', fail);
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (downloadedSize > JOB_LIMITS.downloadMaxSize) {
          req.destroy();
          fail(new Error(`Download exceeded max size: ${downloadedSize} bytes`));
        }
      });
      response.on('aborted', () => fail(new Error('Download response aborted')));
      response.on('error', fail);
      
      response.pipe(file);
      file.on('finish', () => {
        if (settled) return;
        settled = true;
        file.close((error) => error ? reject(error) : resolve(filePath));
      });
    });
    
    req.on('timeout', () => {
      req.destroy(new Error('Download timeout'));
    });
    
    req.on('error', (err) => {
      fs.unlink(filePath, () => {});
      reject(err);
    });
  });
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, '');
  }
  
  return `${req.protocol}://${req.get('host')}`;
}

function generationJobKey(source, userId, playlistId, mode, quality, resolution, fps, order) {
  return `${source}:${userId}:${playlistId}:${mode || 'default'}:${quality}:${resolution}:${fps}fps:${order === 'shuffle' ? 'shuffle' : 'sequential'}`;
}

function generationStatusPath(source, token, playlistId, jobId) {
  const basePath = source === 'qq' ? '/api/qq/playlist-video' : '/api/playlist-video';
  return `${basePath}/${encodeURIComponent(token)}/${encodeURIComponent(playlistId)}/generate/${encodeURIComponent(jobId)}`;
}

function generationCancelPath(source, token, playlistId, jobId) {
  return `${generationStatusPath(source, token, playlistId, jobId)}/cancel`;
}

function generationCancelledError() {
  const error = new Error('生成已取消');
  error.code = 'GENERATION_CANCELLED';
  return error;
}

function buildPlaylistMp4(job, songs) {
  if (job.cancelRequested) return Promise.reject(generationCancelledError());
  const outputPath = getPlaylistMp4Path(job.source, job.playlistId, job.mode, job.quality, job.playlistName, job.order, job.resolution, job.fps);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempKey = `${job.source}_${job.playlistId}_${job.id}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const listPath = path.join(TEMP_DIR, `${tempKey}_concat.txt`);
  const tempOutput = path.join(TEMP_DIR, `${tempKey}_playlist.mp4`);
  const entries = [];

  for (let songIndex = 0; songIndex < songs.length; songIndex++) {
    if (job.skippedIndexes instanceof Set && job.skippedIndexes.has(songIndex)) continue;
    const song = songs[songIndex];
    const songId = getSongIdForTrack(song, job.source);
    const renderContext = createSongRenderContext(job, songIndex + 1, songs.length);
    const songCacheKey = getScopedSongCacheKey(songId, job.source, job.mode, job.quality, job.resolution, job.fps, renderContext);
    const info = getSongSegmentInfo(songCacheKey);
    if (!info || !Number.isInteger(info.segmentCount) || info.segmentCount < 1) {
      return Promise.reject(new Error(`歌曲 ${songId} 的视频缓存不完整`));
    }
    for (let index = 0; index < info.segmentCount; index++) {
      const segmentPath = getSegmentPath(songCacheKey, index);
      if (!fs.existsSync(segmentPath)) return Promise.reject(new Error(`歌曲 ${songId} 缺少视频片段`));
      entries.push(`file '${segmentPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    }
  }

  if (entries.length === 0) return Promise.reject(new Error('没有可合并的视频片段'));
  fs.writeFileSync(listPath, `${entries.join('\n')}\n`, 'utf8');

  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      job.ffmpegProcesses.delete(process);
      try { fs.unlinkSync(listPath); } catch (_) {}
      if (error) {
        try { fs.unlinkSync(tempOutput); } catch (_) {}
        reject(error);
      } else {
        try {
          const moveResult = moveFileSync(tempOutput, outputPath);
          if (!moveResult.sourceRemoved) {
            console.warn(`[整单生成] MP4 已跨磁盘复制到输出目录，但临时源文件清理失败: ${tempOutput}`);
          }
          resolve(outputPath);
        } catch (moveError) {
          reject(moveError);
        }
      }
    };

    const process = spawn(FFMPEG_PATH, [
      '-hide_banner', '-loglevel', 'warning',
      '-fflags', '+genpts',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-map', '0:v:0', '-map', '0:a:0',
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-y', tempOutput
    ]);
    job.ffmpegProcesses.add(process);
    if (job.cancelRequested) {
      try { process.kill('SIGKILL'); } catch (_) {}
    }
    process.stderr.on('data', (data) => { stderr += data.toString(); });
    process.on('error', (error) => finish(job.cancelRequested ? generationCancelledError() : error));
    process.on('close', (code) => {
      if (job.cancelRequested) return finish(generationCancelledError());
      if (code !== 0) return finish(new Error(`合并 MP4 失败: ${stderr.slice(-500)}`));
      finish();
    });
  });
}

function isRetryableNetworkError(error) {
  const message = String(error?.message || error || '');
  const code = String(error?.code || '');
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|ECONNREFUSED|socket hang up|aborted|Download timeout|HTTP (?:408|425|429|5\d\d)/i
    .test(`${code} ${message}`);
}

async function downloadFile(url, filePath, options = {}) {
  const maxAttempts = Math.max(1, Math.min(5, Number(options.maxAttempts) || 3));
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptPath = `${filePath}.part-${attempt}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await downloadFileOnce(url, attemptPath);
      try { fs.unlinkSync(filePath); } catch (_) {}
      fs.renameSync(attemptPath, filePath);
      return filePath;
    } catch (error) {
      lastError = error;
      try { fs.unlinkSync(attemptPath); } catch (_) {}
      if (attempt >= maxAttempts || !isRetryableNetworkError(error)) throw error;
      const delayMs = 400 * attempt + crypto.randomInt(0, 180);
      console.warn(`[下载重试] 第 ${attempt}/${maxAttempts} 次失败，${delayMs}ms 后重试: ${error?.message || error}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError || new Error('Download failed');
}

function generationJobSnapshot(job) {
  const uploadOnly = job.taskType === 'upload_only';
  const activeSongs = job.activeSongs instanceof Map ? Array.from(job.activeSongs.values()) : [];
  // 单曲进度只能贡献 0~1 首，避免 FFmpeg/复用任务传入百分数时把整单进度虚高。
  const activeProgress = activeSongs.reduce((total, item) => {
    const value = Number(item.progress);
    return total + (Number.isFinite(value) ? Math.max(0, Math.min(0.99, value)) : 0);
  }, 0);
  const renderFinished = Boolean(job.outputPath) || ['completed', 'uploading', 'resolving_link', 'upload_failed'].includes(job.status);
  const skipped = Math.max(0, Number(job.skipped) || 0);
  const processed = Math.min(job.total, job.completed + skipped);
  const fractional = renderFinished
    ? job.total
    : Math.min(job.total * 0.99, processed + activeProgress);
  const renderPercent = job.total > 0 ? Math.max(0, Math.min(100, Math.round(fractional / job.total * 100))) : 0;
  const percent = uploadOnly
    ? (job.status === 'queued' ? 0 : Math.max(0, Math.min(100, Number(job.uploadPercent) || 0)))
    : renderPercent;
  const activeWorkSeconds = activeSongs.reduce((total, item) => {
    const workSeconds = Math.max(0, Number(item.workSeconds) || 0);
    const progress = Math.max(0, Math.min(1, Number(item.progress) || 0));
    return total + workSeconds * progress;
  }, 0);
  const timingJob = job.outputPath && job.renderFinishedAt
    ? { ...job, status: 'completed', finishedAt: job.renderFinishedAt }
    : job;
  const timing = uploadOnly
    ? {
        elapsedSeconds: job.startedAt
          ? Math.max(0, Math.floor(((job.finishedAt || Date.now()) - job.startedAt) / 1000))
          : 0,
        etaSeconds: null
      }
    : estimateGenerationTiming(timingJob, activeWorkSeconds);
  return {
    id: job.id,
    source: job.source,
    playlistId: job.playlistId,
    playlistName: job.playlistName || `歌单 ${job.playlistId}`,
    playlistCover: job.playlistCover || '',
    playlistCreator: job.playlistCreator || '',
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || null,
    status: job.status,
    taskType: uploadOnly ? 'upload_only' : 'generate',
    queuePosition: job.status === 'queued'
      ? (uploadOnly ? playlistUploadQueue.position(job.id) : playlistGenerationQueue.position(job.id))
      : (job.status === 'waiting_upload' ? playlistUploadQueue.position(job.id) : 0),
    total: job.total,
    completed: job.completed,
    processed: uploadOnly ? (job.status === 'completed' ? 1 : 0) : processed,
    skipped,
    skippedSongs: Array.isArray(job.skippedSongs)
      ? job.skippedSongs.slice().sort((left, right) => left.index - right.index)
      : [],
    percent,
    elapsedSeconds: timing.elapsedSeconds,
    etaSeconds: timing.etaSeconds,
    currentSong: activeSongs.map((item) => item.name).filter(Boolean).join('、') || job.currentSong || '',
    message: job.message || '',
    error: job.error || '',
    encoder: VIDEO_ENCODER.label,
    gpu: VIDEO_ENCODER.hardware,
    concurrency: job.concurrency || 1,
    requestedConcurrency: job.requestedConcurrency || job.concurrency || 4,
    order: job.order === 'shuffle' ? 'shuffle' : 'sequential',
    mode: isUltraFastGenerationMode(job.mode)
      ? 'ultra_fast'
      : (isBalancedGenerationMode(job.mode) ? 'fast' : (isLiteVideoMode(job.mode) ? 'lite_video' : '')),
    quality: job.quality,
    resolution: job.resolution,
    fps: job.fps,
    localPath: job.outputPath ? path.resolve(job.outputPath) : '',
    uploadStatus: job.uploadStatus || (job.outputPath ? 'pending' : 'waiting'),
    uploadPercent: Math.max(0, Math.min(100, Number(job.uploadPercent) || 0)),
    uploadMessage: job.uploadMessage || '',
    uploadError: job.uploadError || '',
    publicUrl: job.publicUrl || '',
    shareUrl: job.shareUrl || '',
    statusPath: job.statusPath,
    cancelPath: job.cancelPath,
    canCancel: uploadOnly
      ? job.status === 'queued'
      : ['queued', 'running', 'finalizing', 'waiting_upload', 'cancelling'].includes(job.status),
    canDismiss: isGenerationJobTerminal(job)
  };
}

function recordGenerationHistory(job) {
  try {
    generationHistoryOps.add.run({
      job_id: job.id,
      source: job.source,
      user_id: job.userId,
      playlist_id: job.playlistId,
      playlist_name: job.playlistName || '未命名歌单',
      playlist_cover: job.playlistCover || '',
      playlist_creator: job.playlistCreator || '未知作者',
      generated_at: new Date(job.renderFinishedAt || Date.now()).toISOString(),
      generation_seconds: Math.max(0, Math.round(((job.renderFinishedAt || Date.now()) - (job.startedAt || job.renderFinishedAt || Date.now())) / 1000)),
      public_url: job.publicUrl || '',
      local_path: path.resolve(job.outputPath),
      upload_status: job.uploadStatus || 'pending'
    });
  } catch (error) {
    console.error(`[生成历史] ${job.source}:${job.playlistId} 保存失败:`, error?.message || error);
  }
}

function updateGenerationHistoryUpload(job) {
  try {
    generationHistoryOps.updateUpload.run(job.publicUrl || '', job.uploadStatus || '', job.historyJobId || job.id);
  } catch (error) {
    console.error(`[生成历史] ${job.source}:${job.playlistId} 更新上传结果失败:`, error?.message || error);
  }
}

async function uploadGeneratedVideo(job) {
  job.status = 'uploading';
  job.currentSong = '';
  job.activeSongs.clear();
  job.message = '视频已生成，正在上传获取公开链接';
  job.uploadStatus = 'uploading';
  job.uploadPercent = 0;
  job.uploadMessage = '正在准备上传视频';
  job.updatedAt = Date.now();

  const savedCredential = uploadCredentialOps.get.get(job.source, job.userId, 'tmplink');
  const uploadToken = savedCredential ? decrypt(savedCredential.encrypted_token) : '';
  if (!uploadToken) {
    job.status = 'upload_failed';
    job.uploadStatus = 'not_configured';
    job.uploadError = '尚未在个人中心配置有效的 TMPLINK Token';
    job.uploadMessage = '本地视频已生成；配置 TMPLINK Token 后才能获取公开链接';
    job.message = '视频已生成，公开链接未上传';
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
    updateGenerationHistoryUpload(job);
    return;
  }

  try {
    const client = new TmpLinkClient(uploadToken);
    const result = await client.uploadAndGetDirectUrl(job.outputPath, {
      filename: path.basename(job.outputPath),
      model: 2,
      onProgress(progress = {}) {
        job.uploadStatus = progress.phase || job.uploadStatus;
        job.uploadPercent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
        job.uploadMessage = progress.message || job.uploadMessage;
        job.status = progress.phase === 'resolving' ? 'resolving_link' : 'uploading';
        job.message = progress.phase === 'resolving'
          ? '视频已生成，正在获取公开链接'
          : '视频已生成，正在上传获取公开链接';
        job.updatedAt = Date.now();
      }
    });
    job.publicUrl = result.directUrl;
    job.shareUrl = result.shareUrl;
    job.status = 'completed';
    job.uploadStatus = 'completed';
    job.uploadPercent = 100;
    job.uploadMessage = '公开链接已生成';
    job.message = '视频已生成并上传，公开直链可用';
  } catch (error) {
    job.status = 'upload_failed';
    job.uploadStatus = 'failed';
    job.uploadError = error?.message || '上传失败';
    job.uploadMessage = '本地视频已生成，但获取公开链接失败';
    job.message = '视频已生成，公开链接上传失败';
    console.error(`[TMPLINK] ${job.source}:${job.playlistId} 上传失败:`, error?.message || error);
  }
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  updateGenerationHistoryUpload(job);
}

function queueGeneratedVideoUpload(job) {
  job.status = 'waiting_upload';
  job.message = '视频已生成，正在等待上传';
  job.uploadStatus = 'waiting';
  job.uploadPercent = 0;
  job.uploadMessage = '等待上传槽';
  job.updatedAt = Date.now();
  playlistUploadQueue.enqueue(job.id);
  setImmediate(startNextPlaylistUploadJob);
}

function startNextPlaylistUploadJob() {
  if (playlistUploadQueue.runningId) return;

  let job = null;
  while (!job && playlistUploadQueue.length > 0) {
    const jobId = playlistUploadQueue.startNext();
    const candidate = playlistGenerationJobs.get(jobId);
    const waitingToUpload = candidate?.status === 'waiting_upload'
      || (candidate?.taskType === 'upload_only' && candidate?.status === 'queued');
    if (candidate && waitingToUpload && !candidate.cancelRequested) {
      job = candidate;
      break;
    }
    playlistUploadQueue.finish(jobId);
  }
  if (!job) return;

  if (job.taskType === 'upload_only' && !job.startedAt) job.startedAt = Date.now();

  Promise.resolve()
    .then(() => uploadGeneratedVideo(job))
    .then(() => {
      if (job.taskType === 'upload_only' && job.status === 'completed') job.completed = 1;
    })
    .catch((error) => {
      job.status = 'upload_failed';
      job.uploadStatus = 'failed';
      job.uploadError = error?.message || '上传任务失败';
      job.uploadMessage = '本地视频已保留，但上传任务失败';
      job.message = '视频已生成，公开链接上传失败';
      job.finishedAt = Date.now();
      job.updatedAt = Date.now();
      updateGenerationHistoryUpload(job);
      console.error(`[上传队列] ${job.source}:${job.playlistId} 上传失败:`, error);
    })
    .finally(() => {
      job.updatedAt = Date.now();
      if (activePlaylistGenerationJobs.get(job.key) === job.id) {
        activePlaylistGenerationJobs.delete(job.key);
      }
      playlistUploadQueue.finish(job.id);
      setImmediate(startNextPlaylistUploadJob);
    });
}

async function runPlaylistGenerationJob(job, { adapter, cookie, token }) {
  try {
    if (!job.startedAt) job.startedAt = Date.now();
    job.status = 'running';
    job.message = '正在读取完整歌单';
    job.updatedAt = Date.now();

    let playlist = readCachedPlaylistDetail(job.playlistId, job.source);
    if (!playlist) {
      try {
        playlist = await adapter.getPlaylistDetail(job.playlistId, cookie);
        cachePlaylistDetail(job.playlistId, job.source, playlist);
      } catch (error) {
        throw new Error(`读取歌单失败：${error?.message || error}`);
      }
    } else {
      const cachedTracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
      if (cachedTracks.length > 1 && !playlist.creator) {
        try {
          const refreshed = await adapter.getPlaylistDetail(job.playlistId, cookie);
          if (refreshed?.tracks?.length) {
            playlist = refreshed;
            cachePlaylistDetail(job.playlistId, job.source, refreshed);
          }
        } catch (error) {
          // 作者信息属于非关键视觉元数据；网络波动时继续使用已有歌曲缓存生成。
          console.warn(`[整单生成] ${job.source}:${job.playlistId} 刷新歌单作者失败，继续使用缓存: ${error?.message || error}`);
        }
      }
    }
    if (job.cancelRequested) throw generationCancelledError();
    const playlistTracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    const songs = job.order === 'shuffle' ? shuffleTracks(playlistTracks) : playlistTracks;
    job.playlistName = playlist.name || songs[0]?.name || 'playlist';
    job.playlistCreator = playlist.creator || songs[0]?._collectionCreator || '';
    job.playlistCover = playlist.cover || songs[0]?.cover || DEFAULT_COVER_URL;
    if (songs.length === 0) throw new Error('歌单中没有可生成的歌曲');

    job.total = songs.length;
    job.completed = 0;
    job.skipped = 0;
    job.skippedSongs = [];
    job.skippedIndexes = new Set();
    job.songProgress = 0;
    job.activeSongs = new Map();
    const protectedCacheKeys = songs.map((song, index) => {
      const songId = getSongIdForTrack(song, job.source);
      const renderContext = createSongRenderContext(job, index + 1, songs.length);
      return getScopedSongCacheKey(songId, job.source, job.mode, job.quality, job.resolution, job.fps, renderContext);
    });
    for (const cacheKey of protectedCacheKeys) protectSongCacheForJob(job, cacheKey);
    const plannedWorkSeconds = songs.map((song, index) => {
      const cacheKey = protectedCacheKeys[index];
      return isSongCached(cacheKey) ? 0 : Math.max(1, Number(song.duration) || 240);
    });
    job.workTotalSeconds = plannedWorkSeconds.reduce((total, seconds) => total + seconds, 0);
    job.workCompletedSeconds = 0;
    job.workStartedAt = Date.now();
    let playlistCover = playlist.cover || DEFAULT_COVER_URL;
    if (isLiteVideoMode(job.mode)) {
      const picked = await getOrBindBg({
        token,
        playlistId: job.playlistId,
        source: job.source,
        fallbackUrl: playlistCover
      });
      if (isDownloadUrlAllowed(picked).allowed) playlistCover = picked;
    }

    let nextIndex = 0;
    let firstError = null;
    const workerCount = Math.min(job.requestedConcurrency || 4, JOB_LIMITS.maxConcurrentJobs, songs.length);
    job.concurrency = workerCount;

    async function generateNextSong() {
      while (!firstError && !job.cancelRequested) {
        const index = nextIndex++;
        if (index >= songs.length) return;
        const song = songs[index];
      const songId = getSongIdForTrack(song, job.source);
      if (!isValidSongIdForSource(songId, job.source)) {
          firstError = new Error(`第 ${index + 1} 首歌曲缺少有效 ID`);
          return;
      }

        const songName = song.name || song.title || songId;
        const renderContext = createSongRenderContext(job, index + 1, songs.length);
        const songCacheKey = getScopedSongCacheKey(songId, job.source, job.mode, job.quality, job.resolution, job.fps, renderContext);
        const needsGeneration = !isSongCached(songCacheKey);
        let workSeconds = needsGeneration ? plannedWorkSeconds[index] : 0;
        if (!needsGeneration && plannedWorkSeconds[index] > 0) {
          job.workTotalSeconds = Math.max(0, job.workTotalSeconds - plannedWorkSeconds[index]);
          workSeconds = 0;
        }
        job.activeSongs.set(index, { name: songName, progress: 0, workSeconds });
        job.currentSong = songName;
        job.message = `正在并行生成 ${workerCount} 首（已处理 ${job.completed + job.skipped}/${songs.length}${job.skipped ? `，跳过 ${job.skipped}` : ''}）`;
      job.updatedAt = Date.now();

        try {
          if (job.cancelRequested) throw generationCancelledError();
          if (needsGeneration) {
        let generation = generatingLocks.get(songCacheKey);
        if (!generation) {
          let audioUrl;
          try {
            audioUrl = await adapter.getSongUrl(songId, cookie, job.quality);
          } catch (error) {
            if (error?.code === 'SONG_UNPLAYABLE') throw error;
            throw new Error(`获取《${songName}》${{ low: '低', medium: '中', high: '高' }[job.quality]}音质音频地址失败：${error?.message || error}`);
          }
          const lyricsText = await getLyricsForGeneration(adapter, songId, cookie, job.mode).catch((error) => {
            console.warn(`[整单生成] 《${songName}》歌词获取失败，按无歌词继续: ${error?.message || error}`);
            return { original: '', translation: '' };
          });
              if (!audioUrl) throw new Error(`无法获取《${songName}》的音频地址`);
          const coverUrl = isLiteVideoMode(job.mode)
            ? playlistCover
            : pickCoverUrlForSong(song, playlistCover);
          generation = generateSongSegments(
            songCacheKey,
            audioUrl,
            coverUrl,
            song.duration,
            song,
            lyricsText,
            (progress) => {
                  const active = job.activeSongs.get(index);
                  if (active) active.progress = progress;
              job.updatedAt = Date.now();
            },
            {
              isCancelled: () => job.cancelRequested,
              registerProcess: (process) => job.ffmpegProcesses.add(process),
              unregisterProcess: (process) => job.ffmpegProcesses.delete(process)
            },
            renderContext
          );
          generation._createdAt = Date.now();
          generatingLocks.set(songCacheKey, generation);
          generation.finally(() => {
            if (generatingLocks.get(songCacheKey) === generation) generatingLocks.delete(songCacheKey);
          }).catch(() => {});
        }
        const outcome = await Promise.race([
          generation.then(() => 'generated'),
          job.cancelSignal.then(() => 'cancelled')
        ]);
        if (outcome === 'cancelled') throw generationCancelledError();
      }

          if (!isSongCached(songCacheKey)) throw new Error(`《${songName}》生成后校验失败`);
          if (needsGeneration) job.workCompletedSeconds += workSeconds;
          job.completed += 1;
        } catch (error) {
          if (error?.code === 'SONG_UNPLAYABLE') {
            job.skipped += 1;
            job.skippedIndexes.add(index);
            job.skippedSongs.push({
              index: index + 1,
              id: String(songId),
              name: String(songName),
              reason: '版权或音源限制，当前不可播放'
            });
            if (workSeconds > 0) {
              job.workTotalSeconds = Math.max(job.workCompletedSeconds, job.workTotalSeconds - workSeconds);
            }
            console.warn(`[整单生成] 跳过不可播放歌曲 ${index + 1}/${songs.length}《${songName}》(${songId})`);
          } else if (!firstError) {
            firstError = error?.code === 'GENERATION_CANCELLED'
              ? error
              : new Error(`生成《${songName}》失败：${error?.message || error}`);
          }
        } finally {
          job.activeSongs.delete(index);
        }
        job.message = `正在并行生成 ${workerCount} 首（已处理 ${job.completed + job.skipped}/${songs.length}${job.skipped ? `，跳过 ${job.skipped}` : ''}）`;
      job.updatedAt = Date.now();
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => generateNextSong()));
    if (job.cancelRequested) throw generationCancelledError();
    if (firstError) throw firstError;
    if (job.completed === 0) throw new Error('歌单中的歌曲均不可播放，无法生成视频');

    job.status = 'finalizing';
    job.message = job.skipped
      ? `正在合并整张歌单 MP4（已跳过 ${job.skipped} 首不可播放歌曲）`
      : '正在合并整张歌单 MP4';
    job.currentSong = '';
    job.activeSongs.clear();
    job.updatedAt = Date.now();
    job.outputPath = await buildPlaylistMp4(job, songs);
    job.renderFinishedAt = Date.now();
    recordGenerationHistory(job);
    releaseProtectedSongCaches(job);
    scheduleCacheCleanup('after-playlist-merge');
    if (job.cancelRequested) throw generationCancelledError();

    queueGeneratedVideoUpload(job);
    return;
  } catch (error) {
    const cancelled = job.cancelRequested || error?.code === 'GENERATION_CANCELLED';
    job.status = cancelled ? 'cancelled' : 'failed';
    job.error = cancelled ? '' : (error?.message || '生成失败');
    job.message = cancelled ? '已取消生成' : '生成失败';
    job.currentSong = '';
    job.activeSongs.clear();
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
    if (!cancelled) console.error(`[整单生成] ${job.source}:${job.playlistId} 失败:`, error);
  } finally {
    releaseProtectedSongCaches(job);
    if (isGenerationJobTerminal(job) && activePlaylistGenerationJobs.get(job.key) === job.id) {
      activePlaylistGenerationJobs.delete(job.key);
    }
  }
}

function startNextPlaylistGenerationJob() {
  if (playlistGenerationQueue.runningId) return;

  let job = null;
  while (!job && playlistGenerationQueue.length > 0) {
    const jobId = playlistGenerationQueue.startNext();
    const candidate = playlistGenerationJobs.get(jobId);
    if (candidate && candidate.status === 'queued' && !candidate.cancelRequested) {
      job = candidate;
      break;
    }
    playlistGenerationQueue.finish(jobId);
  }
  if (!job) return;

  const tokenStore = job.source === 'qq' ? qqUserOps : userOps;
  const user = tokenStore.getById.get(job.userId);
  if (!user) {
    job.status = 'failed';
    job.message = '生成失败';
    job.error = '登录账号不存在或已失效';
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
    if (activePlaylistGenerationJobs.get(job.key) === job.id) activePlaylistGenerationJobs.delete(job.key);
    playlistGenerationQueue.finish(job.id);
    setImmediate(startNextPlaylistGenerationJob);
    return;
  }

  Promise.resolve().then(() => {
    return runPlaylistGenerationJob(job, {
      adapter: getSourceAdapter(job.source),
      cookie: decrypt(user.cookie),
      token: job.playbackToken
    });
  }).catch((error) => {
    job.status = 'failed';
    job.message = '生成失败';
    job.error = error?.message || '启动生成任务失败';
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
    if (activePlaylistGenerationJobs.get(job.key) === job.id) activePlaylistGenerationJobs.delete(job.key);
    console.error(`[整单队列] ${job.source}:${job.playlistId} 启动失败:`, error);
  }).finally(() => {
    playlistGenerationQueue.finish(job.id);
    setImmediate(startNextPlaylistGenerationJob);
  });
}

function resolveAccountUserFromReq(req, source) {
  const headerName = source === 'qq' ? 'x-qq-token' : 'x-token';
  const accountToken = String(req.headers[headerName] || '').trim();
  if (!accountToken) return null;
  return (source === 'qq' ? qqUserOps : userOps).getByToken.get(accountToken) || null;
}

router.get('/generation-jobs', (req, res) => {
  const source = getSourceFromReq(req);
  const user = resolveAccountUserFromReq(req, source);
  if (!user) return res.status(401).json({ success: false, message: '登录已失效' });

  const ownedJobs = Array.from(playlistGenerationJobs.values())
    .filter((job) => job.source === source && job.userId === user.id && !job.dismissedAt);
  const activeJobs = ownedJobs
    .filter(isGenerationJobActive)
    .sort((left, right) => left.createdAt - right.createdAt);
  const recentJobs = ownedJobs
    .filter((job) => !isGenerationJobActive(job))
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, Math.max(0, 50 - activeJobs.length));
  const jobs = [...activeJobs, ...recentJobs].map(generationJobSnapshot);

  res.json({
    success: true,
    data: {
      jobs,
      runningJobId: playlistGenerationQueue.runningId,
      uploadingJobId: playlistUploadQueue.runningId,
      queuedCount: jobs.filter((job) => job.status === 'queued' || job.status === 'waiting_upload').length
    }
  });
});

function findOwnedGenerationJob(req, res, source, user) {
  const job = playlistGenerationJobs.get(String(req.params.jobId || ''));
  if (!job || job.source !== source || job.userId !== user.id) {
    res.status(404).json({ success: false, message: '生成任务不存在或已过期' });
    return null;
  }
  return job;
}

function requestGenerationJobCancellation(job) {
  if (job.status === 'queued' || job.status === 'waiting_upload') {
    const renderedWaitingForUpload = job.status === 'waiting_upload';
    const waitingForUpload = job.status === 'waiting_upload' || job.taskType === 'upload_only';
    job.cancelRequested = true;
    job.status = 'cancelled';
    job.message = waitingForUpload ? '已取消等待上传' : '已取消排队';
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
    (waitingForUpload ? playlistUploadQueue : playlistGenerationQueue).remove(job.id);
    if (renderedWaitingForUpload) {
      job.uploadStatus = 'cancelled';
      job.uploadMessage = '已取消公开链接上传';
      updateGenerationHistoryUpload(job);
    }
    if (activePlaylistGenerationJobs.get(job.key) === job.id) activePlaylistGenerationJobs.delete(job.key);
    if (typeof job.resolveCancel === 'function') job.resolveCancel();
    setImmediate(startNextPlaylistGenerationJob);
    setImmediate(startNextPlaylistUploadJob);
  } else if (!['completed', 'failed', 'cancelled', 'uploading', 'resolving_link', 'upload_failed'].includes(job.status)) {
    job.cancelRequested = true;
    job.status = 'cancelling';
    job.message = '正在取消生成';
    job.updatedAt = Date.now();
    if (typeof job.resolveCancel === 'function') job.resolveCancel();
    for (const process of job.ffmpegProcesses) {
      try { process.kill('SIGKILL'); } catch (_) {}
    }
  }
}

router.post('/generation-jobs/reupload', (req, res) => {
  const source = getSourceFromReq(req);
  const user = resolveAccountUserFromReq(req, source);
  if (!user) return res.status(401).json({ success: false, message: '登录已失效' });
  const historyJobId = String(req.body?.historyJobId || '').trim();
  const history = generationHistoryOps.getOwned.get(historyJobId, source, user.id);
  if (!history) return res.status(404).json({ success: false, message: '历史生成记录不存在' });

  const outputPath = path.resolve(String(history.local_path || ''));
  const relativePath = path.relative(path.resolve(PLAYLIST_MP4_DIR), outputPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return res.status(400).json({ success: false, message: '历史记录中的本地视频路径无效' });
  }
  let stat;
  try { stat = fs.statSync(outputPath); } catch (_) {}
  if (!stat?.isFile() || stat.size <= 0) {
    return res.status(404).json({ success: false, message: '本地视频文件不存在，无法重新上传' });
  }

  const key = `reupload:${source}:${user.id}:${historyJobId}`;
  const activeId = activePlaylistGenerationJobs.get(key);
  const activeJob = activeId ? playlistGenerationJobs.get(activeId) : null;
  if (activeJob && isGenerationJobActive(activeJob)) {
    return res.status(202).json({ success: true, data: generationJobSnapshot(activeJob) });
  }

  const id = crypto.randomUUID();
  let resolveCancel;
  const cancelSignal = new Promise((resolve) => { resolveCancel = resolve; });
  const job = {
    id,
    key,
    taskType: 'upload_only',
    historyJobId,
    source,
    userId: user.id,
    playlistId: String(history.playlist_id),
    playlistName: String(history.playlist_name || '未命名歌单'),
    playlistCover: String(history.playlist_cover || ''),
    playlistCreator: String(history.playlist_creator || ''),
    status: 'queued',
    total: 1,
    completed: 0,
    skipped: 0,
    skippedSongs: [],
    activeSongs: new Map(),
    ffmpegProcesses: new Set(),
    cancelRequested: false,
    cancelSignal,
    resolveCancel,
    concurrency: 1,
    requestedConcurrency: 1,
    currentSong: '',
    message: '仅上传任务已进入队列',
    error: '',
    outputPath,
    uploadStatus: 'waiting',
    uploadPercent: 0,
    uploadMessage: '等待开始上传',
    uploadError: '',
    publicUrl: String(history.public_url || ''),
    shareUrl: '',
    createdAt: Date.now(),
    startedAt: null,
    updatedAt: Date.now(),
    statusPath: '',
    cancelPath: ''
  };
  playlistGenerationJobs.set(id, job);
  activePlaylistGenerationJobs.set(key, id);
  playlistUploadQueue.enqueue(id);
  setImmediate(startNextPlaylistUploadJob);
  res.status(202).json({ success: true, data: generationJobSnapshot(job) });
});

router.post('/generation-jobs/:jobId/cancel', (req, res) => {
  const source = getSourceFromReq(req);
  const user = resolveAccountUserFromReq(req, source);
  if (!user) return res.status(401).json({ success: false, message: '登录已失效' });
  const job = findOwnedGenerationJob(req, res, source, user);
  if (!job) return;
  requestGenerationJobCancellation(job);
  res.json({ success: true, data: generationJobSnapshot(job) });
});

router.post('/generation-jobs/:jobId/dismiss', (req, res) => {
  const source = getSourceFromReq(req);
  const user = resolveAccountUserFromReq(req, source);
  if (!user) return res.status(401).json({ success: false, message: '登录已失效' });
  const job = findOwnedGenerationJob(req, res, source, user);
  if (!job) return;
  if (!isGenerationJobTerminal(job)) {
    return res.status(409).json({ success: false, message: '任务尚未结束，不能确认移除' });
  }
  job.dismissedAt = Date.now();
  job.updatedAt = Date.now();
  res.json({ success: true, data: { id: job.id, dismissed: true } });
});

router.post('/:token/:playlistId/generate', (req, res) => {
  const { token, playlistId } = req.params;
  const source = getSourceFromReq(req);
  const profile = getRenderProfileFromReq(req);
  const { mode, quality, resolution, fps, concurrency } = profile;
  const order = getPlaybackOrderFromReq(req);
  if (!isLikelyToken(token)) return res.status(400).json({ success: false, message: '无效的播放凭证' });
  if (!isValidNumericId(playlistId)) return res.status(400).json({ success: false, message: '无效的歌单 ID' });
  const user = resolveUserFromAccessToken(token, playlistId, source);
  if (!user) return res.status(401).json({ success: false, message: '播放凭证已失效' });

  const key = generationJobKey(source, user.id, playlistId, mode, quality, resolution, fps, order);
  const activeId = activePlaylistGenerationJobs.get(key);
  const activeJob = activeId ? playlistGenerationJobs.get(activeId) : null;
  if (activeJob && isGenerationJobActive(activeJob)) {
    return res.status(202).json({ success: true, data: generationJobSnapshot(activeJob) });
  }

  const id = crypto.randomUUID();
  const cachedPlaylist = readCachedPlaylistDetail(playlistId, source);
  let resolveCancel;
  const cancelSignal = new Promise((resolve) => { resolveCancel = resolve; });
  const job = {
    id,
    key,
    source,
    mode,
    quality,
    resolution,
    fps,
    requestedConcurrency: concurrency,
    order,
    userId: user.id,
    playlistId: String(playlistId),
    playlistName: String(cachedPlaylist?.name || req.body?.playlistName || `歌单 ${playlistId}`),
    playlistCover: String(cachedPlaylist?.cover || req.body?.playlistCover || ''),
    playlistCreator: String(cachedPlaylist?.creator || req.body?.playlistCreator || ''),
    status: 'queued',
    total: Number(cachedPlaylist?.songCount || req.body?.songCount) || 0,
    completed: 0,
    skipped: 0,
    skippedSongs: [],
    skippedIndexes: new Set(),
    songProgress: 0,
    activeSongs: new Map(),
    ffmpegProcesses: new Set(),
    cancelRequested: false,
    cancelSignal,
    resolveCancel,
    concurrency: Math.min(concurrency, JOB_LIMITS.maxConcurrentJobs),
    currentSong: '',
    message: '任务已进入生成队列',
    error: '',
    uploadStatus: 'waiting',
    uploadPercent: 0,
    uploadMessage: '',
    uploadError: '',
    publicUrl: '',
    shareUrl: '',
    createdAt: Date.now(),
    startedAt: null,
    updatedAt: Date.now(),
    playbackToken: token,
    statusPath: generationStatusPath(source, token, playlistId, id),
    cancelPath: generationCancelPath(source, token, playlistId, id)
  };
  playlistGenerationJobs.set(id, job);
  activePlaylistGenerationJobs.set(key, id);
  playlistGenerationQueue.enqueue(id);
  setImmediate(startNextPlaylistGenerationJob);
  res.status(202).json({ success: true, data: generationJobSnapshot(job) });
});

router.get('/:token/:playlistId/generate/:jobId', (req, res) => {
  const { token, playlistId, jobId } = req.params;
  const source = getSourceFromReq(req);
  const user = resolveUserFromAccessToken(token, playlistId, source);
  if (!user) return res.status(401).json({ success: false, message: '播放凭证已失效' });
  const job = playlistGenerationJobs.get(jobId);
  if (!job || job.source !== source || job.userId !== user.id || job.playlistId !== String(playlistId)) {
    return res.status(404).json({ success: false, message: '生成任务不存在或已过期' });
  }
  res.json({ success: true, data: generationJobSnapshot(job) });
});

router.post('/:token/:playlistId/generate/:jobId/cancel', (req, res) => {
  const { token, playlistId, jobId } = req.params;
  const source = getSourceFromReq(req);
  const user = resolveUserFromAccessToken(token, playlistId, source);
  if (!user) return res.status(401).json({ success: false, message: '播放凭证已失效' });
  const job = playlistGenerationJobs.get(jobId);
  if (!job || job.source !== source || job.userId !== user.id || job.playlistId !== String(playlistId)) {
    return res.status(404).json({ success: false, message: '生成任务不存在或已过期' });
  }

  requestGenerationJobCancellation(job);

  res.json({ success: true, data: generationJobSnapshot(job) });
});

router.get('/:token/:playlistId/playlist.mp4', (req, res) => {
  const { token, playlistId } = req.params;
  const source = getSourceFromReq(req);
  const profile = getRenderProfileFromReq(req);
  const { mode, quality, resolution, fps } = profile;
  const order = getPlaybackOrderFromReq(req);
  if (!isLikelyToken(token)) return res.status(400).type('text/plain').send('Invalid token');
  if (!isValidNumericId(playlistId)) return res.status(400).type('text/plain').send('Invalid playlist id');
  const user = resolveUserFromAccessToken(token, playlistId, source);
  if (!user) return res.status(401).type('text/plain').send('Token expired');

  const cachedPlaylist = playlistOps.get.get(getPlaylistCacheKey(playlistId, source));
  const playlistName = cachedPlaylist?.name || '';
  const filePath = findPlaylistMp4Path(source, playlistId, mode, quality, playlistName, order, resolution, fps);
  if (!fs.existsSync(filePath)) {
    res.setHeader('Retry-After', '5');
    return res.status(409).type('text/plain').send('Playlist MP4 is not generated yet');
  }

  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  const modeLabel = isUltraFastGenerationMode(mode) ? '极速' : (isBalancedGenerationMode(mode) ? '平衡' : '质量');
  const qualityLabel = { low: '低', medium: '中', high: '高' }[quality];
  const downloadName = `${sanitizeOutputFileStem(playlistName, `playlist-${playlistId}`)}_${qualityLabel}_${modeLabel}_${resolution}_${fps}FPS.mp4`;
  res.setHeader(
    'Content-Disposition',
    `inline; filename="playlist-${playlistId}.mp4"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
  );
  const range = String(req.headers.range || '');
  if (!range) {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    return res.status(416).end();
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= stat.size) {
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    return res.status(416).end();
  }
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(filePath, { start, end }).pipe(res);
});

// master playlist：为 yt-dlp / VRChat 提供 STREAM-INF 元信息
router.get('/:token/:playlistId/master.m3u8', async (req, res) => {
  const { token, playlistId } = req.params;
  const source = getSourceFromReq(req);
  const profile = getRenderProfileFromReq(req);

  if (!isLikelyToken(token)) {
    return res.status(400).send('#EXTM3U\n#EXT-X-ERROR:Invalid token format');
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).send('#EXTM3U\n#EXT-X-ERROR:Invalid playlist ID');
  }

  const user = resolveUserFromAccessToken(token, playlistId, source);
  if (!user) {
    return res.status(401).send('#EXTM3U\n#EXT-X-ERROR:Invalid token');
  }

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(
    '#EXTM3U\n' +
    '#EXT-X-VERSION:3\n' +
    `#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=${profile.width}x${profile.height},CODECS="avc1.640029,mp4a.40.2"\n` +
    `stream.m3u8${getRenderQuerySuffix(profile.mode, profile.quality, profile.resolution, profile.fps)}`
  );
});

router.get('/:token/:playlistId/stream.m3u8', async (req, res) => {
  const { token, playlistId } = req.params;
  const source = getSourceFromReq(req);
  const profile = getRenderProfileFromReq(req);
  const { mode, quality, resolution, fps } = profile;
  const adapter = getSourceAdapter(source);
  const startIndex = parseInt(req.query.start, 10) || 0;
  const playlistCacheKey = getPlaylistCacheKey(playlistId, source);
  
  if (!isLikelyToken(token)) {
    return res.status(400).send('#EXTM3U\n#EXT-X-ERROR:Invalid token format');
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).send('#EXTM3U\n#EXT-X-ERROR:Invalid playlist ID');
  }
  
  const user = resolveUserFromAccessToken(token, playlistId, source);
  if (!user) {
    return res.status(401).send('#EXTM3U\n#EXT-X-ERROR:Invalid token');
  }
  
  const cookie = decrypt(user.cookie);
  
  let songs, playlistCover;
  const cached = playlistOps.get.get(playlistCacheKey);
  
  if (cached) {
    let cacheParseOk = true;
    try {
      songs = JSON.parse(cached.songs);
      if (!Array.isArray(songs)) {
        throw new Error('songs is not an array');
      }
    } catch (parseErr) {
      console.error(`[HLS] 歌单缓存损坏 ${playlistCacheKey}:`, parseErr.message);
      cacheParseOk = false;
    }
    
    if (!cacheParseOk) {
      try {
        const playlist = await adapter.getPlaylistDetail(playlistId, cookie);
        songs = playlist.tracks;
        playlistCover = playlist.cover;
      } catch (refreshErr) {
        return res.status(500).send('#EXTM3U\n#EXT-X-ERROR:Cache corrupted and refresh failed');
      }
    } else {
      playlistCover = cached.cover;
    }
    const hasVisualMetadata = Array.isArray(songs) && songs.some(s => s && s.cover) && songs.some(s => s && s.album);
    if (!hasVisualMetadata) {
      try {
        const playlist = await adapter.getPlaylistDetail(playlistId, cookie);
        songs = playlist.tracks;
        playlistCover = playlist.cover;
        cachePlaylistDetail(playlistId, source, playlist);
      } catch (_) {
      }
    }
  } else {
    try {
      const playlist = await adapter.getPlaylistDetail(playlistId, cookie);
      songs = playlist.tracks;
      playlistCover = playlist.cover;
      cachePlaylistDetail(playlistId, source, playlist);
    } catch (e) {
      return res.status(500).send('#EXTM3U\n#EXT-X-ERROR:Failed to get playlist');
    }
  }
  
  songs = Array.isArray(songs) ? songs.slice(startIndex) : [];
  
  if (songs.length === 0) {
    return res.status(404).send('#EXTM3U\n#EXT-X-ERROR:Empty playlist');
  }

  const missingSong = songs.find((song) => {
    const songId = getSongIdForTrack(song, source);
    return !isValidSongIdForSource(songId, source) || !isSongCached(getScopedSongCacheKey(songId, source, mode, quality, resolution, fps));
  });
  if (missingSong) {
    res.setHeader('Retry-After', '5');
    return res.status(409).send('#EXTM3U\n#EXT-X-ERROR:Playlist generation is not complete');
  }
  
  const baseUrl = getBaseUrl(req);
  const segmentBasePath = getSegmentBasePathForReq(req, token, playlistId);
  const modeSuffix = getRenderQuerySuffix(mode, quality, resolution, fps);
  const segmentDuration = CACHE_CONFIG.segmentDuration;
  
  let m3u8 = '#EXTM3U\n';
  m3u8 += '#EXT-X-VERSION:3\n';
  m3u8 += `#EXT-X-TARGETDURATION:${segmentDuration + 1}\n`;
  m3u8 += '#EXT-X-PLAYLIST-TYPE:VOD\n';
  m3u8 += '#EXT-X-MEDIA-SEQUENCE:0\n';
  m3u8 += '#EXT-X-ALLOW-CACHE:YES\n';
  
  for (let songIndex = 0; songIndex < songs.length; songIndex++) {
    const song = songs[songIndex];
    const songId = getSongIdForTrack(song, source);
    if (!isValidSongIdForSource(songId, source)) {
      continue;
    }
    const songCacheKey = getScopedSongCacheKey(songId, source, mode, quality, resolution, fps);
    const segmentInfo = getSongSegmentInfo(songCacheKey);
    if (songIndex > 0) {
      m3u8 += '#EXT-X-DISCONTINUITY\n';
    }
    for (let segIndex = 0; segIndex < segmentInfo.segmentCount; segIndex++) {
      const segDuration = segmentInfo.segmentDurations[segIndex] || segmentDuration;
      m3u8 += `#EXTINF:${segDuration.toFixed(6)},\n`;
      m3u8 += `${baseUrl}${segmentBasePath}/seg/${encodeURIComponent(songId)}/${segIndex}.ts${modeSuffix}\n`;
    }
  }
  
  m3u8 += '#EXT-X-ENDLIST\n';
  
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(m3u8);
});

router.get('/:token/:playlistId/seg/:songId/:segmentIndex.ts', async (req, res) => {
  const { token, playlistId, songId, segmentIndex } = req.params;
  const source = getSourceFromReq(req);
  const profile = getRenderProfileFromReq(req);
  const { mode, quality, resolution, fps } = profile;
  const adapter = getSourceAdapter(source);
  const playlistCacheKey = getPlaylistCacheKey(playlistId, source);
  const songCacheKey = getScopedSongCacheKey(songId, source, mode, quality, resolution, fps);
  const segIndex = parseInt(segmentIndex);
  
  if (!isLikelyToken(token)) {
    return res.status(400).json({ error: 'Invalid token format' });
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).json({ error: 'Invalid playlist ID' });
  }
  if (!isValidSongIdForSource(songId, source)) {
    return res.status(400).json({ error: 'Invalid song ID' });
  }
  if (!isValidSegmentIndex(segmentIndex)) {
    return res.status(400).json({ error: 'Invalid segment index' });
  }
  
  const user = resolveUserFromAccessToken(token, playlistId, source);
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  if (segIndex === 0) {
    try {
      let songName = '未知';
      let artist = '未知';

      const cached = playlistOps.get.get(playlistCacheKey);
      if (cached && cached.songs) {
        try {
          const songs = JSON.parse(cached.songs);
          const song = Array.isArray(songs) ? songs.find(s => getSongIdForTrack(s, source) === String(songId)) : null;
          if (song) {
            if (song.name) songName = String(song.name);
            if (song.artist) artist = String(song.artist);
          }
        } catch (_) {}
      }

      playLogOps.log.run({
        user_id: user.id,
        playlist_id: adapter.toPlayLogPlaylistId(playlistId),
        song_id: adapter.toPlayLogSongId(songId),
        song_name: songName,
        artist
      });
    } catch (e) {
      console.error('记录播放失败:', e?.message || e);
    }
  }
  
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  
  const segmentPath = getSegmentPath(songCacheKey, segIndex); 

  const hitStat = isSongCached(songCacheKey) ? await statIfValidSegment(segmentPath) : null;
  if (hitStat) { 
    if (LOG_VERBOSE) console.log(`[分片命中] ${songCacheKey}/${segIndex}`); 

    const etag = makeWeakEtag(hitStat);
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', formatHttpDate(hitStat.mtimeMs));

    const inm = req.headers['if-none-match'];
    if (inm && String(inm).trim() === etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Length', hitStat.size); 
    const stream = fs.createReadStream(segmentPath); 
    stream.pipe(res); 
    return; 
  } 
  res.setHeader('Retry-After', '5');
  return res.status(409).json({ error: 'Playlist generation is not complete' });
});

router.get('/:token/:playlistId/song/:songId.ts', (req, res) => {
  const { token, playlistId, songId } = req.params;
  const source = getSourceFromReq(req);
  const profile = getRenderProfileFromReq(req);
  const { mode, quality, resolution, fps } = profile;
  const basePath = source === 'qq' ? '/api/qq/hls' : '/api/hls';
  const modeSuffix = getRenderQuerySuffix(mode, quality, resolution, fps);
  
  if (!isLikelyToken(token) || !isValidNumericId(playlistId) || !isValidSongIdForSource(songId, source)) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }
  
  res.redirect(`${basePath}/${encodeURIComponent(token)}/${playlistId}/seg/${encodeURIComponent(songId)}/0.ts${modeSuffix}`);
});

router.post('/:token/:playlistId/preload', async (req, res) => {
  const { token, playlistId } = req.params;
  const source = getSourceFromReq(req);
  const profile = getRenderProfileFromReq(req);
  const { mode, quality, resolution, fps } = profile;
  const adapter = getSourceAdapter(source);
  const playlistCacheKey = getPlaylistCacheKey(playlistId, source);
  const count = Math.min(parseInt(req.body.count) || 5, 20);
  
  if (!isLikelyToken(token)) {
    return res.status(400).json({ error: 'Invalid token format' });
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).json({ error: 'Invalid playlist ID' });
  }
  
  const user = resolveUserFromAccessToken(token, playlistId, source);
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  const cookie = decrypt(user.cookie);
  
  try {
    let songs;
    const cached = playlistOps.get.get(playlistCacheKey);
    
    if (cached) {
      let cacheParseOk = true;
      try {
        songs = JSON.parse(cached.songs);
        if (!Array.isArray(songs)) {
          throw new Error('songs is not an array');
        }
      } catch (parseErr) {
        console.error(`[预加载] 歌单缓存损坏 ${playlistCacheKey}:`, parseErr.message);
        cacheParseOk = false;
      }
      
      if (!cacheParseOk) {
        const playlist = await adapter.getPlaylistDetail(playlistId, cookie);
        songs = playlist.tracks;
      } else {
        const hasCover = Array.isArray(songs) && songs.some(s => s && s.cover);
        if (!hasCover) {
          try {
            const playlist = await adapter.getPlaylistDetail(playlistId, cookie);
            songs = playlist.tracks;
          } catch (_) {}
        }
      }
    } else {
      const playlist = await adapter.getPlaylistDetail(playlistId, cookie);
      songs = playlist.tracks;
    }
    
    const toPreload = Array.isArray(songs) ? songs.slice(0, count) : [];
    const results = [];
    
    let coverUrl = (cached && cached.cover) ? cached.cover : DEFAULT_COVER_URL;
    if (isLiteVideoMode(mode)) {
      const picked = await getOrBindBg({
        token,
        playlistId,
        source,
        fallbackUrl: coverUrl
      });
      const allowed = isDownloadUrlAllowed(picked);
      if (allowed.allowed) {
        coverUrl = picked;
      }
    }
    
    if (LOG_VERBOSE) console.log(`[预加载] 开始预加载 ${toPreload.length} 首歌`);
    
    for (const song of toPreload) {
      const songId = getSongIdForTrack(song, source);
      if (!isValidSongIdForSource(songId, source)) {
        results.push({ id: songId, name: song.name, status: 'bad_song_id' });
        continue;
      }
      const songCacheKey = getScopedSongCacheKey(songId, source, mode, quality, resolution, fps);
      if (isSongCached(songCacheKey)) {
        const info = getSongSegmentInfo(songCacheKey);
        results.push({ id: songId, name: song.name, status: 'cached', segments: info?.segmentCount || 0 });
        continue;
      }
      
      try {
        const [audioUrl, lyricsText] = await Promise.all([
          adapter.getSongUrl(songId, cookie, quality),
          getLyricsForGeneration(adapter, songId, cookie, mode)
        ]);
        if (!audioUrl) {
          results.push({ id: songId, name: song.name, status: 'no_url' });
          continue;
        }
        
        const perSongCover = isLiteVideoMode(mode) ? coverUrl : pickCoverUrlForSong(song, coverUrl);
        const info = await generateSongSegments(songCacheKey, audioUrl, perSongCover, song.duration, song, lyricsText);
        results.push({ id: songId, name: song.name, status: 'generated', segments: info.segmentCount });
      } catch (e) {
        results.push({ id: songId, name: song.name, status: 'error', error: e.message });
      }
    }
    
    if (LOG_VERBOSE) console.log(`[预加载] 完成`);
    res.json({ success: true, results });
    
  } catch (e) {
    console.error('预加载错误:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/cache/status', adminAuth, async (req, res) => { 
  try { 
    const dirents = await fs.promises.readdir(CACHE_DIR, { withFileTypes: true }); 
    let totalSize = 0; 
    let totalSongs = 0; 
    const cachedSongs = []; 
     
    for (let i = 0; i < dirents.length; i++) { 
      const entry = dirents[i]; 
      if (!entry.isDirectory()) continue; 
      totalSongs++; 

      const songId = fromFsCacheKey(entry.name); 
      const songDir = path.join(CACHE_DIR, entry.name); 
      const infoPath = path.join(songDir, 'info.json'); 

      let segmentCount = 0; 
      let songSize = 0; 
      let timestamp = 0; 

      const info = await safeReadJson(infoPath); 
      if (info) { 
        segmentCount = info.segmentCount || 0; 
        songSize = Number(info.cacheBytes) || 0; 
        timestamp = Number(info.timestamp) || 0; 
      } 

      if (!timestamp) { 
        try { 
          const stat = await fs.promises.stat(songDir); 
          timestamp = stat.mtimeMs || 0; 
        } catch (_) {} 
      } 

      if (!songSize) { 
        songSize = await getSongDirSizeBytes(songDir); 
      } 

      totalSize += songSize; 

      if (cachedSongs.length < 50) { 
        const ageMin = timestamp ? Math.round((Date.now() - timestamp) / 1000 / 60) : 0; 
        cachedSongs.push({ 
          songId: info && info.songId ? String(info.songId) : songId, 
          segments: segmentCount, 
          size: (songSize / 1024 / 1024).toFixed(2) + ' MB', 
          age: ageMin + ' minutes' 
        }); 
      } 

      if (i > 0 && i % 25 === 0) await yieldToEventLoop(); 
    } 
     
    res.json({ 
      cache: { 
        totalSongs, 
        totalSize: (totalSize / 1024 / 1024).toFixed(2) + ' MB', 
        maxSize: (CACHE_CONFIG.maxSize / 1024 / 1024 / 1024).toFixed(2) + ' GB', 
      }, 
      jobs: { 
        running: jobSemaphore.running, 
        waiting: jobSemaphore.waiting, 
        maxConcurrent: JOB_LIMITS.maxConcurrentJobs, 
        maxQueue: JOB_LIMITS.maxQueueSize 
      }, 
      config: { 
        downloadTimeout: JOB_LIMITS.downloadTimeout + 'ms', 
        downloadMaxSize: (JOB_LIMITS.downloadMaxSize / 1024 / 1024).toFixed(2) + ' MB', 
        ffmpegTimeout: JOB_LIMITS.ffmpegTimeout + 'ms' 
      }, 
      songs: cachedSongs 
    }); 
  } catch (e) { 
    res.status(500).json({ error: e?.message || String(e) }); 
  } 
}); 

router.delete('/cache', adminAuth, async (req, res) => { 
  try { 
    const dirents = await fs.promises.readdir(CACHE_DIR, { withFileTypes: true }); 
    let deleted = 0; 
     
    for (let i = 0; i < dirents.length; i++) { 
      const entry = dirents[i]; 
      if (!entry.isDirectory()) continue; 

      const songId = fromFsCacheKey(entry.name); 
      const songDir = path.join(CACHE_DIR, entry.name); 
      try { 
        await fs.promises.rm(songDir, { recursive: true, force: true }); 
        deleted++; 
      } catch (_) {} 

      if (i > 0 && i % 10 === 0) await yieldToEventLoop(); 
    } 
     
    songSegmentInfo.clear(); 
     
    res.json({ success: true, deletedSongs: deleted }); 
  } catch (e) { 
    res.status(500).json({ error: e?.message || String(e) }); 
  } 
}); 

module.exports = router;
