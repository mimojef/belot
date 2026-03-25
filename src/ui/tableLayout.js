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

function formatAnnouncement(contract, trumpSuit) {
  if (!contract) {
    return 'Без обява'
  }

  if (contract === 'color') {
    return formatTrumpSuit(trumpSuit)
  }

  return formatContract(contract)
}

function formatPlayerName(playerId) {
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

function getCardRank(card) {
  const rawRank = card?.rank ?? card?.value ?? card?.face ?? card?.name ?? ''

  return String(rawRank)
    .replace('JACK', 'J')
    .replace('QUEEN', 'Q')
    .replace('KING', 'K')
    .replace('ACE', 'A')
    .trim()
    .toUpperCase()
}

function getCardSuit(card) {
  return card?.suit ?? ''
}

function getCardId(card) {
  return card?.id ?? `${getCardSuit(card)}-${getCardRank(card)}`
}

function getSuitSymbol(suit) {
  if (suit === 'clubs') return '♣'
  if (suit === 'diamonds') return '♦'
  if (suit === 'hearts') return '♥'
  if (suit === 'spades') return '♠'
  return ''
}

function getSuitColor(suit) {
  if (suit === 'diamonds' || suit === 'hearts') {
    return '#dc2626'
  }

  return '#111827'
}

function getPlayerAvatar(player) {
  return player?.avatarUrl ?? player?.avatar ?? player?.photo ?? player?.image ?? ''
}

function getPlayerDisplayName(player, fallback) {
  return player?.name ?? fallback
}

function getPlayerInitial(name = '') {
  return String(name).trim().charAt(0).toUpperCase() || '?'
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderBiddingButton({
  label,
  icon = '',
  iconColor = '#111827',
  onclick = '',
  enabled = true,
  isAccent = false,
  isDanger = false,
  isPass = false,
}) {
  const background = enabled
    ? isPass
      ? '#f2a81d'
      : '#e8eff1'
    : 'rgba(90, 108, 129, 0.55)'

  const borderColor = enabled
    ? isPass
      ? '#f2a81d'
      : '#d8a02b'
    : 'rgba(255, 255, 255, 0.08)'

  const textColor = enabled
    ? isPass
      ? '#ffffff'
      : isDanger
        ? '#7f1d1d'
        : '#111827'
    : 'rgba(226, 232, 240, 0.45)'

  const iconFinalColor = enabled ? iconColor : 'rgba(226, 232, 240, 0.35)'

  const cursor = enabled ? 'pointer' : 'not-allowed'
  const opacity = enabled ? '1' : '0.68'
  const hoverClass = enabled ? 'bidding-board-btn-active' : ''
  const disabledAttr = enabled ? '' : 'disabled'
  const clickAttr = enabled && onclick ? `onclick="${onclick}"` : ''
  const minHeight = isPass ? '74px' : '78px'
  const fontSize = isPass ? 'clamp(30px, 3vw, 52px)' : 'clamp(12px, 1vw, 18px)'
  const fontWeight = isPass ? '800' : '700'
  const gap = isPass ? '0' : '4px'
  const accentShadow = enabled && (isAccent || isDanger) ? 'inset 0 0 0 1px rgba(255,255,255,0.18)' : 'none'

  return `
    <button
      type="button"
      class="${hoverClass}"
      ${clickAttr}
      ${disabledAttr}
      style="
        appearance: none;
        width: 100%;
        min-height: ${minHeight};
        border-radius: 10px;
        border: 2px solid ${borderColor};
        background: ${background};
        color: ${textColor};
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: ${gap};
        padding: ${isPass ? '8px 16px' : '10px 12px'};
        box-shadow: ${accentShadow};
        cursor: ${cursor};
        opacity: ${opacity};
        transition: transform 0.15s ease, filter 0.15s ease, box-shadow 0.15s ease;
      "
    >
      ${
        icon
          ? `
            <span
              style="
                font-size: ${isPass ? '0' : 'clamp(26px, 2vw, 42px)'};
                line-height: 1;
                font-weight: 800;
                color: ${iconFinalColor};
              "
            >
              ${icon}
            </span>
          `
          : ''
      }
      <span
        style="
          font-size: ${fontSize};
          line-height: 1.05;
          font-weight: ${fontWeight};
          letter-spacing: 0.01em;
          text-transform: uppercase;
          text-align: center;
        "
      >
        ${label}
      </span>
    </button>
  `
}

function renderHumanBiddingControls({
  phase,
  currentTurn,
  bidding,
}) {
  if (phase !== 'bidding' || currentTurn !== 'bottom') {
    return ''
  }

  const allowedSuits = bidding.allowedSuits ?? []
  const allowedContracts = bidding.allowedContracts ?? []
  const canDouble = bidding.canDouble ?? false
  const canRedouble = bidding.canRedouble ?? false

  return `
    <div class="bidding-actions" style="margin-top:0; padding-top:0; border-top:none;">
      <div
        style="
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        "
      >
        ${renderBiddingButton({
          label: 'Спатия',
          icon: '♣',
          iconColor: '#111827',
          onclick: "bidSuitAndRender('clubs')",
          enabled: allowedSuits.includes('clubs'),
        })}

        ${renderBiddingButton({
          label: 'Без коз',
          icon: 'A',
          iconColor: '#111827',
          onclick: 'bidNoTrumpsAndRender()',
          enabled: allowedContracts.includes('no-trumps'),
        })}

        ${renderBiddingButton({
          label: 'Каро',
          icon: '♦',
          iconColor: '#dc2626',
          onclick: "bidSuitAndRender('diamonds')",
          enabled: allowedSuits.includes('diamonds'),
        })}

        ${renderBiddingButton({
          label: 'Всичко коз',
          icon: 'J',
          iconColor: '#dc2626',
          onclick: 'bidAllTrumpsAndRender()',
          enabled: allowedContracts.includes('all-trumps'),
          isAccent: true,
        })}

        ${renderBiddingButton({
          label: 'Купа',
          icon: '♥',
          iconColor: '#ef4444',
          onclick: "bidSuitAndRender('hearts')",
          enabled: allowedSuits.includes('hearts'),
        })}

        ${renderBiddingButton({
          label: 'Контра',
          icon: 'x2',
          iconColor: '#b91c1c',
          onclick: 'doubleBidAndRender()',
          enabled: canDouble,
          isAccent: true,
        })}

        ${renderBiddingButton({
          label: 'Пика',
          icon: '♠',
          iconColor: '#111827',
          onclick: "bidSuitAndRender('spades')",
          enabled: allowedSuits.includes('spades'),
        })}

        ${renderBiddingButton({
          label: 'Ре контра',
          icon: 'x4',
          iconColor: '#991b1b',
          onclick: 'redoubleBidAndRender()',
          enabled: canRedouble,
          isDanger: true,
        })}
      </div>

      <div style="margin-top: 10px;">
        ${renderBiddingButton({
          label: 'Пас',
          onclick: 'passBidAndRender()',
          enabled: true,
          isPass: true,
        })}
      </div>
    </div>
  `
}

function renderMiniCard(card, extraStyle = '') {
  const rank = getCardRank(card)
  const suit = getCardSuit(card)
  const color = getSuitColor(suit)

  return `
    <div
      style="
        width: clamp(56px, 5.2vw, 86px);
        height: clamp(82px, 7.7vw, 126px);
        border-radius: clamp(10px, 1vw, 14px);
        border: 1px solid #d1d5db;
        background: white;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding: clamp(5px, 0.55vw, 8px);
        box-shadow: 0 10px 24px rgba(0,0,0,0.22);
        ${extraStyle}
      "
    >
      <div style="font-size: clamp(15px, 1.05vw, 20px); font-weight: 700; color: ${color};">${rank}</div>
      <div style="font-size: clamp(20px, 1.9vw, 30px); font-weight: 700; color: ${color}; align-self: center;">
        ${getSuitSymbol(suit)}
      </div>
      <div style="font-size: clamp(15px, 1.05vw, 20px); font-weight: 700; color: ${color}; align-self: flex-end;">
        ${rank}
      </div>
    </div>
  `
}

function renderCardBack(extraStyle = '') {
  return `
    <div
      style="
        width: clamp(58px, 5vw, 78px);
        height: clamp(84px, 7vw, 112px);
        border-radius: clamp(10px, 1vw, 14px);
        background:
          radial-gradient(circle at 50% 50%, rgba(255,255,255,0.18) 0 10%, transparent 10% 100%),
          radial-gradient(circle at 25% 25%, rgba(255,255,255,0.14) 0 6%, transparent 6% 100%),
          radial-gradient(circle at 75% 25%, rgba(255,255,255,0.14) 0 6%, transparent 6% 100%),
          radial-gradient(circle at 25% 75%, rgba(255,255,255,0.14) 0 6%, transparent 6% 100%),
          radial-gradient(circle at 75% 75%, rgba(255,255,255,0.14) 0 6%, transparent 6% 100%),
          linear-gradient(135deg, #153457 0%, #214b77 48%, #16395d 100%);
        border: 2px solid rgba(214, 228, 244, 0.85);
        box-shadow: 0 10px 22px rgba(0,0,0,0.22);
        position: relative;
        overflow: hidden;
        ${extraStyle}
      "
    >
      <div
        style="
          position:absolute;
          inset: 7px;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.28);
          background:
            repeating-linear-gradient(
              45deg,
              rgba(255,255,255,0.08) 0 4px,
              rgba(255,255,255,0.02) 4px 8px
            );
        "
      ></div>
    </div>
  `
}

function renderCurrentTrick(currentTrick = []) {
  const map = {
    bottom: null,
    right: null,
    top: null,
    left: null,
  }

  currentTrick.forEach((entry) => {
    map[entry.playerId] = entry.card
  })

  return `
    <div
      style="
        position: relative;
        width: min(34vw, 360px);
        height: min(28vw, 300px);
        min-width: 220px;
        min-height: 190px;
      "
    >
      <div style="position:absolute; left:50%; top:12%; transform:translateX(-50%) rotate(4deg); z-index:2;">
        ${map.top ? renderMiniCard(map.top) : ''}
      </div>

      <div style="position:absolute; left:18%; top:36%; transform:rotate(-12deg); z-index:3;">
        ${map.left ? renderMiniCard(map.left) : ''}
      </div>

      <div style="position:absolute; right:18%; top:36%; transform:rotate(11deg); z-index:4;">
        ${map.right ? renderMiniCard(map.right) : ''}
      </div>

      <div style="position:absolute; left:50%; bottom:10%; transform:translateX(-50%) rotate(-5deg); z-index:5;">
        ${map.bottom ? renderMiniCard(map.bottom) : ''}
      </div>
    </div>
  `
}

function renderCenterContent(phase, currentTrick) {
  if (currentTrick.length > 0) {
    return renderCurrentTrick(currentTrick)
  }

  return ''
}

function renderBottomHandCards(hand = [], phase, currentTurn) {
  if (!hand.length) {
    return ''
  }

  const canPlayNow = phase === 'playing' && currentTurn === 'bottom'
  const middleIndex = (hand.length - 1) / 2

  return `
    <div
      style="
        position: relative;
        width: min(92vw, 920px);
        height: clamp(168px, 23vh, 268px);
        margin: 0 auto;
      "
    >
      ${hand
        .map((card, index) => {
          const rank = getCardRank(card)
          const suit = getCardSuit(card)
          const color = getSuitColor(suit)
          const cardId = getCardId(card)
          const offsetFromCenter = index - middleIndex
          const rotate = offsetFromCenter * 8
          const horizontal = offsetFromCenter * 54
          const curveLift = Math.abs(offsetFromCenter) * 4
          const zIndex = Math.round(200 - Math.abs(offsetFromCenter) * 10 + index)

          return `
            <div
              data-base-z="${zIndex}"
              style="
                position: absolute;
                left: 50%;
                bottom: 0;
                width: clamp(76px, 7vw, 106px);
                height: clamp(114px, 11vw, 156px);
                transform: translateX(${horizontal}px) translateY(-${curveLift}px) rotate(${rotate}deg);
                transform-origin: center bottom;
                z-index: ${zIndex};
                pointer-events: auto;
              "
            >
              <button
                type="button"
                class="bottom-card-btn"
                onclick="window.playCardAndRender && window.playCardAndRender('${cardId}')"
                onmouseenter="
                  if (${canPlayNow ? 'true' : 'false'}) {
                    this.style.transform='translateY(-16px)';
                    this.style.boxShadow='0 18px 34px rgba(0,0,0,0.30)';
                    this.parentElement.style.zIndex='500';
                  }
                "
                onmouseleave="
                  this.style.transform='';
                  this.style.boxShadow='0 10px 24px rgba(0,0,0,0.22)';
                  this.parentElement.style.zIndex=this.parentElement.dataset.baseZ;
                "
                style="
                  width: 100%;
                  height: 100%;
                  border-radius: clamp(10px, 1vw, 14px);
                  border: 1px solid #cbbf95;
                  background: #efe4bd;
                  display: flex;
                  flex-direction: column;
                  justify-content: space-between;
                  padding: clamp(6px, 0.7vw, 10px);
                  box-shadow: 0 10px 24px rgba(0,0,0,0.22);
                  transition: transform 0.15s ease, box-shadow 0.15s ease;
                  cursor: ${canPlayNow ? 'pointer' : 'default'};
                  opacity: ${canPlayNow ? '1' : '0.96'};
                  pointer-events: ${canPlayNow ? 'auto' : 'none'};
                  transform-origin: center bottom;
                "
                ${canPlayNow ? '' : 'disabled'}
              >
                <div style="font-size: clamp(18px, 1.55vw, 24px); font-weight:700; color:${color}; text-align:left;">
                  ${rank}
                </div>
                <div style="font-size: clamp(32px, 2.8vw, 42px); font-weight:700; color:${color}; text-align:center;">
                  ${getSuitSymbol(suit)}
                </div>
                <div style="font-size: clamp(18px, 1.55vw, 24px); font-weight:700; color:${color}; text-align:right;">
                  ${rank}
                </div>
              </button>
            </div>
          `
        })
        .join('')}
    </div>
  `
}

function renderTopLeftScorePanel({ contract, trumpSuit, winningBidder, scores }) {
  const announcement = formatAnnouncement(contract, trumpSuit)
  const bidder = winningBidder ? formatPlayerName(winningBidder) : 'Няма'
  const symbol =
    contract === 'color'
      ? getSuitSymbol(trumpSuit)
      : contract === 'all-trumps'
        ? '★'
        : contract === 'no-trumps'
          ? '⦸'
          : ''

  return `
    <div
      style="
        position: absolute;
        top: clamp(10px, 1.4vw, 18px);
        left: clamp(10px, 1.4vw, 18px);
        width: clamp(140px, 12vw, 200px);
        border-radius: clamp(10px, 1vw, 16px);
        overflow: hidden;
        background: rgba(20, 36, 59, 0.88);
        box-shadow: 0 12px 28px rgba(0,0,0,0.22);
        z-index: 8;
      "
    >
      <div
        style="
          display:grid;
          grid-template-columns:1fr 1fr;
          padding: clamp(12px, 1vw, 16px);
          gap: 8px;
          text-align:center;
        "
      >
        <div>
          <div style="font-size: clamp(14px, 1.4vw, 24px); font-weight: 800; color: #f8fafc;">НИЕ</div>
          <div style="margin-top: 6px; font-size: clamp(20px, 2vw, 42px); color:#ffffff;">${scores.teamA ?? 0}</div>
        </div>

        <div>
          <div style="font-size: clamp(14px, 1.4vw, 24px); font-weight: 800; color: #f8fafc;">ВИЕ</div>
          <div style="margin-top: 6px; font-size: clamp(20px, 2vw, 42px); color:#ffffff;">${scores.teamB ?? 0}</div>
        </div>
      </div>

      <div
        style="
          min-height: clamp(28px, 2.6vw, 42px);
          background: #f2a81d;
          display:flex;
          align-items:center;
          gap: 8px;
          padding: 0 clamp(10px, 0.9vw, 14px);
          color:#ffffff;
          font-weight:700;
          font-size: clamp(12px, 1vw, 18px);
        "
      >
        <span style="font-size: clamp(15px, 1.3vw, 22px); line-height:1;">
          ${symbol}
        </span>
        <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${announcement} ${winningBidder ? `• ${bidder}` : ''}
        </span>
      </div>
    </div>
  `
}

function renderPlayerAvatar(player, fallbackName) {
  const avatar = getPlayerAvatar(player)
  const safeName = escapeHtml(getPlayerDisplayName(player, fallbackName))

  if (avatar) {
    return `
      <img
        src="${escapeHtml(avatar)}"
        alt="${safeName}"
        style="
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        "
      />
    `
  }

  return `
    <div
      style="
        width: 100%;
        height: 100%;
        display:flex;
        align-items:center;
        justify-content:center;
        background:
          radial-gradient(circle at 30% 30%, rgba(255,255,255,0.16), transparent 35%),
          linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02)),
          #223854;
        color: rgba(255,255,255,0.92);
        font-size: clamp(22px, 1.8vw, 32px);
        font-weight: 800;
        letter-spacing: 0.02em;
      "
    >
      ${escapeHtml(getPlayerInitial(safeName))}
    </div>
  `
}

function renderOpponentCardFan(cardsCount, position) {
  if (!cardsCount) {
    return ''
  }

  const visibleCount = Math.min(cardsCount, 8)
  const middleIndex = (visibleCount - 1) / 2

  if (position === 'top') {
    return `
      <div
        style="
          position: absolute;
          left: 50%;
          top: 0;
          transform: translateX(-50%);
          width: min(32vw, 360px);
          height: 120px;
          pointer-events: none;
          z-index: 1;
        "
      >
        ${Array.from({ length: visibleCount })
          .map((_, index) => {
            const offset = index - middleIndex
            const x = offset * 24
            const rotate = offset * 7
            const y = Math.abs(offset) * 3

            return `
              <div
                style="
                  position: absolute;
                  left: 50%;
                  top: 0;
                  transform: translateX(${x}px) translateY(${y}px) rotate(${rotate}deg);
                  transform-origin: center bottom;
                  z-index: ${50 + index};
                "
              >
                ${renderCardBack()}
              </div>
            `
          })
          .join('')}
      </div>
    `
  }

  if (position === 'left') {
    return `
      <div
        style="
          position: absolute;
          left: 6px;
          top: 50%;
          transform: translateY(-50%);
          width: 110px;
          height: min(34vh, 320px);
          pointer-events: none;
          z-index: 1;
        "
      >
        ${Array.from({ length: visibleCount })
          .map((_, index) => {
            const offset = index - middleIndex
            const y = offset * 16
            const x = Math.abs(offset) * 2
            const rotate = offset * 5

            return `
              <div
                style="
                  position: absolute;
                  left: ${x}px;
                  top: 50%;
                  transform: translateY(${y}px) rotate(${rotate}deg);
                  transform-origin: center center;
                  z-index: ${50 + index};
                "
              >
                ${renderCardBack()}
              </div>
            `
          })
          .join('')}
      </div>
    `
  }

  return `
    <div
      style="
        position: absolute;
        right: 6px;
        top: 50%;
        transform: translateY(-50%);
        width: 110px;
        height: min(34vh, 320px);
        pointer-events: none;
        z-index: 1;
      "
    >
      ${Array.from({ length: visibleCount })
        .map((_, index) => {
          const offset = index - middleIndex
          const y = offset * 16
          const x = Math.abs(offset) * 2
          const rotate = offset * -5

          return `
            <div
              style="
                position: absolute;
                right: ${x}px;
                top: 50%;
                transform: translateY(${y}px) rotate(${rotate}deg);
                transform-origin: center center;
                z-index: ${50 + index};
              "
            >
              ${renderCardBack()}
            </div>
          `
        })
        .join('')}
    </div>
  `
}

function renderSeat({ player, name, cardsCount, currentTurn, playerId, position }) {
  const isActive = currentTurn === playerId
  const safeName = escapeHtml(getPlayerDisplayName(player, name))

  let wrapperStyle = `
    position: absolute;
    z-index: 4;
  `

  let seatStyle = `
    position: absolute;
    width: clamp(104px, 8vw, 132px);
    height: clamp(104px, 8vw, 132px);
    border-radius: 18px;
    background: rgba(15, 23, 42, 0.82);
    border: 2px solid ${isActive ? 'rgba(250, 204, 21, 0.95)' : 'rgba(255,255,255,0.14)'};
    box-shadow: ${isActive ? '0 0 0 4px rgba(250, 204, 21, 0.14), 0 12px 30px rgba(0,0,0,0.22)' : '0 12px 30px rgba(0,0,0,0.20)'};
    overflow: hidden;
  `

  if (position === 'top') {
    wrapperStyle += `
      top: clamp(10px, 1.4vw, 18px);
      left: 50%;
      transform: translateX(-50%);
      width: min(34vw, 380px);
      height: 180px;
    `

    seatStyle += `
      left: 50%;
      bottom: 0;
      transform: translateX(-50%);
    `
  }

  if (position === 'left') {
    wrapperStyle += `
      left: clamp(10px, 1.4vw, 18px);
      top: 50%;
      transform: translateY(-50%);
      width: 220px;
      height: min(36vh, 340px);
    `

    seatStyle += `
      right: 0;
      top: 50%;
      transform: translateY(-50%);
    `
  }

  if (position === 'right') {
    wrapperStyle += `
      right: clamp(10px, 1.4vw, 18px);
      top: 50%;
      transform: translateY(-50%);
      width: 220px;
      height: min(36vh, 340px);
    `

    seatStyle += `
      left: 0;
      top: 50%;
      transform: translateY(-50%);
    `
  }

  return `
    <div style="${wrapperStyle}">
      ${renderOpponentCardFan(cardsCount, position)}

      <div style="${seatStyle}">
        <div
          style="
            width: 100%;
            height: 100%;
            display:flex;
            flex-direction:column;
            align-items:center;
            justify-content:flex-start;
            padding: 8px;
            gap: 6px;
            position: relative;
            z-index: 2;
          "
        >
          <div
            style="
              width: calc(100% - 8px);
              aspect-ratio: 1 / 1;
              border-radius: 14px;
              overflow: hidden;
              background: rgba(255,255,255,0.06);
              border: 1px solid rgba(255,255,255,0.10);
              flex: 1 1 auto;
              min-height: 0;
            "
          >
            ${renderPlayerAvatar(player, name)}
          </div>

          <div
            style="
              width: 100%;
              text-align: center;
              font-size: clamp(12px, 0.95vw, 15px);
              font-weight: 700;
              color: #f8fafc;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
              padding: 0 4px;
            "
          >
            ${safeName}
          </div>
        </div>
      </div>
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
  const currentTurn =
    phase === 'bidding'
      ? bidding.currentTurn ?? gameState.currentTurn ?? null
      : gameState.currentTurn ?? null

  const contract = bidding.contract ?? gameState.contract ?? null
  const trumpSuit = bidding.trumpSuit ?? gameState.trumpSuit ?? null
  const winningBidder = bidding.winningBidder ?? gameState.winningBidder ?? null
  const currentTrick = gameState.currentTrick ?? []
  const scores = gameState.scores ?? { teamA: 0, teamB: 0 }

  const showBottomHand =
    phase === 'bidding' || phase === 'playing' || phase === 'round-complete'

  const biddingControlsHtml = renderHumanBiddingControls({
    phase,
    currentTurn,
    bidding,
  })

  return `
    <div class="app">
      <main
        class="table-wrap"
        style="
          padding: 0;
          min-height: 100vh;
          height: 100vh;
        "
      >
        <section
          class="table"
          style="
            position: relative;
            width: 100vw;
            height: 100vh;
            min-height: 100vh;
            max-width: none;
            border-radius: 0;
            border: none;
            padding: 0;
            overflow: hidden;
            background:
              radial-gradient(circle at center, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 18%, rgba(0,0,0,0) 19%),
              radial-gradient(circle at center, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.03) 32%, rgba(0,0,0,0) 33%),
              radial-gradient(circle at center, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 48%, rgba(0,0,0,0) 49%),
              radial-gradient(circle at center, #6da5cf 0%, #5f97c2 38%, #4d83ad 68%, #43749c 100%);
          "
        >
          ${renderTopLeftScorePanel({
            contract,
            trumpSuit,
            winningBidder,
            scores,
          })}

          ${renderSeat({
            player: topPlayer,
            name: 'Горен играч',
            cardsCount: topCount,
            currentTurn,
            playerId: 'top',
            position: 'top',
          })}

          ${renderSeat({
            player: leftPlayer,
            name: 'Ляв играч',
            cardsCount: leftCount,
            currentTurn,
            playerId: 'left',
            position: 'left',
          })}

          ${renderSeat({
            player: rightPlayer,
            name: 'Десен играч',
            cardsCount: rightCount,
            currentTurn,
            playerId: 'right',
            position: 'right',
          })}

          <div
            style="
              position: absolute;
              left: 50%;
              top: 50%;
              transform: translate(-50%, -50%);
              display: flex;
              align-items: center;
              justify-content: center;
              width: min(44vw, 480px);
              height: min(36vw, 360px);
              min-width: 240px;
              min-height: 220px;
              z-index: 2;
            "
          >
            ${renderCenterContent(phase, currentTrick)}
          </div>

          <div
            style="
              position: absolute;
              left: 50%;
              bottom: clamp(10px, 1.4vw, 18px);
              transform: translateX(-50%);
              width: min(94vw, 980px);
              z-index: 5;
            "
          >
            <div
              style="
                width: fit-content;
                min-width: clamp(170px, 14vw, 240px);
                margin: 0 auto 10px;
                padding: 10px 16px;
                border-radius: 16px;
                background: rgba(15, 23, 42, 0.78);
                border: 2px solid ${currentTurn === 'bottom' ? 'rgba(250, 204, 21, 0.95)' : 'rgba(255,255,255,0.12)'};
                box-shadow: ${currentTurn === 'bottom' ? '0 0 0 4px rgba(250, 204, 21, 0.12)' : '0 8px 20px rgba(0,0,0,0.14)'};
                text-align: center;
              "
            >
              <div style="font-size: clamp(16px, 1.1vw, 20px); font-weight: 700; color: #f8fafc;">
                ${escapeHtml(getPlayerDisplayName(bottomPlayer, 'Ти'))} (ти)
              </div>
              <div style="margin-top: 4px; font-size: clamp(13px, 0.95vw, 17px); color:#d1fae5; font-weight:700;">
                Карти: ${bottomCount}
              </div>
            </div>

            ${showBottomHand ? renderBottomHandCards(hands.bottom ?? [], phase, currentTurn) : ''}
          </div>

          ${
            phase === 'bidding'
              ? `
                <div
                  style="
                    position: absolute;
                    left: 50%;
                    bottom: clamp(180px, 25vh, 290px);
                    transform: translateX(-50%);
                    width: min(92vw, 440px);
                    padding: 10px;
                    border-radius: 16px;
                    background: rgba(17, 34, 56, 0.88);
                    border: 2px solid #d79a1e;
                    box-shadow: 0 14px 28px rgba(0,0,0,0.24);
                    z-index: 8;
                  "
                >
                  ${biddingControlsHtml}
                </div>
              `
              : ''
          }
        </section>
      </main>
    </div>
  `
}