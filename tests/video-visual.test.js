const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeTrackMeta, truncateToUnits, resolveFontFile, createTextAssets, removeTextAssets, formatClock, buildVisualFilter } = require('../lib/video-visual');

test('normalizes title, subtitle, album and artist metadata', () => {
  assert.deepEqual(normalizeTrackMeta({ name: 'Song', alias: ['Live', '2026'], album: 'Album', artist: 'Artist' }, 'Playlist'), {
    title: 'Song', subtitle: 'Live / 2026', album: 'Album', artist: 'Artist'
  });
});

test('creates text files for FFmpeg without embedding metadata in filter syntax', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-video-visual-'));
  const assets = createTextAssets(path.join(dir, 'song'), {
    name: "A title: with 'quotes'", subtitle: '副标题', album: '专辑', artist: '歌手'
  });
  assert.equal(fs.readFileSync(assets.files.title, 'utf8'), "A title: with 'quotes'");
  assert.equal(fs.readFileSync(assets.files.artist, 'utf8'), '歌手');
  const filter = buildVisualFilter({
    width: 1280,
    height: 720,
    fps: 5,
    duration: 180,
    textFiles: assets.files,
    fontFile: '/tmp/font.ttf'
  });
  assert.match(filter, /gblur/);
  assert.doesNotMatch(filter, /zoompan|fluidbg|flowwash/);
  assert.match(filter, /loop=loop=-1:size=1:start=0/);
  assert.match(filter, /geq=.*a=.*pow\(max\(abs\(X-W\/2\)/);
  assert.match(filter, /drawtext/);
  assert.match(filter, /\[progress\]/);
  assert.match(filter, /fade=t=in/);
  assert.match(filter, /fade=t=out/);
  assert.match(filter, /floor\(t\/60\)/);
  assert.match(filter, /mod\(max\(t-0\.8,0\)\*/);
  assert.match(filter, /if\(lte\(text_w,\d+\)/);
  assert.equal(filter.includes("A title: with 'quotes'"), false);
  removeTextAssets(assets);
  assert.equal(fs.existsSync(assets.files.title), false);
  assert.equal(fs.existsSync(assets.files.artist), false);
});

test('preserves long metadata for seamless scrolling instead of adding an ellipsis', () => {
  const longTitle = 'This is a deliberately very long title that must stay complete while it scrolls across the video';
  assert.equal(normalizeTrackMeta({ name: longTitle }).title, longTitle);
  assert.equal(normalizeTrackMeta({ name: longTitle }).title.includes('…'), false);
});

test('balanced visual mode truncates metadata and removes scrolling and fades', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-video-fast-'));
  assert.equal(truncateToUnits('This title is much too long', 8).endsWith('...'), true);
  const assets = createTextAssets(path.join(dir, 'song'), {
    name: 'This title is deliberately far too long for the static title area',
    subtitle: 'A very long subtitle that should be shortened',
    album: 'An excessively long album name',
    artist: 'An excessively long artist name that keeps going far beyond the available static area'
  }, '', { width: 1600, height: 900, truncate: true });
  assert.match(fs.readFileSync(assets.files.title, 'utf8'), /\.\.\.$/);
  assert.match(fs.readFileSync(assets.files.artist, 'utf8'), /\.\.\.$/);
  const filter = buildVisualFilter({
    width: 1600,
    height: 900,
    fps: 1,
    duration: 10,
    textFiles: assets.files,
    staticText: true,
    disableFade: true
  });
  assert.doesNotMatch(filter, /mod\(max\(t-0\.8,0\)/);
  assert.doesNotMatch(filter, /fade=t=/);
  assert.match(filter, /N\/\(1\*10\.000\)/);
  assert.match(filter, /\[progress\]/);
  removeTextAssets(assets);
});

test('ultra-fast visual renders one static instrumental frame with duration only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-video-ultra-fast-'));
  const assets = createTextAssets(path.join(dir, 'song'), {
    name: 'Static song', subtitle: 'No lyric layout', album: 'Album', artist: 'Artist'
  });
  const filter = buildVisualFilter({
    width: 1920,
    height: 1080,
    fps: 1,
    duration: 245,
    textFiles: assets.files,
    lyricsFile: path.join(dir, 'lyrics.ass'),
    staticText: true,
    disableFade: true,
    durationOnly: true,
    singleFrame: true,
    hasLyrics: false
  });
  assert.doesNotMatch(filter, /subtitles=filename=|\[bartrack\]|\[progress\]|floor\(t\/60\)|fade=t=/);
  assert.match(filter, /text='04\\:05'/);
  assert.match(filter, /\[artist\]\[titlescrolllayer\]overlay=x=806:y=378/);
  assert.match(filter, /trim=end_frame=1,setpts=PTS-STARTPTS,loop=loop=-1:size=1:start=0/);
  assert.match(filter, /setpts=N\/\(1\*TB\),format=yuv420p\[vout\]/);
  removeTextAssets(assets);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keeps subtitle independent and renders artist below album', () => {
  const meta = normalizeTrackMeta({ name: 'Song', album: 'Album', artist: 'Artist' });
  assert.equal(meta.subtitle, '');
  assert.equal(meta.artist, 'Artist');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-video-artist-'));
  const assets = createTextAssets(path.join(dir, 'song'), { name: 'Song', subtitle: 'Sub', album: 'Album', artist: 'Artist' });
  const filter = buildVisualFilter({ width: 1920, height: 1080, fps: 15, duration: 10, textFiles: assets.files });
  assert.match(filter, /\[album\]\[artistscrolllayer\]overlay=/);
  assert.match(filter, /\[artist\]\[titlescrolllayer\]overlay=/);
  removeTextAssets(assets);
});

test('centers title, subtitle and progress when synchronized lyrics are absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-video-no-lyrics-'));
  const assets = createTextAssets(path.join(dir, 'song'), {
    name: 'Instrumental', subtitle: 'No lyrics', album: 'Album', artist: 'Artist'
  });
  const filter = buildVisualFilter({
    width: 1920,
    height: 1080,
    fps: 15,
    duration: 60,
    textFiles: assets.files,
    lyricsFile: path.join(dir, 'empty.ass'),
    hasLyrics: false
  });
  assert.doesNotMatch(filter, /subtitles=filename=/);
  assert.match(filter, /\[artist\]\[titlescrolllayer\]overlay=x=806:y=378/);
  assert.match(filter, /\[trackcounter\]\[bartrack\]overlay=x=836:y=670/);
  assert.match(filter, /\[subtitle\]drawtext=.*track_counter/s);
  removeTextAssets(assets);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formats total duration for the right progress label', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(185.9), '03:05');
  assert.equal(formatClock(3661), '61:01');
});

test('prefers an installed bold font and keeps text shadows subtle', () => {
  const resolved = resolveFontFile();
  if (process.platform === 'win32') assert.match(path.basename(resolved).toLowerCase(), /msyhbd|dengb|simhei/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-video-bold-'));
  const assets = createTextAssets(path.join(dir, 'song'), { name: 'Title', subtitle: 'Subtitle', album: 'Album' });
  const filter = buildVisualFilter({
    width: 1920,
    height: 1080,
    fps: 15,
    duration: 10,
    textFiles: assets.files
  });
  assert.match(filter, /shadowcolor=black@0\.20:shadowx=1:shadowy=1/);
  assert.doesNotMatch(filter, /shadowcolor=black@0\.48|shadowx=2:shadowy=3/);
  removeTextAssets(assets);
});

test('removes the diffuse cover glow and renders playlist context plus a persistent counter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-video-context-'));
  const assets = createTextAssets(path.join(dir, 'song'), { name: 'Song', album: 'Album', artist: 'Artist' }, '', {
    width: 1600,
    height: 900,
    collectionName: '我的歌单',
    collectionCreator: '小明',
    currentIndex: 2,
    totalTracks: 12,
    showCollection: true
  });
  assert.equal(fs.readFileSync(assets.files.collectionTitle, 'utf8'), '歌单：我的歌单');
  assert.equal(fs.readFileSync(assets.files.collectionAuthor, 'utf8'), '作者：小明');
  assert.equal(fs.readFileSync(assets.files.trackCounter, 'utf8'), '2 / 12');

  const filter = buildVisualFilter({
    width: 1600,
    height: 900,
    fps: 15,
    duration: 60,
    textFiles: assets.files,
    lyricsFile: path.join(dir, 'lyrics.ass'),
    showCollection: assets.showCollection
  });
  assert.doesNotMatch(filter, /coverglow|glowsrc|glowlaid/);
  assert.match(filter, /\[collectiontitle\].*collection_author\.txt/);
  assert.match(filter, /track_counter\.txt.*x=w-text_w-/);
  assert.doesNotMatch(filter, /between\(t|collectionAlpha/);
  assert.match(filter, /collection_title\.txt.*fontcolor=white@0\.82/);
  removeTextAssets(assets);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('single-song output hides collection context but retains 1 / 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-video-single-context-'));
  const assets = createTextAssets(path.join(dir, 'song'), { name: 'Song' }, '', {
    currentIndex: 1,
    totalTracks: 1,
    showCollection: false
  });
  assert.equal(assets.showCollection, false);
  assert.equal(fs.readFileSync(assets.files.collectionTitle, 'utf8'), '');
  assert.equal(fs.readFileSync(assets.files.trackCounter, 'utf8'), '1 / 1');
  const filter = buildVisualFilter({
    width: 1600,
    height: 900,
    fps: 5,
    duration: 30,
    textFiles: assets.files,
    lyricsFile: path.join(dir, 'lyrics.ass'),
    showCollection: false,
    disableFade: true
  });
  assert.doesNotMatch(filter, /collection_title\.txt|collection_author\.txt/);
  assert.match(filter, /track_counter\.txt/);
  removeTextAssets(assets);
  fs.rmSync(dir, { recursive: true, force: true });
});
