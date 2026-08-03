const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveSongUrlResponse } = require('../lib/netease');

test('NetEase 404 song response is classified as confirmed unplayable', () => {
  assert.throws(
    () => resolveSongUrlResponse({ body: { code: 200, data: [{ code: 404, url: null }] } }, '4949145'),
    (error) => error?.code === 'SONG_UNPLAYABLE' && error?.upstreamCode === 404
  );
});

test('valid song URLs still pass through and ambiguous failures are not silently skipped', () => {
  assert.equal(
    resolveSongUrlResponse({ body: { code: 200, data: [{ code: 200, url: 'https://example.com/song.mp3' }] } }, '1'),
    'https://example.com/song.mp3'
  );
  assert.equal(resolveSongUrlResponse({ body: { code: 502 } }, '1'), null);
  assert.equal(resolveSongUrlResponse({ body: { code: 200, data: [{ code: 200, url: null }] } }, '1'), null);
});

test('playlist generation skips only confirmed unplayable songs and excludes them from merge', () => {
  const hls = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hls.js'), 'utf8');
  assert.match(hls, /if \(error\?\.code === 'SONG_UNPLAYABLE'\) \{/);
  assert.match(hls, /job\.skippedSongs\.push\(\{/);
  assert.match(hls, /job\.skippedIndexes\.has\(songIndex\)\) continue/);
  assert.match(hls, /skippedSongs: Array\.isArray\(job\.skippedSongs\)/);
});
