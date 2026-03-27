export function getPlayerTeam(playerId) {
  if (playerId === 'bottom' || playerId === 'top') {
    return 'A'
  }

  if (playerId === 'left' || playerId === 'right') {
    return 'B'
  }

  return null
}