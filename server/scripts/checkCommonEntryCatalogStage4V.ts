/**
 * checkCommonEntryCatalogStage4V.ts — целеви проверки за Етап 4В (корекция):
 * ЕДИН общ каталог на входовете (match_rooms) за Белот, „Свара“ и
 * „Не се сърди човече“; начална комисиона 20%; наградите — автоматично по
 * общата BigInt формула; админ промени без deploy; започнали мачове пазят
 * фиксираните си условия. Само временна база.
 *
 * Пускане: npx tsx scripts/checkCommonEntryCatalogStage4V.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createMatchRoomsStore } from '../src/db/matchRoomsStore.js'
import { createSvaraEconomyStore } from '../src/db/svaraEconomyStore.js'
import { createSvaraMatchSnapshotStore } from '../src/db/svaraMatchSnapshotStore.js'
import { computeLudoWinnerPrize, createLudoEconomyStore } from '../src/db/ludoEconomyStore.js'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import { getSvaraTableCreationOptions, isSvaraEntryFeeShape, SVARA_TEST_ENTRY_FEES } from '../src/games/svara/svaraTableCreationOptions.js'
import { computeSvaraEntryChips, createSvaraMatch, svaraAnteChipsFor } from '../src/games/svara/engine/svaraMatch.js'
import type { SvaraAccessSession } from '../src/games/svara/svaraAccess.js'
import { checkEntryFeePolicy, parseCommissionPercent } from '../src/economy/entryLevelPolicy.js'
import { BELOT_FORMULA_RULES, computeBelotPrizePerWinner, isValidBelotFinancialTerms, pinLegacyBelotFinancialTerms } from '../src/economy/belotFinancialTerms.js'

let passed = 0
let failed = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) { passed++; console.log(`  PASS  ${label}`) }
  else { failed++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 700)}`}`) }
}
const SERVER_ROOT = join(import.meta.dirname, '..')
const CLIENT_ROOT = join(SERVER_ROOT, '..')
process.env.SVARA_TEST_ENABLED = '1'
const dir = mkdtempSync(join(tmpdir(), 'common-catalog-4v-'))
const dbPath = join(dir, 'catalog.sqlite')
await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
const raw = new DatabaseSync(dbPath)
const rooms = await createMatchRoomsStore(dbPath)
const svara = await createSvaraEconomyStore(dbPath)
const ludo = await createLudoEconomyStore(dbPath)
const profile = (id: string, balance = 1_000_000) => {
  raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
  raw.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance').run(id, balance)
}
const balance = (id: string) => (raw.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(id) as { b: number }).b
const upsert = (stakeAmount: number, siteCommissionBps?: number | null, isEnabled = true) => rooms.upsertRoom({ stakeAmount, minLevel: 1, isEnabled, ...(siteCommissionBps === undefined ? {} : { siteCommissionBps }) })
const svaraPrize = (fee: number, n: number) => svara.previewPrize(fee, n)

console.log('\n[1] Единният каталог: съществуващите маси на Белот, начална комисиона 20%')
{
  const rows = raw.prepare('SELECT stake_amount, prize_amount, site_commission_bps FROM match_rooms ORDER BY stake_amount').all() as Array<{ stake_amount: number; prize_amount: number; site_commission_bps: number }>
  check('5-те съществуващи входа са запазени — без изтриване и дубликати', rows.map((r) => r.stake_amount).join(',') === '5000,8000,10000,15000,20000')
  check('всеки вход има начална комисиона 20%', rows.every((r) => r.site_commission_bps === 2_000))
  check('ръчните prize_amount не са пипани (остават само като legacy)', rows.map((r) => r.prize_amount).join(',') === '8000,12000,15000,22000,30000')
  check('game_financial_configs няма отделна конфигурация за „Свара“', (raw.prepare(`SELECT COUNT(*) AS n FROM game_financial_configs`).get() as { n: number }).n === 0)
}

console.log('\n[2] Белот: наградите по общата формула (4 входа, 2 победители), не ръчните')
{
  const prizes = rooms.listRooms().map((r) => r.prizeAmount).join(',')
  check('5 000 / 8 000 / 10 000 / 15 000 / 20 000 → 8 000 / 12 800 / 16 000 / 24 000 / 32 000', prizes === '8000,12800,16000,24000,32000', prizes)
  check('закръгляне до 100: 5 100 @20% → 8 160 → 8 200', computeBelotPrizePerWinner(5_100, 2_000) === 8_200)
  check('при точно 50 — нагоре: 5 000 @10,50% → 8 950 → 9 000', computeBelotPrizePerWinner(5_000, 1_050) === 9_000)
  check('комисионата е остатъкът: 8 000 → фонд 32 000 − 2 × 12 800 = 6 400', 32_000 - 2 * rooms.getPrizeAmount(8_000)! === 6_400)
  const terms = pinLegacyBelotFinancialTerms(8_000, (s) => rooms.getBelotPrizeTerms(s), 'matchmaking-room-created')
  check('нова маса фиксира belot-formula-v1 с 12 800 и 20%', terms?.rulesVersion === BELOT_FORMULA_RULES && terms.prizePerWinner === 12_800 && terms.siteCommissionBps === 2_000 && isValidBelotFinancialTerms(terms))
}

console.log('\n[3] „Свара“ и „Не се сърди човече“ четат същия каталог и комисиона')
{
  const config = svara.getActiveConfig()
  check('„Свара“: входовете = общите от каталога', config.ok && config.config.entryFees.join(',') === '5000,8000,10000,15000,20000', config)
  check('„Свара“ 10 000: 2/3/4 играчи → 16 000 / 24 000 / 32 000', svaraPrize(10_000, 2) === 16_000 && svaraPrize(10_000, 3) === 24_000 && svaraPrize(10_000, 4) === 32_000)
  check('Белот 15 000 и „Свара“ 15 000 × 4 — един и същ фонд и комисиона (24 000 × 2 = 48 000; 48 000)', rooms.getPrizeAmount(15_000)! * 2 === 48_000 && svaraPrize(15_000, 4) === 48_000)
}

console.log('\n[4] Административни промени (добавяне, редакция, изключване) — веднага, без deploy')
const snapshots = await createSvaraMatchSnapshotStore(dbPath)
const lobby = createSvaraLobby({ persistence: snapshots, hasOtherGameCommitment: () => false, svaraConfig: svara, onError: () => {} })
lobby.initializeRecovery()
const frames = new Map<string, any[]>()
const attach = (id: string) => {
  profile(id)
  frames.set(id, [])
  lobby.attachConnection(id, { profileId: id, getSession: () => ({ account: { role: 'admin' }, profile: { profileId: id } }) as SvaraAccessSession, send: (f) => frames.get(id)!.push(typeof f === 'string' ? JSON.parse(f) : f) })
}
const createSvaraTable = (id: string, entryFee: number) => {
  frames.set(id, [])
  lobby.handle(id, { type: 'create_svara_table', requestId: randomUUID(), capacity: 2, entryFee, entryPercent: 1, startMode: 'manual' } as never)
  return frames.get(id)!.findLast((f) => f.type === 'svara_table_updated' || f.type === 'svara_lobby_error')
}
{
  attach('a1'); attach('a2'); attach('a3')
  const options = () => getSvaraTableCreationOptions(lobby.creationPrize).entries
  // Добавяне
  const added = upsert(50_000)
  check('нов вход 50 000 → 20%, Белот 80 000; „Свара“ и „Не се сърди човече“ го виждат веднага', added.ok && rooms.getRoom(50_000)?.siteCommissionBps === 2_000 && rooms.getPrizeAmount(50_000) === 80_000
    && options().some((e) => e.entryFee === 50_000 && e.prizeByCapacity?.[2] === 80_000) && rooms.getEnabledStakes().includes(50_000))
  check('нов вход — prize_amount колоната получава изчислената стойност (не ръчна)', (raw.prepare('SELECT prize_amount AS p FROM match_rooms WHERE stake_amount = 50000').get() as { p: number }).p === 80_000)
  const fiveFive = upsert(5_500)
  check('5 500 (кратно на 100) → в Белот (8 800) и в „Свара“ (8 800 / 13 200 / 17 600)', fiveFive.ok && rooms.getPrizeAmount(5_500) === 8_800
    && JSON.stringify(options().find((e) => e.entryFee === 5_500)?.prizeByCapacity) === JSON.stringify({ 2: 8_800, 3: 13_200, 4: 17_600 }), options().find((e) => e.entryFee === 5_500))
  const table5500 = createSvaraTable('a3', 5_500)
  check('маса „Свара“ с вход 5 500 → създадена', table5500?.type === 'svara_table_updated' && table5500.table.entryFee === 5_500, table5500)
  check('парсерът: 5 500 ✓; 5 550 / 4 900 / 1 000 000 100 ✗', isSvaraEntryFeeShape(5_500) && !isSvaraEntryFeeShape(5_550) && !isSvaraEntryFeeShape(4_900) && !isSvaraEntryFeeShape(1_000_000_100))
  {
    const match = createSvaraMatch({ tableId: 't-5500', capacity: 2, entryFee: 5_500, startMode: 'manual', creatorId: 'c' })
    check('5 500 → 550 чипа; анте 1% = 5,5 → 6 (нагоре до цял чип)', match.startingChips === 550 && match.entryChips === 6, { startingChips: match.startingChips, entryChips: match.entryChips })
    check('динамично анте при 550 чипа: 2% → 11, 3% → 17, отпадане 2% × 2 = 4% → 22; старт и динамика — едно правило',
      svaraAnteChipsFor(550, 2) === 11 && svaraAnteChipsFor(550, 3) === 17 && svaraAnteChipsFor(550, 4) === 22 && svaraAnteChipsFor(550, 1) === computeSvaraEntryChips(550, 1))
    const existing = [...SVARA_TEST_ENTRY_FEES, 10_000]
    const unchanged = existing.every((fee) => [1, 2, 3, 4, 5, 6, 8, 10, 16, 32].every((p) => svaraAnteChipsFor(fee / 10, p) === Math.max(1, Math.floor((fee / 10) * p / 100))))
    check('досегашните входове (кратни на 1 000): антето е същото като преди при всички проценти', unchanged)
  }
  const created = createSvaraTable('a1', 50_000)
  check('маса „Свара“ с добавения вход 50 000 → създадена, награда 80 000', created?.type === 'svara_table_updated' && created.table.entryFee === 50_000 && created.table.prizeAmount === 80_000, created)
  // Редакция на комисиона
  const edited = upsert(10_000, parseCommissionPercent('25').ok ? 2_500 : null)
  check('комисиона 25% за 10 000 → Белот 15 000, „Свара“ 2 играчи 15 000, Ludo 2 играчи 15 000', edited.ok && rooms.getPrizeAmount(10_000) === 15_000 && svaraPrize(10_000, 2) === 15_000
    && options().find((e) => e.entryFee === 10_000)?.prizeByCapacity?.[2] === 15_000)
  check('редакцията не пипа ръчната (legacy) prize_amount на съществуващ вход', rooms.getLegacyPrizeAmount(10_000) === 15_000)
  const decimal = parseCommissionPercent('12,34')
  check('стъпка 0,01%: 12,34% → 1 234 bps; 12,345% → отказ; 9,99% / 50,01% → отказ', decimal.ok && decimal.bps === 1_234 && !parseCommissionPercent('12,345').ok && !parseCommissionPercent('9,99').ok && !parseCommissionPercent('50,01').ok)
  check('store отказва комисиона извън 10–50%', !upsert(10_000, 999).ok && !upsert(10_000, 5_001).ok && rooms.getRoom(10_000)?.siteCommissionBps === 2_500)
  check('границите на входа: 4 900 / 5 050 / 1 000 000 100 → отказ; 5 000 и 1 000 000 000 → ок', checkEntryFeePolicy(4_900).length > 0 && checkEntryFeePolicy(5_050).length > 0 && checkEntryFeePolicy(1_000_000_100).length > 0 && checkEntryFeePolicy(5_000).length === 0 && checkEntryFeePolicy(1_000_000_000).length === 0)
  upsert(10_000, null)
  check('празна комисиона → 20% по подразбиране', rooms.getRoom(10_000)?.siteCommissionBps === 2_000 && rooms.getPrizeAmount(10_000) === 16_000)
  // Изключване
  const disabled = upsert(8_000, undefined, false)
  check('изключване на 8 000 → изчезва от Белот, „Свара“ и „Не се сърди човече“; остава в каталога', disabled.ok && !rooms.getEnabledStakes().includes(8_000) && !options().some((e) => e.entryFee === 8_000) && rooms.getRoom(8_000)?.isEnabled === false)
  const refused = createSvaraTable('a2', 8_000)
  check('нова маса „Свара“ с изключен вход → отказ', refused?.type === 'svara_lobby_error' && lobby.findCommitment('a2') === null, refused)
  upsert(8_000, undefined, true)
  check('повторно включване → отново навсякъде', rooms.getEnabledStakes().includes(8_000) && options().some((e) => e.entryFee === 8_000))
  lobby.shutdown()
}

console.log('\n[5] Започнали мачове пазят фиксираните условия')
{
  // Белот
  const pinned = pinLegacyBelotFinancialTerms(20_000, (s) => rooms.getBelotPrizeTerms(s), 'matchmaking-room-created')!
  upsert(20_000, 3_000)
  check('Белот: фиксирани 32 000 @20%; след 30% новите маси → 28 000, фиксираните остават валидни с 32 000', pinned.prizePerWinner === 32_000 && rooms.getPrizeAmount(20_000) === 28_000 && isValidBelotFinancialTerms(pinned))
  upsert(20_000, 2_000)
  // „Свара“
  for (const id of ['s1', 's2']) profile(id)
  const collected = svara.collectEntries({ matchId: 'sv-started', entryFee: 15_000, participantIds: ['s1', 's2'] })
  upsert(15_000, 4_000, false)
  const settled = svara.settleMatch('sv-started', 's1')
  check('„Свара“: започнал @20% → след 40% и изключване се изплащат 24 000', collected.ok && settled.ok && settled.prize === 24_000 && balance('s1') === 1_000_000 - 15_000 + 24_000)
  upsert(15_000, 2_000, true)
  // „Не се сърди човече“
  const ludoSnapshot = (matchId: string, a: string, b: string) => ({
    matchId, ludoRoomId: `room-${matchId}`, stake: 10_000, revision: 1, serverNow: Date.now(), deadlineAt: null,
    players: [{ profileId: a, displayName: a, avatarUrl: null, color: 'red' }, { profileId: b, displayName: b, avatarUrl: null, color: 'yellow' }],
    state: { turnOrder: ['red', 'yellow'], activeColor: 'red', turnPhase: 'awaiting_roll', diceValue: null, legalMoves: [],
      pieces: [0, 1, 2, 3].flatMap((slot) => [{ color: 'red', slot, position: { kind: 'home', slot } }, { color: 'yellow', slot, position: { kind: 'home', slot } }]),
      status: 'in_progress', winnerColor: null, turnVersion: 1, pendingExtraRoll: false, leftColors: [] },
    events: [], botControlledColors: [],
  }) as never
  for (const id of ['l1', 'l2', 'l3', 'l4']) profile(id)
  const started = ludo.collectLudoMatchStakesWithInitialSnapshot('ludo-new', ['l1', 'l2'], 10_000, ludoSnapshot('ludo-new', 'l1', 'l2'))
  const termsRow = raw.prepare('SELECT rules_version, entry_fee, site_commission_bps FROM ludo_match_financial_terms WHERE match_id = ?').get('ludo-new') as { rules_version: string; entry_fee: number; site_commission_bps: number } | undefined
  check('„Не се сърди човече“: при старта се фиксира комисионата (ludo-formula-v1, 20%) в същата транзакция', started.ok && termsRow?.rules_version === 'ludo-formula-v1' && termsRow.site_commission_bps === 2_000 && termsRow.entry_fee === 10_000)
  upsert(10_000, 3_500)
  const ludoPaid = ludo.payoutLudoMatchWinner('ludo-new', 'l1')
  check('…след смяна на 35% се изплащат фиксираните 16 000 (20% от 20 000), не 13 000', ludoPaid.ok && ludoPaid.prizeAmount === 16_000)
  upsert(10_000, 2_000)
  // Мач, започнал преди Етап 4В (без ред с условия) → досегашното правило.
  ludo.collectLudoMatchStakesWithInitialSnapshot('ludo-old', ['l3', 'l4'], 10_000, ludoSnapshot('ludo-old', 'l3', 'l4'))
  raw.prepare('DELETE FROM ludo_match_financial_terms WHERE match_id = ?').run('ludo-old')
  const oldPaid = ludo.payoutLudoMatchWinner('ludo-old', 'l3')
  check('мач без фиксирани условия (отпреди 4В) → досегашните 80% (floor)', oldPaid.ok && oldPaid.prizeAmount === computeLudoWinnerPrize(20_000))
  raw.prepare(`INSERT INTO ludo_match_financial_terms (match_id, rules_version, entry_fee, site_commission_bps) VALUES ('ludo-bad', 'ludo-formula-v1', 9000, 2000)`).run()
  ludo.collectLudoMatchStakesWithInitialSnapshot('ludo-bad', ['l1', 'l2'], 10_000, ludoSnapshot('ludo-bad', 'l1', 'l2'))
  const before = balance('l1')
  const badPaid = ludo.payoutLudoMatchWinner('ludo-bad', 'l1')
  check('несъответстващи условия (вход ≠ фонд) → изплащането се задържа, без движение на жълтици', !badPaid.ok && balance('l1') === before)
}

console.log('\n[6] Един източник на истина, админ интерфейс и лобита (статично)')
{
  const index = readFileSync(join(SERVER_ROOT, 'src/index.ts'), 'utf8')
  check('няма отделен админ адрес за входовете на „Свара“', !index.includes('/api/admin/svara/entries') && !index.includes('handleAdminSvaraEntriesRequest'))
  check('няма отделен клиентски модул / превключвател „Белот / Свара“', !existsSync(join(CLIENT_ROOT, 'src/app/lobby/adminSvaraEntries.ts')) && !readFileSync(join(CLIENT_ROOT, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8').includes('data-admin-match-game'))
  const svaraStore = readFileSync(join(SERVER_ROOT, 'src/db/svaraEconomyStore.ts'), 'utf8')
  check('„Свара“ не чете/пише game_financial_configs', !svaraStore.includes('game_financial_configs') && svaraStore.includes('FROM match_rooms'))
  check('„Не се сърди човече“ чете комисионата от match_rooms', readFileSync(join(SERVER_ROOT, 'src/db/ludoEconomyStore.ts'), 'utf8').includes('SELECT site_commission_bps AS bps FROM match_rooms'))
  const handler = /async function handleAdminMatchRoomsRequest[\s\S]*?\n}\r?\n/.exec(index)?.[0] ?? ''
  check('админ „Стаи за мач“: само пълен admin; нов вход по политиката; обща комисиона; без ръчна награда',
    handler.includes('isFullAdminSession(session)') && handler.includes('checkEntryFeePolicy(stakeAmount)') && handler.includes('parseCommissionPercent(rawCommission)') && !handler.includes("'prizeAmount'"))
  check('админ отговорите носят наградите по игри (сървърно изчислени)', (handler.match(/adminMatchRoomsPayload\(\)/g) ?? []).length === 3)
  const screen = readFileSync(join(CLIENT_ROOT, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8')
  check('админ изглед: поле „Комисиона (%)“, без поле за ръчна награда, награди за трите игри',
    screen.includes('name="commissionPercent"') && !screen.includes('name="prizeAmount"') && screen.includes('Свара: 2 играчи') && screen.includes('Не се сърди човече: 2 играчи') && screen.includes('на победител (4 играчи, 2 победители)'))
  check('клиентът не изчислява награди сам (премахнат е ×1,6/1,7/1,8)', !screen.includes('stake >= 100_000 ? 1.8'))
}

lobby.shutdown()
raw.close()
svara.close()
ludo.close()
try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows */ }
console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
process.exit(failed > 0 ? 1 : 0)
