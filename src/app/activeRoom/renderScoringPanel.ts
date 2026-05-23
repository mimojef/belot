import type {
  RoomDeclarationSnapshot,
  RoomGameSnapshot,
  RoomSeatSnapshot,
  RoomTeamPointsSnapshot,
  RoomWinningBidSnapshot,
  Seat,
} from '../network/createGameServerClient'
import {
  ACTIVE_ROOM_TABLE_BACKGROUND,
  ACTIVE_ROOM_STAGE_HEIGHT,
  ACTIVE_ROOM_STAGE_WIDTH,
  escapeHtml,
} from './activeRoomShared'
import { renderScoreHud } from './renderScoreHud'

const LABEL_COLUMN_WIDTH_PX = 108
const TABLE_GRID_COLUMNS = `${LABEL_COLUMN_WIDTH_PX}px minmax(0, 1fr) minmax(0, 1fr)`
const SUM_COUNTER_DURATION_MS = 1000
const SUM_COUNTER_AUDIO_SRC = '/audio/game-sounds/scoring.mp3'
const SUM_COUNTER_AUDIO_VOLUME = 0.3
const SUM_COUNTER_START_SCALE = 4.6
const RANK_ORDER: RoomDeclarationSnapshot['highRank'][] = [
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
  'A',
]
const SQUARE_STRENGTH_BY_RANK: Record<string, number> = {
  '7': 0,
  '8': 0,
  '9': 5,
  '10': 3,
  J: 6,
  Q: 1,
  K: 2,
  A: 4,
}

type RenderScoringScreenOptions = {
  root: HTMLDivElement
  game: RoomGameSnapshot
  seats: RoomSeatSnapshot[]
  localSeat: Seat
  winningBid: NonNullable<RoomWinningBidSnapshot> | null
  countdownSeconds: number
  stageScale: number
  scaledStageWidth: number
  scaledStageHeight: number
}

type Team = 'A' | 'B'

type ScoringDeclarationItem = {
  declaration: RoomDeclarationSnapshot
  isScored: boolean
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

function getPerspectiveValues<T>(
  teamAValue: T,
  teamBValue: T,
  localSeat: Seat,
): {
  ourValue: T
  theirValue: T
} {
  return isTeamASeat(localSeat)
    ? {
        ourValue: teamAValue,
        theirValue: teamBValue,
      }
    : {
        ourValue: teamBValue,
        theirValue: teamAValue,
      }
}

function getRankStrength(rank: RoomDeclarationSnapshot['highRank']): number {
  if (rank === null) {
    return -1
  }

  return RANK_ORDER.indexOf(rank)
}

function getSquareStrength(declaration: RoomDeclarationSnapshot): number {
  const rank = declaration.highRank ?? declaration.cards[0]?.rank ?? null

  if (rank === null) {
    return -1
  }

  return SQUARE_STRENGTH_BY_RANK[rank] ?? -1
}

function getSequenceStrength(declaration: RoomDeclarationSnapshot): number {
  return declaration.points * 100 + getRankStrength(declaration.highRank)
}

function getStrongestDeclaration(
  declarations: RoomDeclarationSnapshot[],
  getStrength: (declaration: RoomDeclarationSnapshot) => number,
): RoomDeclarationSnapshot | null {
  if (declarations.length === 0) {
    return null
  }

  return declarations.reduce((best, current) => {
    return getStrength(current) > getStrength(best) ? current : best
  }, declarations[0]!)
}

function getWinningTeamForDeclarationGroup(
  declarations: RoomDeclarationSnapshot[],
  getStrength: (declaration: RoomDeclarationSnapshot) => number,
): Team | null {
  const teamAHighest = getStrongestDeclaration(
    declarations.filter((declaration) => declaration.team === 'A'),
    getStrength,
  )
  const teamBHighest = getStrongestDeclaration(
    declarations.filter((declaration) => declaration.team === 'B'),
    getStrength,
  )

  if (teamAHighest === null && teamBHighest === null) {
    return null
  }

  if (teamAHighest !== null && teamBHighest === null) {
    return 'A'
  }

  if (teamAHighest === null && teamBHighest !== null) {
    return 'B'
  }

  const teamAStrength = getStrength(teamAHighest!)
  const teamBStrength = getStrength(teamBHighest!)

  if (teamAStrength === teamBStrength) {
    return null
  }

  return teamAStrength > teamBStrength ? 'A' : 'B'
}

function buildScoringDeclarationItems(
  declarations: RoomDeclarationSnapshot[],
): ScoringDeclarationItem[] {
  const scoreableDeclarations = declarations.filter((declaration) => {
    return declaration.announced && declaration.valid
  })
  const squareDeclarations = scoreableDeclarations.filter((declaration) => {
    return declaration.type === 'square'
  })
  const sequenceDeclarations = scoreableDeclarations.filter((declaration) => {
    return declaration.type === 'sequence'
  })
  const squareWinningTeam = getWinningTeamForDeclarationGroup(
    squareDeclarations,
    getSquareStrength,
  )
  const sequenceWinningTeam = getWinningTeamForDeclarationGroup(
    sequenceDeclarations,
    getSequenceStrength,
  )

  return scoreableDeclarations.map((declaration) => {
    const isScored =
      declaration.type === 'belote' ||
      (declaration.type === 'square' && declaration.team === squareWinningTeam) ||
      (declaration.type === 'sequence' && declaration.team === sequenceWinningTeam)

    return {
      declaration,
      isScored,
    }
  })
}

function getSuitSymbol(suit: RoomDeclarationSnapshot['suit']): string {
  if (suit === 'hearts') return '&hearts;'
  if (suit === 'diamonds') return '&diams;'
  if (suit === 'spades') return '&spades;'
  if (suit === 'clubs') return '&clubs;'
  return ''
}

function getSuitColor(suit: RoomDeclarationSnapshot['suit']): string {
  return suit === 'hearts' || suit === 'diamonds' ? '#ef4444' : '#101418'
}

function getDeclarationSuit(declaration: RoomDeclarationSnapshot): RoomDeclarationSnapshot['suit'] {
  return declaration.suit ?? declaration.cards[0]?.suit ?? null
}

function getDeclarationRankText(declaration: RoomDeclarationSnapshot): string {
  if (declaration.type === 'square') {
    const rank = declaration.cards[0]?.rank ?? declaration.highRank ?? ''
    return [rank, rank, rank, rank].filter(Boolean).join(' ')
  }

  return [...declaration.cards]
    .sort((left, right) => getRankStrength(left.rank) - getRankStrength(right.rank))
    .map((card) => card.rank)
    .join(' ')
}

function renderDeclarationToken(item: ScoringDeclarationItem): string {
  const declaration = item.declaration
  const suit = getDeclarationSuit(declaration)
  const color = getSuitColor(suit)
  const symbol = getSuitSymbol(suit)
  const rankText = getDeclarationRankText(declaration)
  const shouldShowRankText = declaration.type !== 'belote'
  const opacity = item.isScored ? '1' : '0.62'
  const decoration = item.isScored ? 'none' : 'line-through'
  const textShadow = color === '#101418'
    ? '0 0 2px rgba(255,255,255,0.62)'
    : 'none'

  return `
    <span
      style="
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap:5px;
        opacity:${opacity};
        text-decoration:${decoration};
        text-decoration-thickness:2px;
        text-decoration-color:rgba(16,20,24,0.65);
        white-space:nowrap;
      "
    >
      ${
        symbol
          ? `
            <span
              style="
                display:inline-flex;
                align-items:center;
                justify-content:center;
                color:${color};
                font-size:30px;
                line-height:1;
                font-weight:900;
                text-shadow:${textShadow};
              "
            >${symbol}</span>
          `
          : ''
      }
      ${
        shouldShowRankText
          ? `
            <span
              style="
                color:${color};
                font-size:20px;
                line-height:1;
                font-weight:900;
                text-shadow:${textShadow};
              "
            >${escapeHtml(rankText)}</span>
          `
          : ''
      }
    </span>
  `
}

function renderDeclarationItemsCell(
  items: ScoringDeclarationItem[],
  points: number,
): string {
  const pointsColor = points > 0 ? '#15803d' : '#101418'

  if (items.length === 0) {
    return `
      <span
        style="
          color:${pointsColor};
          font-size:19px;
          font-weight:700;
          white-space:nowrap;
        "
      >${escapeHtml(formatBonusValue(points))}</span>
    `
  }

  return `
    <div
      style="
        display:flex;
        align-items:center;
        justify-content:center;
        gap:8px;
        flex-wrap:wrap;
        min-height:42px;
        padding:6px 0;
      "
    >
      ${items.map(renderDeclarationToken).join('')}
      <span
        style="
          color:${pointsColor};
          font-size:19px;
          font-weight:700;
          white-space:nowrap;
        "
      >${escapeHtml(formatBonusValue(points))}</span>
    </div>
  `
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

function formatBonusValue(value: number | string): string {
  if (typeof value === 'string') {
    return value
  }

  return value > 0 ? `+${value}` : '0'
}

function formatRawHandValue(points: number, tricksWon: number): string {
  if (tricksWon === 0) {
    return `
      <span
        style="
          color:#dc2626;
          font-weight:900;
        "
      >КАПО</span>
    `
  }

  return String(points)
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
        background:#171717;
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
    overflowVisible?: boolean
    useValueHtml?: boolean
    valueColor?: string
  } = {},
): string {
  const {
    minHeight = 54,
    overflowVisible = false,
    useValueHtml = false,
    valueColor = '#101418',
  } = options

  return `
    <div
      style="
        display:grid;
        grid-template-columns:${TABLE_GRID_COLUMNS};
        align-items:stretch;
        min-height:${minHeight}px;
        border-bottom:1px solid rgba(232, 178, 78, 0.78);
        background:#ffffff;
        position:${overflowVisible ? 'relative' : 'static'};
        z-index:${overflowVisible ? '4' : 'auto'};
        overflow:visible;
      "
    >
      <div
        style="
          padding:0 14px 0 16px;
          color:#101418;
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
          overflow:visible;
        "
      >
        ${useValueHtml || leftValue.includes('<') ? leftValue : escapeHtml(leftValue)}
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
          overflow:visible;
        "
      >
        ${useValueHtml || rightValue.includes('<') ? rightValue : escapeHtml(rightValue)}
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
        background:#121212;
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
        color:#101418;
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
          font-size:26px;
        "
      >
        ${escapeHtml(String(ourPoints))}
      </div>

      <div
        style="
          display:flex;
          align-items:center;
          justify-content:center;
          font-size:26px;
        "
      >
        ${escapeHtml(String(theirPoints))}
      </div>
    </div>
  `
}

function renderAnimatedSumValue(points: number): string {
  return `
    <span
      style="
        display:inline-flex;
        align-items:center;
        justify-content:center;
        min-width:4ch;
        height:1.1em;
        overflow:visible;
        position:relative;
        z-index:5;
      "
    >
      <span
        data-scoring-sum-counter="1"
        data-target-points="${points}"
        style="
          display:inline-block;
          transform:scale(${SUM_COUNTER_START_SCALE});
          transform-origin:center center;
          line-height:1;
          will-change:transform, opacity;
          opacity:0.9;
          text-shadow:0 5px 16px rgba(0,0,0,0.18);
        "
      >0</span>
    </span>
  `
}

function canPlayAudioNow(): boolean {
  if (typeof document === 'undefined') {
    return true
  }

  if (document.visibilityState !== 'visible') {
    return false
  }

  if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
    return false
  }

  return true
}

function playScoringSumSound(): void {
  if (!canPlayAudioNow()) {
    return
  }

  const audio = new Audio(SUM_COUNTER_AUDIO_SRC)
  audio.preload = 'auto'
  audio.volume = SUM_COUNTER_AUDIO_VOLUME
  void audio.play().catch(() => {})
}

function animateScoringSumCounters(root: HTMLElement): void {
  const counters = Array.from(
    root.querySelectorAll<HTMLElement>('[data-scoring-sum-counter="1"]'),
  )

  if (counters.length === 0) {
    return
  }

  playScoringSumSound()

  const targets = counters.map((counter) => {
    const target = Number(counter.dataset.targetPoints)
    return Number.isFinite(target) ? target : 0
  })
  const startedAt = performance.now()

  function tick(now: number): void {
    const elapsed = now - startedAt
    const progress = Math.min(1, elapsed / SUM_COUNTER_DURATION_MS)
    const easedProgress = 1 - Math.pow(1 - progress, 3)

    counters.forEach((counter, index) => {
      const target = targets[index] ?? 0
      counter.textContent = String(Math.round(target * easedProgress))
      const scale = SUM_COUNTER_START_SCALE - (SUM_COUNTER_START_SCALE - 1) * easedProgress
      counter.style.transform = `scale(${scale})`
      counter.style.opacity = String(0.9 + 0.1 * easedProgress)
    })

    if (progress < 1) {
      window.requestAnimationFrame(tick)
    }
  }

  window.requestAnimationFrame(tick)
}

function renderScoringPanelHtml(
  game: RoomGameSnapshot,
  localSeat: Seat,
  fallbackWinningBid: NonNullable<RoomWinningBidSnapshot> | null,
  countdownSeconds: number,
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
  const rawHands = getPerspectivePoints(scoring.rawHandPoints, localSeat)
  const rawHandTricksWon = getPerspectivePoints(scoring.rawHandTricksWon, localSeat)
  const sumPoints = getPerspectivePoints(scoring.sumPoints, localSeat)
  const officialRoundPoints = getPerspectivePoints(scoring.officialRoundPoints, localSeat)
  const scoringDeclarationItems = buildScoringDeclarationItems(game.declarations)
  const teamABeloteItems = scoringDeclarationItems.filter((item) => {
    return item.declaration.team === 'A' && item.declaration.type === 'belote'
  })
  const teamBBeloteItems = scoringDeclarationItems.filter((item) => {
    return item.declaration.team === 'B' && item.declaration.type === 'belote'
  })
  const teamADeclarationItems = scoringDeclarationItems.filter((item) => {
    return item.declaration.team === 'A' && item.declaration.type !== 'belote'
  })
  const teamBDeclarationItems = scoringDeclarationItems.filter((item) => {
    return item.declaration.team === 'B' && item.declaration.type !== 'belote'
  })
  const beloteCells = getPerspectiveValues(
    renderDeclarationItemsCell(teamABeloteItems, scoring.belotePoints.teamA),
    renderDeclarationItemsCell(teamBBeloteItems, scoring.belotePoints.teamB),
    localSeat,
  )
  const declarationCells = getPerspectiveValues(
    renderDeclarationItemsCell(teamADeclarationItems, scoring.declarationPoints.teamA),
    renderDeclarationItemsCell(teamBDeclarationItems, scoring.declarationPoints.teamB),
    localSeat,
  )
  const belote = {
    ourPoints: beloteCells.ourValue,
    theirPoints: beloteCells.theirValue,
  }
  const declarations = {
    ourPoints: declarationCells.ourValue,
    theirPoints: declarationCells.theirValue,
  }

  return `
    <section
      style="
        width:100%;
        max-width:730px;
        margin:0 auto;
        background:#0a0a0a;
        border:4px solid #dca33a;
        border-radius:14px;
        overflow:hidden;
        box-shadow:0 18px 40px rgba(0,0,0,0.28), 0 0 0 1px rgba(244,182,58,0.28);
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
          ${renderMatrixRow(
            'Ръце',
            formatRawHandValue(rawHands.ourPoints, rawHandTricksWon.ourPoints),
            formatRawHandValue(rawHands.theirPoints, rawHandTricksWon.theirPoints),
          )}
          ${renderMatrixRow('Сбор', renderAnimatedSumValue(sumPoints.ourPoints), renderAnimatedSumValue(sumPoints.theirPoints), {
            overflowVisible: true,
            useValueHtml: true,
          })}
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
          background:#121212;
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
    seats,
    localSeat,
    winningBid,
    countdownSeconds,
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
              ${renderScoringPanelHtml(game, localSeat, winningBid, countdownSeconds)}
            </div>
          </div>
        </div>
      </div>

      ${renderScoreHud({
        game,
        seats,
        localSeat,
        winningBid: game.scoring?.winningBid ?? winningBid,
        stageScale,
      })}
    </div>
  `

  animateScoringSumCounters(root)
}
