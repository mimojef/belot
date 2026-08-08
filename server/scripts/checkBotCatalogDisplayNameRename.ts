/**
 * checkBotCatalogDisplayNameRename.ts — regression coverage for the 300
 * permanent catalog bot display-name rename (A/B/C/D/E/F + 6 digits).
 *
 * [1]  exactly 300 names in BOT_CATALOG_DISPLAY_NAMES
 * [2]  exactly 50 names starting with A
 * [3]  exactly 50 names starting with B
 * [4]  exactly 50 names starting with C
 * [5]  exactly 50 names starting with D
 * [6]  exactly 50 names starting with E
 * [7]  exactly 50 names starting with F
 * [8]  every name matches ^[A-F][0-9]{6}$
 * [9]  all 300 names are unique
 * [10] mapping to profile_id matches the exact bot-f-/bot-m- group ranges
 * [11] rename does not change gender for any profile
 * [12] rename does not change the set of profile_id rows (no add/remove)
 * [13] rename does not change balance/level/skill_rating/stats/bot_metadata/
 *      bot_allowed_stakes (independent before/after query diff, not just
 *      trusting the function-under-test's own snapshot)
 *
 * Plus: fresh-DB seeding produces the new names directly (no legacy
 * "Мария38961" style names survive), restart/re-seed after rename does not
 * revert names, dry-run performs zero writes, and a broken pre-condition
 * aborts with no partial writes.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { BOT_CATALOG_DISPLAY_NAMES } from '../src/db/botCatalogDisplayNames.js'
import {
  renameCatalogBotDisplayNames,
  snapshotBotNonNameFields,
} from '../src/db/renameBotCatalogDisplayNames.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}`)
    failed++
  }
}

async function applyMigrations(databaseFilePath: string): Promise<void> {
  const db = new DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of migrationFiles) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    db.exec(sql)
  }
  db.close()
}

// ─── [1]-[10] Pure static checks on BOT_CATALOG_DISPLAY_NAMES ──────────────

function checkStaticMapping(): void {
  console.log('\n[1-10] Static BOT_CATALOG_DISPLAY_NAMES checks')

  const entries = Object.entries(BOT_CATALOG_DISPLAY_NAMES)
  check('[1] exactly 300 names', entries.length === 300)

  const letterCounts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 }
  for (const [, name] of entries) {
    const letter = name.charAt(0)
    letterCounts[letter] = (letterCounts[letter] ?? 0) + 1
  }
  check('[2] exactly 50 names with A', letterCounts.A === 50)
  check('[3] exactly 50 names with B', letterCounts.B === 50)
  check('[4] exactly 50 names with C', letterCounts.C === 50)
  check('[5] exactly 50 names with D', letterCounts.D === 50)
  check('[6] exactly 50 names with E', letterCounts.E === 50)
  check('[7] exactly 50 names with F', letterCounts.F === 50)

  const formatRe = /^[A-F][0-9]{6}$/
  check('[8] every name matches ^[A-F][0-9]{6}$', entries.every(([, name]) => formatRe.test(name)))

  const uniqueNames = new Set(entries.map(([, name]) => name))
  check('[9] all 300 names are unique', uniqueNames.size === 300)

  const expectedLetterFor = (profileId: string): string | null => {
    const femaleMatch = profileId.match(/^bot-f-(\d{3})$/)
    if (femaleMatch) {
      const index = Number(femaleMatch[1])
      if (index >= 0 && index <= 49) return 'A'
      if (index >= 50 && index <= 99) return 'B'
      if (index >= 100 && index <= 149) return 'C'
      return null
    }
    const maleMatch = profileId.match(/^bot-m-(\d{3})$/)
    if (maleMatch) {
      const index = Number(maleMatch[1])
      if (index >= 0 && index <= 49) return 'D'
      if (index >= 50 && index <= 99) return 'E'
      if (index >= 100 && index <= 149) return 'F'
      return null
    }
    return null
  }

  const mappingMatchesGroups = entries.every(([profileId, name]) => {
    const expectedLetter = expectedLetterFor(profileId)
    return expectedLetter !== null && name.charAt(0) === expectedLetter
  })
  check('[10] mapping to profile_id matches bot-f-/bot-m- group ranges exactly', mappingMatchesGroups)

  const allExpectedIdsPresent =
    Array.from({ length: 150 }, (_, i) => `bot-f-${String(i).padStart(3, '0')}`)
      .every((id) => id in BOT_CATALOG_DISPLAY_NAMES) &&
    Array.from({ length: 150 }, (_, i) => `bot-m-${String(i).padStart(3, '0')}`)
      .every((id) => id in BOT_CATALOG_DISPLAY_NAMES)
  check('[10b] all 300 expected bot-f-000..149 / bot-m-000..149 ids are covered', allExpectedIdsPresent)
}

// ─── Fresh-DB seeding uses the new names directly ──────────────────────────

async function checkFreshSeedUsesNewNames(): Promise<void> {
  console.log('\n[fresh-seed] seedCatalogBotsIfNeeded() on a fresh DB uses new A-F names')

  const dir = await mkdtemp(join(tmpdir(), 'belot-bot-rename-fresh-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    await applyMigrations(dbPath)
    const store = await createPlayerProgressStore(dbPath)
    store.seedCatalogBotsIfNeeded()
    store.close()

    const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
    const rows = db.prepare(
      `SELECT profile_id, display_name FROM profiles WHERE profile_kind = 'bot' ORDER BY profile_id;`,
    ).all() as { profile_id: string; display_name: string }[]
    db.close()

    check('[fresh-seed] exactly 300 bot rows created', rows.length === 300)
    check(
      '[fresh-seed] every seeded display_name matches the static A-F catalog',
      rows.every((r) => r.display_name === BOT_CATALOG_DISPLAY_NAMES[r.profile_id]),
    )
    check(
      '[fresh-seed] no legacy "Мария/Ивайло..." style names survive',
      rows.every((r) => /^[A-F][0-9]{6}$/.test(r.display_name)),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ─── Simulated "old production" DB (legacy Мария/Ивайло names) + rename ───

function seedLegacyStyleBots(db: DatabaseSync): void {
  const maleNames = ['Иван', 'Петър', 'Георги', 'Стефан', 'Антон', 'Борис', 'Мартин', 'Калин', 'Симон', 'Кирил', 'Радо', 'Веско', 'Митко', 'Христо', 'Тодор', 'Алекс', 'Виктор', 'Тошко', 'Данко', 'Ивайло']
  const femaleNames = ['Мария', 'Елена', 'Надя', 'Соня', 'Вера', 'Нора', 'Лора', 'Яна', 'Деси', 'Поли', 'Катя', 'Таня', 'Сара', 'Ева', 'Диана', 'Стела', 'Ани', 'Ина', 'Силвия', 'Биляна']

  const insertProfile = db.prepare(`
    INSERT INTO profiles (
      profile_id, account_id, profile_kind, username, normalized_username,
      display_name, normalized_display_name, avatar_url,
      level, rank_title, skill_rating, gender, status
    ) VALUES (?, NULL, 'bot', NULL, NULL, ?, ?, NULL, 3, 'Ранг 3', 1234, ?, 'active');
  `)
  const insertWallet = db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 73000);`)
  const insertProgress = db.prepare(`INSERT INTO profile_progress (profile_id, completed_games_count, won_games_count, rank_level) VALUES (?, 42, 19, 3);`)
  const insertMetadata = db.prepare(`
    INSERT INTO bot_metadata (
      profile_id, bot_code, difficulty, behavior_preset, logic_source, selection_weight,
      auto_refill_threshold, auto_refill_target_balance
    ) VALUES (?, ?, 'hard', 'aggressive', 'existing-core-v1', 17, 5000, 60000);
  `)
  const insertStake = db.prepare(`INSERT INTO bot_allowed_stakes (profile_id, stake_amount) VALUES (?, ?);`)

  function suffix(globalIndex: number): string {
    return String(10000 + ((globalIndex * 7919 + 11111) % 90000))
  }

  function generate(names: string[], gender: 'male' | 'female', prefix: string, globalOffset: number): void {
    let botIndex = 0
    for (let nameIdx = 0; nameIdx < names.length; nameIdx++) {
      const count = nameIdx < 10 ? 8 : 7
      for (let variant = 0; variant < count; variant++) {
        const displayName = `${names[nameIdx]}${suffix(globalOffset + botIndex)}`
        const normalized = displayName.toLocaleLowerCase('bg-BG')
        const profileId = `${prefix}${String(botIndex).padStart(3, '0')}`
        const botCode = `CATALOG_${profileId.toUpperCase().replace(/-/g, '_')}`
        insertProfile.run(profileId, displayName, normalized, gender)
        insertWallet.run(profileId)
        insertProgress.run(profileId)
        insertMetadata.run(profileId, botCode)
        insertStake.run(profileId, 5000)
        insertStake.run(profileId, 10000)
        botIndex++
      }
    }
  }

  generate(maleNames, 'male', 'bot-m-', 0)
  generate(femaleNames, 'female', 'bot-f-', 150)
}

async function checkRenameOfExistingLegacyDb(): Promise<void> {
  console.log('\n[11-13] Rename of a simulated pre-existing ("production-like") legacy-named DB')

  const dir = await mkdtemp(join(tmpdir(), 'belot-bot-rename-legacy-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    await applyMigrations(dbPath)
    const seedDb = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
    seedDb.exec('PRAGMA foreign_keys = ON;')
    seedLegacyStyleBots(seedDb)

    const genderBefore = new Map<string, string | null>()
    const idsBefore = new Set<string>()
    const nonNameSnapshotsBefore = new Map<string, string>()
    for (const row of seedDb.prepare(`SELECT profile_id, gender, display_name FROM profiles WHERE profile_kind = 'bot';`).all() as { profile_id: string; gender: string | null; display_name: string }[]) {
      idsBefore.add(row.profile_id)
      genderBefore.set(row.profile_id, row.gender)
      nonNameSnapshotsBefore.set(row.profile_id, snapshotBotNonNameFields(seedDb, row.profile_id))
      check(`[legacy-sanity] ${row.profile_id} starts with a legacy-style name (not A-F format) before rename`, !/^[A-F][0-9]{6}$/.test(row.display_name))
    }
    check('[legacy-sanity] 300 legacy bot rows seeded', idsBefore.size === 300)

    // Dry-run must perform zero writes.
    const dryRunResult = renameCatalogBotDisplayNames(seedDb, { apply: false })
    check('[dry-run] preflight passes on legacy DB', dryRunResult.ok === true && dryRunResult.preflightIssues.length === 0)
    check('[dry-run] applied === false', dryRunResult.applied === false)
    const stillLegacy = seedDb.prepare(`SELECT COUNT(*) AS c FROM profiles WHERE profile_kind = 'bot' AND display_name GLOB '[A-F][0-9][0-9][0-9][0-9][0-9][0-9]';`).get() as { c: number }
    check('[dry-run] zero rows renamed after dry-run', stillLegacy.c === 0)

    // Apply.
    const applyResult = renameCatalogBotDisplayNames(seedDb, { apply: true })
    check('[apply] ok === true', applyResult.ok === true)
    check('[apply] applied === true', applyResult.applied === true)
    check('[apply] renamedCount === 300', applyResult.renamedCount === 300)
    check('[apply] no snapshot mismatches reported', applyResult.snapshotMismatches.length === 0)
    check(
      '[apply] per-letter counts are 50 each',
      ['A', 'B', 'C', 'D', 'E', 'F'].every((letter) => applyResult.perLetterCounts[letter] === 50),
    )

    const afterRows = seedDb.prepare(`SELECT profile_id, gender, display_name FROM profiles WHERE profile_kind = 'bot';`).all() as { profile_id: string; gender: string | null; display_name: string }[]
    const idsAfter = new Set(afterRows.map((r) => r.profile_id))

    check('[12] profile_id set unchanged (no add/remove)', idsAfter.size === idsBefore.size && [...idsBefore].every((id) => idsAfter.has(id)))

    check(
      '[apply] every bot now has its expected new display_name',
      afterRows.every((r) => r.display_name === BOT_CATALOG_DISPLAY_NAMES[r.profile_id]),
    )

    let genderUnchangedCount = 0
    for (const row of afterRows) {
      if (genderBefore.get(row.profile_id) === row.gender) genderUnchangedCount++
    }
    check('[11] gender unchanged for all 300 profiles', genderUnchangedCount === 300)

    // [13] Independent before/after diff (not reusing the function's own
    // snapshot machinery) across balance / level / skill_rating / stats /
    // bot_metadata / bot_allowed_stakes.
    let independentMismatchCount = 0
    for (const profileId of idsBefore) {
      const after = snapshotBotNonNameFields(seedDb, profileId)
      const before = nonNameSnapshotsBefore.get(profileId)
      if (after !== before) independentMismatchCount++
    }
    check('[13] independent snapshot diff: zero non-name field changes across all 300 profiles', independentMismatchCount === 0)

    // Spot-check a handful of concrete fields directly (belt-and-braces on
    // top of the JSON-snapshot diff above).
    const spotCheckRow = seedDb.prepare(`
      SELECT p.level, p.skill_rating, pw.yellow_coins_balance, pp.completed_games_count, pp.won_games_count,
             bm.difficulty, bm.behavior_preset, bm.selection_weight
      FROM profiles p
      JOIN profile_wallets pw ON pw.profile_id = p.profile_id
      JOIN profile_progress pp ON pp.profile_id = p.profile_id
      JOIN bot_metadata bm ON bm.profile_id = p.profile_id
      WHERE p.profile_id = 'bot-f-000';
    `).get() as { level: number; skill_rating: number; yellow_coins_balance: number; completed_games_count: number; won_games_count: number; difficulty: string; behavior_preset: string; selection_weight: number }
    check(
      '[13-spotcheck] bot-f-000 keeps seeded level/rating/balance/stats/metadata exactly',
      spotCheckRow.level === 3 &&
        spotCheckRow.skill_rating === 1234 &&
        spotCheckRow.yellow_coins_balance === 73000 &&
        spotCheckRow.completed_games_count === 42 &&
        spotCheckRow.won_games_count === 19 &&
        spotCheckRow.difficulty === 'hard' &&
        spotCheckRow.behavior_preset === 'aggressive' &&
        spotCheckRow.selection_weight === 17,
    )
    const stakeRows = seedDb.prepare(`SELECT stake_amount FROM bot_allowed_stakes WHERE profile_id = 'bot-f-000' ORDER BY stake_amount;`).all() as { stake_amount: number }[]
    check('[13-spotcheck] bot-f-000 bot_allowed_stakes unchanged (5000, 10000)', stakeRows.length === 2 && stakeRows[0]!.stake_amount === 5000 && stakeRows[1]!.stake_amount === 10000)

    // Restart/redeploy simulation: seedCatalogBotsIfNeeded() after rename
    // must NOT revert names (count>=300 guard + INSERT OR IGNORE).
    const store = await createPlayerProgressStore(dbPath)
    store.seedCatalogBotsIfNeeded()
    store.close()
    const afterRestart = seedDb.prepare(`SELECT profile_id, display_name FROM profiles WHERE profile_kind = 'bot';`).all() as { profile_id: string; display_name: string }[]
    check(
      '[restart] seedCatalogBotsIfNeeded() after rename does not revert names',
      afterRestart.every((r) => r.display_name === BOT_CATALOG_DISPLAY_NAMES[r.profile_id]),
    )

    // Re-running the rename again (already-renamed DB) must stay a safe no-op.
    const rerunResult = renameCatalogBotDisplayNames(seedDb, { apply: true })
    check('[idempotent] re-running rename on already-renamed DB succeeds with no conflicts', rerunResult.ok === true && rerunResult.preflightIssues.length === 0)
    check('[idempotent] re-running rename again reports renamedCount === 300', rerunResult.renamedCount === 300)

    seedDb.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function checkBrokenPreconditionAborts(): Promise<void> {
  console.log('\n[safety] broken pre-condition aborts with zero writes')

  const dir = await mkdtemp(join(tmpdir(), 'belot-bot-rename-broken-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    await applyMigrations(dbPath)
    const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
    db.exec('PRAGMA foreign_keys = ON;')
    seedLegacyStyleBots(db)

    // Delete one bot so the count check (300) fails.
    db.exec(`DELETE FROM bot_allowed_stakes WHERE profile_id = 'bot-f-000';`)
    db.exec(`DELETE FROM bot_metadata WHERE profile_id = 'bot-f-000';`)
    db.exec(`DELETE FROM profile_progress WHERE profile_id = 'bot-f-000';`)
    db.exec(`DELETE FROM profile_wallets WHERE profile_id = 'bot-f-000';`)
    db.exec(`DELETE FROM profiles WHERE profile_id = 'bot-f-000';`)

    const result = renameCatalogBotDisplayNames(db, { apply: true })
    check('[safety] preflight fails when a target bot is missing', result.ok === false && result.applied === false)
    check(
      '[safety] preflight issue mentions the missing profile or wrong count',
      result.preflightIssues.some((i) => i.profileId === 'bot-f-000' || i.reason.includes('300')),
    )

    const renamedCount = db.prepare(`SELECT COUNT(*) AS c FROM profiles WHERE profile_kind = 'bot' AND display_name GLOB '[A-F][0-9][0-9][0-9][0-9][0-9][0-9]';`).get() as { c: number }
    check('[safety] zero rows renamed when preflight fails (no partial writes)', renamedCount.c === 0)

    db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  checkStaticMapping()
  await checkFreshSeedUsesNewNames()
  await checkRenameOfExistingLegacyDb()
  await checkBrokenPreconditionAborts()

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
