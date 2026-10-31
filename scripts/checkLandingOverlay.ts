/**
 * checkLandingOverlay.ts
 *
 * Landing overlay — real browser (Playwright) срещу реалния main.ts през
 * Vite dev сървър. Без backend. Мобилният редизайн засяга САМО телефонния
 * вариант; desktop/таблет вариантът трябва да е идентичен с оригинала
 * (scripts/fixtures/landingDesktopBaseline.json, генериран от изходния код
 * преди редизайна).
 *
 *   [V1]  вариантът се избира по оригиналното условие
 *         isPhoneLayoutViewport() || (innerWidth <= 640 && portrait)
 *   Телефон (нов вертикален банер):
 *   [L1]  банерът е зареден, пропорцията 894:1758 е запазена, ширината е
 *         min(налична, 480px) независимо от височината, няма хоризонтален
 *         скрол, скролва се само зоната с банера, бутонът е фиксиран долу
 *         (не се мести при скрол) и никога не закрива банера, подравнен е с
 *         колоната на банера; банерът започва точно от горния край
 *   [L2]  телефон в portrait: банерът е на цялата ширина на екрана
 *   [L3]  бутонът: лек 3D вид (.pwa-cta-3d — градиент около #7950E8,
 *         вътрешни сенки), при :active потъва с 1px
 *   Desktop/таблет (оригинален хоризонтален лендинг):
 *   [D1]  оригиналното изображение и бутон (без .pwa-cta-glow)
 *   [D2]  DOM идентичен с baseline-а (overlay cssText + innerHTML)
 *   [D3]  pixel-идентичен screenshot спрямо baseline-а, рендериран в същата
 *         страница
 *   [D4]  геометрия: 1672:941, вписан във viewport-а, бутонът е в (22%, 63%)
 *   [D5]  hover стойности = оригиналните
 *   Поведение (телефон и desktop):
 *   [B1]  "/" показва overlay-я; "/lobby" не го показва
 *   [B2]  без install prompt: click -> overlay-ят изчезва, URL = /lobby
 *   [B3]  beforeinstallprompt + accepted: prompt() веднъж, "Инсталиране...",
 *         после overlay-ят изчезва, URL = /lobby
 *   [B4]  beforeinstallprompt + dismissed: същото, текстът се възстановява
 *   [B5]  standalone (display-mode) -> overlay не се показва
 *   [R1]  source review: id-та, PWA извиквания, /lobby, removeLandingOverlay,
 *         lobby syncUrlPath guard
 *   [R2]  оригиналният desktop банер и изходните PNG-та са запазени
 *
 * Употреба: node scripts/checkLandingOverlay.ts [--screenshots=DIR]
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { readFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

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
function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      const { port } = address
      srv.close(() => resolveFree(port))
    })
  })
}

const BANNER_SRC = '/assets/landing-page/landing-mobile-v2.webp'
const BANNER_W = 894
const BANNER_H = 1758
// Долният край на последния ред информационни картички (вкл. сянката) в
// пикселите на банера; под тях банерът продължава с декоративна долна част.
const BANNER_CARDS_BOTTOM = 1420
// Долен padding на зоната с бутона (без safe-area — 0 в Playwright).
const BOTTOM_PADDING_PX = 12
// .pwa-cta-glow пулсира до scale(1.025) — getBoundingClientRect го включва.
const CTA_PULSE_MAX_SCALE = 1.025

type DesktopBaseline = {
  overlayCssText: string
  innerHTML: string
  hover: Record<'enter' | 'leave', { filter: string; transform: string; boxShadow: string }>
}
const desktopBaseline = JSON.parse(await readFile('scripts/fixtures/landingDesktopBaseline.json', 'utf8')) as DesktopBaseline

const screenshotsArg = process.argv.find((a) => a.startsWith('--screenshots='))
const screenshotsDir = screenshotsArg ? screenshotsArg.slice('--screenshots='.length) : null

// touch: isMobile + hasTouch (coarse pointer) емулация.
type Viewport = { name: string; width: number; height: number; touch: boolean; fullWidth?: boolean }
const MOBILE_VIEWPORTS: Viewport[] = [
  { name: 'phone-360x640', width: 360, height: 640, touch: true, fullWidth: true },
  { name: 'phone-360x800', width: 360, height: 800, touch: true, fullWidth: true },
  { name: 'phone-360x780', width: 360, height: 780, touch: true, fullWidth: true },
  { name: 'phone-375x667', width: 375, height: 667, touch: true, fullWidth: true },
  { name: 'phone-390x844', width: 390, height: 844, touch: true, fullWidth: true },
  { name: 'phone-412x915', width: 412, height: 915, touch: true, fullWidth: true },
  { name: 'phone-440x956', width: 440, height: 956, touch: true, fullWidth: true },
  { name: 'phone-414x896', width: 414, height: 896, touch: true, fullWidth: true },
  { name: 'phone-390x664-safari-toolbars', width: 390, height: 664, touch: true, fullWidth: true },
  { name: 'phone-320x568', width: 320, height: 568, touch: true, fullWidth: true },
  { name: 'phone-landscape-844x390', width: 844, height: 390, touch: true },
  { name: 'narrow-portrait-window-600x960', width: 600, height: 960, touch: false },
]
const DESKTOP_VIEWPORTS: Viewport[] = [
  { name: 'tablet-768x1024', width: 768, height: 1024, touch: true },
  { name: 'tablet-820x1180', width: 820, height: 1180, touch: true },
  { name: 'tablet-1024x768', width: 1024, height: 768, touch: true },
  { name: 'tablet-1180x820', width: 1180, height: 820, touch: true },
  { name: 'desktop-700x1000', width: 700, height: 1000, touch: false },
  { name: 'desktop-1280x720', width: 1280, height: 720, touch: false },
  { name: 'desktop-1366x768', width: 1366, height: 768, touch: false },
  { name: 'desktop-1920x1080', width: 1920, height: 1080, touch: false },
]

console.log('\ncheckLandingOverlay\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const origin = `http://127.0.0.1:${port}`
  browser = await chromium.launch()
  if (screenshotsDir) await mkdir(screenshotsDir, { recursive: true })

  async function openPage(path: string, vp: Viewport, initScript?: string): Promise<Page> {
    const context = await browser!.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.touch,
      hasTouch: vp.touch,
      deviceScaleFactor: vp.touch ? 2 : 1,
    })
    if (initScript) await context.addInitScript(initScript)
    const page = await context.newPage()
    await page.goto(origin + path)
    return page
  }
  async function waitForBanner(page: Page): Promise<void> {
    await page.waitForSelector('#pwa-landing-overlay img', { timeout: 15_000 })
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('#pwa-landing-overlay img')
      return img !== null && img.complete && img.naturalWidth > 0
    }, undefined, { timeout: 15_000 })
  }
  // Оригиналното условие за телефонен вариант (viewportStage.ts
  // isPhoneLayoutViewport + landing-ския narrow portrait), изчислено в
  // браузъра — за да докаже, че вариантът следва него, а не нов breakpoint.
  function expectsMobileVariant(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const w = window.innerWidth
      const h = window.innerHeight
      const shortSide = Math.min(w, h)
      const longSide = Math.max(w, h)
      const isCoarseTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches
      const isNarrowPortrait = h > w && shortSide <= 640 && longSide <= 1200
      const isPhone = (isCoarseTouch && shortSide <= 480 && longSide <= 1050) || isNarrowPortrait
      return isPhone || (w <= 640 && h > w)
    })
  }

  // ── Телефон: L1/L2 ───────────────────────────────────────────────────────
  for (const vp of MOBILE_VIEWPORTS) {
    const page = await openPage('/', vp)
    await waitForBanner(page)
    await check(`[V1] ${vp.name}: original phone condition -> new mobile landing`, async () => {
      assert(await expectsMobileVariant(page), 'original condition does not select the phone variant here')
      assert(await page.locator('#pwa-landing-scroll').count() === 1, 'mobile landing not rendered')
    })
    const m = await page.evaluate(() => {
      const overlay = document.getElementById('pwa-landing-overlay')!
      const scroll = document.getElementById('pwa-landing-scroll')!
      const img = scroll.querySelector<HTMLImageElement>('img')!
      const btn = overlay.querySelector<HTMLButtonElement>('#pwa-install-btn')!
      const r = (el: Element) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height } }
      const snap = () => ({ img: r(img), btn: r(btn), scroll: r(scroll) })
      const before = snap()
      scroll.scrollTop = scroll.scrollHeight
      const after = snap()
      scroll.scrollTop = 0
      return {
        src: img.currentSrc, naturalW: img.naturalWidth, naturalH: img.naturalHeight,
        before, after, btnText: btn.textContent?.trim(),
        btnInScroll: scroll.contains(btn),
        overlayScrollW: overlay.scrollWidth, overlayClientW: overlay.clientWidth,
        overlayScrollH: overlay.scrollHeight, overlayClientH: overlay.clientHeight,
        scrollScrollW: scroll.scrollWidth, scrollClientW: scroll.clientWidth,
        scrollScrollH: scroll.scrollHeight, scrollClientH: scroll.clientHeight,
        docScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, innerH: window.innerHeight,
        h1: overlay.querySelector('h1')?.textContent?.trim() ?? null,
        h1Size: (() => { const h = overlay.querySelector('h1'); return h ? r(h) : null })(),
        alt: img.alt,
      }
    })
    const { img, btn, scroll } = m.before
    const vScroll = m.scrollScrollH - m.scrollClientH
    const contentBottom = img.top + img.height * (BANNER_CARDS_BOTTOM / BANNER_H)
    console.log(`  ·     ${vp.name}: banner ${img.width.toFixed(0)}×${img.height.toFixed(0)}, image-zone scroll ${vScroll}px, space above/below banner ${(img.top - scroll.top).toFixed(0)}/${(scroll.bottom - img.bottom).toFixed(0)}px, cards→button ${(btn.top - contentBottom).toFixed(0)}px`)

    await check(`[L1] ${vp.name}: banner loaded (webp ${BANNER_W}×${BANNER_H})`, () => {
      assert(new URL(m.src).pathname === BANNER_SRC, `src=${m.src}`)
      assert(m.naturalW === BANNER_W && m.naturalH === BANNER_H, `natural ${m.naturalW}×${m.naturalH}`)
    })
    await check(`[L1] ${vp.name}: aspect ratio preserved`, () => {
      const ratio = img.width / img.height
      assert(Math.abs(ratio - BANNER_W / BANNER_H) < 0.004, `rendered ratio ${ratio}`)
    })
    await check(`[L1] ${vp.name}: no horizontal overflow; only the image zone may scroll`, () => {
      assert(m.overlayScrollW <= m.overlayClientW, `overlay scrollWidth ${m.overlayScrollW} > ${m.overlayClientW}`)
      assert(m.scrollScrollW <= m.scrollClientW, `image zone scrollWidth ${m.scrollScrollW} > ${m.scrollClientW}`)
      assert(m.docScrollW <= m.innerW, `document scrollWidth ${m.docScrollW} > ${m.innerW}`)
      assert(m.overlayScrollH <= m.overlayClientH, 'overlay itself scrolls')
      assert(img.left >= -0.5 && img.right <= m.innerW + 0.5, `img x ${img.left}..${img.right}`)
    })
    await check(`[L1] ${vp.name}: width = min(available width, 480px), independent of height`, () => {
      const expected = Math.min(m.scrollClientW, 480)
      assert(Math.abs(img.width - expected) <= 0.5, `img width ${img.width}, expected ${expected}`)
    })
    await check(`[L1] ${vp.name}: button fixed at the bottom, unaffected by image scroll`, () => {
      assert(!m.btnInScroll, 'button is inside the scrollable image zone')
      for (const s of [m.before, m.after]) {
        const center = (s.btn.top + s.btn.bottom) / 2
        assert(Math.abs(center - (m.innerH - BOTTOM_PADDING_PX - 25)) <= 1, `button center ${center} (innerH ${m.innerH})`)
      }
      assert(Math.abs(m.after.btn.top - m.before.btn.top) < 0.5, 'button moved while scrolling the image')
      assert(btn.height >= 49.5 && btn.height <= 50 * CTA_PULSE_MAX_SCALE + 0.5, `button height ${btn.height}`)
      assert(m.btnText === 'Играй Белот Сега', `text ${m.btnText}`)
    })
    await check(`[L1] ${vp.name}: button never covers the banner`, () => {
      assert(scroll.bottom <= btn.top + 0.5, `image zone bottom ${scroll.bottom} > button top ${btn.top}`)
      // Скролнат до края: целият долен край на банера е видим над бутона.
      assert(m.after.img.bottom <= m.after.scroll.bottom + 0.5, `banner bottom ${m.after.img.bottom} hidden below ${m.after.scroll.bottom}`)
      if (vScroll <= 0) assert(img.top >= scroll.top - 0.5 && img.bottom <= scroll.bottom + 0.5, 'banner clipped without scroll')
    })
    await check(`[L1] ${vp.name}: button aligned with the banner column`, () => {
      const slack = img.width * (CTA_PULSE_MAX_SCALE - 1) / 2 + 0.5
      assert(btn.left >= img.left - slack && btn.right <= img.right + slack, `button ${btn.left}..${btn.right} vs banner ${img.left}..${img.right}`)
    })
    await check(`[L1] ${vp.name}: banner starts at the very top of the screen`, () => {
      assert(Math.abs(img.top - scroll.top) <= 0.5 && Math.abs(scroll.top) <= 0.5, `banner top ${img.top}, image zone top ${scroll.top}`)
    })
    await check(`[L1] ${vp.name}: accessible title + alt, visually hidden`, () => {
      assert(m.h1 === 'Pika.bg — Играй Белот Онлайн', `h1=${m.h1}`)
      assert(m.h1Size !== null && m.h1Size.width <= 1 && m.h1Size.height <= 1, 'h1 is visible')
      assert(m.alt.length > 20, 'missing alt')
    })
    if (vp.fullWidth) {
      await check(`[L2] ${vp.name}: banner uses the full screen width`, () => {
        assert(img.left <= 0.5 && Math.abs(img.width - m.innerW) <= 0.5, `img ${img.left}+${img.width} vs ${m.innerW}`)
      })
    }
    if (screenshotsDir) await page.screenshot({ path: join(screenshotsDir, `${vp.name}.png`) })
    await check(`[L3] ${vp.name}: subtle 3D button, slightly pressed on :active`, async () => {
      const read = () => page.evaluate(() => {
        const b = document.getElementById('pwa-install-btn')!
        const cs = getComputedStyle(b)
        return { cls: b.className, bg: cs.backgroundImage, shadow: cs.boxShadow, translate: cs.translate, inlineBg: b.style.background, inlineShadow: b.style.boxShadow }
      })
      const rest = await read()
      assert(rest.cls === 'pwa-cta-glow pwa-cta-3d', `class ${rest.cls}`)
      assert(rest.bg.startsWith('linear-gradient') && rest.bg.includes('rgb(121, 80, 232)'), `background ${rest.bg}`)
      assert(rest.shadow.includes('inset') && rest.inlineBg === '' && rest.inlineShadow === '', `shadow ${rest.shadow} / inline ${rest.inlineBg}|${rest.inlineShadow}`)
      assert(rest.translate === 'none', `translate at rest ${rest.translate}`)
      await page.mouse.move(btn.left + btn.width / 2, btn.top + btn.height / 2)
      await page.mouse.down()
      await page.waitForTimeout(200)
      const pressed = await read()
      if (screenshotsDir) await page.screenshot({ path: join(screenshotsDir, `${vp.name}-pressed.png`), clip: { x: 0, y: btn.top - 16, width: m.innerW, height: btn.height + 32 } })
      await page.mouse.up()
      assert(pressed.translate === '0px 1px', `translate when pressed ${pressed.translate}`)
      assert(pressed.shadow !== rest.shadow, 'shadow does not change when pressed')
    })
    await page.context().close()
  }

  // ── Desktop/таблет: D1-D5 (оригиналът, непроменен) ───────────────────────
  for (const vp of DESKTOP_VIEWPORTS) {
    const page = await openPage('/', vp)
    await waitForBanner(page)
    await check(`[V1] ${vp.name}: original condition -> original desktop landing`, async () => {
      assert(!(await expectsMobileVariant(page)), 'original condition selects the phone variant here')
      assert(await page.locator('#pwa-landing-scroll').count() === 0, 'mobile landing rendered on desktop/tablet')
    })
    await check(`[D1] ${vp.name}: original image and button (no .pwa-cta-glow)`, async () => {
      const d = await page.evaluate(() => {
        const overlay = document.getElementById('pwa-landing-overlay')!
        const img = overlay.querySelector<HTMLImageElement>('img')!
        const btn = overlay.querySelector<HTMLButtonElement>('#pwa-install-btn')!
        return { src: img.currentSrc, btnClass: btn.className, btnText: btn.textContent?.trim() }
      })
      assert(d.src.endsWith('/assets/landing-page/landing-page.webp'), `src=${d.src}`)
      assert(d.btnClass === '', `button class "${d.btnClass}"`)
      assert(d.btnText === 'Играй Белот Сега', `text ${d.btnText}`)
    })
    await check(`[D2] ${vp.name}: DOM identical to the pre-redesign baseline`, async () => {
      const d = await page.evaluate((b) => {
        const overlay = document.getElementById('pwa-landing-overlay')!
        const ref = document.createElement('div')
        ref.style.cssText = b.overlayCssText
        const tpl = document.createElement('template')
        tpl.innerHTML = b.innerHTML
        return { cssOk: overlay.style.cssText === ref.style.cssText, htmlOk: overlay.innerHTML === tpl.innerHTML, css: overlay.style.cssText, refCss: ref.style.cssText }
      }, desktopBaseline)
      assert(d.cssOk, `overlay style differs:\n    ${d.css}\n    ${d.refCss}`)
      assert(d.htmlOk, 'overlay markup differs from baseline')
    })
    await check(`[D4] ${vp.name}: geometry (1672:941, fits viewport, button at 22%/63%)`, async () => {
      const g = await page.evaluate(() => {
        const overlay = document.getElementById('pwa-landing-overlay')!
        const img = overlay.querySelector('img')!.getBoundingClientRect()
        const btnWrap = overlay.querySelector('#pwa-install-btn')!.parentElement!.getBoundingClientRect()
        return { img: { l: img.left, t: img.top, w: img.width, h: img.height, r: img.right, b: img.bottom }, cx: btnWrap.left + btnWrap.width / 2, cy: btnWrap.top + btnWrap.height / 2, iw: window.innerWidth, ih: window.innerHeight, sw: document.documentElement.scrollWidth }
      })
      assert(Math.abs(g.img.w / g.img.h - 1672 / 941) < 0.004, `ratio ${g.img.w / g.img.h}`)
      assert(g.img.l >= -0.5 && g.img.r <= g.iw + 0.5 && g.img.t >= -0.5 && g.img.b <= g.ih + 0.5, 'banner outside viewport')
      assert(g.sw <= g.iw, `horizontal overflow ${g.sw}`)
      assert(Math.abs(g.cx - (g.img.l + g.img.w * 0.22)) <= 1 && Math.abs(g.cy - (g.img.t + g.img.h * 0.63)) <= 1, `button block center ${g.cx},${g.cy}`)
    })
    await check(`[D5] ${vp.name}: hover styles equal the original`, async () => {
      const h = await page.evaluate(() => {
        const btn = document.querySelector<HTMLButtonElement>('#pwa-install-btn')!
        const read = () => ({ filter: btn.style.filter, transform: btn.style.transform, boxShadow: btn.style.boxShadow })
        btn.dispatchEvent(new MouseEvent('mouseenter'))
        const enter = read()
        btn.dispatchEvent(new MouseEvent('mouseleave'))
        return { enter, leave: read() }
      })
      const norm = await page.evaluate((b) => {
        const el = document.createElement('div')
        const n = (s: { filter: string; transform: string; boxShadow: string }) => {
          el.style.filter = s.filter; el.style.transform = s.transform; el.style.boxShadow = s.boxShadow
          return { filter: el.style.filter, transform: el.style.transform, boxShadow: el.style.boxShadow }
        }
        return { enter: n(b.enter), leave: n(b.leave) }
      }, desktopBaseline.hover)
      assert(JSON.stringify(h) === JSON.stringify(norm), `hover ${JSON.stringify(h)} vs ${JSON.stringify(norm)}`)
    })
    await check(`[D3] ${vp.name}: pixel-identical to the baseline rendered in the same page`, async () => {
      await page.mouse.move(0, 0)
      const current = await page.screenshot()
      await page.evaluate((b) => {
        const old = document.getElementById('pwa-landing-overlay')!
        const ref = document.createElement('div')
        ref.id = 'pwa-landing-overlay'
        ref.style.cssText = b.overlayCssText
        ref.innerHTML = b.innerHTML
        old.replaceWith(ref)
      }, desktopBaseline)
      await waitForBanner(page)
      const baseline = await page.screenshot()
      assert(current.equals(baseline), 'screenshot differs from baseline')
    })
    if (screenshotsDir) await page.screenshot({ path: join(screenshotsDir, `${vp.name}.png`) })
    await page.context().close()
  }

  const VARIANTS: Array<[string, Viewport]> = [
    ['phone', MOBILE_VIEWPORTS[3]],
    ['desktop', DESKTOP_VIEWPORTS[6]],
  ]

  // ── B1: routes ───────────────────────────────────────────────────────────
  for (const [label, vp] of VARIANTS) {
    await check(`[B1] ${label}: /lobby does not show the landing overlay`, async () => {
      const page = await openPage('/lobby', vp)
      await page.waitForTimeout(1_000)
      assert(await page.locator('#pwa-landing-overlay').count() === 0, 'overlay present on /lobby')
      await page.context().close()
    })
  }

  // ── B2: click without install prompt ─────────────────────────────────────
  for (const [label, vp] of VARIANTS) {
    await check(`[B2] ${label}: no install prompt: click dismisses to /lobby`, async () => {
      const page = await openPage('/', vp)
      await waitForBanner(page)
      await page.click('#pwa-install-btn')
      await page.waitForFunction(() => document.getElementById('pwa-landing-overlay') === null, undefined, { timeout: 3_000 })
      assert(new URL(page.url()).pathname === '/lobby', `url ${page.url()}`)
      assert(await page.evaluate(() => document.body.style.overflow) === '', 'body overflow not restored')
      await page.context().close()
    })
  }

  // ── B3/B4: beforeinstallprompt ───────────────────────────────────────────
  for (const [label, vp] of VARIANTS) {
    for (const outcome of ['accepted', 'dismissed'] as const) {
      await check(`[B${outcome === 'accepted' ? 3 : 4}] ${label}: beforeinstallprompt + ${outcome}: prompt shown, then /lobby`, async () => {
        const page = await openPage('/', vp)
        await waitForBanner(page)
        await page.evaluate((result) => {
          const w = window as any
          w.__promptCalls = 0
          let resolveChoice!: (v: { outcome: string }) => void
          w.__resolveChoice = () => resolveChoice({ outcome: result })
          const e = new Event('beforeinstallprompt', { cancelable: true }) as any
          e.prompt = async () => { w.__promptCalls++ }
          e.userChoice = new Promise((r) => { resolveChoice = r })
          window.dispatchEvent(e)
        }, outcome)
        await page.click('#pwa-install-btn')
        await page.waitForFunction(() => (window as any).__promptCalls === 1)
        const mid = await page.evaluate(() => {
          const b = document.querySelector<HTMLButtonElement>('#pwa-install-btn')!
          return { text: b.textContent, disabled: b.disabled }
        })
        assert(mid.text === 'Инсталиране...' && mid.disabled, `while prompting: ${JSON.stringify(mid)}`)
        await page.evaluate(() => (window as any).__resolveChoice())
        if (outcome === 'dismissed') {
          const text = await page.evaluate(() => document.querySelector('#pwa-install-btn')?.textContent ?? null)
          assert(text === 'Играй Белот Сега', `text after dismiss ${text}`)
        }
        await page.waitForFunction(() => document.getElementById('pwa-landing-overlay') === null, undefined, { timeout: 3_000 })
        assert(new URL(page.url()).pathname === '/lobby', `url ${page.url()}`)
        assert(await page.evaluate(() => (window as any).__promptCalls) === 1, 'prompt called more than once')
        await page.context().close()
      })
    }
  }

  // ── B5: standalone ───────────────────────────────────────────────────────
  for (const [label, vp] of VARIANTS) {
    await check(`[B5] ${label}: standalone display-mode: no landing overlay on /`, async () => {
      const page = await openPage('/', vp, `
        const original = window.matchMedia.bind(window)
        window.matchMedia = (q) => q.includes('display-mode: standalone')
          ? { matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } }
          : original(q)
      `)
      await page.waitForTimeout(1_500)
      assert(await page.locator('#pwa-landing-overlay').count() === 0, 'overlay shown in standalone')
      await page.context().close()
    })
  }

  // ── R1: source review ────────────────────────────────────────────────────
  await check('[R1] source: PWA wiring, ids, phone condition and /lobby routing preserved', async () => {
    const main = await readFile('src/main.ts', 'utf8')
    const lobby = await readFile('src/app/lobby/createLobbyFlowController.ts', 'utf8')
    const pwa = await readFile('src/pwa.ts', 'utf8')
    const start = main.indexOf('function showLandingOverlay(')
    assert(start >= 0, 'showLandingOverlay missing')
    const end = main.indexOf('\nfunction ', start + 1)
    const body = main.slice(start, end >= 0 ? end : undefined)
    for (const needle of [
      "overlay.id = 'pwa-landing-overlay'",
      'id="pwa-install-btn"',
      'const isMobileLanding = isPhoneLayoutViewport() || isNarrowPortraitLanding',
      'canInstallPwa()',
      'await triggerPwaInstall()',
      "history.replaceState(null, '', '/lobby')",
      "btn.textContent = 'Инсталиране...'",
      "btn.textContent = 'Играй Белот Сега'",
    ]) assert(body.includes(needle), `showLandingOverlay lost: ${needle}`)
    assert(/const isNarrowPortraitLanding =\s*window\.innerWidth <= 640 &&\s*window\.innerHeight > window\.innerWidth/.test(body), 'narrow portrait condition changed')
    assert(/!isRunningAsStandalone\(\) && !_VALID_PATHS\.has\(_initialPath\)\)\s*\{\s*showLandingOverlay\(\)/.test(main), 'show condition changed')
    assert(main.includes("document.getElementById('pwa-landing-overlay')?.remove()"), 'removeLandingOverlay changed')
    assert(lobby.includes("document.getElementById('pwa-landing-overlay') !== null"), 'lobby syncUrlPath guard missing')
    assert(pwa.includes("addEventListener('beforeinstallprompt'") && pwa.includes('e.preventDefault()'), 'pwa.ts beforeinstallprompt handling changed')
  })
  await check('[R2] assets: original desktop banner and source PNGs are kept', async () => {
    for (const path of [
      'public/assets/landing-page/landing-page.webp',
      'temp/art-landing-mobile.png',
      'temp/art-landing-mobile-v2.png',
    ]) assert((await stat(path)).size > 0, `${path} is empty`)
  })
} catch (err) {
  fail('harness', err)
} finally {
  await browser?.close()
  await vite?.close()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
