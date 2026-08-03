const RESOLUTIONS = {
  '1600x900': { key: '1600x900', width: 1600, height: 900 },
  '1920x1080': { key: '1920x1080', width: 1920, height: 1080 }
};

const ALLOWED_FPS = new Set([5, 10, 15, 30]);
const ALLOWED_CONCURRENCY = new Set([2, 4, 6, 8, 16]);

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

function getGenerationAudioBitrate(value) {
  return AUDIO_QUALITIES[normalizeGenerationQuality(value)].audioBitrate;
}

function resolveGenerationProfile({ mode, quality, resolution, fps, concurrency } = {}, options = {}) {
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
    concurrency: normalizeGenerationConcurrency(concurrency)
  };
}

function buildGenerationQuery({ order, mode, quality, resolution, fps, concurrency } = {}) {
  const params = new URLSearchParams();
  params.set('order', order === 'shuffle' ? 'shuffle' : 'sequential');
  if (mode === 'fast' || mode === 'ultra_fast' || mode === 'lite_video') params.set('mode', mode);
  params.set('quality', normalizeGenerationQuality(quality));
  params.set('resolution', normalizeGenerationResolution(resolution));
  params.set('fps', String(normalizeGenerationFps(fps, mode)));
  params.set('concurrency', String(normalizeGenerationConcurrency(concurrency)));
  return `?${params.toString()}`;
}

module.exports = {
  RESOLUTIONS,
  ALLOWED_FPS,
  ALLOWED_CONCURRENCY,
  AUDIO_QUALITIES,
  normalizeGenerationMode,
  normalizeGenerationResolution,
  normalizeGenerationFps,
  normalizeGenerationQuality,
  normalizeGenerationConcurrency,
  getGenerationAudioBitrate,
  resolveGenerationProfile,
  buildGenerationQuery
};
