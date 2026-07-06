/**
 * checkLocalAiShadowTrace.ts
 *
 * Local check script for server/src/ai/localAiCardShadowTrace.ts (production-safe
 * shadow observation mode, LOCAL_AI_CARD_SHADOW_TRACE_ENABLED) and its wiring in
 * server/src/ai/localAiCardBeta.ts. Does not start a real game — constructed
 * states only, same conventions as checkLocalAiRuleE2ObservationTrace.ts /
 * checkLocalAiCardBetaAdvisor.ts.
 *
 * Two layers of tests:
 *  (a) UNIT tests directly against computeAdvisorV0Shadow()/computeRuleE2Shadow()
 *      — hand-crafted conventionalCard values, no dependency on what the real
 *      3245-line conventional bot (pickServerBotPlayCard.ts) actually picks.
 *  (b) INTEGRATION tests via pickServerBotPlayCardWithAiCandidate — flags OFF
 *      ⇒ zero behavior change and no trace file written at all; shadow ON ⇒
 *      finalSelectedCard always equals conventionalCard; observations may
 *      suggest a different card but never change it; forced decisions never
 *      show an active override/fire; invalid suggestions outside
 *      legalCards/ownHand = 0; trace write failure never breaks the decision;
 *      deterministic; existing beta/advisor behavior unaffected when combined.
 *
 * Не пипа production .env, не прави network/SSH/deploy. Не изисква изрично
 * production env.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  pickServerBotPlayCardWithAiCandidate,
  resetLocalAiCardBetaModelCacheForTests,
  resetLocalAiCardBetaTraceStateForTests,
} from '../src/ai/localAiCardBeta.js'
import { pickServerBotPlayCard } from '../src/game/pickServerBotPlayCard.js'
import {
  computeAdvisorV0Shadow,
  computeRuleE2Shadow,
  resetLocalAiCardShadowTraceStateForTests,
} from '../src/ai/localAiCardShadowTrace.js'
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

// ─── Test runner (same style as sibling check scripts) ──────────────────────

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

// ─── State builders (same conventions as checkLocalAiRuleE2ObservationTrace.ts) ─

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

// Same shared fixture as checkLocalAiRuleE2ObservationTrace.ts — completed
// trick where partner ('top') leads hearts with the Ace (unambiguous
// "high card lead" partner signal).
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

console.log('\ncheckLocalAiShadowTrace\n')

// ─── (a) Unit tests: computeAdvisorV0Shadow() / computeRuleE2Shadow() ───────

checkSync('[A] computeAdvisorV0Shadow: partner winning, overtake unnecessary → wouldOverride=true, avoid_overtaking_partner', () => {
  const currentTrickPlays: ServerTrickPlay[] = [
    { seat: 'right', card: card('hearts', '9') },
    { seat: 'top', card: card('hearts', 'J') }, // partner, currently winning
  ]
  const hand = [card('hearts', 'A'), card('hearts', '7'), card('clubs', '9')]
  const legalCards = [card('hearts', 'A'), card('hearts', '7')]
  const state = baseState(
    { bottom: hand, right: [], top: [], left: [] },
    {
      bidding: { entries: [], currentSeat: null, winningBid: { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false } as ServerWinningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
      playing: makePlaying(currentTrickPlays, 'bottom', [], 0),
    },
  )
  const conventionalCard = card('hearts', 'A') // would overtake partner's J unnecessarily
  const obs = computeAdvisorV0Shadow(state, 'bottom', 'top', 'no-trumps', null, hand, legalCards, currentTrickPlays, conventionalCard)
  assert(obs.wouldOverride, 'трябва wouldOverride=true')
  assertEqual(obs.suggestedCard, 'hearts-7', 'suggestedCard трябва да е safe discard-а')
  assertEqual(obs.reason, 'avoid_overtaking_partner', 'reason')
  assert(obs.wouldDifferFromConventional, 'wouldDifferFromConventional трябва да е true')
  assert(obs.safety.suggestionInLegalCards, 'suggestionInLegalCards')
  assert(obs.safety.suggestionInOwnHand, 'suggestionInOwnHand')
  assertEqual(obs.error, null, 'error')
})

checkSync('[B] computeAdvisorV0Shadow: без силен сигнал → wouldOverride=false, suggestedCard=null', () => {
  const currentTrickPlays: ServerTrickPlay[] = []
  const hand = [card('clubs', '7'), card('diamonds', '8')]
  const legalCards = [card('clubs', '7'), card('diamonds', '8')]
  const state = baseState(
    { bottom: hand, right: [], top: [], left: [] },
    {
      bidding: { entries: [], currentSeat: null, winningBid: { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false } as ServerWinningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
      playing: makePlaying(currentTrickPlays, 'bottom', [], 0),
    },
  )
  const obs = computeAdvisorV0Shadow(state, 'bottom', 'top', 'no-trumps', null, hand, legalCards, currentTrickPlays, card('clubs', '7'))
  assert(!obs.wouldOverride, 'не трябва wouldOverride')
  assertEqual(obs.suggestedCard, null, 'suggestedCard')
  assert(!obs.wouldDifferFromConventional, 'wouldDifferFromConventional')
})

checkSync('[C] computeAdvisorV0Shadow: forced (legalCards.length<=1) → wouldOverride=false', () => {
  const hand = [card('hearts', 'K')]
  const legalCards = [card('hearts', 'K')]
  const state = baseState(
    { bottom: hand, right: [], top: [], left: [] },
    {
      bidding: { entries: [], currentSeat: null, winningBid: { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false } as ServerWinningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
      playing: makePlaying([], 'bottom', [], 0),
    },
  )
  const obs = computeAdvisorV0Shadow(state, 'bottom', 'top', 'no-trumps', null, hand, legalCards, [], card('hearts', 'K'))
  assert(!obs.wouldOverride, 'forced не трябва никога wouldOverride')
  assertEqual(obs.suggestedCard, null, 'suggestedCard')
})

checkSync('[D] computeRuleE2Shadow: partner signal detected, no A-D conflict → wouldFire=true', () => {
  const hand = [card('hearts', 'K'), card('hearts', 'Q'), card('clubs', '7')]
  const legalCards = [card('hearts', 'K'), card('hearts', 'Q')]
  const state = baseState(
    { bottom: hand, right: [], top: [], left: [] },
    {
      bidding: { entries: [], currentSeat: null, winningBid: { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false } as ServerWinningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
      playing: makePlaying([], 'bottom', [PARTNER_HEARTS_ACE_LEAD_TRICK], 1),
    },
  )
  const conventionalCard = card('hearts', 'Q')
  const obs = computeRuleE2Shadow(state, 'bottom', 'top', legalCards, hand, 'no-trumps', null, [], conventionalCard)
  assert(obs.wouldFire, 'wouldFire трябва да е true')
  assertEqual(obs.suggestedCard, 'hearts-K', 'suggestedCard (highest_in_suit)')
  assertEqual(obs.signalSuit, 'hearts', 'signalSuit')
  assert(obs.wouldDifferFromConventional, 'wouldDifferFromConventional (K != Q)')
  assert(obs.safety.suggestionInLegalCards, 'suggestionInLegalCards')
  assert(obs.safety.suggestionInOwnHand, 'suggestionInOwnHand')
  assertEqual(obs.error, null, 'error')
})

checkSync('[E] computeRuleE2Shadow: без partner signal → wouldFire=false, suppressionReason=no_partner_signal', () => {
  const hand = [card('hearts', 'K'), card('hearts', 'Q'), card('clubs', '7')]
  const legalCards = [card('hearts', 'K'), card('hearts', 'Q')]
  const state = baseState(
    { bottom: hand, right: [], top: [], left: [] },
    {
      bidding: { entries: [], currentSeat: null, winningBid: { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false } as ServerWinningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
      playing: makePlaying([], 'bottom', [], 1),
    },
  )
  const obs = computeRuleE2Shadow(state, 'bottom', 'top', legalCards, hand, 'no-trumps', null, [], card('hearts', 'Q'))
  assert(!obs.wouldFire, 'не трябва wouldFire')
  assertEqual(obs.suppressionReason, 'no_partner_signal', 'suppressionReason')
  assertEqual(obs.suggestedCard, null, 'suggestedCard')
})

checkSync('[F] computeRuleE2Shadow: forced (legalCards.length<=1) → wouldFire=false, suppressionReason=not_applicable', () => {
  const hand = [card('hearts', 'K')]
  const legalCards = [card('hearts', 'K')]
  const state = baseState(
    { bottom: hand, right: [], top: [], left: [] },
    {
      bidding: { entries: [], currentSeat: null, winningBid: { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false } as ServerWinningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
      playing: makePlaying([], 'bottom', [PARTNER_HEARTS_ACE_LEAD_TRICK], 1),
    },
  )
  const obs = computeRuleE2Shadow(state, 'bottom', 'top', legalCards, hand, 'no-trumps', null, [], card('hearts', 'K'))
  assert(!obs.wouldFire, 'forced не трябва никога wouldFire')
  assertEqual(obs.suppressionReason, 'not_applicable', 'suppressionReason')
})

// ─── (b) Integration tests via pickServerBotPlayCardWithAiCandidate ─────────

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
  const dir = await mkdtemp(join(tmpdir(), 'local-ai-shadow-trace-check-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function readShadowTraceRecords(tracePath: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(tracePath, 'utf8')
  const lines = content.split('\n').filter((l) => l.trim().length > 0)
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>)
}

function resetAllStateForTests(): void {
  resetLocalAiCardBetaModelCacheForTests()
  resetLocalAiCardBetaTraceStateForTests()
  resetLocalAiCardShadowTraceStateForTests()
}

function buildNonForcedState(): { state: ServerAuthoritativeGameState; seat: Seat } {
  const seat: Seat = 'bottom'
  const hand: ServerCard[] = [card('hearts', 'K'), card('hearts', 'Q'), card('clubs', '7')]
  const hands: Record<Seat, ServerCard[]> = { bottom: hand, right: [], top: [], left: [] }
  const winningBid: ServerWinningBid = { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false }
  const state = baseState(hands, {
    bidding: { entries: [], currentSeat: null, winningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    playing: makePlaying([], seat, [PARTNER_HEARTS_ACE_LEAD_TRICK], 1),
  })
  return { state, seat }
}

function buildForcedState(): { state: ServerAuthoritativeGameState; seat: Seat } {
  const seat: Seat = 'bottom'
  const hand: ServerCard[] = [card('hearts', 'K')]
  const hands: Record<Seat, ServerCard[]> = { bottom: hand, right: [], top: [], left: [] }
  const winningBid: ServerWinningBid = { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false }
  const state = baseState(hands, {
    bidding: { entries: [], currentSeat: null, winningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    playing: makePlaying([], seat, [PARTNER_HEARTS_ACE_LEAD_TRICK], 1),
  })
  return { state, seat }
}

checkSync('[I1] Всички флагове OFF → точно pickServerBotPlayCard(state, seat), НИКАКЪВ trace файл', () => {
  const { state, seat } = buildNonForcedState()
  const tracePath = join(tmpdir(), `local-ai-shadow-trace-check-i1-${Date.now()}.jsonl`)
  withEnv(
    { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: undefined, LOCAL_AI_CARD_SHADOW_TRACE_ENABLED: undefined, LOCAL_AI_CARD_SHADOW_TRACE_PATH: tracePath },
    () => {
      resetAllStateForTests()
      const conventional = pickServerBotPlayCard(state, seat)
      const wrapped = pickServerBotPlayCardWithAiCandidate(state, seat)
      assertEqual(wrapped?.id, conventional?.id, 'wrapped.id vs conventional.id')
    },
  )
  assert(!existsSync(tracePath), 'НЕ трябва да съществува trace файл, когато всички флагове са OFF')
})

checkAsync('[I2] Shadow ON (само), aiEnabled OFF → finalSelectedCard === conventionalCard, finalDecisionSource=conventional_shadow', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const { state, seat } = buildNonForcedState()
    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: undefined, LOCAL_AI_CARD_SHADOW_TRACE_ENABLED: 'true', LOCAL_AI_CARD_SHADOW_TRACE_PATH: tracePath },
      () => {
        resetAllStateForTests()
        pickServerBotPlayCardWithAiCandidate(state, seat)
      },
    )
    const records = await readShadowTraceRecords(tracePath)
    assertEqual(records.length, 1, 'трябва да има точно 1 shadow trace ред')
    const rec = records[0]!
    assertEqual(rec['finalSelectedCard'], rec['conventionalCard'], 'finalSelectedCard трябва да е точно conventionalCard')
    assertEqual(rec['finalDecisionSource'], 'conventional_shadow', 'finalDecisionSource')
  })
})

checkAsync('[I3] Rule E2 сигнал наличен (wouldFire потенциално true) → finalSelectedCard пак === conventionalCard', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const { state, seat } = buildNonForcedState() // hand includes hearts-K/Q, PARTNER_HEARTS_ACE_LEAD_TRICK signal
    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: undefined, LOCAL_AI_CARD_SHADOW_TRACE_ENABLED: 'true', LOCAL_AI_CARD_SHADOW_TRACE_PATH: tracePath },
      () => {
        resetAllStateForTests()
        pickServerBotPlayCardWithAiCandidate(state, seat)
      },
    )
    const records = await readShadowTraceRecords(tracePath)
    const rec = records[0]!
    assertEqual(rec['finalSelectedCard'], rec['conventionalCard'], 'finalSelectedCard трябва да остане conventionalCard дори при Rule E2/advisor сигнал')
    const ruleE2 = rec['ruleE2Observation'] as Record<string, unknown>
    assert(ruleE2 !== undefined, 'ruleE2Observation трябва да присъства')
    assertEqual(ruleE2['enabled'], true, 'ruleE2Observation.enabled')
    // Наблюдението МОЖЕ да предложи различна карта — но не трябва да променя finalSelectedCard (вече проверено по-горе).
  })
})

checkAsync('[I4] Forced decision + shadow ON → нито advisorV0, нито RuleE2 показват активен override/fire', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    const { state, seat } = buildForcedState()
    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: undefined, LOCAL_AI_CARD_SHADOW_TRACE_ENABLED: 'true', LOCAL_AI_CARD_SHADOW_TRACE_PATH: tracePath },
      () => {
        resetAllStateForTests()
        const result = pickServerBotPlayCardWithAiCandidate(state, seat)
        assertEqual(result?.id, 'hearts-K', 'forced карта')
      },
    )
    const records = await readShadowTraceRecords(tracePath)
    const rec = records[0]!
    assertEqual(rec['isForced'], true, 'isForced')
    const advisorV0 = rec['advisorV0Observation'] as Record<string, unknown>
    const ruleE2 = rec['ruleE2Observation'] as Record<string, unknown>
    assertEqual(advisorV0['wouldOverride'], false, 'forced decision никога не трябва advisorV0.wouldOverride=true')
    assertEqual(ruleE2['wouldFire'], false, 'forced decision никога не трябва ruleE2.wouldFire=true')
  })
})

checkAsync('[I5] Safety: 0 invalid suggestions извън legalCards/ownHand в trace-а', async () => {
  await withTempDir(async (dir) => {
    const tracePath = join(dir, 'card-decisions.jsonl')
    for (const { state, seat } of [buildNonForcedState(), buildForcedState()]) {
      withEnv(
        { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: undefined, LOCAL_AI_CARD_SHADOW_TRACE_ENABLED: 'true', LOCAL_AI_CARD_SHADOW_TRACE_PATH: tracePath },
        () => {
          resetAllStateForTests()
          pickServerBotPlayCardWithAiCandidate(state, seat)
        },
      )
    }
    const records = await readShadowTraceRecords(tracePath)
    assert(records.length >= 2, 'трябва поне 2 записа')
    let invalidLegal = 0
    let invalidOwnHand = 0
    for (const rec of records) {
      const advisorV0 = rec['advisorV0Observation'] as Record<string, unknown>
      const ruleE2 = rec['ruleE2Observation'] as Record<string, unknown>
      const advisorSafety = advisorV0['safety'] as Record<string, unknown>
      const ruleE2Safety = ruleE2['safety'] as Record<string, unknown>
      if (advisorSafety['suggestionInLegalCards'] === false) invalidLegal++
      if (advisorSafety['suggestionInOwnHand'] === false) invalidOwnHand++
      if (ruleE2Safety['suggestionInLegalCards'] === false) invalidLegal++
      if (ruleE2Safety['suggestionInOwnHand'] === false) invalidOwnHand++
    }
    assertEqual(invalidLegal, 0, 'invalid suggestions извън legalCards')
    assertEqual(invalidOwnHand, 0, 'invalid suggestions извън ownHand')
  })
})

checkSync('[I6] Trace write failure (недостъпна директория) не чупи решението', () => {
  // Parent path component е ФАЙЛ, не директория → mkdirSync(recursive) хвърля ENOTDIR.
  const { state, seat } = buildNonForcedState()
  const blockerDir = tmpdir()
  const blockerFile = join(blockerDir, `local-ai-shadow-blocker-${Date.now()}.txt`)
  return withEnv(
    { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: undefined, LOCAL_AI_CARD_SHADOW_TRACE_ENABLED: 'true', LOCAL_AI_CARD_SHADOW_TRACE_PATH: join(blockerFile, 'subdir', 'card-decisions.jsonl') },
    () => {
      resetAllStateForTests()
      // blockerFile трябва да съществува като ФАЙЛ (не директория), за да предизвика ENOTDIR.
      writeFileSync(blockerFile, 'not a directory', 'utf8')
      let result: ServerCard | null = null
      let threw = false
      try {
        result = pickServerBotPlayCardWithAiCandidate(state, seat)
      } catch {
        threw = true
      }
      assert(!threw, 'pickServerBotPlayCardWithAiCandidate НЕ трябва да хвърля при trace write failure')
      assert(result !== null, 'решението трябва да продължи нормално')
      rmSync(blockerFile, { force: true })
    },
  )
})

checkAsync('[I7] Deterministic — идентичен state дава идентичен shadow trace ред (без timestamp)', async () => {
  await withTempDir(async (dir) => {
    const tracePathA = join(dir, 'a.jsonl')
    const tracePathB = join(dir, 'b.jsonl')
    const { state: stateA, seat: seatA } = buildNonForcedState()
    const { state: stateB, seat: seatB } = buildNonForcedState()

    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: undefined, LOCAL_AI_CARD_SHADOW_TRACE_ENABLED: 'true', LOCAL_AI_CARD_SHADOW_TRACE_PATH: tracePathA },
      () => {
        resetAllStateForTests()
        pickServerBotPlayCardWithAiCandidate(stateA, seatA)
      },
    )
    withEnv(
      { LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_TRACE_ENABLED: undefined, LOCAL_AI_CARD_SHADOW_TRACE_ENABLED: 'true', LOCAL_AI_CARD_SHADOW_TRACE_PATH: tracePathB },
      () => {
        resetAllStateForTests()
        pickServerBotPlayCardWithAiCandidate(stateB, seatB)
      },
    )

    const recA = (await readShadowTraceRecords(tracePathA))[0]!
    const recB = (await readShadowTraceRecords(tracePathB))[0]!
    delete recA['timestamp']
    delete recB['timestamp']
    assertEqual(JSON.stringify(recA), JSON.stringify(recB), 'записите трябва да са byte-identical (без timestamp)')
  })
})

checkSync('[I8] Shadow ON заедно с LOCAL_AI_CARD_BETA_ENABLED=true+advisor policy — старото поведение непроменено', () => {
  const { state, seat } = buildNonForcedState()
  const tracePath = join(tmpdir(), `local-ai-shadow-trace-check-i8-${Date.now()}.jsonl`)
  const stateForComparison = JSON.parse(JSON.stringify(state)) as ServerAuthoritativeGameState

  const resultWithoutShadow = withEnv(
    { LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'advisor', LOCAL_AI_CARD_SHADOW_TRACE_ENABLED: undefined },
    () => {
      resetAllStateForTests()
      return pickServerBotPlayCardWithAiCandidate(stateForComparison, seat)
    },
  )
  const resultWithShadow = withEnv(
    { LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'advisor', LOCAL_AI_CARD_SHADOW_TRACE_ENABLED: 'true', LOCAL_AI_CARD_SHADOW_TRACE_PATH: tracePath },
    () => {
      resetAllStateForTests()
      return pickServerBotPlayCardWithAiCandidate(state, seat)
    },
  )
  assertEqual(resultWithShadow?.id, resultWithoutShadow?.id, 'advisor policy резултатът не трябва да се промени от shadow trace флага')
})

// ─── Run async queue, print summary ──────────────────────────────────────────

async function main(): Promise<void> {
  for (const fn of asyncQueue) await fn()

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
  resetAllStateForTests()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
