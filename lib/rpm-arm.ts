type HttpLikeError = {
  status?: unknown;
  data?: { error?: unknown };
};

type ArmStageWhenReadyOptions<T> = {
  signal: AbortSignal;
  attempt: () => Promise<T>;
  wait: (delayMs: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
};

function readinessPending(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as HttpLikeError;
  return (
    candidate.status === 409 &&
    typeof candidate.data?.error === 'string' &&
    candidate.data.error.includes('Server dispatchers are not ready')
  );
}

export async function armStageWhenReady<T>({
  signal,
  attempt,
  wait,
  timeoutMs = 60_000,
  pollMs = 250,
}: ArmStageWhenReadyOptions<T>) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal.throwIfAborted();
    try {
      return await attempt();
    } catch (error) {
      if (!readinessPending(error)) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Server dispatchers were not ready within ${Math.round(timeoutMs / 1_000)} seconds.`,
        );
      }
      await wait(Math.min(pollMs, remainingMs), signal);
    }
  }
}
