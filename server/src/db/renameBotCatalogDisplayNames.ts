import { BOT_CATALOG_DISPLAY_NAMES } from './botCatalogDisplayNames.js'
import { validateProfileDisplayName } from './normalizeProfileIdentityText.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

const NEW_DISPLAY_NAME_RE = /^[A-F][0-9]{6}$/

export type RenameCatalogBotsIssue = {
  profileId: string
  reason: string
}

export type RenameCatalogBotsResult = {
  ok: boolean
  applied: boolean
  totalTargets: number
  renamedCount: number
  perLetterCounts: Record<string, number>
  preflightIssues: RenameCatalogBotsIssue[]
  snapshotMismatches: RenameCatalogBotsIssue[]
}

/**
 * Serializes every column this rename must NOT touch, across every table
 * that references a catalog bot profile_id. Used to prove (before === after)
 * that the rename only ever wrote display_name/normalized_display_name/
 * updated_at on `profiles`.
 */
export function snapshotBotNonNameFields(
  database: SqliteDatabase,
  profileId: string,
): string {
  const profile = database.prepare(`
    SELECT account_id, profile_kind, username, normalized_username, avatar_url,
           level, rank_title, skill_rating, status, created_at,
           average_rating, total_ratings_count, gender, is_temporary
    FROM profiles
    WHERE profile_id = ?;
  `).get(profileId)

  const wallet = database.prepare(`
    SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?;
  `).get(profileId)

  const progress = database.prepare(`
    SELECT completed_games_count, won_games_count, rank_level
    FROM profile_progress WHERE profile_id = ?;
  `).get(profileId)

  const metadata = database.prepare(`
    SELECT bot_code, difficulty, behavior_preset, logic_source, selection_weight,
           auto_refill_threshold, auto_refill_target_balance
    FROM bot_metadata WHERE profile_id = ?;
  `).get(profileId)

  const allowedStakes = database.prepare(`
    SELECT stake_amount FROM bot_allowed_stakes WHERE profile_id = ? ORDER BY stake_amount;
  `).all(profileId)

  return JSON.stringify({ profile, wallet, progress, metadata, allowedStakes })
}

function letterOf(displayName: string): string {
  return displayName.charAt(0)
}

/**
 * Renames the 300 permanent catalog bot profiles (bot-f-000..149,
 * bot-m-000..149) to the fixed A–F + 6-digit names in
 * BOT_CATALOG_DISPLAY_NAMES.
 *
 * Deliberately does NOT reuse adminRenameProfileDisplayName: that helper's
 * underlying statements are scoped to `profile_kind = 'human'` and silently
 * no-op ("Профилът не беше намерен.") for bot profiles — verified directly
 * against a seeded temp DB. Duplicating a bot-scoped UPDATE here (instead of
 * widening the shared human-facing admin helper) keeps this change isolated
 * to the bot catalog.
 *
 * options.apply = false (default) runs every pre-flight check and reports
 * what WOULD happen, without opening a write transaction — safe to call
 * against a live database repeatedly.
 */
export function renameCatalogBotDisplayNames(
  database: SqliteDatabase,
  options: { apply: boolean },
): RenameCatalogBotsResult {
  const targetProfileIds = Object.keys(BOT_CATALOG_DISPLAY_NAMES)
  const preflightIssues: RenameCatalogBotsIssue[] = []
  const perLetterCounts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 }

  const seenNames = new Set<string>()
  for (const [profileId, newName] of Object.entries(BOT_CATALOG_DISPLAY_NAMES)) {
    if (!NEW_DISPLAY_NAME_RE.test(newName)) {
      preflightIssues.push({ profileId, reason: `Name "${newName}" does not match ^[A-F][0-9]{6}$.` })
      continue
    }

    if (seenNames.has(newName)) {
      preflightIssues.push({ profileId, reason: `Duplicate generated name "${newName}".` })
    }
    seenNames.add(newName)

    const validation = validateProfileDisplayName(newName, { profileId })
    if (!validation.ok) {
      preflightIssues.push({ profileId, reason: `Fails validateProfileDisplayName: ${validation.message}` })
    }

    perLetterCounts[letterOf(newName)] = (perLetterCounts[letterOf(newName)] ?? 0) + 1
  }

  const femaleCount = targetProfileIds.filter((id) => id.startsWith('bot-f-')).length
  const maleCount = targetProfileIds.filter((id) => id.startsWith('bot-m-')).length
  if (femaleCount !== 150) {
    preflightIssues.push({ profileId: '*', reason: `Expected 150 bot-f- targets, got ${femaleCount}.` })
  }
  if (maleCount !== 150) {
    preflightIssues.push({ profileId: '*', reason: `Expected 150 bot-m- targets, got ${maleCount}.` })
  }

  const countRow = database.prepare(
    `SELECT COUNT(*) AS count FROM profiles WHERE profile_kind = 'bot';`,
  ).get() as { count: number }
  if (countRow.count !== 300) {
    preflightIssues.push({ profileId: '*', reason: `Expected exactly 300 bot profiles in target database, found ${countRow.count}.` })
  }

  const selectExisting = database.prepare(
    `SELECT profile_id FROM profiles WHERE profile_id = ? AND profile_kind = 'bot';`,
  )
  for (const profileId of targetProfileIds) {
    const row = selectExisting.get(profileId) as { profile_id: string } | undefined
    if (!row) {
      preflightIssues.push({ profileId, reason: 'Bot profile not found (or not profile_kind=bot) in target database.' })
    }
  }

  const conflictCheck = database.prepare(
    `SELECT profile_id FROM profiles WHERE normalized_display_name = ? LIMIT 1;`,
  )
  for (const [profileId, newName] of Object.entries(BOT_CATALOG_DISPLAY_NAMES)) {
    const normalized = newName.toLocaleLowerCase('bg-BG')
    const existing = conflictCheck.get(normalized) as { profile_id: string } | undefined
    if (existing && existing.profile_id !== profileId) {
      preflightIssues.push({
        profileId,
        reason: `normalized_display_name "${normalized}" already used by profile "${existing.profile_id}".`,
      })
    }
  }

  // FINAL PLAN v5 — Display Name Reservation, diagnostic-only pass. Same
  // TOCTOU caveat as conflictCheck above applies here too: this is early UX
  // feedback for a dry-run report, NOT the authoritative gate — see the
  // re-check inside BEGIN IMMEDIATE below, which is what actually protects
  // the invariant against a reservation claimed between this preflight and
  // the write transaction.
  const pendingConflictCheck = database.prepare(`
    SELECT pending_registration_id
    FROM pending_registrations
    WHERE normalized_display_name = ?
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    LIMIT 1;
  `)
  for (const [profileId, newName] of Object.entries(BOT_CATALOG_DISPLAY_NAMES)) {
    const normalized = newName.toLocaleLowerCase('bg-BG')
    const existingPending = pendingConflictCheck.get(normalized) as { pending_registration_id: string } | undefined
    if (existingPending) {
      preflightIssues.push({
        profileId,
        reason: `normalized_display_name "${normalized}" reserved by active pending registration "${existingPending.pending_registration_id}".`,
      })
    }
  }

  if (preflightIssues.length > 0 || !options.apply) {
    return {
      ok: preflightIssues.length === 0,
      applied: false,
      totalTargets: targetProfileIds.length,
      renamedCount: 0,
      perLetterCounts,
      preflightIssues,
      snapshotMismatches: [],
    }
  }

  const beforeSnapshots = new Map<string, string>()
  for (const profileId of targetProfileIds) {
    beforeSnapshots.set(profileId, snapshotBotNonNameFields(database, profileId))
  }

  const updateStatement = database.prepare(`
    UPDATE profiles
    SET display_name = ?, normalized_display_name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ? AND profile_kind = 'bot';
  `)

  let renamedCount = 0
  const snapshotMismatches: RenameCatalogBotsIssue[] = []

  database.exec('BEGIN IMMEDIATE;')
  try {
    // FINAL PLAN v5 — authoritative re-check, INSIDE the write transaction,
    // BEFORE the first identity UPDATE. The preflight pass above (conflictCheck/
    // pendingConflictCheck) is informational only — a real registration or
    // rename could have claimed one of these names in the window between
    // that preflight and this BEGIN IMMEDIATE. Re-running both conflict
    // checks here, against the now-locked transaction snapshot, is what
    // actually closes that TOCTOU gap.
    const authoritativeProfileConflict = database.prepare(
      `SELECT profile_id FROM profiles WHERE normalized_display_name = ? LIMIT 1;`,
    )
    const authoritativePendingConflict = database.prepare(`
      SELECT pending_registration_id
      FROM pending_registrations
      WHERE normalized_display_name = ?
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      LIMIT 1;
    `)
    for (const [profileId, newName] of Object.entries(BOT_CATALOG_DISPLAY_NAMES)) {
      const normalized = newName.toLocaleLowerCase('bg-BG')

      const profileConflict = authoritativeProfileConflict.get(normalized) as { profile_id: string } | undefined
      if (profileConflict && profileConflict.profile_id !== profileId) {
        throw new Error(
          `Authoritative re-check failed: normalized_display_name "${normalized}" (target for "${profileId}") ` +
          `is now used by profile "${profileConflict.profile_id}" (claimed after the preflight pass). Rename stopped.`,
        )
      }

      const pendingConflict = authoritativePendingConflict.get(normalized) as { pending_registration_id: string } | undefined
      if (pendingConflict) {
        throw new Error(
          `Authoritative re-check failed: normalized_display_name "${normalized}" (target for "${profileId}") ` +
          `is reserved by active pending registration "${pendingConflict.pending_registration_id}" ` +
          `(claimed after the preflight pass). Rename stopped.`,
        )
      }
    }

    for (const [profileId, newName] of Object.entries(BOT_CATALOG_DISPLAY_NAMES)) {
      const normalized = newName.toLocaleLowerCase('bg-BG')
      const result = updateStatement.run(newName, normalized, profileId) as { changes?: number }

      if ((result.changes ?? 0) !== 1) {
        throw new Error(`Update affected ${result.changes ?? 0} row(s) for profile "${profileId}", expected 1.`)
      }

      renamedCount++
    }

    for (const profileId of targetProfileIds) {
      const after = snapshotBotNonNameFields(database, profileId)
      const before = beforeSnapshots.get(profileId)
      if (after !== before) {
        snapshotMismatches.push({ profileId, reason: 'Non-name fields changed by rename.' })
      }
    }

    if (snapshotMismatches.length > 0) {
      throw new Error(
        `${snapshotMismatches.length} profile(s) had non-name fields change unexpectedly; rolling back.`,
      )
    }

    database.exec('COMMIT;')
  } catch (error) {
    try {
      database.exec('ROLLBACK;')
    } catch {
      // ignore rollback failure and surface the original error
    }

    throw error
  }

  return {
    ok: true,
    applied: true,
    totalTargets: targetProfileIds.length,
    renamedCount,
    perLetterCounts,
    preflightIssues: [],
    snapshotMismatches: [],
  }
}
