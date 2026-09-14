// Orchestrator state — PRESENTATION/ORCHESTRATION слой (виж Phase 3A task-а
// т.2), НЕ engine state. Живее тук всичко, което engine-ът съзнателно НЕ
// познава: timers/deadlines, bot control flag-ове, turn scheduling. Чист
// TypeScript (без DOM/Date.now() calls тук — тези остават в
// createLudoFlowController.ts, който подава "now" като параметър навсякъде,
// за да остане тестваемо без реално чакане — виж task-а т.25).
//
// Deadline модел: `rollDeadlineAt`/`moveDeadlineAt` са абсолютни Unix-ms
// timestamps (не countdown секунди) — UI timer-ът derive-ва remaining time
// от тях (`Math.max(0, deadline - Date.now())`), огледално на Belot-овия
// `timerDeadlineAt` pattern (виж audit-а), но БЕЗ import от Belot код.
//
// Server-migration readiness (т.22): SERVER по-късно ще притежава RNG,
// deadlines, timeout actions, bot takeover, canonical state; CLIENT ще
// остане само render/countdown display/animations/input request. Затова
// целият orchestrator тук е проектиран да приема "authoritative now" (или
// по-късно "authoritative deadline от сървъра") като INPUT, не да генерира
// собствено недетерминирано време скрито в closures.

import type { LudoColor, LudoTurnPhase } from '../engine/ludoEngineTypes'

export const LUDO_ROLL_TIMEOUT_MS = 10_000
export const LUDO_MOVE_TIMEOUT_MS = 15_000
// Кратко "мислене" преди bot action — presentation delay, НЕ human timeout
// (виж task-а т.16: bot никога не чака 10s/15s human таймери).
export const LUDO_BOT_THINK_DELAY_MS = 700

export interface LudoOrchestratorState {
  // Кой цвят в момента е bot-controlled — sticky flag (аналог на Belot
  // controlledByBot), не се reset-ва автоматично при следващ ход. Начално
  // всички non-local цветове (в mock-а: всички освен local player-а) са
  // bot-controlled by design (виж createLudoMockPlayers isBot флаговете) —
  // orchestrator-ът НЕ решава кой е bot, само действа спрямо готовия флаг.
  botControlledColors: ReadonlySet<LudoColor>
  // Абсолютен Unix-ms timestamp, до който трябва HUMAN player-ът да хвърли
  // зара, или null ако текущата фаза не е "чакаме roll от human".
  rollDeadlineAt: number | null
  // Абсолютен Unix-ms timestamp, до който трябва HUMAN player-ът да избере
  // ход, или null ако текущата фаза не е "чакаме move от human".
  moveDeadlineAt: number | null
  // turnVersion, за който текущите deadlines важат — при stale timeout
  // (turnVersion вече е различен) deadline action-ът се игнорира (виж
  // task-а т.18/TIMER10).
  deadlineTurnVersion: number
}

export function createLudoOrchestratorInitialState(botControlledColors: ReadonlySet<LudoColor>): LudoOrchestratorState {
  return {
    botControlledColors,
    rollDeadlineAt: null,
    moveDeadlineAt: null,
    deadlineTurnVersion: 0,
  }
}

// Кой тип deadline действие чака в момента, изведено от canonical
// turnPhase + дали активният цвят е bot-controlled — pure helper, нужен на
// controller-а да реши "трябва ли изобщо timer" (виж task-а т.16: bot
// никога не чака human timers).
export type LudoPendingDeadlineKind = 'roll' | 'move' | 'none'

export function resolveLudoPendingDeadlineKind(
  turnPhase: LudoTurnPhase,
  activeColor: LudoColor,
  botControlledColors: ReadonlySet<LudoColor>,
): LudoPendingDeadlineKind {
  if (botControlledColors.has(activeColor)) return 'none'
  if (turnPhase === 'waiting_for_roll') return 'roll'
  if (turnPhase === 'awaiting_move_selection') return 'move'
  return 'none'
}
