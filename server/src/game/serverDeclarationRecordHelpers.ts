import type { Seat } from '../core/serverTypes.js'
import type { ServerDeclarationCandidate } from './declarations/index.js'
import type { ServerDeclaration } from './serverGameTypes.js'
import { getTeamBySeat } from './serverStateHelpers.js'

export function createServerDeclarationRecord(params: {
  candidate: ServerDeclarationCandidate
  seat: Seat
  declaredAtTrickIndex: number
}): ServerDeclaration {
  const { candidate, seat, declaredAtTrickIndex } = params

  return {
    key: candidate.key,
    seat,
    team: getTeamBySeat(seat),
    type: candidate.type,
    publicLabel: candidate.publicLabel,
    points: candidate.points,
    cards: candidate.privateMetadata.cards,
    cardIds: candidate.cardIds,
    suit: candidate.privateMetadata.suit,
    highRank: candidate.privateMetadata.highRank,
    declaredAtTrickIndex,
    announced: true,
    valid: true,
  }
}
