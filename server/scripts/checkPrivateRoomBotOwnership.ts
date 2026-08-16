/**
 * checkPrivateRoomBotOwnership.ts
 *
 * Replaces checkPrivateRoomBotFillGating.ts — the old single "Запълни с
 * ботове" host-only, whole-table beginBotFill() is gone, replaced by
 * per-team addBotToTeam()/removeBotFromTeam(), owned by whichever human is
 * currently seated in that specific team (host has no special privilege
 * over bots at all anymore).
 *
 * Covers:
 *  - A team with exactly 1 human + 1 empty slot: that human can add a bot.
 *  - A team with exactly 1 human + 1 bot: that human can remove the bot.
 *  - A team with 2 humans: bot add is rejected ('private_room_team_full').
 *  - A team with 0 humans: bot add by anyone (including a human seated in
 *    the OTHER team) is rejected ('private_room_bot_owner_missing').
 *  - A human in Team A cannot add/remove a bot in Team B, and vice versa.
 *  - Double-add (bot already present) and double-remove (no bot present)
 *    both fail cleanly, not silently/duplicating.
 *  - Removing a bot restores the slot to a claimable "+" (occupant: null).
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
// [1] 1 human + 1 empty -> that human can add a bot.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  const result = store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBotOccupant('1'), isBlockedWith: noBlocks })
  check('[1] sole team human can add a bot into the empty slot', result.ok)
}

// ---------------------------------------------------------------------------
// [2] 1 human + 1 bot -> that human can remove the bot.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBotOccupant('1'), isBlockedWith: noBlocks })
  const result = store.removeBotFromTeam({ connectionId: 'conn-host', team: 'A' })
  check('[2] bot owner can remove their bot', result.ok)
  if (result.ok) {
    const slotA1 = result.room.slots.find((s) => s.team === 'A' && s.slotIndex === 1)!
    check('[2b] slot restored to "+" (occupant: null)', slotA1.occupant === null)
  }
}

// ---------------------------------------------------------------------------
// [3] 2 humans on a team -> bot add rejected (team full).
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('partner'), team: 'A', slotIndex: 1, isBlockedWith: noBlocks })

  const result = store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBotOccupant('1'), isBlockedWith: noBlocks })
  check('[3] a full-human team rejects bot add', !result.ok)
  check('[3b] error code is private_room_team_full', !result.ok && result.code === 'private_room_team_full')
}

// ---------------------------------------------------------------------------
// [4] 0 humans in the target team -> rejected, even from a human in the
// OTHER team.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store) // host is in Team A; Team B has 0 humans

  const result = store.addBotToTeam({ connectionId: 'conn-host', team: 'B', botOccupant: makeBotOccupant('1'), isBlockedWith: noBlocks })
  check('[4] a human cannot add a bot into a team they are not seated in', !result.ok)
  check('[4b] error code is private_room_bot_owner_missing', !result.ok && result.code === 'private_room_bot_owner_missing')
}

// ---------------------------------------------------------------------------
// [5] Team A human cannot add/remove a bot in Team B, and vice versa.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('b0'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })

  const crossAdd = store.addBotToTeam({ connectionId: 'conn-host', team: 'B', botOccupant: makeBotOccupant('1'), isBlockedWith: noBlocks })
  check('[5] Team A human cannot add a bot to Team B (which has its own human)', !crossAdd.ok)

  store.addBotToTeam({ connectionId: 'conn-b0', team: 'B', botOccupant: makeBotOccupant('2'), isBlockedWith: noBlocks })
  const crossRemove = store.removeBotFromTeam({ connectionId: 'conn-host', team: 'B' })
  check('[5b] Team A human cannot remove Team B\'s bot', !crossRemove.ok)
}

// ---------------------------------------------------------------------------
// [6] Double-add and double-remove both fail cleanly.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)

  const firstAdd = store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBotOccupant('1'), isBlockedWith: noBlocks })
  const secondAdd = store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBotOccupant('2'), isBlockedWith: noBlocks })
  check('[6] first add succeeds', firstAdd.ok)
  check('[6b] second add on an already-bot-filled team fails (not two bots)', !secondAdd.ok)

  store.removeBotFromTeam({ connectionId: 'conn-host', team: 'A' })
  const secondRemove = store.removeBotFromTeam({ connectionId: 'conn-host', team: 'A' })
  check('[6c] removing an already-empty slot fails cleanly (no crash, no-op)', !secondRemove.ok)
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
