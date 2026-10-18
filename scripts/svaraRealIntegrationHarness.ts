import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat as statFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createNetServer, type Socket } from 'node:net'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

export function backendTestEnv(parent: NodeJS.ProcessEnv, parentPid: number, nonce: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'SystemDrive', 'ComSpec', 'PATH', 'Path', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (parent[key]) env[key] = parent[key]
  }
  return { ...env, NODE_ENV: 'test', PORT: '0', SVARA_TEST_ENABLED: '1',
    EMAIL_VERIFICATION_CODE_SECRET: `isolated-svara-${nonce}-${randomUUID()}`,
    BELOT_GAME_WORKER_COUNT: '1', BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
    SVARA_HARNESS_NONCE: nonce, SVARA_HARNESS_PARENT_PID: String(parentPid) }
}

export function ownedHarnessPath(root: string, path: string): string {
  const base = resolve(root), target = resolve(path), inTemp = relative(resolve(tmpdir()), base)
  assert(inTemp && !isAbsolute(inTemp) && inTemp !== '..' && !inTemp.startsWith(`..${sep}`)
    && basename(base).startsWith('pika-svara-browser-'), 'Not an owned temporary harness root')
  const rel = relative(base, target)
  assert(!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), 'Path escapes owned harness root')
  return target
}

/** Match the actual backend's wildcard bind. A 127.0.0.1 probe can succeed
 * alongside an existing 0.0.0.0 listener on Windows and proves nothing. */
export async function assertWildcardPortFree(port: number): Promise<void> {
  await new Promise<void>((done, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => server.close((error) => error ? reject(error) : done()))
  })
}

export async function createIsolatedSvaraRoot(projectRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'pika-svara-browser-'))
  const originalRoot = await realpath(root)
  const serverDir = ownedHarnessPath(root, join(root, 'server'))
  const links = [join(serverDir, 'node_modules'), join(root, 'node_modules')]
  const cleanup = async () => {
    assert.equal(await realpath(root), originalRoot, 'Temporary root was replaced')
    for (const link of links) {
      try { await unlink(ownedHarnessPath(root, link)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    await rm(ownedHarnessPath(root, root), { recursive: true, force: true })
  }
  try {
    await mkdir(serverDir, { recursive: true })
    // The production worker freshness guard checks source mtimes too.
    for (const directory of ['src', 'dist', 'database/migrations']) {
      await cp(join(projectRoot, 'server', directory), ownedHarnessPath(root, join(serverDir, directory)), { recursive: true, preserveTimestamps: true })
    }
    await cp(join(projectRoot, 'server/package.json'), join(serverDir, 'package.json'))
    await mkdir(join(serverDir, 'database/data'), { recursive: true })
    await symlink(join(projectRoot, 'server/node_modules'), links[0]!, process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(join(projectRoot, 'node_modules'), links[1]!, process.platform === 'win32' ? 'junction' : 'dir')
    const hookPath = join(root, 'backend-hooks.mjs')
    await cp(join(projectRoot, 'scripts/fixtures/svaraRealBackendHooks.mjs'), hookPath)
    const runnerPath = join(root, 'backend-runner.mjs')
    // A normal entry module avoids propagating a --import preload into the
    // production worker_threads, which have their own unchanged bootstrap.
    await writeFile(runnerPath, "import './backend-hooks.mjs';\nawait import('./server/dist/index.js');\n")
    return { root, serverDir, runnerPath, dbFile: join(serverDir, 'database/data/belot-v2.sqlite'), cleanup }
  } catch (error) { await cleanup(); throw error }
}

export async function runNode(projectRoot: string, args: string[]): Promise<void> {
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? done() : reject(new Error(`Build exited ${code}: ${output.slice(-3000)}`)))
  })
}

export async function waitForHarnessCondition(label: string, predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`Timeout: ${label}`)
}

type Identity = { event: string; nonce: string; pid: number; parentPid: number; address?: { port: number; address: string } }
export function verifyHarnessIdentity(value: unknown, nonce: string, pid: number): asserts value is Identity {
  assert(value && typeof value === 'object')
  const identity = value as Identity
  assert.equal(identity.nonce, nonce, 'Wrong harness nonce')
  assert.equal(identity.pid, pid, 'Wrong child PID')
  assert.equal(identity.parentPid, process.pid, 'Wrong parent PID')
}

export async function startIsolatedSvaraBackend(isolated: Awaited<ReturnType<typeof createIsolatedSvaraRoot>>, options: { featureFlag?: string | null; deckControl?: boolean } = {}) {
  const nonce = randomUUID()
  if (options.deckControl) {
    // Existing restart fixture, installed ONLY in this owned private copy.
    // Use its deterministic RNG; retain the production real clock/lifecycle.
    const hook = ownedHarnessPath(isolated.root, join(isolated.root, 'controlled-hooks.mjs'))
    await cp(join(process.cwd(), 'server/scripts/fixtures/svaraRestartHooks.mjs'), hook)
    const runtime = ownedHarnessPath(isolated.root, join(isolated.serverDir, 'dist/games/svara/runtime/svaraMatchRuntime.js'))
    const actual = runtime.replace(/\.js$/, '.actual.js')
    try { await statFile(actual) } catch { await cp(runtime, actual) }
    await writeFile(runtime, "export * from './svaraMatchRuntime.actual.js';\nimport { createSvaraMatchRuntime as actual } from './svaraMatchRuntime.actual.js';\nimport { random, observeRuntime } from '../../../../../controlled-hooks.mjs';\nexport function createSvaraMatchRuntime(options = {}) { return observeRuntime(actual({ ...options, random })); }\n")
    await writeFile(isolated.runnerPath, "import './backend-hooks.mjs';\nimport { configure } from './controlled-hooks.mjs';\nconfigure({ nonce: process.env.SVARA_HARNESS_NONCE, parentPid: Number(process.env.SVARA_HARNESS_PARENT_PID), now: Date.now() });\nawait import('./server/dist/index.js');\n")
  }
  const env = backendTestEnv(process.env, process.pid, nonce)
  if (options.featureFlag === null) delete env.SVARA_TEST_ENABLED
  else if (options.featureFlag !== undefined) env.SVARA_TEST_ENABLED = options.featureFlag
  const child: ChildProcess = spawn(process.execPath, [isolated.runnerPath], {
    cwd: isolated.serverDir, env, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = '', identitySeen = false, listenerPort = 0, stopped = false, fault: unknown
  const replies = new Map<string, { result?: unknown; error?: string }>()
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => { stopped = true; done(code) }))
  child.on('error', (error) => { fault = error })
  child.stdout!.on('data', (chunk) => { output += chunk.toString() })
  child.stderr!.on('data', (chunk) => { output += chunk.toString() })
  child.on('message', (message) => {
    try {
      verifyHarnessIdentity(message, nonce, child.pid!)
      const reply = message as typeof message & { reply?: string; result?: unknown; error?: string }
      if (reply.reply) replies.set(reply.reply, reply)
      if (message.event === 'identity') identitySeen = true
      if (message.event === 'listening') {
        assert(identitySeen && message.address?.address === '0.0.0.0' && message.address.port > 0)
        listenerPort = message.address.port
      }
    } catch (error) { fault = error }
  })
  const stop = async () => {
    assert.equal(child.spawnfile, process.execPath)
    assert.equal(child.spawnargs[1], isolated.runnerPath)
    if (!stopped) {
      if (identitySeen && child.connected) child.send({ command: 'shutdown', nonce })
      else child.kill()
      try { await waitForHarnessCondition('owned backend shutdown', () => stopped, 15000) }
      catch (error) { child.kill('SIGKILL'); await exited; throw error }
    }
    const code = await exited
    assert.equal(code, 0, `Owned backend did not stop cleanly (${code})`)
    assert(output.includes('[shutdown] signal=SIGTERM'), 'Real shutdown handler was not exercised')
    if (listenerPort) await assertWildcardPortFree(listenerPort)
  }
  try {
    await waitForHarnessCondition('owned backend identity, actual listening socket and exact database', () => {
      if (fault) throw fault
      if (stopped) throw new Error(`Owned backend exited during startup: ${output.slice(-3000)}`)
      return identitySeen && listenerPort > 0 && output.includes(`[db] SQLite ready file=${isolated.dbFile} `)
    }, 40000)
    await waitForHarnessCondition('owned backend worker health', async () => {
      if (fault) throw fault
      if (stopped) throw new Error('Owned backend exited during health check')
      const response = await fetch(`http://127.0.0.1:${listenerPort}/health`)
      const health = await response.json() as { ok?: boolean; gameWorkerLifecycle?: { state: string } }
      return response.ok && health.ok === true && health.gameWorkerLifecycle?.state === 'ready'
    }, 10000)
    const fixtureCommand = async (command: string, fields: Record<string, unknown> = {}) => {
      assert(options.deckControl && child.connected && !stopped, 'No private deck controller')
      const id = randomUUID()
      child.send({ nonce, id, command, ...fields })
      await waitForHarnessCondition('private deck fixture reply', () => { if (fault) throw fault; return replies.has(id) }, 5000)
      const reply = replies.get(id)!; replies.delete(id)
      assert(!reply.error, 'Private deck fixture rejected command')
      return reply.result
    }
    const queueDecks = async (decks: string[][]) => { await fixtureCommand('decks', { decks }) }
    const runtimeStatus = async () => await fixtureCommand('runtime-status') as { matchIds: string[] }
    const crash = async () => {
      assert(identitySeen && listenerPort && child.spawnargs[1] === isolated.runnerPath, 'Refusing crash of an unverified backend')
      assert(!stopped && child.pid, 'Owned backend is already stopped')
      child.kill('SIGKILL'); await exited
      await assertWildcardPortFree(listenerPort)
    }
    return { child, port: listenerPort, nonce, output: () => output, stop, crash, queueDecks, runtimeStatus }
  } catch (error) {
    try { await stop() } catch { if (!stopped) { child.kill('SIGKILL'); await exited } }
    throw error
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml',
}

/** Loopback-only same-origin gateway. HTTP bodies, cookies, Origin and real WS
 * upgrades go unchanged to the owned backend. No frame injection or routing to 3001. */
export async function startSvaraGateway(distDir: string, backendPort: number | (() => number | null)) {
  const targetPort = () => typeof backendPort === 'number' ? backendPort : backendPort()
  const sockets = new Set<Socket>()
  const server = createHttpServer(async (req, res) => {
    if (req.url?.startsWith('/api/') || req.url?.startsWith('/uploads/') || req.url === '/health') {
      const port = targetPort()
      if (port === null) { res.writeHead(503); res.end(); return }
      const upstream = httpRequest({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res)
      })
      upstream.on('error', () => { res.writeHead(502); res.end() })
      req.pipe(upstream)
      return
    }
    try {
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://test').pathname)
      let path = resolve(distDir, `.${urlPath === '/' ? '/index.html' : urlPath}`)
      const rel = relative(resolve(distDir), path)
      assert(!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
      try { if ((await statFile(path)).isDirectory()) path = join(path, 'index.html') }
      catch { if (!extname(urlPath)) path = join(distDir, 'index.html') }
      const data = await readFile(path)
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' }); res.end(data)
    } catch { res.writeHead(404); res.end() }
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, client, head) => {
    if (req.url !== '/ws') { client.destroy(); return }
    const port = targetPort()
    if (port === null) { client.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n'); return }
    const upstream = httpRequest({ hostname: '127.0.0.1', port, path: req.url, headers: req.headers })
    upstream.on('upgrade', (response, socket, upstreamHead) => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket))
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((lines, value, index, all) => index % 2 === 0 ? `${lines}${value}: ${all[index + 1]}\r\n` : lines, '')}\r\n`)
      if (head.length) socket.write(head)
      if (upstreamHead.length) client.write(upstreamHead)
      client.on('error', () => socket.destroy()); socket.on('error', () => client.destroy())
      client.once('close', () => socket.destroy()); socket.once('close', () => client.destroy())
      client.pipe(socket); socket.pipe(client)
    })
    upstream.on('response', (response) => { client.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`); response.resume() })
    upstream.on('error', () => client.destroy()); upstream.end()
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  assert(address && typeof address !== 'string')
  return { port: address.port, close: async () => {
    for (const socket of sockets) socket.destroy()
    server.closeIdleConnections()
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()))
  } }
}
