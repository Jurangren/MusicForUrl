const test = require('node:test');
const assert = require('node:assert/strict');
const { SerialJobQueue } = require('../lib/serial-job-queue');

test('歌单任务严格按入队顺序逐个开始', () => {
  const queue = new SerialJobQueue();
  queue.enqueue('first');
  queue.enqueue('second');
  queue.enqueue('third');

  assert.equal(queue.startNext(), 'first');
  assert.equal(queue.startNext(), null);
  assert.equal(queue.position('first'), 0);
  assert.equal(queue.position('second'), 1);
  assert.equal(queue.position('third'), 2);

  queue.finish('first');
  assert.equal(queue.startNext(), 'second');
  queue.finish('second');
  assert.equal(queue.startNext(), 'third');
});

test('未开始的排队任务可以直接移除且不影响后续顺序', () => {
  const queue = new SerialJobQueue();
  queue.enqueue('running');
  queue.enqueue('cancelled');
  queue.enqueue('next');
  assert.equal(queue.startNext(), 'running');

  assert.equal(queue.remove('cancelled'), true);
  assert.equal(queue.position('cancelled'), -1);
  assert.equal(queue.position('next'), 1);

  queue.finish('running');
  assert.equal(queue.startNext(), 'next');
});

test('重复入队和错误完成不会破坏正在运行的任务', () => {
  const queue = new SerialJobQueue();
  assert.equal(queue.enqueue('job'), true);
  assert.equal(queue.enqueue('job'), false);
  assert.equal(queue.startNext(), 'job');
  assert.equal(queue.enqueue('job'), false);
  assert.equal(queue.finish('other'), false);
  assert.equal(queue.runningId, 'job');
  assert.equal(queue.finish('job'), true);
  assert.equal(queue.runningId, null);
});
