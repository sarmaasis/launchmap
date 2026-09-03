CREATE TABLE search_queries (
  launch_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  query TEXT NOT NULL,
  page TEXT NOT NULL DEFAULT '',
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  day TEXT NOT NULL,
  PRIMARY KEY (launch_id, engine, query, page, day)
);

CREATE INDEX idx_search_queries_launch ON search_queries(launch_id, clicks DESC);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  launch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  access_json TEXT,
  site_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_connections_launch_kind ON connections(launch_id, kind);
CREATE INDEX idx_connections_user ON connections(user_id);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX idx_api_keys_user ON api_keys(user_id);
