import { isOpenRouter, openRouterRoute } from '../openrouter';
import { endpointFromBaseUrl } from './connection';
import { captureHttpExchange } from './http-exchange';
import {
  assessTpm,
  tpmRequestBody,
  TPM_TIMEOUT_MS,
  type TpmWorkload,
} from '../tpm-test';

export async function captureTpmExchange(
  connection: {
    apiType: 'openai' | 'anthropic';
    model: string;
    apiKey: string;
    baseUrl: string;
    actualBaseUrl: string;
    openRouterTier?: string;
  },
  workload: TpmWorkload,
  nonce: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
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
      body: JSON.stringify({
        ...tpmRequestBody(
          connection.apiType,
          connection.model,
          workload,
          nonce,
        ),
        ...openRouterRoute(
          connection.baseUrl,
          connection.apiType,
          connection.model,
          connection.openRouterTier,
        ),
      }),
      timeoutMs: TPM_TIMEOUT_MS,
    },
    signal,
    request,
  );
  return { ...exchange, ...assessTpm(exchange, connection.apiType) };
}
