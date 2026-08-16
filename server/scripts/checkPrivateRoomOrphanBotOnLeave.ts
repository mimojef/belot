/**
 * checkPrivateRoomOrphanBotOnLeave.ts
 *
 * Unit tests for privateRoomsStore.ts's leaveRoom() orphan-bot cleanup: a
 * bot can never be left without its owning human in the same team.
 *
 * Covers:
 *  - Human leaves a team that also has a bot partner -> the bot is removed
 *    too; the team ends up fully empty ("+", "+"), never an orphaned bot.
 *  - A team with 2 humans, one leaves -> the other stays seated, and that
 *    team now has exactly 1 human + 1 empty slot (bot-fill would become
 *    available again).
 *  - The last human overall leaving deletes the room entirely.
 *  - Leaving a team that has no bot partner does not touch the other team.
 */

import { createPrivateRoomsStore, getTeamHumanCount, type PrivateRoomBotOccupant } from '../src/game/privateRoomsStore.js'

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
    behaviorPreset: 'balanced',
    logicSource: 'existing-core-v1',
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
// [1] Human leaves, bot partner is auto-removed too.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)

  const addBot = store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBotOccupant('1'), isBlockedWith: noBlocks })
  check('[1] bot added to host\'s team', addBot.ok)

  store.leaveRoom('conn-host')
  const roomAfter = store.getRoomByProfileId('profile-host')
  check('[1b] room no longer resolvable by the departed host\'s profileId', roomAfter === null)

  // Room still exists only if someone else is present — here it does not,
  // since host+bot were the only occupants, so the room is fully deleted.
  const stillListed = store.listRooms()
  check('[1c] room with only a human+bot pair is deleted once the human leaves', stillListed.length === 0)
}

// ---------------------------------------------------------------------------
// [2] Team has human+bot, ANOTHER human is present elsewhere in the room ->
// the bot is still cleaned up, room survives, team becomes fully empty.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('guest'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  store.addBotToTeam({ connectionId: 'conn-host', team: 'A', botOccupant: makeBotOccupant('1'), isBlockedWith: noBlocks })

  store.leaveRoom('conn-host')
  const roomAfter = store.getRoomByConnectionId('conn-guest')
  check('[2] room survives (guest remains)', roomAfter !== null)
  if (roomAfter !== null) {
    const teamASlots = roomAfter.slots.filter((s) => s.team === 'A')
    check('[2b] Team A is fully empty (bot removed alongside the leaving human)', teamASlots.every((s) => s.occupant === null))
    check('[2c] Team B (guest) untouched', getTeamHumanCount(roomAfter, 'B') === 1)
  }
}

// ---------------------------------------------------------------------------
// [3] Team has 2 humans, one leaves -> the other stays, team now has exactly
// 1 human + 1 empty slot.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('partner'), team: 'A', slotIndex: 1, isBlockedWith: noBlocks })

  store.leaveRoom('conn-host')
  const roomAfter = store.getRoomByConnectionId('conn-partner')
  check('[3] room survives (partner remains)', roomAfter !== null)
  if (roomAfter !== null) {
    check('[3b] Team A now has exactly 1 human', getTeamHumanCount(roomAfter, 'A') === 1)
    const emptySlot = roomAfter.slots.find((s) => s.team === 'A' && s.occupant === null)
    check('[3c] Team A has exactly 1 empty slot (bot-fill becomes available again)', emptySlot !== undefined)
  }
}

// ---------------------------------------------------------------------------
// [4] Last human overall leaving deletes the room entirely.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const room = createOpenRoom(store)

  events.length = 0
  store.leaveRoom('conn-host')
  check('[4] room deleted after the only human leaves', store.listRooms().length === 0)
  check('[4b] onRoomsChanged fired', events.includes('roomsChanged'))
  check('[4c] onMemberLeft did NOT fire for the delete-whole-room path (no one left to notify)', !events.includes('memberLeft'))
}

// ---------------------------------------------------------------------------
// [5] Leaving a team with no bot partner does not touch the other team.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const room = createOpenRoom(store)
  store.joinTeam({ privateRoomId: room.id, ...makeHuman('guest'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  store.addBotToTeam({ connectionId: 'conn-guest', team: 'B', botOccupant: makeBotOccupant('2'), isBlockedWith: noBlocks })

  store.leaveRoom('conn-host') // Team A has no bot — Team B (guest + bot) must survive untouched
  const roomAfter = store.getRoomByConnectionId('conn-guest')
  check('[5] room survives (guest + their bot remain)', roomAfter !== null)
  if (roomAfter !== null) {
    const teamBBot = roomAfter.slots.find((s) => s.team === 'B' && s.occupant?.kind === 'bot')
    check('[5b] Team B\'s bot is untouched by an unrelated Team A leave', teamBBot !== undefined)
  }
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
