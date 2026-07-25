/**
 * checkPlayersPagination.ts
 *
 * HTTP-level интеграционен тест за server-side pagination на страница
 * "Играчи" (GET /api/players?page=&snapshot=), който заменя стария твърд
 * LIMIT 500 (server/src/db/playerProgressStore.ts,
 * listPublicHumanProfilesStatement) с pagination, покриваща ВСИЧКИ
 * допустими профили в базата, плюс замразен (snapshot) глобален ред,
 * стабилен между страници дори при промяна на online статус междувременно.
 *
 * Реален spawn-нат сървър, изолирана SQLite база — profiles се seed-ват
 * директно в базата (WAL-достъпна докато сървърът работи), после се
 * четат само през реалните HTTP заявки, точно както клиентът би ги видял.
 *
 * [1]  Над 500 профила са реално достъпни през pagination traversal-а.
 * [2]  Максимум 300 резултата на страница; последната страница има точния
 *      остатък.
 * [3]  Няма дублирани или пропуснати профили между всички страници.
 * [4]  Правилен ред за обикновен потребител: всички реални играчи преди
 *      всички ботове (в целия traversal, при фиксиран snapshot).
 * [5]  Правилен ред за администратор: собственият профил е ГЛОБАЛНА
 *      позиция 0 (page 1) ВИНАГИ; online реален играч е веднага след own;
 *      own не се дублира в останалите bucket-и; хора преди ботове.
 * [6]  Коректни totalCount/totalPages (self-consistency + сума на страниците).
 * [7]  Невалидни номера на страници (0, отрицателно, нечислово, твърде
 *      голямо) → безопасно clamp-ване в рамките на СЪЩИЯ snapshot, не
 *      400/срив и не нов snapshot.
 * [8]  Snapshot стабилност: същата страница + snapshot token → идентичен
 *      ред при две отделни заявки.
 * [9]  Горна и долна pagination навигация ползват един и същ render/wiring
 *      механизъм (source check — гарантира, че не могат да се разминат).
 * [10] /api/players/search продължава да работи непроменено (regression).
 * [11] Реална промяна online → offline между заявка за страница 1 и
 *      страница 2 (СЪЩИЯ snapshot) не води до дублиран или пропуснат ID —
 *      позицията е замразена, само показвания isOnline статус е "на живо".
 * [12] Изтекъл/невалиден (произволен) snapshot token → сървърът НЕ
 *      преизчислява "страница 2" под същия идентификатор; връща безопасно
 *      page=1 + snapshotReset=true + НОВ snapshot token с пълно покритие.
 * [13] Липсващ (не подаден изобщо) snapshot token за page>1 → третира се
 *      като обикновено прясно отваряне (snapshotReset=false), не като
 *      "възстановяване от грешка".
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, cp, mkdir, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const projectRoot = resolve(serverRoot, '..')

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

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

// ─── [9] Static source check — не изисква сървър ───────────────────────────

console.log('\n=== Players Pagination — source checks ===\n')

await check('[9] Горна и долна навигация ползват един и същ render/wiring механизъм', () => {
  const renderSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8')

  const desktopMatch = renderSrc.match(/function renderPlayersDirectory[\s\S]*?^function /m)
  const desktopSrc = desktopMatch ? desktopMatch[0] : ''
  const desktopPagerCalls = (desktopSrc.match(/renderPlayersPager\(state\)/g) ?? []).length
  assert(desktopPagerCalls === 2, `desktop: очаквани 2 извиквания на renderPlayersPager, намерени ${desktopPagerCalls}`)

  const mobileMatch = renderSrc.match(/function renderMobilePlayersDirectory[\s\S]*?^function /m)
  const mobileSrc = mobileMatch ? mobileMatch[0] : ''
  const mobilePagerCalls = (mobileSrc.match(/renderPlayersPager\(state\)/g) ?? []).length
  assert(mobilePagerCalls === 2, `mobile: очаквани 2 извиквания на renderPlayersPager, намерени ${mobilePagerCalls}`)

  // Едно-единствено click-wiring място за data-lobby-players-page (не дублирана логика).
  const wiringOccurrences = (renderSrc.match(/data-lobby-players-page\]/g) ?? []).length
  assert(wiringOccurrences === 1, `очаквано точно 1 querySelectorAll wiring място, намерени ${wiringOccurrences}`)
})

// ─── DB seed helper ──────────────────────────────────────────────────────────

function insertProfile(
  db: DatabaseSync,
  opts: {
    profileId: string
    displayName: string
    normalizedDisplayName: string
    profileKind?: 'human' | 'bot'
    updatedAt: string
  },
): void {
  const kind = opts.profileKind ?? 'human'
  let accountId: string | null = null
  if (kind === 'human') {
    accountId = `acc-${opts.profileId}`
    db.prepare(`
      INSERT INTO accounts (account_id, email, password_hash, role, status)
      VALUES (?, ?, 'scrypt:aa:bb', 'player', 'active')
    `).run(accountId, `${opts.profileId}@example.test`)
  }

  db.prepare(`
    INSERT INTO profiles (
      profile_id, account_id, profile_kind, username, normalized_username,
      display_name, normalized_display_name, avatar_url,
      level, rank_title, skill_rating, status, is_temporary,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, NULL, NULL,
      ?, ?, NULL,
      1, 'Ранг 1', 1000, 'active', 0,
      ?, ?
    )
  `).run(
    opts.profileId,
    accountId,
    kind,
    opts.displayName,
    opts.normalizedDisplayName,
    opts.updatedAt,
    opts.updatedAt,
  )
}

// ─── HTTP / process harness (established pattern) ──────────────────────────

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'PlayersPaginationCheck1!'
const PAGE_SIZE = 300

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

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>((r) => setTimeout(r, 250))
  }
}

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-players-pagination-http-'))
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

function openAuthenticatedWs(port: number, cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
    const t = setTimeout(() => { ws.terminate(); reject(new Error('WS open timeout')) }, 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (err) => { clearTimeout(t); reject(err) })
  })
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolveClose) => {
    ws.once('close', () => resolveClose())
    ws.close()
    setTimeout(resolveClose, 2000)
  })
}

type PlayersPageResponse = {
  ok: boolean
  players: Array<{ profileId: string; isBot?: boolean; isOnline?: boolean }>
  page: number
  pageSize: number
  totalCount: number
  totalPages: number
  snapshot: string
  snapshotReset: boolean
  message?: string
}

async function fetchPage(port: number, cookie: string, page: number, snapshotToken?: string): Promise<PlayersPageResponse> {
  const params = new URLSearchParams({ page: String(page) })
  if (snapshotToken) params.set('snapshot', snapshotToken)
  const r = await httpGetJson(port, `/api/players?${params.toString()}`, cookie)
  return r.body as PlayersPageResponse
}

async function fetchAllPages(port: number, cookie: string): Promise<{
  pages: PlayersPageResponse[]
  snapshot: string
  totalCount: number
  totalPages: number
}> {
  const first = await fetchPage(port, cookie, 1)
  assert(first.ok === true, `page 1 response ok=false: ${first.message}`)
  const pages = [first]
  for (let p = 2; p <= first.totalPages; p++) {
    const next = await fetchPage(port, cookie, p, first.snapshot)
    assert(next.ok === true, `page ${p} response ok=false: ${next.message}`)
    pages.push(next)
  }
  return { pages, snapshot: first.snapshot, totalCount: first.totalCount, totalPages: first.totalPages }
}

// ─── HTTP тест ────────────────────────────────────────────────────────────────

console.log('\n=== Players Pagination — HTTP level ===\n')

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: ReturnType<typeof startSrv> | null = null
let onlineWs: WebSocket | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitFor('server ready', async () => {
    try {
      const r = await httpGetJson(port, '/health')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
  console.log('  Сървърът е готов.\n')

  // Seed: 700 постоянни допустими профила (350 human + 350 bot) — над 500,
  // за да докаже pagination-ът покрива всичко, не само стария LIMIT 500.
  const db = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  const baseTime = new Date('2026-06-01T00:00:00.000Z').getTime()
  for (let i = 0; i < 700; i++) {
    const kind = i % 2 === 0 ? 'human' : 'bot'
    insertProfile(db, {
      profileId: `bulk-${i}`,
      displayName: `Bulk Player ${i}`,
      normalizedDisplayName: `bulk player ${i}`,
      profileKind: kind,
      updatedAt: new Date(baseTime - i * 1000).toISOString(),
    })
  }
  db.close()

  const runId = `${Date.now()}-${process.pid}`

  // Regular (online) test user.
  const userEmail = `pager-user-${runId}@example.test`
  const regRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userEmail, password: PASSWORD, displayName: 'PagerUser', gender: 'male' }),
  })
  if (regRes.status !== 200) throw new Error(`Register (user) ${regRes.status}`)

  const userLoginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userEmail, password: PASSWORD }),
  })
  const uh = userLoginRes.headers as Headers & { getSetCookie?: () => string[] }
  const userCookie = (uh.getSetCookie?.()[0] ?? userLoginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!userCookie) throw new Error('No Set-Cookie on user login')

  const meRes = await httpGetJson(port, '/api/auth/me', userCookie)
  const pagerUserProfileId = (meRes.body as { session?: { profile?: { profileId?: string } } })
    .session?.profile?.profileId
  if (!pagerUserProfileId) throw new Error('No profileId from /api/auth/me')

  // Отваряме реален WS с тази сесия — маркира PagerUser като online.
  onlineWs = await openAuthenticatedWs(port, userCookie)

  // Admin test user.
  const adminEmail = `pager-admin-${runId}@example.test`
  const adminRegRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: PASSWORD, displayName: 'PagerAdmin', gender: 'male' }),
  })
  if (adminRegRes.status !== 200) throw new Error(`Register (admin) ${adminRegRes.status}`)

  const db2 = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
  db2.prepare(`UPDATE accounts SET role='admin' WHERE email=?`).run(adminEmail)
  db2.close()

  const adminLoginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: PASSWORD }),
  })
  const ah = adminLoginRes.headers as Headers & { getSetCookie?: () => string[] }
  const adminCookie = (ah.getSetCookie?.()[0] ?? adminLoginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!adminCookie) throw new Error('No Set-Cookie on admin login')

  const adminMeRes = await httpGetJson(port, '/api/auth/me', adminCookie)
  const pagerAdminProfileId = (adminMeRes.body as { session?: { profile?: { profileId?: string } } })
    .session?.profile?.profileId
  if (!pagerAdminProfileId) throw new Error('No profileId from admin /api/auth/me')

  // ─── Non-admin traversal (споделен от checks [1]-[4],[6]) ────────────────

  const nonAdminTraversal = await fetchAllPages(port, userCookie)

  await check('[1] Над 500 профила са реално достъпни', () => {
    assert(nonAdminTraversal.totalCount > 500, `totalCount=${nonAdminTraversal.totalCount}, очаквано >500`)
  })

  await check('[2] Максимум 300 на страница; правилна последна страница', () => {
    for (let i = 0; i < nonAdminTraversal.pages.length - 1; i++) {
      const p = nonAdminTraversal.pages[i]!
      assert(p.players.length === PAGE_SIZE, `page ${p.page}: ${p.players.length} играчи, очаквани ${PAGE_SIZE}`)
    }
    const last = nonAdminTraversal.pages.at(-1)!
    const expectedLast = nonAdminTraversal.totalCount - PAGE_SIZE * (nonAdminTraversal.totalPages - 1)
    assert(last.players.length === expectedLast, `последна страница: ${last.players.length}, очаквани ${expectedLast}`)
    assert(last.players.length <= PAGE_SIZE, 'последната страница не трябва да надвишава 300')
  })

  await check('[3] Няма дублирани или пропуснати профили между страниците', () => {
    const allIds = nonAdminTraversal.pages.flatMap((p) => p.players.map((pl) => pl.profileId))
    const uniqueIds = new Set(allIds)
    assert(uniqueIds.size === allIds.length, `намерени дубликати: ${allIds.length - uniqueIds.size}`)
    assert(uniqueIds.size === nonAdminTraversal.totalCount, `union.size=${uniqueIds.size}, totalCount=${nonAdminTraversal.totalCount}`)
  })

  await check('[4] Правилен ред за обикновен потребител: реални играчи → ботове', () => {
    const flat = nonAdminTraversal.pages.flatMap((p) => p.players)
    const lastHumanIdx = flat.reduce((acc, p, i) => (p.isBot !== true ? i : acc), -1)
    const firstBotIdx = flat.findIndex((p) => p.isBot === true)
    assert(firstBotIdx !== -1, 'трябва да има поне един бот в traversal-а')
    assert(lastHumanIdx < firstBotIdx, `последен човек (${lastHumanIdx}) трябва да е преди първия бот (${firstBotIdx})`)
  })

  await check('[6] Коректни totalCount/totalPages', () => {
    const expectedTotalPages = Math.ceil(nonAdminTraversal.totalCount / PAGE_SIZE)
    assert(nonAdminTraversal.totalPages === expectedTotalPages, `totalPages=${nonAdminTraversal.totalPages}, очаквано ${expectedTotalPages}`)
    const sum = nonAdminTraversal.pages.reduce((acc, p) => acc + p.players.length, 0)
    assert(sum === nonAdminTraversal.totalCount, `сума на страниците=${sum}, totalCount=${nonAdminTraversal.totalCount}`)
  })

  // ─── Admin ordering: own винаги глобална позиция 0 ─────────────────────────

  await check('[5] Правилен ред за администратор: own глобално първи, online веднага след own, own без дублиране, хора преди ботове', async () => {
    const adminTraversal = await fetchAllPages(port, adminCookie)
    const flat = adminTraversal.pages.flatMap((p) => p.players)

    assert(adminTraversal.pages[0]!.page === 1, 'own трябва да е на page 1')
    assert(flat[0]?.profileId === pagerAdminProfileId, `очакван own (${pagerAdminProfileId}) на глобална позиция 0, получен ${flat[0]?.profileId}`)
    assert(flat[1]?.profileId === pagerUserProfileId, `очакван online PagerUser веднага след own, получен ${flat[1]?.profileId}`)

    const ownOccurrences = flat.filter((p) => p.profileId === pagerAdminProfileId).length
    assert(ownOccurrences === 1, `own трябва да се среща точно веднъж, срещнат ${ownOccurrences} пъти`)

    const lastHumanIdx = flat.reduce((acc, p, i) => (p.isBot !== true ? i : acc), -1)
    const firstBotIdx = flat.findIndex((p) => p.isBot === true)
    assert(lastHumanIdx < firstBotIdx, `(admin) последен човек (${lastHumanIdx}) трябва да е преди първия бот (${firstBotIdx})`)
  })

  // ─── Invalid page numbers (в рамките на СЪЩИЯ snapshot) ────────────────────

  await check('[7] Невалидни номера на страници → безопасно clamp-ване в рамките на същия snapshot', async () => {
    const snapshotToken = nonAdminTraversal.snapshot

    const zero = await fetchPage(port, userCookie, 0, snapshotToken)
    assert(zero.ok && zero.page === 1, `page=0 → очакван clamp към 1, получен page=${zero.page}`)
    assert(zero.snapshot === snapshotToken, 'page=0 с валиден snapshot не трябва да създава нов snapshot')

    const negative = await httpGetJson(port, `/api/players?page=-5&snapshot=${snapshotToken}`, userCookie)
    assert(negative.status === 200, `page=-5 → очакван 200, получен ${negative.status}`)
    assert((negative.body as PlayersPageResponse).page === 1, 'page=-5 → очакван clamp към 1')

    const nonNumeric = await httpGetJson(port, `/api/players?page=abc&snapshot=${snapshotToken}`, userCookie)
    assert(nonNumeric.status === 200, `page=abc → очакван 200, получен ${nonNumeric.status}`)
    assert((nonNumeric.body as PlayersPageResponse).page === 1, 'page=abc → очакван clamp към 1')

    const tooLarge = await fetchPage(port, userCookie, 999_999, snapshotToken)
    assert(tooLarge.ok && tooLarge.page === nonAdminTraversal.totalPages, `page=999999 → очакван clamp към totalPages (${nonAdminTraversal.totalPages}), получен ${tooLarge.page}`)
  })

  // ─── Snapshot стабилност ──────────────────────────────────────────────────

  await check('[8] Snapshot стабилност: същата страница + token → идентичен ред', async () => {
    const snapshotToken = nonAdminTraversal.snapshot
    const first = await fetchPage(port, userCookie, 2, snapshotToken)
    const second = await fetchPage(port, userCookie, 2, snapshotToken)
    assert(first.ok && second.ok, 'и двете заявки трябва да са ok')
    const firstIds = first.players.map((p) => p.profileId)
    const secondIds = second.players.map((p) => p.profileId)
    assert(JSON.stringify(firstIds) === JSON.stringify(secondIds), 'същия snapshot трябва да дава идентичен ред при две отделни заявки')
  })

  // ─── Search regression ─────────────────────────────────────────────────────

  await check('[10] /api/players/search продължава да работи непроменено', async () => {
    const r = await httpGetJson(port, '/api/players/search?q=Bulk', userCookie)
    assert(r.status === 200, `status=${r.status}`)
    const b = r.body as { ok: boolean; players: unknown[] }
    assert(b.ok === true && Array.isArray(b.players), 'search трябва да върне players масив')
  })

  // ─── [11] Online → offline transition mid-traversal (admin snapshot) ──────

  await check('[11] Промяна online → offline между page заявки (същия snapshot) не дублира/пропуска ID', async () => {
    // Прясно admin зареждане — PagerUser е ощe online в този момент.
    const adminPage1 = await fetchPage(port, adminCookie, 1)
    assert(adminPage1.ok, 'admin page 1 ok=false')
    const snapshotToken = adminPage1.snapshot

    const page1Ids = adminPage1.players.map((p) => p.profileId)
    const pagerUserOnPage1 = adminPage1.players.find((p) => p.profileId === pagerUserProfileId)

    // PagerUser отива offline МЕЖДУ заявките за страница 1 и страница 2.
    if (onlineWs) {
      await closeWs(onlineWs)
      onlineWs = null
    }
    await sleep(200) // даваме на сървъра време да обработи disconnect-а

    const remainingPages: PlayersPageResponse[] = []
    for (let p = 2; p <= adminPage1.totalPages; p++) {
      const next = await fetchPage(port, adminCookie, p, snapshotToken)
      assert(next.ok, `page ${p} ok=false`)
      remainingPages.push(next)
    }

    const allIds = [...page1Ids, ...remainingPages.flatMap((p) => p.players.map((pl) => pl.profileId))]
    const uniqueIds = new Set(allIds)
    assert(uniqueIds.size === allIds.length, `PagerUser online→offline mid-traversal причини дубликат(и): ${allIds.length - uniqueIds.size}`)
    assert(uniqueIds.size === adminPage1.totalCount, `union.size=${uniqueIds.size}, totalCount=${adminPage1.totalCount} — профил е пропуснат`)

    // Ако PagerUser не е бил на page 1 (позицията зависи от bucket-а по
    // време на snapshot creation), поне проверяваме, че се среща точно
    // веднъж в целия traversal (вече потвърдено чрез allIds/uniqueIds по-горе).
    void pagerUserOnPage1
  })

  // ─── [12] Изтекъл/невалиден snapshot token ──────────────────────────────────

  await check('[12] Невалиден snapshot token → безопасен нов snapshot от page 1', async () => {
    const bogus = await fetchPage(port, userCookie, 5, 'this-token-does-not-exist-12345')
    assert(bogus.ok, 'заявка с невалиден snapshot трябва пак да е 200/ok:true')
    assert(bogus.page === 1, `невалиден snapshot → очаквано page=1, получено page=${bogus.page}`)
    assert(bogus.snapshotReset === true, 'невалиден (подаден, но неразпознат) snapshot → snapshotReset трябва да е true')
    assert(bogus.snapshot !== 'this-token-does-not-exist-12345', 'трябва да се върне НОВ snapshot token, различен от невалидния')

    // Новият snapshot трябва да работи пълноценно — цял traversal без дублиране/пропуск.
    const recoveredTraversal = await fetchAllPages(port, userCookie)
    const allIds = recoveredTraversal.pages.flatMap((p) => p.players.map((pl) => pl.profileId))
    assert(new Set(allIds).size === recoveredTraversal.totalCount, 'новият snapshot след recovery трябва да покрива всички профили без дублиране')
  })

  // ─── [13] Липсващ (не подаден) snapshot token за page>1 ───────────────────

  await check('[13] Липсващ (не подаден изобщо) snapshot за page>1 → обикновено прясно отваряне, не "reset"', async () => {
    const r = await fetchPage(port, userCookie, 3) // без snapshot параметър изобщо
    assert(r.ok, 'заявка без snapshot трябва пак да е ok')
    assert(r.page === 1, `без snapshot → очаквано page=1 (винаги старт от начало), получено page=${r.page}`)
    assert(r.snapshotReset === false, 'без подаден изобщо snapshot → snapshotReset трябва да е false (не е "възстановяване от грешка")')
  })
} catch (err) {
  fail('HTTP test error', err)
  if (srv) console.error('\n[server output]\n' + srv.output().slice(-3000))
} finally {
  if (onlineWs) onlineWs.terminate()
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

// ─── Резюме ────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
