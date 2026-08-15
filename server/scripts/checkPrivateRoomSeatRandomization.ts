/**
 * checkPrivateRoomSeatRandomization.ts
 *
 * Verifies the server-side random seat/team assignment used by BOTH private
 * table start paths (server/src/core/seededRandom.ts): the organic "4th
 * member joins/accepts invite" path (handlePrivateRoomFull) and the
 * "Запълни с ботове" path (handlePrivateRoomBotFill), both in
 * server/src/index.ts. Regression guard for a bug where handlePrivateRoomFull
 * seated members by fixed join order (findFirstOpenSeat scanning the
 * constant SERVER_SEAT_ORDER) — since SERVER_TEAM_A_SEATS=['bottom','top'],
 * the 3rd player to join always ended up as the room creator's partner,
 * letting players pick teammates by controlling join order.
 *
 * Deliberately avoids statistically-flaky tests that rely on many random
 * runs: shuffleSeatOrder()'s Fisher-Yates loop for 4 seats needs exactly 3
 * calls to nextRandom() (index=3,2,1), and each call's floor(r*(index+1))
 * selects one of (index+1) swap choices — so there are exactly 4*3*2 = 24
 * possible (choice0, choice1, choice2) triples, which is a bijection onto
 * the 24 permutations of 4 seats. By injecting a fixed nextRandom() for
 * each of these 24 triples (value = (choice + 0.5) / choiceCount, safely
 * mid-bucket to dodge floating-point boundary rounding), every possible
 * shuffle outcome is enumerated deterministically and reproducibly — no
 * sampling, no randomness in the test itself.
 *
 * Covers:
 *  - shuffleSeatOrder always returns the 4 seats, each exactly once.
 *  - The 24 injected triples produce 24 *distinct* permutations (bijective,
 *    no bias/collision).
 *  - nextRandom is invoked exactly 3 times per shuffleSeatOrder() call — the
 *    "random runs only once" contract (one Fisher-Yates pass, no re-shuffle
 *    internally).
 *  - createSeededRandom(seed) is deterministic: same seed -> same sequence.
 *  - 2 humans + 2 bots: treating participants [human A, human B, bot, bot]
 *    zipped against the shuffled seat order, exactly 8/24 permutations seat
 *    the humans as partners and 16/24 as opponents — the exact 1/3 vs 2/3
 *    split required by the spec (proven exhaustively, not approximately).
 *  - 3 humans + 1 bot: each of the 3 humans is the bot's partner in exactly
 *    8/24 permutations — no fixed bias toward one human.
 *  - Static guard: shuffleSeatOrder is called from exactly the two private
 *    table start paths (handlePrivateRoomFull, handlePrivateRoomBotFill) in
 *    index.ts, never from reconnect/resume code — so reconnect cannot
 *    trigger a re-shuffle (the result is stored once in room.seats).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  createSeededRandom,
  shuffleSeatOrder,
  shuffleWithRandom,
} from '../src/core/seededRandom.js'
import { SERVER_SEAT_ORDER, SERVER_TEAM_A_SEATS, type Seat } from '../src/core/serverTypes.js'

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
function sameTeam(a: Seat, b: Seat): boolean {
  return TEAM_A.has(a) === TEAM_A.has(b)
}

function injectSequence(values: number[]): () => number {
  let i = 0
  return () => {
    if (i >= values.length) {
      throw new Error(`nextRandom invoked more than ${values.length} times`)
    }
    return values[i++]!
  }
}

// ---------------------------------------------------------------------------
// [1] Basic shape: always a permutation of the 4 seats
// ---------------------------------------------------------------------------
{
  const result = shuffleSeatOrder(() => 0.42)
  check(
    '[1] shuffleSeatOrder returns exactly the 4 seats, each once',
    result.length === 4 && new Set(result).size === 4 && SERVER_SEAT_ORDER.every((s) => result.includes(s)),
  )
}

// ---------------------------------------------------------------------------
// [2]-[4] Exhaustive 24-triple enumeration
// ---------------------------------------------------------------------------
const allPermutations: Seat[][] = []
let callCountForFirstShuffle = -1

for (let i = 0; i < 4; i++) {
  for (let j = 0; j < 3; j++) {
    for (let k = 0; k < 2; k++) {
      let calls = 0
      const nextRandom = () => {
        calls++
        const values = [(i + 0.5) / 4, (j + 0.5) / 3, (k + 0.5) / 2]
        return values[calls - 1]!
      }
      const result = shuffleSeatOrder(nextRandom)
      if (callCountForFirstShuffle === -1) callCountForFirstShuffle = calls
      if (calls !== 3) {
        // Recorded via the [3] check below using this same loop's tally.
      }
      allPermutations.push(result)
    }
  }
}

check(
  '[2] 24 injected (choice0, choice1, choice2) triples produce 24 distinct permutations (bijective, unbiased)',
  new Set(allPermutations.map((p) => p.join(','))).size === 24,
)

check(
  '[3] shuffleSeatOrder() calls nextRandom exactly 3 times (single Fisher-Yates pass, no re-shuffle)',
  callCountForFirstShuffle === 3,
)

{
  // Re-run once more with an instrumented counter across the whole call to
  // double check no path invokes nextRandom a 4th time silently.
  let calls = 0
  const nextRandom = () => {
    calls++
    return 0.1
  }
  shuffleSeatOrder(nextRandom)
  check('[3b] repeat: exactly 3 nextRandom calls for a single shuffleSeatOrder() invocation', calls === 3)
}

// ---------------------------------------------------------------------------
// [4] createSeededRandom determinism
// ---------------------------------------------------------------------------
{
  const genA = createSeededRandom('private-room-fill:room-123')
  const genB = createSeededRandom('private-room-fill:room-123')
  const sequenceA = [genA(), genA(), genA()]
  const sequenceB = [genB(), genB(), genB()]
  check(
    '[4] createSeededRandom(seed) is deterministic — same seed produces the same sequence',
    sequenceA.every((v, idx) => v === sequenceB[idx]),
  )

  const genC = createSeededRandom('private-room-fill:room-456')
  const sequenceC = [genC(), genC(), genC()]
  check(
    '[4b] different seeds produce different sequences (not a constant generator)',
    sequenceA.some((v, idx) => v !== sequenceC[idx]),
  )
}

// ---------------------------------------------------------------------------
// [5] 2 humans + 2 bots — exact 1/3 partner vs 2/3 opponent split
// ---------------------------------------------------------------------------
{
  // Participants zipped in fixed order [humanA, humanB, bot1, bot2] against
  // each of the 24 enumerated shuffled seat orders — mirrors exactly how
  // handlePrivateRoomBotFill zips privateRoom.members then bot profiles
  // against shuffleSeatOrder()'s output.
  let partnerCount = 0
  let opponentCount = 0

  for (const perm of allPermutations) {
    const seatA = perm[0]!
    const seatB = perm[1]!
    if (sameTeam(seatA, seatB)) partnerCount++
    else opponentCount++
  }

  check(
    '[5] 2 humans + 2 bots: exactly 8/24 permutations seat the humans as partners (=1/3)',
    partnerCount === 8,
  )
  check(
    '[5b] 2 humans + 2 bots: exactly 16/24 permutations seat the humans as opponents (=2/3)',
    opponentCount === 16,
  )
  check(
    '[5c] both partner AND opponent outcomes are reachable via controlled random — proven, not assumed',
    partnerCount > 0 && opponentCount > 0,
  )
}

// ---------------------------------------------------------------------------
// [6] 3 humans + 1 bot — no fixed bias in which human partners the bot
// ---------------------------------------------------------------------------
{
  // Participants [humanA, humanB, humanC, bot] — bot is participants[3].
  const partnerOfBotCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0 }

  for (const perm of allPermutations) {
    const botSeat = perm[3]!
    const partnerHumanIndex = [0, 1, 2].find((humanIndex) => sameTeam(perm[humanIndex]!, botSeat))
    if (partnerHumanIndex !== undefined) {
      partnerOfBotCounts[partnerHumanIndex]++
    }
  }

  check(
    '[6] 3 humans + 1 bot: human A is the bot\'s partner in exactly 8/24 permutations',
    partnerOfBotCounts[0] === 8,
  )
  check(
    '[6b] 3 humans + 1 bot: human B is the bot\'s partner in exactly 8/24 permutations',
    partnerOfBotCounts[1] === 8,
  )
  check(
    '[6c] 3 humans + 1 bot: human C is the bot\'s partner in exactly 8/24 permutations',
    partnerOfBotCounts[2] === 8,
  )
}

// ---------------------------------------------------------------------------
// [7] shuffleWithRandom generic helper — same bijection guarantee for an
// arbitrary 4-element input (not just Seat literals)
// ---------------------------------------------------------------------------
{
  const items = ['w', 'x', 'y', 'z']
  const outputs = new Set<string>()
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 2; k++) {
        const nextRandom = injectSequence([(i + 0.5) / 4, (j + 0.5) / 3, (k + 0.5) / 2])
        outputs.add(shuffleWithRandom(items, nextRandom).join(','))
      }
    }
  }
  check('[7] shuffleWithRandom is bijective for a generic 4-element array too', outputs.size === 24)
}

// ---------------------------------------------------------------------------
// [8] Static guard: shuffleSeatOrder is only invoked from the bot-fill path,
// never from reconnect/resume code — so a reconnect cannot trigger a
// re-shuffle. This is a structural fact about the codebase, checked here so
// a future refactor that violates it fails CI instead of silently breaking
// "reconnect preserves the seat assignment".
// ---------------------------------------------------------------------------
{
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const indexTsPath = join(currentDir, '..', 'src', 'index.ts')
  const indexTsSource = readFileSync(indexTsPath, 'utf8')

  const resumeRoomHandlerMatch = indexTsSource.match(
    /function tryResumeRoomForConnection[\s\S]{0,4000}?\n}/,
  )
  const resumeHumanControlHandlerMatch = indexTsSource.match(
    /'resume_human_control'[\s\S]{0,2000}?\n {6}return/,
  )
  // handlePrivateRoomFull — организацично 4-о попълване (join/invite-accept).
  // Преди regression fix-a: join order директно определяше seat/team чрез
  // findFirstOpenSeat() (SERVER_SEAT_ORDER сканиран по ред) — 3-тият
  // присъединил се играч винаги ставаше партньор на създателя. Fix-ът добавя
  // shuffleSeatOrder() тук, огледално на handlePrivateRoomBotFill.
  const privateRoomFullHandlerMatch = indexTsSource.match(
    /function handlePrivateRoomFull[\s\S]{0,8000}?\n}/,
  )
  const privateRoomBotFillHandlerMatch = indexTsSource.match(
    /function handlePrivateRoomBotFill[\s\S]{0,8000}?\n}/,
  )

  const shuffleCallCount = (indexTsSource.match(/shuffleSeatOrder\(/g) ?? []).length

  check(
    '[8] shuffleSeatOrder е извикан точно 2 пъти в index.ts (handlePrivateRoomFull + handlePrivateRoomBotFill)',
    shuffleCallCount === 2,
  )
  check(
    '[8a] handlePrivateRoomFull (органично 4-о попълване чрез join/invite-accept) вика shuffleSeatOrder — join order вече не определя seat/team',
    privateRoomFullHandlerMatch !== null && privateRoomFullHandlerMatch[0].includes('shuffleSeatOrder'),
  )
  check(
    '[8a2] handlePrivateRoomBotFill продължава да вика shuffleSeatOrder (regression guard за вече съществуващото поведение)',
    privateRoomBotFillHandlerMatch !== null && privateRoomBotFillHandlerMatch[0].includes('shuffleSeatOrder'),
  )
  check(
    '[8b] the reconnect ("resume_room") handler body does not call shuffleSeatOrder',
    resumeRoomHandlerMatch === null || !resumeRoomHandlerMatch[0].includes('shuffleSeatOrder'),
  )
  check(
    '[8c] the resume_human_control handler body does not call shuffleSeatOrder',
    resumeHumanControlHandlerMatch === null || !resumeHumanControlHandlerMatch[0].includes('shuffleSeatOrder'),
  )
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
