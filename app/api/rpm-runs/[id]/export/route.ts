import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRuns } from '@/db/schema';
import { RPM_REQUEST_TIMEOUT_MS } from '@/lib/rpm-types';
import { concurrencyUsesStreaming } from '@/lib/concurrency-test';
import { listR2Keys, runDetail } from '@/lib/server/rpm-store';
import { RPM_MAX_RESPONSE_BYTES } from '@/lib/server/rpm-provider';

type Context = { params: Promise<{ id: string }> };

function filenamePart(value: string) {
  return (
    value
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unnamed'
  );
}

async function storedJson(key: string) {
  const object = await env.EVIDENCE.get(key);
  try {
    return object
      ? JSON.parse(await object.text())
      : { evidenceObjectKey: key, error: 'Stored object is missing.' };
  } catch {
    return {
      evidenceObjectKey: key,
      error: 'Stored object could not be decoded.',
    };
  }
}

export async function GET(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json(
      { error: 'Sign in to export this RPM run.' },
      { status: 401, headers: { 'cache-control': 'private, no-store' } },
    );
  const { id } = await context.params;
  const rows = await getDb()
    .select()
    .from(rpmRuns)
    .where(and(eq(rpmRuns.id, id), eq(rpmRuns.userId, user.userId)))
    .limit(1);
  if (!rows.length)
    return Response.json(
      { error: 'RPM run not found.' },
      { status: 404, headers: { 'cache-control': 'private, no-store' } },
    );

  const detail = await runDetail(rows[0]);
  const connectionObject = await env.EVIDENCE.get(
    `rpm/v1/${id}/connection.json`,
  );
  const connection = connectionObject ? await connectionObject.json() : null;
  const preflightObject = await env.EVIDENCE.get(`rpm/v1/${id}/preflight.json`);
  const preflightText = preflightObject ? await preflightObject.text() : '';
  let preflight: unknown = null;
  try {
    preflight = preflightText ? JSON.parse(preflightText) : null;
  } catch {
    preflight = { error: 'Stored preflight evidence could not be decoded.' };
  }
  const resultPrefix = `rpm/v1/${id}/results/`;
  const dispatchStartPrefix = `rpm/v1/${id}/dispatch-starts/`;
  const resultKeys = await listR2Keys(env.EVIDENCE, resultPrefix);
  const dispatcherKeys = await listR2Keys(
    env.EVIDENCE,
    `rpm/v1/${id}/dispatchers/`,
  );
  const dispatcherFailureKeys = await listR2Keys(
    env.EVIDENCE,
    `rpm/v1/${id}/dispatcher-failures/`,
  );
  const shardClaimKeys = await listR2Keys(env.EVIDENCE, `rpm/v1/${id}/claims/`);
  const upstreamClaimKeys = await listR2Keys(
    env.EVIDENCE,
    `rpm/v1/${id}/upstream-claims/`,
  );
  const dispatchStartKeys = await listR2Keys(env.EVIDENCE, dispatchStartPrefix);
  const resultIdentities = new Set(
    resultKeys.map((key) => key.slice(resultPrefix.length)),
  );
  const unmatchedDispatchStartKeys = dispatchStartKeys.filter(
    (key) => !resultIdentities.has(key.slice(dispatchStartPrefix.length)),
  );
  const encoder = new TextEncoder();
  const header = `${JSON.stringify({
    schemaVersion: 'rpm-evidence-v1',
    exportedAt: new Date().toISOString(),
    connection,
    evidenceScope:
      'Every preflight, dispatcher manifest, and request/response evidence object present when this export snapshot began. Responses stored after the verdict freeze are retained with verdictEligible=false. Re-export an active or partial run after it settles to include later raw evidence. API keys and sensitive response headers are redacted.',
    requestPolicy: {
      stream: detail.run.rampMode === 'concurrency' && concurrencyUsesStreaming(rows[0].automaticMetricsJson),
      maxTokens: detail.run.openRouterTier ? 512 : 8,
      requestedServiceTier: detail.run.openRouterTier ?? null,
      clientRetries: 0,
      preflightTimeoutMs: 45_000,
      rampRequestTimeoutMs: detail.run.rampMode === 'automatic' ? RPM_REQUEST_TIMEOUT_MS : dispatcherKeys.length
        ? RPM_REQUEST_TIMEOUT_MS
        : 45_000,
      maxStoredResponseBodyBytes: RPM_MAX_RESPONSE_BYTES,
      dispatchMode: detail.run.rampMode === 'concurrency' ? 'concurrency-shards-v1' : detail.run.rampMode === 'automatic' ? 'automatic-closed-loop-v1' : dispatcherKeys.length
        ? upstreamClaimKeys.length
          ? 'server-timed-shard-v1'
          : 'server-timed-shard-v2'
        : 'legacy-browser-timed-batch-v1',
    },
    diagnosticSummary: {
      classification:
        ['fixed','automatic','concurrency'].includes(detail.run.rampMode) && detail.run.status === 'passed' ? 'measurement_complete' : detail.run.status === 'inconclusive'
          ? 'tester_delivery_failure'
          : detail.run.status === 'failed'
            ? 'provider_threshold_failure'
            : detail.run.status,
      providerJudged: !['fixed','automatic','concurrency'].includes(detail.run.rampMode) && detail.run.status !== 'inconclusive',
      stopReason: detail.run.stopReason,
      stages: detail.stages.map((stage) => ({
        stageIndex: stage.stageIndex,
        targetRpm: stage.targetRpm,
        status: stage.status,
        armStatus:
          stage.scheduledStartAt !== null
            ? 'armed'
            : stage.status === 'pending'
              ? 'not_started'
              : 'failed_to_arm',
        failureClass:
          stage.status === 'inconclusive'
            ? stage.scheduledStartAt === null
              ? 'pre_arm_dispatcher_failure'
              : 'post_arm_delivery_failure'
            : null,
        armedAt: stage.scheduledStartAt,
        expectedDispatchers: stage.batchCount,
        scheduledRequests: stage.scheduledCount,
        verifiedDispatchStarts: stage.attemptedCount,
        preservedSuccessfulResponses: stage.successCount,
        unverifiedSendSlots: stage.missedDispatchCount,
        unstartedSendSlots:
          stage.scheduledStartAt === null ? stage.scheduledCount : 0,
        providerJudged: stage.dispatchValid === true,
      })),
    },
    controlClaims: {
      explanation:
        'Each v2 dispatcher claims one immutable sequence partition before arming. Legacy v1 runs also contain per-request claims. Only a dispatch-start marker or preserved response counts as a verified upstream start.',
      shardClaimKeys,
      upstreamClaimKeys,
      dispatchStartKeys,
    },
    partial:
      detail.run.status === 'cancelled' ||
      detail.run.status === 'inconclusive' ||
      detail.stages.some(
        (stage) =>
          stage.status === 'running' ||
          stage.status === 'finalizing' ||
          stage.status === 'pending',
      ),
    run: detail.run,
    stages: detail.stages,
    preflight,
  }).slice(0, -1)},"batches":[`;
  type ExportPhase =
    | 'header'
    | 'batches'
    | 'dispatchStarts'
    | 'dispatchers'
    | 'failures'
    | 'done';
  let phase: ExportPhase = 'header';
  let index = 0;
  let first = true;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const push = (value: string) => controller.enqueue(encoder.encode(value));
      try {
        if (phase === 'header') {
          push(header);
          phase = 'batches';
          return;
        }
        if (phase === 'batches') {
          if (index < resultKeys.length) {
            const value = await storedJson(resultKeys[index]);
            push(`${first ? '' : ','}${JSON.stringify(value)}`);
            first = false;
            index += 1;
            return;
          }
          push('],"unmatchedDispatchStarts":[');
          phase = 'dispatchStarts';
          index = 0;
          first = true;
          return;
        }
        if (phase === 'dispatchStarts') {
          if (index < unmatchedDispatchStartKeys.length) {
            const value = await storedJson(unmatchedDispatchStartKeys[index]);
            push(`${first ? '' : ','}${JSON.stringify(value)}`);
            first = false;
            index += 1;
            return;
          }
          push('],"dispatchers":[');
          phase = 'dispatchers';
          index = 0;
          first = true;
          return;
        }
        if (phase === 'dispatchers') {
          if (index < dispatcherKeys.length) {
            const value = await storedJson(dispatcherKeys[index]);
            push(`${first ? '' : ','}${JSON.stringify(value)}`);
            first = false;
            index += 1;
            return;
          }
          push('],"dispatcherFailures":[');
          phase = 'failures';
          index = 0;
          first = true;
          return;
        }
        if (phase === 'failures') {
          if (index < dispatcherFailureKeys.length) {
            const value = await storedJson(dispatcherFailureKeys[index]);
            push(`${first ? '' : ','}${JSON.stringify(value)}`);
            first = false;
            index += 1;
            return;
          }
          push(']}');
          phase = 'done';
          return;
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  const timestamp = new Date(detail.run.createdAt)
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
  const filename = `rpm-rps_${filenamePart(detail.run.profileName ?? 'one-time')}_${filenamePart(detail.run.modelName)}_${timestamp}_${detail.run.status}.json`;
  return new Response(stream, {
    headers: {
      'cache-control': 'private, no-store',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}
