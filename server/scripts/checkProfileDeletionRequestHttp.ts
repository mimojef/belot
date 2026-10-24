/**
 * checkProfileDeletionRequestHttp.ts
 *
 * Самоизтриване на профили — Етап 3, end-to-end през РЕАЛЕН HTTP/WS сървър
 * (src/index.ts) в ИЗОЛИРАНО копие на server/ с temp база и temp uploads/.
 * Никога реалната база.
 *
 * [F] Изключен PROFILE_SELF_DELETION_ENABLED: подаването е недостъпно,
 *     пътят за отмяна остава.
 * [E] Подаване: сесия, CSRF, парола, чужд профил, служебна роля, официален
 *     профил, потвърждение, активен Белот/Не се сърди човече/Свара,
 *     незавършен турнир, успех (сесии, WS, realtime, покани, данни).
 * [R] Вход и отмяна: токен, "остави активна", отмяна, повторна употреба,
 *     възстановяване на видимостта, бан + заявка.
 * [X] Изключения: история на завършен турнир и "Приключили" частни маси
 *     (2 часа) остават видими; профилът не се отваря; темите на скрит
 *     профил са скрити; останалите социални функции го крият.
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPasswordHash } from '../src/db/authHelpers.js'
import { OFFICIAL_PIKA_PROFILE_ID } from '../src/db/normalizeProfileIdentityText.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
import { createProfileDeletionRequestStore } from '../src/db/profileDeletionRequestStore.js'

const SECRET = 'profile-deletion-request-http-secret-0123456789'
const PASSWORD = 'secret123'
const ACTIVE_MESSAGE = 'В момента участвате в активна игра или незавършил турнир. За да подадете заявка за изтриване на профила, първо трябва да приключите участието си.'

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

const originalServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\ncheckProfileDeletionRequestHttp')
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

const isolatedRoot = await mkdtemp(join(tmpdir(), 'belot-deletion-request-http-'))
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

function startServer(port: number, flagEnabled: boolean): RunningServer {
  const chunks: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
    BELOT_GAME_WORKER_COUNT: '1',
    PASSWORD_RESET_RATE_LIMIT_SECRET: SECRET,
  }
  delete env.PROFILE_SELF_DELETION_ENABLED
  if (flagEnabled) env.PROFILE_SELF_DELETION_ENABLED = '1'
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
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timeout: health\n${server.output().slice(-2000)}`)
}

const bootstrap = await ensureServerDatabaseReady({ serverRootOverride: serverDir })
const db = new DatabaseSync(bootstrap.databaseFilePath)
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode';`).run()

// Официалният профил Pika.bg — създаден директно (с роля player), за да се
// провери, че самият профил (не ролята) няма право на самоизтриване.
const officialEmail = 'official-pika@example.test'
const officialAccountId = randomUUID()
db.prepare(`INSERT INTO accounts (account_id, email, password_hash) VALUES (?, ?, ?);`).run(officialAccountId, officialEmail, createPasswordHash(PASSWORD))
db.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, username, normalized_username) VALUES (?, ?, 'OfficialPikaTest', 'officialpikatest', 'officialpikatest', 'officialpikatest');`).run(OFFICIAL_PIKA_PROFILE_ID, officialAccountId)

let server: RunningServer | null = null
let serverB: RunningServer | null = null
const sockets: WebSocket[] = []

try {
  let port = await getFreePort()
  let base = `http://127.0.0.1:${port}`

  async function api(path: string, init: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any; setCookie: string }> {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.cookie ? { Cookie: init.cookie } : {}),
        ...(init.headers ?? {}),
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
    // Съществуващият rate limit за direct регистрация (10/час от IP) е извън
    // обхвата на теста — всички регистрации идват от 127.0.0.1.
    db.prepare(`DELETE FROM registration_rate_limit_events WHERE scope = 'registration-direct-ip';`).run()
    const email = `http-del-${label.toLowerCase()}-${counter}@example.test`
    const displayName = `HttpDel${label}${counter}`
    const res = await api('/api/auth/register', { method: 'POST', body: { email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() } })
    if (res.status !== 200 || !res.json.ok) throw new Error(`регистрация ${label}: ${res.status} ${JSON.stringify(res.json)}`)
    return { profileId: res.json.session.profile.profileId, accountId: res.json.session.account.accountId, email, displayName, cookie: res.setCookie.split(';')[0] }
  }

  async function login(email: string, password = PASSWORD): Promise<{ status: number; json: any; cookie: string }> {
    const res = await api('/api/auth/login', { method: 'POST', body: { email, password } })
    return { status: res.status, json: res.json, cookie: res.setCookie.split(';')[0] }
  }

  type Socket = { ws: WebSocket; messages: any[]; closed: Promise<void> }
  async function openSocket(cookie: string, socketPort: number = port): Promise<Socket> {
    const ws = new WebSocket(`ws://127.0.0.1:${socketPort}/ws`, { headers: { Cookie: cookie } })
    sockets.push(ws)
    const messages: any[] = []
    ws.on('message', (data) => { try { messages.push(JSON.parse(String(data))) } catch { /* ignore */ } })
    const closed = new Promise<void>((r) => ws.once('close', () => r()))
    await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j) })
    await waitFor(() => messages.some((m) => m.type === 'connected'), 'connected')
    return { ws, messages, closed }
  }

  async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`Timeout: ${label}`)
  }

  const submit = (user: User, body: Record<string, unknown> = { password: PASSWORD, confirm: true }, headers: Record<string, string> = {}) =>
    api('/api/account/deletion-request', { method: 'POST', cookie: user.cookie, body, headers })
  const requestCount = (profileId: string) => (db.prepare('SELECT COUNT(*) AS c FROM profile_deletion_requests WHERE profile_id = ?;').get(profileId) as { c: number }).c

  // ═══ [F] Изключен флаг ════════════════════════════════════════════════
  server = startServer(port, false)
  await waitForHealth(port, server)
  console.log('\n[F] Изключен feature flag')
  const flagUser = await register('FlagOff')
  await check('[F1] Подаването е недостъпно (404 PROFILE_SELF_DELETION_DISABLED) и не създава заявка', async () => {
    const res = await submit(flagUser)
    assert(res.status === 404 && res.json.code === 'PROFILE_SELF_DELETION_DISABLED', `${res.status} ${JSON.stringify(res.json)}`)
    assert(requestCount(flagUser.profileId) === 0, 'създадена заявка')
  })
  await check('[F1b] Етап 4I — сесията не предлага "Изтрий" при изключен флаг (profileSelfDeletionAvailable=false)', async () => {
    const me = await api('/api/auth/me', { cookie: flagUser.cookie })
    assert(me.status === 200 && me.json.session?.profileSelfDeletionAvailable === false, JSON.stringify(me.json?.session?.profileSelfDeletionAvailable))
  })
  await check('[F2] Пътят за отмяна остава наличен (невалиден токен -> 400 INVALID_RESTORE_TOKEN, не 404)', async () => {
    const res = await api('/api/account/deletion-request/cancel', { method: 'POST', body: { restoreToken: 'x'.repeat(43) } })
    assert(res.status === 400 && res.json.code === 'INVALID_RESTORE_TOKEN', `${res.status} ${JSON.stringify(res.json)}`)
  })
  await stopServer(server)

  // ═══ Включен флаг ═════════════════════════════════════════════════════
  port = await getFreePort()
  base = `http://127.0.0.1:${port}`
  server = startServer(port, true)
  await waitForHealth(port, server)

  const hidden = await register('Hidden')
  const friend = await register('Friend')
  const staff = await register('Staff')
  const gamer = await register('Gamer')
  const inviter = await register('Inviter')

  // Приятелство + разговор + съобщение в лоби чата + тема на hidden.
  const friendshipId = randomUUID()
  const [lower, higher] = [hidden.profileId, friend.profileId].sort()
  db.prepare(`INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, responded_at) VALUES (?, ?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP);`)
    .run(friendshipId, hidden.profileId, friend.profileId, lower, higher)
  db.prepare(`INSERT INTO friend_chat_messages (message_id, friendship_id, sender_profile_id, body) VALUES (?, ?, ?, 'Здравей');`).run(randomUUID(), friendshipId, hidden.profileId)
  const lobbyMessageId = randomUUID()
  db.prepare(`INSERT INTO lobby_chat_messages (message_id, sender_profile_id, sender_display_name, sender_role, body) VALUES (?, ?, ?, 'player', 'Съобщение в лобито');`)
    .run(lobbyMessageId, hidden.profileId, hidden.displayName)
  const topicId = randomUUID()
  db.prepare(`INSERT INTO topics (topic_id, slug, title, created_by_profile_id, created_by_role) VALUES (?, ?, 'Тема на скрития', ?, 'player');`).run(topicId, `hidden-topic-${topicId.slice(0, 8)}`, hidden.profileId)
  db.prepare(`INSERT INTO vip_status (profile_id, active_until) VALUES (?, ?);`).run(hidden.profileId, new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString())

  // Чакаща покана за турнирен партньор КЪМ hidden (inviter е с потвърден запис).
  const openTournamentId = randomUUID()
  const formingTeamId = randomUUID()
  const inviteId = randomUUID()
  db.prepare(`INSERT INTO tournaments (tournament_id, name, entry_fee, start_mode, status, creator_profile_id) VALUES (?, 'Отворен турнир', 100, 'fill', 'open', ?);`).run(openTournamentId, inviter.profileId)
  db.prepare(`INSERT INTO tournament_teams (team_id, tournament_id, status) VALUES (?, ?, 'forming');`).run(formingTeamId, openTournamentId)
  db.prepare(`INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status) VALUES (?, ?, ?, ?, 'partner_inviter', 'confirmed');`).run(randomUUID(), openTournamentId, inviter.profileId, formingTeamId)
  db.prepare(`INSERT INTO tournament_partner_invites (invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+1 day'));`)
    .run(inviteId, openTournamentId, formingTeamId, inviter.profileId, hidden.profileId)

  const dataFingerprint = () => JSON.stringify({
    wallet: db.prepare('SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?;').get(hidden.profileId),
    vip: db.prepare('SELECT active_until FROM vip_status WHERE profile_id = ?;').get(hidden.profileId),
    progress: db.prepare('SELECT * FROM profile_progress WHERE profile_id = ?;').get(hidden.profileId),
    friendship: db.prepare('SELECT * FROM profile_friendships WHERE friendship_id = ?;').get(friendshipId),
    chat: db.prepare('SELECT COUNT(*) AS c FROM friend_chat_messages WHERE friendship_id = ?;').get(friendshipId),
    lobby: db.prepare('SELECT deleted_at FROM lobby_chat_messages WHERE message_id = ?;').get(lobbyMessageId),
    topic: db.prepare('SELECT status FROM topics WHERE topic_id = ?;').get(topicId),
    profile: db.prepare('SELECT * FROM profiles WHERE profile_id = ?;').get(hidden.profileId),
  })
  const fingerprintBefore = dataFingerprint()

  console.log('\n[E] Подаване')

  await check('[E1] Без сесия -> 401', async () => {
    const res = await api('/api/account/deletion-request', { method: 'POST', body: { password: PASSWORD, confirm: true } })
    assert(res.status === 401, String(res.status))
  })

  await check('[E2] Cross-site заявка (съществуващата CSRF защита) -> 403', async () => {
    const res = await submit(hidden, { password: PASSWORD, confirm: true }, { 'Sec-Fetch-Site': 'cross-site' })
    assert(res.status === 403, String(res.status))
    assert(requestCount(hidden.profileId) === 0, 'заявка')
  })

  await check('[E3] Грешна парола -> 401 INVALID_PASSWORD, без заявка, сесията остава', async () => {
    const res = await submit(hidden, { password: 'wrong-pass', confirm: true })
    assert(res.status === 401 && res.json.code === 'INVALID_PASSWORD', `${res.status} ${JSON.stringify(res.json)}`)
    assert(requestCount(hidden.profileId) === 0, 'заявка')
    assert((await api('/api/friends', { cookie: hidden.cookie })).status === 200, 'сесията е отнета')
  })

  await check('[E4] Подменен profileId (чужд профил) -> 403 FORBIDDEN_PROFILE', async () => {
    const res = await submit(hidden, { password: PASSWORD, confirm: true, profileId: friend.profileId })
    assert(res.status === 403 && res.json.code === 'FORBIDDEN_PROFILE', `${res.status} ${JSON.stringify(res.json)}`)
    assert(requestCount(friend.profileId) === 0 && requestCount(hidden.profileId) === 0, 'заявка')
  })

  await check('[E4b] Етап 4I — при включен флаг сесията на играч предлага "Изтрий" (profileSelfDeletionAvailable=true)', async () => {
    const me = await api('/api/auth/me', { cookie: gamer.cookie })
    assert(me.status === 200 && me.json.session?.profileSelfDeletionAvailable === true, JSON.stringify(me.json?.session?.profileSelfDeletionAvailable))
  })

  await check('[E5] Служебна роля (pika_team) -> 403 ROLE_NOT_ALLOWED; сесията не предлага "Изтрий"', async () => {
    db.prepare(`UPDATE accounts SET role = 'pika_team' WHERE account_id = ?;`).run(staff.accountId)
    const res = await submit(staff)
    assert(res.status === 403 && res.json.code === 'ROLE_NOT_ALLOWED', `${res.status} ${JSON.stringify(res.json)}`)
    const me = await api('/api/auth/me', { cookie: staff.cookie })
    assert(me.json.session?.profileSelfDeletionAvailable === false, `служебна роля: ${JSON.stringify(me.json?.session?.profileSelfDeletionAvailable)}`)
  })

  await check('[E6] Официалният профил Pika.bg -> 403 ROLE_NOT_ALLOWED', async () => {
    const officialLogin = await login(officialEmail)
    assert(officialLogin.status === 200, `вход ${officialLogin.status}`)
    const res = await api('/api/account/deletion-request', { method: 'POST', cookie: officialLogin.cookie, body: { password: PASSWORD, confirm: true } })
    assert(res.status === 403 && res.json.code === 'ROLE_NOT_ALLOWED', `${res.status} ${JSON.stringify(res.json)}`)
    assert(requestCount(OFFICIAL_PIKA_PROFILE_ID) === 0, 'заявка')
    const me = await api('/api/auth/me', { cookie: officialLogin.cookie })
    assert(me.json.session?.profileSelfDeletionAvailable === false, `официален профил: ${JSON.stringify(me.json?.session?.profileSelfDeletionAvailable)}`)
  })

  await check('[E7] Без изрично потвърждение -> 400 CONFIRMATION_REQUIRED', async () => {
    const res = await submit(hidden, { password: PASSWORD })
    assert(res.status === 400 && res.json.code === 'CONFIRMATION_REQUIRED', `${res.status} ${JSON.stringify(res.json)}`)
  })

  async function expectActiveRefusal(label: string): Promise<void> {
    const res = await submit(gamer)
    assert(res.status === 409 && res.json.code === 'ACTIVE_GAME_OR_TOURNAMENT' && res.json.message === ACTIVE_MESSAGE, `${label}: ${res.status} ${JSON.stringify(res.json)}`)
    assert(requestCount(gamer.profileId) === 0, `${label}: създадена заявка`)
    assert((await api('/api/friends', { cookie: gamer.cookie })).status === 200, `${label}: сесията е отнета`)
  }

  await check('[E8] Активен Белот (persisted snapshot) -> 409 с точното съобщение; без заявка, сесията остава', async () => {
    const roomId = randomUUID()
    db.prepare(`INSERT INTO active_room_snapshots (room_id, snapshot_version, room_status, state_version, snapshot_json, is_active) VALUES (?, 1, 'playing', 1, ?, 1);`)
      .run(roomId, JSON.stringify({ status: 'playing', seats: { bottom: { participant: { kind: 'human', identity: { profileId: gamer.profileId }, permanentlyLeftAt: null } } } }))
    await expectActiveRefusal('Белот')
    db.prepare(`UPDATE active_room_snapshots SET is_active = 0 WHERE room_id = ?;`).run(roomId)
  })

  await check('[E9] Активно Не се сърди човече (persisted snapshot) -> 409', async () => {
    const matchId = randomUUID()
    db.prepare(`INSERT INTO active_ludo_match_snapshots (match_id, snapshot_version, ludo_room_id, match_status, revision, snapshot_json, is_active) VALUES (?, 1, ?, 'in_progress', 1, ?, 1);`)
      .run(matchId, randomUUID(), JSON.stringify({ players: [{ profileId: gamer.profileId }, { profileId: randomUUID() }] }))
    await expectActiveRefusal('Не се сърди човече')
    db.prepare(`UPDATE active_ludo_match_snapshots SET is_active = 0 WHERE match_id = ?;`).run(matchId)
  })

  await check('[E10] Активна Свара (постоянен snapshot) -> 409', async () => {
    const matchId = randomUUID()
    const other = randomUUID()
    db.prepare(`INSERT INTO svara_match_snapshots (match_id, format_version, revision, match_status, snapshot_json) VALUES (?, 1, 0, 'in-progress', ?);`)
      .run(matchId, JSON.stringify({ formatVersion: 1, matchId, revision: 0, state: { phase: 'in-progress', seats: [gamer.profileId, other], status: { [gamer.profileId]: 'active', [other]: 'active' } } }))
    await expectActiveRefusal('Свара')
    db.prepare(`UPDATE svara_match_snapshots SET match_status = 'closed' WHERE match_id = ?;`).run(matchId)
  })

  await check('[E11] Незавършило участие в турнир -> 409', async () => {
    const tournamentId = randomUUID()
    db.prepare(`INSERT INTO tournaments (tournament_id, name, entry_fee, start_mode, status, creator_profile_id) VALUES (?, 'Активен турнир', 100, 'fill', 'open', ?);`).run(tournamentId, friend.profileId)
    db.prepare(`INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, joined_as, status) VALUES (?, ?, ?, 'solo', 'confirmed');`).run(randomUUID(), tournamentId, gamer.profileId)
    await expectActiveRefusal('турнир')
  })

  await check('[E11b] Активен бан (Етап 4E6B) -> 409 PROFILE_BANNED при жива сесия; без заявка; сесията остава', async () => {
    const banned = await register('Banned')
    // Директно в базата — механизмът за налагане (който отнема сесиите) не се ползва тук.
    db.prepare(`INSERT INTO profile_bans (ban_id, profile_id, banned_until, reason, banned_by_profile_id) VALUES (?, ?, datetime('now', '+1 day'), 'тест', NULL);`).run(randomUUID(), banned.profileId)
    const res = await submit(banned)
    assert(res.status === 409 && res.json.code === 'PROFILE_BANNED', `${res.status} ${JSON.stringify(res.json)}`)
    assert(requestCount(banned.profileId) === 0, 'създадена заявка')
    assert((await api('/api/friends', { cookie: banned.cookie })).status === 200, 'сесията е отнета')
  })

  // WS връзки преди успешното подаване.
  const hiddenSocket = await openSocket(hidden.cookie)
  const friendSocket = await openSocket(friend.cookie)
  friendSocket.ws.send(JSON.stringify({ type: 'subscribe_lobby_chat' }))
  await waitFor(() => friendSocket.messages.some((m) => m.type === 'lobby_chat_history'), 'lobby history')

  await check('[E12] Преди подаването темата на hidden е видима в директорията', async () => {
    const topics = await api('/api/topics', { cookie: friend.cookie })
    assert(topics.status === 200 && JSON.stringify(topics.json).includes(topicId), 'темата липсва')
  })

  let submitResult: Awaited<ReturnType<typeof submit>> | null = null
  // Етап 4G — клиентът не определя срока: полета за дата в тялото се отказват.
  await check('[E12b] Клиентска дата в тялото (scheduledFor/requestedAt) -> 400, без заявка', async () => {
    const tamper = await register('ClientDate')
    for (const extra of [{ scheduledFor: '2030-01-01T00:00:00.000Z' }, { requestedAt: '2020-01-01T00:00:00.000Z' }, { gracePeriodDays: 1 }]) {
      const res = await submit(tamper, { password: PASSWORD, confirm: true, ...extra })
      assert(res.status === 400, `${JSON.stringify(extra)}: ${res.status} ${JSON.stringify(res.json)}`)
    }
    assert(requestCount(tamper.profileId) === 0, 'създадена заявка')
  })

  await check('[E13] Успешно подаване: 200, срок точно 30 дни (2 592 000 s), отговорът = реда в базата, cookie изчистено, заявка pending', async () => {
    submitResult = await submit(hidden)
    const res = submitResult
    assert(res.status === 200 && res.json.ok === true, `${res.status} ${JSON.stringify(res.json)}`)
    const row = db.prepare(`SELECT * FROM profile_deletion_requests WHERE profile_id = ?;`).get(hidden.profileId) as Record<string, string | number>
    assert(row.status === 'pending', 'status')
    assert(PROFILE_DELETION_GRACE_PERIOD_MS === 2_592_000_000, 'константата е 30 дни')
    assert(Date.parse(String(row.scheduled_for)) - Date.parse(String(row.requested_at)) === PROFILE_DELETION_GRACE_PERIOD_MS, '30 дни')
    assert(Number(row.grace_period_days) === 30 && res.json.gracePeriodDays === 30, `gracePeriodDays: ${res.json.gracePeriodDays}`)
    assert(res.json.scheduledFor === row.scheduled_for, 'scheduledFor в отговора')
    const expectedRemaining = Date.parse(String(row.scheduled_for)) - Date.now()
    assert(Math.abs(res.json.remainingMs - expectedRemaining) < 60_000, `remainingMs ${res.json.remainingMs} vs ${expectedRemaining}`)
    assert(/belot_session=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(res.setCookie), `Set-Cookie: ${res.setCookie}`)
  })

  await check('[E14] Сесиите са отнети: старият cookie -> 401; /api/auth/me без сесия', async () => {
    assert((await api('/api/friends', { cookie: hidden.cookie })).status === 401, 'friends')
    const me = await api('/api/auth/me', { cookie: hidden.cookie })
    assert(!JSON.stringify(me.json).includes(hidden.profileId), 'me')
  })

  await check('[E15] WS на hidden получава session_deletion_requested и се затваря', async () => {
    await waitFor(() => hiddenSocket.messages.some((m) => m.type === 'session_deletion_requested'), 'session_deletion_requested')
    await Promise.race([hiddenSocket.closed, new Promise((_, j) => setTimeout(() => j(new Error('socket не е затворен')), 5000))])
  })

  await check('[E16] Приятелят получава profile_visibility_changed (hidden) и lobby_chat_message_deleted', async () => {
    await waitFor(() => friendSocket.messages.some((m) => m.type === 'profile_visibility_changed' && m.profileId === hidden.profileId && m.hidden === true), 'visibility hidden')
    await waitFor(() => friendSocket.messages.some((m) => m.type === 'lobby_chat_message_deleted' && m.messageId === lobbyMessageId), 'lobby deletion')
  })

  await check('[E17] Приятели, разговори, търсене, профил и тема — скрити за другите; нова WS връзка на hidden е гост', async () => {
    const friends = await api('/api/friends', { cookie: friend.cookie })
    assert(friends.status === 200 && !JSON.stringify(friends.json).includes(hidden.profileId), 'приятели')
    const conversations = await api('/api/chat/conversations', { cookie: friend.cookie })
    assert(!JSON.stringify(conversations.json).includes(friendshipId), 'разговори')
    const search = await api(`/api/players/search?q=${encodeURIComponent(hidden.displayName)}`, { cookie: friend.cookie })
    assert(!JSON.stringify(search.json).includes(hidden.profileId), 'търсене')
    assert((await api(`/api/profiles/${hidden.profileId}`, { cookie: friend.cookie })).status === 404, 'профил')
    const topics = await api('/api/topics', { cookie: friend.cookie })
    assert(!JSON.stringify(topics.json).includes(topicId), 'тема')
    const guestSocket = await openSocket(hidden.cookie)
    assert(!JSON.stringify(guestSocket.messages).includes(hidden.profileId), 'WS с профила')
    guestSocket.ws.close()
  })

  // Етап 4: поканата НЕ се отказва необратимо — остава pending, но не може да
  // бъде приета през периода (общ SQLite guard върху tournament_entries).
  await check('[E18] Чакащата покана за турнирен партньор остава pending и не може да бъде приета; потвърденото участие на поканилия е непокътнато', async () => {
    const invite = db.prepare('SELECT status FROM tournament_partner_invites WHERE invite_id = ?;').get(inviteId) as { status: string }
    assert(invite.status === 'pending', `status=${invite.status}`)
    const entry = db.prepare(`SELECT status FROM tournament_entries WHERE tournament_id = ? AND profile_id = ?;`).get(openTournamentId, inviter.profileId) as { status: string }
    assert(entry.status === 'confirmed', `inviter entry=${entry.status}`)
    let refused = false
    try {
      db.prepare(`INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status) VALUES (?, ?, ?, ?, 'partner_invitee', 'confirmed');`)
        .run(randomUUID(), openTournamentId, hidden.profileId, formingTeamId)
    } catch (error) {
      refused = error instanceof Error && error.message.includes('profile_deletion_pending_tournament_admission')
    }
    assert(refused, 'приемане на поканата през периода не беше отказано')
  })

  // P6: заявката е записана от ДРУГ процес (отделна връзка към базата, без
  // отнемане на сесиите в този процес) — записването в турнир завършва с
  // очакван отказ, никога с HTTP 500 / необработена SQL грешка.
  await check('[E18b] Записване в турнир при активна заявка от друг процес: без HTTP 500; при 403 — точното съобщение; без участие', async () => {
    const racer = await register('P6Race')
    db.prepare(`UPDATE profile_wallets SET yellow_coins_balance = 1000000 WHERE profile_id = ?;`).run(racer.profileId)
    const raceCreator = await register('P6Creator')
    const raceTournamentId = randomUUID()
    db.prepare(`INSERT INTO tournaments (tournament_id, name, entry_fee, start_mode, status, creator_profile_id) VALUES (?, 'P6 турнир', 100, 'fill', 'open', ?);`).run(raceTournamentId, raceCreator.profileId)
    const otherProcessStore = await createProfileDeletionRequestStore(bootstrap.databaseFilePath, { rateLimitSecret: SECRET })
    try {
      const created = otherProcessStore.createRequest({ profileId: racer.profileId, accountId: racer.accountId })
      assert(created.ok, `заявка: ${JSON.stringify(created)}`)
    } finally {
      otherProcessStore.close()
    }
    const res = await api(`/api/tournaments/${raceTournamentId}/join`, { method: 'POST', cookie: racer.cookie, body: {} })
    assert(res.status !== 500, `HTTP 500: ${JSON.stringify(res.json)}`)
    assert([401, 403].includes(res.status), `неочакван статус ${res.status} ${JSON.stringify(res.json)}`)
    if (res.status === 403) {
      assert(res.json.reason === 'profile_deletion_pending', `reason=${res.json.reason}`)
      assert(res.json.message === 'Профилът ви е подаден за изтриване. Не можете да участвате в турнир, докато заявката е активна.', `message=${res.json.message}`)
    }
    const entries = db.prepare('SELECT COUNT(*) AS c FROM tournament_entries WHERE tournament_id = ? AND profile_id = ?;').get(raceTournamentId, racer.profileId) as { c: number }
    assert(entries.c === 0, 'участие')
    console.log(`        (статус при сесия, валидна до проверката: ${res.status})`)
  })

  await check('[E18c] Съобщението и статусът за profile_deletion_pending са в JOIN и PARTNER_INVITE картите (403)', () => {
    const source = readFileSync(join(originalServerRoot, 'src', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
    assert(source.includes("const PROFILE_DELETION_PENDING_TOURNAMENT_MESSAGE =\n  'Профилът ви е подаден за изтриване. Не можете да участвате в турнир, докато заявката е активна.'"), 'текст')
    assert((source.match(/profile_deletion_pending: PROFILE_DELETION_PENDING_TOURNAMENT_MESSAGE,/g) ?? []).length === 2, 'двете карти')
    assert(source.includes("|| reason === 'participation_blocked' || reason === 'profile_deletion_pending'\n  ) return 403"), 'покани: 403')
    assert(source.includes("|| result.reason === 'profile_deletion_pending' ? 403"), 'solo: 403')
  })

  await check('[E19] Данните на профила са непроменени (жълтици, VIP, статистики, приятелство, разговор, лоби, тема, профил)', () => {
    assert(dataFingerprint() === fingerprintBefore, 'данните са променени')
  })

  console.log('\n[R] Вход и отмяна')

  let firstToken = ''
  await check('[R1] Вход с вярна парола -> 403 PROFILE_PENDING_DELETION + токен, срок, без сесия', async () => {
    const res = await login(hidden.email)
    assert(res.status === 403 && res.json.code === 'PROFILE_PENDING_DELETION' && res.json.restoreAvailable === true, `${res.status} ${JSON.stringify(res.json)}`)
    assert(/^[A-Za-z0-9_-]{43}$/.test(res.json.restoreToken), 'токен')
    assert(res.json.remainingMs > PROFILE_DELETION_GRACE_PERIOD_MS - 60_000 && res.json.remainingMs <= PROFILE_DELETION_GRACE_PERIOD_MS, 'оставащ срок (30 дни)')
    const row = db.prepare(`SELECT scheduled_for, grace_period_days FROM profile_deletion_requests WHERE profile_id = ? AND status = 'pending';`).get(hidden.profileId) as { scheduled_for: string; grace_period_days: number }
    assert(res.json.scheduledFor === row.scheduled_for && res.json.gracePeriodDays === row.grace_period_days, `срокът в отговора = базата: ${JSON.stringify({ scheduledFor: res.json.scheduledFor, gracePeriodDays: res.json.gracePeriodDays })}`)
    assert(res.json.isBanned === false, 'isBanned')
    assert(res.json.profileId === undefined, 'вътрешният profileId е изтекъл към клиента')
    assert(!/belot_session=[^;]/.test(res.cookie), 'издадена сесия')
    const stored = db.prepare('SELECT token_hash FROM profile_deletion_restore_tokens WHERE profile_id = ?;').all(hidden.profileId) as Array<{ token_hash: string }>
    assert(stored.some((t) => t.token_hash === createHash('sha256').update(res.json.restoreToken).digest('hex')), 'хешът липсва')
    firstToken = res.json.restoreToken
  })

  await check('[R2] Грешна парола -> отговорът е идентичен с непознат имейл (без разкриване)', async () => {
    const wrong = await login(hidden.email, 'wrong-pass')
    const unknown = await login('nobody-deletion-http@example.test', 'wrong-pass')
    assert(wrong.status === unknown.status && JSON.stringify(wrong.json) === JSON.stringify(unknown.json), `${JSON.stringify(wrong.json)} / ${JSON.stringify(unknown.json)}`)
  })

  await check('[R3] "Остави заявката активна" -> 200; същият токен не може да отмени', async () => {
    const keep = await api('/api/account/deletion-request/keep', { method: 'POST', body: { restoreToken: firstToken } })
    assert(keep.status === 200 && keep.json.ok === true, `${keep.status}`)
    const cancel = await api('/api/account/deletion-request/cancel', { method: 'POST', body: { restoreToken: firstToken } })
    assert(cancel.status === 400 && cancel.json.code === 'INVALID_RESTORE_TOKEN', `${cancel.status} ${JSON.stringify(cancel.json)}`)
    assert(requestCount(hidden.profileId) === 1 && (db.prepare(`SELECT status FROM profile_deletion_requests WHERE profile_id = ?;`).get(hidden.profileId) as { status: string }).status === 'pending', 'заявката не е pending')
  })

  let secondToken = ''
  await check('[R4] Нов вход -> нов токен; отмяна -> 200; приятелят получава profile_visibility_changed (видим)', async () => {
    const res = await login(hidden.email)
    secondToken = res.json.restoreToken
    const cancel = await api('/api/account/deletion-request/cancel', { method: 'POST', body: { restoreToken: secondToken } })
    assert(cancel.status === 200 && cancel.json.ok === true, `${cancel.status} ${JSON.stringify(cancel.json)}`)
    await waitFor(() => friendSocket.messages.some((m) => m.type === 'profile_visibility_changed' && m.profileId === hidden.profileId && m.hidden === false), 'visibility restored')
  })

  await check('[R5] Повторна употреба на токена след отмяна -> 400', async () => {
    const res = await api('/api/account/deletion-request/cancel', { method: 'POST', body: { restoreToken: secondToken } })
    assert(res.status === 400 && res.json.code === 'INVALID_RESTORE_TOKEN', `${res.status}`)
  })

  await check('[R6] След отмяна: старите сесии остават отнети; нормален вход, профил, приятели, разговор и тема са видими; данните — непроменени', async () => {
    assert((await api('/api/friends', { cookie: hidden.cookie })).status === 401, 'старата (отнета) сесия се възстанови')
    const res = await login(hidden.email)
    assert(res.status === 200 && res.json.ok === true, `вход ${res.status}`)
    assert((await api(`/api/profiles/${hidden.profileId}`, { cookie: friend.cookie })).status === 200, 'профил')
    assert(JSON.stringify((await api('/api/friends', { cookie: friend.cookie })).json).includes(hidden.profileId), 'приятели')
    assert(JSON.stringify((await api('/api/chat/conversations', { cookie: friend.cookie })).json).includes(friendshipId), 'разговор')
    assert(JSON.stringify((await api('/api/topics', { cookie: friend.cookie })).json).includes(topicId), 'тема')
    assert(dataFingerprint() === fingerprintBefore, 'данните са променени')
    const invite = db.prepare('SELECT status FROM tournament_partner_invites WHERE invite_id = ?;').get(inviteId) as { status: string }
    assert(invite.status === 'pending', `поканата след отмяна: ${invite.status}`)
  })

  await check('[R7] Бан + заявка: токен с isBanned=true; отмяната не маха бана; следващият вход -> PROFILE_BANNED', async () => {
    const banned = await register('BannedPending')
    assert((await submit(banned)).status === 200, 'подаване')
    db.prepare(`INSERT INTO profile_bans (ban_id, profile_id, banned_until, reason) VALUES (?, ?, datetime('now', '+5 days'), 'тест');`).run(randomUUID(), banned.profileId)
    const pending = await login(banned.email)
    assert(pending.status === 403 && pending.json.code === 'PROFILE_PENDING_DELETION' && pending.json.isBanned === true, JSON.stringify(pending.json))
    const cancel = await api('/api/account/deletion-request/cancel', { method: 'POST', body: { restoreToken: pending.json.restoreToken } })
    assert(cancel.status === 200, `отмяна ${cancel.status}`)
    const after = await login(banned.email)
    assert(after.status === 403 && after.json.code === 'PROFILE_BANNED', `${after.status} ${JSON.stringify(after.json)}`)
  })

  console.log('\n[M] Два сървърни процеса върху една база (PM2 multi-instance)')

  const portB = await getFreePort()
  serverB = startServer(portB, true)
  await waitForHealth(portB, serverB)
  const remoteHidden = await register('RemoteHidden')
  const remoteFriend = await register('RemoteFriend')
  const [rLower, rHigher] = [remoteHidden.profileId, remoteFriend.profileId].sort()
  db.prepare(`INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, responded_at) VALUES (?, ?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP);`)
    .run(randomUUID(), remoteHidden.profileId, remoteFriend.profileId, rLower, rHigher)
  const remoteHiddenSocket = await openSocket(remoteHidden.cookie, portB)
  const remoteFriendSocket = await openSocket(remoteFriend.cookie, portB)

  await check('[M1] Подаване през процес A затваря WS връзката на профила в процес B (poll на журнала)', async () => {
    assert((await submit(remoteHidden)).status === 200, 'подаване през A')
    await waitFor(() => remoteHiddenSocket.messages.some((m) => m.type === 'session_deletion_requested'), 'session_deletion_requested в B')
    await Promise.race([remoteHiddenSocket.closed, new Promise((_, j) => setTimeout(() => j(new Error('socket в B не е затворен')), 5000))])
  })

  await check('[M2] Приятелят, свързан към процес B, получава скриване и (след отмяна през A) възстановяване', async () => {
    await waitFor(() => remoteFriendSocket.messages.some((m) => m.type === 'profile_visibility_changed' && m.profileId === remoteHidden.profileId && m.hidden === true), 'hidden в B')
    const pending = await login(remoteHidden.email)
    const cancel = await api('/api/account/deletion-request/cancel', { method: 'POST', body: { restoreToken: pending.json.restoreToken } })
    assert(cancel.status === 200, `отмяна ${cancel.status}`)
    await waitFor(() => remoteFriendSocket.messages.some((m) => m.type === 'profile_visibility_changed' && m.profileId === remoteHidden.profileId && m.hidden === false), 'restored в B')
  })

  await check('[M3] Процес B отказва HTTP на отнетата сесия веднага (споделена база)', async () => {
    const res = await fetch(`http://127.0.0.1:${portB}/api/friends`, { headers: { Cookie: remoteHidden.cookie } })
    assert(res.status === 401, String(res.status))
  })
  await stopServer(serverB)
  serverB = null

  console.log('\n[X] Исторически изключения')

  const historyUser = await register('History')
  const teammate = await register('Teammate')
  const finishedTournamentId = randomUUID()
  const championTeamId = randomUUID()
  db.prepare(`INSERT INTO tournaments (tournament_id, name, entry_fee, start_mode, status, creator_profile_id, finished_at) VALUES (?, 'Завършен турнир', 100, 'fill', 'finished', ?, CURRENT_TIMESTAMP);`).run(finishedTournamentId, friend.profileId)
  db.prepare(`INSERT INTO tournament_teams (team_id, tournament_id, status) VALUES (?, ?, 'champion');`).run(championTeamId, finishedTournamentId)
  for (const member of [historyUser, teammate]) {
    db.prepare(`INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status) VALUES (?, ?, ?, ?, 'solo', 'champion');`).run(randomUUID(), finishedTournamentId, member.profileId, championTeamId)
  }
  const avatarName = `${randomUUID()}.webp`
  await mkdir(join(serverDir, 'uploads', 'avatars'), { recursive: true })
  await writeFile(join(serverDir, 'uploads', 'avatars', avatarName), Buffer.from('avatar'))
  const avatarUrl = `/uploads/avatars/${avatarName}`
  db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(avatarUrl, historyUser.profileId)
  const occupant = (user: User) => ({ profileId: user.profileId, displayName: user.displayName, avatarUrl: avatarUrl, isBot: false })
  const botOccupant = { profileId: null, displayName: 'Бот', avatarUrl: null, isBot: true }
  const recentMatchId = randomUUID()
  const oldMatchId = randomUUID()
  db.prepare(`INSERT INTO private_room_matches (room_id, private_room_id, status, stake, team_a_json, team_b_json, team_a_score, team_b_score, finished_at) VALUES (?, ?, 'finished', 100, ?, ?, 151, 80, datetime('now', '-30 minutes'));`)
    .run(recentMatchId, randomUUID(), JSON.stringify([occupant(historyUser), botOccupant]), JSON.stringify([botOccupant, botOccupant]))
  db.prepare(`INSERT INTO private_room_matches (room_id, private_room_id, status, stake, team_a_json, team_b_json, team_a_score, team_b_score, finished_at) VALUES (?, ?, 'finished', 100, ?, ?, 151, 80, datetime('now', '-3 hours'));`)
    .run(oldMatchId, randomUUID(), JSON.stringify([occupant(historyUser), botOccupant]), JSON.stringify([botOccupant, botOccupant]))
  const entriesBefore = JSON.stringify(db.prepare('SELECT * FROM tournament_entries WHERE tournament_id = ? ORDER BY entry_id;').all(finishedTournamentId))

  assert((await submit(historyUser)).status === 200, 'подаване на historyUser')

  await check('[X1] Завършеният турнир показва участника, отбора и резултата; турнирните записи са непроменени', async () => {
    const detail = await api(`/api/tournaments/${finishedTournamentId}`, { cookie: friend.cookie })
    const text = JSON.stringify(detail.json)
    assert(detail.status === 200, `статус ${detail.status}`)
    assert(text.includes(historyUser.displayName) && text.includes(historyUser.profileId), 'името/участникът липсва')
    assert(text.includes(championTeamId) && text.includes('champion'), 'отборът/резултатът липсва')
    assert(JSON.stringify(db.prepare('SELECT * FROM tournament_entries WHERE tournament_id = ? ORDER BY entry_id;').all(finishedTournamentId)) === entriesBefore, 'записите са променени')
  })

  await check('[X2] Профилът не се отваря чрез историята (404 за други потребители)', async () => {
    assert((await api(`/api/profiles/${historyUser.profileId}`, { cookie: friend.cookie })).status === 404, 'профилът е видим')
  })

  await check('[X3] "Приключили" частни маси: участието от последните 2 часа се показва (име + аватар); по-старото — не', async () => {
    const socket = await openSocket(friend.cookie)
    socket.ws.send(JSON.stringify({ type: 'request_private_games_list' }))
    await waitFor(() => socket.messages.some((m) => m.type === 'private_games_list'), 'private_games_list')
    const list = [...socket.messages].reverse().find((m) => m.type === 'private_games_list')
    const finishedIds = list.finished.map((g: { roomId: string }) => g.roomId)
    assert(finishedIds.includes(recentMatchId), 'скорошното участие липсва')
    assert(!finishedIds.includes(oldMatchId), 'участието отпреди 3 часа се показва')
    const card = list.finished.find((g: { roomId: string }) => g.roomId === recentMatchId)
    assert(card.teamA[0].displayName === historyUser.displayName && card.teamA[0].avatarUrl === avatarUrl, 'името/аватарът са променени')
    socket.ws.close()
  })

  await check('[X4] Аватарът от историята се сервира (200); профилът и галерията остават недостъпни', async () => {
    assert((await fetch(`${base}${avatarUrl}`)).status === 200, 'аватар')
    assert((await fetch(`${base}/uploads/profile-gallery/${historyUser.profileId}/x.webp`)).status === 404, 'галерия')
  })

  await check('[X5] Историческата видимост не дава достъп: старата сесия е невалидна, нов WS е гост', async () => {
    assert((await api('/api/friends', { cookie: historyUser.cookie })).status === 401, 'сесия')
    const socket = await openSocket(historyUser.cookie)
    assert(!JSON.stringify(socket.messages).includes(historyUser.profileId), 'WS с профила')
    socket.ws.close()
  })

  await check('[X6] Останалите публични/социални функции продължават да го крият (търсене, класации, players)', async () => {
    const search = await api(`/api/players/search?q=${encodeURIComponent(historyUser.displayName)}`, { cookie: friend.cookie })
    assert(!JSON.stringify(search.json).includes(historyUser.profileId), 'търсене')
    assert(!JSON.stringify((await api('/api/leaderboards', { cookie: friend.cookie })).json).includes(historyUser.profileId), 'класации')
    assert(!JSON.stringify((await api('/api/players', { cookie: friend.cookie })).json).includes(historyUser.profileId), 'players')
  })

  await check('[Z] Сървърът е работил без необработени грешки за профилното изтриване', () => {
    assert(!/\[profile-deletion\][^\n]*failed/.test(server!.output()), 'има грешка в лога')
    assert(!server!.output().includes(firstToken) && !server!.output().includes(secondToken), 'токен в лога')
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  Неочаквана грешка: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  for (const ws of sockets) {
    try { ws.terminate() } catch { /* ignore */ }
  }
  if (serverB !== null) await stopServer(serverB)
  if (server !== null) await stopServer(server)
  db.close()
  await rm(isolatedRoot, { recursive: true, force: true }).catch(() => {})
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
