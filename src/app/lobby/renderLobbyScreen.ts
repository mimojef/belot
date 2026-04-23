import type { MatchStake } from '../network/createGameServerClient'
import { getViewportStageMetrics } from '../../ui/layout/viewportStage'

export type LobbyScreenState = {
  displayName: string
  selectedStake: MatchStake
  isConnected: boolean
  isSearching: boolean
  queuedPlayers: number
  requiredPlayers: number
  remainingMs: number | null
  statusText: string
  errorText: string | null
}

export type RenderLobbyScreenOptions = {
  state: LobbyScreenState
  onDisplayNameChange: (value: string) => void
  onStakeChange: (stake: MatchStake) => void
  onSearchClick: () => void
  onCancelClick: () => void
}

type LobbyStakeCard = {
  stake: MatchStake
  prizeAmount: number
}

const MATCH_STAKE_CARDS: LobbyStakeCard[] = [
  { stake: 5000, prizeAmount: 8000 },
  { stake: 8000, prizeAmount: 12000 },
  { stake: 10000, prizeAmount: 15000 },
  { stake: 15000, prizeAmount: 22000 },
  { stake: 20000, prizeAmount: 30000 },
]

const BASE_STAGE_WIDTH = 1120
const BASE_STAGE_HEIGHT = 700
const MAX_STAGE_SCALE = 1.06
const MIN_STAGE_SCALE = 0.56
const VIEWPORT_HORIZONTAL_PADDING = 28
const VIEWPORT_VERTICAL_PADDING = 28
const RESERVED_TOP_SPACE = 40

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatRemainingSeconds(remainingMs: number | null): string {
  if (remainingMs === null) {
    return '—'
  }

  return `${Math.max(0, Math.ceil(remainingMs / 1000))}`
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat('bg-BG').format(value)
}

export function renderLobbyScreen(
  root: HTMLElement,
  options: RenderLobbyScreenOptions,
): void {
  const { state } = options
  const canStartSearch = state.isConnected && !state.isSearching
  const profileName = state.displayName.trim() || 'Играч'

  const { stageScale, scaledStageWidth, scaledStageHeight } =
    getViewportStageMetrics({
      baseWidth: BASE_STAGE_WIDTH,
      baseHeight: BASE_STAGE_HEIGHT,
      minScale: MIN_STAGE_SCALE,
      maxScale: MAX_STAGE_SCALE,
      viewportHorizontalPadding: VIEWPORT_HORIZONTAL_PADDING,
      viewportVerticalPadding: VIEWPORT_VERTICAL_PADDING,
      reservedTopSpace: RESERVED_TOP_SPACE,
    })

  root.innerHTML = `
    <div
      data-lobby-screen-root="1"
      data-lobby-stage-scale="${stageScale.toFixed(4)}"
      style="
        min-height:100vh;
        box-sizing:border-box;
        padding:${Math.round(VIEWPORT_VERTICAL_PADDING / 2)}px ${Math.round(VIEWPORT_HORIZONTAL_PADDING / 2)}px;
        display:flex;
        align-items:flex-start;
        justify-content:center;
        overflow:hidden;
        background:
          radial-gradient(circle at 50% 16%, rgba(42, 112, 214, 0.26), transparent 34%),
          radial-gradient(circle at 50% 82%, rgba(255, 171, 23, 0.08), transparent 28%),
          linear-gradient(180deg, #081933 0%, #0a2347 48%, #091c3b 100%);
        font-family:Arial, Helvetica, sans-serif;
      "
    >
      <div
        style="
          position:relative;
          width:${scaledStageWidth}px;
          height:${scaledStageHeight}px;
          flex:0 0 auto;
        "
      >
        <div
          style="
            position:absolute;
            left:50%;
            top:0;
            width:${BASE_STAGE_WIDTH}px;
            height:${BASE_STAGE_HEIGHT}px;
            transform:translateX(-50%) scale(${stageScale});
            transform-origin:top center;
          "
        >
          <div
            style="
              width:100%;
              height:100%;
              display:flex;
              flex-direction:column;
              gap:18px;
              color:#f8fafc;
            "
          >
            <div
              style="
                display:flex;
                align-items:flex-start;
                justify-content:space-between;
                gap:16px;
                flex-wrap:wrap;
                border-radius:24px;
                padding:22px 24px;
                background:
                  linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03)),
                  linear-gradient(180deg, rgba(8,28,60,0.90), rgba(6,23,48,0.96));
                border:1px solid rgba(255,255,255,0.12);
                box-shadow:0 20px 48px rgba(0,0,0,0.24);
              "
            >
              <div style="min-width:300px; max-width:700px;">
                <div
                  style="
                    font-size:34px;
                    line-height:1.02;
                    font-weight:900;
                    letter-spacing:0.01em;
                  "
                >
                  Белот
                </div>

                <div
                  style="
                    margin-top:10px;
                    font-size:14px;
                    line-height:1.5;
                    color:rgba(255,255,255,0.74);
                    font-weight:600;
                  "
                >
                  Избери маса и влез в търсене на игра. Ако няма достатъчно играчи,
                  свободните места ще бъдат попълнени автоматично.
                </div>
              </div>

              <div
                style="
                  display:flex;
                  flex-direction:column;
                  gap:10px;
                  min-width:300px;
                  max-width:320px;
                "
              >
                <div
                  style="
                    border-radius:20px;
                    padding:14px 16px;
                    background:
                      linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02)),
                      rgba(11,28,57,0.72);
                    border:1px solid rgba(255,255,255,0.10);
                  "
                >
                  <div
                    style="
                      font-size:11px;
                      font-weight:800;
                      color:#94a3b8;
                      text-transform:uppercase;
                      letter-spacing:0.08em;
                    "
                  >
                    Профил
                  </div>

                  <div
                    style="
                      margin-top:7px;
                      font-size:22px;
                      font-weight:900;
                      line-height:1.1;
                      color:#ffffff;
                      white-space:nowrap;
                      overflow:hidden;
                      text-overflow:ellipsis;
                    "
                    title="${escapeHtml(profileName)}"
                  >
                    ${escapeHtml(profileName)}
                  </div>
                </div>

                <div
                  style="
                    display:grid;
                    grid-template-columns:repeat(3, minmax(0, 1fr));
                    gap:8px;
                  "
                >
                  <div
                    style="
                      border-radius:16px;
                      padding:10px;
                      background:rgba(15,23,42,0.55);
                      border:1px solid rgba(255,255,255,0.08);
                    "
                  >
                    <div style="font-size:10px; font-weight:800; color:#94a3b8; text-transform:uppercase;">
                      Връзка
                    </div>
                    <div style="margin-top:5px; font-size:13px; font-weight:900; color:${state.isConnected ? '#f8fafc' : '#fca5a5'};">
                      ${state.isConnected ? 'Онлайн' : 'Офлайн'}
                    </div>
                  </div>

                  <div
                    style="
                      border-radius:16px;
                      padding:10px;
                      background:rgba(15,23,42,0.55);
                      border:1px solid rgba(255,255,255,0.08);
                    "
                  >
                    <div style="font-size:10px; font-weight:800; color:#94a3b8; text-transform:uppercase;">
                      Играчи
                    </div>
                    <div style="margin-top:5px; font-size:13px; font-weight:900; color:#f8fafc;">
                      ${state.queuedPlayers} / ${state.requiredPlayers}
                    </div>
                  </div>

                  <div
                    style="
                      border-radius:16px;
                      padding:10px;
                      background:rgba(15,23,42,0.55);
                      border:1px solid rgba(255,255,255,0.08);
                    "
                  >
                    <div style="font-size:10px; font-weight:800; color:#94a3b8; text-transform:uppercase;">
                      Таймер
                    </div>
                    <div style="margin-top:5px; font-size:13px; font-weight:900; color:#f8fafc;">
                      ${escapeHtml(formatRemainingSeconds(state.remainingMs))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div
              style="
                display:grid;
                grid-template-columns:repeat(5, minmax(0, 1fr));
                gap:14px;
              "
            >
              ${MATCH_STAKE_CARDS.map((card) => {
                const isSelected = card.stake === state.selectedStake
                const isDisabled = !canStartSearch

                return `
                  <button
                    type="button"
                    data-lobby-stake-card="${card.stake}"
                    ${isDisabled ? 'disabled' : ''}
                    style="
                      position:relative;
                      min-height:220px;
                      border-radius:24px;
                      padding:18px 16px 16px;
                      text-align:left;
                      border:1px solid ${
                        isSelected
                          ? 'rgba(255, 183, 28, 0.95)'
                          : 'rgba(255,255,255,0.12)'
                      };
                      background:
                        ${isSelected
                          ? 'radial-gradient(circle at 50% 0%, rgba(255,183,28,0.18), transparent 42%),'
                          : ''}
                        linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03)),
                        linear-gradient(180deg, rgba(8,28,60,0.92), rgba(6,23,48,0.97));
                      color:#f8fafc;
                      box-shadow:
                        0 16px 38px rgba(0,0,0,0.24),
                        ${isSelected ? '0 0 0 1px rgba(255,183,28,0.28)' : '0 0 0 0 transparent'};
                      cursor:${isDisabled ? 'default' : 'pointer'};
                      opacity:${isDisabled ? '0.68' : '1'};
                    "
                  >
                    ${
                      isSelected
                        ? `
                          <div
                            style="
                              position:absolute;
                              top:12px;
                              right:12px;
                              border-radius:999px;
                              padding:6px 9px;
                              background:linear-gradient(180deg, #ffd15b 0%, #ffad18 100%);
                              color:#0b1e3f;
                              font-size:10px;
                              font-weight:900;
                              text-transform:uppercase;
                              letter-spacing:0.08em;
                            "
                          >
                            Избрано
                          </div>
                        `
                        : ''
                    }

                    <div
                      style="
                        font-size:11px;
                        font-weight:800;
                        color:rgba(255,255,255,0.70);
                        text-transform:uppercase;
                        letter-spacing:0.10em;
                      "
                    >
                      Награда
                    </div>

                    <div
                      style="
                        margin-top:9px;
                        font-size:28px;
                        line-height:1;
                        font-weight:900;
                        color:#ffffff;
                      "
                    >
                      ${escapeHtml(formatAmount(card.prizeAmount))}
                    </div>

                    <div
                      style="
                        margin-top:18px;
                        font-size:11px;
                        font-weight:800;
                        color:rgba(255,255,255,0.70);
                        text-transform:uppercase;
                        letter-spacing:0.10em;
                      "
                    >
                      Вход
                    </div>

                    <div
                      style="
                        margin-top:9px;
                        font-size:24px;
                        line-height:1;
                        font-weight:900;
                        color:#ffbf38;
                      "
                    >
                      ${escapeHtml(formatAmount(card.stake))}
                    </div>

                    <div
                      style="
                        margin-top:20px;
                        font-size:12px;
                        line-height:1.42;
                        font-weight:700;
                        color:rgba(255,255,255,0.76);
                      "
                    >
                      ${state.isSearching && isSelected
                        ? 'Търсенето е стартирано за тази маса.'
                        : state.isConnected
                          ? 'Натисни, за да влезеш в търсене.'
                          : 'Изчакай връзката със сървъра.'}
                    </div>
                  </button>
                `
              }).join('')}
            </div>

            <div
              style="
                border-radius:22px;
                padding:18px 20px;
                background:
                  linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03)),
                  linear-gradient(180deg, rgba(8,28,60,0.90), rgba(6,23,48,0.96));
                border:1px solid rgba(255,255,255,0.12);
                box-shadow:0 20px 48px rgba(0,0,0,0.22);
                color:#f8fafc;
              "
            >
              <div
                style="
                  display:flex;
                  align-items:flex-start;
                  justify-content:space-between;
                  gap:16px;
                  flex-wrap:wrap;
                "
              >
                <div style="max-width:760px;">
                  <div
                    style="
                      font-size:20px;
                      line-height:1.1;
                      font-weight:900;
                      color:#ffffff;
                    "
                  >
                    ${escapeHtml(state.statusText)}
                  </div>

                  <div
                    style="
                      margin-top:7px;
                      font-size:13px;
                      line-height:1.45;
                      font-weight:600;
                      color:rgba(255,255,255,0.68);
                    "
                  >
                    ${
                      state.isSearching
                        ? 'Търсенето е активно. При напълване на масата играта ще стартира автоматично.'
                        : 'След натискане на каре ще се отвори страницата за изчакване на играчи.'
                    }
                  </div>
                </div>

                ${
                  state.isSearching
                    ? `
                      <button
                        type="button"
                        data-lobby-cancel-button="1"
                        style="
                          border:0;
                          border-radius:14px;
                          padding:12px 16px;
                          background:linear-gradient(180deg, #8b5cf6 0%, #6d28d9 100%);
                          color:#f5f3ff;
                          font-size:14px;
                          font-weight:900;
                          cursor:pointer;
                          box-shadow:0 12px 28px rgba(76,29,149,0.30);
                        "
                      >
                        Откажи търсенето
                      </button>
                    `
                    : ''
                }
              </div>

              ${
                state.errorText
                  ? `
                    <div
                      style="
                        margin-top:14px;
                        border-radius:14px;
                        background:rgba(127,29,29,0.30);
                        border:1px solid rgba(248,113,113,0.25);
                        color:#fecaca;
                        font-size:13px;
                        line-height:1.5;
                        padding:11px 13px;
                      "
                    >
                      ${escapeHtml(state.errorText)}
                    </div>
                  `
                  : ''
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  `

  const stakeButtons = root.querySelectorAll<HTMLButtonElement>('[data-lobby-stake-card]')

  stakeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (!canStartSearch) {
        return
      }

      const rawStake = Number(button.dataset.lobbyStakeCard)
      const selectedCard = MATCH_STAKE_CARDS.find((card) => card.stake === rawStake)

      if (!selectedCard) {
        return
      }

      options.onStakeChange(selectedCard.stake)
      options.onSearchClick()
    })
  })

  const cancelButton = root.querySelector<HTMLButtonElement>('[data-lobby-cancel-button="1"]')

  cancelButton?.addEventListener('click', () => {
    options.onCancelClick()
  })
}
