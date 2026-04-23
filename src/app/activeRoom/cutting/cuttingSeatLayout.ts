import type { RoomSeatSnapshot, Seat } from '../../network/createGameServerClient'

export const SEAT_ORDER: readonly Seat[] = ['bottom', 'right', 'top', 'left']

export const CUTTING_VISUAL_SEAT_LABELS: Record<Seat, string> = {
  bottom: 'ТИ',
  right: 'ДЯСНО',
  top: 'ГОРЕ',
  left: 'ЛЯВО',
}

export const CUTTING_VISUAL_SEAT_INITIALS: Record<Seat, string> = {
  bottom: 'Т',
  right: 'Д',
  top: 'Г',
  left: 'Л',
}

export function createEmptySeatSnapshot(seat: Seat): RoomSeatSnapshot {
  return {
    seat,
    displayName: '',
    isOccupied: false,
    isBot: false,
    isConnected: false,
    avatarUrl: null,
    level: null,
    rankTitle: null,
    skillRating: null,
  }
}

export function getVisualSeatForLocalPerspective(
  actualSeat: Seat,
  localSeat: Seat,
): Seat {
  const actualIndex = SEAT_ORDER.indexOf(actualSeat)
  const localIndex = SEAT_ORDER.indexOf(localSeat)

  if (actualIndex === -1 || localIndex === -1) {
    return actualSeat
  }

  return SEAT_ORDER[(actualIndex - localIndex + SEAT_ORDER.length) % SEAT_ORDER.length]
}

export function getCuttingSeatPanelAnchorStyle(
  visualSeat: Seat,
  panelScale: number,
): string {
  if (visualSeat === 'top') {
    return `
      left:50%;
      top:5px;
      transform:translateX(-50%) scale(${panelScale});
      transform-origin:top center;
    `
  }

  if (visualSeat === 'bottom') {
    return `
      left:50%;
      bottom:5px;
      transform:translateX(-50%) scale(${panelScale});
      transform-origin:bottom center;
    `
  }

  if (visualSeat === 'left') {
    return `
      left:5px;
      top:50%;
      transform:translateY(-50%) scale(${panelScale});
      transform-origin:left center;
    `
  }

  return `
    right:5px;
    top:50%;
    transform:translateY(-50%) scale(${panelScale});
    transform-origin:right center;
  `
}
