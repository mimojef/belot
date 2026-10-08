/**
 * checkMuteModerationUiBrowser.ts
 *
 * Real browser (Playwright/Chromium), real production modules, real DOM:
 *  [1] popup "Заглушението изтече" / "Заглушението е премахнато" се показва
 *      НАД активна игра на Белот (реалният createActiveRoomFlowController,
 *      рендиран от реален сървърен snapshot — reactionCountdownBrowserHarness),
 *      с точните текстове, бутон OK, без да спира countdown анимацията или
 *      да маха игровия DOM; опашка без дубликати; OK -> ack; clear() затваря;
 *      повторна доставка на вече потвърдено -> тих re-ack, без popup.
 *      Desktop и mobile.
 *  [2] бутон "Мют" в профилния popup — само за viewerCanProfileMute, само за
 *      чужд профил със зареден статус БЕЗ активен мют.
 *  [3] moderation popup за мют от профила (topicId: null) се рендира в
 *      'global' scope НАД profile popup-а (z-index 12200) със срокове
 *      30 мин/1 ч/3 ч/24 ч, а не в 'topics-view'.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { buildRoomAtPhase, getActiveSeat, snapshotJson } from './fixtures/reactionCountdownServerFixtures.ts'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const EXPECTED = {
  expired: {
    title: 'Заглушението изтече',
    body: 'Вашето заглушение изтече. Вече можете да пишете в Лафче, Теми и чатовете на частните маси.',
  },
  unmuted: {
    title: 'Заглушението е премахнато',
    body: 'Вашето заглушение беше премахнато предсрочно. Вече можете да пишете в Лафче, Теми и чатовете на частните маси.',
  },
}

async function openGamePage(browser: Browser, baseUrl: string, contextOptions: BrowserContextOptions): Promise<{ page: Page; errors: string[]; seat: string }> {
  const context = await browser.newContext({ ...contextOptions, baseURL: baseUrl })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // tsx/esbuild keepNames инжектира __name() в сериализираните page.evaluate callback-и.
  await page.addInitScript('window.__name = function (fn) { return fn }')
  await page.goto('/scripts/fixtures/reactionCountdownBrowserHarness.html')
  await page.waitForFunction(() => (window as any).__reactionCountdownHarness?.ready === true)
  const room = buildRoomAtPhase('cutting', 15000)
  const seat = getActiveSeat(room)
  await page.evaluate(([id, s]) => (window as any).__reactionCountdownHarness.mount(id, s, 5000), [room.id, seat] as const)
  await page.evaluate((json) => (window as any).__reactionCountdownHarness.deliver(json), snapshotJson(room, seat))
  await page.waitForFunction(
    (s) => (window as any).__reactionCountdownHarness.readFills().some((f: any) => f.seat === s && f.active),
    seat,
    { timeout: 20_000 },
  )
  // Реалният popup модул, зареден в СЪЩАТА страница с играта.
  await page.evaluate(async () => {
    const mod = await import('/src/ui/notifications/muteEndNoticePopup.ts')
    const acks: string[] = []
    ;(window as any).__muteAcks = acks
    ;(window as any).__mutePopup = mod.createMuteEndNoticePopupController({ onAcknowledge: (id: string) => acks.push(id) })
  })
  return { page, errors, seat }
}

async function readOverlay(page: Page) {
  return page.evaluate(() => {
    const overlays = document.querySelectorAll('#mute-end-notice-modal')
    const overlay = overlays[0] as HTMLElement | undefined
    if (!overlay) return { count: 0 } as const
    const centerEl = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
    return {
      count: overlays.length,
      noticeId: overlay.getAttribute('data-mute-end-notice-id'),
      kind: overlay.getAttribute('data-mute-end-notice-kind'),
      title: overlay.querySelector('[data-mute-end-notice-title="1"]')?.textContent?.trim() ?? null,
      body: overlay.querySelector('[data-mute-end-notice-body="1"]')?.textContent?.trim() ?? null,
      okText: overlay.querySelector('[data-mute-end-notice-ok="1"]')?.textContent?.trim() ?? null,
      zIndex: getComputedStyle(overlay).zIndex,
      onTop: centerEl !== null && overlay.contains(centerEl),
      inBody: overlay.parentElement === document.body,
    } as const
  })
}

console.log('\n═══ checkMuteModerationUiBrowser ═══\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}`
  browser = await chromium.launch()

  for (const [label, contextOptions] of [
    ['desktop', { viewport: { width: 1440, height: 900 } }],
    ['mobile', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }],
  ] as const) {
    await check(`[1] ${label}: mute-end popups over an ACTIVE Belot game — exact texts, OK, queue, no gameplay impact`, async () => {
      const { page, errors, seat } = await openGamePage(browser!, baseUrl, contextOptions)
      const fillBefore = (await page.evaluate(() => (window as any).__reactionCountdownHarness.readFills())).find((f: any) => f.seat === seat)

      await page.evaluate(() => {
        const notices = [
          { noticeId: 'n-expired', kind: 'expired', mutedUntil: null, endedAt: new Date().toISOString() },
          { noticeId: 'n-unmuted', kind: 'unmuted', mutedUntil: null, endedAt: new Date().toISOString() },
        ]
        ;(window as any).__mutePopup.enqueue(notices)
        ;(window as any).__mutePopup.enqueue(notices) // повторна доставка (reconnect) -> без дубликати
      })
      let overlay = await readOverlay(page)
      assert(overlay.count === 1, `exactly one popup, got ${overlay.count}`)
      assert(overlay.kind === 'expired' && overlay.title === EXPECTED.expired.title && overlay.body === EXPECTED.expired.body, `expired texts ${JSON.stringify(overlay)}`)
      assert(overlay.okText === 'OK', 'OK button')
      assert(overlay.zIndex === '200001' && overlay.inBody, `global layer ${JSON.stringify(overlay)}`)
      assert(overlay.onTop, 'popup must be visually on top of the game')
      const queued = await page.evaluate(() => (window as any).__mutePopup.getQueuedNoticeIds())
      assert(JSON.stringify(queued) === JSON.stringify(['n-unmuted']), `queue without duplicates ${JSON.stringify(queued)}`)

      // Играта продължава под popup-а: countdown анимацията тече, DOM-ът е на мястото си.
      await sleep(600)
      const fillDuring = (await page.evaluate(() => (window as any).__reactionCountdownHarness.readFills())).find((f: any) => f.seat === seat)
      assert(fillDuring?.active === true, 'game countdown bar still mounted and active')
      assert(fillDuring.currentTime > fillBefore.currentTime, 'countdown animation keeps running under the popup')
      assert(fillDuring.durationMs === fillBefore.durationMs && fillDuring.key === fillBefore.key, 'turn/timer not reset by the popup')

      await page.click('[data-mute-end-notice-ok="1"]')
      overlay = await readOverlay(page)
      assert(overlay.count === 1 && overlay.kind === 'unmuted', 'next queued notice shown after OK')
      assert(overlay.title === EXPECTED.unmuted.title && overlay.body === EXPECTED.unmuted.body, `unmuted texts ${JSON.stringify(overlay)}`)
      await page.click('[data-mute-end-notice-ok="1"]')
      assert((await readOverlay(page)).count === 0, 'no popup left')
      let acks: string[] = await page.evaluate(() => (window as any).__muteAcks.slice())
      assert(JSON.stringify(acks) === JSON.stringify(['n-expired', 'n-unmuted']), `acks ${JSON.stringify(acks)}`)

      // Вече потвърдено, доставено пак (ack без връзка) -> тих re-ack, без popup.
      await page.evaluate(() => (window as any).__mutePopup.enqueue([{ noticeId: 'n-expired', kind: 'expired', mutedUntil: null, endedAt: new Date().toISOString() }]))
      assert((await readOverlay(page)).count === 0, 'acknowledged notice must not pop up again')
      acks = await page.evaluate(() => (window as any).__muteAcks.slice())
      assert(acks.filter((id) => id === 'n-expired').length === 2, 'silent re-ack sent')

      // clear(): OK на друго устройство / супресирано -> затваря видимия.
      await page.evaluate(() => (window as any).__mutePopup.enqueue([{ noticeId: 'n-other', kind: 'unmuted', mutedUntil: null, endedAt: new Date().toISOString() }]))
      assert((await readOverlay(page)).noticeId === 'n-other', 'new notice visible')
      await page.evaluate(() => (window as any).__mutePopup.clear(['n-other']))
      assert((await readOverlay(page)).count === 0, 'clear() closes the visible popup')

      const fillAfter = (await page.evaluate(() => (window as any).__reactionCountdownHarness.readFills())).find((f: any) => f.seat === seat)
      assert(fillAfter?.active === true && fillAfter.key === fillBefore.key, 'game state untouched after popups')
      assert(errors.length === 0, `page errors: ${errors.join(' | ')}`)
      await page.context().close()
    })
  }

  // [2] + [3] — реалните render функции в браузъра.
  {
    const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    // tsx/esbuild keepNames инжектира __name() в сериализираните page.evaluate callback-и.
    await page.addInitScript('window.__name = function (fn) { return fn }')
    await page.goto('/scripts/fixtures/reactionCountdownBrowserHarness.html')
    await page.waitForFunction(() => (window as any).__reactionCountdownHarness?.ready === true)

    await check('[2] "Мют" button only for admin/pika_team viewers, foreign profile, loaded status, no active mute', async () => {
      const result = await page.evaluate(async () => {
        const { renderPlayerProfilePopup } = await import('/src/ui/overlays/renderPlayerProfilePopup.ts')
        const profile = { profileId: 'target-1', displayName: 'Нарушител', avatarUrl: null, level: 3 } as any
        const notMuted = { isMuted: false, mutedUntil: null, mutedByAccountId: null, reason: null }
        const muted = { isMuted: true, mutedUntil: new Date(Date.now() + 3600_000).toISOString(), mutedByAccountId: 'a', reason: 'r' }
        const has = (opts: any) => {
          const html = renderPlayerProfilePopup({ isOpen: true, seat: 'bottom', profile, ...opts })
          return html.includes('data-player-profile-mute-action="target-1"')
        }
        return {
          canMuteNotMuted: has({ viewerCanProfileMute: true, targetMute: notMuted }),
          noPermission: has({ viewerCanProfileMute: false, targetMute: notMuted }),
          alreadyMuted: has({ viewerCanProfileMute: true, targetMute: muted }),
          statusNotLoaded: has({ viewerCanProfileMute: true, targetMute: null }),
          ownProfile: has({ viewerCanProfileMute: true, targetMute: notMuted, isOwnProfile: true }),
          overlayWhenMuted: renderPlayerProfilePopup({ isOpen: true, seat: 'bottom', profile, viewerCanProfileMute: true, targetMute: muted })
            .includes('data-player-profile-mute-overlay="target-1"'),
        }
      })
      assert(result.canMuteNotMuted, 'button shown for permitted viewer')
      assert(!result.noPermission, 'button hidden without permission')
      assert(!result.alreadyMuted, 'no second mute while active')
      assert(!result.statusNotLoaded, 'hidden until the status is known')
      assert(!result.ownProfile, 'hidden on own profile')
      assert(result.overlayWhenMuted, 'existing active-mute overlay shown instead')
    })

    await check('[3] profile-origin mute popup renders in global scope above the profile popup with 30m/1h/3h/24h', async () => {
      const result = await page.evaluate(async () => {
        const { renderTopicModerationActionPopup } = await import('/src/app/lobby/renderTopicsScreen.ts')
        const state = {
          topicModerationActionPopup: { kind: 'mute', topicId: null, targetProfileId: 't', targetDisplayName: 'Нарушител', sourceMessageId: null, sourceKind: 'unspecified' },
          topicModerationActionDurationMs: null,
          topicModerationActionReason: '',
          topicModerationActionReasonCategory: null,
          topicModerationActionBusy: false,
          topicModerationActionErrorText: null,
          profile: { profileId: 'viewer' },
        } as any
        const global = renderTopicModerationActionPopup(state, 'global')
        const topicsView = renderTopicModerationActionPopup(state, 'topics-view')
        const durations = [...global.matchAll(/data-topic-moderation-duration="(\d+)"/g)].map((m) => Number(m[1]))
        return {
          globalRendered: global.length > 0,
          topicsViewEmpty: topicsView === '',
          zIndex12200: global.includes('z-index:12200'),
          durations,
          hasReason: global.includes('data-topic-moderation-reason="1"'),
          hasCategory: global.includes('data-topic-moderation-reason-category="1"'),
          channelsText: global.includes('Лафче, Теми и чатовете на частните маси'),
        }
      })
      assert(result.globalRendered && result.topicsViewEmpty, `scope routing ${JSON.stringify(result)}`)
      assert(result.zIndex12200, 'must be above the profile popup')
      assert(JSON.stringify(result.durations) === JSON.stringify([1800000, 3600000, 10800000, 86400000]), `durations ${JSON.stringify(result.durations)}`)
      assert(result.hasReason && result.hasCategory, 'reason + category inputs')
      assert(result.channelsText, 'subtitle names all three channels')
    })

    await check('[2/3] no page errors', async () => {
      assert(errors.length === 0, errors.join(' | '))
    })
    await context.close()
  }
} finally {
  await browser?.close()
  await vite?.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
