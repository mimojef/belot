/**
 * checkPartnerRaiseAllTrumpsBid.ts
 *
 * Regression проверки за новото конвенционално bidding правило:
 *   Ботът обявява собствена боя X → партньорът вдига с по-висока боя Y →
 *   при следващия ред на бота, ако Y все още е водещата обява, отборът на
 *   бота ще води първи в разиграването, и ботът има Вале в X →
 *   ботът обявява „Всичко коз“.
 *
 * [1]  J+9 в X, наш отбор води първи               → all-trumps
 * [2]  J+A+Q+7 в X (без 9), наш отбор води първи    → all-trumps
 * [3]  Без Вале в X, има 9                          → pass
 * [4]  Противниковият отбор води първи              → правилото не се активира
 * [5]  Партньорът НЕ е вдигнал по-висока боя         → правилото не се активира
 * [6]  По-високата боя е обявена от противник        → правилото не се активира
 * [7]  След партньора противник е взел водещата обява → правилото не се активира
 * [8]  Strict mode активен (opponent deals), точната комбинация е изпълнена,
 *      ръката няма 4 strict secure tricks  → all-trumps (заобикаля filtering)
 * [9]  Strict mode активен, партньорската комбинация НЕ е изпълнена  → старото strict поведение (pass)
 * [10] Invariant: firstDealSeat === getSeatAfterDealer(dealerSeat) и техните
 *      отбори са винаги противоположни, за четирите dealer позиции
 */

import { pickServerBotBidAction } from '../src/game/pickServerBotBidAction.js'
import { getSeatAfterDealer } from '../src/game/serverPhaseHelpers.js'
import type {
  ServerAuthoritativeGameState,
  ServerBidEntry,
  ServerCard,
  ServerPlayerState,
  ServerSuit,
} from '../src/game/serverGameTypes.js'
import type { Seat, Team } from '../src/core/serverTypes.js'

// ─── Брояч ──────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: получено "${String(actual)}", очаквано "${String(expected)}"`)
  }
}

// ─── State builders ──────────────────────────────────────────────────────────

function makeCard(suit: ServerSuit, rank: ServerCard['rank'], id?: string): ServerCard {
  return { id: id ?? `${suit}-${rank}`, suit, rank }
}

function makePlayers(): Record<Seat, ServerPlayerState> {
  const seats: Seat[] = ['bottom', 'right', 'top', 'left']
  const teams: Team[] = ['A', 'B', 'A', 'B']
  return Object.fromEntries(
    seats.map((s, i) => [s, { seat: s, team: teams[i]!, mode: 'bot' as const, controlledByBot: true }]),
  ) as Record<Seat, ServerPlayerState>
}

type MakeStateOpts = {
  botSeat: Seat
  hand: ServerCard[]
  bidEntries: ServerBidEntry[]
  winningBid: ServerAuthoritativeGameState['bidding']['winningBid']
  firstDealSeat: Seat
  dealerSeat?: Seat
  matchScore?: { teamA: number; teamB: number }
}

function makeState(opts: MakeStateOpts): ServerAuthoritativeGameState {
  const {
    botSeat, hand, bidEntries, winningBid, firstDealSeat,
    dealerSeat = 'left',
    matchScore = { teamA: 0, teamB: 0 },
  } = opts
  const emptyScore = { teamA: 0, teamB: 0 }
  const hands: Record<Seat, ServerCard[]> = {
    bottom: [],
    right: [],
    top: [],
    left: [],
    [botSeat]: hand,
  }

  return {
    phase: 'bidding',
    phaseEnteredAt: 0,
    targetScore: 151,
    players: makePlayers(),
    round: {
      dealerSeat,
      cutterSeat: 'top',
      firstBidderSeat: firstDealSeat,
      firstDealSeat,
      selectedCutIndex: null,
    },
    deck: [],
    hands,
    bidding: {
      entries: bidEntries,
      currentSeat: botSeat,
      winningBid,
      hasStarted: true,
      hasEnded: false,
      consecutivePasses: 0,
    },
    declarations: [],
    matchDeclarationMissionCounts: {
      announce_tersa: emptyScore,
      announce_50: emptyScore,
      announce_100: emptyScore,
      announce_kare: emptyScore,
      announce_belot: emptyScore,
    },
    currentTrick: { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 0 },
    wonTricks: { A: [], B: [] },
    playing: null,
    scoring: null,
    matchEnded: null,
    score: {
      round: {
        tricks: emptyScore,
        declarations: emptyScore,
        belote: emptyScore,
        lastTen: emptyScore,
        capot: emptyScore,
        total: emptyScore,
      },
      match: matchScore,
      carryOver: emptyScore,
    },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  }
}

// bottom = team A (бот), top = партньор (team A), right/left = team B
const BOT: Seat = 'bottom'
const PARTNER: Seat = 'top'
const OPP1: Seat = 'right'
const OPP2: Seat = 'left'

function partnerRaiseWinningBid(suit: ServerSuit): ServerAuthoritativeGameState['bidding']['winningBid'] {
  return { seat: PARTNER, contract: 'suit', trumpSuit: suit, doubled: false, redoubled: false }
}

// ─── Проверки ────────────────────────────────────────────────────────────────

console.log('\ncheckPartnerRaiseAllTrumpsBid\n')

// [1] Ботът обявява clubs, партньорът вдига с hearts, ботът има J+9 в clubs,
//     наш отбор (bottom/top) води първи → all-trumps
check('[1] J+9 в собствена боя, наш отбор води първи → all-trumps', () => {
  const entries: ServerBidEntry[] = [
    { seat: BOT, action: { type: 'suit', suit: 'clubs' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'suit', suit: 'hearts' } },
    { seat: OPP2, action: { type: 'pass' } },
  ]
  const hand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', '9'),
    makeCard('clubs', '7'),
    makeCard('spades', 'Q'),
  ]
  const state = makeState({
    botSeat: BOT,
    hand,
    bidEntries: entries,
    winningBid: partnerRaiseWinningBid('hearts'),
    firstDealSeat: PARTNER, // team A first lead
  })

  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'all-trumps', 'action type')
})

// [2] Ботът има J+A+Q+7 (без 9) в собствената боя, наш отбор води първи → all-trumps
check('[2] J без 9 (J+A+Q+7) в собствена боя → all-trumps', () => {
  const entries: ServerBidEntry[] = [
    { seat: BOT, action: { type: 'suit', suit: 'clubs' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'suit', suit: 'hearts' } },
    { seat: OPP2, action: { type: 'pass' } },
  ]
  const hand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', 'A'),
    makeCard('clubs', 'Q'),
    makeCard('clubs', '7'),
  ]
  const state = makeState({
    botSeat: BOT,
    hand,
    bidEntries: entries,
    winningBid: partnerRaiseWinningBid('hearts'),
    firstDealSeat: BOT,
  })

  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'all-trumps', 'action type')
})

// [3] Без Вале в собствената боя, но има 9 → pass (не се активира новото правило)
check('[3] Без Вале, само 9 в собствена боя → pass', () => {
  const entries: ServerBidEntry[] = [
    { seat: BOT, action: { type: 'suit', suit: 'clubs' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'suit', suit: 'hearts' } },
    { seat: OPP2, action: { type: 'pass' } },
  ]
  // Слаба ръка навсякъде — само 9 в clubs, нищо друго достойно за обявяване.
  const hand: ServerCard[] = [
    makeCard('clubs', '9'),
    makeCard('clubs', '7'),
    makeCard('spades', '8'),
    makeCard('diamonds', '7'),
  ]
  const state = makeState({
    botSeat: BOT,
    hand,
    bidEntries: entries,
    winningBid: partnerRaiseWinningBid('hearts'),
    firstDealSeat: BOT,
  })

  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'pass', 'action type (ново правило не се активира без J)')
})

// [4] Противниковият отбор (right/left) ще води първи → правилото не се активира
check('[4] Противниковият отбор води първи → all-trumps не се обявява по новото правило', () => {
  const entries: ServerBidEntry[] = [
    { seat: BOT, action: { type: 'suit', suit: 'clubs' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'suit', suit: 'hearts' } },
    { seat: OPP2, action: { type: 'pass' } },
  ]
  const hand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', '9'),
    makeCard('clubs', '7'),
    makeCard('spades', '8'),
  ]
  const state = makeState({
    botSeat: BOT,
    hand,
    bidEntries: entries,
    winningBid: partnerRaiseWinningBid('hearts'),
    firstDealSeat: OPP1, // team B first lead
  })

  const action = pickServerBotBidAction(state, BOT)
  // Не проверяваме конкретното действие (може да pass или друг contract от
  // нормалната логика) — само че НЕ е all-trumps по новото правило.
  // За чиста слаба ръка извън clubs очакваме pass.
  assertEqual(action.type, 'pass', 'action type (opponent team first lead → не all-trumps)')
})

// [5] Партньорът не е вдигнал по-висока боя (само pass-нал) → правилото не се активира
check('[5] Партньорът не е вдигнал → правилото не се активира', () => {
  const entries: ServerBidEntry[] = [
    { seat: BOT, action: { type: 'suit', suit: 'clubs' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'pass' } },
    { seat: OPP2, action: { type: 'pass' } },
  ]
  const hand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', '9'),
    makeCard('clubs', '7'),
    makeCard('spades', '8'),
  ]
  const state = makeState({
    botSeat: BOT,
    hand,
    bidEntries: entries,
    winningBid: { seat: BOT, contract: 'suit', trumpSuit: 'clubs', doubled: false, redoubled: false },
    firstDealSeat: BOT,
  })

  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'pass', 'action type (без партньорско вдигане)')
})

// [6] По-високата боя е обявена от противник, не от партньора → не се активира
check('[6] По-високата боя е от противник → правилото не се активира', () => {
  const entries: ServerBidEntry[] = [
    { seat: BOT, action: { type: 'suit', suit: 'clubs' } },
    { seat: OPP1, action: { type: 'suit', suit: 'hearts' } },
    { seat: PARTNER, action: { type: 'pass' } },
    { seat: OPP2, action: { type: 'pass' } },
  ]
  const hand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', '9'),
    makeCard('clubs', '7'),
    makeCard('spades', '8'),
  ]
  const state = makeState({
    botSeat: BOT,
    hand,
    bidEntries: entries,
    winningBid: { seat: OPP1, contract: 'suit', trumpSuit: 'hearts', doubled: false, redoubled: false },
    firstDealSeat: BOT,
  })

  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'pass', 'action type (opponent suit, не partner)')
})

// [7] След партньорската обява противник е взел водещата обява → не се активира
check('[7] Противник е вдигнал над партньора → правилото не се активира', () => {
  const entries: ServerBidEntry[] = [
    { seat: BOT, action: { type: 'suit', suit: 'clubs' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'suit', suit: 'hearts' } },
    { seat: OPP2, action: { type: 'suit', suit: 'spades' } }, // spades > hearts
  ]
  const hand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', '9'),
    makeCard('clubs', '7'),
    makeCard('diamonds', '8'),
  ]
  const state = makeState({
    botSeat: BOT,
    hand,
    bidEntries: entries,
    winningBid: { seat: OPP2, contract: 'suit', trumpSuit: 'spades', doubled: false, redoubled: false },
    firstDealSeat: BOT,
  })

  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'pass', 'action type (spades от противник е водеща, не hearts)')
})

// [8] Strict mode активен (opp=141, gap=13), точната комбинация е изпълнена,
//     И реалистичен game state: dealerSeat=OPP1 (team B) → противниковият
//     отбор раздава → getSeatAfterDealer(OPP1='right') = 'top' = PARTNER
//     (team A) → firstDealSeat е от нашия отбор. Това е единствената валидна
//     комбинация "нашият отбор има first lead" — тя автоматично означава
//     противниковият отбор раздава (съседни seats са от противоположни
//     отбори), значи старият strict-mode "opponentTeamDeals" guard тук би
//     пропуснал (opponentTeamDeals=true) и позволил нормалния strict flow.
//     Ръката НЯМА 4-те strict secure tricks (само 3 в clubs: J+9+7, липсва A)
//     → getBestBotContractCandidate под strict filtering би отхвърлил
//     candidate-а и върнал pass. Точното правило трябва да заобиколи това,
//     връщайки all-trumps директно, ПРЕДИ minimumSecureTricks filtering-а.
check('[8] Strict mode активен (opponent deals) + точна комбинация → all-trumps, заобикаля secure-tricks filtering', () => {
  const entries: ServerBidEntry[] = [
    { seat: BOT, action: { type: 'suit', suit: 'clubs' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'suit', suit: 'hearts' } },
    { seat: OPP2, action: { type: 'pass' } },
  ]
  // Само 3 secure tricks в clubs (J+9+7 — липсва A след 9 в top-chain реда
  // ALL_TRUMPS_TOP_CHAIN_ORDER = [J,9,A,10,K,Q,8,7], значи J+9 после 7 чупи
  // веригата преди A) → под strict-mode праг от 4, старият filtering би pass-нал.
  const hand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', '9'),
    makeCard('clubs', '7'),
    makeCard('spades', 'Q'),
  ]
  const state = makeState({
    botSeat: BOT,
    hand,
    bidEntries: entries,
    winningBid: partnerRaiseWinningBid('hearts'),
    firstDealSeat: PARTNER, // team A first lead (валидно: getSeatAfterDealer('right')==='top')
    dealerSeat: OPP1,       // 'right' — противниковият отбор раздава (реалистично)
    matchScore: { teamA: 128, teamB: 141 }, // opp=141, gap=13 → strict active
  })

  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'all-trumps', 'action type (комбинацията заобикаля secure-tricks filtering)')
})

// [9] Strict mode активен, но партньорската комбинация НЕ е изпълнена
//     (партньорът не е вдигнал) → старото strict-mode поведение остава
//     непроменено. Тук нашият отбор (team A) раздава: dealerSeat=BOT
//     ('bottom') → getSeatAfterDealer('bottom')==='right' (team B получава
//     first lead — реалистично, не се твърди, че нашият отбор има first lead).
check('[9] Strict mode активен, без точна комбинация → старото strict поведение (pass)', () => {
  const entries: ServerBidEntry[] = [
    { seat: BOT, action: { type: 'suit', suit: 'clubs' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'pass' } },
    { seat: OPP2, action: { type: 'pass' } },
  ]
  const hand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', '9'),
    makeCard('clubs', '7'),
    makeCard('spades', 'Q'),
  ]
  const state = makeState({
    botSeat: BOT,
    hand,
    bidEntries: entries,
    winningBid: { seat: BOT, contract: 'suit', trumpSuit: 'clubs', doubled: false, redoubled: false },
    firstDealSeat: OPP1,  // 'right' = getSeatAfterDealer('bottom') — реалистично
    dealerSeat: BOT,      // 'bottom' — нашият отбор раздава → strict-mode форсира pass
    matchScore: { teamA: 128, teamB: 141 },
  })

  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'pass', 'action type (без комбинация → старото strict поведение)')
})

// [10] Invariant: firstDealSeat === getSeatAfterDealer(dealerSeat), и техните
//      отбори са ВИНАГИ противоположни — за всичките четири dealer позиции.
//      Това е причината старият strict-mode "нашият отбор раздава" pass
//      никога реално не може да съвпадне с "нашият отбор има first lead"
//      (условие 5 на новата конвенция) — двете са взаимно изключващи се по
//      конструкция на реалния game lifecycle (createServerRoundStartState.ts).
function teamOfSeat(seat: Seat): Team {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

check('[10] Invariant: firstDealSeat екип е винаги противоположен на dealer екип (4 позиции)', () => {
  const allSeats: Seat[] = ['bottom', 'right', 'top', 'left']

  for (const dealerSeat of allSeats) {
    const firstDealSeat = getSeatAfterDealer(dealerSeat)
    const dealerTeam = teamOfSeat(dealerSeat)
    const firstDealTeam = teamOfSeat(firstDealSeat)

    assert(
      firstDealTeam !== dealerTeam,
      `dealerSeat=${dealerSeat} (team ${dealerTeam}) → firstDealSeat=${firstDealSeat} трябва да е противоположен отбор, получено team ${firstDealTeam}`,
    )
  }
})

// ─── Резултат ────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
