export function dealFirstRound(deck) {
  const workingDeck = [...deck]

  const hands = {
    bottom: [],
    left: [],
    top: [],
    right: [],
  }

  const dealOrder = ['left', 'top', 'right', 'bottom']

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