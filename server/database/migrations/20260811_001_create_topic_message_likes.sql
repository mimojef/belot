PRAGMA foreign_keys = ON;

-- Current-state (не append-only event log) likes ledger за "Теми" root
-- messages и replies (Етап 3). PRIMARY KEY(message_id, liker_profile_id) е
-- самият DB constraint за "макс 1 active like/profile/message" — не in-memory
-- check. Unlike е DELETE (не soft-toggle флаг), like е INSERT — крайното
-- състояние винаги е "редът съществува = liked", изчислимо чрез COUNT(*)/
-- EXISTS, без нужда от replay на историята.
--
-- ON DELETE CASCADE към topic_messages: like-овете на изтрито съобщение
-- изчезват автоматично (симетрично с parent_message_id self-reference
-- cascade в 20260810_002). ON DELETE CASCADE към profiles следва
-- profile_likes (20260519_001) конвенцията.
CREATE TABLE IF NOT EXISTS topic_message_likes (
  message_id TEXT NOT NULL,
  liker_profile_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, liker_profile_id),
  FOREIGN KEY (message_id) REFERENCES topic_messages(message_id) ON DELETE CASCADE,
  FOREIGN KEY (liker_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

-- Захранва batch "SELECT message_id, COUNT(*) ... WHERE message_id IN (...)
-- GROUP BY message_id" aggregate заявките (likeCount за страница от root
-- messages / replies), а не N+1 per-message COUNT(*).
CREATE INDEX IF NOT EXISTS idx_topic_message_likes_message
  ON topic_message_likes(message_id);
