import test from 'node:test';
import assert from 'node:assert/strict';
import { readApiResponse } from '../lib/api-response.ts';

test('valid answers containing HTML remain intact', async () => {
  const data = {answer:'<!DOCTYPE html><html><body>pelican</body></html>', savedAnimation:{id:'saved'}};
  assert.deepEqual(await readApiResponse(Response.json(data)), data);
});
test('HTML gateway timeout explains HTTP status without leaking page content', async () => {
  await assert.rejects(readApiResponse(new Response('<!DOCTYPE html><html>private-token</html>',{status:524})), error => {
    assert.match(error.message,/HTML page.*HTTP 524.*timed out.*Saved results/);
    assert.doesNotMatch(error.message,/private-token|Unexpected token/);
    return true;
  });
});
test('HTML success fallback, malformed JSON, and empty responses are rejected', async () => {
  for (const body of ['<!DOCTYPE html><html>login</html>', '{"answer":', '', 'null', '[]']) {
    await assert.rejects(readApiResponse(new Response(body)), /HTTP 200/);
  }
});
test('provider JSON errors remain readable and do not become parser errors', async () => {
  await assert.rejects(readApiResponse(Response.json({error:'Insufficient balance'},{status:403})), /Insufficient balance/);
  await assert.rejects(readApiResponse(Response.json({error:'Provider failed'})), /Provider failed/);
});
test('an interrupted response reports transport failure, preserving cancellation', async () => {
  const broken = new Response(new ReadableStream({start(c){ c.error(new Error('socket closed')); }}));
  await assert.rejects(readApiResponse(broken), /connection.*interrupted/);
  const aborted = new Response(new ReadableStream({start(c){ c.error(new DOMException('stopped','AbortError')); }}));
  await assert.rejects(readApiResponse(aborted), {name:'AbortError'});
});
