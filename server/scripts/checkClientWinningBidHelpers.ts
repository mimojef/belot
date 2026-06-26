/**
 * checkClientWinningBidHelpers.ts — Client helper checks за HUD форматиране и state machine.
 *
 * Тества реалните production функции от winningBidHelpers.ts (без DOM).
 * Изпълнява се с `tsx` (не е в build:scripts tsconfig).
 *
 * HUD formatter checks:
 * [0]  formatBidType: null winningBid → "Няма обява"
 * [1]  formatBidType: suit clubs → "Спатия"
 * [2]  formatBidType: suit diamonds → "Каро"
 * [3]  formatBidType: suit hearts → "Купа"
 * [4]  formatBidType: suit spades → "Пика"
 * [5]  formatBidType: all-trumps → "Всичко коз"
 * [6]  formatBidType: no-trumps → "Без коз"
 * [7]  getBidMultiplierLabel: null → ""
 * [8]  getBidMultiplierLabel: doubled → " x2"
 * [9]  getBidMultiplierLabel: redoubled → " x4"
 * [10] HUD summary string: "Купа x2: ..." съдържа правилните части
 *
 * selectWinningBidFromGame checks:
 * [11] bidding phase → взима от bidding
 * [12] playing phase → взима от playing
 * [13] scoring phase → взима от scoring
 * [14] null game → null
 * [15] cutting phase без bid → null
 *
 * computeNextLastKnownWinningBid state machine checks:
 * [16] reconnect при playing: previous=null, game с playing.winningBid → задава bid
 * [17] normal play update: previous=X, game с playing.winningBid=Y → обновява до Y
 * [18] scoring: previous=X, game с scoring.winningBid=X → запазва/обновява
 * [19] cutting phase: previous=bid, game без winningBid → изчиства до null
 * [20] deal-first-3: previous=bid, game без winningBid → изчиства до null
 * [21] deal-next-2: previous=bid, game без winningBid → изчиства до null
 * [22] bidding phase старт: previous=bid, game без winningBid в bidding → изчиства до null
 * [23] null game: previous=bid → запазва предишната стойност (не изчиства)
 * [24] playing phase с null game.playing.winningBid, previous=bid → не изчиства (playing не е pre-contract)
 */

import {
  formatBidType,
  getBidMultiplierLabel,
  selectWinningBidFromGame,
  computeNextLastKnownWinningBid,
} from '../../src/app/activeRoom/winningBidHelpers.js'
import type { RoomWinningBidSnapshot } from '../../src/app/network/createGameServerClient.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

type WB = NonNullable<RoomWinningBidSnapshot>

function wb(
  contract: WB['contract'],
  trumpSuit: WB['trumpSuit'],
  doubled = false,
  redoubled = false,
  seat: WB['seat'] = 'bottom',
): WB {
  return { seat, contract, trumpSuit, doubled, redoubled }
}

function makeGame(opts: {
  phase: string
  biddingWinningBid?: RoomWinningBidSnapshot
  playingWinningBid?: RoomWinningBidSnapshot
  scoringWinningBid?: RoomWinningBidSnapshot
}) {
  return {
    phase: opts.phase,
    authoritativePhase: opts.phase,
    timerDeadlineAt: null,
    dealerSeat: null,
    firstDealSeat: null,
    cutting: null,
    bidding: opts.biddingWinningBid !== undefined
      ? { currentBidderSeat: null, canSubmitBid: false, entries: [], winningBid: opts.biddingWinningBid, validActions: null }
      : null,
    playing: opts.playingWinningBid !== undefined
      ? { winningBid: opts.playingWinningBid, currentTurnSeat: 'bottom' as const, currentTrickPlays: [], completedTricksCount: 0, latestCompletedTrick: null, validCardIds: null }
      : null,
    scoring: opts.scoringWinningBid !== undefined
      ? { winningBid: opts.scoringWinningBid, rawHandPoints: { teamA: 0, teamB: 0 }, rawHandTricksWon: { teamA: 0, teamB: 0 }, declarationPoints: { teamA: 0, teamB: 0 }, belotePoints: { teamA: 0, teamB: 0 }, sumPoints: { teamA: 0, teamB: 0 }, officialRoundPoints: { teamA: 0, teamB: 0 }, matchTotals: { teamA: 0, teamB: 0 }, carryOver: { teamA: 0, teamB: 0 }, isCapotRound: false, isNonCapotRound: false, outcomeLabel: '', outcomeShortLabel: '', counterMultiplier: 1 }
      : null,
    matchEnded: null,
    declarations: [],
    score: { match: { teamA: 0, teamB: 0 } },
    handCounts: { bottom: 0, right: 0, top: 0, left: 0 },
    ownHand: [],
  }
}

// ── HUD formatter checks [0]-[10] ─────────────────────────────────────────────

console.log('\n[0]-[9] formatBidType и getBidMultiplierLabel')

check('[0] null → "Няма обява"', formatBidType(null) === 'Няма обява')
check('[1] suit clubs → "Спатия"', formatBidType(wb('suit', 'clubs')) === 'Спатия')
check('[2] suit diamonds → "Каро"', formatBidType(wb('suit', 'diamonds')) === 'Каро')
check('[3] suit hearts → "Купа"', formatBidType(wb('suit', 'hearts')) === 'Купа')
check('[4] suit spades → "Пика"', formatBidType(wb('suit', 'spades')) === 'Пика')
check('[5] all-trumps → "Всичко коз"', formatBidType(wb('all-trumps', null)) === 'Всичко коз')
check('[6] no-trumps → "Без коз"', formatBidType(wb('no-trumps', null)) === 'Без коз')
check('[7] null → ""', getBidMultiplierLabel(null) === '')
check('[8] doubled → " x2"', getBidMultiplierLabel(wb('suit', 'hearts', true, false)) === ' x2')
check('[9] redoubled → " x4"', getBidMultiplierLabel(wb('suit', 'hearts', true, true)) === ' x4')

console.log('\n[10] HUD summary string')
{
  const bid = wb('suit', 'hearts', true, false)
  const bidLabel = formatBidType(bid)
  const multiplier = getBidMultiplierLabel(bid)
  const summary = `${bidLabel}${multiplier}: Играч`
  check('[10] summary = "Купа x2: Играч"', summary === 'Купа x2: Играч')
}

// ── selectWinningBidFromGame checks [11]-[15] ─────────────────────────────────

console.log('\n[11]-[15] selectWinningBidFromGame')

{
  const biddingWb = wb('suit', 'hearts')
  const result = selectWinningBidFromGame(makeGame({ phase: 'bidding', biddingWinningBid: biddingWb }))
  check('[11] bidding → взима от bidding', result?.contract === 'suit' && result?.trumpSuit === 'hearts')
}

{
  const playingWb = wb('all-trumps', null, false, false, 'top')
  const result = selectWinningBidFromGame(makeGame({ phase: 'playing', playingWinningBid: playingWb }))
  check('[12] playing → взима от playing', result?.contract === 'all-trumps' && result?.seat === 'top')
}

{
  const scoringWb = wb('no-trumps', null, true, false, 'left')
  const result = selectWinningBidFromGame(makeGame({ phase: 'scoring', scoringWinningBid: scoringWb }))
  check('[13] scoring → взима от scoring', result?.contract === 'no-trumps' && result?.doubled === true)
}

check('[14] null game → null', selectWinningBidFromGame(null) === null)

{
  const result = selectWinningBidFromGame(makeGame({ phase: 'cutting' }))
  check('[15] cutting без bid → null', result === null)
}

// ── computeNextLastKnownWinningBid state machine checks [16]-[24] ─────────────

console.log('\n[16]-[24] computeNextLastKnownWinningBid state machine')

{
  const playingWb = wb('suit', 'spades', false, false, 'right')
  const game = makeGame({ phase: 'playing', playingWinningBid: playingWb })
  const next = computeNextLastKnownWinningBid(null, game)
  check('[16] reconnect playing: null → задава bid', next?.contract === 'suit' && next?.trumpSuit === 'spades')
}

{
  const prev = wb('suit', 'clubs')
  const newWb = wb('all-trumps', null, false, false, 'top')
  const game = makeGame({ phase: 'playing', playingWinningBid: newWb })
  const next = computeNextLastKnownWinningBid(prev, game)
  check('[17] playing update: X → Y', next?.contract === 'all-trumps')
}

{
  const scoringWb = wb('no-trumps', null, true, false, 'bottom')
  const game = makeGame({ phase: 'scoring', scoringWinningBid: scoringWb })
  const next = computeNextLastKnownWinningBid(scoringWb, game)
  check('[18] scoring: запазва bid', next?.contract === 'no-trumps' && next?.doubled === true)
}

{
  const prev = wb('suit', 'hearts')
  const game = makeGame({ phase: 'cutting' })
  const next = computeNextLastKnownWinningBid(prev, game)
  check('[19] cutting: изчиства до null', next === null)
}

{
  const prev = wb('suit', 'diamonds')
  const game = makeGame({ phase: 'deal-first-3' })
  const next = computeNextLastKnownWinningBid(prev, game)
  check('[20] deal-first-3: изчиства до null', next === null)
}

{
  const prev = wb('suit', 'spades')
  const game = makeGame({ phase: 'deal-next-2' })
  const next = computeNextLastKnownWinningBid(prev, game)
  check('[21] deal-next-2: изчиства до null', next === null)
}

{
  const prev = wb('suit', 'clubs')
  const game = makeGame({ phase: 'bidding', biddingWinningBid: null })
  const next = computeNextLastKnownWinningBid(prev, game)
  check('[22] bidding старт без winningBid: изчиства до null', next === null)
}

{
  const prev = wb('suit', 'hearts')
  const next = computeNextLastKnownWinningBid(prev, null)
  check('[23] null game: запазва предишната стойност', next?.contract === 'suit' && next?.trumpSuit === 'hearts')
}

{
  const prev = wb('suit', 'diamonds')
  const game = makeGame({ phase: 'playing', playingWinningBid: null })
  const next = computeNextLastKnownWinningBid(prev, game)
  check('[24] playing с null winningBid: запазва предишна (playing не е pre-contract)', next?.contract === 'suit')
}

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
