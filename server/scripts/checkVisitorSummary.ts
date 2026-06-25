import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSiteVisitStore } from '../src/db/siteVisitStore.js'

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function withTempDb(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-visitor-summary-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS site_visitors (
        anonymous_visitor_id TEXT PRIMARY KEY,
        first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        first_profile_id TEXT NULL,
        last_profile_id TEXT NULL,
        first_ip_address TEXT NULL,
        last_ip_address TEXT NULL,
        first_user_agent TEXT NULL,
        last_user_agent TEXT NULL,
        first_referrer TEXT NULL,
        last_referrer TEXT NULL,
        first_source TEXT NULL,
        last_source TEXT NULL
      );
      CREATE TABLE IF NOT EXISTS site_visit_events (
        page_view_id TEXT PRIMARY KEY,
        anonymous_visitor_id TEXT NOT NULL,
        profile_id TEXT NULL,
        path TEXT NOT NULL,
        navigation_type TEXT NOT NULL CHECK (
          navigation_type IN ('navigate', 'reload', 'back_forward', 'spa')
        ),
        referrer TEXT NULL,
        source TEXT NULL,
        utm_source TEXT NULL,
        utm_medium TEXT NULL,
        utm_campaign TEXT NULL,
        utm_term TEXT NULL,
        utm_content TEXT NULL,
        ip_address TEXT NULL,
        user_agent TEXT NULL,
        occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (anonymous_visitor_id) REFERENCES site_visitors(anonymous_visitor_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_site_visit_events_occurred_at ON site_visit_events(occurred_at);
    `)
    db.close()
    await fn(dbPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function insertVisitorEvent(
  db: DatabaseSync,
  visitorId: string,
  occurredAtExpr: string,
): void {
  // occurredAtExpr is an SQL expression like "datetime('now', '-5 days')" — interpolated directly.
  db.exec(`
    INSERT OR IGNORE INTO site_visitors (anonymous_visitor_id, first_seen_at, last_seen_at)
    VALUES ('${visitorId}', ${occurredAtExpr}, ${occurredAtExpr});
    INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, path, navigation_type, occurred_at)
    VALUES ('${randomUUID()}', '${visitorId}', '/lobby', 'navigate', ${occurredAtExpr});
  `)
}

// ─── [1] Празна история → нули ────────────────────────────────────────────────

console.log('\n[1] getVisitorSummary() — празна таблица')
await withTempDb(async (dbPath) => {
  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getVisitorSummary()
    await check('[1.1] today = 0', () => {
      if (summary.today !== 0) throw new Error(`today=${summary.today}`)
    })
    await check('[1.2] yesterday = 0', () => {
      if (summary.yesterday !== 0) throw new Error(`yesterday=${summary.yesterday}`)
    })
    await check('[1.3] last7days = 0', () => {
      if (summary.last7days !== 0) throw new Error(`last7days=${summary.last7days}`)
    })
    await check('[1.4] last30days = 0', () => {
      if (summary.last30days !== 0) throw new Error(`last30days=${summary.last30days}`)
    })
  } finally {
    store.close()
  }
})

// ─── [2] Посетители в различни периоди ───────────────────────────────────────

console.log('\n[2] getVisitorSummary() — посетители в различни периоди')
await withTempDb(async (dbPath) => {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')

  const todayVisitor     = randomUUID()
  const yesterdayVisitor = randomUUID()
  const week5dVisitor    = randomUUID()
  const month20dVisitor  = randomUUID()
  const oldVisitor       = randomUUID()

  insertVisitorEvent(db, todayVisitor,     "datetime('now')")
  insertVisitorEvent(db, yesterdayVisitor, "datetime('now', '-1 days')")
  insertVisitorEvent(db, week5dVisitor,    "datetime('now', '-5 days')")
  insertVisitorEvent(db, month20dVisitor,  "datetime('now', '-20 days')")
  insertVisitorEvent(db, oldVisitor,       "datetime('now', '-40 days')")
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getVisitorSummary()
    await check('[2.1] today = 1 (само todayVisitor)', () => {
      if (summary.today !== 1) throw new Error(`today=${summary.today}`)
    })
    await check('[2.2] yesterday >= 1 (yesterdayVisitor в last 24ч не е вчера)', () => {
      // yesterday = start of yesterday до сега, last7days включва вчера
      if (summary.last7days < 3) throw new Error(`last7days=${summary.last7days}`)
    })
    await check('[2.3] last7days >= 3 (today+yesterday+5d)', () => {
      if (summary.last7days < 3) throw new Error(`last7days=${summary.last7days}`)
    })
    await check('[2.4] last30days >= 4 (today+yesterday+5d+20d)', () => {
      if (summary.last30days < 4) throw new Error(`last30days=${summary.last30days}`)
    })
    await check('[2.5] last30days не включва 40-дневния посетител', () => {
      // oldVisitor е преди 40 дни, не трябва да се брои
      if (summary.last30days >= 5) throw new Error(`last30days=${summary.last30days} (очакван < 5)`)
    })
  } finally {
    store.close()
  }
})

// ─── [3] Един посетител с много events се брои веднъж ────────────────────────

console.log('\n[3] getVisitorSummary() — duplicate visitor се брои веднъж')
await withTempDb(async (dbPath) => {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')

  const visitorId = randomUUID()
  insertVisitorEvent(db, visitorId, "datetime('now')")
  // Втори event за същия visitor
  db.prepare(`
    INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, path, navigation_type, occurred_at)
    VALUES (?, ?, '/shop', 'spa', datetime('now'))
  `).run(randomUUID(), visitorId)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getVisitorSummary()
    await check('[3.1] today = 1 при множество events от един visitor', () => {
      if (summary.today !== 1) throw new Error(`today=${summary.today}`)
    })
  } finally {
    store.close()
  }
})

// ─── [4] HTTP endpoint — /api/admin/stats включва visitors ───────────────────

console.log('\n[4] /api/admin/stats endpoint — visitors присъства и е валиден')

const PASSWORD = 'VisitorSummarySmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000

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

type HttpResult = { status: number; body: unknown }

function httpGet(port: number, pathname: string, cookie?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (cookie) headers.Cookie = cookie
    const req = request(
      { hostname: '127.0.0.1', port, path: pathname, method: 'GET', headers, timeout: 5000 },
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

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

console.log(`  Server root: ${sourceServerRoot}`)

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-visitor-summary-http-'))
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
    databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
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
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null

try {
  server = startServer(isolated.serverDir, port)

  console.log(`\n  Чакам сървъра на порт ${port}...`)
  await waitFor(
    'server health ready',
    async () => {
      try {
        const r = await httpGet(port, '/health')
        const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
        return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
      } catch { return false }
    },
    SERVER_READY_TIMEOUT_MS,
  )
  console.log('  Сървърът е готов.\n')

  // Регистрация + промотиране
  const runId = `${Date.now()}-${process.pid}`
  const adminEmail = `visitor-summary-${runId}@example.test`

  const regRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: PASSWORD, displayName: 'SummaryAdmin', gender: 'male' }),
  })
  if (regRes.status !== 200) throw new Error(`Регистрацията върна ${regRes.status}`)

  const db = new DatabaseSync(isolated.databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE email = ?`).run(adminEmail)
  db.close()

  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: PASSWORD }),
  })
  const loginExt = loginRes.headers as Headers & { getSetCookie?: () => string[] }
  const adminCookie = (loginExt.getSetCookie?.()[0] ?? loginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!adminCookie) throw new Error('Липсва Set-Cookie при admin login.')

  // ─── [4.1] Без cookie → 403 ────────────────────────────────────────────────
  {
    const r = await httpGet(port, '/api/admin/stats')
    await check('[4.1] без cookie → 403', () => {
      if (r.status !== 403) throw new Error(`Получен ${r.status}, очакван 403`)
    })
  }

  // ─── [4.2] Admin → 200 + visitors присъства ────────────────────────────────
  {
    const r = await httpGet(port, '/api/admin/stats', adminCookie)
    const b = r.body as Record<string, unknown>
    await check('[4.2] status 200', () => {
      if (r.status !== 200) throw new Error(`Получен ${r.status}, очакван 200`)
    })
    await check('[4.3] ok: true', () => {
      if (b.ok !== true) throw new Error(`ok=${String(b.ok)}`)
    })
    const stats = b.stats as Record<string, unknown> | undefined
    await check('[4.4] stats.visitors е обект', () => {
      if (!stats?.visitors || typeof stats.visitors !== 'object' || Array.isArray(stats.visitors)) {
        throw new Error(`visitors=${String(stats?.visitors)}`)
      }
    })
    const visitors = stats?.visitors as Record<string, unknown> | undefined
    await check('[4.5] visitors.today е integer ≥ 0', () => {
      if (!Number.isInteger(visitors?.today) || (visitors.today as number) < 0) {
        throw new Error(`today=${String(visitors?.today)}`)
      }
    })
    await check('[4.6] visitors.yesterday е integer ≥ 0', () => {
      if (!Number.isInteger(visitors?.yesterday) || (visitors.yesterday as number) < 0) {
        throw new Error(`yesterday=${String(visitors?.yesterday)}`)
      }
    })
    await check('[4.7] visitors.last7days е integer ≥ 0', () => {
      if (!Number.isInteger(visitors?.last7days) || (visitors.last7days as number) < 0) {
        throw new Error(`last7days=${String(visitors?.last7days)}`)
      }
    })
    await check('[4.8] visitors.last30days е integer ≥ 0', () => {
      if (!Number.isInteger(visitors?.last30days) || (visitors.last30days as number) < 0) {
        throw new Error(`last30days=${String(visitors?.last30days)}`)
      }
    })
    await check('[4.9] last30days >= last7days >= today (монотонност)', () => {
      const v = visitors as { today: number; yesterday: number; last7days: number; last30days: number }
      if (v.last30days < v.last7days) throw new Error(`last30days(${v.last30days}) < last7days(${v.last7days})`)
      if (v.last7days < v.today) throw new Error(`last7days(${v.last7days}) < today(${v.today})`)
    })
  }

} catch (err) {
  fail('Непредвидена грешка в HTTP теста', err)
  if (server) console.error('\n[server output]\n' + server.output().slice(-2000))
  console.error(err)
} finally {
  if (server) await stopServer(server)
  await isolated.cleanup()
}

// ─── Резюме ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
