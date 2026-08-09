/**
 * checkLocalTournamentBotFlow.ts
 *
 * End-to-end проверка на strictly-local турнирния тестов режим (виж
 * docs/local-tournament-test.md). Спавва РЕАЛНИ изолирани сървър процеси
 * (огледало на checkTournamentRoomStartAndCleanup.ts) срещу temp SQLite
 * копия — никога срещу постоянната локална база. Използва РЕАЛНИЯ tournament
 * coordinator/scheduler/game runtime/bot logic — никаква фиктивна симулация.
 *
 * Сценарии:
 *  A. Local test mode guard + DB redirection (dedicated test filename)   [1]-[3]
 *  B. Full-bot турнир (4 отбора, всички catalog ботове) до settlement    [4]-[10]
 *  C. One-human flow — реален WS клиент, resume_room, реални действия    [11]-[14]
 *  D. Walkover (реални регистрирани профили, ускорени реални таймери,
 *     без DB force-poke) — semifinal + final walkover, settlement once  [15]-[20]
 *  E. Reset — scoped, idempotent, не пипа "нормален" control турнир      [21]-[24]
 *  F. Production safety (NODE_ENV=production) — dev endpoint 404 и т.н. [25]-[27]
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'

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
    await sleep(200)
  }
  throw new Error(`Timeout: ${label}`)
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

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

function httpRequestRaw(port: number, pathname: string, method: string): Promise<{ status: number; text: string }> {
  return new Promise((resolveReq, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: pathname, method, timeout: 8000 }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(Buffer.from(c)))
      res.on('end', () => resolveReq({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error('HTTP timeout.')))
    req.on('error', reject)
    req.end()
  })
}

function smokeEmail(runId: string, suffix: string): string {
  return `local-bot-flow-${runId}-${suffix}@example.test`.toLowerCase()
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
      password: 'LocalBotFlow1!',
      displayName: `LBF ${suffix}`,
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

async function loginAndGetCookie(port: number, email: string, password: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (res.status !== 200) throw new Error(`Login върна status ${res.status} за ${email}.`)
  const payload = await res.json() as { ok?: boolean; message?: string }
  if (!payload.ok) throw new Error(`Login не е успешен за ${email}: ${payload.message ?? '?'}`)
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  if (!rawCookie) throw new Error(`Липсва Set-Cookie при login за ${email}.`)
  return rawCookie.split(';')[0]!
}

async function createTournamentHttp(port: number, cookie: string, name: string, teamCapacity: number): Promise<{ tournamentId: string }> {
  const r = await httpRequest(port, '/api/tournaments', 'POST', cookie, {
    name, entryFee: 5000, teamCapacity, visibility: 'public', startMode: 'fill',
  })
  if (r.status !== 200 || !r.body?.ok) throw new Error(`createTournament(${name}) failed: status=${r.status} body=${JSON.stringify(r.body)}`)
  return { tournamentId: r.body.tournament.tournamentId }
}

async function joinSoloHttp(port: number, cookie: string, tournamentId: string): Promise<void> {
  const r = await httpRequest(port, `/api/tournaments/${tournamentId}/join`, 'POST', cookie, {})
  if (r.status !== 200 || !r.body?.ok) throw new Error(`joinSolo failed: status=${r.status} body=${JSON.stringify(r.body)}`)
}

async function getTournamentDetailHttp(port: number, cookie: string, tournamentId: string): Promise<any> {
  const r = await httpRequest(port, `/api/tournaments/${tournamentId}`, 'GET', cookie)
  if (r.status !== 200 || !r.body?.ok) throw new Error(`getTournamentDetail failed: status=${r.status} body=${JSON.stringify(r.body)}`)
  return r.body.tournament
}

// ─── Dev API helpers (без auth — само loopback + флаг guard) ────────────────

async function devCreate(port: number, teamCapacity: number, mode: string): Promise<any> {
  const r = await httpRequest(port, '/dev/tournament-test/api/create', 'POST', undefined, { teamCapacity, mode })
  if (r.status !== 200 || !r.body?.ok) throw new Error(`dev create failed: status=${r.status} body=${JSON.stringify(r.body)}`)
  return r.body
}
async function devState(port: number, tournamentId: string): Promise<any> {
  const r = await httpRequest(port, `/dev/tournament-test/api/state?tournamentId=${encodeURIComponent(tournamentId)}`, 'GET')
  if (r.status !== 200 || !r.body?.ok) throw new Error(`dev state failed: status=${r.status} body=${JSON.stringify(r.body)}`)
  return r.body.state
}
async function devReset(port: number): Promise<{ tournamentsRemoved: number; profilesRemoved: number }> {
  const r = await httpRequest(port, '/dev/tournament-test/api/reset', 'POST', undefined, {})
  if (r.status !== 200 || !r.body?.ok) throw new Error(`dev reset failed: status=${r.status} body=${JSON.stringify(r.body)}`)
  return r.body
}

// ─── WebSocket helpers (огледало на checkTournamentRoomStartAndCleanup.ts) ──

type WsClient = { ws: WebSocket; frames: any[]; onFrame?: (frame: any) => void }

function connectWs(port: number, cookie: string): Promise<WsClient> {
  return new Promise((resolveOpen, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
    const client: WsClient = { ws, frames: [] }
    ws.on('message', (data) => {
      let frame: any
      try { frame = JSON.parse(data.toString()) } catch { return }
      client.frames.push(frame)
      client.onFrame?.(frame)
    })
    ws.once('open', () => resolveOpen(client))
    ws.once('error', reject)
  })
}
function closeWs(client: WsClient): void {
  try { client.ws.close() } catch { /* ignore */ }
}
function sendWs(client: WsClient, payload: unknown): void {
  client.ws.send(JSON.stringify(payload))
}
async function waitForFrame(client: WsClient, predicate: (frame: any) => boolean, timeoutMs = 20_000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = client.frames.find(predicate)
    if (found !== undefined) return found
    await sleep(100)
  }
  return null
}
async function resumeRoomAndWait(
  port: number, cookie: string, roomId: string, reconnectToken: string,
): Promise<{ client: WsClient; resumed: any | null; failed: any | null }> {
  const client = await connectWs(port, cookie)
  sendWs(client, { type: 'resume_room', roomId, reconnectToken })
  const resumed = await waitForFrame(client, (f) => f.type === 'room_resumed' && f.roomId === roomId, 20_000)
  const failedFrame = resumed === null
    ? await waitForFrame(client, (f) => f.type === 'room_resume_failed' && f.roomId === roomId, 2_000)
    : null
  return { client, resumed, failed: failedFrame }
}

/**
 * Минимален, но РЕАЛЕН auto-responder за "test human" seat-а — на всеки
 * room_snapshot реагира с валидно cut/bid/play действие веднага щом е
 * негов ред (реални submit_* съобщения през реалния WS handler, не DB
 * short-circuit). Нужен е, защото ако human seat-ът просто спре да
 * отговаря, следващите му ходове чакат пълния 20s human timeout (виж
 * SERVER_TIMING_CONFIG) — независим от местните bot-delay overrides — което
 * би направило "one human" сценария непрактично бавен.
 */
function attachAutoResponder(client: WsClient, roomId: string, mySeat: string, onSubmit: () => void): void {
  // Dedup guard — по повече от една причина (bot-driven broadcasts за
  // другите места пристигат по средата на собствения ни ход; сървърът може
  // да преизлъчи същия snapshot повече от веднъж) множество room_snapshot
  // кадри могат да покажат идентично "мой ред е" състояние. Без guard-а
  // клиентът праща второ, вече невалидно действие ("Не е ред на този играч
  // да ..."). Пазим подпис на последното нещо, на което сме реагирали, и
  // прескачаме кадри с идентичен подпис.
  let lastActedSignature: string | null = null
  client.onFrame = (frame) => {
    if (frame.type !== 'room_snapshot' || frame.roomId !== roomId) return
    const game = frame.game
    if (!game) return
    const cutting = game.cutting
    if (cutting?.canSubmitCut === true && (cutting.cutterSeat === null || cutting.cutterSeat === mySeat)) {
      const signature = `cutting:${cutting.deckCount}`
      if (signature === lastActedSignature) return
      lastActedSignature = signature
      const cutIndex = Math.max(1, Math.min(31, Math.floor((cutting.deckCount ?? 32) / 2)))
      sendWs(client, { type: 'submit_cut_index', roomId, cutIndex })
      onSubmit()
      return
    }
    const bidding = game.bidding
    if (bidding?.canSubmitBid === true && bidding.currentBidderSeat === mySeat && bidding.validActions) {
      const signature = `bidding:${bidding.entries.length}`
      if (signature === lastActedSignature) return
      lastActedSignature = signature
      const va = bidding.validActions
      const action = va.pass
        ? { type: 'pass' }
        : va.allTrumps
          ? { type: 'all-trumps' }
          : va.suits?.clubs ? { type: 'suit', suit: 'clubs' }
          : va.suits?.diamonds ? { type: 'suit', suit: 'diamonds' }
          : va.suits?.hearts ? { type: 'suit', suit: 'hearts' }
          : va.suits?.spades ? { type: 'suit', suit: 'spades' }
          : va.noTrumps ? { type: 'no-trumps' } : { type: 'pass' }
      sendWs(client, { type: 'submit_bid_action', roomId, action })
      onSubmit()
      return
    }
    const playing = game.playing
    // validCardIds не е viewer-specific "canSubmit" флаг (за разлика от
    // canSubmitCut/canSubmitBid) — трябва изрично да сверим currentTurnSeat
    // срещу собствения seat, иначе клиентът се опитва да играе карта и на
    // чужд ред ("Не е ред на този играч да играе.").
    if (playing?.currentTurnSeat === mySeat && playing.validCardIds && playing.validCardIds.length > 0) {
      const signature = `playing:${playing.completedTricksCount}:${playing.currentTrickPlays.length}`
      if (signature === lastActedSignature) return
      lastActedSignature = signature
      sendWs(client, { type: 'submit_play_card', roomId, cardId: playing.validCardIds[0] })
      onSubmit()
    }
  }
}

// ─── Изолиран сървър процес ──────────────────────────────────────────────────

type RunningServer = { child: ChildProcessWithoutNullStreams; closed: Promise<void>; output(): string }

const CLEANUP_RETRYABLE_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

async function rmTempRootWithRetry(root: string): Promise<void> {
  const maxAttempts = 6
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { await rm(root, { recursive: true, force: true }); return } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (!CLEANUP_RETRYABLE_ERROR_CODES.has(code) || attempt === maxAttempts) throw error
      await sleep(150 * attempt)
    }
  }
}

async function createIsolatedServerRoot(originalServerRoot: string, label: string): Promise<{
  root: string; serverDir: string; cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), `belot-local-tournament-${label}-`))
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
  return { root, serverDir, cleanup: async () => { await rmTempRootWithRetry(root) } }
}

function startServer(serverDir: string, port: number, extraEnv: Record<string, string>): RunningServer {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    { cwd: serverDir, env: { ...process.env, PORT: String(port), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  const closed = new Promise<void>((resolveClosed) => { child.once('close', () => resolveClosed()) })
  return { child, closed, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (server === null) return
  if (server.child.exitCode === null) server.child.kill('SIGTERM')
  let forceKillTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (server.child.exitCode === null) server.child.kill('SIGKILL')
  }, 10_000)
  try { await server.closed } finally {
    if (forceKillTimer !== null) { clearTimeout(forceKillTimer); forceKillTimer = null }
  }
}

async function waitForHealth(port: number, requireLocalTestMode: boolean): Promise<void> {
  await waitFor('server health ready', async () => {
    try {
      const r = await httpRequest(port, '/health', 'GET')
      const h = r.body as { ok?: boolean; gameWorkerLifecycle?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
  if (requireLocalTestMode) {
    await waitFor('dev health reports local test mode enabled', async () => {
      try {
        const r = await httpRequest(port, '/dev/tournament-test/api/health', 'GET')
        return r.status === 200 && r.body?.localTournamentTestModeEnabled === true
      } catch { return false }
    }, 10_000)
  }
}

function openDb(databaseFile: string): DatabaseSync {
  const db = new DatabaseSync(databaseFile, { open: true })
  db.exec('PRAGMA busy_timeout = 8000;')
  return db
}
function countRows(db: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { count: number } | undefined)?.count ?? 0
}
function getRow(db: DatabaseSync, sql: string, ...params: unknown[]): any {
  return db.prepare(sql).get(...params)
}

/** Диагностика при зависване (виж §13 в task spec-а: "При зависване да
 * отпечата: tournament status; match status; room status/phase; worker
 * state; последните релевантни events"). */
async function dumpDiagnostics(port: number, tournamentId: string, server: RunningServer | null): Promise<void> {
  console.log(`\n  ── DIAGNOSTICS (tournament ${tournamentId}) ──`)
  try {
    const state = await devState(port, tournamentId)
    console.log(`  tournament: status=${state.tournament.status} settlementState=${state.tournament.settlementState}`)
    for (const match of state.matches) {
      console.log(
        `  match ${match.matchId}: round=${match.roundType} status=${match.status} ` +
        `attendance=${match.attendanceResolutionKind} resultKind=${match.resultKind} ` +
        `roomId=${match.roomId} gameStartAt=${match.gameStartAt} winnerTeamId=${match.winnerTeamId}`,
      )
    }
  } catch (error) {
    console.log(`  (failed to fetch dev state: ${error instanceof Error ? error.message : String(error)})`)
  }
  try {
    const health = await httpRequest(port, '/health', 'GET')
    console.log(`  /health gameRuntime=${JSON.stringify(health.body?.gameRuntime)} gameWorkerTick=${JSON.stringify(health.body?.gameWorkerTick)}`)
    console.log(`  /health tournamentCoordinator=${JSON.stringify(health.body?.tournamentCoordinator)}`)
  } catch (error) {
    console.log(`  (failed to fetch /health: ${error instanceof Error ? error.message : String(error)})`)
  }
  if (server !== null) {
    const tail = server.output().split('\n').slice(-40).join('\n')
    console.log(`  ── last server output (tail) ──\n${tail}`)
  }
  console.log('  ── end diagnostics ──\n')
}

/** waitFor вариант, който логва прогреса периодично вместо да мълчи цялото
 * timeout прозорче, и дъмпва диагностика точно преди да хвърли timeout. */
async function waitForTournamentState(
  label: string,
  port: number,
  tournamentId: string,
  predicate: (state: any) => boolean,
  timeoutMs: number,
  server: RunningServer | null,
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let lastLogAt = 0
  let lastState: any = null
  while (Date.now() < deadline) {
    lastState = await devState(port, tournamentId)
    if (predicate(lastState)) return lastState
    if (Date.now() - lastLogAt > 15_000) {
      lastLogAt = Date.now()
      const matchSummary = lastState.matches
        .map((m: any) => `${m.roundType}:${m.status}${m.resultKind ? `/${m.resultKind}` : ''}`)
        .join(', ')
      console.log(`  … waiting (${label}): tournament=${lastState.tournament.status} matches=[${matchSummary}]`)
    }
    await sleep(500)
  }
  await dumpDiagnostics(port, tournamentId, server)
  throw new Error(`Timeout: ${label}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// ГЛАВНА ФУНКЦИЯ
// ═══════════════════════════════════════════════════════════════════════════

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)
// Само за локална итерация при debug-ване (не се ползва от npm run
// check:local-tournament-bot-flow) — full-bot секцията (реален bracket до
// target score 151, ~15-20+ мин заради непроменената production
// trick-collection пауза) е най-бавната; skip-ва се с --skip-full-bot, за да
// не се чака цялото ѝ изпълнение при итерация върху по-късни секции.
const skipFullBot = process.argv.includes('--skip-full-bot')

console.log('\n═══ checkLocalTournamentBotFlow ═══')
console.log(`Server root: ${sourceServerRoot}`)

const runId = `${Date.now()}-${process.pid}`

// ─── ГЛАВЕН СЪРВЪР (local test mode ON, ускорени таймери) ──────────────────

const main = await createIsolatedServerRoot(sourceServerRoot, 'main')
const mainPort = await getFreePort()
let mainServer: RunningServer | null = null
let mainDb: DatabaseSync | null = null
const testDatabaseFile = join(main.serverDir, 'database', 'data', 'belot-v2-tournament-test.sqlite')
const defaultDatabaseFile = join(main.serverDir, 'database', 'data', 'belot-v2.sqlite')

try {
  mainServer = startServer(main.serverDir, mainPort, {
    BELOT_LOCAL_TOURNAMENT_TEST_MODE: '1',
    BELOT_LOCAL_TOURNAMENT_ATTENDANCE_MS: '4000',
    BELOT_LOCAL_TOURNAMENT_TRANSITION_MS: '2000',
    BELOT_LOCAL_BOT_ACTION_MIN_MS: '20',
    BELOT_LOCAL_BOT_ACTION_MAX_MS: '60',
  })
  console.log(`\n[startup] Чакам главния сървър на порт ${mainPort}...`)
  await waitForHealth(mainPort, true)
  console.log('  Сървърът е готов.')

  // ── A. GUARD + DB REDIRECTION ──────────────────────────────────────────

  await check('[1] Dev панелът се сервира (guard позволява — флаг + loopback)', async () => {
    const r = await httpRequestRaw(mainPort, '/dev/tournament-test', 'GET')
    assert(r.status === 200, `status=${r.status}`)
    assert(r.text.includes('Local Tournament Test Panel'), 'панелът не съдържа очаквания маркер')
  })

  await check('[2] Local test DB е отделен файл (belot-v2-tournament-test.sqlite), не споделената belot-v2.sqlite', () => {
    assert(existsSync(testDatabaseFile), `очакван test DB файл липсва: ${testDatabaseFile}`)
    assert(!existsSync(defaultDatabaseFile), `споделеният belot-v2.sqlite не трябва да съществува в local test mode: ${defaultDatabaseFile}`)
  })

  await check('[3] Startup log съдържа "[local-tournament-test] enabled"', () => {
    assert(mainServer!.output().includes('[local-tournament-test] enabled'), 'липсва startup log маркер')
  })

  mainDb = openDb(testDatabaseFile)

  // ── B. FULL-BOT ТУРНИР (4 отбора, всички ботове) ─────────────────────────

  let fullBot: any = null
  if (skipFullBot) {
    console.log('\n[full-bot] --skip-full-bot подадено — прескачам (само за локална итерация).')
  } else {
    console.log('\n[full-bot] Създавам full-bot турнир (4 отбора, 8 играчи)...')
    fullBot = await devCreate(mainPort, 4, 'all_bots')

    await check('[4] Full-bot турнир създаден с 8 бот-участника (dev API)', () => {
      assert(fullBot.ok === true, `create ok=${fullBot.ok}`)
      assert(fullBot.humanCredentials.length === 0, 'all_bots режим не трябва да създава човешки profiles')
    })

    await check('[5] Турнирът стига до semifinal_in_progress (реален scheduler + coordinator fill/bracket)', async () => {
      await waitFor('full-bot tournament starts bracket', async () => {
        const state = await devState(mainPort, fullBot.tournamentId)
        return state.tournament.status === 'starting' || state.tournament.status === 'semifinal_in_progress'
      }, 30_000)
    })

    await check('[6]-[9] Всички мачове завършват нормално (bots_inserted, не walkover), турнирът стига до settlement', async () => {
      const state = await waitForTournamentState(
        'full-bot tournament reaches finished+settled',
        mainPort,
        fullBot.tournamentId,
        (s) => s.tournament.status === 'finished' && s.tournament.settlementState === 'settled',
        // Реален bracket (2 полуфинала + финал), всеки до ~10+ ръце до target
        // score 151, с production trick-collection паузата непроменена (виж
        // коментара при [14] по-долу) — реалистично отнема на порядъка на
        // 15-20+ минути дори с максимално ускорени bot action delays.
        1_800_000,
        mainServer,
      )
      assert(state.matches.length >= 3, `expected >=3 matches (2 semifinals + final), got ${state.matches.length}`)
      for (const match of state.matches) {
        assert(match.status === 'completed', `match ${match.matchId} status=${match.status}`)
        assert(match.resultKind !== 'walkover', `match ${match.matchId} unexpectedly resolved as walkover in all-bots mode`)
        assert(match.attendanceResolutionKind === 'bots_inserted', `match ${match.matchId} attendanceResolutionKind=${match.attendanceResolutionKind}`)
      }
      assert(state.tournament.championTeamId !== null, 'missing championTeamId')
      assert(state.tournament.runnerUpTeamId !== null, 'missing runnerUpTeamId')
    })

    await check('[10] Settlement е exactly once (4 prize_payout реда) и rooms/snapshots са затворени', () => {
      const payoutCount = countRows(
        mainDb!,
        `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`,
        fullBot.tournamentId,
      )
      assert(payoutCount === 4, `expected 4 prize_payout rows, got ${payoutCount}`)
      const roomRows = mainDb!.prepare(`SELECT room_id FROM tournament_matches WHERE tournament_id = ? AND room_id IS NOT NULL;`).all(fullBot.tournamentId) as Array<{ room_id: string }>
      assert(roomRows.length >= 3, `expected >=3 rooms, got ${roomRows.length}`)
      for (const row of roomRows) {
        const activeCount = countRows(mainDb!, `SELECT COUNT(*) AS count FROM active_room_snapshots WHERE room_id = ? AND is_active = 1;`, row.room_id)
        assert(activeCount === 0, `room ${row.room_id} still has an active snapshot after settlement`)
      }
    })
  }

  // ── C. ONE-HUMAN FLOW ─────────────────────────────────────────────────────

  console.log('\n[one-human] Създавам one-human турнир (4 отбора, 1 реален играч + ботове)...')
  const oneHuman = await devCreate(mainPort, 4, 'one_human')
  const humanCred = oneHuman.humanCredentials[0]

  await check('[11] one_human режим създава точно 1 тестов човешки профил с валидни credentials', () => {
    assert(oneHuman.humanCredentials.length === 1, `expected 1 human credential, got ${oneHuman.humanCredentials.length}`)
    assert(typeof humanCred.email === 'string' && humanCred.email.length > 0, 'липсва email')
    assert(typeof humanCred.password === 'string' && humanCred.password.length > 0, 'липсва password')
  })

  const humanCookie = await loginAndGetCookie(mainPort, humanCred.email, humanCred.password)

  let humanAssignment: any = null
  await check('[12] Реалният човешки профил получава match assignment (myActiveMatch) през реалния tournament detail endpoint', async () => {
    await waitFor('human profile receives myActiveMatch', async () => {
      const detail = await getTournamentDetailHttp(mainPort, humanCookie, oneHuman.tournamentId)
      if (detail.myActiveMatch === null) return false
      humanAssignment = detail.myActiveMatch
      return true
    }, 20_000)
  })

  let humanActionsSubmitted = 0
  let humanWsClient: WsClient | null = null
  await check('[13] Real WS клиент влиза през resume_room и seat binding-ът е правилен', async () => {
    const { client, resumed, failed } = await resumeRoomAndWait(mainPort, humanCookie, humanAssignment.roomId, humanAssignment.reconnectToken)
    assert(resumed !== null, `resume_room failed: ${JSON.stringify(failed)}`)
    assert(resumed.seat === humanAssignment.seat, `seat mismatch: got ${resumed.seat}, expected ${humanAssignment.seat}`)
    humanWsClient = client
    attachAutoResponder(client, humanAssignment.roomId, humanAssignment.seat, () => { humanActionsSubmitted += 1 })
  })

  await check('[14] Поне едно реално човешко действие се приема от сървъра, мачът завършва и tournament detail отразява следващото състояние', async () => {
    await waitFor('human submits at least one real action', () => humanActionsSubmitted > 0, 15_000)
    // Реалната trick-collection пауза (playAfterTrickCollectionDelayMs,
    // ~1.3s/взятка — production timing, НЕ overridden от local test mode,
    // виж §7 в task spec-а) означава пълен мач (до 8 взятки × до ~10+ ръце
    // до target score 151) реално отнема на порядъка на минути, дори с
    // ускорени bot action delays.
    await waitFor('human match completes', async () => {
      const state = await devState(mainPort, oneHuman.tournamentId)
      const match = state.matches.find((m: any) => m.matchId === humanAssignment.matchId)
      return match?.status === 'completed'
    }, 720_000)
    await waitFor('tournament detail reflects post-match state (no stale myActiveMatch on the completed match)', async () => {
      const detail = await getTournamentDetailHttp(mainPort, humanCookie, oneHuman.tournamentId)
      return detail.myActiveMatch === null || detail.myActiveMatch.matchId !== humanAssignment.matchId
    }, 20_000)
    const errorFrame = humanWsClient!.frames.find((f) => f.type === 'error')
    assert(errorFrame === undefined, `unexpected error frame: ${JSON.stringify(errorFrame)}`)
  })
  if (humanWsClient) closeWs(humanWsClient)

  // ── D. WALKOVER (реални регистрирани профили, реални ускорени таймери) ───

  console.log('\n[delta] Регистрирам 8 профила за walkover сценарий (DELTA)...')
  const deltaPlayers: Array<{ cookie: string; profileId: string }> = []
  for (let i = 0; i < 8; i++) deltaPlayers.push(await registerAndGetProfile(mainPort, runId, `d${i}`))
  const delta = await createTournamentHttp(mainPort, deltaPlayers[0]!.cookie, `Delta Local Bot Flow ${runId}`, 4)
  for (const p of deltaPlayers) await joinSoloHttp(mainPort, p.cookie, delta.tournamentId)

  await waitFor('delta: two semifinal rooms are assigned', async () => {
    const details = await Promise.all(deltaPlayers.map((p) => getTournamentDetailHttp(mainPort, p.cookie, delta.tournamentId)))
    return details.every((d) => d.myActiveMatch !== null)
  }, 30_000)

  const deltaByMatch = new Map<string, Array<{ p: { cookie: string; profileId: string }; assignment: any }>>()
  for (const p of deltaPlayers) {
    const detail = await getTournamentDetailHttp(mainPort, p.cookie, delta.tournamentId)
    const a = detail.myActiveMatch
    const list = deltaByMatch.get(a.matchId) ?? []
    list.push({ p, assignment: a })
    deltaByMatch.set(a.matchId, list)
  }
  assert(deltaByMatch.size === 2, `expected 2 delta semifinal matches, got ${deltaByMatch.size}`)

  const deltaSemifinalWinners: Array<{ p: { cookie: string; profileId: string }; assignment: any }[]> = []
  const deltaSemifinalLosers: Array<{ p: { cookie: string; profileId: string }; assignment: any }[]> = []
  // Пазим live WS клиентите на присъстващите (печелившите) играчи, за да
  // можем след walkover резолюцията да пратим leave_active_room към ВЕЧЕ
  // force-затворената от coordinator-а стая — реален regression тест за
  // "You are not attached to this room." bug-а (виж [17b] по-долу).
  const deltaPresentClientsByMatch = new Map<string, WsClient[]>()

  await check('[15]-[17] И двата полуфинала се решават реално със служебна победа през ускорения (не-forced) attendance таймер', async () => {
    // И двата мача получават attendance прозорец от ЕДИН и същ coordinator
    // tick (когато bracket-ът се създава) — затова присъстващите отбори И
    // на двата мача трябва да се свържат ПРЕДИ да чакаме резолюция на
    // когото и да е от тях. Ако обработим мачовете последователно
    // (connect+wait, после connect+wait), прозорецът на ВТОРИЯ мач би
    // изтекъл, докато чакаме първия — 0 свързани играчи по това време би
    // означавало "mixed missing" (bot-fill) вместо чист one-sided walkover.
    const perMatch: Array<{ matchId: string; presentTeamId: string; present: any[]; absent: any[] }> = []
    for (const [matchId, players] of deltaByMatch.entries()) {
      const presentTeamId = players[0]!.assignment.teamId
      const present = players.filter((x) => x.assignment.teamId === presentTeamId)
      const absent = players.filter((x) => x.assignment.teamId !== presentTeamId)
      const presentClients: WsClient[] = []
      for (const { p, assignment } of present) {
        const { client, resumed, failed } = await resumeRoomAndWait(mainPort, p.cookie, assignment.roomId, assignment.reconnectToken)
        assert(resumed !== null, `resume_room failed for present delta player: ${JSON.stringify(failed)}`)
        presentClients.push(client)
      }
      deltaPresentClientsByMatch.set(matchId, presentClients)
      perMatch.push({ matchId, presentTeamId, present, absent })
    }

    // НЕ форсираме deadline директно в DB — изчакваме РЕАЛНИЯ ускорен
    // (BELOT_LOCAL_TOURNAMENT_ATTENDANCE_MS=4000) таймер да изтече сам, за да
    // провери реално override wiring-а, не само walkover логиката.
    for (const { matchId, presentTeamId, present, absent } of perMatch) {
      await waitFor(`delta semifinal ${matchId} resolves to walkover via real accelerated timer`, () => {
        const match = getRow(mainDb, `SELECT status, result_kind, winner_team_id FROM tournament_matches WHERE match_id = ?;`, matchId)
        return match !== undefined && match.status === 'completed' && match.result_kind === 'walkover'
      }, 15_000)
      const match = getRow(mainDb, `SELECT winner_team_id FROM tournament_matches WHERE match_id = ?;`, matchId)
      assert(match.winner_team_id === presentTeamId, `winner_team_id=${match.winner_team_id}, expected present team ${presentTeamId}`)
      deltaSemifinalWinners.push(present)
      deltaSemifinalLosers.push(absent)
    }
  })

  // Regression за "Към лобито" след semifinal loss/win показваше плашещ toast
  // "You are not attached to this room." — коренната причина: играчът
  // изпраща leave_active_room ЗА СЪЩАТА turnament стая, от която
  // tournamentCoordinator вече е detach-нал connection-а (виж
  // closeCompletedTournamentRoom → forceRemoveTournamentRoomById веднага
  // след walkover резолюцията, ПРЕДИ клиентският leave_active_room да
  // пристигне). Fix-ът прави leave_active_room идемпотентен точно за този
  // случай (server/src/index.ts) — тук доказваме го с реален WS round-trip
  // върху СЪЩАТА вече-resumed връзка, не source-fragment проверка.
  await check('[17b] leave_active_room след walkover е идемпотентен (не връща "You are not attached to this room.")', async () => {
    for (const [matchId, players] of deltaByMatch.entries()) {
      const roomId = players[0]!.assignment.roomId
      const client = deltaPresentClientsByMatch.get(matchId)?.[0]
      assert(client !== undefined, `no tracked present WS client for match ${matchId}`)
      const framesBefore = client.frames.length
      sendWs(client, { type: 'leave_active_room', roomId })
      const response = await waitForFrame(
        client,
        (f) => client.frames.indexOf(f) >= framesBefore && (f.type === 'left_active_room' || f.type === 'error'),
        5_000,
      )
      assert(response !== null, `no response to leave_active_room for already force-closed room ${roomId}`)
      assert(
        !(response.type === 'error' && response.message === 'You are not attached to this room.'),
        `regression: leave_active_room after walkover still returns the scary error: ${JSON.stringify(response)}`,
      )
      assert(response.type === 'left_active_room' && response.roomId === roomId, `expected benign left_active_room, got: ${JSON.stringify(response)}`)
    }
    for (const clients of deltaPresentClientsByMatch.values()) {
      for (const c of clients) closeWs(c)
    }
  })

  await check('[18] Победителят вижда service-win (не e "eliminated", изчаква sibling мача), загубилият не е champion/runner_up', async () => {
    // "eliminated" статусът се финализира едва когато И ДВАТА sibling
    // полуфинала са завършили (bracket-ladder логика в
    // tournamentCoordinator.ts advanceBracketLadder) — точно затова, а не за
    // walkover-specific причина, тук НЕ асертваме 'eliminated' веднага след
    // самия walkover (виж идентичния коментар в
    // checkTournamentRoomStartAndCleanup.ts).
    for (const winnerTeam of deltaSemifinalWinners) {
      for (const { p } of winnerTeam) {
        const detail = await getTournamentDetailHttp(mainPort, p.cookie, delta.tournamentId)
        assert(detail.viewer.myPlacement !== 'eliminated', `winner myPlacement=${detail.viewer.myPlacement}`)
      }
    }
    for (const loserTeam of deltaSemifinalLosers) {
      for (const { p } of loserTeam) {
        const detail = await getTournamentDetailHttp(mainPort, p.cookie, delta.tournamentId)
        assert(detail.viewer.myPlacement !== 'champion' && detail.viewer.myPlacement !== 'runner_up', `loser myPlacement=${detail.viewer.myPlacement}`)
        assert(detail.myActiveMatch === null, 'loser unexpectedly still has an active match')
      }
    }
  })

  let deltaFinalMatchId: string | null = null
  await waitFor('delta: final match is created after both semifinals', async () => {
    const detail = await getTournamentDetailHttp(mainPort, deltaSemifinalWinners[0]![0]!.p.cookie, delta.tournamentId)
    if (detail.myActiveMatch === null) return false
    deltaFinalMatchId = detail.myActiveMatch.matchId
    return true
  }, 20_000)

  const deltaFinalPresentTeam = deltaSemifinalWinners[0]!
  const deltaFinalAbsentTeam = deltaSemifinalWinners[1]!

  await check('[19] Final walkover — само единият финалист се явява (реален ускорен round_transition таймер)', async () => {
    for (const { p } of deltaFinalPresentTeam) {
      const detail = await getTournamentDetailHttp(mainPort, p.cookie, delta.tournamentId)
      assert(detail.myActiveMatch?.matchId === deltaFinalMatchId, 'present finalist missing final assignment')
      const { resumed, failed } = await resumeRoomAndWait(mainPort, p.cookie, detail.myActiveMatch.roomId, detail.myActiveMatch.reconnectToken)
      assert(resumed !== null, `final resume failed: ${JSON.stringify(failed)}`)
    }
    await waitFor('delta final resolves to walkover via real accelerated round-transition timer', () => {
      const match = getRow(mainDb, `SELECT status, result_kind FROM tournament_matches WHERE match_id = ?;`, deltaFinalMatchId)
      return match !== undefined && match.status === 'completed' && match.result_kind === 'walkover'
    }, 15_000)
  })

  await check('[20] Champion/runner-up и settlement exactly once за DELTA', async () => {
    await waitFor('delta tournament settles', async () => {
      const detail = await getTournamentDetailHttp(mainPort, deltaFinalPresentTeam[0]!.p.cookie, delta.tournamentId)
      return detail.status === 'finished' && detail.settlementState === 'settled'
    }, 20_000)
    const championDetail = await getTournamentDetailHttp(mainPort, deltaFinalPresentTeam[0]!.p.cookie, delta.tournamentId)
    assert(championDetail.viewer.myPlacement === 'champion', `expected champion, got ${championDetail.viewer.myPlacement}`)
    const runnerUpDetail = await getTournamentDetailHttp(mainPort, deltaFinalAbsentTeam[0]!.p.cookie, delta.tournamentId)
    assert(runnerUpDetail.viewer.myPlacement === 'runner_up', `expected runner_up, got ${runnerUpDetail.viewer.myPlacement}`)
    const payoutCountFirst = countRows(mainDb, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, delta.tournamentId)
    assert(payoutCountFirst === 4, `expected 4 prize_payout rows, got ${payoutCountFirst}`)
    await sleep(5_000)
    const payoutCountAfter = countRows(mainDb, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, delta.tournamentId)
    assert(payoutCountAfter === payoutCountFirst, `payout count changed after additional ticks: ${payoutCountFirst} -> ${payoutCountAfter}`)
  })

  // ── E. RESET ───────────────────────────────────────────────────────────

  const expectedTournamentsRemoved = skipFullBot ? 1 : 2

  await check(`[21] Reset премахва само dev-API-created турнирите (${skipFullBot ? '' : 'full-bot + '}one-human) и техните тестови профили`, async () => {
    const result = await devReset(mainPort)
    assert(result.tournamentsRemoved === expectedTournamentsRemoved, `expected ${expectedTournamentsRemoved} tournaments removed, got ${result.tournamentsRemoved}`)
    assert(result.profilesRemoved === 1, `expected 1 test-human profile removed (one_human mode), got ${result.profilesRemoved}`)
  })

  await check('[22] Премахнатите турнири реално ги няма в базата', () => {
    const removedTournamentIds = skipFullBot ? [oneHuman.tournamentId] : [fullBot.tournamentId, oneHuman.tournamentId]
    for (const tournamentId of removedTournamentIds) {
      const row = getRow(mainDb, `SELECT tournament_id FROM tournaments WHERE tournament_id = ?;`, tournamentId)
      assert(row === undefined, `tournament ${tournamentId} still present after reset`)
    }
  })

  await check('[23] "Нормалният" control турнир (DELTA, създаден извън dev API) остава напълно непокътнат', () => {
    const row = getRow(mainDb, `SELECT tournament_id, status, settlement_state FROM tournaments WHERE tournament_id = ?;`, delta.tournamentId)
    assert(row !== undefined, 'delta control tournament unexpectedly removed by reset')
    assert(row.status === 'finished' && row.settlement_state === 'settled', 'delta control tournament state corrupted by reset')
  })

  await check('[24] Втори reset е idempotent (0 промени)', async () => {
    const result = await devReset(mainPort)
    assert(result.tournamentsRemoved === 0, `expected 0 tournaments removed on second reset, got ${result.tournamentsRemoved}`)
    assert(result.profilesRemoved === 0, `expected 0 profiles removed on second reset, got ${result.profilesRemoved}`)
  })

} catch (error) {
  console.error('\n[main] Unexpected error, aborting remaining checks in this section:', error)
  failed++
} finally {
  try {
    mainDb?.close()
  } catch {
    // ignore — сървърният процес се спира веднага след това и без значение
  }
  await stopServer(mainServer)
  await main.cleanup()
}

// ─── F. PRODUCTION SAFETY (NODE_ENV=production) ─────────────────────────────

console.log('\n[production-safety] Спавам сървър с NODE_ENV=production + флаг=1...')
const prodRoot = await createIsolatedServerRoot(sourceServerRoot, 'prod-safety')
const prodPort = await getFreePort()
let prodServer: RunningServer | null = null

try {
  prodServer = startServer(prodRoot.serverDir, prodPort, {
    NODE_ENV: 'production',
    BELOT_LOCAL_TOURNAMENT_TEST_MODE: '1',
  })
  console.log(`\n[startup] Чакам production-safety сървъра на порт ${prodPort}...`)
  await waitForHealth(prodPort, false)
  console.log('  Сървърът е готов.')

  await check('[25] Dev endpoint връща 404 при NODE_ENV=production, дори с флаг=1', async () => {
    const r = await httpRequestRaw(prodPort, '/dev/tournament-test', 'GET')
    assert(r.status === 404, `expected 404, got ${r.status}`)
    assert(!r.text.includes('Local Tournament Test Panel'), 'production build не трябва да разкрива dev UI съдържание')
  })

  await check('[26] Dev API create endpoint връща 404 при NODE_ENV=production', async () => {
    const r = await httpRequest(prodPort, '/dev/tournament-test/api/create', 'POST', undefined, { teamCapacity: 4, mode: 'all_bots' })
    assert(r.status === 404, `expected 404, got ${r.status}`)
  })

  await check('[27] Startup log НЕ съдържа "[local-tournament-test] enabled" при NODE_ENV=production', () => {
    assert(!prodServer!.output().includes('[local-tournament-test] enabled'), 'production build не трябва да лlog-ва local-tournament-test enabled')
  })
} finally {
  await stopServer(prodServer)
  await prodRoot.cleanup()
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
