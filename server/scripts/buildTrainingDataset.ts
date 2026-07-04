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
  }
}

function bumpActorKind(counts: ActorKindCounts, kind: TrainingActorKind): void {
  counts[kind] = (counts[kind] ?? 0) + 1
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
}

type BiddingDecisionRecord = {
  recordingId: string
  roomKey: string
  dealIndex: number
  sequence: number
  seat: string
  playerKey: string | null
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

        const record: BiddingDecisionRecord = {
          recordingId: deal.recordingId,
          roomKey: deal.roomKey,
          dealIndex: deal.dealIndex,
          sequence: action.sequence,
          seat: action.seat,
          playerKey: deal.seats[action.seat]?.playerKey ?? null,
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
            file: file.archivePath,
            line: i + 1,
            message: `chosenCard "${action.chosenCard.id}" не е в legalCards (recordingId=${deal.recordingId}, sequence=${action.sequence})`,
          })
          continue
        }
        if (!handIds.has(action.chosenCard.id)) {
          criticalErrors.push({
            kind: 'validation',
            file: file.archivePath,
            line: i + 1,
            message: `chosenCard "${action.chosenCard.id}" не е в ownHand (recordingId=${deal.recordingId}, sequence=${action.sequence})`,
          })
          continue
        }

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
        }
        cardDecisionLines.push(JSON.stringify(record))
        stats.exportedCardDecisions++
      }
    }
  }

  const parseErrorCount = criticalErrors.filter((e) => e.kind === 'parse').length
  const validationErrorCount = criticalErrors.filter((e) => e.kind === 'validation').length

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
  sanitizationViolations: SanitizationViolation[]
  criticalErrors: CriticalError[]
}

async function writeSummary(input: SummaryInput): Promise<void> {
  const { status, archivePath, stats, parseErrorCount, validationErrorCount, sanitizationViolations, criticalErrors } = input

  const ignoredBiddingActorKinds = { ...stats.biddingActorKindCounts }
  const ignoredCardActorKinds = { ...stats.cardActorKindCounts }
  delete ignoredBiddingActorKinds.human_manual
  delete ignoredCardActorKinds.human_manual

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
    sanitizationViolationCount: sanitizationViolations.length,
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
  sanitizationViolationCount: number
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
  lines.push(`- Validation errors (chosenCard не в legalCards/ownHand): ${s.validationErrorCount}`)
  lines.push(`- Sanitization violations: ${s.sanitizationViolationCount}`)
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
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
