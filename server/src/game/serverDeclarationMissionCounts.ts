import {
  createEmptyMatchDeclarationMissionCounts,
  createEmptyMatchDeclarationMissionCountsBySeat,
} from './createServerRoundDefaults.js'
import type {
  ServerDeclaration,
  ServerDeclarationMissionCountsBySeat,
  ServerDeclarationMissionType,
  ServerRoundScore,
} from './serverGameTypes.js'

export function getDeclarationMissionType(
  declaration: ServerDeclaration,
): ServerDeclarationMissionType | null {
  switch (declaration.publicLabel) {
    case 'Терца':
      return 'announce_tersa'
    case '50':
      return 'announce_50'
    case '100':
      return 'announce_100'
    case 'Каре':
      return 'announce_kare'
    case 'Белот':
      return 'announce_belot'
    default:
      return null
  }
}

function cloneRoundScore(score: ServerRoundScore): ServerRoundScore {
  return {
    teamA: score.teamA,
    teamB: score.teamB,
  }
}

export function normalizeMatchDeclarationMissionCounts(
  counts: Partial<Record<ServerDeclarationMissionType, ServerRoundScore>> | null | undefined,
): Record<ServerDeclarationMissionType, ServerRoundScore> {
  const emptyCounts = createEmptyMatchDeclarationMissionCounts()

  if (!counts) {
    return emptyCounts
  }

  return {
    announce_tersa: cloneRoundScore(counts.announce_tersa ?? emptyCounts.announce_tersa),
    announce_50: cloneRoundScore(counts.announce_50 ?? emptyCounts.announce_50),
    announce_100: cloneRoundScore(counts.announce_100 ?? emptyCounts.announce_100),
    announce_kare: cloneRoundScore(counts.announce_kare ?? emptyCounts.announce_kare),
    announce_belot: cloneRoundScore(counts.announce_belot ?? emptyCounts.announce_belot),
  }
}

export function normalizeMatchDeclarationMissionCountsBySeat(
  bySeat: ServerDeclarationMissionCountsBySeat | null | undefined,
): ServerDeclarationMissionCountsBySeat {
  if (!bySeat) {
    return createEmptyMatchDeclarationMissionCountsBySeat()
  }
  // shallow clone — inner objects are cloned when mutated below
  return { ...bySeat }
}

export function addDeclarationsToMatchMissionCounts(
  counts: Partial<Record<ServerDeclarationMissionType, ServerRoundScore>> | null | undefined,
  declarations: ServerDeclaration[],
): Record<ServerDeclarationMissionType, ServerRoundScore> {
  const nextCounts = normalizeMatchDeclarationMissionCounts(counts)

  for (const declaration of declarations) {
    if (!declaration.valid || !declaration.announced) {
      continue
    }

    const missionType = getDeclarationMissionType(declaration)

    if (missionType === null) {
      continue
    }

    const teamKey = declaration.team === 'A' ? 'teamA' : 'teamB'
    nextCounts[missionType] = {
      ...nextCounts[missionType],
      [teamKey]: nextCounts[missionType][teamKey] + 1,
    }
  }

  return nextCounts
}

export function addDeclarationsToMatchMissionCountsBySeat(
  bySeat: ServerDeclarationMissionCountsBySeat | null | undefined,
  declarations: ServerDeclaration[],
): ServerDeclarationMissionCountsBySeat {
  const next = normalizeMatchDeclarationMissionCountsBySeat(bySeat)

  for (const declaration of declarations) {
    if (!declaration.valid || !declaration.announced) {
      continue
    }

    const missionType = getDeclarationMissionType(declaration)
    if (missionType === null) {
      continue
    }

    const seat = declaration.seat
    const seatCounts = next[seat] ?? {}
    next[seat] = {
      ...seatCounts,
      [missionType]: (seatCounts[missionType] ?? 0) + 1,
    }
  }

  return next
}
