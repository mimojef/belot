import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { renderTournamentDetailScreen } from '../../src/app/lobby/renderTournamentsScreen.js'
import type { LobbyScreenState } from '../../src/app/lobby/renderLobbyScreen.js'
import type {
  TournamentDetailSnapshot,
  TournamentStatus,
  TournamentSummarySnapshot,
} from '../../src/app/network/createGameServerClient.js'

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

function countNeedle(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function stripSourceComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

function normalizeSpaces(value: string): string {
  return value.replace(/[\u00a0\u202f]/g, ' ')
}

function compactNumberText(value: string): string {
  return normalizeSpaces(value).replace(/\s+/g, '')
}

const projectRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--project-root='))?.slice('--project-root='.length)
    ?? join(process.cwd(), '..'),
)

const tournamentId = '55555555-5555-4555-8555-555555555555'

function baseSummary(overrides: Partial<TournamentSummarySnapshot> = {}): TournamentSummarySnapshot {
  return {
    tournamentId,
    name: 'Отворен турнир',
    creator: {
      profileId: 'creator-profile',
      displayName: 'Създател',
      avatarUrl: null,
    },
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
    confirmedEntriesCount: 0,
    reservedPlacesCount: 0,
    occupiedPlacesCount: 0,
    completedTeamsCount: 0,
    formingTeamsCount: 0,
    availablePlaces: 8,
    isFull: false,
    startMode: 'fill',
    scheduledStartAt: null,
    createdAt: '2026-07-31T10:00:00.000Z',
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
      persisted: false,
    },
    isMine: false,
    viewer: {
      isParticipant: false,
      canJoinSolo: true,
      canInvitePartner: true,
      canLeave: false,
      canCancel: false,
      joinedAs: null,
      entryStatus: null,
      myPrizeAmount: null,
      myPlacement: null,
    },
    ...overrides,
  }
}

function detail(overrides: Partial<TournamentDetailSnapshot> = {}): TournamentDetailSnapshot {
  const summary = baseSummary(overrides)
  return {
    ...summary,
    cancelReason: null,
    startedAt: null,
    finishedAt: null,
    myTeam: null,
    teams: [],
    rounds: [],
    myActiveMatch: null,
    incomingPartnerInvite: null,
    outgoingPartnerInvite: null,
    ...overrides,
  }
}

function state(tournament: TournamentDetailSnapshot, profileId = 'viewer-profile'): LobbyScreenState {
  return {
    profile: {
      profileId,
      displayName: profileId === 'creator-profile' ? 'Създател' : 'Играч',
      avatarUrl: null,
    },
    displayName: profileId === 'creator-profile' ? 'Създател' : 'Играч',
    tournamentDetailLoading: false,
    tournamentDetailErrorText: null,
    tournamentDetailRequiresPassword: false,
    tournamentDetailPasswordDraft: '',
    tournamentDetailUnlockBusy: false,
    tournamentDetailUnlockErrorText: null,
    tournamentDetailId: tournament.tournamentId,
    tournamentDetail: tournament,
    tournamentJoinConfirmOpen: false,
    tournamentJoinBusy: false,
    tournamentJoinErrorText: null,
    tournamentPartnerPickerOpen: false,
    tournamentPartnerPickerLoading: false,
    tournamentPartnerPickerErrorText: null,
    tournamentPartnerInviteBusy: false,
    tournamentPartnerInviteErrorText: null,
    tournamentPartnerInviteQuery: '',
    tournamentPartnerCandidates: [],
    tournamentLeaveConfirmOpen: false,
    tournamentLeaveBusy: false,
    tournamentLeaveErrorText: null,
    tournamentCancelConfirmOpen: false,
    tournamentCancelBusy: false,
    tournamentCancelErrorText: null,
  } as LobbyScreenState
}

function htmlFor(tournament: TournamentDetailSnapshot, profileId?: string): string {
  return renderTournamentDetailScreen(state(tournament, profileId))
}

console.log('\ncheckTournamentDetailEntryActions')

const openHtml = htmlFor(detail())
check('open detail shows solo entry action', openHtml.includes('data-tournament-join-open="1"') && openHtml.includes('Запиши се сам'))
check('open detail shows partner entry action', openHtml.includes('data-tournament-partner-picker-open="1"') && openHtml.includes('Участвай с партньор'))
check('entry buttons share one action container', openHtml.includes('data-tournament-entry-actions="1"') && countNeedle(openHtml, 'data-tournament-entry-actions="1"') === 1)
check('entry action container uses two equal grid columns', openHtml.includes('grid-template-columns:minmax(0,1fr) minmax(0,1fr)'))
check('entry buttons are side-by-side native buttons', /<div data-tournament-entry-actions="1"[\s\S]*<button type="button" data-tournament-join-open="1"[\s\S]*<button type="button" data-tournament-partner-picker-open="1"/.test(openHtml))
check('entry buttons have separate action identifiers', countNeedle(openHtml, 'data-tournament-join-open="1"') === 1 && countNeedle(openHtml, 'data-tournament-partner-picker-open="1"') === 1)
check('entry buttons keep mobile touch target and text wrapping', countNeedle(openHtml, 'min-height:44px') >= 2 && countNeedle(openHtml, 'white-space:normal') >= 2 && countNeedle(openHtml, 'min-width:0') >= 2)
check('prize label shows 80 percent from system fee percent', openHtml.includes('Награден фонд (80%)'))
check('old 90 percent prize-pool label is removed', !openHtml.includes('Награден фонд (90%)'))
check('financial amounts for entry 5000 remain unchanged', ['5000', '40000', '8000', '32000', '20800', '11200'].every((value) => compactNumberText(openHtml).includes(value)))
check('system fee label remains 20 percent', openHtml.includes('Системна такса (20%)'))
check('winner and runner-up shares remain 65 and 35 percent', openHtml.includes('Първо място (65%)') && openHtml.includes('Второ място (35%)'))

const creatorHtml = htmlFor(detail({
  isMine: true,
  viewer: {
    ...baseSummary().viewer,
    canJoinSolo: true,
    canInvitePartner: true,
    canCancel: true,
  },
}), 'creator-profile')
check('creator who is not participant sees both entry buttons', creatorHtml.includes('data-tournament-join-open="1"') && creatorHtml.includes('data-tournament-partner-picker-open="1"'))
check('creator cancel remains separate below entry row', creatorHtml.indexOf('data-tournament-entry-actions="1"') < creatorHtml.indexOf('data-tournament-cancel-open="1"'))
check('creator is not auto-registered by detail render', !creatorHtml.includes('Записан си самостоятелно') && !creatorHtml.includes('data-tournament-leave-open="1"'))

const otherHtml = htmlFor(detail(), 'other-profile')
check('other authenticated profile sees both entry buttons', otherHtml.includes('data-tournament-join-open="1"') && otherHtml.includes('data-tournament-partner-picker-open="1"'))

const participantHtml = htmlFor(detail({
  confirmedEntriesCount: 1,
  occupiedPlacesCount: 1,
  availablePlaces: 7,
  viewer: {
    ...baseSummary().viewer,
    isParticipant: true,
    canJoinSolo: false,
    canInvitePartner: true,
    canLeave: true,
    joinedAs: 'solo',
    entryStatus: 'confirmed',
  },
}))
check('registered participant does not see duplicate entry action row', !participantHtml.includes('data-tournament-entry-actions="1"') && !participantHtml.includes('Запиши се сам'))
check('registered participant keeps leave action when allowed', participantHtml.includes('data-tournament-leave-open="1"'))
check('registered participant can still use existing partner invite flow when allowed', participantHtml.includes('data-tournament-partner-picker-open="1"') && participantHtml.includes('Покани приятел за партньор'))

const pendingInviteHtml = htmlFor(detail({
  outgoingPartnerInvite: {
    inviteId: 'invite-1',
    tournamentId,
    teamId: 'team-1',
    inviterProfileId: 'viewer-profile',
    inviteeProfileId: 'friend-profile',
    inviter: { profileId: 'viewer-profile', displayName: 'Играч', avatarUrl: null },
    invitee: { profileId: 'friend-profile', displayName: 'Приятел', avatarUrl: null },
    status: 'pending',
    expiresAt: '2026-07-31T11:00:00.000Z',
    popupDismissedAt: null,
    notificationReadAt: null,
    createdAt: '2026-07-31T10:00:00.000Z',
  },
}))
check('pending partner invite suppresses duplicate entry actions', !pendingInviteHtml.includes('data-tournament-entry-actions="1"') && !pendingInviteHtml.includes('data-tournament-join-open="1"'))
check('pending partner invite shows current pending state', pendingInviteHtml.includes('Чакаме отговор'))

for (const status of ['starting', 'semifinal_in_progress', 'final_in_progress', 'finished'] as TournamentStatus[]) {
  const html = htmlFor(detail({
    status,
    statusLabel: status,
    viewer: {
      ...baseSummary().viewer,
      canJoinSolo: false,
      canInvitePartner: false,
    },
  }))
  check(`${status} does not show entry actions`, !html.includes('data-tournament-entry-actions="1"') && !html.includes('data-tournament-join-open="1"') && !html.includes('Участвай с партньор'))
}

const fullHtml = htmlFor(detail({
  isFull: true,
  occupiedPlacesCount: 8,
  availablePlaces: 0,
  confirmedEntriesCount: 8,
  viewer: {
    ...baseSummary().viewer,
    canJoinSolo: false,
    canInvitePartner: false,
  },
}))
check('full tournament does not show disallowed entry actions', !fullHtml.includes('data-tournament-entry-actions="1"') && !fullHtml.includes('data-tournament-join-open="1"') && !fullHtml.includes('data-tournament-partner-picker-open="1"'))
check('full tournament keeps a clear unavailable reason', fullHtml.includes('Турнирът е запълнен'))

const busyHtml = htmlFor(detail(), 'viewer-profile').replace('data-tournament-join-open="1"', 'data-tournament-join-open="1"')
const busyState = state(detail())
busyState.tournamentJoinBusy = true
busyState.tournamentPartnerInviteBusy = true
const busyRendered = renderTournamentDetailScreen(busyState)
check('loading state marks both entry buttons disabled and busy', countNeedle(busyRendered, 'disabled aria-busy="true"') >= 2)

const renderLobbySource = stripSourceComments(await readFile(join(projectRoot, 'src', 'app', 'lobby', 'renderLobbyScreen.ts'), 'utf8'))
const controllerSource = stripSourceComments(await readFile(join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8'))
const tournamentsScreenSource = stripSourceComments(await readFile(join(projectRoot, 'src', 'app', 'lobby', 'renderTournamentsScreen.ts'), 'utf8'))
const prizeRulesSource = await readFile(join(projectRoot, 'server', 'src', 'tournament', 'tournamentPrizeRules.ts'), 'utf8')
const economySource = await readFile(join(projectRoot, 'server', 'src', 'db', 'tournamentEconomyStore.ts'), 'utf8')
const cardNavigationSource = await readFile(join(projectRoot, 'server', 'scripts', 'checkTournamentCardNavigation.ts'), 'utf8')

check('solo action uses existing solo join listener', renderLobbySource.includes('[data-tournament-join-open="1"]') && renderLobbySource.includes('options.onTournamentJoinConfirmOpen'))
check('solo submit keeps double-submit guard', /async function submitTournamentJoin[\s\S]*state\.tournamentJoinBusy/.test(controllerSource))
check('solo submit uses existing onTournamentJoin flow', controllerSource.includes('options.onTournamentJoin(tournamentId, null)') && controllerSource.includes('mergeTournamentSummaryIntoDetail(result.tournament)'))
check('partner action uses existing partner picker listener', renderLobbySource.includes('[data-tournament-partner-picker-open="1"]') && renderLobbySource.includes('options.onTournamentPartnerPickerOpen'))
check('partner submit uses existing partner invite flow', controllerSource.includes('options.onTournamentPartnerInviteCreate(tournamentId, profileId, null)'))
check('list card still does not perform direct solo join', cardNavigationSource.includes('list card does not expose direct solo join action'))
check('production tournament UI does not contain old 90 percent label', !tournamentsScreenSource.includes('Награден фонд (90%)'))
check('production tournament UI contains corrected 80 percent label expression', tournamentsScreenSource.includes('Награден фонд (${escapeHtml(prizePoolPercentLabel(t))})'))
check('tournament prize rules were not edited in UI script', prizeRulesSource.includes('TOURNAMENT_SYSTEM_FEE_PERCENT = 20') && prizeRulesSource.includes('TOURNAMENT_WINNER_SHARE_PERCENT = 65'))
check('backend economy still references authoritative prize preview', economySource.includes('calculateTournamentPrizePreview') && economySource.includes('preview.systemFee'))

void busyHtml

if (failed > 0) {
  console.error(`\ncheckTournamentDetailEntryActions failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckTournamentDetailEntryActions passed: ${passed} checks`)
