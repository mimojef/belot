/**
 * checkTopicMessagesRealtime.ts
 *
 * Етап 2 — realtime root съобщения в "Теми": WS send/subscribe/catch-up,
 * server-side VIP authorization, cross-instance poll cursor invariant,
 * avatar batch-hydration. [A17] потвърждава VISIBILITY policy-то: block
 * НЕ филтрира public Topics realtime (поправено — виж диагностичния брифа).
 *
 * Real spawn-нат сървър (или два — за cross-instance теста), изолирана
 * SQLite база, реални HTTP + WS заявки — същия established harness pattern
 * като checkLobbyChat.ts.
 *
 * === Section D: cross-instance poll cursor invariant (чист unit тест) ===
 * [D1] Точния race сценарий от Етап 2 корекция т.1: cursor=100, instance B
 *      insert-ва seq=101 (непознат locally), instance A insert-ва локално
 *      seq=102 (locally-announced) → poll вижда [101,102] → nextCursor=102,
 *      rowsToBroadcast=[101] само (102 е вече доставен instant-но).
 * [D2] Празен batch (нищо ново) → cursor остава непроменен, rowsToBroadcast=[]
 * [D3] Всички редове locally-announced → cursor напредва докрай, rowsToBroadcast=[]
 * [D4] Ред извън ред (defensive) — cursor следва последния подаден ред, не max()
 *
 * === Section A: единична инстанция (HTTP/WS) ===
 * [A1]  Анонимен: subscribe -> topic_message_error not_authenticated (без catch-up); send -> not_authenticated
 * [A2]  Registered non-VIP -> send -> vip_required
 * [A3]  VIP (launch gift claim) -> send веднага разрешен, broadcast стига до подателя с requestId
 * [A4]  Изтекъл VIP (active_until в миналото) -> vip_required
 * [A5]  Unknown topicId -> topic_not_found
 * [A6]  Removed topic -> topic_not_found (НЕ topic_locked)
 * [A7]  Locked topic -> topic_locked
 * [A8]  Empty/whitespace body -> empty_body
 * [A9]  >2000 Unicode code points -> body_too_long; точно 2000 -> позволено
 * [A10] Вътрешен \n (Shift+Enter) НЕ се отхвърля (за разлика от lobby chat)
 * [A11] Forbidden control char () -> invalid_body
 * [A12] Rate limit: 6-о съобщение в прозореца -> rate_limited
 * [A13] Duplicate guard scoped profileId+topicId: същия body в Тема1 după Тема1 -> duplicate_message;
 *       същия body в Тема2 (различна тема, същия подател) -> позволено
 * [A14] requestId е ЗАДЪЛЖИТЕЛЕН структурно — send_topic_message без requestId -> generic parse error, не topic_message_error
 * [A15] Batch avatar hydration: senderAvatarUrl в live broadcast отразява ТЕКУЩИЯ avatar (derived, не snapshot)
 * [A16] Subscribe gap-closing catch-up (Етап 2 корекция т.1): съобщение, изпратено между REST snapshot
 *       и subscribe, се доставя чрез topic_message_catchup, НЕ се губи
 * [A17] Block relationship НЕ филтрира realtime: A блокира B -> A ВСЕ ОЩЕ получава live съобщенията на B; B продължава да вижда тези на A
 *
 * === Section A (продължение): write-policy архитектура — block НЕ ограничава писането ===
 * (диагностичен брифа "PUBLIC TOPIC VISIBILITY vs PUBLIC TOPIC WRITE PERMISSION")
 * [J]  A блокира B. B е owner на custom public topic. A може да публикува ROOT в темата на B.
 * [K]  A блокира B. B е owner на custom public topic. A може да публикува REPLY в темата на B.
 * [L]  B е блокирал A (owner блокира писателя — обратна посока от J/K). A може да публикува ROOT/REPLY в темата на B.
 * [M]  Mutual block A<->B: писането в custom public topic остава разрешено (J/K/L комбинирани в едно DB състояние).
 * [N]  System topics (topic-general/topic-lafche) нямат user owner (created_by_profile_id IS NULL) — няма върху какво да приложи owner-block restriction дори принципно.
 * [O]  Source check: и send_topic_message, и send_topic_reply викат assertCanWriteToTopic() — единствен централен write-policy layer, без bypass path.
 *
 * === Section B: cross-instance (два процеса, обща SQLite база) ===
 * [B1] Съобщение от instance #1 стига до абонат на instance #2 (poll tick)
 * [B2] Няма двойно broadcast-ване към собствения subscriber на изпращащия instance
 *
 * === Section C: poll cursor startup baseline (Етап 2 корекция т.2) ===
 * [C1] Стартиране на сървър срещу DB с ПРЕДИШНА история (стари seq-ове) НЕ
 *      реплеива историческите редове през cross-instance poll-а към
 *      subscriber, чийто afterSeq вече покрива старата история.
 *
 * === Section E: source checks — N+1 avatar lookup guarantee (корекция т.3) ===
 * [E1] hydrateTopicMessagesWithCurrentAvatars вика getProfileSnapshotsByIds
 *      ТОЧНО ВЕДНЪЖ вътре в тялото си (batch, не loop по едно съобщение)
 * [E2] runTopicMessagesCrossInstancePoll вика hydrateTopicMessagesWithCurrentAvatars
 *      ЕДИН ПЪТ на tick за целия rowsToBroadcast batch, НЕ вътре в for-цикъла по редове
 * [E3] subscribe_topic_messages catch-up вика hydrateTopicMessagesWithCurrentAvatars
 *      с целия page.messages масив накуп, не по едно съобщение
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, cp, mkdir, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import { computeTopicMessagePollAdvance } from '../src/realtime/topicMessagePollAdvance.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')

// ─── Брояч ────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── Section D: cross-instance poll cursor invariant (чист unit тест) ─────

console.log('\n=== Topic Messages Realtime — Section D (poll cursor invariant, unit) ===\n')

await check('[D1] Точния race сценарий от корекция т.1: B insert 101, A insert 102 локално — нищо не се губи/дублира', () => {
  const rows = [{ seq: 101, topicId: 't1' }, { seq: 102, topicId: 't1' }]
  const locallyAnnounced = new Set<number>([102]) // A вече е broadcast-нал 102 instant-но при local send
  const result = computeTopicMessagePollAdvance(100, locallyAnnounced, rows)
  assert(result.nextCursor === 102, `nextCursor трябва да е 102, получено ${result.nextCursor}`)
  assert(result.rowsToBroadcast.length === 1, `трябва да broadcast-не точно 1 ред (101), получени ${result.rowsToBroadcast.length}`)
  assert(result.rowsToBroadcast[0]!.seq === 101, `единственият broadcast ред трябва да е seq=101, получен ${result.rowsToBroadcast[0]!.seq}`)
})

await check('[D2] Празен batch — cursor непроменен, нищо за broadcast', () => {
  const result = computeTopicMessagePollAdvance(50, new Set(), [])
  assert(result.nextCursor === 50, 'cursor трябва да остане 50')
  assert(result.rowsToBroadcast.length === 0, 'rowsToBroadcast трябва да е празен')
})

await check('[D3] Всички редове locally-announced — cursor напредва докрай, rowsToBroadcast=[]', () => {
  const rows = [{ seq: 5 }, { seq: 6 }, { seq: 7 }]
  const result = computeTopicMessagePollAdvance(4, new Set([5, 6, 7]), rows)
  assert(result.nextCursor === 7, `cursor трябва да напредне до 7, получено ${result.nextCursor}`)
  assert(result.rowsToBroadcast.length === 0, 'нищо не трябва да се broadcast-не втори път')
})

await check('[D4] Cursor следва ПОСЛЕДНИЯ подаден ред (реда на rows), не max() — defensive проверка на реда', () => {
  const rows = [{ seq: 10 }, { seq: 11 }, { seq: 9 }] // умишлено не-монотонен вход
  const result = computeTopicMessagePollAdvance(0, new Set(), rows)
  assert(result.nextCursor === 9, `cursor трябва да е последния елемент (9), получено ${result.nextCursor} — pollNewMessages винаги е ASC, но функцията не трябва тихо да "поправя" невалиден вход`)
})

// ─── Established HTTP/WS harness (виж checkLobbyChat.ts за пълния rationale) ──

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'TopicsRealtimeCheck1!'

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') { srv.close(() => reject(new Error('No free port'))); return }
      const { port } = addr
      srv.close(() => resolvePort(port))
    })
  })
}

async function waitFor(label: string, pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>((r) => setTimeout(r, 250))
  }
}

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-topics-realtime-http-'))
  const serverDir = join(tmp, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(root, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(root, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(root, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(root, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const lt = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(root, 'node_modules'), join(serverDir, 'node_modules'), lt)
  await symlink(join(root, '..', 'node_modules'), join(tmp, 'node_modules'), lt)
  return {
    serverDir,
    dbFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: () => retryRm(tmp),
  }
}

function startSrv(serverDir: string, port: number): { child: ChildProcessWithoutNullStreams; output(): string } {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port), BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function stopSrv(s: { child: ChildProcessWithoutNullStreams }): Promise<void> {
  if (s.child.exitCode !== null) return
  s.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { s.child.kill('SIGKILL'); r() }, 10_000)
    s.child.once('exit', () => { clearTimeout(t); r() })
  })
}

type HttpResult = { status: number; body: unknown }

async function httpGetJson(port: number, pathname: string, cookie?: string): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* */ }
  return { status: res.status, body }
}

async function httpPostJson(port: number, pathname: string, cookie: string | undefined, payload: unknown): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* */ }
  return { status: res.status, body }
}

async function waitForServerReady(port: number): Promise<void> {
  await waitFor('server ready', async () => {
    try {
      const r = await httpGetJson(port, '/health')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
}

async function registerAndLogin(port: number, email: string, displayName: string): Promise<{ cookie: string; profileId: string }> {
  const regRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName, gender: 'male' }),
  })
  if (regRes.status !== 200) throw new Error(`Register ${email} failed: ${regRes.status}`)

  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const h = loginRes.headers as Headers & { getSetCookie?: () => string[] }
  const cookie = (h.getSetCookie?.()[0] ?? loginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!cookie) throw new Error(`No Set-Cookie on login for ${email}`)

  const meRes = await httpGetJson(port, '/api/auth/me', cookie)
  const profileId = (meRes.body as { session?: { profile?: { profileId?: string } } }).session?.profile?.profileId
  if (!profileId) throw new Error(`No profileId for ${email}`)

  return { cookie, profileId }
}

type AnyMsg = Record<string, unknown> & { type: string }

const wsMessageBuffers = new WeakMap<WebSocket, AnyMsg[]>()

function openWs(port: number, cookie?: string): Promise<WebSocket> {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, cookie ? { headers: { Cookie: cookie } } : undefined)
    const buffer: AnyMsg[] = []
    wsMessageBuffers.set(ws, buffer)
    ws.on('message', (raw: RawData) => {
      try { buffer.push(JSON.parse(raw.toString())) } catch { /* ignore malformed */ }
    })
    const t = setTimeout(() => { ws.terminate(); reject(new Error('WS open timeout')) }, 5000)
    ws.once('open', () => { clearTimeout(t); resolveWs(ws) })
    ws.once('error', (err) => { clearTimeout(t); reject(err) })
  })
}

function sendWs(ws: WebSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message))
}

async function waitForWsMessage(ws: WebSocket, predicate: (msg: AnyMsg) => boolean, timeoutMs = 5000): Promise<AnyMsg> {
  const buffer = wsMessageBuffers.get(ws)
  if (!buffer) throw new Error('WS connection not opened via openWs() — no message buffer registered')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const idx = buffer.findIndex(predicate)
    if (idx !== -1) {
      const [msg] = buffer.splice(idx, 1)
      return msg!
    }
    if (Date.now() > deadline) throw new Error('Timeout waiting for WS message matching predicate')
    await sleep(25)
  }
}

async function collectWsMessages(ws: WebSocket, durationMs: number): Promise<AnyMsg[]> {
  const buffer = wsMessageBuffers.get(ws)
  if (!buffer) throw new Error('WS connection not opened via openWs() — no message buffer registered')
  const startLength = buffer.length
  await sleep(durationMs)
  return buffer.slice(startLength)
}

// ─── Topics-специфични helpers ──────────────────────────────────────────────

function insertTopic(db: DatabaseSync, input: { topicId: string; slug: string; title: string; status?: string; lockedUntil?: string }): void {
  db.prepare(`
    INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order, locked_until)
    VALUES (?, ?, ?, 0, NULL, ?, 100, ?);
  `).run(input.topicId, input.slug, input.title, input.status ?? 'active', input.lockedUntil ?? null)
}

function seedOldTopicMessage(db: DatabaseSync, input: { topicId: string; senderProfileId: string; senderDisplayName: string; body: string }): number {
  const messageId = randomUUID()
  db.prepare(`
    INSERT INTO topic_messages (message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body)
    VALUES (?, ?, NULL, ?, ?, 'player', ?);
  `).run(messageId, input.topicId, input.senderProfileId, input.senderDisplayName, input.body)
  const row = db.prepare(`SELECT seq FROM topic_messages WHERE message_id = ?`).get(messageId) as { seq: number }
  return row.seq
}

async function grantVipViaLaunchGift(port: number, cookie: string): Promise<void> {
  const res = await httpPostJson(port, '/api/vip/claim-launch-gift', cookie, {})
  if (res.status !== 200) throw new Error(`claim-launch-gift failed: ${res.status} ${JSON.stringify(res.body)}`)
}

function setVipExpiredDirectly(db: DatabaseSync, profileId: string): void {
  const pastIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  db.prepare(`
    INSERT INTO vip_status (profile_id, active_until)
    VALUES (?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until;
  `).run(profileId, pastIso)
}

function setProfileAvatarDirectly(db: DatabaseSync, profileId: string, avatarUrl: string): void {
  db.prepare(`UPDATE profiles SET avatar_url = ? WHERE profile_id = ?`).run(avatarUrl, profileId)
}

// ─── Section A: единична инстанция ──────────────────────────────────────────

console.log('\n=== Topic Messages Realtime — Section A (single instance) ===\n')

const isoA = await makeIsolated(serverRoot)
const portA = await getFreePort()
let srvA: ReturnType<typeof startSrv> | null = null

try {
  srvA = startSrv(isoA.serverDir, portA)
  console.log(`  Чакам сървъра на порт ${portA}…`)
  await waitForServerReady(portA)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`
  const userA = await registerAndLogin(portA, `tm-user-a-${runId}@example.test`, 'TopicUserA')
  const userB = await registerAndLogin(portA, `tm-user-b-${runId}@example.test`, 'TopicUserB')

  const db = new DatabaseSync(isoA.dbFile, { open: true, enableForeignKeyConstraints: true })
  insertTopic(db, { topicId: 'topic-a-active', slug: 'a-active', title: 'Активна тема' })
  insertTopic(db, { topicId: 'topic-a-active-2', slug: 'a-active-2', title: 'Втора активна тема' })
  // Temporary lock (Етап 4) — locked_until в бъдещето, огледално на реален
  // topicModerationStore.lockTopic() резултат (виж checkTopicModeration.ts
  // за store-level теста), не само static status enum (иначе новата
  // computed isLocked проверка в index.ts би върнала false — виж
  // getTopicLockSnapshot).
  insertTopic(db, { topicId: 'topic-a-locked', slug: 'a-locked', title: 'Заключена тема', status: 'locked', lockedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') })
  insertTopic(db, { topicId: 'topic-a-removed', slug: 'a-removed', title: 'Премахната тема', status: 'removed' })
  db.close()

  const wsAnon = await openWs(portA)
  const wsA = await openWs(portA, userA.cookie)
  const wsB = await openWs(portA, userB.cookie)

  // Реалният composer flow ВИНАГИ subscribe-ва преди да позволи писане (само
  // активната тема е WS-абонирана наведнъж) — точно както lobby chat изисква
  // subscribe_lobby_chat преди send (виж checkLobbyChat.ts Section A). Без
  // subscribe, insert-ът пак успява (send handler-ът не проверява subscription
  // state), но broadcastTopicMessageToLocalSubscribers няма towards кого да
  // echo-не обратно към подателя — затова тестовите сокети subscribe-ват тук,
  // огледално на реалния client flow.
  sendWs(wsA, { type: 'subscribe_topic_messages', topicId: 'topic-a-active', afterSeq: 0 })
  await waitForWsMessage(wsA, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-a-active')
  sendWs(wsB, { type: 'subscribe_topic_messages', topicId: 'topic-a-active', afterSeq: 0 })
  await waitForWsMessage(wsB, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-a-active')

  await check('[A1] Анонимен: subscribe -> not_authenticated (без catch-up); send -> not_authenticated', async () => {
    sendWs(wsAnon, { type: 'subscribe_topic_messages', topicId: 'topic-a-active', afterSeq: 0 })
    const subErr = await waitForWsMessage(wsAnon, (m) => m.type === 'topic_message_error')
    assert(subErr.code === 'not_authenticated', `subscribe трябва да отхвърли анонимен, получен ${subErr.code}`)

    sendWs(wsAnon, { type: 'send_topic_message', topicId: 'topic-a-active', body: 'опит от анонимен', requestId: 'anon-1' })
    const sendErr = await waitForWsMessage(wsAnon, (m) => m.type === 'topic_message_error' && m.requestId === 'anon-1')
    assert(sendErr.code === 'not_authenticated', `send трябва да отхвърли анонимен, получен ${sendErr.code}`)
  })

  await check('[A2] Регистриран НЕ-VIP -> send -> vip_required', async () => {
    sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-a-active', body: 'преди VIP', requestId: 'req-novip' })
    const err = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_error' && m.requestId === 'req-novip')
    assert(err.code === 'vip_required', `очакван vip_required, получен ${err.code}`)
  })

  await check('[A3] Launch gift claim -> VIP веднага активен -> send разрешен, broadcast с requestId', async () => {
    await grantVipViaLaunchGift(portA, userA.cookie)
    sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-a-active', body: 'вече съм VIP', requestId: 'req-vip-ok' })
    const msg = await waitForWsMessage(wsA, (m) => m.type === 'topic_message' && m.requestId === 'req-vip-ok')
    assert(msg.body === 'вече съм VIP', 'тялото трябва да съвпада')
    assert(typeof msg.messageId === 'string' && msg.messageId.length > 0, 'липсва messageId')
    assert(msg.senderProfileId === userA.profileId, 'senderProfileId трябва да е реалния подател')
  })

  await check('[A4] Изтекъл VIP -> vip_required', async () => {
    const dbExpire = new DatabaseSync(isoA.dbFile, { open: true, enableForeignKeyConstraints: true })
    setVipExpiredDirectly(dbExpire, userA.profileId)
    dbExpire.close()

    sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-a-active', body: 'след изтичане', requestId: 'req-expired' })
    const err = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_error' && m.requestId === 'req-expired')
    assert(err.code === 'vip_required', `очакван vip_required, получен ${err.code}`)

    // Възстановяваме VIP за останалите тестове в тази секция.
    await grantVipViaLaunchGift(portA, userB.cookie) // userB VIP-ва се тук, ще потрябва по-долу
    const dbRestore = new DatabaseSync(isoA.dbFile, { open: true, enableForeignKeyConstraints: true })
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    dbRestore.prepare(`UPDATE vip_status SET active_until = ? WHERE profile_id = ?`).run(future, userA.profileId)
    dbRestore.close()
  })

  await check('[A5] Unknown topicId -> topic_not_found', async () => {
    sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-does-not-exist', body: 'x', requestId: 'req-unknown' })
    const err = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_error' && m.requestId === 'req-unknown')
    assert(err.code === 'topic_not_found', `очакван topic_not_found, получен ${err.code}`)
  })

  await check('[A6] Removed topic -> topic_not_found (НЕ topic_locked)', async () => {
    sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-a-removed', body: 'x', requestId: 'req-removed' })
    const err = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_error' && m.requestId === 'req-removed')
    assert(err.code === 'topic_not_found', `removed тема трябва да е topic_not_found, получен ${err.code}`)
  })

  await check('[A7] Locked topic -> topic_locked', async () => {
    sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-a-locked', body: 'x', requestId: 'req-locked' })
    const err = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_error' && m.requestId === 'req-locked')
    assert(err.code === 'topic_locked', `locked тема трябва да е topic_locked, получен ${err.code}`)
  })

  await check('[A8] Empty/whitespace body -> empty_body', async () => {
    sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-a-active', body: '', requestId: 'req-empty' })
    const e1 = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_error' && m.requestId === 'req-empty')
    assert(e1.code === 'empty_body', `empty трябва да е empty_body, получен ${e1.code}`)

    sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-a-active', body: '     ', requestId: 'req-ws' })
    const e2 = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_error' && m.requestId === 'req-ws')
    assert(e2.code === 'empty_body', `whitespace-only трябва да е empty_body, получен ${e2.code}`)
  })

  await check('[A9] >2000 code points -> body_too_long; точно 2000 -> позволено', async () => {
    const over2000 = 'a'.repeat(2001)
    sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-a-active', body: over2000, requestId: 'req-toolong' })
    const err = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_error' && m.requestId === 'req-toolong')
    assert(err.code === 'body_too_long', `>2000 трябва да е body_too_long, получен ${err.code}`)

    const exactly2000 = 'b'.repeat(2000)
    sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-a-active', body: exactly2000, requestId: 'req-exact2000' })
    const ok = await waitForWsMessage(
      wsA,
      (m) => (m.type === 'topic_message' && m.requestId === 'req-exact2000') || (m.type === 'topic_message_error' && m.requestId === 'req-exact2000'),
    )
    assert(ok.type === 'topic_message', `точно 2000 code points трябва да е позволено, получено ${ok.type}/${(ok as { code?: string }).code}`)
  })

  await check('[A10] Вътрешен \\n (Shift+Enter) НЕ се отхвърля', async () => {
    sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-a-active', body: 'първи ред\nвтори ред', requestId: 'req-newline' })
    const msg = await waitForWsMessage(
      wsA,
      (m) => (m.type === 'topic_message' && m.requestId === 'req-newline') || (m.type === 'topic_message_error' && m.requestId === 'req-newline'),
    )
    assert(msg.type === 'topic_message', `вътрешен \\n трябва да е позволен, получено ${msg.type}/${(msg as { code?: string }).code}`)
    assert(msg.body === 'първи ред\nвтори ред', 'тялото трябва да пази вътрешния newline непокътнат')
  })

  await check('[A11] Forbidden control char (\\u0001) -> invalid_body', async () => {
    sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-a-active', body: 'тексттекст', requestId: 'req-control' })
    const err = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_error' && m.requestId === 'req-control')
    assert(err.code === 'invalid_body', `control char трябва да е invalid_body, получен ${err.code}`)
  })

  await check('[A12] Rate limit: 6-о съобщение в прозореца се отхвърля', async () => {
    let rateLimited = false
    for (let i = 0; i < 6; i++) {
      sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-a-active', body: `rl-${i}-${Date.now()}`, requestId: `req-rl-${i}` })
      const result = await waitForWsMessage(
        wsA,
        (m) => m.requestId === `req-rl-${i}` && (m.type === 'topic_message' || m.type === 'topic_message_error'),
      )
      if (result.type === 'topic_message_error' && result.code === 'rate_limited') {
        rateLimited = true
        break
      }
    }
    assert(rateLimited, 'очаква се rate_limited в рамките на 6 бързи съобщения')
    // Изчакваме прозореца (10s) да изтече, за да не пречи на следващите тестове.
    await sleep(10_200)
  })

  await check('[A13] Duplicate guard scoped profileId+topicId — различна тема НЕ е блокирана', async () => {
    const marker = `dup-marker-${Date.now()}`
    sendWs(wsB, { type: 'send_topic_message', topicId: 'topic-a-active', body: marker, requestId: 'req-dup-1' })
    const first = await waitForWsMessage(wsB, (m) => m.requestId === 'req-dup-1' && (m.type === 'topic_message' || m.type === 'topic_message_error'))
    assert(first.type === 'topic_message', `първото изпращане трябва да мине, получено ${first.type}`)

    sendWs(wsB, { type: 'send_topic_message', topicId: 'topic-a-active', body: marker, requestId: 'req-dup-2' })
    const second = await waitForWsMessage(wsB, (m) => m.requestId === 'req-dup-2' && (m.type === 'topic_message' || m.type === 'topic_message_error'))
    assert(second.type === 'topic_message_error' && second.code === 'duplicate_message', `същия body в СЪЩАТА тема трябва да е duplicate_message, получено ${second.type}/${(second as { code?: string }).code}`)

    // Echo-то за подателя изисква subscription (broadcast филтрира по
    // topicMessageSubscribersByTopicId) — превключваме wsB към
    // topic-a-active-2 временно, после ГО ВРЪЩАМЕ обратно към topic-a-active
    // (Topics UX е скалар — един активен subscribe наведнъж, виж модела в
    // index.ts), за да не счупим следващите тестове по-долу.
    sendWs(wsB, { type: 'subscribe_topic_messages', topicId: 'topic-a-active-2', afterSeq: 0 })
    await waitForWsMessage(wsB, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-a-active-2')

    sendWs(wsB, { type: 'send_topic_message', topicId: 'topic-a-active-2', body: marker, requestId: 'req-dup-3' })
    const third = await waitForWsMessage(wsB, (m) => m.requestId === 'req-dup-3' && (m.type === 'topic_message' || m.type === 'topic_message_error'))
    assert(third.type === 'topic_message', `същия body в РАЗЛИЧНА тема НЕ трябва да е блокиран, получено ${third.type}/${(third as { code?: string }).code}`)

    sendWs(wsB, { type: 'subscribe_topic_messages', topicId: 'topic-a-active', afterSeq: 0 })
    await waitForWsMessage(wsB, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-a-active')
  })

  await check('[A14] requestId е задължителен структурно — липсващ requestId -> generic parse error', async () => {
    const collected = collectWsMessages(wsA, 1500)
    wsA.send(JSON.stringify({ type: 'send_topic_message', topicId: 'topic-a-active', body: 'без requestId' }))
    const messages = await collected
    const genericError = messages.find((m) => m.type === 'error')
    const topicError = messages.find((m) => m.type === 'topic_message_error')
    const echoed = messages.find((m) => m.type === 'topic_message' && m.body === 'без requestId')
    assert(genericError !== undefined, 'очаква се generic { type: "error" } за структурно невалидно съобщение (липсващ requestId)')
    assert(topicError === undefined, 'НЕ трябва да достигне до topic_message_error handler-а (structural reject по-рано)')
    assert(echoed === undefined, 'съобщението НЕ трябва да е било вмъкнато/broadcast-нато')
  })

  await check('[A15] Batch avatar hydration: senderAvatarUrl в live broadcast отразява ТЕКУЩИЯ avatar', async () => {
    const dbAvatar = new DatabaseSync(isoA.dbFile, { open: true, enableForeignKeyConstraints: true })
    setProfileAvatarDirectly(dbAvatar, userB.profileId, '/uploads/avatars/topic-user-b.webp')
    dbAvatar.close()

    sendWs(wsB, { type: 'send_topic_message', topicId: 'topic-a-active', body: 'с нов avatar', requestId: 'req-avatar' })
    const msg = await waitForWsMessage(wsB, (m) => m.type === 'topic_message' && m.requestId === 'req-avatar')
    assert(msg.senderAvatarUrl === '/uploads/avatars/topic-user-b.webp', `senderAvatarUrl трябва да отразява ТЕКУЩИЯ avatar, получено ${msg.senderAvatarUrl}`)
  })

  await check('[A16] Subscribe gap-closing catch-up — съобщение изпратено МЕЖДУ REST snapshot и subscribe не се губи', async () => {
    // 1) "REST snapshot" — реалния REST endpoint, точно както клиентът би направил initial load.
    const restResult = await httpGetJson(portA, '/api/topics/topic-a-active-2/messages', userA.cookie)
    const restBody = restResult.body as { ok: boolean; messages: Array<{ seq: number }> }
    assert(restBody.ok === true, 'REST history заявката трябва да успее')
    const latestKnownSeq = restBody.messages.length > 0 ? Math.max(...restBody.messages.map((m) => m.seq)) : 0

    // 2) Съобщение, изпратено В ПРОЗОРЕЦА между snapshot-а и subscribe-а (симулира race-а от корекция т.1).
    // wsB временно subscribe-ва към topic-a-active-2, за да получи echo
    // потвърждение за успешния send (виж коментара в A13) — после се връща
    // обратно към topic-a-active за следващите тестове (A17).
    sendWs(wsB, { type: 'subscribe_topic_messages', topicId: 'topic-a-active-2', afterSeq: 0 })
    await waitForWsMessage(wsB, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-a-active-2')

    const gapMarker = `gap-message-${Date.now()}`
    sendWs(wsB, { type: 'send_topic_message', topicId: 'topic-a-active-2', body: gapMarker, requestId: 'req-gap' })
    await waitForWsMessage(wsB, (m) => m.type === 'topic_message' && m.requestId === 'req-gap')

    sendWs(wsB, { type: 'subscribe_topic_messages', topicId: 'topic-a-active', afterSeq: 0 })
    await waitForWsMessage(wsB, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-a-active')

    // 3) Едва СЕГА subscribe-ва с afterSeq = latestKnownSeq (gap-closing cursor).
    sendWs(wsA, { type: 'subscribe_topic_messages', topicId: 'topic-a-active-2', afterSeq: latestKnownSeq })
    const catchup = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-a-active-2')
    const catchupMessages = catchup.messages as Array<{ body: string }>
    assert(catchupMessages.some((m) => m.body === gapMarker), 'gap-съобщението трябва да е в catch-up batch-а, не изгубено')
  })

  await check('[A17] Block relationship НЕ филтрира realtime: A блокира B -> A ВСЕ ОЩЕ получава live съобщенията на B (block != hide public Topics content)', async () => {
    const blockRes = await httpPostJson(portA, `/api/profiles/${encodeURIComponent(userB.profileId)}/block`, userA.cookie, {})
    assert(blockRes.status === 200, `block заявката трябва да успее, получен статус ${blockRes.status}`)

    sendWs(wsA, { type: 'subscribe_topic_messages', topicId: 'topic-a-active', afterSeq: 999999 })
    await waitForWsMessage(wsA, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-a-active')
    sendWs(wsB, { type: 'subscribe_topic_messages', topicId: 'topic-a-active', afterSeq: 999999 })
    await waitForWsMessage(wsB, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-a-active')

    // wsB е изчерпала per-profile rate limit-а (A13/A15/A16 кумулативно, без
    // sleep между тях, за разлика от A12) — изчакваме прозореца ПРЕДИ първия
    // send тук.
    await sleep(10_200)

    const marker = `blocked-sender-${Date.now()}`
    sendWs(wsB, { type: 'send_topic_message', topicId: 'topic-a-active', body: marker, requestId: 'req-blocked' })
    await waitForWsMessage(wsB, (m) => m.type === 'topic_message' && m.requestId === 'req-blocked')
    const seenByA = await waitForWsMessage(wsA, (m) => m.type === 'topic_message' && m.body === marker, 3000)
    assert(seenByA.body === marker, 'A е блокирал B, но публичното live съобщение на B трябва все пак да стигне до A (VISIBILITY fix: block != hide public Topics content)')

    const reverseMarker = `reverse-direction-${Date.now()}`
    sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-a-active', body: reverseMarker, requestId: 'req-reverse' })
    const seenByB = await waitForWsMessage(wsB, (m) => m.type === 'topic_message' && m.body === reverseMarker, 3000)
    assert(seenByB.body === reverseMarker, 'B (не е блокирал A) продължава да вижда съобщенията на A')
  })

  // ── Write-policy архитектура: block НЕ ограничава писането ───────────────
  // [A17] по-горе доказа VISIBILITY policy-то (A вече е блокирал B преди
  // тази точка в теста — A->B block relationship е активен, и потвърдихме,
  // че той НЕ филтрира realtime). Тук доказваме, че СЪЩОТО block relationship
  // НЕ пипа WRITE permission-а — архитектурно отделен gate
  // (assertCanWriteToTopic, index.ts) — виж диагностичния брифа "DO NOT
  // COUPLE VISIBILITY TO WRITE POLICY".

  let topicOwnedByBId = ''
  let caseJRootMessageId = ''

  await check('[J] A блокира B (активно от A17). B е owner на custom тема. A публикува ROOT в темата на B -> позволено', async () => {
    // Реален create_topic през wsB (не raw SQL insert) — topicStore.createTopic
    // задава createdByProfileId = самия creator, значи темата е ДЕЙСТВИТЕЛНО
    // owned от B през нормалния продуктов път (userB вече е VIP, виж A4).
    const createMarker = `case-jkl-topic-${Date.now()}`
    sendWs(wsB, { type: 'create_topic', title: createMarker, requestId: 'req-case-create' })
    const created = await waitForWsMessage(wsB, (m) => m.type === 'topic_created' && m.requestId === 'req-case-create')
    const createdTopic = created.topic as { topicId: string; createdByProfileId: string | null }
    assert(createdTopic.createdByProfileId === userB.profileId, 'новосъздадената тема трябва да има createdByProfileId = userB.profileId')
    topicOwnedByBId = createdTopic.topicId

    // Fresh rate-limit прозорец преди новата серия sends — established idiom
    // от A17 по-горе (checkTopicMessageRateLimit е per-profile, не per-topic).
    await sleep(10_200)

    sendWs(wsA, { type: 'subscribe_topic_messages', topicId: topicOwnedByBId, afterSeq: 0 })
    await waitForWsMessage(wsA, (m) => m.type === 'topic_message_catchup' && m.topicId === topicOwnedByBId)

    const marker = `case-j-root-${Date.now()}`
    sendWs(wsA, { type: 'send_topic_message', topicId: topicOwnedByBId, body: marker, requestId: 'req-case-j' })
    const sent = await waitForWsMessage(wsA, (m) => m.type === 'topic_message' && m.requestId === 'req-case-j')
    assert(sent.body === marker, 'A (блокирал B) трябва да може да публикува ROOT в темата на B (owner) — block != deny posting in public Topics')
    caseJRootMessageId = sent.messageId as string
  })

  await check('[K] A блокира B. B е owner. A публикува REPLY в темата на B -> позволено', async () => {
    assert(caseJRootMessageId.length > 0, '[J] трябва да мине успешно преди [K] (нужен е root messageId за parentMessageId)')
    const marker = `case-k-reply-${Date.now()}`
    sendWs(wsA, { type: 'send_topic_reply', topicId: topicOwnedByBId, parentMessageId: caseJRootMessageId, body: marker, requestId: 'req-case-k' })
    const sent = await waitForWsMessage(wsA, (m) => m.type === 'topic_reply' && m.requestId === 'req-case-k')
    assert(sent.body === marker, 'A трябва да може да публикува REPLY в темата на B (owner, блокиран от A) — block != deny posting in public Topics')
  })

  let caseLRootMessageId = ''

  await check('[L] B блокира A (обратна посока — owner блокира писателя; сега mutual с A17). A публикува ROOT в темата на B -> позволено', async () => {
    const blockBtoARes = await httpPostJson(portA, `/api/profiles/${encodeURIComponent(userA.profileId)}/block`, userB.cookie, {})
    assert(blockBtoARes.status === 200, `B->A block заявката трябва да успее, получен статус ${blockBtoARes.status}`)

    const marker = `case-l-root-${Date.now()}`
    sendWs(wsA, { type: 'send_topic_message', topicId: topicOwnedByBId, body: marker, requestId: 'req-case-l-root' })
    const sent = await waitForWsMessage(wsA, (m) => m.type === 'topic_message' && m.requestId === 'req-case-l-root')
    assert(sent.body === marker, 'A трябва да може да публикува ROOT в темата на B дори B да е блокирал A (owner->writer посока) — block != deny posting')
    caseLRootMessageId = sent.messageId as string
  })

  await check('[L] B блокира A. A публикува REPLY в темата на B -> позволено', async () => {
    assert(caseLRootMessageId.length > 0, 'предходният [L] check трябва да мине успешно преди този')
    const marker = `case-l-reply-${Date.now()}`
    sendWs(wsA, { type: 'send_topic_reply', topicId: topicOwnedByBId, parentMessageId: caseLRootMessageId, body: marker, requestId: 'req-case-l-reply' })
    const sent = await waitForWsMessage(wsA, (m) => m.type === 'topic_reply' && m.requestId === 'req-case-l-reply')
    assert(sent.body === marker, 'A трябва да може да публикува REPLY в темата на B дори B да е блокирал A — block != deny posting')
  })

  await check('[M] Mutual block A<->B (player_blocks и в двете посоки) — public custom Topics write остава разрешен (виж [L] по-горе)', () => {
    const dbCaseM = new DatabaseSync(isoA.dbFile, { open: true, enableForeignKeyConstraints: true })
    const aToB = dbCaseM.prepare('SELECT 1 FROM player_blocks WHERE blocker_profile_id = ? AND blocked_profile_id = ?').get(userA.profileId, userB.profileId)
    const bToA = dbCaseM.prepare('SELECT 1 FROM player_blocks WHERE blocker_profile_id = ? AND blocked_profile_id = ?').get(userB.profileId, userA.profileId)
    dbCaseM.close()
    assert(aToB !== undefined, 'A->B block трябва да е активен (установен в [A17])')
    assert(bToA !== undefined, 'B->A block трябва да е активен (установен в [L]) -> mutual block A<->B')
    // [L] по-горе вече доказа поведенчески, че при ТОЧНО това mutual
    // състояние A продължава да публикува ROOT+REPLY в темата на B — current
    // policy (mutual block НЕ ограничава public custom Topics писане).
  })

  await check('[N] System topics (topic-general/topic-lafche) нямат user owner -> created_by_profile_id IS NULL', () => {
    const dbCaseN = new DatabaseSync(isoA.dbFile, { open: true, enableForeignKeyConstraints: true })
    const general = dbCaseN.prepare('SELECT created_by_profile_id FROM topics WHERE topic_id = ?').get('topic-general') as { created_by_profile_id: string | null } | undefined
    const lafche = dbCaseN.prepare('SELECT created_by_profile_id FROM topics WHERE topic_id = ?').get('topic-lafche') as { created_by_profile_id: string | null } | undefined
    dbCaseN.close()
    assert(general !== undefined, 'topic-general трябва да съществува (seed migration 20260810_002)')
    assert(general!.created_by_profile_id === null, 'topic-general.created_by_profile_id трябва да е NULL — системна тема, без user owner, значи няма върху какво да важи owner-block restriction')
    assert(lafche !== undefined, 'topic-lafche трябва да съществува (seed migration 20260817_002)')
    assert(lafche!.created_by_profile_id === null, 'topic-lafche.created_by_profile_id трябва да е NULL — системна тема, без user owner')
  })

  wsAnon.terminate()
  wsA.terminate()
  wsB.terminate()
} catch (err) {
  fail('Section A error', err)
  if (srvA) console.error('\n[server A output]\n' + srvA.output().slice(-3000))
} finally {
  if (srvA) await stopSrv(srvA)
  await isoA.cleanup()
}

// ─── Section B: cross-instance (два процеса, обща SQLite база) ─────────────

console.log('\n=== Topic Messages Realtime — Section B (cross-instance) ===\n')

const isoB = await makeIsolated(serverRoot)
const portB1 = await getFreePort()
const portB2 = await getFreePort()
let srvB1: ReturnType<typeof startSrv> | null = null
let srvB2: ReturnType<typeof startSrv> | null = null

try {
  srvB1 = startSrv(isoB.serverDir, portB1)
  console.log(`  Чакам instance #1 на порт ${portB1}…`)
  await waitForServerReady(portB1)

  srvB2 = startSrv(isoB.serverDir, portB2)
  console.log(`  Чакам instance #2 на порт ${portB2}…`)
  await waitForServerReady(portB2)
  console.log('  И двете инстанции са готови (споделят една SQLite база).\n')

  const runId = `${Date.now()}-${process.pid}`
  const senderOnB1 = await registerAndLogin(portB1, `tm-cross-sender-${runId}@example.test`, 'CrossSenderTopics')
  const subscriberOnB2 = await registerAndLogin(portB2, `tm-cross-subscriber-${runId}@example.test`, 'CrossSubTopics')

  await grantVipViaLaunchGift(portB1, senderOnB1.cookie)

  const dbB = new DatabaseSync(isoB.dbFile, { open: true, enableForeignKeyConstraints: true })
  insertTopic(dbB, { topicId: 'topic-cross', slug: 'cross', title: 'Cross instance тема' })
  dbB.close()

  const wsSenderOnB1 = await openWs(portB1, senderOnB1.cookie)
  const wsSubscriberOnB2 = await openWs(portB2, subscriberOnB2.cookie)

  sendWs(wsSenderOnB1, { type: 'subscribe_topic_messages', topicId: 'topic-cross', afterSeq: 0 })
  await waitForWsMessage(wsSenderOnB1, (m) => m.type === 'topic_message_catchup')
  sendWs(wsSubscriberOnB2, { type: 'subscribe_topic_messages', topicId: 'topic-cross', afterSeq: 0 })
  await waitForWsMessage(wsSubscriberOnB2, (m) => m.type === 'topic_message_catchup')

  await check('[B1] Съобщение от instance #1 стига до абонат на instance #2 (cross-instance poll)', async () => {
    const marker = `cross-instance-topic-${Date.now()}`
    sendWs(wsSenderOnB1, { type: 'send_topic_message', topicId: 'topic-cross', body: marker, requestId: 'req-cross-1' })
    await waitForWsMessage(wsSenderOnB1, (m) => m.type === 'topic_message' && m.requestId === 'req-cross-1')

    // Cross-instance poll-ът тик-ва на ~700ms — изчакваме до 5с за instance #2.
    const seenOnB2 = await waitForWsMessage(
      wsSubscriberOnB2,
      (m) => m.type === 'topic_message' && m.body === marker,
      5000,
    )
    assert(seenOnB2.senderDisplayName === 'CrossSenderTopics', 'display name трябва да е коректен и през cross-instance пътя')
  })

  await check('[B2] Няма двойно broadcast-ване към собствения subscriber на изпращащия instance', async () => {
    const marker = `no-double-broadcast-topic-${Date.now()}`
    const collected = collectWsMessages(wsSenderOnB1, 2500)
    sendWs(wsSenderOnB1, { type: 'send_topic_message', topicId: 'topic-cross', body: marker, requestId: 'req-nodup' })
    const messages = await collected
    const matches = messages.filter((m) => m.type === 'topic_message' && m.body === marker)
    assert(matches.length === 1, `подателят трябва да види съобщението си точно веднъж, видени ${matches.length} пъти`)
  })

  wsSenderOnB1.terminate()
  wsSubscriberOnB2.terminate()
} catch (err) {
  fail('Section B error', err)
  if (srvB1) console.error('\n[server B1 output]\n' + srvB1.output().slice(-2000))
  if (srvB2) console.error('\n[server B2 output]\n' + srvB2.output().slice(-2000))
} finally {
  if (srvB1) await stopSrv(srvB1)
  if (srvB2) await stopSrv(srvB2)
  await isoB.cleanup()
}

// ─── Section C: poll cursor startup baseline (корекция т.2) ────────────────

console.log('\n=== Topic Messages Realtime — Section C (poll cursor startup baseline) ===\n')

const isoC = await makeIsolated(serverRoot)
const portC = await getFreePort()
let srvC: ReturnType<typeof startSrv> | null = null

try {
  // 1) Първо реален server bootstrap (празна база) — оставяме СЪЩИЯ migration
  // runner на сървъра (ensureServerDatabaseReady), който сървърът реално ползва
  // при production startup, да приложи всички миграции. Ръчно пре-изпълнение на
  // SQL файловете тук би дублирало non-idempotent ALTER TABLE стъпки от по-стари
  // миграции (несвързани с Темите) и би счупило bootstrap-а при реалния старт.
  srvC = startSrv(isoC.serverDir, portC)
  console.log(`  Bootstrap: чакам празен сървър (за да приложи миграциите нормално) на порт ${portC}…`)
  await waitForServerReady(portC)
  await stopSrv(srvC)
  srvC = null

  // На Windows файловият handle към SQLite WAL/-shm понякога се освобождава с
  // малко закъснение след процеса реално да е излязъл (виж аналогичния
  // коментар в checkTopicsStore.ts withTempDir) — кратка пауза преди да
  // отворим нова връзка към същия файл.
  await sleep(500)

  // 2) Seed-ваме "историческа" тема директно в ВЕЧЕ МИГРИРАНАТА база — това е
  // restart симулация: следващия старт на процеса ще намери тази история
  // готова, точно както рестарт на production Node instance би намерил.
  const seedDb = new DatabaseSync(isoC.dbFile, { open: true, enableForeignKeyConstraints: true })
  seedDb.exec('PRAGMA foreign_keys = ON;')
  seedDb.prepare(`
    INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)
  `).run('seed-old-author', 'OldAuthor', 'oldauthor')
  insertTopic(seedDb, { topicId: 'topic-old-history', slug: 'old-history', title: 'Стара история' })
  let lastOldSeq = 0
  for (let i = 0; i < 5; i++) {
    lastOldSeq = seedOldTopicMessage(seedDb, {
      topicId: 'topic-old-history',
      senderProfileId: 'seed-old-author',
      senderDisplayName: 'OldAuthor',
      body: `стара новина ${i}`,
    })
  }
  seedDb.close()

  // 3) Реален "рестарт" — нов процес срещу СЪЩИЯ dbFile, вече съдържащ старата история.
  srvC = startSrv(isoC.serverDir, portC)
  console.log(`  Рестарт: чакам сървъра (със seed-ната стара история) на порт ${portC}…`)
  await waitForServerReady(portC)
  console.log('  Сървърът е готов — topicMessagePollCursor трябва да е стартирал от getMaxSeq(), не от 0.\n')

  const runId = `${Date.now()}-${process.pid}`
  const viewer = await registerAndLogin(portC, `tm-startup-baseline-${runId}@example.test`, 'StartupBaselineViewer')
  const wsViewer = await openWs(portC, viewer.cookie)

  await check('[C1] Startup baseline: cross-instance poll НЕ реплейва старата история като нови live push-ове', async () => {
    // Subscribe с afterSeq = вече познатия seq (симулира REST-loaded клиент,
    // който вече е видял старите 5 съобщения) — catch-up трябва да е празен.
    sendWs(wsViewer, { type: 'subscribe_topic_messages', topicId: 'topic-old-history', afterSeq: lastOldSeq })
    const catchup = await waitForWsMessage(wsViewer, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-old-history')
    assert(Array.isArray(catchup.messages) && catchup.messages.length === 0, 'catch-up не трябва да съдържа нищо — afterSeq вече покрива цялата стара история')
    assert(catchup.truncated === false, 'truncated трябва да е false')

    // Ако poll cursor-ът грешно беше стартирал от 0, следващите poll тикове
    // (на ~700ms) биха broadcast-нали ВСИЧКИТЕ 5 стари съобщения като "нови"
    // live push-ове към subscriber-а веднага след subscribe. Изчакваме >2
    // poll тика и проверяваме, че НИЩО спонтанно не пристига.
    const spontaneous = await collectWsMessages(wsViewer, 1800)
    const unexpectedLivePush = spontaneous.filter((m) => m.type === 'topic_message')
    assert(
      unexpectedLivePush.length === 0,
      `startup baseline е грешен — старата история е реплейната като live push (${unexpectedLivePush.length} съобщения), poll cursor трябва да стартира от getMaxSeq(), не от 0`,
    )
  })

  wsViewer.terminate()
} catch (err) {
  fail('Section C error', err)
  if (srvC) console.error('\n[server C output]\n' + srvC.output().slice(-3000))
} finally {
  if (srvC) await stopSrv(srvC)
  await isoC.cleanup()
}

// ─── Section E: source checks — N+1 avatar lookup guarantee (корекция т.3) ─

console.log('\n=== Topic Messages Realtime — Section E (N+1 avatar lookup source checks) ===\n')

{
  const { readFileSync } = await import('node:fs')
  const serverSrc = readFileSync(join(serverRoot, 'src', 'index.ts'), 'utf8')

  await check('[E1] hydrateTopicMessagesWithCurrentAvatars вика getProfileSnapshotsByIds ТОЧНО ВЕДНЪЖ (batch, не loop)', () => {
    const fnBody = serverSrc.match(/function hydrateTopicMessagesWithCurrentAvatars\(([\s\S]*?)\n\}/)?.[0] ?? ''
    assert(fnBody.length > 0, 'hydrateTopicMessagesWithCurrentAvatars не е намерена')
    const callCount = (fnBody.match(/playerProgressStore\.getProfileSnapshotsByIds\(/g) ?? []).length
    assert(callCount === 1, `очаква се точно 1 извикване на getProfileSnapshotsByIds вътре в hydrate helper-а, намерени ${callCount}`)
    assert(!/for\s*\([^)]*\)\s*\{[\s\S]*getProfileSnapshotsByIds/.test(fnBody), 'getProfileSnapshotsByIds не трябва да е вътре в for-цикъл')
  })

  await check('[E2] runTopicMessagesCrossInstancePoll вика hydrateTopicMessagesWithCurrentAvatars ЕДИН път на tick, извън for-цикъла по редове', () => {
    const fnBody = serverSrc.match(/function runTopicMessagesCrossInstancePoll\(\)[\s\S]*?\n\}/)?.[0] ?? ''
    assert(fnBody.length > 0, 'runTopicMessagesCrossInstancePoll не е намерена')
    const callCount = (fnBody.match(/hydrateTopicMessagesWithCurrentAvatars\(/g) ?? []).length
    assert(callCount === 1, `очаква се точно 1 извикване на hydrateTopicMessagesWithCurrentAvatars на tick, намерени ${callCount}`)
    const forLoopBlock = fnBody.match(/for\s*\(const row of rows\)\s*\{[\s\S]*?\n    \}/)?.[0] ?? ''
    assert(!forLoopBlock.includes('hydrateTopicMessagesWithCurrentAvatars'), 'hydrate НЕ трябва да е вътре в for-цикъла по individual редове (би било N+1)')
  })

  await check('[E3] subscribe_topic_messages catch-up вика hydrateTopicMessagesWithCurrentAvatars с целия page.messages накуп', () => {
    const subscribeBlock = serverSrc.match(/if \(message\.type === 'subscribe_topic_messages'\)[\s\S]{0,3200}/)?.[0] ?? ''
    assert(subscribeBlock.includes('hydrateTopicMessagesWithCurrentAvatars(page.messages)'), 'catch-up трябва да подаде целия page.messages масив накуп, не по едно съобщение в цикъл')
  })

  // Perf audit fix — broadcast fan-out N+1 elimination (два кръга). Първи
  // кръг: viewerAwareReplyCount/getTopicThreadUnreadCountForProfile/
  // viewerHasLikedMessage бяха вътре в for цикъла по subscriber connections —
  // O(S×3)/O(S) заявки, S=connected subscribers. Втори кръг (follow-up):
  // дори след dedupe по connection, getTopicThreadUnreadCountForProfile
  // остана в LOOP по уникален profileId — O(uniqueProfiles) заявки. Финално:
  // getTopicThreadUnreadCountsForProfiles batch-ва целия profile set в
  // ФИКСИРАН малък брой SQL statements (независим от profile count),
  // извикан ИЗВЪН всички for-цикли. Тестовете по-долу доказват СТРУКТУРНО
  // (source-level), не само поведенчески, че per-recipient/per-profile-loop
  // SQL заявки вече не съществуват в тези loop-ове изобщо.
  await check('[E4] broadcastTopicMessageToLocalSubscribers прави batch unread lookup ИЗВЪН всички for-цикли (нула SQL в loop-овете)', () => {
    const fnBody = serverSrc.match(/function broadcastTopicMessageToLocalSubscribers\(([\s\S]*?)\n\}/)?.[0] ?? ''
    assert(fnBody.length > 0, 'broadcastTopicMessageToLocalSubscribers не е намерена')
    // Точно ДВА for-цикъла остават в тялото: (1) collect live recipients —
    // само connection/socket/block lookups (in-memory); (2) финалният send
    // loop — само map lookup + safeSendToConnection. Няма трети "loop по
    // уникален profileId" вече — batch call-ът замества го изцяло.
    assert(!/for\s*\(const profileId of uniqueViewerProfileIds\)/.test(fnBody), 'не трябва да има loop по uniqueViewerProfileIds — batch call-ът замества го')
    const connectionIteratingLoops = [...fnBody.matchAll(/for\s*\(const (?:subscriberConnectionId|recipient) of [^)]*\)\s*\{([\s\S]*?)\n    \}/g)].map((m) => m[1] ?? '')
    assert(connectionIteratingLoops.length >= 2, `очакват се точно 2 connection-iterating for-цикъла (collect + send), намерени ${connectionIteratingLoops.length}`)
    for (const body of connectionIteratingLoops) {
      assert(!body.includes('topicMessageStore.getBroadcastViewerDataForProfiles('), 'batch viewer-data lookup не трябва да е вътре в connection-iterating for-цикъла (би било N+1 отново)')
      assert(!body.includes('getTopicThreadUnreadCountForProfile('), 'единичният unread SQL lookup не трябва да е никъде в тази функция')
      assert(!body.includes('getTopicThreadUnreadCountsForProfiles('), 'batch unread lookup не трябва да е вътре в for-цикъл (трябва да е извън, ЕДИН път за целия batch)')
    }
    // Batch извикването трябва да е ИЗВЪН всички for-цикли, върху dedupe-нат
    // uniqueViewerProfileIds set (не connection list).
    assert(
      fnBody.includes('getTopicThreadUnreadCountsForProfiles(') && fnBody.includes('snapshot.messageId,') && fnBody.includes('uniqueViewerProfileIds,'),
      'batch unread call трябва да мине snapshot.messageId + uniqueViewerProfileIds (dedupe-нат set) извън for-циклите',
    )
    assert(fnBody.includes('new Set('), 'трябва да dedupe-ва profileId-та чрез Set преди batch lookup-а')
  })

  await check('[E5] broadcastTopicReplyToLocalSubscribers не вика SQL-backed helper вътре в for-цикъла по subscribers', () => {
    const fnBody = serverSrc.match(/function broadcastTopicReplyToLocalSubscribers\(([\s\S]*?)\n\}/)?.[0] ?? ''
    assert(fnBody.length > 0, 'broadcastTopicReplyToLocalSubscribers не е намерена')
    const forLoopBodies = [...fnBody.matchAll(/for\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/g)].map((m) => m[1] ?? '')
    assert(forLoopBodies.length >= 2, `очакват се поне 2 for-цикъла (collect + send), намерени ${forLoopBodies.length}`)
    for (const body of forLoopBodies) {
      assert(!body.includes('topicMessageStore.getBroadcastViewerDataForProfiles('), 'batch viewer-data lookup не трябва да е вътре в per-subscriber for-цикъла (би било N+1 отново)')
      assert(!body.includes('viewerHasLikedMessage('), 'per-connection viewerHasLikedMessage SQL call не трябва да е в for-цикъла')
    }
    assert(fnBody.includes('new Set('), 'трябва да dedupe-ва profileId-та чрез Set преди batch lookup-а')
  })

  await check('[E6] reconcileTopicUnreadForDirectorySubscribers прави batch unread lookup ИЗВЪН всички for-цикли (фиксиран брой SQL, не loop по profileId)', () => {
    const fnBody = serverSrc.match(/function reconcileTopicUnreadForDirectorySubscribers\(([\s\S]*?)\n\}/)?.[0] ?? ''
    assert(fnBody.length > 0, 'reconcileTopicUnreadForDirectorySubscribers не е намерена')
    // Два прохода: (1) collect-ващият for-цикъл по topicsDirectorySubscriberConnectionIds
    // — прави connection-specific WRITE (markTopicSeenForActiveProfile) и
    // collect-ва readRecipients, но НЕ прави unread READ SQL заявка; (2)
    // финалният send loop по readRecipients — само map lookup + send, нула SQL.
    assert(!/for\s*\(const profileId of uniqueProfileIds\)/.test(fnBody), 'не трябва да има loop по уникален profileId, викащ единичен unread lookup — batch call-ът замества го')
    const collectLoopBody = fnBody.match(/for\s*\(const subscriberConnectionId of \[\.\.\.topicsDirectorySubscriberConnectionIds\]\)\s*\{([\s\S]*?)\n  \}/)?.[1] ?? ''
    assert(collectLoopBody.length > 0, 'collect for-цикълът по topicsDirectorySubscriberConnectionIds не е намерен')
    assert(!collectLoopBody.includes('getTopicUnreadCountForProfile('), 'единичен topic-level unread SQL call не трябва да е в collect loop-а')
    assert(!collectLoopBody.includes('getTopicThreadUnreadCountForProfile('), 'единичен thread-level unread SQL call не трябва да е в collect loop-а')
    assert(collectLoopBody.includes('markTopicSeenForActiveProfile('), 'connection-specific WRITE-ът трябва да остане в collect loop-а (per-connection, различни connections могат легитимно да имат различен activeTopicId)')

    const sendLoopBody = fnBody.match(/for\s*\(const recipient of readRecipients\)\s*\{([\s\S]*?)\n  \}/)?.[1] ?? ''
    assert(sendLoopBody.length > 0, 'send for-цикълът по readRecipients не е намерен')
    assert(!sendLoopBody.includes('getTopicUnreadCountsForProfiles('), 'batch call не трябва да е вътре в send loop-а (трябва да е извън, ЕДИН път за целия batch)')
    assert(!sendLoopBody.includes('getTopicThreadUnreadCountsForProfiles('), 'batch call не трябва да е вътре в send loop-а')
    assert(/topicUnreadCountByProfileId\.get\(recipient\.profileId\)/.test(sendLoopBody), 'send loop-ът трябва да чете от вече изчисления batch resultat чрез map lookup')

    // Batch извикванията трябва да са ИЗВЪН двата for-цикъла, върху
    // dedupe-нат uniqueProfileIds set.
    assert(fnBody.includes('getTopicUnreadCountsForProfiles(topicId, uniqueProfileIds,'), 'batch topic-level unread call липсва извън for-циклите')
    assert(fnBody.includes('getTopicThreadUnreadCountsForProfiles(rootMessageId, uniqueProfileIds,'), 'batch thread-level unread call липсва извън for-циклите')
    assert(fnBody.includes('new Set('), 'трябва да dedupe-ва profileId-та чрез Set преди batch lookup-а')
  })

  await check('[E7] getGeneralThreadUnreadTotal (General unread hot path) вече не прави GROUP BY / temp B-tree заявка', () => {
    const readStateSrc = readFileSync(join(serverRoot, 'src', 'db', 'topicReadStateStore.ts'), 'utf8')
    const fnBody = readStateSrc.match(/function getGeneralThreadUnreadTotal\(([\s\S]*?)\n  \}/)?.[0] ?? ''
    assert(fnBody.length > 0, 'getGeneralThreadUnreadTotal не е намерена')
    assert(!fnBody.includes('GROUP BY'), 'заявката вече не трябва да прави GROUP BY (елиминиран temp B-tree hot path за unbounded "Общи" история)')
    assert(!fnBody.includes('SUM(unread_count)'), 'заявката вече не трябва да е nested SUM върху per-thread breakdown subquery')
    assert(fnBody.includes('COUNT(*)'), 'заявката трябва да е директен COUNT(*) без per-thread GROUP BY')
  })

  await check('[O] send_topic_message И send_topic_reply викат assertCanWriteToTopic() ПРЕДИ insert — единствен централен write-policy layer, без bypass path', () => {
    const sendMessageBlock = serverSrc.match(/if \(message\.type === 'send_topic_message'\)[\s\S]*?(?=\n\s*if \(message\.type === 'send_topic_reply'\))/)?.[0] ?? ''
    const sendReplyBlock = serverSrc.match(/if \(message\.type === 'send_topic_reply'\)[\s\S]*?(?=\n\s*if \(message\.type === 'toggle_topic_message_like'\))/)?.[0] ?? ''
    assert(sendMessageBlock.length > 0, 'send_topic_message handler-ът не е намерен')
    assert(sendReplyBlock.length > 0, 'send_topic_reply handler-ът не е намерен')

    assert(sendMessageBlock.includes('assertCanWriteToTopic('), 'send_topic_message трябва да вика централния write-policy helper')
    assert(sendReplyBlock.includes('assertCanWriteToTopic('), 'send_topic_reply трябва да вика централния write-policy helper')

    // Ordering: write-policy проверката трябва да е ПРЕДИ реалния insert —
    // никой insert path не бива да заобикаля helper-а.
    const insertMessageIdx = sendMessageBlock.indexOf('topicMessageStore.insertMessage(')
    const writeCheckIdxInMessage = sendMessageBlock.indexOf('assertCanWriteToTopic(')
    assert(
      insertMessageIdx >= 0 && writeCheckIdxInMessage >= 0 && writeCheckIdxInMessage < insertMessageIdx,
      'assertCanWriteToTopic трябва да се извиква ПРЕДИ topicMessageStore.insertMessage',
    )

    const insertReplyIdx = sendReplyBlock.indexOf('topicMessageStore.insertReply(')
    const writeCheckIdxInReply = sendReplyBlock.indexOf('assertCanWriteToTopic(')
    assert(
      insertReplyIdx >= 0 && writeCheckIdxInReply >= 0 && writeCheckIdxInReply < insertReplyIdx,
      'assertCanWriteToTopic трябва да се извиква ПРЕДИ topicMessageStore.insertReply',
    )

    // Единствени insert call sites в целия сървър (потвърждава, че няма
    // alternate/трети write path около централния gate).
    const totalInsertMessageCalls = (serverSrc.match(/topicMessageStore\.insertMessage\(/g) ?? []).length
    const totalInsertReplyCalls = (serverSrc.match(/topicMessageStore\.insertReply\(/g) ?? []).length
    assert(totalInsertMessageCalls === 1, `очаква се точно 1 call site за topicMessageStore.insertMessage в целия сървър, намерени ${totalInsertMessageCalls}`)
    assert(totalInsertReplyCalls === 1, `очаква се точно 1 call site за topicMessageStore.insertReply в целия сървър, намерени ${totalInsertReplyCalls}`)
  })
}

// ─── Резюме ──────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
