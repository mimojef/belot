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

export function dealSecondRound(deck, hands, dealerId = 'bottom') {
  const workingDeck = [...deck]

  const updatedHands = {
    bottom: [...(hands.bottom ?? [])],
    right: [...(hands.right ?? [])],
    top: [...(hands.top ?? [])],
    left: [...(hands.left ?? [])],
  }

  const dealOrder = getDealOrder(dealerId)

  for (const playerPosition of dealOrder) {
    updatedHands[playerPosition].push(...workingDeck.splice(0, 3))
  }

  return {
    hands: updatedHands,
    remainingDeck: workingDeck,
  }
}