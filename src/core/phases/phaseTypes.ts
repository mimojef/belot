export const PHASE_TYPES = [
  'new-game',
  'choose-first-dealer',
  'cutting',
  'cut-resolve',
  'deal-first-3',
  'deal-next-2',
  'bidding',
  'deal-last-3',
  'playing',
  'scoring',
  'next-round',
] as const

export type PhaseType = (typeof PHASE_TYPES)[number]