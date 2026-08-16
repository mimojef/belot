/**
 * checkPrivateRoomStartValidation.ts
 *
 * Unit tests for privateRoomsStore.ts's evaluateRoomReadiness() — the final
 * server-authoritative gate before a private table transitions from waiting
 * room to a live game. Exercises the pure function directly with hand-built
 * PrivateRoom fixtures (mirrors resolveMatchmakingSeats.ts's exported-pure-
 * function test style).
 *
 * Covers:
 *  - A fully valid 4/4 room (2 humans per team, no blocks) is ready.
 *  - A block between two humans on the SAME team (partners) blocks the
 *    start, reporting the correct blockedTeam.
 *  - A block between humans on DIFFERENT teams (opponents) does NOT block
 *    the start — only partner blocks matter.
 *  - A "late" block — the two partners had no block relationship when they
 *    joined, but one toggled a block afterward — is still caught here, since
 *    isBlockedWith is evaluated against live state at call time.
 *  - Duplicate bot profileId across the two teams is rejected defensively
 *    (reason: 'duplicate_bot_identity'), even though addBotToTeam's
 *    excludedProfileIds is supposed to make this unreachable in practice.
 */

import {
  evaluateRoomReadiness,
  type PrivateRoom,
  type PrivateRoomBotOccupant,
  type PrivateRoomHumanOccupant,
  type PrivateRoomSlots,
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

function human(id: string): PrivateRoomHumanOccupant {
  return {
    kind: 'human',
    connectionId: `conn-${id}`,
    profileId: `profile-${id}`,
    displayName: `Player ${id}`,
    avatarUrl: null,
    level: 5,
    rankTitle: null,
  }
}

function bot(id: string): PrivateRoomBotOccupant {
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

// botProfileId deliberately omitted (it is an optional field on the type) —
// exercises evaluateRoomReadiness's fallback to identity.profileId, and its
// conservative sentinel when even that is null.
function botWithoutProfileId(displayName: string, identityProfileId: string | null): PrivateRoomBotOccupant {
  return {
    kind: 'bot',
    botCode: 'CATALOG_BOT',
    difficulty: 'normal',
    identity: {
      accountId: null,
      profileId: identityProfileId,
      username: null,
      displayName,
      avatarUrl: null,
      level: 7,
      rankTitle: 'Новак',
      skillRating: 1000,
      gender: null,
    },
  }
}

function buildRoom(occupants: {
  a0: PrivateRoomHumanOccupant | PrivateRoomBotOccupant | null
  a1: PrivateRoomHumanOccupant | PrivateRoomBotOccupant | null
  b0: PrivateRoomHumanOccupant | PrivateRoomBotOccupant | null
  b1: PrivateRoomHumanOccupant | PrivateRoomBotOccupant | null
}): PrivateRoom {
  const slots: PrivateRoomSlots = [
    { team: 'A', slotIndex: 0, occupant: occupants.a0 },
    { team: 'A', slotIndex: 1, occupant: occupants.a1 },
    { team: 'B', slotIndex: 0, occupant: occupants.b0 },
    { team: 'B', slotIndex: 1, occupant: occupants.b1 },
  ]
  return {
    id: 'room-1',
    kind: 'open',
    stake: 1000,
    hostProfileId: 'profile-a0',
    hostConnectionId: 'conn-a0',
    slots,
    pendingInvites: [],
    authorizedProfileIds: new Set(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60000,
  }
}

const noBlocks = () => false

// ---------------------------------------------------------------------------
// [1] Fully valid 4/4 room, no blocks -> ready.
// ---------------------------------------------------------------------------
{
  const room = buildRoom({ a0: human('a0'), a1: human('a1'), b0: human('b0'), b1: human('b1') })
  const readiness = evaluateRoomReadiness(room, noBlocks)
  check('[1] 4 humans, no blocks -> ready', readiness.ready === true)
}

// ---------------------------------------------------------------------------
// [2] Block between Team A partners -> blocked, correct team reported.
// ---------------------------------------------------------------------------
{
  const room = buildRoom({ a0: human('a0'), a1: human('a1'), b0: human('b0'), b1: human('b1') })
  const isBlockedWith = (x: string, y: string) =>
    (x === 'profile-a0' && y === 'profile-a1') || (x === 'profile-a1' && y === 'profile-a0')
  const readiness = evaluateRoomReadiness(room, isBlockedWith)
  check('[2] Team A partner block -> not ready', readiness.ready === false)
  check(
    '[2b] blockedTeam is A',
    !readiness.ready && readiness.reason === 'blocked_partnership' && readiness.blockedTeam === 'A',
  )
}

// ---------------------------------------------------------------------------
// [3] Block between opponents (different teams) -> does NOT block the start.
// ---------------------------------------------------------------------------
{
  const room = buildRoom({ a0: human('a0'), a1: human('a1'), b0: human('b0'), b1: human('b1') })
  const isBlockedWith = (x: string, y: string) =>
    (x === 'profile-a0' && y === 'profile-b0') || (x === 'profile-b0' && y === 'profile-a0')
  const readiness = evaluateRoomReadiness(room, isBlockedWith)
  check('[3] opponent block does not prevent start', readiness.ready === true)
}

// ---------------------------------------------------------------------------
// [4] Late block: partners had no block relationship when they joined, but
// one toggled a block afterward -> still caught at final evaluation, since
// isBlockedWith reflects live state, not a stale snapshot.
// ---------------------------------------------------------------------------
{
  const room = buildRoom({ a0: human('a0'), a1: human('a1'), b0: human('b0'), b1: human('b1') })
  let blockedPairs: Array<[string, string]> = [] // empty when A-team partners joined
  const isBlockedWith = (x: string, y: string) => blockedPairs.some(([p, q]) => p === x && q === y)

  const readinessBeforeBlock = evaluateRoomReadiness(room, isBlockedWith)
  check('[4] before the late block, room is ready', readinessBeforeBlock.ready === true)

  blockedPairs = [['profile-b1', 'profile-b0']] // Team B partner blocks after the fact
  const readinessAfterBlock = evaluateRoomReadiness(room, isBlockedWith)
  check('[4b] after the late block, room is no longer ready', readinessAfterBlock.ready === false)
  check(
    '[4c] blockedTeam is B',
    !readinessAfterBlock.ready && readinessAfterBlock.reason === 'blocked_partnership' && readinessAfterBlock.blockedTeam === 'B',
  )
}

// ---------------------------------------------------------------------------
// [5] Duplicate bot profileId across teams -> rejected defensively.
// ---------------------------------------------------------------------------
{
  const room = buildRoom({ a0: human('a0'), a1: bot('shared'), b0: human('b0'), b1: bot('shared') })
  const readiness = evaluateRoomReadiness(room, noBlocks)
  check('[5] duplicate bot identity across teams -> not ready', readiness.ready === false)
  check('[5b] reason is duplicate_bot_identity', !readiness.ready && readiness.reason === 'duplicate_bot_identity')
}

// ---------------------------------------------------------------------------
// [6] Distinct bots on each team are fine.
// ---------------------------------------------------------------------------
{
  const room = buildRoom({ a0: human('a0'), a1: bot('team-a-bot'), b0: human('b0'), b1: bot('team-b-bot') })
  const readiness = evaluateRoomReadiness(room, noBlocks)
  check('[6] distinct bot identities per team -> ready', readiness.ready === true)
}

// ---------------------------------------------------------------------------
// [7] botProfileId absent on both bots: falls back to identity.profileId —
// distinct identity.profileId values are correctly NOT flagged as duplicate.
// ---------------------------------------------------------------------------
{
  const room = buildRoom({
    a0: human('a0'),
    a1: botWithoutProfileId('Bot Alpha', 'identity-alpha'),
    b0: human('b0'),
    b1: botWithoutProfileId('Bot Beta', 'identity-beta'),
  })
  const readiness = evaluateRoomReadiness(room, noBlocks)
  check('[7] no botProfileId, distinct identity.profileId -> ready (correct fallback)', readiness.ready === true)
}

// ---------------------------------------------------------------------------
// [8] botProfileId AND identity.profileId both absent on two bots: no
// stable identifier exists for either, so they are conservatively treated
// as a duplicate rather than silently exempted from the check.
// ---------------------------------------------------------------------------
{
  const room = buildRoom({
    a0: human('a0'),
    a1: botWithoutProfileId('Bot Alpha', null),
    b0: human('b0'),
    b1: botWithoutProfileId('Bot Beta', null),
  })
  const readiness = evaluateRoomReadiness(room, noBlocks)
  check('[8] no botProfileId and no identity.profileId on either bot -> not ready (conservative)', readiness.ready === false)
  check('[8b] reason is duplicate_bot_identity', !readiness.ready && readiness.reason === 'duplicate_bot_identity')
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
