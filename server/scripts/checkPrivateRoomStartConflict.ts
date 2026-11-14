/**
 * checkPrivateRoomStartConflict.ts — „Едно Белот участие“, проверката
 * непосредствено преди старт на частна маса (privateRoomsStore): участник,
 * който вече е в друг активен мач, НЕ влиза в новата игра — мястото му се
 * освобождава през същия leaveRoom път (orphan-бот, известия), масата остава
 * да чака. Реалният store, фалшиви callback-и.
 *
 *   [K1] автоматичен старт: зает участник -> без старт, мястото му е свободно;
 *   [K2] заетият има бот партньор -> и ботът излиза (orphan cleanup);
 *   [K3] мъртва връзка на заетия (reload/прекъсване) -> пак се освобождава;
 *   [K4] ръчен старт: зает участник -> отказ с код, без старт, място освободено;
 *   [K5] без конфликт -> автоматичният и ръчният старт работят както досега;
 *   [K6] след освобождаване ново сядане без конфликт -> масата стартира.
 *
 *   node server/node_modules/tsx/dist/cli.mjs server/scripts/checkPrivateRoomStartConflict.ts
 */

import {
  createPrivateRoomsStore,
  type PrivateRoom,
  type PrivateRoomBotOccupant,
  type PrivateRoomHumanOccupant,
} from '../src/game/privateRoomsStore.js'

let passed = 0
let failed = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ''}`)
  }
}

function makeHuman(id: string) {
  return { connectionId: `conn-${id}`, profileId: `profile-${id}`, displayName: `Player ${id}`, avatarUrl: null, level: 5, rankTitle: null }
}
function makeBot(id: string): PrivateRoomBotOccupant {
  return {
    kind: 'bot',
    botProfileId: `bot-${id}`,
    botCode: 'CATALOG_BOT',
    difficulty: 'normal',
    behaviorPreset: 'balanced',
    logicSource: 'existing-core-v1',
    identity: { accountId: null, profileId: `bot-${id}`, username: null, displayName: `Bot ${id}`, avatarUrl: null, level: 7, rankTitle: 'Новак', skillRating: 1000, gender: null },
  }
}
const noBlocks = () => false

function createTrackedStore(busyProfileIds: Set<string>) {
  const events: string[] = []
  const released: Array<{ after: PrivateRoom | null; before: PrivateRoom; occupant: PrivateRoomHumanOccupant }> = []
  let resolveCalls = 0
  const store = createPrivateRoomsStore({
    onRoomsChanged: () => events.push('roomsChanged'),
    onRoomReady: () => events.push('roomReady'),
    onRoomExpired: () => events.push('roomExpired'),
    onRoomClosed: () => events.push('roomClosed'),
    onMemberLeft: (_room, occupant) => events.push(`memberLeft:${occupant.profileId}`),
    onMemberKicked: () => events.push('memberKicked'),
    resolveStartConflicts: (room) => {
      resolveCalls += 1
      return room.slots
        .map((s) => s.occupant)
        .filter((o): o is PrivateRoomHumanOccupant => o?.kind === 'human' && o.profileId !== null && busyProfileIds.has(o.profileId))
    },
    onMemberReleasedForConflict: (after, before, occupant) => released.push({ after, before, occupant }),
  })
  return { store, events, released, resolveCalls: () => resolveCalls }
}

function createRoom(store: ReturnType<typeof createPrivateRoomsStore>, manualStart: boolean): PrivateRoom {
  const created = store.createRoom({ ...makeHuman('host'), stake: 1000, isLocked: false, waitMinutes: 15, manualStart })
  if (!created.ok) throw new Error('setup: createRoom')
  return created.room
}
function join(store: ReturnType<typeof createPrivateRoomsStore>, roomId: string, id: string, team: 'A' | 'B', slotIndex: 0 | 1) {
  const result = store.joinTeam({ privateRoomId: roomId, ...makeHuman(id), team, slotIndex, isBlockedWith: noBlocks })
  if (!result.ok) throw new Error(`setup: join ${id}: ${result.message}`)
  return result
}
const occupantIds = (room: PrivateRoom | undefined) => (room?.slots ?? []).map((s) => (s.occupant === null ? '-' : s.occupant.kind === 'bot' ? 'bot' : s.occupant.profileId))

console.log('\ncheckPrivateRoomStartConflict\n')

// ─── [K1] Автоматичен старт, зает участник ────────────────────────────────
{
  const t = createTrackedStore(new Set(['profile-p2']))
  const room = createRoom(t.store, false)
  join(t.store, room.id, 'p2', 'B', 0)
  join(t.store, room.id, 'p3', 'A', 1)
  const last = join(t.store, room.id, 'p4', 'B', 1)
  const live = t.store.listRooms().find((r) => r.id === room.id)
  check('[K1] автоматичен старт: зает участник -> масата НЕ стартира', !t.events.includes('roomReady') && last.readyToStart === false)
  check('[K1] мястото на заетия е освободено, останалите седят', JSON.stringify(occupantIds(live)) === JSON.stringify(['profile-host', 'profile-p3', '-', 'profile-p4']), JSON.stringify(occupantIds(live)))
  check('[K1] резултатът на joinTeam е масата СЛЕД освобождаването', !occupantIds(last.room).includes('profile-p2'))
  check('[K1] известията минават през leaveRoom (memberLeft) + onMemberReleasedForConflict', t.events.includes('memberLeft:profile-p2') && t.released.length === 1 && t.released[0]!.occupant.profileId === 'profile-p2' && t.released[0]!.after !== null)
  check('[K1] заетият вече не е член (getRoomByProfileId)', t.store.getRoomByProfileId('profile-p2') === null)
}

// ─── [K2] Заетият има бот партньор ────────────────────────────────────────
{
  const t = createTrackedStore(new Set(['profile-p2']))
  const room = createRoom(t.store, false)
  join(t.store, room.id, 'p2', 'B', 0)
  const bot = t.store.addBotToTeam({ connectionId: 'conn-p2', team: 'B', botOccupant: makeBot('b1'), isBlockedWith: noBlocks })
  check('[K2] (setup) ботът е добавен', bot.ok)
  join(t.store, room.id, 'p3', 'A', 1)
  const live = t.store.listRooms().find((r) => r.id === room.id)
  check('[K2] без старт; заетият и ботът му излизат (orphan cleanup)', !t.events.includes('roomReady') && JSON.stringify(occupantIds(live)) === JSON.stringify(['profile-host', 'profile-p3', '-', '-']), JSON.stringify(occupantIds(live)))
}

// ─── [K3] Мъртва връзка на заетия ─────────────────────────────────────────
{
  const t = createTrackedStore(new Set(['profile-p2']))
  const room = createRoom(t.store, false)
  join(t.store, room.id, 'p2', 'B', 0)
  t.store.removeConnection('conn-p2') // reload/прекъсване: връзката е махната, мястото остава
  join(t.store, room.id, 'p3', 'A', 1)
  join(t.store, room.id, 'p4', 'B', 1)
  const live = t.store.listRooms().find((r) => r.id === room.id)
  check('[K3] мъртва връзка -> мястото пак се освобождава, без старт', !t.events.includes('roomReady') && occupantIds(live)[2] === '-' && t.store.getRoomByProfileId('profile-p2') === null, JSON.stringify(occupantIds(live)))
}

// ─── [K4] Ръчен старт, зает участник ──────────────────────────────────────
{
  const busy = new Set<string>()
  const t = createTrackedStore(busy)
  const room = createRoom(t.store, true)
  join(t.store, room.id, 'p2', 'B', 0)
  join(t.store, room.id, 'p3', 'A', 1)
  join(t.store, room.id, 'p4', 'B', 1)
  const callsBeforeStart = t.resolveCalls()
  busy.add('profile-p4') // влиза в друг (напр. турнирен) мач, докато масата чака ръчен старт
  const start = t.store.startRoom({ connectionId: 'conn-host', isBlockedWith: noBlocks })
  const live = t.store.listRooms().find((r) => r.id === room.id)
  check('[K4] 4/4 с ръчен старт не прави проверка преди натискане на „Старт“', callsBeforeStart === 0)
  check('[K4] ръчен старт: отказ с код private_room_member_in_active_game, без старт', !start.ok && start.code === 'private_room_member_in_active_game' && !t.events.includes('roomReady'))
  check('[K4] мястото на заетия е освободено, масата чака', live !== undefined && occupantIds(live)[3] === '-' && t.released.length === 1, JSON.stringify(occupantIds(live)))
}

// ─── [K5] Без конфликт — досегашното поведение ────────────────────────────
{
  const t = createTrackedStore(new Set())
  const room = createRoom(t.store, false)
  join(t.store, room.id, 'p2', 'B', 0)
  join(t.store, room.id, 'p3', 'A', 1)
  const last = join(t.store, room.id, 'p4', 'B', 1)
  check('[K5] автоматичен старт без конфликт: стартира веднъж, една проверка', last.readyToStart && t.events.filter((e) => e === 'roomReady').length === 1 && t.resolveCalls() === 1 && t.released.length === 0)

  const m = createTrackedStore(new Set())
  const manual = createRoom(m.store, true)
  join(m.store, manual.id, 'p2', 'B', 0)
  join(m.store, manual.id, 'p3', 'A', 1)
  join(m.store, manual.id, 'p4', 'B', 1)
  const start = m.store.startRoom({ connectionId: 'conn-host', isBlockedWith: noBlocks })
  check('[K5] ръчен старт без конфликт: стартира', start.ok && m.events.filter((e) => e === 'roomReady').length === 1 && m.released.length === 0)
}

// ─── [K6] След освобождаване — ново сядане стартира ───────────────────────
{
  const t = createTrackedStore(new Set(['profile-p2']))
  const room = createRoom(t.store, false)
  join(t.store, room.id, 'p2', 'B', 0)
  join(t.store, room.id, 'p3', 'A', 1)
  join(t.store, room.id, 'p4', 'B', 1)
  const again = join(t.store, room.id, 'p5', 'B', 0)
  check('[K6] свободното място е заето от друг -> масата стартира', again.readyToStart && t.events.filter((e) => e === 'roomReady').length === 1)
}

console.log(`\n${passed} passed, ${failed} failed`)
// Таймерите за изтичане на масите иначе държат процеса жив.
process.exit(failed > 0 ? 1 : 0)
