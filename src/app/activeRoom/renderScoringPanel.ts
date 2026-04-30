import type {
  RoomGameSnapshot,
  RoomTeamPointsSnapshot,
  RoomWinningBidSnapshot,
  Seat,
} from '../network/createGameServerClient'
import {
  ACTIVE_ROOM_STAGE_HEIGHT,
  ACTIVE_ROOM_STAGE_WIDTH,
  escapeHtml,
} from './activeRoomShared'
import { renderScoreHud } from './renderScoreHud'

const TABLE_BACKGROUND = `
  radial-gradient(circle at center, rgba(74,222,128,0.18) 0%, rgba(34,197,94,0.10) 34%, rgba(21,128,61,0.00) 58%),
  linear-gradient(180deg, rgba(22,101,52,0.98) 0%, rgba(17,94,39,0.99) 100%)
`

const LABEL_COLUMN_WIDTH_PX = 108
const TABLE_GRID_COLUMNS = `${LABEL_COLUMN_WIDTH_PX}px minmax(0, 1fr) minmax(0, 1fr)`

type RenderScoringScreenOptions = {
  root: HTMLDivElement
  game: RoomGameSnapshot
  localSeat: Seat
  winningBid: NonNullable<RoomWinningBidSnapshot> | null
  stageScale: number
  scaledStageWidth: number
  scaledStageHeight: number
}

function isTeamASeat(seat: Seat): boolean {
  return seat === 'bottom' || seat === 'top'
}

function getPerspectivePoints(
  score: RoomTeamPointsSnapshot,
  localSeat: Seat,
): {
  ourPoints: number
  theirPoints: number
} {
  return isTeamASeat(localSeat)
    ? {
        ourPoints: score.teamA,
        theirPoints: score.teamB,
      }
    : {
        ourPoints: score.teamB,
        theirPoints: score.teamA,
      }
}

function formatSuitLabel(suit: 'clubs' | 'diamonds' | 'hearts' | 'spades' | null): string {
  if (suit === 'clubs') return 'Спатия'
  if (suit === 'diamonds') return 'Каро'
  if (suit === 'hearts') return 'Купа'
  if (suit === 'spades') return 'Пика'
  return '—'
}

function formatBidLabel(
  winningBid: NonNullable<RoomWinningBidSnapshot> | null,
): string {
  if (winningBid === null) {
    return 'Няма обява'
  }

  if (winningBid.contract === 'all-trumps') {
    return 'Всичко коз'
  }

  if (winningBid.contract === 'no-trumps') {
    return 'Без коз'
  }

  return formatSuitLabel(winningBid.trumpSuit)
}

function getBidOwnerLabel(
  winningBid: NonNullable<RoomWinningBidSnapshot> | null,
  localSeat: Seat,
): string {
  if (winningBid === null) {
    return '—'
  }

  return isTeamASeat(winningBid.seat) === isTeamASeat(localSeat)
    ? 'НИЕ'
    : 'ВИЕ'
}

function getBidMultiplierLabel(
  winningBid: NonNullable<RoomWinningBidSnapshot> | null,
): string {
  if (winningBid?.redoubled) return ' x4'
  if (winningBid?.doubled) return ' x2'
  return ''
}

function resolveBidIcon(
  winningBid: NonNullable<RoomWinningBidSnapshot> | null,
): {
  symbol: string
  color: string
} {
  if (winningBid === null) {
    return {
      symbol: '•',
      color: '#101418',
    }
  }

  if (winningBid.contract === 'all-trumps') {
    return {
      symbol: 'J',
      color: '#cc2233',
    }
  }

  if (winningBid.contract === 'no-trumps') {
    return {
      symbol: 'A',
      color: '#101418',
    }
  }

  if (winningBid.trumpSuit === 'hearts') {
    return {
      symbol: '♥',
      color: '#cc2233',
    }
  }

  if (winningBid.trumpSuit === 'diamonds') {
    return {
      symbol: '♦',
      color: '#cc2233',
    }
  }

  if (winningBid.trumpSuit === 'spades') {
    return {
      symbol: '♠',
      color: '#101418',
    }
  }

  return {
    symbol: '♣',
    color: '#101418',
  }
}

function formatBonusValue(value: number): string {
  return value > 0 ? `+${value}` : '0'
}

function getCountdownSeconds(timerDeadlineAt: number | null): number {
  if (timerDeadlineAt === null) {
    return 5
  }

  return Math.max(0, Math.ceil((timerDeadlineAt - Date.now()) / 1000))
}

function renderMatrixHeaderRow(): string {
  return `
    <div
      style="
        display:grid;
        grid-template-columns:${TABLE_GRID_COLUMNS};
        align-items:end;
        min-height:58px;
        border-bottom:1px solid rgba(232, 178, 78, 0.78);
        background:rgba(255,255,255,0.025);
      "
    >
      <div></div>

      <div
        style="
          display:flex;
          align-items:end;
          justify-content:center;
          padding-bottom:8px;
          text-align:center;
          color:#f0b43f;
          font-size:24px;
          font-weight:700;
        "
      >
        НИЕ
      </div>

      <div
        style="
          display:flex;
          align-items:end;
          justify-content:center;
          padding-bottom:8px;
          text-align:center;
          color:#f0b43f;
          font-size:24px;
          font-weight:700;
        "
      >
        ВИЕ
      </div>
    </div>
  `
}

function renderMatrixRow(
  label: string,
  leftValue: string,
  rightValue: string,
  options: {
    minHeight?: number
    valueColor?: string
  } = {},
): string {
  const {
    minHeight = 54,
    valueColor = '#f8fafc',
  } = options

  return `
    <div
      style="
        display:grid;
        grid-template-columns:${TABLE_GRID_COLUMNS};
        align-items:stretch;
        min-height:${minHeight}px;
        border-bottom:1px solid rgba(232, 178, 78, 0.78);
        background:rgba(255,255,255,0.03);
      "
    >
      <div
        style="
          padding:0 14px 0 16px;
          color:#f7f3ea;
          font-size:18px;
          font-weight:500;
          text-transform:uppercase;
          display:flex;
          align-items:center;
        "
      >
        ${escapeHtml(label)}
      </div>

      <div
        style="
          display:flex;
          align-items:center;
          justify-content:center;
          padding:0 10px;
          text-align:center;
          color:${valueColor};
          font-size:18px;
          font-weight:700;
        "
      >
        ${escapeHtml(leftValue)}
      </div>

      <div
        style="
          display:flex;
          align-items:center;
          justify-content:center;
          padding:0 10px;
          text-align:center;
          color:${valueColor};
          font-size:18px;
          font-weight:700;
        "
      >
        ${escapeHtml(rightValue)}
      </div>
    </div>
  `
}

function renderOutcomeRow(outcomeShortLabel: string): string {
  return `
    <div
      style="
        display:grid;
        grid-template-columns:${TABLE_GRID_COLUMNS};
        align-items:center;
        min-height:48px;
        background:rgba(255,255,255,0.03);
      "
    >
      <div
        style="
          padding:0 14px 0 16px;
          color:#f7f3ea;
          font-size:18px;
          font-weight:500;
          text-transform:uppercase;
          display:flex;
          align-items:center;
        "
      >
        Изход
      </div>

      <div
        style="
          grid-column:2 / 4;
          display:flex;
          align-items:center;
          justify-content:center;
          color:#f8fafc;
          font-size:18px;
          font-weight:700;
        "
      >
        ${escapeHtml(outcomeShortLabel)}
      </div>
    </div>
  `
}

function renderResultRow(ourPoints: number, theirPoints: number): string {
  return `
    <div
      style="
        display:grid;
        grid-template-columns:${TABLE_GRID_COLUMNS};
        align-items:center;
        min-height:54px;
        background:#e7a321;
        color:#fff7e6;
        font-weight:800;
      "
    >
      <div
        style="
          padding:0 14px 0 16px;
          font-size:22px;
          text-transform:uppercase;
          display:flex;
          align-items:center;
        "
      >
        Резултат
      </div>

      <div
        style="
          display:flex;
          align-items:center;
          justify-content:center;
          font-size:22px;
        "
      >
        ${ourPoints}
      </div>

      <div
        style="
          display:flex;
          align-items:center;
          justify-content:center;
          font-size:22px;
        "
      >
        ${theirPoints}
      </div>
    </div>
  `
}

function renderScoringPanelHtml(
  game: RoomGameSnapshot,
  localSeat: Seat,
  fallbackWinningBid: NonNullable<RoomWinningBidSnapshot> | null,
): string {
  const scoring = game.scoring

  if (scoring === null) {
    return ''
  }

  const winningBid = scoring.winningBid ?? fallbackWinningBid
  const bidIcon = resolveBidIcon(winningBid)
  const bidLabel = formatBidLabel(winningBid)
  const bidOwnerLabel = getBidOwnerLabel(winningBid, localSeat)
  const bidMultiplierLabel = getBidMultiplierLabel(winningBid)
  const countdownSeconds = getCountdownSeconds(game.timerDeadlineAt)
  const belote = getPerspectivePoints(scoring.belotePoints, localSeat)
  const declarations = getPerspectivePoints(scoring.declarationPoints, localSeat)
  const rawHands = getPerspectivePoints(scoring.rawHandPoints, localSeat)
  const sumPoints = getPerspectivePoints(scoring.sumPoints, localSeat)
  const officialRoundPoints = getPerspectivePoints(scoring.officialRoundPoints, localSeat)

  return `
    <section
      style="
        width:100%;
        max-width:730px;
        margin:0 auto;
        background:rgba(34, 70, 92, 0.97);
        border:2px solid #dca33a;
        border-radius:14px;
        overflow:hidden;
        box-shadow:0 18px 40px rgba(0,0,0,0.22);
        backdrop-filter:blur(3px);
      "
    >
      <div
        style="
          padding:10px 18px 0 18px;
          display:flex;
          align-items:center;
          justify-content:center;
          gap:10px;
          color:#faf7ef;
          font-size:22px;
          font-weight:700;
          text-transform:uppercase;
        "
      >
        <div
          style="
            width:46px;
            height:46px;
            border-radius:50%;
            background:rgba(255,255,255,0.95);
            display:flex;
            align-items:center;
            justify-content:center;
            font-size:34px;
            line-height:1;
            color:${bidIcon.color};
            box-shadow:0 4px 12px rgba(0,0,0,0.14);
            flex:0 0 auto;
          "
        >
          ${escapeHtml(bidIcon.symbol)}
        </div>

        <div>
          ${escapeHtml(bidLabel.toUpperCase())}
          ${bidOwnerLabel !== '—' ? ` (${escapeHtml(bidOwnerLabel)})` : ''}
          ${escapeHtml(bidMultiplierLabel)}
        </div>
      </div>

      <div style="padding:10px 0 0 0;">
        <div style="position:relative;">
          <div
            style="
              position:absolute;
              top:0;
              bottom:0;
              left:${LABEL_COLUMN_WIDTH_PX}px;
              width:1px;
              background:rgba(231, 176, 72, 0.62);
              pointer-events:none;
              z-index:2;
            "
          ></div>

          <div
            style="
              position:absolute;
              top:0;
              bottom:0;
              left:calc(${LABEL_COLUMN_WIDTH_PX}px + ((100% - ${LABEL_COLUMN_WIDTH_PX}px) / 2));
              width:1px;
              background:rgba(231, 176, 72, 0.62);
              pointer-events:none;
              z-index:2;
            "
          ></div>

          ${renderMatrixHeaderRow()}
          ${renderMatrixRow('Белоти', formatBonusValue(belote.ourPoints), formatBonusValue(belote.theirPoints), {
            minHeight: 60,
            valueColor: '#f4b63a',
          })}
          ${renderMatrixRow('Обяви', formatBonusValue(declarations.ourPoints), formatBonusValue(declarations.theirPoints), {
            minHeight: 60,
            valueColor: '#f4b63a',
          })}
          ${renderMatrixRow('Ръце', String(rawHands.ourPoints), String(rawHands.theirPoints))}
          ${renderMatrixRow('Сбор', String(sumPoints.ourPoints), String(sumPoints.theirPoints))}
        </div>

        ${renderOutcomeRow(scoring.outcomeShortLabel)}
        ${renderResultRow(officialRoundPoints.ourPoints, officialRoundPoints.theirPoints)}
      </div>

      <div
        style="
          position:relative;
          min-height:52px;
          display:flex;
          align-items:center;
          justify-content:center;
          padding:0 88px 0 18px;
          color:#f4f7fb;
          font-size:18px;
          font-weight:500;
          background:rgba(18, 39, 54, 0.72);
          border-top:1px solid rgba(232, 178, 78, 0.52);
        "
      >
        <div>
          ${escapeHtml(scoring.outcomeLabel)}
        </div>

        <div
          data-scoring-countdown="1"
          style="
            position:absolute;
            right:18px;
            bottom:12px;
            color:#f4b63a;
            font-size:16px;
            font-weight:800;
            letter-spacing:0.02em;
            white-space:nowrap;
          "
        >
          ${countdownSeconds} сек.
        </div>
      </div>
    </section>
  `
}

export function renderScoringScreen(options: RenderScoringScreenOptions): void {
  const {
    root,
    game,
    localSeat,
    winningBid,
    stageScale,
    scaledStageWidth,
    scaledStageHeight,
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
        background:${TABLE_BACKGROUND};
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
              position:relative;
              width:100%;
              height:100%;
              overflow:visible;
            "
          >
            <div
              style="
                position:absolute;
                inset:0;
                display:flex;
                align-items:center;
                justify-content:center;
                padding:48px 24px;
                box-sizing:border-box;
              "
            >
              ${renderScoringPanelHtml(game, localSeat, winningBid)}
            </div>
          </div>
        </div>
      </div>

      ${renderScoreHud({
        game,
        localSeat,
        winningBid: game.scoring?.winningBid ?? winningBid,
        stageScale,
      })}
    </div>
  `
}
