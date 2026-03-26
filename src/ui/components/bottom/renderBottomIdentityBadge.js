import { getPlayerAvatar, getPlayerDisplayName, getPlayerInitial } from '../../helpers/players.js'
import { escapeHtml } from '../../helpers/formatters.js'

function formatBidText(bidInfo) {
  if (!bidInfo) {
    return 'Все още няма обява'
  }

  if (typeof bidInfo === 'string') {
    return bidInfo
  }

  if (bidInfo.type === 'pass') {
    return 'Пас'
  }

  if (bidInfo.type === 'double') {
    return 'Контра'
  }

  if (bidInfo.type === 'redouble') {
    return 'Ре контра'
  }

  if (bidInfo.type === 'all-trumps') {
    return 'Всичко коз'
  }

  if (bidInfo.type === 'no-trumps') {
    return 'Без коз'
  }

  if (bidInfo.type === 'suit') {
    if (bidInfo.suit === 'spades') return 'Пика'
    if (bidInfo.suit === 'hearts') return 'Купа'
    if (bidInfo.suit === 'diamonds') return 'Каро'
    if (bidInfo.suit === 'clubs') return 'Спатия'
  }

  return bidInfo.label ?? 'Обява'
}

function formatTimerText(secondsLeft) {
  const safeSeconds = Math.max(0, Number(secondsLeft ?? 0))
  return `${safeSeconds} сек`
}

export function renderBottomIdentityBadge(
  player,
  fallbackName,
  currentTurn,
  cardsCount,
  options = {}
) {
  const avatar = getPlayerAvatar(player)
  const displayName = getPlayerDisplayName(player, fallbackName)
  const safeName = escapeHtml(displayName)
  const seatId = 'bottom'
  const isActive = currentTurn === seatId

  const showBidInfo = options.showBidInfo ?? false
  const lastBidText = formatBidText(options.lastBidInfo)
  const timeProgress = Math.max(0, Math.min(100, Number(options.timeProgress ?? 0)))
  const timerSecondsLeft = Math.max(0, Number(options.timerSecondsLeft ?? 0))
  const showTimer = showBidInfo && isActive
  const showActiveBidBanner = showBidInfo && isActive

  return `
    <div
      data-bidding-seat-root="${seatId}"
      style="
        position: absolute;
        left: 50%;
        bottom: 8px;
        transform: translateX(-50%);
        z-index: 420;
        display: flex;
        align-items: stretch;
        gap: 12px;
        min-width: clamp(260px, 26vw, 390px);
        max-width: min(78vw, 520px);
        padding: 0;
        border-radius: 18px;
        overflow: hidden;
        background: rgba(18, 31, 49, 0.86);
        border: 3px solid ${isActive ? '#f59e0b' : 'rgba(255,255,255,0.12)'};
        box-shadow: ${isActive ? '0 0 0 4px rgba(245,158,11,0.14), 0 14px 30px rgba(0,0,0,0.26)' : '0 12px 24px rgba(0,0,0,0.22)'};
        backdrop-filter: blur(4px);
      "
    >
      ${
        showBidInfo
          ? `
            <div
              data-bidding-active-strip="${seatId}"
              style="
                position: absolute;
                left: 0;
                top: 0;
                width: 100%;
                height: 12px;
                background: linear-gradient(90deg, #16a34a 0%, #22c55e 50%, #4ade80 100%);
                box-shadow: inset 0 -1px 0 rgba(255,255,255,0.18);
                opacity: ${showActiveBidBanner ? '1' : '0'};
                transition: opacity 0.15s linear;
              "
            ></div>
          `
          : ''
      }

      <div
        style="
          width: 100%;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: ${showBidInfo ? '18px 12px 8px 12px' : '8px 12px'};
        "
      >
        <div
          style="
            width: 66px;
            height: 66px;
            border-radius: 14px;
            overflow: hidden;
            flex-shrink: 0;
            border: 2px solid rgba(255,255,255,0.18);
            background: rgba(255,255,255,0.08);
          "
        >
          ${
            avatar
              ? `
                <img
                  src="${escapeHtml(avatar)}"
                  alt="${safeName}"
                  style="width:100%; height:100%; object-fit:cover; display:block;"
                />
              `
              : `
                <div
                  style="
                    width:100%;
                    height:100%;
                    display:flex;
                    align-items:center;
                    justify-content:center;
                    background:
                      radial-gradient(circle at 30% 30%, rgba(255,255,255,0.16), transparent 35%),
                      linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02)),
                      #223854;
                    color: rgba(255,255,255,0.92);
                    font-size: 28px;
                    font-weight: 800;
                  "
                >
                  ${escapeHtml(getPlayerInitial(displayName))}
                </div>
              `
          }
        </div>

        <div style="min-width:0; flex:1; display:flex; flex-direction:column; gap:6px;">
          <div
            style="
              color:#ffffff;
              font-size: clamp(20px, 1.5vw, 32px);
              line-height: 1.05;
              font-weight: 700;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            "
          >
            ${safeName}
          </div>

          ${
            showBidInfo
              ? `
                <div
                  style="
                    padding: 6px 10px 7px 10px;
                    border-radius: 12px;
                    background: rgba(7, 18, 33, 0.92);
                    border: 1px solid rgba(255,255,255,0.08);
                    display:flex;
                    flex-direction:column;
                    gap:6px;
                  "
                >
                  <div
                    style="
                      display:flex;
                      align-items:center;
                      justify-content:center;
                      gap:8px;
                      min-width:0;
                    "
                  >
                    <div
                      style="
                        color: rgba(255,255,255,0.94);
                        font-size: clamp(11px, 0.82vw, 14px);
                        font-weight: 700;
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        text-align: center;
                        min-width: 0;
                      "
                    >
                      ${escapeHtml(lastBidText)}
                    </div>

                    <div
                      data-bidding-timer-text="${seatId}"
                      style="
                        flex-shrink: 0;
                        color: #86efac;
                        font-size: clamp(10px, 0.78vw, 12px);
                        font-weight: 800;
                        letter-spacing: 0.02em;
                        white-space: nowrap;
                        opacity: ${showTimer ? '1' : '0'};
                        transition: opacity 0.15s linear;
                      "
                    >
                      ${escapeHtml(formatTimerText(timerSecondsLeft))}
                    </div>
                  </div>

                  <div
                    style="
                      width: 100%;
                      height: 8px;
                      border-radius: 999px;
                      overflow: hidden;
                      background: rgba(255,255,255,0.10);
                      box-shadow: inset 0 1px 2px rgba(0,0,0,0.24);
                    "
                  >
                    <div
                      data-bidding-progress-bar="${seatId}"
                      style="
                        width: ${showTimer ? `${timeProgress}%` : '0%'};
                        height: 100%;
                        border-radius: 999px;
                        background: linear-gradient(90deg, #22c55e 0%, #4ade80 100%);
                        transition: width 0.15s linear, opacity 0.15s linear;
                        opacity: ${showTimer ? '1' : '0'};
                      "
                    ></div>
                  </div>
                </div>
              `
              : ''
          }

          <div
            style="
              display:inline-flex;
              align-items:center;
              justify-content:center;
              align-self:flex-start;
              min-width: 120px;
              padding: 6px 12px;
              border-radius: 10px;
              background: #f2a81d;
              color:#ffffff;
              font-size: clamp(14px, 0.9vw, 16px);
              font-weight: 800;
            "
          >
            Карти: ${cardsCount}
          </div>
        </div>
      </div>
    </div>
  `
}
