/**
 * checkCampaignScheduler.ts
 *
 * Фаза 1 на системата "Кампании" — проверки на
 * server/src/campaigns/campaignScheduler.ts: автоматично активиране на due
 * scheduled кампании, автоматично приключване на due active кампании,
 * идемпотентност при повторни tick-ове, restart-безопасност (нов scheduler
 * instance върху същия store/база продължава коректно), и критичният
 * сценарий "целият период вече е изтекъл при рестарт" — кампанията НИКОГА
 * не минава през 'active', отива директно scheduled -> finished. Изолация
 * на грешки в рамките на един tick + health diagnostics. Изолирана temp
 * SQLite база, подготвена през реалния ensureServerDatabaseReady() runner.
 */

import { mkdir, mkdtemp, readdir, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createCampaignsStore, type CampaignsStore } from '../src/campaigns/campaignsStore.js'
import { createCampaignScheduler } from '../src/campaigns/campaignScheduler.js'

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

console.log('\ncheckCampaignScheduler')
console.log(`Server root: ${sourceServerRoot}`)

async function loadRealMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function createReadyTempDatabasePath(): Promise<{ databaseFilePath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-scheduler-'))
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

async function seedAdminProfile(databaseFilePath: string): Promise<void> {
  const sqliteModule = await import('node:sqlite')
  const database = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  try {
    database.prepare(`
      INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, 'Admin Tester', 'admin tester');
    `).run(ADMIN_ACTOR.profileId)
  } finally {
    database.close()
  }
}

async function getEventTypes(databaseFilePath: string, campaignId: string): Promise<string[]> {
  const sqliteModule = await import('node:sqlite')
  const database = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  try {
    const rows = database
      .prepare(`SELECT event_type FROM campaign_events WHERE campaign_id = ? ORDER BY created_at ASC;`)
      .all(campaignId) as Array<{ event_type: string }>
    return rows.map((r) => r.event_type)
  } finally {
    database.close()
  }
}

function createTestDraft(store: CampaignsStore, overrides: { name: string; startsAt: string; endsAt: string }) {
  return store.createDraftCampaign(
    { name: overrides.name, startsAt: overrides.startsAt, endsAt: overrides.endsAt, unitNameSingular: 'тиква', unitNamePlural: 'тикви' },
    ADMIN_ACTOR,
  )
}

const { databaseFilePath, cleanup } = await createReadyTempDatabasePath()
await seedAdminProfile(databaseFilePath)

try {
  // ─── 1. Празен tick — no-op ───
  await check('[1] tickNow() с нулеви кампании е безопасен no-op', async () => {
    const store = await createCampaignsStore(databaseFilePath)
    try {
      const scheduler = createCampaignScheduler({ store })
      scheduler.tickNow()
      const health = scheduler.getHealth()
      assert(health.processedLastTick === 0, `expected 0 processed, got ${health.processedLastTick}`)
      assert(health.lastError === null, `expected no error, got ${health.lastError}`)
    } finally {
      store.close()
    }
  })

  // ─── 2. Автоматично активиране ───
  await check('[2] Due scheduled кампания се активира автоматично на tick', async () => {
    const store = await createCampaignsStore(databaseFilePath)
    try {
      const draft = createTestDraft(store, { name: 'Auto-activate', startsAt: hoursFromNow(-1), endsAt: hoursFromNow(48) })
      assert(draft.ok, 'setup failed')
      if (!draft.ok) return
      const scheduled = store.scheduleCampaign(draft.campaign.campaignId, ADMIN_ACTOR)
      assert(scheduled.ok, `setup scheduling failed: ${JSON.stringify(scheduled)}`)
      if (!scheduled.ok) return

      const scheduler = createCampaignScheduler({ store })
      scheduler.tickNow()

      const after = store.getCampaignById(draft.campaign.campaignId)
      assert(after !== null && after.status === 'active', `expected active, got ${after?.status}`)
      const events = await getEventTypes(databaseFilePath, draft.campaign.campaignId)
      assert(events.includes('campaign_activated'), 'missing campaign_activated event')

      store.stopCampaign(draft.campaign.campaignId, ADMIN_ACTOR)
    } finally {
      store.close()
    }
  })

  // ─── 3. Автоматично приключване ───
  await check('[3] Due active кампания се приключва автоматично на tick', async () => {
    const store = await createCampaignsStore(databaseFilePath)
    try {
      // Кампания с кратък бъдещ прозорец, активирана сега — tick-ваме с
      // инжектиран `now` 1 час по-късно (без реално чакане), за да отмине
      // ends_at и да проверим автоматичното приключване.
      const draft = createTestDraft(store, { name: 'Auto-finish', startsAt: hoursFromNow(-2), endsAt: hoursFromNow(0.1) })
      assert(draft.ok, 'setup failed')
      if (!draft.ok) return
      const activated = store.activateCampaign(draft.campaign.campaignId, new Date(), ADMIN_ACTOR)
      assert(activated.ok, `setup activation failed: ${JSON.stringify(activated)}`)
      if (!activated.ok) return

      const scheduler = createCampaignScheduler({ store, now: () => new Date(Date.now() + 3_600_000) })
      scheduler.tickNow()

      const after = store.getCampaignById(draft.campaign.campaignId)
      assert(after !== null && after.status === 'finished', `expected finished, got ${after?.status}`)
      const events = await getEventTypes(databaseFilePath, draft.campaign.campaignId)
      assert(events.includes('campaign_finished'), 'missing campaign_finished event')
    } finally {
      store.close()
    }
  })

  // ─── 4. Повторно изпълнение — идемпотентност ───
  await check('[4] Повторен tick не дублира преходи/events', async () => {
    const store = await createCampaignsStore(databaseFilePath)
    try {
      const draft = createTestDraft(store, { name: 'Idempotent tick', startsAt: hoursFromNow(-1), endsAt: hoursFromNow(48) })
      assert(draft.ok, 'setup failed')
      if (!draft.ok) return
      const scheduled = store.scheduleCampaign(draft.campaign.campaignId, ADMIN_ACTOR)
      assert(scheduled.ok, 'setup scheduling failed')
      if (!scheduled.ok) return

      const scheduler = createCampaignScheduler({ store })
      scheduler.tickNow()
      scheduler.tickNow()
      scheduler.tickNow()

      const events = await getEventTypes(databaseFilePath, draft.campaign.campaignId)
      const activatedCount = events.filter((e) => e === 'campaign_activated').length
      assert(activatedCount === 1, `expected exactly 1 campaign_activated event after 3 ticks, got ${activatedCount}`)

      store.stopCampaign(draft.campaign.campaignId, ADMIN_ACTOR)
    } finally {
      store.close()
    }
  })

  // ─── 5. Рестарт по време на планиран период (нов scheduler instance) ───
  await check('[5] Нов scheduler instance ("рестарт") върху същия store продължава коректно, без дублиране', async () => {
    const store = await createCampaignsStore(databaseFilePath)
    try {
      const draft = createTestDraft(store, { name: 'Restart mid-schedule', startsAt: hoursFromNow(-1), endsAt: hoursFromNow(48) })
      assert(draft.ok, 'setup failed')
      if (!draft.ok) return
      const scheduled = store.scheduleCampaign(draft.campaign.campaignId, ADMIN_ACTOR)
      assert(scheduled.ok, 'setup scheduling failed')
      if (!scheduled.ok) return

      const schedulerBeforeRestart = createCampaignScheduler({ store })
      schedulerBeforeRestart.tickNow()
      const midway = store.getCampaignById(draft.campaign.campaignId)
      assert(midway !== null && midway.status === 'active', 'expected active before simulated restart')

      // "Рестарт": съвсем нов scheduler instance (нов in-memory state), СЪЩИЯ store/база.
      const schedulerAfterRestart = createCampaignScheduler({ store })
      schedulerAfterRestart.tickNow()
      schedulerAfterRestart.tickNow()

      const after = store.getCampaignById(draft.campaign.campaignId)
      assert(after !== null && after.status === 'active', `expected still active, got ${after?.status}`)
      const events = await getEventTypes(databaseFilePath, draft.campaign.campaignId)
      assert(events.filter((e) => e === 'campaign_activated').length === 1, 'restart must not duplicate campaign_activated')

      store.stopCampaign(draft.campaign.campaignId, ADMIN_ACTOR)
    } finally {
      store.close()
    }
  })

  // ─── 6. Критичен сценарий: рестарт след ЦЕЛИЯТ период е изтекъл ───
  await check('[6] Scheduled кампания, чийто ЦЯЛ период вече е изтекъл при "рестарт" — НИКОГА не минава през active', async () => {
    const store = await createCampaignsStore(databaseFilePath)
    try {
      const draft = createTestDraft(store, { name: 'Expired before activation', startsAt: hoursFromNow(-100), endsAt: hoursFromNow(-50) })
      assert(draft.ok, 'setup failed')
      if (!draft.ok) return
      const scheduled = store.scheduleCampaign(draft.campaign.campaignId, ADMIN_ACTOR)
      assert(scheduled.ok, 'setup scheduling failed')
      if (!scheduled.ok) return

      const scheduler = createCampaignScheduler({ store })
      scheduler.tickNow()

      const after = store.getCampaignById(draft.campaign.campaignId)
      assert(after !== null && after.status === 'finished', `expected finished (direct), got ${after?.status}`)
      const events = await getEventTypes(databaseFilePath, draft.campaign.campaignId)
      assert(events.includes('campaign_expired_before_activation'), 'missing campaign_expired_before_activation event')
      assert(!events.includes('campaign_activated'), 'campaign must NEVER have been activated — "не я активирай за кратко само за да я приключиш"')
    } finally {
      store.close()
    }
  })

  // ─── 7. Изолация на грешки в рамките на един tick ───
  // Забележка по дизайна: единствената активна кампания (invariant) прави
  // невъзможно да има ДВЕ едновременно due 'scheduled' кампании с реално
  // застъпващи се прозорци (overlap guard-ът при scheduleCampaign вече би
  // блокирал това) — две кампании, due "точно сега", неизбежно биха имали
  // прозорци, покриващи "сега", значит биха се застъпвали. Затова тук
  // "healthy" е АКТИВНА кампания, due за ПРИКЛЮЧВАНЕ (dueActiveIds опашка),
  // а "poisoned" е SCHEDULED кампания, due за АКТИВИРАНЕ (dueScheduledIds
  // опашка) — две различни опашки в СЪЩИЯ tick, без overlap конфликт помежду
  // им (прозорците им реално не се пресичат към момента на scheduleCampaign).
  await check('[7] Грешка при обработка на една кампания не блокира останалите в същия tick', async () => {
    const store = await createCampaignsStore(databaseFilePath)
    try {
      const healthyDraft = createTestDraft(store, { name: 'Healthy (active, due to finish)', startsAt: hoursFromNow(-3), endsAt: hoursFromNow(0.1) })
      assert(healthyDraft.ok, 'setup failed')
      if (!healthyDraft.ok) return
      const healthyActivated = store.activateCampaign(healthyDraft.campaign.campaignId, new Date(), ADMIN_ACTOR)
      assert(healthyActivated.ok, `setup activation failed: ${JSON.stringify(healthyActivated)}`)
      if (!healthyActivated.ok) return

      const poisonedDraft = createTestDraft(store, { name: 'Poisoned (scheduled, due to activate)', startsAt: hoursFromNow(1), endsAt: hoursFromNow(48) })
      assert(poisonedDraft.ok, 'setup failed')
      if (!poisonedDraft.ok) return
      const poisonedScheduled = store.scheduleCampaign(poisonedDraft.campaign.campaignId, ADMIN_ACTOR)
      assert(poisonedScheduled.ok, `setup scheduling failed: ${JSON.stringify(poisonedScheduled)}`)
      if (!poisonedScheduled.ok) return

      let loggedErrorCount = 0
      const wrappedStore: CampaignsStore = {
        ...store,
        activateCampaign: (campaignId, now, actor) => {
          if (campaignId === poisonedDraft.campaign.campaignId) {
            throw new Error('simulated failure for poisoned campaign')
          }
          return store.activateCampaign(campaignId, now, actor)
        },
      }

      // Виртуален "now" +2ч: прави и healthy (ends_at=+0.1ч) due за finish, И
      // poisoned (starts_at=+1ч) due за activate, в един и същ tick.
      const scheduler = createCampaignScheduler({
        store: wrappedStore,
        now: () => new Date(Date.now() + 2 * 3_600_000),
        logError: () => {
          loggedErrorCount += 1
        },
      })
      scheduler.tickNow()

      assert(loggedErrorCount === 1, `expected exactly 1 logged error, got ${loggedErrorCount}`)
      const healthyAfter = store.getCampaignById(healthyDraft.campaign.campaignId)
      assert(healthyAfter !== null && healthyAfter.status === 'finished', `healthy campaign should still finish despite sibling failure, got ${healthyAfter?.status}`)
      const poisonedAfter = store.getCampaignById(poisonedDraft.campaign.campaignId)
      assert(poisonedAfter !== null && poisonedAfter.status === 'scheduled', 'poisoned campaign should remain scheduled (unchanged) after its own failure')

      // lastError (mirror на tournamentScheduler.ts семантиката) е tick-level
      // "целият tick не отбеляза прогрес" сигнал, нулиран щом processedLastTick>0
      // — тук healthy УСПЯ, затова lastError коректно се нулира. Per-item
      // грешката вече е проверена по-горе чрез loggedErrorCount===1 (правилният
      // канал за единична изолирана грешка в тази архитектура).
      const health = scheduler.getHealth()
      assert(health.lastError === null, `expected lastError cleared when other items in the tick succeeded, got ${health.lastError}`)
      assert(health.inFlight === false, 'inFlight must return to false even after an error')

      store.softDeleteCampaign(poisonedDraft.campaign.campaignId, ADMIN_ACTOR)
    } finally {
      store.close()
    }
  })

  // ─── 8. Реентрантна защита (inFlight guard) ───
  await check('[8] inFlight guard: рекурсивен tickNow() по средата на текущ tick е no-op', async () => {
    const store = await createCampaignsStore(databaseFilePath)
    try {
      const draft = createTestDraft(store, { name: 'Reentrancy', startsAt: hoursFromNow(-1), endsAt: hoursFromNow(48) })
      assert(draft.ok, 'setup failed')
      if (!draft.ok) return
      const scheduled = store.scheduleCampaign(draft.campaign.campaignId, ADMIN_ACTOR)
      assert(scheduled.ok, 'setup scheduling failed')
      if (!scheduled.ok) return

      let reentrantCallCount = 0
      let reentrantSawInFlight = false
      let scheduler!: ReturnType<typeof createCampaignScheduler>
      const wrappedStore: CampaignsStore = {
        ...store,
        listDueScheduledCampaignIds: (now, limit) => {
          reentrantCallCount += 1
          if (reentrantCallCount === 1) {
            reentrantSawInFlight = scheduler.getHealth().inFlight
            scheduler.tickNow() // рекурсивен опит по средата на текущия tick
          }
          return store.listDueScheduledCampaignIds(now, limit)
        },
      }
      scheduler = createCampaignScheduler({ store: wrappedStore })
      scheduler.tickNow()

      assert(reentrantSawInFlight, 'expected inFlight=true during the outer tick body')
      assert(reentrantCallCount === 1, `expected listDueScheduledCampaignIds to run exactly once (reentrant call must no-op), got ${reentrantCallCount}`)

      const after = store.getCampaignById(draft.campaign.campaignId)
      assert(after !== null && after.status === 'active', 'outer tick should have completed normally despite the reentrant attempt')
      store.stopCampaign(draft.campaign.campaignId, ADMIN_ACTOR)
    } finally {
      store.close()
    }
  })

  // ─── 9. Health diagnostics ───
  await check('[9] getHealth(): коректни state преходи idle -> running -> stopped', async () => {
    const store = await createCampaignsStore(databaseFilePath)
    try {
      const scheduler = createCampaignScheduler({ store, intervalMs: 999_999 })
      assert(scheduler.getHealth().state === 'idle', 'expected idle before start()')
      scheduler.start()
      assert(scheduler.getHealth().state === 'running', 'expected running after start()')
      scheduler.stop()
      assert(scheduler.getHealth().state === 'stopped', 'expected stopped after stop()')
      scheduler.close()
    } finally {
      store.close()
    }
  })

  // ─── 10. Flag-agnostic архитектура — статична проверка ───
  // Проверяваме за реална import/require зависимост от campaignsFeatureFlag.ts,
  // не за литерално присъствие на името като текст — campaignScheduler.ts
  // легитимно СПОМЕНАВА isCampaignsFeatureEnabled() в обяснителен коментар
  // (защо той НЕ се ползва тук), без да го импортира/вика.
  await check('[10] campaignsStore.ts/campaignScheduler.ts нямат import зависимост от campaignsFeatureFlag.ts (gating е отговорност на бъдещата wiring точка)', async () => {
    const { readFile } = await import('node:fs/promises')
    const storeSource = await readFile(new URL('../src/campaigns/campaignsStore.ts', import.meta.url), 'utf8')
    const schedulerSource = await readFile(new URL('../src/campaigns/campaignScheduler.ts', import.meta.url), 'utf8')
    const importsFeatureFlag = (source: string): boolean => /from\s+['"].*campaignsFeatureFlag(\.js)?['"]/.test(source)
    assert(!importsFeatureFlag(storeSource), 'campaignsStore.ts must not import campaignsFeatureFlag.ts')
    assert(!importsFeatureFlag(schedulerSource), 'campaignScheduler.ts must not import campaignsFeatureFlag.ts')
  })

  // Фаза 4 (admin UI) легитимно wire-ва campaignsStore/campaignScheduler в
  // index.ts — админ панелът трябва да извиква реалните lifecycle преходи
  // (schedule/activate/stop/clone), и scheduler-ът трябва да работи за
  // автоматичните преходи, докато флагът е включен за тестване. Старата
  // проверка (Фази 1-3: "index.ts няма НИКАКВО reference") вече е обсолетна
  // по дизайн — заменена с проверка на РЕАЛНИЯ инвариант, който винаги е имал
  // значение: нулево поведенческо въздействие в production, докато флагът е
  // изключен (и двете инстанции трябва да бъдат създадени УСЛОВНО спрямо
  // isCampaignsFeatureEnabled()).
  await check('[11] index.ts wire-ва campaignsStore/campaignScheduler само УСЛОВНО спрямо isCampaignsFeatureEnabled() — нулево поведенческо въздействие, докато флагът е изключен', async () => {
    const { readFile } = await import('node:fs/promises')
    const indexSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    assert(indexSource.includes('createCampaignsStore'), 'index.ts трябва да инстанцира campaignsStore (admin lifecycle операции)')
    assert(indexSource.includes('createCampaignScheduler'), 'index.ts трябва да инстанцира campaignScheduler (auto-transitions за admin тестване)')

    const campaignsStoreCreation = indexSource.match(/const campaignsStore = ([^\n]+\n)+?\s*: null/)
    assert(campaignsStoreCreation !== null && /isCampaignsFeatureEnabled\(\)/.test(campaignsStoreCreation[0]), 'campaignsStore създаването трябва да е условно спрямо isCampaignsFeatureEnabled()')

    const schedulerCreation = indexSource.match(/const campaignScheduler = ([^\n]+\n)+?\s*: null/)
    assert(schedulerCreation !== null && /campaignsStore !== null/.test(schedulerCreation[0]), 'campaignScheduler създаването трябва да е условно спрямо campaignsStore !== null (и той вече е флаг-условен)')
  })
} finally {
  await cleanup()
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
