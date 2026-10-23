/**
 * checkProfileDeletionNameHistory.ts
 *
 * Самоизтриване, Етап 4E3 — исторически имена при окончателно изтриване:
 *   * profile_name_change_ledger — old/new_display_name -> "Изтрит профил";
 *     сумата, балансът, датата, change_id и snapshot-ът остават;
 *   * campaign_archive_top10 — display_name_at_archive на реда на профила ->
 *     "Изтрит профил"; място, единици, титла и класация остават.
 * САМО временни бази (ensureServerDatabaseReady() върху копие на миграциите).
 *
 * [N] Регистър за смяна на име.  [A] Архив на кампаниите.
 * [P] Отмяна, worker, повторно пускане, restore, rollback, DTO.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileDeletionExecutor, PROFILE_DELETION_DELETED_LABEL, type ProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import { createProfileDeletionRequestStore } from '../src/db/profileDeletionRequestStore.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
import { createProfileDeletionWorker } from '../src/core/profileDeletionWorker.js'
import { createCampaignCreditStore } from '../src/campaigns/campaignCreditStore.js'
import { createCampaignArchiveStore } from '../src/campaigns/campaignArchiveStore.js'
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

const sourceServerRoot = resolve(process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
const SECRET = 'profile-deletion-name-history-secret-0123456789'
const LABEL = PROFILE_DELETION_DELETED_LABEL
const PRICE = 500

console.log('\ncheckProfileDeletionNameHistory')

const root = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-names-'))
await mkdir(join(root, 'database', 'migrations'), { recursive: true })
await mkdir(join(root, 'database', 'data'), { recursive: true })
for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
  if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') {
    await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
  }
}
const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })
const roots: ProfileDeletionUploadRoots = {
  avatars: join(root, 'uploads', 'avatars'),
  profileGallery: join(root, 'uploads', 'profile-gallery'),
  chatAttachments: join(root, 'uploads', 'chat-attachments'),
  topicAttachments: join(root, 'uploads', 'topic-attachments'),
  topicMuteEvidenceAttachments: join(root, 'uploads', 'topic-mute-evidence-attachments'),
  supportAttachments: join(root, 'uploads', 'support-attachments'),
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
const campaignCredit = await createCampaignCreditStore(databaseFilePath)
const archiveStore = await createCampaignArchiveStore(databaseFilePath, campaignCredit)
const executor = await createProfileDeletionExecutor(databaseFilePath)

function makeWorker(exec: ProfileDeletionExecutor, onlyRequestIds: string[]) {
  return createProfileDeletionWorker({
    executor: exec,
    workerId: `w-names-${randomUUID().slice(0, 6)}`,
    uploadRoots: roots,
    removeFile: removeProfileDeletionFile,
    appendLedgerEntry: null,
    onlyRequestIds,
  })
}

type User = { profileId: string; accountId: string; displayName: string }
let counter = 0
function registerUser(label: string): User {
  counter += 1
  const displayName = `Nm${label}${counter}`
  const result = authStore.register({ email: `names-${label.toLowerCase()}-${counter}@example.test`, password: 'secret123', displayName, gender: 'male', visitorId: randomUUID() })
  if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
  const profileId = result.session.profile.profileId as string
  db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 100000) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = 100000;`).run(profileId)
  return { profileId, accountId: result.session.account.accountId, displayName }
}
function rename(user: User, name: string): void {
  const result = progressStore.changeProfileDisplayName(user.profileId, name, PRICE)
  if (!result.ok) throw new Error(`смяна на име ${name}: ${JSON.stringify(result)}`)
  user.displayName = name
}
const dbNow = (database: SqliteDatabase = db) => (database.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
function insertDueRequest(user: User): string {
  const requestId = randomUUID()
  const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
  const scheduledFor = new Date(Date.parse(dbNow()) - 1000).toISOString()
  const requestedAt = new Date(Date.parse(scheduledFor) - PROFILE_DELETION_GRACE_PERIOD_MS).toISOString()
  const guard = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_profile_deletion_requests_insert_guard';`).get() as { sql: string }).sql
  db.exec('DROP TRIGGER trg_profile_deletion_requests_insert_guard;')
  try {
    db.prepare(`INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for) VALUES (?, ?, ?, ?, ?, ?);`)
      .run(requestId, user.profileId, user.accountId, createdAt, requestedAt, scheduledFor)
  } finally {
    db.exec(guard)
  }
  return requestId
}
async function deleteViaWorker(user: User): Promise<string> {
  const requestId = insertDueRequest(user)
  const summary = await makeWorker(executor, [requestId]).runOnce()
  assertEqual(summary.completed, 1, `completed (${JSON.stringify(summary)})`)
  return requestId
}
const all = (sql: string, ...params: Array<string | number>) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>
const json = (sql: string, ...params: Array<string | number>) => JSON.stringify(all(sql, ...params))
const scalar = (sql: string, ...params: Array<string | number>) => Number(Object.values(db.prepare(sql).get(...params) as Record<string, number>)[0])

const LEDGER_COLS = 'change_id, profile_id, deleted_profile_id_snapshot, old_display_name, new_display_name, price_amount, balance_after, created_at'
const ledgerOf = (profileId: string) => all(`SELECT ${LEDGER_COLS} FROM profile_name_change_ledger WHERE profile_id = ?1 OR deleted_profile_id_snapshot = ?1 ORDER BY created_at, change_id;`, profileId)
const ledgerTotals = () => json('SELECT COUNT(*) AS c, COALESCE(SUM(price_amount), 0) AS s, COALESCE(SUM(balance_after), 0) AS b FROM profile_name_change_ledger;')

// Архив: кампания с класация от 10 места.
function createArchivedCampaign(name: string, ranking: User[]): string {
  const campaignId = randomUUID()
  db.prepare(`INSERT INTO campaigns (campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural) VALUES (?, ?, 'finished', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'точка', 'точки');`).run(campaignId, name)
  db.prepare(`INSERT INTO campaign_archive_summary (campaign_id, ended_reason, participants_count, total_units, units_from_belot, units_from_ludo, units_from_purchases, units_from_admin_adjustments, rewards_granted_count, unit_icon_url_at_archive) VALUES (?, 'expired', ?, 0, 0, 0, 0, 0, 0, NULL);`).run(campaignId, ranking.length)
  ranking.forEach((user, index) => {
    db.prepare(`INSERT INTO campaign_archive_top10 (campaign_id, rank, profile_id, display_name_at_archive, rank_title_at_archive, units_total) VALUES (?, ?, ?, ?, ?, ?);`)
      .run(campaignId, index + 1, user.profileId, user.displayName, `Титла${index + 1}`, 1000 - index * 10)
  })
  return campaignId
}
const archiveRows = (campaignId: string) => all('SELECT rank, profile_id, display_name_at_archive, rank_title_at_archive, units_total FROM campaign_archive_top10 WHERE campaign_id = ? ORDER BY rank;', campaignId)

try {
  console.log('\n[N] Регистър за смяна на потребителско име')

  const solo = registerUser('Solo')
  const multi = registerUser('Multi')
  const sharedA = registerUser('ShrA')
  const sharedB = registerUser('ShrB')
  const bystander = registerUser('Bystander')
  const soloOriginal = solo.displayName
  rename(solo, `SoloRenamed${counter}`)
  const multiNames = [multi.displayName]
  for (const step of [1, 2, 3]) {
    rename(multi, `MultiStep${step}x${counter}`)
    multiNames.push(multi.displayName)
  }
  rename(bystander, `BystanderNew${counter}`)
  // Едно и също име в различни периоди: A пуска "SharedName", после B го взима.
  const sharedName = `SharedName${counter}`
  rename(sharedA, sharedName)
  rename(sharedA, `SharedAMoved${counter}`)
  rename(sharedB, sharedName)

  const soloBefore = ledgerOf(solo.profileId)
  const multiBefore = ledgerOf(multi.profileId)
  const othersBefore = json(`SELECT ${LEDGER_COLS} FROM profile_name_change_ledger WHERE profile_id IN (?, ?) ORDER BY change_id;`, bystander.profileId, sharedB.profileId)
  const totalsBefore = ledgerTotals()

  await deleteViaWorker(solo)
  await deleteViaWorker(multi)
  await deleteViaWorker(sharedA)

  await check('[N1] Една платена смяна: двете имена -> "Изтрит профил"; change_id, сума, баланс, дата — непроменени', () => {
    const after = ledgerOf(solo.profileId)
    assertEqual(after.length, 1, 'редове')
    const [b, a] = [soloBefore[0]!, after[0]!]
    assertEqual(a.old_display_name, LABEL, 'старо име')
    assertEqual(a.new_display_name, LABEL, 'ново име')
    for (const key of ['change_id', 'price_amount', 'balance_after', 'created_at'] as const) assertEqual(a[key], b[key], key)
  })

  await check('[N2] Няколко последователни смени: всички редове са заличени, броят и сумите са същите', () => {
    const after = ledgerOf(multi.profileId)
    assertEqual(after.length, multiBefore.length, 'брой')
    assertEqual(after.length, 3, 'три смени')
    for (const [index, row] of after.entries()) {
      assert(row.old_display_name === LABEL && row.new_display_name === LABEL, `ред ${index}`)
      assertEqual(row.price_amount, multiBefore[index]!.price_amount, 'сума')
      assertEqual(row.balance_after, multiBefore[index]!.balance_after, 'баланс')
    }
  })

  await check('[N3] Едно и също име в различни периоди: записите на другия потребител (B) остават с "SharedName" — принадлежността не е по име', () => {
    const bRows = ledgerOf(sharedB.profileId)
    assertEqual(bRows.length, 1, 'B')
    assertEqual(bRows[0]!.new_display_name, sharedName, 'името на B е непроменено')
    assertEqual(bRows[0]!.profile_id, sharedB.profileId, 'B е свързан')
    for (const row of ledgerOf(sharedA.profileId)) assert(row.old_display_name === LABEL && row.new_display_name === LABEL, 'редовете на A')
  })

  await check('[N4] Чуждите записи са байт по байт непроменени', () => {
    assertEqual(json(`SELECT ${LEDGER_COLS} FROM profile_name_change_ledger WHERE profile_id IN (?, ?) ORDER BY change_id;`, bystander.profileId, sharedB.profileId), othersBefore, 'чужди редове')
  })

  await check('[N5] Финансовите стойности: общият брой, сумата и балансите в регистъра са непроменени', () => {
    assertEqual(ledgerTotals(), totalsBefore, 'общо')
  })

  await check('[N6] Snapshot идентификаторите: profile_id е NULL, deleted_profile_id_snapshot = изтрития профил', () => {
    for (const user of [solo, multi, sharedA]) {
      const rows = ledgerOf(user.profileId)
      assert(rows.length > 0, 'редове')
      for (const row of rows) assert(row.profile_id === null && row.deleted_profile_id_snapshot === user.profileId, `snapshot ${user.displayName}`)
    }
  })

  await check('[N7] Оригиналните имена на изтритите липсват в регистъра; имената на другите (вкл. същото име на B) са налице', () => {
    for (const name of [soloOriginal, solo.displayName, ...multiNames, `SharedAMoved${counter}`]) {
      assertEqual(scalar('SELECT COUNT(*) FROM profile_name_change_ledger WHERE old_display_name = ?1 OR new_display_name = ?1;', name), 0, `"${name}"`)
    }
    assertEqual(scalar('SELECT COUNT(*) FROM profile_name_change_ledger WHERE new_display_name = ?;', sharedName), 1, 'името на B')
  })

  console.log('\n[A] Архив на кампаниите')

  const ranking = Array.from({ length: 10 }, (_, index) => registerUser(`Rank${index + 1}`))
  const campaignA = createArchivedCampaign('Архив А', ranking)
  const campaignB = createArchivedCampaign('Архив Б', [ranking[4]!, ranking[0]!, ranking[7]!])
  const archiveABefore = archiveRows(campaignA)
  const archiveBBefore = archiveRows(campaignB)
  const otherCampaignJson = () => json('SELECT * FROM campaign_archive_top10 WHERE campaign_id NOT IN (?, ?) ORDER BY campaign_id, rank;', campaignA, campaignB)
  const otherBefore = otherCampaignJson()
  const firstName = ranking[0]!.displayName
  const fourthName = ranking[3]!.displayName
  const eighthName = ranking[7]!.displayName

  await deleteViaWorker(ranking[0]!) // 1-во място в А, 2-ро в Б
  await check('[A1] Изтрит участник на 1-во място: името -> етикета; мястото, единиците и титлата остават; profile_id е NULL', () => {
    const row = archiveRows(campaignA)[0]!
    assert(row.rank === 1 && row.display_name_at_archive === LABEL && row.profile_id === null, JSON.stringify(row))
    assertEqual(row.units_total, archiveABefore[0]!.units_total, 'единици')
    assertEqual(row.rank_title_at_archive, archiveABefore[0]!.rank_title_at_archive, 'титла')
  })

  await deleteViaWorker(ranking[3]!) // 4-то място
  await check('[A2] Изтрит участник на друго място (4-то): само неговият ред е променен', () => {
    const after = archiveRows(campaignA)
    assertEqual(after[3]!.display_name_at_archive, LABEL, '4-то място')
    for (const index of [1, 2, 4, 5, 6, 8, 9]) assertEqual(JSON.stringify(after[index]), JSON.stringify(archiveABefore[index]), `място ${index + 1}`)
  })

  await deleteViaWorker(ranking[7]!) // 8-мо в А, 3-то в Б
  await check('[A3] Няколко изтрити участници в един архив (1, 4, 8) и в друг архив (2, 3): всички — етикет; останалите — непроменени', () => {
    const a = archiveRows(campaignA)
    for (const index of [0, 3, 7]) assert(a[index]!.display_name_at_archive === LABEL && a[index]!.profile_id === null, `А място ${index + 1}`)
    const b = archiveRows(campaignB)
    assertEqual(b[0]!.display_name_at_archive, archiveBBefore[0]!.display_name_at_archive, 'Б 1-во (жив)')
    assert(b[1]!.display_name_at_archive === LABEL && b[2]!.display_name_at_archive === LABEL, 'Б 2-ро и 3-то')
  })

  await check('[A4] Окончателните класирания: места, единици и титли във всички архиви са непроменени; няма пренареждане/преизчисляване; другите кампании — непокътнати', () => {
    const strip = (rows: Array<Record<string, unknown>>) => JSON.stringify(rows.map((row) => [row.rank, row.units_total, row.rank_title_at_archive]))
    assertEqual(strip(archiveRows(campaignA)), strip(archiveABefore), 'А')
    assertEqual(strip(archiveRows(campaignB)), strip(archiveBBefore), 'Б')
    assertEqual(otherCampaignJson(), otherBefore, 'други кампании')
  })

  await check('[A5] Оригиналните имена на изтритите липсват в обработените архивни редове', () => {
    for (const name of [firstName, fourthName, eighthName]) {
      assertEqual(scalar('SELECT COUNT(*) FROM campaign_archive_top10 WHERE display_name_at_archive = ?;', name), 0, `"${name}"`)
    }
  })

  await check('[A6] DTO на архива (getArchiveDetail): етикет, profileId null, без snapshot/вътрешни идентификатори', () => {
    const detail = archiveStore.getArchiveDetail(campaignA)
    assert(detail !== null, 'архив')
    const first = detail!.top10[0]!
    assert(first.displayNameAtArchive === LABEL && first.profileId === null, JSON.stringify(first))
    const raw = JSON.stringify(detail)
    for (const user of [ranking[0]!, ranking[3]!, ranking[7]!]) assert(!raw.includes(user.profileId), 'UUID на изтрит профил в DTO')
    assert(!raw.includes('snapshot'), 'snapshot поле в DTO')
  })

  console.log('\n[P] Отмяна, worker, restore, rollback')

  await check('[P1] Отмяна преди крайния срок: имената в регистъра и архива са непроменени през периода и след отмяната', async () => {
    const user = registerUser('Cancel')
    rename(user, `CancelRenamed${counter}`)
    const campaign = createArchivedCampaign('Архив отмяна', [user])
    const ledgerBefore = json(`SELECT ${LEDGER_COLS} FROM profile_name_change_ledger WHERE profile_id = ?;`, user.profileId)
    const archiveBefore = JSON.stringify(archiveRows(campaign))
    const created = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    if (!created.ok) throw new Error(JSON.stringify(created))
    assertEqual((await makeWorker(executor, [created.request.requestId]).runOnce()).claimed, 0, 'не е взета преди срока')
    assertEqual(json(`SELECT ${LEDGER_COLS} FROM profile_name_change_ledger WHERE profile_id = ?;`, user.profileId), ledgerBefore, 'регистър през периода')
    assertEqual(JSON.stringify(archiveRows(campaign)), archiveBefore, 'архив през периода')
    const issued = requestStore.issueRestoreToken(user.profileId)
    assert(issued.ok && requestStore.cancelWithToken(issued.restoreToken).ok, 'отмяна')
    assertEqual(json(`SELECT ${LEDGER_COLS} FROM profile_name_change_ledger WHERE profile_id = ?;`, user.profileId), ledgerBefore, 'регистър след отмяна')
    assertEqual(JSON.stringify(archiveRows(campaign)), archiveBefore, 'архив след отмяна')
  })

  await check('[P2] Успешно окончателно изтриване: заявката е completed, профилът липсва, регистърът и архивът са заличени', async () => {
    const user = registerUser('Final')
    rename(user, `FinalRenamed${counter}`)
    const campaign = createArchivedCampaign('Архив финал', [registerUser('Other'), user])
    const requestId = await deleteViaWorker(user)
    assertEqual((db.prepare('SELECT status FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as { status: string }).status, 'completed', 'статус')
    assertEqual(scalar('SELECT COUNT(*) FROM profiles WHERE profile_id = ?;', user.profileId), 0, 'профил')
    assert(ledgerOf(user.profileId).every((row) => row.new_display_name === LABEL), 'регистър')
    assertEqual(archiveRows(campaign)[1]!.display_name_at_archive, LABEL, 'архив')
  })

  await check('[P3] Повторно изпълнение на worker-а: нищо не се взема и нищо не се променя', async () => {
    const snapshot = () => json('SELECT * FROM profile_name_change_ledger ORDER BY change_id;') + json('SELECT * FROM campaign_archive_top10 ORDER BY campaign_id, rank;')
    const before = snapshot()
    const requestIds = (all(`SELECT request_id FROM profile_deletion_requests WHERE status = 'completed';`) as Array<{ request_id: string }>).map((row) => row.request_id)
    assertEqual((await makeWorker(executor, requestIds).runOnce()).claimed, 0, 'нищо не е взето')
    assertEqual(snapshot(), before, 'непроменено')
  })

  await check('[P4] Restore от стара база: replayDeletionForRestore и worker-ът върху възстановената заявка прилагат същото заличаване', async () => {
    const replayUser = registerUser('Replay')
    rename(replayUser, `ReplayRenamed${counter}`)
    const queuedUser = registerUser('Queued')
    rename(queuedUser, `QueuedRenamed${counter}`)
    const campaign = createArchivedCampaign('Архив restore', [replayUser, queuedUser])
    const queuedRequest = insertDueRequest(queuedUser)
    const backupPath = join(root, `backup-${randomUUID()}.sqlite`)
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}';`)
    const restored = await createProfileDeletionExecutor(backupPath)
    const restoredDb = new sqliteModule.DatabaseSync(backupPath, { readOnly: true })
    try {
      const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(replayUser.profileId) as { created_at: string }).created_at
      const result = restored.replayDeletionForRestore({ profileId: replayUser.profileId, accountIdSnapshot: replayUser.accountId, profileCreatedAtSnapshot: createdAt })
      assertEqual(result.kind, 'deleted', 'replay')
      assertEqual((await makeWorker(restored, [queuedRequest]).runOnce()).completed, 1, 'worker върху възстановената заявка')
      const ledger = restoredDb.prepare(`SELECT old_display_name, new_display_name, price_amount FROM profile_name_change_ledger WHERE deleted_profile_id_snapshot IN (?, ?);`).all(replayUser.profileId, queuedUser.profileId) as Array<Record<string, unknown>>
      assert(ledger.length === 2 && ledger.every((row) => row.old_display_name === LABEL && row.new_display_name === LABEL && row.price_amount === PRICE), JSON.stringify(ledger))
      const archive = restoredDb.prepare('SELECT display_name_at_archive, profile_id FROM campaign_archive_top10 WHERE campaign_id = ? ORDER BY rank;').all(campaign) as Array<Record<string, unknown>>
      assert(archive.every((row) => row.display_name_at_archive === LABEL && row.profile_id === null), JSON.stringify(archive))
    } finally {
      restoredDb.close()
      restored.close()
    }
  })

  await check('[P5] Грешка по време на изтриването (архивът е променен извън заличаването): ROLLBACK, failed; имената, сумите и профилът са непокътнати', async () => {
    const user = registerUser('Rollback')
    rename(user, `RollbackRenamed${counter}`)
    const bystanderRow = registerUser('RollbackOther')
    const campaign = createArchivedCampaign('Архив rollback', [user, bystanderRow])
    const ledgerBefore = json(`SELECT ${LEDGER_COLS} FROM profile_name_change_ledger WHERE profile_id = ?;`, user.profileId)
    const archiveBefore = JSON.stringify(archiveRows(campaign))
    db.exec(`CREATE TRIGGER trg_test_tamper_archive AFTER DELETE ON profiles WHEN OLD.profile_id = '${user.profileId}'
      BEGIN UPDATE campaign_archive_top10 SET units_total = units_total + 1 WHERE campaign_id = '${campaign}' AND rank = 2; END;`)
    let requestId = ''
    try {
      requestId = insertDueRequest(user)
      const summary = await makeWorker(executor, [requestId]).runOnce()
      assertEqual(summary.failed, 1, `failed (${JSON.stringify(summary)})`)
    } finally {
      db.exec('DROP TRIGGER trg_test_tamper_archive;')
    }
    const row = db.prepare('SELECT status, db_deleted_at, last_error_code FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, unknown>
    assert(row.status === 'failed' && row.db_deleted_at === null && row.last_error_code === 'db_phase_error', JSON.stringify(row))
    assertEqual(scalar('SELECT COUNT(*) FROM profiles WHERE profile_id = ?;', user.profileId), 1, 'профилът')
    assertEqual(json(`SELECT ${LEDGER_COLS} FROM profile_name_change_ledger WHERE profile_id = ?;`, user.profileId), ledgerBefore, 'регистърът (имена и суми)')
    assertEqual(JSON.stringify(archiveRows(campaign)), archiveBefore, 'архивът')
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const store of [executor, requestStore, authStore, progressStore] as Array<{ close: () => void }>) {
    try { store.close() } catch { /* ignore */ }
  }
  db.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
