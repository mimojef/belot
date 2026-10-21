/**
 * checkTopicsPersonalDisabledHttp.ts
 *
 * HTTP/WS E2E срещу РЕАЛЕН spawn-нат сървър (изолиран temp SQLite, direct
 * registration mode — моделът от checkMarketingRole.ts) за server-side
 * TOPICS_PERSONAL_ENABLED gate-а (server/src/core/topicsPersonalFeatureGate.ts).
 * Трите фази ползват ЕДНА и СЪЩА база:
 *
 *  F0. flag (споделената константа) е false по подразбиране; env override.
 *  P1. flag ON (env TOPICS_PERSONAL_ENABLED=1) — създава "стари" данни:
 *      vip_dm разговор A↔B със съобщение + friend разговор A↔C със съобщение.
 *  P2. flag OFF (без env — реалният default):
 *      - POST /api/chat/vip-dm/start и /start-with-message → 403
 *        topics_personal_disabled, без нов vip_dm ред;
 *      - POST /api/chat/<vip_dm>/messages (и от двете страни, и със
 *        снимка) → 403, без нови съобщения;
 *      - старите vip_dm данни остават непокътнати и четими (GET);
 *      - основният Чат (friend): изпращане 200, история, WS известие;
 *        непознат не може да пише в чужд разговор (непроменено).
 *  P3. flag ON отново — старият vip_dm разговор е достъпен и приема съобщения.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import WebSocket, { type RawData } from 'ws'
import { TOPICS_PERSONAL_ENABLED } from '../src/shared/topicsPersonalFeatureFlag.js'
import { isTopicsPersonalServerEnabled } from '../src/core/topicsPersonalFeatureGate.js'

const PASSWORD = 'TopicsPersonalCheck1!'
const TEST_SECRET = 'topics-personal-http-test-secret-0123456789abcdef'

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

const sourceServerRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())

function getFreePort(): Promise<number> {
  return new Promise((done, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('no port')))
        return
      }
      srv.close(() => done(addr.port))
    })
  })
}

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-topics-personal-'))
  const serverDir = join(root, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(originalServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  // Compiled game worker (resolveGameWorkerEntryUrl) — сървърът не стартира без него.
  await cp(join(originalServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(originalServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(originalServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(originalServerRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)
  return { serverDir, databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'), cleanup: () => retryRm(root) }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

function startServer(serverDir: string, port: number, topicsPersonalEnv: '1' | null): RunningServer {
  const chunks: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
    BELOT_GAME_WORKER_COUNT: '1',
    PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_SECRET,
  }
  delete env.TOPICS_PERSONAL_ENABLED
  if (topicsPersonalEnv !== null) env.TOPICS_PERSONAL_ENABLED = topicsPersonalEnv
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => chunks.push(chunk))
  child.stderr.on('data', (chunk: string) => chunks.push(chunk))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((done) => {
    const timer = setTimeout(() => { server.child.kill('SIGKILL'); done() }, 10_000)
    server.child.once('exit', () => { clearTimeout(timer); done() })
  })
}

async function waitForServer(port: number, server: RunningServer): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/rooms`)).status === 200) return
    } catch { /* not yet */ }
    await sleep(100)
  }
  throw new Error(`server did not start:\n${server.output().slice(-2000)}`)
}

let ipCounter = 0
const nextIp = () => `203.0.113.${(ipCounter += 1) % 250 + 1}`

type JsonResult = { status: number; body: Record<string, unknown> | null; text: string; setCookie: string[] }

async function request(port: number, method: 'GET' | 'POST' | 'DELETE', pathname: string, body?: unknown, cookie?: string): Promise<JsonResult> {
  const headers: Record<string, string> = { 'X-Forwarded-For': nextIp() }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie) headers['Cookie'] = cookie
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: Record<string, unknown> | null = null
  try { parsed = JSON.parse(text) as Record<string, unknown> } catch { /* not json */ }
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  return { status: res.status, body: parsed, text, setCookie: headersExt.getSetCookie?.() ?? [] }
}

const cookieOf = (result: JsonResult) => result.setCookie.find((c) => c.startsWith('belot_session='))?.split(';')[0] ?? ''

function withDb<T>(databaseFile: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile)
  try { return fn(db) } finally { db.close() }
}

type TestUser = { cookie: string; profileId: string; email: string }

async function registerUser(port: number, label: string): Promise<TestUser> {
  const email = `tp-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName: `Tp${label}${randomUUID().slice(0, 4)}`, gender: 'male', visitorId: randomUUID(),
  })
  assert(result.status === 200, `register ${label}: ${result.status} ${result.text}`)
  return login(port, email, label)
}

async function login(port: number, email: string, label: string): Promise<TestUser> {
  const res = await request(port, 'POST', '/api/auth/login', { email, password: PASSWORD, rememberMe: true })
  const cookie = cookieOf(res)
  assert(cookie !== '', `login ${label}: ${res.status} ${res.text}`)
  const me = await request(port, 'GET', '/api/auth/me', undefined, cookie)
  const profileId = ((me.body?.session as { profile?: { profileId?: string } } | undefined)?.profile?.profileId) ?? ''
  assert(profileId !== '', `profileId ${label}`)
  return { cookie, profileId, email }
}

function setVip(databaseFile: string, profileId: string): void {
  const activeUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  withDb(databaseFile, (db) => db.prepare(`
    INSERT INTO vip_status (profile_id, active_until) VALUES (?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until;
  `).run(profileId, activeUntil))
}

const countVipDmRows = (databaseFile: string) =>
  withDb(databaseFile, (db) => (db.prepare(`SELECT COUNT(*) AS n FROM profile_friendships WHERE kind = 'vip_dm'`).get() as { n: number }).n)

const countMessages = (databaseFile: string, friendshipId: string) =>
  withDb(databaseFile, (db) => (db.prepare('SELECT COUNT(*) AS n FROM friend_chat_messages WHERE friendship_id = ?').get(friendshipId) as { n: number }).n)

const messageBodies = (result: JsonResult) =>
  ((result.body?.messages as Array<{ body?: string }> | undefined) ?? []).map((m) => m.body ?? '')

type AnyMsg = Record<string, unknown> & { type: string }

function openWs(port: number, cookie: string): Promise<{ ws: WebSocket; buffer: AnyMsg[] }> {
  return new Promise((done, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
    const buffer: AnyMsg[] = []
    ws.on('message', (raw: RawData) => { try { buffer.push(JSON.parse(raw.toString())) } catch { /* ignore */ } })
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('WS open timeout')) }, 5000)
    ws.once('open', () => { clearTimeout(timer); done({ ws, buffer }) })
    ws.once('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

async function waitForWs(buffer: AnyMsg[], predicate: (m: AnyMsg) => boolean, timeoutMs = 5000): Promise<AnyMsg> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = buffer.find(predicate)
    if (found) return found
    await sleep(25)
  }
  throw new Error('timeout waiting for WS message')
}

const pngBuffer = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 30, g: 140, b: 220 } } }).png().toBuffer()
const IMAGE_DATA_URL = `data:image/png;base64,${pngBuffer.toString('base64')}`

// ─── F0 ─────────────────────────────────────────────────────────────────────

console.log('\n═══ Topics → Лични (vip_dm) feature flag — HTTP E2E ═══')
console.log('\n=== F0. flag ===')

await check('F0a. TOPICS_PERSONAL_ENABLED е false по подразбиране', () => {
  assert(TOPICS_PERSONAL_ENABLED === false, String(TOPICS_PERSONAL_ENABLED))
})
await check('F0b. server gate: без env → false; env "1" → true; env "0" → false', () => {
  const original = process.env.TOPICS_PERSONAL_ENABLED
  try {
    delete process.env.TOPICS_PERSONAL_ENABLED
    assert(isTopicsPersonalServerEnabled() === false, 'default')
    process.env.TOPICS_PERSONAL_ENABLED = '1'
    assert(isTopicsPersonalServerEnabled() === true, 'env 1')
    process.env.TOPICS_PERSONAL_ENABLED = '0'
    assert(isTopicsPersonalServerEnabled() === false, 'env 0')
  } finally {
    if (original === undefined) delete process.env.TOPICS_PERSONAL_ENABLED
    else process.env.TOPICS_PERSONAL_ENABLED = original
  }
})

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null

try {
  // ─── P1. ON — "стари" данни ───────────────────────────────────────────────
  console.log('\n=== P1. flag ON — създаване на стари данни ===')
  server = startServer(isolated.serverDir, port, '1')
  await waitForServer(port, server)
  withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())

  const a = await registerUser(port, 'a')
  const b = await registerUser(port, 'b')
  const c = await registerUser(port, 'c')
  const d = await registerUser(port, 'd')
  for (const user of [a, b, d]) setVip(isolated.databaseFile, user.profileId)

  let vipDmId = ''
  let friendId = ''

  await check('P1a. ON: vip_dm start-with-message A→B (непознати) → 200, създава разговор', async () => {
    const res = await request(port, 'POST', '/api/chat/vip-dm/start-with-message', { recipientProfileId: b.profileId, body: 'старо лично съобщение' }, a.cookie)
    assert(res.status === 200 && res.body?.ok === true, `${res.status} ${res.text}`)
    vipDmId = String(res.body?.friendshipId ?? '')
    assert(vipDmId !== '', 'friendshipId')
  })
  await check('P1b. ON: отговор B→A във vip_dm → 200', async () => {
    const res = await request(port, 'POST', `/api/chat/${vipDmId}/messages`, { body: 'стар отговор' }, b.cookie)
    assert(res.status === 200, `${res.status} ${res.text}`)
  })
  await check('P1c. friend разговор A↔C (заявка + приемане) + съобщение → 200', async () => {
    const reqFriend = await request(port, 'POST', '/api/friends/request', { profileId: c.profileId }, a.cookie)
    assert(reqFriend.status === 200, `friend request: ${reqFriend.status} ${reqFriend.text}`)
    friendId = withDb(isolated.databaseFile, (db) => (db.prepare(
      `SELECT friendship_id FROM profile_friendships WHERE requester_profile_id = ? AND addressee_profile_id = ? AND kind = 'friend' ORDER BY created_at DESC LIMIT 1`,
    ).get(a.profileId, c.profileId) as { friendship_id?: string } | undefined)?.friendship_id ?? '')
    assert(friendId !== '', 'friendshipId missing')
    const accept = await request(port, 'POST', `/api/friends/${friendId}/accept`, undefined, c.cookie)
    assert(accept.status === 200, `accept: ${accept.status} ${accept.text}`)
    const send = await request(port, 'POST', `/api/chat/${friendId}/messages`, { body: 'приятелско съобщение' }, a.cookie)
    assert(send.status === 200, `send: ${send.status} ${send.text}`)
  })

  const vipDmRowsBefore = countVipDmRows(isolated.databaseFile)
  const vipDmMessagesBefore = countMessages(isolated.databaseFile, vipDmId)
  const vipDmSnapshotBefore = withDb(isolated.databaseFile, (db) => JSON.stringify(db.prepare('SELECT message_id, sender_profile_id, body FROM friend_chat_messages WHERE friendship_id = ? ORDER BY message_id').all(vipDmId)))
  await stopServer(server)
  server = null

  // ─── P2. OFF ──────────────────────────────────────────────────────────────
  console.log('\n=== P2. flag OFF (default) ===')
  server = startServer(isolated.serverDir, port, null)
  await waitForServer(port, server)
  const a2 = await login(port, a.email, 'a')
  const b2 = await login(port, b.email, 'b')
  const c2 = await login(port, c.email, 'c')
  const d2 = await login(port, d.email, 'd')

  const expectDisabled = (res: JsonResult, label: string) => {
    assert(res.status === 403, `${label}: status ${res.status} ${res.text}`)
    assert(res.body?.code === 'topics_personal_disabled', `${label}: code ${String(res.body?.code)}`)
    assert(res.body?.ok === false, `${label}: ok`)
  }

  await check('P2a. OFF: POST /api/chat/vip-dm/start-with-message (нов разговор A→D) → 403, без нов ред', async () => {
    const res = await request(port, 'POST', '/api/chat/vip-dm/start-with-message', { recipientProfileId: d2.profileId, body: 'ново лично' }, a2.cookie)
    expectDisabled(res, 'start-with-message')
    assert(countVipDmRows(isolated.databaseFile) === vipDmRowsBefore, 'vip_dm rows changed')
  })
  await check('P2b. OFF: start-with-message към съществуващ vip_dm партньор (A→B) → 403', async () => {
    const res = await request(port, 'POST', '/api/chat/vip-dm/start-with-message', { recipientProfileId: b2.profileId, body: 'опит' }, a2.cookie)
    expectDisabled(res, 'start-with-message existing')
  })
  await check('P2c. OFF: POST /api/chat/vip-dm/start (legacy) → 403', async () => {
    const res = await request(port, 'POST', '/api/chat/vip-dm/start', { recipientProfileId: d2.profileId }, a2.cookie)
    expectDisabled(res, 'vip-dm/start')
  })
  await check('P2d. OFF: директен POST /api/chat/<vip_dm>/messages от A и от B → 403', async () => {
    expectDisabled(await request(port, 'POST', `/api/chat/${vipDmId}/messages`, { body: 'директен опит' }, a2.cookie), 'A')
    expectDisabled(await request(port, 'POST', `/api/chat/${vipDmId}/messages`, { body: 'директен отговор' }, b2.cookie), 'B')
  })
  await check('P2e. OFF: vip_dm съобщение със снимка → 403', async () => {
    expectDisabled(await request(port, 'POST', `/api/chat/${vipDmId}/messages`, { body: '', imageDataUrl: IMAGE_DATA_URL }, a2.cookie), 'image')
    expectDisabled(await request(port, 'POST', '/api/chat/vip-dm/start-with-message', { recipientProfileId: d2.profileId, body: '', imageDataUrl: IMAGE_DATA_URL }, a2.cookie), 'start image')
  })
  await check('P2g. OFF: старите vip_dm данни са непокътнати (редове и съобщения)', () => {
    assert(countVipDmRows(isolated.databaseFile) === vipDmRowsBefore, 'vip_dm rows')
    assert(countMessages(isolated.databaseFile, vipDmId) === vipDmMessagesBefore, 'vip_dm message count')
    const after = withDb(isolated.databaseFile, (db) => JSON.stringify(db.prepare('SELECT message_id, sender_profile_id, body FROM friend_chat_messages WHERE friendship_id = ? ORDER BY message_id').all(vipDmId)))
    assert(after === vipDmSnapshotBefore, 'vip_dm messages changed')
  })
  await check('P2h. OFF: старата vip_dm история остава четима (GET messages → 200)', async () => {
    const res = await request(port, 'GET', `/api/chat/${vipDmId}/messages`, undefined, a2.cookie)
    assert(res.status === 200, `${res.status} ${res.text}`)
    const bodies = messageBodies(res)
    assert(bodies.includes('старо лично съобщение') && bodies.includes('стар отговор'), JSON.stringify(bodies))
  })

  console.log('\n--- основен Чат (friend) — без регресии ---')
  await check('P2i. OFF: friend A→C изпращане → 200 + WS chat_message_received при C', async () => {
    const { ws, buffer } = await openWs(port, c2.cookie)
    try {
      await sleep(300)
      const res = await request(port, 'POST', `/api/chat/${friendId}/messages`, { body: 'приятелско при OFF' }, a2.cookie)
      assert(res.status === 200 && res.body?.ok !== false, `${res.status} ${res.text}`)
      await waitForWs(buffer, (m) => m.type === 'chat_message_received' && m.friendshipId === friendId)
    } finally {
      ws.close()
    }
  })
  await check('P2j. OFF: friend отговор C→A → 200; история съдържа старите и новите съобщения', async () => {
    const send = await request(port, 'POST', `/api/chat/${friendId}/messages`, { body: 'отговор от C' }, c2.cookie)
    assert(send.status === 200, `${send.status} ${send.text}`)
    const res = await request(port, 'GET', `/api/chat/${friendId}/messages`, undefined, a2.cookie)
    const bodies = messageBodies(res)
    assert(res.status === 200 && ['приятелско съобщение', 'приятелско при OFF', 'отговор от C'].every((b) => bodies.includes(b)), JSON.stringify(bodies))
  })
  await check('P2k. OFF: friend снимка → 200 (attachment пътят не е засегнат)', async () => {
    const res = await request(port, 'POST', `/api/chat/${friendId}/messages`, { body: '', imageDataUrl: IMAGE_DATA_URL }, a2.cookie)
    assert(res.status === 200, `${res.status} ${res.text}`)
  })
  await check('P2l. OFF: GET /api/chat/conversations → friend разговорът е наличен', async () => {
    const res = await request(port, 'GET', '/api/chat/conversations', undefined, a2.cookie)
    const conversations = (res.body?.conversations as Array<{ friendshipId: string; kind: string }> | undefined) ?? []
    assert(res.status === 200 && conversations.some((cv) => cv.friendshipId === friendId && cv.kind === 'friend'), JSON.stringify(conversations))
  })
  await check('P2m. OFF: непознат (D) не може да пише в чужд friend разговор (непроменено)', async () => {
    const res = await request(port, 'POST', `/api/chat/${friendId}/messages`, { body: 'натрапник' }, d2.cookie)
    assert(res.status >= 400 && res.status < 500, `${res.status} ${res.text}`)
  })
  await check('P2n. OFF: изтриване на собствено friend съобщение → 200 (непроменено)', async () => {
    const send = await request(port, 'POST', `/api/chat/${friendId}/messages`, { body: 'за изтриване' }, a2.cookie)
    const messageId = String((send.body?.newMessage as { messageId?: string } | undefined)?.messageId ?? '')
    assert(messageId !== '', `newMessage missing: ${send.text}`)
    const del = await request(port, 'DELETE', `/api/chat/${friendId}/messages/${messageId}`, undefined, a2.cookie)
    assert(del.status === 200, `${del.status} ${del.text}`)
  })

  await stopServer(server)
  server = null

  // ─── P3. ON again ─────────────────────────────────────────────────────────
  console.log('\n=== P3. flag ON отново — възстановяване ===')
  server = startServer(isolated.serverDir, port, '1')
  await waitForServer(port, server)
  const a3 = await login(port, a.email, 'a')
  const b3 = await login(port, b.email, 'b')

  await check('P3a. ON: старият vip_dm разговор е в списъка и историята е цяла', async () => {
    const list = await request(port, 'GET', '/api/chat/conversations', undefined, a3.cookie)
    const conversations = (list.body?.conversations as Array<{ friendshipId: string; kind: string }> | undefined) ?? []
    assert(conversations.some((cv) => cv.friendshipId === vipDmId && cv.kind === 'vip_dm'), JSON.stringify(conversations))
    const res = await request(port, 'GET', `/api/chat/${vipDmId}/messages`, undefined, b3.cookie)
    const bodies = messageBodies(res)
    assert(bodies.includes('старо лично съобщение') && bodies.includes('стар отговор'), JSON.stringify(bodies))
  })
  await check('P3b. ON: ново съобщение в стария vip_dm → 200', async () => {
    const res = await request(port, 'POST', `/api/chat/${vipDmId}/messages`, { body: 'след възстановяване' }, a3.cookie)
    assert(res.status === 200, `${res.status} ${res.text}`)
    assert(countMessages(isolated.databaseFile, vipDmId) === vipDmMessagesBefore + 1, 'message count')
  })
  await check('P3c. ON: нов vip_dm (start-with-message A→D) → 200', async () => {
    const res = await request(port, 'POST', '/api/chat/vip-dm/start-with-message', { recipientProfileId: d.profileId, body: 'нов след възстановяване' }, a3.cookie)
    assert(res.status === 200 && res.body?.ok === true, `${res.status} ${res.text}`)
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  harness: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  if (server) console.error(server.output().slice(-3000))
} finally {
  if (server) await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)
process.exit(failed > 0 ? 1 : 0)
