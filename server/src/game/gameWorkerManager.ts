export type GameWorkerId = string

export type GameWorkerStatus = 'ready' | 'stopped'

export type GameWorkerSnapshot = {
  workerId: GameWorkerId
  status: GameWorkerStatus
  activeRooms: number
  maxRooms: number
}

export type GameWorkerManagerHealth = {
  configuredWorkers: number
  readyWorkers: number
  totalActiveRooms: number
  workers: readonly GameWorkerSnapshot[]
}

export type GameWorkerManagerConfig = {
  workerCount: number
  maxRoomsPerWorker: number
}

export interface GameWorkerManager {
  ensureRoom(roomId: string): GameWorkerId | null
  getWorkerIdForRoom(roomId: string): GameWorkerId | null
  removeRoom(roomId: string): void
  getWorkers(): readonly GameWorkerSnapshot[]
  getHealth(): GameWorkerManagerHealth
}
