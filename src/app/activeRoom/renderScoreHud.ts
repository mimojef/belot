import type {
  RoomGameSnapshot,
  RoomWinningBidSnapshot,
  Seat,
} from '../network/createGameServerClient'
import { escapeHtml } from './activeRoomShared'

const SCORE_HUD_INTERNAL_OFFSET = 18

type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'

type RenderScoreHudOptions = {
  game: RoomGameSnapshot
  localSeat: Seat
  winningBid: NonNullable<RoomWinningBidSnapshot> | null
  stageScale: number
}

function isTeamASeat(seat: Seat): boolean {
  return seat === 'bottom' || seat === 'top'
}

function formatSeatForLocalPerspective(seat: Seat | null, localSeat: Seat): string {
  if (seat === null) return '—'
  if (seat === localSeat) return 'ТИ'

  const partnerSeat: Seat = localSeat === 'bottom'
    ? 'top'
    : localSeat === 'top'
      ? 'bottom'
      : localSeat === 'right'
        ? 'left'
        : 'right'

  if (seat === partnerSeat) return 'ПАРТНЬОР'
  if (seat === 'top') return 'ГОРЕ'
  if (seat === 'left') return 'ЛЯВО'
  if (seat === 'right') return 'ДЯСНО'
  return 'ДОЛУ'
}

function formatSuit(suit: Suit | null): string {
  if (suit === 'clubs') return 'Спатия'
  if (suit === 'diamonds') return 'Каро'
  if (suit === 'hearts') return 'Купа'
  if (suit === 'spades') return 'Пика'
  return '—'
}

function formatBidType(
  winningBid: NonNullable<RoomWinningBidSnapshot> | null,
): string {
  if (winningBid === null) return 'Няма обява'
  if (winningBid.contract === 'all-trumps') return 'Всичко коз'
  if (winningBid.contract === 'no-trumps') return 'Без коз'
  if (winningBid.contract === 'suit') return formatSuit(winningBid.trumpSuit)
  return 'Няма обява'
}

function getBidMultiplierLabel(
  winningBid: NonNullable<RoomWinningBidSnapshot> | null,
): string {
  if (winningBid?.redoubled) return ' x4'
  if (winningBid?.doubled) return ' x2'
  return ''
}

function getBidIconMarkup(
  winningBid: NonNullable<RoomWinningBidSnapshot> | null,
): string {
  if (winningBid === null) return ''

  if (winningBid.contract === 'all-trumps') {
    return `
      <img
        src="/images/ui/score-hud/plain-red-J.png"
        alt=""
        draggable="false"
        style="
          width:45px;
          height:45px;
          object-fit:contain;
          display:block;
          user-select:none;
          pointer-events:none;
        "
      />
    `
  }

  if (winningBid.contract === 'no-trumps') {
    return `
      <img
        src="/images/ui/score-hud/plain-black-A.png"
        alt=""
        draggable="false"
        style="
          width:45px;
          height:45px;
          object-fit:contain;
          display:block;
          user-select:none;
          pointer-events:none;
        "
      />
    `
  }

  if (winningBid.contract !== 'suit') return ''

  if (winningBid.trumpSuit === 'clubs') {
    return '<span style="color:#111111; font-size:52px; line-height:1;">♣</span>'
  }

  if (winningBid.trumpSuit === 'diamonds') {
    return '<span style="color:#c62828; font-size:52px; line-height:1;">♦</span>'
  }

  if (winningBid.trumpSuit === 'hearts') {
    return '<span style="color:#c62828; font-size:52px; line-height:1;">♥</span>'
  }

  if (winningBid.trumpSuit === 'spades') {
    return '<span style="color:#111111; font-size:52px; line-height:1;">♠</span>'
  }

  return ''
}

function getScoreForLocalPerspective(game: RoomGameSnapshot, localSeat: Seat): {
  ourScore: number
  theirScore: number
} {
  const teamAScore = game.score.match.teamA
  const teamBScore = game.score.match.teamB

  return isTeamASeat(localSeat)
    ? { ourScore: teamAScore, theirScore: teamBScore }
    : { ourScore: teamBScore, theirScore: teamAScore }
}

export function renderScoreHud(options: RenderScoreHudOptions): string {
  const { game, localSeat, winningBid, stageScale } = options
  const { ourScore, theirScore } = getScoreForLocalPerspective(game, localSeat)
  const bidLabel = formatBidType(winningBid)
  const bidIconMarkup = getBidIconMarkup(winningBid)
  const showIcon = bidIconMarkup.length > 0
  const bidMultiplierLabel = getBidMultiplierLabel(winningBid)
  const bidOwnerLabel = winningBid
    ? formatSeatForLocalPerspective(winningBid.seat, localSeat)
    : '—'
  const bidSummary = `${bidLabel}${bidMultiplierLabel}: ${bidOwnerLabel}`

  return `
    <div
      data-active-room-score-hud="1"
      style="
        position:fixed;
        top:${5 - SCORE_HUD_INTERNAL_OFFSET * stageScale}px;
        left:${5 - SCORE_HUD_INTERNAL_OFFSET * stageScale}px;
        width:0;
        height:0;
        z-index:8;
        pointer-events:none;
        transform:scale(${stageScale});
        transform-origin:top left;
        font-family:Inter, system-ui, sans-serif;
      "
    >
      <div
        style="
          position:absolute;
          top:${SCORE_HUD_INTERNAL_OFFSET}px;
          left:${SCORE_HUD_INTERNAL_OFFSET}px;
          width:300px;
          pointer-events:none;
        "
      >
        <div
          style="
            border-radius:12px;
            overflow:hidden;
            background: linear-gradient(180deg, rgba(13, 41, 73, 0.96) 0%, rgba(9, 31, 58, 0.96) 100%);
            border:1px solid rgba(255,255,255,0.12);
            box-shadow:
              0 18px 36px rgba(0,0,0,0.24),
              inset 0 1px 0 rgba(255,255,255,0.05);
            backdrop-filter: blur(10px);
          "
        >
          <div
            style="
              padding:12px 14px 10px 14px;
              font-size:11px;
              font-weight:900;
              letter-spacing:0.14em;
              text-transform:uppercase;
              color:rgba(239,245,255,0.82);
              border-bottom:1px solid rgba(255,255,255,0.08);
            "
          >
            Резултат
          </div>

          <div
            style="
              display:grid;
              grid-template-columns: 1fr 40px 1fr;
              align-items:stretch;
              min-height:112px;
            "
          >
            <div
              style="
                text-align:center;
                padding:12px 10px 16px 10px;
                border-right:1px solid rgba(255,255,255,0.10);
              "
            >
              <div
                style="
                  font-size:18px;
                  font-weight:500;
                  letter-spacing:0.04em;
                  color:#ffffff;
                  margin-bottom:12px;
                "
              >
                НИЕ
              </div>

              <div
                style="
                  font-size:56px;
                  line-height:1;
                  font-weight:300;
                  color:#ffffff;
                "
              >
                ${ourScore}
              </div>
            </div>

            <div
              style="
                display:flex;
                align-items:center;
                justify-content:center;
                color:#ffffff;
                font-size:26px;
                font-weight:700;
                border-right:1px solid rgba(255,255,255,0.10);
              "
            >
              :
            </div>

            <div
              style="
                text-align:center;
                padding:12px 10px 16px 10px;
              "
            >
              <div
                style="
                  font-size:18px;
                  font-weight:500;
                  letter-spacing:0.04em;
                  color:#ffffff;
                  margin-bottom:12px;
                "
              >
                ВИЕ
              </div>

              <div
                style="
                  font-size:56px;
                  line-height:1;
                  font-weight:300;
                  color:#ffffff;
                "
              >
                ${theirScore}
              </div>
            </div>
          </div>

          <div
            style="
              display:grid;
              grid-template-columns:${showIcon ? '68px 1fr' : '1fr'};
              align-items:stretch;
              min-height:56px;
              background: linear-gradient(180deg, rgba(247, 181, 34, 0.98) 0%, rgba(236, 168, 26, 0.98) 100%);
              border-top:1px solid rgba(255,255,255,0.08);
            "
          >
            ${
              showIcon
                ? `
              <div
                style="
                  display:flex;
                  align-items:center;
                  justify-content:center;
                  border-right:1px solid rgba(0,0,0,0.12);
                  line-height:1;
                "
              >
                ${bidIconMarkup}
              </div>
            `
                : ''
            }

            <div
              style="
                display:flex;
                align-items:center;
                padding:0 12px;
                min-width:0;
                font-size:16px;
                font-weight:900;
                line-height:1.1;
                color:#111111;
                white-space:nowrap;
                overflow:hidden;
                text-overflow:ellipsis;
              "
              title="${escapeHtml(bidSummary)}"
            >
              ${escapeHtml(bidSummary)}
            </div>
          </div>
        </div>
      </div>
    </div>
  `
}
