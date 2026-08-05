const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeOutputFileStem,
  buildPlaylistOutputFilename,
  buildPlaylistOutputSuffix
} = require('../lib/output-filename');

test('puts playlist name, quality, mode, resolution, FPS and volume in the output filename', () => {
  assert.equal(
    buildPlaylistOutputFilename({
      name: '晴天',
      source: 'netease',
      mode: '',
      playlistId: '8123456789012345',
      version: 17
    }),
    '晴天_高_质量_1920x1080_15FPS_VOL100.mp4'
  );
  assert.equal(
    buildPlaylistOutputSuffix({ source: 'qq', mode: 'lite_video', playlistId: '9', version: 17 }),
    '_qq_high_lite_1920x1080_15fps_100vol_sequential_9_v17.mp4'
  );
  assert.equal(
    buildPlaylistOutputFilename({
      name: 'Fast list', source: 'netease', mode: 'fast', playlistId: '9', version: 17
    }),
    'Fast list_高_平衡_1920x1080_1FPS_VOL100.mp4'
  );
  assert.equal(
    buildPlaylistOutputFilename({
      name: 'Static list', source: 'netease', mode: 'ultra_fast', playlistId: '10', version: 17
    }),
    'Static list_高_极速_1920x1080_1FPS_VOL100.mp4'
  );
  assert.match(
    buildPlaylistOutputFilename({
      name: 'HD', source: 'qq', resolution: '1920x1080', fps: 30, playlistId: '10', version: 19
    }),
    /^HD_高_质量_1920x1080_30FPS_VOL100\.mp4$/
  );
  assert.match(
    buildPlaylistOutputFilename({ name: 'Louder', volume: 150 }),
    /_VOL150\.mp4$/
  );
});

test('removes Windows-invalid filename characters and limits long names', () => {
  assert.equal(sanitizeOutputFileStem('歌单: A/B? <Live> *  '), '歌单_ A_B_ _Live_ _');
  assert.equal(sanitizeOutputFileStem('...'), 'playlist');
  assert.ok(Array.from(sanitizeOutputFileStem('歌'.repeat(200))).length <= 80);
});
