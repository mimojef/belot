/**
 * checkPrivateRoomInviteAuthorization.ts
 *
 * Unit tests for the room-lifetime authorization model on LOCKED private
 * rooms (privateRoomsStore.ts's authorizedProfileIds). This replaced an
 * earlier, broken design where "accepted invite" and "room-lifetime access"
 * were conflated into a single one-shot grant consumed at seat-claim time —
 * that broke the moment an authorized player left their seat and tried to
 * rejoin (their authorization had already been spent). The corrected model
 * treats them as two separate concepts:
 *   1. pending invite — one-shot, consumed by accept/decline/expiry/cancel.
 *   2. authorizedProfileIds — populated once (creator at create time,
 *      invitee at accept time), NEVER removed by join or leave, and lives
 *      only as long as the room itself.
 *
 * Covers:
 *  - Accepting an invite adds the profileId to authorizedProfileIds without
 *    seating them (joinTeam is still required afterward).
 *  - join_private_room (joinTeam) on a locked room without authorization is
 *    rejected.
 *  - With authorization, joinTeam succeeds and does NOT consume/remove the
 *    authorization.
 *  - The room creator (authorized at create time, never invited) can leave
 *    and rejoin a different slot/team.
 *  - An accepted invitee can join, leave, and rejoin a different slot/team.
 *  - An unauthorized profile remains rejected even after other members
 *    join/leave repeatedly.
 *  - Declining an invite does not grant authorization.
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

const noBlocks = () => false

function createLockedRoom(store: ReturnType<typeof createPrivateRoomsStore>, hostId = 'host') {
  const created = store.createRoom({ ...makeHuman(hostId), stake: 1000, isLocked: true, waitMinutes: 15 })
  if (!created.ok) throw new Error('setup failed')
  return created.room
}

// ---------------------------------------------------------------------------
// [1] Accept grants authorization WITHOUT seating.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createLockedRoom(store)
  const invite = store.inviteFriend({ senderConnectionId: 'conn-host', toProfileId: 'profile-invitee', toDisplayName: 'Invitee' })
  if (!invite.ok) throw new Error('setup failed')

  const respond = store.respondToInvite({ inviteId: invite.invite.inviteId, profileId: 'profile-invitee', accept: true })
  check('[1] accept succeeds', respond.ok)
  check('[1b] accepted flag is true', respond.ok && respond.accepted === true)
  if (respond.ok) {
    check('[1c] invitee NOT seated by accept alone', respond.room.slots.every((s) => s.occupant === null || (s.occupant.kind === 'human' && s.occupant.profileId === 'profile-host')))
    check('[1d] invitee is now in authorizedProfileIds', respond.room.authorizedProfileIds.has('profile-invitee'))
  }
}

// ---------------------------------------------------------------------------
// [2] join_private_room on a locked room without authorization is rejected.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createLockedRoom(store)

  const result = store.joinTeam({
    privateRoomId: room.id,
    ...makeHuman('stranger'),
    team: 'B',
    slotIndex: 0,
    isBlockedWith: noBlocks,
  })
  check('[2] unauthorized join to a locked room is rejected', !result.ok)
}

// ---------------------------------------------------------------------------
// [3] With authorization, joinTeam succeeds and does NOT consume the grant.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createLockedRoom(store)
  const invite = store.inviteFriend({ senderConnectionId: 'conn-host', toProfileId: 'profile-invitee', toDisplayName: 'Invitee' })
  if (!invite.ok) throw new Error('setup failed')
  store.respondToInvite({ inviteId: invite.invite.inviteId, profileId: 'profile-invitee', accept: true })

  const joinResult = store.joinTeam({
    privateRoomId: room.id,
    ...makeHuman('invitee'),
    team: 'B',
    slotIndex: 0,
    isBlockedWith: noBlocks,
  })
  check('[3] authorized invitee successfully claims a slot', joinResult.ok)
  check('[3b] authorization is NOT consumed by the join', joinResult.ok && joinResult.room.authorizedProfileIds.has('profile-invitee'))
}

// ---------------------------------------------------------------------------
// [4] Locked-room creator: leave -> still authorized -> rejoin a different
// slot/team succeeds.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createLockedRoom(store) // host authorized at create time (never invited)
  // A second, separately-invited-and-accepted human keeps the room alive
  // after the host leaves (locked rooms require authorization to join).
  const otherInvite = store.inviteFriend({ senderConnectionId: 'conn-host', toProfileId: 'profile-other', toDisplayName: 'Other' })
  if (!otherInvite.ok) throw new Error('setup failed')
  store.respondToInvite({ inviteId: otherInvite.invite.inviteId, profileId: 'profile-other', accept: true })
  const otherJoin = store.joinTeam({ privateRoomId: room.id, ...makeHuman('other'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  if (!otherJoin.ok) throw new Error('setup failed')

  store.leaveRoom('conn-host')
  const roomAfterLeave = store.getRoomByConnectionId('conn-other')
  check('[4] room survives host leave (other player remains)', roomAfterLeave !== null)
  check('[4b] host profileId is still authorized after leaving', roomAfterLeave !== null && roomAfterLeave.authorizedProfileIds.has('profile-host'))

  const rejoin = store.joinTeam({
    privateRoomId: roomAfterLeave!.id,
    ...makeHuman('host'),
    team: 'B', // deliberately a DIFFERENT team than their original A0
    slotIndex: 1,
    isBlockedWith: noBlocks,
  })
  check('[4c] the creator can rejoin a different slot/team after leaving', rejoin.ok)
}

// ---------------------------------------------------------------------------
// [5] Accepted invitee: join -> leave -> rejoin a different slot/team.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createLockedRoom(store)
  const invite = store.inviteFriend({ senderConnectionId: 'conn-host', toProfileId: 'profile-invitee', toDisplayName: 'Invitee' })
  if (!invite.ok) throw new Error('setup failed')
  store.respondToInvite({ inviteId: invite.invite.inviteId, profileId: 'profile-invitee', accept: true })
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('invitee'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })

  store.leaveRoom('conn-invitee')
  const rejoin = store.joinTeam({
    privateRoomId: room.id,
    ...makeHuman('invitee'),
    team: 'A', // different team than their first B,0 choice
    slotIndex: 1,
    isBlockedWith: noBlocks,
  })
  check('[5] accepted invitee can rejoin a different slot/team after leaving', rejoin.ok)
}

// ---------------------------------------------------------------------------
// [6] Unauthorized profile stays rejected even after other join/leave churn.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createLockedRoom(store)
  const invite = store.inviteFriend({ senderConnectionId: 'conn-host', toProfileId: 'profile-invitee', toDisplayName: 'Invitee' })
  if (!invite.ok) throw new Error('setup failed')
  store.respondToInvite({ inviteId: invite.invite.inviteId, profileId: 'profile-invitee', accept: true })
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('invitee'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  store.leaveRoom('conn-invitee')
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('invitee'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })

  const strangerAttempt = store.joinTeam({
    privateRoomId: room.id,
    ...makeHuman('stranger'),
    team: 'B',
    slotIndex: 1,
    isBlockedWith: noBlocks,
  })
  check('[6] a never-invited stranger is still rejected after churn', !strangerAttempt.ok)
}

// ---------------------------------------------------------------------------
// [7] Declining an invite grants no authorization.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createLockedRoom(store)
  const invite = store.inviteFriend({ senderConnectionId: 'conn-host', toProfileId: 'profile-decliner', toDisplayName: 'Decliner' })
  if (!invite.ok) throw new Error('setup failed')

  const decline = store.respondToInvite({ inviteId: invite.invite.inviteId, profileId: 'profile-decliner', accept: false })
  check('[7] decline succeeds', decline.ok)
  check('[7b] decline does not grant authorization', decline.ok && !decline.room.authorizedProfileIds.has('profile-decliner'))

  const joinAttempt = store.joinTeam({
    privateRoomId: room.id,
    ...makeHuman('decliner'),
    team: 'B',
    slotIndex: 0,
    isBlockedWith: noBlocks,
  })
  check('[7c] the decliner cannot join afterward either', !joinAttempt.ok)
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
