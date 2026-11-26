/**
 * checkEntryLevelCatalogStage2.ts — целеви проверки за Етап 2 на общата
 * финансова основа:
 *   - server/src/economy/entryLevelCatalogReader.ts (общ read-only интерфейс + /api/rooms payload)
 *   - server/src/economy/entryLevelPolicy.ts (одобрена политика + админ валидация)
 *   - свързването в server/src/index.ts (/api/rooms съвместимост, изплащанията непроменени)
 *
 * Без реален сървър; matchRoomsStore се пуска срещу временна SQLite база,
 * създадена от истинската миграция на match_rooms.
 *
 * Пускане: npx tsx scripts/checkEntryLevelCatalogStage2.ts
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createMatchRoomsStore } from '../src/db/matchRoomsStore.js'
import {
  buildPublicEntryCatalogPayload,
  createEntryLevelCatalogReader,
  tryBuildPublicEntryCatalogPayload,
  type MatchRoomsReadSource,
} from '../src/economy/entryLevelCatalogReader.js'
import {
  checkEntryFeePolicy,
  ENTRY_LEVEL_POLICY,
  formatBpsAsPercent,
  parseCommissionPercent,
  planEntryLevelRemoval,
  validateEntryLevelCreate,
  validateEntryLevelUpdate,
  type ExistingEntryLevel,
} from '../src/economy/entryLevelPolicy.js'

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

const codes = (result: { ok: boolean; errors?: { code: string }[] }): string[] => (result.ok ? [] : (result.errors ?? []).map((e) => e.code))

// 13 нива (вкл. legacy под 5 000) — симулира production набор; стойностите са синтетични.
const thirteen = [1_000, 2_000, 5_000, 8_000, 10_000, 15_000, 20_000, 50_000, 100_000, 200_000, 500_000, 800_000, 1_000_000]
  .map((stakeAmount, index) => ({ stakeAmount, minLevel: index < 7 ? 1 : 5, prizeAmount: stakeAmount * 2, isEnabled: stakeAmount !== 800_000 }))

async function main(): Promise<void> {
  console.log('\n[1] Reader: всички 13 нива се запазват, активните се филтрират')
  {
    let rooms = thirteen.slice()
    const source: MatchRoomsReadSource = { listRooms: () => rooms }
    const reader = createEntryLevelCatalogReader(source)
    const catalog = reader.getCatalog()
    check('13 нива в каталога (нищо не е премахнато)', catalog.levels.length === 13, catalog.levels.length)
    check('0 issues', catalog.issues.length === 0, catalog.issues)
    check('12 активни (800 000 е изключено)', reader.getActiveLevels().length === 12)
    check('getActiveLevel(800000) = null', reader.getActiveLevel(800_000) === null)
    check('getActiveLevel(5000) намира нивото', reader.getActiveLevel(5_000)?.entryFee === 5_000)
    check('legacy 1 000 остава в каталога', reader.getActiveLevel(1_000)?.entryFee === 1_000)
    check('getActiveLevel(непознат) = null', reader.getActiveLevel(7_777) === null)
    check('memo: същият масив → същият каталог', reader.getCatalog() === catalog)
    rooms = rooms.map((r) => (r.stakeAmount === 800_000 ? { ...r, isEnabled: true } : r))
    check('нов масив (reload) → каталогът се обновява', reader.getCatalog() !== catalog && reader.getActiveLevels().length === 13)
    check('изходният масив не е мутиран', thirteen.length === 13 && thirteen.find((r) => r.stakeAmount === 800_000)?.isEnabled === false)
  }

  console.log('\n[2] Reader срещу истински matchRoomsStore + миграцията (локален набор от 5)')
  const dir = mkdtempSync(join(tmpdir(), 'entry-catalog-stage2-'))
  try {
    const dbPath = join(dir, 'test.sqlite')
    const seed = new DatabaseSync(dbPath)
    seed.exec(readFileSync(join(import.meta.dirname, '../database/migrations/20260520_002_create_match_rooms.sql'), 'utf8'))
    seed.close()
    const store = await createMatchRoomsStore(dbPath)
    const before = JSON.stringify(store.listRooms())
    const prizesBefore = store.listRooms().map((r) => store.getPrizeAmount(r.stakeAmount))
    const reader = createEntryLevelCatalogReader(store)
    check('5 активни нива от миграцията', reader.getActiveLevels().map((l) => l.entryFee).join(',') === '5000,8000,10000,15000,20000')
    const payload = buildPublicEntryCatalogPayload(reader.getCatalog())
    check('payload: 5 нива', payload.levels.length === 5)
    check('match_rooms непроменена след четене', JSON.stringify(store.listRooms()) === before)
    check('getPrizeAmount (действащите изплащания) непроменен', JSON.stringify(store.listRooms().map((r) => store.getPrizeAmount(r.stakeAmount))) === JSON.stringify(prizesBefore))
    const raw = new DatabaseSync(dbPath)
    const count = (raw.prepare('SELECT COUNT(*) AS n FROM match_rooms').get() as { n: number }).n
    raw.close()
    check('5 реда в базата (без DELETE/INSERT)', count === 5)
    // Изключване през store-а → reader вижда промяната (общ източник).
    store.upsertRoom({ stakeAmount: 8_000, minLevel: 1, prizeAmount: 12_000, isEnabled: false })
    check('след upsert isEnabled=false → 4 активни', reader.getActiveLevels().length === 4 && reader.getActiveLevel(8_000) === null)
    check('изключеното ниво остава в каталога', reader.getCatalog().getLevel(8_000)?.isEnabled === false)
  } finally {
    // matchRoomsStore няма close(); на Windows файлът остава заключен — best-effort почистване.
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  console.log('\n[3] Payload: наградите са само примерни')
  {
    const reader = createEntryLevelCatalogReader({ listRooms: () => thirteen })
    const p = buildPublicEntryCatalogPayload(reader.getCatalog())
    check('version 1, source match_rooms', p.version === 1 && p.source === 'match_rooms')
    check('informationalOnly = true', p.informationalOnly === true)
    check('commissionConfigured = false', p.commissionConfigured === false)
    check('само активните нива (12)', p.levels.length === 12 && !p.levels.some((l) => l.entryFee === 800_000))
    check('configuredCommissionBps = null за всички', p.levels.every((l) => l.configuredCommissionBps === null))
    check('всеки preview е illustrative + assumed-default 2000', p.levels.every((l) => l.prizePreview.illustrative === true && l.prizePreview.commissionBasis === 'assumed-default' && l.prizePreview.assumedCommissionBps === 2_000))
    check('notice споменава „Примерни“', p.notice.includes('Примерни'))
    const l5000 = p.levels.find((l) => l.entryFee === 5_000)!
    const belot = l5000.prizePreview.items.find((i) => i.gameKey === 'belot')!
    check('Белот 5 000: фонд 20 000, 8 000 на победител, комисиона 4 000',
      belot.status === 'ok' && belot.pot === 20_000 && belot.prizePerWinner === 8_000 && belot.siteCommission === 4_000, belot)
    check('6 формата на ниво', l5000.prizePreview.items.length === 6)
    const legacy = p.levels.find((l) => l.entryFee === 1_000)!
    check('legacy 1 000: policyCompliant=false, entry-fee-below-min', !legacy.policyCompliant && legacy.policyViolations.includes('entry-fee-below-min'))
    check('5 000: policyCompliant=true', l5000.policyCompliant && l5000.policyViolations.length === 0)
    check('policy блок = одобрените граници', p.policy.minEntryFee === 5_000 && p.policy.maxEntryFee === 1_000_000_000 && p.policy.entryFeeStep === 100
      && p.policy.minCommissionBps === 1_000 && p.policy.maxCommissionBps === 5_000 && p.policy.commissionStepBps === 1)
    check('payload-ът няма prizeAmount (не е действащата награда)', !JSON.stringify(p).includes('prizeAmount'))
  }

  console.log('\n[4] /api/rooms съвместимост')
  {
    const rooms = thirteen
    const reader = createEntryLevelCatalogReader({ listRooms: () => rooms })
    const body = JSON.parse(JSON.stringify({ ok: true, rooms, entryCatalog: tryBuildPublicEntryCatalogPayload(reader) }))
    check('ok + rooms + entryCatalog', body.ok === true && Array.isArray(body.rooms) && body.entryCatalog !== null)
    check('rooms идентичен (JSON) със store-а', JSON.stringify(body.rooms) === JSON.stringify(rooms))
    check('всяка стая пази точно stakeAmount/minLevel/prizeAmount/isEnabled',
      body.rooms.every((r: Record<string, unknown>) => Object.keys(r).sort().join(',') === 'isEnabled,minLevel,prizeAmount,stakeAmount'))
    // Клиентският парсер в src/main.ts (loadMatchRooms) изисква само ok + Array.isArray(rooms).
    check('клиентското условие loadMatchRooms е изпълнено', body.ok && Array.isArray(body.rooms))

    const indexSource = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
    const handler = /async function handlePublicRoomsRequest[\s\S]*?\n}\r?\n/.exec(indexSource)?.[0] ?? ''
    check('handler връща rooms: matchRoomsStore.listRooms()', handler.includes('rooms: matchRoomsStore.listRooms()'))
    check('handler добавя entryCatalog чрез fail-safe функцията', handler.includes('tryBuildPublicEntryCatalogPayload(entryLevelCatalogReader'))
    check('изплащанията на Белот остават през prize_amount', /setMatchPrizeResolver\(\(stake\) => matchRoomsStore\.getPrizeAmount\(stake\)\)/.test(indexSource))
    check('readerът не се ползва в изплащания/опашки (само /api/rooms + създаване)', (indexSource.match(/(?<![/\w])entryLevelCatalogReader\b/g) ?? []).length === 2)
    const readerSource = readFileSync(join(import.meta.dirname, '../src/economy/entryLevelCatalogReader.ts'), 'utf8')
    check('reader модулът не пише (няма INSERT/UPDATE/DELETE/upsert)', !/\b(INSERT|UPDATE|DELETE)\b|upsertRoom|deleteRoom/.test(readerSource))
  }

  console.log('\n[5] Обработка на грешки')
  {
    let logged: unknown = null
    const broken = createEntryLevelCatalogReader({ listRooms: () => { throw new Error('db down') } })
    const result = tryBuildPublicEntryCatalogPayload(broken, (e) => { logged = e })
    check('грешка в източника → null, не хвърля', result === null)
    check('грешката е подадена към onError', logged instanceof Error && (logged as Error).message === 'db down')
    check('без onError също не хвърля', tryBuildPublicEntryCatalogPayload(broken) === null)

    const dirty = createEntryLevelCatalogReader({
      listRooms: () => [
        { stakeAmount: 5_000, minLevel: 1, isEnabled: true },
        { stakeAmount: Number.NaN, minLevel: 1, isEnabled: true },
        { stakeAmount: 9_000, minLevel: 0, isEnabled: true },
        { stakeAmount: 10_000, minLevel: 1, isEnabled: true },
        { stakeAmount: 10_000, minLevel: 2, isEnabled: true },
      ],
    })
    const p = tryBuildPublicEntryCatalogPayload(dirty)
    check('невалидни/дублирани редове не чупят payload-а', p !== null && p.levels.map((l) => l.entryFee).join(',') === '5000')
    check('excludedRowCount = 4', p?.excludedRowCount === 4, p?.excludedRowCount)
    const empty = tryBuildPublicEntryCatalogPayload(createEntryLevelCatalogReader({ listRooms: () => [] }))
    check('празна таблица → празен каталог, не null', empty !== null && empty.levels.length === 0)
  }

  console.log('\n[6] Политика: вход')
  {
    const ok = (fee: unknown) => checkEntryFeePolicy(fee).length === 0
    const has = (fee: unknown, code: string) => checkEntryFeePolicy(fee).some((e) => e.code === code)
    check('5 000 ✓', ok(5_000))
    check('1 000 000 000 ✓', ok(1_000_000_000))
    check('5 100 ✓', ok(5_100))
    check('4 900 → below-min', has(4_900, 'entry-fee-below-min'))
    check('1 000 000 100 → above-max', has(1_000_000_100, 'entry-fee-above-max'))
    check('5 050 → not-multiple', has(5_050, 'entry-fee-not-multiple'))
    check('5000.5 → not-integer', has(5000.5, 'entry-fee-not-integer'))
    check('"5000" (string) → not-integer', has('5000', 'entry-fee-not-integer'))
    check('NaN → not-integer', has(Number.NaN, 'entry-fee-not-integer'))
    check('Infinity → not-integer', has(Number.POSITIVE_INFINITY, 'entry-fee-not-integer'))
    check('-5000 → below-min', has(-5_000, 'entry-fee-below-min'))
    check('ENTRY_LEVEL_POLICY е замразен', Object.isFrozen(ENTRY_LEVEL_POLICY))
  }

  console.log('\n[7] Политика: комисиона (10%–50%, точност 0,01%)')
  {
    const bps = (input: unknown) => { const r = parseCommissionPercent(input); return r.ok ? r.bps : r.error.code }
    check('"20" → 2000', bps('20') === 2_000)
    check('"10" → 1000 (долна граница)', bps('10') === 1_000)
    check('"50" → 5000 (горна граница)', bps('50') === 5_000)
    check('"12,34" → 1234', bps('12,34') === 1_234)
    check('"12.5" → 1250', bps('12.5') === 1_250)
    check('12.5 (number) → 1250', bps(12.5) === 1_250)
    check('" 33.33 " → 3333', bps(' 33.33 ') === 3_333)
    check('"10.01" → 1001', bps('10.01') === 1_001)
    check('"12.345" → precision', bps('12.345') === 'commission-precision')
    check('12.345 (number) → precision', bps(12.345) === 'commission-precision')
    check('"9.99" → below-min', bps('9.99') === 'commission-below-min')
    check('"50.01" → above-max', bps('50.01') === 'commission-above-max')
    check('"100" → above-max', bps('100') === 'commission-above-max')
    check('"0" → below-min', bps('0') === 'commission-below-min')
    check('"abc" → invalid-format', bps('abc') === 'commission-invalid-format')
    check('"-20" → invalid-format', bps('-20') === 'commission-invalid-format')
    check('"20%" → invalid-format', bps('20%') === 'commission-invalid-format')
    check('"" → invalid-format', bps('') === 'commission-invalid-format')
    check('NaN → invalid-format', bps(Number.NaN) === 'commission-invalid-format')
    check('1e21 → invalid-format', bps(1e21) === 'commission-invalid-format')
    check('null → invalid-format', bps(null) === 'commission-invalid-format')
    check('formatBpsAsPercent(1250) = "12,50"', formatBpsAsPercent(1_250) === '12,50')
    check('formatBpsAsPercent(1001) = "10,01"', formatBpsAsPercent(1_001) === '10,01')
  }

  console.log('\n[8] Админ валидация: добавяне')
  {
    const existing: ExistingEntryLevel[] = [{ entryFee: 5_000, isEnabled: true }, { entryFee: 10_000, isEnabled: false }]
    const okCreate = validateEntryLevelCreate({ entryFee: 25_000, minLevel: 3, commissionPercent: '15,5' }, existing)
    check('валидно ново ниво', okCreate.ok && okCreate.value.entryFee === 25_000 && okCreate.value.siteCommissionBps === 1_550 && okCreate.value.isEnabled === true)
    const noCommission = validateEntryLevelCreate({ entryFee: 25_000, minLevel: 1 }, existing)
    check('без комисиона → siteCommissionBps = null (не 20%)', noCommission.ok && noCommission.value.siteCommissionBps === null)
    check('дублиран вход → already-exists', codes(validateEntryLevelCreate({ entryFee: 5_000, minLevel: 1 }, existing)).includes('entry-fee-already-exists'))
    check('дублиран изключен вход → already-exists', codes(validateEntryLevelCreate({ entryFee: 10_000, minLevel: 1 }, existing)).includes('entry-fee-already-exists'))
    check('4 900 → below-min', codes(validateEntryLevelCreate({ entryFee: 4_900, minLevel: 1 }, existing)).includes('entry-fee-below-min'))
    check('minLevel 0 → min-level-invalid', codes(validateEntryLevelCreate({ entryFee: 25_000, minLevel: 0 }, existing)).includes('min-level-invalid'))
    check('isEnabled "yes" → is-enabled-invalid', codes(validateEntryLevelCreate({ entryFee: 25_000, minLevel: 1, isEnabled: 'yes' }, existing)).includes('is-enabled-invalid'))
    const multi = codes(validateEntryLevelCreate({ entryFee: 5_050, minLevel: -1, commissionPercent: '60' }, existing))
    check('събира всички грешки наведнъж', multi.includes('entry-fee-not-multiple') && multi.includes('min-level-invalid') && multi.includes('commission-above-max'), multi)
  }

  console.log('\n[9] Админ валидация: редактиране')
  {
    const existing: ExistingEntryLevel[] = [{ entryFee: 1_000, isEnabled: true }, { entryFee: 5_000, isEnabled: true }, { entryFee: 10_000, isEnabled: false }]
    const legacy = validateEntryLevelUpdate(1_000, { minLevel: 2 }, existing)
    check('legacy ниво (под 5 000) може да се редактира', legacy.ok && legacy.value.changes.minLevel === 2)
    check('непознато ниво → not-found', codes(validateEntryLevelUpdate(7_000, { minLevel: 2 }, existing)).includes('entry-level-not-found'))
    check('смяна на входа → immutable', codes(validateEntryLevelUpdate(5_000, { entryFee: 6_000 }, existing)).includes('entry-fee-immutable'))
    check('същият вход в patch-а е позволен', validateEntryLevelUpdate(5_000, { entryFee: 5_000, minLevel: 1 }, existing).ok)
    check('празна промяна → empty-update', codes(validateEntryLevelUpdate(5_000, {}, existing)).includes('empty-update'))
    const commission = validateEntryLevelUpdate(5_000, { commissionPercent: '25' }, existing)
    check('комисиона 25% → 2500 bps', commission.ok && commission.value.changes.siteCommissionBps === 2_500)
    check('комисиона 5% → below-min', codes(validateEntryLevelUpdate(5_000, { commissionPercent: 5 }, existing)).includes('commission-below-min'))
    check('isEnabled "false" (string) → invalid', codes(validateEntryLevelUpdate(5_000, { isEnabled: 'false' }, existing)).includes('is-enabled-invalid'))
    check('деактивиране при друго активно ниво → ok', validateEntryLevelUpdate(5_000, { isEnabled: false }, existing).ok)
    const lastOne: ExistingEntryLevel[] = [{ entryFee: 5_000, isEnabled: true }, { entryFee: 10_000, isEnabled: false }]
    check('деактивиране на последното активно → last-enabled-level', codes(validateEntryLevelUpdate(5_000, { isEnabled: false }, lastOne)).includes('last-enabled-level'))
    check('активиране на изключено ниво → ok', validateEntryLevelUpdate(10_000, { isEnabled: true }, lastOne).ok)
  }

  console.log('\n[10] Деактивиране вместо изтриване')
  {
    const existing: ExistingEntryLevel[] = [{ entryFee: 5_000, isEnabled: true }, { entryFee: 8_000, isEnabled: true }, { entryFee: 10_000, isEnabled: false }]
    const plan = planEntryLevelRemoval(8_000, existing)
    check('активно ниво → action deactivate', plan.ok && plan.action === 'deactivate' && plan.entryFee === 8_000)
    const noop = planEntryLevelRemoval(10_000, existing)
    check('вече изключено → action none', noop.ok && noop.action === 'none')
    check('непознато → not-found', codes(planEntryLevelRemoval(9_999, existing)).includes('entry-level-not-found'))
    check('последното активно → last-enabled-level', codes(planEntryLevelRemoval(5_000, [{ entryFee: 5_000, isEnabled: true }])).includes('last-enabled-level'))
    check('планът никога не връща delete', [plan, noop].every((p) => !p.ok || (p.action as string) !== 'delete'))
  }

  console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
