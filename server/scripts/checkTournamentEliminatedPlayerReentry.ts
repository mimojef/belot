// Регресионни тестове: отпаднал играч / загубил финала / Свара / съобщения
// при покани / ред на проверките при покана.
//
// Само временна база (mkdtemp) — не пипа основната локална или production
// база. Времето е фиксирано (NOW), турнирите са fill mode без срок, за да не
// зависят проверките от реалния час.
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentCoordinator } from '../src/tournament/tournamentCoordinator.js'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import { createSvaraMatchRuntime } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import type { SvaraAccessSession } from '../src/games/svara/svaraAccess.js'
import type { ServerRoom } from '../src/core/serverTypes.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, details = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label}${details ? `: ${details}` : ''}`)
  }
}

const currentFilePath = fileURLToPath(import.meta.url)
const serverRootPath = join(dirname(currentFilePath), '..')
const migrationsDirectoryPath = join(serverRootPath, 'database', 'migrations')
const manualTransactionMarker = '-- MANUAL_TRANSACTION_MIGRATION'

async function applyMigrations(database: DatabaseSync): Promise<void> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec(`
    CREATE TABLE IF NOT EXISTS server_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const entries = await readdir(migrationsDirectoryPath, { withFileTypes: true })
  const fileNames = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
  const insertApplied = database.prepare(`INSERT OR IGNORE INTO server_migrations (filename) VALUES (?);`)
  for (const filename of fileNames) {
    const sql = (await readFile(join(migrationsDirectoryPath, filename), 'utf8')).trim()
    if (sql.length === 0) continue
    if (sql.startsWith(manualTransactionMarker)) {
      database.exec(sql)
      insertApplied.run(filename)
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

const NOW = new Date('2026-11-09T17:48:00.000Z')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-eliminated-reentry-'))
const dbPath = join(tempDir, 'server.db')
const database = new DatabaseSync(dbPath)
await applyMigrations(database)

function insertProfile(profileId: string): void {
  database.prepare(`
    INSERT OR IGNORE INTO accounts (account_id, email, password_hash, role, status)
    VALUES (?, ?, 'hash', 'player', 'active');
  `).run(profileId, `${profileId}@example.test`)
  database.prepare(`
    INSERT OR IGNORE INTO profiles (
      profile_id, account_id, display_name, normalized_display_name, profile_kind, status
    ) VALUES (?, ?, ?, ?, 'human', 'active');
  `).run(profileId, profileId, profileId, profileId.toLowerCase())
  database.prepare(`
    INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, 1000000);
  `).run(profileId)
}

function insertTournament(tournamentId: string, status: string): void {
  const creatorProfileId = `creator-${tournamentId}`
  insertProfile(creatorProfileId)
  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, status,
      started_at, finished_at
    ) VALUES (?, 'community', ?, ?, 'public', NULL, 5000, 8, 'fill', NULL, ?,
      CASE WHEN ? = 'open' THEN NULL ELSE CURRENT_TIMESTAMP END,
      CASE WHEN ? IN ('finished', 'cancelled', 'admin_cancelled', 'auto_cancelled', 'failed')
        THEN CURRENT_TIMESTAMP ELSE NULL END
    );
  `).run(tournamentId, `Reentry ${tournamentId}`, creatorProfileId, status, status, status)
}

function insertEntry(tournamentId: string, profileId: string, status: string, createdAt?: string): void {
  insertProfile(profileId)
  database.prepare(`
    INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status, created_at)
    VALUES (?, ?, ?, NULL, 'solo', ?, COALESCE(?, CURRENT_TIMESTAMP));
  `).run(randomUUID(), tournamentId, profileId, status, createdAt ?? null)
}

function setTournamentStatus(tournamentId: string, status: string): void {
  database.prepare(`UPDATE tournaments SET status = ? WHERE tournament_id = ?;`).run(status, tournamentId)
}

function setEntryStatus(tournamentId: string, profileId: string, status: string): void {
  database.prepare(`UPDATE tournament_entries SET status = ? WHERE tournament_id = ? AND profile_id = ?;`)
    .run(status, tournamentId, profileId)
}

function walletBalance(profileId: string): number {
  return (database.prepare(`SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?;`)
    .get(profileId) as { b: number }).b
}

function countEntries(tournamentId: string, profileId: string): number {
  return (database.prepare(`
    SELECT COUNT(*) AS count FROM tournament_entries WHERE tournament_id = ? AND profile_id = ?;
  `).get(tournamentId, profileId) as { count: number }).count
}

function fillWithSoloEntries(tournamentId: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    insertEntry(tournamentId, `${tournamentId}-filler-${index}`, 'confirmed')
  }
}

const economyStore = await createTournamentEconomyStore(dbPath)
const rooms = new Map<string, ServerRoom>()
const coordinator = await createTournamentCoordinator({
  databaseFilePath: dbPath,
  getPublicProfile: () => null,
  getRoom: (roomId) => rooms.get(roomId) ?? null,
  commitRoom: (room) => { rooms.set(room.id, room) },
  closeCompletedRoom: (room) => { rooms.delete(room.id) },
  ensureRoomRuntime: () => ({ ok: true }),
  settleTournamentPrizes: () => ({ ok: true }),
  notifyAssignment: () => {},
  notifyFeederMatchCompleted: () => {},
  notifyFeederScoreProgress: () => {},
  isConnectionAttached: () => false,
  isProfileOnline: () => false,
  intervalMs: 60_000,
})

const indexSource = await readFile(join(serverRootPath, 'src', 'index.ts'), 'utf8')
const partnerMessagesBody = indexSource.match(/const PARTNER_INVITE_FAILURE_MESSAGES[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? ''
function partnerMessage(reason: string): string | null {
  const match = partnerMessagesBody.match(new RegExp(`\\b${reason}\\s*:\\s*'([^']*)'`))
  return match?.[1] ?? null
}

try {
  console.log('\n[1] getActiveTournamentIdForProfile — статус на записа И на турнира')
  {
    const cases: Array<{ label: string; tStatus: string; eStatus: string; expectActive: boolean }> = [
      { label: 'confirmed, полуфинал тече → активен', tStatus: 'semifinal_in_progress', eStatus: 'confirmed', expectActive: true },
      { label: 'eliminated, полуфинал тече → НЕ е активен', tStatus: 'semifinal_in_progress', eStatus: 'eliminated', expectActive: false },
      { label: 'eliminated, финал тече → НЕ е активен', tStatus: 'final_in_progress', eStatus: 'eliminated', expectActive: false },
      { label: 'finalist, финал тече → активен', tStatus: 'final_in_progress', eStatus: 'finalist', expectActive: true },
      { label: 'finalist (загубил финала), турнирът е finished → НЕ е активен', tStatus: 'finished', eStatus: 'finalist', expectActive: false },
      { label: 'champion, finished → НЕ е активен', tStatus: 'finished', eStatus: 'champion', expectActive: false },
      { label: 'confirmed, auto_cancelled → НЕ е активен', tStatus: 'auto_cancelled', eStatus: 'confirmed', expectActive: false },
      { label: 'confirmed, failed → НЕ е активен', tStatus: 'failed', eStatus: 'confirmed', expectActive: false },
      { label: 'confirmed, open (регистрация) → активен (без промяна)', tStatus: 'open', eStatus: 'confirmed', expectActive: true },
    ]
    cases.forEach((testCase, index) => {
      const tournamentId = `act-${index}`
      const profileId = `act-p-${index}`
      insertTournament(tournamentId, testCase.tStatus)
      insertEntry(tournamentId, profileId, testCase.eStatus)
      const active = coordinator.getActiveTournamentIdForProfile(profileId)
      check(testCase.label, testCase.expectActive ? active === tournamentId : active === null, `active=${active}`)
    })

    // Стар 'finalist' ред в приключил турнир не засенчва реалното активно участие.
    insertTournament('stale-old', 'finished')
    insertEntry('stale-old', 'stale-p', 'finalist', '2026-01-01 00:00:00')
    insertTournament('stale-new', 'semifinal_in_progress')
    insertEntry('stale-new', 'stale-p', 'confirmed', '2026-11-09 17:00:00')
    check(
      'стар finalist ред (finished) + ново участие → връща новия турнир',
      coordinator.getActiveTournamentIdForProfile('stale-p') === 'stale-new',
    )

    // Започнал турнир има приоритет пред бъдеща 'open' регистрация.
    insertTournament('prio-open', 'open')
    insertEntry('prio-open', 'prio-p', 'confirmed', '2026-11-09 10:00:00')
    insertTournament('prio-running', 'semifinal_in_progress')
    insertEntry('prio-running', 'prio-p', 'confirmed', '2026-11-09 12:00:00')
    check(
      'open регистрация + течащ турнир → връща течащия',
      coordinator.getActiveTournamentIdForProfile('prio-p') === 'prio-running',
    )

    // acknowledgeTournamentBotReplacementReturn ползва същата проверка.
    const finishedAck = coordinator.acknowledgeTournamentBotReplacementReturn('act-4' as never, 'act-p-4' as never)
    check(
      'acknowledge return за загубил финала в приключил турнир → not_active_participant',
      finishedAck.ok === false && finishedAck.reason === 'not_active_participant',
      JSON.stringify(finishedAck),
    )
    const activeAck = coordinator.acknowledgeTournamentBotReplacementReturn('stale-new' as never, 'stale-p' as never)
    check(
      'acknowledge return за активно участие при стар finalist ред → ok',
      activeAck.ok === true,
      JSON.stringify(activeAck),
    )
  }

  console.log('\n[2] Свара — блокиране и освобождаване')
  {
    check(
      'index.ts: hasOtherGameCommitment на Свара ползва getActiveTournamentIdForProfile',
      /hasOtherGameCommitment:[\s\S]{0,400}tournamentCoordinator\.getActiveTournamentIdForProfile\(profileId\) !== null/.test(indexSource),
    )
    check(
      'index.ts: login push tournament_active_participation ползва getActiveTournamentIdForProfile',
      /getActiveTournamentIdForProfile\(connection\.profileId\)[\s\S]{0,300}type: 'tournament_active_participation'/.test(indexSource),
    )

    const previousFlag = process.env.SVARA_TEST_ENABLED
    process.env.SVARA_TEST_ENABLED = '1'
    try {
      const runtime = createSvaraMatchRuntime({ random: { nextInt: () => 0 } })
      const lobby = createSvaraLobby({
        runtime,
        hasOtherGameCommitment: (profileId) => coordinator.getActiveTournamentIdForProfile(profileId) !== null,
      })
      const frames = new Map<string, Array<Record<string, unknown>>>()
      const attach = (profileId: string): void => {
        const session: SvaraAccessSession = { account: { role: 'admin' }, profile: { profileId } }
        frames.set(profileId, [])
        lobby.attachConnection(profileId, {
          profileId,
          getSession: () => session,
          send: (frame) => frames.get(profileId)!.push(typeof frame === 'string' ? JSON.parse(frame) : frame),
        })
      }
      const tryCreateTable = (profileId: string): string => {
        lobby.handle(profileId, {
          type: 'create_svara_table', requestId: randomUUID(), capacity: 2, entryFee: 5000, entryPercent: 1, startMode: 'manual',
        } as never)
        // Допуснат = вече седи на масата (commitment), не зависи от реда на push-овете.
        if (lobby.findCommitment(profileId) !== null) return 'admitted'
        const lastError = frames.get(profileId)!.findLast((frame) => frame.type === 'svara_lobby_error')
        return String(lastError?.code ?? 'unknown')
      }
      const leaveOwnTable = (profileId: string): void => {
        const commitment = lobby.findCommitment(profileId)
        if (commitment !== null) {
          lobby.handle(profileId, { type: 'leave_svara_table', matchId: commitment.matchId, requestId: randomUUID() } as never)
        }
      }

      // Финалист: блокиран, докато финалът тече; освободен, щом турнирът приключи.
      insertTournament('svara-final', 'final_in_progress')
      insertEntry('svara-final', 'svara-runner-up', 'finalist')
      attach('svara-runner-up')
      check('финалист, финалът тече → Свара отказва (other_game_commitment)', tryCreateTable('svara-runner-up') === 'other_game_commitment')
      setTournamentStatus('svara-final', 'finished') // загубилият остава 'finalist'
      check('загубил финала, турнирът е finished → Свара допуска', tryCreateTable('svara-runner-up') === 'admitted')
      leaveOwnTable('svara-runner-up')

      // Отпаднал при продължаващ турнир: блокиран като confirmed, освободен като eliminated.
      insertTournament('svara-semi', 'semifinal_in_progress')
      insertEntry('svara-semi', 'svara-loser', 'confirmed')
      attach('svara-loser')
      check('играч в течащ полуфинал → Свара отказва', tryCreateTable('svara-loser') === 'other_game_commitment')
      setEntryStatus('svara-semi', 'svara-loser', 'eliminated')
      check('отпаднал, турнирът продължава → Свара допуска', tryCreateTable('svara-loser') === 'admitted')
      leaveOwnTable('svara-loser')
    } finally {
      if (previousFlag === undefined) delete process.env.SVARA_TEST_ENABLED
      else process.env.SVARA_TEST_ENABLED = previousFlag
    }
  }

  console.log('\n[3] Отпаднал играч при продължаващ турнир — записване')
  for (const oldStatus of ['semifinal_in_progress', 'final_in_progress']) {
    const oldId = `elim-old-${oldStatus}`
    insertTournament(oldId, oldStatus)
    const solo = `elim-solo-${oldStatus}`
    const inviter = `elim-inviter-${oldStatus}`
    const invitee = `elim-invitee-${oldStatus}`
    for (const profileId of [solo, inviter, invitee]) insertEntry(oldId, profileId, 'eliminated')

    const target = `elim-new-${oldStatus}`
    insertTournament(target, 'open')
    const soloResult = economyStore.joinTournamentSoloAtomically(target, solo, { now: NOW })
    check(`${oldStatus}: отпаднал → solo записване OK`, soloResult.ok === true && countEntries(target, solo) === 1, JSON.stringify(soloResult))
    const createResult = economyStore.createPartnerInviteAtomically(target, inviter, invitee, { now: NOW })
    check(`${oldStatus}: отпаднал поканил + отпаднал поканен → поканата е създадена`, createResult.ok === true, JSON.stringify(createResult))
    if (createResult.ok) {
      const acceptResult = economyStore.acceptPartnerInviteAtomically(target, createResult.invite.inviteId, invitee, NOW)
      check(`${oldStatus}: отпаднал поканен → приемане OK`, acceptResult.ok === true, JSON.stringify(acceptResult))
    }
  }

  console.log('\n[4] Загубил финала след приключил турнир — записване')
  {
    insertTournament('runner-old', 'finished')
    for (const profileId of ['runner-solo', 'runner-inviter', 'runner-invitee']) insertEntry('runner-old', profileId, 'finalist')
    insertTournament('runner-new', 'open')
    const soloResult = economyStore.joinTournamentSoloAtomically('runner-new', 'runner-solo', { now: NOW })
    check('загубил финала → solo записване OK', soloResult.ok === true, JSON.stringify(soloResult))
    const createResult = economyStore.createPartnerInviteAtomically('runner-new', 'runner-inviter', 'runner-invitee', { now: NOW })
    check('загубил финала → покана OK', createResult.ok === true, JSON.stringify(createResult))
    if (createResult.ok) {
      const acceptResult = economyStore.acceptPartnerInviteAtomically('runner-new', createResult.invite.inviteId, 'runner-invitee', NOW)
      check('загубил финала → приемане OK', acceptResult.ok === true, JSON.stringify(acceptResult))
    }
  }

  console.log('\n[5] Съобщения при покани')
  {
    check(
      'съобщение: блокиран поканил → "Вече участваш в друг активен турнир."',
      partnerMessage('already_participating_elsewhere') === 'Вече участваш в друг активен турнир.',
      String(partnerMessage('already_participating_elsewhere')),
    )
    check(
      'съобщение: блокиран поканен партньор → "Играчът вече има активно турнирно участие."',
      partnerMessage('partner_participating_elsewhere') === 'Играчът вече има активно турнирно участие.',
      String(partnerMessage('partner_participating_elsewhere')),
    )

    insertTournament('msg-running', 'semifinal_in_progress')
    insertTournament('msg-target', 'open')

    insertEntry('msg-running', 'msg-busy-inviter', 'confirmed')
    insertProfile('msg-free-invitee')
    const inviterBlocked = economyStore.createPartnerInviteAtomically('msg-target', 'msg-busy-inviter', 'msg-free-invitee', { now: NOW })
    check(
      'поканилият играе другаде → already_participating_elsewhere',
      inviterBlocked.ok === false && inviterBlocked.reason === 'already_participating_elsewhere',
      JSON.stringify(inviterBlocked),
    )

    insertProfile('msg-free-inviter')
    insertEntry('msg-running', 'msg-busy-invitee', 'confirmed')
    const inviteeBlocked = economyStore.createPartnerInviteAtomically('msg-target', 'msg-free-inviter', 'msg-busy-invitee', { now: NOW })
    check(
      'поканеният играе другаде → partner_participating_elsewhere',
      inviteeBlocked.ok === false && inviteeBlocked.reason === 'partner_participating_elsewhere',
      JSON.stringify(inviteeBlocked),
    )

    // Приемане: блокиран е самият приемащ → съобщението е за него.
    insertProfile('msg-accept-inviter')
    insertProfile('msg-accept-invitee')
    const created = economyStore.createPartnerInviteAtomically('msg-target', 'msg-accept-inviter', 'msg-accept-invitee', { now: NOW })
    check('setup: покана за приемане е създадена', created.ok === true, JSON.stringify(created))
    if (created.ok) {
      insertEntry('msg-running', 'msg-accept-invitee', 'confirmed')
      const balanceBefore = walletBalance('msg-accept-invitee')
      const accepted = economyStore.acceptPartnerInviteAtomically('msg-target', created.invite.inviteId, 'msg-accept-invitee', NOW)
      check(
        'приемащият играе другаде → already_participating_elsewhere (съобщение за самия него)',
        accepted.ok === false && accepted.reason === 'already_participating_elsewhere',
        JSON.stringify(accepted),
      )
      check('отказаното приемане не таксува', walletBalance('msg-accept-invitee') === balanceBefore)
    }
  }

  console.log('\n[6] Ред на проверките при недостатъчно места')
  {
    insertTournament('order-running', 'final_in_progress')

    // 7/8 заети: нов участник с партньор би получил partner_requires_two_slots.
    insertTournament('order-one-slot', 'open')
    fillWithSoloEntries('order-one-slot', 7)
    insertEntry('order-running', 'order-busy-inviter', 'finalist')
    insertProfile('order-invitee-a')
    const busyBefore = walletBalance('order-busy-inviter')
    const busyOneSlot = economyStore.createPartnerInviteAtomically('order-one-slot', 'order-busy-inviter', 'order-invitee-a', { now: NOW })
    check(
      'активен поканил + 1 свободно място → already_participating_elsewhere (а не partner_requires_two_slots)',
      busyOneSlot.ok === false && busyOneSlot.reason === 'already_participating_elsewhere',
      JSON.stringify(busyOneSlot),
    )
    check('отказът не таксува поканилия', walletBalance('order-busy-inviter') === busyBefore)

    insertTournament('order-full', 'open')
    fillWithSoloEntries('order-full', 8)
    const busyFull = economyStore.createPartnerInviteAtomically('order-full', 'order-busy-inviter', 'order-invitee-a', { now: NOW })
    check(
      'активен поканил + пълен турнир → already_participating_elsewhere (а не tournament_full)',
      busyFull.ok === false && busyFull.reason === 'already_participating_elsewhere',
      JSON.stringify(busyFull),
    )

    // Правилата за местата са непроменени за свободен поканил.
    insertProfile('order-free-inviter')
    insertProfile('order-invitee-b')
    const freeOneSlot = economyStore.createPartnerInviteAtomically('order-one-slot', 'order-free-inviter', 'order-invitee-b', { now: NOW })
    check(
      'свободен поканил + 1 свободно място → partner_requires_two_slots (без промяна)',
      freeOneSlot.ok === false && freeOneSlot.reason === 'partner_requires_two_slots',
      JSON.stringify(freeOneSlot),
    )
    const freeFull = economyStore.createPartnerInviteAtomically('order-full', 'order-free-inviter', 'order-invitee-b', { now: NOW })
    check(
      'свободен поканил + пълен турнир → tournament_full (без промяна)',
      freeFull.ok === false && freeFull.reason === 'tournament_full',
      JSON.stringify(freeFull),
    )

    // Solo записването: активното участие и досега е преди капацитета.
    const soloBusyFull = economyStore.joinTournamentSoloAtomically('order-full', 'order-busy-inviter', { now: NOW })
    check(
      'solo: активен играч + пълен турнир → already_participating_elsewhere (без промяна)',
      soloBusyFull.ok === false && soloBusyFull.reason === 'already_participating_elsewhere',
      JSON.stringify(soloBusyFull),
    )

    // Отпаднал поканил при 1 свободно място → правилото за местата важи.
    insertEntry('order-running', 'order-eliminated-inviter', 'eliminated')
    const eliminatedOneSlot = economyStore.createPartnerInviteAtomically('order-one-slot', 'order-eliminated-inviter', 'order-invitee-b', { now: NOW })
    check(
      'отпаднал поканил + 1 свободно място → partner_requires_two_slots',
      eliminatedOneSlot.ok === false && eliminatedOneSlot.reason === 'partner_requires_two_slots',
      JSON.stringify(eliminatedOneSlot),
    )
  }
} finally {
  coordinator.close()
  database.close()
  await rm(tempDir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\ncheckTournamentEliminatedPlayerReentry passed=${passed} failed=${failed}`)
if (failed > 0) process.exit(1)
