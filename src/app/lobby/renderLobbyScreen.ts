import type {
  AdminSettingsSnapshot,
  ChatConversationSnapshot,
  ChatMessageSnapshot,
  CoinPackageInput,
  CoinPackageSnapshot,
  CoinPackageStatus,
  CoinPurchaseSnapshot,
  FriendRelationshipSnapshot,
  FriendshipsSnapshot,
  LeaderboardCategory,
  LeaderboardsSnapshot,
  MatchStake,
  PlayerPublicProfileSnapshot,
} from '../network/createGameServerClient'
import type { PlayerProfileFriendshipAction } from '../../ui/overlays/renderPlayerProfilePopup'
import { renderPlayerProfilePopup } from '../../ui/overlays/renderPlayerProfilePopup'

export type LobbyAuthModalMode = 'closed' | 'cta' | 'login' | 'register'

export type AvatarCropSelection = {
  x: number
  y: number
  size: number
}

export type LobbyScreenState = {
  view: 'tables' | 'players' | 'friends' | 'chat' | 'leaderboards' | 'shop' | 'admin'
  displayName: string
  selectedStake: MatchStake
  isConnected: boolean
  isSearching: boolean
  queuedPlayers: number
  requiredPlayers: number
  remainingMs: number | null
  statusText: string
  errorText: string | null
  profilePopupOpen: boolean
  profile: PlayerPublicProfileSnapshot
  profilePopupProfile: PlayerPublicProfileSnapshot | null
  profilePopupCanEdit: boolean
  players: PlayerPublicProfileSnapshot[]
  playersLoading: boolean
  playersErrorText: string | null
  leaderboards: LeaderboardsSnapshot | null
  leaderboardsLoading: boolean
  leaderboardsErrorText: string | null
  activeLeaderboardCategory: LeaderboardCategory
  shopPackages: CoinPackageSnapshot[]
  shopPackagesLoading: boolean
  shopPackagesErrorText: string | null
  shopPurchases: CoinPurchaseSnapshot[]
  shopPurchasesLoading: boolean
  shopPurchaseActionPackageId: string | null
  shopPurchaseMessageText: string | null
  isAdmin: boolean
  adminSettings: AdminSettingsSnapshot | null
  adminSettingsLoading: boolean
  adminSettingsErrorText: string | null
  adminCoinPackages: CoinPackageSnapshot[]
  adminCoinPackagesLoading: boolean
  adminCoinPackagesErrorText: string | null
  friendships: FriendshipsSnapshot | null
  friendsLoading: boolean
  friendsErrorText: string | null
  friendshipAction: PlayerProfileFriendshipAction | null
  giftModalFriendshipId: string | null
  giftModalFriendName: string
  giftModalErrorText: string | null
  chatConversations: ChatConversationSnapshot[]
  activeChatFriendshipId: string | null
  chatMessages: ChatMessageSnapshot[]
  chatLoading: boolean
  chatMessagesLoading: boolean
  chatErrorText: string | null
  authModalMode: LobbyAuthModalMode
  authErrorText: string | null
  signupBonusYellowCoins: number
  profileNameChangePrice: number
  profileEditorOpen: boolean
  profileEditorErrorText: string | null
}

export type RenderLobbyScreenOptions = {
  state: LobbyScreenState
  onDisplayNameChange: (value: string) => void
  onStakeChange: (stake: MatchStake) => void
  onSearchClick: () => void
  onCancelClick: () => void
  onProfileClick: () => void
  onProfileClose: () => void
  onProfileEditClick: () => void
  onProfileEditClose: () => void
  onProfileEditSubmit: (
    avatarFile: File | null,
    avatarCrop: AvatarCropSelection | null,
    galleryFiles: File[],
  ) => void
  onProfileEditorFileError: (message: string) => void
  onProfileGalleryDelete: (imageId: string) => void
  onProfileNameChangeSubmit: (displayName: string) => void
  onLobbyClick: () => void
  onPlayersClick: () => void
  onShopClick: () => void
  onShopPurchaseClick: (packageId: string) => void
  onLeaderboardsClick: () => void
  onLeaderboardCategoryClick: (category: LeaderboardCategory) => void
  onAdminClick: () => void
  onAdminSettingsSubmit: (settings: AdminSettingsSnapshot) => void
  onAdminCoinPackageSubmit: (input: CoinPackageInput) => void
  onAdminCoinPackageStatusChange: (
    packageId: string,
    status: CoinPackageStatus,
  ) => void
  onFriendsClick: () => void
  onChatClick: () => void
  onChatConversationClick: (friendshipId: string) => void
  onChatSubmit: (friendshipId: string, body: string) => void
  onPlayerCardClick: (profile: PlayerPublicProfileSnapshot) => void
  onLeaderboardPlayerClick: (profile: PlayerPublicProfileSnapshot) => void
  onFriendProfileClick: (profile: PlayerPublicProfileSnapshot) => void
  onFriendRequestClick: (profileId: string) => void
  onFriendBlockClick: (profileId: string) => void
  onFriendAcceptClick: (friendshipId: string) => void
  onFriendRejectClick: (friendshipId: string) => void
  onFriendRemoveClick: (friendshipId: string) => void
  onGiftCoinsClick: (friendshipId: string) => void
  onGiftCoinsClose: () => void
  onGiftCoinsSubmit: (friendshipId: string, amount: number) => void
  onAuthModalClose: () => void
  onAuthModeChange: (mode: Exclude<LobbyAuthModalMode, 'closed'>) => void
  onLoginSubmit: (email: string, password: string) => void
  onRegisterSubmit: (displayName: string, email: string, password: string) => void
}

type LobbyStakeCard = {
  stake: MatchStake
  prizeAmount: number
  onlinePlayers: number
}

const MATCH_STAKE_CARDS: LobbyStakeCard[] = [
  { stake: 5000, prizeAmount: 8000, onlinePlayers: 124 },
  { stake: 8000, prizeAmount: 12000, onlinePlayers: 98 },
  { stake: 10000, prizeAmount: 15000, onlinePlayers: 87 },
  { stake: 15000, prizeAmount: 22000, onlinePlayers: 63 },
  { stake: 20000, prizeAmount: 30000, onlinePlayers: 45 },
]

const COIN_PACKAGES = [
  { amount: 1000, image: '/assets/lobby/coins-1000.png', width: 60, height: 53 },
  { amount: 5000, image: '/assets/lobby/coins-5000.png', width: 82, height: 74 },
  { amount: 10000, image: '/assets/lobby/coins-10000.png', width: 89, height: 85 },
  { amount: 25000, image: '/assets/lobby/coins-25000.png', width: 106, height: 93 },
  { amount: 50000, image: '/assets/lobby/coins-50000.png', width: 111, height: 98 },
]

const MAX_PROFILE_GALLERY_IMAGES = 6

let popupRootEl: HTMLElement | null = null

export type ProfilePopupCallbacks = {
  onClose: () => void
  onEditClick: () => void
  onFriendRequestClick: (profileId: string) => void
  onFriendBlockClick: (profileId: string) => void
  onFriendAcceptClick: (friendshipId: string) => void
  onFriendRejectClick: (friendshipId: string) => void
  onFriendRemoveClick: (friendshipId: string) => void
  onGiftCoinsClick: (friendshipId: string) => void
}

function attachPopupListeners(el: HTMLElement, cb: ProfilePopupCallbacks): void {
  el.querySelector<HTMLButtonElement>('[data-player-profile-popup-close="1"]')
    ?.addEventListener('click', cb.onClose)
  el.querySelector<HTMLElement>('[data-player-profile-popup-backdrop="1"]')
    ?.addEventListener('click', cb.onClose)
  el.querySelector<HTMLButtonElement>('[data-player-profile-edit="1"]')
    ?.addEventListener('click', cb.onEditClick)
  el.querySelector<HTMLButtonElement>('[data-player-profile-friend-request]')
    ?.addEventListener('click', (e) => {
      const profileId = (e.currentTarget as HTMLButtonElement).dataset.playerProfileFriendRequest?.trim() ?? ''
      if (profileId) cb.onFriendRequestClick(profileId)
    })
  el.querySelector<HTMLButtonElement>('[data-player-profile-block]')
    ?.addEventListener('click', (e) => {
      const profileId = (e.currentTarget as HTMLButtonElement).dataset.playerProfileBlock?.trim() ?? ''
      if (profileId) cb.onFriendBlockClick(profileId)
    })
  el.querySelector<HTMLButtonElement>('[data-player-profile-gift-coins]')
    ?.addEventListener('click', (e) => {
      const friendshipId = (e.currentTarget as HTMLButtonElement).dataset.playerProfileGiftCoins?.trim() ?? ''
      if (friendshipId) cb.onGiftCoinsClick(friendshipId)
    })
  el.querySelectorAll<HTMLButtonElement>('[data-player-profile-friend-accept]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.playerProfileFriendAccept?.trim() ?? ''
      if (id) cb.onFriendAcceptClick(id)
    })
  })
  el.querySelectorAll<HTMLButtonElement>('[data-player-profile-friend-reject]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.playerProfileFriendReject?.trim() ?? ''
      if (id) cb.onFriendRejectClick(id)
    })
  })
  el.querySelectorAll<HTMLButtonElement>('[data-player-profile-friend-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.playerProfileFriendRemove?.trim() ?? ''
      if (id) cb.onFriendRemoveClick(id)
    })
  })
  el.querySelectorAll<HTMLElement>('[data-gallery-image-url]').forEach((imgEl) => {
    imgEl.addEventListener('click', () => {
      const url = imgEl.getAttribute('data-gallery-image-url') ?? ''
      if (!url) return
      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:fixed;inset:0;z-index:20000;background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;cursor:zoom-out;'
      const img = document.createElement('img')
      img.src = url
      img.alt = 'Снимка'
      img.style.cssText = 'max-width:90vw;max-height:90vh;object-fit:contain;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.7);'
      overlay.appendChild(img)
      overlay.addEventListener('click', () => overlay.remove())
      document.body.appendChild(overlay)
    })
  })
}

export function syncProfilePopup(
  popupState: {
    isOpen: boolean
    profile: PlayerPublicProfileSnapshot | null
    canEdit: boolean
    friendshipAction: PlayerProfileFriendshipAction | null
  },
  cb: ProfilePopupCallbacks,
): void {
  if (!popupState.isOpen) {
    popupRootEl?.remove()
    popupRootEl = null
    return
  }
  const isFirstOpen = !popupRootEl
  if (isFirstOpen) {
    popupRootEl = document.createElement('div')
    document.body.appendChild(popupRootEl)
  }
  popupRootEl.innerHTML = renderPlayerProfilePopup({
    isOpen: true,
    seat: 'bottom',
    profile: popupState.profile,
    canEdit: popupState.canEdit,
    friendshipAction: popupState.friendshipAction,
    skipAnimation: !isFirstOpen,
  })
  attachPopupListeners(popupRootEl, cb)
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat('bg-BG').format(value)
}

function formatPackagePrice(priceCents: number, currency: string): string {
  return new Intl.NumberFormat('bg-BG', {
    style: 'currency',
    currency,
  }).format(priceCents / 100)
}

function formatCompactDateTime(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('bg-BG', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatPurchaseStatusLabel(status: CoinPurchaseSnapshot['status']): string {
  switch (status) {
    case 'pending':
      return 'Изчаква плащане'
    case 'paid':
      return 'Платена'
    case 'canceled':
      return 'Отказана'
    case 'failed':
      return 'Неуспешна'
    default:
      return status
  }
}

function getPurchaseStatusColor(status: CoinPurchaseSnapshot['status']): string {
  switch (status) {
    case 'paid':
      return '#86efac'
    case 'pending':
      return '#d4a520'
    case 'failed':
      return '#fecaca'
    case 'canceled':
    default:
      return 'rgba(255,255,255,0.48)'
  }
}

function renderAuthModal(state: LobbyScreenState): string {
  if (state.authModalMode === 'closed') {
    return ''
  }

  const bonusText = formatAmount(state.signupBonusYellowCoins)
  const isLogin = state.authModalMode === 'login'
  const isRegister = state.authModalMode === 'register'

  const body = state.authModalMode === 'cta'
    ? `
      <div style="display:grid;gap:16px;text-align:center;">
        <div style="font-size:28px;line-height:1.12;font-weight:900;color:#f8fafc;">
          Регистрирай се и вземи ${escapeHtml(bonusText)} безплатни жълтици
        </div>
        <div style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.72);font-weight:700;">
          Създай профил, избери име и играй белот с други хора. Жълтиците, рангът и рейтингът ти ще се пазят.
        </div>
        <div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:6px;">
          <button type="button" data-lobby-auth-register-button="1" style="height:46px;min-width:150px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;">Регистрация</button>
          <button type="button" data-lobby-auth-login-button="1" style="height:46px;min-width:130px;border:1px solid rgba(212,165,32,0.62);border-radius:8px;background:#080808;color:#f8fafc;font-size:15px;font-weight:900;cursor:pointer;">Вход</button>
        </div>
      </div>
    `
    : `
      <form data-lobby-auth-form="${isLogin ? 'login' : 'register'}" style="display:grid;gap:12px;">
        <div style="font-size:25px;line-height:1.1;font-weight:900;color:#f8fafc;text-align:center;">
          ${isLogin ? 'Вход в профила' : 'Създай профил'}
        </div>
        ${isRegister ? `
          <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Име в играта
            <input name="displayName" autocomplete="nickname" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:700;outline:none;">
          </label>
        ` : ''}
        <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
          Email
          <input name="email" type="email" autocomplete="email" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:700;outline:none;">
        </label>
        <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
          Парола
          <input name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:700;outline:none;">
        </label>
        <button type="submit" style="height:46px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;margin-top:4px;">
          ${isLogin ? 'Влез' : 'Регистрирай се'}
        </button>
        <button type="button" data-lobby-auth-mode="${isLogin ? 'register' : 'login'}" style="height:34px;border:0;background:transparent;color:rgba(255,255,255,0.72);font-size:13px;font-weight:800;cursor:pointer;">
          ${isLogin ? 'Нямаш профил? Регистрирай се' : 'Имаш профил? Влез'}
        </button>
      </form>
    `

  return `
    <div data-lobby-auth-modal-root="1" style="position:fixed;inset:0;z-index:13000;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-lobby-auth-modal-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.74);backdrop-filter:blur(4px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,480px);border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
        <button type="button" data-lobby-auth-modal-close="1" aria-label="Затвори" style="position:absolute;right:12px;top:10px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <div style="display:grid;gap:14px;">
          ${body}
          ${state.authErrorText ? `<div style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;">${escapeHtml(state.authErrorText)}</div>` : ''}
        </div>
      </div>
    </div>
  `
}

function renderProfileEditModal(state: LobbyScreenState): string {
  if (!state.profileEditorOpen) {
    return ''
  }

  const galleryImages = [...state.profile.galleryImages].sort(
    (left, right) => left.sortOrder - right.sortOrder,
  )
  const gallerySlotsLeft = Math.max(
    0,
    MAX_PROFILE_GALLERY_IMAGES - galleryImages.length,
  )
  const nameChangePrice = state.profileNameChangePrice

  return `
    <div data-lobby-profile-editor-root="1" style="position:fixed;inset:0;z-index:13500;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-lobby-profile-editor-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.76);backdrop-filter:blur(4px);"></div>
      <div role="dialog" aria-modal="true" class="gold-scrollbar" style="position:relative;width:min(92vw,560px);max-height:90vh;overflow-y:auto;border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
        <button type="button" data-lobby-profile-editor-close="1" aria-label="Затвори" style="position:absolute;right:12px;top:10px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <form data-lobby-profile-editor-form="1" style="display:grid;gap:16px;">
          <div>
            <div style="font-size:25px;line-height:1.1;font-weight:900;color:#f8fafc;">Редакция на профил</div>
            <div style="margin-top:7px;font-size:13px;line-height:1.45;color:rgba(255,255,255,0.62);font-weight:700;">Името е заключено. Смяната му ще бъде платена с жълтици на следваща стъпка.</div>
          </div>

          <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Име в играта
            <input value="${escapeHtml(state.profile.displayName)}" disabled style="height:42px;border-radius:8px;border:1px solid rgba(255,255,255,0.10);background:#101010;color:rgba(255,255,255,0.58);padding:0 12px;font-size:15px;font-weight:700;outline:none;">
          </label>

          <div style="display:grid;gap:8px;border:1px solid rgba(212,165,32,0.22);border-radius:8px;background:rgba(255,255,255,0.035);padding:12px;">
            <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
              Ново име
              <input name="paidDisplayName" maxlength="32" autocomplete="nickname" placeholder="Въведи ново име" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:700;outline:none;">
            </label>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
              <div style="font-size:12px;line-height:1.35;color:rgba(255,255,255,0.62);font-weight:800;">
                Цена: <strong style="color:#d4a520;">${formatAmount(nameChangePrice)}</strong> жълтици
              </div>
              <button type="button" data-lobby-profile-name-change-submit="1" style="height:38px;padding:0 14px;border:1px solid rgba(212,165,32,0.58);border-radius:8px;background:#080808;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;">
                Смени име
              </button>
            </div>
          </div>

          <div style="display:grid;gap:8px;">
            <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">Аватар</div>
            <div style="display:flex;align-items:center;gap:16px;">
              <div
                data-avatar-pick-btn="1"
                role="button"
                tabindex="0"
                style="width:80px;height:80px;border-radius:8px;border:2px dashed rgba(212,165,32,0.50);background:#101010;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto;overflow:hidden;position:relative;"
              >
                ${state.profile.avatarUrl
                  ? `<img src="${escapeHtml(state.profile.avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;position:absolute;inset:0;"><div style="position:absolute;inset:0;background:rgba(0,0,0,0.50);display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:12px;font-weight:900;letter-spacing:0.04em;">Смени</span></div>`
                  : `<span style="color:rgba(212,165,32,0.70);font-size:36px;font-weight:300;line-height:1;">+</span>`}
              </div>
              <input name="avatarFile" type="file" accept="image/png,image/jpeg,image/webp" style="display:none;">
              <div style="font-size:13px;color:rgba(255,255,255,0.62);font-weight:700;line-height:1.5;">
                ${state.profile.avatarUrl ? 'Натисни квадрата за да смениш аватара.' : 'Натисни квадрата за да добавиш аватар.'}<br>Ще можеш да очертаеш зона от снимката.
              </div>
            </div>
          </div>

          <div style="display:grid;gap:8px;">
            <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">Галерия</div>
            <div data-gallery-grid="1" style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;">
              ${galleryImages.map((image) => `
                <div style="position:relative;aspect-ratio:1/1;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.10);background:#101010;">
                  <img src="${escapeHtml(image.imageUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">
                  <button
                    type="button"
                    data-lobby-gallery-delete="${escapeHtml(image.imageId)}"
                    aria-label="Изтрий снимката"
                    style="position:absolute;top:4px;right:4px;width:26px;height:26px;border:1px solid rgba(248,113,113,0.56);border-radius:999px;background:rgba(12,12,12,0.86);color:#fecaca;font-size:16px;font-weight:900;line-height:1;cursor:pointer;"
                  >×</button>
                </div>
              `).join('')}
              ${Array.from({ length: gallerySlotsLeft }, () => `
                <div
                  data-gallery-add-slot="1"
                  role="button"
                  tabindex="0"
                  style="aspect-ratio:1/1;border-radius:8px;border:2px dashed rgba(255,255,255,0.20);background:#101010;display:flex;align-items:center;justify-content:center;cursor:pointer;"
                >
                  <span style="color:rgba(255,255,255,0.40);font-size:28px;font-weight:300;line-height:1;">+</span>
                </div>
              `).join('')}
            </div>
            <input data-gallery-file-input="1" type="file" accept="image/png,image/jpeg,image/webp" style="display:none;">
          </div>

          ${state.profileEditorErrorText ? `<div style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;">${escapeHtml(state.profileEditorErrorText)}</div>` : ''}

          <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;">
            <button type="button" data-lobby-profile-editor-cancel="1" style="height:42px;padding:0 16px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:#080808;color:#f8fafc;font-size:14px;font-weight:900;cursor:pointer;">Откажи</button>
            <button type="submit" style="height:42px;padding:0 18px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;cursor:pointer;">Запази</button>
          </div>
        </form>
      </div>
    </div>
  `
}

function renderGiftCoinsModal(state: LobbyScreenState): string {
  if (state.giftModalFriendshipId === null) {
    return ''
  }

  return `
    <div data-lobby-gift-modal-root="1" style="position:fixed;inset:0;z-index:13600;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-lobby-gift-modal-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.76);backdrop-filter:blur(4px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,430px);border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
        <button type="button" data-lobby-gift-modal-close="1" aria-label="Затвори" style="position:absolute;right:12px;top:10px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <form data-lobby-gift-form="${escapeHtml(state.giftModalFriendshipId)}" style="display:grid;gap:14px;">
          <div>
            <div style="font-size:24px;line-height:1.1;font-weight:900;color:#f8fafc;">Подари жълтици</div>
            <div style="margin-top:7px;font-size:13px;line-height:1.45;color:rgba(255,255,255,0.62);font-weight:700;">Към ${escapeHtml(state.giftModalFriendName || 'приятел')}. Сумата трябва да е между 100 и 50 000 жълтици.</div>
          </div>
          <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Сума
            <input name="amount" type="number" min="100" max="50000" step="100" value="1000" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:800;outline:none;">
          </label>
          ${state.giftModalErrorText ? `<div style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;">${escapeHtml(state.giftModalErrorText)}</div>` : ''}
          <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;">
            <button type="button" data-lobby-gift-modal-cancel="1" style="height:42px;padding:0 16px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:#080808;color:#f8fafc;font-size:14px;font-weight:900;cursor:pointer;">Откажи</button>
            <button type="submit" style="height:42px;padding:0 18px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;cursor:pointer;">Изпрати</button>
          </div>
        </form>
      </div>
    </div>
  `
}

function renderNav(state: LobbyScreenState): string {
  const activeView = state.view
  const playersActive = activeView === 'players'
  const friendsActive = activeView === 'friends'
  const chatActive = activeView === 'chat'
  const leaderboardsActive = activeView === 'leaderboards'
  const shopActive = activeView === 'shop'
  const adminActive = activeView === 'admin'
  const lobbyActive = activeView === 'tables'
  const incomingFriendRequestsCount =
    state.friendships?.incomingPending.length ?? 0

  return `
    <nav style="
      background: #0a0a0a;
      border-bottom: 1px solid rgba(255,255,255,0.10);
      max-width: 1640px;
      margin: 0 auto;
      box-sizing: border-box;
      padding: 0 5px;
      display: flex;
      align-items: center;
      gap: 0;
      height: 72px;
      position: sticky;
      top: 0;
      z-index: 100;
    ">
      <a href="#" style="display:flex; align-items:center; gap:8px; text-decoration:none; margin-right:16px;">
        <img src="/assets/lobby/logo.png" alt="Pika.bg" style="width:192px; height:52px; display:block; object-fit:contain;">
      </a>

      <div style="display:flex; align-items:stretch; gap:0; height:100%; flex:1;">
        <button type="button" data-lobby-nav-players="1" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          border:0;
          background:${playersActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:${playersActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
          border-bottom:2px solid ${playersActive ? '#d4a520' : 'transparent'};
          cursor:pointer;
          height:100%;
        ">
          <span style="font-size:25px;line-height:1;color:currentColor;">◎</span>
          Играчи
        </button>
        <button type="button" data-lobby-nav-friends="1" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          border:0;
          background:${friendsActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:${friendsActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
          border-bottom:2px solid ${friendsActive ? '#d4a520' : 'transparent'};
          cursor:pointer;
          height:100%;
        ">
          <span style="font-size:23px;line-height:1;color:currentColor;">+</span>
          Приятели
          ${incomingFriendRequestsCount > 0 ? `
            <span style="min-width:20px;height:20px;border-radius:999px;background:#d4a520;color:#080808;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;font-size:11px;font-weight:900;line-height:1;">
              ${formatAmount(incomingFriendRequestsCount)}
            </span>
          ` : ''}
        </button>
        <button type="button" data-lobby-nav-chat="1" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          border:0;
          background:${chatActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:${chatActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
          border-bottom:2px solid ${chatActive ? '#d4a520' : 'transparent'};
          cursor:pointer;
          height:100%;
        ">
          <span style="font-size:22px;line-height:1;color:currentColor;">▣</span>
          Чат
        </button>
        <a href="#" data-lobby-nav-lobby="1" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          text-decoration:none;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:${lobbyActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
          border-bottom:2px solid ${lobbyActive ? '#d4a520' : 'transparent'};
          background:${lobbyActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
        ">
          <img src="/assets/lobby/nav-icon-preview/nav-home-gold.svg" alt="" style="width:28px; height:28px; display:block; object-fit:contain;">
          Лоби
        </a>
        <a href="#" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          text-decoration:none;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:rgba(255,255,255,0.70);
          border-bottom:2px solid transparent;
          transition:color 0.15s;
        ">
          <img src="/assets/lobby/nav-icon-preview/nav-tournaments-white.png" alt="" style="width:32px; height:29px; display:block; object-fit:contain;">
          Турнири
        </a>
        <button type="button" data-lobby-nav-shop="1" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          border:0;
          background:${shopActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:${shopActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
          border-bottom:2px solid ${shopActive ? '#d4a520' : 'transparent'};
          cursor:pointer;
          height:100%;
        ">
          <img src="/assets/lobby/nav-icon-preview/nav-shop-white.png" alt="" style="width:31px; height:30px; display:block; object-fit:contain;">
          Магазин
        </button>
        <button type="button" data-lobby-nav-leaderboards="1" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          border:0;
          background:${leaderboardsActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:${leaderboardsActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
          border-bottom:2px solid ${leaderboardsActive ? '#d4a520' : 'transparent'};
          cursor:pointer;
          height:100%;
        ">
          <img src="/assets/lobby/nav-icon-preview/nav-leaderboard-white.png" alt="" style="width:29px; height:30px; display:block; object-fit:contain;">
          Класация
        </button>
        <button
          type="button"
          data-lobby-profile-button="1"
          style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          border:0;
          background:${shopActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
          background:transparent;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:${shopActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
          border-bottom:2px solid ${shopActive ? '#d4a520' : 'transparent'};
          cursor:pointer;
          height:100%;
          cursor:pointer;
          height:100%;
        ">
          <img src="/assets/lobby/nav-icon-preview/nav-profile-white.png" alt="" style="width:28px; height:31px; display:block; object-fit:contain;">
          Профил
        </button>
        ${state.isAdmin ? `
          <button type="button" data-lobby-nav-admin="1" style="
            display:flex; align-items:center; gap:10px;
            padding:0 18px;
            border:0;
            background:${adminActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
            font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
            color:${adminActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
            border-bottom:2px solid ${adminActive ? '#d4a520' : 'transparent'};
            cursor:pointer;
            height:100%;
          ">
            <span style="font-size:22px;line-height:1;color:currentColor;">⚙</span>
            Админ
          </button>
        ` : ''}
      </div>

      <div style="display:flex; align-items:center; gap:16px; margin-left:auto;">
        <button style="
          background:none; border:none; cursor:pointer; padding:6px;
          color:rgba(255,255,255,0.65); position:relative;
        ">
          <img src="/assets/lobby/nav-icon-preview/nav-notifications-white.png" alt="" style="width:28px; height:31px; display:block; object-fit:contain;">
          <span style="
            position:absolute; top:4px; right:4px;
            width:8px; height:8px; border-radius:50%;
            background:#ef4444; border:1.5px solid #0a0a0a;
          "></span>
        </button>
        <button style="
          display:flex; align-items:center; gap:8px;
          background: linear-gradient(135deg, #d4a520 0%, #b8891a 100%);
          border: none; border-radius:8px;
          padding:9px 16px;
          cursor:pointer;
          font-size:13px; font-weight:800; letter-spacing:0.05em; text-transform:uppercase;
          color:#000000;
          box-shadow: 0 2px 12px rgba(212,165,32,0.35);
        ">
          <span style="font-size:16px; font-weight:900;">+</span>
          Купи Жълтици
        </button>
        <img src="/assets/lobby/icon-coin.png" alt="" style="width:33px; height:32px; display:block; object-fit:contain;">
      </div>
    </nav>
  `
}

function renderHeroSection(
  profileName: string,
  isConnected: boolean,
  avatarUrl: string | null,
  yellowCoinsBalance: number | null,
  wonGamesCount: number | null,
  completedGamesCount: number | null,
  rankTitle: string | null,
): string {
  const winRate =
    wonGamesCount !== null && completedGamesCount !== null && completedGamesCount > 0
      ? Math.round((wonGamesCount / completedGamesCount) * 100)
      : null
  return `
    <div style="display:flex; gap:16px; align-items:stretch; margin-bottom:16px;">
      <div style="flex:0 1 985px; min-width:0; border:2px solid rgba(212,165,32,0.75); border-radius:14px; overflow:hidden; position:relative; box-sizing:border-box;">
        <img src="/assets/lobby/hero-banner.png" alt="Добре дошъл в лобито"
          style="width:100%; height:254px; max-width:100%; display:block; object-fit:contain;">
      </div>

      <div style="
        flex:1 1 620px; min-width:580px; height:258px;
        background: linear-gradient(160deg, #050505 0%, #0d0d0d 100%);
        border: 2px solid rgba(212,165,32,0.75);
        border-radius:14px;
        padding:16px 28px;
        box-sizing:border-box;
      ">
        <div style="display:flex; align-items:center; gap:24px; height:120px;">
          <div style="position:relative; width:120px; height:120px; flex-shrink:0;">
            <div style="
              width:120px; height:120px; border-radius:12px;
              border:3px solid #d4a520;
              overflow:hidden;
              background:#111111;
              box-shadow:0 0 0 2px rgba(0,0,0,0.65), 0 0 22px rgba(212,165,32,0.18);
              box-sizing:border-box;
            ">
              ${avatarUrl
                ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(profileName)}" style="width:100%; height:100%; object-fit:cover; object-position:center;">`
                : `<span style="font-size:48px;font-weight:900;color:#d4a520;display:flex;align-items:center;justify-content:center;width:100%;height:100%;">${escapeHtml(profileName.charAt(0).toUpperCase() || '?')}</span>`}
            </div>
            <div style="
              position:absolute; right:-6px; bottom:-6px;
              width:18px; height:18px; border-radius:50%;
              background:${isConnected ? '#22c55e' : '#ef4444'};
              border:2px solid #050505;
            "></div>
          </div>
          <div style="flex:1; min-width:0;">
            <div style="font-size:30px; line-height:1; font-weight:800; color:#ffffff;">${escapeHtml(profileName)}</div>
            <div style="display:flex; align-items:center; gap:8px; margin-top:12px;">
              <div style="
                width:14px; height:14px; border-radius:50%;
                background:${isConnected ? '#22c55e' : '#ef4444'};
              "></div>
              <span style="font-size:16px; color:rgba(255,255,255,0.88); font-weight:600;">
                ${isConnected ? 'Онлайн' : 'Офлайн'}
              </span>
            </div>
          </div>
          <div style="width:1px; height:92px; background:rgba(212,165,32,0.35);"></div>
          <div style="width:210px;">
            <div style="font-size:17px; color:rgba(255,255,255,0.78); font-weight:500;">Баланс</div>
            <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
              <span style="font-size:34px; line-height:1; font-weight:900; color:#d4a520;">${yellowCoinsBalance !== null ? formatAmount(yellowCoinsBalance) : '—'}</span>
              <img src="/assets/lobby/icon-coin.png" alt="" style="width:33px; height:32px; display:block; object-fit:contain;">
            </div>
            <div style="font-size:16px; color:rgba(255,255,255,0.72); margin-top:8px;">жълтици</div>
          </div>
        </div>

        <div style="
          height:1px;
          background:linear-gradient(90deg, transparent 0%, rgba(212,165,32,0.55) 12%, rgba(212,165,32,0.55) 88%, transparent 100%);
          margin:10px 0 8px;
        "></div>

        <div style="
          display:grid; grid-template-columns:0.82fr 1fr 1.18fr 1.42fr;
          align-items:center;
          height:76px;
        ">
          <div style="display:flex; align-items:center; gap:8px; min-width:0; padding-right:10px;">
            <img src="/assets/lobby/icon-victories.png" alt="" style="width:36px; height:36px; display:block; object-fit:contain; flex-shrink:0;">
            <div style="min-width:0;">
              <div style="font-size:15px; color:rgba(255,255,255,0.82); font-weight:600;">Победи</div>
              <div style="font-size:22px; line-height:1.1; font-weight:800; color:#ffffff; margin-top:6px;">${wonGamesCount !== null ? formatAmount(wonGamesCount) : '—'}</div>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px; min-width:0; padding:0 10px; border-left:1px solid rgba(212,165,32,0.35);">
            <img src="/assets/lobby/icon-games-played.png" alt="" style="width:36px; height:38px; display:block; object-fit:contain; flex-shrink:0;">
            <div style="min-width:0;">
              <div style="font-size:14px; line-height:1.1; color:rgba(255,255,255,0.82); font-weight:600;">Изиграни игри</div>
              <div style="font-size:22px; line-height:1.1; font-weight:800; color:#ffffff; margin-top:6px;">${completedGamesCount !== null ? formatAmount(completedGamesCount) : '—'}</div>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px; min-width:0; padding:0 10px; border-left:1px solid rgba(212,165,32,0.35);">
            <img src="/assets/lobby/icon-success-rate.png" alt="" style="width:36px; height:38px; display:block; object-fit:contain; flex-shrink:0;">
            <div style="min-width:0;">
              <div style="font-size:14px; line-height:1.1; color:rgba(255,255,255,0.82); font-weight:600;">Успеваемост</div>
              <div style="font-size:22px; line-height:1.1; font-weight:800; color:#ffffff; margin-top:6px;">${winRate !== null ? `${winRate}%` : '—'}</div>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:10px; min-width:0; padding-left:10px; border-left:1px solid rgba(212,165,32,0.35);">
            <img src="/assets/lobby/icon-rank.png" alt="" style="width:48px; height:62px; display:block; object-fit:contain; flex-shrink:0;">
            <div style="min-width:0;">
              <div style="font-size:15px; color:#d4a520; font-weight:700;">Ранг</div>
              <div style="font-size:18px; line-height:1.15; font-weight:800; color:#ffffff; margin-top:7px;">${rankTitle ? escapeHtml(rankTitle) : '—'}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
}

function renderStakeSection(
  selectedStake: MatchStake,
  canStartSearch: boolean,
  isSearching: boolean,
): string {
  const stakeCards = MATCH_STAKE_CARDS.map((card) => {
    const isSelected = isSearching && card.stake === selectedStake
    const isDisabled = !canStartSearch

    return `
      <button
        type="button"
        data-lobby-stake-card="${card.stake}"
        ${isDisabled ? 'disabled' : ''}
        style="
          position:relative;
          background:#000000;
          border: 1px solid ${isSelected ? '#c8940e' : 'rgba(212,165,32,0.72)'};
          border-radius:12px;
          padding:16px 14px 14px;
          cursor:${isDisabled ? 'default' : 'pointer'};
          text-align:left;
          overflow:hidden;
          transition:border-color 0.15s, background 0.15s, box-shadow 0.15s;
          box-shadow: ${isSelected ? '0 0 0 1px rgba(200,148,14,0.3), 0 8px 24px rgba(0,0,0,0.4)' : '0 4px 16px rgba(0,0,0,0.3)'};
          opacity:${isDisabled && !isSelected ? '0.7' : '1'};
        "
      >
        <img src="/assets/lobby/spade-watermark.png" alt=""
          style="
            position:absolute; bottom:8px; right:18px;
            width:82px; height:97px; display:block; object-fit:contain;
            opacity:1;
            pointer-events:none;
          ">

        ${isSelected ? `
          <div style="
            position:absolute; top:10px; right:10px;
            background:linear-gradient(135deg, #d4a520 0%, #a07010 100%);
            border-radius:20px; padding:3px 9px;
            font-size:9px; font-weight:900; text-transform:uppercase; letter-spacing:0.06em;
            color:#000000;
          ">ИЗБРАНО ★</div>
        ` : ''}

        <div style="font-size:10px; font-weight:700; color:rgba(255,255,255,0.5); text-transform:uppercase; letter-spacing:0.08em; margin-bottom:5px;">Награда</div>
        <div style="display:flex; align-items:center; gap:5px; margin-bottom:12px;">
          <span style="font-size:22px; font-weight:900; color:#d4a520; line-height:1;">${formatAmount(card.prizeAmount)}</span>
          <img src="/assets/lobby/icon-coin.png" alt="" style="height:18px;">
        </div>

        <div style="font-size:10px; font-weight:700; color:rgba(255,255,255,0.5); text-transform:uppercase; letter-spacing:0.08em; margin-bottom:5px;">Вход</div>
        <div style="display:flex; align-items:center; gap:5px; margin-bottom:14px;">
          <span style="font-size:18px; font-weight:400; color:#ffffff; line-height:1;">${formatAmount(card.stake)}</span>
          <img src="/assets/lobby/icon-coin.png" alt="" style="height:15px;">
        </div>

        <div style="
          display:flex; align-items:center; gap:5px;
          font-size:11px; font-weight:600; color:rgba(255,255,255,0.45);
        ">
          <img src="/assets/lobby/icon-users.png" alt="" style="height:12px; opacity:0.6;">
          Играчи онлайн: ${card.onlinePlayers}
        </div>
      </button>
    `
  }).join('')

  return `
    <div style="margin-bottom:16px;">
      <div style="
        display:flex; align-items:center; justify-content:center; gap:12px;
        margin-bottom:14px;
      ">
        <div style="flex:1; height:2px; background:linear-gradient(90deg, #000000 0%, #d4a520 100%);"></div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="color:#d4a520; font-size:16px;">◆</span>
          <span style="font-size:16px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; color:#d4a520;">Избери маса</span>
          <span style="color:#d4a520; font-size:16px;">◆</span>
        </div>
        <div style="flex:1; height:2px; background:linear-gradient(90deg, #d4a520 0%, #000000 100%);"></div>
      </div>

      <div style="
        display:grid;
        grid-template-columns:repeat(5, minmax(0, 1fr));
        gap:12px;
      ">
        ${stakeCards}
      </div>

      <style>
        [data-lobby-stake-card]:not(:disabled):hover {
          border-color:#c8940e !important;
          box-shadow:0 0 0 2px rgba(200,148,14,0.42), 0 8px 24px rgba(212,165,32,0.18) !important;
        }
      </style>
    </div>
  `
}

function renderBottomSection(): string {
  const coinPackages = COIN_PACKAGES.map((pkg, index) => {
    const isFirstPackage = index === 0

    return `
    <div style="
      background:#000000;
      border:1px solid rgba(212,165,32,0.72);
      border-radius:12px;
      padding:10px 12px;
      margin-left:${isFirstPackage ? '-8px' : '0'};
      display:grid; grid-template-columns:${pkg.width}px minmax(0, 1fr); align-items:center; gap:10px;
      flex:1; min-width:0;
      overflow:hidden;
      box-shadow:inset 0 0 18px rgba(212,165,32,0.035);
    ">
      <div style="height:98px; display:flex; align-items:center; justify-content:center;">
        <img src="${pkg.image}" alt="${formatAmount(pkg.amount)} жълтици"
          style="width:${pkg.width}px; height:${pkg.height}px; display:block; object-fit:contain;">
      </div>
      <div style="display:flex; flex-direction:column; justify-content:center; align-items:flex-start; min-width:0;">
        <div style="font-size:21px; line-height:1; font-weight:800; color:#d4a520; white-space:nowrap;">
          ${formatAmount(pkg.amount)}
        </div>
        <div style="font-size:12px; line-height:1; color:rgba(255,255,255,0.82); margin-top:6px; margin-bottom:9px; font-weight:400;">жълтици</div>
        <button data-lobby-buy-coins-button="1" style="
          background:linear-gradient(135deg, #f4c95b 0%, #c98f13 100%);
          border:none; border-radius:6px;
          padding:0 14px;
          height:28px;
          font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:0.03em;
          color:#000000; cursor:pointer;
          min-width:84px;
          transition:transform 0.14s ease, box-shadow 0.14s ease, filter 0.14s ease;
        ">Купи</button>
      </div>
    </div>
  `
  }).join('')

  return `
    <div style="
      display:grid;
      grid-template-columns:310px repeat(5, minmax(0, 1fr));
      gap:8px;
      align-items:stretch;
      margin-bottom:16px;
    ">
      <div style="
        background:#000000;
        border:1px solid rgba(212,165,32,0.72);
        border-right:0;
        border-radius:12px 0 0 12px;
        padding:15px 20px;
        display:flex; flex-direction:column; justify-content:center;
      ">
        <div style="display:flex; align-items:flex-start; gap:10px;">
          <div style="
            width:45px; height:43px; border-radius:12px;
            background:#000000;
            display:flex; align-items:center; justify-content:center;
            flex-shrink:0;
          ">
            <img src="/assets/lobby/icon-shop-cart.png" alt="" style="width:45px; height:43px; display:block; object-fit:contain;">
          </div>
          <div style="min-width:0;">
            <div style="font-size:13px; font-weight:800; color:#d4a520; text-transform:uppercase; letter-spacing:0.05em;">Магазин за жълтици</div>
            <div style="font-size:11px; color:rgba(255,255,255,0.5); font-weight:400; line-height:1.35; margin-top:5px;">
              Купи жълтици и се върни в играта
            </div>
            <button data-lobby-buy-coins-button="1" style="
              margin-top:9px;
              height:28px;
              padding:0 14px;
              border:none;
              border-radius:6px;
              background:linear-gradient(135deg, #f4c95b 0%, #c98f13 100%);
              color:#000000;
              font-size:10px;
              font-weight:800;
              text-transform:uppercase;
              letter-spacing:0.03em;
              cursor:pointer;
              min-width:132px;
              transition:transform 0.14s ease, box-shadow 0.14s ease, filter 0.14s ease;
            ">Виж всички оферти</button>
          </div>
        </div>
      </div>

      ${coinPackages}

      <style>
        [data-lobby-buy-coins-button="1"]:hover {
          filter:brightness(1.12);
          transform:translateY(-1px);
          box-shadow:0 4px 12px rgba(212,165,32,0.26);
        }

        [data-lobby-buy-coins-button="1"]:active {
          filter:brightness(0.98);
          transform:translateY(0);
        }
      </style>
    </div>

    <div style="
      display:grid;
      grid-template-columns:repeat(3, minmax(0, 1fr)) 332px;
      gap:12px;
      align-items:stretch;
    ">
      <div style="
        background:#000000;
        border:1px solid rgba(167,139,250,0.62);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:14px;
        cursor:pointer;
        min-height:137px;
      ">
        <img src="/assets/lobby/icon-private-table.png" alt="" style="width:76px; height:75px; display:block; object-fit:contain; flex-shrink:0;">
        <div style="flex:1; min-width:0;">
          <div style="font-size:15px; font-weight:800; color:#a78bfa; text-transform:uppercase; letter-spacing:0.05em;">Частни маси</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px; font-weight:400;">Създай маса и играй с приятели.</div>
        </div>
      </div>

      <div style="
        background:#000000;
        border:1px solid rgba(212,165,32,0.68);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:14px;
        cursor:pointer;
        position:relative;
        min-height:137px;
      ">
        <img src="/assets/lobby/icon-daily-rewards.png" alt="" style="width:74px; height:75px; display:block; object-fit:contain; flex-shrink:0;">
        <div style="flex:1; min-width:0;">
          <div style="font-size:15px; font-weight:800; color:#d4a520; text-transform:uppercase; letter-spacing:0.05em;">Ежедневни награди</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px; font-weight:400;">Влизай всеки ден и вземи своите награди.</div>
        </div>
      </div>

      <div style="
        background:#000000;
        border:1px solid rgba(96,165,250,0.62);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:14px;
        cursor:pointer;
        min-height:137px;
      ">
        <img src="/assets/lobby/icon-missions.png" alt="" style="width:73px; height:76px; display:block; object-fit:contain; flex-shrink:0;">
        <div style="flex:1; min-width:0;">
          <div style="font-size:15px; font-weight:800; color:#60a5fa; text-transform:uppercase; letter-spacing:0.05em;">Дневни мисии</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px; font-weight:400;">Изпълнявай дневни мисии и печели жълтици.</div>
        </div>
      </div>

      <div style="
        min-height:137px;
        display:flex;
        align-items:flex-end;
        justify-content:flex-end;
        overflow:hidden;
      ">
        <img src="/assets/lobby/footer-decor.png" alt="" style="width:332px; height:137px; display:block; object-fit:contain;">
      </div>
    </div>
  `
}

function renderFooter(): string {
  return `
    <footer style="
      margin-top:16px;
      border-top:1px solid rgba(255,255,255,0.07);
      padding:16px 0;
      display:flex;
      align-items:center;
      gap:0;
    ">
      <div data-lobby-footer-items="1" style="display:flex; align-items:center; gap:30px; flex:1;">
        <div style="display:flex; align-items:center; gap:10px;">
          <img src="/assets/lobby/icon-fair-play.png" alt="" style="height:28px; opacity:0.7;">
          <div>
            <div style="font-size:12px; font-weight:700; color:rgba(255,255,255,0.75);">Честна игра</div>
            <div style="font-size:10px; color:rgba(255,255,255,0.4); font-weight:600;">За коректна и безопасна среда</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <div style="opacity:0.7;">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="rgba(255,255,255,0.6)"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>
          </div>
          <div>
            <div style="font-size:12px; font-weight:700; color:rgba(255,255,255,0.75);">Сигурност</div>
            <div style="font-size:10px; color:rgba(255,255,255,0.4); font-weight:600;">Защита на данни</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style="display:block; flex-shrink:0; opacity:0.88;">
            <circle cx="8" cy="9" r="3.1" stroke="#d4a520" stroke-width="1.7"/>
            <path d="M3.4 19c.7-3.2 2.3-4.8 4.6-4.8s3.9 1.6 4.6 4.8" stroke="#d4a520" stroke-width="1.7" stroke-linecap="round"/>
            <circle cx="15.8" cy="8.2" r="2.5" stroke="rgba(212,165,32,0.72)" stroke-width="1.55"/>
            <path d="M13.2 14.2c.7-.7 1.6-1 2.8-1 2 0 3.5 1.5 4.1 4.4" stroke="rgba(212,165,32,0.72)" stroke-width="1.55" stroke-linecap="round"/>
          </svg>
          <img src="/assets/lobby/icon-users.png" alt="" style="display:none;">
          <div>
            <div style="font-size:12px; font-weight:700; color:rgba(255,255,255,0.75);">Онлайн играчи</div>
            <div style="font-size:10px; color:rgba(255,255,255,0.4); font-weight:600;">2 456</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <div style="opacity:0.7;">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="rgba(255,255,255,0.6)"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
          </div>
          <div>
            <div style="font-size:12px; font-weight:700; color:rgba(255,255,255,0.75);">Помощ</div>
            <div style="font-size:10px; color:rgba(255,255,255,0.4); font-weight:600;">Свържи се с нас</div>
          </div>
        </div>
      </div>
      <img src="/assets/lobby/copyright-pika-2026.png" alt="© Pika.bg 2026 Всички права запазени" style="width:360px; height:31px; display:block; object-fit:contain;">
      <style>
        [data-lobby-footer-items="1"] > div:nth-child(1),
        [data-lobby-footer-items="1"] > div:nth-child(2),
        [data-lobby-footer-items="1"] > div:nth-child(4) {
          display:none !important;
        }
      </style>
    </footer>
  `
}

function renderFriendAvatar(profile: PlayerPublicProfileSnapshot): string {
  const displayName = profile.displayName?.trim() || 'Играч'
  const avatarUrl = profile.avatarUrl?.trim() ?? ''
  const fallbackLetter = escapeHtml(displayName.charAt(0).toUpperCase() || '?')

  if (avatarUrl) {
    return `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`
  }

  return fallbackLetter
}

function renderFriendRelationshipCard(
  relationship: FriendRelationshipSnapshot,
  variant: 'incoming' | 'outgoing' | 'friend',
): string {
  const profile = relationship.profile
  const displayName = profile.displayName?.trim() || 'Играч'
  const profileId = profile.profileId ?? ''

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid rgba(212,165,32,0.26);border-radius:8px;background:linear-gradient(180deg,#141414 0%,#050505 100%);padding:12px;">
      <button type="button" data-lobby-friend-profile="${escapeHtml(profileId)}" style="display:flex;align-items:center;gap:12px;min-width:0;border:0;background:transparent;color:#ffffff;text-align:left;cursor:pointer;padding:0;flex:1;">
        <div style="width:52px;height:52px;border-radius:8px;border:1px solid rgba(212,165,32,0.54);background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:21px;font-weight:900;flex:0 0 auto;">
          ${renderFriendAvatar(profile)}
        </div>
        <div style="min-width:0;">
          <div style="font-size:15px;font-weight:900;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayName)}</div>
          <div style="margin-top:4px;font-size:12px;font-weight:800;color:rgba(255,255,255,0.54);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(profile.rankTitle ?? 'Ранг 1')}</div>
        </div>
      </button>
      ${variant === 'incoming' ? `
        <div style="display:flex;align-items:center;gap:8px;flex:0 0 auto;">
          <button type="button" data-lobby-friend-accept="${escapeHtml(relationship.friendshipId)}" style="height:36px;padding:0 12px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;">Приеми</button>
          <button type="button" data-lobby-friend-reject="${escapeHtml(relationship.friendshipId)}" style="height:36px;padding:0 12px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:#080808;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;">Откажи</button>
        </div>
      ` : `
        <div style="font-size:12px;font-weight:900;color:${variant === 'friend' ? '#fde68a' : 'rgba(255,255,255,0.54)'};white-space:nowrap;">
          ${variant === 'friend' ? 'Приятел' : 'Изчаква отговор'}
        </div>
      `}
      ${variant === 'friend' ? `
        <button type="button" data-lobby-friend-remove="${escapeHtml(relationship.friendshipId)}" style="height:34px;padding:0 10px;border:1px solid rgba(248,113,113,0.36);border-radius:8px;background:rgba(127,29,29,0.22);color:#fecaca;font-size:12px;font-weight:900;cursor:pointer;flex:0 0 auto;">Премахни</button>
      ` : ''}
    </div>
  `
}

function renderFriendSection(
  title: string,
  emptyText: string,
  relationships: FriendRelationshipSnapshot[],
  variant: 'incoming' | 'outgoing' | 'friend',
): string {
  return `
    <section style="display:grid;gap:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid rgba(212,165,32,0.20);padding-bottom:8px;">
        <div style="font-size:17px;font-weight:900;color:#f8fafc;">${escapeHtml(title)}</div>
        <div style="font-size:12px;font-weight:900;color:#d4a520;">${formatAmount(relationships.length)}</div>
      </div>
      ${relationships.length === 0 ? `
        <div style="border:1px dashed rgba(255,255,255,0.14);border-radius:8px;background:rgba(255,255,255,0.03);padding:18px;color:rgba(255,255,255,0.58);font-size:13px;font-weight:800;text-align:center;">
          ${escapeHtml(emptyText)}
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;">
          ${relationships.map((relationship) => renderFriendRelationshipCard(relationship, variant)).join('')}
        </div>
      `}
    </section>
  `
}

function renderFriendsDirectory(state: LobbyScreenState): string {
  if (state.friendsLoading) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.34);background:#050505;border-radius:8px;color:#d4a520;font-size:18px;font-weight:900;">
        Зареждане на приятели...
      </div>
    `
  }

  if (state.friendsErrorText) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(248,113,113,0.34);background:rgba(127,29,29,0.28);border-radius:8px;color:#fecaca;font-size:15px;font-weight:800;text-align:center;padding:20px;">
        ${escapeHtml(state.friendsErrorText)}
      </div>
    `
  }

  const friendships = state.friendships ?? {
    incomingPending: [],
    outgoingPending: [],
    friends: [],
    blocked: [],
  }

  return `
    <section style="min-height:520px;display:grid;gap:18px;align-content:start;">
      <div style="display:flex;align-items:end;justify-content:space-between;gap:16px;border-bottom:1px solid rgba(212,165,32,0.28);padding-bottom:12px;">
        <div>
          <div style="font-size:26px;line-height:1.05;font-weight:900;color:#f8fafc;">Приятели</div>
          <div style="margin-top:6px;font-size:13px;font-weight:700;color:rgba(255,255,255,0.56);">Покани, чакащи отговори и приети приятелства.</div>
        </div>
        <div style="font-size:13px;font-weight:900;color:#d4a520;">${formatAmount(friendships.friends.length)} приятели</div>
      </div>

      ${renderFriendSection('Покани към теб', 'Няма нови покани.', friendships.incomingPending, 'incoming')}
      ${renderFriendSection('Изпратени покани', 'Няма изпратени покани.', friendships.outgoingPending, 'outgoing')}
      ${renderFriendSection('Списък приятели', 'Все още нямаш добавени приятели.', friendships.friends, 'friend')}
    </section>
  `
}

function formatChatTime(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  return new Intl.DateTimeFormat('bg-BG', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function renderChatPanel(state: LobbyScreenState): string {
  if (state.chatLoading) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.34);background:#050505;border-radius:8px;color:#d4a520;font-size:18px;font-weight:900;">
        Зареждане на чат...
      </div>
    `
  }

  const activeConversation = state.chatConversations.find(
    (conversation) => conversation.friendshipId === state.activeChatFriendshipId,
  ) ?? state.chatConversations[0] ?? null

  return `
    <section style="min-height:520px;display:grid;grid-template-columns:360px minmax(0,1fr);gap:14px;align-content:start;">
      <div style="border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:#050505;overflow:hidden;">
        <div style="padding:14px 16px;border-bottom:1px solid rgba(212,165,32,0.24);">
          <div style="font-size:22px;font-weight:900;color:#f8fafc;">Чат</div>
          <div style="margin-top:5px;font-size:12px;font-weight:800;color:rgba(255,255,255,0.54);">Само между приятели. Недостъпен по време на игра.</div>
        </div>
        ${state.chatConversations.length === 0 ? `
          <div style="padding:24px 16px;color:rgba(255,255,255,0.62);font-size:14px;font-weight:800;text-align:center;">
            Добави приятели, за да започнеш чат.
          </div>
        ` : `
          <div style="display:grid;max-height:560px;overflow:auto;">
            ${state.chatConversations.map((conversation) => {
              const isActive = activeConversation?.friendshipId === conversation.friendshipId
              const displayName = conversation.friend.displayName?.trim() || 'Играч'
              const avatarUrl = conversation.friend.avatarUrl?.trim() ?? ''
              const preview = conversation.lastMessage?.body ?? 'Няма съобщения'

              return `
                <button type="button" data-lobby-chat-conversation="${escapeHtml(conversation.friendshipId)}" style="display:flex;align-items:center;gap:12px;border:0;border-bottom:1px solid rgba(255,255,255,0.06);background:${isActive ? 'rgba(212,165,32,0.12)' : 'transparent'};color:#ffffff;text-align:left;padding:12px 14px;cursor:pointer;min-width:0;">
                  <div style="width:46px;height:46px;border-radius:8px;border:1px solid rgba(212,165,32,0.48);background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:19px;font-weight:900;flex:0 0 auto;">
                    ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">` : escapeHtml(displayName.charAt(0).toUpperCase() || '?')}
                  </div>
                  <div style="min-width:0;flex:1;">
                    <div style="font-size:14px;font-weight:900;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayName)}</div>
                    <div style="margin-top:4px;font-size:12px;font-weight:700;color:rgba(255,255,255,0.54);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(preview)}</div>
                  </div>
                </button>
              `
            }).join('')}
          </div>
        `}
      </div>

      <div style="border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:linear-gradient(180deg,#111 0%,#050505 100%);min-width:0;overflow:hidden;">
        ${activeConversation === null ? `
          <div style="min-height:520px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.62);font-size:15px;font-weight:800;text-align:center;padding:20px;">
            Избери приятел от списъка.
          </div>
        ` : `
          <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(212,165,32,0.24);">
            <div style="font-size:19px;font-weight:900;color:#f8fafc;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(activeConversation.friend.displayName ?? 'Играч')}</div>
            ${state.chatErrorText ? `<div style="margin-left:auto;color:#fecaca;font-size:12px;font-weight:800;">${escapeHtml(state.chatErrorText)}</div>` : ''}
          </div>
          <div style="height:410px;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px;">
            ${state.chatMessagesLoading ? `
              <div style="margin:auto;color:#d4a520;font-size:15px;font-weight:900;">Зареждане...</div>
            ` : state.chatMessages.length === 0 ? `
              <div style="margin:auto;color:rgba(255,255,255,0.58);font-size:14px;font-weight:800;text-align:center;">Няма съобщения. Започни разговора.</div>
            ` : state.chatMessages.map((message) => `
              <div style="align-self:${message.isOwnMessage ? 'flex-end' : 'flex-start'};max-width:min(72%,620px);display:grid;gap:4px;">
                <div style="border-radius:8px;background:${message.isOwnMessage ? 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)' : 'rgba(255,255,255,0.08)'};color:${message.isOwnMessage ? '#080808' : '#f8fafc'};padding:9px 11px;font-size:14px;font-weight:800;line-height:1.35;word-break:break-word;">
                  ${escapeHtml(message.body)}
                </div>
                <div style="font-size:10px;font-weight:800;color:rgba(255,255,255,0.42);text-align:${message.isOwnMessage ? 'right' : 'left'};">${escapeHtml(formatChatTime(message.createdAt))}</div>
              </div>
            `).join('')}
          </div>
          <form data-lobby-chat-form="${escapeHtml(activeConversation.friendshipId)}" style="display:flex;gap:10px;padding:14px 16px;border-top:1px solid rgba(212,165,32,0.20);">
            <input name="message" maxlength="1000" autocomplete="off" placeholder="Напиши съобщение..." style="height:42px;flex:1;min-width:0;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:700;outline:none;">
            <button type="submit" style="height:42px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;cursor:pointer;">Изпрати</button>
          </form>
        `}
      </div>
    </section>
  `
}

function renderPlayersDirectory(state: LobbyScreenState): string {
  const players = state.players

  if (state.playersLoading) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.34);background:#050505;border-radius:8px;color:#d4a520;font-size:18px;font-weight:900;">
        Зареждане на играчи...
      </div>
    `
  }

  if (state.playersErrorText) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(248,113,113,0.34);background:rgba(127,29,29,0.28);border-radius:8px;color:#fecaca;font-size:15px;font-weight:800;text-align:center;padding:20px;">
        ${escapeHtml(state.playersErrorText)}
      </div>
    `
  }

  return `
    <section style="min-height:520px;display:grid;gap:14px;align-content:start;">
      <div style="display:flex;align-items:end;justify-content:space-between;gap:16px;border-bottom:1px solid rgba(212,165,32,0.28);padding-bottom:12px;">
        <div>
          <div style="font-size:26px;line-height:1.05;font-weight:900;color:#f8fafc;">Всички играчи</div>
          <div style="margin-top:6px;font-size:13px;font-weight:700;color:rgba(255,255,255,0.56);">Профили, ранг, рейтинг и галерия.</div>
        </div>
        <div style="font-size:13px;font-weight:900;color:#d4a520;">${formatAmount(players.length)} играчи</div>
      </div>

      ${players.length === 0 ? `
        <div style="min-height:360px;display:flex;align-items:center;justify-content:center;border:1px dashed rgba(255,255,255,0.16);background:rgba(255,255,255,0.03);border-radius:8px;color:rgba(255,255,255,0.62);font-size:15px;font-weight:800;">
          Все още няма регистрирани играчи.
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(5, minmax(0, 1fr));gap:12px;">
          ${players.map((player) => {
            const displayName = player.displayName?.trim() || 'Играч'
            const avatarUrl = player.avatarUrl?.trim() ?? ''
            const fallbackLetter = escapeHtml(displayName.charAt(0).toUpperCase() || '?')

            return `
              <button type="button" data-lobby-player-card="${escapeHtml(player.profileId ?? '')}" style="display:grid;gap:10px;text-align:left;border:1px solid rgba(212,165,32,0.32);border-radius:8px;background:linear-gradient(180deg,#141414 0%,#050505 100%);padding:12px;color:#ffffff;cursor:pointer;min-width:0;">
                <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                  <div style="width:54px;height:54px;border-radius:8px;border:1px solid rgba(212,165,32,0.56);background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:22px;font-weight:900;flex:0 0 auto;">
                    ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">` : fallbackLetter}
                  </div>
                  <div style="min-width:0;">
                    <div style="font-size:15px;font-weight:900;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayName)}</div>
                    <div style="margin-top:3px;display:flex;align-items:center;gap:6px;min-width:0;">
                      <div style="font-size:12px;font-weight:800;color:#d4a520;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(player.rankTitle ?? 'Ранг 1')}</div>
                      ${player.isOnline !== undefined ? `<div style="font-size:11px;font-weight:800;color:${player.isOnline ? '#4ade80' : '#f87171'};white-space:nowrap;flex-shrink:0;">${player.isOnline ? 'Онлайн' : 'Офлайн'}</div>` : ''}
                    </div>
                  </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                  <div style="border-radius:8px;background:rgba(255,255,255,0.05);padding:8px;">
                    <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:rgba(255,255,255,0.44);">Оценка</div>
                    <div style="margin-top:4px;font-size:15px;font-weight:900;color:#f8fafc;">${typeof player.averageRating === 'number' ? player.averageRating.toFixed(2) : '-'}</div>
                  </div>
                  <div style="border-radius:8px;background:rgba(255,255,255,0.05);padding:8px;">
                    <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:rgba(255,255,255,0.44);">Игри</div>
                    <div style="margin-top:4px;font-size:15px;font-weight:900;color:#f8fafc;">${formatAmount(player.completedGamesCount ?? 0)}</div>
                  </div>
                </div>
              </button>
            `
          }).join('')}
        </div>
      `}
    </section>
  `
}

const LEADERBOARD_TABS: Array<{
  category: LeaderboardCategory
  label: string
  metricLabel: string
}> = [
  { category: 'balance', label: 'Баланс', metricLabel: 'жълтици' },
  { category: 'rank', label: 'Ранг', metricLabel: 'игри' },
  { category: 'wins', label: 'Победи', metricLabel: 'победи' },
  { category: 'rating', label: 'Рейтинг', metricLabel: 'оценка' },
]

function getLeaderboardMetric(
  category: LeaderboardCategory,
  player: PlayerPublicProfileSnapshot,
): string {
  if (category === 'balance') {
    return formatAmount(player.yellowCoinsBalance ?? 0)
  }

  if (category === 'rank') {
    return formatAmount(player.completedGamesCount ?? 0)
  }

  if (category === 'wins') {
    return formatAmount(player.wonGamesCount ?? 0)
  }

  return typeof player.averageRating === 'number'
    ? player.averageRating.toFixed(2)
    : '-'
}

function renderLeaderboardsDirectory(state: LobbyScreenState): string {
  if (state.leaderboardsLoading) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.34);background:#050505;border-radius:8px;color:#d4a520;font-size:18px;font-weight:900;">
        Зареждане на класации...
      </div>
    `
  }

  if (state.leaderboardsErrorText) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(248,113,113,0.34);background:rgba(127,29,29,0.28);border-radius:8px;color:#fecaca;font-size:15px;font-weight:800;text-align:center;padding:20px;">
        ${escapeHtml(state.leaderboardsErrorText)}
      </div>
    `
  }

  const category = state.activeLeaderboardCategory
  const players = state.leaderboards?.[category] ?? []
  const activeTab = LEADERBOARD_TABS.find((tab) => tab.category === category) ?? LEADERBOARD_TABS[0]

  return `
    <section style="min-height:520px;display:grid;gap:14px;align-content:start;">
      <div style="display:flex;align-items:end;justify-content:space-between;gap:16px;border-bottom:1px solid rgba(212,165,32,0.28);padding-bottom:12px;">
        <div>
          <div style="font-size:26px;line-height:1.05;font-weight:900;color:#f8fafc;">Класации</div>
          <div style="margin-top:6px;font-size:13px;font-weight:700;color:rgba(255,255,255,0.56);">Топ играчи по баланс, ранг, победи и партньорска оценка.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
          ${LEADERBOARD_TABS.map((tab) => {
            const isActive = tab.category === category

            return `
              <button type="button" data-lobby-leaderboard-tab="${tab.category}" style="height:38px;padding:0 14px;border:1px solid ${isActive ? 'rgba(212,165,32,0.78)' : 'rgba(255,255,255,0.12)'};border-radius:8px;background:${isActive ? 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)' : '#080808'};color:${isActive ? '#080808' : '#f8fafc'};font-size:13px;font-weight:900;cursor:pointer;">
                ${escapeHtml(tab.label)}
              </button>
            `
          }).join('')}
        </div>
      </div>

      ${players.length === 0 ? `
        <div style="min-height:360px;display:flex;align-items:center;justify-content:center;border:1px dashed rgba(255,255,255,0.16);background:rgba(255,255,255,0.03);border-radius:8px;color:rgba(255,255,255,0.62);font-size:15px;font-weight:800;">
          Все още няма данни за тази класация.
        </div>
      ` : `
        <div style="display:grid;gap:8px;">
          ${players.map((player, index) => {
            const displayName = player.displayName?.trim() || 'Играч'
            const avatarUrl = player.avatarUrl?.trim() ?? ''
            const fallbackLetter = escapeHtml(displayName.charAt(0).toUpperCase() || '?')
            const position = index + 1
            const medalColor =
              position === 1 ? '#f4c95b' : position === 2 ? '#d4d4d8' : position === 3 ? '#c08457' : 'rgba(255,255,255,0.50)'

            return `
              <button type="button" data-lobby-leaderboard-player="${escapeHtml(player.profileId ?? '')}" style="display:grid;grid-template-columns:64px minmax(0,1fr) 150px 130px 130px;align-items:center;gap:14px;text-align:left;border:1px solid rgba(212,165,32,0.24);border-radius:8px;background:linear-gradient(180deg,#141414 0%,#050505 100%);padding:12px 14px;color:#ffffff;cursor:pointer;min-width:0;">
                <div style="font-size:26px;font-weight:900;color:${medalColor};text-align:center;">#${position}</div>
                <div style="display:flex;align-items:center;gap:12px;min-width:0;">
                  <div style="width:50px;height:50px;border-radius:8px;border:1px solid rgba(212,165,32,0.56);background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:21px;font-weight:900;flex:0 0 auto;">
                    ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">` : fallbackLetter}
                  </div>
                  <div style="min-width:0;">
                    <div style="font-size:15px;font-weight:900;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayName)}</div>
                    <div style="margin-top:4px;font-size:12px;font-weight:800;color:#d4a520;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(player.rankTitle ?? 'Ранг 1')}</div>
                  </div>
                </div>
                <div>
                  <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:rgba(255,255,255,0.44);">${escapeHtml(activeTab.metricLabel)}</div>
                  <div style="margin-top:4px;font-size:18px;font-weight:900;color:#f8fafc;">${escapeHtml(getLeaderboardMetric(category, player))}</div>
                </div>
                <div>
                  <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:rgba(255,255,255,0.44);">игри</div>
                  <div style="margin-top:4px;font-size:15px;font-weight:900;color:#f8fafc;">${formatAmount(player.completedGamesCount ?? 0)}</div>
                </div>
                <div>
                  <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:rgba(255,255,255,0.44);">оценка</div>
                  <div style="margin-top:4px;font-size:15px;font-weight:900;color:#f8fafc;">${typeof player.averageRating === 'number' ? player.averageRating.toFixed(2) : '-'}</div>
                </div>
              </button>
            `
          }).join('')}
        </div>
      `}
    </section>
  `
}

function renderShopPanel(state: LobbyScreenState): string {
  if (state.shopPackagesLoading) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.34);background:#050505;border-radius:8px;color:#d4a520;font-size:18px;font-weight:900;">
        Зареждане на магазина...
      </div>
    `
  }

  if (state.shopPackagesErrorText) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(248,113,113,0.34);background:rgba(127,29,29,0.28);border-radius:8px;color:#fecaca;font-size:15px;font-weight:800;text-align:center;padding:20px;">
        ${escapeHtml(state.shopPackagesErrorText)}
      </div>
    `
  }

  const packages = state.shopPackages
  const isLoggedIn = state.profile.profileId !== null
  const purchaseHistory = `
    ${state.shopPurchaseMessageText ? `
      <div style="border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:rgba(212,165,32,0.08);padding:12px 14px;color:#f8fafc;font-size:13px;font-weight:800;">
        ${escapeHtml(state.shopPurchaseMessageText)}
      </div>
    ` : ''}

    ${isLoggedIn ? `
      <div style="display:grid;gap:10px;border-top:1px solid rgba(212,165,32,0.22);padding-top:14px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div style="font-size:18px;font-weight:900;color:#f8fafc;">История на покупки</div>
          ${state.shopPurchasesLoading ? `<div style="font-size:12px;font-weight:900;color:#d4a520;">Зареждане...</div>` : ''}
        </div>
        ${state.shopPurchases.length === 0 ? `
          <div style="border:1px solid rgba(255,255,255,0.10);border-radius:8px;background:#080808;padding:14px;color:rgba(255,255,255,0.58);font-size:13px;font-weight:800;">Още няма покупки.</div>
        ` : `
          <div style="display:grid;gap:8px;">
            ${state.shopPurchases.map((purchase) => `
              <div style="display:grid;grid-template-columns:1.2fr 0.8fr 0.8fr 0.7fr;gap:10px;align-items:center;border:1px solid rgba(255,255,255,0.10);border-radius:8px;background:#080808;padding:12px;">
                <div>
                  <div style="font-size:14px;font-weight:900;color:#f8fafc;">${escapeHtml(purchase.title)}</div>
                  <div style="margin-top:3px;font-size:11px;font-weight:800;color:rgba(255,255,255,0.42);">${escapeHtml(formatCompactDateTime(purchase.createdAt))}</div>
                </div>
                <div style="font-size:14px;font-weight:900;color:#d4a520;">${formatAmount(purchase.yellowCoinsAmount)}</div>
                <div style="font-size:14px;font-weight:900;color:#f8fafc;">${escapeHtml(formatPackagePrice(purchase.priceCents, purchase.currency))}</div>
                <div style="font-size:12px;font-weight:900;color:${getPurchaseStatusColor(purchase.status)};">${escapeHtml(formatPurchaseStatusLabel(purchase.status))}</div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    ` : ''}
  `

  return `
    <section style="min-height:520px;display:grid;gap:18px;align-content:start;">
      <div style="display:flex;align-items:end;justify-content:space-between;gap:16px;border-bottom:1px solid rgba(212,165,32,0.28);padding-bottom:12px;">
        <div>
          <div style="font-size:26px;line-height:1.05;font-weight:900;color:#f8fafc;">Магазин</div>
          <div style="margin-top:6px;font-size:13px;font-weight:700;color:rgba(255,255,255,0.56);">Избери пакет и завърши плащането през Stripe. Жълтиците се добавят след потвърждение.</div>
        </div>
        <div style="border:1px solid rgba(212,165,32,0.28);border-radius:8px;background:#0a0a0a;padding:10px 12px;color:#d4a520;font-size:13px;font-weight:900;">
          Баланс: ${formatAmount(state.profile.yellowCoinsBalance ?? 0)}
        </div>
      </div>

      ${packages.length === 0 ? `
        <div style="min-height:260px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,0.10);background:#080808;border-radius:8px;color:rgba(255,255,255,0.64);font-size:15px;font-weight:800;text-align:center;padding:20px;">
          Няма активни пакети в магазина.
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;">
          ${packages.map((coinPackage) => `
            <article style="display:grid;gap:14px;border:1px solid rgba(212,165,32,0.28);border-radius:8px;background:linear-gradient(180deg,#171717 0%,#050505 100%);padding:18px;min-height:250px;">
              <div style="height:74px;display:flex;align-items:center;justify-content:center;">
                <img src="/assets/lobby/icon-shop-cart.png" alt="" style="width:58px;height:56px;object-fit:contain;filter:drop-shadow(0 8px 14px rgba(0,0,0,0.45));">
              </div>
              <div style="display:grid;gap:6px;">
                <div style="font-size:20px;line-height:1.15;font-weight:900;color:#f8fafc;">${escapeHtml(coinPackage.title)}</div>
                <div style="font-size:34px;line-height:1;font-weight:900;color:#d4a520;">${formatAmount(coinPackage.yellowCoinsAmount)}</div>
                <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.46);">жълтици</div>
              </div>
              <div style="min-height:40px;font-size:13px;line-height:1.45;font-weight:700;color:rgba(255,255,255,0.62);">${escapeHtml(coinPackage.description)}</div>
              <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:auto;">
                <div style="font-size:18px;font-weight:900;color:#f8fafc;">${escapeHtml(formatPackagePrice(coinPackage.priceCents, coinPackage.currency))}</div>
                <button type="button" data-lobby-shop-package="${escapeHtml(coinPackage.packageId)}" ${state.shopPurchaseActionPackageId === coinPackage.packageId ? 'disabled' : ''} style="height:42px;padding:0 14px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:${state.shopPurchaseActionPackageId === coinPackage.packageId ? 'wait' : 'pointer'};">
                  ${state.shopPurchaseActionPackageId === coinPackage.packageId ? 'Към плащане...' : isLoggedIn ? 'Купи' : 'Влез за покупка'}
                </button>
              </div>
            </article>
          `).join('')}
        </div>
      `}

      ${purchaseHistory}
    </section>
  `
}

function renderAdminPanel(state: LobbyScreenState): string {
  if (!state.isAdmin) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(248,113,113,0.34);background:rgba(127,29,29,0.28);border-radius:8px;color:#fecaca;font-size:15px;font-weight:800;text-align:center;padding:20px;">
        Нямаш достъп до админ панела.
      </div>
    `
  }

  if (state.adminSettingsLoading) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.34);background:#050505;border-radius:8px;color:#d4a520;font-size:18px;font-weight:900;">
        Зареждане на настройки...
      </div>
    `
  }

  const settings = state.adminSettings ?? {
    signupBonusYellowCoins: state.signupBonusYellowCoins,
    profileNameChangePrice: 50_000,
  }
  const adminPackages = state.adminCoinPackages

  return `
    <section style="min-height:520px;display:grid;gap:14px;align-content:start;">
      <div style="display:flex;align-items:end;justify-content:space-between;gap:16px;border-bottom:1px solid rgba(212,165,32,0.28);padding-bottom:12px;">
        <div>
          <div style="font-size:26px;line-height:1.05;font-weight:900;color:#f8fafc;">Админ панел</div>
          <div style="margin-top:6px;font-size:13px;font-weight:700;color:rgba(255,255,255,0.56);">Настройки за икономика и профили.</div>
        </div>
      </div>

      <form data-lobby-admin-settings-form="1" style="width:min(100%,680px);display:grid;gap:14px;border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:linear-gradient(180deg,#141414 0%,#050505 100%);padding:18px;">
        <label style="display:grid;gap:7px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
          Signup bonus жълтици
          <input name="signupBonusYellowCoins" type="number" min="0" max="10000000" step="1000" value="${settings.signupBonusYellowCoins}" style="height:44px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:800;outline:none;">
        </label>

        <label style="display:grid;gap:7px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
          Цена за смяна на име
          <input name="profileNameChangePrice" type="number" min="0" max="10000000" step="1000" value="${settings.profileNameChangePrice}" style="height:44px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:800;outline:none;">
        </label>

        ${state.adminSettingsErrorText ? `
          <div style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;">
            ${escapeHtml(state.adminSettingsErrorText)}
          </div>
        ` : ''}

        <div style="display:flex;justify-content:flex-end;">
          <button type="submit" style="height:44px;padding:0 18px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;cursor:pointer;">
            Запази
          </button>
        </div>
      </form>

      <div style="display:grid;gap:12px;margin-top:8px;">
        <div style="display:flex;align-items:end;justify-content:space-between;gap:12px;">
          <div>
            <div style="font-size:20px;line-height:1.1;font-weight:900;color:#f8fafc;">Пакети жълтици</div>
            <div style="margin-top:5px;font-size:12px;font-weight:700;color:rgba(255,255,255,0.54);">Активните пакети се показват в магазина.</div>
          </div>
          ${state.adminCoinPackagesLoading ? `
            <div style="font-size:12px;font-weight:900;color:#d4a520;">Зареждане...</div>
          ` : ''}
        </div>

        ${state.adminCoinPackagesErrorText ? `
          <div style="width:min(100%,980px);border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;">
            ${escapeHtml(state.adminCoinPackagesErrorText)}
          </div>
        ` : ''}

        <div style="width:min(100%,980px);display:grid;gap:8px;">
          ${adminPackages.length === 0 ? `
            <div style="border:1px solid rgba(255,255,255,0.10);border-radius:8px;background:#080808;padding:14px;color:rgba(255,255,255,0.58);font-size:13px;font-weight:800;">Няма създадени пакети.</div>
          ` : adminPackages.map((coinPackage) => `
            <div style="display:grid;grid-template-columns:1.2fr 0.9fr 0.8fr 0.7fr auto;gap:10px;align-items:center;border:1px solid rgba(255,255,255,0.10);border-radius:8px;background:#090909;padding:12px;">
              <div>
                <div style="font-size:14px;font-weight:900;color:#f8fafc;">${escapeHtml(coinPackage.title)}</div>
                <div style="margin-top:3px;font-size:11px;font-weight:800;color:rgba(255,255,255,0.44);">${escapeHtml(coinPackage.packageKey)}</div>
              </div>
              <div style="font-size:14px;font-weight:900;color:#d4a520;">${formatAmount(coinPackage.yellowCoinsAmount)}</div>
              <div style="font-size:14px;font-weight:900;color:#f8fafc;">${escapeHtml(formatPackagePrice(coinPackage.priceCents, coinPackage.currency))}</div>
              <div style="font-size:12px;font-weight:900;color:${coinPackage.status === 'active' ? '#86efac' : 'rgba(255,255,255,0.46)'};">${coinPackage.status}</div>
              <button type="button" data-lobby-admin-package-status="${escapeHtml(coinPackage.packageId)}" data-lobby-admin-package-next-status="${coinPackage.status === 'active' ? 'inactive' : 'active'}" style="height:36px;padding:0 12px;border:1px solid rgba(212,165,32,0.28);border-radius:8px;background:#111111;color:#d4a520;font-size:12px;font-weight:900;cursor:pointer;">
                ${coinPackage.status === 'active' ? 'Скрий' : 'Активирай'}
              </button>
            </div>
          `).join('')}
        </div>

        <form data-lobby-admin-coin-package-form="1" style="width:min(100%,980px);display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:linear-gradient(180deg,#141414 0%,#050505 100%);padding:18px;">
          <label style="display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Ключ
            <input name="packageKey" type="text" maxlength="48" placeholder="starter" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;">
          </label>
          <label style="display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Име
            <input name="title" type="text" maxlength="80" placeholder="Starter" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;">
          </label>
          <label style="display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Жълтици
            <input name="yellowCoinsAmount" type="number" min="1" max="100000000" step="1000" value="100000" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;">
          </label>
          <label style="display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Цена в центове
            <input name="priceCents" type="number" min="0" max="10000000" step="1" value="499" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;">
          </label>
          <label style="display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Валута
            <input name="currency" type="text" maxlength="3" value="EUR" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;text-transform:uppercase;">
          </label>
          <label style="display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Подредба
            <input name="sortOrder" type="number" min="0" max="1000000" step="1" value="50" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;">
          </label>
          <label style="display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Статус
            <select name="status" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;">
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </label>
          <label style="grid-column:1 / -1;display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Описание
            <input name="description" type="text" maxlength="220" placeholder="Описание за магазина" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;">
          </label>
          <div style="grid-column:1 / -1;display:flex;justify-content:flex-end;">
            <button type="submit" style="height:42px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;">
              Запази пакет
            </button>
          </div>
        </form>
      </div>
    </section>
  `
}

export function renderLobbyScreen(
  root: HTMLElement,
  options: RenderLobbyScreenOptions,
): void {
  const { state } = options
  const canStartSearch = state.isConnected && !state.isSearching
  const profileName = state.displayName.trim() || 'Играч'

  root.innerHTML = `
    <div
      data-lobby-screen-root="1"
      style="
        position: fixed;
        inset: 0;
        background: #242424;
        color: #ffffff;
        font-family: Arial, Helvetica, sans-serif;
        overflow-y: auto;
        overflow-x: hidden;
        z-index: 50;
      "
    >
      <style>
        [data-lobby-screen-root="1"] {
          --lobby-scale: 1;
        }

        @media (min-width: 2200px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 1.08; }
        }

        @media (min-width: 1920px) and (max-width: 2199px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 1.02; }
        }

        @media (max-width: 1700px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.96; }
        }

        @media (max-width: 1600px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.91; }
        }

        @media (max-width: 1500px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.86; }
        }

        @media (max-width: 1400px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.80; }
        }

        @media (max-width: 1280px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.73; }
        }

        @media (max-width: 1120px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.64; }
        }

        @media (max-width: 960px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.55; }
        }

        @media (max-width: 768px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.45; }
        }
      </style>

      <div data-lobby-scale-stage="1" style="width:1640px; margin:0 auto; zoom:var(--lobby-scale);">
        ${renderNav(state)}

        <div style="max-width: 1640px; margin: 0 auto; padding: 16px 20px; background:#000000; box-sizing:border-box;">
          ${state.view === 'players'
            ? renderPlayersDirectory(state)
            : state.view === 'leaderboards'
              ? renderLeaderboardsDirectory(state)
              : state.view === 'shop'
                ? renderShopPanel(state)
              : state.view === 'admin'
                ? renderAdminPanel(state)
            : state.view === 'friends'
              ? renderFriendsDirectory(state)
              : state.view === 'chat'
                ? renderChatPanel(state)
              : `
              ${renderHeroSection(profileName, state.isConnected, state.profile.avatarUrl, state.profile.yellowCoinsBalance, state.profile.wonGamesCount, state.profile.completedGamesCount, state.profile.rankTitle)}
              ${renderStakeSection(state.selectedStake, canStartSearch, state.isSearching)}
              ${renderBottomSection()}
            `}
          ${renderFooter()}
        </div>
      </div>

      ${state.isSearching ? `
        <div style="
          position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
          z-index:200;
          background:linear-gradient(135deg, #111111 0%, #080808 100%);
          border:1px solid rgba(212,165,32,0.4);
          border-radius:16px;
          padding:14px 24px;
          display:flex; align-items:center; gap:16px;
          box-shadow:0 8px 32px rgba(0,0,0,0.5);
          min-width:360px;
        ">
          <div style="
            width:12px; height:12px; border-radius:50%;
            background:#d4a520;
            animation:pulse 1.2s ease-in-out infinite;
            flex-shrink:0;
          "></div>
          <div style="flex:1;">
            <div style="font-size:14px; font-weight:800; color:#d4a520;">${escapeHtml(state.statusText)}</div>
            <div style="font-size:12px; color:rgba(255,255,255,0.55); margin-top:2px; font-weight:600;">Търсенето е активно. Играта ще стартира автоматично.</div>
          </div>
          <button
            type="button"
            data-lobby-cancel-button="1"
            style="
              background:linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
              border:none; border-radius:10px;
              padding:9px 16px;
              font-size:13px; font-weight:800;
              color:#f5f3ff; cursor:pointer;
              white-space:nowrap;
            "
          >Откажи</button>
        </div>

        <style>
          @keyframes pulse {
            0%, 100% { opacity:1; transform:scale(1); }
            50% { opacity:0.5; transform:scale(0.8); }
          }
        </style>
      ` : ''}

      ${state.errorText ? `
        <div style="
          position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
          z-index:200;
          background:rgba(127,29,29,0.95);
          border:1px solid rgba(248,113,113,0.3);
          border-radius:12px;
          padding:12px 20px;
          font-size:13px; font-weight:700; color:#fecaca;
          box-shadow:0 8px 24px rgba(0,0,0,0.4);
          max-width:480px;
          text-align:center;
        ">
          ${escapeHtml(state.errorText)}
        </div>
      ` : ''}

      ${renderProfileEditModal(state)}
      ${renderGiftCoinsModal(state)}
      ${renderAuthModal(state)}
    </div>
  `

  const stakeButtons = root.querySelectorAll<HTMLButtonElement>('[data-lobby-stake-card]')

  stakeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (!canStartSearch) {
        return
      }

      const rawStake = Number(button.dataset.lobbyStakeCard)
      const selectedCard = MATCH_STAKE_CARDS.find((card) => card.stake === rawStake)

      if (!selectedCard) {
        return
      }

      options.onStakeChange(selectedCard.stake)
      options.onSearchClick()
    })
  })

  const cancelButton = root.querySelector<HTMLButtonElement>('[data-lobby-cancel-button="1"]')

  cancelButton?.addEventListener('click', () => {
    options.onCancelClick()
  })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-profile-button="1"]')
    ?.addEventListener('click', (event) => {
      event.preventDefault()
      options.onProfileClick()
    })

  root
    .querySelector<HTMLElement>('[data-lobby-nav-lobby="1"]')
    ?.addEventListener('click', (event) => {
      event.preventDefault()
      options.onLobbyClick()
    })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-nav-players="1"]')
    ?.addEventListener('click', options.onPlayersClick)

  root
    .querySelector<HTMLButtonElement>('[data-lobby-nav-leaderboards="1"]')
    ?.addEventListener('click', options.onLeaderboardsClick)

  root
    .querySelector<HTMLButtonElement>('[data-lobby-nav-shop="1"]')
    ?.addEventListener('click', options.onShopClick)

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-shop-package]').forEach((button) => {
    button.addEventListener('click', () => {
      const packageId = button.dataset.lobbyShopPackage?.trim() ?? ''

      if (packageId.length > 0) {
        options.onShopPurchaseClick(packageId)
      }
    })
  })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-nav-admin="1"]')
    ?.addEventListener('click', options.onAdminClick)

  root
    .querySelector<HTMLButtonElement>('[data-lobby-nav-friends="1"]')
    ?.addEventListener('click', options.onFriendsClick)

  root
    .querySelector<HTMLButtonElement>('[data-lobby-nav-chat="1"]')
    ?.addEventListener('click', options.onChatClick)

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-chat-conversation]').forEach((button) => {
    button.addEventListener('click', () => {
      const friendshipId = button.dataset.lobbyChatConversation?.trim() ?? ''

      if (friendshipId.length > 0) {
        options.onChatConversationClick(friendshipId)
      }
    })
  })

  root.querySelectorAll<HTMLFormElement>('[data-lobby-chat-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const friendshipId = form.dataset.lobbyChatForm?.trim() ?? ''
      const data = new FormData(form)
      const body = String(data.get('message') ?? '').trim()

      if (friendshipId.length > 0 && body.length > 0) {
        options.onChatSubmit(friendshipId, body)
        form.reset()
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-player-card]').forEach((button) => {
    button.addEventListener('click', () => {
      const profileId = button.dataset.lobbyPlayerCard ?? ''
      const profile = state.players.find((player) => player.profileId === profileId)

      if (profile) {
        options.onPlayerCardClick(profile)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-leaderboard-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const category = button.dataset.lobbyLeaderboardTab as LeaderboardCategory | undefined

      if (
        category === 'balance' ||
        category === 'rank' ||
        category === 'wins' ||
        category === 'rating'
      ) {
        options.onLeaderboardCategoryClick(category)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-leaderboard-player]').forEach((button) => {
    button.addEventListener('click', () => {
      const profileId = button.dataset.lobbyLeaderboardPlayer ?? ''
      const leaderboards = state.leaderboards
      const profile = leaderboards
        ? [
            ...leaderboards.balance,
            ...leaderboards.rank,
            ...leaderboards.wins,
            ...leaderboards.rating,
          ].find((player) => player.profileId === profileId)
        : null

      if (profile) {
        options.onLeaderboardPlayerClick(profile)
      }
    })
  })

  root
    .querySelector<HTMLFormElement>('[data-lobby-admin-settings-form="1"]')
    ?.addEventListener('submit', (event) => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      const data = new FormData(form)
      const signupBonusYellowCoins = Number(data.get('signupBonusYellowCoins'))
      const profileNameChangePrice = Number(data.get('profileNameChangePrice'))

      options.onAdminSettingsSubmit({
        signupBonusYellowCoins,
        profileNameChangePrice,
      })
    })

  root
    .querySelector<HTMLFormElement>('[data-lobby-admin-coin-package-form="1"]')
    ?.addEventListener('submit', (event) => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      const data = new FormData(form)
      const status = String(data.get('status') ?? '')

      if (status !== 'active' && status !== 'inactive') {
        return
      }

      options.onAdminCoinPackageSubmit({
        packageKey: String(data.get('packageKey') ?? '').trim(),
        title: String(data.get('title') ?? '').trim(),
        description: String(data.get('description') ?? '').trim(),
        yellowCoinsAmount: Number(data.get('yellowCoinsAmount')),
        priceCents: Number(data.get('priceCents')),
        currency: String(data.get('currency') ?? 'EUR').trim().toUpperCase(),
        status,
        sortOrder: Number(data.get('sortOrder')),
      })
    })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-admin-package-status]').forEach((button) => {
    button.addEventListener('click', () => {
      const packageId = button.dataset.lobbyAdminPackageStatus?.trim() ?? ''
      const status = button.dataset.lobbyAdminPackageNextStatus ?? ''

      if (packageId.length > 0 && (status === 'active' || status === 'inactive')) {
        options.onAdminCoinPackageStatusChange(packageId, status)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-friend-profile]').forEach((button) => {
    button.addEventListener('click', () => {
      const profileId = button.dataset.lobbyFriendProfile ?? ''
      const friendshipGroups = state.friendships
        ? [
            ...state.friendships.incomingPending,
            ...state.friendships.outgoingPending,
            ...state.friendships.friends,
            ...state.friendships.blocked,
          ]
        : []
      const relationship = friendshipGroups.find(
        (item) => item.profile.profileId === profileId,
      )

      if (relationship) {
        options.onFriendProfileClick(relationship.profile)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-friend-accept]').forEach((button) => {
    button.addEventListener('click', () => {
      const friendshipId = button.dataset.lobbyFriendAccept?.trim() ?? ''

      if (friendshipId.length > 0) {
        options.onFriendAcceptClick(friendshipId)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-friend-reject]').forEach((button) => {
    button.addEventListener('click', () => {
      const friendshipId = button.dataset.lobbyFriendReject?.trim() ?? ''

      if (friendshipId.length > 0) {
        options.onFriendRejectClick(friendshipId)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-friend-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      const friendshipId = button.dataset.lobbyFriendRemove?.trim() ?? ''

      if (friendshipId.length > 0) {
        options.onFriendRemoveClick(friendshipId)
      }
    })
  })

  // Управление на профил попъпа директно на document.body (без участие в root.innerHTML)
  syncProfilePopup(
    {
      isOpen: state.profilePopupOpen,
      profile: state.profilePopupProfile ?? state.profile,
      canEdit: state.profilePopupCanEdit,
      friendshipAction: state.friendshipAction,
    },
    {
      onClose: options.onProfileClose,
      onEditClick: options.onProfileEditClick,
      onFriendRequestClick: options.onFriendRequestClick,
      onFriendBlockClick: options.onFriendBlockClick,
      onFriendAcceptClick: options.onFriendAcceptClick,
      onFriendRejectClick: options.onFriendRejectClick,
      onFriendRemoveClick: options.onFriendRemoveClick,
      onGiftCoinsClick: options.onGiftCoinsClick,
    },
  )

  root
    .querySelector<HTMLButtonElement>('[data-lobby-gift-modal-close="1"]')
    ?.addEventListener('click', options.onGiftCoinsClose)

  root
    .querySelector<HTMLButtonElement>('[data-lobby-gift-modal-cancel="1"]')
    ?.addEventListener('click', options.onGiftCoinsClose)

  root
    .querySelector<HTMLElement>('[data-lobby-gift-modal-backdrop="1"]')
    ?.addEventListener('click', options.onGiftCoinsClose)

  root.querySelectorAll<HTMLFormElement>('[data-lobby-gift-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const friendshipId = form.dataset.lobbyGiftForm?.trim() ?? ''
      const data = new FormData(form)
      const amount = Number(data.get('amount') ?? 0)

      if (friendshipId.length > 0) {
        options.onGiftCoinsSubmit(friendshipId, amount)
      }
    })
  })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-profile-editor-close="1"]')
    ?.addEventListener('click', options.onProfileEditClose)

  root
    .querySelector<HTMLButtonElement>('[data-lobby-profile-editor-cancel="1"]')
    ?.addEventListener('click', options.onProfileEditClose)

  root
    .querySelector<HTMLElement>('[data-lobby-profile-editor-backdrop="1"]')
    ?.addEventListener('click', options.onProfileEditClose)

  const avatarInput = root.querySelector<HTMLInputElement>(
    'input[name="avatarFile"]',
  )

  root.querySelector<HTMLElement>('[data-avatar-pick-btn="1"]')?.addEventListener('click', () => {
    avatarInput?.click()
  })

  let currentCrop: AvatarCropSelection | null = null

  function openCropOverlay(file: File): void {
    const overlay = document.createElement('div')
    overlay.setAttribute('data-avatar-crop-overlay', '1')
    overlay.style.cssText = [
      'position:fixed;inset:0;z-index:14000;',
      'background:#0a0a0a;',
      'display:flex;flex-direction:column;',
      'font-family:Arial,Helvetica,sans-serif;',
    ].join('')

    overlay.innerHTML = `
      <div style="flex:0 0 auto;padding:14px 20px;background:#0a0a0a;border-bottom:1px solid rgba(255,255,255,0.10);display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
        <div style="font-size:14px;font-weight:700;color:rgba(255,255,255,0.80);line-height:1.4;">
          Очертайте с мишката зона от снимката която искате да използвате за аватар.
        </div>
        <div style="display:flex;gap:10px;flex-shrink:0;">
          <button type="button" data-crop-cancel="1" style="height:40px;padding:0 16px;border:1px solid rgba(255,255,255,0.18);border-radius:8px;background:#080808;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;">Откажи</button>
          <button type="button" data-crop-confirm="1" style="height:40px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;">Потвърди избора</button>
        </div>
      </div>
      <div data-crop-box="1" style="flex:1;position:relative;overflow:hidden;user-select:none;touch-action:none;display:flex;align-items:center;justify-content:center;background:#111;cursor:crosshair;">
        <img data-crop-image="1" alt="" style="max-width:100%;max-height:100%;display:block;object-fit:contain;pointer-events:none;">
        <div data-crop-selection="1" style="position:absolute;display:none;border:2px solid #f4c95b;background:rgba(212,165,32,0.10);box-shadow:0 0 0 9999px rgba(0,0,0,0.54);pointer-events:none;"></div>
      </div>
    `

    document.body.appendChild(overlay)

    const overlayImage = overlay.querySelector<HTMLImageElement>('[data-crop-image="1"]')!
    const overlayBox = overlay.querySelector<HTMLElement>('[data-crop-box="1"]')!
    const overlaySelection = overlay.querySelector<HTMLElement>('[data-crop-selection="1"]')!

    overlayImage.src = URL.createObjectURL(file)

    let startX = 0
    let startY = 0
    let pendingCrop: AvatarCropSelection | null = null

    function clearOverlayCrop(): void {
      pendingCrop = null
      overlaySelection.style.display = 'none'
    }

    function getOverlayPoint(event: PointerEvent): { x: number; y: number } | null {
      const rect = overlayImage.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left))
      const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top))
      return { x, y }
    }

    function drawOverlayCrop(currentX: number, currentY: number): void {
      const rect = overlayImage.getBoundingClientRect()
      const boxRect = overlayBox.getBoundingClientRect()
      const deltaX = currentX - startX
      const deltaY = currentY - startY
      const size = Math.min(Math.abs(deltaX), Math.abs(deltaY))
      if (size < 4) { clearOverlayCrop(); return }
      const dirX = deltaX >= 0 ? 1 : -1
      const dirY = deltaY >= 0 ? 1 : -1
      const displayX = dirX > 0 ? startX : startX - size
      const displayY = dirY > 0 ? startY : startY - size
      const boundedX = Math.max(0, Math.min(rect.width - size, displayX))
      const boundedY = Math.max(0, Math.min(rect.height - size, displayY))
      overlaySelection.style.display = 'block'
      overlaySelection.style.left = `${rect.left - boxRect.left + boundedX}px`
      overlaySelection.style.top = `${rect.top - boxRect.top + boundedY}px`
      overlaySelection.style.width = `${size}px`
      overlaySelection.style.height = `${size}px`
      pendingCrop = {
        x: (boundedX / rect.width) * overlayImage.naturalWidth,
        y: (boundedY / rect.height) * overlayImage.naturalHeight,
        size: (size / rect.width) * overlayImage.naturalWidth,
      }
    }

    overlayBox.addEventListener('pointerdown', (event) => {
      const point = getOverlayPoint(event)
      if (point === null) return
      event.preventDefault()
      overlayBox.setPointerCapture(event.pointerId)
      startX = point.x
      startY = point.y
      drawOverlayCrop(point.x, point.y)
    })

    overlayBox.addEventListener('pointermove', (event) => {
      if (!overlayBox.hasPointerCapture(event.pointerId)) return
      const point = getOverlayPoint(event)
      if (point === null) return
      event.preventDefault()
      drawOverlayCrop(point.x, point.y)
    })

    overlayBox.addEventListener('pointerup', (event) => {
      if (overlayBox.hasPointerCapture(event.pointerId)) {
        overlayBox.releasePointerCapture(event.pointerId)
      }
    })

    overlay.querySelector('[data-crop-confirm="1"]')?.addEventListener('click', () => {
      currentCrop = pendingCrop
      overlay.remove()

      if (currentCrop !== null && avatarInput?.files?.[0]) {
        const crop = currentCrop
        const canvas = document.createElement('canvas')
        canvas.width = 250
        canvas.height = 250
        const ctx = canvas.getContext('2d')
        if (ctx) {
          const img = new Image()
          const objectUrl = URL.createObjectURL(avatarInput.files[0])
          img.onload = () => {
            ctx.drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, 250, 250)
            const pickBtn = root.querySelector<HTMLElement>('[data-avatar-pick-btn="1"]')
            if (pickBtn) {
              const dataUrl = canvas.toDataURL('image/webp')
              pickBtn.innerHTML = `<img src="${dataUrl}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;position:absolute;inset:0;"><div style="position:absolute;inset:0;background:rgba(0,0,0,0.50);display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:12px;font-weight:900;letter-spacing:0.04em;">Смени</span></div>`
            }
            URL.revokeObjectURL(objectUrl)
          }
          img.src = objectUrl
        }
      }
    })

    overlay.querySelector('[data-crop-cancel="1"]')?.addEventListener('click', () => {
      currentCrop = null
      if (avatarInput) avatarInput.value = ''
      const pickBtn = root.querySelector<HTMLElement>('[data-avatar-pick-btn="1"]')
      if (pickBtn) {
        pickBtn.innerHTML = state.profile.avatarUrl
          ? `<img src="${escapeHtml(state.profile.avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;position:absolute;inset:0;"><div style="position:absolute;inset:0;background:rgba(0,0,0,0.50);display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:12px;font-weight:900;letter-spacing:0.04em;">Смени</span></div>`
          : `<span style="color:rgba(212,165,32,0.70);font-size:36px;font-weight:300;line-height:1;">+</span>`
      }
      overlay.remove()
    })
  }

  avatarInput?.addEventListener('change', () => {
    const file = avatarInput.files?.[0] ?? null
    currentCrop = null
    if (!file) return
    if (file.size > 10_000_000) {
      avatarInput.value = ''
      options.onProfileEditorFileError('Снимката трябва да е до 10 МБ.')
      return
    }
    openCropOverlay(file)
  })

  const pendingGalleryItems: Array<{ file: File; crop: AvatarCropSelection; dataUrl: string }> = []
  const galleryGrid = root.querySelector<HTMLElement>('[data-gallery-grid="1"]')
  const galleryFileInput = root.querySelector<HTMLInputElement>('[data-gallery-file-input="1"]')

  function addGalleryEmptySlot(): void {
    if (!galleryGrid) return
    const slot = document.createElement('div')
    slot.setAttribute('data-gallery-add-slot', '1')
    slot.setAttribute('role', 'button')
    slot.setAttribute('tabindex', '0')
    slot.style.cssText = 'aspect-ratio:1/1;border-radius:8px;border:2px dashed rgba(255,255,255,0.20);background:#101010;display:flex;align-items:center;justify-content:center;cursor:pointer;'
    slot.innerHTML = '<span style="color:rgba(255,255,255,0.40);font-size:28px;font-weight:300;line-height:1;">+</span>'
    slot.addEventListener('click', () => galleryFileInput?.click())
    galleryGrid.appendChild(slot)
  }

  function openGalleryCropOverlay(file: File): void {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:14000;background:#0a0a0a;display:flex;flex-direction:column;font-family:Arial,Helvetica,sans-serif;'
    overlay.innerHTML = `
      <div style="flex:0 0 auto;padding:14px 20px;background:#0a0a0a;border-bottom:1px solid rgba(255,255,255,0.10);display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
        <div style="font-size:14px;font-weight:700;color:rgba(255,255,255,0.80);line-height:1.4;">
          Очертайте с мишката зона от снимката която искате да добавите в галерията.
        </div>
        <div style="display:flex;gap:10px;flex-shrink:0;">
          <button type="button" data-gallery-crop-cancel="1" style="height:40px;padding:0 16px;border:1px solid rgba(255,255,255,0.18);border-radius:8px;background:#080808;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;">Откажи</button>
          <button type="button" data-gallery-crop-confirm="1" style="height:40px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;">Добави в галерията</button>
        </div>
      </div>
      <div data-gallery-crop-box="1" style="flex:1;position:relative;overflow:hidden;user-select:none;touch-action:none;display:flex;align-items:center;justify-content:center;background:#111;cursor:crosshair;">
        <img data-gallery-crop-image="1" alt="" style="max-width:100%;max-height:100%;display:block;object-fit:contain;pointer-events:none;">
        <div data-gallery-crop-selection="1" style="position:absolute;display:none;border:2px solid #f4c95b;background:rgba(212,165,32,0.10);box-shadow:0 0 0 9999px rgba(0,0,0,0.54);pointer-events:none;"></div>
      </div>
    `
    document.body.appendChild(overlay)

    const overlayImage = overlay.querySelector<HTMLImageElement>('[data-gallery-crop-image="1"]')!
    const overlayBox = overlay.querySelector<HTMLElement>('[data-gallery-crop-box="1"]')!
    const overlaySelection = overlay.querySelector<HTMLElement>('[data-gallery-crop-selection="1"]')!
    overlayImage.src = URL.createObjectURL(file)

    let startX = 0
    let startY = 0
    let pendingCrop: AvatarCropSelection | null = null

    function clearGalleryCrop(): void {
      pendingCrop = null
      overlaySelection.style.display = 'none'
    }

    function getGalleryPoint(event: PointerEvent): { x: number; y: number } | null {
      const rect = overlayImage.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left))
      const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top))
      return { x, y }
    }

    function drawGalleryCrop(currentX: number, currentY: number): void {
      const rect = overlayImage.getBoundingClientRect()
      const boxRect = overlayBox.getBoundingClientRect()
      const deltaX = currentX - startX
      const deltaY = currentY - startY
      const size = Math.min(Math.abs(deltaX), Math.abs(deltaY))
      if (size < 4) { clearGalleryCrop(); return }
      const dirX = deltaX >= 0 ? 1 : -1
      const dirY = deltaY >= 0 ? 1 : -1
      const displayX = dirX > 0 ? startX : startX - size
      const displayY = dirY > 0 ? startY : startY - size
      const boundedX = Math.max(0, Math.min(rect.width - size, displayX))
      const boundedY = Math.max(0, Math.min(rect.height - size, displayY))
      overlaySelection.style.display = 'block'
      overlaySelection.style.left = `${rect.left - boxRect.left + boundedX}px`
      overlaySelection.style.top = `${rect.top - boxRect.top + boundedY}px`
      overlaySelection.style.width = `${size}px`
      overlaySelection.style.height = `${size}px`
      pendingCrop = {
        x: (boundedX / rect.width) * overlayImage.naturalWidth,
        y: (boundedY / rect.height) * overlayImage.naturalHeight,
        size: (size / rect.width) * overlayImage.naturalWidth,
      }
    }

    overlayBox.addEventListener('pointerdown', (event) => {
      const point = getGalleryPoint(event)
      if (point === null) return
      event.preventDefault()
      overlayBox.setPointerCapture(event.pointerId)
      startX = point.x
      startY = point.y
      drawGalleryCrop(point.x, point.y)
    })

    overlayBox.addEventListener('pointermove', (event) => {
      if (!overlayBox.hasPointerCapture(event.pointerId)) return
      const point = getGalleryPoint(event)
      if (point === null) return
      event.preventDefault()
      drawGalleryCrop(point.x, point.y)
    })

    overlayBox.addEventListener('pointerup', (event) => {
      if (overlayBox.hasPointerCapture(event.pointerId)) overlayBox.releasePointerCapture(event.pointerId)
    })

    overlay.querySelector('[data-gallery-crop-confirm="1"]')?.addEventListener('click', () => {
      if (pendingCrop === null) { overlay.remove(); return }
      const crop = pendingCrop
      const canvas = document.createElement('canvas')
      canvas.width = 800
      canvas.height = 800
      const ctx = canvas.getContext('2d')
      if (!ctx) { overlay.remove(); return }
      const img = new Image()
      const objectUrl = URL.createObjectURL(file)
      img.onload = () => {
        ctx.drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, 800, 800)
        const dataUrl = canvas.toDataURL('image/webp', 0.92)
        URL.revokeObjectURL(objectUrl)
        const item = { file, crop, dataUrl }
        pendingGalleryItems.push(item)
        if (galleryGrid) {
          const div = document.createElement('div')
          div.style.cssText = 'position:relative;aspect-ratio:1/1;border-radius:8px;overflow:hidden;border:1px solid rgba(212,165,32,0.30);background:#101010;'
          const previewImg = document.createElement('img')
          previewImg.src = dataUrl
          previewImg.alt = ''
          previewImg.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;'
          const removeBtn = document.createElement('button')
          removeBtn.type = 'button'
          removeBtn.style.cssText = 'position:absolute;top:4px;right:4px;width:26px;height:26px;border:1px solid rgba(248,113,113,0.56);border-radius:999px;background:rgba(12,12,12,0.86);color:#fecaca;font-size:16px;font-weight:900;line-height:1;cursor:pointer;'
          removeBtn.textContent = '×'
          removeBtn.addEventListener('click', () => {
            const idx = pendingGalleryItems.indexOf(item)
            if (idx !== -1) pendingGalleryItems.splice(idx, 1)
            div.remove()
            addGalleryEmptySlot()
          })
          div.appendChild(previewImg)
          div.appendChild(removeBtn)
          const firstSlot = galleryGrid.querySelector<HTMLElement>('[data-gallery-add-slot]')
          if (firstSlot) {
            galleryGrid.insertBefore(div, firstSlot)
            firstSlot.remove()
          } else {
            galleryGrid.appendChild(div)
          }
        }
        overlay.remove()
      }
      img.src = objectUrl
    })

    overlay.querySelector('[data-gallery-crop-cancel="1"]')?.addEventListener('click', () => {
      overlay.remove()
    })
  }

  root.querySelectorAll<HTMLElement>('[data-gallery-add-slot]').forEach((slot) => {
    slot.addEventListener('click', () => galleryFileInput?.click())
  })

  galleryFileInput?.addEventListener('change', () => {
    const file = galleryFileInput?.files?.[0] ?? null
    if (!file) return
    if (galleryFileInput) galleryFileInput.value = ''
    if (file.size > 10_000_000) {
      options.onProfileEditorFileError('Снимката трябва да е до 10 МБ.')
      return
    }
    openGalleryCropOverlay(file)
  })

  function dataUrlToFile(dataUrl: string, filename: string): File {
    const parts = dataUrl.split(',')
    const mime = parts[0].match(/:(.*?);/)![1]
    const binaryStr = atob(parts[1])
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
    return new File([bytes], filename, { type: mime })
  }

  root
    .querySelector<HTMLFormElement>('[data-lobby-profile-editor-form="1"]')
    ?.addEventListener('submit', (event) => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      const data = new FormData(form)
      const avatarFile = data.get('avatarFile')
      const galleryFiles = pendingGalleryItems.map((item, i) => dataUrlToFile(item.dataUrl, `gallery-${i}.webp`))
      options.onProfileEditSubmit(
        avatarFile instanceof File && avatarFile.size > 0 ? avatarFile : null,
        currentCrop,
        galleryFiles,
      )
    })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-profile-name-change-submit="1"]')
    ?.addEventListener('click', () => {
      const input = root.querySelector<HTMLInputElement>('input[name="paidDisplayName"]')
      options.onProfileNameChangeSubmit(input?.value.trim() ?? '')
    })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-gallery-delete]').forEach((button) => {
    button.addEventListener('click', () => {
      const imageId = button.dataset.lobbyGalleryDelete?.trim() ?? ''

      if (imageId.length > 0) {
        options.onProfileGalleryDelete(imageId)
      }
    })
  })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-auth-modal-close="1"]')
    ?.addEventListener('click', options.onAuthModalClose)

  root
    .querySelector<HTMLElement>('[data-lobby-auth-modal-backdrop="1"]')
    ?.addEventListener('click', options.onAuthModalClose)

  root
    .querySelector<HTMLButtonElement>('[data-lobby-auth-register-button="1"]')
    ?.addEventListener('click', () => options.onAuthModeChange('register'))

  root
    .querySelector<HTMLButtonElement>('[data-lobby-auth-login-button="1"]')
    ?.addEventListener('click', () => options.onAuthModeChange('login'))

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-auth-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.lobbyAuthMode
      if (mode === 'login' || mode === 'register') {
        options.onAuthModeChange(mode)
      }
    })
  })

  root.querySelectorAll<HTMLFormElement>('[data-lobby-auth-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const data = new FormData(form)
      const email = String(data.get('email') ?? '')
      const password = String(data.get('password') ?? '')

      if (form.dataset.lobbyAuthForm === 'register') {
        options.onRegisterSubmit(String(data.get('displayName') ?? ''), email, password)
        return
      }

      options.onLoginSubmit(email, password)
    })
  })
}
