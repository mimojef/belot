import type {
  PlayerPublicProfileSnapshot,
  RoomSeatSnapshot,
  Seat,
} from '../network/createGameServerClient'
import { renderPlayerProfilePopup } from '../../ui/overlays/renderPlayerProfilePopup'

const HOST_ID = 'active-room-profile-overlay-host'

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
  onClose: () => void,
): void {
  host.innerHTML = renderPlayerProfilePopup({
    isOpen: true,
    seat,
    profile,
    isLoading,
    canEdit: false,
    friendshipAction: null,
    skipAnimation: !isLoading,
  })
  attachListeners(host, onClose)
}

export function showSeatProfileOverlay(
  seatSnapshot: RoomSeatSnapshot,
  onClose: () => void,
): void {
  removeSeatProfileOverlay()

  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'position:fixed;inset:0;z-index:99998;'

  renderIntoHost(host, seatSnapshot.seat, null, true, onClose)
  document.body.appendChild(host)
}

export function updateSeatProfileOverlay(
  seatSnapshot: RoomSeatSnapshot,
  profile: PlayerPublicProfileSnapshot | null,
): void {
  const host = getHost()
  if (!host) return

  const onClose = (): void => removeSeatProfileOverlay()
  renderIntoHost(host, seatSnapshot.seat, profile, false, onClose)
}

export function removeSeatProfileOverlay(): void {
  document.getElementById(HOST_ID)?.remove()
}
