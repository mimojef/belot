/**
 * reviewTrainingDataset.ts
 *
 * Read-only локален quality review на вече генерирания training dataset
 * (training-output/card-decisions.jsonl, bidding-decisions.jsonl). Не чете
 * .tar.gz архива и не пипа dataset builder-а — само анализира какво вече е
 * export-нато и пише отчет обратно в training-output/.
 *
 * Usage:
 *   npm run review:training-dataset   (от server/)
 *
 * Exit codes:
 *   0 — отчетът е генериран (dataset quality проблемите се виждат В отчета,
 *       не спират процеса — това е review tool, не gate)
 *   1 — privacy/sanitization нарушение в generated output
 *   2 — dataset файловете липсват /不 могат да се прочетат
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanFileForForbiddenContent, type SanitizationViolation } from './trainingDataset/sanitizeOutput.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')

const CARD_DECISIONS_PATH = join(OUTPUT_DIR, 'card-decisions.jsonl')
const BIDDING_DECISIONS_PATH = join(OUTPUT_DIR, 'bidding-decisions.jsonl')
const SUMMARY_JSON_PATH = join(OUTPUT_DIR, 'summary.json')
const REPORT_MD_PATH = join(OUTPUT_DIR, 'dataset-quality-report.md')
const REPORT_JSON_PATH = join(OUTPUT_DIR, 'dataset-quality-report.json')

// ─── Shared helpers ───────────────────────────────────────────────────────────

type Seat = 'bottom' | 'right' | 'top' | 'left'
type Team = 'A' | 'B'

// Канонично правило от server/src/game/createInitialAuthoritativeGameState.ts:
// bottom/top → team A, right/left → team B. Извеждаме team само за отчета —
// не се пише обратно в dataset-а.
function deriveTeam(seat: Seat): Team {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}

function sortEntriesDesc(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
}

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0
  const mid = Math.floor(sortedAsc.length / 2)
  return sortedAsc.length % 2 === 0 ? (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2 : sortedAsc[mid]!
}

function distributionStats(counts: Map<string, number>): {
  uniqueKeys: number
  min: number
  max: number
  median: number
  top10: Array<{ key: string; count: number }>
} {
  const values = [...counts.values()]
  const sortedAsc = [...values].sort((a, b) => a - b)
  const top10 = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, count]) => ({ key, count }))

  return {
    uniqueKeys: counts.size,
    min: values.length > 0 ? Math.min(...values) : 0,
    max: values.length > 0 ? Math.max(...values) : 0,
    median: median(sortedAsc),
    top10,
  }
}

function numericStats(values: number[]): { count: number; min: number; max: number; median: number } {
  if (values.length === 0) return { count: 0, min: 0, max: 0, median: 0 }
  const sortedAsc = [...values].sort((a, b) => a - b)
  return {
    count: values.length,
    min: sortedAsc[0]!,
    max: sortedAsc[sortedAsc.length - 1]!,
    median: median(sortedAsc),
  }
}

// Същата ServerCard shape проверка като в buildTrainingDataset.ts
// (id/suit/rank непразни низове) — независима повторна проверка тук.
function isValidCompactCard(card: unknown): card is CompactCard {
  if (typeof card !== 'object' || card === null) return false
  const c = card as Record<string, unknown>
  return (
    typeof c.id === 'string' && c.id.length > 0 &&
    typeof c.suit === 'string' && c.suit.length > 0 &&
    typeof c.rank === 'string' && c.rank.length > 0
  )
}

// Кратка (не-обратимо разкриваема) etикетка за playerKey/roomKey в отчета —
// показваме само първите 10 hex символа от вече псевдонимизирания HMAC ключ,
// колкото да се различават записите в top10 списъка. Пълният ключ никога не
// се записва в отчета.
function shortKeyLabel(key: string): string {
  return key.length > 10 ? `${key.slice(0, 10)}…` : key
}

// ─── Line-level parsing ───────────────────────────────────────────────────────

type LineParseResult<T> =
  | { ok: true; lineNumber: number; raw: string; record: T }
  | { ok: false; lineNumber: number; raw: string; error: string }

function parseJsonlLines<T>(content: string): { blankLines: number; results: LineParseResult<T>[] } {
  const lines = content.split('\n')
  const results: LineParseResult<T>[] = []
  let blankLines = 0

  lines.forEach((rawLine, idx) => {
    const trimmed = rawLine.trim()
    if (!trimmed) {
      blankLines++
      return
    }
    try {
      const record = JSON.parse(trimmed) as T
      results.push({ ok: true, lineNumber: idx + 1, raw: trimmed, record })
    } catch (e) {
      results.push({ ok: false, lineNumber: idx + 1, raw: trimmed, error: e instanceof Error ? e.message : String(e) })
    }
  })

  return { blankLines, results }
}

function findExactDuplicates(rawLines: string[]): { duplicateGroups: number; duplicateRows: number; topGroups: Array<{ count: number; sample: string }> } {
  const counts = new Map<string, number>()
  for (const line of rawLines) counts.set(line, (counts.get(line) ?? 0) + 1)

  let duplicateGroups = 0
  let duplicateRows = 0
  const groupsOverOne: Array<{ count: number; sample: string }> = []

  for (const [line, count] of counts) {
    if (count > 1) {
      duplicateGroups++
      duplicateRows += count - 1 // "extra" rows beyond the first occurrence
      groupsOverOne.push({ count, sample: line.slice(0, 160) })
    }
  }

  groupsOverOne.sort((a, b) => b.count - a.count)
  return { duplicateGroups, duplicateRows, topGroups: groupsOverOne.slice(0, 5) }
}

// ─── Card/bidding compact types (as actually written by buildTrainingDataset.ts) ─

type CompactCard = { id: string; suit: string; rank: string }
type CompactBidAction = { type: string; suit?: string }

type CardDecisionRecord = {
  recordingId?: unknown
  roomKey?: unknown
  dealIndex?: unknown
  sequence?: unknown
  trickIndex?: unknown
  positionInTrick?: unknown
  seat?: Seat
  playerKey?: string | null
  ownHand?: CompactCard[]
  legalCards?: CompactCard[]
  chosenCard?: CompactCard
  contract?: { bidderSeat?: string; contract?: string; trumpSuit?: string | null; doubled?: boolean; redoubled?: boolean }
  playedCardCountBeforeAction?: unknown
  currentTrick?: unknown[]
  currentWinningSeat?: unknown
  currentWinningCard?: unknown
  dealerSeat?: unknown
  leaderSeat?: unknown
  scoreBeforeDeal?: { team0?: unknown; team1?: unknown }
}

type BiddingDecisionRecord = {
  recordingId?: unknown
  roomKey?: unknown
  dealIndex?: unknown
  sequence?: unknown
  seat?: Seat
  playerKey?: string | null
  ownHand?: CompactCard[]
  dealerSeat?: unknown
  scoreBeforeDeal?: { team0?: unknown; team1?: unknown }
  previousBids?: CompactBidAction[]
  legalActions?: CompactBidAction[]
  chosenAction?: CompactBidAction
}

const CARD_REQUIRED_FIELDS: Array<keyof CardDecisionRecord> = [
  'recordingId', 'roomKey', 'dealIndex', 'sequence', 'trickIndex', 'positionInTrick',
  'seat', 'playerKey', 'ownHand', 'legalCards', 'chosenCard', 'contract',
  'playedCardCountBeforeAction', 'currentTrick', 'dealerSeat', 'leaderSeat', 'scoreBeforeDeal',
]

const BIDDING_REQUIRED_FIELDS: Array<keyof BiddingDecisionRecord> = [
  'recordingId', 'roomKey', 'dealIndex', 'sequence', 'seat', 'playerKey', 'ownHand',
  'dealerSeat', 'scoreBeforeDeal', 'previousBids', 'legalActions', 'chosenAction',
]

function findMissingFields<T extends object>(record: T, requiredFields: Array<keyof T>): string[] {
  const missing: string[] = []
  for (const field of requiredFields) {
    const value = record[field]
    if (value === undefined || value === null) missing.push(String(field))
  }
  return missing
}

function bidActionLabel(a: CompactBidAction | undefined): string {
  if (!a) return 'unknown'
  return a.type === 'suit' ? `suit-${a.suit}` : a.type
}

// ─── Bidding dataset analysis ────────────────────────────────────────────────

type BiddingAnalysis = {
  totalLines: number
  blankLines: number
  parseErrors: Array<{ line: number; error: string }>
  actionTypeCounts: Record<string, number>
  suitCounts: Record<string, number>
  seatCounts: Record<string, number>
  teamCounts: Record<string, number>
  nullPlayerKeyCount: number
  missingFieldCounts: Record<string, number>
  playerKeyStats: ReturnType<typeof distributionStats>
  roomKeyStats: ReturnType<typeof distributionStats>
  duplicates: ReturnType<typeof findExactDuplicates>
  contextStats: {
    totalContexts: number
    repeatedContexts: number
    conflictingContexts: number
    conflictingRows: number
    topRepeated: Array<{ count: number; distinctChoices: number; choiceCounts: Record<string, number> }>
  }
  ownHandFieldPresent: boolean
  ownHandStats: ReturnType<typeof numericStats>
  missingOwnHandCount: number
  emptyOwnHandCount: number
  invalidOwnHandCount: number
}

function analyzeBidding(content: string): BiddingAnalysis {
  const { blankLines, results } = parseJsonlLines<BiddingDecisionRecord>(content)

  const actionTypeCounts: Record<string, number> = {}
  const suitCounts: Record<string, number> = {}
  const seatCounts: Record<string, number> = {}
  const teamCounts: Record<string, number> = {}
  const missingFieldCounts: Record<string, number> = {}
  const playerKeyCounts = new Map<string, number>()
  const roomKeyCounts = new Map<string, number>()
  const contextMap = new Map<string, Map<string, number>>() // contextKey -> (choiceLabel -> count)
  const parseErrors: Array<{ line: number; error: string }> = []
  const rawLines: string[] = []
  const ownHandLengths: number[] = []
  let nullPlayerKeyCount = 0
  let ownHandFieldSeen = false
  let missingOwnHandCount = 0
  let emptyOwnHandCount = 0
  let invalidOwnHandCount = 0

  for (const result of results) {
    rawLines.push(result.raw)
    if (!result.ok) {
      parseErrors.push({ line: result.lineNumber, error: result.error })
      continue
    }
    const record = result.record
    if ('ownHand' in record) ownHandFieldSeen = true

    for (const field of findMissingFields(record, BIDDING_REQUIRED_FIELDS)) bump(missingFieldCounts, field)

    if (record.ownHand === undefined || record.ownHand === null) {
      missingOwnHandCount++
    } else if (!Array.isArray(record.ownHand) || record.ownHand.length === 0) {
      emptyOwnHandCount++
    } else if (!record.ownHand.every(isValidCompactCard)) {
      invalidOwnHandCount++
    } else {
      ownHandLengths.push(record.ownHand.length)
    }

    if (record.playerKey === null) nullPlayerKeyCount++
    if (typeof record.playerKey === 'string') playerKeyCounts.set(record.playerKey, (playerKeyCounts.get(record.playerKey) ?? 0) + 1)
    if (typeof record.roomKey === 'string') roomKeyCounts.set(record.roomKey, (roomKeyCounts.get(record.roomKey) ?? 0) + 1)

    const seat = record.seat
    if (seat) {
      bump(seatCounts, seat)
      bump(teamCounts, deriveTeam(seat))
    }

    const choiceLabel = bidActionLabel(record.chosenAction)
    bump(actionTypeCounts, record.chosenAction?.type ?? 'unknown')
    if (record.chosenAction?.type === 'suit') bump(suitCounts, record.chosenAction.suit ?? 'unknown')

    const contextKey = JSON.stringify({
      seat: record.seat,
      ownHand: [...(record.ownHand ?? [])].map((c) => c.id).sort(),
      dealerSeat: record.dealerSeat,
      scoreBeforeDeal: record.scoreBeforeDeal,
      previousBids: record.previousBids,
      legalActions: record.legalActions,
    })
    let choiceCounts = contextMap.get(contextKey)
    if (!choiceCounts) {
      choiceCounts = new Map<string, number>()
      contextMap.set(contextKey, choiceCounts)
    }
    choiceCounts.set(choiceLabel, (choiceCounts.get(choiceLabel) ?? 0) + 1)
  }

  let repeatedContexts = 0
  let conflictingContexts = 0
  let conflictingRows = 0
  const topRepeatedRaw: Array<{ totalCount: number; distinctChoices: number; choiceCounts: Record<string, number> }> = []

  for (const choiceCounts of contextMap.values()) {
    const totalCount = [...choiceCounts.values()].reduce((a, b) => a + b, 0)
    if (totalCount > 1) {
      repeatedContexts++
      if (choiceCounts.size > 1) {
        conflictingContexts++
        conflictingRows += totalCount
      }
      topRepeatedRaw.push({ totalCount, distinctChoices: choiceCounts.size, choiceCounts: Object.fromEntries(choiceCounts) })
    }
  }
  topRepeatedRaw.sort((a, b) => b.totalCount - a.totalCount)

  return {
    totalLines: results.length,
    blankLines,
    parseErrors,
    actionTypeCounts,
    suitCounts,
    seatCounts,
    teamCounts,
    nullPlayerKeyCount,
    missingFieldCounts,
    playerKeyStats: distributionStats(playerKeyCounts),
    roomKeyStats: distributionStats(roomKeyCounts),
    duplicates: findExactDuplicates(rawLines),
    contextStats: {
      totalContexts: contextMap.size,
      repeatedContexts,
      conflictingContexts,
      conflictingRows,
      topRepeated: topRepeatedRaw.slice(0, 10).map((g) => ({ count: g.totalCount, distinctChoices: g.distinctChoices, choiceCounts: g.choiceCounts })),
    },
    ownHandFieldPresent: ownHandFieldSeen,
    ownHandStats: numericStats(ownHandLengths),
    missingOwnHandCount,
    emptyOwnHandCount,
    invalidOwnHandCount,
  }
}

// ─── Card dataset analysis ───────────────────────────────────────────────────

type CardAnalysis = {
  totalLines: number
  blankLines: number
  parseErrors: Array<{ line: number; error: string }>
  contractTypeCounts: Record<string, number>
  trumpSuitCounts: Record<string, number>
  legalCardsLenHistogram: Record<string, number>
  forcedCount: number
  nonForcedCount: number
  positionInTrickCounts: Record<string, number>
  chosenSuitCounts: Record<string, number>
  chosenRankCounts: Record<string, number>
  seatCounts: Record<string, number>
  teamCounts: Record<string, number>
  nullPlayerKeyCount: number
  missingFieldCounts: Record<string, number>
  chosenNotInLegalCount: number
  chosenNotInHandCount: number
  playerKeyStats: ReturnType<typeof distributionStats>
  roomKeyStats: ReturnType<typeof distributionStats>
  duplicates: ReturnType<typeof findExactDuplicates>
  contextStats: {
    totalContexts: number
    repeatedContexts: number
    conflictingContexts: number
    conflictingRows: number
    topRepeated: Array<{ count: number; distinctChoices: number; choiceCounts: Record<string, number> }>
  }
}

function analyzeCards(content: string): CardAnalysis {
  const { blankLines, results } = parseJsonlLines<CardDecisionRecord>(content)

  const contractTypeCounts: Record<string, number> = {}
  const trumpSuitCounts: Record<string, number> = {}
  const legalCardsLenHistogram: Record<string, number> = {}
  const positionInTrickCounts: Record<string, number> = {}
  const chosenSuitCounts: Record<string, number> = {}
  const chosenRankCounts: Record<string, number> = {}
  const seatCounts: Record<string, number> = {}
  const teamCounts: Record<string, number> = {}
  const missingFieldCounts: Record<string, number> = {}
  const playerKeyCounts = new Map<string, number>()
  const roomKeyCounts = new Map<string, number>()
  const contextMap = new Map<string, Map<string, number>>()
  const parseErrors: Array<{ line: number; error: string }> = []
  const rawLines: string[] = []

  let forcedCount = 0
  let nonForcedCount = 0
  let nullPlayerKeyCount = 0
  let chosenNotInLegalCount = 0
  let chosenNotInHandCount = 0

  for (const result of results) {
    rawLines.push(result.raw)
    if (!result.ok) {
      parseErrors.push({ line: result.lineNumber, error: result.error })
      continue
    }
    const record = result.record

    for (const field of findMissingFields(record, CARD_REQUIRED_FIELDS)) bump(missingFieldCounts, field)

    if (record.playerKey === null) nullPlayerKeyCount++
    if (typeof record.playerKey === 'string') playerKeyCounts.set(record.playerKey, (playerKeyCounts.get(record.playerKey) ?? 0) + 1)
    if (typeof record.roomKey === 'string') roomKeyCounts.set(record.roomKey, (roomKeyCounts.get(record.roomKey) ?? 0) + 1)

    const seat = record.seat
    if (seat) {
      bump(seatCounts, seat)
      bump(teamCounts, deriveTeam(seat))
    }

    const contractType = record.contract?.contract ?? 'unknown'
    bump(contractTypeCounts, contractType)
    if (contractType === 'suit') bump(trumpSuitCounts, record.contract?.trumpSuit ?? 'unknown')

    const legalCards = record.legalCards ?? []
    bump(legalCardsLenHistogram, String(legalCards.length))
    if (legalCards.length === 1) forcedCount++
    else if (legalCards.length >= 2) nonForcedCount++

    if (typeof record.positionInTrick === 'number') bump(positionInTrickCounts, String(record.positionInTrick))

    if (record.chosenCard) {
      bump(chosenSuitCounts, record.chosenCard.suit)
      bump(chosenRankCounts, record.chosenCard.rank)
    }

    const legalIds = new Set(legalCards.map((c) => c.id))
    const handIds = new Set((record.ownHand ?? []).map((c) => c.id))
    if (record.chosenCard && !legalIds.has(record.chosenCard.id)) chosenNotInLegalCount++
    if (record.chosenCard && !handIds.has(record.chosenCard.id)) chosenNotInHandCount++

    const contextKey = JSON.stringify({
      seat: record.seat,
      trickIndex: record.trickIndex,
      positionInTrick: record.positionInTrick,
      ownHand: [...(record.ownHand ?? [])].map((c) => c.id).sort(),
      legalCards: [...legalCards].map((c) => c.id).sort(),
      contract: record.contract,
      playedCardCountBeforeAction: record.playedCardCountBeforeAction,
      currentTrick: record.currentTrick,
      currentWinningSeat: record.currentWinningSeat,
      currentWinningCard: record.currentWinningCard,
      dealerSeat: record.dealerSeat,
      leaderSeat: record.leaderSeat,
      scoreBeforeDeal: record.scoreBeforeDeal,
    })
    let choiceCounts = contextMap.get(contextKey)
    if (!choiceCounts) {
      choiceCounts = new Map<string, number>()
      contextMap.set(contextKey, choiceCounts)
    }
    const choiceLabel = record.chosenCard?.id ?? 'unknown'
    choiceCounts.set(choiceLabel, (choiceCounts.get(choiceLabel) ?? 0) + 1)
  }

  let repeatedContexts = 0
  let conflictingContexts = 0
  let conflictingRows = 0
  const topRepeatedRaw: Array<{ totalCount: number; distinctChoices: number; choiceCounts: Record<string, number> }> = []

  for (const choiceCounts of contextMap.values()) {
    const totalCount = [...choiceCounts.values()].reduce((a, b) => a + b, 0)
    if (totalCount > 1) {
      repeatedContexts++
      if (choiceCounts.size > 1) {
        conflictingContexts++
        conflictingRows += totalCount
      }
      topRepeatedRaw.push({ totalCount, distinctChoices: choiceCounts.size, choiceCounts: Object.fromEntries(choiceCounts) })
    }
  }
  topRepeatedRaw.sort((a, b) => b.totalCount - a.totalCount)

  return {
    totalLines: results.length,
    blankLines,
    parseErrors,
    contractTypeCounts,
    trumpSuitCounts,
    legalCardsLenHistogram,
    forcedCount,
    nonForcedCount,
    positionInTrickCounts,
    chosenSuitCounts,
    chosenRankCounts,
    seatCounts,
    teamCounts,
    nullPlayerKeyCount,
    missingFieldCounts,
    chosenNotInLegalCount,
    chosenNotInHandCount,
    playerKeyStats: distributionStats(playerKeyCounts),
    roomKeyStats: distributionStats(roomKeyCounts),
    duplicates: findExactDuplicates(rawLines),
    contextStats: {
      totalContexts: contextMap.size,
      repeatedContexts,
      conflictingContexts,
      conflictingRows,
      topRepeated: topRepeatedRaw.slice(0, 10).map((g) => ({ count: g.totalCount, distinctChoices: g.distinctChoices, choiceCounts: g.choiceCounts })),
    },
  }
}

// ─── Extra privacy markers (session/cookie/authorization — не са в builder-ския scanner) ─

const EXTRA_FORBIDDEN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'session', pattern: /"session[a-z]*"\s*:/i },
  { label: 'cookie', pattern: /"cookie"\s*:/i },
  { label: 'authorization', pattern: /"authorization"\s*:/i },
]

async function scanExtraForbiddenContent(filePath: string): Promise<SanitizationViolation[]> {
  const content = await readFile(filePath, 'utf8')
  const lines = content.split('\n')
  const violations: SanitizationViolation[] = []
  lines.forEach((line, idx) => {
    for (const { label, pattern } of EXTRA_FORBIDDEN_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({ file: filePath, line: idx + 1, pattern: label, snippet: line.slice(0, 200) })
      }
    }
  })
  return violations
}

// ─── Report rendering ─────────────────────────────────────────────────────────

function pct(part: number, total: number): string {
  if (total === 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

function renderTop10(entries: Array<{ key: string; count: number }>, total: number): string[] {
  return entries.map((e, i) => `  ${i + 1}. \`${shortKeyLabel(e.key)}\` — ${e.count} (${pct(e.count, total)})`)
}

function renderCountsTable(counts: Record<string, number>): string[] {
  return sortEntriesDesc(counts).map(([k, v]) => `- ${k}: ${v}`)
}

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  Training Dataset Quality Review (локален, read-only)')
  console.log('─────────────────────────────────────────')

  let cardContent: string
  let biddingContent: string
  let summaryJsonRaw: string | null = null

  try {
    cardContent = await readFile(CARD_DECISIONS_PATH, 'utf8')
    biddingContent = await readFile(BIDDING_DECISIONS_PATH, 'utf8')
  } catch (e) {
    console.error(`FATAL: не мога да прочета dataset файловете от ${OUTPUT_DIR}`)
    console.error(`Изпълни първо: npm run build:training-dataset`)
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(2)
    return
  }

  try {
    summaryJsonRaw = await readFile(SUMMARY_JSON_PATH, 'utf8')
  } catch {
    summaryJsonRaw = null
  }
  const builderSummary = summaryJsonRaw ? (JSON.parse(summaryJsonRaw) as Record<string, unknown>) : null

  console.log('Анализирам bidding-decisions.jsonl...')
  const bidding = analyzeBidding(biddingContent)
  console.log('Анализирам card-decisions.jsonl...')
  const cards = analyzeCards(cardContent)

  const totalSamples = bidding.totalLines + cards.totalLines

  const countsMatchSummary =
    builderSummary !== null &&
    builderSummary['exportedBiddingDecisions'] === bidding.totalLines &&
    builderSummary['exportedCardDecisions'] === cards.totalLines

  // ─── Privacy scan (builder patterns + extra session/cookie/authorization) ──
  console.log('Privacy/sanitization сканиране...')
  const filesToScan = [CARD_DECISIONS_PATH, BIDDING_DECISIONS_PATH, SUMMARY_JSON_PATH]
  const baseViolations: SanitizationViolation[] = []
  const extraViolations: SanitizationViolation[] = []
  for (const f of filesToScan) {
    try {
      baseViolations.push(...(await scanFileForForbiddenContent(f)))
      extraViolations.push(...(await scanExtraForbiddenContent(f)))
    } catch {
      // summary.json/summary.md опционални — липсата им не е privacy проблем
    }
  }
  const allPrivacyViolations = [...baseViolations, ...extraViolations]

  // ─── Forced vs non-forced ───────────────────────────────────────────────────
  const totalCardDecisions = cards.forcedCount + cards.nonForcedCount
  const forcedPct = pct(cards.forcedCount, totalCardDecisions)
  const nonForcedPct = pct(cards.nonForcedCount, totalCardDecisions)

  // ─── Build machine-readable report ──────────────────────────────────────────

  const reportJson = {
    generatedAt: new Date().toISOString(),
    inputFiles: {
      cardDecisions: CARD_DECISIONS_PATH,
      biddingDecisions: BIDDING_DECISIONS_PATH,
    },
    overallSummary: {
      totalBiddingSamples: bidding.totalLines,
      totalCardSamples: cards.totalLines,
      totalSamples,
      countsMatchBuilderSummary: countsMatchSummary,
      builderSummaryExportedBidding: builderSummary?.['exportedBiddingDecisions'] ?? null,
      builderSummaryExportedCard: builderSummary?.['exportedCardDecisions'] ?? null,
      biddingBlankLines: bidding.blankLines,
      cardBlankLines: cards.blankLines,
      biddingParseErrors: bidding.parseErrors.length,
      cardParseErrors: cards.parseErrors.length,
      biddingExactDuplicateGroups: bidding.duplicates.duplicateGroups,
      biddingExactDuplicateRows: bidding.duplicates.duplicateRows,
      cardExactDuplicateGroups: cards.duplicates.duplicateGroups,
      cardExactDuplicateRows: cards.duplicates.duplicateRows,
    },
    biddingQuality: {
      schemaNote: bidding.ownHandFieldPresent
        ? 'ownHand присъства в bidding-decisions.jsonl'
        : 'ВНИМАНИЕ: bidding-decisions.jsonl НЕ съдържа ownHand — моделът не вижда ръката на играча при обявяване.',
      ownHandCoverage: {
        recordsWithValidOwnHand: bidding.ownHandStats.count,
        missingOwnHandCount: bidding.missingOwnHandCount,
        emptyOwnHandCount: bidding.emptyOwnHandCount,
        invalidOwnHandCount: bidding.invalidOwnHandCount,
        ownHandLength: {
          min: bidding.ownHandStats.min,
          max: bidding.ownHandStats.max,
          median: bidding.ownHandStats.median,
        },
      },
      actionTypeCounts: bidding.actionTypeCounts,
      suitCounts: bidding.suitCounts,
      seatCounts: bidding.seatCounts,
      teamCounts: bidding.teamCounts,
      gameModeNote: 'Bidding schema-та няма отделно "game mode"/final-contract поле — само chosenAction.type на всяко решение (виж actionTypeCounts). Финалният контракт не може безопасно да се извлече без join със card dataset по recordingId.',
      uniquePlayerKeys: bidding.playerKeyStats.uniqueKeys,
      uniqueRoomKeys: bidding.roomKeyStats.uniqueKeys,
      nullPlayerKeyCount: bidding.nullPlayerKeyCount,
      missingFieldCounts: bidding.missingFieldCounts,
      playerKeyDistribution: bidding.playerKeyStats,
      roomKeyDistribution: bidding.roomKeyStats,
      contextStats: bidding.contextStats,
    },
    cardQuality: {
      contractTypeCounts: cards.contractTypeCounts,
      trumpSuitCounts: cards.trumpSuitCounts,
      legalCardsLenHistogram: cards.legalCardsLenHistogram,
      positionInTrickCounts: cards.positionInTrickCounts,
      chosenSuitCounts: cards.chosenSuitCounts,
      chosenRankCounts: cards.chosenRankCounts,
      seatCounts: cards.seatCounts,
      teamCounts: cards.teamCounts,
      uniquePlayerKeys: cards.playerKeyStats.uniqueKeys,
      uniqueRoomKeys: cards.roomKeyStats.uniqueKeys,
      nullPlayerKeyCount: cards.nullPlayerKeyCount,
      missingFieldCounts: cards.missingFieldCounts,
      chosenCardNotInLegalCardsCount: cards.chosenNotInLegalCount,
      chosenCardNotInOwnHandCount: cards.chosenNotInHandCount,
      playerKeyDistribution: cards.playerKeyStats,
      roomKeyDistribution: cards.roomKeyStats,
      contextStats: cards.contextStats,
    },
    trivialDecisionAnalysis: {
      forcedDecisions: cards.forcedCount,
      nonForcedDecisions: cards.nonForcedCount,
      forcedPct,
      nonForcedPct,
    },
    privacyReview: {
      status: allPrivacyViolations.length === 0 ? 'PASS' : 'FAIL',
      violationCount: allPrivacyViolations.length,
      violations: allPrivacyViolations.slice(0, 100),
    },
  }

  await writeFile(REPORT_JSON_PATH, JSON.stringify(reportJson, null, 2) + '\n', 'utf8')
  await writeFile(REPORT_MD_PATH, renderMarkdownReport(reportJson, bidding, cards), 'utf8')

  console.log(`\n✓ Отчет записан: ${REPORT_MD_PATH}`)
  console.log(`✓ Отчет записан: ${REPORT_JSON_PATH}`)

  console.log('\n─────────────────────────────────────────')
  console.log('  Кратко резюме')
  console.log('─────────────────────────────────────────')
  console.log(`  Bidding samples: ${bidding.totalLines}   Card samples: ${cards.totalLines}   Общо: ${totalSamples}`)
  console.log(`  Counts match summary.json: ${countsMatchSummary ? 'да' : 'НЕ'}`)
  console.log(`  Forced (1 legal card): ${cards.forcedCount} (${forcedPct})   Non-forced: ${cards.nonForcedCount} (${nonForcedPct})`)
  console.log(`  Privacy review: ${allPrivacyViolations.length === 0 ? 'PASS' : `FAIL (${allPrivacyViolations.length} нарушения)`}`)
  if (!bidding.ownHandFieldPresent) {
    console.log('  ⚠ bidding-decisions.jsonl няма ownHand поле — виж отчета за детайли.')
  }

  if (allPrivacyViolations.length > 0) {
    console.error('\n✗ PRIVACY VIOLATION — виж training-output/dataset-quality-report.md за детайли.')
    process.exit(1)
    return
  }

  process.exit(0)
}

function renderMarkdownReport(
  r: {
    generatedAt: string
    overallSummary: {
      totalBiddingSamples: number
      totalCardSamples: number
      totalSamples: number
      countsMatchBuilderSummary: boolean
      builderSummaryExportedBidding: unknown
      builderSummaryExportedCard: unknown
      biddingBlankLines: number
      cardBlankLines: number
      biddingParseErrors: number
      cardParseErrors: number
      biddingExactDuplicateGroups: number
      biddingExactDuplicateRows: number
      cardExactDuplicateGroups: number
      cardExactDuplicateRows: number
    }
    biddingQuality: {
      schemaNote: string
      ownHandCoverage: {
        recordsWithValidOwnHand: number
        missingOwnHandCount: number
        emptyOwnHandCount: number
        invalidOwnHandCount: number
        ownHandLength: { min: number; max: number; median: number }
      }
      actionTypeCounts: Record<string, number>
      suitCounts: Record<string, number>
      seatCounts: Record<string, number>
      teamCounts: Record<string, number>
      gameModeNote: string
      uniquePlayerKeys: number
      uniqueRoomKeys: number
      nullPlayerKeyCount: number
      missingFieldCounts: Record<string, number>
      playerKeyDistribution: ReturnType<typeof distributionStats>
      roomKeyDistribution: ReturnType<typeof distributionStats>
      contextStats: BiddingAnalysis['contextStats']
    }
    cardQuality: {
      contractTypeCounts: Record<string, number>
      trumpSuitCounts: Record<string, number>
      legalCardsLenHistogram: Record<string, number>
      positionInTrickCounts: Record<string, number>
      chosenSuitCounts: Record<string, number>
      chosenRankCounts: Record<string, number>
      seatCounts: Record<string, number>
      teamCounts: Record<string, number>
      uniquePlayerKeys: number
      uniqueRoomKeys: number
      nullPlayerKeyCount: number
      missingFieldCounts: Record<string, number>
      chosenCardNotInLegalCardsCount: number
      chosenCardNotInOwnHandCount: number
      playerKeyDistribution: ReturnType<typeof distributionStats>
      roomKeyDistribution: ReturnType<typeof distributionStats>
      contextStats: CardAnalysis['contextStats']
    }
    trivialDecisionAnalysis: { forcedDecisions: number; nonForcedDecisions: number; forcedPct: string; nonForcedPct: string }
    privacyReview: { status: string; violationCount: number; violations: SanitizationViolation[] }
  },
  bidding: BiddingAnalysis,
  cards: CardAnalysis,
): string {
  const lines: string[] = []
  lines.push('# Training Dataset Quality Review')
  lines.push('')
  lines.push(`Генериран на: ${r.generatedAt}`)
  lines.push('')
  lines.push('Read-only анализ на вече export-натия dataset (`training-output/*.jsonl`). Не пипа dataset builder-а, recorder-а или .tar.gz архива.')
  lines.push('')

  lines.push('## 1. Общ dataset summary')
  lines.push('')
  lines.push(`- Bidding samples: **${r.overallSummary.totalBiddingSamples}**`)
  lines.push(`- Card samples: **${r.overallSummary.totalCardSamples}**`)
  lines.push(`- Общо samples: **${r.overallSummary.totalSamples}**`)
  lines.push(`- Съвпада ли с \`summary.json\` (exportedBiddingDecisions/exportedCardDecisions): **${r.overallSummary.countsMatchBuilderSummary ? 'ДА' : 'НЕ'}** (summary.json: bidding=${r.overallSummary.builderSummaryExportedBidding}, card=${r.overallSummary.builderSummaryExportedCard})`)
  lines.push(`- Празни редове — bidding: ${r.overallSummary.biddingBlankLines}, card: ${r.overallSummary.cardBlankLines}`)
  lines.push(`- Invalid JSON редове — bidding: ${r.overallSummary.biddingParseErrors}, card: ${r.overallSummary.cardParseErrors}`)
  lines.push(`- Exact duplicate JSONL редове — bidding: ${r.overallSummary.biddingExactDuplicateGroups} групи / ${r.overallSummary.biddingExactDuplicateRows} extra реда`)
  lines.push(`- Exact duplicate JSONL редове — card: ${r.overallSummary.cardExactDuplicateGroups} групи / ${r.overallSummary.cardExactDuplicateRows} extra реда`)
  lines.push('')

  lines.push('## 2. Bidding dataset quality')
  lines.push('')
  lines.push(`**Schema бележка:** ${r.biddingQuality.schemaNote}`)
  lines.push('')
  lines.push('**ownHand coverage (bidding):**')
  lines.push(`- Records с валиден (non-empty, правилна card shape) ownHand: **${r.biddingQuality.ownHandCoverage.recordsWithValidOwnHand}**`)
  lines.push(`- Missing ownHand (undefined/null): ${r.biddingQuality.ownHandCoverage.missingOwnHandCount}`)
  lines.push(`- Empty ownHand (array с 0 елемента / не е array): ${r.biddingQuality.ownHandCoverage.emptyOwnHandCount}`)
  lines.push(`- Invalid ownHand (поне 1 карта с невалидна id/suit/rank форма): ${r.biddingQuality.ownHandCoverage.invalidOwnHandCount}`)
  lines.push(`- ownHand.length — min: ${r.biddingQuality.ownHandCoverage.ownHandLength.min}, max: ${r.biddingQuality.ownHandCoverage.ownHandLength.max}, median: ${r.biddingQuality.ownHandCoverage.ownHandLength.median}`)
  lines.push('')
  lines.push('**Разпределение по action type:**')
  lines.push(...renderCountsTable(r.biddingQuality.actionTypeCounts))
  lines.push('')
  lines.push('**Разпределение по suit (само за chosenAction.type === "suit"):**')
  lines.push(...renderCountsTable(r.biddingQuality.suitCounts))
  lines.push('')
  lines.push(`**Game mode:** ${r.biddingQuality.gameModeNote}`)
  lines.push('')
  lines.push('**Разпределение по seat:**')
  lines.push(...renderCountsTable(r.biddingQuality.seatCounts))
  lines.push('')
  lines.push('**Разпределение по team (derived от seat, bottom/top=A, right/left=B):**')
  lines.push(...renderCountsTable(r.biddingQuality.teamCounts))
  lines.push('')
  lines.push(`- Уникални \`playerKey\`: **${r.biddingQuality.uniquePlayerKeys}**`)
  lines.push(`- Уникални \`roomKey\`: **${r.biddingQuality.uniqueRoomKeys}**`)
  lines.push(`- Записи с \`playerKey === null\` (аномално за human_manual): ${r.biddingQuality.nullPlayerKeyCount}`)
  lines.push('')
  if (Object.keys(r.biddingQuality.missingFieldCounts).length > 0) {
    lines.push('**Missing/null критични полета:**')
    lines.push(...renderCountsTable(r.biddingQuality.missingFieldCounts))
  } else {
    lines.push('**Missing/null критични полета:** няма — всички задължителни полета присъстват във всеки ред.')
  }
  lines.push('')
  lines.push(`**Top repeated bidding contexts** (контекст = seat+sorted ownHand+dealerSeat+scoreBeforeDeal+previousBids+legalActions; ${r.biddingQuality.contextStats.totalContexts} уникални контекста, ${r.biddingQuality.contextStats.repeatedContexts} се повтарят):`)
  for (const g of r.biddingQuality.contextStats.topRepeated) {
    lines.push(`  - count=${g.count}, distinct choices=${g.distinctChoices}: ${JSON.stringify(g.choiceCounts)}`)
  }
  lines.push('')
  lines.push('**Raw sensitive identifiers:** виж секция 7 (Privacy review) — общ scan за двата dataset файла.')
  lines.push('')

  lines.push('## 3. Card dataset quality')
  lines.push('')
  lines.push('**Разпределение по game mode (contract.contract):**')
  lines.push(...renderCountsTable(r.cardQuality.contractTypeCounts))
  lines.push('')
  lines.push('**Разпределение по trumpSuit (само за contract === "suit"):**')
  lines.push(...renderCountsTable(r.cardQuality.trumpSuitCounts))
  lines.push('')
  lines.push('**Разпределение по legalCards.length:**')
  lines.push(...renderCountsTable(r.cardQuality.legalCardsLenHistogram))
  lines.push('')
  lines.push('**Разпределение по positionInTrick (0 = leader/lead, 1-3 = follow):**')
  lines.push(...renderCountsTable(r.cardQuality.positionInTrickCounts))
  lines.push('')
  lines.push('**Разпределение chosenCard по suit:**')
  lines.push(...renderCountsTable(r.cardQuality.chosenSuitCounts))
  lines.push('')
  lines.push('**Разпределение chosenCard по rank:**')
  lines.push(...renderCountsTable(r.cardQuality.chosenRankCounts))
  lines.push('')
  lines.push('**Разпределение по seat:**')
  lines.push(...renderCountsTable(r.cardQuality.seatCounts))
  lines.push('')
  lines.push('**Разпределение по team (derived от seat):**')
  lines.push(...renderCountsTable(r.cardQuality.teamCounts))
  lines.push('')
  lines.push(`- Уникални \`playerKey\`: **${r.cardQuality.uniquePlayerKeys}**`)
  lines.push(`- Уникални \`roomKey\`: **${r.cardQuality.uniqueRoomKeys}**`)
  lines.push(`- Записи с \`playerKey === null\` (аномално за human_manual): ${r.cardQuality.nullPlayerKeyCount}`)
  lines.push('')
  if (Object.keys(r.cardQuality.missingFieldCounts).length > 0) {
    lines.push('**Missing/null критични полета:**')
    lines.push(...renderCountsTable(r.cardQuality.missingFieldCounts))
  } else {
    lines.push('**Missing/null критични полета:** няма — всички задължителни полета присъстват във всеки ред.')
  }
  lines.push('')
  lines.push(`- \`chosenCard\` извън \`legalCards\` (независима повторна проверка): **${r.cardQuality.chosenCardNotInLegalCardsCount}**`)
  lines.push(`- \`chosenCard\` извън \`ownHand\` (независима повторна проверка): **${r.cardQuality.chosenCardNotInOwnHandCount}**`)
  lines.push('')
  lines.push(`**Top repeated card contexts** (контекст = seat+trickIndex+positionInTrick+sorted ownHand+sorted legalCards+contract+currentTrick+scoreBeforeDeal и др.; ${r.cardQuality.contextStats.totalContexts} уникални контекста, ${r.cardQuality.contextStats.repeatedContexts} се повтарят):`)
  for (const g of r.cardQuality.contextStats.topRepeated) {
    lines.push(`  - count=${g.count}, distinct choices=${g.distinctChoices}: ${JSON.stringify(g.choiceCounts)}`)
  }
  lines.push('')

  lines.push('## 4. Trivial decision analysis (forced vs non-forced)')
  lines.push('')
  lines.push(`- Forced decisions (точно 1 legal card): **${r.trivialDecisionAnalysis.forcedDecisions}** (${r.trivialDecisionAnalysis.forcedPct})`)
  lines.push(`- Non-forced decisions (2+ legal cards): **${r.trivialDecisionAnalysis.nonForcedDecisions}** (${r.trivialDecisionAnalysis.nonForcedPct})`)
  lines.push('')
  lines.push('Forced decisions не носят training сигнал за избор (само едно легално действие) — препоръчително е да се маркират/филтрират отделно при supervised training на card-play политика, за да не изкривяват loss функцията с "безплатни" правилни отговори.')
  lines.push('')

  lines.push('## 5. Player/room distribution')
  lines.push('')
  lines.push('**Bidding — playerKey:**')
  lines.push(`- уникални: ${r.biddingQuality.playerKeyDistribution.uniqueKeys}, min: ${r.biddingQuality.playerKeyDistribution.min}, max: ${r.biddingQuality.playerKeyDistribution.max}, median: ${r.biddingQuality.playerKeyDistribution.median}`)
  lines.push('- Top 10:')
  lines.push(...renderTop10(r.biddingQuality.playerKeyDistribution.top10, r.overallSummary.totalBiddingSamples))
  lines.push('')
  lines.push('**Bidding — roomKey:**')
  lines.push(`- уникални: ${r.biddingQuality.roomKeyDistribution.uniqueKeys}, min: ${r.biddingQuality.roomKeyDistribution.min}, max: ${r.biddingQuality.roomKeyDistribution.max}, median: ${r.biddingQuality.roomKeyDistribution.median}`)
  lines.push('- Top 10:')
  lines.push(...renderTop10(r.biddingQuality.roomKeyDistribution.top10, r.overallSummary.totalBiddingSamples))
  lines.push('')
  lines.push('**Card — playerKey:**')
  lines.push(`- уникални: ${r.cardQuality.playerKeyDistribution.uniqueKeys}, min: ${r.cardQuality.playerKeyDistribution.min}, max: ${r.cardQuality.playerKeyDistribution.max}, median: ${r.cardQuality.playerKeyDistribution.median}`)
  lines.push('- Top 10:')
  lines.push(...renderTop10(r.cardQuality.playerKeyDistribution.top10, r.overallSummary.totalCardSamples))
  lines.push('')
  lines.push('**Card — roomKey:**')
  lines.push(`- уникални: ${r.cardQuality.roomKeyDistribution.uniqueKeys}, min: ${r.cardQuality.roomKeyDistribution.min}, max: ${r.cardQuality.roomKeyDistribution.max}, median: ${r.cardQuality.roomKeyDistribution.median}`)
  lines.push('- Top 10:')
  lines.push(...renderTop10(r.cardQuality.roomKeyDistribution.top10, r.overallSummary.totalCardSamples))
  lines.push('')
  lines.push('_(playerKey/roomKey стойностите по-горе са показани съкратени до първите 10 hex символа — вече псевдонимизирани HMAC ключове, не оригинални production идентификатори.)_')
  lines.push('')

  lines.push('## 6. Duplicate / near-duplicate review')
  lines.push('')
  lines.push(`- Exact duplicate JSONL редове (bidding): ${r.overallSummary.biddingExactDuplicateGroups} групи, ${r.overallSummary.biddingExactDuplicateRows} extra реда`)
  lines.push(`- Exact duplicate JSONL редове (card): ${r.overallSummary.cardExactDuplicateGroups} групи, ${r.overallSummary.cardExactDuplicateRows} extra реда`)
  lines.push('')
  lines.push(`- Bidding контексти с еднакъв context key, но различен chosen action ("конфликтни"): **${r.biddingQuality.contextStats.conflictingContexts}** групи, обхващащи ${r.biddingQuality.contextStats.conflictingRows} реда (от ${r.biddingQuality.contextStats.repeatedContexts} повторени контекста общо)`)
  lines.push(`- Card контексти с еднакъв context key, но различен chosenCard ("конфликтни"): **${r.cardQuality.contextStats.conflictingContexts}** групи, обхващащи ${r.cardQuality.contextStats.conflictingRows} реда (от ${r.cardQuality.contextStats.repeatedContexts} повторени контекста общо)`)
  lines.push('')
  lines.push('Context key-овете са изчислени само от реално налични schema полета (виж секции 2 и 3) — не са измислени/предположени идентификатори.')
  lines.push('')

  lines.push('## 7. Privacy review')
  lines.push('')
  lines.push(`Статус: **${r.privacyReview.status}**`)
  lines.push(`Проверени файлове: card-decisions.jsonl, bidding-decisions.jsonl, summary.json`)
  lines.push(`Забранени маркери: roomId, profileId, accountId, playerId, connectionId, reconnectToken, sessionId/session*, deviceId, email, username, displayName, ip/ipAddress, password, token/accessToken/refreshToken/authToken, secret, cookie, authorization + email-like/ipv4-like patterns.`)
  lines.push(`Намерени нарушения: ${r.privacyReview.violationCount}`)
  if (r.privacyReview.violations.length > 0) {
    lines.push('')
    for (const v of r.privacyReview.violations) {
      lines.push(`- [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    }
  }
  lines.push('')

  lines.push('## Заключение: готовност за bot training')
  lines.push('')
  const readinessNotes: string[] = []
  if (!bidding.ownHandFieldPresent) {
    readinessNotes.push('🔴 **Блокиращо за bidding модел:** `bidding-decisions.jsonl` няма `ownHand` — без ръката на играча не може да се обучи модел, който предсказва обявяване от visible state. Builder-ът трябва да добави `ownHand` от `visibleBeforeAction.ownHand` (вече присъства в recorder schema-та, просто не е copy-нато в export record-а).')
  } else if (bidding.missingOwnHandCount > 0 || bidding.emptyOwnHandCount > 0 || bidding.invalidOwnHandCount > 0) {
    readinessNotes.push(`🔴 **Блокиращо:** ${bidding.missingOwnHandCount} missing + ${bidding.emptyOwnHandCount} empty + ${bidding.invalidOwnHandCount} invalid ownHand записи в bidding dataset-а — builder-ската validation трябва да се разгледа отново.`)
  } else {
    readinessNotes.push(`🟢 Bidding dataset-ът вече включва \`ownHand\` за всички ${bidding.ownHandStats.count} records (min/max/median дължина: ${bidding.ownHandStats.min}/${bidding.ownHandStats.max}/${bidding.ownHandStats.median}) — вече е подходящ за supervised bidding модел, при 0 validation нарушения.`)
  }
  if (cards.chosenNotInLegalCount > 0 || cards.chosenNotInHandCount > 0) {
    readinessNotes.push(`🔴 **Блокиращо:** намерени ${cards.chosenNotInLegalCount} chosenCard извън legalCards и ${cards.chosenNotInHandCount} извън ownHand в card dataset-а — validation-а на builder-а трябва да се разгледа отново.`)
  }
  if (r.privacyReview.status !== 'PASS') {
    readinessNotes.push('🔴 **Блокиращо:** privacy нарушения в generated output — не се export-ва/commit-ва преди fix.')
  }
  if (cards.forcedCount > 0) {
    readinessNotes.push(`🟡 **За внимание:** ${r.trivialDecisionAnalysis.forcedPct} от card decisions са forced (1 legal card) — препоръка е да се тренира отделно/да се тежират по-ниско, за да не разводняват сигнала от реални избори.`)
  }
  if (r.overallSummary.cardExactDuplicateGroups > 0 || r.overallSummary.biddingExactDuplicateGroups > 0) {
    readinessNotes.push('🟡 **За внимание:** има exact duplicate редове — за training обикновено се дедупликират, за да не претеглят изкуствено едни и същи ситуации.')
  }
  readinessNotes.push('🟢 Card dataset-ът (ownHand + legalCards + contract + trick context + chosenCard) изглежда достатъчно богат за supervised card-play модел, при 0 validation нарушения.')

  lines.push(...readinessNotes.map((n) => `- ${n}`))
  lines.push('')

  return lines.join('\n')
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
