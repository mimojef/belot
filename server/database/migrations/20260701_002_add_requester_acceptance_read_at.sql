-- Adds requester_acceptance_read_at to profile_friendships.
-- NULL  = requester has an unread "X accepted your friend request" notification.
-- TEXT  = ISO timestamp when the requester dismissed/read the notification.
-- Backfill: all existing accepted friendships are marked as already-read so
-- that no stale notifications appear after deploy.
-- Pending/rejected rows remain NULL but are never surfaced as notifications.

ALTER TABLE profile_friendships
  ADD COLUMN requester_acceptance_read_at TEXT NULL;

UPDATE profile_friendships
  SET requester_acceptance_read_at = updated_at
  WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS idx_profile_friendships_unread_acceptance
  ON profile_friendships(requester_profile_id, requester_acceptance_read_at)
  WHERE status = 'accepted' AND requester_acceptance_read_at IS NULL;
