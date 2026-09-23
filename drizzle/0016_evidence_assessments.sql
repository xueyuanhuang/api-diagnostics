ALTER TABLE test_results ADD COLUMN assessment_json TEXT;
CREATE TABLE run_assessments (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
 reference_run_id TEXT,
 analysis_version TEXT NOT NULL,
 report_json TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX run_assessments_owner_run ON run_assessments(user_id, run_id, created_at);
