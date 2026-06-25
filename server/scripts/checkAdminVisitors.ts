/**
 * Focused check: getVisitorList() + GET /api/admin/visitors endpoint
 *
 * [1] Empty DB → total=0, rows=[]
 * [2] Registered visitor: isRegistered, displayName, email, pageViews, reloads
 * [3] Guest visitor: isRegistered=false, displayName/email null
 * [4] Period filter: today excludes old, 7d includes more
 * [5] Type filter: guest/registered split
 * [6] Pagination: limit/offset
 * [7] Sorted by last_seen_at DESC
 * [8] HTTP: 403 without admin
 * [9] HTTP: 200 + correct shape with admin
 * [10] HTTP: invalid period defaults to 'today' (200 ok)
 */

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

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function makeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY, account_id TEXT NULL,
      profile_kind TEXT NOT NULL DEFAULT 'human',
      username TEXT NULL, normalized_username TEXT NULL,
      display_name TEXT NOT NULL, normalized_display_name TEXT NOT NULL,
      avatar_url TEXT NULL, level INTEGER NOT NULL DEFAULT 1,
      rank_title TEXT NULL, skill_rating INTEGER NOT NULL DEFAULT 1000,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'player',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT NULL
    );
    CREATE TABLE IF NOT EXISTS site_visitors (
      anonymous_visitor_id TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      first_profile_id TEXT NULL, last_profile_id TEXT NULL,
      first_ip_address TEXT NULL, last_ip_address TEXT NULL,
      first_user_agent TEXT NULL, last_user_agent TEXT NULL,
      first_referrer TEXT NULL, last_referrer TEXT NULL,
      first_source TEXT NULL, last_source TEXT NULL
    );
    CREATE TABLE IF NOT EXISTS site_visit_events (
      page_view_id TEXT PRIMARY KEY,
      anonymous_visitor_id TEXT NOT NULL,
      profile_id TEXT NULL,
      path TEXT NOT NULL,
      navigation_type TEXT NOT NULL CHECK (navigation_type IN ('navigate','reload','back_forward','spa')),
      referrer TEXT NULL, source TEXT NULL,
      utm_source TEXT NULL, utm_medium TEXT NULL, utm_campaign TEXT NULL,
      utm_term TEXT NULL, utm_content TEXT NULL,
      ip_address TEXT NULL, user_agent TEXT NULL,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (anonymous_visitor_id) REFERENCES site_visitors(anonymous_visitor_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_site_visit_events_occurred_at ON site_visit_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_site_visitors_last_seen_at ON site_visitors(last_seen_at);
  `)
}

function iv(db: DatabaseSync, id: string, profileId: string | null, ip: string | null, firstSeen: string, lastSeen: string, source: string | null = null): void {
  const pid = profileId ? `'${profileId}'` : 'NULL'
  const pip = ip ? `'${ip}'` : 'NULL'
  const psrc = source ? `'${source}'` : 'NULL'
  db.exec(`INSERT OR IGNORE INTO site_visitors
    (anonymous_visitor_id, first_profile_id, last_profile_id, first_ip_address, last_ip_address,
     first_seen_at, last_seen_at, first_source, last_source)
    VALUES ('${id}', ${pid}, ${pid}, ${pip}, ${pip}, ${firstSeen}, ${lastSeen}, ${psrc}, ${psrc})`)
}

function ie(db: DatabaseSync, pvId: string, visId: string, profileId: string | null, navType: string, at: string): void {
  const pid = profileId ? `'${profileId}'` : 'NULL'
  db.exec(`INSERT OR IGNORE INTO site_visit_events
    (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at)
    VALUES ('${pvId}', '${visId}', ${pid}, '/', '${navType}', ${at})`)
}

async function withDb(fn: (dbPath: string, db: DatabaseSync) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-admin-visitors-'))
  const dbPath = join(dir, 'test.sqlite')
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA journal_mode = WAL;')
  makeSchema(db)
  try {
    await fn(dbPath, db)
  } finally {
    try { db.close() } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true })
  }
}

// ─── [1] Empty DB ─────────────────────────────────────────────────────────────

console.log('\n[1] Empty DB → total=0, rows=[]')
await withDb(async (dbPath, db) => {
  db.close()
  const store = await createSiteVisitStore(dbPath)
  try {
    const r = store.getVisitorList({ period: 'today', type: 'all', limit: 50, offset: 0 })
    await check('[1.1] total=0', () => { if (r.total !== 0) throw new Error(`total=${r.total}`) })
    await check('[1.2] rows=[]', () => { if (r.rows.length !== 0) throw new Error(`rows.length=${r.rows.length}`) })
  } finally { store.close() }
})

// ─── [2] Registered visitor fields ───────────────────────────────────────────

console.log('\n[2] Registered visitor: fields populated correctly')
await withDb(async (dbPath, db) => {
  db.exec(`INSERT INTO accounts (account_id, email, password_hash, role) VALUES ('acc1', 'user@test.com', 'x', 'player')`)
  db.exec(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name) VALUES ('prof1', 'acc1', 'Тест Юзър', 'tест юзър')`)
  iv(db, 'vis1', 'prof1', '10.0.0.1', "datetime('now', '-2 hours')", "datetime('now')", 'google')
  ie(db, 'ev1', 'vis1', 'prof1', 'navigate', "datetime('now', '-2 hours')")
  ie(db, 'ev2', 'vis1', 'prof1', 'reload', "datetime('now', '-1 hour')")
  ie(db, 'ev3', 'vis1', 'prof1', 'navigate', "datetime('now', '-30 minutes')")
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const r = store.getVisitorList({ period: 'today', type: 'all', limit: 50, offset: 0 })
    await check('[2.1] total=1', () => { if (r.total !== 1) throw new Error(`total=${r.total}`) })
    const row = r.rows[0]!
    await check('[2.2] isRegistered=true', () => { if (!row.isRegistered) throw new Error('isRegistered=false') })
    await check('[2.3] displayName', () => { if (row.displayName !== 'Тест Юзър') throw new Error(`displayName=${row.displayName}`) })
    await check('[2.4] email', () => { if (row.email !== 'user@test.com') throw new Error(`email=${row.email}`) })
    await check('[2.5] lastIpAddress', () => { if (row.lastIpAddress !== '10.0.0.1') throw new Error(`ip=${row.lastIpAddress}`) })
    await check('[2.6] firstSource=google', () => { if (row.firstSource !== 'google') throw new Error(`source=${row.firstSource}`) })
    await check('[2.7] pageViews=3', () => { if (row.pageViews !== 3) throw new Error(`pageViews=${row.pageViews}`) })
    await check('[2.8] reloads=1', () => { if (row.reloads !== 1) throw new Error(`reloads=${row.reloads}`) })
  } finally { store.close() }
})

// ─── [3] Guest visitor ────────────────────────────────────────────────────────

console.log('\n[3] Guest visitor: isRegistered=false, no name/email')
await withDb(async (dbPath, db) => {
  iv(db, 'guest1', null, '5.5.5.5', "datetime('now', '-1 hour')", "datetime('now')")
  ie(db, 'ge1', 'guest1', null, 'navigate', "datetime('now', '-1 hour')")
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const r = store.getVisitorList({ period: 'today', type: 'all', limit: 50, offset: 0 })
    await check('[3.1] total=1', () => { if (r.total !== 1) throw new Error(`total=${r.total}`) })
    const row = r.rows[0]!
    await check('[3.2] isRegistered=false', () => { if (row.isRegistered) throw new Error('isRegistered=true') })
    await check('[3.3] displayName=null', () => { if (row.displayName !== null) throw new Error(`displayName=${row.displayName}`) })
    await check('[3.4] email=null', () => { if (row.email !== null) throw new Error(`email=${row.email}`) })
  } finally { store.close() }
})

// ─── [4] Period filter ────────────────────────────────────────────────────────

console.log('\n[4] Period filter')
await withDb(async (dbPath, db) => {
  iv(db, 'v-now',  null, null, "datetime('now', '-30 minutes')", "datetime('now', '-30 minutes')")
  iv(db, 'v-3d',   null, null, "datetime('now', '-3 days')", "datetime('now', '-3 days')")
  iv(db, 'v-15d',  null, null, "datetime('now', '-15 days')", "datetime('now', '-15 days')")
  iv(db, 'v-40d',  null, null, "datetime('now', '-40 days')", "datetime('now', '-40 days')")
  ie(db, 'e1', 'v-now',  null, 'navigate', "datetime('now', '-30 minutes')")
  ie(db, 'e2', 'v-3d',   null, 'navigate', "datetime('now', '-3 days')")
  ie(db, 'e3', 'v-15d',  null, 'navigate', "datetime('now', '-15 days')")
  ie(db, 'e4', 'v-40d',  null, 'navigate', "datetime('now', '-40 days')")
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const today = store.getVisitorList({ period: 'today', type: 'all', limit: 50, offset: 0 })
    const d7    = store.getVisitorList({ period: '7d',    type: 'all', limit: 50, offset: 0 })
    const d30   = store.getVisitorList({ period: '30d',   type: 'all', limit: 50, offset: 0 })
    await check('[4.1] today: only v-now', () => { if (today.total !== 1) throw new Error(`today.total=${today.total}`) })
    await check('[4.2] 7d: v-now + v-3d = 2', () => { if (d7.total !== 2) throw new Error(`7d.total=${d7.total}`) })
    await check('[4.3] 30d: v-now + v-3d + v-15d = 3', () => { if (d30.total !== 3) throw new Error(`30d.total=${d30.total}`) })
  } finally { store.close() }
})

// ─── [5] Type filter ──────────────────────────────────────────────────────────

console.log('\n[5] Type filter: all/guest/registered')
await withDb(async (dbPath, db) => {
  db.exec(`INSERT INTO accounts (account_id, email, password_hash, role) VALUES ('acc5', 'r@r.com', 'x', 'player')`)
  db.exec(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name) VALUES ('p5', 'acc5', 'Reg', 'reg')`)
  iv(db, 'vg1', null,  null, "datetime('now', '-1 hour')", "datetime('now', '-1 hour')")
  iv(db, 'vg2', null,  null, "datetime('now', '-2 hours')", "datetime('now', '-2 hours')")
  iv(db, 'vr1', 'p5', null, "datetime('now', '-3 hours')", "datetime('now', '-3 hours')")
  ie(db, 'eg1', 'vg1', null,  'navigate', "datetime('now', '-1 hour')")
  ie(db, 'eg2', 'vg2', null,  'navigate', "datetime('now', '-2 hours')")
  ie(db, 'er1', 'vr1', 'p5', 'navigate', "datetime('now', '-3 hours')")
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const all  = store.getVisitorList({ period: 'today', type: 'all',        limit: 50, offset: 0 })
    const g    = store.getVisitorList({ period: 'today', type: 'guest',       limit: 50, offset: 0 })
    const reg  = store.getVisitorList({ period: 'today', type: 'registered',  limit: 50, offset: 0 })
    await check('[5.1] all: total=3', () => { if (all.total !== 3) throw new Error(`all.total=${all.total}`) })
    await check('[5.2] guest: total=2', () => { if (g.total !== 2) throw new Error(`guest.total=${g.total}`) })
    await check('[5.3] guest rows: all isRegistered=false', () => { if (g.rows.some(r => r.isRegistered)) throw new Error('has registered') })
    await check('[5.4] registered: total=1', () => { if (reg.total !== 1) throw new Error(`reg.total=${reg.total}`) })
    await check('[5.5] registered rows: all isRegistered=true', () => { if (reg.rows.some(r => !r.isRegistered)) throw new Error('has guest') })
  } finally { store.close() }
})

// ─── [6] Pagination ───────────────────────────────────────────────────────────

console.log('\n[6] Pagination: limit/offset')
await withDb(async (dbPath, db) => {
  for (let i = 0; i < 6; i++) {
    const id = `vpg${i}`
    iv(db, id, null, null, `datetime('now', '-${i + 1} hours')`, `datetime('now', '-${i} minutes')`)
    ie(db, `epg${i}`, id, null, 'navigate', `datetime('now', '-${i + 1} hours')`)
  }
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const p1 = store.getVisitorList({ period: 'today', type: 'all', limit: 2, offset: 0 })
    const p2 = store.getVisitorList({ period: 'today', type: 'all', limit: 2, offset: 2 })
    const p3 = store.getVisitorList({ period: 'today', type: 'all', limit: 2, offset: 4 })
    await check('[6.1] total=6 on all pages', () => { if (p1.total !== 6) throw new Error(`total=${p1.total}`) })
    await check('[6.2] page1: 2 rows', () => { if (p1.rows.length !== 2) throw new Error(`len=${p1.rows.length}`) })
    await check('[6.3] page2: 2 rows', () => { if (p2.rows.length !== 2) throw new Error(`len=${p2.rows.length}`) })
    await check('[6.4] page3: 2 rows', () => { if (p3.rows.length !== 2) throw new Error(`len=${p3.rows.length}`) })
    await check('[6.5] pages non-overlapping', () => {
      const ids1 = new Set(p1.rows.map(r => r.anonymousVisitorId))
      const ids2 = new Set(p2.rows.map(r => r.anonymousVisitorId))
      if ([...ids2].some(id => ids1.has(id))) throw new Error('overlap between pages')
    })
  } finally { store.close() }
})

// ─── [7] Sort by last_seen_at DESC ────────────────────────────────────────────

console.log('\n[7] Sorted by last_seen_at DESC')
await withDb(async (dbPath, db) => {
  // Insert with different last_seen values, older first to check ordering
  iv(db, 'vsort-old',   null, null, "datetime('now', '-3 hours')", "datetime('now', '-3 hours')")
  iv(db, 'vsort-mid',   null, null, "datetime('now', '-2 hours')", "datetime('now', '-2 hours')")
  iv(db, 'vsort-new',   null, null, "datetime('now', '-1 hour')",  "datetime('now', '-30 minutes')")
  ie(db, 'es1', 'vsort-old', null, 'navigate', "datetime('now', '-3 hours')")
  ie(db, 'es2', 'vsort-mid', null, 'navigate', "datetime('now', '-2 hours')")
  ie(db, 'es3', 'vsort-new', null, 'navigate', "datetime('now', '-1 hour')")
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const r = store.getVisitorList({ period: 'today', type: 'all', limit: 50, offset: 0 })
    await check('[7.1] first row is vsort-new (newest)', () => {
      if (r.rows[0]?.anonymousVisitorId !== 'vsort-new') throw new Error(`first=${r.rows[0]?.anonymousVisitorId}`)
    })
    await check('[7.2] last row is vsort-old (oldest)', () => {
      const last = r.rows[r.rows.length - 1]
      if (last?.anonymousVisitorId !== 'vsort-old') throw new Error(`last=${last?.anonymousVisitorId}`)
    })
  } finally { store.close() }
})

// ─── [8-10] HTTP endpoint ─────────────────────────────────────────────────────

console.log('\n[8-10] HTTP: GET /api/admin/visitors')

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'AdminVisitorsCheck1!'

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') { srv.close(() => reject(new Error('No free port'))); return }
      const { port } = addr
      srv.close(() => resolve(port))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function waitFor(label: string, pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
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
      { hostname: '127.0.0.1', port, path: pathname, method: 'GET', headers, timeout: 8000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          let body: unknown = null
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* */ }
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')))
    req.on('error', reject)
    req.end()
  })
}

const sourceRoot = resolve(process.argv.slice(2).find(a => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
console.log(`  Server root: ${sourceRoot}`)

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-admin-visitors-http-'))
  const serverDir = join(tmp, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(root, 'src'),  join(serverDir, 'src'),  { recursive: true, preserveTimestamps: true })
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
    cleanup: async () => rm(tmp, { recursive: true, force: true }),
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
  await new Promise<void>(r => {
    const t = setTimeout(() => { s.child.kill('SIGKILL'); r() }, 10_000)
    s.child.once('exit', () => { clearTimeout(t); r() })
  })
}

const iso = await makeIsolated(sourceRoot)
const port = await getFreePort()
let srv: ReturnType<typeof startSrv> | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitFor('server ready', async () => {
    try {
      const r = await httpGet(port, '/health')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`
  const adminEmail = `admin-visitors-${runId}@example.test`

  const regRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: PASSWORD, displayName: 'VisAdmin', gender: 'male' }),
  })
  if (regRes.status !== 200) throw new Error(`Register ${regRes.status}`)

  const db2 = new DatabaseSync(iso.dbFile)
  db2.prepare(`UPDATE accounts SET role='admin' WHERE email=?`).run(adminEmail)
  db2.close()

  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: PASSWORD }),
  })
  const h2 = loginRes.headers as Headers & { getSetCookie?: () => string[] }
  const adminCookie = (h2.getSetCookie?.()[0] ?? loginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!adminCookie) throw new Error('No Set-Cookie on admin login')

  // [8] 403 без cookie
  await check('[8] 403 без admin cookie', async () => {
    const r = await httpGet(port, '/api/admin/visitors?period=today')
    if (r.status !== 403) throw new Error(`status=${r.status}`)
    if ((r.body as { ok: boolean }).ok !== false) throw new Error('ok should be false')
  })

  // [9] 200 + shape
  await check('[9] 200 + correct shape', async () => {
    const r = await httpGet(port, '/api/admin/visitors?period=today&type=all&limit=50&offset=0', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
    const b = r.body as { ok: boolean; rows: unknown[]; total: number }
    if (!b.ok) throw new Error('ok=false')
    if (!Array.isArray(b.rows)) throw new Error('rows not array')
    if (typeof b.total !== 'number') throw new Error(`total type=${typeof b.total}`)
    if (b.total < 0) throw new Error(`total=${b.total}`)
  })

  // [10] Invalid period → 200 ok
  await check('[10] invalid period → 200 ok (defaults to today)', async () => {
    const r = await httpGet(port, '/api/admin/visitors?period=BOGUS&type=BOGUS', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
    const b = r.body as { ok: boolean }
    if (!b.ok) throw new Error('ok=false')
  })

} catch (err) {
  fail('HTTP test error', err)
  if (srv) console.error('\n[server output]\n' + srv.output().slice(-3000))
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

// ─── Резюме ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
