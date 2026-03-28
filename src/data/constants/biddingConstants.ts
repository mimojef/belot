import type { Suit } from '../../core/state/gameTypes'

export const BID_SUIT_ORDER: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades']

export const BID_CONTRACT_ORDER = ['suit', 'no-trumps', 'all-trumps'] as const

export type BidContractOrder = (typeof BID_CONTRACT_ORDER)[number]