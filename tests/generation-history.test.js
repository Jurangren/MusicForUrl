const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { userOps, generationHistoryOps } = require('../lib/db');
const router = require('../routes/generation-history');

function handlerFor(routePath, method) {
  const layer = router.stack.find((item) => item?.route?.path === routePath && item.route.methods?.[method]);
  assert.ok(layer);
  return layer.route.stack.at(-1).handle;
}

test('generation history API returns all requested display fields for the authenticated account', async (t) => {
  const originalUserLookup = userOps.getByToken.get;
  const originalList = generationHistoryOps.list.all;
  const originalCount = generationHistoryOps.count.get;
  userOps.getByToken.get = () => ({ id: 66 });
  generationHistoryOps.list.all = () => [{
    job_id: 'job-1', source: 'netease', playlist_id: '123', playlist_name: '歌单',
    playlist_cover: 'https://img.test/cover.jpg', playlist_creator: '作者',
    generated_at: '2026-08-03T01:02:03.000Z', generation_seconds: 42,
    public_url: 'https://cdn.test/video.mp4', local_path: 'C:\\video.mp4', upload_status: 'completed'
  }];
  generationHistoryOps.count.get = () => ({ count: 1 });
  t.after(() => {
    userOps.getByToken.get = originalUserLookup;
    generationHistoryOps.list.all = originalList;
    generationHistoryOps.count.get = originalCount;
  });

  const req = { query: { source: 'netease', page: '1', limit: '10' }, headers: { 'x-token': 'login-token' } };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
  await handlerFor('/', 'get')(req, res);
  assert.equal(res.body.success, true);
  assert.equal(res.body.total, 1);
  assert.deepEqual(res.body.data[0], {
    jobId: 'job-1', source: 'netease', playlistId: '123', playlistName: '歌单',
    playlistCover: 'https://img.test/cover.jpg', playlistCreator: '作者',
    generatedAt: '2026-08-03T01:02:03.000Z', generationSeconds: 42,
    publicUrl: 'https://cdn.test/video.mp4', localPath: 'C:\\video.mp4', uploadStatus: 'completed'
  });
});

test('history page renders playlist, author, time, duration, link and local path', () => {
  const root = path.join(__dirname, '..');
  const view = fs.readFileSync(path.join(root, 'public', 'views', 'generated.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'public', 'js', 'main.js'), 'utf8');
  const hls = fs.readFileSync(path.join(root, 'routes', 'hls.js'), 'utf8');
  assert.match(view, /id="generationHistoryList"/);
  assert.match(main, /item\.playlistName/);
  assert.match(main, /item\.playlistCover/);
  assert.match(main, /item\.playlistCreator/);
  assert.match(main, /item\.generatedAt/);
  assert.match(main, /item\.generationSeconds/);
  assert.match(main, /item\.publicUrl/);
  assert.match(main, /item\.localPath/);
  assert.match(main, /formatGenerationHistoryExpiration/);
  assert.match(main, /`\$\{days\}天\$\{hours\}小时后`/);
  assert.match(main, /checkGenerationHistoryLinks/);
  assert.match(main, /reuploadGenerationHistory/);
  assert.match(main, /重新上传/);
  assert.match(hls, /recordGenerationHistory\(job\)/);
  assert.match(hls, /updateGenerationHistoryUpload\(job\)/);
});
