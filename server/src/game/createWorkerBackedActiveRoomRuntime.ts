import type { ServerRoom } from '../core/serverTypes.js'
import type {
  ActiveRoomRuntime,
  ActiveRoomRuntimeHealth,
  AbandonHumanControlInput,
  EnsureRoomResult,
  ResumeHumanControlInput,
  RuntimeCommandResult,
  RuntimeRoomTickResult,
  SubmitBidInput,
  SubmitCutInput,
  SubmitPlayInput,
  TickRoomsInput,
  TickRoomsResult,
} from './activeRoomRuntime.js'
import type { GameWorkerManager } from './gameWorkerManager.js'

export type WorkerBackedActiveRoomRuntimeDependencies = {
  workerManager: GameWorkerManager
  delegate: ActiveRoomRuntime
}

export function createWorkerBackedActiveRoomRuntime(
  dependencies: WorkerBackedActiveRoomRuntimeDependencies,
): ActiveRoomRuntime {
  const { workerManager, delegate } = dependencies

  return {
    ensureRoom(room: ServerRoom): EnsureRoomResult {
      const existingWorkerId =
        workerManager.getWorkerIdForRoom(room.id)

      if (existingWorkerId !== null) {
        return delegate.ensureRoom(room)
      }

      const newWorkerId = workerManager.ensureRoom(room.id)

      if (newWorkerId === null) {
        return {
          ok: false,
          reason: 'no_capacity',
        }
      }

      let delegateResult: EnsureRoomResult

      try {
        delegateResult = delegate.ensureRoom(room)
      } catch (err) {
        workerManager.removeRoom(room.id)
        throw err
      }

      if (!delegateResult.ok) {
        workerManager.removeRoom(room.id)
        return delegateResult
      }

      return {
        ok: true,
      }
    },

    removeRoom(roomId: string): void {
      delegate.removeRoom(roomId)
      workerManager.removeRoom(roomId)
    },

    hasRoom(roomId: string): boolean {
      const hasAssignment =
        workerManager.getWorkerIdForRoom(roomId) !== null
      const hasRuntime = delegate.hasRoom(roomId)
      return hasAssignment && hasRuntime
    },

    getHealth(): ActiveRoomRuntimeHealth {
      return delegate.getHealth()
    },

    listTrackedRoomIds(): string[] {
      return delegate.listTrackedRoomIds()
    },

    tickRooms(input: TickRoomsInput): TickRoomsResult {
      type RoomEntry = {
        room: ServerRoom
        originalIndex: number
      }

      const groupsByWorker = new Map<string, RoomEntry[]>()

      for (let i = 0; i < input.rooms.length; i += 1) {
        const room = input.rooms[i]
        const workerId =
          workerManager.getWorkerIdForRoom(room.id)

        if (workerId === null) {
          throw new Error(
            `[worker-runtime] Invariant violation: room=${room.id} has no worker assignment during tick`,
          )
        }

        const existing = groupsByWorker.get(workerId) ?? null

        if (existing !== null) {
          existing.push({ room, originalIndex: i })
        } else {
          groupsByWorker.set(workerId, [{ room, originalIndex: i }])
        }
      }

      const orderedResults: RuntimeRoomTickResult[] = new Array(
        input.rooms.length,
      )

      const workerSnapshots = workerManager.getWorkers()

      for (const snapshot of workerSnapshots) {
        const group = groupsByWorker.get(snapshot.workerId) ?? null

        if (group === null) {
          continue
        }

        const partialResult = delegate.tickRooms({
          now: input.now,
          rooms: group.map((entry) => entry.room),
        })

        if (
          partialResult.results.length !== group.length
        ) {
          throw new Error(
            `[worker-runtime] Invariant violation: delegate returned ${partialResult.results.length} results for ${group.length} rooms in worker=${snapshot.workerId}`,
          )
        }

        for (
          let j = 0;
          j < partialResult.results.length;
          j += 1
        ) {
          const result = partialResult.results[j]
          const entry = group[j]

          if (result.roomId !== entry.room.id) {
            throw new Error(
              `[worker-runtime] Invariant violation: delegate result roomId=${result.roomId} does not match expected roomId=${entry.room.id} at position ${j} in worker=${snapshot.workerId}`,
            )
          }

          orderedResults[entry.originalIndex] = result
        }
      }

      for (let i = 0; i < orderedResults.length; i += 1) {
        if (orderedResults[i] === undefined) {
          throw new Error(
            `[worker-runtime] Invariant violation: missing tick result at index ${i}`,
          )
        }
      }

      return {
        results: orderedResults,
      }
    },

    submitBid(input: SubmitBidInput): RuntimeCommandResult {
      const workerId =
        workerManager.getWorkerIdForRoom(input.room.id)

      if (workerId === null) {
        return {
          ok: false,
          message: 'Room has no worker assignment.',
        }
      }

      return delegate.submitBid(input)
    },

    submitCut(input: SubmitCutInput): RuntimeCommandResult {
      const workerId =
        workerManager.getWorkerIdForRoom(input.room.id)

      if (workerId === null) {
        return {
          ok: false,
          message: 'Room has no worker assignment.',
        }
      }

      return delegate.submitCut(input)
    },

    submitPlay(input: SubmitPlayInput): RuntimeCommandResult {
      const workerId =
        workerManager.getWorkerIdForRoom(input.room.id)

      if (workerId === null) {
        return {
          ok: false,
          message: 'Room has no worker assignment.',
        }
      }

      return delegate.submitPlay(input)
    },

    resumeHumanControl(
      input: ResumeHumanControlInput,
    ): RuntimeCommandResult {
      const workerId =
        workerManager.getWorkerIdForRoom(input.room.id)

      if (workerId === null) {
        return {
          ok: false,
          message: 'Room has no worker assignment.',
        }
      }

      return delegate.resumeHumanControl(input)
    },

    abandonHumanControl(
      input: AbandonHumanControlInput,
    ): RuntimeCommandResult {
      const workerId =
        workerManager.getWorkerIdForRoom(input.room.id)

      if (workerId === null) {
        return {
          ok: false,
          message: 'Room has no worker assignment.',
        }
      }

      return delegate.abandonHumanControl(input)
    },
  }
}
