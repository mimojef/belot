/**
 * checkPrivateRoomReconnectSlotRebinding.ts
 *
 * Unit tests for privateRoomsStore.ts's reconnectMember() under the new
 * team/slot model. A reconnecting human keeps their exact (team, slotIndex)
 * — only occupant.connectionId is rewritten in place; nothing about their
 * seat identity moves. Also proves the stale-connectionId cleanup ordering:
 * removeConnection() for the OLD connectionId, arriving after reconnect has
 * already rebound the slot to the new one, must be a harmless no-op — never
 * freeing the just-reconnected occupant's seat.
 *
 * Covers:
 *  - reconnectMember preserves team/slotIndex; only connectionId changes.
 *  - A delayed removeConnection(oldConnectionId) call after reconnect does
 *    NOT free the seat.
 *  - addBotToTeam/removeBotFromTeam work immediately after reconnect,
 *    addressed via the NEW connectionId.
 *  - leaveRoom works immediately after reconnect, addressed via the NEW
 *    connectionId.
 *  - Reconnecting the HOST also updates hostConnectionId to the new id.
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
  const store = createPrivateRoomsStore({
    onRoomsChanged: () => {},
    onRoomReady: () => {},
    onRoomExpired: () => {},
    onRoomClosed: () => {},
    onMemberLeft: () => {},
  })
  return { store }
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
// [1] Reconnect preserves team/slotIndex, only connectionId changes.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('guest'), team: 'B', slotIndex: 1, isBlockedWith: noBlocks })

  const reconnected = store.reconnectMember('conn-guest-new', 'profile-guest')
  check('[1] reconnectMember finds and rebinds the room', reconnected !== null)
  if (reconnected !== null) {
    const slotB1 = reconnected.slots.find((s) => s.team === 'B' && s.slotIndex === 1)!
    check('[1b] slot is still B,1 (unchanged)', slotB1.occupant?.kind === 'human')
    check('[1c] connectionId rebound to the new connection', slotB1.occupant?.kind === 'human' && slotB1.occupant.connectionId === 'conn-guest-new')
    check('[1d] profileId unchanged', slotB1.occupant?.kind === 'human' && slotB1.occupant.profileId === 'profile-guest')
  }
}

// ---------------------------------------------------------------------------
// [2] Delayed removeConnection(oldConnectionId) after reconnect is a no-op —
// does not free the reconnected occupant's seat.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('guest'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })

  store.reconnectMember('conn-guest-new', 'profile-guest')
  // Simulate the stale WS 'close' event for the OLD connectionId arriving
  // late, after reconnect already rebound the slot to the new connectionId.
  store.removeConnection('conn-guest')

  const roomAfter = store.getRoomByConnectionId('conn-guest-new')
  check('[2] the reconnected occupant is still resolvable by their NEW connectionId', roomAfter !== null)
  if (roomAfter !== null) {
    const slotB0 = roomAfter.slots.find((s) => s.team === 'B' && s.slotIndex === 0)!
    check('[2b] seat was NOT freed by the stale old-connectionId cleanup', slotB0.occupant?.kind === 'human')
  }
}

// ---------------------------------------------------------------------------
// [3] addBotToTeam/removeBotFromTeam work immediately after reconnect, via
// the NEW connectionId.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  store.reconnectMember('conn-host-new', 'profile-host')

  const addResult = store.addBotToTeam({ connectionId: 'conn-host-new', team: 'A', botOccupant: makeBotOccupant('1'), isBlockedWith: noBlocks })
  check('[3] addBotToTeam works via the new connectionId right after reconnect', addResult.ok)

  const removeResult = store.removeBotFromTeam({ connectionId: 'conn-host-new', team: 'A' })
  check('[3b] removeBotFromTeam works via the new connectionId too', removeResult.ok)

  const staleAttempt = store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBotOccupant('2'), isBlockedWith: noBlocks })
  check('[3c] the OLD (stale) connectionId no longer works at all', !staleAttempt.ok)
}

// ---------------------------------------------------------------------------
// [4] leaveRoom works immediately after reconnect, via the NEW connectionId.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('guest'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  store.reconnectMember('conn-guest-new', 'profile-guest')

  store.leaveRoom('conn-guest-new')
  const roomAfter = store.getRoomByConnectionId('conn-host')
  check('[4] leave via the new connectionId succeeds', roomAfter !== null)
  if (roomAfter !== null) {
    const slotB0 = roomAfter.slots.find((s) => s.team === 'B' && s.slotIndex === 0)!
    check('[4b] the vacated slot is now free', slotB0.occupant === null)
  }
}

// ---------------------------------------------------------------------------
// [5] Reconnecting the HOST updates hostConnectionId to the new id.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('guest'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })

  const reconnected = store.reconnectMember('conn-host-new', 'profile-host')
  check('[5] host reconnect updates hostConnectionId', reconnected !== null && reconnected.hostConnectionId === 'conn-host-new')
  check('[5b] hostProfileId is unchanged', reconnected !== null && reconnected.hostProfileId === 'profile-host')
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
