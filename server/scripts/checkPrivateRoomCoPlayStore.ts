/**
 * checkPrivateRoomCoPlayStore.ts — „Забрана за съвместна игра“, Етап 3:
 * авторитетната защита в privateRoomsStore (без сървър, без база).
 *
 *   [P1] joinTeam: забранен партньор/противник -> co_play_restricted, масата непроменена;
 *   [P2] записват се accountId от входа и момент на сядане; куката получава доверените данни;
 *   [P3] acceptPartnerInvite: отказ без промяна на масата и на поканата;
 *   [P4] автоматичен старт: финална проверка освобождава участника, масата не стартира;
 *   [P5] ръчен старт: финална проверка -> код co_play_restricted, масата не стартира;
 *   [P6] без куките (изключен флаг) — поведението е непроменено.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkPrivateRoomCoPlayStore.ts   (от server/)
 */

import {
  createPrivateRoomsStore,
  PRIVATE_ROOM_CO_PLAY_REJECTION,
  type PrivateRoom,
  type PrivateRoomHumanOccupant,
} from '../src/game/privateRoomsStore.js'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const noBlock = () => false
const STAKE = 5000 as never

type Recorder = {
  ready: PrivateRoom[]
  seated: string[]
  released: string[]
  coPlayReleased: string[]
  restrictedPairs: Set<string>
  hookCalls: Array<{ connectionId: string; profileId: string | null; accountId: string | null }>
}

function makeStore(withCoPlayHooks: boolean) {
  const rec: Recorder = { ready: [], seated: [], released: [], coPlayReleased: [], restrictedPairs: new Set(), hookCalls: [] }
  const restricted = (a: string | null | undefined, b: string | null | undefined) =>
    typeof a === 'string' && typeof b === 'string' && (rec.restrictedPairs.has(`${a}|${b}`) || rec.restrictedPairs.has(`${b}|${a}`))
  const store = createPrivateRoomsStore({
    onRoomsChanged: () => {},
    onRoomReady: (room) => { rec.ready.push(room) },
    onRoomExpired: () => {},
    onRoomClosed: () => {},
    onMemberLeft: () => {},
    onMemberKicked: () => {},
    onMemberSeated: (_room, occupant) => { rec.seated.push(occupant.profileId ?? '') },
    onMemberReleasedForConflict: (_after, _before, occupant) => { rec.released.push(occupant.profileId ?? '') },
    ...(withCoPlayHooks
      ? {
          isCoPlayRestrictedWithRoom: (room: PrivateRoom, joining: { connectionId: string; profileId: string | null; accountId: string | null }) => {
            rec.hookCalls.push(joining)
            return room.slots.some((s) => s.occupant?.kind === 'human' && restricted(joining.accountId, s.occupant.coPlayAccountId))
          },
          resolveCoPlayStartConflicts: (room: PrivateRoom) => {
            const humans = room.slots.map((s) => s.occupant).filter((o): o is PrivateRoomHumanOccupant => o?.kind === 'human')
            const victims: PrivateRoomHumanOccupant[] = []
            for (let i = 0; i < humans.length; i += 1) {
              for (let j = 0; j < i; j += 1) {
                if (restricted(humans[i]!.coPlayAccountId, humans[j]!.coPlayAccountId)) { victims.push(humans[i]!); break }
              }
            }
            return victims
          },
          onCoPlayMemberReleased: (_after: PrivateRoom | null, _before: PrivateRoom, occupant: PrivateRoomHumanOccupant) => { rec.coPlayReleased.push(occupant.profileId ?? '') },
        }
      : {}),
  })
  return { store, rec }
}

function person(id: string) {
  return { connectionId: `c-${id}`, profileId: `p-${id}`, displayName: id, avatarUrl: null, level: 5, rankTitle: null, coPlayAccountId: `acc-${id}` }
}

function createRoom(store: ReturnType<typeof makeStore>['store'], host: string, manualStart: boolean, invitePartner = false): PrivateRoom {
  const result = store.createRoom({ ...person(host), stake: STAKE, isLocked: false, waitMinutes: 15 as never, manualStart, invitePartner })
  if (!result.ok) throw new Error(`createRoom: ${result.message}`)
  return result.room
}

function join(store: ReturnType<typeof makeStore>['store'], roomId: string, id: string, team: 'A' | 'B', slotIndex: 0 | 1) {
  return store.joinTeam({ privateRoomId: roomId, ...person(id), team, slotIndex, isBlockedWith: noBlock })
}

console.log('\ncheckPrivateRoomCoPlayStore\n')

await check('[P1] joinTeam: забранен партньор И забранен противник -> co_play_restricted; масата непроменена', () => {
  const { store, rec } = makeStore(true)
  const room = createRoom(store, 'host', true)
  assert(join(store, room.id, 'a', 'B', 0).ok, '(setup) A сяда')
  rec.restrictedPairs.add('acc-a|acc-b')
  const before = JSON.stringify(store.getRoomByConnectionId('c-host')!.slots)
  const asPartner = join(store, room.id, 'b', 'B', 1)
  const asOpponent = join(store, room.id, 'b', 'A', 1)
  for (const result of [asPartner, asOpponent]) {
    assert(!result.ok && result.code === 'co_play_restricted' && result.message === PRIVATE_ROOM_CO_PLAY_REJECTION.message, JSON.stringify(result))
  }
  assert(JSON.stringify(store.getRoomByConnectionId('c-host')!.slots) === before, 'местата са променени')
  assert(store.getRoomByConnectionId('c-b') === null, 'Б е регистриран в масата')
  assert(!rec.seated.includes('p-b'), 'onMemberSeated за Б')
  // Без забрана същият играч сяда нормално (нищо не е останало от отказа).
  rec.restrictedPairs.clear()
  assert(join(store, room.id, 'b', 'B', 1).ok, 'Б не може да седне след отпадане на забраната')
})

await check('[P2] записват се accountId (от входа) и момент на сядане; куката получава доверените данни', () => {
  const { store, rec } = makeStore(true)
  const room = createRoom(store, 'host', true)
  assert(join(store, room.id, 'a', 'B', 0).ok, 'A сяда')
  const slots = store.getRoomByConnectionId('c-host')!.slots
  const host = slots[0]!.occupant as PrivateRoomHumanOccupant
  const a = slots.find((s) => s.occupant?.kind === 'human' && s.occupant.profileId === 'p-a')!.occupant as PrivateRoomHumanOccupant
  assert(host.coPlayAccountId === 'acc-host' && a.coPlayAccountId === 'acc-a', 'accountId')
  assert(typeof host.seatedAt === 'number' && typeof a.seatedAt === 'number' && a.seatedAt >= host.seatedAt, 'seatedAt')
  assert(rec.hookCalls.length === 1 && rec.hookCalls[0]!.accountId === 'acc-a' && rec.hookCalls[0]!.connectionId === 'c-a', JSON.stringify(rec.hookCalls))
})

await check('[P3] acceptPartnerInvite: отказ co_play_restricted без промяна на масата и на поканата', () => {
  const { store, rec } = makeStore(true)
  const room = createRoom(store, 'host', true, true)
  const invited = store.invitePartner({ senderConnectionId: 'c-host', toProfileId: 'p-q', toDisplayName: 'q' })
  assert(invited.ok, '(setup) покана')
  assert(join(store, room.id, 'f', 'B', 0).ok, '(setup) F сяда след поканата')
  rec.restrictedPairs.add('acc-f|acc-q')
  const before = JSON.stringify(store.getRoomByConnectionId('c-host'))
  const result = store.acceptPartnerInvite({ inviteId: invited.ok ? invited.invite.inviteId : '', ...person('q'), isBlockedWith: noBlock })
  assert(!result.ok && result.code === 'co_play_restricted' && result.inviteConsumed === false, JSON.stringify(result))
  assert(JSON.stringify(store.getRoomByConnectionId('c-host')) === before, 'масата/поканата са променени')
  assert(store.findPartnerInvite(invited.ok ? invited.invite.inviteId : '') !== null, 'поканата е изчезнала')
  // F напуска -> приемането минава.
  store.leaveRoom('c-f')
  const after = store.acceptPartnerInvite({ inviteId: invited.ok ? invited.invite.inviteId : '', ...person('q'), isBlockedWith: noBlock })
  assert(after.ok, `приемане след промяна на състава: ${JSON.stringify(after)}`)
})

await check('[P4] автоматичен старт: финалната проверка освобождава ограничения участник; масата не стартира', () => {
  const { store, rec } = makeStore(true)
  const room = createRoom(store, 'host', false)
  assert(join(store, room.id, 'a', 'A', 1).ok && join(store, room.id, 'b', 'B', 0).ok, '(setup)')
  // Забраната възниква след сядането (напр. налагане при изключен флаг).
  rec.restrictedPairs.add('acc-a|acc-b')
  const last = join(store, room.id, 'c', 'B', 1)
  assert(last.ok && last.readyToStart === false, `масата стартира: ${JSON.stringify(last)}`)
  assert(rec.ready.length === 0, 'onRoomReady е извикан')
  assert(JSON.stringify(rec.released) === JSON.stringify(['p-b']) && JSON.stringify(rec.coPlayReleased) === JSON.stringify(['p-b']), `освободени: ${JSON.stringify(rec)}`)
  const current = store.getRoomByConnectionId('c-host')!
  assert(current.slots.every((s) => s.occupant?.kind !== 'human' || s.occupant.profileId !== 'p-b'), 'Б е още на масата')
})

await check('[P5] ръчен старт: финалната проверка -> co_play_restricted, освободен участник, масата не стартира', () => {
  const { store, rec } = makeStore(true)
  const room = createRoom(store, 'host', true)
  assert(join(store, room.id, 'a', 'A', 1).ok && join(store, room.id, 'b', 'B', 0).ok && join(store, room.id, 'c', 'B', 1).ok, '(setup)')
  rec.restrictedPairs.add('acc-a|acc-b')
  const result = store.startRoom({ connectionId: 'c-host', isBlockedWith: noBlock })
  assert(!result.ok && result.code === 'co_play_restricted', JSON.stringify(result))
  assert(rec.ready.length === 0, 'стартира')
  assert(JSON.stringify(rec.coPlayReleased) === JSON.stringify(['p-b']), JSON.stringify(rec.coPlayReleased))
})

await check('[P6] без куките (изключен флаг): сядането и автоматичният старт са непроменени', () => {
  const { store, rec } = makeStore(false)
  const room = createRoom(store, 'host', false)
  rec.restrictedPairs.add('acc-a|acc-b')
  assert(join(store, room.id, 'a', 'A', 1).ok && join(store, room.id, 'b', 'B', 0).ok, 'сядане')
  const last = join(store, room.id, 'c', 'B', 1)
  assert(last.ok && last.readyToStart === true && rec.ready.length === 1, `не стартира: ${JSON.stringify(last)}`)
  assert(rec.released.length === 0, 'освободен участник')
})

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
// Таймерите за изтичане на масите (15 мин.) иначе държат процеса жив.
process.exit(failed > 0 ? 1 : 0)
