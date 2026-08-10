/**
 * checkProfilePopupMobileResponsive.ts
 *
 * Permanent regression guard за renderPlayerProfilePopup.ts responsive
 * layout — засегнат от box-sizing bug, открит при финалния visual test на
 * "Теми" (клик върху author в Topics message stream на iPhone 12 Pro
 * 390x844): popup card-ът получаваше explicit width (min(92vw,760px) на
 * desktop, 100% през mobile @media override), но БЕЗ box-sizing:border-box —
 * padding:24px 24px 22px + border:2px се добавяха ОТГОРЕ на width-а,
 * правейки card-а реално с ~52px по-широк от viewport-а. Резултат: X close
 * бутонът, coin balance-а и десните action бутони бяха физически извън
 * видимата зона на mobile.
 *
 * Bug-ът беше ОБЩ за renderPlayerProfilePopup (не Topics-specific, не
 * harness-only) — компонентът се ползва идентично от Topics, Players,
 * Friends и всеки друг mobile flow. Fix: box-sizing:border-box на
 * data-player-profile-popup-card.
 *
 * Реален браузър (Playwright) + реален production код
 * (createLobbyFlowController + renderLobbyScreen + renderPlayerProfilePopup),
 * зареден през Vite dev server. Ползва permanent-purpose
 * topicsSwitchRaceHarness (не временния visual-only harness премахнат след
 * Етап 1 checkpoint-а) — deliverNextProfileResponseWithOverrides позволява
 * доставяне на профил с avatar/VIP/gallery overrides, нужни за тези
 * layout проверки.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
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
        reject(new Error('Не успях да намеря свободен порт.'))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

async function openTopicsScreen(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__topicsSwitchRaceHarness.openTopicsScreen()
  })
  await page.waitForSelector('[data-topics-screen="1"]', { state: 'attached' })
}

async function deliverNextResponseWithAuthor(page: Page, topicId: string, body: string, senderProfileId: string, senderDisplayName: string): Promise<void> {
  await page.evaluate(
    ({ id, b, pid, name }) => {
      ;(window as any).__topicsSwitchRaceHarness.deliverNextResponseWithAuthor(id, b, pid, name)
    },
    { id: topicId, b: body, pid: senderProfileId, name: senderDisplayName },
  )
}

async function clickMessageAuthor(page: Page, profileId: string): Promise<void> {
  await page.evaluate((pid) => {
    ;(window as any).__topicsSwitchRaceHarness.clickMessageAuthor(pid)
  }, profileId)
}

async function clickTopicChip(page: Page, topicId: string): Promise<void> {
  await page.evaluate((id) => {
    ;(window as any).__topicsSwitchRaceHarness.clickTopicChip(id)
  }, topicId)
}

async function deliverNextResponse(page: Page, topicId: string): Promise<void> {
  await page.evaluate((id) => {
    ;(window as any).__topicsSwitchRaceHarness.deliverNextResponse(id)
  }, topicId)
}

/** Нужна е НОВА onTopicMessagesLoad заявка за topic-general — превключваме away (topic-a) и обратно, за да я тригнем (pendingResolvers queue-то за topic-general може вече да е консумирано от предишен сценарий). */
async function refreshGeneralTopicQueue(page: Page): Promise<void> {
  await clickTopicChip(page, 'topic-a')
  await deliverNextResponse(page, 'topic-a')
  await page.waitForTimeout(20)
  await clickTopicChip(page, 'topic-general')
}

async function deliverNextProfileResponseWithOverrides(
  page: Page,
  profileId: string,
  displayName: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ({ pid, name, ov }) => {
      ;(window as any).__topicsSwitchRaceHarness.deliverNextProfileResponseWithOverrides(pid, name, ov)
    },
    { pid: profileId, name: displayName, ov: overrides },
  )
}

async function closeProfilePopup(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__topicsSwitchRaceHarness.closeProfilePopup()
  })
}

/** Отваря темата, доставя 1 съобщение от даден author, кликва author-а и доставя canonical profile с overrides — крайно състояние: popup отворен. */
async function openProfilePopupFor(
  page: Page,
  topicId: string,
  profileId: string,
  displayName: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  await refreshGeneralTopicQueue(page)
  await page.waitForTimeout(50)
  await deliverNextResponseWithAuthor(page, topicId, `msg-from-${profileId}`, profileId, displayName)
  await page.waitForSelector(`[data-topic-message-author="${profileId}"]`, { state: 'attached', timeout: 3000 })
  await clickMessageAuthor(page, profileId)
  await page.waitForTimeout(20)
  await deliverNextProfileResponseWithOverrides(page, profileId, displayName, overrides)
  await page.waitForSelector('[data-player-profile-popup-root="1"]', { state: 'attached', timeout: 3000 })
  await page.waitForTimeout(200)
}

async function assertPopupFitsViewport(page: Page, viewportWidth: number, viewportHeight: number, label: string): Promise<void> {
  const cardRect = await page.evaluate(() => document.querySelector('[data-player-profile-popup-card="1"]')?.getBoundingClientRect())
  assert(cardRect !== undefined, `${label}: popup card трябва да съществува в DOM-а`)

  const closeRect = await page.evaluate(() => document.querySelector('[data-player-profile-popup-close="1"]')?.getBoundingClientRect())
  assert(closeRect !== undefined, `${label}: close бутонът трябва да съществува`)

  const hOverflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth)

  assert(!hOverflow, `${label}: не трябва да има horizontal page overflow`)
  assert(
    cardRect!.right <= viewportWidth + 1 && cardRect!.left >= -1,
    `${label}: popup card трябва да се побира изцяло по ширина, получих rect=${JSON.stringify(cardRect)}, viewportWidth=${viewportWidth}`,
  )
  assert(
    cardRect!.bottom <= viewportHeight + 1,
    `${label}: popup card max-height трябва да е в рамките на viewport-а, получих bottom=${cardRect!.bottom}, viewportHeight=${viewportHeight}`,
  )
  assert(
    closeRect!.right <= viewportWidth + 1 && closeRect!.left >= -1,
    `${label}: close/X контролът трябва да е изцяло видим, получих rect=${JSON.stringify(closeRect)}`,
  )
}

async function assertActionButtonsFitViewport(page: Page, viewportWidth: number, label: string): Promise<void> {
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-player-profile-actions="1"] button')).map((btn) => {
      const r = btn.getBoundingClientRect()
      return { left: r.left, right: r.right, width: r.width }
    }),
  )
  assert(buttons.length > 0, `${label}: очаквах поне 1 action бутон в DOM-а`)
  for (const btn of buttons) {
    assert(
      btn.right <= viewportWidth + 1 && btn.left >= -1,
      `${label}: action бутон излиза извън viewport-а: ${JSON.stringify(btn)}`,
    )
    assert(btn.width >= 24, `${label}: action бутон не трябва да е смачкан до нечетим размер: width=${btn.width}`)
  }
}

console.log('\ncheckProfilePopupMobileResponsive\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

// Профилите тук се гледат от viewer-а с profileId='me' (getAuthSession в
// harness-а) — всички са ЧУЖДИ профили спрямо viewer-а, значи action
// бутоните (Харесай/Покани/Блокирай) винаги се рендират.
const PROFILE_WITH_AVATAR = { profileId: 'author-with-avatar', displayName: 'С Аватар', overrides: { avatarUrl: 'https://picsum.photos/seed/avatar-a/100/100', isVip: false, level: 7, yellowCoinsBalance: 84250, likesCount: 12 } }
const PROFILE_NO_AVATAR = { profileId: 'author-no-avatar', displayName: 'Без Аватар', overrides: { avatarUrl: null, isVip: false, level: 3 } }
const PROFILE_VIP = { profileId: 'author-vip', displayName: 'VIP Играч', overrides: { avatarUrl: 'https://picsum.photos/seed/avatar-vip/100/100', isVip: true, level: 12 } }

try {
  const port = await findFreePort()
  vite = await createViteServer({
    root: process.cwd(),
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
  })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/topicsSwitchRaceHarness.html`

  browser = await chromium.launch()

  // ─── Mobile: iPhone 12 Pro 390x844 ──────────────────────────────────────
  const mobileViewport = { width: 390, height: 844 }

  await (async () => {
    const context: BrowserContext = await browser!.newContext({ viewport: mobileViewport, hasTouch: true, isMobile: true })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })
    await openTopicsScreen(page)
    // showTopics() отваря general по подразбиране с pending заявка —
    // consume-ваме я веднага, за да не остане orphaned pending resolver.
    await deliverNextResponse(page, 'topic-general')
    await page.waitForTimeout(20)

    await check('[1] Mobile 390x844: профил С avatar — popup се побира изцяло, close видим', async () => {
      await openProfilePopupFor(page, 'topic-general', PROFILE_WITH_AVATAR.profileId, PROFILE_WITH_AVATAR.displayName, PROFILE_WITH_AVATAR.overrides)
      await assertPopupFitsViewport(page, mobileViewport.width, mobileViewport.height, 'author-with-avatar')
    })

    await check('[2] Mobile 390x844: action бутоните (Харесай/Покани/Блокирай) се побират чисто', async () => {
      await assertActionButtonsFitViewport(page, mobileViewport.width, 'author-with-avatar action buttons')
    })

    await check('[3] Mobile 390x844: close затваря popup-а, повторен клик отваря отново', async () => {
      await closeProfilePopup(page)
      await page.waitForTimeout(150)
      const closedGone = await page.evaluate(() => document.querySelector('[data-player-profile-popup-root="1"]') === null)
      assert(closedGone, 'Popup трябва да изчезне от DOM-а след close')

      // Отваряме СЪЩИЯ author отново — data-topic-message-author бутонът е
      // все още в DOM-а (не сме сменяли тема), само popup-а е затворен.
      await clickMessageAuthor(page, PROFILE_WITH_AVATAR.profileId)
      await page.waitForTimeout(20)
      await deliverNextProfileResponseWithOverrides(page, PROFILE_WITH_AVATAR.profileId, PROFILE_WITH_AVATAR.displayName, PROFILE_WITH_AVATAR.overrides)
      await page.waitForSelector('[data-player-profile-popup-root="1"]', { state: 'attached', timeout: 3000 })
      const reopened = await page.evaluate(() => document.querySelector('[data-player-profile-popup-root="1"]') !== null)
      assert(reopened, 'Popup трябва да се отвори отново при повторен клик')
      await closeProfilePopup(page)
      await page.waitForTimeout(150)
    })

    await check('[4] Mobile 390x844: профил БЕЗ avatar (letter fallback) — popup се побира изцяло', async () => {
      await openProfilePopupFor(page, 'topic-general', PROFILE_NO_AVATAR.profileId, PROFILE_NO_AVATAR.displayName, PROFILE_NO_AVATAR.overrides)
      await assertPopupFitsViewport(page, mobileViewport.width, mobileViewport.height, 'author-no-avatar')
      await assertActionButtonsFitViewport(page, mobileViewport.width, 'author-no-avatar action buttons')
      await closeProfilePopup(page)
      await page.waitForTimeout(150)
    })

    await check('[5] Mobile 390x844: VIP профил — popup се побира изцяло, VIP бадж видим в рамките на card-а', async () => {
      await openProfilePopupFor(page, 'topic-general', PROFILE_VIP.profileId, PROFILE_VIP.displayName, PROFILE_VIP.overrides)
      await assertPopupFitsViewport(page, mobileViewport.width, mobileViewport.height, 'author-vip')

      const vipBadgeRect = await page.evaluate(() => document.querySelector('[data-player-profile-vip-badge="1"]')?.getBoundingClientRect())
      assert(vipBadgeRect !== undefined, 'VIP бадж трябва да съществува за VIP профил')
      assert(
        vipBadgeRect!.right <= mobileViewport.width + 1,
        `VIP бадж трябва да е в рамките на viewport-а, получих rect=${JSON.stringify(vipBadgeRect)}`,
      )
      await closeProfilePopup(page)
      await page.waitForTimeout(150)
    })

    await check('[6] Mobile 390x844: popup internal scroll — ако съдържанието е по-високо, scroll е ВЪТРЕ в card-а, не в page', async () => {
      await openProfilePopupFor(page, 'topic-general', PROFILE_WITH_AVATAR.profileId, PROFILE_WITH_AVATAR.displayName, PROFILE_WITH_AVATAR.overrides)

      const cardOverflowY = await page.evaluate(() => getComputedStyle(document.querySelector('[data-player-profile-popup-card="1"]')!).overflowY)
      assert(cardOverflowY === 'auto' || cardOverflowY === 'scroll', `popup card трябва да има вътрешен vertical scroll, получих overflow-y=${cardOverflowY}`)

      const windowScrollYBefore = await page.evaluate(() => window.scrollY)
      await page.evaluate(() => {
        const el = document.querySelector('[data-player-profile-popup-card="1"]') as HTMLElement
        el.scrollTop = el.scrollHeight
      })
      await page.waitForTimeout(100)
      const windowScrollYAfter = await page.evaluate(() => window.scrollY)
      assert(windowScrollYAfter === windowScrollYBefore, 'window/page не трябва да scroll-ва при вътрешен scroll на popup-а')

      await closeProfilePopup(page)
      await page.waitForTimeout(150)
    })

    await check('[7] Mobile 390x844: няма JS грешки в конзолата по време на сценариите', () => {
      assert(errors.length === 0, `Конзолни грешки: ${errors.join(' | ')}`)
    })

    await context.close()
  })()

  // ─── Допълнителни mobile viewport-и (edge sizes) ────────────────────────
  await (async () => {
    for (const vp of [{ width: 320, height: 568 }, { width: 430, height: 932 }]) {
      const context: BrowserContext = await browser!.newContext({ viewport: vp, hasTouch: true, isMobile: true })
      const page = await context.newPage()
      await page.goto(baseUrl)
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })
      await openTopicsScreen(page)
      await deliverNextResponse(page, 'topic-general')
      await page.waitForTimeout(20)

      await check(`[8] Mobile ${vp.width}x${vp.height}: popup се побира изцяло (edge viewport size)`, async () => {
        await openProfilePopupFor(page, 'topic-general', PROFILE_WITH_AVATAR.profileId, PROFILE_WITH_AVATAR.displayName, PROFILE_WITH_AVATAR.overrides)
        await assertPopupFitsViewport(page, vp.width, vp.height, `edge viewport ${vp.width}x${vp.height}`)
        await assertActionButtonsFitViewport(page, vp.width, `edge viewport ${vp.width}x${vp.height} action buttons`)
      })

      await context.close()
    }
  })()

  // ─── Desktop regression: popup остава визуално непроменен ──────────────
  await (async () => {
    const desktopViewport = { width: 1400, height: 900 }
    const context: BrowserContext = await browser!.newContext({ viewport: desktopViewport })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })
    await openTopicsScreen(page)
    await deliverNextResponse(page, 'topic-general')
    await page.waitForTimeout(20)

    await check('[9] Desktop 1400x900: popup card width = min(92vw, 760px) → точно 760px (без regression)', async () => {
      await openProfilePopupFor(page, 'topic-general', PROFILE_WITH_AVATAR.profileId, PROFILE_WITH_AVATAR.displayName, PROFILE_WITH_AVATAR.overrides)
      const cardRect = await page.evaluate(() => document.querySelector('[data-player-profile-popup-card="1"]')?.getBoundingClientRect())
      assert(cardRect !== undefined, 'popup card трябва да съществува')
      assert(
        Math.abs(cardRect!.width - 760) < 2,
        `Desktop popup card width трябва да остане 760px (92vw се ограничава от max), получих ${cardRect!.width}`,
      )
    })

    await check('[10] Desktop 1400x900: popup center-иран, без horizontal overflow', async () => {
      const hOverflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth)
      assert(!hOverflow, 'Desktop не трябва да има horizontal page overflow')
      await closeProfilePopup(page)
      await page.waitForTimeout(150)
    })

    await check('[11] Desktop: няма JS грешки в конзолата', () => {
      assert(errors.length === 0, `Конзолни грешки: ${errors.join(' | ')}`)
    })

    await context.close()
  })()
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
