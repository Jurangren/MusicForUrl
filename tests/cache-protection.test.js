const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('playlist generation protects every song cache until final MP4 merge finishes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hls.js'), 'utf8');
  assert.match(source, /const protectedSongCacheKeys = new Map\(\)/);
  assert.match(source, /generatingLocks\.has\(songId\) \|\| isSongCacheProtected\(songId\)/);
  assert.match(source, /async function deleteSongDir\(info\) \{\s*if \(generatingLocks\.has\(info\.songId\) \|\| isSongCacheProtected\(info\.songId\)\) return 0/);

  const runStart = source.indexOf('async function runPlaylistGenerationJob');
  const runEnd = source.indexOf("router.post('/:token/:playlistId/generate'", runStart);
  const runSource = source.slice(runStart, runEnd);
  const protectAt = runSource.indexOf('protectSongCacheForJob(job, cacheKey)');
  const generateAt = runSource.indexOf('await Promise.all');
  const mergeAt = runSource.indexOf('job.outputPath = await buildPlaylistMp4');
  const releaseAt = runSource.indexOf('releaseProtectedSongCaches(job)', mergeAt);
  assert.ok(protectAt >= 0 && protectAt < generateAt, 'cache must be pinned before parallel song generation');
  assert.ok(mergeAt >= 0 && releaseAt > mergeAt, 'cache must remain pinned through playlist merge');
  assert.match(runSource, /finally \{\s*releaseProtectedSongCaches\(job\)/);
});
