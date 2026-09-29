// Anti Bad Luck — server-only, seat-based state. НЕ влиза в snapshot-а към
// клиента (createRoomSnapshotMessage whitelist-ва полета), НЕ зависи от
// човек/бот/profile — един и същ state за seat-а при permanent bot, bot
// takeover, reconnect и reclaim. Reset-ва се само при нов мач
// (createInitialAuthoritativeGameState).

import type { Seat } from '../../core/serverTypes.js'

export const SERVER_ANTI_BAD_LUCK_STREAK_THRESHOLD = 3

export type ServerAntiBadLuckSeatState = {
  consecutiveBadDeals: number
  // dealIndex, в който seat-ът е достигнал прага — по-малко = по-стар pending
  // (приоритет при двама pending партньори). null = не е pending.
  pendingSinceDealIndex: number | null
}

export type ServerAntiBadLuckState = {
  // Брояч на раздаванията в мача (увеличава се при всяко deal-first-3).
  dealIndex: number
  seats: Record<Seat, ServerAntiBadLuckSeatState>
}

export type ServerAntiBadLuckRescueType = 'SUIT' | 'ALL_TRUMPS' | 'NO_TRUMPS'

export type ServerAntiBadLuckRescueKind = {
  type: ServerAntiBadLuckRescueType
  // SUIT → цветът; ALL_TRUMPS/NO_TRUMPS → 'TRIPLE' (JJJ/AAA) | 'PAIR_PLUS' (JJ9/AA10)
  variant: string
}

export type ServerAntiBadLuckRescue = ServerAntiBadLuckRescueKind & {
  cardIds: string[]
}

function createEmptySeatState(): ServerAntiBadLuckSeatState {
  return { consecutiveBadDeals: 0, pendingSinceDealIndex: null }
}

export function createEmptyServerAntiBadLuckState(): ServerAntiBadLuckState {
  return {
    dealIndex: 0,
    seats: {
      bottom: createEmptySeatState(),
      right: createEmptySeatState(),
      top: createEmptySeatState(),
      left: createEmptySeatState(),
    },
  }
}
