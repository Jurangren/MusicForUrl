const RESOLUTIONS = {
  '1600x900': { key: '1600x900', width: 1600, height: 900 },
  '1920x1080': { key: '1920x1080', width: 1920, height: 1080 }
};

const ALLOWED_FPS = new Set([5, 10, 15, 30]);
const ALLOWED_CONCURRENCY = new Set([2, 4, 6, 8, 16]);
const DEFAULT_VOLUME_PERCENT = 100;
const MIN_VOLUME_PERCENT = 0;
const MAX_VOLUME_PERCENT = 200;

const AUDIO_QUALITIES = {
  low: { key: 'low', label: '低', audioBitrate: '96k' },
  medium: { key: 'medium', label: '中', audioBitrate: '128k' },
  high: { key: 'high', label: '高', audioBitrate: '192k' }
};

function normalizeGenerationMode(value, { allowLiteVideo = false } = {}) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'fast') return 'fast';
  if (mode === 'ultra_fast') return 'ultra_fast';
  if (allowLiteVideo && mode === 'lite_video') return 'lite_video';
  return '';
}

function normalizeGenerationResolution(value) {
  const key = String(value || '').trim().toLowerCase();
  return RESOLUTIONS[key]?.key || '1920x1080';
}

function normalizeGenerationFps(value, mode = '') {
  if (mode === 'fast' || mode === 'ultra_fast') return 1;
  const fps = Number.parseInt(value, 10);
  if (!ALLOWED_FPS.has(fps)) return 15;
  return fps;
}

function normalizeGenerationQuality(value) {
  const key = String(value || '').trim().toLowerCase();
  return AUDIO_QUALITIES[key]?.key || 'high';
}

function normalizeGenerationConcurrency(value) {
  const concurrency = Number.parseInt(value, 10);
  return ALLOWED_CONCURRENCY.has(concurrency) ? concurrency : 4;
}

function normalizeGenerationVolume(value) {
  if (value == null || String(value).trim() === '') return DEFAULT_VOLUME_PERCENT;
  const volume = Number(value);
  if (!Number.isFinite(volume)) return DEFAULT_VOLUME_PERCENT;
  return Math.max(MIN_VOLUME_PERCENT, Math.min(MAX_VOLUME_PERCENT, Math.round(volume)));
}

function getGenerationVolumeMultiplier(value) {
  return normalizeGenerationVolume(value) / 100;
}

function getGenerationAudioBitrate(value) {
  return AUDIO_QUALITIES[normalizeGenerationQuality(value)].audioBitrate;
}

function resolveGenerationProfile({ mode, quality, resolution, fps, concurrency, volume } = {}, options = {}) {
  const normalizedMode = normalizeGenerationMode(mode, options);
  const resolutionKey = normalizeGenerationResolution(resolution);
  const resolved = RESOLUTIONS[resolutionKey];
  return {
    mode: normalizedMode,
    quality: normalizeGenerationQuality(quality),
    resolution: resolutionKey,
    width: resolved.width,
    height: resolved.height,
    fps: normalizeGenerationFps(fps, normalizedMode),
    concurrency: normalizeGenerationConcurrency(concurrency),
    volume: normalizeGenerationVolume(volume)
  };
}

function buildGenerationQuery({ order, mode, quality, resolution, fps, concurrency, volume } = {}) {
  const params = new URLSearchParams();
  params.set('order', order === 'shuffle' ? 'shuffle' : 'sequential');
  if (mode === 'fast' || mode === 'ultra_fast' || mode === 'lite_video') params.set('mode', mode);
  params.set('quality', normalizeGenerationQuality(quality));
  params.set('resolution', normalizeGenerationResolution(resolution));
  params.set('fps', String(normalizeGenerationFps(fps, mode)));
  params.set('concurrency', String(normalizeGenerationConcurrency(concurrency)));
  params.set('volume', String(normalizeGenerationVolume(volume)));
  return `?${params.toString()}`;
}

module.exports = {
  RESOLUTIONS,
  ALLOWED_FPS,
  ALLOWED_CONCURRENCY,
  DEFAULT_VOLUME_PERCENT,
  MIN_VOLUME_PERCENT,
  MAX_VOLUME_PERCENT,
  AUDIO_QUALITIES,
  normalizeGenerationMode,
  normalizeGenerationResolution,
  normalizeGenerationFps,
  normalizeGenerationQuality,
  normalizeGenerationConcurrency,
  normalizeGenerationVolume,
  getGenerationVolumeMultiplier,
  getGenerationAudioBitrate,
  resolveGenerationProfile,
  buildGenerationQuery
};
