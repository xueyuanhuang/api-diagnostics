import { validateBaseUrl } from './connection';

export class HistoryAssignmentError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const profileMetadataSql = `
  SELECT p.id, p.name, COALESCE(c.base_url, p.base_url) AS baseUrl
  FROM connection_profiles p
  LEFT JOIN profile_api_configs c ON c.profile_id = p.id AND c.api_type = ?
  WHERE p.id = ? AND p.user_id = ?
    AND (c.id IS NOT NULL OR (p.api_type = ? AND NOT EXISTS (
      SELECT 1 FROM profile_api_configs any_config WHERE any_config.profile_id = p.id
    )))`;

// This changes ownership metadata only, never the captured request/results or any key.
export async function assignHistoryConnection(
  db: Pick<D1Database, 'prepare'>,
  userId: string,
  runId: string,
  profileId: string,
) {
  if (!userId)
    throw new HistoryAssignmentError('Sign in to organize saved runs.', 401);
  if (!profileId || profileId.length > 100)
    throw new HistoryAssignmentError('Choose a saved connection.', 400);
  const run = await db
    .prepare(`
    SELECT id, profile_id AS profileId, profile_name AS profileName, api_type AS apiType, base_url AS baseUrl
    FROM test_runs WHERE id = ? AND user_id = ?
  `)
    .bind(runId, userId)
    .first<{
      id: string;
      profileId: string | null;
      profileName: string | null;
      apiType: string;
      baseUrl: string;
    }>();
  if (!run) throw new HistoryAssignmentError('Saved run not found.', 404);
  if (run.profileId !== null || run.profileName !== null)
    throw new HistoryAssignmentError(
      'This run already has a connection name. Refresh history before continuing.',
      409,
    );
  const profileArgs = [run.apiType, profileId, userId, run.apiType];
  const profile = await db
    .prepare(profileMetadataSql)
    .bind(...profileArgs)
    .first<{ id: string; name: string; baseUrl: string }>();
  if (!profile)
    throw new HistoryAssignmentError(
      'Saved connection or matching API type not found.',
      404,
    );
  const runUrl = validateBaseUrl(run.baseUrl);
  const profileUrl = validateBaseUrl(profile.baseUrl);
  if (
    'error' in runUrl ||
    'error' in profileUrl ||
    runUrl.baseUrl !== profileUrl.baseUrl
  )
    throw new HistoryAssignmentError(
      'The saved connection must have the same API type and base URL as this historical run.',
      409,
    );
  const changed = await db
    .prepare(`
    UPDATE test_runs SET profile_id = ?, profile_name = ?
    WHERE id = ? AND user_id = ? AND profile_id IS NULL AND profile_name IS NULL
      AND api_type = ? AND base_url = ?
      AND EXISTS (SELECT 1 FROM (${profileMetadataSql}) target WHERE target.name = ? AND target.baseUrl = ?)
  `)
    .bind(
      profile.id,
      profile.name,
      runId,
      userId,
      run.apiType,
      run.baseUrl,
      ...profileArgs,
      profile.name,
      profile.baseUrl,
    )
    .run();
  if (changed.meta.changes !== 1)
    throw new HistoryAssignmentError(
      'The run or connection changed. Refresh history and try again.',
      409,
    );
  return { id: runId, profileId: profile.id, profileName: profile.name };
}
