import {
  ENDPOINT_TIMEOUT_MS,
  endpointCheckUrl,
  endpointRequestBody,
  summarizeEndpointResponse,
  type EndpointProtocol,
  type EndpointCase,
} from '../endpoint-check';
import { captureHttpExchange } from './http-exchange';

export async function captureEndpointExchange(
  connection: {
    model: string;
    apiKey: string;
    baseUrl: string;
    actualBaseUrl: string;
  },
  protocol: EndpointProtocol,
  caseId: EndpointCase,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (protocol === 'messages') {
    headers['x-api-key'] = connection.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else headers.authorization = `Bearer ${connection.apiKey}`;
  const exchange = await captureHttpExchange(
    {
      ...connection,
      headers,
      requestUrl: endpointCheckUrl(connection.actualBaseUrl, protocol),
      body: JSON.stringify(
        endpointRequestBody(protocol, connection.model, caseId),
      ),
      timeoutMs: ENDPOINT_TIMEOUT_MS,
    },
    signal,
    request,
  );
  return {
    ...exchange,
    protocol,
    caseId,
    ...summarizeEndpointResponse(exchange.rawResponse, protocol, caseId),
  };
}
