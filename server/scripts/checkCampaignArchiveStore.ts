/**
 * checkCampaignArchiveStore.ts
 *
 * Фаза 11 на системата "Кампании" — функционални проверки на
 * server/src/campaigns/campaignArchiveStore.ts: reconciliation-gated
 * readiness (Белот primary+legacy, Ludo, coin/bundle/VIP покупки, дължими
 * gift-item награди), атомарно замразяване (summary + Топ 10), идемпотентно
 * повторно архивиране, tie-break подреждане, замразени display name/rank
 * snapshot-и, hard-delete/soft-delete поведение, admin списъчни изгледи, и
 * заключването на тематичната иконка след архивиране
 * (campaignAdminStore.ts::updateThemeAsset). Изолирана temp SQLite база,
 * реални миграции през ensureServerDatabaseReady().
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createCampaignsStore, type CampaignsStore, type CampaignId } from '../src/campaigns/campaignsStore.js'
import { createCampaignAdminStore, type CampaignAdminStore } from '../src/campaigns/campaignAdminStore.js'
import { createCampaignCreditStore, type CampaignCreditStore } from '../src/campaigns/campaignCreditStore.js'
import { createCampaignArchiveStore, type CampaignArchiveStore } from '../src/campaigns/campaignArchiveStore.js'

let passed = 0
let failed = 0

function pass(label: string): void { passed += 1; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed += 1
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (error) { fail(label, error) }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)
const sourceMigrationsDirectoryPath = join(sourceServerRoot, 'database', 'migrations')

console.log('\ncheckCampaignArchiveStore')

async function loadRealMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function createReadyTempDatabasePath(): Promise<{ databaseFilePath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-archive-'))
  const migrationsDirectoryPath = join(root, 'database', 'migrations')
  const dataDirectoryPath = join(root, 'database', 'data')
  await mkdir(migrationsDirectoryPath, { recursive: true })
  await mkdir(dataDirectoryPath, { recursive: true })
  const fileNames = await loadRealMigrationFileNames()
  for (const filename of fileNames) {
    await cp(join(sourceMigrationsDirectoryPath, filename), join(migrationsDirectoryPath, filename))
  }
  const result = await ensureServerDatabaseReady({ serverRootOverride: root })
  return { databaseFilePath: result.databaseFilePath, cleanup: async () => { await rm(root, { recursive: true, force: true }) } }
}

const { databaseFilePath, cleanup } = await createReadyTempDatabasePath()

async function openRawDb() {
  const sqliteModule = await import('node:sqlite')
  const db = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  return db
}

async function seedProfile(displayName: string, opts: { rankTitle?: string | null; isTemporary?: boolean; profileKind?: 'human' | 'bot' } = {}): Promise<string> {
  const db = await openRawDb()
  try {
    const profileId = randomUUID()
    db.prepare(`
      INSERT INTO profiles (profile_id, display_name, normalized_display_name, rank_title, is_temporary, profile_kind)
      VALUES (?, ?, ?, ?, ?, ?);
    `).run(profileId, displayName, displayName.toLowerCase(), opts.rankTitle ?? null, opts.isTemporary ? 1 : 0, opts.profileKind ?? 'human')
    return profileId
  } finally {
    db.close()
  }
}

async function hardDeleteProfileRaw(profileId: string): Promise<void> {
  const db = await openRawDb()
  try {
    db.prepare(`DELETE FROM profiles WHERE profile_id = ?;`).run(profileId)
  } finally {
    db.close()
  }
}

function toSqliteTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

async function seedBelotMatchCompletion(opts: { profileId: string; roomId: string; endedAt: Date; stakeAmount?: number; matchScope?: string }): Promise<string> {
  const db = await openRawDb()
  try {
    const matchScope = opts.matchScope ?? `${opts.roomId}:v1`
    db.prepare(`
      INSERT INTO belot_match_completion_ledger (match_scope, profile_id, room_id, team, did_win, stake_amount, ended_at, is_guest_trial)
      VALUES (?, ?, ?, 'A', 1, ?, ?, 0);
    `).run(matchScope, opts.profileId, opts.roomId, opts.stakeAmount ?? 100, toSqliteTimestamp(opts.endedAt))
    return matchScope
  } finally {
    db.close()
  }
}

async function seedLegacyMatchResult(opts: { profileId: string; roomId: string; completedAt: Date }): Promise<void> {
  const db = await openRawDb()
  try {
    db.prepare(`
      INSERT INTO profile_match_results (room_id, profile_id, team, did_win, completed_at, is_guest_trial)
      VALUES (?, ?, 'A', 1, ?, 0);
    `).run(opts.roomId, opts.profileId, toSqliteTimestamp(opts.completedAt))
  } finally {
    db.close()
  }
}

async function seedLudoMatch(opts: { profileId: string; stake: number; finishedAt: Date }): Promise<string> {
  const db = await openRawDb()
  try {
    const matchId = randomUUID()
    db.prepare(`
      INSERT INTO ludo_room_matches (match_id, ludo_room_id, status, stake, player_count, players_json, winner_profile_id, finished_at)
      VALUES (?, ?, 'finished', ?, 2, '[]', ?, ?);
    `).run(matchId, randomUUID(), opts.stake, opts.profileId, toSqliteTimestamp(opts.finishedAt))
    return matchId
  } finally {
    db.close()
  }
}

async function seedPurchase(table: 'coin_purchase_ledger' | 'bundle_purchase_ledger', opts: { profileId: string; packageKey: string; creditedAt: Date }): Promise<string> {
  const db = await openRawDb()
  try {
    const purchaseId = randomUUID()
    const createdAt = toSqliteTimestamp(opts.creditedAt)
    if (table === 'bundle_purchase_ledger') {
      db.prepare(`
        INSERT INTO bundle_purchase_ledger (purchase_id, profile_id, package_key_snapshot, title_snapshot, yellow_coins_amount, vip_days_snapshot, price_cents, currency, provider, status, credited_at, created_at, updated_at)
        VALUES (?, ?, ?, 'Test Bundle', 100, 7, 499, 'eur', 'stripe', 'paid', ?, ?, ?);
      `).run(purchaseId, opts.profileId, opts.packageKey, createdAt, createdAt, createdAt)
    } else {
      db.prepare(`
        INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_key_snapshot, title_snapshot, yellow_coins_amount, price_cents, currency, provider, status, credited_at, created_at, updated_at)
        VALUES (?, ?, ?, 'Test Pack', 100, 499, 'eur', 'stripe', 'paid', ?, ?, ?);
      `).run(purchaseId, opts.profileId, opts.packageKey, createdAt, createdAt, createdAt)
    }
    return purchaseId
  } finally {
    db.close()
  }
}

async function seedVipPurchase(opts: { profileId: string; creditedAt: Date }): Promise<string> {
  const db = await openRawDb()
  try {
    const purchaseId = randomUUID()
    const createdAt = toSqliteTimestamp(opts.creditedAt)
    db.prepare(`
      INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, provider, status, credited_at, created_at)
      VALUES (?, ?, 'vip_30', 30, 999, 'eur', 'stripe', 'paid', ?, ?);
    `).run(purchaseId, opts.profileId, createdAt, createdAt)
    return purchaseId
  } finally {
    db.close()
  }
}

async function createRealGiftSender(): Promise<string> {
  const db = await openRawDb()
  try {
    const accountId = randomUUID()
    const profileId = randomUUID()
    db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role) VALUES (?, ?, 'x', 'marketing');`).run(accountId, `${accountId}@example.test`)
    db.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name) VALUES (?, ?, 'Sender', 'sender');`).run(profileId, accountId)
    return profileId
  } finally {
    db.close()
  }
}

async function seedGiftItem(): Promise<string> {
  const db = await openRawDb()
  try {
    const giftItemId = randomUUID()
    db.prepare(`INSERT INTO gift_items (gift_item_id, name, image_url, price) VALUES (?, 'Gift', '/img.webp', 1);`).run(giftItemId)
    return giftItemId
  } finally {
    db.close()
  }
}

// Фаза 12 §2 одит-регресия — минимален валиден tournament_matches ред (+
// родителски tournaments/tournament_teams/tournament_rounds редове,
// изисквани от FK-итата), асоцииран с даден room_id. Единственото поле,
// което readiness/reconciliation SQL-ите реално ползват, е room_id (UNIQUE
// колона) — останалите полета са минимално валидни стойности, удовлетворяващи
// CHECK/FK constraints.
async function seedTournamentMatchForRoom(roomId: string): Promise<void> {
  const db = await openRawDb()
  try {
    const creatorProfileId = randomUUID()
    db.prepare(`
      INSERT INTO profiles (profile_id, display_name, normalized_display_name, is_temporary, profile_kind)
      VALUES (?, 'Tournament Creator', 'tournament creator', 0, 'human');
    `).run(creatorProfileId)
    const tournamentId = randomUUID()
    db.prepare(`
      INSERT INTO tournaments (tournament_id, name, creator_profile_id, entry_fee, start_mode, status)
      VALUES (?, 'Test Tournament', ?, 100, 'fill', 'final_in_progress');
    `).run(tournamentId, creatorProfileId)
    const teamAId = randomUUID()
    const teamBId = randomUUID()
    db.prepare(`INSERT INTO tournament_teams (team_id, tournament_id, status) VALUES (?, ?, 'locked');`).run(teamAId, tournamentId)
    db.prepare(`INSERT INTO tournament_teams (team_id, tournament_id, status) VALUES (?, ?, 'locked');`).run(teamBId, tournamentId)
    const roundId = randomUUID()
    db.prepare(`INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index) VALUES (?, ?, 'final', 1);`).run(roundId, tournamentId)
    db.prepare(`
      INSERT INTO tournament_matches (match_id, tournament_id, round_id, room_id, team_a_id, team_b_id, status)
      VALUES (?, ?, ?, ?, ?, ?, 'in_progress');
    `).run(randomUUID(), tournamentId, roundId, roomId, teamAId, teamBId)
  } finally {
    db.close()
  }
}

const SYSTEM_ACTOR = { type: 'system' as const }
// Реален profile ред (не случаен randomUUID()) — campaign_events.actor_profile_id
// има FK към profiles(profile_id); несъществуващ id би чупил всяка
// insertEvent() операция (stopCampaign/archiveCampaign/etc.) с FOREIGN KEY
// constraint failed.
const adminActorProfileId = await seedProfile('Test Admin Actor')
const ADMIN_ACTOR = { type: 'admin' as const, profileId: adminActorProfileId }

const campaignsStore: CampaignsStore = await createCampaignsStore(databaseFilePath)
const campaignAdminStore: CampaignAdminStore = await createCampaignAdminStore(databaseFilePath)
const campaignCreditStore: CampaignCreditStore = await createCampaignCreditStore(databaseFilePath)
const archiveStore: CampaignArchiveStore = await createCampaignArchiveStore(databaseFilePath, campaignCreditStore)

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString()
}

// Всяка тестова кампания получава СВОЙ, никога-застъпващ-се времеви
// прозорец (реалните campaigns в production никога не се застъпват —
// hasOverlap() проверка при schedule/update — но createFinishedCampaign тук
// извиква activateCampaign директно, без schedule, затова overlap не се
// проверява автоматично). Без тая изолация, readiness-проверките на ДВЕ
// различни тестови кампании със СЪЩИЯ времеви прозорец биха "видели" чужди
// seed-нати pending редове (false positive incomplete reconciliation).
let testCampaignWindowCounter = 0
function nextIsolatedWindow(): { startsAt: string; endsAt: string } {
  testCampaignWindowCounter += 1
  const offsetHours = 10 + testCampaignWindowCounter * 4
  return { startsAt: hoursFromNow(-offsetHours), endsAt: hoursFromNow(-offsetHours + 2) }
}

// Директни raw-SQL INSERT-и за earn_rules/package_earn_rules/reward_tiers
// (НЕ campaignAdminStore.saveCampaignConfiguration — тая admin-ниво
// application валидация, реален allowed stake/истински package_key/etc,
// е извън обхвата на тоя store-level тест) — established pattern, mirror
// на checkCampaignCreditStore.ts::seedCampaign. stake_amount=0 винаги е
// валиден (campaign_earn_rules CHECK изисква само >= 0, без FK към
// match_rooms — тая DB-level constraint е единствената гаранция тук).
async function createFinishedCampaign(opts: {
  earnRules?: Array<{ gameKind: 'belot' | 'ludo'; stake: number; units: number }>
  packageRules?: Array<{ packageKey: string; units: number }>
  giftTierThreshold?: number
  giftItemId?: string
  senderProfileId?: string
  manualStop?: boolean
  /**
   * За manualStop:true тестове — getEffectiveWindowEndIso() разширява
   * ефективния край на СПРЯНА кампания до реалния момент на campaign_stopped
   * event-а (виж campaignArchiveStore.ts doc коментара), т.е. до "сега",
   * НЕЗАВИСИМО от nextIsolatedWindow()'s изолиран (далечен) прозорец —
   * ефективният диапазон [starts_at, сега) би покрил ВСЕКИ друг тест,
   * чиито pending redове са seed-нати някъде в "близкото минало". Тестове
   * за manualStop трябва да ползват прозорец, започващ СЪВСЕМ скоро (секунди
   * преди "сега"), за да остане ефективният диапазон тесен и изолиран.
   */
}): Promise<{ campaignId: CampaignId; eventAtWithinWindow: Date }> {
  const senderProfileId = opts.senderProfileId ?? null
  const window = opts.manualStop
    ? { startsAt: new Date(Date.now() - 5_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() }
    : nextIsolatedWindow()
  const createResult = campaignsStore.createDraftCampaign({
    name: `Test Campaign ${randomUUID().slice(0, 8)}`,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    unitNameSingular: 'жетон',
    unitNamePlural: 'жетони',
    giftSenderProfileId: senderProfileId,
  }, SYSTEM_ACTOR)
  if (!createResult.ok) throw new Error('setup: createDraftCampaign failed')
  const campaignId = createResult.campaign.campaignId
  // Средата на прозореца — безопасно "в рамките на" независимо от
  // ends_at закръгляне/precision разлики.
  const eventAtWithinWindow = new Date((Date.parse(window.startsAt) + Date.parse(window.endsAt)) / 2)

  const db = await openRawDb()
  try {
    for (const rule of opts.earnRules ?? []) {
      db.prepare(`INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, ?, ?, ?);`)
        .run(campaignId, rule.gameKind, rule.stake, rule.units)
    }
    for (const rule of opts.packageRules ?? []) {
      db.prepare(`INSERT INTO campaign_package_earn_rules (campaign_id, package_key, units_per_purchase) VALUES (?, ?, ?);`)
        .run(campaignId, rule.packageKey, rule.units)
    }
    if (opts.giftTierThreshold !== undefined && opts.giftItemId !== undefined) {
      const tierId = randomUUID()
      db.prepare(`INSERT INTO campaign_reward_tiers (tier_id, campaign_id, threshold_units) VALUES (?, ?, ?);`).run(tierId, campaignId, opts.giftTierThreshold)
      db.prepare(`INSERT INTO campaign_tier_rewards (tier_reward_id, tier_id, reward_type, reward_payload_json) VALUES (?, ?, 'gift_item', ?);`)
        .run(randomUUID(), tierId, JSON.stringify({ giftItemId: opts.giftItemId }))
    }
  } finally {
    db.close()
  }

  const activateResult = campaignsStore.activateCampaign(campaignId, new Date(Date.parse(window.startsAt) + 60_000), SYSTEM_ACTOR)
  if (!activateResult.ok) throw new Error(`setup: activateCampaign failed: ${JSON.stringify(activateResult)}`)

  if (opts.manualStop) {
    const stopResult = campaignsStore.stopCampaign(campaignId, ADMIN_ACTOR)
    if (!stopResult.ok) throw new Error('setup: stopCampaign failed')
  } else {
    const finishResult = campaignsStore.finishCampaign(campaignId, new Date(), SYSTEM_ACTOR)
    if (!finishResult.ok) throw new Error('setup: finishCampaign failed')
  }
  return { campaignId, eventAtWithinWindow }
}

// ─── A. Readiness ───

await check('[A1] getArchivalReadiness: непознат campaignId -> campaign_not_found', () => {
  const result = archiveStore.getArchivalReadiness(randomUUID())
  assert(!result.ok && result.reason === 'campaign_not_found', `${JSON.stringify(result)}`)
})

await check('[A2] getArchivalReadiness: активна (не finished/stopped) кампания -> not_finished', async () => {
  const createResult = campaignsStore.createDraftCampaign({
    name: 'Active Test', startsAt: hoursFromNow(-1), endsAt: hoursFromNow(5),
    unitNameSingular: 'ж', unitNamePlural: 'жета',
  }, SYSTEM_ACTOR)
  if (!createResult.ok) throw new Error('setup failed')
  campaignsStore.activateCampaign(createResult.campaign.campaignId, new Date(), SYSTEM_ACTOR)
  const result = archiveStore.getArchivalReadiness(createResult.campaign.campaignId)
  assert(!result.ok && result.reason === 'not_finished', `${JSON.stringify(result)}`)
  // Освобождава прозореца/активния slot за следващите тестове (иначе
  // overlap/"max 1 active" проверките на следващите create/schedule
  // извиквания биха се провалили заради тая останала активна кампания).
  campaignsStore.stopCampaign(createResult.campaign.campaignId, ADMIN_ACTOR)
})

await check('[A3] getArchivalReadiness: чисто приключена кампания (без начисления) -> ready=true', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({})
  const result = archiveStore.getArchivalReadiness(campaignId)
  assert(result.ok && result.ready === true, `${JSON.stringify(result)}`)
})

await check('[A4] getArchivalReadiness: висящ belot_win (primary ledger) в прозореца -> pendingBelotWin=1, ready=false', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({ earnRules: [{ gameKind: 'belot', stake: 100, units: 10 }] })
  const winner = await seedProfile('A4 winner')
  await seedBelotMatchCompletion({ profileId: winner, roomId: `room-${randomUUID()}`, endedAt: eventAtWithinWindow })
  const result = archiveStore.getArchivalReadiness(campaignId)
  assert(result.ok && result.ready === false && result.readiness.pendingBelotWin === 1, `${JSON.stringify(result)}`)
})

await check('[A5] getArchivalReadiness: висящ legacy belot (profile_match_results, без нов ledger ред) -> pendingBelotLegacy=1', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({ earnRules: [{ gameKind: 'belot', stake: 0, units: 5 }] })
  const winner = await seedProfile('A5 winner')
  await seedLegacyMatchResult({ profileId: winner, roomId: `legacy-room-${randomUUID()}`, completedAt: eventAtWithinWindow })
  const result = archiveStore.getArchivalReadiness(campaignId)
  assert(result.ok && result.readiness.pendingBelotLegacy === 1, `${JSON.stringify(result)}`)
})

await check('[A6] getArchivalReadiness: висящ ludo_win -> pendingLudoWin=1', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({ earnRules: [{ gameKind: 'ludo', stake: 50, units: 8 }] })
  const winner = await seedProfile('A6 winner')
  await seedLudoMatch({ profileId: winner, stake: 50, finishedAt: eventAtWithinWindow })
  const result = archiveStore.getArchivalReadiness(campaignId)
  assert(result.ok && result.readiness.pendingLudoWin === 1, `${JSON.stringify(result)}`)
})

await check('[A7] getArchivalReadiness: висящи coin/bundle/vip покупки -> съответните броячи', async () => {
  // vip_purchase_ledger.package_id ('vip_30') е packageKey-ят, с който
  // campaignPurchaseHooks.ts начислява VIP покупка — без правило за него
  // покупката не е дължима (виж [A12]).
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({ packageRules: [{ packageKey: 'starter', units: 3 }, { packageKey: 'vip_30', units: 2 }] })
  const buyer = await seedProfile('A7 buyer')
  await seedPurchase('coin_purchase_ledger', { profileId: buyer, packageKey: 'starter', creditedAt: eventAtWithinWindow })
  await seedPurchase('bundle_purchase_ledger', { profileId: buyer, packageKey: 'starter', creditedAt: eventAtWithinWindow })
  await seedVipPurchase({ profileId: buyer, creditedAt: eventAtWithinWindow })
  const result = archiveStore.getArchivalReadiness(campaignId)
  assert(result.ok && result.readiness.pendingPurchaseCoin === 1, `coin: ${JSON.stringify(result)}`)
  assert(result.ok && result.readiness.pendingPurchaseBundle === 1, `bundle: ${JSON.stringify(result)}`)
  assert(result.ok && result.readiness.pendingPurchaseVip === 1, `vip: ${JSON.stringify(result)}`)
})

await check('[A8] getArchivalReadiness: дължима gift-item награда (праг прекосен, непредоставена) -> pendingGiftRewardGaps=1', async () => {
  const senderProfileId = await createRealGiftSender()
  const giftItemId = await seedGiftItem()
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({
    earnRules: [{ gameKind: 'belot', stake: 100, units: 10_000 }],
    giftTierThreshold: 10, giftItemId, senderProfileId,
  })
  const winner = await seedProfile('A8 winner')
  // Начисли директно през admin adjustment (бърз, детерминистичен път до прага) —
  // sender профила не е валиден към момента на credit (campaign е вече finished,
  // но adjustment не го проверява) — продуцираме gap чрез псевдо-невалиден sender.
  // По-просто: директно презаписваме gift sender на несъществуващ, за да garantira gap.
  const dbForBreak = await openRawDb()
  try {
    dbForBreak.prepare(`UPDATE campaigns SET gift_sender_profile_id = NULL WHERE campaign_id = ?;`).run(campaignId)
  } finally {
    dbForBreak.close()
  }
  const creditResult = campaignCreditStore.applyManualAdjustment({
    campaignId, profileId: winner, unitsDelta: 10, reason: 'test', adminProfileId: ADMIN_ACTOR.profileId,
  })
  assert(creditResult.ok, `manual adjustment failed: ${JSON.stringify(creditResult)}`)
  const result = archiveStore.getArchivalReadiness(campaignId)
  assert(result.ok && result.readiness.pendingGiftRewardGaps === 1, `${JSON.stringify(result)}`)
})

await check('[A9] getArchivalReadiness: бот (постоянен каталожен, is_temporary=0) печели в прозореца -> НЕ блокира архивирането завинаги (pendingBelotWin=0, pendingLudoWin=0, ready=true)', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({
    earnRules: [{ gameKind: 'belot', stake: 100, units: 10 }, { gameKind: 'ludo', stake: 0, units: 10 }],
  })
  const botProfileId = await seedProfile('Catalog Bot', { isTemporary: false, profileKind: 'bot' })
  await seedBelotMatchCompletion({ profileId: botProfileId, roomId: `bot-room-${randomUUID().slice(0, 8)}`, endedAt: eventAtWithinWindow })
  await seedLudoMatch({ profileId: botProfileId, stake: 0, finishedAt: eventAtWithinWindow })
  const result = archiveStore.getArchivalReadiness(campaignId)
  assert(result.ok && result.readiness.pendingBelotWin === 0, `pendingBelotWin should stay 0 for a bot win, not block forever: ${JSON.stringify(result)}`)
  assert(result.ok && result.readiness.pendingLudoWin === 0, `pendingLudoWin should stay 0 for a bot win, not block forever: ${JSON.stringify(result)}`)
  assert(result.ok && result.ready, `campaign must remain archivable despite the ineligible bot win: ${JSON.stringify(result)}`)
  const archiveResult = archiveStore.archiveCampaign(campaignId, ADMIN_ACTOR, null)
  assert(archiveResult.ok, `archiveCampaign unexpectedly blocked by bot win: ${JSON.stringify(archiveResult)}`)
})

await check('[A10] getArchivalReadiness: турнирен мач (изрично изключен от кампанийно начисляване) -> НЕ се третира като pending и НЕ се credit-ва впоследствие', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({
    earnRules: [{ gameKind: 'belot', stake: 100, units: 10_000 }],
  })
  const winner = await seedProfile('A10 tournament winner')
  const roomId = `tournament-room-${randomUUID().slice(0, 8)}`
  await seedBelotMatchCompletion({ profileId: winner, roomId, endedAt: eventAtWithinWindow })
  await seedTournamentMatchForRoom(roomId)
  const result = archiveStore.getArchivalReadiness(campaignId)
  assert(result.ok && result.readiness.pendingBelotWin === 0, `tournament match must never count as pending: ${JSON.stringify(result)}`)
  assert(result.ok && result.ready, `campaign must be archivable despite the excluded tournament match: ${JSON.stringify(result)}`)
  const archiveResult = archiveStore.archiveCampaign(campaignId, ADMIN_ACTOR, null)
  assert(archiveResult.ok, `archiveCampaign unexpectedly blocked by tournament match: ${JSON.stringify(archiveResult)}`)
  if (archiveResult.ok) {
    assert(archiveResult.detail.summary.totalUnits === 0, `tournament win must never be credited: ${JSON.stringify(archiveResult.detail.summary)}`)
    assert(archiveResult.detail.summary.participantsCount === 0, `tournament-only winner must not appear as a participant: ${JSON.stringify(archiveResult.detail.summary)}`)
  }
})

// ─── Фаза 12.1 — readiness брои САМО реално дължими (>0 единици) начисления ───

async function seedStakeDebit(roomId: string, profileId: string, amount: number): Promise<void> {
  const db = await openRawDb()
  try {
    db.prepare(`
      INSERT INTO match_economy_ledger (ledger_id, room_id, profile_id, entry_type, amount, balance_after)
      VALUES (?, ?, ?, 'stake_debit', ?, 0);
    `).run(randomUUID(), roomId, profileId, amount)
  } finally {
    db.close()
  }
}

await check('[A11] Белот/Ludo победа БЕЗ earn rule (или с правило за друга ставка) -> не блокира архива', async () => {
  const noRules = await createFinishedCampaign({})
  const winner = await seedProfile('A11 winner')
  await seedBelotMatchCompletion({ profileId: winner, roomId: `a11-room-${randomUUID().slice(0, 8)}`, endedAt: noRules.eventAtWithinWindow })
  await seedLudoMatch({ profileId: winner, stake: 50, finishedAt: noRules.eventAtWithinWindow })
  const result = archiveStore.getArchivalReadiness(noRules.campaignId)
  assert(result.ok && result.ready && result.readiness.pendingBelotWin === 0 && result.readiness.pendingLudoWin === 0, `no earn rule must not block: ${JSON.stringify(result)}`)
  const archived = archiveStore.archiveCampaign(noRules.campaignId, ADMIN_ACTOR, null)
  assert(archived.ok, `archive blocked by a no-rule win: ${JSON.stringify(archived)}`)

  const otherStake = await createFinishedCampaign({ earnRules: [{ gameKind: 'belot', stake: 500, units: 10 }, { gameKind: 'ludo', stake: 500, units: 10 }] })
  await seedBelotMatchCompletion({ profileId: winner, roomId: `a11b-room-${randomUUID().slice(0, 8)}`, endedAt: otherStake.eventAtWithinWindow, stakeAmount: 100 })
  await seedLudoMatch({ profileId: winner, stake: 50, finishedAt: otherStake.eventAtWithinWindow })
  const other = archiveStore.getArchivalReadiness(otherStake.campaignId)
  assert(other.ok && other.ready, `rule for a different stake must not block: ${JSON.stringify(other)}`)

  const zeroUnits = await createFinishedCampaign({ earnRules: [{ gameKind: 'belot', stake: 100, units: 0 }] })
  await seedBelotMatchCompletion({ profileId: winner, roomId: `a11c-room-${randomUUID().slice(0, 8)}`, endedAt: zeroUnits.eventAtWithinWindow })
  const zero = archiveStore.getArchivalReadiness(zeroUnits.campaignId)
  assert(zero.ok && zero.ready, `0-unit rule must not block: ${JSON.stringify(zero)}`)
})

await check('[A12] покупка на пакет без earn rule (coin/bundle/vip) -> не блокира архива', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({ packageRules: [{ packageKey: 'other-package', units: 5 }] })
  const buyer = await seedProfile('A12 buyer')
  await seedPurchase('coin_purchase_ledger', { profileId: buyer, packageKey: 'starter', creditedAt: eventAtWithinWindow })
  await seedPurchase('bundle_purchase_ledger', { profileId: buyer, packageKey: 'starter', creditedAt: eventAtWithinWindow })
  await seedVipPurchase({ profileId: buyer, creditedAt: eventAtWithinWindow })
  const result = archiveStore.getArchivalReadiness(campaignId)
  assert(result.ok && result.ready, `purchases without a matching package rule must not block: ${JSON.stringify(result)}`)
  const archived = archiveStore.archiveCampaign(campaignId, ADMIN_ACTOR, null)
  assert(archived.ok, `archive blocked by a no-rule purchase: ${JSON.stringify(archived)}`)
})

await check('[A13] legacy Белот: неопределима ставка (reconciliation го прескача) не блокира завинаги; доказана ставка с правило -> блокира', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({ earnRules: [{ gameKind: 'belot', stake: 0, units: 5 }, { gameKind: 'belot', stake: 200, units: 7 }] })
  const winner = await seedProfile('A13 winner')
  const opponent = await seedProfile('A13 opponent')
  // Друг участник е дебитиран, победителят — не: legacy sweep-ът логва
  // "insufficient info, skipping" и НИКОГА не начислява реда.
  const unknownStakeRoom = `a13-unknown-${randomUUID().slice(0, 8)}`
  await seedLegacyMatchResult({ profileId: winner, roomId: unknownStakeRoom, completedAt: eventAtWithinWindow })
  await seedStakeDebit(unknownStakeRoom, opponent, 200)
  const skipped = archiveStore.getArchivalReadiness(campaignId)
  assert(skipped.ok && skipped.ready && skipped.readiness.pendingBelotLegacy === 0, `insufficient-stake legacy row must not block forever: ${JSON.stringify(skipped)}`)

  // Собствен stake_debit 200 + правило за 200 -> реално дължимо -> блокира.
  const ownStakeRoom = `a13-own-${randomUUID().slice(0, 8)}`
  await seedLegacyMatchResult({ profileId: winner, roomId: ownStakeRoom, completedAt: eventAtWithinWindow })
  await seedStakeDebit(ownStakeRoom, winner, 200)
  const owed = archiveStore.getArchivalReadiness(campaignId)
  assert(owed.ok && !owed.ready && owed.readiness.pendingBelotLegacy === 1, `owed legacy credit must block: ${JSON.stringify(owed)}`)

  // Възстановяване със същата ставка (както legacy sweep-а) -> отблокира.
  const credit = campaignCreditStore.creditCampaignUnits({
    profileId: winner, sourceType: 'belot_win', sourceId: ownStakeRoom, eventAt: eventAtWithinWindow, stakeAmount: 200,
  })
  assert(credit.ok && credit.unitsCredited === 7, `recovery credit: ${JSON.stringify(credit)}`)
  const recovered = archiveStore.getArchivalReadiness(campaignId)
  assert(recovered.ok && recovered.ready, `recovered campaign must be archivable: ${JSON.stringify(recovered)}`)
})

await check('[A14] реално дължимо, но пропуснато начисление блокира, докато бъде възстановено; непотвърденото поздравление не блокира', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({ earnRules: [{ gameKind: 'belot', stake: 100, units: 10 }] })
  const db = await openRawDb()
  try {
    const tierId = randomUUID()
    db.prepare(`INSERT INTO campaign_reward_tiers (tier_id, campaign_id, threshold_units) VALUES (?, ?, 10);`).run(tierId, campaignId)
    db.prepare(`INSERT INTO campaign_tier_rewards (tier_reward_id, tier_id, reward_type, reward_payload_json) VALUES (?, ?, 'yellow_coins', ?);`)
      .run(randomUUID(), tierId, JSON.stringify({ amount: 100 }))
  } finally {
    db.close()
  }
  const winner = await seedProfile('A14 winner')
  const matchScope = await seedBelotMatchCompletion({ profileId: winner, roomId: `a14-room-${randomUUID().slice(0, 8)}`, endedAt: eventAtWithinWindow })
  const blocked = archiveStore.archiveCampaign(campaignId, ADMIN_ACTOR, null)
  assert(!blocked.ok && blocked.reason === 'reconciliation_incomplete', `missed owed credit must block: ${JSON.stringify(blocked)}`)

  const credit = campaignCreditStore.creditCampaignUnits({
    profileId: winner, sourceType: 'belot_win', sourceId: matchScope, eventAt: eventAtWithinWindow, stakeAmount: 100,
  })
  assert(credit.ok && credit.unitsCredited === 10 && credit.grantedRewards.length === 1 && credit.notification !== null, `recovery credit with reward: ${JSON.stringify(credit)}`)
  assert(campaignCreditStore.listPendingNotifications(winner).length === 1, 'congratulation stays unacknowledged')
  const archived = archiveStore.archiveCampaign(campaignId, ADMIN_ACTOR, null)
  assert(archived.ok && archived.detail.summary.totalUnits === 10 && archived.detail.summary.rewardsGrantedCount === 1, `unacknowledged popup must not block: ${JSON.stringify(archived)}`)
})

// ─── B. archiveCampaign ───

await check('[B1] archiveCampaign: not_finished за draft/active кампания', async () => {
  const createResult = campaignsStore.createDraftCampaign({
    name: 'Draft', startsAt: hoursFromNow(1), endsAt: hoursFromNow(5), unitNameSingular: 'ж', unitNamePlural: 'жета',
  }, SYSTEM_ACTOR)
  if (!createResult.ok) throw new Error('setup failed')
  const result = archiveStore.archiveCampaign(createResult.campaign.campaignId, ADMIN_ACTOR, null)
  assert(!result.ok && result.reason === 'not_finished', `${JSON.stringify(result)}`)
})

await check('[B2] archiveCampaign: campaign_not_found за непознат id', () => {
  const result = archiveStore.archiveCampaign(randomUUID(), ADMIN_ACTOR, null)
  assert(!result.ok && result.reason === 'campaign_not_found', `${JSON.stringify(result)}`)
})

await check('[B3] archiveCampaign: reconciliation_incomplete когато има висящо начисление -> не записва archive', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({ earnRules: [{ gameKind: 'belot', stake: 100, units: 10 }] })
  const winner = await seedProfile('B3 winner')
  await seedBelotMatchCompletion({ profileId: winner, roomId: `room-${randomUUID()}`, endedAt: eventAtWithinWindow })
  const result = archiveStore.archiveCampaign(campaignId, ADMIN_ACTOR, null)
  assert(!result.ok && result.reason === 'reconciliation_incomplete', `${JSON.stringify(result)}`)
  assert(archiveStore.getArchiveDetail(campaignId) === null, 'не трябва да е записан частичен архив')
})

let b4CampaignId!: CampaignId
let b4Winner1!: string
let b4Winner2!: string
await check('[B4] archiveCampaign: успешно замразяване — summary + top10 коректни, campaigns.archived_at сетнат', async () => {
  const created = await createFinishedCampaign({ earnRules: [{ gameKind: 'belot', stake: 100, units: 10 }] })
  b4CampaignId = created.campaignId
  const eventAtWithinWindow = created.eventAtWithinWindow
  b4Winner1 = await seedProfile('B4 Winner One', { rankTitle: 'Майстор' })
  b4Winner2 = await seedProfile('B4 Winner Two', { rankTitle: 'Чирак' })
  const r1 = campaignCreditStore.creditCampaignUnits({ profileId: b4Winner1, sourceType: 'belot_win', sourceId: 'm1', eventAt: eventAtWithinWindow, stakeAmount: 100 })
  assert(r1.ok, `credit 1 failed: ${JSON.stringify(r1)}`)
  const r2 = campaignCreditStore.creditCampaignUnits({ profileId: b4Winner2, sourceType: 'belot_win', sourceId: 'm2', eventAt: eventAtWithinWindow, stakeAmount: 100 })
  assert(r2.ok, `credit 2 failed: ${JSON.stringify(r2)}`)

  const result = archiveStore.archiveCampaign(b4CampaignId, ADMIN_ACTOR, null)
  assert(result.ok, `archive failed: ${JSON.stringify(result)}`)
  if (!result.ok) return
  assert(result.alreadyArchived === false, 'трябва да е НОВО архивиране')
  assert(result.detail.summary.totalUnits === 20, `totalUnits: ${result.detail.summary.totalUnits}`)
  assert(result.detail.summary.unitsFromBelot === 20, `unitsFromBelot: ${result.detail.summary.unitsFromBelot}`)
  assert(result.detail.summary.participantsCount === 2, `participantsCount: ${result.detail.summary.participantsCount}`)
  assert(result.detail.summary.endedReason === 'expired', `endedReason: ${result.detail.summary.endedReason}`)
  assert(result.detail.top10.length === 2, `top10 length: ${result.detail.top10.length}`)
  assert(result.detail.top10[0]!.rank === 1 && result.detail.top10[0]!.unitsTotal === 10, 'rank1')
  assert(result.detail.top10[0]!.rankTitleAtArchive === 'Майстор' || result.detail.top10[0]!.rankTitleAtArchive === 'Чирак', 'rank title frozen')

  const campaign = campaignsStore.getCampaignById(b4CampaignId)
  assert(campaign !== null && campaign.archivedAt !== null, 'campaigns.archived_at трябва да е сетнат')
})

await check('[B5] archiveCampaign: идемпотентно повторно извикване -> alreadyArchived=true, СЪЩИТЕ данни, без презапис', async () => {
  const before = archiveStore.getArchiveDetail(b4CampaignId)
  const result = archiveStore.archiveCampaign(b4CampaignId, ADMIN_ACTOR, '/uploads/should-be-ignored.webp')
  assert(result.ok && result.alreadyArchived === true, `${JSON.stringify(result)}`)
  if (!result.ok) return
  assert(result.detail.summary.unitIconUrlAtArchive === before?.summary.unitIconUrlAtArchive, 'повторен опит не трябва да презапише unitIconUrlAtArchive')
  assert(result.detail.summary.totalUnits === before?.summary.totalUnits, 'totalUnits непроменени')
})

await check('[B5b] Фаза 12 §3: ред "credit commit ПРЕДИ archive readiness-check" -> credit-ът влиза в архива; ред "archive commit ПРЕДИ credit" -> credit-ът safely отказан (no_eligible_campaign), без throw, без счупен архив', async () => {
  // Два отделни, детерминистични редоследа (не истинско multi-thread
  // "състезание" — node:sqlite е синхронно, Node е single-threaded, затова
  // двата възможни редоследа са изцяло детерминистично тествани, не
  // зависими от timing/flakiness).
  const { campaignId: raceCampaignA } = await createFinishedCampaign({
    earnRules: [{ gameKind: 'belot', stake: 100, units: 10 }],
  })
  const racer = await seedProfile('Race winner A')
  const creditBeforeArchive = campaignCreditStore.creditCampaignUnits({
    profileId: racer, sourceType: 'belot_win', sourceId: 'race-match-a',
    eventAt: new Date((Date.parse((campaignsStore.getCampaignById(raceCampaignA)!.startsAt)) + Date.parse(campaignsStore.getCampaignById(raceCampaignA)!.endsAt)) / 2),
    stakeAmount: 100,
  })
  assert(creditBeforeArchive.ok, `credit преди archive трябва да успее: ${JSON.stringify(creditBeforeArchive)}`)
  const archiveAfterCredit = archiveStore.archiveCampaign(raceCampaignA, ADMIN_ACTOR, null)
  assert(archiveAfterCredit.ok, `archive след успешен credit не бива да откаже: ${JSON.stringify(archiveAfterCredit)}`)
  if (archiveAfterCredit.ok) {
    assert(archiveAfterCredit.detail.summary.totalUnits === 10, `credit-ът, записан ПРЕДИ archive, трябва да влезе в totalUnits: ${JSON.stringify(archiveAfterCredit.detail.summary)}`)
  }

  const { campaignId: raceCampaignB } = await createFinishedCampaign({
    earnRules: [{ gameKind: 'belot', stake: 100, units: 10 }],
  })
  const archiveBeforeCredit = archiveStore.archiveCampaign(raceCampaignB, ADMIN_ACTOR, null)
  assert(archiveBeforeCredit.ok, `archive на чисто приключена кампания (0 pending) трябва да успее: ${JSON.stringify(archiveBeforeCredit)}`)
  const campaignBWindow = { startsAt: campaignsStore.getCampaignById(raceCampaignB)!.startsAt, endsAt: campaignsStore.getCampaignById(raceCampaignB)!.endsAt }
  const lateCreditAfterArchive = campaignCreditStore.creditCampaignUnits({
    profileId: racer, sourceType: 'belot_win', sourceId: 'race-match-b',
    eventAt: new Date((Date.parse(campaignBWindow.startsAt) + Date.parse(campaignBWindow.endsAt)) / 2),
    stakeAmount: 100,
  })
  assert(!lateCreditAfterArchive.ok && lateCreditAfterArchive.reason === 'no_eligible_campaign', `credit СЛЕД archive трябва безопасно да откаже (не throw, не "лъжлив" success): ${JSON.stringify(lateCreditAfterArchive)}`)
  const checkDb = await openRawDb()
  try {
    const ledgerRowAfterArchive = checkDb.prepare(`SELECT 1 FROM campaign_unit_ledger WHERE campaign_id = ? AND source_id = 'race-match-b';`).get(raceCampaignB)
    assert(ledgerRowAfterArchive === undefined, 'отказан credit не бива да остави ledger ред')
  } finally {
    checkDb.close()
  }
})

await check('[B6] Последващо преименуване/промяна на ранг на играч НЕ променя вече замразения Топ 10', async () => {
  const detailBefore = archiveStore.getArchiveDetail(b4CampaignId)!
  const frozenName = detailBefore.top10[0]!.displayNameAtArchive
  const frozenRank = detailBefore.top10[0]!.rankTitleAtArchive
  const db = await openRawDb()
  try {
    db.prepare(`UPDATE profiles SET display_name = 'Съвсем Друго Име', rank_title = 'Легенда' WHERE profile_id = ?;`).run(b4Winner1)
  } finally {
    db.close()
  }
  const detailAfter = archiveStore.getArchiveDetail(b4CampaignId)!
  assert(detailAfter.top10[0]!.displayNameAtArchive === frozenName, 'display name трябва да остане замразен')
  assert(detailAfter.top10[0]!.rankTitleAtArchive === frozenRank, 'rank title трябва да остане замразен')
})

await check('[B7] Hard-delete на топ-участник: units/participants непокътнати, но профилът изчезва от Топ 10 вида (profile_id NULL)', async () => {
  await hardDeleteProfileRaw(b4Winner2)
  const detail = archiveStore.getArchiveDetail(b4CampaignId)!
  assert(detail.summary.totalUnits === 20, 'historical totalUnits непроменени след hard-delete на участник')
  assert(detail.summary.participantsCount === 2, 'participantsCount непроменен след hard-delete')
  const row = detail.top10.find((r) => r.displayNameAtArchive === 'B4 Winner Two')
  assert(row !== undefined, 'замразеният Топ10 ред остава (display_name_at_archive snapshot, profile_id FK SET NULL)')
  assert(row!.profileId === null, 'profileId трябва да е nulled след hard-delete (ON DELETE SET NULL)')
})

await check('[B9] campaignAdminStore.updateThemeAsset отказва редакция на архивирана кампания', () => {
  const result = campaignAdminStore.updateThemeAsset(b4CampaignId, 'unit_icon', '/uploads/new.webp', ADMIN_ACTOR)
  assert(!result.ok && result.reason === 'campaign_archived', `${JSON.stringify(result)}`)
})

await check('[B8] Soft-delete на архивирана кампания не унищожава архива/Топ10', async () => {
  const deleteResult = campaignsStore.softDeleteCampaign(b4CampaignId, ADMIN_ACTOR)
  assert(deleteResult.ok, `soft delete failed: ${JSON.stringify(deleteResult)}`)
  const detail = archiveStore.getArchiveDetail(b4CampaignId)
  assert(detail !== null && detail.top10.length === 2, 'архивът трябва да остане напълно читаем след soft-delete')
})

await check('[B10] archiveCampaign: нулево участие -> успешен архив с totalUnits=0, participantsCount=0, празен top10', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({})
  const result = archiveStore.archiveCampaign(campaignId, ADMIN_ACTOR, null)
  assert(result.ok, `${JSON.stringify(result)}`)
  if (!result.ok) return
  assert(result.detail.summary.totalUnits === 0 && result.detail.summary.participantsCount === 0, 'нулево участие')
  assert(result.detail.top10.length === 0, 'празен top10')
})

await check('[B11] archiveCampaign: ended_reason="stopped" за ръчно спряна кампания', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({ manualStop: true })
  const result = archiveStore.archiveCampaign(campaignId, ADMIN_ACTOR, null)
  assert(result.ok && result.detail.summary.endedReason === 'stopped', `${JSON.stringify(result)}`)
})

await check('[B12] archiveCampaign: unitIconUrlAtArchive се записва точно както е подаден', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({})
  const result = archiveStore.archiveCampaign(campaignId, ADMIN_ACTOR, '/uploads/campaign-themes/x/archive/icon.webp')
  assert(result.ok && result.detail.summary.unitIconUrlAtArchive === '/uploads/campaign-themes/x/archive/icon.webp', `${JSON.stringify(result)}`)
})

// ─── C. Топ 10 ранкинг + tie-break ───

await check('[C1] Топ 10: максимум 10 реда, низходящ ред, детерминистичен tie-break (profile_id ASC) при равни units', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({})
  const profiles: Array<{ id: string; units: number }> = []
  for (let i = 0; i < 12; i += 1) {
    const id = await seedProfile(`C1 Player ${i}`)
    const units = i < 2 ? 500 : 100 - i // първите 2 равни (500), после низходящо намаляващи
    const r = campaignCreditStore.applyManualAdjustment({ campaignId, profileId: id, unitsDelta: units, reason: 'seed', adminProfileId: ADMIN_ACTOR.profileId })
    assert(r.ok, `seed credit failed: ${JSON.stringify(r)}`)
    profiles.push({ id, units })
  }
  const result = archiveStore.archiveCampaign(campaignId, ADMIN_ACTOR, null)
  assert(result.ok, `${JSON.stringify(result)}`)
  if (!result.ok) return
  assert(result.detail.top10.length === 10, `очакват се точно 10, получени ${result.detail.top10.length}`)
  for (let i = 1; i < result.detail.top10.length; i += 1) {
    assert(result.detail.top10[i - 1]!.unitsTotal >= result.detail.top10[i]!.unitsTotal, 'низходящ ред')
  }
  const tiedPair = [result.detail.top10[0]!, result.detail.top10[1]!]
  assert(tiedPair[0]!.unitsTotal === 500 && tiedPair[1]!.unitsTotal === 500, 'очакват се двама с равен брой на върха')
  assert(tiedPair[0]!.profileId! < tiedPair[1]!.profileId!, 'tie-break: profile_id ASC')
})

await check('[C2] Топ 10: бот/temp профили никога не влизат в класацията', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({})
  const human = await seedProfile('C2 Human')
  const bot = await seedProfile('C2 Bot', { profileKind: 'bot' })
  const temp = await seedProfile('C2 Temp', { isTemporary: true })
  campaignCreditStore.applyManualAdjustment({ campaignId, profileId: human, unitsDelta: 50, reason: 'x', adminProfileId: ADMIN_ACTOR.profileId })
  // Директно инжектираме totals redове за бот/temp (симулира хипотетичен бъдещ бъг,
  // не нормален път — applyManualAdjustment сам по себе си не ги филтрира с admin
  // override, но Топ10 computation-ът И ТАКА не бива никога да ги покаже).
  const db = await openRawDb()
  try {
    db.prepare(`INSERT INTO campaign_profile_totals (campaign_id, profile_id, units_total) VALUES (?, ?, 999);`).run(campaignId, bot)
    db.prepare(`INSERT INTO campaign_profile_totals (campaign_id, profile_id, units_total) VALUES (?, ?, 999);`).run(campaignId, temp)
  } finally {
    db.close()
  }
  const result = archiveStore.archiveCampaign(campaignId, ADMIN_ACTOR, null)
  assert(result.ok, `${JSON.stringify(result)}`)
  if (!result.ok) return
  assert(result.detail.top10.length === 1, `очаква се само 1 (човешкия), получени ${result.detail.top10.length}`)
  assert(result.detail.top10[0]!.profileId === human, 'само човешкият профил')
})

// ─── D. Admin списъчни изгледи ───

await check('[D1] listFinishedCampaignsForAdmin: изключва draft/scheduled-никога-активирана кампания', async () => {
  const createResult = campaignsStore.createDraftCampaign({
    name: 'Never Activated', startsAt: hoursFromNow(1), endsAt: hoursFromNow(2), unitNameSingular: 'ж', unitNamePlural: 'жета',
  }, SYSTEM_ACTOR)
  if (!createResult.ok) throw new Error('setup failed')
  const scheduleResult = campaignsStore.scheduleCampaign(createResult.campaign.campaignId, SYSTEM_ACTOR)
  assert(scheduleResult.ok, 'setup: schedule failed')
  // Директно местим starts_at/ends_at в миналото и извикваме expire — mirror на scheduler-а.
  const db = await openRawDb()
  try {
    db.prepare(`UPDATE campaigns SET starts_at = ?, ends_at = ? WHERE campaign_id = ?;`).run(hoursFromNow(-2), hoursFromNow(-1), createResult.campaign.campaignId)
  } finally {
    db.close()
  }
  const expireResult = campaignsStore.expireScheduledCampaignWithoutActivating(createResult.campaign.campaignId, new Date(), SYSTEM_ACTOR)
  assert(expireResult.ok, `setup: expire failed: ${JSON.stringify(expireResult)}`)
  const list = archiveStore.listFinishedCampaignsForAdmin()
  assert(!list.some((row) => row.campaignId === createResult.campaign.campaignId), 'никога-активирана кампания не трябва да е в списъка')
})

await check('[D2] listFinishedCampaignsForAdmin: включва архивирана И finished-но-неархивирана, с totalUnits=null за последната', async () => {
  const { campaignId: archivedCampaignId } = await createFinishedCampaign({})
  const archiveResult = archiveStore.archiveCampaign(archivedCampaignId, ADMIN_ACTOR, null)
  assert(archiveResult.ok, 'setup: archive failed')
  const { campaignId: pendingCampaignId, eventAtWithinWindow } = await createFinishedCampaign({ earnRules: [{ gameKind: 'belot', stake: 100, units: 10 }] })
  const winner = await seedProfile('D2 winner')
  await seedBelotMatchCompletion({ profileId: winner, roomId: `room-${randomUUID()}`, endedAt: eventAtWithinWindow })

  const list = archiveStore.listFinishedCampaignsForAdmin()
  const archivedRow = list.find((row) => row.campaignId === archivedCampaignId)
  const pendingRow = list.find((row) => row.campaignId === pendingCampaignId)
  assert(archivedRow !== undefined && archivedRow.archivedAt !== null && archivedRow.totalUnits === 0, `archived row: ${JSON.stringify(archivedRow)}`)
  assert(pendingRow !== undefined && pendingRow.archivedAt === null && pendingRow.totalUnits === null, `pending row: ${JSON.stringify(pendingRow)}`)
})

await check('[D3] listArchivableCandidateIds: само finished/stopped + неархивирани + не-изтрити', async () => {
  const { campaignId: pendingCampaignId, eventAtWithinWindow } = await createFinishedCampaign({})
  const ids = archiveStore.listArchivableCandidateIds()
  assert(ids.includes(pendingCampaignId), 'finished неархивирана кампания трябва да е кандидат')
  const archiveResult = archiveStore.archiveCampaign(pendingCampaignId, ADMIN_ACTOR, null)
  assert(archiveResult.ok, 'setup')
  const idsAfter = archiveStore.listArchivableCandidateIds()
  assert(!idsAfter.includes(pendingCampaignId), 'архивирана кампания вече не е кандидат')
})

await check('[D4] getArchiveDetail: null за finished-но-неархивирана кампания', async () => {
  const { campaignId, eventAtWithinWindow } = await createFinishedCampaign({ earnRules: [{ gameKind: 'belot', stake: 100, units: 10 }] })
  const winner = await seedProfile('D4 winner')
  await seedBelotMatchCompletion({ profileId: winner, roomId: `room-${randomUUID()}`, endedAt: eventAtWithinWindow })
  assert(archiveStore.getArchiveDetail(campaignId) === null, 'getArchiveDetail трябва да е null преди архивиране')
})

campaignsStore.close()
campaignAdminStore.close()
campaignCreditStore.close()
archiveStore.close()
await cleanup()

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
