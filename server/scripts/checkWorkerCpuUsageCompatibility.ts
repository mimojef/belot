import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGameWorkerLifecycleClient } from '../src/game/createGameWorkerLifecycleClient.js'
import { createGameWorkerPool } from '../src/game/createGameWorkerPool.js'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

async function writeFakeWorker(): Promise<{ url: URL; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-worker-cpu-check-'))
  const file = join(dir, 'fakeWorker.mjs')
  const source = `
import { parentPort, workerData } from 'node:worker_threads'
const workerId = workerData.workerId
const startedAt = Date.now()
parentPort.on('message', (message) => {
  if (message.type === 'ping') {
    parentPort.postMessage({ type: 'pong', requestId: message.requestId, receivedAt: Date.now() })
    return
  }
  if (message.type === 'health_request') {
    parentPort.postMessage({
      type: 'health_response',
      requestId: message.requestId,
      workerId,
      startedAt,
      uptimeMs: Math.max(0, Date.now() - startedAt),
      activeRooms: 0,
    })
    return
  }
  if (message.type === 'shutdown') {
    parentPort.postMessage({ type: 'shutdown_complete', requestId: message.requestId })
    parentPort.close()
    return
  }
})
// Burn a little CPU so cpuUsage() has something non-zero to report.
const busyStart = Date.now()
while (Date.now() - busyStart < 50) { Math.sqrt(Math.random()) }
parentPort.postMessage({ type: 'ready', workerId, protocolVersion: 3, startedAt })
`
  await writeFile(file, source, 'utf8')
  return {
    url: pathToFileURL(file),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

console.log('\n[1] getWorkerCpuUsage() on a ready worker — real Node runtime has worker.cpuUsage() available')
{
  const fake = await writeFakeWorker()
  const client = createGameWorkerLifecycleClient({ workerId: 'w1', workerEntryUrl: fake.url })
  try {
    await client.start()
    const usage = await client.getWorkerCpuUsage()
    assert(usage !== null, 'usage is non-null when worker.cpuUsage() is available on this runtime')
    assert(
      usage === null || (typeof usage.user === 'number' && typeof usage.system === 'number'),
      'usage shape matches NodeJS.CpuUsage { user, system } when present',
    )
  } finally {
    await client.shutdown().catch(() => {})
    await fake.cleanup()
  }
}

console.log('\n[2] getWorkerCpuUsage() before start() (state=idle) — returns null, never throws')
{
  const fake = await writeFakeWorker()
  const client = createGameWorkerLifecycleClient({ workerId: 'w2', workerEntryUrl: fake.url })
  try {
    let threw = false
    let usage: Awaited<ReturnType<typeof client.getWorkerCpuUsage>> = undefined as unknown as null
    try {
      usage = await client.getWorkerCpuUsage()
    } catch {
      threw = true
    }
    assert(!threw, 'calling getWorkerCpuUsage() before start() does not throw')
    assert(usage === null, 'usage is null when the worker is not ready (state=idle)')
  } finally {
    await fake.cleanup()
  }
}

console.log('\n[3] getWorkerCpuUsage() after shutdown() (state=stopped) — returns null, never throws')
{
  const fake = await writeFakeWorker()
  const client = createGameWorkerLifecycleClient({ workerId: 'w3', workerEntryUrl: fake.url })
  try {
    await client.start()
    await client.shutdown()
    let threw = false
    let usage: Awaited<ReturnType<typeof client.getWorkerCpuUsage>> = undefined as unknown as null
    try {
      usage = await client.getWorkerCpuUsage()
    } catch {
      threw = true
    }
    assert(!threw, 'calling getWorkerCpuUsage() after shutdown() does not throw')
    assert(usage === null, 'usage is null after shutdown (state=stopped)')
  } finally {
    await fake.cleanup()
  }
}

console.log('\n[4] Pool.getWorkerCpuUsages() — never throws, returns an entry per worker, degrades gracefully')
{
  const fake = await writeFakeWorker()
  const pool = createGameWorkerPool({
    workerCount: 2,
    maxRoomsPerWorker: 10,
    workerEntryUrl: fake.url,
  })
  try {
    await pool.start()
    let threw = false
    let entries: Awaited<ReturnType<typeof pool.getWorkerCpuUsages>> = []
    try {
      entries = await pool.getWorkerCpuUsages()
    } catch {
      threw = true
    }
    assert(!threw, 'pool.getWorkerCpuUsages() does not throw')
    assert(entries.length === 2, `pool.getWorkerCpuUsages() returns one entry per worker (got ${entries.length}, expected 2)`)
    for (const entry of entries) {
      assert(
        entry.cpuUsage === null || typeof entry.cpuUsage.user === 'number',
        `entry for ${entry.workerId} has null or well-formed cpuUsage`,
      )
    }
  } finally {
    await pool.shutdown().catch(() => {})
    await fake.cleanup()
  }
}

console.log('\n[5] Pool.getWorkerCpuUsages() on a pool with zero workers started — never throws, returns empty array')
{
  const fake = await writeFakeWorker()
  const pool = createGameWorkerPool({
    workerCount: 1,
    maxRoomsPerWorker: 10,
    workerEntryUrl: fake.url,
  })
  try {
    // Never call pool.start() — simulates monitoring querying before the pool is up.
    let threw = false
    let entries: Awaited<ReturnType<typeof pool.getWorkerCpuUsages>> = []
    try {
      entries = await pool.getWorkerCpuUsages()
    } catch {
      threw = true
    }
    assert(!threw, 'getWorkerCpuUsages() on an unstarted pool does not throw')
    assert(entries.length === 0, 'unstarted pool reports zero worker CPU entries')
  } finally {
    await fake.cleanup()
  }
}

console.log('\n[6] Monitoring sampler-level fallback — undefined getWorkerCpuUsages resolves to an empty promise, not a crash')
{
  // Mirrors the exact fallback used in index.ts wiring:
  // getWorkerCpuUsages: () => gameWorkerPool?.getWorkerCpuUsages() ?? Promise.resolve([])
  const gameWorkerPool: { getWorkerCpuUsages: () => Promise<unknown[]> } | null = null
  let threw = false
  let result: unknown[] = []
  try {
    result = await (gameWorkerPool?.getWorkerCpuUsages() ?? Promise.resolve([]))
  } catch {
    threw = true
  }
  assert(!threw, 'null gameWorkerPool fallback does not throw')
  assert(Array.isArray(result) && result.length === 0, 'null gameWorkerPool fallback resolves to an empty array')
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
