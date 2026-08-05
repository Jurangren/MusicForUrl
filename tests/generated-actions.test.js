const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');

test('generated result opens the selected link in a safe new tab', () => {
  const home = fs.readFileSync(path.join(publicDir, 'views', 'home.html'), 'utf8');
  const main = fs.readFileSync(path.join(publicDir, 'js', 'main.js'), 'utf8');

  assert.match(home, /onclick="openGeneratedUrl\(\)"[^>]*>打开链接<\/button>/);
  assert.doesNotMatch(home, /id="favoriteBtn"/);
  assert.match(main, /function openGeneratedUrl\(\)/);
  assert.match(main, /link\.target = '_blank'/);
  assert.match(main, /link\.rel = 'noopener noreferrer'/);
});

test('generation progress exposes a real server-side cancel action', () => {
  const home = fs.readFileSync(path.join(publicDir, 'views', 'home.html'), 'utf8');
  const main = fs.readFileSync(path.join(publicDir, 'js', 'main.js'), 'utf8');

  assert.match(home, /id="cancelGenerationBtn"[^>]*onclick="cancelGeneration\(\)"/);
  assert.match(main, /async function cancelGeneration\(\)/);
  assert.match(main, /requestGeneration\(activeGenerationCancelPath, \{ method: 'POST'/);
  assert.match(main, /job\.status === 'cancelled'/);
});

test('render completion exposes local path before TMPLINK upload progress', () => {
  const home = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'home.html'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
  const hls = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hls.js'), 'utf8');

  assert.match(home, /id="generatedLocalPath"[^>]*hidden/);
  assert.match(home, /id="generatedLocalPathValue"/);
  assert.match(home, /id="uploadProgress"[^>]*hidden/);
  assert.match(home, /id="uploadProgressBar"/);
  assert.match(main, /function renderGeneratedLocalPath\(localPath = ''\)/);
  assert.match(main, /if \(job\.localPath\)/);
  assert.match(main, /function updateUploadProgress\(job = \{\}\)/);
  assert.match(hls, /localPath: job\.outputPath \? path\.resolve\(job\.outputPath\) : ''/);
  assert.match(hls, /queueGeneratedVideoUpload\(job\)/);
});

test('generated result uses only the TMPLINK public direct URL', () => {
  const main = fs.readFileSync(path.join(publicDir, 'js', 'main.js'), 'utf8');
  const netease = fs.readFileSync(path.join(__dirname, '..', 'routes', 'playlist.js'), 'utf8');
  const qq = fs.readFileSync(path.join(__dirname, '..', 'routes', 'qq-playlist.js'), 'utf8');
  assert.match(main, /escapeUrl\(job\.publicUrl/);
  assert.match(main, /公开直链/);
  assert.doesNotMatch(main, /type: 'mp4'/);
  assert.doesNotMatch(netease, /const mp4Url =/);
  assert.doesNotMatch(qq, /const mp4Url =/);
});

test('playlist generation is submitted to a refresh-safe multi-task queue', () => {
  const home = fs.readFileSync(path.join(publicDir, 'views', 'home.html'), 'utf8');
  const main = fs.readFileSync(path.join(publicDir, 'js', 'main.js'), 'utf8');
  const hls = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hls.js'), 'utf8');

  assert.match(home, /id="generationQueuePanel"[^>]*hidden/);
  assert.match(home, /id="generationQueueList"/);
  assert.match(main, /api\('\/playlist-video\/generation-jobs'/);
  assert.match(main, /qqApi\('\/playlist-video\/generation-jobs'/);
  assert.match(main, /async function cancelGenerationJob\(button\)/);
  assert.match(hls, /const playlistGenerationQueue = new SerialJobQueue\(\)/);
  assert.match(hls, /const playlistUploadQueue = new SerialJobQueue\(\)/);
  assert.match(hls, /router\.get\('\/generation-jobs'/);
  assert.match(hls, /playlistGenerationQueue\.enqueue\(id\)/);
  assert.match(hls, /job\.status === 'queued'/);
  assert.match(hls, /waitingForUpload \? playlistUploadQueue : playlistGenerationQueue/);
  assert.match(main, /async function confirmGenerationJob\(button\)/);
  assert.match(main, /generation-task-confirm/);
  assert.match(hls, /router\.post\('\/generation-jobs\/:jobId\/dismiss'/);
  assert.match(hls, /router\.post\('\/generation-jobs\/reupload'/);
});

test('personal center validates and saves a source-specific TMPLINK token', () => {
  const userView = fs.readFileSync(path.join(publicDir, 'views', 'user.html'), 'utf8');
  const footer = fs.readFileSync(path.join(publicDir, 'includes', 'footer.html'), 'utf8');
  const main = fs.readFileSync(path.join(publicDir, 'js', 'main.js'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'upload-settings.js'), 'utf8');
  assert.match(userView, /id="tmplinkTokenInput"[^>]*type="password"/);
  assert.match(userView, /onclick="saveTmplinkToken\(\)"/);
  assert.match(main, /async function saveTmplinkToken\(\)/);
  assert.match(userView, /onclick="showTmplinkHelp\(\)"/);
  assert.match(footer, /id="tmplinkHelpModal"/);
  assert.match(footer, /app_token/);
  assert.match(footer, /Local Storage/);
  assert.match(main, /function showTmplinkHelp\(\)/);
  assert.match(main, /function hideTmplinkHelp\(\)/);
  assert.match(route, /await client\.validateToken\(\)/);
  assert.match(route, /uploadCredentialOps\.set\.run/);
  assert.ok(route.indexOf('await client.validateToken()') < route.indexOf('uploadCredentialOps.set.run'));
});

test('generation order can be selected before creating the MP4', () => {
  const home = fs.readFileSync(path.join(publicDir, 'views', 'home.html'), 'utf8');
  const main = fs.readFileSync(path.join(publicDir, 'js', 'main.js'), 'utf8');
  const hls = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hls.js'), 'utf8');
  assert.match(home, /name="generationOrder" value="sequential" checked/);
  assert.match(home, /name="generationOrder" value="shuffle"/);
  assert.match(main, /&order=' \+ generationOrder/);
  assert.match(hls, /job\.order === 'shuffle' \? shuffleTracks\(playlistTracks\) : playlistTracks/);
});

test('quality, balanced and ultra-fast generation modes can be selected below playback order', () => {
  const home = fs.readFileSync(path.join(publicDir, 'views', 'home.html'), 'utf8');
  const main = fs.readFileSync(path.join(publicDir, 'js', 'main.js'), 'utf8');
  const hls = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hls.js'), 'utf8');
  assert.match(home, /name="generationMode" value="default"/);
  assert.match(home, /name="generationMode" value="default"[^>]*><span>质量<\/span>/);
  assert.match(home, /name="generationMode" value="fast" checked[^>]*><span>平衡<\/span>/);
  assert.match(home, /name="generationMode" value="ultra_fast"[^>]*><span>极速<\/span>/);
  assert.match(main, /\['fast', 'ultra_fast'\]\.includes\(selectedGenerationMode\)/);
  assert.match(main, /'&mode=' \+ generationMode/);
  assert.match(home, /name="generationResolution" value="1600x900"/);
  assert.match(home, /name="generationResolution" value="1920x1080" checked/);
  assert.match(home, /name="generationFps" value="15" checked/);
  assert.match(home, /name="generationFps" value="30" data-standard-only/);
  assert.match(home, /id="fastFpsNotice"[^>]*hidden>1 FPS/);
  assert.match(main, /input\.disabled = fixedFpsMode/);
  assert.match(main, /generationMode === 'fast' \|\| generationMode === 'ultra_fast'/);
  assert.match(hls, /if \(isUltraFastGenerationMode\(mode\)\) return Promise\.resolve\(''\)/);
  assert.match(hls, /durationOnly: ultraFastMode === true/);
  assert.match(hls, /singleFrame: ultraFastMode === true/);
});

test('render and upload use separate single-slot queues', () => {
  const hls = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hls.js'), 'utf8');
  assert.match(hls, /const playlistGenerationQueue = new SerialJobQueue\(\)/);
  assert.match(hls, /const playlistUploadQueue = new SerialJobQueue\(\)/);
  assert.match(hls, /job\.outputPath = await buildPlaylistMp4[\s\S]*queueGeneratedVideoUpload\(job\)/);
  assert.match(hls, /playlistUploadQueue\.enqueue\(job\.id\)/);
  assert.match(hls, /if \(playlistUploadQueue\.runningId\) return/);
  assert.match(hls, /playlistGenerationQueue\.finish\(job\.id\)[\s\S]*startNextPlaylistGenerationJob/);
  assert.match(hls, /taskType: 'upload_only'[\s\S]*playlistUploadQueue\.enqueue\(id\)/);
});

test('playlist MP4 files are written directly in the output root', () => {
  const hls = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hls.js'), 'utf8');
  assert.match(hls, /return path\.join\(PLAYLIST_MP4_DIR, buildPlaylistOutputFilename\(options\)\)/);
  assert.doesNotMatch(hls, /return path\.join\(PLAYLIST_MP4_DIR, storageKey, buildPlaylistOutputFilename/);
});

test('audio quality can be selected and defaults to high', () => {
  const home = fs.readFileSync(path.join(publicDir, 'views', 'home.html'), 'utf8');
  const main = fs.readFileSync(path.join(publicDir, 'js', 'main.js'), 'utf8');
  assert.match(home, /name="generationQuality" value="low"/);
  assert.match(home, /name="generationQuality" value="medium"/);
  assert.match(home, /name="generationQuality" value="high" checked/);
  assert.match(main, /'&quality=' \+ generationQuality/);
});

test('playlist output volume uses a 0% to 200% slider and is applied during final audio merge', () => {
  const home = fs.readFileSync(path.join(publicDir, 'views', 'home.html'), 'utf8');
  const main = fs.readFileSync(path.join(publicDir, 'js', 'main.js'), 'utf8');
  const hls = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hls.js'), 'utf8');
  assert.match(home, /id="generationVolume" type="range" min="0" max="200" step="5" value="100"/);
  assert.match(main, /'&concurrency=' \+ generationConcurrency \+ '&volume=' \+ generationVolume/);
  assert.match(hls, /'-c:v', 'copy'/);
  assert.match(hls, /volumeMultiplier === 1[\s\S]*\['-c:a', 'copy', '-bsf:a', 'aac_adtstoasc'\]/);
  assert.match(hls, /\['-c:a', 'aac', '-b:a', getGenerationAudioBitrate\(job\.quality\), '-af', `volume=\$\{volumeMultiplier\.toFixed\(2\)\}`\]/);
  assert.match(hls, /'-c:v', 'copy',[\s\S]*\.\.\.audioArgs/);
  assert.match(hls, /volume: Number\.isFinite\(Number\(job\.volume\)\)/);
});

test('generation concurrency supports 2, 4, 6, 8 and 16 with 4 selected by default', () => {
  const home = fs.readFileSync(path.join(publicDir, 'views', 'home.html'), 'utf8');
  const main = fs.readFileSync(path.join(publicDir, 'js', 'main.js'), 'utf8');
  assert.match(home, /name="generationConcurrency" value="2"/);
  assert.match(home, /name="generationConcurrency" value="4" checked/);
  assert.match(home, /name="generationConcurrency" value="6"/);
  assert.match(home, /name="generationConcurrency" value="8"/);
  assert.match(home, /name="generationConcurrency" value="16"/);
  assert.match(main, /'&concurrency=' \+ generationConcurrency/);
});

test('first high-concurrency selection warns once and can restore the previous value', () => {
  const home = fs.readFileSync(path.join(publicDir, 'views', 'home.html'), 'utf8');
  const main = fs.readFileSync(path.join(publicDir, 'js', 'main.js'), 'utf8');
  assert.match(home, /value="8" onchange="confirmHighConcurrencySelection\(this\)"/);
  assert.match(home, /value="16" onchange="confirmHighConcurrencySelection\(this\)"/);
  assert.match(main, /const HIGH_CONCURRENCY_WARNING_KEY = 'highConcurrencyWarningConfirmed'/);
  assert.match(main, /function confirmHighConcurrencySelection\(input\)/);
  assert.match(main, /window\.confirm\(/);
  assert.match(main, /localStorage\.setItem\(HIGH_CONCURRENCY_WARNING_KEY, '1'\)/);
  assert.match(main, /lastGenerationConcurrency/);
});

test('generation result lists songs skipped as confirmed unplayable', () => {
  const home = fs.readFileSync(path.join(publicDir, 'views', 'home.html'), 'utf8');
  const main = fs.readFileSync(path.join(publicDir, 'js', 'main.js'), 'utf8');
  assert.match(home, /id="generatedSkippedSongs"[^>]*hidden/);
  assert.match(home, /id="generatedSkippedSongsList"/);
  assert.match(main, /function renderSkippedSongs\(job = \{\}\)/);
  assert.match(main, /job\.skippedSongs/);
  assert.match(main, /跳过 \$\{Number\(job\.skipped\)\}/);
});

test('generation progress displays elapsed time and estimated wait time', () => {
  const home = fs.readFileSync(path.join(publicDir, 'views', 'home.html'), 'utf8');
  const main = fs.readFileSync(path.join(publicDir, 'js', 'main.js'), 'utf8');
  const hls = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hls.js'), 'utf8');
  assert.match(home, /id="generationElapsed"/);
  assert.match(home, /id="generationEta"/);
  assert.match(main, /function formatGenerationDuration\(seconds\)/);
  assert.match(main, /job\.status === 'finalizing'.*正在合并/s);
  assert.match(hls, /elapsedSeconds: timing\.elapsedSeconds/);
  assert.match(hls, /etaSeconds: timing\.etaSeconds/);
  assert.match(hls, /if \(!job\.startedAt\) job\.startedAt = Date\.now\(\)/);
  assert.match(hls, /generation_seconds:[^\n]*job\.startedAt/);
});
