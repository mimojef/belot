import { randomUUID } from 'node:crypto'
import type { MatchStake } from '../matchmaking/matchmakingTypes.js'

export const PRIVATE_ROOM_OPEN_TIMEOUT_MS = 10 * 60 * 1000
export const PRIVATE_ROOM_LOCKED_TIMEOUT_MS = 20 * 60 * 1000
const MAX_MEMBERS = 4

export type PrivateRoomMember = {
  connectionId: string
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
}

export type PrivateRoomInvite = {
  inviteId: string
  fromProfileId: string
  fromDisplayName: string
  toProfileId: string
  privateRoomId: string
  sentAt: number
}

export type PrivateRoom = {
  id: string
  kind: 'open' | 'locked'
  stake: MatchStake
  hostProfileId: string | null
  hostConnectionId: string
  members: PrivateRoomMember[]
  pendingInvites: PrivateRoomInvite[]
  createdAt: number
  expiresAt: number
}

export type CancelInviteResult =
  | { ok: true; invite: PrivateRoomInvite }
  | { ok: false; message: string }

export type CloseRoomResult =
  | { ok: true; room: PrivateRoom }
  | { ok: false; message: string }

export type BeginBotFillResult =
  | { ok: true; room: PrivateRoom }
  | { ok: false; message: string }

export type PrivateRoomsStore = {
  createRoom: (input: CreateRoomInput) => CreateRoomResult
  joinRoom: (input: JoinRoomInput) => JoinRoomResult
  leaveRoom: (connectionId: string) => void
  closeRoom: (hostConnectionId: string) => CloseRoomResult
  inviteFriend: (input: InviteFriendInput) => InviteFriendResult
  cancelInvite: (inviteId: string, senderConnectionId: string) => CancelInviteResult
  removeInviteById: (inviteId: string) => PrivateRoomInvite | null
  respondToInvite: (input: RespondToInviteInput) => RespondToInviteResult
  beginBotFill: (hostConnectionId: string) => BeginBotFillResult
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
}

export type CreateRoomResult =
  | { ok: true; room: PrivateRoom }
  | { ok: false; message: string }

export type JoinRoomInput = {
  privateRoomId: string
  connectionId: string
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
}

export type JoinRoomResult =
  | { ok: true; room: PrivateRoom }
  | { ok: false; message: string }

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
  connectionId: string
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
  accept: boolean
}

export type RespondToInviteResult =
  | { ok: true; room: PrivateRoom; joined: boolean }
  | { ok: false; message: string }

type StoreCallbacks = {
  onRoomsChanged: () => void
  onRoomFull: (room: PrivateRoom) => void
  onRoomExpired: (room: PrivateRoom) => void
  onRoomClosed: (room: PrivateRoom) => void
  onMemberLeft: (room: PrivateRoom, member: PrivateRoomMember) => void
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
        for (const m of current.members) {
          connectionToRoom.delete(m.connectionId)
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

  function createRoom(input: CreateRoomInput): CreateRoomResult {
    if (connectionToRoom.has(input.connectionId)) {
      return { ok: false, message: 'Вече си влязъл в тази маса.' }
    }

    if (input.profileId !== null) {
      for (const room of rooms.values()) {
        if (room.members.some((m) => m.profileId === input.profileId)) {
          return { ok: false, message: 'Вече си влязъл в тази маса.' }
        }
      }
    }

    const now = Date.now()
    const timeoutMs = input.isLocked ? PRIVATE_ROOM_LOCKED_TIMEOUT_MS : PRIVATE_ROOM_OPEN_TIMEOUT_MS

    const member: PrivateRoomMember = {
      connectionId: input.connectionId,
      profileId: input.profileId,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      level: input.level,
      rankTitle: input.rankTitle,
    }

    const room: PrivateRoom = {
      id: randomUUID(),
      kind: input.isLocked ? 'locked' : 'open',
      stake: input.stake,
      hostProfileId: input.profileId,
      hostConnectionId: input.connectionId,
      members: [member],
      pendingInvites: [],
      createdAt: now,
      expiresAt: now + timeoutMs,
    }

    rooms.set(room.id, room)
    connectionToRoom.set(input.connectionId, room.id)
    scheduleExpiry(room)
    callbacks.onRoomsChanged()

    return { ok: true, room }
  }

  function joinRoom(input: JoinRoomInput): JoinRoomResult {
    if (connectionToRoom.has(input.connectionId)) {
      return { ok: false, message: 'Вече си влязъл в тази маса.' }
    }

    const room = rooms.get(input.privateRoomId) ?? null
    if (room === null) {
      return { ok: false, message: 'Масата не съществува.' }
    }

    if (room.kind === 'locked') {
      return { ok: false, message: 'Масата е заключена — нужна е покана.' }
    }

    if (room.members.length >= MAX_MEMBERS) {
      return { ok: false, message: 'Масата е пълна.' }
    }

    if (input.profileId !== null && room.members.some((m) => m.profileId === input.profileId)) {
      return { ok: false, message: 'Вече си в тази маса.' }
    }

    const member: PrivateRoomMember = {
      connectionId: input.connectionId,
      profileId: input.profileId,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      level: input.level,
      rankTitle: input.rankTitle,
    }

    const nextRoom: PrivateRoom = { ...room, members: [...room.members, member] }
    rooms.set(nextRoom.id, nextRoom)
    connectionToRoom.set(input.connectionId, nextRoom.id)

    if (nextRoom.members.length >= MAX_MEMBERS) {
      cancelExpiry(nextRoom.id)
      rooms.delete(nextRoom.id)
      for (const m of nextRoom.members) {
        connectionToRoom.delete(m.connectionId)
      }
      callbacks.onRoomFull(nextRoom)
      callbacks.onRoomsChanged()
    } else {
      callbacks.onRoomsChanged()
    }

    return { ok: true, room: nextRoom }
  }

  function leaveRoom(connectionId: string): void {
    const roomId = connectionToRoom.get(connectionId)
    if (roomId === undefined) return

    const room = rooms.get(roomId)
    if (room === undefined) {
      connectionToRoom.delete(connectionId)
      return
    }

    const leavingMember = room.members.find((m) => m.connectionId === connectionId)
    connectionToRoom.delete(connectionId)

    const remaining = room.members.filter((m) => m.connectionId !== connectionId)

    if (remaining.length === 0) {
      cancelExpiry(roomId)
      rooms.delete(roomId)
      callbacks.onRoomsChanged()
      return
    }

    const nextHostConnectionId =
      room.hostConnectionId === connectionId ? remaining[0].connectionId : room.hostConnectionId
    const nextHostProfileId =
      room.hostConnectionId === connectionId ? remaining[0].profileId : room.hostProfileId

    const nextRoom: PrivateRoom = {
      ...room,
      members: remaining,
      hostConnectionId: nextHostConnectionId,
      hostProfileId: nextHostProfileId,
    }

    rooms.set(roomId, nextRoom)

    if (leavingMember) {
      callbacks.onMemberLeft(nextRoom, leavingMember)
    }
    callbacks.onRoomsChanged()
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
    for (const m of room.members) {
      connectionToRoom.delete(m.connectionId)
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

    if (room.members.length >= MAX_MEMBERS) {
      return { ok: false, message: 'Масата е пълна.' }
    }

    const senderMember = room.members.find((m) => m.connectionId === input.senderConnectionId)
    if (senderMember === undefined) {
      return { ok: false, message: 'Не си в тази маса.' }
    }

    if (senderMember.profileId === null) {
      return { ok: false, message: 'Трябва да си влязъл с профил за да каниш приятели.' }
    }

    if (room.pendingInvites.some((i) => i.toProfileId === input.toProfileId)) {
      return { ok: false, message: 'Вече е изпратена покана до този играч.' }
    }

    if (room.members.some((m) => m.profileId === input.toProfileId)) {
      return { ok: false, message: 'Играчът вече е в масата.' }
    }

    const invite: PrivateRoomInvite = {
      inviteId: randomUUID(),
      fromProfileId: senderMember.profileId,
      fromDisplayName: senderMember.displayName,
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

  function respondToInvite(input: RespondToInviteInput): RespondToInviteResult {
    if (input.profileId === null) {
      return { ok: false, message: 'Трябва да си влязъл с профил.' }
    }

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
      return { ok: true, room: nextRoom, joined: false }
    }

    if (connectionToRoom.has(input.connectionId)) {
      return { ok: false, message: 'Вече си в друга частна маса.' }
    }

    if (targetRoom.members.length >= MAX_MEMBERS) {
      return { ok: false, message: 'Масата е пълна.' }
    }

    const member: PrivateRoomMember = {
      connectionId: input.connectionId,
      profileId: input.profileId,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      level: input.level,
      rankTitle: input.rankTitle,
    }

    const nextRoom: PrivateRoom = {
      ...targetRoom,
      members: [...targetRoom.members, member],
      pendingInvites: nextInvites,
    }

    rooms.set(nextRoom.id, nextRoom)
    connectionToRoom.set(input.connectionId, nextRoom.id)

    if (nextRoom.members.length >= MAX_MEMBERS) {
      cancelExpiry(nextRoom.id)
      rooms.delete(nextRoom.id)
      for (const m of nextRoom.members) {
        connectionToRoom.delete(m.connectionId)
      }
      callbacks.onRoomFull(nextRoom)
      callbacks.onRoomsChanged()
    } else {
      callbacks.onRoomsChanged()
    }

    return { ok: true, room: nextRoom, joined: true }
  }

  function beginBotFill(hostConnectionId: string): BeginBotFillResult {
    const roomId = connectionToRoom.get(hostConnectionId)
    if (roomId === undefined) {
      return { ok: false, message: 'Не си в частна маса.' }
    }

    const room = rooms.get(roomId)
    if (room === undefined) {
      connectionToRoom.delete(hostConnectionId)
      return { ok: false, message: 'Масата не съществува.' }
    }

    if (room.hostConnectionId !== hostConnectionId) {
      return { ok: false, message: 'Само домакинът може да стартира със ботове.' }
    }

    if (room.members.length < 2 || room.members.length >= MAX_MEMBERS) {
      return { ok: false, message: 'Запълването с ботове изисква 2 или 3 играчи в масата.' }
    }

    // Detach the room from the store synchronously (same pattern as the
    // room-full auto-start path) so no concurrent join/invite/second
    // bot-fill call can observe or mutate it afterwards — Node's
    // single-threaded event loop guarantees this happens atomically with
    // respect to any other WS message handler.
    cancelExpiry(roomId)
    rooms.delete(roomId)
    for (const m of room.members) {
      connectionToRoom.delete(m.connectionId)
    }
    callbacks.onRoomsChanged()

    return { ok: true, room }
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
      if (room.members.some((m) => m.profileId === profileId)) {
        return room
      }
    }
    return null
  }

  function reconnectMember(newConnectionId: string, profileId: string): PrivateRoom | null {
    const room = getRoomByProfileId(profileId)
    if (room === null) return null

    const memberIndex = room.members.findIndex((m) => m.profileId === profileId)
    if (memberIndex === -1) return null

    const oldConnectionId = room.members[memberIndex].connectionId

    const updatedMembers = room.members.map((m, i) =>
      i === memberIndex ? { ...m, connectionId: newConnectionId } : m,
    )

    const isHost = room.hostConnectionId === oldConnectionId
    const nextRoom: PrivateRoom = {
      ...room,
      members: updatedMembers,
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
    joinRoom,
    leaveRoom,
    closeRoom,
    inviteFriend,
    cancelInvite,
    removeInviteById,
    respondToInvite,
    beginBotFill,
    listRooms,
    getRoomByConnectionId,
    getRoomByProfileId,
    reconnectMember,
    removeConnection,
  }
}
