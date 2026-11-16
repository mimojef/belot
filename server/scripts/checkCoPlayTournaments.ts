/**
 * checkCoPlayTournaments.ts — „Забрана за съвместна игра“, Етап 4: турнири и
 * отложено активиране. Реални coPlayRestrictionStore + tournamentEconomyStore
 * + tournamentStore върху ЕДНА изолирана временна база (всички миграции).
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkCoPlayTournaments.ts   (от server/)
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { CO_PLAY_MS_PER_DAY, createCoPlayRestrictionStore, type CoPlayRestrictionStore } from '../src/db/coPlayRestrictionStore.js'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentStore } from '../src/db/tournamentStore.js'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: очаквано ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}

const sourceMigrations = join(resolve(process.cwd()), 'database', 'migrations')
const sqliteModule = await import('node:sqlite')
type SqliteDatabase = InstanceType<typeof sqliteModule.DatabaseSync>
const tempRoots: string[] = []
const toClose: Array<{ close: () => void }> = []
const BALANCE = 1_000_000
const FEE = 5_000
const START = Date.now()
let nowMs = START
const clock = () => nowMs

async function freshEnv() {
  nowMs = START
  const root = await mkdtemp(join(tmpdir(), 'belot-co-play-tournaments-'))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(sourceMigrations, { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') await cp(join(sourceMigrations, entry.name), join(root, 'database', 'migrations', entry.name))
  }
  const { databaseFilePath: path } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const raw = new sqliteModule.DatabaseSync(path, { open: true, enableForeignKeyConstraints: true })
  raw.exec('PRAGMA busy_timeout = 5000;')
  toClose.push(raw)
  const coPlay = await createCoPlayRestrictionStore(path, { now: clock })
  toClose.push(coPlay)
  const guardStats = { isActive: 0, areRestricted: 0 }
  const economy = await createTournamentEconomyStore(path, {
    coPlayGuard: {
      isActive: () => { guardStats.isActive += 1; return coPlay.isTournamentEnforcementActive() },
      areRestricted: (a, b) => { guardStats.areRestricted += 1; return coPlay.areAccountsRestrictedForTournament(a, b) },
    },
  })
  const tournaments = await createTournamentStore(path)
  const admin = seedPerson(raw, 'Admin')
  return { path, raw, coPlay, economy, tournaments, admin, guardStats }
}

function seedPerson(raw: SqliteDatabase, name: string, accountId: string = randomUUID()): string {
  const profileId = randomUUID()
  raw.prepare(`INSERT OR IGNORE INTO accounts (account_id, email, password_hash) VALUES (?, ?, 'x');`).run(accountId, `${accountId}@example.test`)
  raw.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind, status) VALUES (?, ?, ?, ?, 'human', 'active');`)
    .run(profileId, accountId, `${name}${profileId.slice(0, 4)}`, `${name.toLowerCase()}-${profileId.slice(0, 8)}`)
  raw.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?);`).run(profileId, BALANCE)
  return profileId
}
const accountOf = (raw: SqliteDatabase, profileId: string) => (raw.prepare('SELECT account_id FROM profiles WHERE profile_id = ?').get(profileId) as { account_id: string }).account_id
const wallet = (raw: SqliteDatabase, profileId: string) => (raw.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(profileId) as { b: number }).b
const entryCount = (raw: SqliteDatabase, tournamentId: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed'`).get(tournamentId) as { n: number }).n
const teamCount = (raw: SqliteDatabase, tournamentId: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM tournament_teams WHERE tournament_id = ?`).get(tournamentId) as { n: number }).n
const setTournamentStatus = (raw: SqliteDatabase, tournamentId: string, status: string) => raw.prepare('UPDATE tournaments SET status = ? WHERE tournament_id = ?').run(status, tournamentId)
const auditCount = (raw: SqliteDatabase, action: string) => (raw.prepare('SELECT COUNT(*) AS n FROM co_play_restriction_audit WHERE action = ?').get(action) as { n: number }).n

type Env = Awaited<ReturnType<typeof freshEnv>>
let tournamentSeq = 0
/** Насрочен турнир (часовете са раздалечени, за да не пречи правилото за друг турнир под 60 мин.). */
function createTournament(env: Env, options: { shuffle?: boolean } = {}): string {
  tournamentSeq += 1
  const creator = seedPerson(env.raw, 'Creator')
  const result = env.tournaments.createTournament({
    name: `Турнир ${tournamentSeq}`,
    creatorProfileId: creator,
    visibility: 'public',
    entryFee: FEE,
    startMode: 'scheduled',
    scheduledStartAt: new Date(START + (24 + tournamentSeq * 3) * 60 * 60 * 1000).toISOString(),
    playerCapacity: 8,
    shuffleEnabled: options.shuffle === true,
  })
  if (!result.ok) throw new Error(`createTournament: ${result.reason}`)
  return result.tournament.tournamentId
}
function impose(env: Env, a: string, b: string, durationDays: number | null = 30) {
  const result = env.coPlay.imposeRestriction({ firstProfileId: a, secondProfileId: b, reason: 'Тест', durationDays, actorProfileId: env.admin })
  if (!result.ok) throw new Error(`impose: ${result.code}`)
  return result.restriction
}
function enable(env: Env): void {
  const r = env.coPlay.setEnabled({ enabled: true, actorProfileId: env.admin })
  if (!r.ok) throw new Error(`enable: ${JSON.stringify(r)}`)
}
function joinOk(env: Env, tournamentId: string, profileId: string): void {
  const r = env.economy.joinTournamentSoloAtomically(tournamentId, profileId)
  if (!r.ok) throw new Error(`join: ${r.reason}`)
}

console.log('\ncheckCoPlayTournaments\n')

// ─── Отказ при регистрация ────────────────────────────────────────────────

await check('[T1] самостоятелна регистрация: отказ co_play_restricted; без промени по турнир, отбори и портфейл', async () => {
  const env = await freshEnv()
  const [a, b] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B')]
  enable(env)
  impose(env, a, b)
  const t = createTournament(env)
  joinOk(env, t, a)
  const before = { entries: entryCount(env.raw, t), teams: teamCount(env.raw, t), wallet: wallet(env.raw, b) }
  const r = env.economy.joinTournamentSoloAtomically(t, b)
  assert(!r.ok && r.reason === 'co_play_restricted', JSON.stringify(r))
  assertEqual({ entries: entryCount(env.raw, t), teams: teamCount(env.raw, t), wallet: wallet(env.raw, b) }, before, 'промяна при отказа')
})

await check('[T2] двустранност и други профили на акаунтите (в двете посоки)', async () => {
  const env = await freshEnv()
  const a = seedPerson(env.raw, 'A')
  const a2 = seedPerson(env.raw, 'A2', accountOf(env.raw, a))
  const b = seedPerson(env.raw, 'B')
  const b2 = seedPerson(env.raw, 'B2', accountOf(env.raw, b))
  enable(env)
  impose(env, a2, b2)
  const t1 = createTournament(env)
  joinOk(env, t1, a)
  const r1 = env.economy.joinTournamentSoloAtomically(t1, b)
  const t2 = createTournament(env)
  joinOk(env, t2, b)
  const r2 = env.economy.joinTournamentSoloAtomically(t2, a)
  assert(!r1.ok && r1.reason === 'co_play_restricted', `Б в турнира на А: ${JSON.stringify(r1)}`)
  assert(!r2.ok && r2.reason === 'co_play_restricted', `А в турнира на Б: ${JSON.stringify(r2)}`)
})

await check('[T3] покана за партньор: отказ за забранена двойка и при забранен записан участник; поканилият не плаща', async () => {
  const env = await freshEnv()
  const [a, b, c, d] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B'), seedPerson(env.raw, 'C'), seedPerson(env.raw, 'D')]
  enable(env)
  impose(env, a, b)
  impose(env, c, d)
  const t = createTournament(env)
  const pair = env.economy.createPartnerInviteAtomically(t, a, b)
  assert(!pair.ok && pair.reason === 'co_play_restricted', `двойката: ${JSON.stringify(pair)}`)
  joinOk(env, t, d)
  const viaParticipant = env.economy.createPartnerInviteAtomically(t, a, c)
  assert(!viaParticipant.ok && viaParticipant.reason === 'co_play_restricted', `поканен спрямо записан: ${JSON.stringify(viaParticipant)}`)
  assert(wallet(env.raw, a) === BALANCE && entryCount(env.raw, t) === 1, 'поканилият е таксуван/записан')
})

await check('[T4] приемане на покана: повторна проверка (съставът се е променил); поканата и отборът остават, без такса', async () => {
  const env = await freshEnv()
  const [a, c, d] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'C'), seedPerson(env.raw, 'D')]
  enable(env)
  const t = createTournament(env)
  const invite = env.economy.createPartnerInviteAtomically(t, a, c)
  assert(invite.ok, `(setup) покана: ${JSON.stringify(invite)}`)
  if (!invite.ok) return
  joinOk(env, t, d)
  impose(env, c, d) // C няма потвърдено участие -> активна веднага
  const before = { entries: entryCount(env.raw, t), teams: teamCount(env.raw, t), wallet: wallet(env.raw, c) }
  const r = env.economy.acceptPartnerInviteAtomically(t, invite.invite.inviteId, c)
  assert(!r.ok && r.reason === 'co_play_restricted', JSON.stringify(r))
  const status = (env.raw.prepare('SELECT status FROM tournament_partner_invites WHERE invite_id = ?').get(invite.invite.inviteId) as { status: string }).status
  assertEqual(status, 'pending', 'поканата')
  assertEqual({ entries: entryCount(env.raw, t), teams: teamCount(env.raw, t), wallet: wallet(env.raw, c) }, before, 'промяна при отказа')
})

await check('[T5] турнир с разбъркване: отказ при самостоятелна регистрация', async () => {
  const env = await freshEnv()
  const [a, b] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B')]
  enable(env)
  impose(env, a, b)
  const t = createTournament(env, { shuffle: true })
  joinOk(env, t, a)
  const r = env.economy.joinTournamentSoloAtomically(t, b)
  assert(!r.ok && r.reason === 'co_play_restricted', JSON.stringify(r))
})

await check('[T6] изключен флаг: регистрациите не се ограничават; проверката не прави нито една турнирна проверка по двойки', async () => {
  const env = await freshEnv()
  const [a, b] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B')]
  impose(env, a, b)
  const t = createTournament(env)
  joinOk(env, t, a)
  joinOk(env, t, b)
  assert(env.guardStats.areRestricted === 0, `areRestricted при изключен флаг: ${env.guardStats.areRestricted}`)
})

await check('[T7] неограничени потребители: регистрация, автоматично сдвояване, покана и приемане — нормално', async () => {
  const env = await freshEnv()
  const [a, b, x, y, p, q] = ['A', 'B', 'X', 'Y', 'P', 'Q'].map((n) => seedPerson(env.raw, n)) as [string, string, string, string, string, string]
  enable(env)
  impose(env, a, b)
  const t = createTournament(env)
  joinOk(env, t, x)
  joinOk(env, t, y)
  const pair = (env.raw.prepare(`SELECT COUNT(DISTINCT team_id) AS n FROM tournament_entries WHERE tournament_id = ? AND profile_id IN (?, ?)`).get(t, x, y) as { n: number }).n
  assert(pair === 1, 'автоматичното сдвояване на X и Y')
  const invite = env.economy.createPartnerInviteAtomically(t, p, q)
  assert(invite.ok, `покана: ${JSON.stringify(invite)}`)
  if (invite.ok) assert(env.economy.acceptPartnerInviteAtomically(t, invite.invite.inviteId, q).ok, 'приемане')
  assert(wallet(env.raw, x) === BALANCE - FEE && wallet(env.raw, q) === BALANCE - FEE, 'таксите')
})

// ─── Отложено активиране ──────────────────────────────────────────────────

await check('[T8] налагане при общ предстоящ турнир -> pending_activation с турнира; не се прилага в игрите', async () => {
  const env = await freshEnv()
  const [a, b] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B')]
  enable(env)
  const t = createTournament(env)
  joinOk(env, t, a)
  joinOk(env, t, b)
  const r = impose(env, a, b)
  assertEqual(r.status, 'pending_activation', 'статус')
  assert(r.activatedAt === null && r.expiresAt === null && r.durationDays === 30, `срок: ${JSON.stringify({ a: r.activatedAt, e: r.expiresAt, d: r.durationDays })}`)
  assertEqual(r.pendingReason, 'shared_tournament', 'причина')
  assertEqual(r.pendingTournaments.map((x) => [x.tournamentId, x.status]), [[t, 'open']], 'турнири')
  assert(typeof r.pendingTournaments[0]?.name === 'string' && r.pendingTournaments[0]!.name!.length > 0, 'име на турнира')
  assertEqual(env.coPlay.getEnforcedRestrictionIdBetweenAccounts(accountOf(env.raw, a), accountOf(env.raw, b)), null, 'прилага се в игрите')
  assert(!env.coPlay.isRestrictedBetweenProfiles(a, b), 'прилага се (по профил)')
  assertEqual(entryCount(env.raw, t), 2, 'участниците са непокътнати')
})

await check('[T9] налагане при общ ЗАПОЧНАЛ турнир -> pending_activation; турнирът не се пипа', async () => {
  const env = await freshEnv()
  const [a, b] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B')]
  enable(env)
  const t = createTournament(env)
  joinOk(env, t, a)
  joinOk(env, t, b)
  setTournamentStatus(env.raw, t, 'semifinal_in_progress')
  const r = impose(env, a, b)
  assertEqual([r.status, r.pendingTournaments[0]?.status], ['pending_activation', 'semifinal_in_progress'], 'статус')
  assertEqual((env.raw.prepare('SELECT status FROM tournaments WHERE tournament_id = ?').get(t) as { status: string }).status, 'semifinal_in_progress', 'турнирът')
})

await check('[T10] няколко общи турнира: активира се едва след края на всички; срокът тече от активирането; идемпотентно', async () => {
  const env = await freshEnv()
  const [a, b] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B')]
  const [t1, t2] = [createTournament(env), createTournament(env)]
  for (const t of [t1, t2]) { joinOk(env, t, a); joinOk(env, t, b) }
  const r = impose(env, a, b, 30)
  assertEqual(r.pendingTournaments.length, 2, 'два турнира')
  nowMs = START + 2 * 3600_000
  setTournamentStatus(env.raw, t1, 'finished')
  assertEqual(env.coPlay.activateEligiblePendingRestrictions(), [], 'активирана след първия')
  nowMs = START + (3 * 3600_000 + 30 * 60_000)
  setTournamentStatus(env.raw, t2, 'finished')
  assertEqual(env.coPlay.activateEligiblePendingRestrictions(), [r.restrictionId], 'не е активирана след втория')
  const active = env.coPlay.getRestriction(r.restrictionId)!
  assertEqual(active.status, 'active', 'статус')
  assertEqual(active.createdAt, new Date(START).toISOString(), 'момент на заявката')
  assertEqual(active.activatedAt, new Date(nowMs).toISOString(), 'момент на активиране')
  assertEqual(active.expiresAt, new Date(nowMs + 30 * CO_PLAY_MS_PER_DAY).toISOString(), 'срокът тече от активирането')
  assertEqual(auditCount(env.raw, 'activate'), 1, 'одит')
  const expiresAt = active.expiresAt
  nowMs += 3600_000
  assertEqual(env.coPlay.activateEligiblePendingRestrictions(), [], 'повторно активиране')
  assertEqual(env.coPlay.getRestriction(r.restrictionId)!.expiresAt, expiresAt, 'срокът е изместен')
  assertEqual(auditCount(env.raw, 'activate'), 1, 'повторен одит')
  enable(env)
  assert(env.coPlay.getEnforcedRestrictionIdBetweenAccounts(accountOf(env.raw, a), accountOf(env.raw, b)) === r.restrictionId, 'след активиране не се прилага в игрите')
})

await check('[T11] автоматично активиране при отмяна на турнира (реалната отмяна от създателя)', async () => {
  const env = await freshEnv()
  const [a, b] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B')]
  const t = createTournament(env)
  joinOk(env, t, a)
  joinOk(env, t, b)
  const r = impose(env, a, b, null)
  const creator = (env.raw.prepare('SELECT creator_profile_id AS c FROM tournaments WHERE tournament_id = ?').get(t) as { c: string }).c
  const cancel = env.economy.cancelOpenTournamentAndRefundAtomically(t, creator, 'Тест')
  assert(cancel.ok, `отмяна: ${JSON.stringify(cancel)}`)
  assertEqual(env.coPlay.activateEligiblePendingRestrictions(), [r.restrictionId], 'активиране')
  const active = env.coPlay.getRestriction(r.restrictionId)!
  assert(active.status === 'active' && active.isIndefinite && active.expiresAt === null, 'безсрочна активна')
})

await check('[T12] отмяна на изчакваща забрана преди активирането', async () => {
  const env = await freshEnv()
  const [a, b] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B')]
  const t = createTournament(env)
  joinOk(env, t, a)
  joinOk(env, t, b)
  const r = impose(env, a, b)
  const lifted = env.coPlay.liftRestriction({ restrictionId: r.restrictionId, actorProfileId: env.admin, reason: 'Грешка' })
  assert(lifted.ok && lifted.restriction.status === 'lifted' && lifted.restriction.activatedAt === null, JSON.stringify(lifted))
  setTournamentStatus(env.raw, t, 'finished')
  assertEqual(env.coPlay.activateEligiblePendingRestrictions(), [], 'отменената е активирана')
  assertEqual(env.coPlay.getPendingRestrictionCount(), 0, 'остава в изчакващите')
})

await check('[T13] рестарт при изчакваща забрана: зарежда се; турнирът е приключил докато сървърът е спрян -> активира се при старта', async () => {
  const env = await freshEnv()
  const [a, b] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B')]
  const t = createTournament(env)
  joinOk(env, t, a)
  joinOk(env, t, b)
  const r = impose(env, a, b, 10)
  setTournamentStatus(env.raw, t, 'auto_cancelled')
  nowMs = START + 5 * 3600_000
  const restarted = await createCoPlayRestrictionStore(env.path, { now: clock })
  toClose.push(restarted)
  assertEqual(restarted.getPendingRestrictionCount(), 1, 'изчакващата не е заредена')
  assertEqual(restarted.activateEligiblePendingRestrictions(), [r.restrictionId], 'не е активирана при старта')
  assertEqual(restarted.getRestriction(r.restrictionId)!.activatedAt, new Date(nowMs).toISOString(), 'момент на активиране')
})

await check('[T14] изчакваща забрана: нови общи регистрации се отказват (флаг вкл.); при изключен флаг — разрешени и активирането пак изчаква', async () => {
  const env = await freshEnv()
  const [a, b] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B')]
  const t1 = createTournament(env)
  joinOk(env, t1, a)
  joinOk(env, t1, b)
  const r = impose(env, a, b)
  enable(env)
  const t2 = createTournament(env)
  joinOk(env, t2, a)
  const refused = env.economy.joinTournamentSoloAtomically(t2, b)
  assert(!refused.ok && refused.reason === 'co_play_restricted', `нова обща регистрация: ${JSON.stringify(refused)}`)
  env.coPlay.setEnabled({ enabled: false, actorProfileId: env.admin })
  joinOk(env, t2, b)
  setTournamentStatus(env.raw, t1, 'finished')
  assertEqual(env.coPlay.activateEligiblePendingRestrictions(), [], 'активирана въпреки общия t2')
  assert(env.coPlay.getRestriction(r.restrictionId)!.pendingTournaments.some((x) => x.tournamentId === t2), 't2 не е записан')
})

await check('[T15] дублиране: нова забрана при изчакваща за същата двойка -> already_restricted', async () => {
  const env = await freshEnv()
  const [a, b] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B')]
  const t = createTournament(env)
  joinOk(env, t, a)
  joinOk(env, t, b)
  const r = impose(env, a, b)
  const again = env.coPlay.imposeRestriction({ firstProfileId: b, secondProfileId: a, reason: 'x', durationDays: null, actorProfileId: env.admin })
  assert(!again.ok && again.code === 'already_restricted' && again.existingRestrictionId === r.restrictionId, JSON.stringify(again))
})

// ─── Флаг ─────────────────────────────────────────────────────────────────

await check('[T16] включване на флага при активна забрана с общ НЕЗАПОЧНАЛ турнир -> отказ със списъка; никой не се маха', async () => {
  const env = await freshEnv()
  const [a, b] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B')]
  const r = impose(env, a, b) // активна (няма общ турнир)
  const t = createTournament(env)
  joinOk(env, t, a)
  joinOk(env, t, b) // флагът е изключен -> разрешено
  const refused = env.coPlay.setEnabled({ enabled: true, actorProfileId: env.admin })
  assert(!refused.ok && refused.code === 'tournament_conflicts', JSON.stringify(refused))
  if (!refused.ok) assertEqual(refused.conflicts.map((c) => [c.restrictionId, c.tournamentId, c.tournamentStatus]), [[r.restrictionId, t, 'open']], 'конфликти')
  assert(!env.coPlay.isEnabled() && entryCount(env.raw, t) === 2, 'флагът е включен или участник е изваден')
  setTournamentStatus(env.raw, t, 'final_in_progress')
  const ok = env.coPlay.setEnabled({ enabled: true, actorProfileId: env.admin })
  assert(ok.ok && env.coPlay.isEnabled(), 'започнал турнир не трябва да пречи на включването')
})

await check('[T17] защитна проверка преди старт: засича активна забрана между записани (само четене)', async () => {
  const env = await freshEnv()
  const [a, b] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B')]
  const r = impose(env, a, b)
  const t = createTournament(env)
  joinOk(env, t, a)
  joinOk(env, t, b)
  assertEqual(env.coPlay.findActiveConflictsInTournament(t).map((c) => c.restrictionId), [r.restrictionId], 'конфликт')
  assertEqual(entryCount(env.raw, t), 2, 'промяна')
})

await check('[T18] API/одит: изчакващата е в списъка pending_activation, не в active; активирането е в одита', async () => {
  const env = await freshEnv()
  const [a, b] = [seedPerson(env.raw, 'A'), seedPerson(env.raw, 'B')]
  const t = createTournament(env)
  joinOk(env, t, a)
  joinOk(env, t, b)
  const r = impose(env, a, b)
  assertEqual(env.coPlay.listRestrictions({ status: 'pending_activation' }).items.map((x) => x.restrictionId), [r.restrictionId], 'pending_activation')
  assertEqual(env.coPlay.listRestrictions({ status: 'active' }).total, 0, 'active')
  setTournamentStatus(env.raw, t, 'finished')
  env.coPlay.activateEligiblePendingRestrictions()
  assertEqual(env.coPlay.listRestrictions({ status: 'active' }).total, 1, 'active след активиране')
  const actions = env.coPlay.listAudit({ restrictionId: r.restrictionId }).items.map((x) => x.action)
  assertEqual(actions, ['activate', 'impose'], 'одит')
})

for (const item of toClose) {
  try { item.close() } catch { /* затворена */ }
}
for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {})
console.log(`\nPassed: ${passed}  Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
