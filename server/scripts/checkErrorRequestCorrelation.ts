// checkErrorRequestCorrelation.ts — Етап 1: сървърът добавя requestType към
// всеки {type:'error'} (централно, в sendJsonMessage).
//
//  Unit (фалшиви sockets):
//  [U1] error към socket-а на обработваната заявка -> requestType = типа ѝ
//  [U2] error към друг socket или извън обработка -> requestType: null
//  [U3] не-error съобщения и вече зададен requestType — непроменени
//  Реален сървър (гост връзка, без регистрация):
//  [S1] submit_play_card към чужда стая -> error с requestType 'submit_play_card'
//  [S2] join_ludo_room като гост -> error с requestType 'join_ludo_room'
//  [S3] невалиден payload -> error с requestType: null
//  [S4] ping -> pong без requestType; текстът на грешките е непроменен
//
//   node node_modules/tsx/dist/cli.mjs scripts/checkErrorRequestCorrelation.ts   (от server/)

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { sendJsonMessage, setWsRequestContext } from '../src/core/sendJsonMessage.js'

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

function fakeSocket() {
  const sent: Array<Record<string, unknown>> = []
  return { socket: { send: (text: string) => sent.push(JSON.parse(text)) } as unknown as import('ws').WebSocket, sent }
}

console.log('\ncheckErrorRequestCorrelation\n')

await check('[U1] error към socket-а на обработваната заявка -> requestType = типа на заявката', () => {
  const a = fakeSocket()
  setWsRequestContext({ socket: a.socket, requestType: 'submit_play_card' })
  try {
    sendJsonMessage(a.socket, { type: 'error', message: 'Your seat was not found.' })
  } finally {
    setWsRequestContext(null)
  }
  assert(a.sent.length === 1 && a.sent[0]!.requestType === 'submit_play_card' && a.sent[0]!.message === 'Your seat was not found.', JSON.stringify(a.sent))
})

await check('[U2] error към друг socket по време на обработката или извън обработка -> requestType: null', () => {
  const a = fakeSocket()
  const b = fakeSocket()
  setWsRequestContext({ socket: a.socket, requestType: 'submit_bid_action' })
  try {
    sendJsonMessage(b.socket, { type: 'error', message: 'other' })
  } finally {
    setWsRequestContext(null)
  }
  sendJsonMessage(a.socket, { type: 'error', message: 'async later' })
  assert(b.sent[0]!.requestType === null && 'requestType' in b.sent[0]!, JSON.stringify(b.sent))
  assert(a.sent[0]!.requestType === null && 'requestType' in a.sent[0]!, JSON.stringify(a.sent))
})

await check('[U3] не-error съобщения и вече зададен requestType — непроменени; входният обект не се мутира', () => {
  const a = fakeSocket()
  const payload = { type: 'error', message: 'x', requestType: 'explicit' }
  const snapshot = { type: 'room_snapshot', roomId: 'r' }
  setWsRequestContext({ socket: a.socket, requestType: 'submit_play_card' })
  try {
    sendJsonMessage(a.socket, payload)
    sendJsonMessage(a.socket, snapshot)
    const plain = { type: 'error', message: 'y' }
    sendJsonMessage(a.socket, plain)
    assert(!('requestType' in plain), 'входният обект е мутиран')
  } finally {
    setWsRequestContext(null)
  }
  assert(a.sent[0]!.requestType === 'explicit', JSON.stringify(a.sent[0]))
  assert(!('requestType' in a.sent[1]!), JSON.stringify(a.sent[1]))
  assert(a.sent[2]!.requestType === 'submit_play_card', JSON.stringify(a.sent[2]))
})

// ── Реален сървър ────────────────────────────────────────────────────────
const freePort = () => new Promise<number>((done, failPort) => {
  const server = createNetServer().once('error', failPort).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return failPort(new Error('No free port'))
    server.close(() => done(address.port))
  })
})
const sourceServerRoot = resolve(process.cwd())
async function createIsolatedServerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'belot-error-correlation-'))
  const serverDir = join(root, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(sourceServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(sourceServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(sourceServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(sourceServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(sourceServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(sourceServerRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)
  return {
    serverDir,
    cleanup: async () => {
      for (let i = 0; i < 4; i++) {
        try { await rm(root, { recursive: true, force: true }); return } catch { await sleep(250) }
      }
    },
  }
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

let child: ChildProcessWithoutNullStreams | null = null
const isolated = await createIsolatedServerRoot()
try {
  const port = await freePort()
  const chunks: string[] = []
  child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: isolated.serverDir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c)); child.stderr.on('data', (c) => chunks.push(c))
  console.log(`\nWaiting for server on port ${port}...`)
  if (!(await waitForHealth(port))) { console.error(chunks.join('')); throw new Error('server did not become ready') }
  console.log('Server ready.\n')

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const received: Array<Record<string, any>> = []
  ws.on('message', (data) => { try { received.push(JSON.parse(String(data))) } catch { /* ignore */ } })
  await new Promise<void>((ok, bad) => { ws.once('open', () => ok()); ws.once('error', bad) })
  const nextError = async (send: string | object): Promise<Record<string, any>> => {
    const from = received.length
    ws.send(typeof send === 'string' ? send : JSON.stringify(send))
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const found = received.slice(from).find((m) => m.type === 'error')
      if (found) return found
      await sleep(30)
    }
    throw new Error(`no error for ${typeof send === 'string' ? send : JSON.stringify(send)}`)
  }

  await check('[S1] submit_play_card към стая, в която връзката не е -> requestType submit_play_card', async () => {
    const error = await nextError({ type: 'submit_play_card', roomId: 'room-x', cardId: 'clubs-7', declarationKeys: [] })
    assert(error.requestType === 'submit_play_card' && error.message === 'You are not attached to this room.', JSON.stringify(error))
  })
  await check('[S2] join_ludo_room като гост -> requestType join_ludo_room (Ludo домейн)', async () => {
    const error = await nextError({ type: 'join_ludo_room', ludoRoomId: 'ludo-x' })
    assert(error.requestType === 'join_ludo_room' && error.message === 'Трябва да влезеш в профила си.', JSON.stringify(error))
  })
  await check('[S3] невалиден payload -> requestType: null (не е отговор на разпозната заявка)', async () => {
    const error = await nextError('{"type":"no_such_message_type"}')
    assert('requestType' in error && error.requestType === null && error.message === 'Invalid message payload.', JSON.stringify(error))
  })
  await check('[S4] ping -> pong без requestType', async () => {
    const from = received.length
    ws.send(JSON.stringify({ type: 'ping' }))
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !received.slice(from).some((m) => m.type === 'pong')) await sleep(30)
    const pong = received.slice(from).find((m) => m.type === 'pong')
    assert(pong !== undefined && !('requestType' in pong), JSON.stringify(pong))
  })
  ws.close()
} finally {
  if (child && child.exitCode === null) {
    child.kill()
    await sleep(300)
  }
  await isolated.cleanup()
}

console.log(`\n${'═'.repeat(72)}\nPassed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
