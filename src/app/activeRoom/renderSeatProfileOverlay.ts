import type {
  PlayerPublicProfileSnapshot,
  RoomSeatSnapshot,
  Seat,
} from '../network/createGameServerClient'
import {
  renderPlayerProfilePopup,
  type PlayerProfileFriendshipAction,
} from '../../ui/overlays/renderPlayerProfilePopup'

const HOST_ID = 'active-room-profile-overlay-host'

let _overlayIsOwnProfile = false
let _currentProfile: PlayerPublicProfileSnapshot | null = null
let _currentSeat: Seat | null = null
let _actionMessage: string | null = null

let _getFriendshipAction: ((profileId: string) => PlayerProfileFriendshipAction | null) | null = null
let _onSendFriendRequest: ((profileId: string) => Promise<{ ok: true; newLabel: string } | { ok: false; message: string }>) | null = null
let _onLikeProfile: ((profileId: string) => Promise<{ ok: true; liked: boolean; likesCount: number } | { ok: false }>) | null = null
let _onBlockProfile: ((profileId: string) => Promise<{ message: string }>) | null = null

function getHost(): HTMLDivElement | null {
  return document.getElementById(HOST_ID) as HTMLDivElement | null
}

function buildFriendshipAction(profile: PlayerPublicProfileSnapshot | null, overrideLabel?: string): PlayerProfileFriendshipAction | null {
  if (_overlayIsOwnProfile || !profile?.profileId) return null
  if (overrideLabel) {
    return { profileId: profile.profileId, label: overrideLabel, disabled: true, message: _actionMessage }
  }
  const action = _getFriendshipAction?.(profile.profileId) ?? null
  if (action) action.message = _actionMessage
  return action
}

function rerender(onClose: () => void): void {
  const host = getHost()
  if (!host || _currentSeat === null) return
  const friendshipAction = buildFriendshipAction(_currentProfile)
  host.innerHTML = renderPlayerProfilePopup({
    isOpen: true,
    seat: _currentSeat,
    profile: _currentProfile,
    isLoading: false,
    canEdit: false,
    isOwnProfile: _overlayIsOwnProfile,
    friendshipAction,
    skipAnimation: true,
  })
  attachListeners(host, onClose)
}

function attachListeners(host: HTMLDivElement, onClose: () => void): void {
  host
    .querySelector<HTMLButtonElement>('[data-player-profile-popup-close="1"]')
    ?.addEventListener('click', onClose)

  host
    .querySelector<HTMLElement>('[data-player-profile-popup-backdrop="1"]')
    ?.addEventListener('click', onClose)

  host
    .querySelector<HTMLButtonElement>('[data-player-profile-friend-request]')
    ?.addEventListener('click', async (e) => {
      const profileId = (e.currentTarget as HTMLElement).getAttribute('data-player-profile-friend-request')
      if (!profileId || !_onSendFriendRequest) return
      const btn = e.currentTarget as HTMLButtonElement
      btn.disabled = true
      btn.textContent = 'Изпращане...'
      const result = await _onSendFriendRequest(profileId)
      _actionMessage = result.ok ? null : result.message
      rerender(onClose)
    })

  host
    .querySelector<HTMLButtonElement>('[data-player-profile-like]')
    ?.addEventListener('click', async (e) => {
      const profileId = (e.currentTarget as HTMLElement).getAttribute('data-player-profile-like')
      if (!profileId || !_onLikeProfile || !_currentProfile) return
      const result = await _onLikeProfile(profileId)
      if (result.ok) {
        _currentProfile = { ..._currentProfile, hasLikedByMe: result.liked, likesCount: result.likesCount }
      }
      rerender(onClose)
    })

  host
    .querySelector<HTMLButtonElement>('[data-player-profile-block]')
    ?.addEventListener('click', async (e) => {
      const profileId = (e.currentTarget as HTMLElement).getAttribute('data-player-profile-block')
      if (!profileId || !_onBlockProfile) return
      const btn = e.currentTarget as HTMLButtonElement
      btn.disabled = true
      const result = await _onBlockProfile(profileId)
      _actionMessage = result.message
      rerender(onClose)
    })
}

function renderIntoHost(
  host: HTMLDivElement,
  seat: Seat,
  profile: PlayerPublicProfileSnapshot | null,
  isLoading: boolean,
  isOwnProfile: boolean,
  onClose: () => void,
  emptyMessage?: string | null,
): void {
  _currentProfile = profile
  _currentSeat = seat
  const friendshipAction = buildFriendshipAction(profile)
  host.innerHTML = renderPlayerProfilePopup({
    isOpen: true,
    seat,
    profile,
    isLoading,
    canEdit: false,
    isOwnProfile,
    friendshipAction,
    skipAnimation: !isLoading,
    emptyMessage,
  })
  attachListeners(host, onClose)
}

export function showSeatProfileOverlay(
  seatSnapshot: RoomSeatSnapshot,
  onClose: () => void,
  isOwnProfile = false,
  getFriendshipAction?: ((profileId: string) => PlayerProfileFriendshipAction | null) | null,
  onSendFriendRequest?: ((profileId: string) => Promise<{ ok: true; newLabel: string } | { ok: false; message: string }>) | null,
  onLikeProfile?: ((profileId: string) => Promise<{ ok: true; liked: boolean; likesCount: number } | { ok: false }>) | null,
  onBlockProfile?: ((profileId: string) => Promise<{ message: string }>) | null,
): void {
  _getFriendshipAction = getFriendshipAction ?? null
  _onSendFriendRequest = onSendFriendRequest ?? null
  _onLikeProfile = onLikeProfile ?? null
  _onBlockProfile = onBlockProfile ?? null
  _actionMessage = null
  removeSeatProfileOverlay()
  _overlayIsOwnProfile = isOwnProfile

  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'position:fixed;inset:0;z-index:99998;'

  renderIntoHost(host, seatSnapshot.seat, null, true, isOwnProfile, onClose)
  document.body.appendChild(host)
}

export function updateSeatProfileOverlay(
  seatSnapshot: RoomSeatSnapshot,
  profile: PlayerPublicProfileSnapshot | null,
  emptyMessage?: string | null,
): void {
  const host = getHost()
  if (!host) return

  _actionMessage = null
  const onClose = (): void => removeSeatProfileOverlay()
  renderIntoHost(host, seatSnapshot.seat, profile, false, _overlayIsOwnProfile, onClose, emptyMessage)
}

export function removeSeatProfileOverlay(): void {
  _overlayIsOwnProfile = false
  _currentProfile = null
  _currentSeat = null
  _actionMessage = null
  document.getElementById(HOST_ID)?.remove()
}
