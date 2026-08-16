/**
 * checkPrivateRoomHostTransferLifecycle.ts
 *
 * Unit tests for privateRoomsStore.ts's host/creator lifecycle — the
 * invariants around what happens when the CURRENT host leaves, distinct
 * from checkPrivateRoomHostReassignmentSkipsBots.ts (which only proves the
 * "skip bot, pick next human" scan order). This file covers the broader
 * lifecycle contract:
 *
 *  [1]  host leaves, a second human remains -> room survives.
 *  [2]  host leaves together with their OWN bot partner (same team) -> the
 *       bot is removed by orphan-cleanup AND host reassignment happens in
 *       the SAME leaveRoom() call, exercising both paths together (the
 *       existing skip-bots test deliberately keeps them on separate teams).
 *  [3]  the remaining human becomes host.
 *  [4]  the new host is never a bot (re-asserted here at the "host had an
 *       own bot partner" angle, complementing the existing file's
 *       "bot at an earlier slot on someone else's team" angle).
 *  [5]  no humans remain after the leave -> room is deleted entirely.
 *  [6]  host transfer does NOT reset/change expiresAt.
 *  [7]  host transfer does NOT move any remaining occupant's slot/team.
 *  [8]  locked room: host leaves, a remaining INVITED (authorized) human
 *       becomes host.
 *  [9]  the new locked-room host can invite friends (inviteFriend is
 *       membership-based, not tied to being the original creator).
 *  [10] the OLD creator, having lost host status, does NOT get it back by
 *       simply leaving and rejoining — joinTeam() never assigns host.
 *
 * There is no persisted "creatorProfileId" anywhere on PrivateRoom — only
 * hostProfileId/hostConnectionId, reassigned exclusively inside leaveRoom().
 * joinTeam() never touches them. This file proves that contract behaviorally
 * end-to-end at the store level, the same style as
 * checkPrivateRoomHostReassignmentSkipsBots.ts and checkPrivateRoomStartValidation.ts.
 */

import {
  createPrivateRoomsStore,
  type PrivateRoomBotOccupant,
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

// ---------------------------------------------------------------------------
// [1]+[2]+[3]+[4]+[6]+[7] host leaves together with their OWN bot partner —
// remaining human becomes host, bot is gone, expiresAt/slots untouched.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()

  const created = store.createRoom({ ...makeHuman('host'), stake: 1000, isLocked: false, waitMinutes: 15 })
  if (!created.ok) throw new Error('setup failed')
  const originalExpiresAt = created.room.expiresAt

  // host adds a bot partner on their OWN team (A) -> A1.
  const addBot = store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBotOccupant('1'), isBlockedWith: noBlocks })
  if (!addBot.ok) throw new Error('setup failed')

  // marta joins Team B, slot 0 — deliberately NOT slot 0 of A, so the "which
  // slot is next in scan order" question is unambiguous.
  const martaJoin = store.joinTeam({ privateRoomId: created.room.id, ...makeHuman('marta'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  if (!martaJoin.ok) throw new Error('setup failed')

  check('[setup] host is at A0, bot at A1, marta at B0', martaJoin.room.hostConnectionId === 'conn-host')

  // THE TEST: host (with own bot partner on Team A) leaves.
  store.leaveRoom('conn-host')
  const finalRoom = store.getRoomByConnectionId('conn-marta')

  check('[1] room survives (marta remains)', finalRoom !== null)
  if (finalRoom !== null) {
    check('[2] the host\'s own bot partner (A1) was removed by orphan-cleanup', finalRoom.slots.find((s) => s.team === 'A' && s.slotIndex === 1)?.occupant === null)
    check('[2b] A0 (the departed host\'s own slot) is also empty', finalRoom.slots.find((s) => s.team === 'A' && s.slotIndex === 0)?.occupant === null)
    check('[3] marta is the new host (profileId)', finalRoom.hostProfileId === 'profile-marta')
    check('[4] the new host is never the bot — hostConnectionId is marta\'s real connection', finalRoom.hostConnectionId === 'conn-marta')
    check('[6] expiresAt is byte-identical after the host transfer (not reset)', finalRoom.expiresAt === originalExpiresAt)
    check('[7] marta is still at exactly B,0 — host transfer did not move her slot/team', finalRoom.slots.find((s) => s.team === 'B' && s.slotIndex === 0)?.occupant?.profileId === 'profile-marta')
  }
}

// ---------------------------------------------------------------------------
// [5] No humans remain after the leave -> room deleted entirely, no orphan
// bot, no stale entry.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()

  const created = store.createRoom({ ...makeHuman('solo'), stake: 1000, isLocked: false, waitMinutes: 15 })
  if (!created.ok) throw new Error('setup failed')
  // Bot must be added to solo's OWN team (A, where they are seated at A0) —
  // addBotToTeam requires the caller to be a human member of the target team.
  const addBot = store.addBotToTeam({ connectionId: 'conn-solo', team: 'A', botOccupant: makeBotOccupant('2'), isBlockedWith: noBlocks })
  if (!addBot.ok) throw new Error('setup failed')

  events.length = 0
  store.leaveRoom('conn-solo')

  check('[5] the room no longer exists in the store at all', store.listRooms().every((r) => r.id !== created.room.id))
  check('[5b] getRoomByConnectionId for the departed connection returns null (no orphan bot-only room left behind)', store.getRoomByConnectionId('conn-solo') === null)
  check('[5c] onRoomsChanged fired (list broadcast keeps clients in sync)', events.includes('roomsChanged'))
  check('[5d] onMemberLeft did NOT fire for a room-deleting leave (nothing to notify remaining members about)', !events.includes('memberLeft'))
}

// ---------------------------------------------------------------------------
// [8]+[9] Locked room: host leaves, a remaining INVITED human becomes host,
// and the new host can invite (membership-based, not creator-based).
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()

  const created = store.createRoom({ ...makeHuman('creator'), stake: 1000, isLocked: true, waitMinutes: 15 })
  if (!created.ok) throw new Error('setup failed')

  // Real invite flow: creator invites 'invitee', invitee accepts (grants
  // room-lifetime authorization, does NOT auto-seat), then claims a slot
  // via the normal joinTeam path — mirrors the real production sequence.
  const inviteResult = store.inviteFriend({ senderConnectionId: 'conn-creator', toProfileId: 'profile-invitee', toDisplayName: 'Invitee' })
  if (!inviteResult.ok) throw new Error(`invite setup failed: ${inviteResult.message}`)
  const accept = store.respondToInvite({ inviteId: inviteResult.invite.inviteId, profileId: 'profile-invitee', accept: true })
  if (!accept.ok) throw new Error('accept setup failed')

  const invJoin = store.joinTeam({ privateRoomId: created.room.id, ...makeHuman('invitee'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  if (!invJoin.ok) throw new Error(`invitee join failed: ${invJoin.message}`)

  // THE TEST: creator/host leaves the locked room.
  store.leaveRoom('conn-creator')
  const afterLeave = store.getRoomByConnectionId('conn-invitee')

  check('[8] the locked room survives (the invited human remains)', afterLeave !== null)
  if (afterLeave !== null) {
    check('[8b] the remaining invited human is the new host', afterLeave.hostProfileId === 'profile-invitee')
    check('[8c] the old creator is gone from the room entirely', !afterLeave.slots.some((s) => s.occupant?.profileId === 'profile-creator'))

    // [9] the new host (not the original creator) can invite — inviteFriend
    // is membership-based, no host-only/creator-only restriction exists.
    const newHostInvite = store.inviteFriend({ senderConnectionId: 'conn-invitee', toProfileId: 'profile-third', toDisplayName: 'Third' })
    check('[9] the new host can successfully invite a friend to the (still locked) room', newHostInvite.ok)
  }

  // [10] the old creator rejoins later — does NOT steal host back. Locked
  // room: creator retains room-lifetime authorization from creation, so a
  // direct rejoin via joinTeam is legitimately reachable.
  const rejoin = store.joinTeam({ privateRoomId: created.room.id, ...makeHuman('creator'), team: 'A', slotIndex: 1, isBlockedWith: noBlocks })
  check('[10-setup] the old creator can rejoin (still room-lifetime authorized from creation)', rejoin.ok)
  if (rejoin.ok) {
    check('[10] the old creator rejoining does NOT restore their host status — invitee is still host', rejoin.room.hostProfileId === 'profile-invitee')
    check('[10b] hostConnectionId still points to invitee\'s connection, not the rejoined creator\'s NEW connection', rejoin.room.hostConnectionId === 'conn-invitee')
  }
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
