/**
 * checkSweepEligibilityOptimization.ts
 *
 * Phase S1 + S2 (incidents 18529 / 18537) в computeServerSweepEligibility —
 * БЕЗ промяна на eligibility semantics, node guard semantics или правилото.
 *   S1: root precheck (губещ root ход още в текущата взятка) + root ordering.
 *   S2: indexed search (32-bit маска на оставащите карти, без spreads/filter
 *       в hot recursion, кеш на легалните ходове/победителя), същото обхождане.
 *
 *  [A] differential срещу ORIGINAL HEAD solver-а (преди S1/S2, дословно
 *      копиран по-долу) върху ≥ 10 000 states. Резултатът трябва да е
 *      идентичен навсякъде; за states, които НЕ са отхвърлени от root
 *      precheck-а — и точно същият брой nodes и guardHit.
 *  [B] production fixtures: original / S1 (legacy path) / final.
 *  [C] dedicated guard-hit fixtures без губещ root ход (suit/5, suit/6,
 *      all-trumps/6, no-trumps/6): final = ТОЧНО 200001 nodes, guardHit.
 *  [D] human main-thread пътища: 4-та карта и sweep accept revalidation
 *      (вкл. guard-hit state — най-лошият случай).
 *  [E] fallback: fabricated дублирани карти → legacy path, същата семантика.
 *  [F] observer overhead: без observer / worker observer / main observer.
 *  [G] observer/diagnostics поведение (хвърлящ observer, worker batch агрегати).
 *
 * Runtime: ~2–4 мин (ORIGINAL solver-ът изчерпва guard-а за ~0.2 s на state).
 */

import type { Seat } from '../src/core/serverTypes.js'
import type { ServerAuthoritativeGameState, ServerCard, ServerRank, ServerSuit, ServerWinningBid } from '../src/game/serverGameTypes.js'
import {
  computeServerSweepEligibility,
  computeServerSweepEligibilityOutcome,
  MAX_SWEEP_SEARCH_NODES,
  setServerSweepEligibilityObserver,
  type ServerSweepEligibilityObservation,
} from '../src/game/computeServerSweepEligibility.js'
import { getNextSeat, getPreviousSeat } from '../src/game/serverPhaseHelpers.js'
import { getServerTrickWinner } from '../src/game/getServerTrickWinner.js'
import { getServerValidPlayCards } from '../src/game/getServerValidPlayCards.js'
import { submitHumanPlayCardForRoom } from '../src/game/submitHumanPlayCardForRoom.js'
import { submitHumanSweepDecisionForRoom } from '../src/game/submitHumanSweepDecisionForRoom.js'
import { createRoomWithHumanHost } from '../src/core/createRoomWithHumanHost.js'
import type { ServerRoom } from '../src/core/serverTypes.js'
import {
  sanitizeGameWorkerBatchDiagnostics,
  startGameWorkerBatchDiagnostics,
} from '../src/game/gameWorkerBatchDiagnostics.js'
import { createGameWorkerBatchMetrics } from '../src/monitoring/gameWorkerBatchMetrics.js'
import { createMainThreadTimingMetrics } from '../src/monitoring/mainThreadTimingMetrics.js'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

console.log('\n═══ checkSweepEligibilityOptimization ═══')

type Hands = Record<Seat, ServerCard[]>
type Bid = ServerWinningBid
const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']
const SUITS: ServerSuit[] = ['clubs', 'diamonds', 'hearts', 'spades']
const RANKS: ServerRank[] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const DECK: ServerCard[] = SUITS.flatMap((suit) => RANKS.map((rank) => ({ id: `${suit}-${rank}`, suit, rank })))

function card(id: string): ServerCard {
  const [suit, rank] = id.split('-') as [ServerSuit, ServerRank]
  return { id, suit, rank }
}

// ─── ORIGINAL HEAD solver (преди S1 и S2) — ДОСЛОВНО, + брояч/guard флаг ───
function originalSweepEligibility(sweepSeat: Seat, hands: Hands, winningBid: Bid): { result: boolean; nodes: number; guardHit: boolean } {
  const handsKey = (h: Hands) => SEAT_ORDER.map((seat) => h[seat].map((c) => `${c.suit}${c.rank}`).slice().sort().join(',')).join('|')
  const legalCardsFor = (seat: Seat, hand: ServerCard[], plays: { seat: Seat; card: ServerCard }[]) => {
    const fakeState = {
      hands: { bottom: [], right: [], top: [], left: [], [seat]: hand },
      playing: { currentTrick: { plays } },
      bidding: { winningBid },
    } as unknown as ServerAuthoritativeGameState
    return getServerValidPlayCards(fakeState, seat)
  }
  if (hands[sweepSeat].length < 2) return { result: false, nodes: 0, guardHit: false }
  const memo = new Map<string, boolean>()
  let nodes = 0
  let guardHit = false
  function isGuaranteedSweep(currentHands: Hands): boolean {
    if (currentHands[sweepSeat].length === 0) return true
    const key = handsKey(currentHands)
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    if (++nodes > 200000) {
      guardHit = true
      memo.set(key, false)
      return false
    }
    let result = true
    for (const leadCard of currentHands[sweepSeat]) {
      const afterLead: Hands = { ...currentHands, [sweepSeat]: currentHands[sweepSeat].filter((c) => c.id !== leadCard.id) }
      if (!allResponsesWinTrickThenRecurse([{ seat: sweepSeat, card: leadCard }], afterLead)) {
        result = false
        break
      }
    }
    memo.set(key, result)
    return result
  }
  function allResponsesWinTrickThenRecurse(plays: { seat: Seat; card: ServerCard }[], responderHands: Hands): boolean {
    if (plays.length === 4) {
      const winner = getServerTrickWinner(plays, winningBid)
      if (!winner || winner.seat !== sweepSeat) return false
      return isGuaranteedSweep(responderHands)
    }
    const nextSeat = getNextSeat(plays[plays.length - 1]!.seat)
    for (const c of legalCardsFor(nextSeat, responderHands[nextSeat], plays)) {
      if (++nodes > 200000) {
        guardHit = true
        return false
      }
      const nextHands: Hands = { ...responderHands, [nextSeat]: responderHands[nextSeat].filter((x) => x.id !== c.id) }
      if (!allResponsesWinTrickThenRecurse([...plays, { seat: nextSeat, card: c }], nextHands)) return false
    }
    return true
  }
  const result = isGuaranteedSweep(hands)
  return { result, nodes, guardHit }
}

const finalOutcome = (seat: Seat, hands: Hands, bid: Bid) => computeServerSweepEligibilityOutcome({ sweepSeat: seat, hands, winningBid: bid })
const s1Outcome = (seat: Seat, hands: Hands, bid: Bid) => computeServerSweepEligibilityOutcome({ sweepSeat: seat, hands, winningBid: bid }, { implementation: 'legacy' })

const threadCpu = (): number => {
  const fn = (process as unknown as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage
  const usage = fn ? fn.call(process) : process.cpuUsage()
  return (usage.user + usage.system) / 1000
}

// 1 warmup + 5 runs → median/max wall и thread CPU.
function measure<T>(fn: () => T, runs = 5): { value: T; wallMedian: number; wallMax: number; cpuMedian: number; cpuMax: number } {
  let value = fn()
  const walls: number[] = []
  const cpus: number[] = []
  for (let i = 0; i < runs; i += 1) {
    const c0 = threadCpu()
    const t0 = performance.now()
    value = fn()
    walls.push(performance.now() - t0)
    cpus.push(threadCpu() - c0)
  }
  walls.sort((a, b) => a - b)
  cpus.sort((a, b) => a - b)
  return { value, wallMedian: walls[Math.floor(runs / 2)]!, wallMax: walls[runs - 1]!, cpuMedian: cpus[Math.floor(runs / 2)]!, cpuMax: cpus[runs - 1]! }
}
const fmt = (ms: number) => (ms < 1 ? ms.toFixed(3) : ms.toFixed(1))

// ─── генератори (детерминирани) ────────────────────────────────────────────
let seed = 20261022
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}
const TRUMP_POWER: Record<ServerRank, number> = { '7': 0, '8': 1, Q: 2, K: 3, '10': 4, A: 5, '9': 6, J: 7 }
const PLAIN_POWER: Record<ServerRank, number> = { '7': 0, '8': 1, '9': 2, J: 3, Q: 4, K: 5, '10': 6, A: 7 }
const suitBid = (trumpSuit: ServerSuit): Bid => ({ seat: 'bottom', contract: 'suit', trumpSuit, doubled: false, redoubled: false })
const ALL_TRUMPS: Bid = { seat: 'bottom', contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false }
const NO_TRUMPS: Bid = { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false }
function randomBid(): Bid {
  const roll = rand()
  if (roll < 0.6) return suitBid(SUITS[Math.floor(rand() * 4)]!)
  return roll < 0.8 ? ALL_TRUMPS : NO_TRUMPS
}
const isTrump = (c: ServerCard, bid: Bid) => bid !== null && (bid.contract === 'all-trumps' || (bid.contract === 'suit' && c.suit === bid.trumpSuit))
const score = (c: ServerCard, bid: Bid) => (isTrump(c, bid) ? 100 + TRUMP_POWER[c.rank] : PLAIN_POWER[c.rank])
const partnerOf = (seat: Seat) => SEAT_ORDER[(SEAT_ORDER.indexOf(seat) + 2) % 4]!

type Category = 'random' | 'strong' | 'adversarial' | 'many-trumps' | 'no-trumps-in-opponents' | 'void-suits'
type Generated = { claimant: Seat; hands: Hands; bid: Bid }

function fill(hands: Hands, pool: ServerCard[], n: number): Hands | null {
  let rest = pool
  for (const seat of SEAT_ORDER) {
    if (hands[seat].length === 0) {
      if (rest.length < n) return null
      hands[seat] = rest.slice(0, n)
      rest = rest.slice(n)
    }
  }
  return hands
}

function generate(category: Category, n: number): Generated | null {
  const claimant = SEAT_ORDER[Math.floor(rand() * 4)]!
  const hands: Hands = { bottom: [], right: [], top: [], left: [] }
  const deck = shuffle(DECK)
  switch (category) {
    case 'random': {
      return { claimant, bid: randomBid(), hands: fill(hands, deck, n)! }
    }
    case 'strong': {
      const bid = randomBid()
      const pool = deck.slice(0, 4 * n)
      hands[claimant] = shuffle([...pool].sort((a, b) => score(b, bid) - score(a, bid)).slice(0, n))
      return { claimant, bid, hands: fill(hands, pool.filter((c) => !hands[claimant].includes(c)), n)! }
    }
    case 'adversarial': {
      // Силни карти + една уязвима; по-силна карта от същия цвят е при противник
      // (≈ production случаите → губещ root ход).
      const bid = randomBid()
      const sorted = [...deck].sort((a, b) => score(b, bid) - score(a, bid))
      const top = sorted.slice(0, n - 1)
      const low = deck.find((c) => !top.includes(c) && deck.some((d) => d.suit === c.suit && !top.includes(d) && d !== c && score(d, bid) > score(c, bid)))!
      hands[claimant] = shuffle([...top, low])
      const beater = deck.find((d) => d.suit === low.suit && !hands[claimant].includes(d) && score(d, bid) > score(low, bid))!
      const opponents = SEAT_ORDER.filter((seat) => seat !== claimant && seat !== partnerOf(claimant))
      const opponent = opponents[Math.floor(rand() * 2)]!
      const rest = deck.filter((c) => !hands[claimant].includes(c) && c !== beater)
      hands[opponent] = [beater, ...rest.slice(0, n - 1)]
      return { claimant, bid, hands: fill(hands, rest.slice(n - 1), n)! }
    }
    case 'many-trumps': {
      // Claimant: колкото може повече козове (suit) / най-силните (all-trumps).
      const bid = rand() < 0.75 ? suitBid(SUITS[Math.floor(rand() * 4)]!) : ALL_TRUMPS
      const trumps = deck.filter((c) => isTrump(c, bid)).sort((a, b) => score(b, bid) - score(a, bid))
      const take = trumps.slice(0, Math.min(n, trumps.length - Math.floor(rand() * 2)))
      hands[claimant] = shuffle([...take, ...deck.filter((c) => !take.includes(c) && !isTrump(c, bid)).slice(0, n - take.length)])
      return { claimant, bid, hands: fill(hands, deck.filter((c) => !hands[claimant].includes(c)), n)! }
    }
    case 'no-trumps-in-opponents': {
      const bid = suitBid(SUITS[Math.floor(rand() * 4)]!)
      const trumps = deck.filter((c) => isTrump(c, bid))
      const plain = deck.filter((c) => !isTrump(c, bid))
      const claimantTrumps = Math.min(n, 1 + Math.floor(rand() * n))
      hands[claimant] = shuffle([...trumps.slice(0, claimantTrumps), ...plain.slice(0, n - claimantTrumps)])
      const partner = partnerOf(claimant)
      hands[partner] = shuffle([...trumps.slice(claimantTrumps), ...plain.slice(n - claimantTrumps)]).slice(0, n)
      const used = new Set([...hands[claimant], ...hands[partner]])
      return { claimant, bid, hands: fill(hands, plain.filter((c) => !used.has(c)), n)! }
    }
    case 'void-suits': {
      // Противниците/партньорът са void в 2 цвята; claimant от всички цветове.
      const bid = randomBid()
      const voidSuits = shuffle(SUITS).slice(0, 2)
      hands[claimant] = deck.slice(0, n)
      const rest = deck.slice(n)
      const allowed = rest.filter((c) => !voidSuits.includes(c.suit))
      const filled = fill(hands, allowed, n)
      return filled === null ? null : { claimant, bid, hands: filled }
    }
  }
}

// ─── [A] ────────────────────────────────────────────────────────────────────
await check('[A] differential срещу ORIGINAL HEAD: ≥10 000 states, 0 result mismatches; deep-search states — точно същите nodes и guardHit', () => {
  const plan: [Category, number[], number][] = [
    ['random', [2, 3, 4, 5, 6], 700],
    ['strong', [2, 3, 4], 500],
    ['strong', [5, 6], 60],
    ['adversarial', [2, 3, 4, 5, 6], 450],
    ['many-trumps', [2, 3, 4], 400],
    ['many-trumps', [5, 6], 40],
    ['no-trumps-in-opponents', [2, 3, 4, 5, 6], 300],
    ['void-suits', [2, 3, 4, 5, 6], 300],
  ]
  type Bucket = { states: number; precheck: number; deep: number; trues: number; guardHits: number }
  const buckets = new Map<string, Bucket>()
  const contracts: Record<string, number> = {}
  const mismatches: string[] = []
  let states = 0
  let deepStates = 0
  let precheckStates = 0
  let originalGuardHits = 0
  let finalGuardHits = 0
  let trues = 0
  let originalMs = 0
  let finalMs = 0
  for (const [category, sizes, perSize] of plan) {
    for (const n of sizes) {
      for (let i = 0; i < perSize; i += 1) {
        const generated = generate(category, n)
        if (generated === null) continue
        const { claimant, hands, bid } = generated
        const t0 = performance.now()
        const original = originalSweepEligibility(claimant, hands, bid)
        const t1 = performance.now()
        const final = finalOutcome(claimant, hands, bid)
        const boolean = computeServerSweepEligibility({ sweepSeat: claimant, hands, winningBid: bid })
        finalMs += performance.now() - t1
        originalMs += t1 - t0
        states += 1
        contracts[bid!.contract] = (contracts[bid!.contract] ?? 0) + 1
        const bucketKey = `${category}/${n}`
        const bucket = buckets.get(bucketKey) ?? { states: 0, precheck: 0, deep: 0, trues: 0, guardHits: 0 }
        bucket.states += 1
        if (original.result) {
          trues += 1
          bucket.trues += 1
        }
        if (original.guardHit) {
          originalGuardHits += 1
          bucket.guardHits += 1
        }
        if (final.guardHit) finalGuardHits += 1
        if (final.implementation !== 'indexed') mismatches.push(`${bucketKey}: unexpected ${final.implementation} path for a real deck`)
        if (original.result !== final.result || boolean !== final.result) {
          mismatches.push(`${bucketKey}/${bid!.contract}: result original=${original.result} final=${final.result} boolean=${boolean}`)
        }
        if (final.rootPrecheckRejected) {
          precheckStates += 1
          bucket.precheck += 1
          if (final.result) mismatches.push(`${bucketKey}: precheck-rejected state returned true`)
        } else {
          deepStates += 1
          bucket.deep += 1
          if (final.nodes !== original.nodes || final.guardHit !== original.guardHit) {
            mismatches.push(`${bucketKey}/${bid!.contract}: deep search nodes original=${original.nodes}/${original.guardHit} final=${final.nodes}/${final.guardHit}`)
          }
        }
        if (original.guardHit && final.result) mismatches.push(`${bucketKey}: guard false became true`)
        buckets.set(bucketKey, bucket)
      }
    }
  }
  console.log(`      states=${states} (${Object.entries(contracts).map(([k, v]) => `${k}:${v}`).join(' ')}) true=${trues}`)
  console.log(`      root precheck rejected=${precheckStates}  deep search=${deepStates}`)
  console.log(`      guard-hit: original=${originalGuardHits} final=${finalGuardHits} (останалите original guard hits са отхвърлени от precheck → false и в двете)`)
  console.log(`      total time original ${originalMs.toFixed(0)} ms → final ${finalMs.toFixed(0)} ms`)
  const rows = [...buckets.entries()].map(([key, b]) => `${key}: ${b.states} st, precheck ${b.precheck}, deep ${b.deep}, true ${b.trues}, guard ${b.guardHits}`)
  for (let i = 0; i < rows.length; i += 3) console.log(`      ${rows.slice(i, i + 3).join(' | ')}`)
  assert(mismatches.length === 0, `mismatches (${mismatches.length}): ${mismatches.slice(0, 10).join('; ')}`)
  assert(states >= 10000, `≥ 10000 states (${states})`)
  assert(precheckStates > 0 && deepStates > 0 && originalGuardHits > 0 && finalGuardHits > 0 && trues > 0, 'all classes covered')
})

// ─── [B] ────────────────────────────────────────────────────────────────────
const PRODUCTION_FIXTURES: { name: string; seat: Seat; bid: Bid; hands: Hands }[] = [
  {
    name: 'case 1 (room 608eaf81, incident 18529)',
    seat: 'right',
    bid: suitBid('spades'),
    hands: {
      bottom: ['clubs-7', 'clubs-K', 'hearts-Q', 'hearts-9', 'clubs-10'].map(card),
      right: ['spades-J', 'spades-10', 'spades-8', 'spades-Q', 'spades-A'].map(card),
      top: ['spades-K', 'clubs-Q', 'clubs-8', 'diamonds-7', 'diamonds-8'].map(card),
      left: ['hearts-10', 'clubs-9', 'clubs-J', 'clubs-A', 'hearts-K'].map(card),
    },
  },
  {
    name: 'case 2 (room c7979942, incident 18537)',
    seat: 'bottom',
    bid: suitBid('diamonds'),
    hands: {
      bottom: ['diamonds-J', 'diamonds-A', 'diamonds-9', 'diamonds-10', 'diamonds-Q'].map(card),
      right: ['diamonds-7', 'spades-8', 'spades-10', 'clubs-9', 'clubs-A'].map(card),
      top: ['spades-J', 'clubs-10', 'clubs-K', 'spades-9', 'spades-7'].map(card),
      left: ['diamonds-K', 'hearts-8', 'hearts-J', 'hearts-9', 'hearts-10'].map(card),
    },
  },
]

function compareImplementations(label: string, seat: Seat, hands: Hands, bid: Bid) {
  const original = measure(() => originalSweepEligibility(seat, hands, bid))
  const s1 = measure(() => s1Outcome(seat, hands, bid))
  const final = measure(() => finalOutcome(seat, hands, bid))
  console.log(`      ${label}`)
  console.log(`        original: ${original.value.result} nodes=${original.value.nodes} guard=${original.value.guardHit}  wall med/max ${fmt(original.wallMedian)}/${fmt(original.wallMax)} ms  CPU med/max ${fmt(original.cpuMedian)}/${fmt(original.cpuMax)} ms`)
  console.log(`        S1:       ${s1.value.result} nodes=${s1.value.nodes} guard=${s1.value.guardHit} precheck=${s1.value.rootPrecheckRejected}  wall med/max ${fmt(s1.wallMedian)}/${fmt(s1.wallMax)} ms  CPU med/max ${fmt(s1.cpuMedian)}/${fmt(s1.cpuMax)} ms`)
  console.log(`        final:    ${final.value.result} nodes=${final.value.nodes} guard=${final.value.guardHit} precheck=${final.value.rootPrecheckRejected}  wall med/max ${fmt(final.wallMedian)}/${fmt(final.wallMax)} ms  CPU med/max ${fmt(final.cpuMedian)}/${fmt(final.cpuMax)} ms`)
  return { original, s1, final }
}

for (const fixture of PRODUCTION_FIXTURES) {
  await check(`[B] ${fixture.name}: original / S1 / final`, () => {
    const { original, s1, final } = compareImplementations(fixture.name, fixture.seat, fixture.hands, fixture.bid)
    assert(original.value.result === false && s1.value.result === false && final.value.result === false, 'all false')
    assert(original.value.guardHit && original.value.nodes === MAX_SWEEP_SEARCH_NODES + 1, 'original exhausts the guard')
    assert(final.value.rootPrecheckRejected && final.value.nodes === 0 && !final.value.guardHit, 'final: root precheck')
    assert(final.value.implementation === 'indexed', 'final uses the indexed path')
  })
}

// ─── [C] ────────────────────────────────────────────────────────────────────
// Детерминирано търсене на state без губещ root ход, който изчерпва guard-а.
function findGuardFixture(bid: Bid, n: number, claimantPick: 'strong' | 'top-ranks'): Generated {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    const claimant: Seat = 'bottom'
    const deck = shuffle(DECK)
    const hands: Hands = { bottom: [], right: [], top: [], left: [] }
    if (claimantPick === 'top-ranks') {
      hands[claimant] = shuffle(deck.filter((c) => c.rank === 'J' || c.rank === '9' || c.rank === 'A')).slice(0, n)
    } else {
      hands[claimant] = [...deck.slice(0, 4 * n)].sort((a, b) => score(b, bid) - score(a, bid)).slice(0, n)
    }
    const filled = fill(hands, deck.filter((c) => !hands[claimant].includes(c)), n)
    if (filled === null) continue
    const s1 = s1Outcome(claimant, filled, bid)
    if (!s1.rootPrecheckRejected && s1.guardHit) return { claimant, hands: filled, bid }
  }
  throw new Error(`no guard fixture found for ${bid!.contract}/${n}`)
}

const GUARD_FIXTURES: [string, Bid, number, 'strong' | 'top-ranks'][] = [
  ['suit/5', suitBid('spades'), 5, 'strong'],
  ['suit/6', suitBid('hearts'), 6, 'strong'],
  ['all-trumps/6', ALL_TRUMPS, 6, 'top-ranks'],
  ['no-trumps/6', NO_TRUMPS, 6, 'strong'],
]
const guardFixtures = new Map<string, Generated>()

for (const [label, bid, n, pick] of GUARD_FIXTURES) {
  await check(`[C] guard-hit fixture ${label}: без губещ root ход; final = ТОЧНО ${MAX_SWEEP_SEARCH_NODES + 1} nodes + guardHit, по-бързо`, () => {
    const fixture = findGuardFixture(bid, n, pick)
    guardFixtures.set(label, fixture)
    console.log(`      ${label} claimant=${fixture.claimant} hands=${JSON.stringify(Object.fromEntries(SEAT_ORDER.map((s) => [s, fixture.hands[s].map((c) => c.id)])))}`)
    const { original, s1, final } = compareImplementations(label, fixture.claimant, fixture.hands, fixture.bid)
    assert(original.value.result === false && original.value.guardHit && original.value.nodes === MAX_SWEEP_SEARCH_NODES + 1, 'original: guard')
    assert(s1.value.result === false && s1.value.guardHit && s1.value.nodes === MAX_SWEEP_SEARCH_NODES + 1 && !s1.value.rootPrecheckRejected, 'S1: guard')
    assert(final.value.result === false && final.value.guardHit && final.value.nodes === MAX_SWEEP_SEARCH_NODES + 1 && !final.value.rootPrecheckRejected, 'final: EXACTLY the same guard hit')
    assert(final.wallMedian * 4 < original.wallMedian, `final at least 4× faster (${final.wallMedian} vs ${original.wallMedian})`)
  })
}

// ─── [D] human main-thread пътища ───────────────────────────────────────────
function teamBySeat(seat: Seat): 'A' | 'B' {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}
const emptyRoundScore = () => ({ teamA: 0, teamB: 0 })
function fillerTrick(trickIndex: number, winnerSeat: Seat) {
  return {
    trickIndex,
    leaderSeat: winnerSeat,
    winnerSeat,
    winningTeam: teamBySeat(winnerSeat),
    plays: SEAT_ORDER.map((seat) => ({ seat, card: { id: `clubs-7-filler-${trickIndex}-${seat}`, suit: 'clubs', rank: '7' } })),
  }
}
// Същата форма като baseState в checkSweepDownTheCards.ts.
function playingState(params: { hands: Hands; bid: Bid; currentTrick: unknown; currentTurnSeat: Seat | null; sweepOffer: unknown; completedTricks: unknown[] }): ServerAuthoritativeGameState {
  const breakdown = () => ({ tricks: emptyRoundScore(), declarations: emptyRoundScore(), belote: emptyRoundScore(), lastTen: emptyRoundScore(), capot: emptyRoundScore(), total: emptyRoundScore() })
  const missions = () => ({ announce_tersa: emptyRoundScore(), announce_50: emptyRoundScore(), announce_100: emptyRoundScore(), announce_kare: emptyRoundScore(), announce_belot: emptyRoundScore() })
  return {
    phase: 'playing',
    phaseEnteredAt: Date.now(),
    targetScore: 151,
    players: Object.fromEntries(SEAT_ORDER.map((seat) => [seat, { seat, team: teamBySeat(seat), mode: 'human', controlledByBot: false }])),
    round: { dealerSeat: 'bottom', cutterSeat: 'right', firstBidderSeat: 'right', firstDealSeat: 'right', selectedCutIndex: null },
    deck: [],
    hands: params.hands,
    bidding: { entries: [], currentSeat: null, winningBid: params.bid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    declarations: [],
    matchDeclarationMissionCounts: missions(),
    matchDeclarationMissionCountsBySeat: {},
    currentTrick: { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 0 },
    wonTricks: { A: [], B: [] },
    playing: {
      hasStarted: true,
      currentTurnSeat: params.currentTurnSeat,
      currentTrick: params.currentTrick,
      completedTricks: params.completedTricks,
      lastCompletedTrickWinnerSeat: null,
      lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: { bottom: [], right: [], top: [], left: [] },
      wonTricksByTeam: { A: [], B: [] },
      sweepOffer: params.sweepOffer,
      declinedSweepSeats: [],
      sweepResolution: null,
    },
    scoring: null,
    matchEnded: null,
    score: { round: breakdown(), match: emptyRoundScore(), carryOver: { teamA: 0, teamB: 0 } },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  } as unknown as ServerAuthoritativeGameState
}
function roomWith(state: ServerAuthoritativeGameState): ServerRoom {
  const { room } = createRoomWithHumanHost({ roomId: 'sweep-main-thread', connectionId: 'c1', identity: { displayName: 'Human', profileId: 'profile-1' } as never })
  return { ...room, game: { ...room.game, authoritativeState: state } }
}

let lastObservation: ServerSweepEligibilityObservation | null = null
const captureObserver = (observation: ServerSweepEligibilityObservation) => {
  lastObservation = observation
}

// Взятка, която claimant печели и след която ръцете са ТОЧНО `after`; 4-тата
// карта е на човека (seat преди claimant) и е легална.
function trickLeadingTo(after: Generated): { hands: Hands; plays: { seat: Seat; card: ServerCard }[]; humanSeat: Seat; humanCard: ServerCard } {
  const used = new Set(SEAT_ORDER.flatMap((seat) => after.hands[seat].map((c) => c.id)))
  const leftover = DECK.filter((c) => !used.has(c.id))
  const humanSeat = getPreviousSeat(after.claimant)
  const order = [after.claimant, getNextSeat(after.claimant), getNextSeat(getNextSeat(after.claimant)), humanSeat]
  for (const lead of leftover) {
    for (const a of leftover) for (const b of leftover) for (const h of leftover) {
      const picked = [lead, a, b, h]
      if (new Set(picked.map((c) => c.id)).size !== 4) continue
      const plays = picked.map((c, k) => ({ seat: order[k]!, card: c }))
      const winner = getServerTrickWinner(plays, after.bid)
      if (!winner || winner.seat !== after.claimant) continue
      const humanHand = [...after.hands[humanSeat], h]
      const legal = getServerValidPlayCards({ hands: { bottom: [], right: [], top: [], left: [], [humanSeat]: humanHand }, playing: { currentTrick: { plays: plays.slice(0, 3) } }, bidding: { winningBid: after.bid } } as unknown as ServerAuthoritativeGameState, humanSeat)
      if (!legal.some((c) => c.id === h.id)) continue
      const hands: Hands = { ...after.hands, [humanSeat]: humanHand }
      return { hands, plays: plays.slice(0, 3), humanSeat, humanCard: h }
    }
  }
  throw new Error('no completing trick found')
}

function humanFourthCard(label: string, after: Generated) {
  const trick = trickLeadingTo(after)
  const run = () => {
    const state = playingState({
      hands: trick.hands,
      bid: after.bid,
      completedTricks: [fillerTrick(0, after.claimant), fillerTrick(1, after.claimant)],
      currentTurnSeat: trick.humanSeat,
      sweepOffer: null,
      currentTrick: { leaderSeat: after.claimant, currentSeat: trick.humanSeat, plays: trick.plays, winnerSeat: null, trickIndex: 2 },
    })
    lastObservation = null
    const result = submitHumanPlayCardForRoom(roomWith(state), trick.humanSeat, trick.humanCard.id)
    return { result, observation: lastObservation as ServerSweepEligibilityObservation | null }
  }
  const measured = measure(run)
  const { result, observation } = measured.value
  assert(result.ok, `human play accepted: ${result.ok ? '' : result.message}`)
  const next = result.room.game.authoritativeState as ServerAuthoritativeGameState
  assert(SEAT_ORDER.every((seat) => JSON.stringify(next.hands[seat].map((c) => c.id)) === JSON.stringify(after.hands[seat].map((c) => c.id))), 'post-trick hands = fixture')
  assert(observation !== null, 'solver observed on the human path')
  console.log(`      human 4th card (${label}): total wall med/max ${fmt(measured.wallMedian)}/${fmt(measured.wallMax)} ms, solver ${fmt(observation.durationMs)} ms, nodes=${observation.nodes} guard=${observation.guardHit} precheck=${observation.rootPrecheckRejected} offer=${next.playing!.sweepOffer !== null}`)
  return { next, observation }
}

function humanAccept(label: string, fixture: Generated) {
  const run = () => {
    const state = playingState({
      hands: fixture.hands,
      bid: fixture.bid,
      completedTricks: [fillerTrick(0, fixture.claimant), fillerTrick(1, fixture.claimant)],
      currentTurnSeat: null,
      sweepOffer: { seat: fixture.claimant, offeredAtTrickIndex: 2, expiresAt: Date.now() + 10_000 },
      currentTrick: { leaderSeat: fixture.claimant, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 2 },
    })
    lastObservation = null
    const result = submitHumanSweepDecisionForRoom(roomWith(state), fixture.claimant, 'accept')
    return { result, observation: lastObservation as ServerSweepEligibilityObservation | null }
  }
  const measured = measure(run)
  const { result, observation } = measured.value
  assert(observation !== null, 'solver observed on the accept path')
  console.log(`      sweep accept revalidation (${label}): total wall med/max ${fmt(measured.wallMedian)}/${fmt(measured.wallMax)} ms, solver ${fmt(observation.durationMs)} ms, nodes=${observation.nodes} guard=${observation.guardHit} accepted=${result.ok}`)
  return { result, observation }
}

await check('[D1] human 4-та карта (main thread): production state (precheck) и guard-hit state', () => {
  setServerSweepEligibilityObserver(captureObserver)
  const case1 = PRODUCTION_FIXTURES[0]!
  const a = humanFourthCard('case 1', { claimant: case1.seat, hands: case1.hands, bid: case1.bid })
  assert(a.observation.rootPrecheckRejected && a.next.playing!.sweepOffer === null, 'case 1: precheck, no offer')
  const guard = guardFixtures.get('suit/5')!
  const b = humanFourthCard('guard suit/5', guard)
  assert(b.observation.guardHit && b.observation.nodes === MAX_SWEEP_SEARCH_NODES + 1 && b.next.playing!.sweepOffer === null, 'guard state: same guard false → no offer')
})

await check('[D2] sweep accept revalidation (main thread): case 2 (precheck) и guard-hit state', () => {
  const case2 = PRODUCTION_FIXTURES[1]!
  const a = humanAccept('case 2', { claimant: case2.seat, hands: case2.hands, bid: case2.bid })
  assert(!a.result.ok && a.observation.rootPrecheckRejected, 'case 2: not eligible → no-op')
  const guard = guardFixtures.get('suit/6')!
  const b = humanAccept('guard suit/6', guard)
  assert(!b.result.ok && b.observation.guardHit && b.observation.nodes === MAX_SWEEP_SEARCH_NODES + 1, 'guard state: not eligible → no-op')
})

// ─── [E] fallback ───────────────────────────────────────────────────────────
await check('[E] дублирани (suit,rank) / id (fabricated) → legacy path, същата семантика като ORIGINAL', () => {
  let checked = 0
  for (let i = 0; i < 300; i += 1) {
    const n = 2 + (i % 4)
    const generated = generate(i % 2 === 0 ? 'random' : 'strong', n)!
    // Дубликат на (suit,rank) с различен id в ръката на противник.
    const victim = generated.hands[getNextSeat(generated.claimant)]
    const clone = { ...generated.hands[generated.claimant][0]!, id: `${generated.hands[generated.claimant][0]!.id}-dup` }
    victim[victim.length - 1] = clone
    const original = originalSweepEligibility(generated.claimant, generated.hands, generated.bid)
    const final = finalOutcome(generated.claimant, generated.hands, generated.bid)
    assert(final.implementation === 'legacy', 'duplicate input uses legacy path')
    assert(final.result === original.result, `result ${final.result} vs ${original.result}`)
    if (!final.rootPrecheckRejected) assert(final.nodes === original.nodes && final.guardHit === original.guardHit, 'deep nodes equal')
    checked += 1
  }
  const tooMany: Hands = { bottom: [], right: [], top: [], left: [] }
  for (let i = 0; i < 36; i += 1) tooMany[SEAT_ORDER[i % 4]!].push({ id: `x-${i}`, suit: SUITS[i % 4]!, rank: RANKS[Math.floor(i / 4) % 8]! })
  assert(finalOutcome('bottom', tooMany, NO_TRUMPS).implementation === 'legacy', '> 32 cards → legacy')
  console.log(`      ${checked} duplicate-card states: legacy path, identical to ORIGINAL`)
})

// ─── [F] observer overhead ──────────────────────────────────────────────────
await check('[F] observer overhead върху guard-hit fixture: без / worker / main observer', () => {
  const fixture = guardFixtures.get('suit/5')!
  const call = () => computeServerSweepEligibility({ sweepSeat: fixture.claimant, hands: fixture.hands, winningBid: fixture.bid })
  setServerSweepEligibilityObserver(null)
  const none = measure(call, 9)
  let collector = startGameWorkerBatchDiagnostics(() => performance.now(), null)
  setServerSweepEligibilityObserver((observation) => collector.recordSweepEligibility(observation))
  const worker = measure(call, 9)
  collector = startGameWorkerBatchDiagnostics(() => performance.now(), null)
  const timings = createMainThreadTimingMetrics()
  setServerSweepEligibilityObserver((observation) => {
    timings.record('gameplay', 'sweepEligibility', observation.durationMs)
    if (observation.guardHit) timings.record('gameplay', 'sweepEligibility.guardHit', observation.durationMs)
  })
  const main = measure(call, 9)
  setServerSweepEligibilityObserver(captureObserver)
  console.log(`      no observer:   wall med/max ${fmt(none.wallMedian)}/${fmt(none.wallMax)} ms`)
  console.log(`      worker obs.:   wall med/max ${fmt(worker.wallMedian)}/${fmt(worker.wallMax)} ms`)
  console.log(`      main obs.:     wall med/max ${fmt(main.wallMedian)}/${fmt(main.wallMax)} ms`)
  // Микро: само цената на observer извикването (performance.now ×2 + record).
  const microRuns = 200000
  let t0 = performance.now()
  for (let i = 0; i < microRuns; i += 1) collector.recordSweepEligibility({ durationMs: 1, nodes: 10, guardHit: false })
  const workerPerCall = ((performance.now() - t0) / microRuns) * 1000
  t0 = performance.now()
  for (let i = 0; i < microRuns; i += 1) timings.record('gameplay', 'sweepEligibility', 1)
  const mainPerCall = ((performance.now() - t0) / microRuns) * 1000
  console.log(`      per-call observer cost: worker ${workerPerCall.toFixed(3)} µs, main ${mainPerCall.toFixed(3)} µs`)
  assert(none.value === worker.value && none.value === main.value, 'same result')
  assert(workerPerCall < 50 && mainPerCall < 50, 'observer cost per call is microseconds')
})

// ─── [G] observer/diagnostics поведение ─────────────────────────────────────
await check('[G1] хвърлящ observer не променя резултата; без observer няма измерване', () => {
  const fixture = PRODUCTION_FIXTURES[0]!
  setServerSweepEligibilityObserver(() => {
    throw new Error('observer broken')
  })
  const withThrowing = computeServerSweepEligibility({ sweepSeat: fixture.seat, hands: fixture.hands, winningBid: fixture.bid })
  setServerSweepEligibilityObserver(null)
  const withoutObserver = computeServerSweepEligibility({ sweepSeat: fixture.seat, hands: fixture.hands, winningBid: fixture.bid })
  setServerSweepEligibilityObserver(captureObserver)
  const trueHands: Hands = {
    bottom: ['clubs-J', 'clubs-9', 'clubs-A'].map(card),
    right: ['diamonds-7', 'diamonds-8', 'diamonds-Q'].map(card),
    top: ['hearts-7', 'hearts-8', 'hearts-Q'].map(card),
    left: ['spades-7', 'spades-8', 'spades-Q'].map(card),
  }
  lastObservation = null
  const eligible = computeServerSweepEligibility({ sweepSeat: 'bottom', hands: trueHands, winningBid: suitBid('clubs') })
  const observation = lastObservation as ServerSweepEligibilityObservation | null
  assert(withThrowing === false && withoutObserver === false, 'same result regardless of observer')
  assert(eligible === true && observation !== null && !observation.rootPrecheckRejected && observation.nodes > 0, JSON.stringify(observation))
})

await check('[G2] worker batch diagnostics: sweep агрегати, sanitize, main-side метрики (bounded)', () => {
  let clock = 0
  const collector = startGameWorkerBatchDiagnostics(() => clock, null)
  collector.recordSweepEligibility({ durationMs: 0.2, nodes: 0, guardHit: false })
  collector.recordSweepEligibility({ durationMs: 850, nodes: 200001, guardHit: true })
  clock = 900
  const diagnostics = collector.finish()
  assert(diagnostics.sweepEligibility?.count === 2 && diagnostics.sweepEligibility.guardHits === 1 && diagnostics.sweepEligibility.maxNodes === 200001, JSON.stringify(diagnostics.sweepEligibility))
  const sanitized = sanitizeGameWorkerBatchDiagnostics(JSON.parse(JSON.stringify(diagnostics)), new Set())
  assert(sanitized?.sweepEligibility?.maxMs === 850, 'sweep stats survive sanitize')
  const corrupted = sanitizeGameWorkerBatchDiagnostics({ ...diagnostics, sweepEligibility: { count: 1, totalMs: -1, maxMs: 'x', guardHits: 5, maxNodes: 1 } }, new Set())
  assert(corrupted !== null && corrupted.sweepEligibility === undefined, 'invalid sweep field dropped alone')
  const noSweep = startGameWorkerBatchDiagnostics(() => 0, null).finish()
  assert(noSweep.sweepEligibility === undefined, 'batch without solver calls has no sweep field')
  const metrics = createGameWorkerBatchMetrics()
  metrics.record(0, { outcome: 'completed', roomCount: 1, roundTripWallMs: 905, requestPostMessageMs: 0.1, diagnostics: sanitized } as never)
  const snapshot = metrics.snapshotOneSecondAndReset()
  assert(snapshot.w1?.sweepEligibilityCount === 2 && snapshot.w1.sweepEligibilityGuardHits === 1 && snapshot.w1.sweepEligibilityMaxMs === 850, JSON.stringify(snapshot.w1))
})

console.log(`\n  passed=${passed} failed=${failed}`)
if (failed > 0) process.exit(1)
