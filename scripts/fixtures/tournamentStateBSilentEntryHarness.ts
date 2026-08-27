// Споделена браузърна тестова "сглобка" за checkTournamentStateBSilentEntry.ts
// — зарежда РЕАЛНИЯ createActiveRoomFlowController() и го движи с реални
// armPendingTournamentSilentEntry()/handleServerMessage() извиквания, за да
// докаже на реален DOM DELTA production bug-а от реален browser
// reproduction: STATE B (lobby-owned) трябва да остане visible, докато
// tournamentAttendance.state все още не е 'started'/'completed' — raw
// activeRoom attendance renderer ("Изчакват се играчите"/"Готови: N от 4")
// НЕ трябва да стане visible преди authoritative start, дори докато
// silent-attached-ият connection вече получава room_snapshot push-ове.
// Огледало на установения pattern в tournamentWalkoverAcknowledgementHarness.ts.
import { createActiveRoomFlowController } from '/src/app/activeRoom/createActiveRoomFlowController.ts'
import type {
  RoomGameSnapshot,
  RoomSeatSnapshot,
  RoomSnapshotMessage,
  TournamentAttendanceSnapshot,
} from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

let showLobbyCalls = 0

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
  isConnected: index !== 0,
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
  fetchTournamentDetail: async () => null,
  onEnterWaitingForNextTournamentRound: () => {},
  onTournamentFinalResultContinue: () => {},
  acknowledgeTournamentSemifinalResult: () => {},
  requestBidResync: () => {},
  forceReconnectForZombieConnection: () => {},
})

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

function startedGame(phase: 'cutting' | 'playing'): RoomGameSnapshot {
  return {
    ...emptyGame(),
    phase,
    authoritativePhase: phase,
  }
}

function attendanceSnapshot(
  state: 'waiting' | 'resolved' | 'countdown' | 'started' | 'completed',
  missingCount: number,
): TournamentAttendanceSnapshot {
  const missingPlayers = seats.slice(4 - missingCount).map((s) => ({
    seat: s.seat,
    team: (s.seat === 'bottom' || s.seat === 'top') ? 'A' as const : 'B' as const,
    displayName: s.displayName,
    avatarUrl: null,
  }))
  return {
    state,
    serverNow: new Date().toISOString(),
    deadlineAt: state === 'waiting' ? new Date(Date.now() + 20_000).toISOString() : null,
    secondsRemaining: state === 'waiting' ? 20 : 0,
    missingPlayers,
    missingByTeam: { A: [], B: [] },
    resolutionKind: state === 'started' || state === 'completed' ? 'all_present' : null,
    gameStartAt: state === 'started' ? new Date().toISOString() : null,
    startSecondsRemaining: 0,
    walkover: null,
  }
}

function roomSnapshot(input: {
  roomId: string
  attendanceState: 'waiting' | 'resolved' | 'countdown' | 'started' | 'completed'
  missingCount: number
  game: RoomGameSnapshot | null
}): RoomSnapshotMessage {
  return {
    type: 'room_snapshot',
    roomId: input.roomId,
    roomStatus: input.attendanceState === 'started' ? 'playing' : 'waiting',
    yourSeat: 'bottom',
    reconnectToken: 'token',
    seats,
    game: input.game,
    isGuestTrial: false,
    isPrivateTableOrigin: false,
    isTournamentMatchOrigin: true,
    tournamentId: 'tour-1',
    tournamentMatchId: 'final-match-1',
    tournamentRoundType: 'final',
    tournamentAttendance: attendanceSnapshot(input.attendanceState, input.missingCount),
    stakeAmount: 5000,
  }
}

function armSilentEntry(roomId: string): void {
  controller.armPendingTournamentSilentEntry({ roomId, seat: 'bottom', stake: 5000 })
}

function sendWaitingSnapshot(roomId: string, missingCount = 3): void {
  controller.handleServerMessage(roomSnapshot({ roomId, attendanceState: 'waiting', missingCount, game: null }))
}

function sendResolvedSnapshot(roomId: string): void {
  controller.handleServerMessage(roomSnapshot({ roomId, attendanceState: 'resolved', missingCount: 0, game: null }))
}

function sendStartedSnapshot(roomId: string, phase: 'cutting' | 'playing' = 'cutting'): void {
  controller.handleServerMessage(roomSnapshot({ roomId, attendanceState: 'started', missingCount: 0, game: startedGame(phase) }))
}

function sendCompletedSnapshot(roomId: string): void {
  controller.handleServerMessage(roomSnapshot({ roomId, attendanceState: 'completed', missingCount: 0, game: startedGame('playing') }))
}

function hasActiveRoom(): boolean {
  return controller.hasActiveRoom()
}

function rawAttendanceCardVisible(): boolean {
  return root.textContent?.includes('Готови:') === true
}

function domHasContent(): boolean {
  return root.innerHTML.trim().length > 0
}

function getShowLobbyCalls(): number {
  return showLobbyCalls
}

function reset(): void {
  showLobbyCalls = 0
  root.innerHTML = ''
}

;(window as any).__tournamentStateBSilentEntryHarness = {
  armSilentEntry,
  sendWaitingSnapshot,
  sendResolvedSnapshot,
  sendStartedSnapshot,
  sendCompletedSnapshot,
  hasActiveRoom,
  rawAttendanceCardVisible,
  domHasContent,
  getShowLobbyCalls,
  reset,
}
