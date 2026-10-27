/**
 * checkPrivateRoomPartnerInvite.ts
 *
 * Unit tests за "Покани партньор" в privateRoomsStore.ts — резервираното
 * място под домакина (A1), еднократната партньорска покана и атомарното
 * приемане. Приятелство/онлайн/"играе" проверките живеят в index.ts и се
 * покриват от checkPrivateRoomPartnerInviteWebSocket.ts.
 *
 * Covers:
 *  - без чекбокса: няма резервация, A1 работи както досега;
 *  - с чекбокса: A1 е резервирано — join и bot-fill отказват;
 *  - само домакинът кани; втора покана докато първата виси се отказва;
 *  - приемане: сяда на A1, поканата се изчиства, повторно приемане отказва;
 *  - отказ / отмяна / изтичане: мястото остава резервирано, може нова покана;
 *  - поканен, който вече чака в друга маса;
 *  - домакинът напуска → резервацията и поканата се анулират;
 *  - затваряне/изтичане на масата не оставя таймер на поканата;
 *  - партньорът напуска/е изритан → мястото отново е резервирано;
 *  - reconnect на домакина и на поканения;
 *  - едновременни заявки (приемане срещу отмяна, двойно приемане);
 *  - блокиране между поканения и домакина;
 *  - приемане, което запълва 4/4 → onRoomReady точно веднъж.
 */

import { createPrivateRoomsStore, type PrivateRoom, type PrivateRoomPartnerInvite } from '../src/game/privateRoomsStore.js'

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

type EndedEvent = { room: PrivateRoom; invite: PrivateRoomPartnerInvite; reason: string }

function createTrackedStore(partnerInviteTtlMs = 60_000) {
  const ended: EndedEvent[] = []
  const ready: PrivateRoom[] = []
  const closed: PrivateRoom[] = []
  const expired: PrivateRoom[] = []
  const store = createPrivateRoomsStore(
    {
      onRoomsChanged: () => {},
      onRoomReady: (room) => ready.push(room),
      onRoomExpired: (room) => expired.push(room),
      onRoomClosed: (room) => closed.push(room),
      onMemberLeft: () => {},
      onMemberKicked: () => {},
      onPartnerInviteEnded: (room, invite, reason) => ended.push({ room, invite, reason }),
    },
    { partnerInviteTtlMs },
  )
  return { store, ended, ready, closed, expired }
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

function createRoom(
  store: ReturnType<typeof createPrivateRoomsStore>,
  opts: { hostId?: string; invitePartner?: boolean; isLocked?: boolean; waitMinutes?: 5 | 10 | 15 | 30 } = {},
) {
  const created = store.createRoom({
    ...makeHuman(opts.hostId ?? 'host'),
    stake: 1000,
    isLocked: opts.isLocked ?? false,
    waitMinutes: opts.waitMinutes ?? 15,
    manualStart: false,
    invitePartner: opts.invitePartner ?? true,
  })
  if (!created.ok) throw new Error('setup failed')
  return created.room
}

function invite(store: ReturnType<typeof createPrivateRoomsStore>, toId: string, hostId = 'host') {
  return store.invitePartner({
    senderConnectionId: `conn-${hostId}`,
    toProfileId: `profile-${toId}`,
    toDisplayName: `Player ${toId}`,
  })
}

function accept(store: ReturnType<typeof createPrivateRoomsStore>, inviteId: string, id: string, connSuffix = '') {
  return store.acceptPartnerInvite({
    inviteId,
    ...makeHuman(id),
    connectionId: `conn-${id}${connSuffix}`,
    profileId: `profile-${id}`,
    isBlockedWith: noBlocks,
  })
}

function a1(store: ReturnType<typeof createPrivateRoomsStore>, roomId: string) {
  const room = store.listRooms().find((r) => r.id === roomId)!
  return room.slots.find((s) => s.team === 'A' && s.slotIndex === 1)!.occupant
}

function currentRoom(store: ReturnType<typeof createPrivateRoomsStore>, roomId: string): PrivateRoom | undefined {
  return store.listRooms().find((r) => r.id === roomId)
}

console.log('\ncheckPrivateRoomPartnerInvite\n')

// [1] Без чекбокса — старото поведение.
{
  const { store } = createTrackedStore()
  const room = createRoom(store, { invitePartner: false })
  check('[1a] room без "Покани партньор" няма резервация', room.partnerReservation === null)
  const join = store.joinTeam({ ...makeHuman('x'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: noBlocks })
  check('[1b] без резервация друг играч сяда на A1 както досега', join.ok)
  const inv = invite(store, 'friend')
  check('[1c] без резервация invitePartner отказва', !inv.ok)
}

// [2] Резервация: join и bot-fill не могат да вземат A1.
{
  const { store } = createTrackedStore()
  const room = createRoom(store)
  check('[2a] резервацията е A1 с собственик домакина', room.partnerReservation?.team === 'A' && room.partnerReservation.slotIndex === 1 && room.partnerReservation.ownerProfileId === 'profile-host')
  const join = store.joinTeam({ ...makeHuman('x'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: noBlocks })
  check('[2b] join на резервираното място е отказан с private_room_slot_reserved', !join.ok && join.code === 'private_room_slot_reserved')
  check('[2c] резервираното място остава празно', a1(store, room.id) === null)
  const joinB = store.joinTeam({ ...makeHuman('y'), privateRoomId: room.id, team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  check('[2d] останалите места работят нормално', joinB.ok)
  const bot = store.addBotToTeam({
    connectionId: 'conn-host',
    team: 'A',
    botOccupant: { kind: 'bot', botProfileId: 'bot-1', botCode: 'b1', difficulty: 'normal', identity: { profileId: 'bot-1', displayName: 'Bot', avatarUrl: null, level: 1, rankTitle: null } } as any,
    isBlockedWith: noBlocks,
  })
  check('[2e] бот не може да заеме резервираното място', !bot.ok && bot.code === 'private_room_slot_reserved')
  check('[2f] след отказания бот A1 е още празно', a1(store, room.id) === null)
}

// [3] Само домакинът кани; дублирана покана се отказва.
{
  const { store } = createTrackedStore()
  const room = createRoom(store)
  store.joinTeam({ ...makeHuman('opp'), privateRoomId: room.id, team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  const byOpp = invite(store, 'friend', 'opp')
  check('[3a] не-домакин не може да кани партньор', !byOpp.ok && byOpp.code === 'private_room_not_creator')
  const first = invite(store, 'friend')
  check('[3b] домакинът кани успешно', first.ok)
  const second = invite(store, 'friend2')
  check('[3c] втора покана докато първата виси е отказана (private_room_partner_invite_pending)', !second.ok && second.code === 'private_room_partner_invite_pending')
  const same = invite(store, 'friend')
  check('[3d] повторна покана към същия приятел също е отказана', !same.ok && same.code === 'private_room_partner_invite_pending')
  const self = store.cancelPartnerInvite('conn-host')
  check('[3e] (почистване) отмяната работи', self.ok)
  const selfInvite = store.invitePartner({ senderConnectionId: 'conn-host', toProfileId: 'profile-host', toDisplayName: 'me' })
  check('[3f] домакинът не може да покани себе си', !selfInvite.ok)
}

// [4] Приемане + двойно приемане.
{
  const { store } = createTrackedStore()
  const room = createRoom(store, { isLocked: true })
  const inv = invite(store, 'friend')
  if (!inv.ok) throw new Error('invite failed')
  const wrong = accept(store, inv.invite.inviteId, 'stranger')
  check('[4a] чужд профил не може да приеме поканата и тя не се консумира', !wrong.ok && !wrong.inviteConsumed && store.findPartnerInvite(inv.invite.inviteId) !== null)
  const ok = accept(store, inv.invite.inviteId, 'friend')
  check('[4b] приемането сяда поканения на A1', ok.ok && a1(store, room.id)?.kind === 'human' && (a1(store, room.id) as any).profileId === 'profile-friend')
  check('[4c] след приемане няма висяща покана', currentRoom(store, room.id)?.partnerReservation?.invite === null)
  check('[4d] заключена маса: приетият е authorized (може да се върне след leave)', currentRoom(store, room.id)!.authorizedProfileIds.has('profile-friend'))
  const again = accept(store, inv.invite.inviteId, 'friend', '-tab2')
  check('[4e] второ приемане на същата покана е отказано', !again.ok && again.code === 'private_room_partner_invite_invalid')
  check('[4f] на масата има точно 2 човека (няма двойно сядане)', currentRoom(store, room.id)!.slots.filter((s) => s.occupant !== null).length === 2)
  check('[4g] getRoomByConnectionId сочи масата за приелия', store.getRoomByConnectionId('conn-friend')?.id === room.id)
}

// [5] Отказ → мястото остава резервирано, може нова покана.
{
  const { store } = createTrackedStore()
  const room = createRoom(store)
  const inv = invite(store, 'friend')
  if (!inv.ok) throw new Error('invite failed')
  const declinedByOther = store.declinePartnerInvite({ inviteId: inv.invite.inviteId, profileId: 'profile-stranger' })
  check('[5a] чужд профил не може да откаже поканата', !declinedByOther.ok)
  const declined = store.declinePartnerInvite({ inviteId: inv.invite.inviteId, profileId: 'profile-friend' })
  check('[5b] отказът изчиства поканата', declined.ok && currentRoom(store, room.id)?.partnerReservation?.invite === null)
  check('[5c] резервацията остава след отказ', currentRoom(store, room.id)?.partnerReservation !== null && a1(store, room.id) === null)
  const lateAccept = accept(store, inv.invite.inviteId, 'friend')
  check('[5d] приемане след отказ е невалидно', !lateAccept.ok)
  check('[5e] домакинът може да покани друг', invite(store, 'friend2').ok)
}

// [6] Отмяна от домакина.
{
  const { store } = createTrackedStore()
  const room = createRoom(store)
  const inv = invite(store, 'friend')
  if (!inv.ok) throw new Error('invite failed')
  store.joinTeam({ ...makeHuman('opp'), privateRoomId: room.id, team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  check('[6a] не-домакин не може да отмени', !store.cancelPartnerInvite('conn-opp').ok)
  const cancelled = store.cancelPartnerInvite('conn-host')
  check('[6b] домакинът отменя поканата', cancelled.ok && cancelled.invite.inviteId === inv.invite.inviteId)
  check('[6c] приемане след отмяна е невалидно', !accept(store, inv.invite.inviteId, 'friend').ok && a1(store, room.id) === null)
  check('[6d] втора отмяна без покана отказва', !store.cancelPartnerInvite('conn-host').ok)
  check('[6e] след отмяна може нова покана', invite(store, 'friend').ok)
}

// [7] Изтичане след TTL.
{
  const { store, ended } = createTrackedStore(80)
  const room = createRoom(store)
  const inv = invite(store, 'friend')
  if (!inv.ok) throw new Error('invite failed')
  check('[7a] expiresAt = sentAt + TTL', inv.invite.expiresAt - inv.invite.sentAt === 80)
  await sleep(160)
  check('[7b] onPartnerInviteEnded("expired") е извикан веднъж', ended.length === 1 && ended[0]!.reason === 'expired' && ended[0]!.invite.inviteId === inv.invite.inviteId)
  check('[7c] поканата е изчистена, резервацията остава', currentRoom(store, room.id)?.partnerReservation?.invite === null && currentRoom(store, room.id)?.partnerReservation !== null)
  check('[7d] приемане след изтичане е невалидно', !accept(store, inv.invite.inviteId, 'friend').ok && a1(store, room.id) === null)
  const reinvite = invite(store, 'friend')
  check('[7e] бутонът е отново активен — нова покана е възможна', reinvite.ok)
  if (reinvite.ok) {
    accept(store, reinvite.invite.inviteId, 'friend')
    await sleep(160)
    check('[7f] прието преди TTL → таймерът не изтича по-късно', ended.length === 1)
  }
}

// [8] Поканен, който вече чака в друга маса.
{
  const { store } = createTrackedStore()
  createRoom(store, { hostId: 'host' })
  const other = createRoom(store, { hostId: 'busy', invitePartner: false })
  check('[8a] (setup) втората маса е създадена', other.partnerReservation === null)
  const inv = invite(store, 'busy')
  check('[8b] покана към човек, който чака в друга маса, е отказана', !inv.ok && inv.code === 'private_room_partner_unavailable')

  const inv2 = invite(store, 'friend')
  if (!inv2.ok) throw new Error('invite failed')
  // Поканеният междувременно сяда в друга маса.
  store.joinTeam({ ...makeHuman('friend'), privateRoomId: other.id, team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  const res = accept(store, inv2.invite.inviteId, 'friend', '-2')
  check('[8c] приемане докато е в друга маса → отказ, поканата е консумирана', !res.ok && res.inviteConsumed && res.code === 'private_room_partner_unavailable')
}

// [9] Домакинът напуска → резервация и покана се анулират.
{
  const { store, ended } = createTrackedStore()
  const room = createRoom(store)
  store.joinTeam({ ...makeHuman('opp'), privateRoomId: room.id, team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  const inv = invite(store, 'friend')
  if (!inv.ok) throw new Error('invite failed')
  const after = store.leaveRoom('conn-host')
  check('[9a] onPartnerInviteEnded("owner_left")', ended.length === 1 && ended[0]!.reason === 'owner_left')
  check('[9b] резервацията е освободена', after !== null && after.partnerReservation === null)
  check('[9c] приемане след напускане на домакина е невалидно', !accept(store, inv.invite.inviteId, 'friend').ok)
  const join = store.joinTeam({ ...makeHuman('x'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: noBlocks })
  check('[9d] A1 вече е обикновено свободно място', join.ok)
}

// [9.1] Последният човек (домакинът) напуска с висяща покана.
{
  const { store, ended } = createTrackedStore(60)
  createRoom(store)
  invite(store, 'friend')
  store.leaveRoom('conn-host')
  check('[9.1a] owner_left при изтриване на масата', ended.length === 1 && ended[0]!.reason === 'owner_left')
  await sleep(120)
  check('[9.1b] таймерът не изтича след изтриването', ended.length === 1)
}

// [10] Затваряне / изтичане на масата.
{
  const { store, ended, closed } = createTrackedStore(60)
  createRoom(store)
  const inv = invite(store, 'friend')
  if (!inv.ok) throw new Error('invite failed')
  store.closeRoom('conn-host')
  check('[10a] onRoomClosed получава масата с висящата покана (за известяване на поканения)', closed[0]?.partnerReservation?.invite?.inviteId === inv.invite.inviteId)
  check('[10b] поканата вече не може да бъде намерена', store.findPartnerInvite(inv.invite.inviteId) === null)
  await sleep(120)
  check('[10c] таймерът на поканата е изчистен при затваряне', ended.length === 0)
  check('[10d] приемане след затваряне е невалидно', !accept(store, inv.invite.inviteId, 'friend').ok)
}

// [11] Партньорът напуска / е изритан → мястото отново е резервирано.
{
  const { store } = createTrackedStore()
  const room = createRoom(store)
  let inv = invite(store, 'friend')
  if (!inv.ok) throw new Error('invite failed')
  accept(store, inv.invite.inviteId, 'friend')
  store.leaveRoom('conn-friend')
  check('[11a] след напускане на партньора резервацията остава', currentRoom(store, room.id)?.partnerReservation !== null && a1(store, room.id) === null)
  const join = store.joinTeam({ ...makeHuman('x'), privateRoomId: room.id, team: 'A', slotIndex: 1, isBlockedWith: noBlocks })
  check('[11b] друг играч не може да седне на освободеното резервирано място', !join.ok && join.code === 'private_room_slot_reserved')
  inv = invite(store, 'friend2')
  check('[11c] домакинът може да покани нов партньор', inv.ok)
  if (inv.ok) accept(store, inv.invite.inviteId, 'friend2')
  const kick = store.kickMember({ connectionId: 'conn-host', team: 'A', slotIndex: 1 })
  check('[11d] изритан партньор → мястото отново е резервирано', kick.ok && currentRoom(store, room.id)?.partnerReservation !== null && a1(store, room.id) === null)
}

// [12] Reconnect на домакина и на поканения.
{
  const { store } = createTrackedStore()
  const room = createRoom(store)
  const inv = invite(store, 'friend')
  if (!inv.ok) throw new Error('invite failed')
  const reconnected = store.reconnectMember('conn-host-2', 'profile-host')
  check('[12a] reconnect запазва висящата покана', reconnected?.partnerReservation?.invite?.inviteId === inv.invite.inviteId)
  check('[12b] старата връзка вече не може да отмени', !store.cancelPartnerInvite('conn-host').ok)
  check('[12c] поканеният намира поканата си след refresh', store.findPartnerInvitesForProfile('profile-friend').length === 1)
  const res = accept(store, inv.invite.inviteId, 'friend', '-after-refresh')
  check('[12d] приемане от нова връзка (след refresh) работи', res.ok && store.getRoomByConnectionId('conn-friend-after-refresh')?.id === room.id)
  check('[12e] домакинът с новата връзка вижда партньора', store.getRoomByConnectionId('conn-host-2')?.slots[1]?.occupant !== null)
}

// [13] Едновременни заявки.
{
  const { store } = createTrackedStore()
  const room = createRoom(store)
  const inv = invite(store, 'friend')
  if (!inv.ok) throw new Error('invite failed')
  const [r1, r2] = await Promise.all([
    Promise.resolve().then(() => accept(store, inv.invite.inviteId, 'friend', '-tabA')),
    Promise.resolve().then(() => accept(store, inv.invite.inviteId, 'friend', '-tabB')),
  ])
  check('[13a] две едновременни приемания → точно едно успешно', [r1, r2].filter((r) => r.ok).length === 1)
  check('[13b] на масата има точно един партньор', currentRoom(store, room.id)!.slots.filter((s) => s.occupant?.kind === 'human').length === 2)
}
{
  const { store } = createTrackedStore()
  const room = createRoom(store)
  const inv = invite(store, 'friend')
  if (!inv.ok) throw new Error('invite failed')
  const [acc, can] = await Promise.all([
    Promise.resolve().then(() => accept(store, inv.invite.inviteId, 'friend')),
    Promise.resolve().then(() => store.cancelPartnerInvite('conn-host')),
  ])
  const seated = a1(store, room.id) !== null
  check('[13c] приемане срещу отмяна → точно един от двата успява', acc.ok !== can.ok)
  check('[13d] състоянието съответства на победителя', acc.ok ? seated : !seated)
}
{
  const { store } = createTrackedStore()
  createRoom(store)
  const results = await Promise.all(
    ['f1', 'f2', 'f3'].map((id) => Promise.resolve().then(() => invite(store, id))),
  )
  check('[13e] три едновременни покани → точно една висяща', results.filter((r) => r.ok).length === 1)
}

// [14] Блокиране между поканения и домакина.
{
  const { store } = createTrackedStore()
  const room = createRoom(store)
  const inv = invite(store, 'friend')
  if (!inv.ok) throw new Error('invite failed')
  const res = store.acceptPartnerInvite({
    inviteId: inv.invite.inviteId,
    ...makeHuman('friend'),
    isBlockedWith: (a, b) => a === 'profile-friend' && b === 'profile-host',
  })
  check('[14a] блокиране → отказ, поканата е консумирана', !res.ok && res.inviteConsumed)
  check('[14b] мястото остава празно и резервирано', a1(store, room.id) === null && currentRoom(store, room.id)?.partnerReservation !== null)
}

// [15] Приемане, което запълва 4/4 → старт точно веднъж.
{
  const { store, ready } = createTrackedStore()
  const room = createRoom(store)
  store.joinTeam({ ...makeHuman('b0'), privateRoomId: room.id, team: 'B', slotIndex: 0, isBlockedWith: noBlocks })
  store.joinTeam({ ...makeHuman('b1'), privateRoomId: room.id, team: 'B', slotIndex: 1, isBlockedWith: noBlocks })
  check('[15a] 3/4 с празно резервирано място не стартира', ready.length === 0)
  const inv = invite(store, 'friend')
  if (!inv.ok) throw new Error('invite failed')
  check('[15b] покана при 3/4 не стартира масата', ready.length === 0)
  const res = accept(store, inv.invite.inviteId, 'friend')
  check('[15c] приемането запълва 4/4 → readyToStart', res.ok && res.readyToStart)
  check('[15d] onRoomReady е извикан точно веднъж с партньора на A1', ready.length === 1 && (ready[0]!.slots[1]!.occupant as any)?.profileId === 'profile-friend')
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
