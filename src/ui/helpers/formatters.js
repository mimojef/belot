export function formatContract(contract) {
  if (contract === 'color') {
    return 'Цвят'
  }

  if (contract === 'all-trumps') {
    return 'Всичко коз'
  }

  if (contract === 'no-trumps') {
    return 'Без коз'
  }

  return contract ?? 'Няма'
}

export function formatTrumpSuit(trumpSuit) {
  if (trumpSuit === 'clubs') {
    return 'Спатия'
  }

  if (trumpSuit === 'diamonds') {
    return 'Каро'
  }

  if (trumpSuit === 'hearts') {
    return 'Купа'
  }

  if (trumpSuit === 'spades') {
    return 'Пика'
  }

  if (trumpSuit === 'all-trumps') {
    return 'Всичко коз'
  }

  if (trumpSuit === 'no-trumps') {
    return 'Без коз'
  }

  return trumpSuit ?? 'Няма'
}

export function formatAnnouncement(contract, trumpSuit) {
  if (!contract) {
    return 'Без обява'
  }

  if (contract === 'color') {
    return formatTrumpSuit(trumpSuit)
  }

  return formatContract(contract)
}

export function formatPlayerName(playerId) {
  if (playerId === 'bottom') {
    return 'Ти'
  }

  if (playerId === 'right') {
    return 'Десен играч'
  }

  if (playerId === 'top') {
    return 'Горен играч'
  }

  if (playerId === 'left') {
    return 'Ляв играч'
  }

  return playerId ?? 'неизвестен играч'
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
