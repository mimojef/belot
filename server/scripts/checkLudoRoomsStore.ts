import { strict as assert } from 'node:assert'
import { createLudoRoomsStore, type LudoRoom } from '../src/game/ludoRoomsStore.js'

const started: LudoRoom[] = []
const kicked: string[] = []
const store = createLudoRoomsStore({
  onRoomsChanged: () => {},
  onRoomReady: (room) => started.push(room),
  onMemberKicked: (_room, player) => kicked.push(player.profileId),
})

let serial = 0
const player = () => {
  serial += 1
  return { connectionId: `c${serial}`, profileId: `p${serial}`, displayName: `Player ${serial}`, avatarUrl: null }
}

function create(playerCount: 2 | 4, manualStart: boolean) {
  const host = player()
  const result = store.createRoom({ ...host, stake: 100, playerCount, manualStart })
  assert.equal(result.ok, true)
  return { host, room: result.ok ? result.room : null! }
}

{
  const { room } = create(2, false)
  const guest = player()
  const result = store.joinRoom({ roomId: room.id, ...guest })
  assert.equal(result.ok && result.started, true, '2-player auto-start')
  assert.equal(store.listRooms().some((item) => item.id === room.id), false, 'started room disappears')
}

{
  const { room } = create(4, false)
  for (let index = 0; index < 3; index += 1) {
    const guest = player()
    const result = store.joinRoom({ roomId: room.id, ...guest })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.started, index === 2, '4-player auto-start only when full')
  }
}

for (const playerCount of [2, 4] as const) {
  const { host, room } = create(playerCount, true)
  const early = store.startRoom(host.connectionId)
  assert.equal(early.ok, false, 'manual start rejects incomplete room')
  while (room.players.length < playerCount) {
    const guest = player()
    const joined = store.joinRoom({ roomId: room.id, ...guest })
    assert.equal(joined.ok && !joined.started, true, 'manual room remains waiting when full')
  }
  assert.equal(store.startRoom(room.players[1]!.connectionId).ok, false, 'non-host cannot start')
  assert.equal(store.startRoom(host.connectionId).ok, true, `${playerCount}-player manual start`)
}

{
  const { host, room } = create(4, true)
  const guest = player()
  assert.equal(store.joinRoom({ roomId: room.id, ...guest }).ok, true, 'join through room id')
  assert.equal(store.joinRoom({ roomId: room.id, ...guest }).ok, false, 'duplicate join rejected')
  assert.equal(store.kickMember(guest.connectionId, host.profileId).ok, false, 'non-host cannot kick')
  assert.equal(store.kickMember(host.connectionId, host.profileId).ok, false, 'host cannot kick self')
  assert.equal(store.kickMember(host.connectionId, guest.profileId).ok, true, 'creator kick')
  assert.deepEqual(kicked.at(-1), guest.profileId)
}

{
  const { room } = create(2, true)
  const guest = player()
  assert.equal(store.joinRoom({ roomId: room.id, ...guest }).ok, true)
  const extra = player()
  assert.equal(store.joinRoom({ roomId: room.id, ...extra }).ok, false, 'full room rejected')
}

{
  const { host, room } = create(2, true)
  assert.equal(store.leaveRoom(host.connectionId), null, 'A: lone creator leave tears down room')
  assert.equal(store.listRooms().some((item) => item.id === room.id), false, 'A: torn-down room no longer exists')
  assert.equal(store.leaveRoom(host.connectionId), null, 'A: duplicate leave is idempotent')
  assert.equal(store.createRoom({ ...host, connectionId: `${host.connectionId}-again`, stake: 100, playerCount: 2, manualStart: true }).ok, true, 'D: creator can immediately create again')
}

{
  const { host, room } = create(4, true)
  const guest = player()
  assert.equal(store.joinRoom({ roomId: room.id, ...guest }).ok, true)
  const remaining = store.leaveRoom(guest.connectionId)
  assert.equal(remaining?.players.length, 1, 'B: guest leave frees their seat')
  assert.equal(remaining?.players[0]?.profileId, host.profileId, 'B: creator remains in room')
  assert.equal(store.joinRoom({ roomId: room.id, ...guest, connectionId: `${guest.connectionId}-again` }).ok, true, 'D: guest can immediately rejoin')
}

{
  const { host, room } = create(4, true)
  const guest = player()
  assert.equal(store.joinRoom({ roomId: room.id, ...guest }).ok, true)
  const remaining = store.leaveRoom(host.connectionId)
  assert.equal(remaining?.hostProfileId, guest.profileId, 'C: creator leave transfers host to first waiting player')
  assert.equal(remaining?.players.length, 1, 'C: creator is removed while waiting guest remains')
}

assert.equal(started.filter((room) => room.playerCount === 2).length >= 2, true)
assert.equal(started.filter((room) => room.playerCount === 4).length >= 2, true)
console.log('PASS Ludo room lifecycle: 2/4 auto, 2/4 manual, join, duplicate/full, kick permissions, start removal')
