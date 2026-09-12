CREATE TABLE IF NOT EXISTS public_gallery (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  seconds TEXT NOT NULL,
  tokens TEXT NOT NULL,
  object_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
