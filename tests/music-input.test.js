const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNeteaseSongId,
  parseQQSongMid,
  createVirtualPlaylistId
} = require('../lib/music-input');

test('recognizes NetEase single-song links without confusing playlist links', () => {
  assert.equal(parseNeteaseSongId('https://music.163.com/#/song?id=123456789'), '123456789');
  assert.equal(parseNeteaseSongId('https://music.163.com/song/987654321'), '987654321');
  assert.equal(parseNeteaseSongId('https://music.163.com/playlist?id=123456789'), null);
  assert.equal(parseNeteaseSongId('123456789'), null);
});

test('recognizes common QQ Music single-song links', () => {
  assert.equal(parseQQSongMid('https://y.qq.com/n/ryqq/songDetail/003OUlho2HcRHC'), '003OUlho2HcRHC');
  assert.equal(parseQQSongMid('https://i.y.qq.com/v8/playsong.html?songmid=001ABCdef9'), '001ABCdef9');
  assert.equal(parseQQSongMid('https://y.qq.com/n/ryqq/playlist/123456'), null);
});

test('creates stable numeric virtual playlist ids for playback routes', () => {
  const neteaseId = createVirtualPlaylistId('netease', '123');
  const qqId = createVirtualPlaylistId('qq', '003OUlho2HcRHC');
  assert.match(neteaseId, /^8\d{15}$/);
  assert.match(qqId, /^9\d{15}$/);
  assert.equal(createVirtualPlaylistId('netease', '123'), neteaseId);
  assert.notEqual(neteaseId, qqId);
});
