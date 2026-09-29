/**
 * checkPartnerFirstDiscardExclusion.ts
 *
 * Regression: бот чете изчистванията на партньора при „изчистване на боя“.
 * firstDiscardedSuitByPartner (първата изчистена боя — цветен сигнал, не
 * директна J/A заявка) е HARD EXCLUSION до края на раздаването: никоя
 * по-късна сигнална логика не може да я избере като боя за търсене на
 * партньора. По-късните изчиствания само подреждат останалите бои.
 *
 * Преди fix-а се застъпваха:
 *  - partnerSignaledSuit (боя/безкоз): при 2 изчистени бои, ако дедукцията
 *    не даде точно една боя или тя е опасна → resolveColorSignal(ПОСЛЕДНАТА)
 *    → „червена → другата червена“ връща ПЪРВАТА изчистена боя.
 *  - partnerAllTrumpsColorSignaledSuit (всичко коз): гледа само последната
 *    наша взятка → resolveColorSignal(последната) → първата изчистена боя.
 *  - И двата пътя връщаха една боя без fallback.
 *
 * Сценарии (L = дългата боя на бота, F = първа изчистена, P = другата боя
 * от цвета на F, R = другата боя от цвета на L):
 *  [A]  чисти само F                → P, fallback R, никога F
 *  [B]  чисти F, после P            → R, fallback P, никога F
 *  [B*] чисти F, после P, R опасна  → P, никога F (старият код избираше F)
 *  [C]  огледално за всички 8 комбинации (L, F от другия цвят)
 *  [AT] същото при „Всичко коз“ (цветен сигнал от последната наша взятка)
 *  [D]  директна заявка (A при безкоз) първа → не е изключение
 *  [E]  ново раздаване (без completedTricks) → няма изключение
 */

import { pickServerBotPlayCard } from '../src/game/pickServerBotPlayCard.js'
import type {
  ServerAuthoritativeGameState,
  ServerBidEntry,
  ServerCard,
  ServerCompletedTrick,
  ServerPlayerState,
  ServerRank,
  ServerSuit,
} from '../src/game/serverGameTypes.js'
import type { Seat, Team } from '../src/core/serverTypes.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, details = ''): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}${details ? ` — ${details}` : ''}`)
    failed++
  }
}

const BOT: Seat = 'bottom'
const PARTNER: Seat = 'top'
const OPP1: Seat = 'right'
const OPP2: Seat = 'left'

const SUIT_NAME: Record<ServerSuit, string> = { clubs: 'СПАТИЯ', diamonds: 'КАРО', hearts: 'КУПА', spades: 'ПИКА' }
const COLOR_PARTNER: Record<ServerSuit, ServerSuit> = { clubs: 'spades', spades: 'clubs', hearts: 'diamonds', diamonds: 'hearts' }
const RED: ServerSuit[] = ['hearts', 'diamonds']
const BLACK: ServerSuit[] = ['clubs', 'spades']

function card(suit: ServerSuit, rank: ServerRank): ServerCard {
  return { id: `${suit}-${rank}`, suit, rank }
}

function play(seat: Seat, c: ServerCard) {
  return { seat, card: c }
}

function trick(trickIndex: number, leaderSeat: Seat, winnerSeat: Seat, plays: Array<{ seat: Seat; card: ServerCard }>): ServerCompletedTrick {
  return { trickIndex, leaderSeat, winnerSeat, winningTeam: winnerSeat === BOT || winnerSeat === PARTNER ? 'A' : 'B', plays }
}

function makePlayers(): Record<Seat, ServerPlayerState> {
  const seats: Seat[] = ['bottom', 'right', 'top', 'left']
  const teams: Team[] = ['A', 'B', 'A', 'B']
  return Object.fromEntries(
    seats.map((s, i) => [s, { seat: s, team: teams[i]!, mode: 'bot' as const, controlledByBot: true }]),
  ) as Record<Seat, ServerPlayerState>
}

function makeState(options: {
  hand: ServerCard[]
  completedTricks: ServerCompletedTrick[]
  contract: 'no-trumps' | 'all-trumps'
  declarer: Seat
}): ServerAuthoritativeGameState {
  const emptyScore = { teamA: 0, teamB: 0 }
  const bidAction = options.contract === 'no-trumps' ? { type: 'no-trumps' as const } : { type: 'all-trumps' as const }
  const bidEntries: ServerBidEntry[] = [{ seat: options.declarer, action: bidAction }]
  const currentTrick = { leaderSeat: BOT, currentSeat: BOT, plays: [], winnerSeat: null, trickIndex: options.completedTricks.length }

  return {
    phase: 'playing',
    phaseEnteredAt: 0,
    targetScore: 151,
    players: makePlayers(),
    round: { dealerSeat: 'right', cutterSeat: 'bottom', firstBidderSeat: 'left', firstDealSeat: 'left', selectedCutIndex: null },
    deck: [],
    hands: { bottom: options.hand, right: [], top: [], left: [] },
    bidding: {
      entries: bidEntries,
      currentSeat: null,
      winningBid: { seat: options.declarer, contract: options.contract, trumpSuit: null, doubled: false, redoubled: false },
      hasStarted: true,
      hasEnded: true,
      consecutivePasses: 0,
    },
    declarations: [],
    matchDeclarationMissionCounts: {
      announce_tersa: emptyScore, announce_50: emptyScore, announce_100: emptyScore, announce_kare: emptyScore, announce_belot: emptyScore,
    },
    matchDeclarationMissionCountsBySeat: {},
    currentTrick,
    wonTricks: { A: [], B: [] },
    playing: {
      hasStarted: true,
      currentTurnSeat: BOT,
      currentTrick,
      completedTricks: options.completedTricks,
      lastCompletedTrickWinnerSeat: null,
      lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: { bottom: [], right: [], top: [], left: [] },
      wonTricksByTeam: { A: [], B: [] },
    },
    scoring: null,
    matchEnded: null,
    score: {
      round: { tricks: emptyScore, declarations: emptyScore, belote: emptyScore, lastTen: emptyScore, capot: emptyScore, total: emptyScore },
      match: emptyScore,
      carryOver: emptyScore,
    },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  }
}

type Scenario = { L: ServerSuit; F: ServerSuit; P: ServerSuit; R: ServerSuit }

function allScenarios(): Scenario[] {
  const result: Scenario[] = []
  for (const L of [...BLACK, ...RED]) {
    const otherColor = RED.includes(L) ? BLACK : RED
    for (const F of otherColor) {
      result.push({ L, F, P: COLOR_PARTNER[F], R: COLOR_PARTNER[L] })
    }
  }
  return result
}

function label(s: Scenario): string {
  return `L=${SUIT_NAME[s.L]}, F=${SUIT_NAME[s.F]}`
}

// ── Взятки: ботът води дългата боя L и печели; партньорът чисти. ───────────
// Безкоз: A, после 10 (ботът печели и двете).
function noTrumpsTricks(s: Scenario, secondDiscard: boolean, dangerR: boolean): ServerCompletedTrick[] {
  const tricks: ServerCompletedTrick[] = []
  if (dangerR) {
    // Противник е водил R и е взел → R е опасна боя.
    tricks.push(trick(tricks.length, OPP2, OPP2, [play(OPP2, card(s.R, 'A')), play(BOT, card(s.R, '7')), play(OPP1, card(s.R, '8')), play(PARTNER, card(s.R, '9'))]))
  }
  tricks.push(trick(tricks.length, BOT, BOT, [play(BOT, card(s.L, 'A')), play(OPP1, card(s.L, '7')), play(PARTNER, card(s.F, '7')), play(OPP2, card(s.L, '8'))]))
  if (secondDiscard) {
    tricks.push(trick(tricks.length, BOT, BOT, [play(BOT, card(s.L, '10')), play(OPP1, card(s.L, '9')), play(PARTNER, card(s.P, '7')), play(OPP2, card(s.L, 'Q'))]))
  }
  return tricks
}

// Всичко коз: J, после 9.
function allTrumpsTricks(s: Scenario, secondDiscard: boolean): ServerCompletedTrick[] {
  const tricks = [trick(0, BOT, BOT, [play(BOT, card(s.L, 'J')), play(OPP1, card(s.L, '7')), play(PARTNER, card(s.F, '7')), play(OPP2, card(s.L, '8'))])]
  if (secondDiscard) {
    tricks.push(trick(1, BOT, BOT, [play(BOT, card(s.L, '9')), play(OPP1, card(s.L, 'Q')), play(PARTNER, card(s.P, '7')), play(OPP2, card(s.L, 'K'))]))
  }
  return tricks
}

// Ръка: карти в изброените бои (K и Q — без властни, без „опасни 10“).
// Картата от L не бива да е властна (иначе cashable master я играе преди
// сигнала — виж checkBotCashableMasterLead.ts): при безкоз след A и 10 от L
// K би била властна → държим J (K е неизиграна); при всичко коз J е изиграна → K.
function hand(L: ServerSuit, suits: ServerSuit[], lRank: ServerRank = 'K'): ServerCard[] {
  return [card(L, lRank), ...suits.flatMap((suit) => [card(suit, 'K'), card(suit, 'Q')])]
}

function pick(state: ServerAuthoritativeGameState): ServerSuit | null {
  return pickServerBotPlayCard(state, BOT)?.suit ?? null
}

function runContract(contract: 'no-trumps' | 'all-trumps'): void {
  const tag = contract === 'no-trumps' ? 'NT' : 'AT'
  // Безкоз: обявил противник (без NT declarer control); всичко коз: обявил ботът.
  const declarer = contract === 'no-trumps' ? OPP1 : BOT
  const tricksFor = (s: Scenario, second: boolean) =>
    contract === 'no-trumps' ? noTrumpsTricks(s, second, false) : allTrumpsTricks(s, second)

  const results: Record<string, boolean> = { A1: true, A2: true, B1: true, B2: true }
  const failures: string[] = []

  for (const s of allScenarios()) {
    const cases: Array<[string, boolean, ServerSuit[], ServerSuit]> = [
      // [id, втора изчистена, бои в ръката, очаквана боя]
      ['A1', false, [s.P, s.R, s.F], s.P],
      ['A2', false, [s.R, s.F], s.R],
      ['B1', true, [s.R, s.P, s.F], s.R],
      ['B2', true, [s.P, s.F], s.P],
    ]
    for (const [id, second, suits, expected] of cases) {
      const actual = pick(makeState({ hand: hand(s.L, suits, contract === 'no-trumps' ? 'J' : 'K'), completedTricks: tricksFor(s, second), contract, declarer }))
      if (actual !== expected || actual === s.F) {
        results[id] = false
        failures.push(`${id} ${label(s)}: получено ${actual ? SUIT_NAME[actual] : 'null'}, очаквано ${SUIT_NAME[expected]}`)
      }
    }
  }

  check(`[${tag} A/C] само F изчистена → P (8 огледални)`, results.A1!)
  check(`[${tag} A/C] само F изчистена, няма P → fallback R (8 огледални)`, results.A2!)
  check(`[${tag} B/C] F, после P → R (8 огледални), никога F`, results.B1!)
  check(`[${tag} B/C] F, после P, няма R → fallback P (8 огледални), никога F`, results.B2!)
  failures.forEach((failure) => console.error(`        ${failure}`))
}

runContract('no-trumps')
runContract('all-trumps')

// [B*] Безкоз: F, после P, но R е опасна (противник е водил R) → P, никога F.
{
  const failures: string[] = []
  for (const s of allScenarios()) {
    const actual = pick(makeState({ hand: hand(s.L, [s.R, s.P, s.F], 'J'), completedTricks: noTrumpsTricks(s, true, true), contract: 'no-trumps', declarer: OPP1 }))
    if (actual !== s.P) failures.push(`${label(s)}: получено ${actual ? SUIT_NAME[actual] : 'null'}`)
  }
  check('[NT B*] F, после P, R опасна → P, никога F (8 огледални)', failures.length === 0, failures.join('; '))
}

// Точният пример от заявката (безкоз и всичко коз): СПАТИЯ, КУПА, после КАРО.
{
  const s: Scenario = { L: 'clubs', F: 'hearts', P: 'diamonds', R: 'spades' }
  for (const contract of ['no-trumps', 'all-trumps'] as const) {
    const declarer = contract === 'no-trumps' ? OPP1 : BOT
    const tricksFor = (second: boolean) => contract === 'no-trumps' ? noTrumpsTricks(s, second, false) : allTrumpsTricks(s, second)
    const onlyHearts = pick(makeState({ hand: hand(s.L, ['diamonds', 'spades', 'hearts'], contract === 'no-trumps' ? 'J' : 'K'), completedTricks: tricksFor(false), contract, declarer }))
    const onlyHeartsNoDiamonds = pick(makeState({ hand: hand(s.L, ['spades', 'hearts'], contract === 'no-trumps' ? 'J' : 'K'), completedTricks: tricksFor(false), contract, declarer }))
    const heartsThenDiamonds = pick(makeState({ hand: hand(s.L, ['spades', 'diamonds', 'hearts'], contract === 'no-trumps' ? 'J' : 'K'), completedTricks: tricksFor(true), contract, declarer }))
    const heartsThenDiamondsNoSpades = pick(makeState({ hand: hand(s.L, ['diamonds', 'hearts'], contract === 'no-trumps' ? 'J' : 'K'), completedTricks: tricksFor(true), contract, declarer }))
    check(`[${contract}] СПАТИЯ + само КУПА → КАРО`, onlyHearts === 'diamonds', String(onlyHearts))
    check(`[${contract}] СПАТИЯ + само КУПА, няма КАРО → ПИКА`, onlyHeartsNoDiamonds === 'spades', String(onlyHeartsNoDiamonds))
    check(`[${contract}] СПАТИЯ + КУПА, после КАРО → ПИКА`, heartsThenDiamonds === 'spades', String(heartsThenDiamonds))
    check(`[${contract}] СПАТИЯ + КУПА, после КАРО, няма ПИКА → КАРО (никога КУПА)`, heartsThenDiamondsNoSpades === 'diamonds', String(heartsThenDiamondsNoSpades))
  }
}

// [D] Първото изчистване е директна заявка (A при безкоз) → не е изключение.
{
  const tricks = [
    trick(0, BOT, BOT, [play(BOT, card('clubs', 'A')), play(OPP1, card('clubs', '7')), play(PARTNER, card('hearts', 'A')), play(OPP2, card('clubs', '8'))]),
  ]
  const actual = pick(makeState({ hand: hand('clubs', ['hearts', 'diamonds', 'spades']), completedTricks: tricks, contract: 'no-trumps', declarer: OPP1 }))
  check('[D] безкоз: партньорът чисти A♥ (директна заявка) → КУПА, не е изключение', actual === 'hearts', String(actual))
}

// [E] Ново раздаване: completedTricks са празни → няма памет от предишното.
{
  const actual = pick(makeState({ hand: hand('clubs', ['hearts', 'diamonds']), completedTricks: [], contract: 'no-trumps', declarer: OPP1 }))
  check('[E] ново раздаване без взятки → няма сигнал/изключение (ботът не е блокиран за КУПА)', actual !== null)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
