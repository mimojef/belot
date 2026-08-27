// Браузърна тестова "сглобка" за checkTournamentInterRoundAutoReturn.ts —
// кара РЕАЛНИЯ createLobbyFlowController() (не мокап), зареден през Vite
// dev server, в истински браузър (Playwright).
//
// simulateTournamentMatchAssignedPush() тук огледално възпроизвежда ТОЧНО
// логиката, добавена в main.ts's tournament_match_assigned WS handler (§
// "A → B AUTO NAVIGATION"):
//
//   if (message.assignment.deadlineKind === 'round_transition') {
//     attemptTournamentRoundTransitionSilentAttach(message.assignment) // не тестваме тук — виж checkTournamentUnifiedTransitionTiming
//     if (lobby.getCurrentTournamentDetailId() !== message.assignment.tournamentId) {
//       lobby.navigateToTournamentDetail(message.assignment.tournamentId)
//     }
//   }
//
// т.е. извиква СЪЩИТЕ два публични LobbyFlowController метода
// (getCurrentTournamentDetailId/navigateToTournamentDetail), по СЪЩИЯ ред,
// със СЪЩОТО условие — не е мокап на main.ts, а директна проверка на
// lobby controller-ово поведение при точно тази двойка извиквания, plus
// реалния DOM/render резултат от тях (STATE B renderer-ът, не мокап).
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import type { TournamentDetailSnapshot, TournamentMatchAssignmentSnapshot } from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

let tournamentDetailToServe: TournamentDetailSnapshot | null = null
let navigateToTournamentDetailCalls = 0

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
  onTournamentActiveMatchRecovered: () => {},
  onTournamentRoundTransitionAssignment: () => {},
})

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
    teams: [
      { teamId: 'team-a', status: 'locked', members: [{ profileId: 'me', displayName: 'Me', avatarUrl: null, joinedAs: 'solo' }] } as any,
      { teamId: 'team-b', status: 'locked', members: [{ profileId: 'opp-1', displayName: 'Opponent One', avatarUrl: null, joinedAs: 'solo' }] } as any,
    ],
    rounds: [],
    myActiveMatch: null,
    myInterRoundWaiting: null,
    incomingPartnerInvite: null,
    outgoingPartnerInvite: null,
    ...overrides,
  } as TournamentDetailSnapshot
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function stateAAssignmentDetail(): TournamentDetailSnapshot {
  return baseDetail({
    myActiveMatch: null,
    myInterRoundWaiting: {
      tournamentId: 'tour-1',
      currentRoundType: 'semifinal',
      nextRoundType: 'final',
      completedMatchId: 'my-match-1',
      sibling: {
        matchId: 'sibling-match-1',
        roundIndex: 2,
        teamA: { teamId: 'sib-a', status: 'locked', members: [] } as any,
        teamB: { teamId: 'sib-b', status: 'locked', members: [] } as any,
        scoreA: 10,
        scoreB: 8,
        status: 'in_progress',
        winnerTeamId: null,
        progressLabel: 'Играе се',
      },
      ownResultAcknowledged: true,
      otherFinalistReady: false,
      nextMatchId: null,
      nextRoomId: null,
      nextMatchStartAt: null,
      serverNow: new Date().toISOString(),
      completedSemifinalMatchId: 'my-match-1',
      siblingSemifinal: {
        matchId: 'sibling-match-1',
        roundIndex: 2,
        teamA: { teamId: 'sib-a', status: 'locked', members: [] } as any,
        teamB: { teamId: 'sib-b', status: 'locked', members: [] } as any,
        scoreA: 10,
        scoreB: 8,
        status: 'in_progress',
        winnerTeamId: null,
        progressLabel: 'Играе се',
      },
      finalMatchId: null,
      finalRoomId: null,
      finalStartAt: null,
    },
  })
}

function stateBAssignment(): TournamentMatchAssignmentSnapshot {
  return {
    tournamentId: 'tour-1',
    tournamentName: 'Harness Tournament',
    matchId: 'match-1',
    roomId: 'final-room',
    roundType: 'final',
    seat: 'bottom',
    teamId: 'team-a',
    partnerProfileId: 'partner-1',
    opponentTeamId: 'team-b',
    reconnectToken: 'reconnect-token-1',
    deadlineKind: 'round_transition',
    attendanceDeadlineAt: new Date(Date.now() + 20_000).toISOString(),
    gameStartAt: null,
  }
}

async function enterStateAOnDetail(): Promise<void> {
  tournamentDetailToServe = stateAAssignmentDetail()
  controller.navigateToTournamentDetail('tour-1')
  await flush()
}

function goToScreen(screen: 'lobby' | 'players' | 'chat' | 'tournaments'): void {
  if (screen === 'lobby') {
    controller.resetToLobby()
    controller.render()
    return
  }
  // Real SPA route change (mirrors an actual browser back/forward or nav
  // click): pushState + a popstate dispatch — main.ts's own
  // window.addEventListener('popstate', ...) reacts to exactly this by
  // calling navigateFromPath(). 'chat'/'tournaments' would route the same
  // way; the guard under test (getCurrentTournamentDetailId()) is
  // screen-agnostic (only checks state.currentScreen === 'tournament-detail'),
  // so a single additional non-tournament screen (players) is enough to
  // prove "user is elsewhere in the SPA".
  const path = screen === 'players' ? '/players' : screen === 'chat' ? '/chat' : '/tournaments'
  history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

// Exact mirror of main.ts's tournament_match_assigned handler:
//   lobby.handleServerMessage(message)   // pre-existing — drives the
//                                         // ALREADY-working in-place STATE
//                                         // A->B re-render when the player
//                                         // is already on this tournament's
//                                         // detail screen (fetchTournamentDetail
//                                         // re-fetch, unchanged by this task)
//   if (deadlineKind === 'round_transition') {
//     attemptTournamentRoundTransitionSilentAttach(...)   // unrelated to this test
//     if (getCurrentTournamentDetailId() !== tournamentId) navigateToTournamentDetail(...)
//   }
function simulateTournamentMatchAssignedPush(assignment: TournamentMatchAssignmentSnapshot): void {
  tournamentDetailToServe = baseDetail({
    myActiveMatch: assignment,
    myInterRoundWaiting: null,
  })
  controller.handleServerMessage({
    type: 'tournament_match_assigned',
    assignment,
  } as any)
  if (controller.getCurrentTournamentDetailId() !== assignment.tournamentId) {
    navigateToTournamentDetailCalls += 1
    controller.navigateToTournamentDetail(assignment.tournamentId)
  }
}

;(window as any).__tournamentInterRoundAutoReturnHarness = {
  enterStateAOnDetail,
  goToScreen,
  simulateTournamentMatchAssignedPush: async (): Promise<void> => {
    simulateTournamentMatchAssignedPush(stateBAssignment())
    await flush()
  },
  getCurrentScreen: () => controller.getCurrentScreen(),
  getCurrentTournamentDetailId: () => controller.getCurrentTournamentDetailId(),
  getPathname: () => window.location.pathname,
  domHasStateBMarkup: () => root.innerHTML.includes('data-tournament-inter-round-opponent-known="1"'),
  domHasStateAMarkup: () => root.innerHTML.includes('data-tournament-inter-round-waiting="1"'),
  getNavigateToTournamentDetailCalls: () => navigateToTournamentDetailCalls,
  reset: () => {
    navigateToTournamentDetailCalls = 0
  },
}
