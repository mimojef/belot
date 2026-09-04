/**
 * checkTournamentShuffleMode.ts
 *
 * Targeted regression за "С разбъркване" (tournament shuffle mode), актуален
 * към "scheduled shuffle timing" ревизията — T-15 pre-shuffle е премахнат,
 * shuffle-ът вече е inline вътре в startTournamentAtomicallyLocal (§12 в
 * task spec-а):
 *  [1] normal (shuffle_enabled=0) tournament поведение остава напълно
 *      непроменено (auto-pair при join, backward-compatible default).
 *  [2] scheduled shuffle tournament: до T-0 остава individual entrants (без
 *      pre-pairing) дори близо до scheduled_start_at.
 *  [3] пълен scheduled shuffle tournament при T-0: startTournamentAtomically
 *      shuffle-ва + locks teams + стартира в ЕДНА атомарна операция.
 *  [4] underfilled scheduled shuffle tournament при T-0: НЕ се разбърква,
 *      пада в съществуващия auto-cancel/refund flow (SCHEDULED_START_NOT_READY).
 *  [5] start-when-full shuffle продължава да работи (shuffle+lock+start,
 *      вече синхронно вътре в самия join, не отделна стъпка).
 *  [6] shuffle-ът никога не се изпълнява втори път (idempotent).
 *  [7] randomization pairing работи върху резултата от crypto shuffle, не
 *      върху original registration/entrant order — доказано чрез source-level
 *      structural inspection (regex върху production кода на
 *      tournamentEconomyStore.ts), НЕ чрез multi-trial статистика. Никога не
 *      може да fail-не заради конкретен CSPRNG изход в конкретно изпълнение.
 *  [8] след start persisted team assignments не се променят (restart-safe).
 *  [9] finished tournament view използва реалния persisted winning team
 *      (championTeamId -> t.teams member lookup), не entrant order —
 *      "Победител: Отбор <X> — <Играч 1> и <Играч 2>" label формат.
 *  [10] label ordering за финализирани (seed_slot NOT NULL) team-ове следва
 *      persisted seed_slot ASC, НИКОГА team_id/created_at — deterministic
 *      тест (нарочно "обърнати" team_id стойности + идентичен created_at,
 *      симулиращ second-precision collision).
 *  [11] leave-invariant пази roster-а финален след shuffle (kept from prior
 *      revision).
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentStore } from '../src/db/tournamentStore.js'
import { buildTeamDtos } from '../src/tournament/tournamentDto.js'
import type { TournamentEntryRecord, TournamentTeamRecord } from '../src/tournament/tournamentTypes.js'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    console.error(`  FAIL ${label}: ${message}`)
  }
}

const currentFilePath = fileURLToPath(import.meta.url)
const serverRootPath = join(dirname(currentFilePath), '..')
const migrationsDirectoryPath = join(serverRootPath, 'database', 'migrations')
const manualTransactionMarker = '-- MANUAL_TRANSACTION_MIGRATION'

async function loadMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(migrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function applyMigrations(database: DatabaseSync): Promise<void> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec(`
    CREATE TABLE IF NOT EXISTS server_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const getApplied = database.prepare(`SELECT filename FROM server_migrations WHERE filename = ? LIMIT 1;`)
  const insertApplied = database.prepare(`INSERT INTO server_migrations (filename) VALUES (?);`)
  for (const filename of await loadMigrationFileNames()) {
    if (getApplied.get(filename) !== undefined) continue
    const sql = (await readFile(join(migrationsDirectoryPath, filename), 'utf8')).trim()
    if (sql.length === 0) continue
    if (sql.startsWith(manualTransactionMarker)) {
      database.exec(sql)
      continue
    }
    database.exec('BEGIN;')
    try {
      database.exec(sql)
      insertApplied.run(filename)
      database.exec('COMMIT;')
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      throw new Error(`Failed to apply migration ${filename}: ${String(error)}`)
    }
  }
}

function insertProfile(database: DatabaseSync, profileId: string, name: string, balance: number): void {
  database.prepare(`
    INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind, status)
    VALUES (?, ?, ?, ?, 'human', 'active');
  `).run(profileId, profileId, name, name.toLowerCase())
  database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, ?);
  `).run(profileId, balance)
}

type TeamRow = { team_id: string; status: string; seed_slot: number | null }
type EntryRow = { entry_id: string; profile_id: string; team_id: string | null; joined_as: string; status: string }

function getTeamsForTournament(database: DatabaseSync, tournamentId: string): TeamRow[] {
  return database.prepare(`
    SELECT team_id, status, seed_slot FROM tournament_teams WHERE tournament_id = ? ORDER BY created_at ASC;
  `).all(tournamentId) as TeamRow[]
}

function getEntry(database: DatabaseSync, tournamentId: string, profileId: string): EntryRow | undefined {
  return database.prepare(`
    SELECT entry_id, profile_id, team_id, joined_as, status
    FROM tournament_entries WHERE tournament_id = ? AND profile_id = ?;
  `).get(tournamentId, profileId) as EntryRow | undefined
}

function teamMembersKey(database: DatabaseSync, teamId: string): string {
  return (database.prepare(`SELECT profile_id FROM tournament_entries WHERE team_id = ? ORDER BY profile_id ASC;`).all(teamId) as { profile_id: string }[])
    .map((r) => r.profile_id)
    .join(',')
}

console.log('\ncheckTournamentShuffleMode')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-shuffle-mode-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null
let tournamentStore: Awaited<ReturnType<typeof createTournamentStore>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)

  const profiles = Array.from({ length: 100 }, () => randomUUID())
  profiles.forEach((profileId, index) => insertProfile(db as DatabaseSync, profileId, `Player ${index + 1}`, 1_000_000))
  let nextProfileIndex = 0
  function allocProfiles(count: number): string[] {
    if (nextProfileIndex + count > profiles.length) {
      throw new Error(`profile pool exhausted: need ${count} more, only ${profiles.length - nextProfileIndex} left`)
    }
    const slice = profiles.slice(nextProfileIndex, nextProfileIndex + count) as string[]
    nextProfileIndex += count
    return slice
  }

  economyStore = await createTournamentEconomyStore(dbPath)
  tournamentStore = await createTournamentStore(dbPath)
  const store = tournamentStore

  function createTournament(opts: {
    playerCapacity: number
    creatorProfileId: string
    name: string
    shuffleEnabled?: boolean
    startMode?: 'fill' | 'scheduled'
    scheduledStartAt?: string
  }): string {
    const result = store.createTournament({
      name: opts.name,
      creatorProfileId: opts.creatorProfileId,
      visibility: 'public',
      entryFee: 5_000,
      startMode: opts.startMode ?? 'fill',
      playerCapacity: opts.playerCapacity,
      scheduledStartAt: opts.scheduledStartAt ?? null,
      shuffleEnabled: opts.shuffleEnabled ?? false,
    })
    if (!result.ok) throw new Error(`seed tournament creation failed: ${result.reason}`)
    return result.tournament.tournamentId
  }

  // ── [1] Normal (non-shuffle) tournament: unchanged auto-pair behavior ──
  await check('[1] normal tournament (shuffle_enabled=0) keeps existing auto-pair-at-join behavior', () => {
    const [creator, a, b] = allocProfiles(3)
    const tournamentId = createTournament({ playerCapacity: 8, creatorProfileId: creator, name: 'Normal' })
    const joinA = economyStore!.joinTournamentSoloAtomically(tournamentId, a)
    if (!joinA.ok) throw new Error('join A failed')
    const joinB = economyStore!.joinTournamentSoloAtomically(tournamentId, b)
    assert(joinB.ok, `join B failed: ${JSON.stringify(joinB)}`)
    if (!joinB.ok) return
    assert(joinA.entry.teamId === joinB.entry.teamId, 'A and B should auto-pair onto the same team (unchanged behavior)')
    const team = getTeamsForTournament(db!, tournamentId).find((t) => t.team_id === joinB.entry.teamId)
    assert(team !== undefined && team.status === 'complete', 'team should be complete immediately after auto-pair')
    assert(joinB.autoPairedWithProfileId === a, 'B should report auto-pairing with A')
  })

  // ── [2] Scheduled shuffle tournament: individual entrants remain
  // unpaired all the way up to (but not including) T-0 — no T-15 pre-shuffle. ──
  let scheduledTournamentId = ''
  const scheduledProfiles: string[] = []
  let scheduledStartAtIso = ''
  await check('[2] scheduled shuffle tournament: NO pre-shuffle before T-0, even seconds before scheduled_start_at', () => {
    const [creator] = allocProfiles(1)
    // Lead time only needs to satisfy the create-time validation floor (30
    // min in the real HTTP endpoint) — the store layer itself doesn't
    // enforce that, so a short lead time is fine here and lets the test
    // simulate "T-0 has arrived" without waiting.
    scheduledStartAtIso = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    scheduledTournamentId = createTournament({
      playerCapacity: 8,
      creatorProfileId: creator,
      name: 'Shuffle Scheduled',
      shuffleEnabled: true,
      startMode: 'scheduled',
      scheduledStartAt: scheduledStartAtIso,
    })
    const joiners = allocProfiles(8)
    scheduledProfiles.push(...joiners)
    for (const profileId of joiners) {
      const result = economyStore!.joinTournamentSoloAtomically(scheduledTournamentId, profileId)
      assert(result.ok, `join failed: ${JSON.stringify(result)}`)
    }
    const teams = getTeamsForTournament(db!, scheduledTournamentId)
    assert(teams.length === 8, `expected 8 individual 1-member teams, got ${teams.length}`)
    assert(teams.every((t) => t.status === 'forming'), 'every entrant should stay an individual forming team, no matter how close to T-0')
    for (const team of teams) {
      const memberCount = (db!.prepare(`SELECT COUNT(*) as count FROM tournament_entries WHERE team_id = ? AND status = 'confirmed';`).get(team.team_id) as { count: number }).count
      assert(memberCount === 1, `each pre-T-0 team should have exactly 1 member, got ${memberCount}`)
    }
    const tournament = store.getTournamentById(scheduledTournamentId)
    assert(tournament !== null && tournament.teamsShuffledAt === null, 'teams_shuffled_at must remain NULL right up until T-0')

    // Simulate "we're now 1 second before scheduled_start_at, still not
    // there yet" by driving startTournamentAtomically with a `now` still
    // BEFORE scheduled_start_at — startTournamentAtomically itself doesn't
    // gate on scheduled_start_at (that's the scheduler's due-queue job), so
    // this specifically proves NOTHING auto-shuffles on its own before an
    // explicit start attempt fires.
    const teamsStillUnshuffled = getTeamsForTournament(db!, scheduledTournamentId)
    assert(teamsStillUnshuffled.every((t) => t.status === 'forming'), 'still no pre-shuffle without an explicit start attempt')
  })

  // ── [3] Full scheduled shuffle tournament at T-0: shuffle + lock + start atomically ──
  await check('[3] full scheduled shuffle tournament at T-0: startTournamentAtomically shuffles, locks teams, and starts in one atomic call', () => {
    const startResult = economyStore!.startTournamentAtomically(scheduledTournamentId, new Date(scheduledStartAtIso))
    assert(startResult.ok, `start failed: ${JSON.stringify(startResult)}`)
    if (!startResult.ok) return
    assert(startResult.startedTeams.length === 4, `expected 4 locked teams, got ${startResult.startedTeams.length}`)
    assert(startResult.startedTeams.every((t) => t.status === 'locked'), 'every started team must be locked')
    assert(new Set(startResult.startedTeams.map((t) => t.seedSlot)).size === 4, 'every team should have a distinct seed slot')

    const tournament = store.getTournamentById(scheduledTournamentId)
    assert(tournament !== null && tournament.teamsShuffledAt !== null, 'teams_shuffled_at must be set as part of the same start call')
    assert(tournament.status === 'starting', `tournament should be 'starting', got ${tournament!.status}`)

    for (const profileId of scheduledProfiles) {
      const entry = getEntry(db!, scheduledTournamentId, profileId)
      assert(entry !== undefined && entry.team_id !== null, 'every entrant must now belong to a real 2-member locked team')
    }
    const matches = db!.prepare(`SELECT COUNT(*) as count FROM tournament_matches WHERE tournament_id = ?;`).get(scheduledTournamentId) as { count: number }
    assert(matches.count === 2, `expected 2 first-round matches (4 teams), got ${matches.count}`)
  })

  // ── [4] Underfilled scheduled shuffle tournament at T-0: no shuffle, existing cancel/refund flow ──
  await check('[4] underfilled scheduled shuffle tournament at T-0: NOT shuffled, falls into the existing auto-cancel/refund flow', () => {
    const [creator, a, b, c] = allocProfiles(4)
    const scheduledAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    const tid = createTournament({
      playerCapacity: 8,
      creatorProfileId: creator,
      name: 'Shuffle Scheduled Underfilled',
      shuffleEnabled: true,
      startMode: 'scheduled',
      scheduledStartAt: scheduledAt,
    })
    for (const profileId of [a, b, c]) {
      const r = economyStore!.joinTournamentSoloAtomically(tid, profileId)
      if (!r.ok) throw new Error(`seed join failed: ${JSON.stringify(r)}`)
    }
    const balancesBefore = new Map([a, b, c].map((p) => [p, (db!.prepare(`SELECT yellow_coins_balance as balance FROM profile_wallets WHERE profile_id = ?;`).get(p) as { balance: number }).balance]))

    // T-0 arrives, tournament is only 3/8 -> startTournamentAtomically must
    // refuse WITHOUT touching teams (no shuffle for an incomplete roster).
    const startResult = economyStore!.startTournamentAtomically(tid, new Date(scheduledAt))
    assert(!startResult.ok, `expected start to fail for an underfilled tournament, got ${JSON.stringify(startResult)}`)
    if (!startResult.ok) {
      assert(startResult.reason === 'not_ready', `expected not_ready, got ${startResult.reason}`)
    }
    const teamsAfterFailedStart = getTeamsForTournament(db!, tid)
    assert(teamsAfterFailedStart.every((t) => t.status === 'forming'), 'no team may be locked when the start attempt was refused for being underfilled')
    const tournamentAfterFailedStart = store.getTournamentById(tid)
    assert(tournamentAfterFailedStart !== null && tournamentAfterFailedStart.teamsShuffledAt === null, 'teams_shuffled_at must remain NULL — no shuffle happened')
    assert(tournamentAfterFailedStart.status === 'open', 'tournament must remain open (not_ready does not transition status)')

    // Existing scheduled-underfilled cancel/refund flow — same one used by
    // non-shuffle tournaments, completely unmodified by shuffle mode.
    const cancelResult = economyStore!.autoCancelScheduledTournamentAtomically(tid, new Date(scheduledAt), 'scheduled_start_not_ready')
    assert(cancelResult.ok, `cancel failed: ${JSON.stringify(cancelResult)}`)
    if (!cancelResult.ok) return
    assert(cancelResult.refundedProfiles.length === 3, `expected all 3 confirmed entrants refunded, got ${cancelResult.refundedProfiles.length}`)
    for (const profileId of [a, b, c]) {
      const balanceAfter = (db!.prepare(`SELECT yellow_coins_balance as balance FROM profile_wallets WHERE profile_id = ?;`).get(profileId) as { balance: number }).balance
      assert(balanceAfter === balancesBefore.get(profileId)! + 5_000, `${profileId} should be fully refunded`)
    }
    const tournamentAfterCancel = store.getTournamentById(tid)
    assert(tournamentAfterCancel !== null && tournamentAfterCancel.status === 'auto_cancelled', 'tournament should be auto_cancelled')
  })

  // ── [5] Start-when-full shuffle still works (shuffle+lock+start, synchronous with the filling join) ──
  let fillTournamentId = ''
  await check('[5] shuffle fill-mode tournament: last participant\'s join synchronously shuffles + locks + starts the tournament', () => {
    const [creator] = allocProfiles(1)
    fillTournamentId = createTournament({
      playerCapacity: 8,
      creatorProfileId: creator,
      name: 'Shuffle Fill',
      shuffleEnabled: true,
      startMode: 'fill',
    })
    const joiners = allocProfiles(8)
    for (let i = 0; i < joiners.length; i += 1) {
      const result = economyStore!.joinTournamentSoloAtomically(fillTournamentId, joiners[i] as string)
      assert(result.ok, `join ${i} failed: ${JSON.stringify(result)}`)
      const teams = getTeamsForTournament(db!, fillTournamentId)
      if (i < joiners.length - 1) {
        assert(teams.every((t) => t.status === 'forming'), `before capacity is reached, teams should stay individual/forming (join ${i})`)
      } else {
        assert(teams.length === 4, `expected 4 locked teams immediately after the filling join, got ${teams.length}`)
        assert(teams.every((t) => t.status === 'locked'), 'teams should already be locked right after the filling join')
      }
    }
    const tournament = store.getTournamentById(fillTournamentId)
    assert(tournament !== null && tournament.teamsShuffledAt !== null, 'teamsShuffledAt should be set synchronously with the filling join')
    assert(tournament.status === 'starting', `tournament should already be 'starting', got ${tournament!.status}`)
  })

  // ── [6] Shuffle executes exactly once (idempotent) — repeated start/shuffle attempts are no-ops ──
  await check('[6] shuffle never runs twice: repeated start attempts do not change team composition', () => {
    const teamsBefore = getTeamsForTournament(db!, scheduledTournamentId)
    const membersBefore = new Map(teamsBefore.map((t) => [t.team_id, teamMembersKey(db!, t.team_id)]))

    // scheduledTournamentId already started (status='starting') — a repeat
    // start attempt must be idempotent (already-started success), never a
    // second shuffle.
    const repeat = economyStore!.startTournamentAtomically(scheduledTournamentId, new Date())
    assert(repeat.ok && repeat.alreadyStarted, `expected an idempotent already-started result, got ${JSON.stringify(repeat)}`)
    const teamsAfter = getTeamsForTournament(db!, scheduledTournamentId)
    for (const team of teamsAfter) {
      assert(membersBefore.get(team.team_id) === teamMembersKey(db!, team.team_id), 'team composition must be unchanged after a repeat start attempt')
    }

    // Also prove idempotency via the standalone shuffleTournamentEntrantsAtomically
    // helper against the already-shuffled fill tournament from [5].
    const manualShuffle = economyStore!.shuffleTournamentEntrantsAtomically(fillTournamentId, new Date())
    assert(manualShuffle.ok && manualShuffle.alreadyShuffled, `expected alreadyShuffled no-op, got ${JSON.stringify(manualShuffle)}`)
  })

  // ── [7] Randomness: deterministic STRUCTURAL proof, not a probabilistic
  // multi-trial test. A statistical "run N trials and hope X+Y aren't always
  // paired" test can flake purely because a CSPRNG happened to produce a
  // particular outcome — this instead inspects the actual production source
  // of tournamentEconomyStore.ts to prove the code-path invariant directly:
  // original (created_at-ordered) entries -> a COPY -> shuffleInPlace
  // (crypto Fisher-Yates) mutates the COPY -> pairing reads from the
  // shuffled copy, never from the original array. This can never fail due
  // to which particular permutation the CSPRNG happens to produce on a
  // given run — it fails only if the source code itself stops matching that
  // structure (e.g. someone "optimizes" it back to pairing entries[i]/
  // entries[i+1] directly). ──
  await check('[7] randomization pairing is a deterministic structural invariant of the source (copy -> crypto Fisher-Yates -> pair the copy), not original registration order', () => {
    const economyStoreSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'tournamentEconomyStore.ts'),
      'utf8',
    )

    // (a) shuffleInPlace itself is a crypto-secure, unbiased Fisher-Yates:
    // node:crypto randomInt (never Math.random, never a hardcoded/derived
    // seed), standard i..1 descending loop with j drawn from the FULL
    // remaining range [0, i] (not a narrower/biased range).
    const shuffleInPlaceMatch = economyStoreSource.match(
      /function shuffleInPlace<T>\(items: T\[\]\): void \{\s*for \(let i = items\.length - 1; i > 0; i -= 1\) \{\s*const j = randomInt\(i \+ 1\)/,
    )
    assert(shuffleInPlaceMatch !== null, 'shuffleInPlace must be a standard descending Fisher-Yates using crypto randomInt(i+1) for the full remaining range')
    assert(!/Math\.random/.test(economyStoreSource), 'tournamentEconomyStore.ts must never use Math.random() for team assignment')
    const randomIntImportMatch = economyStoreSource.match(/import\s*\{[^}]*\brandomInt\b[^}]*\}\s*from\s*'node:crypto'/)
    assert(randomIntImportMatch !== null, 'randomInt must be imported from node:crypto (cryptographically secure), not a userland/deterministic PRNG')

    // (b) performShuffleTeamsInCurrentTransaction — the actual production
    // pairing code path — builds a COPY of the confirmed-entries query
    // result (which is ORDER BY created_at ASC, i.e. original registration
    // order) via spread, shuffles THAT COPY in place, and only then pairs
    // ADJACENT elements of the shuffled copy. It never reads `entries[i]`/
    // `entries[i+1]` directly for pairing.
    // Bounded by the START of the next top-level (2-space indented)
    // `function ` declaration in the same closure — robust against the
    // nested if/for braces inside the function body (a naive lazy
    // "...\n  }\n" match would stop at the FIRST 2-space-indented closing
    // brace it hits, which belongs to an inner if-block, not the function).
    const shuffleFunctionStart = economyStoreSource.indexOf('function performShuffleTeamsInCurrentTransaction(')
    assert(shuffleFunctionStart >= 0, 'performShuffleTeamsInCurrentTransaction not found in source')
    const nextFunctionMatch = economyStoreSource.slice(shuffleFunctionStart + 1).match(/\n  function /)
    assert(nextFunctionMatch !== null && nextFunctionMatch.index !== undefined, 'could not locate the end of performShuffleTeamsInCurrentTransaction (next top-level function declaration)')
    const shuffleFunctionBody = economyStoreSource.slice(
      shuffleFunctionStart,
      shuffleFunctionStart + 1 + nextFunctionMatch!.index!,
    )

    assert(
      /const shuffledEntries = \[\.\.\.entries\]/.test(shuffleFunctionBody),
      'pairing must operate on an explicit COPY of the original (created_at-ordered) entries array, not the original itself',
    )
    assert(
      /shuffleInPlace\(shuffledEntries\)/.test(shuffleFunctionBody),
      'the copy must be passed through shuffleInPlace (crypto Fisher-Yates) before any pairing happens',
    )
    // The copy-then-shuffle line must appear BEFORE the pairing loop that
    // reads shuffledEntries[i]/[i+1] — proves shuffle happens first, pairing
    // second (not pairing computed, then a no-op shuffle for show).
    const copyIndex = shuffleFunctionBody.indexOf('const shuffledEntries = [...entries]')
    const shuffleCallIndex = shuffleFunctionBody.indexOf('shuffleInPlace(shuffledEntries)')
    const pairingIndex = shuffleFunctionBody.indexOf('shuffledEntries[i]')
    assert(copyIndex >= 0 && shuffleCallIndex > copyIndex, 'shuffleInPlace(shuffledEntries) must come after the copy is created')
    assert(pairingIndex > shuffleCallIndex, 'pairing (reading shuffledEntries[i]) must come after shuffleInPlace has already run')

    // Pairing reads exclusively from the shuffled copy — the original
    // `entries` identifier must never be indexed for pairing purposes
    // anywhere after the copy is taken (only used earlier for the
    // length/parity guard and to build previousTeamIds, both order-
    // independent uses).
    assert(!/\bentries\[i\]/.test(shuffleFunctionBody), 'pairing must never index the original (unshuffled, created_at-ordered) entries array')

    // (c) Sanity: the query this function starts from really is ordered by
    // created_at (original registration order) — otherwise "not original
    // order" would be a vacuous claim. selectConfirmedEntriesStatement is
    // the one performShuffleTeamsInCurrentTransaction reads from.
    const selectConfirmedEntriesMatch = economyStoreSource.match(
      /const selectConfirmedEntriesStatement = database\.prepare\(`[\s\S]*?`\)/,
    )
    assert(selectConfirmedEntriesMatch !== null, 'selectConfirmedEntriesStatement not found')
    assert(
      /ORDER BY created_at ASC/.test(selectConfirmedEntriesMatch![0]),
      'sanity: the source entries really are in original registration (created_at) order before the copy+shuffle',
    )
  })

  // ── [8] Persisted team assignments survive a simulated server restart ──
  await check('[8] persisted teams do not change after a simulated restart (fresh store instance over the same DB file)', async () => {
    const teamsBeforeRestart = getTeamsForTournament(db!, scheduledTournamentId)
    const membersBeforeRestart = new Map(teamsBeforeRestart.map((t) => [t.team_id, teamMembersKey(db!, t.team_id)]))

    economyStore!.close()
    economyStore = await createTournamentEconomyStore(dbPath)

    const teamsAfterRestart = getTeamsForTournament(db!, scheduledTournamentId)
    assert(teamsAfterRestart.length === teamsBeforeRestart.length, 'team count must be unchanged after restart')
    for (const team of teamsAfterRestart) {
      assert(membersBeforeRestart.get(team.team_id) === teamMembersKey(db!, team.team_id), `team ${team.team_id} composition changed across restart`)
    }
    const postRestartShuffle = economyStore!.shuffleTournamentEntrantsAtomically(scheduledTournamentId, new Date())
    assert(!postRestartShuffle.ok || postRestartShuffle.alreadyShuffled, 'post-restart shuffle re-check must be a no-op for an already-shuffled tournament')
  })

  // ── [9] Finished tournament view uses the real persisted winning team, not entrant order ──
  await check('[9] finished shuffle tournament: winning team is resolved from persisted championTeamId + locked team members ("Отбор <X> — <P1> и <P2>")', () => {
    // Use the already-shuffled+started scheduled tournament from [2]/[3].
    // Simulate settlement completion by directly persisting championTeamId/
    // runnerUpTeamId (mirrors what settleTournamentPrizesAtomicallyLocal
    // would write after a real final match) — this test targets the DTO/
    // display resolution path, not the full gameplay->settlement pipeline
    // (already covered by checkTournamentSchedulerStart.ts for non-shuffle
    // tournaments).
    const teams = getTeamsForTournament(db!, scheduledTournamentId)
    assert(teams.length === 4, 'sanity: 4 locked teams from [3]')
    const championTeamId = teams[0]!.team_id
    const runnerUpTeamId = teams[1]!.team_id

    db!.prepare(`
      UPDATE tournaments
      SET status = 'finished', champion_team_id = ?, runner_up_team_id = ?,
          settlement_state = 'settled', settled_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP
      WHERE tournament_id = ?;
    `).run(championTeamId, runnerUpTeamId, scheduledTournamentId)

    const tournament = store.getTournamentById(scheduledTournamentId)
    assert(tournament !== null && tournament.championTeamId === championTeamId, 'championTeamId must be the real persisted locked team, not derived from entrant order')

    // Build the same DTO shape the client renders from (buildTeamDtos ->
    // TournamentTeamDto[]), then reproduce the client's positional label
    // mapping (buildTournamentTeamLabelMap in renderTournamentsScreen.ts:
    // letter = index in the stable, persisted team list order) to prove the
    // "Отбор <X> — <P1> и <P2>" string is built from persisted data only.
    const teamRecords: TournamentTeamRecord[] = store.getTeamsForTournament(scheduledTournamentId)
    const entryRecords: TournamentEntryRecord[] = store.getEntriesForTournament(scheduledTournamentId)
    const profileNames = new Map(scheduledProfiles.map((p, i) => [p, `Player ${i + 1}`]))
    const teamDtos = buildTeamDtos({
      teams: teamRecords,
      entries: entryRecords,
      getPublicProfile: (profileId) => ({ profileId, displayName: profileNames.get(profileId) ?? 'Играч', avatarUrl: null }),
    })

    const letters = ['A', 'B', 'C', 'D']
    const labelMap = new Map(teamDtos.map((team, index) => [team.teamId, `Отбор ${letters[index]}`]))
    const championDto = teamDtos.find((t) => t.teamId === championTeamId)
    assert(championDto !== undefined, 'champion team DTO must exist')
    assert(championDto!.members.length === 2, 'champion team must have exactly 2 persisted members')
    const label = labelMap.get(championTeamId)
    const winnerLine = `Победител: ${label} — ${championDto!.members.map((m) => m.displayName).join(' и ')}`
    assert(/^Победител: Отбор [A-D] — .+ и .+$/.test(winnerLine), `winner line did not match expected format: ${winnerLine}`)

    // The winning team's members must be EXACTLY the two profiles actually
    // persisted on that team_id — never reconstructed from scheduledProfiles
    // registration order.
    const actualMemberIds = new Set(
      (db!.prepare(`SELECT profile_id FROM tournament_entries WHERE team_id = ?;`).all(championTeamId) as { profile_id: string }[]).map((r) => r.profile_id),
    )
    const dtoMemberIds = new Set(championDto!.members.map((m) => m.profileId))
    assert(actualMemberIds.size === 2 && dtoMemberIds.size === 2, 'sanity: exactly 2 members on each side')
    for (const id of actualMemberIds) assert(dtoMemberIds.has(id), 'DTO members must match persisted tournament_entries exactly')
  })

  // ── [10] Team label ordering is deterministic on persisted seed_slot ASC,
  // NEVER on team_id/created_at — deliberately deterministic (no randomness
  // involved). Seeds 4 locked team rows with team_id values in the EXACT
  // OPPOSITE lexicographic order from their seed_slot (seed_slot 1 gets the
  // "largest" UUID, seed_slot 4 gets the "smallest"), all sharing an
  // IDENTICAL created_at timestamp (simulating the real-world SQLite
  // CURRENT_TIMESTAMP second-precision collision this guards against — every
  // team INSERT inside one shuffle transaction can land in the very same
  // second). If ordering ever fell back to created_at/team_id (as it did
  // before the ORDER BY fix), this would produce the REVERSED label order;
  // with the fix, store.getTeamsForTournament must return seed_slot 1..4 in
  // order regardless. ──
  await check('[10] store.getTeamsForTournament orders finalized teams by persisted seed_slot ASC, never by team_id/created_at (deterministic, no randomness)', () => {
    const [creator] = allocProfiles(1)
    const tid = createTournament({ playerCapacity: 8, creatorProfileId: creator, name: 'Seed Slot Ordering', shuffleEnabled: true, startMode: 'fill' })

    // team_id values deliberately chosen so that plain lexicographic
    // (team_id ASC) order is the EXACT REVERSE of the intended seed_slot
    // order — if the fix regressed, this test would see teams 4,3,2,1
    // instead of 1,2,3,4.
    const seedToTeamId: Record<number, string> = {
      1: 'zzzz-seed-slot-team-1',
      2: 'yyyy-seed-slot-team-2',
      3: 'xxxx-seed-slot-team-3',
      4: 'wwww-seed-slot-team-4',
    }
    const sharedCreatedAt = '2026-01-01 12:00:00' // identical for all 4 rows — simulates a second-precision collision
    for (const [seedSlotStr, teamId] of Object.entries(seedToTeamId)) {
      db!.prepare(`
        INSERT INTO tournament_teams (team_id, tournament_id, status, seed_slot, created_at, updated_at)
        VALUES (?, ?, 'locked', ?, ?, ?);
      `).run(teamId, tid, Number(seedSlotStr), sharedCreatedAt, sharedCreatedAt)
    }

    const teams = store.getTeamsForTournament(tid)
    assert(teams.length === 4, `expected exactly the 4 manually-seeded teams, got ${teams.length}`)
    const orderedSeedSlots = teams.map((t) => t.seedSlot)
    assert(
      JSON.stringify(orderedSeedSlots) === JSON.stringify([1, 2, 3, 4]),
      `expected teams ordered by seed_slot ASC (1,2,3,4), got ${JSON.stringify(orderedSeedSlots)} — ordering fell back to team_id/created_at`,
    )
    const orderedTeamIds = teams.map((t) => t.teamId)
    assert(
      JSON.stringify(orderedTeamIds) === JSON.stringify(['zzzz-seed-slot-team-1', 'yyyy-seed-slot-team-2', 'xxxx-seed-slot-team-3', 'wwww-seed-slot-team-4']),
      `team_id order must follow seed_slot (1->2->3->4), NOT lexicographic team_id order, got ${JSON.stringify(orderedTeamIds)}`,
    )

    // The resulting label map (reproducing buildTournamentTeamLabelMap's
    // positional index-based mapping) must therefore assign:
    // seed_slot 1 -> Отбор A, seed_slot 2 -> Отбор Б, seed_slot 3 -> Отбор В,
    // seed_slot 4 -> Отбор Г — independent of team_id/created_at.
    const letters = ['A', 'B', 'C', 'D']
    const labelBySeedSlot = new Map(teams.map((t, index) => [t.seedSlot, `Отбор ${letters[index]}`]))
    assert(labelBySeedSlot.get(1) === 'Отбор A', 'seed_slot 1 must map to Отбор A')
    assert(labelBySeedSlot.get(2) === 'Отбор B', 'seed_slot 2 must map to Отбор B')
    assert(labelBySeedSlot.get(3) === 'Отбор C', 'seed_slot 3 must map to Отбор C')
    assert(labelBySeedSlot.get(4) === 'Отбор D', 'seed_slot 4 must map to Отбор D')

    // Sanity: same guarantee holds for the tournamentEconomyStore.ts copy of
    // this statement (kept in sync — see the comment there).
    const economyOrderedSeedSlots = (
      db!.prepare(`
        SELECT seed_slot FROM tournament_teams WHERE tournament_id = ?
        ORDER BY CASE WHEN seed_slot IS NOT NULL THEN 0 ELSE 1 END ASC, seed_slot ASC, created_at ASC;
      `).all(tid) as { seed_slot: number }[]
    ).map((r) => r.seed_slot)
    assert(JSON.stringify(economyOrderedSeedSlots) === JSON.stringify([1, 2, 3, 4]), 'the economy-store-side ORDER BY must produce the same seed_slot ASC order')
  })

  // ── Post-shuffle leave invariant (kept from the prior revision): a player
  // leaving after shuffle dissolves the whole pair, never strands a
  // 1-member forming team, and never lets a newcomer silently join.
  //
  // NOTE: with shuffle+start now unified into one atomic operation (§3 in
  // the "scheduled shuffle timing" task spec), there is no longer a normal
  // API-reachable window where a tournament is simultaneously
  // teams_shuffled_at!==null AND status==='open' — start-when-full shuffles
  // AND starts synchronously in the same join call, and scheduled shuffle
  // only happens at T-0 as part of the same start transaction. This test
  // therefore directly persists teams_shuffled_at (mirroring what any future
  // code path that separates shuffle from start would produce) to prove the
  // leave-time guard itself still holds for that state, independent of
  // whether today's flow can currently reach it via the public API. ──
  await check('[11] leaving while teams_shuffled_at is set (tournament still open) dissolves the whole pair, no stranded team, no backfill', () => {
    const liveEconomy = economyStore!
    const [creator] = allocProfiles(1)
    const tid = createTournament({
      playerCapacity: 8,
      creatorProfileId: creator,
      name: 'Shuffle Leave While Still Open',
      shuffleEnabled: true,
      startMode: 'scheduled',
      scheduledStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    const joiners = allocProfiles(8)
    for (const profileId of joiners) {
      const r = liveEconomy.joinTournamentSoloAtomically(tid, profileId)
      if (!r.ok) throw new Error(`seed join failed: ${JSON.stringify(r)}`)
    }
    // Still 'open' and unshuffled (scheduled mode only shuffles at T-0).
    const preShuffleTournament = store.getTournamentById(tid)
    assert(preShuffleTournament !== null && preShuffleTournament.status === 'open' && preShuffleTournament.teamsShuffledAt === null, 'sanity: still open, not yet shuffled')

    // Directly persist the shuffle result while keeping status='open' —
    // simulates the invariant-relevant state (teams_shuffled_at set, roster
    // final) independent of which code path produced it.
    const manualShuffle = liveEconomy.shuffleTournamentEntrantsAtomically(tid, new Date())
    assert(manualShuffle.ok && !manualShuffle.alreadyShuffled, `expected a fresh manual shuffle, got ${JSON.stringify(manualShuffle)}`)
    const postShuffleTournament = store.getTournamentById(tid)
    assert(postShuffleTournament !== null && postShuffleTournament.status === 'open' && postShuffleTournament.teamsShuffledAt !== null, 'sanity: shuffled but still open (shuffleTournamentEntrantsAtomically never touches status)')

    const teamsAfterShuffle = getTeamsForTournament(db!, tid)
    assert(teamsAfterShuffle.length === 4 && teamsAfterShuffle.every((t) => t.status === 'locked'), 'sanity: 4 locked teams after shuffle')
    const leaver = joiners[0] as string
    const leaverTeamId = getEntry(db!, tid, leaver)!.team_id as string
    const teammateEntry = (db!.prepare(`SELECT profile_id FROM tournament_entries WHERE team_id = ? AND profile_id <> ? AND status = 'confirmed';`).get(leaverTeamId, leaver) as { profile_id: string }).profile_id

    const leave = liveEconomy.leaveTournamentAndRefundAtomically(tid, leaver)
    assert(leave.ok, `leave failed: ${JSON.stringify(leave)}`)

    const teammateAfter = getEntry(db!, tid, teammateEntry)!
    assert(teammateAfter.status === 'refunded', `teammate must be auto-refunded (full pair dissolves post-shuffle), got status=${teammateAfter.status}`)
    assert(db!.prepare(`SELECT team_id FROM tournament_teams WHERE team_id = ?;`).get(leaverTeamId) === undefined, 'the dissolved team row must be deleted, not demoted to forming')

    const remainingTeams = getTeamsForTournament(db!, tid)
    for (const team of remainingTeams) {
      if (team.status !== 'forming') continue
      const memberCount = (db!.prepare(`SELECT COUNT(*) as count FROM tournament_entries WHERE team_id = ? AND status = 'confirmed';`).get(team.team_id) as { count: number }).count
      assert(memberCount !== 1, `found a stranded 1-member forming team (${team.team_id}) in an already-shuffled tournament`)
    }

    const [newcomer] = allocProfiles(1)
    const newcomerJoin = liveEconomy.joinTournamentSoloAtomically(tid, newcomer)
    assert(!newcomerJoin.ok, `newcomer join must be rejected on an already-shuffled tournament, got ${JSON.stringify(newcomerJoin)}`)
    if (!newcomerJoin.ok) {
      assert(newcomerJoin.reason === 'shuffle_already_completed', `expected shuffle_already_completed, got ${newcomerJoin.reason}`)
    }
  })

  // ── Integrity ──
  await check('[integrity] foreign_key_check is clean', () => {
    const fkCheck = db!.prepare('PRAGMA foreign_key_check;').all()
    assert(fkCheck.length === 0, `foreign key violations: ${JSON.stringify(fkCheck)}`)
  })
  await check('[integrity] integrity_check is ok', () => {
    const integrityCheck = db!.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }
    assert(integrityCheck.integrity_check === 'ok', `integrity_check: ${integrityCheck.integrity_check}`)
  })
} finally {
  try { economyStore?.close() } catch {}
  try { tournamentStore?.close() } catch {}
  try { db?.close() } catch {}
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\ncheckTournamentShuffleMode failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckTournamentShuffleMode passed: ${passed} checks`)
