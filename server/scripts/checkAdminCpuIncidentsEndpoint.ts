import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// ─── Конфигурация ─────────────────────────────────────────────────────────────

const PASSWORD = 'CpuIncidentSmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000
const LIST_ENDPOINT = '/api/admin/monitoring/cpu-incidents'

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

function httpRequest(port: number, pathname: string, method: string, cookie?: string): Promise<HttpResult> {
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

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
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
  const root = await mkdtemp(join(tmpdir(), 'belot-cpu-incidents-smoke-'))
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

// ─── Роля/session helpers ──────────────────────────────────────────────────────

function promoteRole(databaseFile: string, email: string, role: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?`).run(role, email)
  db.close()
}

// Директно вкарване на compact incident redovete в изолираната DB — избягва
// нуждата да симулираме реален sustained CPU spike в теста (бавно/нестабилно);
// целта тук е auth/schema/privacy на HTTP слоя, не state machine-а самия него
// (той вече е покрит от checkCpuIncidentDetector.ts/checkCpuIncidentStore.ts).
function seedIncidentRow(databaseFile: string): number {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  const result = db.prepare(`
    INSERT INTO monitoring_cpu_incidents (
      detection_type, started_at, ended_at, duration_ms,
      process_cpu_max, process_cpu_avg, process_cpu_p95,
      server_cpu_max, game_worker_cpu_max, non_game_worker_process_cpu_max,
      event_loop_utilization_max, event_loop_delay_p99_max_ms, rss_max_mb,
      online_players_avg, active_matches_avg, ws_connections_avg,
      gameplay_per_min, lobby_chat_per_min, direct_chat_per_min,
      pika_team_chat_per_min, official_support_per_min, private_room_chat_per_min,
      topics_per_min, lafche_per_min, http_per_min,
      top_http_categories_json, top_ws_inbound_types_json, top_ws_outbound_types_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'sustained_high', Date.now() - 60_000, Date.now(), 60_000,
    105.9, 91.7, 100.2,
    38.2, null, null,
    null, null, 220.5,
    83, 27, 86,
    1185, 84, 96,
    12, 3, 8,
    21, 37, 510,
    '{"topics":21,"admin":5}', '{"submit_bid_action":40}', '{"room_snapshot":300}',
  )
  const incidentId = Number(result.lastInsertRowid)
  db.prepare(`
    INSERT INTO monitoring_cpu_incident_samples (
      incident_id, t, sample_resolution_ms, process_cpu, server_cpu,
      game_worker_cpu, non_game_worker_process_cpu, event_loop_utilization,
      event_loop_delay_p99_ms, rss_mb, online_players, active_matches, ws_connections
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(incidentId, Date.now() - 30_000, 10_000, 92.5, 40.1, null, null, null, null, 210, 80, 25, 84)
  db.close()
  return incidentId
}

async function register(port: number, runId: string, suffix: string): Promise<{ email: string; cookie: string }> {
  const email = `cpu-incidents-smoke-${runId}-${suffix}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName: `Smoke ${suffix}`, gender: 'male' }),
  })
  if (res.status !== 200) throw new Error(`Регистрацията на ${suffix} върна status ${res.status}.`)
  const payload = await res.json() as { ok?: boolean; message?: string }
  if (!payload.ok) throw new Error(`Регистрацията на ${suffix} не е успешна: ${payload.message ?? '?'}`)
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  if (!rawCookie) throw new Error(`Липсва Set-Cookie при регистрация на ${suffix}.`)
  return { email, cookie: rawCookie.split(';')[0]! }
}

async function login(port: number, email: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const payload = await res.json() as { ok?: boolean }
  if (!payload.ok) throw new Error(`Login не е успешен за ${email}.`)
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const cookie = (headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0]
  if (!cookie) throw new Error(`Липсва Set-Cookie при login за ${email}.`)
  return cookie
}

// ─── Главна функция ───────────────────────────────────────────────────────────

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

console.log('\n═══ Admin CPU incidents endpoint smoke test ═══')
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

  console.log('\n[auth] Регистрация на потребители...')
  const runId = `${Date.now()}-${process.pid}`

  const player = await register(port, runId, 'player')
  const adminCandidate = await register(port, runId, 'admin')
  const subadminCandidate = await register(port, runId, 'subadmin')

  promoteRole(isolated.databaseFile, adminCandidate.email, 'admin')
  promoteRole(isolated.databaseFile, subadminCandidate.email, 'subadmin')

  const adminCookie = await login(port, adminCandidate.email)
  const subadminCookie = await login(port, subadminCandidate.email)

  console.log('  Регистрирани: player, admin, subadmin.')

  console.log('\n[seed] Вкарване на compact incident ред директно в DB...')
  const incidentId = seedIncidentRow(isolated.databaseFile)
  console.log(`  incident id=${incidentId}`)

  // ─── [1] Без cookie → 403 ─────────────────────────────────────────────────

  console.log('\n[1] Без cookie → 403')
  {
    const r = await httpRequest(port, LIST_ENDPOINT, 'GET')
    const b = r.body as Record<string, unknown>
    await check('[1.1] status 403 без cookie', () => {
      if (r.status !== 403) throw new Error(`Получен ${r.status}, очакван 403`)
    })
    await check('[1.2] ok: false без cookie', () => {
      if (b.ok !== false) throw new Error(`ok=${String(b.ok)}, очакван false`)
    })
  }

  // ─── [2] Обикновен player → 403 ────────────────────────────────────────────

  console.log('\n[2] Обикновен player cookie → 403')
  {
    const r = await httpRequest(port, LIST_ENDPOINT, 'GET', player.cookie)
    await check('[2.1] status 403 с player cookie', () => {
      if (r.status !== 403) throw new Error(`Получен ${r.status}, очакван 403`)
    })
  }

  // ─── [3] Admin → 200 ───────────────────────────────────────────────────────

  console.log('\n[3] Admin cookie → 200 + списък')
  let listBody: { ok?: boolean; incidents?: unknown[] } | null = null
  {
    const r = await httpRequest(port, LIST_ENDPOINT, 'GET', adminCookie)
    const b = r.body as { ok?: boolean; incidents?: unknown[] }
    await check('[3.1] status 200 за admin', () => {
      if (r.status !== 200) throw new Error(`Получен ${r.status}, очакван 200`)
    })
    await check('[3.2] ok: true', () => {
      if (b.ok !== true) throw new Error(`ok=${String(b.ok)}`)
    })
    await check('[3.3] incidents е масив', () => {
      if (!Array.isArray(b.incidents)) throw new Error('incidents не е масив')
    })
    await check('[3.4] seeded incident присъства в списъка', () => {
      if (!Array.isArray(b.incidents) || b.incidents.length === 0) throw new Error('празен списък')
    })
    listBody = b
  }

  // ─── [4] Subadmin → 200 (същия достъп като admin за read-only diagnostics) ──

  console.log('\n[4] Subadmin cookie → 200 (read-only diagnostics, същия pattern като /monitoring/history)')
  {
    const r = await httpRequest(port, LIST_ENDPOINT, 'GET', subadminCookie)
    await check('[4.1] status 200 за subadmin', () => {
      if (r.status !== 200) throw new Error(`Получен ${r.status}, очакван 200`)
    })
  }

  // ─── [5] Response schema — summary полета ──────────────────────────────────

  console.log('\n[5] Response schema — summary полета')
  if (listBody?.incidents && listBody.incidents.length > 0) {
    const item = listBody.incidents[0] as Record<string, unknown>
    await check('[5.1] id е число', () => {
      if (typeof item.id !== 'number') throw new Error(`id=${String(item.id)}`)
    })
    await check('[5.2] detectionType е string', () => {
      if (typeof item.detectionType !== 'string') throw new Error(`detectionType=${String(item.detectionType)}`)
    })
    await check('[5.3] startedAtMs/endedAtMs/durationMs присъстват', () => {
      if (typeof item.startedAtMs !== 'number') throw new Error('startedAtMs липсва')
      if (item.endedAtMs !== null && typeof item.endedAtMs !== 'number') throw new Error('endedAtMs невалиден')
      if (item.durationMs !== null && typeof item.durationMs !== 'number') throw new Error('durationMs невалиден')
    })
    await check('[5.4] activityRates е обект с числови полета', () => {
      const ar = item.activityRates as Record<string, unknown> | undefined
      if (!ar || typeof ar !== 'object') throw new Error('activityRates липсва')
      if (typeof ar.gameplayPerMin !== 'number') throw new Error('gameplayPerMin невалиден')
      if (typeof ar.officialSupportPerMin !== 'number') throw new Error('officialSupportPerMin невалиден')
      if (typeof ar.pikaTeamChatPerMin !== 'number') throw new Error('pikaTeamChatPerMin невалиден')
    })
  }

  // ─── [6] Detail endpoint — admin → 200 + timeline ──────────────────────────

  console.log('\n[6] Detail endpoint (admin) → 200 + timeline')
  {
    const r = await httpRequest(port, `${LIST_ENDPOINT}/${incidentId}`, 'GET', adminCookie)
    const b = r.body as { ok?: boolean; summary?: unknown; timeline?: unknown[] }
    await check('[6.1] status 200', () => {
      if (r.status !== 200) throw new Error(`Получен ${r.status}, очакван 200`)
    })
    await check('[6.2] summary присъства', () => {
      if (!b.summary) throw new Error('summary липсва')
    })
    await check('[6.3] timeline е масив', () => {
      if (!Array.isArray(b.timeline)) throw new Error('timeline не е масив')
    })
    await check('[6.4] timeline съдържа seeded-ия sample', () => {
      if (!Array.isArray(b.timeline) || b.timeline.length === 0) throw new Error('празен timeline')
    })
  }

  // ─── [7] Detail endpoint — непознат id → 404 ───────────────────────────────

  console.log('\n[7] Detail endpoint — непознат id → 404')
  {
    const r = await httpRequest(port, `${LIST_ENDPOINT}/999999999`, 'GET', adminCookie)
    await check('[7.1] status 404 за непознат id', () => {
      if (r.status !== 404) throw new Error(`Получен ${r.status}, очакван 404`)
    })
  }

  // ─── [8] Detail endpoint — player → 403 ────────────────────────────────────

  console.log('\n[8] Detail endpoint — обикновен player → 403')
  {
    const r = await httpRequest(port, `${LIST_ENDPOINT}/${incidentId}`, 'GET', player.cookie)
    await check('[8.1] status 403 за player на detail endpoint', () => {
      if (r.status !== 403) throw new Error(`Получен ${r.status}, очакван 403`)
    })
  }

  // ─── [9] POST → 405 ─────────────────────────────────────────────────────────

  console.log('\n[9] POST към list endpoint (admin cookie) → 405')
  {
    const r = await httpRequest(port, LIST_ENDPOINT, 'POST', adminCookie)
    await check('[9.1] status 405', () => {
      if (r.status !== 405) throw new Error(`Получен ${r.status}, очакван 405`)
    })
  }

  // ─── [10] Privacy — отговорите не съдържат чувствителна информация ────────

  console.log('\n[10] Отговорите не съдържат secrets, stack traces, или chat съдържание')
  {
    const rList = await httpRequest(port, LIST_ENDPOINT, 'GET', adminCookie)
    const rDetail = await httpRequest(port, `${LIST_ENDPOINT}/${incidentId}`, 'GET', adminCookie)
    const combined = JSON.stringify(rList.body) + JSON.stringify(rDetail.body)
    await check('[10.1] Без "node:internal" в отговора', () => {
      if (combined.includes('node:internal')) throw new Error('намерен node:internal')
    })
    await check('[10.2] Без stack frame "    at " в отговора', () => {
      if (combined.includes('    at ')) throw new Error('намерен stack frame')
    })
    await check('[10.3] Без Windows абсолютен path', () => {
      if (/[A-Za-z]:\\\\/.test(combined)) throw new Error('намерен Windows path')
    })
    await check('[10.4] Без имейл адреси (player/admin/subadmin)', () => {
      if (combined.includes('@example.test')) throw new Error('намерен email адрес')
    })
    await check('[10.5] Без password стойност', () => {
      if (combined.includes(PASSWORD)) throw new Error('намерена парола')
    })
  }

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`Passed: ${passed}  Failed: ${failed}`)

  if (server) {
    console.log('\n[cleanup] Спиране на сървъра и изтриване на временните файлове...')
    await stopServer(server)
    console.log('  Сървърът е спрян.')
  }
  await isolated.cleanup()
  console.log('  Временните файлове са изтрити.')

  if (failed > 0) process.exit(1)
} catch (error) {
  console.error('\n[fatal]', error)
  if (server) {
    console.log(`\n[debug] Server output:\n${server.output().slice(-4000)}`)
    await stopServer(server)
  }
  await isolated.cleanup()
  process.exit(1)
}
