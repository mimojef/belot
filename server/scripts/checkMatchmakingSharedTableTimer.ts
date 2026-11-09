/**
 * checkMatchmakingSharedTableTimer.ts
 *
 * Fixed shared timer for a random Belot table (MATCHMAKING_WAIT_MS = 180s).
 * Drives the real createMatchmakingQueueEntry + getSharedTableTimer (the
 * join handler) and tryCreatePendingMatchGroup on a 250ms tick (the
 * matchmaking interval), with a fake clock. Leave/cancel/disconnect all go
 * through removeQueueEntryByConnectionId (removeConnectionFromMatchmaking).
 *
 * [1]  1 human → 3 bots, room at t=179s (bot-fill unchanged)
 * [2]  2 humans → 2 bots at t=178s; 3 humans → 1 bot at t=177s
 * [3]  2nd joins at 60s → sees 120s; 3rd at 100s → same deadline
 * [4]  1st leaves at 90s → 2nd keeps 90s left, room still at ≤180s (not extended)
 * [5]  new player joins after the 1st left → inherits the same deadline
 * [6]  all leave → queue freed, next player starts a fresh 180s
 * [7]  4 humans → immediate start, no bots
 * [8]  leave + join in the same ms (both orders)
 * [9]  disconnect + rejoin while others wait → actual remaining time
 * [10] no double start, no duplicate seats, nobody matched twice
 * [11] every waiting entry shares one expiresAt
 * [12] admin changes 180→120 while a table waits → that table keeps its
 *      deadline and 180s duration; the next new table uses 120s
 * [13] admin change with an empty queue → next table 120s, bots at 117–119s
 */

import { createMatchmakingQueueEntry } from '../src/matchmaking/createMatchmakingQueueEntry.js'
import { getSharedTableTimer } from '../src/matchmaking/getSharedTableTimer.js'
import { getSearchingEntriesByStake } from '../src/matchmaking/getSearchingEntriesByStake.js'
import { removeQueueEntryByConnectionId } from '../src/matchmaking/removeQueueEntryByConnectionId.js'
import { tryCreatePendingMatchGroup } from '../src/matchmaking/tryCreatePendingMatchGroup.js'
import {
  MATCHMAKING_WAIT_MS,
  setSupportedMatchStakes,
  type PendingMatchGroup,
} from '../src/matchmaking/matchmakingTypes.js'
import type { MatchmakingState } from '../src/matchmaking/matchmakingState.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` (${detail})` : ''}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}${detail ? ` (${detail})` : ''}`)
    failed++
  }
}

const STAKE = 5000
const TICK_MS = 250
const BASE = 1_700_000_000_000
const W = MATCHMAKING_WAIT_MS
setSupportedMatchStakes([STAKE])

let clock = BASE
const realDateNow = Date.now
Date.now = () => clock

// setWaitMs = admin saves a new "Белот — изчакване на случайна маса" value.
type Event = { at: number; join?: string; leave?: string; setWaitMs?: number }
type Matched = { at: number; group: PendingMatchGroup }
type RunResult = {
  groups: Matched[]
  // remainingMs the joining player is shown (shared table deadline - now)
  seenOnJoin: Record<string, number>
  // totalDurationMs (progress ring) the joining player is shown
  durationOnJoin: Record<string, number>
  // remainingMs a player is shown at a given probe time
  probes: Record<string, number | null>
  expiresAtSnapshots: number[][]
  state: MatchmakingState
}

function run(events: Event[], until: number, probeAt: { at: number; key: string }[] = []): RunResult {
  let state: MatchmakingState = { queueEntries: [], pendingGroups: [], lastProcessedAt: null }
  const result: RunResult = { groups: [], seenOnJoin: {}, durationOnJoin: {}, probes: {}, expiresAtSnapshots: [], state }
  let adminWaitMs = W
  const pending = [...events].sort((a, b) => a.at - b.at)
  const probes = [...probeAt].sort((a, b) => a.at - b.at)

  const process = () => {
    for (let guard = 0; guard < 20; guard++) {
      const r = tryCreatePendingMatchGroup(state, () => false, (_s, profileId) => `Temp ${profileId}`, clock)
      if (r.room === null || r.group === null) return
      state = r.matchmakingState
      result.groups.push({ at: clock - BASE, group: r.group })
    }
  }

  for (let t = 0; t <= until; t += TICK_MS) {
    while (pending.length > 0 && pending[0]!.at <= t) {
      const ev = pending.shift()!
      clock = BASE + ev.at
      if (ev.setWaitMs !== undefined) adminWaitMs = ev.setWaitMs
      if (ev.join) {
        const entry = createMatchmakingQueueEntry({
          connectionId: `conn-${ev.join}`,
          playerId: `player-${ev.join}`,
          profileId: `profile-${ev.join}`,
          displayName: ev.join,
          stake: STAKE,
          waitMs: adminWaitMs,
          tableTimer: getSharedTableTimer(state.queueEntries, STAKE),
        })
        state = { ...state, queueEntries: [...state.queueEntries, entry] }
        const timer = getSharedTableTimer(state.queueEntries, STAKE)!
        result.seenOnJoin[ev.join] = timer.expiresAt - clock
        result.durationOnJoin[ev.join] = timer.waitDurationMs
        process() // join handler calls processMatchmaking() synchronously
      }
      if (ev.leave) {
        state = { ...state, queueEntries: removeQueueEntryByConnectionId(state.queueEntries, `conn-${ev.leave}`) }
      }
      result.expiresAtSnapshots.push(getSearchingEntriesByStake(state.queueEntries, STAKE).map((e) => e.expiresAt))
    }
    while (probes.length > 0 && probes[0]!.at <= t) {
      const probe = probes.shift()!
      clock = BASE + probe.at
      const timer = getSharedTableTimer(state.queueEntries, STAKE)
      result.probes[probe.key] = timer === null ? null : timer.expiresAt - clock
    }
    clock = BASE + t
    process()
  }

  result.state = state
  return result
}

const bots = (m: Matched | undefined) => m?.group.seatAssignments.filter((s) => s.isBot).length ?? -1
const humans = (m: Matched | undefined) => m?.group.matchedHumans.map((e) => e.displayName).join(',') ?? ''

// [1] 1 human → 3 bots at the end
{
  const r = run([{ at: 0, join: 'A' }], W + 5_000)
  check('[1] one room', r.groups.length === 1)
  check('[1] 3 bots', bots(r.groups[0]) === 3)
  check('[1] room at t=179s (last 3s, one bot per second)', r.groups[0]?.at === W - 1_000, `at=${r.groups[0]?.at}`)
  check('[1] first player sees 180000ms', r.seenOnJoin.A === W, `seen=${r.seenOnJoin.A}`)
}

// [2] 2 humans → 2 bots at 178s; 3 humans → 1 bot at 177s
{
  const two = run([{ at: 0, join: 'A' }, { at: 30_000, join: 'B' }], W + 5_000)
  check('[2] 2 humans → 2 bots at t=178s', two.groups.length === 1 && bots(two.groups[0]) === 2 && two.groups[0]!.at === W - 2_000, `at=${two.groups[0]?.at}`)
  const three = run([{ at: 0, join: 'A' }, { at: 30_000, join: 'B' }, { at: 40_000, join: 'C' }], W + 5_000)
  check('[2] 3 humans → 1 bot at t=177s', three.groups.length === 1 && bots(three.groups[0]) === 1 && three.groups[0]!.at === W - 3_000, `at=${three.groups[0]?.at}`)
}

// [3] 2nd at 60s sees 120s, 3rd at 100s sees same deadline
{
  const r = run([{ at: 0, join: 'A' }, { at: 60_000, join: 'B' }, { at: 100_000, join: 'C' }], W + 5_000)
  check('[3] 2nd player sees 120000ms', r.seenOnJoin.B === 120_000, `seen=${r.seenOnJoin.B}`)
  check('[3] 3rd player sees 80000ms (same deadline)', r.seenOnJoin.C === 80_000, `seen=${r.seenOnJoin.C}`)
}

// [4] 1st leaves at 90s → 2nd keeps 90s, room not extended
{
  const r = run(
    [{ at: 0, join: 'A' }, { at: 60_000, join: 'B' }, { at: 90_000, leave: 'A' }],
    W + 70_000,
    [{ at: 90_000, key: 'B@90' }],
  )
  check('[4] after 1st leaves, 2nd sees 90000ms', r.probes['B@90'] === 90_000, `seen=${r.probes['B@90']}`)
  check('[4] room for B at t=179s with 3 bots (not 60s+180s)', r.groups.length === 1 && humans(r.groups[0]) === 'B' && bots(r.groups[0]) === 3 && r.groups[0]!.at === W - 1_000, `at=${r.groups[0]?.at}`)
}

// [5] new player joins after the 1st left → same deadline
{
  const r = run(
    [{ at: 0, join: 'A' }, { at: 60_000, join: 'B' }, { at: 90_000, leave: 'A' }, { at: 120_000, join: 'C' }],
    W + 70_000,
  )
  check('[5] new player after 1st left sees 60000ms', r.seenOnJoin.C === 60_000, `seen=${r.seenOnJoin.C}`)
  check('[5] B+C + 2 bots at t=178s', r.groups.length === 1 && humans(r.groups[0]) === 'B,C' && bots(r.groups[0]) === 2 && r.groups[0]!.at === W - 2_000, `at=${r.groups[0]?.at}`)
}

// [6] all leave → next player starts fresh 180s
{
  const r = run(
    [{ at: 0, join: 'A' }, { at: 60_000, join: 'B' }, { at: 90_000, leave: 'A' }, { at: 100_000, leave: 'B' }, { at: 150_000, join: 'C' }],
    150_000 + W + 5_000,
  )
  check('[6] after everyone left, next player sees fresh 180000ms', r.seenOnJoin.C === W, `seen=${r.seenOnJoin.C}`)
  check('[6] no room for the abandoned table', r.groups.length === 1 && humans(r.groups[0]) === 'C')
  check('[6] C filled with 3 bots at 150s+179s', r.groups[0]?.at === 150_000 + W - 1_000, `at=${r.groups[0]?.at}`)
}

// [7] 4 humans → immediate start
{
  const r = run(
    [{ at: 0, join: 'A' }, { at: 60_000, join: 'B' }, { at: 100_000, join: 'C' }, { at: 130_000, join: 'D' }],
    W + 5_000,
  )
  check('[7] started at the 4th join (130s)', r.groups.length === 1 && r.groups[0]!.at === 130_000 && r.groups[0]!.group.shouldStartImmediately)
  check('[7] no bots', bots(r.groups[0]) === 0)
  check('[7] queue empty afterwards', getSearchingEntriesByStake(r.state.queueEntries, STAKE).length === 0)
}

// [8] leave + join in the same millisecond (both orders)
{
  // Others still waiting: order does not matter, deadline stays.
  const a = run([{ at: 0, join: 'A' }, { at: 60_000, join: 'B' }, { at: 90_000, leave: 'A' }, { at: 90_000, join: 'C' }], W + 5_000)
  check('[8] A leaves then C joins (B waiting) → C sees 90000ms', a.seenOnJoin.C === 90_000, `seen=${a.seenOnJoin.C}`)
  const b = run([{ at: 0, join: 'A' }, { at: 60_000, join: 'B' }, { at: 90_000, join: 'C' }, { at: 90_000, leave: 'A' }], W + 5_000)
  check('[8] C joins then A leaves (B waiting) → C sees 90000ms', b.seenOnJoin.C === 90_000, `seen=${b.seenOnJoin.C}`)
  check('[8] both orders: one room B,C + 2 bots at t=178s', a.groups.length === 1 && b.groups.length === 1 && humans(a.groups[0]) === 'B,C' && humans(b.groups[0]) === 'B,C' && a.groups[0]!.at === W - 2_000 && b.groups[0]!.at === W - 2_000)
  // Sole player: leave first frees the table, join first keeps it.
  const c = run([{ at: 0, join: 'A' }, { at: 90_000, leave: 'A' }, { at: 90_000, join: 'C' }], 90_000 + W + 5_000)
  check('[8] sole A leaves then C joins → fresh 180000ms', c.seenOnJoin.C === W, `seen=${c.seenOnJoin.C}`)
  const d = run([{ at: 0, join: 'A' }, { at: 90_000, join: 'C' }, { at: 90_000, leave: 'A' }], 90_000 + W + 5_000)
  check('[8] C joins then sole A leaves → C keeps table deadline (90000ms)', d.seenOnJoin.C === 90_000 && d.groups[0]?.at === W - 1_000, `seen=${d.seenOnJoin.C} at=${d.groups[0]?.at}`)
}

// [9] disconnect + rejoin while others wait → actual remaining time
{
  const r = run(
    [{ at: 0, join: 'A' }, { at: 60_000, join: 'B' }, { at: 100_000, leave: 'B' }, { at: 105_000, join: 'B' }],
    W + 5_000,
  )
  check('[9] B reconnects at 105s → sees 75000ms (no restart)', r.seenOnJoin.B === 75_000, `seen=${r.seenOnJoin.B}`)
  check('[9] one room A,B + 2 bots at t=178s', r.groups.length === 1 && humans(r.groups[0]) === 'A,B' && bots(r.groups[0]) === 2 && r.groups[0]!.at === W - 2_000)
}

// [10] no double start / duplicate seats across a busy timeline
{
  const r = run(
    [
      { at: 0, join: 'A' }, { at: 10_000, join: 'B' }, { at: 20_000, join: 'C' },
      { at: 50_000, join: 'D' }, { at: 50_000, join: 'E' }, { at: 70_000, join: 'F' },
      { at: 80_000, leave: 'E' }, { at: 90_000, join: 'G' },
    ],
    50_000 + W + 5_000,
  )
  check('[10] first room A,B,C,D immediately at 50s', r.groups[0]?.at === 50_000 && humans(r.groups[0]) === 'A,B,C,D')
  check('[10] E starts a fresh table (180000ms)', r.seenOnJoin.E === W, `seen=${r.seenOnJoin.E}`)
  check('[10] F,G inherit E\'s deadline even after E left', r.seenOnJoin.F === W - 20_000 && r.seenOnJoin.G === W - 40_000, `F=${r.seenOnJoin.F} G=${r.seenOnJoin.G}`)
  check('[10] second room F,G + 2 bots at 50s+178s', r.groups.length === 2 && humans(r.groups[1]) === 'F,G' && bots(r.groups[1]) === 2 && r.groups[1]!.at === 50_000 + W - 2_000, `at=${r.groups[1]?.at}`)
  const matchedHumans = r.groups.flatMap((g) => g.group.matchedHumans.map((e) => e.entryId))
  check('[10] nobody matched twice', new Set(matchedHumans).size === matchedHumans.length)
  check('[10] every room has 4 distinct seats', r.groups.every((g) => g.group.seatAssignments.length === 4 && new Set(g.group.seatAssignments.map((s) => s.seat)).size === 4))
  check('[10] queue empty at the end', getSearchingEntriesByStake(r.state.queueEntries, STAKE).length === 0)
}

// [11] every waiting entry shares one expiresAt
{
  const r = run(
    [{ at: 0, join: 'A' }, { at: 60_000, join: 'B' }, { at: 90_000, leave: 'A' }, { at: 120_000, join: 'C' }],
    W + 5_000,
  )
  check('[11] all waiting entries have the same expiresAt at every step', r.expiresAtSnapshots.every((list) => new Set(list).size <= 1))
}

// [12] admin changes 180→120 while a table waits
{
  const r = run(
    [
      { at: 0, join: 'A' }, { at: 60_000, setWaitMs: 120_000 }, { at: 90_000, join: 'B' },
      { at: 200_000, join: 'C' },
    ],
    200_000 + 120_000 + 5_000,
    [{ at: 60_000, key: 'A@60' }],
  )
  check('[12] existing table: A still sees 120000ms right after the change', r.probes['A@60'] === 120_000, `seen=${r.probes['A@60']}`)
  check('[12] B joins the existing table → 90000ms left, ring duration 180000', r.seenOnJoin.B === 90_000 && r.durationOnJoin.B === W, `seen=${r.seenOnJoin.B} dur=${r.durationOnJoin.B}`)
  check('[12] existing table filled at t=178s (old deadline kept)', r.groups[0]?.at === W - 2_000 && humans(r.groups[0]) === 'A,B', `at=${r.groups[0]?.at}`)
  check('[12] next new table uses 120s (seen 120000, ring 120000)', r.seenOnJoin.C === 120_000 && r.durationOnJoin.C === 120_000, `seen=${r.seenOnJoin.C} dur=${r.durationOnJoin.C}`)
  check('[12] new table filled with 3 bots at 200s+119s', r.groups.length === 2 && bots(r.groups[1]) === 3 && r.groups[1]!.at === 200_000 + 120_000 - 1_000, `at=${r.groups[1]?.at}`)
}

// [13] admin change with an empty queue → next table 120s; bot-fill unchanged
{
  const one = run([{ at: 0, setWaitMs: 120_000 }, { at: 1_000, join: 'A' }], 130_000)
  check('[13] 1 human → 3 bots at 1s+119s', one.groups.length === 1 && bots(one.groups[0]) === 3 && one.groups[0]!.at === 1_000 + 119_000, `at=${one.groups[0]?.at}`)
  const three = run([{ at: 0, setWaitMs: 20_000 }, { at: 0, join: 'A' }, { at: 1_000, join: 'B' }, { at: 2_000, join: 'C' }], 30_000)
  check('[13] min 20s: 3 humans → 1 bot at t=17s', three.groups.length === 1 && bots(three.groups[0]) === 1 && three.groups[0]!.at === 17_000, `at=${three.groups[0]?.at}`)
  const max = run([{ at: 0, setWaitMs: 600_000 }, { at: 0, join: 'A' }], 605_000)
  check('[13] max 600s: room at t=599s', max.groups.length === 1 && max.groups[0]!.at === 599_000 && max.seenOnJoin.A === 600_000, `at=${max.groups[0]?.at}`)
}

Date.now = realDateNow
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
