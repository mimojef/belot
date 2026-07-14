/**
 * checkMatchmakingBlockedPartnership.ts
 *
 * Verifies that matchmaking never seats two mutually-blocked human players as
 * partners, while still allowing them to be seated as opponents at the same
 * table. Covers:
 *  - resolveMatchmakingSeats (pure seat resolver): symmetric block check,
 *    initialSeatOrder preserved when valid, exhaustive 24-permutation
 *    fallback, null when no valid partnership seating exists.
 *  - createMatchedRoomFromEntries: accepts a pre-resolved seat order, humans
 *    get the first entries.length seats, bots get the remainder.
 *  - tryCreatePendingMatchGroup: skips a stake with an unresolvable block
 *    conflict without mutating the queue, keeps processing other stakes,
 *    and throttles the diagnostic warning.
 */

// This script's DB has no seeded bot catalog for the test stakes used below;
// allow the deterministic in-process bot fallback so createMatchedRoomFromEntries
// can seat bots without depending on external DB fixtures.
process.env.BELOT_ALLOW_CATALOG_BOT_FALLBACK = '1'

import { SERVER_SEAT_ORDER, SERVER_TEAM_A_SEATS, type Seat } from '../src/core/serverTypes.js'
import { createMatchedRoomFromEntries } from '../src/matchmaking/createMatchedRoomFromEntries.js'
import { resolveMatchmakingSeats } from '../src/matchmaking/resolveMatchmakingSeats.js'
import { tryCreatePendingMatchGroup } from '../src/matchmaking/tryCreatePendingMatchGroup.js'
import {
  MATCHMAKING_WAIT_MS,
  setSupportedMatchStakes,
  type MatchmakingQueueEntry,
} from '../src/matchmaking/matchmakingTypes.js'
import type { MatchmakingState } from '../src/matchmaking/matchmakingState.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}`)
    failed++
  }
}

const TEAM_A = new Set<Seat>(SERVER_TEAM_A_SEATS)
function isPartner(seatA: Seat, seatB: Seat): boolean {
  return TEAM_A.has(seatA) === TEAM_A.has(seatB)
}

const BASE = 1_700_000_000_000
const STAKE = 5000

function makeEntry(id: string, joinedAtOffset: number, profileId: string | null = `profile-${id}`): MatchmakingQueueEntry {
  const joinedAt = BASE + joinedAtOffset
  return {
    entryId: `entry-${id}`,
    connectionId: `conn-${id}`,
    playerId: `player-${id}`,
    profileId,
    displayName: `Player ${id}`,
    publicProfile: null,
    stake: STAKE,
    stakePaid: false,
    joinedAt,
    expiresAt: joinedAt + MATCHMAKING_WAIT_MS,
    status: 'searching',
  }
}

function seatOf(entries: MatchmakingQueueEntry[], seatOrder: Seat[], id: string): Seat {
  const index = entries.findIndex((e) => e.entryId === `entry-${id}`)
  if (index === -1) throw new Error(`entry-${id} not found`)
  const seat = seatOrder[index]
  if (!seat) throw new Error(`no seat for entry-${id}`)
  return seat
}

// ---------------------------------------------------------------------------
// resolveMatchmakingSeats — pure unit tests
// ---------------------------------------------------------------------------

// [1] No blocks → initialSeatOrder preserved unchanged
{
  const entries = [makeEntry('A', 0), makeEntry('B', 1), makeEntry('C', 2), makeEntry('D', 3)]
  const initial: Seat[] = ['right', 'bottom', 'left', 'top']
  const result = resolveMatchmakingSeats(entries, initial, () => false)
  check('[1] no blocks → initialSeatOrder returned unchanged (same reference)', result === initial)
}

// [2] Result always contains exactly the 4 unique seats
{
  const entries = [makeEntry('A', 0), makeEntry('B', 1)]
  const initial: Seat[] = [...SERVER_SEAT_ORDER]
  const result = resolveMatchmakingSeats(entries, initial, (a, b) => a === 'profile-A' && b === 'profile-B')
  check(
    '[2] resolved seat order has exactly 4 unique seats',
    result !== null && new Set(result).size === 4 && result.length === 4,
  )
}

// [3] A→B blocks partnership
{
  const entries = [makeEntry('A', 0), makeEntry('B', 1), makeEntry('C', 2), makeEntry('D', 3)]
  const initial: Seat[] = ['bottom', 'top', 'right', 'left'] // A,B partners initially
  const isBlocked = (a: string, b: string) => a === 'profile-A' && b === 'profile-B'
  const result = resolveMatchmakingSeats(entries, initial, isBlocked)
  check(
    '[3] A→B blocks partnership → A and B not seated as partners',
    result !== null && !isPartner(seatOf(entries, result, 'A'), seatOf(entries, result, 'B')),
  )
}

// [4] B→A blocks partnership (reverse direction only)
{
  const entries = [makeEntry('A', 0), makeEntry('B', 1), makeEntry('C', 2), makeEntry('D', 3)]
  const initial: Seat[] = ['bottom', 'top', 'right', 'left']
  const isBlocked = (a: string, b: string) => a === 'profile-B' && b === 'profile-A'
  const result = resolveMatchmakingSeats(entries, initial, isBlocked)
  check(
    '[4] B→A blocks partnership → A and B not seated as partners',
    result !== null && !isPartner(seatOf(entries, result, 'A'), seatOf(entries, result, 'B')),
  )
}

// [5] Mutual block forbids partnership
{
  const entries = [makeEntry('A', 0), makeEntry('B', 1), makeEntry('C', 2), makeEntry('D', 3)]
  const initial: Seat[] = ['bottom', 'top', 'right', 'left']
  const isBlocked = (a: string, b: string) =>
    (a === 'profile-A' && b === 'profile-B') || (a === 'profile-B' && b === 'profile-A')
  const result = resolveMatchmakingSeats(entries, initial, isBlocked)
  check(
    '[5] mutual block → A and B not seated as partners',
    result !== null && !isPartner(seatOf(entries, result, 'A'), seatOf(entries, result, 'B')),
  )
}

// [6] Blocked pair CAN be opponents
{
  const entries = [makeEntry('A', 0), makeEntry('B', 1), makeEntry('C', 2), makeEntry('D', 3)]
  const initial: Seat[] = ['bottom', 'right', 'top', 'left'] // A,B already opponents
  const isBlocked = (a: string, b: string) =>
    (a === 'profile-A' && b === 'profile-B') || (a === 'profile-B' && b === 'profile-A')
  const result = resolveMatchmakingSeats(entries, initial, isBlocked)
  check(
    '[6] blocked pair can be opponents → valid initial order preserved as-is',
    result === initial && !isPartner(seatOf(entries, result!, 'A'), seatOf(entries, result!, 'B')),
  )
}

// [7] 2 blocked humans + 2 bots → room created, humans seated as opponents, never partners
{
  const entries = [makeEntry('A', 0), makeEntry('B', 1)]
  const initial: Seat[] = ['bottom', 'top', 'right', 'left'] // A,B partners initially — must be fixed
  const isBlocked = (a: string, b: string) =>
    (a === 'profile-A' && b === 'profile-B') || (a === 'profile-B' && b === 'profile-A')
  const result = resolveMatchmakingSeats(entries, initial, isBlocked)
  check(
    '[7] 2 blocked humans + 2 bots → valid seating found (never null)',
    result !== null,
  )
  check(
    '[7] 2 blocked humans + 2 bots → seated as opponents, not partners',
    result !== null && !isPartner(seatOf(entries, result, 'A'), seatOf(entries, result, 'B')),
  )

  if (result !== null) {
    const { room, group } = createMatchedRoomFromEntries(entries, false, result, undefined, 2)
    const seatA = group.seatAssignments.find((s) => s.playerId === 'player-A')?.seat
    const seatB = group.seatAssignments.find((s) => s.playerId === 'player-B')?.seat
    check('[7] room created with 2 bots added', room.id !== '' && group.addedBots.length === 2)
    check(
      '[7] humans A and B are opponents in the created room',
      seatA !== undefined && seatB !== undefined && !isPartner(seatA, seatB),
    )
  }
}

// [8] 3 humans + 1 bot: valid seating found when one exists
{
  const entries = [makeEntry('A', 0), makeEntry('B', 1), makeEntry('C', 2)]
  const initial: Seat[] = ['bottom', 'top', 'right', 'left'] // A,B partners — blocked
  const isBlocked = (a: string, b: string) =>
    (a === 'profile-A' && b === 'profile-B') || (a === 'profile-B' && b === 'profile-A')
  const result = resolveMatchmakingSeats(entries, initial, isBlocked)
  check(
    '[8] 3 humans + 1 bot, A-B blocked → valid seating found (A,C or B,C partners)',
    result !== null && !isPartner(seatOf(entries, result, 'A'), seatOf(entries, result, 'B')),
  )
}

// [9] 4 humans: one of the three valid team partitions is found
{
  const entries = [makeEntry('A', 0), makeEntry('B', 1), makeEntry('C', 2), makeEntry('D', 3)]
  const initial: Seat[] = ['bottom', 'top', 'right', 'left'] // A-B, C-D partners
  // Block A-B and C-D partnerships — only A-C/B-D or A-D/B-C partitions remain valid.
  const isBlocked = (a: string, b: string) =>
    (a === 'profile-A' && b === 'profile-B') ||
    (a === 'profile-C' && b === 'profile-D')
  const result = resolveMatchmakingSeats(entries, initial, isBlocked)
  check(
    '[9] 4 humans, A-B and C-D partnerships blocked → alternate valid partition found',
    result !== null &&
      !isPartner(seatOf(entries, result, 'A'), seatOf(entries, result, 'B')) &&
      !isPartner(seatOf(entries, result, 'C'), seatOf(entries, result, 'D')),
  )
}

// [10] Impossible fixed group → null (one human blocked with all others)
{
  const entries = [makeEntry('A', 0), makeEntry('B', 1), makeEntry('C', 2), makeEntry('D', 3)]
  const initial: Seat[] = [...SERVER_SEAT_ORDER]
  // A is blocked with everyone → every partition puts A next to a blocked partner.
  const isBlocked = (a: string, b: string) =>
    (a === 'profile-A' || b === 'profile-A') && a !== b
  const result = resolveMatchmakingSeats(entries, initial, isBlocked)
  check('[10] one human blocked with all others → no valid seating (null)', result === null)
}

// [10b] Impossible fixed group → null (3-cycle mutual block, 4th free)
{
  const entries = [makeEntry('A', 0), makeEntry('B', 1), makeEntry('C', 2), makeEntry('D', 3)]
  const initial: Seat[] = [...SERVER_SEAT_ORDER]
  const blockedPairs = new Set(['profile-A|profile-B', 'profile-B|profile-C', 'profile-C|profile-A'])
  const isBlocked = (a: string, b: string) => blockedPairs.has(`${a}|${b}`) || blockedPairs.has(`${b}|${a}`)
  const result = resolveMatchmakingSeats(entries, initial, isBlocked)
  check('[10b] three-way mutual block cycle among 3 of 4 humans → no valid seating (null)', result === null)
}

// [10c] Pair-block cache bound: an impossible 4-human configuration must not
// invoke isBlocked more than 12 times (6 unordered pairs × 2 directions),
// even though every one of the 24 seat permutations gets evaluated.
{
  const entries = [makeEntry('A', 0), makeEntry('B', 1), makeEntry('C', 2), makeEntry('D', 3)]
  const initial: Seat[] = [...SERVER_SEAT_ORDER]
  let callCount = 0
  const isBlocked = (a: string, b: string) => {
    callCount++
    // A is blocked with everyone → no valid partnership seating exists.
    return (a === 'profile-A' || b === 'profile-A') && a !== b
  }
  const result = resolveMatchmakingSeats(entries, initial, isBlocked)
  check('[10c] impossible 4-human config still resolves to null', result === null)
  check(
    `[10c] isBlocked invoked at most 12 times despite checking all seat permutations (actual: ${callCount})`,
    callCount <= 12,
  )
}

// [11] Independent brute-force oracle matrix — proves the production
// resolveMatchmakingSeats agrees with an exhaustive ground-truth search
// across every block graph shape for 2, 3, and 4 humans, and every possible
// initialSeatOrder. This does NOT reuse any resolver internals — the oracle
// is a separate, from-scratch enumeration written only in the test file.

// Test-local permutation generator (independent from the production
// generateAllFourSeatPermutations in resolveMatchmakingSeats.ts).
function oracleAllFourSeatPermutations(seats: Seat[]): Seat[][] {
  function permute(arr: Seat[]): Seat[][] {
    if (arr.length <= 1) return [arr]
    const out: Seat[][] = []
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
      for (const p of permute(rest)) out.push([arr[i]!, ...p])
    }
    return out
  }
  return permute(seats)
}

{
  const allPerms = oracleAllFourSeatPermutations([...SERVER_SEAT_ORDER])
  const seen = new Set(allPerms.map((p) => p.join(',')))
  check('[11] there are exactly 24 unique 4-seat permutations', seen.size === 24 && allPerms.length === 24)
}

// Ground-truth oracle: does ANY of the 24 seat permutations yield a seating
// with no blocked human partnership, for this exact entries + block graph?
function oracleHasValidSeating(
  entries: MatchmakingQueueEntry[],
  isBlockedUndirected: (a: string, b: string) => boolean,
): boolean {
  for (const seatOrder of oracleAllFourSeatPermutations([...SERVER_SEAT_ORDER])) {
    let valid = true
    for (let i = 0; i < entries.length && valid; i++) {
      for (let j = i + 1; j < entries.length && valid; j++) {
        const seatI = seatOrder[i]!
        const seatJ = seatOrder[j]!
        if (!isPartner(seatI, seatJ)) continue
        const a = entries[i].profileId
        const b = entries[j].profileId
        if (a && b && isBlockedUndirected(a, b)) valid = false
      }
    }
    if (valid) return true
  }
  return false
}

function oracleSeatingIsValid(
  entries: MatchmakingQueueEntry[],
  seatOrder: Seat[],
  isBlockedUndirected: (a: string, b: string) => boolean,
): boolean {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const seatI = seatOrder[i]!
      const seatJ = seatOrder[j]!
      if (!isPartner(seatI, seatJ)) continue
      const a = entries[i].profileId
      const b = entries[j].profileId
      if (a && b && isBlockedUndirected(a, b)) return false
    }
  }
  return true
}

function runOracleMatrix(label: string, humanCount: number, pairCount: number): void {
  const ids = ['A', 'B', 'C', 'D'].slice(0, humanCount)
  const entries = ids.map((id, i) => makeEntry(id, i))
  const pairIndices: [number, number][] = []
  for (let i = 0; i < humanCount; i++) {
    for (let j = i + 1; j < humanCount; j++) pairIndices.push([i, j])
  }
  // pairIndices.length must equal pairCount (2 humans→1 pair, 3→3 pairs, 4→6 pairs)
  const graphCount = 2 ** pairCount
  const allSeatPermutations = oracleAllFourSeatPermutations([...SERVER_SEAT_ORDER])

  let mismatches = 0
  let checkedCombinations = 0

  for (let mask = 0; mask < graphCount; mask++) {
    const blockedPairs = new Set<string>()
    for (let p = 0; p < pairIndices.length; p++) {
      if ((mask & (1 << p)) !== 0) {
        const [i, j] = pairIndices[p]!
        blockedPairs.add(canonicalKeyForTest(entries[i].profileId!, entries[j].profileId!))
      }
    }
    const isBlockedUndirected = (a: string, b: string) => blockedPairs.has(canonicalKeyForTest(a, b))
    const isBlockedDirected = (a: string, b: string) => isBlockedUndirected(a, b)

    const oracleHasSolution = oracleHasValidSeating(entries, isBlockedUndirected)

    for (const initial of allSeatPermutations) {
      checkedCombinations++
      const production = resolveMatchmakingSeats(entries, initial, isBlockedDirected)

      let ok = true
      if (!oracleHasSolution) {
        ok = production === null
      } else {
        ok =
          production !== null &&
          production.length === 4 &&
          new Set(production).size === 4 &&
          oracleSeatingIsValid(entries, production, isBlockedUndirected)
      }

      if (!ok) {
        mismatches++
        if (mismatches <= 3) {
          console.error(
            `    MISMATCH humanCount=${humanCount} graphMask=${mask} initialSeatOrder=${initial.join(',')} ` +
            `oracleHasSolution=${oracleHasSolution} production=${production === null ? 'null' : production.join(',')}`,
          )
        }
      }
    }
  }

  check(
    `[11] ${label}: production matches brute-force oracle for all ${graphCount} block graphs × 24 initial orders (${checkedCombinations} combinations, ${mismatches} mismatches)`,
    mismatches === 0,
  )
}

function canonicalKeyForTest(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

// A) 2 humans: 2^1 = 2 block graphs × 24 initial orders
runOracleMatrix('2 humans', 2, 1)
// B) 3 humans: 2^3 = 8 block graphs × 24 initial orders
runOracleMatrix('3 humans', 3, 3)
// C) 4 humans: 2^6 = 64 block graphs × 24 initial orders
runOracleMatrix('4 humans', 4, 6)

// ---------------------------------------------------------------------------
// createMatchedRoomFromEntries — bots receive the remaining seats
// ---------------------------------------------------------------------------

// [12] Bots get resolvedSeatOrder[entries.length..3]
{
  const entries = [makeEntry('A', 0), makeEntry('B', 1)]
  const resolvedSeatOrder: Seat[] = ['left', 'right', 'bottom', 'top']
  const { group } = createMatchedRoomFromEntries(entries, false, resolvedSeatOrder, undefined, 2)
  const seatA = group.seatAssignments.find((s) => s.playerId === 'player-A')?.seat
  const seatB = group.seatAssignments.find((s) => s.playerId === 'player-B')?.seat
  const botSeats = group.seatAssignments.filter((s) => s.isBot).map((s) => s.seat).sort()
  check('[12] humans occupy resolvedSeatOrder[0] and [1]', seatA === 'left' && seatB === 'right')
  check(
    '[12] bots occupy the remaining resolvedSeatOrder positions',
    botSeats.length === 2 && botSeats.join(',') === ['bottom', 'top'].sort().join(','),
  )
}

// ---------------------------------------------------------------------------
// tryCreatePendingMatchGroup — integration: queue safety, cross-stake, throttle
// ---------------------------------------------------------------------------

function makeState(entries: MatchmakingQueueEntry[]): MatchmakingState {
  return { queueEntries: entries, pendingGroups: [], lastProcessedAt: null }
}

// [13] Impossible group at one stake does not mutate the queue
{
  setSupportedMatchStakes([STAKE])
  const now = BASE + MATCHMAKING_WAIT_MS // ensure ready (4 humans → immediate)
  const entries = [makeEntry('A', 0), makeEntry('B', 1), makeEntry('C', 2), makeEntry('D', 3)]
  const isBlocked = (a: string, b: string) => (a === 'profile-A' || b === 'profile-A') && a !== b
  const state = makeState(entries)
  const result = tryCreatePendingMatchGroup(state, isBlocked, undefined, now)

  check('[13] no room created for unresolvable block conflict', result.room === null && result.group === null)
  check(
    '[13] queue entries unchanged (no status/joinedAt/entryId mutation, no loss/duplication)',
    result.matchmakingState.queueEntries.length === entries.length &&
      result.matchmakingState.queueEntries.every((e, i) => {
        const original = entries[i]
        return (
          original !== undefined &&
          e.entryId === original.entryId &&
          e.status === original.status &&
          e.joinedAt === original.joinedAt
        )
      }),
  )
}

// [14] createMatchedRoomFromEntries / createTempBot not invoked for an impossible group
{
  setSupportedMatchStakes([STAKE])
  const now = BASE + MATCHMAKING_WAIT_MS
  const entries = [makeEntry('A', 0), makeEntry('B', 1), makeEntry('C', 2), makeEntry('D', 3)]
  const isBlocked = (a: string, b: string) => (a === 'profile-A' || b === 'profile-A') && a !== b
  let tempBotCalls = 0
  const createTempBot = () => {
    tempBotCalls++
    return null
  }
  const result = tryCreatePendingMatchGroup(makeState(entries), isBlocked, createTempBot, now)
  check('[14] createTempBot never invoked for an unresolvable group', tempBotCalls === 0)
  check('[14] result outcome is the existing no-match shape (room/group both null)', result.room === null && result.group === null)
}

// [15] A conflict on one stake does not block processing of another stake
{
  const STAKE_A = 4000
  const STAKE_B = 6000
  setSupportedMatchStakes([STAKE_A, STAKE_B])
  const now = BASE + MATCHMAKING_WAIT_MS

  const blockedEntries = [
    { ...makeEntry('A', 0), stake: STAKE_A, expiresAt: BASE + MATCHMAKING_WAIT_MS },
    { ...makeEntry('B', 1), stake: STAKE_A, expiresAt: BASE + 1 + MATCHMAKING_WAIT_MS },
    { ...makeEntry('C', 2), stake: STAKE_A, expiresAt: BASE + 2 + MATCHMAKING_WAIT_MS },
    { ...makeEntry('D', 3), stake: STAKE_A, expiresAt: BASE + 3 + MATCHMAKING_WAIT_MS },
  ]
  const clearEntries = [
    { ...makeEntry('E', 4), stake: STAKE_B, expiresAt: BASE + 4 + MATCHMAKING_WAIT_MS },
    { ...makeEntry('F', 5), stake: STAKE_B, expiresAt: BASE + 5 + MATCHMAKING_WAIT_MS },
    { ...makeEntry('G', 6), stake: STAKE_B, expiresAt: BASE + 6 + MATCHMAKING_WAIT_MS },
    { ...makeEntry('H', 7), stake: STAKE_B, expiresAt: BASE + 7 + MATCHMAKING_WAIT_MS },
  ]
  const isBlocked = (a: string, b: string) => (a === 'profile-A' || b === 'profile-A') && a !== b
  const result = tryCreatePendingMatchGroup(
    makeState([...blockedEntries, ...clearEntries]),
    isBlocked,
    undefined,
    now,
  )

  check(
    '[15] stake with unresolvable conflict is skipped, next stake still produces a room',
    result.room !== null && result.group !== null && result.group.stake === STAKE_B,
  )
  check(
    '[15] blocked-stake entries remain untouched (still searching) after the other stake matched',
    result.matchmakingState.queueEntries.filter((e) => e.stake === STAKE_A).length === 4 &&
      result.matchmakingState.queueEntries.filter((e) => e.stake === STAKE_A && e.status === 'searching').length === 4,
  )
}

// [16] Warning throttle: repeated ticks within 60s for the same stake warn at most once
// Uses a stake untouched by earlier tests so its throttle-map entry starts fresh.
{
  const THROTTLE_TEST_STAKE = 7777
  setSupportedMatchStakes([THROTTLE_TEST_STAKE])
  const entries = [
    { ...makeEntry('A', 0), stake: THROTTLE_TEST_STAKE },
    { ...makeEntry('B', 1), stake: THROTTLE_TEST_STAKE },
    { ...makeEntry('C', 2), stake: THROTTLE_TEST_STAKE },
    { ...makeEntry('D', 3), stake: THROTTLE_TEST_STAKE },
  ]
  const isBlocked = (a: string, b: string) => (a === 'profile-A' || b === 'profile-A') && a !== b

  const originalWarn = console.warn
  let warnCalls = 0
  console.warn = () => {
    warnCalls++
  }

  const now = BASE + MATCHMAKING_WAIT_MS
  tryCreatePendingMatchGroup(makeState(entries), isBlocked, undefined, now)
  tryCreatePendingMatchGroup(makeState(entries), isBlocked, undefined, now + 1_000)
  tryCreatePendingMatchGroup(makeState(entries), isBlocked, undefined, now + 30_000)

  console.warn = originalWarn
  check('[16] warning throttled to at most once within a 60s window for the same stake', warnCalls === 1)
}

// ---------------------------------------------------------------------------
// Regression: normal matchmaking without blocks is unaffected
// ---------------------------------------------------------------------------

// [17] No blocks → behaviour identical to pre-patch (room created, 4 humans, no bots)
{
  setSupportedMatchStakes([STAKE])
  const now = BASE + MATCHMAKING_WAIT_MS
  const entries = [makeEntry('A', 0), makeEntry('B', 1), makeEntry('C', 2), makeEntry('D', 3)]
  const result = tryCreatePendingMatchGroup(makeState(entries), (_a, _b) => false, undefined, now)

  check(
    '[17] normal matchmaking without blocks creates a room with all 4 humans, no bots',
    result.room !== null &&
      result.group !== null &&
      result.group.matchedHumans.length === 4 &&
      result.group.addedBots.length === 0,
  )
  check(
    '[17] queue is emptied for the matched entries',
    result.matchmakingState.queueEntries.length === 0,
  )
}

// ---------------------------------------------------------------------------

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
