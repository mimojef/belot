import type { Seat, ServerRoom } from '../core/serverTypes.js'
import type { ClientBidAction } from '../protocol/messageTypes.js'

export type ActiveRoomRuntimeHealth = {
  activeRooms: number
  roomsByPhase: Record<string, number>
}

export type RuntimeCommandResult =
  | { ok: true; room: ServerRoom }
  | { ok: false; message: string }

export type SubmitBidInput = {
  room: ServerRoom
  seat: Seat
  action: ClientBidAction
}

export type SubmitCutInput = {
  room: ServerRoom
  seat: Seat
  cutIndex: number
}

export type SubmitPlayInput = {
  room: ServerRoom
  seat: Seat
  cardId: string
  declarationKeys?: string[]
}

export type ResumeHumanControlInput = {
  room: ServerRoom
  seat: Seat
}

export type AbandonHumanControlInput = {
  room: ServerRoom
  seat: Seat
}

export type AdvanceRoomInput = {
  room: ServerRoom
  now: number
}

export interface ActiveRoomRuntime {
  ensureRoom(room: ServerRoom): void
  removeRoom(roomId: string): void
  hasRoom(roomId: string): boolean
  getHealth(): ActiveRoomRuntimeHealth
  submitBid(input: SubmitBidInput): RuntimeCommandResult
  submitCut(input: SubmitCutInput): RuntimeCommandResult
  submitPlay(input: SubmitPlayInput): RuntimeCommandResult
  resumeHumanControl(input: ResumeHumanControlInput): RuntimeCommandResult
  abandonHumanControl(input: AbandonHumanControlInput): RuntimeCommandResult
  advanceRoom(input: AdvanceRoomInput): ServerRoom
}
