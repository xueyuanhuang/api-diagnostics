import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBaseUrl,
  validateOutboundUrl,
  endpointFromBaseUrl,
} from '../lib/server/connection.ts';
import { confirmHttpRisk } from '../lib/http-consent.ts';

test('public HTTP/custom ports normalize and retain correct API paths', () => {
  const base = validateBaseUrl('http://45.58.184.227:3000/');
  assert.deepEqual(base, { baseUrl: 'http://45.58.184.227:3000' });
  assert.equal(
    endpointFromBaseUrl(base.baseUrl, 'anthropic').href,
    'http://45.58.184.227:3000/v1/messages',
  );
  assert.equal(
    endpointFromBaseUrl(base.baseUrl + '/v1', 'openai').href,
    'http://45.58.184.227:3000/v1/chat/completions',
  );
  assert.ok(!('error' in validateBaseUrl('https://example.com:8443')));
});

test('private addresses, URL credentials and unsupported schemes remain blocked', () => {
  for (const url of [
    'http://localhost:3000',
    'http://127.1:3000',
    'http://2130706433',
    'http://10.0.0.1:3000',
    'http://169.254.169.254',
    'https://192.168.1.2:8443',
    'http://[::1]:3000',
    'http://metadata.google.internal',
    'ftp://example.com',
    'http://user:pass@example.com',
    'http://example.com?secret=x',
  ]) {
    assert.ok('error' in validateBaseUrl(url), url);
  }
});

test('outbound HTTP requires explicit boolean consent, including saved URLs', () => {
  for (const consent of [undefined, false, 'true', 1])
    assert.ok(
      'error' in validateOutboundUrl('http://45.58.184.227:3000', consent),
    );
  assert.ok(
    !('error' in validateOutboundUrl('http://45.58.184.227:3000', true)),
  );
  assert.ok(
    !('error' in validateOutboundUrl('https://example.com', undefined)),
  );
  assert.ok('error' in validateOutboundUrl('http://127.0.0.1', true));
});

test('HTTP consent supports cancel and one prompt per batch, HTTPS does not prompt', () => {
  let calls = 0;
  const reject = (message) => {
    calls++;
    assert.match(message, /API key/);
    assert.match(message, /without encryption/);
    return false;
  };
  assert.equal(confirmHttpRisk(['https://example.com'], reject), true);
  assert.equal(calls, 0);
  assert.equal(
    confirmHttpRisk(
      ['http://example.com:3000', 'http://example.com:3000'],
      reject,
    ),
    false,
  );
  assert.equal(calls, 1);
  assert.equal(
    confirmHttpRisk(['http://example.com'], () => true),
    true,
  );
});
