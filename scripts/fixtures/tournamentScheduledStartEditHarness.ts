// Браузърна тестова "сглобка" за checkTournamentScheduledStartEditClient.ts —
// кара РЕАЛНИЯ createLobbyFlowController() (не мокап), зареден през Vite dev
// server, в истински браузър (Playwright). Огледален pattern на
// tournamentSoloAutoPairDetailRefreshHarness.ts.
//
// Три НЕЗАВИСИМИ controller instances на СЪЩИЯ (мокапнат) турнир:
//  - creator: вижда "Редактирай старт" бутона, отваря popup-а, редактира,
//    submit-ва -> проверява canonical fetchTournamentDetail refetch (§13) и
//    новото "Старт" значение (§14).
//  - nonCreator: same турнир, isMine=false -> бутонът НЕ трябва да е видим (§12).
//  - otherViewer: симулира ДРУГ вече отворен client (участник), който никога
//    не click-ва нищо — само получава реален tournament_schedule_updated push
//    (§17) и трябва да refetch-не/покаже новото време без action от негова страна.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import type { TournamentDetailSnapshot, TournamentSummarySnapshot } from '/src/app/network/createGameServerClient.ts'

const tournamentId = 'tour-schedule-edit-1'
const ORIGINAL_ISO = '2026-08-30T22:00:00.000Z'
const NEW_ISO = '2026-08-30T21:00:00.000Z'

function baseDetail(overrides: Partial<TournamentDetailSnapshot> = {}): TournamentDetailSnapshot {
  return {
    tournamentId,
    name: 'Schedule Edit Harness Tournament',
    creator: { profileId: 'creator-1', displayName: 'PIKABG', avatarUrl: null },
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
    startMode: 'scheduled',
    scheduledStartAt: ORIGINAL_ISO,
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

function mount(root: HTMLElement, profileId: string, isMine: boolean) {
  let detailLoadCallCount = 0
  let scheduleUpdateCallCount = 0
  let currentScheduledStartAt = ORIGINAL_ISO

  const controller = createLobbyFlowController({
    root,
    joinMatchmaking: () => {},
    leaveMatchmaking: () => {},
    onMatchFound: () => {},
    getAuthSession: () => ({
      account: { role: 'player' },
      profile: { profileId, displayName: profileId } as any,
    }),
    onTournamentDetailLoad: async (_tournamentId: string) => {
      detailLoadCallCount += 1
      return { ok: true, tournament: baseDetail({ isMine, scheduledStartAt: currentScheduledStartAt }) }
    },
    onTournamentScheduleUpdate: async (_tournamentId: string, scheduledStartAt: string) => {
      scheduleUpdateCallCount += 1
      currentScheduledStartAt = scheduledStartAt
      const { teams: _t, myTeam: _mt, rounds: _r, myActiveMatch: _ma, myInterRoundWaiting: _mi,
        incomingPartnerInvite: _ii, outgoingPartnerInvite: _oi, cancelReason: _cr, startedAt: _sa,
        finishedAt: _fa, viewerHasUnresolvedBotReplacement: _vb,
        ...summary } = baseDetail({ isMine, scheduledStartAt })
      return { ok: true, tournament: summary as TournamentSummarySnapshot }
    },
  } as any)

  controller.navigateToTournamentDetail(tournamentId)

  function simulateScheduleUpdatedPush(pushTournamentId: string, updatedIso: string): void {
    currentScheduledStartAt = updatedIso
    controller.handleServerMessage({
      type: 'tournament_schedule_updated',
      tournamentId: pushTournamentId,
    } as any)
  }

  return {
    getRootText: () => root.textContent ?? '',
    clickEditOpen: () => root.querySelector<HTMLButtonElement>('[data-tournament-schedule-edit-open="1"]')?.click(),
    hasEditButton: () => root.querySelector('[data-tournament-schedule-edit-open="1"]') !== null,
    setDateInput: (value: string) => {
      const input = root.querySelector<HTMLInputElement>('[data-tournament-schedule-edit-date="1"]')
      if (input === null) return
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    },
    setTimeInput: (value: string) => {
      const input = root.querySelector<HTMLInputElement>('[data-tournament-schedule-edit-time="1"]')
      if (input === null) return
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    },
    getDateInputValue: () => root.querySelector<HTMLInputElement>('[data-tournament-schedule-edit-date="1"]')?.value ?? null,
    getTimeInputValue: () => root.querySelector<HTMLInputElement>('[data-tournament-schedule-edit-time="1"]')?.value ?? null,
    clickSubmit: () => root.querySelector<HTMLButtonElement>('[data-tournament-schedule-edit-submit="1"]')?.click(),
    getDetailLoadCallCount: () => detailLoadCallCount,
    getScheduleUpdateCallCount: () => scheduleUpdateCallCount,
    getCurrentScreen: () => controller.getCurrentScreen(),
    simulateScheduleUpdatedPush,
    hasSuccessNotice: () => (root.textContent ?? '').includes('Началният час на турнира е променен.'),
    // Real DOM click on "← Назад към всички турнири" — goes through the SAME
    // showTournamentsList() lifecycle path a real user's click would (§
    // "UI lifecycle bug" regression: navigation away must clear the
    // transient success notice).
    clickBackToTournamentsList: () => root.querySelector<HTMLButtonElement>('[data-tournament-detail-back="1"]')?.click(),
    // Re-enters the SAME tournament via the SAME public navigateToTournamentDetail
    // entry point a real "Отвори" click uses — goes through showTournamentDetail()
    // again, proving the stale notice does not resurrect on re-entry.
    reNavigateToDetail: () => controller.navigateToTournamentDetail(tournamentId),
  }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

const creatorRoot = document.createElement('div')
document.body.appendChild(creatorRoot)
const creator = mount(creatorRoot, 'creator-1', true)

const nonCreatorRoot = document.createElement('div')
document.body.appendChild(nonCreatorRoot)
const nonCreator = mount(nonCreatorRoot, 'other-participant', false)

const otherViewerRoot = document.createElement('div')
document.body.appendChild(otherViewerRoot)
const otherViewer = mount(otherViewerRoot, 'other-open-client', false)

;(window as any).__tournamentScheduledStartEditHarness = {
  flush,
  tournamentId,
  originalIso: ORIGINAL_ISO,
  newIso: NEW_ISO,
  creator,
  nonCreator,
  otherViewer,
}
