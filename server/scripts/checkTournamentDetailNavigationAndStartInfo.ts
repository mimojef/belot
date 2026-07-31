import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { renderTournamentDetailScreen } from '../../src/app/lobby/renderTournamentsScreen.js'
import type { LobbyScreenState } from '../../src/app/lobby/renderLobbyScreen.js'
import type {
  TournamentDetailSnapshot,
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

function stripSourceComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const projectRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--project-root='))?.slice('--project-root='.length)
    ?? join(process.cwd(), '..'),
)

const tournamentId = '66666666-6666-4666-8666-666666666666'

function baseSummary(overrides: Partial<TournamentSummarySnapshot> = {}): TournamentSummarySnapshot {
  return {
    tournamentId,
    name: 'Навигационен турнир',
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
    confirmedEntriesCount: 2,
    reservedPlacesCount: 0,
    occupiedPlacesCount: 2,
    completedTeamsCount: 1,
    formingTeamsCount: 0,
    availablePlaces: 6,
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
      displayName: 'Играч',
      avatarUrl: null,
    },
    displayName: 'Играч',
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

console.log('\ncheckTournamentDetailNavigationAndStartInfo')

// ── A. Back button ──

const openHtml = htmlFor(detail())
check('detail screen renders back CTA', openHtml.includes('data-tournament-detail-back="1"'))
check('back CTA text contains "Назад към всички турнири"', openHtml.includes('Назад към всички турнири'))
check('back CTA is a native focusable button element', /<button[^>]*data-tournament-detail-back="1"/.test(openHtml))
check('back CTA has an accessible name', /data-tournament-detail-back="1"[^>]*aria-label="Назад към всички турнири"/.test(openHtml))
check('back CTA renders before the tournament title', openHtml.indexOf('data-tournament-detail-back="1"') < openHtml.indexOf(`>${'Навигационен турнир'}<`))

const renderLobbySourceForBack = await readFile(join(projectRoot, 'src', 'app', 'lobby', 'renderLobbyScreen.ts'), 'utf8')
check(
  'back CTA is wired to the existing tournaments-list navigation handler (SPA, not full reload)',
  renderLobbySourceForBack.includes('[data-tournament-detail-back="1"]') &&
  /data-tournament-detail-back="1"\]'\)[\s\S]{0,60}\?\.addEventListener\('click', options\.onTournamentsClick\)/.test(renderLobbySourceForBack),
)

const controllerSourceForBack = await readFile(join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8')
check(
  'onTournamentsClick calls showTournamentsList (SPA screen switch, no window.location.href)',
  /onTournamentsClick: \(\) => \{\s*void showTournamentsList\(\)/.test(controllerSourceForBack),
)
check('showTournamentsList does not perform a full page reload', !/showTournamentsList[\s\S]{0,400}window\.location\.href/.test(controllerSourceForBack))

// ── B. Scheduled start info ──

const scheduledFutureHtml = htmlFor(detail({
  startMode: 'scheduled',
  scheduledStartAt: new Date(Date.now() + 2 * 60 * 60 * 1000 + 90 * 1000).toISOString(),
}))
check('scheduled tournament shows a start card', scheduledFutureHtml.includes('data-tournament-start-card="1"'))
check('scheduled tournament shows formatted start date/time', /data-tournament-start-primary="1"[^>]*>\d{2}\.\d{2}\.\d{4}/.test(scheduledFutureHtml))
check('scheduled tournament shows a countdown secondary label', /data-tournament-start-secondary="1"[^>]*>Остават \d+ ч\. \d+ мин\./.test(scheduledFutureHtml))

const scheduledSoonHtml = htmlFor(detail({
  startMode: 'scheduled',
  scheduledStartAt: new Date(Date.now() + 5000).toISOString(),
}))
check('countdown for near-future timestamp does not go negative', !/Остават -/.test(scheduledSoonHtml))

const scheduledPastHtml = htmlFor(detail({
  startMode: 'scheduled',
  scheduledStartAt: new Date(Date.now() - 60_000).toISOString(),
}))
check('expired scheduled countdown shows safe post-deadline text, not a negative timer', scheduledPastHtml.includes('Очаква се започване...') && !/Остават -/.test(scheduledPastHtml))

// ── C. Fill tournament start info ──

const fillHtml = htmlFor(detail({
  startMode: 'fill',
  scheduledStartAt: null,
  confirmedEntriesCount: 2,
  playerCapacity: 8,
}))
check('fill tournament shows "При запълване"', fillHtml.includes('При запълване'))
check('fill tournament shows remaining participants count (6 of 8)', fillHtml.includes('Остават още 6 участници до старт'))
check('fill tournament does not render a countdown clock label', !fillHtml.includes('Остават') || !/Остават \d+ ч\./.test(fillHtml))

const fillReadyHtml = htmlFor(detail({
  startMode: 'fill',
  scheduledStartAt: null,
  confirmedEntriesCount: 8,
  playerCapacity: 8,
}))
check('full-ready fill tournament shows readiness text', fillReadyHtml.includes('Турнирът е готов за старт'))
check('full-ready fill tournament does not claim participants are still missing', !fillReadyHtml.includes('Остават още'))

// ── D. Started / finished ──

for (const status of ['starting', 'semifinal_in_progress', 'final_in_progress'] as const) {
  const html = htmlFor(detail({
    status,
    statusLabel: status,
    startMode: 'scheduled',
    scheduledStartAt: new Date(Date.now() + 3600_000).toISOString(),
  }))
  check(`${status} tournament does not show pre-start countdown`, !/Остават \d+ ч\./.test(html) && !html.includes('Очаква се започване...'))
  check(`${status} tournament shows an in-progress status text`, html.includes('Турнирът е в ход'))
}

const finishedHtml = htmlFor(detail({
  status: 'finished',
  statusLabel: 'Завършен',
  startMode: 'scheduled',
  scheduledStartAt: new Date(Date.now() - 3600_000).toISOString(),
}))
check('finished tournament does not show pre-start countdown', !/Остават \d+ ч\./.test(finishedHtml) && !finishedHtml.includes('Очаква се започване...'))
check('finished tournament shows final status text', finishedHtml.includes('Турнирът приключи'))

// ── E. Regression: existing detail content untouched ──

check('teams section rendering is still present', openHtml.includes('renderTournamentTeamsList') === false && openHtml.includes('Отбори'))
check('personal participation status block regression not broken (entry actions render for non-participant)', openHtml.includes('data-tournament-join-open="1"'))

const participantOpenHtml = htmlFor(detail({
  viewer: {
    ...baseSummary().viewer,
    isParticipant: true,
    canJoinSolo: false,
    canLeave: true,
    joinedAs: 'solo',
    entryStatus: 'confirmed',
  },
}))
check('personal solo status text still renders for a real solo participant', participantOpenHtml.includes('Записан си самостоятелно'))

const completeTeamHtml = htmlFor(detail({
  myTeam: { teamId: 'team-1', status: 'complete', members: [
    { profileId: 'viewer-profile', displayName: 'Играч', avatarUrl: null, joinedAt: '2026-07-31T10:00:00.000Z', joinedAs: 'solo' },
    { profileId: 'partner-profile', displayName: 'Партньор', avatarUrl: null, joinedAt: '2026-07-31T10:05:00.000Z', joinedAs: 'partner_invitee' },
  ] },
  teams: [{ teamId: 'team-1', status: 'complete', members: [
    { profileId: 'viewer-profile', displayName: 'Играч', avatarUrl: null, joinedAt: '2026-07-31T10:00:00.000Z', joinedAs: 'solo' },
    { profileId: 'partner-profile', displayName: 'Партньор', avatarUrl: null, joinedAt: '2026-07-31T10:05:00.000Z', joinedAs: 'partner_invitee' },
  ] }],
  viewer: {
    ...baseSummary().viewer,
    isParticipant: true,
    canJoinSolo: false,
    canLeave: true,
    joinedAs: 'partner_inviter',
    entryStatus: 'confirmed',
  },
}))
check('complete-team personal status regression not broken', completeTeamHtml.includes('Отборът ти е готов') && !completeTeamHtml.includes('Записан си самостоятелно'))
check('teams section regression not broken (renders complete team card)', completeTeamHtml.includes('Готов отбор'))

const entryActionsOpenHtml = htmlFor(detail())
check('entry actions regression not broken', entryActionsOpenHtml.includes('data-tournament-join-open="1"') && entryActionsOpenHtml.includes('data-tournament-partner-picker-open="1"'))

// ── Source-level wiring checks ──

const tournamentsScreenSource = stripSourceComments(await readFile(join(projectRoot, 'src', 'app', 'lobby', 'renderTournamentsScreen.ts'), 'utf8'))
const controllerSource = stripSourceComments(await readFile(join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8'))

check('start countdown formatter exists and is exported for reuse', tournamentsScreenSource.includes('export function formatTournamentStartCountdown'))
check('start info branching helper exists (no ad-hoc duplicated logic)', tournamentsScreenSource.includes('function computeTournamentStartInfo'))
check('controller uses a single setInterval-based tick loop for the tournament countdown', /tournamentStartCountdownIntervalId = window\.setInterval/.test(controllerSource))
check('controller does not start a second interval when one is already active for the same tournament/timestamp', /tournamentStartCountdownIntervalId !== null &&\s*tournamentStartCountdownTournamentId === tournamentId &&\s*tournamentStartCountdownScheduledAt === scheduledStartAt/.test(controllerSource))
check('controller clears the tournament countdown interval on screen change (no leaked interval)', controllerSource.includes('clearTournamentStartCountdownLoop()'))
check(
  'countdown interval is torn down whenever leaving the tournament-detail screen (covers matchmaking/private-room paths too)',
  /if \(state\.currentScreen !== 'tournament-detail'\) \{\s*clearTournamentStartCountdownLoop\(\)/.test(controllerSource),
)
check('no duplicate/second unmanaged interval variable was introduced for this feature', (controllerSource.match(/tournamentStartCountdownIntervalId: ReturnType<typeof setInterval> \| null = null/g) ?? []).length === 1)

// ── F. Layout / no horizontal overflow ──

check('start card uses box-sizing safe layout (no fixed desktop-only width)', !/data-tournament-start-card="1"[\s\S]{0,400}width:\d+px/.test(tournamentsScreenSource))
check('detail section keeps max-width + margin:0 auto (unchanged by this feature)', tournamentsScreenSource.includes('max-width:720px;margin:0 auto'))
check('back button text can wrap safely on narrow viewports (no white-space:nowrap forcing overflow)', !/data-tournament-detail-back="1"[\s\S]{0,300}white-space:nowrap/.test(tournamentsScreenSource))

if (failed > 0) {
  console.error(`\ncheckTournamentDetailNavigationAndStartInfo failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckTournamentDetailNavigationAndStartInfo passed: ${passed} checks`)
