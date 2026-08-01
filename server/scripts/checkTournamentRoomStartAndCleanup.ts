/**
 * checkTournamentRoomStartAndCleanup.ts
 *
 * Behavior-level integration test за production инцидента (виж
 * fix(tournaments): start matches and close completed rooms):
 *  - Реални tournament match-ове стояха на "Зареждане на играта...", ready
 *    count оставаше 0 и room phase не излизаше от 'bootstrap', защото
 *    турнирната detail страница "Влез в масата" водеше грешно към
 *    showSessionInGameOverlay ("В момента се играе игра с този профил")
 *    вместо директен resume_room (виж onTournamentEnterActiveMatch в main.ts).
 *  - Completed walkover мач оставяше active_room_snapshots с
 *    room_status='waiting', game_phase='bootstrap', is_active=1 завинаги,
 *    защото ServerRoom.status никога не се задаваше на 'finished' за
 *    турнирни стаи (shouldKeepRoomAlive третираше всяка турнирна стая с
 *    status !== 'finished' като "пази вечно" — а нищо в кодовата база не
 *    задаваше този статус, виж finishTournamentRoom/closeCompletedRoom в
 *    tournamentCoordinator.ts).
 *
 * Спавва РЕАЛЕН изолиран сървър процес (огледало на
 * checkTournamentEntryHttpApi.ts) срещу temp SQLite копие — никога срещу
 * постоянната локална база. Използва реални HTTP регистрации, реален
 * tournament join flow, реални WebSocket клиенти и реалния resume_room
 * message handler (не source-fragment проверки).
 *
 * Сценарии:
 *  A. Четирима присъстващи — реален attendance/game-start/game-action [1]-[12]
 *  B. Reconnect със същия seat, нов connectionId                      [13]-[16]
 *  C. Walkover cleanup (one-team-missing)                              [17]-[23]
 *  D. Both-teams-missing → ботове → реален закъснял takeover           [24]-[27]
 *  E. Restart recovery за stale active_room_snapshots (реален store)   [28]-[32]
 *  F. Final walkover + settlement точно веднъж                         [33]-[35]
 *
 * fix(tournaments): route both teams after walkover — добавя (запазвайки
 * номерацията по-горе непроменена, новите проверки са именувани по буква):
 *  [A-winner] / [B-loser] semifinal walkover — routing на победител/загубил
 *    (myPlacement, myActiveMatch, personal elimination callout, no-show
 *    reconnect, липса на penalty/economy за конкретния неявил се профил).
 *  [C] Feeder audience — негативно scoping (не изтича към чужди турнири).
 *  [D]/[E] Final walkover — champion/runner-up routing, реални награди,
 *    без "eliminated без награда" за runner-up, без waiting view.
 *  [F] Reconnect на неявил се профил (semifinal и final) — resume се
 *    отхвърля чисто, вижда правилния личен резултат при следващо влизане.
 *  Client fixture проверки чрез директен import на
 *  renderTournamentDetailScreen (реалната клиентска render функция) върху
 *  реално server-computed DTO — не source-fragment търсене.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { renderTournamentDetailScreen } from '../../src/app/lobby/renderTournamentsScreen.js'
import type { LobbyScreenState } from '../../src/app/lobby/renderLobbyScreen.js'

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
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
async function waitFor(
  label: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(150)
  }
  throw new Error(`Timeout: ${label}`)
}

// ─── Мрежови/HTTP helpers (огледало на checkTournamentEntryHttpApi.ts) ──────

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

function smokeEmail(runId: string, suffix: string): string {
  return `tournament-room-start-${runId}-${suffix}@example.test`.toLowerCase()
}

async function registerAndGetProfile(
  port: number,
  runId: string,
  suffix: string,
): Promise<{ cookie: string; profileId: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: smokeEmail(runId, suffix),
      password: 'TournamentRoomStart1!',
      displayName: `Room ${suffix}`,
      gender: 'male',
    }),
  })
  if (res.status !== 200) throw new Error(`Регистрацията върна status ${res.status} за ${suffix}.`)
  const payload = await res.json() as { ok?: boolean; message?: string; session?: { profile?: { profileId?: string } } }
  if (!payload.ok) throw new Error(`Регистрацията не е успешна за ${suffix}: ${payload.message ?? '?'}`)
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  if (!rawCookie) throw new Error(`Липсва Set-Cookie за ${suffix}.`)
  const profileId = payload.session?.profile?.profileId
  if (!profileId) throw new Error(`Липсва profileId за ${suffix}.`)
  return { cookie: rawCookie.split(';')[0]!, profileId }
}

async function createTournament(
  port: number,
  cookie: string,
  name: string,
): Promise<{ tournamentId: string }> {
  const r = await httpRequest(port, '/api/tournaments', 'POST', cookie, {
    name,
    entryFee: 5000,
    teamCapacity: 4,
    visibility: 'public',
    startMode: 'fill',
  })
  if (r.status !== 200 || !r.body?.ok) {
    throw new Error(`createTournament(${name}) failed: status=${r.status} body=${JSON.stringify(r.body)}`)
  }
  return { tournamentId: r.body.tournament.tournamentId }
}

async function joinSolo(port: number, cookie: string, tournamentId: string): Promise<void> {
  const r = await httpRequest(port, `/api/tournaments/${tournamentId}/join`, 'POST', cookie, {})
  if (r.status !== 200 || !r.body?.ok) {
    throw new Error(`joinSolo failed: status=${r.status} body=${JSON.stringify(r.body)}`)
  }
}

async function getTournamentDetail(port: number, cookie: string, tournamentId: string): Promise<any> {
  const r = await httpRequest(port, `/api/tournaments/${tournamentId}`, 'GET', cookie)
  if (r.status !== 200 || !r.body?.ok) {
    throw new Error(`getTournamentDetail failed: status=${r.status} body=${JSON.stringify(r.body)}`)
  }
  return r.body.tournament
}

// Рендира РЕАЛНАТА tournament detail страница (renderTournamentDetailScreen,
// клиентски модул) върху РЕАЛНО server-computed DTO (не измислен fixture) —
// поведенческа проверка на клиентския callout/текст, не source-fragment
// търсене. renderTournamentsScreen.ts няма runtime зависимости отвъд себе си
// (само `import type` за протокол/state типовете), затова е безопасно за
// директен import тук.
function renderTournamentDetailScreenForFixture(tournament: any, viewerProfileId = 'fixture-viewer'): string {
  const state: LobbyScreenState = {
    profile: { profileId: viewerProfileId, displayName: 'Fixture', avatarUrl: null },
    displayName: 'Fixture',
    tournamentDetailLoading: false,
    tournamentDetailErrorText: null,
    tournamentDetailRequiresPassword: false,
    tournamentDetailPasswordDraft: '',
    tournamentDetailUnlockBusy: false,
    tournamentDetailUnlockErrorText: null,
    tournamentDetailId: tournament.tournamentId,
    tournamentDetail: tournament,
    tournamentJoinConfirmOpen: false,
    tournamentJoinBusy: false,
    tournamentJoinErrorText: null,
    tournamentPartnerPickerOpen: false,
    tournamentPartnerPickerLoading: false,
    tournamentPartnerPickerErrorText: null,
    tournamentPartnerInviteBusy: false,
    tournamentPartnerInviteErrorText: null,
    tournamentPartnerInviteQuery: '',
    tournamentPartnerCandidates: [],
    tournamentLeaveConfirmOpen: false,
    tournamentLeaveBusy: false,
    tournamentLeaveErrorText: null,
    tournamentCancelConfirmOpen: false,
    tournamentCancelBusy: false,
    tournamentCancelErrorText: null,
  } as LobbyScreenState
  return renderTournamentDetailScreen(state)
}

// ─── WebSocket helpers ───────────────────────────────────────────────────────

type WsClient = { ws: WebSocket; frames: any[] }

function connectWs(port: number, cookie: string): Promise<WsClient> {
  return new Promise((resolveOpen, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
    const frames: any[] = []
    ws.on('message', (data) => {
      try { frames.push(JSON.parse(data.toString())) } catch { /* ignore non-JSON */ }
    })
    ws.once('open', () => resolveOpen({ ws, frames }))
    ws.once('error', reject)
  })
}

function closeWs(client: WsClient): void {
  try { client.ws.close() } catch { /* ignore */ }
}

function sendWs(client: WsClient, payload: unknown): void {
  client.ws.send(JSON.stringify(payload))
}

async function waitForFrame(
  client: WsClient,
  predicate: (frame: any) => boolean,
  timeoutMs = 20_000,
): Promise<any | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = client.frames.find(predicate)
    if (found !== undefined) return found
    await sleep(100)
  }
  return null
}

async function resumeRoomAndWait(
  port: number,
  cookie: string,
  roomId: string,
  reconnectToken: string,
): Promise<{ client: WsClient; resumed: any | null; failed: any | null }> {
  const client = await connectWs(port, cookie)
  sendWs(client, { type: 'resume_room', roomId, reconnectToken })
  const resumed = await waitForFrame(client, (f) => f.type === 'room_resumed' && f.roomId === roomId, 20_000)
  const failedFrame = resumed === null
    ? await waitForFrame(client, (f) => f.type === 'room_resume_failed' && f.roomId === roomId, 2_000)
    : null
  return { client, resumed, failed: failedFrame }
}

// ─── Изолиран сървър процес (огледало на checkTournamentEntryHttpApi.ts) ───

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
      if (!CLEANUP_RETRYABLE_ERROR_CODES.has(code) || attempt === maxAttempts) throw error
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
  const root = await mkdtemp(join(tmpdir(), 'belot-tournament-room-start-'))
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
    cleanup: async () => { await rmTempRootWithRetry(root) },
  }
}

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port) },
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
  if (server.child.exitCode === null) server.child.kill('SIGTERM')
  let forceKillTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (server.child.exitCode === null) server.child.kill('SIGKILL')
  }, 10_000)
  try {
    await server.closed
  } finally {
    if (forceKillTimer !== null) { clearTimeout(forceKillTimer); forceKillTimer = null }
  }
}

// ─── Директен достъп до temp SQLite файла на живия сървър (WAL, конкурентен
// read/write от отделен process е безопасен) — само за forcing на deadline
// колони и read-only проверки; никога не пипа постоянната локална база. ───

function openLiveDb(databaseFile: string): DatabaseSync {
  const db = new DatabaseSync(databaseFile, { open: true })
  db.exec('PRAGMA busy_timeout = 8000;')
  return db
}

function countRows(db: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { count: number } | undefined)?.count ?? 0
}

function getMatchRow(db: DatabaseSync, matchId: string): any {
  return db.prepare(`SELECT * FROM tournament_matches WHERE match_id = ?;`).get(matchId)
}

function forceAttendanceDeadlinePast(db: DatabaseSync, matchId: string): void {
  db.prepare(`
    UPDATE tournament_matches
    SET attendance_deadline_at = '2020-01-01T00:00:00.000Z',
        no_show_deadline_at = '2020-01-01T00:00:00.000Z'
    WHERE match_id = ?;
  `).run(matchId)
}

// ─── Главна функция ─────────────────────────────────────────────────────────

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

console.log('\n═══ checkTournamentRoomStartAndCleanup ═══')
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
        const h = r.body as { ok?: boolean; gameWorkerLifecycle?: { state?: string } | null }
        return r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready'
      } catch { return false }
    },
    SERVER_READY_TIMEOUT_MS,
  )
  console.log('  Сървърът е готов.')

  const runId = `${Date.now()}-${process.pid}`

  async function registerGroup(prefix: string, count: number): Promise<Array<{ cookie: string; profileId: string }>> {
    const out: Array<{ cookie: string; profileId: string }> = []
    for (let i = 0; i < count; i++) {
      out.push(await registerAndGetProfile(port, runId, `${prefix}${i}`))
    }
    return out
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Турнир ALPHA (teamCapacity=4, 8 играчи) — сценарии A, B, C
  // ═══════════════════════════════════════════════════════════════════════

  console.log('\n[alpha] Регистрация и старт на турнир Alpha...')
  const alpha = await registerGroup('alpha', 8)
  const alphaTournament = await createTournament(port, alpha[0]!.cookie, `Alpha Room Start ${runId}`)
  for (const p of alpha) await joinSolo(port, p.cookie, alphaTournament.tournamentId)

  await waitFor('alpha: tournament locks teams and starts bracket', async () => {
    const detail = await getTournamentDetail(port, alpha[0]!.cookie, alphaTournament.tournamentId)
    return detail.status === 'starting' || detail.status === 'semifinal_in_progress'
  }, 30_000)

  await waitFor('alpha: two semifinal rooms are assigned', async () => {
    return alpha.every(async () => true) && (await Promise.all(
      alpha.map((p) => getTournamentDetail(port, p.cookie, alphaTournament.tournamentId)),
    )).every((d) => d.myActiveMatch !== null)
  }, 30_000)

  const alphaDetails = await Promise.all(
    alpha.map(async (p) => ({ p, detail: await getTournamentDetail(port, p.cookie, alphaTournament.tournamentId) })),
  )
  const alphaByMatch = new Map<string, Array<{ p: { cookie: string; profileId: string }; assignment: any }>>()
  for (const { p, detail } of alphaDetails) {
    const assignment = detail.myActiveMatch
    assert(assignment !== null, `alpha profile ${p.profileId} has no myActiveMatch`)
    const list = alphaByMatch.get(assignment.matchId) ?? []
    list.push({ p, assignment })
    alphaByMatch.set(assignment.matchId, list)
  }
  assert(alphaByMatch.size === 2, `expected 2 alpha semifinal matches, got ${alphaByMatch.size}`)
  const [alphaSfEntries, alphaSfCEntries] = [...alphaByMatch.entries()]
  const [sfAMatchId, sfAPlayers] = alphaSfEntries!
  const [sfCMatchId, sfCPlayers] = alphaSfCEntries!
  const sfARoomId: string = sfAPlayers[0]!.assignment.roomId

  const alphaDb = openLiveDb(isolated.databaseFile)

  // ── A. ЧЕТИРИМА ПРИСЪСТВАЩИ ──────────────────────────────────────────────

  const sfAClients: WsClient[] = []

  await check('[1] Създаден tournament match с два отбора по двама (SF-A)', () => {
    assert(sfAPlayers.length === 4, `sfAPlayers=${sfAPlayers.length}`)
    const teamIds = new Set(sfAPlayers.map((x) => x.assignment.teamId))
    assert(teamIds.size === 2, `expected 2 distinct teams, got ${teamIds.size}`)
  })

  await check('[2]-[4] Всеки profile влиза през реалния resume_room flow и се свързва с точния предварително зададен seat', async () => {
    for (const { p, assignment } of sfAPlayers) {
      const { client, resumed, failed } = await resumeRoomAndWait(port, p.cookie, assignment.roomId, assignment.reconnectToken)
      assert(resumed !== null, `resume_room failed for ${p.profileId}: ${JSON.stringify(failed)}`)
      assert(resumed.seat === assignment.seat, `seat mismatch for ${p.profileId}: got ${resumed.seat}, expected ${assignment.seat}`)
      sfAClients.push(client)
    }
  })

  await check('[5]-[6] Server attendance отчита четиримата (ready/present count става 4)', async () => {
    await waitFor('attendance shows 0 missing players for SF-A', async () => {
      const match = getMatchRow(alphaDb, sfAMatchId)
      if (match === undefined) return false
      // Изчакваме следващия coordinator tick да прочете обновените connections.
      const detail = await getTournamentDetail(port, sfAPlayers[0]!.p.cookie, alphaTournament.tournamentId)
      return detail.myActiveMatch !== null
    }, 15_000)
    await waitFor('SF-A match leaves awaiting_players without walkover', () => {
      const match = getMatchRow(alphaDb, sfAMatchId)
      return match !== undefined && match.status !== 'awaiting_players'
    }, 20_000)
    const match = getMatchRow(alphaDb, sfAMatchId)
    assert(match.result_kind !== 'walkover', 'SF-A resolved as walkover despite all four players present')
  })

  await check('[7]-[8] Мачът започва преди deadline и game_start_at се попълва', async () => {
    const match = getMatchRow(alphaDb, sfAMatchId)
    assert(match.game_start_at !== null, 'game_start_at is null')
    assert(match.attendance_resolution_kind === 'all_present', `resolution_kind=${match.attendance_resolution_kind}`)
  })

  await check('[9] Room phase напуска bootstrap (match става in_progress)', async () => {
    await waitFor('SF-A match becomes in_progress', () => {
      const match = getMatchRow(alphaDb, sfAMatchId)
      return match !== undefined && match.status === 'in_progress'
    }, 20_000)
  })

  await check('[10] Клиентите получават playable room snapshot (authoritativePhase извън bootstrap)', async () => {
    for (const client of sfAClients) {
      const snap = await waitForFrame(client, (f) => f.type === 'room_snapshot' && f.roomId === sfARoomId && f.game?.authoritativePhase && f.game.authoritativePhase !== 'bootstrap', 20_000)
      assert(snap !== null, 'no playable room snapshot received')
    }
  })

  await check('[11] Поне една реална начална game action (cut) се приема от сървъра', async () => {
    let cutSubmitted = false
    for (const client of sfAClients) {
      const snap = client.frames.slice().reverse().find((f) => f.type === 'room_snapshot' && f.roomId === sfARoomId && f.game?.cutting?.canSubmitCut === true)
      if (snap === undefined) continue
      const framesBefore = client.frames.length
      const cutIndex = Math.max(1, Math.min(31, Math.floor((snap.game.cutting.deckCount ?? 32) / 2)))
      sendWs(client, { type: 'submit_cut_index', roomId: sfARoomId, cutIndex })
      await waitFor('cut action produces server response', () => client.frames.length > framesBefore, 10_000)
      const errorFrame = client.frames.slice(framesBefore).find((f) => f.type === 'error')
      assert(errorFrame === undefined, `submit_cut_index rejected: ${JSON.stringify(errorFrame)}`)
      cutSubmitted = true
      break
    }
    assert(cutSubmitted, 'no client ever had canSubmitCut=true — could not exercise a real game action')
  })

  await check('[12] Няма walkover за SF-A', () => {
    const match = getMatchRow(alphaDb, sfAMatchId)
    assert(match.result_kind !== 'walkover', `result_kind=${match.result_kind}`)
  })

  // ── B. RECONNECT ─────────────────────────────────────────────────────────

  await check('[13]-[16] Reconnect със същия seat под нов connectionId, без дублиран participant', async () => {
    const target = sfAPlayers[0]!
    const before = countRows(alphaDb, `SELECT COUNT(*) AS count FROM tournament_entries WHERE tournament_id = ?;`, alphaTournament.tournamentId)
    closeWs(sfAClients[0]!)
    await sleep(500)
    const { client: newClient, resumed, failed } = await resumeRoomAndWait(port, target.p.cookie, target.assignment.roomId, target.assignment.reconnectToken)
    assert(resumed !== null, `reconnect resume_room failed: ${JSON.stringify(failed)}`)
    assert(resumed.seat === target.assignment.seat, `reconnect seat mismatch: got ${resumed.seat}`)
    const after = countRows(alphaDb, `SELECT COUNT(*) AS count FROM tournament_entries WHERE tournament_id = ?;`, alphaTournament.tournamentId)
    assert(after === before, `tournament_entries count changed after reconnect: ${before} -> ${after}`)
    sfAClients[0] = newClient
  })

  // ── C. WALKOVER CLEANUP (one-team-missing) ───────────────────────────────

  const sfCPresentTeamId: string = sfCPlayers[0]!.assignment.teamId
  const sfCPresent = sfCPlayers.filter((x) => x.assignment.teamId === sfCPresentTeamId)
  const sfCRoomId: string = sfCPlayers[0]!.assignment.roomId
  const sfCClients: WsClient[] = []

  await check('[17] Симулира валиден one-team-missing walkover (само единият отбор се свързва)', async () => {
    assert(sfCPresent.length === 2, `expected 2 present players on one team, got ${sfCPresent.length}`)
    for (const { p, assignment } of sfCPresent) {
      const { client, resumed, failed } = await resumeRoomAndWait(port, p.cookie, assignment.roomId, assignment.reconnectToken)
      assert(resumed !== null, `resume_room failed for present SF-C player: ${JSON.stringify(failed)}`)
      sfCClients.push(client)
    }
    forceAttendanceDeadlinePast(alphaDb, sfCMatchId)
  })

  await check('[18] tournament match става completed (walkover)', async () => {
    await waitFor('SF-C match resolves to completed walkover', () => {
      const match = getMatchRow(alphaDb, sfCMatchId)
      return match !== undefined && match.status === 'completed' && match.result_kind === 'walkover'
    }, 20_000)
    const match = getMatchRow(alphaDb, sfCMatchId)
    assert(match.winner_team_id === sfCPresentTeamId, `winner_team_id=${match.winner_team_id}, expected present team ${sfCPresentTeamId}`)
  })

  await check('[19] active_room_snapshots за SF-C стаята става is_active=0 (премахнат)', async () => {
    await waitFor('SF-C snapshot removed', () => {
      return countRows(alphaDb, `SELECT COUNT(*) AS count FROM active_room_snapshots WHERE room_id = ? AND is_active = 1;`, sfCRoomId) === 0
    }, 15_000)
  })

  await check('[20]-[21] Runtime room се премахва и свързаните профили се освобождават', async () => {
    for (const client of sfCClients) {
      sendWs(client, { type: 'resume_room', roomId: sfCRoomId, reconnectToken: 'irrelevant-stale-token-after-close' })
      const failedFrame = await waitForFrame(client, (f) => f.type === 'room_resume_failed' || (f.type === 'error'), 10_000)
      assert(failedFrame !== null, 'expected the closed tournament room to reject further resume attempts')
    }
  })

  await check('[22] Няма table_exit_penalties за SF-C стаята', () => {
    assert(countRows(alphaDb, `SELECT COUNT(*) AS count FROM table_exit_penalties WHERE room_id = ?;`, sfCRoomId) === 0, 'unexpected table_exit_penalties row')
  })

  await check('[23] Няма match_economy_ledger операции за SF-C стаята', () => {
    assert(countRows(alphaDb, `SELECT COUNT(*) AS count FROM match_economy_ledger WHERE room_id = ?;`, sfCRoomId) === 0, 'unexpected match_economy_ledger row')
  })

  // ── C. FEEDER AUDIENCE (негативно scoping — победилият SF-C отбор чака
  // именно SF-A; не трябва да получава feeder съобщения за чужди турнири) ──

  await check('[C] Победилият SF-C отбор не получава feeder съобщения за турнири, в които не участва', () => {
    for (const client of sfCClients) {
      const foreignFeederFrame = client.frames.find((f) =>
        (f.type === 'tournament_feeder_score_progress' || f.type === 'tournament_feeder_match_completed') &&
        f.tournamentId !== alphaTournament.tournamentId,
      )
      assert(foreignFeederFrame === undefined, `received a feeder message for an unrelated tournament: ${JSON.stringify(foreignFeederFrame)}`)
    }
  })

  // ── Полуфинален walkover: routing на ПОБЕДИЛИЯ и ЗАГУБИЛИЯ отбор
  // (виж fix(tournaments): route both teams after walkover) ─────────────

  const sfCAbsent = sfCPlayers.filter((x) => x.assignment.teamId !== sfCPresentTeamId)

  await check('[A-winner] Победилият отбор не е "eliminated" и все още няма myActiveMatch (изчаква другия полуфинал)', async () => {
    const winnerDetail = await getTournamentDetail(port, sfCPresent[0]!.p.cookie, alphaTournament.tournamentId)
    assert(winnerDetail.viewer.myPlacement !== 'eliminated', `winner myPlacement=${winnerDetail.viewer.myPlacement}`)
    assert(winnerDetail.myActiveMatch === null, 'winner already has a final assignment before the other semifinal finished')
  })

  // SF-A (sibling полуфинал) остава нарочно "in_progress" за целия тест (за
  // да провери реален cut action/reconnect в сценарий A/B), затова целият
  // semifinal кръг НЕ приключва — bracket-ladder логиката (ensureNextRound,
  // виж коментара "само загубилите в currentRoundType стават 'eliminated'
  // веднага" в tournamentCoordinator.ts) финализира entryStatus='eliminated'
  // едва когато И ДВАТА sibling мача са завършени, не мач по мач. Затова тук
  // проверяваме само каквото е гарантирано веднага след ТОЗИ мач (не
  // champion/runner_up, без active match/room) — пълният 'eliminated' label
  // (round вече напълно решен) се проверява отделно в Gamma по-долу, където
  // и двата полуфинала реално приключват.
  await check('[B-loser] Загубилият отбор (включително неявилият се играч) няма myActiveMatch и не е champion/runner_up', async () => {
    for (const { p } of sfCAbsent) {
      const loserDetail = await getTournamentDetail(port, p.cookie, alphaTournament.tournamentId)
      assert(loserDetail.viewer.myPlacement !== 'champion' && loserDetail.viewer.myPlacement !== 'runner_up', `loser ${p.profileId} myPlacement=${loserDetail.viewer.myPlacement}`)
      assert(loserDetail.myActiveMatch === null, `loser ${p.profileId} unexpectedly still has an active match`)
    }
  })

  await check('[F] Неявилият се играч не може да resume-не приключилата стая (не виси на "Зареждане на играта...")', async () => {
    const noShow = sfCAbsent[0]!
    const { resumed, failed } = await resumeRoomAndWait(port, noShow.p.cookie, noShow.assignment.roomId, noShow.assignment.reconnectToken)
    assert(resumed === null, 'no-show player unexpectedly resumed the already-closed walkover room')
    assert(failed !== null, 'expected room_resume_failed for the no-show player on the closed room')
  })

  await check('[B-loser] Няма penalty/economy операция за неявилия се играч конкретно', () => {
    const noShowProfileId = sfCAbsent[0]!.p.profileId
    assert(countRows(alphaDb, `SELECT COUNT(*) AS count FROM table_exit_penalties WHERE profile_id = ?;`, noShowProfileId) === 0, 'unexpected penalty for no-show profile')
    assert(countRows(alphaDb, `SELECT COUNT(*) AS count FROM match_economy_ledger WHERE profile_id = ?;`, noShowProfileId) === 0, 'unexpected economy ledger row for no-show profile')
  })

  await check('[B-loser] tournament detail на неявилия се играч не показва премахнатата публична "Турнирна схема"', async () => {
    const loserDetail = await getTournamentDetail(port, sfCAbsent[0]!.p.cookie, alphaTournament.tournamentId)
    const html = renderTournamentDetailScreenForFixture(loserDetail)
    assert(!html.includes('Турнирна схема'), 'removed public bracket section must not reappear')
  })

  for (const c of sfAClients) closeWs(c)
  for (const c of sfCClients) closeWs(c)
  alphaDb.close()

  // ═══════════════════════════════════════════════════════════════════════
  // Турнир BETA (teamCapacity=4, 8 играчи) — сценарий D
  // ═══════════════════════════════════════════════════════════════════════

  console.log('\n[beta] Регистрация и старт на турнир Beta...')
  const beta = await registerGroup('beta', 8)
  const betaTournament = await createTournament(port, beta[0]!.cookie, `Beta Room Start ${runId}`)
  for (const p of beta) await joinSolo(port, p.cookie, betaTournament.tournamentId)

  await waitFor('beta: two semifinal rooms are assigned', async () => {
    const details = await Promise.all(beta.map((p) => getTournamentDetail(port, p.cookie, betaTournament.tournamentId)))
    return details.every((d) => d.myActiveMatch !== null)
  }, 30_000)

  const betaDetails = await Promise.all(
    beta.map(async (p) => ({ p, detail: await getTournamentDetail(port, p.cookie, betaTournament.tournamentId) })),
  )
  const betaByMatch = new Map<string, Array<{ p: { cookie: string; profileId: string }; assignment: any }>>()
  for (const { p, detail } of betaDetails) {
    const assignment = detail.myActiveMatch
    const list = betaByMatch.get(assignment.matchId) ?? []
    list.push({ p, assignment })
    betaByMatch.set(assignment.matchId, list)
  }
  const [betaSfEntry] = [...betaByMatch.entries()]
  const [betaMatchId, betaPlayers] = betaSfEntry!
  const betaDb = openLiveDb(isolated.databaseFile)

  await check('[24]-[26] Both-teams-missing → липсващите места се запълват само с ботове, мачът започва', async () => {
    // Никой от четиримата не се свързва — форсираме deadline директно.
    forceAttendanceDeadlinePast(betaDb, betaMatchId)
    await waitFor('BETA match resolves with bots_inserted', () => {
      const match = getMatchRow(betaDb, betaMatchId)
      return match !== undefined && match.attendance_resolution_kind === 'bots_inserted'
    }, 20_000)
    const replacementCount = countRows(betaDb, `SELECT COUNT(*) AS count FROM tournament_match_no_show_replacements WHERE match_id = ?;`, betaMatchId)
    assert(replacementCount === 4, `expected 4 bot replacements (both teams missing), got ${replacementCount}`)
    const match = getMatchRow(betaDb, betaMatchId)
    assert(match.result_kind !== 'walkover', 'both-teams-missing must not resolve as walkover')
  })

  await check('[27] Реален закъснял играч поема точно своя seat от бота', async () => {
    const late = betaPlayers[0]!
    const { client, resumed, failed } = await resumeRoomAndWait(port, late.p.cookie, late.assignment.roomId, late.assignment.reconnectToken)
    assert(resumed !== null, `late takeover resume_room failed: ${JSON.stringify(failed)}`)
    assert(resumed.seat === late.assignment.seat, `takeover seat mismatch: got ${resumed.seat}, expected ${late.assignment.seat}`)
    closeWs(client)
  })

  betaDb.close()

  // ═══════════════════════════════════════════════════════════════════════
  // Турнир GAMMA (teamCapacity=4, 8 играчи) — сценарий F (final walkover)
  // ═══════════════════════════════════════════════════════════════════════

  console.log('\n[gamma] Регистрация и старт на турнир Gamma...')
  const gamma = await registerGroup('gamma', 8)
  const gammaTournament = await createTournament(port, gamma[0]!.cookie, `Gamma Room Start ${runId}`)
  for (const p of gamma) await joinSolo(port, p.cookie, gammaTournament.tournamentId)

  await waitFor('gamma: two semifinal rooms are assigned', async () => {
    const details = await Promise.all(gamma.map((p) => getTournamentDetail(port, p.cookie, gammaTournament.tournamentId)))
    return details.every((d) => d.myActiveMatch !== null)
  }, 30_000)

  const gammaDetails = await Promise.all(
    gamma.map(async (p) => ({ p, detail: await getTournamentDetail(port, p.cookie, gammaTournament.tournamentId) })),
  )
  const gammaByMatch = new Map<string, Array<{ p: { cookie: string; profileId: string }; assignment: any }>>()
  for (const { p, detail } of gammaDetails) {
    const assignment = detail.myActiveMatch
    const list = gammaByMatch.get(assignment.matchId) ?? []
    list.push({ p, assignment })
    gammaByMatch.set(assignment.matchId, list)
  }
  assert(gammaByMatch.size === 2, `expected 2 gamma semifinal matches, got ${gammaByMatch.size}`)
  const gammaDb = openLiveDb(isolated.databaseFile)

  const gammaWinners: Array<{ p: { cookie: string; profileId: string }; assignment: any }[]> = []
  const gammaLosers: Array<{ p: { cookie: string; profileId: string }; assignment: any }[]> = []
  for (const [matchId, players] of gammaByMatch.entries()) {
    const presentTeamId = players[0]!.assignment.teamId
    const present = players.filter((x) => x.assignment.teamId === presentTeamId)
    const absent = players.filter((x) => x.assignment.teamId !== presentTeamId)
    for (const { p, assignment } of present) {
      const { resumed, failed } = await resumeRoomAndWait(port, p.cookie, assignment.roomId, assignment.reconnectToken)
      assert(resumed !== null, `gamma semifinal resume failed: ${JSON.stringify(failed)}`)
    }
    forceAttendanceDeadlinePast(gammaDb, matchId)
    await waitFor(`gamma semifinal ${matchId} resolves to walkover`, () => {
      const match = getMatchRow(gammaDb, matchId)
      return match !== undefined && match.status === 'completed' && match.result_kind === 'walkover'
    }, 20_000)
    gammaWinners.push(present)
    gammaLosers.push(absent)
  }

  await check('[B-loser] И двата загубили полуфинала отбора в Gamma виждат eliminated + callout за служебна загуба', async () => {
    for (const loserTeam of gammaLosers) {
      for (const { p } of loserTeam) {
        const detail = await getTournamentDetail(port, p.cookie, gammaTournament.tournamentId)
        assert(detail.viewer.myPlacement === 'eliminated', `profile ${p.profileId} myPlacement=${detail.viewer.myPlacement}`)
        const html = renderTournamentDetailScreenForFixture(detail)
        assert(html.includes('Отпаднахте на полуфинал със служебна загуба.'), 'missing walkover elimination callout for gamma loser')
      }
    }
  })

  let gammaFinalMatchId: string | null = null
  let gammaFinalRoomId: string | null = null
  let gammaFinalPlayers: Array<{ p: { cookie: string; profileId: string }; assignment: any }> = []

  await waitFor('gamma: final match is created after both semifinals', async () => {
    const detail = await getTournamentDetail(port, gamma[0]!.cookie, gammaTournament.tournamentId)
    const finalRound = detail.rounds.find((r: any) => r.roundType === 'final')
    if (finalRound === undefined || finalRound.matches.length === 0) return false
    gammaFinalMatchId = finalRound.matches[0].matchId
    return true
  }, 20_000)

  // Намираме assignment-ите за финала за единия финалистки отбор (winners
  // на едно от двете semifinal-и) — те вече имат myActiveMatch сочещ финала.
  await waitFor('gamma: finalists receive final match assignment', async () => {
    const candidate = gammaWinners[0]![0]!.p
    const detail = await getTournamentDetail(port, candidate.cookie, gammaTournament.tournamentId)
    if (detail.myActiveMatch === null || detail.myActiveMatch.matchId !== gammaFinalMatchId) return false
    gammaFinalRoomId = detail.myActiveMatch.roomId
    return true
  }, 20_000)

  for (const { p } of gammaWinners[0]!) {
    const detail = await getTournamentDetail(port, p.cookie, gammaTournament.tournamentId)
    gammaFinalPlayers.push({ p, assignment: detail.myActiveMatch })
  }

  // Другият финалистки отбор (победители на другия полуфинал) НИКОГА не се
  // свързва към финала — те стават "загубил финала служебно" (runner-up).
  // Улавяме assignment-а им РАНО (преди да форсираме deadline-а), за да
  // можем после да тестваме stale resume_room с истинския им token.
  const gammaFinalRunnerUpPlayers: Array<{ p: { cookie: string; profileId: string }; assignment: any }> = []
  for (const { p } of gammaWinners[1]!) {
    const detail = await getTournamentDetail(port, p.cookie, gammaTournament.tournamentId)
    assert(detail.myActiveMatch?.matchId === gammaFinalMatchId, `runner-up profile ${p.profileId} missing final assignment`)
    gammaFinalRunnerUpPlayers.push({ p, assignment: detail.myActiveMatch })
  }

  await check('[33] Walkover cleanup работи и за final (само единият финалист се явява)', async () => {
    for (const { p, assignment } of gammaFinalPlayers) {
      const { resumed, failed } = await resumeRoomAndWait(port, p.cookie, assignment.roomId, assignment.reconnectToken)
      assert(resumed !== null, `final resume failed: ${JSON.stringify(failed)}`)
    }
    forceAttendanceDeadlinePast(gammaDb, gammaFinalMatchId!)
    await waitFor('gamma final resolves to walkover', () => {
      const match = getMatchRow(gammaDb, gammaFinalMatchId!)
      return match !== undefined && match.status === 'completed' && match.result_kind === 'walkover'
    }, 20_000)
  })

  await check('[34] Settlement се изпълнява точно веднъж', async () => {
    await waitFor('gamma tournament settles', async () => {
      const detail = await getTournamentDetail(port, gamma[0]!.cookie, gammaTournament.tournamentId)
      return detail.status === 'finished' && detail.settlementState === 'settled'
    }, 20_000)
    const payoutCountAfterFirstSettle = countRows(
      gammaDb,
      `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`,
      gammaTournament.tournamentId,
    )
    // И шампионът, и финалистът получават награда (65%/35%) — 2 играча на отбор.
    assert(payoutCountAfterFirstSettle === 4, `expected 4 prize_payout rows (champion + runner-up teams), got ${payoutCountAfterFirstSettle}`)
    // Изчакваме допълнителни coordinator тикове (реконсилиация) и потвърждаваме
    // без дублиране на payout-и — settlement е atomically-guarded веднъж.
    await sleep(6_000)
    const payoutCountAfterMoreTicks = countRows(
      gammaDb,
      `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`,
      gammaTournament.tournamentId,
    )
    assert(payoutCountAfterMoreTicks === payoutCountAfterFirstSettle, `payout count changed after additional ticks: ${payoutCountAfterFirstSettle} -> ${payoutCountAfterMoreTicks}`)
  })

  await check('[35] Няма stale final room (snapshot премахнат, resume се отхвърля)', async () => {
    await waitFor('final room snapshot removed', () => {
      return countRows(gammaDb, `SELECT COUNT(*) AS count FROM active_room_snapshots WHERE room_id = ? AND is_active = 1;`, gammaFinalRoomId!) === 0
    }, 15_000)
    const { resumed, failed } = await resumeRoomAndWait(port, gammaFinalPlayers[0]!.p.cookie, gammaFinalRoomId!, gammaFinalPlayers[0]!.assignment.reconnectToken)
    assert(resumed === null, 'stale final room unexpectedly accepted a resume_room call')
    assert(failed !== null, 'expected room_resume_failed for the closed final room')
  })

  // ── D. FINAL WALKOVER — WINNER ───────────────────────────────────────────

  await check('[D] Победителите на финала виждат champion резултат, не waiting view, и получават личната си награда', async () => {
    for (const { p } of gammaFinalPlayers) {
      const detail = await getTournamentDetail(port, p.cookie, gammaTournament.tournamentId)
      assert(detail.viewer.myPlacement === 'champion', `champion profile ${p.profileId} myPlacement=${detail.viewer.myPlacement}`)
      assert(typeof detail.viewer.myPrizeAmount === 'number' && detail.viewer.myPrizeAmount > 0, `champion profile ${p.profileId} missing prize amount`)
      assert(detail.myActiveMatch === null, `champion profile ${p.profileId} unexpectedly still has an active match (waiting view)`)
      const html = renderTournamentDetailScreenForFixture(detail)
      assert(html.includes('Шампиони!') && html.includes('Спечелихте финала служебно.'), `missing champion walkover text, snippet=${html.slice(0, 400)}`)
    }
  })

  // ── E. FINAL WALKOVER — LOSER (runner-up) ────────────────────────────────

  await check('[E] Загубилите финала виждат runner-up резултат и своята награда, не "eliminated без награда"', async () => {
    for (const { p } of gammaFinalRunnerUpPlayers) {
      const detail = await getTournamentDetail(port, p.cookie, gammaTournament.tournamentId)
      assert(detail.viewer.myPlacement === 'runner_up', `runner-up profile ${p.profileId} myPlacement=${detail.viewer.myPlacement}`)
      assert(typeof detail.viewer.myPrizeAmount === 'number' && detail.viewer.myPrizeAmount > 0, `runner-up profile ${p.profileId} missing prize amount`)
      assert(detail.myActiveMatch === null, `runner-up profile ${p.profileId} unexpectedly still has an active match (waiting view)`)
      const html = renderTournamentDetailScreenForFixture(detail)
      assert(html.includes('Финалисти.') && html.includes('Загубихте финала служебно.'), `missing runner-up walkover text, snippet=${html.slice(0, 400)}`)
      assert(!html.includes('Отпаднахте на полуфинал'), 'runner-up must not be shown the semifinal elimination callout')
    }
  })

  await check('[F] Неявилият се финалист не може да resume-не приключилата финална стая', async () => {
    const noShowFinalist = gammaFinalRunnerUpPlayers[0]!
    const { resumed, failed } = await resumeRoomAndWait(port, noShowFinalist.p.cookie, noShowFinalist.assignment.roomId, noShowFinalist.assignment.reconnectToken)
    assert(resumed === null, 'no-show finalist unexpectedly resumed the closed final room')
    assert(failed !== null, 'expected room_resume_failed for the no-show finalist')
  })

  gammaDb.close()
} finally {
  if (server) await stopServer(server)
  await isolated.cleanup()
}

// ═══════════════════════════════════════════════════════════════════════
// E. RESTART RECOVERY — реален activeRoomSnapshotStore срещу отделна temp
// SQLite база (реални migration файлове, никога постоянната локална база).
// ═══════════════════════════════════════════════════════════════════════

const currentFilePath = fileURLToPath(import.meta.url)
const migrationsDirectoryPath = join(dirname(currentFilePath), '..', 'database', 'migrations')
const manualTransactionMarker = '-- MANUAL_TRANSACTION_MIGRATION'

async function loadMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(migrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function applyMigrations(database: DatabaseSync): Promise<void> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec(`
    CREATE TABLE IF NOT EXISTS server_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const getApplied = database.prepare(`SELECT filename FROM server_migrations WHERE filename = ? LIMIT 1;`)
  const insertApplied = database.prepare(`INSERT INTO server_migrations (filename) VALUES (?);`)
  for (const filename of await loadMigrationFileNames()) {
    if (getApplied.get(filename) !== undefined) continue
    const sql = (await readFile(join(migrationsDirectoryPath, filename), 'utf8')).trim()
    if (sql.length === 0) continue
    if (sql.startsWith(manualTransactionMarker)) {
      database.exec(sql)
      continue
    }
    database.exec('BEGIN;')
    try {
      database.exec(sql)
      insertApplied.run(filename)
      database.exec('COMMIT;')
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch { /* ignore */ }
      throw new Error(`Failed to apply migration ${filename}: ${String(error)}`)
    }
  }
}

console.log('\n[E] Restart recovery за stale active_room_snapshots...')

const recoveryTempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-recovery-'))
const recoveryDbPath = join(recoveryTempDir, 'recovery.sqlite')

try {
  const seedDb = new DatabaseSync(recoveryDbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(seedDb)

  const profileId = randomUUID()
  const tournamentId = randomUUID()
  const teamAId = randomUUID()
  const teamBId = randomUUID()
  const roundId = randomUUID()
  const matchId = randomUUID()
  const staleRoomId = randomUUID()

  seedDb.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?);`)
    .run(profileId, 'Recovery Player', 'recovery player')
  seedDb.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, status,
      entry_fee, player_capacity, start_mode, settlement_state
    ) VALUES (?, 'community', 'Recovery Seed', ?, 'public', 'finished', 5000, 8, 'fill', 'settled');
  `).run(tournamentId, profileId)
  seedDb.prepare(`INSERT INTO tournament_teams (team_id, tournament_id, status) VALUES (?, ?, 'eliminated');`).run(teamAId, tournamentId)
  seedDb.prepare(`INSERT INTO tournament_teams (team_id, tournament_id, status) VALUES (?, ?, 'finalist');`).run(teamBId, tournamentId)
  seedDb.prepare(`INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index) VALUES (?, ?, 'semifinal', 1);`)
    .run(roundId, tournamentId)
  seedDb.prepare(`
    INSERT INTO tournament_matches (
      match_id, tournament_id, round_id, room_id, team_a_id, team_b_id,
      status, result_kind, winner_team_id, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'completed', 'walkover', ?, CURRENT_TIMESTAMP);
  `).run(matchId, tournamentId, roundId, staleRoomId, teamAId, teamBId, teamBId)

  // Симулира точно pre-fix production бъга: completed walkover мач, чиято
  // runtime стая никога не получи status='finished', затова snapshot-ът
  // остана is_active=1/room_status='waiting'/game_phase='bootstrap' завинаги.
  seedDb.prepare(`
    INSERT INTO active_room_snapshots (
      room_id, snapshot_version, room_status, game_phase, state_version,
      snapshot_json, is_active, finished_at, removed_at
    ) VALUES (?, 1, 'waiting', 'bootstrap', 1, ?, 1, NULL, NULL);
  `).run(staleRoomId, JSON.stringify({ id: staleRoomId, status: 'waiting', game: { phase: 'bootstrap' } }))

  seedDb.close()

  const activeRoomSnapshotStoreModule = await import(
    pathToFileURL(join(dirname(currentFilePath), '..', 'src', 'db', 'activeRoomSnapshotStore.ts')).href
  ) as typeof import('../src/db/activeRoomSnapshotStore.js')

  const store = await activeRoomSnapshotStoreModule.createActiveRoomSnapshotStore(recoveryDbPath)

  await check('[28] Seed-нат completed walkover match + stale active snapshot (is_active=1)', () => {
    const verifyDb = new DatabaseSync(recoveryDbPath, { open: true })
    const before = countRows(verifyDb, `SELECT COUNT(*) AS count FROM active_room_snapshots WHERE room_id = ? AND is_active = 1;`, staleRoomId)
    verifyDb.close()
    assert(before === 1, `expected the seeded stale snapshot to exist before recovery, count=${before}`)
  })

  let firstRunRemoved = -1
  await check('[29]-[30] Реалният recovery (activeRoomSnapshotStore) деактивира stale snapshot-а', () => {
    firstRunRemoved = store.deactivateStaleCompletedTournamentRoomSnapshots()
    assert(firstRunRemoved === 1, `expected 1 removed row, got ${firstRunRemoved}`)
    const verifyDb = new DatabaseSync(recoveryDbPath, { open: true })
    const remaining = countRows(verifyDb, `SELECT COUNT(*) AS count FROM active_room_snapshots WHERE room_id = ?;`, staleRoomId)
    verifyDb.close()
    assert(remaining === 0, `stale snapshot row still present after recovery, count=${remaining}`)
  })

  await check('[31] Room не се възстановява (loadActiveRooms не съдържа stale room)', () => {
    const restored = store.loadActiveRooms()
    assert(!restored.some((room) => room.id === staleRoomId), 'stale completed-tournament room was restored into runtime')
  })

  await check('[32] Второ изпълнение е idempotent (не прави допълнителни промени)', () => {
    const secondRunRemoved = store.deactivateStaleCompletedTournamentRoomSnapshots()
    assert(secondRunRemoved === 0, `expected 0 removed rows on second run, got ${secondRunRemoved}`)
  })

  store.close()
} finally {
  await rm(recoveryTempDir, { recursive: true, force: true })
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
