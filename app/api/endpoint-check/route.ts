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
import { captureEndpointExchange } from '@/lib/server/endpoint-check';
import { isEndpointProtocol, isEndpointCase } from '@/lib/endpoint-check';

export async function POST(request: NextRequest) {
  let payload: RequestPayload & {
    allowInsecureHttp?: unknown;
    protocol?: unknown;
    caseId?: unknown;
  };
  try {
    payload = await request.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('Invalid body');
  } catch {
    return noStore({ error: 'Invalid request body.' }, { status: 400 });
  }
  if (!isEndpointProtocol(payload.protocol) || !isEndpointCase(payload.caseId))
    return noStore(
      { error: 'Choose a valid endpoint and test prompt.' },
      { status: 400 },
    );
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
    const exchange = await captureEndpointExchange(
      { ...connection, actualBaseUrl: resolved.actualBaseUrl },
      payload.protocol,
      payload.caseId,
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
