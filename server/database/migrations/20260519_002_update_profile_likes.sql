DROP TABLE IF EXISTS profile_likes;

CREATE TABLE profile_likes (
  liker_profile_id TEXT NOT NULL,
  liked_profile_id TEXT NOT NULL,
  last_liked_at TEXT NOT NULL DEFAULT (datetime('now')),
  total_given INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (liker_profile_id, liked_profile_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_likes_liked ON profile_likes (liked_profile_id);
