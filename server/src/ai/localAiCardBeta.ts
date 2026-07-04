/**
 * localAiCardBeta.ts
 *
 * Local-only, OFF-by-default AI card-play beta candidate. Wraps the
 * conventional expert bot (pickServerBotPlayCard) so that a local
 * developer can opt in to an experimental AI card-selection candidate via
 * an env flag, while gameplay is byte-for-byte unchanged for everyone else.
 *
 * Hard guarantees:
 *  - LOCAL_AI_CARD_BETA_ENABLED defaults to OFF. When OFF (or unset, or
 *    anything other than the literal string "true"), this module always
 *    returns exactly what the conventional bot would have returned, with
 *    no extra I/O, no model load attempt, and no log output beyond what
 *    the conventional bot already produces.
 *  - The conventional card is ALWAYS computed first. The AI candidate can
 *    only ever REPLACE it after passing validation (member of legalCards
 *    AND member of the bot's own hand) — never the other way around.
 *  - Any missing/corrupt model, any exception during inference, or any
 *    invalid AI-selected card silently falls back to the conventional
 *    card. This module can never crash the game loop and can never
 *    return a card outside legalCards/ownHand.
 *  - Bidding, scoring, declarations, matchmaking, economy, the recorder
 *    writer, and the client protocol are never touched here — this is
 *    exclusively a card-selection candidate for the single seat currently
 *    deciding a play.
 *
 * Optional local-only decision TRACING (LOCAL_AI_CARD_BETA_TRACE_ENABLED,
 * default OFF, independent of the AI flag) appends one JSONL record per
 * bot card decision to training-output/local-ai-beta/card-decisions.jsonl
 * (gitignored, never committed) so a local beta session can be audited
 * after the fact. Trace writes are fail-safe: any write error is caught,
 * logged once as a warning, and never affects the returned card. When
 * BOTH flags are OFF (the default), this module does exactly what it did
 * before tracing existed — one extra boolean env read, nothing else.
 *
 * Feature extraction and model loading are the SAME code already
 * validated offline by server/scripts/{trainCardModel,testCardModelInference,
 * simulateAiCardCandidate}.ts (server/src/ai/cardModelFeatures.ts,
 * cardModelInference.ts) — nothing is duplicated or re-implemented here.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Seat } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState, ServerCard } from '../game/serverGameTypes.js'
import { getServerValidPlayCards } from '../game/getServerValidPlayCards.js'
import { getServerTrickWinner } from '../game/getServerTrickWinner.js'
import { pickServerBotPlayCard } from '../game/pickServerBotPlayCard.js'
import {
  CardModelLoadError,
  loadCardModelFromFileSync,
  rankLegalCardsWithCardModel,
  type CardModel,
} from './cardModelInference.js'
import type { CardDecisionState } from './cardModelFeatures.js'

// ─── Feature flags ─────────────────────────────────────────────────────────────

function isLocalAiCardBetaEnabled(): boolean {
  return process.env['LOCAL_AI_CARD_BETA_ENABLED']?.trim().toLowerCase() === 'true'
}

function isLocalAiCardBetaTraceEnabled(): boolean {
  return process.env['LOCAL_AI_CARD_BETA_TRACE_ENABLED']?.trim().toLowerCase() === 'true'
}

// ─── Paths (local-only artifacts, never committed) ────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
// server/src/ai -> server/src -> server -> repo root
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const DEFAULT_MODEL_PATH = join(REPO_ROOT, 'training-output', 'models', 'card-model-v1', 'model.json')
const DEFAULT_TRACE_PATH = join(REPO_ROOT, 'training-output', 'local-ai-beta', 'card-decisions.jsonl')

function getModelPath(): string {
  return process.env['LOCAL_AI_CARD_BETA_MODEL_PATH']?.trim() || DEFAULT_MODEL_PATH
}

function getTracePath(): string {
  return process.env['LOCAL_AI_CARD_BETA_TRACE_PATH']?.trim() || DEFAULT_TRACE_PATH
}

// ─── Model cache (avoid re-reading the file on every single card decision) ──

type ModelCacheEntry =
  | { status: 'not-loaded' }
  | { status: 'loaded'; model: CardModel; path: string }
  | { status: 'failed'; reason: string; path: string }

let modelCache: ModelCacheEntry = { status: 'not-loaded' }
let hasLoggedStartupStatus = false
let hasLoggedTraceStatus = false

function logStartupStatusOnce(): void {
  if (hasLoggedStartupStatus) return
  hasLoggedStartupStatus = true
  console.log(
    `[local-ai-card-beta] LOCAL_AI_CARD_BETA_ENABLED=true — AI card candidate active (local-only, bidding/scoring/matchmaking unaffected). Model path: ${getModelPath()}`,
  )
}

function logTraceStatusOnce(): void {
  if (hasLoggedTraceStatus) return
  hasLoggedTraceStatus = true
  console.log(`[local-ai-card-beta-trace] LOCAL_AI_CARD_BETA_TRACE_ENABLED=true — logging decisions to ${getTracePath()}`)
}

function loadModel(): CardModel | null {
  const path = getModelPath()

  // Ако вече сме опитали с този точно path и е неуспешно/успешно — не повтаряй I/O на всяко решение.
  if (modelCache.status === 'loaded' && modelCache.path === path) return modelCache.model
  if (modelCache.status === 'failed' && modelCache.path === path) return null

  try {
    const model = loadCardModelFromFileSync(path)
    modelCache = { status: 'loaded', model, path }
    console.log(`[local-ai-card-beta] AI model зареден успешно: ${model.modelVersion} от ${path}`)
    return model
  } catch (e) {
    const reason = e instanceof CardModelLoadError || e instanceof Error ? e.message : String(e)
    modelCache = { status: 'failed', reason, path }
    console.warn(`[local-ai-card-beta] AI model НЕ е наличен/невалиден (${reason}) — fallback към conventional bot logic.`)
    return null
  }
}

function currentModelFailureReason(): string | null {
  return modelCache.status === 'failed' ? modelCache.reason : null
}

/** Изложено само за local check/test script-ове — не се използва в реалния gameplay flow. */
export function resetLocalAiCardBetaModelCacheForTests(): void {
  modelCache = { status: 'not-loaded' }
  hasLoggedStartupStatus = false
}

// ─── Decision state construction (същите правила като conventional bot-а) ──

function buildCardDecisionState(
  state: ServerAuthoritativeGameState,
  seat: Seat,
  legalCards: ServerCard[],
): CardDecisionState {
  const winningBid = state.bidding.winningBid
  const contract = winningBid?.contract ?? 'no-trumps'
  const trumpSuit = contract === 'suit' ? (winningBid?.trumpSuit ?? null) : null
  const plays = state.playing?.currentTrick?.plays ?? []
  const currentWinner = getServerTrickWinner(plays, winningBid)

  return {
    seat,
    ownHand: state.hands[seat] ?? [],
    legalCards,
    contract: { contract, trumpSuit },
    currentTrick: plays,
    currentWinningSeat: currentWinner?.seat ?? null,
  }
}

// ─── Decision tracing (local-only, OFF by default, independent of the AI flag) ─

export const LOCAL_AI_CARD_BETA_TRACE_VERSION = 1

export type LocalAiCardBetaDecisionSource =
  | 'ai_disabled'
  | 'ai_accepted'
  | 'ai_same_as_conventional'
  | 'conventional_fallback'
  | 'forced_card'

export type LocalAiCardBetaTraceRecord = {
  timestamp: string
  traceVersion: number
  modelVersion: string | null
  aiEnabled: boolean
  traceEnabled: true
  decisionSource: LocalAiCardBetaDecisionSource
  fallbackUsed: boolean
  fallbackReason: string | null
  seatIndex: number
  teamIndex: number
  legalCardsCount: number
  ownHandCount: number
  isForced: boolean
  gameMode: string | null
  trumpSuit: string | null
  conventionalCard: string | null
  aiSelectedCard: string | null
  finalCard: string | null
  aiSameAsConventional: boolean | null
  finalCardValid: boolean
  aiCardValid: boolean | null
  rankingLength: number
  topPredictions: Array<{ id: string; score: number; probability: number }>
  // ServerAuthoritativeGameState носи никакъв room identifier (нито raw, нито
  // псевдонимизиран) — recorder-ският roomKey се смята на друг слой
  // (trainingRecorderCollector), недостъпен от тук. Затова полето е винаги
  // null — никога не се извежда/измисля raw roomId.
  roomKey: null
}

const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']

function seatIndexOf(seat: Seat): number {
  return SEAT_ORDER.indexOf(seat)
}

function teamIndexOf(seat: Seat): number {
  return seat === 'bottom' || seat === 'top' ? 0 : 1
}

let traceDirEnsuredForPath: string | null = null

function ensureTraceDir(tracePath: string): boolean {
  if (traceDirEnsuredForPath === tracePath) return true
  try {
    mkdirSync(dirname(tracePath), { recursive: true })
    traceDirEnsuredForPath = tracePath
    return true
  } catch (e) {
    console.warn(
      `[local-ai-card-beta-trace] Не мога да създам trace директория (${e instanceof Error ? e.message : String(e)}) — trace е пропуснат за това решение.`,
    )
    return false
  }
}

/**
 * Пише един trace ред. Fail-safe: писането никога не хвърля навън — при
 * грешка само логва warning (защото traceEnabled вече е true тук) и играта
 * продължава с вече изчислената карта.
 */
function writeTraceRecordSafely(record: LocalAiCardBetaTraceRecord): void {
  const tracePath = getTracePath()
  if (!ensureTraceDir(tracePath)) return
  try {
    appendFileSync(tracePath, JSON.stringify(record) + '\n', 'utf8')
  } catch (e) {
    console.warn(
      `[local-ai-card-beta-trace] Trace write неуспешен (${e instanceof Error ? e.message : String(e)}) — играта продължава нормално.`,
    )
  }
}

/** Изложено само за local check/test script-ове. */
export function resetLocalAiCardBetaTraceStateForTests(): void {
  traceDirEnsuredForPath = null
  hasLoggedTraceStatus = false
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Drop-in replacement за pickServerBotPlayCard в bot card-play call site-а.
 * Когато и двата флага (AI, trace) са OFF — единственият допълнителен разход
 * спрямо преди tracing-а е двата boolean env read-а; връща се точно
 * pickServerBotPlayCard(state, seat), без никакъв друг I/O или логика.
 */
export function pickServerBotPlayCardWithAiCandidate(
  state: ServerAuthoritativeGameState,
  seat: Seat,
): ServerCard | null {
  const conventionalCard = pickServerBotPlayCard(state, seat)
  const aiEnabled = isLocalAiCardBetaEnabled()
  const traceEnabled = isLocalAiCardBetaTraceEnabled()

  if (!aiEnabled && !traceEnabled) {
    return conventionalCard
  }

  // Отвъд тази точка поне единият флаг е включен — позволено е допълнително
  // изчисление (legalCards, model, inference) само за AI/trace нуждите.

  const legalCards = getServerValidPlayCards(state, seat)
  const hand = state.hands[seat] ?? []
  const isForced = legalCards.length <= 1
  const winningBid = state.bidding.winningBid
  const gameMode = winningBid?.contract ?? null
  const trumpSuit = winningBid?.contract === 'suit' ? (winningBid.trumpSuit ?? null) : null

  let decisionSource: LocalAiCardBetaDecisionSource
  let finalCard: ServerCard | null = conventionalCard
  let aiSelectedCardId: string | null = null
  let aiCardValid: boolean | null = null
  let aiSameAsConventional: boolean | null = null
  let fallbackUsed = false
  let fallbackReason: string | null = null
  let rankingLength = 0
  let topPredictions: Array<{ id: string; score: number; probability: number }> = []
  let modelVersionUsed: string | null = null

  if (isForced) {
    // Forced (или без избор) — conventional вече е единствената/коректна опция,
    // независимо от AI флага. Никакъв model load/inference за тривиален избор.
    decisionSource = 'forced_card'
  } else if (!aiEnabled) {
    decisionSource = 'ai_disabled'
  } else if (!conventionalCard) {
    // Edge case: conventional bot върна null (напр. празна ръка) — AI няма какво да предложи.
    decisionSource = 'conventional_fallback'
    fallbackUsed = true
    fallbackReason = 'conventional bot върна null (edge case, вероятно празна ръка)'
  } else {
    logStartupStatusOnce()
    const model = loadModel()

    if (!model) {
      decisionSource = 'conventional_fallback'
      fallbackUsed = true
      fallbackReason = currentModelFailureReason() ?? 'AI model не е наличен'
    } else {
      modelVersionUsed = model.modelVersion
      const legalIds = new Set(legalCards.map((c) => c.id))
      const handIds = new Set(hand.map((c) => c.id))

      try {
        const decisionState = buildCardDecisionState(state, seat, legalCards)
        const prediction = rankLegalCardsWithCardModel(model, decisionState)
        rankingLength = prediction.ranking.length
        topPredictions = prediction.ranking
          .slice(0, 3)
          .map((r) => ({ id: r.id, score: r.score, probability: r.probability }))
        fallbackUsed = prediction.fallbackUsed
        fallbackReason = prediction.fallbackReason

        const predictionIsValidMember = legalIds.has(prediction.selectedCard) && handIds.has(prediction.selectedCard)

        // Ако rankLegalCardsWithCardModel вътрешно fallback-на (напр. non-finite
        // score) ИЛИ избраната карта се окаже извън legalCards/ownHand, това НЕ
        // е реална AI препоръка — третираме го като conventional_fallback и
        // връщаме точно conventionalCard, а не вътрешния first-legal pick на
        // inference модула (за да decisionSource="conventional_fallback" винаги
        // означава "finalCard === conventionalCard", както изисква схемата).
        if (!predictionIsValidMember || prediction.fallbackUsed) {
          aiCardValid = predictionIsValidMember
          if (!predictionIsValidMember) {
            console.warn(
              `[local-ai-card-beta] AI selected card "${prediction.selectedCard}" е invalid (не е в legalCards/ownHand за seat=${seat}) — fallback към conventional bot.`,
            )
          }
          decisionSource = 'conventional_fallback'
          finalCard = conventionalCard
          fallbackUsed = true
          fallbackReason = fallbackReason ?? 'AI selected card извън legalCards/ownHand'
        } else {
          aiCardValid = true
          aiSelectedCardId = prediction.selectedCard
          const aiCard = legalCards.find((c) => c.id === prediction.selectedCard)!
          aiSameAsConventional = aiCard.id === conventionalCard.id
          finalCard = aiCard
          decisionSource = aiSameAsConventional ? 'ai_same_as_conventional' : 'ai_accepted'
          console.log(`[local-ai-card-beta] AI избра карта: ${aiCard.id} (seat=${seat})`)
        }
      } catch (e) {
        aiCardValid = false
        decisionSource = 'conventional_fallback'
        fallbackUsed = true
        fallbackReason = `exception: ${e instanceof Error ? e.message : String(e)}`
        console.warn(
          `[local-ai-card-beta] Exception при AI inference за seat=${seat} (${e instanceof Error ? e.message : String(e)}) — fallback към conventional bot.`,
        )
      }
    }
  }

  if (traceEnabled) {
    logTraceStatusOnce()
    const legalIds = new Set(legalCards.map((c) => c.id))
    const handIds = new Set(hand.map((c) => c.id))
    const finalCardValid = finalCard !== null && legalIds.has(finalCard.id) && (hand.length === 0 || handIds.has(finalCard.id))

    writeTraceRecordSafely({
      timestamp: new Date().toISOString(),
      traceVersion: LOCAL_AI_CARD_BETA_TRACE_VERSION,
      modelVersion: modelVersionUsed,
      aiEnabled,
      traceEnabled: true,
      decisionSource,
      fallbackUsed,
      fallbackReason,
      seatIndex: seatIndexOf(seat),
      teamIndex: teamIndexOf(seat),
      legalCardsCount: legalCards.length,
      ownHandCount: hand.length,
      isForced,
      gameMode,
      trumpSuit,
      conventionalCard: conventionalCard?.id ?? null,
      aiSelectedCard: aiSelectedCardId,
      finalCard: finalCard?.id ?? null,
      aiSameAsConventional,
      finalCardValid,
      aiCardValid,
      rankingLength,
      topPredictions,
      roomKey: null,
    })
  }

  return finalCard
}
