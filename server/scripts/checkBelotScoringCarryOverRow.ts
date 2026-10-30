/**
 * checkBelotScoringCarryOverRow.ts
 *
 * Ред „Висящи“ в скоринг таблото — целият път без браузър:
 * реален startServerScoringPhase → реален createRoomSnapshotMessage (за
 * конкретен играч) → реален renderScoringScreen (HTML в stub root).
 *  [1] нормално раздаване без пренос → редът липсва
 *  [2] равна игра, която само създава висящи → редът липсва
 *  [3] решено раздаване с присъдени 18 → „Висящи“, +18 в колоната на
 *      получателя, „—“ в другата (и от двете перспективи)
 *  [4] две поредни равни → следващото решено показва целия пренос (+26)
 *  [5] следващото обикновено раздаване → редът отново липсва
 *  [6] state отпреди полето (възстановен snapshot) → 0/0, редът липсва
 *  [7] телефонен layout → същият ред
 */

import type { Seat, ServerRoom } from '../src/core/serverTypes.js'
import type { ServerAuthoritativeGameState } from '../src/game/serverGameTypes.js'
import { startServerScoringPhase } from '../src/game/startServerScoringPhase.js'
import { createRoomSnapshotMessage } from '../src/protocol/createRoomSnapshotMessage.js'
import {
  createEmptyBiddingState,
  createEmptyHands,
  createEmptyMatchDeclarationMissionCounts,
  createEmptyPlayingState,
  createEmptyScoreBreakdown,
  createEmptyTimerState,
  createEmptyTrickState,
  createEmptyWonTricks,
} from '../src/game/createServerRoundDefaults.js'
import { renderScoringScreen } from '../../src/app/activeRoom/renderScoringPanel.js'
import type { RoomGameSnapshot } from '../../src/app/network/createGameServerClient.js'

let passed = 0
let failed = 0
let lastRenderedHtml = ''

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
const ZERO: Pair = { teamA: 0, teamB: 0 }

function trick(winnerSeat: Seat, cards: Card[]) {
  return { winnerSeat, plays: cards.map(([suit, rank]) => ({ seat: winnerSeat, card: { id: `${suit}-${rank}`, suit, rank } })) }
}

function suitCards(suit: string, ranks: readonly string[] = RANKS): Card[] {
  return ranks.map((rank) => [suit, rank] as Card)
}

function chunk(cards: Card[]): Card[][] {
  const result: Card[][] = []
  for (let index = 0; index < cards.length; index += 4) result.push(cards.slice(index, index + 4))
  return result
}

// „Всичко коз“, без анонси. TIE: A 129 / B 129. MADE: A 60 / B 198 → 6 / 20.
const TIE_TRICKS = [
  ...chunk([
    ...suitCards('hearts'),
    ...suitCards('diamonds', ['A', '10', 'K', '8', '7']),
    ...suitCards('clubs', ['9', 'A', '10', 'K', 'Q', '8', '7']),
  ]).map((cards, index) => trick(index % 2 === 0 ? 'right' : 'left', cards)),
  ...chunk(suitCards('spades')).map((cards) => trick('bottom', cards)),
  trick('top', [['diamonds', 'J'], ['clubs', 'J'], ['diamonds', '9'], ['diamonds', 'Q']]),
]
const MADE_A_CARDS: Card[] = [['spades', 'J'], ['spades', '9'], ['spades', '7'], ['spades', '8'], ['hearts', 'J'], ['hearts', 'Q'], ['diamonds', 'Q'], ['hearts', '7']]
const MADE_TRICKS = [
  ...chunk(MADE_A_CARDS).map((cards) => trick('bottom', cards)),
  ...chunk(
    SUITS.flatMap((suit) => suitCards(suit)).filter(
      ([suit, rank]) => !MADE_A_CARDS.some(([s, r]) => s === suit && r === rank),
    ),
  ).map((cards, index) => trick(index % 2 === 0 ? 'right' : 'left', cards)),
]

type Hand = { tricks: typeof TIE_TRICKS; bidderSeat: Seat }
const TIE_BY_A: Hand = { tricks: TIE_TRICKS, bidderSeat: 'bottom' }
const TIE_BY_B: Hand = { tricks: TIE_TRICKS, bidderSeat: 'right' }
const MADE_BY_B: Hand = { tricks: MADE_TRICKS, bidderSeat: 'right' }

function scoreHand(hand: Hand, before: { match: Pair; carryOver: Pair }): ServerAuthoritativeGameState {
  const winningBid = { seat: hand.bidderSeat, contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false } as const
  const state = {
    phase: 'playing',
    phaseEnteredAt: null,
    targetScore: 151,
    players: {
      bottom: { seat: 'bottom', team: 'A', mode: 'bot', controlledByBot: false },
      right: { seat: 'right', team: 'B', mode: 'bot', controlledByBot: false },
      top: { seat: 'top', team: 'A', mode: 'bot', controlledByBot: false },
      left: { seat: 'left', team: 'B', mode: 'bot', controlledByBot: false },
    },
    round: { dealerSeat: 'right', cutterSeat: null, firstBidderSeat: null, firstDealSeat: null, selectedCutIndex: null },
    deck: [],
    hands: createEmptyHands(),
    bidding: { ...createEmptyBiddingState(), hasEnded: true, winningBid },
    declarations: [],
    matchDeclarationMissionCounts: createEmptyMatchDeclarationMissionCounts(),
    currentTrick: createEmptyTrickState(),
    wonTricks: createEmptyWonTricks(),
    playing: {
      ...createEmptyPlayingState(),
      hasStarted: true,
      completedTricks: hand.tricks.map((item, trickIndex) => ({ ...item, trickIndex })),
    },
    scoring: null,
    matchEnded: null,
    score: { round: createEmptyScoreBreakdown(), match: { ...before.match }, carryOver: { ...before.carryOver } },
    timer: createEmptyTimerState(),
  } as unknown as ServerAuthoritativeGameState

  return startServerScoringPhase(state)
}

function makeRoom(authoritativeState: ServerAuthoritativeGameState): ServerRoom {
  const seat = (name: Seat) => ({
    seat: name,
    team: name === 'bottom' || name === 'top' ? 'A' : 'B',
    participant: {
      kind: 'bot',
      playerId: `bot-${name}`,
      joinedAt: 0,
      botCode: 'easy',
      difficulty: 'easy',
      identity: { accountId: null, profileId: null, username: null, displayName: `Bot ${name}`, avatarUrl: null, level: null, rankTitle: null, skillRating: null, gender: null },
    },
  })
  return {
    id: 'room-carry-over-row',
    status: 'playing',
    createdAt: 0,
    updatedAt: 0,
    hostPlayerId: null,
    config: { maxPlayers: 4, allowBots: true, isPrivate: false, joinCode: null, stakeAmount: null, targetScore: 151, turnTimeMs: 15000, reconnectGraceMs: 30000 },
    seats: { bottom: seat('bottom'), right: seat('right'), top: seat('top'), left: seat('left') },
    game: { phase: 'scoring', stateVersion: 1, startedAt: 0, updatedAt: 0, activeTimerId: null, timerDeadlineAt: null, authoritativeState },
    replayVotes: [],
    leaveVotes: [],
  } as unknown as ServerRoom
}

// Рендира таблото за играча на `viewerSeat` и връща реда „Висящи“ (или null).
function renderCarryOverRow(state: ServerAuthoritativeGameState, viewerSeat: Seat): { left: string; right: string } | null {
  const message = createRoomSnapshotMessage(makeRoom(state), viewerSeat)
  const game = message.game as unknown as RoomGameSnapshot
  const root = { innerHTML: '' } as unknown as HTMLDivElement
  renderScoringScreen({
    root,
    game,
    seats: message.seats as never,
    localSeat: viewerSeat,
    controlledSeat: viewerSeat,
    winningBid: null,
    countdownSeconds: 5,
    animateSumCounters: false,
    stageScale: 1,
    scaledStageWidth: 1600,
    scaledStageHeight: 900,
  })
  const html = root.innerHTML
  lastRenderedHtml = html
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  assert(text.includes('Сбор') && text.includes('Резултат'), 'таблото не е рендирано')
  const match = text.match(/Висящи (\S+) (\S+) /)
  if (match === null) return null
  // Редът трябва да е между „Сбор“ и „Резултат“.
  assert(text.indexOf('Сбор') < text.indexOf('Висящи') && text.indexOf('Висящи') < text.indexOf('Резултат'), 'позиция на реда')
  return { left: match[1]!, right: match[2]! }
}

function expectRow(actual: { left: string; right: string } | null, expected: { left: string; right: string } | null, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: ${JSON.stringify(actual)} (очаквано ${JSON.stringify(expected)})`,
  )
}

console.log('\n═══ checkBelotScoringCarryOverRow ═══')

check('[1] нормално раздаване без пренос → редът липсва', () => {
  const state = scoreHand(MADE_BY_B, { match: ZERO, carryOver: ZERO })
  expectRow(renderCarryOverRow(state, 'bottom'), null, 'без пренос')
})

check('[2] равна игра, създаваща висящи → редът липсва', () => {
  const state = scoreHand(TIE_BY_B, { match: ZERO, carryOver: ZERO })
  assert(state.score.carryOver.teamB === 13, 'висящите са създадени')
  expectRow(renderCarryOverRow(state, 'bottom'), null, 'равна')
})

check('[3] присъдени 18 → +18 при получателя, „—“ при другия (двете перспективи)', () => {
  for (const carryOver of [{ teamA: 0, teamB: 18 }, { teamA: 18, teamB: 0 }]) {
    const state = scoreHand(MADE_BY_B, { match: { teamA: 63, teamB: 92 }, carryOver })
    assert(state.score.round.total.teamB === 38, `резултат B ${state.score.round.total.teamB}`)
    expectRow(renderCarryOverRow(state, 'bottom'), { left: '—', right: '+18' }, `НИЕ=A, пренос ${JSON.stringify(carryOver)}`)
    expectRow(renderCarryOverRow(state, 'right'), { left: '+18', right: '—' }, `НИЕ=B, пренос ${JSON.stringify(carryOver)}`)
  }
})

check('[4] две поредни равни → следващото решено показва целия пренос', () => {
  const first = scoreHand(TIE_BY_B, { match: ZERO, carryOver: ZERO })
  expectRow(renderCarryOverRow(first, 'bottom'), null, 'първа равна')
  const second = scoreHand(TIE_BY_A, first.score)
  expectRow(renderCarryOverRow(second, 'bottom'), null, 'втора равна (натрупва)')
  const decided = scoreHand(MADE_BY_B, second.score)
  expectRow(renderCarryOverRow(decided, 'bottom'), { left: '—', right: '+26' }, 'решено')
})

check('[5] следващото обикновено раздаване → редът отново липсва', () => {
  const decided = scoreHand(MADE_BY_B, { match: ZERO, carryOver: { teamA: 0, teamB: 18 } })
  const next = scoreHand(MADE_BY_B, decided.score)
  expectRow(renderCarryOverRow(next, 'bottom'), null, 'следващо')
})

check('[6] state отпреди полето (възстановен snapshot) → редът липсва', () => {
  const state = scoreHand(MADE_BY_B, { match: ZERO, carryOver: { teamA: 0, teamB: 18 } })
  const legacy = { ...state, scoring: { ...state.scoring! } }
  delete (legacy.scoring as { awardedCarryOver?: unknown }).awardedCarryOver
  const message = createRoomSnapshotMessage(makeRoom(legacy), 'bottom')
  const scoring = (message.game as unknown as RoomGameSnapshot).scoring!
  assert(scoring.awardedCarryOver?.teamA === 0 && scoring.awardedCarryOver?.teamB === 0, 'default 0/0')
  expectRow(renderCarryOverRow(legacy, 'bottom'), null, 'legacy')
})

check('[7] телефонен layout → същият ред', () => {
  const globalScope = globalThis as unknown as { window?: unknown }
  const previousWindow = globalScope.window
  globalScope.window = { innerWidth: 340, innerHeight: 720, matchMedia: () => ({ matches: true }) }
  try {
    const state = scoreHand(MADE_BY_B, { match: ZERO, carryOver: { teamA: 0, teamB: 18 } })
    expectRow(renderCarryOverRow(state, 'bottom'), { left: '—', right: '+18' }, 'mobile')
    assert(lastRenderedHtml.includes('data-mobile-layout="1"'), 'телефонният layout не е активен')
    expectRow(renderCarryOverRow(scoreHand(MADE_BY_B, state.score), 'bottom'), null, 'mobile следващо')
  } finally {
    globalScope.window = previousWindow
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
