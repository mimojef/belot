// Браузърна тестова "сглобка" за checkTournamentSoloAutoPairDetailRefresh.ts —
// кара РЕАЛНИЯ createLobbyFlowController() (не мокап), зареден през Vite dev
// server, в истински браузър (Playwright). Огледален pattern на
// tournamentPartnerSearchTypingHarness.ts.
//
// Симулира точно репортнатия bug: A (Mimo) вече чака сам в 'forming' team;
// текущият viewer отваря "Запиши се сам" и сървърът auto-pair-ва двамата.
// onTournamentJoin мокапът връща САМО TournamentSummarySnapshot (точно както
// реалният /api/tournaments/:id/join отговор — виж handleTournamentJoinRequest
// в server/src/index.ts), НЕ пълен TournamentDetailSnapshot — за да провери
// дали контролерът прави authoritative detail refetch след успешния join,
// вместо да разчита само на shallow-merge-натите summary полета.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import type { TournamentDetailSnapshot, TournamentSummarySnapshot } from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

const tournamentId = 'tour-auto-pair-1'
const mimoTeamId = 'team-mimo-waiting'

let detailLoadCallCount = 0
let joinCallCount = 0

function waitingSoloDetail(): TournamentDetailSnapshot {
  return {
    tournamentId,
    name: 'Auto-Pair Harness Tournament',
    creator: { profileId: 'creator-1', displayName: 'Creator', avatarUrl: null },
    visibility: 'public',
    requiresPassword: false,
    status: 'open',
    statusLabel: 'Записване',
    championTeamId: null,
    runnerUpTeamId: null,
    settlementState: 'pending',
    settledAt: null,
    entryFee: 5000,
    playerCapacity: 8,
    confirmedEntriesCount: 1,
    reservedPlacesCount: 0,
    occupiedPlacesCount: 1,
    completedTeamsCount: 0,
    formingTeamsCount: 1,
    availablePlaces: 7,
    isFull: false,
    startMode: 'fill',
    scheduledStartAt: null,
    fillExpiresAt: null,
    createdAt: new Date().toISOString(),
    prizePreview: {
      totalEntryFees: 40000, systemFee: 8000, prizePool: 32000,
      firstTeamPrize: 20800, secondTeamPrize: 11200, firstPlayerPrize: 10400, secondPlayerPrize: 5600,
      systemFeePercent: 20, winnerSharePercent: 65, runnerUpSharePercent: 35,
      financialRulesVersion: 'v1', persisted: true,
    } as any,
    isMine: false,
    viewer: {
      isParticipant: false,
      entryStatus: null,
      joinedAs: null,
      canJoinSolo: true,
      canInvitePartner: true,
      canLeave: false,
      canCancel: false,
      myPlacement: null,
      myPrizeAmount: null,
    },
    cancelReason: null,
    startedAt: null,
    finishedAt: null,
    myTeam: null,
    teams: [
      {
        teamId: mimoTeamId,
        status: 'forming',
        members: [
          { profileId: 'mimo', displayName: 'Mimo', avatarUrl: null, joinedAt: new Date().toISOString(), joinedAs: 'solo' },
        ],
      },
    ],
    rounds: [],
    myActiveMatch: null,
    myInterRoundWaiting: null,
    incomingPartnerInvite: null,
    outgoingPartnerInvite: null,
    viewerHasUnresolvedBotReplacement: false,
  } as TournamentDetailSnapshot
}

// Authoritative post-join state — what the server ACTUALLY has after
// joinTournamentSoloAtomically auto-pairs "me" with Mimo's waiting team.
function readyPairDetail(): TournamentDetailSnapshot {
  const base = waitingSoloDetail()
  return {
    ...base,
    confirmedEntriesCount: 2,
    occupiedPlacesCount: 2,
    completedTeamsCount: 1,
    formingTeamsCount: 0,
    availablePlaces: 6,
    viewer: {
      ...base.viewer,
      isParticipant: true,
      entryStatus: 'confirmed',
      joinedAs: 'solo',
      canJoinSolo: false,
    },
    myTeam: {
      teamId: mimoTeamId,
      status: 'complete',
      members: [
        { profileId: 'mimo', displayName: 'Mimo', avatarUrl: null, joinedAt: base.createdAt, joinedAs: 'solo' },
        { profileId: 'me', displayName: 'Me', avatarUrl: null, joinedAt: new Date().toISOString(), joinedAs: 'solo' },
      ],
    },
    teams: [
      {
        teamId: mimoTeamId,
        status: 'complete',
        members: [
          { profileId: 'mimo', displayName: 'Mimo', avatarUrl: null, joinedAt: base.createdAt, joinedAs: 'solo' },
          { profileId: 'me', displayName: 'Me', avatarUrl: null, joinedAt: new Date().toISOString(), joinedAs: 'solo' },
        ],
      },
    ],
  } as TournamentDetailSnapshot
}

function joinSummaryOnly(): TournamentSummarySnapshot {
  // Exactly what /api/tournaments/:id/join returns on success today
  // (buildTournamentSummaryDto) — deliberately WITHOUT teams/myTeam, to
  // reproduce the real production response shape.
  const { teams: _teams, myTeam: _myTeam, rounds: _rounds, myActiveMatch: _myActiveMatch,
    myInterRoundWaiting: _myInterRoundWaiting, incomingPartnerInvite: _incomingPartnerInvite,
    outgoingPartnerInvite: _outgoingPartnerInvite, cancelReason: _cancelReason, startedAt: _startedAt,
    finishedAt: _finishedAt, viewerHasUnresolvedBotReplacement: _viewerHasUnresolvedBotReplacement,
    ...summary } = readyPairDetail()
  return summary
}

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
    detailLoadCallCount += 1
    return { ok: true, tournament: detailLoadCallCount === 1 ? waitingSoloDetail() : readyPairDetail() }
  },
  onTournamentJoin: async (_tournamentId: string, _password: string | null) => {
    joinCallCount += 1
    return {
      ok: true,
      alreadyJoined: false,
      debitedAmount: 5000,
      walletBalance: 95000,
      tournament: joinSummaryOnly(),
    }
  },
} as any)

// A page-load marker + navigateToTournamentDetail call count proves no
// reload/re-navigation ever happens during the join — the fix must be a
// plain in-place detail refetch, not a navigation workaround.
;(window as any).__harnessLoadMarker = 'still-the-same-page'
let navigateToTournamentDetailCallCount = 0
const realNavigate = controller.navigateToTournamentDetail.bind(controller)
controller.navigateToTournamentDetail = (id: string) => {
  navigateToTournamentDetailCallCount += 1
  realNavigate(id)
}

controller.navigateToTournamentDetail(tournamentId)

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function clickJoinOpen(): void {
  root.querySelector<HTMLButtonElement>('[data-tournament-join-open="1"]')?.click()
}

function clickJoinSubmit(): void {
  root.querySelector<HTMLButtonElement>('[data-tournament-join-submit="1"]')?.click()
}

;(window as any).__tournamentSoloAutoPairDetailRefreshHarness = {
  flush,
  clickJoinOpen,
  clickJoinSubmit,
  getRootText: () => root.textContent ?? '',
  getRootHtml: () => root.innerHTML,
  getDetailLoadCallCount: () => detailLoadCallCount,
  getJoinCallCount: () => joinCallCount,
  getCurrentScreen: () => controller.getCurrentScreen(),
  getNavigateToTournamentDetailCallCount: () => navigateToTournamentDetailCallCount,
  getLoadMarker: () => (window as any).__harnessLoadMarker,
}

// ─── Second, INDEPENDENT controller instance: the WAITING player's (A/Mimo's
// own) already-open tournament detail screen — §"REALTIME" regression.
// A never clicks anything here; the only trigger is a simulated
// server-pushed tournament_team_updated message (exactly what
// handleTournamentJoinRequest emits after a committed auto-pair — see
// server/src/index.ts), delivered via the REAL, publicly exposed
// controller.handleServerMessage(), not a private/internal call. ───

const waitingRoot = document.createElement('div')
document.body.appendChild(waitingRoot)

let waitingDetailLoadCallCount = 0

function waitingPlayerOwnDetail(): TournamentDetailSnapshot {
  const base = waitingSoloDetail()
  return {
    ...base,
    viewer: { ...base.viewer, isParticipant: true, entryStatus: 'confirmed', joinedAs: 'solo', canJoinSolo: false },
    myTeam: base.teams[0] as any,
  } as TournamentDetailSnapshot
}

function waitingPlayerReadyDetail(): TournamentDetailSnapshot {
  const ready = readyPairDetail()
  return {
    ...ready,
    viewer: { ...ready.viewer, isParticipant: true, entryStatus: 'confirmed', joinedAs: 'solo', canJoinSolo: false },
  } as TournamentDetailSnapshot
}

const waitingController = createLobbyFlowController({
  root: waitingRoot,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: 'player' },
    profile: { profileId: 'mimo', displayName: 'Mimo' } as any,
  }),
  onTournamentDetailLoad: async (_tournamentId: string) => {
    waitingDetailLoadCallCount += 1
    return { ok: true, tournament: waitingDetailLoadCallCount === 1 ? waitingPlayerOwnDetail() : waitingPlayerReadyDetail() }
  },
} as any)

waitingController.navigateToTournamentDetail(tournamentId)

function simulateTeamUpdatedPush(pushTournamentId: string): void {
  waitingController.handleServerMessage({
    type: 'tournament_team_updated',
    tournamentId: pushTournamentId,
    teamId: mimoTeamId,
  } as any)
}

;(window as any).__tournamentSoloAutoPairWaitingClientHarness = {
  flush,
  getRootText: () => waitingRoot.textContent ?? '',
  getDetailLoadCallCount: () => waitingDetailLoadCallCount,
  getCurrentScreen: () => waitingController.getCurrentScreen(),
  simulateTeamUpdatedPush,
}
