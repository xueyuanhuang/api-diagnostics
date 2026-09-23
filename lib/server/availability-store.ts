import {
  PROBE_INTERVAL_MS,
  probeSlot,
  type AvailabilityData,
  type AvailabilitySample,
  type AvailabilityTarget,
} from '../availability';

export class AvailabilityError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export type StoredProbe = {
  id: string;
  userId: string;
  profileId: string;
  profileName: string;
  apiType: 'anthropic' | 'openai';
  modelName: string;
  openRouterTier?: string | null;
  baseUrl: string;
  allowInsecureHttp: number;
  createdAt: number;
  paused?: number;
};
const targetColumns = `t.id, t.user_id AS userId, t.profile_id AS profileId, p.name AS profileName,
  t.openrouter_tier AS openRouterTier, t.api_type AS apiType, t.model_name AS modelName, t.base_url AS baseUrl,
  t.allow_insecure_http AS allowInsecureHttp, t.created_at AS createdAt, t.paused`;

export class AvailabilityStore {
  constructor(private db: D1Database) {}

  async add(
    userId: string,
    input: Omit<StoredProbe, 'userId' | 'profileName'>,
  ) {
    const results = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM availability_targets WHERE user_id=? AND profile_id=? AND api_type=? AND model_name=? AND COALESCE(openrouter_tier,'')=? AND deleted_at IS NOT NULL`,
        )
        .bind(userId, input.profileId, input.apiType, input.modelName, input.openRouterTier ?? ''),
      this.db
        .prepare(`INSERT OR IGNORE INTO availability_targets
        (id,user_id,profile_id,api_type,model_name,base_url,allow_insecure_http,created_at,openrouter_tier)
        SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM connection_profiles WHERE id=? AND user_id=?)
        AND (SELECT COUNT(*) FROM availability_targets WHERE deleted_at IS NULL)<200`)
        .bind(
          input.id,
          userId,
          input.profileId,
          input.apiType,
          input.modelName,
          input.baseUrl,
          input.allowInsecureHttp,
          input.createdAt,
          input.openRouterTier ?? null,
          input.profileId,
          userId,
        ),
    ]);
    const result = results[1];
    if (!result.meta.changes)
      throw new AvailabilityError(
        'Target already exists, the connection is unavailable, or the 200-target monitoring limit has been reached.',
        409,
      );
    return this.db
      .prepare(
        `SELECT id FROM availability_targets WHERE user_id=? AND profile_id=? AND api_type=? AND model_name=? AND COALESCE(openrouter_tier,'')=? AND deleted_at IS NULL`,
      )
      .bind(userId, input.profileId, input.apiType, input.modelName, input.openRouterTier ?? '')
      .first<{ id: string }>();
  }

  async pause(userId: string, id: string, paused: boolean) {
    const result=await this.db.prepare('UPDATE availability_targets SET paused=? WHERE id=? AND user_id=? AND deleted_at IS NULL').bind(paused?1:0,id,userId).run();
    if (!result.meta.changes) throw new AvailabilityError('Target not found.',404);
  }

  async remove(userId: string, id: string, now: number) {
    const result = await this.db
      .prepare(
        'UPDATE availability_targets SET deleted_at=? WHERE id=? AND user_id=? AND deleted_at IS NULL',
      )
      .bind(now, id, userId)
      .run();
    if (!result.meta.changes)
      throw new AvailabilityError('Target not found.', 404);
  }

  async active(id: string, userId?: string): Promise<StoredProbe | null> {
    return this.db
      .prepare(`SELECT ${targetColumns} FROM availability_targets t
      JOIN connection_profiles p ON p.id=t.profile_id AND p.user_id=t.user_id
      WHERE t.id=? AND t.deleted_at IS NULL AND t.paused=0${userId ? ' AND t.user_id=?' : ''}`)
      .bind(...(userId ? [id, userId] : [id]))
      .first<StoredProbe>();
  }

  async claim(target: StoredProbe, slot: number, now: number) {
    const result = await this.db
      .prepare(`INSERT OR IGNORE INTO availability_samples
      (id,target_id,slot_start,started_at,status)
      SELECT ?,?,?,?,'checking' FROM availability_targets
      WHERE id=? AND user_id=? AND deleted_at IS NULL AND paused=0 AND created_at=?`)
      .bind(
        `${target.id}:${slot}`,
        target.id,
        slot,
        now,
        target.id,
        target.userId,
        target.createdAt,
      )
      .run();
    return Boolean(result.meta.changes);
  }

  async finish(
    target: StoredProbe,
    slot: number,
    sample: Omit<AvailabilitySample, 'slotStart' | 'startedAt'>,
  ) {
    await this.db.batch([
      this.db
        .prepare(`UPDATE availability_samples SET finished_at=?,status=?,http_status=?,latency_ms=?,returned_model=?,request_id=?,answer=?,error=?
        WHERE target_id=? AND slot_start=? AND status='checking'
        AND EXISTS (SELECT 1 FROM availability_targets WHERE id=? AND deleted_at IS NULL AND created_at=?)`)
        .bind(
          sample.finishedAt,
          sample.status,
          sample.httpStatus,
          sample.latencyMs,
          sample.returnedModel,
          sample.requestId,
          sample.answer,
          sample.error,
          target.id,
          slot,
          target.id,
          target.createdAt,
        ),
      this.db
        .prepare(
          'DELETE FROM availability_samples WHERE target_id=? AND slot_start<?',
        )
        .bind(target.id, slot - 7 * 24 * 60 * 60 * 1000),
    ]);
  }

  async due(slot: number, now: number) {
    await this.db
      .prepare(
        `INSERT INTO availability_scheduler (id,last_tick_at) VALUES ('main',?) ON CONFLICT(id) DO UPDATE SET last_tick_at=MAX(last_tick_at,excluded.last_tick_at)`,
      )
      .bind(now)
      .run();
    const rows = await this.db
      .prepare(`SELECT t.id FROM availability_targets t
      JOIN connection_profiles p ON p.id=t.profile_id AND p.user_id=t.user_id
      WHERE t.deleted_at IS NULL AND t.paused=0 AND t.created_at<? AND NOT EXISTS
      (SELECT 1 FROM availability_samples s WHERE s.target_id=t.id AND s.slot_start=?)
      ORDER BY COALESCE((SELECT MAX(started_at) FROM availability_samples WHERE target_id=t.id),0),t.created_at,t.id LIMIT 200`)
      .bind(slot + PROBE_INTERVAL_MS, slot)
      .all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }

  async list(
    userId: string,
    configured: boolean,
    now: number,
  ): Promise<AvailabilityData> {
    const [targets, samples, heartbeat] = await Promise.all([
      this.db
        .prepare(
          `SELECT ${targetColumns} FROM availability_targets t JOIN connection_profiles p ON p.id=t.profile_id AND p.user_id=t.user_id WHERE t.user_id=? AND t.deleted_at IS NULL ORDER BY t.created_at DESC,t.id`,
        )
        .bind(userId)
        .all<StoredProbe>(),
      this.db
        .prepare(`SELECT s.target_id AS targetId,s.slot_start AS slotStart,s.started_at AS startedAt,s.finished_at AS finishedAt,s.status,
        s.http_status AS httpStatus,s.latency_ms AS latencyMs,s.returned_model AS returnedModel,s.request_id AS requestId,s.answer,s.error
        FROM availability_targets t JOIN availability_samples s ON s.target_id=t.id
        WHERE t.user_id=? AND t.deleted_at IS NULL AND s.slot_start>=? AND s.started_at>=t.created_at ORDER BY s.slot_start`)
        .bind(userId, probeSlot(now) - 23 * PROBE_INTERVAL_MS)
        .all<AvailabilitySample & { targetId: string }>(),
      this.db
        .prepare(
          "SELECT last_tick_at AS lastTickAt FROM availability_scheduler WHERE id='main'",
        )
        .first<{ lastTickAt: number }>(),
    ]);
    const grouped = new Map<string, AvailabilitySample[]>();
    for (const { targetId, ...sample } of samples.results) {
      const rows = grouped.get(targetId) ?? [];
      rows.push(sample);
      grouped.set(targetId, rows);
    }
    return {
      targets: targets.results.map(
        ({ userId: _owner, allowInsecureHttp: _consent, ...target }) =>
          ({
            ...target,
            samples: grouped.get(target.id) ?? [],
          }) as AvailabilityTarget,
      ),
      scheduler: { configured, lastTickAt: heartbeat?.lastTickAt ?? null },
      serverTime: now,
    };
  }
}
