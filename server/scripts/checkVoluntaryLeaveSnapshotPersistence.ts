/**
 * checkVoluntaryLeaveSnapshotPersistence.ts
 *
 * Regression check за backward-compatibility риска, открит при review на
 * permanentlyLeftAt (виж checkVoluntaryLeaveChatGate.ts за самата
 * voluntary-leave логика): production възстановява активни стаи от SQLite
 * snapshot-и след PM2 restart. Snapshot-и, записани ПРЕДИ добавянето на
 * HumanRoomParticipant.permanentlyLeftAt, нямат това поле в JSON-а изобщо —
 * след JSON.parse то е `undefined`, не `null`. Строга `=== null` проверка
 * би third-party третирала legacy АКТИВЕН участник като "окончателно
 * напуснал" и погрешно би отключила чата му.
 *
 * Fix (два слоя):
 *  1. prepareRestoredRoomForServerStart (server/src/index.ts) — единственото
 *     място, което вече rehydrate-ва всеки restored human participant при
 *     server boot — сега нормализира permanentlyLeftAt: participant.permanentlyLeftAt ?? null.
 *  2. isProfileInActiveGame чете participant.permanentlyLeftAt == null
 *     (loose, не strict) — defense-in-depth за всеки друг read path, който
 *     евентуално заобиколи нормализацията.
 *
 * Тестове (реален сървър, реален SQLite snapshot файл, РЕАЛЕН restart —
 * spawn → stop → spawn отново върху СЪЩИЯ database file, точно PM2 restart):
 *  [A] Legacy snapshot (participant БЕЗ permanentlyLeftAt ключ в JSON-а изобщо,
 *      инжектиран директно в SQLite, симулира snapshot от преди тази промяна)
 *      → след restart → chat GET → 403 (третиран като активен)
 *  [B] Нов активен участник (permanentlyLeftAt: null, реалният path) →
 *      save + restart + restore → chat GET → 403
 *  [C] Доброволно напуснал (реален leave_active_room + acceptPenalty) →
 *      permanentlyLeftAt получава timestamp → save + restart + restore →
 *      chat GET → 200 (timestamp-ът реално оцелява JSON round-trip-а)
 *  [D] Временен disconnect (WS close БЕЗ leave_active_room) → save + restart
 *      + restore → permanentlyLeftAt остава null → chat GET → 403
 *  [E] Неуспешен/отказан leave (acceptPenalty:false) → сървърът връща error,
 *      НЕ left_active_room → permanentlyLeftAt остава null → chat GET → 403
 *      (доказва, че failure path-овете в leave_active_room handler-а никога
 *      не маркират профила като напуснал)
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForCondition(label: string, predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(150)
  }
  throw new Error(`Timeout: ${label}`)
}

// ─── Изолиран сървър — СЪЩИЯТ serverDir/database се ползва за 2 spawn-а ────

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-voluntary-leave-snapshot-'))
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
  return {
    serverDir,
    databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: () => retryRm(root),
  }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    { cwd: serverDir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c))
  child.stderr.on('data', (c) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

// Изчаква реалния exit event, не само kill() извикването — иначе следващият
// spawn върху СЪЩИЯ SQLite файл (WAL mode) може да види недовършен checkpoint.
async function stopServerGracefully(server: RunningServer | null): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 12_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

async function waitForHealth(port: number, server: RunningServer): Promise<void> {
  try {
    await waitForCondition('backend health', async () => {
      try {
        const r = await fetch(`http://localhost:${port}/health`)
        const h = await r.json()
        return r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready'
      } catch { return false }
    }, 30_000)
  } catch (err) {
    console.error('--- server output ---')
    console.error(server.output())
    throw err
  }
}

async function httpJson(port: number, method: string, pathname: string, cookie: string | null, body?: unknown): Promise<{ status: number; body: any; setCookie: string | null }> {
  const res = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, body: json, setCookie }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') { reject(new Error('no port')); return }
      const p = addr.port
      srv.close(() => resolveFree(p))
    })
  })
}

async function registerProfile(port: number, label: string): Promise<{ cookie: string; profileId: string }> {
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `snap-persist-${label}-${runId}@example.test`,
    password: 'SnapshotPersistDiag1!',
    displayName: `Snap${label}`,
    gender: 'male',
  })
  if (reg.status !== 200) throw new Error(`Регистрация (${label}) неуспешна: ${JSON.stringify(reg.body)}`)
  return { cookie: reg.setCookie as string, profileId: reg.body.session.profile.profileId }
}

async function joinRealMatchAndWaitPlaying(port: number, cookie: string, stake: number): Promise<{ ws: WebSocket; frames: any[]; roomId: string; reconnectToken: string | null }> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: cookie } })
  const frames: any[] = []
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ } })
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen())
    ws.once('error', reject)
  })
  ws.send(JSON.stringify({ type: 'join_matchmaking', stake }))
  await waitForCondition(
    `room_snapshot roomStatus=playing (stake=${stake})`,
    () => frames.some((f) => f.type === 'room_snapshot' && f.roomStatus === 'playing'),
    40_000,
  )
  const snap = frames.find((f) => f.type === 'room_snapshot' && f.roomStatus === 'playing')
  return { ws, frames, roomId: snap.roomId, reconnectToken: snap.reconnectToken ?? null }
}

function dbGet(dbPath: string, sql: string, params: unknown[] = []): any {
  const db = new DatabaseSync(dbPath, { open: true })
  try { return db.prepare(sql).get(...(params as any)) } finally { db.close() }
}
function dbRun(dbPath: string, sql: string, params: unknown[] = []): void {
  const db = new DatabaseSync(dbPath, { open: true })
  try { db.prepare(sql).run(...(params as any)) } finally { db.close() }
}

console.log('\ncheckVoluntaryLeaveSnapshotPersistence\n')

let serverA: RunningServer | null = null
let serverB: RunningServer | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)

try {
  const port = await findFreePort()

  // ═══ Round 1: реален сървър, реални WS connections/matchmaking ═══════════
  serverA = startServer(isolated.serverDir, port)
  console.log(`[Round 1] Чакам сървъра на порт ${port}...`)
  await waitForHealth(port, serverA)
  console.log('[Round 1] Сървърът е готов.\n')

  // Profile 1 (стойност за scenario B — permanentlyLeftAt:null, реалният
  // default path — реален matchmaking, никога не напуска).
  const p1 = await registerProfile(port, 'b')
  console.log('Profile B: matchmaking (stake 5000)...')
  const roomB = await joinRealMatchAndWaitPlaying(port, p1.cookie, 5000)
  console.log(`Profile B е в реална активна стая ${roomB.roomId}.`)

  // Profile 3 (сценарий C — реално доброволно напускане).
  const p3 = await registerProfile(port, 'c')
  console.log('Profile C: matchmaking (stake 8000)...')
  const roomC = await joinRealMatchAndWaitPlaying(port, p3.cookie, 8000)
  console.log(`Profile C е в реална активна стая ${roomC.roomId}.`)

  // Profile 4 (сценарий D — временен disconnect, БЕЗ leave_active_room).
  const p4 = await registerProfile(port, 'd')
  console.log('Profile D: matchmaking (stake 10000)...')
  const roomD = await joinRealMatchAndWaitPlaying(port, p4.cookie, 10000)
  console.log(`Profile D е в реална активна стая ${roomD.roomId}.\n`)

  // ─── [E] Отказан/неуспешен leave (acceptPenalty:false) — контрол ПРЕДИ restart ──
  await check('[E1] leave_active_room с acceptPenalty:false → сървърът връща error, НЕ left_active_room', async () => {
    const framesBefore = roomB.frames.length
    roomB.ws.send(JSON.stringify({ type: 'leave_active_room', roomId: roomB.roomId, acceptPenalty: false }))
    await waitForCondition('error отговор за отказан leave', () => roomB.frames.slice(framesBefore).some((f) => f.type === 'error'), 5_000)
    const gotLeftConfirmation = roomB.frames.slice(framesBefore).some((f) => f.type === 'left_active_room')
    if (gotLeftConfirmation) throw new Error('Сървърът погрешно е потвърдил напускане при отказана санкция')
  })
  await check('[E2] След отказания leave, Profile B остава активен → chat GET все още 403', async () => {
    const r = await httpJson(port, 'GET', '/api/chat/conversations', p1.cookie)
    if (r.status !== 403) throw new Error(`status=${r.status} (очакван 403 — leave-ът е бил отказан, permanentlyLeftAt трябва да е останал null)`)
  })

  // ─── Profile C: реално доброволно напускане (permanentlyLeftAt се задава) ──
  console.log('\nProfile C напуска доброволно (leave_active_room+acceptPenalty)...')
  roomC.ws.send(JSON.stringify({ type: 'leave_active_room', roomId: roomC.roomId, acceptPenalty: true }))
  await waitForCondition('left_active_room за Profile C', () => roomC.frames.some((f) => f.type === 'left_active_room'), 10_000)
  await check('[pre-restart] Веднага след напускане, Profile C → chat GET 200 (контрол преди restart)', async () => {
    const r = await httpJson(port, 'GET', '/api/chat/conversations', p3.cookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
  })

  // ─── Profile D: временен disconnect, БЕЗ leave_active_room ──────────────
  roomD.ws.close()
  await new Promise<void>((r) => roomD.ws.once('close', () => r()))
  await sleep(300)

  // ─── Изчакай snapshot commit-ите реално да стигнат до SQLite (persistRoomSnapshot е синхронен при всяка room state промяна, но дай малък буфер) ──
  await sleep(500)

  // ─── Инжектирай legacy snapshot (Profile A) — участник БЕЗ permanentlyLeftAt ключ в JSON-а ──
  const templateRow = dbGet(isolated.databaseFile, `SELECT snapshot_json FROM active_room_snapshots WHERE room_id = ?`, [roomB.roomId]) as { snapshot_json: string } | undefined
  if (!templateRow) throw new Error('Не намерих snapshot за Profile B стаята — persistRoomSnapshot не е записал?')

  const pA = await registerProfile(port, 'a')
  const legacyRoomId = `legacy-room-${randomUUID()}`
  const templateRoom = JSON.parse(templateRow.snapshot_json)
  let legacySeatKey: string | null = null
  for (const seatKey of Object.keys(templateRoom.seats)) {
    const participant = templateRoom.seats[seatKey]?.participant
    if (participant?.kind === 'human') {
      legacySeatKey = seatKey
      // Замести идентичността с Profile A и ИЗТРИЙ permanentlyLeftAt ключа изцяло —
      // симулира JSON, записан ПРЕДИ добавянето на полето (не просто null).
      participant.identity = { ...participant.identity, profileId: pA.profileId }
      participant.publicProfile = participant.publicProfile ? { ...participant.publicProfile, profileId: pA.profileId } : null
      delete participant.permanentlyLeftAt
      break
    }
  }
  if (legacySeatKey === null) throw new Error('Не намерих human seat в template room-а')
  templateRoom.id = legacyRoomId
  templateRoom.status = 'playing'

  dbRun(
    isolated.databaseFile,
    `INSERT INTO active_room_snapshots (room_id, snapshot_version, room_status, game_phase, state_version, snapshot_json, is_active)
     VALUES (?, 1, 'playing', ?, 0, ?, 1)`,
    [legacyRoomId, templateRoom.game?.phase ?? null, JSON.stringify(templateRoom)],
  )
  console.log(`\nИнжектирах legacy snapshot (room=${legacyRoomId}, БЕЗ permanentlyLeftAt ключ) за Profile A.`)

  // Потвърди, преди restart, че injection-ът реално няма ключа в суровия JSON.
  await check('[инжекция] Инжектираният legacy JSON наистина няма permanentlyLeftAt ключ', () => {
    const row = dbGet(isolated.databaseFile, `SELECT snapshot_json FROM active_room_snapshots WHERE room_id = ?`, [legacyRoomId]) as { snapshot_json: string }
    const parsed = JSON.parse(row.snapshot_json)
    const participant = parsed.seats[legacySeatKey!].participant
    if ('permanentlyLeftAt' in participant) throw new Error('Инжектираният JSON съдържа permanentlyLeftAt — инжекцията не отразява legacy данни')
  })

  await stopServerGracefully(serverA)
  console.log('\n[Round 1] Сървърът е спрян (SIGTERM, изчакан graceful exit).\n')

  // ═══ Round 2: РЕСТАРТ върху СЪЩИЯ database file (симулира PM2 restart) ══
  serverB = startServer(isolated.serverDir, port)
  console.log(`[Round 2] Рестартирам сървъра на СЪЩИЯ порт/database...`)
  await waitForHealth(port, serverB)
  console.log('[Round 2] Сървърът е рестартиран и е готов.\n')

  await check('[A] Legacy snapshot (участник БЕЗ permanentlyLeftAt) след restart → chat GET 403 (третиран като активен)', async () => {
    const r = await httpJson(port, 'GET', '/api/chat/conversations', pA.cookie)
    if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)} (очакван 403 — липсващо поле НЕ трябва да значи "напуснал")`)
  })

  await check('[B] Нов активен участник (permanentlyLeftAt:null, реален matchmaking) след restart → chat GET 403', async () => {
    const r = await httpJson(port, 'GET', '/api/chat/conversations', p1.cookie)
    if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  await check('[C] Доброволно напуснал (реален leave_active_room) след restart → chat GET продължава 200 (timestamp оцелява JSON round-trip)', async () => {
    const r = await httpJson(port, 'GET', '/api/chat/conversations', p3.cookie)
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    if (!r.body?.ok || !Array.isArray(r.body.conversations)) throw new Error(`неочакван body: ${JSON.stringify(r.body)}`)
  })

  await check('[D] Временен disconnect (без leave) след restart → permanentlyLeftAt остава null → chat GET 403', async () => {
    const r = await httpJson(port, 'GET', '/api/chat/conversations', p4.cookie)
    if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)} (очакван 403 — все още resumable)`)
  })

  await check('[D-resume] reconnectToken за Profile D остава валиден след restart (resume все още възможен)', async () => {
    const row = dbGet(isolated.databaseFile, `SELECT snapshot_json FROM active_room_snapshots WHERE room_id = ?`, [roomD.roomId]) as { snapshot_json: string } | undefined
    if (!row) throw new Error('Room D snapshot липсва след restart')
    const parsed = JSON.parse(row.snapshot_json)
    const stillHasToken = Object.values(parsed.seats as Record<string, any>).some(
      (s: any) => s.participant?.kind === 'human' && s.participant?.identity?.profileId === p4.profileId && s.participant?.reconnectToken !== null,
    )
    if (!stillHasToken) throw new Error('reconnectToken не е оцелял/е нулиран погрешно през restart-а за временно disconnected играч')
  })
} finally {
  await stopServerGracefully(serverA)
  await stopServerGracefully(serverB)
  await isolated.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
