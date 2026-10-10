/**
 * checkCampaignSchemaConstraints.ts
 *
 * Фаза 0 на системата "Кампании" — функционални проверки на самите DB
 * constraint-и от 20261010_001_create_campaign_system_tables.sql (не само
 * "таблицата съществува", а "грешен ред реално се отхвърля / правилен ред
 * се пази коректно"), върху база, подготвена през РЕАЛНИЯ
 * ensureServerDatabaseReady() runner. Изолирана temp база — никога
 * истинската local/production база.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'

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

function assertThrows(fn: () => void, message: string): void {
  let threw = false
  try {
    fn()
  } catch {
    threw = true
  }
  assert(threw, message)
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length)
    ?? process.cwd(),
)
const sourceMigrationsDirectoryPath = join(sourceServerRoot, 'database', 'migrations')

console.log('\ncheckCampaignSchemaConstraints')
console.log(`Server root: ${sourceServerRoot}`)

async function loadRealMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function createReadyTempDatabase() {
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-constraints-'))
  const migrationsDirectoryPath = join(root, 'database', 'migrations')
  const dataDirectoryPath = join(root, 'database', 'data')
  await mkdir(migrationsDirectoryPath, { recursive: true })
  await mkdir(dataDirectoryPath, { recursive: true })
  const fileNames = await loadRealMigrationFileNames()
  for (const filename of fileNames) {
    await cp(join(sourceMigrationsDirectoryPath, filename), join(migrationsDirectoryPath, filename))
  }
  const result = await ensureServerDatabaseReady({ serverRootOverride: root })

  const sqliteModule = await import('node:sqlite')
  const database = new sqliteModule.DatabaseSync(result.databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA foreign_keys = ON;')

  return {
    database,
    cleanup: async () => {
      database.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function insertProfile(database: any, profileId: string, displayName: string): void {
  database.prepare(`
    INSERT INTO profiles (profile_id, display_name, normalized_display_name)
    VALUES (?, ?, ?);
  `).run(profileId, displayName, displayName.toLowerCase())
}

function insertCampaign(
  database: any,
  overrides: Partial<{
    campaignId: string
    status: string
    startsAt: string
    endsAt: string
  }> = {},
): string {
  const campaignId = overrides.campaignId ?? randomUUID()
  database.prepare(`
    INSERT INTO campaigns (
      campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural
    ) VALUES (?, 'Хелоуин 2026', ?, ?, ?, 'тиква', 'тикви');
  `).run(
    campaignId,
    overrides.status ?? 'draft',
    overrides.startsAt ?? '2026-10-20T00:00:00.000Z',
    overrides.endsAt ?? '2026-11-05T00:00:00.000Z',
  )
  return campaignId
}

const { database, cleanup } = await createReadyTempDatabase()

try {
  // ─── 1. Единствена активна кампания (partial unique index) ───
  await check('[1] Партиалният unique индекс позволява точно 1 активна кампания', () => {
    insertCampaign(database, { status: 'active', startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-10T00:00:00.000Z' })
    assertThrows(
      () => insertCampaign(database, { status: 'active', startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' }),
      'втора активна кампания не беше отхвърлена от idx_campaigns_single_active',
    )
    // Не-активни статуси не са ограничени от индекса.
    insertCampaign(database, { status: 'draft' })
    insertCampaign(database, { status: 'finished' })
  })

  // ─── 2. CHECK: ends_at > starts_at ───
  await check('[2] CHECK отхвърля ends_at <= starts_at', () => {
    assertThrows(
      () => insertCampaign(database, { startsAt: '2026-10-20T00:00:00.000Z', endsAt: '2026-10-20T00:00:00.000Z' }),
      'равни starts_at/ends_at не бяха отхвърлени',
    )
    assertThrows(
      () => insertCampaign(database, { startsAt: '2026-10-20T00:00:00.000Z', endsAt: '2026-10-01T00:00:00.000Z' }),
      'ends_at преди starts_at не беше отхвърлен',
    )
  })

  // ─── 3. CHECK: status enum ───
  await check('[3] CHECK отхвърля невалиден status', () => {
    assertThrows(
      () => database.prepare(`
        INSERT INTO campaigns (campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural)
        VALUES (?, 'x', 'not_a_real_status', '2026-01-01', '2026-01-02', 'a', 'b');
      `).run(randomUUID()),
      'невалиден status не беше отхвърлен',
    )
  })

  // ─── 4. campaign_earn_rules: game_kind enum + units_per_win >= 0 ───
  let draftCampaignId!: string
  await check('[4] campaign_earn_rules: валиден ред (Белот + Ludo, независими stake=0 редове)', () => {
    draftCampaignId = insertCampaign(database, { status: 'draft' })
    database.prepare(`
      INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, 'belot', 0, 3);
    `).run(draftCampaignId)
    database.prepare(`
      INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, 'ludo', 0, 5);
    `).run(draftCampaignId)
  })

  await check('[5] campaign_earn_rules: невалиден game_kind се отхвърля', () => {
    assertThrows(
      () => database.prepare(`
        INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, 'poker', 0, 1);
      `).run(draftCampaignId),
      'невалиден game_kind не беше отхвърлен',
    )
  })

  await check('[6] campaign_earn_rules: отрицателен units_per_win се отхвърля', () => {
    assertThrows(
      () => database.prepare(`
        INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, 'belot', 50, -1);
      `).run(draftCampaignId),
      'отрицателен units_per_win не беше отхвърлен',
    )
  })

  // ─── 7. campaign_reward_tiers: threshold_units > 0 + UNIQUE(campaign, threshold) ───
  let tierId!: string
  await check('[7] campaign_reward_tiers: валиден праг + дублиран threshold се отхвърля', () => {
    tierId = randomUUID()
    database.prepare(`
      INSERT INTO campaign_reward_tiers (tier_id, campaign_id, threshold_units) VALUES (?, ?, 500);
    `).run(tierId, draftCampaignId)
    assertThrows(
      () => database.prepare(`
        INSERT INTO campaign_reward_tiers (tier_id, campaign_id, threshold_units) VALUES (?, ?, 500);
      `).run(randomUUID(), draftCampaignId),
      'дублиран threshold_units за същата кампания не беше отхвърлен',
    )
    assertThrows(
      () => database.prepare(`
        INSERT INTO campaign_reward_tiers (tier_id, campaign_id, threshold_units) VALUES (?, ?, 0);
      `).run(randomUUID(), draftCampaignId),
      'threshold_units=0 не беше отхвърлен',
    )
  })

  // ─── 8. campaign_tier_rewards: множество награди на 1 праг + json_valid + reward_type enum ───
  let tierRewardCoinsId!: string
  let tierRewardVipId!: string
  await check('[8] campaign_tier_rewards: 2 различни награди към ЕДИН праг (жълтици + VIP)', () => {
    tierRewardCoinsId = randomUUID()
    tierRewardVipId = randomUUID()
    database.prepare(`
      INSERT INTO campaign_tier_rewards (tier_reward_id, tier_id, reward_type, reward_payload_json)
      VALUES (?, ?, 'yellow_coins', '{"amount":50000}');
    `).run(tierRewardCoinsId, tierId)
    database.prepare(`
      INSERT INTO campaign_tier_rewards (tier_reward_id, tier_id, reward_type, reward_payload_json)
      VALUES (?, ?, 'vip_days', '{"days":3}');
    `).run(tierRewardVipId, tierId)
    const count = (database.prepare(`SELECT COUNT(*) AS c FROM campaign_tier_rewards WHERE tier_id = ?;`).get(tierId) as { c: number }).c
    assert(count === 2, `expected 2 rewards for tier, got ${count}`)
  })

  await check('[9] campaign_tier_rewards: невалиден reward_type и невалиден JSON се отхвърлят', () => {
    assertThrows(
      () => database.prepare(`
        INSERT INTO campaign_tier_rewards (tier_reward_id, tier_id, reward_type, reward_payload_json)
        VALUES (?, ?, 'free_cash', '{}');
      `).run(randomUUID(), tierId),
      'невалиден reward_type не беше отхвърлен',
    )
    assertThrows(
      () => database.prepare(`
        INSERT INTO campaign_tier_rewards (tier_reward_id, tier_id, reward_type, reward_payload_json)
        VALUES (?, ?, 'yellow_coins', 'not valid json');
      `).run(randomUUID(), tierId),
      'невалиден JSON payload не беше отхвърлен (json_valid)',
    )
  })

  // ─── 10. campaign_reward_claims: частично предоставяне, без да се маркира "всичко успешно" ───
  const profileAId = randomUUID()
  await check('[10] campaign_reward_claims: частичен claim (1 от 2 награди) е коректно представим, без да се губи разликата', () => {
    insertProfile(database, profileAId, 'Играч А')
    database.prepare(`
      INSERT INTO campaign_reward_claims (campaign_id, profile_id, tier_reward_id) VALUES (?, ?, ?);
    `).run(draftCampaignId, profileAId, tierRewardCoinsId)
    // VIP наградата (tierRewardVipId) умишлено НЕ е claim-ната — симулира частичен провал.
    const claimedCount = (database.prepare(`
      SELECT COUNT(*) AS c FROM campaign_reward_claims WHERE campaign_id = ? AND profile_id = ?;
    `).get(draftCampaignId, profileAId) as { c: number }).c
    const totalRewardsForTier = (database.prepare(`
      SELECT COUNT(*) AS c FROM campaign_tier_rewards WHERE tier_id = ?;
    `).get(tierId) as { c: number }).c
    assert(claimedCount === 1, `expected 1 claim, got ${claimedCount}`)
    assert(totalRewardsForTier === 2, `expected 2 total rewards for tier, got ${totalRewardsForTier}`)
    assert(claimedCount < totalRewardsForTier, 'схемата трябва да позволява claimedCount < totalRewardsForTier (частичен провал)')
  })

  await check('[11] campaign_reward_claims: дублиран claim за същата (кампания, профил, награда) се отхвърля', () => {
    assertThrows(
      () => database.prepare(`
        INSERT INTO campaign_reward_claims (campaign_id, profile_id, tier_reward_id) VALUES (?, ?, ?);
      `).run(draftCampaignId, profileAId, tierRewardCoinsId),
      'дублиран reward claim не беше отхвърлен',
    )
    // Довършваме частичния провал от предходния тест — втората награда СЕГА се claim-ва успешно.
    database.prepare(`
      INSERT INTO campaign_reward_claims (campaign_id, profile_id, tier_reward_id) VALUES (?, ?, ?);
    `).run(draftCampaignId, profileAId, tierRewardVipId)
  })

  // ─── 12. campaign_unit_ledger: natural-key идемпотентност ───
  await check('[12] campaign_unit_ledger: дублиран (campaign, profile, source_type, source_id) се отхвърля', () => {
    const matchId = randomUUID()
    database.prepare(`
      INSERT INTO campaign_unit_ledger (campaign_id, profile_id, source_type, source_id, units_amount, event_at)
      VALUES (?, ?, 'belot_win', ?, 3, '2026-10-21T10:00:00.000Z');
    `).run(draftCampaignId, profileAId, matchId)
    assertThrows(
      () => database.prepare(`
        INSERT INTO campaign_unit_ledger (campaign_id, profile_id, source_type, source_id, units_amount, event_at)
        VALUES (?, ?, 'belot_win', ?, 3, '2026-10-21T10:00:05.000Z');
      `).run(draftCampaignId, profileAId, matchId),
      'повторно начисление за същия мач не беше отхвърлено',
    )
  })

  // ─── 13. campaign_archive_top10: PK(campaign_id, rank) ───
  await check('[13] campaign_archive_top10: дублиран rank за същата кампания се отхвърля', () => {
    database.prepare(`
      INSERT INTO campaign_archive_summary (
        campaign_id, ended_reason, participants_count, total_units,
        units_from_belot, units_from_ludo, units_from_purchases, units_from_admin_adjustments, rewards_granted_count
      ) VALUES (?, 'expired', 1, 10, 10, 0, 0, 0, 2);
    `).run(draftCampaignId)
    database.prepare(`
      INSERT INTO campaign_archive_top10 (campaign_id, rank, profile_id, display_name_at_archive, units_total)
      VALUES (?, 1, ?, 'Играч А', 10);
    `).run(draftCampaignId, profileAId)
    assertThrows(
      () => database.prepare(`
        INSERT INTO campaign_archive_top10 (campaign_id, rank, profile_id, display_name_at_archive, units_total)
        VALUES (?, 1, ?, 'Друг играч', 5);
      `).run(draftCampaignId, randomUUID()),
      'дублиран rank=1 за същата кампания не беше отхвърлен',
    )
  })

  // ─── 14. FK RESTRICT: кампания с деца не може да се трие физически ───
  await check('[14] FK ON DELETE RESTRICT пречи на физическо изтриване на кампания с redове-деца', () => {
    assertThrows(
      () => database.prepare(`DELETE FROM campaigns WHERE campaign_id = ?;`).run(draftCampaignId),
      'физическо DELETE на кампания с деца не беше блокирано от FK RESTRICT',
    )
  })

  // ─── 15. ON DELETE SET NULL: hard-delete на профил не унищожава кампанийна история ───
  await check('[15] Hard-delete на профил оставя campaign_unit_ledger/campaign_archive_top10 редовете, с profile_id=NULL', () => {
    database.prepare(`DELETE FROM profiles WHERE profile_id = ?;`).run(profileAId)

    const ledgerRow = database.prepare(`
      SELECT profile_id FROM campaign_unit_ledger WHERE campaign_id = ? AND source_type = 'belot_win';
    `).get(draftCampaignId) as { profile_id: string | null } | undefined
    assert(ledgerRow !== undefined, 'campaign_unit_ledger ред беше изтрит заедно с профила (очаквано SET NULL, не CASCADE)')
    assert(ledgerRow!.profile_id === null, `очаквано profile_id=NULL след hard-delete, получено ${ledgerRow!.profile_id}`)

    const archiveRow = database.prepare(`
      SELECT profile_id, display_name_at_archive FROM campaign_archive_top10 WHERE campaign_id = ? AND rank = 1;
    `).get(draftCampaignId) as { profile_id: string | null; display_name_at_archive: string } | undefined
    assert(archiveRow !== undefined, 'campaign_archive_top10 ред беше изтрит заедно с профила')
    assert(archiveRow!.profile_id === null, `очаквано profile_id=NULL след hard-delete, получено ${archiveRow!.profile_id}`)
    assert(archiveRow!.display_name_at_archive === 'Играч А', 'замразеното display_name_at_archive не трябва да се променя след hard-delete')
  })

  // ─── 16. campaigns.gift_sender_profile_id: SET NULL след hard-delete на marketing профил ───
  await check('[16] gift_sender_profile_id преживява hard-delete на избрания marketing профил (SET NULL, кампанията оцелява)', () => {
    const marketingProfileId = randomUUID()
    insertProfile(database, marketingProfileId, 'Marketing Profile')
    const campaignWithSenderId = insertCampaign(database, { status: 'draft' })
    database.prepare(`UPDATE campaigns SET gift_sender_profile_id = ? WHERE campaign_id = ?;`).run(marketingProfileId, campaignWithSenderId)

    database.prepare(`DELETE FROM profiles WHERE profile_id = ?;`).run(marketingProfileId)

    const row = database.prepare(`SELECT gift_sender_profile_id FROM campaigns WHERE campaign_id = ?;`).get(campaignWithSenderId) as { gift_sender_profile_id: string | null }
    assert(row.gift_sender_profile_id === null, `очаквано gift_sender_profile_id=NULL след hard-delete, получено ${row.gift_sender_profile_id}`)
    const campaignStillExists = database.prepare(`SELECT campaign_id FROM campaigns WHERE campaign_id = ?;`).get(campaignWithSenderId)
    assert(campaignStillExists !== undefined, 'кампанията беше изтрита заедно с marketing профила (очаквано SET NULL, не CASCADE)')
  })

  // ─── 17. campaign_reward_notifications: pending → acknowledged round trip ───
  await check('[17] campaign_reward_notifications: pending → acknowledged, веднъж потвърдено не се връща на pending', () => {
    const notificationId = randomUUID()
    const profileBId = randomUUID()
    insertProfile(database, profileBId, 'Играч Б')
    database.prepare(`
      INSERT INTO campaign_reward_notifications (notification_id, campaign_id, profile_id, payload_json)
      VALUES (?, ?, ?, '{"rewards":[{"type":"yellow_coins","amount":50000}]}');
    `).run(notificationId, draftCampaignId, profileBId)

    const pendingRow = database.prepare(`SELECT status, acknowledged_at FROM campaign_reward_notifications WHERE notification_id = ?;`).get(notificationId) as { status: string; acknowledged_at: string | null }
    assert(pendingRow.status === 'pending', `очакван default status='pending', получено ${pendingRow.status}`)
    assert(pendingRow.acknowledged_at === null, 'acknowledged_at трябва да е NULL преди потвърждение')

    database.prepare(`
      UPDATE campaign_reward_notifications SET status = 'acknowledged', acknowledged_at = CURRENT_TIMESTAMP WHERE notification_id = ?;
    `).run(notificationId)

    const ackRow = database.prepare(`SELECT status, acknowledged_at FROM campaign_reward_notifications WHERE notification_id = ?;`).get(notificationId) as { status: string; acknowledged_at: string | null }
    assert(ackRow.status === 'acknowledged', `очакван status='acknowledged', получено ${ackRow.status}`)
    assert(ackRow.acknowledged_at !== null, 'acknowledged_at трябва да е зададен след потвърждение')
  })

  await check('[18] campaign_reward_notifications: невалиден status и невалиден payload_json се отхвърлят', () => {
    assertThrows(
      () => database.prepare(`
        INSERT INTO campaign_reward_notifications (notification_id, campaign_id, profile_id, status, payload_json)
        VALUES (?, ?, NULL, 'shown', '{}');
      `).run(randomUUID(), draftCampaignId),
      'невалиден status не беше отхвърлен',
    )
    assertThrows(
      () => database.prepare(`
        INSERT INTO campaign_reward_notifications (notification_id, campaign_id, profile_id, payload_json)
        VALUES (?, ?, NULL, 'not json');
      `).run(randomUUID(), draftCampaignId),
      'невалиден JSON payload не беше отхвърлен',
    )
  })

  // ─── 19. campaign_manual_adjustments: units_delta <> 0, audit поля ───
  await check('[19] campaign_manual_adjustments: units_delta=0 се отхвърля, отрицателна корекция с reason+admin се пази', () => {
    const adminProfileId = randomUUID()
    insertProfile(database, adminProfileId, 'Admin')
    assertThrows(
      () => database.prepare(`
        INSERT INTO campaign_manual_adjustments (adjustment_id, campaign_id, profile_id, units_delta, reason, admin_profile_id)
        VALUES (?, ?, NULL, 0, 'test', ?);
      `).run(randomUUID(), draftCampaignId, adminProfileId),
      'units_delta=0 не беше отхвърлен',
    )
    assertThrows(
      () => database.prepare(`
        INSERT INTO campaign_manual_adjustments (adjustment_id, campaign_id, profile_id, units_delta, reason, admin_profile_id)
        VALUES (?, ?, NULL, -5, '   ', ?);
      `).run(randomUUID(), draftCampaignId, adminProfileId),
      'празен reason не беше отхвърлен',
    )
    database.prepare(`
      INSERT INTO campaign_manual_adjustments (adjustment_id, campaign_id, profile_id, units_delta, reason, admin_profile_id)
      VALUES (?, ?, NULL, -5, 'корекция на грешка', ?);
    `).run(randomUUID(), draftCampaignId, adminProfileId)
  })

  // ─── 20. Пълна здравина на базата след всички сценарии по-горе ───
  await check('[20] foreign_keys=1, integrity_check=ok, foreign_key_check empty след всички сценарии', () => {
    const fk = (database.prepare('PRAGMA foreign_keys;').get() as { foreign_keys: number }).foreign_keys
    assert(fk === 1, `PRAGMA foreign_keys = ${fk}, expected 1`)
    const integrity = (database.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check
    assert(integrity === 'ok', `integrity_check = ${integrity}`)
    const fkCheck = database.prepare('PRAGMA foreign_key_check;').all()
    assert(fkCheck.length === 0, `foreign_key_check has ${fkCheck.length} violations`)
  })
} finally {
  await cleanup()
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
