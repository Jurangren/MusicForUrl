const { AUDIO_QUALITIES, resolveGenerationProfile } = require('./generation-profile');

function sanitizeOutputFileStem(value, fallback = 'playlist', maxLength = 80) {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  const limited = Array.from(cleaned).slice(0, Math.max(1, maxLength)).join('').replace(/[. ]+$/g, '');
  return limited || fallback;
}

function playlistOutputIdentity(options = {}) {
  const { source, mode, order, playlistId, version } = options;
  const sourceKey = source === 'qq' ? 'qq' : 'netease';
  const modeKey = mode === 'ultra_fast'
    ? 'ultra_fast'
    : (mode === 'fast' ? 'fast' : (mode === 'lite_video' ? 'lite' : 'default'));
  const profile = resolveGenerationProfile(options, { allowLiteVideo: true });
  const orderKey = order === 'shuffle' ? 'shuffle' : 'sequential';
  const id = String(playlistId || '').replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
  return `${sourceKey}_${profile.quality}_${modeKey}_${profile.resolution}_${profile.fps}fps_${profile.volume}vol_${orderKey}_${id}_v${Number(version) || 1}.mp4`;
}

function buildPlaylistOutputFilename(options = {}) {
  const stem = sanitizeOutputFileStem(options.name, 'playlist');
  const profile = resolveGenerationProfile(options, { allowLiteVideo: true });
  const modeLabel = profile.mode === 'ultra_fast'
    ? '极速'
    : (profile.mode === 'fast' ? '平衡' : (profile.mode === 'lite_video' ? '轻量' : '质量'));
  const qualityLabel = AUDIO_QUALITIES[profile.quality].label;
  return `${stem}_${qualityLabel}_${modeLabel}_${profile.resolution}_${profile.fps}FPS_VOL${profile.volume}.mp4`;
}

function buildPlaylistOutputSuffix(options = {}) {
  return `_${playlistOutputIdentity(options)}`;
}

module.exports = {
  sanitizeOutputFileStem,
  playlistOutputIdentity,
  buildPlaylistOutputFilename,
  buildPlaylistOutputSuffix
};
