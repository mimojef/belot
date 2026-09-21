// checkPendingRegistrationDisplayNameReservationPreflight.ts
//
// READ-ONLY production preflight tool (FINAL PLAN v5, §12) — run this against
// a COPY/SNAPSHOT of the production belot-v2.sqlite file (NEVER against the
// live DB while the server is writing to it) BEFORE deploying the
// 20260921_001_add_pending_registration_display_name_reservation.sql
// migration, to know in advance exactly what the migration's backfill will
// do: how many pending rows exist, how many are already expired, which
// normalized-display-name duplicate groups exist among the active ones,
// which rows are malformed, which conflict with already-completed profiles,
// and — using the EXACT SAME deterministic winner/loser rule the migration
// handler uses (created_at ASC, pending_registration_id ASC) — which row in
// each duplicate group will end up reserved and which will end up NULL
// (unreserved, but never deleted).
//
// This script NEVER writes to the database (opened with { readOnly: true }).
// It uses the canonical normalizeProfileDisplayName() helper — the SAME
// function used by register()/check-name/verify — not a SQL LOWER() proxy,
// so its classification exactly matches what the real migration will do.
//
// Usage:
//   npx tsx scripts/checkPendingRegistrationDisplayNameReservationPreflight.ts <path-to-sqlite-copy>
//
// Does NOT run automatically against production. Does NOT modify anything.

import { DatabaseSync } from 'node:sqlite'
import { normalizeProfileDisplayName } from '../server/src/db/normalizeProfileIdentityText.js'

const dbPath = process.argv[2]
if (!dbPath) {
  console.error('Usage: npx tsx scripts/checkPendingRegistrationDisplayNameReservationPreflight.ts <path-to-sqlite-copy>')
  console.error('Run this against a COPY of the production DB — never against the live file while the server writes to it.')
  process.exit(1)
}

type PendingRow = {
  pending_registration_id: string
  display_name: string
  normalized_email: string
  created_at: string
  expires_at: string
}

type ProfileConflictRow = {
  profile_id: string
  normalized_display_name: string | null
  normalized_username: string | null
}

console.log('\n═══ checkPendingRegistrationDisplayNameReservationPreflight (READ-ONLY) ═══\n')
console.log(`DB: ${dbPath}\n`)

const db = new DatabaseSync(dbPath, { readOnly: true, open: true })

try {
  const nowIso = new Date().toISOString()

  // ─── 1. Total / active / expired pending counts ────────────────────────
  const totalPending = (db.prepare('SELECT COUNT(*) AS c FROM pending_registrations;').get() as { c: number }).c
  const expiredRows = db
    .prepare('SELECT pending_registration_id, display_name, normalized_email, created_at, expires_at FROM pending_registrations WHERE expires_at <= ?;')
    .all(nowIso) as PendingRow[]
  const activeRows = db
    .prepare('SELECT pending_registration_id, display_name, normalized_email, created_at, expires_at FROM pending_registrations WHERE expires_at > ?;')
    .all(nowIso) as PendingRow[]

  console.log(`Total pending registrations:        ${totalPending}`)
  console.log(`Active (non-expired) pending:        ${activeRows.length}`)
  console.log(`Expired pending (migration deletes): ${expiredRows.length}`)
  console.log()

  // ─── 2. Normalize every ACTIVE row with the canonical helper ───────────
  // (expired rows are deleted by the migration BEFORE backfill runs, so they
  // never participate in duplicate/conflict classification.)
  const normalizedById = new Map<string, string | null>()
  const malformed: PendingRow[] = []
  for (const row of activeRows) {
    const normalized = normalizeProfileDisplayName(row.display_name)
    normalizedById.set(row.pending_registration_id, normalized)
    if (normalized === null) malformed.push(row)
  }

  console.log(`Malformed/legacy display names (fail current validation): ${malformed.length}`)
  for (const row of malformed) {
    console.log(`  - ${row.pending_registration_id}  display_name="${row.display_name}"  created_at=${row.created_at}`)
  }
  console.log()

  // ─── 3. Group by normalized name -> exact duplicate groups ─────────────
  const groups = new Map<string, PendingRow[]>()
  for (const row of activeRows) {
    const normalized = normalizedById.get(row.pending_registration_id)
    if (normalized === null || normalized === undefined) continue
    const group = groups.get(normalized)
    if (group) group.push(row)
    else groups.set(normalized, [row])
  }
  const duplicateGroups = [...groups.entries()].filter(([, rows]) => rows.length > 1)

  console.log(`Exact normalized duplicate groups (2+ active pending rows, same normalized name): ${duplicateGroups.length}`)
  let normalizationCollisionCount = 0
  for (const [normalized, rows] of duplicateGroups) {
    const rawValues = new Set(rows.map((r) => r.display_name))
    const isNormalizationCollision = rawValues.size > 1
    if (isNormalizationCollision) normalizationCollisionCount += 1
    const sorted = [...rows].sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
      return a.pending_registration_id < b.pending_registration_id ? -1 : 1
    })
    console.log(`  normalized="${normalized}"${isNormalizationCollision ? ' [NORMALIZATION COLLISION — different raw spellings]' : ''}`)
    sorted.forEach((r, i) => {
      const role = i === 0 ? 'WINNER (reserved)' : 'loser (-> NULL, unreserved, NOT deleted)'
      console.log(`    [${role}] ${r.pending_registration_id}  raw="${r.display_name}"  created_at=${r.created_at}`)
    })
  }
  console.log()
  console.log(`  ...of which normalization collisions (different raw spelling, same normalized key): ${normalizationCollisionCount}`)
  console.log()

  // ─── 4. Conflicts against ALREADY-existing active profiles ─────────────
  const profileRows = db
    .prepare(`SELECT profile_id, normalized_display_name, normalized_username FROM profiles WHERE status = 'active';`)
    .all() as ProfileConflictRow[]
  const profileNormalizedDisplayNames = new Set(profileRows.map((p) => p.normalized_display_name).filter((v): v is string => v !== null))
  const profileNormalizedUsernames = new Set(profileRows.map((p) => p.normalized_username).filter((v): v is string => v !== null))

  const conflictsWithDisplayName: PendingRow[] = []
  const conflictsWithUsername: PendingRow[] = []
  for (const row of activeRows) {
    const normalized = normalizedById.get(row.pending_registration_id)
    if (normalized === null || normalized === undefined) continue
    if (profileNormalizedDisplayNames.has(normalized)) conflictsWithDisplayName.push(row)
    if (profileNormalizedUsernames.has(normalized)) conflictsWithUsername.push(row)
  }

  console.log(`Conflicts with profiles.normalized_display_name: ${conflictsWithDisplayName.length}`)
  for (const row of conflictsWithDisplayName) {
    console.log(`  - ${row.pending_registration_id}  display_name="${row.display_name}"`)
  }
  console.log(`Conflicts with profiles.normalized_username:      ${conflictsWithUsername.length}`)
  for (const row of conflictsWithUsername) {
    console.log(`  - ${row.pending_registration_id}  display_name="${row.display_name}"`)
  }
  console.log()

  // ─── 5. Final expected outcome counts ───────────────────────────────────
  const profileConflictIds = new Set([...conflictsWithDisplayName, ...conflictsWithUsername].map((r) => r.pending_registration_id))
  const loserIds = new Set<string>()
  for (const [, rows] of duplicateGroups) {
    const sorted = [...rows].sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
      return a.pending_registration_id < b.pending_registration_id ? -1 : 1
    })
    for (const loser of sorted.slice(1)) loserIds.add(loser.pending_registration_id)
  }
  const malformedIds = new Set(malformed.map((r) => r.pending_registration_id))

  let expectedReserved = 0
  let expectedUnreserved = 0
  for (const row of activeRows) {
    const id = row.pending_registration_id
    const isMalformed = malformedIds.has(id)
    const isLoser = loserIds.has(id)
    const isProfileConflict = profileConflictIds.has(id)
    if (isMalformed || isLoser || isProfileConflict) {
      expectedUnreserved += 1
    } else {
      expectedReserved += 1
    }
  }

  console.log('─'.repeat(72))
  console.log(`Expected reserved (non-NULL normalized_display_name) after migration:   ${expectedReserved}`)
  console.log(`Expected unreserved/NULL after migration (never deleted):               ${expectedUnreserved}`)
  console.log(`Expected expired rows the migration will DELETE:                        ${expiredRows.length}`)
  console.log('─'.repeat(72))
  console.log('\nNo writes performed. This is a read-only report.\n')
} finally {
  db.close()
}
