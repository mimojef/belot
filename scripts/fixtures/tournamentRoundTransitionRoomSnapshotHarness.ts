// Браузърна тестова "сглобка" за
// checkTournamentRoundTransitionRoomSnapshotHijack.ts — кара РЕАЛНИЯ
// createLobbyFlowController() (не мокап), зареден през Vite dev server, в
// истински браузър (Playwright), точно по продукционния path: STATE B (§
// "STATE A -> STATE B -> GAMEPLAY") се влиза чрез showTournamentDetail() с
// authoritative myActiveMatch.deadlineKind === 'round_transition', след
// което сървърни room_snapshot push-ове за силентно attach-натата стая се
// подават директно през controller.handleServerMessage(...) — точно по
// пътя, по който main.ts подава реални WS кадри (виж main.ts:4927-4934:
// activeRoom.handleServerMessage() пръв, после lobby.handleServerMessage()
// ако activeRoom не е "consumed" съобщението — STATE B стои единствено в
// lobby-я, activeRoomState е null през целия прозорец).
//
// Огледало на tournamentStateBSilentEntryHarness.ts (там се тества
// createActiveRoomFlowController's own silent-entry watch в изолация) —
// тук се тества ДРУГАТА страна: lobby controller-ът НЕ трябва да hijack-не
// currentScreen/DOM-а само защото room_snapshot изглежда идентично на
// нормална matchmaking чакалня (roomStatus:'waiting' + game:null).
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import type { RoomSeatSnapshot, RoomSnapshotMessage, TournamentDetailSnapshot } from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

let tournamentDetailToServe: TournamentDetailSnapshot | null = null
let recoveredCalls: unknown[] = []
let roundTransitionAssignmentCalls: unknown[] = []

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: 'player' },
    profile: { profileId: 'me', displayName: 'Me' } as any,
  }),
  onTournamentDetailLoad: async (_tournamentId: string) => {
    if (tournamentDetailToServe === null) {
      return { ok: false, message: 'no fixture detail set' }
    }
    return { ok: true, tournament: tournamentDetailToServe }
  },
  onTournamentActiveMatchRecovered: (assignment) => {
    recoveredCalls.push(assignment)
  },
  onTournamentRoundTransitionAssignment: (assignment) => {
    roundTransitionAssignmentCalls.push(assignment)
  },
})

const seats: RoomSeatSnapshot[] = ['bottom', 'right', 'top', 'left'].map((seat, index) => ({
  seat: seat as RoomSeatSnapshot['seat'],
  isOccupied: index < 2,
  isConnected: index === 0,
  isBot: index !== 0,
  isControlledByBot: false,
  displayName: index === 0 ? 'Harness Human' : `Bot ${index}`,
  avatarUrl: null,
  gender: null,
  level: 1,
  rankTitle: null,
  skillRating: null,
}))

function baseDetail(overrides: Partial<TournamentDetailSnapshot>): TournamentDetailSnapshot {
  return {
    tournamentId: 'tour-1',
    name: 'Harness Tournament',
    creator: { profileId: 'creator-1', displayName: 'Creator', avatarUrl: null },
    visibility: 'public',
    requiresPassword: false,
    status: 'semifinal_in_progress',
    statusLabel: 'В ход',
    championTeamId: null,
    runnerUpTeamId: null,
    settlementState: 'pending',
    settledAt: null,
    entryFee: 5000,
    playerCapacity: 8,
    confirmedEntriesCount: 8,
    reservedPlacesCount: 0,
    occupiedPlacesCount: 8,
    completedTeamsCount: 4,
    formingTeamsCount: 0,
    availablePlaces: 0,
    isFull: true,
    startMode: 'fill',
    scheduledStartAt: null,
    fillExpiresAt: null,
    createdAt: new Date().toISOString(),
    prizePreview: {
      totalEntryFees: 40000,
      systemFee: 8000,
      prizePool: 32000,
      firstTeamPrize: 20800,
      secondTeamPrize: 11200,
      firstPlayerPrize: 10400,
      secondPlayerPrize: 5600,
      systemFeePercent: 20,
      winnerSharePercent: 65,
      runnerUpSharePercent: 35,
      financialRulesVersion: 'v1',
      persisted: true,
    } as any,
    isMine: false,
    viewer: {
      isParticipant: true,
      entryStatus: 'confirmed',
      joinedAs: 'solo',
      canJoinSolo: false,
      canInvitePartner: false,
      canLeave: false,
      canCancel: false,
      myPlacement: null,
      myPrizeAmount: null,
    },
    cancelReason: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    myTeam: null,
    teams: [],
    rounds: [],
    myActiveMatch: null,
    myInterRoundWaiting: null,
    incomingPartnerInvite: null,
    outgoingPartnerInvite: null,
    ...overrides,
  } as TournamentDetailSnapshot
}

async function enterStateB(roomId: string, matchId: string): Promise<void> {
  tournamentDetailToServe = baseDetail({
    myActiveMatch: {
      tournamentId: 'tour-1',
      tournamentName: 'Harness Tournament',
      matchId,
      roomId,
      roundType: 'final',
      seat: 'bottom',
      teamId: 'team-a',
      partnerProfileId: 'partner-1',
      opponentTeamId: 'team-b',
      reconnectToken: 'reconnect-token-1',
      deadlineKind: 'round_transition',
      attendanceDeadlineAt: new Date(Date.now() + 20_000).toISOString(),
      gameStartAt: null,
    },
    myInterRoundWaiting: null,
  })
  controller.navigateToTournamentDetail('tour-1')
  // navigateToTournamentDetail kicks off the async onTournamentDetailLoad
  // fetch — flush microtasks so the fixture detail above is actually
  // hydrated into state before the test pushes a room_snapshot, exactly
  // like a real fetchTournamentDetail() round-trip completing.
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function pushRoomSnapshot(input: {
  roomId: string
  roomStatus: 'waiting' | 'playing' | 'finished'
  game: RoomSnapshotMessage['game']
  isTournamentMatchOrigin: boolean
}): void {
  const message: RoomSnapshotMessage = {
    type: 'room_snapshot',
    roomId: input.roomId,
    roomStatus: input.roomStatus,
    yourSeat: 'bottom',
    reconnectToken: 'reconnect-token-1',
    seats,
    game: input.game,
    isGuestTrial: false,
    isPrivateTableOrigin: false,
    isTournamentMatchOrigin: input.isTournamentMatchOrigin,
    tournamentId: input.isTournamentMatchOrigin ? 'tour-1' : null,
    tournamentMatchId: input.isTournamentMatchOrigin ? 'match-1' : null,
    tournamentRoundType: input.isTournamentMatchOrigin ? 'final' : null,
    tournamentAttendance: null,
    stakeAmount: 5000,
  }
  controller.handleServerMessage(message)
}

;(window as any).__tournamentRoundTransitionRoomSnapshotHarness = {
  enterStateB,
  pushRoomSnapshot,
  getCurrentScreen: () => controller.getCurrentScreen(),
  domHasMatchmakingRoomMarkup: () => root.innerHTML.includes('mm-mobile-search-label') || root.innerHTML.includes('data-matchmaking-room-cancel-button'),
  getRoot: () => root,
  getRecoveredCalls: () => recoveredCalls,
  getRoundTransitionAssignmentCalls: () => roundTransitionAssignmentCalls,
  reset: () => {
    recoveredCalls = []
    roundTransitionAssignmentCalls = []
  },
}
