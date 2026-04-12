import type {
  GameState,
  BaseRoundScoreResult,
  RoundOutcomeResult,
  RoundScore,
  Team,
  Card,
} from './gameTypes'
import { buildBeloteScore, buildComparableDeclarationsScore } from '../rules/declarationsRules'
import { calculateRoundOutcome } from '../rules/calculateRoundOutcome'
import { buildOfficialRoundScore } from '../rules/buildOfficialRoundScore'

type BaseRoundScore = BaseRoundScoreResult
type Outcome = RoundOutcomeResult

const SCORING_AUTO_ADVANCE_MS = 5000

const SEAT_VALUES = ['bottom', 'right', 'top', 'left'] as const
const RED_SUITS = new Set(['hearts', 'diamonds'])
const SEQUENCE_RANK_ORDER = ['7', '8', '9', 'J', 'Q', 'K', '10', 'A'] as const

type DeclarationTextColor = 'red' | 'black'

type DeclarationKind = 'belote' | 'sequence' | 'square'

type SeatValue = (typeof SEAT_VALUES)[number]

type UnknownRecord = Record<string, unknown>

type ExtractedDeclaration = {
  key: string
  team: Team
  seat: SeatValue | null
  kind: DeclarationKind
  suit: string | null
  cards: Card[]
  rankText: string
  points: number
}

export type ScoringTextPart = {
  text: string
  color: DeclarationTextColor
}

export type ScoringBeloteDisplayItem = {
  key: string
  suit: string | null
  suitSymbol: string
  color: DeclarationTextColor
}

export type ScoringDeclarationDisplayItem = {
  key: string
  kind: 'sequence' | 'square'
  suit: string | null
  suitSymbol: string
  rankText: string
  displayText: string
  color: DeclarationTextColor
  points: number
  displayParts: ScoringTextPart[]
}

export type ScoringViewState = {
  isVisible: boolean
  hasBaseRoundScore: boolean
  hasOutcome: boolean
  winningBidLabel: string
  winningBidOwnerLabel: string
  teamARawPoints: number
  teamBRawPoints: number
  teamATricksWon: number
  teamBTricksWon: number
  teamADeclarationPoints: number
  teamBDeclarationPoints: number
  teamABelotePoints: number
  teamBBelotePoints: number
  teamASumPoints: number
  teamBSumPoints: number
  expectedTotalPoints: number
  actualTotalPoints: number
  isComplete: boolean
  isPointTotalValid: boolean
  lastTrickWinnerLabel: string
  bidderTeamLabel: string
  defenderTeamLabel: string
  bidderPoints: number
  defenderPoints: number
  winningTeamLabel: string
  outcomeLabel: string
  outcomeShortLabel: string
  isInside: boolean
  isMade: boolean
  isTie: boolean
  officialRoundTeamA: number
  officialRoundTeamB: number
  matchTotalTeamA: number
  matchTotalTeamB: number
  carryOverTeamA: number
  carryOverTeamB: number
  hasDouble: boolean
  hasRedouble: boolean
  counterMultiplier: number
  countdownSeconds: number
  autoAdvanceCountdownSeconds: number
  teamABeloteItems: ScoringBeloteDisplayItem[]
  teamBBeloteItems: ScoringBeloteDisplayItem[]
  teamADeclarationItems: ScoringDeclarationDisplayItem[]
  teamBDeclarationItems: ScoringDeclarationDisplayItem[]
}

function createZeroRoundScore(): RoundScore {
  return {
    teamA: 0,
    teamB: 0,
  }
}

function formatSuitLabel(suit: string | null | undefined): string {
  if (suit === 'spades') return 'Пика'
  if (suit === 'hearts') return 'Купа'
  if (suit === 'diamonds') return 'Каро'
  if (suit === 'clubs') return 'Спатия'
  return '—'
}

function formatSeatLabel(seat: string | null | undefined): string {
  if (seat === 'bottom') return 'Долу'
  if (seat === 'right') return 'Дясно'
  if (seat === 'top') return 'Горе'
  if (seat === 'left') return 'Ляво'
  return '—'
}

function formatTeamLabel(team: 'A' | 'B' | null | undefined): string {
  if (team === 'A') return 'Отбор A'
  if (team === 'B') return 'Отбор B'
  return '—'
}

function resolveWinningBidLabel(
  winningBid: GameState['bidding']['winningBid']
): string {
  if (!winningBid) {
    return 'Няма обява'
  }

  if (winningBid.contract === 'suit') {
    return formatSuitLabel(winningBid.trumpSuit)
  }

  if (winningBid.contract === 'all-trumps') {
    return 'Всичко коз'
  }

  if (winningBid.contract === 'no-trumps') {
    return 'Без коз'
  }

  return 'Няма обява'
}

function resolveOutcomeLabel(
  outcome: 'made' | 'inside' | 'tie' | 'unknown'
): string {
  if (outcome === 'made') return 'Обявилият е изкарал'
  if (outcome === 'inside') return 'Обявилият е вътре'
  if (outcome === 'tie') return 'Равна игра'
  return 'Неизвестен резултат'
}

function resolveOutcomeShortLabel(
  outcome: 'made' | 'inside' | 'tie' | 'unknown'
): string {
  if (outcome === 'made') return 'Изкарана'
  if (outcome === 'inside') return 'Вътре'
  if (outcome === 'tie') return 'Равна'
  return '—'
}

function getTeamBySeat(
  seat: GameState['bidding']['winningBid'] extends infer T ? T : never
): Team | null {
  if (!seat || typeof seat !== 'object' || !('seat' in seat)) {
    return null
  }

  const winningBidSeat = seat.seat

  if (winningBidSeat === 'bottom' || winningBidSeat === 'top') {
    return 'A'
  }

  if (winningBidSeat === 'left' || winningBidSeat === 'right') {
    return 'B'
  }

  return null
}

function resolveWinningBidOwnerLabel(
  winningBid: GameState['bidding']['winningBid']
): string {
  const team = getTeamBySeat(winningBid)

  if (team === 'A') {
    return 'НИЕ'
  }

  if (team === 'B') {
    return 'ВИЕ'
  }

  return '—'
}

function resolveCounterMultiplier(
  winningBid: GameState['bidding']['winningBid']
): number {
  if (!winningBid) {
    return 1
  }

  if (winningBid.redoubled) {
    return 4
  }

  if (winningBid.doubled) {
    return 2
  }

  return 1
}

function getNowForTimestamp(timestamp: number | null | undefined): number {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now()
    }

    return Date.now()
  }

  if (timestamp > 1_000_000_000_000) {
    return Date.now()
  }

  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }

  return Date.now()
}

function resolveScoringCountdownSeconds(state: GameState): number {
  if (state.phase !== 'scoring') {
    return 5
  }

  const phaseEnteredAt =
    typeof state.phaseEnteredAt === 'number' && Number.isFinite(state.phaseEnteredAt)
      ? state.phaseEnteredAt
      : null

  if (phaseEnteredAt === null) {
    return 5
  }

  const now = getNowForTimestamp(phaseEnteredAt)
  const elapsedMs = Math.max(0, now - phaseEnteredAt)
  const remainingMs = Math.max(0, SCORING_AUTO_ADVANCE_MS - elapsedMs)

  return Math.ceil(remainingMs / 1000)
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as UnknownRecord
}

function isSeatValue(value: unknown): value is SeatValue {
  return typeof value === 'string' && SEAT_VALUES.includes(value as SeatValue)
}

function getTeamFromSeatValue(seat: SeatValue | null): Team | null {
  if (seat === 'bottom' || seat === 'top') {
    return 'A'
  }

  if (seat === 'left' || seat === 'right') {
    return 'B'
  }

  return null
}

function detectSeatFromString(value: string): SeatValue | null {
  const normalized = value.trim().toLowerCase()

  if (normalized.includes('bottom')) return 'bottom'
  if (normalized.includes('right')) return 'right'
  if (normalized.includes('top')) return 'top'
  if (normalized.includes('left')) return 'left'

  return null
}

function resolveSeatFromNode(node: UnknownRecord, path: string[]): SeatValue | null {
  const directSeatKeys = [
    'seat',
    'playerSeat',
    'ownerSeat',
    'declaredBySeat',
    'announcedBySeat',
    'winningSeat',
  ]

  for (const key of directSeatKeys) {
    const value = node[key]

    if (isSeatValue(value)) {
      return value
    }

    if (typeof value === 'string') {
      const detected = detectSeatFromString(value)
      if (detected) {
        return detected
      }
    }
  }

  for (let index = path.length - 1; index >= 0; index -= 1) {
    const detected = detectSeatFromString(path[index])
    if (detected) {
      return detected
    }
  }

  return null
}

function isCardLike(value: unknown): value is Card {
  const record = asRecord(value)

  if (!record) {
    return false
  }

  return typeof record.rank === 'string' && typeof record.suit === 'string'
}

function extractCardsFromNode(node: UnknownRecord): Card[] {
  const candidateKeys = [
    'cards',
    'declarationCards',
    'selectedCards',
    'sequenceCards',
    'squareCards',
    'beloteCards',
  ]

  for (const key of candidateKeys) {
    const value = node[key]

    if (Array.isArray(value) && value.every(isCardLike)) {
      return value
    }
  }

  return []
}

function getStringFromNode(node: UnknownRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = node[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }

  return null
}

function resolveSuitSymbol(suit: string | null | undefined): string {
  if (suit === 'spades') return '♠'
  if (suit === 'hearts') return '♥'
  if (suit === 'diamonds') return '♦'
  if (suit === 'clubs') return '♣'
  return ''
}

function resolveSuitColor(suit: string | null | undefined): DeclarationTextColor {
  return suit && RED_SUITS.has(suit) ? 'red' : 'black'
}

function resolveSuitFromCards(cards: Card[]): string | null {
  if (cards.length === 0) {
    return null
  }

  const firstSuit = cards[0]?.suit ?? null

  if (!firstSuit) {
    return null
  }

  const allSameSuit = cards.every((card) => card.suit === firstSuit)
  return allSameSuit ? firstSuit : firstSuit
}

function resolveRankOrderIndex(rank: string): number {
  const index = SEQUENCE_RANK_ORDER.indexOf(rank as (typeof SEQUENCE_RANK_ORDER)[number])
  return index === -1 ? 999 : index
}

function sortCardsForSequence(cards: Card[]): Card[] {
  return [...cards].sort((left, right) => {
    return resolveRankOrderIndex(left.rank) - resolveRankOrderIndex(right.rank)
  })
}

function buildSequenceRankText(cards: Card[]): string {
  return sortCardsForSequence(cards)
    .map((card) => card.rank)
    .join('')
}

function buildSquareRankText(cards: Card[]): string {
  if (cards.length === 0) {
    return ''
  }

  return cards[0]?.rank ?? ''
}

function calculateDeclarationPoints(kind: DeclarationKind, cards: Card[]): number {
  if (kind === 'belote') {
    return 20
  }

  if (kind === 'square') {
    const rank = cards[0]?.rank ?? ''

    if (rank === 'J') return 200
    if (rank === '9') return 150
    if (rank === '10' || rank === 'A' || rank === 'K' || rank === 'Q') return 100

    return 0
  }

  if (kind === 'sequence') {
    if (cards.length === 3) return 20
    if (cards.length === 4) return 50
    if (cards.length >= 5) return 100
  }

  return 0
}

function isBeloteCards(cards: Card[]): boolean {
  if (cards.length !== 2) {
    return false
  }

  const sameSuit = cards[0]?.suit === cards[1]?.suit
  const ranks = new Set(cards.map((card) => card.rank))

  return sameSuit && ranks.has('Q') && ranks.has('K')
}

function isSquareCards(cards: Card[]): boolean {
  if (cards.length !== 4) {
    return false
  }

  const firstRank = cards[0]?.rank ?? null
  return Boolean(firstRank) && cards.every((card) => card.rank === firstRank)
}

function isSequenceCards(cards: Card[]): boolean {
  if (cards.length < 3) {
    return false
  }

  const suit = cards[0]?.suit ?? null

  if (!suit || !cards.every((card) => card.suit === suit)) {
    return false
  }

  const sorted = sortCardsForSequence(cards)
  for (let index = 1; index < sorted.length; index += 1) {
    const previousIndex = resolveRankOrderIndex(sorted[index - 1].rank)
    const currentIndex = resolveRankOrderIndex(sorted[index].rank)

    if (currentIndex !== previousIndex + 1) {
      return false
    }
  }

  return true
}

function resolveDeclarationKind(node: UnknownRecord, cards: Card[]): DeclarationKind | null {
  const typeText = [
    getStringFromNode(node, ['type']) ?? '',
    getStringFromNode(node, ['kind']) ?? '',
    getStringFromNode(node, ['category']) ?? '',
    getStringFromNode(node, ['label']) ?? '',
    getStringFromNode(node, ['name']) ?? '',
    getStringFromNode(node, ['declarationType']) ?? '',
  ]
    .join(' ')
    .toLowerCase()

  if (typeText.includes('belote')) {
    return 'belote'
  }

  if (typeText.includes('square') || typeText.includes('four-of-a-kind') || typeText.includes('carre')) {
    return 'square'
  }

  if (typeText.includes('sequence')) {
    return 'sequence'
  }

  if (isBeloteCards(cards)) {
    return 'belote'
  }

  if (isSquareCards(cards)) {
    return 'square'
  }

  if (isSequenceCards(cards)) {
    return 'sequence'
  }

  return null
}

function shouldSkipPath(path: string[]): boolean {
  const joined = path.join('.').toLowerCase()

  return (
    joined.includes('prompt') ||
    joined.includes('option') ||
    joined.includes('candidate') ||
    joined.includes('possible') ||
    joined.includes('preview') ||
    joined.includes('available')
  )
}

function isExplicitlyRejected(node: UnknownRecord): boolean {
  const falseKeys = ['declared', 'announced', 'confirmed', 'selected', 'isDeclared', 'isAnnounced']

  for (const key of falseKeys) {
    if (key in node && node[key] === false) {
      return true
    }
  }

  return false
}

function resolveDeclarationEntry(
  node: UnknownRecord,
  path: string[]
): ExtractedDeclaration | null {
  if (shouldSkipPath(path) || isExplicitlyRejected(node)) {
    return null
  }

  const cards = extractCardsFromNode(node)
  const kind = resolveDeclarationKind(node, cards)

  if (!kind) {
    return null
  }

  const seat = resolveSeatFromNode(node, path)
  const team = getTeamFromSeatValue(seat)

  if (!team) {
    return null
  }

  const rawSuit =
    getStringFromNode(node, ['suit', 'trumpSuit']) ??
    resolveSuitFromCards(cards)

  const points =
    (typeof node.points === 'number' ? node.points : null) ??
    (typeof node.score === 'number' ? node.score : null) ??
    (typeof node.value === 'number' ? node.value : null) ??
    calculateDeclarationPoints(kind, cards)

  const rankText =
    kind === 'belote'
      ? 'QK'
      : kind === 'square'
        ? buildSquareRankText(cards)
        : buildSequenceRankText(cards)

  const key = [
    team,
    seat ?? 'unknown-seat',
    kind,
    rawSuit ?? 'no-suit',
    rankText || 'no-ranks',
    String(points),
  ].join('::')

  return {
    key,
    team,
    seat,
    kind,
    suit: rawSuit,
    cards,
    rankText,
    points,
  }
}

function collectExtractedDeclarations(state: GameState): ExtractedDeclaration[] {
  const root = state.declarations as unknown
  const results: ExtractedDeclaration[] = []
  const seenKeys = new Set<string>()

  function walk(value: unknown, path: string[], depth: number): void {
    if (depth > 8) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, [...path, String(index)], depth + 1)
      })
      return
    }

    const record = asRecord(value)

    if (!record) {
      return
    }

    const resolved = resolveDeclarationEntry(record, path)

    if (resolved && !seenKeys.has(resolved.key)) {
      seenKeys.add(resolved.key)
      results.push(resolved)
    }

    Object.entries(record).forEach(([key, nestedValue]) => {
      walk(nestedValue, [...path, key], depth + 1)
    })
  }

  walk(root, ['declarations'], 0)

  return results
}

function buildBeloteDisplayItem(entry: ExtractedDeclaration): ScoringBeloteDisplayItem {
  return {
    key: entry.key,
    suit: entry.suit,
    suitSymbol: resolveSuitSymbol(entry.suit),
    color: resolveSuitColor(entry.suit),
  }
}

function buildSquareDisplayParts(rankText: string, points: number): ScoringTextPart[] {
  const repeatedRanks = Array.from({ length: 4 }, () => rankText)

  return repeatedRanks.map((rank, index) => {
    const isLastRank = index === repeatedRanks.length - 1

    return {
      text: isLastRank ? `${rank} +${points}` : `${rank} `,
      color: index % 2 === 0 ? 'black' : 'red',
    }
  })
}

function buildSequenceDisplayParts(
  suitSymbol: string,
  rankText: string,
  color: DeclarationTextColor
): ScoringTextPart[] {
  const prefix = suitSymbol ? `${suitSymbol} ` : ''

  return [
    {
      text: `${prefix}${rankText}`.trim(),
      color,
    },
  ]
}

function buildDeclarationDisplayItem(entry: ExtractedDeclaration): ScoringDeclarationDisplayItem {
  const suitSymbol = resolveSuitSymbol(entry.suit)
  const color = resolveSuitColor(entry.suit)

  if (entry.kind === 'square') {
    const displayParts = buildSquareDisplayParts(entry.rankText, entry.points)

    return {
      key: entry.key,
      kind: 'square',
      suit: entry.suit,
      suitSymbol,
      rankText: entry.rankText,
      displayText: `${entry.rankText} ${entry.rankText} ${entry.rankText} ${entry.rankText} +${entry.points}`,
      color: 'black',
      points: entry.points,
      displayParts,
    }
  }

  const displayParts = buildSequenceDisplayParts(suitSymbol, entry.rankText, color)

  return {
    key: entry.key,
    kind: 'sequence',
    suit: entry.suit,
    suitSymbol,
    rankText: entry.rankText,
    displayText: `${suitSymbol} ${entry.rankText}`.trim(),
    color,
    points: entry.points,
    displayParts,
  }
}

function buildDeclarationsDisplay(state: GameState): {
  teamABeloteItems: ScoringBeloteDisplayItem[]
  teamBBeloteItems: ScoringBeloteDisplayItem[]
  teamADeclarationItems: ScoringDeclarationDisplayItem[]
  teamBDeclarationItems: ScoringDeclarationDisplayItem[]
} {
  const extracted = collectExtractedDeclarations(state)

  const teamABeloteItems = extracted
    .filter((entry) => entry.team === 'A' && entry.kind === 'belote')
    .map(buildBeloteDisplayItem)

  const teamBBeloteItems = extracted
    .filter((entry) => entry.team === 'B' && entry.kind === 'belote')
    .map(buildBeloteDisplayItem)

  const teamADeclarationItems = extracted
    .filter((entry) => entry.team === 'A' && entry.kind !== 'belote')
    .map(buildDeclarationDisplayItem)

  const teamBDeclarationItems = extracted
    .filter((entry) => entry.team === 'B' && entry.kind !== 'belote')
    .map(buildDeclarationDisplayItem)

  return {
    teamABeloteItems,
    teamBBeloteItems,
    teamADeclarationItems,
    teamBDeclarationItems,
  }
}

export function getScoringViewState(state: GameState): ScoringViewState {
  const scoringState = state.scoring
  const baseRoundScore: BaseRoundScore | null = scoringState?.baseRoundScore ?? null
  const storedOutcome: Outcome | null = scoringState?.roundOutcome ?? null

  const declarationsScore = baseRoundScore
    ? buildComparableDeclarationsScore(state.declarations)
    : createZeroRoundScore()

  const beloteScore = baseRoundScore
    ? buildBeloteScore(state.declarations)
    : createZeroRoundScore()

  const computedOutcome =
    baseRoundScore && state.bidding.winningBid?.seat
      ? calculateRoundOutcome({
          baseRoundScore,
          bidderSeat: state.bidding.winningBid.seat,
          declarationsTeamA: declarationsScore.teamA,
          declarationsTeamB: declarationsScore.teamB,
          beloteTeamA: beloteScore.teamA,
          beloteTeamB: beloteScore.teamB,
        })
      : null

  const outcome: Outcome | null = computedOutcome ?? storedOutcome
  const counterMultiplier = resolveCounterMultiplier(state.bidding.winningBid)

  const officialRoundResult =
    baseRoundScore && outcome
      ? buildOfficialRoundScore({
          baseRoundScore,
          roundOutcome: outcome,
          currentCarryOver: state.score.carryOver,
          declarationsScore,
          beloteScore,
          counterMultiplier,
        })
      : null

  const premiumPointsTotal =
    declarationsScore.teamA +
    declarationsScore.teamB +
    beloteScore.teamA +
    beloteScore.teamB

  const teamASumPoints =
    (baseRoundScore?.teamA.rawPoints ?? 0) +
    declarationsScore.teamA +
    beloteScore.teamA

  const teamBSumPoints =
    (baseRoundScore?.teamB.rawPoints ?? 0) +
    declarationsScore.teamB +
    beloteScore.teamB

  const countdownSeconds = resolveScoringCountdownSeconds(state)
  const declarationsDisplay = buildDeclarationsDisplay(state)

  return {
    isVisible: state.phase === 'scoring',
    hasBaseRoundScore: Boolean(baseRoundScore),
    hasOutcome: Boolean(outcome),
    winningBidLabel: resolveWinningBidLabel(state.bidding.winningBid),
    winningBidOwnerLabel: resolveWinningBidOwnerLabel(state.bidding.winningBid),
    teamARawPoints: baseRoundScore?.teamA.rawPoints ?? 0,
    teamBRawPoints: baseRoundScore?.teamB.rawPoints ?? 0,
    teamATricksWon: baseRoundScore?.teamA.tricksWon ?? 0,
    teamBTricksWon: baseRoundScore?.teamB.tricksWon ?? 0,
    teamADeclarationPoints: declarationsScore.teamA,
    teamBDeclarationPoints: declarationsScore.teamB,
    teamABelotePoints: beloteScore.teamA,
    teamBBelotePoints: beloteScore.teamB,
    teamASumPoints,
    teamBSumPoints,
    expectedTotalPoints: (baseRoundScore?.expectedTotalPoints ?? 0) + premiumPointsTotal,
    actualTotalPoints: (baseRoundScore?.actualTotalPoints ?? 0) + premiumPointsTotal,
    isComplete: baseRoundScore?.isComplete ?? false,
    isPointTotalValid:
      baseRoundScore
        ? (baseRoundScore.actualTotalPoints + premiumPointsTotal) ===
          (baseRoundScore.expectedTotalPoints + premiumPointsTotal)
        : false,
    lastTrickWinnerLabel: formatSeatLabel(baseRoundScore?.lastTrickWinner ?? null),
    bidderTeamLabel: formatTeamLabel(outcome?.bidderTeam ?? null),
    defenderTeamLabel: formatTeamLabel(outcome?.defenderTeam ?? null),
    bidderPoints: outcome?.bidderPoints ?? 0,
    defenderPoints: outcome?.defenderPoints ?? 0,
    winningTeamLabel: formatTeamLabel(outcome?.winningTeam ?? null),
    outcomeLabel: resolveOutcomeLabel(outcome?.outcome ?? 'unknown'),
    outcomeShortLabel: resolveOutcomeShortLabel(outcome?.outcome ?? 'unknown'),
    isInside: outcome?.isInside ?? false,
    isMade: outcome?.isMade ?? false,
    isTie: outcome?.isTie ?? false,
    officialRoundTeamA:
      officialRoundResult?.roundBreakdown.total.teamA ?? state.score.round.total.teamA,
    officialRoundTeamB:
      officialRoundResult?.roundBreakdown.total.teamB ?? state.score.round.total.teamB,
    matchTotalTeamA: state.score.match.teamA,
    matchTotalTeamB: state.score.match.teamB,
    carryOverTeamA: state.score.carryOver.teamA,
    carryOverTeamB: state.score.carryOver.teamB,
    hasDouble: state.bidding.winningBid?.doubled ?? false,
    hasRedouble: state.bidding.winningBid?.redoubled ?? false,
    counterMultiplier,
    countdownSeconds,
    autoAdvanceCountdownSeconds: countdownSeconds,
    teamABeloteItems: declarationsDisplay.teamABeloteItems,
    teamBBeloteItems: declarationsDisplay.teamBBeloteItems,
    teamADeclarationItems: declarationsDisplay.teamADeclarationItems,
    teamBDeclarationItems: declarationsDisplay.teamBDeclarationItems,
  }
}