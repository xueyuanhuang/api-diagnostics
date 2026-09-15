/** Never expose a gateway's HTML (or its embedded private data) as an API error. */
export async function readApiResponse<T>(response: Response): Promise<T> {
  const status = `HTTP ${response.status}`;
  let text: string;
  try { text = await response.text(); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error(`The connection to the tester was interrupted (${status}). Check Saved results before retrying; the test may have completed.`);
  }
  let data: unknown;
  try { data = JSON.parse(text); }
  catch {
    const html = /^\s*(?:<!doctype html|<html|<head|<body)/i.test(text) || response.headers.get('content-type')?.includes('text/html');
    const detail = response.status === 401 || response.redirected
      ? 'Sign in again, then return to the test.'
      : [408, 504, 522, 524].includes(response.status)
        ? 'The website or its gateway timed out. Check Saved results before retrying.'
        : response.status === 403
          ? 'Access to the tester was blocked. Refresh the page and try again.'
          : 'Refresh the page and try again. If it repeats, report this HTTP status.';
    throw new Error(`The tester returned ${html ? 'an HTML page' : text.trim() ? 'an invalid response' : 'an empty response'} instead of test data (${status}). ${detail} This does not indicate an output-token limit error.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`The tester returned an unexpected response (${status}). Refresh the page and try again.`);
  }
  const error = (data as { error?: unknown }).error;
  if (!response.ok || error) throw new Error(typeof error === 'string' ? error : `The request failed (${status}). Please try again.`);
  return data as T;
}
