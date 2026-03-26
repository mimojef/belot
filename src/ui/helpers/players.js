export const PLAYER_ORDER = ['bottom', 'right', 'top', 'left']

export function getPlayerIdByIndex(index) {
  if (index === null || index === undefined) {
    return null
  }

  return PLAYER_ORDER[((index % PLAYER_ORDER.length) + PLAYER_ORDER.length) % PLAYER_ORDER.length]
}

export function getPlayerAvatar(player) {
  return player?.avatarUrl ?? player?.avatar ?? player?.photo ?? player?.image ?? ''
}

export function getPlayerDisplayName(player, fallback) {
  return player?.name ?? fallback
}

export function getPlayerInitial(name = '') {
  return String(name).trim().charAt(0).toUpperCase() || '?'
}
