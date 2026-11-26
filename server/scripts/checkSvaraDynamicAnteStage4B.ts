/**
 * checkSvaraDynamicAnteStage4B.ts — целеви проверки за Етап 4Б: динамично анте
 * на „Свара“ + админ настройката „Интервал за увеличаване на антето“.
 *
 * Реален runtime + SQLite persistence на „Свара“ във ВРЕМЕННА база,
 * контролиран часовник; „рестарт“ = нов runtime от записания snapshot.
 *
 * Пускане: npx tsx scripts/checkSvaraDynamicAnteStage4B.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdminSettingsStore } from '../src/db/adminSettingsStore.js'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createSvaraMatchSnapshotStore } from '../src/db/svaraMatchSnapshotStore.js'
import { createSvaraMatch, svaraAnteChipsFor, type SvaraMatchState } from '../src/games/svara/engine/svaraMatch.js'
import { createSvaraMatchRuntime, type SvaraMatchRuntime } from '../src/games/svara/runtime/svaraMatchRuntime.js'

let passed = 0
let failed = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) { passed++; console.log(`  PASS  ${label}`) }
  else { failed++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 800)}`}`) }
}

const MIN = 60_000
const T0 = 1_800_000_000_000
const dir = mkdtempSync(join(tmpdir(), 'svara-ante-4b-'))
const dbPath = join(dir, 'svara.sqlite')
await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
const store = await createSvaraMatchSnapshotStore(dbPath)

let clock = T0
const now = () => clock
let serial = 0
const sys = (rt: SvaraMatchRuntime, id: string, command: Parameters<SvaraMatchRuntime['executeSystemCommand']>[2]) => rt.executeSystemCommand(id, `sys-${++serial}`, command)
const act = (rt: SvaraMatchRuntime, id: string, player: string, command: unknown) => rt.executeParticipantCommand(id, { playerId: player }, `c-${++serial}`, command)
const state = (rt: SvaraMatchRuntime, id: string): SvaraMatchState => rt.exportInternalStateForServer(id)

/** Довършва текущото раздаване (всички освен един отказват) до state.round === null. */
function finishRound(rt: SvaraMatchRuntime, id: string): void {
  for (let i = 0; i < 200; i += 1) {
    const round = state(rt, id).round as any
    if (round === null) return
    if ((round.kind === 'ordinary' || round.kind === 'svara') && round.dealing) { sys(rt, id, { type: 'finish-dealing', roundId: round.roundId }); continue }
    if (round.kind === 'ordinary' || round.kind === 'svara') { act(rt, id, round.betting.toAct, { type: 'act', action: { kind: 'fold' } }); continue }
    if (round.kind === 'reveal-choice') { sys(rt, id, { type: 'expire-reveal-choice', roundId: round.roundId }); continue }
    if (round.kind === 'reveal-display') { sys(rt, id, { type: 'close-reveal-display', roundId: round.roundId }); continue }
    if (round.kind === 'showdown-display') { sys(rt, id, { type: 'advance-showdown-display', roundId: round.roundId }); continue }
    if (round.kind === 'payout-display') { sys(rt, id, { type: 'close-payout-display', roundId: round.roundId }); continue }
    if (round.kind === 'svara-joining') { sys(rt, id, { type: 'close-svara-joining', roundId: round.roundId }); continue }
    throw new Error(`unexpected round ${round.kind}`)
  }
  throw new Error('round did not finish')
}
/** Ново раздаване в момента `at` → връща антето (чипове) и процента. */
function deal(rt: SvaraMatchRuntime, id: string, at: number): { chips: number; percent: number } {
  clock = at
  sys(rt, id, { type: 'start-next-round' })
  const s = state(rt, id)
  return { chips: s.entryChips, percent: s.dynamicAnte!.percent }
}
function newMatch(rt: SvaraMatchRuntime, players: string[], intervalMs: number, entryFee = 50_000): string {
  const id = `m${++serial}`
  clock = T0
  rt.registerMatch({ matchId: id, creator: { playerId: players[0]! }, capacity: players.length as 2 | 3 | 4, entryFee, startMode: 'manual', anteIncreaseIntervalMs: intervalMs })
  for (const p of players.slice(1)) act(rt, id, p, { type: 'join-seat' })
  act(rt, id, players[0]!, { type: 'start-match' })
  return id
}

console.log('\n[1] Начало: 1% от първоначалните чипове на един играч')
{
  const rt = createSvaraMatchRuntime({ persistence: store, now, random: { nextInt: () => 0 } })
  const id = newMatch(rt, ['a', 'b', 'c', 'd'], 10 * MIN)
  const s = state(rt, id)
  check('вход 50 000 → 5 000 чипа; анте 1% = 50 (за 4 играчи)', s.startingChips === 5_000 && s.entryChips === 50 && s.dynamicAnte?.percent === 1)
  check('интервал 10 мин и начало = времето на старта', s.dynamicAnte?.intervalMs === 10 * MIN && s.dynamicAnte?.startedAt === T0)
  const two = newMatch(rt, ['x', 'y'], 10 * MIN)
  check('2 играчи също започват с 1% (50)', state(rt, two).entryChips === 50)

  console.log('\n[2] +1 п.п. на всеки 10 минути, само на границата между раздаванията')
  const first = deal(rt, id, T0 + 9 * MIN + 59_000)
  check('9:59 → още 1% (50)', first.percent === 1 && first.chips === 50)
  clock = T0 + 25 * MIN // времето минава ПО СРЕДАТА на раздаването
  const midSnapshot = state(rt, id)
  finishRound(rt, id)
  check('антето не се променя по средата на раздаване (25-та минута, раздаването е от 9:59)', midSnapshot.entryChips === 50 && (midSnapshot.round as any)?.betting?.entryChips === 50)
  const second = deal(rt, id, T0 + 25 * MIN)
  check('следващото раздаване на 25:00 → 3% (две пропуснати граници, приложени наведнъж)', second.percent === 3 && second.chips === 150, second)
  check('антето е спрямо ПЪРВОНАЧАЛНИТЕ чипове (не текущия баланс)', second.chips === svaraAnteChipsFor(5_000, 3))
  finishRound(rt, id)
  const third = deal(rt, id, T0 + 29 * MIN)
  check('29:00 → без повторно прилагане (3%)', third.percent === 3)
  finishRound(rt, id)

  console.log('\n[3] Отпадане → ×2; едновременно с времево увеличение — последователно')
  clock = T0 + 30 * MIN
  act(rt, id, 'd', { type: 'exit' }) // отпадане точно на границата 30:00
  const fourth = deal(rt, id, T0 + 30 * MIN)
  check('30:00 време + отпадане в 30:00 → (3+1)×2 = 8% (първо времето, после удвояването)', fourth.percent === 8 && fourth.chips === 400, fourth)
  const changes = state(rt, id).dynamicAnte!.changes.map((c) => `${c.kind}:${c.percent}`)
  check('история на промените: time 2, time 3, time 4, removal 8', changes.join(',') === 'time:2,time:3,time:4,removal:8', changes)
  finishRound(rt, id)
  clock = T0 + 35 * MIN
  act(rt, id, 'c', { type: 'exit' }) // отпадане ПРЕДИ следващата граница
  const fifth = deal(rt, id, T0 + 40 * MIN)
  check('отпадане в 35:00, граница 40:00 → 8×2 = 16, после +1 = 17%', fifth.percent === 17 && fifth.chips === 850, fifth)
  check('доброволно напускане на вече отпаднал не удвоява повторно', state(rt, id).dynamicAnte!.pendingRemovals.length === 0)
  finishRound(rt, id)

  console.log('\n[4] Специалното правило за финалния двубой е запазено')
  // Двама играчи — „Без залог“ се отключва в 4-тото поредно heads-up раздаване без залог (правило на двигателя).
  const duel = newMatch(rt, ['p', 'q'], 10 * MIN)
  let allowNoBetSeen = false
  for (let n = 0; n < 4; n += 1) {
    deal(rt, duel, T0 + n * MIN)
    const round = state(rt, duel).round as any
    if (round?.isFourthHeadsUp) allowNoBetSeen = true
    sys(rt, duel, { type: 'finish-dealing', roundId: round.roundId })
    // Двамата „без залог“/чек — тук: първият отказва (стрийкът се нулира само при доброволен залог).
    finishRound(rt, duel)
  }
  check('финален двубой: 4-тото поредно heads-up раздаване без залог е специалното (isFourthHeadsUp), при динамично анте', allowNoBetSeen)
}

console.log('\n[5] Рестарт: анте, начало, интервал и броячи се запазват; без повторно прилагане')
{
  const rt = createSvaraMatchRuntime({ persistence: store, now, random: { nextInt: () => 0 } })
  const id = newMatch(rt, ['r1', 'r2', 'r3'], 5 * MIN, 5_000)
  const a = deal(rt, id, T0 + 11 * MIN) // 2 граници → 3%
  finishRound(rt, id)
  const saved = store.load(id)!
  check('преди рестарта: 3%, entryChips = 15', a.percent === 3 && saved.state.entryChips === 15 && saved.state.dynamicAnte?.appliedTimeSteps === 2)
  // „Рестарт“: нов runtime от записаното състояние, сървърът е бил спрян 6 минути.
  const rt2 = createSvaraMatchRuntime({ persistence: store, now, random: { nextInt: () => 0 } })
  rt2.restoreMatchesForServer([saved])
  const restored = state(rt2, id)
  check('възстановени: интервал 5 мин, начало T0, 3%, appliedTimeSteps 2', restored.dynamicAnte?.intervalMs === 5 * MIN && restored.dynamicAnte?.startedAt === T0
    && restored.dynamicAnte?.percent === 3 && restored.entryChips === 15)
  const b = deal(rt2, id, T0 + 14 * MIN)
  check('след рестарта, преди следващата граница (14:00) → пак 3% (без повторно прилагане)', b.percent === 3)
  finishRound(rt2, id)
  const c = deal(rt2, id, T0 + 21 * MIN)
  check('прекъсването се отчита: 21:00 → граници 15 и 20 → 5%', c.percent === 5 && c.chips === 25, c)

  const tampered = structuredClone(store.load(id)!)
  tampered.state.entryChips = 999
  let rejected = false
  try { createSvaraMatchRuntime({ now }).restoreMatchesForServer([tampered]) } catch { rejected = true }
  check('записан snapshot с анте, различно от процента → отказан при възстановяване', rejected)
  const legacy = createSvaraMatch({ tableId: 'legacy', capacity: 2, entryFee: 5_000, startMode: 'manual', creatorId: 'z' })
  check('мач без интервал (стар запис) → фиксирано анте, без dynamicAnte', legacy.dynamicAnte === undefined && legacy.entryChips === 5)
  let invalid = 0
  for (const ms of [59_999, 30 * MIN + 1, 90_000.5]) { try { createSvaraMatch({ tableId: 't', capacity: 2, entryFee: 5_000, startMode: 'manual', creatorId: 'z', anteIncreaseIntervalMs: ms }) } catch { invalid += 1 } }
  check('интервал извън 1..30 минути → отказ', invalid === 3)
}

console.log('\n[6] Админ настройка: запис, граници, само за нови маси')
{
  const settings = await createAdminSettingsStore(dbPath)
  check('по подразбиране 10 минути', settings.getSettings().svaraAnteIncreaseIntervalMinutes === 10)
  const bad = [0, 31, 1.5, -3].map((v) => settings.updateSettings({ svaraAnteIncreaseIntervalMinutes: v }).ok)
  check('0 / 31 / 1,5 / −3 → отказ', bad.every((ok) => ok === false))
  const ok = settings.updateSettings({ svaraAnteIncreaseIntervalMinutes: 3 })
  check('3 минути → записано', ok.ok && settings.getSettings().svaraAnteIncreaseIntervalMinutes === 3, ok)
  const again = await createAdminSettingsStore(dbPath)
  check('устойчиво (нова връзка вижда 3)', again.getSettings().svaraAnteIncreaseIntervalMinutes === 3)
  check('граници 1 и 30 → приети', settings.updateSettings({ svaraAnteIncreaseIntervalMinutes: 1 }).ok && settings.updateSettings({ svaraAnteIncreaseIntervalMinutes: 30 }).ok)

  // Мач, създаден с 30 мин; настройката се сменя на 1 мин → активният мач пази 30.
  const rt = createSvaraMatchRuntime({ persistence: store, now, random: { nextInt: () => 0 } })
  const id = newMatch(rt, ['s1', 's2'], settings.getSettings().svaraAnteIncreaseIntervalMinutes * MIN)
  settings.updateSettings({ svaraAnteIncreaseIntervalMinutes: 1 })
  const d = deal(rt, id, T0 + 5 * MIN)
  check('промяна на настройката не засяга започнат мач (30 мин интервал → на 5:00 пак 1%)', state(rt, id).dynamicAnte?.intervalMs === 30 * MIN && d.percent === 1)
  const fresh = newMatch(rt, ['n1', 'n2'], settings.getSettings().svaraAnteIncreaseIntervalMinutes * MIN)
  const e = deal(rt, fresh, T0 + 5 * MIN)
  check('нов мач взема новата стойност (1 мин → на 5:00 = 6%)', state(rt, fresh).dynamicAnte?.intervalMs === MIN && e.percent === 6)
}

console.log('\n[7] Без принудителен All-in по часовник')
{
  const rt = createSvaraMatchRuntime({ persistence: store, now, random: { nextInt: () => 0 } })
  const id = newMatch(rt, ['w1', 'w2'], MIN, 5_000)
  const before = state(rt, id)
  const big = deal(rt, id, T0 + 600 * MIN) // 601% → 3 005 чипа анте > 500 стек
  const s = state(rt, id)
  const entries = s.ledger.filter((e) => e.type === 'entry' && e.roundId === s.ledger.filter((x) => x.type === 'entry').at(-1)!.roundId)
  const bets = s.ledger.filter((e) => e.type === 'bet' && e.roundId === entries[0]!.roundId)
  check('огромно анте (601% = 3 005 > стек 500): всеки плаща само наличното (съществуващото правило), без залози/ходове', big.percent === 601 && entries.length === 2 && entries.every((e) => e.amount === 500) && bets.length === 0, { entries, bets: bets.length })
  check('мачът не е прекратен и няма автоматичен ход', s.phase === 'in-progress' && before.phase === 'in-progress')
}

console.log('\n[8] Брояч до следващото увеличение (snapshot) и нулиране след отпадане')
{
  const rt = createSvaraMatchRuntime({ persistence: store, now, random: { nextInt: () => 0 } })
  const ante = (id: string, player: string) => rt.getPlayerSnapshot(id, { playerId: player }).table
  // Обичайно времево увеличение: срокът е видим за всички участници и минава към следващия пълен интервал.
  const id = newMatch(rt, ['t1', 't2', 't3'], 10 * MIN, 5_000)
  check('след старта: всички участници виждат срок T0+10:00, без промяна (changedAt null)',
    ['t1', 't2', 't3'].every((p) => ante(id, p).ante?.nextIncreaseAt === T0 + 10 * MIN && ante(id, p).ante?.changedAt === null), ante(id, 't1'))
  deal(rt, id, T0 + 10 * MIN + 5_000); finishRound(rt, id)
  const afterTime = ante(id, 't2')
  check('граница 10:05 → +1 (2%), следващ срок 20:00 (пълен интервал от планираното), changedAt = момента на границата',
    afterTime.entryChips === svaraAnteChipsFor(500, 2) && afterTime.ante?.nextIncreaseAt === T0 + 20 * MIN && afterTime.ante?.changedAt === T0 + 10 * MIN + 5_000, afterTime)

  // „Бягам“ (отказ в раздаване) не е отпадане и не нулира брояча.
  const before = state(rt, id).dynamicAnte!
  deal(rt, id, T0 + 12 * MIN); finishRound(rt, id) // всички освен един отказват
  check('„Бягам“ не нулира: срокът остава 20:00, без удвояване', ante(id, 't1').ante?.nextIncreaseAt === T0 + 20 * MIN
    && state(rt, id).dynamicAnte!.percent === before.percent && state(rt, id).dynamicAnte!.startedAt === before.startedAt)

  // Отпадане (пример от заданието): остават 4:00 → вход ×2 от следващото раздаване, броячът — пълни 10:00.
  clock = T0 + 16 * MIN
  act(rt, id, 't3', { type: 'exit' })
  check('по средата между границите: антето още не е променено, срокът е 20:00', ante(id, 't1').entryChips === svaraAnteChipsFor(500, 2) && ante(id, 't1').ante?.nextIncreaseAt === T0 + 20 * MIN)
  const r = deal(rt, id, T0 + 16 * MIN + 30_000)
  check('следващо раздаване 16:30 → вход ×2 (4%), броячът започва 10:00 (срок 26:30)', r.percent === 4
    && ante(id, 't1').ante?.nextIncreaseAt === T0 + 26 * MIN + 30_000 && ante(id, 't1').ante?.changedAt === T0 + 16 * MIN + 30_000, ante(id, 't1'))
  finishRound(rt, id)
  check('20:00 (старият срок) вече не увеличава', deal(rt, id, T0 + 21 * MIN).percent === 4)
  finishRound(rt, id)
  check('след новите 10:00 (26:30) → обичайното +1 (5%), срок 36:30', deal(rt, id, T0 + 26 * MIN + 30_000).percent === 5 && ante(id, 't1').ante?.nextIncreaseAt === T0 + 36 * MIN + 30_000)
  finishRound(rt, id)

  // Едновременни условия: времеви срок и отпадане на една граница — детерминистично, без двойно увеличение.
  const sim = newMatch(rt, ['u1', 'u2', 'u3', 'u4'], 10 * MIN, 5_000)
  clock = T0 + 9 * MIN + 59_000
  act(rt, sim, 'u4', { type: 'exit' })
  clock = T0 + 9 * MIN + 59_500
  act(rt, sim, 'u3', { type: 'exit' })
  const s = deal(rt, sim, T0 + 10 * MIN + 5_000)
  const changes = state(rt, sim).dynamicAnte!.changes.map((c) => `${c.kind}:${c.percent}`).join(',')
  check('отпадания 9:59 и 9:59,5 + срок 10:00, граница 10:05 → 1×2×2+1 = 5% (по време, по веднъж)', s.percent === 5 && changes === 'removal:2,removal:4,time:5', { s, changes })
  check('само едно нулиране: срок 20:05 (пълен интервал от границата)', ante(sim, 'u1').ante?.nextIncreaseAt === T0 + 20 * MIN + 5_000)
  finishRound(rt, sim)
  check('без повторно прилагане на същата граница/срок', deal(rt, sim, T0 + 11 * MIN).percent === 5)
  finishRound(rt, sim)

  // Възстановяване: срокът след нулиране оцелява при рестарт; стари записи без appliedAt са валидни.
  const saved = store.load(id)!
  const rt2 = createSvaraMatchRuntime({ persistence: store, now, random: { nextInt: () => 0 } })
  rt2.restoreMatchesForServer([saved])
  check('рестарт: същият срок (36:30), вход и changedAt', rt2.getPlayerSnapshot(id, { playerId: 't1' }).table.ante?.nextIncreaseAt === T0 + 36 * MIN + 30_000
    && rt2.getPlayerSnapshot(id, { playerId: 't2' }).table.entryChips === svaraAnteChipsFor(500, 5)
    && rt2.getPlayerSnapshot(id, { playerId: 't1' }).table.ante?.changedAt === T0 + 26 * MIN + 30_000)
  check('рестарт: 36:00 → без промяна; 36:30 → 6%', deal(rt2, id, T0 + 36 * MIN).percent === 5 && (finishRound(rt2, id), deal(rt2, id, T0 + 36 * MIN + 30_000).percent === 6))
  const legacy = structuredClone(saved)
  for (const change of legacy.state.dynamicAnte!.changes) delete change.appliedAt
  let legacyOk = true
  try { createSvaraMatchRuntime({ now }).restoreMatchesForServer([legacy]) } catch { legacyOk = false }
  check('стар запис (без appliedAt в историята) се възстановява; changedAt → null', legacyOk)
  const waiting = `w${++serial}`
  rt.registerMatch({ matchId: waiting, creator: { playerId: 'w1' }, capacity: 2, entryFee: 5_000, startMode: 'manual', anteIncreaseIntervalMs: 10 * MIN })
  check('чакаща маса (lobby): няма срок', rt.getPlayerSnapshot(waiting, { playerId: 'w1' }).table.ante?.nextIncreaseAt === null)
}

try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows */ }
console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
process.exit(failed > 0 ? 1 : 0)
