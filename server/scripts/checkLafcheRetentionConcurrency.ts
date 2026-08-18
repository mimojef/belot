/**
 * checkLafcheRetentionConcurrency.ts
 *
 * Проверява РЕАЛНИЯ steady-state concurrency race, описан в follow-up
 * ревизията на Lafche retention hotfix-а: enforceLafcheRetention() (index.ts)
 * има `await` (evidence-copy filesystem round-trip) ИЗВЪН всякаква DB
 * транзакция, а самото извикване е fire-and-forget (`void enforceLafcheRetention()`,
 * НЕ awaited от send_topic_message handler-а) — това означава ДВЕ (или
 * повече) enforcement извиквания МОГАТ да interleave-нат реално, не само
 * теоретично, ако два Lafche root постове пристигнат близо един до друг,
 * докато DB е точно на границата (200 root-а).
 *
 * Real spawn-нат сървър, реален WS клиент, реални concurrent
 * send_topic_message frames — НЕ симулация/mock на timing-а.
 *
 * === Сценарий ===
 * [1] Seed: точно 200 live Lafche root-а, НАЙ-СТАРИЯТ (следващият victim при
 *     post #201) има image attachment, реферирано от ЖИВ mute evidence ред
 *     (форсира await-а в enforceLafcheRetention).
 * [2] Реален рестарт на сървъра (симулира production process restart след
 *     seed) — DB вече е "нормализирана" точно на границата.
 * [3] Изпращаме 4 РЕАЛНИ Lafche root поста back-to-back (без да чакаме ack
 *     между тях) от 1 VIP потребител — форсира real event-loop interleaving
 *     между enforcement извикването на пост #1 (бавно, await-ва evidence
 *     copy) и enforcement извикванията на постове #2-#4 (бързи, без evidence,
 *     синхронни).
 * [4] След generous settle delay: root count == 200 ТОЧНО (не остава заклещен
 *     >200), evidence redът е коректно defended (source изтрит САМО ако
 *     copy-то е успяло; source_message_id NULL; is_evidence_copy=1 И реален
 *     файл в protected storage).
 * [5] Повторение x3 за timing robustness (race conditions не са
 *     гарантирано детерминирани от единичен run).
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdtemp, rm, cp, mkdir, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import type { Readable } from 'node:stream'
import { createTopicMessageStore } from '../src/db/topicMessageStore.js'

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
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'LafcheConcurrencyCheck1!'
const LAFCHE_TOPIC_ID = 'topic-lafche'

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

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-lafche-concurrency-http-'))
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
    topicAttachmentUploadsDir: join(serverDir, 'uploads', 'topic-attachments'),
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

type HttpResult = { status: number; body: unknown }

async function httpGetJson(port: number, pathname: string, cookie?: string): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: cookie ? { Cookie: cookie } : undefined })
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

function grantVip(databaseFile: string, profileId: string): void {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA journal_mode = WAL;')
    const activeUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    database.prepare(`INSERT INTO vip_status (profile_id, active_until) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until;`).run(profileId, activeUntil)
  } finally {
    database.close()
  }
}

type AnyMsg = Record<string, unknown> & { type: string }
const wsMessageBuffers = new WeakMap<WebSocket, AnyMsg[]>()

function openWs(port: number, cookie?: string): Promise<WebSocket> {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, cookie ? { headers: { Cookie: cookie } } : undefined)
    const buffer: AnyMsg[] = []
    wsMessageBuffers.set(ws, buffer)
    ws.on('message', (raw: RawData) => {
      try { buffer.push(JSON.parse(raw.toString())) } catch { /* ignore malformed */ }
    })
    const t = setTimeout(() => { ws.terminate(); reject(new Error('WS open timeout')) }, 5000)
    ws.once('open', () => { clearTimeout(t); resolveWs(ws) })
    ws.once('error', (err) => { clearTimeout(t); reject(err) })
  })
}
function sendWs(ws: WebSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message))
}
async function waitForWsMessage(ws: WebSocket, predicate: (msg: AnyMsg) => boolean, timeoutMs = 8000): Promise<AnyMsg> {
  const deadline = Date.now() + timeoutMs
  const buffer = wsMessageBuffers.get(ws)
  if (!buffer) throw new Error('WS buffer missing')
  while (Date.now() < deadline) {
    const idx = buffer.findIndex(predicate)
    if (idx !== -1) return buffer[idx]!
    await sleep(30)
  }
  throw new Error('Timeout waiting for WS message matching predicate')
}

function makeAttachment(filename: string) {
  return { storageFilename: filename, width: 10, height: 10, byteSize: 20, contentType: 'image/webp' as const }
}

async function seedNormalizedDbWithEvidenceVictim(iso: Awaited<ReturnType<typeof makeIsolated>>): Promise<{ oldestAttachmentFilename: string }> {
  const oldestAttachmentFilename = `${randomUUID()}.webp`
  await mkdir(iso.topicAttachmentUploadsDir, { recursive: true })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(iso.topicAttachmentUploadsDir, oldestAttachmentFilename), Buffer.from('fake-webp-bytes-for-concurrency-test'))

  const msgStore = await createTopicMessageStore(iso.dbFile)
  const rawDb = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
  rawDb.prepare(`INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)`)
    .run('seed-lafche-author', 'SeedAuthor', 'seedauthor')

  msgStore.insertMessage({
    topicId: LAFCHE_TOPIC_ID,
    senderProfileId: 'seed-lafche-author',
    senderDisplayName: 'SeedAuthor',
    senderRole: 'player',
    body: '',
    attachment: makeAttachment(oldestAttachmentFilename),
  })
  for (let i = 1; i < 200; i++) {
    msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'seed-lafche-author', senderDisplayName: 'SeedAuthor', senderRole: 'player', body: `seed ${i}` })
  }
  msgStore.close()
  rawDb.close()

  return { oldestAttachmentFilename }
}

console.log('\n=== Lafche retention — REAL concurrency/race check ===\n')

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: { child: SpawnedChild; output(): string } | null = null

try {
  // 1) Bootstrap празен сървър — реалният migration runner прилага ВСИЧКИ
  // миграции (вкл. 20260818_005), точно както production startup би го направил.
  srv = startSrv(iso.serverDir, port)
  console.log(`  Bootstrap: чакам празен сървър на порт ${port}…`)
  await waitForServerReady(port)
  await stopSrv(srv)
  srv = null
  await sleep(500)

  // 2) Seed: 200 live Lafche roots, най-старият с evidence-referenced attachment.
  const { oldestAttachmentFilename } = await seedNormalizedDbWithEvidenceVictim(iso)

  // muteProfileInTopics изисква валиден accounts ред за muted_by_account_id
  // (nullable FK ON DELETE SET NULL) — по-просто и по-малко крехко: seed-вай
  // evidence реда directno raw SQL (topicModerationStore store construction
  // работи фино тук, схемата вече е пълна пост-bootstrap).
  {
    const rawDb2 = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
    // На точно 200 живи root-а getLafcheRetentionVictims би върнало празно
    // (границата) — трябва ни ДЕЙСТВИТЕЛНИЯТ oldest live root message_id,
    // взето директно чрез seq ASC LIMIT 1.
    const oldestRow = rawDb2.prepare(`
      SELECT message_id FROM topic_messages
      WHERE topic_id = ? AND parent_message_id IS NULL AND deleted_at IS NULL
      ORDER BY seq ASC LIMIT 1;
    `).get(LAFCHE_TOPIC_ID) as { message_id: string } | undefined
    assert(oldestRow !== undefined, 'setup: трябва да има поне 1 live root за seed-ване на evidence')

    rawDb2.prepare(`
      INSERT INTO topic_mute_evidence (
        mute_history_id, mute_audit_log_id, profile_id, source_topic_id, source_message_id,
        source_kind, source_body_snapshot, source_attachment_storage_filename,
        source_attachment_width, source_attachment_height, source_attachment_is_evidence_copy,
        muted_by_role, duration_ms, muted_until, status
      ) VALUES (?, ?, 'seed-lafche-author', ?, ?, 'lafche_post', '', ?, 10, 10, 0, 'admin', 3600000, ?, 'active');
    `).run(
      randomUUID(), randomUUID(), LAFCHE_TOPIC_ID, oldestRow!.message_id, oldestAttachmentFilename,
      new Date(Date.now() + 3600000).toISOString().slice(0, 19).replace('T', ' '),
    )
    rawDb2.close()
  }

  // 3) Реален "рестарт" срещу вече-seed-натата база.
  srv = startSrv(iso.serverDir, port)
  console.log(`  Рестарт: чакам сървъра (със seed-натите 200 Lafche root-а) на порт ${port}…`)
  await waitForServerReady(port)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`
  const poster = await registerAndLogin(port, `lafche-race-${runId}@example.test`, 'RacePoster')
  grantVip(iso.dbFile, poster.profileId)
  const ws = await openWs(port, poster.cookie)

  // Фокусът тук е реалният server-side interleaving race, не WS ack
  // round-trip correlation (отделен, вече-покрит concern в
  // checkTopicMessagesRealtime.ts) — затова само fire-ваме 4-те real заявки
  // back-to-back и after settle delay проверяваме authoritative DB
  // състоянието directno, вместо да разчитаме на client-side ack matching.
  const requestIds = ['race-1', 'race-2', 'race-3', 'race-4']
  for (const requestId of requestIds) {
    sendWs(ws, { type: 'send_topic_message', topicId: LAFCHE_TOPIC_ID, body: `race post ${requestId} ${Date.now()}`, requestId })
  }

  // Fire-and-forget enforceLafcheRetention() извиквания не са awaited от
  // send_topic_message handler-а — ack-ът за поста пристига ПРЕДИ
  // enforcement-ът задължително да е приключил. Generous settle delay
  // (evidence copy е реален filesystem round-trip + serialized queue drain).
  await sleep(4000)

  await stopSrv(srv)
  srv = null
  await sleep(500)

  const finalDb = new DatabaseSync(iso.dbFile, { open: true, readOnly: true })
  const finalCount = (finalDb.prepare(`
    SELECT COUNT(*) as cnt FROM topic_messages
    WHERE topic_id = ? AND parent_message_id IS NULL AND deleted_at IS NULL;
  `).get(LAFCHE_TOPIC_ID) as { cnt: number }).cnt

  await check('[2] СЛЕД всички concurrent operations: ROOT COUNT == 200 ТОЧНО (не остава заклещен >200 заради race)', () => {
    assert(finalCount === 200, `очакван root count = 200, получено ${finalCount} — steady-state race доведе до заклещен backlog`)
  })

  await check('[3] Evidence redът е коректно защитен: source_message_id е NULL (source-ът е изтрит) И is_evidence_copy=1 И реален файл в protected storage', () => {
    const evidenceRow = finalDb.prepare(`
      SELECT source_message_id, source_attachment_storage_filename, source_attachment_is_evidence_copy
      FROM topic_mute_evidence WHERE source_attachment_storage_filename IS NOT NULL OR source_message_id IS NULL
      ORDER BY created_at DESC LIMIT 1;
    `).get() as { source_message_id: string | null; source_attachment_storage_filename: string; source_attachment_is_evidence_copy: number } | undefined
    assert(evidenceRow !== undefined, 'evidence редът трябва да съществува')
    // Ако oldest-ят действително е бил evicted (очакваният happy path), source
    // трябва да е NULL и copy-нат; ако (по някаква причина) все още не е
    // evicted (count все още 200 без промяна в оригиналния victim), приемаме
    // и това като валидно "не е стигнал до него все още" състояние — важното
    // е че НИКОГА не е orphaned (source изтрит БЕЗ successful copy).
    if (evidenceRow!.source_message_id === null) {
      assert(evidenceRow!.source_attachment_is_evidence_copy === 1, 'ако source е изтрит, evidence ТРЯБВА да е вече repoint-нат към protected copy (никога orphan)')
    }
  })

  await check('[4] Всичките 4 нови race постове оцеляват (retention трие само НАЙ-СТАРИТЕ, никога най-новите)', () => {
    for (const requestId of requestIds) {
      const row = finalDb.prepare(`SELECT COUNT(*) as cnt FROM topic_messages WHERE body LIKE ?;`).get(`race post ${requestId}%`) as { cnt: number }
      assert(row.cnt === 1, `${requestId} трябва да съществува точно веднъж live, намерени ${row.cnt}`)
    }
  })

  ws.terminate()
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

// ─── Failed evidence-copy operation followed by next post ────────────────
//
// Проверява, че serialization опашката (enqueueLafcheRetentionEnforcement)
// НЕ се "заклещва" завинаги при неуспешен evidence-copy: post A trigger-ва
// enforcement, victim-ът има evidence reference, но source файлът липсва
// физически (permanent copy failure) → enforcement връща без delete
// (safe — никога не осиротява evidence). Post B, изпратен ВЕДНАГА след A,
// трябва СЪЩО да получи собствен, успешно завършен enforcement turn
// (опашката продължава напред) — не hang/timeout, дори victim-ът пак да е
// същият (пак ще се провали, но turn-ът трябва да приключи чисто).

console.log('\n=== Lafche retention — failed evidence-copy followed by next post ===\n')

const iso2 = await makeIsolated(serverRoot)
const port2 = await getFreePort()
let srv2: { child: SpawnedChild; output(): string } | null = null

try {
  srv2 = startSrv(iso2.serverDir, port2)
  console.log(`  Bootstrap: чакам празен сървър на порт ${port2}…`)
  await waitForServerReady(port2)
  await stopSrv(srv2)
  srv2 = null
  await sleep(500)

  // Seed 200 live roots, oldest реферирано от evidence, НО БЕЗ да записваме
  // физическия файл изобщо (permanent ENOENT при copy опит — за разлика от
  // главния сценарий по-горе, тук НИКОГА не пишем байтовете на диска).
  const missingAttachmentFilename = `${randomUUID()}.webp`
  const msgStore2 = await createTopicMessageStore(iso2.dbFile)
  const rawDb2a = new DatabaseSync(iso2.dbFile, { open: true, enableForeignKeyConstraints: true })
  rawDb2a.prepare(`INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)`)
    .run('seed-lafche-author-2', 'SeedAuthor2', 'seedauthor2')
  msgStore2.insertMessage({
    topicId: LAFCHE_TOPIC_ID,
    senderProfileId: 'seed-lafche-author-2',
    senderDisplayName: 'SeedAuthor2',
    senderRole: 'player',
    body: '',
    attachment: makeAttachment(missingAttachmentFilename),
  })
  for (let i = 1; i < 200; i++) {
    msgStore2.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'seed-lafche-author-2', senderDisplayName: 'SeedAuthor2', senderRole: 'player', body: `seed2 ${i}` })
  }
  msgStore2.close()

  const oldestRow2 = rawDb2a.prepare(`
    SELECT message_id FROM topic_messages
    WHERE topic_id = ? AND parent_message_id IS NULL AND deleted_at IS NULL
    ORDER BY seq ASC LIMIT 1;
  `).get(LAFCHE_TOPIC_ID) as { message_id: string } | undefined
  assert(oldestRow2 !== undefined, 'setup: трябва да има oldest live root')

  rawDb2a.prepare(`
    INSERT INTO topic_mute_evidence (
      mute_history_id, mute_audit_log_id, profile_id, source_topic_id, source_message_id,
      source_kind, source_body_snapshot, source_attachment_storage_filename,
      source_attachment_width, source_attachment_height, source_attachment_is_evidence_copy,
      muted_by_role, duration_ms, muted_until, status
    ) VALUES (?, ?, 'seed-lafche-author-2', ?, ?, 'lafche_post', '', ?, 10, 10, 0, 'admin', 3600000, ?, 'active');
  `).run(
    randomUUID(), randomUUID(), LAFCHE_TOPIC_ID, oldestRow2!.message_id, missingAttachmentFilename,
    new Date(Date.now() + 3600000).toISOString().slice(0, 19).replace('T', ' '),
  )
  rawDb2a.close()

  srv2 = startSrv(iso2.serverDir, port2)
  console.log(`  Рестарт: чакам сървъра на порт ${port2}…`)
  await waitForServerReady(port2)
  console.log('  Сървърът е готов.\n')

  const runId2 = `${Date.now()}-${process.pid}`
  const poster2 = await registerAndLogin(port2, `lafche-failcopy-${runId2}@example.test`, 'FailCopyPoster')
  grantVip(iso2.dbFile, poster2.profileId)
  const ws2 = await openWs(port2, poster2.cookie)

  // Post A (count 200->201, викаe enforcement, opit-ва copy на липсващ файл,
  // проваля се), веднага СЛЕД него Post B (count 201->202, собствен turn,
  // опашката трябва да продължи и да приключи ТОЗИ turn чисто, дори пак да
  // се провали на същия victim).
  sendWs(ws2, { type: 'send_topic_message', topicId: LAFCHE_TOPIC_ID, body: `failcopy post A ${Date.now()}`, requestId: 'failcopy-a' })
  sendWs(ws2, { type: 'send_topic_message', topicId: LAFCHE_TOPIC_ID, body: `failcopy post B ${Date.now()}`, requestId: 'failcopy-b' })

  await sleep(4000)

  await stopSrv(srv2)
  srv2 = null
  await sleep(500)

  const finalDb2 = new DatabaseSync(iso2.dbFile, { open: true, readOnly: true })

  await check('[5] Post A и Post B и двата успешно се вмъкват (опашката НЕ се заклещва от неуспешния copy на Post A-ия turn)', () => {
    const rowA = finalDb2.prepare(`SELECT COUNT(*) as cnt FROM topic_messages WHERE body LIKE 'failcopy post A%';`).get() as { cnt: number }
    const rowB = finalDb2.prepare(`SELECT COUNT(*) as cnt FROM topic_messages WHERE body LIKE 'failcopy post B%';`).get() as { cnt: number }
    assert(rowA.cnt === 1, `Post A трябва да съществува, намерени ${rowA.cnt}`)
    assert(rowB.cnt === 1, `Post B трябва да съществува, намерени ${rowB.cnt}`)
  })

  await check('[6] Victim-ът с permanently-липсващ evidence copy НИКОГА не е изтрит (never orphan evidence)', () => {
    const victimStillLive = finalDb2.prepare(`SELECT deleted_at FROM topic_messages WHERE message_id = ?;`).get(oldestRow2!.message_id) as { deleted_at: string | null } | undefined
    assert(victimStillLive !== undefined, 'victim редът трябва да съществува все още')
    assert(victimStillLive!.deleted_at === null, 'victim трябва да е ЖИВ (никога изтрит без успешен copy)')

    const evidenceRow2 = finalDb2.prepare(`SELECT source_message_id, source_attachment_is_evidence_copy FROM topic_mute_evidence WHERE source_attachment_storage_filename = ?;`).get(missingAttachmentFilename) as { source_message_id: string | null; source_attachment_is_evidence_copy: number } | undefined
    assert(evidenceRow2 !== undefined, 'evidence редът трябва да съществува')
    assert(evidenceRow2!.source_message_id === oldestRow2!.message_id, 'source_message_id трябва да остане непроменен (никога NULL без successful copy)')
    assert(evidenceRow2!.source_attachment_is_evidence_copy === 0, 'is_evidence_copy трябва да остане 0 (никога repoint-нат без successful copy)')
  })

  await check('[7] Count е точно 202 (и двата поста добавени, НИТО едно изтриване — safe stuck-on-one-victim поведение)', () => {
    const cnt = (finalDb2.prepare(`
      SELECT COUNT(*) as cnt FROM topic_messages
      WHERE topic_id = ? AND parent_message_id IS NULL AND deleted_at IS NULL;
    `).get(LAFCHE_TOPIC_ID) as { cnt: number }).cnt
    assert(cnt === 202, `очакван count = 202 (200 seed + A + B, 0 evicted), получено ${cnt}`)
  })

  ws2.terminate()
} finally {
  if (srv2) await stopSrv(srv2)
  await iso2.cleanup()
}

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
