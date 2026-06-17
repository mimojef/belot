import type {
  GameWorkerId,
  GameWorkerManager,
  GameWorkerManagerConfig,
  GameWorkerManagerHealth,
  GameWorkerSnapshot,
  GameWorkerStatus,
} from './gameWorkerManager.js'

type MutableGameWorkerState = {
  workerId: GameWorkerId
  status: GameWorkerStatus
  activeRooms: number
  maxRooms: number
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `[worker-manager] Configuration error: ${name} must be a finite number, got ${value}`,
    )
  }

  if (!Number.isInteger(value)) {
    throw new Error(
      `[worker-manager] Configuration error: ${name} must be an integer, got ${value}`,
    )
  }

  if (value < 1) {
    throw new Error(
      `[worker-manager] Configuration error: ${name} must be at least 1, got ${value}`,
    )
  }

  return value
}

function createWorkerSnapshots(
  workers: readonly MutableGameWorkerState[],
): GameWorkerSnapshot[] {
  return workers.map((w) => ({
    workerId: w.workerId,
    status: w.status,
    activeRooms: w.activeRooms,
    maxRooms: w.maxRooms,
  }))
}

export function createInProcessGameWorkerManager(
  config: GameWorkerManagerConfig,
): GameWorkerManager {
  const workerCount = requirePositiveInteger(config.workerCount, 'workerCount')
  const maxRooms = requirePositiveInteger(
    config.maxRoomsPerWorker,
    'maxRoomsPerWorker',
  )

  const workers: MutableGameWorkerState[] = Array.from(
    { length: workerCount },
    (_, i) => ({
      workerId: `game-worker-${i + 1}`,
      status: 'ready' as GameWorkerStatus,
      activeRooms: 0,
      maxRooms,
    }),
  )

  const roomAssignments = new Map<string, GameWorkerId>()

  let roundRobinCursor = 0

  function pickWorker(): MutableGameWorkerState | null {
    let minimumLoad = Infinity

    for (const worker of workers) {
      if (worker.status === 'ready' && worker.activeRooms < worker.maxRooms) {
        if (worker.activeRooms < minimumLoad) {
          minimumLoad = worker.activeRooms
        }
      }
    }

    if (minimumLoad === Infinity) {
      return null
    }

    for (let offset = 0; offset < workers.length; offset += 1) {
      const index = (roundRobinCursor + offset) % workers.length
      const worker = workers[index]

      if (
        worker.status === 'ready' &&
        worker.activeRooms < worker.maxRooms &&
        worker.activeRooms === minimumLoad
      ) {
        roundRobinCursor = (index + 1) % workers.length
        return worker
      }
    }

    return null
  }

  return {
    ensureRoom(roomId: string): GameWorkerId | null {
      const existing = roomAssignments.get(roomId) ?? null

      if (existing !== null) {
        return existing
      }

      const worker = pickWorker()

      if (worker === null) {
        return null
      }

      roomAssignments.set(roomId, worker.workerId)
      worker.activeRooms += 1

      return worker.workerId
    },

    getWorkerIdForRoom(roomId: string): GameWorkerId | null {
      return roomAssignments.get(roomId) ?? null
    },

    removeRoom(roomId: string): void {
      const workerId = roomAssignments.get(roomId) ?? null

      if (workerId === null) {
        return
      }

      const worker =
        workers.find((candidate) => candidate.workerId === workerId) ?? null

      if (worker === null) {
        throw new Error(
          `[worker-manager] Invariant violation: assignment exists for room=${roomId} but worker=${workerId} not found`,
        )
      }

      if (worker.activeRooms < 1) {
        throw new Error(
          `[worker-manager] Invariant violation: worker=${workerId} has invalid activeRooms=${worker.activeRooms} for assigned room=${roomId}`,
        )
      }

      roomAssignments.delete(roomId)
      worker.activeRooms -= 1
    },

    getWorkers(): readonly GameWorkerSnapshot[] {
      return createWorkerSnapshots(workers)
    },

    getHealth(): GameWorkerManagerHealth {
      const snapshots = createWorkerSnapshots(workers)
      const readyWorkers = workers.filter((w) => w.status === 'ready').length
      const totalActiveRooms = roomAssignments.size

      return {
        configuredWorkers: workers.length,
        readyWorkers,
        totalActiveRooms,
        workers: snapshots,
      }
    },
  }
}
