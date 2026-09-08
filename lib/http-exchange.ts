export type HttpExchange = {
  requestedModel: string;
  originalBaseUrl: string;
  requestMethod: 'POST';
  requestUrl: string;
  requestHeaders: [string, string][];
  requestBody: string;
  responseHeaders: [string, string][];
  httpStatus: number | null;
  requestId: string | null;
  rawResponse: string;
  captureComplete: boolean;
  startedAt: string;
  endedAt: string;
  totalTimeMs: number;
  error: string | null;
};
