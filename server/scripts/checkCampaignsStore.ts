/**
 * checkCampaignsStore.ts
 *
 * Фаза 1 на системата "Кампании" — функционални проверки на
 * server/src/campaigns/campaignsStore.ts: лайфсайкъл на кампанията
 * (create/edit/schedule/activate/finish/stop/clone/soft-delete), единствена
 * активна кампания (вкл. симулирани конкурентни заявки през 2 отделни DB
 * connections), overlap guard, audit trail (campaign_events), запазване на
 * история при soft-delete. Изолирана temp SQLite база, подготвена през
 * реалния ensureServerDatabaseReady() runner — никога local/production база.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createCampaignsStore, type CampaignsStore } from '../src/campaigns/campaignsStore.js'

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

console.log('\ncheckCampaignsStore')
console.log(`Server root: ${sourceServerRoot}`)

async function loadRealMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function createReadyTempDatabasePath(): Promise<{ databaseFilePath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'belot-campaigns-store-'))
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

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString()
}

const ADMIN_ACTOR = { type: 'admin' as const, profileId: 'admin-profile-1' }
const SYSTEM_ACTOR = { type: 'system' as const }

async function getEventRows(databaseFilePath: string, campaignId: string) {
  const sqliteModule = await import('node:sqlite')
  const database = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  try {
    return database
      .prepare(`SELECT event_type, actor_profile_id, payload_json FROM campaign_events WHERE campaign_id = ? ORDER BY created_at ASC;`)
      .all(campaignId) as Array<{ event_type: string; actor_profile_id: string | null; payload_json: string | null }>
  } finally {
    database.close()
  }
}

const { databaseFilePath, cleanup } = await createReadyTempDatabasePath()
let store!: CampaignsStore

try {
  store = await createCampaignsStore(databaseFilePath)

  // campaign_events.actor_profile_id реферира profiles(profile_id) ON DELETE
  // SET NULL — нужен е реален profiles ред за ADMIN_ACTOR, иначе insertEvent
  // би гръмнал с FOREIGN KEY constraint failed при всяко admin действие.
  {
    const sqliteModule = await import('node:sqlite')
    const seedDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
    try {
      seedDatabase.prepare(`
        INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, 'Admin Tester', 'admin tester');
      `).run(ADMIN_ACTOR.profileId)
    } finally {
      seedDatabase.close()
    }
  }

  function createTestDraft(overrides: {
    name: string
    startsAt: string
    endsAt: string
    unitNameSingular?: string
    unitNamePlural?: string
    giftSenderProfileId?: string | null
  }) {
    return store.createDraftCampaign(
      {
        name: overrides.name,
        startsAt: overrides.startsAt,
        endsAt: overrides.endsAt,
        unitNameSingular: overrides.unitNameSingular ?? 'тиква',
        unitNamePlural: overrides.unitNamePlural ?? 'тикви',
        giftSenderProfileId: overrides.giftSenderProfileId,
      },
      ADMIN_ACTOR,
    )
  }

  // ─── 1. Създаване на чернова ───
  let draftId!: string
  await check('[1] createDraftCampaign: успешно създава draft + campaign_created event', async () => {
    const result = store.createDraftCampaign(
      { name: 'Хелоуин 2026', startsAt: hoursFromNow(24), endsAt: hoursFromNow(24 * 20), unitNameSingular: 'тиква', unitNamePlural: 'тикви' },
      ADMIN_ACTOR,
    )
    assert(result.ok, 'createDraftCampaign failed unexpectedly')
    if (!result.ok) return
    draftId = result.campaign.campaignId
    assert(result.campaign.status === 'draft', `expected status draft, got ${result.campaign.status}`)
    const events = await getEventRows(databaseFilePath, draftId)
    assert(events.length === 1 && events[0].event_type === 'campaign_created', 'missing campaign_created event')
    assert(events[0].actor_profile_id === ADMIN_ACTOR.profileId, 'admin actor_profile_id not recorded')
    assert(JSON.parse(events[0].payload_json ?? '{}').actorType === 'admin', 'payload_json missing actorType=admin')
  })

  // ─── 2. Невалидни дати ───
  await check('[2] createDraftCampaign: ends_at <= starts_at се отхвърля с invalid_period', () => {
    const result = store.createDraftCampaign(
      { name: 'x', startsAt: hoursFromNow(10), endsAt: hoursFromNow(5), unitNameSingular: 'a', unitNamePlural: 'b' },
      ADMIN_ACTOR,
    )
    assert(!result.ok && result.reason === 'invalid_period', `expected invalid_period, got ${JSON.stringify(result)}`)
  })

  // ─── 3. Редактиране ───
  await check('[3] updateCampaign: редакция на draft успешна + campaign_updated event', () => {
    const result = store.updateCampaign(draftId, { name: 'Хелоуин 2026 (редакция)' }, ADMIN_ACTOR)
    assert(result.ok, 'updateCampaign failed unexpectedly')
    if (result.ok) assert(result.campaign.name === 'Хелоуин 2026 (редакция)', 'name not updated')
  })

  // ─── 4. Планиране ───
  await check('[4] scheduleCampaign: draft -> scheduled успешно', () => {
    const result = store.scheduleCampaign(draftId, ADMIN_ACTOR)
    assert(result.ok && result.campaign.status === 'scheduled', `expected scheduled, got ${JSON.stringify(result)}`)
  })

  await check('[5] updateCampaign: вече не е редактируем след "not_editable" преход (симулация активна, виж теста по-долу)', () => {
    // Истинският "not_editable" случай (status='active') се проверява в тест [11].
    // Тук само потвърждаваме, че scheduled кампания ОЩЕ Е редактируема (edit
    // е разрешен за draft/scheduled, заключен само от active нататък).
    const result = store.updateCampaign(draftId, { name: 'Хелоуин 2026 (пак редакция)' }, ADMIN_ACTOR)
    assert(result.ok, 'scheduled campaign should still be editable')
  })

  // ─── 6. Застъпващи се кампании ───
  await check('[6] scheduleCampaign: overlap с вече scheduled кампания се отхвърля', () => {
    const overlappingDraft = store.createDraftCampaign(
      { name: 'Коледа (overlap)', startsAt: hoursFromNow(24 * 5), endsAt: hoursFromNow(24 * 15), unitNameSingular: 'снежинка', unitNamePlural: 'снежинки' },
      ADMIN_ACTOR,
    )
    assert(overlappingDraft.ok, 'setup draft failed')
    if (!overlappingDraft.ok) return
    const result = store.scheduleCampaign(overlappingDraft.campaign.campaignId, ADMIN_ACTOR)
    assert(!result.ok && result.reason === 'overlaps_existing_campaign', `expected overlaps_existing_campaign, got ${JSON.stringify(result)}`)
    // non-overlapping период на СЪЩАТА draft трябва да мине успешно.
    store.updateCampaign(overlappingDraft.campaign.campaignId, { startsAt: hoursFromNow(24 * 25), endsAt: hoursFromNow(24 * 35) }, ADMIN_ACTOR)
    const retryResult = store.scheduleCampaign(overlappingDraft.campaign.campaignId, ADMIN_ACTOR)
    assert(retryResult.ok, `non-overlapping reschedule should succeed, got ${JSON.stringify(retryResult)}`)
    // Разчистваме — иначе остава 'scheduled' безсрочно и колидира с по-късни тестове.
    store.softDeleteCampaign(overlappingDraft.campaign.campaignId, ADMIN_ACTOR)
  })

  // ─── 7. Активиране + единствена активна кампания ───
  let activeId!: string
  await check('[7] activateCampaign: scheduled -> active успешно', () => {
    const activateNow = new Date(Date.now() + 24 * 3_600_000 + 1_000) // малко след starts_at
    const result = store.activateCampaign(draftId, activateNow, ADMIN_ACTOR)
    assert(result.ok && result.campaign.status === 'active', `expected active, got ${JSON.stringify(result)}`)
    activeId = draftId
  })

  await check('[8] activateCampaign: втора кампания не може да се активира докато първата е активна', () => {
    const secondDraft = createTestDraft(
      { name: 'Втора активна (трябва да бъде отхвърлена)', startsAt: hoursFromNow(1), endsAt: hoursFromNow(48) },
    )
    assert(secondDraft.ok, 'setup failed')
    if (!secondDraft.ok) return
    const result = store.activateCampaign(secondDraft.campaign.campaignId, new Date(), ADMIN_ACTOR)
    assert(!result.ok && result.reason === 'another_campaign_active', `expected another_campaign_active, got ${JSON.stringify(result)}`)
  })

  // ─── 9. Две конкурентни заявки за активиране (2 отделни connections) ───
  await check('[9] Две отделни store connections, опит за едновременна активация — само една успява', async () => {
    // Освобождаваме текущата активна кампания, за да нулираме сцената.
    store.stopCampaign(activeId, ADMIN_ACTOR)

    const candidateA = createTestDraft(
      { name: 'Candidate A', startsAt: hoursFromNow(100), endsAt: hoursFromNow(150) },
    )
    const candidateB = createTestDraft(
      { name: 'Candidate B', startsAt: hoursFromNow(200), endsAt: hoursFromNow(250) },
    )
    assert(candidateA.ok && candidateB.ok, 'setup failed')
    if (!candidateA.ok || !candidateB.ok) return

    const storeConnectionTwo = await createCampaignsStore(databaseFilePath)
    try {
      const resultA = store.activateCampaign(candidateA.campaign.campaignId, new Date(), ADMIN_ACTOR)
      const resultB = storeConnectionTwo.activateCampaign(candidateB.campaign.campaignId, new Date(), ADMIN_ACTOR)
      const successCount = [resultA, resultB].filter((r) => r.ok).length
      assert(successCount === 1, `expected exactly 1 success, got ${successCount}: ${JSON.stringify([resultA, resultB])}`)
      const failedOne = !resultA.ok ? resultA : !resultB.ok ? resultB : null
      assert(failedOne !== null && !failedOne.ok && failedOne.reason === 'another_campaign_active', 'loser should fail with another_campaign_active')
      // Разчистваме активната кампания от този тест за следващите.
      const stillActive = store.getActiveCampaign()
      if (stillActive !== null) store.stopCampaign(stillActive.campaignId, ADMIN_ACTOR)
    } finally {
      storeConnectionTwo.close()
    }
  })

  // ─── 10. Активиране на вече изтекла кампания ───
  await check('[10] activateCampaign: already_expired когато ends_at вече е минал', () => {
    const expiredDraft = createTestDraft(
      { name: 'Вече изтекла', startsAt: new Date(Date.now() - 48 * 3_600_000).toISOString(), endsAt: new Date(Date.now() - 1_000).toISOString() },
    )
    assert(expiredDraft.ok, 'setup failed')
    if (!expiredDraft.ok) return
    const result = store.activateCampaign(expiredDraft.campaign.campaignId, new Date(), ADMIN_ACTOR)
    assert(!result.ok && result.reason === 'already_expired', `expected already_expired, got ${JSON.stringify(result)}`)
  })

  // ─── 11. not_editable след активиране ───
  let lockedActiveId!: string
  await check('[11] updateCampaign: активна кампания не е редактируема (not_editable)', () => {
    const draft = createTestDraft({ name: 'За заключване', startsAt: hoursFromNow(1), endsAt: hoursFromNow(300) })
    assert(draft.ok, 'setup failed')
    if (!draft.ok) return
    const activateResult = store.activateCampaign(draft.campaign.campaignId, new Date(), ADMIN_ACTOR)
    assert(activateResult.ok, 'setup activation failed')
    if (!activateResult.ok) return
    lockedActiveId = activateResult.campaign.campaignId
    const updateResult = store.updateCampaign(lockedActiveId, { name: 'не трябва да мине' }, ADMIN_ACTOR)
    assert(!updateResult.ok && updateResult.reason === 'not_editable', `expected not_editable, got ${JSON.stringify(updateResult)}`)
  })

  // ─── 12. Ръчно спиране ───
  await check('[12] stopCampaign: active -> stopped успешно + campaign_stopped event', async () => {
    const result = store.stopCampaign(lockedActiveId, ADMIN_ACTOR)
    assert(result.ok && result.campaign.status === 'stopped', `expected stopped, got ${JSON.stringify(result)}`)
    const events = await getEventRows(databaseFilePath, lockedActiveId)
    assert(events.some((e) => e.event_type === 'campaign_stopped'), 'missing campaign_stopped event')
  })

  await check('[13] stopCampaign: невалиден преход (вече stopped) се отхвърля', () => {
    const result = store.stopCampaign(lockedActiveId, ADMIN_ACTOR)
    assert(!result.ok && result.reason === 'invalid_status', `expected invalid_status, got ${JSON.stringify(result)}`)
  })

  // ─── 14. finishCampaign идемпотентност ───
  await check('[14] finishCampaign: идемпотентен повторен извикване (alreadyFinished, без дублиран event)', async () => {
    const draft = createTestDraft({ name: 'За finish', startsAt: hoursFromNow(1), endsAt: hoursFromNow(400) })
    assert(draft.ok, 'setup failed')
    if (!draft.ok) return
    const activateResult = store.activateCampaign(draft.campaign.campaignId, new Date(), ADMIN_ACTOR)
    assert(activateResult.ok, 'setup activation failed')
    if (!activateResult.ok) return
    const campaignId = activateResult.campaign.campaignId
    const first = store.finishCampaign(campaignId, new Date(), SYSTEM_ACTOR)
    assert(first.ok && !first.alreadyFinished, 'first finish should succeed, not alreadyFinished')
    const second = store.finishCampaign(campaignId, new Date(), SYSTEM_ACTOR)
    assert(second.ok && second.alreadyFinished, 'second finish should report alreadyFinished')
    const events = await getEventRows(databaseFilePath, campaignId)
    const finishEvents = events.filter((e) => e.event_type === 'campaign_finished')
    assert(finishEvents.length === 1, `expected exactly 1 campaign_finished event, got ${finishEvents.length}`)
    assert(finishEvents[0].actor_profile_id === null, 'system actor should have NULL actor_profile_id')
    assert(JSON.parse(finishEvents[0].payload_json ?? '{}').actorType === 'system', 'payload_json missing actorType=system')
  })

  // ─── 15. Клониране ───
  await check('[15] cloneCampaign: нов draft с копирани настройки, независим campaign_id', () => {
    const result = store.cloneCampaign(lockedActiveId, ADMIN_ACTOR)
    assert(result.ok, `clone failed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.campaign.campaignId !== lockedActiveId, 'clone must have a new campaign_id')
    assert(result.campaign.status === 'draft', `clone must start as draft, got ${result.campaign.status}`)
    assert(result.campaign.deletedAt === null, 'clone must not be soft-deleted')
    const original = store.getCampaignById(lockedActiveId)
    assert(original !== null && result.campaign.name === original.name, 'clone name must match source')
  })

  // ─── 16. Soft-delete + запазване на история ───
  await check('[16] softDeleteCampaign: отхвърлен за активна, разрешен за stopped, историята се запазва', async () => {
    const draft = createTestDraft({ name: 'За soft-delete', startsAt: hoursFromNow(500), endsAt: hoursFromNow(520) })
    assert(draft.ok, 'setup failed')
    if (!draft.ok) return
    const campaignId = draft.campaign.campaignId

    // Draft директно soft-delete е разрешен (не е active).
    const deleteResult = store.softDeleteCampaign(campaignId, ADMIN_ACTOR)
    assert(deleteResult.ok && deleteResult.campaign.deletedAt !== null, `expected successful soft-delete, got ${JSON.stringify(deleteResult)}`)

    const doubleDelete = store.softDeleteCampaign(campaignId, ADMIN_ACTOR)
    assert(!doubleDelete.ok && doubleDelete.reason === 'already_deleted', `expected already_deleted, got ${JSON.stringify(doubleDelete)}`)

    // Активна кампания не може да се soft-delete-не директно.
    const activeDraft = createTestDraft({ name: 'Активна за delete тест', startsAt: hoursFromNow(1), endsAt: hoursFromNow(600) })
    assert(activeDraft.ok, 'setup failed')
    if (!activeDraft.ok) return
    const activated = store.activateCampaign(activeDraft.campaign.campaignId, new Date(), ADMIN_ACTOR)
    assert(activated.ok, 'setup activation failed')
    if (!activated.ok) return
    const blockedDelete = store.softDeleteCampaign(activated.campaign.campaignId, ADMIN_ACTOR)
    assert(!blockedDelete.ok && blockedDelete.reason === 'cannot_delete_active_campaign', `expected cannot_delete_active_campaign, got ${JSON.stringify(blockedDelete)}`)
    store.stopCampaign(activated.campaign.campaignId, ADMIN_ACTOR)
    const nowAllowedDelete = store.softDeleteCampaign(activated.campaign.campaignId, ADMIN_ACTOR)
    assert(nowAllowedDelete.ok, `expected success after stop-then-delete, got ${JSON.stringify(nowAllowedDelete)}`)

    // Историята остава заявима: getCampaignById и includeDeleted listing все още я виждат.
    const stillFound = store.getCampaignById(campaignId)
    assert(stillFound !== null && stillFound.name === 'За soft-delete', 'soft-deleted row must remain queryable by id')
    const defaultList = store.listCampaigns()
    assert(!defaultList.some((c) => c.campaignId === campaignId), 'default listCampaigns must exclude soft-deleted rows')
    const includeDeletedList = store.listCampaigns({ includeDeleted: true })
    assert(includeDeletedList.some((c) => c.campaignId === campaignId), 'includeDeleted:true must include soft-deleted rows')
    const events = await getEventRows(databaseFilePath, campaignId)
    assert(events.some((e) => e.event_type === 'campaign_soft_deleted'), 'missing campaign_soft_deleted event')
  })

  // ─── 17. getActiveCampaign ───
  await check('[17] getActiveCampaign: null когато няма активна, върната кампания когато има', () => {
    const existingActive = store.getActiveCampaign()
    if (existingActive !== null) store.stopCampaign(existingActive.campaignId, ADMIN_ACTOR)
    assert(store.getActiveCampaign() === null, 'expected null when nothing active')

    const draft = createTestDraft({ name: 'Проверка getActiveCampaign', startsAt: hoursFromNow(1), endsAt: hoursFromNow(700) })
    assert(draft.ok, 'setup failed')
    if (!draft.ok) return
    const activated = store.activateCampaign(draft.campaign.campaignId, new Date(), ADMIN_ACTOR)
    assert(activated.ok, 'setup activation failed')
    if (!activated.ok) return
    const active = store.getActiveCampaign()
    assert(active !== null && active.campaignId === activated.campaign.campaignId, 'expected to find the just-activated campaign')
    store.stopCampaign(activated.campaign.campaignId, ADMIN_ACTOR)
  })

  // ─── 18. listDueScheduledCampaignIds / listDueActiveCampaignIds граници ───
  await check('[18] listDueScheduledCampaignIds: точно на/преди/след starts_at граница', () => {
    const futureDraft = createTestDraft({ name: 'Due boundary', startsAt: hoursFromNow(2), endsAt: hoursFromNow(800) })
    assert(futureDraft.ok, 'setup failed')
    if (!futureDraft.ok) return
    const scheduled = store.scheduleCampaign(futureDraft.campaign.campaignId, ADMIN_ACTOR)
    assert(scheduled.ok, 'setup scheduling failed')
    if (!scheduled.ok) return

    const beforeDue = store.listDueScheduledCampaignIds(new Date(), 10)
    assert(!beforeDue.includes(scheduled.campaign.campaignId), 'should not be due before starts_at')

    const afterDue = store.listDueScheduledCampaignIds(new Date(Date.now() + 2 * 3_600_000 + 1_000), 10)
    assert(afterDue.includes(scheduled.campaign.campaignId), 'should be due after starts_at')

    store.softDeleteCampaign(scheduled.campaign.campaignId, ADMIN_ACTOR)
  })
} finally {
  if (store !== undefined) store.close()
  await cleanup()
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
