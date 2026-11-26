/**
 * checkEntryLevelCommissionStage3A.ts — целеви проверки за Етап 3А:
 * индивидуална комисиона match_rooms.site_commission_bps.
 *
 *   - миграция 20261126_001 върху ВРЕМЕННА база със съществуващи нива и prize_amount;
 *   - пълният migration runner върху временен .sqlite (databaseFilePathOverride);
 *   - matchRoomsStore: четене на колоната, стара схема без колоната, upsert я пази;
 *   - каталог + entryCatalog: NULL / зададен процент / смесено / fail-closed;
 *   - /api/rooms съвместимост.
 *
 * Не пипа реалната база. Пускане: npx tsx scripts/checkEntryLevelCommissionStage3A.ts
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createMatchRoomsStore } from '../src/db/matchRoomsStore.js'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import {
  buildPublicEntryCatalogPayload,
  createEntryLevelCatalogReader,
  tryBuildPublicEntryCatalogPayload,
} from '../src/economy/entryLevelCatalogReader.js'
import { computePrizeBreakdown } from '../src/economy/prizeFormula.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

const SERVER_ROOT = join(import.meta.dirname, '..')
const MIGRATIONS = join(SERVER_ROOT, 'database', 'migrations')
const CREATE_SQL = readFileSync(join(MIGRATIONS, '20260520_002_create_match_rooms.sql'), 'utf8')
const COMMISSION_MIGRATION = '20261126_001_match_rooms_site_commission_bps.sql'
const COMMISSION_SQL = readFileSync(join(MIGRATIONS, COMMISSION_MIGRATION), 'utf8')

// 13 нива с нестандартни prize_amount (симулира production; стойностите са синтетични).
const EXTRA_LEVELS: Array<[number, number, number, number]> = [
  [1_000, 1, 1_700, 1], [2_000, 1, 3_300, 1], [50_000, 3, 77_000, 1], [100_000, 5, 150_000, 1],
  [200_000, 5, 310_000, 1], [500_000, 7, 777_000, 1], [800_000, 9, 1_200_000, 0], [1_000_000, 10, 1_550_000, 1],
]

function fullRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare('SELECT stake_amount, min_level, prize_amount, is_enabled, created_at, updated_at FROM match_rooms ORDER BY stake_amount').all() as Array<Record<string, unknown>>
}

function tryExec(db: DatabaseSync, sql: string): boolean {
  try { db.exec(sql); return true } catch { return false }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'entry-commission-3a-'))
  try {
    console.log('\n[1] Миграцията върху временна база със съществуващи нива')
    const legacyPath = join(dir, 'legacy.sqlite')
    {
      const db = new DatabaseSync(legacyPath)
      db.exec(CREATE_SQL)
      const insert = db.prepare('INSERT INTO match_rooms (stake_amount, min_level, prize_amount, is_enabled) VALUES (?, ?, ?, ?)')
      for (const row of EXTRA_LEVELS) insert.run(...row)
      const before = fullRows(db)
      check('преди: 13 нива', before.length === 13)

      db.exec(COMMISSION_SQL)
      const after = fullRows(db)
      check('след: същите 13 реда, всички колони идентични (вкл. prize_amount и timestamps)', JSON.stringify(after) === JSON.stringify(before))
      const commissions = db.prepare('SELECT site_commission_bps AS c FROM match_rooms').all() as Array<{ c: unknown }>
      check('site_commission_bps = NULL за всички (без автоматични 20%)', commissions.every((r) => r.c === null))
      const column = (db.prepare('PRAGMA table_info(match_rooms)').all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>)
        .find((c) => c.name === 'site_commission_bps')
      check('колона INTEGER, nullable, default NULL', column?.type === 'INTEGER' && column.notnull === 0 && (column.dflt_value === null || column.dflt_value === 'NULL'), column)

      console.log('\n[2] CHECK ограничението')
      const set = (v: string) => tryExec(db, `UPDATE match_rooms SET site_commission_bps = ${v} WHERE stake_amount = 5000`)
      check('1000 (10%) ✓', set('1000'))
      check('5000 (50%) ✓', set('5000'))
      check('1234 (12,34%) ✓', set('1234'))
      check('NULL ✓', set('NULL'))
      check('999 ✗', !set('999'))
      check('5001 ✗', !set('5001'))
      check('0 ✗', !set('0'))
      check('-2000 ✗', !set('-2000'))
      check('20.5 (REAL) ✗', !set('20.5'))
      check('2000.5 (REAL) ✗', !set('2000.5'))
      check("'abc' ✗", !set("'abc'"))
      check("'2000' (текст → INTEGER affinity) ✓ и се пази като integer",
        set("'2000'") && (db.prepare("SELECT typeof(site_commission_bps) AS t FROM match_rooms WHERE stake_amount = 5000").get() as { t: string }).t === 'integer')
      check('INSERT на ново ниво без колоната → NULL',
        tryExec(db, 'INSERT INTO match_rooms (stake_amount, min_level, prize_amount, is_enabled) VALUES (30000, 1, 45000, 1)')
        && (db.prepare('SELECT site_commission_bps AS c FROM match_rooms WHERE stake_amount = 30000').get() as { c: unknown }).c === null)
      check('INSERT с 6000 ✗', !tryExec(db, 'INSERT INTO match_rooms (stake_amount, min_level, prize_amount, is_enabled, site_commission_bps) VALUES (40000, 1, 60000, 1, 6000)'))
      db.exec('DELETE FROM match_rooms WHERE stake_amount = 30000')
      db.exec('UPDATE match_rooms SET site_commission_bps = NULL')
      check('prize_amount непроменен след всички опити', JSON.stringify(fullRows(db).map((r) => r.prize_amount)) === JSON.stringify(after.map((r) => r.prize_amount)))
      db.close()
    }

    console.log('\n[3] Пълният migration runner върху временен .sqlite')
    {
      const runnerPath = join(dir, 'runner.sqlite')
      const first = await ensureServerDatabaseReady({ databaseFilePathOverride: runnerPath })
      check('миграцията е приложена от runner-а', first.appliedMigrations.some((m) => m.filename === COMMISSION_MIGRATION))
      const second = await ensureServerDatabaseReady({ databaseFilePathOverride: runnerPath })
      check('втори старт: нищо ново (идемпотентно)', second.appliedCount === 0, second.appliedCount)
      const db = new DatabaseSync(runnerPath)
      const recorded = db.prepare('SELECT COUNT(*) AS n FROM server_migrations WHERE filename = ?').get(COMMISSION_MIGRATION) as { n: number } | undefined
      check('записана в server_migrations', (recorded?.n ?? 0) === 1)
      const seeded = db.prepare('SELECT stake_amount, prize_amount, site_commission_bps FROM match_rooms ORDER BY stake_amount').all() as Array<{ stake_amount: number; prize_amount: number; site_commission_bps: unknown }>
      check('seed-натите 5 нива с NULL комисиона и оригинален prize_amount',
        seeded.length === 5 && seeded.every((r) => r.site_commission_bps === null) && seeded.map((r) => r.prize_amount).join(',') === '8000,12000,15000,22000,30000', seeded)
      db.close()
    }

    console.log('\n[4] matchRoomsStore')
    {
      const store = await createMatchRoomsStore(legacyPath)
      check('празна карта при NULL навсякъде', store.getSiteCommissionBpsByStake().size === 0)
      check('rooms[] пази точно stakeAmount/minLevel/prizeAmount/isEnabled',
        store.listRooms().every((r) => Object.keys(r).sort().join(',') === 'isEnabled,minLevel,prizeAmount,stakeAmount'))
      const raw = new DatabaseSync(legacyPath)
      raw.exec('UPDATE match_rooms SET site_commission_bps = 1500 WHERE stake_amount = 5000')
      raw.exec('UPDATE match_rooms SET site_commission_bps = 1234 WHERE stake_amount = 10000')
      store.reload()
      const map = store.getSiteCommissionBpsByStake()
      check('след reload: 5000→1500, 10000→1234', map.get(5_000) === 1_500 && map.get(10_000) === 1_234 && map.size === 2)
      const prizesBefore = store.listRooms().map((r) => r.prizeAmount)
      // Съществуващият админ път (upsertRoom) не знае за колоната и трябва да я запази.
      const upsert = store.upsertRoom({ stakeAmount: 5_000, minLevel: 2, prizeAmount: 8_000, isEnabled: true })
      check('upsertRoom работи', upsert.ok)
      check('upsertRoom запазва site_commission_bps', store.getSiteCommissionBpsByStake().get(5_000) === 1_500)
      check('getPrizeAmount непроменен', store.getPrizeAmount(5_000) === 8_000 && JSON.stringify(store.listRooms().map((r) => r.prizeAmount)) === JSON.stringify(prizesBefore))
      const inserted = store.upsertRoom({ stakeAmount: 30_000, minLevel: 1, prizeAmount: 45_000, isEnabled: false })
      check('ново ниво през upsertRoom → NULL комисиона', inserted.ok && !store.getSiteCommissionBpsByStake().has(30_000))
      raw.close()

      const oldPath = join(dir, 'old-schema.sqlite')
      const old = new DatabaseSync(oldPath)
      old.exec(CREATE_SQL)
      old.close()
      const oldStore = await createMatchRoomsStore(oldPath)
      check('стара схема без колоната: store работи, 5 нива, празна карта', oldStore.listRooms().length === 5 && oldStore.getSiteCommissionBpsByStake().size === 0)
    }

    console.log('\n[5] entryCatalog: NULL / зададен / смесено')
    {
      const rooms = [
        { stakeAmount: 5_000, minLevel: 1, isEnabled: true },
        { stakeAmount: 10_000, minLevel: 1, isEnabled: true },
        { stakeAmount: 20_000, minLevel: 1, isEnabled: true },
        { stakeAmount: 50_000, minLevel: 1, isEnabled: false },
      ]
      let commissions: ReadonlyMap<number, unknown> = new Map<number, unknown>([[5_000, 1_500], [10_000, 1_234], [50_000, 3_000]])
      const reader = createEntryLevelCatalogReader({ listRooms: () => rooms, getSiteCommissionBpsByStake: () => commissions })
      const p = buildPublicEntryCatalogPayload(reader.getCatalog())
      const l5 = p.levels.find((l) => l.entryFee === 5_000)!
      const l10 = p.levels.find((l) => l.entryFee === 10_000)!
      const l20 = p.levels.find((l) => l.entryFee === 20_000)!

      check('зададен: commissionConfigured true, configuredCommissionBps 1500', l5.commissionConfigured && l5.configuredCommissionBps === 1_500)
      check('зададен: basis configured, commissionBps 1500, assumed null, без notice',
        l5.prizePreview.commissionBasis === 'configured' && l5.prizePreview.commissionBps === 1_500 && l5.prizePreview.assumedCommissionBps === null && l5.commissionNotice === null)
      const b5 = l5.prizePreview.items.find((i) => i.gameKey === 'belot')!
      check('Белот 5 000 @15%: фонд 20 000, 8 500 на победител, комисиона 3 000',
        b5.status === 'ok' && b5.pot === 20_000 && b5.prizePerWinner === 8_500 && b5.siteCommission === 3_000, b5)
      const b10 = l10.prizePreview.items.find((i) => i.gameKey === 'belot')!
      const direct = computePrizeBreakdown({ entryFee: 10_000, paidEntries: 4, winners: 2, siteCommissionBps: 1_234 })
      check('Белот 10 000 @12,34% = директно computePrizeBreakdown',
        direct.ok && b10.status === 'ok' && b10.prizePerWinner === direct.breakdown.prizePerWinner && b10.siteCommission === direct.breakdown.siteCommission, { b10, direct })
      check('12,34%: 17 532 → 17 500/победител, комисиона 5 000', b10.status === 'ok' && b10.prizePerWinner === 17_500 && b10.siteCommission === 5_000, b10)
      check('всички формати при 5 000 ползват 15%', l5.prizePreview.items.every((i) => {
        if (i.status !== 'ok') return false
        const r = computePrizeBreakdown({ entryFee: 5_000, paidEntries: i.paidEntries, winners: i.winners, siteCommissionBps: 1_500 })
        return r.ok && r.breakdown.prizePerWinner === i.prizePerWinner && r.breakdown.siteCommission === i.siteCommission
      }))

      check('NULL: commissionConfigured false, configuredCommissionBps null', !l20.commissionConfigured && l20.configuredCommissionBps === null)
      check('NULL: basis assumed-default, 2000, notice „не е конфигуриран“',
        l20.prizePreview.commissionBasis === 'assumed-default' && l20.prizePreview.commissionBps === 2_000 && l20.prizePreview.assumedCommissionBps === 2_000
        && (l20.commissionNotice ?? '').includes('не е конфигуриран'))
      check('всички preview-та остават illustrative', p.levels.every((l) => l.prizePreview.illustrative === true) && p.informationalOnly === true)

      check('смесено: top-level commissionConfigured false, configuredLevelCount 2', p.commissionConfigured === false && p.configuredLevelCount === 2)
      check('смесено: notice споменава предполагаеми 20%', p.notice.includes('20%'))
      check('изключено ниво (50 000) не е в levels', !p.levels.some((l) => l.entryFee === 50_000))

      commissions = new Map<number, unknown>([[5_000, 1_500], [10_000, 1_234], [20_000, 5_000]])
      const all = buildPublicEntryCatalogPayload(reader.getCatalog())
      check('нова карта → каталогът се обновява; всички зададени → top-level true', all.commissionConfigured === true && all.configuredLevelCount === 3)
      check('всички зададени: notice без „предполагаеми“', !all.notice.includes('предполагаеми'))

      const none = buildPublicEntryCatalogPayload(createEntryLevelCatalogReader({ listRooms: () => rooms }).getCatalog())
      check('източник без getSiteCommissionBpsByStake → всички NULL (Етап 2 поведение)', none.commissionConfigured === false && none.configuredLevelCount === 0
        && none.levels.every((l) => l.prizePreview.assumedCommissionBps === 2_000))
      const empty = buildPublicEntryCatalogPayload(createEntryLevelCatalogReader({ listRooms: () => [] }).getCatalog())
      check('без активни нива → commissionConfigured false', empty.commissionConfigured === false && empty.levels.length === 0)
    }

    console.log('\n[6] Fail-closed при невалидна стойност в базата')
    {
      const rooms = [
        { stakeAmount: 5_000, minLevel: 1, isEnabled: true },
        { stakeAmount: 10_000, minLevel: 1, isEnabled: true },
        { stakeAmount: 15_000, minLevel: 1, isEnabled: true },
        { stakeAmount: 20_000, minLevel: 1, isEnabled: true },
        { stakeAmount: 25_000, minLevel: 1, isEnabled: true },
        { stakeAmount: 30_000, minLevel: 1, isEnabled: true },
      ]
      const bad = new Map<number, unknown>([[10_000, 999], [15_000, 2000.5], [20_000, '2000'], [25_000, 9_999], [30_000, 1_000]])
      const p = tryBuildPublicEntryCatalogPayload(createEntryLevelCatalogReader({ listRooms: () => rooms, getSiteCommissionBpsByStake: () => bad }))
      check('payload се изгражда', p !== null)
      check('невалидните (999, 2000.5, "2000", 9999) не се показват — нито с 20%', p?.levels.map((l) => l.entryFee).join(',') === '5000,30000', p?.levels.map((l) => l.entryFee))
      check('excludedRowCount = 4', p?.excludedRowCount === 4, p?.excludedRowCount)
      check('валидната граница 1000 се показва като зададена', p?.levels.find((l) => l.entryFee === 30_000)?.configuredCommissionBps === 1_000)
      const throwing = tryBuildPublicEntryCatalogPayload(createEntryLevelCatalogReader({ listRooms: () => rooms, getSiteCommissionBpsByStake: () => { throw new Error('boom') } }))
      check('грешка при четене на комисиите → null, не хвърля', throwing === null)
    }

    console.log('\n[7] API съвместимост и непроменени области')
    {
      const store = await createMatchRoomsStore(legacyPath)
      const reader = createEntryLevelCatalogReader(store)
      const body = JSON.parse(JSON.stringify({ ok: true, rooms: store.listRooms(), entryCatalog: tryBuildPublicEntryCatalogPayload(reader) }))
      check('rooms без нови ключове (siteCommissionBps не изтича в rooms)',
        body.rooms.every((r: Record<string, unknown>) => Object.keys(r).sort().join(',') === 'isEnabled,minLevel,prizeAmount,stakeAmount'))
      check('entryCatalog отразява реалната база (5 000 @15%)', body.entryCatalog.levels.find((l: { entryFee: number }) => l.entryFee === 5_000)?.configuredCommissionBps === 1_500)
      const stage2Keys = ['entryFee', 'minLevel', 'policyCompliant', 'policyViolations', 'configuredCommissionBps', 'prizePreview']
      check('Етап 2 полетата на ниво са налични', body.entryCatalog.levels.every((l: Record<string, unknown>) => stage2Keys.every((k) => k in l)))
      check('Етап 2 top-level полетата са налични', ['version', 'source', 'informationalOnly', 'commissionConfigured', 'policy', 'levels', 'excludedRowCount', 'notice'].every((k) => k in body.entryCatalog))

      const untouched = ['src/economy/prizeFormula.ts', 'src/economy/entryLevelCatalog.ts', 'src/economy/entryLevelPolicy.ts']
      const diff = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', ...untouched], { cwd: SERVER_ROOT, encoding: 'utf8' }).trim()
      check('формулата, каталогът и политиката — непроменени', diff === '', diff)
      // index.ts се променя в следващите етапи — проверяваме съдържателно, не по diff.
      const indexSource = readFileSync(join(SERVER_ROOT, 'src/index.ts'), 'utf8')
      check('admin endpoint-ите за ниво: upsertRoom + deleteRoom непроменени',
        indexSource.includes('matchRoomsStore.upsertRoom({ stakeAmount, minLevel, prizeAmount, isEnabled })') && indexSource.includes('matchRoomsStore.deleteRoom(stakeAmount)'))
      check('index.ts не пише site_commission_bps', !indexSource.includes('site_commission_bps'))
      const storeSource = readFileSync(join(SERVER_ROOT, 'src/db/matchRoomsStore.ts'), 'utf8')
      check('store не пише site_commission_bps', !/(INSERT|UPDATE)[^;`]*site_commission_bps/.test(storeSource))
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows: store-ът държи файла отворен */ }
  }

  console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
