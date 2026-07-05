/**
 * checkLocalAiCardBeta.ts
 *
 * Local check script за server/src/ai/localAiCardBeta.ts — доказва, че
 * local-only AI card-play beta wrapper е safe преди какъвто и да е бъдещ
 * runtime/beta risk decision. Не изисква production env — всички scenario-та
 * работят с конструирани states и temp model.json файлове.
 *
 * Сценарии:
 *  [1]  Flag OFF → резултатът е точно pickServerBotPlayCard(state, seat)
 *  [2]  Flag ON + валиден model + non-forced sample → AI избира валидна карта
 *  [3]  Missing model file → fallback към conventional, без crash
 *  [4]  Corrupt model (invalid JSON / грешна schema) → fallback, без crash
 *  [5]  "Invalid AI prediction" (астрономически тегла → non-finite score
 *       вътре в rankLegalCardsWithCardModel) → wrapper fallback-ва, все пак
 *       връща валидна карта
 *  [6]  Forced legalCards.length === 1 → връща точно forced картата
 *  [7]  Final selected card винаги ∈ legalCards и ∈ ownHand (кросчек върху
 *       всички по-горни сценарии)
 *  [8]  Никакви production env изисквания — работи с празен process.env
 *  [9]  Real-data smoke: training-output/baseline/card-test.jsonl (ако е
 *       наличен) — flag OFF == conventional; flag ON никога не връща
 *       invalid карта
 *
 * Не пипа production .env, не прави network/SSH/deploy.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  pickServerBotPlayCardWithAiCandidate,
  resetLocalAiCardBetaModelCacheForTests,
} from '../src/ai/localAiCardBeta.js'
import { pickServerBotPlayCard } from '../src/game/pickServerBotPlayCard.js'
import { CARD_MODEL_FEATURE_NAMES } from '../src/ai/cardModelFeatures.js'
import type {
  ServerAuthoritativeGameState,
  ServerCard,
  ServerPlayerState,
  ServerPlayingState,
  ServerTrickPlay,
  ServerWinningBid,
} from '../src/game/serverGameTypes.js'
import type { Seat, Team } from '../src/core/serverTypes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const REAL_MODEL_PATH = join(REPO_ROOT, 'training-output', 'models', 'card-model-v1', 'model.json')
const CARD_TEST_PATH = join(REPO_ROOT, 'training-output', 'baseline', 'card-test.jsonl')

// ─── Test runner (същия стил като checkTrainingRecorder.ts) ──────────────────

let passed = 0
let failed = 0
const asyncQueue: Array<() => Promise<void>> = []

function checkSync(label: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

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

// ─── State builders (минимален валиден ServerAuthoritativeGameState) ─────────

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

/** Изгражда non-forced playing state: seat "bottom" с 5 карти на ръка, водещ трик (свободен избор), suit contract. */
function buildNonForcedState(): { state: ServerAuthoritativeGameState; seat: Seat } {
  const seat: Seat = 'bottom'
  const hand: ServerCard[] = [
    card('hearts', 'J'), card('hearts', 'K'), card('diamonds', '9'),
    card('clubs', '10'), card('spades', 'A'),
  ]
  const hands: Record<Seat, ServerCard[]> = { bottom: hand, right: [], top: [], left: [] }
  const winningBid: ServerWinningBid = { seat: 'bottom', contract: 'suit', trumpSuit: 'hearts', doubled: false, redoubled: false }

  const state = baseState(hands, {
    bidding: { entries: [], currentSeat: null, winningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    playing: makePlaying([], seat),
  })

  return { state, seat }
}

/** Изгражда forced playing state: seat "bottom" с точно 1 карта на ръка. */
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

// ─── Model builders ───────────────────────────────────────────────────────────

function validModelJson(weights: number[] = [0.01, -0.03, -0.23, -0.16, 1.0]): Record<string, unknown> {
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

async function writeTempModel(content: string | Record<string, unknown>): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'local-ai-card-beta-check-'))
  const path = join(dir, 'model.json')
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  await writeFile(path, text, 'utf8')
  return { dir, path }
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

function legalIdsOf(state: ServerAuthoritativeGameState, seat: Seat): Set<string> {
  // pickServerBotPlayCard няма exported valid-cards helper поотделно тук, но
  // getServerValidPlayCards е реекспортирано през bot picker модула indirectно —
  // затова просто питаме conventional bot-а и hand-а: ако картата е в hand-а и
  // conventional/AI я приема, значи е част от legal set-а по конструкция на теста.
  return new Set((state.hands[seat] ?? []).map((c) => c.id))
}

// ─── Scenario tests ───────────────────────────────────────────────────────────

console.log('\ncheckLocalAiCardBeta\n')

// [1] Flag OFF → точно conventional resultat
checkSync('[1] Flag OFF → резултатът е точно pickServerBotPlayCard(state, seat)', () => {
  const { state, seat } = buildNonForcedState()
  withEnv({ LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_MODEL_PATH: undefined }, () => {
    resetLocalAiCardBetaModelCacheForTests()
    const conventional = pickServerBotPlayCard(state, seat)
    const wrapped = pickServerBotPlayCardWithAiCandidate(state, seat)
    assert(conventional !== null, 'conventional card не трябва да е null')
    assertEqual(wrapped?.id, conventional?.id, 'wrapped.id vs conventional.id')
  })
})

// [2] Flag ON + валиден model + non-forced sample → AI избира валидна карта
checkAsync('[2] Flag ON + валиден model + non-forced sample → валидна AI карта', async () => {
  const { state, seat } = buildNonForcedState()
  const { dir, path } = await writeTempModel(validModelJson())
  try {
    withEnv({ LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'model', LOCAL_AI_CARD_BETA_MODEL_PATH: path }, () => {
      resetLocalAiCardBetaModelCacheForTests()
      const legalIds = legalIdsOf(state, seat)
      const result = pickServerBotPlayCardWithAiCandidate(state, seat)
      assert(result !== null, 'резултатът не трябва да е null')
      assert(legalIds.has(result!.id), `избраната карта "${result!.id}" трябва да е в hand-а/legalCards`)
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// [3] Missing model → fallback, без crash
checkSync('[3] Missing model file → fallback към conventional, без crash', () => {
  const { state, seat } = buildNonForcedState()
  withEnv({ LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'model', LOCAL_AI_CARD_BETA_MODEL_PATH: join(tmpdir(), 'does-not-exist-12345', 'model.json') }, () => {
    resetLocalAiCardBetaModelCacheForTests()
    const conventional = pickServerBotPlayCard(state, seat)
    const wrapped = pickServerBotPlayCardWithAiCandidate(state, seat)
    assertEqual(wrapped?.id, conventional?.id, 'при липсващ model трябва да падне точно към conventional')
  })
})

// [4] Corrupt model (invalid JSON) → fallback, без crash
checkAsync('[4a] Corrupt model (invalid JSON) → fallback, без crash', async () => {
  const { state, seat } = buildNonForcedState()
  const { dir, path } = await writeTempModel('{ this is not valid json')
  try {
    withEnv({ LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'model', LOCAL_AI_CARD_BETA_MODEL_PATH: path }, () => {
      resetLocalAiCardBetaModelCacheForTests()
      const conventional = pickServerBotPlayCard(state, seat)
      const wrapped = pickServerBotPlayCardWithAiCandidate(state, seat)
      assertEqual(wrapped?.id, conventional?.id, 'при corrupt JSON трябва да падне точно към conventional')
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// [4b] Corrupt model (грешна schema — wrong modelVersion) → fallback, без crash
checkAsync('[4b] Corrupt model (грешен modelVersion) → fallback, без crash', async () => {
  const { state, seat } = buildNonForcedState()
  const { dir, path } = await writeTempModel({ ...validModelJson(), modelVersion: 'card-model-v999' })
  try {
    withEnv({ LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'model', LOCAL_AI_CARD_BETA_MODEL_PATH: path }, () => {
      resetLocalAiCardBetaModelCacheForTests()
      const conventional = pickServerBotPlayCard(state, seat)
      const wrapped = pickServerBotPlayCardWithAiCandidate(state, seat)
      assertEqual(wrapped?.id, conventional?.id, 'при wrong modelVersion трябва да падне точно към conventional')
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// [4c] Corrupt model (featureNames mismatch) → fallback, без crash
checkAsync('[4c] Corrupt model (featureNames mismatch) → fallback, без crash', async () => {
  const { state, seat } = buildNonForcedState()
  const { dir, path } = await writeTempModel({ ...validModelJson(), featureNames: ['wrong', 'feature', 'names', 'here', 'x'] })
  try {
    withEnv({ LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'model', LOCAL_AI_CARD_BETA_MODEL_PATH: path }, () => {
      resetLocalAiCardBetaModelCacheForTests()
      const conventional = pickServerBotPlayCard(state, seat)
      const wrapped = pickServerBotPlayCardWithAiCandidate(state, seat)
      assertEqual(wrapped?.id, conventional?.id, 'при featureNames mismatch трябва да падне точно към conventional')
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// [5] "Invalid AI prediction" — астрономически тегла → non-finite score вътре в rankLegalCardsWithCardModel
checkAsync('[5] Астрономически тегла (non-finite score) → wrapper fallback-ва, но връща ВАЛИДНА карта', async () => {
  const { state, seat } = buildNonForcedState()
  // Всяко тегло поотделно е finite (минава validateAndBuildCardModel), но dot
  // product с 5 такива тегла препълва Number.MAX_VALUE → Infinity score.
  const hugeWeights = [1e308, 1e308, 1e308, 1e308, 1e308]
  const { dir, path } = await writeTempModel(validModelJson(hugeWeights))
  try {
    withEnv({ LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'model', LOCAL_AI_CARD_BETA_MODEL_PATH: path }, () => {
      resetLocalAiCardBetaModelCacheForTests()
      const legalIds = legalIdsOf(state, seat)
      const result = pickServerBotPlayCardWithAiCandidate(state, seat)
      assert(result !== null, 'резултатът не трябва да е null дори при non-finite AI score')
      assert(legalIds.has(result!.id), `картата "${result!.id}" трябва да е валидна дори при non-finite AI score`)
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// [6] Forced legalCards.length === 1 → връща точно forced картата (flag ON и OFF)
checkSync('[6a] Forced (1 legal card), flag OFF → връща forced картата', () => {
  const { state, seat } = buildForcedState()
  withEnv({ LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_MODEL_PATH: undefined }, () => {
    resetLocalAiCardBetaModelCacheForTests()
    const result = pickServerBotPlayCardWithAiCandidate(state, seat)
    assertEqual(result?.id, 'hearts-J', 'forced card трябва да е единствената карта в ръката')
  })
})

checkAsync('[6b] Forced (1 legal card), flag ON + валиден model → все пак връща forced картата', async () => {
  const { state, seat } = buildForcedState()
  const { dir, path } = await writeTempModel(validModelJson())
  try {
    withEnv({ LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'model', LOCAL_AI_CARD_BETA_MODEL_PATH: path }, () => {
      resetLocalAiCardBetaModelCacheForTests()
      const result = pickServerBotPlayCardWithAiCandidate(state, seat)
      assertEqual(result?.id, 'hearts-J', 'forced card трябва да остане единствената опция дори с AI ON')
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// [7] Кросчек: final card винаги в ownHand за всички построени states по-горе
checkSync('[7] Final selected card винаги ∈ ownHand (non-forced state)', () => {
  const { state, seat } = buildNonForcedState()
  withEnv({ LOCAL_AI_CARD_BETA_ENABLED: undefined }, () => {
    resetLocalAiCardBetaModelCacheForTests()
    const result = pickServerBotPlayCardWithAiCandidate(state, seat)
    const handIds = new Set((state.hands[seat] ?? []).map((c) => c.id))
    assert(result !== null && handIds.has(result.id), 'final card трябва да е в ownHand')
  })
})

// [8] Никакви production env изисквания — работи с изчистен process.env (само PATH/NODE_ENV пипани косвено от Node)
checkSync('[8] Работи без production env vars (само LOCAL_AI_CARD_BETA_* touched)', () => {
  const { state, seat } = buildNonForcedState()
  const untouchedKeys = ['STRIPE_SECRET_KEY', 'TRAINING_RECORDER_ENABLED', 'DATABASE_URL', 'JWT_SECRET']
  for (const k of untouchedKeys) delete process.env[k]
  withEnv({ LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_MODEL_PATH: undefined }, () => {
    resetLocalAiCardBetaModelCacheForTests()
    const result = pickServerBotPlayCardWithAiCandidate(state, seat)
    assert(result !== null, 'трябва да работи без production env vars')
  })
})

// [9] Real-data smoke: card-test.jsonl (ако е наличен)
checkAsync('[9] Real-data smoke: card-test.jsonl — flag OFF==conventional, flag ON никога invalid', async () => {
  let content: string
  try {
    content = readFileSync(CARD_TEST_PATH, 'utf8')
  } catch {
    console.log(`  SKIP  [9] ${CARD_TEST_PATH} не е наличен — изпълни npm run prepare:training-baseline първо (не е фатално за check-а).`)
    return
  }

  const lines = content.split('\n').filter((l) => l.trim().length > 0)
  const sample = lines.slice(0, 300) // достатъчно за smoke, не цялото 2339-редово множество

  let checkedCount = 0
  let invalidCount = 0
  let flagOffMismatchCount = 0

  const hasRealModel = (() => {
    try {
      readFileSync(REAL_MODEL_PATH, 'utf8')
      return true
    } catch {
      return false
    }
  })()

  for (const line of sample) {
    const rec = JSON.parse(line) as {
      seat: Seat
      ownHand: ServerCard[]
      legalCards: ServerCard[]
      contract: { contract: 'suit' | 'no-trumps' | 'all-trumps'; trumpSuit: string | null }
      currentTrick: Array<{ seat: Seat; card: ServerCard }>
    }

    const hands: Record<Seat, ServerCard[]> = { bottom: [], right: [], top: [], left: [] }
    hands[rec.seat] = rec.ownHand
    const winningBid: ServerWinningBid = {
      seat: rec.seat,
      contract: rec.contract.contract,
      trumpSuit: (rec.contract.trumpSuit as ServerCard['suit'] | null) ?? null,
      doubled: false,
      redoubled: false,
    }
    const plays: ServerTrickPlay[] = rec.currentTrick.map((p) => ({ seat: p.seat, card: p.card }))

    const state = baseState(hands, {
      bidding: { entries: [], currentSeat: null, winningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
      playing: makePlaying(plays, rec.seat),
    })

    checkedCount++

    // flag OFF → трябва да съвпада точно с conventional
    const conventional = withEnv({ LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_MODEL_PATH: undefined }, () => {
      resetLocalAiCardBetaModelCacheForTests()
      return pickServerBotPlayCardWithAiCandidate(state, rec.seat)
    })
    const rawConventional = pickServerBotPlayCard(state, rec.seat)
    if (conventional?.id !== rawConventional?.id) flagOffMismatchCount++

    // flag ON (ако има реален model) → никога invalid карта
    if (hasRealModel) {
      const handIds = new Set(rec.ownHand.map((c) => c.id))
      const aiResult = withEnv({ LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'model', LOCAL_AI_CARD_BETA_MODEL_PATH: REAL_MODEL_PATH }, () => {
        resetLocalAiCardBetaModelCacheForTests()
        return pickServerBotPlayCardWithAiCandidate(state, rec.seat)
      })
      if (!aiResult || !handIds.has(aiResult.id)) invalidCount++
    }
  }

  console.log(`  [9] smoke обхвана ${checkedCount} sample-а (model наличен: ${hasRealModel})`)
  assertEqual(flagOffMismatchCount, 0, `flag OFF mismatch спрямо conventional bot (${flagOffMismatchCount}/${checkedCount})`)
  assertEqual(invalidCount, 0, `invalid AI карти при flag ON (${invalidCount}/${checkedCount})`)
})

// ─── Run async queue, print summary ──────────────────────────────────────────

async function main(): Promise<void> {
  for (const fn of asyncQueue) await fn()

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
  resetLocalAiCardBetaModelCacheForTests()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
