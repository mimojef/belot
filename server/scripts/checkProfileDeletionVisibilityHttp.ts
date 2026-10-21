/**
 * checkProfileDeletionVisibilityHttp.ts
 *
 * Самоизтриване на профили — Етап 2, end-to-end през РЕАЛЕН HTTP сървър
 * (src/index.ts), стартиран в ИЗОЛИРАНО копие на server/ с temp база и temp
 * uploads/ (mirror на createIsolatedServerRoot от
 * checkAdminProfileBanAndDeleteHttpAuthorization.ts). Никога реалната база,
 * никога реалните качени файлове.
 *
 * Скриването се задейства с ред в profile_deletion_requests (API за
 * подаване още няма — следващ етап), възстановяването — с отмяна.
 *
 * Проверява директния достъп отвън: профил по ID, търсене, класации,
 * players директория, приятели, лични разговори и прикачени файлове,
 * аватар/галерия по URL, Теми (Лафче), харесване/блокиране, сесия и вход,
 * регистрация (трите съобщения), admin достъп, и пълно възстановяване.
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { cp, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { computeProfileDeletionSchedule } from '../src/db/profileDeletionSchedule.js'
import {
  PROFILE_PENDING_DELETION_LOGIN_MESSAGE,
  REGISTRATION_DISPLAY_NAME_TAKEN_MESSAGE,
  REGISTRATION_EMAIL_AND_DISPLAY_NAME_TAKEN_MESSAGE,
  REGISTRATION_EMAIL_TAKEN_MESSAGE,
} from '../src/db/authStore.js'

const TEST_REGISTRATION_SECRET = 'profile-deletion-visibility-http-secret-0123456789'
const PASSWORD = 'secret123'

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

console.log('\ncheckProfileDeletionVisibilityHttp')
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

async function createIsolatedServerRoot(): Promise<{ root: string; serverDir: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'belot-deletion-visibility-http-'))
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
  return { root, serverDir, cleanup: async () => { await rm(root, { recursive: true, force: true }).catch(() => {}) } }
}

type RunningServer = { child: ChildProcessByStdio<null, Readable, Readable>; output(): string }

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
      BELOT_GAME_WORKER_COUNT: '1',
      PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_REGISTRATION_SECRET,
    },
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
      if (res.ok) return
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timeout: health\n${server.output().slice(-2000)}`)
}

type User = { profileId: string; accountId: string; email: string; displayName: string; cookie: string }

const isolated = await createIsolatedServerRoot()
const port = await getFreePort()
let server: RunningServer | null = null

try {
  // Базата се подготвя предварително (сървърът после само потвърждава
  // миграциите), за да зададем direct registration режим.
  const bootstrap = await ensureServerDatabaseReady({ serverRootOverride: isolated.serverDir })
  const databaseFile = bootstrap.databaseFilePath
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode';`).run()

  server = startServer(isolated.serverDir, port)
  await waitForHealth(port, server)
  const base = `http://127.0.0.1:${port}`

  async function api(path: string, init: { method?: string; cookie?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
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
    return { status: res.status, json }
  }

  let counter = 0
  async function register(label: string): Promise<User> {
    counter += 1
    const email = `http-vis-${label.toLowerCase()}-${counter}@example.test`
    const displayName = `HttpVis${label}${counter}`
    const res = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() }),
    })
    const json = await res.json() as any
    if (res.status !== 200 || !json.ok) throw new Error(`регистрация ${label}: ${res.status} ${JSON.stringify(json)}`)
    const setCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()[0] ?? res.headers.get('set-cookie') ?? ''
    return { profileId: json.session.profile.profileId, accountId: json.session.account.accountId, email, displayName, cookie: setCookie.split(';')[0] }
  }

  const alice = await register('Alice')
  const bob = await register('Bob')
  const hidden = await register('Hidden')
  const admin = await register('Admin')
  db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(admin.accountId)

  // Приятелство + разговор + прикачен файл (директно в temp базата).
  const friendshipId = randomUUID()
  const [lower, higher] = [alice.profileId, hidden.profileId].sort()
  db.prepare(`
    INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, responded_at)
    VALUES (?, ?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP);
  `).run(friendshipId, alice.profileId, hidden.profileId, lower, higher)
  const messageId = randomUUID()
  const chatFilename = `${randomUUID()}.webp`
  db.prepare(`INSERT INTO friend_chat_messages (message_id, friendship_id, sender_profile_id, body) VALUES (?, ?, ?, 'Здравей от скрития');`).run(messageId, friendshipId, hidden.profileId)
  db.prepare(`INSERT INTO friend_chat_attachments (message_id, storage_filename, width, height, byte_size) VALUES (?, ?, 10, 10, 9);`).run(messageId, chatFilename)
  const uploadsRoot = join(isolated.serverDir, 'uploads')
  await mkdir(join(uploadsRoot, 'chat-attachments'), { recursive: true })
  await writeFile(join(uploadsRoot, 'chat-attachments', chatFilename), Buffer.from('fake-webp'))

  // Аватар и галерия — реални файлове под temp uploads/.
  const avatarName = `${randomUUID()}.webp`
  const galleryName = `${randomUUID()}.webp`
  const bobGalleryName = `${randomUUID()}.webp`
  await mkdir(join(uploadsRoot, 'avatars'), { recursive: true })
  await mkdir(join(uploadsRoot, 'profile-gallery', hidden.profileId), { recursive: true })
  await mkdir(join(uploadsRoot, 'profile-gallery', bob.profileId), { recursive: true })
  await writeFile(join(uploadsRoot, 'avatars', avatarName), Buffer.from('avatar'))
  await writeFile(join(uploadsRoot, 'profile-gallery', hidden.profileId, galleryName), Buffer.from('gallery'))
  await writeFile(join(uploadsRoot, 'profile-gallery', bob.profileId, bobGalleryName), Buffer.from('bob-gallery'))
  const avatarUrl = `/uploads/avatars/${avatarName}`
  const galleryUrl = `/uploads/profile-gallery/${hidden.profileId}/${galleryName}`
  const bobGalleryUrl = `/uploads/profile-gallery/${bob.profileId}/${bobGalleryName}`
  db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(avatarUrl, hidden.profileId)

  // Публикация на скрития в Лафче + отговор от Alice под нея.
  const lafcheRootId = randomUUID()
  db.prepare(`
    INSERT INTO topic_messages (message_id, topic_id, sender_profile_id, sender_display_name, sender_role, body)
    VALUES (?, 'topic-lafche', ?, ?, 'player', 'Публикация на скрития');
  `).run(lafcheRootId, hidden.profileId, hidden.displayName)
  db.prepare(`
    INSERT INTO topic_messages (message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body)
    VALUES (?, 'topic-lafche', ?, ?, ?, 'player', 'Отговор от Alice');
  `).run(randomUUID(), lafcheRootId, alice.profileId, alice.displayName)

  const countRows = () => JSON.stringify({
    messages: (db.prepare('SELECT COUNT(*) AS c FROM friend_chat_messages;').get() as { c: number }).c,
    attachments: (db.prepare('SELECT COUNT(*) AS c FROM friend_chat_attachments;').get() as { c: number }).c,
    topics: (db.prepare('SELECT COUNT(*) AS c FROM topic_messages;').get() as { c: number }).c,
    friendships: JSON.stringify(db.prepare('SELECT * FROM profile_friendships ORDER BY friendship_id;').all()),
  })

  async function visibleState(viewer: User) {
    const profile = await api(`/api/profiles/${hidden.profileId}`, { cookie: viewer.cookie })
    const search = await api(`/api/players/search?q=${encodeURIComponent(hidden.displayName)}`, { cookie: viewer.cookie })
    const friends = await api('/api/friends', { cookie: viewer.cookie })
    const conversations = await api('/api/chat/conversations', { cookie: viewer.cookie })
    const messages = await api(`/api/chat/${friendshipId}/messages`, { cookie: viewer.cookie })
    const attachment = await fetch(`${base}/api/chat/${friendshipId}/attachments/${chatFilename}`, { headers: { Cookie: viewer.cookie } })
    const avatar = await fetch(`${base}${avatarUrl}`)
    const gallery = await fetch(`${base}${galleryUrl}`)
    const lafche = await api('/api/topics/topic-lafche/messages', { cookie: viewer.cookie })
    const replies = await api(`/api/topics/topic-lafche/messages/${lafcheRootId}/replies`, { cookie: viewer.cookie })
    return { profile, search, friends, conversations, messages, attachmentStatus: attachment.status, avatarStatus: avatar.status, galleryStatus: gallery.status, lafche, replies }
  }

  const containsId = (value: unknown, id: string) => JSON.stringify(value).includes(id)

  console.log('\n[Pre] Преди скриване (контрол)')
  const before = await visibleState(alice)
  const rowsBefore = countRows()
  await check('[P1] Преди скриване всичко е видимо за Alice', () => {
    assert(before.profile.status === 200, `профил ${before.profile.status}`)
    assert(containsId(before.search.json, hidden.profileId), 'търсене')
    assert(containsId(before.friends.json, hidden.profileId), 'приятели')
    assert(containsId(before.conversations.json, friendshipId), 'разговори')
    assert(before.messages.status === 200, `съобщения ${before.messages.status}`)
    assert(before.attachmentStatus === 200, `прикачен файл ${before.attachmentStatus}`)
    assert(before.avatarStatus === 200 && before.galleryStatus === 200, `аватар ${before.avatarStatus} / галерия ${before.galleryStatus}`)
    assert(containsId(before.lafche.json, lafcheRootId), 'Лафче')
    assert(before.replies.status === 200, `отговори ${before.replies.status}`)
  })

  // ─── Скриване ────────────────────────────────────────────────────────
  const profileRow = db.prepare('SELECT account_id, created_at FROM profiles WHERE profile_id = ?;').get(hidden.profileId) as { account_id: string; created_at: string }
  const now = (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
  const schedule = computeProfileDeletionSchedule(new Date(now))
  const requestId = randomUUID()
  db.prepare(`
    INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for)
    VALUES (?, ?, ?, ?, ?, ?);
  `).run(requestId, hidden.profileId, profileRow.account_id, profileRow.created_at, schedule.requestedAt, schedule.scheduledFor)

  console.log('\n[H] След скриване')
  const after = await visibleState(alice)

  await check('[H1] Профил по ID: 404 за Alice и за гост; 200 за admin (модерация)', async () => {
    assert(after.profile.status === 404, `Alice: ${after.profile.status}`)
    const guest = await api(`/api/profiles/${hidden.profileId}`)
    assert(guest.status === 404, `гост: ${guest.status}`)
    const asAdmin = await api(`/api/profiles/${hidden.profileId}`, { cookie: admin.cookie })
    assert(asAdmin.status === 200 && containsId(asAdmin.json, hidden.profileId), `admin: ${asAdmin.status}`)
  })

  await check('[H2] Търсене, класации и players директория не съдържат скрития профил', async () => {
    assert(!containsId(after.search.json, hidden.profileId), 'търсене')
    const leaderboards = await api('/api/leaderboards', { cookie: alice.cookie })
    assert(leaderboards.status === 200 && !containsId(leaderboards.json, hidden.profileId), 'класации')
    const players = await api('/api/players', { cookie: alice.cookie })
    assert(players.status === 200 && !containsId(players.json, hidden.profileId), 'players')
    assert(containsId(players.json, bob.profileId) || containsId(leaderboards.json, bob.profileId), 'Bob липсва навсякъде')
  })

  await check('[H3] Приятели и разговори: няма следа от скрития; съобщения и прикачен файл са недостъпни', () => {
    assert(after.friends.status === 200 && !containsId(after.friends.json, hidden.profileId), 'приятели')
    assert(after.conversations.status === 200 && !containsId(after.conversations.json, friendshipId), 'разговори')
    assert(after.messages.status >= 400, `съобщения: ${after.messages.status}`)
    assert(after.attachmentStatus === 404 || after.attachmentStatus === 403, `прикачен файл: ${after.attachmentStatus}`)
  })

  // Етап 3: аватарът се сервира (изключенията турнири/частни маси го
  // показват); галерията — не.
  await check('[H4] Галерия по директен URL: 404; аватарът (изключения) и галерията на Bob: 200', async () => {
    assert(after.avatarStatus === 200, `аватар: ${after.avatarStatus}`)
    assert(after.galleryStatus === 404, `галерия: ${after.galleryStatus}`)
    const bobGallery = await fetch(`${base}${bobGalleryUrl}`)
    assert(bobGallery.status === 200, `галерия на Bob: ${bobGallery.status}`)
  })

  await check('[H5] Лафче: публикацията на скрития липсва, отговорите под нея са недостъпни', () => {
    assert(after.lafche.status === 200 && !containsId(after.lafche.json, lafcheRootId), 'Лафче')
    assert(after.replies.status === 404, `отговори: ${after.replies.status}`)
  })

  await check('[H6] Харесване и блокиране на скрит профил: 404', async () => {
    const like = await api(`/api/profiles/${hidden.profileId}/like`, { method: 'POST', cookie: alice.cookie })
    assert(like.status === 404, `харесване: ${like.status}`)
    const block = await api(`/api/profiles/${hidden.profileId}/block`, { method: 'POST', cookie: alice.cookie })
    assert(block.status === 404, `блокиране: ${block.status}`)
  })

  await check('[H7] Стара сесия на скрития: /api/auth/me без сесия, защитен endpoint — 401', async () => {
    const me = await api('/api/auth/me', { cookie: hidden.cookie })
    assert(!containsId(me.json, hidden.profileId), `me: ${JSON.stringify(me.json).slice(0, 200)}`)
    const friends = await api('/api/friends', { cookie: hidden.cookie })
    assert(friends.status === 401, `friends: ${friends.status}`)
  })

  await check('[H8] Вход: вярна парола -> 403 PROFILE_PENDING_DELETION; грешна парола = непознат имейл', async () => {
    const ok = await api('/api/auth/login', { method: 'POST', body: { email: hidden.email, password: PASSWORD } })
    assert(ok.status === 403 && ok.json.code === 'PROFILE_PENDING_DELETION' && ok.json.message === PROFILE_PENDING_DELETION_LOGIN_MESSAGE, `${ok.status} ${JSON.stringify(ok.json)}`)
    const wrong = await api('/api/auth/login', { method: 'POST', body: { email: hidden.email, password: 'wrong-pass' } })
    const unknown = await api('/api/auth/login', { method: 'POST', body: { email: 'nobody-http-vis@example.test', password: 'wrong-pass' } })
    assert(wrong.status === unknown.status && JSON.stringify(wrong.json) === JSON.stringify(unknown.json), 'грешна парола издава състоянието')
  })

  await check('[H9] Регистрация: имейл/име/и двете на скрития — трите съобщения, идентични с активен профил', async () => {
    const reg = (email: string, displayName: string) => api('/api/auth/register', { method: 'POST', body: { email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() } })
    const e1 = await reg(hidden.email, 'HttpFreshNameA')
    const e2 = await reg(bob.email, 'HttpFreshNameB')
    assert(e1.json.message === REGISTRATION_EMAIL_TAKEN_MESSAGE && JSON.stringify(e1) === JSON.stringify(e2), `имейл: ${JSON.stringify(e1)} / ${JSON.stringify(e2)}`)
    const n1 = await reg('http-fresh-c@example.test', hidden.displayName)
    const n2 = await reg('http-fresh-d@example.test', bob.displayName)
    assert(n1.json.message === REGISTRATION_DISPLAY_NAME_TAKEN_MESSAGE && JSON.stringify(n1) === JSON.stringify(n2), `име: ${JSON.stringify(n1)} / ${JSON.stringify(n2)}`)
    const b1 = await reg(hidden.email, hidden.displayName)
    const b2 = await reg(bob.email, bob.displayName)
    assert(b1.json.message === REGISTRATION_EMAIL_AND_DISPLAY_NAME_TAKEN_MESSAGE && JSON.stringify(b1) === JSON.stringify(b2), `и двете: ${JSON.stringify(b1)} / ${JSON.stringify(b2)}`)
  })

  await check('[H10] Данните и файловете са непокътнати (съобщения, прикачени файлове, Теми, приятелства, файлове на диска)', async () => {
    assert(countRows() === rowsBefore, 'редове в базата')
    for (const path of [join(uploadsRoot, 'chat-attachments', chatFilename), join(uploadsRoot, 'avatars', avatarName), join(uploadsRoot, 'profile-gallery', hidden.profileId, galleryName)]) {
      assert((await stat(path)).isFile(), `липсва ${path}`)
    }
  })

  // ─── Отмяна ──────────────────────────────────────────────────────────
  db.prepare(`UPDATE profile_deletion_requests SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE request_id = ?;`).run(requestId)

  console.log('\n[X] След отмяна')
  const restored = await visibleState(alice)
  await check('[X1] Всичко е видимо отново, без загуби', () => {
    assert(restored.profile.status === 200, `профил ${restored.profile.status}`)
    assert(containsId(restored.search.json, hidden.profileId), 'търсене')
    assert(containsId(restored.friends.json, hidden.profileId), 'приятели')
    assert(containsId(restored.conversations.json, friendshipId), 'разговори')
    assert(restored.messages.status === 200 && containsId(restored.messages.json, messageId), 'съобщения')
    assert(restored.attachmentStatus === 200, `прикачен файл ${restored.attachmentStatus}`)
    assert(restored.avatarStatus === 200 && restored.galleryStatus === 200, 'аватар/галерия')
    assert(containsId(restored.lafche.json, lafcheRootId), 'Лафче')
    assert(restored.replies.status === 200, 'отговори')
  })

  await check('[X2] Старата сесия и входът работят отново', async () => {
    const friends = await api('/api/friends', { cookie: hidden.cookie })
    assert(friends.status === 200, `стара сесия: ${friends.status}`)
    const login = await api('/api/auth/login', { method: 'POST', body: { email: hidden.email, password: PASSWORD } })
    assert(login.status === 200 && login.json.ok === true, `вход: ${login.status}`)
  })

  db.close()
} catch (error) {
  failed += 1
  console.error(`  FAIL  Неочаквана грешка: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  if (server !== null) await stopServer(server)
  await isolated.cleanup()
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
