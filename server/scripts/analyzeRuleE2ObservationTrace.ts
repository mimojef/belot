/**
 * analyzeRuleE2ObservationTrace.ts
 *
 * Read-only local анализатор за
 * training-output/local-ai-beta/card-decisions-rule-e2-observation.jsonl —
 * trace-а, записан от server/src/ai/localAiCardBeta.ts, само когато
 * LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED=true по време на локална beta
 * игра (виж server/src/ai/cardAdvisorSignalRuleE2.ts за самата Rule E2
 * `e2_no_point_feed` логика).
 *
 * Не пипа gameplay/bot logic, не пипа localAiCardBeta.ts — само чете вече
 * записан trace log и генерира human/machine-readable отчет за наблюдение.
 * Rule E2 в реалната игра е чисто observational (никога не избира final
 * картата) — този анализатор просто измерва какво е щял да предложи и защо
 * (не), плюс safety инварианти върху вече записаните данни.
 *
 * Usage:
 *   npm run analyze:rule-e2-observation-trace
 *   npm run analyze:rule-e2-observation-trace -- path/to/trace.jsonl
 *   LOCAL_AI_RULE_E2_OBSERVATION_TRACE_PATH=... npm run analyze:rule-e2-observation-trace
 *
 * Толерантност: невалидни/празни/частично corrupt JSONL редове НЕ спират
 * анализа — броят се като parseErrors и се пропускат; отчетът се генерира
 * от останалите валидни редове (може да е 0 валидни редове без crash).
 *
 * Exit codes:
 *   0 — анализ завършен (дори при parse errors в trace-а — те се отчитат, не блокират)
 *   1 — privacy нарушение в input/generated файловете
 *   2 — file system грешка (различна от "файлът просто не съществува все още")
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { scanFileForForbiddenContent, type SanitizationViolation } from './trainingDataset/sanitizeOutput.js'
import type { LocalAiCardBetaTraceRecord } from '../src/ai/localAiCardBeta.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const TRACE_DIR = join(REPO_ROOT, 'training-output', 'local-ai-beta')
const DEFAULT_TRACE_PATH = join(TRACE_DIR, 'card-decisions-rule-e2-observation.jsonl')

const REPORT_JSON_PATH = join(TRACE_DIR, 'rule-e2-observation-trace-report.json')
const REPORT_MD_PATH = join(TRACE_DIR, 'rule-e2-observation-trace-report.md')

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

// ─── Tolerant JSONL parsing (никога не хвърля — corrupt/празни редове се броят, не спират анализа) ─

type Row = LocalAiCardBetaTraceRecord

function parseJsonlTolerant(content: string): { rows: Array<{ row: Row; lineNumber: number }>; parseErrors: string[] } {
  const rawLines = content.split('\n')
  const rows: Array<{ row: Row; lineNumber: number }> = []
  const parseErrors: string[] = []

  rawLines.forEach((rawLine, idx) => {
    const isLastLine = idx === rawLines.length - 1
    const trimmed = rawLine.trim()
    if (!trimmed) {
      if (!isLastLine) parseErrors.push(`ред ${idx + 1}: празен ред (не е trailing newline)`)
      return
    }
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        parseErrors.push(`ред ${idx + 1}: JSON не е обект`)
        return
      }
      rows.push({ row: parsed as Row, lineNumber: idx + 1 })
    } catch (e) {
      parseErrors.push(`ред ${idx + 1}: invalid JSON — ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  return { rows, parseErrors }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

function pct(part: number, total: number): string {
  if (total === 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

function rate(part: number, total: number): number {
  return total === 0 ? 0 : part / total
}

function extractSuit(cardId: string | null | undefined): string | null {
  if (!cardId || typeof cardId !== 'string') return null
  const idx = cardId.indexOf('-')
  return idx === -1 ? null : cardId.slice(0, idx)
}

function confidenceBucket(c: number): string {
  if (c < 0.5) return '<0.5'
  if (c < 0.7) return '0.5-0.69'
  if (c < 0.85) return '0.7-0.84'
  return '>=0.85'
}

function pointsBucket(p: number): string {
  if (p <= 0) return '0'
  if (p < 10) return '1-9'
  return '10+'
}

function boolKey(v: boolean | null | undefined): string {
  if (v === true) return 'true'
  if (v === false) return 'false'
  return 'null'
}

function sortedCounts(map: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]))
}

// ─── Report shape ───────────────────────────────────────────────────────────────

export type RuleE2ObservationReport = {
  generatedAt: string
  tracePath: string
  basicCounts: {
    totalJsonlRows: number
    parseErrorCount: number
    validRows: number
    rowsWithObservation: number
    rowsWithoutObservation: number
    decisionSourceCounts: Record<string, number>
    forcedCardCount: number
  }
  observationCounts: {
    enabledTrue: number
    enabledFalse: number
    wouldFireCount: number
    wouldFireRate: number
    suppressionReasonCounts: Record<string, number>
    suggestedCardCounts: Record<string, number>
    signalSuitCounts: Record<string, number>
    signalTypeCounts: Record<string, number>
    confidenceBuckets: Record<string, number>
  }
  differenceAnalysis: {
    wouldDifferFromFinalCount: number
    wouldDifferFromFinalRate: number
    wouldDifferFromConventionalCount: number
    wouldDifferFromConventionalRate: number
    wouldDifferFromAdvisorV0Count: number
    wouldDifferFromAdvisorV0Rate: number
    wouldFireAndDifferFromFinal: number
    wouldFireAndSameAsFinal: number
    wouldFireAndSameAsConventional: number
    wouldFireAndDifferFromConventional: number
  }
  safetyAnalysis: {
    suggestionInLegalCardsFalseCount: number
    suggestionInOwnHandFalseCount: number
    invalidOrMissingSuggestedCardWhenFired: number
    forcedCardWithWouldFireTrue: number
    observationErrorCount: number
    impossibleStateCount: number
    impossibleStateExamples: string[]
  }
  contextBreakdowns: {
    gameModeCounts: Record<string, number>
    positionInTrickCounts: Record<string, number>
    leadCount: number
    followCount: number
    leadFollowUnknownCount: number
    pointsInTrickBuckets: Record<string, number>
    partnerCurrentlyWinningCounts: Record<string, number>
    opponentCurrentlyWinningCounts: Record<string, number>
    finalCardSameSuitAsSignal: { same: number; different: number; notApplicable: number }
    conventionalCardSameSuitAsSignal: { same: number; different: number; notApplicable: number }
    advisorV0CardSameSuitAsSignal: string
  }
}

// ─── Pure aggregation (изнесена, за да е директно тествана без process.exit) ────

export function computeRuleE2ObservationReport(
  rows: Array<{ row: Row; lineNumber: number }>,
  parseErrorCount: number,
  totalJsonlRows: number,
  tracePath: string,
): RuleE2ObservationReport {
  const decisionSourceCounts: Record<string, number> = {}
  let forcedCardCount = 0
  let rowsWithObservation = 0

  let enabledTrue = 0
  let enabledFalse = 0
  let wouldFireCount = 0
  const suppressionReasonCounts: Record<string, number> = {}
  const suggestedCardCounts: Record<string, number> = {}
  const signalSuitCounts: Record<string, number> = {}
  const signalTypeCounts: Record<string, number> = {}
  const confidenceBuckets: Record<string, number> = {}

  let wouldDifferFromFinalCount = 0
  let wouldDifferFromConventionalCount = 0
  let wouldDifferFromAdvisorV0Count = 0
  let wouldFireAndDifferFromFinal = 0
  let wouldFireAndSameAsFinal = 0
  let wouldFireAndSameAsConventional = 0
  let wouldFireAndDifferFromConventional = 0

  let suggestionInLegalCardsFalseCount = 0
  let suggestionInOwnHandFalseCount = 0
  let invalidOrMissingSuggestedCardWhenFired = 0
  let forcedCardWithWouldFireTrue = 0
  let observationErrorCount = 0
  let impossibleStateCount = 0
  const impossibleStateExamples: string[] = []

  const gameModeCounts: Record<string, number> = {}
  const positionInTrickCounts: Record<string, number> = {}
  let leadCount = 0
  let followCount = 0
  let leadFollowUnknownCount = 0
  const pointsInTrickBuckets: Record<string, number> = {}
  const partnerCurrentlyWinningCounts: Record<string, number> = {}
  const opponentCurrentlyWinningCounts: Record<string, number> = {}
  let finalSameSuit = 0
  let finalDiffSuit = 0
  let finalNotApplicable = 0
  let conventionalSameSuit = 0
  let conventionalDiffSuit = 0
  let conventionalNotApplicable = 0

  for (const { row, lineNumber } of rows) {
    const decisionSource = typeof row.decisionSource === 'string' ? row.decisionSource : 'unknown'
    bump(decisionSourceCounts, decisionSource)
    if (decisionSource === 'forced_card') forcedCardCount++

    if (typeof row.gameMode === 'string') bump(gameModeCounts, row.gameMode)
    if (typeof row.positionInTrick === 'number') bump(positionInTrickCounts, String(row.positionInTrick))
    if (row.isLead === true) leadCount++
    else if (row.isLead === false) followCount++
    else leadFollowUnknownCount++
    if (typeof row.pointsInTrick === 'number') bump(pointsInTrickBuckets, pointsBucket(row.pointsInTrick))
    bump(partnerCurrentlyWinningCounts, boolKey(row.partnerCurrentlyWinning))
    bump(opponentCurrentlyWinningCounts, boolKey(row.opponentCurrentlyWinning))

    const obs = row.ruleE2Observation
    if (!obs || typeof obs !== 'object') continue
    rowsWithObservation++

    if (obs.enabled === true) enabledTrue++
    else enabledFalse++

    const wouldFire = obs.wouldFire === true
    if (wouldFire) wouldFireCount++

    const suppressionKey = obs.suppressionReason === null || obs.suppressionReason === undefined ? '(none — wouldFire)' : String(obs.suppressionReason)
    bump(suppressionReasonCounts, suppressionKey)

    if (typeof obs.suggestedCard === 'string') bump(suggestedCardCounts, obs.suggestedCard)
    if (typeof obs.signalSuit === 'string') bump(signalSuitCounts, obs.signalSuit)
    if (typeof obs.signalType === 'string') bump(signalTypeCounts, obs.signalType)
    if (typeof obs.signalConfidence === 'number') bump(confidenceBuckets, confidenceBucket(obs.signalConfidence))

    if (obs.wouldDifferFromFinal === true) wouldDifferFromFinalCount++
    if (obs.wouldDifferFromConventional === true) wouldDifferFromConventionalCount++
    if (obs.wouldDifferFromAdvisorV0 === true) wouldDifferFromAdvisorV0Count++

    if (wouldFire) {
      if (obs.wouldDifferFromFinal === true) wouldFireAndDifferFromFinal++
      else wouldFireAndSameAsFinal++
      if (obs.wouldDifferFromConventional === true) wouldFireAndDifferFromConventional++
      else wouldFireAndSameAsConventional++
    }

    if (obs.safety?.suggestionInLegalCards === false) suggestionInLegalCardsFalseCount++
    if (obs.safety?.suggestionInOwnHand === false) suggestionInOwnHandFalseCount++
    if (wouldFire && (typeof obs.suggestedCard !== 'string' || obs.suggestedCard.length === 0)) invalidOrMissingSuggestedCardWhenFired++
    if (decisionSource === 'forced_card' && wouldFire) forcedCardWithWouldFireTrue++
    if (typeof obs.error === 'string' && obs.error.length > 0) observationErrorCount++

    // Невъзможни състояния: wouldFire=true трябва да значи suppressionReason===null (и обратно).
    if (wouldFire && obs.suppressionReason !== null && obs.suppressionReason !== undefined) {
      impossibleStateCount++
      if (impossibleStateExamples.length < 20) impossibleStateExamples.push(`ред ${lineNumber}: wouldFire=true но suppressionReason="${obs.suppressionReason}"`)
    }
    if (!wouldFire && (obs.suppressionReason === null || obs.suppressionReason === undefined)) {
      impossibleStateCount++
      if (impossibleStateExamples.length < 20) impossibleStateExamples.push(`ред ${lineNumber}: wouldFire=false но suppressionReason е null/missing`)
    }

    const signalSuit = typeof obs.signalSuit === 'string' ? obs.signalSuit : null
    if (signalSuit) {
      const finalSuit = extractSuit(row.finalCard)
      if (finalSuit) {
        if (finalSuit === signalSuit) finalSameSuit++
        else finalDiffSuit++
      } else {
        finalNotApplicable++
      }
      const conventionalSuit = extractSuit(row.conventionalCard)
      if (conventionalSuit) {
        if (conventionalSuit === signalSuit) conventionalSameSuit++
        else conventionalDiffSuit++
      } else {
        conventionalNotApplicable++
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    tracePath,
    basicCounts: {
      totalJsonlRows,
      parseErrorCount,
      validRows: rows.length,
      rowsWithObservation,
      rowsWithoutObservation: rows.length - rowsWithObservation,
      decisionSourceCounts: sortedCounts(decisionSourceCounts),
      forcedCardCount,
    },
    observationCounts: {
      enabledTrue,
      enabledFalse,
      wouldFireCount,
      wouldFireRate: rate(wouldFireCount, rowsWithObservation),
      suppressionReasonCounts: sortedCounts(suppressionReasonCounts),
      suggestedCardCounts: sortedCounts(suggestedCardCounts),
      signalSuitCounts: sortedCounts(signalSuitCounts),
      signalTypeCounts: sortedCounts(signalTypeCounts),
      confidenceBuckets: sortedCounts(confidenceBuckets),
    },
    differenceAnalysis: {
      wouldDifferFromFinalCount,
      wouldDifferFromFinalRate: rate(wouldDifferFromFinalCount, rowsWithObservation),
      wouldDifferFromConventionalCount,
      wouldDifferFromConventionalRate: rate(wouldDifferFromConventionalCount, rowsWithObservation),
      wouldDifferFromAdvisorV0Count,
      wouldDifferFromAdvisorV0Rate: rate(wouldDifferFromAdvisorV0Count, rowsWithObservation),
      wouldFireAndDifferFromFinal,
      wouldFireAndSameAsFinal,
      wouldFireAndSameAsConventional,
      wouldFireAndDifferFromConventional,
    },
    safetyAnalysis: {
      suggestionInLegalCardsFalseCount,
      suggestionInOwnHandFalseCount,
      invalidOrMissingSuggestedCardWhenFired,
      forcedCardWithWouldFireTrue,
      observationErrorCount,
      impossibleStateCount,
      impossibleStateExamples,
    },
    contextBreakdowns: {
      gameModeCounts: sortedCounts(gameModeCounts),
      positionInTrickCounts: sortedCounts(positionInTrickCounts),
      leadCount,
      followCount,
      leadFollowUnknownCount,
      pointsInTrickBuckets: sortedCounts(pointsInTrickBuckets),
      partnerCurrentlyWinningCounts: sortedCounts(partnerCurrentlyWinningCounts),
      opponentCurrentlyWinningCounts: sortedCounts(opponentCurrentlyWinningCounts),
      finalCardSameSuitAsSignal: { same: finalSameSuit, different: finalDiffSuit, notApplicable: finalNotApplicable },
      conventionalCardSameSuitAsSignal: { same: conventionalSameSuit, different: conventionalDiffSuit, notApplicable: conventionalNotApplicable },
      advisorV0CardSameSuitAsSignal:
        'not_available_in_trace — advisorV0CardId (shadow advisor v0 избор) не се persist-ва в trace payload-а, само derived boolean wouldDifferFromAdvisorV0 е наличен',
    },
  }
}

// ─── Markdown rendering ─────────────────────────────────────────────────────────

function renderMarkdown(r: RuleE2ObservationReport): string {
  const lines: string[] = []
  const bc = r.basicCounts
  const oc = r.observationCounts
  const da = r.differenceAnalysis
  const sa = r.safetyAnalysis
  const cb = r.contextBreakdowns

  lines.push('# Rule E2 (`e2_no_point_feed`) — Observational Beta Trace Analysis')
  lines.push('')
  lines.push(`Генериран на: ${r.generatedAt}`)
  lines.push(`Trace файл: \`${r.tracePath}\``)
  lines.push('')
  lines.push('Локален, read-only отчет върху observational Rule E2 trace от `LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED=true` local beta сесии. Rule E2 НИКОГА не е избирал final картата в тези игри — само е трасирал какво би предложил и защо (не). Този отчет не отразява production трафик.')
  lines.push('')

  lines.push('## 1. Basic counts')
  lines.push('')
  lines.push(`- Total JSONL rows (опитани за parse): ${bc.totalJsonlRows}`)
  lines.push(`- Parse errors: ${bc.parseErrorCount}`)
  lines.push(`- Valid rows: ${bc.validRows}`)
  lines.push(`- Rows with ruleE2Observation: ${bc.rowsWithObservation}`)
  lines.push(`- Rows without ruleE2Observation: ${bc.rowsWithoutObservation}`)
  lines.push(`- forced_card count: ${bc.forcedCardCount}`)
  lines.push('')
  lines.push('decisionSource distribution:')
  for (const [k, v] of Object.entries(bc.decisionSourceCounts)) lines.push(`- ${k}: ${v} (${pct(v, bc.validRows)})`)
  lines.push('')

  lines.push('## 2. Rule E2 observation counts')
  lines.push('')
  lines.push(`- enabled=true: ${oc.enabledTrue}, enabled=false: ${oc.enabledFalse}`)
  lines.push(`- wouldFire count: ${oc.wouldFireCount} (${pct(oc.wouldFireCount, bc.rowsWithObservation)} от rows with observation)`)
  lines.push('')
  lines.push('suppressionReason distribution (`(none — wouldFire)` = редовете, където Rule E2 реално би fired):')
  for (const [k, v] of Object.entries(oc.suppressionReasonCounts)) lines.push(`- ${k}: ${v} (${pct(v, bc.rowsWithObservation)})`)
  lines.push('')
  lines.push('signalSuit distribution (само където сигнал е детектиран):')
  if (Object.keys(oc.signalSuitCounts).length === 0) lines.push('- (няма)')
  for (const [k, v] of Object.entries(oc.signalSuitCounts)) lines.push(`- ${k}: ${v}`)
  lines.push('')
  lines.push('signalType distribution:')
  if (Object.keys(oc.signalTypeCounts).length === 0) lines.push('- (няма)')
  for (const [k, v] of Object.entries(oc.signalTypeCounts)) lines.push(`- ${k}: ${v}`)
  lines.push('')
  lines.push('signalConfidence buckets (само където сигнал е детектиран):')
  for (const bucket of ['<0.5', '0.5-0.69', '0.7-0.84', '>=0.85']) lines.push(`- ${bucket}: ${oc.confidenceBuckets[bucket] ?? 0}`)
  lines.push('')
  lines.push('suggestedCard distribution (само wouldFire=true редове):')
  if (Object.keys(oc.suggestedCardCounts).length === 0) lines.push('- (няма — wouldFire никога не е true в тази извадка)')
  for (const [k, v] of Object.entries(oc.suggestedCardCounts)) lines.push(`- ${k}: ${v}`)
  lines.push('')

  lines.push('## 3. Difference analysis')
  lines.push('')
  lines.push(`- wouldDifferFromFinal: ${da.wouldDifferFromFinalCount} (${pct(da.wouldDifferFromFinalCount, bc.rowsWithObservation)})`)
  lines.push(`- wouldDifferFromConventional: ${da.wouldDifferFromConventionalCount} (${pct(da.wouldDifferFromConventionalCount, bc.rowsWithObservation)})`)
  lines.push(`- wouldDifferFromAdvisorV0: ${da.wouldDifferFromAdvisorV0Count} (${pct(da.wouldDifferFromAdvisorV0Count, bc.rowsWithObservation)})`)
  lines.push(`- wouldFire AND wouldDifferFromFinal: ${da.wouldFireAndDifferFromFinal}`)
  lines.push(`- wouldFire AND same as final: ${da.wouldFireAndSameAsFinal}`)
  lines.push(`- wouldFire AND same as conventional: ${da.wouldFireAndSameAsConventional}`)
  lines.push(`- wouldFire AND different from conventional: ${da.wouldFireAndDifferFromConventional}`)
  lines.push('')

  lines.push('## 4. Safety analysis')
  lines.push('')
  lines.push(`- suggestionInLegalCards=false count: ${sa.suggestionInLegalCardsFalseCount} (трябва да е 0)`)
  lines.push(`- suggestionInOwnHand=false count: ${sa.suggestionInOwnHandFalseCount} (трябва да е 0)`)
  lines.push(`- invalid/missing suggestedCard when wouldFire=true: ${sa.invalidOrMissingSuggestedCardWhenFired} (трябва да е 0)`)
  lines.push(`- forced_card with wouldFire=true: ${sa.forcedCardWithWouldFireTrue} (трябва да е 0)`)
  lines.push(`- observation error field count: ${sa.observationErrorCount}`)
  lines.push(`- impossible state count (wouldFire/suppressionReason contradiction): ${sa.impossibleStateCount} (трябва да е 0)`)
  if (sa.impossibleStateExamples.length > 0) {
    lines.push('  Примери:')
    for (const ex of sa.impossibleStateExamples) lines.push(`  - ${ex}`)
  }
  lines.push('')

  lines.push('## 5. Context breakdowns')
  lines.push('')
  lines.push('gameMode:')
  for (const [k, v] of Object.entries(cb.gameModeCounts)) lines.push(`- ${k}: ${v}`)
  lines.push('')
  lines.push('positionInTrick:')
  for (const [k, v] of Object.entries(cb.positionInTrickCounts)) lines.push(`- ${k}: ${v}`)
  lines.push(`- lead: ${cb.leadCount}, follow: ${cb.followCount}, unknown: ${cb.leadFollowUnknownCount}`)
  lines.push('')
  lines.push('pointsInTrick buckets:')
  for (const bucket of ['0', '1-9', '10+']) lines.push(`- ${bucket}: ${cb.pointsInTrickBuckets[bucket] ?? 0}`)
  lines.push('')
  lines.push('partnerCurrentlyWinning:')
  for (const [k, v] of Object.entries(cb.partnerCurrentlyWinningCounts)) lines.push(`- ${k}: ${v}`)
  lines.push('')
  lines.push('opponentCurrentlyWinning:')
  for (const [k, v] of Object.entries(cb.opponentCurrentlyWinningCounts)) lines.push(`- ${k}: ${v}`)
  lines.push('')
  lines.push(`- Final card same suit as signal: same=${cb.finalCardSameSuitAsSignal.same}, different=${cb.finalCardSameSuitAsSignal.different}, n/a=${cb.finalCardSameSuitAsSignal.notApplicable}`)
  lines.push(`- Conventional card same suit as signal: same=${cb.conventionalCardSameSuitAsSignal.same}, different=${cb.conventionalCardSameSuitAsSignal.different}, n/a=${cb.conventionalCardSameSuitAsSignal.notApplicable}`)
  lines.push(`- Advisor v0 card same suit as signal: ${cb.advisorV0CardSameSuitAsSignal}`)
  lines.push('')

  lines.push('## 6. Practical judgement')
  lines.push('')
  lines.push('**Measurable facts from trace:**')
  lines.push('')
  lines.push(`- Rule E2 би fired в ${oc.wouldFireCount}/${bc.rowsWithObservation} наблюдавани решения (${pct(oc.wouldFireCount, bc.rowsWithObservation)}).`)
  lines.push(`- От тези wouldFire=true случаи, ${da.wouldFireAndDifferFromFinal} (${pct(da.wouldFireAndDifferFromFinal, oc.wouldFireCount)} от wouldFire) биха избрали различна карта от реално изиграната.`)
  lines.push(`- Safety инварианти (suggestion ∈ legalCards ∩ ownHand, forced_card никога с wouldFire=true, wouldFire/suppressionReason непротиворечиви): ${sa.suggestionInLegalCardsFalseCount + sa.suggestionInOwnHandFalseCount + sa.forcedCardWithWouldFireTrue + sa.impossibleStateCount === 0 ? 'ВСИЧКИ издържани, 0 нарушения' : 'НАРУШЕНИ — виж safety analysis по-горе'}.`)
  lines.push('')
  lines.push('**Inferred risk (без human ground truth, не е "коректност"):**')
  lines.push('')
  lines.push('- Този trace няма human ground truth за exact-card accuracy — `wouldFire=true` НЕ означава "правилен избор", само означава "сигналът и non-suppression условията са изпълнени по дефинираната Rule E2 логика".')
  lines.push('- Ниска fire rate + доминиращ `no_partner_signal`/`not_applicable` suppression предполага, че повечето тричкове в тази 3-игрова извадка просто нямат ясен partner signal (очаквано — нужен е предходен трик с ясен suit lead от партньора).')
  lines.push('')
  lines.push('**Offline-evaluator comparison:**')
  lines.push('')
  lines.push('- Офлайн evaluator (`evaluate:rule-e2-signal-advisor`) показа за `e2_no_point_feed`: advisor v0 baseline ~52.0% → v0+e2_no_point_feed 53.1% (+205/18299), red-flag rate 30.9% — измерено срещу реални човешки избори в голям dataset.')
  lines.push('- Local beta trace-ът (840 решения, 3 игри) е твърде малък и БЕЗ human ground truth, за да потвърди или отхвърли директно тези офлайн проценти — може само да провери дали структурното поведение (fire rate, suppression разпределение, safety) изглежда съгласувано с офлайн логиката, не да пресметне собствена accuracy/red-flag rate.')
  lines.push('')
  lines.push('**Recommendation:**')
  lines.push('')
  if (sa.suggestionInLegalCardsFalseCount + sa.suggestionInOwnHandFalseCount + sa.forcedCardWithWouldFireTrue + sa.impossibleStateCount > 0) {
    lines.push('- ⚠ Safety нарушения открити в trace-а — не продължавай към guarded runtime beta, преди да се разследва причината.')
  } else if (oc.wouldFireCount === 0) {
    lines.push('- Rule E2 нито веднъж не е fired в тази извадка (0 wouldFire=true) — извадката е твърде малка/еднообразна за практическа преценка. Препоръка: събери повече local beta игри (повече ръце с ясен partner suit signal) преди да се прави каквато и да е runtime препоръка.')
  } else {
    lines.push('- Safety инвариантите са чисти (0 нарушения) и структурното поведение изглежда съгласувано с офлайн логиката. Извадката (840 решения / 3 игри) обаче остава твърде малка за самостоятелно потвърждение на офлайн процентите. Препоръка: продължи да събираш local beta observational trace данни (повече игри) преди решение за guarded runtime beta mode — все още не е достатъчно за такава стъпка само на база тази извадка.')
  }
  lines.push('')

  lines.push('## Изходни файлове')
  lines.push('')
  lines.push(`- \`${r.tracePath}\` (input, generated от runtime trace)`)
  lines.push(`- \`training-output/local-ai-beta/rule-e2-observation-trace-report.json\``)
  lines.push(`- \`training-output/local-ai-beta/rule-e2-observation-trace-report.md\``)
  lines.push('')

  return lines.join('\n')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  Rule E2 Observational Trace — Analyzer (локален, read-only)')
  console.log('─────────────────────────────────────────')

  const args = process.argv.slice(2)
  const tracePath = args.find((a) => !a.startsWith('-')) ?? (process.env['LOCAL_AI_RULE_E2_OBSERVATION_TRACE_PATH']?.trim() || DEFAULT_TRACE_PATH)

  let content: string
  try {
    content = await readFile(tracePath, 'utf8')
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      console.log(`Trace файл не е намерен: ${tracePath}`)
      console.log('Няма записани observation decisions все още — пусни локална beta игра с LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED=true първо.')
      process.exit(0)
      return
    }
    console.error(`FATAL: не мога да прочета trace файла (${tracePath}): ${err.message}`)
    process.exit(2)
    return
  }

  console.log(`Чета: ${tracePath}`)

  // ─── Privacy scan на input-а, преди каквато и да е обработка ────────────────
  const inputViolations = await scanAllForbiddenContent(tracePath)
  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в trace файла — анализ СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  const rawLineCount = content.split('\n').filter((l, idx, arr) => !(idx === arr.length - 1 && l.trim() === '')).length
  const { rows, parseErrors } = parseJsonlTolerant(content)

  if (parseErrors.length > 0) {
    console.warn(`\n⚠ ${parseErrors.length} parse грешки в trace-а (пропуснати, анализът продължава):`)
    for (const e of parseErrors.slice(0, 50)) console.warn(`  ${e}`)
    if (parseErrors.length > 50) console.warn(`  ... и още ${parseErrors.length - 50}`)
  }

  const report = computeRuleE2ObservationReport(rows, parseErrors.length, rawLineCount, tracePath)

  await mkdir(TRACE_DIR, { recursive: true })
  await writeFile(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8')
  await writeFile(REPORT_MD_PATH, renderMarkdown(report), 'utf8')

  // ─── Privacy re-scan на generated report-а ──────────────────────────────────
  const outputViolations = [
    ...(await scanAllForbiddenContent(REPORT_JSON_PATH)),
    ...(await scanAllForbiddenContent(REPORT_MD_PATH)),
  ]
  if (outputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в generated report — намерени ${outputViolations.length}:\n`)
    for (const v of outputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  console.log('\n─────────────────────────────────────────')
  console.log('  Резултат')
  console.log('─────────────────────────────────────────')
  console.log(`  Total rows: ${report.basicCounts.totalJsonlRows}, parse errors: ${report.basicCounts.parseErrorCount}, valid: ${report.basicCounts.validRows}`)
  console.log(`  Rows with observation: ${report.basicCounts.rowsWithObservation}, without: ${report.basicCounts.rowsWithoutObservation}`)
  console.log(`  wouldFire: ${report.observationCounts.wouldFireCount} (${pct(report.observationCounts.wouldFireCount, report.basicCounts.rowsWithObservation)})`)
  console.log(`  Safety violations: ${report.safetyAnalysis.suggestionInLegalCardsFalseCount + report.safetyAnalysis.suggestionInOwnHandFalseCount + report.safetyAnalysis.forcedCardWithWouldFireTrue + report.safetyAnalysis.impossibleStateCount}`)
  console.log(`\n✓ Отчет: ${REPORT_MD_PATH}`)
  console.log(`✓ Отчет: ${REPORT_JSON_PATH}`)
  console.log('\n✓ Анализ завършен успешно.\n')
  process.exit(0)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error('Unexpected error:', e)
    process.exit(2)
  })
}
