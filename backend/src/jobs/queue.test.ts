import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from './queue.ts';

test('queue: runs a registered handler and stores the result', async () => {
  const q = new JobQueue();
  q.register('event.analytics', async (p) => ({ echoed: p.eventId }));
  const job = q.enqueue('event.analytics', { eventId: 'e1' });
  assert.equal(job.status, 'queued');
  await q.drain();
  const done = q.get(job.id)!;
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result, { echoed: 'e1' });
  assert.equal(done.attempts, 1);
});

test('queue: rejects an unregistered kind', () => {
  const q = new JobQueue();
  assert.throws(() => q.enqueue('judge.evaluate', {}));
});

test('queue: retries a failing handler up to maxAttempts, then marks it failed', async () => {
  const q = new JobQueue({ backoffMs: 1 });
  let calls = 0;
  q.register('judge.evaluate', async () => {
    calls++;
    throw new Error('boom');
  });
  const job = q.enqueue('judge.evaluate', {}, { maxAttempts: 3 });
  await q.drain();
  const failed = q.get(job.id)!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 3);
  assert.equal(calls, 3);
  assert.match(failed.error ?? '', /boom/);
});

test('queue: a handler that fails once then succeeds ends up done', async () => {
  const q = new JobQueue({ backoffMs: 1 });
  let calls = 0;
  q.register('judge.evaluate', async () => {
    calls++;
    if (calls === 1) throw new Error('transient');
    return 'ok';
  });
  const job = q.enqueue('judge.evaluate', {}, { maxAttempts: 2 });
  await q.drain();
  assert.equal(q.get(job.id)!.status, 'done');
  assert.equal(q.get(job.id)!.result, 'ok');
});

test('queue: stats and list reflect job states', async () => {
  const q = new JobQueue();
  q.register('event.analytics', async () => 1);
  q.enqueue('event.analytics', {});
  q.enqueue('event.analytics', {});
  await q.drain();
  const stats = q.stats();
  assert.equal(stats.done, 2);
  assert.equal(stats.total, 2);
  assert.equal(q.list({ status: 'done' }).length, 2);
});

test('queue: prunes finished jobs beyond the retention cap', async () => {
  const q = new JobQueue({ retention: 3 });
  q.register('event.analytics', async () => 1);
  for (let i = 0; i < 10; i++) q.enqueue('event.analytics', { i });
  await q.drain();
  assert.ok(q.list().length <= 3, `retained ${q.list().length}`);
});
