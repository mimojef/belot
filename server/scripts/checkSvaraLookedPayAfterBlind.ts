/**
 * checkSvaraLookedPayAfterBlind.ts — игра на тъмно (правило от 28.11.2026):
 *
 *  • Тъмният залог се брои двойно, докато играчът не е погледнал (27.11.2026).
 *  • Играта на тъмно продължава, докато погледнал играч не плати или не
 *    повиши успешно. Самото поглеждане и „Погледна и бяга“ не я прекратяват.
 *  • Успешно плащане/повишаване на погледнал играч я затваря за цялото
 *    раздаване: картите на останалите активни играчи се обръщат (всеки вижда
 *    само своите), „Тъмни“ изчезва, нов тъмен залог е забранен на сървъра.
 *    Обърнатият тъмен залог вече не се брои двойно (както при повишаване) —
 *    но НИЩО не се удържа автоматично: на своя ред играчът избира „Плати“
 *    (разликата), „Вдигни“ или „Бягам“ (губи вече внесеното).
 *  • Без връщане към тъмно в същото раздаване; ново раздаване — отначало.
 *
 * Части [1]–[8]: чиста логика по реалната верига
 *   сървърни опции (describeSvaraBettingOptions) → клиентски бутони
 *   (deriveSvaraActionButtons) → сървърно действие (applySvaraBettingAction +
 *   затварянето, както svaraMatch.act) → банка (buildSvaraPotLayers).
 * Части [9]–[11]: истински сървърен път (runtime + svaraMatch + SQLite
 *   persistence + snapshot към клиента): 2/3/4 играчи, поверителност на
 *   картите, следващо раздаване, възстановяване след рестарт.
 *
 * Пускане (от server/): npx tsx scripts/checkSvaraLookedPayAfterBlind.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applySvaraBettingAction,
  createSvaraBetting,
  describeSvaraBettingOptions,
  lookAtSvaraCards,
  requireCallsAfterBlindClose,
  revealUnlookedHands,
  svaraBlindDoubledContributions,
  svaraBlindPlayers,
  type SvaraBettingAction,
  type SvaraBettingState,
} from '../src/games/svara/engine/svaraBetting.js'
import { buildSvaraPotLayers } from '../src/games/svara/engine/svaraPots.js'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createSvaraMatchSnapshotStore } from '../src/db/svaraMatchSnapshotStore.js'
import { createSvaraMatchRuntime, type SvaraMatchRuntime } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import { serializeSvaraSnapshotForClient } from '../src/games/svara/protocol/svaraSnapshotProtocol.js'
import { deriveSvaraActionButtons } from '../../src/app/games/svara/table/svaraBettingActions.js'
import { detectSvaraFinalCall, detectSvaraFinalStayBlind, isSvaraOpeningPay, svaraEntryLightTotal, svaraRaiseAmount } from '../../src/app/games/svara/table/svaraBetAnimationTracker.js'

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) { passed++; console.log(`  PASS  ${name}`) } else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const ENTRY = 5
const STACK = 1000

type Game = { state: SvaraBettingState; stacks: Record<string, number>; players: string[] }

function start(title: string, players: string[]): Game {
  console.log(`\n${title}`)
  const stacks = Object.fromEntries(players.map((id) => [id, STACK]))
  return { state: createSvaraBetting({ order: players, stacks, folded: [], entryChips: ENTRY, allowNoBet: false }), stacks, players }
}

/** Действие на сървъра, както svaraMatch.act: при затваряне на тъмното — обръщане и нов ход за обърнатите. */
function act(game: Game, playerId: string, action: SvaraBettingAction): number {
  const wasOpen = game.state.blind.status !== 'closed'
  const result = applySvaraBettingAction(game.state, playerId, action, game.stacks[playerId]!)
  game.stacks[playerId] = game.stacks[playerId]! - result.added
  game.state = result.state
  if (wasOpen && game.state.blind.status === 'closed') game.state = requireCallsAfterBlindClose(revealUnlookedHands(game.state), playerId)
  return result.added
}

function look(game: Game, playerId: string): void { game.state = lookAtSvaraCards(game.state, playerId) }

function buttons(game: Game, playerId: string) {
  const options = describeSvaraBettingOptions(game.state, playerId, game.stacks[playerId]!)
  return { options, list: deriveSvaraActionButtons(options as never, game.state.looked.includes(playerId), ENTRY) }
}

const hasBlindButton = (game: Game, playerId: string) => buttons(game, playerId).list.some((b) => b.label.startsWith('Тъмни') || (b.command as { action?: { kind?: string } } | null)?.action?.kind === 'blind-bet')

/** Клиентската обява за последния запис (огледало на flushBetAnimations). */
function announcement(game: Game): { speech: string; potFlash: number | null } {
  const log = game.state.log
  const entry = log.at(-1)!
  const previousBet = log.slice(0, -1).reduce((max, prior) => Math.max(max, svaraEntryLightTotal(prior)), 0)
  const e = { kind: entry.kind as never, total: entry.total, previousBet, blind: entry.blind }
  if (entry.kind === 'stay-blind') return { speech: 'Оставам на тъмно', potFlash: null }
  if (entry.allIn || entry.kind === 'all-in') return { speech: 'ОЛ-ИН!', potFlash: entry.added }
  if (entry.kind === 'call') return { speech: `Плащам ${entry.added}`, potFlash: entry.added }
  if (entry.kind === 'blind-bet') return { speech: `Тъмни ${entry.added}`, potFlash: svaraRaiseAmount(e) }
  const raise = svaraRaiseAmount(e)
  if (raise !== null) return { speech: `Вдигам +${raise}`, potFlash: raise }
  if (isSvaraOpeningPay(e)) return { speech: `Залагам ${entry.added}`, potFlash: entry.added }
  return { speech: '(без обява)', potFlash: null }
}

/** Банката както settleOrdinary: Вход + доброволни; тъмните (необърнати) — двойно за правото на банка. */
function pots(game: Game) {
  const contributions = Object.fromEntries(game.players.map((id) => [id, ENTRY + (game.state.voluntary[id] ?? 0)]))
  return buildSvaraPotLayers({ participants: game.players, contributions, folded: game.state.folded, blindDoubled: svaraBlindDoubledContributions(game.state) })
}

function chipsConserved(game: Game): boolean {
  return game.players.every((id) => STACK - game.stacks[id]! === (game.state.voluntary[id] ?? 0))
}

/** Общото начало: A тъмно 10, B тъмно 20 (= 40), A поглежда. */
function blindBlindLook(title: string): Game {
  const game = start(title, ['A', 'B'])
  act(game, 'A', { kind: 'blind-bet', total: 10 })
  act(game, 'B', { kind: 'blind-bet', total: 20 })
  look(game, 'A')
  return game
}

// ── [1] Поглежда и плаща → всички на светло ─────────────────────────────────
{
  const game = blindBlindLook('[1] 2 играчи: A тъмно 10 → B тъмно 20 → A Виж → A „Плати“')
  check('текущият залог след двата тъмни е 40 (тъмният се брои двойно)', game.state.currentBet === 40)
  check('само поглеждането не прекратява тъмното', game.state.blind.status === 'active')
  const { options, list } = buttons(game, 'A')
  check('A: сървърът предлага плащане до 40 и повишаване от 45', options.call === 40 && options.bet?.min === 45, JSON.stringify(options))
  const pay = list.find((b) => b.kind === 'pay')
  check('A: бутонът „Плати 40“ изпраща call', pay?.label === 'Плати 40' && JSON.stringify(pay.command) === JSON.stringify({ type: 'act', action: { kind: 'call' } }), JSON.stringify(pay))
  const added = act(game, 'A', { kind: 'call' })
  check('от A се удържат 30 (общо 40); обява „Плащам 30“', added === 30 && game.state.voluntary.A === 40 && announcement(game).speech === 'Плащам 30')
  check('тъмната игра приключва; картите на B се обръщат автоматично', game.state.blind.status === 'closed' && game.state.looked.includes('B') && svaraBlindPlayers(game.state).length === 0)
  check('от B НЕ се удържа нищо автоматично (остава 20)', game.state.voluntary.B === 20 && game.stacks.B === STACK - 20)
  check('B е на ход; наддаването не е приключило', game.state.toAct === 'B' && !game.state.complete)
  const b = buttons(game, 'B')
  check('B: „Плати 40“ (доплаща 20), „Вдигни“ от 45, „Бягам“; без „Тъмни“ и „Остани на тъмно“',
    b.options.call === 40 && b.options.bet?.min === 45 && b.options.fold && b.options.blindBet === null && !b.options.stayBlind && !hasBlindButton(game, 'B')
    && b.list.find((x) => x.kind === 'pay')?.label === 'Плати 40', JSON.stringify(b.options))
  let refused = ''
  try { act(game, 'B', { kind: 'blind-bet', total: 40 }) } catch (error) { refused = (error as { code?: string }).code ?? '' }
  check('сървърът отказва тъмен залог след преминаването към светло', refused === 'blind-not-allowed', refused)
  check('чиповете са точно внесеното', chipsConserved(game))
}

// ── [1a] B плаща разликата ──────────────────────────────────────────────────
{
  const game = blindBlindLook('[1a] … B „Плати“ (доплаща разликата)')
  act(game, 'A', { kind: 'call' })
  const added = act(game, 'B', { kind: 'call' })
  check('B доплаща 20 → по 40; край; обява „Плащам 20“', added === 20 && game.state.voluntary.B === 40 && game.state.complete && announcement(game).speech === 'Плащам 20')
  check('банка 90 (80 + 10 Вход), спорна за двамата', pots(game).length === 1 && pots(game)[0]!.amount === 90 && pots(game)[0]!.eligible.join() === 'A,B')
}

// ── [1b] B вдига ────────────────────────────────────────────────────────────
{
  const game = blindBlindLook('[1b] … B „Вдигни“ 60')
  act(game, 'A', { kind: 'call' })
  const added = act(game, 'B', { kind: 'bet', total: 60 })
  check('B внася 40 (до 60); „Вдигам +20“; A е на ход', added === 40 && announcement(game).speech === 'Вдигам +20' && game.state.toAct === 'A', JSON.stringify(announcement(game)))
  check('A (вече на светло) няма „Тъмни“', !hasBlindButton(game, 'A') && buttons(game, 'A').options.call === 60)
  act(game, 'A', { kind: 'call' })
  check('A доплаща 20 → по 60; край', game.state.voluntary.A === 60 && game.state.complete && chipsConserved(game))
}

// ── [1c] B бяга ─────────────────────────────────────────────────────────────
{
  const game = blindBlindLook('[1c] … B „Бягам“ — без доплащане, губи внесеното')
  act(game, 'A', { kind: 'call' })
  const added = act(game, 'B', { kind: 'fold' })
  check('без нови чипове; B губи внесените 20 (остават в банката); край', added === 0 && game.state.voluntary.B === 20 && game.state.folded.includes('B') && game.state.complete)
  const layers = pots(game)
  check('банката 70 е само за A', layers.reduce((sum, l) => sum + l.amount, 0) === 70 && layers.every((l) => l.eligible.join() === 'A'), JSON.stringify(layers))
}

// ── [2] Поглежда и вдига → всички на светло (4 играчи) ──────────────────────
{
  const game = start('[2] 4 играчи: A тъмно 10 → B тъмно 20 → C Виж, „Вдигни“ 50', ['A', 'B', 'C', 'D'])
  act(game, 'A', { kind: 'blind-bet', total: 10 })
  act(game, 'B', { kind: 'blind-bet', total: 20 })
  look(game, 'C')
  act(game, 'C', { kind: 'bet', total: 50 })
  check('C: „Вдигам +10“ (над 40)', announcement(game).speech === 'Вдигам +10', JSON.stringify(announcement(game)))
  check('тъмното приключва; всички неотказали виждат картите си', game.state.blind.status === 'closed' && ['A', 'B', 'D'].every((id) => game.state.looked.includes(id)))
  check('D, A, B: без „Тъмни“', ['D', 'A', 'B'].every((id) => describeSvaraBettingOptions(game.state, id, game.stacks[id]!).blindBet === null))
  act(game, 'D', { kind: 'call' })
  act(game, 'A', { kind: 'call' })
  act(game, 'B', { kind: 'call' })
  check('D 50, A доплаща 40, B доплаща 30; край', game.state.voluntary.D === 50 && game.state.voluntary.A === 50 && game.state.voluntary.B === 50 && game.state.complete)
  check('банка 200 + 20 Вход', pots(game).length === 1 && pots(game)[0]!.amount === 220 && chipsConserved(game))
}

// ── [3] Поглежда и бяга → тъмното продължава ────────────────────────────────
{
  const game = start('[3] 3 играчи: A тъмно 10 → B Виж, „Бягам“ → C още може тъмно', ['A', 'B', 'C'])
  act(game, 'A', { kind: 'blind-bet', total: 10 })
  look(game, 'B')
  act(game, 'B', { kind: 'fold' })
  check('тъмното продължава; никой не е обърнат', game.state.blind.status === 'active' && !game.state.looked.includes('C') && game.state.toAct === 'C')
  const c = buttons(game, 'C')
  check('C: „Тъмни“ от 20 (2 × последния тъмен)', c.options.blindBet?.min === 20 && hasBlindButton(game, 'C'), JSON.stringify(c.options))
  act(game, 'C', { kind: 'blind-bet', total: 20 })
  check('C заложи на тъмно; A решава (тъмни от 40 или Виж)', game.state.toAct === 'A' && buttons(game, 'A').options.blindBet?.min === 40)
}

// ── [4] Само поглежда, без действие ─────────────────────────────────────────
{
  const game = start('[4] 3 играчи: A тъмно 10 → B само поглежда', ['A', 'B', 'C'])
  act(game, 'A', { kind: 'blind-bet', total: 10 })
  look(game, 'B')
  check('тъмното още не приключва; C не е обърнат', game.state.blind.status === 'active' && !game.state.looked.includes('C'))
  check('B (погледнал) не може тъмно, но може да плати/вдигне/бяга', buttons(game, 'B').options.blindBet === null && buttons(game, 'B').options.call === 20)
}

// ── [5] Неуспешен/отхвърлен залог → без промяна ─────────────────────────────
{
  console.log('\n[5] Отхвърлено плащане на погледнал играч → без промяна')
  const stacks = { A: STACK, B: 15 }
  const game: Game = { state: createSvaraBetting({ order: ['A', 'B'], stacks, folded: [], entryChips: ENTRY, allowNoBet: false }), stacks: { ...stacks }, players: ['A', 'B'] }
  act(game, 'A', { kind: 'blind-bet', total: 10 }) // текущ 20
  look(game, 'B')
  const before = JSON.stringify(game.state)
  let code = ''
  try { act(game, 'B', { kind: 'call' }) } catch (error) { code = (error as { code?: string }).code ?? '' }
  check('плащането на 20 с 15 чипа се отказва (insufficient-chips)', code === 'insufficient-chips', code)
  check('състоянието е непроменено; тъмното продължава; A не е обърнат', JSON.stringify(game.state) === before && game.state.blind.status === 'active' && !game.state.looked.includes('A'))
  act(game, 'B', { kind: 'all-in' }) // ол-ин за плащане е успешно плащане
  check('ол-ин за плащане (15) е успешно плащане → тъмното приключва, A е обърнат и избира (без удържане)', game.state.blind.status === 'closed' && game.state.looked.includes('A')
    && game.state.toAct === 'A' && !game.state.complete && game.state.voluntary.A === 10, JSON.stringify({ status: game.state.blind.status, toAct: game.state.toAct, complete: game.state.complete }))
}

// ── [6] 4 играчи, последователни тъмни, после погледнат плаща ───────────────
{
  const game = start('[6] 4 играчи: A тъмно 10 → B тъмно 20 → C тъмно 40 → D Виж, „Плати“ 80', ['A', 'B', 'C', 'D'])
  act(game, 'A', { kind: 'blind-bet', total: 10 })
  act(game, 'B', { kind: 'blind-bet', total: 20 })
  act(game, 'C', { kind: 'blind-bet', total: 40 })
  look(game, 'D')
  act(game, 'D', { kind: 'call' })
  check('D: „Плащам 80“ → тъмното приключва за всички', announcement(game).speech === 'Плащам 80' && game.state.blind.status === 'closed' && ['A', 'B', 'C'].every((id) => game.state.looked.includes(id)))
  check('A, B, C — без автоматично удържане; ред: A', game.state.voluntary.A === 10 && game.state.voluntary.B === 20 && game.state.voluntary.C === 40 && game.state.toAct === 'A')
  check('никой няма „Тъмни“', ['A', 'B', 'C', 'D'].every((id) => describeSvaraBettingOptions(game.state, id, game.stacks[id]!).blindBet === null))
  act(game, 'A', { kind: 'call' })
  act(game, 'B', { kind: 'fold' })
  act(game, 'C', { kind: 'call' })
  check('A доплаща 70, B бяга (губи 20), C доплаща 40 (вече не се брои двойно); край', game.state.voluntary.A === 80 && game.state.folded.includes('B') && game.state.voluntary.C === 80 && game.state.complete)
  check('чиповете са точно внесеното', chipsConserved(game))
}

// ── [7] Без връщане към тъмно в същото раздаване ────────────────────────────
{
  const game = start('[7] 3 играчи: A тъмно 10 → B Виж, „Плати“ → B по-късно бяга', ['A', 'B', 'C'])
  act(game, 'A', { kind: 'blind-bet', total: 10 })
  look(game, 'B')
  act(game, 'B', { kind: 'call' })
  check('тъмното приключи', game.state.blind.status === 'closed')
  act(game, 'C', { kind: 'bet', total: 30 })
  act(game, 'A', { kind: 'call' })
  act(game, 'B', { kind: 'fold' })
  check('след като плащащият бяга — пак светло, без „Тъмни“ за никого', game.state.blind.status === 'closed' && ['A', 'C'].every((id) => describeSvaraBettingOptions(game.state, id, game.stacks[id]!).blindBet === null))
}

// ── [8] Клиент: последното действие преди сравняването ──────────────────────
{
  console.log('\n[8] Клиент: последно „Оставам на тъмно“ не е „Плащам“')
  const round = (blindPlayers: string[]) => ({ kind: 'ordinary', roundId: 'r1', currentBet: 40, blindPlayers, actions: [
    { playerId: 'A', kind: 'blind-bet', total: 10, added: 10, allIn: false, blind: true },
    { playerId: 'B', kind: 'blind-bet', total: 20, added: 20, allIn: false, blind: true },
    { playerId: 'A', kind: 'call', total: 40, added: 30, allIn: false, blind: false },
  ] })
  const next = { matchId: 'm', revision: 2, toActId: null, seats: [], round: { kind: 'showdown-display', displayPhase: 'showdown', comparedPlayers: ['A', 'B'] } }
  const prev = (blindPlayers: string[]) => ({ matchId: 'm', revision: 1, toActId: 'B', seats: [{ playerId: 'B', stack: 980 }], round: round(blindPlayers) })
  check('B на тъмно → „Оставам на тъмно“, без плащане и без чипове', detectSvaraFinalStayBlind(prev(['B']) as never, next as never)?.playerId === 'B' && detectSvaraFinalCall(prev(['B']) as never, next as never) === null)
  check('B погледнал → последното плащане е 20', detectSvaraFinalCall(prev([]) as never, next as never)?.added === 20 && detectSvaraFinalStayBlind(prev([]) as never, next as never) === null)
}

// ── [9]–[11] Истински сървърен път ──────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'svara-blind-'))
const dbPath = join(dir, 'svara.sqlite')
await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
const store = await createSvaraMatchSnapshotStore(dbPath)
try {
  let serial = 0
  const seeded = (seed: number) => { let s = seed >>> 0; return { nextInt: (max: number) => { s = (s * 1664525 + 1013904223) >>> 0; return Math.floor((s / 2 ** 32) * max) } } }
  const runtimeFor = (seed: number) => createSvaraMatchRuntime({ persistence: store, random: seeded(seed) })
  const snap = (rt: SvaraMatchRuntime, id: string, viewer: string) => JSON.parse(serializeSvaraSnapshotForClient(rt.getPlayerSnapshot(id, { playerId: viewer })))
  const state = (rt: SvaraMatchRuntime, id: string) => rt.exportInternalStateForServer(id)
  const round = (rt: SvaraMatchRuntime, id: string) => state(rt, id).round as any
  const sys = (rt: SvaraMatchRuntime, id: string, command: any) => rt.executeSystemCommand(id, `sys-${++serial}`, command)
  const cmd = (rt: SvaraMatchRuntime, id: string, player: string, command: unknown) => rt.executeParticipantCommand(id, { playerId: player }, `c-${++serial}`, command)
  const settle = (rt: SvaraMatchRuntime, id: string) => {
    for (let i = 0; i < 10; i++) {
      const r = round(rt, id)
      if (r === null) sys(rt, id, { type: 'start-next-round' })
      else if (r.dealing) sys(rt, id, { type: 'finish-dealing', roundId: r.roundId })
      else return
    }
  }
  const toAct = (rt: SvaraMatchRuntime, id: string): string => round(rt, id).betting.toAct
  const options = (rt: SvaraMatchRuntime, id: string, viewer: string) => snap(rt, id, viewer).you.betting
  function newMatch(players: string[], seed: number) {
    const rt = runtimeFor(seed)
    const id = `blind-${players.length}-${seed}`
    rt.registerMatch({ matchId: id, creator: { playerId: players[0]! }, capacity: players.length as 2 | 3 | 4, entryFee: 5_000, entryPercent: 1, startMode: 'manual' })
    for (const p of players.slice(1)) cmd(rt, id, p, { type: 'join-seat' })
    cmd(rt, id, players[0]!, { type: 'start-match' })
    settle(rt, id)
    return { rt, id }
  }
  /** Първите n-1 на ход залагат на тъмно (минимума), последният поглежда и прави `final`. */
  function blindsThenLookedAction(rt: SvaraMatchRuntime, id: string, players: string[], final: 'call' | 'raise') {
    const blinders: string[] = []
    for (let i = 0; i < players.length - 1; i++) {
      const p = toAct(rt, id)
      const min = options(rt, id, p).blindBet.min
      cmd(rt, id, p, { type: 'act', action: { kind: 'blind-bet', total: min } })
      blinders.push(p)
    }
    const actor = toAct(rt, id)
    cmd(rt, id, actor, { type: 'look' })
    check(`${players.length} играчи: само поглеждането не прекратява тъмното (сървър)`, round(rt, id).betting.blind.status === 'active'
      && blinders.every((p) => snap(rt, id, p).you.cards === null))
    const opts = options(rt, id, actor)
    cmd(rt, id, actor, { type: 'act', action: final === 'call' ? { kind: 'call' } : { kind: 'bet', total: opts.bet.min } })
    return { blinders, actor }
  }

  console.log('\n[9] Сървърен път: 2, 3 и 4 играчи — плащане/повишаване на погледнал играч')
  for (const [players, final] of [[['a1', 'a2'], 'call'], [['b1', 'b2', 'b3'], 'call'], [['c1', 'c2', 'c3', 'c4'], 'raise']] as const) {
    const { rt, id } = newMatch([...players], 11 + players.length)
    const stacksBefore = Object.fromEntries(players.map((p) => [p, state(rt, id).stacks[p]!]))
    const { blinders, actor } = blindsThenLookedAction(rt, id, [...players], final)
    const label = `${players.length} играчи, ${final === 'call' ? 'плаща' : 'вдига'}`
    check(`${label}: тъмното приключва за цялото раздаване`, round(rt, id).betting.blind.status === 'closed' && snap(rt, id, actor).round.blind.status === 'closed')
    // Всеки вижда само собствените си карти.
    const own = Object.fromEntries(players.map((p) => [p, snap(rt, id, p).you.cards as string[] | null]))
    const privacy = players.every((viewer) => {
      const raw = JSON.stringify(snap(rt, id, viewer))
      return Array.isArray(own[viewer]) && own[viewer]!.length === 3
        && players.filter((p) => p !== viewer).every((p) => (own[p] ?? []).every((card) => own[viewer]!.includes(card) || !raw.includes(`"${card}"`)))
    })
    check(`${label}: картите на всички неотказали са обърнати, всеки вижда само своите`, privacy)
    check(`${label}: никой няма „Тъмни“ (сървърни опции)`, players.every((p) => { const b = snap(rt, id, p).you.betting; return !b || b.blindBet === null }))
    const blindTotal = (p: string) => round(rt, id).betting.log.find((e: any) => e.playerId === p && e.kind === 'blind-bet')?.total
    check(`${label}: бившите играчи на тъмно не са таксувани автоматично`, blinders.every((p) => round(rt, id).betting.voluntary[p] === blindTotal(p)
      && state(rt, id).stacks[p] === stacksBefore[p]! - blindTotal(p)))
    const next = toAct(rt, id)
    check(`${label}: следващият бивш играч на тъмно е на ход с „Плати“/„Вдигни“/„Бягам“`, blinders.includes(next) && options(rt, id, next).call !== null && options(rt, id, next).fold && options(rt, id, next).blindBet === null)
    let code = ''
    try { cmd(rt, id, next, { type: 'act', action: { kind: 'blind-bet', total: 1_000 } }) } catch (error) { code = String((error as { code?: string }).code ?? '') }
    check(`${label}: сървърът отхвърля последващ тъмен залог`, code.includes('blind-not-allowed') || code.includes('below-minimum') || code.includes('insufficient'), code)
  }

  console.log('\n[10] Сървърен път: reconnect/refresh и възстановяване след рестарт; следващо раздаване')
  {
    const players = ['r1', 'r2', 'r3']
    const { rt, id } = newMatch(players, 21)
    blindsThenLookedAction(rt, id, players, 'call')
    const before = Object.fromEntries(players.map((p) => [p, JSON.stringify(snap(rt, id, p))]))
    // Reconnect/refresh: нов snapshot от същото състояние — непроменен.
    check('reconnect/refresh: snapshot-ът е същият (тъмното затворено, същите карти/опции)', players.every((p) => JSON.stringify(snap(rt, id, p)) === before[p]))
    // Рестарт: нов runtime възстановява от SQLite.
    const restored = runtimeFor(99)
    restored.restoreMatchesForServer(store.loadActiveMatches())
    check('рестарт: възстановеното състояние дава същите snapshot-и', players.every((p) => JSON.stringify(snap(restored, id, p)) === before[p]))
    check('рестарт: тъмното остава затворено; без „Тъмни“', round(restored, id).betting.blind.status === 'closed' && players.every((p) => { const b = snap(restored, id, p).you.betting; return !b || b.blindBet === null }))
    // Довършване на раздаването: всички на ход бягат/плащат → следващо раздаване.
    for (let i = 0; i < 10 && round(restored, id)?.betting && !round(restored, id).betting.complete; i++) {
      const p = toAct(restored, id)
      cmd(restored, id, p, { type: 'act', action: { kind: 'fold' } })
    }
    for (let i = 0; i < 20; i++) {
      const r = round(restored, id)
      if (r === null) break
      if (r.kind === 'showdown-display') sys(restored, id, { type: r.phase === 'showdown' ? 'advance-showdown-display' : 'close-payout-display', roundId: r.roundId })
      else if (r.kind === 'payout-display') sys(restored, id, { type: 'close-payout-display', roundId: r.roundId })
      else if (r.kind === 'reveal-choice') sys(restored, id, { type: 'expire-reveal-choice', roundId: r.roundId })
      else if (r.kind === 'reveal-display') sys(restored, id, { type: 'close-reveal-display', roundId: r.roundId })
      else break
    }
    settle(restored, id)
    const r = round(restored, id)
    const first = toAct(restored, id)
    check('следващо раздаване: тъмната игра отново е разрешена', r.betting.blind.status === 'available' && options(restored, id, first).blindBet !== null && players.every((p) => snap(restored, id, p).you.cards === null))
  }

  console.log('\n[11] Сървърен път: поглежда и бяга → тъмното продължава')
  {
    const players = ['f1', 'f2', 'f3']
    const { rt, id } = newMatch(players, 31)
    const first = toAct(rt, id)
    cmd(rt, id, first, { type: 'act', action: { kind: 'blind-bet', total: options(rt, id, first).blindBet.min } })
    const second = toAct(rt, id)
    cmd(rt, id, second, { type: 'look' })
    cmd(rt, id, second, { type: 'act', action: { kind: 'fold' } })
    const third = toAct(rt, id)
    check('тъмното продължава; третият още може „Тъмни“; първият не е обърнат', round(rt, id).betting.blind.status === 'active' && options(rt, id, third).blindBet !== null && snap(rt, id, first).you.cards === null)
  }
} finally {
  store.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
