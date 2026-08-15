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
import { computeVipRemainingDays, formatVipDaysLabel } from '../src/ui/overlays/renderPlayerProfilePopup.ts'

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

async function deliverNextResponse(page: Page, topicId: string): Promise<void> {
  await page.evaluate((id) => {
    ;(window as any).__topicsSwitchRaceHarness.deliverNextResponse(id)
  }, topicId)
}

/**
 * Нужна е НОВА onTopicMessagesLoad заявка за topic-general (pendingResolvers
 * queue-то за topic-general може вече да е консумирано от предишен сценарий
 * в СЪЩИЯ page/controller session).
 *
 * Старият механизъм (chip-click away към topic-a и обратно към topic-general)
 * разчиташе на data-topic-chip навигацията, премахната в "Simplify Topics
 * navigation" (ee52049) — вече не съществува в production UI, затова
 * clickTopicChip тук вече не намираше нищо и pendingResolvers никога не се
 * презареждаше (production-verified regression, виж checkTopicsSwitchRace.ts
 * [2] "legacy topic strip entry points remain absent from render source").
 *
 * Текущият реален начин: showTopicsDirectory() (зад navigateToTopics(), т.е.
 * "Теми" nav entry point-а) безусловно вика loadTopicMessagesForActiveTopic()
 * при ВСЯКО влизане, дори ако вече сме на Topics екрана (виж коментара в
 * createLobbyFlowController.ts showTopicsDirectory: "всяко влизане в 'Теми'
 * трябва да вижда свеж статус"). Затова просто повторно извикване на
 * openTopicsScreen() (= controller.navigateToTopics()) е достатъчно, за да
 * получим свеж pending resolver — без нужда от chip-based "switch away".
 */
async function refreshGeneralTopicQueue(page: Page): Promise<void> {
  await openTopicsScreen(page)
  await page.waitForTimeout(20)
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

// ─── VIP remaining days — pure calculation (own profile header redesign) ───
// Без браузър: computeVipRemainingDays е чист helper, изчислен от authoritative
// active_until timestamp (НЕ отделно DB поле). Math.ceil + clamp(0) семантика.
console.log('=== VIP remaining days — pure calculation ===\n')

await check('[V1] Липсващ timestamp (null) → 0 дни', () => {
  assert(computeVipRemainingDays(null) === 0, `очаквах 0, получих ${computeVipRemainingDays(null)}`)
})

await check('[V2] Липсващ timestamp (undefined) → 0 дни', () => {
  assert(computeVipRemainingDays(undefined) === 0, `очаквах 0, получих ${computeVipRemainingDays(undefined)}`)
})

await check('[V3] Невалиден timestamp низ → 0 дни (не хвърля грешка)', () => {
  assert(computeVipRemainingDays('not-a-date') === 0, `очаквах 0, получих ${computeVipRemainingDays('not-a-date')}`)
})

await check('[V4] Timestamp в миналото (изтекъл VIP) → 0 дни, никога отрицателно', () => {
  const now = Date.parse('2026-08-15T12:00:00.000Z')
  const past = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString()
  assert(computeVipRemainingDays(past, now) === 0, `очаквах 0, получих ${computeVipRemainingDays(past, now)}`)
})

await check('[V5] Активен VIP с много оставащи дни (556) изчислява точно', () => {
  const now = Date.parse('2026-08-15T12:00:00.000Z')
  const future = new Date(now + 556 * 24 * 60 * 60 * 1000).toISOString()
  const days = computeVipRemainingDays(future, now)
  assert(days === 556, `очаквах 556, получих ${days}`)
  assert(formatVipDaysLabel(days) === 'VIP · 556 дни', `очаквах "VIP · 556 дни", получих "${formatVipDaysLabel(days)}"`)
})

await check('[V6] Голяма стойност (1245 дни) без overflow/грешка в изчислението', () => {
  const now = Date.parse('2026-08-15T12:00:00.000Z')
  const future = new Date(now + 1245 * 24 * 60 * 60 * 1000).toISOString()
  const days = computeVipRemainingDays(future, now)
  assert(days === 1245, `очаквах 1245, получих ${days}`)
  assert(formatVipDaysLabel(days) === 'VIP · 1245 дни', `очаквах "VIP · 1245 дни", получих "${formatVipDaysLabel(days)}"`)
})

await check('[V7] Точно 1 оставащ ден (24ч напред) → "1 ден" (единствено число), НЕ "1 дни"', () => {
  const now = Date.parse('2026-08-15T12:00:00.000Z')
  const future = new Date(now + 24 * 60 * 60 * 1000).toISOString()
  const days = computeVipRemainingDays(future, now)
  assert(days === 1, `очаквах 1, получих ${days}`)
  assert(formatVipDaysLabel(days) === 'VIP · 1 ден', `очаквах "VIP · 1 ден", получих "${formatVipDaysLabel(days)}"`)
})

await check('[V8] Off-by-one guard: няколко часа преди expiration все още показва "1 ден", НЕ "0 дни" (Math.ceil, не floor)', () => {
  const now = Date.parse('2026-08-15T12:00:00.000Z')
  const future = new Date(now + 3 * 60 * 60 * 1000).toISOString() // 3 часа напред
  const days = computeVipRemainingDays(future, now)
  assert(days === 1, `очаквах 1 (ceil на 3ч от 24ч денонощие), получих ${days}`)
})

await check('[V9] Off-by-one guard: 25 часа напред → "2 дни" (ceil), не заклещва на "1 ден"', () => {
  const now = Date.parse('2026-08-15T12:00:00.000Z')
  const future = new Date(now + 25 * 60 * 60 * 1000).toISOString()
  const days = computeVipRemainingDays(future, now)
  assert(days === 2, `очаквах 2, получих ${days}`)
})

await check('[V10] Нулева стойност → множествено число "0 дни" (не "0 ден")', () => {
  assert(formatVipDaysLabel(0) === 'VIP · 0 дни', `очаквах "VIP · 0 дни", получих "${formatVipDaysLabel(0)}"`)
})

console.log('\n=== Browser (Playwright) checks ===\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

// Профилите тук се гледат от viewer-а с profileId='me' (getAuthSession в
// harness-а) — всички са ЧУЖДИ профили спрямо viewer-а, значи action
// бутоните (Харесай/Покани/Блокирай) винаги се рендират.
const PROFILE_WITH_AVATAR = { profileId: 'author-with-avatar', displayName: 'С Аватар', overrides: { avatarUrl: 'https://picsum.photos/seed/avatar-a/100/100', isVip: false, level: 7, yellowCoinsBalance: 84250, likesCount: 12 } }
const PROFILE_NO_AVATAR = { profileId: 'author-no-avatar', displayName: 'Без Аватар', overrides: { avatarUrl: null, isVip: false, level: 3 } }
const PROFILE_VIP = { profileId: 'author-vip', displayName: 'VIP Играч', overrides: { avatarUrl: 'https://picsum.photos/seed/avatar-vip/100/100', isVip: true, level: 12, vipActiveUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString() } }

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

  // ─── Own profile popup: balance + "VIP · N дни" + Редакция (header redesign) ───
  await (async () => {
    const ownViewport = { width: 360, height: 776 }
    const context: BrowserContext = await browser!.newContext({ viewport: ownViewport, hasTouch: true, isMobile: true })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })
    // Начален render — production main.ts прави същото веднъж при boot;
    // без него data-lobby-profile-button не съществува все още в DOM-а.
    await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.render())

    async function openOwnProfilePopup(overrides: Record<string, unknown>, vipActiveUntil: string | null): Promise<void> {
      await page.evaluate((ov) => (window as any).__topicsSwitchRaceHarness.setOwnProfileOverrides(ov), overrides)
      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.openOwnProfile())
      await page.waitForSelector('[data-player-profile-popup-root="1"]', { state: 'attached', timeout: 3000 })
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.getOwnVipStatusPendingCount() > 0, undefined, { timeout: 3000 })
      await page.evaluate((au) => (window as any).__topicsSwitchRaceHarness.deliverOwnVipStatus(au), vipActiveUntil)
      await page.waitForTimeout(80)
    }
    async function closeOwn(): Promise<void> {
      await closeProfilePopup(page)
      await page.waitForTimeout(120)
    }

    await check('[O1] Own profile 360x776: активен VIP много дни → "VIP · 556 дни", popup се побира изцяло', async () => {
      const future = new Date(Date.now() + 556 * 24 * 60 * 60 * 1000).toISOString()
      await openOwnProfilePopup({ yellowCoinsBalance: 114500 }, future)
      const vipText = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getOwnVipDaysText())
      assert(vipText?.includes('VIP · 556 дни') ?? false, `очаквах "VIP · 556 дни", получих "${vipText}"`)
      await assertPopupFitsViewport(page, ownViewport.width, ownViewport.height, 'own profile active VIP')
      await closeOwn()
    })

    await check('[O2] Own profile: 1 оставащ ден → "VIP · 1 ден" (единствено число)', async () => {
      const future = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString() // 20ч напред → ceil=1
      await openOwnProfilePopup({}, future)
      const vipText = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getOwnVipDaysText())
      assert(vipText?.includes('VIP · 1 ден') ?? false, `очаквах "VIP · 1 ден", получих "${vipText}"`)
      assert(!(vipText?.includes('1 дни') ?? false), `не трябва да съдържа "1 дни", получих "${vipText}"`)
      await closeOwn()
    })

    await check('[O3] Own profile: изтекъл VIP (минал timestamp) → "VIP · 0 дни", редът остава видим', async () => {
      const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
      await openOwnProfilePopup({}, past)
      const vipText = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getOwnVipDaysText())
      assert(vipText?.includes('VIP · 0 дни') ?? false, `очаквах "VIP · 0 дни", получих "${vipText}"`)
      await closeOwn()
    })

    await check('[O4] Own profile: липсващ VIP (activeUntil=null) → "VIP · 0 дни", редът НЕ се крие', async () => {
      await openOwnProfilePopup({}, null)
      const vipText = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getOwnVipDaysText())
      assert(vipText?.includes('VIP · 0 дни') ?? false, `очаквах "VIP · 0 дни", получих "${vipText}"`)
      const rowExists = await page.evaluate(() => document.querySelector('[data-player-profile-own-vip-days="1"]') !== null)
      assert(rowExists, 'VIP редът трябва да присъства дори без активен VIP — layout-ът не трябва да зависи от VIP статус')
      await closeOwn()
    })

    await check('[O5] Own profile: голяма стойност "VIP · 1245 дни" + голям баланс 12 450 000 — без overflow при 360px', async () => {
      const future = new Date(Date.now() + 1245 * 24 * 60 * 60 * 1000).toISOString()
      await openOwnProfilePopup({ yellowCoinsBalance: 12450000 }, future)
      const vipText = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getOwnVipDaysText())
      assert(vipText?.includes('VIP · 1245 дни') ?? false, `очаквах "VIP · 1245 дни", получих "${vipText}"`)
      const balanceText = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getOwnBalanceText())
      assert(balanceText?.includes('12') ?? false, `балансът трябва да е видим, получих "${balanceText}"`)
      await assertPopupFitsViewport(page, ownViewport.width, ownViewport.height, 'own profile large values')
      const hOverflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth)
      assert(!hOverflow, 'не трябва да има horizontal overflow при големи стойности')
      await closeOwn()
    })

    await check('[O6] Own profile: „Редакция“ е видима и достъпна', async () => {
      await openOwnProfilePopup({ yellowCoinsBalance: 1000 }, null)
      const editVisible = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.isOwnEditVisible())
      assert(editVisible, '„Редакция“ трябва да е видима за own profile')
      await closeOwn()
    })

    await check('[O8] Own profile: повторни generic render() докато popup-ът е отворен НЕ трябва да предизвикват повторни onGetOwnVipStatus заявки (request-dedupe guard)', async () => {
      await page.evaluate((ov) => (window as any).__topicsSwitchRaceHarness.setOwnProfileOverrides(ov), { yellowCoinsBalance: 7000 })
      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.openOwnProfile())
      await page.waitForSelector('[data-player-profile-popup-root="1"]', { state: 'attached', timeout: 3000 })
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.getOwnVipStatusPendingCount() > 0, undefined, { timeout: 3000 })

      const callCountAfterOpen = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getOwnVipStatusCallCount())

      // Симулираме честите generic render() цикли (WS/presence/badge events), докато заявката е ОЩЕ pending.
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.render())
      }
      const callCountWhilePending = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getOwnVipStatusCallCount())
      assert(
        callCountWhilePending === callCountAfterOpen,
        `докато заявката е pending, повторни render() не трябва да стартират нова заявка: преди=${callCountAfterOpen}, след=${callCountWhilePending}`,
      )

      // Доставяме отговора и продължаваме с повторни render() след resolve.
      const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()
      await page.evaluate((au) => (window as any).__topicsSwitchRaceHarness.deliverOwnVipStatus(au), future)
      await page.waitForTimeout(80)

      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.render())
      }
      const callCountAfterResolve = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getOwnVipStatusCallCount())
      assert(
        callCountAfterResolve === callCountAfterOpen,
        `след resolve, повторни render() докато popup-ът стои отворен НЕ трябва да стартират нова заявка: очаквах ${callCountAfterOpen}, получих ${callCountAfterResolve}`,
      )

      await closeOwn()
    })

    await check('[O11] Own profile: Edit → X → popup-ът се отваря отново със СТАРИТЕ данни (не Lobby fallback)', async () => {
      const oldAvatarUrl = 'https://picsum.photos/seed/own-avatar-old-x/200/200'
      await openOwnProfilePopup({ avatarUrl: oldAvatarUrl, yellowCoinsBalance: 3000 }, null)

      const avatarBeforeEdit = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getOwnAvatarImgSrc())
      assert(avatarBeforeEdit === oldAvatarUrl, `очаквах avatar=${oldAvatarUrl}, получих ${avatarBeforeEdit}`)

      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.clickOwnEdit())
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.isProfileEditorOpen() === true, undefined, { timeout: 3000 })
      const popupOpenDuringEdit = await page.evaluate(() => document.querySelector('[data-player-profile-popup-root="1"]') !== null)
      assert(!popupOpenDuringEdit, 'докато edit екранът е отворен, старият popup НЕ трябва да остава в DOM-а (двоен overlay)')

      const renderCountBeforeClose = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getRenderLobbyScreenCallCount())
      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.clickProfileEditorClose())
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.isProfileEditorOpen() === false, undefined, { timeout: 3000 })
      const renderCountAfterClose = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getRenderLobbyScreenCallCount())
      assert(
        renderCountAfterClose === renderCountBeforeClose,
        `X→Profile не трябва да минава през generic renderLobbyScreen() (пълен Lobby rebuild): преди=${renderCountBeforeClose}, след=${renderCountAfterClose}`,
      )

      const popupReopened = await page.evaluate(() => document.querySelector('[data-player-profile-popup-root="1"]') !== null)
      assert(popupReopened, 'след X, profile popup-ът трябва да се отвори отново (не fallback към Lobby)')

      const avatarAfterClose = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getOwnAvatarImgSrc())
      assert(avatarAfterClose === oldAvatarUrl, `след X очаквах старите данни (avatar=${oldAvatarUrl}), получих ${avatarAfterClose}`)

      await closeOwn()
    })

    await check('[O12] Own profile: Edit → Откажи → popup-ът се отваря отново със СТАРИТЕ данни (не Lobby fallback)', async () => {
      const oldAvatarUrl = 'https://picsum.photos/seed/own-avatar-old-cancel/200/200'
      await openOwnProfilePopup({ avatarUrl: oldAvatarUrl, yellowCoinsBalance: 3500 }, null)

      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.clickOwnEdit())
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.isProfileEditorOpen() === true, undefined, { timeout: 3000 })

      const renderCountBeforeCancel = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getRenderLobbyScreenCallCount())
      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.clickProfileEditorCancel())
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.isProfileEditorOpen() === false, undefined, { timeout: 3000 })
      const renderCountAfterCancel = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getRenderLobbyScreenCallCount())
      assert(
        renderCountAfterCancel === renderCountBeforeCancel,
        `Откажи→Profile не трябва да минава през generic renderLobbyScreen() (пълен Lobby rebuild): преди=${renderCountBeforeCancel}, след=${renderCountAfterCancel}`,
      )

      const popupReopened = await page.evaluate(() => document.querySelector('[data-player-profile-popup-root="1"]') !== null)
      assert(popupReopened, 'след "Откажи", profile popup-ът трябва да се отвори отново (не fallback към Lobby)')

      const avatarAfterCancel = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getOwnAvatarImgSrc())
      assert(avatarAfterCancel === oldAvatarUrl, `след "Откажи" очаквах старите данни (avatar=${oldAvatarUrl}), получих ${avatarAfterCancel}`)

      await closeOwn()
    })

    await check('[O13] Own profile: Edit → успешен Save → popup-ът остава отворен с НОВИТЕ данни (не Lobby fallback)', async () => {
      const oldAvatarUrl = 'https://picsum.photos/seed/own-avatar-before-save/200/200'
      const newAvatarUrl = 'https://picsum.photos/seed/own-avatar-after-save/200/200'
      await openOwnProfilePopup({ avatarUrl: oldAvatarUrl, yellowCoinsBalance: 4200 }, null)

      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.clickOwnEdit())
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.isProfileEditorOpen() === true, undefined, { timeout: 3000 })

      await page.evaluate((url) => (window as any).__topicsSwitchRaceHarness.setNextProfileEditSubmitAvatarUrl(url), newAvatarUrl)
      // Броячът се хваща ВЕДНАГА след click-а, в СЪЩОТО evaluate извикване —
      // submitProfileEdit() синхронно прави ОЧАКВАН pending-state render()
      // ("Запазване...", докато editor-ът е още видим — това е ОК, не е
      // Lobby flash) ПРЕДИ да опре в await-а към onProfileEditSubmit mock-а.
      // Затова базовата стойност трябва да е СЛЕД този pending render, за да
      // тества точно success→popup reopen прехода, а не самия submit start.
      const renderCountAfterSubmitClick = await page.evaluate(() => {
        ;(window as any).__topicsSwitchRaceHarness.submitProfileEditorForm()
        return (window as any).__topicsSwitchRaceHarness.getRenderLobbyScreenCallCount()
      })
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.isProfileEditorOpen() === false, undefined, { timeout: 3000 })
      const renderCountAfterSave = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getRenderLobbyScreenCallCount())
      assert(
        renderCountAfterSave === renderCountAfterSubmitClick,
        `Save→Profile (след успешния onProfileEditSubmit resolve) не трябва да минава през generic renderLobbyScreen() (пълен Lobby rebuild): преди=${renderCountAfterSubmitClick}, след=${renderCountAfterSave}`,
      )

      const popupReopened = await page.evaluate(() => document.querySelector('[data-player-profile-popup-root="1"]') !== null)
      assert(popupReopened, 'след успешен Save, profile popup-ът трябва да се отвори отново (не fallback към Lobby)')

      const avatarAfterSave = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getOwnAvatarImgSrc())
      assert(avatarAfterSave === newAvatarUrl, `след Save очаквах новите данни (avatar=${newAvatarUrl}), получих ${avatarAfterSave}`)

      await closeOwn()
    })

    await check('[O7] Няма JS грешки в конзолата по време на own profile сценариите', () => {
      assert(errors.length === 0, `Конзолни грешки: ${errors.join(' | ')}`)
    })

    await context.close()
  })()

  // ─── Own profile desktop regression (отделен viewport context) ─────────
  await (async () => {
    const desktopViewport = { width: 1400, height: 900 }
    const context: BrowserContext = await browser!.newContext({ viewport: desktopViewport })
    const page = await context.newPage()
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })
    await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.render())

    await check('[O9] Own profile desktop 1400x900: VIP ред + баланс + Редакция рендерират коректно, без overflow', async () => {
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      await page.evaluate((ov) => (window as any).__topicsSwitchRaceHarness.setOwnProfileOverrides(ov), { yellowCoinsBalance: 55000 })
      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.openOwnProfile())
      await page.waitForSelector('[data-player-profile-popup-root="1"]', { state: 'attached', timeout: 3000 })
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.getOwnVipStatusPendingCount() > 0, undefined, { timeout: 3000 })
      await page.evaluate((au) => (window as any).__topicsSwitchRaceHarness.deliverOwnVipStatus(au), future)
      await page.waitForTimeout(80)

      const vipText = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getOwnVipDaysText())
      assert(vipText?.includes('VIP · 30 дни') ?? false, `очаквах "VIP · 30 дни", получих "${vipText}"`)
      const editVisible = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.isOwnEditVisible())
      assert(editVisible, '„Редакция“ трябва да е видима за own profile на desktop')
      const hOverflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth)
      assert(!hOverflow, 'Desktop own profile не трябва да има horizontal overflow')
    })

    await context.close()
  })()

  // ─── Other profile: НЕ показва точния брой оставащи VIP дни ─────────────
  // Собствена, изолирана page/context навигация (свеж pendingResolvers per
  // topic-general) — не reuse-ва refreshGeneralTopicQueue/chip-based helper-а
  // по-горе (data-topic-chip вече не съществува в render source-а след
  // "Simplify Topics navigation" — pre-existing, несвързан с тази задача gap;
  // тук просто консумираме директно ПЪРВАТА естествена pending заявка).
  await (async () => {
    const context: BrowserContext = await browser!.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })
    await openTopicsScreen(page)

    await check('[O10] Чужд активен VIP профил: „VIP“ бадж + „N дни“ като ОТДЕЛЕН текст вдясно (не вътре в pill-a)', async () => {
      const future = new Date(Date.now() + 556 * 24 * 60 * 60 * 1000).toISOString()
      await deliverNextResponseWithAuthor(page, 'topic-general', 'hello-from-other-vip', 'other-vip-profile', 'Other VIP')
      await page.waitForSelector('[data-topic-message-author="other-vip-profile"]', { state: 'attached', timeout: 3000 })
      await clickMessageAuthor(page, 'other-vip-profile')
      await page.waitForTimeout(20)
      await deliverNextProfileResponseWithOverrides(page, 'other-vip-profile', 'Other VIP', { isVip: true, yellowCoinsBalance: 99999, vipActiveUntil: future })
      await page.waitForSelector('[data-player-profile-popup-root="1"]', { state: 'attached', timeout: 3000 })
      await page.waitForTimeout(100)

      const ownVipRowExists = await page.evaluate(() => document.querySelector('[data-player-profile-own-vip-days="1"]') !== null)
      assert(!ownVipRowExists, 'чужд профил НЕ трябва да показва data-player-profile-own-vip-days (собствения-профил ред)')

      const publicBadgeText = await page.evaluate(() => document.querySelector('[data-player-profile-vip-badge="1"]')?.textContent?.trim() ?? null)
      assert(publicBadgeText === 'VIP', `публичният VIP бадж за чужд профил трябва да е точно "VIP" (без брой дни вътре в pill-a), получих "${publicBadgeText}"`)

      const foreignVipRowText = await page.evaluate(() => document.querySelector('[data-player-profile-foreign-vip-days="1"]')?.textContent ?? null)
      assert(foreignVipRowText?.includes('556 дни') ?? false, `очаквах "556 дни" в чуждия VIP ред, получих "${foreignVipRowText}"`)

      const editVisible = await page.evaluate(() => document.querySelector('[data-player-profile-edit="1"]') !== null)
      assert(!editVisible, 'обикновен viewer (не admin) не трябва да вижда „Редакция“ за чужд профил')

      await closeProfilePopup(page)
      await page.waitForTimeout(100)
    })

    await check('[O14] Чужд профил + 1 оставащ ден → "1 ден" (единствено число), бадж-ът остава само "VIP"', async () => {
      const future = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString() // 20ч напред → ceil=1
      await refreshGeneralTopicQueue(page)
      await deliverNextResponseWithAuthor(page, 'topic-general', 'hello-from-other-vip-1d', 'other-vip-profile-1d', 'Other VIP 1d')
      await page.waitForSelector('[data-topic-message-author="other-vip-profile-1d"]', { state: 'attached', timeout: 3000 })
      await clickMessageAuthor(page, 'other-vip-profile-1d')
      await page.waitForTimeout(20)
      await deliverNextProfileResponseWithOverrides(page, 'other-vip-profile-1d', 'Other VIP 1d', { isVip: true, vipActiveUntil: future })
      await page.waitForSelector('[data-player-profile-popup-root="1"]', { state: 'attached', timeout: 3000 })
      await page.waitForTimeout(100)

      const foreignVipRowText = await page.evaluate(() => document.querySelector('[data-player-profile-foreign-vip-days="1"]')?.textContent ?? null)
      assert(foreignVipRowText?.includes('1 ден') ?? false, `очаквах "1 ден", получих "${foreignVipRowText}"`)
      assert(!(foreignVipRowText?.includes('1 дни') ?? false), `не трябва да съдържа "1 дни", получих "${foreignVipRowText}"`)
      const publicBadgeText = await page.evaluate(() => document.querySelector('[data-player-profile-vip-badge="1"]')?.textContent?.trim() ?? null)
      assert(publicBadgeText === 'VIP', `бадж-ът трябва да остане точно "VIP", получих "${publicBadgeText}"`)

      await closeProfilePopup(page)
      await page.waitForTimeout(100)
    })

    await check('[O15] Чужд профил + изтекъл VIP (минал active_until) → целият VIP ред липсва, никъде няма "0 дни"', async () => {
      const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
      await refreshGeneralTopicQueue(page)
      await deliverNextResponseWithAuthor(page, 'topic-general', 'hello-from-other-expired', 'other-expired-profile', 'Other Expired')
      await page.waitForSelector('[data-topic-message-author="other-expired-profile"]', { state: 'attached', timeout: 3000 })
      await clickMessageAuthor(page, 'other-expired-profile')
      await page.waitForTimeout(20)
      await deliverNextProfileResponseWithOverrides(page, 'other-expired-profile', 'Other Expired', { isVip: false, vipActiveUntil: past })
      await page.waitForSelector('[data-player-profile-popup-root="1"]', { state: 'attached', timeout: 3000 })
      await page.waitForTimeout(100)

      const vipRowExists = await page.evaluate(() => document.querySelector('[data-player-profile-foreign-vip-days="1"]') !== null)
      assert(!vipRowExists, 'изтекъл VIP за чужд профил трябва да крие целия VIP ред')
      const badgeExists = await page.evaluate(() => document.querySelector('[data-player-profile-vip-badge="1"]') !== null)
      assert(!badgeExists, 'изтекъл VIP не трябва да показва и самия "VIP" бадж')
      const popupText = await page.evaluate(() => document.querySelector('[data-player-profile-popup-card="1"]')?.textContent ?? '')
      assert(!popupText.includes('0 дни'), `не трябва да се показва "VIP 0 дни" за чужд профил, получих popup текст: "${popupText}"`)

      await closeProfilePopup(page)
      await page.waitForTimeout(100)
    })

    await check('[O16] Чужд профил без VIP данни (vipActiveUntil липсва) → VIP редът също липсва (същия helper, 0 дни → скрит)', async () => {
      await refreshGeneralTopicQueue(page)
      await deliverNextResponseWithAuthor(page, 'topic-general', 'hello-from-other-novip', 'other-novip-profile', 'Other NoVip')
      await page.waitForSelector('[data-topic-message-author="other-novip-profile"]', { state: 'attached', timeout: 3000 })
      await clickMessageAuthor(page, 'other-novip-profile')
      await page.waitForTimeout(20)
      await deliverNextProfileResponseWithOverrides(page, 'other-novip-profile', 'Other NoVip', {})
      await page.waitForSelector('[data-player-profile-popup-root="1"]', { state: 'attached', timeout: 3000 })
      await page.waitForTimeout(100)

      const vipRowExists = await page.evaluate(() => document.querySelector('[data-player-profile-foreign-vip-days="1"]') !== null)
      assert(!vipRowExists, 'профил без VIP данни не трябва да показва VIP реда')

      await closeProfilePopup(page)
      await page.waitForTimeout(100)
    })

    await check('[O17] Сърцата в popup-а са SVG икони, не emoji/text glyph (♥)', async () => {
      await refreshGeneralTopicQueue(page)
      await deliverNextResponseWithAuthor(page, 'topic-general', 'hello-from-heart-check', 'heart-check-profile', 'Heart Check')
      await page.waitForSelector('[data-topic-message-author="heart-check-profile"]', { state: 'attached', timeout: 3000 })
      await clickMessageAuthor(page, 'heart-check-profile')
      await page.waitForTimeout(20)
      await deliverNextProfileResponseWithOverrides(page, 'heart-check-profile', 'Heart Check', { likesCount: 7 })
      await page.waitForSelector('[data-player-profile-popup-root="1"]', { state: 'attached', timeout: 3000 })
      await page.waitForTimeout(100)

      const popupText = await page.evaluate(() => document.querySelector('[data-player-profile-popup-card="1"]')?.textContent ?? '')
      assert(!popupText.includes('♥') && !popupText.includes('❤'), `popup текстът не трябва да съдържа heart emoji/glyph, получих: "${popupText}"`)

      const likeButtonHasSvg = await page.evaluate(() => document.querySelector('[data-player-profile-like] svg') !== null)
      assert(likeButtonHasSvg, '„Харесай“ бутонът трябва да съдържа SVG сърце')

      const likesStatHasSvg = await page.evaluate(() => document.querySelector('[data-player-profile-stat="1"] svg') !== null)
      assert(likesStatHasSvg, '„Харесан: N“ статистиката трябва да съдържа SVG сърце')

      await closeProfilePopup(page)
      await page.waitForTimeout(100)
    })

    await context.close()
  })()

  // ─── Foreign profile mobile 360x776: header (avatar/име/баланс/VIP ред) ──
  await (async () => {
    const context: BrowserContext = await browser!.newContext({ viewport: { width: 360, height: 776 }, hasTouch: true, isMobile: true })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })
    await openTopicsScreen(page)

    await check('[O18] Чужд профил 360x776: avatar вляво, име/баланс/VIP ред вдясно, без overflow', async () => {
      const future = new Date(Date.now() + 556 * 24 * 60 * 60 * 1000).toISOString()
      await deliverNextResponseWithAuthor(page, 'topic-general', 'hello-from-trento', 'trento-profile', 'Trento76')
      await page.waitForSelector('[data-topic-message-author="trento-profile"]', { state: 'attached', timeout: 3000 })
      await clickMessageAuthor(page, 'trento-profile')
      await page.waitForTimeout(20)
      await deliverNextProfileResponseWithOverrides(page, 'trento-profile', 'Trento76', {
        isVip: true,
        vipActiveUntil: future,
        yellowCoinsBalance: 6011000,
        avatarUrl: 'https://picsum.photos/seed/trento76/200/200',
      })
      await page.waitForSelector('[data-player-profile-popup-root="1"]', { state: 'attached', timeout: 3000 })
      await page.waitForTimeout(100)

      await assertPopupFitsViewport(page, 360, 776, 'foreign profile Trento76')

      const summaryText = await page.evaluate(() => document.querySelector('[data-player-profile-foreign-summary="1"]')?.textContent ?? null)
      assert(summaryText?.includes('6') ?? false, `балансът трябва да е видим в foreign summary, получих "${summaryText}"`)
      assert(summaryText?.includes('556 дни') ?? false, `VIP дните трябва да са видими в foreign summary, получих "${summaryText}"`)

      const avatarRect = await page.evaluate(() => document.querySelector('[data-player-profile-avatar="1"]')?.getBoundingClientRect())
      const summaryRect = await page.evaluate(() => document.querySelector('[data-player-profile-foreign-summary="1"]')?.getBoundingClientRect())
      assert(avatarRect !== undefined && summaryRect !== undefined, 'avatar и foreign summary трябва да съществуват в DOM-а')
      assert(avatarRect!.left < summaryRect!.left, `avatar трябва да е вляво от summary блока, avatar.left=${avatarRect!.left}, summary.left=${summaryRect!.left}`)

      const hOverflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth)
      assert(!hOverflow, 'чужд профил при 360px не трябва да има horizontal overflow')

      await closeProfilePopup(page)
      await page.waitForTimeout(100)
    })

    await check('[O19] Няма JS грешки в конзолата по време на foreign profile mobile сценария', () => {
      assert(errors.length === 0, `Конзолни грешки: ${errors.join(' | ')}`)
    })

    await context.close()
  })()

  // ─── "Дай VIP" admin grant (само role==='admin', само чужд профил) ─────
  await (async () => {
    const context: BrowserContext = await browser!.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })

    async function openForeignProfilePopupAs(
      role: 'player' | 'admin' | 'subadmin' | 'pika_team' | 'top_chat_admin' | 'chat_admin',
      profileId: string,
      displayName: string,
      overrides: Record<string, unknown>,
    ): Promise<void> {
      await page.evaluate((r) => (window as any).__topicsSwitchRaceHarness.setOwnAccountRole(r), role)
      await refreshGeneralTopicQueue(page)
      await deliverNextResponseWithAuthor(page, 'topic-general', `hello-from-${profileId}`, profileId, displayName)
      await page.waitForSelector(`[data-topic-message-author="${profileId}"]`, { state: 'attached', timeout: 3000 })
      await clickMessageAuthor(page, profileId)
      await page.waitForTimeout(20)
      await deliverNextProfileResponseWithOverrides(page, profileId, displayName, overrides)
      await page.waitForSelector('[data-player-profile-popup-root="1"]', { state: 'attached', timeout: 3000 })
      await page.waitForTimeout(100)
    }

    await check('[V1] admin viewer вижда "Дай VIP" в чужд profile popup', async () => {
      await openForeignProfilePopupAs('admin', 'vipgrant-admin-target-1', 'Target One', {})
      const visible = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.isVipGrantTriggerVisible())
      assert(visible, '"Дай VIP" трябва да е видим за admin viewer в чужд профил')
      await closeProfilePopup(page)
      await page.waitForTimeout(100)
    })

    const NON_ADMIN_ROLES: Array<'player' | 'subadmin' | 'pika_team' | 'top_chat_admin' | 'chat_admin'> = [
      'player', 'subadmin', 'pika_team', 'top_chat_admin', 'chat_admin',
    ]
    for (const role of NON_ADMIN_ROLES) {
      await check(`[V2] ${role} viewer НЕ вижда "Дай VIP" в чужд profile popup`, async () => {
        await openForeignProfilePopupAs(role, `vipgrant-target-${role}`, `Target ${role}`, {})
        const visible = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.isVipGrantTriggerVisible())
        assert(!visible, `"Дай VIP" НЕ трябва да е видим за ${role}`)
        await closeProfilePopup(page)
        await page.waitForTimeout(100)
      })
    }

    await check('[V4] "Дай VIP" → Отказ затваря само формата (popup остава отворен, без generic Lobby render)', async () => {
      await openForeignProfilePopupAs('admin', 'vipgrant-cancel-target', 'Cancel Target', {})
      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.clickVipGrantOpen())
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.isVipGrantFormOpen() === true, undefined, { timeout: 3000 })

      const renderCountBeforeCancel = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getRenderLobbyScreenCallCount())
      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.clickVipGrantCancel())
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.isVipGrantFormOpen() === false, undefined, { timeout: 3000 })
      const renderCountAfterCancel = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getRenderLobbyScreenCallCount())
      assert(
        renderCountAfterCancel === renderCountBeforeCancel,
        `Отказ не трябва да минава през generic renderLobbyScreen(): преди=${renderCountBeforeCancel}, след=${renderCountAfterCancel}`,
      )

      const popupStillOpen = await page.evaluate(() => document.querySelector('[data-player-profile-popup-root="1"]') !== null)
      assert(popupStillOpen, 'profile popup-ът трябва да остане отворен след Отказ')

      const triggerVisibleAgain = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.isVipGrantTriggerVisible())
      assert(triggerVisibleAgain, 'след Отказ trigger-ът "Дай VIP" трябва да се появи отново')

      await closeProfilePopup(page)
      await page.waitForTimeout(100)
    })

    await check('[V5] 0 / отрицателно / decimal / нечислова / празна стойност се reject-ват (client-side), формата остава отворена', async () => {
      await openForeignProfilePopupAs('admin', 'vipgrant-invalid-target', 'Invalid Target', {})
      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.clickVipGrantOpen())
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.isVipGrantFormOpen() === true, undefined, { timeout: 3000 })

      for (const invalid of ['0', '-5', '2.5', 'abc', '']) {
        await page.evaluate((v) => (window as any).__topicsSwitchRaceHarness.setVipGrantDaysInput(v), invalid)
        await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.submitVipGrantForm())
        await page.waitForTimeout(50)
        const errorText = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getVipGrantErrorText())
        assert(errorText !== null, `очаквах грешка за невалидна стойност "${invalid}", получих null`)
        const formStillOpen = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.isVipGrantFormOpen())
        assert(formStillOpen, `формата трябва да остане отворена след невалидна стойност "${invalid}"`)
      }

      await closeProfilePopup(page)
      await page.waitForTimeout(100)
    })

    await check('[V6] Успешен grant: popup остава отворен, VIP редът се обновява ВЕДНАГА, без generic Lobby render', async () => {
      const targetProfileId = 'vipgrant-success-target'
      const targetDisplayName = 'Success Target'
      await openForeignProfilePopupAs('admin', targetProfileId, targetDisplayName, {})

      const vipRowBefore = await page.evaluate(() => document.querySelector('[data-player-profile-foreign-vip-days="1"]') !== null)
      assert(!vipRowBefore, 'преди grant-а не трябва да има VIP ред (профилът няма VIP)')

      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.clickVipGrantOpen())
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.isVipGrantFormOpen() === true, undefined, { timeout: 3000 })

      const newActiveUntil = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString()
      await page.evaluate(
        ({ pid, name, au }) => (window as any).__topicsSwitchRaceHarness.setNextAdminGrantVipSuccess(pid, name, { isVip: true, vipActiveUntil: au }),
        { pid: targetProfileId, name: targetDisplayName, au: newActiveUntil },
      )
      await page.evaluate((v) => (window as any).__topicsSwitchRaceHarness.setVipGrantDaysInput(v), '15')

      const renderCountBeforeSubmit = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getRenderLobbyScreenCallCount())
      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.submitVipGrantForm())
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.isVipGrantFormOpen() === false, undefined, { timeout: 3000 })
      const renderCountAfterSubmit = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getRenderLobbyScreenCallCount())
      assert(
        renderCountAfterSubmit === renderCountBeforeSubmit,
        `успешен grant не трябва да минава през generic renderLobbyScreen(): преди=${renderCountBeforeSubmit}, след=${renderCountAfterSubmit}`,
      )

      const popupStillOpen = await page.evaluate(() => document.querySelector('[data-player-profile-popup-root="1"]') !== null)
      assert(popupStillOpen, 'profile popup-ът трябва да остане отворен след успешен grant')

      const vipRowText = await page.evaluate(() => document.querySelector('[data-player-profile-foreign-vip-days="1"]')?.textContent ?? null)
      assert(vipRowText?.includes('15 дни') ?? false, `VIP редът трябва веднага да покаже "15 дни", получих "${vipRowText}"`)

      await closeProfilePopup(page)
      await page.waitForTimeout(100)
    })

    await check('[V7] Grant грешка от сървъра: popup + формата остават отворени, VIP статусът НЕ се променя локално', async () => {
      const targetProfileId = 'vipgrant-error-target'
      const targetDisplayName = 'Error Target'
      await openForeignProfilePopupAs('admin', targetProfileId, targetDisplayName, {})

      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.clickVipGrantOpen())
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.isVipGrantFormOpen() === true, undefined, { timeout: 3000 })
      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.setNextAdminGrantVipError('Сървърна грешка при grant.'))
      await page.evaluate((v) => (window as any).__topicsSwitchRaceHarness.setVipGrantDaysInput(v), '10')
      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.submitVipGrantForm())
      await page.waitForTimeout(100)

      const errorText = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getVipGrantErrorText())
      assert(errorText?.includes('Сървърна грешка') ?? false, `очаквах видимо съобщение за грешка, получих "${errorText}"`)

      const formStillOpen = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.isVipGrantFormOpen())
      assert(formStillOpen, 'формата трябва да остане отворена при грешка')

      const popupStillOpen = await page.evaluate(() => document.querySelector('[data-player-profile-popup-root="1"]') !== null)
      assert(popupStillOpen, 'profile popup-ът трябва да остане отворен при грешка')

      const vipRowExists = await page.evaluate(() => document.querySelector('[data-player-profile-foreign-vip-days="1"]') !== null)
      assert(!vipRowExists, 'при грешка VIP статусът НЕ трябва да се е променил локално (все още без VIP)')

      await closeProfilePopup(page)
      await page.waitForTimeout(100)
    })

    await check('[V8] Няма JS грешки в конзолата по време на "Дай VIP" сценариите', () => {
      assert(errors.length === 0, `Конзолни грешки: ${errors.join(' | ')}`)
    })

    await context.close()
  })()

  // ─── "Дай VIP" НЕ се показва в own profile (отделен, чист context) ──────
  await (async () => {
    const context: BrowserContext = await browser!.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })
    // Начален render — production main.ts прави същото веднъж при boot;
    // без него data-lobby-profile-button не съществува все още в DOM-а.
    await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.render())

    await check('[V3] admin viewer в own profile НЕ вижда "Дай VIP"', async () => {
      await page.evaluate((r) => (window as any).__topicsSwitchRaceHarness.setOwnAccountRole(r), 'admin')
      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.openOwnProfile())
      await page.waitForSelector('[data-player-profile-popup-root="1"]', { state: 'attached', timeout: 3000 })
      await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness.getOwnVipStatusPendingCount() > 0, undefined, { timeout: 3000 })
      await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.deliverOwnVipStatus(null))
      await page.waitForTimeout(80)
      const visible = await page.evaluate(() => (window as any).__topicsSwitchRaceHarness.isVipGrantTriggerVisible())
      assert(!visible, '"Дай VIP" не трябва да се показва в own profile, дори за admin')
      await closeProfilePopup(page)
      await page.waitForTimeout(100)
    })

    await context.close()
  })()
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
