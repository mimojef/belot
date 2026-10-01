PRAGMA foreign_keys = ON;

-- "Anti Bad Luck праг" (Admin -> Настройки) — seed по съществуващия
-- admin_settings key/value модел (виж 20260926_001 за registration mode).
-- Само INSERT ... ON CONFLICT DO NOTHING: идемпотентно, без schema промяна,
-- без bulk данни, без промяна на вече зададена стойност.
--
--   anti_bad_luck_threshold        0|5|6|7|8|9|10. 5 = поведението отпреди
--                                  настройката (seat става pending след 5
--                                  поредни BAD → rescue най-рано на 6-тото);
--                                  0 = системата е напълно изключена.
--   anti_bad_luck_reset_generation вътрешен брояч (не admin-editable):
--                                  увеличава се атомарно при всяко
--                                  превключване към 0; anti-bad-luck state,
--                                  изчислен при по-стара generation, се
--                                  изхвърля при следващото раздаване.
INSERT INTO admin_settings (setting_key, setting_value) VALUES
  ('anti_bad_luck_threshold', '5'),
  ('anti_bad_luck_reset_generation', '0')
ON CONFLICT(setting_key) DO NOTHING;
