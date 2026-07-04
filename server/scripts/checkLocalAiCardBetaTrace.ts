/**
 * checkLocalAiCardBetaTrace.ts
 *
 * Local check script за trace logic-ата в server/src/ai/localAiCardBeta.ts
 * (LOCAL_AI_CARD_BETA_TRACE_ENABLED). Не изисква production env — всички
 * сценарии работят с конструирани states, temp model.json и temp trace
 * файлове, напълно изолирани от реалния trace log.
 *
 * Сценарии:
 *  [1]  Trace flag OFF → не се пише trace файл (нула overhead извън flag checks)
 *  [2]  Trace ON + AI disabled → записва decisionSource="ai_disabled"
 *  [3]  Trace ON + AI accepted (валидна, различна от conventional карта) →
 *       decisionSource="ai_accepted"
 *  [4]  Trace ON + AI same as conventional → decisionSource="ai_same_as_conventional"
 *  [5]  Trace ON + missing model → decisionSource="conventional_fallback"
 *  [6]  Trace ON + corrupt model → decisionSource="conventional_fallback"
 *  [7]  Forced card (legalCards.length===1) → decisionSource="forced_card"
 *       (независимо от AI флага)
 *  [8]  Invalid AI prediction mock (астрономически тегла → non-finite score
 *       вътре в rankLegalCardsWithCardModel) → decisionSource="conventional_fallback",
 *       finalCard===conventionalCard
 *  [9]  Summary counts (computeTraceSummary) са коректни върху известен набор trace redове
 *  [10] Trace output няма forbidden markers (roomId/profileId/email/ip/password/
 *       token/secret/session/cookie/authorization)
 *
 * Не пипа production .env, не прави network/SSH/deploy.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  pickServerBotPlayCardWithAiCandidate,
  resetLocalAiCardBetaModelCacheForTests,
  resetLocalAiCardBetaTraceStateForTests,
  type LocalAiCardBetaTraceRecord,
} from '../src/ai/localAiCardBeta.js'
import { pickServerBotPlayCard } from '../src/game/pickServerBotPlayCard.js'
import { CARD_MODEL_FEATURE_NAMES } from '../src/ai/cardModelFeatures.js'
import { computeTraceSummary, parseJsonlStrict } from './summarizeLocalAiCardBetaTrace.js'
import { scanFileForForbiddenContent } from './trainingDataset/sanitizeOutput.js'
import type {
  ServerAuthoritativeGameState,
  ServerCard,
  ServerPlayerState,
  ServerPlayingState,
  ServerTrickPlay,
  ServerWinningBid,
} from '../src/game/serverGameTypes.js'
import type { Seat, Team } from '../src/core/serverTypes.js'

// ─── Test runner (същия стил като checkTrainingRecorder.ts / checkLocalAiCardBeta.ts) ─

let passed = 0
let failed = 0
const asyncQueue: Array<() => Promise<void>> = []

function checkAsync(label: string, fn: () => Promise<void>): void {
  asyncQueue.push(async () => {
    try {
      await fn()
      passed++
      console.log(`  PASS  ${label}`)
    } catch (err) {
      failed++
      console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: получено "${String(actual)}", очаквано "${String(expected)}"`)
}

// ─── State builders (същите като checkLocalAiCardBeta.ts) ───────────────────

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']

function card(suit: string, rank: string): ServerCard {
  return { id: `${suit}-${rank}`, suit: suit as ServerCard['suit'], rank: rank as ServerCard['rank'] }
}

function emptyScore() {
  return { teamA: 0, teamB: 0 }
}

function makePlayers(): Record<Seat, ServerPlayerState> {
  const teams: Team[] = ['A', 'B', 'A', 'B']
  return Object.fromEntries(
    SEATS.map((s, i) => [s, { seat: s, team: teams[i]!, mode: 'bot' as const, controlledByBot: true }]),
  ) as Record<Seat, ServerPlayerState>
}

function emptyWon(): Record<Seat, ServerCard[][]> {
  return { bottom: [], right: [], top: [], left: [] }
}

function baseState(
  hands: Record<Seat, ServerCard[]>,
  overrides: Partial<ServerAuthoritativeGameState> = {},
): ServerAuthoritativeGameState {
  const es = emptyScore()
  return {
    phase: 'playing',
    phaseEnteredAt: 0,
    targetScore: 151,
    players: makePlayers(),
    round: { dealerSeat: 'bottom', cutterSeat: null, firstBidderSeat: null, firstDealSeat: null, selectedCutIndex: null },
    deck: [],
    hands,
    bidding: { entries: [], currentSeat: null, winningBid: null, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    declarations: [],
    matchDeclarationMissionCounts: {
      announce_tersa: es, announce_50: es, announce_100: es, announce_kare: es, announce_belot: es,
    },
    matchDeclarationMissionCountsBySeat: {},
    currentTrick: { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 0 },
    wonTricks: { A: [], B: [] },
    playing: null,
    scoring: null,
    matchEnded: null,
    score: {
      round: { tricks: es, declarations: es, belote: es, lastTen: es, capot: es, total: es },
      match: { teamA: 0, teamB: 0 },
      carryOver: es,
    },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
    ...overrides,
  }
}

function makePlaying(currentTrickPlays: ServerTrickPlay[], currentTurnSeat: Seat | null): ServerPlayingState {
  return {
    hasStarted: true,
    currentTurnSeat,
    currentTrick: { leaderSeat: currentTrickPlays[0]?.seat ?? null, currentSeat: currentTurnSeat, plays: currentTrickPlays, winnerSeat: null, trickIndex: 0 },
    completedTricks: [],
    lastCompletedTrickWinnerSeat: null,
    lastCompletedTrickWinnerTeam: null,
    wonTricksBySeat: emptyWon(),
    wonTricksByTeam: { A: [], B: [] },
  }
}

/**
 * Two-card leading all-trumps fixture. hearts-J (all-trumps точки=20) и
 * hearts-8 (точки=0) са единствените карти на ръка → само
 * cardPointsNormalized (feature index 1) различава двете карти (isTrump,
 * suitVoidRisk и leadership interactions всичките са равни/нула за двете) —
 * това позволява ДЕТЕРМИНИСТИЧНО да принудим AI избора чрез знака на
 * едно-единствено тегло, независимо кое от двете conventional bot-ът реално
 * връща.
 */
function buildTwoCardState(): { state: ServerAuthoritativeGameState; seat: Seat } {
  const seat: Seat = 'bottom'
  const hand: ServerCard[] = [card('hearts', 'J'), card('hearts', '8')]
  const hands: Record<Seat, ServerCard[]> = { bottom: hand, right: [], top: [], left: [] }
  const winningBid: ServerWinningBid = { seat: 'bottom', contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false }

  const state = baseState(hands, {
    bidding: { entries: [], currentSeat: null, winningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    playing: makePlaying([], seat),
  })

  return { state, seat }
}

function buildForcedState(): { state: ServerAuthoritativeGameState; seat: Seat } {
  const seat: Seat = 'bottom'
  const hand: ServerCard[] = [card('hearts', 'J')]
  const hands: Record<Seat, ServerCard[]> = { bottom: hand, right: [], top: [], left: [] }
  const winningBid: ServerWinningBid = { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false }

  const state = baseState(hands, {
    bidding: { entries: [], currentSeat: null, winningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    playing: makePlaying([], seat),
  })

  return { state, seat }
}

// ─── Model + env helpers ──────────────────────────────────────────────────────

function validModelJson(weights: number[]): Record<string, unknown> {
  return {
    modelVersion: 'card-model-v1',
    generatedAt: new Date().toISOString(),
    approach: 'linear-softmax-ranker',
    featureNames: CARD_MODEL_FEATURE_NAMES,
    weights,
    hyperparameters: { epochs: 60, learningRate: 0.5, l2Regularization: 0.001 },
    trainingCounts: { trainTotal: 0, trainForced: 0, trainNonForced: 0 },
    fallbackStrategy: 'test fixture',
    trainingDataHash: 'sha256:test',
    trainingDataFile: 'test',
    finalTrainLoss: 0,
  }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'local-ai-card-beta-trace-check-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) previous[key] = process.env[key]
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

function resetAllCaches(): void {
  resetLocalAiCardBetaModelCacheForTests()
  resetLocalAiCardBetaTraceStateForTests()
}

async function readTraceRecords(tracePath: string): Promise<LocalAiCardBetaTraceRecord[]> {
  const content = await readFile(tracePath, 'utf8')
  const { records, errors } = parseJsonlStrict(content, 'trace')
  assert(errors.length === 0, `trace parse errors: ${errors.join('; ')}`)
  return records.map((r) => r.record as unknown as LocalAiCardBetaTraceRecord)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8')
    return true
  } catch {
    return false
  }
}

// ─── Scenario tests ───────────────────────────────────────────────────────────

console.log('\ncheckLocalAiCardBetaTrace\n')

// [1] Trace flag OFF → не се пише trace файл
checkAsync('[1] Trace flag OFF → не се пише trace файл', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const { state, seat } = buildTwoCardState()
    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_PATH: tracePath },
      () => {
        resetAllCaches()
        pickServerBotPlayCardWithAiCandidate(state, seat)
      },
    )
    assert(!(await fileExists(tracePath)), 'trace файл не трябва да съществува при flag OFF')
  })
})

// [2] Trace ON + AI disabled → ai_disabled
checkAsync('[2] Trace ON + AI disabled → decisionSource="ai_disabled"', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const { state, seat } = buildTwoCardState()
    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_TRACE_PATH: tracePath },
      () => {
        resetAllCaches()
        pickServerBotPlayCardWithAiCandidate(state, seat)
      },
    )
    const records = await readTraceRecords(tracePath)
    assertEqual(records.length, 1, 'трябва да има точно 1 trace ред')
    assertEqual(records[0]!.decisionSource, 'ai_disabled', 'decisionSource')
    assertEqual(records[0]!.aiEnabled, false, 'aiEnabled')
    assert(records[0]!.finalCardValid, 'finalCardValid трябва да е true')
  })
})

// [3] Trace ON + AI accepted (различна от conventional)
checkAsync('[3] Trace ON + AI избира различна валидна карта → decisionSource="ai_accepted"', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const modelPath = join(dir, 'model.json')
    const { state, seat } = buildTwoCardState()
    const conventional = pickServerBotPlayCard(state, seat)!
    // W2 (cardPointsNormalized) с обратен знак спрямо conventional → AI избира ДРУГАТА карта.
    const w2 = conventional.id === 'hearts-J' ? -1 : 1
    await writeFile(modelPath, JSON.stringify(validModelJson([0, w2, 0, 0, 0])), 'utf8')

    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_MODEL_PATH: modelPath, LOCAL_AI_CARD_BETA_TRACE_PATH: tracePath },
      () => {
        resetAllCaches()
        const result = pickServerBotPlayCardWithAiCandidate(state, seat)
        assert(result !== null && result.id !== conventional.id, 'AI картата трябва да е различна от conventional')
      },
    )

    const records = await readTraceRecords(tracePath)
    assertEqual(records.length, 1, 'трябва да има точно 1 trace ред')
    assertEqual(records[0]!.decisionSource, 'ai_accepted', 'decisionSource')
    assertEqual(records[0]!.aiSameAsConventional, false, 'aiSameAsConventional')
    assertEqual(records[0]!.aiCardValid, true, 'aiCardValid')
    assert(records[0]!.finalCardValid, 'finalCardValid трябва да е true')
    assert(records[0]!.finalCard === records[0]!.aiSelectedCard, 'finalCard трябва да е AI картата')
  })
})

// [4] Trace ON + AI same as conventional
checkAsync('[4] Trace ON + AI избира СЪЩАТА карта като conventional → decisionSource="ai_same_as_conventional"', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const modelPath = join(dir, 'model.json')
    const { state, seat } = buildTwoCardState()
    const conventional = pickServerBotPlayCard(state, seat)!
    // W2 със знака, който прави AI да избере СЪЩАТА карта като conventional.
    const w2 = conventional.id === 'hearts-J' ? 1 : -1
    await writeFile(modelPath, JSON.stringify(validModelJson([0, w2, 0, 0, 0])), 'utf8')

    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_MODEL_PATH: modelPath, LOCAL_AI_CARD_BETA_TRACE_PATH: tracePath },
      () => {
        resetAllCaches()
        const result = pickServerBotPlayCardWithAiCandidate(state, seat)
        assertEqual(result?.id, conventional.id, 'AI картата трябва да съвпада с conventional')
      },
    )

    const records = await readTraceRecords(tracePath)
    assertEqual(records.length, 1, 'трябва да има точно 1 trace ред')
    assertEqual(records[0]!.decisionSource, 'ai_same_as_conventional', 'decisionSource')
    assertEqual(records[0]!.aiSameAsConventional, true, 'aiSameAsConventional')
    assert(records[0]!.finalCardValid, 'finalCardValid трябва да е true')
  })
})

// [5] Trace ON + missing model → conventional_fallback
checkAsync('[5] Trace ON + missing model → decisionSource="conventional_fallback"', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const { state, seat } = buildTwoCardState()
    const conventional = pickServerBotPlayCard(state, seat)!

    withEnv(
      {
        LOCAL_AI_CARD_BETA_ENABLED: 'true',
        LOCAL_AI_CARD_BETA_TRACE_ENABLED: 'true',
        LOCAL_AI_CARD_BETA_MODEL_PATH: join(dir, 'does-not-exist.json'),
        LOCAL_AI_CARD_BETA_TRACE_PATH: tracePath,
      },
      () => {
        resetAllCaches()
        const result = pickServerBotPlayCardWithAiCandidate(state, seat)
        assertEqual(result?.id, conventional.id, 'трябва да върне conventional при missing model')
      },
    )

    const records = await readTraceRecords(tracePath)
    assertEqual(records[0]!.decisionSource, 'conventional_fallback', 'decisionSource')
    assert(records[0]!.fallbackUsed, 'fallbackUsed трябва да е true')
    assert(!!records[0]!.fallbackReason, 'fallbackReason трябва да е попълнена')
    assert(records[0]!.finalCardValid, 'finalCardValid трябва да е true')
  })
})

// [6] Trace ON + corrupt model → conventional_fallback
checkAsync('[6] Trace ON + corrupt model (invalid JSON) → decisionSource="conventional_fallback"', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const modelPath = join(dir, 'model.json')
    await writeFile(modelPath, '{ not valid json', 'utf8')
    const { state, seat } = buildTwoCardState()
    const conventional = pickServerBotPlayCard(state, seat)!

    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_MODEL_PATH: modelPath, LOCAL_AI_CARD_BETA_TRACE_PATH: tracePath },
      () => {
        resetAllCaches()
        const result = pickServerBotPlayCardWithAiCandidate(state, seat)
        assertEqual(result?.id, conventional.id, 'трябва да върне conventional при corrupt model')
      },
    )

    const records = await readTraceRecords(tracePath)
    assertEqual(records[0]!.decisionSource, 'conventional_fallback', 'decisionSource')
    assert(records[0]!.finalCardValid, 'finalCardValid трябва да е true')
  })
})

// [7] Forced card → forced_card (независимо от AI флага)
checkAsync('[7] Forced card (1 legal card) → decisionSource="forced_card"', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const modelPath = join(dir, 'model.json')
    await writeFile(modelPath, JSON.stringify(validModelJson([0.01, -0.03, -0.23, -0.16, 1.0])), 'utf8')
    const { state, seat } = buildForcedState()

    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_MODEL_PATH: modelPath, LOCAL_AI_CARD_BETA_TRACE_PATH: tracePath },
      () => {
        resetAllCaches()
        const result = pickServerBotPlayCardWithAiCandidate(state, seat)
        assertEqual(result?.id, 'hearts-J', 'forced card трябва да е единствената карта')
      },
    )

    const records = await readTraceRecords(tracePath)
    assertEqual(records[0]!.decisionSource, 'forced_card', 'decisionSource')
    assertEqual(records[0]!.isForced, true, 'isForced')
    assert(records[0]!.finalCardValid, 'finalCardValid трябва да е true')
  })
})

// [8] Invalid AI prediction mock (non-finite score) → conventional_fallback, finalCard===conventional
checkAsync('[8] Astronomически тегла (non-finite score) → decisionSource="conventional_fallback"', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const modelPath = join(dir, 'model.json')
    const hugeWeights = [1e308, 1e308, 1e308, 1e308, 1e308]
    await writeFile(modelPath, JSON.stringify(validModelJson(hugeWeights)), 'utf8')
    const { state, seat } = buildTwoCardState()
    const conventional = pickServerBotPlayCard(state, seat)!

    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_MODEL_PATH: modelPath, LOCAL_AI_CARD_BETA_TRACE_PATH: tracePath },
      () => {
        resetAllCaches()
        const result = pickServerBotPlayCardWithAiCandidate(state, seat)
        assertEqual(result?.id, conventional.id, 'при non-finite AI score трябва да върне точно conventional')
      },
    )

    const records = await readTraceRecords(tracePath)
    assertEqual(records[0]!.decisionSource, 'conventional_fallback', 'decisionSource')
    assert(records[0]!.fallbackUsed, 'fallbackUsed трябва да е true')
    assert(records[0]!.finalCardValid, 'finalCardValid трябва да е true')
  })
})

// [9] Summary counts (computeTraceSummary) върху известен набор
checkAsync('[9] computeTraceSummary дава коректни counts върху известен trace набор', async () => {
  const now = new Date().toISOString()
  const mk = (overrides: Partial<LocalAiCardBetaTraceRecord>): { record: LocalAiCardBetaTraceRecord; lineNumber: number } => ({
    record: {
      timestamp: now,
      traceVersion: 1,
      modelVersion: 'card-model-v1',
      aiEnabled: true,
      traceEnabled: true,
      decisionSource: 'ai_accepted',
      fallbackUsed: false,
      fallbackReason: null,
      seatIndex: 0,
      teamIndex: 0,
      legalCardsCount: 2,
      ownHandCount: 2,
      isForced: false,
      gameMode: 'all-trumps',
      trumpSuit: null,
      conventionalCard: 'hearts-8',
      aiSelectedCard: 'hearts-J',
      finalCard: 'hearts-J',
      aiSameAsConventional: false,
      finalCardValid: true,
      aiCardValid: true,
      rankingLength: 2,
      topPredictions: [],
      roomKey: null,
      ...overrides,
    },
    lineNumber: 1,
  })

  const synthetic = [
    mk({ decisionSource: 'ai_disabled', aiEnabled: false, aiSelectedCard: null, aiCardValid: null, aiSameAsConventional: null, finalCard: 'hearts-8' }),
    mk({ decisionSource: 'ai_disabled', aiEnabled: false, aiSelectedCard: null, aiCardValid: null, aiSameAsConventional: null, finalCard: 'hearts-8' }),
    mk({ decisionSource: 'forced_card', isForced: true, aiSelectedCard: null, aiCardValid: null, aiSameAsConventional: null, finalCard: 'hearts-J' }),
    mk({ decisionSource: 'ai_accepted', aiSelectedCard: 'hearts-J', finalCard: 'hearts-J', aiSameAsConventional: false }),
    mk({ decisionSource: 'ai_accepted', aiSelectedCard: 'hearts-J', finalCard: 'hearts-J', aiSameAsConventional: false }),
    mk({ decisionSource: 'ai_same_as_conventional', aiSelectedCard: 'hearts-8', finalCard: 'hearts-8', aiSameAsConventional: true }),
    mk({ decisionSource: 'conventional_fallback', fallbackUsed: true, fallbackReason: 'AI model не е наличен', aiSelectedCard: null, aiCardValid: null, aiSameAsConventional: null, finalCard: 'hearts-8' }),
    mk({ decisionSource: 'conventional_fallback', fallbackUsed: true, fallbackReason: 'exception: boom', aiSelectedCard: null, aiCardValid: false, aiSameAsConventional: null, finalCard: 'hearts-8' }),
  ]

  const summary = computeTraceSummary(synthetic, '/tmp/fake-trace.jsonl')

  assertEqual(summary.totalDecisions, 8, 'totalDecisions')
  assertEqual(summary.decisionSourceCounts.ai_disabled, 2, 'ai_disabled count')
  assertEqual(summary.decisionSourceCounts.forced_card, 1, 'forced_card count')
  assertEqual(summary.decisionSourceCounts.ai_accepted, 2, 'ai_accepted count')
  assertEqual(summary.decisionSourceCounts.ai_same_as_conventional, 1, 'ai_same_as_conventional count')
  assertEqual(summary.decisionSourceCounts.conventional_fallback, 2, 'conventional_fallback count')
  assertEqual(summary.invalidAiPredictions, 1, 'invalidAiPredictions (aiCardValid===false)')
  assertEqual(summary.invalidFinalCards, 0, 'invalidFinalCards')
  assertEqual(summary.nonForcedAiEnabledTotal, 5, 'nonForcedAiEnabledTotal (ai_accepted+ai_same_as_conventional+conventional_fallback)')
  assertEqual(summary.validAiPredictionsTotal, 3, 'validAiPredictionsTotal (ai_accepted+ai_same_as_conventional)')
  assert(Math.abs(summary.aiAcceptedRateExcludingForced - 2 / 5) < 1e-9, 'aiAcceptedRateExcludingForced')
  assert(Math.abs(summary.aiDiffersFromConventionalRate - 2 / 3) < 1e-9, 'aiDiffersFromConventionalRate')
  assertEqual(summary.topAiSelectedCards[0]?.id, 'hearts-J', 'top AI card')
  assertEqual(summary.topAiSelectedCards[0]?.count, 2, 'top AI card count')
})

// [10] Trace output няма forbidden markers
checkAsync('[10] Trace output няма forbidden markers (roomId/profileId/email/ip/password/token/secret/session/cookie/authorization)', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const modelPath = join(dir, 'model.json')
    await writeFile(modelPath, JSON.stringify(validModelJson([0.01, -0.03, -0.23, -0.16, 1.0])), 'utf8')

    // Изпълняваме няколко различни decision пътя, за да имаме разнообразен trace.
    for (const build of [buildTwoCardState, buildForcedState]) {
      const { state, seat } = build()
      withEnv(
        { LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_MODEL_PATH: modelPath, LOCAL_AI_CARD_BETA_TRACE_PATH: tracePath },
        () => {
          resetAllCaches()
          pickServerBotPlayCardWithAiCandidate(state, seat)
        },
      )
    }

    const violations = await scanFileForForbiddenContent(tracePath)
    assertEqual(violations.length, 0, `forbidden markers намерени: ${violations.map((v) => v.pattern).join(', ')}`)

    const extraForbidden = [/"session[a-z]*"\s*:/i, /"cookie"\s*:/i, /"authorization"\s*:/i]
    const content = await readFile(tracePath, 'utf8')
    for (const pattern of extraForbidden) {
      assert(!pattern.test(content), `намерен допълнителен forbidden marker: ${pattern}`)
    }
  })
})

// ─── Run async queue, print summary ──────────────────────────────────────────

async function main(): Promise<void> {
  for (const fn of asyncQueue) await fn()

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
  resetAllCaches()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
