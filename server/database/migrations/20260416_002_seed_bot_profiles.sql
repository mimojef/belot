PRAGMA foreign_keys = ON;

WITH RECURSIVE
  seq(n) AS (
    VALUES(1)
    UNION ALL
    SELECT n + 1
    FROM seq
    WHERE n < 240
  ),
  prefixes(idx, prefix) AS (
    VALUES
      (0,  'moby'),
      (1,  'mojo'),
      (2,  'kavo'),
      (3,  'nexo'),
      (4,  'orbi'),
      (5,  'vexo'),
      (6,  'zipo'),
      (7,  'lumo'),
      (8,  'tano'),
      (9,  'riko'),
      (10, 'faro'),
      (11, 'dexo'),
      (12, 'boro'),
      (13, 'sivo'),
      (14, 'piko'),
      (15, 'joro'),
      (16, 'moro'),
      (17, 'xeno'),
      (18, 'zeko'),
      (19, 'yavo')
  )
INSERT OR IGNORE INTO bot_profiles (
  profile_id,
  code,
  logic_source,
  status,
  selection_weight,
  username,
  display_name,
  avatar_url,
  level,
  rank_title,
  skill_rating,
  average_rating,
  total_ratings_count,
  yellow_coins_balance,
  bio_text,
  is_temporary_identity
)
SELECT
  'bot_' || printf('%03d', seq.n) AS profile_id,
  'bg-bot-' || printf('%03d', seq.n) AS code,
  'existing-core-v1' AS logic_source,
  'active' AS status,
  1 AS selection_weight,
  prefixes.prefix || printf('%09d', 200000000 + (seq.n * 7919)) AS username,
  prefixes.prefix || printf('%09d', 200000000 + (seq.n * 7919)) AS display_name,
  NULL AS avatar_url,
  1 AS level,
  'бот' AS rank_title,
  1000 AS skill_rating,
  4.2 AS average_rating,
  0 AS total_ratings_count,
  50000 AS yellow_coins_balance,
  'Стандартен бот профил за автоматично попълване на свободни места.' AS bio_text,
  0 AS is_temporary_identity
FROM seq
JOIN prefixes
  ON prefixes.idx = ((seq.n - 1) % 20);

WITH RECURSIVE
  seq(n) AS (
    VALUES(1)
    UNION ALL
    SELECT n + 1
    FROM seq
    WHERE n < 240
  ),
  stakes(stake) AS (
    VALUES
      (5000),
      (8000),
      (10000),
      (15000),
      (20000)
  )
INSERT OR IGNORE INTO bot_profile_allowed_stakes (
  profile_id,
  stake
)
SELECT
  'bot_' || printf('%03d', seq.n) AS profile_id,
  stakes.stake
FROM seq
CROSS JOIN stakes;

