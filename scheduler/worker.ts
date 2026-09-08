import { signProbeTick, PROBE_TRIGGER_PATH } from '../lib/probe-signature';
import { mapProbePool, probeSlot } from '../lib/availability';

type SchedulerEnv = {
  AVAILABILITY_TRIGGER_SECRET: string;
  SITE_ORIGIN: string;
};
export async function triggerAvailability(
  env: SchedulerEnv,
  scheduledTime: number,
  transport: typeof fetch = fetch,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  if (
    !env.AVAILABILITY_TRIGGER_SECRET ||
    env.AVAILABILITY_TRIGGER_SECRET.length < 32
  )
    throw new Error('Scheduler secret is not configured.');
  const deadline = AbortSignal.timeout(8 * 60 * 1000);
  const slot = probeSlot(scheduledTime);
  const url = new URL(PROBE_TRIGGER_PATH, env.SITE_ORIGIN);
  if (url.protocol !== 'https:') throw new Error('Scheduler requires HTTPS.');
  async function send(payload: unknown): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    for (let attempt = 0; attempt < 3; attempt++) {
      deadline.throwIfAborted();
      const timestamp = String(Date.now());
      const signature = await signProbeTick(
        env.AVAILABILITY_TRIGGER_SECRET,
        timestamp,
        body,
      );
      try {
        const response = await transport(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-probe-timestamp': timestamp,
            'x-probe-signature': signature,
          },
          body,
          redirect: 'manual',
          signal: AbortSignal.any([deadline, AbortSignal.timeout(110_000)]),
        });
        if (response.ok)
          return (await response.json()) as Record<string, unknown>;
        await response.body?.cancel();
        if (response.status !== 429 && response.status < 500)
          throw new SchedulerConfigurationError(
            `Scheduler endpoint returned HTTP ${response.status}.`,
          );
      } catch (error) {
        if (error instanceof SchedulerConfigurationError) throw error;
        if (attempt === 2 || deadline.aborted)
          throw new Error('Scheduler request failed.');
      }
      if (attempt < 2) await sleep(1000 * 2 ** attempt);
    }
    throw new Error('Scheduler endpoint unavailable.');
  }
  const listed = await send({ action: 'list', slot });
  if (
    !Array.isArray(listed.ids) ||
    !listed.ids.every((id) => typeof id === 'string')
  )
    throw new Error('Unexpected target list.');
  const chunks: string[][] = [];
  for (let i = 0; i < listed.ids.length; i += 10)
    chunks.push(listed.ids.slice(i, i + 10));
  const results = await mapProbePool(chunks, 6, async (ids) => {
    try {
      return await send({ action: 'check', slot, ids });
    } catch {
      return null;
    }
  });
  if (results.some((result) => result === null))
    throw new Error('Some scheduled checks were not delivered.');
  return { targets: listed.ids.length, batches: results.length };
}
class SchedulerConfigurationError extends Error {}
const worker = {
  async scheduled(controller: ScheduledController, env: SchedulerEnv) {
    const result = await triggerAvailability(env, controller.scheduledTime);
    console.log(JSON.stringify({ event: 'availability_tick', ...result }));
  },
  fetch() {
    return new Response('Not found', { status: 404 });
  },
};

export default worker;
