import { getCardSuit } from './cardUtils.js'
import { isSuitContract, isAllTrumpsContract, getCardPower } from './contractUtils.js'

export function getWinningTrickEntry(state, trickEntries = []) {
  if (!trickEntries.length) {
    return null
  }

  const leadSuit = getCardSuit(trickEntries[0].card)

  if (!leadSuit) {
    return trickEntries[0]
  }

  if (isSuitContract(state)) {
    const trumpEntries = trickEntries.filter((entry) => getCardSuit(entry.card) === state.trumpSuit)

    if (trumpEntries.length > 0) {
      return trumpEntries.reduce((best, current) => {
        const currentPower = getCardPower(state, current.card, { treatAsTrump: true })
        const bestPower = getCardPower(state, best.card, { treatAsTrump: true })

        return currentPower > bestPower ? current : best
      })
    }

    const leadSuitEntries = trickEntries.filter((entry) => getCardSuit(entry.card) === leadSuit)

    return leadSuitEntries.reduce((best, current) => {
      const currentPower = getCardPower(state, current.card, { treatAsTrump: false })
      const bestPower = getCardPower(state, best.card, { treatAsTrump: false })

      return currentPower > bestPower ? current : best
    })
  }

  if (isAllTrumpsContract(state)) {
    const leadSuitEntries = trickEntries.filter((entry) => getCardSuit(entry.card) === leadSuit)

    return leadSuitEntries.reduce((best, current) => {
      const currentPower = getCardPower(state, current.card, { treatAsTrump: true })
      const bestPower = getCardPower(state, best.card, { treatAsTrump: true })

      return currentPower > bestPower ? current : best
    })
  }

  const leadSuitEntries = trickEntries.filter((entry) => getCardSuit(entry.card) === leadSuit)

  return leadSuitEntries.reduce((best, current) => {
    const currentPower = getCardPower(state, current.card, { treatAsTrump: false })
    const bestPower = getCardPower(state, best.card, { treatAsTrump: false })

    return currentPower > bestPower ? current : best
  })
}