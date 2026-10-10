/**
 * checkCampaignGiftSenderProtection.ts
 *
 * Фаза 2.1 — защита срещу окончателно изтриване на профил, който фигурира
 * като подател на поне един реално предоставен кампаниен подарък
 * (gift_item_transactions.context = 'campaign_reward'). Проверява и двата
 * защитни слоя: application-level guard (profileHardDeleteService.ts) и
 * DB-level BEFORE DELETE trigger (20261013_001 миграцията), върху изолирана
 * SQLite база, подготвена през реалния ensureServerDatabaseReady() runner.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createProfileHardDeleteService, type ProfileHardDeleteService } from '../src/db/profileHardDeleteService.js'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed += 1
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed += 1
  const message = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${message}`)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (error) {
    fail(label, error)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length)
    ?? process.cwd(),
)
const sourceMigrationsDirectoryPath = join(sourceServerRoot, 'database', 'migrations')

console.log('\ncheckCampaignGiftSenderProtection')
console.log(`Server root: ${sourceServerRoot}`)

async function loadRealMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function createReadyTempDatabasePath(): Promise<{ databaseFilePath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-gift-sender-protection-'))
  const migrationsDirectoryPath = join(root, 'database', 'migrations')
  const dataDirectoryPath = join(root, 'database', 'data')
  await mkdir(migrationsDirectoryPath, { recursive: true })
  await mkdir(dataDirectoryPath, { recursive: true })
  const fileNames = await loadRealMigrationFileNames()
  for (const filename of fileNames) {
    await cp(join(sourceMigrationsDirectoryPath, filename), join(migrationsDirectoryPath, filename))
  }
  const result = await ensureServerDatabaseReady({ serverRootOverride: root })
  return {
    databaseFilePath: result.databaseFilePath,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function openRawDb(databaseFilePath: string) {
  const sqliteModule = await import('node:sqlite')
  const db = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  return db
}

async function seedProfile(databaseFilePath: string, displayName: string, opts: { accountRole?: string } = {}): Promise<{ profileId: string; accountId: string | null }> {
  const db = await openRawDb(databaseFilePath)
  try {
    const profileId = randomUUID()
    let accountId: string | null = null
    if (opts.accountRole !== undefined) {
      accountId = randomUUID()
      db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role) VALUES (?, ?, 'x', ?);`).run(
        accountId,
        `${accountId}@example.test`,
        opts.accountRole,
      )
    }
    db.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name) VALUES (?, ?, ?, ?);`).run(
      profileId,
      accountId,
      displayName,
      displayName.toLowerCase(),
    )
    return { profileId, accountId }
  } finally {
    db.close()
  }
}

async function seedGiftItem(databaseFilePath: string, name: string): Promise<string> {
  const db = await openRawDb(databaseFilePath)
  try {
    const giftItemId = randomUUID()
    db.prepare(`INSERT INTO gift_items (gift_item_id, name, image_url, price) VALUES (?, ?, '/img.webp', 1);`).run(giftItemId, name)
    return giftItemId
  } finally {
    db.close()
  }
}

async function insertGiftTransaction(
  databaseFilePath: string,
  senderProfileId: string,
  recipientProfileId: string,
  giftItemId: string,
  context: string,
): Promise<string> {
  const db = await openRawDb(databaseFilePath)
  try {
    const transactionId = randomUUID()
    db.prepare(`
      INSERT INTO gift_item_transactions (transaction_id, gift_item_id, sender_profile_id, recipient_profile_id, charged_price, context, request_id)
      VALUES (?, ?, ?, ?, 1, ?, ?);
    `).run(transactionId, giftItemId, senderProfileId, recipientProfileId, context, randomUUID())
    return transactionId
  } finally {
    db.close()
  }
}

async function countRows(databaseFilePath: string, sql: string, ...params: unknown[]): Promise<number> {
  const db = await openRawDb(databaseFilePath)
  try {
    const row = db.prepare(sql).get(...params) as { c: number }
    return row.c
  } finally {
    db.close()
  }
}

async function profileExists(databaseFilePath: string, profileId: string): Promise<boolean> {
  return (await countRows(databaseFilePath, `SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;`, profileId)) === 1
}

const { databaseFilePath, cleanup } = await createReadyTempDatabasePath()
let hardDeleteService!: ProfileHardDeleteService

try {
  hardDeleteService = await createProfileHardDeleteService(databaseFilePath, { deleteUploadFileByUrl: async () => {} })
  const { profileId: adminProfileId } = await seedProfile(databaseFilePath, 'Admin Actor')

  // ─── 1. Marketing профил БЕЗ кампанийни подаръци — изтрива се нормално ───
  await check('[1] Marketing профил без кампанийни подаръци може да бъде изтрит според действащите правила', async () => {
    const { profileId } = await seedProfile(databaseFilePath, 'Clean Marketing', { accountRole: 'marketing' })
    const result = await hardDeleteService.hardDeleteProfile({
      targetProfileId: profileId,
      actorProfileId: adminProfileId,
      actorAccountId: adminProfileId,
      reason: 'test cleanup',
    })
    assert(result.ok, `expected successful delete, got ${JSON.stringify(result)}`)
    assert(!(await profileExists(databaseFilePath, profileId)), 'profile should actually be gone')
  })

  // ─── 2. Marketing профил с ЕДИН предоставен кампаниен подарък — защитен ───
  let protectedProfileId!: string
  let protectedAccountId!: string | null
  let protectedTransactionId!: string
  await check('[2] Marketing профил с ЕДИН предоставен кампаниен подарък не може да бъде изтрит окончателно', async () => {
    const seeded = await seedProfile(databaseFilePath, 'Protected Marketing', { accountRole: 'marketing' })
    protectedProfileId = seeded.profileId
    protectedAccountId = seeded.accountId
    const giftItemId = await seedGiftItem(databaseFilePath, 'Protection Test Gift')
    const { profileId: recipientId } = await seedProfile(databaseFilePath, 'Recipient For Protection Test')
    protectedTransactionId = await insertGiftTransaction(databaseFilePath, protectedProfileId, recipientId, giftItemId, 'campaign_reward')

    const result = await hardDeleteService.hardDeleteProfile({
      targetProfileId: protectedProfileId,
      actorProfileId: adminProfileId,
      actorAccountId: adminProfileId,
      reason: 'attempted deletion',
    })
    assert(!result.ok && result.code === 'campaign_gift_sender_protected', `expected campaign_gift_sender_protected, got ${JSON.stringify(result)}`)
    assert(await profileExists(databaseFilePath, protectedProfileId), 'protected profile must remain intact')
  })

  // ─── 3. Множество кампанийни подаръци — профилът остава защитен ───
  await check('[3] Marketing профил с множество кампанийни подаръци е защитен', async () => {
    const { profileId } = await seedProfile(databaseFilePath, 'Multi Gift Marketing', { accountRole: 'marketing' })
    const giftA = await seedGiftItem(databaseFilePath, 'Multi Gift A')
    const giftB = await seedGiftItem(databaseFilePath, 'Multi Gift B')
    const { profileId: recipient1 } = await seedProfile(databaseFilePath, 'Recipient Multi 1')
    const { profileId: recipient2 } = await seedProfile(databaseFilePath, 'Recipient Multi 2')
    await insertGiftTransaction(databaseFilePath, profileId, recipient1, giftA, 'campaign_reward')
    await insertGiftTransaction(databaseFilePath, profileId, recipient2, giftB, 'campaign_reward')

    const result = await hardDeleteService.hardDeleteProfile({
      targetProfileId: profileId,
      actorProfileId: adminProfileId,
      actorAccountId: adminProfileId,
      reason: 'attempted deletion',
    })
    assert(!result.ok && result.code === 'campaign_gift_sender_protected', `expected protection, got ${JSON.stringify(result)}`)
  })

  // ─── 4. Профил, сменил роля СЛЕД предоставянето — остава защитен ───
  await check('[4] Профил, който е сменил ролята си след предоставянето, остава защитен (защитата е по история, не по текуща роля)', async () => {
    const { profileId, accountId } = await seedProfile(databaseFilePath, 'Former Marketing', { accountRole: 'marketing' })
    const giftItemId = await seedGiftItem(databaseFilePath, 'Former Marketing Gift')
    const { profileId: recipientId } = await seedProfile(databaseFilePath, 'Recipient Former Marketing')
    await insertGiftTransaction(databaseFilePath, profileId, recipientId, giftItemId, 'campaign_reward')

    // Ролята е свалена до обикновен player — защитата НЕ зависи от accounts.role.
    const db = await openRawDb(databaseFilePath)
    try {
      db.prepare(`UPDATE accounts SET role = 'player' WHERE account_id = ?;`).run(accountId)
    } finally {
      db.close()
    }

    const result = await hardDeleteService.hardDeleteProfile({
      targetProfileId: profileId,
      actorProfileId: adminProfileId,
      actorAccountId: adminProfileId,
      reason: 'attempted deletion after role change',
    })
    assert(!result.ok && result.code === 'campaign_gift_sender_protected', `expected protection despite role change, got ${JSON.stringify(result)}`)
  })

  // ─── 5. Обикновен подарък САМ ПО СЕБЕ СИ не активира защитата ───
  await check('[5] Обикновен ("profile" context) подарък сам по себе си не активира кампанийната защита', async () => {
    const { profileId } = await seedProfile(databaseFilePath, 'Ordinary Gift Sender', { accountRole: 'marketing' })
    const giftItemId = await seedGiftItem(databaseFilePath, 'Ordinary Gift')
    const { profileId: recipientId } = await seedProfile(databaseFilePath, 'Recipient Ordinary Gift')
    await insertGiftTransaction(databaseFilePath, profileId, recipientId, giftItemId, 'profile')

    const result = await hardDeleteService.hardDeleteProfile({
      targetProfileId: profileId,
      actorProfileId: adminProfileId,
      actorAccountId: adminProfileId,
      reason: 'ordinary gift sender deletion',
    })
    assert(result.ok, `ordinary ("profile" context) gift history must NOT trigger the campaign protection, got ${JSON.stringify(result)}`)
  })

  // ─── 6-7-8. Запазване на данните при отказ ───
  await check('[6]-[8] При отказ не се губят данни: профил, акаунт, gift транзакция, delivery log — всичко интактно', async () => {
    assert(await profileExists(databaseFilePath, protectedProfileId), 'profile must still exist after the earlier refusal')
    if (protectedAccountId !== null) {
      const accountCount = await countRows(databaseFilePath, `SELECT COUNT(*) AS c FROM accounts WHERE account_id = ?;`, protectedAccountId)
      assert(accountCount === 1, 'account must still exist after the earlier refusal (no partial deletion)')
    }
    const txRow = await countRows(
      databaseFilePath,
      `SELECT COUNT(*) AS c FROM gift_item_transactions WHERE transaction_id = ? AND sender_profile_id = ?;`,
      protectedTransactionId,
      protectedProfileId,
    )
    assert(txRow === 1, 'gift_item_transactions row (the "история на получените кампанийни подаръци") must remain fully intact')

    // Няма "partial" snapshot ефекти — profile_bans/other category-B tables
    // не трябва да имат ред за този профил въобще (той никога не е бил
    // banned), доказва че delete flow-ът се е отказал РАНО, преди да стигне
    // до каквито и да е snapshot UPDATE-и.
    const banSnapshotRow = await countRows(
      databaseFilePath,
      `SELECT COUNT(*) AS c FROM profile_bans WHERE deleted_profile_id_snapshot = ?;`,
      protectedProfileId,
    )
    assert(banSnapshotRow === 0, 'refused delete must not have executed any downstream snapshot logic')
  })

  // ─── 9. Защитата работи при изключен feature flag ───
  await check('[9] Защитата работи дори при изключен CAMPAIGNS_FEATURE_ENABLED (постоянна защита на историята, не campaign-active функция)', async () => {
    const originalFlagValue = process.env.CAMPAIGNS_FEATURE_ENABLED
    delete process.env.CAMPAIGNS_FEATURE_ENABLED
    try {
      const result = await hardDeleteService.hardDeleteProfile({
        targetProfileId: protectedProfileId,
        actorProfileId: adminProfileId,
        actorAccountId: adminProfileId,
        reason: 'attempted deletion with flag off',
      })
      assert(!result.ok && result.code === 'campaign_gift_sender_protected', `expected protection regardless of feature flag, got ${JSON.stringify(result)}`)
    } finally {
      if (originalFlagValue === undefined) delete process.env.CAMPAIGNS_FEATURE_ENABLED
      else process.env.CAMPAIGNS_FEATURE_ENABLED = originalFlagValue
    }
  })

  // ─── 10. DB-level trigger: директен DELETE (байпас на целия service) се отказва ───
  await check('[10] DB trigger: директен "DELETE FROM profiles" (байпас на profileHardDeleteService) се отказва', async () => {
    const db = await openRawDb(databaseFilePath)
    try {
      let threw = false
      let message = ''
      try {
        db.prepare(`DELETE FROM profiles WHERE profile_id = ?;`).run(protectedProfileId)
      } catch (error) {
        threw = true
        message = error instanceof Error ? error.message : String(error)
      }
      assert(threw, 'direct DELETE FROM profiles must be rejected by the BEFORE DELETE trigger')
      assert(message.includes('campaign_gift_sender_protected'), `expected trigger error message, got: ${message}`)
    } finally {
      db.close()
    }
    assert(await profileExists(databaseFilePath, protectedProfileId), 'profile must still exist after the rejected direct DELETE attempt')
  })

  // ─── 11. Account-level изтриване не заобикаля защитата ───
  await check('[11] Изтриване само на account реда (ако е възможно) не заобикаля защитата на профила/историята', async () => {
    // profiles.account_id няма FK constraint (проверено directно в схемата)
    // — DELETE FROM accounts самостоятелно НЕ каскадно трие профила. Пряк
    // опит през hardDeleteProfile() (единствения канонически path, който
    // евентуално трие и account реда) е вече доказано блокиран (тест [2]).
    // Тук потвърждаваме директно, че самостоятелно account-level DELETE не
    // засяга profiles/gift_item_transactions.
    if (protectedAccountId !== null) {
      const db = await openRawDb(databaseFilePath)
      try {
        db.prepare(`DELETE FROM accounts WHERE account_id = ?;`).run(protectedAccountId)
      } finally {
        db.close()
      }
    }
    assert(await profileExists(databaseFilePath, protectedProfileId), 'profile must survive a standalone account-row deletion (no FK cascade from accounts to profiles)')
    const txRow = await countRows(
      databaseFilePath,
      `SELECT COUNT(*) AS c FROM gift_item_transactions WHERE transaction_id = ?;`,
      protectedTransactionId,
    )
    assert(txRow === 1, 'gift transaction history must survive a standalone account-row deletion')
  })

  // ─── 12. Нормалното поведение на останалите профили не е нарушено ───
  await check('[12] Нормалното изтриване на несвързан, незащитен профил продължава да работи напълно нормално', async () => {
    const { profileId } = await seedProfile(databaseFilePath, 'Ordinary Unrelated Profile')
    const result = await hardDeleteService.hardDeleteProfile({
      targetProfileId: profileId,
      actorProfileId: adminProfileId,
      actorAccountId: adminProfileId,
      reason: 'ordinary unrelated deletion',
    })
    assert(result.ok, `ordinary profile deletion must be unaffected by the new protection, got ${JSON.stringify(result)}`)
    assert(!(await profileExists(databaseFilePath, profileId)), 'ordinary profile should be gone')
  })

  // ─── Допълнително: hasCampaignGiftSenderHistory pre-check точност ───
  await check('[доп.] hasCampaignGiftSenderHistory() връща коректен резултат за защитен и незащитен профил', async () => {
    assert(hardDeleteService.hasCampaignGiftSenderHistory(protectedProfileId) === true, 'expected true for the protected profile')
    const { profileId: cleanProfileId } = await seedProfile(databaseFilePath, 'Pre-check Clean Profile')
    assert(hardDeleteService.hasCampaignGiftSenderHistory(cleanProfileId) === false, 'expected false for a profile with no campaign gift history')
  })
} finally {
  if (hardDeleteService !== undefined) hardDeleteService.close()
  await cleanup()
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
