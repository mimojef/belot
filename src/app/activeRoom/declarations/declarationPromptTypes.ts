import type {
  RoomCardSnapshot,
  RoomWinningBidSnapshot,
} from '../../network/createGameServerClient'

export type ClientDeclarationCandidateType = 'sequence' | 'square' | 'belote'

export type ClientDeclarationPublicLabel =
  | 'Терца'
  | '50'
  | '100'
  | 'Каре'
  | 'Белот'

export type ClientDeclarationDetectionContract =
  | Pick<NonNullable<RoomWinningBidSnapshot>, 'contract' | 'trumpSuit'>
  | null

export type ClientDeclarationCandidate = {
  key: string
  type: ClientDeclarationCandidateType
  publicLabel: ClientDeclarationPublicLabel
  points: number
  cardIds: string[]
  privateMetadata: {
    suit: RoomCardSnapshot['suit'] | null
    highRank: RoomCardSnapshot['rank'] | null
    rank: RoomCardSnapshot['rank'] | null
    sequenceLength: number | null
  }
}

export type PendingDeclarationPrompt = {
  cardId: string
  options: ClientDeclarationCandidate[]
  selectedKeys: string[]
}
