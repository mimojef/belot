import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink, readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createSiteVisitStore } from '../src/db/siteVisitStore.js'

const PASSWORD = 'VisitorSmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000
const ENDPOINT = '/api/visits/page-view'

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

type HttpResult = {
  status: number
  body: unknown
}

function httpJson(
  port: number,
  pathname: string,
  method: string,
  body?: unknown,
  cookie?: string,
  extraHeaders: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers: Record<string, string> = {
      'User-Agent': 'visitor-smoke/1.0',
      'X-Forwarded-For': '203.0.113.41',
      ...extraHeaders,
    }
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(payload))
    }
    if (cookie) headers.Cookie = cookie

    const req = request(
      { hostname: '127.0.0.1', port, path: pathname, method, headers, timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          let parsed: unknown = null
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            // Tests below assert JSON only for endpoints that should return JSON.
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('HTTP timeout.')))
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

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
  const root = await mkdtemp(join(tmpdir(), 'belot-visitor-smoke-'))
  const serverDir = join(root, 'server')

  await mkdir(serverDir, { recursive: true })
  await cp(join(originalServerRoot, 'src'), join(serverDir, 'src'), {
    recursive: true,
    preserveTimestamps: true,
  })
  await cp(join(originalServerRoot, 'dist'), join(serverDir, 'dist'), {
    recursive: true,
    preserveTimestamps: true,
  })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(
    join(originalServerRoot, 'database', 'migrations'),
    join(serverDir, 'database', 'migrations'),
    { recursive: true, preserveTimestamps: true },
  )
  await cp(join(originalServerRoot, 'package.json'), join(serverDir, 'package.json'), {
    preserveTimestamps: true,
  })

  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(originalServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(originalServerRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)

  return {
    root,
    serverDir,
    databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: async () => {
      // On Windows, SQLite WAL files can briefly remain locked after the
      // server process exits. Retry a few times rather than propagating EBUSY.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await rm(root, { recursive: true, force: true })
          return
        } catch {
          await new Promise<void>((r) => setTimeout(r, 250))
        }
      }
    },
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
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); resolve() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); resolve() })
  })
}

async function registerAndGetCookie(port: number, runId: string): Promise<{ cookie: string; profileId: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `visitor-smoke-${runId}@example.test`,
      password: PASSWORD,
      displayName: `Visitor Smoke ${runId.slice(-4)}`,
      gender: 'male',
    }),
  })
  if (res.status !== 200) throw new Error(`Регистрацията върна status ${res.status}.`)
  const payload = await res.json() as { ok?: boolean; session?: { profile?: { profileId?: string | null } }; message?: string }
  if (!payload.ok) throw new Error(`Регистрацията не е успешна: ${payload.message ?? '?'}`)

  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  if (!rawCookie) throw new Error('Липсва Set-Cookie при регистрация.')
  const profileId = payload.session?.profile?.profileId
  if (!profileId) throw new Error('Липсва profileId при регистрация.')

  return { cookie: rawCookie.split(';')[0]!, profileId }
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    anonymousVisitorId: randomUUID(),
    pageViewId: randomUUID(),
    path: '/lobby',
    navigationType: 'navigate',
    referrer: null,
    utm: {},
    ...overrides,
  }
}

function getDb(databaseFile: string): DatabaseSync {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  return db
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

console.log('\n═══ Visitor tracking focused checks ═══')
console.log(`Server root: ${sourceServerRoot}`)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null

try {
  server = startServer(isolated.serverDir, port)

  console.log(`\n[startup] Чакам сървъра на порт ${port}...`)
  await waitFor(
    'server health ready',
    async () => {
      try {
        const r = await httpJson(port, '/health', 'GET')
        const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
        return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
      } catch {
        return false
      }
    },
    SERVER_READY_TIMEOUT_MS,
  )
  console.log('  Сървърът е готов.')

  console.log('\n[1] Валиден guest event')
  const guestPayload = payload({
    referrer: 'https://google.example/search?q=secret',
    utm: { utm_source: 'google', utm_medium: 'organic', utm_campaign: 'summer' },
  })
  {
    const r = await httpJson(port, ENDPOINT, 'POST', guestPayload)
    const b = r.body as { ok?: boolean; recorded?: boolean }
    await check('[1.1] guest status 200', () => {
      if (r.status !== 200) throw new Error(`Получен ${r.status}, очакван 200`)
    })
    await check('[1.2] guest recorded true', () => {
      if (b.ok !== true || b.recorded !== true) throw new Error(`Отговор: ${JSON.stringify(b)}`)
    })
    const db = getDb(isolated.databaseFile)
    try {
      const row = db.prepare(`
        SELECT profile_id, path, referrer, source, utm_source, utm_medium, utm_campaign, ip_address, user_agent
        FROM site_visit_events
        WHERE page_view_id = ?
      `).get(guestPayload.pageViewId) as Record<string, unknown> | undefined
      await check('[1.3] guest записът е без profileId и с server-side IP/UA', () => {
        if (!row) throw new Error('Липсва event row.')
        if (row.profile_id !== null) throw new Error(`profile_id=${String(row.profile_id)}`)
        if (row.ip_address !== '203.0.113.41') throw new Error(`ip_address=${String(row.ip_address)}`)
        if (row.user_agent !== 'visitor-smoke/1.0') throw new Error(`user_agent=${String(row.user_agent)}`)
      })
      await check('[1.4] query string не се пази в referrer', () => {
        if (row?.referrer !== 'https://google.example/search') throw new Error(`referrer=${String(row?.referrer)}`)
      })
      await check('[1.5] UTM whitelist полетата се пазят', () => {
        if (row?.source !== 'google' || row.utm_source !== 'google' || row.utm_medium !== 'organic' || row.utm_campaign !== 'summer') {
          throw new Error(JSON.stringify(row))
        }
      })
    } finally {
      db.close()
    }
  }

  console.log('\n[2] Authenticated event')
  const runId = `${Date.now()}-${process.pid}`
  const auth = await registerAndGetCookie(port, runId)
  const authPayload = payload({ anonymousVisitorId: guestPayload.anonymousVisitorId, path: '/players' })
  {
    const r = await httpJson(port, ENDPOINT, 'POST', authPayload, auth.cookie)
    const b = r.body as { ok?: boolean; recorded?: boolean }
    await check('[2.1] authenticated status 200', () => {
      if (r.status !== 200 || b.ok !== true || b.recorded !== true) throw new Error(`Отговор: ${r.status} ${JSON.stringify(b)}`)
    })
    const db = getDb(isolated.databaseFile)
    try {
      const row = db.prepare(`SELECT profile_id FROM site_visit_events WHERE page_view_id = ?`).get(authPayload.pageViewId) as { profile_id: string | null } | undefined
      await check('[2.2] authenticated event е свързан с profileId от session', () => {
        if (row?.profile_id !== auth.profileId) throw new Error(`profile_id=${String(row?.profile_id)}, expected=${auth.profileId}`)
      })
    } finally {
      db.close()
    }
  }

  console.log('\n[3] Duplicate pageViewId')
  {
    const duplicate = { ...authPayload, path: '/ranking', referrer: 'https://duplicate.example/path' }
    const r = await httpJson(port, ENDPOINT, 'POST', duplicate, auth.cookie)
    const b = r.body as { ok?: boolean; recorded?: boolean; duplicate?: boolean }
    await check('[3.1] duplicate връща recorded false', () => {
      if (r.status !== 200 || b.ok !== true || b.recorded !== false || b.duplicate !== true) {
        throw new Error(`Отговор: ${r.status} ${JSON.stringify(b)}`)
      }
    })
    const db = getDb(isolated.databaseFile)
    try {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM site_visit_events WHERE page_view_id = ?`).get(authPayload.pageViewId) as { count: number }
      await check('[3.2] duplicate не добавя втори event', () => {
        if (row.count !== 1) throw new Error(`count=${row.count}`)
      })
    } finally {
      db.close()
    }
  }

  console.log('\n[4] Cross-site browser request rejection')
  {
    const r = await httpJson(port, ENDPOINT, 'POST', payload(), undefined, {
      Origin: 'https://evil.example',
      'Sec-Fetch-Site': 'cross-site',
      'X-Forwarded-For': '203.0.113.42',
    })
    await check('[4.1] cross-site browser POST → 403', () => {
      if (r.status !== 403) throw new Error(`Получен ${r.status}, очакван 403`)
    })
  }

  console.log('\n[5] Rate limit по IP')
  {
    const ip = '203.0.113.50'
    let limitedStatus = 0
    for (let i = 0; i < 121; i++) {
      const r = await httpJson(port, ENDPOINT, 'POST', payload(), undefined, {
        'X-Forwarded-For': ip,
      })
      limitedStatus = r.status
    }
    await check('[5.1] 121-а заявка от един IP → 429', () => {
      if (limitedStatus !== 429) throw new Error(`Получен ${limitedStatus}, очакван 429`)
    })
  }

  console.log('\n[6] Rate limit по visitor ID')
  {
    const visitorId = randomUUID()
    let limitedStatus = 0
    for (let i = 0; i < 61; i++) {
      const r = await httpJson(port, ENDPOINT, 'POST', payload({ anonymousVisitorId: visitorId }), undefined, {
        'X-Forwarded-For': '203.0.113.51',
      })
      limitedStatus = r.status
    }
    await check('[6.1] 61-а заявка от един visitor ID → 429', () => {
      if (limitedStatus !== 429) throw new Error(`Получен ${limitedStatus}, очакван 429`)
    })
  }

  console.log('\n[7] Concurrent duplicate pageViewId')
  {
    const duplicatePayload = payload({ anonymousVisitorId: randomUUID(), pageViewId: randomUUID() })
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => httpJson(port, ENDPOINT, 'POST', {
        ...duplicatePayload,
        path: i % 2 === 0 ? '/lobby' : '/shop',
      }, undefined, { 'X-Forwarded-For': '203.0.113.52' })),
    )
    await check('[7.1] concurrent duplicate има точно един recorded=true', () => {
      const recordedCount = responses.filter((r) => (r.body as { recorded?: boolean }).recorded === true).length
      const duplicateCount = responses.filter((r) => (r.body as { duplicate?: boolean }).duplicate === true).length
      if (recordedCount !== 1 || duplicateCount !== 7) {
        throw new Error(`recorded=${recordedCount} duplicate=${duplicateCount}`)
      }
    })
    const db = getDb(isolated.databaseFile)
    try {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM site_visit_events WHERE page_view_id = ?`).get(duplicatePayload.pageViewId) as { count: number }
      await check('[7.2] concurrent duplicate записва точно един event', () => {
        if (row.count !== 1) throw new Error(`count=${row.count}`)
      })
    } finally {
      db.close()
    }
  }

  console.log('\n[8] Duplicate не променя visitor aggregate')
  {
    const visitorId = randomUUID()
    const pageViewId = randomUUID()
    const first = payload({
      anonymousVisitorId: visitorId,
      pageViewId,
      referrer: 'https://original.example/start',
      utm: { utm_source: 'original-source' },
    })
    await httpJson(port, ENDPOINT, 'POST', first, undefined, { 'X-Forwarded-For': '203.0.113.53' })
    const dbBefore = getDb(isolated.databaseFile)
    const before = dbBefore.prepare(`
      SELECT last_seen_at, last_referrer, last_source
      FROM site_visitors
      WHERE anonymous_visitor_id = ?
    `).get(visitorId) as Record<string, unknown>
    dbBefore.close()
    await sleep(1100)
    const duplicate = payload({
      anonymousVisitorId: visitorId,
      pageViewId,
      path: '/shop',
      referrer: 'https://duplicate-touch.example/changed',
      utm: { utm_source: 'duplicate-source' },
    })
    const r = await httpJson(port, ENDPOINT, 'POST', duplicate, undefined, { 'X-Forwarded-For': '203.0.113.53' })
    const dbAfter = getDb(isolated.databaseFile)
    try {
      const after = dbAfter.prepare(`
        SELECT last_seen_at, last_referrer, last_source
        FROM site_visitors
        WHERE anonymous_visitor_id = ?
      `).get(visitorId) as Record<string, unknown>
      await check('[8.1] duplicate response е clean duplicate', () => {
        const b = r.body as { recorded?: boolean; duplicate?: boolean }
        if (r.status !== 200 || b.recorded !== false || b.duplicate !== true) throw new Error(`${r.status} ${JSON.stringify(b)}`)
      })
      await check('[8.2] duplicate не обновява aggregate', () => {
        if (
          after.last_seen_at !== before.last_seen_at ||
          after.last_referrer !== before.last_referrer ||
          after.last_source !== before.last_source
        ) {
          throw new Error(`before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
        }
      })
    } finally {
      dbAfter.close()
    }
  }

  console.log('\n[9] Internal referrer не презаписва external last-touch')
  {
    const visitorId = randomUUID()
    const first = payload({
      anonymousVisitorId: visitorId,
      referrer: 'https://external.example/a?hidden=1',
      utm: { utm_source: 'external-source' },
    })
    const second = payload({
      anonymousVisitorId: visitorId,
      path: '/shop',
      navigationType: 'spa',
      referrer: `http://127.0.0.1:${port}/lobby?local=1`,
      utm: {},
    })
    await httpJson(port, ENDPOINT, 'POST', first, undefined, { 'X-Forwarded-For': '203.0.113.54' })
    await sleep(1100)
    await httpJson(port, ENDPOINT, 'POST', second, undefined, { 'X-Forwarded-For': '203.0.113.54' })
    const db = getDb(isolated.databaseFile)
    try {
      const visitor = db.prepare(`
        SELECT last_seen_at, last_referrer, last_source
        FROM site_visitors
        WHERE anonymous_visitor_id = ?
      `).get(visitorId) as Record<string, unknown>
      const event = db.prepare(`
        SELECT referrer, source
        FROM site_visit_events
        WHERE page_view_id = ?
      `).get(second.pageViewId) as Record<string, unknown>
      await check('[9.1] event пази internal referrer като navigation info', () => {
        if (event.referrer !== `http://127.0.0.1:${port}/lobby` || event.source !== 'internal') {
          throw new Error(JSON.stringify(event))
        }
      })
      await check('[9.2] aggregate last-touch остава external', () => {
        if (visitor.last_referrer !== 'https://external.example/a' || visitor.last_source !== 'external-source') {
          throw new Error(JSON.stringify(visitor))
        }
      })
    } finally {
      db.close()
    }
  }

  console.log('\n[10] Retention cleanup')
  {
    const oldVisitorId = randomUUID()
    const oldOrphanVisitorId = randomUUID()
    const recentVisitorId = randomUUID()
    const db = getDb(isolated.databaseFile)
    try {
      db.prepare(`
        INSERT INTO site_visitors (anonymous_visitor_id, first_seen_at, last_seen_at, first_source, last_source)
        VALUES (?, datetime('now', '-91 days'), datetime('now', '-91 days'), 'old', 'old')
      `).run(oldVisitorId)
      db.prepare(`
        INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, path, navigation_type, source, occurred_at)
        VALUES (?, ?, '/old', 'navigate', 'old', datetime('now', '-91 days'))
      `).run(randomUUID(), oldVisitorId)
      db.prepare(`
        INSERT INTO site_visitors (anonymous_visitor_id, first_seen_at, last_seen_at, first_source, last_source)
        VALUES (?, datetime('now', '-91 days'), datetime('now', '-91 days'), 'orphan', 'orphan')
      `).run(oldOrphanVisitorId)
      db.prepare(`
        INSERT INTO site_visitors (anonymous_visitor_id, first_seen_at, last_seen_at, first_source, last_source)
        VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'recent', 'recent')
      `).run(recentVisitorId)
    } finally {
      db.close()
    }
    const store = await createSiteVisitStore(isolated.databaseFile)
    try {
      const result = store.purgeOlderThanDays(90)
      await check('[10.1] retention изтрива old event и orphan visitor', () => {
        if (result.deletedEvents < 1 || result.deletedVisitors < 2) throw new Error(JSON.stringify(result))
      })
    } finally {
      store.close()
    }
    const verifyDb = getDb(isolated.databaseFile)
    try {
      const oldEventCount = verifyDb.prepare(`SELECT COUNT(*) AS count FROM site_visit_events WHERE anonymous_visitor_id = ?`).get(oldVisitorId) as { count: number }
      const oldVisitorCount = verifyDb.prepare(`SELECT COUNT(*) AS count FROM site_visitors WHERE anonymous_visitor_id = ?`).get(oldVisitorId) as { count: number }
      const recentVisitorCount = verifyDb.prepare(`SELECT COUNT(*) AS count FROM site_visitors WHERE anonymous_visitor_id = ?`).get(recentVisitorId) as { count: number }
      await check('[10.2] retention оставя recent visitor', () => {
        if (oldEventCount.count !== 0 || oldVisitorCount.count !== 0 || recentVisitorCount.count !== 1) {
          throw new Error(`oldEvents=${oldEventCount.count} oldVisitor=${oldVisitorCount.count} recent=${recentVisitorCount.count}`)
        }
      })
    } finally {
      verifyDb.close()
    }
  }

  console.log('\n[11] Невалидни payload-и')
  const invalidCases: Array<[string, Record<string, unknown>]> = [
    ['invalid anonymousVisitorId', payload({ anonymousVisitorId: 'bad-id' })],
    ['invalid pageViewId', payload({ pageViewId: 'bad-id' })],
    ['external path', payload({ path: 'https://evil.example/lobby' })],
    ['path с query', payload({ path: '/lobby?x=1' })],
    ['invalid navigation type', payload({ navigationType: 'render' })],
    ['client profileId е забранен', payload({ profileId: randomUUID() })],
  ]
  for (const [label, body] of invalidCases) {
    const r = await httpJson(port, ENDPOINT, 'POST', body, undefined, { 'X-Forwarded-For': '203.0.113.55' })
    await check(`[11] ${label} → 400`, () => {
      if (r.status !== 400) throw new Error(`Получен ${r.status}, очакван 400`)
    })
  }

  console.log('\n[12] UTM whitelist и дължини')
  {
    const unknownUtm = await httpJson(port, ENDPOINT, 'POST', payload({ utm: { utm_source: 'ok', utm_bad: 'nope' } }), undefined, { 'X-Forwarded-For': '203.0.113.56' })
    await check('[12.1] unknown UTM field → 400', () => {
      if (unknownUtm.status !== 400) throw new Error(`Получен ${unknownUtm.status}, очакван 400`)
    })

    const longUtm = await httpJson(port, ENDPOINT, 'POST', payload({ utm: { utm_source: 'x'.repeat(65) } }), undefined, { 'X-Forwarded-For': '203.0.113.56' })
    await check('[12.2] прекалено дълъг utm_source → 400', () => {
      if (longUtm.status !== 400) throw new Error(`Получен ${longUtm.status}, очакван 400`)
    })
  }

  console.log('\n[13] First-touch и external last-touch')
  {
    const visitorId = randomUUID()
    const first = payload({
      anonymousVisitorId: visitorId,
      referrer: 'https://first.example/a?hidden=1',
      utm: { utm_source: 'first-source' },
    })
    const last = payload({
      anonymousVisitorId: visitorId,
      path: '/shop',
      navigationType: 'spa',
      referrer: 'https://last.example/b?hidden=2',
      utm: { utm_source: 'last-source' },
    })
    await httpJson(port, ENDPOINT, 'POST', first, undefined, { 'X-Forwarded-For': '203.0.113.57' })
    await sleep(1100)
    await httpJson(port, ENDPOINT, 'POST', last, undefined, { 'X-Forwarded-For': '203.0.113.57' })
    const db = getDb(isolated.databaseFile)
    try {
      const row = db.prepare(`
        SELECT first_referrer, last_referrer, first_source, last_source
        FROM site_visitors
        WHERE anonymous_visitor_id = ?
      `).get(visitorId) as Record<string, unknown> | undefined
      await check('[13.1] first-touch не се презаписва', () => {
        if (row?.first_referrer !== 'https://first.example/a' || row.first_source !== 'first-source') {
          throw new Error(JSON.stringify(row))
        }
      })
      await check('[13.2] external last-touch се обновява', () => {
        if (row?.last_referrer !== 'https://last.example/b' || row.last_source !== 'last-source') {
          throw new Error(JSON.stringify(row))
        }
      })
    } finally {
      db.close()
    }
  }

  console.log('\n[14] Frontend tracker integration')
  {
    const renderSource = await readFile(join(sourceServerRoot, '..', 'src', 'app', 'lobby', 'renderLobbyScreen.ts'), 'utf8')
    const trackerSource = await readFile(join(sourceServerRoot, '..', 'src', 'app', 'visitors', 'createVisitorPageViewTracker.ts'), 'utf8')
    await check('[14.1] render функцията не изпраща visitor tracking', () => {
      if (renderSource.includes('/api/visits/page-view') || renderSource.includes('createVisitorPageViewTracker')) {
        throw new Error('renderLobbyScreen съдържа visitor tracking hook.')
      }
    })
    await check('[14.2] tracker-ът е вързан за initial load, pushState и popstate', () => {
      if (!trackerSource.includes('history.pushState') || !trackerSource.includes('popstate') || !trackerSource.includes('getEntriesByType')) {
        throw new Error('Липсва очакваният navigation hook.')
      }
    })
  }

  console.log('\n[15] Device type recorded on new page-view')
  {
    const mobileUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    const visitorId = randomUUID()
    const r = await httpJson(port, ENDPOINT, 'POST', payload({ anonymousVisitorId: visitorId }), undefined, {
      'X-Forwarded-For': '203.0.113.60',
      'User-Agent': mobileUa,
    })
    await check('[15.1] page-view with iPhone UA → 200 recorded', () => {
      const b = r.body as { ok?: boolean; recorded?: boolean }
      if (r.status !== 200 || b.ok !== true || b.recorded !== true) throw new Error(`${r.status} ${JSON.stringify(b)}`)
    })
    const db = getDb(isolated.databaseFile)
    try {
      const row = db.prepare(`SELECT last_device_type FROM site_visitors WHERE anonymous_visitor_id = ?`).get(visitorId) as { last_device_type: string | null } | undefined
      await check('[15.2] last_device_type = mobile for iPhone UA', () => {
        if (row?.last_device_type !== 'mobile') throw new Error(`last_device_type=${String(row?.last_device_type)}`)
      })
    } finally { db.close() }
  }

  console.log('\n[16] Device type updates when UA changes')
  {
    const desktopUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
    const tabletUa  = 'Mozilla/5.0 (Linux; Android 12; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
    const visitorId = randomUUID()
    // First page-view: desktop
    await httpJson(port, ENDPOINT, 'POST', payload({ anonymousVisitorId: visitorId }), undefined, {
      'X-Forwarded-For': '203.0.113.61',
      'User-Agent': desktopUa,
    })
    const db1 = getDb(isolated.databaseFile)
    const after1 = db1.prepare(`SELECT last_device_type FROM site_visitors WHERE anonymous_visitor_id = ?`).get(visitorId) as { last_device_type: string | null } | undefined
    db1.close()
    await check('[16.1] first visit = desktop', () => {
      if (after1?.last_device_type !== 'desktop') throw new Error(`device=${String(after1?.last_device_type)}`)
    })
    // Second page-view from different device (tablet UA)
    await httpJson(port, ENDPOINT, 'POST', payload({ anonymousVisitorId: visitorId }), undefined, {
      'X-Forwarded-For': '203.0.113.61',
      'User-Agent': tabletUa,
    })
    const db2 = getDb(isolated.databaseFile)
    const after2 = db2.prepare(`SELECT last_device_type FROM site_visitors WHERE anonymous_visitor_id = ?`).get(visitorId) as { last_device_type: string | null } | undefined
    db2.close()
    await check('[16.2] second visit (tablet UA) updates device type to tablet', () => {
      if (after2?.last_device_type !== 'tablet') throw new Error(`device=${String(after2?.last_device_type)}`)
    })
  }

  console.log('\n[17] Duplicate does not change device type')
  {
    const mobileUa  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    const desktopUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
    const visitorId = randomUUID()
    const pageViewId = randomUUID()
    // First page-view: mobile
    await httpJson(port, ENDPOINT, 'POST', payload({ anonymousVisitorId: visitorId, pageViewId }), undefined, {
      'X-Forwarded-For': '203.0.113.62',
      'User-Agent': mobileUa,
    })
    // Duplicate page-view with different (desktop) UA — must NOT update device
    const r = await httpJson(port, ENDPOINT, 'POST', payload({ anonymousVisitorId: visitorId, pageViewId }), undefined, {
      'X-Forwarded-For': '203.0.113.62',
      'User-Agent': desktopUa,
    })
    await check('[17.1] duplicate recognised', () => {
      const b = r.body as { recorded?: boolean; duplicate?: boolean }
      if (r.status !== 200 || b.recorded !== false || b.duplicate !== true) throw new Error(`${r.status} ${JSON.stringify(b)}`)
    })
    const db = getDb(isolated.databaseFile)
    try {
      const row = db.prepare(`SELECT last_device_type FROM site_visitors WHERE anonymous_visitor_id = ?`).get(visitorId) as { last_device_type: string | null } | undefined
      await check('[17.2] device type unchanged after duplicate (still mobile)', () => {
        if (row?.last_device_type !== 'mobile') throw new Error(`last_device_type=${String(row?.last_device_type)}`)
      })
    } finally { db.close() }
  }

  console.log('\n[18] OS type recorded on new page-view')
  {
    const androidUa = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36'
    const visitorId = randomUUID()
    const r = await httpJson(port, ENDPOINT, 'POST', payload({ anonymousVisitorId: visitorId }), undefined, {
      'X-Forwarded-For': '203.0.113.63',
      'User-Agent': androidUa,
    })
    await check('[18.1] page-view with Android UA → 200 recorded', () => {
      const b = r.body as { ok?: boolean; recorded?: boolean }
      if (r.status !== 200 || b.ok !== true || b.recorded !== true) throw new Error(`${r.status} ${JSON.stringify(b)}`)
    })
    const db = getDb(isolated.databaseFile)
    try {
      const row = db.prepare(`SELECT last_os_type FROM site_visitors WHERE anonymous_visitor_id = ?`).get(visitorId) as { last_os_type: string | null } | undefined
      await check('[18.2] last_os_type = android for Android UA', () => {
        if (row?.last_os_type !== 'android') throw new Error(`last_os_type=${String(row?.last_os_type)}`)
      })
    } finally { db.close() }
  }

  console.log('\n[19] OS type updates when UA changes')
  {
    const windowsUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
    const macUa     = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15'
    const visitorId = randomUUID()
    // First page-view: windows
    await httpJson(port, ENDPOINT, 'POST', payload({ anonymousVisitorId: visitorId }), undefined, {
      'X-Forwarded-For': '203.0.113.64',
      'User-Agent': windowsUa,
    })
    const db1 = getDb(isolated.databaseFile)
    const after1 = db1.prepare(`SELECT last_os_type FROM site_visitors WHERE anonymous_visitor_id = ?`).get(visitorId) as { last_os_type: string | null } | undefined
    db1.close()
    await check('[19.1] first visit = windows', () => {
      if (after1?.last_os_type !== 'windows') throw new Error(`os=${String(after1?.last_os_type)}`)
    })
    // Second page-view from a different OS (macOS UA)
    await httpJson(port, ENDPOINT, 'POST', payload({ anonymousVisitorId: visitorId }), undefined, {
      'X-Forwarded-For': '203.0.113.64',
      'User-Agent': macUa,
    })
    const db2 = getDb(isolated.databaseFile)
    const after2 = db2.prepare(`SELECT last_os_type FROM site_visitors WHERE anonymous_visitor_id = ?`).get(visitorId) as { last_os_type: string | null } | undefined
    db2.close()
    await check('[19.2] second visit (macOS UA) updates os type to macos', () => {
      if (after2?.last_os_type !== 'macos') throw new Error(`os=${String(after2?.last_os_type)}`)
    })
  }

  console.log('\n[20] Duplicate does not change OS type')
  {
    const iosUa     = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    const windowsUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
    const visitorId = randomUUID()
    const pageViewId = randomUUID()
    // First page-view: ios
    await httpJson(port, ENDPOINT, 'POST', payload({ anonymousVisitorId: visitorId, pageViewId }), undefined, {
      'X-Forwarded-For': '203.0.113.65',
      'User-Agent': iosUa,
    })
    // Duplicate page-view with different (windows) UA — must NOT update os
    const r = await httpJson(port, ENDPOINT, 'POST', payload({ anonymousVisitorId: visitorId, pageViewId }), undefined, {
      'X-Forwarded-For': '203.0.113.65',
      'User-Agent': windowsUa,
    })
    await check('[20.1] duplicate recognised', () => {
      const b = r.body as { recorded?: boolean; duplicate?: boolean }
      if (r.status !== 200 || b.recorded !== false || b.duplicate !== true) throw new Error(`${r.status} ${JSON.stringify(b)}`)
    })
    const db = getDb(isolated.databaseFile)
    try {
      const row = db.prepare(`SELECT last_os_type FROM site_visitors WHERE anonymous_visitor_id = ?`).get(visitorId) as { last_os_type: string | null } | undefined
      await check('[20.2] os type unchanged after duplicate (still ios)', () => {
        if (row?.last_os_type !== 'ios') throw new Error(`last_os_type=${String(row?.last_os_type)}`)
      })
    } finally { db.close() }
  }
} finally {
  if (server) {
    await stopServer(server)
    if (server.child.exitCode !== 0 && server.child.exitCode !== null) {
      console.error('\n[server output]\n' + server.output())
    }
  }
  await isolated.cleanup()
}

console.log(`\nРезултат: ${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exitCode = 1
}
