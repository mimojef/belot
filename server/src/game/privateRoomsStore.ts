import { randomUUID } from 'node:crypto'
import type { MatchStake } from '../matchmaking/matchmakingTypes.js'
import type { PrivateRoomActionErrorCode, PrivateRoomWaitMinutes } from '../protocol/messageTypes.js'
import type {
  BotBehaviorPreset,
  BotDifficulty,
  BotLogicSource,
  PlayerIdentitySnapshot,
  Team,
} from '../core/serverTypes.js'

const TOTAL_SLOTS = 4

export type PrivateRoomHumanOccupant = {
  kind: 'human'
  connectionId: string
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
}

export type PrivateRoomBotOccupant = {
  kind: 'bot'
  botProfileId?: string
  botCode: string
  difficulty: BotDifficulty
  behaviorPreset?: BotBehaviorPreset
  logicSource?: BotLogicSource
  identity: PlayerIdentitySnapshot
}

export type PrivateRoomOccupant = PrivateRoomHumanOccupant | PrivateRoomBotOccupant

export type PrivateRoomSlot = {
  team: Team
  slotIndex: 0 | 1
  occupant: PrivateRoomOccupant | null
}

export type PrivateRoomInvite = {
  inviteId: string
  fromProfileId: string
  fromDisplayName: string
  toProfileId: string
  privateRoomId: string
  sentAt: number
}

// Фиксиран ред завинаги: A0, A1, B0, B1 — leave/host-reassignment/list-preview
// логиката разчита на този ред за детерминирано "първи зает human слот" скан.
export type PrivateRoomSlots = [PrivateRoomSlot, PrivateRoomSlot, PrivateRoomSlot, PrivateRoomSlot]

export type PrivateRoom = {
  id: string
  kind: 'open' | 'locked'
  stake: MatchStake
  hostProfileId: string | null
  hostConnectionId: string
  slots: PrivateRoomSlots
  pendingInvites: PrivateRoomInvite[]
  /**
   * Room-lifetime authorization за locked стаи: кой profileId има право да
   * claim-ва/rejoin-ва слот в тази стая. Populate-ва се веднъж (при create за
   * създателя, при invite accept за поканения) и НИКОГА не се маха при join
   * или leave — изчезва само когато room обектът бъде изтрит. Разделено
   * съзнателно от `pendingInvites` (еднократни, консумирани при отговор).
   */
  authorizedProfileIds: Set<string>
  createdAt: number
  expiresAt: number
  /**
   * "Ръчен старт от създателя" — при true, стаята НЕ auto-start-ва при 4/4;
   * остава waiting и пълна докато creator-ът explicit не изпрати startRoom().
   * Default false (сегашното auto-start поведение).
   */
  manualStart: boolean
}

export function getTeamSlots(room: PrivateRoom, team: Team): [PrivateRoomSlot, PrivateRoomSlot] {
  const teamSlots = room.slots.filter((s) => s.team === team)
  return [teamSlots[0]!, teamSlots[1]!]
}

export function findSlot(room: PrivateRoom, team: Team, slotIndex: 0 | 1): PrivateRoomSlot | undefined {
  return room.slots.find((s) => s.team === team && s.slotIndex === slotIndex)
}

export function findSlotByConnectionId(room: PrivateRoom, connectionId: string): PrivateRoomSlot | undefined {
  return room.slots.find((s) => s.occupant?.kind === 'human' && s.occupant.connectionId === connectionId)
}

export function findSlotByProfileId(room: PrivateRoom, profileId: string): PrivateRoomSlot | undefined {
  return room.slots.find((s) => s.occupant?.kind === 'human' && s.occupant.profileId === profileId)
}

export function getOccupiedCount(room: PrivateRoom): number {
  return room.slots.filter((s) => s.occupant !== null).length
}

export function getHumanCount(room: PrivateRoom): number {
  return room.slots.filter((s) => s.occupant?.kind === 'human').length
}

export function getTeamHumanCount(room: PrivateRoom, team: Team): number {
  return getTeamSlots(room, team).filter((s) => s.occupant?.kind === 'human').length
}

// Скан в *фиксирания* A0→A1→B0→B1 ред на room.slots — гарантира
// детерминирано host-reassignment, което никога не сочи към бот.
export function findFirstHumanOccupant(room: PrivateRoom): PrivateRoomHumanOccupant | null {
  for (const slot of room.slots) {
    if (slot.occupant?.kind === 'human') return slot.occupant
  }
  return null
}

export type RoomReadiness =
  | { ready: true }
  | { ready: false; reason: 'blocked_partnership'; blockedTeam: Team }
  | { ready: false; reason: 'duplicate_bot_identity' }

export type IsBlockedWith = (profileIdA: string, profileIdB: string) => boolean

// Финалната валидация преди старт на маса — вика се само когато всичките 4
// слота вече са заети (occupiedCount===4). Duplicate-bot проверката е
// defensive double-check: addBotToTeam подава excludedProfileIds на
// selectMatchmakingBotProfiles именно за да не се стигне до тук, но това е
// последната порта преди игра да старира.
// Идентификатор за duplicate-bot проверката по-долу. botProfileId е
// незадължително поле на типа (огледално на BotRoomParticipant.botProfileId
// в serverTypes.ts) — днешният единствен caller (index.ts, 'add_bot_to_
// private_room_team') винаги го попълва от selectMatchmakingBotProfiles()
// (DB/catalog профилите имат non-null ProfileId; temp-bot fallback-ът
// генерира temp-bot-${randomUUID()}), но evaluateRoomReadiness е defensive
// последна порта, не бива да разчита мълчаливо на това. identity.profileId
// е вторият fallback (identity полето е задължително на occupant-а, макар
// вътрешният му profileId пак да е nullable по тип). Ако НИТО едно от двете
// не съществува, връщаме споделен sentinel — два "безименни" бота стават
// автоматично "дубликат" (safe/conservative: не можем да ги докажем
// различни, затова отказваме старт вместо да рискуваме два неразличими bot
// участника), вместо старото поведение, което тихо ги пропускаше от
// проверката изцяло.
function getBotIdentityKey(bot: PrivateRoomBotOccupant): string {
  if (bot.botProfileId != null) return `profile:${bot.botProfileId}`
  if (bot.identity.profileId != null) return `identity:${bot.identity.profileId}`
  return '__no_stable_bot_identity__'
}

export function evaluateRoomReadiness(room: PrivateRoom, isBlockedWith: IsBlockedWith): RoomReadiness {
  const botIdentityKeys = room.slots
    .map((s) => s.occupant)
    .filter((o): o is PrivateRoomBotOccupant => o !== null && o.kind === 'bot')
    .map(getBotIdentityKey)

  if (new Set(botIdentityKeys).size !== botIdentityKeys.length) {
    return { ready: false, reason: 'duplicate_bot_identity' }
  }

  for (const team of ['A', 'B'] as const) {
    const humans = getTeamSlots(room, team)
      .map((s) => s.occupant)
      .filter((o): o is PrivateRoomHumanOccupant => o !== null && o.kind === 'human')

    if (humans.length === 2) {
      const [a, b] = humans
      if (
        a.profileId !== null &&
        b.profileId !== null &&
        (isBlockedWith(a.profileId, b.profileId) || isBlockedWith(b.profileId, a.profileId))
      ) {
        return { ready: false, reason: 'blocked_partnership', blockedTeam: team }
      }
    }
  }

  return { ready: true }
}

export type CancelInviteResult =
  | { ok: true; invite: PrivateRoomInvite }
  | { ok: false; message: string }

export type CloseRoomResult =
  | { ok: true; room: PrivateRoom }
  | { ok: false; message: string }

export type PrivateRoomsStore = {
  createRoom: (input: CreateRoomInput) => CreateRoomResult
  joinTeam: (input: JoinTeamInput) => JoinTeamResult
  leaveRoom: (connectionId: string) => PrivateRoom | null
  closeRoom: (hostConnectionId: string) => CloseRoomResult
  inviteFriend: (input: InviteFriendInput) => InviteFriendResult
  cancelInvite: (inviteId: string, senderConnectionId: string) => CancelInviteResult
  removeInviteById: (inviteId: string) => PrivateRoomInvite | null
  respondToInvite: (input: RespondToInviteInput) => RespondToInviteResult
  addBotToTeam: (input: AddBotToTeamInput) => AddBotToTeamResult
  removeBotFromTeam: (input: RemoveBotFromTeamInput) => RemoveBotFromTeamResult
  startRoom: (input: StartRoomInput) => StartRoomResult
  kickMember: (input: KickMemberInput) => KickMemberResult
  listRooms: () => PrivateRoom[]
  getRoomByConnectionId: (connectionId: string) => PrivateRoom | null
  getRoomByProfileId: (profileId: string) => PrivateRoom | null
  reconnectMember: (newConnectionId: string, profileId: string) => PrivateRoom | null
  removeConnection: (connectionId: string) => void
}

export type CreateRoomInput = {
  connectionId: string
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
  stake: MatchStake
  isLocked: boolean
  waitMinutes: PrivateRoomWaitMinutes
  manualStart: boolean
}

export type CreateRoomResult =
  | { ok: true; room: PrivateRoom }
  | { ok: false; message: string }

export type JoinTeamInput = {
  privateRoomId: string
  connectionId: string
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
  team: Team
  slotIndex: 0 | 1
  isBlockedWith: IsBlockedWith
}

export type JoinTeamResult =
  | { ok: true; room: PrivateRoom; readyToStart: boolean; readiness?: RoomReadiness }
  | { ok: false; message: string; code?: PrivateRoomActionErrorCode }

export type StartRoomInput = {
  connectionId: string
  isBlockedWith: IsBlockedWith
}

export type StartRoomResult =
  | { ok: true; room: PrivateRoom }
  | { ok: false; message: string; code?: PrivateRoomActionErrorCode; readiness?: RoomReadiness }

export type KickMemberInput = {
  connectionId: string
  team: Team
  slotIndex: 0 | 1
}

export type KickMemberResult =
  | { ok: true; room: PrivateRoom; kickedOccupant: PrivateRoomHumanOccupant }
  | { ok: true; room: PrivateRoom; removedBot: PrivateRoomBotOccupant }
  | { ok: false; message: string; code?: PrivateRoomActionErrorCode }

export type AddBotToTeamInput = {
  connectionId: string
  team: Team
  botOccupant: PrivateRoomBotOccupant
  isBlockedWith: IsBlockedWith
}

export type AddBotToTeamResult =
  | { ok: true; room: PrivateRoom; readyToStart: boolean; readiness?: RoomReadiness }
  | { ok: false; message: string; code?: PrivateRoomActionErrorCode }

export type RemoveBotFromTeamInput = {
  connectionId: string
  team: Team
}

export type RemoveBotFromTeamResult =
  | { ok: true; room: PrivateRoom }
  | { ok: false; message: string; code?: PrivateRoomActionErrorCode }

export type InviteFriendInput = {
  senderConnectionId: string
  toProfileId: string
  toDisplayName: string
}

export type InviteFriendResult =
  | { ok: true; invite: PrivateRoomInvite; room: PrivateRoom }
  | { ok: false; message: string }

export type RespondToInviteInput = {
  inviteId: string
  profileId: string
  accept: boolean
}

export type RespondToInviteResult =
  | { ok: true; room: PrivateRoom; accepted: boolean }
  | { ok: false; message: string }

type StoreCallbacks = {
  onRoomsChanged: () => void
  // Фиксира "стаята стана 4/4 И мина final block validation" — за разлика от
  // старото onRoomFull, вече НЕ значи просто "4 заети слота" (виж
  // evaluateRoomReadiness — 4/4-но-blocked стая не води до onRoomReady).
  onRoomReady: (room: PrivateRoom) => void
  onRoomExpired: (room: PrivateRoom) => void
  onRoomClosed: (room: PrivateRoom) => void
  onMemberLeft: (room: PrivateRoom, occupant: PrivateRoomHumanOccupant) => void
  // Различен от onMemberLeft — kicked играчът трябва dedicated targeted
  // съобщение (private_room_kicked), не generic member-left нотификация
  // към host-а (тя вече знае, тя самата kick-на). Вика се само от
  // kickMember(), никога от leaveRoom().
  onMemberKicked: (room: PrivateRoom, occupant: PrivateRoomHumanOccupant) => void
}

export function createPrivateRoomsStore(callbacks: StoreCallbacks): PrivateRoomsStore {
  const rooms = new Map<string, PrivateRoom>()
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const connectionToRoom = new Map<string, string>()

  function scheduleExpiry(room: PrivateRoom): void {
    const delay = room.expiresAt - Date.now()

    const timer = setTimeout(() => {
      const current = rooms.get(room.id)
      if (current) {
        rooms.delete(current.id)
        expiryTimers.delete(current.id)
        for (const slot of current.slots) {
          if (slot.occupant?.kind === 'human') {
            connectionToRoom.delete(slot.occupant.connectionId)
          }
        }
        callbacks.onRoomExpired(current)
        callbacks.onRoomsChanged()
      }
    }, Math.max(delay, 0))

    expiryTimers.set(room.id, timer)
  }

  function cancelExpiry(roomId: string): void {
    const timer = expiryTimers.get(roomId)
    if (timer !== undefined) {
      clearTimeout(timer)
      expiryTimers.delete(roomId)
    }
  }

  // Детачва стаята от store-а синхронно (rooms.delete + connectionToRoom
  // cleanup) — извиква се само когато readiness.ready===true, точно както
  // старият "room full" detach. Node event loop-ът гарантира, че нищо
  // конкурентно не може да я пипне между тази стъпка и onRoomReady().
  function detachReadyRoom(room: PrivateRoom): void {
    cancelExpiry(room.id)
    rooms.delete(room.id)
    for (const slot of room.slots) {
      if (slot.occupant?.kind === 'human') {
        connectionToRoom.delete(slot.occupant.connectionId)
      }
    }
  }

  // Споделена 4/4 auto-start проверка, извиквана от joinTeam/addBotToTeam
  // веднага след slot-ът е попълнен. При room.manualStart===true, 4/4 НЕ
  // auto-detach-ва/onRoomReady-ва — стаята остава waiting и пълна, чакайки
  // explicit startRoom() от creator-а (виж §1 в task spec-а: "manualStart ON
  // -> при 4/4 НЕ стартирай автоматично"). readyToStart в резултата отразява
  // само реалния auto-start изход — manual-start пълна стая връща
  // readyToStart:false с readiness:{ready:true}, за да различи caller-ът
  // "пълна и readiness мина, но чака ръчен старт" от "пълна, но readiness
  // отказа" (виж broadcastPrivateRoomNotReadyInfo в index.ts — не бива да
  // получи фалшив "readiness failed" при manual-start room).
  function tryAutoStartIfFull(
    room: PrivateRoom,
    isBlockedWith: IsBlockedWith,
  ): { room: PrivateRoom; readyToStart: boolean; readiness?: RoomReadiness } {
    if (getOccupiedCount(room) < TOTAL_SLOTS) {
      callbacks.onRoomsChanged()
      return { room, readyToStart: false }
    }

    const readiness = evaluateRoomReadiness(room, isBlockedWith)
    if (readiness.ready && !room.manualStart) {
      detachReadyRoom(room)
      callbacks.onRoomReady(room)
      callbacks.onRoomsChanged()
      return { room, readyToStart: true, readiness }
    }

    // Стаята остава жива в store-а — не auto-kick, не auto-start (или защото
    // readiness отказа, или защото manualStart чака explicit START).
    callbacks.onRoomsChanged()
    return { room, readyToStart: false, readiness }
  }

  function createRoom(input: CreateRoomInput): CreateRoomResult {
    if (connectionToRoom.has(input.connectionId)) {
      return { ok: false, message: 'Вече си влязъл в тази маса.' }
    }

    if (input.profileId !== null) {
      for (const room of rooms.values()) {
        if (room.slots.some((s) => s.occupant?.kind === 'human' && s.occupant.profileId === input.profileId)) {
          return { ok: false, message: 'Вече си влязъл в тази маса.' }
        }
      }
    }

    const now = Date.now()
    const timeoutMs = input.waitMinutes * 60 * 1000

    const creatorOccupant: PrivateRoomHumanOccupant = {
      kind: 'human',
      connectionId: input.connectionId,
      profileId: input.profileId,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      level: input.level,
      rankTitle: input.rankTitle,
    }

    const slots: PrivateRoomSlots = [
      { team: 'A', slotIndex: 0, occupant: creatorOccupant },
      { team: 'A', slotIndex: 1, occupant: null },
      { team: 'B', slotIndex: 0, occupant: null },
      { team: 'B', slotIndex: 1, occupant: null },
    ]

    const room: PrivateRoom = {
      id: randomUUID(),
      kind: input.isLocked ? 'locked' : 'open',
      stake: input.stake,
      hostProfileId: input.profileId,
      hostConnectionId: input.connectionId,
      slots,
      pendingInvites: [],
      authorizedProfileIds: new Set(input.profileId !== null ? [input.profileId] : []),
      createdAt: now,
      expiresAt: now + timeoutMs,
      manualStart: input.manualStart,
    }

    rooms.set(room.id, room)
    connectionToRoom.set(input.connectionId, room.id)
    scheduleExpiry(room)
    callbacks.onRoomsChanged()

    return { ok: true, room }
  }

  function joinTeam(input: JoinTeamInput): JoinTeamResult {
    if (connectionToRoom.has(input.connectionId)) {
      return { ok: false, message: 'Вече си влязъл в тази маса.' }
    }

    const room = rooms.get(input.privateRoomId) ?? null
    if (room === null) {
      return { ok: false, message: 'Масата не съществува.' }
    }

    if (room.kind === 'locked') {
      if (input.profileId === null || !room.authorizedProfileIds.has(input.profileId)) {
        return { ok: false, message: 'Масата е заключена — нужна е покана.' }
      }
    }

    if (
      input.profileId !== null &&
      room.slots.some((s) => s.occupant?.kind === 'human' && s.occupant.profileId === input.profileId)
    ) {
      return { ok: false, message: 'Вече си в тази маса.' }
    }

    const targetSlot = findSlot(room, input.team, input.slotIndex)
    if (targetSlot === undefined) {
      return { ok: false, message: 'Невалидно място.' }
    }
    if (targetSlot.occupant !== null) {
      return { ok: false, message: 'Мястото вече е заето.', code: 'private_room_slot_taken' }
    }

    const [slotA, slotB] = getTeamSlots(room, input.team)
    const partnerSlot = slotA.slotIndex === input.slotIndex ? slotB : slotA
    if (
      partnerSlot.occupant?.kind === 'human' &&
      partnerSlot.occupant.profileId !== null &&
      input.profileId !== null
    ) {
      const partnerProfileId = partnerSlot.occupant.profileId
      if (input.isBlockedWith(input.profileId, partnerProfileId)) {
        return {
          ok: false,
          message: 'Този потребител е блокиран от Вас и не може да Ви бъде партньор.',
          code: 'private_room_partner_blocked_by_viewer',
        }
      }
      if (input.isBlockedWith(partnerProfileId, input.profileId)) {
        return {
          ok: false,
          message: 'В този отбор има играч, който ви е блокирал и не иска да сте негов партньор.',
          code: 'private_room_partner_blocked',
        }
      }
    }

    const occupant: PrivateRoomHumanOccupant = {
      kind: 'human',
      connectionId: input.connectionId,
      profileId: input.profileId,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      level: input.level,
      rankTitle: input.rankTitle,
    }

    const nextSlots = room.slots.map((s) =>
      s.team === input.team && s.slotIndex === input.slotIndex ? { ...s, occupant } : s,
    ) as PrivateRoomSlots

    const nextRoom: PrivateRoom = { ...room, slots: nextSlots }
    rooms.set(nextRoom.id, nextRoom)
    connectionToRoom.set(input.connectionId, nextRoom.id)

    const outcome = tryAutoStartIfFull(nextRoom, input.isBlockedWith)
    return { ok: true, room: outcome.room, readyToStart: outcome.readyToStart, readiness: outcome.readiness }
  }

  function addBotToTeam(input: AddBotToTeamInput): AddBotToTeamResult {
    const roomId = connectionToRoom.get(input.connectionId)
    if (roomId === undefined) {
      return { ok: false, message: 'Не си в частна маса.' }
    }

    const room = rooms.get(roomId)
    if (room === undefined) {
      connectionToRoom.delete(input.connectionId)
      return { ok: false, message: 'Масата не съществува.' }
    }

    const callerSlot = room.slots.find(
      (s) => s.team === input.team && s.occupant?.kind === 'human' && s.occupant.connectionId === input.connectionId,
    )
    if (callerSlot === undefined) {
      return {
        ok: false,
        message: 'Само играч от този отбор може да добавя бот тук.',
        code: 'private_room_bot_owner_missing',
      }
    }

    const emptySlot = getTeamSlots(room, input.team).find((s) => s.occupant === null)
    if (emptySlot === undefined) {
      return { ok: false, message: 'Отборът е пълен.', code: 'private_room_team_full' }
    }

    const nextSlots = room.slots.map((s) =>
      s.team === input.team && s.slotIndex === emptySlot.slotIndex ? { ...s, occupant: input.botOccupant } : s,
    ) as PrivateRoomSlots

    const nextRoom: PrivateRoom = { ...room, slots: nextSlots }
    rooms.set(nextRoom.id, nextRoom)

    const outcome = tryAutoStartIfFull(nextRoom, input.isBlockedWith)
    return { ok: true, room: outcome.room, readyToStart: outcome.readyToStart, readiness: outcome.readiness }
  }

  function removeBotFromTeam(input: RemoveBotFromTeamInput): RemoveBotFromTeamResult {
    const roomId = connectionToRoom.get(input.connectionId)
    if (roomId === undefined) {
      return { ok: false, message: 'Не си в частна маса.' }
    }

    const room = rooms.get(roomId)
    if (room === undefined) {
      connectionToRoom.delete(input.connectionId)
      return { ok: false, message: 'Масата не съществува.' }
    }

    const callerSlot = room.slots.find(
      (s) => s.team === input.team && s.occupant?.kind === 'human' && s.occupant.connectionId === input.connectionId,
    )
    if (callerSlot === undefined) {
      return {
        ok: false,
        message: 'Само играч от този отбор може да маха бот тук.',
        code: 'private_room_bot_owner_missing',
      }
    }

    const botSlot = getTeamSlots(room, input.team).find((s) => s.occupant?.kind === 'bot')
    if (botSlot === undefined) {
      return { ok: false, message: 'В този отбор няма бот.' }
    }

    const nextSlots = room.slots.map((s) =>
      s.team === input.team && s.slotIndex === botSlot.slotIndex ? { ...s, occupant: null } : s,
    ) as PrivateRoomSlots

    const nextRoom: PrivateRoom = { ...room, slots: nextSlots }
    rooms.set(nextRoom.id, nextRoom)
    callbacks.onRoomsChanged()

    return { ok: true, room: nextRoom }
  }

  // Host-only explicit старт за manualStart===true стаи — единственият друг
  // caller на detachReadyRoom+onRoomReady извън tryAutoStartIfFull. Race-safe
  // (§ Race в task spec-а): преизчислява getOccupiedCount/evaluateRoomReadiness
  // на ТЕКУЩИЯ store state в момента на извикване, не на кеширан snapshot от
  // момента, в който клиентът е получил "4/4" — ако някой е напуснал/бил
  // kick-нат между click и това извикване, occupiedCount вече е <4 тук и
  // request-ът се отказва, стаята остава waiting непроменена.
  function startRoom(input: StartRoomInput): StartRoomResult {
    const roomId = connectionToRoom.get(input.connectionId)
    if (roomId === undefined) {
      return { ok: false, message: 'Не си в частна маса.' }
    }

    const room = rooms.get(roomId)
    if (room === undefined) {
      connectionToRoom.delete(input.connectionId)
      return { ok: false, message: 'Масата не съществува.' }
    }

    if (room.hostConnectionId !== input.connectionId) {
      return {
        ok: false,
        message: 'Само домакинът може да стартира масата.',
        code: 'private_room_not_creator',
      }
    }

    if (!room.manualStart) {
      // Defensive — клиентският бутон никога не би трябвало да е visible/
      // usable тук (виж canManualStart в snapshot-а), но сървърът остава
      // authoritative дори при spoofed WS съобщение.
      return {
        ok: false,
        message: 'Масата не изисква ръчен старт.',
        code: 'private_room_not_ready_to_start',
      }
    }

    if (getOccupiedCount(room) < TOTAL_SLOTS) {
      return {
        ok: false,
        message: 'Масата все още не е пълна.',
        code: 'private_room_not_ready_to_start',
      }
    }

    const readiness = evaluateRoomReadiness(room, input.isBlockedWith)
    if (!readiness.ready) {
      return {
        ok: false,
        message: 'Масата не може да стартира в момента.',
        code: 'private_room_not_ready_to_start',
        readiness,
      }
    }

    detachReadyRoom(room)
    callbacks.onRoomReady(room)
    callbacks.onRoomsChanged()

    return { ok: true, room }
  }

  // Host-only removal на зает слот (човек ИЛИ бот), докато стаята е WAITING
  // (все още в rooms Map-а — веднъж detach-ната/playing, connectionId-ите
  // вече не са в connectionToRoom, значи getRoomByConnectionId-базираният
  // lookup тук естествено отказва). Target-ът е explicit team+slotIndex, не
  // profileId — не позволява spoof на произволен участник (§3 в task
  // spec-а). Occupant kind-ът се determinира ИЗЦЯЛО от authoritative slot
  // state тук — сървърът не приема/не се доверява на никакъв client-подаден
  // "kind" hint.
  //
  // Двата branch-а имат различна семантика надолу по веригата (виж
  // KickMemberResult): human -> kickedOccupant (index.ts праща targeted
  // private_room_kicked + onMemberKicked audit callback, точно established
  // flow-а). bot -> removedBot (само slot clear + onRoomsChanged, НИКАКВО
  // notification — бот няма session за известяване, и няма kicked-player
  // popup смисъл за него, виж §При "−" върху BOT в task spec-а).
  //
  // Bot-removal тук умишлено НЕ прави orphan-partner cleanup (за разлика от
  // human-kick клона по-долу и leaveRoom) — orphan-bot invariant-ът пази
  // "бот никога не остава без собствен човек в отбора"; премахването на
  // бота самия не създава такъв осиротял бот (партньорският слот, ако е
  // човек, си остава напълно валиден сам по себе си).
  function kickMember(input: KickMemberInput): KickMemberResult {
    const roomId = connectionToRoom.get(input.connectionId)
    if (roomId === undefined) {
      return { ok: false, message: 'Не си в частна маса.' }
    }

    const room = rooms.get(roomId)
    if (room === undefined) {
      connectionToRoom.delete(input.connectionId)
      return { ok: false, message: 'Масата не съществува.' }
    }

    if (room.hostConnectionId !== input.connectionId) {
      return {
        ok: false,
        message: 'Само домакинът може да премахва играчи от масата.',
        code: 'private_room_not_creator',
      }
    }

    const targetSlot = findSlot(room, input.team, input.slotIndex)
    if (targetSlot === undefined || targetSlot.occupant === null) {
      return {
        ok: false,
        message: 'Няма никого на това място.',
        code: 'private_room_kick_target_invalid',
      }
    }

    if (targetSlot.occupant.kind === 'bot') {
      const removedBot = targetSlot.occupant
      const nextSlots = room.slots.map((s) =>
        s.team === targetSlot.team && s.slotIndex === targetSlot.slotIndex ? { ...s, occupant: null } : s,
      ) as PrivateRoomSlots

      const nextRoom: PrivateRoom = { ...room, slots: nextSlots }
      rooms.set(roomId, nextRoom)
      callbacks.onRoomsChanged()

      return { ok: true, room: nextRoom, removedBot }
    }

    if (targetSlot.occupant.connectionId === room.hostConnectionId) {
      return {
        ok: false,
        message: 'Не можеш да премахнеш себе си.',
        code: 'private_room_kick_target_invalid',
      }
    }

    const kickedOccupant = targetSlot.occupant

    let nextSlots: PrivateRoomSlot[] = room.slots.map((s) =>
      s.team === targetSlot.team && s.slotIndex === targetSlot.slotIndex ? { ...s, occupant: null } : s,
    )

    const partnerSlotIndex = nextSlots.findIndex(
      (s) => s.team === targetSlot.team && s.slotIndex !== targetSlot.slotIndex,
    )
    if (partnerSlotIndex !== -1 && nextSlots[partnerSlotIndex]!.occupant?.kind === 'bot') {
      nextSlots = nextSlots.map((s, i) => (i === partnerSlotIndex ? { ...s, occupant: null } : s))
    }

    const nextRoom: PrivateRoom = { ...room, slots: nextSlots as PrivateRoomSlots }
    rooms.set(roomId, nextRoom)
    connectionToRoom.delete(kickedOccupant.connectionId)

    callbacks.onMemberKicked(nextRoom, kickedOccupant)
    callbacks.onRoomsChanged()

    return { ok: true, room: nextRoom, kickedOccupant }
  }

  // Връща стаята след leave-а (за да могат remaining members да получат
  // fresh private_room_updated — виж sendPrivateRoomUpdateToMembers в
  // index.ts), или null ако стаята вече не съществува (изтрита защото не
  // остана нито един човек, или connectionId изобщо не е бил в стая).
  function leaveRoom(connectionId: string): PrivateRoom | null {
    const roomId = connectionToRoom.get(connectionId)
    if (roomId === undefined) return null

    const room = rooms.get(roomId)
    if (room === undefined) {
      connectionToRoom.delete(connectionId)
      return null
    }

    const leaverSlot = room.slots.find((s) => s.occupant?.kind === 'human' && s.occupant.connectionId === connectionId)
    connectionToRoom.delete(connectionId)
    if (leaverSlot === undefined) return room

    const leavingOccupant = leaverSlot.occupant as PrivateRoomHumanOccupant

    let nextSlots: PrivateRoomSlot[] = room.slots.map((s) =>
      s.team === leaverSlot.team && s.slotIndex === leaverSlot.slotIndex ? { ...s, occupant: null } : s,
    )

    // Orphan-bot cleanup: ако партньорският слот в същия отбор е бот, маха се
    // и той — никога не оставяме бот без собствен човек в отбора.
    const partnerSlotIndex = nextSlots.findIndex(
      (s) => s.team === leaverSlot.team && s.slotIndex !== leaverSlot.slotIndex,
    )
    if (partnerSlotIndex !== -1 && nextSlots[partnerSlotIndex]!.occupant?.kind === 'bot') {
      nextSlots = nextSlots.map((s, i) => (i === partnerSlotIndex ? { ...s, occupant: null } : s))
    }

    const finalSlots = nextSlots as PrivateRoomSlots
    const remainingHumanCount = finalSlots.filter((s) => s.occupant?.kind === 'human').length

    if (remainingHumanCount === 0) {
      cancelExpiry(roomId)
      rooms.delete(roomId)
      callbacks.onRoomsChanged()
      return null
    }

    let nextHostConnectionId = room.hostConnectionId
    let nextHostProfileId = room.hostProfileId

    if (room.hostConnectionId === connectionId) {
      // Точка 2: детерминиран A0→A1→B0→B1 скан, но НИКОГА не сочи бот —
      // findFirstHumanOccupant пропуска бот слотове дори да са по-рано в реда.
      const newHost = findFirstHumanOccupant({ ...room, slots: finalSlots })!
      nextHostConnectionId = newHost.connectionId
      nextHostProfileId = newHost.profileId
    }

    const nextRoom: PrivateRoom = {
      ...room,
      slots: finalSlots,
      hostConnectionId: nextHostConnectionId,
      hostProfileId: nextHostProfileId,
    }

    rooms.set(roomId, nextRoom)
    callbacks.onMemberLeft(nextRoom, leavingOccupant)
    callbacks.onRoomsChanged()
    return nextRoom
  }

  function closeRoom(hostConnectionId: string): CloseRoomResult {
    const roomId = connectionToRoom.get(hostConnectionId)
    if (roomId === undefined) {
      return { ok: false, message: 'Не си в частна маса.' }
    }

    const room = rooms.get(roomId)
    if (room === undefined) {
      connectionToRoom.delete(hostConnectionId)
      return { ok: false, message: 'Масата не съществува.' }
    }

    cancelExpiry(roomId)
    rooms.delete(roomId)
    for (const slot of room.slots) {
      if (slot.occupant?.kind === 'human') {
        connectionToRoom.delete(slot.occupant.connectionId)
      }
    }

    callbacks.onRoomClosed(room)
    callbacks.onRoomsChanged()

    return { ok: true, room }
  }

  function cancelInvite(inviteId: string, senderConnectionId: string): CancelInviteResult {
    const roomId = connectionToRoom.get(senderConnectionId)
    if (roomId === undefined) {
      return { ok: false, message: 'Не си в частна маса.' }
    }

    const room = rooms.get(roomId)
    if (room === undefined) {
      return { ok: false, message: 'Масата не съществува.' }
    }

    const invite = room.pendingInvites.find((i) => i.inviteId === inviteId)
    if (!invite) {
      return { ok: false, message: 'Поканата не съществува.' }
    }

    const nextRoom: PrivateRoom = {
      ...room,
      pendingInvites: room.pendingInvites.filter((i) => i.inviteId !== inviteId),
    }
    rooms.set(roomId, nextRoom)
    callbacks.onRoomsChanged()

    return { ok: true, invite }
  }

  function removeInviteById(inviteId: string): PrivateRoomInvite | null {
    for (const [roomId, room] of rooms.entries()) {
      const invite = room.pendingInvites.find((i) => i.inviteId === inviteId)
      if (!invite) continue

      const nextRoom: PrivateRoom = {
        ...room,
        pendingInvites: room.pendingInvites.filter((i) => i.inviteId !== inviteId),
      }
      rooms.set(roomId, nextRoom)
      return invite
    }
    return null
  }

  function inviteFriend(input: InviteFriendInput): InviteFriendResult {
    const roomId = connectionToRoom.get(input.senderConnectionId)
    if (roomId === undefined) {
      return { ok: false, message: 'Не си в частна маса.' }
    }

    const room = rooms.get(roomId)
    if (room === undefined) {
      return { ok: false, message: 'Масата не съществува.' }
    }

    if (room.kind !== 'locked') {
      return { ok: false, message: 'Само заключени маси поддържат покани.' }
    }

    if (getOccupiedCount(room) >= TOTAL_SLOTS) {
      return { ok: false, message: 'Масата е пълна.' }
    }

    const senderSlot = room.slots.find(
      (s) => s.occupant?.kind === 'human' && s.occupant.connectionId === input.senderConnectionId,
    )
    const senderOccupant = senderSlot?.occupant as PrivateRoomHumanOccupant | undefined
    if (senderOccupant === undefined) {
      return { ok: false, message: 'Не си в тази маса.' }
    }

    if (senderOccupant.profileId === null) {
      return { ok: false, message: 'Трябва да си влязъл с профил за да каниш приятели.' }
    }

    if (room.pendingInvites.some((i) => i.toProfileId === input.toProfileId)) {
      return { ok: false, message: 'Вече е изпратена покана до този играч.' }
    }

    if (room.slots.some((s) => s.occupant?.kind === 'human' && s.occupant.profileId === input.toProfileId)) {
      return { ok: false, message: 'Играчът вече е в масата.' }
    }

    const invite: PrivateRoomInvite = {
      inviteId: randomUUID(),
      fromProfileId: senderOccupant.profileId,
      fromDisplayName: senderOccupant.displayName,
      toProfileId: input.toProfileId,
      privateRoomId: roomId,
      sentAt: Date.now(),
    }

    const nextRoom: PrivateRoom = {
      ...room,
      pendingInvites: [...room.pendingInvites, invite],
    }

    rooms.set(roomId, nextRoom)

    return { ok: true, invite, room: nextRoom }
  }

  // Приемане на покана вече НЕ сяда автоматично — само разрешава profileId-а
  // за room-lifetime authorization (виж authorizedProfileIds по-горе).
  // Реалният seat claim минава през joinTeam, точно както при open стаите.
  function respondToInvite(input: RespondToInviteInput): RespondToInviteResult {
    let targetRoom: PrivateRoom | null = null

    for (const room of rooms.values()) {
      if (room.pendingInvites.some((i) => i.inviteId === input.inviteId)) {
        targetRoom = room
        break
      }
    }

    if (targetRoom === null) {
      return { ok: false, message: 'Поканата не съществува или е изтекла.' }
    }

    const invite = targetRoom.pendingInvites.find((i) => i.inviteId === input.inviteId)
    if (!invite || invite.toProfileId !== input.profileId) {
      return { ok: false, message: 'Тази покана не е за теб.' }
    }

    const nextInvites = targetRoom.pendingInvites.filter((i) => i.inviteId !== input.inviteId)

    if (!input.accept) {
      const nextRoom: PrivateRoom = { ...targetRoom, pendingInvites: nextInvites }
      rooms.set(nextRoom.id, nextRoom)
      callbacks.onRoomsChanged()
      return { ok: true, room: nextRoom, accepted: false }
    }

    const nextAuthorizedProfileIds = new Set(targetRoom.authorizedProfileIds)
    nextAuthorizedProfileIds.add(input.profileId)

    const nextRoom: PrivateRoom = {
      ...targetRoom,
      pendingInvites: nextInvites,
      authorizedProfileIds: nextAuthorizedProfileIds,
    }
    rooms.set(nextRoom.id, nextRoom)
    callbacks.onRoomsChanged()

    return { ok: true, room: nextRoom, accepted: true }
  }

  function listRooms(): PrivateRoom[] {
    return Array.from(rooms.values())
  }

  function getRoomByConnectionId(connectionId: string): PrivateRoom | null {
    const roomId = connectionToRoom.get(connectionId)
    if (roomId === undefined) return null
    return rooms.get(roomId) ?? null
  }

  function getRoomByProfileId(profileId: string): PrivateRoom | null {
    for (const room of rooms.values()) {
      if (room.slots.some((s) => s.occupant?.kind === 'human' && s.occupant.profileId === profileId)) {
        return room
      }
    }
    return null
  }

  // Точка 4 (втори review кръг): защо старият disconnect не освобождава
  // reconnected occupant-а — removeConnection(connectionId) по-долу само
  // трие ключ от connectionToRoom по ПОДАДЕНИЯ connectionId. Ако reconnect
  // вече е пренаписал слота на нов connectionId преди delayed WS 'close' за
  // стария socket да пристигне, removeConnection(oldConnectionId) просто
  // трие вече несъществуващ ключ — no-op, безвредно.
  function reconnectMember(newConnectionId: string, profileId: string): PrivateRoom | null {
    const room = getRoomByProfileId(profileId)
    if (room === null) return null

    const slotIndex = room.slots.findIndex((s) => s.occupant?.kind === 'human' && s.occupant.profileId === profileId)
    if (slotIndex === -1) return null

    const oldOccupant = room.slots[slotIndex]!.occupant as PrivateRoomHumanOccupant
    const oldConnectionId = oldOccupant.connectionId

    const nextSlots = room.slots.map((s, i) =>
      i === slotIndex ? { ...s, occupant: { ...oldOccupant, connectionId: newConnectionId } } : s,
    ) as PrivateRoomSlots

    const isHost = room.hostConnectionId === oldConnectionId
    const nextRoom: PrivateRoom = {
      ...room,
      slots: nextSlots,
      hostConnectionId: isHost ? newConnectionId : room.hostConnectionId,
    }

    rooms.set(room.id, nextRoom)
    connectionToRoom.delete(oldConnectionId)
    connectionToRoom.set(newConnectionId, room.id)

    return nextRoom
  }

  function removeConnection(connectionId: string): void {
    connectionToRoom.delete(connectionId)
  }

  return {
    createRoom,
    joinTeam,
    leaveRoom,
    closeRoom,
    inviteFriend,
    cancelInvite,
    removeInviteById,
    respondToInvite,
    addBotToTeam,
    removeBotFromTeam,
    startRoom,
    kickMember,
    listRooms,
    getRoomByConnectionId,
    getRoomByProfileId,
    reconnectMember,
    removeConnection,
  }
}
