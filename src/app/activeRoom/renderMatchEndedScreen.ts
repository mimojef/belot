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
  onReturnToLobby: () => void
  onStartNewGame?: () => void
}

function getTeamBySeat(seat: Seat): Team {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

function getOpponentTeam(team: Team): Team {
  return team === 'A' ? 'B' : 'A'
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

function renderPlayerTile(seat: RoomSeatSnapshot): string {
  const displayName = seat.isOccupied ? seat.displayName : 'Свободно място'

  return `
    <div
      style="
        min-width:0;
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        gap:11px;
        min-height:172px;
        padding:18px 14px 14px;
        border-radius:8px;
        background:rgba(255,255,255,0.055);
        border:1px solid rgba(255,255,255,0.10);
      "
    >
      <div
        style="
          width:116px;
          height:116px;
          flex:0 0 116px;
          border-radius:8px;
          overflow:hidden;
          background:rgba(15,23,42,0.72);
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
): string {
  return `
    <div style="min-width:0;">
      <div
        style="
          margin-bottom:10px;
          color:#facc15;
          font-size:13px;
          font-weight:900;
          letter-spacing:0.08em;
          text-transform:uppercase;
        "
      >
        ${escapeHtml(title)}
      </div>
      <div
        style="
          display:grid;
          grid-template-columns:repeat(2, minmax(0, 1fr));
          gap:10px;
        "
      >
        ${seats.map(renderPlayerTile).join('')}
      </div>
    </div>
  `
}

function renderMatchEndedPanel(
  game: RoomGameSnapshot,
  seats: RoomSeatSnapshot[],
  localSeat: Seat,
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

  return `
    <section
      style="
        width:min(940px, calc(100vw - 44px));
        border-radius:14px;
        background:linear-gradient(180deg, rgba(15,35,72,0.98) 0%, rgba(11,28,58,0.98) 100%);
        border:1px solid rgba(250,204,21,0.82);
        box-shadow:0 30px 80px rgba(2,6,23,0.42);
        color:#f8fafc;
        overflow:hidden;
      "
    >
      <div
        style="
          padding:28px 32px 22px;
          display:grid;
          grid-template-columns:minmax(0, 1fr) auto minmax(0, 1fr);
          align-items:end;
          gap:20px;
          border-bottom:1px solid rgba(250,204,21,0.22);
          background:rgba(2,6,23,0.22);
        "
      >
        <div style="min-width:0;text-align:right;">
          <div style="color:rgba(226,232,240,0.76);font-size:14px;font-weight:900;letter-spacing:0.10em;text-transform:uppercase;">
            НИЕ
          </div>
          <div style="margin-top:4px;color:#f8fafc;font-size:64px;line-height:0.95;font-weight:900;">
            ${ourScore}
          </div>
        </div>

        <div
          style="
            color:#facc15;
            font-size:42px;
            line-height:1;
            font-weight:900;
            padding-bottom:8px;
          "
        >
          :
        </div>

        <div style="min-width:0;text-align:left;">
          <div style="color:rgba(226,232,240,0.76);font-size:14px;font-weight:900;letter-spacing:0.10em;text-transform:uppercase;">
            ВИЕ
          </div>
          <div style="margin-top:4px;color:#f8fafc;font-size:64px;line-height:0.95;font-weight:900;">
            ${theirScore}
          </div>
        </div>
      </div>

      <div style="padding:26px 32px 30px;">
        <div
          style="
            display:flex;
            align-items:center;
            justify-content:flex-start;
            margin-bottom:24px;
          "
        >
          <div>
            <div
              style="
                color:${resultColor};
                font-size:36px;
                line-height:1.08;
                font-weight:900;
                letter-spacing:0.04em;
              "
            >
              ${resultLabel}
            </div>
            <div
              style="
                margin-top:7px;
                color:rgba(226,232,240,0.82);
                font-size:16px;
                font-weight:700;
              "
            >
              ${matchEnded ? `Игра до ${matchEnded.targetScore}` : 'Финален резултат'}
            </div>
          </div>
        </div>

        <div
          style="
            display:grid;
            grid-template-columns:repeat(2, minmax(0, 1fr));
            gap:18px;
          "
        >
          ${renderTeamPlayers('Ние', ourSeats)}
          ${renderTeamPlayers('Вие', theirSeats)}
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
              border:1px solid rgba(250,204,21,0.42);
              border-radius:8px;
              padding:0 22px;
              background:rgba(15,23,42,0.72);
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
            data-match-ended-new-game-button="1"
            style="
              height:52px;
              min-width:168px;
              border:0;
              border-radius:8px;
              padding:0 22px;
              background:linear-gradient(180deg, #facc15 0%, #eab308 100%);
              color:#172554;
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
    onReturnToLobby,
    onStartNewGame,
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
            ${renderMatchEndedPanel(game, seats, localSeat)}
          </div>
        </div>
      </div>
    </div>
  `

  root
    .querySelector<HTMLButtonElement>('[data-match-ended-lobby-button="1"]')
    ?.addEventListener('click', onReturnToLobby)

  root
    .querySelector<HTMLButtonElement>('[data-match-ended-new-game-button="1"]')
    ?.addEventListener('click', onStartNewGame ?? onReturnToLobby)
}
