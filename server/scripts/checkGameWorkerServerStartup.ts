import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'

type RunningServer = {
  child: ChildProcessWithoutNullStreams
  output: () => string
}

let passCount = 0
let failCount = 0

function pass(label: string): void {
  passCount += 1
  console.log(`  PASS ${label}`)
}

function fail(label: string, error: unknown): void {
  failCount += 1
  const msg = error instanceof Error ? error.message : String(error)
  console.error(`  FAIL ${label}: ${msg}`)
}

async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (error: unknown) {
    fail(label, error)
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate a TCP port.')))
        return
      }

      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return awaitableRace(
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    }),
    timeoutMs,
    () => {
      child.kill('SIGKILL')
      throw new Error('Timed out waiting for server process exit.')
    },
  )
}

function awaitableRace<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => unknown,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      try {
        reject(onTimeout())
      } catch (error: unknown) {
        reject(error)
      }
    }, timeoutMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout !== null) {
      clearTimeout(timeout)
    }
  })
}

async function startServer(env: Record<string, string>): Promise<RunningServer> {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => chunks.push(String(chunk)))
  child.stderr.on('data', (chunk) => chunks.push(String(chunk)))

  return {
    child,
    output: () => chunks.join(''),
  }
}

async function waitForHttpJson(
  port: number,
  pathname: string,
  timeoutMs = 15_000,
): Promise<unknown> {
  const startedAt = Date.now()
  let lastError: Error | null = null

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await new Promise((resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port,
            path: pathname,
            method: 'GET',
            timeout: 1000,
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
            res.on('end', () => {
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
              } catch (error: unknown) {
                reject(error)
              }
            })
          },
        )

        req.on('timeout', () => {
          req.destroy(new Error('HTTP request timed out.'))
        })
        req.on('error', reject)
        req.end()
      })
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error))
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  throw lastError ?? new Error(`Timed out waiting for ${pathname}.`)
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) {
    return
  }

  server.child.kill('SIGTERM')
  await waitForExit(server.child, 10_000)
}

async function withStartedServer(
  env: Record<string, string>,
  fn: (port: number, server: RunningServer) => Promise<void>,
): Promise<void> {
  const port = await getFreePort()
  const server = await startServer({ ...env, PORT: String(port) })

  try {
    await fn(port, server)
  } finally {
    await stopServer(server)
  }
}

console.log('\n=== Game worker backend startup smoke ===')

await check('S1: default in-process mode starts and shuts down cleanly', async () => {
  await withStartedServer({}, async (port) => {
    const health = await waitForHttpJson(port, '/health') as {
      gameWorkerTick: { mode: string }
      gameWorkerPool: unknown
      gameWorkerLifecycle: { ok: boolean }
    }

    assert.equal(health.gameWorkerTick.mode, 'in-process')
    assert.equal(health.gameWorkerPool, null)
    assert.equal(health.gameWorkerLifecycle.ok, true)
  })
})

await check('S1b: in-process mode ignores pool-only worker count config', async () => {
  await withStartedServer(
    {
      BELOT_GAME_WORKER_TICK_MODE: 'in-process',
      BELOT_GAME_WORKER_COUNT: '0',
    },
    async (port) => {
      const health = await waitForHttpJson(port, '/health') as {
        gameWorkerTick: { mode: string }
        gameWorkerPool: unknown
      }

      assert.equal(health.gameWorkerTick.mode, 'in-process')
      assert.equal(health.gameWorkerPool, null)
    },
  )
})

await check('S2: worker-candidate starts with one pool worker', async () => {
  await withStartedServer(
    {
      BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
      BELOT_GAME_WORKER_COUNT: '1',
    },
    async (port) => {
      const health = await waitForHttpJson(port, '/health') as {
        gameWorkerTick: { mode: string }
        gameWorkerPool: {
          state: string
          workerCount: number
          readyWorkers: number
          workers: unknown[]
        }
      }

      assert.equal(health.gameWorkerTick.mode, 'worker-candidate')
      assert.equal(health.gameWorkerPool.state, 'ready')
      assert.equal(health.gameWorkerPool.workerCount, 1)
      assert.equal(health.gameWorkerPool.readyWorkers, 1)
      assert.equal(health.gameWorkerPool.workers.length, 1)
    },
  )
})

await check('S3: worker-candidate starts with two pool workers', async () => {
  await withStartedServer(
    {
      BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
      BELOT_GAME_WORKER_COUNT: '2',
    },
    async (port) => {
      const health = await waitForHttpJson(port, '/health') as {
        gameWorkerPool: {
          workerCount: number
          readyWorkers: number
          workers: Array<{ workerId: string }>
        }
      }

      assert.equal(health.gameWorkerPool.workerCount, 2)
      assert.equal(health.gameWorkerPool.readyWorkers, 2)
      assert.deepStrictEqual(
        health.gameWorkerPool.workers.map((worker) => worker.workerId),
        ['game-worker-1', 'game-worker-2'],
      )
    },
  )
})

await check('S4: invalid worker count fails before HTTP listen', async () => {
  const port = await getFreePort()
  const server = await startServer({
    PORT: String(port),
    BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
    BELOT_GAME_WORKER_COUNT: '0',
  })

  const exit = await waitForExit(server.child, 10_000)
  const output = server.output()

  assert.notEqual(exit.code, 0)
  assert.match(output, /Invalid BELOT_GAME_WORKER_COUNT/)
  assert.equal(output.includes('[http] Belot V2 server is running'), false)
})

if (failCount > 0) {
  console.error(`\nGame worker backend startup smoke failed: ${failCount} failed, ${passCount} passed.`)
  process.exitCode = 1
} else {
  console.log(`\nGame worker backend startup smoke passed: ${passCount} checks.`)
}
