PRAGMA foreign_keys = ON;

ALTER TABLE profile_friendships
  ADD COLUMN blocker_profile_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_profile_friendships_blocker
  ON profile_friendships(blocker_profile_id, status, updated_at);
