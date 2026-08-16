/**
 * checkPrivateRoomBotIdentityUniqueness.ts
 *
 * Unit tests for bot identity uniqueness when Team A and Team B add bots
 * independently (at different times, via separate add_bot_to_private_room_team
 * calls — unlike the old single "Запълни с ботове" call that always selected
 * all needed bots in one shot with an inherently-distinct batch).
 *
 * Scope note: the actual exclusion-list wiring (index.ts's
 * 'add_bot_to_private_room_team' handler collecting already-seated bot
 * profileIds and passing them as selectMatchmakingBotProfiles's
 * excludedProfileIds) lives above this pure in-memory store and is not
 * re-tested here — it's mechanical, and selectMatchmakingBotProfiles already
 * has its own excludedProfileIds contract. What IS tested here, at the store
 * level, is the guarantee that actually matters operationally: whatever bot
 * identities addBotToTeam is given, evaluateRoomReadiness (wired into both
 * joinTeam and addBotToTeam) is the final gate that would catch a duplicate
 * if the exclusion logic upstream ever had a bug.
 *
 * Covers:
 *  - Team A bot, then Team B bot with a DIFFERENT botProfileId -> room
 *    completes and starts normally.
 *  - Team A bot, then Team B bot with the SAME botProfileId (simulating an
 *    upstream exclusion-list bug) -> the room reaches 4/4 but is rejected
 *    from starting, with the duplicate caught by evaluateRoomReadiness.
 *  - botProfileId is an OPTIONAL field on PrivateRoomBotOccupant (mirrors
 *    BotRoomParticipant.botProfileId in serverTypes.ts). Today's one real
 *    caller (index.ts's add_bot_to_private_room_team handler) always
 *    populates it from selectMatchmakingBotProfiles(), whose DB/catalog and
 *    temp-bot paths all produce a non-null value — but evaluateRoomReadiness
 *    is a defensive last gate and must not silently exempt bots without a
 *    botProfileId from the duplicate check. These cases prove the
 *    identity.profileId fallback (and the conservative "both missing"
 *    sentinel) work correctly even when botProfileId itself is absent.
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

function makeBotOccupant(botProfileId: string): PrivateRoomBotOccupant {
  return {
    kind: 'bot',
    botProfileId,
    botCode: 'CATALOG_BOT',
    difficulty: 'normal',
    identity: {
      accountId: null,
      profileId: botProfileId,
      username: null,
      displayName: `Bot ${botProfileId}`,
      avatarUrl: null,
      level: 7,
      rankTitle: 'Новак',
      skillRating: 1000,
      gender: null,
    },
  }
}

// botProfileId deliberately omitted — simulates a bot occupant constructed
// without that optional field. identityProfileId controls the fallback
// identifier (identity.profileId); pass null to simulate the pathological
// "no stable identifier at all" case.
function makeBotOccupantWithoutProfileId(displayName: string, identityProfileId: string | null): PrivateRoomBotOccupant {
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

const noBlocks = () => false

function createOpenRoom(store: ReturnType<typeof createPrivateRoomsStore>, hostId = 'host') {
  const created = store.createRoom({ ...makeHuman(hostId), stake: 1000, isLocked: false, waitMinutes: 15 })
  if (!created.ok) throw new Error('setup failed')
  return created.room
}

// ---------------------------------------------------------------------------
// [1] Distinct bot identities across teams -> room completes and starts.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('b0'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })

  const addA = store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBotOccupant('bot-alpha'), isBlockedWith: noBlocks })
  check('[1] Team A bot add succeeds', addA.ok)

  events.length = 0
  const addB = store.addBotToTeam({ connectionId: 'conn-b0', team: 'B', botOccupant: makeBotOccupant('bot-beta'), isBlockedWith: noBlocks })
  check('[1b] Team B bot add (distinct identity) completes the room and starts it', addB.ok && addB.readyToStart === true)
  check('[1c] roomReady fired for the valid 4/4 room', events.includes('roomReady'))
}

// ---------------------------------------------------------------------------
// [2] SAME bot identity on both teams (simulated exclusion-list failure) ->
// room reaches 4/4 but evaluateRoomReadiness rejects the start.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('b0'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })

  const addA = store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBotOccupant('bot-shared'), isBlockedWith: noBlocks })
  check('[2] Team A bot add succeeds', addA.ok)

  events.length = 0
  const addB = store.addBotToTeam({ connectionId: 'conn-b0', team: 'B', botOccupant: makeBotOccupant('bot-shared'), isBlockedWith: noBlocks })
  check('[2b] Team B bot add with the SAME identity still succeeds as a seat-claim', addB.ok)
  check('[2c] but the room is NOT allowed to start', addB.ok && addB.readyToStart === false)
  check(
    '[2d] readiness reports duplicate_bot_identity',
    addB.ok && addB.readiness !== undefined && !addB.readiness.ready && addB.readiness.reason === 'duplicate_bot_identity',
  )
  check('[2e] roomReady never fired for the duplicate-bot room', !events.includes('roomReady'))
  check('[2f] room stays live (not silently started with a broken bot pair)', store.listRooms().some((r) => r.id === room.id))
}

// ---------------------------------------------------------------------------
// [3] Both bots missing botProfileId, but DISTINCT identity.profileId ->
// the fallback identifier correctly tells them apart; room starts.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('b0'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })

  const addA = store.addBotToTeam({
    connectionId: 'conn-host',
    team: 'A',
    botOccupant: makeBotOccupantWithoutProfileId('Bot Alpha', 'identity-alpha'),
    isBlockedWith: noBlocks,
  })
  check('[3] Team A bot add (no botProfileId, distinct identity.profileId) succeeds', addA.ok)

  events.length = 0
  const addB = store.addBotToTeam({
    connectionId: 'conn-b0',
    team: 'B',
    botOccupant: makeBotOccupantWithoutProfileId('Bot Beta', 'identity-beta'),
    isBlockedWith: noBlocks,
  })
  check('[3b] Team B bot add (no botProfileId, distinct identity.profileId) completes and starts the room', addB.ok && addB.readyToStart === true)
  check('[3c] roomReady fired — distinct identity.profileId fallback correctly proved uniqueness', events.includes('roomReady'))
}

// ---------------------------------------------------------------------------
// [4] Both bots missing botProfileId AND identity.profileId (no stable
// identifier at all) -> treated conservatively as a duplicate, room refuses
// to start rather than risk two indistinguishable bot participants.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('b0'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })

  const addA = store.addBotToTeam({
    connectionId: 'conn-host',
    team: 'A',
    botOccupant: makeBotOccupantWithoutProfileId('Bot Alpha', null),
    isBlockedWith: noBlocks,
  })
  check('[4] Team A bot add (no identifiers at all) still succeeds as a seat-claim', addA.ok)

  events.length = 0
  const addB = store.addBotToTeam({
    connectionId: 'conn-b0',
    team: 'B',
    botOccupant: makeBotOccupantWithoutProfileId('Bot Beta', null),
    isBlockedWith: noBlocks,
  })
  check('[4b] Team B bot add (no identifiers at all) still succeeds as a seat-claim', addB.ok)
  check('[4c] but the room is NOT allowed to start (cannot prove the two bots are distinct)', addB.ok && addB.readyToStart === false)
  check(
    '[4d] readiness reports duplicate_bot_identity for the identifier-less pair',
    addB.ok && addB.readiness !== undefined && !addB.readiness.ready && addB.readiness.reason === 'duplicate_bot_identity',
  )
  check('[4e] roomReady never fired', !events.includes('roomReady'))
}

// ---------------------------------------------------------------------------
// [5] Mixed: one bot has botProfileId, the other has none but a distinct
// identity.profileId -> no false-positive cross-field collision.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('b0'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })

  const addA = store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBotOccupant('bot-gamma'), isBlockedWith: noBlocks })
  check('[5] Team A bot add (with botProfileId) succeeds', addA.ok)

  events.length = 0
  const addB = store.addBotToTeam({
    connectionId: 'conn-b0',
    team: 'B',
    botOccupant: makeBotOccupantWithoutProfileId('Bot Delta', 'identity-delta'),
    isBlockedWith: noBlocks,
  })
  check('[5b] Team B bot add (no botProfileId, distinct identity.profileId) completes and starts the room', addB.ok && addB.readyToStart === true)
  check('[5c] roomReady fired — no false-positive collision between the two identifier schemes', events.includes('roomReady'))
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
