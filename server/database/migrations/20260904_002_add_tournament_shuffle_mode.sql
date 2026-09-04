PRAGMA foreign_keys = ON;

-- "С разбъркване" tournament mode (виж task spec-а за shuffle mode). Backward
-- compatible за всички съществуващи турнири: default 0/NULL запазва точно
-- сегашното auto-pair-при-join поведение (shuffle_enabled=0 никога не влиза
-- в новите code paths).
--
-- shuffle_enabled се задава САМО при create, никога не се променя после —
-- server-authoritative, клиентът не може да го overwrite-не през друг endpoint.
--
-- teams_shuffled_at е idempotency guard за еднократното окончателно
-- разбъркване (T-15 за scheduled / при запълване за fill) — NULL означава
-- "shuffle-ът още не е извършен"; веднъж сетнат, никога не се презаписва
-- (виж shuffleTournamentEntrantsAtomically).
ALTER TABLE tournaments ADD COLUMN shuffle_enabled INTEGER NOT NULL DEFAULT 0 CHECK (
  shuffle_enabled IN (0, 1)
);

ALTER TABLE tournaments ADD COLUMN teams_shuffled_at TEXT NULL;

-- Due-queue за scheduler tick-а: shuffle-enabled scheduled турнири, чийто
-- T-15 момент вече е дошъл, но shuffle-ът още не е извършен.
CREATE INDEX IF NOT EXISTS idx_tournaments_shuffle_due
  ON tournaments(scheduled_start_at)
  WHERE status = 'open' AND start_mode = 'scheduled' AND shuffle_enabled = 1 AND teams_shuffled_at IS NULL;
