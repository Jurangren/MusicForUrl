const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TmpLinkClient, decodeTokenClaims } = require('../lib/tmplink');

function tokenFor(claims) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'signature'
  ].join('.');
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('decodes TMPLINK uid and rejects expired JWT before remote save', () => {
  assert.equal(decodeTokenClaims(tokenFor({ uid: 123, exp: Math.floor(Date.now() / 1000) + 60 })).uid, 123);
  assert.throws(() => decodeTokenClaims(tokenFor({ uid: 123, exp: 1 })), /已过期/);
});

test('validates token against TMPLINK get_detail', async () => {
  let requestBody = '';
  const client = new TmpLinkClient(tokenFor({ uid: 456, exp: Math.floor(Date.now() / 1000) + 60 }), {
    fetchImpl: async (_url, options) => {
      requestBody = String(options.body);
      return json({ status: 1, data: { nickname: 'test' } });
    }
  });
  const result = await client.validateToken();
  assert.equal(result.valid, true);
  assert.equal(result.uid, '456');
  assert.match(requestBody, /action=get_detail/);
  assert.match(requestBody, /token=/);
});

test('uses 80 MiB slices by default and orders upload nodes by probe latency', async () => {
  const client = new TmpLinkClient(tokenFor({ uid: 456, exp: Math.floor(Date.now() / 1000) + 60 }), {
    fetchImpl: async (url) => {
      if (url.startsWith('https://slow.test')) await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response('', { status: 200 });
    }
  });
  assert.equal(client.sliceSize, 80 * 1024 * 1024);
  const ordered = await client.probeUploadServers(['https://slow.test', 'https://fast.test']);
  assert.deepEqual(ordered, ['https://fast.test', 'https://slow.test']);
});

test('uploads slices, waits for completion and resolves a public direct URL', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-tmplink-'));
  const filePath = path.join(tempDir, 'video.mp4');
  fs.writeFileSync(filePath, Buffer.from('video-data'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let prepareCount = 0;
  let uploadedMultipart = false;
  const progress = [];
  const client = new TmpLinkClient(tokenFor({ uid: 789, exp: Math.floor(Date.now() / 1000) + 60 }), {
    sliceSize: 1024 * 1024,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/file') && String(options.body).includes('upload_request_select2')) {
        return json({ status: 1, data: { utoken: 'upload-token', servers: [{ url: 'https://upload.test' }] } });
      }
      if (url.endsWith('/app/upload_slice') && options.body instanceof FormData) {
        uploadedMultipart = true;
        return json({ status: 5, data: null });
      }
      if (url.endsWith('/app/upload_slice')) {
        prepareCount += 1;
        return prepareCount === 1
          ? json({ status: 3, data: { next: 0, total: 1, wait: 0 } })
          : json({ status: 1, data: 'ukey-1' });
      }
      if (url.endsWith('/file') && String(options.body).includes('download_req')) {
        return json({ status: 1, data: 'https://cdn.test/video.mp4' });
      }
      throw new Error(`unexpected request: ${url}`);
    }
  });
  const result = await client.uploadAndGetDirectUrl(filePath, { onProgress: (value) => progress.push(value) });
  assert.equal(uploadedMultipart, true);
  assert.equal(result.directUrl, 'https://cdn.test/video.mp4');
  assert.equal(result.shareUrl, 'https://www.ttttt.link/file/ukey-1');
  assert.equal(progress.at(-1).percent, 100);
});
