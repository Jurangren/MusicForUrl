const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveGenerationProfile,
  buildGenerationQuery,
  getGenerationAudioBitrate,
  normalizeGenerationVolume,
  getGenerationVolumeMultiplier
} = require('../lib/generation-profile');

test('defaults to 1920x1080 at 15FPS', () => {
  assert.deepEqual(resolveGenerationProfile(), {
    mode: '', quality: 'high', resolution: '1920x1080', width: 1920, height: 1080, fps: 15, concurrency: 4, volume: 100
  });
});

test('supports 1080p and fixes balanced and ultra-fast modes at 1FPS', () => {
  assert.deepEqual(resolveGenerationProfile({ resolution: '1920x1080', fps: 30 }), {
    mode: '', quality: 'high', resolution: '1920x1080', width: 1920, height: 1080, fps: 30, concurrency: 4, volume: 100
  });
  assert.equal(resolveGenerationProfile({ mode: 'fast', fps: 30 }).fps, 1);
  assert.equal(resolveGenerationProfile({ mode: 'fast', fps: 10 }).fps, 1);
  assert.equal(resolveGenerationProfile({ mode: 'fast', fps: 5 }).fps, 1);
  assert.equal(resolveGenerationProfile({ mode: 'ultra_fast', fps: 30 }).mode, 'ultra_fast');
  assert.equal(resolveGenerationProfile({ mode: 'ultra_fast', fps: 30 }).fps, 1);
});

test('supports output volume from 0% to 200% with 100% as the default', () => {
  assert.equal(normalizeGenerationVolume(undefined), 100);
  assert.equal(normalizeGenerationVolume(''), 100);
  assert.equal(normalizeGenerationVolume(75), 75);
  assert.equal(normalizeGenerationVolume(-20), 0);
  assert.equal(normalizeGenerationVolume(250), 200);
  assert.equal(getGenerationVolumeMultiplier(150), 1.5);
  assert.equal(resolveGenerationProfile({ volume: 135 }).volume, 135);
});

test('supports 2, 4, 6, 8 and 16 generation workers with 4 as the default', () => {
  assert.equal(resolveGenerationProfile({ concurrency: 2 }).concurrency, 2);
  assert.equal(resolveGenerationProfile({ concurrency: 6 }).concurrency, 6);
  assert.equal(resolveGenerationProfile({ concurrency: 8 }).concurrency, 8);
  assert.equal(resolveGenerationProfile({ concurrency: 16 }).concurrency, 16);
  assert.equal(resolveGenerationProfile({ concurrency: 3 }).concurrency, 4);
});

test('supports low, medium and high audio quality with high as the default', () => {
  assert.equal(resolveGenerationProfile({ quality: 'low' }).quality, 'low');
  assert.equal(resolveGenerationProfile({ quality: 'medium' }).quality, 'medium');
  assert.equal(resolveGenerationProfile({ quality: 'invalid' }).quality, 'high');
  assert.equal(getGenerationAudioBitrate('low'), '96k');
  assert.equal(getGenerationAudioBitrate('medium'), '128k');
  assert.equal(getGenerationAudioBitrate('high'), '192k');
});

test('serializes stable render-profile query parameters', () => {
  assert.equal(
    buildGenerationQuery({ order: 'shuffle', mode: 'fast', resolution: '1920x1080', fps: 10 }),
    '?order=shuffle&mode=fast&quality=high&resolution=1920x1080&fps=1&concurrency=4&volume=100'
  );
  assert.equal(
    buildGenerationQuery({ mode: 'ultra_fast', resolution: '1600x900', fps: 15 }),
    '?order=sequential&mode=ultra_fast&quality=high&resolution=1600x900&fps=1&concurrency=4&volume=100'
  );
  assert.match(buildGenerationQuery({ volume: 165 }), /&volume=165$/);
});
