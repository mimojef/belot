// Браузърна тестова "сглобка" за checkTournamentSoloLeaveRealtimeClient.ts —
// кара РЕАЛНИЯ createLobbyFlowController() (не мокап), зареден през Vite dev
// server, в истински браузър (Playwright). Огледален pattern на
// tournamentSoloAutoPairDetailRefreshHarness.ts's "waiting client" половина —
// самият client-side механизъм (tournament_team_updated push -> canonical
// fetchTournamentDetail) е ИДЕНТИЧЕН, независимо дали mutation-ът, който го
// emit-на, е auto-pair join или solo-leave replacement/demote (§"PART 4 —
// REALTIME" в task spec-а). Тук специфично се проверява сценарият с ДВАМА
// едновременни recipients (A и C), плюс complete->forming->complete
// последователност за самотния remaining member (без C).
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import type { TournamentDetailSnapshot } from '/src/app/network/createGameServerClient.ts'

const tournamentId = 'tour-solo-leave-1'
const abTeamId = 'team-ab-complete'
const cOldTeamId = 'team-c-waiting'

function baseDetail(overrides: Partial<TournamentDetailSnapshot> = {}): TournamentDetailSnapshot {
  return {
    tournamentId,
    name: 'Solo Leave Realtime Harness Tournament',
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
    playerCapacity: 32,
    confirmedEntriesCount: 3,
    reservedPlacesCount: 0,
    occupiedPlacesCount: 3,
    completedTeamsCount: 1,
    formingTeamsCount: 1,
    availablePlaces: 29,
    isFull: false,
    startMode: 'fill',
    scheduledStartAt: null,
    fillExpiresAt: null,
    createdAt: '2026-08-29T10:00:00.000Z',
    prizePreview: {
      totalEntryFees: 40000, systemFee: 8000, prizePool: 32000,
      firstTeamPrize: 20800, secondTeamPrize: 11200, firstPlayerPrize: 10400, secondPlayerPrize: 5600,
      systemFeePercent: 20, winnerSharePercent: 65, runnerUpSharePercent: 35,
      financialRulesVersion: 'v1', persisted: true,
    } as any,
    isMine: false,
    viewer: {
      isParticipant: false, entryStatus: null, joinedAs: null,
      canJoinSolo: true, canInvitePartner: true, canLeave: false, canCancel: false,
      myPlacement: null, myPrizeAmount: null,
    },
    cancelReason: null, startedAt: null, finishedAt: null,
    myTeam: null, teams: [], rounds: [], myActiveMatch: null, myInterRoundWaiting: null,
    incomingPartnerInvite: null, outgoingPartnerInvite: null,
    viewerHasUnresolvedBotReplacement: false,
    ...overrides,
  } as TournamentDetailSnapshot
}

function member(profileId: string, name: string, joinedAs: 'solo' = 'solo') {
  return { profileId, displayName: name, avatarUrl: null, joinedAt: '2026-08-29T10:00:00.000Z', joinedAs }
}

function mount(root: HTMLElement, viewerProfileId: string, snapshots: TournamentDetailSnapshot[]) {
  let detailLoadCallCount = 0
  const controller = createLobbyFlowController({
    root,
    joinMatchmaking: () => {},
    leaveMatchmaking: () => {},
    onMatchFound: () => {},
    getAuthSession: () => ({ account: { role: 'player' }, profile: { profileId: viewerProfileId, displayName: viewerProfileId } as any }),
    onTournamentDetailLoad: async (_tournamentId: string) => {
      const snapshot = snapshots[Math.min(detailLoadCallCount, snapshots.length - 1)] as TournamentDetailSnapshot
      detailLoadCallCount += 1
      return { ok: true, tournament: snapshot }
    },
  } as any)
  controller.navigateToTournamentDetail(tournamentId)
  return {
    getRootText: () => root.textContent ?? '',
    getDetailLoadCallCount: () => detailLoadCallCount,
    getCurrentScreen: () => controller.getCurrentScreen(),
    simulatePush: (pushTournamentId: string) => {
      controller.handleServerMessage({ type: 'tournament_team_updated', tournamentId: pushTournamentId, teamId: abTeamId } as any)
    },
  }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

// ─── Scenario 1 (Case A): A+B complete, C waiting, B leaves -> A+C complete.
// Two independent already-open clients (A's own screen, C's own screen) —
// both must see the SAME new team composition after their own push. ───

const aRoot = document.createElement('div')
document.body.appendChild(aRoot)
const aClient = mount(aRoot, 'a', [
  baseDetail({
    viewer: { isParticipant: true, entryStatus: 'confirmed', joinedAs: 'solo', canJoinSolo: false, canInvitePartner: true, canLeave: true, canCancel: false, myPlacement: null, myPrizeAmount: null },
    myTeam: { teamId: abTeamId, status: 'complete', members: [member('a', 'A'), member('b', 'B')] },
    teams: [{ teamId: abTeamId, status: 'complete', members: [member('a', 'A'), member('b', 'B')] }],
  }),
  baseDetail({
    confirmedEntriesCount: 2,
    viewer: { isParticipant: true, entryStatus: 'confirmed', joinedAs: 'solo', canJoinSolo: false, canInvitePartner: true, canLeave: true, canCancel: false, myPlacement: null, myPrizeAmount: null },
    myTeam: { teamId: abTeamId, status: 'complete', members: [member('a', 'A'), member('c', 'C')] },
    teams: [{ teamId: abTeamId, status: 'complete', members: [member('a', 'A'), member('c', 'C')] }],
  }),
])

const cRoot = document.createElement('div')
document.body.appendChild(cRoot)
const cClient = mount(cRoot, 'c', [
  baseDetail({
    confirmedEntriesCount: 3,
    viewer: { isParticipant: true, entryStatus: 'confirmed', joinedAs: 'solo', canJoinSolo: false, canInvitePartner: true, canLeave: true, canCancel: false, myPlacement: null, myPrizeAmount: null },
    myTeam: { teamId: cOldTeamId, status: 'forming', members: [member('c', 'C')] },
    teams: [
      { teamId: abTeamId, status: 'complete', members: [member('a', 'A'), member('b', 'B')] },
      { teamId: cOldTeamId, status: 'forming', members: [member('c', 'C')] },
    ],
  }),
  baseDetail({
    confirmedEntriesCount: 2,
    viewer: { isParticipant: true, entryStatus: 'confirmed', joinedAs: 'solo', canJoinSolo: false, canInvitePartner: true, canLeave: true, canCancel: false, myPlacement: null, myPrizeAmount: null },
    myTeam: { teamId: abTeamId, status: 'complete', members: [member('a', 'A'), member('c', 'C')] },
    teams: [{ teamId: abTeamId, status: 'complete', members: [member('a', 'A'), member('c', 'C')] }],
  }),
])

// ─── Scenario 2 (Case B): A+B complete, B leaves, no C -> A becomes waiting
// solo (complete -> forming). Later, a future D join pushes forming -> complete
// again — same A client, third snapshot. ───

const aOnlyRoot = document.createElement('div')
document.body.appendChild(aOnlyRoot)
const aOnlyClient = mount(aOnlyRoot, 'a-only', [
  baseDetail({
    confirmedEntriesCount: 2,
    viewer: { isParticipant: true, entryStatus: 'confirmed', joinedAs: 'solo', canJoinSolo: false, canInvitePartner: true, canLeave: true, canCancel: false, myPlacement: null, myPrizeAmount: null },
    myTeam: { teamId: abTeamId, status: 'complete', members: [member('a-only', 'A'), member('b', 'B')] },
    teams: [{ teamId: abTeamId, status: 'complete', members: [member('a-only', 'A'), member('b', 'B')] }],
  }),
  baseDetail({
    confirmedEntriesCount: 1,
    viewer: { isParticipant: true, entryStatus: 'confirmed', joinedAs: 'solo', canJoinSolo: false, canInvitePartner: true, canLeave: true, canCancel: false, myPlacement: null, myPrizeAmount: null },
    myTeam: { teamId: abTeamId, status: 'forming', members: [member('a-only', 'A')] },
    teams: [{ teamId: abTeamId, status: 'forming', members: [member('a-only', 'A')] }],
  }),
  baseDetail({
    confirmedEntriesCount: 2,
    viewer: { isParticipant: true, entryStatus: 'confirmed', joinedAs: 'solo', canJoinSolo: false, canInvitePartner: true, canLeave: true, canCancel: false, myPlacement: null, myPrizeAmount: null },
    myTeam: { teamId: abTeamId, status: 'complete', members: [member('a-only', 'A'), member('d', 'D')] },
    teams: [{ teamId: abTeamId, status: 'complete', members: [member('a-only', 'A'), member('d', 'D')] }],
  }),
])

;(window as any).__tournamentSoloLeaveRealtimeHarness = {
  flush,
  aClient,
  cClient,
  aOnlyClient,
}
