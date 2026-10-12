import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunLifetime } from '../run-lifetime.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('deadline during restart waiting prevents a second launch before cleanup', async () => {
  const waiting = deferred(), expired = deferred();
  const events = [];
  const lifetime = createRunLifetime(Date.now() + 20);
  const work = lifetime.run(async () => {
    events.push('restart-wait'); await waiting.promise;
    lifetime.assertActive(); events.push('launch');
  }, () => { events.push('timeout'); expired.resolve(); });
  await expired.promise;
  waiting.resolve();
  await assert.rejects(work, { safeCode: 'SESSION_DEADLINE' });
  events.push('owned-cleanup');
  assert.deepEqual(events, ['restart-wait', 'timeout', 'owned-cleanup']);
  assert.throws(lifetime.assertActive, { safeCode: 'SESSION_DEADLINE' });
});

test('deadline during an in-flight launch drains its result before owned cleanup and cannot resume later', async () => {
  const launch = deferred(), expired = deferred();
  const events = [];
  let app, cleanupFinished = false;
  const lifetime = createRunLifetime(Date.now() + 20);
  const work = lifetime.run(async () => {
    lifetime.assertActive(); events.push('launch-started');
    app = await launch.promise; events.push('launch-returned');
    assert.equal(cleanupFinished, false);
    lifetime.assertActive(); events.push('work-resumed');
  }, () => { events.push('timeout'); expired.resolve(); });
  let settled = false;
  const observed = assert.rejects(work, { safeCode: 'SESSION_DEADLINE' }).then(() => { settled = true; });
  await expired.promise;
  await Promise.resolve();
  assert.equal(settled, false, 'the owner cannot enter cleanup while launch is still running');
  launch.resolve({ pid: 42 });
  await observed;
  assert.deepEqual(app, { pid: 42 });
  events.push('owned-cleanup'); cleanupFinished = true;
  await Promise.resolve();
  assert.deepEqual(events, ['launch-started', 'timeout', 'launch-returned', 'owned-cleanup']);
});

test('completed work preserves result, stops late starts and never invokes timeout cleanup', async () => {
  const lifetime = createRunLifetime(Date.now() + 1000);
  let expired = false;
  assert.equal(await lifetime.run(async () => 7, () => { expired = true; }), 7);
  assert.equal(expired, false);
  assert.throws(lifetime.assertActive, { safeCode: 'SESSION_DEADLINE' });
  await assert.rejects(lifetime.run(async () => 8), { safeCode: 'INVALID_HARNESS' });
});
