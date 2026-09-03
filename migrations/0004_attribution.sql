ALTER TABLE events ADD COLUMN vid TEXT;
ALTER TABLE events ADD COLUMN name TEXT;

CREATE TABLE visitors (
  launch_id TEXT NOT NULL,
  id TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  first_path TEXT,
  last_path TEXT,
  first_referrer TEXT,
  last_referrer TEXT,
  first_utm_source TEXT,
  first_utm_medium TEXT,
  first_utm_campaign TEXT,
  last_utm_source TEXT,
  last_utm_medium TEXT,
  last_utm_campaign TEXT,
  country TEXT,
  device TEXT,
  PRIMARY KEY (launch_id, id)
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  launch_id TEXT NOT NULL,
  vid TEXT,
  provider TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'one_time',
  currency TEXT DEFAULT 'usd',
  first_referrer TEXT,
  last_referrer TEXT,
  first_path TEXT,
  created_at INTEGER NOT NULL,
  external_id TEXT
);

CREATE TABLE hour_buckets (
  launch_id TEXT NOT NULL,
  hour_ts INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  uniques INTEGER NOT NULL DEFAULT 0,
  signups INTEGER NOT NULL DEFAULT 0,
  revenue_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (launch_id, hour_ts)
);

CREATE TABLE launch_modes (
  launch_id TEXT PRIMARY KEY,
  live INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE INDEX idx_payments_launch_created ON payments(launch_id, created_at);
CREATE INDEX idx_events_launch_vid_created ON events(launch_id, vid, created_at);
CREATE INDEX idx_visitors_launch ON visitors(launch_id);
CREATE UNIQUE INDEX idx_payments_provider_external ON payments(provider, external_id) WHERE external_id IS NOT NULL;
