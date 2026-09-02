ALTER TABLE events ADD COLUMN referrer TEXT;
ALTER TABLE events ADD COLUMN device TEXT;
CREATE INDEX IF NOT EXISTS idx_events_launch_path ON events(launch_id, path);
