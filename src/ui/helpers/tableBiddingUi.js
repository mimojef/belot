export function getBidInfoForPlayer(gameState = {}, playerId) {
  const history = gameState?.bidding?.history ?? gameState?.bidHistory ?? []

  if (!Array.isArray(history) || history.length === 0) {
    return null
  }

  const lastEntry = [...history].reverse().find((entry) => entry?.playerId === playerId)

  if (!lastEntry) {
    return null
  }

  if (lastEntry.type === 'pass') {
    return { type: 'pass' }
  }

  if (lastEntry.type === 'double') {
    return { type: 'double' }
  }

  if (lastEntry.type === 'redouble') {
    return { type: 'redouble' }
  }

  if (lastEntry.type === 'all-trumps') {
    return { type: 'all-trumps' }
  }

  if (lastEntry.type === 'no-trumps') {
    return { type: 'no-trumps' }
  }

  if (lastEntry.type === 'suit') {
    return {
      type: 'suit',
      suit: lastEntry.suit ?? lastEntry.trumpSuit ?? null,
    }
  }

  if (lastEntry.contract === 'all-trumps') {
    return { type: 'all-trumps' }
  }

  if (lastEntry.contract === 'no-trumps') {
    return { type: 'no-trumps' }
  }

  if (lastEntry.contract === 'color' || lastEntry.suit || lastEntry.trumpSuit) {
    return {
      type: 'suit',
      suit: lastEntry.suit ?? lastEntry.trumpSuit ?? null,
    }
  }

  return lastEntry.label ? { label: lastEntry.label } : null
}

export function getActiveBiddingPlayerId(gameState = {}) {
  return (
    gameState?.ui?.bidding?.activePlayerId ??
    gameState?.bidding?.currentPlayerId ??
    gameState?.bidding?.currentPlayer ??
    gameState?.bidding?.activePlayerId ??
    gameState?.bidding?.activePlayer ??
    gameState?.bidding?.currentTurn ??
    gameState?.currentPlayerId ??
    gameState?.currentTurn ??
    null
  )
}

export function getBiddingTimeProgress(gameState = {}, playerId, isActive) {
  if (!isActive) {
    return 0
  }

  const phase = gameState?.phase ?? null

  if (phase !== 'bidding') {
    return 0
  }

  const uiMsLeft = gameState?.ui?.bidding?.msLeft ?? null
  const uiTurnLimitMs = gameState?.ui?.bidding?.turnLimitMs ?? null

  if (uiMsLeft !== null && uiTurnLimitMs) {
    const safeMsLeft = Math.max(0, Number(uiMsLeft))
    const safeLimit = Math.max(1, Number(uiTurnLimitMs))

    return (safeMsLeft / safeLimit) * 100
  }

  const turnStartedAt = gameState?.bidding?.turnStartedAt ?? gameState?.turnStartedAt ?? null
  const turnTimeLimitMs = gameState?.bidding?.turnTimeLimitMs ?? gameState?.turnTimeLimitMs ?? 15000

  if (!turnStartedAt || !turnTimeLimitMs) {
    return 100
  }

  const startedAtMs = new Date(turnStartedAt).getTime()

  if (Number.isNaN(startedAtMs)) {
    return 100
  }

  const elapsed = Date.now() - startedAtMs
  const remaining = Math.max(0, turnTimeLimitMs - elapsed)

  return (remaining / turnTimeLimitMs) * 100
}

export function getBiddingSecondsLeft(gameState = {}, playerId, isActive) {
  if (!isActive) {
    return 0
  }

  const phase = gameState?.phase ?? null

  if (phase !== 'bidding') {
    return 0
  }

  const uiSecondsLeft = gameState?.ui?.bidding?.secondsLeft ?? null

  if (uiSecondsLeft !== null && uiSecondsLeft !== undefined) {
    return Math.max(0, Number(uiSecondsLeft))
  }

  const turnStartedAt = gameState?.bidding?.turnStartedAt ?? gameState?.turnStartedAt ?? null
  const turnTimeLimitMs = gameState?.bidding?.turnTimeLimitMs ?? gameState?.turnTimeLimitMs ?? 15000

  if (!turnStartedAt || !turnTimeLimitMs) {
    return Math.ceil(turnTimeLimitMs / 1000)
  }

  const startedAtMs = new Date(turnStartedAt).getTime()

  if (Number.isNaN(startedAtMs)) {
    return Math.ceil(turnTimeLimitMs / 1000)
  }

  const elapsed = Date.now() - startedAtMs
  const remaining = Math.max(0, turnTimeLimitMs - elapsed)

  return Math.ceil(remaining / 1000)
}