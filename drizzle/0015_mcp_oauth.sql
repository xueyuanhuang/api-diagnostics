CREATE TABLE IF NOT EXISTS mcp_clients (id TEXT PRIMARY KEY, redirect_uri TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_codes (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, state TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_tokens (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL, resource TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS mcp_tokens_user_idx ON mcp_tokens(user_id);
