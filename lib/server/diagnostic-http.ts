import { env } from 'cloudflare:workers';
import {
  diagnosticStore,
  DiagnosticError,
  DIAGNOSTIC_MAX_BYTES,
} from './diagnostic-store';
import { noStore, serverError } from './http';

export const diagnostics = () => diagnosticStore(env.DB, env.EVIDENCE);
export function diagnosticError(error: unknown) {
  return error instanceof DiagnosticError
    ? noStore({ error: error.message }, { status: error.status })
    : serverError(error);
}
export function validateDiagnosticMutation(request: Request, json = false) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    throw new DiagnosticError('Cross-origin changes are not allowed.', 403);
  if (
    json &&
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/json'
  )
    throw new DiagnosticError('Expected JSON.', 415);
}
export async function readDiagnosticPayload(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new DiagnosticError('Missing saved run.');
  let size = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > DIAGNOSTIC_MAX_BYTES) {
        await reader.cancel();
        throw new DiagnosticError(
          'This evidence is too large to save. Download the raw JSON instead.',
          413,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text) as { document?: unknown; revision?: unknown };
    } catch {
      throw new DiagnosticError('Invalid saved-run JSON.');
    }
  } finally {
    reader.releaseLock();
  }
}
