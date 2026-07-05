/**
 * evaluateCardAdvisor.ts
 *
 * Offline, read-only validation for the new "conventional-first tactical
 * advisor" guard-rule engine (server/src/ai/cardAdvisorPolicy.ts) — run this
 * BEFORE wiring the advisor into the live bot path
 * (server/src/ai/localAiCardBeta.ts). Zero runtime risk: it re-simulates the
 * conventional bot's choice (via pickServerBotPlayCard, read-only, never
 * modified) over validation/test split records, adapts the dataset's
 * ALREADY-COMPUTED memory fields (memory / legalCardsMemoryFeatures, from
 * "Add Belot card memory dataset features") into the engine's plain-data
 * input shape, and runs the exact same decideAdvisorCard() that the runtime
 * wrapper will use — so this offline pass validates the REAL guard-rule
 * logic, not an approximation of it.
 *
 * Reports: override rate (target 5-20% of non-forced decisions), per-rule
 * trigger counts, accuracy vs human chosenCard (conventional-alone vs
 * advisor-adjusted), a red-flag check (advisor overrides a case where the
 * human actually kept the conventional card), and representative examples
 * per rule.
 *
 * Does not train anything, does not touch gameplay/recorder/bot-strategy
 * files, does not commit generated output (training-output/ stays ignored).
 *
 * Usage:
 *   npm run evaluate:card-advisor   (от server/)
 *
 * Exit codes:
 *   0 — успешно
 *   1 — invalid/missing input, privacy нарушение, schema грешка
 *   2 — file system грешка
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseJsonlStrict,
  validateCardRecordV2,
  scanAllForbiddenContent,
  type CardRecordV2,
} from './humanMoveMemoryV2Shared.js'
import { pickServerBotPlayCard } from '../src/game/pickServerBotPlayCard.js'
import { decideAdvisorCard, type AdvisorCandidateMemory, type AdvisorDecisionInput, type AdvisorReason } from '../src/ai/cardAdvisorPolicy.js'
import type { ServerScoringContract } from '../src/game/serverScoring.js'
import type {
  ServerAuthoritativeGameState,
  ServerCard,
  ServerPlayerState,
  ServerSuit,
  ServerTrickPlay,
  ServerWinningBid,
} from '../src/game/serverGameTypes.js'
import type { Seat, Team } from '../src/core/serverTypes.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')
const BASELINE_DIR = join(OUTPUT_DIR, 'baseline')
const REPORT_DIR = join(OUTPUT_DIR, 'card-advisor')

const CARD_PATHS = {
  validation: join(BASELINE_DIR, 'card-validation.jsonl'),
  test: join(BASELINE_DIR, 'card-test.jsonl'),
}
const REPORT_JSON_PATH = join(REPORT_DIR, 'evaluate-card-advisor-report.json')
const REPORT_MD_PATH = join(REPORT_DIR, 'evaluate-card-advisor-report.md')

const OVERRIDE_RATE_TARGET_MIN = 0.05
const OVERRIDE_RATE_TARGET_MAX = 0.20

// ─── Seat/team helpers (small local copy — this project's established convention: ─
// never import seat/partner helpers from pickServerBotPlayCard.ts, see cardMemoryFeatures.ts) ─

const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']
function getPartnerSeat(seat: Seat): Seat {
  return SEAT_ORDER[(SEAT_ORDER.indexOf(seat) + 2) % 4]!
}

// ─── Minimal ServerAuthoritativeGameState reconstruction (same proven pattern ─
// as analyzeAiCardModelWeaknesses.ts's buildMinimalState — re-simulates the
// conventional bot's choice offline, read-only import of pickServerBotPlayCard) ─

function emptyScore() {
  return { teamA: 0, teamB: 0 }
}
function makePlayers(): Record<Seat, ServerPlayerState> {
  const teams: Team[] = ['A', 'B', 'A', 'B']
  return Object.fromEntries(
    SEAT_ORDER.map((s, i) => [s, { seat: s, team: teams[i]!, mode: 'bot' as const, controlledByBot: true }]),
  ) as Record<Seat, ServerPlayerState>
}
function emptyWon(): Record<Seat, ServerCard[][]> {
  return { bottom: [], right: [], top: [], left: [] }
}

function buildMinimalState(r: CardRecordV2): { state: ServerAuthoritativeGameState; seat: Seat } {
  const seat = r.seat as Seat
  const hands: Record<Seat, ServerCard[]> = { bottom: [], right: [], top: [], left: [] }
  hands[seat] = r.ownHand as ServerCard[]
  const winningBid: ServerWinningBid = {
    seat: r.contract.bidderSeat as Seat,
    contract: r.contract.contract,
    trumpSuit: r.contract.trumpSuit as ServerSuit | null,
    doubled: r.contract.doubled,
    redoubled: r.contract.redoubled,
  }
  const plays: ServerTrickPlay[] = r.currentTrick.map((p) => ({ seat: p.seat as Seat, card: p.card as ServerCard }))
  const es = emptyScore()

  const state: ServerAuthoritativeGameState = {
    phase: 'playing',
    phaseEnteredAt: 0,
    targetScore: 151,
    players: makePlayers(),
    round: { dealerSeat: r.dealerSeat as Seat, cutterSeat: null, firstBidderSeat: null, firstDealSeat: null, selectedCutIndex: null },
    deck: [],
    hands,
    bidding: { entries: [], currentSeat: null, winningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    declarations: [],
    matchDeclarationMissionCounts: {
      announce_tersa: es, announce_50: es, announce_100: es, announce_kare: es, announce_belot: es,
    },
    matchDeclarationMissionCountsBySeat: {},
    currentTrick: { leaderSeat: r.leaderSeat as Seat, currentSeat: seat, plays: [], winnerSeat: null, trickIndex: r.trickIndex },
    wonTricks: { A: [], B: [] },
    playing: {
      hasStarted: true,
      currentTurnSeat: seat,
      currentTrick: { leaderSeat: plays[0]?.seat ?? (r.leaderSeat as Seat), currentSeat: seat, plays, winnerSeat: null, trickIndex: r.trickIndex },
      completedTricks: [],
      lastCompletedTrickWinnerSeat: null,
      lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: emptyWon(),
      wonTricksByTeam: { A: [], B: [] },
    },
    scoring: null,
    matchEnded: null,
    score: { round: { tricks: es, declarations: es, belote: es, lastTen: es, capot: es, total: es }, match: { teamA: 0, teamB: 0 }, carryOver: es },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  }

  return { state, seat }
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

type RuleCounts = Record<AdvisorReason, number>
function emptyRuleCounts(): RuleCounts {
  return {
    avoid_giving_trick_to_opponent: 0,
    avoid_feeding_points: 0,
    avoid_overtaking_partner: 0,
    preserve_clean_winner: 0,
  }
}

type EvalOutcome = {
  reason: AdvisorReason | null
  override: boolean
  conventionalMatchesHuman: boolean
  finalMatchesHuman: boolean
  redFlag: boolean // override fired, but human actually kept the conventional card
  positiveSignal: boolean // override fired and moved the pick to match the human's actual choice
  gameMode: string
  positionInTrick: number
  example: {
    gameMode: string
    trumpSuit: string | null
    positionInTrick: number
    pointsInTrick: number
    conventionalCard: string
    advisorCard: string
    humanChosenCard: string
    reason: AdvisorReason
  } | null
}

function evaluateSplit(records: CardRecordV2[]): { outcomes: EvalOutcome[]; skippedNoConventional: number } {
  const outcomes: EvalOutcome[] = []
  let skippedNoConventional = 0

  for (const r of records) {
    if (r.legalCards.length <= 1) continue // forced — no real choice, skip from evaluation denominator

    const { state, seat } = buildMinimalState(r)
    const conventionalCardId = pickServerBotPlayCard(state, seat)?.id ?? null
    if (!conventionalCardId) {
      skippedNoConventional++
      continue
    }
    const conventionalCard = r.legalCards.find((c) => c.id === conventionalCardId) as ServerCard | undefined
    if (!conventionalCard) {
      skippedNoConventional++
      continue
    }

    const candidateMemoryById = new Map<string, AdvisorCandidateMemory>()
    for (const c of r.legalCardsMemoryFeatures) {
      candidateMemoryById.set(c.id, {
        id: c.id,
        candidateIsCleanWinner: c.candidateIsCleanWinner,
        shouldPreserveCleanWinner: c.shouldPreserveCleanWinner,
      })
    }

    const input: AdvisorDecisionInput = {
      seat,
      partnerSeat: getPartnerSeat(seat),
      positionInTrick: r.positionInTrick,
      contract: r.contract.contract as ServerScoringContract,
      trumpSuit: r.contract.trumpSuit as ServerSuit | null,
      currentTrickPlays: r.currentTrick.map((p) => ({ seat: p.seat as Seat, card: p.card as ServerCard })),
      legalCards: r.legalCards as ServerCard[],
      conventionalCard,
      partnerCurrentlyWinning: r.memory.partnerCurrentlyWinning,
      opponentCurrentlyWinning: r.memory.opponentCurrentlyWinning,
      pointsInTrick: r.memory.pointsInTrick,
      candidateMemoryById,
    }

    const result = decideAdvisorCard(input)
    const conventionalMatchesHuman = conventionalCard.id === r.chosenCard.id
    const finalMatchesHuman = result.finalCard.id === r.chosenCard.id

    outcomes.push({
      reason: result.reason,
      override: result.override,
      conventionalMatchesHuman,
      finalMatchesHuman,
      redFlag: result.override && conventionalMatchesHuman,
      positiveSignal: result.override && !conventionalMatchesHuman && finalMatchesHuman,
      gameMode: r.contract.contract,
      positionInTrick: r.positionInTrick,
      example: result.override && result.reason
        ? {
            gameMode: r.contract.contract,
            trumpSuit: r.contract.trumpSuit,
            positionInTrick: r.positionInTrick,
            pointsInTrick: r.memory.pointsInTrick,
            conventionalCard: conventionalCard.id,
            advisorCard: result.finalCard.id,
            humanChosenCard: r.chosenCard.id,
            reason: result.reason,
          }
        : null,
    })
  }

  return { outcomes, skippedNoConventional }
}

function summarize(outcomes: EvalOutcome[]) {
  const total = outcomes.length
  const overrideCount = outcomes.filter((o) => o.override).length
  const ruleCounts = emptyRuleCounts()
  for (const o of outcomes) if (o.reason) ruleCounts[o.reason]++

  const conventionalAccuracy = outcomes.filter((o) => o.conventionalMatchesHuman).length
  const advisorAdjustedAccuracy = outcomes.filter((o) => o.finalMatchesHuman).length
  const redFlags = outcomes.filter((o) => o.redFlag).length
  const positiveSignals = outcomes.filter((o) => o.positiveSignal).length

  const representativeExamples: Record<AdvisorReason, EvalOutcome['example'][]> = {
    avoid_giving_trick_to_opponent: [],
    avoid_feeding_points: [],
    avoid_overtaking_partner: [],
    preserve_clean_winner: [],
  }
  for (const o of outcomes) {
    if (o.example && representativeExamples[o.example.reason].length < 5) {
      representativeExamples[o.example.reason].push(o.example)
    }
  }

  return {
    total,
    overrideCount,
    overrideRate: total > 0 ? overrideCount / total : 0,
    ruleCounts,
    conventionalAccuracy: { correct: conventionalAccuracy, total, rate: total > 0 ? conventionalAccuracy / total : 0 },
    advisorAdjustedAccuracy: { correct: advisorAdjustedAccuracy, total, rate: total > 0 ? advisorAdjustedAccuracy / total : 0 },
    redFlags,
    redFlagRate: overrideCount > 0 ? redFlags / overrideCount : 0,
    positiveSignals,
    positiveSignalRate: overrideCount > 0 ? positiveSignals / overrideCount : 0,
    representativeExamples,
  }
}

function pct(part: number, total: number): string {
  if (total === 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  Card Advisor Offline Evaluator (локален, read-only)')
  console.log('─────────────────────────────────────────')

  const splitContents: Record<'validation' | 'test', string> = { validation: '', test: '' }
  const missingSplits: string[] = []
  for (const split of ['validation', 'test'] as const) {
    try {
      splitContents[split] = await readFile(CARD_PATHS[split], 'utf8')
    } catch {
      missingSplits.push(CARD_PATHS[split])
    }
  }
  if (missingSplits.length > 0) {
    console.error('FATAL: липсват необходими card split файлове:')
    for (const f of missingSplits) console.error(`  - ${f}`)
    console.error('\nИзпълни първо: npm run prepare:training-baseline')
    process.exit(2)
    return
  }

  console.log('Валидирам card split файловете (включително memory enrichment полета)...')
  const parsedValidation = parseJsonlStrict<Partial<CardRecordV2>>(splitContents.validation, 'card-validation.jsonl')
  const parsedTest = parseJsonlStrict<Partial<CardRecordV2>>(splitContents.test, 'card-test.jsonl')
  const schemaErrors: string[] = [...parsedValidation.errors, ...parsedTest.errors]
  for (const { record, lineNumber } of parsedValidation.lines) schemaErrors.push(...validateCardRecordV2(record, `card-validation.jsonl:${lineNumber}`))
  for (const { record, lineNumber } of parsedTest.lines) schemaErrors.push(...validateCardRecordV2(record, `card-test.jsonl:${lineNumber}`))
  if (schemaErrors.length > 0) {
    console.error(`\n✗ Открити ${schemaErrors.length} schema грешки — анализ СПРЯН.\n`)
    for (const e of schemaErrors.slice(0, 200)) console.error(`  ${e}`)
    process.exit(1)
    return
  }

  console.log('Privacy/sanitization сканиране на входа...')
  const inputViolations = [
    ...(await scanAllForbiddenContent(CARD_PATHS.validation)),
    ...(await scanAllForbiddenContent(CARD_PATHS.test)),
  ]
  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в input-а — анализ СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  const validationRecords = parsedValidation.lines.map((l) => l.record as CardRecordV2)
  const testRecords = parsedTest.lines.map((l) => l.record as CardRecordV2)

  console.log('Симулирам conventional bot избора (read-only pickServerBotPlayCard) и пускам advisor engine-а...')
  const validationEval = evaluateSplit(validationRecords)
  const testEval = evaluateSplit(testRecords)
  const validationSummary = summarize(validationEval.outcomes)
  const testSummary = summarize(testEval.outcomes)

  const overrideRateInRange = testSummary.overrideRate >= OVERRIDE_RATE_TARGET_MIN && testSummary.overrideRate <= OVERRIDE_RATE_TARGET_MAX

  const reportJson = {
    generatedAt: new Date().toISOString(),
    inputFiles: { cardValidation: CARD_PATHS.validation, cardTest: CARD_PATHS.test },
    privacyValidation: { status: 'PASS', violationCount: 0 },
    overrideRateTarget: { min: OVERRIDE_RATE_TARGET_MIN, max: OVERRIDE_RATE_TARGET_MAX },
    validation: { ...validationSummary, skippedNoConventional: validationEval.skippedNoConventional },
    test: { ...testSummary, skippedNoConventional: testEval.skippedNoConventional },
    overrideRateInRangeOnTest: overrideRateInRange,
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
  console.log('  Резултат (test split)')
  console.log('─────────────────────────────────────────')
  console.log(`  Non-forced decisions evaluated: ${testSummary.total} (skipped, no conventional pick: ${testEval.skippedNoConventional})`)
  console.log(`  Override rate: ${pct(testSummary.overrideCount, testSummary.total)} (target ${pct(OVERRIDE_RATE_TARGET_MIN * 100, 100)}-${pct(OVERRIDE_RATE_TARGET_MAX * 100, 100)}) — ${overrideRateInRange ? 'IN RANGE' : 'OUT OF RANGE'}`)
  console.log(`  Per-rule triggers: avoid_giving_trick_to_opponent=${testSummary.ruleCounts.avoid_giving_trick_to_opponent}, avoid_feeding_points=${testSummary.ruleCounts.avoid_feeding_points}, avoid_overtaking_partner=${testSummary.ruleCounts.avoid_overtaking_partner}, preserve_clean_winner=${testSummary.ruleCounts.preserve_clean_winner}`)
  console.log(`  Conventional-alone accuracy vs human: ${pct(testSummary.conventionalAccuracy.correct, testSummary.conventionalAccuracy.total)}`)
  console.log(`  Advisor-adjusted accuracy vs human: ${pct(testSummary.advisorAdjustedAccuracy.correct, testSummary.advisorAdjustedAccuracy.total)}`)
  console.log(`  Red flags (override fired but human kept conventional): ${testSummary.redFlags} / ${testSummary.overrideCount} overrides (${pct(testSummary.redFlags, testSummary.overrideCount)})`)
  console.log(`  Positive signals (override moved pick to match human): ${testSummary.positiveSignals} / ${testSummary.overrideCount} overrides (${pct(testSummary.positiveSignals, testSummary.overrideCount)})`)
  console.log(`\n✓ Отчет: ${REPORT_MD_PATH}`)
  console.log(`✓ Отчет: ${REPORT_JSON_PATH}`)
  console.log('✓ Card advisor offline evaluation завършен успешно.\n')
  process.exit(0)
}

function renderMarkdown(report: any): string {
  const lines: string[] = []
  lines.push('# Card Advisor — Offline Evaluation Report')
  lines.push('')
  lines.push(`Генериран на: ${report.generatedAt}`)
  lines.push('')
  lines.push(
    '**Local-only, offline, zero runtime risk.** Оценява guard-rule advisor engine-а (server/src/ai/cardAdvisorPolicy.ts) ' +
    'върху реални човешки card decisions (validation/test split), преди какъвто и да е runtime wiring. ' +
    'Целта е override rate в разумен, консервативен диапазон и НЕ-негативен ефект спрямо conventional-alone accuracy.',
  )
  lines.push('')

  for (const split of ['validation', 'test'] as const) {
    const s = report[split]
    lines.push(`## ${split}`)
    lines.push(`- Non-forced decisions evaluated: ${s.total} (skipped, no conventional pick: ${s.skippedNoConventional})`)
    lines.push(`- Override rate: ${pct(s.overrideCount, s.total)} (target ${report.overrideRateTarget.min * 100}%-${report.overrideRateTarget.max * 100}%)`)
    lines.push(`- Per-rule triggers:`)
    lines.push(`  - avoid_giving_trick_to_opponent: ${s.ruleCounts.avoid_giving_trick_to_opponent}`)
    lines.push(`  - avoid_feeding_points: ${s.ruleCounts.avoid_feeding_points}`)
    lines.push(`  - avoid_overtaking_partner: ${s.ruleCounts.avoid_overtaking_partner}`)
    lines.push(`  - preserve_clean_winner: ${s.ruleCounts.preserve_clean_winner}`)
    lines.push(`- Conventional-alone accuracy vs human chosenCard: ${pct(s.conventionalAccuracy.correct, s.conventionalAccuracy.total)}`)
    lines.push(`- Advisor-adjusted accuracy vs human chosenCard: ${pct(s.advisorAdjustedAccuracy.correct, s.advisorAdjustedAccuracy.total)}`)
    lines.push(`- Red flags (override fired, human actually kept conventional): ${s.redFlags} / ${s.overrideCount} overrides (${pct(s.redFlags, s.overrideCount)})`)
    lines.push(`- Positive signals (override moved pick to match human): ${s.positiveSignals} / ${s.overrideCount} overrides (${pct(s.positiveSignals, s.overrideCount)})`)
    lines.push('')
    lines.push('### Representative examples per rule')
    for (const [rule, examples] of Object.entries(s.representativeExamples) as Array<[string, any[]]>) {
      lines.push(`#### ${rule}`)
      if (examples.length === 0) {
        lines.push('_(no examples — rule never fired on this split)_')
      } else {
        for (const ex of examples) {
          lines.push(
            `- gameMode=${ex.gameMode}, trumpSuit=${ex.trumpSuit}, positionInTrick=${ex.positionInTrick}, pointsInTrick=${ex.pointsInTrick}: ` +
            `conventional=${ex.conventionalCard} → advisor=${ex.advisorCard} (human chose ${ex.humanChosenCard})`,
          )
        }
      }
      lines.push('')
    }
  }

  lines.push('## Заключение')
  lines.push(
    report.overrideRateInRangeOnTest
      ? '✓ Override rate (test) е в целевия консервативен диапазон 5-20%.'
      : '⚠ Override rate (test) е ИЗВЪН целевия диапазон 5-20% — виж числата по-горе преди runtime wiring.',
  )
  lines.push('')

  return lines.join('\n')
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(2)
})
