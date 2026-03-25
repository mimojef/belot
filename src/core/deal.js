const PLAYER_ORDER = ['bottom', 'right', 'top', 'left']

function normalizePlayerIndex(index) {
  return ((index % PLAYER_ORDER.length) + PLAYER_ORDER.length) % PLAYER_ORDER.length
}

function getPlayerIndex(playerId) {
  const index = PLAYER_ORDER.indexOf(playerId)
  return index === -1 ? 0 : index
}

function getDealOrder(dealerId) {
  const dealerIndex = getPlayerIndex(dealerId)

  return Array.from({ length: PLAYER_ORDER.length }, (_, offset) => {
    return PLAYER_ORDER[normalizePlayerIndex(dealerIndex + 1 + offset)]
  })
}

export function dealFirstRound(deck, dealerId = 'bottom') {
  const workingDeck = [...deck]

  const hands = {
    bottom: [],
    right: [],
    top: [],
    left: [],
  }

  const dealOrder = getDealOrder(dealerId)

  for (const playerPosition of dealOrder) {
    hands[playerPosition].push(...workingDeck.splice(0, 3))
  }

  for (const playerPosition of dealOrder) {
    hands[playerPosition].push(...workingDeck.splice(0, 2))
  }

  return {
    hands,
    remainingDeck: workingDeck,
  }
}