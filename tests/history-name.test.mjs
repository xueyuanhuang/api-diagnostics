import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { NORMAL_QUESTIONS } from '../lib/questions.ts';
import { validateBaseUrl } from '../lib/server/connection.ts';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;

test('actual batch handler freezes the entered history name for every model', async () => {
  const source = read('../components/token-check-app.tsx');
  const handler = source.slice(
    source.search(/  (?:async )?function runTests\(/),
    source.indexOf('  function stopNormalTest('),
  );
  let tasks;
  const scope = {
    isRpmRunning: false,
    isBoundaryRunning: false,
    isEndpointRunning: false,
    profileBusy: false,
    queueStartingRef: { current: false },
    setFormError: () => {},
    baseUrl: 'https://example.com',
    apiKey: 'test-only',
    selectedProfileId: '',
    selectedProfile: null,
    selectedProfileConfig: null,
    profileName: '  IDT-ccmax-蒸馏  ',
    user: {},
    apiType: 'anthropic',
    modelsToEnqueue: ['model-a', 'model-b'],
    concurrency: 3,
    isRunning: false,
    clientBaseUrlError: () => null,
    confirmHttpRisk: () => true,
    isInsecureHttp: () => false,
    normalQueue: {
      setConcurrency() {},
      enqueue(t) {
        tasks = t;
        return ['one', 'two'];
      },
    },
    NORMAL_QUESTIONS,
    testFetch() {},
    classifyResult() {},
    saveCompletedRun() {},
    setSelectedJobId() {},
    setSelectedModels() {},
    showCurrent() {},
    setLastRunMode() {},
    setShownApiType() {},
  };
  vm.createContext(scope);
  vm.runInContext(compile(handler), scope);
  await scope.runTests({ preventDefault() {} });
  assert.equal(tasks.length, 2);
  for (const task of tasks)
    assert.equal(task.context.profileName, 'IDT-ccmax-蒸馏');
  scope.profileName = 'changed after start';
  assert.equal(tasks[0].context.profileName, 'IDT-ccmax-蒸馏');
  scope.isBoundaryRunning = true;
  tasks = null;
  await scope.runTests({ preventDefault() {} });
  assert.equal(
    tasks,
    null,
    'normal tests cannot start during a boundary probe',
  );
  scope.isBoundaryRunning = false;
  scope.isEndpointRunning = true;
  await scope.runTests({ preventDefault() {} });
  assert.equal(tasks, null, 'normal tests cannot start during an endpoint comparison');
});

test('saved-profile batch persists every model before dispatch; failed persistence sends nothing', async () => {
  const source = read('../components/token-check-app.tsx');
  const handler = source.slice(
    source.search(/  (?:async )?function runTests\(/),
    source.indexOf('  function stopNormalTest('),
  );
  let failSave = false;
  const events = [];
  const scope = {
    Error,
    isRpmRunning: false,
    isBoundaryRunning: false,
    isEndpointRunning: false,
    profileBusy: false,
    queueStartingRef: { current: false },
    setFormError: (message) => events.push(['error', message]),
    setProfileBusy() {},
    baseUrl: 'https://example.com',
    apiKey: '',
    selectedProfileId: 'p',
    selectedProfile: { name: 'Saved' },
    selectedProfileConfig: { baseUrl: 'https://example.com' },
    profileName: 'Saved',
    user: {},
    apiType: 'anthropic',
    modelsToEnqueue: ['old', 'new-a', 'new-b'],
    concurrency: 3,
    isRunning: false,
    clientBaseUrlError: () => null,
    confirmHttpRisk: () => true,
    isInsecureHttp: () => false,
    rememberProfileModels: async (id, type, url, models) => {
      events.push(['persist', id, type, url, [...models]]);
      if (failSave) throw new Error('Storage unavailable');
    },
    normalQueue: {
      setConcurrency() {},
      enqueue(tasks) {
        events.push(['enqueue', tasks.length]);
        return ['1'];
      },
    },
    NORMAL_QUESTIONS,
    testFetch() {},
    classifyResult() {},
    saveCompletedRun() {},
    setSelectedJobId() {},
    setSelectedModels() {},
    showCurrent() {},
    setLastRunMode() {},
    setShownApiType() {},
  };
  vm.createContext(scope);
  vm.runInContext(compile(handler), scope);
  await scope.runTests({ preventDefault() {} });
  assert.deepEqual(
    events.filter((e) => e[0] !== 'error'),
    [
      [
        'persist',
        'p',
        'anthropic',
        'https://example.com',
        ['old', 'new-a', 'new-b'],
      ],
      ['enqueue', 3],
    ],
  );
  events.length = 0;
  failSave = true;
  await scope.runTests({ preventDefault() {} });
  assert.equal(
    events.some((e) => e[0] === 'enqueue'),
    false,
  );
  assert.ok(
    events.some(
      (e) => e[0] === 'error' && e[1].includes('Storage unavailable'),
    ),
  );
});

test('actual save callback sends frozen name; POST persists it without saving credentials', async () => {
  const component = read('../components/token-check-app.tsx');
  const callback = component.slice(
    component.indexOf('  async function saveCompletedRun('),
    component.indexOf('  function exportEvidence('),
  );
  let submitted;
  const client = {
    jsonFetch: async (_url, init) => {
      submitted = JSON.parse(init.body);
      return { run: { id: 'saved', profileName: submitted.profileName } };
    },
    setRuns() {},
  };
  vm.createContext(client);
  vm.runInContext(compile(callback), client);
  const results = NORMAL_QUESTIONS.map(() => ({ status: 'normal' }));
  await client.saveCompletedRun(
    results,
    {
      profileName: 'IDT-ccmax-蒸馏',
      apiType: 'anthropic',
      baseUrl: 'https://example.com',
      modelName: 'test',
    },
    null,
  );
  assert.equal(submitted.profileName, 'IDT-ccmax-蒸馏');
  assert.equal(submitted.apiKey, undefined);
  const route = read('../app/api/runs/route.ts');
  const writes = [];
  const server = {
    exports: {},
    getChatGPTUser: async () => ({ userId: 'owner' }),
    env: {
      DB: {
        prepare(sql) {
          return {
            bind(...values) {
              return { sql, values };
            },
          };
        },
        async batch(items) {
          writes.push(...items);
        },
      },
    },
    NORMAL_QUESTIONS,
    validateBaseUrl,
    crypto,
    noStore: (body, init) => ({ body, status: init?.status ?? 200 }),
    serverError: (e) => {
      throw e;
    },
  };
  vm.createContext(server);
  vm.runInContext(
    compile(route.slice(route.indexOf('type StoredStatus'))),
    server,
  );
  const response = await server.exports.POST({ json: async () => submitted });
  assert.equal(response.status, 201);
  assert.equal(response.body.run.profileName, 'IDT-ccmax-蒸馏');
  assert.equal(writes[0].values[2], null);
  assert.equal(writes[0].values[3], 'IDT-ccmax-蒸馏');
  assert.ok(writes.every((w) => !w.sql.includes('connection_profiles')));
});
