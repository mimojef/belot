import { PLAYER_ORDER } from './constants.js'

export function isBotPlayer(playerId) {
  return playerId !== 'bottom'
}

export function normalizePlayerIndex(index) {
  return ((index % PLAYER_ORDER.length) + PLAYER_ORDER.length) % PLAYER_ORDER.length
}

export function getRandomPlayerIndex() {
  return Math.floor(Math.random() * PLAYER_ORDER.length)
}

export function getPlayerIdByIndex(index) {
  return PLAYER_ORDER[normalizePlayerIndex(index)]
}

export function getPlayerIndexById(playerId) {
  return PLAYER_ORDER.indexOf(playerId)
}

export function getNextPlayerId(playerId) {
  const currentIndex = PLAYER_ORDER.indexOf(playerId)

  if (currentIndex === -1) {
    return PLAYER_ORDER[0]
  }

  return PLAYER_ORDER[normalizePlayerIndex(currentIndex + 1)]
}

export function getPreviousPlayerId(playerId) {
  const currentIndex = PLAYER_ORDER.indexOf(playerId)

  if (currentIndex === -1) {
    return PLAYER_ORDER[PLAYER_ORDER.length - 1]
  }

  return PLAYER_ORDER[normalizePlayerIndex(currentIndex - 1)]
}

export function getNextPlayerIndex(index) {
  return normalizePlayerIndex(index + 1)
}

export function getTeamByPlayerId(playerId) {
  return playerId === 'bottom' || playerId === 'top' ? 'teamA' : 'teamB'
}

export function getRoundWinnerTeam(trickWins) {
  if (trickWins.teamA > trickWins.teamB) {
    return 'teamA'
  }

  if (trickWins.teamB > trickWins.teamA) {
    return 'teamB'
  }

  return 'draw'
}

export function formatPlayerLabel(playerId) {
  if (playerId === 'bottom') return 'Ти'
  if (playerId === 'right') return 'Десен играч'
  if (playerId === 'top') return 'Горен играч'
  if (playerId === 'left') return 'Ляв играч'
  return playerId ?? 'неизвестен играч'
}