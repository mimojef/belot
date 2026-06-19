import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink, unlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'

type RunningServer = {
  child: ChildProcessWithoutNullStreams
  output(): string
}

type TestServerRoot = {
  root: string
  server: string
  databaseFile: string
  cleanup(): Promise<void>
}

type HealthWorker = {
  workerId: string
  state: string
  assignedRooms: number
}

type HealthPayload = {
  ok: boolean
  gameWorkerTick: {
    mode: string
  }
  gameWorkerPool: {
    state: string
    workerCount: number
    readyWorkers: number
    failedWorkers: number
    totalAssignedRooms: number
    workers: HealthWorker[]
  } | null
}

type ServerMessage = Record<string, unknown> & {
  type?: string
}

type RoomSnapshot = ServerMessage & {
  type: 'room_snapshot'
  roomId: string
  yourSeat: string | null
  reconnectToken: string | null
  game?: {
    authoritativePhase?: string | null
    cutting?: {
      deckCount: number
      canSubmitCut: boolean
    } | null
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
    scoring?: unknown | null
    matchEnded?: unknown | null
  } | null
}

type ClientRecord = {
  id: number
  email: string
  password: string
  displayName: string
  cookie: string
  ws: WebSocket | null
  open: boolean
  roomId: string | null
  seat: string | null
  reconnectToken: string | null
  resumeConfirmed: boolean
  sentActionKeys: Set<string>
  messages: ServerMessage[]
  errors: string[]
}

type RoomRecord = {
  roomId: string
  phases: Set<string>
  snapshotCount: number
  seats: Set<string>
  reconnectTokens: Map<number, string>
  actionCount: number
}

const CLIENT_COUNT = 16
const EXPECTED_ROOM_COUNT = 4
const STAKE = 5000
const PASSWORD = 'FullServerValidation123!'
const SERVER_READY_TIMEOUT_MS = 30_000
const MATCHMAKING_TIMEOUT_MS = 30_000
const GAMEPLAY_TIMEOUT_MS = 120_000
const RESTORE_TIMEOUT_MS = 45_000

let passCount = 0
let failCount = 0
const unhandledErrors: string[] = []

process.on('unhandledRejection', (reason) => {
  unhandledErrors.push(reason instanceof Error ? reason.message : String(reason))
})

process.on('uncaughtException', (error) => {
  unhandledErrors.push(error.message)
})

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function awaitableRace<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout !== null) {
      clearTimeout(timeout)
    }
  })
}

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return
    }

    await sleep(50)
  }

  throw new Error(`Timed out waiting for ${label}.`)
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

async function createIsolatedServerRoot(originalServerRoot: string): Promise<TestServerRoot> {
  const root = await mkdtemp(join(tmpdir(), 'belot-full-server-'))
  const server = join(root, 'server')

  await mkdir(server, { recursive: true })
  await cp(join(originalServerRoot, 'src'), join(server, 'src'), {
    recursive: true,
    preserveTimestamps: true,
  })
  await cp(join(originalServerRoot, 'dist'), join(server, 'dist'), {
    recursive: true,
    preserveTimestamps: true,
  })
  await mkdir(join(server, 'database'), { recursive: true })
  await cp(join(originalServerRoot, 'database', 'migrations'), join(server, 'database', 'migrations'), {
    recursive: true,
    preserveTimestamps: true,
  })
  await mkdir(join(server, 'database', 'data'), { recursive: true })
  await cp(join(originalServerRoot, 'package.json'), join(server, 'package.json'), {
    preserveTimestamps: true,
  })

  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(
    join(originalServerRoot, 'node_modules'),
    join(server, 'node_modules'),
    linkType,
  )
  await symlink(
    join(originalServerRoot, '..', 'node_modules'),
    join(root, 'node_modules'),
    linkType,
  )

  return {
    root,
    server,
    databaseFile: join(server, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function startServer(testRoot: TestServerRoot, port: number): Promise<RunningServer> {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: testRoot.server,
      env: {
        ...process.env,
        PORT: String(port),
        BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
        BELOT_GAME_WORKER_COUNT: '4',
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

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }

  return await awaitableRace(
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    }),
    timeoutMs,
    'Timed out waiting for server process exit.',
  )
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) {
    return
  }

  server.child.kill('SIGTERM')
  const exit = await waitForExit(server.child, 15_000).catch(async (error) => {
    server.child.kill('SIGKILL')
    await waitForExit(server.child, 5000).catch(() => {})
    throw error
  })

  const cleanExit =
    exit.code === 0 ||
    (exit.code === null && exit.signal === 'SIGTERM' && process.platform === 'win32')
  assert.equal(
    cleanExit,
    true,
    `server exited with code=${exit.code} signal=${exit.signal}`,
  )
}

async function getHttpJson(port: number, pathname: string): Promise<unknown> {
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

    req.on('timeout', () => req.destroy(new Error('HTTP request timed out.')))
    req.on('error', reject)
    req.end()
  })
}

async function waitForPoolReady(port: number): Promise<HealthPayload> {
  let lastHealth: HealthPayload | null = null

  await waitFor(
    'four ready pool workers',
    async () => {
      try {
        const health = await getHttpJson(port, '/health') as HealthPayload
        lastHealth = health
        return (
          health.ok === true &&
          health.gameWorkerTick.mode === 'worker-candidate' &&
          health.gameWorkerPool !== null &&
          health.gameWorkerPool.state === 'ready' &&
          health.gameWorkerPool.workerCount === 4 &&
          health.gameWorkerPool.readyWorkers === 4
        )
      } catch {
        return false
      }
    },
    SERVER_READY_TIMEOUT_MS,
  )

  assert.notEqual(lastHealth, null)
  return lastHealth!
}

async function registerClient(port: number, clientId: number, runId: string): Promise<ClientRecord> {
  const email = `full-server-${runId}-${clientId}@example.test`
  const displayName = `Full ${clientId}`
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      displayName,
      gender: clientId % 2 === 0 ? 'female' : 'male',
    }),
  })

  const payload = await response.json() as { ok?: boolean; message?: string }
  assert.equal(response.status, 200, `register status for client=${clientId}`)
  assert.equal(payload.ok, true, `register failed for client=${clientId}: ${payload.message ?? ''}`)

  const headersWithGetSetCookie = response.headers as Headers & {
    getSetCookie?: () => string[]
  }
  const cookieHeader =
    headersWithGetSetCookie.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
  assert.equal(typeof cookieHeader, 'string', `missing Set-Cookie for client=${clientId}`)

  return {
    id: clientId,
    email,
    password: PASSWORD,
    displayName,
    cookie: cookieHeader!.split(';')[0]!,
    ws: null,
    open: false,
    roomId: null,
    seat: null,
    reconnectToken: null,
    resumeConfirmed: false,
    sentActionKeys: new Set<string>(),
    messages: [],
    errors: [],
  }
}

function isRoomSnapshot(message: ServerMessage): message is RoomSnapshot {
  return message.type === 'room_snapshot' && typeof message.roomId === 'string'
}

function chooseBidAction(snapshot: RoomSnapshot): Record<string, unknown> | null {
  const bidding = snapshot.game?.bidding ?? null
  const validActions = bidding?.validActions ?? null

  if (!bidding?.canSubmitBid || validActions === null) {
    return null
  }

  if (bidding.winningBid !== null && validActions.pass) {
    return { type: 'pass' }
  }

  if (validActions.allTrumps) {
    return { type: 'all-trumps' }
  }

  if (validActions.noTrumps) {
    return { type: 'no-trumps' }
  }

  for (const suit of ['spades', 'hearts', 'diamonds', 'clubs']) {
    if (validActions.suits[suit]) {
      return { type: 'suit', suit }
    }
  }

  if (validActions.pass) {
    return { type: 'pass' }
  }

  if (validActions.double) {
    return { type: 'double' }
  }

  if (validActions.redouble) {
    return { type: 'redouble' }
  }

  return null
}

function sendClientMessage(client: ClientRecord, payload: Record<string, unknown>): void {
  if (client.ws === null || client.ws.readyState !== WebSocket.OPEN) {
    return
  }

  client.ws.send(JSON.stringify(payload))
}

function maybeSubmitAction(
  client: ClientRecord,
  snapshot: RoomSnapshot,
  rooms: Map<string, RoomRecord>,
): void {
  const game = snapshot.game ?? null
  const room = rooms.get(snapshot.roomId) ?? null

  if (room === null || game === null) {
    return
  }

  const phase = game.authoritativePhase ?? 'unknown'

  if (game.cutting?.canSubmitCut) {
    const cutIndex = Math.max(1, Math.min(31, Math.floor(game.cutting.deckCount / 2)))
    const key = `cut:${snapshot.roomId}:${phase}:${game.cutting.deckCount}:${cutIndex}`
    if (!client.sentActionKeys.has(key)) {
      client.sentActionKeys.add(key)
      room.actionCount += 1
      sendClientMessage(client, {
        type: 'submit_cut_index',
        roomId: snapshot.roomId,
        cutIndex,
      })
    }
    return
  }

  const bidAction = chooseBidAction(snapshot)
  if (bidAction !== null) {
    const bidding = game.bidding!
    const key = [
      'bid',
      snapshot.roomId,
      phase,
      bidding.currentBidderSeat ?? 'none',
      bidding.entries.length,
      JSON.stringify(bidAction),
    ].join(':')

    if (!client.sentActionKeys.has(key)) {
      client.sentActionKeys.add(key)
      room.actionCount += 1
      sendClientMessage(client, {
        type: 'submit_bid_action',
        roomId: snapshot.roomId,
        action: bidAction,
      })
    }
    return
  }

  const validCardIds = game.playing?.validCardIds ?? null
  if (validCardIds !== null && validCardIds.length > 0) {
    const playing = game.playing!
    const cardId = validCardIds[0]!
    const key = [
      'play',
      snapshot.roomId,
      phase,
      playing.currentTurnSeat ?? 'none',
      playing.completedTricksCount,
      playing.currentTrickPlays.length,
      cardId,
    ].join(':')

    if (!client.sentActionKeys.has(key)) {
      client.sentActionKeys.add(key)
      room.actionCount += 1
      sendClientMessage(client, {
        type: 'submit_play_card',
        roomId: snapshot.roomId,
        cardId,
        declarationKeys: [],
      })
    }
  }
}

async function connectClient(
  port: number,
  client: ClientRecord,
  rooms: Map<string, RoomRecord>,
  resume?: { roomId: string; reconnectToken: string },
): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: {
      Cookie: client.cookie,
    },
  })
  client.ws = ws
  client.open = false
  client.resumeConfirmed = false

  ws.on('message', (data) => {
    let message: ServerMessage
    try {
      message = JSON.parse(String(data)) as ServerMessage
    } catch (error: unknown) {
      client.errors.push(error instanceof Error ? error.message : String(error))
      return
    }

    client.messages.push(message)

    if (message.type === 'error') {
      client.errors.push(String(message.message ?? 'unknown error'))
      return
    }

    if (message.type === 'match_found' && typeof message.roomId === 'string') {
      client.roomId = message.roomId
      client.seat = typeof message.seat === 'string' ? message.seat : client.seat
      if (!rooms.has(message.roomId)) {
        rooms.set(message.roomId, {
          roomId: message.roomId,
          phases: new Set<string>(),
          snapshotCount: 0,
          seats: new Set<string>(),
          reconnectTokens: new Map<number, string>(),
          actionCount: 0,
        })
      }
      return
    }

    if (
      message.type === 'session_in_game' &&
      typeof message.roomId === 'string' &&
      typeof message.reconnectToken === 'string'
    ) {
      client.roomId = message.roomId
      client.reconnectToken = message.reconnectToken
      sendClientMessage(client, {
        type: 'resume_room',
        roomId: message.roomId,
        reconnectToken: message.reconnectToken,
      })
      return
    }

    if (message.type === 'room_resumed') {
      client.resumeConfirmed = true
      if (typeof message.roomId === 'string') {
        client.roomId = message.roomId
      }
      if (typeof message.seat === 'string') {
        client.seat = message.seat
      }
      return
    }

    if (isRoomSnapshot(message)) {
      client.roomId = message.roomId
      client.seat = message.yourSeat
      if (message.reconnectToken !== null) {
        client.reconnectToken = message.reconnectToken
      }

      const room =
        rooms.get(message.roomId) ??
        {
          roomId: message.roomId,
          phases: new Set<string>(),
          snapshotCount: 0,
          seats: new Set<string>(),
          reconnectTokens: new Map<number, string>(),
          actionCount: 0,
        }

      room.snapshotCount += 1
      if (message.yourSeat !== null) {
        room.seats.add(message.yourSeat)
      }
      if (message.reconnectToken !== null) {
        room.reconnectTokens.set(client.id, message.reconnectToken)
      }
      const phase = message.game?.authoritativePhase ?? null
      if (phase !== null) {
        room.phases.add(phase)
      }
      if (message.game?.scoring !== null && message.game?.scoring !== undefined) {
        room.phases.add('scoring')
      }
      if (message.game?.matchEnded !== null && message.game?.matchEnded !== undefined) {
        room.phases.add('match-ended')
      }
      rooms.set(message.roomId, room)

      maybeSubmitAction(client, message, rooms)
    }
  })

  ws.on('error', (error) => {
    client.errors.push(error.message)
  })

  ws.on('close', () => {
    client.open = false
  })

  await awaitableRace(
    new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        client.open = true
        if (resume !== undefined) {
          sendClientMessage(client, {
            type: 'resume_room',
            roomId: resume.roomId,
            reconnectToken: resume.reconnectToken,
          })
        }
        resolve()
      })
      ws.once('error', reject)
    }),
    5000,
    `Timed out opening websocket for client=${client.id}.`,
  )
}

function closeClient(client: ClientRecord): Promise<void> {
  if (client.ws === null) {
    return Promise.resolve()
  }

  const ws = client.ws
  client.ws = null

  if (ws.readyState === WebSocket.CLOSED) {
    client.open = false
    return Promise.resolve()
  }

  return awaitableRace(
    new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.close()
    }),
    3000,
    `Timed out closing websocket for client=${client.id}.`,
  ).catch(() => {
    ws.terminate()
  })
}

function summarizeDistribution(health: HealthPayload): Record<string, number> {
  assert.notEqual(health.gameWorkerPool, null)
  return Object.fromEntries(
    health.gameWorkerPool!.workers.map((worker) => [
      worker.workerId,
      worker.assignedRooms,
    ]),
  )
}

function assertFourWorkerRoomDistribution(health: HealthPayload, expectedRooms: number): void {
  assert.notEqual(health.gameWorkerPool, null)
  assert.equal(health.gameWorkerPool!.workerCount, 4)
  assert.equal(health.gameWorkerPool!.readyWorkers, 4)
  assert.equal(health.gameWorkerPool!.failedWorkers, 0)
  assert.equal(health.gameWorkerPool!.totalAssignedRooms, expectedRooms)
  assert.deepStrictEqual(
    health.gameWorkerPool!.workers.map((worker) => worker.assignedRooms),
    [1, 1, 1, 1],
  )
}

function summarizeRooms(rooms: Map<string, RoomRecord>): Array<{
  roomId: string
  phases: string[]
  snapshots: number
  seats: string[]
  actions: number
}> {
  return [...rooms.values()]
    .sort((a, b) => a.roomId.localeCompare(b.roomId, 'en'))
    .map((room) => ({
      roomId: room.roomId,
      phases: [...room.phases].sort(),
      snapshots: room.snapshotCount,
      seats: [...room.seats].sort(),
      actions: room.actionCount,
    }))
}

function getSqliteErrorLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => /SQLITE_|sqlite.*error|database.*error|failed to apply migration/i.test(line))
}

function tailOutput(output: string, maxLines = 80): string {
  return output
    .split(/\r?\n/)
    .slice(-maxLines)
    .join('\n')
}

function countActiveRoomSnapshots(databaseFile: string): number {
  const db = new DatabaseSync(databaseFile, {
    open: true,
    readOnly: true,
  })

  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM active_room_snapshots
         WHERE is_active = 1;`,
      )
      .get() as { count: number }

    return row.count
  } finally {
    db.close()
  }
}

function assertNoClientErrors(clients: readonly ClientRecord[]): void {
  const errors = clients.flatMap((client) =>
    client.errors.map((error) => `client=${client.id}: ${error}`),
  )
  assert.deepStrictEqual(errors, [])
}

async function runFullServerValidation(): Promise<void> {
  const originalServerRoot = process.cwd()
  const testRoot = await createIsolatedServerRoot(originalServerRoot)
  const port = await getFreePort()
  let server: RunningServer | null = null
  let restartServer: RunningServer | null = null
  const clients: ClientRecord[] = []
  const rooms = new Map<string, RoomRecord>()
  const runId = `${Date.now()}-${process.pid}`

  try {
    server = await startServer(testRoot, port)
    const startupHealth = await waitForPoolReady(port)
    console.log('  startup health:', JSON.stringify(summarizeDistribution(startupHealth)))

    for (let index = 1; index <= CLIENT_COUNT; index += 1) {
      clients.push(await registerClient(port, index, runId))
    }

    await Promise.all(clients.map((client) => connectClient(port, client, rooms)))
    await Promise.all(
      clients.map(async (client) => {
        sendClientMessage(client, {
          type: 'join_matchmaking',
          stake: STAKE,
          displayName: client.displayName,
        })
      }),
    )

    await waitFor(
      'four matchmaking rooms',
      () => rooms.size === EXPECTED_ROOM_COUNT && clients.every((client) => client.roomId !== null),
      MATCHMAKING_TIMEOUT_MS,
    )

    const afterMatchHealth = await waitForPoolReady(port)
    assertFourWorkerRoomDistribution(afterMatchHealth, EXPECTED_ROOM_COUNT)
    console.log('  after matchmaking distribution:', JSON.stringify(summarizeDistribution(afterMatchHealth)))

    await waitFor(
      'cutting, bidding, playing, and scoring snapshots',
      () =>
        rooms.size === EXPECTED_ROOM_COUNT &&
        [...rooms.values()].every(
          (room) =>
            room.phases.has('cutting') &&
            room.phases.has('bidding') &&
            room.phases.has('playing') &&
            room.phases.has('scoring'),
        ),
      GAMEPLAY_TIMEOUT_MS,
    )

    assert.equal(countActiveRoomSnapshots(testRoot.databaseFile), EXPECTED_ROOM_COUNT)
    assertNoClientErrors(clients)
    console.log('  gameplay rooms:', JSON.stringify(summarizeRooms(rooms)))
    console.log('  active snapshots before restart:', countActiveRoomSnapshots(testRoot.databaseFile))

    const reconnectClient = clients[0]!
    assert.notEqual(reconnectClient.roomId, null)
    assert.notEqual(reconnectClient.reconnectToken, null)
    const reconnectRoomId = reconnectClient.roomId!
    const reconnectToken = reconnectClient.reconnectToken!
    const reconnectMessageOffset = reconnectClient.messages.length
    await closeClient(reconnectClient)
    await connectClient(port, reconnectClient, rooms, {
      roomId: reconnectRoomId,
      reconnectToken,
    })
    await waitFor(
      'single client reconnect',
      () =>
        reconnectClient.resumeConfirmed ||
        reconnectClient.messages
          .slice(reconnectMessageOffset)
          .some((m) => m.type === 'room_snapshot' && m.roomId === reconnectRoomId),
      RESTORE_TIMEOUT_MS,
    )
    console.log(
      '  reconnect result:',
      JSON.stringify({
        client: reconnectClient.id,
        roomId: reconnectRoomId,
        resumeConfirmed: reconnectClient.resumeConfirmed,
      }),
    )

    for (const client of clients) {
      assert.notEqual(client.roomId, null, `client=${client.id} missing room before restart`)
      assert.notEqual(client.reconnectToken, null, `client=${client.id} missing reconnect token before restart`)
    }

    const restoreTargets = clients.map((client) => ({
      client,
      roomId: client.roomId!,
      reconnectToken: client.reconnectToken!,
    }))
    const restoreMessageOffsets = new Map(
      restoreTargets.map(({ client }) => [client.id, client.messages.length] as const),
    )

    await Promise.all(clients.map(closeClient))
    await stopServer(server)
    const firstOutput = server.output()
    const firstSqliteErrors = getSqliteErrorLines(firstOutput)
    assert.deepStrictEqual(firstSqliteErrors, [])
    server = null

    restartServer = await startServer(testRoot, port)
    const restartHealth = await waitForPoolReady(port)
    assertFourWorkerRoomDistribution(restartHealth, EXPECTED_ROOM_COUNT)
    console.log('  restart distribution:', JSON.stringify(summarizeDistribution(restartHealth)))

    await Promise.all(
      restoreTargets.map(({ client, roomId, reconnectToken }) =>
        connectClient(port, client, rooms, { roomId, reconnectToken }),
      ),
    )

    await waitFor(
      'all clients resume after restart',
      () =>
        restoreTargets.every(({ client }) =>
          client.resumeConfirmed ||
          client.messages.some(
            (message, index) =>
              index >= (restoreMessageOffsets.get(client.id) ?? 0) &&
              message.type === 'room_snapshot' &&
              message.roomId === client.roomId,
          ),
        ),
      RESTORE_TIMEOUT_MS,
    )

    await sleep(1000)
    assert.equal(countActiveRoomSnapshots(testRoot.databaseFile), EXPECTED_ROOM_COUNT)
    assertNoClientErrors(clients)
    const finalHealth = await waitForPoolReady(port)
    assertFourWorkerRoomDistribution(finalHealth, EXPECTED_ROOM_COUNT)
    const finalActiveSnapshotCount = countActiveRoomSnapshots(testRoot.databaseFile)
    assert.equal(finalActiveSnapshotCount, EXPECTED_ROOM_COUNT)

    await Promise.all(clients.map(closeClient))
    await stopServer(restartServer)
    const secondOutput = restartServer.output()
    const secondSqliteErrors = getSqliteErrorLines(secondOutput)
    assert.deepStrictEqual(secondSqliteErrors, [])
    restartServer = null

    assert.deepStrictEqual(unhandledErrors, [])
    console.log('  restore rooms:', JSON.stringify(summarizeRooms(rooms)))
    console.log('  active snapshots after restart:', finalActiveSnapshotCount)
    console.log('  sqlite errors:', JSON.stringify([...firstSqliteErrors, ...secondSqliteErrors]))
    console.log(
      '  shutdown:',
      JSON.stringify({
        firstServerStopped: true,
        restartedServerStopped: true,
        tempDatabase: basename(testRoot.databaseFile),
      }),
    )
  } catch (error: unknown) {
    if (server !== null) {
      console.error('  first server output tail:\n' + tailOutput(server.output()))
    }
    if (restartServer !== null) {
      console.error('  restart server output tail:\n' + tailOutput(restartServer.output()))
    }
    throw error
  } finally {
    await Promise.all(clients.map(closeClient)).catch(() => {})
    if (server !== null) {
      await stopServer(server).catch(() => {})
    }
    if (restartServer !== null) {
      await stopServer(restartServer).catch(() => {})
    }
    await unlink(join(testRoot.server, 'node_modules')).catch(() => {})
    await unlink(join(testRoot.root, 'node_modules')).catch(() => {})
    await testRoot.cleanup()
  }
}

console.log('\n=== Game worker full-server validation ===')

await check('F1: four-worker backend validates WebSocket gameplay, persistence restore, reconnect, restart, and shutdown', async () => {
  await runFullServerValidation()
})

if (failCount > 0) {
  console.error(`\nGame worker full-server validation failed: ${failCount} failed, ${passCount} passed.`)
  process.exitCode = 1
} else {
  console.log(`\nGame worker full-server validation passed: ${passCount} checks.`)
}
