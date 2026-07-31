/**
 * Regression: leaving/refunding a solo tournament entry must restore the
 * unregistered entry actions and allow a fresh paid rejoin in the same tournament.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'TournamentLeaveRejoin1!'
const SESSION_COOKIE_NAME = 'belot_session'
const SERVER_READY_TIMEOUT_MS = 30_000

type HttpResult = { status: number; body: any }
type RunningServer = {
  child: ChildProcessWithoutNullStreams
  closed: Promise<void>
  output(): string
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
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

async function waitFor(label: string, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout while waiting for ${label}.`)
}

async function httpRequest(
  port: number,
  pathname: string,
  method: string,
  cookie?: string,
  jsonBody?: unknown,
): Promise<HttpResult> {
  const headers: Record<string, string> = {}
  if (cookie) headers.Cookie = cookie
  if (jsonBody !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
  })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // not JSON
  }
  return { status: response.status, body }
}

async function createIsolatedServerRoot(originalServerRoot: string): Promise<{
  root: string
  serverDir: string
  databaseFile: string
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-tournament-leave-rejoin-'))
  const serverDir = join(root, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(originalServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(
    join(originalServerRoot, 'database', 'migrations'),
    join(serverDir, 'database', 'migrations'),
    { recursive: true, preserveTimestamps: true },
  )
  await cp(join(originalServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })

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
  child.stdout.on('data', (chunk: string) => chunks.push(chunk))
  child.stderr.on('data', (chunk: string) => chunks.push(chunk))
  return {
    child,
    closed: new Promise((resolveClosed) => child.once('close', () => resolveClosed())),
    output: () => chunks.join(''),
  }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode === null) server.child.kill('SIGTERM')
  const forceKillTimer = setTimeout(() => {
    if (server.child.exitCode === null) server.child.kill('SIGKILL')
  }, 10_000)
  try {
    await server.closed
  } finally {
    clearTimeout(forceKillTimer)
  }
}

function smokeEmail(runId: string, suffix: string): string {
  return `tournament-leave-rejoin-${runId}-${suffix}@example.test`
}

async function registerAndGetCookie(port: number, runId: string, suffix: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: smokeEmail(runId, suffix),
      password: PASSWORD,
      displayName: `Leave Rejoin ${suffix}`,
      gender: 'male',
    }),
  })
  assert(response.status === 200, `register ${suffix} status=${response.status}`)
  const body = await response.json() as { ok?: boolean; message?: string }
  assert(body.ok === true, `register ${suffix} failed: ${body.message ?? '?'}`)
  const headersExt = response.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
  assert(typeof rawCookie === 'string' && rawCookie.length > 0, 'missing Set-Cookie')
  return rawCookie.split(';')[0] ?? `${SESSION_COOKIE_NAME}=missing`
}

async function getWalletBalance(port: number, cookie: string): Promise<number> {
  const response = await httpRequest(port, '/api/auth/me', 'GET', cookie)
  assert(response.status === 200 && response.body.ok === true, 'auth/me failed')
  return response.body.session.profile.yellowCoinsBalance
}

async function createTournament(port: number, cookie: string): Promise<{ tournamentId: string }> {
  const response = await httpRequest(port, '/api/tournaments', 'POST', cookie, {
    name: 'Leave Rejoin Regression',
    entryFee: 5000,
    visibility: 'public',
    startMode: 'fill',
  })
  assert(response.status === 200 && response.body.ok === true, `create tournament failed: ${JSON.stringify(response.body)}`)
  return { tournamentId: response.body.tournament.tournamentId }
}

async function assertEntryActionsRestored(port: number, tournamentId: string, cookie: string): Promise<void> {
  const detail = await httpRequest(port, `/api/tournaments/${tournamentId}`, 'GET', cookie)
  assert(detail.status === 200 && detail.body.ok === true, `detail failed: ${detail.status}`)
  const tournament = detail.body.tournament
  assert(tournament.confirmedEntriesCount === 0, `confirmedEntriesCount=${tournament.confirmedEntriesCount}`)
  assert(tournament.viewer.isParticipant === false, 'viewer still participant after leave')
  assert(tournament.viewer.entryStatus === 'refunded', `entryStatus=${tournament.viewer.entryStatus}`)
  assert(tournament.viewer.canJoinSolo === true, 'solo action not restored after leave')
  assert(tournament.viewer.canInvitePartner === true, 'partner action not restored after leave')
}

async function getEntryFeeLedgerCounts(databaseFile: string, tournamentId: string): Promise<{
  debits: number
  refunds: number
}> {
  const sqliteModule = await import('node:sqlite')
  const database = new sqliteModule.DatabaseSync(databaseFile, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  try {
    const rows = database.prepare(`
      SELECT entry_type, COUNT(*) as count
      FROM tournament_economy_ledger
      WHERE tournament_id = ?
        AND entry_type IN ('entry_fee_debit', 'entry_fee_refund')
      GROUP BY entry_type;
    `).all(tournamentId) as Array<{ entry_type: string; count: number }>
    return {
      debits: rows.find((row) => row.entry_type === 'entry_fee_debit')?.count ?? 0,
      refunds: rows.find((row) => row.entry_type === 'entry_fee_refund')?.count ?? 0,
    }
  } finally {
    database.close()
  }
}

async function checkFrontendWiring(projectRoot: string): Promise<void> {
  const renderSource = await readFile(
    join(projectRoot, 'src', 'app', 'lobby', 'renderTournamentsScreen.ts'),
    'utf8',
  )
  assert(renderSource.includes('t.viewer.canJoinSolo || t.viewer.canInvitePartner'), 'entry row does not allow either restored action')
  assert(renderSource.includes('data-tournament-join-open="1"'), 'solo action button wiring missing')
  assert(renderSource.includes('data-tournament-partner-picker-open="1"'), 'partner action button wiring missing')

  const controllerSource = await readFile(
    join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'),
    'utf8',
  )
  assert(controllerSource.includes('submitTournamentLeave'), 'leave controller missing')
  assert(controllerSource.includes('mergeTournamentSummaryIntoDetail(result.tournament)'), 'leave result is not merged into detail')
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)
const projectRoot = resolve(sourceServerRoot, '..')

console.log('\nTournament leave/rejoin regression')
console.log(`Server root: ${sourceServerRoot}`)

await checkFrontendWiring(projectRoot)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null

try {
  server = startServer(isolated.serverDir, port)
  await waitFor('server /health', async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      return response.ok
    } catch {
      return false
    }
  })

  const runId = randomUUID().slice(0, 8)
  const creatorCookie = await registerAndGetCookie(port, runId, 'creator')
  const playerCookie = await registerAndGetCookie(port, runId, 'player')
  const { tournamentId } = await createTournament(port, creatorCookie)

  const initialBalance = await getWalletBalance(port, playerCookie)
  const join1 = await httpRequest(port, `/api/tournaments/${tournamentId}/join`, 'POST', playerCookie, {})
  assert(join1.status === 200 && join1.body.alreadyJoined === false, `initial join failed: ${JSON.stringify(join1.body)}`)
  assert(await getWalletBalance(port, playerCookie) === initialBalance - 5000, 'initial join did not debit 5000')

  const leave1 = await httpRequest(port, `/api/tournaments/${tournamentId}/leave`, 'POST', playerCookie)
  assert(leave1.status === 200 && leave1.body.alreadyRefunded === false, `first leave failed: ${JSON.stringify(leave1.body)}`)
  assert(await getWalletBalance(port, playerCookie) === initialBalance, 'first leave did not refund 5000')
  await assertEntryActionsRestored(port, tournamentId, playerCookie)

  const join2 = await httpRequest(port, `/api/tournaments/${tournamentId}/join`, 'POST', playerCookie, {})
  assert(join2.status === 200 && join2.body.alreadyJoined === false, `rejoin failed: ${JSON.stringify(join2.body)}`)
  assert(await getWalletBalance(port, playerCookie) === initialBalance - 5000, 'rejoin did not debit a fresh 5000')

  const leave2 = await httpRequest(port, `/api/tournaments/${tournamentId}/leave`, 'POST', playerCookie)
  assert(leave2.status === 200 && leave2.body.alreadyRefunded === false, `second leave failed: ${JSON.stringify(leave2.body)}`)
  assert(await getWalletBalance(port, playerCookie) === initialBalance, 'second leave did not refund the rejoin debit')

  const idempotentLeave = await httpRequest(port, `/api/tournaments/${tournamentId}/leave`, 'POST', playerCookie)
  assert(idempotentLeave.status === 200 && idempotentLeave.body.alreadyRefunded === true, 'repeat leave is not idempotent')
  assert(await getWalletBalance(port, playerCookie) === initialBalance, 'repeat leave changed wallet balance')

  const ledgerCounts = await getEntryFeeLedgerCounts(isolated.databaseFile, tournamentId)
  assert(ledgerCounts.debits === 2, `expected 2 debit rows, got ${ledgerCounts.debits}`)
  assert(ledgerCounts.refunds === 2, `expected 2 refund rows, got ${ledgerCounts.refunds}`)

  console.log('PASS tournament leave/rejoin regression')
} catch (error) {
  if (server !== null) console.error(server.output())
  throw error
} finally {
  if (server !== null) await stopServer(server)
  await isolated.cleanup()
}
