const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLrc, parseBilingualLyrics, createLyricsAss, containsInstrumentalMarker } = require('../lib/lyrics');

test('parses LRC timestamps, multiple timestamps and offset', () => {
  const cues = parseLrc('[offset:100]\n[00:01.00][00:02.50]第一句\n[00:04.20]第二句');
  assert.deepEqual(cues.map((cue) => [cue.start, cue.text]), [
    [1.1, '第一句'], [2.6, '第一句'], [4.3, '第二句']
  ]);
});

test('creates five-line animated ASS lyric states', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-lyrics-'));
  const filePath = path.join(dir, 'lyrics.ass');
  const result = createLyricsAss(filePath, '[00:00.00]一\n[00:02.00]二\n[00:04.00]三\n[00:06.00]四\n[00:08.00]五', {
    width: 1280, height: 720, duration: 10
  });
  const content = fs.readFileSync(filePath, 'utf8');
  assert.equal(result.cueCount, 5);
  assert.match(content, /\\move\(/);
  assert.doesNotMatch(content, /\\fad\(/);
  assert.match(content, /\\an5/);
  assert.match(content, /}一/);
  assert.match(content, /\\fs\d+\\b650/);
  assert.match(content, /\\t\(\d+,\d+,0\.85,\\fs\d+\\alpha&H[0-9A-F]+&\)/);
});

test('renders five lyric rows with synchronized movement, size and opacity transitions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-lyrics-five-'));
  const filePath = path.join(dir, 'lyrics.ass');
  createLyricsAss(filePath, '[00:00.00]one\n[00:02.00]two\n[00:04.00]three\n[00:06.00]four\n[00:08.00]five', {
    width: 1920, height: 1080, duration: 10
  });
  const content = fs.readFileSync(filePath, 'utf8');
  const middleState = content.split('\n').filter((line) => line.startsWith('Dialogue: 0,0:00:04.00')).join('\n');
  for (const word of ['one', 'two', 'three', 'four', 'five']) assert.match(middleState, new RegExp(word));
  assert.match(middleState, /\\move\([^)]*\)/);
  assert.match(middleState, /\\fs72.*\\t\([^)]*\\fs42\\alpha&H68&\)/);
  assert.match(middleState, /\\fs42.*\\t\([^)]*\\fs72\\alpha&H00&\)/);
  assert.doesNotMatch(middleState, /\\fad\(/);
  const moves = Array.from(middleState.matchAll(/\\move\(\d+,(-?\d+),\d+,(-?\d+),/g));
  assert.ok(moves.length >= 5);
  for (const move of moves) assert.ok(Number(move[2]) < Number(move[1]), `歌词必须只向上移动: ${move[0]}`);
});

test('does not render a placeholder when synchronized lyrics are unavailable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-lyrics-empty-'));
  const filePath = path.join(dir, 'lyrics.ass');
  const result = createLyricsAss(filePath, '', { width: 1280, height: 720, duration: 10 });
  const content = fs.readFileSync(filePath, 'utf8');
  assert.equal(result.cueCount, 0);
  assert.doesNotMatch(content, /Dialogue:/);
  assert.doesNotMatch(content, /暂无同步歌词/);
});

test('treats any lyrics containing the instrumental marker as no lyrics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-lyrics-instrumental-'));
  const filePath = path.join(dir, 'lyrics.ass');
  const result = createLyricsAss(filePath, {
    original: '[00:00.00]前置内容\n[00:01.00]纯音乐，请欣赏\n[00:02.00]后置内容',
    translation: '[00:00.00]Other text'
  }, { width: 1920, height: 1080, duration: 10 });
  const content = fs.readFileSync(filePath, 'utf8');
  assert.equal(result.instrumental, true);
  assert.equal(result.cueCount, 0);
  assert.doesNotMatch(content, /Dialogue:/);
  assert.equal(containsInstrumentalMarker({
    original: '[00:00.00]Real lyrics',
    translation: '[00:00.00]纯音乐，请欣赏'
  }), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uses translated lyrics as the main line and keeps the original below it', () => {
  const cues = parseBilingualLyrics({
    original: '[00:01.00]Hello world\n[00:03.00]Good night',
    translation: '[00:01.10]你好世界\n[00:03.00]晚安'
  });
  assert.deepEqual(cues.map((cue) => [cue.primary, cue.original, cue.translated]), [
    ['你好世界', 'Hello world', true],
    ['晚安', 'Good night', true]
  ]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-lyrics-bilingual-'));
  const filePath = path.join(dir, 'lyrics.ass');
  const result = createLyricsAss(filePath, {
    original: '[00:01.00]Hello world',
    translation: '[00:01.00]你好世界'
  }, { width: 1280, height: 720, duration: 5 });
  const content = fs.readFileSync(filePath, 'utf8');
  assert.equal(result.translatedCueCount, 1);
  assert.match(content, /Lyrics,Main[^\n]+你好世界/);
  assert.match(content, /Lyrics,Original[^\n]+\\fs\d+\\b650[^\n]+Hello world/);
  assert.match(content, /Hello world/);
});

test('rapid lyric cues never overlap and skip low-frame-count slide animations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-lyrics-rapid-'));
  const filePath = path.join(dir, 'lyrics.ass');
  createLyricsAss(filePath, '[00:00.00]one\n[00:00.05]two\n[00:00.18]three\n[00:00.40]four', {
    width: 1920, height: 1080, duration: 1
  });
  const content = fs.readFileSync(filePath, 'utf8');
  const events = content.split('\n').filter((line) => line.startsWith('Dialogue:'));
  const toSeconds = (value) => {
    const match = String(value).match(/(\d+):(\d+):(\d+)\.(\d+)/);
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 100;
  };
  const ranges = Array.from(new Set(events.map((line) => {
    const fields = line.split(',');
    return `${toSeconds(fields[1])}|${toSeconds(fields[2])}`;
  }))).map((range) => range.split('|').map(Number));
  for (let index = 0; index < ranges.length - 1; index++) {
    assert.ok(ranges[index][1] <= ranges[index + 1][0]);
  }
  assert.match(events[0], /\\pos\(/);
  assert.doesNotMatch(content, /\\move\(/);
  assert.doesNotMatch(content, /\\t\(/);
  assert.doesNotMatch(content, /\\b(?:0|700|900)/);
});

test('fast lyrics hard-cut between states without slide animation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-lyrics-fast-'));
  const filePath = path.join(dir, 'lyrics.ass');
  createLyricsAss(filePath, '[00:00.00]one\n[00:02.00]two\n[00:04.00]three', {
    width: 1600, height: 900, duration: 6, hardCut: true
  });
  const content = fs.readFileSync(filePath, 'utf8');
  assert.match(content, /\\pos\(/);
  assert.doesNotMatch(content, /\\move\(/);
  assert.doesNotMatch(content, /\\t\(/);
  assert.match(content, /\\b650/);
});
