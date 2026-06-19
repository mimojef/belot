import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'

const EXPECTED_PHASES = ['cutting', 'deal-first-3', 'bidding', 'playing'] as const
const SERVER_READY_TIMEOUT_MS = 30_000
const MATCHMAKING_TIMEOUT_MS = 35_000
const PLAYING_TIMEOUT_MS = 120_000
const PASSWORD = 'CandidateApplyE2E123!'
const STAKE = 5000

type HealthPayload = {
  ok?: boolean
  gameRuntime?: { activeRooms?: number; roomsByPhase?: Record<string, number> }
  gameWorkerTick?: { mode?: string }
  gameWorkerPool?: { state?: string; workerCount?: number; readyWorkers?: number } | null
}

type RoomSnapshot = {
  type: 'room_snapshot'
  roomId: string
  game: {
    authoritativePhase?: string | null
    cutting?: { deckCount: number; canSubmitCut: boolean } | null
    bidding?: {
      currentBidderSeat: string | null
      canSubmitBid: boolean
      entries: unknown[]
      winningBid: unknown | null
      validActions: {
        pass: boolean
        suits: Record<string, boolean>
        noTrumps: boolean
        allTrumps: boolean
        double: boolean
        redouble: boolean
      } | null
    } | null
    playing?: {
      currentTurnSeat: string | null
      currentTrickPlays: unknown[]
      completedTricksCount: number
      validCardIds: string[] | null
    } | null
  } | null
}

type RunningServer = {
  child: ChildProcessWithoutNullStreams
  output(): string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate a port.')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

async function getHttpJson(port: number, pathname: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path: pathname, method: 'GET', timeout: 2000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
          catch (error) { reject(error) }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('HTTP request timed out.')))
    req.on('error', reject)
    req.end()
  })
}

function readPersistedPhase(databaseFile: string): string | null {
  const db = new DatabaseSync(databaseFile)
  try {
    const row = db.prepare(`
      SELECT json_extract(snapshot_json, '$.game.authoritativeState.phase') AS game_phase
      FROM active_room_snapshots
      WHERE is_active = 1
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as { game_phase: string | null } | undefined
    return row?.game_phase ?? null
  } finally {
    db.close()
  }
}

function chooseBidAction(snapshot: RoomSnapshot): Record<string, unknown> | null {
  const bidding = snapshot.game?.bidding ?? null
  const valid = bidding?.validActions ?? null
  if (!bidding?.canSubmitBid || valid === null) return null
  if (bidding.winningBid !== null && valid.pass) return { type: 'pass' }
  if (valid.allTrumps) return { type: 'all-trumps' }
  if (valid.noTrumps) return { type: 'no-trumps' }
  for (const suit of ['spades', 'hearts', 'diamonds', 'clubs']) {
    if (valid.suits[suit]) return { type: 'suit', suit }
  }
  if (valid.pass) return { type: 'pass' }
  if (valid.double) return { type: 'double' }
  if (valid.redouble) return { type: 'redouble' }
  return null
}

async function createIsolatedServerRoot(sourceServerRoot: string): Promise<{
  root: string
  server: string
  databaseFile: string
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-candidate-e2e-'))
  const server = join(root, 'server')
  await mkdir(server, { recursive: true })

  // dist/ is the runtime entry; src/game/ is needed by resolveGameWorkerEntryUrl stale check
  await cp(join(sourceServerRoot, 'dist'), join(server, 'dist'), { recursive: true })
  await mkdir(join(server, 'src', 'game'), { recursive: true })
  await cp(join(sourceServerRoot, 'src', 'game'), join(server, 'src', 'game'), {
    recursive: true,
    preserveTimestamps: true,
  })
  await mkdir(join(server, 'database'), { recursive: true })
  await cp(
    join(sourceServerRoot, 'database', 'migrations'),
    join(server, 'database', 'migrations'),
    { recursive: true },
  )
  await mkdir(join(server, 'database', 'data'), { recursive: true })
  await cp(join(sourceServerRoot, 'package.json'), join(server, 'package.json'))

  // Accelerate matchmaking timing constants in compiled JS
  const matchmakingTypesPath = join(server, 'dist', 'matchmaking', 'matchmakingTypes.js')
  const matchmakingTypes = await readFile(matchmakingTypesPath, 'utf8')
  const acceleratedMatchmakingTypes = matchmakingTypes.replace(
    'export const MATCHMAKING_WAIT_MS = 20000;',
    'export const MATCHMAKING_WAIT_MS = 1000;',
  )
  assert.notEqual(acceleratedMatchmakingTypes, matchmakingTypes, 'Unable to accelerate MATCHMAKING_WAIT_MS.')
  await writeFile(matchmakingTypesPath, acceleratedMatchmakingTypes, 'utf8')

  const indexPath = join(server, 'dist', 'index.js')
  const indexJs = await readFile(indexPath, 'utf8')
  const acceleratedIndex = indexJs
    .replace('const MATCHMAKING_TICK_MS = 250;', 'const MATCHMAKING_TICK_MS = 10;')
    .replace('const EARLY_BOT_FILL_DEBIT_MS = 1700;', 'const EARLY_BOT_FILL_DEBIT_MS = 50;')
    .replace('const MATCHMAKING_NO_CAPACITY_COOLDOWN_MS = 2_000;', 'const MATCHMAKING_NO_CAPACITY_COOLDOWN_MS = 10;')
    .replace('const GAME_RUNTIME_TICK_MS = 250;', 'const GAME_RUNTIME_TICK_MS = 10;')
  assert.notEqual(acceleratedIndex, indexJs, 'Unable to accelerate index.js timing constants.')
  await writeFile(indexPath, acceleratedIndex, 'utf8')

  const serverTimingPath = join(server, 'dist', 'game', 'serverTimingConfig.js')
  const serverTiming = await readFile(serverTimingPath, 'utf8')
  const acceleratedServerTiming = serverTiming
    .replace(/cutHumanTimeoutMs: \d+/, 'cutHumanTimeoutMs: 20')
    .replace(/cutBotDelayMs: \d+/, 'cutBotDelayMs: 20')
    .replace(/bidHumanTimeoutMs: \d+/, 'bidHumanTimeoutMs: 20')
    .replace(/bidBotDelayMs: \d+/, 'bidBotDelayMs: 20')
    .replace(/playHumanTimeoutMs: \d+/, 'playHumanTimeoutMs: 20')
    .replace(/playBotDelayMs: \d+/, 'playBotDelayMs: 20')
    .replace(/summaryVisibleMs: \d+/, 'summaryVisibleMs: 20')
  assert.notEqual(acceleratedServerTiming, serverTiming, 'Unable to accelerate serverTimingConfig.js.')
  await writeFile(serverTimingPath, acceleratedServerTiming, 'utf8')

  const phaseDelayPath = join(server, 'dist', 'game', 'getServerPhaseAutoAdvanceDelay.js')
  const phaseDelays = await readFile(phaseDelayPath, 'utf8')
  const acceleratedPhaseDelays = phaseDelays.replace(
    /(const (?:DEAL_FIRST_THREE|DEAL_NEXT_TWO|DEAL_LAST_THREE|ROUND_COMPLETE_PLAYING|NEXT_ROUND|NEXT_ROUND_AFTER_ALL_PASS)_AUTO_ADVANCE_MS = )\d+;/g,
    (_match, prefix: string) => `${prefix}20;`,
  )
  assert.notEqual(acceleratedPhaseDelays, phaseDelays, 'Unable to accelerate phase auto-advance delays.')
  await writeFile(phaseDelayPath, acceleratedPhaseDelays, 'utf8')

  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(sourceServerRoot, 'node_modules'), join(server, 'node_modules'), linkType)
  await symlink(join(sourceServerRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)

  return {
    root,
    server,
    databaseFile: join(server, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: async () => {
      await unlink(join(server, 'node_modules')).catch(() => {})
      await unlink(join(root, 'node_modules')).catch(() => {})
      await rm(root, { recursive: true, force: true })
    },
  }
}

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('dist', 'index.js')], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
      BELOT_GAME_WORKER_COUNT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.setEncoding('utf8')
  child.stderr!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => chunks.push(chunk))
  child.stderr!.on('data', (chunk: string) => chunks.push(chunk))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      server.child.kill('SIGKILL')
      resolve()
    }, 10_000)
    server.child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null
let socket: WebSocket | null = null

try {
  server = startServer(isolated.server, port)

  await waitFor(
    'single worker backend readiness',
    async () => {
      try {
        const health = await getHttpJson(port, '/health') as HealthPayload
        return (
          health.ok === true &&
          health.gameWorkerTick?.mode === 'worker-candidate' &&
          health.gameWorkerPool?.state === 'ready' &&
          health.gameWorkerPool?.workerCount === 1 &&
          health.gameWorkerPool?.readyWorkers === 1
        )
      } catch { return false }
    },
    SERVER_READY_TIMEOUT_MS,
  )

  const runId = `${Date.now()}-${process.pid}`
  const registerResponse = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `candidate-e2e-${runId}@example.test`,
      password: PASSWORD,
      displayName: 'Candidate E2E',
      gender: 'male',
    }),
  })
  const registration = await registerResponse.json() as { ok?: boolean; message?: string }
  assert.equal(registerResponse.status, 200)
  assert.equal(registration.ok, true, registration.message)
  const cookieHeader =
    (registerResponse.headers as unknown as { getSetCookie?(): string[] }).getSetCookie?.()[0]
    ?? registerResponse.headers.get('set-cookie')
  assert.ok(typeof cookieHeader === 'string', 'missing Set-Cookie from registration')
  const cookie = cookieHeader!.split(';')[0]!

  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
  let roomId: string | null = null
  let clientPhase: string | null = null
  const seenPhases = new Set<string>()
  const sentActions = new Set<string>()
  const clientErrors: string[] = []
  let playingHealth: HealthPayload | null = null

  function send(payload: Record<string, unknown>): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
  }

  function maybeSubmitAction(snapshot: RoomSnapshot): void {
    if (snapshot.game?.cutting?.canSubmitCut) {
      const cutIndex = Math.max(1, Math.floor(snapshot.game.cutting.deckCount / 2))
      const key = `cut:${clientPhase}:${cutIndex}`
      if (!sentActions.has(key)) {
        sentActions.add(key)
        send({ type: 'submit_cut_index', roomId, cutIndex })
      }
      return
    }
    const bid = chooseBidAction(snapshot)
    if (bid !== null) {
      const bidding = snapshot.game!.bidding!
      const key = `bid:${clientPhase}:${bidding.currentBidderSeat}:${bidding.entries.length}`
      if (!sentActions.has(key)) {
        sentActions.add(key)
        send({ type: 'submit_bid_action', roomId, action: bid })
      }
      return
    }
    const validCards = snapshot.game?.playing?.validCardIds ?? null
    if (validCards !== null && validCards.length > 0) {
      const playing = snapshot.game!.playing!
      const key = `play:${playing.completedTricksCount}:${playing.currentTrickPlays.length}:${validCards[0]}`
      if (!sentActions.has(key)) {
        sentActions.add(key)
        send({ type: 'submit_play_card', roomId, cardId: validCards[0], declarationKeys: [] })
      }
    }
  }

  socket.on('message', (data) => {
    const message = JSON.parse(String(data)) as Record<string, unknown>
    if (message['type'] === 'error') {
      clientErrors.push(String(message['message'] ?? 'unknown error'))
      return
    }
    if (message['type'] === 'match_found' && typeof message['roomId'] === 'string') {
      roomId = message['roomId']
      return
    }
    if (message['type'] !== 'room_snapshot') return

    const snapshot = message as unknown as RoomSnapshot
    roomId = snapshot.roomId
    clientPhase = snapshot.game?.authoritativePhase ?? null
    if (clientPhase !== null && !seenPhases.has(clientPhase)) {
      seenPhases.add(clientPhase)
      if (clientPhase === 'playing') {
        // Capture /health asynchronously at the moment playing is first observed
        void (getHttpJson(port, '/health') as Promise<HealthPayload>)
          .then((h) => { playingHealth = h })
          .catch(() => {})
      }
    }
    maybeSubmitAction(snapshot)
  })
  socket.on('error', (error) => clientErrors.push(error.message))

  await new Promise<void>((resolve, reject) => {
    socket!.once('open', resolve)
    socket!.once('error', reject)
  })
  send({ type: 'join_matchmaking', stake: STAKE, displayName: 'Candidate E2E' })

  await waitFor('matchmaking room', () => roomId !== null, MATCHMAKING_TIMEOUT_MS)
  await waitFor('playing phase reached via WebSocket', () => seenPhases.has('playing'), PLAYING_TIMEOUT_MS)

  // Give async /health capture a moment to settle
  await sleep(300)

  assert.deepEqual(clientErrors, [])

  for (const phase of EXPECTED_PHASES) {
    assert.ok(seenPhases.has(phase), `WebSocket never observed phase=${phase}`)
    console.log(`  seen phase=${phase}`)
  }

  // Verify /health.roomsByPhase showed playing when playing was first reached via WebSocket
  assert.notEqual(playingHealth, null, 'No /health captured when playing was first seen on WebSocket')
  const roomsByPhase = playingHealth!.gameRuntime?.roomsByPhase ?? {}
  assert.equal(
    roomsByPhase['playing'],
    1,
    `/health roomsByPhase.playing should be 1, got ${JSON.stringify(roomsByPhase)}`,
  )
  console.log(`  /health roomsByPhase at playing: ${JSON.stringify(roomsByPhase)}`)

  // Stop server gracefully before reading SQLite (avoids WAL race on Windows)
  socket.close()
  socket = null
  await stopServer(server)
  server = null

  // Server process has exited: WAL is fully flushed, safe to read SQLite directly
  const persistedPhase = readPersistedPhase(isolated.databaseFile)
  assert.notEqual(persistedPhase, null, 'No active_room_snapshots row found after server stop')
  console.log(`  persisted phase after stop: ${persistedPhase}`)

  console.log(`Real index worker-candidate phase consistency passed serverRoot=${sourceServerRoot}`)
} catch (error) {
  if (server !== null) {
    const tail = server.output().split(/\r?\n/).slice(-80).join('\n')
    console.error(`Server output tail:\n${tail}`)
  }
  throw error
} finally {
  if (socket !== null) { try { socket.terminate() } catch { /* ignore */ } }
  if (server !== null) await stopServer(server).catch(() => {})
  await isolated.cleanup()
}
