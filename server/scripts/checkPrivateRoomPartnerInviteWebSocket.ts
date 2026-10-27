/**
 * checkPrivateRoomPartnerInviteWebSocket.ts
 *
 * Реален spawned сървър + реални WebSocket връзки за "Покани партньор" в
 * частните маси (същият изолиран harness като checkPrivateRoomWebSocketRoundTrip.ts).
 *
 * Covers:
 *  - create_private_room{invitePartner} → резервирано A1 в snapshot-а;
 *    друг играч не може да седне там (private_room_slot_reserved);
 *  - покана само към онлайн приятел: не-приятел, офлайн и играещ се отказват;
 *  - поканеният получава private_room_invite_received{inviteKind:'partner'};
 *    домакинът вижда "Поканихте Х" (invite в snapshot-а), другите членове
 *    виждат само invitePending; втора покана се отказва;
 *  - refresh/reconnect на поканения (поканата идва отново) и на домакина
 *    (snapshot-ът пак носи поканата);
 *  - отказ → "Х отказа твоята покана за партньор", бутонът се освобождава;
 *  - отмяна → поканеният получава private_room_invite_cancelled;
 *  - приемане → сяда на A1; двойно приемане → само едно успешно;
 *  - приемане срещу отмяна едновременно → точно един изход;
 *  - домакинът напуска → поканата на поканения се анулира;
 *  - изтичане след 60 сек → и двете страни са известени, мястото остава резервирано;
 *  - допустимост при поканата (жълтици, ниво — съществуващите правила на
 *    checkPrivateRoomStakeEligibility): покана не се създава, резервацията
 *    остава; приемането проверява наново;
 *  - ЖЪЛТИЦИ: нито покана, нито приемане, нито отказ движат баланса или
 *    match_economy_ledger; таксата се взема едва при реалния старт.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { verifyVerificationCode } from '../src/db/authHelpers.js'

const TEST_REGISTRATION_SECRET = 'private-room-partner-invite-registration-secret-0123456789'
const STAKE = 5000
const START_BALANCE = 100_000
let testDatabaseFile = ''

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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

// ─── Изолиран сървър ─────────────────────────────────────────────────────────

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
  const root = await mkdtemp(join(tmpdir(), 'belot-private-room-partner-'))
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
  return { serverDir, cleanup: () => retryRm(root) }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

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

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(testDatabaseFile, { open: true, timeout: 5_000 })
  try { return fn(db) } finally { db.close() }
}

function setWalletBalance(profileId: string, amount: number): void {
  withDb((db) => {
    const res = db.prepare('UPDATE profile_wallets SET yellow_coins_balance = ? WHERE profile_id = ?').run(amount, profileId)
    if (Number(res.changes) === 0) {
      db.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?)').run(profileId, amount)
    }
  })
}

function setProfileLevel(profileId: string, level: number): void {
  withDb((db) => db.prepare('UPDATE profiles SET level = ? WHERE profile_id = ?').run(level, profileId))
}

// Admin сесия: ролята се записва в accounts, после нов login (сесията пази ролята).
async function loginAsAdmin(port: number, account: Account): Promise<string> {
  const email = withDb((db) => {
    db.prepare("UPDATE accounts SET role = 'admin' WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)").run(account.profileId)
    return (db.prepare('SELECT a.email FROM accounts a JOIN profiles p ON p.account_id = a.account_id WHERE p.profile_id = ?').get(account.profileId) as { email: string }).email
  })
  const login = await httpJson(port, 'POST', '/api/auth/login', null, { email, password: 'PartnerInviteDiag1!', rememberMe: true })
  if (login.status !== 200 || login.setCookie === null) throw new Error(`admin login failed: ${login.status} ${JSON.stringify(login.body)}`)
  return login.setCookie
}

function getWalletBalance(profileId: string): number {
  return withDb((db) => {
    const row = db.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(profileId) as { b: number } | undefined
    return Number(row?.b ?? 0)
  })
}

function countLedgerRows(profileId: string): number {
  return withDb((db) => {
    const row = db.prepare('SELECT COUNT(*) AS c FROM match_economy_ledger WHERE profile_id = ?').get(profileId) as { c: number }
    return Number(row.c)
  })
}

function bruteForceVerificationCode(pendingRegistrationId: string): string {
  const row = withDb((db) =>
    db.prepare('SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?').get(pendingRegistrationId) as { code_hash: string } | undefined,
  )
  if (!row) throw new Error(`pending_registrations row not found: ${pendingRegistrationId}`)
  for (let candidate = 0; candidate < 1_000_000; candidate++) {
    const code = candidate.toString().padStart(6, '0')
    if (verifyVerificationCode(code, TEST_REGISTRATION_SECRET, row.code_hash)) return code
  }
  throw new Error(`Could not brute-force the verification code for ${pendingRegistrationId}`)
}

// ─── Клиенти ─────────────────────────────────────────────────────────────────

type Account = { tag: string; profileId: string; cookie: string }
type TestClient = Account & { ws: WebSocket; frames: any[] }

async function registerProfile(port: number, tag: string): Promise<Account> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `partner-invite-${tag}-${runId}@example.test`,
    password: 'PartnerInviteDiag1!',
    displayName: `PI ${tag}`,
    gender: 'male',
    visitorId: randomUUID(),
  })
  const pendingRegistrationId: string | undefined = reg.body?.pendingRegistrationId
  if (!pendingRegistrationId) throw new Error(`Registration failed for ${tag}: ${JSON.stringify(reg.body)}`)
  const code = bruteForceVerificationCode(pendingRegistrationId)
  const verifyBody = { pendingRegistrationId, code, rememberMe: true }
  let verified: Awaited<ReturnType<typeof httpJson>>
  try {
    verified = await httpJson(port, 'POST', '/api/auth/verify-registration-email', null, verifyBody)
  } catch {
    await sleep(200)
    verified = await httpJson(port, 'POST', '/api/auth/verify-registration-email', null, verifyBody)
  }
  if (verified.status !== 200) throw new Error(`Email verification failed for ${tag}: ${JSON.stringify(verified.body)}`)
  const account = { tag, cookie: verified.setCookie as string, profileId: verified.body.session.profile.profileId }
  setWalletBalance(account.profileId, START_BALANCE)
  return account
}

async function openSocket(port: number, account: Account): Promise<TestClient> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: account.cookie } })
  const frames: any[] = []
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ }
  })
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen())
    ws.once('error', reject)
  })
  return { ...account, ws, frames }
}

async function closeSocket(client: TestClient): Promise<void> {
  if (client.ws.readyState === WebSocket.CLOSED) return
  await new Promise<void>((r) => {
    client.ws.once('close', () => r())
    client.ws.close()
  })
}

async function makeFriends(port: number, a: Account, b: Account): Promise<void> {
  const req = await httpJson(port, 'POST', '/api/friends/request', a.cookie, { profileId: b.profileId })
  if (req.status !== 200 || req.body?.ok !== true) throw new Error(`friend request failed: ${JSON.stringify(req.body)}`)
  const list = await httpJson(port, 'GET', '/api/friends', b.cookie)
  const incoming = (list.body?.friendships?.incomingPending ?? []).find((f: any) => f.profile?.profileId === a.profileId)
  if (!incoming) throw new Error('incoming friend request not found')
  const acc = await httpJson(port, 'POST', `/api/friends/${incoming.friendshipId}/accept`, b.cookie)
  if (acc.status !== 200 || acc.body?.ok !== true) throw new Error(`friend accept failed: ${JSON.stringify(acc.body)}`)
}

function send(client: TestClient, message: Record<string, unknown>): void {
  client.ws.send(JSON.stringify(message))
}

async function waitForFrame(client: TestClient, predicate: (frame: any) => boolean, timeoutMs = 10_000, label = 'frame'): Promise<any> {
  try {
    await waitForCondition(label, () => client.frames.some(predicate), timeoutMs)
  } catch (err) {
    console.error(`[debug] ${client.tag} frames while waiting for "${label}":`, JSON.stringify(client.frames.slice(-15), null, 2))
    throw err
  }
  return client.frames.find(predicate)
}

function lastRoomUpdate(client: TestClient): any {
  return [...client.frames].reverse().find((f) => f.type === 'private_room_updated')?.room ?? null
}

function slotOccupant(room: any, team: 'A' | 'B', slotIndex: 0 | 1): any {
  return room.slots.find((s: any) => s.team === team && s.slotIndex === slotIndex)?.occupant ?? null
}

async function expectError(client: TestClient, label: string, predicate: (f: any) => boolean = () => true): Promise<any> {
  return waitForFrame(client, (f) => f.type === 'error' && predicate(f), 5_000, label)
}

async function createPartnerRoom(host: TestClient): Promise<string> {
  host.frames.length = 0
  send(host, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15, invitePartner: true })
  const created = await waitForFrame(host, (f) => f.type === 'private_room_updated', 10_000, 'create_private_room')
  return created.room.id
}

async function invitePartner(host: TestClient, to: Account): Promise<string> {
  const fromIndex = host.frames.length
  send(host, { type: 'invite_private_room_partner', toProfileId: to.profileId })
  const isNewInviteFrame = (f: any) =>
    host.frames.indexOf(f) >= fromIndex &&
    f.type === 'private_room_updated' &&
    f.room.partnerReservation?.invite?.toProfileId === to.profileId
  const updated = await waitForFrame(host, isNewInviteFrame, 5_000, `host sees invite to ${to.tag}`)
  return updated.room.partnerReservation.invite.inviteId
}

console.log('\ncheckPrivateRoomPartnerInviteWebSocket\n')

let server: RunningServer | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)
testDatabaseFile = join(isolated.serverDir, 'database', 'data', 'belot-v2.sqlite')
const openClients: TestClient[] = []

try {
  const port = await findFreePort()
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
    console.error(server.output())
    throw err
  }
  console.log('Server ready.\n')

  const accounts: Record<string, Account> = {}
  for (const tag of ['host', 'friend', 'friend2', 'stranger', 'opp', 'offline', 'busy', 'busyHelper', 'hostX', 'friendX', 'hostZ', 'friendZ', 'hostB', 'poor', 'late', 'rich', 'adminL', 'hostL', 'novice', 'poorNovice', 'veteran']) {
    accounts[tag] = await registerProfile(port, tag)
  }
  for (const tag of ['friend', 'friend2', 'offline', 'busy']) await makeFriends(port, accounts.host!, accounts[tag]!)
  await makeFriends(port, accounts.hostX!, accounts.friendX!)
  await makeFriends(port, accounts.hostZ!, accounts.friendZ!)
  for (const tag of ['poor', 'late', 'rich']) await makeFriends(port, accounts.hostB!, accounts[tag]!)
  for (const tag of ['novice', 'poorNovice', 'veteran']) await makeFriends(port, accounts.hostL!, accounts[tag]!)

  const c: Record<string, TestClient> = {}
  for (const tag of ['host', 'friend', 'friend2', 'stranger', 'opp', 'busy', 'busyHelper', 'hostX', 'friendX', 'hostZ', 'friendZ', 'hostB', 'poor', 'late', 'rich', 'hostL', 'novice', 'poorNovice', 'veteran']) {
    c[tag] = await openSocket(port, accounts[tag]!)
    openClients.push(c[tag]!)
  }
  const { host, friend, friend2, stranger, opp, busy, busyHelper, hostX, friendX, hostZ, friendZ, hostB, poor, late, rich, hostL, novice, poorNovice, veteran } = c as Record<string, TestClient>

  // ─── Изтичане: стартира първо, проверява се накрая (реалните 60 сек) ──────
  const roomX = await createPartnerRoom(hostX!)
  friendX!.frames.length = 0
  const inviteXSentAt = Date.now()
  const inviteX = await invitePartner(hostX!, friendX!)
  await waitForFrame(friendX!, (f) => f.type === 'private_room_invite_received' && f.inviteId === inviteX, 5_000, 'friendX invite')

  const trackedForCoins = [host, friend, friend2, opp] as TestClient[]
  const balancesBefore = new Map(trackedForCoins.map((cl) => [cl.profileId, getWalletBalance(cl.profileId)]))
  const ledgerBefore = new Map(trackedForCoins.map((cl) => [cl.profileId, countLedgerRows(cl.profileId)]))

  // ─── [W1] Създаване с резервация ──────────────────────────────────────────
  console.log('--- Резервация ---')
  const roomId = await createPartnerRoom(host!)
  await check('[W1] create_private_room{invitePartner} → резервирано A1 без покана', () => {
    const room = lastRoomUpdate(host!)
    const r = room.partnerReservation
    if (r === null || r.team !== 'A' || r.slotIndex !== 1 || r.invitePending !== false) throw new Error(JSON.stringify(r))
    if (slotOccupant(room, 'A', 1) !== null) throw new Error('A1 not empty')
  })

  await check('[W2] друг играч не може да седне на резервираното място', async () => {
    opp!.frames.length = 0
    send(opp!, { type: 'join_private_room', privateRoomId: roomId, team: 'A', slotIndex: 1 })
    await expectError(opp!, 'reserved join rejection', (f) => f.code === 'private_room_slot_reserved')
  })

  opp!.frames.length = 0
  send(opp!, { type: 'join_private_room', privateRoomId: roomId, team: 'B', slotIndex: 0 })
  await waitForFrame(opp!, (f) => f.type === 'private_room_updated' && slotOccupant(f.room, 'B', 0) !== null, 5_000, 'opp joins B0')

  await check('[W3] lobby списъкът показва резервацията', async () => {
    stranger!.frames.length = 0
    send(stranger!, { type: 'request_private_rooms_list' })
    const list = await waitForFrame(stranger!, (f) => f.type === 'private_rooms_list', 5_000, 'list')
    const room = list.rooms.find((r: any) => r.id === roomId)
    if (room?.partnerReservation?.slotIndex !== 1) throw new Error(JSON.stringify(room?.partnerReservation))
  })

  // ─── Валидация на поканата ───────────────────────────────────────────────
  console.log('--- Кого може да покани ---')
  await check('[W4] не-приятел не може да бъде поканен', async () => {
    host!.frames.length = 0
    send(host!, { type: 'invite_private_room_partner', toProfileId: stranger!.profileId })
    await expectError(host!, 'stranger rejection', (f) => f.code === 'private_room_partner_unavailable')
    if (stranger!.frames.some((f) => f.type === 'private_room_invite_received')) throw new Error('stranger got an invite')
  })

  await check('[W5] офлайн приятел не може да бъде поканен', async () => {
    host!.frames.length = 0
    send(host!, { type: 'invite_private_room_partner', toProfileId: accounts.offline!.profileId })
    const err = await expectError(host!, 'offline rejection', (f) => f.code === 'private_room_partner_unavailable')
    if (!String(err.message).includes('офлайн')) throw new Error(err.message)
  })

  // busy влиза в реална игра: busy (A0) + бот (A1) + busyHelper (B0) + бот (B1).
  send(busy!, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 })
  const busyRoom = await waitForFrame(busy!, (f) => f.type === 'private_room_updated', 10_000, 'busy room')
  send(busy!, { type: 'add_bot_to_private_room_team', team: 'A' })
  await waitForFrame(busy!, (f) => f.type === 'private_room_updated' && slotOccupant(f.room, 'A', 1)?.isBot === true, 5_000, 'busy bot')
  send(busyHelper!, { type: 'join_private_room', privateRoomId: busyRoom.room.id, team: 'B', slotIndex: 0 })
  await waitForFrame(busyHelper!, (f) => f.type === 'private_room_updated', 5_000, 'helper join')
  send(busyHelper!, { type: 'add_bot_to_private_room_team', team: 'B' })
  await waitForFrame(busy!, (f) => f.type === 'private_room_full', 10_000, 'busy game started')

  await check('[W6] играещ приятел не може да бъде поканен', async () => {
    host!.frames.length = 0
    send(host!, { type: 'invite_private_room_partner', toProfileId: busy!.profileId })
    const err = await expectError(host!, 'busy rejection', (f) => f.code === 'private_room_partner_unavailable')
    if (!String(err.message).includes('играе')) throw new Error(err.message)
  })

  await check('[W7] /api/friends показва играещия приятел като isInGame', async () => {
    const list = await httpJson(port, 'GET', '/api/friends', host!.cookie)
    const entry = list.body.friendships.friends.find((f: any) => f.profile.profileId === busy!.profileId)
    if (entry?.isInGame !== true || entry?.isOnline !== true) throw new Error(JSON.stringify({ isInGame: entry?.isInGame, isOnline: entry?.isOnline }))
  })

  // ─── Покана, reconnect, отказ ────────────────────────────────────────────
  console.log('--- Покана, reconnect, отказ ---')
  friend!.frames.length = 0
  opp!.frames.length = 0
  host!.frames.length = 0
  const invite1 = await invitePartner(host!, friend!)

  await check('[W8] поканеният получава partner покана от домакина', async () => {
    const f = await waitForFrame(friend!, (fr) => fr.type === 'private_room_invite_received' && fr.inviteId === invite1, 5_000, 'friend invite')
    if (f.inviteKind !== 'partner' || f.privateRoomId !== roomId || f.fromProfileId !== host!.profileId || f.stake !== STAKE) throw new Error(JSON.stringify(f))
    if (!(f.expiresAt - Date.now() > 50_000 && f.expiresAt - Date.now() <= 60_000)) throw new Error(`expiresAt ${f.expiresAt - Date.now()}ms`)
  })

  await check('[W9] домакинът вижда "Поканихте Х"; другите членове само invitePending', async () => {
    const hostRoom = lastRoomUpdate(host!)
    if (hostRoom.partnerReservation.invite?.toDisplayName !== 'PI friend') throw new Error(JSON.stringify(hostRoom.partnerReservation))
    const oppUpdate = await waitForFrame(opp!, (f) => f.type === 'private_room_updated' && f.room.partnerReservation?.invitePending === true, 5_000, 'opp sees pending')
    if (oppUpdate.room.partnerReservation.invite !== null) throw new Error('invite details leaked to a non-host member')
  })

  await check('[W10] втора покана докато първата виси е отказана', async () => {
    host!.frames.length = 0
    send(host!, { type: 'invite_private_room_partner', toProfileId: friend2!.profileId })
    await expectError(host!, 'second invite rejection', (f) => f.code === 'private_room_partner_invite_pending')
    await sleep(300)
    if (friend2!.frames.some((f) => f.type === 'private_room_invite_received')) throw new Error('friend2 got an invite')
  })

  await check('[W11] refresh на поканения → поканата пристига отново', async () => {
    await closeSocket(friend!)
    c.friend = await openSocket(port, accounts.friend!)
    openClients.push(c.friend)
    send(c.friend, { type: 'request_private_rooms_list' })
    await waitForFrame(c.friend, (f) => f.type === 'private_room_invite_received' && f.inviteId === invite1 && f.inviteKind === 'partner', 5_000, 'redelivered invite')
  })

  await check('[W12] refresh на домакина → snapshot-ът пак носи поканата', async () => {
    await closeSocket(host!)
    c.host = await openSocket(port, accounts.host!)
    openClients.push(c.host)
    send(c.host, { type: 'request_private_rooms_list' })
    const upd = await waitForFrame(c.host, (f) => f.type === 'private_room_updated' && f.room.id === roomId, 5_000, 'host resync')
    if (upd.room.partnerReservation?.invite?.inviteId !== invite1) throw new Error(JSON.stringify(upd.room.partnerReservation))
  })

  const hostC = () => c.host!
  const friendC = () => c.friend!

  await check('[W13] отказ → "Х отказа твоята покана за партньор", бутонът се освобождава', async () => {
    hostC().frames.length = 0
    send(friendC(), { type: 'respond_private_room_invite', inviteId: invite1, accept: false })
    const status = await waitForFrame(hostC(), (f) => f.type === 'private_room_partner_invite_status', 5_000, 'declined status')
    if (status.status !== 'declined' || status.message !== 'PI friend отказа твоята покана за партньор.') throw new Error(JSON.stringify(status))
    const upd = await waitForFrame(hostC(), (f) => f.type === 'private_room_updated' && f.room.partnerReservation?.invitePending === false, 5_000, 'reservation free')
    if (slotOccupant(upd.room, 'A', 1) !== null) throw new Error('A1 occupied after decline')
  })

  // ─── Отмяна ──────────────────────────────────────────────────────────────
  console.log('--- Отмяна ---')
  friendC().frames.length = 0
  const invite2 = await invitePartner(hostC(), friendC())
  await waitForFrame(friendC(), (f) => f.type === 'private_room_invite_received' && f.inviteId === invite2, 5_000, 'invite2')
  await check('[W14] "Отмени поканата" → поканеният получава private_room_invite_cancelled', async () => {
    hostC().frames.length = 0
    send(hostC(), { type: 'cancel_private_room_partner_invite' })
    await waitForFrame(friendC(), (f) => f.type === 'private_room_invite_cancelled' && f.inviteId === invite2, 5_000, 'cancelled')
    await waitForFrame(hostC(), (f) => f.type === 'private_room_updated' && f.room.partnerReservation?.invite === null, 5_000, 'host free again')
    friendC().frames.length = 0
    send(friendC(), { type: 'respond_private_room_invite', inviteId: invite2, accept: true })
    await expectError(friendC(), 'accept after cancel rejected')
    if (slotOccupant(lastRoomUpdate(hostC()), 'A', 1) !== null) throw new Error('seated after cancel')
  })

  // ─── Приемане срещу отмяна едновременно ──────────────────────────────────
  await check('[W15] едновременни "Приеми" и "Отмени" → точно един изход', async () => {
    friendC().frames.length = 0
    const invite3 = await invitePartner(hostC(), friendC())
    await waitForFrame(friendC(), (f) => f.type === 'private_room_invite_received' && f.inviteId === invite3, 5_000, 'invite3')
    hostC().frames.length = 0
    send(friendC(), { type: 'respond_private_room_invite', inviteId: invite3, accept: true })
    send(hostC(), { type: 'cancel_private_room_partner_invite' })
    await sleep(1_000)
    const room = lastRoomUpdate(hostC())
    const seated = slotOccupant(room, 'A', 1)?.profileId === friendC().profileId
    const cancelFailed = hostC().frames.some((f) => f.type === 'error')
    if (seated !== cancelFailed) throw new Error(`seated=${seated} cancelFailed=${cancelFailed}`)
    if (room.partnerReservation.invite !== null) throw new Error('invite still pending')
    if (seated) {
      // Връщаме мястото за следващия сценарий.
      send(friendC(), { type: 'leave_private_room' })
      await waitForFrame(hostC(), (f) => f.type === 'private_room_updated' && slotOccupant(f.room, 'A', 1) === null, 5_000, 'friend left')
    }
  })

  // ─── Приемане + двойно приемане ──────────────────────────────────────────
  console.log('--- Приемане ---')
  friend2!.frames.length = 0
  const invite4 = await invitePartner(hostC(), friend2!)
  await waitForFrame(friend2!, (f) => f.type === 'private_room_invite_received' && f.inviteId === invite4, 5_000, 'invite4')
  hostC().frames.length = 0
  friend2!.frames.length = 0
  // Двоен клик / replay: две "Приеми" една след друга по същата връзка (втори
  // таб на същия профил не е възможен — новата сесия изтласква старата).
  send(friend2!, { type: 'respond_private_room_invite', inviteId: invite4, accept: true })
  send(friend2!, { type: 'respond_private_room_invite', inviteId: invite4, accept: true })

  await check('[W16] приемане → поканеният е настанен на A1 и получава чакалнята', async () => {
    const upd = await waitForFrame(hostC(), (f) => f.type === 'private_room_updated' && slotOccupant(f.room, 'A', 1)?.profileId === friend2!.profileId, 5_000, 'seated')
    if (upd.room.partnerReservation.invite !== null) throw new Error('invite not cleared')
    await waitForFrame(hostC(), (f) => f.type === 'private_room_invite_accepted', 5_000, 'host accepted notice')
    await waitForFrame(friend2!, (f) => f.type === 'private_room_updated' && f.room.id === roomId, 5_000, 'friend2 snapshot')
  })

  await check('[W17] двойно приемане → точно едно сядане, второто е отказано', async () => {
    await sleep(500)
    // Губещата заявка вече не намира партньорска покана и минава през общия
    // respond handler — отказ "Поканата не съществува или е изтекла.".
    const errors = friend2!.frames.filter((f) => f.type === 'error')
    if (errors.length !== 1) throw new Error(`errors=${errors.length}`)
    const humans = lastRoomUpdate(hostC()).slots.filter((s: any) => s.occupant !== null && !s.occupant.isBot)
    if (humans.length !== 3) throw new Error(`humans=${humans.length}`)
    if (hostC().frames.filter((f) => f.type === 'private_room_invite_accepted').length !== 1) throw new Error('host notified twice')
  })

  await check('[W18] ЖЪЛТИЦИ: покани/откази/приемане не са движили баланса и ledger-а', () => {
    for (const cl of trackedForCoins) {
      const before = balancesBefore.get(cl.profileId)!
      const after = getWalletBalance(cl.profileId)
      if (after !== before) throw new Error(`${cl.tag}: ${before} -> ${after}`)
      if (countLedgerRows(cl.profileId) !== ledgerBefore.get(cl.profileId)) throw new Error(`${cl.tag}: ledger rows changed`)
    }
  })

  await check('[W19] старт на мача → таксата се взема едва сега, чрез съществуващата логика', async () => {
    send(opp!, { type: 'add_bot_to_private_room_team', team: 'B' })
    await waitForFrame(hostC(), (f) => f.type === 'private_room_full', 10_000, 'match start')
    await waitForCondition('stakes collected', () => [hostC(), friend2!, opp!].every((cl) => getWalletBalance(cl.profileId) === START_BALANCE - STAKE), 5_000)
    if (getWalletBalance(friendC().profileId) !== START_BALANCE) throw new Error('friend (declined) was charged')
  })

  // ─── Домакинът напуска с висяща покана ───────────────────────────────────
  console.log('--- Домакинът напуска ---')
  await createPartnerRoom(hostZ!)
  friendZ!.frames.length = 0
  const inviteZ = await invitePartner(hostZ!, friendZ!)
  await waitForFrame(friendZ!, (f) => f.type === 'private_room_invite_received' && f.inviteId === inviteZ, 5_000, 'inviteZ')
  await check('[W20] домакинът напуска → поканата на поканения се анулира', async () => {
    send(hostZ!, { type: 'leave_private_room' })
    await waitForFrame(friendZ!, (f) => f.type === 'private_room_invite_cancelled' && f.inviteId === inviteZ, 5_000, 'cancelled on host leave')
    friendZ!.frames.length = 0
    send(friendZ!, { type: 'respond_private_room_invite', inviteId: inviteZ, accept: true })
    await expectError(friendZ!, 'accept after host left')
  })

  // ─── Недостатъчно жълтици при поканата ───────────────────────────────────
  console.log('--- Жълтици при поканата ---')
  const roomB = await createPartnerRoom(hostB!)
  setWalletBalance(poor!.profileId, STAKE - 1)
  const poorLedgerBefore = countLedgerRows(poor!.profileId)

  await check('[W23] приятел без достатъчно жълтици → покана не се създава, домакинът получава текста за прозореца', async () => {
    hostB!.frames.length = 0
    poor!.frames.length = 0
    send(hostB!, { type: 'invite_private_room_partner', toProfileId: poor!.profileId })
    const err = await expectError(hostB!, 'insufficient balance', (f) => f.code === 'private_room_partner_insufficient_balance')
    if (err.message !== 'PI poor не може да играе на тази маса поради липса на достатъчно жълтици.') throw new Error(err.message)
    await sleep(400)
    if (poor!.frames.some((f) => f.type === 'private_room_invite_received')) throw new Error('poor received an invite')
    if (hostB!.frames.some((f) => f.type === 'private_room_updated')) throw new Error('room changed after rejected invite')
  })

  await check('[W24] отказът не пипа жълтиците на приятеля (баланс и ledger)', () => {
    if (getWalletBalance(poor!.profileId) !== STAKE - 1) throw new Error(`balance ${getWalletBalance(poor!.profileId)}`)
    if (countLedgerRows(poor!.profileId) !== poorLedgerBefore) throw new Error('ledger changed')
  })

  await check('[W25] резервацията остава и домакинът веднага кани друг приятел', async () => {
    send(hostB!, { type: 'request_private_rooms_list' })
    const upd = await waitForFrame(hostB!, (f) => f.type === 'private_room_updated' && f.room.id === roomB, 5_000, 'hostB resync')
    if (upd.room.partnerReservation?.invitePending !== false || slotOccupant(upd.room, 'A', 1) !== null) throw new Error(JSON.stringify(upd.room.partnerReservation))
    late!.frames.length = 0
    await invitePartner(hostB!, late!)
    await waitForFrame(late!, (f) => f.type === 'private_room_invite_received' && f.inviteKind === 'partner', 5_000, 'late invite')
  })

  await check('[W26] балансът пада след поканата → проверката при приемане пак отказва, мястото е свободно', async () => {
    const inviteLate = lastRoomUpdate(hostB!).partnerReservation.invite.inviteId
    setWalletBalance(late!.profileId, 0)
    hostB!.frames.length = 0
    late!.frames.length = 0
    send(late!, { type: 'respond_private_room_invite', inviteId: inviteLate, accept: true })
    await expectError(late!, 'accept balance re-check', (f) => f.code === 'private_room_insufficient_balance')
    const status = await waitForFrame(hostB!, (f) => f.type === 'private_room_partner_invite_status' && f.status === 'unavailable', 5_000, 'host unavailable')
    void status
    const upd = await waitForFrame(hostB!, (f) => f.type === 'private_room_updated' && f.room.partnerReservation?.invitePending === false, 5_000, 'reservation free again')
    if (slotOccupant(upd.room, 'A', 1) !== null) throw new Error('late was seated without coins')
    if (getWalletBalance(late!.profileId) !== 0) throw new Error('late balance changed')
  })

  await check('[W27] приятел с достатъчно жълтици → покана и приемане работят', async () => {
    rich!.frames.length = 0
    const inviteRich = await invitePartner(hostB!, rich!)
    await waitForFrame(rich!, (f) => f.type === 'private_room_invite_received' && f.inviteId === inviteRich, 5_000, 'rich invite')
    send(rich!, { type: 'respond_private_room_invite', inviteId: inviteRich, accept: true })
    await waitForFrame(hostB!, (f) => f.type === 'private_room_updated' && slotOccupant(f.room, 'A', 1)?.profileId === rich!.profileId, 5_000, 'rich seated')
    if (getWalletBalance(rich!.profileId) !== START_BALANCE) throw new Error('rich charged before match start')
  })

  // ─── Недостатъчно ниво при поканата ──────────────────────────────────────
  console.log('--- Ниво при поканата ---')
  const LEVEL_STAKE = 7000
  const LEVEL_MIN = 5

  await check('[W28] (setup) admin създава залог с изискване за ниво 5', async () => {
    const adminCookie = await loginAsAdmin(port, accounts.adminL!)
    const res = await httpJson(port, 'POST', '/api/admin/rooms', adminCookie, { stakeAmount: LEVEL_STAKE, minLevel: LEVEL_MIN, prizeAmount: 10_000, isEnabled: true })
    if (res.status !== 200 || res.body?.room?.minLevel !== LEVEL_MIN) throw new Error(`${res.status} ${JSON.stringify(res.body)}`)
  })

  for (const cl of [hostL!, veteran!]) setProfileLevel(cl.profileId, LEVEL_MIN)
  setWalletBalance(poorNovice!.profileId, 0)
  const levelBalancesBefore = new Map([novice!, poorNovice!, veteran!].map((cl) => [cl.profileId, getWalletBalance(cl.profileId)]))
  const levelLedgerBefore = new Map([novice!, poorNovice!, veteran!].map((cl) => [cl.profileId, countLedgerRows(cl.profileId)]))
  hostL!.frames.length = 0
  send(hostL!, { type: 'create_private_room', stake: LEVEL_STAKE, isLocked: false, waitMinutes: 15, invitePartner: true })
  const roomL: string = (await waitForFrame(hostL!, (f) => f.type === 'private_room_updated', 10_000, 'level room')).room.id

  await check('[W29] приятел с недостатъчно ниво → покана не се създава, текстът за прозореца е точен', async () => {
    hostL!.frames.length = 0
    novice!.frames.length = 0
    send(hostL!, { type: 'invite_private_room_partner', toProfileId: novice!.profileId })
    const err = await expectError(hostL!, 'level required', (f) => f.code === 'private_room_partner_level_required')
    if (err.message !== 'PI novice не може да играе на тази маса поради недостатъчно ниво.') throw new Error(err.message)
    await sleep(400)
    if (novice!.frames.some((f) => f.type === 'private_room_invite_received')) throw new Error('novice received an invite')
    if (hostL!.frames.some((f) => f.type === 'private_room_updated')) throw new Error('room changed after rejected invite')
  })

  await check('[W30] без ниво И без жълтици → съобщението за ниво (редът на съществуващите правила)', async () => {
    hostL!.frames.length = 0
    send(hostL!, { type: 'invite_private_room_partner', toProfileId: poorNovice!.profileId })
    const err = await expectError(hostL!, 'level before balance', (f) => typeof f.code === 'string' && f.code.startsWith('private_room_partner_'))
    if (err.code !== 'private_room_partner_level_required') throw new Error(err.code)
  })

  await check('[W31] резервацията остава и домакинът веднага кани приятел с нужното ниво', async () => {
    send(hostL!, { type: 'request_private_rooms_list' })
    const upd = await waitForFrame(hostL!, (f) => f.type === 'private_room_updated' && f.room.id === roomL, 5_000, 'hostL resync')
    if (upd.room.partnerReservation?.invitePending !== false || slotOccupant(upd.room, 'A', 1) !== null) throw new Error(JSON.stringify(upd.room.partnerReservation))
    veteran!.frames.length = 0
    await invitePartner(hostL!, veteran!)
    await waitForFrame(veteran!, (f) => f.type === 'private_room_invite_received' && f.inviteKind === 'partner', 5_000, 'veteran invite')
  })

  await check('[W32] нивото пада след поканата → проверката при приемане пак отказва', async () => {
    const inviteVeteran = lastRoomUpdate(hostL!).partnerReservation.invite.inviteId
    setProfileLevel(veteran!.profileId, 1)
    hostL!.frames.length = 0
    veteran!.frames.length = 0
    send(veteran!, { type: 'respond_private_room_invite', inviteId: inviteVeteran, accept: true })
    await expectError(veteran!, 'accept level re-check', (f) => f.code === 'private_room_level_required')
    await waitForFrame(hostL!, (f) => f.type === 'private_room_partner_invite_status' && f.status === 'unavailable', 5_000, 'host unavailable')
    const upd = await waitForFrame(hostL!, (f) => f.type === 'private_room_updated' && f.room.partnerReservation?.invitePending === false, 5_000, 'reservation free again')
    if (slotOccupant(upd.room, 'A', 1) !== null) throw new Error('veteran was seated without the level')
  })

  await check('[W33] отказите по ниво не пипат жълтиците (баланс и ledger)', () => {
    for (const cl of [novice!, poorNovice!, veteran!]) {
      if (getWalletBalance(cl.profileId) !== levelBalancesBefore.get(cl.profileId)) throw new Error(`${cl.tag} balance changed`)
      if (countLedgerRows(cl.profileId) !== levelLedgerBefore.get(cl.profileId)) throw new Error(`${cl.tag} ledger changed`)
    }
  })

  // ─── Изтичане (реалните 60 сек) ──────────────────────────────────────────
  console.log('--- Изтичане (изчаква до 60 сек) ---')
  await check('[W21] след 60 сек поканата изтича — поканеният и домакинът са известени', async () => {
    const remaining = Math.max(0, inviteXSentAt + 60_000 - Date.now())
    await waitForFrame(friendX!, (f) => f.type === 'private_room_invite_expired' && f.inviteId === inviteX, remaining + 5_000, 'expired')
    const status = await waitForFrame(hostX!, (f) => f.type === 'private_room_partner_invite_status' && f.status === 'expired', 5_000, 'host expired status')
    if (!String(status.message).includes('изтече')) throw new Error(status.message)
    if (Date.now() - inviteXSentAt < 59_000) throw new Error('expired too early')
  })

  await check('[W22] след изтичане мястото остава резервирано и може нова покана', async () => {
    const room = lastRoomUpdate(hostX!)
    if (room.id !== roomX || room.partnerReservation?.invitePending !== false || slotOccupant(room, 'A', 1) !== null) throw new Error(JSON.stringify(room.partnerReservation))
    friendX!.frames.length = 0
    send(friendX!, { type: 'respond_private_room_invite', inviteId: inviteX, accept: true })
    await expectError(friendX!, 'accept after expiry')
    const again = await invitePartner(hostX!, friendX!)
    if (again === inviteX) throw new Error('same inviteId reused')
  })
} finally {
  for (const cl of openClients) {
    try { cl.ws.close() } catch { /* ignore */ }
  }
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
