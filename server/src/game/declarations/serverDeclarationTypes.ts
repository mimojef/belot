import type {
  ServerCard,
  ServerRank,
  ServerSuit,
  ServerWinningBid,
} from '../serverGameTypes.js'

export type ServerDeclarationCandidateType = 'sequence' | 'square' | 'belote'

export type ServerDeclarationPublicLabel =
  | 'Каре'
  | 'Терца'
  | '50'
  | '100'
  | 'Белот'

export type ServerDeclarationComparisonGroup =
  | 'sequence'
  | 'square'
  | 'belote'

export type ServerDeclarationDetectionContract =
  | Pick<NonNullable<ServerWinningBid>, 'contract' | 'trumpSuit'>
  | null

export type ServerDeclarationPrivateMetadata = {
  suit: ServerSuit | null
  highRank: ServerRank | null
  rank: ServerRank | null
  sequenceLength: number | null
  cards: ServerCard[]
}

export type ServerDeclarationCandidate = {
  id: string
  key: string
  type: ServerDeclarationCandidateType
  comparisonGroup: ServerDeclarationComparisonGroup
  publicLabel: ServerDeclarationPublicLabel
  points: number
  cardIds: string[]
  privateMetadata: ServerDeclarationPrivateMetadata
}

export type ServerDeclarationConflictResolution = {
  selectedCandidates: ServerDeclarationCandidate[]
  rejectedCandidates: ServerDeclarationCandidate[]
}

export type ServerDeclarationLabelSource = Pick<
  ServerDeclarationCandidate,
  'publicLabel'
>
