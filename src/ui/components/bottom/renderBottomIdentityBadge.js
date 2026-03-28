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

  const showCuttingTimer = options.showCuttingTimer ?? false
  const cuttingTimeProgress = Math.max(0, Math.min(100, Number(options.cuttingTimeProgress ?? 0)))

  const isCompactActiveBiddingCard = showBidInfo && isActive

  if (isCompactActiveBiddingCard) {
    return `
      <div
        data-bidding-seat-root="${seatId}"
        style="
          position: absolute;
          left: 50%;
          bottom: 8px;
          transform: translateX(-50%);
          z-index: 420;
          width: clamp(112px, 8.4vw, 136px);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
        "
      >
        <div
          style="
            width: 100%;
            aspect-ratio: 1 / 1;
            border-radius: 18px;
            overflow: hidden;
            background: rgba(15, 23, 42, 0.92);
            border: 3px solid #f59e0b;
            box-shadow: 0 0 0 4px rgba(245,158,11,0.14), 0 14px 30px rgba(0,0,0,0.26);
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
                      font-size: clamp(28px, 2.1vw, 40px);
                      font-weight: 800;
                    "
                  >
                    ${escapeHtml(getPlayerInitial(displayName))}
                  </div>
                `
            }
          </div>
        </div>

        <div
          style="
            width: 100%;
            height: 8px;
            border-radius: 999px;
            overflow: hidden;
            background: rgba(7, 18, 33, 0.9);
            box-shadow: inset 0 1px 2px rgba(0,0,0,0.24), 0 6px 14px rgba(0,0,0,0.18);
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

        <div
          data-bidding-timer-text="${seatId}"
          style="
            display: none;
          "
        >
          ${escapeHtml(formatTimerText(timerSecondsLeft))}
        </div>
      </div>
    `
  }

  return `
    <div
      data-bidding-seat-root="${seatId}"
      style="
        position: absolute;
        left: 50%;
        bottom: 8px;
        transform: translateX(-50%);
        z-index: 420;
        width: clamp(112px, 8.4vw, 136px);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: ${showCuttingTimer ? '6px' : '0'};
      "
    >
      <div
        style="
          width: 100%;
          height: ${showBidInfo ? 'clamp(186px, 13.8vw, 220px)' : 'clamp(148px, 11vw, 176px)'};
          border-radius: 18px;
          overflow: hidden;
          background: rgba(15, 23, 42, 0.84);
          border: 3px solid ${isActive ? '#f59e0b' : 'rgba(255,255,255,0.12)'};
          box-shadow: ${isActive ? '0 0 0 4px rgba(245,158,11,0.14), 0 14px 30px rgba(0,0,0,0.26)' : '0 12px 24px rgba(0,0,0,0.22)'};
          backdrop-filter: blur(4px);
          display: flex;
          flex-direction: column;
        "
      >
        ${
          showBidInfo
            ? `
              <div
                data-bidding-active-strip="${seatId}"
                style="
                  height: 12px;
                  background: linear-gradient(90deg, #16a34a 0%, #22c55e 50%, #4ade80 100%);
                  box-shadow: inset 0 -1px 0 rgba(255,255,255,0.18);
                  opacity: 0;
                  transition: opacity 0.15s linear;
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
              position: relative;
              width: 100%;
              height: 100%;
              border-radius: 14px;
              overflow: hidden;
              background: rgba(255,255,255,0.08);
              border: 1px solid rgba(255,255,255,0.10);
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
                      font-size: clamp(28px, 2.1vw, 40px);
                      font-weight: 800;
                    "
                  >
                    ${escapeHtml(getPlayerInitial(displayName))}
                  </div>
                `
            }
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
                      color: rgba(255,255,255,0.94);
                      font-size: clamp(10px, 0.76vw, 12px);
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

                  <div
                    data-bidding-timer-text="${seatId}"
                    style="
                      flex-shrink: 0;
                      color: #86efac;
                      font-size: clamp(9px, 0.72vw, 11px);
                      font-weight: 800;
                      letter-spacing: 0.02em;
                      white-space: nowrap;
                      opacity: 0;
                      transition: opacity 0.15s linear;
                    "
                  >
                    ${escapeHtml(formatTimerText(timerSecondsLeft))}
                  </div>
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
                    data-bidding-progress-bar="${seatId}"
                    style="
                      width: 0%;
                      height: 100%;
                      border-radius: 999px;
                      background: linear-gradient(90deg, #22c55e 0%, #4ade80 100%);
                      transition: width 0.15s linear, opacity 0.15s linear;
                      opacity: 0;
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

      ${
        showCuttingTimer
          ? `
            <div
              style="
                width: 100%;
                height: 8px;
                border-radius: 999px;
                overflow: hidden;
                background: rgba(7, 18, 33, 0.9);
                box-shadow: inset 0 1px 2px rgba(0,0,0,0.24), 0 6px 14px rgba(0,0,0,0.18);
              "
            >
              <div
                data-cutting-progress-bar
                style="
                  width: ${`${cuttingTimeProgress}%`};
                  height: 100%;
                  border-radius: 999px;
                  background: linear-gradient(90deg, #22c55e 0%, #4ade80 100%);
                  transition: width 0.15s linear, opacity 0.15s linear;
                  opacity: 1;
                "
              ></div>
            </div>
          `
          : ''
      }
    </div>
  `
}