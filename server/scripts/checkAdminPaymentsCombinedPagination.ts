/**
 * checkAdminPaymentsCombinedPagination.ts
 *
 * Focused regression test за global top-N pagination correctness на
 * GET /api/admin/payments, след като покрит бъде coin_purchase_ledger +
 * vip_purchase_ledger combined listing (виж checkAdminPaymentsVipAggregation.ts
 * за store-level aggregation checks). Проблем, който този тест доказва:
 *
 * Наивна стратегия "coin SQL page N + всички VIP редове, merge, sort,
 * re-slice" би fetch-вала coin's СОБСТВЕН SQL LIMIT/OFFSET page — ако VIP
 * редове interleave-ват сред първите N резултата по credited_at DESC,
 * coin's "page 1" (offset=0, limit=N) вече не съвпада с combined page 1
 * (защото няколко от нейните редове биват изместени от по-нови VIP редове),
 * а combined page 2 продължава от coin SQL offset=N — изместените coin
 * редове изчезват безследно (нито се появяват на page 1, нито на page 2).
 *
 * Fix стратегия (server/src/index.ts handleAdminPaymentsListRequest): за
 * combined offset+limit заявка, взимаме от ВСЕКИ source top-(offset+limit)
 * редове (започвайки от 0, не от заявения offset), merge, sort по
 * credited_at DESC, после slice(offset, offset+limit) върху combined
 * резултата. HTTP-level тест (реален сървър process, реална SQLite база) —
 * store-level unit тест не може да exercise-не handler-а directно.
 *
 * [1] Seed 6 coin + 4 VIP покупки с interleaved credited_at timestamps
 *       (по-нови VIP редове изместват по-стари coin редове в top-N)
 * [2] page 1 (limit=5, offset=0) + page 2 (limit=5, offset=5) заедно
 *       съдържат ТОЧНО 10-те seed-нати purchaseId, без пропуски/дубликати
 * [3] Global order по credited_at DESC е правилен през границата на
 *       page 1/page 2 (последният ред на page 1 е >= първия ред на page 2)
 * [4] pagination.total на всяка страница е 10 (coin.total=6 + vip.total=4),
 *       не само coin count-а
 * [5] summary.totalsByCurrency е сумата на ВСИЧКИ 10 покупки (coin+VIP),
 *       еднаква стойност на двете страници (whole-period summary)
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'AdminPaymentsPagCheck1!'

function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') { srv.close(() => reject(new Error('No free port'))); return }
      const { port } = addr
      srv.close(() => resolvePromise(port))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(label: string, pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

const sourceRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
    ?? process.cwd(),
)
console.log(`  Server root: ${sourceRoot}`)

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>((r) => setTimeout(r, 250))
  }
}

async function makeIsolated(root: string): Promise<{ serverDir: string; cleanup: () => Promise<void> }> {
  const { existsSync } = await import('node:fs')
  const isServerDir = existsSync(join(root, 'src', 'index.ts'))
  const serverSrc = isServerDir ? root : join(root, 'server')

  const tmp = await mkdtemp(join(tmpdir(), 'belot-admin-payments-pagination-'))
  const serverDir = join(tmp, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(serverSrc, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(serverSrc, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(serverSrc, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(serverSrc, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const lt = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(serverSrc, 'node_modules'), join(serverDir, 'node_modules'), lt)
  await symlink(join(serverSrc, '..', 'node_modules'), join(tmp, 'node_modules'), lt)
  return {
    serverDir,
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
      env: {
        ...process.env,
        PORT: String(port),
        BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
        BELOT_GAME_WORKER_COUNT: '1',
        STRIPE_SECRET_KEY: '',
        STRIPE_WEBHOOK_SECRET: '',
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

async function stopSrv(s: { child: ChildProcessWithoutNullStreams }): Promise<void> {
  if (s.child.exitCode !== null) return
  s.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { s.child.kill('SIGKILL'); r() }, 10_000)
    s.child.once('exit', () => { clearTimeout(t); r() })
  })
}

type HttpResult = { status: number; body: Record<string, unknown> }

async function httpJson(
  port: number,
  method: string,
  pathname: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  let body: Record<string, unknown> = {}
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    // no body / non-JSON
  }
  return { status: response.status, body }
}

const iso = await makeIsolated(sourceRoot)
const port = await getFreePort()
let srv: ReturnType<typeof startSrv> | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitFor('server ready', async () => {
    try {
      const r = await httpJson(port, 'GET', '/health')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`
  const adminEmail = `admin-pag-${runId}@example.test`
  const playerEmail = `player-pag-${runId}@example.test`

  const regAdmin = await httpJson(port, 'POST', '/api/auth/register', {
    body: { email: adminEmail, password: PASSWORD, displayName: 'PagAdmin', gender: 'male' },
  })
  assert(regAdmin.status === 200, `admin register status=${regAdmin.status}`)
  const regPlayer = await httpJson(port, 'POST', '/api/auth/register', {
    body: { email: playerEmail, password: PASSWORD, displayName: 'PagPlayer', gender: 'male' },
  })
  assert(regPlayer.status === 200, `player register status=${regPlayer.status}`)

  const dbFile = join(iso.serverDir, 'database', 'data', 'belot-v2.sqlite')
  const db = new DatabaseSync(dbFile)
  db.prepare(`UPDATE accounts SET role='admin' WHERE email=?`).run(adminEmail)
  const playerProfileId = (
    db.prepare(`SELECT p.profile_id FROM profiles p JOIN accounts a ON a.account_id = p.account_id WHERE a.email = ?`).get(playerEmail) as { profile_id: string }
  ).profile_id

  async function loginAndGetCookie(email: string): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
    const h = response.headers as Headers & { getSetCookie?: () => string[] }
    const cookie = (h.getSetCookie?.()[0] ?? response.headers.get('set-cookie'))?.split(';')[0]
    if (!cookie) throw new Error(`No Set-Cookie on login for ${email}`)
    return cookie
  }

  const adminCookie = await loginAndGetCookie(adminEmail)

  // ─── [1] Seed: 6 coin + 4 VIP покупки, interleaved credited_at timestamps ──
  // baseMinute=0 е най-новото (credited_at="сега"), по-голям minute offset = по-старо.
  // Подредба по новина (0=newest .. 9=oldest), редуваме coin/VIP нарочно
  // около top-5 границата (page 1 vs page 2), за да гарантираме interleaving.
  const baseNow = Date.now()
  function creditedAtMinutesAgo(minutesAgo: number): string {
    return new Date(baseNow - minutesAgo * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  }

  type SeedSpec = { kind: 'coin' | 'vip'; minutesAgo: number; priceCents: number }
  // Нарочна редица: VIP редове на позиции 1,3,6,8 (0-indexed по новина)
  // измества coin редове около page 1/page 2 границата (top-5).
  const seedSpecs: SeedSpec[] = [
    { kind: 'coin', minutesAgo: 0, priceCents: 100 },   // 0 (newest)
    { kind: 'vip',  minutesAgo: 1, priceCents: 789 },   // 1
    { kind: 'coin', minutesAgo: 2, priceCents: 200 },   // 2
    { kind: 'vip',  minutesAgo: 3, priceCents: 3989 },  // 3
    { kind: 'coin', minutesAgo: 4, priceCents: 300 },   // 4 <- last row of page 1 (offset=0,limit=5)
    { kind: 'coin', minutesAgo: 5, priceCents: 400 },   // 5 <- first row of page 2 (offset=5,limit=5)
    { kind: 'vip',  minutesAgo: 6, priceCents: 6989 },  // 6
    { kind: 'coin', minutesAgo: 7, priceCents: 500 },   // 7
    { kind: 'vip',  minutesAgo: 8, priceCents: 789 },   // 8
    { kind: 'coin', minutesAgo: 9, priceCents: 600 },   // 9 (oldest)
  ]

  const seededIds: string[] = []
  let expectedTotalCents = 0
  const vipPackageForCents = (cents: number): 'vip_30' | 'vip_180' | 'vip_365' =>
    cents === 789 ? 'vip_30' : cents === 3989 ? 'vip_180' : 'vip_365'

  await check('[1] Seed 6 coin + 4 VIP покупки с interleaved credited_at timestamps', () => {
    for (const spec of seedSpecs) {
      const id = randomUUID()
      const ts = creditedAtMinutesAgo(spec.minutesAgo)
      if (spec.kind === 'coin') {
        db.prepare(`
          INSERT INTO coin_purchase_ledger (
            purchase_id, profile_id, package_key_snapshot, title_snapshot,
            yellow_coins_amount, price_cents, currency, provider, status,
            credited_at, created_at, updated_at
          ) VALUES (?, ?, 'starter', 'Starter Pack', 100, ?, 'EUR', 'stripe', 'paid', ?, ?, ?);
        `).run(id, playerProfileId, spec.priceCents, ts, ts, ts)
      } else {
        db.prepare(`
          INSERT INTO vip_purchase_ledger (
            purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot,
            currency, provider, status, created_at, updated_at, credited_at
          ) VALUES (?, ?, ?, 30, ?, 'EUR', 'stripe', 'paid', ?, ?, ?);
        `).run(id, playerProfileId, vipPackageForCents(spec.priceCents), spec.priceCents, ts, ts, ts)
      }
      seededIds.push(id)
      expectedTotalCents += spec.priceCents
    }
    assertEqual(seededIds.length, 10, 'sanity: 10 seed-нати покупки')
  })

  let page1Ids: string[] = []
  let page2Ids: string[] = []
  let page1LastCreditedAt = ''
  let page2FirstCreditedAt = ''

  await check('[2] page1 (limit=5,offset=0) + page2 (limit=5,offset=5) заедно съдържат ТОЧНО 10-те seed-нати purchaseId, без пропуски/дубликати', async () => {
    const r1 = await httpJson(port, 'GET', '/api/admin/payments?period=allTime&limit=5&offset=0', { cookie: adminCookie })
    assertEqual(r1.status, 200, 'page1 status')
    const p1 = r1.body.purchases as Array<{ purchaseId: string; creditedAt: string | null; source: string }>
    assertEqual(p1.length, 5, 'page1 трябва да съдържа точно 5 реда')
    page1Ids = p1.map(r => r.purchaseId)
    page1LastCreditedAt = p1[p1.length - 1]!.creditedAt ?? ''

    const r2 = await httpJson(port, 'GET', '/api/admin/payments?period=allTime&limit=5&offset=5', { cookie: adminCookie })
    assertEqual(r2.status, 200, 'page2 status')
    const p2 = r2.body.purchases as Array<{ purchaseId: string; creditedAt: string | null; source: string }>
    assertEqual(p2.length, 5, 'page2 трябва да съдържа точно 5 реда')
    page2Ids = p2.map(r => r.purchaseId)
    page2FirstCreditedAt = p2[0]!.creditedAt ?? ''

    const combinedIds = [...page1Ids, ...page2Ids]
    const uniqueIds = new Set(combinedIds)
    assertEqual(uniqueIds.size, 10, `трябва да има точно 10 уникални purchaseId в двете страници заедно, получих ${uniqueIds.size}: ${JSON.stringify(combinedIds)}`)

    for (const seededId of seededIds) {
      assert(uniqueIds.has(seededId), `seed-натата покупка ${seededId} трябва да присъства в page1 ИЛИ page2 (не изгубена)`)
    }

    // Потвърждава, че VIP редовете реално изместиха coin редове (interleaving
    // действително се случи, не тривиален сценарий).
    const p1Sources = p1.map(r => r.source)
    assert(p1Sources.includes('vip') && p1Sources.includes('coin'), 'page1 трябва да съдържа И coin, И VIP редове (доказва interleaving-а от seed данните)')
  })

  await check('[3] Global order по credited_at DESC е правилен през границата page1/page2 (последен ред на page1 >= първи ред на page2)', () => {
    assert(page1LastCreditedAt !== '', 'page1LastCreditedAt трябва да е populated от check [2]')
    assert(page2FirstCreditedAt !== '', 'page2FirstCreditedAt трябва да е populated от check [2]')
    const lastP1 = Date.parse(page1LastCreditedAt)
    const firstP2 = Date.parse(page2FirstCreditedAt)
    assert(lastP1 >= firstP2, `последният ред на page1 (${page1LastCreditedAt}) трябва да е >= първия ред на page2 (${page2FirstCreditedAt}) — global DESC order`)
  })

  await check('[4] pagination.total на всяка страница е 10 (coin.total=6 + vip.total=4), не само coin count', async () => {
    const r1 = await httpJson(port, 'GET', '/api/admin/payments?period=allTime&limit=5&offset=0', { cookie: adminCookie })
    const pagination1 = r1.body.pagination as { total: number; hasMore: boolean }
    assertEqual(pagination1.total, 10, 'page1 pagination.total трябва да е 10 (combined coin+VIP)')
    assertEqual(pagination1.hasMore, true, 'page1 hasMore трябва да е true (има page2)')

    const r2 = await httpJson(port, 'GET', '/api/admin/payments?period=allTime&limit=5&offset=5', { cookie: adminCookie })
    const pagination2 = r2.body.pagination as { total: number; hasMore: boolean }
    assertEqual(pagination2.total, 10, 'page2 pagination.total трябва да е 10 (СЪЩИЯТ whole-period total, не различен)')
    assertEqual(pagination2.hasMore, false, 'page2 hasMore трябва да е false (последна страница)')
  })

  await check('[5] summary.totalsByCurrency е сумата на ВСИЧКИ 10 покупки (coin+VIP), еднаква стойност на двете страници', async () => {
    const r1 = await httpJson(port, 'GET', '/api/admin/payments?period=allTime&limit=5&offset=0', { cookie: adminCookie })
    const summary1 = (r1.body.summary as { totalsByCurrency: Record<string, number> }).totalsByCurrency
    assertEqual(summary1.EUR, expectedTotalCents, `page1 EUR total трябва да е ${expectedTotalCents} (сума на всички 10 покупки)`)

    const r2 = await httpJson(port, 'GET', '/api/admin/payments?period=allTime&limit=5&offset=5', { cookie: adminCookie })
    const summary2 = (r2.body.summary as { totalsByCurrency: Record<string, number> }).totalsByCurrency
    assertEqual(summary2.EUR, expectedTotalCents, 'page2 EUR total трябва да е СЪЩИЯТ whole-period total като page1')
  })

  db.close()
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
