// Pure deadline computation helpers — приемат "now" като параметър (не
// четат Date.now() вътрешно), за да останат детерминистично тестваеми (виж
// task-а т.25: "без реално чакане 10/15 секунди"). Controller-ът е
// единственото място, което реално чете Date.now() и setTimeout/
// setInterval — виж createLudoFlowController.ts.

import {
  LUDO_ROLL_TIMEOUT_MS,
  LUDO_MOVE_TIMEOUT_MS,
  resolveLudoPendingDeadlineKind,
  type LudoOrchestratorState,
} from './ludoOrchestratorTypes'
import type { LudoColor, LudoTurnPhase } from '../engine/ludoEngineTypes'

// Изчислява НОВИЯ orchestrator state след като canonical engine turnPhase/
// activeColor/turnVersion са се променили (след dispatch) — решава дали
// текущата фаза изисква roll deadline, move deadline, или никакъв (bot на
// ход, или фаза без чакане). Pure — не мутира входа, връща нов обект.
export function computeLudoDeadlineStateForPhase(
  orchestrator: LudoOrchestratorState,
  turnPhase: LudoTurnPhase,
  activeColor: LudoColor,
  turnVersion: number,
  now: number,
): LudoOrchestratorState {
  const pending = resolveLudoPendingDeadlineKind(turnPhase, activeColor, orchestrator.botControlledColors)

  if (pending === 'roll') {
    return {
      ...orchestrator,
      rollDeadlineAt: now + LUDO_ROLL_TIMEOUT_MS,
      moveDeadlineAt: null,
      deadlineTurnVersion: turnVersion,
    }
  }
  if (pending === 'move') {
    return {
      ...orchestrator,
      rollDeadlineAt: null,
      moveDeadlineAt: now + LUDO_MOVE_TIMEOUT_MS,
      deadlineTurnVersion: turnVersion,
    }
  }
  // 'none' — bot на ход, или фаза без чакане (rolling/move_resolving/
  // turn_complete) — няма активен human deadline.
  return {
    ...orchestrator,
    rollDeadlineAt: null,
    moveDeadlineAt: null,
    deadlineTurnVersion: turnVersion,
  }
}

// Дали даден timeout callback (registered за конкретен turnVersion) все
// още е валиден спрямо ТЕКУЩИЯ orchestrator state — stale timeout от
// предишен turnVersion (ход вече напреднал по друга причина, напр. ръчен
// roll преди timeout-а да изтече) трябва да бъде игнориран (виж task-а
// т.18/TIMER3/TIMER10).
export function isLudoDeadlineStillValid(orchestrator: LudoOrchestratorState, registeredTurnVersion: number): boolean {
  return orchestrator.deadlineTurnVersion === registeredTurnVersion
}

// Marks a color as bot-controlled (sticky) — pure, връща нов Set/state.
export function markLudoColorBotControlled(
  orchestrator: LudoOrchestratorState,
  color: LudoColor,
): LudoOrchestratorState {
  if (orchestrator.botControlledColors.has(color)) return orchestrator
  const next = new Set(orchestrator.botControlledColors)
  next.add(color)
  return { ...orchestrator, botControlledColors: next }
}

// Explicit "resume human control" — премахва bot flag-а за даден цвят
// (аналог на Belot resumeHumanControl). Не се извиква автоматично никъде в
// Phase 3A (няма UI trigger за нея все още — mock-ът няма реален human за
// non-local цветовете), но е готова за бъдеща "reclaim" функционалност.
export function resumeLudoHumanControl(orchestrator: LudoOrchestratorState, color: LudoColor): LudoOrchestratorState {
  if (!orchestrator.botControlledColors.has(color)) return orchestrator
  const next = new Set(orchestrator.botControlledColors)
  next.delete(color)
  return { ...orchestrator, botControlledColors: next }
}
