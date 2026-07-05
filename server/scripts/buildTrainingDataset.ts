/**
 * buildTrainingDataset.ts
 *
 * Локален dataset builder за AI bot training — чете .tar.gz архив с training
 * recorder JSONL записи и export-ва САМО човешки manual решения (bidding и
 * card play), заедно с machine/human-readable отчети.
 *
 * Не променя recorder writer-а, runtime bot strategy, gameplay, matchmaking,
 * economy или client protocol — това е read-only offline инструмент.
 *
 * Usage:
 *   npm run build:training-dataset [-- path/to/archive.tar.gz]
 *
 * Без аргумент, използва default архива:
 *   <repo-root>/training-recorder-audit-20260704-144842.tar.gz
 *
 * Exit codes:
 *   0 — успешен export + validation
 *   1 — критична грешка (malformed JSON, invalid chosenCard, privacy violation)
 *   2 — file system / archive read грешка
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readJsonlFilesFromTarGz } from './trainingDataset/tarGzJsonlReader.js'
import { scanFileForForbiddenContent, type SanitizationViolation } from './trainingDataset/sanitizeOutput.js'
import {
  computeCardMemorySnapshot,
  computeCandidateMemoryFeatures,
  computeSuitExhaustedExceptOwnCards,
  type CardMemorySnapshot,
  type CandidateMemoryFeatures,
  type CompactCard as MemoryCompactCard,
  type MemoryComputationInput,
} from './trainingDataset/cardMemoryFeatures.js'
import { SERVER_SUITS } from '../src/game/serverCardConstants.js'
import type {
  AnyTrainingRecord,
  TrainingActorKind,
  TrainingDealRecord,
} from '../src/trainingRecorder/trainingRecorderTypes.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..') // server/scripts → server → repo root
const DEFAULT_ARCHIVE_NAME = 'training-recorder-audit-20260704-144842.tar.gz'
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')

const CARD_DECISIONS_PATH = join(OUTPUT_DIR, 'card-decisions.jsonl')
const BIDDING_DECISIONS_PATH = join(OUTPUT_DIR, 'bidding-decisions.jsonl')
const SUMMARY_JSON_PATH = join(OUTPUT_DIR, 'summary.json')
const SUMMARY_MD_PATH = join(OUTPUT_DIR, 'summary.md')

// ─── Types ────────────────────────────────────────────────────────────────────

type CriticalError = {
  kind: 'parse' | 'validation'
  area?: 'card' | 'bidding-hand' | 'memory'
  file: string
  line: number
  message: string
}

type ActorKindCounts = Partial<Record<TrainingActorKind, number>>

type BuildStats = {
  filesRead: number
  totalRecordsRead: number
  blankLinesIgnored: number
  fullDeals: number
  biddingOnlyDeals: number
  incompleteDeals: number
  biddingActorKindCounts: ActorKindCounts
  cardActorKindCounts: ActorKindCounts
  exportedBiddingDecisions: number
  exportedCardDecisions: number
  // ─── Memory feature coverage (виж cardMemoryFeatures.ts) ──────────────────
  memorySamplesWithPlayedCardsSoFar: number
  memoryOwnCleanWinnersTotal: number
  memoryOwnCleanWinnersHistogram: Record<string, number> // count-of-clean-winners -> брой decisions
  memoryCandidateIsCleanWinnerCount: number
  memoryShouldPreserveCleanWinnerCount: number
  memorySuitExhaustedExceptOwnCardsCount: number
  memoryRemainingTrumpCountHistogram: Record<string, number>
  memoryVoidSuitsBySeatObservations: number
  memoryPartnerVoidSuitsObservations: number
  memoryOpponentVoidSuitsObservations: number
  memoryKnownCannotHaveObservations: number
}

function createStats(filesRead: number): BuildStats {
  return {
    filesRead,
    totalRecordsRead: 0,
    blankLinesIgnored: 0,
    fullDeals: 0,
    biddingOnlyDeals: 0,
    incompleteDeals: 0,
    biddingActorKindCounts: {},
    cardActorKindCounts: {},
    exportedBiddingDecisions: 0,
    exportedCardDecisions: 0,
    memorySamplesWithPlayedCardsSoFar: 0,
    memoryOwnCleanWinnersTotal: 0,
    memoryOwnCleanWinnersHistogram: {},
    memoryCandidateIsCleanWinnerCount: 0,
    memoryShouldPreserveCleanWinnerCount: 0,
    memorySuitExhaustedExceptOwnCardsCount: 0,
    memoryRemainingTrumpCountHistogram: {},
    memoryVoidSuitsBySeatObservations: 0,
    memoryPartnerVoidSuitsObservations: 0,
    memoryOpponentVoidSuitsObservations: 0,
    memoryKnownCannotHaveObservations: 0,
  }
}

function bumpActorKind(counts: ActorKindCounts, kind: TrainingActorKind): void {
  counts[kind] = (counts[kind] ?? 0) + 1
}

// ─── Memory snapshot validation (защита срещу измислени/невъзможни данни) ────
// Виж task изискванията: snapshot трябва да е ПРЕДИ chosenCard, без дубликати/
// overlap, без невъзможни deck брой, и suitExhaustedExceptOwnCards/
// candidateIsCleanWinner трябва да са arithmetically/logically консистентни.
function validateMemorySnapshot(
  input: MemoryComputationInput,
  snapshot: CardMemorySnapshot,
  suitExhaustedExceptOwnCards: Record<string, boolean>,
  chosenCardMemoryFeatures: CandidateMemoryFeatures,
  chosenCard: MemoryCompactCard,
): string[] {
  const errors: string[] = []

  const playedIds = snapshot.playedCardsSoFar.map((c) => c.id)
  const playedIdSet = new Set(playedIds)
  if (playedIdSet.size !== playedIds.length) {
    errors.push('memory: playedCardsSoFar съдържа дублирани карти')
  }

  const handIds = new Set(input.ownHand.map((c) => c.id))
  for (const id of playedIdSet) {
    if (handIds.has(id)) {
      errors.push(`memory: карта "${id}" е едновременно в ownHand и playedCardsSoFar`)
    }
  }

  if (playedIdSet.has(chosenCard.id)) {
    errors.push(`memory: chosenCard "${chosenCard.id}" вече присъства в playedCardsSoFar`)
  }

  if (snapshot.remainingCardsCount < 0) {
    errors.push(`memory: невъзможен remainingCardsCount=${snapshot.remainingCardsCount} (отрицателен)`)
  }
  if (input.ownHand.length + snapshot.playedCardsSoFar.length > 32) {
    errors.push(
      `memory: невъзможен deck count — ownHand(${input.ownHand.length}) + playedCardsSoFar(${snapshot.playedCardsSoFar.length}) > 32`,
    )
  }

  for (const [suit, exhausted] of Object.entries(suitExhaustedExceptOwnCards)) {
    if (!exhausted) continue
    const played = snapshot.playedCardsBySuit[suit] ?? 0
    const own = input.ownHand.filter((c) => c.suit === suit).length
    if (played + own !== 8) {
      errors.push(`memory: suitExhaustedExceptOwnCards["${suit}"]=true, но played(${played})+ownHand(${own}) !== 8`)
    }
  }

  if (chosenCardMemoryFeatures.candidateIsCleanWinner && chosenCardMemoryFeatures.higherRemainingCardsCount !== 0) {
    errors.push(
      `memory: candidateIsCleanWinner=true за chosenCard, но higherRemainingCardsCount=${chosenCardMemoryFeatures.higherRemainingCardsCount} (очаквано 0)`,
    )
  }

  return errors
}

// Валидира, че всяка карта в ownHand има очакваната ServerCard форма
// ({id, suit, rank}, всички непразни низове) — същия representation, който
// вече се използва за ownHand/legalCards/chosenCard в card decisions.
function isValidCompactCard(card: unknown): card is { id: string; suit: string; rank: string } {
  if (typeof card !== 'object' || card === null) return false
  const c = card as Record<string, unknown>
  return (
    typeof c.id === 'string' && c.id.length > 0 &&
    typeof c.suit === 'string' && c.suit.length > 0 &&
    typeof c.rank === 'string' && c.rank.length > 0
  )
}

// ─── Export record shapes (pseudonymized-only fields, no raw identifiers) ────

type CardDecisionRecord = {
  recordingId: string
  roomKey: string
  dealIndex: number
  sequence: number
  trickIndex: number
  positionInTrick: number
  seat: string
  playerKey: string | null
  ownHand: unknown
  legalCards: unknown
  chosenCard: unknown
  contract: unknown
  playedCardCountBeforeAction: number
  currentTrick: unknown
  currentWinningSeat: unknown
  currentWinningCard: unknown
  dealerSeat: unknown
  leaderSeat: unknown
  scoreBeforeDeal: unknown
  // ─── Belot card memory / belief-tracker enrichment (виж cardMemoryFeatures.ts) ─
  // Изцяло derived от deal.tricks (recorder-ски, вече записани на deal-ниво) +
  // action.visibleBeforeAction.currentTrick — БЕЗ recorder writer промяна.
  memory: CardMemorySnapshot & { suitExhaustedExceptOwnCards: Record<string, boolean> }
  chosenCardMemoryFeatures: CandidateMemoryFeatures
  legalCardsMemoryFeatures: CandidateMemoryFeatures[]
}

type BiddingDecisionRecord = {
  recordingId: string
  roomKey: string
  dealIndex: number
  sequence: number
  seat: string
  playerKey: string | null
  ownHand: unknown
  dealerSeat: unknown
  scoreBeforeDeal: unknown
  previousBids: unknown
  legalActions: unknown
  chosenAction: unknown
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const archiveArg = args.find((a) => !a.startsWith('-'))
  const archivePath = archiveArg ? resolve(process.cwd(), archiveArg) : join(REPO_ROOT, DEFAULT_ARCHIVE_NAME)

  console.log('─────────────────────────────────────────')
  console.log('  AI Training Dataset Builder (локален)')
  console.log('─────────────────────────────────────────')
  console.log(`  Архив:  ${archivePath}`)
  console.log(`  Output: ${OUTPUT_DIR}\n`)

  await rm(OUTPUT_DIR, { recursive: true, force: true })
  await mkdir(OUTPUT_DIR, { recursive: true })

  let jsonlFiles: Awaited<ReturnType<typeof readJsonlFilesFromTarGz>>
  try {
    jsonlFiles = await readJsonlFilesFromTarGz(archivePath)
  } catch (e) {
    console.error(`FATAL: не мога да прочета архива: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
    return
  }

  if (jsonlFiles.length === 0) {
    console.error('FATAL: няма намерени .jsonl файлове в архива')
    process.exit(2)
    return
  }

  console.log(`  Намерени ${jsonlFiles.length} .jsonl файла в архива:`)
  for (const f of jsonlFiles) console.log(`    - ${f.archivePath}`)
  console.log('')

  const stats = createStats(jsonlFiles.length)
  const criticalErrors: CriticalError[] = []
  const cardDecisionLines: string[] = []
  const biddingDecisionLines: string[] = []

  for (const file of jsonlFiles) {
    const lines = file.content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i]!
      const trimmed = rawLine.trim()
      if (!trimmed) {
        stats.blankLinesIgnored++
        continue
      }

      let parsed: AnyTrainingRecord
      try {
        parsed = JSON.parse(trimmed) as AnyTrainingRecord
      } catch (e) {
        criticalErrors.push({
          kind: 'parse',
          file: file.archivePath,
          line: i + 1,
          message: e instanceof Error ? e.message : String(e),
        })
        continue
      }

      stats.totalRecordsRead++

      if (!parsed.completed) {
        stats.incompleteDeals++
        continue
      }

      const deal = parsed as TrainingDealRecord
      if (deal.recordKind === 'full') stats.fullDeals++
      else if (deal.recordKind === 'bidding_only') stats.biddingOnlyDeals++

      for (const action of deal.biddingActions ?? []) {
        bumpActorKind(stats.biddingActorKindCounts, action.actorKind)
        if (action.actorKind !== 'human_manual') continue

        const ownHand = action.visibleBeforeAction.ownHand

        if (!Array.isArray(ownHand) || ownHand.length === 0) {
          criticalErrors.push({
            kind: 'validation',
            area: 'bidding-hand',
            file: file.archivePath,
            line: i + 1,
            message: `bidding ownHand липсва/празно (recordingId=${deal.recordingId}, sequence=${action.sequence})`,
          })
          continue
        }
        if (!ownHand.every(isValidCompactCard)) {
          criticalErrors.push({
            kind: 'validation',
            area: 'bidding-hand',
            file: file.archivePath,
            line: i + 1,
            message: `bidding ownHand съдържа невалидна card representation (recordingId=${deal.recordingId}, sequence=${action.sequence})`,
          })
          continue
        }

        const record: BiddingDecisionRecord = {
          recordingId: deal.recordingId,
          roomKey: deal.roomKey,
          dealIndex: deal.dealIndex,
          sequence: action.sequence,
          seat: action.seat,
          playerKey: deal.seats[action.seat]?.playerKey ?? null,
          ownHand,
          dealerSeat: action.visibleBeforeAction.dealerSeat,
          scoreBeforeDeal: action.visibleBeforeAction.scoreBeforeDeal,
          previousBids: action.visibleBeforeAction.previousBids,
          legalActions: action.visibleBeforeAction.legalActions,
          chosenAction: action.chosenAction,
        }
        biddingDecisionLines.push(JSON.stringify(record))
        stats.exportedBiddingDecisions++
      }

      for (const action of deal.cardActions ?? []) {
        bumpActorKind(stats.cardActorKindCounts, action.actorKind)
        if (action.actorKind !== 'human_manual') continue

        const legalIds = new Set(action.visibleBeforeAction.legalCards.map((c) => c.id))
        const handIds = new Set(action.visibleBeforeAction.ownHand.map((c) => c.id))

        if (!legalIds.has(action.chosenCard.id)) {
          criticalErrors.push({
            kind: 'validation',
            area: 'card',
            file: file.archivePath,
            line: i + 1,
            message: `chosenCard "${action.chosenCard.id}" не е в legalCards (recordingId=${deal.recordingId}, sequence=${action.sequence})`,
          })
          continue
        }
        if (!handIds.has(action.chosenCard.id)) {
          criticalErrors.push({
            kind: 'validation',
            area: 'card',
            file: file.archivePath,
            line: i + 1,
            message: `chosenCard "${action.chosenCard.id}" не е в ownHand (recordingId=${deal.recordingId}, sequence=${action.sequence})`,
          })
          continue
        }

        // ─── Belot card memory snapshot (виж cardMemoryFeatures.ts за пълния алгоритъм) ─
        const memoryInput: MemoryComputationInput = {
          seat: action.seat,
          ownHand: action.visibleBeforeAction.ownHand,
          legalCards: action.visibleBeforeAction.legalCards,
          contract: action.visibleBeforeAction.contract.contract,
          trumpSuit: action.visibleBeforeAction.contract.trumpSuit,
          completedTricksSoFar: (deal.tricks ?? [])
            .filter((t) => t.trickIndex < action.trickIndex)
            .map((t) => ({ plays: t.plays.map((p) => ({ seat: p.seat, card: p.card })) })),
          currentTrickPlaysSoFar: action.visibleBeforeAction.currentTrick.map((p) => ({ seat: p.seat, card: p.card })),
        }
        const memorySnapshot = computeCardMemorySnapshot(memoryInput)
        const ownHandBySuit: Record<string, number> = {}
        for (const suit of SERVER_SUITS) ownHandBySuit[suit] = 0
        for (const c of memoryInput.ownHand) ownHandBySuit[c.suit] = (ownHandBySuit[c.suit] ?? 0) + 1
        const suitExhaustedExceptOwnCards: Record<string, boolean> = {}
        for (const suit of SERVER_SUITS) suitExhaustedExceptOwnCards[suit] = computeSuitExhaustedExceptOwnCards(memorySnapshot, ownHandBySuit, suit)

        const chosenCardMemoryFeatures = computeCandidateMemoryFeatures(memoryInput, memorySnapshot, action.chosenCard)
        const legalCardsMemoryFeatures = memoryInput.legalCards.map((c) => computeCandidateMemoryFeatures(memoryInput, memorySnapshot, c))

        const memoryValidationErrors = validateMemorySnapshot(
          memoryInput, memorySnapshot, suitExhaustedExceptOwnCards, chosenCardMemoryFeatures, action.chosenCard,
        )
        if (memoryValidationErrors.length > 0) {
          for (const message of memoryValidationErrors) {
            criticalErrors.push({
              kind: 'validation',
              area: 'memory',
              file: file.archivePath,
              line: i + 1,
              message: `${message} (recordingId=${deal.recordingId}, sequence=${action.sequence})`,
            })
          }
          continue
        }

        // ─── Memory coverage stats ─────────────────────────────────────────────
        if (memorySnapshot.playedCardsSoFar.length > 0 || memorySnapshot.trickNumber > 0) stats.memorySamplesWithPlayedCardsSoFar++
        stats.memoryOwnCleanWinnersTotal += memorySnapshot.ownCleanWinnersCount
        const cleanWinnerBucket = String(memorySnapshot.ownCleanWinnersCount)
        stats.memoryOwnCleanWinnersHistogram[cleanWinnerBucket] = (stats.memoryOwnCleanWinnersHistogram[cleanWinnerBucket] ?? 0) + 1
        if (chosenCardMemoryFeatures.candidateIsCleanWinner) stats.memoryCandidateIsCleanWinnerCount++
        if (chosenCardMemoryFeatures.shouldPreserveCleanWinner) stats.memoryShouldPreserveCleanWinnerCount++
        if (Object.values(suitExhaustedExceptOwnCards).some(Boolean)) stats.memorySuitExhaustedExceptOwnCardsCount++
        const trumpBucket = String(memorySnapshot.remainingTrumpCount)
        stats.memoryRemainingTrumpCountHistogram[trumpBucket] = (stats.memoryRemainingTrumpCountHistogram[trumpBucket] ?? 0) + 1
        if (Object.values(memorySnapshot.voidSuitsBySeat).some((arr) => arr.length > 0)) stats.memoryVoidSuitsBySeatObservations++
        if (memorySnapshot.partnerVoidSuits.length > 0) stats.memoryPartnerVoidSuitsObservations++
        if (Object.values(memorySnapshot.opponentVoidSuits).some((arr) => arr.length > 0)) stats.memoryOpponentVoidSuitsObservations++
        if (Object.keys(memorySnapshot.knownCannotHaveCardsBySeat).length > 0) stats.memoryKnownCannotHaveObservations++

        const record: CardDecisionRecord = {
          recordingId: deal.recordingId,
          roomKey: deal.roomKey,
          dealIndex: deal.dealIndex,
          sequence: action.sequence,
          trickIndex: action.trickIndex,
          positionInTrick: action.positionInTrick,
          seat: action.seat,
          playerKey: deal.seats[action.seat]?.playerKey ?? null,
          ownHand: action.visibleBeforeAction.ownHand,
          legalCards: action.visibleBeforeAction.legalCards,
          chosenCard: action.chosenCard,
          contract: action.visibleBeforeAction.contract,
          playedCardCountBeforeAction: action.visibleBeforeAction.playedCardCountBeforeAction,
          currentTrick: action.visibleBeforeAction.currentTrick,
          currentWinningSeat: action.visibleBeforeAction.currentWinningSeat,
          currentWinningCard: action.visibleBeforeAction.currentWinningCard,
          dealerSeat: action.visibleBeforeAction.dealerSeat,
          leaderSeat: action.visibleBeforeAction.leaderSeat,
          scoreBeforeDeal: action.visibleBeforeAction.scoreBeforeDeal,
          memory: { ...memorySnapshot, suitExhaustedExceptOwnCards },
          chosenCardMemoryFeatures,
          legalCardsMemoryFeatures,
        }
        cardDecisionLines.push(JSON.stringify(record))
        stats.exportedCardDecisions++
      }
    }
  }

  const parseErrorCount = criticalErrors.filter((e) => e.kind === 'parse').length
  const validationErrorCount = criticalErrors.filter((e) => e.kind === 'validation').length
  const cardValidationErrorCount = criticalErrors.filter((e) => e.kind === 'validation' && e.area === 'card').length
  const biddingHandValidationErrorCount = criticalErrors.filter((e) => e.kind === 'validation' && e.area === 'bidding-hand').length
  const memoryValidationErrorCount = criticalErrors.filter((e) => e.kind === 'validation' && e.area === 'memory').length

  if (criticalErrors.length > 0) {
    console.error(`\n✗ Открити ${criticalErrors.length} критични грешки — export СПРЯН, dataset файлове НЕ СА записани.\n`)
    for (const err of criticalErrors) {
      console.error(`  [${err.kind.toUpperCase()}] ${err.file}:${err.line}: ${err.message}`)
    }

    await writeSummary({
      status: 'failed',
      archivePath,
      stats,
      parseErrorCount,
      validationErrorCount,
      cardValidationErrorCount,
      biddingHandValidationErrorCount,
      memoryValidationErrorCount,
      sanitizationViolations: [],
      criticalErrors,
    })

    console.error(`\nОтчет записан в: ${SUMMARY_JSON_PATH} / ${SUMMARY_MD_PATH}`)
    process.exit(1)
    return
  }

  // Няма критични грешки → записваме dataset файловете.
  await writeFile(CARD_DECISIONS_PATH, cardDecisionLines.length > 0 ? cardDecisionLines.join('\n') + '\n' : '', 'utf8')
  await writeFile(BIDDING_DECISIONS_PATH, biddingDecisionLines.length > 0 ? biddingDecisionLines.join('\n') + '\n' : '', 'utf8')

  const datasetViolations: SanitizationViolation[] = [
    ...(await scanFileForForbiddenContent(CARD_DECISIONS_PATH)),
    ...(await scanFileForForbiddenContent(BIDDING_DECISIONS_PATH)),
  ]

  await writeSummary({
    status: datasetViolations.length > 0 ? 'failed' : 'ok',
    archivePath,
    stats,
    parseErrorCount,
    validationErrorCount,
    cardValidationErrorCount,
    biddingHandValidationErrorCount,
    memoryValidationErrorCount,
    sanitizationViolations: datasetViolations,
    criticalErrors: [],
  })

  const summaryViolations: SanitizationViolation[] = [
    ...(await scanFileForForbiddenContent(SUMMARY_JSON_PATH)),
    ...(await scanFileForForbiddenContent(SUMMARY_MD_PATH)),
  ]

  const allViolations = [...datasetViolations, ...summaryViolations]

  printFinalReport(stats)

  if (allViolations.length > 0) {
    console.error(`\n✗ Privacy/sanitization validation ПРОВАЛЕНА — намерени ${allViolations.length} нарушения:\n`)
    for (const v of allViolations) {
      console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    }
    process.exit(1)
    return
  }

  console.log('\n✓ Privacy/sanitization validation: PASS')
  console.log('✓ Dataset export завършен успешно.\n')
  process.exit(0)
}

// ─── Summary writers ──────────────────────────────────────────────────────────

type SummaryInput = {
  status: 'ok' | 'failed'
  archivePath: string
  stats: BuildStats
  parseErrorCount: number
  validationErrorCount: number
  cardValidationErrorCount: number
  biddingHandValidationErrorCount: number
  memoryValidationErrorCount: number
  sanitizationViolations: SanitizationViolation[]
  criticalErrors: CriticalError[]
}

async function writeSummary(input: SummaryInput): Promise<void> {
  const {
    status, archivePath, stats, parseErrorCount, validationErrorCount,
    cardValidationErrorCount, biddingHandValidationErrorCount, memoryValidationErrorCount, sanitizationViolations, criticalErrors,
  } = input

  const ignoredBiddingActorKinds = { ...stats.biddingActorKindCounts }
  const ignoredCardActorKinds = { ...stats.cardActorKindCounts }
  delete ignoredBiddingActorKinds.human_manual
  delete ignoredCardActorKinds.human_manual

  const exportedCard = stats.exportedCardDecisions
  const memoryCoverage = {
    samplesWithPlayedCardsSoFarPct: exportedCard > 0 ? stats.memorySamplesWithPlayedCardsSoFar / exportedCard : 0,
    ownCleanWinnersAvg: exportedCard > 0 ? stats.memoryOwnCleanWinnersTotal / exportedCard : 0,
    ownCleanWinnersHistogram: stats.memoryOwnCleanWinnersHistogram,
    candidateIsCleanWinnerCount: stats.memoryCandidateIsCleanWinnerCount,
    candidateIsCleanWinnerPct: exportedCard > 0 ? stats.memoryCandidateIsCleanWinnerCount / exportedCard : 0,
    shouldPreserveCleanWinnerCount: stats.memoryShouldPreserveCleanWinnerCount,
    shouldPreserveCleanWinnerPct: exportedCard > 0 ? stats.memoryShouldPreserveCleanWinnerCount / exportedCard : 0,
    suitExhaustedExceptOwnCardsCount: stats.memorySuitExhaustedExceptOwnCardsCount,
    suitExhaustedExceptOwnCardsPct: exportedCard > 0 ? stats.memorySuitExhaustedExceptOwnCardsCount / exportedCard : 0,
    remainingTrumpCountHistogram: stats.memoryRemainingTrumpCountHistogram,
    voidSuitsBySeatObservationsPct: exportedCard > 0 ? stats.memoryVoidSuitsBySeatObservations / exportedCard : 0,
    partnerVoidSuitsObservationsPct: exportedCard > 0 ? stats.memoryPartnerVoidSuitsObservations / exportedCard : 0,
    opponentVoidSuitsObservationsPct: exportedCard > 0 ? stats.memoryOpponentVoidSuitsObservations / exportedCard : 0,
    knownCannotHaveObservationsPct: exportedCard > 0 ? stats.memoryKnownCannotHaveObservations / exportedCard : 0,
  }

  const summaryJson = {
    generatedAt: new Date().toISOString(),
    status,
    archiveFileName: archivePath.split(/[\\/]/).pop(),
    totalRecorderFilesRead: stats.filesRead,
    totalRecordsRead: stats.totalRecordsRead,
    blankLinesIgnored: stats.blankLinesIgnored,
    recordKindCounts: {
      full: stats.fullDeals,
      biddingOnly: stats.biddingOnlyDeals,
      incomplete: stats.incompleteDeals,
    },
    totalHumanManualBiddingActions: stats.biddingActorKindCounts.human_manual ?? 0,
    totalHumanManualCardActions: stats.cardActorKindCounts.human_manual ?? 0,
    exportedBiddingDecisions: stats.exportedBiddingDecisions,
    exportedCardDecisions: stats.exportedCardDecisions,
    ignoredActorKindCounts: {
      bidding: ignoredBiddingActorKinds,
      card: ignoredCardActorKinds,
    },
    parseErrorCount,
    validationErrorCount,
    cardValidationErrorCount,
    biddingHandValidationErrorCount,
    memoryValidationErrorCount,
    biddingOwnHandIncluded: true,
    sanitizationViolationCount: sanitizationViolations.length,
    memoryFeatureCoverage: memoryCoverage,
    outputFiles: {
      cardDecisions: 'training-output/card-decisions.jsonl',
      biddingDecisions: 'training-output/bidding-decisions.jsonl',
      summaryJson: 'training-output/summary.json',
      summaryMd: 'training-output/summary.md',
    },
    ...(criticalErrors.length > 0
      ? { criticalErrors: criticalErrors.slice(0, 200).map((e) => ({ kind: e.kind, file: e.file, line: e.line, message: e.message })) }
      : {}),
  }

  await writeFile(SUMMARY_JSON_PATH, JSON.stringify(summaryJson, null, 2) + '\n', 'utf8')
  await writeFile(SUMMARY_MD_PATH, buildSummaryMarkdown(summaryJson), 'utf8')
}

function buildSummaryMarkdown(s: {
  generatedAt: string
  status: string
  archiveFileName: string | undefined
  totalRecorderFilesRead: number
  totalRecordsRead: number
  blankLinesIgnored: number
  recordKindCounts: { full: number; biddingOnly: number; incomplete: number }
  totalHumanManualBiddingActions: number
  totalHumanManualCardActions: number
  exportedBiddingDecisions: number
  exportedCardDecisions: number
  ignoredActorKindCounts: { bidding: ActorKindCounts; card: ActorKindCounts }
  parseErrorCount: number
  validationErrorCount: number
  cardValidationErrorCount: number
  biddingHandValidationErrorCount: number
  memoryValidationErrorCount: number
  biddingOwnHandIncluded: boolean
  sanitizationViolationCount: number
  memoryFeatureCoverage: {
    samplesWithPlayedCardsSoFarPct: number
    ownCleanWinnersAvg: number
    ownCleanWinnersHistogram: Record<string, number>
    candidateIsCleanWinnerCount: number
    candidateIsCleanWinnerPct: number
    shouldPreserveCleanWinnerCount: number
    shouldPreserveCleanWinnerPct: number
    suitExhaustedExceptOwnCardsCount: number
    suitExhaustedExceptOwnCardsPct: number
    remainingTrumpCountHistogram: Record<string, number>
    voidSuitsBySeatObservationsPct: number
    partnerVoidSuitsObservationsPct: number
    opponentVoidSuitsObservationsPct: number
    knownCannotHaveObservationsPct: number
  }
  criticalErrors?: Array<{ kind: string; file: string; line: number; message: string }>
}): string {
  const lines: string[] = []
  lines.push('# Training Dataset Builder — отчет')
  lines.push('')
  lines.push(`Генериран на: ${s.generatedAt}`)
  lines.push(`Архив: \`${s.archiveFileName}\``)
  lines.push(`Статус: **${s.status === 'ok' ? 'УСПЕХ ✓' : 'ПРОВАЛ ✗'}**`)
  lines.push('')
  lines.push('## Recorder файлове')
  lines.push('')
  lines.push(`- Прочетени .jsonl файлове: ${s.totalRecorderFilesRead}`)
  lines.push(`- Общо records: ${s.totalRecordsRead}`)
  lines.push(`- Игнорирани празни редове: ${s.blankLinesIgnored}`)
  lines.push(`- Full deals: ${s.recordKindCounts.full}`)
  lines.push(`- Bidding-only (all-pass): ${s.recordKindCounts.biddingOnly}`)
  lines.push(`- Incomplete deals: ${s.recordKindCounts.incomplete}`)
  lines.push('')
  lines.push('## Human manual решения')
  lines.push('')
  lines.push(`- Общо human_manual bidding actions: ${s.totalHumanManualBiddingActions}`)
  lines.push(`- Общо human_manual card actions: ${s.totalHumanManualCardActions}`)
  lines.push(`- Export-нати bidding decisions: ${s.exportedBiddingDecisions}`)
  lines.push(`- Export-нати card decisions: ${s.exportedCardDecisions}`)
  lines.push('')
  lines.push('## Игнорирани (не-human_manual) actorKind')
  lines.push('')
  lines.push('**Bidding actions:**')
  for (const [k, v] of Object.entries(s.ignoredActorKindCounts.bidding)) lines.push(`- ${k}: ${v}`)
  lines.push('')
  lines.push('**Card actions:**')
  for (const [k, v] of Object.entries(s.ignoredActorKindCounts.card)) lines.push(`- ${k}: ${v}`)
  lines.push('')
  lines.push('## Validation')
  lines.push('')
  lines.push(`- Parse errors: ${s.parseErrorCount}`)
  lines.push(`- Validation errors общо: ${s.validationErrorCount}`)
  lines.push(`  - Card validation errors (chosenCard не в legalCards/ownHand): ${s.cardValidationErrorCount}`)
  lines.push(`  - Bidding hand validation errors (ownHand липсва/празно/невалидно): ${s.biddingHandValidationErrorCount}`)
  lines.push(`  - Memory validation errors (viж cardMemoryFeatures.ts — дубликати/overlap/impossible deck count/arithmetic несъответствие): ${s.memoryValidationErrorCount}`)
  lines.push(`- Bidding decisions включват ownHand: ${s.biddingOwnHandIncluded ? 'ДА' : 'НЕ'}`)
  lines.push(`- Sanitization violations: ${s.sanitizationViolationCount}`)
  lines.push('')

  lines.push('## Memory feature coverage (Belot card memory / belief-tracker enrichment)')
  lines.push('')
  lines.push(
    'Всяко card decision вече включва `memory` snapshot (played/remaining cards, void suits, clean winners, ' +
    'trick context) + `chosenCardMemoryFeatures`/`legalCardsMemoryFeatures` (per-candidate higherRemainingCardsCount/ ' +
    'candidateIsCleanWinner/shouldPreserveCleanWinner) — виж server/scripts/trainingDataset/cardMemoryFeatures.ts.',
  )
  lines.push('')
  const mc = s.memoryFeatureCoverage
  lines.push(`- Samples с непразен playedCardsSoFar (trickNumber>0 или вече изиграни карти в текущия trick): ${(mc.samplesWithPlayedCardsSoFarPct * 100).toFixed(1)}%`)
  lines.push(`- Среден брой ownCleanWinners на decision: ${mc.ownCleanWinnersAvg.toFixed(2)}`)
  lines.push('- Хистограма ownCleanWinnersCount (брой decisions по count):')
  for (const [count, n] of Object.entries(mc.ownCleanWinnersHistogram).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    lines.push(`  - ${count}: ${n}`)
  }
  lines.push(`- candidateIsCleanWinner=true (за chosenCard): ${mc.candidateIsCleanWinnerCount} (${(mc.candidateIsCleanWinnerPct * 100).toFixed(1)}%)`)
  lines.push(`- shouldPreserveCleanWinner=true (за chosenCard): ${mc.shouldPreserveCleanWinnerCount} (${(mc.shouldPreserveCleanWinnerPct * 100).toFixed(1)}%)`)
  lines.push(`- suitExhaustedExceptOwnCards=true за поне 1 боя: ${mc.suitExhaustedExceptOwnCardsCount} (${(mc.suitExhaustedExceptOwnCardsPct * 100).toFixed(1)}%)`)
  lines.push('- Хистограма remainingTrumpCount:')
  for (const [count, n] of Object.entries(mc.remainingTrumpCountHistogram).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    lines.push(`  - ${count}: ${n}`)
  }
  lines.push(`- Decisions с поне 1 known void suit (произволен seat): ${(mc.voidSuitsBySeatObservationsPct * 100).toFixed(1)}%`)
  lines.push(`- Decisions с известен partner void suit: ${(mc.partnerVoidSuitsObservationsPct * 100).toFixed(1)}%`)
  lines.push(`- Decisions с известен opponent void suit: ${(mc.opponentVoidSuitsObservationsPct * 100).toFixed(1)}%`)
  lines.push(`- Decisions с поне 1 knownCannotHaveCardsBySeat (overtrump-failure дедукция): ${(mc.knownCannotHaveObservationsPct * 100).toFixed(1)}%`)
  lines.push('')

  if (s.criticalErrors && s.criticalErrors.length > 0) {
    lines.push('## Критични грешки (първите 200)')
    lines.push('')
    for (const e of s.criticalErrors) {
      lines.push(`- [${e.kind}] ${e.file}:${e.line}: ${e.message}`)
    }
    lines.push('')
  }

  lines.push('## Изходни файлове')
  lines.push('')
  lines.push('- `training-output/card-decisions.jsonl`')
  lines.push('- `training-output/bidding-decisions.jsonl`')
  lines.push('- `training-output/summary.json`')
  lines.push('- `training-output/summary.md`')
  lines.push('')

  return lines.join('\n')
}

function printFinalReport(stats: BuildStats): void {
  console.log('─────────────────────────────────────────')
  console.log('  Резултат')
  console.log('─────────────────────────────────────────')
  console.log(`  Recorder файлове:            ${stats.filesRead}`)
  console.log(`  Общо records:                ${stats.totalRecordsRead}`)
  console.log(`  Full deals:                  ${stats.fullDeals}`)
  console.log(`  Bidding-only (all-pass):     ${stats.biddingOnlyDeals}`)
  console.log(`  Incomplete deals:            ${stats.incompleteDeals}`)
  console.log(`  Exported bidding decisions:  ${stats.exportedBiddingDecisions}`)
  console.log(`  Exported card decisions:     ${stats.exportedCardDecisions}`)
  console.log('─────────────────────────────────────────')
  console.log(`  Memory: ownCleanWinners avg=${stats.exportedCardDecisions > 0 ? (stats.memoryOwnCleanWinnersTotal / stats.exportedCardDecisions).toFixed(2) : '0.00'}, ` +
    `candidateIsCleanWinner=${stats.memoryCandidateIsCleanWinnerCount}, shouldPreserve=${stats.memoryShouldPreserveCleanWinnerCount}, ` +
    `suitExhausted=${stats.memorySuitExhaustedExceptOwnCardsCount}, knownCannotHave=${stats.memoryKnownCannotHaveObservations}`)
  console.log('─────────────────────────────────────────')
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
