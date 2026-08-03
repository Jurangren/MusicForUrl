const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { isAllowedTmpLinkHost, probePublicLink } = require('../lib/public-link-health');

function requestReturning(statusCode) {
  return (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = (error) => request.emit('error', error);
    request.end = () => callback({ statusCode, resume() {} });
    return request;
  };
}

test('only probes known TMPLINK delivery hosts', () => {
  assert.equal(isAllowedTmpLinkHost('tmp-hd100.vx-cdn.com'), true);
  assert.equal(isAllowedTmpLinkHost('connect.cntmp.link'), true);
  assert.equal(isAllowedTmpLinkHost('example.com'), false);
});

test('treats HTTP 200 as valid and HTTP 302 as expired', async () => {
  const valid = await probePublicLink('https://tmp-hd100.vx-cdn.com/video.mp4', { requestImpl: requestReturning(200) });
  const expired = await probePublicLink('https://tmp-hd100.vx-cdn.com/video.mp4', { requestImpl: requestReturning(302) });
  assert.equal(valid.valid, true);
  assert.equal(valid.statusCode, 200);
  assert.equal(expired.valid, false);
  assert.equal(expired.statusCode, 302);
});

test('rejects unsupported hosts without making a request', async () => {
  let requested = false;
  const result = await probePublicLink('http://127.0.0.1/private', {
    requestImpl() { requested = true; }
  });
  assert.equal(result.valid, false);
  assert.equal(requested, false);
});
