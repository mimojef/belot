/**
 * summarizeLocalAiCardBetaTrace.ts
 *
 * Read-only summarizer за training-output/local-ai-beta/card-decisions.jsonl
 * (записан от server/src/ai/localAiCardBeta.ts, само когато
 * LOCAL_AI_CARD_BETA_TRACE_ENABLED=true по време на локална beta игра).
 * Не пипа gameplay/bot logic — само чете вече записан trace log и генерира
 * human/machine-readable отчет.
 *
 * Usage:
 *   npm run summarize:local-ai-card-beta-trace   (от server/)
 *   npm run summarize:local-ai-card-beta-trace -- path/to/card-decisions.jsonl
 *
 * Exit codes:
 *   0 — обобщено успешно (или няма trace файл все още — не е грешка)
 *   1 — invalid JSONL, invalid final card намерен в trace-а, privacy нарушение
 *   2 — file system грешка (различна от "файлът просто не съществува")
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { scanFileForForbiddenContent, type SanitizationViolation } from './trainingDataset/sanitizeOutput.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const TRACE_DIR = join(REPO_ROOT, 'training-output', 'local-ai-beta')
const DEFAULT_TRACE_PATH = join(TRACE_DIR, 'card-decisions.jsonl')

const SUMMARY_JSON_PATH = join(TRACE_DIR, 'summary.json')
const SUMMARY_MD_PATH = join(TRACE_DIR, 'summary.md')

// ─── Trace record shape (pass-through — matches localAiCardBeta.ts) ──────────

export type DecisionSource =
  | 'ai_disabled'
  | 'ai_accepted'
  | 'ai_same_as_conventional'
  | 'conventional_fallback'
  | 'forced_card'
  | 'advisor_override'
  | 'advisor_no_override'
  | 'advisor_fallback'
const KNOWN_DECISION_SOURCES: DecisionSource[] = [
  'ai_disabled', 'ai_accepted', 'ai_same_as_conventional', 'conventional_fallback', 'forced_card',
  'advisor_override', 'advisor_no_override', 'advisor_fallback',
]

export type TraceRecord = {
  timestamp: string
  traceVersion: number
  modelVersion: string | null
  aiEnabled: boolean
  traceEnabled: boolean
  decisionSource: DecisionSource
  fallbackUsed: boolean
  fallbackReason: string | null
  seatIndex: number
  teamIndex: number
  legalCardsCount: number
  ownHandCount: number
  isForced: boolean
  gameMode: string | null
  trumpSuit: string | null
  // Добавени в traceVersion 2 (server/src/ai/localAiCardBeta.ts) — optional,
  // защото по-стари trace файлове (traceVersion 1) не ги съдържат.
  isLead?: boolean
  positionInTrick?: number
  pointsInTrick?: number
  conventionalCard: string | null
  aiSelectedCard: string | null
  finalCard: string | null
  aiSameAsConventional: boolean | null
  finalCardValid: boolean
  aiCardValid: boolean | null
  rankingLength: number
  topPredictions: Array<{ id: string; score: number; probability: number }>
  // Добавени в traceVersion 3 (conventional-first tactical advisor policy) —
  // optional, защото по-стари trace файлове (traceVersion 1/2) не ги съдържат.
  policyMode?: 'model' | 'advisor' | null
  advisorSelectedCard?: string | null
  advisorOverride?: boolean | null
  advisorReason?: string | null
  partnerCurrentlyWinning?: boolean | null
  opponentCurrentlyWinning?: boolean | null
  conventionalCardCandidateIsCleanWinner?: boolean | null
  conventionalCardShouldPreserveCleanWinner?: boolean | null
  finalCardCandidateIsCleanWinner?: boolean | null
  finalCardShouldPreserveCleanWinner?: boolean | null
  predictedWinnerIfConventional?: string | null
  predictedWinningTeamIfConventional?: string | null
  predictedWinnerIfAdvisor?: string | null
  predictedWinningTeamIfAdvisor?: string | null
  roomKey: string | null
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
      if (pattern.test(line)) violations.push({ file: filePath, line: idx + 1, pattern: label, snippet: line.slice(0, 200) })
    }
  })
  return violations
}

async function scanAllForbiddenContent(filePath: string): Promise<SanitizationViolation[]> {
  return [...(await scanFileForForbiddenContent(filePath)), ...(await scanExtraForbiddenContent(filePath))]
}

function pct(part: number, total: number): string {
  if (total === 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

// ─── Strict JSONL parsing (само trailing newline позволен като "празен ред") ─

export function parseJsonlStrict(content: string, fileLabel: string): { records: Array<{ record: TraceRecord; lineNumber: number }>; errors: string[] } {
  const rawLines = content.split('\n')
  const records: Array<{ record: TraceRecord; lineNumber: number }> = []
  const errors: string[] = []

  rawLines.forEach((rawLine, idx) => {
    const isLastLine = idx === rawLines.length - 1
    const trimmed = rawLine.trim()
    if (!trimmed) {
      if (!isLastLine) errors.push(`${fileLabel}:${idx + 1}: неочакван празен ред (не е trailing newline)`)
      return
    }
    try {
      const parsed = JSON.parse(trimmed) as TraceRecord
      if (!KNOWN_DECISION_SOURCES.includes(parsed.decisionSource)) {
        errors.push(`${fileLabel}:${idx + 1}: непознат decisionSource "${String(parsed.decisionSource)}"`)
        return
      }
      records.push({ record: parsed, lineNumber: idx + 1 })
    } catch (e) {
      errors.push(`${fileLabel}:${idx + 1}: invalid JSON — ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  return { records, errors }
}

// ─── Pure aggregation (изнесена, за да е директно тестваема без process.exit) ─

export type TraceSummary = {
  generatedAt: string
  tracePath: string
  totalDecisions: number
  decisionSourceCounts: Record<DecisionSource, number>
  invalidAiPredictions: number
  invalidFinalCards: number
  invalidFinalCardLines: number[]
  fallbackReasonCounts: Record<string, number>
  aiAcceptedRateExcludingForced: number
  aiDiffersFromConventionalCount: number
  aiDiffersFromConventionalRate: number
  nonForcedAiEnabledTotal: number
  validAiPredictionsTotal: number
  topAiSelectedCards: Array<{ id: string; count: number }>
  // ─── Advisor policy stats (traceVersion 3, additive) ────────────────────────
  advisorTotalDecisions: number
  advisorOverrideCount: number
  advisorNoOverrideCount: number
  advisorFallbackCount: number
  advisorOverrideRate: number
  advisorReasonCounts: Record<string, number>
}

export function computeTraceSummary(
  records: Array<{ record: TraceRecord; lineNumber: number }>,
  tracePath: string,
): TraceSummary {
  const bySource: Record<DecisionSource, number> = {
    ai_disabled: 0, ai_accepted: 0, ai_same_as_conventional: 0, conventional_fallback: 0, forced_card: 0,
    advisor_override: 0, advisor_no_override: 0, advisor_fallback: 0,
  }
  let invalidAiPredictions = 0
  let invalidFinalCards = 0
  const invalidFinalCardLines: number[] = []
  const fallbackReasonCounts: Record<string, number> = {}
  const aiSelectedCardCounts: Record<string, number> = {}
  const advisorReasonCounts: Record<string, number> = {}

  for (const { record, lineNumber } of records) {
    bySource[record.decisionSource]++
    if (record.aiCardValid === false) invalidAiPredictions++
    if (!record.finalCardValid) {
      invalidFinalCards++
      invalidFinalCardLines.push(lineNumber)
    }
    if (record.fallbackUsed && record.fallbackReason) {
      fallbackReasonCounts[record.fallbackReason] = (fallbackReasonCounts[record.fallbackReason] ?? 0) + 1
    }
    if (record.aiSelectedCard) {
      aiSelectedCardCounts[record.aiSelectedCard] = (aiSelectedCardCounts[record.aiSelectedCard] ?? 0) + 1
    }
    if (record.decisionSource === 'advisor_override' && record.advisorReason) {
      advisorReasonCounts[record.advisorReason] = (advisorReasonCounts[record.advisorReason] ?? 0) + 1
    }
  }

  const total = records.length
  const nonForcedAiEnabledTotal = bySource.ai_accepted + bySource.ai_same_as_conventional + bySource.conventional_fallback
  const validAiPredictionsTotal = bySource.ai_accepted + bySource.ai_same_as_conventional
  const aiAcceptedRateExcludingForced = nonForcedAiEnabledTotal > 0 ? bySource.ai_accepted / nonForcedAiEnabledTotal : 0
  const aiDiffersFromConventionalRate = validAiPredictionsTotal > 0 ? bySource.ai_accepted / validAiPredictionsTotal : 0

  const topAiSelectedCards = Object.entries(aiSelectedCardCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, count]) => ({ id, count }))

  const advisorTotalDecisions = bySource.advisor_override + bySource.advisor_no_override + bySource.advisor_fallback
  const advisorOverrideRate = advisorTotalDecisions > 0 ? bySource.advisor_override / advisorTotalDecisions : 0

  return {
    generatedAt: new Date().toISOString(),
    tracePath,
    totalDecisions: total,
    decisionSourceCounts: bySource,
    invalidAiPredictions,
    invalidFinalCards,
    invalidFinalCardLines: invalidFinalCardLines.slice(0, 100),
    fallbackReasonCounts,
    aiAcceptedRateExcludingForced,
    aiDiffersFromConventionalCount: bySource.ai_accepted,
    aiDiffersFromConventionalRate,
    nonForcedAiEnabledTotal,
    validAiPredictionsTotal,
    topAiSelectedCards,
    advisorTotalDecisions,
    advisorOverrideCount: bySource.advisor_override,
    advisorNoOverrideCount: bySource.advisor_no_override,
    advisorFallbackCount: bySource.advisor_fallback,
    advisorOverrideRate,
    advisorReasonCounts,
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  Local AI Card Beta — Trace Summarizer (локален, read-only)')
  console.log('─────────────────────────────────────────')

  const args = process.argv.slice(2)
  const tracePath = args.find((a) => !a.startsWith('-')) ?? (process.env['LOCAL_AI_CARD_BETA_TRACE_PATH']?.trim() || DEFAULT_TRACE_PATH)

  let content: string
  try {
    content = await readFile(tracePath, 'utf8')
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      console.log(`Trace файл не е намерен: ${tracePath}`)
      console.log('Няма записани decisions все още — пусни локална beta игра с LOCAL_AI_CARD_BETA_TRACE_ENABLED=true първо.')
      process.exit(0)
      return
    }
    console.error(`FATAL: не мога да прочета trace файла (${tracePath}): ${err.message}`)
    process.exit(2)
    return
  }

  console.log(`Чета: ${tracePath}`)
  const { records, errors } = parseJsonlStrict(content, 'card-decisions.jsonl')

  if (errors.length > 0) {
    console.error(`\n✗ Открити ${errors.length} validation грешки в trace-а:\n`)
    for (const e of errors.slice(0, 200)) console.error(`  ${e}`)
    process.exit(1)
    return
  }

  if (records.length === 0) {
    console.log('Trace файлът е празен (0 records).')
  }

  // ─── Privacy scan на trace input-а ──────────────────────────────────────────
  const inputViolations = await scanAllForbiddenContent(tracePath)
  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в trace файла — summarize СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  // ─── Aggregate metrics (изчислени в pure, тествана отделно функция) ───────
  const summaryJson = computeTraceSummary(records, tracePath)

  await mkdir(TRACE_DIR, { recursive: true })
  await writeFile(SUMMARY_JSON_PATH, JSON.stringify(summaryJson, null, 2) + '\n', 'utf8')
  await writeFile(SUMMARY_MD_PATH, renderMarkdown(summaryJson), 'utf8')

  // ─── Privacy re-scan на generated summary ──────────────────────────────────
  const outputViolations = [
    ...(await scanAllForbiddenContent(SUMMARY_JSON_PATH)),
    ...(await scanAllForbiddenContent(SUMMARY_MD_PATH)),
  ]
  if (outputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в generated summary — намерени ${outputViolations.length}:\n`)
    for (const v of outputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  // ─── Console report ─────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────')
  console.log('  Резултат')
  console.log('─────────────────────────────────────────')
  console.log(`  Total decisions: ${summaryJson.totalDecisions}`)
  console.log(`  ai_disabled: ${summaryJson.decisionSourceCounts.ai_disabled}, forced_card: ${summaryJson.decisionSourceCounts.forced_card}`)
  console.log(`  ai_accepted: ${summaryJson.decisionSourceCounts.ai_accepted}, ai_same_as_conventional: ${summaryJson.decisionSourceCounts.ai_same_as_conventional}, conventional_fallback: ${summaryJson.decisionSourceCounts.conventional_fallback}`)
  console.log(`  Invalid AI predictions: ${summaryJson.invalidAiPredictions}`)
  console.log(`  Invalid final cards: ${summaryJson.invalidFinalCards}`)
  console.log(`  AI accepted rate (excluding forced): ${pct(summaryJson.decisionSourceCounts.ai_accepted, summaryJson.nonForcedAiEnabledTotal)}`)
  console.log(`  AI differs from conventional rate: ${pct(summaryJson.decisionSourceCounts.ai_accepted, summaryJson.validAiPredictionsTotal)}`)
  if (summaryJson.advisorTotalDecisions > 0) {
    console.log(`  Advisor policy — total: ${summaryJson.advisorTotalDecisions}, override: ${summaryJson.advisorOverrideCount}, no_override: ${summaryJson.advisorNoOverrideCount}, fallback: ${summaryJson.advisorFallbackCount}`)
    console.log(`  Advisor override rate: ${pct(summaryJson.advisorOverrideCount, summaryJson.advisorTotalDecisions)}`)
    console.log(`  Advisor reasons: ${Object.entries(summaryJson.advisorReasonCounts).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`)
  }
  console.log(`\n✓ Отчет: ${SUMMARY_MD_PATH}`)
  console.log(`✓ Отчет: ${SUMMARY_JSON_PATH}`)

  if (summaryJson.invalidFinalCards > 0) {
    console.error(`\n✗ КРИТИЧНО: ${summaryJson.invalidFinalCards} invalid final card(s) намерени в trace-а — виж редове: ${summaryJson.invalidFinalCardLines.slice(0, 20).join(', ')}`)
    process.exit(1)
    return
  }

  console.log('✓ Summarize завършен успешно.\n')
  process.exit(0)
}

function renderMarkdown(s: TraceSummary): string {
  const lines: string[] = []
  lines.push('# Local AI Card Beta — Trace Summary')
  lines.push('')
  lines.push(`Генериран на: ${s.generatedAt}`)
  lines.push(`Trace файл: \`${s.tracePath}\``)
  lines.push('')
  lines.push('Локален, read-only отчет върху decision trace от `LOCAL_AI_CARD_BETA_TRACE_ENABLED=true` local beta сесии. Не отразява production трафик — само локални тестови/beta игри.')
  lines.push('')

  lines.push('## Общо решения')
  lines.push('')
  lines.push(`- Total decisions: **${s.totalDecisions}**`)
  lines.push(`- ai_disabled: ${s.decisionSourceCounts.ai_disabled}`)
  lines.push(`- forced_card: ${s.decisionSourceCounts.forced_card}`)
  lines.push(`- ai_accepted: ${s.decisionSourceCounts.ai_accepted}`)
  lines.push(`- ai_same_as_conventional: ${s.decisionSourceCounts.ai_same_as_conventional}`)
  lines.push(`- conventional_fallback: ${s.decisionSourceCounts.conventional_fallback}`)
  lines.push('')

  lines.push('## Safety validation')
  lines.push('')
  lines.push(`- Invalid AI predictions (модел предложи карта извън legalCards/ownHand, коригирано от wrapper-а): **${s.invalidAiPredictions}**`)
  lines.push(`- Invalid FINAL cards (трябва да е 0 — критично, ако не е): **${s.invalidFinalCards}**`)
  if (s.invalidFinalCards > 0) {
    lines.push(`  - Редове: ${s.invalidFinalCardLines.join(', ')}`)
  }
  lines.push('')

  lines.push('## Fallback reasons')
  lines.push('')
  if (Object.keys(s.fallbackReasonCounts).length === 0) {
    lines.push('Няма fallback-и в trace-а.')
  } else {
    for (const [reason, count] of Object.entries(s.fallbackReasonCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${reason}: ${count}`)
    }
  }
  lines.push('')

  lines.push('## AI поведение (само non-forced decisions с AI enabled)')
  lines.push('')
  lines.push(`- AI accepted rate (изключвайки forced): ${pct(s.aiDiffersFromConventionalCount, s.nonForcedAiEnabledTotal)} (${s.aiDiffersFromConventionalCount}/${s.nonForcedAiEnabledTotal})`)
  lines.push(`- AI differs from conventional (сред валидни AI predictions): ${pct(s.aiDiffersFromConventionalCount, s.validAiPredictionsTotal)} (${s.aiDiffersFromConventionalCount}/${s.validAiPredictionsTotal})`)
  lines.push('')

  lines.push('## Top избрани AI карти')
  lines.push('')
  if (s.topAiSelectedCards.length === 0) {
    lines.push('Няма AI-selected карти в trace-а.')
  } else {
    for (const c of s.topAiSelectedCards) lines.push(`- ${c.id}: ${c.count}`)
  }
  lines.push('')

  lines.push('## Advisor policy (conventional-first tactical guard, traceVersion 3)')
  lines.push('')
  if (s.advisorTotalDecisions === 0) {
    lines.push('Няма advisor-policy decisions в trace-а (LOCAL_AI_CARD_BETA_POLICY беше "model" или AI флагът е бил off).')
  } else {
    lines.push(`- Total advisor decisions: ${s.advisorTotalDecisions}`)
    lines.push(`- advisor_override: ${s.advisorOverrideCount}`)
    lines.push(`- advisor_no_override: ${s.advisorNoOverrideCount}`)
    lines.push(`- advisor_fallback: ${s.advisorFallbackCount}`)
    lines.push(`- Override rate: ${pct(s.advisorOverrideCount, s.advisorTotalDecisions)}`)
    lines.push('')
    lines.push('Override reasons:')
    if (Object.keys(s.advisorReasonCounts).length === 0) {
      lines.push('- (none)')
    } else {
      for (const [reason, count] of Object.entries(s.advisorReasonCounts).sort((a, b) => b[1] - a[1])) {
        lines.push(`- ${reason}: ${count}`)
      }
    }
  }
  lines.push('')

  lines.push('## Изходни файлове')
  lines.push('')
  lines.push('- `training-output/local-ai-beta/card-decisions.jsonl` (input, generated от runtime trace)')
  lines.push('- `training-output/local-ai-beta/summary.json`')
  lines.push('- `training-output/local-ai-beta/summary.md`')
  lines.push('')

  return lines.join('\n')
}

// main() трябва да тръгне САМО когато файлът се изпълнява директно (npm run
// summarize:local-ai-card-beta-trace), НЕ когато computeTraceSummary/
// parseJsonlStrict се import-ват от check script (иначе process.exit щеше
// да убие импортиращия процес).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error('Unexpected error:', e)
    process.exit(2)
  })
}
