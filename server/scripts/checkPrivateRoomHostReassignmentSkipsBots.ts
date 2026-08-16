/**
 * checkPrivateRoomHostReassignmentSkipsBots.ts
 *
 * Unit test for privateRoomsStore.ts's leaveRoom() host-reassignment logic.
 * When the departing connection was host, the new host must be the first
 * HUMAN occupant in the fixed A0->A1->B0->B1 scan order — never a bot, even
 * if a bot happens to occupy an earlier slot than the next human.
 *
 * Scenario: Team A ends up as {A0: bot, A1: human}, built via a bot-fill
 * that landed in A0 specifically (because the human in that team had chosen
 * slot A1). The current host is a *different* human, seated in Team B, who
 * then leaves. Orphan-bot cleanup only touches the LEAVER's own team (Team
 * B, which has no bot), so Team A's {bot@A0, human@A1} survives the leave
 * completely untouched — exercising exactly the "skip earlier-slot bot"
 * path in host reassignment, not the orphan-cleanup path.
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

{
  const { store } = createTrackedStore()

  // 1) alice creates the room -> A0, initial host.
  const created = store.createRoom({ ...makeHuman('alice'), stake: 1000, isLocked: false, waitMinutes: 15 })
  if (!created.ok) throw new Error('setup failed')

  // 2) bob joins Team B, slot 0.
  const bobJoin = store.joinTeam({ privateRoomId: created.room.id, ...makeHuman('bob'), team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  if (!bobJoin.ok) throw new Error('setup failed')

  // 3) alice (host) leaves -> only bob remains -> bob becomes host, Team A empty.
  store.leaveRoom('conn-alice')
  const afterAliceLeft = store.getRoomByConnectionId('conn-bob')
  check('[setup] bob is host after alice leaves', afterAliceLeft?.hostConnectionId === 'conn-bob')

  // 4) carol joins Team A, slot 1 (deliberately NOT slot 0).
  const carolJoin = store.joinTeam({ privateRoomId: afterAliceLeft!.id, ...makeHuman('carol'), team: 'A', slotIndex: 1, isBlockedWith: noBlocks })
  if (!carolJoin.ok) throw new Error('setup failed')

  // 5) carol adds a bot to Team A -> the only free slot there is A0.
  const addBot = store.addBotToTeam({ connectionId: 'conn-carol', team: 'A', botOccupant: makeBotOccupant('1'), isBlockedWith: noBlocks })
  if (!addBot.ok) throw new Error('setup failed')
  const slotA0 = addBot.room.slots.find((s) => s.team === 'A' && s.slotIndex === 0)!
  const slotA1 = addBot.room.slots.find((s) => s.team === 'A' && s.slotIndex === 1)!
  check('[setup] bot landed at A0 (earlier scan position than the human at A1)', slotA0.occupant?.kind === 'bot')
  check('[setup] carol (human) is at A1', slotA1.occupant?.kind === 'human' && slotA1.occupant.profileId === 'profile-carol')
  check('[setup] bob (host) is still in Team B, untouched by the bot-add', addBot.room.hostConnectionId === 'conn-bob')

  // 6) THE TEST: bob (host, Team B) leaves. Team A's {bot@A0, carol@A1} must
  // survive untouched (orphan cleanup only applies to bob's own team), and
  // the new host must be carol — never the bot at A0.
  store.leaveRoom('conn-bob')
  const finalRoom = store.getRoomByConnectionId('conn-carol')

  check('[6] room survives (carol remains)', finalRoom !== null)
  if (finalRoom !== null) {
    const finalSlotA0 = finalRoom.slots.find((s) => s.team === 'A' && s.slotIndex === 0)!
    check('[6b] the bot at A0 is untouched (Team B leave does not orphan-clean Team A)', finalSlotA0.occupant?.kind === 'bot')
    check('[6c] new host is carol, NOT the bot', finalRoom.hostProfileId === 'profile-carol')
    check('[6d] new host connectionId is carol\'s, NOT undefined/bot-derived', finalRoom.hostConnectionId === 'conn-carol')
  }
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
