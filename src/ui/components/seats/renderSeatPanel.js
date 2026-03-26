import { getPlayerDisplayName } from '../../helpers/players.js'
import { escapeHtml } from '../../helpers/formatters.js'
import { renderPlayerAvatar } from './renderPlayerAvatar.js'

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

export function renderSeatPanel(player, fallbackName, isActive, options = {}) {
  const safeName = escapeHtml(getPlayerDisplayName(player, fallbackName))

  const playerId = options.playerId ?? ''
  const showBidInfo = options.showBidInfo ?? false
  const lastBidText = formatBidText(options.lastBidInfo)
  const timeProgress = Math.max(0, Math.min(100, Number(options.timeProgress ?? 0)))
  const timerSecondsLeft = Math.max(0, Number(options.timerSecondsLeft ?? 0))
  const showTimer = showBidInfo && isActive
  const showActiveBidBanner = showBidInfo && isActive

  return `
    <div
      style="
        width: 100%;
        height: 100%;
        border-radius: 18px;
        overflow: hidden;
        background: rgba(15, 23, 42, 0.84);
        border: 2px solid ${isActive ? 'rgba(250, 204, 21, 0.96)' : 'rgba(255,255,255,0.12)'};
        box-shadow: ${isActive ? '0 0 0 4px rgba(250,204,21,0.14), 0 12px 30px rgba(0,0,0,0.24)' : '0 12px 24px rgba(0,0,0,0.20)'};
        display: flex;
        flex-direction: column;
      "
    >
      ${
        showActiveBidBanner
          ? `
            <div
              data-bidding-active-bar="${escapeHtml(playerId)}"
              style="
                height: 12px;
                background: linear-gradient(90deg, #16a34a 0%, #22c55e 50%, #4ade80 100%);
                box-shadow: inset 0 -1px 0 rgba(255,255,255,0.18);
                flex-shrink: 0;
              "
            ></div>
          `
          : ''
      }

      <div
        style="
          height: ${showBidInfo ? 'calc(100% - 78px)' : 'calc(100% - 40px)'};
          padding: 7px;
        "
      >
        <div
          style="
            width: 100%;
            height: 100%;
            border-radius: 14px;
            overflow: hidden;
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.10);
          "
        >
          ${renderPlayerAvatar(player, fallbackName)}
        </div>
      </div>

      ${
        showBidInfo
          ? `
            <div
              style="
                height: 38px;
                padding: 6px 8px 4px 8px;
                background: rgba(7, 18, 33, 0.96);
                border-top: 1px solid rgba(255,255,255,0.08);
                display: flex;
                flex-direction: column;
                justify-content: center;
                gap: 5px;
              "
            >
              <div
                style="
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  gap: 6px;
                  min-width: 0;
                "
              >
                <div
                  style="
                    color: rgba(255,255,255,0.92);
                    font-size: clamp(10px, 0.8vw, 13px);
                    font-weight: 700;
                    text-align: center;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    min-width: 0;
                  "
                >
                  ${escapeHtml(lastBidText)}
                </div>

                ${
                  showTimer
                    ? `
                      <div
                        data-bidding-timer-text="${escapeHtml(playerId)}"
                        style="
                          flex-shrink: 0;
                          color: #86efac;
                          font-size: clamp(9px, 0.72vw, 11px);
                          font-weight: 800;
                          letter-spacing: 0.02em;
                          white-space: nowrap;
                        "
                      >
                        ${escapeHtml(formatTimerText(timerSecondsLeft))}
                      </div>
                    `
                    : ''
                }
              </div>

              <div
                style="
                  width: 100%;
                  height: 7px;
                  border-radius: 999px;
                  overflow: hidden;
                  background: rgba(255,255,255,0.10);
                  box-shadow: inset 0 1px 2px rgba(0,0,0,0.24);
                "
              >
                <div
                  data-bidding-progress-fill="${escapeHtml(playerId)}"
                  style="
                    width: ${showTimer ? `${timeProgress}%` : '0%'};
                    height: 100%;
                    border-radius: 999px;
                    background: linear-gradient(90deg, #22c55e 0%, #4ade80 100%);
                    transition: width 0.1s linear;
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
          height: 40px;
          background: rgba(2, 19, 38, 0.96);
          display:flex;
          align-items:center;
          justify-content:center;
          padding: 0 8px;
          color:#f8fafc;
          font-size: clamp(12px, 0.95vw, 16px);
          font-weight: 700;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          border-top: ${showBidInfo ? '1px solid rgba(255,255,255,0.06)' : 'none'};
        "
      >
        ${safeName}
      </div>
    </div>
  `
}
