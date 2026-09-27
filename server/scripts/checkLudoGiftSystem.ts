/**
 * checkLudoGiftSystem.ts
 *
 * Real spawned-server, real WebSocket integration test за Ludo in-game
 * gifts (виж task-а "Ludo подаръци") — следва established isolated-server
 * pattern (виж checkLudoSpectatorSubscription.ts / checkGiftItemSystem.ts).
 *
 * Покрива (виж task-а §14):
 *   [A1] Успешен gift send между 2 participants — debit, ludo_gift_sent
 *        стига до подателя И получателя, ludo_gift_send_result ok:true с
 *        коректен senderBalanceAfter.
 *   [A2] Server отхвърля self-gift (recipientProfileId === sender).
 *   [A3] Server отхвърля recipient извън СЪЩИЯ match (реален профил, но не
 *        участник в тоя match).
 *   [A4] Insufficient balance — ok:false, НЯМА debit, НЯМА broadcast.
 *   [A5] Idempotent replay — същия requestId два пъти -> вторият е
 *        isReplay:true, БЕЗ втори debit/broadcast.
 *   [A6] Spectator НЕ може да прати gift (send_ludo_gift рефлектиран с
 *        'Не участваш в тази игра.'), НО вижда realtime анимацията, когато
 *        реален participant прати gift.
 *   [A7] 4-player match — gift към конкретен opponent каца в ТОЧНИЯ negov
 *        recipientColor, никога в чужд.
 *   [A8] Reconnect-safety — ludo_game_state_request след успешен gift
 *        връща activeLudoGifts с коректен recipientColor/expiresAt (~60s).
 *   [A9] Catalog reuse — GET /api/gift-items връща СЪЩИЯ catalog ред,
 *        seed-нат directno в gift_items (нула паралелен Ludo-only каталог).
 *   [F1-F6] Frontend source-review (regex) — gift icon gate-ове, recipient
 *        binding, spectator no-send-controls, 60s timer non-restart wiring,
 *        reconnect/destroy cleanup wiring.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { verifyVerificationCode } from '../src/db/authHelpers.js'

const TEST_REGISTRATION_SECRET = 'ludo-gift-system-ws-registration-secret-0123456789'
let dbFile = ''

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
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
async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)
const projectRoot = resolve(sourceServerRoot, '..')

async function createIsolatedServerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'belot-ludo-gift-'))
  const serverDir = join(root, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(sourceServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(sourceServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(sourceServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(sourceServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(sourceServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(sourceServerRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)
  return { serverDir, dbFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'), cleanup: () => retryRm(root) }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }
function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_REGISTRATION_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c)); child.stderr.on('data', (c) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}
async function waitForHealth(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      const h = await r.json()
      if (r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready') return true
    } catch { /* retry */ }
    await sleep(200)
  }
  return false
}
async function killServer(server: RunningServer | null): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  server.child.kill('SIGKILL')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 8_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

function bruteForceVerificationCode(pendingRegistrationId: string): string {
  const db = new DatabaseSync(dbFile, { open: true })
  const row = db.prepare(`SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?`).get(pendingRegistrationId) as
    | { code_hash: string }
    | undefined
  db.close()
  if (!row) throw new Error(`pending_registrations row not found: ${pendingRegistrationId}`)
  for (let candidate = 0; candidate < 1_000_000; candidate++) {
    const code = candidate.toString().padStart(6, '0')
    if (verifyVerificationCode(code, TEST_REGISTRATION_SECRET, row.code_hash)) return code
  }
  throw new Error(`Could not brute-force the verification code for ${pendingRegistrationId}`)
}

type TestClient = { profileId: string; cookie: string; ws: WebSocket; frames: any[] }
async function registerAndLogin(port: number, tag: string, runId: string) {
  const email = `ludo-gift-${tag}-${runId}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, password: 'LudoGift1!', displayName: `LG${tag}${runId.slice(-5)}`, gender: 'male',
      visitorId: randomUUID(),
    }),
  })
  const body = await res.json()
  const pendingRegistrationId: string | undefined = body?.pendingRegistrationId
  if (!pendingRegistrationId) throw new Error(`register ${tag} failed: ${JSON.stringify(body)}`)
  const code = bruteForceVerificationCode(pendingRegistrationId)
  let verifyRes: Response
  try {
    verifyRes = await fetch(`http://127.0.0.1:${port}/api/auth/verify-registration-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingRegistrationId, code, rememberMe: true }),
    })
  } catch {
    await sleep(200)
    verifyRes = await fetch(`http://127.0.0.1:${port}/api/auth/verify-registration-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingRegistrationId, code, rememberMe: true }),
    })
  }
  const verifyBody = await verifyRes.json()
  if (verifyRes.status !== 200) throw new Error(`verify-registration-email ${tag} failed: ${JSON.stringify(verifyBody)}`)
  const setCookie = (verifyRes.headers.getSetCookie?.()[0] ?? verifyRes.headers.get('set-cookie'))?.split(';')[0] ?? null
  if (!setCookie) throw new Error('no cookie returned')
  return { cookie: setCookie, profileId: verifyBody.session.profile.profileId as string }
}
async function connectWs(port: number, cookie: string, profileId: string): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
  const frames: any[] = []
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ } })
  await new Promise<void>((resolveOpen, reject) => { ws.once('open', () => resolveOpen()); ws.once('error', reject) })
  return { profileId, cookie, ws, frames }
}
function send(c: TestClient, m: Record<string, unknown>): void { c.ws.send(JSON.stringify(m)) }
async function waitForFrame(c: TestClient, pred: (f: any) => boolean, timeoutMs = 10_000, label = 'frame'): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = c.frames.find(pred)
    if (found) return found
    await sleep(80)
  }
  console.error(`[debug] frames for "${label}":`, JSON.stringify(c.frames.map((f) => f.type)))
  const errorFrame = c.frames.find((f) => f.type === 'error')
  if (errorFrame) console.error(`[debug] error frame content for "${label}":`, JSON.stringify(errorFrame))
  throw new Error(`Timeout waiting for ${label}`)
}
async function waitBriefly(c: TestClient, pred: (f: any) => boolean, waitMs = 1_500): Promise<any | null> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const found = c.frames.find(pred)
    if (found) return found
    await sleep(80)
  }
  return null
}

function setWalletBalance(profileId: string, amount: number): void {
  const db = new DatabaseSync(dbFile, { open: true, timeout: 5_000 })
  try {
    const res = db.prepare('UPDATE profile_wallets SET yellow_coins_balance = ? WHERE profile_id = ?').run(amount, profileId)
    if (Number(res.changes) === 0) {
      db.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?)').run(profileId, amount)
    }
  } finally {
    db.close()
  }
}
function getWalletBalance(profileId: string): number {
  const db = new DatabaseSync(dbFile, { open: true, timeout: 5_000 })
  try {
    const row = db.prepare('SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?').get(profileId) as
      | { yellow_coins_balance: number }
      | undefined
    return row?.yellow_coins_balance ?? 0
  } finally {
    db.close()
  }
}
function seedGiftItem(giftItemId: string, name: string, imageUrl: string, price: number): void {
  const db = new DatabaseSync(dbFile, { open: true, timeout: 5_000 })
  try {
    db.prepare(
      `INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, 0)
       ON CONFLICT(gift_item_id) DO UPDATE SET name=excluded.name, image_url=excluded.image_url, price=excluded.price, is_active=1`,
    ).run(giftItemId, name, imageUrl, price)
  } finally {
    db.close()
  }
}
function countGiftTransactions(requestId: string): number {
  const db = new DatabaseSync(dbFile, { open: true, timeout: 5_000 })
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM gift_item_transactions WHERE request_id = ?').get(requestId) as { c: number }
    return row.c
  } finally {
    db.close()
  }
}

async function createNpMatch(port: number, tag: string, playerCount: 2 | 4): Promise<{ clients: TestClient[]; matchId: string }> {
  const registrations = await Promise.all(
    Array.from({ length: playerCount }, (_, i) => registerAndLogin(port, `${tag}${i}`, runId)),
  )
  registrations.forEach((r) => setWalletBalance(r.profileId, 50_000))
  const clients = await Promise.all(registrations.map((r) => connectWs(port, r.cookie, r.profileId)))
  send(clients[0]!, { type: 'create_ludo_room', stake: STAKE, playerCount, manualStart: false })
  const roomFrame = await waitForFrame(clients[0]!, (f) => f.type === 'ludo_room_updated', 10_000, `${tag} room created`)
  for (let i = 1; i < clients.length; i++) {
    send(clients[i]!, { type: 'join_ludo_room', ludoRoomId: roomFrame.room.id })
  }
  const started = await waitForFrame(clients[0]!, (f) => f.type === 'ludo_game_started', 10_000, `${tag} auto-start`)
  for (let i = 1; i < clients.length; i++) {
    await waitForFrame(clients[i]!, (f) => f.type === 'ludo_game_started', 10_000, `${tag} started (client ${i})`)
  }
  return { clients, matchId: started.snapshot.matchId }
}
function colorOf(matchClients: TestClient[], startedFrame: any, client: TestClient): string {
  return startedFrame.snapshot.players.find((p: any) => p.profileId === client.profileId)?.color
}
function latestParticipantSnapshotFrame(c: TestClient): any {
  return c.frames.filter((f) => f.type === 'ludo_game_started' || f.type === 'ludo_game_state').pop()
}

console.log('\ncheckLudoGiftSystem\n')

const isolated = await createIsolatedServerRoot()
dbFile = isolated.dbFile
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const STAKE = 5000
const GIFT_ITEM_ID = `test-gift-${runId}`
const GIFT_NAME = 'Тестов подарък'
const GIFT_IMAGE_URL = `https://example.test/gifts/${runId}.png`
const GIFT_PRICE = 100

let server: RunningServer | null = null

try {
  const port = await findFreePort()
  server = startServer(isolated.serverDir, port)
  console.log(`Waiting for server on port ${port}...`)
  if (!(await waitForHealth(port))) { console.error(server.output()); throw new Error('server did not become ready') }
  console.log('Server ready.\n')

  seedGiftItem(GIFT_ITEM_ID, GIFT_NAME, GIFT_IMAGE_URL, GIFT_PRICE)

  // ═══════════════════════════════════════════════════════════════════════
  // A9: Catalog reuse — GET /api/gift-items (public, reused endpoint)
  // ═══════════════════════════════════════════════════════════════════════
  console.log('=== A9: catalog reuse ===')
  await check('[A9] GET /api/gift-items връща seed-натия test gift (reuse на съществуващия public catalog)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/gift-items`)
    const body = await res.json()
    assertEqual(res.status, 200, 'HTTP status')
    assert(body.ok === true, 'ok:true')
    const item = (body.items as any[]).find((i) => i.giftItemId === GIFT_ITEM_ID)
    assert(item !== undefined, 'seed-натият gift item трябва да се появи в catalog-а')
    assertEqual(item.price, GIFT_PRICE, 'price mismatch')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // A1: successful 2p gift send
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== A1: успешен gift send (2 players) ===')
  const match2p = await createNpMatch(port, 'a', 2)
  const [p1, p2] = match2p.clients
  const started2p = latestParticipantSnapshotFrame(p1!)
  const p1Color = colorOf(match2p.clients, started2p, p1!)
  const p2Color = colorOf(match2p.clients, started2p, p2!)
  const p1BalanceBefore = getWalletBalance(p1!.profileId)
  const requestId1 = randomUUID()

  p1!.frames.length = 0
  p2!.frames.length = 0
  send(p1!, { type: 'send_ludo_gift', matchId: match2p.matchId, recipientProfileId: p2!.profileId, giftItemId: GIFT_ITEM_ID, requestId: requestId1 })

  const sendResult1 = await waitForFrame(p1!, (f) => f.type === 'ludo_gift_send_result' && f.requestId === requestId1, 5_000, 'A1 send result')
  await check('[A1a] ludo_gift_send_result ok:true с коректна цена/нов баланс', () => {
    assertEqual(sendResult1.ok, true, 'ok')
    assertEqual(sendResult1.chargedPrice, GIFT_PRICE, 'chargedPrice')
    assertEqual(sendResult1.senderBalanceAfter, p1BalanceBefore - GIFT_PRICE, 'senderBalanceAfter')
    assertEqual(sendResult1.isReplay, false, 'isReplay')
  })
  await check('[A1b] Wallet debit реално приложен в DB (атомарен, authoritative)', () => {
    assertEqual(getWalletBalance(p1!.profileId), p1BalanceBefore - GIFT_PRICE, 'DB balance')
  })
  const giftSentToSender = await waitForFrame(p1!, (f) => f.type === 'ludo_gift_sent' && f.transactionId === sendResult1.transactionId, 5_000, 'A1 gift_sent -> sender')
  await check('[A1c] Подателят получава СЪЩИЯ ludo_gift_sent (server echo, mirror на emoji reaction pattern-а)', () => {
    assertEqual(giftSentToSender.senderColor, p1Color, 'senderColor')
    assertEqual(giftSentToSender.recipientColor, p2Color, 'recipientColor')
    assertEqual(giftSentToSender.imageUrl, GIFT_IMAGE_URL, 'imageUrl')
    assertEqual(giftSentToSender.giftName, GIFT_NAME, 'giftName')
    assertEqual(giftSentToSender.chargedPrice, GIFT_PRICE, 'chargedPrice')
  })
  await check('[A1d] Получателят също получава ludo_gift_sent (real-time delivery)', async () => {
    const frame = await waitForFrame(p2!, (f) => f.type === 'ludo_gift_sent' && f.transactionId === sendResult1.transactionId, 5_000, 'A1 gift_sent -> recipient')
    assertEqual(frame.recipientProfileId, p2!.profileId, 'recipientProfileId')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // A2: server rejects self-gift
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== A2: server отхвърля self-gift ===')
  await check('[A2] send_ludo_gift към собствения profileId -> ok:false', async () => {
    const requestId = randomUUID()
    p1!.frames.length = 0
    send(p1!, { type: 'send_ludo_gift', matchId: match2p.matchId, recipientProfileId: p1!.profileId, giftItemId: GIFT_ITEM_ID, requestId })
    const result = await waitForFrame(p1!, (f) => f.type === 'ludo_gift_send_result' && f.requestId === requestId, 5_000, 'A2 self-gift result')
    assertEqual(result.ok, false, 'ok трябва да е false')
    assert(!('transactionId' in result), 'НЕ трябва да има transactionId при отказ')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // A3: server rejects recipient outside the match
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== A3: server отхвърля recipient извън match-а ===')
  const { cookie: outsiderCookie, profileId: outsiderProfileId } = await registerAndLogin(port, 'outsider', runId)
  const outsider = await connectWs(port, outsiderCookie, outsiderProfileId)
  await check('[A3] send_ludo_gift към реален профил, но НЕ участник в тоя match -> ok:false', async () => {
    const requestId = randomUUID()
    const balanceBefore = getWalletBalance(p1!.profileId)
    p1!.frames.length = 0
    send(p1!, { type: 'send_ludo_gift', matchId: match2p.matchId, recipientProfileId: outsiderProfileId, giftItemId: GIFT_ITEM_ID, requestId })
    const result = await waitForFrame(p1!, (f) => f.type === 'ludo_gift_send_result' && f.requestId === requestId, 5_000, 'A3 outsider result')
    assertEqual(result.ok, false, 'ok трябва да е false')
    assertEqual(getWalletBalance(p1!.profileId), balanceBefore, 'баланс не трябва да се промени')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // A4: insufficient balance
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== A4: insufficient balance ===')
  await check('[A4] Insufficient balance -> ok:false, няма debit, няма broadcast', async () => {
    setWalletBalance(p1!.profileId, 10) // < GIFT_PRICE (100)
    const requestId = randomUUID()
    p1!.frames.length = 0
    p2!.frames.length = 0
    send(p1!, { type: 'send_ludo_gift', matchId: match2p.matchId, recipientProfileId: p2!.profileId, giftItemId: GIFT_ITEM_ID, requestId })
    const result = await waitForFrame(p1!, (f) => f.type === 'ludo_gift_send_result' && f.requestId === requestId, 5_000, 'A4 insufficient balance result')
    assertEqual(result.ok, false, 'ok трябва да е false')
    assertEqual(getWalletBalance(p1!.profileId), 10, 'баланс не трябва да се промени (без debit)')
    const leaked = await waitBriefly(p2!, (f) => f.type === 'ludo_gift_sent' && f.transactionId === undefined ? false : true, 1_000)
    assert(leaked === null, 'НЕ трябва да има ludo_gift_sent broadcast при insufficient balance')
    setWalletBalance(p1!.profileId, 50_000) // restore за следващите тестове
  })

  // ═══════════════════════════════════════════════════════════════════════
  // A5: idempotent replay
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== A5: idempotent replay (същия requestId) ===')
  await check('[A5] Втори send със СЪЩИЯ requestId -> isReplay:true, БЕЗ втори debit/DB ред', async () => {
    const requestId = randomUUID()
    const balanceBefore = getWalletBalance(p1!.profileId)
    p1!.frames.length = 0
    send(p1!, { type: 'send_ludo_gift', matchId: match2p.matchId, recipientProfileId: p2!.profileId, giftItemId: GIFT_ITEM_ID, requestId })
    const first = await waitForFrame(p1!, (f) => f.type === 'ludo_gift_send_result' && f.requestId === requestId, 5_000, 'A5 first send')
    assertEqual(first.isReplay, false, 'първият send не е replay')
    const balanceAfterFirst = getWalletBalance(p1!.profileId)
    assertEqual(balanceAfterFirst, balanceBefore - GIFT_PRICE, 'debit след първия send')

    p1!.frames.length = 0
    send(p1!, { type: 'send_ludo_gift', matchId: match2p.matchId, recipientProfileId: p2!.profileId, giftItemId: GIFT_ITEM_ID, requestId })
    const second = await waitForFrame(p1!, (f) => f.type === 'ludo_gift_send_result' && f.requestId === requestId, 5_000, 'A5 replay send')
    assertEqual(second.ok, true, 'replay остава ok:true (idempotent success)')
    assertEqual(second.isReplay, true, 'вторият send трябва да е isReplay:true')
    assertEqual(getWalletBalance(p1!.profileId), balanceAfterFirst, 'НЕ трябва да има втори debit')
    assertEqual(countGiftTransactions(requestId), 1, 'точно ЕДИН DB ред за requestId-то, независимо от повторния send')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // A6: spectator — no send, but sees the animation
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== A6: spectator no-send + visibility ===')
  const spectator = outsider // reuse-ва вече свързания outsider client като spectator
  send(spectator, { type: 'watch_ludo_match', matchId: match2p.matchId })
  await waitForFrame(spectator, (f) => f.type === 'ludo_spectator_game_state' && f.snapshot.matchId === match2p.matchId, 5_000, 'A6 spectator initial snapshot')

  await check('[A6a] Spectator send_ludo_gift -> ok:false (НЕ участник в match-а)', async () => {
    const requestId = randomUUID()
    spectator.frames.length = 0
    send(spectator, { type: 'send_ludo_gift', matchId: match2p.matchId, recipientProfileId: p2!.profileId, giftItemId: GIFT_ITEM_ID, requestId })
    const result = await waitForFrame(spectator, (f) => f.type === 'ludo_gift_send_result' && f.requestId === requestId, 5_000, 'A6 spectator result')
    assertEqual(result.ok, false, 'spectator send трябва да е отхвърлен')
  })
  await check('[A6b] Spectator ВИЖДА ludo_gift_sent, когато реален participant прати gift (presentation-only visibility)', async () => {
    const requestId = randomUUID()
    spectator.frames.length = 0
    send(p1!, { type: 'send_ludo_gift', matchId: match2p.matchId, recipientProfileId: p2!.profileId, giftItemId: GIFT_ITEM_ID, requestId })
    const frame = await waitForFrame(spectator, (f) => f.type === 'ludo_gift_sent', 5_000, 'A6b spectator sees gift')
    assertEqual(frame.matchId, match2p.matchId, 'matchId')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // A8: reconnect-safety — activeLudoGifts в ludo_game_state_request
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== A8: reconnect-safety (activeLudoGifts) ===')
  await check('[A8] ludo_game_state_request след успешен gift връща activeLudoGifts с коректни данни', async () => {
    p2!.frames.length = 0
    send(p2!, { type: 'ludo_game_state_request' })
    const stateFrame = await waitForFrame(p2!, (f) => f.type === 'ludo_game_state', 5_000, 'A8 reconnect state')
    const gifts = stateFrame.activeLudoGifts as any[] | undefined
    assert(Array.isArray(gifts), 'activeLudoGifts трябва да е масив')
    const activeForP2 = gifts!.find((g) => g.recipientColor === p2Color)
    assert(activeForP2 !== undefined, 'трябва да има активен gift за p2Color')
    const remainingMs = Date.parse(activeForP2.expiresAt) - Date.now()
    assert(remainingMs > 0 && remainingMs <= 60_000, `remainingMs (${remainingMs}) трябва да е (0, 60000]`)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // A7: 4-player recipient correctness
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== A7: 4-player recipient correctness ===')
  const match4p = await createNpMatch(port, 'b', 4)
  const [q1, q2, q3, q4] = match4p.clients
  const started4p = latestParticipantSnapshotFrame(q1!)
  const q3Color = colorOf(match4p.clients, started4p, q3!)
  await check('[A7] Gift от q1 towards q3 конкретно каца в q3Color, никога в q2/q4', async () => {
    const requestId = randomUUID()
    q1!.frames.length = 0
    q2!.frames.length = 0
    q3!.frames.length = 0
    q4!.frames.length = 0
    send(q1!, { type: 'send_ludo_gift', matchId: match4p.matchId, recipientProfileId: q3!.profileId, giftItemId: GIFT_ITEM_ID, requestId })
    const result = await waitForFrame(q1!, (f) => f.type === 'ludo_gift_send_result' && f.requestId === requestId, 5_000, 'A7 send result')
    assertEqual(result.ok, true, 'gift трябва да успее')
    const frameAtQ3 = await waitForFrame(q3!, (f) => f.type === 'ludo_gift_sent' && f.transactionId === result.transactionId, 5_000, 'A7 q3 receives')
    assertEqual(frameAtQ3.recipientColor, q3Color, 'recipientColor трябва да е точно q3Color')
    assertEqual(frameAtQ3.recipientProfileId, q3!.profileId, 'recipientProfileId трябва да е точно q3')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // F1-F6: Frontend source-review (regex) — gate-ове, binding, cleanup wiring
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== F1-F6: frontend source review ===')
  const renderLudoGameScreenSrc = await readFile(join(projectRoot, 'src/app/games/ludo/renderLudoGameScreen.ts'), 'utf8')
  const renderLudoPlayerPanelSrc = await readFile(join(projectRoot, 'src/app/games/ludo/pieces/renderLudoPlayerPanel.ts'), 'utf8')
  const createLudoFlowControllerSrc = await readFile(join(projectRoot, 'src/app/games/ludo/createLudoFlowController.ts'), 'utf8')

  await check("[F1] renderLudoGameScreen.ts: gift icon gate-нат по viewMode==='player' && color !== localColor", () => {
    assert(
      /state\.viewMode === 'player' && color !== localColor/.test(renderLudoGameScreenSrc),
      "очакван gate `state.viewMode === 'player' && color !== localColor` в renderPlayerPanelSlot",
    )
  })
  await check('[F2] renderLudoPlayerPanel.ts: giftIcon параметърът default-ва към null (без икона, освен ако не е explicit подаден)', () => {
    assert(
      /giftIcon: LudoGiftIconSide \| null = null/.test(renderLudoPlayerPanelSrc),
      'очакван default null за giftIcon параметъра',
    )
  })
  await check('[F3] createLudoFlowController.ts: recipient profileId се resolve-ва от authoritativeSnapshot.players по color (не от произволен DOM data)', () => {
    assert(
      /authoritativeSnapshot\.players\.find\(\(player\) => player\.color === color\)/.test(createLudoFlowControllerSrc),
      'очаквано authoritative lookup по color в gift icon click handler-а',
    )
  })
  await check('[F4] createLudoFlowController.ts: giftPickerModal е null за spectator (isSpectator gate)', () => {
    assert(
      /options\.authoritative && !isSpectator\s*\n\s*\? createGiftPickerModal/.test(createLudoFlowControllerSrc),
      'очакван `options.authoritative && !isSpectator` gate преди createGiftPickerModal(...)',
    )
  })
  await check('[F5] syncGiftOverlays: timer се armира само веднъж (rerender НЕ рестартира remainingMs)', () => {
    assert(
      /giftOverlayTimerIds\[colorKey\] === undefined/.test(createLudoFlowControllerSrc),
      'очакван `giftOverlayTimerIds[colorKey] === undefined` guard',
    )
    assert(
      /const remainingMs = Date\.parse\(overlay\.expiresAt\) - nowMs/.test(createLudoFlowControllerSrc),
      'очаквано remainingMs изчислено от authoritative expiresAt, не fixed constant',
    )
  })
  await check('[F6] destroy()/invalidateAuthoritativePresentations() чистят gift overlay state (reconnect/destroy safety)', () => {
    assert(/clearAllGiftOverlays\(\)/.test(createLudoFlowControllerSrc), 'clearAllGiftOverlays() трябва да се вика някъде')
    const destroyMatch = /function destroy\(\): void \{[\s\S]*?\n {2}\}/.exec(createLudoFlowControllerSrc)
    assert(destroyMatch !== null && /clearAllGiftOverlays\(\)/.test(destroyMatch[0]), 'destroy() трябва да вика clearAllGiftOverlays()')
    const invalidateMatch = /function invalidateAuthoritativePresentations\(\): void \{[\s\S]*?\n {2}\}/.exec(createLudoFlowControllerSrc)
    assert(invalidateMatch !== null && /clearAllGiftOverlays\(\)/.test(invalidateMatch[0]), 'invalidateAuthoritativePresentations() трябва да вика clearAllGiftOverlays()')
  })

  console.log('\n' + '═'.repeat(75))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  console.log('═'.repeat(75) + '\n')
  if (failed > 0) process.exitCode = 1
} catch (error) {
  console.error('\nFATAL:', error instanceof Error ? error.message : error)
  if (server) console.error('\n--- server output ---\n' + server.output())
  process.exitCode = 1
} finally {
  await killServer(server)
  await isolated.cleanup()
}
