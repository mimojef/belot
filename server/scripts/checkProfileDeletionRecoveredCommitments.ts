/**
 * checkProfileDeletionRecoveredCommitments.ts
 *
 * Самоизтриване на профили — Етап 4K2: възстановени игрови ангажименти и
 * уведомление при автоматична отмяна. РЕАЛНИ отделни процеси (src/index.ts)
 * с обща временна SQLite база и общ временен регистър. Никога реалната база.
 *
 * Race-ът (заявката е COMMIT-ната в A преди snapshot-а на играта в B, а B
 * спира преди poll-а) се възпроизвежда детерминистично: B държи играта, B
 * умира (SIGKILL), snapshot-ът се скрива, A приема заявката през истинския
 * HTTP път, snapshot-ът се връща ("записан след COMMIT-а"), B се рестартира и
 * възстановява играта от базата.
 *
 * [R1] Срив веднага след създаване на маса: масата не оцелява -> без отмяна.
 * [R2] Белот: срив веднага след старт на игра, възстановяване, конфликт при
 *      рестарта, системна отмяна през durable протокола, един запис в
 *      регистъра, неработещ offsite, чакащ текст, повторни рестарти, ack,
 *      невъзможно изтриване, уведомление веднъж, сесии, жълтици.
 * [R3] Не се сърди човече: активен мач, възстановяване, отмяна, икономика.
 * [R4] Потребителска и [R5] административна отмяна — без уведомление;
 *      [R6] тригерите пазят инвариантите на уведомленията.
 * [R7] Необратимо решение в регистъра + възстановена игра -> без отмяна,
 *      сигнал за администратор (fail-closed).
 * [R8] Административно отложено изтриване не се отменя.
 * [R9] Свара — постоянен snapshot, открит периодично от ДРУГ процес.
 * [R10] Нечетимо хранилище на Свара ('unknown') -> без автоматична отмяна.
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { ensureProfileDeletionLedgerRecord, readProfileDeletionLedger } from '../src/db/profileDeletionLedger.js'
import { writeTestLedgerAck } from './fixtures/profileDeletionCancellationKit.js'

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const SECRET = 'profile-deletion-recovered-commitments-secret-0123456789'
const PASSWORD = 'recovered-commitments-pass-4417'
const STAKE = 5000
const PENDING_TEXT = 'Установено е участие в игра или заето място на маса. Отмяната на заявката за изтриване е приета и очаква потвърждение. Докато процесът приключи, профилът остава временно скрит.'
const NOTICE_TEXT = 'Заявката Ви за изтриване беше отменена автоматично. Установено е, че имате заето място на маса или участвате в игра. Профилът Ви е запазен. След като напуснете масата или играта приключи, можете да подадете нова заявка за изтриване.'
const ORDINARY_PENDING_TEXT = 'Отмяната е приета и профилът няма да бъде изтрит. Потвърждаваме я в защитения регистър — след няколко минути ще можете да влезете нормално.'

const originalServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\ncheckProfileDeletionRecoveredCommitments')
console.log(`Server root: ${originalServerRoot}`)

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

const isolatedRoot = await mkdtemp(join(tmpdir(), 'belot-deletion-recovered-'))
const ledgerPath = join(isolatedRoot, 'deletion-ledger', 'profile-deletions.jsonl')
const serverDir = join(isolatedRoot, 'server')
await mkdir(serverDir, { recursive: true })
await cp(join(originalServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
await cp(join(originalServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
await cp(join(originalServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
await cp(join(originalServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
const linkType = process.platform === 'win32' ? 'junction' : 'dir'
await symlink(join(originalServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
await symlink(join(originalServerRoot, '..', 'node_modules'), join(isolatedRoot, 'node_modules'), linkType)

type RunningServer = { label: string; port: number; child: ChildProcessByStdio<null, Readable, Readable>; output(): string }

function startServer(label: string, port: number, reconcileIntervalMs: number): RunningServer {
  const chunks: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
    BELOT_GAME_WORKER_COUNT: '1',
    PASSWORD_RESET_RATE_LIMIT_SECRET: SECRET,
    PROFILE_DELETION_LEDGER_PATH: ledgerPath,
    PROFILE_SELF_DELETION_ENABLED: '1',
    PROFILE_DELETION_CANCELLATION_FINALIZER_INTERVAL_MS: '300',
    PROFILE_DELETION_COMMITMENT_RECONCILE_INTERVAL_MS: String(reconcileIntervalMs),
  }
  delete env.PROFILE_DELETION_LEDGER_OFFSITE_REQUIRED // offsite ack е задължителен
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  return { label, port, child, output: () => chunks.join('') }
}

async function killServer(server: RunningServer, signal: NodeJS.Signals): Promise<void> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return
  const exited = new Promise<void>((res) => server.child.once('exit', () => res()))
  server.child.kill(signal)
  const timer = setTimeout(() => server.child.kill('SIGKILL'), 10_000)
  await exited
  clearTimeout(timer)
}

async function waitForHealth(server: RunningServer): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`Сървър ${server.label} спря:\n${server.output().slice(-2000)}`)
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`)
      const health = await res.json() as { ok?: boolean; gameWorkerLifecycle?: { state?: string } }
      if (res.ok && health.ok === true && health.gameWorkerLifecycle?.state === 'ready') return
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timeout: health ${server.label}\n${server.output().slice(-2000)}`)
}

const bootstrap = await ensureServerDatabaseReady({ serverRootOverride: serverDir })
const db = new DatabaseSync(bootstrap.databaseFilePath)
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode';`).run()

const STARTUP_ONLY = 3_600_000
const servers: RunningServer[] = []
const sockets: WebSocket[] = []

try {
  let serverA = startServer('A', await getFreePort(), STARTUP_ONLY)
  servers.push(serverA)
  await waitForHealth(serverA)
  let serverB = startServer('B', await getFreePort(), STARTUP_ONLY)
  servers.push(serverB)
  await waitForHealth(serverB)

  async function restart(server: RunningServer, signal: NodeJS.Signals, reconcileIntervalMs = STARTUP_ONLY): Promise<RunningServer> {
    await killServer(server, signal)
    const next = startServer(server.label, server.port, reconcileIntervalMs)
    servers.push(next)
    await waitForHealth(next)
    return next
  }

  async function api(server: RunningServer, path: string, init: { method?: string; cookie?: string; body?: unknown } = {}): Promise<{ status: number; json: any; setCookie: string }> {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.cookie ? { Cookie: init.cookie } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, json, setCookie: res.headers.get('set-cookie') ?? '' }
  }

  type User = { profileId: string; accountId: string; email: string; displayName: string; cookie: string }
  let counter = 0
  async function register(label: string): Promise<User> {
    counter += 1
    db.prepare(`DELETE FROM registration_rate_limit_events WHERE scope = 'registration-direct-ip';`).run()
    const email = `recov-${label.toLowerCase()}-${counter}@example.test`
    const displayName = `Rc${label}${counter}`.slice(0, 20)
    const res = await api(serverA, '/api/auth/register', { method: 'POST', body: { email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() } })
    if (res.status !== 200 || !res.json.ok) throw new Error(`регистрация ${label}: ${res.status} ${JSON.stringify(res.json)}`)
    const user = { profileId: res.json.session.profile.profileId, accountId: res.json.session.account.accountId, email, displayName, cookie: res.setCookie.split(';')[0] }
    db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 50000) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance;`).run(user.profileId)
    return user
  }

  async function login(server: RunningServer, user: User): Promise<{ status: number; json: any; cookie: string }> {
    db.prepare(`DELETE FROM registration_rate_limit_events WHERE scope LIKE 'login-%';`).run()
    const res = await api(server, '/api/auth/login', { method: 'POST', body: { email: user.email, password: PASSWORD } })
    return { status: res.status, json: res.json, cookie: res.setCookie.split(';')[0] }
  }

  type Socket = { ws: WebSocket; messages: any[] }
  async function openSocket(server: RunningServer, cookie: string): Promise<Socket> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Cookie: cookie } })
    sockets.push(ws)
    const messages: any[] = []
    ws.on('message', (data) => { try { messages.push(JSON.parse(String(data))) } catch { /* ignore */ } })
    ws.on('error', () => undefined)
    await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j) })
    await waitFor(() => messages.some((m) => m.type === 'connected'), 'connected')
    return { ws, messages }
  }

  async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`Timeout: ${label}`)
  }

  async function sendAndWait(socket: Socket, message: Record<string, unknown>, type: string, label: string): Promise<any> {
    socket.messages.length = 0
    socket.ws.send(JSON.stringify(message))
    await waitFor(() => socket.messages.some((m) => m.type === type || m.type === 'error' || m.type === 'cross_game_commitment_blocked'), label)
    const frame = socket.messages.find((m) => m.type === type)
    if (frame === undefined) throw new Error(`${label}: ${JSON.stringify(socket.messages.slice(-3))}`)
    return frame
  }

  async function submitVia(server: RunningServer, user: User): Promise<{ status: number; json: any }> {
    db.prepare(`DELETE FROM registration_rate_limit_events WHERE scope LIKE 'profile-deletion-submit-%';`).run()
    return await api(server, '/api/account/deletion-request', { method: 'POST', cookie: user.cookie, body: { password: PASSWORD, confirm: true } })
  }

  type CancellationRow = { cancellation_id: string; source: string; ledger_recorded_at: string | null; finalized_at: string | null }
  const latestRequest = (profileId: string) => db.prepare('SELECT request_id, status FROM profile_deletion_requests WHERE profile_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1;').get(profileId) as { request_id: string; status: string } | undefined
  const cancellationsFor = (requestId: string) => db.prepare('SELECT cancellation_id, source, ledger_recorded_at, finalized_at FROM profile_deletion_cancellations WHERE request_id = ?;').all(requestId) as CancellationRow[]
  const noticeFor = (cancellationId: string) => db.prepare('SELECT delivered_at FROM profile_deletion_auto_cancellation_notices WHERE cancellation_id = ?;').get(cancellationId) as { delivered_at: string | null } | undefined
  const ledgerKinds = (requestId: string) => readProfileDeletionLedger(ledgerPath).records
    .filter((record: any) => record.requestId === requestId)
    .map((record: any) => record.kind ?? 'intent')
  const activeSessions = (profileId: string) => (db.prepare('SELECT COUNT(*) AS c FROM account_sessions WHERE profile_id = ? AND revoked_at IS NULL;').get(profileId) as { c: number }).c
  const walletOf = (profileId: string) => (db.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?;').get(profileId) as { b: number }).b
  const belotSnapshotOf = (profileId: string) => db.prepare(`SELECT room_id, is_active FROM active_room_snapshots WHERE room_status = 'playing' AND instr(snapshot_json, ?) > 0 ORDER BY rowid DESC LIMIT 1;`).get(profileId) as { room_id: string; is_active: number } | undefined
  const ludoSnapshotOf = (profileId: string) => db.prepare(`SELECT match_id, is_active FROM active_ludo_match_snapshots WHERE match_status = 'in_progress' AND instr(snapshot_json, ?) > 0 ORDER BY rowid DESC LIMIT 1;`).get(profileId) as { match_id: string; is_active: number } | undefined
  const profileVisible = async (viewer: User, profileId: string) => (await api(serverA, `/api/profiles/${profileId}`, { cookie: viewer.cookie })).status === 200
  const countRows = (sql: string, ...params: Array<string | number>) => (db.prepare(sql).get(...params) as { c: number }).c

  const observer = await register('Observer')

  // ═══ Цикъл 1: маса, игра на Белот, мач в Не се сърди човече в процес B ═══
  console.log('\n[setup] Процес B: чакаща маса (T), игра на Белот (U), мач в Не се сърди човече (H, G)')

  const tableUser = await register('Table')
  const belotUser = await register('Belot')
  const ludoHost = await register('LudoH')
  const ludoGuest = await register('LudoG')

  const tableSocket = await openSocket(serverB, tableUser.cookie)
  await sendAndWait(tableSocket, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 }, 'private_room_updated', 'маса в B')
  const belotSocket = await openSocket(serverB, belotUser.cookie)
  await sendAndWait(belotSocket, { type: 'create_room', displayName: belotUser.displayName }, 'room_created', 'игра на Белот в B')
  await waitFor(() => belotSnapshotOf(belotUser.profileId)?.is_active === 1, 'snapshot на Белот')
  const hostSocket = await openSocket(serverB, ludoHost.cookie)
  const ludoRoom = await sendAndWait(hostSocket, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: false }, 'ludo_room_updated', 'Не се сърди човече в B')
  const guestSocket = await openSocket(serverB, ludoGuest.cookie)
  guestSocket.ws.send(JSON.stringify({ type: 'join_ludo_room', ludoRoomId: ludoRoom.room.id }))
  await waitFor(() => hostSocket.messages.some((m) => m.type === 'ludo_game_started'), 'ludo_game_started')
  await waitFor(() => ludoSnapshotOf(ludoHost.profileId)?.is_active === 1, 'snapshot на мача')

  // B спира, преди да обработи каквото и да е.
  await killServer(serverB, 'SIGKILL')
  const belotRoomId = belotSnapshotOf(belotUser.profileId)!.room_id
  const ludoMatchId = ludoSnapshotOf(ludoHost.profileId)!.match_id
  db.prepare('UPDATE active_room_snapshots SET is_active = 0 WHERE room_id = ?;').run(belotRoomId)
  db.prepare('UPDATE active_ludo_match_snapshots SET is_active = 0 WHERE match_id = ?;').run(ludoMatchId)
  const submitted = {
    table: await submitVia(serverA, tableUser),
    belot: await submitVia(serverA, belotUser),
    ludo: await submitVia(serverA, ludoHost),
  }
  // "Snapshot-ът е записан след COMMIT-а на заявката."
  db.prepare('UPDATE active_room_snapshots SET is_active = 1 WHERE room_id = ?;').run(belotRoomId)
  db.prepare('UPDATE active_ludo_match_snapshots SET is_active = 1 WHERE match_id = ?;').run(ludoMatchId)
  const walletsBefore = { belot: walletOf(belotUser.profileId), host: walletOf(ludoHost.profileId), guest: walletOf(ludoGuest.profileId) }
  const ludoEconomyRowsBefore = countRows('SELECT COUNT(*) AS c FROM ludo_match_economy_ledger WHERE match_id = ?;', ludoMatchId)

  console.log('\n[R0] A приема заявките (не вижда паметта на мъртвия B); B се рестартира и възстановява игрите')
  await check('[R0] Трите заявки са приети от A (200), сесиите са отнети', () => {
    for (const [label, res] of Object.entries(submitted)) assert(res.status === 200, `${label}: ${res.status} ${JSON.stringify(res.json)}`)
    for (const user of [tableUser, belotUser, ludoHost]) assert(activeSessions(user.profileId) === 0, 'активни сесии')
  })
  const belotRequestId = latestRequest(belotUser.profileId)!.request_id
  const ludoRequestId = latestRequest(ludoHost.profileId)!.request_id
  const tableRequestId = latestRequest(tableUser.profileId)!.request_id

  serverB = startServer('B', serverB.port, STARTUP_ONLY)
  servers.push(serverB)
  await waitForHealth(serverB)

  console.log('\n[R1] Срив веднага след създаване на маса')
  await check('[R1] Чакащата маса не оцелява след рестарта -> заявката остава валидно приета (без отмяна и без уведомление)', async () => {
    await new Promise((r) => setTimeout(r, 1500))
    assert(cancellationsFor(tableRequestId).length === 0, 'неочаквана отмяна')
    assert(latestRequest(tableUser.profileId)!.status === 'pending', 'статус')
  })

  console.log('\n[R2] Белот: срив веднага след старт на игра и възстановяване')
  let belotCancellationId = ''
  await check('[R2a] Рестартът на B възстановява играта и открива конфликта: системна отмяна (source=system), записана в регистъра; лог origin=startup', async () => {
    await waitFor(() => cancellationsFor(belotRequestId)[0]?.ledger_recorded_at != null, 'системна отмяна')
    const [row] = cancellationsFor(belotRequestId)
    assert(row.source === 'system', `source=${row.source}`)
    belotCancellationId = row.cancellation_id
    assert(serverB.output().includes(`mode=auto_cancel_accepted_recovered_commitment origin=startup requestId=${belotRequestId}`), 'лог в B')
    const kinds = ledgerKinds(belotRequestId)
    assert(kinds.filter((k: string) => k === 'request_cancelled').length === 1 && !kinds.includes('request_deletion_decided'), `регистър: ${kinds.join(',')}`)
  })

  await check('[R2b] Играта НЕ е прекратена (snapshot активен, стаята е възстановена в B); жълтиците са непроменени', async () => {
    assert(belotSnapshotOf(belotUser.profileId)?.is_active === 1, 'snapshot-ът е деактивиран')
    assert(walletOf(belotUser.profileId) === walletsBefore.belot, 'жълтиците са променени')
    assert(serverB.output().includes(belotRoomId) || belotSnapshotOf(belotUser.profileId)?.room_id === belotRoomId, 'стаята')
  })

  await check('[R2c] Неработещ offsite: след няколко цикъла отмяната още чака; заявката е pending, но преходът към executing е невъзможен; профилът е скрит', async () => {
    await new Promise((r) => setTimeout(r, 1500)) // ~5 цикъла на финализатора
    const [row] = cancellationsFor(belotRequestId)
    assert(row.finalized_at === null && latestRequest(belotUser.profileId)!.status === 'pending', 'финализирана без ack')
    let refused = ''
    try { db.prepare(`UPDATE profile_deletion_requests SET status = 'executing' WHERE request_id = ?;`).run(belotRequestId) } catch (error) { refused = String(error) }
    assert(refused.includes('profile_deletion_cancellation_pending'), `преход: ${refused || 'позволен'}`)
    assert(!(await profileVisible(observer, belotUser.profileId)), 'профилът е видим')
    assert(noticeFor(belotCancellationId)?.delivered_at === null, 'уведомлението липсва или е показано')
  })

  await check('[R2d] Вход докато чака: 403 с текста за автоматична отмяна (без "Профилът Ви е запазен"), без токен и без сесия; старата сесия е отказана', async () => {
    const res = await login(serverA, belotUser)
    assert(res.status === 403 && res.json.cancellationPending === true && res.json.cancellationMessage === PENDING_TEXT, `${res.status} ${JSON.stringify(res.json)}`)
    assert(res.json.restoreToken === undefined && !res.cookie.includes('='), 'токен/сесия')
    assert(!JSON.stringify(res.json).includes('Профилът Ви е запазен'), 'преждевременно "запазен"')
    assert((await api(serverA, '/api/friends', { cookie: belotUser.cookie })).status === 401, 'старата сесия е приета')
  })

  await check('[R2e] Повторни рестарти (B и A) не създават втора отмяна, второ уведомление или втори запис в регистъра', async () => {
    serverB = await restart(serverB, 'SIGKILL')
    serverA = await restart(serverA, 'SIGTERM')
    await new Promise((r) => setTimeout(r, 1000))
    assert(cancellationsFor(belotRequestId).length === 1, `отмени: ${cancellationsFor(belotRequestId).length}`)
    assert(countRows('SELECT COUNT(*) AS c FROM profile_deletion_auto_cancellation_notices n JOIN profile_deletion_cancellations c ON c.cancellation_id = n.cancellation_id WHERE c.request_id = ?;', belotRequestId) === 1, 'уведомления')
    assert(ledgerKinds(belotRequestId).filter((k: string) => k === 'request_cancelled').length === 1, `регистър: ${ledgerKinds(belotRequestId).join(',')}`)
  })

  await check('[R2f] След offsite ack: cancelled, профилът е видим; след края на играта изтриване е невъзможно (крайно състояние)', async () => {
    writeTestLedgerAck(ledgerPath)
    await waitFor(() => latestRequest(belotUser.profileId)?.status === 'cancelled', 'cancelled')
    assert(await profileVisible(observer, belotUser.profileId), 'скрит')
    db.prepare('UPDATE active_room_snapshots SET is_active = 0 WHERE room_id = ?;').run(belotRoomId) // "играта приключи"
    let refused = ''
    try { db.prepare(`UPDATE profile_deletion_requests SET status = 'executing' WHERE request_id = ?;`).run(belotRequestId) } catch (error) { refused = String(error) }
    assert(refused.includes('profile_deletion_invalid_status_transition'), `преход: ${refused || 'позволен'}`)
    assert(walletOf(belotUser.profileId) === walletsBefore.belot, 'жълтиците са променени')
  })

  await check('[R2g] Успешен вход -> точното уведомление веднъж; втори вход и /api/auth/me -> без уведомление; старата сесия НЕ е възстановена', async () => {
    const first = await login(serverA, belotUser)
    assert(first.status === 200 && first.json.ok === true && first.json.profileDeletionAutoCancellationNotice === NOTICE_TEXT, `${first.status} ${JSON.stringify(first.json?.profileDeletionAutoCancellationNotice)}`)
    assert(noticeFor(belotCancellationId)?.delivered_at != null, 'не е маркирано като показано')
    const me = await api(serverB, '/api/auth/me', { cookie: first.cookie })
    assert(me.status === 200 && !JSON.stringify(me.json).includes('profileDeletionAutoCancellationNotice'), 'уведомление в /api/auth/me')
    const second = await login(serverB, belotUser)
    assert(second.status === 200 && second.json.profileDeletionAutoCancellationNotice === undefined, 'повторно уведомление')
    assert((await api(serverA, '/api/friends', { cookie: belotUser.cookie })).status === 401, 'старата сесия е възстановена')
  })

  console.log('\n[R3] Не се сърди човече: активен мач, възстановяване')
  await check('[R3] Мачът е възстановен; отмяна през протокола; след ack -> cancelled; мачът не е прекратен; жълтици и икономика непроменени', async () => {
    await waitFor(() => cancellationsFor(ludoRequestId)[0]?.ledger_recorded_at != null, 'системна отмяна')
    assert(cancellationsFor(ludoRequestId).length === 1 && cancellationsFor(ludoRequestId)[0].source === 'system', 'отмяна')
    writeTestLedgerAck(ledgerPath)
    await waitFor(() => latestRequest(ludoHost.profileId)?.status === 'cancelled', 'cancelled')
    assert(ludoSnapshotOf(ludoHost.profileId)?.is_active === 1, 'мачът е прекратен')
    assert(walletOf(ludoHost.profileId) === walletsBefore.host && walletOf(ludoGuest.profileId) === walletsBefore.guest, 'жълтиците са променени')
    assert(countRows('SELECT COUNT(*) AS c FROM ludo_match_economy_ledger WHERE match_id = ?;', ludoMatchId) === ludoEconomyRowsBefore, 'икономиката е променена')
    assert(latestRequest(ludoGuest.profileId) === undefined, 'заявка за госта')
  })

  // ═══ [R4]-[R6] Без уведомление при потребителска/административна отмяна ═══
  console.log('\n[R4]-[R6] Потребителска и административна отмяна')

  await check('[R4] Потребителска отмяна -> обичайният текст докато чака; след ack вход без уведомление', async () => {
    const user = await register('UserCancel')
    assert((await submitVia(serverA, user)).status === 200, 'подаване')
    const pending = await login(serverA, user)
    const cancel = await api(serverA, '/api/account/deletion-request/cancel', { method: 'POST', body: { restoreToken: pending.json.restoreToken } })
    assert(cancel.status === 200, `отмяна ${cancel.status}`)
    const waiting = await login(serverA, user)
    assert(waiting.json.cancellationMessage === ORDINARY_PENDING_TEXT, `текст: ${waiting.json.cancellationMessage}`)
    writeTestLedgerAck(ledgerPath)
    await waitFor(() => latestRequest(user.profileId)?.status === 'cancelled', 'cancelled')
    const ok = await login(serverA, user)
    assert(ok.status === 200 && ok.json.profileDeletionAutoCancellationNotice === undefined, 'уведомление при потребителска отмяна')
    assert(noticeFor(cancellationsFor(latestRequest(user.profileId)!.request_id)[0].cancellation_id) === undefined, 'ред за уведомление')
  })

  let adminCancellationId = ''
  await check('[R5] Административна отмяна (истинският API) -> вход без уведомление', async () => {
    const admin = await register('Admin')
    db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(admin.accountId)
    const target = await register('AdmTarget')
    assert((await submitVia(serverA, target)).status === 200, 'подаване')
    const requestId = latestRequest(target.profileId)!.request_id
    const cancelled = await api(serverA, `/api/admin/profile-deletions/${requestId}/cancel`, { method: 'POST', cookie: admin.cookie, body: { reason: 'Проверка 4K2' } })
    assert(cancelled.status === 200, `админ отмяна ${cancelled.status} ${JSON.stringify(cancelled.json)}`)
    writeTestLedgerAck(ledgerPath)
    await waitFor(() => latestRequest(target.profileId)?.status === 'cancelled', 'cancelled')
    const ok = await login(serverA, target)
    assert(ok.status === 200 && ok.json.profileDeletionAutoCancellationNotice === undefined, 'уведомление при админ отмяна')
    adminCancellationId = cancellationsFor(requestId)[0].cancellation_id
    assert(noticeFor(adminCancellationId) === undefined, 'ред за уведомление')
  })

  await check('[R6] Тригерите: уведомление само за системна отмяна; показване само след окончателна отмяна и само веднъж', () => {
    const expectAbort = (fn: () => void, code: string) => {
      let message = ''
      try { fn() } catch (error) { message = String(error) }
      assert(message.includes(code), `очаквано ${code}, получено ${message || 'успех'}`)
    }
    expectAbort(() => db.prepare('INSERT INTO profile_deletion_auto_cancellation_notices (cancellation_id) VALUES (?);').run(adminCancellationId), 'profile_deletion_notice_requires_system_cancellation')
    expectAbort(() => db.prepare(`UPDATE profile_deletion_auto_cancellation_notices SET delivered_at = NULL WHERE cancellation_id = ?;`).run(belotCancellationId), 'profile_deletion_notice_immutable')
  })

  // ═══ Цикъл 2: необратимо решение и административно отложено изтриване ═══
  console.log('\n[R7]-[R8] Необратимо решение и административно изтриване при възстановена игра')
  const decidedUser = await register('Decided')
  const adminTargetUser = await register('AdmPending')
  const adminActor = await register('AdmActor')
  for (const user of [decidedUser, adminTargetUser]) {
    const socket = await openSocket(serverB, user.cookie)
    await sendAndWait(socket, { type: 'create_room', displayName: user.displayName }, 'room_created', `игра за ${user.displayName}`)
    await waitFor(() => belotSnapshotOf(user.profileId)?.is_active === 1, 'snapshot')
  }
  await killServer(serverB, 'SIGKILL')
  const cycle2Rooms = [belotSnapshotOf(decidedUser.profileId)!.room_id, belotSnapshotOf(adminTargetUser.profileId)!.room_id]
  for (const roomId of cycle2Rooms) db.prepare('UPDATE active_room_snapshots SET is_active = 0 WHERE room_id = ?;').run(roomId)
  assert((await submitVia(serverA, decidedUser)).status === 200, 'подаване decided')
  assert((await submitVia(serverA, adminTargetUser)).status === 200, 'подаване admin target')
  const decidedRequestId = latestRequest(decidedUser.profileId)!.request_id
  const adminTargetRequestId = latestRequest(adminTargetUser.profileId)!.request_id
  // Необратимо решение в регистъра (напр. база, възстановена с разминат часовник).
  ensureProfileDeletionLedgerRecord(ledgerPath, { v: 1, kind: 'request_deletion_decided', requestId: decidedRequestId, profileId: decidedUser.profileId, recordedAt: new Date().toISOString() })
  const pendingModerationId = randomUUID()
  db.prepare(`INSERT INTO pending_profile_moderation (pending_id, target_profile_id, action, requested_by_profile_id, requested_by_account_id, reason) VALUES (?, ?, 'delete', ?, ?, 'Административно изтриване след играта');`)
    .run(pendingModerationId, adminTargetUser.profileId, adminActor.profileId, adminActor.accountId)
  for (const roomId of cycle2Rooms) db.prepare('UPDATE active_room_snapshots SET is_active = 1 WHERE room_id = ?;').run(roomId)
  serverB = startServer('B', serverB.port, STARTUP_ONLY)
  servers.push(serverB)
  await waitForHealth(serverB)

  await check('[R7] Регистърът доказва необратимо решение -> БЕЗ отмяна, без уведомление; заявката е непроменена; сигнал за административна проверка', async () => {
    await waitFor(() => serverB.output().includes(`mode=commitment_conflict_irreversible requestId=${decidedRequestId}`), 'сигнал')
    assert(cancellationsFor(decidedRequestId).length === 0, 'отмяна след необратимо решение')
    assert(latestRequest(decidedUser.profileId)!.status === 'pending', 'статус')
    assert(belotSnapshotOf(decidedUser.profileId)?.is_active === 1, 'играта е прекратена')
  })

  await check('[R8] Административното отложено изтриване остава непокътнато (отменя се само доброволната заявка)', async () => {
    await waitFor(() => cancellationsFor(adminTargetRequestId)[0]?.ledger_recorded_at != null, 'системна отмяна на доброволната')
    assert(db.prepare('SELECT 1 FROM pending_profile_moderation WHERE pending_id = ?;').get(pendingModerationId) !== undefined, 'административното изтриване е отменено')
    assert(!ledgerKinds(adminTargetRequestId).some((k: string) => k.startsWith('admin_')), 'административен запис')
  })
  for (const roomId of cycle2Rooms) db.prepare('UPDATE active_room_snapshots SET is_active = 0 WHERE room_id = ?;').run(roomId)
  db.prepare('DELETE FROM pending_profile_moderation WHERE pending_id = ?;').run(pendingModerationId)

  // ═══ [R9]-[R10] Свара и периодичната проверка в ДРУГ процес ═════════════
  console.log('\n[R9]-[R10] Свара: периодична проверка в процес A')
  serverA = await restart(serverA, 'SIGTERM', 500)
  const svaraOther = await register('SvaraOther')

  function insertSvaraSnapshot(seats: string[], snapshotJson?: string): string {
    const matchId = randomUUID()
    const json = snapshotJson ?? JSON.stringify({ formatVersion: 1, matchId, revision: 0, state: { phase: 'in-progress', seats, status: Object.fromEntries(seats.map((id) => [id, 'active'])) } })
    db.prepare(`INSERT INTO svara_match_snapshots (match_id, format_version, revision, match_status, snapshot_json) VALUES (?, 1, 0, 'in-progress', ?);`).run(matchId, json)
    return matchId
  }

  await check('[R9] Постоянен snapshot на Свара, появил се след приемането -> A го открива периодично (origin=periodic) и отменя през протокола', async () => {
    const user = await register('Svara')
    assert((await submitVia(serverA, user)).status === 200, 'подаване')
    const requestId = latestRequest(user.profileId)!.request_id
    // > 2 цикъла на poll-а (1 s) в B: събитието 'requested' вече е обработено
    // там без игра, така че отмяната може да дойде само от периодичната проверка.
    await new Promise((r) => setTimeout(r, 2500))
    assert(cancellationsFor(requestId).length === 0, 'отмяна без игра')
    const matchId = insertSvaraSnapshot([user.profileId, svaraOther.profileId])
    try {
      await waitFor(() => cancellationsFor(requestId)[0]?.ledger_recorded_at != null, 'системна отмяна')
      assert(serverA.output().includes(`mode=auto_cancel_accepted_recovered_commitment origin=periodic requestId=${requestId}`), 'лог origin=periodic')
    } finally {
      db.prepare(`UPDATE svara_match_snapshots SET match_status = 'closed' WHERE match_id = ?;`).run(matchId)
    }
  })

  await check('[R10] Нечетимо хранилище на Свара (повреден snapshot) -> само "unknown": без автоматична отмяна', async () => {
    const user = await register('SvaraBad')
    assert((await submitVia(serverA, user)).status === 200, 'подаване')
    const requestId = latestRequest(user.profileId)!.request_id
    const matchId = randomUUID()
    const badJson = JSON.stringify({ formatVersion: 1, matchId, revision: 0, state: { phase: 'in-progress', seats: user.profileId, status: 'повреден' } })
    insertSvaraSnapshot([], badJson)
    try {
      await new Promise((r) => setTimeout(r, 2500)) // ~5 периодични проверки
      assert(cancellationsFor(requestId).length === 0, 'отмяна при нечетимо хранилище')
      assert(latestRequest(user.profileId)!.status === 'pending', 'статус')
    } finally {
      db.prepare(`UPDATE svara_match_snapshots SET match_status = 'closed' WHERE match_id = ?;`).run(matchId)
    }
  })

  await check('[R11] Паролата и текстовете на уведомленията не са в регистъра; паролата не е в логовете', () => {
    const ledgerText = readProfileDeletionLedger(ledgerPath).records.map((r) => JSON.stringify(r)).join('\n')
    assert(!ledgerText.includes('Заявката Ви') && !ledgerText.includes('Установено е') && !ledgerText.includes(PASSWORD), 'лични данни/текстове в регистъра')
    for (const server of servers) assert(!server.output().includes(PASSWORD), `парола в лога на ${server.label}`)
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  (неочаквана грешка): ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  for (const server of servers) console.error(`--- ${server.label} ---\n${server.output().slice(-2500)}`)
} finally {
  for (const ws of sockets) { try { ws.close() } catch { /* ignore */ } }
  for (const server of servers) await killServer(server, 'SIGTERM')
  db.close()
  await rm(isolatedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
