import { env } from 'cloudflare:workers';
import { PROBE_INTERVAL_MS } from '../availability';
import { AvailabilityStore } from './availability-store';
import { getOwnedProfileConfig } from './profile-config';
import { decryptApiKey } from './encryption';
import { validateOutboundUrl } from './connection';
import { resolveHostedConnection } from './hosted-ip-mapping';
import {
  checkProviderAvailability,
  type ProbeOutcome,
} from './availability-provider';

export function availabilityStore() {
  return new AvailabilityStore(env.DB);
}
export function probeTriggerSecret() {
  return (env as unknown as Record<string, string | undefined>)
    .AVAILABILITY_TRIGGER_SECRET;
}

export async function runAvailabilityTarget(
  id: string,
  slot: number,
  signal: AbortSignal,
  userId?: string,
) {
  const store = availabilityStore();
  const target = await store.active(id, userId);
  if (!target || target.createdAt >= slot + PROBE_INTERVAL_MS) return 'skipped';
  signal.throwIfAborted();
  if (!(await store.claim(target, slot, Date.now()))) return 'skipped';
  let outcome: ProbeOutcome;
  try {
    const config = await getOwnedProfileConfig({
      userId: target.userId,
      profileId: target.profileId,
      apiType: target.apiType,
      requestedModel: target.modelName,
      allowModelOverride: true,
    });
    if (
      !config ||
      config.baseUrl.replace(/\/$/, '') !== target.baseUrl.replace(/\/$/, '')
    )
      throw new Error(
        'The saved connection changed. Remove and re-add this target.',
      );
    const checked = validateOutboundUrl(
      config.baseUrl,
      Boolean(target.allowInsecureHttp),
    );
    if ('error' in checked)
      throw new Error(
        'This connection needs to be added again with the current HTTP settings.',
      );
    const apiKey = await decryptApiKey(config.encryptedApiKey, config.keyIv);
    const resolved = await resolveHostedConnection(config.baseUrl, true);
    signal.throwIfAborted();
    // A deletion during connection preparation must prevent a new paid request.
    const stillActive = await store.active(id, target.userId);
    if (!stillActive || stillActive.createdAt !== target.createdAt)
      return 'skipped';
    outcome = await checkProviderAvailability(
      {
        apiType: target.apiType,
        model: target.modelName,
        openRouterTier: target.openRouterTier,
        apiKey,
        actualBaseUrl: resolved.actualBaseUrl,
      },
      signal,
    );
  } catch {
    outcome = {
      status: 'unknown',
      finishedAt: Date.now(),
      httpStatus: null,
      latencyMs: null,
      returnedModel: null,
      requestId: null,
      answer: null,
      error:
        'Check could not start. Verify the saved connection; remove and re-add the target if its URL changed.',
    };
  }
  await store.finish(target, slot, outcome);
  return outcome.status;
}
