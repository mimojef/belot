/**
 * cardModelInference.ts
 *
 * Read-only, fail-closed inference wrapper за card-model-v1. Зарежда
 * model.json (произведен от server/scripts/trainCardModel.ts) и предлага
 * чиста функция за ranking на legalCards в даден decision context.
 *
 * Няма runtime gameplay ефект — това е offline/local inference helper,
 * подготовка за евентуален бъдещ beta bot. НЕ е включен в gameplay,
 * matchmaking, bot strategy или client protocol.
 *
 * Feature extraction се преизползва от cardModelFeatures.ts (същия код,
 * който trainer-ът използва) — гарантира, че inference и training никога
 * не могат да се разминат в feature логиката.
 */

import { readFile } from 'node:fs/promises'

import {
  CARD_MODEL_FEATURE_NAMES,
  computeCardModelFeatures,
  dot,
  type CardDecisionState,
} from './cardModelFeatures.js'

// ─── Model schema ─────────────────────────────────────────────────────────────

export const EXPECTED_MODEL_VERSION = 'card-model-v1'

export type CardModel = {
  modelVersion: string
  featureNames: readonly string[]
  weights: readonly number[]
  raw: Record<string, unknown>
}

export class CardModelLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CardModelLoadError'
  }
}

/**
 * Валидира и построява CardModel от вече parse-нат JSON обект. Fail-closed:
 * хвърля CardModelLoadError за всякаква липсваща/невалидна/несъвместима
 * стойност, вместо тихо да продължи с непълен/грешен модел.
 */
export function validateAndBuildCardModel(parsed: unknown): CardModel {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CardModelLoadError('model.json не е валиден JSON обект')
  }
  const raw = parsed as Record<string, unknown>

  if (typeof raw.modelVersion !== 'string' || raw.modelVersion.length === 0) {
    throw new CardModelLoadError('model.json: липсва/невалиден modelVersion')
  }
  if (raw.modelVersion !== EXPECTED_MODEL_VERSION) {
    throw new CardModelLoadError(
      `model.json: неочакван modelVersion "${raw.modelVersion}" (очакван "${EXPECTED_MODEL_VERSION}") — inference wrapper-ът е писан точно за тази model schema.`,
    )
  }

  if (!Array.isArray(raw.featureNames) || raw.featureNames.length === 0) {
    throw new CardModelLoadError('model.json: липсва/празен featureNames')
  }
  const featureNames = raw.featureNames as unknown[]
  if (featureNames.length !== CARD_MODEL_FEATURE_NAMES.length) {
    throw new CardModelLoadError(
      `model.json: featureNames.length=${featureNames.length}, очаквано ${CARD_MODEL_FEATURE_NAMES.length}`,
    )
  }
  for (let i = 0; i < CARD_MODEL_FEATURE_NAMES.length; i++) {
    if (featureNames[i] !== CARD_MODEL_FEATURE_NAMES[i]) {
      throw new CardModelLoadError(
        `model.json: featureNames[${i}]="${String(featureNames[i])}", очаквано "${CARD_MODEL_FEATURE_NAMES[i]}" — ` +
          'редът на features е критичен за коректен dot-product; несъвпадение означава несъвместим/повреден model artifact.',
      )
    }
  }

  if (!Array.isArray(raw.weights) || raw.weights.length !== featureNames.length) {
    throw new CardModelLoadError(
      `model.json: weights липсва или дължината (${Array.isArray(raw.weights) ? raw.weights.length : 'n/a'}) не съвпада с featureNames (${featureNames.length})`,
    )
  }
  const weights = raw.weights as unknown[]
  for (let i = 0; i < weights.length; i++) {
    if (typeof weights[i] !== 'number' || !Number.isFinite(weights[i] as number)) {
      throw new CardModelLoadError(`model.json: weights[${i}] не е валидно (finite) число`)
    }
  }

  return {
    modelVersion: raw.modelVersion,
    featureNames: featureNames as string[],
    weights: weights as number[],
    raw,
  }
}

/** Чете и валидира model.json от диск. Fail-closed при missing/corrupt файл. */
export async function loadCardModelFromFile(modelPath: string): Promise<CardModel> {
  let content: string
  try {
    content = await readFile(modelPath, 'utf8')
  } catch (e) {
    throw new CardModelLoadError(`Не мога да прочета model artifact "${modelPath}": ${e instanceof Error ? e.message : String(e)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (e) {
    throw new CardModelLoadError(`model.json на "${modelPath}" не е валиден JSON: ${e instanceof Error ? e.message : String(e)}`)
  }

  return validateAndBuildCardModel(parsed)
}

// ─── Prediction API ───────────────────────────────────────────────────────────

export type RankedCardEntry = { id: string; score: number; probability: number }

export type RankedCardPrediction = {
  ranking: RankedCardEntry[]
  selectedCard: string
  fallbackUsed: boolean
  fallbackReason: string | null
  validation: {
    legalCardsCount: number
    isForced: boolean
    selectedCardIsLegal: boolean
  }
}

/**
 * Ranking на legalCards за даден decision context. Никога не връща карта
 * извън legalCards — гарантирано чрез fallback towards legalCards[0] при
 * всякаква невалидна/недостатъчна model prediction.
 */
export function rankLegalCardsWithCardModel(model: CardModel, state: CardDecisionState): RankedCardPrediction {
  const legalCards = state.legalCards

  if (legalCards.length === 0) {
    throw new Error('rankLegalCardsWithCardModel: legalCards е празен — критична input грешка, decision state-ът е невалиден.')
  }

  if (legalCards.length === 1) {
    const only = legalCards[0]!
    return {
      ranking: [{ id: only.id, score: 0, probability: 1 }],
      selectedCard: only.id,
      fallbackUsed: false,
      fallbackReason: null,
      validation: { legalCardsCount: 1, isForced: true, selectedCardIsLegal: true },
    }
  }

  const legalIds = new Set(legalCards.map((c) => c.id))
  const scored = legalCards.map((c) => ({ id: c.id, score: dot(model.weights, computeCardModelFeatures(state, c)) }))
  const hasInvalidScore = scored.some((s) => !Number.isFinite(s.score))

  let fallbackUsed = false
  let fallbackReason: string | null = null
  let ranking: RankedCardEntry[]

  if (hasInvalidScore) {
    fallbackUsed = true
    fallbackReason = 'Model произведе non-finite score за поне една candidate карта — fallback към first-legal ranking.'
    ranking = legalCards.map((c, i) => ({ id: c.id, score: 0, probability: i === 0 ? 1 : 0 }))
  } else {
    // Softmax за probability estimate (запазва същия relative order както raw score сортиране,
    // затова top избора съвпада 1:1 с trainer-ската predictCard логика).
    const maxScore = Math.max(...scored.map((s) => s.score))
    const expScores = scored.map((s) => Math.exp(s.score - maxScore))
    const sumExp = expScores.reduce((a, b) => a + b, 0)
    ranking = scored
      .map((s, i) => ({ id: s.id, score: s.score, probability: expScores[i]! / sumExp }))
      .sort((a, b) => b.score - a.score)
  }

  const topValid = ranking.find((r) => legalIds.has(r.id))
  let selectedCard: string
  if (!topValid) {
    fallbackUsed = true
    fallbackReason = fallbackReason ?? 'Ranking-ът не съдържа валидна карта от legalCards — fallback към legalCards[0].'
    selectedCard = legalCards[0]!.id
  } else {
    selectedCard = topValid.id
  }

  // Финална safety net — гарантира, че НИКОГА не се връща карта извън legalCards.
  if (!legalIds.has(selectedCard)) {
    selectedCard = legalCards[0]!.id
    fallbackUsed = true
    fallbackReason = 'Safety net: избраната карта беше извън legalCards — принудителен fallback към legalCards[0].'
  }

  return {
    ranking,
    selectedCard,
    fallbackUsed,
    fallbackReason,
    validation: { legalCardsCount: legalCards.length, isForced: false, selectedCardIsLegal: legalIds.has(selectedCard) },
  }
}
