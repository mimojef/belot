/**
 * checkTopicMuteEvidenceAttachmentEndpointAuth.ts
 *
 * HTTP integration checks за GET /api/topics/mute-evidence/attachments/:filename
 * (handleTopicMuteEvidenceAttachmentDownloadRequest, index.ts) — protected
 * moderation-only evidence-copy endpoint от Lafche retention hotfix-а (§8 от
 * hotfix брифа). Real spawn-нат сървър, изолирана SQLite база + изолирана
 * uploads директория, реални HTTP заявки. Established harness pattern (виж
 * checkTopicModerationAuthRealtime.ts).
 *
 * === Auth gate (isTopicModeratorSession: admin/subadmin/pika_team/top_chat_admin) ===
 * [1] Unauthenticated (без сесия) → 403
 * [2] Обикновен player (registered, без роля) → 403
 * [3] chat_admin (грешна/недостатъчна роля — изрично изключена от
 *     isTopicModeratorSession, scoped само до lobby chat) → 403
 * [4] admin → 200, точните байтове на evidence copy файла
 * [5] subadmin → 200
 * [6] pika_team → 200
 * [7] top_chat_admin → 200
 *
 * === Path validation (IMAGE_ATTACHMENT_FILENAME_PATTERN mandatory allowlist) ===
 * [8]  Литерален "../" traversal в URL → WHATWG URL dot-segment normalization
 *      маха route match-а изцяло → generic fallback 404 "Not found" (заявката
 *      никога не стига до handler-а)
 * [9]  Encoded traversal (%2e%2e%2f) като filename segment (валиден segment,
 *      НЕ collapse-нат от URL нормализацията) → decoded съдържа "../" →
 *      отхвърлено от IMAGE_ATTACHMENT_FILENAME_PATTERN → 400 "Невалидно име"
 *      (доказва, че самата pattern валидация е реалната защита, не route-а)
 * [10] Валидно-оформено (UUID.webp), но НИКОГА registered evidence copy
 *      filename → 404 "Файлът не беше намерен" (isRegisteredEvidenceAttachmentCopy
 *      guard-ва enumeration — не всеки .webp в storage-а е servable)
 * [11] Легитимен evidence filename, но с is_evidence_copy=0 (все още сочи
 *      normal shared storage, НЕ protected copy) → 404 през ТОЗИ endpoint —
 *      normal (non-copy) evidence трябва да мине през /api/topics/:id/attachments/,
 *      не през moderation-only copy route-а
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdtemp, rm, cp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'

type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>

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

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'MuteEvidenceEndpointCheck1!'

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

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-mute-evidence-endpoint-http-'))
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
    evidenceUploadsDir: join(serverDir, 'uploads', 'topic-mute-evidence-attachments'),
    cleanup: () => retryRm(tmp),
  }
}

function startSrv(serverDir: string, port: number): { child: SpawnedChild; output(): string } {
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

async function stopSrv(s: { child: SpawnedChild }): Promise<void> {
  if (s.child.exitCode !== null) return
  s.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { s.child.kill('SIGKILL'); r() }, 10_000)
    s.child.once('exit', () => { clearTimeout(t); r() })
  })
}

type HttpResult = { status: number; body: unknown; headers: Headers }

async function httpGetJson(port: number, pathname: string, cookie?: string): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* */ }
  return { status: res.status, body, headers: res.headers }
}

async function httpGetBinary(port: number, pathname: string, cookie?: string): Promise<{ status: number; buffer: Buffer; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  })
  const buffer = Buffer.from(await res.arrayBuffer())
  return { status: res.status, buffer, headers: res.headers }
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

function promoteAccount(databaseFile: string, email: string, role: 'admin' | 'subadmin' | 'pika_team' | 'top_chat_admin' | 'chat_admin'): void {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA journal_mode = WAL;')
    database.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?;`).run(role, email)
  } finally {
    database.close()
  }
}

function insertMuteEvidence(
  databaseFile: string,
  input: { profileId: string; storageFilename: string; isEvidenceCopy: boolean },
): void {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA journal_mode = WAL;')
    const mutedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    database.prepare(`
      INSERT INTO topic_mute_evidence (
        mute_history_id, mute_audit_log_id, profile_id, source_topic_id, source_message_id,
        source_kind, source_body_snapshot, source_attachment_storage_filename,
        source_attachment_width, source_attachment_height, source_attachment_is_evidence_copy,
        muted_by_role, duration_ms, muted_until, status
      ) VALUES (?, ?, ?, 'topic-lafche', NULL, 'lafche_post', '', ?, 10, 10, ?, 'admin', 3600000, ?, 'active');
    `).run(randomUUID(), randomUUID(), input.profileId, input.storageFilename, input.isEvidenceCopy ? 1 : 0, mutedUntil)
  } finally {
    database.close()
  }
}

console.log('\n=== Topic Mute Evidence Attachment Endpoint Auth (single instance) ===\n')

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: { child: SpawnedChild; output(): string } | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitForServerReady(port)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`

  const admin = await registerAndLogin(port, `mev-admin-${runId}@example.test`, 'AdminUser')
  const subadmin = await registerAndLogin(port, `mev-subadmin-${runId}@example.test`, 'SubadminUser')
  const pikaTeam = await registerAndLogin(port, `mev-pikateam-${runId}@example.test`, 'PikaTeamUser')
  const topChatAdmin = await registerAndLogin(port, `mev-topchatadmin-${runId}@example.test`, 'TopChatAdminUser')
  const chatAdmin = await registerAndLogin(port, `mev-chatadmin-${runId}@example.test`, 'ChatAdminUser')
  const normalPlayer = await registerAndLogin(port, `mev-player-${runId}@example.test`, 'NormalPlayer')
  const targetUser = await registerAndLogin(port, `mev-target-${runId}@example.test`, 'TargetUser')

  promoteAccount(iso.dbFile, `mev-admin-${runId}@example.test`, 'admin')
  promoteAccount(iso.dbFile, `mev-subadmin-${runId}@example.test`, 'subadmin')
  promoteAccount(iso.dbFile, `mev-pikateam-${runId}@example.test`, 'pika_team')
  promoteAccount(iso.dbFile, `mev-topchatadmin-${runId}@example.test`, 'top_chat_admin')
  promoteAccount(iso.dbFile, `mev-chatadmin-${runId}@example.test`, 'chat_admin')

  await mkdir(iso.evidenceUploadsDir, { recursive: true })
  const registeredCopyFilename = `${randomUUID()}.webp`
  const registeredCopyBytes = Buffer.from(`fake-webp-evidence-bytes-${randomUUID()}`)
  await writeFile(join(iso.evidenceUploadsDir, registeredCopyFilename), registeredCopyBytes)
  insertMuteEvidence(iso.dbFile, { profileId: targetUser.profileId, storageFilename: registeredCopyFilename, isEvidenceCopy: true })

  const neverWrittenFilename = `${randomUUID()}.webp`
  // Валидно UUID.webp име, НИКОГА не е било реален registered evidence copy
  // (нито redove в topic_mute_evidence го реферират) — arbitrary/foreign filename.

  const nonCopyFilename = `${randomUUID()}.webp`
  insertMuteEvidence(iso.dbFile, { profileId: targetUser.profileId, storageFilename: nonCopyFilename, isEvidenceCopy: false })

  const routePrefix = '/api/topics/mute-evidence/attachments'

  console.log('=== Auth gate ===\n')

  await check('[1] Unauthenticated (без сесия) → 403', async () => {
    const r = await httpGetJson(port, `${routePrefix}/${registeredCopyFilename}`)
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })

  await check('[2] Обикновен player (без роля) → 403', async () => {
    const r = await httpGetJson(port, `${routePrefix}/${registeredCopyFilename}`, normalPlayer.cookie)
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })

  await check('[3] chat_admin (грешна роля — изключена от isTopicModeratorSession) → 403', async () => {
    const r = await httpGetJson(port, `${routePrefix}/${registeredCopyFilename}`, chatAdmin.cookie)
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })

  await check('[4] admin → 200, точните байтове на evidence copy файла', async () => {
    const r = await httpGetBinary(port, `${routePrefix}/${registeredCopyFilename}`, admin.cookie)
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
    assert(r.headers.get('content-type') === 'image/webp', `очаквано image/webp Content-Type, получено ${r.headers.get('content-type')}`)
    assert(r.buffer.equals(registeredCopyBytes), 'върнатите байтове трябва да съвпадат точно с записания evidence copy файл')
  })

  await check('[5] subadmin → 200', async () => {
    const r = await httpGetJson(port, `${routePrefix}/${registeredCopyFilename}`, subadmin.cookie)
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[6] pika_team → 200', async () => {
    const r = await httpGetJson(port, `${routePrefix}/${registeredCopyFilename}`, pikaTeam.cookie)
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[7] top_chat_admin → 200', async () => {
    const r = await httpGetJson(port, `${routePrefix}/${registeredCopyFilename}`, topChatAdmin.cookie)
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  console.log('\n=== Path validation ===\n')

  await check('[8] Литерален "../" traversal → URL нормализация маха route match-а → generic fallback 404 "Not found"', async () => {
    const r = await httpGetJson(port, `${routePrefix}/../../../../etc/passwd`, admin.cookie)
    assert(r.status === 404, `очаквано 404, получено ${r.status}`)
    const body = r.body as { message?: string }
    assert(body.message === 'Not found', `очаквано generic fallback message "Not found", получено ${JSON.stringify(body)}`)
  })

  await check('[9] Encoded traversal (%2e%2e%2f) → decoded съдържа "../" → отхвърлено от IMAGE_ATTACHMENT_FILENAME_PATTERN → 400', async () => {
    const r = await httpGetJson(port, `${routePrefix}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`, admin.cookie)
    assert(r.status === 400, `очаквано 400 (invalid filename pattern), получено ${r.status}`)
  })

  await check('[10] Валидно-оформено UUID.webp, никога registered evidence copy → 404 (enumeration protection)', async () => {
    const r = await httpGetJson(port, `${routePrefix}/${neverWrittenFilename}`, admin.cookie)
    assert(r.status === 404, `очаквано 404, получено ${r.status}`)
  })

  await check('[11] Легитимен evidence filename с is_evidence_copy=0 → 404 през ТОЗИ endpoint (нормалната non-copy evidence минава през /api/topics/:id/attachments/, не тук)', async () => {
    const r = await httpGetJson(port, `${routePrefix}/${nonCopyFilename}`, admin.cookie)
    assert(r.status === 404, `очаквано 404, получено ${r.status}`)
  })

  console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

if (failed > 0) {
  process.exit(1)
}
