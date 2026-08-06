import type {
  RoomGameSnapshot,
  RoomSeatSnapshot,
  RoomWinningBidSnapshot,
  Seat,
} from '../network/createGameServerClient'
import { escapeHtml } from './activeRoomShared'
import { getVisualSeatForLocalPerspective } from './cutting/cuttingSeatLayout'
import { formatBidType, getBidMultiplierLabel } from './winningBidHelpers'
import { isPhoneLayoutViewport, getRealViewportWidthCssPx } from '../../ui/layout/viewportStage'
import { getScoreHudMobileGeometry } from './scoreHudMobileGeometry'

const SCORE_HUD_INTERNAL_OFFSET = 18

type RenderScoreHudOptions = {
  game: RoomGameSnapshot
  seats: RoomSeatSnapshot[]
  localSeat: Seat
  winningBid: NonNullable<RoomWinningBidSnapshot> | null
  stageScale: number
}

function isTeamASeat(seat: Seat): boolean {
  return seat === 'bottom' || seat === 'top'
}

function formatSeatForLocalPerspective(seat: Seat | null, localSeat: Seat): string {
  if (seat === null) return '—'
  const visualSeat = getVisualSeatForLocalPerspective(seat, localSeat)

  if (visualSeat === 'bottom') return 'ТИ'
  if (visualSeat === 'top') return 'ГОРЕ'
  if (visualSeat === 'left') return 'ЛЯВО'
  if (visualSeat === 'right') return 'ДЯСНО'
  return '—'
}

function formatBidOwnerLabel(
  seat: Seat | null,
  seats: RoomSeatSnapshot[],
  localSeat: Seat,
): string {
  if (seat === null) return '—'

  const seatSnapshot = seats.find((candidate) => candidate.seat === seat) ?? null
  const displayName = seatSnapshot?.displayName.trim() ?? ''

  return seatSnapshot?.isOccupied && displayName.length > 0
    ? displayName
    : formatSeatForLocalPerspective(seat, localSeat)
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
  const { game, seats, localSeat, winningBid, stageScale } = options
  const isMobileLayout = isPhoneLayoutViewport()
  const { ourScore, theirScore } = getScoreForLocalPerspective(game, localSeat)
  const bidLabel = formatBidType(winningBid)
  const bidIconMarkup = getBidIconMarkup(winningBid)
  const showIcon = bidIconMarkup.length > 0
  const bidMultiplierLabel = getBidMultiplierLabel(winningBid)
  const bidOwnerLabel = winningBid
    ? formatBidOwnerLabel(winningBid.seat, seats, localSeat)
    : '—'
  const bidSummary = `${bidLabel}${bidMultiplierLabel}: ${bidOwnerLabel}`

  // hudScale е ДОПЪЛНИТЕЛЕН множител над stageScale, приложен само за да
  // предпази HUD-а от застъпване с top-seat профилния панел на тесни mobile
  // viewport-и (виж scoreHudMobileGeometry.ts за пълната geometry и root
  // cause). combinedScale замества самостоятелния stageScale навсякъде —
  // включително в top/left offset формулата — защото тя компенсира точно
  // толкова local px (SCORE_HUD_INTERNAL_OFFSET), колкото transform:scale
  // после мащабира навън; ако top/left продължаваше да ползва само
  // stageScale, докато transform ползва stageScale*hudScale, компенсацията
  // би останала разсинхронизирана и anchor точката би се "плъзнала" встрани
  // при hudScale<1, вместо да остане фиксирана в левия горен ъгъл.
  const { hudScale } = getScoreHudMobileGeometry({
    viewportWidthCssPx: getRealViewportWidthCssPx(),
    stageScale,
    isMobileLayout,
  })
  const combinedScale = stageScale * hudScale

  return `
    <div
      data-active-room-score-hud="1"
      style="
        position:fixed;
        top:${5 - SCORE_HUD_INTERNAL_OFFSET * combinedScale}px;
        left:${5 - SCORE_HUD_INTERNAL_OFFSET * combinedScale}px;
        width:0;
        height:0;
        z-index:8;
        pointer-events:none;
        transform:scale(${combinedScale});
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
            background: linear-gradient(180deg, rgba(29, 29, 29, 0.97) 0%, rgba(10, 10, 10, 0.98) 100%);
            border:1px solid rgba(220,163,58,0.78);
            box-shadow:
              0 18px 36px rgba(0,0,0,0.28),
              0 0 0 1px rgba(220,163,58,0.22),
              inset 0 1px 0 rgba(255,255,255,0.04);
            -webkit-backdrop-filter: blur(10px);backdrop-filter: blur(10px);
          "
        >
          <div
            style="
              padding:12px 14px 10px 14px;
              font-size:11px;
              font-weight:900;
              letter-spacing:0.14em;
              text-transform:uppercase;
              color:rgba(244,182,58,0.92);
              border-bottom:1px solid rgba(220,163,58,0.34);
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
                border-right:1px solid rgba(220,163,58,0.28);
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
                border-right:1px solid rgba(220,163,58,0.28);
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
              border-top:1px solid rgba(220,163,58,0.48);
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
                font-size:${isMobileLayout ? '20px' : '16px'};
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
