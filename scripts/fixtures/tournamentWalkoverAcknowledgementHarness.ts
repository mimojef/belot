// Споделена браузърна тестова "сглобка" за checkTournamentWalkoverAcknowledgement.ts
// — зарежда РЕАЛНИЯ createActiveRoomFlowController() и го движи с реални
// handleServerMessage()/render()/click() извиквания, за да докаже на реален
// DOM DELTA walkover acknowledgement fix-а: победителят чрез walkover трябва
// да изпрати tournament_semifinal_result_acknowledge (options.
// acknowledgeTournamentSemifinalResult) независимо дали натисне ръчно
// "Към турнира", или auto-transition таймерът го изведе автоматично — но
// НЕ при загуба, НЕ при final walkover. Огледало на установения pattern в
// biddingBoardLifecycleHarness.ts.
import { createActiveRoomFlowController } from '/src/app/activeRoom/createActiveRoomFlowController.ts'
import type {
  RoomGameSnapshot,
  RoomSeatSnapshot,
  RoomSnapshotMessage,
  TournamentAttendanceSnapshot,
  TournamentRoundType,
} from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

let ackCalls: Array<{ tournamentId: string; semifinalMatchId: string }> = []
let enterWaitingCalls = 0
let showLobbyCalls = 0
let finalResultContinueCalls: string[] = []
// Queue-driven mock за fetchTournamentDetail — shift-ва по един отговор на
// извикване, докато остане последният елемент (тогава той се повтаря за
// следващи retry опити). Празна опашка = null (симулира fetch failure,
// огледално на реалното main.ts поведение — грешка се резолвва до null, не
// throw-ва).
let fetchTournamentDetailQueue: Array<any> = []
let fetchTournamentDetailCallCount = 0

class FakeAudio {
  constructor(_src?: string) {}
  preload = ''
  volume = 1
  play(): Promise<void> {
    return Promise.resolve()
  }
}
Object.defineProperty(window, 'Audio', { configurable: true, value: FakeAudio })

const seats: RoomSeatSnapshot[] = ['bottom', 'right', 'top', 'left'].map((seat, index) => ({
  seat: seat as RoomSeatSnapshot['seat'],
  isOccupied: true,
  isConnected: true,
  isBot: index !== 0,
  isControlledByBot: false,
  displayName: index === 0 ? 'Harness Human' : `Bot ${index}`,
  avatarUrl: null,
  gender: null,
  level: 1,
  rankTitle: null,
  skillRating: null,
}))

const score = { match: { teamA: 0, teamB: 0 } }
const noVisibleHands = { bottom: 0, right: 0, top: 0, left: 0 }

const controller = createActiveRoomFlowController({
  root: root as unknown as HTMLDivElement,
  isConnected: () => true,
  leaveActiveRoom: () => {},
  submitCutIndex: () => {},
  submitBidAction: () => {},
  submitPlayCard: () => {},
  resumeHumanControl: () => {},
  submitPartnerRating: () => {},
  sendReplayVote: () => {},
  sendLeaveMatchVote: () => {},
  sendEmojiReaction: () => {},
  sendPhraseReaction: () => {},
  requestPlayerProfile: () => {},
  getFriendshipAction: () => null,
  onSendFriendRequest: async () => ({ ok: false, message: 'unused' }),
  onLikeProfile: async () => ({ ok: false }),
  onBlockProfile: async () => ({ message: 'unused' }),
  showLobby: () => { showLobbyCalls += 1 },
  startNewGame: () => {},
  onGuestTrialReplayRequested: () => {},
  fetchTournamentDetail: async (tournamentId: string) => {
    fetchTournamentDetailCallCount += 1
    if (fetchTournamentDetailQueue.length === 0) return null
    if (fetchTournamentDetailQueue.length > 1) return fetchTournamentDetailQueue.shift() ?? null
    return fetchTournamentDetailQueue[0] ?? null
  },
  onEnterWaitingForNextTournamentRound: () => { enterWaitingCalls += 1 },
  onTournamentFinalResultContinue: (tournamentId: string) => { finalResultContinueCalls.push(tournamentId) },
  acknowledgeTournamentSemifinalResult: (tournamentId: string, semifinalMatchId: string) => {
    ackCalls.push({ tournamentId, semifinalMatchId })
  },
  requestBidResync: () => {},
  forceReconnectForZombieConnection: () => {},
})

function enter(roomId: string): void {
  controller.enterActiveRoom({
    roomId,
    seat: 'bottom',
    stake: 5000,
    humanPlayers: 1,
    botPlayers: 3,
    shouldStartImmediately: false,
  } as any, true)
}

function emptyGame(): RoomGameSnapshot {
  return {
    phase: null,
    authoritativePhase: null,
    timerDeadlineAt: null,
    dealerSeat: null,
    firstDealSeat: null,
    cutting: null,
    bidding: null,
    playing: null,
    scoring: null,
    matchEnded: null,
    declarations: [],
    score,
    handCounts: noVisibleHands,
    ownHand: [],
  }
}

function playingGame(): RoomGameSnapshot {
  return {
    ...emptyGame(),
    phase: 'playing',
    authoritativePhase: 'playing',
  }
}

function matchEndedGame(winnerTeam: 'A' | 'B'): RoomGameSnapshot {
  return {
    ...emptyGame(),
    phase: 'match-ended',
    authoritativePhase: 'match-ended',
    matchEnded: {
      winnerTeam,
      targetScore: 151,
      finalScore: { teamA: winnerTeam === 'A' ? 151 : 90, teamB: winnerTeam === 'B' ? 151 : 90 },
      endedAt: Date.now(),
      replayVotes: [],
      leaveVotes: [],
      awardedPrizeAmount: null,
    },
  }
}

function walkoverAttendance(localSeatMissing: boolean): TournamentAttendanceSnapshot {
  return {
    state: 'completed',
    serverNow: new Date().toISOString(),
    deadlineAt: null,
    secondsRemaining: 0,
    missingPlayers: localSeatMissing
      ? [{ seat: 'bottom', team: 'A', displayName: 'Harness Human', avatarUrl: null }]
      : [{ seat: 'right', team: 'B', displayName: 'Bot 1', avatarUrl: null }],
    missingByTeam: { A: [], B: [] },
    resolutionKind: 'walkover',
    gameStartAt: null,
    startSecondsRemaining: 0,
    walkover: {
      winnerTeamId: localSeatMissing ? 'team-b' : 'team-a',
      loserTeamId: localSeatMissing ? 'team-a' : 'team-b',
      reason: 'no_show',
      completedAt: new Date().toISOString(),
    },
  }
}

// wonByWalkover=true => localSeatMissing=false (моят отбор Е присъствал, печели служебно)
// wonByWalkover=false => localSeatMissing=true (моят отбор липсва, губи служебно)
function walkoverSnapshot(
  roomId: string,
  tournamentId: string,
  tournamentMatchId: string,
  roundType: TournamentRoundType,
  wonByWalkover: boolean,
): RoomSnapshotMessage {
  return {
    type: 'room_snapshot',
    roomId,
    roomStatus: 'playing',
    yourSeat: 'bottom',
    reconnectToken: 'token',
    seats,
    game: emptyGame(),
    isGuestTrial: false,
    isPrivateTableOrigin: false,
    isTournamentMatchOrigin: true,
    tournamentId,
    tournamentMatchId,
    tournamentRoundType: roundType,
    tournamentAttendance: walkoverAttendance(!wonByWalkover),
    stakeAmount: 5000,
  }
}

// Изпраща се ПРЕДИ matchEnded snapshot-а, за да уталожи dealing/deal-next-2/
// deal-last-3 animation кешовете (isAnimating е unconditional флаг, преживял
// entre предишни тестови стаи в СЪЩИЯ harness controller instance) — точно
// какъвто реалистичен playing -> matchEnded преход прави в продукция.
function playingSnapshot(roomId: string, tournamentId: string, tournamentMatchId: string, roundType: TournamentRoundType): RoomSnapshotMessage {
  return {
    type: 'room_snapshot',
    roomId,
    roomStatus: 'playing',
    yourSeat: 'bottom',
    reconnectToken: 'token',
    seats,
    game: playingGame(),
    isGuestTrial: false,
    isPrivateTableOrigin: false,
    isTournamentMatchOrigin: true,
    tournamentId,
    tournamentMatchId,
    tournamentRoundType: roundType,
    tournamentAttendance: null,
    stakeAmount: 5000,
  }
}

function scoringSnapshotData(matchTotalsA: number, matchTotalsB: number) {
  const zero = { teamA: 0, teamB: 0 }
  return {
    winningBid: { seat: 'bottom' as const, contract: 'all-trumps' as const, trumpSuit: null, doubled: false, redoubled: false },
    rawHandPoints: { teamA: 90, teamB: 62 },
    rawHandTricksWon: zero,
    declarationPoints: zero,
    belotePoints: zero,
    sumPoints: { teamA: 90, teamB: 62 },
    officialRoundPoints: { teamA: 90, teamB: 62 },
    matchTotals: { teamA: matchTotalsA, teamB: matchTotalsB },
    carryOver: zero,
    isCapotRound: false,
    isNonCapotRound: true,
    outcomeLabel: 'Вътре',
    outcomeShortLabel: 'Вътре',
    counterMultiplier: 1,
  }
}

// Точен repro на ISSUE 1 race-а: game.matchEnded вече е populated, докато
// authoritativePhase все още е 'scoring' — сървърът изчислява winner/
// matchEnded в момента на влизане в scoring фазата
// (server/src/game/startServerScoringPhase.ts), преди authoritative-ния 5s
// summaryVisibleMs delay да изтече. Огледално на реалния сървърен snapshot
// за печелившата ръка на мач-приключващ tournament round.
function scoringWithMatchEndedGame(wonRound: boolean): RoomGameSnapshot {
  const winnerTeam: 'A' | 'B' = wonRound ? 'A' : 'B'
  return {
    ...emptyGame(),
    phase: 'scoring',
    authoritativePhase: 'scoring',
    scoring: scoringSnapshotData(winnerTeam === 'A' ? 151 : 90, winnerTeam === 'B' ? 151 : 90),
    matchEnded: {
      winnerTeam,
      targetScore: 151,
      finalScore: { teamA: winnerTeam === 'A' ? 151 : 90, teamB: winnerTeam === 'B' ? 151 : 90 },
      endedAt: Date.now(),
      replayVotes: [],
      leaveVotes: [],
      awardedPrizeAmount: null,
    },
  }
}

function scoringWithMatchEndedSnapshot(
  roomId: string,
  tournamentId: string,
  tournamentMatchId: string,
  roundType: TournamentRoundType,
  wonRound: boolean,
): RoomSnapshotMessage {
  return {
    type: 'room_snapshot',
    roomId,
    roomStatus: 'playing',
    yourSeat: 'bottom',
    reconnectToken: 'token',
    seats,
    game: scoringWithMatchEndedGame(wonRound),
    isGuestTrial: false,
    isPrivateTableOrigin: false,
    isTournamentMatchOrigin: true,
    tournamentId,
    tournamentMatchId,
    tournamentRoundType: roundType,
    tournamentAttendance: null,
    stakeAmount: 5000,
  }
}

function normalMatchEndedSnapshot(
  roomId: string,
  tournamentId: string,
  tournamentMatchId: string,
  roundType: TournamentRoundType,
  wonRound: boolean,
): RoomSnapshotMessage {
  return {
    type: 'room_snapshot',
    roomId,
    roomStatus: 'playing',
    yourSeat: 'bottom',
    reconnectToken: 'token',
    seats,
    game: matchEndedGame(wonRound ? 'A' : 'B'),
    isGuestTrial: false,
    isPrivateTableOrigin: false,
    isTournamentMatchOrigin: true,
    tournamentId,
    tournamentMatchId,
    tournamentRoundType: roundType,
    tournamentAttendance: null,
    stakeAmount: 5000,
  }
}

function snapshot(message: RoomSnapshotMessage): void {
  controller.handleServerMessage(message)
}

function render(): void {
  controller.render()
}

function walkoverContinueButtonExists(): boolean {
  return root.querySelector('[data-tournament-walkover-continue]') !== null
}

function clickWalkoverContinue(): boolean {
  const btn = root.querySelector<HTMLButtonElement>('[data-tournament-walkover-continue]')
  if (!btn) return false
  btn.click()
  return true
}

function roundResultLobbyButtonExists(): boolean {
  return root.querySelector('[data-tournament-round-result-lobby]') !== null
}

function clickRoundResultLobby(): boolean {
  const btn = root.querySelector<HTMLButtonElement>('[data-tournament-round-result-lobby]')
  if (!btn) return false
  btn.click()
  return true
}

function completePendingTournamentRoundResultTransition(): boolean {
  return controller.completePendingTournamentRoundResultTransition()
}

function scoringCountdownVisible(): boolean {
  return root.querySelector('[data-scoring-countdown="1"]') !== null
}

function finalResultScreenVisible(): boolean {
  return root.querySelector('[data-tournament-final-result-detail]') !== null
}

function finalResultTitleText(): string | null {
  return root.querySelector('[data-tournament-final-result-title]')?.textContent ?? null
}

function finalResultPrizeText(): string | null {
  return root.querySelector('[data-tournament-final-result-prize]')?.textContent ?? null
}

function clickFinalResultContinue(): boolean {
  const btn = root.querySelector<HTMLButtonElement>('[data-tournament-final-result-detail]')
  if (!btn) return false
  btn.click()
  return true
}

function setFetchTournamentDetailQueue(queue: Array<any>): void {
  fetchTournamentDetailQueue = [...queue]
  fetchTournamentDetailCallCount = 0
}

function getFetchTournamentDetailCallCount(): number {
  return fetchTournamentDetailCallCount
}

function getFinalResultContinueCalls(): string[] {
  return finalResultContinueCalls
}

function getAckCalls(): Array<{ tournamentId: string; semifinalMatchId: string }> {
  return ackCalls
}
function getAckCount(): number {
  return ackCalls.length
}
function getEnterWaitingCount(): number {
  return enterWaitingCalls
}
function getShowLobbyCalls(): number {
  return showLobbyCalls
}

function reset(): void {
  ackCalls = []
  enterWaitingCalls = 0
  showLobbyCalls = 0
  finalResultContinueCalls = []
  fetchTournamentDetailQueue = []
  fetchTournamentDetailCallCount = 0
  root.innerHTML = ''
}

;(window as any).__tournamentWalkoverAckHarness = {
  enter,
  walkoverSnapshot,
  playingSnapshot,
  normalMatchEndedSnapshot,
  scoringWithMatchEndedSnapshot,
  snapshot,
  render,
  walkoverContinueButtonExists,
  clickWalkoverContinue,
  roundResultLobbyButtonExists,
  clickRoundResultLobby,
  completePendingTournamentRoundResultTransition,
  scoringCountdownVisible,
  finalResultScreenVisible,
  finalResultTitleText,
  finalResultPrizeText,
  clickFinalResultContinue,
  setFetchTournamentDetailQueue,
  getFetchTournamentDetailCallCount,
  getFinalResultContinueCalls,
  getAckCalls,
  getAckCount,
  getEnterWaitingCount,
  getShowLobbyCalls,
  reset,
}
