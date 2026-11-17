/**
 * checkMobileModalAboveFooter.ts — мобилната рамка: цялоекранните overlay-и
 * (position:fixed + inset:0 — backdrop-ите на модалите и менюто) вътре в
 * скролиращия root получават собствен композитен слой (will-change:opacity),
 * за да не се рисуват под вложения хоризонтален скролер на footer-а в iOS
 * Safari. Останалите fixed елементи (долна навигация, toast-ове) — без промяна. Реалният клиент (Vite) срещу
 * изолиран сървър (giftBackTestHarness), Chromium + WebKit.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkMobileModalAboveFooter.ts
 *
 * Скрийншоти: <tmp>/belot-v2-mobile-modal-footer/*.png
 *
 * Бележка: самото неправилно наслагване е специфично за iOS (async overflow
 * scrolling) и не се възпроизвежда в Playwright WebKit/Chromium — тук се
 * проверяват условието за фикса, hit-test-ът, footer-ът при затворен модал и
 * desktop контролата.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { webkit, type Browser, type Page } from 'playwright'
import { assert, check, finishAndExit, startGiftBackHarness } from './giftBackTestHarness'

console.log('\ncheckMobileModalAboveFooter\n')

const OUT = join(tmpdir(), 'belot-v2-mobile-modal-footer')
await mkdir(OUT, { recursive: true })

const h = await startGiftBackHarness()
const wk = await webkit.launch()

type FooterGeometry = { rect: number[]; position: string; zIndex: string; willChange: string; margin: string }

try {
  h.db.prepare('DELETE FROM registration_rate_limit_events').run()
  const profile = await h.register('mmf')

  async function open(browser: Browser, width: number, height: number, mobile: boolean): Promise<{ page: Page; close: () => Promise<void> }> {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
    await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
    await context.addInitScript(() => {
      try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch { /* ignore */ }
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => console.error(`    pageerror: ${error.message}`))
    await page.goto(`${h.appOrigin}/games/ludo`)
    await page.locator('[data-ludo-create-open]').first().waitFor({ timeout: 30_000 })
    await page.waitForTimeout(800)
    return { page, close: () => context.close() }
  }

  const footerGeometry = (page: Page): Promise<FooterGeometry> => page.evaluate(() => {
    const footer = document.querySelector('[data-lobby-screen-root="1"] footer') as HTMLElement
    const r = footer.getBoundingClientRect()
    const cs = getComputedStyle(footer)
    return { rect: [r.left, r.top, r.width, r.height], position: cs.position, zIndex: cs.zIndex, willChange: cs.willChange, margin: cs.margin }
  })

  // Видимите цялоекранни position:fixed overlay-и в мобилния root, които НЕ
  // са композирани по собствена причина (backdrop-filter/will-change/transform).
  const uncompositedFixed = (page: Page): Promise<string[]> => page.evaluate(() => {
    const root = document.querySelector('[data-lobby-screen-root="1"]')!
    return Array.from(root.querySelectorAll<HTMLElement>('*')).filter((el) => {
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed') return false
      const r = el.getBoundingClientRect()
      if (r.width < innerWidth || r.height < innerHeight) return false
      const backdrop = cs.getPropertyValue('backdrop-filter') || cs.getPropertyValue('-webkit-backdrop-filter')
      return cs.willChange === 'auto' && cs.transform === 'none' && (!backdrop || backdrop === 'none')
    }).map((el) => `${el.tagName}[${Array.from(el.attributes).filter((a) => a.name.startsWith('data-')).map((a) => a.name).join(',')}]`)
  })

  for (const [engine, browser] of [['chromium', h.browser], ['webkit', wk]] as const) {
    for (const height of [664, 844]) {
      const label = `${engine} 390x${height}`
      const ui = await open(browser, 390, height, true)
      try {
        const before = await footerGeometry(ui.page)
        await check(`${label}: footer при затворен модал — static, без z-index/will-change`, () => {
          assert(before.position === 'static' && before.zIndex === 'auto' && before.willChange === 'auto', JSON.stringify(before))
        })
        await ui.page.locator('[data-ludo-create-open]').first().click()
        await ui.page.locator('[data-ludo-create-form]').waitFor()
        await ui.page.waitForTimeout(400)
        await ui.page.screenshot({ path: join(OUT, `${engine}-${height}-ludo-create.png`) })
        await check(`${label}: backdrop на "Създай игра" е с will-change:opacity и z-index 9500`, async () => {
          const s = await ui.page.locator('[data-ludo-create-backdrop]').evaluate((el) => { const cs = getComputedStyle(el); return { wc: cs.willChange, z: cs.zIndex, pos: cs.position, tr: cs.transform } })
          assert(s.wc === 'opacity' && s.z === '9500' && s.pos === 'fixed' && s.tr === 'none', JSON.stringify(s))
        })
        await check(`${label}: бутоните на модала са най-отгоре (hit-test), footer-ът не ги закрива`, async () => {
          const hits = await ui.page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-ludo-create-form] button, [data-ludo-create-form] select, [data-ludo-create-form] input')).map((el) => {
            const r = el.getBoundingClientRect()
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            return { ok: !!hit && (hit === el || el.contains(hit) || hit.closest('label')?.contains(el) === true), inFooter: !!hit?.closest('footer'), name: el.textContent?.trim() || el.getAttribute('name') }
          }))
          assert(hits.length >= 4 && hits.every((x) => x.ok && !x.inFooter), JSON.stringify(hits))
        })
        await check(`${label}: всички цялоекранни overlay-и в мобилния root имат собствен слой`, async () => {
          const bad = await uncompositedFixed(ui.page)
          assert(bad.length === 0, bad.join(' | '))
        })
        await check(`${label}: не-цялоекранните fixed елементи (долна навигация и т.н.) са без will-change`, async () => {
          const touched = await ui.page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-lobby-screen-root="1"] *')).filter((el) => {
            const cs = getComputedStyle(el)
            return cs.position === 'fixed' && !/inset: ?0/.test(el.getAttribute('style') ?? '') && cs.willChange !== 'auto'
          }).map((el) => el.outerHTML.slice(0, 80)))
          const nav = await ui.page.locator('[data-lobby-guest-bottom-nav="1"]').evaluate((el) => getComputedStyle(el).willChange)
          assert(touched.length === 0 && nav === 'auto', `${nav} ${touched.join(' | ')}`)
        })
        await check(`${label}: footer-ът е непроменен докато модалът е отворен`, async () => {
          const during = await footerGeometry(ui.page)
          assert(JSON.stringify(during) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(during)}`)
        })
        await ui.page.locator('[data-ludo-create-close]').click()
        await ui.page.waitForTimeout(300)
        await check(`${label}: след затваряне footer-ът е на същото място`, async () => {
          const after = await footerGeometry(ui.page)
          assert(JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(after)}`)
          assert((await ui.page.locator('[data-ludo-create-backdrop]').count()) === 0, 'backdrop остана')
        })
        // Менюто (долната навигация → "Меню") — друг fixed overlay в root-а.
        await ui.page.locator('[data-lobby-guest-bottom-menu="1"]').first().click()
        await ui.page.waitForTimeout(400)
        await ui.page.screenshot({ path: join(OUT, `${engine}-${height}-menu.png`) })
        await check(`${label}: отвореното меню — всички цялоекранни overlay-и имат собствен слой`, async () => {
          const bad = await uncompositedFixed(ui.page)
          assert(bad.length === 0, bad.join(' | '))
        })
      } finally {
        await ui.close()
      }
    }
  }

  // Desktop: правилото е само за телефонната рамка.
  const desk = await open(h.browser, 1280, 850, false)
  try {
    await desk.page.locator('[data-ludo-create-open]').first().click()
    await desk.page.locator('[data-ludo-create-form]').waitFor()
    await desk.page.screenshot({ path: join(OUT, 'desktop-ludo-create.png') })
    await check('desktop 1280: без мобилната рамка и без will-change върху backdrop-а', async () => {
      const s = await desk.page.evaluate(() => ({
        mobileRoot: document.querySelectorAll('[data-mobile-layout="1"]').length,
        wc: getComputedStyle(document.querySelector('[data-ludo-create-backdrop]')!).willChange,
      }))
      assert(s.mobileRoot === 0 && s.wc === 'auto', JSON.stringify(s))
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
