-- „Свара“: ръчно уреждане на задържани изплащания (status='held') от
-- администратор — одит на решението. Само добавящи колони; съществуващите
-- редове не се променят. Уреждането е само от 'held' към 'paid' (на
-- победителя по фиксираните условия) или 'refunded' (връщане на входовете),
-- в една транзакция; UNIQUE(match, profile, type) в ledger-а пази от двойно.
ALTER TABLE svara_match_finance ADD COLUMN resolved_at TEXT NULL;
ALTER TABLE svara_match_finance ADD COLUMN resolved_by TEXT NULL;
ALTER TABLE svara_match_finance ADD COLUMN resolution_action TEXT NULL
  CHECK (resolution_action IS NULL OR resolution_action IN ('payout', 'refund'));
ALTER TABLE svara_match_finance ADD COLUMN resolution_note TEXT NULL;
ALTER TABLE svara_match_finance ADD COLUMN resolution_evidence TEXT NULL;
-- held_reason трябва да е NULL извън 'held' (CHECK) → първоначалната причина се пази тук.
ALTER TABLE svara_match_finance ADD COLUMN resolved_held_reason TEXT NULL;
