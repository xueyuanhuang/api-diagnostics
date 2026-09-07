import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRunSecrets, rpmRuns } from '@/db/schema';
import type { RpmPreflightSummary } from '@/lib/rpm-types';
import { decryptApiKey } from '@/lib/server/encryption';
import { noStore, serverError } from '@/lib/server/http';
import {
  runProviderRequest,
  type RpmRequestEvidence,
} from '@/lib/server/rpm-provider';
import { runDetail } from '@/lib/server/rpm-store';
import { prepareRpmConnection } from '@/lib/server/hosted-ip-mapping';
import { IpMappingError } from '@/lib/server/ip-mapping';

type Context = { params: Promise<{ id: string }> };

function summarize(evidence: RpmRequestEvidence): RpmPreflightSummary {
  return {
    outcome: evidence.outcome,
    httpStatus: evidence.response.status,
    firstByteMs: evidence.firstByteMs,
    totalTimeMs: evidence.totalTimeMs,
    requestId: evidence.response.requestId,
    returnedModel: evidence.response.returnedModel,
    error: evidence.error,
  };
}

async function storedEvidence(id: string) {
  const object = await env.EVIDENCE.get(`rpm/v1/${id}/preflight.json`);
  if (!object) return null;
  try {
    return JSON.parse(await object.text()) as RpmRequestEvidence;
  } catch {
    return null;
  }
}

async function ownedRun(id: string, userId: string) {
  const rows = await getDb()
    .select()
    .from(rpmRuns)
    .where(and(eq(rpmRuns.id, id), eq(rpmRuns.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

async function failPreflight(id: string, userId: string, reason: string) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE rpm_stages SET status = 'skipped' WHERE run_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM rpm_runs WHERE id = ? AND user_id = ? AND status = 'preflight')",
    ).bind(id, id, userId),
    env.DB.prepare(
      "DELETE FROM rpm_run_secrets WHERE run_id = ? AND EXISTS (SELECT 1 FROM rpm_runs WHERE id = ? AND user_id = ? AND status = 'preflight')",
    ).bind(id, id, userId),
    env.DB.prepare(
      "DELETE FROM rpm_active_leases WHERE user_id = ? AND run_id = ? AND EXISTS (SELECT 1 FROM rpm_runs WHERE id = ? AND user_id = ? AND status = 'preflight')",
    ).bind(userId, id, id, userId),
    env.DB.prepare(
      "UPDATE rpm_runs SET status = 'inconclusive', stop_reason = ?, finished_at = ? WHERE id = ? AND user_id = ? AND status = 'preflight'",
    ).bind(reason, now, id, userId),
  ]);
}

async function applyEvidenceOutcome(
  id: string,
  userId: string,
  evidence: RpmRequestEvidence,
) {
  let run = await ownedRun(id, userId);
  if (!run || run.status !== 'preflight') return run;
  if (evidence.outcome === 'success') {
    await env.DB.prepare(
      "UPDATE rpm_runs SET status = 'ready' WHERE id = ? AND user_id = ? AND status = 'preflight'",
    )
      .bind(id, userId)
      .run();
  } else {
    await failPreflight(
      id,
      userId,
      `Preflight failed: ${evidence.error ?? evidence.outcome}.`,
    );
  }
  run = await ownedRun(id, userId);
  return run;
}

export async function POST(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore(
      { error: 'Sign in to preflight this run.' },
      { status: 401 },
    );
  const { id } = await context.params;

  let run = await ownedRun(id, user.userId);
  if (!run) return noStore({ error: 'RPM run not found.' }, { status: 404 });

  try {
    if (run.status !== 'preflight') {
      const existing = await storedEvidence(id);
      return noStore({
        ...(await runDetail(run)),
        preflight: existing ? summarize(existing) : null,
      });
    }

    const claimKey = `rpm/v1/${id}/preflight-claim`;
    let claim = await env.EVIDENCE.put(claimKey, String(Date.now()), {
      onlyIf: { etagDoesNotMatch: '*' },
    });
    if (!claim) {
      const existing = await storedEvidence(id);
      run = (await ownedRun(id, user.userId)) ?? run;
      if (existing) {
        run = (await applyEvidenceOutcome(id, user.userId, existing)) ?? run;
        return noStore({
          ...(await runDetail(run)),
          preflight: summarize(existing),
        });
      }
      if (run.status !== 'preflight') {
        return noStore({ ...(await runDetail(run)), preflight: null });
      }
      const previousClaim = await env.EVIDENCE.get(claimKey);
      const previousClaimedAt = previousClaim
        ? Number(await previousClaim.text())
        : Number.NaN;
      if (
        previousClaim &&
        Number.isFinite(previousClaimedAt) &&
        Date.now() - previousClaimedAt >= 90_000
      ) {
        claim = await env.EVIDENCE.put(claimKey, String(Date.now()), {
          onlyIf: { etagMatches: previousClaim.etag },
        });
      }
    }
    if (!claim) {
      return noStore(
        {
          error: 'This preflight is already running.',
          activeRunId: id,
          preflightInProgress: true,
        },
        { status: 409 },
      );
    }

    const secrets = await getDb()
      .select()
      .from(rpmRunSecrets)
      .where(eq(rpmRunSecrets.runId, id))
      .limit(1);
    if (!secrets.length) {
      run = (await ownedRun(id, user.userId)) ?? run;
      if (run.status !== 'preflight') {
        const existing = await storedEvidence(id);
        return noStore({
          ...(await runDetail(run)),
          preflight: existing ? summarize(existing) : null,
        });
      }
      await failPreflight(
        id,
        user.userId,
        'Preflight could not start because its temporary credential was unavailable.',
      );
      run = (await ownedRun(id, user.userId)) ?? run;
      return noStore(
        {
          ...(await runDetail(run)),
          preflight: null,
          error: run.stopReason,
        },
        { status: 409 },
      );
    }

    const apiKey = await decryptApiKey(
      secrets[0].encryptedApiKey,
      secrets[0].keyIv,
    );
    const resolved = await prepareRpmConnection(id, run.baseUrl);
    const evidence = await runProviderRequest({
      apiType: run.apiType,
      baseUrl: resolved.actualBaseUrl,
      originalBaseUrl: run.baseUrl,
      apiKey,
      model: run.modelName,
      runId: id,
      stageIndex: -1,
      sequence: 0,
      plannedAt: Date.now(),
    });
    run = (await ownedRun(id, user.userId)) ?? run;
    const savedEvidence = await env.EVIDENCE.put(
      `rpm/v1/${id}/preflight.json`,
      JSON.stringify(evidence),
      {
        httpMetadata: { contentType: 'application/json' },
        onlyIf: { etagDoesNotMatch: '*' },
      },
    );
    const canonicalEvidence = savedEvidence
      ? evidence
      : await storedEvidence(id);
    if (!canonicalEvidence)
      throw new Error('Preflight evidence could not be stored.');
    run =
      (await applyEvidenceOutcome(id, user.userId, canonicalEvidence)) ?? run;
    return noStore({
      ...(await runDetail(run)),
      preflight: summarize(canonicalEvidence),
    });
  } catch (error) {
    try {
      await failPreflight(
        id,
        user.userId,
        error instanceof IpMappingError
          ? error.message
          : 'Preflight could not be completed or saved. No ramp traffic was started.',
      );
    } catch {
      // Preserve the original server error if cleanup itself also fails.
    }
    if (error instanceof IpMappingError)
      return noStore({ error: error.message }, { status: error.status });
    return serverError(error);
  }
}
