const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePreference, probeEncoder } = require('../lib/video-encoder');

test('normalizes GPU encoder aliases', () => {
  assert.equal(normalizePreference('nvidia'), 'h264_nvenc');
  assert.equal(normalizePreference('intel'), 'h264_qsv');
  assert.equal(normalizePreference('amd'), 'h264_amf');
  assert.equal(normalizePreference('cpu'), 'libx264');
  assert.equal(normalizePreference('unknown'), 'auto');
});

test('CPU encoder is always an available fallback', () => {
  assert.equal(probeEncoder('ffmpeg', 'libx264'), true);
});
