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
 *
 * Optional local-only Rule E2 OBSERVATIONAL tracing
 * (LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED, default OFF, independent of the
 * AI/policy/trace flags above, only takes effect when trace is also ON) adds
 * a `ruleE2Observation` field to each trace record describing what the
 * proposed Rule E2 (`e2_no_point_feed` partner-signal-return variant, see
 * server/src/ai/cardAdvisorSignalRuleE2.ts) would have suggested and why
 * (not) — purely for local beta observation. It NEVER selects the bot's
 * actual card and NEVER affects decisionSource. When this flag is OFF, no
 * ruleE2Observation key is added to the trace record at all.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Seat } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState, ServerCard, ServerSuit } from '../game/serverGameTypes.js'
import { getServerValidPlayCards } from '../game/getServerValidPlayCards.js'
import { getServerTrickWinner } from '../game/getServerTrickWinner.js'
import { pickServerBotPlayCard } from '../game/pickServerBotPlayCard.js'
import { getServerCardPoints, type ServerScoringContract } from '../game/serverScoring.js'
import {
  CardModelLoadError,
  loadCardModelFromFileSync,
  rankLegalCardsWithCardModel,
  type CardModel,
} from './cardModelInference.js'
import { deriveTeam, type CardDecisionState, type Team } from './cardModelFeatures.js'
import { decideAdvisorCard, type AdvisorDecisionInput, type AdvisorReason } from './cardAdvisorPolicy.js'
import { buildAdvisorRuntimeMemory } from './cardAdvisorMemory.js'
import {
  observeRuleE2NoPointFeed,
  type RuleE2SignalType,
  type RuleE2SuppressionReason,
} from './cardAdvisorSignalRuleE2.js'

// ─── Feature flags ─────────────────────────────────────────────────────────────

function isLocalAiCardBetaEnabled(): boolean {
  return process.env['LOCAL_AI_CARD_BETA_ENABLED']?.trim().toLowerCase() === 'true'
}

function isLocalAiCardBetaTraceEnabled(): boolean {
  return process.env['LOCAL_AI_CARD_BETA_TRACE_ENABLED']?.trim().toLowerCase() === 'true'
}

/**
 * Purely OBSERVATIONAL — never influences finalCard/decisionSource. When true
 * (and LOCAL_AI_CARD_BETA_TRACE_ENABLED is also true), each trace record gets
 * an additional `ruleE2Observation` payload describing what the proposed
 * Rule E2 (`e2_no_point_feed` variant, see server/src/ai/cardAdvisorSignalRuleE2.ts
 * and server/scripts/evaluateRuleE2SignalAdvisor.ts) would have suggested and
 * why (not) — for local beta observation only, so a future decision about a
 * real runtime override can be informed by live gameplay data, not just the
 * offline dataset. Default OFF; when OFF, no ruleE2Observation key is added
 * to the trace record at all (not even null), keeping trace output lean.
 */
function isLocalAiCardBetaRuleE2TraceEnabled(): boolean {
  return process.env['LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED']?.trim().toLowerCase() === 'true'
}

export type LocalAiCardBetaPolicyMode = 'model' | 'advisor'

/**
 * 'model' = old pure model-replacement candidate (unchanged logic, kept
 * available, no longer default). 'advisor' = new conventional-first tactical
 * guard engine (server/src/ai/cardAdvisorPolicy.ts) — DEFAULT when the beta
 * is enabled and this is unset/invalid, per the explicit pivot away from
 * "pure AI replacement" after live testing showed weak/erratic play despite
 * good offline model metrics. Set LOCAL_AI_CARD_BETA_POLICY=model explicitly
 * to keep the old behavior.
 */
function getLocalAiCardBetaPolicyMode(): LocalAiCardBetaPolicyMode {
  const raw = process.env['LOCAL_AI_CARD_BETA_POLICY']?.trim().toLowerCase()
  return raw === 'model' ? 'model' : 'advisor'
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
    // bidderSeat = winningBid.seat (същото поле, вече изчислено по-горе) —
    // само за card-model-v2 (isOurTeamContractor interaction терми);
    // card-model-v1 feature extraction никога не го чете (виж cardModelFeatures.ts).
    contract: { contract, trumpSuit, bidderSeat: winningBid?.seat ?? null },
    currentTrick: plays,
    currentWinningSeat: currentWinner?.seat ?? null,
  }
}

// ─── Decision tracing (local-only, OFF by default, independent of the AI flag) ─

// v2: добавени isLead/positionInTrick/pointsInTrick — позволява бъдещ trace
// анализ да прави lead/follow breakdown директно от trace-а (виж
// weakness-analysis.md, "Lead/follow breakdown: НЕ е налично" находка).
// v3: добавен policyMode='advisor' (conventional-first tactical guard engine,
// server/src/ai/cardAdvisorPolicy.ts) — новите полета описват advisor
// override-и (advisorSelectedCard/advisorOverride/advisorReason), memory
// facts (partnerCurrentlyWinning/opponentCurrentlyWinning), clean-winner
// сигнали за conventional/final картата, и predicted-winner симулации.
// Чисто адитивна схема промяна — по-старите consumers (computeTraceSummary),
// които не четат новите полета, продължават да работят непроменени.
export const LOCAL_AI_CARD_BETA_TRACE_VERSION = 3

export type LocalAiCardBetaDecisionSource =
  | 'ai_disabled'
  | 'ai_accepted'
  | 'ai_same_as_conventional'
  | 'conventional_fallback'
  | 'forced_card'
  | 'advisor_override'
  | 'advisor_no_override'
  | 'advisor_fallback'

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
  // Добавени в traceVersion 2 — computed unconditionally от state.playing?.currentTrick,
  // независимо от AI флага, за да е налично за ai_disabled/forced_card decisions също.
  isLead: boolean
  positionInTrick: number
  pointsInTrick: number
  conventionalCard: string | null
  aiSelectedCard: string | null
  finalCard: string | null
  aiSameAsConventional: boolean | null
  finalCardValid: boolean
  aiCardValid: boolean | null
  rankingLength: number
  topPredictions: Array<{ id: string; score: number; probability: number }>
  // ─── traceVersion 3 (advisor policy) ────────────────────────────────────────
  // null когато aiEnabled=false (никакъв policy path не е взет за това решение).
  policyMode: LocalAiCardBetaPolicyMode | null
  advisorSelectedCard: string | null
  advisorOverride: boolean | null
  advisorReason: AdvisorReason | null
  partnerCurrentlyWinning: boolean | null
  opponentCurrentlyWinning: boolean | null
  conventionalCardCandidateIsCleanWinner: boolean | null
  conventionalCardShouldPreserveCleanWinner: boolean | null
  finalCardCandidateIsCleanWinner: boolean | null
  finalCardShouldPreserveCleanWinner: boolean | null
  // predictedWinner*/predictedWinningTeam* са РЕАЛНИЯТ финален trick winner
  // САМО когато positionInTrick===3 (последен да играе в трика) — на по-ранна
  // позиция това е "ако трикът свършеше точно сега" interim симулация, която
  // по-нататъшен ход на противник може да обезсили. Никога не третирай тези
  // полета като гарантиран изход извън positionInTrick===3.
  predictedWinnerIfConventional: string | null
  predictedWinningTeamIfConventional: Team | null
  predictedWinnerIfAdvisor: string | null
  predictedWinningTeamIfAdvisor: Team | null
  // ServerAuthoritativeGameState носи никакъв room identifier (нито raw, нито
  // псевдонимизиран) — recorder-ският roomKey се смята на друг слой
  // (trainingRecorderCollector), недостъпен от тук. Затова полето е винаги
  // null — никога не се извежда/измисля raw roomId.
  roomKey: null
  // Optional (не `| null`, а изцяло липсващо поле, когато flag-ът е OFF) —
  // виж isLocalAiCardBetaRuleE2TraceEnabled(). Чисто observational: никога не
  // влияе finalCard/decisionSource по-горе.
  ruleE2Observation?: LocalAiCardBetaRuleE2ObservationPayload
}

export type LocalAiCardBetaRuleE2ObservationPayload = {
  enabled: true
  variant: 'e2_no_point_feed'
  wouldFire: boolean
  suggestedCard: string | null
  signalSuit: string | null
  signalType: RuleE2SignalType | null
  signalConfidence: number | null
  suppressionReason: RuleE2SuppressionReason | null
  wouldDifferFromFinal: boolean
  wouldDifferFromConventional: boolean
  wouldDifferFromAdvisorV0: boolean
  safety: { suggestionInLegalCards: boolean; suggestionInOwnHand: boolean }
  error: string | null
}

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

  // Computed unconditionally (не само за AI-enabled клона), за да е налично
  // за trace-а дори при ai_disabled/forced_card decisions — евтино, чисто
  // read-only върху вече наличния plays масив.
  const currentPlays = state.playing?.currentTrick?.plays ?? []
  const isLeadDecision = currentPlays.length === 0
  const positionInTrickForTrace = currentPlays.length
  const traceContract: ServerScoringContract = winningBid?.contract ?? 'no-trumps'
  const pointsInTrickForTrace = currentPlays.reduce(
    (sum, p) => sum + getServerCardPoints(p.card.suit, p.card.rank, traceContract, trumpSuit as ServerSuit | null),
    0,
  )

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
  let policyModeUsed: LocalAiCardBetaPolicyMode | null = null
  let advisorSelectedCardId: string | null = null
  let advisorOverrideFlag: boolean | null = null
  let advisorReasonValue: AdvisorReason | null = null
  let partnerCurrentlyWinningForTrace: boolean | null = null
  let opponentCurrentlyWinningForTrace: boolean | null = null
  let conventionalCleanWinner: boolean | null = null
  let conventionalPreserve: boolean | null = null
  let finalCleanWinner: boolean | null = null
  let finalPreserve: boolean | null = null
  let predictedWinnerConventionalSeat: Seat | null = null
  let predictedWinnerAdvisorSeat: Seat | null = null

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
    const policyMode = getLocalAiCardBetaPolicyMode()
    policyModeUsed = policyMode

    if (policyMode === 'advisor') {
      // ─── Conventional-first tactical advisor (default policy) ──────────────
      // conventionalCard е винаги отправната точка; guard rules (server/src/ai/
      // cardAdvisorPolicy.ts) override-ват само на силен, explainable сигнал.
      try {
        const partnerSeat = getPartnerSeat(seat)
        const memory = buildAdvisorRuntimeMemory(
          state, seat, partnerSeat, traceContract, trumpSuit as ServerSuit | null, hand, legalCards, currentPlays,
        )
        const input: AdvisorDecisionInput = {
          seat,
          partnerSeat,
          positionInTrick: positionInTrickForTrace,
          contract: traceContract,
          trumpSuit: trumpSuit as ServerSuit | null,
          currentTrickPlays: currentPlays,
          legalCards,
          conventionalCard,
          partnerCurrentlyWinning: memory.partnerCurrentlyWinning,
          opponentCurrentlyWinning: memory.opponentCurrentlyWinning,
          pointsInTrick: memory.pointsInTrick,
          candidateMemoryById: memory.candidateMemoryById,
        }
        const result = decideAdvisorCard(input)

        const legalIds = new Set(legalCards.map((c) => c.id))
        const handIds = new Set(hand.map((c) => c.id))
        const resultIsValidMember = legalIds.has(result.finalCard.id) && handIds.has(result.finalCard.id)

        partnerCurrentlyWinningForTrace = memory.partnerCurrentlyWinning
        opponentCurrentlyWinningForTrace = memory.opponentCurrentlyWinning
        const conventionalMemory = memory.candidateMemoryById.get(conventionalCard.id) ?? null
        conventionalCleanWinner = conventionalMemory?.candidateIsCleanWinner ?? null
        conventionalPreserve = conventionalMemory?.shouldPreserveCleanWinner ?? null
        predictedWinnerConventionalSeat = result.predictedWinnerSeatIfConventional

        if (!resultIsValidMember) {
          console.warn(
            `[local-ai-card-beta] Advisor selected card "${result.finalCard.id}" е invalid (не е в legalCards/ownHand за seat=${seat}) — fallback към conventional bot.`,
          )
          decisionSource = 'advisor_fallback'
          finalCard = conventionalCard
          fallbackUsed = true
          fallbackReason = 'Advisor selected card извън legalCards/ownHand'
          predictedWinnerAdvisorSeat = predictedWinnerConventionalSeat
          finalCleanWinner = conventionalCleanWinner
          finalPreserve = conventionalPreserve
        } else {
          finalCard = result.finalCard
          advisorOverrideFlag = result.override
          advisorReasonValue = result.reason
          advisorSelectedCardId = result.override ? result.finalCard.id : null
          predictedWinnerAdvisorSeat = result.predictedWinnerSeatIfFinal
          const finalMemory = memory.candidateMemoryById.get(result.finalCard.id) ?? null
          finalCleanWinner = finalMemory?.candidateIsCleanWinner ?? null
          finalPreserve = finalMemory?.shouldPreserveCleanWinner ?? null
          decisionSource = result.override ? 'advisor_override' : 'advisor_no_override'
          if (result.override) {
            console.log(`[local-ai-card-beta] Advisor override: ${conventionalCard.id} → ${result.finalCard.id} (reason=${result.reason}, seat=${seat})`)
          }
        }
      } catch (e) {
        decisionSource = 'advisor_fallback'
        finalCard = conventionalCard
        fallbackUsed = true
        fallbackReason = `exception: ${e instanceof Error ? e.message : String(e)}`
        console.warn(
          `[local-ai-card-beta] Exception при advisor decision за seat=${seat} (${e instanceof Error ? e.message : String(e)}) — fallback към conventional bot.`,
        )
      }
    } else {
      // ─── policyMode === 'model' — старата "pure model replacement" логика,
      // непроменена (kept available, no longer default след пивота към advisor). ─
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
  }

  if (traceEnabled) {
    logTraceStatusOnce()
    const legalIds = new Set(legalCards.map((c) => c.id))
    const handIds = new Set(hand.map((c) => c.id))
    const finalCardValid = finalCard !== null && legalIds.has(finalCard.id) && (hand.length === 0 || handIds.has(finalCard.id))

    // ─── Rule E2 observational trace (never influences finalCard/decisionSource) ─
    // Independent of aiEnabled/policyMode — computes its own shadow advisor v0
    // (A-D) check internally (see cardAdvisorSignalRuleE2.ts), so this works
    // even when the live decision took the 'model' policy path or AI is off.
    let ruleE2Observation: LocalAiCardBetaRuleE2ObservationPayload | undefined
    if (isLocalAiCardBetaRuleE2TraceEnabled()) {
      try {
        const partnerSeat = getPartnerSeat(seat)
        const obs = observeRuleE2NoPointFeed({
          state,
          seat,
          partnerSeat,
          legalCards,
          ownHand: hand,
          contract: traceContract,
          trumpSuit: trumpSuit as ServerSuit | null,
          currentTrickPlays: currentPlays,
        })
        ruleE2Observation = {
          enabled: true,
          variant: obs.variant,
          wouldFire: obs.wouldFire,
          suggestedCard: obs.suggestedCard,
          signalSuit: obs.signalSuit,
          signalType: obs.signalType,
          signalConfidence: obs.signalConfidence,
          suppressionReason: obs.suppressionReason,
          wouldDifferFromFinal: obs.suggestedCard !== null && obs.suggestedCard !== (finalCard?.id ?? null),
          wouldDifferFromConventional: obs.suggestedCard !== null && obs.suggestedCard !== (conventionalCard?.id ?? null),
          wouldDifferFromAdvisorV0: obs.suggestedCard !== null && obs.advisorV0CardId !== null && obs.suggestedCard !== obs.advisorV0CardId,
          safety: obs.safety,
          error: null,
        }
      } catch (e) {
        ruleE2Observation = {
          enabled: true,
          variant: 'e2_no_point_feed',
          wouldFire: false,
          suggestedCard: null,
          signalSuit: null,
          signalType: null,
          signalConfidence: null,
          suppressionReason: null,
          wouldDifferFromFinal: false,
          wouldDifferFromConventional: false,
          wouldDifferFromAdvisorV0: false,
          safety: { suggestionInLegalCards: true, suggestionInOwnHand: true },
          error: `exception: ${e instanceof Error ? e.message : String(e)}`,
        }
        console.warn(
          `[local-ai-card-beta-trace] Rule E2 observation exception за seat=${seat} (${e instanceof Error ? e.message : String(e)}) — само trace полето е засегнато, finalCard непроменен.`,
        )
      }
    }

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
      isLead: isLeadDecision,
      positionInTrick: positionInTrickForTrace,
      pointsInTrick: pointsInTrickForTrace,
      conventionalCard: conventionalCard?.id ?? null,
      aiSelectedCard: aiSelectedCardId,
      finalCard: finalCard?.id ?? null,
      aiSameAsConventional,
      finalCardValid,
      aiCardValid,
      rankingLength,
      topPredictions,
      policyMode: policyModeUsed,
      advisorSelectedCard: advisorSelectedCardId,
      advisorOverride: advisorOverrideFlag,
      advisorReason: advisorReasonValue,
      partnerCurrentlyWinning: partnerCurrentlyWinningForTrace,
      opponentCurrentlyWinning: opponentCurrentlyWinningForTrace,
      conventionalCardCandidateIsCleanWinner: conventionalCleanWinner,
      conventionalCardShouldPreserveCleanWinner: conventionalPreserve,
      finalCardCandidateIsCleanWinner: finalCleanWinner,
      finalCardShouldPreserveCleanWinner: finalPreserve,
      predictedWinnerIfConventional: predictedWinnerConventionalSeat,
      predictedWinningTeamIfConventional: predictedWinnerConventionalSeat ? deriveTeam(predictedWinnerConventionalSeat) : null,
      predictedWinnerIfAdvisor: predictedWinnerAdvisorSeat,
      predictedWinningTeamIfAdvisor: predictedWinnerAdvisorSeat ? deriveTeam(predictedWinnerAdvisorSeat) : null,
      roomKey: null,
      ...(ruleE2Observation ? { ruleE2Observation } : {}),
    })
  }

  return finalCard
}
