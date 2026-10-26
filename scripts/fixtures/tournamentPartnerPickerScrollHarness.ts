// Р‘СЂР°СѓР·СЉСЂРЅР° С‚РµСЃС‚РѕРІР° "СЃРіР»РѕР±РєР°" Р·Р° checkTournamentPartnerPickerScroll.ts вЂ”
// РєР°СЂР° Р Р•РђР›РќРРЇ createLobbyFlowController() (РЅРµ РјРѕРєР°Рї), Р·Р°СЂРµРґРµРЅ РїСЂРµР· Vite
// dev server, РІ РёСЃС‚РёРЅСЃРєРё Р±СЂР°СѓР·СЉСЂ (Playwright). РћС‚РІР°СЂСЏ "РР·Р±РµСЂРё РїР°СЂС‚РЅСЊРѕСЂ"
// modal-a СЃ РґСЉР»СЉРі СЃРїРёСЃСЉРє РїСЂРёСЏС‚РµР»Рё РІ С‚СѓСЂРЅРёСЂ СЃ Р°РєС‚РёРІРµРЅ Р±СЂРѕСЏС‡ (fill СЂРµР¶РёРј),
// РїСЂРµРІСЉСЂС‚Р° СЃРїРёСЃСЉРєР° Рё РїРѕРґР°РІР° С„РѕРЅРѕРІРё СЃСЉР±РёС‚РёСЏ РїСЂРµР· Р Р•РђР›РќРРЇ handleServerMessage
// (Р›Р°С„С‡Рµ topic_unread_count_changed, tournament_team_updated) Рё РїСѓР±Р»РёС‡РЅРёСЏ
// render() (РєР°РєС‚Рѕ РіРѕ РІРёРєР° main.ts РїСЂРё РЅРµСЃРІСЉСЂР·Р°РЅРё РѕР±РЅРѕРІСЏРІР°РЅРёСЏ), Р·Р° РґР°
// РїСЂРѕРІРµСЂРё РґР°Р»Рё СЃРїРёСЃСЉРєСЉС‚ СЃ РїСЂРёСЏС‚РµР»Рё СЃРµ РїСЂРµСЃСЉР·РґР°РІР° / РЅСѓР»РёСЂР° СЃРєСЂРѕР»Р°.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import { LAFCHE_TOPIC_ID } from '/src/app/lobby/renderTopicsScreen.ts'
import type {
  TopicSnapshot,
  TournamentDetailSnapshot,
  TournamentPartnerCandidateSnapshot,
} from '/src/app/network/createGameServerClient.ts'

const TOURNAMENT_ID = 'tour-scroll-1'
const FRIENDS_COUNT = 40

const root = document.createElement('div')
document.body.appendChild(root)

const friendsCandidates: TournamentPartnerCandidateSnapshot[] = Array.from({ length: FRIENDS_COUNT }, (_, i) => ({
  profileId: `friend-${String(i).padStart(2, '0')}`,
  displayName: `Friend ${String(i).padStart(2, '0')}`,
  avatarUrl: null,
  online: false,
  eligible: true,
  unavailableReason: null,
}))

let detailOverrides: Partial<TournamentDetailSnapshot> = {}
let detailLoadCount = 0
let candidatesLoadCount = 0
let lastInviteSubmittedProfileId: string | null = null
const fillExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

function baseDetail(): TournamentDetailSnapshot {
  return {
    tournamentId: TOURNAMENT_ID,
    name: 'Scroll Harness Tournament',
    creator: { profileId: 'creator-1', displayName: 'Creator', avatarUrl: null },
    visibility: 'public',
    requiresPassword: false,
    status: 'open',
    statusLabel: 'РћС‚РІРѕСЂРµРЅ',
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
    formingTeamsCount: 0,
    availablePlaces: 7,
    isFull: false,
    // Fill СЂРµР¶РёРј СЃ fillExpiresAt вЂ” РґРµС‚Р°Р№Р»РЅРёСЏС‚ РµРєСЂР°РЅ РїРѕРєР°Р·РІР° СЃРµРєСѓРЅРґРµРЅ Р±СЂРѕСЏС‡
    // ("РР·С‚РёС‡Р° СЃР»РµРґ MM:SS"), С‚.Рµ. С‚РѕС‡РЅРѕ РїСЂРѕРґСѓРєС†РёРѕРЅРЅР°С‚Р° РєРѕРЅС„РёРіСѓСЂР°С†РёСЏ, РІ РєРѕСЏС‚Рѕ
    // РІСЃРµРєРё РїСЉР»РµРЅ render() РЅР° РµРєСЂР°РЅР° РїСЂРѕРёР·РІРµР¶РґР° СЂР°Р·Р»РёС‡РµРЅ HTML.
    startMode: 'fill',
    scheduledStartAt: null,
    fillExpiresAt,
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
    teams: [],
    rounds: [],
    myActiveMatch: null,
    myInterRoundWaiting: null,
    incomingPartnerInvite: null,
    outgoingPartnerInvite: null,
    ...detailOverrides,
  } as TournamentDetailSnapshot
}

function topic(topicId: string, isGeneral: boolean, unreadCount: number): TopicSnapshot {
  return {
    topicId,
    slug: topicId,
    title: topicId,
    description: null,
    isGeneral,
    createdByProfileId: null,
    status: 'active',
    sortOrder: 0,
    createdAt: new Date().toISOString(),
    unreadCount,
    lockedUntil: null,
    lockedReason: null,
  }
}

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: 'player' },
    profile: { profileId: 'me', displayName: 'Me' } as any,
  }) as any,
  onTopicsLoad: async () => ({ ok: true, topics: [topic('topic-general', true, 0), topic(LAFCHE_TOPIC_ID, false, 0)] }) as any,
  onTournamentDetailLoad: async (_tournamentId: string) => {
    detailLoadCount += 1
    return { ok: true, tournament: baseDetail() }
  },
  onTournamentPartnerCandidatesLoad: async (_tournamentId: string) => {
    candidatesLoadCount += 1
    return { ok: true, candidates: friendsCandidates }
  },
  onTournamentPartnerCandidatesSearch: async () => ({ ok: true, candidates: [] }),
  onTournamentPartnerInviteCreate: async (_tournamentId, inviteeProfileId, _password) => {
    lastInviteSubmittedProfileId = inviteeProfileId
    return {
      ok: true,
      invite: {
        inviteId: 'invite-1',
        tournamentId: TOURNAMENT_ID,
        teamId: 'team-1',
        inviterProfileId: 'me',
        inviteeProfileId,
        status: 'pending',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        popupDismissedAt: null,
        notificationReadAt: null,
        createdAt: new Date().toISOString(),
        respondedAt: null,
      } as any,
      walletBalance: 995000,
      tournament: baseDetail() as any,
    }
  },
})

// Р‘СЂРѕРё СЂРµР°Р»РЅРёС‚Рµ РїСЉР»РЅРё root rebuild-Рё (root.innerHTML = ... РїРѕРґРјРµРЅСЏ РґРµС†Р°С‚Р°
// РЅР° root-Р°) вЂ” "skip-if-unchanged" render() РЅРµ РјСѓС‚РёСЂР° root РёР·РѕР±С‰Рѕ.
let rootChildListMutations = 0
new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === 'childList' && record.target === root) rootChildListMutations += 1
  }
}).observe(root, { childList: true })

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

// scheduleRender() (topic badge fallback) Рµ debounce-РЅР°С‚ СЃ 50ms.
async function flushPastScheduledRender(): Promise<void> {
  await new Promise((r) => setTimeout(r, 80))
  await flush()
}

function getFriendsListEl(): HTMLElement | null {
  const firstFriend = root.querySelector<HTMLElement>(`[data-tournament-partner-invite="${friendsCandidates[0].profileId}"]`)
  return firstFriend?.parentElement ?? null
}

let lafcheUnread = 0

;(window as any).__tournamentPartnerPickerScrollHarness = {
  flush,
  flushPastScheduledRender,
  init: async () => {
    await controller.refreshTopicsDirectoryMetadata()
    controller.navigateToTournamentDetail(TOURNAMENT_ID)
    await flush()
  },
  openPicker: () => {
    root.querySelector<HTMLButtonElement>('[data-tournament-partner-picker-open="1"]')?.click()
  },
  closePicker: () => {
    root.querySelector<HTMLButtonElement>('[data-tournament-partner-picker-close="1"]')?.click()
  },
  isPickerOpen: () => root.querySelector('[data-tournament-partner-picker-backdrop="1"]') !== null,
  friendRowCount: () => getFriendsListEl()?.querySelectorAll('[data-tournament-partner-invite]').length ?? 0,
  getFriendsListNodeId: () => {
    const el = getFriendsListEl()
    if (el === null) return null
    if (!el.dataset.harnessNodeId) el.dataset.harnessNodeId = String(Math.random())
    return el.dataset.harnessNodeId
  },
  getFriendsListMetrics: () => {
    const el = getFriendsListEl()
    if (el === null) return null
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  },
  scrollFriendsListTo: (px: number) => {
    const el = getFriendsListEl()
    if (el === null) throw new Error('friends list not found')
    el.scrollTop = px
    el.dispatchEvent(new Event('scroll'))
    return el.scrollTop
  },
  scrollFriendsListToBottom: () => {
    const el = getFriendsListEl()
    if (el === null) throw new Error('friends list not found')
    el.scrollTop = el.scrollHeight
    el.dispatchEvent(new Event('scroll'))
    return el.scrollTop
  },
  // РќРµСЃРІСЉСЂР·Р°РЅ С„РѕРЅРѕРІ render вЂ” С‚РѕС‡РЅРѕ РєР°РєРІРѕС‚Рѕ main.ts РїСЂР°РІРё РѕС‚
  // loadPublicSettings/syncLobbyFriendships/... (lobby.render()).
  backgroundRender: () => controller.render(),
  // РќРѕРІ РїРѕСЃС‚ РІ "Р›Р°С„С‡Рµ" РѕС‚ РґСЂСѓРі РїРѕС‚СЂРµР±РёС‚РµР» -> СЃСЉСЂРІСЉСЂСЉС‚ РїСЂР°С‰Р°
  // topic_unread_count_changed РєСЉРј РІСЃРµРєРё directory subscriber (РІРёР¶
  // reconcileTopicUnreadForDirectorySubscribers РІ server/src/index.ts).
  lafchePost: () => {
    lafcheUnread += 1
    controller.handleServerMessage({ type: 'topic_unread_count_changed', topicId: LAFCHE_TOPIC_ID, unreadCount: lafcheUnread } as any)
  },
  // Р РµР°Р»РЅРѕ С‚СѓСЂРЅРёСЂРЅРѕ РѕР±РЅРѕРІСЏРІР°РЅРµ (РґСЂСѓРі СѓС‡Р°СЃС‚РЅРёРє СЃРµ Рµ Р·Р°РїРёСЃР°Р») вЂ” Р°РІС‚РѕСЂРёС‚РµС‚РµРЅ
  // refetch РЅР° РґРµС‚Р°Р№Р»Р° СЃ РїСЂРѕРјРµРЅРµРЅРё РґР°РЅРЅРё.
  tournamentTeamUpdated: (confirmedEntriesCount: number) => {
    detailOverrides = { ...detailOverrides, confirmedEntriesCount, occupiedPlacesCount: confirmedEntriesCount, availablePlaces: 8 - confirmedEntriesCount }
    controller.handleServerMessage({ type: 'tournament_team_updated', tournamentId: TOURNAMENT_ID } as any)
  },
  isFriendRowVisibleInList: (profileId: string) => {
    const list = getFriendsListEl()
    const row = list?.querySelector<HTMLElement>(`[data-tournament-partner-invite="${profileId}"]`) ?? null
    if (list === null || row === null) return false
    const listRect = list.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    return rowRect.top >= listRect.top - 1 && rowRect.bottom <= listRect.bottom + 1
  },
  clickFriend: (profileId: string) => {
    const list = getFriendsListEl()
    list?.querySelector<HTMLButtonElement>(`[data-tournament-partner-invite="${profileId}"]`)?.click()
  },
  getCountdownText: () => root.querySelector('[data-tournament-start-tertiary="1"]')?.textContent ?? null,
  getRootRebuildCount: () => rootChildListMutations,
  getDetailLoadCount: () => detailLoadCount,
  getCandidatesLoadCount: () => candidatesLoadCount,
  getLastInviteSubmittedProfileId: () => lastInviteSubmittedProfileId,
  lastFriendProfileId: () => friendsCandidates[friendsCandidates.length - 1].profileId,
}
