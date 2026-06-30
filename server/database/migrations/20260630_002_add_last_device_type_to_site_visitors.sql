ALTER TABLE site_visitors
  ADD COLUMN last_device_type TEXT NULL
  CHECK (last_device_type IN ('mobile', 'desktop', 'tablet', 'unknown'));

-- Backfill from last_user_agent where available.
-- The classification mirrors detectDeviceType() in server/src/utils/detectDeviceType.ts.
-- Rows without a user agent are set to 'unknown'. No rows remain NULL after this migration.
-- This UPDATE is idempotent: re-running it only sets rows that are still NULL.
UPDATE site_visitors
SET last_device_type = CASE
  -- iPhone / iPod → mobile
  WHEN last_user_agent LIKE '%iPhone%'  THEN 'mobile'
  WHEN last_user_agent LIKE '%iPod%'    THEN 'mobile'
  -- Android phone: contains 'Android' AND 'Mobile'
  WHEN last_user_agent LIKE '%Android%' AND last_user_agent LIKE '%Mobile%' THEN 'mobile'
  -- iPad → tablet (explicit token)
  WHEN last_user_agent LIKE '%iPad%'    THEN 'tablet'
  -- iPadOS desktop-like: "Macintosh" UA that also carries "Mobile" (Safari on iPad with desktop mode)
  WHEN last_user_agent LIKE '%Macintosh%' AND last_user_agent LIKE '%Mobile%' THEN 'tablet'
  -- Android without 'Mobile' → tablet
  WHEN last_user_agent LIKE '%Android%' THEN 'tablet'
  -- Desktop OS tokens
  WHEN last_user_agent LIKE '%Windows%' THEN 'desktop'
  WHEN last_user_agent LIKE '%Macintosh%' THEN 'desktop'
  WHEN last_user_agent LIKE '%Linux%'   THEN 'desktop'
  WHEN last_user_agent LIKE '%CrOS%'    THEN 'desktop'
  -- UA present but unrecognised
  WHEN last_user_agent IS NOT NULL      THEN 'unknown'
  -- No UA at all → also unknown; all rows get a non-NULL value after this migration
  ELSE 'unknown'
END
WHERE last_device_type IS NULL;
