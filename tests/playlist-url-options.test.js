const test = require('node:test');
const assert = require('node:assert/strict');

const neteaseRouter = require('../routes/playlist');
const qqRouter = require('../routes/qq-playlist');

function getRouteHandler(router, path, method) {
  const layer = router.stack.find((item) => item?.route?.path === path && item.route.methods?.[method]);
  assert.ok(layer, `Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.at(-1).handle;
}

function createMockReq({ id, source, order = 'sequential', mode = '', quality = 'high', resolution = '1920x1080', fps = 15, concurrency = 4, volume = 100 }) {
  return {
    query: { id: String(id), order, mode, quality, resolution, fps, concurrency, volume },
    params: {},
    ...(source === 'qq' ? { qqUser: { id: 88 } } : { user: { id: 66 } })
  };
}

async function invoke(handler, req) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
  await handler(req, res);
  return res;
}

for (const item of [
  { name: '网易云', router: neteaseRouter, id: '123456', source: 'netease', prefix: '/api/playlist-video/' },
  { name: 'QQ', router: qqRouter, id: '888999', source: 'qq', prefix: '/api/qq/playlist-video/' }
]) {
  test(`${item.name} /url 只返回任务地址，不提供本地 HTTP 视频链接`, async () => {
    const response = await invoke(getRouteHandler(item.router, '/url', 'get'), createMockReq(item));
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    const data = response.body.data;
    assert.equal(data.url, undefined);
    assert.equal(data.urls, undefined);
    assert.equal(data.default, undefined);
    assert.match(data.generationPath, new RegExp(`${item.prefix}.+/${item.id}/generate\\?order=sequential&quality=high&resolution=1920x1080&fps=15&concurrency=4&volume=100$`));
  });
}

test('order, mode, quality, resolution, FPS, concurrency and volume only propagate to generationPath', async () => {
  const handler = getRouteHandler(neteaseRouter, '/url', 'get');
  const shuffled = await invoke(handler, createMockReq({ id: '123456', source: 'netease', order: 'shuffle' }));
  assert.match(shuffled.body.data.generationPath, /\?order=shuffle&quality=high&resolution=1920x1080&fps=15&concurrency=4&volume=100$/);

  const fast = await invoke(handler, createMockReq({ id: '123456', source: 'netease', mode: 'fast', fps: 30 }));
  assert.equal(fast.body.data.mode, 'fast');
  assert.equal(fast.body.data.fps, 1);
  assert.match(fast.body.data.generationPath, /\?order=sequential&mode=fast&quality=high&resolution=1920x1080&fps=1&concurrency=4&volume=100$/);

  const ultraFast = await invoke(handler, createMockReq({ id: '123456', source: 'netease', mode: 'ultra_fast', fps: 30 }));
  assert.equal(ultraFast.body.data.mode, 'ultra_fast');
  assert.equal(ultraFast.body.data.fps, 1);
  assert.match(ultraFast.body.data.generationPath, /\?order=sequential&mode=ultra_fast&quality=high&resolution=1920x1080&fps=1&concurrency=4&volume=100$/);

  const standard = await invoke(handler, createMockReq({ id: '123456', source: 'netease', fps: 30 }));
  assert.equal(standard.body.data.fps, 30);
  assert.match(standard.body.data.generationPath, /resolution=1920x1080&fps=30&concurrency=4&volume=100$/);

  const low = await invoke(handler, createMockReq({ id: '123456', source: 'netease', quality: 'low' }));
  assert.equal(low.body.data.quality, 'low');
  assert.match(low.body.data.generationPath, /quality=low/);

  const eight = await invoke(handler, createMockReq({ id: '123456', source: 'netease', concurrency: 8 }));
  assert.equal(eight.body.data.concurrency, 8);
  assert.match(eight.body.data.generationPath, /concurrency=8&volume=100$/);

  const sixteen = await invoke(handler, createMockReq({ id: '123456', source: 'netease', concurrency: 16 }));
  assert.equal(sixteen.body.data.concurrency, 16);
  assert.match(sixteen.body.data.generationPath, /concurrency=16&volume=100$/);

  const louder = await invoke(handler, createMockReq({ id: '123456', source: 'netease', volume: 145 }));
  assert.equal(louder.body.data.volume, 145);
  assert.match(louder.body.data.generationPath, /&volume=145$/);
});
