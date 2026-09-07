import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { NormalTestQueue, isQueueActive } from '../lib/normal-test-queue.ts';
import { NORMAL_QUESTIONS } from '../lib/questions.ts';

function fixture() {
  const queue = new NormalTestQueue();
  const pending = new Set();
  const calls = [];
  const saves = [];
  let active = 0,
    maxActive = 0;
  const task = (model, saveFails = false) => ({
    key: model,
    context: { modelName: model, baseUrl: 'https://fixture.invalid' },
    questions: NORMAL_QUESTIONS,
    classify: (data) => (data.httpStatus === 429 ? 'error' : 'normal'),
    request: async (question, index, signal) => {
      calls.push({ model, index });
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve, reject) => {
          const done = () => {
            pending.delete(done);
            signal.removeEventListener('abort', abort);
            resolve();
          };
          const abort = () => {
            pending.delete(done);
            reject(new DOMException('Stopped', 'AbortError'));
          };
          pending.add(done);
          signal.addEventListener('abort', abort, { once: true });
        });
        return {
          returnedModel: model,
          requestId: `${model}-${index}`,
          rawResponse: `evidence:${model}:${question.id}`,
          httpStatus: model === 'limited' ? 429 : 200,
        };
      } finally {
        active--;
      }
    },
    save: async (results, context) => {
      saves.push({ context, results });
      if (saveFails) throw new Error('Fixture storage failure');
      return { ...context, id: `saved-${model}` };
    },
  });
  const drain = async () => {
    for (let i = 0; i < 200; i++) {
      for (const resolve of pending) resolve();
      await setImmediate();
      if (!queue.getSnapshot().some((job) => isQueueActive(job.phase))) return;
    }
    assert.fail('queue did not drain');
  };
  return { queue, task, calls, saves, drain, maxActive: () => maxActive };
}

test('six models send 72 isolated requests with default three-model concurrency and save once each', async () => {
  const f = fixture();
  f.queue.enqueue(['a', 'b', 'c', 'd', 'e', 'f'].map((m) => f.task(m)));
  assert.equal(f.calls.length, 3);
  assert.equal(
    f.queue.getSnapshot().filter((j) => j.phase === 'queued').length,
    3,
  );
  await f.drain();
  assert.equal(f.calls.length, 72);
  assert.equal(f.maxActive(), 3);
  assert.equal(f.saves.length, 6);
  for (const saved of f.saves) {
    assert.equal(saved.results.length, 12);
    assert.ok(
      saved.results.every((r) => r.returnedModel === saved.context.modelName),
    );
    assert.equal(new Set(saved.results.map((r) => r.requestId)).size, 12);
  }
  for (const job of f.queue.getSnapshot())
    assert.equal(job.context.id, `saved-${job.context.modelName}`);
});

test('adding while running and repeated clicks cannot duplicate active models', async () => {
  const f = fixture();
  f.queue.enqueue([f.task('a'), f.task('b'), f.task('c')]);
  assert.equal(
    f.queue.enqueue([f.task('a'), f.task('d'), f.task('d')]).length,
    1,
  );
  assert.equal(f.calls.length, 3);
  await f.drain();
  assert.equal(f.calls.length, 48);
  assert.equal(f.saves.length, 4);
});

test('stopping one model frees a slot without aborting its peers; queued cancellation sends nothing', async () => {
  const f = fixture();
  const ids = f.queue.enqueue(['a', 'b', 'c', 'd', 'e'].map((m) => f.task(m)));
  f.queue.stop(ids[4]);
  f.queue.stop(ids[0]);
  await f.drain();
  assert.equal(f.queue.getSnapshot()[0].phase, 'stopped');
  assert.equal(f.queue.getSnapshot()[4].phase, 'stopped');
  assert.equal(f.calls.filter((c) => c.model === 'a').length, 1);
  assert.equal(f.calls.filter((c) => c.model === 'e').length, 0);
  assert.deepEqual(
    f.saves.map((s) => s.context.modelName).sort((a, b) => a.localeCompare(b)),
    ['b', 'c', 'd'],
  );
});

test('stop all cancels waiting work before active tasks can refill slots', async () => {
  const f = fixture();
  f.queue.enqueue(['a', 'b', 'c', 'd', 'e', 'f'].map((m) => f.task(m)));
  f.queue.stopAll();
  await f.drain();
  assert.equal(f.calls.length, 3);
  assert.equal(f.saves.length, 0);
  assert.ok(f.queue.getSnapshot().every((j) => j.phase === 'stopped'));
  f.queue.clear();
  assert.equal(f.queue.getSnapshot().length, 0);
  f.queue.enqueue([f.task('new')]);
  await f.drain();
  assert.equal(f.saves.length, 1);
});

test('adjustable concurrency and save failures do not strand later models', async () => {
  const f = fixture();
  f.queue.setConcurrency(1);
  f.queue.enqueue([f.task('a', true), f.task('limited'), f.task('c')]);
  assert.equal(f.calls.length, 1);
  f.queue.setConcurrency(2);
  assert.equal(f.calls.length, 2);
  await f.drain();
  assert.equal(f.maxActive(), 2);
  assert.equal(f.saves.length, 3);
  assert.match(f.queue.getSnapshot()[0].message, /saving failed/);
  assert.equal(
    f.queue.getSnapshot()[1].results.filter((r) => r.status === 'error').length,
    12,
  );
  assert.ok(f.queue.getSnapshot().every((j) => j.phase === 'complete'));
});

test('production wires per-job context and retains ownership for unsaved model overrides', () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const component = source('../components/token-check-app.tsx');
  assert.match(component, /model: context\.modelName/);
  assert.match(component, /model: modelName/);
  assert.match(component, /saveCompletedRun\(finished, context, profileId\)/);
  const profile = source('../lib/server/profile-config.ts');
  assert.match(profile, /eq\(connectionProfiles\.userId, userId\)/);
  assert.match(profile, /allowModelOverride = false/);
  for (const path of [
    '../app/api/test/route.ts',
    '../app/api/tool-boundary/route.ts',
  ]) {
    assert.match(source(path), /resolveTestConnection\(payload\)/);
  }
  for (const path of [
    '../lib/server/test-connection.ts',
    '../app/api/runs/route.ts',
  ]) {
    assert.match(source(path), /allowModelOverride: true/);
    assert.match(source(path), /model\.length > 120/);
  }
});
