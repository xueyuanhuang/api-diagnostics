import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))(
  'miniflare',
);

test('actual mapper works in Workers and refuses DNS API/DoH redirects without forwarding credentials', async () => {
  // Transpile the real production module, not a second implementation of its fetch options.
  const connection = readFileSync(
    new URL('../lib/server/connection.ts', import.meta.url),
    'utf8',
  );
  const mapping = readFileSync(
    new URL('../lib/server/ip-mapping.ts', import.meta.url),
    'utf8',
  ).replace("import { validateBaseUrl } from './connection';", '');
  const entry = `
    export default {async fetch(request) {
      const scenario = new URL(request.url).pathname;
      const seen = [];
      const record = {type:'A',name:'45-58-184-227.ip-api.example.com',content:'45.58.184.227',proxied:false};
      const transport = async (url, init) => {
        // Native workerd Request enforces the production runtime's redirect enum.
        const actual = new Request(url, init);
        seen.push({url:actual.url,redirect:actual.redirect,hasAuth:actual.headers.has('authorization')});
        const doh = actual.url.includes('dns-query');
        if ((scenario.startsWith('/api-redirect') && !doh) || (scenario.startsWith('/doh-redirect') && doh))
          return new Response(scenario.endsWith('-json') ? JSON.stringify(doh ? {Status:0,Answer:[{type:1,data:record.content}]} : {success:true,result:[record]}) : 'not JSON', {status:302,headers:{location:'https://untrusted.example/collect'}});
        if (scenario === '/invalid-json' && !doh) return new Response('<html>upstream error</html>', {status:502});
        return Response.json(doh ? {Status:0,Answer:[{type:1,data:record.content}]} : {success:true,result:[record]});
      };
      try {
        const result = await resolveIpConnection('http://45.58.184.227:3000/',true,
          {token:'TEST-DNS-SECRET',zoneId:'a'.repeat(32),suffix:'ip-api.example.com'},transport,async()=>{});
        return Response.json({result,seen});
      } catch(error) { return Response.json({error:error.message,seen},{status:503}); }
    }};
  `;
  const script = ts.transpileModule(
    connection + '\n' + mapping + '\n' + entry,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    },
  ).outputText;
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-05-15',
    compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
    cf: false,
  });
  try {
    const response = await mf.dispatchFetch('http://local.test/success');
    const success = await response.json();
    assert.equal(response.status, 200, JSON.stringify(success));
    assert.equal(success.result.originalBaseUrl, 'http://45.58.184.227:3000');
    assert.equal(
      success.result.actualBaseUrl,
      'http://45-58-184-227.ip-api.example.com:3000',
    );
    assert.deepEqual(
      success.seen.map((x) => x.redirect),
      ['manual', 'manual'],
    );
    assert.deepEqual(
      success.seen.map((x) => x.hasAuth),
      [true, false],
    );
    for (const path of [
      '/api-redirect',
      '/doh-redirect',
      '/api-redirect-json',
      '/doh-redirect-json',
    ]) {
      const failed = await mf.dispatchFetch('http://local.test' + path);
      const failure = await failed.json();
      assert.equal(failed.status, 503);
      assert.match(failure.error, /redirect.*302/i);
      assert.ok(
        failure.seen.every((x) => !x.url.includes('untrusted.example')),
      );
      assert.equal(JSON.stringify(failure).includes('TEST-DNS-SECRET'), false);
    }
    const malformed = await (
      await mf.dispatchFetch('http://local.test/invalid-json')
    ).json();
    assert.match(malformed.error, /invalid JSON.*502/i);
    assert.doesNotMatch(malformed.error, /could not be reached/);
  } finally {
    await mf.dispose();
  }
});
