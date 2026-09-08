import { NextRequest } from 'next/server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { noStore } from '@/lib/server/http';
import { getOwnedProfileConfig } from '@/lib/server/profile-config';
import { validateOutboundUrl } from '@/lib/server/connection';
import { AvailabilityError } from '@/lib/server/availability-store';
import {
  availabilityStore,
  probeTriggerSecret,
  runAvailabilityTarget,
} from '@/lib/server/availability-runner';
import { probeSlot } from '@/lib/availability';

export async function GET() {
  const user = await getChatGPTUser();
  if (!user)
    return noStore(
      { error: 'Sign in to view your availability targets.' },
      { status: 401 },
    );
  try {
    return noStore(
      await availabilityStore().list(
        user.userId,
        Boolean(probeTriggerSecret()),
        Date.now(),
      ),
    );
  } catch {
    return noStore(
      { error: 'Availability history could not be loaded.' },
      { status: 503 },
    );
  }
}

export async function POST(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore(
      { error: 'Sign in to add an availability target.' },
      { status: 401 },
    );
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return noStore(
      { error: 'Cross-origin changes are not allowed.' },
      { status: 403 },
    );
  try {
    const body = (await request.json()) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.profileId !== 'string' ||
      body.profileId.length > 160 ||
      (body.apiType !== 'anthropic' && body.apiType !== 'openai') ||
      typeof body.model !== 'string' ||
      !body.model.trim() ||
      body.model.length > 120
    )
      throw new AvailabilityError(
        'Choose a saved connection, API type and model.',
      );
    if (!probeTriggerSecret())
      throw new AvailabilityError(
        'Background monitoring is not configured yet.',
        503,
      );
    const config = await getOwnedProfileConfig({
      userId: user.userId,
      profileId: body.profileId,
      apiType: body.apiType,
      requestedModel: body.model.trim(),
    });
    if (!config)
      throw new AvailabilityError('Saved connection or model not found.', 404);
    const checked = validateOutboundUrl(config.baseUrl, body.allowInsecureHttp);
    if ('error' in checked) throw new AvailabilityError(checked.error);
    const saved = await availabilityStore().add(user.userId, {
      id: crypto.randomUUID(),
      profileId: body.profileId,
      apiType: config.apiType,
      modelName: config.modelName,
      baseUrl: checked.baseUrl,
      allowInsecureHttp: body.allowInsecureHttp === true ? 1 : 0,
      createdAt: Date.now(),
    });
    if (!saved)
      throw new AvailabilityError('Target could not be created.', 503);
    // The first check is awaited so it survives neither as detached work nor a fake success.
    try {
      await runAvailabilityTarget(
        saved.id,
        probeSlot(Date.now()),
        request.signal,
        user.userId,
      );
    } catch {
      /* The saved target remains scheduled if the initial HTTP request is interrupted. */
    }
    return noStore({ id: saved.id }, { status: 201 });
  } catch (error) {
    return noStore(
      {
        error:
          error instanceof AvailabilityError
            ? error.message
            : 'Target could not be added. Refresh the list before retrying.',
      },
      { status: error instanceof AvailabilityError ? error.status : 400 },
    );
  }
}
