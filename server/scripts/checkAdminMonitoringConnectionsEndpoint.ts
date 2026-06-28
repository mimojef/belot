import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

// ─── Конфигурация ─────────────────────────────────────────────────────────────

const PASSWORD = 'ConnSmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000
const ENDPOINT = '/api/admin/monitoring/connections'

// ─── Брояч ────────────────────────────────────────────────────────────────────

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

// ─── Мрежови helpers ──────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Не може да се намери свободен порт.')))
        return
      }
      const { port } = addr
      srv.close(() => resolve(port))
    })
  })
}

type HttpResult = { status: number; body: unknown }

function httpRequest(
  port: number,
  pathname: string,
  method: string,
  cookie?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (cookie) headers['Cookie'] = cookie

    const req = request(
      { hostname: '127.0.0.1', port, path: pathname, method, headers, timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          let body: unknown = null
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('HTTP timeout.')))
    req.on('error', reject)
    req.end()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

// ─── WebSocket helpers ────────────────────────────────────────────────────────

function openAuthenticatedWs(port: number, cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: cookie },
    })
    const t = setTimeout(() => { ws.terminate(); reject(new Error('WS open timeout')) }, 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (err) => { clearTimeout(t); reject(err) })
  })
}

function openGuestWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const t = setTimeout(() => { ws.terminate(); reject(new Error('Guest WS open timeout')) }, 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (err) => { clearTimeout(t); reject(err) })
  })
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return }
    ws.once('close', resolve)
    ws.close()
    setTimeout(() => { ws.terminate(); resolve() }, 2000)
  })
}

// ─── Сървър helpers ───────────────────────────────────────────────────────────

type RunningServer = {
  child: ChildProcessWithoutNullStreams
  output(): string
}

async function createIsolatedServerRoot(originalServerRoot: string): Promise<{
  root: string
  serverDir: string
  databaseFile: string
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-connsmoke-'))
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
    root, serverDir, databaseFile,
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

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); resolve() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); resolve() })
  })
}

function promoteToAdmin(databaseFile: string, email: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE email = ?`).run(email)
  db.close()
}

async function registerAndGetCookie(port: number, email: string, displayName: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName, gender: 'male' }),
  })
  if (res.status !== 200) throw new Error(`Register returned ${res.status}`)
  const payload = await res.json() as { ok?: boolean; message?: string }
  if (!payload.ok) throw new Error(`Register failed: ${payload.message ?? '?'}`)
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const raw = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  if (!raw) throw new Error('No Set-Cookie after register')
  return raw.split(';')[0]!
}

// ─── Типове ───────────────────────────────────────────────────────────────────

type WsEntry = {
  connectionId: string
  readyStateLabel: string
  isOpen: boolean
  profileId: string | null
  displayName: string | null
  connectedAtMs: number
  lastSeenAtMs: number
  maskedIp: string | null
  userAgent: string | null
  currentRoomId: string | null
  hasActiveGameSession: boolean
  probablePendingSessionInGame: boolean
}

type WsSummary = {
  registrySize: number
  openSocketCount: number
  connectedStateCount: number
  uniqueOnlineProfiles: number
  guestOpenSockets: number
  authenticatedOpenSockets: number
  profilesWithMultipleOpenSockets: number
}

type ConnResponse = { ok: boolean; entries?: WsEntry[]; summary?: WsSummary; message?: string }

// ─── Главна функция ───────────────────────────────────────────────────────────

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

console.log('\n═══ Admin monitoring/connections integration smoke test ═══')
console.log(`Server root: ${sourceServerRoot}`)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null
const openSockets: WebSocket[] = []

try {
  server = startServer(isolated.serverDir, port)

  console.log(`\n[startup] Чакам сървъра на порт ${port}...`)
  await waitFor(
    'server health ready',
    async () => {
      try {
        const r = await httpRequest(port, '/health', 'GET')
        const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
        return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
      } catch { return false }
    },
    SERVER_READY_TIMEOUT_MS,
  )
  console.log('  Сървърът е готов.')

  // ─── Регистрация ──────────────────────────────────────────────────────────

  console.log('\n[auth] Регистрация на потребители...')
  const runId = `${Date.now()}-${process.pid}`

  const userEmail = `connsmoke-${runId}-user@example.test`
  const adminEmail = `connsmoke-${runId}-admin@example.test`

  const userCookie = await registerAndGetCookie(port, userEmail, 'ConnSmoke User')
  await registerAndGetCookie(port, adminEmail, 'ConnSmoke Admin')  // register; cookie from this session discarded

  promoteToAdmin(isolated.databaseFile, adminEmail)

  // Login след промотиране — получаваме нова сесия с role='admin'
  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: PASSWORD }),
  })
  const loginPayload = await loginRes.json() as { ok?: boolean }
  if (!loginPayload.ok) throw new Error('Admin login failed after promotion.')
  const loginExt = loginRes.headers as Headers & { getSetCookie?: () => string[] }
  const adminCookie = (loginExt.getSetCookie?.()[0] ?? loginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!adminCookie) throw new Error('No Set-Cookie on admin login.')

  console.log('  Потребителите са готови. Admin-ът е промотиран.')

  // ─── [1] Без cookie → 403 ─────────────────────────────────────────────────

  console.log('\n[1] Без cookie → 403')
  {
    const r = await httpRequest(port, ENDPOINT, 'GET')
    const b = r.body as Record<string, unknown>
    await check('[1.1] status 403 без cookie', () => {
      if (r.status !== 403) throw new Error(`Got ${r.status}, expected 403`)
    })
    await check('[1.2] ok: false без cookie', () => {
      if (b.ok !== false) throw new Error(`ok=${String(b.ok)}, expected false`)
    })
  }

  // ─── [2] Обикновен потребител → 403 ──────────────────────────────────────

  console.log('\n[2] Обикновен потребител → 403')
  {
    const r = await httpRequest(port, ENDPOINT, 'GET', userCookie)
    const b = r.body as Record<string, unknown>
    await check('[2.1] status 403 с user cookie', () => {
      if (r.status !== 403) throw new Error(`Got ${r.status}, expected 403`)
    })
    await check('[2.2] ok: false с user cookie', () => {
      if (b.ok !== false) throw new Error(`ok=${String(b.ok)}, expected false`)
    })
  }

  // ─── [3] Admin → 200 + структура ─────────────────────────────────────────

  console.log('\n[3] Admin → 200 + структура')
  {
    const r = await httpRequest(port, ENDPOINT, 'GET', adminCookie)
    const b = r.body as ConnResponse
    await check('[3.1] status 200 с admin cookie', () => {
      if (r.status !== 200) throw new Error(`Got ${r.status}, expected 200`)
    })
    await check('[3.2] ok: true', () => {
      if (b.ok !== true) throw new Error(`ok=${String(b.ok)}, expected true`)
    })
    await check('[3.3] entries е масив', () => {
      if (!Array.isArray(b.entries)) throw new Error('entries is not array')
    })
    await check('[3.4] summary е обект с числови полета', () => {
      const sm = b.summary
      if (!sm || typeof sm !== 'object') throw new Error('summary missing')
      const fields = ['registrySize', 'openSocketCount', 'connectedStateCount',
        'uniqueOnlineProfiles', 'guestOpenSockets', 'authenticatedOpenSockets',
        'profilesWithMultipleOpenSockets'] as const
      for (const f of fields) {
        if (!Number.isInteger(sm[f]) || sm[f] < 0) {
          throw new Error(`summary.${f}=${String(sm[f])} не е цяло число ≥ 0`)
        }
      }
    })
    await check('[3.5] openSocketCount = auth + guest', () => {
      const sm = b.summary
      if (!sm) return
      if (sm.openSocketCount !== sm.authenticatedOpenSockets + sm.guestOpenSockets) {
        throw new Error(`${sm.openSocketCount} ≠ ${sm.authenticatedOpenSockets}+${sm.guestOpenSockets}`)
      }
    })
  }

  // ─── [4] Реална authenticated OPEN връзка ────────────────────────────────

  console.log('\n[4] Authenticated OPEN WS → в entries')
  let wsUser: WebSocket | null = null
  {
    wsUser = await openAuthenticatedWs(port, userCookie)
    openSockets.push(wsUser)
    await sleep(300)

    const r = await httpRequest(port, ENDPOINT, 'GET', adminCookie)
    const b = r.body as ConnResponse

    await check('[4.1] authenticatedOpenSockets > 0', () => {
      if (!b.summary || b.summary.authenticatedOpenSockets === 0) {
        throw new Error(`authenticatedOpenSockets=${String(b.summary?.authenticatedOpenSockets)}`)
      }
    })
    await check('[4.2] entry с isOpen === true и profileId !== null съществува', () => {
      const found = b.entries?.find(e => e.isOpen && e.profileId !== null)
      if (!found) throw new Error('No open authenticated entry')
    })
    await check('[4.3] readyStateLabel е OPEN за отворена връзка', () => {
      const found = b.entries?.find(e => e.isOpen)
      if (!found) throw new Error('No open entry')
      if (found.readyStateLabel !== 'OPEN') throw new Error(`readyStateLabel=${found.readyStateLabel}`)
    })
    await check('[4.4] connectionId е непразен string', () => {
      const found = b.entries?.find(e => e.isOpen && e.profileId !== null)
      if (!found?.connectionId) throw new Error('No connectionId')
    })
  }

  // ─── [5] Реален guest OPEN socket (без cookie) ────────────────────────────

  console.log('\n[5] Guest OPEN WS (без cookie) → в entries')
  {
    const guestWs = await openGuestWs(port)
    openSockets.push(guestWs)
    await sleep(300)

    const r = await httpRequest(port, ENDPOINT, 'GET', adminCookie)
    const b = r.body as ConnResponse

    await check('[5.1] guestOpenSockets > 0', () => {
      if (!b.summary || b.summary.guestOpenSockets === 0) {
        throw new Error(`guestOpenSockets=${String(b.summary?.guestOpenSockets)}`)
      }
    })
    await check('[5.2] guest entry има profileId === null', () => {
      const guest = b.entries?.find(e => e.isOpen && e.profileId === null)
      if (!guest) throw new Error('No open guest entry')
    })
  }

  // ─── [6] Displacement: втори socket на същия профил ──────────────────────
  //
  // Когато потребителят отваря втора WS без активна игра, сървърът извиква
  // displaceProfileConnections() и затваря първата връзка.
  // Очакваме: след displacement само 1 OPEN socket за профила.

  console.log('\n[6] Displacement при втори socket за същия профил (без игра)')
  let wsUser2: WebSocket | null = null
  {
    wsUser2 = await openAuthenticatedWs(port, userCookie)
    openSockets.push(wsUser2)

    // Изчакваме wsUser да бъде displacement-нат (OPEN → CLOSING/CLOSED)
    await waitFor(
      'first WS displaced',
      () => wsUser !== null && wsUser.readyState !== WebSocket.OPEN,
      3000,
    ).catch(() => { /* Таймаут не е критичен — ще се провери в теста */ })

    await sleep(200)
    const r = await httpRequest(port, ENDPOINT, 'GET', adminCookie)
    const b = r.body as ConnResponse

    await check('[6.1] wsUser е displacement-нат (readyState ≠ OPEN)', () => {
      if (wsUser !== null && wsUser.readyState === WebSocket.OPEN) {
        throw new Error('First WS still OPEN — displacement did not happen')
      }
    })
    await check('[6.2] profilesWithMultipleOpenSockets === 0 след displacement', () => {
      if (b.summary?.profilesWithMultipleOpenSockets !== 0) {
        throw new Error(`profilesWithMultipleOpenSockets=${String(b.summary?.profilesWithMultipleOpenSockets)}, expected 0`)
      }
    })
    await check('[6.3] wsUser2 е все още OPEN', () => {
      if (wsUser2?.readyState !== WebSocket.OPEN) {
        throw new Error(`wsUser2 readyState=${String(wsUser2?.readyState)}, expected OPEN(1)`)
      }
    })
  }

  // ─── [7] IP masking ───────────────────────────────────────────────────────

  console.log('\n[7] IP masking')
  {
    const r = await httpRequest(port, ENDPOINT, 'GET', adminCookie)
    const b = r.body as ConnResponse
    const rawIpv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
    const maskedPattern = /^\*\.\*\.\d{1,3}\.\d{1,3}$|^\[\*\*\*\*\]$/

    await check('[7.1] Няма немаскирано IPv4 в maskedIp', () => {
      for (const e of b.entries ?? []) {
        if (e.maskedIp !== null && rawIpv4.test(e.maskedIp)) {
          throw new Error(`Unmaksed IPv4: ${e.maskedIp}`)
        }
      }
    })
    await check('[7.2] maskedIp е *.*.x.y или [****] или null', () => {
      for (const e of b.entries ?? []) {
        if (e.maskedIp !== null && !maskedPattern.test(e.maskedIp)) {
          throw new Error(`Unexpected maskedIp format: ${e.maskedIp}`)
        }
      }
    })
  }

  // ─── [8] Без secrets в отговора ───────────────────────────────────────────

  console.log('\n[8] Отговорът не съдържа secrets')
  {
    const r = await httpRequest(port, ENDPOINT, 'GET', adminCookie)
    const raw = JSON.stringify(r.body)

    await check('[8.1] Без "reconnectToken"', () => {
      if (raw.includes('reconnectToken')) throw new Error('"reconnectToken" in response')
    })
    await check('[8.2] Без "accessToken"', () => {
      if (raw.includes('accessToken')) throw new Error('"accessToken" in response')
    })
    await check('[8.3] Без поле "password"', () => {
      if (raw.toLowerCase().includes('"password"')) throw new Error('"password" in response')
    })
    await check('[8.4] Без session cookie стойност', () => {
      if (raw.includes('belot-session=')) throw new Error('Session cookie value in response')
    })
    await check('[8.5] Без Windows пътища', () => {
      if (/[A-Za-z]:\\/.test(raw)) throw new Error('Windows path in response')
    })
    await check('[8.6] Без node:internal stack trace', () => {
      if (raw.includes('node:internal')) throw new Error('node:internal in response')
    })
  }

  // ─── [9] POST → 405 ───────────────────────────────────────────────────────

  console.log('\n[9] POST → 405')
  {
    const r = await httpRequest(port, ENDPOINT, 'POST', adminCookie)
    const b = r.body as Record<string, unknown>
    await check('[9.1] status 405', () => {
      if (r.status !== 405) throw new Error(`Got ${r.status}, expected 405`)
    })
    await check('[9.2] ok: false', () => {
      if (b.ok !== false) throw new Error(`ok=${String(b.ok)}, expected false`)
    })
  }

} catch (err) {
  fail('Непредвидена грешка в smoke теста', err)
  if (server !== null) {
    console.error('\n[server output tail]:\n' + server.output().slice(-3000))
  }
  console.error(err)
} finally {
  console.log('\n[cleanup] Затваряне на WebSocket-и...')
  await Promise.all(openSockets.map(closeWs))

  console.log('[cleanup] Спиране на сървъра...')
  if (server !== null) {
    try {
      await stopServer(server)
      console.log('  Сървърът е спрян.')
    } catch (err) {
      fail('Спиране на сървъра', err)
      console.error('[cleanup] Server output tail:')
      console.error(server.output().slice(-3000))
    }
  }

  // На Windows SQLite WAL файловете и junction симлинковете могат да останат
  // заключени кратко след като процесът се спре. Retry с нарастващо изчакване.
  {
    const RETRYABLE = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])
    const MAX_ATTEMPTS = 5
    let attempt = 0
    let cleanupDone = false
    while (attempt < MAX_ATTEMPTS) {
      await sleep(attempt === 0 ? 200 : 200 * attempt)
      try {
        await isolated.cleanup()
        cleanupDone = true
        console.log('  Временните файлове са изтрити.')
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? ''
        if (!RETRYABLE.has(code)) {
          fail('Изтриване на временните файлове (неочаквана грешка)', err)
          break
        }
        attempt++
        if (attempt < MAX_ATTEMPTS) {
          console.log(`  [cleanup] ${code} при rm — опит ${attempt}/${MAX_ATTEMPTS - 1}...`)
        }
      }
    }
    if (!cleanupDone) {
      console.warn(`  WARNING: временната папка не е изтрита след ${MAX_ATTEMPTS} опита — може да се изтрие ръчно: ${isolated.root}`)
    }
  }
}

// ─── Резюме ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
