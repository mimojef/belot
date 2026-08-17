/**
 * checkLobbyChatPikaAnnouncementCutoff.ts
 *
 * Targeted regression за cutover marker-а на "Публикации от Pika.bg" (виж
 * migration 20260817_001_seed_lobby_chat_pika_announcement_cutoff.sql +
 * adminSettingsStore.getLobbyChatPikaAnnouncementCutoffSeq +
 * lobbyChatStore.listRecentMessages(..., minSeq)).
 *
 * Проблем, който този тест покрива: старият общ Live Chat стана "Публикации
 * от Pika.bg" (permission-narrowing, виж CLAUDE.md/задачата), но старите
 * съобщения (включително от admin/pika_team податели) продължаваха да се
 * показват като история — трябва cutover граница, seed-ната ЕДНАГА при
 * cutover, persist-ната в admin_settings, НЕ преизчислена при всеки restart.
 *
 * [1] Стари съобщения (вкарани в базата ПРЕДИ cutoff миграцията да е
 *     приложена) НЕ се появяват в lobby_chat_history — дори от admin/pika_team
 *     подател (доказва, че cutoff-ът НЕ е role-based филтър).
 * [2] Старите съобщения остават в DB (не са изтрити) — директна SQL проверка.
 * [3] Ново съобщение от admin, изпратено СЛЕД cutover, се появява в история.
 * [4] Ново съобщение от pika_team, изпратено СЛЕД cutover, се появява в история.
 * [5] Restart на сървъра (нова инстанция, СЪЩАТА база) НЕ променя cutoff-а —
 *     старите съобщения остават скрити, новите (от [3]/[4]) остават видими.
 *     Това е основната защита срещу "runtime MAX(seq) baseline, преизчислен
 *     при всеки restart" грешния подход, изрично забранен в заданието.
 * [6] admin_settings пази cutoff стойността точно равна на MAX(seq) от
 *     старите съобщения в момента на seed-a (не 0, не текущия MAX(seq)).
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, cp, mkdir, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import WebSocket, { type RawData } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')

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

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'CutoffCheck1!'

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') { srv.close(() => reject(new Error('No free port'))); return }
      const { port } = addr
      srv.close(() => resolvePort(port))
    })
  })
}

async function waitFor(label: string, pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>((r) => setTimeout(r, 250))
  }
}

// Windows не освобождава веднага WAL/SHM file handle-ите на SQLite точно в
// момента, в който child процесът приключи (stopSrv резолвва при 'exit'
// event-а на процеса, не при OS-ниво release на файловите handles) —
// `new DatabaseSync(...)` веднага след stopSrv() отваря "успешно", но
// ПЪРВАТА реална заявка (.prepare()/.exec()) към нея спорадично удря
// "disk I/O error" (SQLITE_IOERR), докато Windows не освободи locks-ите
// (обикновено <1s). Retry-with-backoff около first real query, не само
// около open() — mirror на retryRm по-горе.
async function openDbWithRetry(dbFile: string): Promise<InstanceType<typeof DatabaseSync>> {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt++) {
    let db: InstanceType<typeof DatabaseSync> | null = null
    try {
      db = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })
      db.prepare('SELECT 1').get()
      return db
    } catch (error) {
      lastError = error
      try { db?.close() } catch { /* ignore close failure on a DB we couldn't query */ }
      await sleep(300)
    }
  }
  throw lastError
}

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-lobby-chat-cutoff-'))
  const serverDir = join(tmp, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(root, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(root, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(root, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(root, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const lt = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(root, 'node_modules'), join(serverDir, 'node_modules'), lt)
  await symlink(join(root, '..', 'node_modules'), join(tmp, 'node_modules'), lt)
  return {
    serverDir,
    dbFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: () => retryRm(tmp),
  }
}

function startSrv(serverDir: string, port: number): { child: ChildProcessWithoutNullStreams; output(): string } {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port), BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function stopSrv(s: { child: ChildProcessWithoutNullStreams }): Promise<void> {
  if (s.child.exitCode !== null) return
  s.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { s.child.kill('SIGKILL'); r() }, 10_000)
    s.child.once('exit', () => { clearTimeout(t); r() })
  })
}

type HttpResult = { status: number; body: unknown }

async function httpGetJson(port: number, pathname: string, cookie?: string): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* */ }
  return { status: res.status, body }
}

async function waitForServerReady(port: number): Promise<void> {
  await waitFor('server ready', async () => {
    try {
      const r = await httpGetJson(port, '/health')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
}

async function registerAndLogin(port: number, email: string, displayName: string): Promise<{ cookie: string; profileId: string }> {
  const regRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName, gender: 'male' }),
  })
  if (regRes.status !== 200) throw new Error(`Register ${email} failed: ${regRes.status}`)

  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const h = loginRes.headers as Headers & { getSetCookie?: () => string[] }
  const cookie = (h.getSetCookie?.()[0] ?? loginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!cookie) throw new Error(`No Set-Cookie on login for ${email}`)

  const meRes = await httpGetJson(port, '/api/auth/me', cookie)
  const profileId = (meRes.body as { session?: { profile?: { profileId?: string } } }).session?.profile?.profileId
  if (!profileId) throw new Error(`No profileId for ${email}`)

  return { cookie, profileId }
}

type AnyMsg = Record<string, unknown> & { type: string }

const wsMessageBuffers = new WeakMap<WebSocket, AnyMsg[]>()

function openWs(port: number, cookie?: string): Promise<WebSocket> {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, cookie ? { headers: { Cookie: cookie } } : undefined)
    const buffer: AnyMsg[] = []
    wsMessageBuffers.set(ws, buffer)
    ws.on('message', (raw: RawData) => {
      try {
        buffer.push(JSON.parse(raw.toString()))
      } catch { /* ignore malformed */ }
    })
    const t = setTimeout(() => { ws.terminate(); reject(new Error('WS open timeout')) }, 5000)
    ws.once('open', () => { clearTimeout(t); resolveWs(ws) })
    ws.once('error', (err) => { clearTimeout(t); reject(err) })
  })
}

function sendWs(ws: WebSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message))
}

async function waitForWsMessage(
  ws: WebSocket,
  predicate: (msg: AnyMsg) => boolean,
  timeoutMs = 5000,
): Promise<AnyMsg> {
  const buffer = wsMessageBuffers.get(ws)
  if (!buffer) throw new Error('WS connection not opened via openWs() — no message buffer registered')

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const idx = buffer.findIndex(predicate)
    if (idx !== -1) {
      const [msg] = buffer.splice(idx, 1)
      return msg!
    }
    if (Date.now() > deadline) {
      throw new Error('Timeout waiting for WS message matching predicate')
    }
    await sleep(25)
  }
}

console.log('\n=== Lobby Chat — "Публикации от Pika.bg" cutover marker ===\n')

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: ReturnType<typeof startSrv> | null = null

try {
  // ── Стъпка 1: стартираме сървъра ЕДНЪЖ само за да приложи миграциите
  //    (включително новата 20260817_001) върху празна база, после спираме.
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port} (bootstrap, за миграции)…`)
  await waitForServerReady(port)

  // Регистрираме реални профили за "старите" податели, ДОКАТО сървърът е
  // жив — lobby_chat_messages.sender_profile_id има FOREIGN KEY REFERENCES
  // profiles(profile_id) (виж 20260728_001_create_lobby_chat_messages.sql),
  // значи не можем директно INSERT с измислен profile_id по-долу.
  const runId = `${Date.now()}-${process.pid}`
  const oldMimo = await registerAndLogin(port, `cutoff-old-mimo-${runId}@example.test`, 'Mimo')
  const oldMimojef = await registerAndLogin(port, `cutoff-old-mimojef-${runId}@example.test`, 'Mimojef')
  const oldAdmin = await registerAndLogin(port, `cutoff-old-admin-${runId}@example.test`, 'OldAdmin')
  const oldPika = await registerAndLogin(port, `cutoff-old-pika-${runId}@example.test`, 'OldPikaTeam')

  await stopSrv(srv)
  srv = null

  // ── Стъпка 2: директно в SQLite вкарваме "стари" съобщения (симулира
  //    исторически Live Chat съобщения от преди cutover-а), включително от
  //    admin/pika_team подател (доказва, че cutoff-ът не е role-based).
  const seedDb = await openDbWithRetry(iso.dbFile)
  const insertOldMessage = seedDb.prepare(`
    INSERT INTO lobby_chat_messages (message_id, sender_profile_id, sender_display_name, sender_is_chat_admin, sender_role, body)
    VALUES (?, ?, ?, 0, ?, ?);
  `)
  insertOldMessage.run(`old-mimo-${runId}`, oldMimo.profileId, 'Mimo', 'player', 'старо съобщение от Mimo (общ Live Chat)')
  insertOldMessage.run(`old-mimojef-${runId}`, oldMimojef.profileId, 'Mimojef', 'player', 'старо съобщение от Mimojef (общ Live Chat)')
  insertOldMessage.run(`old-admin-${runId}`, oldAdmin.profileId, 'OldAdmin', 'admin', 'старо съобщение от admin ПРЕДИ cutover — не трябва да се вижда')
  insertOldMessage.run(`old-pika-${runId}`, oldPika.profileId, 'OldPikaTeam', 'pika_team', 'старо съобщение от pika_team ПРЕДИ cutover — не трябва да се вижда')

  const oldMaxSeqRow = seedDb.prepare(`SELECT COALESCE(MAX(seq), 0) as maxSeq FROM lobby_chat_messages`).get() as { maxSeq: number }
  const oldMaxSeq = oldMaxSeqRow.maxSeq
  assert(oldMaxSeq >= 4, `очаквани поне 4 стари съобщения вкарани, MAX(seq)=${oldMaxSeq}`)

  // Cutoff-ът вече Е seed-нат от bootstrap-а в стъпка 1 (миграцията се
  // прилага ЕДНЪЖ, ПРЕДИ да сме вкарали тези "стари" съобщения) — затова
  // cutoff-ът трябва да е 0 (нямаше ГЪЛОСНО никакви съобщения преди
  // bootstrap-a), а всички 4 seed-нати съобщения по-горе трябва да се
  // третират като "нови" (seq > 0). За да тестваме РЕАЛНИЯ cutover сценарий
  // (стари съобщения СЪЩЕСТВУВАТ преди мигрецията се прилага за пръв път),
  // ръчно нулираме ledger записа на cutoff миграцията и презасяваме — това
  // симулира точно продукционния cutover момент върху база с реална стара
  // история.
  seedDb.prepare(`DELETE FROM admin_settings WHERE setting_key = 'lobby_chat_pika_announcement_cutoff_seq'`).run()
  seedDb.prepare(`DELETE FROM server_migrations WHERE filename = '20260817_001_seed_lobby_chat_pika_announcement_cutoff.sql'`).run()
  seedDb.close()

  // ── Стъпка 3: стартираме сървъра ОТНОВО — сега cutoff миграцията се
  //    прилага за първи път СЪС старите съобщения вече в базата, точно
  //    както production cutover-а. Cutoff трябва да улови oldMaxSeq.
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port} (cutover run)…`)
  await waitForServerReady(port)

  await check('[6] admin_settings пази cutoff = MAX(seq) на старите съобщения в момента на cutover-а (не 0, не текущия MAX(seq))', () => {
    const db = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
    try {
      const row = db.prepare(`SELECT setting_value FROM admin_settings WHERE setting_key = 'lobby_chat_pika_announcement_cutoff_seq'`).get() as { setting_value: string } | undefined
      assert(row !== undefined, 'липсва seed-нат cutoff запис в admin_settings')
      assert(Number(row!.setting_value) === oldMaxSeq, `cutoff трябва да е ${oldMaxSeq}, получен ${row!.setting_value}`)
    } finally {
      db.close()
    }
  })

  const adminUser = await registerAndLogin(port, `cutoff-admin-${runId}@example.test`, 'CutoffAdmin')
  const pikaUser = await registerAndLogin(port, `cutoff-pika-${runId}@example.test`, 'CutoffPika')
  const dbForRoles = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
  dbForRoles.prepare(`UPDATE accounts SET role='admin' WHERE email=?`).run(`cutoff-admin-${runId}@example.test`)
  dbForRoles.prepare(`UPDATE accounts SET role='pika_team' WHERE email=?`).run(`cutoff-pika-${runId}@example.test`)
  dbForRoles.close()

  const wsAdmin = await openWs(port, adminUser.cookie)
  const wsPika = await openWs(port, pikaUser.cookie)

  await check('[1] Стари съобщения (включително от admin/pika_team подател) НЕ се появяват в lobby_chat_history', async () => {
    sendWs(wsAdmin, { type: 'subscribe_lobby_chat' })
    const history = await waitForWsMessage(wsAdmin, (m) => m.type === 'lobby_chat_history')
    const messages = history.messages as Array<{ messageId: string; senderDisplayName: string }>
    assert(messages.length === 0, `историята трябва да е празна веднага след cutover, получени ${messages.length} съобщения: ${JSON.stringify(messages.map((m) => m.senderDisplayName))}`)
  })

  await check('[2] Старите съобщения остават в DB (не са изтрити)', () => {
    const db = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
    try {
      const rows = db.prepare(`SELECT message_id FROM lobby_chat_messages WHERE message_id IN (?, ?, ?, ?)`).all(
        `old-mimo-${runId}`, `old-mimojef-${runId}`, `old-admin-${runId}`, `old-pika-${runId}`,
      ) as Array<{ message_id: string }>
      assert(rows.length === 4, `и четирите стари съобщения трябва да останат в DB, намерени ${rows.length}`)
    } finally {
      db.close()
    }
  })

  let adminMessageId = ''
  await check('[3] Ново съобщение от admin (СЛЕД cutover) се появява в история', async () => {
    sendWs(wsAdmin, { type: 'send_lobby_chat_message', body: `нова-публикация-admin-${runId}`, requestId: 'req-new-admin' })
    const sent = await waitForWsMessage(wsAdmin, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-new-admin')
    adminMessageId = sent.messageId as string

    sendWs(wsAdmin, { type: 'subscribe_lobby_chat' })
    const history = await waitForWsMessage(wsAdmin, (m) => m.type === 'lobby_chat_history')
    const messages = history.messages as Array<{ messageId: string }>
    assert(messages.some((m) => m.messageId === adminMessageId), 'новото admin съобщение трябва да е в историята')
    assert(messages.length === 1, `историята трябва да съдържа точно 1 съобщение (само новото), получени ${messages.length}`)
  })

  let pikaMessageId = ''
  await check('[4] Ново съобщение от pika_team (СЛЕД cutover) се появява в история', async () => {
    sendWs(wsPika, { type: 'subscribe_lobby_chat' })
    await waitForWsMessage(wsPika, (m) => m.type === 'lobby_chat_history')

    sendWs(wsPika, { type: 'send_lobby_chat_message', body: `нова-публикация-pika-${runId}`, requestId: 'req-new-pika' })
    const sent = await waitForWsMessage(wsPika, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-new-pika')
    pikaMessageId = sent.messageId as string

    sendWs(wsAdmin, { type: 'subscribe_lobby_chat' })
    const history = await waitForWsMessage(wsAdmin, (m) => m.type === 'lobby_chat_history')
    const messages = history.messages as Array<{ messageId: string }>
    assert(messages.some((m) => m.messageId === pikaMessageId), 'новото pika_team съобщение трябва да е в историята')
    assert(messages.some((m) => m.messageId === adminMessageId), 'по-старото ново admin съобщение също трябва да остане в историята')
    assert(messages.length === 2, `историята трябва да съдържа точно 2 съобщения (двете нови), получени ${messages.length}`)
  })

  await stopSrv(srv)
  srv = null

  await check('[5] Restart на сървъра (СЪЩАТА база) НЕ променя cutoff-а — старите остават скрити, новите остават видими', async () => {
    srv = startSrv(iso.serverDir, port)
    await waitForServerReady(port)

    const db = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
    try {
      const row = db.prepare(`SELECT setting_value FROM admin_settings WHERE setting_key = 'lobby_chat_pika_announcement_cutoff_seq'`).get() as { setting_value: string }
      assert(Number(row.setting_value) === oldMaxSeq, `cutoff НЕ трябва да се променя при restart, очакван ${oldMaxSeq}, получен ${row.setting_value}`)
    } finally {
      db.close()
    }

    const freshAdminCookie = (await registerAndLogin(port, `cutoff-admin2-${runId}@example.test`, 'CutoffAdmin2')).cookie
    const dbRole = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
    dbRole.prepare(`UPDATE accounts SET role='admin' WHERE email=?`).run(`cutoff-admin2-${runId}@example.test`)
    dbRole.close()

    const wsAfterRestart = await openWs(port, freshAdminCookie)
    sendWs(wsAfterRestart, { type: 'subscribe_lobby_chat' })
    const history = await waitForWsMessage(wsAfterRestart, (m) => m.type === 'lobby_chat_history')
    const messages = history.messages as Array<{ messageId: string }>
    assert(messages.length === 2, `след restart трябва да останат точно 2-те нови публикации, получени ${messages.length}`)
    assert(messages.some((m) => m.messageId === adminMessageId), 'admin публикацията трябва да оцелее restart-а')
    assert(messages.some((m) => m.messageId === pikaMessageId), 'pika_team публикацията трябва да оцелее restart-а')
    wsAfterRestart.terminate()
  })

  wsAdmin.terminate()
  wsPika.terminate()
} catch (err) {
  fail('setup/HTTP error', err)
  if (srv) console.error('\n[server output]\n' + srv.output().slice(-3000))
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
