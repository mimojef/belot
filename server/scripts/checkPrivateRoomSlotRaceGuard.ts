/**
 * checkPrivateRoomSlotRaceGuard.ts
 *
 * privateRoomsStore.ts's mutating methods are synchronous end-to-end (no
 * `await` between reading current state and writing the mutation — see the
 * "Atomicity" section of the private-room team/seat plan). Node's single-
 * threaded event loop therefore serializes any two WS messages that would
 * otherwise race: whichever call happens to execute first (in send order)
 * always wins cleanly, and the second sees fresh, already-mutated state.
 * These tests simulate that ordering directly (back-to-back synchronous
 * calls) for the specific (team, slotIndex) claims the spec calls out.
 *
 * Covers:
 *  - Two joinTeam calls for the exact same (team, slotIndex) -> exactly one
 *    wins, the second sees 'private_room_slot_taken'.
 *  - joinTeam(A,0) and joinTeam(A,1) in an empty team -> both succeed,
 *    distinct occupants, no conflict (different slots are independent).
 *  - joinTeam(team, slotIndex) vs addBotToTeam(team) both targeting the same
 *    physically free slot -> exactly one wins; never 3 occupants, an
 *    overwritten human, or a duplicate seat.
 *  - A leave racing right against the action that would complete the room
 *    to 4/4 -> no double-start, no room left with a missing/corrupt seat.
 */

import { createPrivateRoomsStore, type PrivateRoomBotOccupant } from '../src/game/privateRoomsStore.js'

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

function createTrackedStore() {
  const events: string[] = []
  const store = createPrivateRoomsStore({
    onRoomsChanged: () => events.push('roomsChanged'),
    onRoomReady: () => events.push('roomReady'),
    onRoomExpired: () => events.push('roomExpired'),
    onRoomClosed: () => events.push('roomClosed'),
    onMemberLeft: () => events.push('memberLeft'),
  })
  return { store, events }
}

function makeHuman(id: string) {
  return {
    connectionId: `conn-${id}`,
    profileId: `profile-${id}`,
    displayName: `Player ${id}`,
    avatarUrl: null,
    level: 5,
    rankTitle: null,
  }
}

function makeBotOccupant(id: string): PrivateRoomBotOccupant {
  return {
    kind: 'bot',
    botProfileId: `bot-${id}`,
    botCode: 'CATALOG_BOT',
    difficulty: 'normal',
    identity: {
      accountId: null,
      profileId: `bot-${id}`,
      username: null,
      displayName: `Bot ${id}`,
      avatarUrl: null,
      level: 7,
      rankTitle: 'Новак',
      skillRating: 1000,
      gender: null,
    },
  }
}

const noBlocks = () => false

function createOpenRoom(store: ReturnType<typeof createPrivateRoomsStore>, hostId = 'host') {
  const created = store.createRoom({ ...makeHuman(hostId), stake: 1000, isLocked: false, waitMinutes: 15 })
  if (!created.ok) throw new Error('setup failed')
  return created.room
}

// ---------------------------------------------------------------------------
// [1] Two simultaneous joins for the exact same (team, slotIndex).
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)

  const first = store.joinTeam({ privateRoomId: room.id, ...makeHuman('ivan'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  const second = store.joinTeam({ privateRoomId: room.id, ...makeHuman('milen'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })

  check('[1] first claim on B,0 wins', first.ok)
  check('[1b] second claim on the SAME slot loses cleanly', !second.ok)
  check('[1c] loser gets private_room_slot_taken', !second.ok && second.code === 'private_room_slot_taken')

  const finalRoom = store.getRoomByConnectionId('conn-ivan')
  const slotB0 = finalRoom!.slots.find((s) => s.team === 'B' && s.slotIndex === 0)!
  check('[1d] the winner (ivan) occupies B,0 — no overwrite by the loser', slotB0.occupant?.kind === 'human' && slotB0.occupant.profileId === 'profile-ivan')
}

// ---------------------------------------------------------------------------
// [2] Two DIFFERENT slots in the same empty team -> both succeed, no
// conflict.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)

  const first = store.joinTeam({ privateRoomId: room.id, ...makeHuman('a'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  const second = store.joinTeam({ privateRoomId: room.id, ...makeHuman('b'), team: 'B', slotIndex: 1, isBlockedWith: noBlocks })

  check('[2] B,0 claim succeeds', first.ok)
  check('[2b] B,1 claim succeeds independently', second.ok)
  if (first.ok && second.ok) {
    const slotB0 = second.room.slots.find((s) => s.team === 'B' && s.slotIndex === 0)!
    const slotB1 = second.room.slots.find((s) => s.team === 'B' && s.slotIndex === 1)!
    check('[2c] both distinct occupants land where claimed', slotB0.occupant?.kind === 'human' && slotB0.occupant.profileId === 'profile-a' && slotB1.occupant?.kind === 'human' && slotB1.occupant.profileId === 'profile-b')
  }
}

// ---------------------------------------------------------------------------
// [3] Human join vs bot-add racing for the exact SAME physically free slot
// (Team A's only empty slot, A1, with the host already at A0).
// ---------------------------------------------------------------------------
{
  // 3a) Human wins (join processed first, before the competing bot-add).
  {
    const { store } = createTrackedStore()
    const room = createOpenRoom(store)

    const humanJoin = store.joinTeam({ privateRoomId: room.id, ...makeHuman('ivan'), team: 'A', slotIndex: 1, isBlockedWith: noBlocks })
    check('[3a] human join to A,1 wins first', humanJoin.ok)

    const botAdd = store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBotOccupant('race'), isBlockedWith: noBlocks })
    check('[3a-2] a competing bot-add for the same now-human-occupied slot fails (team full)', !botAdd.ok)
    check('[3a-3] no 3rd occupant materialized — room stays at 2 total', humanJoin.ok && humanJoin.room.slots.filter((s) => s.occupant !== null).length === 2)
  }

  // 3b) Bot wins (bot-add processed first, before the competing human join).
  {
    const { store } = createTrackedStore()
    const room = createOpenRoom(store)

    const botAdd = store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBotOccupant('winner'), isBlockedWith: noBlocks })
    check('[3b] bot-add to A\'s free slot (A,1) wins first', botAdd.ok)

    const lateHumanJoin = store.joinTeam({ privateRoomId: room.id, ...makeHuman('dave'), team: 'A', slotIndex: 1, isBlockedWith: noBlocks })
    check('[3b-2] a competing human join to the now-bot-occupied slot fails cleanly', !lateHumanJoin.ok)
    check('[3b-3] loser sees private_room_slot_taken, not a crash', !lateHumanJoin.ok && lateHumanJoin.code === 'private_room_slot_taken')
  }
}

// ---------------------------------------------------------------------------
// [4] Leave racing right against room completion: the leave message for a
// human arrives right after their room already transitioned to
// readyToStart (detached from the store, handed off to game-start). This
// must be a safe no-op — never a ghost room, never a mutation on a room
// that's already gameplay-bound.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('a1'), team: 'A', slotIndex: 1, isBlockedWith: noBlocks })
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('b0'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })

  events.length = 0
  const completingJoin = store.joinTeam({ privateRoomId: room.id, ...makeHuman('b1'), team: 'B', slotIndex: 1, isBlockedWith: noBlocks })
  check('[4] the 4th join completes the room and starts it', completingJoin.ok && completingJoin.readyToStart === true)
  check('[4b] roomReady fired exactly once', events.filter((e) => e === 'roomReady').length === 1)
  check('[4c] room detached — no longer listed', store.listRooms().length === 0)

  // A leave message for one of the now-seated humans, arriving right after
  // completion (simulating the in-flight race), must be a safe no-op.
  events.length = 0
  store.leaveRoom('conn-b0')
  check('[4d] late leave on an already-started room is a silent no-op', events.length === 0)
  check('[4e] listRooms still empty — no ghost room resurrected', store.listRooms().length === 0)
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
