import type {
  RoomGameSnapshot,
  RoomSeatSnapshot,
  Seat,
  Team,
} from '../network/createGameServerClient'
import {
  ACTIVE_ROOM_TABLE_BACKGROUND,
  ACTIVE_ROOM_STAGE_HEIGHT,
  ACTIVE_ROOM_STAGE_WIDTH,
  escapeHtml,
} from './activeRoomShared'

type RenderMatchEndedScreenOptions = {
  root: HTMLDivElement
  game: RoomGameSnapshot
  seats: RoomSeatSnapshot[]
  localSeat: Seat
  stageScale: number
  scaledStageWidth: number
  scaledStageHeight: number
  prizeAmount?: number | null
  skipPrizeAnimation?: boolean
  countdownSeconds: number
  onReturnToLobby: () => void
  onStartNewGame?: () => void
  onSubmitPartnerRating?: (ratingValue: number) => void
  onReplayVote?: () => void
  onLeaveVote?: () => void
}

function getTeamBySeat(seat: Seat): Team {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

function getOpponentTeam(team: Team): Team {
  return team === 'A' ? 'B' : 'A'
}

function getPartnerSeat(seat: Seat): Seat {
  if (seat === 'bottom') return 'top'
  if (seat === 'top') return 'bottom'
  if (seat === 'left') return 'right'
  return 'left'
}

function getTeamScore(
  score: RoomGameSnapshot['score']['match'],
  team: Team,
): number {
  return team === 'A' ? score.teamA : score.teamB
}

function getSeatInitial(displayName: string): string {
  const trimmedName = displayName.trim()

  if (!trimmedName) {
    return '?'
  }

  return trimmedName.slice(0, 1).toUpperCase()
}

function renderLevelBadge(level: number | null | undefined): string {
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 1) return ''
  return `<div style="position:absolute;right:4px;bottom:4px;min-width:20px;height:20px;border-radius:999px;background:#000000;display:flex;align-items:center;justify-content:center;padding:0 3px;line-height:1;z-index:1;color:#ffffff;font-size:11px;font-weight:700;">${Math.trunc(level)}</div>`
}

const REPLAY_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`
const LEAVE_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`

function renderPlayerTile(seat: RoomSeatSnapshot, hasVotedReplay = false, hasVotedLeave = false): string {
  const displayName = seat.isOccupied ? seat.displayName : 'Свободно място'

  return `
    <div
      style="
        position:relative;
        min-width:0;
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        gap:11px;
        min-height:172px;
        padding:18px 14px 14px;
        border-radius:8px;
        background:rgba(18,18,18,0.92);
        border:1px solid rgba(250,204,21,0.28);
      "
    >
      ${hasVotedReplay ? `<div style="position:absolute;top:7px;left:7px;width:22px;height:22px;border-radius:50%;background:#22c55e;display:flex;align-items:center;justify-content:center;color:#ffffff;z-index:2;">${REPLAY_ICON_SVG}</div>` : ''}
      ${hasVotedLeave ? `<div style="position:absolute;top:7px;left:7px;width:22px;height:22px;border-radius:50%;background:#ef4444;display:flex;align-items:center;justify-content:center;color:#ffffff;z-index:2;">${LEAVE_ICON_SVG}</div>` : ''}
      <div style="position:relative;width:116px;height:116px;flex:0 0 116px;">
        <div
          style="
            width:100%;
            height:100%;
            border-radius:8px;
            overflow:hidden;
            background:rgba(10,10,10,0.86);
            border:1px solid rgba(250,204,21,0.22);
            display:flex;
            align-items:center;
            justify-content:center;
            color:#facc15;
            font-size:42px;
            font-weight:900;
          "
        >
          ${
            seat.avatarUrl
              ? `<img
                  src="${escapeHtml(seat.avatarUrl)}"
                  alt="${escapeHtml(displayName)}"
                  draggable="false"
                  style="width:100%;height:100%;object-fit:cover;display:block;"
                />`
              : escapeHtml(getSeatInitial(displayName))
          }
        </div>
        ${renderLevelBadge(seat.level)}
      </div>

      <div style="min-width:0;width:100%;text-align:center;">
        <div
          style="
            color:#f8fafc;
            font-size:15px;
            line-height:1.2;
            font-weight:800;
            white-space:nowrap;
            overflow:hidden;
            text-overflow:ellipsis;
          "
          title="${escapeHtml(displayName)}"
        >
          ${escapeHtml(displayName)}
        </div>
      </div>
    </div>
  `
}

function renderTeamPlayers(
  title: string,
  seats: RoomSeatSnapshot[],
  score: number,
  replayVotes: Seat[],
  leaveVotes: Seat[],
  footer = '',
): string {
  return `
    <div style="min-width:0;">
      <div
        style="
          margin-bottom:10px;
          display:flex;
          align-items:baseline;
          gap:10px;
        "
      >
        <div
          style="
            color:#facc15;
            font-size:30px;
            font-weight:900;
            letter-spacing:0.08em;
            text-transform:uppercase;
          "
        >
          ${escapeHtml(title)}
        </div>
        <div style="color:#f8fafc;font-size:30px;font-weight:900;line-height:1;">
          ${score}
        </div>
      </div>
      <div
        style="
          display:grid;
          grid-template-columns:repeat(2, minmax(0, 1fr));
          gap:10px;
        "
      >
        ${seats.map((s) => renderPlayerTile(s, replayVotes.includes(s.seat), leaveVotes.includes(s.seat))).join('')}
      </div>
      ${footer}
    </div>
  `
}

function renderPartnerRating(localSeat: Seat, seats: RoomSeatSnapshot[]): string {
  const partnerSeat = getPartnerSeat(localSeat)
  const partner = seats.find((seat) => seat.seat === partnerSeat) ?? null

  if (!partner || !partner.isOccupied) {
    return ''
  }

  return `
    <div data-partner-rating-panel="1" style="margin-top:14px;">
      <div style="font-size:12px;font-weight:900;color:rgba(226,232,240,0.60);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:9px;">
        Оцени партньор
      </div>
      <div style="display:flex;gap:8px;">
        ${[1, 2, 3, 4, 5, 6]
          .map((rating) => `
            <button
              type="button"
              data-partner-rating-value="${rating}"
              aria-label="Оцени с ${rating}"
              title="${rating}/6"
              style="
                width:28px;
                height:28px;
                border-radius:50%;
                border:0;
                background:#facc15;
                color:#101010;
                font-size:13px;
                font-weight:900;
                cursor:pointer;
                display:flex;
                align-items:center;
                justify-content:center;
                flex-shrink:0;
              "
            >
              ${rating}
            </button>
          `)
          .join('')}
      </div>
    </div>
  `
}

function renderMatchEndedPanel(
  game: RoomGameSnapshot,
  seats: RoomSeatSnapshot[],
  localSeat: Seat,
  prizeAmount?: number | null,
  _onReplayVote?: () => void,
  countdownSeconds = 120,
  skipPrizeAnimation = false,
): string {
  const localTeam = getTeamBySeat(localSeat)
  const opponentTeam = getOpponentTeam(localTeam)
  const matchEnded = game.matchEnded
  const finalScore = matchEnded?.finalScore ?? game.score.match
  const ourScore = getTeamScore(finalScore, localTeam)
  const theirScore = getTeamScore(finalScore, opponentTeam)
  const winnerTeam = matchEnded?.winnerTeam ?? null
  const resultLabel =
    winnerTeam === null
      ? 'КРАЙ НА ИГРАТА'
      : winnerTeam === localTeam
        ? 'ПОБЕДИТЕЛ'
        : 'ГУБЕЩ'
  const resultColor = winnerTeam === null
    ? '#e2e8f0'
    : winnerTeam === localTeam
      ? '#facc15'
      : '#cbd5e1'
  const ourSeats = seats.filter((seat) => getTeamBySeat(seat.seat) === localTeam)
  const theirSeats = seats.filter((seat) => getTeamBySeat(seat.seat) === opponentTeam)
  const replayVotes = game.matchEnded?.replayVotes ?? []
  const leaveVotes = game.matchEnded?.leaveVotes ?? []

  return `
    <section
      style="
        width:min(940px, calc(100vw - 44px));
        border-radius:14px;
        background:linear-gradient(180deg, rgba(22,22,22,0.98) 0%, rgba(8,8,8,0.99) 100%);
        border:3px solid rgba(250,204,21,0.82);
        box-shadow:0 30px 80px rgba(2,6,23,0.42);
        color:#f8fafc;
        overflow:hidden;
      "
    >
      <div style="padding:26px 32px 30px;">
        <div
          style="
            display:flex;
            align-items:center;
            justify-content:center;
            margin-bottom:16px;
            text-align:center;
          "
        >
          <div
            style="
              color:${resultColor};
              font-size:36px;
              line-height:1.08;
              font-weight:900;
              letter-spacing:0.04em;
            "
          >
            ${resultLabel}${winnerTeam === localTeam && prizeAmount && prizeAmount > 0 ? `<span data-prize-counter="1" style="margin-left:16px;color:#22c55e;">${skipPrizeAnimation ? `+${prizeAmount.toLocaleString('bg-BG')}` : '+0'}</span>` : ''}
          </div>
        </div>
        <div style="height:2px;background:linear-gradient(90deg, transparent 0%, #facc15 30%, #facc15 70%, transparent 100%);margin-bottom:20px;border-radius:1px;"></div>

        <div
          style="
            display:grid;
            grid-template-columns:minmax(0,1fr) 2px minmax(0,1fr);
            column-gap:18px;
            align-items:stretch;
          "
        >
          ${renderTeamPlayers('Ние', ourSeats, ourScore, replayVotes, leaveVotes, renderPartnerRating(localSeat, seats))}
          <div style="background:linear-gradient(180deg,transparent 0%,#facc15 25%,#facc15 75%,transparent 100%);border-radius:1px;"></div>
          ${renderTeamPlayers('Вие', theirSeats, theirScore, replayVotes, leaveVotes)}
        </div>

        <div
          style="
            margin-top:24px;
            display:flex;
            align-items:center;
            justify-content:center;
            gap:12px;
            flex-wrap:wrap;
          "
        >
          <button
            type="button"
            data-match-ended-lobby-button="1"
            style="
              height:52px;
              min-width:168px;
              border:1px solid rgba(250,204,21,0.58);
              border-radius:8px;
              padding:0 22px;
              background:rgba(10,10,10,0.78);
              color:#f8fafc;
              font-family:Inter, system-ui, sans-serif;
              font-size:16px;
              font-weight:900;
              cursor:pointer;
              box-shadow:0 16px 34px rgba(0,0,0,0.18);
            "
          >
            Към лобито
          </button>

          <button
            type="button"
            data-match-ended-replay-button="1"
            style="
              height:52px;
              min-width:168px;
              border:1px solid rgba(250,204,21,0.58);
              border-radius:8px;
              padding:0 22px;
              background:rgba(10,10,10,0.78);
              color:#f8fafc;
              font-family:Inter, system-ui, sans-serif;
              font-size:16px;
              font-weight:900;
              cursor:pointer;
              box-shadow:0 16px 34px rgba(0,0,0,0.18);
              display:flex;
              align-items:center;
              justify-content:center;
              gap:8px;
            "
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            Преиграй
          </button>

          <button
            type="button"
            data-match-ended-new-game-button="1"
            style="
              height:52px;
              min-width:168px;
              border:0;
              border-radius:8px;
              padding:0 22px;
              background:linear-gradient(180deg, #facc15 0%, #eab308 100%);
              color:#101010;
              font-family:Inter, system-ui, sans-serif;
              font-size:16px;
              font-weight:900;
              cursor:pointer;
              box-shadow:0 16px 34px rgba(0,0,0,0.26);
            "
          >
            Нова игра
          </button>
        </div>

        <div style="display:flex;justify-content:flex-end;margin-top:14px;">
          <div
            data-match-ended-countdown="1"
            style="
              font-size:13px;
              font-weight:900;
              color:${countdownSeconds <= 30 ? '#f87171' : 'rgba(226,232,240,0.44)'};
              font-variant-numeric:tabular-nums;
            "
          >${countdownSeconds}с</div>
        </div>
      </div>
    </section>
  `
}

export function renderMatchEndedScreen(options: RenderMatchEndedScreenOptions): void {
  const {
    root,
    game,
    seats,
    localSeat,
    stageScale,
    scaledStageWidth,
    scaledStageHeight,
    prizeAmount,
    skipPrizeAnimation = false,
    countdownSeconds,
    onReturnToLobby,
    onStartNewGame,
    onSubmitPartnerRating,
    onReplayVote,
    onLeaveVote,
  } = options

  root.innerHTML = `
    <div
      style="
        position:relative;
        min-height:100vh;
        width:100%;
        box-sizing:border-box;
        display:flex;
        align-items:center;
        justify-content:center;
        overflow:hidden;
        background:${ACTIVE_ROOM_TABLE_BACKGROUND};
        font-family:Inter, system-ui, sans-serif;
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
            top:50%;
            width:${ACTIVE_ROOM_STAGE_WIDTH}px;
            height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
            transform:translate(-50%, -50%) scale(${stageScale});
            transform-origin:center center;
          "
        >
          <div
            style="
              position:absolute;
              inset:0;
              display:flex;
              align-items:center;
              justify-content:center;
              padding:42px 24px;
              box-sizing:border-box;
            "
          >
            ${renderMatchEndedPanel(game, seats, localSeat, prizeAmount, onReplayVote, countdownSeconds, skipPrizeAnimation)}
          </div>
        </div>
      </div>
    </div>
  `

  if (!skipPrizeAnimation) {
    const counterEl = root.querySelector<HTMLElement>('[data-prize-counter="1"]')
    if (counterEl && prizeAmount && prizeAmount > 0) {
      const el = counterEl
      const duration = 1500
      const startTime = performance.now()
      const target = prizeAmount

      function tick(now: number): void {
        const elapsed = now - startTime
        const t = Math.min(elapsed / duration, 1)
        const eased = 1 - Math.pow(1 - t, 3)
        const current = Math.round(eased * target)
        el.textContent = `+${current.toLocaleString('bg-BG')}`
        if (t < 1) {
          requestAnimationFrame(tick)
        }
      }

      requestAnimationFrame(tick)
    }
  }

  root
    .querySelector<HTMLButtonElement>('[data-match-ended-lobby-button="1"]')
    ?.addEventListener('click', onReturnToLobby)

  root
    .querySelector<HTMLButtonElement>('[data-match-ended-replay-button="1"]')
    ?.addEventListener('click', onReplayVote ?? onStartNewGame ?? onReturnToLobby)

  root
    .querySelector<HTMLButtonElement>('[data-match-ended-new-game-button="1"]')
    ?.addEventListener('click', () => {
      onLeaveVote?.()
      ;(onStartNewGame ?? onReturnToLobby)()
    })

  root
    .querySelectorAll<HTMLButtonElement>('[data-partner-rating-value]')
    .forEach((button) => {
      button.addEventListener('click', () => {
        const ratingValue = Number(button.dataset.partnerRatingValue)

        if (!Number.isInteger(ratingValue)) {
          return
        }

        onSubmitPartnerRating?.(ratingValue)

        root
          .querySelectorAll<HTMLButtonElement>('[data-partner-rating-value]')
          .forEach((ratingButton) => {
            ratingButton.disabled = true
            ratingButton.style.cursor = 'default'
            ratingButton.style.opacity = ratingButton === button ? '1' : '0.45'
          })

        const panel = root.querySelector<HTMLElement>('[data-partner-rating-panel="1"]')

        panel?.insertAdjacentHTML(
          'beforeend',
          '<div style="width:100%;color:#bef264;font-size:13px;font-weight:900;text-align:right;">Оценката е изпратена.</div>',
        )
      })
    })
}
