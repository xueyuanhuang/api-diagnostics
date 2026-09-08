const encoder = new TextEncoder();
export const PROBE_TRIGGER_PATH = '/api/availability/tick';
async function key(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
async function message(timestamp: string, body: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(body));
  const hex = [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
  return encoder.encode(`POST\n${PROBE_TRIGGER_PATH}\n${timestamp}\n${hex}`);
}
export async function signProbeTick(
  secret: string,
  timestamp: string,
  body: string,
) {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await key(secret),
    await message(timestamp, body),
  );
  return [...new Uint8Array(signature)]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export async function verifyProbeTick(
  secret: string | undefined,
  timestamp: string | null,
  signature: string | null,
  body: string,
  now = Date.now(),
) {
  if (
    !secret ||
    secret.length < 32 ||
    !timestamp ||
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 120_000 ||
    !signature ||
    !/^[0-9a-f]{64}$/.test(signature)
  )
    return false;
  return crypto.subtle.verify(
    'HMAC',
    await key(secret),
    Uint8Array.from(signature.match(/../g)!, (x) => parseInt(x, 16)),
    await message(timestamp, body),
  );
}
