import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRuns } from '@/db/schema';
import { listR2Keys, runDetail } from '@/lib/server/rpm-store';

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
  const preflightObject = await env.EVIDENCE.get(`rpm/v1/${id}/preflight.json`);
  const preflightText = preflightObject ? await preflightObject.text() : '';
  let preflight: unknown = null;
  try {
    preflight = preflightText ? JSON.parse(preflightText) : null;
  } catch {
    preflight = { error: 'Stored preflight evidence could not be decoded.' };
  }
  const resultKeys = await listR2Keys(env.EVIDENCE, `rpm/v1/${id}/results/`);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (value: string) => controller.enqueue(encoder.encode(value));
      try {
        push(
          `${JSON.stringify({
            schemaVersion: 'rpm-evidence-v1',
            exportedAt: new Date().toISOString(),
            evidenceScope:
              'Every stored preflight and batch request/response. API keys and sensitive response headers are redacted.',
            partial:
              detail.run.status === 'cancelled' ||
              detail.run.status === 'inconclusive' ||
              detail.stages.some(
                (stage) =>
                  stage.status === 'running' || stage.status === 'pending',
              ),
            run: detail.run,
            stages: detail.stages,
            preflight,
          }).slice(0, -1)},"batches":[`,
        );
        let first = true;
        for (const key of resultKeys) {
          const object = await env.EVIDENCE.get(key);
          let batch: unknown;
          try {
            batch = object
              ? JSON.parse(await object.text())
              : { evidenceObjectKey: key, error: 'Stored object is missing.' };
          } catch {
            batch = {
              evidenceObjectKey: key,
              error: 'Stored object could not be decoded.',
            };
          }
          push(`${first ? '' : ','}${JSON.stringify(batch)}`);
          first = false;
        }
        push(']}');
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
  const filename = `rpm-ramp_${filenamePart(detail.run.profileName ?? 'one-time')}_${filenamePart(detail.run.modelName)}_${timestamp}_${detail.run.status}.json`;
  return new Response(stream, {
    headers: {
      'cache-control': 'private, no-store',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}
