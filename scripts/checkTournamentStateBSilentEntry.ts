/**
 * checkTournamentStateBSilentEntry.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression for
 * a production bug caught by manual browser reproduction of Phase 2 (STATE A
 * -> STATE B -> gameplay): after STATE A (sibling semifinal still
 * in_progress), once the sibling completed, the UI jumped straight to the
 * raw activeRoom attendance screen ("ФИНАЛ" / "Изчакват се играчите" /
 * "Готови: 1 от 4") instead of the lobby-owned STATE B screen
 * ("Класирахте се за финала!" / "Ще играете срещу ... от маса 2" /
 * countdown), even though tournamentAttendance.state was still
 * 'waiting'/'resolved' at that moment (attendance not yet authoritative).
 *
 * ROOT CAUSE (see checkTournamentUnifiedTransitionTiming.ts's "ROOT CAUSE"
 * check for the direct unit-level proof): server/src/protocol/
 * parseClientMessage.ts rebuilt the validated resume_room ClientMessage
 * WITHOUT copying the client-sent `silent` field through, so the server
 * ALWAYS replied room_resumed (navigation) instead of room_attached_silent —
 * regardless of what the client actually sent. main.ts's
 * `room_resumed && !activeRoom.hasActiveRoom()` handler then called
 * enterActiveRoomFromResume() immediately, well before attendance resolved,
 * showing the raw card. Silent attach itself (armPendingTournamentSilentEntry
 * + the room_snapshot readiness gate in createActiveRoomFlowController.ts)
 * was correct all along — the wire protocol just never carried the flag.
 *
 * Fix: parseClientMessage.ts now copies `silent: parsed.silent === true`
 * into the parsed resume_room message.
 *
 * This file specifically proves the CLIENT-side control-flow ownership
 * downstream of a (now-correctly-delivered) silent attach — tested at
 * createActiveRoomFlowController level (not through main.ts WS routing, nor
 * source-fragment assertions — a real browser reproduction is exactly what
 * caught this, so this test drives the real controller with real
 * armPendingTournamentSilentEntry()/handleServerMessage() calls and reads
 * the real rendered DOM):
 *
 *  [1] silently armed + attendance snapshot state='waiting': activeRoom does
 *      NOT take over — hasActiveRoom() stays false, root DOM untouched (so
 *      whatever the lobby has rendered — STATE B in production — is left
 *      alone). enterActiveRoomFromResume is NOT called.
 *  [2] same, state='resolved' (attendance decided but game not started yet):
 *      still no takeover.
 *  [3] state='started': activeRoom takes over exactly once —
 *      hasActiveRoom() becomes true, the raw attendance card never rendered
 *      at any point leading up to this.
 *  [4] repeated 'started'/'completed' snapshots afterward do not re-trigger
 *      entry or regress back to the attendance card (structural exactly-once
 *      — the entry condition requires activeRoomState === null, which is no
 *      longer true after [3]).
 *  [5] state='completed' (walkover/already-resolved terminal case) is
 *      likewise accepted as a valid entry trigger on its own, mirroring the
 *      existing in-room attendance-card gate.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

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
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
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

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no free port'))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

type H = {
  armSilentEntry: (roomId: string) => Promise<void>
  sendWaitingSnapshot: (roomId: string, missingCount?: number) => Promise<void>
  sendResolvedSnapshot: (roomId: string) => Promise<void>
  sendStartedSnapshot: (roomId: string, phase?: 'cutting' | 'playing') => Promise<void>
  sendCompletedSnapshot: (roomId: string) => Promise<void>
  hasActiveRoom: () => Promise<boolean>
  rawAttendanceCardVisible: () => Promise<boolean>
  domHasContent: () => Promise<boolean>
  getShowLobbyCalls: () => Promise<number>
  reset: () => Promise<void>
}

async function harness(page: Page): Promise<H> {
  const w = '__tournamentStateBSilentEntryHarness'
  return {
    armSilentEntry: (roomId) => page.evaluate(([k, r]: any) => (window as any)[k].armSilentEntry(r), [w, roomId] as any),
    sendWaitingSnapshot: (roomId, missingCount) =>
      page.evaluate(([k, args]: any) => (window as any)[k].sendWaitingSnapshot(...args), [w, [roomId, missingCount]] as any),
    sendResolvedSnapshot: (roomId) => page.evaluate(([k, r]: any) => (window as any)[k].sendResolvedSnapshot(r), [w, roomId] as any),
    sendStartedSnapshot: (roomId, phase) =>
      page.evaluate(([k, args]: any) => (window as any)[k].sendStartedSnapshot(...args), [w, [roomId, phase]] as any),
    sendCompletedSnapshot: (roomId) => page.evaluate(([k, r]: any) => (window as any)[k].sendCompletedSnapshot(r), [w, roomId] as any),
    hasActiveRoom: () => page.evaluate((k: any) => (window as any)[k].hasActiveRoom(), w),
    rawAttendanceCardVisible: () => page.evaluate((k: any) => (window as any)[k].rawAttendanceCardVisible(), w),
    domHasContent: () => page.evaluate((k: any) => (window as any)[k].domHasContent(), w),
    getShowLobbyCalls: () => page.evaluate((k: any) => (window as any)[k].getShowLobbyCalls(), w),
    reset: () => page.evaluate((k: any) => (window as any)[k].reset(), w),
  }
}

console.log('\n═══ checkTournamentStateBSilentEntry ═══\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({
    root: process.cwd(),
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
  })
  await vite.listen()

  browser = await chromium.launch()
  const baseUrl = `http://127.0.0.1:${port}`

  const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/scripts/fixtures/tournamentStateBSilentEntryHarness.html')
  const h = await harness(page)

  await check('[1/2] silently armed + attendance waiting/resolved: no takeover, STATE B (lobby) left undisturbed, enterActiveRoomFromResume NOT called', async () => {
    await h.reset()
    await h.armSilentEntry('final-room')
    await h.sendWaitingSnapshot('final-room', 3)
    assert((await h.hasActiveRoom()) === false, 'hasActiveRoom() became true while attendance was still "waiting" — premature navigation')
    assert((await h.domHasContent()) === false, 'activeRoom rendered SOMETHING into the shared root while attendance was "waiting" — would clobber the lobby STATE B screen in production')
    assert((await h.rawAttendanceCardVisible()) === false, 'raw attendance card leaked while attendance was "waiting"')

    await h.sendResolvedSnapshot('final-room')
    assert((await h.hasActiveRoom()) === false, 'hasActiveRoom() became true while attendance was "resolved" (still not started) — premature navigation')
    assert((await h.domHasContent()) === false, 'activeRoom rendered SOMETHING into the shared root while attendance was "resolved"')
  })

  await check('[3] attendance snapshot state="started": activeRoom takes over exactly once, no attendance-card flash on the way', async () => {
    await h.sendStartedSnapshot('final-room', 'cutting')
    assert((await h.hasActiveRoom()) === true, 'hasActiveRoom() did not become true once attendance reached "started" — silent entry never happened (the original bug in reverse) or the fix regressed it')
    assert((await h.rawAttendanceCardVisible()) === false, 'raw attendance card is visible even at state="started" — should already be gameplay UI, not the waiting card')
  })

  await check('[4] repeated started/completed pushes afterward do not re-enter or regress back to the attendance card (structural exactly-once)', async () => {
    await h.sendStartedSnapshot('final-room', 'playing')
    assert((await h.hasActiveRoom()) === true, 'hasActiveRoom() flipped back to false on a later snapshot — unexpected leave/reset')
    assert((await h.rawAttendanceCardVisible()) === false, 'attendance card reappeared after a later started snapshot — re-entry regression')

    await h.sendCompletedSnapshot('final-room')
    assert((await h.hasActiveRoom()) === true, 'hasActiveRoom() flipped to false on a completed snapshot')
    assert((await h.rawAttendanceCardVisible()) === false, 'attendance card reappeared on a completed snapshot')

    // Idempotency of the arm call itself post-entry — must not throw or
    // disturb the already-entered room.
    await h.armSilentEntry('final-room')
    assert((await h.hasActiveRoom()) === true, 'a redundant armSilentEntry call after entry disturbed activeRoomState')
  })

  await check('[5] a fresh room reaching state="completed" directly (walkover-style, no prior "started") is also a valid entry trigger', async () => {
    // Genuinely fresh module state (activeRoomState starts null) — the
    // silent-entry gate requires activeRoomState === null by design (it must
    // never clobber an already-entered room), so this scenario needs a real
    // fresh page, not just a DOM/state reset within the same controller
    // instance (checks [1]-[4] above deliberately share one instance to also
    // prove exactly-once ACROSS a sequence of pushes for the SAME room).
    await page.goto('/scripts/fixtures/tournamentStateBSilentEntryHarness.html')
    const fresh = await harness(page)
    assert((await fresh.hasActiveRoom()) === false, 'sanity: fresh page load should start with no active room')
    await fresh.armSilentEntry('walkover-final-room')
    await fresh.sendCompletedSnapshot('walkover-final-room')
    assert((await fresh.hasActiveRoom()) === true, 'state="completed" (e.g. walkover-resolved) did not trigger entry on its own')
    assert((await fresh.rawAttendanceCardVisible()) === false, 'attendance card visible for a state="completed" entry')
  })

  await check('Няма JS грешки в конзолата през целия сценарий', () => {
    assert(errors.length === 0, `console errors: ${errors.join('; ')}`)
  })

  await context.close()

  console.log('\n' + '═'.repeat(64))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exit(1)
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}
