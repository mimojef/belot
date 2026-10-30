/**
 * checkBelotTieCarryOverAccumulation.ts
 *
 * Висящи точки при поредни равни игри (serverScoring.ts buildOfficialRoundScore),
 * през реалния startServerScoringPhase:
 *  [1] една равна игра + решено раздаване — висящите отиват при победителя
 *      (както собственикът, така и противникът му) и се зануляват
 *  [2] две поредни равни игри с различни изпълнители — натрупване, без
 *      преждевременно присъждане на защитниците (вкл. висяща контра)
 *  [3] следващото решено раздаване присъжда целия пренос точно веднъж
 *      (изкарана и „вътре“), след това преносът е 0
 *  [4] при достигнат праг мачът приключва и на равна игра (непроменено)
 *
 * Раздавания („Всичко коз“, без анонси, 8 взятки):
 *  TIE  — A 129 / B 129 сурови → 13 за защитата, 13 висящи за изпълнителя
 *  MADE — A 60 / B 198 сурови → 6 / 20
 */

import type { Seat } from '../src/core/serverTypes.js'
import type { ServerAuthoritativeGameState } from '../src/game/serverGameTypes.js'
import { startServerScoringPhase } from '../src/game/startServerScoringPhase.js'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

type Pair = { teamA: number; teamB: number }
type Card = [suit: string, rank: string]

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'] as const
const RANKS = ['J', '9', 'A', '10', 'K', 'Q', '8', '7'] as const

function trick(winnerSeat: Seat, cards: Card[]) {
  return { winnerSeat, plays: cards.map(([suit, rank]) => ({ card: { suit, rank } })) }
}

function suitCards(suit: string, ranks: readonly string[] = RANKS): Card[] {
  return ranks.map((rank) => [suit, rank] as Card)
}

function chunk(cards: Card[]): Card[][] {
  const result: Card[][] = []
  for (let index = 0; index < cards.length; index += 4) result.push(cards.slice(index, index + 4))
  return result
}

// A: всички пики (62) + J♦ J♣ 9♦ Q♦ (57) + последната взятка (10) = 129.
const TIE_TRICKS = [
  ...chunk([
    ...suitCards('hearts'),
    ...suitCards('diamonds', ['A', '10', 'K', '8', '7']),
    ...suitCards('clubs', ['9', 'A', '10', 'K', 'Q', '8', '7']),
  ]).map((cards, index) => trick(index % 2 === 0 ? 'right' : 'left', cards)),
  ...chunk(suitCards('spades')).map((cards) => trick('bottom', cards)),
  trick('top', [['diamonds', 'J'], ['clubs', 'J'], ['diamonds', '9'], ['diamonds', 'Q']]),
]

// A: J♠ 9♠ 7♠ 8♠ (34) + J♥ Q♥ Q♦ 7♥ (26) = 60; B: останалите 188 + последната (10) = 198.
const MADE_A_CARDS: Card[] = [['spades', 'J'], ['spades', '9'], ['spades', '7'], ['spades', '8'], ['hearts', 'J'], ['hearts', 'Q'], ['diamonds', 'Q'], ['hearts', '7']]
const MADE_TRICKS = [
  ...chunk(MADE_A_CARDS).map((cards) => trick('bottom', cards)),
  ...chunk(
    SUITS.flatMap((suit) => suitCards(suit)).filter(
      ([suit, rank]) => !MADE_A_CARDS.some(([s, r]) => s === suit && r === rank),
    ),
  ).map((cards, index) => trick(index % 2 === 0 ? 'right' : 'left', cards)),
]

type HandSpec = {
  tricks: typeof TIE_TRICKS
  bidderSeat: Seat
  doubled?: boolean
}

function scoreHand(
  hand: HandSpec,
  before: { match: Pair; carryOver: Pair },
): ServerAuthoritativeGameState {
  const state = {
    phase: 'playing',
    targetScore: 151,
    bidding: {
      winningBid: {
        seat: hand.bidderSeat,
        contract: 'all-trumps',
        trumpSuit: null,
        doubled: hand.doubled === true,
        redoubled: false,
      },
    },
    playing: { completedTricks: hand.tricks.map((item, trickIndex) => ({ ...item, trickIndex })) },
    declarations: [],
    scoring: null,
    matchEnded: null,
    score: { round: null, match: { ...before.match }, carryOver: { ...before.carryOver } },
  } as unknown as ServerAuthoritativeGameState

  return startServerScoringPhase(state)
}

function pair(value: Pair): string {
  return `${value.teamA}/${value.teamB}`
}

function expectPair(label: string, actual: Pair, expected: Pair): void {
  assert(
    actual.teamA === expected.teamA && actual.teamB === expected.teamB,
    `${label}: ${pair(actual)} (очаквано ${pair(expected)})`,
  )
}

const TIE_BY_A: HandSpec = { tricks: TIE_TRICKS, bidderSeat: 'bottom' }
const TIE_BY_B: HandSpec = { tricks: TIE_TRICKS, bidderSeat: 'right' }
const MADE_BY_B: HandSpec = { tricks: MADE_TRICKS, bidderSeat: 'right' }
const INSIDE_BY_A: HandSpec = { tricks: MADE_TRICKS, bidderSeat: 'bottom' }
const ZERO: Pair = { teamA: 0, teamB: 0 }

console.log('\n═══ checkBelotTieCarryOverAccumulation ═══')

check('[0] тестовите раздавания: TIE 129/129 → равна, MADE 60/198 → изкарана 6/20', () => {
  const tie = scoreHand(TIE_BY_B, { match: ZERO, carryOver: ZERO })
  expectPair('TIE сурови', tie.scoring!.rawHandPoints, { teamA: 129, teamB: 129 })
  assert(tie.scoring!.outcome === 'tie', `TIE outcome ${tie.scoring!.outcome}`)
  const made = scoreHand(MADE_BY_B, { match: ZERO, carryOver: ZERO })
  expectPair('MADE сурови', made.scoring!.rawHandPoints, { teamA: 60, teamB: 198 })
  assert(made.scoring!.outcome === 'made', `MADE outcome ${made.scoring!.outcome}`)
  expectPair('MADE точки', made.score.round.total, { teamA: 6, teamB: 20 })
})

check('[1] една равна + решено: висящите → победителя (собственик или противник), после 0', () => {
  const tieB = scoreHand(TIE_BY_B, { match: ZERO, carryOver: ZERO })
  expectPair('равна (изп. B) точки', tieB.score.round.total, { teamA: 13, teamB: 0 })
  expectPair('равна (изп. B) висящи', tieB.score.carryOver, { teamA: 0, teamB: 13 })
  const ownerWins = scoreHand(MADE_BY_B, tieB.score)
  expectPair('B изкарва, висящите на B', ownerWins.score.round.total, { teamA: 6, teamB: 33 })
  expectPair('висящи след', ownerWins.score.carryOver, ZERO)

  const tieA = scoreHand(TIE_BY_A, { match: ZERO, carryOver: ZERO })
  expectPair('равна (изп. A) висящи', tieA.score.carryOver, { teamA: 13, teamB: 0 })
  const opponentWins = scoreHand(MADE_BY_B, tieA.score)
  expectPair('B изкарва, висящите на A', opponentWins.score.round.total, { teamA: 6, teamB: 33 })
  expectPair('висящи след', opponentWins.score.carryOver, ZERO)
})

check('[2] две поредни равни с различни изпълнители: натрупване, нищо не се присъжда', () => {
  const first = scoreHand(TIE_BY_B, { match: ZERO, carryOver: ZERO })
  const second = scoreHand(TIE_BY_A, first.score)
  expectPair('втора равна — точки (само защитата B)', second.score.round.total, { teamA: 0, teamB: 13 })
  expectPair('натрупани висящи', second.score.carryOver, { teamA: 13, teamB: 13 })
  expectPair('общ резултат', second.score.match, { teamA: 13, teamB: 13 })

  const doubled = scoreHand({ ...TIE_BY_A, doubled: true }, first.score)
  expectPair('висяща контра — точки на защитата ×2', doubled.score.round.total, { teamA: 0, teamB: 26 })
  expectPair('висяща контра — натрупани', doubled.score.carryOver, { teamA: 26, teamB: 13 })
})

check('[3] следващото решено раздаване присъжда целия пренос точно веднъж', () => {
  const first = scoreHand(TIE_BY_B, { match: ZERO, carryOver: ZERO })
  const second = scoreHand(TIE_BY_A, first.score)

  const made = scoreHand(MADE_BY_B, second.score)
  expectPair('изкарана — точки', made.score.round.total, { teamA: 6, teamB: 46 })
  expectPair('изкарана — висящи след', made.score.carryOver, ZERO)
  expectPair('изкарана — общ резултат', made.score.match, { teamA: 19, teamB: 59 })
  assert(made.score.match.teamA + made.score.match.teamB === 26 * 3, 'всички 78 точки от 3 раздавания са записани веднъж')

  const next = scoreHand(MADE_BY_B, made.score)
  expectPair('следващо раздаване — без повторно присъждане', next.score.round.total, { teamA: 6, teamB: 20 })

  const inside = scoreHand(INSIDE_BY_A, second.score)
  assert(inside.scoring!.outcome === 'inside', `outcome ${inside.scoring!.outcome}`)
  expectPair('„вътре“ — точки', inside.score.round.total, { teamA: 0, teamB: 52 })
  expectPair('„вътре“ — висящи след', inside.score.carryOver, ZERO)
})

check('[4] праг достигнат на равна игра → мачът приключва (непроменено)', () => {
  const result = scoreHand(TIE_BY_B, { match: { teamA: 140, teamB: 100 }, carryOver: { teamA: 0, teamB: 13 } })
  assert(result.scoring!.outcome === 'tie', 'tie')
  assert(result.matchEnded !== null && result.matchEnded.winnerTeam === 'A', `matchEnded ${JSON.stringify(result.matchEnded)}`)
  expectPair('финален резултат', result.matchEnded!.finalScore, { teamA: 153, teamB: 100 })
  expectPair('висящи (неприсъдени)', result.score.carryOver, { teamA: 0, teamB: 26 })
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
