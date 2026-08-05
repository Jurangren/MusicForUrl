const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { moveFileSync } = require('../lib/file-move');

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-file-move-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('moves a completed MP4 with rename when source and destination share a device', (t) => {
  const dir = createTempDir(t);
  const source = path.join(dir, 'source.mp4');
  const destination = path.join(dir, 'destination.mp4');
  fs.writeFileSync(source, 'completed-video');

  const result = moveFileSync(source, destination);

  assert.deepEqual(result, { method: 'rename', sourceRemoved: true });
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'completed-video');
});

test('falls back to verified copy and cleanup when rename reports EXDEV', (t) => {
  const dir = createTempDir(t);
  const source = path.join(dir, 'source.mp4');
  const destination = path.join(dir, 'destination.mp4');
  fs.writeFileSync(source, Buffer.alloc(1024 * 1024, 0x5a));
  fs.writeFileSync(destination, 'old-video');

  const fileSystem = Object.create(fs);
  let injected = false;
  fileSystem.renameSync = (from, to) => {
    if (!injected && from === source && to === destination) {
      injected = true;
      const error = new Error('cross-device link not permitted');
      error.code = 'EXDEV';
      throw error;
    }
    return fs.renameSync(from, to);
  };

  const result = moveFileSync(source, destination, {
    fileSystem,
    stagingSuffix: 'cross-device-test'
  });

  assert.deepEqual(result, { method: 'copy', sourceRemoved: true });
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.statSync(destination).size, 1024 * 1024);
  assert.equal(fs.readFileSync(destination)[0], 0x5a);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.part')), []);
});
