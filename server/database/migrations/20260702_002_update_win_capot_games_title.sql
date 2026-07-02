PRAGMA foreign_keys = ON;

-- Correct the title of the win_capot_games mission to reflect that progress
-- is now awarded per round (not per won match). Only updates rows whose title
-- still contains the old wording so re-running the migration is safe.
UPDATE mission_templates
SET title = 'Спечели рунд с капо', updated_at = CURRENT_TIMESTAMP
WHERE mission_type = 'win_capot_games'
  AND (
    title LIKE '%игра с капо%'
    OR title LIKE '%Спечели игра%'
    OR title LIKE '%win_capot%'
  );
