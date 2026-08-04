import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE,
  PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE,
} from '../src/db/normalizeProfileIdentityText.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const PASSWORD = 'ProfileNameHttp1!'
const SERVER_READY_TIMEOUT_MS = 45_000

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`PASS ${label}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
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
      server.close(() => resolvePort(address.port))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

type RunningServer = {
  child: ChildProcessWithoutNullStreams
  output: () => string
}

async function createIsolatedServerRoot(): Promise<{
  root: string
  serverDir: string
  databaseFile: string
  cleanup: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-profile-name-http-'))
  const serverDir = join(root, 'server')

  await mkdir(serverDir, { recursive: true })
  await cp(join(serverRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(serverRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(serverRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(serverRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })

  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(serverRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(serverRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)

  return {
    root,
    serverDir,
    databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: () => rm(root, { recursive: true, force: true }),
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
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (server === null || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      server.child.kill('SIGKILL')
      resolveStop()
    }, 10_000)
    server.child.once('exit', () => {
      clearTimeout(timeout)
      resolveStop()
    })
  })
}

async function waitForServer(port: number, server: RunningServer): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Server exited early:\n${server.output()}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return
    } catch {
      // Retry until ready or timeout.
    }
    await sleep(150)
  }
  throw new Error(`Server did not become ready:\n${server.output()}`)
}

type JsonResponse = {
  status: number
  body: { ok?: boolean; message?: string; code?: string; session?: { profile: { profileId: string }; account: { accountId: string } } }
  cookie: string | null
}

async function postJson(
  port: number,
  pathname: string,
  body: unknown,
  options: { method?: 'POST' | 'PATCH'; cookie?: string | null } = {},
): Promise<JsonResponse> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: options.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as JsonResponse['body']
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? null
  return { status: response.status, body: payload, cookie }
}

function assertValidationError(
  response: JsonResponse,
  expectedCode: 'MIXED_ALPHABETS' | 'RESERVED_PIKA_NAME',
  expectedMessage: string,
): void {
  assert(response.status === 400, `expected HTTP 400, got ${response.status}`)
  assert(response.body.ok === false, `expected ok=false, got ${String(response.body.ok)}`)
  assert(response.body.code === expectedCode, `expected code=${expectedCode}, got ${response.body.code ?? '(missing)'}`)
  assert(response.body.message === expectedMessage, `expected exact message mismatch: ${response.body.message ?? '(missing)'}`)
}

async function register(port: number, email: string, displayName: string): Promise<{ cookie: string; profileId: string }> {
  const response = await postJson(port, '/api/auth/register', {
    email,
    password: PASSWORD,
    displayName,
    gender: 'male',
  })
  assert(response.status === 200, `register ${email} status=${response.status} message=${response.body.message ?? ''}`)
  assert(response.body.ok === true && response.body.session !== undefined, 'register payload missing session')
  assert(response.cookie !== null, 'register response missing cookie')
  return { cookie: response.cookie, profileId: response.body.session.profile.profileId }
}

async function login(port: number, email: string): Promise<string> {
  const response = await postJson(port, '/api/auth/login', { email, password: PASSWORD })
  assert(response.status === 200, `login ${email} status=${response.status}`)
  assert(response.cookie !== null, 'login response missing cookie')
  return response.cookie
}

function promoteToAdmin(databaseFile: string, email: string): void {
  const db = new DatabaseSync(databaseFile)
  try {
    db.exec('PRAGMA journal_mode = WAL;')
    db.prepare(`UPDATE accounts SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE email = ?`).run(email)
  } finally {
    db.close()
  }
}

async function main(): Promise<void> {
  const isolated = await createIsolatedServerRoot()
  const port = await getFreePort()
  let server: RunningServer | null = null

  try {
    server = startServer(isolated.serverDir, port)
    await waitForServer(port, server)

    await check('[1] direct register API rejects mixed-script name', async () => {
      const response = await postJson(port, '/api/auth/register', {
        email: 'mixed-http@example.test',
        password: PASSWORD,
        displayName: '\u041Cilen',
        gender: 'male',
      })
      assertValidationError(response, 'MIXED_ALPHABETS', PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE)
    })

    await check('[2] direct register API rejects reserved PIKABG variant', async () => {
      const response = await postJson(port, '/api/auth/register', {
        email: 'reserved-http@example.test',
        password: PASSWORD,
        displayName: 'P I K A B G',
        gender: 'female',
      })
      assertValidationError(response, 'RESERVED_PIKA_NAME', PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE)
    })

    await check('[3] direct self rename API rejects mixed-script name', async () => {
      const player = await register(port, 'self-rename-http@example.test', 'Self Rename')
      const response = await postJson(
        port,
        '/api/profile/me/display-name',
        { displayName: 'Pika \u0411\u0413' },
        { cookie: player.cookie },
      )
      assertValidationError(response, 'MIXED_ALPHABETS', PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE)
    })

    await check('[4] direct admin rename API rejects reserved PIKABG variant', async () => {
      const adminEmail = 'admin-http@example.test'
      await register(port, adminEmail, 'Http Admin')
      promoteToAdmin(isolated.databaseFile, adminEmail)
      const adminCookie = await login(port, adminEmail)
      const target = await register(port, 'admin-target-http@example.test', 'Http Target')
      const response = await postJson(
        port,
        `/api/admin/profiles/${encodeURIComponent(target.profileId)}/display-name`,
        { displayName: 'P I K A B G' },
        { method: 'PATCH', cookie: adminCookie },
      )
      assertValidationError(response, 'RESERVED_PIKA_NAME', PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE)
    })

    await check('[5] direct register API rejects reserved name via containment bypass attempts', async () => {
      const response = await postJson(port, '/api/auth/register', {
        email: 'bypass-http@example.test',
        password: PASSWORD,
        displayName: 'MYPIKABG',
        gender: 'male',
      })
      assertValidationError(response, 'RESERVED_PIKA_NAME', PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE)
    })

    await check('[6] direct self rename API rejects Cyrillic reserved containment bypass attempts', async () => {
      const player = await register(port, 'bypass-cyrillic-http@example.test', 'Bypass Cyrillic')
      const response = await postJson(
        port,
        '/api/profile/me/display-name',
        { displayName: 'ПИКАБГ игра' },
        { cookie: player.cookie },
      )
      assertValidationError(response, 'RESERVED_PIKA_NAME', PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE)
    })
  } finally {
    await stopServer(server)
    await isolated.cleanup()
  }

  console.log(`\nProfile display name HTTP API checks: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

await main()
