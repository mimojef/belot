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
  // shutdownRequested blocks new enqueues but must NOT stop drain from flushing existing items
  let shutdownRequested = false
  let shutdownResolve: (() => void) | null = null

  async function drain(): Promise<void> {
    if (writing) return
    writing = true

    // Continue draining until queue is empty regardless of shutdownRequested.
    // shutdownRequested only prevents new items from being enqueued.
    while (queue.length > 0) {
      const payload = queue.shift()!
      try {
        await writer.write(payload)
      } catch {
        // writer.write handles its own errors and marks metrics unhealthy
      }
    }

    writing = false

    if (shutdownResolve !== null) {
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

    // Wait for drain to flush all remaining items, then resolve
    const drainPromise = new Promise<void>((resolve) => {
      shutdownResolve = resolve
      if (!writing) {
        // Drain hasn't started or already finished — kick it off
        void drain()
      }
      // If writing=true, drain is already running and will call shutdownResolve when done
    })

    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))

    await Promise.race([drainPromise, timeoutPromise])
    await writer.shutdown(Math.min(timeoutMs, 500))
  }

  return { enqueue, getSize, shutdown }
}
