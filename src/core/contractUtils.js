import { NORMAL_RANK_POWER, TRUMP_RANK_POWER } from './constants.js'
import { getCardRank, getCardSuit } from './cardUtils.js'

export function formatSuitLabel(suit) {
  if (suit === 'clubs') return 'Спатия'
  if (suit === 'diamonds') return 'Каро'
  if (suit === 'hearts') return 'Купа'
  if (suit === 'spades') return 'Пика'
  return suit ?? 'Няма'
}

export function formatContractLabel(contract) {
  if (contract === 'color') return 'Цвят'
  if (contract === 'all-trumps') return 'Всичко коз'
  if (contract === 'no-trumps') return 'Без коз'
  return contract ?? 'Няма'
}

export function isAllTrumpsContract(state) {
  const contract = String(state.contract ?? '').toLowerCase()
  const trumpSuit = String(state.trumpSuit ?? '').toLowerCase()

  return (
    contract === 'all-trumps' ||
    contract === 'all_trumps' ||
    contract === 'all trumps' ||
    contract === 'vsichko-koz' ||
    contract === 'vsichko koz' ||
    trumpSuit === 'all-trumps' ||
    trumpSuit === 'all_trumps' ||
    trumpSuit === 'all trumps'
  )
}

export function isNoTrumpsContract(state) {
  const contract = String(state.contract ?? '').toLowerCase()
  const trumpSuit = String(state.trumpSuit ?? '').toLowerCase()

  return (
    contract === 'no-trumps' ||
    contract === 'no_trumps' ||
    contract === 'no trumps' ||
    contract === 'bez-koz' ||
    contract === 'bez koz' ||
    trumpSuit === 'no-trumps' ||
    trumpSuit === 'no_trumps' ||
    trumpSuit === 'no trumps'
  )
}

export function isSuitContract(state) {
  return !isAllTrumpsContract(state) && !isNoTrumpsContract(state) && !!state.trumpSuit
}

export function getCardPower(state, card, { treatAsTrump = false } = {}) {
  const rank = getCardRank(card)

  if (!rank) {
    return -1
  }

  const powerMap = treatAsTrump ? TRUMP_RANK_POWER : NORMAL_RANK_POWER

  return powerMap[rank] ?? -1
}

export function canBeatCard(state, candidateCard, targetCard, contextSuit) {
  if (!candidateCard || !targetCard) {
    return false
  }

  if (getCardSuit(candidateCard) !== getCardSuit(targetCard)) {
    return false
  }

  const suit = getCardSuit(candidateCard)
  const treatAsTrump =
    isAllTrumpsContract(state) ||
    (isSuitContract(state) && suit === state.trumpSuit) ||
    (contextSuit && suit === contextSuit && contextSuit === state.trumpSuit)

  return (
    getCardPower(state, candidateCard, { treatAsTrump }) >
    getCardPower(state, targetCard, { treatAsTrump })
  )
}