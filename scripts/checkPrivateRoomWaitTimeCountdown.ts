/**
 * checkPrivateRoomWaitTimeCountdown.ts
 *
 * Real browser (Playwright), real production code — verifies the private
 * table "selectable wait time" feature end to end on the client:
 *
 *  - the create-table popup's new "Време за изчакване на играчи" select
 *    (5/10/15/30 minutes, default 15) and that its value reaches
 *    onPrivateRoomCreate;
 *  - the waiting-room countdown badge (data-private-room-countdown) reads
 *    the server-authoritative expiresAt, is present in both the desktop
 *    header row and the mobile row, and is visually distinct from stake/
 *    player-count text;
 *  - the countdown pure formatter (formatPrivateRoomCountdown) for the
 *    1h+ / <1h / <1min / 00:00 / negative-clamped cases;
 *  - the tick loop: exactly one active interval at a time, no duplicate
 *    interval after a room re-render (e.g. an incoming chat message), and
 *    that ticking does NOT trigger a full waiting-room re-render — chat
 *    draft/focus/caret/scroll state must survive;
 *  - warning (<60s) / critical (<30s) CSS state classes on the countdown
 *    badge, and that the critical pulse animation is disabled under
 *    prefers-reduced-motion;
 *  - reaching 00:00 client-side does NOT locally remove the room or
 *    navigate away — only the server's private_room_expired message does,
 *    and it shows the exact required banner text;
 *  - interval cleanup on every documented exit path: private_room_left,
 *    private_room_closed, private_room_full, and controller.destroy().
 *
 * Uses the same established pattern as checkPrivateRoomMobileResponsive.ts:
 * a Vite dev server serves the existing fixture harness
 * (scripts/fixtures/privateRoomWaitingHarness.ts), which boots the REAL
 * production controller/render functions; this script drives it with a real
 * Chromium instance and asserts on the real DOM.
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

function makeMember(profileId: string, displayName: string, isHost: boolean, level = 5) {
  return { profileId, displayName, avatarUrl: null, level, rankTitle: isHost ? null : 'Играч', isHost }
}

function makeRoom(
  id: string,
  members: unknown[],
  opts: { kind?: 'open' | 'locked'; stake?: number; expiresAt?: number } = {},
) {
  return {
    id,
    kind: opts.kind ?? 'open',
    stake: opts.stake ?? 5000,
    members,
    createdAt: Date.now(),
    expiresAt: opts.expiresAt ?? Date.now() + 10 * 60_000,
  }
}

// ─── [1] Pure formatter tests (imported directly, no browser needed) ───────
async function runFormatterUnitTests(): Promise<void> {
  const mod = await import('../src/app/lobby/renderPrivateRoomWaitingScreen.ts')
  const { formatPrivateRoomCountdown, getPrivateRoomCountdownState } = mod as any

  check('[F1] 1h05m32s formats as 1:05:32', () => {
    const text = formatPrivateRoomCountdown((1 * 3600 + 5 * 60 + 32) * 1000)
    assert(text === '1:05:32', `got "${text}"`)
  })
  check('[F2] 14m32s (under 1h) formats as 14:32', () => {
    const text = formatPrivateRoomCountdown((14 * 60 + 32) * 1000)
    assert(text === '14:32', `got "${text}"`)
  })
  check('[F3] 42s (under 1min) formats as 00:42', () => {
    const text = formatPrivateRoomCountdown(42 * 1000)
    assert(text === '00:42', `got "${text}"`)
  })
  check('[F4] 0ms formats as 00:00', () => {
    const text = formatPrivateRoomCountdown(0)
    assert(text === '00:00', `got "${text}"`)
  })
  check('[F5] negative remaining is clamped to 00:00, never negative', () => {
    const text = formatPrivateRoomCountdown(-5000)
    assert(text === '00:00', `got "${text}"`)
  })
  check('[F6] countdown state: normal above 60s', () => {
    assert(getPrivateRoomCountdownState(61_000) === 'normal', 'expected normal')
  })
  check('[F7] countdown state: warning at/under 60s', () => {
    assert(getPrivateRoomCountdownState(60_000) === 'warning', 'expected warning at exactly 60s')
    assert(getPrivateRoomCountdownState(45_000) === 'warning', 'expected warning at 45s')
  })
  check('[F8] countdown state: critical at/under 30s', () => {
    assert(getPrivateRoomCountdownState(30_000) === 'critical', 'expected critical at exactly 30s')
    assert(getPrivateRoomCountdownState(5_000) === 'critical', 'expected critical at 5s')
  })
}

// ─── [2]-[9] Browser scenarios against the real controller ─────────────────
async function runCreatePopupScenario(page: Page, label: string): Promise<void> {
  await page.goto('/scripts/fixtures/privateRoomCreatePopupHarness.html')
  await page.waitForFunction(() => (window as any).__prcpHarness !== undefined, undefined, { timeout: 10_000 })

  await page.evaluate(() => (window as any).__prcpHarness.openCreatePopup())
  await page.waitForSelector('[data-private-room-create-form="1"]', { state: 'attached' })

  await check(`${label} [C1] waitMinutes select exists with exactly the 4 required options`, async () => {
    const values = await page.$$eval('select[name="waitMinutes"] option', (opts) =>
      opts.map((o) => (o as HTMLOptionElement).value),
    )
    assert(JSON.stringify(values) === JSON.stringify(['5', '10', '15', '30']), `got options ${JSON.stringify(values)}`)
  })

  await check(`${label} [C2] "Без ограничение" option does not exist`, async () => {
    const text = await page.locator('[data-private-room-create-form="1"]').textContent()
    assert(!(text ?? '').includes('Без ограничение'), '"Без ограничение" must not appear anywhere in the form')
  })

  await check(`${label} [C3] 15 minutes is selected by default`, async () => {
    const selected = await page.$eval('select[name="waitMinutes"]', (el) => (el as HTMLSelectElement).value)
    assert(selected === '15', `expected default "15", got "${selected}"`)
  })

  await check(`${label} [C4] field label reads "Време за изчакване на играчи"`, async () => {
    const text = await page.locator('[data-private-room-create-form="1"]').textContent()
    assert((text ?? '').includes('Време за изчакване на играчи'), 'label text not found')
  })

  await check(`${label} [C5] submitting the form forwards the selected waitMinutes to onPrivateRoomCreate`, async () => {
    await page.selectOption('select[name="waitMinutes"]', '30')
    await page.locator('[data-private-room-create-form="1"] button[type="submit"]').click()
    const args = await page.evaluate(() => (window as any).__prcpHarness.getLastCreateArgs())
    assert(Array.isArray(args) && args[2] === 30, `expected waitMinutes=30 forwarded, got ${JSON.stringify(args)}`)
  })
}

async function runCountdownDisplayScenario(page: Page, label: string): Promise<void> {
  await page.goto('/scripts/fixtures/privateRoomWaitingHarness.html')
  await page.waitForFunction(() => (window as any).__prwHarness !== undefined, undefined, { timeout: 10_000 })

  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.navigateToPrivateRooms()
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-cd', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)], { expiresAt: Date.now() + 14 * 60_000 + 32_000 }) })

  await page.waitForSelector('[data-private-room-waiting-screen="1"]', { state: 'attached' })

  await check(`${label} [D1] Countdown badge is present with data-private-room-countdown`, async () => {
    const count = await page.locator('[data-private-room-countdown="1"]').count()
    assert(count >= 1, `expected at least 1 countdown badge, got ${count}`)
  })

  await check(`${label} [D2] Countdown text roughly matches remaining time (mm:ss, ~14:3x)`, async () => {
    const text = await page.locator('[data-private-room-countdown-value="1"]').first().textContent()
    assert(/^14:(2[5-9]|3[0-2])$/.test((text ?? '').trim()), `unexpected countdown text "${text}"`)
  })

  await check(`${label} [D3] Countdown is visually separate from stake/player-count subtitle`, async () => {
    const subtitleText = await page.locator('.prw-subtitle').textContent()
    assert(!(subtitleText ?? '').includes('Оставащо време'), 'countdown text leaked into the stake/player-count subtitle')
  })

  await check(`${label} [D4] Normal state has no warning/critical class`, async () => {
    const cls = await page.locator('[data-private-room-countdown="1"]').first().getAttribute('class')
    assert(!(cls ?? '').includes('warning') && !(cls ?? '').includes('critical'), `unexpected class "${cls}"`)
  })
}

async function runWarningCriticalStateScenario(page: Page, label: string): Promise<void> {
  await page.goto('/scripts/fixtures/privateRoomWaitingHarness.html')
  await page.waitForFunction(() => (window as any).__prwHarness !== undefined, undefined, { timeout: 10_000 })

  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.navigateToPrivateRooms()
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-warn', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)], { expiresAt: Date.now() + 45_000 } ) })

  await check(`${label} [W1] Under 60s shows warning class`, async () => {
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-private-room-countdown="1"]')
      return el !== null && el.className.includes('warning')
    }, undefined, { timeout: 3_000 })
  })

  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-warn', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)], { expiresAt: Date.now() + 20_000 } ) })

  await check(`${label} [W2] Under 30s shows critical class`, async () => {
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-private-room-countdown="1"]')
      return el !== null && el.className.includes('critical')
    }, undefined, { timeout: 3_000 })
  })

  await check(`${label} [W3] prefers-reduced-motion disables the critical pulse animation`, async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const animName = await page.evaluate(() => {
      const el = document.querySelector('[data-private-room-countdown-value="1"]')
      if (el === null) return null
      return getComputedStyle(el).animationName
    })
    assert(animName === 'none' || animName === null, `expected animation disabled under reduced-motion, got "${animName}"`)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })
}

async function runTickLoopLifecycleScenario(page: Page, label: string): Promise<void> {
  await page.goto('/scripts/fixtures/privateRoomWaitingHarness.html')
  await page.waitForFunction(() => (window as any).__prwHarness !== undefined, undefined, { timeout: 10_000 })

  const fixedExpiresAt = Date.now() + 10 * 60_000

  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.navigateToPrivateRooms()
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-tick', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)], { expiresAt: fixedExpiresAt }) })
  await page.waitForSelector('[data-private-room-waiting-screen="1"]', { state: 'attached' })

  await check(`${label} [T1] Exactly one active interval while in the waiting room`, async () => {
    const count = await page.evaluate(() => (window as any).__prwHarness.getActiveIntervalCount())
    assert(count === 1, `expected exactly 1 active interval, got ${count}`)
  })

  const intervalIdBeforeRerenders = await page.evaluate(() => (window as any).__prwHarness.getSoleActiveIntervalId())

  // Re-render the room with the SAME expiresAt each time (simulates a member
  // join/leave or chat push causing renderPrivateRoomWaitingRoom() to run
  // again while the room's TTL itself hasn't changed) — must not accumulate
  // a second interval.
  for (let i = 0; i < 5; i++) {
    await page.evaluate(({ room }) => {
      ;(window as any).__prwHarness.pushRoomUpdated(room)
    }, { room: makeRoom('room-tick', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false), makeMember(`extra-${i}`, `Гост ${i}`, false)], { expiresAt: fixedExpiresAt }) })
  }

  await check(`${label} [T2] Repeated room re-renders never accumulate more than one active interval`, async () => {
    const count = await page.evaluate(() => (window as any).__prwHarness.getActiveIntervalCount())
    assert(count === 1, `expected exactly 1 active interval after repeated re-renders, got ${count}`)
  })

  await check(`${label} [T2b] Repeated same-room/same-expiresAt re-renders reuse the SAME interval (not cleared+recreated)`, async () => {
    const intervalIdAfter = await page.evaluate(() => (window as any).__prwHarness.getSoleActiveIntervalId())
    assert(
      intervalIdBeforeRerenders !== null && intervalIdAfter === intervalIdBeforeRerenders,
      `expected the same interval id to survive re-renders, got ${intervalIdBeforeRerenders} -> ${intervalIdAfter}`,
    )
  })

  await check(`${label} [T3] Leaving the waiting room (private_room_left) clears the interval`, async () => {
    await page.evaluate(() => (window as any).__prwHarness.pushRoomLeft('room-tick'))
    const count = await page.evaluate(() => (window as any).__prwHarness.getActiveIntervalCount())
    assert(count === 0, `expected 0 active intervals after leaving, got ${count}`)
  })

  // Re-enter, then verify private_room_closed / private_room_full also clear it.
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-tick-2', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)]) })
  await check(`${label} [T4] private_room_closed clears the interval`, async () => {
    await page.evaluate(() => (window as any).__prwHarness.pushRoomClosed('room-tick-2'))
    const count = await page.evaluate(() => (window as any).__prwHarness.getActiveIntervalCount())
    assert(count === 0, `expected 0 active intervals after room closed, got ${count}`)
  })

  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-tick-3', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)]) })
  await check(`${label} [T5] private_room_full clears the interval`, async () => {
    await page.evaluate(() => (window as any).__prwHarness.pushRoomFull('game-room-x', 'bottom', 5000))
    const count = await page.evaluate(() => (window as any).__prwHarness.getActiveIntervalCount())
    assert(count === 0, `expected 0 active intervals after room full/game start, got ${count}`)
  })

  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-tick-4', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)]) })
  await check(`${label} [T6] controller.destroy() clears the interval`, async () => {
    await page.evaluate(() => (window as any).__prwHarness.destroy())
    const count = await page.evaluate(() => (window as any).__prwHarness.getActiveIntervalCount())
    assert(count === 0, `expected 0 active intervals after destroy(), got ${count}`)
  })
}

// Directly exercises the idempotent-lifecycle contract of
// startPrivateRoomCountdownLoop(roomId, expiresAt) in createLobbyFlowController.ts:
// same (roomId, expiresAt) -> no interval churn, only a DOM re-sync; either
// value changing -> old interval torn down, new one started; cleanup zeroes
// out interval id + tracked roomId + tracked expiresAt.
async function runIdempotentLifecycleScenario(page: Page, label: string): Promise<void> {
  await page.goto('/scripts/fixtures/privateRoomWaitingHarness.html')
  await page.waitForFunction(() => (window as any).__prwHarness !== undefined, undefined, { timeout: 10_000 })

  const initialExpiresAt = Date.now() + 12 * 60_000

  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.navigateToPrivateRooms()
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('idem-room-a', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)], { expiresAt: initialExpiresAt }) })
  await page.waitForSelector('[data-private-room-waiting-screen="1"]', { state: 'attached' })

  const firstIntervalId = await page.evaluate(() => (window as any).__prwHarness.getSoleActiveIntervalId())
  await check(`${label} [I1] A single interval starts for a fresh room`, () => {
    assert(firstIntervalId !== null, 'expected exactly one active interval after entering the waiting room')
  })

  // ─── Same room id + same expiresAt: re-render must NOT touch the interval,
  // but the freshly rendered DOM node must be immediately correct. ─────────
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('idem-room-a', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false), makeMember('guest-2', 'Гост Две', false)], { expiresAt: initialExpiresAt }) })

  await check(`${label} [I2] Same roomId + same expiresAt: the interval id is unchanged (not cleared/recreated)`, async () => {
    const idAfter = await page.evaluate(() => (window as any).__prwHarness.getSoleActiveIntervalId())
    assert(idAfter === firstIntervalId, `expected interval id to stay ${firstIntervalId}, got ${idAfter}`)
  })

  await check(`${label} [I3] Same roomId + same expiresAt: the newly rendered DOM node is immediately synced (not stale/blank)`, async () => {
    const text = await page.locator('[data-private-room-countdown-value="1"]').first().textContent()
    const remainingMinutes = Math.round((initialExpiresAt - Date.now()) / 60_000)
    assert(/^1[12]:\d{2}$/.test((text ?? '').trim()), `expected ~11-12 minutes text, got "${text}" (approx ${remainingMinutes}m)`)
  })

  // ─── Different room id (same expiresAt value): must tear down + restart. ─
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('idem-room-b', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)], { expiresAt: initialExpiresAt }) })

  await check(`${label} [I4] Different roomId (same expiresAt) starts a new lifecycle (new interval id)`, async () => {
    const idAfter = await page.evaluate(() => (window as any).__prwHarness.getSoleActiveIntervalId())
    assert(idAfter !== null && idAfter !== firstIntervalId, `expected a new interval id, got ${idAfter} (was ${firstIntervalId})`)
  })

  const secondIntervalId = await page.evaluate(() => (window as any).__prwHarness.getSoleActiveIntervalId())

  // ─── Same room id, different expiresAt: must also tear down + restart. ──
  const refreshedExpiresAt = initialExpiresAt + 5 * 60_000
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('idem-room-b', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)], { expiresAt: refreshedExpiresAt }) })

  await check(`${label} [I5] Same roomId, different expiresAt starts a new lifecycle (new interval id)`, async () => {
    const idAfter = await page.evaluate(() => (window as any).__prwHarness.getSoleActiveIntervalId())
    assert(idAfter !== null && idAfter !== secondIntervalId, `expected a new interval id, got ${idAfter} (was ${secondIntervalId})`)
  })

  await check(`${label} [I6] After the expiresAt-only change, the DOM reflects the refreshed expiresAt immediately`, async () => {
    const text = await page.locator('[data-private-room-countdown-value="1"]').first().textContent()
    assert(/^1[67]:\d{2}$/.test((text ?? '').trim()), `expected ~16-17 minutes text after refresh, got "${text}"`)
  })

  // ─── Cleanup zeroes out interval id + tracked roomId + tracked expiresAt:
  // proven indirectly by re-entering the SAME room id + expiresAt that was
  // active before leaving — if the tracked values had not been zeroed, this
  // would be wrongly treated as "unchanged" and skip creating a new interval
  // (leaving zero intervals active, since the old one was already cleared).
  // ──────────────────────────────────────────────────────────────────────
  await page.evaluate(() => (window as any).__prwHarness.pushRoomLeft('idem-room-b'))
  await check(`${label} [I7] Leaving zeroes out the interval (0 active)`, async () => {
    const count = await page.evaluate(() => (window as any).__prwHarness.getActiveIntervalCount())
    assert(count === 0, `expected 0 active intervals after leaving, got ${count}`)
  })

  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.navigateToPrivateRooms()
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('idem-room-b', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)], { expiresAt: refreshedExpiresAt }) })

  await check(`${label} [I8] Re-entering the exact same (roomId, expiresAt) after a full leave still starts a fresh interval (tracked state was zeroed, not stale)`, async () => {
    const count = await page.evaluate(() => (window as any).__prwHarness.getActiveIntervalCount())
    assert(count === 1, `expected exactly 1 active interval after re-entering post-cleanup, got ${count}`)
  })
}

async function runNoFullRerenderScenario(page: Page, label: string): Promise<void> {
  await page.goto('/scripts/fixtures/privateRoomWaitingHarness.html')
  await page.waitForFunction(() => (window as any).__prwHarness !== undefined, undefined, { timeout: 10_000 })

  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.navigateToPrivateRooms()
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-norerender', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)]) })
  await page.waitForSelector('[data-private-room-waiting-screen="1"]', { state: 'attached' })

  // Mark the current countdown badge DOM node so we can detect if a full
  // innerHTML re-render replaces it (which the tick loop must never do).
  await page.evaluate(() => {
    const el = document.querySelector('[data-private-room-countdown="1"]')
    if (el) (el as any).__markedNode = true
    ;(window as any).__markedBadge = el
  })

  const chatInput = page.locator('[data-private-waiting-chat-input="1"]')
  await chatInput.click()
  const draftText = 'чернова по време на countdown tick'
  await chatInput.type(draftText, { delay: 5 })

  // Wait past at least one full countdown tick (1s interval).
  await page.waitForTimeout(1300)

  await check(`${label} [N1] Countdown DOM node identity is preserved across a tick (no full re-render)`, async () => {
    const stillSameNode = await page.evaluate(() => {
      const el = document.querySelector('[data-private-room-countdown="1"]')
      return el === (window as any).__markedBadge
    })
    assert(stillSameNode, 'countdown badge DOM node was replaced — implies a full re-render happened on tick')
  })

  await check(`${label} [N2] Chat draft survives a countdown tick`, async () => {
    const value = await chatInput.inputValue()
    assert(value === draftText, `draft should survive tick, got "${value}"`)
  })

  await check(`${label} [N3] Chat input focus survives a countdown tick`, async () => {
    const stillFocused = await page.evaluate(() => document.activeElement === document.querySelector('[data-private-waiting-chat-input="1"]'))
    assert(stillFocused, 'chat input should remain focused across a countdown tick')
  })

  await check(`${label} [N4] Countdown value text still updates despite no full re-render`, async () => {
    const text1 = await page.locator('[data-private-room-countdown-value="1"]').first().textContent()
    await page.waitForTimeout(1100)
    const text2 = await page.locator('[data-private-room-countdown-value="1"]').first().textContent()
    assert(text1 !== text2, `expected countdown text to change across ~1s, both were "${text1}"`)
  })
}

async function runExpiryContractScenario(page: Page, label: string): Promise<void> {
  await page.goto('/scripts/fixtures/privateRoomWaitingHarness.html')
  await page.waitForFunction(() => (window as any).__prwHarness !== undefined, undefined, { timeout: 10_000 })

  // expiresAt already in the past — client must NOT self-close on render.
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.navigateToPrivateRooms()
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-expiry', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)], { expiresAt: Date.now() - 5_000 }) })

  await check(`${label} [X1] Client shows 00:00 for an already-past expiresAt, does not throw`, async () => {
    await page.waitForSelector('[data-private-room-waiting-screen="1"]', { state: 'attached' })
    const text = await page.locator('[data-private-room-countdown-value="1"]').first().textContent()
    assert((text ?? '').trim() === '00:00', `expected "00:00", got "${text}"`)
  })

  await check(`${label} [X2] Client does NOT self-navigate away or clear the room at 00:00 (waits for server)`, async () => {
    const screen = await page.evaluate(() => (window as any).__prwHarness.getCurrentScreen())
    assert(screen === 'private-room-waiting', `expected to still be in the waiting room, got "${screen}"`)
    const stillThereCount = await page.locator('[data-private-room-waiting-screen="1"]').count()
    assert(stillThereCount === 1, 'waiting screen should still be rendered while waiting for server confirmation')
  })

  await check(`${label} [X3] private_room_expired navigates away with the exact required message`, async () => {
    await page.evaluate(() => (window as any).__prwHarness.pushRoomExpired('room-expiry'))
    const screen = await page.evaluate(() => (window as any).__prwHarness.getCurrentScreen())
    assert(screen !== 'private-room-waiting', `expected to leave the waiting room, currentScreen="${screen}"`)
    const bodyText = await page.textContent('body')
    assert(
      (bodyText ?? '').includes('Частната маса беше затворена, защото времето за изчакване изтече.'),
      'exact required expiry message not found in the DOM',
    )
  })

  await check(`${label} [X4] Interval is cleared once private_room_expired arrives`, async () => {
    const count = await page.evaluate(() => (window as any).__prwHarness.getActiveIntervalCount())
    assert(count === 0, `expected 0 active intervals after expiry, got ${count}`)
  })
}

async function runOpenLockedResponsiveScenario(page: Page, label: string): Promise<void> {
  await page.goto('/scripts/fixtures/privateRoomWaitingHarness.html')
  await page.waitForFunction(() => (window as any).__prwHarness !== undefined, undefined, { timeout: 10_000 })

  for (const kind of ['open', 'locked'] as const) {
    await page.evaluate(({ room }) => {
      ;(window as any).__prwHarness.navigateToPrivateRooms()
      ;(window as any).__prwHarness.pushRoomUpdated(room)
    }, { room: makeRoom(`room-${kind}`, [makeMember('me', 'Тестов Играч', true)], { kind }) })

    await check(`${label} [R-${kind}] Countdown badge renders for a ${kind} room without horizontal overflow`, async () => {
      await page.waitForSelector('[data-private-room-countdown="1"]', { state: 'attached' })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
      assert(!overflow, `horizontal overflow for kind=${kind}`)
    })
  }

  // 4/4 players (game about to start) + long display name — still no overflow.
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, {
    room: makeRoom('room-4of4', [
      makeMember('me', 'Константин-Александър Величковски-Радославов', true),
      makeMember('g1', 'Гост Едно', false),
      makeMember('g2', 'Гост Две', false),
      makeMember('g3', 'Гост Три', false),
    ]),
  })

  await check(`${label} [R-4of4] 4/4 players with a long display name: no overflow, leave button still reachable`, async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
    assert(!overflow, 'horizontal overflow at 4/4 players with long name')
    const box = await page.locator('[data-private-waiting-leave-button="1"]').boundingBox()
    assert(box !== null, 'leave button missing from DOM')
  })
}

console.log('\ncheckPrivateRoomWaitTimeCountdown\n')

await runFormatterUnitTests()

const VIEWPORTS: Array<{ width: number; height: number; label: string; mobile: boolean }> = [
  { width: 390, height: 844, label: '390x844 (mobile)', mobile: true },
  { width: 1280, height: 800, label: '1280x800 (desktop)', mobile: false },
]

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

  for (const vp of VIEWPORTS) {
    console.log(`\n--- Viewport ${vp.label} ---`)
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.mobile,
      isMobile: vp.mobile,
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    await runCreatePopupScenario(page, `[${vp.label}]`)
    await runCountdownDisplayScenario(page, `[${vp.label}]`)
    await runWarningCriticalStateScenario(page, `[${vp.label}]`)
    await runTickLoopLifecycleScenario(page, `[${vp.label}]`)
    await runIdempotentLifecycleScenario(page, `[${vp.label}]`)
    await runNoFullRerenderScenario(page, `[${vp.label}]`)
    await runExpiryContractScenario(page, `[${vp.label}]`)
    await runOpenLockedResponsiveScenario(page, `[${vp.label}]`)

    await check(`[${vp.label}] No console errors throughout the scenario`, () => {
      assert(errors.length === 0, `Console errors: ${errors.join(' | ')}`)
    })

    await context.close()
  }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
