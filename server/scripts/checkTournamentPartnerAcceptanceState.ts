/**
 * Regression: after a partner invite is accepted, the tournament detail DTO,
 * the "ОТБОРИ" section and the personal status text must all reflect the
 * completed team — not a stale solo-participant label or an empty teams list.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'TournamentPartnerAccept1!'
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
  const root = await mkdtemp(join(tmpdir(), 'belot-tournament-partner-accept-'))
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
  return `tournament-partner-accept-${runId}-${suffix}@example.test`
}

async function registerAndGetCookie(
  port: number,
  runId: string,
  suffix: string,
): Promise<{ cookie: string; profileId: string; displayName: string }> {
  const displayName = `Partner Accept ${suffix}`
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: smokeEmail(runId, suffix),
      password: PASSWORD,
      displayName,
      gender: 'male',
    }),
  })
  assert(response.status === 200, `register ${suffix} status=${response.status}`)
  const body = await response.json() as { ok?: boolean; message?: string; session?: { profile?: { profileId?: string } } }
  assert(body.ok === true, `register ${suffix} failed: ${body.message ?? '?'}`)
  const headersExt = response.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
  assert(typeof rawCookie === 'string' && rawCookie.length > 0, 'missing Set-Cookie')
  const profileId = body.session?.profile?.profileId
  assert(typeof profileId === 'string' && profileId.length > 0, 'missing profileId after register')
  return { cookie: rawCookie.split(';')[0] ?? '', profileId: profileId as string, displayName }
}

async function getWalletBalance(port: number, cookie: string): Promise<number> {
  const response = await httpRequest(port, '/api/auth/me', 'GET', cookie)
  assert(response.status === 200 && response.body.ok === true, 'auth/me failed')
  return response.body.session.profile.yellowCoinsBalance
}

async function establishFriendship(
  port: number,
  requesterCookie: string,
  addresseeCookie: string,
  addresseeProfileId: string,
): Promise<void> {
  const sendResult = await httpRequest(port, '/api/friends/request', 'POST', requesterCookie, {
    profileId: addresseeProfileId,
  })
  assert(sendResult.status === 200 && sendResult.body.ok === true, `friend request failed: ${JSON.stringify(sendResult.body)}`)

  const incoming = await httpRequest(port, '/api/friends', 'GET', addresseeCookie)
  assert(incoming.status === 200 && incoming.body.ok === true, `friends list failed: ${JSON.stringify(incoming.body)}`)
  const pending = incoming.body.friendships.incomingPending as Array<{ friendshipId: string }>
  assert(pending.length === 1, `expected exactly 1 incoming friend request, got ${pending.length}`)
  const friendshipId = pending[0]!.friendshipId

  const acceptResult = await httpRequest(port, `/api/friends/${friendshipId}/accept`, 'POST', addresseeCookie)
  assert(acceptResult.status === 200 && acceptResult.body.ok === true, `friend accept failed: ${JSON.stringify(acceptResult.body)}`)
}

async function createTournament(port: number, cookie: string): Promise<{ tournamentId: string; entryFee: number }> {
  const entryFee = 5000
  const response = await httpRequest(port, '/api/tournaments', 'POST', cookie, {
    name: 'Partner Accept Regression',
    entryFee,
    visibility: 'public',
    startMode: 'fill',
  })
  assert(response.status === 200 && response.body.ok === true, `create tournament failed: ${JSON.stringify(response.body)}`)
  return { tournamentId: response.body.tournament.tournamentId, entryFee }
}

async function getDetail(port: number, tournamentId: string, cookie: string): Promise<any> {
  const detail = await httpRequest(port, `/api/tournaments/${tournamentId}`, 'GET', cookie)
  assert(detail.status === 200 && detail.body.ok === true, `detail failed: ${detail.status} ${JSON.stringify(detail.body)}`)
  return detail.body.tournament
}

async function checkFrontendWiring(projectRoot: string): Promise<void> {
  const renderSource = await readFile(
    join(projectRoot, 'src', 'app', 'lobby', 'renderTournamentsScreen.ts'),
    'utf8',
  )
  assert(renderSource.includes('renderTournamentTeamsList(t)'), 'teams section does not render t.teams')
  assert(renderSource.includes("t.teams.length === 0"), 'teams empty-state branch missing')
  assert(renderSource.includes('hasCompleteTeam'), 'personal status does not check complete team membership')
  assert(renderSource.includes("'Отборът ти е готов'"), 'complete-team personal status text missing')
}

async function getTeamRowCounts(databaseFile: string, tournamentId: string): Promise<{
  teams: number
  completeTeams: number
  confirmedEntries: number
}> {
  const sqliteModule = await import('node:sqlite')
  const database = new sqliteModule.DatabaseSync(databaseFile, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  try {
    const teams = database.prepare(
      `SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ?;`,
    ).get(tournamentId) as { count: number }
    const completeTeams = database.prepare(
      `SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ? AND status != 'forming';`,
    ).get(tournamentId) as { count: number }
    const confirmedEntries = database.prepare(
      `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`,
    ).get(tournamentId) as { count: number }
    const fkCheck = database.prepare('PRAGMA foreign_key_check;').all()
    assert(fkCheck.length === 0, `foreign_key_check found ${fkCheck.length} violations`)
    const integrityCheck = database.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }
    assert(integrityCheck.integrity_check === 'ok', `integrity_check=${integrityCheck.integrity_check}`)
    return { teams: teams.count, completeTeams: completeTeams.count, confirmedEntries: confirmedEntries.count }
  } finally {
    database.close()
  }
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)
const projectRoot = resolve(sourceServerRoot, '..')

console.log('\nTournament partner-acceptance state regression')
console.log(`Server root: ${sourceServerRoot}`)

await checkFrontendWiring(projectRoot)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null
let passCount = 0
const pass = (label: string) => {
  passCount += 1
  console.log(`  [${passCount}] PASS ${label}`)
}

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
  const a = await registerAndGetCookie(port, runId, 'a')
  const b = await registerAndGetCookie(port, runId, 'b')
  await establishFriendship(port, a.cookie, b.cookie, b.profileId)
  pass('friendship established')

  const { tournamentId, entryFee } = await createTournament(port, a.cookie)

  // ── A: preconditions before accept ──
  const balanceABefore = await getWalletBalance(port, a.cookie)
  const joinA = await httpRequest(port, `/api/tournaments/${tournamentId}/join`, 'POST', a.cookie, {})
  assert(joinA.status === 200 && joinA.body.alreadyJoined === false, `A join failed: ${JSON.stringify(joinA.body)}`)
  assert(await getWalletBalance(port, a.cookie) === balanceABefore - entryFee, 'A join did not debit entry fee')

  const detailBeforeInvite = await getDetail(port, tournamentId, a.cookie)
  assert(detailBeforeInvite.confirmedEntriesCount === 1, `confirmedEntriesCount=${detailBeforeInvite.confirmedEntriesCount}`)
  assert(detailBeforeInvite.completedTeamsCount === 0, `completedTeamsCount=${detailBeforeInvite.completedTeamsCount}`)
  assert(detailBeforeInvite.viewer.isParticipant === true, 'A should be participant before invite')
  assert(detailBeforeInvite.myTeam === null, 'A myTeam should be null before invite')
  pass('A solo participant, 1 confirmed entry, 0 complete teams')

  const invite = await httpRequest(port, `/api/tournaments/${tournamentId}/partner-invites`, 'POST', a.cookie, {
    inviteeProfileId: b.profileId,
  })
  assert(invite.status === 200 && invite.body.ok === true, `invite creation failed: ${JSON.stringify(invite.body)}`)
  const inviteId = invite.body.invite.inviteId as string
  pass('A sent partner invite, seat reservation created')

  // ── B: accept ──
  const balanceBBefore = await getWalletBalance(port, b.cookie)
  const accept = await httpRequest(
    port,
    `/api/tournaments/${tournamentId}/partner-invites/${inviteId}/accept`,
    'POST',
    b.cookie,
  )
  assert(accept.status === 200 && accept.body.ok === true, `accept failed: ${JSON.stringify(accept.body)}`)
  assert(await getWalletBalance(port, b.cookie) === balanceBBefore - entryFee, 'B accept did not debit entry fee exactly once')
  pass('B accepted, entry fee debited exactly once')

  // ── Repeat accept must not double-debit or duplicate ──
  const repeatAccept = await httpRequest(
    port,
    `/api/tournaments/${tournamentId}/partner-invites/${inviteId}/accept`,
    'POST',
    b.cookie,
  )
  assert(repeatAccept.status === 200 && repeatAccept.body.ok === true, `repeat accept failed: ${JSON.stringify(repeatAccept.body)}`)
  assert(repeatAccept.body.alreadyResolved === true, 'repeat accept is not idempotent')
  assert(await getWalletBalance(port, b.cookie) === balanceBBefore - entryFee, 'repeat accept changed wallet balance')
  pass('repeat accept is idempotent, no double debit')

  // ── Detail DTO invariants ──
  const detailForA = await getDetail(port, tournamentId, a.cookie)
  const detailForB = await getDetail(port, tournamentId, b.cookie)

  assert(detailForA.confirmedEntriesCount === 2, `A view confirmedEntriesCount=${detailForA.confirmedEntriesCount}`)
  assert(detailForA.completedTeamsCount === 1, `A view completedTeamsCount=${detailForA.completedTeamsCount}`)
  assert(detailForB.confirmedEntriesCount === 2, `B view confirmedEntriesCount=${detailForB.confirmedEntriesCount}`)
  assert(detailForB.completedTeamsCount === 1, `B view completedTeamsCount=${detailForB.completedTeamsCount}`)
  pass('participant/team counters are 2 and 1 for both viewers')

  assert(Array.isArray(detailForA.teams) && detailForA.teams.length === 1, `A teams length=${detailForA.teams?.length}`)
  const teamFromA = detailForA.teams[0]
  assert(teamFromA.status !== 'forming', `team status still forming: ${teamFromA.status}`)
  assert(teamFromA.members.length === 2, `team members length=${teamFromA.members.length}`)
  const memberIdsA = teamFromA.members.map((m: any) => m.profileId).sort()
  assert(
    JSON.stringify(memberIdsA) === JSON.stringify([a.profileId, b.profileId].sort()),
    `team members mismatch: ${JSON.stringify(memberIdsA)}`,
  )
  pass('teams[] contains the complete team, not filtered out for being unlocked')

  assert(detailForA.myTeam !== null, 'A myTeam is null after accept')
  assert(detailForA.myTeam.teamId === teamFromA.teamId, 'A myTeam does not match teams[] entry')
  assert(detailForB.myTeam !== null, 'B myTeam is null after accept')
  assert(detailForB.myTeam.teamId === teamFromA.teamId, 'B myTeam does not match teams[] entry')
  pass('myTeam matches the same authoritative team for both A and B')

  assert(detailForA.incomingPartnerInvite === null, 'A still sees an incoming invite')
  assert(detailForA.outgoingPartnerInvite === null, 'A still sees an outgoing invite after resolution')
  assert(detailForB.incomingPartnerInvite === null, 'B still sees the incoming invite after accept')
  assert(detailForB.outgoingPartnerInvite === null, 'B unexpectedly sees an outgoing invite')
  pass('pending invite state is cleared for both A and B')

  assert(detailForA.viewer.isParticipant === true, 'A is not a participant')
  assert(detailForB.viewer.isParticipant === true, 'B is not a participant')
  pass('both viewers remain active participants')

  // ── DB integrity ──
  const rowCounts = await getTeamRowCounts(isolated.databaseFile, tournamentId)
  assert(rowCounts.teams === 1, `expected exactly 1 team row, got ${rowCounts.teams}`)
  assert(rowCounts.completeTeams === 1, `expected exactly 1 complete team row, got ${rowCounts.completeTeams}`)
  assert(rowCounts.confirmedEntries === 2, `expected exactly 2 confirmed entries, got ${rowCounts.confirmedEntries}`)
  pass('exactly one team, one complete team, two confirmed entries; DB integrity ok')

  console.log('\nPASS tournament partner-acceptance state regression')
  console.log(`${passCount} assertions passed.`)
} catch (error) {
  if (server !== null) console.error(server.output())
  throw error
} finally {
  if (server !== null) await stopServer(server)
  await isolated.cleanup()
}
