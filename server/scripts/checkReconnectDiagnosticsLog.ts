// checkReconnectDiagnosticsLog.ts — Етап 0 (диагностика), реален сървър.
// Същият isolated-server-spawn + реален `ws` клиент pattern като
// checkWsCloseDiagnosticsLog.ts. Връзките са гост връзки (без регистрация),
// затова resume_room тук винаги е отказан — това упражнява реалното
// окабеляване на [resume] реда в index.ts, а не самата логика на решението
// (тя е покрита в checkReconnectDiagnostics.ts).
//
//  [I1] [ws] client connected: точен UTC timestamp at=<ISO> за реалната връзка
//  [I2] явен resume_room към несъществуваща стая -> room_resume_failed +
//       [resume] mode=explicit result=refused reason=try_resume_failed
//  [I3] тих resume_room (reconnectOf + reconnectAttempt) -> code
//       reconnect_unavailable + [resume] mode=silent_reconnect detail=no_profile
//       reconnectAttempt=3; отговорът към клиента е непроменен (без detail)
//  [I4] [ws-close] съдържа точен UTC at
//  [I5] reconnectToken не се появява никъде в изхода на сървъра
//  [I6] нормален трафик (ping) не добавя [resume]/[ws-handler-error] редове
//  [I7] общият WS catch логва изключенията (окабеляване в index.ts)
//
//   node node_modules/tsx/dist/cli.mjs scripts/checkReconnectDiagnosticsLog.ts   (от server/)

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${label}`) } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
function assert(condition: boolean, msg: string): asserts condition {
  if (!condition) throw new Error(msg)
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const freePort = () => new Promise<number>((done, failPort) => {
  const server = createNetServer().once('error', failPort).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return failPort(new Error('No free port'))
    server.close(() => done(address.port))
  })
})

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-reconnect-diag-'))
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
  return { serverDir, cleanup: () => retryRm(root) }
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
async function waitForHealth(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      const h: any = await r.json()
      if (r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready') return true
    } catch { /* retry */ }
    await sleep(200)
  }
  return false
}
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(50)
  }
  throw new Error(`Timeout waiting for: ${label}`)
}
function jsonLines(output: string, tag: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = []
  for (const line of output.split('\n')) {
    const idx = line.indexOf(`${tag} `)
    if (idx === -1) continue
    try { out.push(JSON.parse(line.slice(idx + tag.length + 1).trim())) } catch { /* ignore */ }
  }
  return out
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

type Client = { ws: WebSocket; clientId: string; messages: Array<Record<string, any>> }
async function openClient(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const messages: Array<Record<string, any>> = []
  ws.on('message', (data) => { try { messages.push(JSON.parse(String(data))) } catch { /* ignore */ } })
  await new Promise<void>((ok, bad) => { ws.once('open', () => ok()); ws.once('error', bad) })
  await waitUntil(() => messages.some((m) => m.type === 'connected'), 5_000, 'connected')
  const clientId = messages.find((m) => m.type === 'connected')!.clientId as string
  return { ws, clientId, messages }
}

const SECRET_TOKEN = 'RECONNECT-TOKEN-must-never-be-logged-7f3a'

console.log('\ncheckReconnectDiagnosticsLog\n')
let server: RunningServer | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)
try {
  const port = await freePort()
  server = startServer(isolated.serverDir, port)
  console.log(`Waiting for server on port ${port}...`)
  if (!(await waitForHealth(port))) {
    console.error(server.output())
    throw new Error('server did not become ready')
  }
  console.log('Server ready.\n')

  const before = Date.now()
  const client = await openClient(port)
  const after = Date.now()

  await check('[I1] [ws] client connected съдържа точен UTC at=<ISO> за реалната връзка', async () => {
    await waitUntil(() => server!.output().includes(`[ws] client connected: ${client.clientId} `), 5_000, 'connected line')
    const line = server!.output().split('\n').find((l) => l.includes(`[ws] client connected: ${client.clientId} `))!
    const m = / profile=(\S+) at=(\S+)/.exec(line)
    assert(m !== null && m[1] === 'none', line)
    assert(ISO.test(m[2]!), `at=${m[2]}`)
    const at = Date.parse(m[2]!)
    assert(at >= before - 1_000 && at <= after + 1_000, `at извън прозореца: ${m[2]}`)
  })

  await check('[I2] явен resume_room -> room_resume_failed + [resume] mode=explicit refused try_resume_failed', async () => {
    const seen = jsonLines(server!.output(), '[resume]').length
    client.ws.send(JSON.stringify({ type: 'resume_room', roomId: 'room-does-not-exist', reconnectToken: SECRET_TOKEN }))
    await waitUntil(() => client.messages.some((m) => m.type === 'room_resume_failed' && m.roomId === 'room-does-not-exist'), 5_000, 'room_resume_failed')
    await waitUntil(() => jsonLines(server!.output(), '[resume]').length > seen, 5_000, '[resume] line')
    const entry = jsonLines(server!.output(), '[resume]')[seen]!
    assert(entry.connectionId === client.clientId && entry.roomId === 'room-does-not-exist', JSON.stringify(entry))
    assert(entry.mode === 'explicit' && entry.result === 'refused' && entry.reason === 'try_resume_failed', JSON.stringify(entry))
    assert(typeof entry.detail === 'string' && entry.detail.length > 0 && ISO.test(entry.at), JSON.stringify(entry))
    assert(!('reconnectAttempt' in entry) && !('reconnectOf' in entry), JSON.stringify(entry))
  })

  await check('[I3] тих resume_room -> code reconnect_unavailable (отговорът непроменен) + [resume] silent_reconnect detail=no_profile attempt=3', async () => {
    const seen = jsonLines(server!.output(), '[resume]').length
    client.messages.length = 0
    client.ws.send(JSON.stringify({ type: 'resume_room', roomId: 'room-silent', reconnectToken: SECRET_TOKEN, reconnectOf: 'conn-previous', reconnectAttempt: 3 }))
    await waitUntil(() => client.messages.some((m) => m.type === 'room_resume_failed' && m.roomId === 'room-silent'), 5_000, 'room_resume_failed')
    const reply = client.messages.find((m) => m.type === 'room_resume_failed')!
    assert(reply.code === 'reconnect_unavailable' && reply.message === 'Играта не може да бъде възстановена автоматично.', JSON.stringify(reply))
    assert(Object.keys(reply).sort().join(',') === 'code,message,roomId,type', `нови полета към клиента: ${JSON.stringify(reply)}`)
    await waitUntil(() => jsonLines(server!.output(), '[resume]').length > seen, 5_000, '[resume] line')
    const entry = jsonLines(server!.output(), '[resume]')[seen]!
    assert(entry.mode === 'silent_reconnect' && entry.result === 'refused' && entry.reason === 'reconnect_unavailable', JSON.stringify(entry))
    assert(entry.detail === 'no_profile' && entry.reconnectAttempt === 3 && entry.reconnectOf === 'conn-previous', JSON.stringify(entry))
  })

  await check('[I6] нормален трафик (20 × ping) не добавя [resume]/[ws-handler-error] редове', async () => {
    const resumeBefore = jsonLines(server!.output(), '[resume]').length
    const errorsBefore = jsonLines(server!.output(), '[ws-handler-error]').length
    client.messages.length = 0
    for (let i = 0; i < 20; i++) client.ws.send(JSON.stringify({ type: 'ping' }))
    await waitUntil(() => client.messages.filter((m) => m.type === 'pong').length === 20, 5_000, '20 pong')
    await sleep(200)
    assert(jsonLines(server!.output(), '[resume]').length === resumeBefore, 'ping добави [resume] ред')
    assert(jsonLines(server!.output(), '[ws-handler-error]').length === errorsBefore, 'ping добави [ws-handler-error] ред')
  })

  await check('[I4] [ws-close] съдържа точен UTC at', async () => {
    const seen = jsonLines(server!.output(), '[ws-close]').length
    client.ws.close(1000, 'page_unload')
    await waitUntil(() => jsonLines(server!.output(), '[ws-close]').length > seen, 5_000, '[ws-close] line')
    const entry = jsonLines(server!.output(), '[ws-close]').find((e) => e.connectionId === client.clientId)!
    assert(entry !== undefined && ISO.test(entry.at) && entry.reason === 'page_unload', JSON.stringify(entry))
  })

  await check('[I5] reconnectToken не се появява никъде в изхода на сървъра', () => {
    assert(!server!.output().includes(SECRET_TOKEN), 'reconnectToken изтече в лога')
  })

  await check('[I7] общият WS catch логва изключенията (окабеляване в index.ts)', async () => {
    const source = (await readFile(join(sourceServerRoot, 'src', 'index.ts'), 'utf8')).replace(/\r\n/g, '\n')
    const catchIdx = source.indexOf("error instanceof Error ? error.message : 'Unexpected server error.'\n\n      // Етап 0")
    assert(catchIdx !== -1, 'общият catch не е намерен')
    const block = source.slice(catchIdx, catchIdx + 600)
    assert(block.includes('logWsHandlerError(formatWsHandlerErrorLogLine({') && block.includes('messageType: wsTimingLabel'), 'catch не логва изключението')
    assert(block.indexOf('logWsHandlerError(') < block.indexOf("type: 'error'"), 'логът трябва да е преди отговора към клиента')
  })
} finally {
  if (server) {
    server.child.kill()
    await sleep(300)
  }
  await isolated.cleanup()
}

console.log(`\n${'═'.repeat(72)}\nPassed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
