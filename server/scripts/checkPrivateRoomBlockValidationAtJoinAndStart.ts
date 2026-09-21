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
 *
 * Creator block = FULL seat ban (private rooms only, creator -> joiner only):
 *  - [1]-[4] deliberately use a NON-creator blocker (a seated participant who
 *    is not the room's original creator) — a block by the CREATOR now denies
 *    every seat (see [6]-[14]), so the partner-only semantics these cases
 *    prove apply to non-creator participants.
 *  - [6]/[7] creator blocked joiner -> partner seat AND opponent seats denied
 *    with 'private_room_creator_blocked_you'; no seat mutation, no events.
 *  - [8] non-creator blocker -> old partner rule intact, no creator ban.
 *  - [9] reverse direction (joiner blocked creator, creator did not) -> the
 *    creator ban does NOT fire; the old partner rule decides.
 *  - [10] guest creator (profileId null) -> no ban possible.
 *  - [11] creator himself is never affected.
 *  - [12] creatorProfileId is immutable: creator leaves -> host transfers ->
 *    creator's block still bans; reconnect keeps it too.
 *  - [13] replayed/repeated denied seat requests never mutate room state.
 *  - [14] the creator ban takes precedence over slot-taken/partner checks.
 *  - [15] the shared read-only predicate (isProfileBannedByRoomCreator) used by
 *    BOTH the WS precheck (error priority, before level/balance) and joinTeam
 *    keeps the exact same directional semantics; joinTeam's rejection is the
 *    shared PRIVATE_ROOM_CREATOR_BLOCKED_REJECTION.
 *  - [16] race safety: the WS precheck is only an error-priority hint —
 *    joinTeam re-checks and decides finally if the block changes in between.
 */

import {
  createPrivateRoomsStore,
  isProfileBannedByRoomCreator,
  PRIVATE_ROOM_CREATOR_BLOCKED_REJECTION,
} from '../src/game/privateRoomsStore.js'

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

// Blocks host <-> troll, directional (host blocked troll). In [1]-[4] 'host' is
// a seated NON-creator participant at B0 (see createRoomWithSeatedHost) — the
// room's original creator is 'owner' — so this exercises the partner rule only.
const hostBlockedTroll = (a: string, b: string) => a === 'profile-host' && b === 'profile-troll'

// Creator = 'owner' @ A0 (never blocks anyone here); 'host' joins B0 as an
// ordinary participant. 'host' is therefore a non-creator blocker.
function createRoomWithSeatedHost(store: ReturnType<typeof createPrivateRoomsStore>) {
  const room = createOpenRoom(store, 'owner')
  const hostJoin = store.joinTeam({ privateRoomId: room.id, ...makeHuman('host'), team: 'B', slotIndex: 0, isBlockedWith: () => false })
  if (!hostJoin.ok) throw new Error('setup failed: host could not join B0')
  return hostJoin.room
}

// ---------------------------------------------------------------------------
// [1] Joining the blocked partner's team is rejected.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createRoomWithSeatedHost(store)

  const result = store.joinTeam({
    privateRoomId: room.id,
    ...makeHuman('troll'),
    team: 'B', // same team as host (B0) -> would become partners
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
  const room = createRoomWithSeatedHost(store)
  const trollBlockedHost = (a: string, b: string) => a === 'profile-troll' && b === 'profile-host'

  const result = store.joinTeam({
    privateRoomId: room.id,
    ...makeHuman('troll'),
    team: 'B',
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
  const room = createRoomWithSeatedHost(store)

  const result = store.joinTeam({
    privateRoomId: room.id,
    ...makeHuman('troll'),
    team: 'A', // opposing team of host (B) -> opponents, not partners
    slotIndex: 1,
    isBlockedWith: hostBlockedTroll,
  })

  check('[3] joining as an OPPONENT despite a non-creator block succeeds', result.ok)
}

// ---------------------------------------------------------------------------
// [4] Rejected from one team -> free to join the other team.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createRoomWithSeatedHost(store)

  const rejected = store.joinTeam({ privateRoomId: room.id, ...makeHuman('troll'), team: 'B', slotIndex: 1, isBlockedWith: hostBlockedTroll })
  check('[4] rejected from Team B (partner block)', !rejected.ok)

  const accepted = store.joinTeam({ privateRoomId: room.id, ...makeHuman('troll'), team: 'A', slotIndex: 1, isBlockedWith: hostBlockedTroll })
  check('[4b] same player freely joins Team A instead', accepted.ok)
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

// ===========================================================================
// Creator block = FULL seat ban (creator -> joiner, private rooms only).
// Creator = 'host' @ A0 (createOpenRoom default); C = 'c' is the joining player.
// ===========================================================================
const creatorBlockedC = (a: string, b: string) => a === 'profile-host' && b === 'profile-c'

// ---------------------------------------------------------------------------
// [6] Scenario A: creator blocked C -> C's PARTNER seat request is denied,
// with the dedicated code, and nothing about the room changes.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createOpenRoom(store)
  events.length = 0
  const before = JSON.stringify(store.listRooms())

  const result = store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'A', slotIndex: 1, isBlockedWith: creatorBlockedC })

  check('[6] A: creator blocked joiner -> PARTNER seat denied', !result.ok)
  check('[6b] code is private_room_creator_blocked_you', !result.ok && result.code === 'private_room_creator_blocked_you')
  check('[6c] room state is byte-for-byte unchanged (no seat mutation)', JSON.stringify(store.listRooms()) === before)
  check('[6d] no events fired by the denied join (no roomsChanged / roomReady)', events.length === 0)
  check('[6e] joiner holds no room membership', store.getRoomByConnectionId('conn-c') === null && store.getRoomByProfileId('profile-c') === null)
}

// ---------------------------------------------------------------------------
// [7] Scenario B: creator blocked C -> C's OPPONENT seats are denied too.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createOpenRoom(store)
  events.length = 0
  const before = JSON.stringify(store.listRooms())

  const b0 = store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'B', slotIndex: 0, isBlockedWith: creatorBlockedC })
  const b1 = store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'B', slotIndex: 1, isBlockedWith: creatorBlockedC })

  check('[7] B: creator blocked joiner -> OPPONENT seat B0 denied', !b0.ok && b0.code === 'private_room_creator_blocked_you')
  check('[7b] B: creator blocked joiner -> OPPONENT seat B1 denied', !b1.ok && b1.code === 'private_room_creator_blocked_you')
  check('[7c] room state unchanged after both denials', JSON.stringify(store.listRooms()) === before && events.length === 0)
}

// ---------------------------------------------------------------------------
// [8] Scenario C: a NON-creator participant blocked C, creator did not ->
// old partner rule stays; C may still sit elsewhere at the table.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store) // creator 'host' @ A0
  const bBlockedC = (a: string, b: string) => a === 'profile-b' && b === 'profile-c'
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('b'), team: 'B', slotIndex: 0, isBlockedWith: bBlockedC })

  const asPartnerOfB = store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'B', slotIndex: 1, isBlockedWith: bBlockedC })
  check('[8] C: non-creator blocker -> partner seat next to the blocker still denied', !asPartnerOfB.ok)
  check(
    '[8b] ...with the OLD partner code, NOT the creator-ban code',
    !asPartnerOfB.ok && asPartnerOfB.code === 'private_room_partner_blocked',
  )

  const elsewhere = store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'A', slotIndex: 1, isBlockedWith: bBlockedC })
  check('[8c] C: ...but C may still sit on the table where the old rules allow (A1, next to the creator)', elsewhere.ok)
}

// ---------------------------------------------------------------------------
// [9] Scenario D: REVERSE direction — C blocked the creator, creator did NOT
// block C -> the creator ban must not activate; old partner rule decides.
// ---------------------------------------------------------------------------
{
  const cBlockedCreator = (a: string, b: string) => a === 'profile-c' && b === 'profile-host'

  const { store: opponentStore } = createTrackedStore()
  const opponentRoom = createOpenRoom(opponentStore)
  const asOpponent = opponentStore.joinTeam({ privateRoomId: opponentRoom.id, ...makeHuman('c'), team: 'B', slotIndex: 0, isBlockedWith: cBlockedCreator })
  check('[9] D: joiner blocked creator (not vice versa) -> opponent seat is NOT banned', asOpponent.ok)

  const { store: partnerStore } = createTrackedStore()
  const partnerRoom = createOpenRoom(partnerStore)
  const asPartner = partnerStore.joinTeam({ privateRoomId: partnerRoom.id, ...makeHuman('c'), team: 'A', slotIndex: 1, isBlockedWith: cBlockedCreator })
  check('[9b] D: ...partner seat next to the creator is still handled by the OLD partner rule', !asPartner.ok)
  check(
    '[9c] D: ...and the code is the old partner code, never the creator-ban code',
    !asPartner.ok && asPartner.code === 'private_room_partner_blocked_by_viewer',
  )
}

// ---------------------------------------------------------------------------
// [10] Guest creator (profileId null) can hold no block -> no ban is possible.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const created = store.createRoom({ ...makeHuman('g'), profileId: null, stake: 1000, isLocked: false, waitMinutes: 15 })
  if (!created.ok) throw new Error('setup failed')
  check('[10] guest creator -> creatorProfileId is null', created.room.creatorProfileId === null)

  const result = store.joinTeam({ privateRoomId: created.room.id, ...makeHuman('c'), team: 'B', slotIndex: 0, isBlockedWith: () => true })
  check('[10b] guest creator -> joiner is not banned even if every block predicate returns true', result.ok)
}

// ---------------------------------------------------------------------------
// [11] Scenario F: the creator himself is never affected by the check.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store) // creator 'host' @ A0
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('b'), team: 'B', slotIndex: 0, isBlockedWith: () => false })
  store.leaveRoom('conn-host') // room survives ('b' remains); host role transfers to 'b'
  const creatorBlocksEveryone = (a: string) => a === 'profile-host'

  const rejoin = store.joinTeam({ privateRoomId: room.id, ...makeHuman('host'), team: 'A', slotIndex: 0, isBlockedWith: creatorBlocksEveryone })
  check('[11] F: the creator can re-sit at his own table even though he blocks everyone', rejoin.ok)
  check(
    '[11b] F: rejoining does not reclaim host, and creatorProfileId is untouched',
    rejoin.ok && rejoin.room.creatorProfileId === 'profile-host' && rejoin.room.hostProfileId === 'profile-b',
  )
}

// ---------------------------------------------------------------------------
// [12] Scenario H: creator A blocks C -> A leaves -> B becomes host -> C is
// STILL denied, because creatorProfileId stays A (immutable original creator).
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store) // creator 'host' @ A0
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('b'), team: 'B', slotIndex: 0, isBlockedWith: () => false })

  const afterLeave = store.leaveRoom('conn-host')
  check('[12] H: creator left, room survives with B as the NEW host', afterLeave !== null && afterLeave.hostProfileId === 'profile-b')
  check('[12b] H: creatorProfileId is still the ORIGINAL creator after host transfer', afterLeave !== null && afterLeave.creatorProfileId === 'profile-host')

  const cAtEmptyA0 = store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'A', slotIndex: 0, isBlockedWith: creatorBlockedC })
  const cAsPartnerOfNewHost = store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'B', slotIndex: 1, isBlockedWith: creatorBlockedC })
  check('[12c] H: C still denied an empty seat although the creator is no longer at the table', !cAtEmptyA0.ok && cAtEmptyA0.code === 'private_room_creator_blocked_you')
  check('[12d] H: C still denied the new host\'s partner seat', !cAsPartnerOfNewHost.ok && cAsPartnerOfNewHost.code === 'private_room_creator_blocked_you')

  // Disconnect/reconnect of the new host must not touch creatorProfileId either.
  const reconnected = store.reconnectMember('conn-b-2', 'profile-b')
  check('[12e] H: reconnect keeps creatorProfileId', reconnected !== null && reconnected.creatorProfileId === 'profile-host')

  // A second host transfer (new host leaves) still keeps the original creator.
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('d'), team: 'A', slotIndex: 1, isBlockedWith: () => false })
  const afterSecondLeave = store.leaveRoom('conn-b-2')
  check(
    '[12f] H: second host transfer (B leaves -> D hosts) still keeps the original creator',
    afterSecondLeave !== null && afterSecondLeave.hostProfileId === 'profile-d' && afterSecondLeave.creatorProfileId === 'profile-host',
  )
  const cAfterSecondTransfer = store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'B', slotIndex: 0, isBlockedWith: creatorBlockedC })
  check('[12g] H: C still denied after the second host transfer', !cAfterSecondTransfer.ok && cAfterSecondTransfer.code === 'private_room_creator_blocked_you')
}

// ---------------------------------------------------------------------------
// [13] Scenario G (store level): a replayed / repeated denied seat request is
// denied every time and can never mutate room state or emit events.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createOpenRoom(store)
  events.length = 0
  const before = JSON.stringify(store.listRooms())

  const outcomes = [0, 1, 2].flatMap(() => [
    store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'A', slotIndex: 1, isBlockedWith: creatorBlockedC }),
    store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'B', slotIndex: 0, isBlockedWith: creatorBlockedC }),
  ])

  check('[13] G: 6 replayed partner/opponent seat requests are ALL denied with the creator-ban code', outcomes.every((o) => !o.ok && o.code === 'private_room_creator_blocked_you'))
  check('[13b] G: room state unchanged and zero events after the replays', JSON.stringify(store.listRooms()) === before && events.length === 0)
}

// ---------------------------------------------------------------------------
// [14] The creator ban takes precedence over the slot-taken and partner checks
// (C may sit NOWHERE, so the more specific reason wins).
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store) // creator 'host' @ A0
  const bAndCreatorBlockedC = (a: string, b: string) => b === 'profile-c' && (a === 'profile-host' || a === 'profile-b')
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('b'), team: 'B', slotIndex: 0, isBlockedWith: bAndCreatorBlockedC })

  const wouldBePartnerBlock = store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'B', slotIndex: 1, isBlockedWith: bAndCreatorBlockedC })
  const occupiedSlot = store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'A', slotIndex: 0, isBlockedWith: bAndCreatorBlockedC })
  check('[14] creator ban wins over a simultaneous partner block', !wouldBePartnerBlock.ok && wouldBePartnerBlock.code === 'private_room_creator_blocked_you')
  check('[14b] creator ban wins over slot-taken', !occupiedSlot.ok && occupiedSlot.code === 'private_room_creator_blocked_you')
}

// ---------------------------------------------------------------------------
// [15] The shared read-only predicate: same directional semantics as joinTeam.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store) // creator 'host'
  const before = JSON.stringify(store.listRooms())
  const cBlockedCreator = (a: string, b: string) => a === 'profile-c' && b === 'profile-host'

  check('[15] predicate: creator blocked joiner -> banned', isProfileBannedByRoomCreator(room, 'profile-c', creatorBlockedC))
  check('[15b] predicate: reverse direction only (joiner blocked creator) -> NOT banned', !isProfileBannedByRoomCreator(room, 'profile-c', cBlockedCreator))
  check('[15c] predicate: the creator himself is never banned, even if every block predicate is true', !isProfileBannedByRoomCreator(room, 'profile-host', () => true))
  check('[15d] predicate: a null joining profileId (guest) is never banned', !isProfileBannedByRoomCreator(room, null, () => true))
  check('[15e] predicate: a guest-created room (creatorProfileId null) bans nobody', !isProfileBannedByRoomCreator({ creatorProfileId: null }, 'profile-c', () => true))
  check('[15f] predicate: no block at all -> NOT banned', !isProfileBannedByRoomCreator(room, 'profile-c', () => false))
  check('[15g] predicate is read-only — the store is untouched by calling it', JSON.stringify(store.listRooms()) === before)

  const denied = store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'B', slotIndex: 0, isBlockedWith: creatorBlockedC })
  check(
    '[15h] joinTeam rejects with exactly the shared PRIVATE_ROOM_CREATOR_BLOCKED_REJECTION (same code + message as the WS precheck)',
    !denied.ok && denied.code === PRIVATE_ROOM_CREATOR_BLOCKED_REJECTION.code && denied.message === PRIVATE_ROOM_CREATOR_BLOCKED_REJECTION.message,
  )
}

// ---------------------------------------------------------------------------
// [16] Race safety: the precheck is only an error-priority hint; joinTeam is
// authoritative and decides finally if the block changes in between.
// ---------------------------------------------------------------------------
{
  // Precheck passes (no block yet) -> the block appears -> joinTeam still denies.
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  let blocked = false
  const dynamic = (a: string, b: string) => blocked && a === 'profile-host' && b === 'profile-c'

  const precheck = isProfileBannedByRoomCreator(room, 'profile-c', dynamic)
  blocked = true
  const result = store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'B', slotIndex: 0, isBlockedWith: dynamic })

  check('[16] race: precheck saw no block, joinTeam (final authority) still denies once the block exists', precheck === false && !result.ok && result.code === 'private_room_creator_blocked_you')
  check('[16b] race: ...and the room was not mutated', store.getRoomByProfileId('profile-c') === null)
}
{
  // Precheck would deny -> the block is removed -> joinTeam is independent and decides on the current state.
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  let blocked = true
  const dynamic = (a: string, b: string) => blocked && a === 'profile-host' && b === 'profile-c'

  const precheck = isProfileBannedByRoomCreator(room, 'profile-c', dynamic)
  blocked = false
  const result = store.joinTeam({ privateRoomId: room.id, ...makeHuman('c'), team: 'B', slotIndex: 0, isBlockedWith: dynamic })

  check('[16c] race: joinTeam never trusts a stale precheck — it decides on the block state at seat time', precheck === true && result.ok)
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
