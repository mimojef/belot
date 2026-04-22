import type {
  ScoringViewState,
  ScoringBeloteDisplayItem,
  ScoringDeclarationDisplayItem,
} from '../../core/state/getScoringViewState'

type ExtendedScoringViewState = ScoringViewState & {
  counterMultiplier?: number
  bidMultiplier?: number
  hasDouble?: boolean
  hasRedouble?: boolean
  isDoubled?: boolean
  isRedoubled?: boolean
  countdownSeconds?: number
  autoAdvanceCountdownSeconds?: number
}

const DECLARATION_DISPLAY_RANK_ORDER = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const
const LABEL_COLUMN_WIDTH_PX = 108
const TABLE_GRID_COLUMNS = `${LABEL_COLUMN_WIDTH_PX}px minmax(0, 1fr) minmax(0, 1fr)`

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function resolveBidIcon(viewState: ScoringViewState): {
  symbol: string
  color: string
} {
  const blackColor = '#101418'
  const richRedColor = '#cc2233'

  if (viewState.winningBidLabel === 'Купа') {
    return { symbol: '♥', color: richRedColor }
  }

  if (viewState.winningBidLabel === 'Каро') {
    return { symbol: '♦', color: richRedColor }
  }

  if (viewState.winningBidLabel === 'Пика') {
    return { symbol: '♠', color: blackColor }
  }

  if (viewState.winningBidLabel === 'Спатия') {
    return { symbol: '♣', color: blackColor }
  }

  if (viewState.winningBidLabel === 'Всичко коз') {
    return { symbol: 'J', color: richRedColor }
  }

  if (viewState.winningBidLabel === 'Без коз') {
    return { symbol: 'A', color: blackColor }
  }

  return { symbol: '•', color: blackColor }
}

function resolveBidMultiplierText(viewState: ScoringViewState): string {
  const extendedViewState = viewState as ExtendedScoringViewState

  const explicitMultiplier =
    typeof extendedViewState.counterMultiplier === 'number'
      ? extendedViewState.counterMultiplier
      : typeof extendedViewState.bidMultiplier === 'number'
        ? extendedViewState.bidMultiplier
        : null

  if (explicitMultiplier === 4) {
    return ' x4'
  }

  if (explicitMultiplier === 2) {
    return ' x2'
  }

  if (extendedViewState.hasRedouble || extendedViewState.isRedoubled) {
    return ' x4'
  }

  if (extendedViewState.hasDouble || extendedViewState.isDoubled) {
    return ' x2'
  }

  return ''
}

function resolveCountdownSeconds(viewState: ScoringViewState): number {
  const extendedViewState = viewState as ExtendedScoringViewState

  const rawValue =
    typeof extendedViewState.countdownSeconds === 'number'
      ? extendedViewState.countdownSeconds
      : typeof extendedViewState.autoAdvanceCountdownSeconds === 'number'
        ? extendedViewState.autoAdvanceCountdownSeconds
        : 5

  if (!Number.isFinite(rawValue)) {
    return 5
  }

  return Math.max(0, Math.ceil(rawValue))
}

function formatBonusValue(value: number): string {
  if (value <= 0) {
    return '0'
  }

  return `+${value}`
}

function resolveDeclarationColor(color: 'red' | 'black'): string {
  if (color === 'red') {
    return '#d51f34'
  }

  return '#101418'
}

function resolveDeclarationTextShadow(color: 'red' | 'black'): string {
  if (color === 'red') {
    return 'none'
  }

  return '0 0 1px rgba(255,255,255,0.12)'
}

function tokenizeSequenceRankText(rankText: string): string[] {
  const tokens: string[] = []
  let index = 0

  while (index < rankText.length) {
    if (rankText.slice(index, index + 2) === '10') {
      tokens.push('10')
      index += 2
      continue
    }

    tokens.push(rankText[index])
    index += 1
  }

  return tokens
}

function normalizeSequenceRankText(rankText: string): string {
  const orderMap = new Map<string, number>(
    DECLARATION_DISPLAY_RANK_ORDER.map((rank, index) => [rank, index]),
  )

  const tokens = tokenizeSequenceRankText(rankText)

  tokens.sort((left, right) => {
    const leftIndex = orderMap.get(left) ?? 999
    const rightIndex = orderMap.get(right) ?? 999
    return leftIndex - rightIndex
  })

  return tokens.join(' ')
}

function renderSquareDeclarationLine(rankText: string): string {
  const repeatedRanks = Array.from({ length: 4 }, () => rankText)

  return repeatedRanks
    .map((rank, index) => {
      const color = index % 2 === 0 ? 'black' : 'red'

      return `
        <span
          style="
            color:${resolveDeclarationColor(color)};
            text-shadow:${resolveDeclarationTextShadow(color)};
            font-weight:800;
            font-size:21px;
            line-height:1;
            letter-spacing:0.01em;
          "
        >
          ${escapeHtml(rank)}${index < repeatedRanks.length - 1 ? '&nbsp;' : ''}
        </span>
      `
    })
    .join('')
}

function renderSequenceDeclarationLine(item: ScoringDeclarationDisplayItem): string {
  const color = resolveDeclarationColor(item.color)
  const textShadow = resolveDeclarationTextShadow(item.color)
  const displayRankText = normalizeSequenceRankText(item.rankText)

  return `
    <div
      style="
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap:7px;
        white-space:nowrap;
      "
    >
      ${
        item.suitSymbol
          ? `
            <span
              style="
                color:${color};
                text-shadow:${textShadow};
                font-size:31px;
                line-height:1;
                font-weight:900;
              "
            >
              ${escapeHtml(item.suitSymbol)}
            </span>
          `
          : ''
      }

      <span
        style="
          color:${color};
          text-shadow:${textShadow};
          font-size:21px;
          line-height:1;
          font-weight:800;
          letter-spacing:0.01em;
        "
      >
        ${escapeHtml(displayRankText)}
      </span>
    </div>
  `
}

function getDeclarationSortWeight(item: ScoringDeclarationDisplayItem): number {
  if (item.kind === 'square') {
    return 10_000 + item.points
  }

  const tokens = tokenizeSequenceRankText(item.rankText)
  const highestRank = tokens[tokens.length - 1] ?? ''
  const highestRankIndex = DECLARATION_DISPLAY_RANK_ORDER.indexOf(
    highestRank as (typeof DECLARATION_DISPLAY_RANK_ORDER)[number],
  )

  return item.points * 100 + (highestRankIndex === -1 ? 0 : highestRankIndex)
}

function sortDeclarationItemsForDisplay(
  items: ScoringDeclarationDisplayItem[],
): ScoringDeclarationDisplayItem[] {
  return [...items].sort((left, right) => {
    return getDeclarationSortWeight(left) - getDeclarationSortWeight(right)
  })
}

function renderBeloteCell(
  items: ScoringBeloteDisplayItem[],
  points: number,
): string {
  if (items.length === 0) {
    return `
      <div
        style="
          display:flex;
          align-items:center;
          justify-content:center;
          min-height:42px;
          color:#f8fafc;
          font-size:18px;
          font-weight:700;
        "
      >
        ${escapeHtml(formatBonusValue(points))}
      </div>
    `
  }

  return `
    <div
      style="
        display:flex;
        align-items:center;
        justify-content:center;
        gap:10px;
        flex-wrap:wrap;
        min-height:42px;
        padding:6px 0;
      "
    >
      ${items
        .map((item) => {
          const color = resolveDeclarationColor(item.color)
          const textShadow = resolveDeclarationTextShadow(item.color)

          return `
            <span
              style="
                color:${color};
                text-shadow:${textShadow};
                font-size:45px;
                line-height:1;
                font-weight:900;
              "
            >
              ${escapeHtml(item.suitSymbol)}
            </span>
          `
        })
        .join('')}

      <span
        style="
          color:#f4b63a;
          font-size:19px;
          font-weight:800;
          white-space:nowrap;
        "
      >
        ${escapeHtml(formatBonusValue(points))}
      </span>
    </div>
  `
}

function renderDeclarationCell(
  items: ScoringDeclarationDisplayItem[],
  points: number,
): string {
  if (items.length === 0) {
    return `
      <div
        style="
          display:flex;
          align-items:center;
          justify-content:center;
          min-height:42px;
          color:#f4b63a;
          font-size:18px;
          font-weight:800;
        "
      >
        ${escapeHtml(formatBonusValue(points))}
      </div>
    `
  }

  const sortedItems = sortDeclarationItemsForDisplay(items)

  return `
    <div
      style="
        display:flex;
        align-items:center;
        justify-content:center;
        gap:12px;
        min-height:54px;
        padding:8px 0;
      "
    >
      <div
        style="
          display:flex;
          flex-direction:column;
          align-items:center;
          justify-content:center;
          gap:5px;
        "
      >
        ${sortedItems
          .map((item) => {
            const lineHtml =
              item.kind === 'square'
                ? renderSquareDeclarationLine(item.rankText)
                : renderSequenceDeclarationLine(item)

            return `
              <div
                style="
                  display:flex;
                  align-items:center;
                  justify-content:center;
                  min-height:22px;
                  line-height:1;
                  text-align:center;
                "
              >
                ${lineHtml}
              </div>
            `
          })
          .join('')}
      </div>

      <div
        style="
          color:#f4b63a;
          font-size:19px;
          font-weight:800;
          line-height:1;
          white-space:nowrap;
          align-self:center;
        "
      >
        ${escapeHtml(formatBonusValue(points))}
      </div>
    </div>
  `
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
    useValueHtml?: boolean
    minHeight?: number
    valueColor?: string
  } = {},
): string {
  const {
    useValueHtml = false,
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
        ${useValueHtml ? leftValue : escapeHtml(leftValue)}
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
        ${useValueHtml ? rightValue : escapeHtml(rightValue)}
      </div>
    </div>
  `
}

function renderOutcomeRow(viewState: ScoringViewState): string {
  if (viewState.isTie) {
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
            display:flex;
            align-items:center;
            justify-content:center;
            color:#f8fafc;
            font-size:18px;
            font-weight:700;
          "
        >
          ${escapeHtml(viewState.outcomeShortLabel)}
        </div>

        <div
          style="
            display:flex;
            align-items:center;
            justify-content:center;
            color:#f8fafc;
            font-size:18px;
            font-weight:700;
          "
        >
          ${escapeHtml(viewState.outcomeShortLabel)}
        </div>
      </div>
    `
  }

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
        ${escapeHtml(viewState.outcomeShortLabel)}
      </div>
    </div>
  `
}

function renderResultRow(viewState: ScoringViewState): string {
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
        ${escapeHtml(String(viewState.officialRoundTeamA))}
      </div>

      <div
        style="
          display:flex;
          align-items:center;
          justify-content:center;
          font-size:22px;
        "
      >
        ${escapeHtml(String(viewState.officialRoundTeamB))}
      </div>
    </div>
  `
}

export function renderScoringPanel(viewState: ScoringViewState): string {
  if (!viewState.isVisible) {
    return ''
  }

  const bidIcon = resolveBidIcon(viewState)
  const bidMultiplierText = resolveBidMultiplierText(viewState)
  const countdownSeconds = resolveCountdownSeconds(viewState)

  const teamABeloteHtml = renderBeloteCell(
    viewState.teamABeloteItems ?? [],
    viewState.teamABelotePoints,
  )

  const teamBBeloteHtml = renderBeloteCell(
    viewState.teamBBeloteItems ?? [],
    viewState.teamBBelotePoints,
  )

  const teamADeclarationHtml = renderDeclarationCell(
    viewState.teamADeclarationItems ?? [],
    viewState.teamADeclarationPoints,
  )

  const teamBDeclarationHtml = renderDeclarationCell(
    viewState.teamBDeclarationItems ?? [],
    viewState.teamBDeclarationPoints,
  )

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
        backdrop-filter: blur(3px);
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
          ${escapeHtml(viewState.winningBidLabel.toUpperCase())}
          ${viewState.winningBidOwnerLabel !== '—'
            ? ` (${escapeHtml(viewState.winningBidOwnerLabel)})`
            : ''}
          ${escapeHtml(bidMultiplierText)}
        </div>
      </div>

      <div
        style="
          padding:10px 0 0 0;
        "
      >
        <div
          style="
            position:relative;
          "
        >
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

          ${renderMatrixRow(
            'Белоти',
            teamABeloteHtml,
            teamBBeloteHtml,
            {
              useValueHtml: true,
              minHeight: 60,
            },
          )}

          ${renderMatrixRow(
            'Обяви',
            teamADeclarationHtml,
            teamBDeclarationHtml,
            {
              useValueHtml: true,
              minHeight: 70,
            },
          )}

          ${renderMatrixRow(
            'Ръце',
            String(viewState.teamARawPoints),
            String(viewState.teamBRawPoints),
          )}

          ${renderMatrixRow(
            'Сбор',
            String(viewState.teamASumPoints),
            String(viewState.teamBSumPoints),
          )}
        </div>

        ${renderOutcomeRow(viewState)}

        ${renderResultRow(viewState)}
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
          ${escapeHtml(viewState.outcomeLabel)}
        </div>

        <div
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
          ${escapeHtml(String(countdownSeconds))} сек.
        </div>
      </div>
    </section>
  `
}