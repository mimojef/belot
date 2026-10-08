/**
 * checkReactionCountdownBrowser.ts
 *
 * Real browser (Playwright/Chromium), real production code, real DOM —
 * доказателство, че countdown лентата на "Време за реакция" реално изтича за
 * избраните 5 / 10 / 15 секунди и е синхронизирана със server deadline-а.
 *
 * Веригата е изцяло production код, без мокнати таймери:
 *   реален сървър (createServerRoom -> game loop -> createRoomSnapshotMessage)
 *   -> JSON -> fake WebSocket транспорт
 *   -> реален createGameServerClient (onmessage + server clock sample)
 *   -> реален createActiveRoomFlowController -> DOM + CSS анимация.
 * Измерва се самата анимация: Web Animations API timing (duration/delay/
 * currentTime) и computed transform scaleX на лентата във времето.
 *
 * L = еднопосочната латентност на доставката, оценена от клиента
 * (= -skew - clockOffset). Лентата трябва да стигне 0 в deadline + L —
 * т.е. по authoritative deadline-а, без собствено отброяване.
 *
 * Покрива:
 *  [A] desktop 1440x900: cutting/bidding/playing x 5/10/15s — пълна
 *      продължителност, позиция в началото/средата/края, 0 точно в
 *      deadline-а; звуковото предупреждение започва при прага (не веднага).
 *  [B] refresh (page.reload) по средата — лентата продължава от реалното
 *      оставащо време, не от 100%.
 *  [C] следващ играч (bidding, playing) — новата лента започва пълна за
 *      новия deadline, старата се изключва.
 *  [D] бот — сървърният таймер е 800ms, лентата на бота не е "5/10/15s
 *      чакане" и стартира пълна (непроменена презентация).
 *  [E] разместен клиентски часовник (+37s / -23s) — позицията следва
 *      сървърното време.
 *  [F] mobile 390x844 — същото като [A] за трите фази x 5/10/15s.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import {
  advanceBiddingToNextSeat,
  advancePlayingToNextSeat,
  buildRoomAtPhase,
  getActiveSeat,
  handCurrentSeatToBot,
  restartCurrentTurn,
  snapshotJson,
  stateOf,
  type FixturePhase,
  type Seat,
  type ServerRoom,
} from './fixtures/reactionCountdownServerFixtures.ts'

let passed = 0
let failed = 0
const report: string[] = []

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
const TOTALS = [5000, 10000, 15000] as const
const PHASES: FixturePhase[] = ['cutting', 'bidding', 'playing']
const POSITION_TOLERANCE = 0.03
const END_TOLERANCE_MS = 80
const WARNING_THRESHOLD_MS: Record<number, number> = { 5000: 2333, 10000: 4667, 15000: 7000 }

type Fill = {
  seat: string | null
  active: boolean
  key: string | null
  inlineStyle: string
  durationMs: number | null
  delayMs: number | null
  currentTime: number | null
  scaleX: number
  endsAtRealMs: number | null
  readAtRealMs: number
}

type Session = {
  label: string
  page: Page
  phase: FixturePhase
  total: number
  skewMs: number
  room: ServerRoom
  seat: Seat
  freshDeliveredAt: number
}

let baseUrl = ''
let browser: Browser | null = null

async function readFills(page: Page): Promise<Fill[]> {
  return page.evaluate(() => (window as any).__reactionCountdownHarness.readFills())
}

async function latencyMs(session: Session): Promise<number> {
  const offset = await session.page.evaluate(() => (window as any).__reactionCountdownHarness.clockOffsetMs())
  return -session.skewMs - offset
}

function deadlineOf(room: ServerRoom): number {
  const deadline = room.game.timerDeadlineAt
  assert(typeof deadline === 'number', 'room has no deadline')
  return deadline as number
}

async function waitForFill(page: Page, seat: Seat, deadline: number, timeoutMs = 20_000): Promise<Fill> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const fill = (await readFills(page)).find(
      (f) => f.seat === seat && f.active && (f.key ?? '').endsWith(`:${deadline}`) && f.durationMs !== null,
    )
    if (fill) return fill
    await sleep(40)
  }
  throw new Error(`no active countdown fill for ${seat} @ deadline ${deadline}`)
}

async function bootPage(page: Page, room: ServerRoom, seat: Seat): Promise<void> {
  await page.waitForFunction(() => (window as any).__reactionCountdownHarness?.ready === true)
  await page.evaluate(([id, s]) => (window as any).__reactionCountdownHarness.mount(id, s, 5000), [room.id, seat] as const)
  await page.evaluate((json) => (window as any).__reactionCountdownHarness.deliver(json), snapshotJson(room, seat))
}

async function openSession(
  contextOptions: BrowserContextOptions,
  phase: FixturePhase,
  total: number,
  skewMs = 0,
): Promise<Session> {
  const context = await browser!.newContext({ ...contextOptions, baseURL: baseUrl })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  ;(page as any).__errors = errors
  await page.goto(`/scripts/fixtures/reactionCountdownBrowserHarness.html?skewMs=${skewMs}`)
  const room = buildRoomAtPhase(phase, total === 15000 && phase === 'cutting' ? undefined : total)
  const seat = getActiveSeat(room)
  await bootPage(page, room, seat)
  // Warm-up: клиентът минава през catch-up анимациите (цепене/раздаване).
  await waitForFill(page, seat, deadlineOf(room))
  return { label: `${phase} ${total / 1000}s`, page, phase, total, skewMs, room, seat, freshDeliveredAt: 0 }
}

// Нов ход за същия seat от СЕГА (реален сървърен път) -> доставка.
async function deliverFreshTurn(session: Session): Promise<Fill> {
  session.room = restartCurrentTurn(session.room)
  session.freshDeliveredAt = Date.now()
  await session.page.evaluate(
    (json) => (window as any).__reactionCountdownHarness.deliver(json),
    snapshotJson(session.room, session.seat),
  )
  return waitForFill(session.page, session.seat, deadlineOf(session.room))
}

function expectedFraction(deadline: number, latency: number, total: number, atRealMs: number): number {
  return Math.min(1, Math.max(0, (deadline + latency - atRealMs) / total))
}

async function sampleAt(session: Session, atRealMs: number): Promise<Fill> {
  await sleep(atRealMs - Date.now())
  const fill = (await readFills(session.page)).find((f) => f.seat === session.seat)
  assert(fill !== undefined, `${session.label}: fill disappeared`)
  return fill!
}

// [A]/[F] Пълно изтичане на свежа лента.
async function verifyFullDrain(session: Session, opts: { checkAudio: boolean }): Promise<string> {
  const fresh = await deliverFreshTurn(session)
  const state = stateOf(session.room)
  const deadline = deadlineOf(session.room)
  const startedAt = state.timer.startedAt as number
  const L = await latencyMs(session)

  assert(state.timer.durationMs === session.total, `server durationMs=${state.timer.durationMs}`)
  assert(fresh.durationMs === session.total, `CSS animation-duration=${fresh.durationMs}, expected ${session.total}`)
  assert(
    fresh.inlineStyle.includes(`belot-active-room-cutting-countdown ${session.total}ms linear`),
    'inline style does not carry the configured duration',
  )
  assert(L >= -20 && L <= 600, `implausible delivery latency ${L}ms`)
  const endError = (fresh.endsAtRealMs as number) - (deadline + L)
  assert(Math.abs(endError) <= END_TOLERANCE_MS, `animation end off by ${Math.round(endError)}ms vs deadline+L`)
  const freshExpected = expectedFraction(deadline, L, session.total, fresh.readAtRealMs)
  assert(
    Math.abs(fresh.scaleX - freshExpected) <= POSITION_TOLERANCE,
    `start scaleX ${fresh.scaleX.toFixed(3)} vs expected ${freshExpected.toFixed(3)}`,
  )

  const mid = await sampleAt(session, startedAt + session.total / 2)
  const midExpected = expectedFraction(deadline, L, session.total, mid.readAtRealMs)
  assert(
    Math.abs(mid.scaleX - midExpected) <= POSITION_TOLERANCE,
    `mid scaleX ${mid.scaleX.toFixed(3)} vs expected ${midExpected.toFixed(3)}`,
  )

  const beforeEnd = await sampleAt(session, deadline - 250)
  assert(beforeEnd.scaleX > 0.005, `bar already empty 250ms before deadline (scaleX=${beforeEnd.scaleX})`)

  const afterEnd = await sampleAt(session, deadline + L + 150)
  assert(afterEnd.scaleX <= 0.005, `bar not empty after deadline (scaleX=${afterEnd.scaleX})`)

  if (opts.checkAudio) {
    const calls: Array<{ at: number; shouldPlay: boolean }> = await session.page.evaluate(() =>
      (window as any).__reactionCountdownHarness.audioCalls(),
    )
    const afterFresh = calls.filter((c) => c.at >= session.freshDeliveredAt + 300)
    const firstTrue = afterFresh.find((c) => c.shouldPlay)
    assert(firstTrue !== undefined, 'countdown warning never started')
    const expectedStart = deadline + L - WARNING_THRESHOLD_MS[session.total]
    const startError = firstTrue!.at - expectedStart
    assert(startError >= -250 && startError <= 450, `warning started ${Math.round(startError)}ms off the threshold`)
    assert(firstTrue!.at - startedAt >= 1000, 'warning started immediately with the turn')
  }

  const drainMs = Math.round((fresh.endsAtRealMs as number) - (startedAt + L))
  return `${session.label}: duration=${fresh.durationMs}ms, drain=${drainMs}ms, end-vs-deadline=${Math.round(endError + L)}ms (L=${Math.round(L)}ms), start=${fresh.scaleX.toFixed(3)} mid=${mid.scaleX.toFixed(3)} end=${afterEnd.scaleX.toFixed(3)}`
}

async function closeSession(session: Session): Promise<void> {
  const errors: string[] = (session.page as any).__errors ?? []
  await session.page.context().close()
  assert(errors.length === 0, `${session.label}: page errors: ${errors.join(' | ')}`)
}

const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } }
const MOBILE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }

console.log('\n═══ checkReactionCountdownBrowser ═══\n')

let vite: ViteDevServer | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({
    root: process.cwd(),
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
  })
  await vite.listen()
  baseUrl = `http://127.0.0.1:${port}`
  browser = await chromium.launch()

  for (const [viewportLabel, contextOptions, checkAudio] of [
    ['desktop', DESKTOP, true],
    ['mobile', MOBILE, false],
  ] as const) {
    const sessions = await Promise.all(
      PHASES.flatMap((phase) => TOTALS.map((total) => openSession(contextOptions, phase, total))),
    )
    await Promise.all(
      sessions.map((session) =>
        check(`[${viewportLabel === 'desktop' ? 'A' : 'F'}] ${viewportLabel} ${session.label}: bar drains in exactly ${session.total / 1000}s and hits 0 at the server deadline`, async () => {
          report.push(`${viewportLabel} ${await verifyFullDrain(session, { checkAudio })}`)
          await closeSession(session)
        }),
      ),
    )
  }

  // [B] Refresh по средата на отброяването.
  {
    const sessions = await Promise.all(PHASES.flatMap((phase) => TOTALS.map((total) => openSession(DESKTOP, phase, total))))
    await Promise.all(
      sessions.map((session) =>
        check(`[B] refresh mid-countdown ${session.label}: resumes from the real remaining time, not 100%`, async () => {
          await deliverFreshTurn(session)
          const deadline = deadlineOf(session.room)
          const startedAt = stateOf(session.room).timer.startedAt as number
          await sleep(startedAt + session.total * 0.4 - Date.now())
          await session.page.reload()
          await bootPage(session.page, session.room, session.seat)
          const fill = await waitForFill(session.page, session.seat, deadline)
          const L = await latencyMs(session)
          const expected = expectedFraction(deadline, L, session.total, fill.readAtRealMs)
          assert(fill.durationMs === session.total, `duration after refresh ${fill.durationMs}`)
          assert(
            Math.abs(fill.scaleX - expected) <= POSITION_TOLERANCE,
            `after refresh scaleX ${fill.scaleX.toFixed(3)} vs expected ${expected.toFixed(3)}`,
          )
          assert(expected < 0.7 && fill.scaleX < 0.7, `bar restarted near full after refresh (scaleX=${fill.scaleX.toFixed(3)})`)
          if (fill.readAtRealMs >= deadline + L) {
            // Deadline-ът е изтекъл по време на catch-up анимацията след
            // reload-а — лентата трябва да се появи празна, не да започне отначало.
            assert(fill.scaleX <= 0.005, `deadline passed during catch-up but bar shows ${fill.scaleX}`)
            report.push(`refresh ${session.label}: reloaded at 40%, deadline passed during catch-up -> bar rendered empty (${fill.scaleX.toFixed(3)})`)
          } else {
            const endError = (fill.endsAtRealMs as number) - (deadline + L)
            assert(Math.abs(endError) <= END_TOLERANCE_MS, `after refresh end off by ${Math.round(endError)}ms`)
            report.push(`refresh ${session.label}: reloaded at 40%, bar visible after catch-up at ${fill.scaleX.toFixed(3)} (expected ${expected.toFixed(3)}), end-vs-deadline=${Math.round(endError + L)}ms`)
          }
          await closeSession(session)
        }),
      ),
    )
  }

  // [C] Следващ играч + [D] бот.
  {
    const nextPhases: FixturePhase[] = ['bidding', 'playing']
    const sessions = await Promise.all(nextPhases.flatMap((phase) => TOTALS.map((total) => openSession(DESKTOP, phase, total))))
    await Promise.all(
      sessions.map((session) =>
        check(`[C] next player ${session.label}: new seat bar starts full for its own deadline, previous seat bar stops`, async () => {
          await deliverFreshTurn(session)
          const previousSeat = session.seat
          session.room = session.phase === 'bidding' ? advanceBiddingToNextSeat(session.room) : advancePlayingToNextSeat(session.room)
          const nextSeat = getActiveSeat(session.room)
          assert(nextSeat !== previousSeat, 'turn did not move')
          assert(stateOf(session.room).timer.durationMs === session.total, `next seat server duration ${stateOf(session.room).timer.durationMs}`)
          await session.page.evaluate(
            (json) => (window as any).__reactionCountdownHarness.deliver(json),
            snapshotJson(session.room, previousSeat),
          )
          const deadline = deadlineOf(session.room)
          const fill = await waitForFill(session.page, nextSeat, deadline)
          const L = await latencyMs(session)
          const expected = expectedFraction(deadline, L, session.total, fill.readAtRealMs)
          assert(fill.durationMs === session.total, `next seat duration ${fill.durationMs}`)
          assert(Math.abs(fill.scaleX - expected) <= POSITION_TOLERANCE, `next seat scaleX ${fill.scaleX} vs ${expected}`)
          assert(fill.scaleX >= 0.95, `next seat bar did not start (near) full: ${fill.scaleX}`)
          const previousFill = (await readFills(session.page)).find((f) => f.seat === previousSeat)
          assert(previousFill?.active === false, 'previous seat bar is still active')

          // [D] Ходът се поема от бот -> 800ms сървърен таймер, лентата не е 5/10/15s чакане.
          session.room = handCurrentSeatToBot(session.room)
          const botTimer = stateOf(session.room).timer
          assert(botTimer.durationMs === 800, `bot timer ${botTimer.durationMs}ms, expected 800ms`)
          await session.page.evaluate(
            (json) => (window as any).__reactionCountdownHarness.deliver(json),
            snapshotJson(session.room, previousSeat),
          )
          const botFill = await waitForFill(session.page, nextSeat, deadlineOf(session.room))
          assert(botFill.scaleX >= 0.9, `bot bar should start (near) full, got ${botFill.scaleX}`)
          report.push(`next ${session.label}: ${previousSeat}->${nextSeat} start=${fill.scaleX.toFixed(3)} (previous off); bot takeover server timer=${botTimer.durationMs}ms bar=${botFill.scaleX.toFixed(3)}`)
          await closeSession(session)
        }),
      ),
    )
  }

  // [E] Разместен клиентски часовник.
  {
    const cases: Array<[FixturePhase, number]> = [['cutting', 37_000], ['cutting', -23_000], ['bidding', 37_000], ['playing', -23_000]]
    const sessions = await Promise.all(cases.map(([phase, skew]) => openSession(DESKTOP, phase, 10000, skew)))
    await Promise.all(
      sessions.map((session) =>
        check(`[E] client clock skew ${session.skewMs / 1000}s ${session.label}: bar follows server time`, async () => {
          const fresh = await deliverFreshTurn(session)
          const deadline = deadlineOf(session.room)
          const L = await latencyMs(session)
          const endError = (fresh.endsAtRealMs as number) - (deadline + L)
          assert(Math.abs(endError) <= END_TOLERANCE_MS, `end off by ${Math.round(endError)}ms with skew ${session.skewMs}`)
          const expected = expectedFraction(deadline, L, session.total, fresh.readAtRealMs)
          assert(Math.abs(fresh.scaleX - expected) <= POSITION_TOLERANCE, `scaleX ${fresh.scaleX} vs ${expected}`)
          report.push(`skew ${session.skewMs / 1000}s ${session.label}: end-vs-deadline=${Math.round(endError + L)}ms start=${fresh.scaleX.toFixed(3)}`)
          await closeSession(session)
        }),
      ),
    )
  }
} finally {
  await browser?.close()
  await vite?.close()
}

console.log('\n── measurements ──')
for (const line of report.sort()) console.log(`  ${line}`)
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
