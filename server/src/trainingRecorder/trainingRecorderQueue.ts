import type { MutableTrainingRecorderMetrics } from './trainingRecorderMetrics.js'
import type { TrainingRecorderWriter } from './trainingRecorderWriter.js'

// Dropped records rate limiter — log at most once per 30 seconds
const DROPPED_LOG_RATE_LIMIT_MS = 30_000
let lastDroppedLogAt = 0

function logDropped(metrics: MutableTrainingRecorderMetrics): void {
  metrics.droppedRecords += 1
  const now = Date.now()
  if (now - lastDroppedLogAt >= DROPPED_LOG_RATE_LIMIT_MS) {
    lastDroppedLogAt = now
    console.warn(
      `[training-recorder] Queue full — training record dropped (total dropped: ${metrics.droppedRecords})`,
    )
  }
}

export type TrainingRecorderQueue = {
  enqueue(payload: string): void
  getSize(): number
  shutdown(timeoutMs: number): Promise<void>
}

export function createTrainingRecorderQueue(
  maxQueue: number,
  writer: TrainingRecorderWriter,
  metrics: MutableTrainingRecorderMetrics,
): TrainingRecorderQueue {
  const queue: string[] = []
  let writing = false
  let shutdownRequested = false
  let shutdownResolve: (() => void) | null = null

  async function drain(): Promise<void> {
    if (writing) return
    writing = true

    while (queue.length > 0 && !shutdownRequested) {
      const payload = queue.shift()!
      try {
        await writer.write(payload)
      } catch {
        // writer.write handles its own errors and marks metrics unhealthy
      }
    }

    writing = false

    if (shutdownRequested && shutdownResolve !== null) {
      shutdownResolve()
      shutdownResolve = null
    }
  }

  function enqueue(payload: string): void {
    if (shutdownRequested) return

    if (queue.length >= maxQueue) {
      logDropped(metrics)
      return
    }

    queue.push(payload)

    // Kick off drain without blocking the caller
    void drain()
  }

  function getSize(): number {
    return queue.length
  }

  async function shutdown(timeoutMs: number): Promise<void> {
    shutdownRequested = true

    if (!writing && queue.length === 0) {
      await writer.shutdown(timeoutMs)
      return
    }

    // Wait for drain to complete within timeout
    const drainPromise = new Promise<void>((resolve) => {
      shutdownResolve = resolve
      if (!writing) {
        resolve()
      } else {
        void drain()
      }
    })

    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))

    await Promise.race([drainPromise, timeoutPromise])
    await writer.shutdown(Math.min(timeoutMs, 500))
  }

  return { enqueue, getSize, shutdown }
}
