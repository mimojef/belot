/**
 * checkSvaraLookedPayAfterBlind.ts — правилото от 27.11.2026: тъмният залог се
 * брои двойно; погледнал играч, който изравнява двойния тъмен залог, ПЛАЩА
 * (call), а не повишава. Играчите на тъмно с изравнен залог получават ход за
 * решение: „Оставам на тъмно“, поглеждане и плащане/повишаване, нов тъмен
 * залог или „Бягам“. Минава по реалната верига:
 *   сървърни опции (describeSvaraBettingOptions)
 *   → клиентски бутони (deriveSvaraActionButtons)
 *   → сървърно действие (applySvaraBettingAction)
 *   → клиентска обява (същата логика като flushBetAnimations)
 *   → банка (buildSvaraPotLayers с blindDoubled, както settleOrdinary).
 * Само чиста логика — без база и мрежа.
 *
 * Пускане: npx tsx scripts/checkSvaraLookedPayAfterBlind.ts
 */

import {
  applySvaraBettingAction,
  createSvaraBetting,
  describeSvaraBettingOptions,
  lookAtSvaraCards,
  revealUnlookedHands,
  svaraBlindDoubledContributions,
  svaraBlindPlayers,
  type SvaraBettingAction,
  type SvaraBettingState,
} from '../src/games/svara/engine/svaraBetting.js'
import { buildSvaraPotLayers } from '../src/games/svara/engine/svaraPots.js'
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

/** Действие на сървъра; стекът се намалява точно с върнатото added. */
function act(game: Game, playerId: string, action: SvaraBettingAction): number {
  const result = applySvaraBettingAction(game.state, playerId, action, game.stacks[playerId]!)
  game.stacks[playerId] = game.stacks[playerId]! - result.added
  game.state = result.state
  return result.added
}

/** Както svaraMatch.act: при затваряне на тъмната фаза останалите виждат картите си. */
function actLikeMatch(game: Game, playerId: string, action: SvaraBettingAction): number {
  const wasOpen = game.state.blind.status !== 'closed'
  const added = act(game, playerId, action)
  if (wasOpen && game.state.blind.status === 'closed') game.state = revealUnlookedHands(game.state)
  return added
}

function look(game: Game, playerId: string): void { game.state = lookAtSvaraCards(game.state, playerId) }

function buttons(game: Game, playerId: string) {
  const options = describeSvaraBettingOptions(game.state, playerId, game.stacks[playerId]!)
  return { options, list: deriveSvaraActionButtons(options as never, game.state.looked.includes(playerId), ENTRY) }
}

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

/** Банката както settleOrdinary: Вход + доброволни; тъмните — двойно за правото на банка. */
function pots(game: Game) {
  const contributions = Object.fromEntries(game.players.map((id) => [id, ENTRY + (game.state.voluntary[id] ?? 0)]))
  return buildSvaraPotLayers({ participants: game.players, contributions, folded: game.state.folded, blindDoubled: svaraBlindDoubledContributions(game.state) })
}

function chipsConserved(game: Game): boolean {
  return game.players.every((id) => STACK - game.stacks[id]! === (game.state.voluntary[id] ?? 0))
}

/** Общото начало: A тъмно 10, B тъмно 20, A поглежда и плаща 40. */
function blindBlindLookPay(title: string): Game {
  const game = start(title, ['A', 'B'])
  act(game, 'A', { kind: 'blind-bet', total: 10 })
  act(game, 'B', { kind: 'blind-bet', total: 20 })
  look(game, 'A')
  return game
}

// ── [1] Описаната последователност ──────────────────────────────────────────
{
  const game = blindBlindLookPay('[1] 2 играчи: A тъмно 10 → B тъмно 20 → A Виж → A „Плати“')
  check('текущият залог след двата тъмни е 40 (тъмният се брои двойно)', game.state.currentBet === 40)
  const { options, list } = buttons(game, 'A')
  check('A: сървърът предлага плащане до 40 и повишаване от 45', options.call === 40 && options.bet?.min === 45, JSON.stringify(options))
  const pay = list.find((b) => b.kind === 'pay')
  check('A: бутонът „Плати 40“ изпраща call', pay?.label === 'Плати 40' && JSON.stringify(pay.command) === JSON.stringify({ type: 'act', action: { kind: 'call' } }), JSON.stringify(pay))
  const added = act(game, 'A', { kind: 'call' })
  check('от A се удържат 30 (общо 40)', added === 30 && game.state.voluntary.A === 40)
  check('записано като call; текущият залог остава 40', game.state.log.at(-1)!.kind === 'call' && game.state.currentBet === 40)
  check('обява „Плащам 30“ и „+30“ (действително добавените)', JSON.stringify(announcement(game)) === JSON.stringify({ speech: 'Плащам 30', potFlash: 30 }), JSON.stringify(announcement(game)))
  check('B остава с 20 и не дължи доплащане; тъмната фаза продължава', game.state.voluntary.B === 20 && game.state.blind.status === 'active')
  check('банката е 60 (+ Входове 10)', 40 + 20 === (game.state.voluntary.A! + game.state.voluntary.B!))
  check('B получава ход за решение', game.state.toAct === 'B' && !game.state.complete)
  const b = buttons(game, 'B')
  check('B: „Остани на тъмно“, нов тъмен залог (мин. 40), „Виж“, „Бягам“; без плащане на тъмно', b.options.stayBlind && b.options.blindBet?.min === 40 && b.options.call === null && b.options.fold
    && b.list.some((x) => x.kind === 'stay-blind') && b.list.some((x) => x.kind === 'look') && b.list.find((x) => x.kind === 'pay')?.label === 'Тъмни 40', JSON.stringify(b.options))
  check('чиповете са точно внесеното', chipsConserved(game))
}

// ── [1a] B остава на тъмно ──────────────────────────────────────────────────
{
  const game = blindBlindLookPay('[1a] … B „Остани на тъмно“')
  act(game, 'A', { kind: 'call' })
  const added = act(game, 'B', { kind: 'stay-blind' })
  check('без нови чипове; наддаването приключва (сравняване)', added === 0 && game.state.complete)
  check('обява „Оставам на тъмно“ без „+N“', announcement(game).speech === 'Оставам на тъмно' && announcement(game).potFlash === null)
  check('B е още на тъмно (брои се двойно)', svaraBlindPlayers(game.state).includes('B'))
  const layers = pots(game)
  check('една спорна банка 70 (60 залози + 10 Вход) — без връщане на „непокрити“ 20 на A; правоимащи A и B',
    layers.length === 1 && layers[0]!.kind === 'contested' && layers[0]!.amount === 70 && layers[0]!.eligible.join() === 'A,B', JSON.stringify(layers))
}

// ── [1b] B поглежда и плаща ─────────────────────────────────────────────────
{
  const game = blindBlindLookPay('[1b] … B Виж → B „Плати“')
  act(game, 'A', { kind: 'call' })
  look(game, 'B')
  const { options } = buttons(game, 'B')
  check('B: плащане до 40 (доплаща 20), повишаване от 45', options.call === 40 && options.bet?.min === 45 && !options.stayBlind, JSON.stringify(options))
  const added = act(game, 'B', { kind: 'call' })
  check('B доплаща 20 → общо 40; банката 80; край', added === 20 && game.state.voluntary.B === 40 && game.state.complete)
  check('обява „Плащам 20“', announcement(game).speech === 'Плащам 20')
  const layers = pots(game)
  check('банка 90 (80 + 10 Вход), спорна', layers.length === 1 && layers[0]!.amount === 90)
}

// ── [1c] B поглежда и вдига на светло ───────────────────────────────────────
{
  const game = blindBlindLookPay('[1c] … B Виж → B „Вдигни“ 60')
  act(game, 'A', { kind: 'call' })
  look(game, 'B')
  const added = actLikeMatch(game, 'B', { kind: 'bet', total: 60 })
  check('B внася 40 (до 60); истинско повишаване „Вдигам +20“', added === 40 && announcement(game).speech === 'Вдигам +20', JSON.stringify(announcement(game)))
  check('тъмната фаза приключва; A получава нов ход', game.state.blind.status === 'closed' && game.state.toAct === 'A')
  act(game, 'A', { kind: 'call' })
  check('A доплаща 20 → по 60; край', game.state.voluntary.A === 60 && game.state.complete && chipsConserved(game))
}

// ── [1d] B повишава на тъмно ────────────────────────────────────────────────
{
  const game = blindBlindLookPay('[1d] … B нов тъмен залог 40')
  act(game, 'A', { kind: 'call' })
  const added = act(game, 'B', { kind: 'blind-bet', total: 40 })
  check('B внася още 20 (общо 40 на тъмно = 80 на светло); „Тъмни 20“, „+40“', added === 20 && game.state.currentBet === 80 && JSON.stringify(announcement(game)) === JSON.stringify({ speech: 'Тъмни 20', potFlash: 40 }), JSON.stringify(announcement(game)))
  const { options } = buttons(game, 'A')
  check('A (погледнал) плаща до 80 (още 40) или вдига от 85', options.call === 80 && options.bet?.min === 85)
  act(game, 'A', { kind: 'call' })
  check('A: „Плащам 40“; B отново решава', announcement(game).speech === 'Плащам 40' && game.state.toAct === 'B')
  act(game, 'B', { kind: 'stay-blind' })
  check('край; A 80, B 40 на тъмно; банка 120 (+10)', game.state.complete && pots(game)[0]!.amount === 130 && pots(game).length === 1)
}

// ── [2] Тъмно → светло, един тъмен ──────────────────────────────────────────
{
  const game = start('[2] 2 играчи: A тъмно 10 → B Виж → B „Плати“ → A решава', ['A', 'B'])
  act(game, 'A', { kind: 'blind-bet', total: 10 })
  look(game, 'B')
  const pay = buttons(game, 'B').list.find((b) => b.kind === 'pay')
  check('B: „Плати 20“ → call', pay?.label === 'Плати 20' && (pay.command as { action: { kind: string } }).action.kind === 'call')
  act(game, 'B', { kind: 'call' })
  check('„Плащам 20“; A решава', announcement(game).speech === 'Плащам 20' && game.state.toAct === 'A')
  look(game, 'A')
  check('A погледна: дължи 10 до 20', buttons(game, 'A').options.call === 20)
  act(game, 'A', { kind: 'call' })
  check('A: „Плащам 10“; край; по 20', announcement(game).speech === 'Плащам 10' && game.state.complete && game.state.voluntary.A === 20)
}

// ── [3] 3 играчи ────────────────────────────────────────────────────────────
{
  const game = start('[3] 3 играчи: A тъмно 10 → B тъмно 20 → C Виж, „Плати“ → A Виж, „Плати“ → B остава', ['A', 'B', 'C'])
  act(game, 'A', { kind: 'blind-bet', total: 10 })
  act(game, 'B', { kind: 'blind-bet', total: 20 })
  look(game, 'C')
  act(game, 'C', { kind: 'call' })
  check('C: „Плащам 40“; ред: A', announcement(game).speech === 'Плащам 40' && game.state.toAct === 'A')
  const a = buttons(game, 'A').options
  check('A (тъмно 10 = 20 < 40): без „Остани“; тъмен залог от 40 или Виж', !a.stayBlind && a.blindBet?.min === 40 && a.call === null)
  look(game, 'A')
  act(game, 'A', { kind: 'call' })
  check('A: „Плащам 30“; ред: B (решение)', announcement(game).speech === 'Плащам 30' && game.state.toAct === 'B')
  act(game, 'B', { kind: 'stay-blind' })
  check('край; банка 100 + 15 Вход, една спорна за всички', game.state.complete && pots(game).length === 1 && pots(game)[0]!.amount === 115 && pots(game)[0]!.eligible.join() === 'A,B,C')
  check('чиповете са точно внесеното', chipsConserved(game))
}

// ── [4] 4 играчи, истинско повишаване на светло ─────────────────────────────
{
  const game = start('[4] 4 играчи: A тъмно 10 → B тъмно 20 → C Виж, „Вдигни“ 50', ['A', 'B', 'C', 'D'])
  act(game, 'A', { kind: 'blind-bet', total: 10 })
  act(game, 'B', { kind: 'blind-bet', total: 20 })
  look(game, 'C')
  actLikeMatch(game, 'C', { kind: 'bet', total: 50 })
  check('C: „Вдигам +10“ (над 40)', announcement(game).speech === 'Вдигам +10', JSON.stringify(announcement(game)))
  check('тъмната фаза приключва и всички виждат картите си', game.state.blind.status === 'closed' && svaraBlindPlayers(game.state).length === 0)
  act(game, 'D', { kind: 'call' })
  act(game, 'A', { kind: 'call' })
  act(game, 'B', { kind: 'call' })
  check('D 50, A доплаща 40, B доплаща 30; край', game.state.voluntary.D === 50 && game.state.voluntary.A === 50 && game.state.voluntary.B === 50 && game.state.complete)
  check('банка 200 + 20 Вход', pots(game).length === 1 && pots(game)[0]!.amount === 220 && chipsConserved(game))
}

// ── [5] 4 играчи, последователни тъмни и плащания ──────────────────────────
{
  const game = start('[5] 4 играчи: A тъмно 10 → B тъмно 20 → C тъмно 40 → D Виж, „Плати“ 80', ['A', 'B', 'C', 'D'])
  act(game, 'A', { kind: 'blind-bet', total: 10 })
  act(game, 'B', { kind: 'blind-bet', total: 20 })
  act(game, 'C', { kind: 'blind-bet', total: 40 })
  look(game, 'D')
  act(game, 'D', { kind: 'call' })
  check('D: „Плащам 80“ (80 = двойният тъмен 40)', announcement(game).speech === 'Плащам 80' && game.state.currentBet === 80)
  look(game, 'A'); act(game, 'A', { kind: 'call' })
  look(game, 'B'); act(game, 'B', { kind: 'call' })
  check('A доплаща 70, B 60', game.state.voluntary.A === 80 && game.state.voluntary.B === 80)
  check('C (тъмно 40 = 80) решава', game.state.toAct === 'C' && buttons(game, 'C').options.stayBlind)
  act(game, 'C', { kind: 'stay-blind' })
  check('край; банка 280 + 20, една спорна', game.state.complete && pots(game).length === 1 && pots(game)[0]!.amount === 300)
}

// ── [6] Контрола: без тъмно ─────────────────────────────────────────────────
{
  const game = start('[6] Контрола: A Виж, „Заложи“ 5 → B Виж, „Плати“', ['A', 'B'])
  look(game, 'A'); act(game, 'A', { kind: 'bet', total: ENTRY })
  check('A: „Залагам 5“', announcement(game).speech === 'Залагам 5')
  look(game, 'B'); act(game, 'B', { kind: 'call' })
  check('B: „Плащам 5“; край', announcement(game).speech === 'Плащам 5' && game.state.complete)
}

// ── [7] Клиент: последното действие преди сравняването ──────────────────────
{
  console.log('\n[7] Клиент: последно „Оставам на тъмно“ не е „Плащам“')
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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
