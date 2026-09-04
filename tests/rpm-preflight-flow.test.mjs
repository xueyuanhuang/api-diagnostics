import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const startRoutePath = new URL('../app/api/rpm-runs/route.ts', import.meta.url);
const preflightRoutePath = new URL(
  '../app/api/rpm-runs/[id]/preflight/route.ts',
  import.meta.url,
);
const componentPath = new URL(
  '../components/rpm-ramp-test.tsx',
  import.meta.url,
);

test('run creation returns before the provider preflight starts', () => {
  const source = readFileSync(startRoutePath, 'utf8');
  assert.doesNotMatch(
    source,
    /runProviderRequest\s*\(/,
    'POST /api/rpm-runs must not block on the provider preflight',
  );
});

test('preflight has its own authenticated route', () => {
  assert.equal(
    existsSync(preflightRoutePath),
    true,
    'a separate preflight route must exist so the UI receives a run ID first',
  );
  const source = readFileSync(preflightRoutePath, 'utf8');
  assert.match(source, /getChatGPTUser\s*\(/);
  assert.match(source, /runProviderRequest\s*\(/);
  assert.match(source, /status\s*=\s*'preflight'/);
});

test('the UI keeps a cancellable run ID before awaiting preflight', () => {
  const source = readFileSync(componentPath, 'utf8');
  const createIndex = source.indexOf("jsonFetch<RpmRunDetail>('/api/rpm-runs'");
  const rememberIndex = source.indexOf(
    'activeRunIdRef.current = createdRun.run.id',
  );
  const preflightIndex = source.indexOf(
    '`/api/rpm-runs/${createdRun.run.id}/preflight`',
  );
  assert.ok(createIndex >= 0, 'the UI must create the run first');
  assert.ok(
    rememberIndex > createIndex,
    'the UI must remember the run ID returned by creation',
  );
  assert.ok(
    preflightIndex > rememberIndex,
    'the UI must remember the run ID before starting preflight',
  );
  assert.match(
    source,
    /const runId = activeRunIdRef\.current \?\? detail\?\.run\.id/,
    'Stop must use the immediately available run ID',
  );
});
