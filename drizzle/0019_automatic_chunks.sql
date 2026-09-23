CREATE TABLE rpm_automatic_chunks (run_id TEXT NOT NULL REFERENCES rpm_runs(id) ON DELETE CASCADE, chunk_index INTEGER NOT NULL, PRIMARY KEY (run_id, chunk_index));
