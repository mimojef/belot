/**
 * checkPrivateRoomDeterministicSeatMapping.ts
 *
 * Replaces checkPrivateRoomSeatRandomization.ts — the random seat/team
 * shuffle it tested (server/src/core/seededRandom.ts's shuffleSeatOrder(),
 * called from the old handlePrivateRoomFull/handlePrivateRoomBotFill) has
 * been removed from the private-room path entirely. Players now choose an
 * explicit (team, slotIndex) via "+", so seat assignment must be a pure,
 * deterministic function of that choice — never randomized.
 *
 * Covers:
 *  - mapPrivateRoomSlotToSeat is exhaustively correct for all 4 (team,
 *    slotIndex) inputs: A0→bottom, A1→top, B0→right, B1→left.
 *  - Partner pairing: both Team A slots map to the SERVER_TEAM_A_SEATS pair
 *    (bottom/top), both Team B slots map to SERVER_TEAM_B_SEATS (right/left)
 *    — reusing the existing gameplay seat contract, not reinventing it.
 *  - Static guard: shuffleSeatOrder/seededRandom.ts are no longer imported
 *    by index.ts or privateRoomsStore.ts — a future regression that
 *    reintroduces random seat assignment fails this check instead of
 *    silently breaking "player chooses their own seat".
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mapPrivateRoomSlotToSeat } from '../src/game/mapPrivateRoomSlotToSeat.js'
import { SERVER_TEAM_A_SEATS, SERVER_TEAM_B_SEATS } from '../src/core/serverTypes.js'

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

// ---------------------------------------------------------------------------
// [1] Exhaustive, deterministic mapping for all 4 (team, slotIndex) inputs.
// ---------------------------------------------------------------------------
check('[1] A,0 -> bottom', mapPrivateRoomSlotToSeat('A', 0) === 'bottom')
check('[1b] A,1 -> top', mapPrivateRoomSlotToSeat('A', 1) === 'top')
check('[1c] B,0 -> right', mapPrivateRoomSlotToSeat('B', 0) === 'right')
check('[1d] B,1 -> left', mapPrivateRoomSlotToSeat('B', 1) === 'left')

// ---------------------------------------------------------------------------
// [2] Repeated calls with the same input always yield the same output — pure
// function, no hidden state/randomness.
// ---------------------------------------------------------------------------
{
  const results = new Set<string>()
  for (let i = 0; i < 50; i++) {
    results.add(mapPrivateRoomSlotToSeat('A', 0))
  }
  check('[2] repeated calls are deterministic (no drift across calls)', results.size === 1 && results.has('bottom'))
}

// ---------------------------------------------------------------------------
// [3] Partner pairing reuses SERVER_TEAM_A_SEATS/SERVER_TEAM_B_SEATS — never
// a locally-reinvented seat pair.
// ---------------------------------------------------------------------------
{
  const teamASeats = [mapPrivateRoomSlotToSeat('A', 0), mapPrivateRoomSlotToSeat('A', 1)].sort()
  const teamBSeats = [mapPrivateRoomSlotToSeat('B', 0), mapPrivateRoomSlotToSeat('B', 1)].sort()
  check(
    '[3] Team A slots map exactly onto SERVER_TEAM_A_SEATS',
    JSON.stringify(teamASeats) === JSON.stringify([...SERVER_TEAM_A_SEATS].sort()),
  )
  check(
    '[3b] Team B slots map exactly onto SERVER_TEAM_B_SEATS',
    JSON.stringify(teamBSeats) === JSON.stringify([...SERVER_TEAM_B_SEATS].sort()),
  )
}

// ---------------------------------------------------------------------------
// [4] Static guard: no random shuffle anywhere in the private-room path.
// ---------------------------------------------------------------------------
{
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const indexTsPath = join(currentDir, '..', 'src', 'index.ts')
  const indexTsSource = readFileSync(indexTsPath, 'utf8')

  const privateRoomsStoreTsPath = join(currentDir, '..', 'src', 'game', 'privateRoomsStore.ts')
  const privateRoomsStoreSource = readFileSync(privateRoomsStoreTsPath, 'utf8')

  // Checks the structural import, not bare mentions of the old function
  // name — index.ts's handlePrivateRoomReady doc comment legitimately
  // explains *why* shuffleSeatOrder is gone, which would false-positive a
  // naive substring-anywhere check.
  check(
    '[4] index.ts no longer imports seededRandom.ts',
    !/from ['"]\.\/core\/seededRandom\.js['"]/.test(indexTsSource),
  )
  check(
    '[4b] index.ts never calls shuffleSeatOrder(',
    !indexTsSource.includes('shuffleSeatOrder('),
  )
  check(
    '[4c] privateRoomsStore.ts does not import seededRandom.ts either',
    !/from ['"].*seededRandom\.js['"]/.test(privateRoomsStoreSource),
  )
  check(
    '[4c] index.ts uses mapPrivateRoomSlotToSeat for private-room seat assignment',
    indexTsSource.includes('mapPrivateRoomSlotToSeat'),
  )
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
