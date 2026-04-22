import type { AppBootstrap } from '../bootstrap'
import type {
  Card,
  CompletedTrick,
  Declaration,
  GameState,
  Suit,
  WinningBid,
} from '../../core/state/gameTypes'
import { resolveBeloteDeclarationForPlay } from '../../core/rules/resolveBeloteDeclarationForPlay'

type PendingPromptOption = {
  id: string
  title: string
  description: string
  declarations: Declaration[]
  defaultChecked: boolean
}

type PendingBelotePrompt = {
  cardId: string
  options: PendingPromptOption[]
}

export type BelotePromptController = {
  handlePlayCard(cardId: string): boolean
  registerAutoDeclarationsForPlay(cardId: string): void
  hasPendingPrompt(): boolean
  renderPendingPrompt(): void
}

const SUIT_ORDER: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs']
const RANK_ORDER: Card['rank'][] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']

function getCompletedTricks(state: GameState): CompletedTrick[] {
  return state.playing?.completedTricks ?? []
}

function getWinningBid(state: GameState): WinningBid {
  return state.bidding?.winningBid ?? null
}

function isNoTrumpsWinningBid(winningBid: WinningBid): boolean {
  return winningBid?.contract === 'no-trumps'
}

function shouldDisableDeclarationsForCurrentContract(state: GameState): boolean {
  return isNoTrumpsWinningBid(getWinningBid(state))
}

function getBottomHand(state: GameState): Card[] {
  return state.hands.bottom ?? []
}

function getRankIndex(rank: Card['rank']): number {
  return RANK_ORDER.indexOf(rank)
}

function sortCardsByRank(cards: Card[]): Card[] {
  return [...cards].sort((leftCard, rightCard) => {
    return getRankIndex(leftCard.rank) - getRankIndex(rightCard.rank)
  })
}

function formatSuitLabel(suit: Suit): string {
  if (suit === 'spades') return 'Пика'
  if (suit === 'hearts') return 'Купа'
  if (suit === 'diamonds') return 'Каро'
  return 'Спатия'
}

function formatRankLabel(rank: Card['rank']): string {
  if (rank === 'J') return 'Вале'
  if (rank === 'Q') return 'Дама'
  if (rank === 'K') return 'Поп'
  if (rank === 'A') return 'Асо'
  return rank
}

function formatCardsLabel(cards: Card[]): string {
  return cards.map((card) => formatRankLabel(card.rank)).join(' - ')
}

function getSuitSymbol(suit: Suit): string {
  if (suit === 'spades') return '♠'
  if (suit === 'hearts') return '♥'
  if (suit === 'diamonds') return '♦'
  return '♣'
}

function getSuitColor(suit: Suit): string {
  if (suit === 'hearts' || suit === 'diamonds') {
    return '#ef4444'
  }

  return '#f8fafc'
}

function getCardRankShortLabel(rank: Card['rank']): string {
  return rank
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isInitialRoundAnnouncementMoment(state: GameState): boolean {
  if (state.phase !== 'playing') {
    return false
  }

  return getCompletedTricks(state).length === 0
}

function getDeclarationCardKey(declaration: Declaration): string {
  return declaration.cards
    .map((card) => card.id)
    .sort((leftId, rightId) => leftId.localeCompare(rightId))
    .join('|')
}

function hasSameDeclaration(
  declaration: Declaration,
  candidate: Declaration
): boolean {
  return (
    declaration.seat === candidate.seat &&
    declaration.type === candidate.type &&
    declaration.points === candidate.points &&
    declaration.suit === candidate.suit &&
    declaration.highRank === candidate.highRank &&
    getDeclarationCardKey(declaration) === getDeclarationCardKey(candidate)
  )
}

function getSequencePoints(length: number): number {
  if (length >= 5) {
    return 100
  }

  if (length === 4) {
    return 50
  }

  return 20
}

function getSequenceTitle(length: number): string {
  if (length >= 5) {
    return '100'
  }

  if (length === 4) {
    return '50'
  }

  return 'Терца'
}

function createSequenceDeclaration(
  state: GameState,
  cards: Card[]
): Declaration {
  const sortedCards = sortCardsByRank(cards)

  return {
    seat: 'bottom',
    team: state.players.bottom.team,
    type: 'sequence',
    points: getSequencePoints(sortedCards.length),
    cards: sortedCards,
    suit: sortedCards[0]?.suit ?? 'spades',
    highRank: sortedCards[sortedCards.length - 1]?.rank ?? null,
    announced: true,
    valid: true,
  }
}

function getSquarePoints(rank: Card['rank']): number {
  if (rank === 'J') {
    return 200
  }

  if (rank === '9') {
    return 150
  }

  if (rank === '10' || rank === 'A' || rank === 'K' || rank === 'Q') {
    return 100
  }

  return 0
}

function createSquareDeclaration(
  state: GameState,
  cards: Card[]
): Declaration {
  const sortedCards = sortCardsByRank(cards)
  const rank = sortedCards[0]?.rank ?? null

  return {
    seat: 'bottom',
    team: state.players.bottom.team,
    type: 'square',
    points: getSquarePoints(rank ?? '7'),
    cards: sortedCards,
    suit: sortedCards[0]?.suit ?? 'spades',
    highRank: rank,
    announced: true,
    valid: true,
  }
}

function buildSequenceDeclarations(state: GameState): Declaration[] {
  if (shouldDisableDeclarationsForCurrentContract(state)) {
    return []
  }

  const hand = getBottomHand(state)
  const declarations: Declaration[] = []

  for (const suit of SUIT_ORDER) {
    const suitCards = sortCardsByRank(hand.filter((card) => card.suit === suit))

    if (suitCards.length < 3) {
      continue
    }

    let currentRun: Card[] = []

    function flushCurrentRun(): void {
      if (currentRun.length >= 3) {
        declarations.push(createSequenceDeclaration(state, currentRun))
      }

      currentRun = []
    }

    for (const card of suitCards) {
      if (currentRun.length === 0) {
        currentRun = [card]
        continue
      }

      const previousCard = currentRun[currentRun.length - 1]
      const indexDifference =
        getRankIndex(card.rank) - getRankIndex(previousCard.rank)

      if (indexDifference === 1) {
        currentRun.push(card)
        continue
      }

      flushCurrentRun()
      currentRun = [card]
    }

    flushCurrentRun()
  }

  return declarations
}

function buildSquareDeclarations(state: GameState): Declaration[] {
  if (shouldDisableDeclarationsForCurrentContract(state)) {
    return []
  }

  const hand = getBottomHand(state)
  const cardsByRank = new Map<Card['rank'], Card[]>()

  for (const card of hand) {
    const rankCards = cardsByRank.get(card.rank) ?? []
    rankCards.push(card)
    cardsByRank.set(card.rank, rankCards)
  }

  const declarations: Declaration[] = []

  for (const rank of RANK_ORDER) {
    const cards = cardsByRank.get(rank) ?? []
    const points = getSquarePoints(rank)

    if (cards.length === 4 && points > 0) {
      declarations.push(createSquareDeclaration(state, cards))
    }
  }

  return declarations
}

function createBelotePromptOption(declaration: Declaration): PendingPromptOption {
  const cards = sortCardsByRank(declaration.cards)
  const firstCard = cards[0]
  const secondCard = cards[1]

  return {
    id: `belote-${declaration.suit ?? 'unknown'}`,
    title: 'Белот',
    description: `${formatSuitLabel(declaration.suit ?? 'spades')} • ${formatRankLabel(firstCard?.rank ?? 'Q')} и ${formatRankLabel(secondCard?.rank ?? 'K')} • 20 точки`,
    declarations: [declaration],
    defaultChecked: true,
  }
}

function createSequencePromptOption(declaration: Declaration): PendingPromptOption {
  const cards = sortCardsByRank(declaration.cards)
  const title = getSequenceTitle(cards.length)
  const description = `${formatSuitLabel(cards[0]?.suit ?? 'spades')} • ${formatCardsLabel(cards)} • ${declaration.points} точки`

  return {
    id: `sequence-${cards.map((card) => card.id).join('-')}`,
    title,
    description,
    declarations: [declaration],
    defaultChecked: true,
  }
}

function createSquarePromptOption(declaration: Declaration): PendingPromptOption {
  const rank = declaration.cards[0]?.rank ?? '7'
  const description = `${formatCardsLabel(sortCardsByRank(declaration.cards))} • ${declaration.points} точки`

  return {
    id: `square-${rank}`,
    title: `Каре ${formatRankLabel(rank)}`,
    description,
    declarations: [declaration],
    defaultChecked: true,
  }
}

function resolveBelotePromptOption(
  state: GameState,
  cardId: string
): PendingPromptOption | null {
  const beloteDeclaration = resolveBeloteDeclarationForPlay({
    state,
    seat: 'bottom',
    cardId,
  })

  if (!beloteDeclaration) {
    return null
  }

  return createBelotePromptOption(beloteDeclaration)
}

function resolveRoundDeclarationPromptOptions(state: GameState): PendingPromptOption[] {
  if (!isInitialRoundAnnouncementMoment(state)) {
    return []
  }

  if (shouldDisableDeclarationsForCurrentContract(state)) {
    return []
  }

  const sequenceOptions = buildSequenceDeclarations(state).map((declaration) =>
    createSequencePromptOption(declaration)
  )

  const squareOptions = buildSquareDeclarations(state).map((declaration) =>
    createSquarePromptOption(declaration)
  )

  return [...sequenceOptions, ...squareOptions]
}

function resolvePromptOptions(state: GameState, cardId: string): PendingPromptOption[] {
  if (shouldDisableDeclarationsForCurrentContract(state)) {
    return []
  }

  const options: PendingPromptOption[] = []
  const roundDeclarationOptions = resolveRoundDeclarationPromptOptions(state)

  for (const option of roundDeclarationOptions) {
    options.push(option)
  }

  const beloteOption = resolveBelotePromptOption(state, cardId)

  if (beloteOption) {
    options.push(beloteOption)
  }

  return options.filter((option, optionIndex, allOptions) => {
    return (
      allOptions.findIndex(
        (currentOption) =>
          currentOption.title === option.title &&
          currentOption.description === option.description
      ) === optionIndex
    )
  })
}

function getPendingBelotePromptKey(prompt: PendingBelotePrompt): string {
  const optionKeys = prompt.options.map((option) => {
    const declarationKeys = option.declarations
      .map((declaration) => {
        return [
          declaration.type,
          declaration.points,
          declaration.suit ?? '',
          declaration.highRank ?? '',
          getDeclarationCardKey(declaration),
        ].join(':')
      })
      .join(',')

    return `${option.id}:${option.defaultChecked ? '1' : '0'}:${declarationKeys}`
  })

  return `${prompt.cardId}::${optionKeys.join('|')}`
}

function getDefaultDeclarationsFromPrompt(
  prompt: PendingBelotePrompt | null
): Declaration[] {
  if (!prompt) {
    return []
  }

  return prompt.options.flatMap((option) => {
    if (!option.defaultChecked) {
      return []
    }

    return option.declarations
  })
}

function renderPromptOptionValue(option: PendingPromptOption): string {
  const declaration = option.declarations[0]

  if (!declaration) {
    return ''
  }

  if (declaration.type === 'belote') {
    const suit = declaration.suit ?? 'spades'
    const suitSymbol = getSuitSymbol(suit)
    const suitColor = getSuitColor(suit)

    return `
      <span style="color: ${suitColor}; font-size: 52px; line-height: 1; font-weight: 800;">
        ${suitSymbol}
      </span>
      <span style="color: ${suitColor}; font-size: 32px; line-height: 1; font-weight: 800; letter-spacing: 0.08em;">
        Q K
      </span>
    `
  }

  if (declaration.type === 'square') {
    const rank = getCardRankShortLabel(declaration.cards[0]?.rank ?? '7')

    return `
      <span style="color: #f8fafc; font-size: 32px; line-height: 1; font-weight: 800; letter-spacing: 0.12em; white-space: nowrap;">
        ${escapeHtml(rank)} ${escapeHtml(rank)} ${escapeHtml(rank)} ${escapeHtml(rank)}
      </span>
    `
  }

  const cards = sortCardsByRank(declaration.cards)
  const suit = cards[0]?.suit ?? declaration.suit ?? 'spades'
  const suitSymbol = getSuitSymbol(suit)
  const suitColor = getSuitColor(suit)
  const rankMarkup = cards
    .map((card) => escapeHtml(getCardRankShortLabel(card.rank)))
    .join(' ')

  return `
    <span style="color: ${suitColor}; font-size: 52px; line-height: 1; font-weight: 800;">
      ${suitSymbol}
    </span>
    <span style="color: ${suitColor}; font-size: 32px; line-height: 1; font-weight: 800; letter-spacing: 0.08em; white-space: nowrap;">
      ${rankMarkup}
    </span>
  `
}

export function createBelotePromptController(params: {
  app: AppBootstrap
  render: () => void
}): BelotePromptController {
  const { app, render } = params

  let pendingBelotePrompt: PendingBelotePrompt | null = null
  let renderedPromptKey: string | null = null

  function removeBelotePrompt(): void {
    document.querySelector('[data-belote-prompt-root]')?.remove()
    renderedPromptKey = null
  }

  function registerDeclarations(declarations: Declaration[]): void {
    if (declarations.length === 0) {
      return
    }

    app.engine.updateState((currentState) => {
      const nextDeclarations = [...currentState.declarations]

      for (const declaration of declarations) {
        const alreadyExists = nextDeclarations.some((existingDeclaration) =>
          hasSameDeclaration(existingDeclaration, declaration)
        )

        if (!alreadyExists) {
          nextDeclarations.push(declaration)
        }
      }

      return {
        ...currentState,
        declarations: nextDeclarations,
      }
    })
  }

  function resolveBelotePrompt(cardId: string): PendingBelotePrompt | null {
    const state = app.engine.getState()

    if (state.phase !== 'playing') {
      return null
    }

    const options = resolvePromptOptions(state, cardId)

    if (options.length === 0) {
      return null
    }

    return {
      cardId,
      options,
    }
  }

  function hasPendingPrompt(): boolean {
    return pendingBelotePrompt !== null
  }

  function registerAutoDeclarationsForPlay(cardId: string): void {
    const prompt = resolveBelotePrompt(cardId)

    if (!prompt) {
      return
    }

    registerDeclarations(getDefaultDeclarationsFromPrompt(prompt))
  }

  function renderPendingPrompt(): void {
    if (!pendingBelotePrompt) {
      removeBelotePrompt()
      return
    }

    const currentState = app.engine.getState()

    if (currentState.phase !== 'playing') {
      pendingBelotePrompt = null
      removeBelotePrompt()
      return
    }

    const promptKey = getPendingBelotePromptKey(pendingBelotePrompt)
    const existingRoot = document.querySelector('[data-belote-prompt-root]')

    if (existingRoot && renderedPromptKey === promptKey) {
      return
    }

    removeBelotePrompt()
    renderedPromptKey = promptKey

    const overlay = document.createElement('div')
    overlay.setAttribute('data-belote-prompt-root', 'true')
    overlay.innerHTML = `
      <div
        style="
          position: fixed;
          inset: 0;
          background: rgba(6, 16, 32, 0.52);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          z-index: 9999;
        "
      >
        <div
          style="
            width: min(92vw, 640px);
            background: rgba(14, 33, 51, 0.96);
            border: 2px solid rgba(243, 170, 28, 0.92);
            border-radius: 16px;
            padding: 20px 18px 18px;
            box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
            color: #f8fafc;
            font-family: Arial, Helvetica, sans-serif;
          "
        >
          <div
            style="
              text-align: center;
              font-size: clamp(32px, 4vw, 44px);
              line-height: 1.05;
              font-weight: 800;
              letter-spacing: 0.02em;
              margin-bottom: 18px;
              text-transform: uppercase;
            "
          >
            Избери декларация
          </div>

          <div
            style="
              display: flex;
              flex-direction: column;
              margin-bottom: 18px;
              border-top: 1px solid rgba(243, 170, 28, 0.3);
            "
          >
            ${pendingBelotePrompt.options
              .map(
                (option) => `
                  <label
                    style="
                      display: grid;
                      grid-template-columns: 46px minmax(0, 1fr) auto;
                      align-items: center;
                      gap: 16px;
                      min-height: 108px;
                      padding: 16px 10px;
                      border-bottom: 1px solid rgba(243, 170, 28, 0.3);
                      cursor: pointer;
                    "
                  >
                    <input
                      type="checkbox"
                      data-belote-announce-checkbox
                      value="${escapeHtml(option.id)}"
                      ${option.defaultChecked ? 'checked' : ''}
                      style="
                        width: 30px;
                        height: 30px;
                        margin: 0;
                        cursor: pointer;
                        accent-color: #60a5fa;
                      "
                    />

                    <div
                      style="
                        min-width: 0;
                        font-size: clamp(28px, 3.4vw, 44px);
                        line-height: 1;
                        font-weight: 800;
                        color: #f8fafc;
                        text-transform: uppercase;
                      "
                    >
                      ${escapeHtml(option.title)}
                    </div>

                    <div
                      style="
                        display: flex;
                        align-items: center;
                        justify-content: flex-end;
                        gap: 10px;
                        min-width: 0;
                        text-align: right;
                      "
                    >
                      ${renderPromptOptionValue(option)}
                    </div>
                  </label>
                `
              )
              .join('')}
          </div>

          <button
            type="button"
            data-belote-continue-button
            style="
              width: 100%;
              min-height: 84px;
              border: 0;
              border-radius: 14px;
              padding: 12px 18px;
              background: #f5a623;
              color: #fff7ed;
              font-size: clamp(28px, 4vw, 50px);
              line-height: 1;
              font-weight: 800;
              letter-spacing: 0.02em;
              text-transform: uppercase;
              cursor: pointer;
              box-shadow: inset 0 -4px 0 rgba(0, 0, 0, 0.12);
            "
          >
            Продължи
          </button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    const continueButton = overlay.querySelector<HTMLButtonElement>(
      '[data-belote-continue-button]'
    )
    const announceCheckboxes = Array.from(
      overlay.querySelectorAll<HTMLInputElement>('[data-belote-announce-checkbox]')
    )

    continueButton?.addEventListener('click', () => {
      const prompt = pendingBelotePrompt

      pendingBelotePrompt = null
      removeBelotePrompt()

      if (!prompt) {
        render()
        return
      }

      const selectedOptionIds = new Set(
        announceCheckboxes
          .filter((checkbox) => checkbox.checked)
          .map((checkbox) => checkbox.value)
      )

      const selectedDeclarations = prompt.options.flatMap((option) => {
        if (!selectedOptionIds.has(option.id)) {
          return []
        }

        return option.declarations
      })

      registerDeclarations(selectedDeclarations)
      app.engine.submitPlayCard(prompt.cardId)
      render()
    })
  }

  function handlePlayCard(cardId: string): boolean {
    const belotePrompt = resolveBelotePrompt(cardId)

    if (!belotePrompt) {
      return false
    }

    pendingBelotePrompt = belotePrompt
    renderPendingPrompt()
    return true
  }

  return {
    handlePlayCard,
    registerAutoDeclarationsForPlay,
    hasPendingPrompt,
    renderPendingPrompt,
  }
}
