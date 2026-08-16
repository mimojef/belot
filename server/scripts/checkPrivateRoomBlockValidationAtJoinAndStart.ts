/**
 * checkPrivateRoomBlockValidationAtJoinAndStart.ts
 *
 * End-to-end (store-level) tests for block-relationship validation across
 * the two moments it matters: at joinTeam() time (a player tries to seat
 * themselves next to someone who blocked them / whom they blocked) and at
 * final room-completion time (evaluateRoomReadiness, in case a block
 * relationship appears AFTER two partners already joined). Mirrors
 * checkMatchmakingBlockedPartnership.ts's style, but exercises the new
 * private-room team-choice path instead of matchmaking's seat resolver.
 *
 * Covers:
 *  - Joining a team where the OTHER slot holds a human who blocked you (or
 *    whom you blocked) is rejected with 'private_room_partner_blocked'.
 *  - The block check is symmetric: either direction of block rejects.
 *  - A block between OPPONENTS (different teams) does not affect anything —
 *    joining the opposing team succeeds normally.
 *  - After being rejected from one team due to a partner block, the same
 *    player can freely join the OTHER team.
 *  - Late block: two partners join fine (no block existed yet), a block
 *    appears afterward, and the room is prevented from starting when the
 *    4th slot completes it — without kicking anyone.
 */

import { createPrivateRoomsStore } from '../src/game/privateRoomsStore.js'

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

function createOpenRoom(store: ReturnType<typeof createPrivateRoomsStore>, hostId = 'host') {
  const created = store.createRoom({ ...makeHuman(hostId), stake: 1000, isLocked: false, waitMinutes: 15 })
  if (!created.ok) throw new Error('setup failed')
  return created.room
}

// Blocks host <-> troll, directional (host blocked troll).
const hostBlockedTroll = (a: string, b: string) => a === 'profile-host' && b === 'profile-troll'

// ---------------------------------------------------------------------------
// [1] Joining the blocked partner's team is rejected.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)

  const result = store.joinTeam({
    privateRoomId: room.id,
    ...makeHuman('troll'),
    team: 'A', // same team as host -> would become partners
    slotIndex: 1,
    isBlockedWith: hostBlockedTroll,
  })

  check('[1] joining as blocked partner is rejected', !result.ok)
  check('[1b] error code is private_room_partner_blocked', !result.ok && result.code === 'private_room_partner_blocked')
}

// ---------------------------------------------------------------------------
// [2] Symmetric: the OTHER direction of block also rejects.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  const trollBlockedHost = (a: string, b: string) => a === 'profile-troll' && b === 'profile-host'

  const result = store.joinTeam({
    privateRoomId: room.id,
    ...makeHuman('troll'),
    team: 'A',
    slotIndex: 1,
    isBlockedWith: trollBlockedHost,
  })

  check('[2] the reverse block direction also rejects', !result.ok)
}

// ---------------------------------------------------------------------------
// [3] Opponent block (different teams) does not matter.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)

  const result = store.joinTeam({
    privateRoomId: room.id,
    ...makeHuman('troll'),
    team: 'B', // opposing team -> opponents, not partners
    slotIndex: 0,
    isBlockedWith: hostBlockedTroll,
  })

  check('[3] joining as an OPPONENT despite a block succeeds', result.ok)
}

// ---------------------------------------------------------------------------
// [4] Rejected from one team -> free to join the other team.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)

  const rejected = store.joinTeam({ privateRoomId: room.id, ...makeHuman('troll'), team: 'A', slotIndex: 1, isBlockedWith: hostBlockedTroll })
  check('[4] rejected from Team A (partner block)', !rejected.ok)

  const accepted = store.joinTeam({ privateRoomId: room.id, ...makeHuman('troll'), team: 'B', slotIndex: 0, isBlockedWith: hostBlockedTroll })
  check('[4b] same player freely joins Team B instead', accepted.ok)
}

// ---------------------------------------------------------------------------
// [5] Late block: partners join fine, block appears afterward, room does
// NOT start when the 4th slot completes it — no one is auto-kicked.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createOpenRoom(store) // host @ A0
  let blockedPairs: Array<[string, string]> = []
  const isBlockedWith = (a: string, b: string) => blockedPairs.some(([p, q]) => p === a && q === b)

  const partnerJoin = store.joinTeam({ privateRoomId: room.id, ...makeHuman('partner'), team: 'A', slotIndex: 1, isBlockedWith })
  check('[5] partner joins fine (no block yet)', partnerJoin.ok)

  // Block appears after the fact (simulates the user blocking their table
  // partner via the unrelated friends/profile UI, mid-wait).
  blockedPairs = [['profile-partner', 'profile-host']]

  store.joinTeam({ privateRoomId: room.id, ...makeHuman('b0'), team: 'B', slotIndex: 0, isBlockedWith })
  events.length = 0
  const completingJoin = store.joinTeam({ privateRoomId: room.id, ...makeHuman('b1'), team: 'B', slotIndex: 1, isBlockedWith })

  check('[5b] the completing 4th join itself succeeds (b1 IS seated)', completingJoin.ok)
  check('[5c] but the room does NOT transition to ready', completingJoin.ok && completingJoin.readyToStart === false)
  check(
    '[5d] readiness reports the blocked Team A partnership',
    completingJoin.ok && completingJoin.readiness !== undefined && !completingJoin.readiness.ready &&
      completingJoin.readiness.reason === 'blocked_partnership' && completingJoin.readiness.blockedTeam === 'A',
  )
  check('[5e] roomReady never fired — no silent invalid start', !events.includes('roomReady'))
  check('[5f] room stays listed (live) — no one was auto-kicked', store.listRooms().some((r) => r.id === room.id))
  if (completingJoin.ok) {
    const occupied = completingJoin.room.slots.filter((s) => s.occupant !== null).length
    check('[5g] all 4 seats remain occupied — no auto-kick of either blocked partner', occupied === 4)
  }
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
