/**
 * checkLocalAiRuleE2ObservationTrace.ts
 *
 * Local check script for server/src/ai/cardAdvisorSignalRuleE2.ts (pure
 * observational Rule E2 helper) and its trace-only wiring in
 * server/src/ai/localAiCardBeta.ts (LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED).
 * Does not start a real game — constructed states only, same conventions as
 * checkLocalAiCardBetaAdvisor.ts.
 *
 * Two layers of tests:
 *  (a) UNIT tests directly against observeRuleE2NoPointFeed() — signal
 *      detection, A-D shadow-guard suppression, no-point-feed suppression,
 *      forced-case handling, determinism, safety (suggestion always ∈
 *      legalCards ∩ ownHand).
 *  (b) INTEGRATION tests via pickServerBotPlayCardWithAiCandidate — flag
 *      OFF ⇒ no ruleE2Observation key in the trace record at all; flag ON ⇒
 *      key present; Rule E2 NEVER changes finalCard/decisionSource; forced
 *      decisions never have wouldFire=true; exception safety (corrupt
 *      context does not crash the game, only affects the trace's own error
 *      field).
 *
 * Не пипа production .env, не прави network/SSH/deploy. Не изисква изрично
 * production env.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  pickServerBotPlayCardWithAiCandidate,
  resetLocalAiCardBetaModelCacheForTests,
  resetLocalAiCardBetaTraceStateForTests,
  type LocalAiCardBetaTraceRecord,
} from '../src/ai/localAiCardBeta.js'
import { observeRuleE2NoPointFeed, type RuleE2ObservationInput } from '../src/ai/cardAdvisorSignalRuleE2.js'
import { parseJsonlStrict } from './summarizeLocalAiCardBetaTrace.js'
import type {
  ServerAuthoritativeGameState,
  ServerCard,
  ServerCompletedTrick,
  ServerPlayerState,
  ServerPlayingState,
  ServerTrickPlay,
  ServerWinningBid,
} from '../src/game/serverGameTypes.js'
import type { Seat, Team } from '../src/core/serverTypes.js'

void resolve, dirname, fileURLToPath // (paths not needed beyond module resolution here, kept for parity with sibling check scripts)

// ─── Test runner (same style as checkLocalAiCardBetaAdvisor.ts) ─────────────

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

function card(suit: string, rank: string): ServerCard {
  return { id: `${suit}-${rank}`, suit: suit as ServerCard['suit'], rank: rank as ServerCard['rank'] }
}

// ─── State builders ───────────────────────────────────────────────────────────

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']

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

function baseState(hands: Record<Seat, ServerCard[]>, overrides: Partial<ServerAuthoritativeGameState> = {}): ServerAuthoritativeGameState {
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
    score: { round: { tricks: es, declarations: es, belote: es, lastTen: es, capot: es, total: es }, match: { teamA: 0, teamB: 0 }, carryOver: es },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
    ...overrides,
  }
}

function makePlaying(currentTrickPlays: ServerTrickPlay[], currentTurnSeat: Seat | null, completedTricks: ServerCompletedTrick[], trickIndex: number): ServerPlayingState {
  return {
    hasStarted: true,
    currentTurnSeat,
    currentTrick: { leaderSeat: currentTrickPlays[0]?.seat ?? null, currentSeat: currentTurnSeat, plays: currentTrickPlays, winnerSeat: null, trickIndex },
    completedTricks,
    lastCompletedTrickWinnerSeat: null,
    lastCompletedTrickWinnerTeam: null,
    wonTricksBySeat: emptyWon(),
    wonTricksByTeam: { A: [], B: [] },
  }
}

// A completed trick where 'top' (bottom's partner) leads hearts with the Ace
// (a strong, unambiguous "high card lead" signal) — shared across fixtures.
// Turn order from leader 'top': top → left → bottom → right.
const PARTNER_HEARTS_ACE_LEAD_TRICK: ServerCompletedTrick = {
  trickIndex: 0,
  leaderSeat: 'top',
  plays: [
    { seat: 'top', card: card('hearts', 'A') },
    { seat: 'left', card: card('hearts', '7') },
    { seat: 'bottom', card: card('hearts', '8') },
    { seat: 'right', card: card('hearts', '9') },
  ],
  winnerSeat: 'top',
  winningTeam: 'A',
}

function baseInput(overrides: Partial<RuleE2ObservationInput> = {}): RuleE2ObservationInput {
  const hand = [card('hearts', 'K'), card('hearts', 'Q'), card('clubs', '7')]
  const state = baseState(
    { bottom: hand, right: [], top: [], left: [] },
    {
      bidding: { entries: [], currentSeat: null, winningBid: { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false } as ServerWinningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
      playing: makePlaying([], 'bottom', [PARTNER_HEARTS_ACE_LEAD_TRICK], 1),
    },
  )
  return {
    state,
    seat: 'bottom',
    partnerSeat: 'top',
    legalCards: [card('hearts', 'K'), card('hearts', 'Q')],
    ownHand: hand,
    contract: 'no-trumps',
    trumpSuit: null,
    currentTrickPlays: [],
    ...overrides,
  }
}

// ─── (a) Unit tests: observeRuleE2NoPointFeed() directly ────────────────────

console.log('\ncheckLocalAiRuleE2ObservationTrace\n')

checkSync('[A] Signal detected, no A-D override, no conflict → wouldFire=true, suggestedCard=highest_in_suit', () => {
  const result = observeRuleE2NoPointFeed(baseInput())
  assert(result.wouldEvaluate, 'wouldEvaluate трябва да е true')
  assert(result.wouldFire, 'wouldFire трябва да е true')
  assertEqual(result.signalSuit, 'hearts', 'signalSuit')
  assertEqual(result.suggestedCard, 'hearts-K', 'suggestedCard (highest_in_suit: K > Q)')
  assertEqual(result.suppressionReason, null, 'suppressionReason')
  assert(result.safety.suggestionInLegalCards, 'suggestionInLegalCards')
  assert(result.safety.suggestionInOwnHand, 'suggestionInOwnHand')
})

checkSync('[B] No partner signal (empty completedTricks) → suppressionReason=no_partner_signal', () => {
  const input = baseInput({
    state: baseState(
      { bottom: [card('hearts', 'K'), card('hearts', 'Q'), card('clubs', '7')], right: [], top: [], left: [] },
      {
        bidding: { entries: [], currentSeat: null, winningBid: { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false } as ServerWinningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
        playing: makePlaying([], 'bottom', [], 1),
      },
    ),
  })
  const result = observeRuleE2NoPointFeed(input)
  assert(!result.wouldFire, 'не трябва да fire-не без сигнал')
  assertEqual(result.suppressionReason, 'no_partner_signal', 'suppressionReason')
  assertEqual(result.suggestedCard, null, 'suggestedCard трябва да е null')
})

checkSync('[C] A-D tactical guard already fires (Rule C clean winner) → suppressionReason=tactical_guard_already_applied', () => {
  // legalCards[0] е clean winner (Ace е винаги топ ранг в no-trumps) → Rule C
  // би override-нал в shadow A-D проверката, независимо от Rule E2 сигнала.
  const input = baseInput({
    legalCards: [card('diamonds', 'A'), card('hearts', '7')],
    ownHand: [card('diamonds', 'A'), card('hearts', '7'), card('clubs', '9')],
    currentTrickPlays: [{ seat: 'right', card: card('clubs', '7') }], // opponent led, 0 points, not urgent
  })
  const result = observeRuleE2NoPointFeed(input)
  assert(!result.wouldFire, 'не трябва да fire-не, когато A-D вече е override-нал')
  assertEqual(result.suppressionReason, 'tactical_guard_already_applied', 'suppressionReason')
  assertEqual(result.signalSuit, 'hearts', 'signalSuit трябва все пак да е populated (сигналът съществува, само е suppressed)')
})

checkSync('[D] No legal card in signaled suit → suppressionReason=no_legal_card_in_signal_suit', () => {
  const input = baseInput({
    legalCards: [card('clubs', '7'), card('diamonds', '8')], // no hearts among legal cards
    ownHand: [card('clubs', '7'), card('diamonds', '8')],
  })
  const result = observeRuleE2NoPointFeed(input)
  assert(!result.wouldFire, 'не трябва да fire-не без легална карта в сигнализираната боя')
  assertEqual(result.suppressionReason, 'no_legal_card_in_signal_suit', 'suppressionReason')
})

checkSync('[E] opponentCurrentlyWinning + pointsInTrick>=10 → suppressionReason=opponent_winning_10_plus_points', () => {
  const input = baseInput({
    currentTrickPlays: [{ seat: 'right', card: card('clubs', 'A') }], // opponent winning, clubs-A = 11 points
  })
  const result = observeRuleE2NoPointFeed(input)
  assert(!result.wouldFire, 'не трябва да fire-не при opponent winning с 10+ точки')
  assertEqual(result.suppressionReason, 'opponent_winning_10_plus_points', 'suppressionReason')
})

checkSync('[F] would_feed_points_to_opponent (opponent winning, candidate carries points, points<10)', () => {
  // opponent печели с ниска карта (малко точки в трика), но самата suggested карта носи точки.
  const input = baseInput({
    currentTrickPlays: [{ seat: 'right', card: card('clubs', '7') }], // opponent winning, 0 points so far
    legalCards: [card('hearts', 'K'), card('hearts', '7')], // hearts-K carries points (4), would be candidate (higher rank)
    ownHand: [card('hearts', 'K'), card('hearts', '7'), card('clubs', '8')],
  })
  const result = observeRuleE2NoPointFeed(input)
  assert(!result.wouldFire, 'не трябва да fire-не, ако би нахранило противника с точки')
  assertEqual(result.suppressionReason, 'would_feed_points_to_opponent', 'suppressionReason')
})

checkSync('[G] Forced (legalCards.length<=1) → not_applicable, wouldEvaluate=false', () => {
  const input = baseInput({ legalCards: [card('hearts', 'K')] })
  const result = observeRuleE2NoPointFeed(input)
  assert(!result.wouldFire, 'forced не трябва никога да fire-не')
  assertEqual(result.wouldEvaluate, false, 'wouldEvaluate трябва да е false за forced')
  assertEqual(result.suppressionReason, 'not_applicable', 'suppressionReason')
})

checkSync('[H] Deterministic — identical input produces identical result', () => {
  const input = baseInput()
  const r1 = observeRuleE2NoPointFeed(input)
  const r2 = observeRuleE2NoPointFeed(baseInput())
  assertEqual(JSON.stringify(r1), JSON.stringify(r2), 'резултатите трябва да са byte-identical')
})

checkSync('[I] Missing playing state (state.playing=null) does not throw — degrades to no signal', () => {
  const input = baseInput({
    state: baseState(
      { bottom: [card('hearts', 'K'), card('hearts', 'Q'), card('clubs', '7')], right: [], top: [], left: [] },
      { playing: null, currentTrick: { leaderSeat: null, currentSeat: 'bottom', plays: [], winnerSeat: null, trickIndex: 0 } },
    ),
  })
  const result = observeRuleE2NoPointFeed(input)
  assert(!result.wouldFire, 'без completedTricks не трябва да fire-не')
  assertEqual(result.suppressionReason, 'no_partner_signal', 'suppressionReason')
})

// ─── (b) Integration tests: pickServerBotPlayCardWithAiCandidate + trace ────

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

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'local-ai-rule-e2-trace-check-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function readTraceRecords(tracePath: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(tracePath, 'utf8')
  const { records, errors } = parseJsonlStrict(content, 'trace')
  assert(errors.length === 0, `trace parse errors: ${errors.join('; ')}`)
  return records.map((r) => r.record as unknown as Record<string, unknown>)
}

function buildIntegrationState(): { state: ServerAuthoritativeGameState; seat: Seat } {
  const hand = [card('hearts', 'K'), card('hearts', 'Q'), card('clubs', '7')]
  const state = baseState(
    { bottom: hand, right: [], top: [], left: [] },
    {
      bidding: { entries: [], currentSeat: null, winningBid: { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false } as ServerWinningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
      playing: makePlaying([], 'bottom', [PARTNER_HEARTS_ACE_LEAD_TRICK], 1),
    },
  )
  return { state, seat: 'bottom' }
}

function buildForcedIntegrationState(): { state: ServerAuthoritativeGameState; seat: Seat } {
  const hand = [card('hearts', 'K')]
  const state = baseState(
    { bottom: hand, right: [], top: [], left: [] },
    {
      bidding: { entries: [], currentSeat: null, winningBid: { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false } as ServerWinningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
      playing: makePlaying([], 'bottom', [PARTNER_HEARTS_ACE_LEAD_TRICK], 1),
    },
  )
  return { state, seat: 'bottom' }
}

checkAsync('[I1] Flag OFF → trace record няма ruleE2Observation key изобщо', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const { state, seat } = buildIntegrationState()
    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_PATH: tracePath },
      () => {
        resetLocalAiCardBetaModelCacheForTests()
        resetLocalAiCardBetaTraceStateForTests()
        pickServerBotPlayCardWithAiCandidate(state, seat)
      },
    )
    const records = await readTraceRecords(tracePath)
    assertEqual(records.length, 1, 'трябва да има точно 1 trace ред')
    assert(!('ruleE2Observation' in records[0]!), 'ruleE2Observation КЛЮЧЪТ не трябва да съществува когато flag-ът е OFF')
  })
})

checkAsync('[I2] Flag ON → trace record ИМА ruleE2Observation payload', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const { state, seat } = buildIntegrationState()
    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_TRACE_PATH: tracePath },
      () => {
        resetLocalAiCardBetaModelCacheForTests()
        resetLocalAiCardBetaTraceStateForTests()
        pickServerBotPlayCardWithAiCandidate(state, seat)
      },
    )
    const records = await readTraceRecords(tracePath)
    assertEqual(records.length, 1, 'трябва да има точно 1 trace ред')
    const obs = records[0]!['ruleE2Observation'] as Record<string, unknown> | undefined
    assert(obs !== undefined, 'ruleE2Observation трябва да съществува когато flag-ът е ON')
    assertEqual(obs!['enabled'], true, 'enabled')
    assertEqual(obs!['variant'], 'e2_no_point_feed', 'variant')
  })
})

checkAsync('[I3] Rule E2 НИКОГА не променя finalCard — сравни flag OFF vs ON върху същия state', async () => {
  await withTempDir(async (dir) => {
    const tracePathOff = join(dir, 'off.jsonl')
    const tracePathOn = join(dir, 'on.jsonl')
    const { state: stateOff, seat: seatOff } = buildIntegrationState()
    const { state: stateOn, seat: seatOn } = buildIntegrationState()

    const resultOff = withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_PATH: tracePathOff },
      () => {
        resetLocalAiCardBetaModelCacheForTests()
        resetLocalAiCardBetaTraceStateForTests()
        return pickServerBotPlayCardWithAiCandidate(stateOff, seatOff)
      },
    )
    const resultOn = withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_TRACE_PATH: tracePathOn },
      () => {
        resetLocalAiCardBetaModelCacheForTests()
        resetLocalAiCardBetaTraceStateForTests()
        return pickServerBotPlayCardWithAiCandidate(stateOn, seatOn)
      },
    )
    assertEqual(resultOff?.id, resultOn?.id, 'finalCard трябва да е идентичен независимо от Rule E2 observation флага')

    const recordsOn = await readTraceRecords(tracePathOn)
    const decisionSourceOn = recordsOn[0]!['decisionSource']
    const recordsOff = await readTraceRecords(tracePathOff)
    assertEqual(decisionSourceOn, recordsOff[0]!['decisionSource'], 'decisionSource също не трябва да се променя от Rule E2 observation')
  })
})

checkAsync('[I4] Forced decision + flag ON → ruleE2Observation.wouldFire=false, finalCard = единствената карта', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const { state, seat } = buildForcedIntegrationState()
    const result = withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_TRACE_PATH: tracePath },
      () => {
        resetLocalAiCardBetaModelCacheForTests()
        resetLocalAiCardBetaTraceStateForTests()
        return pickServerBotPlayCardWithAiCandidate(state, seat)
      },
    )
    assertEqual(result?.id, 'hearts-K', 'forced карта')
    const records = await readTraceRecords(tracePath)
    const obs = records[0]!['ruleE2Observation'] as Record<string, unknown>
    assertEqual(obs['wouldFire'], false, 'forced decision никога не трябва да wouldFire=true')
  })
})

checkAsync('[I5] Advisor policy (A-D) + flag ON → ruleE2Observation все още присъства и е консистентен', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const { state, seat } = buildIntegrationState()
    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'advisor', LOCAL_AI_CARD_BETA_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED: 'true', LOCAL_AI_CARD_BETA_TRACE_PATH: tracePath },
      () => {
        resetLocalAiCardBetaModelCacheForTests()
        resetLocalAiCardBetaTraceStateForTests()
        pickServerBotPlayCardWithAiCandidate(state, seat)
      },
    )
    const records = await readTraceRecords(tracePath)
    const obs = records[0]!['ruleE2Observation'] as Record<string, unknown>
    assert(obs !== undefined, 'ruleE2Observation трябва да присъства и в advisor policy режим')
    assertEqual(obs['error'], null, 'не трябва да има exception')
  })
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
