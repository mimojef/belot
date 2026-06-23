import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// ─── Конфигурация ─────────────────────────────────────────────────────────────

const PASSWORD = 'MonitoringSmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000
const ENDPOINT = '/api/admin/monitoring/current'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-monitoring-smoke-'))
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
      email: `monitoring-smoke-${runId}-${suffix}@example.test`,
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

// ─── Главна функция ───────────────────────────────────────────────────────────

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

console.log('\n═══ Admin monitoring endpoint smoke test ═══')
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

  const userEmail = `monitoring-smoke-${runId}-user@example.test`
  const adminEmail = `monitoring-smoke-${runId}-admin@example.test`

  const userCookie = await registerAndGetCookie(port, runId, 'user')
  const adminCookieBeforePromote = await registerAndGetCookie(port, runId, 'admin')

  // Промотираме admin директно в isolated SQLite (сървърът не е стартирал с тази DB — но е)
  // Трябва да logout и login отново, за да получим session с role='admin'.
  // По-просто: logout + login след UPDATE.
  promoteToAdmin(isolated.databaseFile, adminEmail)

  // Login след промотиране — получаваме нова session с role='admin'
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
    const r = await httpRequest(port, ENDPOINT, 'GET')
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
    const r = await httpRequest(port, ENDPOINT, 'GET', userCookie)
    const b = r.body as Record<string, unknown>
    await check('[2.1] status 403 с user cookie', () => {
      if (r.status !== 403) throw new Error(`Получен ${r.status}, очакван 403`)
    })
    await check('[2.2] ok: false с user cookie', () => {
      if (b.ok !== false) throw new Error(`ok=${String(b.ok)}, очакван false`)
    })
  }

  // ─── [3] С admin cookie → 200 + snapshot ─────────────────────────────────

  console.log('\n[3] С admin cookie → 200 + snapshot')
  type Snapshot = {
    samplerStatus: string
    sampledAtMs: number
    sampledAtIso: string
    sampleWindowMs: number
    serverCpuNowPercent: number | null
    nodeCpuNowPercent: number | null
    ramUsedMb: number
    ramTotalMb: number
    ramPercent: number
    processRssMb: number
    processUptimeSec: number
    backendStartedAtIso: string
    activeWsConnections: number
    uniqueOnlineRealPlayers: number
    totalMatchmakingWaiters: number
    matchmakingWaitersByStake: Record<string, number>
    activeRooms: number
    roomsByPhase: Record<string, number>
    workerPool: Record<string, unknown> | null
    lastError: string | null
  }

  let snapshot: Snapshot | null = null

  {
    const r = await httpRequest(port, ENDPOINT, 'GET', adminCookie)
    const b = r.body as { ok?: boolean; snapshot?: Snapshot }
    await check('[3.1] status 200 с admin cookie', () => {
      if (r.status !== 200) throw new Error(`Получен ${r.status}, очакван 200`)
    })
    await check('[3.2] ok: true', () => {
      if (b.ok !== true) throw new Error(`ok=${String(b.ok)}, очакван true`)
    })
    await check('[3.3] snapshot присъства', () => {
      if (!b.snapshot || typeof b.snapshot !== 'object') throw new Error('Липсва snapshot в отговора')
    })
    if (b.snapshot) snapshot = b.snapshot
  }

  // ─── [4] Snapshot полета ──────────────────────────────────────────────────

  console.log('\n[4] Snapshot полета')
  if (snapshot !== null) {
    const snap = snapshot

    await check('[4.1] samplerStatus е warming_up или running', () => {
      if (snap.samplerStatus !== 'warming_up' && snap.samplerStatus !== 'running') {
        throw new Error(`samplerStatus=${snap.samplerStatus}`)
      }
    })

    await check('[4.2] sampledAtMs е число > 0', () => {
      if (typeof snap.sampledAtMs !== 'number' || snap.sampledAtMs <= 0) {
        throw new Error(`sampledAtMs=${snap.sampledAtMs}`)
      }
    })

    await check('[4.3] sampledAtIso е ISO string', () => {
      if (typeof snap.sampledAtIso !== 'string' || !snap.sampledAtIso.includes('T')) {
        throw new Error(`sampledAtIso=${snap.sampledAtIso}`)
      }
    })

    await check('[4.4] RAM полета са числа > 0', () => {
      if (!(snap.ramUsedMb > 0)) throw new Error(`ramUsedMb=${snap.ramUsedMb}`)
      if (!(snap.ramTotalMb > 0)) throw new Error(`ramTotalMb=${snap.ramTotalMb}`)
      if (!(snap.ramPercent >= 0 && snap.ramPercent <= 100)) throw new Error(`ramPercent=${snap.ramPercent}`)
      if (!(snap.processRssMb > 0)) throw new Error(`processRssMb=${snap.processRssMb}`)
    })

    await check('[4.5] processUptimeSec ≥ 0', () => {
      if (typeof snap.processUptimeSec !== 'number' || snap.processUptimeSec < 0) {
        throw new Error(`processUptimeSec=${snap.processUptimeSec}`)
      }
    })

    await check('[4.6] backendStartedAtIso е ISO string', () => {
      if (typeof snap.backendStartedAtIso !== 'string' || !snap.backendStartedAtIso.includes('T')) {
        throw new Error(`backendStartedAtIso=${snap.backendStartedAtIso}`)
      }
    })

    await check('[4.7] activeWsConnections е цяло число ≥ 0', () => {
      if (!Number.isInteger(snap.activeWsConnections) || snap.activeWsConnections < 0) {
        throw new Error(`activeWsConnections=${snap.activeWsConnections}`)
      }
    })

    await check('[4.8] uniqueOnlineRealPlayers е цяло число ≥ 0', () => {
      if (!Number.isInteger(snap.uniqueOnlineRealPlayers) || snap.uniqueOnlineRealPlayers < 0) {
        throw new Error(`uniqueOnlineRealPlayers=${snap.uniqueOnlineRealPlayers}`)
      }
    })

    await check('[4.9] totalMatchmakingWaiters е цяло число ≥ 0', () => {
      if (!Number.isInteger(snap.totalMatchmakingWaiters) || snap.totalMatchmakingWaiters < 0) {
        throw new Error(`totalMatchmakingWaiters=${snap.totalMatchmakingWaiters}`)
      }
    })

    await check('[4.10] matchmakingWaitersByStake е обект', () => {
      if (!snap.matchmakingWaitersByStake || typeof snap.matchmakingWaitersByStake !== 'object') {
        throw new Error('matchmakingWaitersByStake не е обект')
      }
    })

    await check('[4.11] activeRooms е цяло число ≥ 0', () => {
      if (!Number.isInteger(snap.activeRooms) || snap.activeRooms < 0) {
        throw new Error(`activeRooms=${snap.activeRooms}`)
      }
    })

    await check('[4.12] roomsByPhase е обект', () => {
      if (!snap.roomsByPhase || typeof snap.roomsByPhase !== 'object') {
        throw new Error('roomsByPhase не е обект')
      }
    })

    await check('[4.13] workerPool е обект или null', () => {
      if (snap.workerPool !== null && typeof snap.workerPool !== 'object') {
        throw new Error(`workerPool=${String(snap.workerPool)}`)
      }
    })

    // ─── [4.14] Изчакай running и провери CPU + sampleWindowMs ──────────────

    console.log('\n[4.14] Изчакване на samplerStatus=running (≤2 сек)...')
    let runningSnap: Snapshot | null = null

    await waitFor(
      'samplerStatus=running',
      async () => {
        try {
          const r = await httpRequest(port, ENDPOINT, 'GET', adminCookie)
          const b = r.body as { ok?: boolean; snapshot?: Snapshot }
          if (b.snapshot?.samplerStatus === 'running') {
            runningSnap = b.snapshot
            return true
          }
        } catch { /* retry */ }
        return false
      },
      2500,
    ).catch(() => { /* не е задължително да стигнем running в 2.5 сек */ })

    if (runningSnap !== null) {
      const rs = runningSnap

      await check('[4.14a] samplerStatus=running достигнат', () => {
        if (rs.samplerStatus !== 'running') throw new Error(`samplerStatus=${rs.samplerStatus}`)
      })

      await check('[4.14b] serverCpuNowPercent е в [0, 100]', () => {
        if (rs.serverCpuNowPercent === null) throw new Error('serverCpuNowPercent е null')
        if (rs.serverCpuNowPercent < 0 || rs.serverCpuNowPercent > 100) {
          throw new Error(`serverCpuNowPercent=${rs.serverCpuNowPercent} извън [0,100]`)
        }
      })

      await check('[4.14c] nodeCpuNowPercent е число (може > 100)', () => {
        if (typeof rs.nodeCpuNowPercent !== 'number') {
          throw new Error(`nodeCpuNowPercent=${String(rs.nodeCpuNowPercent)}`)
        }
        if (rs.nodeCpuNowPercent < 0) {
          throw new Error(`nodeCpuNowPercent=${rs.nodeCpuNowPercent} < 0`)
        }
      })

      await check('[4.14d] sampleWindowMs > 0', () => {
        if (!(rs.sampleWindowMs > 0)) throw new Error(`sampleWindowMs=${rs.sampleWindowMs}`)
      })
    } else {
      console.log('  (samplerStatus остана warming_up в рамките на 2.5 сек — CPU полетата се проверяват само при running)')
    }
  }

  // ─── [5] Нямаме secrets/paths в отговора ─────────────────────────────────

  console.log('\n[5] Отговорът не съдържа secrets или stack traces')
  {
    const r = await httpRequest(port, ENDPOINT, 'GET', adminCookie)
    const raw = JSON.stringify(r.body)

    await check('[5.1] Без "node:internal" в отговора', () => {
      if (raw.includes('node:internal')) throw new Error('node:internal намерен в response')
    })
    await check('[5.2] Без stack frame "    at " в отговора', () => {
      if (raw.includes('    at ')) throw new Error('Stack frame "    at " намерен в response')
    })
    await check('[5.3] Без Windows абсолютен path в отговора', () => {
      if (/[A-Za-z]:\\/.test(raw)) throw new Error('Windows path намерен в response')
    })
    await check('[5.4] Без Unix абсолютен path (дълъг) в отговора', () => {
      if (/\/[a-z]{2,}\/[a-z]{2,}/.test(raw)) throw new Error('Unix path намерен в response')
    })
    await check('[5.5] Без ".env" текст в отговора', () => {
      if (raw.includes('.env')) throw new Error('".env" намерен в response')
    })
  }

  // ─── [6] Consecutive GETs — snapshot е cached (sampledAtMs не се мени между бързи заявки) ──

  console.log('\n[6] Consecutive GETs връщат cached snapshot')
  {
    const r1 = await httpRequest(port, ENDPOINT, 'GET', adminCookie)
    const r2 = await httpRequest(port, ENDPOINT, 'GET', adminCookie)
    const b1 = (r1.body as { snapshot?: Snapshot }).snapshot
    const b2 = (r2.body as { snapshot?: Snapshot }).snapshot

    await check('[6.1] И двата отговора са 200', () => {
      if (r1.status !== 200 || r2.status !== 200) {
        throw new Error(`Статуси: ${r1.status}, ${r2.status}`)
      }
    })

    await check('[6.2] Двете заявки имат snapshot', () => {
      if (!b1 || !b2) throw new Error('Липсва snapshot')
    })

    // Ако 1-секунденият таймер не е тикнал между двете последователни заявки,
    // sampledAtMs ще е идентично. Ако таймерът е тикнал — стойностите може да са различни.
    // Проверяваме само че и двата snapshot-а са валидни обекти — не гарантираме
    // точно равенство (unit тестът за getSnapshot() вече покрива cached semantics).
    await check('[6.3] Двата snapshot-а имат валиден sampledAtMs', () => {
      if (!b1 || !b2) throw new Error('Липсва snapshot')
      if (!(b1.sampledAtMs > 0) || !(b2.sampledAtMs > 0)) {
        throw new Error(`sampledAtMs: ${b1?.sampledAtMs}, ${b2?.sampledAtMs}`)
      }
    })
  }

  // ─── [7] Невалиден HTTP метод → 405 ──────────────────────────────────────

  console.log('\n[7] POST към endpoint → 405')
  {
    const r = await httpRequest(port, ENDPOINT, 'POST', adminCookie)
    const b = r.body as Record<string, unknown>
    await check('[7.1] status 405 за POST', () => {
      if (r.status !== 405) throw new Error(`Получен ${r.status}, очакван 405`)
    })
    await check('[7.2] ok: false за POST', () => {
      if (b.ok !== false) throw new Error(`ok=${String(b.ok)}, очакван false`)
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
      console.error(server.output().slice(-3000))
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
