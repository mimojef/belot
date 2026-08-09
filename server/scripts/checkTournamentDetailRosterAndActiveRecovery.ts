import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { renderTournamentDetailScreen } from '../../src/app/lobby/renderTournamentsScreen.js'
import type { LobbyScreenState } from '../../src/app/lobby/renderLobbyScreen.js'
import type { TournamentDetailSnapshot, TournamentSummarySnapshot } from '../../src/app/network/createGameServerClient.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label}`)
  }
}

const projectRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--project-root='))?.slice('--project-root='.length)
    ?? join(process.cwd(), '..'),
)

const tournamentId = 'tournament-active-roster'
const viewerProfileId = 'viewer-profile'
const teamIds = ['team-a', 'team-b', 'team-c', 'team-d'] as const

function baseSummary(overrides: Partial<TournamentSummarySnapshot> = {}): TournamentSummarySnapshot {
  return {
    tournamentId,
    name: 'Активен тестов турнир',
    creator: { profileId: 'creator-profile', displayName: 'Създател', avatarUrl: null },
    visibility: 'public',
    requiresPassword: false,
    status: 'semifinal_in_progress',
    statusLabel: 'Полуфинал',
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
    fillExpiresAt: '2026-08-01T14:00:00.000Z',
    createdAt: '2026-08-01T13:00:00.000Z',
    prizePreview: {
      totalEntryFees: 40000,
      systemFee: 8000,
      prizePool: 32000,
      firstTeamPrize: 20800,
      secondTeamPrize: 11200,
      firstPlayerPrize: 10400,
      secondPlayerPrize: 5600,
    },
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
    ...overrides,
  }
}

function detail(overrides: Partial<TournamentDetailSnapshot> = {}): TournamentDetailSnapshot {
  return {
    ...baseSummary(overrides),
    cancelReason: null,
    startedAt: '2026-08-01T14:00:00.000Z',
    finishedAt: null,
    myTeam: {
      teamId: teamIds[3],
      status: 'complete',
      members: [
        { profileId: viewerProfileId, displayName: 'Test Human', avatarUrl: null, joinedAt: '2026-08-01T13:00:00.000Z', joinedAs: 'solo' },
        { profileId: 'bot-d2', displayName: 'Bot D2', avatarUrl: null, joinedAt: '2026-08-01T13:00:00.000Z', joinedAs: 'solo' },
      ],
    },
    teams: teamIds.map((teamId, index) => ({
      teamId,
      status: index === 0 ? 'eliminated' : 'complete',
      members: [
        {
          profileId: index === 3 ? viewerProfileId : `bot-${index + 1}-1`,
          displayName: index === 3 ? 'Test Human' : `Bot ${index + 1}1`,
          avatarUrl: null,
          joinedAt: '2026-08-01T13:00:00.000Z',
          joinedAs: 'solo',
        },
        { profileId: `bot-${index + 1}-2`, displayName: `Bot ${index + 1}2`, avatarUrl: null, joinedAt: '2026-08-01T13:00:00.000Z', joinedAs: 'solo' },
      ],
    })),
    rounds: [],
    myActiveMatch: {
      tournamentId,
      tournamentName: 'Активен тестов турнир',
      matchId: 'match-sf',
      roomId: 'room-sf',
      roundType: 'semifinal',
      seat: 'bottom',
      teamId: teamIds[3],
      partnerProfileId: 'bot-d2',
      opponentTeamId: teamIds[2],
      reconnectToken: 'reconnect-token',
      deadlineKind: 'first_match',
      attendanceDeadlineAt: '2026-08-01T14:00:05.000Z',
      gameStartAt: '2026-08-01T14:00:10.000Z',
    },
    incomingPartnerInvite: null,
    outgoingPartnerInvite: null,
    ...overrides,
  }
}

function state(tournament: TournamentDetailSnapshot, profileId: string | null): LobbyScreenState {
  return {
    currentScreen: 'tournament-detail',
    profile: { profileId, displayName: profileId ?? 'Spectator', avatarUrl: null },
    tournamentDetailId: tournament.tournamentId,
    tournamentDetailLoading: false,
    tournamentDetailErrorText: null,
    tournamentDetailRequiresPassword: false,
    tournamentDetailPasswordDraft: '',
    tournamentDetailUnlockBusy: false,
    tournamentDetailUnlockErrorText: null,
    tournamentDetail: tournament,
  } as LobbyScreenState
}

function htmlFor(tournament: TournamentDetailSnapshot, profileId: string | null = viewerProfileId): string {
  return renderTournamentDetailScreen(state(tournament, profileId))
}

const activeHtml = htmlFor(detail())
check('8 confirmed/roster entries render as 8 / 8', activeHtml.includes('8 / 8'))
check('all 4 teams render their 2 members', teamIds.every((_, index) => activeHtml.includes(`Bot ${index + 1}2`)) && activeHtml.includes('Test Human'))
check('authenticated active participant gets detail resume CTA', activeHtml.includes('data-tournament-enter-active-match="1"') && activeHtml.includes('Продължи играта'))

const spectatorHtml = htmlFor(detail({ myActiveMatch: null, myTeam: null, viewer: { ...baseSummary().viewer, isParticipant: false, entryStatus: null } }), null)
check('public spectator sees roster but no personal CTA', spectatorHtml.includes('8 / 8') && spectatorHtml.includes('Bot 12') && !spectatorHtml.includes('data-tournament-enter-active-match="1"'))

const eliminatedHtml = htmlFor(detail({
  status: 'finished',
  statusLabel: 'Завършен',
  myActiveMatch: null,
  viewer: { ...baseSummary().viewer, entryStatus: 'eliminated', myPlacement: 'eliminated', isParticipant: false },
}))
check('eliminated/completed participant does not get stale CTA', !eliminatedHtml.includes('data-tournament-enter-active-match="1"'))

const serverIndex = await readFile(join(projectRoot, 'server', 'src', 'index.ts'), 'utf8')
const tournamentDto = await readFile(join(projectRoot, 'server', 'src', 'tournament', 'tournamentDto.ts'), 'utf8')
const coordinator = await readFile(join(projectRoot, 'server', 'src', 'tournament', 'tournamentCoordinator.ts'), 'utf8')
const lobbyController = await readFile(join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8')
const activeRoomTypes = await readFile(join(projectRoot, 'src', 'app', 'activeRoom', 'activeRoomTypes.ts'), 'utf8')
const activeRoomController = await readFile(join(projectRoot, 'src', 'app', 'activeRoom', 'createActiveRoomFlowController.ts'), 'utf8')
const mainTs = await readFile(join(projectRoot, 'src', 'main.ts'), 'utf8')
const popup = await readFile(join(projectRoot, 'src', 'ui', 'notifications', 'tournamentMatchStartPopup.ts'), 'utf8')
const feederStrip = await readFile(join(projectRoot, 'src', 'ui', 'notifications', 'tournamentFeederWaitingStrip.ts'), 'utf8')

check('server detail/list occupancy includes eliminated roster entries', serverIndex.includes("status === 'eliminated'") && serverIndex.includes('isTournamentRosterEntryStatus(e.status)'))
check('server team DTO keeps eliminated members visible in roster', tournamentDto.includes("entry.status === 'eliminated'"))
check('myActiveMatch remains authoritative from tournamentCoordinator', serverIndex.includes('tournamentCoordinator?.getAssignmentForProfile(viewerProfileId) ?? null'))
check('hard refresh/detail load restores persistent popup from myActiveMatch', lobbyController.includes('onTournamentActiveMatchRecovered?.(result.tournament.myActiveMatch)') && mainTs.includes('tournamentMatchStartPopup.setAssignment(assignment)'))
check('bots_inserted participant can resume through stored replacement reconnect token', coordinator.includes('tournamentNoShowReplacement') && coordinator.includes('selectReplacementsForMatchStatement.all') && coordinator.includes('reconnect_token'))
check('persistent popup uses active tournament copy and resume CTA', popup.includes('Участвате в активен турнир') && popup.includes('Вашият мач вече е започнал.') && popup.includes('Продължи играта'))
check('room_resume_failed still clears stale tournament popup by room', mainTs.includes("if (message.type === 'room_resume_failed')") && mainTs.includes('tournamentMatchStartPopup.clearAssignmentForRoom(message.roomId)'))
check('semifinal winner transition carries immutable tournamentId even without feeder', activeRoomTypes.includes('tournamentId: string') && activeRoomController.includes('const tournamentId = activeRoomState.tournamentId') && activeRoomController.includes('options.onEnterWaitingForNextTournamentRound(context.feeder, context.tournamentId)'))
check('semifinal winner cleanup opens tournament detail by tournamentId, not generic lobby-only fallback', activeRoomController.includes('returnToLobbyFromMatchEnded()\n    if (context.wonRound)') && mainTs.includes('onEnterWaitingForNextTournamentRound: (_feeder, tournamentId)') && mainTs.includes('lobby?.showTournamentDetail(tournamentId)'))
check('waiting strip keeps sibling progress visible while tournament detail is open', feederStrip.includes('TournamentFeederWaitingState') && feederStrip.includes('scoreA') && feederStrip.includes('scoreB') && feederStrip.includes('Очаквате следващия си турнирен мач'))
check('popup is gated to resumable assignments with non-null reconnectToken', mainTs.includes('assignment !== null && assignment.reconnectToken !== null') && mainTs.includes('message.assignment.reconnectToken !== null'))
check('final assignment before 2.5s semifinal transition completes old result first', mainTs.includes("if (message.type === 'tournament_match_assigned')") && mainTs.indexOf('activeRoom.completePendingTournamentRoundResultTransition()') < mainTs.indexOf('tournamentMatchStartPopup.setAssignment(message.assignment)'))
check('final assignment path clears waiting strip then sets popup for the new room only', mainTs.includes('currentFeederWaitingState = null') && mainTs.includes('tournamentFeederWaitingStrip.setState(null)') && mainTs.includes('tournamentMatchStartPopup.setAssignment(message.assignment)') && mainTs.includes('tournamentMatchStartPopup.clearAssignmentForRoom(message.assignment.roomId)'))
check('old semifinal room cleanup cannot clear a different final assignment', popup.includes('if (current === null || current.roomId !== roomId) return'))
check('loss flow still returns through lobby without next-round waiting callback', activeRoomController.includes('if (context.wonRound)') && activeRoomController.includes("${wonRound ? 'Към турнира' : 'Към лобито'}"))
check('normal non-tournament match-ended flow remains on renderMatchEndedScreen', activeRoomController.includes('} else if (isShowingMatchEndedPhase && activeRoomState.game) {') && activeRoomController.includes('renderMatchEndedScreen('))
check('champion final result has tournament-specific title, score and prize/pending copy', activeRoomController.includes('Спечелихте турнира!') && activeRoomController.includes('Завършихте на второ място') && activeRoomController.includes('Наградата се обработва') && activeRoomController.includes('Лична награда:'))
check('final tournament result uses "Към турнира" and not the generic lobby action', activeRoomController.includes('data-tournament-final-result-detail="1"') && activeRoomController.includes('>Към турнира</button>') && activeRoomController.includes('continueFromTournamentFinalResult(tournamentId)'))
check('final result transition clears final-room assignment and opens tournament detail', activeRoomController.includes('function continueFromTournamentFinalResult(tournamentId: string): void') && activeRoomController.includes('returnToLobbyFromMatchEnded()') && mainTs.includes('onTournamentFinalResultContinue: (tournamentId) =>') && mainTs.includes('tournamentMatchStartPopup.setAssignment(null)') && mainTs.includes('lobby?.showTournamentDetail(tournamentId)'))
check('finished tournament detail never restores active popup without myActiveMatch token', mainTs.includes('assignment !== null && assignment.reconnectToken !== null') && popup.includes('clearAssignmentForRoom'))

console.log(`\ncheckTournamentDetailRosterAndActiveRecovery passed: ${passed} checks, failed: ${failed}`)
if (failed > 0) process.exit(1)
