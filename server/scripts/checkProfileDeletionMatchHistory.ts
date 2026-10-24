/**
 * checkProfileDeletionMatchHistory.ts
 *
 * Самоизтриване на профили — Етап 4E1 (одит P5): при окончателно изтриване
 *   * profile_ip_links / profile_visitor_links на профила се изтриват
 *     (връзките на други профили със същия IP/visitor остават);
 *   * участникът в private_room_matches се анонимизира ("Изтрит профил",
 *     без profileId и avatarUrl), мачът и другите участници остават;
 *   * участникът в ludo_room_matches получава несвързан заместител (и
 *     winner_profile_id, ако е победител), без име/аватар; другите остават.
 * САМО временни бази (ensureServerDatabaseReady() върху копие на миграциите).
 *
 * [V] IP/visitor връзки.  [P] Частни маси.  [L] Ludo.  [C] Кампании и статистики.
 * [G] Срок, отмяна, повторно изпълнение, външният дневник (4C).
 * [R] Restore от стар backup.  [X] Остатъчни лични данни.  [E] Невалидна структура.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore, LUDO_MATCH_WIN_RECONCILIATION_CANDIDATES_SQL } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileDeletionRequestStore } from '../src/db/profileDeletionRequestStore.js'
import { createProfileDeletionExecutor, PROFILE_DELETION_DELETED_LABEL, type ProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
import { createProfileDeletionWorker } from '../src/core/profileDeletionWorker.js'
import { removeProfileDeletionFile, type ProfileDeletionUploadRoots } from '../src/uploads/profileDeletionFileRemoval.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

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

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: очаквано ${String(expected)}, получено ${String(actual)}`)
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)
const SECRET = 'profile-deletion-match-history-test-secret-0123456789'

console.log('\ncheckProfileDeletionMatchHistory')
console.log(`Server root: ${sourceServerRoot}`)

const root = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-history-'))
await mkdir(join(root, 'database', 'migrations'), { recursive: true })
await mkdir(join(root, 'database', 'data'), { recursive: true })
for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
  if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') {
    await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
  }
}
const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })
const uploadsRoot = join(root, 'uploads')
const roots: ProfileDeletionUploadRoots = {
  avatars: join(uploadsRoot, 'avatars'),
  profileGallery: join(uploadsRoot, 'profile-gallery'),
  chatAttachments: join(uploadsRoot, 'chat-attachments'),
  topicAttachments: join(uploadsRoot, 'topic-attachments'),
  topicMuteEvidenceAttachments: join(uploadsRoot, 'topic-mute-evidence-attachments'),
  supportAttachments: join(uploadsRoot, 'support-attachments'),
}
for (const dir of Object.values(roots)) await mkdir(dir, { recursive: true })

const sqliteModule = await import('node:sqlite')
const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

const progressStore = await createPlayerProgressStore(databaseFilePath)
const authStore = await createAuthStore(databaseFilePath, progressStore, {
  registrationVerificationCodeSecret: SECRET,
  getRegistrationVerificationMode: () => 'direct',
  getActiveBanForProfile: () => null,
})
const requestStore = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: SECRET })
const executor = await createProfileDeletionExecutor(databaseFilePath)

function makeWorker(exec: ProfileDeletionExecutor, onlyRequestIds: string[], offsiteConfirmed?: (requestId: string) => boolean) {
  return createProfileDeletionWorker({
    executor: exec,
    workerId: `w-history-${randomUUID().slice(0, 6)}`,
    uploadRoots: roots,
    removeFile: removeProfileDeletionFile,
    appendLedgerEntry: null,
    isLedgerEntryConfirmedOffsite: offsiteConfirmed,
    onlyRequestIds,
  })
}

type User = { profileId: string; accountId: string; displayName: string; avatarUrl: string }
let counter = 0
function registerUser(label: string): User {
  counter += 1
  const displayName = `Hist${label}${counter}`
  const result = authStore.register({ email: `hist-${label.toLowerCase()}-${counter}@example.test`, password: 'secret123', displayName, gender: 'male', visitorId: randomUUID() })
  if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
  const profileId = result.session.profile.profileId as string
  const avatarUrl = `/uploads/avatars/${randomUUID()}.webp`
  db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(avatarUrl, profileId)
  return { profileId, accountId: result.session.account.accountId, displayName, avatarUrl }
}

function dbNow(): string {
  return (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
}

function isoPlus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}

/** Заявка с даден scheduled_for (requested_at назад с точно 30 × 24 ч; insert guard-ът временно е свален). */
function insertRequestScheduledAt(user: User, scheduledForIso: string): string {
  const requestId = randomUUID()
  const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
  const requestedAt = new Date(Date.parse(scheduledForIso) - PROFILE_DELETION_GRACE_PERIOD_MS).toISOString()
  const triggerSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_profile_deletion_requests_insert_guard';`).get() as { sql: string }).sql
  db.exec('DROP TRIGGER trg_profile_deletion_requests_insert_guard;')
  try {
    db.prepare(`
      INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for)
      VALUES (?, ?, ?, ?, ?, ?);
    `).run(requestId, user.profileId, user.accountId, createdAt, requestedAt, scheduledForIso)
  } finally {
    db.exec(triggerSql)
  }
  return requestId
}

const insertDueRequest = (user: User) => insertRequestScheduledAt(user, isoPlus(dbNow(), -1000))

function addLinks(user: User, ips: string[], visitors: string[]): void {
  for (const ip of ips) {
    db.prepare(`INSERT INTO profile_ip_links (profile_id, ip_address, first_seen_at, last_seen_at, event_count) VALUES (?, ?, '2026-01-01 00:00:00', '2026-01-02 00:00:00', 3);`).run(user.profileId, ip)
  }
  for (const visitor of visitors) {
    db.prepare(`INSERT INTO profile_visitor_links (profile_id, anonymous_visitor_id, first_seen_at, last_seen_at, event_count) VALUES (?, ?, '2026-01-01 00:00:00', '2026-01-02 00:00:00', 2);`).run(user.profileId, visitor)
  }
}

const linkCount = (table: 'profile_ip_links' | 'profile_visitor_links', profileId: string) =>
  Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE profile_id = ?;`).get(profileId) as { c: number }).c)

const occupant = (user: User) => ({ profileId: user.profileId, displayName: user.displayName, avatarUrl: user.avatarUrl, isBot: false })
const botOccupant = () => ({ profileId: `bot-${randomUUID().slice(0, 8)}`, displayName: 'Бот', avatarUrl: '/assets/avatars/bot.png', isBot: true })

function insertPrivateMatch(teamA: object[], teamB: object[], status: 'playing' | 'finished' = 'finished'): string {
  const roomId = randomUUID()
  db.prepare(`
    INSERT INTO private_room_matches (room_id, private_room_id, status, stake, team_a_json, team_b_json, team_a_score, team_b_score, started_at, finished_at)
    VALUES (?, ?, ?, 100, ?, ?, 151, 97, '2026-03-01 10:00:00', ?);
  `).run(roomId, randomUUID(), status, JSON.stringify(teamA), JSON.stringify(teamB), status === 'finished' ? '2026-03-01 10:40:00' : null)
  return roomId
}

function privateMatch(roomId: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM private_room_matches WHERE room_id = ?;').get(roomId) as Record<string, unknown>
}

const ludoPlayer = (user: User, color: string) => ({ profileId: user.profileId, displayName: user.displayName, avatarUrl: user.avatarUrl, color })

function insertLudoMatch(players: object[], winnerProfileId: string | null): string {
  const matchId = randomUUID()
  db.prepare(`
    INSERT INTO ludo_room_matches (match_id, ludo_room_id, status, stake, player_count, players_json, winner_profile_id, started_at, finished_at)
    VALUES (?, ?, 'finished', 200, ?, ?, ?, '2026-03-02 10:00:00', '2026-03-02 10:20:00');
  `).run(matchId, randomUUID(), players.length, JSON.stringify(players), winnerProfileId)
  return matchId
}

function ludoMatch(matchId: string): { players: Array<Record<string, unknown>>; winner: string | null; row: Record<string, unknown> } {
  const row = db.prepare('SELECT * FROM ludo_room_matches WHERE match_id = ?;').get(matchId) as Record<string, unknown>
  return { players: JSON.parse(String(row.players_json)) as Array<Record<string, unknown>>, winner: row.winner_profile_id as string | null, row }
}

async function runDeletion(requestId: string): Promise<void> {
  const summary = await makeWorker(executor, [requestId]).runOnce()
  assertEqual(summary.completed, 1, `completed (${JSON.stringify(summary)})`)
}

try {
  console.log('\n[V] IP и visitor връзки')

  const target = registerUser('Target')
  const neighbour = registerUser('Neighbour')
  const sharedIp = '203.0.113.10'
  const sharedVisitor = `v-${randomUUID()}`
  addLinks(target, ['198.51.100.1', '198.51.100.2', sharedIp], [`v-${randomUUID()}`, `v-${randomUUID()}`, sharedVisitor])
  addLinks(neighbour, [sharedIp, '192.0.2.77'], [sharedVisitor])
  // Risk cache на съседа (споделен visitor) — трябва да се инвалидира, преди връзките да изчезнат.
  db.prepare('INSERT INTO admin_profile_risk_checks (profile_id, risk_detected, linked_profiles_count, check_complete) VALUES (?, 1, 1, 1);').run(neighbour.profileId)
  const targetIpBefore = linkCount('profile_ip_links', target.profileId)
  const targetVisitorBefore = linkCount('profile_visitor_links', target.profileId)
  const neighbourLinksBefore = JSON.stringify([
    db.prepare('SELECT * FROM profile_ip_links WHERE profile_id = ? ORDER BY ip_address;').all(neighbour.profileId),
    db.prepare('SELECT * FROM profile_visitor_links WHERE profile_id = ? ORDER BY anonymous_visitor_id;').all(neighbour.profileId),
  ])

  // Частен Белот мач с четирима души (target + трима), още един с бот.
  const friendA = registerUser('FriendA')
  const friendB = registerUser('FriendB')
  const friendC = registerUser('FriendC')
  const privateFour = insertPrivateMatch([occupant(target), occupant(friendA)], [occupant(friendB), occupant(friendC)])
  const privateWithBot = insertPrivateMatch([occupant(friendA), botOccupant()], [occupant(target), botOccupant()], 'playing')
  const privateFourBefore = privateMatch(privateFour)
  const privateUnrelated = insertPrivateMatch([occupant(friendA), occupant(friendB)], [occupant(friendC), botOccupant()])
  const privateUnrelatedBefore = JSON.stringify(privateMatch(privateUnrelated))

  // Ludo: target печели (2 играчи); target губи (4 играчи).
  const ludoWon = insertLudoMatch([ludoPlayer(target, 'red'), ludoPlayer(friendA, 'blue')], target.profileId)
  const ludoLost = insertLudoMatch([ludoPlayer(friendB, 'red'), ludoPlayer(target, 'blue'), ludoPlayer(friendC, 'green'), ludoPlayer(friendA, 'yellow')], friendB.profileId)
  const ludoLostBefore = ludoMatch(ludoLost)

  // Кампании/статистики на другите: начисление и ledger за завършена игра.
  const campaignId = randomUUID()
  db.prepare(`INSERT INTO campaigns (campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural) VALUES (?, 'Кампания', 'active', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'точка', 'точки');`).run(campaignId)
  db.prepare(`INSERT INTO campaign_unit_ledger (campaign_id, profile_id, source_type, source_id, units_amount, event_at) VALUES (?, ?, 'ludo_win', ?, 5, '2026-03-02T10:20:00.000Z');`).run(campaignId, friendB.profileId, ludoLost)
  db.prepare(`INSERT INTO campaign_unit_ledger (campaign_id, profile_id, source_type, source_id, units_amount, event_at) VALUES (?, ?, 'ludo_win', ?, 7, '2026-03-02T10:20:00.000Z');`).run(campaignId, target.profileId, ludoWon)
  for (const [user, matchId, didWin] of [[friendB, ludoLost, 0], [friendA, ludoWon, 0], [friendC, ludoLost, 0]] as const) {
    db.prepare(`INSERT INTO profile_completed_game_ledger (scope_id, profile_id, source, did_win) VALUES (?, ?, 'ludo_match', ?);`).run(matchId, user.profileId, didWin)
  }
  const othersCampaignBefore = JSON.stringify(db.prepare(`SELECT * FROM campaign_unit_ledger WHERE profile_id <> ? ORDER BY source_id;`).all(target.profileId))
  const progressSql = 'SELECT * FROM profile_progress WHERE profile_id IN (?, ?, ?, ?) ORDER BY profile_id;'
  const othersProgressBefore = JSON.stringify(db.prepare(progressSql).all(friendA.profileId, friendB.profileId, friendC.profileId, neighbour.profileId))
  const winCandidatesBefore = JSON.stringify(db.prepare(LUDO_MATCH_WIN_RECONCILIATION_CANDIDATES_SQL).all())
  const reconciliationParticipantsSql = `
    SELECT lrm.match_id AS match_id, json_extract(je.value, '$.profileId') AS participant, lrm.winner_profile_id AS winner
    FROM ludo_room_matches lrm, json_each(lrm.players_json) je
    WHERE lrm.status = 'finished' AND lrm.winner_profile_id IS NOT NULL AND lrm.match_id IN (?, ?)
    ORDER BY lrm.match_id, participant;`

  await check('[G1] Активна заявка преди крайния срок: връзките и архивите са непроменени, worker-ът не я взема', async () => {
    const created = requestStore.createRequest({ profileId: target.profileId, accountId: target.accountId })
    assert(created.ok, JSON.stringify(created))
    if (!created.ok) return
    try {
      const summary = await makeWorker(executor, [created.request.requestId]).runOnce()
      assertEqual(summary.claimed, 0, 'claim преди срока')
      assert(targetIpBefore === 3 && targetVisitorBefore >= 3, `fixture: ip=${targetIpBefore} visitor=${targetVisitorBefore}`)
      assertEqual(linkCount('profile_ip_links', target.profileId), targetIpBefore, 'IP връзки')
      assertEqual(linkCount('profile_visitor_links', target.profileId), targetVisitorBefore, 'visitor връзки')
      assertEqual(JSON.stringify(privateMatch(privateFour)), JSON.stringify(privateFourBefore), 'частният мач')
    } finally {
      // Отмяна (т. 11): нищо не се променя; после нова, изтичаща заявка.
      const issued = requestStore.issueRestoreToken(target.profileId)
      assert(issued.ok && requestStore.cancelWithToken(issued.restoreToken).ok, 'отмяна')
    }
  })

  await check('[G2] Отменена заявка: след отмяната данните са непокътнати', () => {
    assertEqual(linkCount('profile_ip_links', target.profileId), targetIpBefore, 'IP връзки')
    assertEqual(linkCount('profile_visitor_links', target.profileId), targetVisitorBefore, 'visitor връзки')
    assertEqual(JSON.stringify(ludoMatch(ludoWon).players), JSON.stringify([ludoPlayer(target, 'red'), ludoPlayer(friendA, 'blue')]), 'Ludo')
  })

  const targetRequestId = insertDueRequest(target)

  await check('[G3] Външният дневник (4C) не е потвърден: blocked, НИЩО не е изтрито/анонимизирано', async () => {
    const summary = await makeWorker(executor, [targetRequestId], () => false).runOnce()
    assertEqual(summary.blocked, 1, 'blocked')
    assertEqual((db.prepare('SELECT last_error_code FROM profile_deletion_requests WHERE request_id = ?;').get(targetRequestId) as { last_error_code: string }).last_error_code, 'ledger_offsite_pending', 'код')
    assertEqual(linkCount('profile_ip_links', target.profileId), targetIpBefore, 'IP връзки')
    assertEqual(JSON.stringify(privateMatch(privateFour)), JSON.stringify(privateFourBefore), 'частният мач')
    db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(isoPlus(dbNow(), -1000), targetRequestId)
  })

  // Backup ПРЕДИ окончателното изтриване (заявката вече е в него).
  const backupDir = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-history-backup-'))
  const backupWithRequest = join(backupDir, 'with-request.sqlite')
  db.exec(`VACUUM INTO '${backupWithRequest.replace(/'/g, "''")}';`)

  await runDeletion(targetRequestId)

  await check('[G4] Окончателно изтриване след срока: събитието db_deleted отчита връзките и мачовете (само броячи)', () => {
    const detail = JSON.parse((db.prepare(`SELECT detail_json FROM profile_deletion_events WHERE request_id = ? AND event_type = 'db_deleted';`).get(targetRequestId) as { detail_json: string }).detail_json) as Record<string, unknown>
    assertEqual(detail.identityLinks, targetIpBefore + targetVisitorBefore, 'identityLinks')
    assertEqual(detail.privateMatches, 2, 'privateMatches')
    assertEqual(detail.ludoMatches, 2, 'ludoMatches')
  })

  await check('[V1] Няколко IP адреса на профила — всички изтрити', () => {
    assertEqual(linkCount('profile_ip_links', target.profileId), 0, 'IP връзки')
  })

  await check('[V2] Общ IP / visitor с друг профил — връзките на другия са непокътнати', () => {
    const after = JSON.stringify([
      db.prepare('SELECT * FROM profile_ip_links WHERE profile_id = ? ORDER BY ip_address;').all(neighbour.profileId),
      db.prepare('SELECT * FROM profile_visitor_links WHERE profile_id = ? ORDER BY anonymous_visitor_id;').all(neighbour.profileId),
    ])
    assertEqual(after, neighbourLinksBefore, 'връзките на съседа')
    const risk = db.prepare('SELECT check_complete FROM admin_profile_risk_checks WHERE profile_id = ?;').get(neighbour.profileId) as { check_complete: number }
    assertEqual(risk.check_complete, 0, 'risk cache-ът на съседа е инвалидиран (преди изтриването на връзките)')
  })

  await check('[V3] Няколко visitor идентификатора на профила — всички изтрити', () => {
    assertEqual(linkCount('profile_visitor_links', target.profileId), 0, 'visitor връзки')
  })

  console.log('\n[P] Частни маси')

  await check('[P1] Мач с четирима: изтритият е анонимизиран; другите трима, резултатът, статусът и датите — непроменени', () => {
    const after = privateMatch(privateFour)
    const teamA = JSON.parse(String(after.team_a_json)) as Array<Record<string, unknown>>
    const teamB = JSON.parse(String(after.team_b_json)) as Array<Record<string, unknown>>
    assertEqual(JSON.stringify(teamA[0]), JSON.stringify({ profileId: null, displayName: PROFILE_DELETION_DELETED_LABEL, avatarUrl: null, isBot: false }), 'изтритият')
    assertEqual(JSON.stringify(teamA[1]), JSON.stringify(occupant(friendA)), 'съотборникът')
    assertEqual(JSON.stringify(teamB), JSON.stringify([occupant(friendB), occupant(friendC)]), 'противниците')
    for (const column of ['team_a_score', 'team_b_score', 'status', 'stake', 'started_at', 'finished_at', 'private_room_id']) {
      assertEqual(after[column], privateFourBefore[column], column)
    }
  })

  await check('[P2] Мач с бот (статус playing): анонимизира се само изтритият; несвързан мач — байт по байт непроменен', () => {
    const teamB = JSON.parse(String(privateMatch(privateWithBot).team_b_json)) as Array<Record<string, unknown>>
    assertEqual(teamB[0].displayName, PROFILE_DELETION_DELETED_LABEL, 'изтритият')
    assertEqual(teamB[1].isBot, true, 'ботът е непроменен')
    assertEqual(JSON.stringify(privateMatch(privateUnrelated)), privateUnrelatedBefore, 'несвързаният мач')
  })

  await check('[P3] Последователно изтрити участници в един мач: и двамата анонимизирани, останалите непокътнати', async () => {
    const first = registerUser('SeqA')
    const second = registerUser('SeqB')
    const stay = registerUser('SeqStay')
    const roomId = insertPrivateMatch([occupant(first), occupant(stay)], [occupant(second), botOccupant()])
    await runDeletion(insertDueRequest(first))
    await runDeletion(insertDueRequest(second))
    const after = privateMatch(roomId)
    const teamA = JSON.parse(String(after.team_a_json)) as Array<Record<string, unknown>>
    const teamB = JSON.parse(String(after.team_b_json)) as Array<Record<string, unknown>>
    assertEqual(teamA[0].displayName, PROFILE_DELETION_DELETED_LABEL, 'първият')
    assertEqual(teamB[0].displayName, PROFILE_DELETION_DELETED_LABEL, 'вторият')
    assertEqual(JSON.stringify(teamA[1]), JSON.stringify(occupant(stay)), 'оставащият')
    assert(teamA[0].profileId === null && teamB[0].profileId === null, 'без profileId')
  })

  console.log('\n[L] Ludo')

  await check('[L1] Изтритият е победител: несвързан заместител в players_json И winner_profile_id; без име/аватар; цветът е запазен', () => {
    const { players, winner } = ludoMatch(ludoWon)
    const placeholder = String(players[0].profileId)
    assert(/^deleted-[0-9a-f]{32}$/.test(placeholder), `заместител: ${placeholder}`)
    assertEqual(winner, placeholder, 'победителят е същото място')
    assertEqual(JSON.stringify(players[0]), JSON.stringify({ profileId: placeholder, displayName: PROFILE_DELETION_DELETED_LABEL, avatarUrl: null, color: 'red' }), 'изтритият')
    assertEqual(JSON.stringify(players[1]), JSON.stringify(ludoPlayer(friendA, 'blue')), 'загубилият')
    assertEqual(db.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(placeholder), undefined, 'заместителят не е профил')
  })

  await check('[L2] Изтритият е загубил: победителят и другите трима — непроменени; ставка/дати — непроменени', () => {
    const { players, winner, row } = ludoMatch(ludoLost)
    assertEqual(winner, friendB.profileId, 'победителят')
    assertEqual(players[1].displayName, PROFILE_DELETION_DELETED_LABEL, 'изтритият')
    assertEqual(players[1].avatarUrl, null, 'аватар')
    for (const index of [0, 2, 3]) assertEqual(JSON.stringify(players[index]), JSON.stringify(ludoLostBefore.players[index]), `играч ${index}`)
    for (const column of ['stake', 'status', 'player_count', 'started_at', 'finished_at', 'ludo_room_id']) assertEqual(row[column], ludoLostBefore.row[column], column)
  })

  await check('[L3] Заместителите в различни мачове са различни (без връзка между мачовете)', () => {
    const a = ludoMatch(ludoWon).players[0].profileId
    const b = ludoMatch(ludoLost).players[1].profileId
    assert(typeof a === 'string' && typeof b === 'string' && a !== b, `${String(a)} / ${String(b)}`)
  })

  console.log('\n[C] Кампании и статистики')

  await check('[C1] Начисленията и статистиките на другите са непроменени; reconciliation вижда загубилите с правилно "победа/загуба"', () => {
    assertEqual(JSON.stringify(db.prepare(`SELECT * FROM campaign_unit_ledger WHERE profile_id IS NOT NULL ORDER BY source_id;`).all()), othersCampaignBefore, 'начисленията на другите')
    assertEqual(Number((db.prepare(`SELECT COUNT(*) AS c FROM campaign_unit_ledger WHERE profile_id IS NULL AND source_id = ? AND units_amount = 7;`).get(ludoWon) as { c: number }).c), 1, 'начислението на изтрития остава (SET NULL)')
    assertEqual(JSON.stringify(db.prepare(LUDO_MATCH_WIN_RECONCILIATION_CANDIDATES_SQL).all()), winCandidatesBefore, 'кандидати за победи (статистики)')
    const rows = db.prepare(reconciliationParticipantsSql).all(ludoWon, ludoLost) as Array<{ match_id: string; participant: string; winner: string }>
    const byParticipant = new Map(rows.map((row) => [`${row.match_id}:${row.participant}`, row.participant === row.winner]))
    assertEqual(byParticipant.get(`${ludoWon}:${friendA.profileId}`), false, 'загубилият срещу изтрития победител остава в reconciliation-а (didWin=false)')
    assertEqual(byParticipant.get(`${ludoLost}:${friendB.profileId}`), true, 'победителят')
    assertEqual(byParticipant.get(`${ludoLost}:${friendC.profileId}`), false, 'загубил')
    assertEqual(rows.filter((row) => row.match_id === ludoLost).length, 4, 'всички 4 места в reconciliation-а')
  })

  await check('[C2] Профилите и прогресът на другите участници са непроменени', () => {
    for (const user of [friendA, friendB, friendC, neighbour]) {
      assert(db.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(user.profileId) !== undefined, `профил ${user.displayName}`)
    }
    assertEqual(JSON.stringify(db.prepare(progressSql).all(friendA.profileId, friendB.profileId, friendC.profileId, neighbour.profileId)), othersProgressBefore, 'profile_progress на другите')
  })

  console.log('\n[G] Повторно изпълнение')

  await check('[G5] Повторно пускане на worker-а: без нова обработка, архивите са байт по байт същите', async () => {
    const snapshot = JSON.stringify([privateMatch(privateFour), ludoMatch(ludoWon).row, ludoMatch(ludoLost).row])
    const summary = await makeWorker(executor, [targetRequestId]).runOnce()
    assertEqual(summary.claimed, 0, 'завършената заявка не се взема')
    assertEqual(JSON.stringify([privateMatch(privateFour), ludoMatch(ludoWon).row, ludoMatch(ludoLost).row]), snapshot, 'архивите')
  })

  console.log('\n[X] Остатъчни лични данни')

  await check('[X1] Няма старо име, аватар или profile ID на изтрития в архивите и връзките', () => {
    for (const needle of [target.profileId, target.displayName, target.avatarUrl]) {
      for (const [table, columns] of [
        ['private_room_matches', ['team_a_json', 'team_b_json']],
        ['ludo_room_matches', ['players_json', 'winner_profile_id']],
        ['profile_ip_links', ['profile_id']],
        ['profile_visitor_links', ['profile_id']],
      ] as const) {
        for (const column of columns) {
          const hits = Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE instr(CAST(${column} AS TEXT), ?) > 0;`).get(needle) as { c: number }).c)
          assertEqual(hits, 0, `${table}.${column} съдържа ${needle === target.profileId ? 'profileId' : needle === target.displayName ? 'името' : 'аватара'}`)
        }
      }
    }
  })

  console.log('\n[R] Restore от стар backup')

  await check('[R1] Backup със заявката (преди изтриването): повторното прилагане анонимизира отново, без старото име/аватар/ID', async () => {
    const restored = await createProfileDeletionExecutor(backupWithRequest)
    try {
      const summary = await makeWorker(restored, [targetRequestId]).runOnce()
      assertEqual(summary.completed, 1, `completed (${JSON.stringify(summary)})`)
    } finally {
      restored.close()
    }
    const backupDb = new sqliteModule.DatabaseSync(backupWithRequest, { readOnly: true })
    try {
      const text = JSON.stringify([
        backupDb.prepare('SELECT team_a_json, team_b_json FROM private_room_matches;').all(),
        backupDb.prepare('SELECT players_json, winner_profile_id FROM ludo_room_matches;').all(),
        backupDb.prepare('SELECT profile_id FROM profile_ip_links UNION ALL SELECT profile_id FROM profile_visitor_links;').all(),
      ])
      for (const needle of [target.profileId, target.displayName, target.avatarUrl]) assert(!text.includes(needle), 'остатък в restore-натата база')
      const neighbourCount = Number((backupDb.prepare('SELECT COUNT(*) AS c FROM profile_ip_links WHERE profile_id = ?;').get(neighbour.profileId) as { c: number }).c)
      assertEqual(neighbourCount, 2, 'връзките на съседа в restore-натата база')
    } finally {
      backupDb.close()
    }
  })

  await check('[R2] Backup, по-стар от заявката: replayDeletionForRestore анонимизира мачовете и трие връзките', async () => {
    const victim = registerUser('Replay')
    const other = registerUser('ReplayOther')
    addLinks(victim, ['198.51.100.200'], [`v-${randomUUID()}`])
    const roomId = insertPrivateMatch([occupant(victim), occupant(other)], [botOccupant(), botOccupant()])
    const matchId = insertLudoMatch([ludoPlayer(victim, 'green'), ludoPlayer(other, 'red')], victim.profileId)
    const oldBackup = join(backupDir, 'before-request.sqlite')
    db.exec(`VACUUM INTO '${oldBackup.replace(/'/g, "''")}';`)
    const restored = await createProfileDeletionExecutor(oldBackup)
    try {
      const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(victim.profileId) as { created_at: string }).created_at
      const result = restored.replayDeletionForRestore({ profileId: victim.profileId, accountIdSnapshot: victim.accountId, profileCreatedAtSnapshot: createdAt })
      assertEqual(result.kind, 'deleted', 'replay')
    } finally {
      restored.close()
    }
    const backupDb = new sqliteModule.DatabaseSync(oldBackup, { readOnly: true })
    try {
      const match = backupDb.prepare('SELECT team_a_json FROM private_room_matches WHERE room_id = ?;').get(roomId) as { team_a_json: string }
      const teamA = JSON.parse(match.team_a_json) as Array<Record<string, unknown>>
      assertEqual(teamA[0].displayName, PROFILE_DELETION_DELETED_LABEL, 'частният мач')
      assertEqual(JSON.stringify(teamA[1]), JSON.stringify(occupant(other)), 'другият участник')
      const ludo = backupDb.prepare('SELECT players_json, winner_profile_id FROM ludo_room_matches WHERE match_id = ?;').get(matchId) as { players_json: string; winner_profile_id: string }
      const players = JSON.parse(ludo.players_json) as Array<Record<string, unknown>>
      assertEqual(ludo.winner_profile_id, players[0].profileId, 'победителят е заместителят')
      assertEqual(players[1].profileId, other.profileId, 'другият играч')
      const residual = Number((backupDb.prepare('SELECT COUNT(*) AS c FROM profile_ip_links WHERE profile_id = ?;').get(victim.profileId) as { c: number }).c) +
        Number((backupDb.prepare('SELECT COUNT(*) AS c FROM profile_visitor_links WHERE profile_id = ?;').get(victim.profileId) as { c: number }).c)
      assertEqual(residual, 0, 'връзките')
    } finally {
      backupDb.close()
    }
  })

  console.log('\n[E] Невалидна структура')

  await check('[E1] Архивен запис с профила, но с неочаквана структура: ROLLBACK, failed (не "успешно"), нищо не е изтрито', async () => {
    const user = registerUser('Malformed')
    addLinks(user, ['198.51.100.99'], [])
    const matchId = randomUUID()
    db.prepare(`
      INSERT INTO ludo_room_matches (match_id, ludo_room_id, status, stake, player_count, players_json, winner_profile_id, finished_at)
      VALUES (?, 'r', 'finished', 50, 2, ?, NULL, CURRENT_TIMESTAMP);
    `).run(matchId, JSON.stringify({ seats: { red: { profileId: user.profileId } } }))
    const requestId = insertDueRequest(user)
    const summary = await makeWorker(executor, [requestId]).runOnce()
    assertEqual(summary.failed, 1, `failed (${JSON.stringify(summary)})`)
    const row = db.prepare('SELECT status, last_error_code, db_deleted_at FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, unknown>
    assertEqual(row.status, 'failed', 'статус')
    assertEqual(row.db_deleted_at, null, 'не е отчетено като изтрито')
    assert(db.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(user.profileId) !== undefined, 'профилът съществува (ROLLBACK)')
    assertEqual(linkCount('profile_ip_links', user.profileId), 1, 'връзките са непокътнати (ROLLBACK)')
  })

  await check('[E2] ID само като подниз на друга стойност (не profileId) не се пипа и не блокира изтриването', async () => {
    const user = registerUser('Substr')
    const other = registerUser('SubstrOther')
    const roomId = insertPrivateMatch([{ ...occupant(other), displayName: `x${user.profileId}x` }, botOccupant()], [botOccupant(), botOccupant()])
    const before = JSON.stringify(privateMatch(roomId))
    await runDeletion(insertDueRequest(user))
    assertEqual(JSON.stringify(privateMatch(roomId)), before, 'мачът е непроменен')
  })

  await rm(backupDir, { recursive: true, force: true }).catch(() => {})
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
