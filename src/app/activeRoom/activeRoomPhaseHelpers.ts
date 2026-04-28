import type { RoomGameSnapshot } from '../network/createGameServerClient'

export function getCuttingCycleKey(roomId: string, game: RoomGameSnapshot | null): string | null {
  const cuttingSnapshot = game?.cutting ?? null
  const cutterSeat = cuttingSnapshot?.cutterSeat ?? null
  const dealerSeat = game?.dealerSeat ?? null
  const timerDeadlineAt = game?.timerDeadlineAt ?? 'no-timer'

  if (!cuttingSnapshot || !cutterSeat) {
    return null
  }

  return `${roomId}:${dealerSeat ?? 'no-dealer'}:${cutterSeat}:${timerDeadlineAt}`
}

export function getDealFirstThreePhaseKey(
  roomId: string,
  game: RoomGameSnapshot | null,
): string | null {
  if (!game) {
    return null
  }

  const isLiveFirstDealPhase = game.authoritativePhase === 'deal-first-3'
  const isAlreadyPastFirstDeal =
    game.authoritativePhase === 'deal-next-2' ||
    game.authoritativePhase === 'bidding' ||
    game.authoritativePhase === 'deal-last-3' ||
    game.authoritativePhase === 'playing' ||
    game.authoritativePhase === 'scoring'

  if (!isLiveFirstDealPhase && !(isAlreadyPastFirstDeal && hasVisibleFirstThreeHands(game))) {
    return null
  }

  const dealerSeat = game.dealerSeat ?? null

  return `${roomId}:deal-first-3:${dealerSeat ?? 'no-dealer'}`
}

export function hasVisibleFirstThreeHands(game: RoomGameSnapshot | null): boolean {
  if (!game) {
    return false
  }

  return (
    game.handCounts.bottom >= 3 &&
    game.handCounts.right >= 3 &&
    game.handCounts.top >= 3 &&
    game.handCounts.left >= 3
  )
}

export function shouldKeepFirstThreeHandsVisible(game: RoomGameSnapshot | null): boolean {
  return hasVisibleFirstThreeHands(game)
}

export function getDealNextTwoPhaseKey(
  roomId: string,
  game: RoomGameSnapshot | null,
): string | null {
  if (!game) {
    return null
  }

  const isLiveNextTwoPhase = game.authoritativePhase === 'deal-next-2'
  const isAlreadyPastNextTwo =
    game.authoritativePhase === 'bidding' ||
    game.authoritativePhase === 'deal-last-3' ||
    game.authoritativePhase === 'playing' ||
    game.authoritativePhase === 'scoring'

  if (!isLiveNextTwoPhase && !(isAlreadyPastNextTwo && hasVisibleNextTwoHands(game))) {
    return null
  }

  const dealerSeat = game.dealerSeat ?? null

  return `${roomId}:deal-next-2:${dealerSeat ?? 'no-dealer'}`
}

export function hasVisibleNextTwoHands(game: RoomGameSnapshot | null): boolean {
  if (!game) {
    return false
  }

  return (
    game.handCounts.bottom >= 5 &&
    game.handCounts.right >= 5 &&
    game.handCounts.top >= 5 &&
    game.handCounts.left >= 5
  )
}

export function shouldKeepNextTwoHandsVisible(game: RoomGameSnapshot | null): boolean {
  return hasVisibleNextTwoHands(game)
}

export function getDealLastThreePhaseKey(
  roomId: string,
  game: RoomGameSnapshot | null,
): string | null {
  if (!game) {
    return null
  }

  const isLiveLastThreePhase = game.authoritativePhase === 'deal-last-3'
  const isAlreadyPastLastThree =
    game.authoritativePhase === 'playing' ||
    game.authoritativePhase === 'scoring'

  if (!isLiveLastThreePhase && !(isAlreadyPastLastThree && hasVisibleLastThreeHands(game))) {
    return null
  }

  const dealerSeat = game.dealerSeat ?? null

  return `${roomId}:deal-last-3:${dealerSeat ?? 'no-dealer'}`
}

export function hasVisibleLastThreeHands(game: RoomGameSnapshot | null): boolean {
  if (!game) {
    return false
  }

  return (
    game.handCounts.bottom >= 8 &&
    game.handCounts.right >= 8 &&
    game.handCounts.top >= 8 &&
    game.handCounts.left >= 8
  )
}

export function shouldKeepLastThreeHandsVisible(game: RoomGameSnapshot | null): boolean {
  return hasVisibleLastThreeHands(game)
}
