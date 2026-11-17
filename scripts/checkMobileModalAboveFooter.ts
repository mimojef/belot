/**
 * checkMobileModalAboveFooter.ts — мобилната рамка: докато е отворен модален
 * прозорец (цялоекранен overlay с inline position:fixed + inset:0), footer-ът
 * („За Pika.bg“, „Общи условия“, ...) е скрит с visibility:hidden и се връща
 * при затваряне. Причина: в iOS Safari/PWA хоризонталният ред бутони на
 * footer-а излизаше над „Създай игра“ (Не се сърди човече) и закриваше
 * бутоните. Реалният клиент (Vite) срещу изолиран сървър (giftBackTestHarness),
 * Chromium + WebKit.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkMobileModalAboveFooter.ts
 *
 * Скрийншоти: <tmp>/belot-v2-mobile-modal-footer/*.png
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { webkit, type Browser, type Page } from 'playwright'
import { assert, check, finishAndExit, startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckMobileModalAboveFooter\n')

const OUT = join(tmpdir(), 'belot-v2-mobile-modal-footer')
await mkdir(OUT, { recursive: true })

const h = await startGiftBackHarness()
const wk = await webkit.launch()

type Box = { rect: number[]; visibility: string; position: string; zIndex: string; willChange: string }

try {
  h.db.prepare('DELETE FROM registration_rate_limit_events').run()
  const profile = await h.register('mmf')

  async function open(browser: Browser, width: number, height: number, mobile: boolean, who: TestProfile | null, path: string, ready: string): Promise<{ page: Page; close: () => Promise<void> }> {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
    if (who) await context.addCookies([{ name: 'belot_session', value: who.cookie, url: h.backendOrigin }])
    await context.addInitScript(() => {
      try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch { /* ignore */ }
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => console.error(`    pageerror: ${error.message}`))
    await page.goto(`${h.appOrigin}${path}`)
    await page.locator(ready).first().waitFor({ timeout: 30_000 })
    await page.waitForTimeout(800)
    return { page, close: () => context.close() }
  }

  const box = (page: Page, selector: string): Promise<Box> => page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    // Позиция в съдържанието на root-а (кликът може да скролира root-а).
    const scrollTop = cs.position === 'fixed' ? 0 : (document.querySelector('[data-lobby-screen-root="1"]')?.scrollTop ?? 0)
    return { rect: [r.left, r.top + scrollTop, r.width, r.height], visibility: cs.visibility, position: cs.position, zIndex: cs.zIndex, willChange: cs.willChange }
  })
  const FOOTER = '[data-lobby-screen-root="1"] > footer'
  const NAV = '[data-lobby-guest-bottom-nav="1"]'
  const same = (a: Box, b: Box) => JSON.stringify(a.rect) === JSON.stringify(b.rect)

  for (const [engine, browser] of [['chromium', h.browser], ['webkit', wk]] as const) {
    for (const height of [664, 844]) {
      const label = `${engine} 390x${height}`
      const ui = await open(browser, 390, height, true, profile, '/games/ludo', '[data-ludo-create-open]')
      try {
        const footer0 = await box(ui.page, FOOTER)
        const nav0 = await box(ui.page, NAV)
        await check(`${label}: затворен модал — footer видим, static, без z-index/will-change`, () => {
          assert(footer0.visibility === 'visible' && footer0.position === 'static' && footer0.zIndex === 'auto' && footer0.willChange === 'auto', JSON.stringify(footer0))
        })
        await ui.page.locator('[data-ludo-create-open]').first().click()
        await ui.page.locator('[data-ludo-create-form]').waitFor()
        await ui.page.waitForTimeout(300)
        await ui.page.screenshot({ path: join(OUT, `${engine}-${height}-ludo-create.png`) })
        await check(`${label}: „Създай игра“ отворен — footer скрит, на същото място (без разместване)`, async () => {
          const f = await box(ui.page, FOOTER)
          assert(f.visibility === 'hidden' && same(f, footer0), `${JSON.stringify(footer0)} → ${JSON.stringify(f)}`)
        })
        await check(`${label}: „Създай игра“ отворен — долната навигация непроменена`, async () => {
          const n = await box(ui.page, NAV)
          assert(JSON.stringify(n) === JSON.stringify(nav0), `${JSON.stringify(nav0)} → ${JSON.stringify(n)}`)
        })
        await check(`${label}: бутоните и полетата на модала са най-отгоре (hit-test)`, async () => {
          const hits = await ui.page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-ludo-create-form] button, [data-ludo-create-form] select, [data-ludo-create-form] input')).map((el) => {
            const r = el.getBoundingClientRect()
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            return { ok: !!hit && (hit === el || el.contains(hit) || hit.closest('label')?.contains(el) === true), name: el.textContent?.trim() || el.getAttribute('name') }
          }))
          assert(hits.length >= 4 && hits.every((x) => x.ok), JSON.stringify(hits))
        })
        await check(`${label}: без will-change върху backdrop-а (премахнатото правило)`, async () => {
          const wc = await ui.page.locator('[data-ludo-create-backdrop]').evaluate((el) => getComputedStyle(el).willChange)
          assert(wc === 'auto', wc)
        })
        await ui.page.locator('[data-ludo-create-close]').click()
        await ui.page.waitForTimeout(300)
        await check(`${label}: след затваряне footer-ът е видим и на същото място`, async () => {
          const f = await box(ui.page, FOOTER)
          assert(JSON.stringify(f) === JSON.stringify(footer0), `${JSON.stringify(footer0)} → ${JSON.stringify(f)}`)
        })
        // Менюто не е модал — footer-ът остава видим.
        await ui.page.locator('[data-lobby-guest-bottom-menu="1"]').first().click()
        await ui.page.waitForTimeout(400)
        await check(`${label}: отворено меню — footer-ът остава видим`, async () => {
          const open = await ui.page.locator('[data-lobby-mobile-menu="1"]').evaluate((el) => (el as HTMLDetailsElement).open)
          const f = await box(ui.page, FOOTER)
          assert(open && f.visibility === 'visible', `menuOpen=${open} ${JSON.stringify(f)}`)
        })
      } finally {
        await ui.close()
      }

      // Друг модал: гост → „Създай игра“ (Не се сърди човече) → прозорецът за вход/регистрация.
      const guest = await open(browser, 390, height, true, null, '/lobby', '[data-lobby-guest-ludo-create="1"]')
      try {
        const footer0 = await box(guest.page, FOOTER)
        await guest.page.locator('[data-lobby-guest-ludo-create="1"]').first().click()
        await guest.page.locator('[data-lobby-guest-auth-modal="1"]').first().waitFor()
        await guest.page.waitForTimeout(300)
        await guest.page.screenshot({ path: join(OUT, `${engine}-${height}-guest-auth.png`) })
        await check(`${label}: гост, прозорец за вход — footer скрит, без разместване`, async () => {
          const f = await box(guest.page, FOOTER)
          assert(footer0.visibility === 'visible' && f.visibility === 'hidden' && same(f, footer0), `${JSON.stringify(footer0)} → ${JSON.stringify(f)}`)
        })
      } finally {
        await guest.close()
      }
    }
  }

  // Desktop: правилото е само за телефонната рамка.
  const desk = await open(h.browser, 1280, 850, false, profile, '/games/ludo', '[data-ludo-create-open]')
  try {
    await desk.page.locator('[data-ludo-create-open]').first().click()
    await desk.page.locator('[data-ludo-create-form]').waitFor()
    await desk.page.screenshot({ path: join(OUT, 'desktop-ludo-create.png') })
    await check('desktop 1280: без мобилната рамка, footer-ът остава видим при отворен модал', async () => {
      const s = await desk.page.evaluate(() => ({
        mobileRoot: document.querySelectorAll('[data-mobile-layout="1"]').length,
        footers: Array.from(document.querySelectorAll('footer')).map((el) => getComputedStyle(el).visibility),
      }))
      assert(s.mobileRoot === 0 && s.footers.length > 0 && s.footers.every((v) => v === 'visible'), JSON.stringify(s))
    })
  } finally {
    await desk.close()
  }
} finally {
  await wk.close()
  await h.close()
}

console.log(`\n  Скрийншоти: ${OUT}`)
finishAndExit()
