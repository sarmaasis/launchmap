ALTER TABLE events ADD COLUMN utm_source TEXT;
ALTER TABLE events ADD COLUMN utm_medium TEXT;
ALTER TABLE events ADD COLUMN utm_campaign TEXT;
ALTER TABLE events ADD COLUMN host TEXT;
ALTER TABLE events ADD COLUMN bot INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS deletion_requests (id TEXT PRIMARY KEY, user_id TEXT, email TEXT NOT NULL, requested_at INTEGER NOT NULL, completed_at INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, launch_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, match_value TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_launch_bot_created ON events(launch_id, bot, created_at);
CREATE INDEX IF NOT EXISTS idx_goals_launch ON goals(launch_id);
