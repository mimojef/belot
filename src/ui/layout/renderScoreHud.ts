import type { AppBootstrap } from '../../app/bootstrap'
import type { Seat } from '../../data/constants/seatOrder'
import type { Suit } from '../../core/state/gameTypes'

function formatSeat(seat: Seat | null): string {
  if (seat === 'bottom') return 'ТИ'
  if (seat === 'top') return 'ГОРЕ'
  if (seat === 'left') return 'ЛЯВО'
  if (seat === 'right') return 'ДЯСНО'
  return '—'
}

function formatSuit(suit: Suit | null): string {
  if (suit === 'clubs') return 'Спатия'
  if (suit === 'diamonds') return 'Каро'
  if (suit === 'hearts') return 'Купа'
  if (suit === 'spades') return 'Пика'
  return '—'
}

function formatBidType(type: string | null, suit: Suit | null): string {
  if (type === 'pass') return 'Пас'
  if (type === 'double') return 'Контра'
  if (type === 'redouble') return 'Ре контра'
  if (type === 'all-trumps') return 'Всичко коз'
  if (type === 'no-trumps') return 'Без коз'
  if (type === 'color' || type === 'suit') return formatSuit(suit)
  return 'Няма обява'
}

function getBidIconMarkup(type: string | null, suit: Suit | null): string {
  if (type === 'all-trumps') {
    return `
      <img
        src="/images/ui/score-hud/plain-black-J.png"
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

  if (type === 'no-trumps') {
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

  if (type === 'color' || type === 'suit') {
    if (suit === 'clubs') {
      return '<span style="color:#111111; font-size:52px; line-height:1;">♣</span>'
    }

    if (suit === 'diamonds') {
      return '<span style="color:#c62828; font-size:52px; line-height:1;">♦</span>'
    }

    if (suit === 'hearts') {
      return '<span style="color:#c62828; font-size:52px; line-height:1;">♥</span>'
    }

    if (suit === 'spades') {
      return '<span style="color:#111111; font-size:52px; line-height:1;">♠</span>'
    }
  }

  return ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>
  }

  return null
}

function readSeat(value: unknown): Seat | null {
  if (value === 'bottom' || value === 'right' || value === 'top' || value === 'left') {
    return value
  }

  return null
}

function readSuit(value: unknown): Suit | null {
  if (value === 'clubs' || value === 'diamonds' || value === 'hearts' || value === 'spades') {
    return value
  }

  return null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

type ParsedBid = {
  type: string | null
  suit: Suit | null
  seat: Seat | null
}

type BidPresentation = {
  baseType: string | null
  baseSuit: Suit | null
  baseSeat: Seat | null
  modifierType: 'double' | 'redouble' | null
  modifierSeat: Seat | null
}

function parseBidCandidate(candidate: unknown): ParsedBid | null {
  const record = asRecord(candidate)

  if (!record) {
    return null
  }

  const type =
    readString(record.type) ??
    readString(record.contract) ??
    readString(record.bidType)

  const suit =
    readSuit(record.suit) ??
    readSuit(record.trumpSuit) ??
    readSuit(record.bidSuit)

  const seat =
    readSeat(record.seat) ??
    readSeat(record.bidderSeat) ??
    readSeat(record.playerSeat) ??
    readSeat(record.winningSeat)

  if (!type && !suit && !seat) {
    return null
  }

  return { type, suit, seat }
}

function isModifierType(type: string | null): type is 'double' | 'redouble' {
  return type === 'double' || type === 'redouble'
}

function isBaseBidType(type: string | null): boolean {
  return !!type && type !== 'pass' && type !== 'double' && type !== 'redouble'
}

function extractBidPresentation(
  state: ReturnType<AppBootstrap['engine']['getState']>
): BidPresentation {
  const biddingRecord = asRecord(state.bidding)

  const bidCandidates = [
    biddingRecord?.winningBid,
    biddingRecord?.currentWinningBid,
    biddingRecord?.highestBid,
    biddingRecord?.leadingBid,
    biddingRecord?.lastWinningBid,
    biddingRecord?.lastBid,
    biddingRecord?.currentBid,
  ]
    .map(parseBidCandidate)
    .filter((candidate): candidate is ParsedBid => candidate !== null)

  let baseBid =
    bidCandidates.find((candidate) => isBaseBidType(candidate.type)) ?? null

  let modifierBid =
    bidCandidates.find((candidate) => isModifierType(candidate.type)) ?? null

  if (!baseBid) {
    const rawType =
      readString(biddingRecord?.contract) ??
      readString(biddingRecord?.winningType) ??
      readString(biddingRecord?.type)

    const rawSuit =
      readSuit(biddingRecord?.trumpSuit) ??
      readSuit(biddingRecord?.suit) ??
      readSuit(biddingRecord?.winningSuit)

    const rawSeat =
      readSeat(biddingRecord?.winningSeat) ??
      readSeat(biddingRecord?.bidderSeat) ??
      readSeat(biddingRecord?.seat)

    if (isBaseBidType(rawType)) {
      baseBid = {
        type: rawType,
        suit: rawSuit,
        seat: rawSeat,
      }
    } else if (isModifierType(rawType)) {
      modifierBid = {
        type: rawType,
        suit: rawSuit,
        seat: rawSeat,
      }
    }
  }

  if (!modifierBid && biddingRecord) {
    const modifierCandidates = [
      biddingRecord.lastModifier,
      biddingRecord.currentModifier,
      biddingRecord.modifier,
      biddingRecord.lastDouble,
      biddingRecord.lastRedouble,
    ]
      .map(parseBidCandidate)
      .filter((candidate): candidate is ParsedBid => candidate !== null)

    modifierBid =
      modifierCandidates.find((candidate) => isModifierType(candidate.type)) ?? null
  }

  return {
    baseType: baseBid?.type ?? null,
    baseSuit: baseBid?.suit ?? null,
    baseSeat: baseBid?.seat ?? null,
    modifierType:
      modifierBid && isModifierType(modifierBid.type) ? modifierBid.type : null,
    modifierSeat: modifierBid?.seat ?? null,
  }
}

export function renderScoreHud(
  state: ReturnType<AppBootstrap['engine']['getState']>
): string {
  const presentation = extractBidPresentation(state)
  const teamAScore = state.score.match.teamA
  const teamBScore = state.score.match.teamB

  const bidLabel = formatBidType(presentation.baseType, presentation.baseSuit)
  const bidIconMarkup = getBidIconMarkup(
    presentation.baseType,
    presentation.baseSuit
  )
  const showIcon = bidIconMarkup.length > 0

  const bidSummary = `${bidLabel}: ${
    presentation.baseSeat ? formatSeat(presentation.baseSeat) : '—'
  }`

  return `
    <div
      style="
        position:absolute;
        top:18px;
        left:18px;
        width:300px;
        z-index:6;
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
              ${teamAScore}
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
              ${teamBScore}
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
          >
            ${bidSummary}
          </div>
        </div>
      </div>
    </div>
  `
}