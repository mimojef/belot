/**
 * localAiCardShadowTrace.ts
 *
 * Production-safe, OFF-by-default SHADOW observation trace for bot card-play
 * decisions — separate from, and independent of, LOCAL_AI_CARD_BETA_ENABLED
 * (which can let advisor v0 actually REPLACE the bot's card, local-beta-only,
 * never safe for production). This module NEVER changes the selected card.
 * It only observes, in parallel, what advisor v0 (cardAdvisorPolicy.ts) and
 * Rule E2 (cardAdvisorSignalRuleE2.ts) WOULD have picked, and appends that
 * observation to its own separate JSONL trace file — so production data
 * collection can happen safely, with zero risk to actual gameplay.
 *
 * Hard guarantees:
 *  - LOCAL_AI_CARD_SHADOW_TRACE_ENABLED defaults to OFF. When OFF, this
 *    module's entry point returns immediately (one env read, nothing else) —
 *    zero I/O, byte-for-byte unchanged behavior.
 *  - This module has NO return value that can influence gameplay — it is
 *    called purely for its logging side effect, after the caller has already
 *    finalized its own decision. It cannot change conventionalCard/finalCard.
 *  - Any exception anywhere in this module (advisor v0 shadow computation,
 *    Rule E2 shadow computation, trace serialization, file I/O) is caught
 *    internally and NEVER propagates — the game loop is never affected.
 *  - "finalSelectedCard" in the trace payload always equals whatever the
 *    caller (server/src/ai/localAiCardBeta.ts) actually returned. When
 *    LOCAL_AI_CARD_BETA_ENABLED is OFF (the intended production posture —
 *    this shadow mode is designed to be safe to enable even in production,
 *    where the beta AI flag stays off), that is always conventionalCard.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Seat } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState, ServerCard, ServerSuit, ServerTrickPlay } from '../game/serverGameTypes.js'
import type { ServerScoringContract } from '../game/serverScoring.js'
import { decideAdvisorCard, type AdvisorDecisionInput, type AdvisorReason } from './cardAdvisorPolicy.js'
import { buildAdvisorRuntimeMemory } from './cardAdvisorMemory.js'
import { observeRuleE2NoPointFeed, type RuleE2SignalType, type RuleE2SuppressionReason } from './cardAdvisorSignalRuleE2.js'

// ─── Feature flags ─────────────────────────────────────────────────────────────

export function isLocalAiCardShadowTraceEnabled(): boolean {
  return process.env['LOCAL_AI_CARD_SHADOW_TRACE_ENABLED']?.trim().toLowerCase() === 'true'
}

// ─── Paths (local-only artifact, never committed — separate file from the beta trace) ─

const __dirname = dirname(fileURLToPath(import.meta.url))
// server/src/ai -> server/src -> server -> repo root
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const DEFAULT_SHADOW_TRACE_PATH = join(REPO_ROOT, 'training-output', 'local-ai-shadow', 'card-decisions.jsonl')

function getShadowTracePath(): string {
  return process.env['LOCAL_AI_CARD_SHADOW_TRACE_PATH']?.trim() || DEFAULT_SHADOW_TRACE_PATH
}

// ─── Small local seat helpers (ported — same convention as cardAdvisorSignalRuleE2.ts) ─

const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']

function seatIndexOf(seat: Seat): number {
  return SEAT_ORDER.indexOf(seat)
}

function teamIndexOf(seat: Seat): number {
  return seat === 'bottom' || seat === 'top' ? 0 : 1
}

function getPartnerSeat(seat: Seat): Seat {
  return SEAT_ORDER[(SEAT_ORDER.indexOf(seat) + 2) % 4]!
}

// ─── Trace payload shape ─────────────────────────────────────────────────────────

export const LOCAL_AI_CARD_SHADOW_TRACE_VERSION = 1

export type LocalAiCardShadowAdvisorV0Observation = {
  wouldOverride: boolean
  suggestedCard: string | null
  reason: AdvisorReason | null
  wouldDifferFromConventional: boolean
  safety: { suggestionInLegalCards: boolean; suggestionInOwnHand: boolean }
  error: string | null
}

export type LocalAiCardShadowRuleE2Observation = {
  enabled: true
  wouldFire: boolean
  suggestedCard: string | null
  signalSuit: string | null
  signalType: RuleE2SignalType | null
  signalConfidence: number | null
  suppressionReason: RuleE2SuppressionReason | null
  wouldDifferFromConventional: boolean
  safety: { suggestionInLegalCards: boolean; suggestionInOwnHand: boolean }
  error: string | null
}

export type LocalAiCardShadowTraceRecord = {
  timestamp: string
  traceVersion: number
  seatIndex: number
  teamIndex: number
  // ServerAuthoritativeGameState не носи никакъв room/deal identifier на този
  // слой (нито raw, нито псевдонимизиран) — виж localAiCardBeta.ts коментара
  // за същото ограничение. roomKey/deal остават винаги null; trick е реалният
  // state.playing.currentTrick.trickIndex, когато е наличен.
  roomKey: string | null
  deal: string | null
  trick: number | null
  gameMode: string | null
  trumpSuit: string | null
  isForced: boolean
  ownHand: string[]
  legalCards: string[]
  currentTrick: Array<{ seat: Seat; card: string }>
  conventionalCard: string | null
  finalSelectedCard: string | null
  finalDecisionSource: 'conventional_shadow'
  advisorV0Observation: LocalAiCardShadowAdvisorV0Observation
  ruleE2Observation: LocalAiCardShadowRuleE2Observation
  errors: string[]
}

// ─── Shadow observation computation (reuses existing pure helpers, no duplication) ─
// Exported (in addition to the main entry point) so check scripts can unit-test
// them directly with hand-crafted inputs — same convention as decideAdvisorCard
// (cardAdvisorPolicy.ts) and observeRuleE2NoPointFeed (cardAdvisorSignalRuleE2.ts),
// both already exported for the exact same reason.

export function computeAdvisorV0Shadow(
  state: ServerAuthoritativeGameState,
  seat: Seat,
  partnerSeat: Seat,
  contract: ServerScoringContract,
  trumpSuit: ServerSuit | null,
  hand: ServerCard[],
  legalCards: ServerCard[],
  currentPlays: ServerTrickPlay[],
  conventionalCard: ServerCard,
): LocalAiCardShadowAdvisorV0Observation {
  try {
    const memory = buildAdvisorRuntimeMemory(state, seat, partnerSeat, contract, trumpSuit, hand, legalCards, currentPlays)
    const input: AdvisorDecisionInput = {
      seat,
      partnerSeat,
      positionInTrick: currentPlays.length,
      contract,
      trumpSuit,
      currentTrickPlays: currentPlays,
      legalCards,
      conventionalCard,
      partnerCurrentlyWinning: memory.partnerCurrentlyWinning,
      opponentCurrentlyWinning: memory.opponentCurrentlyWinning,
      pointsInTrick: memory.pointsInTrick,
      candidateMemoryById: memory.candidateMemoryById,
    }
    const result = decideAdvisorCard(input)

    if (!result.override) {
      return {
        wouldOverride: false,
        suggestedCard: null,
        reason: null,
        wouldDifferFromConventional: false,
        safety: { suggestionInLegalCards: true, suggestionInOwnHand: true },
        error: null,
      }
    }

    const legalIds = new Set(legalCards.map((c) => c.id))
    const handIds = new Set(hand.map((c) => c.id))
    return {
      wouldOverride: true,
      suggestedCard: result.finalCard.id,
      reason: result.reason,
      wouldDifferFromConventional: result.finalCard.id !== conventionalCard.id,
      safety: { suggestionInLegalCards: legalIds.has(result.finalCard.id), suggestionInOwnHand: handIds.has(result.finalCard.id) },
      error: null,
    }
  } catch (e) {
    return {
      wouldOverride: false,
      suggestedCard: null,
      reason: null,
      wouldDifferFromConventional: false,
      safety: { suggestionInLegalCards: true, suggestionInOwnHand: true },
      error: `exception: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

export function computeRuleE2Shadow(
  state: ServerAuthoritativeGameState,
  seat: Seat,
  partnerSeat: Seat,
  legalCards: ServerCard[],
  hand: ServerCard[],
  contract: ServerScoringContract,
  trumpSuit: ServerSuit | null,
  currentPlays: ServerTrickPlay[],
  conventionalCard: ServerCard,
): LocalAiCardShadowRuleE2Observation {
  try {
    const obs = observeRuleE2NoPointFeed({
      state,
      seat,
      partnerSeat,
      legalCards,
      ownHand: hand,
      contract,
      trumpSuit,
      currentTrickPlays: currentPlays,
    })
    return {
      enabled: true,
      wouldFire: obs.wouldFire,
      suggestedCard: obs.suggestedCard,
      signalSuit: obs.signalSuit,
      signalType: obs.signalType,
      signalConfidence: obs.signalConfidence,
      suppressionReason: obs.suppressionReason,
      wouldDifferFromConventional: obs.suggestedCard !== null && obs.suggestedCard !== conventionalCard.id,
      safety: obs.safety,
      error: null,
    }
  } catch (e) {
    return {
      enabled: true,
      wouldFire: false,
      suggestedCard: null,
      signalSuit: null,
      signalType: null,
      signalConfidence: null,
      suppressionReason: null,
      wouldDifferFromConventional: false,
      safety: { suggestionInLegalCards: true, suggestionInOwnHand: true },
      error: `exception: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

// ─── Fail-safe trace write ───────────────────────────────────────────────────────

let traceDirEnsuredForPath: string | null = null
let hasLoggedShadowStatus = false

function ensureShadowTraceDir(tracePath: string): boolean {
  if (traceDirEnsuredForPath === tracePath) return true
  try {
    mkdirSync(dirname(tracePath), { recursive: true })
    traceDirEnsuredForPath = tracePath
    return true
  } catch (e) {
    console.warn(
      `[local-ai-card-shadow-trace] Не мога да създам trace директория (${e instanceof Error ? e.message : String(e)}) — trace е пропуснат за това решение.`,
    )
    return false
  }
}

function writeShadowTraceRecordSafely(record: LocalAiCardShadowTraceRecord): void {
  const tracePath = getShadowTracePath()
  if (!ensureShadowTraceDir(tracePath)) return
  try {
    appendFileSync(tracePath, JSON.stringify(record) + '\n', 'utf8')
  } catch (e) {
    console.warn(
      `[local-ai-card-shadow-trace] Trace write неуспешен (${e instanceof Error ? e.message : String(e)}) — играта продължава нормално.`,
    )
  }
}

/** Изложено само за local check/test script-ове. */
export function resetLocalAiCardShadowTraceStateForTests(): void {
  traceDirEnsuredForPath = null
  hasLoggedShadowStatus = false
}

// ─── Main entry point ────────────────────────────────────────────────────────────

export type LocalAiCardShadowTraceInput = {
  state: ServerAuthoritativeGameState
  seat: Seat
  conventionalCard: ServerCard | null
  finalCard: ServerCard | null
  legalCards: ServerCard[]
  ownHand: ServerCard[]
  currentTrickPlays: ServerTrickPlay[]
  gameMode: ServerScoringContract
  trumpSuit: ServerSuit | null
}

/**
 * Никога не хвърля навън и никога не връща нищо, влияещо на играта — вика се
 * ЕДИНСТВЕНО заради страничния ефект (trace write), СЛЕД като извикващият
 * (localAiCardBeta.ts) вече е финализирал решението си. Проверява собствения
 * си флаг като първа стъпка, за да е евтин no-op call, когато е OFF.
 */
export function runLocalAiCardShadowTraceIfEnabled(input: LocalAiCardShadowTraceInput): void {
  if (!isLocalAiCardShadowTraceEnabled()) return

  try {
    if (!hasLoggedShadowStatus) {
      hasLoggedShadowStatus = true
      console.log(`[local-ai-card-shadow-trace] LOCAL_AI_CARD_SHADOW_TRACE_ENABLED=true — production-safe shadow observation active, logging to ${getShadowTracePath()}`)
    }

    const { state, seat, conventionalCard, finalCard, legalCards, ownHand, currentTrickPlays, gameMode, trumpSuit } = input
    const errors: string[] = []
    const isForced = legalCards.length <= 1

    let advisorV0Observation: LocalAiCardShadowAdvisorV0Observation
    let ruleE2Observation: LocalAiCardShadowRuleE2Observation

    if (!conventionalCard) {
      // Edge case: conventional bot върна null (напр. празна ръка) — няма спрямо
      // какво да се сравнява observation-ът. Записваме reда с ясно error поле,
      // вместо да пропуснем trace-а изцяло (запазва 1 ред на решение).
      const note = 'conventionalCard is null (edge case, вероятно празна ръка) — shadow observations пропуснати'
      errors.push(note)
      advisorV0Observation = { wouldOverride: false, suggestedCard: null, reason: null, wouldDifferFromConventional: false, safety: { suggestionInLegalCards: true, suggestionInOwnHand: true }, error: note }
      ruleE2Observation = { enabled: true, wouldFire: false, suggestedCard: null, signalSuit: null, signalType: null, signalConfidence: null, suppressionReason: null, wouldDifferFromConventional: false, safety: { suggestionInLegalCards: true, suggestionInOwnHand: true }, error: note }
    } else {
      const partnerSeat = getPartnerSeat(seat)
      advisorV0Observation = computeAdvisorV0Shadow(state, seat, partnerSeat, gameMode, trumpSuit, ownHand, legalCards, currentTrickPlays, conventionalCard)
      ruleE2Observation = computeRuleE2Shadow(state, seat, partnerSeat, legalCards, ownHand, gameMode, trumpSuit, currentTrickPlays, conventionalCard)
      if (advisorV0Observation.error) errors.push(`advisorV0Observation: ${advisorV0Observation.error}`)
      if (ruleE2Observation.error) errors.push(`ruleE2Observation: ${ruleE2Observation.error}`)
    }

    writeShadowTraceRecordSafely({
      timestamp: new Date().toISOString(),
      traceVersion: LOCAL_AI_CARD_SHADOW_TRACE_VERSION,
      seatIndex: seatIndexOf(seat),
      teamIndex: teamIndexOf(seat),
      roomKey: null,
      deal: null,
      trick: state.playing?.currentTrick?.trickIndex ?? null,
      gameMode,
      trumpSuit,
      isForced,
      ownHand: ownHand.map((c) => c.id),
      legalCards: legalCards.map((c) => c.id),
      currentTrick: currentTrickPlays.map((p) => ({ seat: p.seat, card: p.card.id })),
      conventionalCard: conventionalCard?.id ?? null,
      finalSelectedCard: finalCard?.id ?? null,
      finalDecisionSource: 'conventional_shadow',
      advisorV0Observation,
      ruleE2Observation,
      errors,
    })
  } catch (e) {
    console.warn(
      `[local-ai-card-shadow-trace] Неочакван exception (${e instanceof Error ? e.message : String(e)}) — shadow trace пропуснат, играта продължава нормално.`,
    )
  }
}
