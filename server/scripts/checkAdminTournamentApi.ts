import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'AdminTournamentSmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    console.error(`  FAIL ${label}: ${message}`)
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a free port.')))
        return
      }
      const { port } = address
      server.close(() => resolvePort(port))
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
    if (cookie) headers.Cookie = cookie
    let payload: string | undefined
    if (jsonBody !== undefined) {
      payload = JSON.stringify(jsonBody)
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(payload))
    }

    const req = request(
      { hostname: '127.0.0.1', port, path: pathname, method, headers, timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          let body: unknown = null
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
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
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout while waiting for ${label}.`)
}

type RunningServer = {
  child: ChildProcessWithoutNullStreams
  closed: Promise<void>
  output(): string
}

async function removeTempRoot(root: string): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code) || attempt === 6) throw error
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
  const root = await mkdtemp(join(tmpdir(), 'belot-admin-tournament-api-'))
  const serverDir = join(root, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(originalServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(originalServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })

  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(originalServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(originalServerRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)

  return {
    root,
    serverDir,
    databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: async () => removeTempRoot(root),
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
  child.stdout.on('data', (chunk: string) => chunks.push(chunk))
  child.stderr.on('data', (chunk: string) => chunks.push(chunk))
  const closed = new Promise<void>((resolveClosed) => {
    child.once('close', () => resolveClosed())
  })
  return { child, closed, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode === null) server.child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (server.child.exitCode === null) server.child.kill('SIGKILL')
  }, 10_000)
  try {
    await server.closed
  } finally {
    clearTimeout(timer)
  }
}

type RegisteredUser = { cookie: string; email: string; profileId: string }

async function register(port: number, runId: string, suffix: string): Promise<RegisteredUser> {
  const email = `admin-tournament-${runId}-${suffix}@example.test`
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      displayName: `Admin Tournament ${suffix}`,
      gender: 'male',
    }),
  })
  if (response.status !== 200) throw new Error(`register status=${response.status}`)
  const payload = await response.json() as {
    ok?: boolean
    session?: { profile: { profileId: string } }
    message?: string
  }
  if (!payload.ok || !payload.session) throw new Error(`register failed: ${payload.message ?? '?'}`)
  const headersExt = response.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
  if (!rawCookie) throw new Error('missing Set-Cookie')
  return {
    cookie: rawCookie.split(';')[0]!,
    email,
    profileId: payload.session.profile.profileId,
  }
}

function promoteAccount(databaseFile: string, email: string, role: 'admin' | 'subadmin'): void {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA journal_mode = WAL;')
    database.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?;`).run(role, email)
  } finally {
    database.close()
  }
}

function containsSensitiveAdminFields(payload: unknown): boolean {
  const raw = JSON.stringify(payload)
  return /password_hash|passwordHash|sessionId|accountId|connectionId|token_hash|reconnectToken|ledger_id|balance_after|yellowCoinsBalance/i.test(raw)
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\ncheckAdminTournamentApi')
console.log(`Server root: ${sourceServerRoot}`)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null

try {
  server = startServer(isolated.serverDir, port)
  await waitFor('server health', async () => {
    try {
      const response = await httpRequest(port, '/health', 'GET')
      const body = response.body as { ok?: boolean }
      return response.status === 200 && body.ok === true
    } catch {
      return false
    }
  }, SERVER_READY_TIMEOUT_MS)

  const runId = `${Date.now()}-${process.pid}`
  const player = await register(port, runId, 'player')
  const admin = await register(port, runId, 'admin')
  const subadmin = await register(port, runId, 'subadmin')
  promoteAccount(isolated.databaseFile, admin.email, 'admin')
  promoteAccount(isolated.databaseFile, subadmin.email, 'subadmin')

  let tournamentId = ''
  await check('regular player can create fixture tournament', async () => {
    const response = await httpRequest(port, '/api/tournaments', 'POST', player.cookie, {
      name: 'Admin Panel Fixture',
      entryFee: 20_000,
      visibility: 'public',
      startMode: 'fill',
    })
    assert(response.status === 200, `status=${response.status}, body=${JSON.stringify(response.body)}`)
    const body = response.body as { ok?: boolean; tournament?: { tournamentId?: string } }
    assert(body.ok === true && typeof body.tournament?.tournamentId === 'string', 'missing tournament id')
    tournamentId = body.tournament.tournamentId
  })

  await check('anonymous admin tournament list is forbidden', async () => {
    const response = await httpRequest(port, '/api/admin/tournaments', 'GET')
    assert(response.status === 403, `status=${response.status}`)
  })

  await check('player admin tournament list is forbidden', async () => {
    const response = await httpRequest(port, '/api/admin/tournaments', 'GET', player.cookie)
    assert(response.status === 403, `status=${response.status}`)
  })

  await check('subadmin can read list but cannot write', async () => {
    const response = await httpRequest(port, '/api/admin/tournaments?limit=10&status=open', 'GET', subadmin.cookie)
    assert(response.status === 200, `status=${response.status}, body=${JSON.stringify(response.body)}`)
    const body = response.body as { ok?: boolean; canWrite?: boolean; viewerRole?: string; tournaments?: Array<{ tournamentId: string }> }
    assert(body.ok === true && body.viewerRole === 'subadmin' && body.canWrite === false, JSON.stringify(body))
    assert(body.tournaments?.some((row) => row.tournamentId === tournamentId) === true, 'fixture tournament not listed')
    assert(!containsSensitiveAdminFields(body), 'sensitive field leaked in list response')
  })

  await check('subadmin can read detail safely', async () => {
    const response = await httpRequest(port, `/api/admin/tournaments/${tournamentId}`, 'GET', subadmin.cookie)
    assert(response.status === 200, `status=${response.status}, body=${JSON.stringify(response.body)}`)
    const body = response.body as { ok?: boolean; canWrite?: boolean; viewerRole?: string; tournament?: { tournamentId?: string; integrity?: { state?: string } } }
    assert(body.ok === true && body.viewerRole === 'subadmin' && body.canWrite === false, JSON.stringify(body))
    assert(body.tournament?.tournamentId === tournamentId, 'detail tournament mismatch')
    assert(body.tournament.integrity?.state === 'healthy', `integrity=${JSON.stringify(body.tournament?.integrity)}`)
    assert(!containsSensitiveAdminFields(body), 'sensitive field leaked in detail response')
  })

  await check('subadmin cannot reconcile or cancel-open', async () => {
    const reconcile = await httpRequest(port, `/api/admin/tournaments/${tournamentId}/reconcile`, 'POST', subadmin.cookie)
    const cancel = await httpRequest(port, `/api/admin/tournaments/${tournamentId}/cancel-open`, 'POST', subadmin.cookie)
    assert(reconcile.status === 403, `reconcile status=${reconcile.status}`)
    assert(cancel.status === 403, `cancel status=${cancel.status}`)
  })

  await check('admin can read detail with write permission', async () => {
    const response = await httpRequest(port, `/api/admin/tournaments/${tournamentId}`, 'GET', admin.cookie)
    assert(response.status === 200, `status=${response.status}`)
    const body = response.body as { ok?: boolean; canWrite?: boolean; viewerRole?: string }
    assert(body.ok === true && body.viewerRole === 'admin' && body.canWrite === true, JSON.stringify(body))
  })

  await check('admin cancel-open succeeds and is idempotent', async () => {
    const first = await httpRequest(port, `/api/admin/tournaments/${tournamentId}/cancel-open`, 'POST', admin.cookie)
    assert(first.status === 200, `first status=${first.status}, body=${JSON.stringify(first.body)}`)
    const firstBody = first.body as { ok?: boolean; alreadyCancelled?: boolean }
    assert(firstBody.ok === true && firstBody.alreadyCancelled === false, JSON.stringify(firstBody))

    const second = await httpRequest(port, `/api/admin/tournaments/${tournamentId}/cancel-open`, 'POST', admin.cookie)
    assert(second.status === 200, `second status=${second.status}, body=${JSON.stringify(second.body)}`)
    const secondBody = second.body as { ok?: boolean; alreadyCancelled?: boolean }
    assert(secondBody.ok === true && secondBody.alreadyCancelled === true, JSON.stringify(secondBody))
  })

  await check('invalid admin tournament filters are rejected', async () => {
    const response = await httpRequest(port, '/api/admin/tournaments?limit=101', 'GET', admin.cookie)
    assert(response.status === 400, `status=${response.status}`)
  })

  await check('health exposes tournament operation aggregates only', async () => {
    const response = await httpRequest(port, '/health', 'GET')
    assert(response.status === 200, `status=${response.status}`)
    const body = response.body as { tournamentOperations?: unknown }
    assert(body.tournamentOperations !== undefined, 'missing tournamentOperations')
    const raw = JSON.stringify(body.tournamentOperations)
    assert(!raw.includes(tournamentId) && !raw.includes(admin.profileId), 'health leaked identifiers')
  })
} finally {
  if (server !== null) {
    await stopServer(server)
    const output = server.output()
    if (failed > 0 && output.trim().length > 0) {
      console.error('\nServer output:')
      console.error(output)
    }
  }
  await isolated.cleanup()
}

if (failed > 0) {
  console.error(`checkAdminTournamentApi failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`checkAdminTournamentApi passed: ${passed} checks.`)
