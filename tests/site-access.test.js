const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSiteAccess, readStoredConfig } = require('../lib/site-access');

function tempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-site-access-'));
  return path.join(dir, 'site-access.json');
}

test('first-time setup stores a hash and authenticates without plaintext', () => {
  const configFile = tempConfigPath();
  const access = createSiteAccess({ configFile, envSecret: '', cookieSigningKey: 'test-key' });

  assert.equal(access.configured(), false);
  access.setup('correct horse battery staple');
  assert.equal(access.configured(), true);
  assert.equal(access.verify('correct horse battery staple'), true);
  assert.equal(access.verify('wrong secret'), false);

  const raw = fs.readFileSync(configFile, 'utf8');
  assert.equal(raw.includes('correct horse battery staple'), false);
  assert.ok(readStoredConfig(configFile).hash);
});

test('setup can only run once', () => {
  const access = createSiteAccess({ configFile: tempConfigPath(), envSecret: '', cookieSigningKey: 'test-key' });
  access.setup('12345678');
  assert.throws(() => access.setup('abcdefgh'), /已经设置/);
});

test('environment secret takes precedence over stored setup', () => {
  const configFile = tempConfigPath();
  const initial = createSiteAccess({ configFile, envSecret: '', cookieSigningKey: 'test-key' });
  initial.setup('stored-secret');

  const access = createSiteAccess({ configFile, envSecret: 'environment-secret', cookieSigningKey: 'test-key' });
  assert.equal(access.source(), 'environment');
  assert.equal(access.verify('environment-secret'), true);
  assert.equal(access.verify('stored-secret'), false);
});

test('authentication cookie changes with the configured credential', () => {
  const first = createSiteAccess({ configFile: tempConfigPath(), envSecret: 'first-secret', cookieSigningKey: 'test-key' });
  const second = createSiteAccess({ configFile: tempConfigPath(), envSecret: 'second-secret', cookieSigningKey: 'test-key' });
  assert.notEqual(first.cookieValue(), second.cookieValue());
  assert.equal(first.isCookieValid(first.cookieValue()), true);
  assert.equal(first.isCookieValid(second.cookieValue()), false);
});
