/**
 * Focused check: getVisitorSources() + GET /api/admin/visitor-sources
 *
 * [1] Empty DB → total=0, no rows
 * [2] Known aliases → canonical labels (Facebook/Instagram/Google/Pika.bg/Директно)
 * [3] Unknown UTM source → shown as-is
 * [4] Unknown referrer domain → hostname as label
 * [5] Each visitor counted once (source priority over referrer)
 * [6] Period filter: today vs 7d
 * [7] Sort by visitors DESC; Директно last on tie
 * [8] Sum of rows = total
 * [9] HTTP: 403 without admin
 * [10] HTTP: 200 + correct shape (label/visitors/percent, no category field)
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

let passed = 0
let failed = 0

function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}

function makeSchema(db: DatabaseSync): void {
  db.exec(`
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
      profile_id TEXT NULL, path TEXT NOT NULL,
      navigation_type TEXT NOT NULL CHECK (navigation_type IN ('navigate','reload','back_forward','spa')),
      referrer TEXT NULL, source TEXT NULL,
      utm_source TEXT NULL, utm_medium TEXT NULL, utm_campaign TEXT NULL,
      utm_term TEXT NULL, utm_content TEXT NULL,
      ip_address TEXT NULL, user_agent TEXT NULL,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (anonymous_visitor_id) REFERENCES site_visitors(anonymous_visitor_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sve_at ON site_visit_events(occurred_at);
  `)
}

async function withDb(fn: (dbPath: string, db: DatabaseSync) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-visitor-sources-'))
  const dbPath = join(dir, 'test.sqlite')
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA journal_mode = WAL;')
  makeSchema(db)
  try { await fn(dbPath, db) } finally {
    try { db.close() } catch { /* */ }
    await rm(dir, { recursive: true, force: true })
  }
}

function iv(db: DatabaseSync, id: string, source: string | null, referrer: string | null, at: string): void {
  const s = source ? `'${source}'` : 'NULL'
  const r = referrer ? `'${referrer}'` : 'NULL'
  db.exec(`INSERT OR IGNORE INTO site_visitors
    (anonymous_visitor_id, first_source, last_source, first_referrer, last_referrer, first_seen_at, last_seen_at)
    VALUES ('${id}', ${s}, ${s}, ${r}, ${r}, ${at}, ${at})`)
  db.exec(`INSERT OR IGNORE INTO site_visit_events
    (page_view_id, anonymous_visitor_id, path, navigation_type, occurred_at)
    VALUES ('${randomUUID()}', '${id}', '/', 'navigate', ${at})`)
}

const NOW = "datetime('now', '-1 hour')"
const OLD = "datetime('now', '-5 days')"

// ─── [1] Empty DB ─────────────────────────────────────────────────────────────
console.log('\n[1] Empty DB → total=0, no rows')
await withDb(async (dbPath, db) => {
  db.close()
  const store = await createSiteVisitStore(dbPath)
  try {
    const r = store.getVisitorSources({ period: 'today' })
    await check('[1.1] total=0', () => { if (r.total !== 0) throw new Error(`total=${r.total}`) })
    await check('[1.2] rows is empty array', () => { if (r.rows.length !== 0) throw new Error(`rows.length=${r.rows.length}`) })
  } finally { store.close() }
})

// ─── [2] Known aliases → canonical labels ─────────────────────────────────────
console.log('\n[2] Known aliases → canonical labels')
await withDb(async (dbPath, db) => {
  // Facebook aliases
  iv(db, 'fb1', null,           'https://www.facebook.com/foo', NOW)
  iv(db, 'fb2', 'facebook',     null,                           NOW)
  iv(db, 'fb3', 'fb',           null,                           NOW)
  iv(db, 'fb4', 'facebook_ads', null,                           NOW)
  iv(db, 'fb5', null,           'https://l.facebook.com/x',    NOW)
  iv(db, 'fb6', null,           'https://m.facebook.com/x',    NOW)
  // Instagram aliases
  iv(db, 'ig1', null,           'https://www.instagram.com/p', NOW)
  iv(db, 'ig2', 'instagram',    null,                           NOW)
  iv(db, 'ig3', 'ig',           null,                           NOW)
  iv(db, 'ig4', null,           'https://l.instagram.com/x',   NOW)
  // Google aliases
  iv(db, 'go1', null,           'https://www.google.bg/s',     NOW)
  iv(db, 'go2', 'google',       null,                           NOW)
  iv(db, 'go3', 'google_ads',   null,                           NOW)
  iv(db, 'go4', 'googleadservices', null,                       NOW)
  iv(db, 'go5', null,           'https://google.com/s',        NOW)
  // Pika
  iv(db, 'pi1', 'pika.bg',      null,                           NOW)
  iv(db, 'pi2', 'localhost',    null,                           NOW)
  // Direct (null / explicit 'direct')
  iv(db, 'di1', null,           null,                           NOW)
  iv(db, 'di2', 'direct',       null,                           NOW)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const r = store.getVisitorSources({ period: 'today' })
    const byLabel = Object.fromEntries(r.rows.map(row => [row.label, row.visitors]))

    await check('[2.1] Facebook=6', () => { if (byLabel['Facebook'] !== 6) throw new Error(`Facebook=${byLabel['Facebook']}`) })
    await check('[2.2] Instagram=4', () => { if (byLabel['Instagram'] !== 4) throw new Error(`Instagram=${byLabel['Instagram']}`) })
    await check('[2.3] Google=5', () => { if (byLabel['Google'] !== 5) throw new Error(`Google=${byLabel['Google']}`) })
    await check('[2.4] Pika.bg=2', () => { if (byLabel['Pika.bg'] !== 2) throw new Error(`Pika.bg=${byLabel['Pika.bg']}`) })
    await check('[2.5] Директно=2', () => { if (byLabel['Директно'] !== 2) throw new Error(`Директно=${byLabel['Директно']}`) })
    await check('[2.6] total=19', () => { if (r.total !== 19) throw new Error(`total=${r.total}`) })
    await check('[2.7] no "Други" label', () => {
      if (r.rows.some(row => row.label === 'Други')) throw new Error('Found "Други" — should not exist')
    })
  } finally { store.close() }
})

// ─── [3] Unknown UTM source → shown as-is ────────────────────────────────────
console.log('\n[3] Unknown UTM source → shown with own name')
await withDb(async (dbPath, db) => {
  iv(db, 'u1', 'tiktok',  null, NOW)
  iv(db, 'u2', 'tiktok',  null, NOW)
  iv(db, 'u3', 'linkedin', null, NOW)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const r = store.getVisitorSources({ period: 'today' })
    const byLabel = Object.fromEntries(r.rows.map(row => [row.label, row.visitors]))
    await check('[3.1] tiktok=2', () => { if (byLabel['tiktok'] !== 2) throw new Error(`tiktok=${byLabel['tiktok']}`) })
    await check('[3.2] linkedin=1', () => { if (byLabel['linkedin'] !== 1) throw new Error(`linkedin=${byLabel['linkedin']}`) })
    await check('[3.3] no "Други"', () => {
      if (r.rows.some(row => row.label === 'Други')) throw new Error('Found "Други"')
    })
  } finally { store.close() }
})

// ─── [4] Unknown referrer domain → hostname as label ─────────────────────────
console.log('\n[4] Unknown referrer domain → hostname shown as label')
await withDb(async (dbPath, db) => {
  iv(db, 'r1', null, 'https://www.twitter.com/x',  NOW)
  iv(db, 'r2', null, 'https://reddit.com/r/foo',   NOW)
  iv(db, 'r3', null, 'https://www.reddit.com/r/b', NOW)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const r = store.getVisitorSources({ period: 'today' })
    const labels = r.rows.map(row => row.label)
    await check('[4.1] twitter.com in labels', () => {
      if (!labels.includes('twitter.com')) throw new Error(`labels=${JSON.stringify(labels)}`)
    })
    await check('[4.2] reddit.com in labels (www stripped)', () => {
      if (!labels.includes('reddit.com')) throw new Error(`labels=${JSON.stringify(labels)}`)
    })
    await check('[4.3] twitter count=1', () => {
      const row = r.rows.find(row => row.label === 'twitter.com')
      if (!row || row.visitors !== 1) throw new Error(`visitors=${row?.visitors}`)
    })
    await check('[4.4] reddit count=2 (both www and non-www collapsed)', () => {
      const row = r.rows.find(row => row.label === 'reddit.com')
      if (!row || row.visitors !== 2) throw new Error(`visitors=${row?.visitors}`)
    })
  } finally { store.close() }
})

// ─── [5] Each visitor counted once ───────────────────────────────────────────
console.log('\n[5] Each visitor counted once — source wins over referrer')
await withDb(async (dbPath, db) => {
  // Has both source=google_ads and referrer=facebook.com → must be in Google only
  db.exec(`INSERT OR IGNORE INTO site_visitors
    (anonymous_visitor_id, first_source, last_source, first_referrer, last_referrer, first_seen_at, last_seen_at)
    VALUES ('combo', 'google_ads', 'google_ads', 'https://www.facebook.com/x', 'https://www.facebook.com/x', ${NOW}, ${NOW})`)
  db.exec(`INSERT OR IGNORE INTO site_visit_events
    (page_view_id, anonymous_visitor_id, path, navigation_type, occurred_at)
    VALUES ('${randomUUID()}', 'combo', '/', 'navigate', ${NOW})`)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const r = store.getVisitorSources({ period: 'today' })
    await check('[5.1] total=1', () => { if (r.total !== 1) throw new Error(`total=${r.total}`) })
    const sum = r.rows.reduce((a, b) => a + b.visitors, 0)
    await check('[5.2] sum of rows = total', () => { if (sum !== r.total) throw new Error(`sum=${sum}`) })
    const byLabel = Object.fromEntries(r.rows.map(row => [row.label, row.visitors]))
    await check('[5.3] in Google (source wins)', () => { if (byLabel['Google'] !== 1) throw new Error(`Google=${byLabel['Google']}`) })
    await check('[5.4] not in Facebook', () => { if (byLabel['Facebook']) throw new Error(`Facebook=${byLabel['Facebook']}`) })
  } finally { store.close() }
})

// ─── [6] Period filter ────────────────────────────────────────────────────────
console.log('\n[6] Period filter: today vs 7d')
await withDb(async (dbPath, db) => {
  iv(db, 'p-now', null, 'https://google.com', NOW)
  iv(db, 'p-old', null, 'https://google.com', OLD)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const today = store.getVisitorSources({ period: 'today' })
    const d7    = store.getVisitorSources({ period: '7d' })
    await check('[6.1] today: total=1', () => { if (today.total !== 1) throw new Error(`total=${today.total}`) })
    await check('[6.2] 7d: total=2', () => { if (d7.total !== 2) throw new Error(`total=${d7.total}`) })
  } finally { store.close() }
})

// ─── [6b] Period filter — yesterday (fixed clock) ────────────────────────────
console.log('\n[6b] Period filter: yesterday (fixed clock)')
{
  const { getSofiaDayBoundsUtc: getBounds, toSqliteUtc: toUtc } = await import('../src/db/sofiaDayBounds.js')

  await withDb(async (dbPath, db) => {
    const fixedNow = new Date('2026-06-27T10:00:00Z')
    const bounds   = getBounds(fixedNow)

    const tsYest  = `'${toUtc(new Date(new Date(bounds.yesterdayStart + 'Z').getTime() + 2 * 3_600_000))}'`
    const tsToday = `'${toUtc(new Date(new Date(bounds.todayStart     + 'Z').getTime() + 2 * 3_600_000))}'`

    iv(db, 'sy', 'google',   null, tsYest)   // yesterday Sofia, source=google
    iv(db, 'st', 'facebook', null, tsToday)  // today Sofia, source=facebook
    db.close()

    const store = await createSiteVisitStore(dbPath)
    try {
      const yest  = store.getVisitorSources({ period: 'yesterday' }, fixedNow)
      const today = store.getVisitorSources({ period: 'today'     }, fixedNow)
      await check('[6b.1] yesterday: total=1', () => { if (yest.total !== 1) throw new Error(`total=${yest.total}`) })
      await check('[6b.2] yesterday: Google', () => {
        if (yest.rows[0]?.label !== 'Google') throw new Error(`label=${yest.rows[0]?.label}`)
      })
      await check('[6b.3] today: total=1', () => { if (today.total !== 1) throw new Error(`total=${today.total}`) })
      await check('[6b.4] today: Facebook', () => {
        if (today.rows[0]?.label !== 'Facebook') throw new Error(`label=${today.rows[0]?.label}`)
      })
    } finally { store.close() }
  })
}

// ─── [7] Sort order ───────────────────────────────────────────────────────────
console.log('\n[7] Sort by visitors DESC; Директно last on equal count')
await withDb(async (dbPath, db) => {
  // tiktok=5, facebook=3, direct=3, google=1
  for (let i = 0; i < 5; i++) iv(db, `tt${i}`, 'tiktok',   null, NOW)
  for (let i = 0; i < 3; i++) iv(db, `fb${i}`, 'facebook',  null, NOW)
  for (let i = 0; i < 3; i++) iv(db, `di${i}`, null,        null, NOW)
  iv(db, 'go0', 'google', null, NOW)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const r = store.getVisitorSources({ period: 'today' })
    await check('[7.1] first row is tiktok (5)', () => {
      if (r.rows[0]!.label !== 'tiktok') throw new Error(`first=${r.rows[0]?.label}`)
    })
    const fbIdx = r.rows.findIndex(row => row.label === 'Facebook')
    const diIdx = r.rows.findIndex(row => row.label === 'Директно')
    await check('[7.2] Facebook before Директно on tie', () => {
      if (fbIdx === -1 || diIdx === -1 || fbIdx > diIdx) throw new Error(`fb=${fbIdx} di=${diIdx}`)
    })
    await check('[7.3] Google(1) last', () => {
      const last = r.rows[r.rows.length - 1]
      if (last?.label !== 'Google') throw new Error(`last=${last?.label}`)
    })
  } finally { store.close() }
})

// ─── [8] Sum of rows = total ──────────────────────────────────────────────────
console.log('\n[8] Sum of rows visitors = total')
await withDb(async (dbPath, db) => {
  iv(db, 'x1', 'facebook', null,                        NOW)
  iv(db, 'x2', null,       'https://twitter.com/x',     NOW)
  iv(db, 'x3', null,       null,                         NOW)
  iv(db, 'x4', 'tiktok',  null,                         NOW)
  iv(db, 'x5', null,       'https://reddit.com/r/foo',  NOW)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const r = store.getVisitorSources({ period: 'today' })
    const sum = r.rows.reduce((a, b) => a + b.visitors, 0)
    await check('[8.1] sum=total', () => { if (sum !== r.total) throw new Error(`sum=${sum} total=${r.total}`) })
    await check('[8.2] total=5', () => { if (r.total !== 5) throw new Error(`total=${r.total}`) })
  } finally { store.close() }
})

// ─── [9-10] HTTP endpoint ──────────────────────────────────────────────────────
console.log('\n[9-10] HTTP: GET /api/admin/visitor-sources')

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'VisitorSourcesCheck1!'

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') { srv.close(() => reject(new Error('No free port'))); return }
      srv.close(() => resolve((addr).port))
    })
  })
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

async function waitFor(label: string, pred: () => Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await pred()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

function httpGet(port: number, path: string, cookie?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (cookie) headers.Cookie = cookie
    const req = request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers, timeout: 8000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(Buffer.from(c)))
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

const sourceRoot = resolve(process.argv.slice(2).find(a => a.startsWith('--server-root='))?.slice(14) ?? process.cwd())
console.log(`  Server root: ${sourceRoot}`)

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-vsrc-http-'))
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

function startSrv(serverDir: string, port: number) {
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
  const adminEmail = `sources-admin-${runId}@example.test`

  const regRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: PASSWORD, displayName: 'SrcAdmin', gender: 'male' }),
  })
  if (regRes.status !== 200) throw new Error(`Register ${regRes.status}`)

  const db2 = new DatabaseSync(iso.dbFile)
  db2.prepare(`UPDATE accounts SET role='admin' WHERE email=?`).run(adminEmail)
  db2.close()

  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: PASSWORD }),
  })
  const lh = loginRes.headers as Headers & { getSetCookie?: () => string[] }
  const adminCookie = (lh.getSetCookie?.()[0] ?? loginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!adminCookie) throw new Error('No Set-Cookie on admin login')

  await check('[9] 403 без admin cookie', async () => {
    const r = await httpGet(port, '/api/admin/visitor-sources?period=today')
    if (r.status !== 403) throw new Error(`status=${r.status}`)
    if ((r.body as { ok: boolean }).ok !== false) throw new Error('ok should be false')
  })

  await check('[10.1] 200 + shape: ok/rows/total', async () => {
    const r = await httpGet(port, '/api/admin/visitor-sources?period=today', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
    const b = r.body as { ok: boolean; rows: unknown[]; total: number }
    if (!b.ok) throw new Error('ok=false')
    if (!Array.isArray(b.rows)) throw new Error('rows not array')
    if (typeof b.total !== 'number') throw new Error(`total type=${typeof b.total}`)
  })

  await check('[10.2] empty DB → rows=[] total=0', async () => {
    const r = await httpGet(port, '/api/admin/visitor-sources?period=today', adminCookie)
    const b = r.body as { ok: boolean; rows: unknown[]; total: number }
    if (b.rows.length !== 0) throw new Error(`rows.length=${b.rows.length} (expected 0 in fresh DB)`)
    if (b.total !== 0) throw new Error(`total=${b.total}`)
  })

} catch (err) {
  fail('HTTP test error', err)
  if (srv) console.error('\n[server output]\n' + srv.output().slice(-3000))
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
