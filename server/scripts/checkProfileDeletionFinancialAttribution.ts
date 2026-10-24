/**
 * checkProfileDeletionFinancialAttribution.ts
 *
 * Самоизтриване на профили — Етап 4E2 (одит P5, решения 5 и 6):
 *   * ludo_match_economy_ledger: SET NULL + deleted_profile_id_snapshot
 *     (миграция 20261027_001) вместо CASCADE;
 *   * кампании: snapshot в campaign_unit_ledger, campaign_reward_claims,
 *     campaign_manual_adjustments; известията на изтрития се трият;
 *   * вече предоставените награди на изтрит профил не се показват като
 *     "дължими" и не се начисляват отново;
 *   * финансов инвариант преди COMMIT (иначе ROLLBACK).
 * САМО временни бази (ensureServerDatabaseReady() върху копие на миграциите).
 *
 * [M] Миграция.  [L] Ludo регистър.  [C] Кампании.  [G] Worker, restore, инварианти.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createLudoEconomyStore } from '../src/db/ludoEconomyStore.js'
import { createCampaignCreditStore } from '../src/campaigns/campaignCreditStore.js'
import { createProfileDeletionExecutor, type ProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
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
const SECRET = 'profile-deletion-financial-test-secret-0123456789'
const NEW_MIGRATION = '20261027_001_preserve_ludo_and_campaign_financial_attribution.sql'

console.log('\ncheckProfileDeletionFinancialAttribution')
console.log(`Server root: ${sourceServerRoot}`)

const tempRoots: string[] = []
async function createTempServerRoot(filter: (name: string) => boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-financial-'))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql' && filter(entry.name)) {
      await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
    }
  }
  return root
}

const sqliteModule = await import('node:sqlite')
const root = await createTempServerRoot(() => true)
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

const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

const progressStore = await createPlayerProgressStore(databaseFilePath)
const authStore = await createAuthStore(databaseFilePath, progressStore, {
  registrationVerificationCodeSecret: SECRET,
  getRegistrationVerificationMode: () => 'direct',
  getActiveBanForProfile: () => null,
})
const ludoEconomy = await createLudoEconomyStore(databaseFilePath)
const campaignCredit = await createCampaignCreditStore(databaseFilePath)
const executor = await createProfileDeletionExecutor(databaseFilePath)

function makeWorker(exec: ProfileDeletionExecutor, onlyRequestIds: string[]) {
  return createProfileDeletionWorker({
    executor: exec,
    workerId: `w-fin-${randomUUID().slice(0, 6)}`,
    uploadRoots: roots,
    removeFile: removeProfileDeletionFile,
    appendLedgerEntry: null,
    onlyRequestIds,
  })
}

type User = { profileId: string; accountId: string; displayName: string }
let counter = 0
function registerUser(label: string, coins = 0): User {
  counter += 1
  const displayName = `Fin${label}${counter}`
  const result = authStore.register({ email: `fin-${label.toLowerCase()}-${counter}@example.test`, password: 'secret123', displayName, gender: 'male', visitorId: randomUUID() })
  if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
  const profileId = result.session.profile.profileId as string
  if (coins > 0) {
    db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance;`).run(profileId, coins)
  }
  return { profileId, accountId: result.session.account.accountId, displayName }
}

function dbNow(database: SqliteDatabase = db): string {
  return (database.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
}

function insertDueRequest(user: User, database: SqliteDatabase = db): string {
  const requestId = randomUUID()
  const createdAt = (database.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
  const scheduledFor = new Date(Date.parse(dbNow(database)) - 1000).toISOString()
  const requestedAt = new Date(Date.parse(scheduledFor) - PROFILE_DELETION_GRACE_PERIOD_MS).toISOString()
  const triggerSql = (database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_profile_deletion_requests_insert_guard';`).get() as { sql: string }).sql
  database.exec('DROP TRIGGER trg_profile_deletion_requests_insert_guard;')
  try {
    database.prepare(`
      INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for)
      VALUES (?, ?, ?, ?, ?, ?);
    `).run(requestId, user.profileId, user.accountId, createdAt, requestedAt, scheduledFor)
  } finally {
    database.exec(triggerSql)
  }
  return requestId
}

async function deleteViaWorker(user: User): Promise<string> {
  const requestId = insertDueRequest(user)
  const summary = await makeWorker(executor, [requestId]).runOnce()
  assertEqual(summary.completed, 1, `completed (${JSON.stringify(summary)})`)
  return requestId
}

const rows = (sql: string, ...params: string[]) => JSON.stringify(db.prepare(sql).all(...params))
const count = (sql: string, ...params: string[]) => Number((db.prepare(sql).get(...params) as { c: number }).c)

function playLudoMatch(players: User[], stake: number, winner: User | null): string {
  const matchId = randomUUID()
  const collected = ludoEconomy.collectLudoMatchStakes(matchId, players.map((p) => p.profileId), stake)
  assert(collected.ok, `stake: ${JSON.stringify(collected)}`)
  if (winner !== null) {
    const payout = ludoEconomy.payoutLudoMatchWinner(matchId, winner.profileId)
    assert(payout.ok, `payout: ${JSON.stringify(payout)}`)
  }
  return matchId
}

try {
  console.log('\n[M] Миграция 20261027_001')

  await check('[M1] Upgrade със съществуващи Ludo и кампанийни записи: стойностите са байт по байт запазени, SET NULL + snapshot', async () => {
    const upgradeRoot = await createTempServerRoot((name) => name.localeCompare(NEW_MIGRATION, 'en') < 0)
    const { databaseFilePath: upgradePath } = await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
    const up = new sqliteModule.DatabaseSync(upgradePath, { open: true, enableForeignKeyConstraints: true })
    up.exec('PRAGMA foreign_keys = ON;')
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    for (const id of ids) up.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?);`).run(id, `U${id.slice(0, 6)}`, `u${id.slice(0, 6)}`)
    const ins = up.prepare(`INSERT INTO ludo_match_economy_ledger (ledger_id, match_id, profile_id, entry_type, amount, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);`)
    ins.run('l1', 'm1', ids[0], 'ludo_stake_debit', 100, 900, '2026-05-01 10:00:00')
    ins.run('l2', 'm1', ids[1], 'ludo_stake_debit', 100, 400, '2026-05-01 10:00:00')
    ins.run('l3', 'm1', ids[0], 'ludo_winner_payout', 180, 1080, '2026-05-01 10:30:00')
    ins.run('l4', 'm2', ids[2], 'ludo_stake_debit', 50, 0, '2026-05-02 11:00:00')
    up.prepare(`INSERT INTO campaigns (campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural) VALUES ('c1', 'К', 'active', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'т', 'т');`).run()
    up.prepare(`INSERT INTO campaign_unit_ledger (campaign_id, profile_id, source_type, source_id, units_amount, event_at) VALUES ('c1', ?, 'ludo_win', 'm1', 3, '2026-05-01T10:30:00.000Z');`).run(ids[0])
    up.prepare(`INSERT INTO campaign_manual_adjustments (adjustment_id, campaign_id, profile_id, units_delta, reason, admin_profile_id) VALUES ('a1', 'c1', ?, 5, 'бонус', ?);`).run(ids[1], ids[2])
    const ledgerBefore = JSON.stringify(up.prepare('SELECT ledger_id, match_id, profile_id, entry_type, amount, balance_after, created_at FROM ludo_match_economy_ledger ORDER BY ledger_id;').all())
    const unitsBefore = JSON.stringify(up.prepare('SELECT campaign_id, profile_id, source_type, source_id, units_amount, event_at, created_at FROM campaign_unit_ledger;').all())
    const adjBefore = JSON.stringify(up.prepare('SELECT adjustment_id, campaign_id, profile_id, units_delta, reason, admin_profile_id, created_at FROM campaign_manual_adjustments;').all())
    up.close()
    await cp(join(sourceServerRoot, 'database', 'migrations', NEW_MIGRATION), join(upgradeRoot, 'database', 'migrations', NEW_MIGRATION))
    await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
    const after = new sqliteModule.DatabaseSync(upgradePath, { open: true, enableForeignKeyConstraints: true })
    try {
      after.exec('PRAGMA foreign_keys = ON;')
      assertEqual(JSON.stringify(after.prepare('SELECT ledger_id, match_id, profile_id, entry_type, amount, balance_after, created_at FROM ludo_match_economy_ledger ORDER BY ledger_id;').all()), ledgerBefore, 'Ludo редовете')
      assertEqual(JSON.stringify(after.prepare('SELECT campaign_id, profile_id, source_type, source_id, units_amount, event_at, created_at FROM campaign_unit_ledger;').all()), unitsBefore, 'кампанийни единици')
      assertEqual(JSON.stringify(after.prepare('SELECT adjustment_id, campaign_id, profile_id, units_delta, reason, admin_profile_id, created_at FROM campaign_manual_adjustments;').all()), adjBefore, 'ръчни корекции')
      assertEqual(Number((after.prepare('SELECT COUNT(*) AS c FROM ludo_match_economy_ledger WHERE deleted_profile_id_snapshot IS NOT NULL;').get() as { c: number }).c), 0, 'snapshot е NULL')
      const fk = after.prepare(`SELECT on_delete FROM pragma_foreign_key_list('ludo_match_economy_ledger') WHERE "from" = 'profile_id';`).get() as { on_delete: string }
      assertEqual(fk.on_delete, 'SET NULL', 'FK')
      for (const index of ['idx_ludo_match_economy_ledger_profile_id', 'idx_ludo_match_economy_ledger_match_id', 'idx_ludo_match_economy_ledger_deleted_profile_snapshot']) {
        assert(after.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?;`).get(index) !== undefined, index)
      }
      assert(after.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ludo_match_economy_ledger' AND sql IS NULL;`).get() !== undefined, 'UNIQUE(match_id, profile_id, entry_type) е запазен')
      assertEqual((after.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
      // Изтриване на профил след миграцията: редовете остават (вече не CASCADE).
      after.prepare('DELETE FROM profiles WHERE profile_id = ?;').run(ids[0])
      assertEqual(Number((after.prepare(`SELECT COUNT(*) AS c FROM ludo_match_economy_ledger WHERE ledger_id IN ('l1', 'l3') AND profile_id IS NULL;`).get() as { c: number }).c), 2, 'редовете на изтрития остават')
    } finally {
      after.close()
    }
  })

  await check('[M2] Неочаквана схема (база без новите колони): executor-ът отказва още при създаване — нищо не се изтрива', async () => {
    const oldRoot = await createTempServerRoot((name) => name.localeCompare(NEW_MIGRATION, 'en') < 0)
    const { databaseFilePath: oldPath } = await ensureServerDatabaseReady({ serverRootOverride: oldRoot })
    let refused = false
    try {
      const old = await createProfileDeletionExecutor(oldPath)
      old.close()
    } catch (error) {
      refused = error instanceof Error && /no such column|no such table|deleted_profile_id_snapshot/.test(error.message)
    }
    assert(refused, 'executor-ът се създаде върху стара схема')
  })

  console.log('\n[L] Ludo финансов регистър')

  const winner = registerUser('Winner', 5000)
  const loser = registerUser('Loser', 5000)
  const bystander = registerUser('Bystander', 5000)
  const fourth = registerUser('Fourth', 5000)
  const matchWon = playLudoMatch([winner, bystander], 100, winner)
  const matchLost = playLudoMatch([loser, bystander, fourth, winner], 200, bystander)
  const ledgerSql = 'SELECT ledger_id, match_id, profile_id, deleted_profile_id_snapshot, entry_type, amount, balance_after, created_at FROM ludo_match_economy_ledger WHERE match_id = ? ORDER BY ledger_id;'
  const matchWonBefore = db.prepare(ledgerSql).all(matchWon) as Array<Record<string, unknown>>
  const matchLostBefore = db.prepare(ledgerSql).all(matchLost) as Array<Record<string, unknown>>
  const potLostBefore = ludoEconomy.getLudoMatchTotalPot(matchLost)
  const bystanderRowsBefore = rows('SELECT * FROM ludo_match_economy_ledger WHERE profile_id = ? ORDER BY ledger_id;', bystander.profileId)
  const totalLudoBefore = rows('SELECT COUNT(*) AS c, SUM(amount) AS s FROM ludo_match_economy_ledger;')

  // Кампания: прагове 10 -> 100 жълтици, 20 -> 3 дни VIP, 30 -> подарък.
  const admin = registerUser('Admin')
  const marketing = registerUser('Marketing')
  db.prepare(`UPDATE accounts SET role = 'marketing' WHERE account_id = ?;`).run(marketing.accountId)
  const giftItemId = randomUUID()
  db.prepare(`INSERT INTO gift_items (gift_item_id, name, image_url, price) VALUES (?, 'Тиква', '/uploads/gift-items/p.webp', 10);`).run(giftItemId)
  const campaignId = randomUUID()
  db.prepare(`INSERT INTO campaigns (campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural, gift_sender_profile_id) VALUES (?, 'Есен', 'active', '2026-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z', 'тиква', 'тикви', ?);`).run(campaignId, marketing.profileId)
  const tierRewardIds: Record<string, string> = {}
  for (const [threshold, type, payload] of [[10, 'yellow_coins', { amount: 100 }], [20, 'vip_days', { unit: 'days', amount: 3 }], [30, 'gift_item', { giftItemId }]] as const) {
    const tierId = randomUUID()
    const tierRewardId = randomUUID()
    db.prepare(`INSERT INTO campaign_reward_tiers (tier_id, campaign_id, threshold_units) VALUES (?, ?, ?);`).run(tierId, campaignId, threshold)
    db.prepare(`INSERT INTO campaign_tier_rewards (tier_reward_id, tier_id, reward_type, reward_payload_json) VALUES (?, ?, ?, ?);`).run(tierRewardId, tierId, type, JSON.stringify(payload))
    tierRewardIds[type] = tierRewardId
  }
  const keeper = registerUser('Keeper')
  for (const user of [winner, keeper]) {
    const adjusted = campaignCredit.applyManualAdjustment({ campaignId, profileId: user.profileId, unitsDelta: 35, reason: 'Ръчна корекция', adminProfileId: admin.profileId })
    assert(adjusted.ok, `корекция: ${JSON.stringify(adjusted)}`)
  }
  const claimsSql = 'SELECT campaign_id, profile_id, deleted_profile_id_snapshot, tier_reward_id, granted_reward_ref, claimed_at FROM campaign_reward_claims WHERE campaign_id = ? ORDER BY tier_reward_id, profile_id;'
  const winnerClaimsBefore = db.prepare('SELECT tier_reward_id, granted_reward_ref, claimed_at FROM campaign_reward_claims WHERE profile_id = ? ORDER BY tier_reward_id;').all(winner.profileId) as Array<Record<string, unknown>>
  const keeperCampaignBefore = JSON.stringify([
    db.prepare('SELECT * FROM campaign_reward_claims WHERE profile_id = ? ORDER BY tier_reward_id;').all(keeper.profileId),
    db.prepare('SELECT * FROM campaign_unit_ledger WHERE profile_id = ? ORDER BY source_id;').all(keeper.profileId),
    db.prepare('SELECT * FROM campaign_profile_totals WHERE profile_id = ?;').all(keeper.profileId),
    db.prepare('SELECT * FROM campaign_manual_adjustments WHERE profile_id = ?;').all(keeper.profileId),
    db.prepare('SELECT * FROM campaign_reward_notifications WHERE profile_id = ?;').all(keeper.profileId),
    db.prepare(`SELECT * FROM gift_item_transactions WHERE recipient_profile_id = ? AND context = 'campaign_reward';`).all(keeper.profileId),
    db.prepare(`SELECT * FROM vip_grants WHERE profile_id = ?;`).all(keeper.profileId),
  ])
  const winnerVipGrant = db.prepare(`SELECT grant_id FROM vip_grants WHERE profile_id = ? AND reason = 'campaign_reward';`).get(winner.profileId) as { grant_id: string }
  const winnerGiftTx = db.prepare(`SELECT transaction_id FROM gift_item_transactions WHERE recipient_profile_id = ? AND context = 'campaign_reward';`).get(winner.profileId) as { transaction_id: string }
  const winnerAdjustment = db.prepare('SELECT adjustment_id, units_delta, reason, admin_profile_id FROM campaign_manual_adjustments WHERE profile_id = ?;').get(winner.profileId) as Record<string, unknown>
  const campaignUnitsTotalBefore = count('SELECT COALESCE(SUM(units_amount), 0) AS c FROM campaign_unit_ledger WHERE campaign_id = ?;', campaignId)
  const notificationsWinnerBefore = count('SELECT COUNT(*) AS c FROM campaign_reward_notifications WHERE profile_id = ?;', winner.profileId)

  // Backup ПРЕДИ изтриването — за restore сценария [G2].
  const backupDir = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-financial-backup-'))
  tempRoots.push(backupDir)
  const winnerRequestId = insertDueRequest(winner)
  const backupWithRequest = join(backupDir, 'with-request.sqlite')
  db.exec(`VACUUM INTO '${backupWithRequest.replace(/'/g, "''")}';`)
  const summaryWinner = await makeWorker(executor, [winnerRequestId]).runOnce()

  await check('[L1] Изтрит победител: входната такса и печалбата остават — profile_id NULL, snapshot, суми/салда/дати/мач непроменени', () => {
    assertEqual(summaryWinner.completed, 1, `completed (${JSON.stringify(summaryWinner)})`)
    const after = db.prepare(ledgerSql).all(matchWon) as Array<Record<string, unknown>>
    assertEqual(after.length, matchWonBefore.length, 'брой редове')
    for (let index = 0; index < after.length; index += 1) {
      const b = matchWonBefore[index]
      const a = after[index]
      for (const column of ['ledger_id', 'match_id', 'entry_type', 'amount', 'balance_after', 'created_at']) assertEqual(a[column], b[column], `${String(b.entry_type)}.${column}`)
      if (b.profile_id === winner.profileId) {
        assertEqual(a.profile_id, null, 'profile_id')
        assertEqual(a.deleted_profile_id_snapshot, winner.profileId, 'snapshot')
      } else {
        assertEqual(a.profile_id, b.profile_id, 'другият играч')
      }
    }
    assertEqual(after.filter((row) => row.deleted_profile_id_snapshot === winner.profileId && row.entry_type === 'ludo_winner_payout').length, 1, 'печалбата')
  })

  await check('[L2] Записите на останалите участници са байт по байт непроменени; общите суми на регистъра — също', () => {
    assertEqual(rows('SELECT * FROM ludo_match_economy_ledger WHERE profile_id = ? ORDER BY ledger_id;', bystander.profileId), bystanderRowsBefore, 'bystander')
    assertEqual(rows('SELECT COUNT(*) AS c, SUM(amount) AS s FROM ludo_match_economy_ledger;'), totalLudoBefore, 'общо')
  })

  await check('[L3] Изтрит участник, платил само входна такса (загубил), и второ изтриване в същия мач: банката е непроменена', async () => {
    await deleteViaWorker(loser)
    await deleteViaWorker(fourth)
    const after = db.prepare(ledgerSql).all(matchLost) as Array<Record<string, unknown>>
    assertEqual(after.length, matchLostBefore.length, 'брой редове')
    assertEqual(after.filter((row) => row.profile_id === null).length, 3, 'трима изтрити (loser, fourth, winner)')
    for (const deleted of [loser, fourth]) {
      const row = after.find((candidate) => candidate.deleted_profile_id_snapshot === deleted.profileId)
      assert(row !== undefined && row.entry_type === 'ludo_stake_debit' && row.amount === 200, `ставката на ${deleted.displayName}`)
    }
    assertEqual(ludoEconomy.getLudoMatchTotalPot(matchLost), potLostBefore, 'банката (сума на ставките)')
  })

  await check('[L4] Съвместимост след миграцията: нов мач (дебит + печалба) работи; повторно изплащане/дебит не дублира', () => {
    const a = registerUser('NewA', 1000)
    const b = registerUser('NewB', 1000)
    const matchId = playLudoMatch([a, b], 100, a)
    const balance = ludoEconomy.getWalletBalance(a.profileId)
    const again = ludoEconomy.payoutLudoMatchWinner(matchId, a.profileId)
    assert(again.ok && again.alreadyPaid, `повторно изплащане: ${JSON.stringify(again)}`)
    assertEqual(ludoEconomy.getWalletBalance(a.profileId), balance, 'без двойно начисляване')
    const recollect = ludoEconomy.collectLudoMatchStakes(matchId, [a.profileId, b.profileId], 100)
    assert(recollect.ok, 'повторен дебит е идемпотентен')
    assertEqual(count('SELECT COUNT(*) AS c FROM ludo_match_economy_ledger WHERE match_id = ?;', matchId), 3, 'точно 2 дебита + 1 печалба')
  })

  console.log('\n[C] Кампании')

  await check('[C1] Награда в жълтици: claim-ът остава (snapshot, granted_reward_ref и дата непроменени)', () => {
    const claim = db.prepare('SELECT profile_id, deleted_profile_id_snapshot, granted_reward_ref, claimed_at FROM campaign_reward_claims WHERE tier_reward_id = ? AND deleted_profile_id_snapshot = ?;').get(tierRewardIds.yellow_coins, winner.profileId) as Record<string, unknown> | undefined
    assert(claim !== undefined, 'claim-ът за жълтиците')
    const before = winnerClaimsBefore.find((row) => row.tier_reward_id === tierRewardIds.yellow_coins) as Record<string, unknown>
    assertEqual(claim?.profile_id, null, 'profile_id')
    assertEqual(claim?.granted_reward_ref, before.granted_reward_ref, 'granted_reward_ref')
    assertEqual(claim?.claimed_at, before.claimed_at, 'claimed_at')
  })

  await check('[C2] VIP награда: vip_grants и claim-ът остават със snapshot', () => {
    const grant = db.prepare('SELECT profile_id, deleted_profile_id_snapshot, reason, interval_amount FROM vip_grants WHERE grant_id = ?;').get(winnerVipGrant.grant_id) as Record<string, unknown>
    assertEqual(grant.profile_id, null, 'vip_grants.profile_id')
    assertEqual(grant.deleted_profile_id_snapshot, winner.profileId, 'vip_grants snapshot')
    assertEqual(grant.reason, 'campaign_reward', 'причина')
    assertEqual(count('SELECT COUNT(*) AS c FROM campaign_reward_claims WHERE tier_reward_id = ? AND deleted_profile_id_snapshot = ?;', tierRewardIds.vip_days, winner.profileId), 1, 'claim')
  })

  await check('[C3] Подаръчна награда: транзакцията остава (получател NULL), claim-ът е със snapshot', () => {
    const tx = db.prepare('SELECT recipient_profile_id, sender_profile_id, context, charged_price FROM gift_item_transactions WHERE transaction_id = ?;').get(winnerGiftTx.transaction_id) as Record<string, unknown>
    assertEqual(tx.recipient_profile_id, null, 'получател')
    assertEqual(tx.sender_profile_id, marketing.profileId, 'подател')
    assertEqual(tx.context, 'campaign_reward', 'контекст')
    assertEqual(count('SELECT COUNT(*) AS c FROM campaign_reward_claims WHERE tier_reward_id = ? AND deleted_profile_id_snapshot = ?;', tierRewardIds.gift_item, winner.profileId), 1, 'claim')
  })

  await check('[C4] Ръчна корекция: остава със snapshot; сума, причина и администратор — непроменени', () => {
    const adjustment = db.prepare('SELECT profile_id, deleted_profile_id_snapshot, units_delta, reason, admin_profile_id FROM campaign_manual_adjustments WHERE adjustment_id = ?;').get(String(winnerAdjustment.adjustment_id)) as Record<string, unknown>
    assertEqual(adjustment.profile_id, null, 'profile_id')
    assertEqual(adjustment.deleted_profile_id_snapshot, winner.profileId, 'snapshot')
    for (const column of ['units_delta', 'reason', 'admin_profile_id']) assertEqual(adjustment[column], winnerAdjustment[column], column)
  })

  await check('[C5] Единиците на изтрития остават (snapshot), общият сбор на кампанията е непроменен; известията му са изтрити', () => {
    assertEqual(count('SELECT COUNT(*) AS c FROM campaign_unit_ledger WHERE profile_id IS NULL AND deleted_profile_id_snapshot = ? AND units_amount = 35;', winner.profileId), 1, 'единиците')
    assertEqual(count('SELECT COALESCE(SUM(units_amount), 0) AS c FROM campaign_unit_ledger WHERE campaign_id = ?;', campaignId), campaignUnitsTotalBefore, 'сбор на кампанията')
    assert(notificationsWinnerBefore > 0, 'fixture: имало е известия')
    assertEqual(count(`SELECT COUNT(*) AS c FROM campaign_reward_notifications WHERE profile_id IS NULL;`), 0, 'известия без получател')
  })

  await check('[C6] Наградите, единиците, корекцията, известията, подаръкът и VIP-ът на друг профил са байт по байт непроменени', () => {
    const after = JSON.stringify([
      db.prepare('SELECT * FROM campaign_reward_claims WHERE profile_id = ? ORDER BY tier_reward_id;').all(keeper.profileId),
      db.prepare('SELECT * FROM campaign_unit_ledger WHERE profile_id = ? ORDER BY source_id;').all(keeper.profileId),
      db.prepare('SELECT * FROM campaign_profile_totals WHERE profile_id = ?;').all(keeper.profileId),
      db.prepare('SELECT * FROM campaign_manual_adjustments WHERE profile_id = ?;').all(keeper.profileId),
      db.prepare('SELECT * FROM campaign_reward_notifications WHERE profile_id = ?;').all(keeper.profileId),
      db.prepare(`SELECT * FROM gift_item_transactions WHERE recipient_profile_id = ? AND context = 'campaign_reward';`).all(keeper.profileId),
      db.prepare(`SELECT * FROM vip_grants WHERE profile_id = ?;`).all(keeper.profileId),
    ])
    assertEqual(after, keeperCampaignBefore, 'keeper')
  })

  await check('[C7] Вече предоставените награди на изтрития НЕ изглеждат "дължими" (не блокират архива, не са в retry списъка)', () => {
    const gaps = campaignCredit.listPendingGiftRewardGaps(campaignId)
    assertEqual(gaps.length, 0, `дължими подаръци: ${JSON.stringify(gaps)}`)
    assertEqual(campaignCredit.listPendingGiftRewardGaps().filter((gap) => gap.profileId === null).length, 0, 'без получател (всички кампании)')
  })

  await check('[C8] Без ново начисляване за изтрития: credit -> ineligible; ръчна корекция и retry не създават редове/награди', () => {
    const ledgerBefore = rows('SELECT * FROM campaign_unit_ledger ORDER BY source_id, profile_id;')
    const giftBefore = count('SELECT COUNT(*) AS c FROM gift_item_transactions;')
    const credit = campaignCredit.creditCampaignUnits({ profileId: winner.profileId, sourceType: 'ludo_win', sourceId: matchWon, eventAt: new Date(), stakeAmount: 100, didWin: true })
    assert(!credit.ok && credit.reason === 'ineligible_profile', JSON.stringify(credit))
    let adjustmentRefused = false
    try {
      const adjusted = campaignCredit.applyManualAdjustment({ campaignId, profileId: winner.profileId, unitsDelta: 5, reason: 'x', adminProfileId: admin.profileId })
      adjustmentRefused = !adjusted.ok
    } catch {
      adjustmentRefused = true // FK: профилът не съществува
    }
    assert(adjustmentRefused, 'ръчна корекция за изтрит профил')
    let retryRefused = false
    try {
      const retry = campaignCredit.retryPendingGiftReward(campaignId, winner.profileId, tierRewardIds.gift_item)
      retryRefused = !retry.ok
    } catch {
      retryRefused = true
    }
    assert(retryRefused, 'retry на подаръчна награда за изтрит профил')
    assertEqual(rows('SELECT * FROM campaign_unit_ledger ORDER BY source_id, profile_id;'), ledgerBefore, 'кампанийните единици')
    assertEqual(count('SELECT COUNT(*) AS c FROM gift_item_transactions;'), giftBefore, 'подаръци')
  })

  await check('[C9] 4E1 заместител в Ludo историята: reconciliation-ът го вижда, но не начислява (ineligible), останалите резултати са непроменени', () => {
    const won = db.prepare('SELECT players_json, winner_profile_id FROM ludo_room_matches WHERE match_id = ?;').get(matchWon) as { players_json: string; winner_profile_id: string } | undefined
    // Ludo историята (4E1) се пише от index.ts — тук симулираме записа и анонимизирането.
    const placeholder = `deleted-${randomUUID().replace(/-/g, '')}`
    if (won === undefined) {
      db.prepare(`INSERT INTO ludo_room_matches (match_id, ludo_room_id, status, stake, player_count, players_json, winner_profile_id, finished_at) VALUES (?, 'r', 'finished', 100, 2, ?, ?, CURRENT_TIMESTAMP);`)
        .run(matchWon, JSON.stringify([{ profileId: placeholder, displayName: 'Изтрит профил', avatarUrl: null, color: 'red' }, { profileId: bystander.profileId, displayName: bystander.displayName, avatarUrl: null, color: 'blue' }]), placeholder)
    }
    const credit = campaignCredit.creditCampaignUnits({ profileId: placeholder, sourceType: 'ludo_win', sourceId: matchWon, eventAt: new Date(), stakeAmount: 100, didWin: true })
    assert(!credit.ok && credit.reason === 'ineligible_profile', JSON.stringify(credit))
    assertEqual(count('SELECT COUNT(*) AS c FROM campaign_unit_ledger WHERE profile_id = ?;', placeholder), 0, 'без начисление за заместителя')
  })

  console.log('\n[G] Worker, restore, инварианти')

  await check('[G1] Повторно пускане на worker-а: без нови/дублирани финансови записи', async () => {
    const snapshot = JSON.stringify([rows('SELECT * FROM ludo_match_economy_ledger ORDER BY ledger_id;'), rows(claimsSql, campaignId), rows('SELECT * FROM campaign_unit_ledger ORDER BY source_id, profile_id;')])
    const summary = await makeWorker(executor, [winnerRequestId]).runOnce()
    assertEqual(summary.claimed, 0, 'завършената заявка не се взема')
    assertEqual(JSON.stringify([rows('SELECT * FROM ludo_match_economy_ledger ORDER BY ledger_id;'), rows(claimsSql, campaignId), rows('SELECT * FROM campaign_unit_ledger ORDER BY source_id, profile_id;')]), snapshot, 'регистрите')
  })

  await check('[G2] Restore на стара база (заявката е в backup-а): повторното прилагане запазва атрибуцията същата като в живата база', async () => {
    const restored = await createProfileDeletionExecutor(backupWithRequest)
    try {
      const summary = await makeWorker(restored, [winnerRequestId]).runOnce()
      assertEqual(summary.completed, 1, `completed (${JSON.stringify(summary)})`)
    } finally {
      restored.close()
    }
    const backupDb = new sqliteModule.DatabaseSync(backupWithRequest, { readOnly: true })
    try {
      const ledger = backupDb.prepare('SELECT COUNT(*) AS c, SUM(amount) AS s FROM ludo_match_economy_ledger WHERE profile_id IS NULL AND deleted_profile_id_snapshot = ?;').get(winner.profileId) as { c: number; s: number }
      const live = db.prepare('SELECT COUNT(*) AS c, SUM(amount) AS s FROM ludo_match_economy_ledger WHERE profile_id IS NULL AND deleted_profile_id_snapshot = ?;').get(winner.profileId) as { c: number; s: number }
      assertEqual(JSON.stringify(ledger), JSON.stringify(live), 'Ludo атрибуцията')
      assertEqual(Number((backupDb.prepare('SELECT COUNT(*) AS c FROM campaign_reward_claims WHERE deleted_profile_id_snapshot = ?;').get(winner.profileId) as { c: number }).c), 3, 'claim-овете')
      assertEqual(Number((backupDb.prepare('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;').get(winner.profileId) as { c: number }).c), 0, 'профилът е изтрит отново')
    } finally {
      backupDb.close()
    }
  })

  await check('[G3] Restore на база, по-стара от заявката: replayDeletionForRestore snapshot-ва Ludo и кампаниите', async () => {
    const victim = registerUser('Replay', 2000)
    const other = registerUser('ReplayOther', 2000)
    playLudoMatch([victim, other], 150, victim)
    const adjusted = campaignCredit.applyManualAdjustment({ campaignId, profileId: victim.profileId, unitsDelta: 12, reason: 'r', adminProfileId: admin.profileId })
    assert(adjusted.ok, 'корекция')
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
      assertEqual(Number((backupDb.prepare('SELECT COUNT(*) AS c FROM ludo_match_economy_ledger WHERE profile_id IS NULL AND deleted_profile_id_snapshot = ?;').get(victim.profileId) as { c: number }).c), 2, 'Ludo: дебит + печалба')
      assertEqual(Number((backupDb.prepare('SELECT COUNT(*) AS c FROM campaign_unit_ledger WHERE deleted_profile_id_snapshot = ?;').get(victim.profileId) as { c: number }).c), 1, 'единици')
      assertEqual(Number((backupDb.prepare('SELECT COUNT(*) AS c FROM campaign_manual_adjustments WHERE deleted_profile_id_snapshot = ?;').get(victim.profileId) as { c: number }).c), 1, 'корекция')
    } finally {
      backupDb.close()
    }
  })

  await check('[G4] Нарушен финансов инвариант (изгубен ред по време на изтриването): ROLLBACK, failed, профилът и регистрите непокътнати', async () => {
    const user = registerUser('Invariant', 1000)
    const other = registerUser('InvariantOther', 1000)
    playLudoMatch([user, other], 100, other)
    db.exec(`
      CREATE TRIGGER trg_test_lose_ludo_row AFTER DELETE ON profiles
      BEGIN
        DELETE FROM ludo_match_economy_ledger WHERE deleted_profile_id_snapshot = OLD.profile_id;
      END;
    `)
    try {
      const ledgerBefore = rows('SELECT * FROM ludo_match_economy_ledger ORDER BY ledger_id;')
      const requestId = insertDueRequest(user)
      const summary = await makeWorker(executor, [requestId]).runOnce()
      assertEqual(summary.failed, 1, `failed (${JSON.stringify(summary)})`)
      const row = db.prepare('SELECT status, db_deleted_at, last_error_code FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, unknown>
      assertEqual(row.status, 'failed', 'статус')
      assertEqual(row.db_deleted_at, null, 'не е отчетено като изтрито')
      assert(db.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(user.profileId) !== undefined, 'профилът съществува (ROLLBACK)')
      assertEqual(rows('SELECT * FROM ludo_match_economy_ledger ORDER BY ledger_id;'), ledgerBefore, 'регистърът е непокътнат')
    } finally {
      db.exec('DROP TRIGGER trg_test_lose_ludo_row;')
    }
  })

  await check('[G5] Одитният snapshot не е в публичните DTO-та (ludo_room_matches/players, профилни API-та не четат регистъра)', async () => {
    const { readFile } = await import('node:fs/promises')
    const index = await readFile(join(sourceServerRoot, 'src', 'index.ts'), 'utf8')
    assert(!index.includes('ludo_match_economy_ledger'), 'index.ts чете регистъра директно')
    const ludoStore = await readFile(join(sourceServerRoot, 'src', 'db', 'ludoEconomyStore.ts'), 'utf8')
    assert(!ludoStore.includes('deleted_profile_id_snapshot'), 'ludoEconomyStore излага snapshot-а')
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
}

for (const dir of tempRoots) await rm(dir, { recursive: true, force: true }).catch(() => {})

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
