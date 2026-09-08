import { NextRequest } from 'next/server';
import { noStore } from '@/lib/server/http';
import {
  availabilityStore,
  probeTriggerSecret,
  runAvailabilityTarget,
} from '@/lib/server/availability-runner';
import { verifyProbeTick } from '@/lib/probe-signature';
import { mapProbePool, probeSlot, PROBE_INTERVAL_MS } from '@/lib/availability';

export async function POST(request: NextRequest) {
  if (Number(request.headers.get('content-length')) > 16_384)
    return noStore({ error: 'Request too large.' }, { status: 413 });
  const raw = await request.text();
  if (raw.length > 16_384)
    return noStore({ error: 'Request too large.' }, { status: 413 });
  if (
    !(await verifyProbeTick(
      probeTriggerSecret(),
      request.headers.get('x-probe-timestamp'),
      request.headers.get('x-probe-signature'),
      raw,
    ))
  )
    return noStore({ error: 'Invalid scheduler signature.' }, { status: 401 });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return noStore({ error: 'Invalid JSON.' }, { status: 400 });
  }
  const slot = body?.slot;
  if (
    !Number.isSafeInteger(slot) ||
    slot % PROBE_INTERVAL_MS !== 0 ||
    slot > probeSlot(Date.now()) ||
    slot < probeSlot(Date.now()) - PROBE_INTERVAL_MS
  )
    return noStore({ error: 'Invalid probe interval.' }, { status: 400 });
  try {
    if (body.action === 'list')
      return noStore({ ids: await availabilityStore().due(slot, Date.now()) });
    if (
      body.action !== 'check' ||
      !Array.isArray(body.ids) ||
      body.ids.length > 10 ||
      !body.ids.every(
        (id: unknown) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id),
      )
    )
      return noStore({ error: 'Invalid targets.' }, { status: 400 });
    const outcomes = await mapProbePool(
      [...new Set<string>(body.ids)],
      5,
      (id) => runAvailabilityTarget(id, slot, request.signal),
    );
    return noStore({
      checked: outcomes.length,
      ok: outcomes.filter((x) => x === 'ok').length,
      failing: outcomes.filter((x) => x === 'failing').length,
      unknown: outcomes.filter((x) => x === 'unknown').length,
      skipped: outcomes.filter((x) => x === 'skipped').length,
    });
  } catch {
    return noStore(
      { error: 'Scheduled checks could not be completed.' },
      { status: 503 },
    );
  }
}
