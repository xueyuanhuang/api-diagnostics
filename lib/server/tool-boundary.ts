import { openRouterRoute, isOpenRouter } from '@/lib/openrouter';
import {
  boundaryRequestBody,
  BOUNDARY_TIMEOUT_MS,
  summarizeBoundaryResponse,
  type BoundaryApiType,
  type BoundaryExchange,
} from '../tool-boundary';
import { endpointFromBaseUrl } from './connection';
import { captureHttpExchange } from './http-exchange';
export {
  HTTP_CAPTURE_LIMIT as BOUNDARY_CAPTURE_LIMIT,
  redactExchangeSecret as redactBoundarySecret,
} from './http-exchange';

export async function captureBoundaryExchange(
  connection: {
    apiType: BoundaryApiType;
    model: string;
    openRouterTier?: string;
    apiKey: string;
    baseUrl: string;
    actualBaseUrl: string;
  },
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<BoundaryExchange> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (connection.apiType === 'anthropic' && !isOpenRouter(connection.baseUrl)) {
    headers['x-api-key'] = connection.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else headers.authorization = `Bearer ${connection.apiKey}`;
  const exchange = await captureHttpExchange(
    {
      ...connection,
      headers,
      requestUrl: endpointFromBaseUrl(
        connection.actualBaseUrl,
        connection.apiType,
      ).href,
      body: JSON.stringify(
        {...boundaryRequestBody(connection.apiType, connection.model), ...openRouterRoute(connection.baseUrl, 'openai', connection.model, connection.openRouterTier)},
      ),
      timeoutMs: BOUNDARY_TIMEOUT_MS,
    },
    signal,
    request,
  );
  return {
    ...exchange,
    apiType: connection.apiType,
    ...summarizeBoundaryResponse(exchange.rawResponse, connection.apiType),
  };
}
