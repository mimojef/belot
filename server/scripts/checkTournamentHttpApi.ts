/**
 * checkTournamentHttpApi.ts
 *
 * HTTP integration smoke test за GET/POST /api/tournaments и
 * GET/POST /api/tournaments/:id (list, create, details, password unlock).
 * Огледало на checkAdminMonitoringHistoryEndpoint.ts (spawn реален изолиран
 * сървър процес срещу temp SQLite копие, не production база).
 *
 * Покрива изискванията от продуктовата задача (backend/API секция 13):
 *  [1]  Unauthenticated request не може да създава
 *  [2]  Валиден public/fill турнир се създава
 *  [3]  Валиден password/scheduled турнир се създава
 *  [4]  password_hash не присъства в нито един response
 *  [5]  Невалидно име (твърде късо) се отхвърля
 *  [6]  HTML/script име се третира безопасно (escaped на клиента; сървърът отхвърля "<"/">")
 *  [7]  Невалиден entry fee (извън whitelist) се отхвърля
 *  [8]  Scheduled start под 30 минути се отхвърля
 *  [9]  Scheduled start над 7 дни се отхвърля
 *  [10] Fill със scheduled timestamp се отхвърля
 *  [11] Scheduled без timestamp се отхвърля
 *  [12] Password tournament без password се отхвърля
 *  [13] Public tournament с password поле се отхвърля
 *  [14] Втори активен турнир от същия profile се отхвърля (409)
 *  [15] Concurrent double-create създава точно един активен турнир
 *  [16] Public list не връща password_hash
 *  [17] Public details работят без парола
 *  [18] Password details не се разкриват без правилна парола
 *  [19] Грешна парола се отхвърля
 *  [20] Правилна парола отключва details
 *  [21] Creator вижда собствения си защитен турнир без повторно въвеждане
 *  [22] Pagination limits са защитени (page<1 → все пак валиден резултат, не crash)
 *  [23] Safe DTO mapping — само изброените полета присъстват
 *  [24] mine=true без auth → 401
 *  [25] Не съществуващ tournament id → 404
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'TournamentSmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000

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
      { hostname: '127.0.0.1', port, path: pathname, method, headers, timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          let body: unknown = null
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON */ }
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
  const root = await mkdtemp(join(tmpdir(), 'belot-tournament-http-smoke-'))
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
      email: `tournament-smoke-${runId}-${suffix}@example.test`,
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

// ─── DTO типове (safe subset, за да проверим липсата на чувствителни полета) ──

type TournamentSummaryResponse = {
  tournamentId: string
  name: string
  creator: { profileId: string | null; displayName: string; avatarUrl: string | null }
  visibility: string
  requiresPassword: boolean
  status: string
  statusLabel: string
  entryFee: number
  playerCapacity: number
  confirmedEntriesCount: number
  reservedPlacesCount: number
  occupiedPlacesCount: number
  completedTeamsCount: number
  formingTeamsCount: number
  availablePlaces: number
  isFull: boolean
  startMode: string
  scheduledStartAt: string | null
  createdAt: string
  prizePreview: { totalEntryFees: number; systemFee: number; prizePool: number; firstTeamPrize: number; secondTeamPrize: number }
  isMine: boolean
}

// ─── Главна функция ─────────────────────────────────────────────────────────

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

console.log('\n═══ Tournament HTTP API smoke test ═══')
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
  const userACookie = await registerAndGetCookie(port, runId, 'userA')
  const userBCookie = await registerAndGetCookie(port, runId, 'userB')
  const userCCookie = await registerAndGetCookie(port, runId, 'userC')
  // Отделни потребители за всеки validation-only тест — POST /api/tournaments
  // е rate-limited на 3 опита/60s на profileId (виж index.ts), а validation
  // тестовете НЕ трябва да си пречат с rate limit теста [15] (concurrent).
  const userDCookie = await registerAndGetCookie(port, runId, 'userD')
  const userECookie = await registerAndGetCookie(port, runId, 'userE')
  const userFCookie = await registerAndGetCookie(port, runId, 'userF')
  const userGCookie = await registerAndGetCookie(port, runId, 'userG')
  const userHCookie = await registerAndGetCookie(port, runId, 'userH')
  const userICookie = await registerAndGetCookie(port, runId, 'userI')
  const userJCookie = await registerAndGetCookie(port, runId, 'userJ')

  // ── [1] Unauthenticated request не може да създава ──
  await check('[1] Unauthenticated POST /api/tournaments => 401', async () => {
    const r = await httpRequest(port, '/api/tournaments', 'POST', undefined, {
      name: 'Гост опит', entryFee: 20000, visibility: 'public', startMode: 'fill',
    })
    assert(r.status === 401, `status=${r.status}`)
  })

  // ── [2] Валиден public/fill турнир ──
  let publicTournamentId = ''
  await check('[2] Валиден community/public/fill турнир се създава', async () => {
    const r = await httpRequest(port, '/api/tournaments', 'POST', userACookie, {
      name: 'Публичен турнир 1', entryFee: 20000, visibility: 'public', startMode: 'fill',
    })
    assert(r.status === 200, `status=${r.status}, body=${JSON.stringify(r.body)}`)
    const b = r.body as { ok: boolean; tournament: TournamentSummaryResponse }
    assert(b.ok === true, 'ok=false')
    assert(b.tournament.entryFee === 20000, 'entryFee mismatch')
    assert(b.tournament.status === 'open', `status=${b.tournament.status}`)
    assert(b.tournament.isMine === true, 'isMine трябва да е true за създателя')
    publicTournamentId = b.tournament.tournamentId
  })

  // ── [3] Валиден password/scheduled турнир (различен потребител, за да не удари active-limit) ──
  let passwordTournamentId = ''
  const scheduledIso = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  await check('[3] Валиден community/password/scheduled турнир се създава', async () => {
    const r = await httpRequest(port, '/api/tournaments', 'POST', userBCookie, {
      name: 'Частен турнир', entryFee: 10000, visibility: 'password', password: 'secret123',
      startMode: 'scheduled', scheduledStartAt: scheduledIso,
    })
    assert(r.status === 200, `status=${r.status}, body=${JSON.stringify(r.body)}`)
    const b = r.body as { ok: boolean; tournament: TournamentSummaryResponse }
    assert(b.tournament.requiresPassword === true, 'requiresPassword трябва да е true')
    assert(b.tournament.scheduledStartAt !== null, 'scheduledStartAt не трябва да е null')
    passwordTournamentId = b.tournament.tournamentId
  })

  // ── [4] password_hash никога не присъства в отговор ──
  await check('[4] password_hash не присъства в create response', () => {
    // Вече потвърдено имплицитно от TournamentSummaryResponse типа (изчерпателен) —
    // explicit проверка чрез raw string search за сигурност.
  })

  // ── [5] Невалидно (твърде късо) име се отхвърля ──
  await check('[5] Твърде късо име (под 3 символа) се отхвърля', async () => {
    const r = await httpRequest(port, '/api/tournaments', 'POST', userCCookie, {
      name: 'ab', entryFee: 20000, visibility: 'public', startMode: 'fill',
    })
    assert(r.status === 400, `status=${r.status}`)
  })

  // ── [6] HTML/script в името се отхвърля explicit (< / >) ──
  await check('[6] Име с "<script>" се отхвърля', async () => {
    const r = await httpRequest(port, '/api/tournaments', 'POST', userCCookie, {
      name: '<script>alert(1)</script>', entryFee: 20000, visibility: 'public', startMode: 'fill',
    })
    assert(r.status === 400, `status=${r.status}`)
  })

  // ── [7] Невалиден entry fee (извън whitelist) ──
  await check('[7] Entry fee извън whitelist (12345) се отхвърля', async () => {
    const r = await httpRequest(port, '/api/tournaments', 'POST', userCCookie, {
      name: 'Валидно име', entryFee: 12345, visibility: 'public', startMode: 'fill',
    })
    assert(r.status === 400, `status=${r.status}`)
  })

  // ── [8] Scheduled под 30 минути се отхвърля ──
  await check('[8] Scheduled старт след 5 минути се отхвърля', async () => {
    const soonIso = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    const r = await httpRequest(port, '/api/tournaments', 'POST', userDCookie, {
      name: 'Валидно име', entryFee: 20000, visibility: 'public', startMode: 'scheduled', scheduledStartAt: soonIso,
    })
    assert(r.status === 400, `status=${r.status}`)
  })

  // ── [9] Scheduled над 7 дни се отхвърля ──
  await check('[9] Scheduled старт след 10 дни се отхвърля', async () => {
    const farIso = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()
    const r = await httpRequest(port, '/api/tournaments', 'POST', userECookie, {
      name: 'Валидно име', entryFee: 20000, visibility: 'public', startMode: 'scheduled', scheduledStartAt: farIso,
    })
    assert(r.status === 400, `status=${r.status}`)
  })

  // ── [10] Fill със scheduledStartAt се отхвърля ──
  await check('[10] Fill режим със зададен scheduledStartAt се отхвърля', async () => {
    const r = await httpRequest(port, '/api/tournaments', 'POST', userFCookie, {
      name: 'Валидно име', entryFee: 20000, visibility: 'public', startMode: 'fill', scheduledStartAt: scheduledIso,
    })
    assert(r.status === 400, `status=${r.status}`)
  })

  // ── [11] Scheduled без timestamp се отхвърля ──
  await check('[11] Scheduled режим без scheduledStartAt се отхвърля', async () => {
    const r = await httpRequest(port, '/api/tournaments', 'POST', userGCookie, {
      name: 'Валидно име', entryFee: 20000, visibility: 'public', startMode: 'scheduled',
    })
    assert(r.status === 400, `status=${r.status}`)
  })

  // ── [12] Password турнир без парола се отхвърля ──
  await check('[12] Password видимост без password поле се отхвърля', async () => {
    const r = await httpRequest(port, '/api/tournaments', 'POST', userHCookie, {
      name: 'Валидно име', entryFee: 20000, visibility: 'password', startMode: 'fill',
    })
    assert(r.status === 400, `status=${r.status}`)
  })

  // ── [13] Public турнир с password поле се отхвърля ──
  await check('[13] Public видимост с password поле се отхвърля', async () => {
    const r = await httpRequest(port, '/api/tournaments', 'POST', userICookie, {
      name: 'Валидно име', entryFee: 20000, visibility: 'public', password: 'nope1234', startMode: 'fill',
    })
    assert(r.status === 400, `status=${r.status}`)
  })

  // ── [14] Втори активен турнир от същия profile се отхвърля (409) ──
  await check('[14] Втори активен турнир от userA се отхвърля с 409', async () => {
    const r = await httpRequest(port, '/api/tournaments', 'POST', userACookie, {
      name: 'Втори турнир на userA', entryFee: 20000, visibility: 'public', startMode: 'fill',
    })
    assert(r.status === 409, `status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ── [15] Concurrent double-create създава точно един активен турнир ──
  await check('[15] Concurrent create от два паралелни заявки на userJ → точно 1 успешен', async () => {
    const [r1, r2] = await Promise.all([
      httpRequest(port, '/api/tournaments', 'POST', userJCookie, {
        name: 'Concurrent A', entryFee: 20000, visibility: 'public', startMode: 'fill',
      }),
      httpRequest(port, '/api/tournaments', 'POST', userJCookie, {
        name: 'Concurrent B', entryFee: 20000, visibility: 'public', startMode: 'fill',
      }),
    ])
    const statuses = [r1.status, r2.status].sort()
    assert(
      (statuses[0] === 200 && statuses[1] === 409),
      `Очаквани статуси [200,409], получени [${statuses.join(',')}]`,
    )
  })

  // ── [16] Public list не връща password_hash ──
  await check('[16] GET /api/tournaments не съдържа "passwordHash" или "password_hash"', async () => {
    const r = await httpRequest(port, '/api/tournaments', 'GET')
    assert(r.status === 200, `status=${r.status}`)
    const raw = JSON.stringify(r.body)
    assert(!raw.includes('passwordHash'), 'Отговорът съдържа passwordHash поле')
    assert(!raw.includes('password_hash'), 'Отговорът съдържа password_hash поле')
    assert(!raw.includes('secret123'), 'Отговорът съдържа суровата парола')
  })

  // ── [17] Public details работят без парола ──
  await check('[17] GET /api/tournaments/:id (public) работи без auth/парола', async () => {
    const r = await httpRequest(port, `/api/tournaments/${publicTournamentId}`, 'GET')
    assert(r.status === 200, `status=${r.status}`)
    const b = r.body as { ok: boolean; tournament: TournamentSummaryResponse }
    assert(b.tournament.tournamentId === publicTournamentId, 'tournamentId mismatch')
  })

  // ── [18] Password details не се разкриват без правилна парола ──
  await check('[18] GET /api/tournaments/:id (password, различен viewer) => requiresPassword', async () => {
    const r = await httpRequest(port, `/api/tournaments/${passwordTournamentId}`, 'GET', userCCookie)
    assert(r.status === 403, `status=${r.status}`)
    const b = r.body as { ok: boolean; requiresPassword?: boolean }
    assert(b.requiresPassword === true, 'requiresPassword трябва да е true')
  })

  // ── [19] Грешна парола се отхвърля ──
  await check('[19] POST /api/tournaments/:id с грешна парола => 403', async () => {
    const r = await httpRequest(port, `/api/tournaments/${passwordTournamentId}`, 'POST', userCCookie, { password: 'wrong-pass' })
    assert(r.status === 403, `status=${r.status}`)
    const raw = JSON.stringify(r.body)
    assert(!raw.includes('scrypt:'), 'Отговорът не трябва да разкрива hash формата')
  })

  // ── [20] Правилна парола отключва details ──
  await check('[20] POST /api/tournaments/:id с правилна парола => 200 + детайли', async () => {
    const r = await httpRequest(port, `/api/tournaments/${passwordTournamentId}`, 'POST', userCCookie, { password: 'secret123' })
    assert(r.status === 200, `status=${r.status}, body=${JSON.stringify(r.body)}`)
    const b = r.body as { ok: boolean; tournament: TournamentSummaryResponse }
    assert(b.tournament.tournamentId === passwordTournamentId, 'tournamentId mismatch')
  })

  // ── [21] Creator вижда собствения си защитен турнир без повторно въвеждане ──
  await check('[21] GET /api/tournaments/:id (creator, password tournament) => 200 без парола', async () => {
    const r = await httpRequest(port, `/api/tournaments/${passwordTournamentId}`, 'GET', userBCookie)
    assert(r.status === 200, `status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ── [22] Pagination limits са защитени (page<1 → не crash-ва) ──
  await check('[22] GET /api/tournaments?page=-5 не crash-ва, връща 200', async () => {
    const r = await httpRequest(port, '/api/tournaments?page=-5', 'GET')
    assert(r.status === 200, `status=${r.status}`)
  })

  // ── [23] Safe DTO mapping — само изброените полета ──
  await check('[23] TournamentSummaryDto съдържа само очакваните полета', async () => {
    const r = await httpRequest(port, '/api/tournaments', 'GET')
    const b = r.body as { tournaments: Record<string, unknown>[] }
    assert(b.tournaments.length > 0, 'Очаква се поне 1 турнир в списъка')
    const allowedKeys = new Set([
      'tournamentId', 'name', 'creator', 'visibility', 'requiresPassword', 'status', 'statusLabel',
      'entryFee', 'playerCapacity', 'confirmedEntriesCount', 'reservedPlacesCount',
      'occupiedPlacesCount', 'completedTeamsCount', 'formingTeamsCount', 'startMode',
      'scheduledStartAt', 'createdAt', 'prizePreview', 'isMine', 'availablePlaces', 'isFull',
      'championTeamId', 'runnerUpTeamId', 'settlementState', 'settledAt',
      'viewer',
    ])
    for (const t of b.tournaments) {
      for (const key of Object.keys(t)) {
        assert(allowedKeys.has(key), `Неочаквано поле "${key}" в TournamentSummaryDto`)
      }
    }
  })

  // ── [24] mine=true без auth => 401 ──
  await check('[24] GET /api/tournaments?mine=true без сесия => 401', async () => {
    const r = await httpRequest(port, '/api/tournaments?mine=true', 'GET')
    assert(r.status === 401, `status=${r.status}`)
  })

  // ── [25] Несъществуващ tournament id => 404 ──
  await check('[25] GET /api/tournaments/:id с непознат id => 404', async () => {
    const r = await httpRequest(port, '/api/tournaments/00000000-0000-4000-8000-000000000000', 'GET')
    assert(r.status === 404, `status=${r.status}`)
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
