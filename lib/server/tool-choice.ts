import { isOpenRouter, openRouterRoute } from '../openrouter';
import { endpointFromBaseUrl } from './connection';
import { captureHttpExchange } from './http-exchange';
import {
  assessToolChoice,
  toolChoiceRequestBody,
  TOOL_CHOICE_TIMEOUT_MS,
  type ToolChoiceApiType,
} from '../tool-choice';

export async function captureToolChoiceExchange(
  connection: {
    apiType: ToolChoiceApiType;
    model: string;
    apiKey: string;
    baseUrl: string;
    actualBaseUrl: string;
    openRouterTier?: string;
  },
  stream: boolean,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const headers: Record<string, string> = {
    accept: stream ? 'text/event-stream' : 'application/json',
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
        ...toolChoiceRequestBody(connection.apiType, connection.model, stream),
        ...openRouterRoute(
          connection.baseUrl,
          connection.apiType,
          connection.model,
          connection.openRouterTier,
        ),
      }),
      timeoutMs: TOOL_CHOICE_TIMEOUT_MS,
    },
    signal,
    request,
  );
  return {
    ...exchange,
    ...assessToolChoice(exchange, connection.apiType, stream),
  };
}
