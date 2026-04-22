import type { Declaration, Rank, RoundScore, Team } from '../state/gameTypes'

type ComparableDeclarationKind = 'sequence' | 'square'
type NormalizedDeclarationKind = ComparableDeclarationKind | 'belote' | 'unknown'
type DeclarationContract = 'color' | 'all-trumps' | 'no-trumps'

export type DeclarationResolutionResult = {
  resolvedDeclarations: Declaration[]
  validDeclarations: Declaration[]
  invalidDeclarations: Declaration[]
  validComparableDeclarations: Declaration[]
  validBeloteDeclarations: Declaration[]
  strongestTeamA: Declaration | null
  strongestTeamB: Declaration | null
  winningComparableTeam: Team | null
  isTie: boolean
}

const SEQUENCE_RANK_ORDER: Rank[] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const SQUARE_STRENGTH_BY_RANK: Record<Rank, number> = {
  '7': 0,
  '8': 0,
  '9': 5,
  '10': 3,
  J: 6,
  Q: 1,
  K: 2,
  A: 4,
}

function isNoTrumpsContract(contract?: DeclarationContract | null): boolean {
  return contract === 'no-trumps'
}

function getRankStrength(rank: Rank | null): number {
  if (!rank) {
    return -1
  }

  return SEQUENCE_RANK_ORDER.indexOf(rank)
}

function getDeclarationTypeValue(declaration: Declaration): string {
  return String(declaration.type)
}

function getNormalizedDeclarationKind(
  declaration: Declaration
): NormalizedDeclarationKind {
  const declarationType = getDeclarationTypeValue(declaration)

  if (declarationType === 'belote') {
    return 'belote'
  }

  if (
    declarationType === 'sequence' ||
    declarationType === 'sequence-3' ||
    declarationType === 'sequence-4' ||
    declarationType === 'sequence-5-plus'
  ) {
    return 'sequence'
  }

  if (declarationType === 'square') {
    return 'square'
  }

  return 'unknown'
}

function isComparableDeclaration(declaration: Declaration): boolean {
  const kind = getNormalizedDeclarationKind(declaration)
  return kind === 'sequence' || kind === 'square'
}

function isBeloteDeclaration(declaration: Declaration): boolean {
  return getNormalizedDeclarationKind(declaration) === 'belote'
}

function getSequenceLength(declaration: Declaration): number {
  const declarationType = getDeclarationTypeValue(declaration)

  if (declarationType === 'sequence-3') {
    return 3
  }

  if (declarationType === 'sequence-4') {
    return 4
  }

  if (declarationType === 'sequence-5-plus') {
    return Math.max(5, declaration.cards.length)
  }

  return declaration.cards.length
}

function getSequenceHighRank(declaration: Declaration): Rank | null {
  if (declaration.highRank) {
    return declaration.highRank
  }

  if (declaration.cards.length === 0) {
    return null
  }

  let highestCard = declaration.cards[0]

  for (const card of declaration.cards) {
    if (getRankStrength(card.rank) > getRankStrength(highestCard.rank)) {
      highestCard = card
    }
  }

  return highestCard.rank
}

function getSquareStrength(declaration: Declaration): number {
  const rank = declaration.highRank ?? declaration.cards[0]?.rank ?? null

  if (!rank) {
    return -1
  }

  return SQUARE_STRENGTH_BY_RANK[rank] ?? -1
}

function compareSequenceStrength(left: Declaration, right: Declaration): number {
  const leftLength = getSequenceLength(left)
  const rightLength = getSequenceLength(right)

  if (leftLength !== rightLength) {
    return leftLength > rightLength ? 1 : -1
  }

  const leftHighRank = getSequenceHighRank(left)
  const rightHighRank = getSequenceHighRank(right)

  const leftHighRankStrength = getRankStrength(leftHighRank)
  const rightHighRankStrength = getRankStrength(rightHighRank)

  if (leftHighRankStrength !== rightHighRankStrength) {
    return leftHighRankStrength > rightHighRankStrength ? 1 : -1
  }

  return 0
}

function compareSquareStrength(left: Declaration, right: Declaration): number {
  const leftStrength = getSquareStrength(left)
  const rightStrength = getSquareStrength(right)

  if (leftStrength !== rightStrength) {
    return leftStrength > rightStrength ? 1 : -1
  }

  const leftHighRankStrength = getRankStrength(
    left.highRank ?? left.cards[0]?.rank ?? null
  )
  const rightHighRankStrength = getRankStrength(
    right.highRank ?? right.cards[0]?.rank ?? null
  )

  if (leftHighRankStrength !== rightHighRankStrength) {
    return leftHighRankStrength > rightHighRankStrength ? 1 : -1
  }

  return 0
}

function compareComparableDeclarations(left: Declaration, right: Declaration): number {
  const leftKind = getNormalizedDeclarationKind(left)
  const rightKind = getNormalizedDeclarationKind(right)

  if (leftKind === 'square' && rightKind === 'sequence') {
    return 1
  }

  if (leftKind === 'sequence' && rightKind === 'square') {
    return -1
  }

  if (leftKind === 'square' && rightKind === 'square') {
    return compareSquareStrength(left, right)
  }

  if (leftKind === 'sequence' && rightKind === 'sequence') {
    return compareSequenceStrength(left, right)
  }

  return 0
}

function getStrongestComparableDeclaration(
  declarations: Declaration[]
): Declaration | null {
  if (declarations.length === 0) {
    return null
  }

  let strongest = declarations[0]

  for (let index = 1; index < declarations.length; index += 1) {
    const current = declarations[index]
    const comparison = compareComparableDeclarations(current, strongest)

    if (comparison > 0) {
      strongest = current
    }
  }

  return strongest
}

function cloneDeclarationWithValid(
  declaration: Declaration,
  valid: boolean
): Declaration {
  return {
    ...declaration,
    valid,
  }
}

function buildAllInvalidResolution(
  declarations: Declaration[]
): DeclarationResolutionResult {
  const resolvedDeclarations = declarations.map((declaration) =>
    cloneDeclarationWithValid(declaration, false)
  )

  return {
    resolvedDeclarations,
    validDeclarations: [],
    invalidDeclarations: resolvedDeclarations,
    validComparableDeclarations: [],
    validBeloteDeclarations: [],
    strongestTeamA: null,
    strongestTeamB: null,
    winningComparableTeam: null,
    isTie: false,
  }
}

function buildResolutionFromWinner(params: {
  declarations: Declaration[]
  winningComparableTeam: Team | null
  isTie: boolean
  contract?: DeclarationContract | null
}): DeclarationResolutionResult {
  const { declarations, winningComparableTeam, isTie, contract } = params

  if (isNoTrumpsContract(contract)) {
    return buildAllInvalidResolution(declarations)
  }

  const resolvedDeclarations = declarations.map((declaration) => {
    if (!declaration.announced) {
      return cloneDeclarationWithValid(declaration, false)
    }

    if (isBeloteDeclaration(declaration)) {
      return cloneDeclarationWithValid(declaration, true)
    }

    if (!isComparableDeclaration(declaration)) {
      return cloneDeclarationWithValid(declaration, false)
    }

    if (!winningComparableTeam) {
      return cloneDeclarationWithValid(declaration, false)
    }

    return cloneDeclarationWithValid(
      declaration,
      declaration.team === winningComparableTeam
    )
  })

  const validDeclarations = resolvedDeclarations.filter(
    (declaration) => declaration.valid
  )
  const invalidDeclarations = resolvedDeclarations.filter(
    (declaration) => !declaration.valid
  )
  const validComparableDeclarations = validDeclarations.filter((declaration) =>
    isComparableDeclaration(declaration)
  )
  const validBeloteDeclarations = validDeclarations.filter((declaration) =>
    isBeloteDeclaration(declaration)
  )

  const comparableTeamA = declarations.filter(
    (declaration) =>
      declaration.announced &&
      declaration.team === 'A' &&
      isComparableDeclaration(declaration)
  )
  const comparableTeamB = declarations.filter(
    (declaration) =>
      declaration.announced &&
      declaration.team === 'B' &&
      isComparableDeclaration(declaration)
  )

  return {
    resolvedDeclarations,
    validDeclarations,
    invalidDeclarations,
    validComparableDeclarations,
    validBeloteDeclarations,
    strongestTeamA: getStrongestComparableDeclaration(comparableTeamA),
    strongestTeamB: getStrongestComparableDeclaration(comparableTeamB),
    winningComparableTeam,
    isTie,
  }
}

export function resolveDeclarations(
  declarations: Declaration[],
  contract?: DeclarationContract | null
): DeclarationResolutionResult {
  if (isNoTrumpsContract(contract)) {
    return buildAllInvalidResolution(declarations)
  }

  const announcedDeclarations = declarations.filter(
    (declaration) => declaration.announced
  )

  const comparableTeamA = announcedDeclarations.filter(
    (declaration) =>
      declaration.team === 'A' && isComparableDeclaration(declaration)
  )
  const comparableTeamB = announcedDeclarations.filter(
    (declaration) =>
      declaration.team === 'B' && isComparableDeclaration(declaration)
  )

  const strongestTeamA = getStrongestComparableDeclaration(comparableTeamA)
  const strongestTeamB = getStrongestComparableDeclaration(comparableTeamB)

  if (!strongestTeamA && !strongestTeamB) {
    return buildResolutionFromWinner({
      declarations,
      winningComparableTeam: null,
      isTie: false,
      contract,
    })
  }

  if (strongestTeamA && !strongestTeamB) {
    return buildResolutionFromWinner({
      declarations,
      winningComparableTeam: 'A',
      isTie: false,
      contract,
    })
  }

  if (!strongestTeamA && strongestTeamB) {
    return buildResolutionFromWinner({
      declarations,
      winningComparableTeam: 'B',
      isTie: false,
      contract,
    })
  }

  const comparison = compareComparableDeclarations(
    strongestTeamA as Declaration,
    strongestTeamB as Declaration
  )

  if (comparison === 0) {
    return buildResolutionFromWinner({
      declarations,
      winningComparableTeam: null,
      isTie: true,
      contract,
    })
  }

  return buildResolutionFromWinner({
    declarations,
    winningComparableTeam: comparison > 0 ? 'A' : 'B',
    isTie: false,
    contract,
  })
}

export function buildComparableDeclarationsScore(
  declarations: Declaration[],
  contract?: DeclarationContract | null
): RoundScore {
  const resolution = resolveDeclarations(declarations, contract)

  return resolution.validComparableDeclarations.reduce<RoundScore>(
    (score, declaration) => {
      if (declaration.team === 'A') {
        return {
          ...score,
          teamA: score.teamA + declaration.points,
        }
      }

      return {
        ...score,
        teamB: score.teamB + declaration.points,
      }
    },
    {
      teamA: 0,
      teamB: 0,
    }
  )
}

export function buildBeloteScore(
  declarations: Declaration[],
  contract?: DeclarationContract | null
): RoundScore {
  const resolution = resolveDeclarations(declarations, contract)

  return resolution.validBeloteDeclarations.reduce<RoundScore>(
    (score, declaration) => {
      if (declaration.team === 'A') {
        return {
          ...score,
          teamA: score.teamA + declaration.points,
        }
      }

      return {
        ...score,
        teamB: score.teamB + declaration.points,
      }
    },
    {
      teamA: 0,
      teamB: 0,
    }
  )
}