/**
 * analyzePartnerSignalMemory.ts
 *
 * Local-only, read-only offline analysis — checks whether REAL human card
 * decisions (training-output/card-decisions.jsonl) confirm the partner-signal
 * conventions that the conventional bot (server/src/game/pickServerBotPlayCard.ts)
 * already assumes (see training-output/analysis/conventional-bot-logic-report.md):
 * partner led a suit → does the human later return it; partner drew trump →
 * does the human continue the draw; etc. This is NOT a runtime feature — it
 * produces a report to inform a FUTURE "Signal Memory" design for
 * server/src/ai/cardAdvisorPolicy.ts (not implemented here).
 *
 * Why this needs the raw recorder archive (not just card-decisions.jsonl):
 * the persisted per-decision `memory.playedCardsSoFar` is a FLAT, seat-less
 * card list (see server/scripts/trainingDataset/cardMemoryFeatures.ts) — it
 * cannot answer "did seat X lead suit S in trick 2" once flattened. The raw
 * archive's `TrainingDealRecord.tricks` retains full seat+card+trick
 * attribution, so cross-trick partner-signal reconstruction reads the SAME
 * archive `build:training-dataset` already reads (read-only, no recorder
 * writer changes), while all tactical-guard context (partnerCurrentlyWinning,
 * opponentCurrentlyWinning, pointsInTrick, candidateIsCleanWinner,
 * shouldPreserveCleanWinner) is REUSED from the already-computed
 * card-decisions.jsonl row (joined by recordingId+dealIndex+sequence) rather
 * than recomputed — single source of truth, no drift.
 *
 * Does not touch gameplay, matchmaking, economy, client protocol, recorder
 * writer, or pickServerBotPlayCard.ts/localAiCardBeta.ts. Does not implement
 * any runtime Signal Memory layer — offline analysis only.
 *
 * Usage:
 *   npm run analyze:partner-signal-memory   (от server/, след
 *   build:training-dataset — trebва training-output/card-decisions.jsonl да съществува)
 *
 * Exit codes:
 *   0 — успешно
 *   1 — invalid/missing input, privacy нарушение, schema грешка
 *   2 — file system грешка
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readJsonlFilesFromTarGz } from './trainingDataset/tarGzJsonlReader.js'
import {
  parseJsonlStrict,
  validateCardRecordV2,
  scanAllForbiddenContent,
  type CardRecordV2,
} from './humanMoveMemoryV2Shared.js'
import { getServerCardPoints } from '../src/game/serverScoring.js'
import { getServerCardRankPower } from '../src/game/getServerTrickWinner.js'
import type {
  AnyTrainingRecord,
  TrainingDealRecord,
  TrainingTrickResult,
} from '../src/trainingRecorder/trainingRecorderTypes.js'
import type { ServerSuit } from '../src/game/serverGameTypes.js'
import type { Seat } from '../src/core/serverTypes.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const DEFAULT_ARCHIVE_NAME = 'training-recorder-audit-20260704-144842.tar.gz'
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')
const CARD_DECISIONS_PATH = join(OUTPUT_DIR, 'card-decisions.jsonl')
const REPORT_DIR = join(OUTPUT_DIR, 'analysis')
const REPORT_JSON_PATH = join(REPORT_DIR, 'partner-signal-memory-analysis.json')
const REPORT_MD_PATH = join(REPORT_DIR, 'partner-signal-memory-analysis.md')

// ─── Seat/rank helpers (small local copies — this project's established convention: ─
// never import seat helpers from pickServerBotPlayCard.ts) ──────────────────────

const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']
function getPartnerSeat(seat: Seat): Seat {
  return SEAT_ORDER[(SEAT_ORDER.indexOf(seat) + 2) % 4]!
}

function isTrumpCard(suit: ServerSuit, contract: string, trumpSuit: ServerSuit | null): boolean {
  if (contract === 'all-trumps') return true
  if (contract === 'no-trumps') return false
  return trumpSuit !== null && suit === trumpSuit
}

const RANKS_HIGH_TO_LOW_BY_POWER = ['J', '9', 'A', '10', 'K', 'Q', '8', '7'] // trump order, for reference only
const HIGH_RANK_POWER_THRESHOLD = 5 // top 3 of 8 ranks (0..7 scale)
const LOW_RANK_POWER_THRESHOLD = 1 // bottom 2 of 8 ranks

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}
function pct(part: number, total: number): string {
  if (total === 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

// ─── Deal ledger (cross-trick, seat-attributed history, built from raw archive) ─

type SuitLeadEvent = { trickIndex: number; suit: ServerSuit; rank: string; rankPower: number; isHigh: boolean; isLow: boolean }
type SuitPlayEvent = { trickIndex: number; suit: ServerSuit }

type DealLedger = {
  suitLeadsBySeat: Record<Seat, SuitLeadEvent[]>
  suitPlaysBySeat: Record<Seat, SuitPlayEvent[]>
  voidSuitsBySeat: Record<Seat, Set<ServerSuit>>
  trumpLeadTricksBySeat: Record<Seat, number[]>
  /** trickIndex when the "top" remaining card of a led suit got played by anyone (suit was previously led at least once before this). */
  keyCardClearedTrickBySuit: Partial<Record<ServerSuit, number>>
}

function emptySeatRecord<T>(factory: () => T): Record<Seat, T> {
  return { bottom: factory(), right: factory(), top: factory(), left: factory() }
}

function topRankForSuit(suit: ServerSuit, contract: string, trumpSuit: ServerSuit | null): string {
  return isTrumpCard(suit, contract, trumpSuit) ? 'J' : 'A'
}

function buildDealLedger(deal: TrainingDealRecord): DealLedger {
  const contract = deal.finalContract?.contract ?? 'no-trumps'
  const trumpSuit = deal.finalContract?.trumpSuit ?? null

  const ledger: DealLedger = {
    suitLeadsBySeat: emptySeatRecord(() => []),
    suitPlaysBySeat: emptySeatRecord(() => []),
    voidSuitsBySeat: emptySeatRecord(() => new Set<ServerSuit>()),
    trumpLeadTricksBySeat: emptySeatRecord(() => []),
    keyCardClearedTrickBySuit: {},
  }

  const tricksSorted = [...deal.tricks].sort((a, b) => a.trickIndex - b.trickIndex)
  const suitLedBefore = new Set<ServerSuit>()

  for (const trick of tricksSorted) {
    if (trick.plays.length === 0) continue
    const ledSuit = trick.plays[0]!.card.suit
    const leadCard = trick.plays[0]!.card
    const isTrumpLead = isTrumpCard(ledSuit, contract, trumpSuit)
    const rankPower = getServerCardRankPower(leadCard.rank, isTrumpLead)

    ledger.suitLeadsBySeat[trick.leaderSeat]!.push({
      trickIndex: trick.trickIndex,
      suit: ledSuit,
      rank: leadCard.rank,
      rankPower,
      isHigh: rankPower >= HIGH_RANK_POWER_THRESHOLD,
      isLow: rankPower <= LOW_RANK_POWER_THRESHOLD,
    })

    if (contract === 'suit' && trumpSuit && ledSuit === trumpSuit) {
      ledger.trumpLeadTricksBySeat[trick.leaderSeat]!.push(trick.trickIndex)
    }

    const topRank = topRankForSuit(ledSuit, contract, trumpSuit)
    let keyCardPlayedThisTrick = false

    for (const play of trick.plays) {
      ledger.suitPlaysBySeat[play.seat]!.push({ trickIndex: trick.trickIndex, suit: play.card.suit })
      if (play.card.suit !== ledSuit) {
        ledger.voidSuitsBySeat[play.seat]!.add(ledSuit)
      }
      if (play.card.suit === ledSuit && play.card.rank === topRank) {
        keyCardPlayedThisTrick = true
      }
    }

    if (keyCardPlayedThisTrick && suitLedBefore.has(ledSuit) && ledger.keyCardClearedTrickBySuit[ledSuit] === undefined) {
      ledger.keyCardClearedTrickBySuit[ledSuit] = trick.trickIndex
    }
    suitLedBefore.add(ledSuit)
  }

  return ledger
}

// ─── Signal detection (queried at decision time, filtered to trickIndex < actionTrickIndex) ─

type SuitReturnSignal = {
  suit: ServerSuit
  signalTrickIndex: number
  isHigh: boolean
  isLow: boolean
  repeatCount: number
  keyCardCleared: boolean
  confidence: number
}

function detectPartnerSuitSignal(
  ledger: DealLedger,
  partnerSeat: Seat,
  actingSeat: Seat,
  actionTrickIndex: number,
): SuitReturnSignal | null {
  const leadsBeforeNow = ledger.suitLeadsBySeat[partnerSeat]!.filter((e) => e.trickIndex < actionTrickIndex)
  if (leadsBeforeNow.length === 0) return null

  // Walk from most recent backward, skip suits the acting seat has already returned since that lead.
  for (let i = leadsBeforeNow.length - 1; i >= 0; i--) {
    const candidate = leadsBeforeNow[i]!
    const alreadyReturned = ledger.suitPlaysBySeat[actingSeat]!.some(
      (p) => p.suit === candidate.suit && p.trickIndex > candidate.trickIndex && p.trickIndex < actionTrickIndex,
    )
    if (alreadyReturned) continue

    const repeatCount = leadsBeforeNow.filter((e) => e.suit === candidate.suit).length
    const keyCardCleared = ledger.keyCardClearedTrickBySuit[candidate.suit] !== undefined
      && ledger.keyCardClearedTrickBySuit[candidate.suit]! < actionTrickIndex

    let confidence = 0.5
    if (candidate.isHigh) confidence += 0.2
    if (candidate.isLow) confidence -= 0.1
    confidence += Math.min(0.3, (repeatCount - 1) * 0.15)
    if (keyCardCleared) confidence += 0.1
    const decay = Math.pow(0.9, Math.max(0, actionTrickIndex - candidate.trickIndex - 1))
    confidence = clamp01(confidence * decay)

    return { suit: candidate.suit, signalTrickIndex: candidate.trickIndex, isHigh: candidate.isHigh, isLow: candidate.isLow, repeatCount, keyCardCleared, confidence }
  }
  return null
}

type TrumpDrawSignal = { signalTrickIndex: number; confidence: number }

function detectPartnerTrumpDrawSignal(ledger: DealLedger, partnerSeat: Seat, actionTrickIndex: number): TrumpDrawSignal | null {
  const leadsBeforeNow = ledger.trumpLeadTricksBySeat[partnerSeat]!.filter((t) => t < actionTrickIndex)
  if (leadsBeforeNow.length === 0) return null
  const last = leadsBeforeNow[leadsBeforeNow.length - 1]!
  const decay = Math.pow(0.9, Math.max(0, actionTrickIndex - last - 1))
  return { signalTrickIndex: last, confidence: clamp01(0.6 * decay) }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

type SuitReturnOutcome = {
  gameMode: string
  signal: SuitReturnSignal
  hasLegalCardInSignaledSuit: boolean
  humanReturnedSuit: boolean
  opponentCurrentlyWinningHighPoints: boolean
  chosePreservedCleanWinnerElsewhere: boolean
  example: {
    gameMode: string
    trumpSuit: string | null
    signaledSuit: string
    signalConfidence: number
    isHigh: boolean
    repeatCount: number
    keyCardCleared: boolean
    chosenSuit: string
    returned: boolean
    guardConflict: boolean
  }
}

type TrumpDrawOutcome = {
  gameMode: string
  signal: TrumpDrawSignal
  continuedDraw: boolean
}

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  Partner Signal Memory — offline анализ (локален, read-only)')
  console.log('─────────────────────────────────────────')

  const args = process.argv.slice(2)
  const archiveArg = args.find((a) => !a.startsWith('-'))
  const archivePath = archiveArg ? resolve(process.cwd(), archiveArg) : join(REPO_ROOT, DEFAULT_ARCHIVE_NAME)

  console.log(`Архив: ${archivePath}`)
  console.log(`Card decisions: ${CARD_DECISIONS_PATH}`)

  let cardDecisionsContent: string
  try {
    cardDecisionsContent = await readFile(CARD_DECISIONS_PATH, 'utf8')
  } catch {
    console.error(`FATAL: липсва ${CARD_DECISIONS_PATH}`)
    console.error('Изпълни първо: npm run build:training-dataset')
    process.exit(2)
    return
  }

  console.log('Валидирам card-decisions.jsonl...')
  const parsedCardDecisions = parseJsonlStrict<Partial<CardRecordV2>>(cardDecisionsContent, 'card-decisions.jsonl')
  const schemaErrors: string[] = [...parsedCardDecisions.errors]
  for (const { record, lineNumber } of parsedCardDecisions.lines) {
    schemaErrors.push(...validateCardRecordV2(record, `card-decisions.jsonl:${lineNumber}`))
  }
  if (schemaErrors.length > 0) {
    console.error(`\n✗ Открити ${schemaErrors.length} schema грешки — анализ СПРЯН.\n`)
    for (const e of schemaErrors.slice(0, 200)) console.error(`  ${e}`)
    process.exit(1)
    return
  }

  console.log('Privacy/sanitization сканиране на card-decisions.jsonl...')
  const inputViolations = await scanAllForbiddenContent(CARD_DECISIONS_PATH)
  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в input-а — анализ СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  const cardDecisionsByKey = new Map<string, CardRecordV2>()
  for (const { record } of parsedCardDecisions.lines) {
    const r = record as CardRecordV2
    cardDecisionsByKey.set(`${r.recordingId}|${r.dealIndex}|${r.sequence}`, r)
  }
  console.log(`Заредени ${cardDecisionsByKey.size} card decision records.`)

  let jsonlFiles: Awaited<ReturnType<typeof readJsonlFilesFromTarGz>>
  try {
    jsonlFiles = await readJsonlFilesFromTarGz(archivePath)
  } catch (e) {
    console.error(`FATAL: не мога да прочета архива: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
    return
  }
  console.log(`Намерени ${jsonlFiles.length} .jsonl файла в архива.`)

  console.log('Реконструирам deal-level trick history и партньорски сигнали...')

  const suitReturnOutcomes: SuitReturnOutcome[] = []
  const trumpDrawOutcomes: TrumpDrawOutcome[] = []
  let dealsProcessed = 0
  let missingJoinCount = 0
  let parseErrorCount = 0

  for (const file of jsonlFiles) {
    const lines = file.content.split('\n')
    for (const rawLine of lines) {
      const trimmed = rawLine.trim()
      if (!trimmed) continue

      let parsed: AnyTrainingRecord
      try {
        parsed = JSON.parse(trimmed) as AnyTrainingRecord
      } catch {
        parseErrorCount++
        continue
      }
      if (!parsed.completed || parsed.recordKind !== 'full') continue

      const deal = parsed as TrainingDealRecord
      if (!deal.finalContract || deal.tricks.length === 0) continue
      dealsProcessed++

      const ledger = buildDealLedger(deal)
      const gameMode = deal.finalContract.contract
      const trumpSuit = deal.finalContract.trumpSuit

      for (const action of deal.cardActions) {
        if (action.actorKind !== 'human_manual') continue
        if (action.trickIndex < 1) continue // no cross-trick history possible yet

        const key = `${deal.recordingId}|${deal.dealIndex}|${action.sequence}`
        const row = cardDecisionsByKey.get(key)
        if (!row) {
          missingJoinCount++
          continue
        }
        if (row.legalCards.length <= 1) continue // forced — no real choice

        const seat = action.seat
        const partnerSeat = getPartnerSeat(seat)

        // ── Suit-return signal ──
        const suitSignal = detectPartnerSuitSignal(ledger, partnerSeat, seat, action.trickIndex)
        if (suitSignal) {
          const legalSuits = new Set(row.legalCards.map((c) => c.suit))
          const hasLegalCardInSignaledSuit = legalSuits.has(suitSignal.suit)
          const humanReturnedSuit = row.chosenCard.suit === suitSignal.suit
          const opponentCurrentlyWinningHighPoints = row.memory.opponentCurrentlyWinning && row.memory.pointsInTrick >= 10
          const chosePreservedCleanWinnerElsewhere = !humanReturnedSuit && row.chosenCardMemoryFeatures.candidateIsCleanWinner

          suitReturnOutcomes.push({
            gameMode,
            signal: suitSignal,
            hasLegalCardInSignaledSuit,
            humanReturnedSuit,
            opponentCurrentlyWinningHighPoints,
            chosePreservedCleanWinnerElsewhere,
            example: {
              gameMode,
              trumpSuit,
              signaledSuit: suitSignal.suit,
              signalConfidence: Number(suitSignal.confidence.toFixed(2)),
              isHigh: suitSignal.isHigh,
              repeatCount: suitSignal.repeatCount,
              keyCardCleared: suitSignal.keyCardCleared,
              chosenSuit: row.chosenCard.suit,
              returned: humanReturnedSuit,
              guardConflict: opponentCurrentlyWinningHighPoints || chosePreservedCleanWinnerElsewhere,
            },
          })
        }

        // ── Trump-draw signal (only meaningful on lead decisions, suit contract) ──
        if (gameMode === 'suit' && row.positionInTrick === 0) {
          const trumpSignal = detectPartnerTrumpDrawSignal(ledger, partnerSeat, action.trickIndex)
          if (trumpSignal) {
            const hasTrumpLegal = trumpSuit !== null && row.legalCards.some((c) => c.suit === trumpSuit)
            if (hasTrumpLegal) {
              trumpDrawOutcomes.push({
                gameMode,
                signal: trumpSignal,
                continuedDraw: row.chosenCard.suit === trumpSuit,
              })
            }
          }
        }
      }
    }
  }

  console.log(`Обработени ${dealsProcessed} deals (recordKind='full'), ${parseErrorCount} parse грешки, ${missingJoinCount} missing joins (пропуснати).`)
  console.log(`Suit-return сигнал ситуации: ${suitReturnOutcomes.length}, trump-draw сигнал ситуации: ${trumpDrawOutcomes.length}.`)

  // ─── Aggregate: suit-return signal ──────────────────────────────────────────
  const eligible = suitReturnOutcomes.filter((o) => o.hasLegalCardInSignaledSuit)
  const returnedCount = eligible.filter((o) => o.humanReturnedSuit).length
  const notReturnedCount = eligible.length - returnedCount
  const notReturnedWithGuardConflict = eligible.filter((o) => !o.humanReturnedSuit && (o.opponentCurrentlyWinningHighPoints || o.chosePreservedCleanWinnerElsewhere)).length
  const notReturnedNoGuardConflict = notReturnedCount - notReturnedWithGuardConflict

  function byGameMode(outcomes: SuitReturnOutcome[]) {
    const modes = ['suit', 'all-trumps', 'no-trumps']
    const result: Record<string, { total: number; returned: number; returnRate: string }> = {}
    for (const mode of modes) {
      const subset = outcomes.filter((o) => o.gameMode === mode)
      const ret = subset.filter((o) => o.humanReturnedSuit).length
      result[mode] = { total: subset.length, returned: ret, returnRate: pct(ret, subset.length) }
    }
    return result
  }

  function byConfidenceBucket(outcomes: SuitReturnOutcome[]) {
    const buckets = [
      { label: '0.0-0.3 (weak)', min: 0, max: 0.3 },
      { label: '0.3-0.6 (medium)', min: 0.3, max: 0.6 },
      { label: '0.6-1.0 (strong)', min: 0.6, max: 1.01 },
    ]
    const result: Record<string, { total: number; returned: number; returnRate: string }> = {}
    for (const b of buckets) {
      const subset = outcomes.filter((o) => o.signal.confidence >= b.min && o.signal.confidence < b.max)
      const ret = subset.filter((o) => o.humanReturnedSuit).length
      result[b.label] = { total: subset.length, returned: ret, returnRate: pct(ret, subset.length) }
    }
    return result
  }

  const highCardSubset = eligible.filter((o) => o.signal.isHigh)
  const lowCardSubset = eligible.filter((o) => o.signal.isLow)
  const repeatedSubset = eligible.filter((o) => o.signal.repeatCount > 1)
  const keyCardClearedSubset = eligible.filter((o) => o.signal.keyCardCleared)
  const guardConflictSubset = eligible.filter((o) => o.opponentCurrentlyWinningHighPoints || o.chosePreservedCleanWinnerElsewhere)
  const noGuardConflictSubset = eligible.filter((o) => !(o.opponentCurrentlyWinningHighPoints || o.chosePreservedCleanWinnerElsewhere))

  function rate(subset: SuitReturnOutcome[]) {
    const ret = subset.filter((o) => o.humanReturnedSuit).length
    return { total: subset.length, returned: ret, returnRate: pct(ret, subset.length) }
  }

  // ─── Aggregate: trump-draw signal ───────────────────────────────────────────
  const trumpContinued = trumpDrawOutcomes.filter((o) => o.continuedDraw).length

  // ─── Representative examples (privacy-safe) ─────────────────────────────────
  const representativeReturned = eligible.filter((o) => o.humanReturnedSuit).slice(0, 6).map((o) => o.example)
  const representativeNotReturnedGuard = eligible.filter((o) => !o.humanReturnedSuit && (o.opponentCurrentlyWinningHighPoints || o.chosePreservedCleanWinnerElsewhere)).slice(0, 6).map((o) => o.example)
  const representativeNotReturnedNoGuard = eligible.filter((o) => !o.humanReturnedSuit && !(o.opponentCurrentlyWinningHighPoints || o.chosePreservedCleanWinnerElsewhere)).slice(0, 6).map((o) => o.example)

  const reportJson = {
    generatedAt: new Date().toISOString(),
    inputFiles: { archivePath, cardDecisionsPath: CARD_DECISIONS_PATH },
    privacyValidation: { status: 'PASS', violationCount: 0 },
    dealsProcessed,
    missingJoinCount,
    parseErrorCount,
    suitReturnSignal: {
      totalSignalSituations: suitReturnOutcomes.length,
      eligibleSituations: eligible.length,
      note: 'eligibleSituations = ситуации, където seat-ът реално държи легална карта от сигнализираната боя (реален избор за връщане/невръщане).',
      returnedCount,
      notReturnedCount,
      returnRateOverall: pct(returnedCount, eligible.length),
      notReturnedWithGuardConflict,
      notReturnedNoGuardConflict,
      byGameMode: byGameMode(eligible),
      byConfidenceBucket: byConfidenceBucket(eligible),
      highCardSignal: rate(highCardSubset),
      lowCardSignal: rate(lowCardSubset),
      repeatedSuitSignal: rate(repeatedSubset),
      keyCardClearedSignal: rate(keyCardClearedSubset),
      guardConflictPresent: rate(guardConflictSubset),
      guardConflictAbsent: rate(noGuardConflictSubset),
    },
    trumpDrawSignal: {
      totalSituations: trumpDrawOutcomes.length,
      continuedDrawCount: trumpContinued,
      continuedDrawRate: pct(trumpContinued, trumpDrawOutcomes.length),
    },
    representativeExamples: {
      returnedSuit: representativeReturned,
      notReturnedWithGuardConflict: representativeNotReturnedGuard,
      notReturnedNoGuardConflict: representativeNotReturnedNoGuard,
    },
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(REPORT_JSON_PATH, JSON.stringify(reportJson, null, 2) + '\n', 'utf8')
  await writeFile(REPORT_MD_PATH, renderMarkdown(reportJson), 'utf8')

  console.log('Privacy/sanitization сканиране на generated files...')
  const outputViolations = [
    ...(await scanAllForbiddenContent(REPORT_JSON_PATH)),
    ...(await scanAllForbiddenContent(REPORT_MD_PATH)),
  ]
  if (outputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в generated files:\n`)
    for (const v of outputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  console.log('\n─────────────────────────────────────────')
  console.log('  Резултат')
  console.log('─────────────────────────────────────────')
  console.log(`  Suit-return сигнали (eligible): ${eligible.length}, върнати: ${returnedCount} (${pct(returnedCount, eligible.length)}), НЕ върнати: ${notReturnedCount}`)
  console.log(`  От невърнатите — с guard conflict: ${notReturnedWithGuardConflict}, без guard conflict (шум?): ${notReturnedNoGuardConflict}`)
  console.log(`  High-card partner lead → return rate: ${rate(highCardSubset).returnRate} (n=${highCardSubset.length})`)
  console.log(`  Repeated-suit partner lead → return rate: ${rate(repeatedSubset).returnRate} (n=${repeatedSubset.length})`)
  console.log(`  Trump-draw continuation rate: ${reportJson.trumpDrawSignal.continuedDrawRate} (n=${trumpDrawOutcomes.length})`)
  console.log(`\n✓ Отчет: ${REPORT_MD_PATH}`)
  console.log(`✓ Отчет: ${REPORT_JSON_PATH}`)
  console.log('✓ Partner signal memory анализ завършен успешно.\n')
  process.exit(0)
}

function renderMarkdown(report: any): string {
  const lines: string[] = []
  lines.push('# Partner Signal Memory — Offline Analysis Report')
  lines.push('')
  lines.push(`Генериран на: ${report.generatedAt}`)
  lines.push('')
  lines.push(
    '**Local-only, offline, read-only.** Проверява дали реалните човешки card decisions потвърждават ' +
    'partner-signal конвенциите, които conventional bot-ът вече предполага (виж conventional-bot-logic-report.md). ' +
    'НЕ имплементира runtime Signal Memory — само анализ за бъдещ дизайн.',
  )
  lines.push('')
  lines.push(`Deals processed: ${report.dealsProcessed}, missing joins: ${report.missingJoinCount}, parse errors: ${report.parseErrorCount}`)
  lines.push('')

  const s = report.suitReturnSignal
  lines.push('## Suit-return signal ("partner led suit X → връща ли се X?")')
  lines.push('')
  lines.push(`- Общо потенциални ситуации (сигнал открит): ${s.totalSignalSituations}`)
  lines.push(`- Eligible ситуации (seat-ът реално държи легална карта от сигнализираната боя): ${s.eligibleSituations}`)
  lines.push(`- Върнати: ${s.returnedCount} (${s.returnRateOverall})`)
  lines.push(`- НЕ върнати: ${s.notReturnedCount}`)
  lines.push(`  - с tactical guard conflict (opponent печели с 10+ точки, ИЛИ избран clean winner в друга боя): ${s.notReturnedWithGuardConflict}`)
  lines.push(`  - БЕЗ guard conflict (потенциален шум/друга причина): ${s.notReturnedNoGuardConflict}`)
  lines.push('')
  lines.push('### По gameMode')
  for (const [mode, v] of Object.entries(s.byGameMode) as Array<[string, any]>) {
    lines.push(`- ${mode}: ${v.total} ситуации, ${v.returned} върнати (${v.returnRate})`)
  }
  lines.push('')
  lines.push('### По confidence bucket')
  for (const [bucket, v] of Object.entries(s.byConfidenceBucket) as Array<[string, any]>) {
    lines.push(`- ${bucket}: ${v.total} ситуации, ${v.returned} върнати (${v.returnRate})`)
  }
  lines.push('')
  lines.push('### По тип сигнал')
  lines.push(`- High-card partner lead: ${s.highCardSignal.total} ситуации, return rate ${s.highCardSignal.returnRate}`)
  lines.push(`- Low-card partner lead: ${s.lowCardSignal.total} ситуации, return rate ${s.lowCardSignal.returnRate}`)
  lines.push(`- Repeated-suit lead (partner водил тази боя 2+ пъти): ${s.repeatedSuitSignal.total} ситуации, return rate ${s.repeatedSuitSignal.returnRate}`)
  lines.push(`- Key-card cleared (топ картата на боята вече е излязла): ${s.keyCardClearedSignal.total} ситуации, return rate ${s.keyCardClearedSignal.returnRate}`)
  lines.push(`- Guard conflict present: ${s.guardConflictPresent.total} ситуации, return rate ${s.guardConflictPresent.returnRate}`)
  lines.push(`- Guard conflict absent: ${s.guardConflictAbsent.total} ситуации, return rate ${s.guardConflictAbsent.returnRate}`)
  lines.push('')

  const t = report.trumpDrawSignal
  lines.push('## Trump-draw continuation signal ("partner е водил коз по-рано → продължава ли играчът?")')
  lines.push('')
  lines.push(`- Ситуации (leader, притежава коз, партньорът е водил коз по-рано в раздаването): ${t.totalSituations}`)
  lines.push(`- Продължил тегленето (изиграл коз): ${t.continuedDrawCount} (${t.continuedDrawRate})`)
  lines.push('')

  lines.push('## Representative examples (privacy-safe, без roomKey/playerKey/recordingId)')
  lines.push('')
  lines.push('### Върнати боята')
  for (const ex of report.representativeExamples.returnedSuit) {
    lines.push(`- gameMode=${ex.gameMode}, trumpSuit=${ex.trumpSuit}, signaledSuit=${ex.signaledSuit} (conf=${ex.signalConfidence}, high=${ex.isHigh}, repeat=${ex.repeatCount}, keyCardCleared=${ex.keyCardCleared}) → избрана боя=${ex.chosenSuit} ✓ returned`)
  }
  lines.push('')
  lines.push('### НЕ върнати, с guard conflict (обяснимо)')
  for (const ex of report.representativeExamples.notReturnedWithGuardConflict) {
    lines.push(`- gameMode=${ex.gameMode}, trumpSuit=${ex.trumpSuit}, signaledSuit=${ex.signaledSuit} (conf=${ex.signalConfidence}) → избрана боя=${ex.chosenSuit}, guardConflict=true`)
  }
  lines.push('')
  lines.push('### НЕ върнати, БЕЗ guard conflict (шум или друга неописана причина)')
  for (const ex of report.representativeExamples.notReturnedNoGuardConflict) {
    lines.push(`- gameMode=${ex.gameMode}, trumpSuit=${ex.trumpSuit}, signaledSuit=${ex.signaledSuit} (conf=${ex.signalConfidence}) → избрана боя=${ex.chosenSuit}, guardConflict=false`)
  }
  lines.push('')

  lines.push('## Заключение — кои сигнали изглеждат надеждни vs шумни')
  lines.push('')
  lines.push(
    'Виж финалния report (партньорски) за интерпретация — sравни return rate по confidence bucket/тип сигнал: ' +
    'ако high-card/repeated-suit сигналите показват ЗНАЧИТЕЛНО по-висок return rate от low-card/single-lead, ' +
    'това потвърждава bot-овата съществуваща конвенция и е кандидат за бъдещ confidence-based advisor rule. ' +
    'Ако guard-conflict-absent случаите ВСЕ ПАК показват нисък return rate, сигналът вероятно е noisy/твърде слаб ' +
    'да се третира като силна препоръка сам по себе си.',
  )
  lines.push('')

  return lines.join('\n')
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(2)
})
