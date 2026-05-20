import './style.css'

import { createActiveRoomFlowController } from './app/activeRoom/createActiveRoomFlowController'
import {
  isMatchEndedPreviewRequest,
  renderMatchEndedPreview,
} from './app/activeRoom/previewMatchEndedScreen'
import { createGameAudioController } from './app/audio/createGameAudioController'
import {
  createLobbyFlowController,
  type LobbyFlowController,
} from './app/lobby/createLobbyFlowController'
import type { AvatarCropSelection } from './app/lobby/renderLobbyScreen'
import {
  createGameServerClient,
  type AdminSettingsSnapshot,
  type AdminStatsSnapshot,
  type DailyRewardTierSnapshot,
  type ChatConversationSnapshot,
  type ChatMessageSnapshot,
  type CoinCheckoutResponse,
  type CoinPackageInput,
  type CoinPackageSnapshot,
  type CoinPackageStatus,
  type CoinPurchaseSnapshot,
  type FriendshipsSnapshot,
  type GameServerClient,
  type LeaderboardsSnapshot,
  type MissionTemplateInput,
  type MissionTemplateSnapshot,
  type PlayerMissionProgressSnapshot,
  type PlayerPublicProfileSnapshot,
  type SupportMessageSnapshot,
  type SupportConversationSnapshot,
} from './app/network/createGameServerClient'
import { createViewportResizeHandler } from './ui/layout/viewportStage'
import { createProfileLikeNotification } from './ui/notifications/profileLikeNotification'
import { createFriendRequestNotification } from './ui/notifications/friendRequestNotification'

const rootElementCandidate = document.querySelector<HTMLDivElement>('#app')

if (!rootElementCandidate) {
  throw new Error('Root element #app was not found.')
}

const rootElement: HTMLDivElement = rootElementCandidate

if (isMatchEndedPreviewRequest()) {
  const renderPreview = (): void => {
    renderMatchEndedPreview(rootElement)
  }

  const disposeViewportResizeHandler = createViewportResizeHandler(renderPreview)

  window.addEventListener('beforeunload', () => {
    disposeViewportResizeHandler()
  })

  renderPreview()
} else {
let client: GameServerClient
let lobby: LobbyFlowController
const gameAudio = createGameAudioController()

const likeNotifContainer = document.createElement('div')
likeNotifContainer.id = 'global-like-notifications'
document.body.appendChild(likeNotifContainer)

const likeNotification = createProfileLikeNotification({
  container: likeNotifContainer,
  onLike: async (profileId) => {
    await submitProfileLike(profileId)
  },
})

const friendReqNotifContainer = document.createElement('div')
friendReqNotifContainer.id = 'global-friend-request-notifications'
document.body.appendChild(friendReqNotifContainer)

const friendRequestNotification = createFriendRequestNotification({
  container: friendReqNotifContainer,
  onAccept: async (friendshipId) => {
    await submitFriendRequestAction(friendshipId, 'accept')
  },
  onReject: async (friendshipId) => {
    await submitFriendRequestAction(friendshipId, 'reject')
  },
})

const SERVER_RESTART_WAIT_MESSAGE = 'Изчаква се рестарт на сървъра.'
const SERVER_RESUME_WAIT_MESSAGE = 'Възстановяване на играта...'
const SERVER_CONNECTION_ERROR_MESSAGE = 'Възникна грешка при връзката със сървъра.'
const SERVER_RECONNECT_DELAY_MS = 1_000
const SERVER_RECONNECT_MAX_DELAY_MS = 5_000
const MAX_PROFILE_GALLERY_IMAGES = 6

let reconnectTimerId: number | null = null
let connectionErrorTimerId: number | null = null
let reconnectAttempt = 0
let isPageUnloading = false
let isRefreshingAuthConnection = false
let isSessionDisplaced = false
let currentAuthSession: AuthSession | null = null
let supportUnreadIntervalId: ReturnType<typeof setInterval> | null = null
let publicSignupBonusYellowCoins = 100000
let publicProfileNameChangePrice = 50000
let publicOnlinePlayersCount = 0

type AuthSession = {
  sessionId: string
  account: {
    accountId: string
    email: string
    role: string
    status: string
  }
  profile: PlayerPublicProfileSnapshot
}

type AuthResponse = {
  ok: boolean
  session?: AuthSession | null
  message?: string
}

type PlayersResponse = {
  ok: boolean
  players?: PlayerPublicProfileSnapshot[]
  message?: string
}

type LeaderboardsResponse = {
  ok: boolean
  leaderboards?: LeaderboardsSnapshot
  message?: string
}

type PublicSettingsResponse = {
  ok: boolean
  onlinePlayersCount?: number
  settings?: {
    signupBonusYellowCoins?: number
    profileNameChangePrice?: number
  }
  message?: string
}

type AdminSettingsResponse = {
  ok: boolean
  settings?: AdminSettingsSnapshot
  message?: string
}

type CoinPackagesResponse = {
  ok: boolean
  packages?: CoinPackageSnapshot[]
  package?: CoinPackageSnapshot
  message?: string
}

type CoinPurchasesResponse = {
  ok: boolean
  purchases?: CoinPurchaseSnapshot[]
  purchase?: CoinPurchaseSnapshot
  message?: string
}

type FriendshipsResponse = {
  ok: boolean
  friendships?: FriendshipsSnapshot
  message?: string
}

type ChatConversationsResponse = {
  ok: boolean
  conversations?: ChatConversationSnapshot[]
  message?: string
}

type ChatMessagesResponse = {
  ok: boolean
  messages?: ChatMessageSnapshot[]
  conversation?: ChatConversationSnapshot
  message?: string
}

type GiftCoinsResponse = {
  ok: boolean
  senderProfile?: PlayerPublicProfileSnapshot
  recipientProfile?: PlayerPublicProfileSnapshot
  message?: string
}

type DailyMissionsApiResponse = {
  ok: boolean
  missions?: PlayerMissionProgressSnapshot[]
  unclaimedCount?: number
  date?: string
  rewardYellowCoins?: number
  message?: string
}

type AdminMissionsApiResponse = {
  ok: boolean
  activeMissions?: MissionTemplateSnapshot[]
  stagedMissions?: MissionTemplateSnapshot[]
  mission?: MissionTemplateSnapshot
  message?: string
}

function getApiBaseUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  const host = window.location.hostname || 'localhost'
  return `${protocol}//${host}:3001`
}

async function readAuthResponse(response: Response): Promise<AuthResponse> {
  try {
    return (await response.json()) as AuthResponse
  } catch {
    return {
      ok: false,
      message: 'Невалиден отговор от сървъра.',
    }
  }
}

function startSupportUnreadPolling(): void {
  if (supportUnreadIntervalId !== null) return
  supportUnreadIntervalId = setInterval(() => {
    if (currentAuthSession !== null) {
      lobby.refreshSupportUnread()
    }
  }, 30_000)
}

function stopSupportUnreadPolling(): void {
  if (supportUnreadIntervalId === null) return
  clearInterval(supportUnreadIntervalId)
  supportUnreadIntervalId = null
}

function syncLobbyWithAuthSession(): void {
  if (currentAuthSession === null) {
    lobby.setFriendships(null)
    lobby.setChatConversations([])
    return
  }

  lobby.setDisplayName(currentAuthSession.profile.displayName)
  lobby.setLocalAvatarUrl(currentAuthSession.profile.avatarUrl)
}

async function syncLobbyFriendships(): Promise<void> {
  if (currentAuthSession === null) {
    lobby.setFriendships(null)
    return
  }

  const result = await loadFriendships()

  if (result.ok) {
    lobby.setFriendships(result.friendships)
  }
}

async function syncLobbyChatConversations(): Promise<void> {
  if (currentAuthSession === null) {
    lobby.setChatConversations([])
    return
  }

  const result = await loadChatConversations()

  if (result.ok) {
    lobby.setChatConversations(result.conversations)
  }
}

function refreshGameServerConnectionForAuth(): void {
  isRefreshingAuthConnection = true
  clearReconnectTimer()
  client.disconnect()
  lobby.setConnected(false)

  window.setTimeout(() => {
    if (!isRefreshingAuthConnection) {
      return
    }

    isRefreshingAuthConnection = false
    client.connect()
  }, 80)
}

async function loadAuthSession(): Promise<void> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/auth/me`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = await readAuthResponse(response)
    currentAuthSession = data.ok ? data.session ?? null : null
    syncLobbyWithAuthSession()
    if (currentAuthSession !== null) {
      lobby.refreshMissionsCount()
      lobby.refreshSupportUnread()
      startSupportUnreadPolling()
    } else {
      stopSupportUnreadPolling()
    }
    await syncLobbyFriendships()
    await syncLobbyChatConversations()
    lobby.render()
  } catch {
    currentAuthSession = null
  }
}

async function submitAuthRequest(
  endpoint: 'login' | 'register',
  body: Record<string, string>,
): Promise<string | null> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/auth/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(body),
    })
    const data = await readAuthResponse(response)

    if (!response.ok || !data.ok || !data.session) {
      return data.message ?? 'Заявката не беше успешна.'
    }

    currentAuthSession = data.session
    syncLobbyWithAuthSession()
    lobby.refreshSupportUnread()
    startSupportUnreadPolling()
    await syncLobbyFriendships()
    await syncLobbyChatConversations()
    refreshGameServerConnectionForAuth()
    return null
  } catch {
    return 'Няма връзка със сървъра за профили.'
  }
}

async function submitLogout(): Promise<void> {
  try {
    await fetch(`${getApiBaseUrl()}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    })
  } catch {
    // ignore network errors — proceed with local logout
  }
  currentAuthSession = null
  stopSupportUnreadPolling()
  syncLobbyWithAuthSession()
  lobby.render()
}

async function loadPlayersDirectory(): Promise<
  | { ok: true; players: PlayerPublicProfileSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/players`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as PlayersResponse

    if (!response.ok || !data.ok || !Array.isArray(data.players)) {
      return {
        ok: false,
        message: data.message ?? 'Списъкът с играчи не беше зареден.',
      }
    }

    return {
      ok: true,
      players: data.players,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за играчи.',
    }
  }
}

async function loadLeaderboards(): Promise<
  | { ok: true; leaderboards: LeaderboardsSnapshot }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/leaderboards`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as LeaderboardsResponse

    if (!response.ok || !data.ok || !data.leaderboards) {
      return {
        ok: false,
        message: data.message ?? 'Класациите не бяха заредени.',
      }
    }

    return {
      ok: true,
      leaderboards: data.leaderboards,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за класации.',
    }
  }
}

async function loadShopPackages(): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/shop/packages`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Магазинът не беше зареден.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за магазина.',
    }
  }
}

async function loadShopPurchases(): Promise<
  | { ok: true; purchases: CoinPurchaseSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/shop/purchases`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as CoinPurchasesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.purchases)) {
      return {
        ok: false,
        message: data.message ?? 'Историята на покупки не беше заредена.',
      }
    }

    return {
      ok: true,
      purchases: data.purchases,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за покупки.',
    }
  }
}

async function startShopPurchase(packageId: string): Promise<
  | { ok: true; purchases: CoinPurchaseSnapshot[]; message: string }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/shop/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ packageId }),
    })
    const data = (await response.json()) as CoinCheckoutResponse

    if (!response.ok) {
      return {
        ok: false,
        message: data.ok ? 'Stripe плащането не беше стартирано.' : data.message,
      }
    }

    if (!data.ok) {
      return {
        ok: false,
        message: data.message,
      }
    }

    window.location.assign(data.checkoutUrl)

    const purchasesResult = await loadShopPurchases()

    return {
      ok: true,
      purchases: purchasesResult.ok ? purchasesResult.purchases : [data.purchase],
      message: 'Пренасочване към Stripe Checkout...',
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за Stripe плащане.',
    }
  }
}

async function loadPublicSettings(): Promise<void> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/settings/public`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as PublicSettingsResponse
    const signupBonus = data.settings?.signupBonusYellowCoins
    const nameChangePrice = data.settings?.profileNameChangePrice

    if (response.ok && data.ok && typeof signupBonus === 'number' && Number.isInteger(signupBonus)) {
      publicSignupBonusYellowCoins = Math.max(0, signupBonus)
    }

    if (
      response.ok &&
      data.ok &&
      typeof nameChangePrice === 'number' &&
      Number.isInteger(nameChangePrice)
    ) {
      publicProfileNameChangePrice = Math.max(0, nameChangePrice)
    }

    if (response.ok && data.ok) {
      if (typeof data.onlinePlayersCount === 'number') {
        publicOnlinePlayersCount = data.onlinePlayersCount
      }
      lobby.render()
    }
  } catch {
    // Keep the local fallback.
  }
}

type DailyRewardsApiResponse = {
  ok: boolean
  activeTiers?: DailyRewardTierSnapshot[]
  stagedTiers?: DailyRewardTierSnapshot[]
  tiers?: DailyRewardTierSnapshot[]
  yellowCoinsAwarded?: number
  newBalance?: number | null
  message?: string
}

async function loadAdminDailyRewards(): Promise<
  | { ok: true; activeTiers: DailyRewardTierSnapshot[]; stagedTiers: DailyRewardTierSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/daily-rewards`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as DailyRewardsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.activeTiers) || !Array.isArray(data.stagedTiers)) {
      return { ok: false, message: data.message ?? 'Наградите не бяха заредени.' }
    }
    return { ok: true, activeTiers: data.activeTiers, stagedTiers: data.stagedTiers }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function addAdminDailyReward(yellowCoinsAmount: number): Promise<
  | { ok: true; activeTiers: DailyRewardTierSnapshot[]; stagedTiers: DailyRewardTierSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/daily-rewards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ yellowCoinsAmount }),
    })
    const data = (await response.json()) as DailyRewardsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.activeTiers) || !Array.isArray(data.stagedTiers)) {
      return { ok: false, message: data.message ?? 'Наградата не беше добавена.' }
    }
    return { ok: true, activeTiers: data.activeTiers, stagedTiers: data.stagedTiers }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function removeAdminDailyReward(tierId: string): Promise<
  | { ok: true; activeTiers: DailyRewardTierSnapshot[]; stagedTiers: DailyRewardTierSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/daily-rewards/${encodeURIComponent(tierId)}`,
      { method: 'DELETE', credentials: 'include' },
    )
    const data = (await response.json()) as DailyRewardsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.activeTiers) || !Array.isArray(data.stagedTiers)) {
      return { ok: false, message: data.message ?? 'Наградата не беше премахната.' }
    }
    return { ok: true, activeTiers: data.activeTiers, stagedTiers: data.stagedTiers }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadDailyRewards(): Promise<
  | { ok: true; tiers: DailyRewardTierSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/daily-rewards`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as DailyRewardsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.tiers)) {
      return { ok: false, message: data.message ?? 'Наградите не бяха заредени.' }
    }
    return { ok: true, tiers: data.tiers }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function claimDailyReward(tierId: string): Promise<
  | { ok: true; yellowCoinsAwarded: number; newBalance: number | null; tiers: DailyRewardTierSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/daily-rewards/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ tierId }),
    })
    const data = (await response.json()) as DailyRewardsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.tiers)) {
      return { ok: false, message: data.message ?? 'Наградата не беше взета.' }
    }
    const awarded = data.yellowCoinsAwarded ?? 0
    if (currentAuthSession !== null && typeof data.newBalance === 'number') {
      currentAuthSession = {
        ...currentAuthSession,
        profile: {
          ...currentAuthSession.profile,
          yellowCoinsBalance: data.newBalance,
        },
      }
      syncLobbyWithAuthSession()
    }
    return { ok: true, yellowCoinsAwarded: awarded, newBalance: data.newBalance ?? null, tiers: data.tiers }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminStats(): Promise<
  | { ok: true; stats: AdminStatsSnapshot }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/stats`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as { ok: boolean; stats?: AdminStatsSnapshot; message?: string }
    if (!response.ok || !data.ok || !data.stats) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на статистиките.' }
    }
    return { ok: true, stats: data.stats }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminSettings(): Promise<
  | { ok: true; settings: AdminSettingsSnapshot }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/settings`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as AdminSettingsResponse

    if (!response.ok || !data.ok || !data.settings) {
      return {
        ok: false,
        message: data.message ?? 'Админ настройките не бяха заредени.',
      }
    }

    publicSignupBonusYellowCoins = data.settings.signupBonusYellowCoins
    publicProfileNameChangePrice = data.settings.profileNameChangePrice
    return {
      ok: true,
      settings: data.settings,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за админ настройки.',
    }
  }
}

async function submitAdminSettings(
  settings: AdminSettingsSnapshot,
): Promise<
  | { ok: true; settings: AdminSettingsSnapshot }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(settings),
    })
    const data = (await response.json()) as AdminSettingsResponse

    if (!response.ok || !data.ok || !data.settings) {
      return {
        ok: false,
        message: data.message ?? 'Админ настройките не бяха записани.',
      }
    }

    publicSignupBonusYellowCoins = data.settings.signupBonusYellowCoins
    publicProfileNameChangePrice = data.settings.profileNameChangePrice
    return {
      ok: true,
      settings: data.settings,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за админ настройки.',
    }
  }
}

async function loadAdminCoinPackages(): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/coin-packages`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Админ пакетите не бяха заредени.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за админ пакетите.',
    }
  }
}

async function submitAdminCoinPackage(
  input: CoinPackageInput,
): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/coin-packages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(input),
    })
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Пакетът не беше записан.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за запис на пакет.',
    }
  }
}

async function setAdminCoinPackageStatus(
  packageId: string,
  status: CoinPackageStatus,
): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/coin-packages/${encodeURIComponent(packageId)}/status`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ status }),
      },
    )
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Статусът на пакета не беше променен.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за промяна на пакет.',
    }
  }
}

async function deleteAdminCoinPackage(packageId: string): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/coin-packages/${encodeURIComponent(packageId)}`,
      {
        method: 'DELETE',
        credentials: 'include',
      },
    )
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Пакетът не беше изтрит.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за изтриване на пакет.',
    }
  }
}

async function loadLobbyPackages(): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/lobby/packages`, {
      method: 'GET',
    })
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Лоби офертите не бяха заредени.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за лоби оферти.',
    }
  }
}

async function setAdminCoinPackageLobbyVisibility(
  packageId: string,
  showInLobby: boolean,
): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/coin-packages/${encodeURIComponent(packageId)}/lobby`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ showInLobby }),
      },
    )
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Лоби видимостта не беше променена.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за промяна на лоби видимост.',
    }
  }
}

async function readFriendshipsResponse(response: Response): Promise<FriendshipsResponse> {
  try {
    return (await response.json()) as FriendshipsResponse
  } catch {
    return {
      ok: false,
      message: 'Невалиден отговор от сървъра.',
    }
  }
}

async function loadFriendships(): Promise<
  | { ok: true; friendships: FriendshipsSnapshot }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/friends`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = await readFriendshipsResponse(response)

    if (!response.ok || !data.ok || !data.friendships) {
      return {
        ok: false,
        message: data.message ?? 'Приятелите не бяха заредени.',
      }
    }

    return {
      ok: true,
      friendships: data.friendships,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за приятели.',
    }
  }
}

async function submitFriendRequest(profileId: string): Promise<
  | { ok: true; friendships: FriendshipsSnapshot }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/friends/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ profileId }),
    })
    const data = await readFriendshipsResponse(response)

    if (!response.ok || !data.ok || !data.friendships) {
      return {
        ok: false,
        message: data.message ?? 'Поканата не беше изпратена.',
      }
    }

    return {
      ok: true,
      friendships: data.friendships,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за приятели.',
    }
  }
}

async function submitFriendAction(
  friendshipId: string,
  action: 'accept' | 'reject' | 'remove',
): Promise<
  | { ok: true; friendships: FriendshipsSnapshot }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/friends/${encodeURIComponent(friendshipId)}/${action}`,
      {
        method: 'POST',
        credentials: 'include',
      },
    )
    const data = await readFriendshipsResponse(response)

    if (!response.ok || !data.ok || !data.friendships) {
      return {
        ok: false,
        message: data.message ?? 'Поканата не беше обработена.',
      }
    }

    return {
      ok: true,
      friendships: data.friendships,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за приятели.',
    }
  }
}

async function submitProfileBlock(profileId: string): Promise<{ blocked: boolean } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/profiles/${encodeURIComponent(profileId)}/block`, {
      method: 'POST',
      credentials: 'include',
    })
    const data = await response.json() as { ok?: boolean; blocked?: boolean; message?: string }

    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Операцията не успя.' }
    }

    return { blocked: data.blocked ?? false }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function readChatConversationsResponse(
  response: Response,
): Promise<ChatConversationsResponse> {
  try {
    return (await response.json()) as ChatConversationsResponse
  } catch {
    return {
      ok: false,
      message: 'Невалиден отговор от сървъра.',
    }
  }
}

async function readChatMessagesResponse(
  response: Response,
): Promise<ChatMessagesResponse> {
  try {
    return (await response.json()) as ChatMessagesResponse
  } catch {
    return {
      ok: false,
      message: 'Невалиден отговор от сървъра.',
    }
  }
}

async function loadChatConversations(): Promise<
  | { ok: true; conversations: ChatConversationSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/chat/conversations`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = await readChatConversationsResponse(response)

    if (!response.ok || !data.ok || !Array.isArray(data.conversations)) {
      return {
        ok: false,
        message: data.message ?? 'Разговорите не бяха заредени.',
      }
    }

    return {
      ok: true,
      conversations: data.conversations,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за чат.',
    }
  }
}

async function loadChatMessages(friendshipId: string): Promise<
  | { ok: true; messages: ChatMessageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/chat/${encodeURIComponent(friendshipId)}/messages`,
      {
        method: 'GET',
        credentials: 'include',
      },
    )
    const data = await readChatMessagesResponse(response)

    if (!response.ok || !data.ok || !Array.isArray(data.messages)) {
      return {
        ok: false,
        message: data.message ?? 'Съобщенията не бяха заредени.',
      }
    }

    return {
      ok: true,
      messages: data.messages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за чат.',
    }
  }
}

async function sendChatMessage(friendshipId: string, body: string): Promise<
  | {
      ok: true
      conversation: ChatConversationSnapshot
      messages: ChatMessageSnapshot[]
    }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/chat/${encodeURIComponent(friendshipId)}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ body }),
      },
    )
    const data = await readChatMessagesResponse(response)

    if (
      !response.ok ||
      !data.ok ||
      !data.conversation ||
      !Array.isArray(data.messages)
    ) {
      return {
        ok: false,
        message: data.message ?? 'Съобщението не беше изпратено.',
      }
    }

    return {
      ok: true,
      conversation: data.conversation,
      messages: data.messages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за чат.',
    }
  }
}

type SupportMessagesApiResponse = {
  ok: boolean
  messages?: SupportMessageSnapshot[]
  unreadCount?: number
  message?: string
}

type SupportConversationsApiResponse = {
  ok: boolean
  conversations?: SupportConversationSnapshot[]
  message?: string
}

async function loadSupportMessages(): Promise<
  | { ok: true; messages: SupportMessageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/support/messages`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as SupportMessagesApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.messages)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане.' }
    }
    return { ok: true, messages: data.messages }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function sendSupportMessage(body: string): Promise<
  | { ok: true; messages: SupportMessageSnapshot[] }
  | { ok: false; code?: string; remainingMinutes?: number; message?: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/support/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ body, website: '' }),
    })
    const data = (await response.json()) as SupportMessagesApiResponse & { code?: string; remainingMinutes?: number }
    if (!response.ok || !data.ok) {
      return { ok: false, code: data.code, remainingMinutes: data.remainingMinutes, message: data.message }
    }
    if (!Array.isArray(data.messages)) {
      return { ok: false, message: 'Грешка при изпращане.' }
    }
    return { ok: true, messages: data.messages }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminSupportConversations(): Promise<
  | { ok: true; conversations: SupportConversationSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/support/admin/conversations`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as SupportConversationsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.conversations)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане.' }
    }
    return { ok: true, conversations: data.conversations }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminSupportMessages(profileId: string): Promise<
  | { ok: true; messages: SupportMessageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/support/admin/messages/${encodeURIComponent(profileId)}`,
      { method: 'GET', credentials: 'include' },
    )
    const data = (await response.json()) as SupportMessagesApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.messages)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане.' }
    }
    return { ok: true, messages: data.messages }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function sendAdminSupportReply(profileId: string, body: string): Promise<
  | { ok: true; messages: SupportMessageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/support/admin/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ profileId, body }),
    })
    const data = (await response.json()) as SupportMessagesApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.messages)) {
      return { ok: false, message: data.message ?? 'Грешка при изпращане.' }
    }
    return { ok: true, messages: data.messages }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function deleteUserSupportConversation(): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/support/messages`, {
      method: 'DELETE',
      credentials: 'include',
    })
    const data = (await response.json()) as { ok: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Грешка при изтриване.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function archiveAdminSupportConversation(profileId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/support/admin/conversations/${encodeURIComponent(profileId)}/archive`,
      { method: 'POST', credentials: 'include' },
    )
    const data = (await response.json()) as { ok: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Грешка при архивиране.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function submitProfileLike(
  profileId: string,
): Promise<{ ok: true; liked: boolean; likesCount: number } | { ok: false }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/profiles/${encodeURIComponent(profileId)}/like`, {
      method: 'POST',
      credentials: 'include',
    })
    const data = (await response.json()) as { ok: boolean; liked?: boolean; likesCount?: number }
    if (data.ok && typeof data.liked === 'boolean' && typeof data.likesCount === 'number') {
      return { ok: true, liked: data.liked, likesCount: data.likesCount }
    }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}

async function submitFriendRequestAction(
  friendshipId: string,
  action: 'accept' | 'reject',
): Promise<void> {
  try {
    await fetch(`${getApiBaseUrl()}/api/friends/${encodeURIComponent(friendshipId)}/${action}`, {
      method: 'POST',
      credentials: 'include',
    })
  } catch {
    // ignore
  }
}

async function submitGiftCoins(friendshipId: string, amount: number): Promise<
  | {
      ok: true
      senderProfile: PlayerPublicProfileSnapshot
      recipientProfile: PlayerPublicProfileSnapshot
    }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/friends/${encodeURIComponent(friendshipId)}/gift-coins`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ amount }),
      },
    )
    const data = (await response.json()) as GiftCoinsResponse

    if (!response.ok || !data.ok || !data.senderProfile || !data.recipientProfile) {
      return {
        ok: false,
        message: data.message ?? 'Подаръкът не беше изпратен.',
      }
    }

    if (currentAuthSession !== null) {
      currentAuthSession = {
        ...currentAuthSession,
        profile: data.senderProfile,
      }
      syncLobbyWithAuthSession()
    }

    return {
      ok: true,
      senderProfile: data.senderProfile,
      recipientProfile: data.recipientProfile,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за подарък.',
    }
  }
}

function validateImageFile(file: File): string | null {
  const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])

  if (!allowedTypes.has(file.type)) {
    return 'Позволени са само jpg, png и webp снимки.'
  }

  if (file.size > 10_000_000) {
    return 'Снимката трябва да е до 10 МБ.'
  }

  return null
}

async function fileToDataUrl(file: File): Promise<string> {
  const validationError = validateImageFile(file)

  if (validationError !== null) {
    throw new Error(validationError ?? undefined)
  }

  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      resolve(String(reader.result ?? ''))
    })
    reader.addEventListener('error', () => {
      reject(new Error('Снимката не можа да бъде прочетена.'))
    })
    reader.readAsDataURL(file)
  })
}

async function imageFileToServerUploadDataUrl(
  file: File,
  _options: { mode: 'avatar' | 'gallery' },
): Promise<string> {
  return fileToDataUrl(file)
}

async function submitProfileImageData(
  endpoint: 'avatar' | 'gallery',
  imageDataUrl: string,
  crop?: AvatarCropSelection,
): Promise<AuthResponse> {
  const response = await fetch(`${getApiBaseUrl()}/api/profile/me/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      imageDataUrl,
      ...(crop
        ? {
            cropX: crop.x,
            cropY: crop.y,
            cropSize: crop.size,
          }
        : {}),
    }),
  })
  const data = await readAuthResponse(response)

  if (!response.ok || !data.ok || !data.session) {
    throw new Error(data.message ?? 'Профилът не беше обновен.')
  }

  return data
}

async function deleteProfileGalleryImage(imageId: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/profile/me/gallery/${encodeURIComponent(imageId)}`,
      {
        method: 'DELETE',
        credentials: 'include',
      },
    )
    const data = await readAuthResponse(response)

    if (!response.ok || !data.ok || !data.session) {
      return data.message ?? 'Снимката не беше изтрита.'
    }

    currentAuthSession = data.session
    syncLobbyWithAuthSession()
    return null
  } catch {
    return 'Няма връзка със сървъра за профили.'
  }
}

async function submitPresetAvatarUrl(avatarUrl: string): Promise<string | null> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/profile/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ avatarUrl }),
    })
    const data = await readAuthResponse(response)

    if (!response.ok || !data.ok || !data.session) {
      return data.message ?? 'Аватарът не беше обновен.'
    }

    currentAuthSession = data.session
    syncLobbyWithAuthSession()
    return null
  } catch {
    return 'Няма връзка със сървъра.'
  }
}

async function submitProfileNameChange(displayName: string): Promise<string | null> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/profile/me/display-name`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ displayName }),
    })
    const data = await readAuthResponse(response)

    if (!response.ok || !data.ok || !data.session) {
      return data.message ?? 'Името не беше сменено.'
    }

    currentAuthSession = data.session
    syncLobbyWithAuthSession()
    return null
  } catch {
    return 'Няма връзка със сървъра за смяна на име.'
  }
}

async function submitChangePassword(
  currentPassword: string,
  newPassword: string,
): Promise<string | null> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/account/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ currentPassword, newPassword }),
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return data.message ?? 'Паролата не беше сменена.'
    }
    return null
  } catch {
    return 'Няма връзка със сървъра.'
  }
}

async function submitProfileUpdate(
  avatarFile: File | null,
  avatarCrop: AvatarCropSelection | null,
  galleryFiles: File[],
): Promise<string | null> {
  if (avatarFile === null && galleryFiles.length === 0) {
    return null
  }

  try {
    const currentGalleryCount =
      currentAuthSession?.profile.galleryImages.length ?? 0
    const remainingGallerySlots = Math.max(
      0,
      MAX_PROFILE_GALLERY_IMAGES - currentGalleryCount,
    )

    if (galleryFiles.length > remainingGallerySlots) {
      return `Галерията може да има най-много ${MAX_PROFILE_GALLERY_IMAGES} снимки.`
    }

    if (avatarFile !== null) {
      if (avatarCrop === null) {
        return 'Очертай квадрат върху снимката за аватар.'
      }

      const imageDataUrl = await fileToDataUrl(avatarFile)
      const data = await submitProfileImageData('avatar', imageDataUrl, avatarCrop)
      currentAuthSession = data.session ?? currentAuthSession
    }

    for (const galleryFile of galleryFiles.slice(0, remainingGallerySlots)) {
      const imageDataUrl = await imageFileToServerUploadDataUrl(galleryFile, {
        mode: 'gallery',
      })
      const data = await submitProfileImageData('gallery', imageDataUrl)
      currentAuthSession = data.session ?? currentAuthSession
    }

    syncLobbyWithAuthSession()
    return null
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'Няма връзка със сървъра за профили.'
  }
}

async function loadDailyMissions(): Promise<
  | { ok: true; missions: PlayerMissionProgressSnapshot[]; unclaimedCount: number; date: string }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/missions/daily`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as DailyMissionsApiResponse

    if (!response.ok || !data.ok || !Array.isArray(data.missions)) {
      return { ok: false, message: data.message ?? 'Мисиите не бяха заредени.' }
    }

    return { ok: true, missions: data.missions, unclaimedCount: data.unclaimedCount ?? 0, date: data.date ?? '' }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра за мисии.' }
  }
}

async function claimMissionReward(missionId: string): Promise<
  | { ok: true; rewardYellowCoins: number; missions: PlayerMissionProgressSnapshot[]; unclaimedCount: number }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/missions/${encodeURIComponent(missionId)}/claim`,
      { method: 'POST', credentials: 'include' },
    )
    const data = (await response.json()) as DailyMissionsApiResponse

    if (!response.ok || !data.ok || !Array.isArray(data.missions)) {
      return { ok: false, message: data.message ?? 'Наградата не беше взета.' }
    }

    if (currentAuthSession !== null && typeof data.rewardYellowCoins === 'number') {
      currentAuthSession = {
        ...currentAuthSession,
        profile: {
          ...currentAuthSession.profile,
          yellowCoinsBalance:
            (currentAuthSession.profile.yellowCoinsBalance ?? 0) + data.rewardYellowCoins,
        },
      }
      syncLobbyWithAuthSession()
    }

    return {
      ok: true,
      rewardYellowCoins: data.rewardYellowCoins ?? 0,
      missions: data.missions,
      unclaimedCount: data.unclaimedCount ?? 0,
    }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра за вземане на награда.' }
  }
}

type AdminMissionsBothLists = { activeMissions: MissionTemplateSnapshot[]; stagedMissions: MissionTemplateSnapshot[] }

async function loadAdminMissions(): Promise<
  | ({ ok: true } & AdminMissionsBothLists)
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/missions`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as AdminMissionsApiResponse

    if (!response.ok || !data.ok || !Array.isArray(data.activeMissions) || !Array.isArray(data.stagedMissions)) {
      return { ok: false, message: data.message ?? 'Мисиите не бяха заредени.' }
    }

    return { ok: true, activeMissions: data.activeMissions, stagedMissions: data.stagedMissions }
  } catch {
    return { ok: false, message: 'Няма връзка.' }
  }
}

async function submitAdminMission(
  input: MissionTemplateInput,
): Promise<({ ok: true } & AdminMissionsBothLists) | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/missions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
    })
    const data = (await response.json()) as AdminMissionsApiResponse

    if (!response.ok || !data.ok || !Array.isArray(data.activeMissions) || !Array.isArray(data.stagedMissions)) {
      return { ok: false, message: data.message ?? 'Мисията не беше записана.' }
    }

    return { ok: true, activeMissions: data.activeMissions, stagedMissions: data.stagedMissions }
  } catch {
    return { ok: false, message: 'Няма връзка.' }
  }
}

async function setAdminMissionActive(
  missionId: string,
  isActive: boolean,
): Promise<({ ok: true } & AdminMissionsBothLists) | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/missions/${encodeURIComponent(missionId)}/active`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ isActive }),
      },
    )
    const data = (await response.json()) as AdminMissionsApiResponse

    if (!response.ok || !data.ok || !Array.isArray(data.activeMissions) || !Array.isArray(data.stagedMissions)) {
      return { ok: false, message: data.message ?? 'Активността не беше променена.' }
    }

    return { ok: true, activeMissions: data.activeMissions, stagedMissions: data.stagedMissions }
  } catch {
    return { ok: false, message: 'Няма връзка.' }
  }
}

async function deleteAdminMission(
  missionId: string,
): Promise<({ ok: true } & AdminMissionsBothLists) | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/missions/${encodeURIComponent(missionId)}`,
      { method: 'DELETE', credentials: 'include' },
    )
    const data = (await response.json()) as AdminMissionsApiResponse

    if (!response.ok || !data.ok || !Array.isArray(data.activeMissions) || !Array.isArray(data.stagedMissions)) {
      return { ok: false, message: data.message ?? 'Мисията не беше изтрита.' }
    }

    return { ok: true, activeMissions: data.activeMissions, stagedMissions: data.stagedMissions }
  } catch {
    return { ok: false, message: 'Няма връзка.' }
  }
}

lobby = createLobbyFlowController({
  root: rootElement,
  joinMatchmaking: (stake, displayName) => {
    client.joinMatchmaking(stake, displayName)
  },
  leaveMatchmaking: () => {
    client.leaveMatchmaking()
  },
  onMatchFound: (message) => {
    activeRoom.enterActiveRoom(message)
  },
  getAuthSession: () => currentAuthSession,
  onLoginSubmit: (email, password) =>
    submitAuthRequest('login', {
      email,
      password,
    }),
  onRegisterSubmit: (displayName, email, password, gender) =>
    submitAuthRequest('register', {
      displayName,
      email,
      password,
      ...(gender !== null ? { gender } : {}),
    }),
  onProfileEditSubmit: (avatarFile, avatarCrop, galleryFiles) =>
    submitProfileUpdate(avatarFile, avatarCrop, galleryFiles),
  onPresetAvatarApply: (avatarUrl) => submitPresetAvatarUrl(avatarUrl),
  getSignupBonusYellowCoins: () => publicSignupBonusYellowCoins,
  getOnlinePlayersCount: () => publicOnlinePlayersCount,
  getProfileNameChangePrice: () => publicProfileNameChangePrice,
  getApiBaseUrl: () => getApiBaseUrl(),
  onProfileGalleryDelete: (imageId) => deleteProfileGalleryImage(imageId),
  onProfileNameChangeSubmit: (displayName) => submitProfileNameChange(displayName),
  onChangePasswordSubmit: (currentPassword, newPassword) => submitChangePassword(currentPassword, newPassword),
  onPlayersLoad: () => loadPlayersDirectory(),
  onLeaderboardsLoad: () => loadLeaderboards(),
  onLobbyPackagesLoad: () => loadLobbyPackages(),
  onShopPackagesLoad: () => loadShopPackages(),
  onShopPurchasesLoad: () => loadShopPurchases(),
  onShopPurchaseStart: (packageId) => startShopPurchase(packageId),
  onAdminDailyRewardsLoad: () => loadAdminDailyRewards(),
  onAdminDailyRewardAdd: (amount) => addAdminDailyReward(amount),
  onAdminDailyRewardRemove: (tierId) => removeAdminDailyReward(tierId),
  onDailyRewardsLoad: () => loadDailyRewards(),
  onDailyRewardClaim: (tierId) => claimDailyReward(tierId),
  onAdminStatsLoad: () => loadAdminStats(),
  onAdminSettingsLoad: () => loadAdminSettings(),
  onAdminSettingsSubmit: (settings) => submitAdminSettings(settings),
  onAdminCoinPackagesLoad: () => loadAdminCoinPackages(),
  onAdminCoinPackageSubmit: (input) => submitAdminCoinPackage(input),
  onAdminCoinPackageStatusChange: (packageId, status) =>
    setAdminCoinPackageStatus(packageId, status),
  onAdminCoinPackageDelete: (packageId) => deleteAdminCoinPackage(packageId),
  onAdminCoinPackageLobbyToggle: (packageId, showInLobby) =>
    setAdminCoinPackageLobbyVisibility(packageId, showInLobby),
  onFriendshipsLoad: () => loadFriendships(),
  onFriendRequestSubmit: (profileId) => submitFriendRequest(profileId),
  onFriendAccept: (friendshipId) => submitFriendAction(friendshipId, 'accept'),
  onFriendReject: (friendshipId) => submitFriendAction(friendshipId, 'reject'),
  onFriendRemove: (friendshipId) => submitFriendAction(friendshipId, 'remove'),
  onBlockProfile: (profileId) => submitProfileBlock(profileId),
  onLoadBlockedPlayers: async () => {
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/blocks`, { credentials: 'include' })
      const data = await response.json() as { ok?: boolean; profiles?: PlayerPublicProfileSnapshot[]; count?: number; limit?: number; message?: string }
      if (!response.ok || !data.ok) return { ok: false, message: data.message ?? 'Грешка при зареждане.' }
      return { ok: true, profiles: data.profiles ?? [], count: data.count ?? 0, limit: data.limit ?? 50 }
    } catch {
      return { ok: false, message: 'Няма връзка със сървъра.' }
    }
  },
  onLikeProfile: (profileId) => submitProfileLike(profileId),
  onGiftCoinsSubmit: (friendshipId, amount) => submitGiftCoins(friendshipId, amount),
  onChatConversationsLoad: () => loadChatConversations(),
  onChatMessagesLoad: (friendshipId) => loadChatMessages(friendshipId),
  onChatSend: (friendshipId, body) => sendChatMessage(friendshipId, body),
  onLogout: () => submitLogout(),
  onDailyMissionsLoad: () => loadDailyMissions(),
  onMissionClaim: (missionId) => claimMissionReward(missionId),
  onAdminMissionsLoad: () => loadAdminMissions(),
  onAdminMissionSubmit: (input) => submitAdminMission(input),
  onAdminMissionActiveToggle: (missionId, isActive) => setAdminMissionActive(missionId, isActive),
  onAdminMissionDelete: (missionId) => deleteAdminMission(missionId),
  onPrivateRoomsOpen: () => { client.requestPrivateRoomsList() },
  onPrivateRoomsClose: () => {},
  onPrivateRoomCreate: (stake, isLocked) => { client.createPrivateRoom(stake, isLocked) },
  onPrivateRoomJoin: (privateRoomId) => { client.joinPrivateRoom(privateRoomId) },
  onPrivateRoomLeave: () => { client.leavePrivateRoom() },
  onPrivateRoomInvite: (toProfiles) => { client.inviteToPrivateRoom(toProfiles) },
  onCancelPrivateRoomInvite: (inviteId) => { client.cancelPrivateRoomInvite(inviteId) },
  onPrivateRoomInviteRespond: (inviteId, accept) => { client.respondPrivateRoomInvite(inviteId, accept) },
  onSupportMessagesLoad: () => loadSupportMessages(),
  onSupportSend: (body) => sendSupportMessage(body),
  onSupportUnreadLoad: async () => {
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/support/unread`, {
        method: 'GET',
        credentials: 'include',
      })
      const data = (await response.json()) as { ok: boolean; unreadCount?: number }
      if (response.ok && data.ok && typeof data.unreadCount === 'number') {
        return { ok: true, unreadCount: data.unreadCount }
      }
      return { ok: false }
    } catch {
      return { ok: false }
    }
  },
  onAdminSupportConversationsLoad: () => loadAdminSupportConversations(),
  onAdminSupportMessagesLoad: (profileId) => loadAdminSupportMessages(profileId),
  onAdminSupportReply: (profileId, body) => sendAdminSupportReply(profileId, body),
  onAdminSupportDeleteConversation: (profileId) => archiveAdminSupportConversation(profileId),
  onSupportDeleteConversation: () => deleteUserSupportConversation(),
})

const activeRoom = createActiveRoomFlowController({
  root: rootElement,
  gameAudio,
  isConnected: () => client.isConnected(),
  leaveActiveRoom: (roomId, acceptPenalty = false) => {
    client.leaveActiveRoom(roomId, acceptPenalty)
  },
  submitCutIndex: (roomId, cutIndex) => {
    client.submitCutIndex(roomId, cutIndex)
  },
  submitBidAction: (roomId, action) => {
    client.submitBidAction(roomId, action)
  },
  submitPlayCard: (roomId, cardId, declarationKeys) => {
    client.submitPlayCard(roomId, cardId, declarationKeys)
  },
  resumeHumanControl: (roomId) => {
    client.resumeHumanControl(roomId)
  },
  submitPartnerRating: (roomId, ratingValue) => {
    client.submitPartnerRating(roomId, ratingValue)
  },
  sendReplayVote: (roomId) => {
    client.sendReplayVote(roomId)
  },
  sendLeaveMatchVote: (roomId) => {
    client.sendLeaveMatchVote(roomId)
  },
  sendEmojiReaction: (roomId, emojiId) => {
    client.sendEmojiReaction(roomId, emojiId)
  },
  requestPlayerProfile: (roomId, seat) => {
    client.requestPlayerProfile(roomId, seat)
  },
  showLobby: (errorText = null) => {
    lobby.setConnected(client.isConnected())
    lobby.resetToLobby()
    lobby.setErrorText(errorText)
    void loadAuthSession()
  },
  startNewGame: (stake, displayName) => {
    lobby.setConnected(client.isConnected())
    lobby.startMatchmaking(stake, displayName)
  },
})

function clearReconnectTimer(): void {
  if (reconnectTimerId === null) {
    return
  }

  window.clearTimeout(reconnectTimerId)
  reconnectTimerId = null
}

function scheduleServerReconnect(): void {
  if (isPageUnloading || reconnectTimerId !== null) {
    return
  }

  const delayMs = Math.min(
    SERVER_RECONNECT_DELAY_MS + reconnectAttempt * SERVER_RECONNECT_DELAY_MS,
    SERVER_RECONNECT_MAX_DELAY_MS,
  )

  reconnectAttempt += 1
  reconnectTimerId = window.setTimeout(() => {
    reconnectTimerId = null
    client.connect()
  }, delayMs)
}

function requestActiveRoomResume(): boolean {
  const resumeInfo = activeRoom.getResumeInfo()

  if (resumeInfo === null) {
    return false
  }

  client.resumeRoom(resumeInfo.roomId, resumeInfo.reconnectToken)
  return true
}

function showSessionDisplacedOverlay(): void {
  const existing = document.getElementById('session-displaced-overlay')
  if (existing) return

  const overlay = document.createElement('div')
  overlay.id = 'session-displaced-overlay'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:20000;background:rgba(0,0,0,0.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font-family:Arial,Helvetica,sans-serif;'
  overlay.innerHTML = `
    <div style="font-size:48px;">⚠️</div>
    <div style="font-size:20px;font-weight:900;color:#ffffff;text-align:center;max-width:420px;line-height:1.4;">
      Вече има отворена сесия с този профил на друго устройство или таб.
    </div>
    <div style="font-size:14px;color:rgba(255,255,255,0.55);text-align:center;">
      Тази сесия е деактивирана.
    </div>
  `
  document.body.appendChild(overlay)
}

function showSessionInGameOverlay(roomId: string, reconnectToken: string): void {
  const existing = document.getElementById('session-in-game-overlay')
  if (existing) return

  const overlay = document.createElement('div')
  overlay.id = 'session-in-game-overlay'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:20000;background:rgba(0,0,0,0.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font-family:Arial,Helvetica,sans-serif;'
  overlay.innerHTML = `
    <div style="font-size:48px;">🎮</div>
    <div style="font-size:20px;font-weight:900;color:#ffffff;text-align:center;max-width:420px;line-height:1.4;">
      В момента се играе игра с този профил.
    </div>
    <div style="font-size:14px;color:rgba(255,255,255,0.55);text-align:center;max-width:380px;">
      Можеш да се върнеш в играта от това устройство, но другата сесия ще бъде прекратена.
    </div>
    <button data-session-rejoin="1" style="margin-top:8px;padding:14px 32px;border:0;border-radius:8px;background:#d4a520;color:#000000;font-size:16px;font-weight:900;cursor:pointer;letter-spacing:0.04em;">
      Върни ме в играта
    </button>
  `
  document.body.appendChild(overlay)

  overlay.querySelector('[data-session-rejoin="1"]')?.addEventListener('click', () => {
    overlay.remove()
    client.resumeRoom(roomId, reconnectToken)
  })
}

client = createGameServerClient({
  onOpen: () => {
    clearReconnectTimer()
    reconnectAttempt = 0

    if (connectionErrorTimerId !== null) {
      clearTimeout(connectionErrorTimerId)
      connectionErrorTimerId = null
    }

    if (activeRoom.hasActiveRoom()) {
      activeRoom.setConnectionState(true, SERVER_RESUME_WAIT_MESSAGE)
      requestActiveRoomResume()
      return
    }

    lobby.setConnected(true)
    lobby.setErrorText(null)
  },
  onClose: () => {
    if (isSessionDisplaced || isPageUnloading) {
      return
    }

    if (isRefreshingAuthConnection) {
      isRefreshingAuthConnection = false
      lobby.setConnected(false)
      client.connect()
      return
    }

    if (activeRoom.hasActiveRoom()) {
      activeRoom.setConnectionState(false, SERVER_RESTART_WAIT_MESSAGE)
      scheduleServerReconnect()
      return
    }

    lobby.setConnected(false)
    scheduleServerReconnect()

    connectionErrorTimerId = window.setTimeout(() => {
      connectionErrorTimerId = null
      lobby.setErrorText(SERVER_RESTART_WAIT_MESSAGE)
    }, 1500)
  },
  onError: () => {
    if (activeRoom.hasActiveRoom()) {
      activeRoom.setConnectionError(SERVER_CONNECTION_ERROR_MESSAGE)
      return
    }

    lobby.setErrorText(SERVER_CONNECTION_ERROR_MESSAGE)
  },
  onMessage: (message) => {
    if (message.type === 'session_displaced') {
      isSessionDisplaced = true
      showSessionDisplacedOverlay()
      return
    }

    if (message.type === 'session_in_game') {
      showSessionInGameOverlay(message.roomId, message.reconnectToken)
      return
    }

    if (message.type === 'profile_liked') {
      likeNotification.show({
        fromProfileId: message.fromProfileId,
        fromDisplayName: message.fromDisplayName,
        fromAvatarUrl: message.fromAvatarUrl,
      })
      return
    }

    if (message.type === 'friend_request_received') {
      friendRequestNotification.showRequest({
        friendshipId: message.friendshipId,
        fromProfileId: message.fromProfileId,
        fromDisplayName: message.fromDisplayName,
        fromAvatarUrl: message.fromAvatarUrl,
      })
      return
    }

    if (message.type === 'friend_request_accepted') {
      friendRequestNotification.showAccepted({
        fromDisplayName: message.fromDisplayName,
        fromAvatarUrl: message.fromAvatarUrl,
      })
      return
    }

    if (message.type === 'room_resumed' && !activeRoom.hasActiveRoom()) {
      activeRoom.enterActiveRoomFromResume(message.roomId, message.seat, 5000)
      return
    }

    if (activeRoom.handleServerMessage(message)) {
      return
    }

    lobby.handleServerMessage(message)
  },
})

const disposeViewportResizeHandler = createViewportResizeHandler(() => {
  if (activeRoom.hasActiveRoom()) {
    activeRoom.render()
    return
  }

  lobby.render()
})

window.addEventListener('beforeunload', () => {
  isPageUnloading = true
  clearReconnectTimer()
  disposeViewportResizeHandler()
  client.disconnect()
})

const stripeReturnParams = new URLSearchParams(window.location.search)
const stripeReturnScreen = stripeReturnParams.get('screen')
const stripeReturnPayment = stripeReturnParams.get('payment')

if (stripeReturnScreen === 'shop') {
  history.replaceState(null, '', window.location.pathname)

  if (stripeReturnPayment === 'success') {
    lobby.navigateToShop(
      'Плащането е успешно. Жълтиците ще се появят след потвърждение от Stripe.',
    )
  } else if (stripeReturnPayment === 'cancel') {
    lobby.navigateToShop('Покупката беше отказана.')
  } else {
    lobby.render()
  }
} else {
  lobby.render()
}

void loadPublicSettings()
void loadAuthSession()
client.connect()
}
