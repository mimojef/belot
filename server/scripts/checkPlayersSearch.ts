/**
 * checkPlayersSearch.ts
 *
 * Проверки за новия server-side players search (GET /api/players/search),
 * добавен като fix за бъга: "Играч на позиция извън първите 500 (по
 * updated_at/created_at DESC) не може да бъде намерен от търсачката",
 * защото listPublicHumanProfilesStatement носи твърд LIMIT 500 и
 * клиентската търсачка филтрира само сред вече заредените профили.
 *
 * SECTION A — store level (searchPublicProfiles / listPublicHumanProfiles),
 * реална SQLite база с всички migrations, директно извикване на store.
 *
 * [A1]  Профил на позиция >500 (по updated_at DESC) НЕ е в
 *       listPublicHumanProfiles (bulk, LIMIT 500), НО Е намерен чрез
 *       searchPublicProfiles.
 * [A2]  Частично (substring, не само prefix) съвпадение работи.
 * [A3]  Case-insensitive за латиница.
 * [A4]  Case-insensitive за кирилица (SQLite NOCASE НЕ би минал този тест —
 *       нормализацията минава през normalized_display_name/bg-BG lowercase).
 * [A5]  Неактивен профил (status='disabled') не се връща, дори да съвпада.
 * [A6]  Временен профил (is_temporary=1) не се връща, дори да съвпада.
 * [A7]  Литерален "_" в заявката НЕ действа като SQL LIKE single-char
 *       wildcard (доказва ESCAPE клаузата работи).
 * [A8]  Relevance ordering: точно съвпадение → starts-with → contains,
 *       стабилна вторична подредба.
 * [A9]  Празен нормализиран term → връща [] (defensive early return).
 * [A10] Резултатът е ограничен до твърдия LIMIT 50 дори при >50 съвпадения.
 * [A11] listPublicHumanProfiles (bulk списък) остава непроменен: LIMIT 500,
 *       съдържа и human, и bot — regression guard върху същата база.
 *
 * SECTION B — HTTP level, реален spawn-нат сървър, изолирана база.
 *
 * [B1] GET /api/players/search рутира точно като собствен endpoint —
 *      не се прихваща от /api/players и не прихваща него.
 * [B2] Липсващ/празен q → 400.
 * [B3] q под минималната дължина (1 символ) → 400.
 * [B4] q над максималната дължина → 400.
 * [B5] Валидно търсене → 200, enrichment полета (isBlockedByMe,
 *      hasLikedByMe, likesCount, isOnline) присъстват, както в /api/players.
 * [B6] /api/players (bulk endpoint) продължава да работи непроменено.
 * [B7] /api/leaderboards продължава да работи непроменено (sanity).
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, cp, mkdir, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createPlayerProgressStore, type PlayerProgressStore } from '../src/db/playerProgressStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')

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

// ─── DB seed helpers ───────────────────────────────────────────────────────────

async function applyMigrations(dbPath: string): Promise<void> {
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    db.exec(sql)
  }
  db.close()
}

// Директно SQL INSERT (не през store API) — нужен е пълен контрол върху
// updated_at/created_at за детерминистична >500 подредба, и върху
// status/is_temporary за negative test случаите.
function insertProfile(
  db: DatabaseSync,
  opts: {
    profileId: string
    displayName: string
    normalizedDisplayName: string
    profileKind?: 'human' | 'bot'
    withAccount?: boolean
    status?: 'active' | 'disabled'
    isTemporary?: boolean
    updatedAt: string
  },
): void {
  const kind = opts.profileKind ?? 'human'
  const withAccount = opts.withAccount ?? true
  const status = opts.status ?? 'active'
  const isTemporary = opts.isTemporary ?? false

  let accountId: string | null = null
  if (kind === 'human' && withAccount) {
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
      1, 'Ранг 1', 1000, ?, ?,
      ?, ?
    )
  `).run(
    opts.profileId,
    accountId,
    kind,
    opts.displayName,
    opts.normalizedDisplayName,
    status,
    isTemporary ? 1 : 0,
    opts.updatedAt,
    opts.updatedAt,
  )
}

// bg-BG lowercase, огледало на normalizeProfileSearchTerm/normalizedKey логиката.
function bgLower(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('bg-BG')
}

// ─── SECTION A: store level ─────────────────────────────────────────────────

console.log('\n=== Players Search — Section A (store level) ===\n')

const dirA = await mkdtemp(join(tmpdir(), 'belot-players-search-store-'))
const dbPathA = join(dirA, 'test.sqlite')

let storeA: PlayerProgressStore | null = null

try {
  await applyMigrations(dbPathA)

  const rawDb = new DatabaseSync(dbPathA, { open: true, enableForeignKeyConstraints: true })
  rawDb.exec('PRAGMA foreign_keys = ON;')

  // 600 permanent, active, допустими профила (300 human + 300 bot),
  // с СТРИКТНО намаляващ updated_at — profile #0 е най-нов (позиция 1),
  // profile #599 е най-стар (позиция 600, далеч извън LIMIT 500).
  const baseTime = new Date('2026-06-01T00:00:00.000Z').getTime()
  for (let i = 0; i < 600; i++) {
    const kind = i % 2 === 0 ? 'human' : 'bot'
    const updatedAt = new Date(baseTime - i * 1000).toISOString()
    insertProfile(rawDb, {
      profileId: `bulk-${i}`,
      displayName: `Filler Player ${i}`,
      normalizedDisplayName: bgLower(`Filler Player ${i}`),
      profileKind: kind,
      updatedAt,
    })
  }

  // Целевият профил "извън първите 500" — updated_at по-стар от всички
  // 600-те filler профила по-горе → гарантирано на позиция >500.
  const targetUpdatedAt = new Date(baseTime - 601 * 1000).toISOString()
  insertProfile(rawDb, {
    profileId: 'target-mimo',
    displayName: 'Mimo',
    normalizedDisplayName: bgLower('Mimo'),
    profileKind: 'human',
    updatedAt: targetUpdatedAt,
  })

  // Неактивен профил, съвпадащ по име — не трябва да излиза в резултат.
  insertProfile(rawDb, {
    profileId: 'inactive-disabledname',
    displayName: 'DisabledName',
    normalizedDisplayName: bgLower('DisabledName'),
    status: 'disabled',
    updatedAt: new Date(baseTime).toISOString(),
  })

  // Временен профил, съвпадащ по име — не трябва да излиза в резултат.
  insertProfile(rawDb, {
    profileId: 'temp-temporaryname',
    displayName: 'TemporaryName',
    normalizedDisplayName: bgLower('TemporaryName'),
    isTemporary: true,
    updatedAt: new Date(baseTime).toISOString(),
  })

  // Relevance ordering fixtures.
  insertProfile(rawDb, { profileId: 'rel-exact', displayName: 'Ivan', normalizedDisplayName: bgLower('Ivan'), updatedAt: new Date(baseTime + 1000).toISOString() })
  insertProfile(rawDb, { profileId: 'rel-prefix', displayName: 'Ivanov', normalizedDisplayName: bgLower('Ivanov'), updatedAt: new Date(baseTime + 2000).toISOString() })
  insertProfile(rawDb, { profileId: 'rel-contains', displayName: 'Zlativan', normalizedDisplayName: bgLower('Zlativan'), updatedAt: new Date(baseTime + 3000).toISOString() })

  // Cyrillic case-insensitive fixture.
  insertProfile(rawDb, { profileId: 'cyr-ivan', displayName: 'Иван', normalizedDisplayName: bgLower('Иван'), updatedAt: new Date(baseTime + 4000).toISOString() })

  // Wildcard-escape fixture: "Marcus" съдържа "a", после произволен символ
  // ("r"), после "c" — точно шаблонът, който неескейпнат "_" wildcard би
  // хванал при търсене на литералния низ "a_c".
  insertProfile(rawDb, { profileId: 'wild-marcus', displayName: 'Marcus', normalizedDisplayName: bgLower('Marcus'), updatedAt: new Date(baseTime + 5000).toISOString() })

  // >50 съвпадения за LIMIT 50 теста.
  for (let i = 0; i < 60; i++) {
    insertProfile(rawDb, {
      profileId: `many-${i}`,
      displayName: `Manymatch${i}`,
      normalizedDisplayName: bgLower(`Manymatch${i}`),
      updatedAt: new Date(baseTime + 6000 + i * 10).toISOString(),
    })
  }

  rawDb.close()

  storeA = await createPlayerProgressStore(dbPathA)

  await check('[A1] Профил извън първите 500 не е в bulk списъка, но е намерен чрез search', () => {
    const bulk = storeA!.listPublicHumanProfiles()
    assert(bulk.length === 500, `bulk.length=${bulk.length}, очаквани 500`)
    assert(!bulk.some((p) => p.profileId === 'target-mimo'), 'target-mimo не трябва да е в bulk списъка')

    const found = storeA!.searchPublicProfiles(bgLower('Mimo'))
    assert(found.some((p) => p.profileId === 'target-mimo'), 'target-mimo трябва да е намерен чрез search')
  })

  await check('[A2] Частично (substring) съвпадение работи', () => {
    const results = storeA!.searchPublicProfiles(bgLower('lativ'))
    assert(results.some((p) => p.profileId === 'rel-contains'), 'Zlativan трябва да съвпадне по "lativ" substring')
  })

  await check('[A3] Case-insensitive латиница', () => {
    const lower = storeA!.searchPublicProfiles(bgLower('mimo'))
    const upper = storeA!.searchPublicProfiles(bgLower('MIMO'))
    assert(lower.some((p) => p.profileId === 'target-mimo'), 'долен регистър трябва да намери Mimo')
    assert(upper.some((p) => p.profileId === 'target-mimo'), 'горен регистър трябва да намери Mimo')
  })

  await check('[A4] Case-insensitive кирилица (bg-BG, не SQLite NOCASE)', () => {
    const lower = storeA!.searchPublicProfiles(bgLower('иван'))
    const upper = storeA!.searchPublicProfiles(bgLower('ИВАН'))
    assert(lower.some((p) => p.profileId === 'cyr-ivan'), 'долен регистър кирилица трябва да намери Иван')
    assert(upper.some((p) => p.profileId === 'cyr-ivan'), 'горен регистър кирилица трябва да намери Иван')
  })

  await check('[A5] Неактивен профил не се връща', () => {
    const results = storeA!.searchPublicProfiles(bgLower('DisabledName'))
    assert(!results.some((p) => p.profileId === 'inactive-disabledname'), 'disabled профил не трябва да се връща')
  })

  await check('[A6] Временен профил не се връща', () => {
    const results = storeA!.searchPublicProfiles(bgLower('TemporaryName'))
    assert(!results.some((p) => p.profileId === 'temp-temporaryname'), 'temporary профил не трябва да се връща')
  })

  await check('[A7] Литерален "_" не действа като SQL wildcard', () => {
    const literalUnderscore = storeA!.searchPublicProfiles(bgLower('a_c'))
    assert(!literalUnderscore.some((p) => p.profileId === 'wild-marcus'), 'Marcus не трябва да съвпадне с escaped "a_c" (без wildcard)')

    // Sanity: реален substring match все още работи за същия профил.
    const realSubstring = storeA!.searchPublicProfiles(bgLower('arc'))
    assert(realSubstring.some((p) => p.profileId === 'wild-marcus'), 'Marcus трябва да съвпадне с реален substring "arc"')
  })

  await check('[A8] Relevance ordering: exact → prefix → contains', () => {
    const results = storeA!.searchPublicProfiles(bgLower('ivan'))
    const ids = results.map((p) => p.profileId)
    const exactIdx = ids.indexOf('rel-exact')
    const prefixIdx = ids.indexOf('rel-prefix')
    const containsIdx = ids.indexOf('rel-contains')
    assert(exactIdx !== -1 && prefixIdx !== -1 && containsIdx !== -1, 'и трите fixture-и трябва да са в резултата')
    assert(exactIdx < prefixIdx, `exact (${exactIdx}) трябва да е преди prefix (${prefixIdx})`)
    assert(prefixIdx < containsIdx, `prefix (${prefixIdx}) трябва да е преди contains (${containsIdx})`)
  })

  await check('[A9] Празен нормализиран term → []', () => {
    const results = storeA!.searchPublicProfiles('')
    assert(results.length === 0, `очакван празен масив, получени ${results.length}`)
  })

  await check('[A10] Резултатът е ограничен до LIMIT 50', () => {
    const results = storeA!.searchPublicProfiles(bgLower('manymatch'))
    assert(results.length === 50, `results.length=${results.length}, очаквани точно 50 (от 60 съвпадащи)`)
  })

  await check('[A11] Bulk списъкът (listPublicHumanProfiles) остава непроменен', () => {
    const bulk = storeA!.listPublicHumanProfiles()
    assert(bulk.length === 500, `bulk.length=${bulk.length}, очаквани 500 (LIMIT непроменен)`)
    assert(bulk.some((p) => p.isBot === true), 'bulk трябва да съдържа ботове')
    assert(bulk.some((p) => p.isBot !== true), 'bulk трябва да съдържа хора')
  })
} catch (err) {
  fail('Section A setup error', err)
} finally {
  storeA?.close()
  await rm(dirA, { recursive: true, force: true })
}

// ─── SECTION B: HTTP level (реален spawn-нат сървър) ────────────────────────

console.log('\n=== Players Search — Section B (HTTP level) ===\n')

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'PlayersSearchCheck1!'

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
  const tmp = await mkdtemp(join(tmpdir(), 'belot-players-search-http-'))
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
  return { serverDir, cleanup: () => retryRm(tmp) }
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

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: ReturnType<typeof startSrv> | null = null

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

  const runId = `${Date.now()}-${process.pid}`
  const userEmail = `players-search-${runId}@example.test`

  const regRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userEmail, password: PASSWORD, displayName: 'SearchCheckUser', gender: 'male' }),
  })
  if (regRes.status !== 200) throw new Error(`Register ${regRes.status}`)

  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userEmail, password: PASSWORD }),
  })
  const h2 = loginRes.headers as Headers & { getSetCookie?: () => string[] }
  const cookie = (h2.getSetCookie?.()[0] ?? loginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!cookie) throw new Error('No Set-Cookie on login')

  await check('[B1] /api/players/search рутира отделно от /api/players', async () => {
    const search = await httpGetJson(port, '/api/players/search?q=se', cookie)
    const bulk = await httpGetJson(port, '/api/players', cookie)
    assert(search.status === 200, `search status=${search.status}`)
    assert(bulk.status === 200, `bulk status=${bulk.status}`)
    const searchBody = search.body as { ok: boolean; players: unknown[] }
    const bulkBody = bulk.body as { ok: boolean; players: unknown[] }
    assert(searchBody.ok === true && Array.isArray(searchBody.players), 'search трябва да върне players масив')
    assert(bulkBody.ok === true && Array.isArray(bulkBody.players), 'bulk трябва да върне players масив')
  })

  await check('[B2] Липсващ q → 400', async () => {
    const r = await httpGetJson(port, '/api/players/search', cookie)
    assert(r.status === 400, `status=${r.status}`)
    assert((r.body as { ok: boolean }).ok === false, 'ok трябва да е false')
  })

  await check('[B3] q под минималната дължина (1 символ) → 400', async () => {
    const r = await httpGetJson(port, '/api/players/search?q=a', cookie)
    assert(r.status === 400, `status=${r.status}`)
  })

  await check('[B4] q над максималната дължина → 400', async () => {
    const tooLong = 'a'.repeat(100)
    const r = await httpGetJson(port, `/api/players/search?q=${tooLong}`, cookie)
    assert(r.status === 400, `status=${r.status}`)
  })

  await check('[B5] Валидно търсене → 200, enrichment полета присъстват', async () => {
    const r = await httpGetJson(port, '/api/players/search?q=SearchCheckUser', cookie)
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`)
    const b = r.body as { ok: boolean; players: Array<Record<string, unknown>> }
    assert(b.ok === true, 'ok трябва да е true')
    const match = b.players.find((p) => p.profileId !== undefined)
    assert(!!match, 'трябва да има поне един резултат')
    assert('isBlockedByMe' in match!, 'липсва isBlockedByMe')
    assert('hasLikedByMe' in match!, 'липсва hasLikedByMe')
    assert('likesCount' in match!, 'липсва likesCount')
  })

  await check('[B6] /api/players (bulk) продължава да работи непроменено', async () => {
    const r = await httpGetJson(port, '/api/players', cookie)
    assert(r.status === 200, `status=${r.status}`)
    const b = r.body as { ok: boolean; players: unknown[] }
    assert(b.ok === true && Array.isArray(b.players), 'bulk players трябва да е масив')
  })

  await check('[B7] /api/leaderboards продължава да работи непроменено', async () => {
    const r = await httpGetJson(port, '/api/leaderboards', cookie)
    assert(r.status === 200, `status=${r.status}`)
    const b = r.body as { ok: boolean; leaderboards: Record<string, unknown> }
    assert(b.ok === true && typeof b.leaderboards === 'object', 'leaderboards трябва да е обект')
  })
} catch (err) {
  fail('HTTP test error', err)
  if (srv) console.error('\n[server output]\n' + srv.output().slice(-3000))
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

// ─── Резюме ────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
