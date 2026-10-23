-- MANUAL_TRANSACTION_MIGRATION
-- Самоизтриване на профили — Етап 4E4 (одит P5, одобрено решение):
-- оценките, които изтрит профил е дал на други играчи, остават в техните
-- рейтинги, но без връзка към изтрития; получените от него — изчезват.
--
-- Собствена транзакция (MANUAL_TRANSACTION_MIGRATION), защото таблицата се
-- пресъздава, а PRAGMA foreign_keys не може да се изключи вътре в отворена
-- транзакция (established pattern: 20260902_002 / 20261026_001 / 20261027_001).
--
-- profile_partner_ratings (20260510_002):
--   * rated_by_profile_id: NOT NULL + ON DELETE CASCADE -> NULL + ON DELETE
--     SET NULL. Анонимният ред пази стойността, стаята и датата; оригиналният
--     ID НЕ се пази никъде (без snapshot колона). Случаен заместител не е
--     възможен — FK към profiles го забранява.
--   * rated_profile_id: непроменено (NOT NULL + ON DELETE CASCADE) —
--     получените оценки изчезват с профила.
--   * UNIQUE (room_id, rated_by_profile_id, rated_profile_id) — непроменено.
--     NULL не участва в сравнението, но анонимен ред се появява САМО от
--     SET NULL каскадата (вж. тригера за INSERT по-долу), а за всеки
--     рейтингов scope (стая + версия) играчът има точно един партньор —
--     дублиране по смисъл не е възможно.
--   * Нов индекс по rated_by_profile_id — FK действието при изтриване на
--     профил (и проверката на executor-а) не сканира цялата таблица.
--   * Тригери:
--       - нова оценка без оценяващ се отказва (правилата за оценяване не
--         могат да бъдат заобиколени с NULL);
--       - анонимен ред е неизменим — не може да бъде "присвоен" на сесия
--         или редактиран.
-- Всички колони, стойности, UNIQUE и съществуващият индекс са запазени.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE profile_partner_ratings_new (
  rating_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  rated_profile_id TEXT NOT NULL,
  rated_by_profile_id TEXT NULL,
  rating_value INTEGER NOT NULL CHECK (
    rating_value BETWEEN 1 AND 6
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rated_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (rated_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  UNIQUE (room_id, rated_by_profile_id, rated_profile_id)
);

INSERT INTO profile_partner_ratings_new (
  rating_id, room_id, rated_profile_id, rated_by_profile_id, rating_value, created_at
)
SELECT
  rating_id, room_id, rated_profile_id, rated_by_profile_id, rating_value, created_at
FROM profile_partner_ratings;

DROP TABLE profile_partner_ratings;
ALTER TABLE profile_partner_ratings_new RENAME TO profile_partner_ratings;

CREATE INDEX idx_profile_partner_ratings_rated_profile_id
  ON profile_partner_ratings(rated_profile_id, created_at);

CREATE INDEX idx_profile_partner_ratings_rated_by_profile_id
  ON profile_partner_ratings(rated_by_profile_id);

CREATE TRIGGER trg_profile_partner_ratings_rater_required
BEFORE INSERT ON profile_partner_ratings
WHEN NEW.rated_by_profile_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'profile_partner_rating_rater_required');
END;

CREATE TRIGGER trg_profile_partner_ratings_anonymous_immutable
BEFORE UPDATE ON profile_partner_ratings
WHEN OLD.rated_by_profile_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'profile_partner_rating_anonymous_immutable');
END;

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20261028_001_preserve_anonymous_partner_ratings.sql');

COMMIT;

PRAGMA foreign_keys = ON;
