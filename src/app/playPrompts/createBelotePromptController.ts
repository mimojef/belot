import type { AppBootstrap } from '../bootstrap'
import type {
  Card,
  CompletedTrick,
  Declaration,
  GameState,
  Suit,
} from '../../core/state/gameTypes'
import { getValidCardsForSeat } from '../../core/rules/getValidCardsForSeat'

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
  renderPendingPrompt(): void
}

const SUIT_ORDER: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs']
const RANK_ORDER: Card['rank'][] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']

function getCounterpartRank(rank: Card['rank']): Card['rank'] | null {
  if (rank === 'Q') {
    return 'K'
  }

  if (rank === 'K') {
    return 'Q'
  }

  return null
}

function getCompletedTricks(state: GameState): CompletedTrick[] {
  return state.playing?.completedTricks ?? []
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

function isBeloteContract(state: GameState, suit: Suit): boolean {
  const winningBid = state.bidding.winningBid

  if (!winningBid) {
    return false
  }

  if (winningBid.contract === 'all-trumps') {
    return true
  }

  if (winningBid.contract === 'suit' && winningBid.trumpSuit === suit) {
    return true
  }

  return false
}

function isAllowedBeloteAnnouncementMoment(
  state: GameState,
  selectedCard: Card
): boolean {
  if (state.phase !== 'playing') {
    return false
  }

  const validCards = getValidCardsForSeat(state, 'bottom')

  return validCards.some((card) => card.id === selectedCard.id)
}

function isInitialRoundAnnouncementMoment(state: GameState): boolean {
  if (state.phase !== 'playing') {
    return false
  }

  return getCompletedTricks(state).length === 0
}

function hasBeloteAlreadyDeclared(state: GameState, suit: Suit): boolean {
  return state.declarations.some(
    (declaration) =>
      declaration.type === 'belote' &&
      declaration.seat === 'bottom' &&
      declaration.suit === suit &&
      declaration.valid
  )
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

function createBeloteDeclaration(
  state: GameState,
  selectedCard: Card,
  counterpartCard: Card
): Declaration {
  return {
    seat: 'bottom',
    team: state.players.bottom.team,
    type: 'belote',
    points: 20,
    cards: [selectedCard, counterpartCard],
    suit: selectedCard.suit,
    highRank: null,
    announced: true,
    valid: true,
  }
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

function createBelotePromptOption(
  state: GameState,
  selectedCard: Card,
  counterpartCard: Card
): PendingPromptOption {
  const declaration = createBeloteDeclaration(state, selectedCard, counterpartCard)

  return {
    id: `belote-${selectedCard.suit}`,
    title: 'Белот',
    description: `${formatSuitLabel(selectedCard.suit)} • ${formatRankLabel(selectedCard.rank)} и ${formatRankLabel(counterpartCard.rank)} • 20 точки`,
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
  const hand = getBottomHand(state)
  const selectedCard = hand.find((card) => card.id === cardId)

  if (!selectedCard) {
    return null
  }

  const counterpartRank = getCounterpartRank(selectedCard.rank)

  if (!counterpartRank) {
    return null
  }

  if (!isBeloteContract(state, selectedCard.suit)) {
    return null
  }

  if (!isAllowedBeloteAnnouncementMoment(state, selectedCard)) {
    return null
  }

  const counterpartCard = hand.find(
    (card) => card.suit === selectedCard.suit && card.rank === counterpartRank
  )

  if (!counterpartCard) {
    return null
  }

  if (hasBeloteAlreadyDeclared(state, selectedCard.suit)) {
    return null
  }

  return createBelotePromptOption(state, selectedCard, counterpartCard)
}

function resolveRoundDeclarationPromptOptions(state: GameState): PendingPromptOption[] {
  if (!isInitialRoundAnnouncementMoment(state)) {
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

export function createBelotePromptController(params: {
  app: AppBootstrap
  render: () => void
}): BelotePromptController {
  const { app, render } = params

  let pendingBelotePrompt: PendingBelotePrompt | null = null

  function removeBelotePrompt(): void {
    document.querySelector('[data-belote-prompt-root]')?.remove()
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

  function renderPendingPrompt(): void {
    removeBelotePrompt()

    if (!pendingBelotePrompt) {
      return
    }

    const currentState = app.engine.getState()

    if (currentState.phase !== 'playing') {
      pendingBelotePrompt = null
      return
    }

    const overlay = document.createElement('div')
    overlay.setAttribute('data-belote-prompt-root', 'true')
    overlay.innerHTML = `
      <div
        style="
          position: fixed;
          inset: 0;
          background: rgba(2, 6, 23, 0.72);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          z-index: 9999;
        "
      >
        <div
          style="
            width: min(92vw, 520px);
            background: rgba(15, 23, 42, 0.98);
            border: 1px solid rgba(148, 163, 184, 0.22);
            border-radius: 18px;
            padding: 22px;
            box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
            color: #f8fafc;
            font-family: Arial, Helvetica, sans-serif;
          "
        >
          <div
            style="
              font-size: 24px;
              font-weight: 800;
              margin-bottom: 8px;
            "
          >
            Обяви
          </div>

          <div
            style="
              font-size: 15px;
              line-height: 1.5;
              color: #cbd5e1;
              margin-bottom: 16px;
            "
          >
            Намерени са валидни анонси за тази ръка. Можеш да оставиш чекнати повече от една обява.
          </div>

          <div
            style="
              display: flex;
              flex-direction: column;
              gap: 10px;
              margin-bottom: 18px;
            "
          >
            ${pendingBelotePrompt.options
              .map(
                (option) => `
                  <label
                    style="
                      display: flex;
                      align-items: flex-start;
                      gap: 12px;
                      padding: 12px 14px;
                      border-radius: 14px;
                      background: rgba(30, 41, 59, 0.72);
                      border: 1px solid rgba(148, 163, 184, 0.16);
                      cursor: pointer;
                    "
                  >
                    <input
                      type="checkbox"
                      data-belote-announce-checkbox
                      value="${option.id}"
                      ${option.defaultChecked ? 'checked' : ''}
                      style="
                        width: 18px;
                        height: 18px;
                        margin-top: 2px;
                        cursor: pointer;
                        flex: 0 0 auto;
                      "
                    />

                    <div style="display: flex; flex-direction: column; gap: 4px;">
                      <div
                        style="
                          font-size: 16px;
                          font-weight: 800;
                          color: #f8fafc;
                        "
                      >
                        ${option.title}
                      </div>

                      <div
                        style="
                          font-size: 14px;
                          line-height: 1.45;
                          color: #cbd5e1;
                        "
                      >
                        ${option.description}
                      </div>
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
              border: 0;
              border-radius: 12px;
              padding: 13px 16px;
              background: #22c55e;
              color: #052e16;
              font-size: 15px;
              font-weight: 800;
              cursor: pointer;
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
    renderPendingPrompt,
  }
}