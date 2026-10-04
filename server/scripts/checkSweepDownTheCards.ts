/**
 * checkSweepDownTheCards.ts
 *
 * Regression/behavior suite for "Долу картите" (go-down / claim-the-rest).
 *
 * Covers (виж task spec Part G, сценарии 1-15):
 *  [1]  computeServerSweepEligibility: unbeatable remaining hand -> true
 *  [2]  computeServerSweepEligibility: beatable remaining hand -> false
 *  [3]  forged/wrong-seat decision request -> no-op
 *  [4]  decline ('X') -> only sweepOffer/declinedSweepSeats/currentTurnSeat/timer change
 *  [5]  successful accept -> completedTricks=8, hands empty, sweepResolution populated, phase stays 'playing'
 *  [6]  remaining-card points credited correctly via UNMODIFIED resolveServerScoring
 *  [7]  "последно 10" (last trick bonus) credited to the sweeping team
 *  [8]  капо/валат credited correctly via UNMODIFIED resolveServerScoring
 *  [9]  undeclared belot on the OPPONENT team is auto-credited
 *  [10] undeclared belot on the PARTNER (claimant's own team) is auto-credited
 *  [11] already-declared belot is NOT duplicated
 *  [12] a foreign team's belot is credited regardless of the claimant's own suits
 *  [13] duplicate accept request (double-click) is a no-op the second time
 *  [14] snapshot gating: sweepOffer is seat-gated, sweepResolution is NOT
 *  [15] normal trick flow is unaffected; a prior decline is never re-offered
 *  [16] sweep is offered only with at least 2 remaining cards (1 card -> no offer)
 *  [17] the sweep is personal: a partner card that can beat the claimant blocks it
 *
 * Judgment call documented in the final report: the synthesized auto-credited
 * belote ServerDeclaration records are written with `announced: true` (NOT
 * false as a literal reading of the task brief suggested) — confirmed by
 * reading declarations/scoreServerDeclarations.ts (filterScoreableDeclarations
 * requires announced===true) and src/app/activeRoom/renderScoringPanel.ts
 * (buildScoringDeclarationItems also requires `.announced`) that both the
 * EXISTING unmodified scoring pipeline and the EXISTING scoring panel UI only
 * recognize announced:true records. The client's "Белот +20" auto-credit
 * indicator is driven separately by ServerSweepResolution.autoCreditedBelotes,
 * not by inspecting this flag, so no information is lost by keeping it true.
 */

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('\n═══ checkSweepDownTheCards ═══')

const { computeServerSweepEligibility } = await import('../src/game/computeServerSweepEligibility.js')
const { submitServerSweepDecision } = await import('../src/game/submitServerSweepDecision.js')
const { submitServerPlayCard } = await import('../src/game/submitServerPlayCard.js')
const { resolveServerScoring } = await import('../src/game/serverScoring.js')
const { detectServerDeclarationsInHand } = await import('../src/game/declarations/index.js')
const { createPlayingSnapshot } = await import('../src/protocol/createRoomSnapshotMessage.js')

type Seat = 'bottom' | 'right' | 'top' | 'left'
type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'
type Rank = '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'
type Card = { id: string; suit: Suit; rank: Rank }

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']

function card(suit: Suit, rank: Rank, idSuffix = ''): Card {
  return { id: `${suit}-${rank}${idSuffix}`, suit, rank }
}

function teamBySeat(seat: Seat): 'A' | 'B' {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

function emptyRoundScore() {
  return { teamA: 0, teamB: 0 }
}

function emptyMissionCounts() {
  return {
    announce_tersa: emptyRoundScore(),
    announce_50: emptyRoundScore(),
    announce_100: emptyRoundScore(),
    announce_kare: emptyRoundScore(),
    announce_belot: emptyRoundScore(),
  }
}

function emptyScoreBreakdown() {
  return {
    tricks: emptyRoundScore(),
    declarations: emptyRoundScore(),
    belote: emptyRoundScore(),
    lastTen: emptyRoundScore(),
    capot: emptyRoundScore(),
    total: emptyRoundScore(),
  }
}

// Mirrors checkBotTimeoutDeclarationDefaults.ts's `baseState` fixture
// convention, extended with the 3 new ServerPlayingState fields
// (sweepOffer/declinedSweepSeats/sweepResolution).
function baseState(params: {
  hands: Record<Seat, Card[]>
  contract: 'suit' | 'no-trumps' | 'all-trumps'
  trumpSuit?: Suit | null
  bidderSeat?: Seat
  completedTricks?: any[]
  wonTricksBySeat?: Record<Seat, Card[][]>
  wonTricksByTeam?: Record<'A' | 'B', Card[][]>
  currentTrick?: any
  currentTurnSeat?: Seat | null
  sweepOffer?: any
  declinedSweepSeats?: Seat[]
  sweepResolution?: any
  existingDeclarations?: any[]
}): any {
  const {
    hands,
    contract,
    trumpSuit = null,
    bidderSeat = 'bottom',
    completedTricks = [],
    wonTricksBySeat = { bottom: [], right: [], top: [], left: [] },
    wonTricksByTeam = { A: [], B: [] },
    currentTrick = { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: completedTricks.length },
    currentTurnSeat = null,
    sweepOffer = null,
    declinedSweepSeats = [],
    sweepResolution = null,
    existingDeclarations = [],
  } = params

  return {
    phase: 'playing',
    phaseEnteredAt: Date.now(),
    targetScore: 151,
    players: Object.fromEntries(
      SEATS.map((seat) => [
        seat,
        { seat, team: teamBySeat(seat), mode: 'human', controlledByBot: false },
      ]),
    ),
    round: {
      dealerSeat: 'bottom',
      cutterSeat: 'right',
      firstBidderSeat: 'right',
      firstDealSeat: 'right',
      selectedCutIndex: null,
    },
    deck: [],
    hands,
    bidding: {
      entries: [],
      currentSeat: null,
      winningBid: {
        seat: bidderSeat,
        contract,
        trumpSuit: contract === 'suit' ? trumpSuit : null,
        doubled: false,
        redoubled: false,
      },
      hasStarted: true,
      hasEnded: true,
      consecutivePasses: 0,
    },
    declarations: existingDeclarations,
    matchDeclarationMissionCounts: emptyMissionCounts(),
    matchDeclarationMissionCountsBySeat: {},
    currentTrick: { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 0 },
    wonTricks: { A: [], B: [] },
    playing: {
      hasStarted: true,
      currentTurnSeat,
      currentTrick,
      completedTricks,
      lastCompletedTrickWinnerSeat: null,
      lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat,
      wonTricksByTeam,
      sweepOffer,
      declinedSweepSeats,
      sweepResolution,
    },
    scoring: null,
    matchEnded: null,
    score: { round: emptyScoreBreakdown(), match: emptyRoundScore(), carryOver: { teamA: 0, teamB: 0 } },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  }
}

function fillerTrick(trickIndex: number, winnerSeat: Seat): any {
  return {
    trickIndex,
    leaderSeat: winnerSeat,
    winnerSeat,
    winningTeam: teamBySeat(winnerSeat),
    plays: SEATS.map((seat) => ({ seat, card: card('clubs', '7', `-filler-${trickIndex}-${seat}`) })),
  }
}

// ---- [1] computeServerSweepEligibility: unbeatable hand -> true ----

await check('[1] unbeatable remaining hand (trump J+9+A, nobody else holds trump) is sweep-eligible', () => {
  // bottom holds the 3 highest-ranked trump cards remaining in the deck
  // (TRUMP_RANK_POWER: J=7, 9=6, A=5 — the top three). Nobody else holds any
  // club (trump) card at all, so whenever bottom leads trump, the other 3
  // seats are void of the lead suit AND void of trump itself -> per
  // getValidCardsInSuitContract's "leadSuit===trumpSuit, followSuitCards
  // empty -> return hand" branch they may play anything, but per
  // getServerTrickWinner a non-trump card can never beat a trump lead. Holds
  // for any lead order, so bottom wins all 3 remaining tricks regardless.
  const hands: Record<Seat, Card[]> = {
    bottom: [card('clubs', 'J'), card('clubs', '9'), card('clubs', 'A')],
    right: [card('diamonds', '7'), card('diamonds', '8'), card('diamonds', 'Q')],
    top: [card('hearts', '7'), card('hearts', '8'), card('hearts', 'Q')],
    left: [card('spades', '7'), card('spades', '8'), card('spades', 'Q')],
  }

  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands,
    winningBid: { seat: 'bottom', contract: 'suit', trumpSuit: 'clubs', doubled: false, redoubled: false },
  })

  assert(eligible === true, 'expected the unbeatable trump hand to be sweep-eligible')
})

// ---- [2] computeServerSweepEligibility: beatable hand -> false ----

await check('[2] a hand with a non-trump lead that an opponent can legally overtrump is NOT sweep-eligible', () => {
  // bottom holds only 2 non-trump hearts (A, K) — no trump left in bottom's
  // own hand. `right` still holds one trump card (clubs 7). Whichever heart
  // bottom leads first, `right` is void of hearts; since right's partner
  // (left) has not acted yet, right's own team is not currently winning, so
  // right is FORCED to overtrump (getValidCardsInSuitContract: "Partner is
  // not winning. Must play trump if we have one.") with its only trump card,
  // beating bottom's non-trump lead on the very first trick it faces.
  const hands: Record<Seat, Card[]> = {
    bottom: [card('hearts', 'A'), card('hearts', 'K')],
    right: [card('clubs', '7'), card('diamonds', '7')],
    top: [card('spades', '7'), card('spades', '8')],
    left: [card('spades', '9'), card('spades', '10')],
  }

  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands,
    winningBid: { seat: 'bottom', contract: 'suit', trumpSuit: 'clubs', doubled: false, redoubled: false },
  })

  assert(eligible === false, 'expected the beatable hand to NOT be sweep-eligible')
})

// ---- shared eligible fixture for accept-path tests ----

function buildEligibleAcceptFixture(options: {
  completedTricksBefore: number // how many (filler) tricks already completed before the sweep
  existingDeclarations?: any[]
}): any {
  const { completedTricksBefore, existingDeclarations = [] } = options
  const hands: Record<Seat, Card[]> = {
    bottom: [card('clubs', 'J'), card('clubs', '9'), card('clubs', 'A')],
    right: [card('diamonds', '7'), card('diamonds', '8'), card('diamonds', 'Q')],
    top: [card('hearts', '7'), card('hearts', '8'), card('hearts', 'Q')],
    left: [card('spades', '7'), card('spades', '8'), card('spades', 'Q')],
  }
  const completedTricks = Array.from({ length: completedTricksBefore }, (_, i) => fillerTrick(i, 'right'))

  return baseState({
    hands,
    contract: 'suit',
    trumpSuit: 'clubs',
    completedTricks,
    sweepOffer: { seat: 'bottom', offeredAtTrickIndex: completedTricksBefore, expiresAt: Date.now() + 15000 },
    existingDeclarations,
  })
}

// ---- [3] forged/wrong-seat request is a no-op ----

await check('[3] submitServerSweepDecision with a seat that does not match sweepOffer.seat is a no-op', () => {
  const state = buildEligibleAcceptFixture({ completedTricksBefore: 5 })
  const next = submitServerSweepDecision(state, 'right', 'accept')
  assert(next === state, 'expected the exact same state reference back for a forged-seat request')

  const nextDecline = submitServerSweepDecision(state, 'top', 'decline')
  assert(nextDecline === state, 'expected the exact same state reference back for a forged-seat decline too')
})

// ---- [4] decline changes only sweepOffer/declinedSweepSeats/currentTurnSeat/timer ----

await check('[4] decline (X) does not touch hands/declarations/completedTricks/score', () => {
  const state = buildEligibleAcceptFixture({ completedTricksBefore: 5 })
  const next = submitServerSweepDecision(state, 'bottom', 'decline')

  assert(next !== state, 'expected a new state object for an accepted decline')
  assert(next.hands === state.hands, 'hands reference must be unchanged on decline')
  assert(next.declarations === state.declarations, 'declarations reference must be unchanged on decline')
  assert(
    next.playing.completedTricks === state.playing.completedTricks,
    'completedTricks reference must be unchanged on decline',
  )
  assert(next.score === state.score, 'score reference must be unchanged on decline')

  assert(next.playing.sweepOffer === null, 'sweepOffer must be cleared after decline')
  assert(next.playing.declinedSweepSeats.includes('bottom'), 'declinedSweepSeats must include the declining seat')
  assert(next.playing.currentTurnSeat === 'bottom', 'currentTurnSeat must resume to the declining seat (they led the won trick)')
  assert(next.timer.activeSeat === 'bottom', 'a fresh playing timer must be started for the declining seat')
  assert(typeof next.timer.durationMs === 'number' && next.timer.durationMs > 0, 'timer must have a positive duration')
})

// ---- [5] successful accept ----

await check('[5] accept: completedTricks reaches 8, all hands empty, sweepResolution populated, phase stays playing', () => {
  const state = buildEligibleAcceptFixture({ completedTricksBefore: 5 })
  const next = submitServerSweepDecision(state, 'bottom', 'accept')

  assert(next !== state, 'expected a new state for a successful accept')
  assert(next.playing.completedTricks.length === 8, `expected 8 completed tricks, got ${next.playing.completedTricks.length}`)
  for (const seat of SEATS) {
    assert(next.hands[seat].length === 0, `expected ${seat}'s hand to be empty after sweep, got ${next.hands[seat].length}`)
  }
  assert(next.playing.sweepOffer === null, 'sweepOffer must be cleared')
  assert(next.playing.sweepResolution !== null, 'sweepResolution must be populated')
  assert(next.playing.sweepResolution.winnerSeat === 'bottom', 'winnerSeat must be the claimant')
  assert(next.playing.sweepResolution.winnerTeam === 'A', 'winnerTeam must match the claimant seat')
  assert(
    JSON.stringify(next.playing.sweepResolution.throwOrder) === JSON.stringify(['bottom', 'right', 'top', 'left']),
    `expected throwOrder [bottom,right,top,left], got ${JSON.stringify(next.playing.sweepResolution.throwOrder)}`,
  )
  assert(
    next.playing.sweepResolution.handsAtResolution.bottom.length === 3,
    'handsAtResolution must capture the claimant hand size BEFORE clearing',
  )
  assert(typeof next.playing.sweepResolution.resolvedAt === 'number', 'resolvedAt must be a number')
  assert(next.phase === 'playing', 'phase must stay playing (scoring transition is handled by the existing auto-advance pipeline)')
})

// ---- [6]/[7]/[8] scoring correctness via the UNMODIFIED resolveServerScoring ----

function buildScoringFixture(options: {
  priorTricks: { winnerSeat: Seat; points: number }[] // each prior trick's 4 cards collectively worth `points`
  sweeperRemainingPoints: number // sum of point-values across ALL 4 remaining hands (all credited to the sweeper's team)
}): any {
  const { priorTricks, sweeperRemainingPoints } = options
  const completedTricks = priorTricks.map((t, i) => {
    const pointCards = pointCardsSummingTo(t.points, `prior-${i}`)
    assert(pointCards.length <= 4, `test fixture bug: prior trick ${i}'s ${t.points} points need more than 4 cards`)
    const allCards = [
      ...pointCards,
      ...Array.from({ length: 4 - pointCards.length }, (_, j) => card('clubs', '7', `-prior-${i}-pad-${j}`)),
    ]
    return {
      trickIndex: i,
      leaderSeat: t.winnerSeat,
      winnerSeat: t.winnerSeat,
      winningTeam: teamBySeat(t.winnerSeat),
      plays: SEATS.map((seat, idx) => ({ seat, card: allCards[idx]! })),
    }
  })

  const remainingCount = 8 - priorTricks.length
  // The "void-never-wins" pattern below gives every void seat ALL of its
  // (duplicate, test-only) cards as legal responses at every step, which
  // blows up the exhaustive double-dummy search's branching factor well
  // past MAX_SEARCH_NODES once remainingCount gets much past 5 — a
  // test-fixture artifact (a real deck never holds 5+ duplicate cards), not
  // a production concern. Keep fixtures at remainingCount<=5 here.
  assert(remainingCount <= 5, `test fixture bug: remainingCount=${remainingCount} is too large for this fixture pattern (keep <=5)`)
  // Put the entire remaining point total on bottom's cards (rank 'A'=11,
  // '10'=10, 'J'=20, '9'=14 under all-trumps — see pointCard), zero-point
  // filler everywhere else, so the expected sum is easy to hand-verify.
  const remainingPointCards = pointCardsSummingTo(sweeperRemainingPoints, 'remain')
  assert(
    remainingPointCards.length <= remainingCount,
    `test fixture bug: need ${remainingPointCards.length} point cards but only ${remainingCount} remaining slots`,
  )
  // bottom's cards all come from suits (hearts/spades) that the OTHER 3
  // seats never hold a single card of (they hold only clubs/diamonds below),
  // so under all-trumps nobody can ever follow suit on bottom's leads and an
  // off-suit play can never win (isChallengerWinningInAllTrumpsContract) —
  // same "void-never-wins" pattern as the belote fixtures above.
  const bottomHand: Card[] = [
    ...remainingPointCards,
    ...Array.from({ length: remainingCount - remainingPointCards.length }, (_, i) =>
      card('spades', '7', `-bottom-pad-${i}`),
    ),
  ]
  const fillerHand = (seat: Seat): Card[] =>
    Array.from({ length: remainingCount }, (_, i) => card('clubs', '8', `-${seat}-pad-${i}`))

  const hands: Record<Seat, Card[]> = {
    bottom: bottomHand,
    right: fillerHand('right'),
    top: fillerHand('top'),
    left: fillerHand('left'),
  }

  return baseState({
    hands,
    contract: 'all-trumps',
    completedTricks,
    sweepOffer: { seat: 'bottom', offeredAtTrickIndex: priorTricks.length, expiresAt: Date.now() + 15000 },
  })
}

// Decomposes `total` into a small number of known all-trumps point-value
// cards (exhaustive backtracking search over the fixed denomination set,
// since plain greedy can miss a valid decomposition for some totals) purely
// for test-fixture convenience — not production logic.
function pointCardsSummingTo(total: number, idPrefix: string): Card[] {
  const denominations: { points: number; rank: Rank }[] = [
    { points: 20, rank: 'J' },
    { points: 14, rank: '9' },
    { points: 11, rank: 'A' },
    { points: 10, rank: '10' },
    { points: 4, rank: 'K' },
    { points: 3, rank: 'Q' },
  ]

  function solve(remaining: number, startIndex: number): Rank[] | null {
    if (remaining === 0) return []
    if (remaining < 0 || startIndex >= denominations.length) return null
    for (let i = startIndex; i < denominations.length; i += 1) {
      const denom = denominations[i]!
      const rest = solve(remaining - denom.points, i)
      if (rest !== null) return [denom.rank, ...rest]
    }
    return null
  }

  const ranks = solve(total, 0)
  assert(ranks !== null, `test fixture bug: ${total} is not representable with the available all-trumps denominations`)
  return ranks!.map((rank, i) => card('hearts', rank, `-${idPrefix}-${i}`))
}

await check('[6] remaining-card points are credited to the sweeping team via the unmodified scoring pipeline', () => {
  // 3 prior tricks won by right (team B): 7+7+0 = 14 total.
  // Remaining hands (5 cards each — kept small, see buildScoringFixture's
  // search-cost note) sum to 55 points, all credited to bottom's team (A).
  const state = buildScoringFixture({
    priorTricks: [
      { winnerSeat: 'right', points: 3 + 4 }, // Q(3)+K(4)+two 0-point fillers
      { winnerSeat: 'right', points: 3 + 4 },
      { winnerSeat: 'right', points: 0 },
    ],
    sweeperRemainingPoints: 11 + 10 + 20 + 14, // A+10+J+9 = 55
  })
  const next = submitServerSweepDecision(state, 'bottom', 'accept')
  assert(next.playing.completedTricks.length === 8, 'expected 8 completed tricks before scoring')

  const resolution = resolveServerScoring(next)
  assert(resolution !== null, 'expected a scoring resolution')
  // 55 (remaining) + 10 (last-trick bonus, sweeper always wins the last trick) = 65
  assert(
    resolution!.scoring.rawHandPoints.teamA === 65,
    `expected teamA rawHandPoints 65, got ${resolution!.scoring.rawHandPoints.teamA}`,
  )
  assert(
    resolution!.scoring.rawHandPoints.teamB === 14,
    `expected teamB rawHandPoints 14, got ${resolution!.scoring.rawHandPoints.teamB}`,
  )
  assert(
    resolution!.scoring.rawHandTricksWon.teamA === 5 && resolution!.scoring.rawHandTricksWon.teamB === 3,
    `expected tricksWon A=5/B=3, got A=${resolution!.scoring.rawHandTricksWon.teamA}/B=${resolution!.scoring.rawHandTricksWon.teamB}`,
  )
})

await check('[7] "последно 10" (last trick bonus) is credited to the sweeping team', () => {
  // 6 zero-point prior tricks won by right (team B); the last 2 tricks are
  // synthesized by the sweep (minimum allowed — see [16]) — all remaining
  // cards are zero-point filler, so the ONLY points the sweeping team can
  // gain are the +10 last-trick bonus.
  const state = buildScoringFixture({
    priorTricks: Array.from({ length: 6 }, () => ({ winnerSeat: 'right' as Seat, points: 0 })),
    sweeperRemainingPoints: 0,
  })
  const next = submitServerSweepDecision(state, 'bottom', 'accept')
  assert(next.playing.completedTricks.length === 8, 'expected 8 completed tricks before scoring')
  const resolution = resolveServerScoring(next)
  assert(resolution !== null, 'expected a scoring resolution')
  assert(
    resolution!.scoring.rawHandPoints.teamA === 10,
    `expected exactly the +10 last-trick bonus, got ${resolution!.scoring.rawHandPoints.teamA}`,
  )
  assert(resolution!.scoring.rawHandPoints.teamB === 0, `expected teamB 0, got ${resolution!.scoring.rawHandPoints.teamB}`)
})

await check('[8] капо/валат: sweeper team winning every trick is credited a full capot via the unmodified pipeline', () => {
  // 5 prior ZERO-point tricks already won by top (bottom's OWN team, A) —
  // combined with the 3 synthesized tricks the claimant sweeps, team A ends
  // up having won all 8 tricks this round (full capot), without needing an
  // unrealistically large remaining-hand search.
  const state = buildScoringFixture({
    priorTricks: Array.from({ length: 5 }, () => ({ winnerSeat: 'top' as Seat, points: 0 })),
    sweeperRemainingPoints: 0,
  })
  const next = submitServerSweepDecision(state, 'bottom', 'accept')
  assert(next.playing.completedTricks.length === 8, 'expected 8 completed tricks')
  const resolution = resolveServerScoring(next)
  assert(resolution !== null, 'expected a scoring resolution')
  assert(resolution!.scoring.isCapotRound === true, 'expected isCapotRound to be true')
  assert(
    resolution!.scoring.rawHandTricksWon.teamA === 8 && resolution!.scoring.rawHandTricksWon.teamB === 0,
    'expected teamA to have won all 8 tricks',
  )
  // 0 (remaining) + 10 (last trick) + 90 (capot, all-trumps is not doubled) = 100
  assert(
    resolution!.scoring.rawHandPoints.teamA === 100,
    `expected teamA rawHandPoints 100 (0 + 10 last-trick + 90 capot), got ${resolution!.scoring.rawHandPoints.teamA}`,
  )
})

// ---- [9]-[12] undeclared belote auto-credit ----
//
// Shared construction: contract = all-trumps. The claimant (bottom) holds 2
// remaining cards in 2 suits (hearts, spades) that literally nobody else in
// the hand holds ANY card of — under all-trumps, a seat void of the led suit
// may play anything, but an off-suit play can NEVER win a trick
// (isChallengerWinningInAllTrumpsContract: only a card that follows the led
// suit can beat the lead), so bottom's 2 leads are unbeatable regardless of
// what the target seat holds — INCLUDING an undeclared Q+K belote pair in a
// third suit (clubs) that bottom never gets a chance to contest, which is
// exactly what scenario [9]-[12] need to isolate: eligibility does not
// depend on the belote suit at all.

function buildBeloteFixture(options: {
  beloteSeat: Seat
  beloteSuit?: Suit
  existingDeclarations?: any[]
}): any {
  const { beloteSeat, beloteSuit = 'clubs', existingDeclarations = [] } = options
  const fillerSeats = SEATS.filter((s) => s !== beloteSeat && s !== 'bottom')
  const hands: Record<Seat, Card[]> = {
    bottom: [card('hearts', 'A'), card('spades', 'A')],
    right: fillerSeats.includes('right') || beloteSeat === 'right'
      ? beloteSeat === 'right'
        ? [card(beloteSuit, 'Q'), card(beloteSuit, 'K')]
        : [card('diamonds', '7', '-right'), card('diamonds', '8', '-right')]
      : [],
    top: beloteSeat === 'top'
      ? [card(beloteSuit, 'Q'), card(beloteSuit, 'K')]
      : [card('diamonds', '7', '-top'), card('diamonds', '8', '-top')],
    left: beloteSeat === 'left'
      ? [card(beloteSuit, 'Q'), card(beloteSuit, 'K')]
      : [card('diamonds', '7', '-left'), card('diamonds', '8', '-left')],
  }

  const completedTricks = Array.from({ length: 6 }, (_, i) => fillerTrick(i, 'right'))

  return baseState({
    hands,
    contract: 'all-trumps',
    completedTricks,
    sweepOffer: { seat: 'bottom', offeredAtTrickIndex: 6, expiresAt: Date.now() + 15000 },
    existingDeclarations,
  })
}

await check('[9] undeclared belot on the OPPONENT team is auto-credited', () => {
  const state = buildBeloteFixture({ beloteSeat: 'right' })
  // sanity: eligibility must genuinely hold for this fixture.
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: state.hands,
    winningBid: state.bidding.winningBid,
  })
  assert(eligible === true, 'test fixture bug: bottom must genuinely be sweep-eligible here')

  const next = submitServerSweepDecision(state, 'bottom', 'accept')
  assert(next !== state, 'expected the accept to actually go through (eligibility must hold)')

  const beloteDeclarations = next.declarations.filter((d: any) => d.type === 'belote' && d.seat === 'right')
  assert(beloteDeclarations.length === 1, `expected exactly 1 auto-credited belote for right, got ${beloteDeclarations.length}`)
  assert(beloteDeclarations[0].team === 'B', 'expected the auto-credited belote to belong to team B')
  assert(beloteDeclarations[0].announced === true && beloteDeclarations[0].valid === true, 'expected announced=true, valid=true (see file header note)')

  const resolution = resolveServerScoring(next)
  assert(resolution!.scoring.belotePoints.teamB === 20, `expected teamB belotePoints 20, got ${resolution!.scoring.belotePoints.teamB}`)
})

await check('[10] undeclared belot on the PARTNER (claimant\'s own team) is auto-credited', () => {
  const state = buildBeloteFixture({ beloteSeat: 'top' }) // top is bottom's partner (team A)
  const next = submitServerSweepDecision(state, 'bottom', 'accept')
  assert(next !== state, 'expected the accept to actually go through')

  const beloteDeclarations = next.declarations.filter((d: any) => d.type === 'belote' && d.seat === 'top')
  assert(beloteDeclarations.length === 1, `expected exactly 1 auto-credited belote for top, got ${beloteDeclarations.length}`)
  assert(beloteDeclarations[0].team === 'A', 'expected the auto-credited belote to belong to team A')

  const resolution = resolveServerScoring(next)
  assert(resolution!.scoring.belotePoints.teamA === 20, `expected teamA belotePoints 20, got ${resolution!.scoring.belotePoints.teamA}`)
})

await check('[11] an already-declared belot is NOT duplicated', () => {
  const beloteSeat: Seat = 'right'
  const beloteSuit: Suit = 'clubs'
  const hand = [card(beloteSuit, 'Q'), card(beloteSuit, 'K')]
  const authoritative = detectServerDeclarationsInHand(hand, { contract: 'all-trumps', trumpSuit: null })
  const beloteCandidate = authoritative.find((c: any) => c.type === 'belote')!
  assert(!!beloteCandidate, 'test fixture bug: expected the authoritative detector to find the belote candidate')

  const state = buildBeloteFixture({
    beloteSeat,
    beloteSuit,
    existingDeclarations: [
      {
        key: beloteCandidate.key,
        seat: beloteSeat,
        team: 'B',
        type: 'belote',
        publicLabel: 'Белот',
        points: 20,
        cards: beloteCandidate.privateMetadata.cards,
        cardIds: beloteCandidate.cardIds,
        suit: beloteSuit,
        highRank: 'K',
        declaredAtTrickIndex: 2,
        announced: true,
        valid: true,
      },
    ],
  })

  const next = submitServerSweepDecision(state, 'bottom', 'accept')
  assert(next !== state, 'expected the accept to actually go through')

  const matchingDeclarations = next.declarations.filter((d: any) => d.key === beloteCandidate.key)
  assert(matchingDeclarations.length === 1, `expected exactly 1 declaration for the already-declared key, got ${matchingDeclarations.length}`)
})

await check('[12] a foreign team\'s belot is credited even when the claimant holds NO cards of that suit at all', () => {
  const state = buildBeloteFixture({ beloteSeat: 'right', beloteSuit: 'clubs' })
  // Explicit assertion of the scenario's premise: the claimant's remaining
  // hand contains zero cards of the belote suit (clubs).
  assert(
    state.hands.bottom.every((c: Card) => c.suit !== 'clubs'),
    'test fixture bug: claimant must hold zero cards of the belote suit',
  )

  const next = submitServerSweepDecision(state, 'bottom', 'accept')
  assert(next !== state, 'expected the accept to actually go through despite the claimant holding none of that suit')

  const beloteDeclarations = next.declarations.filter((d: any) => d.type === 'belote' && d.seat === 'right')
  assert(beloteDeclarations.length === 1, 'expected the foreign belote to still be credited')
  const resolution = resolveServerScoring(next)
  assert(resolution!.scoring.belotePoints.teamB === 20, 'expected teamB belotePoints 20 regardless of claimant suit composition')
})

// ---- [13] duplicate accept request (double-click) ----

await check('[13] a duplicate accept request after the sweep already resolved is a no-op', () => {
  const state = buildEligibleAcceptFixture({ completedTricksBefore: 5 })
  const firstAccept = submitServerSweepDecision(state, 'bottom', 'accept')
  assert(firstAccept !== state, 'expected the first accept to succeed')

  const secondAccept = submitServerSweepDecision(firstAccept, 'bottom', 'accept')
  assert(secondAccept === firstAccept, 'expected the second accept to be a pure no-op (sweepOffer is already null)')
  assert(
    secondAccept.playing.completedTricks.length === firstAccept.playing.completedTricks.length,
    'completedTricks length must be unchanged between the two post-accept states',
  )
  assert(secondAccept.declarations === firstAccept.declarations, 'declarations reference must be unchanged')
})

// ---- [14] snapshot gating: sweepOffer is seat-gated, sweepResolution is not ----

await check('[14] createPlayingSnapshot: sweepOffer is seat-gated like canSubmitBid; sweepResolution is not gated', () => {
  const offerState = buildEligibleAcceptFixture({ completedTricksBefore: 5 })

  const snapshotForOfferedSeat = createPlayingSnapshot(offerState, 'bottom')
  assert(snapshotForOfferedSeat !== null, 'expected a playing snapshot')
  assert(snapshotForOfferedSeat!.sweepOffer !== null, 'the offered seat must see the sweepOffer')
  assert(snapshotForOfferedSeat!.sweepOffer!.seat === 'bottom', 'sweepOffer.seat must be the offered seat')

  for (const otherSeat of ['right', 'top', 'left'] as Seat[]) {
    const snapshotForOtherSeat = createPlayingSnapshot(offerState, otherSeat)
    assert(
      snapshotForOtherSeat!.sweepOffer === null,
      `seat=${otherSeat} must NOT see a sweepOffer that belongs to a different seat`,
    )
  }

  const resolvedState = submitServerSweepDecision(offerState, 'bottom', 'accept')
  for (const seat of SEATS) {
    const snapshot = createPlayingSnapshot(resolvedState, seat)
    assert(snapshot !== null, `expected a playing snapshot for seat=${seat}`)
    assert(
      snapshot!.sweepResolution !== null,
      `seat=${seat} must see sweepResolution unconditionally (not seat-gated)`,
    )
    assert(snapshot!.sweepResolution!.winnerSeat === 'bottom', 'sweepResolution.winnerSeat must be consistent across all seats')
  }

  // Also verify a null yourSeat (not yet attached to a seat) is handled safely.
  const snapshotForNoSeat = createPlayingSnapshot(offerState, null)
  assert(snapshotForNoSeat!.sweepOffer === null, 'a null yourSeat must never see a sweepOffer')
})

// ---- [15] normal trick flow regression ----

await check('[15a] a normal (non-sweep-eligible) trick win proceeds exactly as before — no sweepOffer appears', () => {
  // bottom leads hearts7(0); right hearts9(2); top heartsQ(4); left heartsK(5)
  // -> left wins. left's remaining hand [clubs10, clubsJ] IS beatable: right
  // still holds clubsA, which beats either of left's cards on whichever
  // trick is led first (right is void of clubs only AFTER using clubsA).
  const plays = [
    { seat: 'bottom' as Seat, card: card('hearts', '7') },
    { seat: 'right' as Seat, card: card('hearts', '9') },
    { seat: 'top' as Seat, card: card('hearts', 'Q') },
  ]
  const hands: Record<Seat, Card[]> = {
    bottom: [card('diamonds', '7'), card('diamonds', '8')],
    right: [card('clubs', 'A'), card('diamonds', '9')],
    top: [card('diamonds', 'Q'), card('diamonds', 'K')],
    left: [card('hearts', 'K'), card('clubs', '10'), card('clubs', 'J')],
  }

  const state = baseState({
    hands,
    contract: 'no-trumps',
    completedTricks: Array.from({ length: 6 }, (_, i) => fillerTrick(i, 'bottom')),
    currentTrick: { leaderSeat: 'bottom', currentSeat: 'left', plays, winnerSeat: null, trickIndex: 6 },
    currentTurnSeat: 'left',
  })

  const next = submitServerPlayCard(state, 'left', 'hearts-K')
  assert(next.playing.lastCompletedTrickWinnerSeat === 'left', `expected left to win the trick, got ${next.playing.lastCompletedTrickWinnerSeat}`)
  assert(next.playing.sweepOffer === null, 'expected no sweepOffer since left\'s remaining hand is beatable')
  assert(next.playing.currentTurnSeat === 'left', 'expected normal currentTurnSeat=winnerSeat progression')
  assert(next.timer.activeSeat === 'left', 'expected a normal playing timer for the winner')
})

await check('[15b] a sweep-eligible winner who already declined this round is never re-offered', () => {
  const hands: Record<Seat, Card[]> = {
    bottom: [card('clubs', 'J'), card('clubs', '9'), card('clubs', 'A')],
    right: [card('diamonds', '7'), card('diamonds', '8'), card('diamonds', 'Q')],
    top: [card('hearts', '7'), card('hearts', '8'), card('hearts', 'Q')],
    left: [card('spades', '7'), card('spades', '8'), card('spades', 'K')],
  }
  const plays = [
    { seat: 'bottom' as Seat, card: card('clubs', '10', '-lead') },
    { seat: 'right' as Seat, card: card('diamonds', '9', '-lead') },
    { seat: 'top' as Seat, card: card('hearts', '9', '-lead') },
  ]
  // bottom still holds clubs J/9/A (sweep-eligible if offered) but has
  // ALREADY declined once this round.
  const state = baseState({
    hands,
    contract: 'suit',
    trumpSuit: 'clubs',
    completedTricks: Array.from({ length: 4 }, (_, i) => fillerTrick(i, 'bottom')),
    currentTrick: { leaderSeat: 'bottom', currentSeat: 'left', plays, winnerSeat: null, trickIndex: 4 },
    currentTurnSeat: 'left',
    declinedSweepSeats: ['bottom'],
  })

  const next = submitServerPlayCard(state, 'left', 'spades-K')
  assert(next.playing.lastCompletedTrickWinnerSeat === 'bottom', `expected bottom (trump) to win the trick, got ${next.playing.lastCompletedTrickWinnerSeat}`)
  assert(next.playing.sweepOffer === null, 'expected NO sweepOffer: bottom already declined this round')
  assert(next.playing.currentTurnSeat === 'bottom', 'expected normal progression since the sweep offer is suppressed')
})

// ---- [16] minimum remaining cards ----

await check('[16a] 2 remaining cards + unbeatable hand -> sweepOffer is created', () => {
  // trick index 5 (6th trick): after it every seat holds 2 cards. bottom wins
  // with trump and keeps clubs J+9; nobody else holds a club.
  const hands: Record<Seat, Card[]> = {
    bottom: [card('clubs', 'J'), card('clubs', '9')],
    right: [card('diamonds', '7'), card('diamonds', '8')],
    top: [card('hearts', '7'), card('hearts', '8')],
    left: [card('spades', '7'), card('spades', '8'), card('spades', 'K')],
  }
  const plays = [
    { seat: 'bottom' as Seat, card: card('clubs', '10', '-lead') },
    { seat: 'right' as Seat, card: card('diamonds', '9', '-lead') },
    { seat: 'top' as Seat, card: card('hearts', '9', '-lead') },
  ]
  const state = baseState({
    hands,
    contract: 'suit',
    trumpSuit: 'clubs',
    completedTricks: Array.from({ length: 5 }, (_, i) => fillerTrick(i, 'bottom')),
    currentTrick: { leaderSeat: 'bottom', currentSeat: 'left', plays, winnerSeat: null, trickIndex: 5 },
    currentTurnSeat: 'left',
  })

  const next = submitServerPlayCard(state, 'left', 'spades-K')
  assert(next.playing.lastCompletedTrickWinnerSeat === 'bottom', `expected bottom to win the trick, got ${next.playing.lastCompletedTrickWinnerSeat}`)
  assert(next.hands.bottom.length === 2, `expected 2 remaining cards, got ${next.hands.bottom.length}`)
  assert(next.playing.sweepOffer !== null && next.playing.sweepOffer.seat === 'bottom', 'expected a sweepOffer for bottom')
  assert(next.playing.currentTurnSeat === null, 'expected play to pause for the sweep offer')
})

await check('[16b] 1 remaining card + otherwise valid sweep -> NO sweepOffer', () => {
  // trick index 6 (7th trick): after it every seat holds 1 card. bottom wins
  // with trump and keeps the unbeatable clubs J — all other conditions hold,
  // but a single last trick is never offered.
  const hands: Record<Seat, Card[]> = {
    bottom: [card('clubs', 'J')],
    right: [card('diamonds', '7')],
    top: [card('hearts', '7')],
    left: [card('spades', '7'), card('spades', 'K')],
  }
  const plays = [
    { seat: 'bottom' as Seat, card: card('clubs', '10', '-lead') },
    { seat: 'right' as Seat, card: card('diamonds', '9', '-lead') },
    { seat: 'top' as Seat, card: card('hearts', '9', '-lead') },
  ]
  const state = baseState({
    hands,
    contract: 'suit',
    trumpSuit: 'clubs',
    completedTricks: Array.from({ length: 6 }, (_, i) => fillerTrick(i, 'bottom')),
    currentTrick: { leaderSeat: 'bottom', currentSeat: 'left', plays, winnerSeat: null, trickIndex: 6 },
    currentTurnSeat: 'left',
  })

  const next = submitServerPlayCard(state, 'left', 'spades-K')
  assert(next.playing.lastCompletedTrickWinnerSeat === 'bottom', `expected bottom to win the trick, got ${next.playing.lastCompletedTrickWinnerSeat}`)
  assert(next.hands.bottom.length === 1, `expected 1 remaining card, got ${next.hands.bottom.length}`)
  assert(next.playing.sweepOffer === null, 'expected NO sweepOffer with only 1 remaining card')
  assert(next.playing.currentTurnSeat === 'bottom', 'expected normal progression to the last trick')
  assert(next.timer.activeSeat === 'bottom', 'expected a normal playing timer for the winner')
})

await check('[16c] computeServerSweepEligibility: unbeatable single card -> false', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('clubs', 'J')],
      right: [card('diamonds', '7')],
      top: [card('hearts', '7')],
      left: [card('spades', '7')],
    },
    winningBid: { seat: 'bottom', contract: 'suit', trumpSuit: 'clubs', doubled: false, redoubled: false },
  })
  assert(eligible === false, 'expected a single remaining card to never be sweep-eligible')
})

// ---- [17] the sweep is PERSONAL: the partner never helps ----

const HEARTS_TRUMP_BID = { seat: 'bottom', contract: 'suit', trumpSuit: 'hearts', doubled: false, redoubled: false } as const
const NO_TRUMPS_BID = { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false } as const

await check('[17a] real bug: trump hearts, claimant 10♥+7♥, partner K♥+J♦ -> NOT eligible', () => {
  // Opponents hold no hearts, so the team takes both tricks either way, and
  // the old solver found "lead 10♥ (partner forced to drop K♥), then 7♥ is
  // master". But led 7♥, the partner's K♥ wins — the claimant cannot take
  // the rest personally.
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('hearts', '10'), card('hearts', '7')],
      right: [card('clubs', '8'), card('clubs', '9')],
      top: [card('hearts', 'K'), card('diamonds', 'J')],
      left: [card('spades', 'Q'), card('diamonds', 'A')],
    },
    winningBid: HEARTS_TRUMP_BID,
  })
  assert(eligible === false, 'expected NOT eligible: partner K♥ beats claimant 7♥')
})

await check('[17b] real bug via trick completion: no sweepOffer for 10♥+7♥ vs partner K♥', () => {
  const hands: Record<Seat, Card[]> = {
    bottom: [card('hearts', '10'), card('hearts', '7')],
    right: [card('clubs', '8'), card('clubs', '9')],
    top: [card('hearts', 'K'), card('diamonds', 'J')],
    left: [card('spades', 'Q'), card('diamonds', 'A'), card('spades', '7')],
  }
  const plays = [
    { seat: 'bottom' as Seat, card: card('hearts', 'J', '-lead') },
    { seat: 'right' as Seat, card: card('clubs', '7', '-lead') },
    { seat: 'top' as Seat, card: card('hearts', '8', '-lead') },
  ]
  const state = baseState({
    hands,
    contract: 'suit',
    trumpSuit: 'hearts',
    completedTricks: Array.from({ length: 5 }, (_, i) => fillerTrick(i, 'bottom')),
    currentTrick: { leaderSeat: 'bottom', currentSeat: 'left', plays, winnerSeat: null, trickIndex: 5 },
    currentTurnSeat: 'left',
  })

  const next = submitServerPlayCard(state, 'left', 'spades-7')
  assert(next.playing.lastCompletedTrickWinnerSeat === 'bottom', `expected bottom to win the trick, got ${next.playing.lastCompletedTrickWinnerSeat}`)
  assert(next.hands.bottom.length === 2, `expected 2 remaining cards, got ${next.hands.bottom.length}`)
  assert(next.playing.sweepOffer === null, 'expected NO sweepOffer')
  assert(next.playing.currentTurnSeat === 'bottom', 'expected normal progression')
})

await check('[17c] control: claimant personally wins every trick (partner holds only a lower trump) -> eligible', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('hearts', 'J'), card('hearts', '9')],
      right: [card('clubs', '8'), card('clubs', '9')],
      top: [card('hearts', '7'), card('diamonds', '8')],
      left: [card('spades', 'Q'), card('diamonds', 'A')],
    },
    winningBid: HEARTS_TRUMP_BID,
  })
  assert(eligible === true, 'expected eligible: J♥/9♥ beat everything incl. the partner 7♥')
})

await check('[17d] control: a remaining trick is necessarily won by the partner -> NOT eligible', () => {
  // no-trumps: partner holds K♠+Q♠ — whatever order, one of them beats 7♠.
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('spades', 'A'), card('spades', '7')],
      right: [card('clubs', '8'), card('clubs', '9')],
      top: [card('spades', 'K'), card('spades', 'Q')],
      left: [card('diamonds', '7'), card('diamonds', '8')],
    },
    winningBid: NO_TRUMPS_BID,
  })
  assert(eligible === false, 'expected NOT eligible: the partner wins a trick')
})

await check('[17e] control: all tricks sure for the TEAM but not personally -> NOT eligible', () => {
  // no-trumps: opponents are void in spades. Leading A♠ forces the partner's
  // singleton 8♠ out (old solver: eligible), but led 7♠ the partner's 8♠ wins.
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('spades', 'A'), card('spades', '7')],
      right: [card('clubs', '8'), card('clubs', '9')],
      top: [card('spades', '8'), card('diamonds', '9')],
      left: [card('diamonds', '7'), card('diamonds', '8')],
    },
    winningBid: NO_TRUMPS_BID,
  })
  assert(eligible === false, 'expected NOT eligible: only the team, not the claimant, takes everything')
})

await check('[17f] revised: drawing out an OPPONENT card with a higher own card first does NOT rescue eligibility -> NOT eligible', () => {
  // Business rule revision: the personal-win invariant is now deliberately
  // order-insensitive for ALL three other seats, not just the partner.
  // no-trumps (A > 10 > K): led K♠ first, it loses to the opponent's 10♠ —
  // that alone is enough to disqualify, even though leading A♠ first would
  // have drawn the 10♠ out and made K♠ safe. See [18] below for the full
  // opponent-symmetry suite.
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('spades', 'A'), card('spades', 'K')],
      right: [card('spades', '10'), card('clubs', '7')],
      top: [card('diamonds', '7'), card('diamonds', '8')],
      left: [card('clubs', '8'), card('clubs', '9')],
    },
    winningBid: NO_TRUMPS_BID,
  })
  assert(eligible === false, 'expected NOT eligible: opponent 10♠ can legally beat K♠ if led first, regardless of order')
})

// ---- [18] opponent symmetry: the SAME order-insensitive "any lead, any
// other seat" invariant that already protects the partner must now also
// protect against BOTH opponents, symmetrically. ----

await check('[18a] LEFT opponent can legally take a remaining trick -> NOT eligible', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('spades', 'A'), card('spades', '7')],
      right: [card('clubs', '7'), card('clubs', '8')],
      top: [card('diamonds', '7'), card('diamonds', '8')],
      left: [card('spades', 'K'), card('spades', 'Q')],
    },
    winningBid: NO_TRUMPS_BID,
  })
  assert(eligible === false, 'expected NOT eligible: left opponent K♠/Q♠ beats the claimant 7♠')
})

await check('[18b] RIGHT opponent can legally take a remaining trick -> NOT eligible (symmetric to 18a)', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('spades', 'A'), card('spades', '7')],
      right: [card('spades', 'K'), card('spades', 'Q')],
      top: [card('clubs', '7'), card('clubs', '8')],
      left: [card('diamonds', '7'), card('diamonds', '8')],
    },
    winningBid: NO_TRUMPS_BID,
  })
  assert(eligible === false, 'expected NOT eligible: right opponent K♠/Q♠ beats the claimant 7♠')
})

await check('[18c] opponent holds a stronger trump in a suit contract -> NOT eligible', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('hearts', '9'), card('hearts', '7')],
      right: [card('hearts', 'J'), card('clubs', '8')],
      top: [card('clubs', '9'), card('clubs', '10')],
      left: [card('diamonds', '7'), card('diamonds', '8')],
    },
    winningBid: HEARTS_TRUMP_BID,
  })
  assert(eligible === false, 'expected NOT eligible: opponent J♥ (highest trump) legally beats both claimant hearts')
})

await check('[18d] opponent\'s nominally-higher card in a DIFFERENT suit cannot legally contest -> eligible', () => {
  // Opponents are void of spades, so a heart/other-suit card they hold —
  // however high its rank — can never legally win a spades trick. This
  // alone must not block the sweep.
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('spades', 'A'), card('spades', 'K')],
      right: [card('hearts', 'J'), card('clubs', '8')],
      top: [card('clubs', '7'), card('clubs', '9')],
      left: [card('diamonds', '7'), card('diamonds', '8')],
    },
    winningBid: NO_TRUMPS_BID,
  })
  assert(eligible === true, 'expected eligible: opponent\'s hearts J is irrelevant to a spades trick, no legal threat exists')
})

await check('[18e] seat symmetry: claimant=right, opponent=top threat -> NOT eligible', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'right',
    hands: {
      right: [card('spades', 'A'), card('spades', '7')],
      top: [card('spades', 'K'), card('spades', 'Q')],
      left: [card('clubs', '7'), card('clubs', '8')],
      bottom: [card('diamonds', '7'), card('diamonds', '8')],
    },
    winningBid: NO_TRUMPS_BID,
  })
  assert(eligible === false, 'expected NOT eligible: seat-symmetric opponent threat (claimant=right, opponent=top)')
})

await check('[18f] seat symmetry: claimant=left, opponent=bottom threat -> NOT eligible', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'left',
    hands: {
      left: [card('spades', 'A'), card('spades', '7')],
      bottom: [card('spades', 'K'), card('spades', 'Q')],
      right: [card('clubs', '7'), card('clubs', '8')],
      top: [card('diamonds', '7'), card('diamonds', '8')],
    },
    winningBid: NO_TRUMPS_BID,
  })
  assert(eligible === false, 'expected NOT eligible: seat-symmetric opponent threat (claimant=left, opponent=bottom)')
})

await check('[18g] positive control: no other seat has any legal way to win any remaining trick -> eligible', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('hearts', 'J'), card('hearts', '9')],
      right: [card('clubs', '7'), card('clubs', '8')],
      top: [card('diamonds', '7'), card('diamonds', '8')],
      left: [card('spades', '7'), card('spades', '8')],
    },
    winningBid: HEARTS_TRUMP_BID,
  })
  assert(eligible === true, 'expected eligible: claimant holds the two highest trumps, nobody can ever legally beat them')
})

// ---- [19] ALL_TRUMPS ranking: J > 9 > A > 10 > K > Q > 8 > 7 ----

const ALL_TRUMPS_BID = { seat: 'bottom', contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false } as const

await check('[19a] all-trumps ranking: opponent\'s 9 (rank-power 6) legally beats claimant\'s 10 and A (rank-power 4/5) -> NOT eligible', () => {
  // This pins down that the ALL_TRUMPS table (J=7,9=6,A=5,10=4,K=3,Q=2,8=1,7=0)
  // is actually used here, not accidentally the NO_TRUMPS table (where 9
  // would be one of the weakest ranks) — if the wrong table were used, this
  // opponent 9 would be seen as harmless and eligibility would wrongly flip
  // to true.
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('hearts', '10'), card('hearts', 'A')],
      right: [card('hearts', '9'), card('clubs', '8')],
      top: [card('clubs', '7'), card('clubs', '9')],
      left: [card('diamonds', '7'), card('diamonds', '8')],
    },
    winningBid: ALL_TRUMPS_BID,
  })
  assert(eligible === false, 'expected NOT eligible: opponent\'s 9 outranks both claimant hearts under all-trumps ranking')
})

await check('[19b] all-trumps ranking positive control: claimant\'s J+9 (the two top ranks) beat an opponent\'s lone A -> eligible', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('hearts', 'J'), card('hearts', '9')],
      right: [card('hearts', 'A'), card('clubs', '8')],
      top: [card('clubs', '7'), card('clubs', '10')],
      left: [card('diamonds', '7'), card('diamonds', '8')],
    },
    winningBid: ALL_TRUMPS_BID,
  })
  assert(eligible === true, 'expected eligible: J and 9 are the two highest all-trumps ranks, opponent\'s A cannot beat either')
})

// ---- [20] NO_TRUMPS ranking: A > 10 > K > Q > J > 9 > 8 > 7 ----

await check('[20a] no-trumps ranking: opponent\'s Q legally beats claimant\'s J (J is LOW under no-trumps, unlike all-trumps) -> NOT eligible', () => {
  // This is the inverse pin of [19]: under ALL_TRUMPS, J is the single
  // highest rank; under NO_TRUMPS it is 4th-from-top (A>10>K>Q>J>9>8>7), so
  // an opponent's Q legitimately beats it. If the code accidentally reused
  // the ALL_TRUMPS table here, J would wrongly look unbeatable.
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('hearts', 'A'), card('hearts', 'J')],
      right: [card('hearts', 'Q'), card('clubs', '8')],
      top: [card('clubs', '7'), card('clubs', '9')],
      left: [card('diamonds', '7'), card('diamonds', '8')],
    },
    winningBid: NO_TRUMPS_BID,
  })
  assert(eligible === false, 'expected NOT eligible: opponent\'s Q outranks claimant\'s J under no-trumps ranking')
})

// ---- [21] SUIT CONTRACT: a harmless off-suit, non-trump card must NOT block ----

await check('[21] suit contract: opponent\'s off-suit, non-trump card cannot legally contest a different led suit -> eligible', () => {
  // Complements [2] (where an opponent DOES hold trump and legally cuts).
  // Here nobody besides bottom holds any hearts (trump) at all, so a
  // nominally-high off-suit card (diamonds J) held by an opponent can never
  // legally win a spades trick — follow-suit/trump rules only let lead-suit
  // or trump cards win.
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('spades', 'A'), card('spades', 'K')],
      right: [card('diamonds', 'J'), card('clubs', '8')],
      top: [card('clubs', '7'), card('clubs', '9')],
      left: [card('diamonds', '7'), card('diamonds', '8')],
    },
    winningBid: HEARTS_TRUMP_BID,
  })
  assert(eligible === true, 'expected eligible: no other seat holds trump or the led suit, an off-suit card can never legally win')
})

// ============================================================================
// ---- [22] SEQUENTIAL UNIVERSAL algorithm regression — production incident
// room 229cf8fc-a259-4bf7-9771-6e6c2e5843b6, round 1. The single-level "flat"
// check (shipped in 0366126) let a responder's ONE matching-suit card be
// counted as a "blocker" against BOTH of the claimant's same-suit remaining
// cards independently — but sequentially that one card can only ever be
// played once, exposing a hidden trump on the second real trick. ----
// ============================================================================

const DIAMONDS_TRUMP_BID = { seat: 'right', contract: 'suit', trumpSuit: 'diamonds', doubled: false, redoubled: false } as const

await check('[22A] EXACT production fixture (room 229cf8fc round 1) -> NOT eligible', () => {
  // right leads clubs-10 then clubs-A (or the reverse): bottom follows suit
  // with its one club on trick 1, then is void and forced to cut with
  // diamonds-Q on trick 2.
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'right',
    hands: {
      right: [card('clubs', '10'), card('clubs', 'A')],
      bottom: [card('diamonds', 'Q'), card('clubs', '7')],
      top: [card('clubs', '8'), card('spades', '7')],
      left: [card('clubs', '9'), card('hearts', '7')],
    },
    winningBid: DIAMONDS_TRUMP_BID,
  })
  assert(eligible === false, 'expected NOT eligible: bottom cuts with diamonds-Q on the second trick once void of clubs')
})

await check('[22B] same fixture WITHOUT the trump threat (bottom holds no diamonds at all) -> eligible', () => {
  // Identical shape to [22A] — bottom still has exactly one club and one
  // "spare" card — except the spare is a harmless off-suit, non-trump card
  // instead of diamonds-Q. Isolates that it really was the trump specifically
  // causing the NOT-eligible verdict in [22A], not the mere fact of having 2 cards.
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'right',
    hands: {
      right: [card('clubs', '10'), card('clubs', 'A')],
      bottom: [card('clubs', '7'), card('hearts', '7')],
      top: [card('clubs', '8'), card('spades', '7')],
      left: [card('clubs', '9'), card('hearts', '8')],
    },
    winningBid: DIAMONDS_TRUMP_BID,
  })
  assert(eligible === true, 'expected eligible: nobody holds trump, both club leads are genuinely safe sequentially')
})

await check('[22C] minimal isolation: claimant leads one suit twice, a single responder holds exactly ONE card of that suit + trump -> NOT eligible', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('clubs', '10'), card('clubs', 'A')],
      top: [card('clubs', '7'), card('hearts', '7')], // one club (safe to follow once) + the only trump
      right: [card('diamonds', '7'), card('diamonds', '8')], // harmless, void of clubs and trump
      left: [card('spades', '7'), card('spades', '8')], // harmless, void of clubs and trump
    },
    winningBid: HEARTS_TRUMP_BID,
  })
  assert(eligible === false, 'expected NOT eligible: top is void of clubs after trick 1 and legally cuts trick 2 with the trump')
})

await check('[22D] same setup but the responder holds TWO cards of the claimant\'s suit (never needs to cut) -> eligible', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('clubs', '10'), card('clubs', 'A')],
      top: [card('clubs', '7'), card('clubs', '8')], // TWO clubs, zero trump — can follow suit both times, never forced to cut
      right: [card('diamonds', '7'), card('diamonds', '8')],
      left: [card('spades', '7'), card('spades', '8')],
    },
    winningBid: HEARTS_TRUMP_BID,
  })
  assert(eligible === true, 'expected eligible: top can always follow suit with its two clubs, both claimant leads stay safe sequentially')
})

// ---- [22E] seat symmetry: the SAME depletion-then-cut pattern at partner, LEFT opponent, RIGHT opponent ----

await check('[22E-partner] depletion-then-cut threat sits with the PARTNER (top, for sweepSeat=bottom) -> NOT eligible', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('clubs', '10'), card('clubs', 'A')],
      top: [card('clubs', '7'), card('hearts', '7')], // bottom's partner
      right: [card('diamonds', '7'), card('diamonds', '8')],
      left: [card('spades', '7'), card('spades', '8')],
    },
    winningBid: HEARTS_TRUMP_BID,
  })
  assert(eligible === false, 'expected NOT eligible: partner cuts trick 2 once void of clubs')
})

await check('[22E-left] depletion-then-cut threat sits with LEFT (bottom\'s opponent, team B) -> NOT eligible', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('clubs', '10'), card('clubs', 'A')],
      left: [card('clubs', '7'), card('hearts', '7')], // bottom's opponent
      right: [card('diamonds', '7'), card('diamonds', '8')],
      top: [card('spades', '7'), card('spades', '8')],
    },
    winningBid: HEARTS_TRUMP_BID,
  })
  assert(eligible === false, 'expected NOT eligible: left opponent cuts trick 2 once void of clubs')
})

await check('[22E-right] depletion-then-cut threat sits with RIGHT (bottom\'s opponent, team B) -> NOT eligible', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('clubs', '10'), card('clubs', 'A')],
      right: [card('clubs', '7'), card('hearts', '7')], // bottom's opponent
      top: [card('diamonds', '7'), card('diamonds', '8')],
      left: [card('spades', '7'), card('spades', '8')],
    },
    winningBid: HEARTS_TRUMP_BID,
  })
  assert(eligible === false, 'expected NOT eligible: right opponent cuts trick 2 once void of clubs')
})

// ---- [22F] ALL_TRUMPS / NO_TRUMPS: sequential (depth-2) ranking must stay correct ----
// Note: neither all-trumps nor no-trumps has a "void of led suit -> may cut
// with trump" escape at all (off-suit cards can NEVER win in either contract
// — see getValidCardsInAllTrumpsContract and the inline no-trumps branch of
// getServerValidPlayCards) — so the depletion-then-CUT mechanism in [22A-E]
// is structurally specific to suit contracts. These two tests instead confirm
// the ranking table is still applied correctly at BOTH recursion depths (not
// just the first trick) under the new sequential search.

await check('[22F-all-trumps] a responder holding both remaining same-suit cards, one of which outranks EITHER claimant lead -> NOT eligible', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('hearts', 'A'), card('hearts', 'K')], // all-trumps power 5, 3
      right: [card('hearts', '9'), card('hearts', 'J')], // power 6, 7 — forced to overtrump on whichever is led
      top: [card('clubs', '7'), card('clubs', '8')],
      left: [card('diamonds', '7'), card('diamonds', '8')],
    },
    winningBid: ALL_TRUMPS_BID,
  })
  assert(eligible === false, 'expected NOT eligible: opponent\'s 9/J both outrank claimant\'s A/K under all-trumps ranking, for either lead order')
})

await check('[22F-no-trumps] a responder holding both remaining same-suit cards, one of which outranks EITHER claimant lead -> NOT eligible', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('hearts', 'Q'), card('hearts', 'J')], // no-trumps power 4, 3
      right: [card('hearts', 'K'), card('hearts', '10')], // power 5, 6 — both outrank Q and J
      top: [card('clubs', '7'), card('clubs', '8')],
      left: [card('diamonds', '7'), card('diamonds', '8')],
    },
    winningBid: NO_TRUMPS_BID,
  })
  assert(eligible === false, 'expected NOT eligible: opponent\'s K/10 both outrank claimant\'s Q/J under no-trumps ranking, for either lead order')
})

// ---- [22G] no-draw-out regression: ONE specific lead order would let the
// claimant draw out the only dangerous card and then sweep everything — the
// UNIVERSAL (not existential) quantifier over the claimant's own lead choice
// must still reject this, because it is not safe for the OTHER lead order too ----

await check('[22G] a lead order exists that would draw out the only threat and win everything, but the reverse order loses -> NOT eligible', () => {
  // no-trumps (A > 10 > K): leading A first draws out the opponent's
  // singleton 10, making K safe afterward — but leading K FIRST loses to that
  // same 10 directly. The new universal-over-leads invariant must reject this
  // regardless, because it must hold no matter which card gets led first.
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('spades', 'A'), card('spades', 'K')],
      right: [card('spades', '10'), card('clubs', '7')],
      top: [card('diamonds', '7'), card('diamonds', '8')],
      left: [card('clubs', '8'), card('clubs', '9')],
    },
    winningBid: NO_TRUMPS_BID,
  })
  assert(eligible === false, 'expected NOT eligible: leading K first loses to opponent\'s 10 directly — draw-out via A-first does not rescue it')
})

// ---- [22H] minimum 2 remaining cards — unchanged ----

await check('[22H] 1 remaining card -> NOT eligible regardless of how safe it looks (offer requires >= 2)', () => {
  const eligible = computeServerSweepEligibility({
    sweepSeat: 'bottom',
    hands: {
      bottom: [card('hearts', 'J')], // the single highest possible card — would be trivially unbeatable
      right: [card('clubs', '7')],
      top: [card('diamonds', '7')],
      left: [card('spades', '7')],
    },
    winningBid: HEARTS_TRUMP_BID,
  })
  assert(eligible === false, 'expected NOT eligible: fewer than MIN_SWEEP_REMAINING_CARDS=2 remaining cards never offers a sweep')
})

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
