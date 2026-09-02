CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  plan TEXT NOT NULL,
  plan_status TEXT,
  launch_credits INTEGER NOT NULL DEFAULT 1,
  watermark INTEGER NOT NULL DEFAULT 1,
  dodo_customer_id TEXT,
  dodo_subscription_id TEXT,
  dodo_payment_id TEXT
);

CREATE TABLE magic_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE launches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  site_url TEXT,
  manual_revenue_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_launches_user ON launches(user_id, created_at DESC);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  launch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  visitor_hash TEXT,
  country TEXT,
  city TEXT,
  lat REAL,
  lng REAL,
  path TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_events_launch_created ON events(launch_id, created_at DESC);
CREATE INDEX idx_events_launch_kind ON events(launch_id, kind);

CREATE TABLE webhook_events (
  webhook_id TEXT PRIMARY KEY,
  event_type TEXT,
  payload TEXT,
  processed_at INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
