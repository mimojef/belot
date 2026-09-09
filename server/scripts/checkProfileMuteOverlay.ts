/**
 * checkProfileMuteOverlay.ts
 *
 * HTTP integration checks за profile popup mute overlay feature — новите
 * /api/topics/mute-status (GET, без :topicId) и /api/topics/unmute (POST,
 * без :topicId) endpoints (handleProfileMuteStatusRequest/
 * handleProfileUnmuteRequest, index.ts), reusing СЪЩИЯ
 * topicModerationStore.getSectionMuteSnapshot/unmuteProfileInTopics
 * primitive-и като съществуващите /api/topics/:topicId/mute-status и
 * /api/topics/:topicId/unmute endpoints. Real spawn-нат сървър, изолирана
 * SQLite база, реални HTTP заявки — established harness pattern (виж
 * checkAdCampaignsHttpAndRealtime.ts).
 *
 * Цел: profile popup-ът да може надеждно да определи "target профилът има
 * ли активен mute", НЕЗАВИСИМО от съобщения в чата/последните 200 root
 * поста в Лафче — reuse-вайки СЪЩАТА section-wide mute логика, само нов
 * routing surface без изкуствена topicId зависимост.
 *
 * === Permission gate (isTopicModeratorSession: admin/subadmin/pika_team/top_chat_admin) ===
 * [1] GET /api/topics/mute-status: unauthenticated → 403
 * [2] GET /api/topics/mute-status: обикновен player → 403 (обикновен viewer никога не получава mute данни)
 * [3] GET /api/topics/mute-status: chat_admin (изрично изключена роля) → 403
 * [4] GET /api/topics/mute-status: admin → 200, коректен mute snapshot
 * [5] GET /api/topics/mute-status: subadmin → 200 (по-широк от Lafche-only permission)
 * [6] POST /api/topics/unmute: обикновен player → 403
 * [7] POST /api/topics/unmute: admin → 200, успешно premature unmute
 *
 * === Основен сценарий (task spec §1-6) ===
 * [8]  Мютнат target + admin viewer → mute-status връща isMuted:true с reason/mutedUntil
 * [9]  Немютнат target + admin viewer → mute-status връща isMuted:false
 * [10] Early unmute (POST /api/topics/unmute) премахва mute-а — последващ GET показва isMuted:false
 * [11] Data-independence: target профил БЕЗ нито едно съобщение в цялата база
 *      (никога не е писал в Лафче/Теми) → mute-status ВСЕ ПАК коректно връща
 *      isMuted:true (доказва, че lookup-ът не зависи от съобщения/200-те
 *      последни root поста — чист profile_id lookup в topic_section_mutes)
 * [12] Unmute-нат профил не се появява повторно като muted при повторен GET (idempotent state)
 * [13] mute-status резултатът е ИДЕНТИЧЕН независимо кой topicId контекст е бил "текущ" при отваряне
 *      на popup-а — reuse на съществуващия /api/topics/:topicId/mute-status с topic-general
 *      връща СЪЩИЯ isMuted/mutedUntil/reason като новия topicId-less endpoint (section-wide инвариант)
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, cp, mkdir, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

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
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
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
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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

function getFreePort(): Promise<number> {
  return new Promise((res, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Не може да се намери свободен порт.')))
        return
      }
      const { port } = addr
      srv.close(() => res(port))
    })
  })
}

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-profile-mute-overlay-'))
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

async function httpPostJson(port: number, pathname: string, cookie: string | undefined, payload: unknown): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
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
  }, 30_000)
}

const PASSWORD = 'ProfileMuteOverlayCheck1!'

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

function promoteAccount(databaseFile: string, email: string, role: 'admin' | 'subadmin' | 'pika_team' | 'chat_admin' | 'top_chat_admin'): void {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA journal_mode = WAL;')
    database.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?;`).run(role, email)
  } finally {
    database.close()
  }
}

type MuteDto = { isMuted: boolean; mutedUntil: string | null; mutedByAccountId: string | null; reason: string | null }

console.log('\n=== Profile Popup Mute Overlay HTTP (single instance) ===\n')

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: { child: ChildProcessWithoutNullStreams; output(): string } | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitForServerReady(port)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`

  const admin = await registerAndLogin(port, `mute-overlay-admin-${runId}@example.test`, 'MuteOverlayAdmin')
  promoteAccount(iso.dbFile, `mute-overlay-admin-${runId}@example.test`, 'admin')
  // Refresh session role snapshot — established convention (re-login not
  // needed, authStore reads role live per request от accounts table).

  const subadmin = await registerAndLogin(port, `mute-overlay-subadmin-${runId}@example.test`, 'MuteOverlaySubadmin')
  promoteAccount(iso.dbFile, `mute-overlay-subadmin-${runId}@example.test`, 'subadmin')

  const chatAdmin = await registerAndLogin(port, `mute-overlay-chatadmin-${runId}@example.test`, 'MuteOverlayChatAdmin')
  promoteAccount(iso.dbFile, `mute-overlay-chatadmin-${runId}@example.test`, 'chat_admin')

  const player = await registerAndLogin(port, `mute-overlay-player-${runId}@example.test`, 'MuteOverlayPlayer')

  const targetA = await registerAndLogin(port, `mute-overlay-targetA-${runId}@example.test`, 'MuteOverlayTargetA')
  const targetB = await registerAndLogin(port, `mute-overlay-targetB-${runId}@example.test`, 'MuteOverlayTargetB')

  console.log('\n=== Section: Permission gate ===\n')

  await check('[1] GET /api/topics/mute-status: unauthenticated → 403', async () => {
    const r = await httpGetJson(port, `/api/topics/mute-status?profileId=${encodeURIComponent(targetA.profileId)}`)
    assertEqual(r.status, 403, 'очаквано 403')
  })

  await check('[2] GET /api/topics/mute-status: обикновен player → 403', async () => {
    const r = await httpGetJson(port, `/api/topics/mute-status?profileId=${encodeURIComponent(targetA.profileId)}`, player.cookie)
    assertEqual(r.status, 403, 'очаквано 403')
  })

  await check('[3] GET /api/topics/mute-status: chat_admin (изключена роля) → 403', async () => {
    const r = await httpGetJson(port, `/api/topics/mute-status?profileId=${encodeURIComponent(targetA.profileId)}`, chatAdmin.cookie)
    assertEqual(r.status, 403, 'очаквано 403 — chat_admin е извън isTopicModeratorSession')
  })

  await check('[4] GET /api/topics/mute-status: admin → 200', async () => {
    const r = await httpGetJson(port, `/api/topics/mute-status?profileId=${encodeURIComponent(targetA.profileId)}`, admin.cookie)
    assertEqual(r.status, 200, `очаквано 200, получено ${r.status}: ${JSON.stringify(r.body)}`)
    assertEqual((r.body as { ok: boolean }).ok, true, 'ok трябва да е true')
  })

  await check('[5] GET /api/topics/mute-status: subadmin → 200 (по-широк от Lafche-only)', async () => {
    const r = await httpGetJson(port, `/api/topics/mute-status?profileId=${encodeURIComponent(targetA.profileId)}`, subadmin.cookie)
    assertEqual(r.status, 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[6] POST /api/topics/unmute: обикновен player → 403', async () => {
    const r = await httpPostJson(port, '/api/topics/unmute', player.cookie, { profileId: targetA.profileId })
    assertEqual(r.status, 403, 'очаквано 403')
  })

  console.log('\n=== Section: Основен сценарий (mute -> overlay -> early unmute) ===\n')

  await check('[9] Немютнат target + admin viewer → isMuted:false', async () => {
    const r = await httpGetJson(port, `/api/topics/mute-status?profileId=${encodeURIComponent(targetA.profileId)}`, admin.cookie)
    const mute = (r.body as { mute: MuteDto }).mute
    assertEqual(mute.isMuted, false, 'targetA не трябва да е мютнат преди mute действието')
  })

  // Mute-ваме targetA чрез СЪЩЕСТВУВАЩИЯ /api/topics/:topicId/mute endpoint
  // (topic-general — винаги seed-нат системен topicId) — reuse на established
  // mute flow-а, не нова mute логика.
  const muteRes = await httpPostJson(port, '/api/topics/topic-general/mute', admin.cookie, {
    profileId: targetA.profileId,
    reason: 'Overlay test mute reason',
    durationMs: 24 * 60 * 60 * 1000,
    sourceMessageId: null,
    sourceKind: 'unspecified',
    reasonCategory: 'other',
  })
  assert(muteRes.status === 200, `mute setup трябва да успее: ${JSON.stringify(muteRes.body)}`)

  await check('[8] Мютнат target + admin viewer → isMuted:true с reason/mutedUntil', async () => {
    const r = await httpGetJson(port, `/api/topics/mute-status?profileId=${encodeURIComponent(targetA.profileId)}`, admin.cookie)
    assertEqual(r.status, 200, 'очаквано 200')
    const mute = (r.body as { mute: MuteDto }).mute
    assertEqual(mute.isMuted, true, 'targetA трябва да е мютнат')
    assertEqual(mute.reason, 'Overlay test mute reason', 'reason трябва да съвпада')
    assert(mute.mutedUntil !== null, 'mutedUntil трябва да е попълнен')
  })

  await check('[7] POST /api/topics/unmute: admin → 200, успешно premature unmute', async () => {
    const r = await httpPostJson(port, '/api/topics/unmute', admin.cookie, { profileId: targetA.profileId })
    assertEqual(r.status, 200, `очаквано 200, получено ${r.status}: ${JSON.stringify(r.body)}`)
    assertEqual((r.body as { ok: boolean }).ok, true, 'ok трябва да е true')
  })

  await check('[10] След early unmute: GET mute-status показва isMuted:false веднага', async () => {
    const r = await httpGetJson(port, `/api/topics/mute-status?profileId=${encodeURIComponent(targetA.profileId)}`, admin.cookie)
    const mute = (r.body as { mute: MuteDto }).mute
    assertEqual(mute.isMuted, false, 'overlay-ът трябва да изчезне веднага след unmute')
  })

  await check('[12] Повторен GET след unmute остава isMuted:false (idempotent)', async () => {
    const r = await httpGetJson(port, `/api/topics/mute-status?profileId=${encodeURIComponent(targetA.profileId)}`, admin.cookie)
    const mute = (r.body as { mute: MuteDto }).mute
    assertEqual(mute.isMuted, false, 'статусът остава unmuted, без flip-back')
  })

  console.log('\n=== Section: Data-independence (target БЕЗ нито едно съобщение) ===\n')

  await check('[11] targetB никога не е писал съобщение → mute-status ВСЕ ПАК работи коректно (data-independence)', async () => {
    // targetB е регистриран, но НИКОГА не е постнал в Лафче/Теми — потвърждаваме
    // isMuted:false преди mute, после mute-ваме и проверяваме isMuted:true,
    // без targetB да има какъвто и да е ред в topic_messages.
    const before = await httpGetJson(port, `/api/topics/mute-status?profileId=${encodeURIComponent(targetB.profileId)}`, admin.cookie)
    assertEqual((before.body as { mute: MuteDto }).mute.isMuted, false, 'targetB преди mute трябва да е isMuted:false')

    const muteB = await httpPostJson(port, '/api/topics/topic-general/mute', admin.cookie, {
      profileId: targetB.profileId,
      reason: 'Data-independence test',
      durationMs: 60 * 60 * 1000,
      sourceMessageId: null,
      sourceKind: 'unspecified',
      reasonCategory: 'other',
    })
    assert(muteB.status === 200, `mute на targetB трябва да успее: ${JSON.stringify(muteB.body)}`)

    const after = await httpGetJson(port, `/api/topics/mute-status?profileId=${encodeURIComponent(targetB.profileId)}`, admin.cookie)
    assertEqual(after.status, 200, 'очаквано 200')
    const mute = (after.body as { mute: MuteDto }).mute
    assertEqual(mute.isMuted, true, 'targetB (никога не е писал съобщение) трябва да се разпознае като мютнат — lookup е чист profile_id, не message-driven')
    assertEqual(mute.reason, 'Data-independence test', 'reason трябва да съвпада')
  })

  await check('[13] Section-wide инвариант: topicId-less endpoint връща ИДЕНТИЧЕН резултат като /:topicId/mute-status', async () => {
    const viaProfilePopup = await httpGetJson(port, `/api/topics/mute-status?profileId=${encodeURIComponent(targetB.profileId)}`, admin.cookie)
    const viaLegacyTopicScoped = await httpGetJson(port, `/api/topics/topic-general/mute-status?profileId=${encodeURIComponent(targetB.profileId)}`, admin.cookie)
    const a = (viaProfilePopup.body as { mute: MuteDto }).mute
    const b = (viaLegacyTopicScoped.body as { mute: MuteDto }).mute
    assertEqual(a.isMuted, b.isMuted, 'isMuted трябва да съвпада независимо от endpoint-а')
    assertEqual(a.mutedUntil, b.mutedUntil, 'mutedUntil трябва да съвпада')
    assertEqual(a.reason, b.reason, 'reason трябва да съвпада')
  })

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (srv) {
    const out = srv.output()
    const hasUnexpectedError = /\bUnhandledPromiseRejection\b|\bTypeError\b|\bFATAL\b/.test(out)
    if (hasUnexpectedError) {
      console.log('\n--- Server output (contains suspicious error markers) ---')
      console.log(out.slice(-4000))
    }
  }
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

if (failed > 0) {
  process.exitCode = 1
}
