import type { AppBootstrap } from './bootstrap'
import type { Seat } from '../data/constants/seatOrder'
import type { Suit } from '../core/state/gameTypes'
import { getBiddingViewState } from '../core/state/getBiddingViewState'
import { renderBiddingPanel } from '../ui/center/renderBiddingPanel'

type RenderAppOptions = {
  onNextPhaseClick?: () => void
  onSelectCutIndex?: (cutIndex: number) => void
  onResolveCutClick?: () => void
  onBidPass?: () => void
  onBidSuit?: (suit: Suit) => void
  onBidNoTrumps?: () => void
  onBidAllTrumps?: () => void
  onBidDouble?: () => void
  onBidRedouble?: () => void
}

function formatSeat(seat: Seat | null): string {
  if (seat === 'bottom') return 'Долу'
  if (seat === 'right') return 'Дясно'
  if (seat === 'top') return 'Горе'
  if (seat === 'left') return 'Ляво'
  return '—'
}

function getActionElements(rootElement: HTMLElement, actionName: string): HTMLElement[] {
  const selectorsByAction: Record<string, string[]> = {
    'bid-pass': [
      '#bid-pass',
      '[data-action="bid-pass"]',
      '[data-bid-action="pass"]',
      '[data-bid-pass]',
    ],
    'bid-suit': [
      '[data-action="bid-suit"]',
      '[data-bid-action="suit"]',
      '[data-bid-suit]',
    ],
    'bid-no-trumps': [
      '#bid-no-trumps',
      '[data-action="bid-no-trumps"]',
      '[data-bid-action="no-trumps"]',
      '[data-bid-no-trumps]',
    ],
    'bid-all-trumps': [
      '#bid-all-trumps',
      '[data-action="bid-all-trumps"]',
      '[data-bid-action="all-trumps"]',
      '[data-bid-all-trumps]',
    ],
    'bid-double': [
      '#bid-double',
      '[data-action="bid-double"]',
      '[data-bid-action="double"]',
      '[data-bid-double]',
    ],
    'bid-redouble': [
      '#bid-redouble',
      '[data-action="bid-redouble"]',
      '[data-bid-action="redouble"]',
      '[data-bid-redouble]',
    ],
  }

  const selectors = selectorsByAction[actionName] ?? []
  const uniqueElements = new Set<HTMLElement>()

  for (const selector of selectors) {
    rootElement.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      uniqueElements.add(element)
    })
  }

  return Array.from(uniqueElements)
}

function readSuitFromElement(element: HTMLElement): Suit | null {
  const datasetSuit =
    element.dataset.suit ??
    element.dataset.bidSuit ??
    element.getAttribute('data-suit') ??
    element.getAttribute('data-bid-suit')

  const valueSuit =
    'value' in element && typeof element.value === 'string' ? element.value : null

  const rawSuit = datasetSuit ?? valueSuit

  if (
    rawSuit === 'clubs' ||
    rawSuit === 'diamonds' ||
    rawSuit === 'hearts' ||
    rawSuit === 'spades'
  ) {
    return rawSuit
  }

  return null
}

function bindClick(elements: HTMLElement[], handler?: () => void): void {
  if (!handler) {
    return
  }

  for (const element of elements) {
    element.addEventListener('click', (event) => {
      event.preventDefault()
      handler()
    })
  }
}

function bindSuitClicks(
  elements: HTMLElement[],
  handler?: (suit: Suit) => void
): void {
  if (!handler) {
    return
  }

  for (const element of elements) {
    element.addEventListener('click', (event) => {
      event.preventDefault()

      const suit = readSuitFromElement(element)
      if (!suit) {
        return
      }

      handler(suit)
    })
  }
}

export function renderApp(
  rootElement: HTMLElement,
  app: AppBootstrap,
  options: RenderAppOptions = {}
): void {
  const state = app.engine.getState()
  const isCuttingPhase = state.phase === 'cutting'
  const isBiddingPhase = state.phase === 'bidding'
  const biddingViewState = isBiddingPhase ? getBiddingViewState(state) : null

  rootElement.innerHTML = `
    <div style="padding: 24px; font-family: Arial, Helvetica, sans-serif; color: white; background: #0f172a; min-height: 100vh;">
      <h1 style="margin: 0 0 16px 0;">Belot V2</h1>

      <div style="padding: 16px; border-radius: 12px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); max-width: 720px; margin-bottom: 16px;">
        <div style="margin-bottom: 10px;"><strong>Фаза:</strong> ${state.phase}</div>
        <div style="margin-bottom: 10px;"><strong>Дилър:</strong> ${formatSeat(state.round.dealerSeat)}</div>
        <div style="margin-bottom: 10px;"><strong>Цепи:</strong> ${formatSeat(state.round.cutterSeat)}</div>
        <div style="margin-bottom: 10px;"><strong>Първи обявява:</strong> ${formatSeat(state.round.firstBidderSeat)}</div>
        <div style="margin-bottom: 10px;"><strong>Първо се раздава на:</strong> ${formatSeat(state.round.firstDealSeat)}</div>
        <div style="margin-bottom: 10px;"><strong>Брой карти в тестето:</strong> ${state.deck.length}</div>
        <div style="margin-bottom: 10px;"><strong>Избран cut index:</strong> ${state.round.selectedCutIndex ?? '—'}</div>
        <div><strong>Текущ обявяващ:</strong> ${formatSeat(state.bidding.currentSeat)}</div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 12px; max-width: 720px; margin-bottom: 16px;">
        <div style="padding: 14px; border-radius: 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);">
          <strong>Долу</strong>
          <div style="margin-top: 8px;">Карти: ${state.hands.bottom.length}</div>
        </div>

        <div style="padding: 14px; border-radius: 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);">
          <strong>Дясно</strong>
          <div style="margin-top: 8px;">Карти: ${state.hands.right.length}</div>
        </div>

        <div style="padding: 14px; border-radius: 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);">
          <strong>Горе</strong>
          <div style="margin-top: 8px;">Карти: ${state.hands.top.length}</div>
        </div>

        <div style="padding: 14px; border-radius: 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);">
          <strong>Ляво</strong>
          <div style="margin-top: 8px;">Карти: ${state.hands.left.length}</div>
        </div>
      </div>

      ${
        isCuttingPhase
          ? `
        <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px;">
          <button
            type="button"
            data-action="cut-index"
            data-cut-index="8"
            style="
              border: 0;
              border-radius: 10px;
              padding: 12px 18px;
              background: #38bdf8;
              color: #082f49;
              font-weight: 700;
              cursor: pointer;
            "
          >
            Избери cut 8
          </button>

          <button
            type="button"
            data-action="cut-index"
            data-cut-index="16"
            style="
              border: 0;
              border-radius: 10px;
              padding: 12px 18px;
              background: #38bdf8;
              color: #082f49;
              font-weight: 700;
              cursor: pointer;
            "
          >
            Избери cut 16
          </button>

          <button
            type="button"
            data-action="cut-index"
            data-cut-index="24"
            style="
              border: 0;
              border-radius: 10px;
              padding: 12px 18px;
              background: #38bdf8;
              color: #082f49;
              font-weight: 700;
              cursor: pointer;
            "
          >
            Избери cut 24
          </button>

          <button
            type="button"
            data-action="resolve-cut"
            style="
              border: 0;
              border-radius: 10px;
              padding: 12px 18px;
              background: #f59e0b;
              color: #451a03;
              font-weight: 700;
              cursor: pointer;
            "
          >
            Потвърди цепенето
          </button>
        </div>
      `
          : ''
      }

      ${
        biddingViewState
          ? `
        <div style="max-width: 720px; margin-bottom: 16px;">
          ${renderBiddingPanel(biddingViewState)}
        </div>
      `
          : ''
      }

      <button
        type="button"
        data-action="next-phase"
        style="
          border: 0;
          border-radius: 10px;
          padding: 12px 18px;
          background: #22c55e;
          color: #052e16;
          font-weight: 700;
          cursor: pointer;
        "
      >
        Следваща фаза
      </button>
    </div>
  `

  const nextPhaseButton = rootElement.querySelector<HTMLButtonElement>(
    '[data-action="next-phase"]'
  )

  nextPhaseButton?.addEventListener('click', () => {
    options.onNextPhaseClick?.()
  })

  const cutIndexButtons = rootElement.querySelectorAll<HTMLButtonElement>(
    '[data-action="cut-index"]'
  )

  for (const button of cutIndexButtons) {
    button.addEventListener('click', () => {
      const rawCutIndex = button.dataset.cutIndex
      const cutIndex = rawCutIndex ? Number(rawCutIndex) : NaN

      if (!Number.isNaN(cutIndex)) {
        options.onSelectCutIndex?.(cutIndex)
      }
    })
  }

  const resolveCutButton = rootElement.querySelector<HTMLButtonElement>(
    '[data-action="resolve-cut"]'
  )

  resolveCutButton?.addEventListener('click', () => {
    options.onResolveCutClick?.()
  })

  if (isBiddingPhase) {
    bindClick(getActionElements(rootElement, 'bid-pass'), options.onBidPass)
    bindSuitClicks(getActionElements(rootElement, 'bid-suit'), options.onBidSuit)
    bindClick(
      getActionElements(rootElement, 'bid-no-trumps'),
      options.onBidNoTrumps
    )
    bindClick(
      getActionElements(rootElement, 'bid-all-trumps'),
      options.onBidAllTrumps
    )
    bindClick(getActionElements(rootElement, 'bid-double'), options.onBidDouble)
    bindClick(
      getActionElements(rootElement, 'bid-redouble'),
      options.onBidRedouble
    )
  }
}