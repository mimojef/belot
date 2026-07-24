/**
 * checkVoluntaryLeaveChatGate.ts
 *
 * Regression check за production bug: играч, напуснал доброволно активна
 * маса (бутон "Излез" + потвърдена санкция), оставаше блокиран от чата
 * (isProfileInActiveGame) до края на целия мач, защото участникът в
 * room.seats[seat].participant си остава kind:'human' завинаги (за game
 * history/attribution — controlledByBot в authoritative game state е
 * ОТДЕЛНА структура и не участва в тази проверка).
 *
 * Fix: ново поле HumanRoomParticipant.permanentlyLeftAt (server/src/core/
 * serverTypes.ts) — null по подразбиране (createHumanParticipant.ts),
 * задава се САМО в leave_active_room handler-а (server/src/index.ts, редом
 * с вече съществуващото reconnectToken:null) при потвърдено доброволно
 * напускане. isProfileInActiveGame вече изисква permanentlyLeftAt===null,
 * в допълнение към kind==='human'.
 *
 * reconnectToken НЕ е ползван за тази цел — createRoomWithHumanHost/
 * addHumanToRoom (guest trial, private стаи) създават участници с
 * reconnectToken:null ОТ САМОТО НАЧАЛО, докато реално активно играят
 * (само истинският matchmaking път през createHumanParticipant генерира
 * random token по подразбиране) — repurpose-ването му би развалило чат
 * гейта точно за тези активни играчи. permanentlyLeftAt е нарочно отделно,
 * еднозначно поле само за тази цел.
 *
 * Тестове (реален spawned сървър, реален matchmaking с bot-fill, реални
 * HTTP+WS заявки — не regex/unit fixtures):
 *  [1] Активен, свързан играч в реална 'playing' стая → chat GET 403
 *  [2] Временен disconnect (WS затворен БЕЗ leave_active_room, reconnectToken
 *      остава валиден за resume) → chat GET продължава 403
 *  [3] Доброволно напускане (leave_active_room + acceptPenalty:true) →
 *      chat GET веднага 200, БЕЗ да чака края на мача
 *  [4] Няколко секунди по-късно (ботът продължава мача вместо напусналия) →
 *      напусналият профил остава разрешен за чат
 *  [5] Санкцията е начислена коректно (penaltyAmount>0, chargedAmount>0,
 *      balanceAfter по-малък от преди) — историята/резултатите не са
 *      компрометирани от frontend поправката
 *  [6] Room-ът НЕ е бил премахнат при напускането (ботът продължава реално,
 *      не мачът приключва принудително)
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
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

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const srv = createServer()
    srv.once('error', () => resolveFree(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolveFree(true)))
  })
}

async function waitForCondition(label: string, predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(150)
  }
  throw new Error(`Timeout: ${label}`)
}

// ─── Изолиран сървър (същия модел като checkVisitorSummary.ts / checkChatMessageNotification.ts) ──

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
  const root = await mkdtemp(join(tmpdir(), 'belot-voluntary-leave-chat-gate-'))
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

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

async function httpJson(
  port: number,
  method: string,
  pathname: string,
  cookie: string | null,
  body?: unknown,
): Promise<{ status: number; body: any; setCookie: string | null }> {
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

console.log('\ncheckVoluntaryLeaveChatGate\n')

let server: RunningServer | null = null
let port = 0
const isolated = await createIsolatedServerRoot(sourceServerRoot)

try {
  port = await findFreePort()
  if (!(await isPortFree(port))) throw new Error(`Порт ${port} зает`)

  server = startServer(isolated.serverDir, port)
  console.log(`Чакам сървъра на порт ${port}...`)
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
  console.log('Сървърът е готов.\n')

  const runId = `${Date.now()}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `voluntary-leave-diag-${runId}@example.test`,
    password: 'VoluntaryLeaveDiag1!',
    displayName: 'VoluntaryLeaveDiag',
    gender: 'male',
  })
  if (reg.status !== 200) throw new Error(`Регистрация неуспешна: ${JSON.stringify(reg.body)}`)
  const cookie = reg.setCookie as string
  const profileId: string = reg.body.session.profile.profileId

  // ─── WS връзка + реален matchmaking (bot-fill) → 'playing' стая ─────────
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: cookie } })
  const frames: any[] = []
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ }
  })
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen())
    ws.once('error', reject)
  })

  ws.send(JSON.stringify({ type: 'join_matchmaking', stake: 5000 }))
  console.log('Чакам room.status="playing" (bot-fill, до ~30 сек)...')
  await waitForCondition(
    'room_snapshot roomStatus=playing',
    () => frames.some((f) => f.type === 'room_snapshot' && f.roomStatus === 'playing'),
    40_000,
  )
  const playingSnapshot = frames.find((f) => f.type === 'room_snapshot' && f.roomStatus === 'playing')
  const roomId: string = playingSnapshot.roomId
  console.log(`Играчът е в реална активна стая ${roomId}.\n`)

  // ─── [1] Активен, свързан играч → 403 ────────────────────────────────────
  await check('[1] Активен свързан играч в playing стая → chat GET 403', async () => {
    const r = await httpJson(port, 'GET', '/api/chat/conversations', cookie)
    if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ─── [2] Временен disconnect (WS затворен, БЕЗ leave_active_room) → 403 ──
  await check('[2] Временен disconnect (WS close без leave_active_room) → chat GET все още 403', async () => {
    ws.close()
    await new Promise<void>((r) => ws.once('close', () => r()))
    await sleep(300) // изчакай сървъра да обработи 'close' event handler-а
    const r = await httpJson(port, 'GET', '/api/chat/conversations', cookie)
    if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)} (очакван 403 — reconnectToken все още валиден, участникът остава resumable)`)
  })

  // ─── Ре-свързване (симулира reconnect на играча) и доброволно напускане ──
  const ws2 = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: cookie } })
  const frames2: any[] = []
  ws2.on('message', (data) => {
    try { frames2.push(JSON.parse(data.toString())) } catch { /* ignore */ }
  })
  await new Promise<void>((resolveOpen, reject) => {
    ws2.once('open', () => resolveOpen())
    ws2.once('error', reject)
  })
  // resume_room, за да прикачим отново currentRoomId към новата connection —
  // reconnectToken все още е валиден (доказано от [2]).
  const reconnectToken: string | null = playingSnapshot.reconnectToken ?? null
  if (reconnectToken !== null) {
    ws2.send(JSON.stringify({ type: 'resume_room', roomId, reconnectToken }))
    await waitForCondition(
      'room_resumed или свеж room_snapshot след reconnect',
      () => frames2.some((f) => (f.type === 'room_resumed' && f.roomId === roomId) || (f.type === 'room_snapshot' && f.roomId === roomId)),
      10_000,
    )
  }

  const balanceBefore = (await httpJson(port, 'GET', '/api/auth/me', cookie)).body?.session?.profile?.yellowCoinsBalance ?? null

  console.log('\nИграчът напуска доброволно (leave_active_room + acceptPenalty)...')
  ws2.send(JSON.stringify({ type: 'leave_active_room', roomId, acceptPenalty: true }))
  await waitForCondition(
    'left_active_room потвърждение',
    () => frames2.some((f) => f.type === 'left_active_room' && f.roomId === roomId),
    10_000,
  )
  const leftMsg = frames2.find((f) => f.type === 'left_active_room' && f.roomId === roomId)

  // ─── [3] Веднага след напускане → chat GET 200 (без чакане на края на мача) ──
  await check('[3] Доброволно напускане (leave_active_room+acceptPenalty) → chat GET 200 ВЕДНАГА', async () => {
    const r = await httpJson(port, 'GET', '/api/chat/conversations', cookie)
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)} (очакван незабавен 200, не чакане на края на мача)`)
    if (!r.body?.ok || !Array.isArray(r.body.conversations)) throw new Error(`неочакван body: ${JSON.stringify(r.body)}`)
  })

  // ─── [4] Няколко секунди по-късно (ботът продължава) → все още 200 ──────
  await sleep(2000)
  await check('[4] 2 сек по-късно (ботът продължава мача вместо напусналия) → чатът остава разрешен', async () => {
    const r = await httpJson(port, 'GET', '/api/chat/conversations', cookie)
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ─── [5] Санкцията е начислена коректно ──────────────────────────────────
  await check('[5a] left_active_room съдържа penalty с положителни суми', () => {
    if (!leftMsg.penalty) throw new Error('Липсва penalty в left_active_room отговора')
    if (!(leftMsg.penalty.penaltyAmount > 0)) throw new Error(`penaltyAmount=${leftMsg.penalty.penaltyAmount}`)
    if (!(leftMsg.penalty.chargedAmount > 0)) throw new Error(`chargedAmount=${leftMsg.penalty.chargedAmount}`)
  })
  await check('[5b] balance намалява реално със санкцията (историята/резултатите не са компрометирани)', async () => {
    const afterMe = await httpJson(port, 'GET', '/api/auth/me', cookie)
    const balanceAfter = afterMe.body?.session?.profile?.yellowCoinsBalance ?? null
    if (balanceBefore === null || balanceAfter === null) throw new Error('Не успях да прочета баланси')
    if (!(balanceAfter < balanceBefore)) throw new Error(`balanceBefore=${balanceBefore} balanceAfter=${balanceAfter} (очаквано намаление)`)
    if (balanceBefore - balanceAfter !== leftMsg.penalty.chargedAmount) {
      throw new Error(`Разликата в баланса (${balanceBefore - balanceAfter}) не съвпада с chargedAmount (${leftMsg.penalty.chargedAmount})`)
    }
  })

  // ─── [6] Room-ът не е бил принудително премахнат — ботът реално продължава ──
  await check('[6] left_active_room.removed === false (ботът продължава мача, не е принудително приключен)', () => {
    if (leftMsg.removed !== false) throw new Error(`removed=${leftMsg.removed} (очаквано false — 3-те останали места все още играят)`)
  })

  ws2.close()
} finally {
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
