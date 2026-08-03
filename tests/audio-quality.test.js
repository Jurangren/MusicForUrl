const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const netease = require('../lib/netease');
const qqmusic = require('../lib/qqmusic');

test('music sources expose low, medium and high profiles with high defaults', () => {
  assert.equal(netease.DEFAULT_MUSIC_QUALITY, 'high');
  assert.deepEqual(
    { low: netease.QUALITY_LEVELS.low, medium: netease.QUALITY_LEVELS.medium, high: netease.QUALITY_LEVELS.high },
    { low: 128000, medium: 192000, high: 320000 }
  );
  assert.equal(qqmusic.DEFAULT_QQ_QUALITY, 'high');
  assert.deepEqual(qqmusic.QQ_QUALITY_MAP.low, { s: 'M500', e: '.mp3' });
  assert.deepEqual(qqmusic.QQ_QUALITY_MAP.high, { s: 'M800', e: '.mp3' });
});

test('playlist video audio bitrate follows the selected quality profile', () => {
  const hls = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hls.js'), 'utf8');
  assert.match(hls, /audioBitrate: getGenerationAudioBitrate\(renderProfile\.quality\)/);
  assert.match(hls, /'-c:a', 'aac',[\s\S]*'-b:a', String\(audioBitrate \|\| '192k'\)/);
});
