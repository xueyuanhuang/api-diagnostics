import { openRouterRoute } from '@/lib/openrouter';
import { NextRequest } from 'next/server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { noStore } from '@/lib/server/http';
import { validateOutboundUrl } from '@/lib/server/connection';
import {
  resolveTestConnection,
  type RequestPayload,
} from '@/lib/server/test-connection';
import { IpMappingError, isRawIpv4 } from '@/lib/server/ip-mapping';
import { resolveHostedConnection } from '@/lib/server/hosted-ip-mapping';
import { captureToolChoiceExchange } from '@/lib/server/tool-choice';

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.nextUrl.origin)
    return noStore(
      { error: 'Cross-origin requests are not allowed.' },
      { status: 403 },
    );
  let payload: RequestPayload & {
    allowInsecureHttp?: unknown;
    stream?: unknown;
  };
  try {
    payload = await request.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('Invalid body');
  } catch {
    return noStore({ error: 'Invalid request body.' }, { status: 400 });
  }
  if (typeof payload.stream !== 'boolean')
    return noStore({ error: 'Choose a valid response mode.' }, { status: 400 });
  let connection;
  try {
    connection = await resolveTestConnection(payload);
  } catch {
    return noStore(
      { error: 'The saved connection could not be opened.' },
      { status: 500 },
    );
  }
  if ('error' in connection)
    return noStore(
      { error: connection.error },
      { status: 'status' in connection ? connection.status : 400 },
    );
  try {
    openRouterRoute(
      connection.baseUrl,
      connection.apiType,
      connection.model,
      payload.openRouterTier,
    );
  } catch (error) {
    return noStore({ error: (error as Error).message }, { status: 400 });
  }
  const outbound = validateOutboundUrl(
    connection.baseUrl,
    payload.allowInsecureHttp,
  );
  if ('error' in outbound)
    return noStore({ error: outbound.error }, { status: 400 });
  try {
    const resolved = await resolveHostedConnection(
      connection.baseUrl,
      isRawIpv4(connection.baseUrl) ? Boolean(await getChatGPTUser()) : false,
    );
    request.signal.throwIfAborted();
    const exchange = await captureToolChoiceExchange(
      {
        ...connection,
        openRouterTier: payload.openRouterTier as string | undefined,
        actualBaseUrl: resolved.actualBaseUrl,
      },
      payload.stream,
      request.signal,
    );
    return noStore({ exchange });
  } catch (error) {
    return noStore(
      {
        error:
          error instanceof IpMappingError
            ? error.message
            : 'Connection preparation failed. No provider exchange was captured.',
      },
      { status: error instanceof IpMappingError ? error.status : 503 },
    );
  }
}
