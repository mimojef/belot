import type {
  PlayerPublicProfileSnapshot,
  RoomSeatSnapshot,
  Seat,
} from '../network/createGameServerClient'
import { renderPlayerProfilePopup } from '../../ui/overlays/renderPlayerProfilePopup'

const HOST_ID = 'active-room-profile-overlay-host'

let _overlayCanEdit = false
let _overlayOnEditClick: (() => void) | undefined

function getHost(): HTMLDivElement | null {
  return document.getElementById(HOST_ID) as HTMLDivElement | null
}

function attachListeners(host: HTMLDivElement, onClose: () => void): void {
  host
    .querySelector<HTMLButtonElement>('[data-player-profile-popup-close="1"]')
    ?.addEventListener('click', onClose)

  host
    .querySelector<HTMLElement>('[data-player-profile-popup-backdrop="1"]')
    ?.addEventListener('click', onClose)
}

function renderIntoHost(
  host: HTMLDivElement,
  seat: Seat,
  profile: PlayerPublicProfileSnapshot | null,
  isLoading: boolean,
  canEdit: boolean,
  onClose: () => void,
  onEditClick?: () => void,
): void {
  host.innerHTML = renderPlayerProfilePopup({
    isOpen: true,
    seat,
    profile,
    isLoading,
    canEdit,
    friendshipAction: null,
    skipAnimation: !isLoading,
  })
  attachListeners(host, onClose)
  if (canEdit && onEditClick) {
    host
      .querySelector<HTMLElement>('[data-player-profile-edit="1"]')
      ?.addEventListener('click', onEditClick)
  }
}

export function showSeatProfileOverlay(
  seatSnapshot: RoomSeatSnapshot,
  onClose: () => void,
  canEdit = false,
  onEditClick?: () => void,
): void {
  _overlayCanEdit = canEdit
  _overlayOnEditClick = onEditClick
  removeSeatProfileOverlay()

  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'position:fixed;inset:0;z-index:99998;'

  renderIntoHost(host, seatSnapshot.seat, null, true, canEdit, onClose, onEditClick)
  document.body.appendChild(host)
}

export function updateSeatProfileOverlay(
  seatSnapshot: RoomSeatSnapshot,
  profile: PlayerPublicProfileSnapshot | null,
): void {
  const host = getHost()
  if (!host) return

  const onClose = (): void => removeSeatProfileOverlay()
  renderIntoHost(host, seatSnapshot.seat, profile, false, _overlayCanEdit, onClose, _overlayOnEditClick)
}

export function removeSeatProfileOverlay(): void {
  _overlayCanEdit = false
  _overlayOnEditClick = undefined
  document.getElementById(HOST_ID)?.remove()
}
