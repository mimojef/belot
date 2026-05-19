CREATE TABLE IF NOT EXISTS profile_likes (
  liker_profile_id TEXT NOT NULL,
  liked_profile_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (liker_profile_id, liked_profile_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_likes_liked ON profile_likes (liked_profile_id);
