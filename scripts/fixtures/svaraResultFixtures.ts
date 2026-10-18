import type { RenderSvaraActiveTableInput } from '../../src/app/games/svara/table/renderSvaraActiveTable'

export const RESULT_START = 1_900_000_000_000

export function svaraResultFixture(): RenderSvaraActiveTableInput {
  return {
    table: {
      matchId: 'result-test', capacity: 4, phase: 'in-progress', startMode: 'manual',
      creatorId: 'alice', entryFee: 10000, entryPercent: 1, startingChips: 1000, entryChips: 10,
      players: ['alice', 'bob', 'carol', 'dave'].map((playerId, seatIndex) => ({ playerId, seatIndex, status: 'active' as const })),
    },
    snapshot: {
      type: 'svara_match_snapshot', protocolVersion: 1, matchId: 'result-test', revision: 20, phase: 'in-progress',
      table: { capacity: 4, startMode: 'manual', creatorId: 'alice', entryFee: 10000, entryPercent: 1, startingChips: 1000, entryChips: 10 },
      seats: ['alice', 'bob', 'carol', 'dave'].map((playerId, seatIndex) => ({
        playerId, seatIndex, status: 'active', stack: 700, isDealer: seatIndex === 0,
        isToAct: false, inRound: true, folded: seatIndex === 3, allIn: seatIndex === 1,
        cardCount: seatIndex === 3 ? 0 : 3, roundContribution: 100,
      })),
      dealerId: 'alice', toActId: null,
      you: { playerId: 'alice', seatIndex: 0, status: 'active', looked: true, returnPending: false,
        svaraDecision: null, cards: null, betting: null, revealChoice: null },
      round: {
        kind: 'showdown-display', roundId: 'showdown-7', dealerId: 'alice', comparedPlayers: ['alice', 'bob'],
        cards: { alice: ['AC', 'AH', 'AS'], bob: ['7D', '7H', '7S'] },
        comparisonPoints: { alice: 33, bob: 34 },
        payout: [
          { stepId: 'main:payout', potId: 'main', isMain: true, amount: 1250, winners: ['bob'], share: null, removed: 0, sequence: 0 },
          { stepId: 'side:payout', potId: 'side', isMain: false, amount: 401, winners: ['alice', 'carol'], share: 200, removed: 1, sequence: 1 },
        ],
        svaraTie: false, displayPhase: 'showdown',
      },
      lockedPots: [], carriedTotal: 0, removedChips: 1, totalChips: 4000,
      history: { totalRounds: 1, showdownReveal: 'withheld', recent: [] },
      result: { finished: false, closed: false, winnerId: null, aborted: false, reason: null, message: null },
    },
    timing: { type: 'svara_match_timing', matchId: 'result-test', revision: 20, serverNow: RESULT_START,
      deadlines: [{ kind: 'showdown-display', deadlineAt: RESULT_START + 3000, remainingMs: 3000, playerId: null }] },
    localProfileId: 'alice', serverNow: RESULT_START, isFullscreen: false, fullscreenSupported: false,
    leavePending: false, actionPending: false, reducedMotion: false,
    activeFoldEffects: [], activeLookEffect: null,
    dealingVisual: { active: false, entry: null, flyingCard: null, landedCardCountBySeatIndex: new Map() },
  }
}

export function setFixturePayout(input: RenderSvaraActiveTableInput): void {
  if (input.snapshot?.round?.kind !== 'showdown-display' || !input.timing) throw new Error('Invalid fixture')
  input.snapshot.round.displayPhase = 'payout'
  input.snapshot.revision++
  input.timing.revision++
  input.timing.deadlines = [{ kind: 'payout-display', deadlineAt: RESULT_START + 3000 + 2400, remainingMs: 2400, playerId: null }]
}
