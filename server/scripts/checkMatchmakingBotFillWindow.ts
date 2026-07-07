/**
 * checkMatchmakingBotFillWindow.ts
 *
 * Verifies staged bot-fill behaviour in getReadyEntriesForStake:
 * - bot-fill window opens at t=17s (MATCHMAKING_WAIT_MS - MATCHMAKING_BOT_FILL_WINDOW_MS)
 * - one bot is unlocked per MATCHMAKING_BOT_FILL_RATE_MS (1s) elapsed since window opened
 * - room is created only when humans + allowedBots === 4 (full table)
 * - a real human joining between steps reduces the bot count needed
 *
 * [1]  1 human, t=1s  → not ready
 * [2]  2 humans, t=1s → not ready (production bug: was incorrectly ready at t=20s)
 * [3]  2 humans, t=16.999s → not ready (just before bot-fill window)
 * [4]  2 humans, t=17.001s → NOT ready yet: allowedBots=1 but 2+1=3 < 4
 * [5]  2 humans, t=18.001s → ready: allowedBots=2, 2+2=4
 * [6]  2 humans, t=20.5s (expired) → ready, allowedBots capped at 2
 * [7]  4 humans, t=1s → ready immediately, shouldStartImmediately=true, maxBots=0
 * [8]  3 humans, t=17.001s → ready: allowedBots=1, 3+1=4
 * [9]  3 humans, t=16.999s → not ready (before window)
 * [10] 1 human, t=19.001s → ready: allowedBots=3, 1+3=4
 * [11] 1 human, t=17.001s → not ready: allowedBots=1, 1+1=2 < 4
 * [12] 1 human, t=18.001s → not ready: allowedBots=2, 1+2=3 < 4
 * [13] real human joins between steps: 2→3 humans at t=17.5s → need only 1 more bot → not ready (1+3=still 3+1=4 at t=17.5s? Let's check)
 * [14] production case: 2 humans at t=1s → NOT ready
 * [15] constants sanity: WAIT=20000, WINDOW=3000, RATE=1000 → window opens at 17000ms
 */

import { getReadyEntriesForStake } from '../src/matchmaking/getReadyEntriesForStake.js'
import {
  MATCHMAKING_WAIT_MS,
  MATCHMAKING_BOT_FILL_WINDOW_MS,
  MATCHMAKING_BOT_FILL_RATE_MS,
} from '../src/matchmaking/matchmakingTypes.js'
import type { MatchmakingQueueEntry } from '../src/matchmaking/matchmakingTypes.js'

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

const STAKE = 5000
const BOT_FILL_START = MATCHMAKING_WAIT_MS - MATCHMAKING_BOT_FILL_WINDOW_MS // 17000

function makeEntry(id: string, joinedAtOffset: number, baseNow: number): MatchmakingQueueEntry {
  const joinedAt = baseNow + joinedAtOffset
  return {
    entryId: id,
    connectionId: `conn-${id}`,
    playerId: `player-${id}`,
    profileId: `profile-${id}`,
    displayName: `Player ${id}`,
    publicProfile: null,
    stake: STAKE,
    stakePaid: false,
    joinedAt,
    expiresAt: joinedAt + MATCHMAKING_WAIT_MS,
    status: 'searching',
  }
}

const BASE = 1_700_000_000_000

// [1] 1 human at t=1s → not ready
{
  const now = BASE + 1_000
  const r = getReadyEntriesForStake([makeEntry('A', 0, BASE)], STAKE, now)
  check('[1] 1 human at t=1s → not ready', r.entries.length === 0)
}

// [2] 2 humans at t=1s → not ready (production bug)
{
  const now = BASE + 1_000
  const r = getReadyEntriesForStake([
    makeEntry('A', 0, BASE),
    makeEntry('B', 1_000, BASE),
  ], STAKE, now)
  check('[2] 2 humans at t=1s → not ready (production bug fix)', r.entries.length === 0)
}

// [3] 2 humans at t=16.999s → not ready
{
  const now = BASE + BOT_FILL_START - 1
  const r = getReadyEntriesForStake([
    makeEntry('A', 0, BASE),
    makeEntry('B', 1_000, BASE),
  ], STAKE, now)
  check('[3] 2 humans at t=16.999s → not ready (before window)', r.entries.length === 0)
}

// [4] 2 humans at t=17.001s → NOT ready yet (allowedBots=1, but 2+1=3 < 4)
{
  const now = BASE + BOT_FILL_START + 1
  const r = getReadyEntriesForStake([
    makeEntry('A', 0, BASE),
    makeEntry('B', 1_000, BASE),
  ], STAKE, now)
  check('[4] 2 humans at t=17.001s → not ready (1 bot allowed, need 2 more → table not full)', r.entries.length === 0)
}

// [5] 2 humans at t=18.001s → ready (allowedBots=2, 2+2=4)
{
  const now = BASE + BOT_FILL_START + MATCHMAKING_BOT_FILL_RATE_MS + 1
  const r = getReadyEntriesForStake([
    makeEntry('A', 0, BASE),
    makeEntry('B', 1_000, BASE),
  ], STAKE, now)
  check('[5] 2 humans at t=18.001s → ready (allowedBots=2, 2+2=4)', r.entries.length === 2)
  check('[5] maxBots=2', r.maxBots === 2)
  check('[5] shouldStartImmediately=false', r.shouldStartImmediately === false)
}

// [6] 2 humans at t=20.5s (past expiry) → ready, allowedBots capped at 2 (open seats)
{
  const now = BASE + 20_500
  const r = getReadyEntriesForStake([
    makeEntry('A', 0, BASE),
    makeEntry('B', 1_000, BASE),
  ], STAKE, now)
  check('[6] 2 humans at t=20.5s → ready', r.entries.length === 2)
  check('[6] maxBots capped at 2 (open seats)', r.maxBots === 2)
}

// [7] 4 humans at t=1s → ready immediately, maxBots=0
{
  const now = BASE + 1_000
  const r = getReadyEntriesForStake([
    makeEntry('A', 0, BASE), makeEntry('B', 200, BASE),
    makeEntry('C', 400, BASE), makeEntry('D', 600, BASE),
  ], STAKE, now)
  check('[7] 4 humans at t=1s → ready immediately', r.entries.length === 4)
  check('[7] shouldStartImmediately=true', r.shouldStartImmediately === true)
  check('[7] maxBots=0', r.maxBots === 0)
}

// [8] 3 humans at t=17.001s → ready (allowedBots=1, 3+1=4)
{
  const now = BASE + BOT_FILL_START + 1
  const r = getReadyEntriesForStake([
    makeEntry('A', 0, BASE),
    makeEntry('B', 1_000, BASE),
    makeEntry('C', 2_000, BASE),
  ], STAKE, now)
  check('[8] 3 humans at t=17.001s → ready (3+1=4)', r.entries.length === 3)
  check('[8] maxBots=1', r.maxBots === 1)
}

// [9] 3 humans at t=16.999s → not ready (before window)
{
  const now = BASE + BOT_FILL_START - 1
  const r = getReadyEntriesForStake([
    makeEntry('A', 0, BASE),
    makeEntry('B', 1_000, BASE),
    makeEntry('C', 2_000, BASE),
  ], STAKE, now)
  check('[9] 3 humans at t=16.999s → not ready (before window)', r.entries.length === 0)
}

// [10] 1 human at t=19.001s → ready (allowedBots=3, 1+3=4)
{
  const now = BASE + BOT_FILL_START + 2 * MATCHMAKING_BOT_FILL_RATE_MS + 1
  const r = getReadyEntriesForStake([makeEntry('A', 0, BASE)], STAKE, now)
  check('[10] 1 human at t=19.001s → ready (1+3=4)', r.entries.length === 1)
  check('[10] maxBots=3', r.maxBots === 3)
}

// [11] 1 human at t=17.001s → not ready (allowedBots=1, 1+1=2 < 4)
{
  const now = BASE + BOT_FILL_START + 1
  const r = getReadyEntriesForStake([makeEntry('A', 0, BASE)], STAKE, now)
  check('[11] 1 human at t=17.001s → not ready (1+1=2 < 4)', r.entries.length === 0)
}

// [12] 1 human at t=18.001s → not ready (allowedBots=2, 1+2=3 < 4)
{
  const now = BASE + BOT_FILL_START + MATCHMAKING_BOT_FILL_RATE_MS + 1
  const r = getReadyEntriesForStake([makeEntry('A', 0, BASE)], STAKE, now)
  check('[12] 1 human at t=18.001s → not ready (1+2=3 < 4)', r.entries.length === 0)
}

// [13] 3 humans at t=17.5s → ready (allowedBots=1, 3+1=4): real human joins between steps
{
  const now = BASE + BOT_FILL_START + 500 // t=17.5s — still first 1s step
  const r = getReadyEntriesForStake([
    makeEntry('A', 0, BASE),
    makeEntry('B', 1_000, BASE),
    makeEntry('C', 17_000, BASE), // joined at t=17s (inside window)
  ], STAKE, now)
  check('[13] 3rd human joins at t=17s → ready at t=17.5s with maxBots=1 (only 1 bot needed)', r.entries.length === 3)
  check('[13] maxBots=1', r.maxBots === 1)
}

// [14] production case: Marta33 t=0, Human2 t=1s, checked at t=1s → not ready
{
  const now = BASE + 1_000
  const r = getReadyEntriesForStake([
    makeEntry('marta33', 0, BASE),
    makeEntry('human2', 1_000, BASE),
  ], STAKE, now)
  check('[14] production case: 2 humans at t=1s → not ready', r.entries.length === 0)
}

// [15] constants sanity
check(
  `[15] WAIT=${MATCHMAKING_WAIT_MS} WINDOW=${MATCHMAKING_BOT_FILL_WINDOW_MS} RATE=${MATCHMAKING_BOT_FILL_RATE_MS} → window at ${BOT_FILL_START}ms`,
  MATCHMAKING_WAIT_MS === 20_000 &&
  MATCHMAKING_BOT_FILL_WINDOW_MS === 3_000 &&
  MATCHMAKING_BOT_FILL_RATE_MS === 1_000 &&
  BOT_FILL_START === 17_000,
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
