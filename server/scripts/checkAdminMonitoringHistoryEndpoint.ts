import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// ─── Конфигурация ─────────────────────────────────────────────────────────────

const PASSWORD = 'HistorySmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000
const ENDPOINT = '/api/admin/monitoring/history'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-history-smoke-'))
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
      await rm(root, { recursive: true, force: true })
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

// ─── Промотиране на admin директно в isolated SQLite ─────────────────────────

function promoteToAdmin(databaseFile: string, email: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE email = ?`).run(email)
  db.close()
}

// ─── Регистрация + извличане на session cookie ────────────────────────────────

async function registerAndGetCookie(port: number, runId: string, suffix: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `history-smoke-${runId}-${suffix}@example.test`,
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

// ─── Типове за history response ───────────────────────────────────────────────

type HistoryPeaks = {
  serverCpu: number | null
  nodeCpu: number | null
  ramUsedMb: number
  ramPercent: number
  rssMb: number
  wsConns: number
  onlinePlayers: number
  activeRooms: number
  mmWaiters: number
}

type HistoryPoint = {
  t: number
  serverCpu: number | null
  nodeCpu: number | null
  ramUsedMb: number
  ramPercent: number
  rssMb: number
  wsConns: number
  onlinePlayers: number
  activeRooms: number
  mmWaiters: number
}

type PeakMoment = {
  value: number
  sampledAt: number | null
}

type PeakMoments = {
  wsConns: PeakMoment
  onlinePlayers: PeakMoment
  activeRooms: PeakMoment
  mmWaiters: PeakMoment
}

type HistoryResponse = {
  ok: boolean
  window: string
  points: HistoryPoint[]
  peaks: HistoryPeaks
  peakMoments: PeakMoments
}

// ─── Главна функция ───────────────────────────────────────────────────────────

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

console.log('\n═══ Admin monitoring history endpoint smoke test ═══')
console.log(`Server root: ${sourceServerRoot}`)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null

try {
  server = startServer(isolated.serverDir, port)

  // ─── Изчакай сървъра да е готов ───────────────────────────────────────────

  console.log(`\n[startup] Чакам сървъра на порт ${port}...`)

  await waitFor(
    'server health ready',
    async () => {
      try {
        const r = await httpRequest(port, '/health', 'GET')
        const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
        return (
          r.status === 200 &&
          h.ok === true &&
          h.gameWorkerPool?.state === 'ready'
        )
      } catch { return false }
    },
    SERVER_READY_TIMEOUT_MS,
  )

  console.log('  Сървърът е готов.')

  // ─── Регистрация на потребители ──────────────────────────────────────────

  console.log('\n[auth] Регистрация на потребители...')
  const runId = `${Date.now()}-${process.pid}`

  const adminEmail = `history-smoke-${runId}-admin@example.test`

  const userCookie = await registerAndGetCookie(port, runId, 'user')
  await registerAndGetCookie(port, runId, 'admin')

  promoteToAdmin(isolated.databaseFile, adminEmail)

  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: PASSWORD }),
  })
  const loginPayload = await loginRes.json() as { ok?: boolean }
  if (!loginPayload.ok) throw new Error('Admin login не е успешен след промотиране.')
  const loginHeadersExt = loginRes.headers as Headers & { getSetCookie?: () => string[] }
  const adminCookie =
    (loginHeadersExt.getSetCookie?.()[0] ?? loginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!adminCookie) throw new Error('Липсва Set-Cookie при admin login.')

  console.log('  Потребителите са регистрирани. Admin-ът е промотиран и има нова сесия.')

  // ─── [1] Без cookie → 403 ─────────────────────────────────────────────────

  console.log('\n[1] Без cookie → 403')
  {
    const r = await httpRequest(port, `${ENDPOINT}?window=1h`, 'GET')
    const b = r.body as Record<string, unknown>
    await check('[1.1] status 403 без cookie', () => {
      if (r.status !== 403) throw new Error(`Получен ${r.status}, очакван 403`)
    })
    await check('[1.2] ok: false без cookie', () => {
      if (b.ok !== false) throw new Error(`ok=${String(b.ok)}, очакван false`)
    })
  }

  // ─── [2] С cookie на обикновен потребител → 403 ───────────────────────────

  console.log('\n[2] С cookie на обикновен потребител → 403')
  {
    const r = await httpRequest(port, `${ENDPOINT}?window=1h`, 'GET', userCookie)
    const b = r.body as Record<string, unknown>
    await check('[2.1] status 403 с user cookie', () => {
      if (r.status !== 403) throw new Error(`Получен ${r.status}, очакван 403`)
    })
    await check('[2.2] ok: false с user cookie', () => {
      if (b.ok !== false) throw new Error(`ok=${String(b.ok)}, очакван false`)
    })
  }

  // ─── [3] Admin + window=1h → 200 + структура ──────────────────────────────

  console.log('\n[3] Admin cookie + window=1h → 200 + структура')
  let histResult1h: HistoryResponse | null = null
  {
    const r = await httpRequest(port, `${ENDPOINT}?window=1h`, 'GET', adminCookie)
    const b = r.body as Record<string, unknown>
    await check('[3.1] status 200', () => {
      if (r.status !== 200) throw new Error(`Получен ${r.status}, очакван 200`)
    })
    await check('[3.2] ok: true', () => {
      if (b.ok !== true) throw new Error(`ok=${String(b.ok)}, очакван true`)
    })
    await check('[3.3] window === "1h"', () => {
      if (b['window'] !== '1h') throw new Error(`window=${String(b['window'])}, очакван "1h"`)
    })
    await check('[3.4] points е масив', () => {
      if (!Array.isArray(b['points'])) throw new Error('points не е масив')
    })
    await check('[3.5] peaks е обект', () => {
      if (!b['peaks'] || typeof b['peaks'] !== 'object' || Array.isArray(b['peaks'])) {
        throw new Error('peaks не е обект')
      }
    })
    if (b.ok === true && Array.isArray(b['points']) && b['peaks']) {
      histResult1h = b as unknown as HistoryResponse
    }
  }

  // ─── [3b] Peaks полета ─────────────────────────────────────────────────────

  console.log('\n[3b] Peaks полета при window=1h (нов сървър — история е празна)')
  if (histResult1h !== null) {
    const pk = histResult1h.peaks

    await check('[3b.1] peaks.serverCpu е number | null', () => {
      if (pk.serverCpu !== null && typeof pk.serverCpu !== 'number') {
        throw new Error(`peaks.serverCpu=${String(pk.serverCpu)}`)
      }
    })
    await check('[3b.2] peaks.nodeCpu е number | null', () => {
      if (pk.nodeCpu !== null && typeof pk.nodeCpu !== 'number') {
        throw new Error(`peaks.nodeCpu=${String(pk.nodeCpu)}`)
      }
    })
    await check('[3b.3] peaks.ramUsedMb е number ≥ 0', () => {
      if (typeof pk.ramUsedMb !== 'number' || pk.ramUsedMb < 0) {
        throw new Error(`peaks.ramUsedMb=${pk.ramUsedMb}`)
      }
    })
    await check('[3b.4] peaks.ramPercent е number ≥ 0', () => {
      if (typeof pk.ramPercent !== 'number' || pk.ramPercent < 0) {
        throw new Error(`peaks.ramPercent=${pk.ramPercent}`)
      }
    })
    await check('[3b.5] peaks.rssMb е number ≥ 0', () => {
      if (typeof pk.rssMb !== 'number' || pk.rssMb < 0) {
        throw new Error(`peaks.rssMb=${pk.rssMb}`)
      }
    })
    await check('[3b.6] peaks.wsConns е integer ≥ 0', () => {
      if (!Number.isInteger(pk.wsConns) || pk.wsConns < 0) {
        throw new Error(`peaks.wsConns=${pk.wsConns}`)
      }
    })
    await check('[3b.7] peaks.onlinePlayers е integer ≥ 0', () => {
      if (!Number.isInteger(pk.onlinePlayers) || pk.onlinePlayers < 0) {
        throw new Error(`peaks.onlinePlayers=${pk.onlinePlayers}`)
      }
    })
    await check('[3b.8] peaks.activeRooms е integer ≥ 0', () => {
      if (!Number.isInteger(pk.activeRooms) || pk.activeRooms < 0) {
        throw new Error(`peaks.activeRooms=${pk.activeRooms}`)
      }
    })
    await check('[3b.9] peaks.mmWaiters е integer ≥ 0', () => {
      if (!Number.isInteger(pk.mmWaiters) || pk.mmWaiters < 0) {
        throw new Error(`peaks.mmWaiters=${pk.mmWaiters}`)
      }
    })
  } else {
    fail('[3b] peaks проверка пропусната — [3] не е минал', 'skip')
  }

  // ─── [3c] peakMoments форма ───────────────────────────────────────────────

  console.log('\n[3c] peakMoments форма при window=1h (нов сървър)')
  {
    const r = await httpRequest(port, `${ENDPOINT}?window=1h`, 'GET', adminCookie)
    const b = r.body as Record<string, unknown>

    await check('[3c.1] peakMoments е обект', () => {
      const pm = b['peakMoments']
      if (!pm || typeof pm !== 'object' || Array.isArray(pm)) {
        throw new Error(`peakMoments=${String(pm)}`)
      }
    })

    const pm = b['peakMoments'] as Record<string, unknown>

    const checkMomentField = async (field: string, checkN: string) => {
      await check(`[3c.${checkN}] peakMoments.${field} е { value: number, sampledAt: number|null }`, () => {
        const m = pm[field] as Record<string, unknown> | undefined
        if (!m || typeof m !== 'object') throw new Error(`${field} не е обект`)
        if (typeof m['value'] !== 'number') throw new Error(`${field}.value не е number: ${String(m['value'])}`)
        if (m['sampledAt'] !== null && typeof m['sampledAt'] !== 'number') {
          throw new Error(`${field}.sampledAt не е number|null: ${String(m['sampledAt'])}`)
        }
      })
      await check(`[3c.${checkN}b] peakMoments.${field}.value ≥ 0`, () => {
        const m = pm[field] as Record<string, unknown> | undefined
        const v = typeof m?.['value'] === 'number' ? m['value'] : -1
        if (v < 0) throw new Error(`${field}.value=${v}`)
      })
    }

    await checkMomentField('wsConns', '2')
    await checkMomentField('onlinePlayers', '3')
    await checkMomentField('activeRooms', '4')
    await checkMomentField('mmWaiters', '5')
  }

  // ─── [4] window=24h и window=7d → 200 + правилен window ───────────────────

  console.log('\n[4] window=24h и window=7d → 200 + правилен window')
  for (const w of ['24h', '7d'] as const) {
    const r = await httpRequest(port, `${ENDPOINT}?window=${w}`, 'GET', adminCookie)
    const b = r.body as Record<string, unknown>
    await check(`[4.${w}.1] status 200 за window=${w}`, () => {
      if (r.status !== 200) throw new Error(`Получен ${r.status}, очакван 200`)
    })
    await check(`[4.${w}.2] ok: true за window=${w}`, () => {
      if (b.ok !== true) throw new Error(`ok=${String(b.ok)}`)
    })
    await check(`[4.${w}.3] window полето е "${w}"`, () => {
      if (b['window'] !== w) throw new Error(`window=${String(b['window'])}, очакван "${w}"`)
    })
    await check(`[4.${w}.4] points е масив за window=${w}`, () => {
      if (!Array.isArray(b['points'])) throw new Error('points не е масив')
    })
    await check(`[4.${w}.5] peaks е обект за window=${w}`, () => {
      if (!b['peaks'] || typeof b['peaks'] !== 'object') throw new Error('peaks не е обект')
    })
    await check(`[4.${w}.6] peakMoments е обект за window=${w}`, () => {
      const pm = b['peakMoments']
      if (!pm || typeof pm !== 'object' || Array.isArray(pm)) {
        throw new Error(`peakMoments не е обект: ${String(pm)}`)
      }
    })
  }

  // ─── [5] Липсващ window параметър → 400 ──────────────────────────────────

  console.log('\n[5] Липсващ window параметър → 400')
  {
    const r = await httpRequest(port, ENDPOINT, 'GET', adminCookie)
    const b = r.body as Record<string, unknown>
    await check('[5.1] status 400 без window параметър', () => {
      if (r.status !== 400) throw new Error(`Получен ${r.status}, очакван 400`)
    })
    await check('[5.2] ok: false без window параметър', () => {
      if (b.ok !== false) throw new Error(`ok=${String(b.ok)}, очакван false`)
    })
  }

  // ─── [6] Невалидни window стойности → 400 ────────────────────────────────

  console.log('\n[6] Невалидни window стойности → 400')
  const invalidWindows: Array<[string, string]> = [
    ['30d', '?window=30d'],
    ['1H', '?window=1H'],
    ['празно', '?window='],
    ['2h', '?window=2h'],
    ['7D', '?window=7D'],
    ['24H', '?window=24H'],
  ]
  for (const [label, qs] of invalidWindows) {
    const r = await httpRequest(port, `${ENDPOINT}${qs}`, 'GET', adminCookie)
    const b = r.body as Record<string, unknown>
    await check(`[6.${label}.1] status 400 за window=${label}`, () => {
      if (r.status !== 400) throw new Error(`Получен ${r.status}, очакван 400`)
    })
    await check(`[6.${label}.2] ok: false за window=${label}`, () => {
      if (b.ok !== false) throw new Error(`ok=${String(b.ok)}, очакван false`)
    })
  }

  // ─── [7] POST с admin cookie → 405 ────────────────────────────────────────

  console.log('\n[7] POST към endpoint с admin cookie → 405')
  {
    const r = await httpRequest(port, `${ENDPOINT}?window=1h`, 'POST', adminCookie)
    const b = r.body as Record<string, unknown>
    await check('[7.1] status 405 за POST', () => {
      if (r.status !== 405) throw new Error(`Получен ${r.status}, очакван 405`)
    })
    await check('[7.2] ok: false за POST', () => {
      if (b.ok !== false) throw new Error(`ok=${String(b.ok)}, очакван false`)
    })
  }

  // ─── [8] Без secrets/stack traces в отговорите ───────────────────────────

  console.log('\n[8] Отговорите не съдържат secrets или stack traces')
  {
    // Проверяваме 200 отговора (най-богатия payload)
    const r = await httpRequest(port, `${ENDPOINT}?window=1h`, 'GET', adminCookie)
    const raw = JSON.stringify(r.body)

    await check('[8.1] Без "node:internal" в отговора', () => {
      if (raw.includes('node:internal')) throw new Error('node:internal намерен в response')
    })
    await check('[8.2] Без stack frame "    at " в отговора', () => {
      if (raw.includes('    at ')) throw new Error('Stack frame "    at " намерен в response')
    })
    await check('[8.3] Без Windows абсолютен path в отговора', () => {
      if (/[A-Za-z]:\\/.test(raw)) throw new Error('Windows path намерен в response')
    })
    await check('[8.4] Без Unix абсолютен path (дълъг) в отговора', () => {
      if (/\/[a-z]{2,}\/[a-z]{2,}/.test(raw)) throw new Error('Unix path намерен в response')
    })
    await check('[8.5] Без ".env" текст в отговора', () => {
      if (raw.includes('.env')) throw new Error('".env" намерен в response')
    })

    // Проверяваме и 400 отговора
    const r400 = await httpRequest(port, `${ENDPOINT}?window=invalid`, 'GET', adminCookie)
    const raw400 = JSON.stringify(r400.body)
    await check('[8.6] 400 отговор без stack traces', () => {
      if (raw400.includes('    at ')) throw new Error('Stack frame намерен в 400 response')
    })

    // Проверяваме и 403 отговора
    const r403 = await httpRequest(port, `${ENDPOINT}?window=1h`, 'GET')
    const raw403 = JSON.stringify(r403.body)
    await check('[8.7] 403 отговор без stack traces', () => {
      if (raw403.includes('    at ')) throw new Error('Stack frame намерен в 403 response')
    })
  }

} catch (err) {
  fail('Непредвидена грешка в smoke теста', err)
  if (server !== null) {
    console.error('\n[server output tail]:\n' + server.output().slice(-3000))
  }
  console.error(err)
} finally {
  // ─── Cleanup ──────────────────────────────────────────────────────────────
  console.log('\n[cleanup] Спиране на сървъра и изтриване на временните файлове...')

  if (server !== null) {
    try {
      await stopServer(server)
      console.log('  Сървърът е спрян.')
    } catch (err) {
      fail('Спиране на сървъра', err)
      console.error('[cleanup] Server stdout/stderr tail:')
      console.error(server!.output().slice(-3000))
    }
  }

  try {
    await isolated.cleanup()
    console.log('  Временните файлове са изтрити.')
  } catch (err) {
    fail('Изтриване на временните файлове', err)
  }
}

// ─── Резюме ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
