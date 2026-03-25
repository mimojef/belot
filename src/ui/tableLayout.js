const PLAYER_ORDER = ['bottom', 'left', 'top', 'right']

function formatContract(contract) {
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

function formatTrumpSuit(trumpSuit) {
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

function formatPlayerName(playerId) {
  if (playerId === 'bottom') {
    return 'Ти'
  }

  if (playerId === 'left') {
    return 'Играч 1'
  }

  if (playerId === 'top') {
    return 'Играч 2'
  }

  if (playerId === 'right') {
    return 'Играч 3'
  }

  return playerId ?? 'неизвестен играч'
}

function getPlayerIdByIndex(index) {
  const normalizedIndex =
    ((index % PLAYER_ORDER.length) + PLAYER_ORDER.length) % PLAYER_ORDER.length

  return PLAYER_ORDER[normalizedIndex]
}

function formatBidAction(action) {
  if (action === 'обява clubs') {
    return 'обява спатия'
  }

  if (action === 'обява diamonds') {
    return 'обява каро'
  }

  if (action === 'обява hearts') {
    return 'обява купа'
  }

  if (action === 'обява spades') {
    return 'обява пика'
  }

  return action ?? 'пас'
}

function renderHumanBiddingControls({
  phase,
  currentTurn,
  contract,
  isDoubled,
  isRedoubled,
}) {
  if (phase !== 'bidding' || currentTurn !== 'bottom') {
    return ''
  }

  const canDouble = !!contract && !isDoubled
  const canRedouble = !!contract && isDoubled && !isRedoubled

  return `
    <div class="bidding-actions">
      <div class="bidding-actions-title">Твоят ход</div>

      <div class="bidding-actions-row">
        <button class="bid-btn" onclick="passBidAndRender()">Пас</button>
        <button class="bid-btn" onclick="bidAllTrumpsAndRender()">Всичко коз</button>
        <button class="bid-btn" onclick="bidNoTrumpsAndRender()">Без коз</button>
      </div>

      <div class="bidding-actions-row">
        <button class="bid-btn" onclick="bidSuitAndRender('clubs')">Спатия</button>
        <button class="bid-btn" onclick="bidSuitAndRender('diamonds')">Каро</button>
        <button class="bid-btn" onclick="bidSuitAndRender('hearts')">Купа</button>
        <button class="bid-btn" onclick="bidSuitAndRender('spades')">Пика</button>
      </div>

      <div class="bidding-actions-row">
        ${
          canDouble
            ? '<button class="bid-btn bid-btn-warning" onclick="doubleBidAndRender()">Контра</button>'
            : ''
        }
        ${
          canRedouble
            ? '<button class="bid-btn bid-btn-danger" onclick="redoubleBidAndRender()">Ре контра</button>'
            : ''
        }
      </div>
    </div>
  `
}

function renderBiddingTurnInfo(phase, currentTurn) {
  if (phase !== 'bidding') {
    return ''
  }

  if (currentTurn === 'bottom') {
    return `
      <div class="bidding-current bidding-current-active">
        На ход си ти
      </div>
    `
  }

  return `
    <div class="bidding-current">
      На ход е ${formatPlayerName(currentTurn)}
    </div>
    <div class="bidding-current bidding-current-muted">
      Изчакване на хода на бот...
    </div>
  `
}

export function renderTableLayout(players, statusText, hands = {}, gameState = {}) {
  const topPlayer = players.find((player) => player.position === 'top')
  const leftPlayer = players.find((player) => player.position === 'left')
  const rightPlayer = players.find((player) => player.position === 'right')
  const bottomPlayer = players.find((player) => player.position === 'bottom')

  const topCount = hands.top?.length ?? 0
  const leftCount = hands.left?.length ?? 0
  const rightCount = hands.right?.length ?? 0
  const bottomCount = hands.bottom?.length ?? 0

  const phase = gameState.phase ?? null
  const bidding = gameState.bidding ?? {}
  const currentTurn = bidding.currentTurn ?? gameState.currentTurn ?? null
  const contract = bidding.contract ?? gameState.contract ?? null
  const trumpSuit = bidding.trumpSuit ?? gameState.trumpSuit ?? null
  const bidHistory = bidding.history ?? gameState.bidHistory ?? []
  const isDoubled = bidding.isDoubled ?? gameState.isDoubled ?? false
  const isRedoubled = bidding.isRedoubled ?? gameState.isRedoubled ?? false
  const dealerPlayer = formatPlayerName(getPlayerIdByIndex(gameState.dealerIndex ?? 0))
  const cuttingPlayer = formatPlayerName(gameState.cuttingPlayer)

  let centerSubtitle = 'Раздават се първите 3+2 карти'

  if (phase === 'bidding') {
    centerSubtitle = `Наддаване след първите 5 карти: на ход е ${formatPlayerName(currentTurn)}`
  }

  if (phase === 'playing' && gameState.secondRoundDealt) {
    centerSubtitle = `Наддаването приключи. Първи на ход е ${formatPlayerName(currentTurn)}`
  }

  if (contract && trumpSuit) {
    let contractText = `Договор: ${formatContract(contract)} | Коз: ${formatTrumpSuit(trumpSuit)}`

    if (isRedoubled) {
      contractText += ' | Ре контра'
    } else if (isDoubled) {
      contractText += ' | Контра'
    }

    centerSubtitle = contractText
  }

  const roundInfoHtml = `
    <div class="bidding-panel">
      <div class="bidding-title">Инфо за рунда</div>
      <div class="bidding-current">Раздава: ${dealerPlayer}</div>
      <div class="bidding-current">Цепи: ${cuttingPlayer}</div>
    </div>
  `

  const biddingStatusHtml =
    phase === 'bidding' || contract
      ? `
        <div class="bidding-current">
          ${
            isRedoubled
              ? 'Статус: Ре контра'
              : isDoubled
                ? 'Статус: Контра'
                : 'Статус: Без контра'
          }
        </div>
      `
      : ''

  const biddingControlsHtml = renderHumanBiddingControls({
    phase,
    currentTurn,
    contract,
    isDoubled,
    isRedoubled,
  })

  const biddingTurnInfoHtml = renderBiddingTurnInfo(phase, currentTurn)

  const biddingHistoryHtml =
    phase === 'bidding'
      ? `
        <div class="bidding-panel">
          <div class="bidding-title">Наддаване</div>
          ${biddingTurnInfoHtml}
          ${biddingStatusHtml}
          ${biddingControlsHtml}
          <div class="bidding-history">
            ${
              bidHistory.length > 0
                ? bidHistory
                    .map(
                      (entry) => `
                        <div class="bidding-history-row">
                          ${formatPlayerName(entry.player)}: ${formatBidAction(entry.action)}
                        </div>
                      `
                    )
                    .join('')
                : '<div class="bidding-history-row">Все още няма обяви</div>'
            }
          </div>
        </div>
      `
      : ''

  return `
    <div class="app">
      <header class="topbar">
        <h1>Белот</h1>
        <div class="subtitle">Многофайлова структура</div>
      </header>

      <main class="table-wrap">
        <section class="table">
          <div class="status-bar">${statusText ?? ''}</div>

          <div class="players">
            <div class="player player-top">
              <div>
                <div>${topPlayer?.name ?? ''}</div>
                <div class="player-cards">Карти: ${topCount}</div>
              </div>
            </div>

            <div class="player-row">
              <div class="player player-left">
                <div>
                  <div>${leftPlayer?.name ?? ''}</div>
                  <div class="player-cards">Карти: ${leftCount}</div>
                </div>
              </div>

              <div class="center-area">
                <div class="center-title">Маса</div>
                <div class="center-subtitle">
                  ${centerSubtitle}
                </div>
                ${roundInfoHtml}
                ${biddingHistoryHtml}
              </div>

              <div class="player player-right">
                <div>
                  <div>${rightPlayer?.name ?? ''}</div>
                  <div class="player-cards">Карти: ${rightCount}</div>
                </div>
              </div>
            </div>

            <div class="player player-bottom">
              <div>
                <div>${bottomPlayer?.name ?? ''} (ти)</div>
                <div class="player-cards">Карти: ${bottomCount}</div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  `
}