// Real createLobbyFlowController() (not a mock), loaded through the Vite dev
// server — see checkTournamentStateANavbarStability.ts. Proves that while
// STATE A ("Изчаквате победителя от маса X") is showing, events unrelated to
// what's on screen (tournament_feeder_score_progress patched via the existing
// targeted DOM patch, and — the actual root cause — ANY OTHER WS handler that
// calls render() without a screen guard, e.g. lobby_chat_message) do not tear
// down and rebuild the shared #app root (navbar / mobile "Меню" included).
// See the "Skip-if-unchanged guard" comment in renderLobbyScreen.ts for the fix.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import type { TournamentDetailSnapshot, TournamentMatchAssignmentSnapshot } from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

let tournamentDetailToServe: TournamentDetailSnapshot | null = null
let rootReplaceCount = 0

// A root.innerHTML = ... reassignment replaces ALL of root's direct children
// in one shot -> exactly one childList mutation record per full rebuild.
// Targeted DOM patches (textContent on a descendant, or toggling an
// attribute on an existing node) do NOT touch root's direct children, so
// they produce zero records here — this is a code-architecture-agnostic
// proxy for "was the whole screen torn down and rebuilt".
const observer = new MutationObserver((records) => {
  for (const record of records) {
    if (record.target === root && record.type === 'childList') {
      rootReplaceCount += 1
    }
  }
})
observer.observe(root, { childList: true, subtree: false })

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

;(window as any).__tournamentStateANavbarStabilityHarness = {
  enterStateAOnDetail,
  simulateFeederScoreProgress: async (scoreA: number, scoreB: number): Promise<void> => {
    controller.handleServerMessage({
      type: 'tournament_feeder_score_progress',
      tournamentId: 'tour-1',
      matchId: 'sibling-match-1',
      teamAId: 'sib-a',
      teamBId: 'sib-b',
      scoreTeamA: scoreA,
      scoreTeamB: scoreB,
      status: 'in_progress',
    } as any)
    await flush()
  },
  simulateLobbyChatMessage: async (seq: number): Promise<void> => {
    controller.handleServerMessage({
      type: 'lobby_chat_message',
      seq,
      messageId: `msg-${seq}`,
      senderProfileId: 'other-player',
      senderDisplayName: 'Other Player',
      senderIsChatAdmin: false,
      senderRole: 'player',
      body: `hello ${seq}`,
      createdAt: new Date().toISOString(),
    } as any)
    await flush()
  },
  // Simulates STATE A -> STATE B: a REAL content change that must still
  // cause a full rebuild (the skip-if-unchanged guard must not over-suppress
  // legitimate transitions).
  simulateRoundTransitionAssignment: async (): Promise<void> => {
    tournamentDetailToServe = baseDetail({ myActiveMatch: stateBAssignment(), myInterRoundWaiting: null })
    controller.handleServerMessage({ type: 'tournament_match_assigned', assignment: stateBAssignment() } as any)
    await flush()
  },
  // Simulates a DIFFERENT renderer (matchmaking-room / private-room-waiting /
  // active-room all write to the same shared #app root) overwriting root out
  // from under createLobbyFlowController, then coming back to STATE A — the
  // guard must detect the foreign markup (missing data-lobby-screen-root)
  // and rebuild rather than wrongly skip.
  simulateForeignRootTakeover: (): void => {
    root.innerHTML = '<div data-foreign-screen="1">some other renderer owns root now</div>'
  },
  getRootReplaceCount: () => rootReplaceCount,
  resetRootReplaceCount: () => { rootReplaceCount = 0 },
  getScoreText: () => root.querySelector('[data-tournament-inter-round-score="1"]')?.textContent ?? null,
  domHasStateAMarkup: () => root.innerHTML.includes('data-tournament-inter-round-waiting="1"'),
  domHasStateBMarkup: () => root.innerHTML.includes('data-tournament-inter-round-opponent-known="1"'),
  clickMobileMenuSummary: () => {
    (root.querySelector('[data-lobby-mobile-menu-summary="1"]') as HTMLElement | null)?.click()
  },
  isMobileMenuOpen: () => (root.querySelector('[data-lobby-mobile-menu="1"]') as HTMLDetailsElement | null)?.open ?? null,
  tagMobileMenuPanelNode: () => {
    const el = root.querySelector('[data-lobby-mobile-menu-panel="1"]') as any
    if (el === null) return null
    const id = Math.random().toString(36).slice(2)
    el.__probeId = id
    return id
  },
  checkMobileMenuPanelNodeTag: () => {
    const el = root.querySelector('[data-lobby-mobile-menu-panel="1"]') as any
    return el === null ? null : (el.__probeId ?? null)
  },
  // Tags the <details data-lobby-mobile-menu="1"> element itself (not just
  // the inner panel) — the one-shot-flicker-on-open regression is about
  // THIS node's identity surviving a native open/close DOM mutation
  // followed by an unrelated blind render().
  tagMobileMenuDetailsNode: () => {
    const el = root.querySelector('[data-lobby-mobile-menu="1"]') as any
    if (el === null) return null
    const id = Math.random().toString(36).slice(2)
    el.__probeId = id
    return id
  },
  checkMobileMenuDetailsNodeTag: () => {
    const el = root.querySelector('[data-lobby-mobile-menu="1"]') as any
    return el === null ? null : (el.__probeId ?? null)
  },
}
