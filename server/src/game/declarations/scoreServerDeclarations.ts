import type { Team } from '../../core/serverTypes.js'
import type {
  ServerDeclaration,
  ServerRank,
  ServerRoundScore,
} from '../serverGameTypes.js'

type RankedDeclaration = ServerDeclaration & {
  strength: number
}

export type ServerDeclarationScoreResult = {
  declarationPoints: ServerRoundScore
  belotePoints: ServerRoundScore
}

const RANK_STRENGTH: Record<ServerRank, number> = {
  '7': 0,
  '8': 1,
  '9': 2,
  '10': 3,
  J: 4,
  Q: 5,
  K: 6,
  A: 7,
}

const SQUARE_STRENGTH_BY_RANK: Record<ServerRank, number> = {
  '7': 0,
  '8': 0,
  '9': 5,
  '10': 3,
  J: 6,
  Q: 1,
  K: 2,
  A: 4,
}

function createZeroRoundScore(): ServerRoundScore {
  return {
    teamA: 0,
    teamB: 0,
  }
}

function addDeclarationPoints(
  score: ServerRoundScore,
  declaration: ServerDeclaration,
): ServerRoundScore {
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
}

function filterScoreableDeclarations(
  declarations: ServerDeclaration[],
): ServerDeclaration[] {
  return declarations.filter((declaration) => {
    return declaration.announced === true && declaration.valid === true
  })
}

function getDeclarationTeamScoreKey(team: Team): keyof ServerRoundScore {
  return team === 'A' ? 'teamA' : 'teamB'
}

function getHighestDeclaration(
  declarations: RankedDeclaration[],
): RankedDeclaration | null {
  if (declarations.length === 0) {
    return null
  }

  return declarations.reduce((best, current) => {
    return current.strength > best.strength ? current : best
  }, declarations[0]!)
}

function getWinnerForRankedDeclarations(
  declarations: RankedDeclaration[],
): Team | null {
  const teamAHighest = getHighestDeclaration(
    declarations.filter((declaration) => declaration.team === 'A'),
  )
  const teamBHighest = getHighestDeclaration(
    declarations.filter((declaration) => declaration.team === 'B'),
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

  if (teamAHighest!.strength === teamBHighest!.strength) {
    return null
  }

  return teamAHighest!.strength > teamBHighest!.strength ? 'A' : 'B'
}

function getSquareRank(declaration: ServerDeclaration): ServerRank | null {
  return declaration.highRank ?? declaration.cards[0]?.rank ?? null
}

function getSquareStrength(declaration: ServerDeclaration): number {
  const rank = getSquareRank(declaration)

  if (rank === null) {
    return -1
  }

  return SQUARE_STRENGTH_BY_RANK[rank] ?? -1
}

function getSequenceHighRankStrength(declaration: ServerDeclaration): number {
  const highRank = declaration.highRank

  if (highRank === null) {
    return -1
  }

  return RANK_STRENGTH[highRank] ?? -1
}

function getSequenceStrength(declaration: ServerDeclaration): number {
  return declaration.points * 100 + getSequenceHighRankStrength(declaration)
}

function sumDeclarationsForTeam(
  declarations: ServerDeclaration[],
  team: Team,
): ServerRoundScore {
  const key = getDeclarationTeamScoreKey(team)

  return declarations
    .filter((declaration) => declaration.team === team)
    .reduce((score, declaration) => {
      return {
        ...score,
        [key]: score[key] + declaration.points,
      }
    }, createZeroRoundScore())
}

function scoreRankedDeclarationGroup(
  declarations: RankedDeclaration[],
): ServerRoundScore {
  const winningTeam = getWinnerForRankedDeclarations(declarations)

  if (winningTeam === null) {
    return createZeroRoundScore()
  }

  return sumDeclarationsForTeam(declarations, winningTeam)
}

export function scoreServerDeclarations(
  declarations: ServerDeclaration[],
): ServerDeclarationScoreResult {
  const scoreableDeclarations = filterScoreableDeclarations(declarations)

  const belotePoints = scoreableDeclarations
    .filter((declaration) => declaration.type === 'belote')
    .reduce(addDeclarationPoints, createZeroRoundScore())

  const squarePoints = scoreRankedDeclarationGroup(
    scoreableDeclarations
      .filter((declaration) => declaration.type === 'square')
      .map((declaration) => ({
        ...declaration,
        strength: getSquareStrength(declaration),
      })),
  )

  const sequencePoints = scoreRankedDeclarationGroup(
    scoreableDeclarations
      .filter((declaration) => declaration.type === 'sequence')
      .map((declaration) => ({
        ...declaration,
        strength: getSequenceStrength(declaration),
      })),
  )

  return {
    declarationPoints: {
      teamA: squarePoints.teamA + sequencePoints.teamA,
      teamB: squarePoints.teamB + sequencePoints.teamB,
    },
    belotePoints,
  }
}
