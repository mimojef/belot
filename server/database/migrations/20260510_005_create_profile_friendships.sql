PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profile_friendships (
  friendship_id TEXT PRIMARY KEY,
  requester_profile_id TEXT NOT NULL,
  addressee_profile_id TEXT NOT NULL,
  lower_profile_id TEXT NOT NULL,
  higher_profile_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'accepted', 'blocked')
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at TEXT NULL,
  CHECK (requester_profile_id <> addressee_profile_id),
  CHECK (lower_profile_id <> higher_profile_id),
  UNIQUE (lower_profile_id, higher_profile_id),
  FOREIGN KEY (requester_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (addressee_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (lower_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (higher_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_profile_friendships_requester
  ON profile_friendships(requester_profile_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_profile_friendships_addressee
  ON profile_friendships(addressee_profile_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_profile_friendships_status_updated
  ON profile_friendships(status, updated_at);
