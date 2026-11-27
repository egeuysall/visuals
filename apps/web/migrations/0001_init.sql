CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  failed INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  json TEXT NOT NULL
);

CREATE INDEX runs_user ON runs (user_id, created_at);

-- Daily counters that cap spend and guessing. The key starts with what is counted and the day.
CREATE TABLE usage (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
