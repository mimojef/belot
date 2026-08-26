/**
 * checkPikaTeamSupportChatHttpAuthorization.ts
 *
 * E2E тест на pika_team role-based chat bypass:
 * POST /api/chat/pika-support/start.
 * Спъва изолирано копие на реалния сървър (собствена temp SQLite база,
 * реални migrations, реален HTTP слой, реален PIKA_OFFICIAL_PROFILE_ID env) —
 * огледално на checkGiftFriendshipBypassHttpAuthorization.ts — за да изпълни
 * РЕАЛНО permission gate-а (isPikaTeamSupportChatSession, index.ts route) и
 * store path-а (chatStore.getOrCreatePikaSupportConversation), не само
 * source-string assertions.
 *
 * Store-level (non-HTTP) semantics — friendship-guard, block-timing, archive,
 * idempotency, self-chat, missing-recipient — вече са напълно покрити от
 * checkOfficialPikaSupportChat.ts (30/30 passing) и не се дублират тук.
 * Този файл добавя САМО HTTP-authorization слоя за role-based sender-и,
 * който checkOfficialPikaSupportChat.ts не може да изпълни (той вика
 * chatStore директно, не минава през session cookie → route → predicate).
 *
 * Покрива (chat authorization hotfix брифа §6):
 *  [A] non-official pika_team + non-friend → chat create/open SUCCESS (200)
 *  [B] същият pika_team повторно → reuse-ва СЪЩИЯ friendshipId (idempotent,
 *      без duplicate/collision)
 *  [C] normal player + non-friend → 403 (няма bypass)
 *  [D] legacy OFFICIAL_PIKA_PROFILE_ID (различен от pika_team role) → старото
 *      поведение продължава да работи (200, без role)
 *  [E] втори различен pika_team sender + СЪЩИЯ recipient → получава
 *      РАЗЛИЧЕН friendshipId от първия sender (conversation identity
 *      isolation — не наследява/презаписва чуждата нишка)
 *  [extra] guest (без cookie) → 401
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'PikaChatSmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000
const OFFICIAL_PIKA_PROFILE_ID = '4c146064-85af-4e6e-b08f-08faa39b167e'

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

function getFreePort(): Promise<number> {
  return new Promise((res, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Не може да се намери свободен порт.')))
        return
      }
      const { port } = addr
      srv.close(() => res(port))
    })
  })
}

type HttpResult = { status: number; body: unknown }

function httpRequest(
  port: number,
  pathname: string,
  method: string,
  cookie?: string,
  jsonBody?: unknown,
): Promise<HttpResult> {
  return new Promise((res, reject) => {
    const headers: Record<string, string> = {}
    if (cookie) headers['Cookie'] = cookie
    let payload: string | undefined
    if (jsonBody !== undefined) {
      payload = JSON.stringify(jsonBody)
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(payload))
    }

    const req = request(
      { hostname: '127.0.0.1', port, path: pathname, method, headers, timeout: 5000 },
      (r) => {
        const chunks: Buffer[] = []
        r.on('data', (c) => chunks.push(Buffer.from(c)))
        r.on('end', () => {
          let body: unknown = null
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON */ }
          res({ status: r.statusCode ?? 0, body })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('HTTP timeout.')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

async function createIsolatedServerRoot(originalServerRoot: string): Promise<{
  root: string
  serverDir: string
  databaseFile: string
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-pika-chat-smoke-'))
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

  const databaseFile = join(serverDir, 'database', 'data', 'belot-v2.sqlite')

  return {
    root,
    serverDir,
    databaseFile,
    cleanup: async () => { await rm(root, { recursive: true, force: true }) },
  }
}

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        PORT: String(port),
        BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
        BELOT_GAME_WORKER_COUNT: '1',
        // Изрично зададен, детерминистичен официален profileId — независим
        // от каквато и да е стойност в родителския process.env, за да не
        // зависи тестът от локална .env конфигурация.
        PIKA_OFFICIAL_PROFILE_ID: OFFICIAL_PIKA_PROFILE_ID,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((res) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); res() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); res() })
  })
}

function promoteRole(databaseFile: string, email: string, role: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?`).run(role, email)
  db.close()
}

// Пренаписва profile_id на вече регистриран профил на explicit UUID —
// единствен начин детерминистично да имаме HTTP-registered потребител с
// ТОЧНО OFFICIAL_PIKA_PROFILE_ID (register() винаги генерира random UUID).
// НЕ пипа accounts.account_id (PK, FK target за account_sessions) — само
// profiles.profile_id, единственото поле, което
// getOrCreatePikaSupportConversation/officialPikaProfileId сравнение
// реално ползва (session.profile.profileId, не account_id). profiles.account_id
// остава непроменен, значи login()-ът (SELECT profile_id FROM profiles WHERE
// account_id=?) продължава да намира реда правилно.
function rewriteProfileId(databaseFile: string, oldProfileId: string, newProfileId: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = OFF;')
  db.prepare(`UPDATE profiles SET profile_id = ? WHERE profile_id = ?`).run(newProfileId, oldProfileId)
  db.prepare(`UPDATE profile_wallets SET profile_id = ? WHERE profile_id = ?`).run(newProfileId, oldProfileId)
  db.prepare(`UPDATE profile_progress SET profile_id = ? WHERE profile_id = ?`).run(newProfileId, oldProfileId)
  db.close()
}

function countPikaSupportRows(databaseFile: string, profileId: string): number {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM profile_friendships
    WHERE kind = 'pika_support' AND (requester_profile_id = ? OR addressee_profile_id = ?)
  `).get(profileId, profileId) as { c: number }
  db.close()
  return row.c
}

type RegisteredUser = { cookie: string; profileId: string; accountId: string; email: string }

async function register(port: number, runId: string, suffix: string): Promise<RegisteredUser> {
  const email = `pika-chat-smoke-${runId}-${suffix}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName: `Smoke ${suffix}`, gender: 'male' }),
  })
  if (res.status !== 200) throw new Error(`Регистрацията (${suffix}) върна status ${res.status}.`)
  const payload = await res.json() as { ok?: boolean; session?: { profile: { profileId: string }; account: { accountId: string } }; message?: string }
  if (!payload.ok || !payload.session) throw new Error(`Регистрацията (${suffix}) не е успешна: ${payload.message ?? '?'}`)

  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  if (!rawCookie) throw new Error(`Липсва Set-Cookie при регистрация (${suffix}).`)
  return {
    cookie: rawCookie.split(';')[0]!,
    profileId: payload.session.profile.profileId,
    accountId: payload.session.account.accountId,
    email,
  }
}

async function login(port: number, email: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const payload = await res.json() as { ok?: boolean }
  if (!payload.ok) throw new Error(`Login не е успешен за ${email}.`)
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  if (!rawCookie) throw new Error(`Липсва Set-Cookie при login за ${email}.`)
  return rawCookie.split(';')[0]!
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\n═══ pika_team support-chat role-based HTTP authorization E2E test ═══')
console.log(`Server root: ${sourceServerRoot}`)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null

try {
  server = startServer(isolated.serverDir, port)

  console.log(`\n[startup] Чакам сървъра на порт ${port}...`)
  await waitFor('server health ready', async () => {
    try {
      const r = await httpRequest(port, '/health', 'GET')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
  console.log('  Сървърът е готов.')

  const runId = `${Date.now()}-${process.pid}`

  console.log('\n[setup] Регистрация на pika_team sender-и, normal player, official-profile акаунт, recipients...')
  const pikaCandidate = await register(port, runId, 'pikateam')
  const pikaCandidateSecond = await register(port, runId, 'pikateam2')
  const playerCandidate = await register(port, runId, 'player')
  const officialCandidate = await register(port, runId, 'official')
  const recipientA = await register(port, runId, 'recipienta')
  const recipientC = await register(port, runId, 'recipientc')
  const recipientD = await register(port, runId, 'recipientd')
  const recipientE = await register(port, runId, 'recipiente')

  promoteRole(isolated.databaseFile, pikaCandidate.email, 'pika_team')
  promoteRole(isolated.databaseFile, pikaCandidateSecond.email, 'pika_team')
  rewriteProfileId(isolated.databaseFile, officialCandidate.profileId, OFFICIAL_PIKA_PROFILE_ID)

  const pikaCookie = await login(port, pikaCandidate.email)
  const pikaCookieSecond = await login(port, pikaCandidateSecond.email)
  const playerCookie = await login(port, playerCandidate.email)
  const officialCookie = await login(port, officialCandidate.email)

  console.log('  Регистрирани: 2× pika_team (non-official), normal player, official PIKA_OFFICIAL_PROFILE_ID акаунт, 4 recipients.')
  console.log('  Никой от recipients НЕ е приятел с изпращачите.')

  // ── [A] non-official pika_team + non-friend → SUCCESS ────────────────────
  console.log('\n[A] non-official pika_team + non-friend получател → chat create SUCCESS')
  let pikaFriendshipIdA = ''
  await check('[A] pika_team (non-official) -> POST chat/pika-support/start => 200 ok:true с friendshipId', async () => {
    const r = await httpRequest(port, '/api/chat/pika-support/start', 'POST', pikaCookie, {
      recipientProfileId: recipientA.profileId,
    })
    const b = r.body as { ok?: boolean; friendshipId?: string }
    if (r.status !== 200 || b.ok !== true || typeof b.friendshipId !== 'string' || b.friendshipId.length === 0) {
      throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    }
    pikaFriendshipIdA = b.friendshipId
  })
  await check('[A.1] точно 1 pika_support ред за pikaCandidate след успешния create', () => {
    const count = countPikaSupportRows(isolated.databaseFile, pikaCandidate.profileId)
    if (count !== 1) throw new Error(`pika_support rows=${count}, очаквах 1`)
  })

  // ── [B] същият pika_team повторно → reuse, без duplicate ────────────────
  console.log('\n[B] pika_team повторно към СЪЩИЯ recipient → reuse на СЪЩИЯ friendshipId, без duplicate')
  await check('[B] pika_team -> POST chat/pika-support/start отново => СЪЩИЯ friendshipId', async () => {
    const r = await httpRequest(port, '/api/chat/pika-support/start', 'POST', pikaCookie, {
      recipientProfileId: recipientA.profileId,
    })
    const b = r.body as { ok?: boolean; friendshipId?: string }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    if (b.friendshipId !== pikaFriendshipIdA) throw new Error(`friendshipId=${b.friendshipId}, очаквах СЪЩИЯ ${pikaFriendshipIdA} (idempotent reuse)`)
  })
  await check('[B.1] все още точно 1 pika_support ред (без duplicate/collision)', () => {
    const count = countPikaSupportRows(isolated.databaseFile, pikaCandidate.profileId)
    if (count !== 1) throw new Error(`pika_support rows=${count}, очаквах 1 (не 2 — reuse, не нов ред)`)
  })

  // ── [C] normal player + non-friend → 403 ──────────────────────────────────
  console.log('\n[C] normal player + non-friend получател → 403 (няма bypass)')
  await check('[C] player -> POST chat/pika-support/start => 403', async () => {
    const r = await httpRequest(port, '/api/chat/pika-support/start', 'POST', playerCookie, {
      recipientProfileId: recipientC.profileId,
    })
    if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[C.1] няма създаден pika_support ред за player-а', () => {
    const count = countPikaSupportRows(isolated.databaseFile, playerCandidate.profileId)
    if (count !== 0) throw new Error(`pika_support rows=${count}, очаквах 0`)
  })

  // ── [extra] guest (без cookie) → 401 ──────────────────────────────────────
  await check('[extra] guest (без cookie) -> POST chat/pika-support/start => 401', async () => {
    const r = await httpRequest(port, '/api/chat/pika-support/start', 'POST', undefined, {
      recipientProfileId: recipientC.profileId,
    })
    if (r.status !== 401) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ── [D] legacy OFFICIAL_PIKA_PROFILE_ID (role !== pika_team) → старото поведение работи ──
  console.log('\n[D] legacy OFFICIAL_PIKA_PROFILE_ID акаунт (role=\'player\', НЕ pika_team) → все още успешен chat')
  await check('[D] official-profileId (role=\'player\') -> POST chat/pika-support/start => 200 ok:true', async () => {
    const r = await httpRequest(port, '/api/chat/pika-support/start', 'POST', officialCookie, {
      recipientProfileId: recipientD.profileId,
    })
    const b = r.body as { ok?: boolean; friendshipId?: string }
    if (r.status !== 200 || b.ok !== true || typeof b.friendshipId !== 'string') {
      throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    }
  })

  // ── [E] втори различен pika_team sender + СЪЩИЯ recipient → изолирана conversation identity ──
  console.log('\n[E] Втори pika_team sender + СЪЩИЯ recipient (recipientA) → отделен friendshipId, без collision')
  await check('[E] pikaCandidateSecond -> POST chat/pika-support/start (recipientA, вече чатнал с pikaCandidate) => 200, РАЗЛИЧЕН friendshipId', async () => {
    const r = await httpRequest(port, '/api/chat/pika-support/start', 'POST', pikaCookieSecond, {
      recipientProfileId: recipientA.profileId,
    })
    const b = r.body as { ok?: boolean; friendshipId?: string }
    if (r.status !== 200 || b.ok !== true || typeof b.friendshipId !== 'string') {
      throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    }
    if (b.friendshipId === pikaFriendshipIdA) {
      throw new Error(`friendshipId съвпада с pikaCandidate-A разговора (${pikaFriendshipIdA}) — conversation identity collision между различни pika_team sender-и!`)
    }
  })
  await check('[E.1] recipientA сега има точно 2 отделни pika_support реда (от двата различни pika_team sender-и)', () => {
    const count = countPikaSupportRows(isolated.databaseFile, recipientA.profileId)
    if (count !== 2) throw new Error(`pika_support rows за recipientA=${count}, очаквах 2 (отделни conversation-и, не сливане)`)
  })
  await check('[E.2] pikaCandidate (първи sender) все още има точно 1 ред — вторият sender не пипна неговия', () => {
    const count = countPikaSupportRows(isolated.databaseFile, pikaCandidate.profileId)
    if (count !== 1) throw new Error(`pika_support rows за pikaCandidate=${count}, очаквах 1 (непроменено)`)
  })

  // ── [F] kind='pika_support' contract — еднакъв за role-based И official ───
  // Deep-dive корекция (production bug fix, второ minavane): "Връзка с
  // екипа" (openSupportInbox/supportPopupOpen) зарежда съдържание от
  // напълно ОТДЕЛЕН backend store (supportStore, /api/support/messages) —
  // несвързан с chatStore/friendshipId по никакъв начин и никога не праща
  // chat_message_received WS notification. Значи "Виж" routing-ът НЕ
  // трябва да различава role-based pika_team direct chat от истински
  // official-profile pika_support разговор (ЕДИН и същ conversation
  // "product" за целите на chat notification routing-а — виж
  // routeByConversation в createLobbyFlowController.ts) — вместо
  // conversation-level discriminator поле (отхвърлен подход от предишен
  // fix опит), клиентът винаги маршрутизира kind='pika_support' към
  // нормалния Chat panel. Тук потвърждаваме server contract-а: и двата
  // случая (role-based pika_team sender И legacy official profile) връщат
  // еднакъв kind='pika_support', БЕЗ допълнителен discriminator field —
  // потвърждава, че server-ът не носи ambiguous/misleading semantic поле.
  console.log('\n[F] kind=\'pika_support\' contract еднакъв за pika_team direct chat и official profile, БЕЗ discriminator field')
  await check('[F.1] pika_team (non-official) POST response: conversation.kind === \'pika_support\', без isOfficialSupportConversation поле', async () => {
    const r = await httpRequest(port, '/api/chat/pika-support/start', 'POST', pikaCookie, {
      recipientProfileId: recipientA.profileId,
    })
    const b = r.body as { ok?: boolean; conversation?: { kind?: string; isOfficialSupportConversation?: unknown } }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    if (b.conversation?.kind !== 'pika_support') throw new Error(`kind=${b.conversation?.kind}, очаквах 'pika_support'`)
    if ('isOfficialSupportConversation' in (b.conversation ?? {})) {
      throw new Error('conversation payload все още съдържа isOfficialSupportConversation — discriminator полето трябваше да е премахнато')
    }
  })
  await check('[F.2] legacy official profile POST response: conversation.kind === \'pika_support\' (СЪЩИЯ kind, без distinction)', async () => {
    const r = await httpRequest(port, '/api/chat/pika-support/start', 'POST', officialCookie, {
      recipientProfileId: recipientD.profileId,
    })
    const b = r.body as { ok?: boolean; conversation?: { kind?: string } }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    if (b.conversation?.kind !== 'pika_support') throw new Error(`kind=${b.conversation?.kind}, очаквах 'pika_support'`)
  })
  await check('[F.3] recipientA GET /api/chat/conversations: pika_team разговорът се вижда с kind=\'pika_support\' от RECIPIENT страна', async () => {
    const recipientCookie = await login(port, recipientA.email)
    const r = await httpRequest(port, '/api/chat/conversations', 'GET', recipientCookie)
    const b = r.body as { ok?: boolean; conversations?: Array<{ friendshipId?: string; kind?: string }> }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    const found = b.conversations?.find((c) => c.friendshipId === pikaFriendshipIdA)
    if (found === undefined) throw new Error(`Разговор ${pikaFriendshipIdA} липсва в recipientA conversations списъка`)
    if (found.kind !== 'pika_support') throw new Error(`kind=${found.kind} от recipient страна, очаквах 'pika_support'`)
  })

  // ── [G] Single-row reuse между двойка, независимо от реда/посоката на initiator ──
  // getOrCreatePikaSupportConversation find-or-create е по (lower,higher)
  // profileId двойка (createChatProfilePair), НЕЗАВИСИМО от кой е requester
  // (selectPikaSupportByPairStatement WHERE lower_profile_id=? AND
  // higher_profile_id=?, без requester/addressee условие) — за ЕДНА двойка
  // профили може да съществува само ЕДИН pika_support row, независимо кой
  // страна е инициирала първо. Проверяваме explicit: recipientD (вече има
  // pika_support разговор с official profile от case [D]/[F.2]) — official
  // profile-ът стартира ОТНОВО СЪЩИЯ разговор → трябва да получи СЪЩИЯ
  // friendshipId (idempotent reuse), не нов row.
  console.log('\n[G] Single conversation row се reuse-ва независимо от посоката/реда на initiate-ване')
  let officialFriendshipIdD = ''
  await check('[G.1] официалният profile record-ва friendshipId-я от случай [D]/[F.2] за сравнение', async () => {
    const r = await httpRequest(port, '/api/chat/pika-support/start', 'POST', officialCookie, {
      recipientProfileId: recipientD.profileId,
    })
    const b = r.body as { ok?: boolean; friendshipId?: string }
    if (r.status !== 200 || b.ok !== true || typeof b.friendshipId !== 'string') {
      throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    }
    officialFriendshipIdD = b.friendshipId
  })
  await check('[G.2] точно 1 pika_support ред за recipientD след повторни official start повиквания (F.2 + G.1) — single row reuse', () => {
    const count = countPikaSupportRows(isolated.databaseFile, recipientD.profileId)
    if (count !== 1) throw new Error(`pika_support rows за recipientD=${count}, очаквах 1 (F.2 и G.1 трябва да са reuse на СЪЩИЯ row, не 2 отделни)`)
  })
  await check('[G.3] recipientD GET /api/chat/conversations вижда СЪЩИЯ friendshipId (single row, независимо кой е requester в DB)', async () => {
    const recipientDCookie = await login(port, recipientD.email)
    const r = await httpRequest(port, '/api/chat/conversations', 'GET', recipientDCookie)
    const b = r.body as { ok?: boolean; conversations?: Array<{ friendshipId?: string; kind?: string }> }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    const pikaSupportConversations = (b.conversations ?? []).filter((c) => c.kind === 'pika_support')
    if (pikaSupportConversations.length !== 1) {
      throw new Error(`recipientD вижда ${pikaSupportConversations.length} pika_support разговора, очаквах точно 1`)
    }
    if (pikaSupportConversations[0]!.friendshipId !== officialFriendshipIdD) {
      throw new Error(`friendshipId=${pikaSupportConversations[0]!.friendshipId}, очаквах СЪЩИЯ ${officialFriendshipIdD}`)
    }
  })

} catch (err) {
  fail('Непредвидена грешка в E2E теста', err)
  if (server !== null) {
    console.error('\n[server output tail]:\n' + server.output().slice(-3000))
  }
  console.error(err)
} finally {
  console.log('\n[cleanup] Спиране на сървъра и изтриване на временните файлове...')
  if (server !== null) {
    try {
      await stopServer(server)
      console.log('  Сървърът е спрян.')
    } catch (err) {
      fail('Спиране на сървъра', err)
      console.error(server.output().slice(-3000))
    }
  }
  let cleanupOk = false
  for (let attempt = 0; attempt < 5 && !cleanupOk; attempt++) {
    try {
      if (attempt > 0) await sleep(500)
      await isolated.cleanup()
      cleanupOk = true
    } catch {
      // ще опитаме пак
    }
  }
  if (cleanupOk) {
    console.log('  Временните файлове са изтрити.')
  } else {
    console.warn('  [warn] Временните файлове не бяха изтрити (Windows file lock) — не е тестов провал.')
  }
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
