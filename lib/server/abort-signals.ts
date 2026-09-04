export function combinedRequestSignal(
  requestSignal: AbortSignal,
  timeoutMs: number,
) {
  return AbortSignal.any([
    requestSignal,
    AbortSignal.timeout(Math.max(1, timeoutMs)),
  ]);
}
