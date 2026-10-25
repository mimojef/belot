/**
 * checkProfileDeletionCommitmentGuard.ts
 *
 * Самоизтриване на профили — Етап 4K: отказ на заявката при незавършени
 * ангажименти, през РЕАЛЕН HTTP/WS сървър (src/index.ts) в ИЗОЛИРАНО копие на
 * server/ с temp база и temp регистър. Никога реалната база.
 *
 * [T] Турнири: записване през истинския API, отписване и повторен опит,
 *     статуси (open/starting/полуфинал/финал), финалист, създател, чакащ
 *     партньор (инициатор) — отказ; приключил/отменен/елиминиран/отписан/
 *     поканен без отговор — допуснато.
 * [B] Частни маси в Белот (публична и заключена): създател, присъединен,
 *     затворен прозорец (мястото остава), напускане и повторен опит.
 * [L] Частни маси в „Не се сърди човече“: създател, присъединен, напускане.
 * [M] Търсене на игра в Белот.
 * [A] Активна игра: Белот (вкл. прекъсната връзка с възстановимо място) и
 *     „Не се сърди човече“.
 * [C] Конкурентни операции: маса/турнир едновременно с подаването.
 * [S] Без странични ефекти и без парола в логовете.
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
import { createProfileDeletionRequestStore } from '../src/db/profileDeletionRequestStore.js'

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

const SECRET = 'profile-deletion-commitment-guard-secret-0123456789'
const PASSWORD = 'commitment-guard-pass-7731'
const STAKE = 5000

const MESSAGES = {
  ACTIVE_GAME: 'Не можете да подадете заявка за изтриване, докато участвате в активна игра. Изчакайте играта да приключи и опитайте отново.',
  BELOT_PRIVATE_TABLE: 'Имате заето място на частна маса в Белот. Напуснете масата, преди да подадете заявка за изтриване на профила.',
  LUDO_PRIVATE_TABLE: 'Имате заето място на частна маса в „Не се сърди човече“. Напуснете масата, преди да подадете заявка за изтриване на профила.',
  BELOT_MATCHMAKING: 'В момента търсите игра в Белот. Спрете търсенето, преди да подадете заявка за изтриване на профила.',
  TOURNAMENT_REGISTRATION: 'Не можете да подадете заявка за изтриване на профила, защото сте записан за участие в турнир. Напуснете турнира или изчакайте той да приключи, след което опитайте отново.',
  TOURNAMENT_ORGANIZER: 'Не можете да подадете заявка за изтриване на профила, защото сте организатор на турнир, който още не е приключил. Изчакайте турнирът да приключи или го отменете, ако това все още е възможно, след което опитайте отново.',
} as const
type BlockerCode = keyof typeof MESSAGES

const originalServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\ncheckProfileDeletionCommitmentGuard')
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

const isolatedRoot = await mkdtemp(join(tmpdir(), 'belot-deletion-commitments-'))
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

type RunningServer = { child: ChildProcessByStdio<null, Readable, Readable>; output(): string }

function startServer(port: number): RunningServer {
  const chunks: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
    BELOT_GAME_WORKER_COUNT: '1',
    PASSWORD_RESET_RATE_LIMIT_SECRET: SECRET,
    PROFILE_DELETION_LEDGER_PATH: ledgerPath,
    PROFILE_SELF_DELETION_ENABLED: '1',
  }
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((res) => {
    const timer = setTimeout(() => { server.child.kill('SIGKILL'); res() }, 10_000)
    server.child.once('exit', () => { clearTimeout(timer); res() })
  })
}

async function waitForHealth(port: number, server: RunningServer): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`Сървърът спря:\n${server.output().slice(-2000)}`)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      const health = await res.json() as { ok?: boolean; gameWorkerLifecycle?: { state?: string } }
      if (res.ok && health.ok === true && health.gameWorkerLifecycle?.state === 'ready') return
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timeout: health\n${server.output().slice(-2000)}`)
}

const bootstrap = await ensureServerDatabaseReady({ serverRootOverride: serverDir })
const db = new DatabaseSync(bootstrap.databaseFilePath)
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode';`).run()

let server: RunningServer | null = null
const sockets: WebSocket[] = []

try {
  const port = await getFreePort()
  const base = `http://127.0.0.1:${port}`
  server = startServer(port)
  await waitForHealth(port, server)

  async function api(path: string, init: { method?: string; cookie?: string; body?: unknown } = {}): Promise<{ status: number; json: any; setCookie: string }> {
    const res = await fetch(`${base}${path}`, {
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

  type User = { profileId: string; accountId: string; displayName: string; cookie: string }
  let counter = 0
  async function register(label: string): Promise<User> {
    counter += 1
    db.prepare(`DELETE FROM registration_rate_limit_events WHERE scope = 'registration-direct-ip';`).run()
    const email = `commit-${label.toLowerCase()}-${counter}@example.test`
    const displayName = `Commit${label}${counter}`.slice(0, 20)
    const res = await api('/api/auth/register', { method: 'POST', body: { email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() } })
    if (res.status !== 200 || !res.json.ok) throw new Error(`регистрация ${label}: ${res.status} ${JSON.stringify(res.json)}`)
    const user = { profileId: res.json.session.profile.profileId, accountId: res.json.session.account.accountId, displayName, cookie: res.setCookie.split(';')[0] }
    db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 50000) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance;`).run(user.profileId)
    return user
  }

  type Socket = { ws: WebSocket; messages: any[]; closed: Promise<void> }
  async function openSocket(user: User): Promise<Socket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: user.cookie } })
    sockets.push(ws)
    const messages: any[] = []
    ws.on('message', (data) => { try { messages.push(JSON.parse(String(data))) } catch { /* ignore */ } })
    const closed = new Promise<void>((r) => ws.once('close', () => r()))
    await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j) })
    await waitFor(() => messages.some((m) => m.type === 'connected'), 'connected')
    return { ws, messages, closed }
  }

  async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
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

  const requestCount = (profileId: string) => (db.prepare('SELECT COUNT(*) AS c FROM profile_deletion_requests WHERE profile_id = ?;').get(profileId) as { c: number }).c
  const eventCount = (profileId: string) => (db.prepare('SELECT COUNT(*) AS c FROM profile_deletion_events WHERE profile_id = ?;').get(profileId) as { c: number }).c
  const walletOf = (profileId: string) => (db.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?;').get(profileId) as { b: number }).b

  // Лимитът за подаване (20/час от IP) е извън обхвата: всички опити са от 127.0.0.1.
  const clearSubmitRateLimit = () => db.prepare(`DELETE FROM registration_rate_limit_events WHERE scope LIKE 'profile-deletion-submit-%';`).run()
  async function submit(user: User): Promise<{ status: number; json: any }> {
    clearSubmitRateLimit()
    return await api('/api/account/deletion-request', { method: 'POST', cookie: user.cookie, body: { password: PASSWORD, confirm: true } })
  }

  // Отказ: точният код и текст, без заявка/събитие, сесията и WS връзката
  // остават, без промяна на жълтиците.
  async function expectRefused(user: User, code: BlockerCode, socket: Socket | null = null): Promise<void> {
    const walletBefore = walletOf(user.profileId)
    const res = await submit(user)
    assert(res.status === 409 && res.json.code === code && res.json.message === MESSAGES[code], `очакван ${code}: ${res.status} ${JSON.stringify(res.json)}`)
    assert(JSON.stringify(res.json).includes(PASSWORD) === false, 'паролата е в отговора')
    assert(requestCount(user.profileId) === 0, 'създадена заявка')
    assert(eventCount(user.profileId) === 0, 'записано събитие')
    assert(walletOf(user.profileId) === walletBefore, 'жълтиците са променени')
    assert((await api('/api/friends', { cookie: user.cookie })).status === 200, 'сесията е отнета')
    if (socket !== null) {
      await new Promise((r) => setTimeout(r, 150))
      assert(socket.ws.readyState === WebSocket.OPEN, 'WS връзката е затворена')
      assert(!socket.messages.some((m) => m.type === 'session_deletion_requested'), 'session_deletion_requested')
    }
  }

  async function expectAccepted(user: User): Promise<void> {
    const res = await submit(user)
    assert(res.status === 200 && res.json.ok === true, `очаквано приемане: ${res.status} ${JSON.stringify(res.json)}`)
    assert(requestCount(user.profileId) === 1, 'заявката липсва')
  }

  const observer = await register('Observer')
  const observerSocket = await openSocket(observer)
  async function privateRoomOf(profileId: string): Promise<any | null> {
    const list = await sendAndWait(observerSocket, { type: 'request_private_rooms_list' }, 'private_rooms_list', 'private_rooms_list')
    return list.rooms.find((r: any) => r.slots.some((s: any) => s.occupant?.profileId === profileId)) ?? null
  }
  async function ludoRoomOf(profileId: string): Promise<any | null> {
    const list = await sendAndWait(observerSocket, { type: 'request_ludo_rooms_list' }, 'ludo_rooms_list', 'ludo_rooms_list')
    return list.rooms.find((r: any) => r.players.some((p: any) => p.profileId === profileId)) ?? null
  }

  // Отделен създател за всеки турнир (един активен турнир на създател —
  // idx_tournaments_one_active_per_creator); профилът е само в базата.
  function insertBareProfile(): string {
    const accountId = randomUUID()
    const profileId = randomUUID()
    const handle = `tcreator${profileId.slice(0, 8)}`
    db.prepare(`INSERT INTO accounts (account_id, email, password_hash) VALUES (?, ?, 'x');`).run(accountId, `${handle}@example.test`)
    db.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, username, normalized_username) VALUES (?, ?, ?, ?, ?, ?);`).run(profileId, accountId, handle, handle, handle, handle)
    return profileId
  }
  function insertTournament(status: string, creatorProfileId = insertBareProfile()): string {
    const tournamentId = randomUUID()
    db.prepare(`INSERT INTO tournaments (tournament_id, name, entry_fee, start_mode, status, creator_profile_id) VALUES (?, ?, 100, 'fill', ?, ?);`)
      .run(tournamentId, `Турнир ${status}`, status, creatorProfileId)
    return tournamentId
  }
  function insertEntry(tournamentId: string, profileId: string, status: string, joinedAs = 'solo', teamId: string | null = null): void {
    db.prepare(`INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status) VALUES (?, ?, ?, ?, ?, ?);`)
      .run(randomUUID(), tournamentId, profileId, teamId, joinedAs, status)
  }

  // ═══ [T] Турнири ══════════════════════════════════════════════════════
  console.log('\n[T] Турнири')

  await check('[T1] Записан (истинският API) в предстоящ турнир -> 409 TOURNAMENT_REGISTRATION; участието остава; отписване -> повторният опит е приет', async () => {
    const user = await register('TJoin')
    const tournamentId = insertTournament('open')
    const joined = await api(`/api/tournaments/${tournamentId}/join`, { method: 'POST', cookie: user.cookie, body: {} })
    assert(joined.status === 200, `записване: ${joined.status} ${JSON.stringify(joined.json)}`)
    await expectRefused(user, 'TOURNAMENT_REGISTRATION')
    const entry = db.prepare('SELECT status FROM tournament_entries WHERE tournament_id = ? AND profile_id = ?;').get(tournamentId, user.profileId) as { status: string }
    assert(entry.status === 'confirmed', `участието е променено: ${entry.status}`)
    const left = await api(`/api/tournaments/${tournamentId}/leave`, { method: 'POST', cookie: user.cookie, body: {} })
    assert(left.status === 200, `отписване: ${left.status} ${JSON.stringify(left.json)}`)
    await expectAccepted(user)
  })

  await check('[T2] Започнал турнир (starting / полуфинал / финал) и финалист -> TOURNAMENT_REGISTRATION', async () => {
    for (const [status, entryStatus] of [['starting', 'confirmed'], ['semifinal_in_progress', 'confirmed'], ['final_in_progress', 'confirmed'], ['final_in_progress', 'finalist']] as const) {
      const user = await register(`TS${status.slice(0, 4)}`)
      insertEntry(insertTournament(status), user.profileId, entryStatus)
      await expectRefused(user, 'TOURNAMENT_REGISTRATION').catch((e) => { throw new Error(`${status}/${entryStatus}: ${e.message}`) })
    }
  })

  await check('[T3] Организатор без собствено участие -> TOURNAMENT_ORGANIZER (не "сте записан"); организатор И участник -> TOURNAMENT_REGISTRATION; след отмяна на турнира -> приета', async () => {
    const owner = await register('TOwner')
    const ownTournamentId = insertTournament('open', owner.profileId)
    await expectRefused(owner, 'TOURNAMENT_ORGANIZER')
    const ownerAndPlayer = await register('TOwnPlay')
    insertEntry(insertTournament('open', ownerAndPlayer.profileId), ownerAndPlayer.profileId, 'confirmed')
    await expectRefused(ownerAndPlayer, 'TOURNAMENT_REGISTRATION')
    for (const status of ['starting', 'semifinal_in_progress', 'final_in_progress']) {
      const runningOwner = await register(`TOwn${status.slice(0, 4)}`)
      insertTournament(status, runningOwner.profileId)
      await expectRefused(runningOwner, 'TOURNAMENT_ORGANIZER').catch((e) => { throw new Error(`${status}: ${e.message}`) })
    }
    // Отмяна на турнира от организатора (истинският API) -> подаването минава.
    const cancelled = await api(`/api/tournaments/${ownTournamentId}/cancel`, { method: 'POST', cookie: owner.cookie, body: {} })
    assert(cancelled.status === 200, `отмяна: ${cancelled.status} ${JSON.stringify(cancelled.json)}`)
    await expectAccepted(owner)
  })

  await check('[T4] Чакащо потвърждение на партньор: инициаторът (потвърден запис) е блокиран; поканеният без отговор — не (правило 4E)', async () => {
    const inviter = await register('TInviter')
    const invitee = await register('TInvitee')
    const tournamentId = insertTournament('open')
    const teamId = randomUUID()
    db.prepare(`INSERT INTO tournament_teams (team_id, tournament_id, status) VALUES (?, ?, 'forming');`).run(teamId, tournamentId)
    insertEntry(tournamentId, inviter.profileId, 'confirmed', 'partner_inviter', teamId)
    const inviteId = randomUUID()
    db.prepare(`INSERT INTO tournament_partner_invites (invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+1 day'));`)
      .run(inviteId, tournamentId, teamId, inviter.profileId, invitee.profileId)
    await expectRefused(inviter, 'TOURNAMENT_REGISTRATION')
    await expectAccepted(invitee)
    assert(db.prepare('SELECT 1 FROM tournament_partner_invites WHERE invite_id = ?;').get(inviteId) !== undefined, 'поканата е изтрита')
  })

  await check('[T5] Приключил, отменен (всички видове), неуспешен турнир; елиминиран, отписан, възстановена такса -> заявката е приета', async () => {
    const cases: Array<[string, string]> = [
      ['finished', 'champion'], ['finished', 'eliminated'], ['cancelled', 'refunded'], ['admin_cancelled', 'refunded'],
      ['auto_cancelled', 'refunded'], ['failed', 'refunded'], ['semifinal_in_progress', 'eliminated'], ['open', 'withdrawn'], ['open', 'refunded'],
    ]
    for (const [status, entryStatus] of cases) {
      const user = await register(`TA${status.slice(0, 3)}${entryStatus.slice(0, 3)}`)
      insertEntry(insertTournament(status), user.profileId, entryStatus)
      await expectAccepted(user).catch((e) => { throw new Error(`${status}/${entryStatus}: ${e.message}`) })
    }
  })

  // ═══ [B] Частни маси в Белот ═════════════════════════════════════════
  console.log('\n[B] Частни маси в Белот')

  for (const isLocked of [false, true]) {
    const kind = isLocked ? 'заключена' : 'публична'
    await check(`[B1${isLocked ? 'b' : 'a'}] Маса (${kind}): създател и присъединен -> BELOT_PRIVATE_TABLE; масата е непроменена; напускане -> приета`, async () => {
      const host = await register(`BHost${isLocked ? 'L' : 'P'}`)
      const guest = await register(`BGuest${isLocked ? 'L' : 'P'}`)
      const hostSocket = await openSocket(host)
      const created = await sendAndWait(hostSocket, { type: 'create_private_room', stake: STAKE, isLocked, waitMinutes: 15 }, 'private_room_updated', 'create_private_room')
      const roomId = created.room.id as string
      const guestSocket = await openSocket(guest)
      guestSocket.messages.length = 0
      guestSocket.ws.send(JSON.stringify({ type: 'join_private_room', privateRoomId: roomId, team: 'B', slotIndex: 0 }))
      await waitFor(() => guestSocket.messages.some((m) => m.type === 'private_room_updated' || m.type === 'error'), 'join')
      const guestJoined = (await privateRoomOf(guest.profileId))?.id === roomId

      await expectRefused(host, 'BELOT_PRIVATE_TABLE', hostSocket)
      if (guestJoined) await expectRefused(guest, 'BELOT_PRIVATE_TABLE', guestSocket)
      else assert(isLocked, 'гостът не можа да седне на публична маса')
      const roomAfter = await privateRoomOf(host.profileId)
      assert(roomAfter?.id === roomId, 'създателят не е на масата след отказа')

      if (guestJoined) {
        await sendAndWait(guestSocket, { type: 'leave_private_room' }, 'private_room_left', 'guest leave')
        await expectAccepted(guest)
      }
      await sendAndWait(hostSocket, { type: 'leave_private_room' }, 'private_room_left', 'host leave')
      await expectAccepted(host)
      if (isLocked && !guestJoined) console.log('        (заключена маса: гостът без покана не сяда — проверен е само създателят)')
    })
  }

  await check('[B2] Затворен прозорец (WS прекъсната): мястото на масата остава -> BELOT_PRIVATE_TABLE; нова връзка, напускане -> приета', async () => {
    const host = await register('BClosed')
    const first = await openSocket(host)
    const created = await sendAndWait(first, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 }, 'private_room_updated', 'create')
    first.ws.close()
    await first.closed
    await new Promise((r) => setTimeout(r, 300))
    assert((await privateRoomOf(host.profileId))?.id === created.room.id, 'мястото е освободено при затваряне')
    await expectRefused(host, 'BELOT_PRIVATE_TABLE')
    const second = await openSocket(host)
    await sendAndWait(second, { type: 'request_private_rooms_list' }, 'private_rooms_list', 'reconnect list')
    await sendAndWait(second, { type: 'leave_private_room' }, 'private_room_left', 'leave after reconnect')
    await expectAccepted(host)
  })

  // ═══ [L] Частни маси в „Не се сърди човече“ ═══════════════════════════
  console.log('\n[L] Частни маси в „Не се сърди човече“')

  await check('[L1] Създател и присъединен -> LUDO_PRIVATE_TABLE; масата е непроменена; напускане -> приета', async () => {
    const host = await register('LHost')
    const guest = await register('LGuest')
    const hostSocket = await openSocket(host)
    const created = await sendAndWait(hostSocket, { type: 'create_ludo_room', stake: STAKE, playerCount: 4, manualStart: true }, 'ludo_room_updated', 'create_ludo_room')
    const guestSocket = await openSocket(guest)
    await sendAndWait(guestSocket, { type: 'join_ludo_room', ludoRoomId: created.room.id }, 'ludo_room_updated', 'join_ludo_room')
    await expectRefused(host, 'LUDO_PRIVATE_TABLE', hostSocket)
    await expectRefused(guest, 'LUDO_PRIVATE_TABLE', guestSocket)
    const roomAfter = await ludoRoomOf(guest.profileId)
    assert(roomAfter?.id === created.room.id && roomAfter.players.length === 2, `масата е променена: ${JSON.stringify(roomAfter?.players?.length)}`)
    await sendAndWait(guestSocket, { type: 'leave_ludo_room' }, 'ludo_room_left', 'guest leave')
    await expectAccepted(guest)
    await sendAndWait(hostSocket, { type: 'leave_ludo_room' }, 'ludo_room_left', 'host leave')
    await expectAccepted(host)
  })

  await check('[L2] Затворен прозорец: мястото остава -> LUDO_PRIVATE_TABLE', async () => {
    const host = await register('LClosed')
    const first = await openSocket(host)
    const created = await sendAndWait(first, { type: 'create_ludo_room', stake: STAKE, playerCount: 4, manualStart: true }, 'ludo_room_updated', 'create')
    first.ws.close()
    await first.closed
    await new Promise((r) => setTimeout(r, 300))
    assert((await ludoRoomOf(host.profileId))?.id === created.room.id, 'мястото е освободено при затваряне')
    await expectRefused(host, 'LUDO_PRIVATE_TABLE')
  })

  // ═══ [M] Търсене на игра ══════════════════════════════════════════════
  console.log('\n[M] Търсене на игра в Белот')

  await check('[M1] Търсене на игра -> BELOT_MATCHMAKING; спиране -> приета', async () => {
    const user = await register('MSearch')
    const socket = await openSocket(user)
    await sendAndWait(socket, { type: 'join_matchmaking', stake: STAKE }, 'matchmaking_joined', 'join_matchmaking')
    await expectRefused(user, 'BELOT_MATCHMAKING', socket)
    await sendAndWait(socket, { type: 'leave_matchmaking' }, 'matchmaking_left', 'leave_matchmaking')
    await expectAccepted(user)
  })

  // ═══ [A] Активна игра ═════════════════════════════════════════════════
  console.log('\n[A] Активна игра')

  await check('[A1] Активна игра на Белот -> ACTIVE_GAME; прекъсната връзка (възстановимо място) -> ACTIVE_GAME', async () => {
    const user = await register('ABelot')
    const socket = await openSocket(user)
    await sendAndWait(socket, { type: 'create_room', displayName: user.displayName }, 'room_created', 'create_room')
    await expectRefused(user, 'ACTIVE_GAME', socket)
    socket.ws.close()
    await socket.closed
    await new Promise((r) => setTimeout(r, 300))
    await expectRefused(user, 'ACTIVE_GAME')
  })

  await check('[A2] Активен мач в „Не се сърди човече“ -> ACTIVE_GAME за двамата; прекъсната връзка -> ACTIVE_GAME', async () => {
    const host = await register('ALudoH')
    const guest = await register('ALudoG')
    const hostSocket = await openSocket(host)
    const created = await sendAndWait(hostSocket, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: false }, 'ludo_room_updated', 'create')
    const guestSocket = await openSocket(guest)
    guestSocket.ws.send(JSON.stringify({ type: 'join_ludo_room', ludoRoomId: created.room.id }))
    await waitFor(() => hostSocket.messages.some((m) => m.type === 'ludo_game_started'), 'ludo_game_started', 10_000)
    await expectRefused(host, 'ACTIVE_GAME', hostSocket)
    await expectRefused(guest, 'ACTIVE_GAME', guestSocket)
    guestSocket.ws.close()
    await guestSocket.closed
    await new Promise((r) => setTimeout(r, 300))
    await expectRefused(guest, 'ACTIVE_GAME')
  })

  // ═══ [C] Конкурентни операции ═════════════════════════════════════════
  console.log('\n[C] Конкурентни операции')

  await check('[C1] create_private_room и подаване едновременно (5 пъти): никога заявка И място на маса', async () => {
    const outcomes: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const user = await register(`CRoom${i}`)
      const socket = await openSocket(user)
      clearSubmitRateLimit()
      // Различен ред на пристигане: в първите две итерации съобщението по WS
      // тръгва преди HTTP заявката, в останалите — веднага след нея (0/5/20 ms).
      const sendCreate = () => { if (socket.ws.readyState === WebSocket.OPEN) socket.ws.send(JSON.stringify({ type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 })) }
      if (i < 2) sendCreate()
      const submitPromise = api('/api/account/deletion-request', { method: 'POST', cookie: user.cookie, body: { password: PASSWORD, confirm: true } })
      if (i >= 2) { await new Promise((r) => setTimeout(r, [0, 5, 20][i - 2])); sendCreate() }
      const res = await submitPromise
      await new Promise((r) => setTimeout(r, 400))
      const room = await privateRoomOf(user.profileId)
      const hasRequest = requestCount(user.profileId) === 1
      assert(!(hasRequest && room !== null), `итерация ${i}: приета заявка И място на маса`)
      if (res.status === 409) assert(res.json.code === 'BELOT_PRIVATE_TABLE' && room !== null && !hasRequest, `итерация ${i}: ${JSON.stringify(res.json)}`)
      else assert(res.status === 200 && hasRequest && room === null, `итерация ${i}: ${res.status}`)
      outcomes.push(res.status === 200 ? 'заявка' : 'маса')
    }
    console.log(`        (изходи: ${outcomes.join(', ')})`)
  })

  await check('[C2] Записване в турнир и подаване едновременно (5 пъти): никога заявка И потвърдено участие', async () => {
    const outcomes: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const user = await register(`CTour${i}`)
      const tournamentId = insertTournament('open')
      clearSubmitRateLimit()
      const [joined, submitted] = await Promise.all([
        api(`/api/tournaments/${tournamentId}/join`, { method: 'POST', cookie: user.cookie, body: {} }),
        api('/api/account/deletion-request', { method: 'POST', cookie: user.cookie, body: { password: PASSWORD, confirm: true } }),
      ])
      assert(joined.status !== 500 && submitted.status !== 500, `HTTP 500: ${joined.status}/${submitted.status}`)
      const entry = db.prepare(`SELECT COUNT(*) AS c FROM tournament_entries WHERE tournament_id = ? AND profile_id = ? AND status = 'confirmed';`).get(tournamentId, user.profileId) as { c: number }
      const hasRequest = requestCount(user.profileId) === 1
      assert(!(hasRequest && entry.c > 0), `итерация ${i}: приета заявка И участие`)
      assert(hasRequest || entry.c > 0, `итерация ${i}: нито заявка, нито участие (${joined.status}/${submitted.status})`)
      if (submitted.status === 409) assert(submitted.json.code === 'TOURNAMENT_REGISTRATION' && submitted.json.message === MESSAGES.TOURNAMENT_REGISTRATION, JSON.stringify(submitted.json))
      outcomes.push(hasRequest ? 'заявка' : 'турнир')
    }
    console.log(`        (изходи: ${outcomes.join(', ')})`)
  })

  await check('[C3] Заявка, приета от друг процес, при отворена WS връзка: влизане в маса / търсене -> profile_deletion_pending; без място', async () => {
    const user = await register('COther')
    const socket = await openSocket(user)
    const otherProcessStore = await createProfileDeletionRequestStore(bootstrap.databaseFilePath, { rateLimitSecret: SECRET })
    try {
      const created = otherProcessStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
      assert(created.ok, `заявка: ${JSON.stringify(created)}`)
    } finally {
      otherProcessStore.close()
    }
    let guarded = 0
    for (const message of [
      { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 },
      { type: 'create_ludo_room', stake: STAKE, playerCount: 4, manualStart: true },
      { type: 'join_matchmaking', stake: STAKE },
    ]) {
      if (socket.ws.readyState !== WebSocket.OPEN) break // poll-ът вече е затворил връзката — също коректно
      socket.messages.length = 0
      socket.ws.send(JSON.stringify(message))
      await waitFor(() => socket.messages.some((m) => m.type === 'error' || m.type === 'private_room_updated' || m.type === 'ludo_room_updated' || m.type === 'matchmaking_joined') || socket.ws.readyState !== WebSocket.OPEN, message.type)
      const frame = socket.messages.find((m) => m.type !== 'session_deletion_requested')
      if (frame !== undefined) guarded += 1
      if (frame !== undefined) assert(frame.type === 'error' && frame.code === 'profile_deletion_pending', `${message.type}: ${JSON.stringify(frame)}`)
    }
    assert((await privateRoomOf(user.profileId)) === null && (await ludoRoomOf(user.profileId)) === null, 'място на маса')
    console.log(`        (отказани от новата проверка: ${guarded}/3; останалите — след затваряне от poll-а)`)
  })

  // ═══ [S] Логове ═══════════════════════════════════════════════════════
  console.log('\n[S] Логове')

  await check('[S1] Паролата не присъства в изхода на сървъра; отказите не се логват с чувствителни данни', () => {
    const output = server!.output()
    assert(!output.includes(PASSWORD), 'паролата е в лога')
    assert(!output.includes(SECRET), 'тайната е в лога')
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  (неочаквана грешка): ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  if (server) console.error(server.output().slice(-3000))
} finally {
  for (const ws of sockets) { try { ws.close() } catch { /* ignore */ } }
  if (server) await stopServer(server)
  db.close()
  await rm(isolatedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
