const { spawnSync } = require('child_process');

const encoderCache = new Map();

const ENCODERS = {
  h264_nvenc: {
    name: 'h264_nvenc',
    label: 'NVIDIA NVENC',
    hardware: true,
    pixelFormat: 'yuv420p',
    args: [
      '-c:v', 'h264_nvenc',
      '-preset', 'p4',
      '-tune', 'hq',
      '-rc', 'vbr',
      '-cq', '23',
      '-b:v', '0',
      '-profile:v', 'high',
      '-level:v', '4.1',
      '-bf', '0'
    ]
  },
  h264_qsv: {
    name: 'h264_qsv',
    label: 'Intel Quick Sync',
    hardware: true,
    pixelFormat: 'nv12',
    args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23']
  },
  h264_amf: {
    name: 'h264_amf',
    label: 'AMD AMF',
    hardware: true,
    pixelFormat: 'yuv420p',
    args: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23']
  },
  libx264: {
    name: 'libx264',
    label: 'CPU libx264',
    hardware: false,
    pixelFormat: 'yuv420p',
    args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-crf', '23']
  }
};

function normalizePreference(value) {
  const raw = String(value || 'auto').trim().toLowerCase();
  const aliases = {
    auto: 'auto', gpu: 'auto',
    nvenc: 'h264_nvenc', nvidia: 'h264_nvenc', h264_nvenc: 'h264_nvenc',
    qsv: 'h264_qsv', intel: 'h264_qsv', h264_qsv: 'h264_qsv',
    amf: 'h264_amf', amd: 'h264_amf', h264_amf: 'h264_amf',
    cpu: 'libx264', x264: 'libx264', libx264: 'libx264'
  };
  return aliases[raw] || 'auto';
}

function probeEncoder(ffmpegPath, encoderName) {
  if (encoderName === 'libx264') return true;
  const encoderArgs = ENCODERS[encoderName]?.args || ['-c:v', encoderName];
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=1',
    '-frames:v', '1', '-an', ...encoderArgs, '-pix_fmt', ENCODERS[encoderName]?.pixelFormat || 'yuv420p',
    '-f', 'null', '-'
  ], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 15000
  });
  return result.status === 0;
}

function detectVideoEncoder(ffmpegPath = 'ffmpeg') {
  const preference = normalizePreference(process.env.VIDEO_ENCODER);
  const cacheKey = `${ffmpegPath}:${preference}`;
  if (encoderCache.has(cacheKey)) return encoderCache.get(cacheKey);

  const candidates = preference === 'auto'
    ? ['h264_nvenc', 'h264_qsv', 'h264_amf']
    : [preference];
  let selected = null;
  for (const candidate of candidates) {
    if (probeEncoder(ffmpegPath, candidate)) {
      selected = ENCODERS[candidate];
      break;
    }
  }
  if (!selected) selected = ENCODERS.libx264;
  const result = { ...selected, args: [...selected.args], requested: preference };
  encoderCache.set(cacheKey, result);
  return result;
}

module.exports = { detectVideoEncoder, probeEncoder, normalizePreference };
