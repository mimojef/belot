/**
 * checkPrivateRoomManualStartAndKick.ts
 *
 * Store-level tests for two new Private Rooms host actions:
 *
 *  A) manualStart toggle — when a room is created with manualStart:true,
 *     reaching 4/4 occupancy no longer auto-detaches/onRoomReady's the room
 *     (mirrors the existing manualStart:false auto-start path, which must
 *     stay byte-identical in behavior — see [1]-[3]).
 *  B) startRoom() — host-only explicit start for a manualStart room:
 *     authorization (creator-only), precondition checks (room must be
 *     manualStart, must be full, readiness must pass), and race-safety
 *     (recomputes against the CURRENT store state at call time, not a
 *     cached snapshot).
 *  C) kickMember() — host-only removal of ANY occupied slot from a WAITING
 *     room. Two distinct outcomes, both authoritative server-side (the kind
 *     is read from the slot state, never trusted from the client):
 *       - human target: authorization, target validity (must not be the
 *         host themselves), orphan-bot partner cleanup (mirrors
 *         leaveRoom's), and the dedicated onMemberKicked callback (distinct
 *         from onMemberLeft) — unchanged from before.
 *       - bot target: same host-only authorization, but a pure slot-clear
 *         with NO onMemberKicked/onMemberLeft callback (bots have no
 *         session to notify), no orphan-partner cleanup (removing the bot
 *         itself never orphans anything), and canManualStart drops
 *         immediately since the room is no longer full.
 *
 * Mirrors the harness style of checkPrivateRoomBlockValidationAtJoinAndStart.ts
 * (store-level, in-process, no WS/HTTP server).
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
    onMemberKicked: () => events.push('memberKicked'),
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

function createRoom(
  store: ReturnType<typeof createPrivateRoomsStore>,
  hostId = 'host',
  manualStart = false,
) {
  const created = store.createRoom({
    ...makeHuman(hostId),
    stake: 1000,
    isLocked: false,
    waitMinutes: 15,
    manualStart,
  })
  if (!created.ok) throw new Error('setup failed')
  return created.room
}

const neverBlocked = () => false

function makeBot(id: string) {
  return {
    kind: 'bot' as const,
    botProfileId: `bot-${id}`,
    botCode: `easy-${id}`,
    difficulty: 'easy' as const,
    identity: { profileId: `bot-${id}`, displayName: `Bot ${id}`, avatarUrl: null, level: 1, rankTitle: null },
  }
}

// ---------------------------------------------------------------------------
// [1]-[3] manualStart:false — byte-identical auto-start behavior (regression
// guard for the tryAutoStartIfFull refactor).
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createRoom(store, 'host', false)

  store.joinTeam({ ...makeHuman('a1'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: neverBlocked })
  store.joinTeam({ ...makeHuman('b0'), privateRoomId: room.id, team: 'B', slotIndex: 0, isBlockedWith: neverBlocked })
  const finalJoin = store.joinTeam({ ...makeHuman('b1'), privateRoomId: room.id, team: 'B', slotIndex: 1, isBlockedWith: neverBlocked })

  check('[1] manualStart:false 4/4 join reports readyToStart:true', finalJoin.ok && finalJoin.readyToStart === true)
  check('[2] onRoomReady fired exactly once', events.filter((e) => e === 'roomReady').length === 1)
  check('[3] room is detached from the store (no longer listed)', store.listRooms().length === 0)
}

// ---------------------------------------------------------------------------
// [4]-[7] manualStart:true — 4/4 does NOT auto-start; room stays live/full.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createRoom(store, 'host', true)

  store.joinTeam({ ...makeHuman('a1'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: neverBlocked })
  store.joinTeam({ ...makeHuman('b0'), privateRoomId: room.id, team: 'B', slotIndex: 0, isBlockedWith: neverBlocked })
  const finalJoin = store.joinTeam({ ...makeHuman('b1'), privateRoomId: room.id, team: 'B', slotIndex: 1, isBlockedWith: neverBlocked })

  check('[4] manualStart:true 4/4 join reports readyToStart:false', finalJoin.ok && finalJoin.readyToStart === false)
  check('[4b] readiness still reports ready:true (block/duplicate checks unaffected)', finalJoin.ok && finalJoin.readiness?.ready === true)
  check('[5] onRoomReady did NOT fire', !events.includes('roomReady'))
  check('[6] room remains listed (live, not detached)', store.listRooms().length === 1)
  check('[7] all 4 seats remain occupied', store.listRooms()[0]!.slots.every((s) => s.occupant !== null))
}

// ---------------------------------------------------------------------------
// [8]-[10] 3/4 manualStart room — no start possible (not full).
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createRoom(store, 'host', true)
  store.joinTeam({ ...makeHuman('a1'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: neverBlocked })

  const startResult = store.startRoom({ connectionId: 'conn-host', isBlockedWith: neverBlocked })
  check('[8] startRoom on a 2/4 room is rejected', !startResult.ok)
  check('[9] error code is private_room_not_ready_to_start', !startResult.ok && startResult.code === 'private_room_not_ready_to_start')
  check('[10] room remains listed/live after the rejected start', store.listRooms().length === 1)
}

// ---------------------------------------------------------------------------
// [11]-[14] host-only authorization for startRoom.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createRoom(store, 'host', true)
  store.joinTeam({ ...makeHuman('a1'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: neverBlocked })
  store.joinTeam({ ...makeHuman('b0'), privateRoomId: room.id, team: 'B', slotIndex: 0, isBlockedWith: neverBlocked })
  store.joinTeam({ ...makeHuman('b1'), privateRoomId: room.id, team: 'B', slotIndex: 1, isBlockedWith: neverBlocked })

  const nonCreatorStart = store.startRoom({ connectionId: 'conn-a1', isBlockedWith: neverBlocked })
  check('[11] non-creator cannot start the room', !nonCreatorStart.ok)
  check('[12] error code is private_room_not_creator', !nonCreatorStart.ok && nonCreatorStart.code === 'private_room_not_creator')

  const spoofedConnectionStart = store.startRoom({ connectionId: 'conn-does-not-exist', isBlockedWith: neverBlocked })
  check('[13] spoofed/unknown connectionId cannot start any room', !spoofedConnectionStart.ok)
  check('[14] room is still live/full and untouched after both rejected attempts', store.listRooms().length === 1 && store.listRooms()[0]!.slots.every((s) => s.occupant !== null))
}

// ---------------------------------------------------------------------------
// [15]-[18] successful host START on a full manualStart room — delegates to
// the same onRoomReady/detach path as auto-start (no duplicated match-start
// logic).
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createRoom(store, 'host', true)
  store.joinTeam({ ...makeHuman('a1'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: neverBlocked })
  store.joinTeam({ ...makeHuman('b0'), privateRoomId: room.id, team: 'B', slotIndex: 0, isBlockedWith: neverBlocked })
  store.joinTeam({ ...makeHuman('b1'), privateRoomId: room.id, team: 'B', slotIndex: 1, isBlockedWith: neverBlocked })

  const startResult = store.startRoom({ connectionId: 'conn-host', isBlockedWith: neverBlocked })
  check('[15] creator START on a full manualStart room succeeds', startResult.ok)
  check('[16] onRoomReady fired exactly once', events.filter((e) => e === 'roomReady').length === 1)
  check('[17] room is detached from the store', store.listRooms().length === 0)
  check('[18] no onMemberKicked/onMemberLeft side effects from START', !events.includes('memberKicked') && !events.includes('memberLeft'))
}

// ---------------------------------------------------------------------------
// [19]-[21] Race-safety: a player leaves between the client's "4/4" snapshot
// and the server processing startRoom() — start must be refused, room stays
// waiting (not silently started with a hole).
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createRoom(store, 'host', true)
  store.joinTeam({ ...makeHuman('a1'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: neverBlocked })
  store.joinTeam({ ...makeHuman('b0'), privateRoomId: room.id, team: 'B', slotIndex: 0, isBlockedWith: neverBlocked })
  store.joinTeam({ ...makeHuman('b1'), privateRoomId: room.id, team: 'B', slotIndex: 1, isBlockedWith: neverBlocked })

  // b1 leaves right before the host's START request is processed.
  store.leaveRoom('conn-b1')

  const startResult = store.startRoom({ connectionId: 'conn-host', isBlockedWith: neverBlocked })
  check('[19] START on a room that JUST became non-full is rejected', !startResult.ok)
  check('[20] error code is private_room_not_ready_to_start', !startResult.ok && startResult.code === 'private_room_not_ready_to_start')
  check('[21] room remains waiting (live, 3/4) — not silently started', store.listRooms().length === 1 && store.listRooms()[0]!.slots.filter((s) => s.occupant !== null).length === 3)
}

// ---------------------------------------------------------------------------
// [22]-[23] Late block appearing between join and START — readiness still
// gates the explicit host start path too.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createRoom(store, 'host', true)
  store.joinTeam({ ...makeHuman('a1'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: neverBlocked })
  store.joinTeam({ ...makeHuman('b0'), privateRoomId: room.id, team: 'B', slotIndex: 0, isBlockedWith: neverBlocked })
  store.joinTeam({ ...makeHuman('b1'), privateRoomId: room.id, team: 'B', slotIndex: 1, isBlockedWith: neverBlocked })

  const hostBlockedA1 = (a: string, b: string) => a === 'profile-host' && b === 'profile-a1'
  const startResult = store.startRoom({ connectionId: 'conn-host', isBlockedWith: hostBlockedA1 })
  check('[22] START is rejected when a late block makes the room not-ready', !startResult.ok)
  check('[23] onRoomReady never fired for a blocked-partnership room', !events.includes('roomReady'))
}

// ---------------------------------------------------------------------------
// [24]-[27] kickMember — host-only authorization.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createRoom(store, 'host', false)
  store.joinTeam({ ...makeHuman('a1'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: neverBlocked })

  const nonHostKick = store.kickMember({ connectionId: 'conn-a1', team: 'A', slotIndex: 0 })
  check('[24] non-host cannot kick anyone', !nonHostKick.ok)
  check('[25] error code is private_room_not_creator', !nonHostKick.ok && nonHostKick.code === 'private_room_not_creator')

  const spoofedKick = store.kickMember({ connectionId: 'conn-does-not-exist', team: 'A', slotIndex: 1 })
  check('[26] spoofed/unknown connectionId cannot kick', !spoofedKick.ok)
  check('[27] a1 is still seated after both rejected attempts', store.getRoomByConnectionId('conn-host')?.slots.some((s) => s.occupant?.kind === 'human' && s.occupant.connectionId === 'conn-a1') === true)
}

// ---------------------------------------------------------------------------
// [28]-[30] Host cannot kick themselves; kicking an empty/invalid slot fails
// cleanly.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createRoom(store, 'host', false)

  const selfKick = store.kickMember({ connectionId: 'conn-host', team: 'A', slotIndex: 0 })
  check('[28] host cannot kick themselves', !selfKick.ok)
  check('[28b] error code is private_room_kick_target_invalid', !selfKick.ok && selfKick.code === 'private_room_kick_target_invalid')

  const emptySlotKick = store.kickMember({ connectionId: 'conn-host', team: 'B', slotIndex: 0 })
  check('[29] kicking an empty slot fails cleanly (no crash)', !emptySlotKick.ok)
  check('[30] room untouched after the invalid attempts', store.listRooms().length === 1 && store.listRooms()[0]!.slots.filter((s) => s.occupant !== null).length === 1)
}

// ---------------------------------------------------------------------------
// [31]-[36] Successful host kick: slot is freed, onMemberKicked fires (not
// onMemberLeft), the room stays live, and the kicked player's connection is
// fully detached (can create/join a new room afterward).
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createRoom(store, 'host', false)
  store.joinTeam({ ...makeHuman('a1'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: neverBlocked })

  const kickResult = store.kickMember({ connectionId: 'conn-host', team: 'A', slotIndex: 1 })
  check('[31] host successfully kicks a real occupant', kickResult.ok)
  check('[32] onMemberKicked fired exactly once', events.filter((e) => e === 'memberKicked').length === 1)
  check('[33] onMemberLeft did NOT fire for a kick (distinct from voluntary leave)', !events.includes('memberLeft'))
  check('[34] the slot is now free', kickResult.ok && kickResult.room.slots.find((s) => s.team === 'A' && s.slotIndex === 1)?.occupant === null)
  check('[35] room remains live/listed (not deleted — host is still seated)', store.listRooms().length === 1)

  const rejoinAttempt = store.createRoom({ ...makeHuman('a1'), stake: 1000, isLocked: false, waitMinutes: 15, manualStart: false })
  check('[36] kicked player is fully detached and can create/join a new room (no lingering connectionToRoom entry, no permanent ban)', rejoinAttempt.ok)
}

// ---------------------------------------------------------------------------
// [37]-[38] Orphan-bot cleanup on kick mirrors leaveRoom's behavior — kicking
// the human partner of a bot also frees the bot's slot.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createRoom(store, 'host', false)
  const botOccupant = {
    kind: 'bot' as const,
    botProfileId: 'bot-1',
    botCode: 'easy-1',
    difficulty: 'easy' as const,
    identity: { profileId: 'bot-1', displayName: 'Bot One', avatarUrl: null, level: 1, rankTitle: null },
  }
  store.addBotToTeam({ connectionId: 'conn-host', team: 'B', botOccupant, isBlockedWith: neverBlocked })
  store.joinTeam({ ...makeHuman('b1'), privateRoomId: room.id, team: 'B', slotIndex: 1, isBlockedWith: neverBlocked })

  const kickResult = store.kickMember({ connectionId: 'conn-host', team: 'B', slotIndex: 1 })
  check('[37] host kicks the bot\'s human partner', kickResult.ok)
  check('[38] the orphaned bot slot is also freed', kickResult.ok && kickResult.room.slots.find((s) => s.team === 'B' && s.slotIndex === 0)?.occupant === null)
}

// ---------------------------------------------------------------------------
// [39]-[42] Scenario A: creator removes a bot via kickMember (same
// team/slotIndex endpoint as human kick) — the bot slot is freed, the
// result carries removedBot (not kickedOccupant), and no
// onMemberKicked/onMemberLeft callback fires (bots have no session).
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createRoom(store, 'host', false)
  store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBot('1'), isBlockedWith: neverBlocked })

  const removeResult = store.kickMember({ connectionId: 'conn-host', team: 'A', slotIndex: 1 })
  check('[39] creator can remove a bot through kickMember', removeResult.ok)
  check('[40] the result carries removedBot, not kickedOccupant', removeResult.ok && 'removedBot' in removeResult && removeResult.removedBot.botProfileId === 'bot-1')
  check('[41] the bot slot is now free (realtime-visible via the returned room)', removeResult.ok && removeResult.room.slots.find((s) => s.team === 'A' && s.slotIndex === 1)?.occupant === null)
  check('[42] no onMemberKicked/onMemberLeft fired for a bot removal (no session to notify)', !events.includes('memberKicked') && !events.includes('memberLeft'))
}

// ---------------------------------------------------------------------------
// [43]-[45] Scenario B: manual-start 4/4 room with a bot — canManualStart-
// style readiness (getOccupiedCount) drops the instant the bot is removed,
// and a fresh join brings it back to 4/4 (no lingering state from the
// removed bot, no double-seating).
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createRoom(store, 'host', true)
  store.joinTeam({ ...makeHuman('a1'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: neverBlocked })
  store.joinTeam({ ...makeHuman('b0'), privateRoomId: room.id, team: 'B', slotIndex: 0, isBlockedWith: neverBlocked })
  // addBotToTeam requires a same-team human caller — host (A0) cannot add a
  // bot to Team B, only a Team B member (b0) can (established ownership
  // rule, unrelated to this fix — see checkPrivateRoomBotOwnership.ts).
  store.addBotToTeam({ connectionId: 'conn-b0', team: 'B', botOccupant: makeBot('1'), isBlockedWith: neverBlocked })

  check('[43] room is 4/4 with a bot seated (manual-start ready to start)', store.listRooms()[0]!.slots.every((s) => s.occupant !== null))

  const removeResult = store.kickMember({ connectionId: 'conn-host', team: 'B', slotIndex: 1 })
  check('[44] removing the bot drops occupancy to 3/4 immediately (canManualStart-equivalent goes false)', removeResult.ok && removeResult.room.slots.filter((s) => s.occupant !== null).length === 3)

  const rejoin = store.joinTeam({ ...makeHuman('b1'), privateRoomId: room.id, team: 'B', slotIndex: 1, isBlockedWith: neverBlocked })
  check('[45] refilling the freed slot brings the room back to 4/4 and ready', rejoin.ok && rejoin.readyToStart === false && rejoin.readiness?.ready === true)
}

// ---------------------------------------------------------------------------
// [46]-[47] Scenario C: authorization — non-creator cannot remove a bot
// either (same host-only gate as human kick, no separate/weaker check).
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createRoom(store, 'host', false)
  // b0 joins Team B so it can legitimately add a bot to ITS OWN team via
  // addBotToTeam (established same-team ownership rule) — the point of this
  // test is kickMember's host-only gate, not addBotToTeam's.
  store.joinTeam({ ...makeHuman('b0'), privateRoomId: room.id, team: 'B', slotIndex: 0, isBlockedWith: neverBlocked })
  store.addBotToTeam({ connectionId: 'conn-b0', team: 'B', botOccupant: makeBot('1'), isBlockedWith: neverBlocked })

  const nonHostRemove = store.kickMember({ connectionId: 'conn-b0', team: 'B', slotIndex: 1 })
  check('[46] non-creator cannot remove a bot', !nonHostRemove.ok)
  check('[47] error code is private_room_not_creator (same gate as human kick)', !nonHostRemove.ok && nonHostRemove.code === 'private_room_not_creator')
  check('[47b] the bot is still seated after the rejected attempt', store.listRooms()[0]!.slots.find((s) => s.team === 'B' && s.slotIndex === 1)?.occupant?.kind === 'bot')
}

// ---------------------------------------------------------------------------
// [48] Scenario E: removing a bot never produces a permanent ban/block —
// the vacated slot can be immediately re-filled by a human join.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createRoom(store, 'host', false)
  store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBot('1'), isBlockedWith: neverBlocked })
  store.kickMember({ connectionId: 'conn-host', team: 'A', slotIndex: 1 })

  const refillResult = store.joinTeam({ ...makeHuman('a1'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: neverBlocked })
  check('[48] the freed bot slot can be immediately claimed by a human (no lingering restriction)', refillResult.ok)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
// Explicit exit — several test blocks above leave rooms live in the store
// with pending expiry setTimeout timers (createRoom's scheduleExpiry,
// waitMinutes:15 => 900_000ms), which would otherwise keep the Node event
// loop alive well past the process's natural completion (mirrors
// checkPrivateRoomBlockValidationAtJoinAndStart.ts's process.exit()).
process.exit(failed > 0 ? 1 : 0)
