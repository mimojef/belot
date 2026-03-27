export function createCuttingFlow({ game, renderGame }) {
  let botCutSelectTimeoutId = null
  let botCutConfirmTimeoutId = null
  let cuttingTurnTimeoutId = null
  let cuttingDomUpdateIntervalId = null

  let currentCuttingTurnKey = null
  let currentCuttingTurnStartedAt = null
  let currentCuttingTurnExpiresAt = null

  const BOT_CUT_SELECT_DELAY_MS = 2000
  const BOT_CUT_CONFIRM_DELAY_MS = 500
  const CUTTING_TURN_LIMIT_MS = 15000
  const CUTTING_DOM_UPDATE_STEP_MS = 100

  function clearBotCutTimeout() {
    if (botCutSelectTimeoutId) {
      clearTimeout(botCutSelectTimeoutId)
      botCutSelectTimeoutId = null
    }

    if (botCutConfirmTimeoutId) {
      clearTimeout(botCutConfirmTimeoutId)
      botCutConfirmTimeoutId = null
    }
  }

  function clearCuttingTurnTimeout() {
    if (cuttingTurnTimeoutId) {
      clearTimeout(cuttingTurnTimeoutId)
      cuttingTurnTimeoutId = null
    }
  }

  function clearCuttingDomUpdateInterval() {
    if (cuttingDomUpdateIntervalId) {
      clearInterval(cuttingDomUpdateIntervalId)
      cuttingDomUpdateIntervalId = null
    }
  }

  function clearCuttingTimers() {
    clearBotCutTimeout()
    clearCuttingTurnTimeout()
    clearCuttingDomUpdateInterval()
    currentCuttingTurnKey = null
    currentCuttingTurnStartedAt = null
    currentCuttingTurnExpiresAt = null
  }

  function getRandomBotCutIndex() {
    const deckLength = game.getState().deck?.length ?? 32

    if (deckLength <= 1) {
      return 0
    }

    const minCut = 1
    const maxCut = deckLength - 1

    return Math.floor(Math.random() * (maxCut - minCut + 1)) + minCut
  }

  function getActiveCuttingPlayerId(state) {
    return state?.cuttingPlayer ?? state?.ui?.cutting?.activePlayerId ?? null
  }

  function getCuttingTurnKey(state) {
    return JSON.stringify({
      phase: state?.phase ?? null,
      awaitingCut: Boolean(state?.awaitingCut),
      cuttingPlayer: getActiveCuttingPlayerId(state),
      dealerIndex: state?.dealerIndex ?? null,
      round: state?.roundNumber ?? state?.round ?? null,
    })
  }

  function getCuttingMsLeft() {
    if (!currentCuttingTurnExpiresAt) {
      return CUTTING_TURN_LIMIT_MS
    }

    return Math.max(0, currentCuttingTurnExpiresAt - Date.now())
  }

  function isHumanCuttingTurn(state) {
    return (
      state?.phase === 'cutting' &&
      state?.awaitingCut &&
      getActiveCuttingPlayerId(state) === 'bottom'
    )
  }

  function isBotCuttingTurn(state) {
    const activePlayerId = getActiveCuttingPlayerId(state)

    return (
      state?.phase === 'cutting' &&
      state?.awaitingCut &&
      Boolean(activePlayerId) &&
      activePlayerId !== 'bottom'
    )
  }

  function formatTimerText(secondsLeft) {
    return `${Math.max(0, Number(secondsLeft ?? 0))} сек`
  }

  function updateCuttingTimerDom() {
    const state = game.getState()

    if (state.phase !== 'cutting' || !state.awaitingCut) {
      return
    }

    const msLeft = getCuttingMsLeft()
    const secondsLeft = Math.max(0, Math.ceil(msLeft / 1000))
    const progressPercent = Math.max(0, Math.min(100, (msLeft / CUTTING_TURN_LIMIT_MS) * 100))

    document.querySelectorAll('[data-cutting-timer-text]').forEach((element) => {
      element.textContent = formatTimerText(secondsLeft)
      element.style.opacity = '1'
    })

    document.querySelectorAll('[data-cutting-progress-bar]').forEach((element) => {
      element.style.width = `${progressPercent}%`
      element.style.opacity = '1'
    })
  }

  function startCuttingDomUpdates() {
    clearCuttingDomUpdateInterval()
    updateCuttingTimerDom()

    cuttingDomUpdateIntervalId = setInterval(() => {
      const latestState = game.getState()

      if (latestState.phase !== 'cutting' || !latestState.awaitingCut) {
        clearCuttingDomUpdateInterval()
        return
      }

      updateCuttingTimerDom()
    }, CUTTING_DOM_UPDATE_STEP_MS)
  }

  function autoResolveCuttingTurn() {
    const latestState = game.getState()

    if (latestState.phase !== 'cutting' || !latestState.awaitingCut) {
      clearCuttingTimers()
      renderGame()
      return
    }

    const cutIndex =
      latestState.selectedCutIndex !== null && latestState.selectedCutIndex !== undefined
        ? latestState.selectedCutIndex
        : getRandomBotCutIndex()

    if (isHumanCuttingTurn(latestState)) {
      clearCuttingDomUpdateInterval()
      renderGame()
      return
    }

    if (latestState.selectedCutIndex === null || latestState.selectedCutIndex === undefined) {
      game.selectCut(cutIndex)
    }

    game.confirmCut(cutIndex)
    renderGame()
  }

  function startCuttingTurnTimers() {
    clearBotCutTimeout()
    clearCuttingTurnTimeout()
    clearCuttingDomUpdateInterval()

    currentCuttingTurnStartedAt = Date.now()
    currentCuttingTurnExpiresAt = currentCuttingTurnStartedAt + CUTTING_TURN_LIMIT_MS

    cuttingTurnTimeoutId = setTimeout(() => {
      cuttingTurnTimeoutId = null
      autoResolveCuttingTurn()
    }, CUTTING_TURN_LIMIT_MS)

    startCuttingDomUpdates()
  }

  function maybeRunBotCutFlow(state = game.getState()) {
    if (state.phase !== 'cutting' || !state.awaitingCut) {
      clearBotCutTimeout()
      return
    }

    if (!isBotCuttingTurn(state)) {
      clearBotCutTimeout()
      return
    }

    if (state.selectedCutIndex !== null && state.selectedCutIndex !== undefined) {
      if (!botCutConfirmTimeoutId) {
        const scheduledTurnKey = currentCuttingTurnKey

        botCutConfirmTimeoutId = setTimeout(() => {
          botCutConfirmTimeoutId = null

          const latestState = game.getState()

          if (latestState.phase !== 'cutting' || !latestState.awaitingCut) {
            return
          }

          if (getCuttingTurnKey(latestState) !== scheduledTurnKey) {
            return
          }

          game.confirmCut(latestState.selectedCutIndex)
          renderGame()
        }, BOT_CUT_CONFIRM_DELAY_MS)
      }

      return
    }

    if (!botCutSelectTimeoutId) {
      const scheduledTurnKey = currentCuttingTurnKey

      botCutSelectTimeoutId = setTimeout(() => {
        botCutSelectTimeoutId = null

        const latestState = game.getState()

        if (latestState.phase !== 'cutting' || !latestState.awaitingCut) {
          return
        }

        if (getCuttingTurnKey(latestState) !== scheduledTurnKey) {
          return
        }

        const botCutIndex = getRandomBotCutIndex()
        game.selectCut(botCutIndex)
        renderGame()
      }, BOT_CUT_SELECT_DELAY_MS)
    }
  }

  function maybeRunCuttingFlow(state = game.getState()) {
    if (state.phase !== 'cutting' || !state.awaitingCut) {
      clearCuttingTimers()
      return
    }

    const nextTurnKey = getCuttingTurnKey(state)

    if (nextTurnKey === currentCuttingTurnKey) {
      return
    }

    currentCuttingTurnKey = nextTurnKey
    startCuttingTurnTimers()
  }

  function getUiState(state) {
    const activePlayerId =
      state.phase === 'cutting' && state.awaitingCut ? getActiveCuttingPlayerId(state) : null

    const msLeft =
      state.phase === 'cutting' && state.awaitingCut ? getCuttingMsLeft() : null

    const secondsLeft = msLeft === null ? null : Math.max(0, Math.ceil(msLeft / 1000))

    const progressPercent =
      msLeft === null
        ? null
        : Math.max(0, Math.min(100, (msLeft / CUTTING_TURN_LIMIT_MS) * 100))

    return {
      activePlayerId,
      msLeft,
      secondsLeft,
      progressPercent,
      turnLimitMs:
        state.phase === 'cutting' && state.awaitingCut ? CUTTING_TURN_LIMIT_MS : null,
      turnStartedAt: currentCuttingTurnStartedAt,
      turnExpiresAt: currentCuttingTurnExpiresAt,
      isBotTurn:
        state.phase === 'cutting' && state.awaitingCut ? isBotCuttingTurn(state) : false,
      isHumanTurn:
        state.phase === 'cutting' && state.awaitingCut ? isHumanCuttingTurn(state) : false,
    }
  }

  return {
    clearBotCutTimeout,
    clearCuttingTimers,
    updateCuttingTimerDom,
    maybeRunBotCutFlow,
    maybeRunCuttingFlow,
    getUiState,
  }
}