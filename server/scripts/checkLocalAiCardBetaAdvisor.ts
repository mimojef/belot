/**
 * checkLocalAiCardBetaAdvisor.ts
 *
 * Local check script за server/src/ai/cardAdvisorPolicy.ts (pure guard-rule
 * engine) и its wiring in server/src/ai/localAiCardBeta.ts
 * (LOCAL_AI_CARD_BETA_POLICY=advisor). Two layers of tests:
 *
 *  (a) UNIT tests directly against decideAdvisorCard() — one fixture per
 *      guard rule (A/B/C/D) proving it fires as designed, boundary fixtures
 *      proving A/D do NOT fire outside positionInTrick===3, and a
 *      priority-order fixture. These construct AdvisorDecisionInput values
 *      directly (no dependency on the real conventional bot's heuristic) —
 *      precise, deterministic tests of the algorithm itself.
 *  (b) INTEGRATION tests via pickServerBotPlayCardWithAiCandidate (same
 *      conventions as checkLocalAiCardBeta.ts) — safety invariants: flag OFF
 *      unchanged; policyMode='model' unaffected (regression guard for the
 *      old path); advisor mode never returns an invalid card; forced
 *      decisions always 'forced_card' regardless of policy; a real-data
 *      smoke pass over card-test.jsonl with policy forced to 'advisor'.
 *
 * Не пипа production .env, не прави network/SSH/deploy. Не изисква изрично
 * production env.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  pickServerBotPlayCardWithAiCandidate,
  resetLocalAiCardBetaModelCacheForTests,
} from '../src/ai/localAiCardBeta.js'
import { pickServerBotPlayCard } from '../src/game/pickServerBotPlayCard.js'
import { decideAdvisorCard, type AdvisorCandidateMemory, type AdvisorDecisionInput } from '../src/ai/cardAdvisorPolicy.js'
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
const CARD_TEST_PATH = join(REPO_ROOT, 'training-output', 'baseline', 'card-test.jsonl')

// ─── Test runner (същия стил като checkLocalAiCardBeta.ts / checkTrainingRecorder.ts) ─

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

function candidateMemoryMap(entries: AdvisorCandidateMemory[]): Map<string, AdvisorCandidateMemory> {
  return new Map(entries.map((e) => [e.id, e]))
}

function neutralMemory(cards: ServerCard[]): AdvisorCandidateMemory[] {
  return cards.map((c) => ({ id: c.id, candidateIsCleanWinner: false, shouldPreserveCleanWinner: false }))
}

// ─── (a) Unit tests: decideAdvisorCard() directly ───────────────────────────

console.log('\ncheckLocalAiCardBetaAdvisor\n')

// [A] avoid_giving_trick_to_opponent — positionInTrick===3, opponent currently
// wins with conventionalCard, a trump legal alternative flips it to our team.
checkSync('[A] Rule A fires at positionInTrick=3 когато opponent печели и flip е възможен', () => {
  const conventional = card('spades', 'Q')
  const flipCard = card('hearts', '7') // trump — flips the trick to bottom's team
  const currentTrickPlays: ServerTrickPlay[] = [
    { seat: 'right', card: card('spades', 'A') }, // opponent, currently winning
    { seat: 'top', card: card('spades', '8') },
    { seat: 'left', card: card('spades', '9') },
  ]
  const input: AdvisorDecisionInput = {
    seat: 'bottom',
    partnerSeat: 'top',
    positionInTrick: 3,
    contract: 'suit',
    trumpSuit: 'hearts',
    currentTrickPlays,
    legalCards: [conventional, flipCard],
    conventionalCard: conventional,
    partnerCurrentlyWinning: false,
    opponentCurrentlyWinning: true,
    pointsInTrick: 4,
    candidateMemoryById: candidateMemoryMap(neutralMemory([conventional, flipCard])),
  }
  const result = decideAdvisorCard(input)
  assert(result.override, 'трябва да override-не')
  assertEqual(result.reason, 'avoid_giving_trick_to_opponent', 'reason')
  assertEqual(result.finalCard.id, flipCard.id, 'finalCard трябва да е flip картата')
})

// [D] avoid_feeding_points — positionInTrick===3, opponent wins, NO flip
// possible (no trump alternative), a lower-point legal alternative exists.
checkSync('[D] Rule D fires при positionInTrick=3, trick изгубен, съществува по-нискоточкова алтернатива', () => {
  const conventional = card('spades', '10') // 10 points
  const lowerPoints = card('spades', 'K') // 4 points, still loses, but cheaper
  const currentTrickPlays: ServerTrickPlay[] = [
    { seat: 'right', card: card('spades', 'A') }, // opponent, unbeatable here (no trump alt)
    { seat: 'top', card: card('spades', '8') },
    { seat: 'left', card: card('spades', '9') },
  ]
  const input: AdvisorDecisionInput = {
    seat: 'bottom',
    partnerSeat: 'top',
    positionInTrick: 3,
    contract: 'suit',
    trumpSuit: 'hearts',
    currentTrickPlays,
    legalCards: [conventional, lowerPoints],
    conventionalCard: conventional,
    partnerCurrentlyWinning: false,
    opponentCurrentlyWinning: true,
    pointsInTrick: 4,
    candidateMemoryById: candidateMemoryMap(neutralMemory([conventional, lowerPoints])),
  }
  const result = decideAdvisorCard(input)
  assert(result.override, 'трябва да override-не')
  assertEqual(result.reason, 'avoid_feeding_points', 'reason')
  assertEqual(result.finalCard.id, lowerPoints.id, 'finalCard трябва да е по-евтината алтернатива')
})

// [B] avoid_overtaking_partner — partner already winning (hard fact), low
// points at stake, conventionalCard would overtake unnecessarily.
checkSync('[B] Rule B fires когато partner печели и overtake е излишен (pointsInTrick<10)', () => {
  const conventional = card('hearts', 'A') // overtakes partner's J
  const safeDiscard = card('hearts', '7') // stays below partner
  const currentTrickPlays: ServerTrickPlay[] = [
    { seat: 'right', card: card('hearts', '9') },
    { seat: 'top', card: card('hearts', 'J') }, // partner, currently winning
  ]
  const input: AdvisorDecisionInput = {
    seat: 'bottom',
    partnerSeat: 'top',
    positionInTrick: 2,
    contract: 'no-trumps',
    trumpSuit: null,
    currentTrickPlays,
    legalCards: [conventional, safeDiscard],
    conventionalCard: conventional,
    partnerCurrentlyWinning: true,
    opponentCurrentlyWinning: false,
    pointsInTrick: 2,
    candidateMemoryById: candidateMemoryMap(neutralMemory([conventional, safeDiscard])),
  }
  const result = decideAdvisorCard(input)
  assert(result.override, 'трябва да override-не')
  assertEqual(result.reason, 'avoid_overtaking_partner', 'reason')
  assertEqual(result.finalCard.id, safeDiscard.id, 'finalCard трябва да остави partner печеливш')
})

// [C] preserve_clean_winner — NOT leading, conventionalCard is a proven clean
// winner, trick not urgent, a safe (non-trump, 0-point) alternative exists.
checkSync('[C] Rule C fires (не lead), conventionalCard е clean winner, трикът не е спешен', () => {
  const conventional = card('hearts', 'A') // clean winner
  const safeDiscard = card('diamonds', '7') // non-trump, 0 points
  const currentTrickPlays: ServerTrickPlay[] = [{ seat: 'right', card: card('clubs', '7') }] // 0 points
  const input: AdvisorDecisionInput = {
    seat: 'bottom',
    partnerSeat: 'top',
    positionInTrick: 1,
    contract: 'no-trumps',
    trumpSuit: null,
    currentTrickPlays,
    legalCards: [conventional, safeDiscard],
    conventionalCard: conventional,
    partnerCurrentlyWinning: false,
    opponentCurrentlyWinning: true,
    pointsInTrick: 0,
    candidateMemoryById: candidateMemoryMap([
      { id: conventional.id, candidateIsCleanWinner: true, shouldPreserveCleanWinner: true },
      { id: safeDiscard.id, candidateIsCleanWinner: false, shouldPreserveCleanWinner: false },
    ]),
  }
  const result = decideAdvisorCard(input)
  assert(result.override, 'трябва да override-не')
  assertEqual(result.reason, 'preserve_clean_winner', 'reason')
  assertEqual(result.finalCard.id, safeDiscard.id, 'finalCard трябва да е safe discard-а')
})

// [C-boundary] Rule C трябва да НЕ fire-не при positionInTrick===0 (leading) —
// leading с guaranteed winner е нормална стратегия, не грешка.
checkSync('[C-boundary] Rule C НЕ fire-ва при positionInTrick=0 (leading)', () => {
  const conventional = card('diamonds', 'J') // clean winner (trump lead)
  const other = card('spades', '7')
  const input: AdvisorDecisionInput = {
    seat: 'bottom',
    partnerSeat: 'top',
    positionInTrick: 0,
    contract: 'suit',
    trumpSuit: 'diamonds',
    currentTrickPlays: [],
    legalCards: [conventional, other],
    conventionalCard: conventional,
    partnerCurrentlyWinning: false,
    opponentCurrentlyWinning: false,
    pointsInTrick: 0,
    candidateMemoryById: candidateMemoryMap([
      { id: conventional.id, candidateIsCleanWinner: true, shouldPreserveCleanWinner: true },
      { id: other.id, candidateIsCleanWinner: false, shouldPreserveCleanWinner: false },
    ]),
  }
  const result = decideAdvisorCard(input)
  assert(!result.override, 'НЕ трябва да override-ва при lead')
  assertEqual(result.finalCard.id, conventional.id, 'finalCard трябва да остане conventional при lead')
})

// [A/D-boundary] Rules A/D НЕ fire-ват при positionInTrick 0/1/2, дори когато
// същият сценарий (opponent печели, flip възможен) би задействал ги на позиция 3.
checkSync('[A/D-boundary] Rules A/D НЕ fire-ват при positionInTrick=2 (не последен ход)', () => {
  const conventional = card('spades', 'Q')
  const flipCard = card('hearts', '7')
  const currentTrickPlays: ServerTrickPlay[] = [
    { seat: 'right', card: card('spades', 'A') },
    { seat: 'top', card: card('spades', '8') },
  ]
  const input: AdvisorDecisionInput = {
    seat: 'bottom',
    partnerSeat: 'top',
    positionInTrick: 2,
    contract: 'suit',
    trumpSuit: 'hearts',
    currentTrickPlays,
    legalCards: [conventional, flipCard],
    conventionalCard: conventional,
    partnerCurrentlyWinning: false,
    opponentCurrentlyWinning: true,
    pointsInTrick: 4,
    candidateMemoryById: candidateMemoryMap(neutralMemory([conventional, flipCard])),
  }
  const result = decideAdvisorCard(input)
  assert(!result.override, 'НЕ трябва да override-ва при positionInTrick=2 (не е последен да играе)')
  assertEqual(result.finalCard.id, conventional.id, 'finalCard трябва да остане conventional')
})

// [Priority] Ако rule A условието е изпълнено (position=3, flip възможен), то
// печели над rule C дори conventionalCard да е ФЛАГ-нат и като clean winner.
checkSync('[Priority] Rule A има приоритет над Rule C при колизия', () => {
  const conventional = card('spades', 'Q')
  const flipCard = card('hearts', '7')
  const otherSafeCard = card('diamonds', '7')
  const currentTrickPlays: ServerTrickPlay[] = [
    { seat: 'right', card: card('spades', 'A') },
    { seat: 'top', card: card('spades', '8') },
    { seat: 'left', card: card('spades', '9') },
  ]
  const input: AdvisorDecisionInput = {
    seat: 'bottom',
    partnerSeat: 'top',
    positionInTrick: 3,
    contract: 'suit',
    trumpSuit: 'hearts',
    currentTrickPlays,
    legalCards: [conventional, flipCard, otherSafeCard],
    conventionalCard: conventional,
    partnerCurrentlyWinning: false,
    opponentCurrentlyWinning: true,
    pointsInTrick: 4,
    candidateMemoryById: candidateMemoryMap([
      { id: conventional.id, candidateIsCleanWinner: true, shouldPreserveCleanWinner: true }, // artificially also clean-winner-flagged
      { id: flipCard.id, candidateIsCleanWinner: false, shouldPreserveCleanWinner: false },
      { id: otherSafeCard.id, candidateIsCleanWinner: false, shouldPreserveCleanWinner: false },
    ]),
  }
  const result = decideAdvisorCard(input)
  assertEqual(result.reason, 'avoid_giving_trick_to_opponent', 'Rule A трябва да спечели приоритета')
  assertEqual(result.finalCard.id, flipCard.id, 'finalCard трябва да е flip картата (Rule A), не safe discard (Rule C)')
})

// [No-signal] Никакво rule условие не е изпълнено → никакъв override.
checkSync('[No-signal] Без силен сигнал → finalCard === conventionalCard', () => {
  const conventional = card('clubs', '9')
  const other = card('diamonds', 'K')
  const input: AdvisorDecisionInput = {
    seat: 'bottom',
    partnerSeat: 'top',
    positionInTrick: 1,
    contract: 'no-trumps',
    trumpSuit: null,
    currentTrickPlays: [{ seat: 'right', card: card('clubs', '7') }],
    legalCards: [conventional, other],
    conventionalCard: conventional,
    partnerCurrentlyWinning: false,
    opponentCurrentlyWinning: true,
    pointsInTrick: 0,
    candidateMemoryById: candidateMemoryMap(neutralMemory([conventional, other])),
  }
  const result = decideAdvisorCard(input)
  assert(!result.override, 'не трябва да override-ва без силен сигнал')
  assertEqual(result.reason, null, 'reason трябва да е null')
  assertEqual(result.finalCard.id, conventional.id, 'finalCard === conventionalCard')
})

// [Forced] legalCards.length<=1 → engine винаги връща conventionalCard, override=false.
checkSync('[Forced] legalCards.length<=1 → override=false, finalCard=conventionalCard', () => {
  const only = card('hearts', 'J')
  const input: AdvisorDecisionInput = {
    seat: 'bottom',
    partnerSeat: 'top',
    positionInTrick: 0,
    contract: 'no-trumps',
    trumpSuit: null,
    currentTrickPlays: [],
    legalCards: [only],
    conventionalCard: only,
    partnerCurrentlyWinning: false,
    opponentCurrentlyWinning: false,
    pointsInTrick: 0,
    candidateMemoryById: candidateMemoryMap(neutralMemory([only])),
  }
  const result = decideAdvisorCard(input)
  assert(!result.override, 'forced не трябва никога да override-ва')
  assertEqual(result.finalCard.id, only.id, 'finalCard трябва да е единствената карта')
})

// ─── (b) Integration tests: pickServerBotPlayCardWithAiCandidate ───────────

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

// [I1] Flag OFF → точно conventional резултат (advisor path never consulted)
checkSync('[I1] Flag OFF → резултатът е точно pickServerBotPlayCard(state, seat)', () => {
  const { state, seat } = buildNonForcedState()
  withEnv({ LOCAL_AI_CARD_BETA_ENABLED: undefined, LOCAL_AI_CARD_BETA_POLICY: undefined }, () => {
    resetLocalAiCardBetaModelCacheForTests()
    const conventional = pickServerBotPlayCard(state, seat)
    const wrapped = pickServerBotPlayCardWithAiCandidate(state, seat)
    assertEqual(wrapped?.id, conventional?.id, 'wrapped.id vs conventional.id')
  })
})

// [I2] Flag ON, policy unset → defaults to advisor (не model) — decisionSource
// не трябва да бъде ai_accepted/ai_same_as_conventional (тези са само за 'model').
checkSync('[I2] Flag ON, policy unset → advisor е default (не изисква model.json)', () => {
  const { state, seat } = buildNonForcedState()
  withEnv({ LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: undefined, LOCAL_AI_CARD_BETA_MODEL_PATH: undefined }, () => {
    resetLocalAiCardBetaModelCacheForTests()
    const result = pickServerBotPlayCardWithAiCandidate(state, seat)
    const handIds = new Set(state.hands[seat]!.map((c) => c.id))
    assert(result !== null && handIds.has(result.id), 'finalCard трябва да е валиден дори без model.json (advisor не се нуждае от model)')
  })
})

// [I3] policyMode='model' explicit → старата логика непроменена (regression guard)
checkSync('[I3] LOCAL_AI_CARD_BETA_POLICY=model → старото поведение непроменено', () => {
  const { state, seat } = buildNonForcedState()
  withEnv({ LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'model', LOCAL_AI_CARD_BETA_MODEL_PATH: join(REPO_ROOT, 'training-output', 'does-not-exist', 'model.json') }, () => {
    resetLocalAiCardBetaModelCacheForTests()
    const conventional = pickServerBotPlayCard(state, seat)
    const wrapped = pickServerBotPlayCardWithAiCandidate(state, seat)
    // Missing model.json → model-path fallback (conventional_fallback), same as before this feature existed.
    assertEqual(wrapped?.id, conventional?.id, 'при missing model.json (policy=model) трябва да падне точно към conventional')
  })
})

// [I4] Forced → decisionSource='forced_card' независимо от policy
checkSync('[I4] Forced (1 legal card), advisor policy → връща forced картата', () => {
  const { state, seat } = buildForcedState()
  withEnv({ LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'advisor' }, () => {
    resetLocalAiCardBetaModelCacheForTests()
    const result = pickServerBotPlayCardWithAiCandidate(state, seat)
    assertEqual(result?.id, 'hearts-J', 'forced card трябва да е единствената карта в ръката')
  })
})

// [I5] Кросчек: final card винаги ∈ ownHand (advisor policy, non-forced state)
checkSync('[I5] Final selected card винаги ∈ ownHand (advisor policy)', () => {
  const { state, seat } = buildNonForcedState()
  withEnv({ LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'advisor' }, () => {
    resetLocalAiCardBetaModelCacheForTests()
    const result = pickServerBotPlayCardWithAiCandidate(state, seat)
    const handIds = new Set((state.hands[seat] ?? []).map((c) => c.id))
    assert(result !== null && handIds.has(result.id), 'final card трябва да е в ownHand')
  })
})

// [I6] Real-data smoke: card-test.jsonl (ако е наличен), policy=advisor forced on
checkAsync('[I6] Real-data smoke: card-test.jsonl, policy=advisor — никога invalid карта, 0 crashes', async () => {
  let content: string
  try {
    content = readFileSync(CARD_TEST_PATH, 'utf8')
  } catch {
    console.log(`  SKIP  [I6] ${CARD_TEST_PATH} не е наличен — изпълни npm run prepare:training-baseline първо (не е фатално за check-а).`)
    return
  }

  const lines = content.split('\n').filter((l) => l.trim().length > 0)
  const sample = lines.slice(0, 300)

  let checkedCount = 0
  let invalidCount = 0
  let crashCount = 0

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
    const handIds = new Set(rec.ownHand.map((c) => c.id))
    try {
      const result = withEnv({ LOCAL_AI_CARD_BETA_ENABLED: 'true', LOCAL_AI_CARD_BETA_POLICY: 'advisor' }, () => {
        resetLocalAiCardBetaModelCacheForTests()
        return pickServerBotPlayCardWithAiCandidate(state, rec.seat)
      })
      if (!result || !handIds.has(result.id)) invalidCount++
    } catch {
      crashCount++
    }
  }

  console.log(`  [I6] smoke обхвана ${checkedCount} sample-а`)
  assertEqual(crashCount, 0, `advisor policy не трябва никога да хвърля exception навън (${crashCount}/${checkedCount})`)
  assertEqual(invalidCount, 0, `invalid final карти при advisor policy (${invalidCount}/${checkedCount})`)
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
