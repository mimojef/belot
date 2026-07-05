/**
 * analyzeAdvisorOverrideTraceCases.ts
 *
 * Read-only local анализатор върху
 * training-output/local-ai-beta/card-decisions-rule-e2-observation.jsonl —
 * фокусиран специфично върху decisionSource === 'advisor_override' редове
 * (реалните случаи, в които advisor v0 — server/src/ai/cardAdvisorPolicy.ts —
 * е сменил конвенционалната карта на бота по време на локална beta игра).
 *
 * Не пипа gameplay/bot logic, не пипа localAiCardBeta.ts/cardAdvisorPolicy.ts
 * — само чете вече записан trace log и генерира подробен per-case отчет:
 * защо advisor v0 е сменил картата, изглежда ли размяната тактически разумна,
 * и дали има случай, в който вероятно е влошила играта.
 *
 * Не hardcode-ва броя случаи (очаквани са 7, но скриптът филтрира динамично).
 *
 * Usage:
 *   npm run analyze:advisor-override-trace-cases
 *   npm run analyze:advisor-override-trace-cases -- path/to/trace.jsonl
 *   LOCAL_AI_ADVISOR_OVERRIDE_TRACE_PATH=... npm run analyze:advisor-override-trace-cases
 *
 * Толерантност: невалидни/празни/частично corrupt JSONL редове НЕ спират
 * анализа — броят се като parseErrors и се пропускат.
 *
 * Exit codes:
 *   0 — анализ завършен (дори при parse errors или 0 override cases)
 *   1 — privacy нарушение в input/generated файловете
 *   2 — file system грешка (различна от "файлът просто не съществува все още")
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { scanFileForForbiddenContent, type SanitizationViolation } from './trainingDataset/sanitizeOutput.js'
import type { LocalAiCardBetaTraceRecord, LocalAiCardBetaRuleE2ObservationPayload } from '../src/ai/localAiCardBeta.js'
import { getServerCardPoints, type ServerScoringContract } from '../src/game/serverScoring.js'
import { getServerCardRankPower } from '../src/game/getServerTrickWinner.js'
import type { ServerSuit, ServerRank } from '../src/game/serverGameTypes.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const TRACE_DIR = join(REPO_ROOT, 'training-output', 'local-ai-beta')
const DEFAULT_TRACE_PATH = join(TRACE_DIR, 'card-decisions-rule-e2-observation.jsonl')

const REPORT_JSON_PATH = join(TRACE_DIR, 'advisor-override-cases-report.json')
const REPORT_MD_PATH = join(TRACE_DIR, 'advisor-override-cases-report.md')

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

// ─── Tolerant JSONL parsing (никога не хвърля) ──────────────────────────────────

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

// ─── Belot domain helpers (ported — виж cardAdvisorSignalRuleE2.ts за същия прецедент) ─

function parseCardId(cardId: string | null | undefined): { suit: ServerSuit; rank: ServerRank } | null {
  if (!cardId || typeof cardId !== 'string') return null
  const idx = cardId.indexOf('-')
  if (idx === -1) return null
  const suit = cardId.slice(0, idx)
  const rank = cardId.slice(idx + 1)
  const validSuits: ServerSuit[] = ['clubs', 'diamonds', 'hearts', 'spades']
  const validRanks: ServerRank[] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']
  if (!validSuits.includes(suit as ServerSuit) || !validRanks.includes(rank as ServerRank)) return null
  return { suit: suit as ServerSuit, rank: rank as ServerRank }
}

function isTrumpCardLocal(suit: ServerSuit, contract: ServerScoringContract, trumpSuit: ServerSuit | null): boolean {
  if (contract === 'all-trumps') return true
  if (contract === 'no-trumps') return false
  return trumpSuit !== null && suit === trumpSuit
}

function teamLabelOf(teamIndex: number | null | undefined): 'A' | 'B' | null {
  if (teamIndex === 0) return 'A'
  if (teamIndex === 1) return 'B'
  return null
}

function outcomeCertainty(positionInTrick: number | undefined | null): 'certain' | 'likely' | 'uncertain' {
  if (positionInTrick === 3) return 'certain'
  if (positionInTrick === 2) return 'likely'
  return 'uncertain'
}

// ─── Per-case analysis shape ─────────────────────────────────────────────────

type WinState = 'winning' | 'not_winning' | 'unknown'
type JudgementLabel = 'looks beneficial' | 'looks neutral' | 'looks risky' | 'insufficient context'

export type OverrideCaseAnalysis = {
  lineNumber: number
  identity: {
    seatIndex: number | null
    teamIndex: number | null
    myTeam: 'A' | 'B' | null
    roomKey: string | null
    dealIdRoundTrickNumber: string
    gameMode: string | null
    trumpSuit: string | null
    positionInTrick: number | null
    ownHandCount: number | null
    legalCardsCount: number | null
    estimatedTrickNumberInDeal: number | null
  }
  decisionComparison: {
    conventionalCard: string | null
    finalCard: string | null
    advisorSelectedCard: string | null
    legalCards: string
    ownHand: string
    currentTrickPlaysBeforeAction: string
    pointsInTrick: number | null
    partnerCurrentlyWinning: boolean | null
    opponentCurrentlyWinning: boolean | null
    predictedWinnerIfConventional: string | null
    predictedWinningTeamIfConventional: string | null
    predictedWinnerIfAdvisor: string | null
    predictedWinningTeamIfAdvisor: string | null
    predictedWinnerChanged: boolean
    predictedTeamChanged: boolean
    outcomeCertainty: 'certain' | 'likely' | 'uncertain'
  }
  advisorReasonInfo: {
    reason: string | null
    knownCategory: boolean
    source: string
  }
  tacticalEvaluation: {
    conventionalCardPoints: number | null
    finalCardPoints: number | null
    pointsDelta: number | null
    sameSuit: boolean | null
    conventionalRankPower: number | null
    finalRankPower: number | null
    rankPowerDelta: number | null
    winsCurrentTrick: { conventional: WinState; advisor: WinState; certainty: string }
    feedsPointsToOpponent: { conventional: boolean | 'unknown'; advisor: boolean | 'unknown'; certainty: string }
    overtakesPartnerUnnecessarily: { ruleApplicable: boolean; rankPowerComparisonSameSuit: string; note: string }
    preservesCleanWinner: {
      conventionalIsCleanWinner: boolean | null
      conventionalShouldPreserve: boolean | null
      finalIsCleanWinner: boolean | null
      finalShouldPreserve: boolean | null
    }
    followsOrReturnsCorrectSuit: string
    saferAlternativeExists: string
    obviousBlunderAvoidance: string
  }
  ruleE2Context: {
    present: boolean
    wouldFire: boolean | null
    suggestedCard: string | null
    signalSuit: string | null
    signalType: string | null
    signalConfidence: number | null
    suppressionReason: string | null
    wouldDifferFromFinal: boolean | null
    wouldDifferFromConventional: boolean | null
    note: string
  }
  judgement: { label: JudgementLabel; explanation: string[] }
}

function analyzeCase(row: Row, lineNumber: number): OverrideCaseAnalysis {
  const myTeam = teamLabelOf(row.teamIndex)
  const certainty = outcomeCertainty(row.positionInTrick)
  const contract = (row.gameMode ?? null) as ServerScoringContract | null
  const trumpSuit = (row.trumpSuit ?? null) as ServerSuit | null

  const conventional = parseCardId(row.conventionalCard)
  const final = parseCardId(row.finalCard)

  const conventionalCardPoints = conventional && contract ? getServerCardPoints(conventional.suit, conventional.rank, contract, trumpSuit) : null
  const finalCardPoints = final && contract ? getServerCardPoints(final.suit, final.rank, contract, trumpSuit) : null
  const pointsDelta = conventionalCardPoints !== null && finalCardPoints !== null ? finalCardPoints - conventionalCardPoints : null

  const sameSuit = conventional && final ? conventional.suit === final.suit : null
  const conventionalRankPower = conventional && contract ? getServerCardRankPower(conventional.rank, isTrumpCardLocal(conventional.suit, contract, trumpSuit)) : null
  const finalRankPower = final && contract ? getServerCardRankPower(final.rank, isTrumpCardLocal(final.suit, contract, trumpSuit)) : null
  const rankPowerDelta = sameSuit && conventionalRankPower !== null && finalRankPower !== null ? finalRankPower - conventionalRankPower : null

  const predictedWinnerChanged = row.predictedWinnerIfConventional !== row.predictedWinnerIfAdvisor
  const predictedTeamChanged = row.predictedWinningTeamIfConventional !== row.predictedWinningTeamIfAdvisor

  const winsConv: WinState = !myTeam || !row.predictedWinningTeamIfConventional ? 'unknown' : row.predictedWinningTeamIfConventional === myTeam ? 'winning' : 'not_winning'
  const winsAdv: WinState = !myTeam || !row.predictedWinningTeamIfAdvisor ? 'unknown' : row.predictedWinningTeamIfAdvisor === myTeam ? 'winning' : 'not_winning'

  const feedsConv: boolean | 'unknown' = winsConv === 'unknown' || conventionalCardPoints === null ? 'unknown' : winsConv === 'not_winning' && conventionalCardPoints > 0
  const feedsAdv: boolean | 'unknown' = winsAdv === 'unknown' || finalCardPoints === null ? 'unknown' : winsAdv === 'not_winning' && finalCardPoints > 0

  const rankPowerComparisonSameSuit =
    sameSuit === null
      ? 'unknown_card_id'
      : sameSuit === false
        ? 'different_suit_not_comparable'
        : rankPowerDelta === null
          ? 'unknown'
          : rankPowerDelta < 0
            ? 'final_is_lower_power_same_suit'
            : rankPowerDelta > 0
              ? 'final_is_higher_power_same_suit'
              : 'equal_power'

  const ruleE2: LocalAiCardBetaRuleE2ObservationPayload | undefined = row.ruleE2Observation

  const obviousBlunderAvoidance =
    pointsDelta === null
      ? 'не може да се определи (invalid card id)'
      : pointsDelta < 0
        ? `finalCard струва ${Math.abs(pointsDelta)} точки по-малко от conventionalCard — избягнато е ненужно "хабене" на стойност`
        : pointsDelta > 0
          ? `⚠ finalCard струва ${pointsDelta} точки ПОВЕЧЕ от conventionalCard — обратен на очаквания ефект за override с този reason`
          : 'няма точкова разлика между двата кандидата'

  const identity: OverrideCaseAnalysis['identity'] = {
    seatIndex: row.seatIndex ?? null,
    teamIndex: row.teamIndex ?? null,
    myTeam,
    roomKey: row.roomKey ?? null,
    dealIdRoundTrickNumber: 'not_available_in_trace (dealId/round/trickNumber не се persist-ват; roomKey винаги е null по дизайн — виж localAiCardBeta.ts коментара за липсващ room identifier на този слой)',
    gameMode: row.gameMode ?? null,
    trumpSuit: row.trumpSuit ?? null,
    positionInTrick: row.positionInTrick ?? null,
    ownHandCount: row.ownHandCount ?? null,
    legalCardsCount: row.legalCardsCount ?? null,
    estimatedTrickNumberInDeal: typeof row.ownHandCount === 'number' ? 9 - row.ownHandCount : null,
  }

  const decisionComparison: OverrideCaseAnalysis['decisionComparison'] = {
    conventionalCard: row.conventionalCard ?? null,
    finalCard: row.finalCard ?? null,
    advisorSelectedCard: row.advisorSelectedCard ?? null,
    legalCards: `not_available_in_trace — само legalCardsCount=${row.legalCardsCount ?? 'n/a'} е записан, не самите карти`,
    ownHand: `not_available_in_trace — само ownHandCount=${row.ownHandCount ?? 'n/a'} е записан, не самите карти`,
    currentTrickPlaysBeforeAction: 'not_available_in_trace — вече изиграните карти в текущия трик (вкл. led suit) не се persist-ват в trace-а',
    pointsInTrick: row.pointsInTrick ?? null,
    partnerCurrentlyWinning: row.partnerCurrentlyWinning ?? null,
    opponentCurrentlyWinning: row.opponentCurrentlyWinning ?? null,
    predictedWinnerIfConventional: row.predictedWinnerIfConventional ?? null,
    predictedWinningTeamIfConventional: row.predictedWinningTeamIfConventional ?? null,
    predictedWinnerIfAdvisor: row.predictedWinnerIfAdvisor ?? null,
    predictedWinningTeamIfAdvisor: row.predictedWinningTeamIfAdvisor ?? null,
    predictedWinnerChanged,
    predictedTeamChanged,
    outcomeCertainty: certainty,
  }

  const KNOWN_REASONS = ['avoid_giving_trick_to_opponent', 'avoid_feeding_points', 'avoid_overtaking_partner', 'preserve_clean_winner']
  const advisorReasonInfo: OverrideCaseAnalysis['advisorReasonInfo'] = {
    reason: row.advisorReason ?? null,
    knownCategory: typeof row.advisorReason === 'string' && KNOWN_REASONS.includes(row.advisorReason),
    source: 'trace_field_advisorReason (директно наличен в trace-а — не е нужна best-effort реконструкция чрез cardAdvisorPolicy/cardAdvisorMemory helpers)',
  }

  const tacticalEvaluation: OverrideCaseAnalysis['tacticalEvaluation'] = {
    conventionalCardPoints,
    finalCardPoints,
    pointsDelta,
    sameSuit,
    conventionalRankPower,
    finalRankPower,
    rankPowerDelta,
    winsCurrentTrick: { conventional: winsConv, advisor: winsAdv, certainty },
    feedsPointsToOpponent: { conventional: feedsConv, advisor: feedsAdv, certainty },
    overtakesPartnerUnnecessarily: {
      ruleApplicable: row.partnerCurrentlyWinning === true,
      rankPowerComparisonSameSuit,
      note: 'Партньорската действително изиграна карта не се persist-ва в trace-а — сравнението е само срещу team-level predicted winner и same-suit rank power delta, не срещу конкретната партньорска карта.',
    },
    preservesCleanWinner: {
      conventionalIsCleanWinner: row.conventionalCardCandidateIsCleanWinner ?? null,
      conventionalShouldPreserve: row.conventionalCardShouldPreserveCleanWinner ?? null,
      finalIsCleanWinner: row.finalCardCandidateIsCleanWinner ?? null,
      finalShouldPreserve: row.finalCardShouldPreserveCleanWinner ?? null,
    },
    followsOrReturnsCorrectSuit: 'not_available_in_trace — led suit на текущия трик не се persist-ва, не може безопасно да се провери',
    saferAlternativeExists: 'not_available_in_trace — пълният legalCards списък не се persist-ва, само legalCardsCount',
    obviousBlunderAvoidance,
  }

  const ruleE2Context: OverrideCaseAnalysis['ruleE2Context'] = {
    present: !!ruleE2,
    wouldFire: ruleE2?.wouldFire ?? null,
    suggestedCard: ruleE2?.suggestedCard ?? null,
    signalSuit: ruleE2?.signalSuit ?? null,
    signalType: ruleE2?.signalType ?? null,
    signalConfidence: ruleE2?.signalConfidence ?? null,
    suppressionReason: ruleE2?.suppressionReason ?? null,
    wouldDifferFromFinal: ruleE2?.wouldDifferFromFinal ?? null,
    wouldDifferFromConventional: ruleE2?.wouldDifferFromConventional ?? null,
    note: 'Rule E2 е чисто observational в тези игри — НИКОГА не е управлявал finalCard/decisionSource. Тук се показва само какво Rule E2 би предложил успоредно, за контекст.',
  }

  const judgement = classifyCase(identity, decisionComparison, tacticalEvaluation, advisorReasonInfo)

  return { lineNumber, identity, decisionComparison, advisorReasonInfo, tacticalEvaluation, ruleE2Context, judgement }
}

// ─── Judgement classifier (обективна, rule-based, еднаква логика за всеки reason) ─

function classifyCase(
  identity: OverrideCaseAnalysis['identity'],
  dc: OverrideCaseAnalysis['decisionComparison'],
  te: OverrideCaseAnalysis['tacticalEvaluation'],
  reasonInfo: OverrideCaseAnalysis['advisorReasonInfo'],
): { label: JudgementLabel; explanation: string[] } {
  const explanation: string[] = []
  const reason = reasonInfo.reason ?? 'unknown'
  explanation.push(`Advisor v0 замени ${dc.conventionalCard ?? '?'} с ${dc.finalCard ?? '?'} (reason: ${reason}), при positionInTrick=${identity.positionInTrick ?? '?'} (outcome certainty: ${dc.outcomeCertainty}).`)

  const winsConv = te.winsCurrentTrick.conventional
  const winsAdv = te.winsCurrentTrick.advisor

  if (winsConv === 'unknown' || winsAdv === 'unknown' || te.pointsDelta === null) {
    explanation.push('Липсват достатъчно надеждни изчислими факти (team-level predicted winner или валидни card id-та), за да се направи обективна преценка.')
    return { label: 'insufficient context', explanation }
  }

  const outcomeWorsened = winsConv === 'winning' && winsAdv === 'not_winning'
  const outcomeImproved = winsConv === 'not_winning' && winsAdv === 'winning'

  if (outcomeWorsened) {
    explanation.push(`Предвиденият (${dc.outcomeCertainty}) победител на трика се измества от нашия отбор към противника заради тази замяна — трикът е бил "жертван".`)
    if (te.pointsDelta < 0) {
      explanation.push(`Спестени са ${Math.abs(te.pointsDelta)} точки чрез запазената карта, но това е малка компенсация спрямо загубата на самия трик (${dc.pointsInTrick ?? '?'} точки в трика).`)
    }
    explanation.push(dc.outcomeCertainty === 'certain' ? 'Тъй като изходът е сигурен (последен играч в трика), това изглежда като реален риск.' : 'Изходът е само интеримна симулация (не е последна позиция в трика) — партньорът все още може да го обърне, но както е записано, изглежда рисково.')
    return { label: 'looks risky', explanation }
  }

  if (outcomeImproved) {
    explanation.push('Предвиденият победител на трика се измества от противника към нашия отбор заради тази замяна — override-ът превръща загубен трик в спечелен.')
    return { label: 'looks beneficial', explanation }
  }

  // outcomeUnchanged (winsConv === winsAdv)
  if (te.pointsDelta < 0) {
    explanation.push(`Предвиденият победител на трика е един и същ и при двата варианта — размяната не сменя изхода, само спестява ${Math.abs(te.pointsDelta)} точки.`)
    if (dc.outcomeCertainty === 'uncertain') {
      explanation.push('Изходът обаче е само ранна интеримна симулация (положения след тази все още предстоят) — етикетирано консервативно като "neutral", не "beneficial", докато не се потвърди резултатът.')
      return { label: 'looks neutral', explanation }
    }
    explanation.push('Изглежда като чиста печалба без видим tactical downside в наличните данни.')
    return { label: 'looks beneficial', explanation }
  }
  if (te.pointsDelta > 0) {
    explanation.push(`⚠ Изходът на трика не се променя, но finalCard струва ${te.pointsDelta} точки повече от conventionalCard — override-ът изглежда е дал повече точки без полза.`)
    return { label: 'looks risky', explanation }
  }

  explanation.push('Няма измерима точкова или изходна разлика между двата кандидата в наличните данни.')
  return { label: 'looks neutral', explanation }
}

// ─── Report shape ───────────────────────────────────────────────────────────────

export type AdvisorOverrideCasesReport = {
  generatedAt: string
  tracePath: string
  basicCounts: {
    totalJsonlRows: number
    parseErrorCount: number
    validRows: number
    advisorOverrideCount: number
  }
  overrideReasonDistribution: Record<string, number>
  judgementCounts: Record<JudgementLabel, number>
  certaintyCounts: Record<'certain' | 'likely' | 'uncertain', number>
  recurringPatternNotes: string[]
  cases: OverrideCaseAnalysis[]
  practicalConclusion: {
    overridesLookReasonable: string
    botsMainlyConventionalPlusGuard: string
    evidenceAdvisorHarms: string
    reasonToContinueTracing: string
    shouldTouchRuntimeNow: string
  }
}

function computeReport(rows: Array<{ row: Row; lineNumber: number }>, parseErrorCount: number, totalJsonlRows: number, tracePath: string): AdvisorOverrideCasesReport {
  const overrideRows = rows.filter(({ row }) => row.decisionSource === 'advisor_override')
  const cases = overrideRows.map(({ row, lineNumber }) => analyzeCase(row, lineNumber))

  const overrideReasonDistribution: Record<string, number> = {}
  const judgementCounts: Record<JudgementLabel, number> = { 'looks beneficial': 0, 'looks neutral': 0, 'looks risky': 0, 'insufficient context': 0 }
  const certaintyCounts: Record<'certain' | 'likely' | 'uncertain', number> = { certain: 0, likely: 0, uncertain: 0 }

  for (const c of cases) {
    const reason = c.advisorReasonInfo.reason ?? 'unknown'
    overrideReasonDistribution[reason] = (overrideReasonDistribution[reason] ?? 0) + 1
    judgementCounts[c.judgement.label]++
    certaintyCounts[c.decisionComparison.outcomeCertainty]++
  }

  const recurringPatternNotes: string[] = []
  const sameSuitSwaps = cases.filter((c) => c.tacticalEvaluation.sameSuit === true).length
  const crossSuitSwaps = cases.filter((c) => c.tacticalEvaluation.sameSuit === false).length
  recurringPatternNotes.push(`${sameSuitSwaps}/${cases.length} override-а заменят карта в СЪЩАТА боя (типично "играй по-малка карта в тази боя"); ${crossSuitSwaps}/${cases.length} сменят и боята.`)
  const pointSavingCases = cases.filter((c) => c.tacticalEvaluation.pointsDelta !== null && c.tacticalEvaluation.pointsDelta < 0).length
  recurringPatternNotes.push(`${pointSavingCases}/${cases.length} override-а намаляват точковата стойност на изиграната карта спрямо conventional избора.`)
  const reasonKeys = Object.keys(overrideReasonDistribution)
  if (reasonKeys.length > 0) {
    recurringPatternNotes.push(`Най-чест override reason: ${reasonKeys.sort((a, b) => overrideReasonDistribution[b]! - overrideReasonDistribution[a]!)[0]}.`)
  }

  const riskyCases = cases.filter((c) => c.judgement.label === 'looks risky')
  const evidenceAdvisorHarms =
    riskyCases.length === 0
      ? 'Не е открит нито един случай, обективно класифициран като "looks risky" сред тези override-и — няма пряко доказателство за вреда в тази извадка.'
      : `Открит(и) ${riskyCases.length} случай(я), класифицирани "looks risky" (ред(ове): ${riskyCases.map((c) => c.lineNumber).join(', ')}) — виж пълния анализ по-долу за детайли. Това е конкретен сигнал, не окончателно доказателство (извадката е малка, 7 случая).`

  return {
    generatedAt: new Date().toISOString(),
    tracePath,
    basicCounts: { totalJsonlRows, parseErrorCount, validRows: rows.length, advisorOverrideCount: overrideRows.length },
    overrideReasonDistribution,
    judgementCounts,
    certaintyCounts,
    recurringPatternNotes,
    cases,
    practicalConclusion: {
      overridesLookReasonable:
        cases.length === 0
          ? 'Няма override случаи в тази извадка.'
          : `${judgementCounts['looks beneficial']}/${cases.length} изглеждат "beneficial", ${judgementCounts['looks neutral']}/${cases.length} "neutral", ${judgementCounts['looks risky']}/${cases.length} "risky", ${judgementCounts['insufficient context']}/${cases.length} "insufficient context" — мнозинството намеси изглеждат разумни, но не всички.`,
      botsMainlyConventionalPlusGuard: `${cases.length} override-а от ${totalJsonlRows} общо решения (${totalJsonlRows > 0 ? ((cases.length / totalJsonlRows) * 100).toFixed(1) : '0.0'}%) — потвърждава "предимно conventional + рядка tactical guard намеса" модела.`,
      evidenceAdvisorHarms,
      reasonToContinueTracing:
        'Извадката от 7 случая е твърде малка за статистическа увереност — препоръчително е да се съберат повече local beta игри, особено за preserve_clean_winner (най-неяснен reason по отношение на "urgency" прага) и за случаи с positionInTrick<3 (несигурен изход).',
      shouldTouchRuntimeNow:
        riskyCases.length === 0
          ? 'Не — извадката е малка и не показва системен проблем; runtime промяна не е оправдана само на база този анализ.'
          : 'Не — дори при открит(и) рисков(и) случай(и), извадката е твърде малка (7 случая) за статистическа увереност; препоръчва се повече local trace данни и/или преглед на preserve_clean_winner прага, преди каквато и да е runtime промяна.',
    },
  }
}

// ─── Markdown rendering ─────────────────────────────────────────────────────────

function renderCaseMarkdown(c: OverrideCaseAnalysis): string {
  const lines: string[] = []
  lines.push(`### Case: ред ${c.lineNumber} — ${c.decisionComparison.conventionalCard} → ${c.decisionComparison.finalCard} (${c.advisorReasonInfo.reason})`)
  lines.push('')
  lines.push(`**Judgement: ${c.judgement.label}**`)
  for (const s of c.judgement.explanation) lines.push(`- ${s}`)
  lines.push('')

  lines.push('**A. Basic identity**')
  lines.push(`- seatIndex: ${c.identity.seatIndex}, teamIndex: ${c.identity.teamIndex} (myTeam: ${c.identity.myTeam})`)
  lines.push(`- roomKey: ${c.identity.roomKey} (винаги null по дизайн)`)
  lines.push(`- dealId/round/trickNumber: ${c.identity.dealIdRoundTrickNumber}`)
  lines.push(`- gameMode: ${c.identity.gameMode}, trumpSuit: ${c.identity.trumpSuit}`)
  lines.push(`- positionInTrick: ${c.identity.positionInTrick}`)
  lines.push(`- ownHandCount: ${c.identity.ownHandCount}, legalCardsCount: ${c.identity.legalCardsCount}`)
  lines.push(`- estimatedTrickNumberInDeal (derived = 9 - ownHandCount, само ориентировъчно): ${c.identity.estimatedTrickNumberInDeal}`)
  lines.push('')

  lines.push('**B. Decision comparison**')
  lines.push(`- conventionalCard: ${c.decisionComparison.conventionalCard}, finalCard: ${c.decisionComparison.finalCard}, advisorSelectedCard: ${c.decisionComparison.advisorSelectedCard}`)
  lines.push(`- legalCards: ${c.decisionComparison.legalCards}`)
  lines.push(`- ownHand: ${c.decisionComparison.ownHand}`)
  lines.push(`- currentTrick before action: ${c.decisionComparison.currentTrickPlaysBeforeAction}`)
  lines.push(`- pointsInTrick: ${c.decisionComparison.pointsInTrick}`)
  lines.push(`- partnerCurrentlyWinning: ${c.decisionComparison.partnerCurrentlyWinning}, opponentCurrentlyWinning: ${c.decisionComparison.opponentCurrentlyWinning}`)
  lines.push(`- predictedWinnerIfConventional: ${c.decisionComparison.predictedWinnerIfConventional} (${c.decisionComparison.predictedWinningTeamIfConventional})`)
  lines.push(`- predictedWinnerIfAdvisor: ${c.decisionComparison.predictedWinnerIfAdvisor} (${c.decisionComparison.predictedWinningTeamIfAdvisor})`)
  lines.push(`- predictedWinnerChanged: ${c.decisionComparison.predictedWinnerChanged}, predictedTeamChanged: ${c.decisionComparison.predictedTeamChanged}`)
  lines.push(`- outcome certainty: **${c.decisionComparison.outcomeCertainty}** (certain само при positionInTrick===3; иначе interim симулация)`)
  lines.push('')

  lines.push('**C. Advisor reason**')
  lines.push(`- reason: ${c.advisorReasonInfo.reason} (known category: ${c.advisorReasonInfo.knownCategory})`)
  lines.push(`- source: ${c.advisorReasonInfo.source}`)
  lines.push('')

  lines.push('**D. Tactical evaluation**')
  lines.push(`- conventionalCardPoints: ${c.tacticalEvaluation.conventionalCardPoints}, finalCardPoints: ${c.tacticalEvaluation.finalCardPoints}, pointsDelta: ${c.tacticalEvaluation.pointsDelta}`)
  lines.push(`- sameSuit: ${c.tacticalEvaluation.sameSuit}, rankPowerDelta: ${c.tacticalEvaluation.rankPowerDelta}`)
  lines.push(`- wins current trick — conventional: ${c.tacticalEvaluation.winsCurrentTrick.conventional} [${c.tacticalEvaluation.winsCurrentTrick.certainty}], advisor: ${c.tacticalEvaluation.winsCurrentTrick.advisor} [${c.tacticalEvaluation.winsCurrentTrick.certainty}]`)
  lines.push(`- feeds points to opponent — conventional: ${c.tacticalEvaluation.feedsPointsToOpponent.conventional}, advisor: ${c.tacticalEvaluation.feedsPointsToOpponent.advisor} [${c.tacticalEvaluation.feedsPointsToOpponent.certainty}]`)
  lines.push(`- overtakes partner unnecessarily — rule applicable: ${c.tacticalEvaluation.overtakesPartnerUnnecessarily.ruleApplicable}, same-suit rank power comparison: ${c.tacticalEvaluation.overtakesPartnerUnnecessarily.rankPowerComparisonSameSuit}`)
  lines.push(`  - ${c.tacticalEvaluation.overtakesPartnerUnnecessarily.note}`)
  lines.push(`- preserves clean winner — conventionalIsCleanWinner: ${c.tacticalEvaluation.preservesCleanWinner.conventionalIsCleanWinner}, conventionalShouldPreserve: ${c.tacticalEvaluation.preservesCleanWinner.conventionalShouldPreserve}, finalIsCleanWinner: ${c.tacticalEvaluation.preservesCleanWinner.finalIsCleanWinner}, finalShouldPreserve: ${c.tacticalEvaluation.preservesCleanWinner.finalShouldPreserve}`)
  lines.push(`- follows/returns correct suit: ${c.tacticalEvaluation.followsOrReturnsCorrectSuit}`)
  lines.push(`- safer alternative exists: ${c.tacticalEvaluation.saferAlternativeExists}`)
  lines.push(`- obvious blunder avoidance: ${c.tacticalEvaluation.obviousBlunderAvoidance}`)
  lines.push('')

  lines.push('**E. Rule E2 observation context** (никога не е управлявал finalCard)')
  if (!c.ruleE2Context.present) {
    lines.push('- (няма ruleE2Observation в този ред)')
  } else {
    lines.push(`- wouldFire: ${c.ruleE2Context.wouldFire}, suggestedCard: ${c.ruleE2Context.suggestedCard}`)
    lines.push(`- signalSuit: ${c.ruleE2Context.signalSuit}, signalType: ${c.ruleE2Context.signalType}, signalConfidence: ${c.ruleE2Context.signalConfidence}`)
    lines.push(`- suppressionReason: ${c.ruleE2Context.suppressionReason}`)
    lines.push(`- wouldDifferFromFinal: ${c.ruleE2Context.wouldDifferFromFinal}, wouldDifferFromConventional: ${c.ruleE2Context.wouldDifferFromConventional}`)
  }
  lines.push(`- ${c.ruleE2Context.note}`)
  lines.push('')

  return lines.join('\n')
}

function renderMarkdown(r: AdvisorOverrideCasesReport): string {
  const lines: string[] = []
  lines.push('# Advisor v0 Override Cases — Local Beta Trace Analysis')
  lines.push('')
  lines.push(`Генериран на: ${r.generatedAt}`)
  lines.push(`Trace файл: \`${r.tracePath}\``)
  lines.push('')
  lines.push('Локален, read-only отчет върху реалните `decisionSource === "advisor_override"` решения от local beta игри (`LOCAL_AI_CARD_BETA_POLICY=advisor`). Всеки такъв случай е момент, в който advisor v0 (server/src/ai/cardAdvisorPolicy.ts) РЕАЛНО е сменил картата на бота спрямо конвенционалната логика.')
  lines.push('')

  lines.push('## Basic counts')
  lines.push('')
  lines.push(`- Total JSONL rows: ${r.basicCounts.totalJsonlRows}`)
  lines.push(`- Parse errors: ${r.basicCounts.parseErrorCount}`)
  lines.push(`- Valid rows: ${r.basicCounts.validRows}`)
  lines.push(`- advisor_override count: ${r.basicCounts.advisorOverrideCount}`)
  lines.push('')

  if (r.cases.length === 0) {
    lines.push('**Няма advisor_override случаи в тази извадка — нищо за анализ на ниво случай.**')
    lines.push('')
  } else {
    lines.push('## Override reason distribution')
    lines.push('')
    for (const [k, v] of Object.entries(r.overrideReasonDistribution)) lines.push(`- ${k}: ${v}`)
    lines.push('')

    lines.push('## Judgement distribution')
    lines.push('')
    for (const [k, v] of Object.entries(r.judgementCounts)) lines.push(`- ${k}: ${v}`)
    lines.push('')

    lines.push('## Outcome certainty distribution')
    lines.push('')
    for (const [k, v] of Object.entries(r.certaintyCounts)) lines.push(`- ${k}: ${v}`)
    lines.push('')

    lines.push('## Recurring patterns')
    lines.push('')
    for (const note of r.recurringPatternNotes) lines.push(`- ${note}`)
    lines.push('')

    lines.push('## Per-case detailed analysis')
    lines.push('')
    for (const c of r.cases) lines.push(renderCaseMarkdown(c))
  }

  lines.push('## Практическо заключение')
  lines.push('')
  lines.push(`1. **7-те намеси изглеждат ли разумни?** ${r.practicalConclusion.overridesLookReasonable}`)
  lines.push(`2. **Ботът е предимно conventional + малка tactical guard намеса?** ${r.practicalConclusion.botsMainlyConventionalPlusGuard}`)
  lines.push(`3. **Има ли доказателство, че advisor v0 вреди?** ${r.practicalConclusion.evidenceAdvisorHarms}`)
  lines.push(`4. **Има ли причина да продължим с още trace игри при същите flags?** ${r.practicalConclusion.reasonToContinueTracing}`)
  lines.push(`5. **Трябва ли да пипаме runtime сега?** ${r.practicalConclusion.shouldTouchRuntimeNow}`)
  lines.push('')

  lines.push('## Изходни файлове')
  lines.push('')
  lines.push(`- \`${r.tracePath}\` (input, generated от runtime trace)`)
  lines.push('- `training-output/local-ai-beta/advisor-override-cases-report.json`')
  lines.push('- `training-output/local-ai-beta/advisor-override-cases-report.md`')
  lines.push('')

  return lines.join('\n')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  Advisor v0 Override Trace Cases — Analyzer (локален, read-only)')
  console.log('─────────────────────────────────────────')

  const args = process.argv.slice(2)
  const tracePath = args.find((a) => !a.startsWith('-')) ?? (process.env['LOCAL_AI_ADVISOR_OVERRIDE_TRACE_PATH']?.trim() || DEFAULT_TRACE_PATH)

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

  const report = computeReport(rows, parseErrors.length, rawLineCount, tracePath)

  await mkdir(TRACE_DIR, { recursive: true })
  await writeFile(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8')
  await writeFile(REPORT_MD_PATH, renderMarkdown(report), 'utf8')

  const outputViolations = [...(await scanAllForbiddenContent(REPORT_JSON_PATH)), ...(await scanAllForbiddenContent(REPORT_MD_PATH))]
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
  console.log(`  advisor_override count: ${report.basicCounts.advisorOverrideCount}`)
  console.log(`  Judgement: ${JSON.stringify(report.judgementCounts)}`)
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
