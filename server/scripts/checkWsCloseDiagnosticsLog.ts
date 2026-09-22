// checkWsCloseDiagnosticsLog.ts
//
// Focused, real-spawned-server test for the server-side WS close diagnostics
// added in server/src/index.ts's socket.on('close', (code, reason) => ...)
// handler (logWsCloseDiagnostics/sanitizeWsCloseReasonForLog). Uses the SAME
// established isolated-server-spawn + real `ws` client pattern as
// checkPrivateRoomWebSocketRoundTrip.ts — not a fragile hand-rolled harness.
//
// Scoped intentionally narrow: connections in this suite never join a Belot
// room (no auth/registration needed — the WS handshake accepts guest
// connections), so every close here is "not attached to a room" by
// construction. That already exercises the attachedToRoom:false/roomId-
// omitted/seat-omitted/roomActive:false path directly (it's the DEFAULT for
// any connection that never attaches). The roomId/seat/roomActive-populated
// path reads from the SAME pre-existing, already-exercised
// ServerConnection.currentRoomId/currentSeat fields and result.room.status —
// no new logic beyond field selection — so it is not re-verified here via a
// full multi-player active-room spin-up, to avoid exactly the kind of
// fragile integration harness this task explicitly said to avoid.
//
// Covers:
//  - explicit close with a diagnostic reason (mirrors GameServerClient's
//    auth_refresh/bid_watchdog/page_unload) is logged with the real code+reason.
//  - a normal close with NO reason omits the `reason` key entirely (distinct
//    from an explicit-reason close).
//  - a close reason containing newlines/control chars (log-injection attempt)
//    is sanitized — no literal newline reaches the log line, so a single
//    [ws-close] JSON object is never split into a fake extra log line.
//  - an abnormal close (client-side abrupt termination, no closing handshake)
//    is logged with code 1006, distinguishing it from explicit disconnects.
//  - none of the forbidden fields (reconnectToken/session token/email/IP/
//    displayName) ever appear in a [ws-close] log line.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { symlink } from 'node:fs/promises'
import WebSocket from 'ws'

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
const freePort = () => new Promise<number>((done, failPort) => {
  const server = createNetServer().once('error', failPort).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return failPort(new Error('No free port'))
    server.close(() => done(address.port))
  })
})

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
  const root = await mkdtemp(join(tmpdir(), 'belot-ws-close-diag-'))
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

/** Finds ALL `[ws-close] {...}` JSON log lines emitted so far in the captured output. */
function extractWsCloseLogEntries(output: string): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = []
  const lines = output.split('\n')
  for (const line of lines) {
    const marker = '[ws-close] '
    const idx = line.indexOf(marker)
    if (idx === -1) continue
    const jsonText = line.slice(idx + marker.length).trim()
    try {
      entries.push(JSON.parse(jsonText))
    } catch { /* not a parseable [ws-close] line, ignore */ }
  }
  return entries
}

console.log('\ncheckWsCloseDiagnosticsLog\n')

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

  let alreadySeenCloseEntries = 0

  // ═══════════════════════════════════════════════════════════════════
  // [A] Explicit close with a diagnostic reason (mirrors auth_refresh/
  // bid_watchdog/page_unload) — logged with the real code + reason,
  // attachedToRoom:false (this connection never joined a room).
  // ═══════════════════════════════════════════════════════════════════
  await check('[A] explicit close with a diagnostic reason is logged with code 1000 + the real reason + attachedToRoom:false', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolveOpen, reject) => { ws.once('open', () => resolveOpen()); ws.once('error', reject) })
    await sleep(100)
    ws.close(1000, 'bid_watchdog')
    await waitUntil(() => extractWsCloseLogEntries(server!.output()).length > alreadySeenCloseEntries, 5_000, '[ws-close] log line for case A')

    const entries = extractWsCloseLogEntries(server!.output())
    const entry = entries[entries.length - 1]!
    alreadySeenCloseEntries = entries.length

    assert(entry.code === 1000, `expected code 1000, got ${JSON.stringify(entry.code)}`)
    assert(entry.reason === 'bid_watchdog', `expected reason 'bid_watchdog', got ${JSON.stringify(entry.reason)}`)
    assert(entry.attachedToRoom === false, `expected attachedToRoom:false (never joined a room), got ${JSON.stringify(entry.attachedToRoom)}`)
    assert(entry.roomId === undefined, `expected roomId to be omitted, got ${JSON.stringify(entry.roomId)}`)
    assert(entry.seat === undefined, `expected seat to be omitted, got ${JSON.stringify(entry.seat)}`)
    assert(entry.roomActive === false, `expected roomActive:false, got ${JSON.stringify(entry.roomActive)}`)
    assert(typeof entry.lifetimeMs === 'number' && (entry.lifetimeMs as number) >= 0, `expected a numeric lifetimeMs, got ${JSON.stringify(entry.lifetimeMs)}`)
    assert(typeof entry.connectionId === 'string' && (entry.connectionId as string).length > 0, 'expected a connectionId')
  })

  // ═══════════════════════════════════════════════════════════════════
  // [B] Normal close WITHOUT a reason omits the `reason` key entirely —
  // distinct log shape from an explicit-reason close.
  // ═══════════════════════════════════════════════════════════════════
  await check('[B] a normal close with no reason omits the `reason` key (distinguishable from an explicit-reason close)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolveOpen, reject) => { ws.once('open', () => resolveOpen()); ws.once('error', reject) })
    await sleep(100)
    ws.close(1000)
    await waitUntil(() => extractWsCloseLogEntries(server!.output()).length > alreadySeenCloseEntries, 5_000, '[ws-close] log line for case B')

    const entries = extractWsCloseLogEntries(server!.output())
    const entry = entries[entries.length - 1]!
    alreadySeenCloseEntries = entries.length

    assert(entry.code === 1000, `expected code 1000, got ${JSON.stringify(entry.code)}`)
    assert(!('reason' in entry), `expected the 'reason' key to be entirely omitted for a no-reason close, got ${JSON.stringify(entry.reason)}`)
  })

  // ═══════════════════════════════════════════════════════════════════
  // [C] A close reason containing newlines/control chars (log-injection
  // attempt) never produces a literal newline in the log — exactly one
  // [ws-close] JSON entry results, not a split/fake extra line.
  // ═══════════════════════════════════════════════════════════════════
  await check('[C] a close reason with embedded newlines/control chars is sanitized — no log-injection, exactly one entry produced', async () => {
    const maliciousReason = 'evil\n[ws-close] {"connectionId":"forged","code":9999}\nmore'
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolveOpen, reject) => { ws.once('open', () => resolveOpen()); ws.once('error', reject) })
    await sleep(100)
    ws.close(1000, maliciousReason)
    await waitUntil(() => extractWsCloseLogEntries(server!.output()).length > alreadySeenCloseEntries, 5_000, '[ws-close] log line for case C')

    const entries = extractWsCloseLogEntries(server!.output())
    const newEntries = entries.slice(alreadySeenCloseEntries)
    alreadySeenCloseEntries = entries.length

    assert(newEntries.length === 1, `expected exactly ONE new [ws-close] entry (no injected fake extra line), got ${newEntries.length}`)
    const reasonText = String(newEntries[0]!.reason ?? '')
    assert(!reasonText.includes('\n'), `sanitized reason must not contain a literal newline, got ${JSON.stringify(reasonText)}`)
    assert(reasonText.includes('forged') === false || !reasonText.includes('\n'), 'sanitized reason must not allow a fabricated JSON object to appear on its own line')
  })

  // ═══════════════════════════════════════════════════════════════════
  // [D] Abnormal close (client abruptly terminates, no closing handshake)
  // is logged with code 1006 — distinguishable from explicit disconnects.
  // ═══════════════════════════════════════════════════════════════════
  await check('[D] an abnormal close (abrupt termination) is logged with code 1006', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolveOpen, reject) => { ws.once('open', () => resolveOpen()); ws.once('error', reject) })
    await sleep(100)
    ws.terminate()
    await waitUntil(() => extractWsCloseLogEntries(server!.output()).length > alreadySeenCloseEntries, 5_000, '[ws-close] log line for case D')

    const entries = extractWsCloseLogEntries(server!.output())
    const entry = entries[entries.length - 1]!
    alreadySeenCloseEntries = entries.length

    assert(entry.code === 1006, `expected abnormal close code 1006, got ${JSON.stringify(entry.code)}`)
    assert(!('reason' in entry), `expected no reason for an abrupt termination, got ${JSON.stringify(entry.reason)}`)
  })

  // ═══════════════════════════════════════════════════════════════════
  // [E] No forbidden PII/secret fields ever appear in ANY [ws-close] entry
  // captured during this whole run.
  // ═══════════════════════════════════════════════════════════════════
  await check('[E] no [ws-close] log entry ever contains reconnectToken/session token/email/IP/displayName fields', async () => {
    const entries = extractWsCloseLogEntries(server!.output())
    assert(entries.length >= 4, `expected at least 4 [ws-close] entries captured across cases A-D, got ${entries.length}`)
    const forbiddenKeys = ['reconnectToken', 'sessionToken', 'session', 'email', 'ip', 'remoteAddress', 'displayName', 'profile']
    for (const entry of entries) {
      for (const key of forbiddenKeys) {
        assert(!(key in entry), `[ws-close] entry must never contain a "${key}" field, found in ${JSON.stringify(entry)}`)
      }
    }
  })

  console.log('\n' + '═'.repeat(72))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  if (server && server.child.exitCode === null) {
    server.child.kill('SIGKILL')
    await Promise.race([new Promise((r) => server!.child.once('exit', r)), sleep(3_000)])
  }
  await isolated.cleanup()
}
