/**
 * checkStrictModeBidding.ts
 *
 * Regression проверки за strict mode при bot bidding.
 * Strict mode: opponentScore > 140 && opponentScore - botTeamScore > 12
 * При активен strict mode:
 *   - ако нашият отбор раздава → pass (без изключения)
 *   - ако противникът раздава → suit/no-trumps/all-trumps само с >= 4 secure tricks
 *
 * [A]  opp=141, gap=13, opp deals, suit J+9+A+10 (4 card) → suit bid
 * [B]  Същото, само J+9+A (3 card)                        → pass
 * [C]  J+9+A+7 (4 card)                                   → suit bid
 * [D]  Пет карти с J+9+A                                  → suit bid
 * [E]  Четири карти без J                                  → suit забранен
 * [F]  Четири карти без 9                                  → suit забранен
 * [G]  Четири карти без A                                  → suit забранен
 * [H]  Strict active, нашият отбор раздава, 5 силни карти → pass
 * [I]  opponentScore точно 140                             → стара логика
 * [J]  Gap точно 12                                        → стара логика
 * [K]  Точно два цвята J+9, останалите с ниски → 4 tricks  → all-trumps допустим
 * [L]  Три валета без деветки → 3 tricks                   → all-trumps забранен
 * [M]  A+10 в две бои при no-trumps → 4 tricks            → no-trumps допустим
 * [N]  Само три tricks при no-trumps                       → no-trumps забранен
 * [O]  Suit J+9+A+четвърта карта допустим; all-trumps под threshold → suit избран
 * [P]  Guard-false → идентично с base логика (deep equal)
 * [Q]  Dealer rotation за всички четири seats
 * [R]  Постоянен бот и takeover → еднакво поведение
 * [S]  Per-candidate fallback: all-trumps 3 tricks, no-trumps 4 tricks → no-trumps избран
 * [T]  Team B симетрия: botSeat=right, teamA=141, teamB=128
 */

import { pickServerBotBidAction } from '../src/game/pickServerBotBidAction.js'
import type {
  ServerAuthoritativeGameState,
  ServerBidAction,
  ServerCard,
  ServerPlayerState,
  ServerSuit,
} from '../src/game/serverGameTypes.js'
import type { Seat, Team } from '../src/core/serverTypes.js'

// ─── Брояч ──────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function checkPass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function checkFail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function check(label: string, fn: () => void): void {
  try {
    fn()
    checkPass(label)
  } catch (err) {
    checkFail(label, err)
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
function assertDeepEqual(actual: ServerBidAction, expected: ServerBidAction, label: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    throw new Error(`${label}: получено ${a}, очаквано ${e}`)
  }
}

// ─── State builders ──────────────────────────────────────────────────────────

function makeCard(suit: ServerSuit, rank: ServerCard['rank'], id?: string): ServerCard {
  return { id: id ?? `${suit}-${rank}`, suit, rank }
}

function makePlayers(mode: ServerPlayerState['mode'] = 'bot'): Record<Seat, ServerPlayerState> {
  const seats: Seat[] = ['bottom', 'right', 'top', 'left']
  const teams: Team[] = ['A', 'B', 'A', 'B']
  return Object.fromEntries(
    seats.map((s, i) => [
      s,
      { seat: s, team: teams[i]!, mode, controlledByBot: mode === 'bot' },
    ]),
  ) as Record<Seat, ServerPlayerState>
}

type MakeBiddingStateOpts = {
  botSeat: Seat
  hand: ServerCard[]
  dealerSeat: Seat
  matchScore: { teamA: number; teamB: number }
  currentBidderSeat?: Seat
  mode?: ServerPlayerState['mode']
}

function makeBiddingState(opts: MakeBiddingStateOpts): ServerAuthoritativeGameState {
  const {
    botSeat,
    hand,
    dealerSeat,
    matchScore,
    currentBidderSeat = botSeat,
    mode = 'bot',
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
    players: makePlayers(mode),
    round: {
      dealerSeat,
      cutterSeat: null,
      firstBidderSeat: null,
      firstDealSeat: null,
      selectedCutIndex: null,
    },
    deck: [],
    hands,
    bidding: {
      entries: [],
      currentSeat: currentBidderSeat,
      winningBid: null,
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
    currentTrick: {
      leaderSeat: null,
      currentSeat: null,
      plays: [],
      winnerSeat: null,
      trickIndex: 0,
    },
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

// ─── Стандартен контекст ─────────────────────────────────────────────────────
// bottom = team A (бот), right/left = team B (противници)
// При opponent=141, bot=128: strict активен

const BOT: Seat = 'bottom'           // team A
const OPP_DEALER: Seat = 'right'     // team B → противникът раздава
const OUR_DEALER: Seat = 'top'       // team A → нашият отбор раздава

const STRICT_SCORE = { teamA: 128, teamB: 141 }  // opp=141, gap=13
const NORMAL_SCORE = { teamA: 100, teamB: 100 }  // без strict mode

// ─── Проверки ────────────────────────────────────────────────────────────────

console.log('\ncheckStrictModeBidding')

// [A] opp=141, bot=128, opp deals, suit hearts J+9+A+10 (4 card) → suit bid
check('[A] strict active, opp deals, J+9+A+10 hearts → suit bid', () => {
  const hand = [
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
    makeCard('hearts', 'A'),
    makeCard('hearts', '10'),
  ]
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE })
  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'suit', 'action type')
  if (action.type === 'suit') assertEqual(action.suit, 'hearts', 'suit')
})

// [B] Същото, само J+9+A (3 card) → pass
check('[B] strict active, opp deals, only J+9+A (3 card) → pass', () => {
  const hand = [
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
    makeCard('hearts', 'A'),
    makeCard('clubs', 'K'),
    makeCard('spades', 'Q'),
  ]
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE })
  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'pass', 'action type')
})

// [C] J+9+A+7 (4 card) → suit bid
check('[C] strict active, J+9+A+7 (4 card) → suit bid', () => {
  const hand = [
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
    makeCard('hearts', 'A'),
    makeCard('hearts', '7'),
  ]
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE })
  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'suit', 'action type')
})

// [D] Пет карти с J+9+A → suit bid
check('[D] strict active, 5 cards with J+9+A → suit bid', () => {
  const hand = [
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
    makeCard('hearts', 'A'),
    makeCard('hearts', 'K'),
    makeCard('hearts', 'Q'),
  ]
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE })
  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'suit', 'action type')
})

// [E] Четири карти без J → suit кандидатът е забранен
check('[E] strict active, 4 cards without J → suit forbidden', () => {
  const hand = [
    makeCard('hearts', '9'),
    makeCard('hearts', 'A'),
    makeCard('hearts', '10'),
    makeCard('hearts', 'K'),
  ]
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE })
  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'pass', 'action type')
})

// [F] Четири карти без 9 → suit кандидатът е забранен
check('[F] strict active, 4 cards without 9 → suit forbidden', () => {
  const hand = [
    makeCard('hearts', 'J'),
    makeCard('hearts', 'A'),
    makeCard('hearts', '10'),
    makeCard('hearts', 'K'),
  ]
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE })
  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'pass', 'action type')
})

// [G] Четири карти без A → suit кандидатът е забранен
check('[G] strict active, 4 cards without A → suit forbidden', () => {
  const hand = [
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
    makeCard('hearts', '10'),
    makeCard('hearts', 'K'),
  ]
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE })
  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'pass', 'action type')
})

// [H] Strict active, НАШ отбор раздава, 5 силни карти → pass
check('[H] strict active, our team deals → pass regardless of hand', () => {
  const hand = [
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
    makeCard('hearts', 'A'),
    makeCard('hearts', '10'),
    makeCard('hearts', 'K'),
  ]
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OUR_DEALER, matchScore: STRICT_SCORE })
  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'pass', 'нашият отбор раздава → задължително pass')
})

// [I] opponentScore точно 140 → стара логика (strict НЕ активен)
check('[I] opponentScore exactly 140 → old logic (no strict)', () => {
  const hand = [
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
    makeCard('hearts', 'A'),
    makeCard('hearts', '10'),
  ]
  // opp=140 → НЕ > 140 → strict не се активира
  const score = { teamA: 120, teamB: 140 }
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: score })
  const action = pickServerBotBidAction(state, BOT)
  assert(action.type !== 'pass', `очакван suit bid при нормална логика, получено: ${action.type}`)
})

// [J] Gap точно 12 → стара логика (strict НЕ активен)
check('[J] gap exactly 12 → old logic (no strict)', () => {
  const hand = [
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
    makeCard('hearts', 'A'),
    makeCard('hearts', '10'),
  ]
  // opp=141, bot=129, gap=12 → НЕ > 12 → strict не се активира
  const score = { teamA: 129, teamB: 141 }
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: score })
  const action = pickServerBotBidAction(state, BOT)
  assert(action.type !== 'pass', `очакван suit bid при нормална логика, получено: ${action.type}`)
})

// [K] Точно два цвята J+9, останалите с ниски → 4 secure tricks → all-trumps допустим
//
// Ръка:
//   clubs:   J, 9        → top-chain J→9 = 2 tricks
//   hearts:  J, 9        → top-chain J→9 = 2 tricks
//   diamonds: 7, 8       → top-chain празен = 0
//   spades:  7, 8        → top-chain празен = 0
//   Общо: 4 secure tricks
//
// guaranteed all-trumps points:
//   clubs J=20 + clubs 9 (с J)=14 = 34
//   hearts J=20 + hearts 9 (с J)=14 = 34
//   Общо: 68 ≥ 54 → влиза в candidates
check('[K] all-trumps: exactly two suits J+9, rest low → exactly 4 secure tricks → allowed', () => {
  const hand = [
    makeCard('clubs', 'J'),
    makeCard('clubs', '9'),
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
    makeCard('diamonds', '7'),
    makeCard('diamonds', '8'),
    makeCard('spades', '7'),
    makeCard('spades', '8'),
  ]
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE })
  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'all-trumps', 'action type')
})

// [L] Три валета без деветки → 3 secure tricks → all-trumps забранен → pass
//
// Ръка:
//   clubs:   J, K        → top-chain J→9: J✓ 9✗ = 1 trick
//   hearts:  J, K        → top-chain J→9: J✓ 9✗ = 1 trick
//   diamonds: J, K       → top-chain J→9: J✓ 9✗ = 1 trick
//   spades:  Q, 8        → top-chain = 0 tricks
//   Общо: 3 secure tricks < 4 → filtered
//
// guaranteed all-trumps points: 3J × 20 = 60 ≥ 54 → влиза в candidates, но filtered
// no-trumps guaranteed points: 0 Aces → 0 < 32 → не влиза в candidates
// suit: нито един suit има J+9+A+4 карти → не влиза в candidates
// Резултат: pass
check('[L] all-trumps: three Jacks no Nines → 3 tricks → forbidden → pass', () => {
  const hand = [
    makeCard('clubs', 'J'),
    makeCard('clubs', 'K'),
    makeCard('hearts', 'J'),
    makeCard('hearts', 'K'),
    makeCard('diamonds', 'J'),
    makeCard('diamonds', 'K'),
    makeCard('spades', 'Q'),
    makeCard('spades', '8'),
  ]
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE })
  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'pass', 'action type')
})

// [M] A+10 в две бои при no-trumps → 4 tricks → no-trumps допустим
//
// clubs:  A, 10 → A→10→K: A✓ 10✓ K✗ = 2 tricks
// hearts: A, 10 → A→10→K: A✓ 10✓ K✗ = 2 tricks
// Общо: 4 tricks ≥ 4 → допустим
// guaranteed no-trumps points: (11+10)+(11+10) = 42 ≥ 32 → влиза в candidates
check('[M] no-trumps: A+10 in two suits → 4 secure tricks → allowed', () => {
  const hand = [
    makeCard('clubs', 'A'),
    makeCard('clubs', '10'),
    makeCard('hearts', 'A'),
    makeCard('hearts', '10'),
    makeCard('diamonds', 'K'),
    makeCard('diamonds', 'Q'),
    makeCard('spades', 'K'),
    makeCard('spades', 'Q'),
  ]
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE })
  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'no-trumps', 'action type')
})

// [N] Само три tricks при no-trumps → кандидатът забранен
//
// clubs:  A, 10 → 2 tricks
// hearts: A     → 1 trick
// Общо: 3 tricks < 4 → filtered
// guaranteed no-trumps: 11+10+11 = 32 ≥ 32 → влиза в candidates, но filtered
// no suit J+9+A+4, no valid all-trumps → pass
check('[N] no-trumps: only 3 secure tricks → forbidden → pass', () => {
  const hand = [
    makeCard('clubs', 'A'),
    makeCard('clubs', '10'),
    makeCard('hearts', 'A'),
    makeCard('diamonds', 'K'),
    makeCard('diamonds', 'Q'),
    makeCard('spades', 'K'),
    makeCard('spades', 'Q'),
    makeCard('spades', 'J'),
  ]
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE })
  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'pass', 'action type')
})

// [O] Suit J+9+A+четвърта карта е допустим; all-trumps не достига candidate threshold → suit избран
//
// Ръката умишлено има само един валет (hearts J) → guaranteed all-trumps: J=20 + 9=14 = 34 < 54
// → all-trumps не влиза в candidates изобщо (под стария threshold)
// hearts J+9+A+K → passesStrictSuitCheck ✓ (4 карти, J+9+A налични)
// no-trumps guaranteed: само A в hearts = 11 < 32 → не влиза в candidates
// Резултат: hearts suit bid
check('[O] suit J+9+A+4th card allowed; all-trumps below old threshold → suit wins', () => {
  const hand = [
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
    makeCard('hearts', 'A'),
    makeCard('hearts', 'K'),
    makeCard('clubs', 'Q'),
    makeCard('clubs', '8'),
    makeCard('diamonds', 'K'),
    makeCard('spades', '7'),
  ]
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE })
  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'suit', 'action type')
  if (action.type === 'suit') assertEqual(action.suit, 'hearts', 'suit')
})

// [P] Guard-false → идентично с base логика (deep equal на цялото ServerBidAction)
check('[P] strict inactive → identical to base logic (deep equal)', () => {
  const hand = [
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
    makeCard('hearts', 'A'),
    makeCard('hearts', '10'),
  ]
  // Нормален score — strict не е активен
  const stateNormal = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: NORMAL_SCORE })
  const resultNormal = pickServerBotBidAction(stateNormal, BOT)

  // Гранична стойност: opp=140 (не > 140) → strict не се активира
  const scoreAlmost = { teamA: 120, teamB: 140 }
  const stateAlmost = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: scoreAlmost })
  const resultAlmost = pickServerBotBidAction(stateAlmost, BOT)

  assertDeepEqual(resultNormal, resultAlmost, 'действията трябва да съвпадат напълно')
})

// [Q] Dealer rotation за всички четири seats
//
// SERVER_SEAT_ORDER = ['bottom', 'right', 'top', 'left']
// Team A = bottom, top; Team B = right, left
// При bot=bottom (team A):
//   dealer=bottom (A) → нашият раздава → pass при strict
//   dealer=right  (B) → opp раздава   → bid при strict (ако ≥ 4 tricks)
//   dealer=top    (A) → нашият раздава → pass при strict
//   dealer=left   (B) → opp раздава   → bid при strict (ако ≥ 4 tricks)
check('[Q] dealer rotation: all four dealer seats', () => {
  // Ръка с допустим suit при strict (J+9+A+10 в hearts)
  const hand = [
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
    makeCard('hearts', 'A'),
    makeCard('hearts', '10'),
  ]

  const dealers: Seat[] = ['bottom', 'right', 'top', 'left']
  const expectedPass = [true, false, true, false] // team A dealers → pass

  for (let i = 0; i < dealers.length; i++) {
    const dealer = dealers[i]!
    const expectPass = expectedPass[i]!
    const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: dealer, matchScore: STRICT_SCORE })
    const action = pickServerBotBidAction(state, BOT)
    if (expectPass) {
      assert(
        action.type === 'pass',
        `dealer=${dealer} (team A) → strict active, our team deals → expected pass, got ${action.type}`,
      )
    } else {
      assert(
        action.type !== 'pass',
        `dealer=${dealer} (team B) → strict active, opp deals → expected bid, got pass`,
      )
    }
  }
})

// [R] Постоянен бот и takeover seat → еднакво поведение
check('[R] permanent bot vs takeover seat → same behavior', () => {
  const hand = [
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
    makeCard('hearts', 'A'),
    makeCard('hearts', '10'),
  ]

  const stateBot = makeBiddingState({
    botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE, mode: 'bot',
  })
  const actionBot = pickServerBotBidAction(stateBot, BOT)

  // Takeover: mode='human' (играчът е human, но ботът го поема)
  const stateTakeover = makeBiddingState({
    botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE, mode: 'human',
  })
  const actionTakeover = pickServerBotBidAction(stateTakeover, BOT)

  assertDeepEqual(actionBot, actionTakeover, 'bot и takeover трябва да дадат идентично действие')
})

// [S] Per-candidate fallback: all-trumps има 3 secure tricks, no-trumps има 4 → no-trumps избран
//
// Ръка:
//   clubs:   J, K  → all-trumps top-chain: J✓ 9✗ = 1 trick; no-trumps: A✗ = 0
//   hearts:  J, K  → all-trumps: 1 trick; no-trumps: 0
//   diamonds: J, K → all-trumps: 1 trick; no-trumps: 0
//   spades: A, 10  → all-trumps: A→10 (но ред е J→9→A, няма J) = 0; no-trumps: A✓ 10✓ = 2
//
// all-trumps guaranteed: 3J×20=60 ≥ 54 → влиза в candidates; top-chain=3 < 4 → filtered
// no-trumps guaranteed: spades A=11 + 10=10 = 21 < 32 → НЕ влиза в candidates!
//
// Горната ръка не работи за [S] защото no-trumps не минава threshold.
// Нужна е ръка с: 3J (all-trumps threshold OK, 3 tricks) + no-trumps guaranteed ≥ 32 + 4 tricks.
// no-trumps guaranteed ≥ 32: трябват A×3 (33pt) или A×2 + A+10 (32pt) и т.н.
// Но при 3J в ръката → малко място за A.
//
// Ръка: clubs J, hearts J, diamonds J, spades A, spades 10, clubs A, hearts A, diamonds 8
//   all-trumps top-chain: clubs J=1, hearts J=1, diamonds J=1, spades (no J)=0 → total=3 < 4 → filtered
//   all-trumps guaranteed: 3×20=60 ≥ 54 → влиза в candidates, но filtered
//   no-trumps top-chain: clubs A=1, hearts A=1, diamonds (no A)=0, spades A+10=2 → total=4 ≥ 4 → допустим
//   no-trumps guaranteed: clubs A=11, hearts A=11, spades A=11 + 10=10 → 43 ≥ 32 → влиза в candidates
//   suit: нито един suit има J+9+A+4 → не влиза
//
// При strict: all-trumps filtered (3 tricks); no-trumps допустим (4 tricks) → no-trumps избран
//
// Верификация на normal режим спрямо теста:
//   При normal: и all-trumps, и no-trumps са кандидати → score логиката избира между тях.
//   Тестът проверява само strict резултата (no-trumps), не твърди нищо за normal режима.
check('[S] per-candidate fallback: all-trumps 3 tricks filtered, no-trumps 4 tricks → no-trumps chosen', () => {
  const hand = [
    makeCard('clubs', 'J'),
    makeCard('clubs', 'A'),
    makeCard('hearts', 'J'),
    makeCard('hearts', 'A'),
    makeCard('diamonds', 'J'),
    makeCard('diamonds', '8'),
    makeCard('spades', 'A'),
    makeCard('spades', '10'),
  ]
  const state = makeBiddingState({ botSeat: BOT, hand, dealerSeat: OPP_DEALER, matchScore: STRICT_SCORE })
  const action = pickServerBotBidAction(state, BOT)
  assertEqual(action.type, 'no-trumps', 'action type при strict mode')
})

// [T] Team B симетрия: botSeat=right (team B), teamA=141, teamB=128
//
// Доказва, че правилото важи симетрично — не само за bottom/team A.
// right е team B; противниковият отбор е team A (bottom, top).
//
// dealer=bottom (team A) → противникът раздава → bid разрешен при ≥4 tricks
// dealer=right  (team B) → нашият раздава → pass
// dealer=top    (team A) → противникът раздава → bid разрешен
// dealer=left   (team B) → нашият раздава → pass
check('[T] team B symmetry: botSeat=right, teamA=141, teamB=128', () => {
  const BOT_B: Seat = 'right'  // team B
  // Strict score за team B бот: teamA (опонент) > 140, gap > 12
  const strictScoreB = { teamA: 141, teamB: 128 }

  // Ръка с допустим suit при strict (J+9+A+10 в hearts)
  const hand = [
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
    makeCard('hearts', 'A'),
    makeCard('hearts', '10'),
  ]

  // dealer от team A → противникът (team A) раздава → bid разрешен
  const stateOppDeals = makeBiddingState({
    botSeat: BOT_B, hand, dealerSeat: 'bottom', matchScore: strictScoreB,
  })
  const actionOppDeals = pickServerBotBidAction(stateOppDeals, BOT_B)
  assert(
    actionOppDeals.type !== 'pass',
    `dealer=bottom (team A) → opp deals for team B bot → expected bid, got pass`,
  )

  // dealer от team B → нашият отбор раздава → pass
  const stateOurDeals = makeBiddingState({
    botSeat: BOT_B, hand, dealerSeat: 'right', matchScore: strictScoreB,
  })
  const actionOurDeals = pickServerBotBidAction(stateOurDeals, BOT_B)
  assertEqual(
    actionOurDeals.type,
    'pass',
    'dealer=right (team B) → our team deals → expected pass',
  )

  // dealer=top (team A) → противникът раздава → bid разрешен
  const stateOppDeals2 = makeBiddingState({
    botSeat: BOT_B, hand, dealerSeat: 'top', matchScore: strictScoreB,
  })
  const actionOppDeals2 = pickServerBotBidAction(stateOppDeals2, BOT_B)
  assert(
    actionOppDeals2.type !== 'pass',
    `dealer=top (team A) → opp deals for team B bot → expected bid, got pass`,
  )

  // dealer=left (team B) → нашият раздава → pass
  const stateOurDeals2 = makeBiddingState({
    botSeat: BOT_B, hand, dealerSeat: 'left', matchScore: strictScoreB,
  })
  const actionOurDeals2 = pickServerBotBidAction(stateOurDeals2, BOT_B)
  assertEqual(
    actionOurDeals2.type,
    'pass',
    'dealer=left (team B) → our team deals → expected pass',
  )
})

// ─── Финален резултат ────────────────────────────────────────────────────────

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
