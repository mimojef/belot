import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { renderTournamentsScreen } from '../../src/app/lobby/renderTournamentsScreen.js'
import type { LobbyScreenState } from '../../src/app/lobby/renderLobbyScreen.js'
import type { TournamentStatus, TournamentSummarySnapshot } from '../../src/app/network/createGameServerClient.js'

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

const projectRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--project-root='))?.slice('--project-root='.length)
    ?? join(process.cwd(), '..'),
)

const tournamentIds = {
  open: '11111111-1111-4111-8111-111111111111',
  active: '22222222-2222-4222-8222-222222222222',
  finished: '33333333-3333-4333-8333-333333333333',
  password: '44444444-4444-4444-8444-444444444444',
}

function tournament(overrides: Partial<TournamentSummarySnapshot> & { tournamentId: string; status: TournamentStatus }): TournamentSummarySnapshot {
  return {
    tournamentId: overrides.tournamentId,
    name: overrides.name ?? `Турнир ${overrides.tournamentId.slice(0, 4)}`,
    creator: overrides.creator ?? {
      profileId: 'creator-profile',
      displayName: 'Създател',
      avatarUrl: null,
    },
    visibility: overrides.visibility ?? 'public',
    requiresPassword: overrides.requiresPassword ?? false,
    status: overrides.status,
    statusLabel: overrides.statusLabel ?? overrides.status,
    championTeamId: overrides.championTeamId ?? null,
    runnerUpTeamId: overrides.runnerUpTeamId ?? null,
    settlementState: overrides.settlementState ?? 'pending',
    settledAt: overrides.settledAt ?? null,
    entryFee: overrides.entryFee ?? 5000,
    playerCapacity: overrides.playerCapacity ?? 8,
    confirmedEntriesCount: overrides.confirmedEntriesCount ?? 0,
    reservedPlacesCount: overrides.reservedPlacesCount ?? 0,
    occupiedPlacesCount: overrides.occupiedPlacesCount ?? 0,
    completedTeamsCount: overrides.completedTeamsCount ?? 0,
    formingTeamsCount: overrides.formingTeamsCount ?? 0,
    availablePlaces: overrides.availablePlaces ?? 8,
    isFull: overrides.isFull ?? false,
    startMode: overrides.startMode ?? 'fill',
    scheduledStartAt: overrides.scheduledStartAt ?? null,
    fillExpiresAt: overrides.fillExpiresAt ?? null,
    createdAt: overrides.createdAt ?? '2026-07-31T10:00:00.000Z',
    prizePreview: overrides.prizePreview ?? {
      totalEntryFees: 40000,
      systemFee: 8000,
      prizePool: 32000,
      firstTeamPrize: 20800,
      secondTeamPrize: 11200,
      firstPlayerPrize: 10400,
      secondPlayerPrize: 5600,
    },
    isMine: overrides.isMine ?? false,
    viewer: overrides.viewer ?? {
      isParticipant: false,
      canJoinSolo: false,
      canInvitePartner: false,
      canLeave: false,
      canCancel: false,
      joinedAs: null,
      entryStatus: null,
      unavailableReason: null,
      myPrizeAmount: null,
      myPlacement: null,
    },
  }
}

function stateFor(profileId: string | null, tournaments: TournamentSummarySnapshot[]): LobbyScreenState {
  return {
    profile: {
      profileId,
      displayName: profileId === 'creator-profile' ? 'Създател' : profileId === null ? '' : 'Играч',
      avatarUrl: null,
    },
    displayName: profileId === null ? '' : 'Играч',
    tournamentsFilter: 'all',
    tournamentsLoading: false,
    tournamentsErrorText: null,
    tournaments,
    tournamentPartnerInvites: [],
    tournamentCreatePopupOpen: false,
  } as LobbyScreenState
}

console.log('\ncheckTournamentCardNavigation')

const openTournament = tournament({
  tournamentId: tournamentIds.open,
  status: 'open',
  statusLabel: 'Записване',
  name: 'Отворен турнир',
})
const activeTournament = tournament({
  tournamentId: tournamentIds.active,
  status: 'semifinal_in_progress',
  statusLabel: 'Полуфинал',
  name: 'Започнал турнир',
})
const finishedTournament = tournament({
  tournamentId: tournamentIds.finished,
  status: 'finished',
  statusLabel: 'Приключил',
  name: 'Приключил турнир',
  settlementState: 'settled',
})
const passwordTournament = tournament({
  tournamentId: tournamentIds.password,
  status: 'open',
  statusLabel: 'Записване',
  name: 'Частен турнир',
  visibility: 'password',
  requiresPassword: true,
})

const allCardsHtml = renderTournamentsScreen(stateFor('viewer-profile', [
  openTournament,
  activeTournament,
  finishedTournament,
  passwordTournament,
]))

check('removed inactive soon placeholder from production list renderer', !allCardsHtml.includes('Записването ще бъде достъпно скоро'))
check('open card CTA is real detail navigation text', allCardsHtml.includes('Разгледай турнира'))
check('active card CTA follows tournament progress', allCardsHtml.includes('Проследи турнира'))
check('finished card CTA opens results', allCardsHtml.includes('Виж резултатите'))
check('open CTA uses the correct tournament ID', allCardsHtml.includes(`data-tournament-card="${tournamentIds.open}"`))
check('active CTA uses the correct tournament ID', allCardsHtml.includes(`data-tournament-card="${tournamentIds.active}"`))
check('finished CTA uses the correct tournament ID', allCardsHtml.includes(`data-tournament-card="${tournamentIds.finished}"`))
check('card title is a native button navigation target', /<button[\s\S]*data-tournament-card="11111111-1111-4111-8111-111111111111"[\s\S]*>Отворен турнир<\/button>/.test(allCardsHtml))
check('open card title and CTA both target detail', countNeedle(allCardsHtml, `data-tournament-card="${tournamentIds.open}"`) === 2)
check('list card does not expose direct solo join action', !allCardsHtml.includes('data-tournament-join-open="1"'))
check('list card does not expose direct partner picker action', !allCardsHtml.includes('data-tournament-partner-picker-open="1"'))
check('list card does not expose creator cancel action', !allCardsHtml.includes('data-tournament-cancel-open="1"'))
check('password-protected card opens detail/unlock flow without password in URL markup', allCardsHtml.includes(`data-tournament-card="${tournamentIds.password}"`) && !allCardsHtml.includes('passwordHash') && !allCardsHtml.includes('password_hash') && !allCardsHtml.includes('?password='))
check('CTA button is not disabled and keeps mobile touch target', /min-height:44px[\s\S]*width:100%[\s\S]*Разгледай турнира/.test(allCardsHtml) && !/<button[\s\S]*disabled[\s\S]*Разгледай турнира/.test(allCardsHtml))
check('CTA text can wrap without horizontal overflow pressure', allCardsHtml.includes('white-space:normal') && allCardsHtml.includes('line-height:1.2'))
check('card itself is not a nested interactive role button', !/<article[^>]*(data-tournament-card|role="button"|tabindex=)/.test(allCardsHtml))
check('guest can see the same public detail CTA', renderTournamentsScreen(stateFor(null, [openTournament])).includes('Разгледай турнира'))
check('creator can see the same detail CTA without auto-registration from card', renderTournamentsScreen(stateFor('creator-profile', [{ ...openTournament, isMine: true }])).includes('Разгледай турнира') && !renderTournamentsScreen(stateFor('creator-profile', [{ ...openTournament, isMine: true }])).includes('data-tournament-join-open="1"'))
check('other authenticated profile can see the same detail CTA', renderTournamentsScreen(stateFor('other-profile', [openTournament])).includes('Разгледай турнира'))

const renderLobbySource = stripSourceComments(await readFile(join(projectRoot, 'src', 'app', 'lobby', 'renderLobbyScreen.ts'), 'utf8'))
const controllerSource = stripSourceComments(await readFile(join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8'))
const tournamentsScreenSource = stripSourceComments(await readFile(join(projectRoot, 'src', 'app', 'lobby', 'renderTournamentsScreen.ts'), 'utf8'))
const showTournamentDetailSource = controllerSource.match(/function showTournamentDetail\(tournamentId: string\): void \{[\s\S]*?\n  \}/)?.[0] ?? ''

check('production renderer no longer contains the removed placeholder text', !tournamentsScreenSource.includes('Записването ще бъде достъпно скоро'))
check('production listener wires data-tournament-card clicks to onTournamentCardClick', renderLobbySource.includes("querySelectorAll<HTMLElement>('[data-tournament-card]") && renderLobbySource.includes('options.onTournamentCardClick(tournamentId)'))
check('controller card action opens existing detail flow', /onTournamentCardClick:\s*\(tournamentId\)\s*=>\s*\{\s*showTournamentDetail\(tournamentId\)\s*\}/.test(controllerSource))
check('detail flow navigates to /tournaments/:id with SPA history', controllerSource.includes('const targetUrl = `/tournaments/${encodeURIComponent(tournamentId)}`') && controllerSource.includes("history.pushState(null, '', targetUrl)"))
check('detail navigation does not use full page reload', showTournamentDetailSource.length > 0 && !/window\.location\.(href|assign|replace)/.test(showTournamentDetailSource))
check('direct /tournaments/:id route remains handled by existing route parser', controllerSource.includes('const tournamentDetailMatch = /^\\/tournaments\\/([^/]+)$/.exec(path)') && controllerSource.includes('showTournamentDetail(decodeURIComponent(tournamentDetailMatch[1]'))
check('deep-link refresh keeps /tournaments/:id as a known initial path', controllerSource.includes(String.raw`/^\/tournaments\/[^/]+$/.test(_loadPath)`))
check('detail screen keeps solo join action in detail only', tournamentsScreenSource.includes('data-tournament-join-open="1"') && tournamentsScreenSource.includes('Запиши се сам'))
check('detail screen keeps partner invite action in detail only', tournamentsScreenSource.includes('data-tournament-partner-picker-open="1"'))
check('detail screen keeps creator cancel action in detail only', tournamentsScreenSource.includes('data-tournament-cancel-open="1"'))
check('detail screen keeps registered participant leave action in detail only', tournamentsScreenSource.includes('data-tournament-leave-open="1"'))
check('password unlock remains POST-body flow on detail', tournamentsScreenSource.includes('data-tournament-unlock-submit="1"') && !controllerSource.match(/\/tournaments\/.*\$\{.*[Pp]assword/))
check('tournament admin UI route is not part of public card navigation', controllerSource.includes('/admin/tournaments') && !allCardsHtml.includes('/admin/tournaments'))

if (failed > 0) {
  console.error(`\ncheckTournamentCardNavigation failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckTournamentCardNavigation passed: ${passed} checks`)
