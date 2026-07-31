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
const TOURNAMENT_LOCK_PASSWORD = 'VaultKey42!'
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

async function createPasswordTournament(
  port: number,
  cookie: string,
  password: string,
): Promise<{ tournamentId: string; entryFee: number }> {
  const entryFee = 5000
  const response = await httpRequest(port, '/api/tournaments', 'POST', cookie, {
    name: 'Partner Locked Regression',
    entryFee,
    visibility: 'password',
    password,
    startMode: 'fill',
  })
  assert(response.status === 200 && response.body.ok === true, `create password tournament failed: ${JSON.stringify(response.body)}`)
  return { tournamentId: response.body.tournament.tournamentId, entryFee }
}

function hasKeyMatching(value: unknown, pattern: RegExp): boolean {
  if (value === null || typeof value !== 'object') return false
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (pattern.test(key)) return true
    if (hasKeyMatching(nested, pattern)) return true
  }
  return false
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
  // Дублиращият "Отборът е готов" панел (без "ти") трябва да е премахнат от
  // renderTournamentPartnerPanel — само personal status ("Отборът ти е готов")
  // и public "ОТБОРИ" секцията трябва да остават.
  assert(!renderSource.includes('>Отборът е готов<'), 'duplicate "Отборът е готов" ready-team panel still present in renderTournamentPartnerPanel')
  // Стабилна "Отбор A/B/C/D" идентификация — виж §3/§4/§5 в task spec-а.
  assert(renderSource.includes('buildTournamentTeamLabelMap'), 'stable team label helper missing')
  assert(renderSource.includes('TOURNAMENT_TEAM_SLOT_LETTERS'), 'team label helper does not use a stable A/B/C/D slot list')
  assert(renderSource.includes('Ти участваш в'), 'personal status is missing "Ти участваш в {Отбор X}" line')
  assert(
    /renderTournamentTeamsList[\s\S]{0,400}buildTournamentTeamLabelMap\(t\.teams\)/.test(renderSource),
    'public teams section does not build labels from the same t.teams order',
  )
  assert(
    /myTeamLabel = t\.myTeam !== null[\s\S]{0,120}buildTournamentTeamLabelMap\(t\.teams\)\.get\(t\.myTeam\.teamId\)/.test(renderSource),
    'personal status label does not come from the same buildTournamentTeamLabelMap(t.teams) mapping',
  )

  // ── Password / partner-invite behavior (виж task spec §5) ──
  // Поканеният никога не трябва да вижда password input в акцепт панела.
  const incomingInviteBlockMatch = /if \(t\.incomingPartnerInvite\) \{[\s\S]*?\n  \}/.exec(renderSource)
  assert(incomingInviteBlockMatch !== null, 'renderTournamentPartnerPanel incomingPartnerInvite block not found')
  const incomingInviteBlock = incomingInviteBlockMatch![0]
  assert(!incomingInviteBlock.includes('type="password"'), 'incoming partner invite panel renders a password input')
  assert(!incomingInviteBlock.toLowerCase().includes('парола'), 'incoming partner invite panel mentions the tournament password to the recipient')
  assert(incomingInviteBlock.includes('data-tournament-partner-accept='), 'incoming partner invite panel is missing the accept button')
  assert(incomingInviteBlock.includes('data-tournament-partner-decline='), 'incoming partner invite panel is missing the decline button')

  const mainSource = await readFile(join(projectRoot, 'src', 'main.ts'), 'utf8')
  const acceptRequestMatch = /async function respondTournamentPartnerInviteRequest\([\s\S]*?\n\}/.exec(mainSource)
  assert(acceptRequestMatch !== null, 'respondTournamentPartnerInviteRequest not found in main.ts')
  assert(!acceptRequestMatch![0].toLowerCase().includes('password'), 'accept/decline/cancel request body references password')

  const joinRequestMatch = /async function joinTournamentRequest\([\s\S]*?\n\}/.exec(mainSource)
  assert(joinRequestMatch !== null, 'joinTournamentRequest not found in main.ts')
  assert(
    joinRequestMatch![0].includes("password !== null ? { password } : {}"),
    'joinTournamentRequest does not conditionally include password only when provided',
  )

  const createInviteRequestMatch = /async function createTournamentPartnerInviteRequest\([\s\S]*?\n\}/.exec(mainSource)
  assert(createInviteRequestMatch !== null, 'createTournamentPartnerInviteRequest not found in main.ts')
  assert(
    createInviteRequestMatch![0].includes("password !== null ? { password } : {}"),
    'createTournamentPartnerInviteRequest does not conditionally include password only when provided',
  )

  // Клиентският controller трябва да преизползва паролата, потвърдена при
  // unlock-а на защитен турнир — не твърд null — за да работят "Запиши се
  // сам" / "Участвай с партньор" веднага след коректна парола (виж дефекта,
  // фиксиран в тази задача: преди това паролата никога не се подаваше).
  const controllerSource = await readFile(
    join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'),
    'utf8',
  )
  assert(
    controllerSource.includes('tournamentDetailVerifiedPassword: string | null'),
    'LobbyScreenState is missing tournamentDetailVerifiedPassword',
  )
  assert(
    controllerSource.includes('state.tournamentDetailVerifiedPassword = passwordAttempt'),
    'submitTournamentUnlock does not retain the verified password after a successful unlock',
  )
  assert(
    controllerSource.includes('options.onTournamentJoin(tournamentId, state.tournamentDetailVerifiedPassword)'),
    'submitTournamentJoin does not forward the verified password (would always fail requires_password on protected tournaments)',
  )
  assert(
    controllerSource.includes('options.onTournamentPartnerInviteCreate(tournamentId, profileId, state.tournamentDetailVerifiedPassword)'),
    'submitTournamentPartnerInvite does not forward the verified password (would always fail requires_password on protected tournaments)',
  )
  assert(
    !/onTournamentPartnerInviteRespond\([^)]*password/i.test(controllerSource),
    'respondTournamentPartnerInvite call site references a password parameter',
  )
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
  const c = await registerAndGetCookie(port, runId, 'c')
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

  // ── Stable team identification (A/B/external viewer must all see the same order) ──
  const detailForC = await getDetail(port, tournamentId, c.cookie)
  assert(Array.isArray(detailForC.teams) && detailForC.teams.length === 1, `external viewer teams length=${detailForC.teams?.length}`)
  const teamIdOrderA = detailForA.teams.map((team: any) => team.teamId)
  const teamIdOrderB = detailForB.teams.map((team: any) => team.teamId)
  const teamIdOrderC = detailForC.teams.map((team: any) => team.teamId)
  assert(
    JSON.stringify(teamIdOrderA) === JSON.stringify(teamIdOrderB) &&
    JSON.stringify(teamIdOrderA) === JSON.stringify(teamIdOrderC),
    `teams[] order differs between viewers: A=${JSON.stringify(teamIdOrderA)} B=${JSON.stringify(teamIdOrderB)} C=${JSON.stringify(teamIdOrderC)}`,
  )
  assert(detailForC.myTeam === null, 'external viewer unexpectedly has a myTeam')
  pass('teams[] order (and therefore the derived Отбор A/B/C/D label) is identical for A, B and an external viewer')

  // ── DB integrity ──
  const rowCounts = await getTeamRowCounts(isolated.databaseFile, tournamentId)
  assert(rowCounts.teams === 1, `expected exactly 1 team row, got ${rowCounts.teams}`)
  assert(rowCounts.completeTeams === 1, `expected exactly 1 complete team row, got ${rowCounts.completeTeams}`)
  assert(rowCounts.confirmedEntries === 2, `expected exactly 2 confirmed entries, got ${rowCounts.confirmedEntries}`)
  pass('exactly one team, one complete team, two confirmed entries; DB integrity ok')

  // ═══════════════════════════════════════════════════════════════════════
  // Password-protected tournament: partner-invite authorization model.
  // Поканеният никога не въвежда/знае паролата; поканилият трябва да е
  // легитимиран — чрез правилна парола или чрез вече потвърдено участие.
  // ═══════════════════════════════════════════════════════════════════════
  // NOTE: /join и /partner-invites са rate-limited на 5 действия/60s на
  // профил (isTournamentEntryActionRateLimited) — затова разделяме сценария
  // между двама различни "неоторизирани" профили (e за чист solo-join тест,
  // e2 за bypass-опит + ескалация до легитимен inviter), вместо да трупаме
  // >5 действия върху един и същ профил.
  const d = await registerAndGetCookie(port, runId, 'd')
  const e = await registerAndGetCookie(port, runId, 'e')
  const e2 = await registerAndGetCookie(port, runId, 'e2')
  const f = await registerAndGetCookie(port, runId, 'f')
  const g = await registerAndGetCookie(port, runId, 'g')
  const h = await registerAndGetCookie(port, runId, 'h')
  await establishFriendship(port, e2.cookie, f.cookie, f.profileId)
  await establishFriendship(port, d.cookie, h.cookie, h.profileId)
  pass('password-tournament test accounts registered and friendships established')

  const { tournamentId: pwTournamentId, entryFee: pwEntryFee } =
    await createPasswordTournament(port, d.cookie, TOURNAMENT_LOCK_PASSWORD)
  pass('password-protected tournament created')

  // ── 1: direct solo join without a password is refused ──
  const eBalanceBefore = await getWalletBalance(port, e.cookie)
  const joinNoPassword = await httpRequest(port, `/api/tournaments/${pwTournamentId}/join`, 'POST', e.cookie, {})
  assert(joinNoPassword.status === 403, `join without password status=${joinNoPassword.status}`)
  assert(joinNoPassword.body.reason === 'requires_password', `join without password body=${JSON.stringify(joinNoPassword.body)}`)
  assert(await getWalletBalance(port, e.cookie) === eBalanceBefore, 'join without password debited the wallet')
  pass('direct solo join without password is refused, no debit')

  // ── 2: direct solo join with a wrong password is refused ──
  const joinWrongPassword = await httpRequest(port, `/api/tournaments/${pwTournamentId}/join`, 'POST', e.cookie, {
    password: 'wrong-password',
  })
  assert(joinWrongPassword.status === 403, `join wrong password status=${joinWrongPassword.status}`)
  assert(joinWrongPassword.body.reason === 'requires_password', `join wrong password body=${JSON.stringify(joinWrongPassword.body)}`)
  assert(await getWalletBalance(port, e.cookie) === eBalanceBefore, 'join with wrong password debited the wallet')
  pass('direct solo join with wrong password is refused, no debit')

  // ── 3: a non-participant cannot bypass the password by sending a partner invite ──
  // (отделен профил e2 — join-тестовете на e вече изразходваха действия от
  // rate limit-а за entry действия, виж бележката по-горе)
  const e2BalanceBefore = await getWalletBalance(port, e2.cookie)
  const inviteBypassAttempt = await httpRequest(port, `/api/tournaments/${pwTournamentId}/partner-invites`, 'POST', e2.cookie, {
    inviteeProfileId: f.profileId,
  })
  assert(inviteBypassAttempt.status === 403, `unauthorized invite creation status=${inviteBypassAttempt.status}`)
  assert(inviteBypassAttempt.body.reason === 'requires_password', `unauthorized invite creation body=${JSON.stringify(inviteBypassAttempt.body)}`)
  assert(await getWalletBalance(port, e2.cookie) === e2BalanceBefore, 'unauthorized invite creation debited the wallet')
  const rowCountsAfterBypassAttempt = await getTeamRowCounts(isolated.databaseFile, pwTournamentId)
  assert(rowCountsAfterBypassAttempt.teams === 0, 'unauthorized invite creation created a team row without a password')
  pass('non-participant cannot create a partner invite without the tournament password')

  const inviteWrongPasswordAttempt = await httpRequest(port, `/api/tournaments/${pwTournamentId}/partner-invites`, 'POST', e2.cookie, {
    inviteeProfileId: f.profileId,
    password: 'wrong-password',
  })
  assert(inviteWrongPasswordAttempt.status === 403, `wrong-password invite creation status=${inviteWrongPasswordAttempt.status}`)
  assert(inviteWrongPasswordAttempt.body.reason === 'requires_password', `wrong-password invite creation body=${JSON.stringify(inviteWrongPasswordAttempt.body)}`)
  pass('non-participant cannot create a partner invite with a wrong password')

  // ── 4: direct solo join with the correct password succeeds ──
  const joinCorrectPassword = await httpRequest(port, `/api/tournaments/${pwTournamentId}/join`, 'POST', e2.cookie, {
    password: TOURNAMENT_LOCK_PASSWORD,
  })
  assert(joinCorrectPassword.status === 200 && joinCorrectPassword.body.ok === true, `join with correct password failed: ${JSON.stringify(joinCorrectPassword.body)}`)
  assert(!JSON.stringify(joinCorrectPassword.body).toLowerCase().includes('passwordhash'), 'join response leaks the password hash')
  assert(await getWalletBalance(port, e2.cookie) === e2BalanceBefore - pwEntryFee, 'join with correct password did not debit exactly the entry fee')
  pass('direct solo join with the correct password succeeds and debits exactly once')

  // ── 5: e2 is now a confirmed participant — creating a partner invite needs no password ──
  const e2BalanceAfterJoin = await getWalletBalance(port, e2.cookie)
  const inviteFromConfirmedEntry = await httpRequest(port, `/api/tournaments/${pwTournamentId}/partner-invites`, 'POST', e2.cookie, {
    inviteeProfileId: f.profileId,
  })
  assert(inviteFromConfirmedEntry.status === 200 && inviteFromConfirmedEntry.body.ok === true, `invite from confirmed entry failed: ${JSON.stringify(inviteFromConfirmedEntry.body)}`)
  const pwInviteId = inviteFromConfirmedEntry.body.invite.inviteId as string
  assert(await getWalletBalance(port, e2.cookie) === e2BalanceAfterJoin, 'invite creation from a confirmed entry incorrectly debited the inviter again')
  pass('confirmed participant can create a partner invite without re-entering the password')

  // ── 6: invite response/DTO never carries the tournament password ──
  assert(!JSON.stringify(inviteFromConfirmedEntry.body).includes(TOURNAMENT_LOCK_PASSWORD), 'partner invite response leaks the tournament password')
  assert(!hasKeyMatching(inviteFromConfirmedEntry.body.invite, /password/i), 'partner invite DTO has a password-related field')
  pass('partner invite response/DTO does not include the tournament password or a password field')

  // ── 7: a foreign, uninvolved profile cannot accept someone else's invite ──
  const foreignAcceptAttempt = await httpRequest(
    port,
    `/api/tournaments/${pwTournamentId}/partner-invites/${pwInviteId}/accept`,
    'POST',
    g.cookie,
  )
  assert(foreignAcceptAttempt.status === 403, `foreign accept status=${foreignAcceptAttempt.status}`)
  assert(foreignAcceptAttempt.body.reason === 'not_invitee', `foreign accept body=${JSON.stringify(foreignAcceptAttempt.body)}`)
  pass('a foreign profile cannot accept an invite addressed to someone else')

  // ── 8: the recipient can view the tournament detail (and the invite) without the password ──
  const detailForRecipient = await getDetail(port, pwTournamentId, f.cookie)
  assert(detailForRecipient.incomingPartnerInvite !== null, 'recipient does not see the incoming invite without the password')
  pass('invite recipient can view the tournament detail without knowing the password')

  // ── 9: recipient accepts WITHOUT sending any password, pays own entry exactly once ──
  const fBalanceBeforeAccept = await getWalletBalance(port, f.cookie)
  const acceptResponse = await httpRequest(
    port,
    `/api/tournaments/${pwTournamentId}/partner-invites/${pwInviteId}/accept`,
    'POST',
    f.cookie,
  )
  assert(acceptResponse.status === 200 && acceptResponse.body.ok === true, `accept failed: ${JSON.stringify(acceptResponse.body)}`)
  assert(await getWalletBalance(port, f.cookie) === fBalanceBeforeAccept - pwEntryFee, 'recipient accept did not debit exactly the entry fee')
  pass('recipient accepts without a password and pays own entry exactly once')

  // ── 10: repeat accept is idempotent, no second debit ──
  const repeatAcceptResponse = await httpRequest(
    port,
    `/api/tournaments/${pwTournamentId}/partner-invites/${pwInviteId}/accept`,
    'POST',
    f.cookie,
  )
  assert(repeatAcceptResponse.status === 200 && repeatAcceptResponse.body.ok === true, `repeat accept failed: ${JSON.stringify(repeatAcceptResponse.body)}`)
  assert(repeatAcceptResponse.body.alreadyResolved === true, 'repeat accept on password tournament is not idempotent')
  assert(await getWalletBalance(port, f.cookie) === fBalanceBeforeAccept - pwEntryFee, 'repeat accept changed the wallet balance again')
  pass('repeat accept on the password-protected tournament is idempotent, no double debit')

  // ── 11: complete team formed correctly ──
  const pwDetailForE2 = await getDetail(port, pwTournamentId, e2.cookie)
  assert(pwDetailForE2.myTeam !== null && pwDetailForE2.myTeam.status !== 'forming', 'password-tournament team is not complete after accept')
  assert(pwDetailForE2.myTeam.members.length === 2, `password-tournament team members=${pwDetailForE2.myTeam.members.length}`)
  pass('complete team is formed for the password-protected tournament invite')

  // ── 12: a cancelled invite does not let the invitee bypass the password later ──
  const inviteForH = await httpRequest(port, `/api/tournaments/${pwTournamentId}/partner-invites`, 'POST', d.cookie, {
    inviteeProfileId: h.profileId,
  })
  assert(inviteForH.status === 200 && inviteForH.body.ok === true, `creator invite to h failed: ${JSON.stringify(inviteForH.body)}`)
  const inviteForHId = inviteForH.body.invite.inviteId as string
  pass('tournament creator can invite without a password (already-authorized by ownership)')

  const cancelInviteForH = await httpRequest(
    port,
    `/api/tournaments/${pwTournamentId}/partner-invites/${inviteForHId}/cancel`,
    'POST',
    d.cookie,
  )
  assert(cancelInviteForH.status === 200 && cancelInviteForH.body.ok === true, `cancel invite failed: ${JSON.stringify(cancelInviteForH.body)}`)
  pass('creator cancels the invite to h')

  const hAcceptAfterCancel = await httpRequest(
    port,
    `/api/tournaments/${pwTournamentId}/partner-invites/${inviteForHId}/accept`,
    'POST',
    h.cookie,
  )
  assert(hAcceptAfterCancel.body.ok === false, `h could accept a cancelled invite: ${JSON.stringify(hAcceptAfterCancel.body)}`)
  pass('h cannot accept a cancelled invite')

  const hBalanceBeforeJoin = await getWalletBalance(port, h.cookie)
  const hJoinWithoutPassword = await httpRequest(port, `/api/tournaments/${pwTournamentId}/join`, 'POST', h.cookie, {})
  assert(hJoinWithoutPassword.status === 403 && hJoinWithoutPassword.body.reason === 'requires_password', `h join after cancelled invite body=${JSON.stringify(hJoinWithoutPassword.body)}`)
  assert(await getWalletBalance(port, h.cookie) === hBalanceBeforeJoin, 'h join after cancelled invite debited the wallet')
  pass('a cancelled invite does not let the invitee bypass the tournament password for a direct join')

  console.log('\nPASS tournament partner-acceptance state regression')
  console.log(`${passCount} assertions passed.`)
} catch (error) {
  if (server !== null) console.error(server.output())
  throw error
} finally {
  if (server !== null) await stopServer(server)
  await isolated.cleanup()
}
