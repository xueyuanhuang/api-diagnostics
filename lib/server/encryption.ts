import { env } from 'cloudflare:workers';

function fromBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function encryptionKey() {
  const secret = env.API_KEY_ENCRYPTION_SECRET;
  if (!secret) throw new Error('API key encryption is not configured.');
  const bytes = fromBase64(secret);
  if (bytes.byteLength !== 32) throw new Error('API key encryption is misconfigured.');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptApiKey(apiKey: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(),
    new TextEncoder().encode(apiKey),
  );
  return { encryptedApiKey: toBase64(ciphertext), keyIv: toBase64(iv) };
}

export async function decryptApiKey(encryptedApiKey: string, keyIv: string) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(keyIv) },
    await encryptionKey(),
    fromBase64(encryptedApiKey),
  );
  return new TextDecoder().decode(plaintext);
}
