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
 * Feature extraction and model loading are the SAME code already
 * validated offline by server/scripts/{trainCardModel,testCardModelInference,
 * simulateAiCardCandidate}.ts (server/src/ai/cardModelFeatures.ts,
 * cardModelInference.ts) — nothing is duplicated or re-implemented here.
 */

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

// ─── Feature flag ─────────────────────────────────────────────────────────────

function isLocalAiCardBetaEnabled(): boolean {
  return process.env['LOCAL_AI_CARD_BETA_ENABLED']?.trim().toLowerCase() === 'true'
}

// ─── Model path (local-only artifact, never committed) ───────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
// server/src/ai -> server/src -> server -> repo root
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const DEFAULT_MODEL_PATH = join(REPO_ROOT, 'training-output', 'models', 'card-model-v1', 'model.json')

function getModelPath(): string {
  return process.env['LOCAL_AI_CARD_BETA_MODEL_PATH']?.trim() || DEFAULT_MODEL_PATH
}

// ─── Model cache (avoid re-reading the file on every single card decision) ──

type ModelCacheEntry =
  | { status: 'not-loaded' }
  | { status: 'loaded'; model: CardModel; path: string }
  | { status: 'failed'; reason: string; path: string }

let modelCache: ModelCacheEntry = { status: 'not-loaded' }
let hasLoggedStartupStatus = false

function logStartupStatusOnce(): void {
  if (hasLoggedStartupStatus) return
  hasLoggedStartupStatus = true
  console.log(
    `[local-ai-card-beta] LOCAL_AI_CARD_BETA_ENABLED=true — AI card candidate active (local-only, bidding/scoring/matchmaking unaffected). Model path: ${getModelPath()}`,
  )
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

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Drop-in replacement за pickServerBotPlayCard в bot card-play call site-а.
 * Флагът е OFF по подразбиране → връща точно pickServerBotPlayCard(state, seat),
 * без никакъв допълнителен I/O или логика.
 */
export function pickServerBotPlayCardWithAiCandidate(
  state: ServerAuthoritativeGameState,
  seat: Seat,
): ServerCard | null {
  const conventionalCard = pickServerBotPlayCard(state, seat)

  if (!isLocalAiCardBetaEnabled()) {
    return conventionalCard
  }

  logStartupStatusOnce()

  // Conventional bot връща null само в edge case (празна ръка) — AI няма какво да предложи тогава.
  if (!conventionalCard) return conventionalCard

  const legalCards = getServerValidPlayCards(state, seat)
  if (legalCards.length <= 1) {
    // Forced (или без избор) — conventional вече е единствената/коректна опция.
    return conventionalCard
  }

  const model = loadModel()
  if (!model) return conventionalCard

  const legalIds = new Set(legalCards.map((c) => c.id))
  const hand = state.hands[seat] ?? []
  const handIds = new Set(hand.map((c) => c.id))

  try {
    const decisionState = buildCardDecisionState(state, seat, legalCards)
    const prediction = rankLegalCardsWithCardModel(model, decisionState)

    if (!legalIds.has(prediction.selectedCard) || !handIds.has(prediction.selectedCard)) {
      console.warn(
        `[local-ai-card-beta] AI selected card "${prediction.selectedCard}" е invalid (не е в legalCards/ownHand за seat=${seat}) — fallback към conventional bot.`,
      )
      return conventionalCard
    }

    const aiCard = legalCards.find((c) => c.id === prediction.selectedCard)
    if (!aiCard) {
      // Не би трябвало да е възможно (вече проверено по-горе), но никога не позволяваме invalid card.
      return conventionalCard
    }

    if (prediction.fallbackUsed) {
      console.log(
        `[local-ai-card-beta] AI wrapper fallback (${prediction.fallbackReason ?? 'unknown reason'}) → карта "${aiCard.id}" (seat=${seat}, все пак валидна).`,
      )
    } else {
      console.log(`[local-ai-card-beta] AI избра карта: ${aiCard.id} (seat=${seat})`)
    }

    return aiCard
  } catch (e) {
    console.warn(
      `[local-ai-card-beta] Exception при AI inference за seat=${seat} (${e instanceof Error ? e.message : String(e)}) — fallback към conventional bot.`,
    )
    return conventionalCard
  }
}
