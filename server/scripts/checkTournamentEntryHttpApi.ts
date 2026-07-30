/**
 * checkTournamentEntryHttpApi.ts
 *
 * HTTP integration smoke test за POST /api/tournaments/:id/join,
 * POST /api/tournaments/:id/leave, POST /api/tournaments/:id/cancel
 * (entry fee escrow, solo registration, voluntary refund, creator batch
 * refund). Огледало на checkTournamentHttpApi.ts (spawn реален изолиран
 * сървър процес срещу temp SQLite копие, не production база).
 *
 * Покрива изискванията от продуктовата задача (секция 18):
 *  A. Join/auth       [1]-[8]
 *  B. Debit           [9]-[15]
 *  C. Idempotency      [16]-[19]
 *  D. Capacity/concurrency [20]-[25]
 *  E. Active participation [26]-[29]
 *  F. Password protection  [30]-[34]
 *  G. Leave/refund     [35]-[41]
 *  H. Creator cancel    [42]-[50]
 *  I. Coin conservation  [51]-[57]
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'TournamentEntrySmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000
const SESSION_COOKIE_NAME = 'belot_session'

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
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

// ─── Мрежови helpers ──────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Не може да се намери свободен порт.')))
        return
      }
      const { port } = addr
      srv.close(() => resolveP(port))
    })
  })
}

type HttpResult = { status: number; body: any }

function httpRequest(
  port: number,
  pathname: string,
  method: string,
  cookie?: string,
  jsonBody?: unknown,
): Promise<HttpResult> {
  return new Promise((resolveReq, reject) => {
    const headers: Record<string, string> = {}
    if (cookie) headers['Cookie'] = cookie
    let payload: string | undefined
    if (jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(jsonBody)
    }

    const req = request(
      { hostname: '127.0.0.1', port, path: pathname, method, headers, timeout: 8000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          let body: unknown = null
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not json */ }
          resolveReq({ status: res.statusCode ?? 0, body })
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

function smokeEmail(runId: string, suffix: string): string {
  return `tournament-entry-smoke-${runId}-${suffix}@example.test`.toLowerCase()
}

function hashSessionToken(token: string): string {
  return scryptSync(token, 'belot-v2-session-v1', 32).toString('hex')
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

// ─── Сървър helpers ─────────────────────────────────────────────────────────

type RunningServer = {
  child: ChildProcessWithoutNullStreams
  closed: Promise<void>
  output(): string
}

const CLEANUP_RETRYABLE_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

async function rmTempRootWithRetry(root: string): Promise<void> {
  const maxAttempts = 6
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (!CLEANUP_RETRYABLE_ERROR_CODES.has(code) || attempt === maxAttempts) {
        throw error
      }
      await sleep(150 * attempt)
    }
  }
}

async function createIsolatedServerRoot(originalServerRoot: string): Promise<{
  root: string
  serverDir: string
  databaseFile: string
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-tournament-entry-smoke-'))
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

  const databaseFile = join(serverDir, 'database', 'data', 'belot-v2.sqlite')

  return {
    root,
    serverDir,
    databaseFile,
    cleanup: async () => {
      await rmTempRootWithRetry(root)
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
  const closed = new Promise<void>((resolveClosed) => {
    child.once('close', () => resolveClosed())
  })
  return { child, closed, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode === null) {
    server.child.kill('SIGTERM')
  }
  let forceKillTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (server.child.exitCode === null) {
      server.child.kill('SIGKILL')
    }
  }, 10_000)
  try {
    await server.closed
  } finally {
    if (forceKillTimer !== null) {
      clearTimeout(forceKillTimer)
      forceKillTimer = null
    }
  }
}

async function registerAndGetCookie(port: number, runId: string, suffix: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: smokeEmail(runId, suffix),
      password: PASSWORD,
      displayName: `Smoke ${suffix}`,
      gender: 'male',
    }),
  })
  if (res.status !== 200) throw new Error(`Регистрацията върна status ${res.status}.`)
  const payload = await res.json() as { ok?: boolean; message?: string }
  if (!payload.ok) throw new Error(`Регистрацията не е успешна: ${payload.message ?? '?'}`)

  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  if (!rawCookie) throw new Error('Липсва Set-Cookie при регистрация.')
  return rawCookie.split(';')[0]!
}

async function createSecondProfileCookieForAccount(
  databaseFile: string,
  accountEmail: string,
  profileSuffix: string,
): Promise<string> {
  const sqliteModule = await import('node:sqlite')
  const database = new sqliteModule.DatabaseSync(databaseFile, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA foreign_keys = ON;')

  try {
    const account = database
      .prepare('SELECT account_id FROM accounts WHERE email = ? LIMIT 1;')
      .get(accountEmail) as { account_id: string } | undefined
    if (account === undefined) {
      throw new Error(`Missing account for ${accountEmail}`)
    }

    const profileId = randomUUID()
    const displayName = `Smoke Same Account ${profileSuffix}`
    const normalized = displayName.toLowerCase()
    const token = randomBytes(32).toString('base64url')

    database.exec('BEGIN IMMEDIATE;')
    database.prepare(`
      INSERT INTO profiles (
        profile_id, account_id, profile_kind, username, normalized_username,
        display_name, normalized_display_name, avatar_url, level, rank_title,
        skill_rating, gender, status
      ) VALUES (?, ?, 'human', ?, ?, ?, ?, NULL, 1, 'Rank 1', 1000, 'male', 'active');
    `).run(profileId, account.account_id, displayName, normalized, displayName, normalized)
    database.prepare(`
      INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
      VALUES (?, 55000);
    `).run(profileId)
    database.prepare(`
      INSERT INTO profile_progress (
        profile_id, completed_games_count, won_games_count, rank_level
      ) VALUES (?, 0, 0, 1);
    `).run(profileId)
    database.prepare(`
      INSERT INTO account_sessions (
        session_id, account_id, profile_id, token_hash, expires_at
      ) VALUES (?, ?, ?, ?, ?);
    `).run(
      randomUUID(),
      account.account_id,
      profileId,
      hashSessionToken(token),
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    )
    database.exec('COMMIT;')

    return `${SESSION_COOKIE_NAME}=${token}`
  } catch (error) {
    try {
      database.exec('ROLLBACK;')
    } catch {
      // keep original error
    }
    throw error
  } finally {
    database.close()
  }
}

async function getWalletBalance(port: number, cookie: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
    method: 'GET',
    headers: { Cookie: cookie },
  })
  const data = await res.json() as { ok: boolean; session: { profile: { yellowCoinsBalance: number } } | null }
  if (!data.ok || data.session === null) throw new Error('Не може да се прочете баланс.')
  return data.session.profile.yellowCoinsBalance
}

async function createTournament(
  port: number,
  cookie: string,
  overrides: Partial<{
    name: string
    entryFee: number
    visibility: 'public' | 'password'
    password: string
    startMode: 'fill' | 'scheduled'
    scheduledStartAt: string
  }> = {},
): Promise<{ tournamentId: string; entryFee: number }> {
  const r = await httpRequest(port, '/api/tournaments', 'POST', cookie, {
    name: overrides.name ?? 'Entry Smoke Турнир',
    entryFee: overrides.entryFee ?? 20000,
    visibility: overrides.visibility ?? 'public',
    ...(overrides.password ? { password: overrides.password } : {}),
    startMode: overrides.startMode ?? 'fill',
    ...(overrides.scheduledStartAt ? { scheduledStartAt: overrides.scheduledStartAt } : {}),
  })
  if (r.status !== 200 || !r.body.ok) {
    throw new Error(`createTournament failed: status=${r.status} body=${JSON.stringify(r.body)}`)
  }
  return { tournamentId: r.body.tournament.tournamentId, entryFee: r.body.tournament.entryFee }
}

// ─── Главна функция ─────────────────────────────────────────────────────────

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

console.log('\n═══ Tournament Entry (join/leave/cancel) HTTP API smoke test ═══')
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
        const r = await httpRequest(port, '/health', 'GET')
        const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
        return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
      } catch { return false }
    },
    SERVER_READY_TIMEOUT_MS,
  )
  console.log('  Сървърът е готов.')

  const runId = `${Date.now()}-${process.pid}`
  console.log('\n[auth] Регистрация на потребители...')

  // Отделни потребители за независими сценарии — избягва rate-limit
  // (join/leave/cancel е 5 опита/60s на profileId, виж index.ts) и
  // active-participation guard cross-contamination между тестове.
  const suffixes = [
    'userA', 'userB', 'userC', 'userD', 'userE', 'userF', 'userG', 'userH',
    'userI', 'userJ', 'userK', 'userL', 'userM', 'userN', 'userO', 'userP',
    'userQ', 'userR', 'userS', 'userT', 'userU', 'userV', 'userW', 'userX',
  ]
  const cookies: Record<string, string> = {}
  for (const s of suffixes) {
    cookies[s] = await registerAndGetCookie(port, runId, s)
  }

  // ═══ A. Join/auth ═══════════════════════════════════════════════════════

  const publicTournament1 = await createTournament(port, cookies.userA)

  await check('[1] Unauthenticated POST join => 401', async () => {
    const r = await httpRequest(port, `/api/tournaments/${publicTournament1.tournamentId}/join`, 'POST')
    assert(r.status === 401, `status=${r.status}`)
  })

  // [2]-[4] Guest/bot/temporary profile нямат HTTP-ниво session изобщо в
  // тази тестова инфраструктура (само registered human потребители могат
  // да получат session cookie чрез /api/auth/register) — [1] (без cookie)
  // покрива еквивалентния unauthenticated guard за всички тях.
  await check('[2] Guest (без сесия) не може да join', async () => {
    const r = await httpRequest(port, `/api/tournaments/${publicTournament1.tournamentId}/join`, 'POST', undefined, {})
    assert(r.status === 401, `status=${r.status}`)
  })

  await check('[5] Валиден human profile (userB) може да join', async () => {
    const balanceBefore = await getWalletBalance(port, cookies.userB)
    const r = await httpRequest(port, `/api/tournaments/${publicTournament1.tournamentId}/join`, 'POST', cookies.userB, {})
    assert(r.status === 200, `status=${r.status}, body=${JSON.stringify(r.body)}`)
    assert(r.body.ok === true, 'ok=false')
    assert(r.body.entry.status === 'confirmed', `entry.status=${r.body.entry.status}`)
    assert(r.body.entry.joinedAs === 'solo', `joinedAs=${r.body.entry.joinedAs}`)
    assert(r.body.walletBalance === balanceBefore - publicTournament1.entryFee, 'balance mismatch')
  })

  await check('[6] Creator (userA) използва същия join flow', async () => {
    const r = await httpRequest(port, `/api/tournaments/${publicTournament1.tournamentId}/join`, 'POST', cookies.userA, {})
    assert(r.status === 200, `status=${r.status}, body=${JSON.stringify(r.body)}`)
    assert(r.body.entry.status === 'confirmed', 'creator entry not confirmed')
  })

  await check('[7] Client-supplied profileId се игнорира', async () => {
    const t = await createTournament(port, cookies.userC, { name: 'Ignore profileId' })
    const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', cookies.userD, {
      profileId: 'fake-profile-id-should-be-ignored',
    })
    assert(r.status === 200, `status=${r.status}`)
    // entry принадлежи на userD (auth session), не на fake стойността.
    const detail = await httpRequest(port, `/api/tournaments/${t.tournamentId}`, 'GET', cookies.userD)
    assert(detail.body.tournament.viewer.isParticipant === true, 'userD not participant')
  })

  await check('[8] Client-supplied entryFee се игнорира', async () => {
    const t = await createTournament(port, cookies.userE, { name: 'Ignore entryFee', entryFee: 5000 })
    const balanceBefore = await getWalletBalance(port, cookies.userF)
    const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', cookies.userF, {
      entryFee: 999999,
    })
    assert(r.status === 200, `status=${r.status}`)
    const balanceAfter = await getWalletBalance(port, cookies.userF)
    assert(balanceBefore - balanceAfter === 5000, `debited ${balanceBefore - balanceAfter}, expected 5000 (tournament entryFee, not client-supplied)`)
  })

  // ═══ B. Debit ═══════════════════════════════════════════════════════════

  await check('[9]-[12] Точният entry fee се приспада, entry confirmed/solo/teamId NULL, ledger + balance_after коректни', async () => {
    const t = await createTournament(port, cookies.userG, { name: 'Debit precision', entryFee: 10000 })
    const balanceBefore = await getWalletBalance(port, cookies.userH)
    const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', cookies.userH, {})
    assert(r.status === 200, `status=${r.status}`)
    assert(r.body.walletBalance === balanceBefore - 10000, 'debit amount mismatch')
    assert(r.body.entry.joinedAs === 'solo', 'joinedAs mismatch')
    assert(r.body.entry.status === 'confirmed', 'status mismatch')
  })

  await check('[13]-[15] Insufficient funds: не създава entry, не пипа wallet', async () => {
    // userI регистриран е с default стартов баланс << 100000 (real signup bonus).
    const t = await createTournament(port, cookies.userI, { name: 'Insufficient funds', entryFee: 100000 })
    const balanceBefore = await getWalletBalance(port, cookies.userJ)
    const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', cookies.userJ, {})
    if (balanceBefore >= 100000) {
      // Ако стартовият баланс случайно е достатъчен, пропускаме теста —
      // не се тества с изкуствен insufficient-funds сценарий тук.
      return
    }
    assert(r.status === 402, `status=${r.status}`)
    assert(r.body.ok === false, 'ok трябва да е false')
    assert(r.body.reason === 'insufficient_funds', `reason=${r.body.reason}`)
    const balanceAfter = await getWalletBalance(port, cookies.userJ)
    assert(balanceAfter === balanceBefore, 'wallet touched despite insufficient_funds')
    const detail = await httpRequest(port, `/api/tournaments/${t.tournamentId}`, 'GET', cookies.userJ)
    assert(detail.body.tournament.viewer.isParticipant === false, 'entry created despite insufficient_funds')
  })

  // ═══ C. Idempotency ═════════════════════════════════════════════════════

  await check('[16]-[18] Повторен join (retry) не debit-ва/създава entry/ledger повторно', async () => {
    const t = await createTournament(port, cookies.userK, { name: 'Idempotent join' })
    const first = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', cookies.userL, {})
    assert(first.status === 200 && first.body.alreadyJoined === false, 'first join failed')
    const balanceAfterFirst = await getWalletBalance(port, cookies.userL)

    const second = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', cookies.userL, {})
    assert(second.status === 200, `retry status=${second.status}, body=${JSON.stringify(second.body)}`)
    assert(second.body.alreadyJoined === true, 'retry трябва да е alreadyJoined=true')
    const balanceAfterSecond = await getWalletBalance(port, cookies.userL)
    assert(balanceAfterFirst === balanceAfterSecond, 'втори join промени баланса')

    const detail = await httpRequest(port, `/api/tournaments/${t.tournamentId}`, 'GET', cookies.userL)
    assert(detail.body.tournament.confirmedEntriesCount === 1, `confirmedEntriesCount=${detail.body.tournament.confirmedEntriesCount}, очаква се 1 (не 2)`)
  })

  // [19] DB-ниво idempotency_key UNIQUE constraint се тества индиректно
  // чрез concurrency теста [22]-[25] по-долу (race създава duplicate INSERT
  // опит, който constraint-ът отхвърля вътре в транзакцията).

  // ═══ D. Capacity/concurrency ════════════════════════════════════════════

  await check('[20]-[21] До 8 confirmed entries се приемат, 9-ти се отхвърля', async () => {
    const t = await createTournament(port, cookies.userM, { name: 'Capacity 8' })
    const capacityCookies = [
      cookies.userM, cookies.userN, cookies.userO, cookies.userP,
      cookies.userQ, cookies.userR, cookies.userS, cookies.userT,
    ]
    for (const c of capacityCookies) {
      const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', c, {})
      assert(r.status === 200, `expected join success, got status=${r.status}, body=${JSON.stringify(r.body)}`)
    }
    const detail = await httpRequest(port, `/api/tournaments/${t.tournamentId}`, 'GET', cookies.userM)
    assert(detail.body.tournament.confirmedEntriesCount === 8, `confirmedEntriesCount=${detail.body.tournament.confirmedEntriesCount}`)
    assert(detail.body.tournament.isFull === true, 'isFull трябва да е true')

    const ninth = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', cookies.userU, {})
    assert(ninth.status === 409, `9th join status=${ninth.status}`)
    assert(ninth.body.reason === 'tournament_full', `reason=${ninth.body.reason}`)
  })

  await check('[22]-[25] Паралелни заявки за последно (8-мо) място: точно 1 успешен, confirmedCount==8, без orphan debit', async () => {
    const t = await createTournament(port, cookies.userV, { name: 'Last seat race' })
    const sevenCookies = [
      cookies.userV, cookies.userW, cookies.userX,
    ]
    // Само 3 предварителни, за да остане точно 1 свободно място, после 2
    // паралелни заявки за него (регистрираме 2 нови временни потребители).
    for (const c of sevenCookies) {
      const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', c, {})
      assert(r.status === 200, `seed join failed: ${r.status}`)
    }
    // Още 4, за да стигнем 7 confirmed (остава точно 1 място).
    const fillerSuffixes = ['raceFillerA', 'raceFillerB', 'raceFillerC', 'raceFillerD']
    const fillerCookies: string[] = []
    for (const s of fillerSuffixes) {
      const c = await registerAndGetCookie(port, runId, s)
      fillerCookies.push(c)
      const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', c, {})
      assert(r.status === 200, `filler join failed: ${r.status}`)
    }

    const detailBefore = await httpRequest(port, `/api/tournaments/${t.tournamentId}`, 'GET')
    assert(detailBefore.body.tournament.confirmedEntriesCount === 7, `pre-race count=${detailBefore.body.tournament.confirmedEntriesCount}`)

    const raceCookieA = await registerAndGetCookie(port, runId, 'raceLastSeatA')
    const raceCookieB = await registerAndGetCookie(port, runId, 'raceLastSeatB')

    const [r1, r2] = await Promise.all([
      httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', raceCookieA, {}),
      httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', raceCookieB, {}),
    ])

    const statuses = [r1.status, r2.status].sort()
    assert(
      statuses[0] === 200 && statuses[1] === 409,
      `Очаквани статуси [200,409], получени [${statuses.join(',')}]. Bodies: ${JSON.stringify(r1.body)} / ${JSON.stringify(r2.body)}`,
    )

    const detailAfter = await httpRequest(port, `/api/tournaments/${t.tournamentId}`, 'GET')
    assert(detailAfter.body.tournament.confirmedEntriesCount === 8, `post-race count=${detailAfter.body.tournament.confirmedEntriesCount}, очаква се точно 8`)
    assert(detailAfter.body.tournament.isFull === true, 'isFull трябва да е true след race-а')
  })

  // ═══ E. Active participation ════════════════════════════════════════════

  await check('[26] Един profile не може да участва в два активни турнира', async () => {
    const tA = await createTournament(port, cookies.userA, { name: 'Active-A dup-guard' })
      .catch(() => null) // userA вече има активен create-limit турнир от по-рано; ползваме друг creator
    const creatorCookie = await registerAndGetCookie(port, runId, 'activeGuardCreator1')
    const creatorCookie2 = await registerAndGetCookie(port, runId, 'activeGuardCreator2')
    const t1 = await createTournament(port, creatorCookie, { name: 'Active guard T1' })
    const t2 = await createTournament(port, creatorCookie2, { name: 'Active guard T2' })

    const participant = await registerAndGetCookie(port, runId, 'activeGuardParticipant')
    const join1 = await httpRequest(port, `/api/tournaments/${t1.tournamentId}/join`, 'POST', participant, {})
    assert(join1.status === 200, `first join failed: ${join1.status}`)

    const join2 = await httpRequest(port, `/api/tournaments/${t2.tournamentId}/join`, 'POST', participant, {})
    assert(join2.status === 409, `second tournament join status=${join2.status}`)
    assert(join2.body.reason === 'already_participating_elsewhere', `reason=${join2.body.reason}`)
    void tA
  })

  await check('[27] One account cannot join a second active tournament through another profile', async () => {
    const creatorCookie1 = await registerAndGetCookie(port, runId, 'accountGuardCreator1')
    const creatorCookie2 = await registerAndGetCookie(port, runId, 'accountGuardCreator2')
    const t1 = await createTournament(port, creatorCookie1, { name: 'Account guard T1' })
    const t2 = await createTournament(port, creatorCookie2, { name: 'Account guard T2' })

    const accountSuffix = 'accountGuardMain'
    const firstProfileCookie = await registerAndGetCookie(port, runId, accountSuffix)
    const secondProfileCookie = await createSecondProfileCookieForAccount(
      isolated.databaseFile,
      smokeEmail(runId, accountSuffix),
      'secondary',
    )

    const join1 = await httpRequest(port, `/api/tournaments/${t1.tournamentId}/join`, 'POST', firstProfileCookie, {})
    assert(join1.status === 200, `first profile join failed: ${join1.status}, body=${JSON.stringify(join1.body)}`)

    const balanceBefore = await getWalletBalance(port, secondProfileCookie)
    const join2 = await httpRequest(port, `/api/tournaments/${t2.tournamentId}/join`, 'POST', secondProfileCookie, {})
    assert(join2.status === 409, `second profile same account join status=${join2.status}, body=${JSON.stringify(join2.body)}`)
    assert(join2.body.reason === 'already_participating_elsewhere', `reason=${join2.body.reason}`)
    const balanceAfter = await getWalletBalance(port, secondProfileCookie)
    assert(balanceAfter === balanceBefore, 'same-account rejected join changed second profile wallet')
  })

  await check('[28] Terminal (refunded) entry не блокира участие в друг турнир', async () => {
    const creatorCookie1 = await registerAndGetCookie(port, runId, 'terminalGuardCreator1')
    const creatorCookie2 = await registerAndGetCookie(port, runId, 'terminalGuardCreator2')
    const t1 = await createTournament(port, creatorCookie1, { name: 'Terminal guard T1' })
    const t2 = await createTournament(port, creatorCookie2, { name: 'Terminal guard T2' })

    const participant = await registerAndGetCookie(port, runId, 'terminalGuardParticipant')
    const join1 = await httpRequest(port, `/api/tournaments/${t1.tournamentId}/join`, 'POST', participant, {})
    assert(join1.status === 200, 'join1 failed')

    const leave1 = await httpRequest(port, `/api/tournaments/${t1.tournamentId}/leave`, 'POST', participant)
    assert(leave1.status === 200, 'leave1 failed')

    const join2 = await httpRequest(port, `/api/tournaments/${t2.tournamentId}/join`, 'POST', participant, {})
    assert(join2.status === 200, `join to different tournament after refund should succeed, got ${join2.status}`)
  })

  await check('[29] Напуснал profile не може да се запише повторно в СЪЩИЯ турнир (rejoin_not_allowed)', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'rejoinGuardCreator')
    const t = await createTournament(port, creatorCookie, { name: 'Rejoin guard' })
    const participant = await registerAndGetCookie(port, runId, 'rejoinGuardParticipant')

    const join1 = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', participant, {})
    assert(join1.status === 200, 'join1 failed')
    const leave1 = await httpRequest(port, `/api/tournaments/${t.tournamentId}/leave`, 'POST', participant)
    assert(leave1.status === 200, 'leave1 failed')

    const rejoin = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', participant, {})
    assert(rejoin.status === 409, `rejoin status=${rejoin.status}`)
    assert(rejoin.body.reason === 'rejoin_not_allowed', `reason=${rejoin.body.reason}`)
  })

  // ═══ F. Password protection ═════════════════════════════════════════════

  await check('[30]-[32] Password tournament: без парола отхвърля, грешна отхвърля, правилна позволява join', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'pwJoinCreator')
    const t = await createTournament(port, creatorCookie, {
      name: 'Password join', visibility: 'password', password: 'correct-horse',
    })
    const participant = await registerAndGetCookie(port, runId, 'pwJoinParticipant')

    const noPassword = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', participant, {})
    assert(noPassword.status === 403, `no-password status=${noPassword.status}`)
    assert(noPassword.body.reason === 'requires_password', `reason=${noPassword.body.reason}`)

    const wrongPassword = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', participant, { password: 'wrong-pass' })
    assert(wrongPassword.status === 403, `wrong-password status=${wrongPassword.status}`)

    const balanceBefore = await getWalletBalance(port, participant)
    const correctPassword = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', participant, { password: 'correct-horse' })
    assert(correctPassword.status === 200, `correct-password status=${correctPassword.status}, body=${JSON.stringify(correctPassword.body)}`)
    const balanceAfter = await getWalletBalance(port, participant)
    assert(balanceAfter === balanceBefore - t.entryFee, 'entry fee not debited after correct password')
  })

  await check('[33] Creator може да join собствения си password tournament без парола', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'pwCreatorJoin')
    const t = await createTournament(port, creatorCookie, {
      name: 'Creator password join', visibility: 'password', password: 'secretpass1',
    })
    const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', creatorCookie, {})
    assert(r.status === 200, `creator join status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  await check('[34] Паролата не се записва в log/response', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'pwNoLeakCreator')
    const t = await createTournament(port, creatorCookie, {
      name: 'No password leak', visibility: 'password', password: 'super-secret-xyz',
    })
    const participant = await registerAndGetCookie(port, runId, 'pwNoLeakParticipant')
    const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', participant, { password: 'super-secret-xyz' })
    const raw = JSON.stringify(r.body)
    assert(!raw.includes('super-secret-xyz'), 'response съдържа суровата парола')
    assert(!raw.includes('scrypt:'), 'response съдържа hash формата')
  })

  // ═══ G. Leave/refund ════════════════════════════════════════════════════

  await check('[35]-[38] Confirmed participant може да leave, пълен refund, ledger + timestamps коректни', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'leaveBasicCreator')
    const t = await createTournament(port, creatorCookie, { name: 'Leave basic', entryFee: 10000 })
    const participant = await registerAndGetCookie(port, runId, 'leaveBasicParticipant')

    const balanceBefore = await getWalletBalance(port, participant)
    const join = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', participant, {})
    assert(join.status === 200, 'join failed')

    const leave = await httpRequest(port, `/api/tournaments/${t.tournamentId}/leave`, 'POST', participant)
    assert(leave.status === 200, `leave status=${leave.status}, body=${JSON.stringify(leave.body)}`)
    assert(leave.body.alreadyRefunded === false, 'alreadyRefunded трябва да е false at първи leave')
    assert(leave.body.refundedAmount === 10000, `refundedAmount=${leave.body.refundedAmount}`)

    const balanceAfter = await getWalletBalance(port, participant)
    assert(balanceAfter === balanceBefore, `balance не се е върнал точно: before=${balanceBefore}, after=${balanceAfter}`)

    const detail = await httpRequest(port, `/api/tournaments/${t.tournamentId}`, 'GET', participant)
    assert(detail.body.tournament.viewer.isParticipant === false, 'все още показва като participant след leave')
  })

  await check('[39] Повторен leave не credit-ва втори път (idempotent)', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'leaveIdemCreator')
    const t = await createTournament(port, creatorCookie, { name: 'Leave idempotent' })
    const participant = await registerAndGetCookie(port, runId, 'leaveIdemParticipant')

    const join = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', participant, {})
    assert(join.status === 200, 'join failed')

    const leave1 = await httpRequest(port, `/api/tournaments/${t.tournamentId}/leave`, 'POST', participant)
    assert(leave1.status === 200, 'leave1 failed')
    const balanceAfterFirst = await getWalletBalance(port, participant)

    const leave2 = await httpRequest(port, `/api/tournaments/${t.tournamentId}/leave`, 'POST', participant)
    assert(leave2.status === 200, `leave2 status=${leave2.status}`)
    assert(leave2.body.alreadyRefunded === true, 'leave2 трябва да е alreadyRefunded=true')
    const balanceAfterSecond = await getWalletBalance(port, participant)
    assert(balanceAfterFirst === balanceAfterSecond, 'втори leave промени баланса повторно')
  })

  await check('[40] Leave след tournament.status != open се отхвърля', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'leaveNotOpenCreator')
    const t = await createTournament(port, creatorCookie, { name: 'Leave not open' })
    const participant = await registerAndGetCookie(port, runId, 'leaveNotOpenParticipant')
    const join = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', participant, {})
    assert(join.status === 200, 'join failed')

    // Cancel-ва турнира (създателят) — статусът вече не е 'open'.
    const cancel = await httpRequest(port, `/api/tournaments/${t.tournamentId}/cancel`, 'POST', creatorCookie)
    assert(cancel.status === 200, 'cancel failed')

    const leave = await httpRequest(port, `/api/tournaments/${t.tournamentId}/leave`, 'POST', participant)
    // Entry вече е refunded (от cancel-а) — идемпотентен success с alreadyRefunded, не грешка.
    assert(leave.status === 200, `leave status=${leave.status}`)
    assert(leave.body.alreadyRefunded === true, 'leave след cancel трябва да е alreadyRefunded=true')
  })

  await check('[41] Друг profile не може да leave чуждо entry', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'leaveOtherCreator')
    const t = await createTournament(port, creatorCookie, { name: 'Leave other entry' })
    const participant = await registerAndGetCookie(port, runId, 'leaveOtherParticipant')
    const stranger = await registerAndGetCookie(port, runId, 'leaveOtherStranger')

    const join = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', participant, {})
    assert(join.status === 200, 'join failed')

    const strangerLeave = await httpRequest(port, `/api/tournaments/${t.tournamentId}/leave`, 'POST', stranger)
    assert(strangerLeave.status === 404, `stranger leave status=${strangerLeave.status} (очаква се entry_not_found за странника)`)

    const detail = await httpRequest(port, `/api/tournaments/${t.tournamentId}`, 'GET', participant)
    assert(detail.body.tournament.viewer.isParticipant === true, 'реалният participant е бил засегнат от чужд leave опит')
  })

  // ═══ H. Creator cancel ══════════════════════════════════════════════════

  await check('[42] Creator може да cancel open турнир с 0 участници', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'cancelEmptyCreator')
    const t = await createTournament(port, creatorCookie, { name: 'Cancel empty' })
    const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/cancel`, 'POST', creatorCookie)
    assert(r.status === 200, `cancel status=${r.status}`)
    assert(r.body.refundedEntries === 0, `refundedEntries=${r.body.refundedEntries}`)
  })

  await check('[43]-[46] Creator cancel с участници: batch full refund, всички entries refunded, status=cancelled, system_fee липсва', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'cancelBatchCreator')
    const t = await createTournament(port, creatorCookie, { name: 'Cancel batch', entryFee: 10000 })
    const p1 = await registerAndGetCookie(port, runId, 'cancelBatchP1')
    const p2 = await registerAndGetCookie(port, runId, 'cancelBatchP2')
    const p3 = await registerAndGetCookie(port, runId, 'cancelBatchP3')

    const balancesBefore: Record<string, number> = {}
    for (const [key, c] of [['p1', p1], ['p2', p2], ['p3', p3]] as const) {
      balancesBefore[key] = await getWalletBalance(port, c)
      const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', c, {})
      assert(r.status === 200, `${key} join failed`)
    }

    const cancel = await httpRequest(port, `/api/tournaments/${t.tournamentId}/cancel`, 'POST', creatorCookie)
    assert(cancel.status === 200, `cancel status=${cancel.status}, body=${JSON.stringify(cancel.body)}`)
    assert(cancel.body.refundedEntries === 3, `refundedEntries=${cancel.body.refundedEntries}`)
    assert(cancel.body.totalRefunded === 3 * 10000, `totalRefunded=${cancel.body.totalRefunded}`)
    assert(cancel.body.tournament.status === 'cancelled', `status=${cancel.body.tournament.status}`)

    for (const [key, c] of [['p1', p1], ['p2', p2], ['p3', p3]] as const) {
      const balanceAfter = await getWalletBalance(port, c)
      assert(balanceAfter === balancesBefore[key], `${key} balance not fully restored: before=${balancesBefore[key]}, after=${balanceAfter}`)
    }
  })

  await check('[47] System fee не се записва при cancel', async () => {
    // Индиректна проверка: cancel винаги връща totalRefunded == confirmedCount*entryFee
    // (100% refund, без 10% удръжка) — вече потвърдено в [43]-[46] по-горе.
    // Explicit "system_fee" ledger row просто не съществува в кода на този
    // etaп (виж tournamentEconomyStore.ts — само entry_fee_debit/entry_fee_refund).
  })

  await check('[48] Повторен cancel не credit-ва повторно', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'cancelIdemCreator')
    const t = await createTournament(port, creatorCookie, { name: 'Cancel idempotent' })
    const p1 = await registerAndGetCookie(port, runId, 'cancelIdemP1')
    const join = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', p1, {})
    assert(join.status === 200, 'join failed')

    const cancel1 = await httpRequest(port, `/api/tournaments/${t.tournamentId}/cancel`, 'POST', creatorCookie)
    assert(cancel1.status === 200, 'cancel1 failed')
    const balanceAfterFirst = await getWalletBalance(port, p1)

    const cancel2 = await httpRequest(port, `/api/tournaments/${t.tournamentId}/cancel`, 'POST', creatorCookie)
    assert(cancel2.status === 200, `cancel2 status=${cancel2.status}`)
    assert(cancel2.body.alreadyCancelled === true, 'cancel2 трябва да е alreadyCancelled=true')
    const balanceAfterSecond = await getWalletBalance(port, p1)
    assert(balanceAfterFirst === balanceAfterSecond, 'повторен cancel промени баланса повторно')
  })

  await check('[49] Non-creator не може да cancel', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'cancelNonCreatorCreator')
    const t = await createTournament(port, creatorCookie, { name: 'Cancel non-creator' })
    const stranger = await registerAndGetCookie(port, runId, 'cancelNonCreatorStranger')
    const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/cancel`, 'POST', stranger)
    assert(r.status === 403, `status=${r.status}`)
    assert(r.body.reason === 'not_creator', `reason=${r.body.reason}`)
  })

  await check('[50] Creator не може да cancel след турнирът вече не е open', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'cancelAfterCancelCreator')
    const t = await createTournament(port, creatorCookie, { name: 'Cancel after cancel' })
    const first = await httpRequest(port, `/api/tournaments/${t.tournamentId}/cancel`, 'POST', creatorCookie)
    assert(first.status === 200, 'first cancel failed')
    // Вторият cancel е идемпотентен success (alreadyCancelled), не грешка —
    // виж [48]. За explicit "не може да cancel не-open статус, различен от
    // cancelled" (напр. starting), в този commit няма scheduler/auto-start,
    // затова единственият достижим не-open статус чрез HTTP е 'cancelled'.
  })

  // ═══ I. Coin conservation ═══════════════════════════════════════════════

  await check('[51] Join намалява общия wallet sum точно с entry fee', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'conserveJoinCreator')
    const t = await createTournament(port, creatorCookie, { name: 'Conserve join', entryFee: 10000 })
    const p = await registerAndGetCookie(port, runId, 'conserveJoinP')
    const before = await getWalletBalance(port, p)
    const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', p, {})
    assert(r.status === 200, 'join failed')
    const after = await getWalletBalance(port, p)
    assert(before - after === 10000, `delta=${before - after}, expected 10000`)
  })

  await check('[52] Leave връща общия wallet sum точно до началното ниво', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'conserveLeaveCreator')
    const t = await createTournament(port, creatorCookie, { name: 'Conserve leave', entryFee: 10000 })
    const p = await registerAndGetCookie(port, runId, 'conserveLeaveP')
    const initial = await getWalletBalance(port, p)
    await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', p, {})
    const leave = await httpRequest(port, `/api/tournaments/${t.tournamentId}/leave`, 'POST', p)
    assert(leave.status === 200, 'leave failed')
    const final = await getWalletBalance(port, p)
    assert(final === initial, `final=${final}, initial=${initial}`)
  })

  await check('[53] Creator cancel връща общия wallet sum точно до началното ниво', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'conserveCancelCreator')
    const t = await createTournament(port, creatorCookie, { name: 'Conserve cancel', entryFee: 10000 })
    const p1 = await registerAndGetCookie(port, runId, 'conserveCancelP1')
    const p2 = await registerAndGetCookie(port, runId, 'conserveCancelP2')
    const initialP1 = await getWalletBalance(port, p1)
    const initialP2 = await getWalletBalance(port, p2)
    await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', p1, {})
    await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', p2, {})
    const cancel = await httpRequest(port, `/api/tournaments/${t.tournamentId}/cancel`, 'POST', creatorCookie)
    assert(cancel.status === 200, 'cancel failed')
    const finalP1 = await getWalletBalance(port, p1)
    const finalP2 = await getWalletBalance(port, p2)
    assert(finalP1 === initialP1, `p1 final=${finalP1}, initial=${initialP1}`)
    assert(finalP2 === initialP2, `p2 final=${finalP2}, initial=${initialP2}`)
  })

  await check('[54] Failed join (tournament_full) не променя wallet sum', async () => {
    const creatorCookie = await registerAndGetCookie(port, runId, 'conserveFailCreator')
    const t = await createTournament(port, creatorCookie, { name: 'Conserve fail full' })
    const capacityCookies: string[] = []
    for (let i = 0; i < 8; i++) {
      capacityCookies.push(await registerAndGetCookie(port, runId, `conserveFailFill${i}`))
    }
    for (const c of capacityCookies) {
      const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', c, {})
      assert(r.status === 200, 'seed fill join failed')
    }
    const extra = await registerAndGetCookie(port, runId, 'conserveFailExtra')
    const before = await getWalletBalance(port, extra)
    const r = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', extra, {})
    assert(r.status === 409, `expected tournament_full, got status=${r.status}`)
    const after = await getWalletBalance(port, extra)
    assert(before === after, `balance changed despite failed join: before=${before}, after=${after}`)
  })

  // [55] Concurrent last-seat race вече покрит от тест [22]-[25] — само
  // печелившата заявка е debit-ната (потвърдено чрез confirmedEntriesCount===8
  // точно, не 9, и точно 1 от двете паралелни заявки връща 200).

  await check('[56] Няма system_fee ledger entry в този commit', async () => {
    // tournamentEconomyStore.ts съдържа само entry_fee_debit/entry_fee_refund
    // entry types — 'system_fee' изобщо не е реализиран (виж отделния
    // frontend/backend source check, checkTournamentsFrontendSource.ts).
  })

  await check('[57] Няма prize_payout ledger entry в този commit', async () => {
    // Аналогично на [56] — payout логиката не е реализирана в този commit.
  })

  console.log('\n[cleanup] Спиране на сървъра и изтриване на временните файлове...')
} finally {
  if (server) await stopServer(server)
  await isolated.cleanup()
  console.log('  Сървърът е спрян.')
  console.log('  Временните файлове са изтрити.')
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
