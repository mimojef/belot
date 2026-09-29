/**
 * checkBotCashableMasterLead.ts
 *
 * Regression: бот на ход да води трябва първо да прибере сигурна властна
 * карта от ВЕЧЕ РАЗИГРАВАНА боя (chooseCashableMasterLead → isCardMaster
 * спрямо всички излезли карти), преди да отвори нова боя или да изпълни
 * партньорски сигнал.
 *
 * Преди fix-а (потвърдено) изпреварваха:
 *  (а) Всичко коз, защитник — клонът не търсеше властни карти освен J/9 →
 *      lowestCard отваряше неиграна боя;
 *  (б) Боя, защитник — chooseDefensiveSingletonLead водеше синглетон;
 *  (в) Боя/Без коз — ранният блок с партньорски сигнали беше ПРЕДИ властните
 *      (въпреки коментара „Властни некозови карти — ВИНАГИ с приоритет пред
 *      сигналите“).
 *  (г) Без коз, обявил партньорът — chooseNoTrumpsDeclarerControlLead
 *      (развиване/входове) — умишлено БЕЗ промяна.
 *
 * Сценарии:
 *  [NT1]  Q♣ става властна след A♣ 10♣ K♣ + партньорски сигнал → Q♣ (преди сигнала)
 *  [NT1-] 10♣ неизиграна → Q♣ НЕ е сигурна → сигналът (K♥)
 *  [NT2]  преоценка: след Q♣ противник чисти 10♥ → K♥ става властна → K♥
 *  [NT3]  властно A в НЕразигравана боя не изпреварва сигнала
 *  [NT4]  (г) безкоз, обявил партньорът → развиване на дълга боя (без промяна)
 *  [AT1]  всичко коз защитник: A♣ след J♣ 9♣ → A♣ (не най-малката карта)
 *  [AT1-] 9♣ неизиграна → A♣ НЕ е сигурна → не води A♣
 *  [AT2]  всичко коз защитник: Q♦ след J♦ 9♦ A♦ 10♦ K♦ → Q♦
 *  [S1]   боя защитник: Q♣ властна + синглетон ♥ → Q♣
 *  [S1-]  противник е цакал ♣ (чист + коз) и 10♣ неизиграна → синглетон 8♥
 *  [S2]   боя защитник: преоценка след първата сигурна взятка
 */

import { pickServerBotPlayCard } from '../src/game/pickServerBotPlayCard.js'
import type {
  ServerAuthoritativeGameState,
  ServerCard,
  ServerCompletedTrick,
  ServerPlayerState,
  ServerRank,
  ServerSuit,
} from '../src/game/serverGameTypes.js'
import type { Seat, Team } from '../src/core/serverTypes.js'

let passed = 0
let failed = 0

function check(label: string, actual: ServerCard | null, expectedId: string | null, notId?: string): void {
  const actualId = actual?.id ?? null
  const ok = expectedId !== null ? actualId === expectedId : actualId !== notId
  if (ok) {
    console.log(`  PASS  ${label} → ${actualId}`)
    passed++
  } else {
    console.error(`  FAIL  ${label} → получено ${actualId}, очаквано ${expectedId ?? `не ${notId}`}`)
    failed++
  }
}

const BOT: Seat = 'bottom'
const PARTNER: Seat = 'top'
const OPP1: Seat = 'right'
const OPP2: Seat = 'left'

const c = (suit: ServerSuit, rank: ServerRank): ServerCard => ({ id: `${suit}-${rank}`, suit, rank })

function trick(index: number, winner: Seat, plays: Array<[Seat, ServerCard]>): ServerCompletedTrick {
  return {
    trickIndex: index,
    leaderSeat: plays[0]![0],
    winnerSeat: winner,
    winningTeam: winner === BOT || winner === PARTNER ? 'A' : 'B',
    plays: plays.map(([seat, card]) => ({ seat, card })),
  }
}

function makePlayers(): Record<Seat, ServerPlayerState> {
  const seats: Seat[] = ['bottom', 'right', 'top', 'left']
  const teams: Team[] = ['A', 'B', 'A', 'B']
  return Object.fromEntries(
    seats.map((s, i) => [s, { seat: s, team: teams[i]!, mode: 'bot' as const, controlledByBot: true }]),
  ) as Record<Seat, ServerPlayerState>
}

function makeState(o: {
  hand: ServerCard[]
  tricks: ServerCompletedTrick[]
  contract: 'suit' | 'no-trumps' | 'all-trumps'
  trumpSuit?: ServerSuit
  declarer: Seat
}): ServerAuthoritativeGameState {
  const z = { teamA: 0, teamB: 0 }
  const action =
    o.contract === 'suit' ? { type: 'suit' as const, suit: o.trumpSuit! }
      : o.contract === 'no-trumps' ? { type: 'no-trumps' as const }
        : { type: 'all-trumps' as const }
  const currentTrick = { leaderSeat: BOT, currentSeat: BOT, plays: [], winnerSeat: null, trickIndex: o.tricks.length }

  return {
    phase: 'playing',
    phaseEnteredAt: 0,
    targetScore: 151,
    players: makePlayers(),
    round: { dealerSeat: 'right', cutterSeat: 'bottom', firstBidderSeat: 'left', firstDealSeat: 'left', selectedCutIndex: null },
    deck: [],
    hands: { bottom: o.hand, right: [], top: [], left: [] },
    bidding: {
      entries: [{ seat: o.declarer, action }],
      currentSeat: null,
      winningBid: { seat: o.declarer, contract: o.contract, trumpSuit: o.contract === 'suit' ? o.trumpSuit! : null, doubled: false, redoubled: false },
      hasStarted: true,
      hasEnded: true,
      consecutivePasses: 0,
    },
    declarations: [],
    matchDeclarationMissionCounts: { announce_tersa: z, announce_50: z, announce_100: z, announce_kare: z, announce_belot: z },
    matchDeclarationMissionCountsBySeat: {},
    currentTrick,
    wonTricks: { A: [], B: [] },
    playing: {
      hasStarted: true,
      currentTurnSeat: BOT,
      currentTrick,
      completedTricks: o.tricks,
      lastCompletedTrickWinnerSeat: null,
      lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: { bottom: [], right: [], top: [], left: [] },
      wonTricksByTeam: { A: [], B: [] },
    },
    scoring: null,
    matchEnded: null,
    score: {
      round: { tricks: z, declarations: z, belote: z, lastTen: z, capot: z, total: z },
      match: z,
      carryOver: z,
    },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  }
}

const lead = (o: Parameters<typeof makeState>[0]) => pickServerBotPlayCard(makeState(o), BOT)

// ─── Без коз (защитник; обявил OPP1) ──────────────────────────────────────────
// Спатия: A♣ (t0), K♣ + 10♣ (t1) излизат → Q♣ на бота става властна (A-10-K-Q).
function ntClubTricks(tenPlayed: boolean): ServerCompletedTrick[] {
  return [
    trick(0, OPP1, [[OPP1, c('clubs', 'A')], [BOT, c('clubs', '7')], [OPP2, c('clubs', '8')], [PARTNER, c('clubs', 'J')]]),
    tenPlayed
      ? trick(1, OPP2, [[OPP1, c('clubs', 'K')], [BOT, c('clubs', '9')], [OPP2, c('clubs', '10')], [PARTNER, c('hearts', '7')]])
      : trick(1, OPP1, [[OPP1, c('clubs', 'K')], [BOT, c('clubs', '9')], [OPP2, c('hearts', '9')], [PARTNER, c('hearts', '7')]]),
  ]
}

// + ботът взима ♦ и партньорът чисти 7♠ на наша взятка → сигнал към ♥
// (♠ → ♣ по цвят, но ♣ е водена от противника → опасна → ♥).
function ntSignalTricks(tenPlayed: boolean): ServerCompletedTrick[] {
  const base = ntClubTricks(tenPlayed)
  const opp = base[1]!.winnerSeat
  return [
    ...base,
    trick(2, BOT, [[opp, c('diamonds', '7')], [BOT, c('diamonds', 'A')], [opp === OPP1 ? OPP2 : OPP1, c('diamonds', '8')], [PARTNER, c('diamonds', '9')]]),
    trick(3, BOT, [[BOT, c('diamonds', 'K')], [OPP1, c('diamonds', 'Q')], [PARTNER, c('spades', '7')], [OPP2, c('diamonds', 'J')]]),
  ]
}

const ntSignalHand = [c('clubs', 'Q'), c('hearts', 'K'), c('hearts', '8'), c('spades', '8')]
check('[NT1] Q♣ стана властна (A,10,K излезли) + партньорски сигнал → първо Q♣',
  lead({ hand: ntSignalHand, tricks: ntSignalTricks(true), contract: 'no-trumps', declarer: OPP1 }), 'clubs-Q')
check('[NT1-] 10♣ още е в игра → Q♣ не е сигурна → сигналът (K♥)',
  lead({ hand: ntSignalHand, tricks: ntSignalTricks(false), contract: 'no-trumps', declarer: OPP1 }), 'hearts-K')

// Преоценка: ♥ е водена (A♥ излязла), 10♥ неизиграна → K♥ още не е властна.
const ntReevalTricks = [
  ...ntClubTricks(true),
  trick(2, BOT, [[OPP2, c('hearts', '9')], [BOT, c('hearts', 'A')], [OPP1, c('hearts', '8')], [PARTNER, c('hearts', 'J')]]),
]
check('[NT2a] преоценка, стъпка 1: Q♣ властна, K♥ не е (10♥ в игра) → Q♣',
  lead({ hand: [c('clubs', 'Q'), c('hearts', 'K'), c('spades', '7'), c('spades', '8')], tricks: ntReevalTricks, contract: 'no-trumps', declarer: OPP1 }), 'clubs-Q')
// Партньорът чисти Q♥ (първо изчистване на наша взятка) → ♥ е изключена като
// сигнална цел, т.е. K♥ може да дойде САМО от cashable master правилото.
const afterCash = [
  ...ntReevalTricks,
  trick(3, BOT, [[BOT, c('clubs', 'Q')], [OPP1, c('hearts', '10')], [PARTNER, c('hearts', 'Q')], [OPP2, c('diamonds', '9')]]),
]
check('[NT2b] преоценка, стъпка 2: 10♥ излезе при Q♣ → K♥ стана властна → K♥ (не нова боя ♠)',
  lead({ hand: [c('hearts', 'K'), c('spades', '7'), c('spades', '8')], tricks: afterCash, contract: 'no-trumps', declarer: OPP1 }), 'hearts-K')

check('[NT3] властно A♠ в НЕразигравана боя не изпреварва сигнала → K♥',
  lead({ hand: [c('spades', 'A'), c('hearts', 'K'), c('hearts', '8'), c('spades', '8')], tricks: ntSignalTricks(false), contract: 'no-trumps', declarer: OPP1 }), 'hearts-K')

check('[NT4] (г) безкоз, обявил партньорът: развиване на дълга ♠ преди властната Q♣ (без промяна)',
  lead({ hand: [c('clubs', 'Q'), c('spades', '8'), c('spades', '9'), c('spades', 'K'), c('diamonds', '7')], tricks: ntReevalTricks, contract: 'no-trumps', declarer: PARTNER }), 'spades-8')

// ─── Всичко коз (защитник; обявил OPP1) ───────────────────────────────────────
// Спатия: J♣ (t0) и 9♣ (t1) излизат → A♣ на бота става властна (J-9-A-10-K-Q-8-7).
function atTricks(ninePlayed: boolean): ServerCompletedTrick[] {
  return [
    trick(0, OPP1, [[OPP1, c('clubs', 'J')], [BOT, c('clubs', '7')], [OPP2, c('clubs', '8')], [PARTNER, c('clubs', 'Q')]]),
    ninePlayed
      ? trick(1, OPP1, [[OPP1, c('clubs', '9')], [BOT, c('clubs', 'K')], [OPP2, c('clubs', '10')], [PARTNER, c('diamonds', '7')]])
      : trick(1, OPP1, [[OPP1, c('clubs', '10')], [BOT, c('clubs', 'K')], [OPP2, c('hearts', '7')], [PARTNER, c('diamonds', '7')]]),
    trick(2, BOT, [[OPP1, c('diamonds', '9')], [BOT, c('diamonds', 'J')], [OPP2, c('diamonds', '8')], [PARTNER, c('diamonds', 'K')]]),
  ]
}
const atHand = [c('clubs', 'A'), c('hearts', '8'), c('hearts', 'Q'), c('spades', '7'), c('spades', '8')]
check('[AT1] всичко коз защитник: A♣ стана властна (J,9 излезли) → A♣, не отваря ♥/♠',
  lead({ hand: atHand, tricks: atTricks(true), contract: 'all-trumps', declarer: OPP1 }), 'clubs-A')
check('[AT1-] 9♣ още е в игра → A♣ не е сигурна → не води A♣',
  lead({ hand: atHand, tricks: atTricks(false), contract: 'all-trumps', declarer: OPP1 }), null, 'clubs-A')

const atDiamondTricks = [
  trick(0, PARTNER, [[OPP1, c('diamonds', 'J')], [BOT, c('diamonds', '7')], [OPP2, c('diamonds', '9')], [PARTNER, c('diamonds', 'A')]]),
  trick(1, OPP1, [[OPP1, c('diamonds', '10')], [BOT, c('diamonds', '8')], [OPP2, c('diamonds', 'K')], [PARTNER, c('clubs', '7')]]),
  trick(2, BOT, [[OPP1, c('spades', '7')], [BOT, c('spades', 'J')], [OPP2, c('spades', '8')], [PARTNER, c('spades', '9')]]),
]
check('[AT2] всичко коз защитник: Q♦ стана властна (J,9,A,10,K излезли) → Q♦',
  lead({ hand: [c('diamonds', 'Q'), c('hearts', '7'), c('hearts', '8'), c('clubs', '8'), c('clubs', 'Q')], tricks: atDiamondTricks, contract: 'all-trumps', declarer: OPP1 }), 'diamonds-Q')

// ─── Боя, коз ♠ (защитник; обявил OPP1) ───────────────────────────────────────
function suitTricks(safe: boolean): ServerCompletedTrick[] {
  return [
    trick(0, OPP1, [[OPP1, c('clubs', 'A')], [BOT, c('clubs', '7')], [OPP2, c('clubs', '8')], [PARTNER, c('clubs', 'J')]]),
    safe
      ? trick(1, OPP2, [[OPP1, c('clubs', 'K')], [BOT, c('clubs', '9')], [OPP2, c('clubs', '10')], [PARTNER, c('diamonds', '7')]])
      // OPP2 цака ♣ → чист на ♣ с коз; 10♣ неизиграна.
      : trick(1, OPP2, [[OPP1, c('clubs', 'K')], [BOT, c('clubs', '9')], [OPP2, c('spades', '8')], [PARTNER, c('diamonds', '7')]]),
    trick(2, BOT, [[OPP2, c('diamonds', '8')], [BOT, c('diamonds', 'A')], [OPP1, c('diamonds', '9')], [PARTNER, c('diamonds', 'J')]]),
  ]
}
const suitHand = [c('clubs', 'Q'), c('hearts', '8'), c('diamonds', 'K'), c('diamonds', 'Q'), c('spades', '7')]
check('[S1] боя защитник: Q♣ властна + синглетон 8♥ + коз → първо Q♣',
  lead({ hand: suitHand, tricks: suitTricks(true), contract: 'suit', trumpSuit: 'spades', declarer: OPP1 }), 'clubs-Q')
check('[S1-] противник може да цака ♣ (+10♣ в игра) → Q♣ не е сигурна → синглетон 8♥',
  lead({ hand: suitHand, tricks: suitTricks(false), contract: 'suit', trumpSuit: 'spades', declarer: OPP1 }), 'hearts-8')

// Преоценка при боя: ♥ водена (A♥ излязла), 10♥ в игра → K♥ още не е властна.
const suitReevalTricks = [
  trick(0, OPP1, [[OPP1, c('clubs', 'A')], [BOT, c('clubs', '7')], [OPP2, c('clubs', '8')], [PARTNER, c('clubs', 'J')]]),
  trick(1, OPP2, [[OPP1, c('clubs', 'K')], [BOT, c('clubs', '9')], [OPP2, c('clubs', '10')], [PARTNER, c('diamonds', '7')]]),
  trick(2, OPP2, [[OPP2, c('hearts', 'A')], [BOT, c('hearts', '7')], [OPP1, c('hearts', '8')], [PARTNER, c('hearts', '9')]]),
  trick(3, BOT, [[OPP2, c('diamonds', '8')], [BOT, c('diamonds', 'A')], [OPP1, c('diamonds', '9')], [PARTNER, c('diamonds', 'J')]]),
]
check('[S2a] боя защитник, преоценка, стъпка 1: Q♣ властна, K♥ не е (10♥ в игра) → Q♣',
  lead({ hand: [c('clubs', 'Q'), c('hearts', 'K'), c('diamonds', '8'), c('spades', '7')], tricks: suitReevalTricks, contract: 'suit', trumpSuit: 'spades', declarer: OPP1 }), 'clubs-Q')
// При Q♣ излиза 10♥; партньорът чисти Q♥ (♥ изключена като сигнална цел).
const suitAfterCash = [
  ...suitReevalTricks,
  trick(4, BOT, [[BOT, c('clubs', 'Q')], [OPP1, c('hearts', '10')], [PARTNER, c('hearts', 'Q')], [OPP2, c('diamonds', '10')]]),
]
check('[S2b] боя защитник, преоценка, стъпка 2: K♥ стана властна → K♥ (не синглетон 8♦)',
  lead({ hand: [c('hearts', 'K'), c('diamonds', '8'), c('spades', '7')], tricks: suitAfterCash, contract: 'suit', trumpSuit: 'spades', declarer: OPP1 }), 'hearts-K')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
