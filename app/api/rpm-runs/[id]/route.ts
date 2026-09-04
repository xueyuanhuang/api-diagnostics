import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRuns } from '@/db/schema';
import type { RpmPreflightSummary } from '@/lib/rpm-types';
import { noStore, serverError } from '@/lib/server/http';
import type { RpmRequestEvidence } from '@/lib/server/rpm-provider';
import { listR2Keys, runDetail } from '@/lib/server/rpm-store';

type Context = { params: Promise<{ id: string }> };

function preflightSummary(evidence: RpmRequestEvidence): RpmPreflightSummary {
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

type TesterDiagnostic = {
  stageIndex: number;
  sequence: number | null;
  shardIndex: number | null;
  plannedAt: number | null;
  recordedAt: number | null;
  scheduleLagMs: number | null;
  reason: string;
};

function diagnosticFromEvidence(value: unknown): TesterDiagnostic | null {
  if (typeof value !== 'object' || value === null) return null;
  const wrapper = value as { requests?: unknown[] };
  const candidate = Array.isArray(wrapper.requests)
    ? wrapper.requests[0]
    : value;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const evidence = candidate as Partial<RpmRequestEvidence>;
  if (evidence.outcome !== 'missed_dispatch') return null;
  return {
    stageIndex:
      typeof evidence.stageIndex === 'number' ? evidence.stageIndex : -1,
    sequence: typeof evidence.sequence === 'number' ? evidence.sequence : null,
    shardIndex:
      typeof evidence.dispatcher?.shardIndex === 'number'
        ? evidence.dispatcher.shardIndex
        : null,
    plannedAt:
      typeof evidence.plannedAt === 'number' ? evidence.plannedAt : null,
    recordedAt:
      typeof evidence.completedAt === 'number' ? evidence.completedAt : null,
    scheduleLagMs:
      typeof evidence.scheduleLagMs === 'number'
        ? evidence.scheduleLagMs
        : null,
    reason:
      typeof evidence.error === 'string' && evidence.error.trim()
        ? evidence.error
        : 'The tester did not record an upstream dispatch start for this slot.',
  };
}

async function storedTesterDiagnostics(
  runId: string,
  stages: Awaited<ReturnType<typeof runDetail>>['stages'],
) {
  const diagnostics: TesterDiagnostic[] = [];
  for (const stage of stages.filter((item) => item.missedDispatchCount > 0)) {
    const stagePart = String(stage.stageIndex).padStart(2, '0');
    let keys = await listR2Keys(
      env.EVIDENCE,
      `rpm/v1/${runId}/tester-diagnostics/s${stagePart}/`,
    );
    // Runs created before compact diagnostic objects were introduced only have
    // canonical request evidence. Scan newest records first and stop as soon as
    // the stage's known number of misses has been explained.
    if (!keys.length) {
      keys = (
        await listR2Keys(env.EVIDENCE, `rpm/v1/${runId}/results/s${stagePart}/`)
      ).reverse();
    }
    for (let index = 0; index < keys.length; index += 4) {
      const objects = await Promise.all(
        keys.slice(index, index + 4).map((key) => env.EVIDENCE.get(key)),
      );
      for (const object of objects) {
        if (!object) continue;
        try {
          const diagnostic = diagnosticFromEvidence(
            JSON.parse(await object.text()),
          );
          if (diagnostic) diagnostics.push(diagnostic);
        } catch {
          // A corrupt evidence object remains visible in the full export. It
          // cannot safely explain a missed send in this compact UI summary.
        }
      }
      if (
        diagnostics.filter((item) => item.stageIndex === stage.stageIndex)
          .length >= stage.missedDispatchCount
      ) {
        break;
      }
    }
  }
  return diagnostics.sort(
    (left, right) =>
      left.stageIndex - right.stageIndex ||
      (left.sequence ?? Number.MAX_SAFE_INTEGER) -
        (right.sequence ?? Number.MAX_SAFE_INTEGER),
  );
}

export async function GET(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to view this RPM run.' }, { status: 401 });
  const { id } = await context.params;
  try {
    const rows = await getDb()
      .select()
      .from(rpmRuns)
      .where(and(eq(rpmRuns.id, id), eq(rpmRuns.userId, user.userId)))
      .limit(1);
    if (!rows.length)
      return noStore({ error: 'RPM run not found.' }, { status: 404 });
    let preflight: RpmPreflightSummary | null = null;
    const object = await env.EVIDENCE.get(`rpm/v1/${id}/preflight.json`);
    if (object) {
      try {
        preflight = preflightSummary(
          JSON.parse(await object.text()) as RpmRequestEvidence,
        );
      } catch {
        preflight = null;
      }
    }
    const detail = await runDetail(rows[0]);
    let liveProgress: {
      stageIndex: number;
      scheduledRequests: number;
      expectedDispatchers: number;
      readyDispatchers: number;
      verifiedDispatchStarts: number;
      evidenceRecords: number;
    } | null = null;
    if (detail.run.status === 'running' && detail.run.currentStage !== null) {
      const activeStage = detail.stages.find(
        (stage) => stage.stageIndex === detail.run.currentStage,
      );
      if (activeStage) {
        const stagePart = String(activeStage.stageIndex).padStart(2, '0');
        const [readyKeys, dispatchStartKeys, resultKeys] = await Promise.all([
          listR2Keys(env.EVIDENCE, `rpm/v1/${id}/dispatchers/s${stagePart}/`),
          listR2Keys(
            env.EVIDENCE,
            `rpm/v1/${id}/dispatch-starts/s${stagePart}/`,
          ),
          listR2Keys(env.EVIDENCE, `rpm/v1/${id}/results/s${stagePart}/`),
        ]);
        liveProgress = {
          stageIndex: activeStage.stageIndex,
          scheduledRequests: activeStage.scheduledCount,
          expectedDispatchers: activeStage.batchCount,
          readyDispatchers: readyKeys.length,
          verifiedDispatchStarts: dispatchStartKeys.length,
          evidenceRecords: resultKeys.length,
        };
      }
    }
    const testerDiagnostics = await storedTesterDiagnostics(id, detail.stages);
    return noStore({ ...detail, preflight, liveProgress, testerDiagnostics });
  } catch (error) {
    return serverError(error);
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore(
      { error: 'Sign in to delete this RPM run.' },
      { status: 401 },
    );
  const { id } = await context.params;
  try {
    const rows = await getDb()
      .select({
        id: rpmRuns.id,
        status: rpmRuns.status,
        finishedAt: rpmRuns.finishedAt,
      })
      .from(rpmRuns)
      .where(and(eq(rpmRuns.id, id), eq(rpmRuns.userId, user.userId)))
      .limit(1);
    if (!rows.length)
      return noStore({ error: 'RPM run not found.' }, { status: 404 });
    if (['preflight', 'ready', 'running'].includes(rows[0].status)) {
      return noStore(
        { error: 'Cancel this active RPM run before deleting it.' },
        { status: 409 },
      );
    }
    if (
      rows[0].status === 'cancelled' &&
      rows[0].finishedAt !== null &&
      Date.now() - rows[0].finishedAt < 60_000
    ) {
      return noStore(
        {
          error:
            'This run was just cancelled. Wait one minute for in-flight requests to settle before deleting it.',
        },
        { status: 409 },
      );
    }
    const keys = await listR2Keys(env.EVIDENCE, `rpm/v1/${id}/`);
    for (let index = 0; index < keys.length; index += 1_000) {
      await env.EVIDENCE.delete(keys.slice(index, index + 1_000));
    }
    await env.DB.prepare('DELETE FROM rpm_runs WHERE id = ? AND user_id = ?')
      .bind(id, user.userId)
      .run();
    return noStore({ deleted: true });
  } catch (error) {
    return serverError(error);
  }
}
