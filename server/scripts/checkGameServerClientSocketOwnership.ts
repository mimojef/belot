// checkGameServerClientSocketOwnership.ts
//
// Focused tests for the WebSocket disconnect-lifecycle hardening in
// src/app/network/createGameServerClient.ts (socket-instance ownership guard
// + bounded diagnostic disconnect reason). Root cause under test: the OLD
// connect()/disconnect() implementation used a single shared `socket`
// closure variable, and each listener (open/close/error/message) mutated it
// unconditionally — a STALE event from a SUPERSEDED socket (e.g. a delayed
// close arriving after a newer connect() already replaced `socket`) could
// null out the CURRENT live connection and fire lifecycle callbacks that no
// longer apply to it.
//
// Real `ws` WebSocketServer (this file lives in server/scripts/, where `ws`
// is an actual dependency — see server/package.json) + Node's own native
// global `WebSocket` client (Node 22+, undici-backed, browser-compatible) —
// NOT a hand-rolled fake WebSocket. createGameServerClient.ts is imported
// directly via a relative path (mirrors the established cross-boundary test
// pattern already used by root scripts/checkEmailRegistrationVerificationLink.ts,
// which imports server modules the same way in reverse).
//
// To deterministically prove the STALE-EVENT-ownership guard (cases 1-3),
// this suite temporarily wraps the global `WebSocket` constructor so it can
// capture a direct reference to each REAL socket instance createGameServerClient
// creates internally (connect() never exposes them) — then synthetically
// dispatches a close/message/error/open Event directly on the SUPERSEDED
// instance, fully bypassing real-network timing races. This is not mocking
// WebSocket itself — TrackedWebSocket extends the real implementation and
// delegates everything to it; only instance CAPTURE is intercepted.

import { createServer as createNetServer } from 'node:net'
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws'
import { createGameServerClient, type ServerMessage } from '../../src/app/network/createGameServerClient.js'

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

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(`Timeout waiting for: ${label}`)
}

console.log('\ncheckGameServerClientSocketOwnership\n')

const port = await freePort()
const url = `ws://127.0.0.1:${port}`
const wss = new WebSocketServer({ port })
const serverSockets: WsWebSocket[] = []
wss.on('connection', (serverSocket) => {
  serverSockets.push(serverSocket)
})
await new Promise<void>((resolve) => wss.once('listening', resolve))

// ─── WebSocket instance tracking (for stale-event injection, cases 1-3) ────
const RealWebSocket = globalThis.WebSocket
if (typeof RealWebSocket !== 'function') {
  throw new Error('Native global WebSocket is not available in this Node runtime — required for this test.')
}
const createdClientSockets: WebSocket[] = []
class TrackedWebSocket extends RealWebSocket {
  constructor(wsUrl: string | URL, protocols?: string | string[]) {
    super(wsUrl, protocols)
    createdClientSockets.push(this as unknown as WebSocket)
  }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = TrackedWebSocket

try {
  // ═══════════════════════════════════════════════════════════════════
  // [1] stale close от socket A след създаден socket B НЕ занулява B.
  // ═══════════════════════════════════════════════════════════════════
  {
    const onCloseCalls: number[] = []
    const client = createGameServerClient({
      url,
      onClose: () => onCloseCalls.push(Date.now()),
    })
    client.connect()
    await waitUntil(() => client.isConnected(), 5_000, 'socket A open')
    assert(createdClientSockets.length === 1, `expected exactly 1 created socket after first connect(), got ${createdClientSockets.length}`)
    const socketA = createdClientSockets[0]!

    // disconnect() no longer nulls the shared socket synchronously — this
    // lets connect() proceed immediately (readyState is CLOSING, not
    // OPEN/CONNECTING), creating socket B WITHOUT waiting for A's real close
    // event — exactly the production race window.
    client.disconnect('test_stale_close')
    client.connect()
    await waitUntil(() => createdClientSockets.length === 2, 5_000, 'socket B created')
    await waitUntil(() => client.isConnected(), 5_000, 'socket B open')
    const socketB = createdClientSockets[1]!
    assert(socketA !== socketB, 'sanity: A and B must be different instances')

    const onCloseCountBeforeStaleEvent = onCloseCalls.length

    // Synthetically dispatch a LATE close event directly on the superseded
    // socket A — simulates A's real close handshake finally completing after
    // B has already taken over. Ownership guard must ignore it.
    socketA.dispatchEvent(new CloseEvent('close', { code: 1000, reason: 'late_stale_close', wasClean: true }))
    await sleep(50)

    await check('[1] stale close from A (after B exists) does NOT null out B — isConnected() still true', async () => {
      assert(client.isConnected(), 'B should still be reported as connected after a stale close from A')
    })
    await check('[1b] stale close from A does NOT re-invoke onClose (guard skipped it, not a real B close)', async () => {
      assert(onCloseCalls.length === onCloseCountBeforeStaleEvent, `onClose should not have fired for a stale A close, call count went from ${onCloseCountBeforeStaleEvent} to ${onCloseCalls.length}`)
    })

    client.disconnect()
    await sleep(50)
  }

  // ═══════════════════════════════════════════════════════════════════
  // [2] stale message от A не стига до onMessage, докато B е current.
  // ═══════════════════════════════════════════════════════════════════
  {
    createdClientSockets.length = 0
    const receivedMessages: ServerMessage[] = []
    const client = createGameServerClient({
      url,
      onMessage: (m) => receivedMessages.push(m),
    })
    client.connect()
    await waitUntil(() => client.isConnected(), 5_000, 'socket A open')
    const socketA = createdClientSockets[0]!

    client.disconnect('test_stale_message')
    client.connect()
    await waitUntil(() => createdClientSockets.length === 2, 5_000, 'socket B created')
    await waitUntil(() => client.isConnected(), 5_000, 'socket B open')

    const messageCountBefore = receivedMessages.length

    // Synthetic MessageEvent dispatched directly on the SUPERSEDED socket A —
    // proves a message arriving on a no-longer-current socket is never
    // treated as belonging to "the current connection".
    socketA.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'pong' }) }))
    await sleep(50)

    await check('[2] stale message from A does NOT reach onMessage', async () => {
      assert(receivedMessages.length === messageCountBefore, `onMessage should not have been called for a stale A message, count went from ${messageCountBefore} to ${receivedMessages.length}`)
    })

    client.disconnect()
    await sleep(50)
  }

  // ═══════════════════════════════════════════════════════════════════
  // [3] stale error/open от A не влияе на B.
  // ═══════════════════════════════════════════════════════════════════
  {
    createdClientSockets.length = 0
    let onOpenCalls = 0
    let onErrorCalls = 0
    const client = createGameServerClient({
      url,
      onOpen: () => { onOpenCalls += 1 },
      onError: () => { onErrorCalls += 1 },
    })
    client.connect()
    await waitUntil(() => client.isConnected(), 5_000, 'socket A open')
    const socketA = createdClientSockets[0]!

    client.disconnect('test_stale_error_open')
    client.connect()
    await waitUntil(() => createdClientSockets.length === 2, 5_000, 'socket B created')
    await waitUntil(() => client.isConnected(), 5_000, 'socket B open')

    const onOpenCountBefore = onOpenCalls
    const onErrorCountBefore = onErrorCalls

    socketA.dispatchEvent(new Event('error'))
    socketA.dispatchEvent(new Event('open'))
    await sleep(50)

    await check('[3] stale error from A does NOT invoke onError', async () => {
      assert(onErrorCalls === onErrorCountBefore, `onError should not have fired for a stale A error, count went from ${onErrorCountBefore} to ${onErrorCalls}`)
    })
    await check('[3b] stale open from A does NOT invoke onOpen again', async () => {
      assert(onOpenCalls === onOpenCountBefore, `onOpen should not have fired again for a stale A open, count went from ${onOpenCountBefore} to ${onOpenCalls}`)
    })
    await check('[3c] B remains connected throughout', async () => {
      assert(client.isConnected(), 'B should still be connected after stale A error/open events')
    })

    client.disconnect()
    await sleep(50)
  }

  // ═══════════════════════════════════════════════════════════════════
  // [4] intentional disconnect() -> точно ЕДИН onClose lifecycle.
  // [5] reconnect след intentional disconnect работи.
  // [6] close reason се подава правилно (проверено server-side, реален WS close frame).
  // ═══════════════════════════════════════════════════════════════════
  {
    createdClientSockets.length = 0
    serverSockets.length = 0
    let onCloseCalls = 0
    const client = createGameServerClient({ url, onClose: () => { onCloseCalls += 1 } })
    client.connect()
    await waitUntil(() => client.isConnected(), 5_000, 'connected')
    await waitUntil(() => serverSockets.length === 1, 5_000, 'server sees the connection')

    const serverSideCloseInfo: Array<{ code: number; reason: string }> = []
    serverSockets[0]!.on('close', (code, reason) => {
      serverSideCloseInfo.push({ code, reason: reason.toString('utf8') })
    })

    client.disconnect('bid_watchdog')
    await waitUntil(() => onCloseCalls === 1, 5_000, 'onClose fired exactly once')
    await sleep(50)

    await check('[4] intentional disconnect() triggers onClose exactly once', async () => {
      assert(onCloseCalls === 1, `expected exactly 1 onClose call, got ${onCloseCalls}`)
    })
    await check('[6] close reason is delivered to the server as the real WS close frame reason (code 1000)', async () => {
      assert(serverSideCloseInfo.length === 1, `expected exactly 1 server-side close event, got ${serverSideCloseInfo.length}`)
      assert(serverSideCloseInfo[0]!.code === 1000, `expected close code 1000, got ${serverSideCloseInfo[0]!.code}`)
      assert(serverSideCloseInfo[0]!.reason === 'bid_watchdog', `expected reason 'bid_watchdog', got '${serverSideCloseInfo[0]!.reason}'`)
    })

    await check('[5] reconnect after intentional disconnect works (new socket opens, onClose does not re-fire)', async () => {
      client.connect()
      await waitUntil(() => client.isConnected(), 5_000, 'reconnected')
      assert(client.isConnected(), 'expected the client to be connected again after connect()')
      assert(onCloseCalls === 1, `onClose must not fire again just from a successful reconnect, still expected 1, got ${onCloseCalls}`)
    })

    client.disconnect()
    await sleep(50)
  }

  // ═══════════════════════════════════════════════════════════════════
  // [7] normal unexpected network close (server-initiated, no client
  // disconnect() call) still triggers onClose.
  // ═══════════════════════════════════════════════════════════════════
  {
    createdClientSockets.length = 0
    serverSockets.length = 0
    let onCloseCalls = 0
    const client = createGameServerClient({ url, onClose: () => { onCloseCalls += 1 } })
    client.connect()
    await waitUntil(() => client.isConnected(), 5_000, 'connected')
    await waitUntil(() => serverSockets.length === 1, 5_000, 'server sees the connection')

    // Server abruptly terminates — no clean closing handshake, mirrors real
    // "abnormal close" network loss (the client-visible code is typically
    // 1006 for a non-clean termination).
    serverSockets[0]!.terminate()

    await check('[7] an unexpected server-initiated close still triggers onClose (not swallowed by the ownership guard)', async () => {
      await waitUntil(() => onCloseCalls === 1, 5_000, 'onClose fired for unexpected close')
      assert(onCloseCalls === 1, `expected exactly 1 onClose call for an unexpected close, got ${onCloseCalls}`)
      assert(!client.isConnected(), 'client should report disconnected after an unexpected close')
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // [8] close reason byte-safety — WebSocket spec: reason, UTF-8 encoded,
  // must be ≤123 bytes or close() throws a SyntaxError SYNCHRONOUSLY.
  // String.prototype.slice() counts UTF-16 code units, not UTF-8 bytes — a
  // reason with enough non-ASCII characters could exceed the limit even
  // after character-count truncation. Proves disconnect() never throws and
  // the byte-bounded reason that actually reaches the wire stays ≤123 bytes,
  // for both a "wide" multi-byte reason (Cyrillic) and an astral-plane
  // (surrogate-pair) reason.
  // ═══════════════════════════════════════════════════════════════════
  {
    createdClientSockets.length = 0
    serverSockets.length = 0
    const client = createGameServerClient({ url })
    client.connect()
    await waitUntil(() => client.isConnected(), 5_000, 'connected')
    await waitUntil(() => serverSockets.length === 1, 5_000, 'server sees the connection')

    const serverSideCloseInfo: Array<{ code: number; reasonBytes: number }> = []
    serverSockets[0]!.on('close', (code, reason) => {
      serverSideCloseInfo.push({ code, reasonBytes: reason.byteLength })
    })

    // 100 Cyrillic characters (2 UTF-8 bytes each) — 200 bytes if truncated
    // by character count alone, far over the 123-byte wire limit.
    const wideReason = 'диагностика '.repeat(9)
    await check('[8] disconnect() does not throw for a wide (multi-byte) reason, and the wire-level reason stays within the WebSocket 123-byte limit', async () => {
      let threw: unknown = null
      try {
        client.disconnect(wideReason)
      } catch (err) {
        threw = err
      }
      assert(threw === null, `disconnect() must never throw for an oversized non-ASCII reason, got: ${threw instanceof Error ? threw.message : String(threw)}`)
      await waitUntil(() => serverSideCloseInfo.length === 1, 5_000, 'server observed the close')
      assert(serverSideCloseInfo[0]!.reasonBytes <= 123, `wire-level close reason must be ≤123 bytes (WebSocket spec hard limit), got ${serverSideCloseInfo[0]!.reasonBytes}`)
    })

    client.connect()
    await waitUntil(() => client.isConnected(), 5_000, 'reconnected for astral-plane case')
    await waitUntil(() => serverSockets.length === 2, 5_000, 'server sees the second connection')
    serverSideCloseInfo.length = 0
    serverSockets[1]!.on('close', (code, reason) => {
      serverSideCloseInfo.push({ code, reasonBytes: reason.byteLength })
    })

    // 100 astral-plane emoji (4 UTF-8 bytes each, surrogate pairs in UTF-16) —
    // also proves codepoint-safe truncation never splits a surrogate pair.
    const astralReason = '🔥'.repeat(100)
    await check('[8b] disconnect() does not throw for an astral-plane (surrogate-pair) reason either, and stays within the byte limit', async () => {
      let threw: unknown = null
      try {
        client.disconnect(astralReason)
      } catch (err) {
        threw = err
      }
      assert(threw === null, `disconnect() must never throw for an oversized astral-plane reason, got: ${threw instanceof Error ? threw.message : String(threw)}`)
      await waitUntil(() => serverSideCloseInfo.length === 1, 5_000, 'server observed the close')
      assert(serverSideCloseInfo[0]!.reasonBytes <= 123, `wire-level close reason must be ≤123 bytes, got ${serverSideCloseInfo[0]!.reasonBytes}`)
    })
  }

  console.log('\n' + '═'.repeat(72))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = RealWebSocket
  await new Promise<void>((resolve) => wss.close(() => resolve()))
}
