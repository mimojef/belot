export function createBiddingFlow({ game, renderGame }) {
  let biddingBotActionTimeoutId = null
  let biddingTurnTimeoutId = null
  let biddingDomUpdateIntervalId = null

  let currentBiddingTurnKey = null
  let currentBiddingTurnStartedAt = null
  let currentBiddingTurnExpiresAt = null

  const BOT_BID_DELAY_MS = 2000
  const BIDDING_TURN_LIMIT_MS = 15000
  const BIDDING_DOM_UPDATE_STEP_MS = 100

  function clearBiddingBotActionTimeout() {
    if (biddingBotActionTimeoutId) {
      clearTimeout(biddingBotActionTimeoutId)
      biddingBotActionTimeoutId = null
    }
  }

  function clearBiddingTurnTimeout() {
    if (biddingTurnTimeoutId) {
      clearTimeout(biddingTurnTimeoutId)
      biddingTurnTimeoutId = null
    }
  }

  function clearBiddingDomUpdateInterval() {
    if (biddingDomUpdateIntervalId) {
      clearInterval(biddingDomUpdateIntervalId)
      biddingDomUpdateIntervalId = null
    }
  }

  function clearBiddingTimers() {
    clearBiddingBotActionTimeout()
    clearBiddingTurnTimeout()
    clearBiddingDomUpdateInterval()
    currentBiddingTurnKey = null
    currentBiddingTurnStartedAt = null
    currentBiddingTurnExpiresAt = null
  }

  function getActiveBiddingPlayerId(state) {
    return (
      state?.ui?.bidding?.activePlayerId ??
      state?.bidding?.currentPlayerId ??
      state?.bidding?.currentPlayer ??
      state?.bidding?.activePlayerId ??
      state?.bidding?.activePlayer ??
      state?.bidding?.currentTurn ??
      state?.currentPlayerId ??
      state?.currentTurn ??
      null
    )
  }

  function getBiddingHistoryLength(state) {
    return state?.bidding?.history?.length ?? state?.biddingHistory?.length ?? 0
  }

  function getLastBidIdentity(state) {
    const history = state?.bidding?.history ?? state?.biddingHistory ?? []

    if (!Array.isArray(history) || history.length === 0) {
      return 'none'
    }

    const lastBid = history[history.length - 1]

    return JSON.stringify({
      playerId: lastBid?.playerId ?? null,
      type: lastBid?.type ?? null,
      suit: lastBid?.suit ?? null,
      contract: lastBid?.contract ?? null,
      value: lastBid?.value ?? null,
    })
  }

  function getBiddingTurnKey(state) {
    const activePlayerId = getActiveBiddingPlayerId(state)

    return JSON.stringify({
      phase: state?.phase ?? null,
      activePlayerId,
      historyLength: getBiddingHistoryLength(state),
      lastBid: getLastBidIdentity(state),
      biddingComplete: state?.bidding?.isComplete ?? state?.biddingComplete ?? false,
    })
  }

  function getBiddingMsLeft() {
    if (!currentBiddingTurnExpiresAt) {
      return BIDDING_TURN_LIMIT_MS
    }

    return Math.max(0, currentBiddingTurnExpiresAt - Date.now())
  }

  function isHumanBiddingTurn(state) {
    return getActiveBiddingPlayerId(state) === 'bottom'
  }

  function isBotBiddingTurn(state) {
    const activePlayerId = getActiveBiddingPlayerId(state)
    return Boolean(activePlayerId) && activePlayerId !== 'bottom'
  }

  function formatTimerText(secondsLeft) {
    return `${Math.max(0, Number(secondsLeft ?? 0))} сек`
  }

  function getExactTimerSelectors(playerId) {
    if (!playerId) {
      return {
        progress: [],
        text: [],
        activeStrip: [],
      }
    }

    if (playerId === 'bottom') {
      return {
        progress: [`[data-bidding-progress-bar="${playerId}"]`],
        text: [`[data-bidding-timer-text="${playerId}"]`],
        activeStrip: [`[data-bidding-active-strip="${playerId}"]`],
      }
    }

    return {
      progress: [`[data-bidding-progress-fill="${playerId}"]`],
      text: [`[data-bidding-timer-text="${playerId}"]`],
      activeStrip: [`[data-bidding-active-bar="${playerId}"]`],
    }
  }

  function getFallbackTimerSelectors(playerId) {
    if (!playerId || playerId === 'bottom') {
      return {
        progress: [],
        text: [],
        activeStrip: [],
      }
    }

    return {
      progress: ['[data-bidding-progress-fill=""]'],
      text: ['[data-bidding-timer-text=""]'],
      activeStrip: ['[data-bidding-active-bar=""]'],
    }
  }

  function queryTimerElements(selectors) {
    const progressElements = []
    const textElements = []
    const activeStripElements = []

    selectors.progress.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        progressElements.push(element)
      })
    })

    selectors.text.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        textElements.push(element)
      })
    })

    selectors.activeStrip.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        activeStripElements.push(element)
      })
    })

    return {
      progressElements,
      textElements,
      activeStripElements,
    }
  }

  function getLiveTimerElements(playerId) {
    const exactSelectors = getExactTimerSelectors(playerId)
    const exactElements = queryTimerElements(exactSelectors)

    const hasExactElements =
      exactElements.progressElements.length > 0 ||
      exactElements.textElements.length > 0 ||
      exactElements.activeStripElements.length > 0

    if (hasExactElements) {
      return exactElements
    }

    const fallbackSelectors = getFallbackTimerSelectors(playerId)
    return queryTimerElements(fallbackSelectors)
  }

  function updateBiddingTimerDom() {
    const state = game.getState()

    if (state.phase !== 'bidding') {
      return
    }

    const activePlayerId = getActiveBiddingPlayerId(state)

    if (!activePlayerId) {
      return
    }

    const msLeft = getBiddingMsLeft()
    const secondsLeft = Math.max(0, Math.ceil(msLeft / 1000))
    const progressPercent = Math.max(0, Math.min(100, (msLeft / BIDDING_TURN_LIMIT_MS) * 100))

    const { progressElements, textElements, activeStripElements } =
      getLiveTimerElements(activePlayerId)

    progressElements.forEach((element) => {
      element.style.width = `${progressPercent}%`
      element.style.opacity = '1'
    })

    textElements.forEach((element) => {
      element.textContent = formatTimerText(secondsLeft)
      element.style.opacity = '1'
    })

    activeStripElements.forEach((element) => {
      element.style.opacity = '1'
    })
  }

  function startBiddingDomUpdates() {
    clearBiddingDomUpdateInterval()
    updateBiddingTimerDom()

    biddingDomUpdateIntervalId = setInterval(() => {
      const latestState = game.getState()

      if (latestState.phase !== 'bidding') {
        clearBiddingDomUpdateInterval()
        return
      }

      updateBiddingTimerDom()
    }, BIDDING_DOM_UPDATE_STEP_MS)
  }

  function autoResolveBiddingTurn() {
    const latestState = game.getState()

    if (latestState.phase !== 'bidding') {
      clearBiddingTimers()
      renderGame()
      return
    }

    game.passBid()
    renderGame()
  }

  function startBiddingTurnTimers(state) {
    clearBiddingBotActionTimeout()
    clearBiddingTurnTimeout()
    clearBiddingDomUpdateInterval()

    currentBiddingTurnStartedAt = Date.now()
    currentBiddingTurnExpiresAt = currentBiddingTurnStartedAt + BIDDING_TURN_LIMIT_MS

    biddingTurnTimeoutId = setTimeout(() => {
      biddingTurnTimeoutId = null
      autoResolveBiddingTurn()
    }, BIDDING_TURN_LIMIT_MS)

    if (isBotBiddingTurn(state)) {
      biddingBotActionTimeoutId = setTimeout(() => {
        biddingBotActionTimeoutId = null

        const latestState = game.getState()

        if (latestState.phase !== 'bidding') {
          return
        }

        const latestTurnKey = getBiddingTurnKey(latestState)

        if (latestTurnKey !== currentBiddingTurnKey) {
          return
        }

        autoResolveBiddingTurn()
      }, BOT_BID_DELAY_MS)
    }

    startBiddingDomUpdates()
  }

  function maybeRunBiddingFlow(state = game.getState()) {
    if (state.phase !== 'bidding') {
      clearBiddingTimers()
      return
    }

    const activePlayerId = getActiveBiddingPlayerId(state)

    if (!activePlayerId) {
      clearBiddingTimers()
      return
    }

    const nextTurnKey = getBiddingTurnKey(state)

    if (nextTurnKey === currentBiddingTurnKey) {
      return
    }

    currentBiddingTurnKey = nextTurnKey
    startBiddingTurnTimers(state)
  }

  function getUiState(state) {
    const activePlayerId = getActiveBiddingPlayerId(state)
    const msLeft = state.phase === 'bidding' ? getBiddingMsLeft() : null
    const secondsLeft = msLeft === null ? null : Math.max(0, Math.ceil(msLeft / 1000))
    const progressPercent =
      msLeft === null
        ? null
        : Math.max(0, Math.min(100, (msLeft / BIDDING_TURN_LIMIT_MS) * 100))

    return {
      activePlayerId,
      msLeft,
      secondsLeft,
      progressPercent,
      turnLimitMs: state.phase === 'bidding' ? BIDDING_TURN_LIMIT_MS : null,
      turnStartedAt: currentBiddingTurnStartedAt,
      turnExpiresAt: currentBiddingTurnExpiresAt,
      isBotTurn: state.phase === 'bidding' ? isBotBiddingTurn(state) : false,
      isHumanTurn: state.phase === 'bidding' ? isHumanBiddingTurn(state) : false,
    }
  }

  return {
    clearBiddingTimers,
    updateBiddingTimerDom,
    maybeRunBiddingFlow,
    getUiState,
  }
}