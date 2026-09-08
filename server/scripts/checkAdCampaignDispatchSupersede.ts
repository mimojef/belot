/**
 * checkAdCampaignDispatchSupersede.ts
 *
 * Проверява dedup/supersede fix-а за pending ad-campaign dispatches (виж
 * adCampaignsStore.sendCampaign) срещу реална temp SQLite база с ВСИЧКИ
 * реални миграции от database/migrations, включително новите
 * 20260908_001/002.
 *
 * Сценарии от task spec-а:
 *   A) offline user + една кампания, изпратена 3 пъти -> при login (т.е.
 *      listPendingDispatchesForProfile) вижда точно 1 pending dispatch
 *      (последния/Send#3).
 *   B) offline user + две различни кампании -> и двете остават налични
 *      (независими, не се засягат взаимно).
 *   C) "online" user + повторно изпращане на СЪЩАТА кампания -> пак само 1
 *      pending dispatch (supersede работи независимо от online/offline,
 *      защото dedup-ът е в DB, не по connection state).
 *   D) dismiss (X) на активния dispatch -> НЕ се появява повторно без ново
 *      "Изпрати" (и supersede НЕ възкресява dismiss-нат dispatch).
 *   E) dispatch_count/history (админ статистика) остава непроменена от
 *      supersede-а — самите dispatch редове не се трият/променят, само
 *      получават superseded_at.
 *   F) supersededDispatchIds от sendCampaign() съдържа точно очакваните
 *      dispatch id-та, за realtime invalidation broadcast-а в index.ts.
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createAdCampaignsStore, type AdCampaignActor } from '../src/db/adCampaignsStore.js'

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
  const insertApplied = database.prepare(`INSERT OR IGNORE INTO server_migrations (filename) VALUES (?);`)
  for (const filename of await loadMigrationFileNames()) {
    if (getApplied.get(filename) !== undefined) continue
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
      try { database.exec('ROLLBACK;') } catch { /* ignore */ }
      throw new Error(`Failed to apply migration ${filename}: ${String(error)}`)
    }
  }
}

function insertProfile(database: DatabaseSync, profileId: string): void {
  database.prepare(`
    INSERT OR IGNORE INTO accounts (account_id, email, password_hash, role, status)
    VALUES (?, ?, 'hash', 'player', 'active');
  `).run(profileId, `${profileId}@example.test`)
  database.prepare(`
    INSERT OR IGNORE INTO profiles (
      profile_id, account_id, display_name, normalized_display_name, profile_kind, status
    ) VALUES (?, ?, ?, ?, 'human', 'active');
  `).run(profileId, profileId, profileId, profileId.toLowerCase())
}

async function main(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'belot-ad-campaign-supersede-'))
  const dbFilePath = join(tempDir, 'test.sqlite')

  try {
    const setupDb = new DatabaseSync(dbFilePath, { open: true })
    await applyMigrations(setupDb)

    const admin: AdCampaignActor = { profileId: 'admin-1', role: 'admin' }
    insertProfile(setupDb, admin.profileId)
    insertProfile(setupDb, 'user-offline')
    insertProfile(setupDb, 'user-online')
    setupDb.close()

    const store = await createAdCampaignsStore(dbFilePath)

    // === A) offline user + 1 кампания, изпратена 3 пъти -> 1 pending ===
    const campaignA = store.createCampaign({
      imageUrl: '/uploads/ad-campaigns/a.webp',
      imageFilename: 'a.webp',
      targetUrl: '/tournaments',
      actor: admin,
    })
    if (!campaignA.ok) throw new Error('createCampaign A failed')
    const campaignAId = campaignA.campaign.campaignId

    const sendA1 = store.sendCampaign(campaignAId, admin)
    const sendA2 = store.sendCampaign(campaignAId, admin)
    const sendA3 = store.sendCampaign(campaignAId, admin)
    if (!sendA1.ok || !sendA2.ok || !sendA3.ok) throw new Error('sendCampaign A failed')

    check(
      '[A1] Send#2 supersede-ва точно Send#1 dispatch',
      sendA2.supersededDispatchIds.length === 1 && sendA2.supersededDispatchIds[0] === sendA1.dispatchId,
      JSON.stringify(sendA2.supersededDispatchIds),
    )
    check(
      '[A2] Send#3 supersede-ва точно Send#2 dispatch (не Send#1 повторно)',
      sendA3.supersededDispatchIds.length === 1 && sendA3.supersededDispatchIds[0] === sendA2.dispatchId,
      JSON.stringify(sendA3.supersededDispatchIds),
    )

    const pendingOfflineAfterA = store.listPendingDispatchesForProfile('user-offline')
    check(
      '[A3] offline user вижда точно 1 pending dispatch за campaign A след 3 изпращания',
      pendingOfflineAfterA.length === 1,
      `дължина=${pendingOfflineAfterA.length}`,
    )
    check(
      '[A4] pending dispatch-ът е Send#3 (последният)',
      pendingOfflineAfterA[0]?.dispatchId === sendA3.dispatchId,
      `dispatchId=${pendingOfflineAfterA[0]?.dispatchId}`,
    )

    // === B) две различни кампании -> и двете независимо налични ===
    const campaignB = store.createCampaign({
      imageUrl: '/uploads/ad-campaigns/b.webp',
      imageFilename: 'b.webp',
      targetUrl: '/lobby',
      actor: admin,
    })
    if (!campaignB.ok) throw new Error('createCampaign B failed')
    const campaignBId = campaignB.campaign.campaignId
    const sendB1 = store.sendCampaign(campaignBId, admin)
    if (!sendB1.ok) throw new Error('sendCampaign B failed')

    check(
      '[B1] Изпращане на кампания B НЕ supersede-ва нищо от кампания A',
      sendB1.supersededDispatchIds.length === 0,
      JSON.stringify(sendB1.supersededDispatchIds),
    )

    const pendingOfflineAfterB = store.listPendingDispatchesForProfile('user-offline')
    const pendingCampaignIds = pendingOfflineAfterB.map((d) => d.campaignId).sort()
    check(
      '[B2] offline user вижда 2 pending dispatches — по 1 за всяка кампания (A и B независими)',
      pendingOfflineAfterB.length === 2 &&
        pendingCampaignIds[0] === [campaignAId, campaignBId].sort()[0] &&
        pendingCampaignIds[1] === [campaignAId, campaignBId].sort()[1],
      JSON.stringify(pendingCampaignIds),
    )

    // === C) повторно изпращане на campaign A ("online" user) -> пак 1 pending ===
    // (store логиката не различава online/offline — dedup е чист DB state;
    // "online" сценарият разлика прави само в delivery транспорта в index.ts,
    // проверен ръчно по-долу в отчета.)
    const sendA4 = store.sendCampaign(campaignAId, admin)
    if (!sendA4.ok) throw new Error('sendCampaign A#4 failed')
    check(
      '[C1] Send#4 supersede-ва Send#3 (предният still-pending dispatch)',
      sendA4.supersededDispatchIds.length === 1 && sendA4.supersededDispatchIds[0] === sendA3.dispatchId,
      JSON.stringify(sendA4.supersededDispatchIds),
    )

    const pendingOnlineAfterC = store.listPendingDispatchesForProfile('user-online')
    const campaignAPendingCount = pendingOnlineAfterC.filter((d) => d.campaignId === campaignAId).length
    check(
      '[C2] "online" user вижда точно 1 pending dispatch за campaign A (без stack)',
      campaignAPendingCount === 1,
      `count=${campaignAPendingCount}`,
    )
    check(
      '[C3] pending dispatch-ът за campaign A е Send#4 (последният)',
      pendingOnlineAfterC.find((d) => d.campaignId === campaignAId)?.dispatchId === sendA4.dispatchId,
    )

    // === D) dismiss (X) на активния dispatch -> не се появява повторно ===
    const dismissResult = store.markDispatchDismissed(sendA4.dispatchId, 'user-online')
    check('[D1] markDispatchDismissed за активния Send#4 връща ok:true', dismissResult.ok === true)

    const pendingOnlineAfterDismiss = store.listPendingDispatchesForProfile('user-online')
    const stillHasCampaignA = pendingOnlineAfterDismiss.some((d) => d.campaignId === campaignAId)
    check(
      '[D2] след dismiss campaign A вече НЕ е pending за user-online (без ново "Изпрати")',
      stillHasCampaignA === false,
    )

    // Supersede на друга кампания не бива да "възкресява" dismiss-нат dispatch.
    const sendB2 = store.sendCampaign(campaignBId, admin)
    if (!sendB2.ok) throw new Error('sendCampaign B#2 failed')
    const pendingOnlineAfterUnrelatedSend = store.listPendingDispatchesForProfile('user-online')
    const campaignAStillAbsent = !pendingOnlineAfterUnrelatedSend.some((d) => d.campaignId === campaignAId)
    check(
      '[D3] Изпращане на НЕсвързана кампания B не възкресява dismiss-натата campaign A',
      campaignAStillAbsent,
    )

    // === E) dispatch_count/history (admin статистика) не се засяга ===
    const managementRowA = store.getManagementRowById(campaignAId)
    check(
      '[E1] dispatch_count за campaign A остава 4 (Send#1..#4) въпреки supersede-а',
      managementRowA?.dispatchCount === 4,
      `dispatchCount=${managementRowA?.dispatchCount}`,
    )

    // === F) user-offline никога не е dismiss-вал нищо -> все още вижда
    // последния pending dispatch на всяка кампания (dismiss е per-profile) ===
    const pendingOfflineFinal = store.listPendingDispatchesForProfile('user-offline')
    const offlineCampaignAEntry = pendingOfflineFinal.find((d) => d.campaignId === campaignAId)
    check(
      '[F1] user-offline (никога не е затварял нищо) все още вижда campaign A pending (Send#4, не по-стар)',
      offlineCampaignAEntry?.dispatchId === sendA4.dispatchId,
      `dispatchId=${offlineCampaignAEntry?.dispatchId}`,
    )
    const offlineCampaignBEntry = pendingOfflineFinal.find((d) => d.campaignId === campaignBId)
    check(
      '[F2] user-offline вижда campaign B pending (последният Send#2, Send#1 supersede-нат)',
      offlineCampaignBEntry?.dispatchId === sendB2.dispatchId,
      `dispatchId=${offlineCampaignBEntry?.dispatchId}`,
    )

    store.close()
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

main()
  .then(() => {
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`Passed: ${passed}  Failed: ${failed}`)
    if (failed > 0) process.exitCode = 1
  })
  .catch((error) => {
    console.error('FATAL:', error)
    process.exitCode = 1
  })
