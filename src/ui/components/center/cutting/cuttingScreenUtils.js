export function escapeHtmlAttribute(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function getSeatOrderAfterDealerCounterClockwise(dealerPosition) {
  const order = ['bottom', 'right', 'top', 'left']
  const dealerIndex = order.indexOf(dealerPosition)

  if (dealerIndex === -1) {
    return ['right', 'top', 'left', 'bottom']
  }

  return [
    order[(dealerIndex + 1) % 4],
    order[(dealerIndex + 2) % 4],
    order[(dealerIndex + 3) % 4],
    order[(dealerIndex + 4) % 4],
  ]
}

export function resolveDealerPosition(gameState = {}) {
  if (typeof gameState.dealerPosition === 'string') {
    return gameState.dealerPosition
  }

  if (typeof gameState.dealer === 'string') {
    return gameState.dealer
  }

  if (typeof gameState.dealerIndex === 'number') {
    const positionsByIndex = ['bottom', 'right', 'top', 'left']
    return positionsByIndex[gameState.dealerIndex] ?? 'bottom'
  }

  return 'bottom'
}

export function resolveAutoCutIndex(gameState = {}) {
  const candidates = [
    gameState.selectedCutIndex,
    gameState.cutIndex,
    gameState.pendingCutIndex,
    gameState.ui?.cutting?.selectedCutIndex,
    gameState.ui?.cutting?.cutIndex,
    gameState.ui?.cutting?.pendingCutIndex,
  ]

  for (const value of candidates) {
    if (Number.isInteger(value) && value >= 0 && value <= 31) {
      return value
    }
  }

  return 16
}

export function buildHoverEnterHandler(isEnabled, x, baseY, rotate) {
  if (!isEnabled) {
    return ''
  }

  return `
    this.style.transform='translateX(${x}px) translateY(calc(-50% + ${baseY - 16}px)) rotate(${rotate}deg)';
    this.style.filter='drop-shadow(0 18px 28px rgba(0,0,0,0.22))';
  `
}

export function buildHoverLeaveHandler(x, y, rotate, filterValue) {
  return `
    this.style.transform='translateX(${x}px) translateY(calc(-50% + ${y}px)) rotate(${rotate}deg)';
    this.style.filter='${filterValue}';
  `
}