import type { ScoringViewState } from '../../core/state/getScoringViewState'

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
  const blackColor = '#111111'
  const richRedColor = '#c1121f'

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

function renderTableRow(
  label: string,
  leftValue: string,
  rightValue: string,
  options: {
    isHighlighted?: boolean
    valueColor?: string
  } = {},
): string {
  const { isHighlighted = false, valueColor = '#f8fafc' } = options

  if (isHighlighted) {
    return `
      <div
        style="
          display:grid;
          grid-template-columns: 1.4fr 1fr 1fr;
          align-items:center;
          min-height:54px;
          background:#e7a321;
          color:#fff7e6;
          font-weight:800;
        "
      >
        <div
          style="
            padding:0 18px;
            font-size:22px;
            text-transform:uppercase;
          "
        >
          ${escapeHtml(label)}
        </div>

        <div
          style="
            text-align:center;
            font-size:22px;
          "
        >
          ${escapeHtml(leftValue)}
        </div>

        <div
          style="
            text-align:center;
            font-size:22px;
          "
        >
          ${escapeHtml(rightValue)}
        </div>
      </div>
    `
  }

  return `
    <div
      style="
        display:grid;
        grid-template-columns: 1.4fr 1fr 1fr;
        align-items:center;
        min-height:54px;
        border-top:1px solid rgba(214, 156, 46, 0.72);
      "
    >
      <div
        style="
          padding:0 18px;
          color:#f4f1e8;
          font-size:18px;
          font-weight:500;
          text-transform:uppercase;
        "
      >
        ${escapeHtml(label)}
      </div>

      <div
        style="
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

function resolveOutcomeCells(viewState: ScoringViewState): {
  left: string
  right: string
} {
  if (viewState.isTie) {
    return {
      left: viewState.outcomeShortLabel,
      right: viewState.outcomeShortLabel,
    }
  }

  if (viewState.bidderTeamLabel === 'Отбор A') {
    return {
      left: viewState.outcomeShortLabel,
      right: '',
    }
  }

  if (viewState.bidderTeamLabel === 'Отбор B') {
    return {
      left: '',
      right: viewState.outcomeShortLabel,
    }
  }

  return {
    left: viewState.outcomeShortLabel,
    right: '',
  }
}

export function renderScoringPanel(viewState: ScoringViewState): string {
  if (!viewState.isVisible) {
    return ''
  }

  const bidIcon = resolveBidIcon(viewState)
  const bidMultiplierText = resolveBidMultiplierText(viewState)
  const countdownSeconds = resolveCountdownSeconds(viewState)
  const outcomeCells = resolveOutcomeCells(viewState)

  return `
    <section
      style="
        width:100%;
        max-width:730px;
        margin:0 auto;
        background:rgba(14, 34, 50, 0.94);
        border:2px solid #d79b2b;
        border-radius:14px;
        overflow:hidden;
        box-shadow:0 18px 40px rgba(0,0,0,0.28);
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
          color:#f7f4ec;
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
            background:rgba(255,255,255,0.92);
            display:flex;
            align-items:center;
            justify-content:center;
            font-size:34px;
            line-height:1;
            color:${bidIcon.color};
            box-shadow:0 4px 12px rgba(0,0,0,0.18);
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
            display:grid;
            grid-template-columns: 1.4fr 1fr 1fr;
            align-items:end;
            min-height:64px;
          "
        >
          <div></div>

          <div
            style="
              text-align:center;
              color:#e7a321;
              font-size:24px;
              font-weight:700;
            "
          >
            НИЕ
          </div>

          <div
            style="
              text-align:center;
              color:#e7a321;
              font-size:24px;
              font-weight:700;
            "
          >
            ВИЕ
          </div>
        </div>

        ${renderTableRow(
          'Белоти',
          String(viewState.teamABelotePoints),
          String(viewState.teamBBelotePoints),
        )}

        ${renderTableRow(
          'Обявяване',
          formatBonusValue(viewState.teamADeclarationPoints),
          formatBonusValue(viewState.teamBDeclarationPoints),
          { valueColor: '#f4b63a' },
        )}

        ${renderTableRow(
          'От ръцете',
          String(viewState.teamARawPoints),
          String(viewState.teamBRawPoints),
        )}

        ${renderTableRow(
          'Сбор',
          String(viewState.teamASumPoints),
          String(viewState.teamBSumPoints),
        )}

        ${renderTableRow(
          'Изход',
          outcomeCells.left,
          outcomeCells.right,
        )}

        ${renderTableRow(
          'Резултат',
          String(viewState.officialRoundTeamA),
          String(viewState.officialRoundTeamB),
          { isHighlighted: true },
        )}
      </div>

      <div
        style="
          position:relative;
          min-height:52px;
          display:flex;
          align-items:center;
          justify-content:center;
          padding:0 88px 0 18px;
          color:#f1f5f9;
          font-size:18px;
          font-weight:500;
          background:rgba(10, 24, 36, 0.72);
          border-top:1px solid rgba(214, 156, 46, 0.5);
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