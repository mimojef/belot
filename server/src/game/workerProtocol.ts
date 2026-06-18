export const GAME_WORKER_PROTOCOL_VERSION = 2

export type WorkerRequestId = string

// ─── Gateway → Worker ─────────────────────────────────────────────────────────

export type GameWorkerPingMessage = {
  type: 'ping'
  requestId: WorkerRequestId
  sentAt: number
}

export type GameWorkerHealthRequestMessage = {
  type: 'health_request'
  requestId: WorkerRequestId
}

export type GameWorkerShutdownMessage = {
  type: 'shutdown'
  requestId: WorkerRequestId
}

export type GameWorkerAssignRoomMessage = {
  type: 'assign_room'
  requestId: WorkerRequestId
  roomId: string
}

export type GameWorkerReleaseRoomMessage = {
  type: 'release_room'
  requestId: WorkerRequestId
  roomId: string
}

export type GatewayToGameWorkerMessage =
  | GameWorkerPingMessage
  | GameWorkerHealthRequestMessage
  | GameWorkerShutdownMessage
  | GameWorkerAssignRoomMessage
  | GameWorkerReleaseRoomMessage

// ─── Worker → Gateway ─────────────────────────────────────────────────────────

export type GameWorkerReadyMessage = {
  type: 'ready'
  workerId: string
  protocolVersion: number
  startedAt: number
}

export type GameWorkerPongMessage = {
  type: 'pong'
  requestId: WorkerRequestId
  receivedAt: number
}

export type GameWorkerHealthResponseMessage = {
  type: 'health_response'
  requestId: WorkerRequestId
  workerId: string
  startedAt: number
  uptimeMs: number
  activeRooms: number
}

export type GameWorkerShutdownCompleteMessage = {
  type: 'shutdown_complete'
  requestId: WorkerRequestId
}

export type GameWorkerErrorMessage = {
  type: 'worker_error'
  requestId?: WorkerRequestId
  message: string
}

export type AssignRoomResult =
  | 'assigned'
  | 'already_assigned'

export type ReleaseRoomResult =
  | 'released'
  | 'not_assigned'

export type GameWorkerAssignRoomAckMessage = {
  type: 'assign_room_ack'
  requestId: WorkerRequestId
  roomId: string
  result: AssignRoomResult
  activeRooms: number
}

export type GameWorkerReleaseRoomAckMessage = {
  type: 'release_room_ack'
  requestId: WorkerRequestId
  roomId: string
  result: ReleaseRoomResult
  activeRooms: number
}

export type GameWorkerToGatewayMessage =
  | GameWorkerReadyMessage
  | GameWorkerPongMessage
  | GameWorkerHealthResponseMessage
  | GameWorkerShutdownCompleteMessage
  | GameWorkerErrorMessage
  | GameWorkerAssignRoomAckMessage
  | GameWorkerReleaseRoomAckMessage
