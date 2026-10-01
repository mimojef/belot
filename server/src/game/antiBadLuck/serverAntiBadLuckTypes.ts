// Anti Bad Luck — server-only, seat-based state. НЕ влиза в snapshot-а към
// клиента (createRoomSnapshotMessage whitelist-ва полета), НЕ зависи от
// човек/бот/profile — един и същ state за seat-а при permanent bot, bot
// takeover, reconnect и reclaim. Reset-ва се при нов мач
// (createInitialAuthoritativeGameState) и при admin превключване към праг 0
// (resetGeneration, виж ServerAntiBadLuckConfig).

import type { Seat } from '../../core/serverTypes.js'
import type { ServerSuit } from '../serverGameTypes.js'

// Admin-конфигурируем праг (admin_settings.anti_bad_luck_threshold). Seat
// става pending след `threshold` поредни BAD първи 5 → rescue най-рано на
// (threshold + 1)-вото поредно BAD. 0 = системата е напълно изключена.
export const SERVER_ANTI_BAD_LUCK_THRESHOLD_VALUES = [0, 5, 6, 7, 8, 9, 10] as const

export type ServerAntiBadLuckThreshold = (typeof SERVER_ANTI_BAD_LUCK_THRESHOLD_VALUES)[number]

// Production default (= поведението преди конфигурируемия праг).
export const SERVER_ANTI_BAD_LUCK_DEFAULT_THRESHOLD: ServerAntiBadLuckThreshold = 5

// Runtime конфигурация, подавана при ВСЕКИ tick от main thread-а (admin
// settings) до game worker-а и надолу до applyServerAntiBadLuckToDeck.
// resetGeneration се увеличава при всяко превключване към 0 — state,
// изчислен при по-стара generation, се изхвърля при следващото раздаване
// (виж applyServerAntiBadLuckToDeck). Никога не стига до клиента.
export type ServerAntiBadLuckConfig = {
  threshold: ServerAntiBadLuckThreshold
  resetGeneration: number
}

// САМО за ниски helper-и/тестови adapter-и (backward compatibility).
// Production runtime границите (worker protocol, tick input,
// advanceRoomAuthoritativeGame) изискват explicit config — без fallback.
export const SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG: ServerAntiBadLuckConfig = {
  threshold: SERVER_ANTI_BAD_LUCK_DEFAULT_THRESHOLD,
  resetGeneration: 0,
}

export function isServerAntiBadLuckThreshold(value: unknown): value is ServerAntiBadLuckThreshold {
  return typeof value === 'number' && (SERVER_ANTI_BAD_LUCK_THRESHOLD_VALUES as readonly number[]).includes(value)
}

export function isServerAntiBadLuckConfig(value: unknown): value is ServerAntiBadLuckConfig {
  if (value === null || typeof value !== 'object') return false
  const config = value as Record<string, unknown>
  const resetGeneration = config['resetGeneration']
  return (
    isServerAntiBadLuckThreshold(config['threshold']) &&
    typeof resetGeneration === 'number' &&
    Number.isSafeInteger(resetGeneration) &&
    resetGeneration >= 0
  )
}

// Fail-fast за production границите — невалиден config е bug, НЕ повод за
// тих fallback към default прага.
export function assertServerAntiBadLuckConfig(value: unknown, context: string): asserts value is ServerAntiBadLuckConfig {
  if (!isServerAntiBadLuckConfig(value)) {
    throw new Error(`[anti-bad-luck] ${context}: invalid antiBadLuckConfig ${JSON.stringify(value)}`)
  }
}

export type ServerAntiBadLuckSeatState = {
  consecutiveBadDeals: number
  // dealIndex, в който seat-ът е достигнал ТЕКУЩИЯ праг — по-малко = по-стар
  // pending (приоритет в опашката за единствения rescue на раздаване). null =
  // не е pending. Изведена стойност (dealIndex − consecutiveBadDeals +
  // threshold + … виж getServerAntiBadLuckPendingSinceDealIndex): eligibility
  // и приоритетът се преизчисляват всяко раздаване по текущия праг, полето
  // се пази за диагностика/backward compatibility на persisted state-а.
  pendingSinceDealIndex: number | null
}

export type ServerAntiBadLuckState = {
  // Брояч на раздаванията в мача (увеличава се при всяко deal-first-3).
  dealIndex: number
  seats: Record<Seat, ServerAntiBadLuckSeatState>
  // Generation на admin reset-а, при която е изчислен state-ът. Липсва в
  // legacy persisted state-ове → 0 (= началната generation, без reset).
  resetGeneration?: number
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

// Runtime constraint за ALL_TRUMPS/NO_TRUMPS candidate generation — изчислен
// от natural J/A цветовете в първите 5 на seat-а точно преди generation.
// Факт от natural deal-а, НЕ част от rescue kind (type/variant остават чист
// random избор) и НЕ се persist-ва — пресмята се наново всяко раздаване.
export type ServerAntiBadLuckAnchorConstraints = {
  naturalAnchorSuits: ServerSuit[]
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

export function getServerAntiBadLuckStateResetGeneration(state: ServerAntiBadLuckState): number {
  return state.resetGeneration ?? 0
}
