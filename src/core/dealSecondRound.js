export function dealSecondRound(deck, hands) {
  const workingDeck = [...deck]

  const updatedHands = {
    bottom: [...(hands.bottom ?? [])],
    left: [...(hands.left ?? [])],
    top: [...(hands.top ?? [])],
    right: [...(hands.right ?? [])],
  }

  const dealOrder = ['left', 'top', 'right', 'bottom']

  for (const playerPosition of dealOrder) {
    updatedHands[playerPosition].push(...workingDeck.splice(0, 3))
  }

  return {
    hands: updatedHands,
    remainingDeck: workingDeck,
  }
}