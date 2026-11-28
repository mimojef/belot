/**
 * checkTableChatWebSocket.ts — Етап 1: общият текстов чат на чакалните, реален сървър.
 *
 * Изолиран сървър (временна база), реални HTTP регистрации и отделни WebSocket
 * връзки. Помощните функции са взети 1:1 от checkPrivateRoomWebSocketRoundTrip.ts.
 * Покрива: стар и нов протокол срещу една и съща маса на Белот (споделена
 * история, доставка в стария формат), външен потребител, член на друга маса,
 * чужд gameId с валиден tableId, невалидни кадри, reconnect с нова връзка,
 * напускане. Mute/лимити: checkTableChatService.ts + checkUnifiedMuteWebSocket.ts.
 *
 * Пускане: cd server && npx tsx scripts/checkTableChatWebSocket.ts
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { verifyVerificationCode } from '../src/db/authHelpers.js'

// Email-verification pending-first registration (виж checkAuthSessionRollingRenewal.ts):
// известен тестов secret на spawned сървъра, за да може 6-цифреният код да се
// извлече от DB-съхранения code_hash със СЪЩИЯ production HMAC helper — тестът
// контролира и secret-а, и DB файла, не е production security bypass.
const TEST_REGISTRATION_SECRET = 'table-chat-ws-registration-secret-0123456789'
let testDatabaseFile = ''

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed++
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${msg}`)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const srv = createServer()
    srv.once('error', () => resolveFree(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolveFree(true)))
  })
}

async function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') { reject(new Error('no port')); return }
      const p = addr.port
      srv.close(() => resolveFree(p))
    })
  })
}

async function waitForCondition(label: string, predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

async function httpJson(
  port: number,
  method: string,
  pathname: string,
  cookie: string | null,
  body?: unknown,
): Promise<{ status: number; body: any; setCookie: string | null }> {
  const res = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, body: json, setCookie }
}

// ─── Isolated server (same model as checkVoluntaryLeaveChatGate.ts) ────────

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-table-chat-ws-'))
  const serverDir = join(root, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(originalServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(originalServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(originalServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(originalServerRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)
  return {
    serverDir,
    cleanup: () => retryRm(root),
  }
}

type RunningServer = { child: ChildProcessByStdio<null, Readable, Readable>; output(): string }

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port), PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_REGISTRATION_SECRET },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c))
  child.stderr.on('data', (c) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

// Пише директно в ИЗОЛИРАНИЯ temp DB на spawned сървъра (тестът го притежава) —
// hasEnoughBalance() чете profile_wallets на всяко извикване, без кеш.
function setWalletBalance(profileId: string, amount: number): void {
  const db = new DatabaseSync(testDatabaseFile, { open: true, timeout: 5_000 })
  try {
    const res = db.prepare('UPDATE profile_wallets SET yellow_coins_balance = ? WHERE profile_id = ?').run(amount, profileId)
    if (Number(res.changes) === 0) {
      db.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?)').run(profileId, amount)
    }
  } finally {
    db.close()
  }
}

function bruteForceVerificationCode(databaseFilePath: string, pendingRegistrationId: string, secret: string): string {
  const db = new DatabaseSync(databaseFilePath, { open: true })
  const row = db.prepare(`SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?`).get(pendingRegistrationId) as
    | { code_hash: string }
    | undefined
  db.close()
  if (!row) throw new Error(`pending_registrations row not found: ${pendingRegistrationId}`)
  for (let candidate = 0; candidate < 1_000_000; candidate++) {
    const code = candidate.toString().padStart(6, '0')
    if (verifyVerificationCode(code, secret, row.code_hash)) return code
  }
  throw new Error(`Could not brute-force the verification code for ${pendingRegistrationId}`)
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

// ─── Test harness: one WS client per human participant ────────────────────

type TestClient = {
  profileId: string
  cookie: string
  ws: WebSocket
  frames: any[]
}

async function registerProfile(port: number, tag: string): Promise<{ cookie: string; profileId: string }> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `private-room-ws-${tag}-${runId}@example.test`,
    password: 'PrivateRoomWsDiag1!',
    displayName: `PRW ${tag}`,
    gender: 'male',
    visitorId: randomUUID(),
  })
  // pendingRegistrationId се връща и на 503 EMAIL_DELIVERY_FAILED (Brevo не е
  // configured в тестовата среда — очаквано, pending редът persists).
  const pendingRegistrationId: string | undefined = reg.body?.pendingRegistrationId
  if (!pendingRegistrationId) throw new Error(`Registration failed for ${tag}: ${JSON.stringify(reg.body)}`)
  const code = bruteForceVerificationCode(testDatabaseFile, pendingRegistrationId, TEST_REGISTRATION_SECRET)
  // bruteForceVerificationCode блокира event loop-а синхронно и понякога прави
  // keep-alive връзката към spawned сървъра stale (ECONNRESET, чисто transient) —
  // един бърз retry е достатъчен (същото като checkAuthSessionRollingRenewal.ts).
  const verifyBody = { pendingRegistrationId, code, rememberMe: true }
  let verified: Awaited<ReturnType<typeof httpJson>>
  try {
    verified = await httpJson(port, 'POST', '/api/auth/verify-registration-email', null, verifyBody)
  } catch {
    await sleep(200)
    verified = await httpJson(port, 'POST', '/api/auth/verify-registration-email', null, verifyBody)
  }
  if (verified.status !== 200) throw new Error(`Email verification failed for ${tag}: ${JSON.stringify(verified.body)}`)
  return { cookie: verified.setCookie as string, profileId: verified.body.session.profile.profileId }
}

async function connectClient(port: number, tag: string): Promise<TestClient> {
  const { cookie, profileId } = await registerProfile(port, tag)
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: cookie } })
  const frames: any[] = []
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ }
  })
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen())
    ws.once('error', reject)
  })
  return { profileId, cookie, ws, frames }
}

function send(client: TestClient, message: Record<string, unknown>): void {
  client.ws.send(JSON.stringify(message))
}

async function reconnectClient(port: number, previous: TestClient): Promise<TestClient> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: previous.cookie } })
  const frames: any[] = []
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ }
  })
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen())
    ws.once('error', reject)
  })
  return { profileId: previous.profileId, cookie: previous.cookie, ws, frames }
}

function framesOfType(client: TestClient, type: string): any[] {
  return client.frames.filter((f) => f.type === type)
}

function occupiedCount(room: any): number {
  return room.slots.filter((s: any) => s.occupant !== null).length
}

function slotOccupant(room: any, team: 'A' | 'B', slotIndex: 0 | 1): any {
  return room.slots.find((s: any) => s.team === team && s.slotIndex === slotIndex)?.occupant ?? null
}

function isActiveServerAuthoritativeRoomSnapshot(frame: any, roomId: string): boolean {
  return (
    frame.type === 'room_snapshot' &&
    frame.roomId === roomId &&
    frame.roomStatus === 'playing' &&
    frame.game !== null &&
    frame.game !== undefined &&
    frame.game.phase !== null &&
    frame.game.phase !== 'bootstrap' &&
    frame.game.authoritativePhase !== null &&
    frame.game.authoritativePhase !== undefined
  )
}

async function waitForFrame(
  client: TestClient,
  predicate: (frame: any) => boolean,
  timeoutMs = 10_000,
  label = 'frame',
): Promise<any> {
  try {
    await waitForCondition(label, () => client.frames.some(predicate), timeoutMs)
  } catch (err) {
    console.error(`[debug] frames received while waiting for "${label}":`, JSON.stringify(client.frames, null, 2))
    throw err
  }
  return client.frames.find(predicate)
}

console.log('\ncheckTableChatWebSocket\n')

let server: RunningServer | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)
testDatabaseFile = join(isolated.serverDir, 'database', 'data', 'belot-v2.sqlite')

const chatTypes = new Set(['private_room_chat_message', 'table_chat_message'])
function chatBodies(client: TestClient): string[] {
  return client.frames.filter((f) => chatTypes.has(f.type)).map((f) => f.body)
}

try {
  const port = await findFreePort()
  if (!(await isPortFree(port))) throw new Error(`Port ${port} in use`)
  server = startServer(isolated.serverDir, port)
  console.log(`Waiting for server on port ${port}...`)
  try {
    await waitForCondition('backend health', async () => {
      try {
        const r = await fetch(`http://localhost:${port}/health`)
        const h = await r.json()
        return r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready'
      } catch { return false }
    }, 30_000)
  } catch (err) {
    console.error('--- server output ---')
    console.error(server.output())
    throw err
  }
  console.log('Server ready.\n')

  const host = await connectClient(port, 'tcHost')
  let guest = await connectClient(port, 'tcGuest')
  const outsider = await connectClient(port, 'tcOut')
  const otherHost = await connectClient(port, 'tcOther')

  send(host, { type: 'create_private_room', stake: 5000, isLocked: false })
  const created = await waitForFrame(host, (f) => f.type === 'private_room_updated', 10_000, 'create_private_room ack')
  const roomId: string = created.room.id
  send(guest, { type: 'join_private_room', privateRoomId: roomId, team: 'B', slotIndex: 0 })
  await waitForFrame(host, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 2, 10_000, 'guest joined')

  send(otherHost, { type: 'create_private_room', stake: 5000, isLocked: false })
  const otherCreated = await waitForFrame(otherHost, (f) => f.type === 'private_room_updated', 10_000, 'second room ack')
  const otherRoomId: string = otherCreated.room.id

  await check('[W1] OLD protocol: subscribe -> private_room_chat_history (old shape) for both members', async () => {
    send(host, { type: 'subscribe_private_room_chat', privateRoomId: roomId })
    send(guest, { type: 'subscribe_private_room_chat', privateRoomId: roomId })
    for (const c of [host, guest]) {
      const h = await waitForFrame(c, (f) => f.type === 'private_room_chat_history' && f.privateRoomId === roomId, 5_000, 'legacy history')
      if (!Array.isArray(h.messages) || h.messages.length !== 0) throw new Error('expected empty history')
      if ('gameId' in h || 'tableId' in h) throw new Error('legacy history must keep the old shape')
    }
  })

  await check('[W2] OLD protocol: send -> private_room_chat_message to both members; requestId only to the sender', async () => {
    send(host, { type: 'send_private_room_chat_message', privateRoomId: roomId, body: 'стар протокол', requestId: 'w2' })
    const own = await waitForFrame(host, (f) => f.type === 'private_room_chat_message' && f.body === 'стар протокол', 5_000, 'host echo')
    const other = await waitForFrame(guest, (f) => f.type === 'private_room_chat_message' && f.body === 'стар протокол', 5_000, 'guest receives')
    if (own.requestId !== 'w2' || 'requestId' in other) throw new Error(`requestId: own=${own.requestId} other=${other.requestId}`)
    if (own.privateRoomId !== roomId || own.senderProfileId !== host.profileId) throw new Error('fields')
  })

  await check('[W3] NEW protocol: subscribe_table_chat{belot} -> table_chat_history with the same history', async () => {
    send(guest, { type: 'subscribe_table_chat', gameId: 'belot', tableId: roomId })
    const h = await waitForFrame(guest, (f) => f.type === 'table_chat_history' && f.tableId === roomId, 5_000, 'table history')
    if (h.gameId !== 'belot' || h.messages.length !== 1 || h.messages[0].body !== 'стар протокол') throw new Error(JSON.stringify(h))
  })

  await check('[W4] NEW protocol: send_table_chat_message -> delivered as private_room_chat_message (old clients keep working)', async () => {
    send(guest, { type: 'send_table_chat_message', gameId: 'belot', tableId: roomId, body: 'нов протокол', requestId: 'w4' })
    const own = await waitForFrame(guest, (f) => f.type === 'private_room_chat_message' && f.body === 'нов протокол', 5_000, 'guest echo')
    await waitForFrame(host, (f) => f.type === 'private_room_chat_message' && f.body === 'нов протокол', 5_000, 'host (old client) receives')
    if (own.requestId !== 'w4') throw new Error('requestId echo')
    if ([host, guest].some((c) => c.frames.some((f) => f.type === 'table_chat_message'))) throw new Error('Belot must keep the legacy delivery format')
  })

  await check('[W5] outsider: subscribe/send over BOTH protocols -> not_member; nothing leaks either way', async () => {
    send(outsider, { type: 'subscribe_table_chat', gameId: 'belot', tableId: roomId })
    send(outsider, { type: 'send_table_chat_message', gameId: 'belot', tableId: roomId, body: 'натрапник 1', requestId: 'o1' })
    send(outsider, { type: 'subscribe_private_room_chat', privateRoomId: roomId })
    send(outsider, { type: 'send_private_room_chat_message', privateRoomId: roomId, body: 'натрапник 2' })
    await waitForCondition('outsider errors', () => outsider.frames.filter((f) => (f.type === 'table_chat_error' || f.type === 'private_room_chat_error') && f.code === 'not_member').length === 4, 5_000)
    const sendErr = outsider.frames.find((f) => f.type === 'table_chat_error' && f.requestId === 'o1')
    if (sendErr?.gameId !== 'belot' || sendErr.tableId !== roomId) throw new Error('table_chat_error fields')
    await sleep(300)
    if (outsider.frames.some((f) => f.type === 'table_chat_history' || f.type === 'private_room_chat_history')) throw new Error('outsider got history')
    if (chatBodies(outsider).length !== 0) throw new Error('outsider received chat')
    if ([...chatBodies(host), ...chatBodies(guest)].some((b) => b.startsWith('натрапник'))) throw new Error('intruder message delivered')
  })

  await check('[W6] member of ANOTHER table: naming this table (any game id) -> not_member; its own messages stay in its table', async () => {
    send(otherHost, { type: 'subscribe_table_chat', gameId: 'belot', tableId: roomId })
    send(otherHost, { type: 'subscribe_table_chat', gameId: 'svara', tableId: otherRoomId })
    send(otherHost, { type: 'send_table_chat_message', gameId: 'svara', tableId: otherRoomId, body: 'чужда игра' })
    await waitForCondition('other errors', () => otherHost.frames.filter((f) => f.type === 'table_chat_error' && f.code === 'not_member').length === 3, 5_000)
    send(otherHost, { type: 'send_table_chat_message', gameId: 'belot', tableId: otherRoomId, body: 'друга маса' })
    await waitForFrame(otherHost, (f) => f.type === 'private_room_chat_message' && f.body === 'друга маса', 5_000, 'own table delivery')
    await sleep(300)
    if ([...chatBodies(host), ...chatBodies(guest)].includes('друга маса')) throw new Error('cross-table leak')
    send(otherHost, { type: 'subscribe_table_chat', gameId: 'belot', tableId: otherRoomId })
    const h = await waitForFrame(otherHost, (f) => f.type === 'table_chat_history' && f.tableId === otherRoomId, 5_000, 'own history')
    if (h.messages.map((m: any) => m.body).join('|') !== 'друга маса') throw new Error(`own history ${JSON.stringify(h.messages)}`)
  })

  await check('[W7] malformed table_chat frames are rejected by the parser (no chat reply); the connection keeps working', async () => {
    const before = host.frames.length
    host.ws.send(JSON.stringify({ type: 'subscribe_table_chat', gameId: 'BELOT', tableId: roomId }))
    host.ws.send(JSON.stringify({ type: 'subscribe_table_chat', gameId: 'belot' }))
    host.ws.send(JSON.stringify({ type: 'send_table_chat_message', gameId: 'belot', tableId: roomId, body: 42 }))
    await sleep(400)
    if (host.frames.slice(before).some((f) => typeof f.type === 'string' && f.type.startsWith('table_chat'))) throw new Error('malformed frame produced a chat reply')
    send(host, { type: 'subscribe_table_chat', gameId: 'belot', tableId: roomId })
    await waitForFrame(host, (f) => f.type === 'table_chat_history' && f.tableId === roomId, 5_000, 'still works')
  })

  await check('[W8] reconnect with a NEW connection: history available, messages reach the new connection', async () => {
    guest.ws.close()
    await sleep(300)
    const reconnected = await reconnectClient(port, guest)
    send(reconnected, { type: 'request_private_rooms_list' })
    await waitForFrame(reconnected, (f) => f.type === 'private_room_updated' && f.room.id === roomId, 10_000, 'membership restored')
    guest = reconnected
    send(guest, { type: 'subscribe_table_chat', gameId: 'belot', tableId: roomId })
    const h = await waitForFrame(guest, (f) => f.type === 'table_chat_history' && f.tableId === roomId, 5_000, 'history after reconnect')
    if (h.messages.map((m: any) => m.body).join('|') !== 'стар протокол|нов протокол') throw new Error(JSON.stringify(h.messages))
    send(host, { type: 'send_private_room_chat_message', privateRoomId: roomId, body: 'след reconnect' })
    await waitForFrame(guest, (f) => f.type === 'private_room_chat_message' && f.body === 'след reconnect', 5_000, 'new connection receives')
  })

  await check('[W9] after leaving the table: refused on both protocols and no longer receives messages', async () => {
    send(guest, { type: 'leave_private_room' })
    await waitForFrame(host, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 1, 10_000, 'guest left')
    const errorsBefore = guest.frames.filter((f) => f.code === 'not_member').length
    send(guest, { type: 'subscribe_table_chat', gameId: 'belot', tableId: roomId })
    send(guest, { type: 'send_private_room_chat_message', privateRoomId: roomId, body: 'след напускане' })
    await waitForCondition('left errors', () => guest.frames.filter((f) => f.code === 'not_member').length === errorsBefore + 2, 5_000)
    send(host, { type: 'send_private_room_chat_message', privateRoomId: roomId, body: 'само хостът' })
    await waitForFrame(host, (f) => f.type === 'private_room_chat_message' && f.body === 'само хостът', 5_000, 'host echo')
    await sleep(300)
    if (chatBodies(guest).includes('само хостът')) throw new Error('former member received a message')
    if (chatBodies(host).includes('след напускане')) throw new Error('former member message delivered')
  })

  for (const c of [host, guest, outsider, otherHost]) { try { c.ws.close() } catch { /* ignore */ } }
} finally {
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
