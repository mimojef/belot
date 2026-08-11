/**
 * checkTopicCreation.ts
 *
 * Custom Topic Creation — зеленото "+" в Topics bar-а вече създава реални
 * теми (WS create_topic), реализирано следвайки established Topics write
 * protocol (VIP guard, structural/semantic parse разделение, rate limit,
 * duplicate/concurrency защита, directory-wide realtime broadcast).
 *
 * Same established harness pattern като checkTopicsStore.ts (unit секции
 * директно срещу store/validator) + checkTopicMessagesRealtime.ts (real
 * spawn-нат сървър + реални WS connections за auth/realtime/concurrency).
 *
 * === Section V: topicTitleValidation (unit) ===
 * [V1]  Празен string -> empty_title
 * [V2]  Whitespace-only -> empty_title (trim се прилага първо)
 * [V3]  Валиден кирилски текст -> ok, trimmed
 * [V4]  Валиден латински текст -> ok
 * [V5]  Смесен текст с нормална пунктуация -> ok
 * [V6]  Точно 80 code points -> ok (граница, не отхвърлена)
 * [V7]  81 code points -> title_too_long
 * [V8]  Control character () -> invalid_title
 * [V9]  Leading/trailing whitespace се trim-ва в резултата
 *
 * === Section S: topicStore.createTopic (unit, реална SQLite база) ===
 * [S1]  Valid create -> persisted с правилния createdByProfileId, status=active
 * [S2]  listActiveTopics връща новосъздадената тема
 * [S3]  Duplicate exact title (active) -> title_exists, само 1 ред в DB
 * [S4]  Duplicate case-insensitive ("БЕЛОТ" срещу "Белот") -> title_exists
 * [S5]  Duplicate trim-insensitive ("  белот  " срещу "Белот") -> title_exists
 * [S6]  Removed topic title reuse -> позволено (нов create успява)
 * [S7]  topic_id е UUID, различен от slug на друга тема, НЕ базиран на title
 * [S8]  Празна нова тема (0 съобщения) — getTopicById я връща коректно, без грешка
 * [S9]  Deterministic ordering: нова тема се появява last (created_at ASC сред sort_order=0)
 * [S10] pollNewActiveTopicsCreatedAfter връща само теми СЛЕД cursor-а, композитен tie-break
 *
 * === Section C: атомична concurrency защита (unit, РЕАЛНИ паралелни transactions) ===
 * [C1] 5 едновременни createTopic() със СЪЩИЯ normalized title ("Белот") ->
 *      точно 1 success, 4 title_exists, точно 1 active ред в DB
 * [C2] Едновременни create с различни титли -> всички успяват независимо
 *
 * === Section A: единична live инстанция (HTTP/WS) — auth + protocol ===
 * (guest_not_allowed НЕ е тестван тук през реален WS join_guest_trial —
 * guard-ът е `playerProgressStore.isTemporaryProfile()`, ИДЕНТИЧНИЯТ code
 * path, вече established и unaffected от create_topic, ползван от
 * send_topic_message/send_topic_reply; heavy guest-trial room simulation
 * harness е извън обхвата на този focused check.)
 * [A1] Анонимен -> create_topic -> not_authenticated
 * [A3] Registered non-VIP -> vip_required
 * [A4] VIP -> create_topic успява, topic_created с matching requestId
 * [A5] Празен title -> empty_title (rate limit slot НЕ се консумира)
 * [A6] Твърде дълъг title (81 code points) -> title_too_long
 * [A7] Duplicate title (вече съществуваща активна тема) -> topic_title_exists
 * [A8] Rate limit: 4-ти create в прозореца -> rate_limited
 * [A9] Нова тема веднага е subscribable — subscribe_topic_messages за нейния topicId работи
 * [A10] Root съобщение веднага постваемо в новата тема
 *
 * === Section R: directory-wide realtime broadcast ===
 * [R1] Directory subscriber (различен от creator-а) получава topic_created broadcast БЕЗ requestId
 * [R2] Creator-ът получава ТОЧНО ЕДИН topic_created пакет (success), НЕ и broadcast-а втори път
 * [R3] Non-subscribed connection НЕ получава topic_created изобщо
 *
 * === Section E2E: real concurrent create_topic през два WS клиента (spec изискване) ===
 * [E1] Две WS connections изпращат create_topic("Белот") / create_topic("  БЕЛОТ  ")
 *      възможно най-близко във времето -> точно 1 success, 1 topic_title_exists,
 *      точно 1 активна тема в DB накрая
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, cp, mkdir, symlink, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import WebSocket, { type RawData } from 'ws'
import { createTopicStore } from '../src/db/topicStore.js'
import { validateTopicTitle, countTopicTitleCodePoints, TOPIC_TITLE_MAX_CODE_POINTS } from '../src/protocol/topicTitleValidation.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const topicsMigrationPath = resolve(serverRoot, 'database/migrations/20260810_002_create_topics_and_messages.sql')
// Moderation migration (Етап 4, приложен след Custom Topic Creation) добавя
// locked_until/locked_reason колони, които topicStore.ts вече чете
// безусловно (SELECT ги включва винаги) — трябва в схемата на ВСЕКИ тест DB
// тук, иначе "no such column".
const topicModerationMigrationPath = resolve(serverRoot, 'database/migrations/20260811_003_create_topic_moderation.sql')

// ─── Брояч ────────────────────────────────────────────────────────────────

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

// ─── Helpers (unit секции) ──────────────────────────────────────────────────

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-topic-creation-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

function buildBaseSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  // Минимален mock (established convention, mirror на checkTopicsStore.ts)
  // — само за да удовлетвори FK референциите на
  // topics.locked_by_account_id/removed_by_account_id и т.н. (Етап 4
  // moderation migration, приложена след Custom Topic Creation).
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY
    );
  `)
}

async function applyMigrationFile(db: DatabaseSync, migrationPath: string): Promise<void> {
  const sql = await readFile(migrationPath, 'utf8')
  db.exec('BEGIN;')
  try {
    db.exec(sql)
    db.exec('COMMIT;')
  } catch (err) {
    db.exec('ROLLBACK;')
    throw err
  }
}

function seedProfile(db: DatabaseSync, profileId: string): void {
  db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run(profileId, profileId)
}

// ─── Section V: topicTitleValidation (unit) ─────────────────────────────────

console.log('\n=== Topic Creation — Section V (title validation, unit) ===\n')

await check('[V1] Празен string -> empty_title', () => {
  const result = validateTopicTitle('')
  assert(!result.ok && result.code === 'empty_title', `очаквах empty_title, получих ${JSON.stringify(result)}`)
})

await check('[V2] Whitespace-only -> empty_title', () => {
  const result = validateTopicTitle('   \n\t  ')
  assert(!result.ok && result.code === 'empty_title', `очаквах empty_title, получих ${JSON.stringify(result)}`)
})

await check('[V3] Валиден кирилски текст -> ok, trimmed', () => {
  const result = validateTopicTitle('  Белот турнири  ')
  assert(result.ok, `очаквах ok, получих ${JSON.stringify(result)}`)
  if (result.ok) assertEqual(result.title, 'Белот турнири', 'title трябва да е trim-нат')
})

await check('[V4] Валиден латински текст -> ok', () => {
  const result = validateTopicTitle('General Discussion')
  assert(result.ok, `очаквах ok, получих ${JSON.stringify(result)}`)
})

await check('[V5] Смесен текст с нормална пунктуация (цифри, dash, въпросителна) -> ok', () => {
  const result = validateTopicTitle('Belot 2026 - въпроси?')
  assert(result.ok, `очаквах ok, получих ${JSON.stringify(result)}`)
})

await check('[V6] Точно 80 code points -> ok (граница)', () => {
  const title = 'а'.repeat(80)
  assertEqual(countTopicTitleCodePoints(title), 80, 'предусловие: точно 80 code points')
  const result = validateTopicTitle(title)
  assert(result.ok, `80 code points трябва да е позволено, получих ${JSON.stringify(result)}`)
})

await check('[V7] 81 code points -> title_too_long', () => {
  const title = 'а'.repeat(81)
  const result = validateTopicTitle(title)
  assert(!result.ok && result.code === 'title_too_long', `очаквах title_too_long, получих ${JSON.stringify(result)}`)
  assertEqual(TOPIC_TITLE_MAX_CODE_POINTS, 80, 'предусловие: max е 80')
})

await check('[V8] Control character (\\u0001) -> invalid_title', () => {
  const result = validateTopicTitle('Темазаглавие')
  assert(!result.ok && result.code === 'invalid_title', `очаквах invalid_title, получих ${JSON.stringify(result)}`)
})

await check('[V9] Leading/trailing whitespace винаги се trim-ва в резултата', () => {
  const result = validateTopicTitle('\t  Нова тема  \n')
  assert(result.ok, 'очаквах ok')
  if (result.ok) assertEqual(result.title, 'Нова тема', 'trim трябва да маха outer whitespace')
})

// ─── Section S: topicStore.createTopic (unit, реална SQLite) ──────────────

console.log('\n=== Topic Creation — Section S (store, unit) ===\n')

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'topic-creation-store.sqlite')
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, topicModerationMigrationPath)
  seedProfile(db, 'creator-1')
  db.close()

  const store = await createTopicStore(dbPath)

  await check('[S1] Valid create -> persisted с правилния creator, status=active', () => {
    const result = store.createTopic({ title: 'Белот', createdByProfileId: 'creator-1' })
    assert(result.ok, `очаквах success, получих ${JSON.stringify(result)}`)
    if (result.ok) {
      assertEqual(result.topic.title, 'Белот', 'title трябва да съвпада')
      assertEqual(result.topic.createdByProfileId, 'creator-1', 'creator трябва да съвпада')
      assertEqual(result.topic.status, 'active', 'нова тема трябва да е active')
      assertEqual(result.topic.isGeneral, false, 'custom тема не трябва да е isGeneral')
    }
  })

  await check('[S2] listActiveTopics връща новосъздадената тема', () => {
    const topics = store.listActiveTopics()
    assert(topics.some((t) => t.title === 'Белот'), 'новата тема трябва да е в списъка')
  })

  await check('[S3] Duplicate exact title (active) -> title_exists, само 1 ред в DB', () => {
    const before = store.listActiveTopics().filter((t) => t.title === 'Белот').length
    assertEqual(before, 1, 'предусловие: точно 1 съществуваща "Белот"')
    const result = store.createTopic({ title: 'Белот', createdByProfileId: 'creator-1' })
    assert(!result.ok && result.code === 'title_exists', `очаквах title_exists, получих ${JSON.stringify(result)}`)
    const after = store.listActiveTopics().filter((t) => t.title === 'Белот').length
    assertEqual(after, 1, 'все още трябва да има само 1 ред — duplicate insert не е минал')
  })

  await check('[S4] Duplicate case-insensitive ("БЕЛОТ" срещу "Белот") -> title_exists', () => {
    const result = store.createTopic({ title: 'БЕЛОТ', createdByProfileId: 'creator-1' })
    assert(!result.ok && result.code === 'title_exists', `очаквах title_exists, получих ${JSON.stringify(result)}`)
  })

  await check('[S5] Duplicate trim-insensitive ("  белот  " срещу "Белот") -> title_exists', () => {
    const result = store.createTopic({ title: '  белот  ', createdByProfileId: 'creator-1' })
    assert(!result.ok && result.code === 'title_exists', `очаквах title_exists, получих ${JSON.stringify(result)}`)
  })

  let removedTopicId: string
  await check('[S6] Removed topic title reuse -> позволено (нов create успява)', () => {
    const created = store.createTopic({ title: 'Временна тема', createdByProfileId: 'creator-1' })
    assert(created.ok, 'предусловие: create успешен')
    if (!created.ok) return
    removedTopicId = created.topic.topicId
    const dbDirect = new DatabaseSync(dbPath, { open: true })
    dbDirect.prepare(`UPDATE topics SET status = 'removed' WHERE topic_id = ?`).run(removedTopicId)
    dbDirect.close()

    const result = store.createTopic({ title: 'Временна тема', createdByProfileId: 'creator-1' })
    assert(result.ok, `removed тема трябва да освободи title-а за reuse, получих ${JSON.stringify(result)}`)
  })

  await check('[S7] topic_id е UUID, различен от slug на друга тема, НЕ базиран на title', () => {
    const a = store.createTopic({ title: 'Уникално име А', createdByProfileId: 'creator-1' })
    const b = store.createTopic({ title: 'Уникално име Б', createdByProfileId: 'creator-1' })
    assert(a.ok && b.ok, 'предусловие: и двата create успешни')
    if (!a.ok || !b.ok) return
    assert(a.topic.topicId !== b.topic.topicId, 'topicId-тата трябва да са различни')
    assert(a.topic.topicId !== a.topic.title, 'topicId НЕ трябва да е директно title-a')
    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    assert(uuidLike.test(a.topic.topicId), `topicId трябва да изглежда като UUID, получих ${a.topic.topicId}`)
    assertEqual(a.topic.slug, a.topic.topicId, 'slug трябва да е равен на topicId (вътрешен uniqueness key)')
  })

  await check('[S8] Празна нова тема (0 съобщения) — getTopicById я връща коректно, без грешка', () => {
    const created = store.createTopic({ title: 'Съвсем празна тема', createdByProfileId: 'creator-1' })
    assert(created.ok, 'предусловие: create успешен')
    if (!created.ok) return
    const fetched = store.getTopicById(created.topic.topicId)
    assert(fetched !== null, 'getTopicById трябва да намери новата тема')
    assertEqual(fetched!.title, 'Съвсем празна тема', 'title трябва да съвпада')
  })

  await check('[S9] Deterministic ordering: нова тема се появява last (created_at ASC)', () => {
    const beforeCount = store.listActiveTopics().length
    const created = store.createTopic({ title: 'Абсолютно последна тема', createdByProfileId: 'creator-1' })
    assert(created.ok, 'предусловие: create успешен')
    const topics = store.listActiveTopics()
    assertEqual(topics.length, beforeCount + 1, 'трябва да има точно 1 нова тема повече')
    assertEqual(topics[topics.length - 1]!.title, 'Абсолютно последна тема', 'новата тема трябва да е последна в established ordering-а')
  })

  await check('[S10] pollNewActiveTopicsCreatedAfter връща само теми СЛЕД cursor-а (rowid-based, insertion-order монотонен)', () => {
    const cursorBefore = store.getLatestActiveTopicCursor()
    const created = store.createTopic({ title: 'Тема след cursor-а', createdByProfileId: 'creator-1' })
    assert(created.ok, 'предусловие: create успешен')
    if (!created.ok) return
    const { topics: polled, nextCursor } = store.pollNewActiveTopicsCreatedAfter(cursorBefore, 50)
    assert(polled.some((t) => t.topicId === created.topic.topicId), 'новата тема трябва да е в poll резултата')
    assert(nextCursor !== cursorBefore, 'nextCursor трябва да напредне след като е имало нов ред')

    const { topics: polledAgain } = store.pollNewActiveTopicsCreatedAfter(nextCursor, 50)
    assertEqual(polledAgain.length, 0, 'повторен poll със свежия cursor не трябва да върне нищо ново')
  })

  store.close()
})

// ─── Section C: атомична concurrency защита (unit, реални паралелни transactions) ──

console.log('\n=== Topic Creation — Section C (atomic concurrency, unit) ===\n')

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'topic-creation-concurrency.sqlite')
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, topicModerationMigrationPath)
  seedProfile(db, 'racer-1')
  db.close()

  const store = await createTopicStore(dbPath)

  await check('[C1] 5 едновременни createTopic() със СЪЩИЯ normalized title -> точно 1 success, 4 title_exists', async () => {
    const variants = ['Дуплирана тема', '  ДУПЛИРАНА ТЕМА  ', 'дуплирана тема', 'Дуплирана Тема', '  дуплирана тема']
    const results = await Promise.all(
      variants.map((title) => Promise.resolve().then(() => store.createTopic({ title, createdByProfileId: 'racer-1' }))),
    )
    const successes = results.filter((r) => r.ok)
    const conflicts = results.filter((r) => !r.ok)
    assertEqual(successes.length, 1, `очаквах точно 1 success от 5 конкурентни заявки, получих ${successes.length}`)
    assertEqual(conflicts.length, 4, `очаквах точно 4 title_exists, получих ${conflicts.length}`)
    assert(conflicts.every((r) => !r.ok && r.code === 'title_exists'), 'всички конфликти трябва да са title_exists')

    const activeCount = store.listActiveTopics().filter((t) => t.title.trim().toLowerCase() === 'дуплирана тема').length
    assertEqual(activeCount, 1, `трябва да има точно 1 активна тема с това normalized title в DB, получих ${activeCount}`)
  })

  await check('[C2] Едновременни create с различни титли -> всички успяват независимо', async () => {
    const titles = ['Паралелна А', 'Паралелна Б', 'Паралелна В', 'Паралелна Г']
    const results = await Promise.all(
      titles.map((title) => Promise.resolve().then(() => store.createTopic({ title, createdByProfileId: 'racer-1' }))),
    )
    assert(results.every((r) => r.ok), `очаквах всички да успеят, получих ${JSON.stringify(results)}`)
    const uniqueIds = new Set(results.map((r) => (r.ok ? r.topic.topicId : null)))
    assertEqual(uniqueIds.size, 4, 'всяка успешна тема трябва да има уникален topicId')
  })

  store.close()
})

// ─── Established real-server HTTP/WS harness (виж checkTopicMessagesRealtime.ts) ──

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'TopicCreationCheck1!'

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
  const tmp = await mkdtemp(join(tmpdir(), 'belot-topic-creation-http-'))
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

async function waitForWsMessage(ws: WebSocket, predicate: (msg: AnyMsg) => boolean, timeoutMs = 5000): Promise<AnyMsg> {
  const buffer = wsMessageBuffers.get(ws)
  if (!buffer) throw new Error('WS connection not opened via openWs() — no message buffer registered')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const idx = buffer.findIndex(predicate)
    if (idx !== -1) {
      const [msg] = buffer.splice(idx, 1)
      return msg!
    }
    if (Date.now() > deadline) throw new Error('Timeout waiting for WS message matching predicate')
    await sleep(25)
  }
}

async function collectWsMessages(ws: WebSocket, durationMs: number): Promise<AnyMsg[]> {
  const buffer = wsMessageBuffers.get(ws)
  if (!buffer) throw new Error('WS connection not opened via openWs() — no message buffer registered')
  const startLength = buffer.length
  await sleep(durationMs)
  return buffer.slice(startLength)
}

async function grantVipViaLaunchGift(port: number, cookie: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/vip/claim-launch-gift`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: '{}',
  })
  if (res.status !== 200) throw new Error(`claim-launch-gift failed: ${res.status}`)
}

// ─── Section A + R: единична live инстанция ────────────────────────────────

console.log('\n=== Topic Creation — Section A/R (single instance, real server) ===\n')

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: ReturnType<typeof startSrv> | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitForServerReady(port)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`
  const userVip = await registerAndLogin(port, `tc-user-vip-${runId}@example.test`, 'TopicCreatorVip')
  const userNoVip = await registerAndLogin(port, `tc-user-novip-${runId}@example.test`, 'TopicCreatorNoVip')
  const userSubscriber = await registerAndLogin(port, `tc-user-sub-${runId}@example.test`, 'TopicCreatorSub')
  // Отделен профил (НЕ userSubscriber.cookie повторно) — established server
  // поведение е single-session-per-account: втора WS connection със СЪЩАТА
  // сесийна cookie displace-ва първата (session_displaced), затова
  // "non-subscribed connection" тестът се нуждае от собствен профил, за да
  // остане wsSubscriber реално отворен и subscribed.
  const userNonSubscribed = await registerAndLogin(port, `tc-user-nonsub-${runId}@example.test`, 'TopicCreatorNonSub')

  await grantVipViaLaunchGift(port, userVip.cookie)

  const wsAnon = await openWs(port)
  const wsVip = await openWs(port, userVip.cookie)
  const wsNoVip = await openWs(port, userNoVip.cookie)
  const wsSubscriber = await openWs(port, userSubscriber.cookie)
  const wsNonSubscribed = await openWs(port, userNonSubscribed.cookie)

  await check('[A1] Анонимен -> create_topic -> not_authenticated', async () => {
    sendWs(wsAnon, { type: 'create_topic', title: 'Опит от анонимен', requestId: 'anon-create-1' })
    const err = await waitForWsMessage(wsAnon, (m) => m.type === 'topic_create_error' && m.requestId === 'anon-create-1')
    assert(err.code === 'not_authenticated', `очаквах not_authenticated, получих ${err.code}`)
  })

  await check('[A3] Registered non-VIP -> vip_required', async () => {
    sendWs(wsNoVip, { type: 'create_topic', title: 'Опит без VIP', requestId: 'novip-create-1' })
    const err = await waitForWsMessage(wsNoVip, (m) => m.type === 'topic_create_error' && m.requestId === 'novip-create-1')
    assert(err.code === 'vip_required', `очаквах vip_required, получих ${err.code}`)
  })

  let createdTopicId = ''

  await check('[A4] VIP -> create_topic успява, topic_created с matching requestId', async () => {
    sendWs(wsVip, { type: 'create_topic', title: `VIP тема ${runId}`, requestId: 'vip-create-1' })
    const msg = await waitForWsMessage(wsVip, (m) => m.type === 'topic_created' && m.requestId === 'vip-create-1')
    const topic = msg.topic as { topicId: string; title: string; createdByProfileId: string; status: string }
    assertEqual(topic.title, `VIP тема ${runId}`, 'title трябва да съвпада')
    assertEqual(topic.createdByProfileId, userVip.profileId, 'creator трябва да е реалния authenticated профил, не spoof-нат')
    assertEqual(topic.status, 'active', 'нова тема трябва да е active')
    createdTopicId = topic.topicId
  })

  await check('[A5] Празен title -> empty_title', async () => {
    sendWs(wsVip, { type: 'create_topic', title: '   ', requestId: 'vip-empty-1' })
    const err = await waitForWsMessage(wsVip, (m) => m.type === 'topic_create_error' && m.requestId === 'vip-empty-1')
    assert(err.code === 'empty_title', `очаквах empty_title, получих ${err.code}`)
  })

  await check('[A6] Твърде дълъг title (81 code points) -> title_too_long', async () => {
    sendWs(wsVip, { type: 'create_topic', title: 'а'.repeat(81), requestId: 'vip-toolong-1' })
    const err = await waitForWsMessage(wsVip, (m) => m.type === 'topic_create_error' && m.requestId === 'vip-toolong-1')
    assert(err.code === 'title_too_long', `очаквах title_too_long, получих ${err.code}`)
  })

  await check('[A7] Duplicate title (вече съществуваща активна тема) -> topic_title_exists', async () => {
    sendWs(wsVip, { type: 'create_topic', title: `VIP тема ${runId}`, requestId: 'vip-dup-1' })
    const err = await waitForWsMessage(wsVip, (m) => m.type === 'topic_create_error' && m.requestId === 'vip-dup-1')
    assert(err.code === 'topic_title_exists', `очаквах topic_title_exists, получих ${err.code}`)
  })

  await check('[A8] Rate limit: 4-ти create в прозореца -> rate_limited', async () => {
    // Лимитът е 3/минута per-profile (server config, TOPIC_CREATE_RATE_LIMIT_MAX_PER_WINDOW).
    // Ползваме СВЕЖ VIP профил тук (не wsVip), за да изолираме теста от
    // rate-limit slot-овете, вече консумирани от wsVip в A4 (success) и A7
    // (duplicate title — минава validation, значи КОНСУМИРА slot, established
    // ред: rate limit е СЛЕД title validation, ПРЕДИ duplicate check).
    const userRateLimit = await registerAndLogin(port, `tc-user-ratelimit-${runId}@example.test`, 'TopicRateLimitUser')
    await grantVipViaLaunchGift(port, userRateLimit.cookie)
    const wsRateLimit = await openWs(port, userRateLimit.cookie)

    sendWs(wsRateLimit, { type: 'create_topic', title: `Rate limit тест 1 ${runId}`, requestId: 'rl-1' })
    await waitForWsMessage(wsRateLimit, (m) => m.type === 'topic_created' && m.requestId === 'rl-1')
    sendWs(wsRateLimit, { type: 'create_topic', title: `Rate limit тест 2 ${runId}`, requestId: 'rl-2' })
    await waitForWsMessage(wsRateLimit, (m) => m.type === 'topic_created' && m.requestId === 'rl-2')
    sendWs(wsRateLimit, { type: 'create_topic', title: `Rate limit тест 3 ${runId}`, requestId: 'rl-3' })
    await waitForWsMessage(wsRateLimit, (m) => m.type === 'topic_created' && m.requestId === 'rl-3')
    sendWs(wsRateLimit, { type: 'create_topic', title: `Rate limit тест 4 ${runId}`, requestId: 'rl-4' })
    const err = await waitForWsMessage(wsRateLimit, (m) => m.type === 'topic_create_error' && m.requestId === 'rl-4')
    assert(err.code === 'rate_limited', `очаквах rate_limited на 4-тия create, получих ${err.code}`)

    wsRateLimit.close()
  })

  await check('[A9] Нова тема веднага е subscribable', async () => {
    sendWs(wsVip, { type: 'subscribe_topic_messages', topicId: createdTopicId, afterSeq: 0 })
    const catchup = await waitForWsMessage(wsVip, (m) => m.type === 'topic_message_catchup' && m.topicId === createdTopicId)
    assert(Array.isArray(catchup.messages) && catchup.messages.length === 0, 'нова тема трябва да има празна catch-up история')
  })

  await check('[A10] Root съобщение веднага постваемо в новата тема', async () => {
    sendWs(wsVip, { type: 'send_topic_message', topicId: createdTopicId, body: 'Първо съобщение в новата тема', requestId: 'first-post-1' })
    const msg = await waitForWsMessage(wsVip, (m) => m.type === 'topic_message' && m.requestId === 'first-post-1')
    assertEqual(msg.body, 'Първо съобщение в новата тема', 'body трябва да съвпада')
    assertEqual(msg.topicId, createdTopicId, 'topicId трябва да съвпада')
  })

  // ─── Section R: directory-wide realtime broadcast ─────────────────────────

  console.log('\n=== Topic Creation — Section R (directory realtime broadcast) ===\n')

  sendWs(wsSubscriber, { type: 'subscribe_topics_directory' })
  await sleep(150) // subscribe е fire-and-forget, без ack — кратка пауза за да "хване" преди следващия create

  // Свеж dedicated creator профил за цялата Section R (НЕ wsVip — по този
  // момент wsVip вече е консумирал 2+ rate-limit slots от A4/A7, а Section R
  // прави 3 отделни create-а, което би прехвърлило лимита от 3/60s и би
  // объркало резултата с rate_limited вместо истинския assertion).
  const userRCreator = await registerAndLogin(port, `tc-user-rcreator-${runId}@example.test`, 'TopicRCreator')
  await grantVipViaLaunchGift(port, userRCreator.cookie)
  const wsRCreator = await openWs(port, userRCreator.cookie)

  await check('[R1] Directory subscriber (различен от creator-а) получава topic_created broadcast БЕЗ requestId', async () => {
    sendWs(wsRCreator, { type: 'create_topic', title: `Broadcast тема ${runId}`, requestId: 'broadcast-create-1' })
    const creatorMsg = await waitForWsMessage(wsRCreator, (m) => m.type === 'topic_created' || m.type === 'topic_create_error')
    if (creatorMsg.type === 'topic_create_error') {
      throw new Error(`create_topic неочаквано отхвърлен: code=${creatorMsg.code} message=${creatorMsg.message}`)
    }
    const broadcastMsg = await waitForWsMessage(
      wsSubscriber,
      (m) => m.type === 'topic_created' && (m.topic as { topicId: string }).topicId === (creatorMsg.topic as { topicId: string }).topicId,
    )
    assertEqual(broadcastMsg.requestId, undefined, 'broadcast до друг subscriber НЕ трябва да носи requestId')
  })

  await check('[R2] Creator-ът получава ТОЧНО ЕДИН topic_created пакет (success), НЕ и broadcast-а втори път', async () => {
    sendWs(wsRCreator, { type: 'subscribe_topics_directory' })
    await sleep(150)
    sendWs(wsRCreator, { type: 'create_topic', title: `No-duplicate тема ${runId}`, requestId: 'no-dup-create-1' })
    await waitForWsMessage(wsRCreator, (m) => m.type === 'topic_created' && m.requestId === 'no-dup-create-1')
    // Изчакваме прозорец, достатъчен за directory poll tick-а (2s interval) — ако
    // creator-ът щеше да получи ВТОРИ пакет (broadcast echo), той би пристигнал тук.
    const extra = await collectWsMessages(wsRCreator, 2500)
    const duplicateTopicCreated = extra.filter((m) => m.type === 'topic_created' && (m.topic as { title: string }).title === `No-duplicate тема ${runId}`)
    assertEqual(duplicateTopicCreated.length, 0, 'creator-ът не трябва да получи ВТОРИ topic_created за собствената си тема')
  })

  await check('[R3] Non-subscribed connection НЕ получава topic_created изобщо', async () => {
    sendWs(wsRCreator, { type: 'create_topic', title: `Not-broadcast тема ${runId}`, requestId: 'not-broadcast-1' })
    await waitForWsMessage(wsRCreator, (m) => m.type === 'topic_created' && m.requestId === 'not-broadcast-1')
    const extra = await collectWsMessages(wsNonSubscribed, 500)
    assert(!extra.some((m) => m.type === 'topic_created'), 'non-subscribed connection не трябва да получи topic_created')
  })

  wsRCreator.close()

  // ─── Section E2E: real concurrent create_topic през два WS клиента ────────

  console.log('\n=== Topic Creation — Section E2E (real concurrent WS create, spec изискване) ===\n')

  await check('[E1] Две WS connections create_topic("Белот") / "  БЕЛОТ  " конкурентно -> точно 1 success, 1 topic_title_exists', async () => {
    const uniqueTitle = `Белот${runId}`
    // Свежи dedicated профили (НЕ userVip/userNoVip) — по този момент от
    // теста wsVip вече е консумирал множество rate-limit slots (A4, A7, R1,
    // R2, R3), reuse тук би объркал резултата с rate_limited вместо
    // topic_title_exists.
    const userRacerA = await registerAndLogin(port, `tc-racer-a-${runId}@example.test`, 'TopicRacerA')
    const userRacerB = await registerAndLogin(port, `tc-racer-b-${runId}@example.test`, 'TopicRacerB')
    await grantVipViaLaunchGift(port, userRacerA.cookie)
    await grantVipViaLaunchGift(port, userRacerB.cookie)
    const wsRacerA = await openWs(port, userRacerA.cookie)
    const wsRacerB = await openWs(port, userRacerB.cookie)

    // Изпратени възможно най-близко във времето (без await между тях) —
    // и двете заявки стигат до сървъра, преди първата да е завършила
    // обработка, точно сценарият, който атомичната BEGIN IMMEDIATE
    // транзакция в topicStore.createTopic трябва да серилизира коректно.
    sendWs(wsRacerA, { type: 'create_topic', title: uniqueTitle, requestId: 'race-a' })
    sendWs(wsRacerB, { type: 'create_topic', title: `  ${uniqueTitle.toUpperCase()}  `, requestId: 'race-b' })

    const [resultA, resultB] = await Promise.all([
      Promise.race([
        waitForWsMessage(wsRacerA, (m) => (m.type === 'topic_created' || m.type === 'topic_create_error') && m.requestId === 'race-a'),
      ]),
      Promise.race([
        waitForWsMessage(wsRacerB, (m) => (m.type === 'topic_created' || m.type === 'topic_create_error') && m.requestId === 'race-b'),
      ]),
    ])

    const outcomes = [resultA, resultB]
    const successes = outcomes.filter((m) => m.type === 'topic_created')
    const conflicts = outcomes.filter((m) => m.type === 'topic_create_error')

    assertEqual(successes.length, 1, `очаквах точно 1 success измежду двете конкурентни WS заявки, получих ${successes.length}: ${JSON.stringify(outcomes)}`)
    assertEqual(conflicts.length, 1, `очаквах точно 1 topic_title_exists, получих ${conflicts.length}`)
    assertEqual(conflicts[0]!.code, 'topic_title_exists', `конфликтният резултат трябва да е topic_title_exists, получих ${conflicts[0]!.code}`)

    // Финална DB проверка — независимо от кой WS round-trip резултат, накрая
    // трябва да има точно 1 активна тема с този normalized title. JS-side
    // case-fold (НЕ SQL LOWER() — ASCII-only, недостатъчен за кирилица,
    // виж regression fix-а в topicStore.createTopic).
    const dbCheck = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
    const allActive = dbCheck.prepare(`SELECT title FROM topics WHERE status = 'active'`).all() as Array<{ title: string }>
    dbCheck.close()
    const matching = allActive.filter((row) => row.title.trim().toLowerCase() === uniqueTitle.toLowerCase())
    assertEqual(matching.length, 1, `трябва да има точно 1 активна тема с normalized title "${uniqueTitle.toLowerCase()}" в DB, получих ${matching.length}`)

    wsRacerA.close()
    wsRacerB.close()
  })

  wsAnon.close()
  wsVip.close()
  wsNoVip.close()
  wsSubscriber.close()
  wsNonSubscribed.close()
} catch (err) {
  console.error('  Неочаквана грешка в Section A/R/E2E harness:', err)
  failed++
} finally {
  if (srv) {
    const output = srv.output()
    if (failed > 0) {
      console.log('\n  --- Server output (за debug) ---\n' + output.slice(-4000))
    }
    await stopSrv(srv)
  }
  await iso.cleanup()
}

// ─── Финален резултат ───────────────────────────────────────────────────────

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
