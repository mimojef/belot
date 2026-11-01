/**
 * checkGuestMobileLobby.ts
 *
 * Мобилно лоби за гости (светъл редизайн) — real browser (Playwright) срещу
 * РЕАЛНИЯ createLobbyFlowController + renderLobbyScreen през Vite dev сървър
 * (scripts/fixtures/guestMobileLobbyPreview.html — гост сесия, тестови данни,
 * без backend). Редизайнът засяга САМО телефон + гост + изглед "tables";
 * всичко останало трябва да е байт-идентично с изходния код преди него
 * (scripts/fixtures/guestMobileLobbyBaseline.json).
 *
 *   [L1]  телефон (360/390/412): светъл фон; header = лого (изображение) +
 *         само "Гост" (без съобщения/меню горе); auth карта: само текстът с
 *         бонуса над "Вход"/"Регистрация" (без заглавие и илюстрация),
 *         банер "Публикации" с последната публикация, без хоризонтален
 *         overflow, без магазинни оферти, правни връзки в footer-а
 *   [L2]  "Белот": карта за ВСЯКА активна маса (изключената е скрита, редът
 *         е от сървъра), точно 2 изцяло видими, хоризонтален scroll до
 *         последната, само "Награда"/"Вход" (без "Играчи"), подравнени
 *         карти, "Играй" — гост-пробна (5000) без
 *         lock, останалите с data-lobby-stake-card-guest-locked
 *   [L3]  "Не се сърди човече" банер + частни маси/информационни редове със
 *         същите data-* атрибути и броячи; долна навигация с 5 елемента;
 *         всички икони са заредени
 *   [B1]  поведение: "Гост" → auth попъп (cta); пробна маса → guest trial попъп; заключена → попъп за
 *         заключена маса; Вход/Регистрация → auth модал; Теми и Чат → auth
 *         попъп (cta); "Не се сърди човече" (Създай игра, частни маси) →
 *         auth попъп (cta — Ludo изисква профил); Игри → "Игри"; Меню (долу)
 *         → менюто; Публикации → цял екран и обратно; Частни маси (Белот) →
 *         auth попъп (cta); Правила → /rules
 *   [B2]  Ludo flag изключен → без Ludo банер/ред; зареждане / няма маси
 *   [U1]  непроменено спрямо baseline-а: логнат телефон, гост извън
 *         "tables" на телефон, desktop и таблет (гост и логнат)
 *   [A1]  WebP иконите съществуват, с alpha (VP8X), оригиналните PNG в temp/
 *
 * Употреба: node scripts/checkGuestMobileLobby.ts [--screenshots=DIR]
 *           node scripts/checkGuestMobileLobby.ts --write-baseline  (само
 *           върху изходния код ПРЕДИ редизайна)
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
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

const HARNESS = '/scripts/fixtures/guestMobileLobbyPreview.html'
const BASELINE_PATH = 'scripts/fixtures/guestMobileLobbyBaseline.json'
const ICON_DIR = 'public/assets/lobby-mobile/icons'
const GUEST_TRIAL_STAKE = 5000

type Viewport = { name: string; width: number; height: number; touch: boolean }
const PHONE_VIEWPORTS: Viewport[] = [
  { name: 'phone-360x780', width: 360, height: 780, touch: true },
  { name: 'phone-390x844', width: 390, height: 844, touch: true },
  { name: 'phone-412x915', width: 412, height: 915, touch: true },
]

// Сценарии, които трябва да останат байт-идентични с кода преди редизайна.
type BaselineScenario = { name: string; width: number; height: number; touch: boolean; query: string; clickSelector?: string }
const BASELINE_SCENARIOS: BaselineScenario[] = [
  { name: 'phone-logged-in-390x844', width: 390, height: 844, touch: true, query: 'auth=1' },
  // Гост на телефон в "Правила" вече е светъл (виж [I1]); влязъл потребител
  // в същия екран остава непроменен.
  { name: 'phone-logged-in-rules-390x844', width: 390, height: 844, touch: true, query: 'auth=1', clickSelector: '[data-lobby-rules-card="1"]' },
  // Гост на телефон в "Игри" вече е светъл (GUEST_MOBILE_LIGHT_INFO_VIEWS) —
  // навигацията до екрана се проверява в [B1].
  { name: 'tablet-guest-820x1180', width: 820, height: 1180, touch: true, query: '' },
  { name: 'tablet-guest-1024x768', width: 1024, height: 768, touch: true, query: '' },
  { name: 'desktop-guest-1366x768', width: 1366, height: 768, touch: false, query: '' },
  { name: 'desktop-logged-in-1366x768', width: 1366, height: 768, touch: false, query: 'auth=1' },
]

const args = process.argv.slice(2)
const writeBaseline = args.includes('--write-baseline')
const screenshotsArg = args.find((a) => a.startsWith('--screenshots='))
const screenshotsDir = screenshotsArg ? screenshotsArg.slice('--screenshots='.length) : null

let vite: ViteDevServer | null = null
let browser: Browser | null = null
let baseUrl = ''

async function openPage(width: number, height: number, touch: boolean, query = ''): Promise<{ page: Page; errors: string[] }> {
  const context = await browser!.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch && width < 900, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${baseUrl}${HARNESS}${query ? `?${query}` : ''}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  return { page, errors }
}

async function captureRoot(scenario: BaselineScenario): Promise<string> {
  const { page } = await openPage(scenario.width, scenario.height, scenario.touch, scenario.query)
  if (scenario.clickSelector) {
    // DOM click (не pointer) — на телефон преди редизайна бутонът е само в
    // затвореното меню, но handler-ът е същият.
    await page.evaluate((selector) => document.querySelector<HTMLElement>(selector)?.click(), scenario.clickSelector)
    await page.waitForTimeout(300)
  }
  const html = await page.evaluate(() => document.querySelector('[data-lobby-screen-root="1"]')?.outerHTML ?? '')
  await page.context().close()
  return html
}

const clickAndSettle = async (page: Page, selector: string): Promise<void> => {
  await page.locator(selector).first().click()
  await page.waitForTimeout(250)
}

try {
  const port = await findFreePort()
  vite = await createViteServer({ server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  baseUrl = `http://127.0.0.1:${port}`
  browser = await chromium.launch()

  if (writeBaseline) {
    const out: Record<string, string> = {}
    for (const scenario of BASELINE_SCENARIOS) out[scenario.name] = await captureRoot(scenario)
    await writeFile(BASELINE_PATH, JSON.stringify(out, null, 1) + '\n')
    console.log(`baseline written: ${BASELINE_PATH} (${Object.keys(out).length} scenarios)`)
  } else {
    if (screenshotsDir) await mkdir(screenshotsDir, { recursive: true })

    // ── L1-L3: телефон, гост, "tables" ─────────────────────────────────────
    for (const vp of PHONE_VIEWPORTS) {
      const { page, errors } = await openPage(vp.width, vp.height, vp.touch)
      const m = await page.evaluate(() => {
        const r = (el: Element | null) => {
          if (!el) return null
          const b = el.getBoundingClientRect()
          return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }
        }
        const root = document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')!
        const scroll = document.querySelector<HTMLElement>('[data-lobby-stakes-scroll="1"]')!
        const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-lobby-guest-table-card]'))
        const preview = (window as any).__guestMobileLobbyPreview
        return {
          rootBg: getComputedStyle(root).backgroundColor,
          rootOverflowY: getComputedStyle(root).overflowY,
          innerW: window.innerWidth,
          docScrollW: document.documentElement.scrollWidth,
          rootScrollW: root.scrollWidth,
          rootClientW: root.clientWidth,
          header: (() => {
            const h = document.querySelector('[data-lobby-guest-mobile-header="1"]')
            if (!h) return null
            const logo = h.querySelector<HTMLImageElement>('img')
            const buttons = Array.from(h.querySelectorAll('button'))
            return {
              logoSrc: logo?.getAttribute('src') ?? '', logoLoaded: !!logo && logo.complete && logo.naturalWidth > 0,
              buttons: buttons.map((b) => ({ text: b.textContent?.trim(), gate: b.getAttribute('data-lobby-guest-auth-gate') })),
              hasMenuOrContact: !!h.querySelector('[data-lobby-mobile-menu], [data-lobby-nav-guest-contact], details, summary'),
              text: h.textContent?.replace(/s+/g, ' ').trim(),
            }
          })(),
          menuHost: !!document.querySelector('[data-lobby-guest-menu-host="1"] [data-lobby-mobile-menu="1"]'),
          authCardText: document.querySelector('[data-lobby-guest-auth-card="1"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          authCard: (() => {
            const card = document.querySelector('[data-lobby-guest-auth-card="1"]')!
            const text = card.querySelector('[data-lobby-guest-auth-card-text="1"]')
            const buttons = Array.from(card.querySelectorAll('button'))
            return {
              height: card.getBoundingClientRect().height,
              imgs: Array.from(card.querySelectorAll('img')).map((i) => i.closest('button') !== null),
              textBottom: text?.getBoundingClientRect().bottom ?? Infinity,
              buttonsTop: Math.min(...buttons.map((b) => b.getBoundingClientRect().top)),
            }
          })(),
          authButtons: document.querySelectorAll('[data-lobby-guest-auth-card="1"] [data-lobby-auth-login="1"], [data-lobby-guest-auth-card="1"] [data-lobby-auth-register="1"]').length,
          postsText: document.querySelector('[data-lobby-guest-posts-banner="1"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          postsIsToggle: document.querySelector('[data-lobby-guest-posts-banner="1"]')?.getAttribute('data-lobby-livechat-fullscreen-toggle') === '1',
          offers: document.querySelectorAll('[data-lobby-buy-coins-package], [data-lobby-nav-shop="1"]:not([data-lobby-mobile-menu="1"] *)').length,
          footerLinks: Array.from(document.querySelectorAll('[data-lobby-mobile-footer-legal-link="1"]')).map((a) => a.textContent?.trim()),
          enabledRooms: (preview.rooms as Array<{ stakeAmount: number; prizeAmount: number; isEnabled: boolean }>).filter((x) => x.isEnabled),
          cards: cards.map((c) => ({
            stake: Number(c.dataset.lobbyGuestTableCard),
            statRows: c.querySelectorAll('dl > div').length,
            text: c.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            button: (() => { const b = c.querySelector<HTMLButtonElement>('button[data-lobby-stake-card]'); return b ? { stake: Number(b.dataset.lobbyStakeCard), locked: b.hasAttribute('data-lobby-stake-card-guest-locked'), text: b.textContent?.trim(), disabled: b.disabled, cls: b.className } : null })(),
            rect: r(c),
          })),
          scrollLeftMax: scroll.scrollWidth - scroll.clientWidth,
          ludoButton: !!document.querySelector('[data-lobby-guest-ludo-section="1"] [data-lobby-guest-auth-gate="1"]'),
          rows: Array.from(document.querySelectorAll('[data-lobby-guest-rows="1"] > *')).map((el) => ({
            attrs: el.getAttributeNames().filter((n) => n.startsWith('data-') || n === 'href').map((n) => `${n}=${el.getAttribute(n)}`).join(' '),
            text: el.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          })),
          bottomNav: Array.from(document.querySelectorAll('[data-lobby-guest-bottom-nav="1"] > *')).map((el) => ({
            text: el.textContent?.trim(),
            attrs: el.getAttributeNames().filter((n) => n.startsWith('data-')).join(' '),
            rect: r(el),
            color: getComputedStyle(el).color,
            background: getComputedStyle(el).backgroundColor,
            images: el.querySelectorAll('img').length,
            svg: (() => {
              const s = el.querySelector('[data-lobby-guest-nav-icon] > svg')
              return s ? { w: s.getBoundingClientRect().width, stroke: s.getAttribute('stroke'), strokeWidth: s.getAttribute('stroke-width'), color: getComputedStyle(s).color } : null
            })(),
            hasMenuBadge: el.querySelector('[data-mobile-menu-total-badge="1"]') !== null,
          })),
          menuBadgeCount: document.querySelectorAll('[data-mobile-menu-total-badge="1"]').length,
          brokenImages: Array.from(document.querySelectorAll<HTMLImageElement>('[data-lobby-screen-root="1"] img')).filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute('src')),
          placeholders: Array.from(document.querySelectorAll('[data-lobby-media-slot]')).map((el) => {
            const img = el.querySelector('img')
            return { slot: el.getAttribute('data-lobby-media-slot'), rect: r(el), src: img?.getAttribute('src') ?? null, fit: img ? getComputedStyle(img).objectFit : null, imgRect: img ? r(img) : null, overflow: getComputedStyle(el).overflow }
          }),
        }
      })

      await check(`[L1] ${vp.name}: light guest lobby, no page errors`, () => {
        assert(errors.length === 0, `page errors: ${errors.join(' | ')}`)
        assert(m.rootBg === 'rgb(245, 247, 252)', `root bg ${m.rootBg}`)
        assert(m.rootOverflowY === 'auto', `root overflow-y ${m.rootOverflowY} (broken style attribute?)`)
        assert(m.header !== null, 'guest header missing')
        assert(m.menuHost, 'mobile menu (opened from the bottom nav) missing')
      })
      await check(`[L1] ${vp.name}: header = logo image + only the "Гост" button (no messages/menu buttons)`, () => {
        const h = m.header!
        assert(h.logoSrc === '/assets/lobby-mobile/logo-pika-text.webp' && h.logoLoaded, `logo ${h.logoSrc} loaded=${h.logoLoaded}`)
        assert(h.buttons.length === 1 && h.buttons[0].text === 'Гост' && h.buttons[0].gate === '1', `header buttons ${JSON.stringify(h.buttons)}`)
        assert(!h.hasMenuOrContact, 'header still contains the menu or the messages button')
        assert(h.text === 'Гост', `header text "${h.text}" (logo must be an image, not text)`)
      })
      await check(`[L1] ${vp.name}: auth card with the signup bonus, posts banner shows the latest post`, () => {
        assert(m.authCardText === 'Влез или създай профил и започни със 50 000 жълтици. Вход Регистрация' && m.authButtons === 2, `auth card "${m.authCardText}" buttons ${m.authButtons}`)
        assert(m.authCard.imgs.length === 2 && m.authCard.imgs.every(Boolean), `auth card images outside the buttons: ${JSON.stringify(m.authCard.imgs)}`)
        assert(m.authCard.textBottom <= m.authCard.buttonsTop, 'text is not above the buttons')
        assert(m.authCard.height <= 140, `auth card too tall: ${m.authCard.height}`)
        console.log(`  ·     ${vp.name}: auth card height ${m.authCard.height.toFixed(1)}px`)
        assert(m.postsIsToggle && m.postsText.includes('Публикации от Pika.bg') && m.postsText.includes('новият мобилен дизайн'), `posts "${m.postsText}"`)
      })
      await check(`[L1] ${vp.name}: no horizontal page overflow, no shop offers, legal footer kept`, () => {
        assert(m.docScrollW <= m.innerW && m.rootScrollW <= m.rootClientW, `scrollWidth doc ${m.docScrollW} root ${m.rootScrollW}/${m.rootClientW}`)
        assert(m.offers === 0, `offers/shop entries outside the menu: ${m.offers}`)
        for (const label of ['Общи условия', 'Политика за поверителност', 'Контакти', 'Настройки на бисквитките']) {
          assert(m.footerLinks.includes(label), `footer link "${label}" missing`)
        }
        // Дублиращите големите информационни карти връзки не са в footer-а на лобито.
        assert(JSON.stringify(m.footerLinks) === JSON.stringify(['За Pika.bg', 'Общи условия', 'Политика за поверителност', 'Контакти', 'Настройки на бисквитките']), `footer links ${JSON.stringify(m.footerLinks)}`)
      })
      await check(`[L2] ${vp.name}: one card per enabled room, server order, real entry/prize`, () => {
        assert(m.cards.length === m.enabledRooms.length, `cards ${m.cards.length} vs enabled rooms ${m.enabledRooms.length}`)
        m.cards.forEach((card, i) => {
          const room = m.enabledRooms[i]
          assert(card.stake === room.stakeAmount, `card ${i} stake ${card.stake} vs ${room.stakeAmount}`)
          const fmt = (n: number) => n.toLocaleString('bg-BG').replace(/\s/g, ' ')
          const text = card.text.replace(/\s/g, ' ')
          assert(text === `Награда ${fmt(room.prizeAmount)} Вход ${fmt(room.stakeAmount)} ${card.button?.text ?? ''}`.trim(), `card ${i} text "${card.text}"`)
          assert(!text.includes('Играчи') && card.statRows === 2, `card ${i}: ${card.statRows} stat rows / players row present`)
        })
      })
      await check(`[L2] ${vp.name}: exactly two cards fully visible, horizontal scroll reaches the last`, async () => {
        const fullyVisible = m.cards.filter((c) => c.rect!.left >= -0.5 && c.rect!.right <= m.innerW + 0.5)
        assert(fullyVisible.length === 2, `fully visible cards: ${fullyVisible.length}`)
        assert(Math.abs(m.cards[0].rect!.width - m.cards[1].rect!.width) < 0.5, 'cards differ in width')
        assert(m.cards.every((c) => Math.abs(c.rect!.top - m.cards[0].rect!.top) < 0.5 && Math.abs(c.rect!.height - m.cards[0].rect!.height) < 0.5), 'cards are not aligned (top/height)')
        console.log(`  ·     ${vp.name}: table card ${m.cards[0].rect!.width.toFixed(1)}×${m.cards[0].rect!.height.toFixed(1)}`)
        const last = await page.evaluate(async () => {
          const s = document.querySelector<HTMLElement>('[data-lobby-stakes-scroll="1"]')!
          s.scrollLeft = s.scrollWidth
          await new Promise((res) => setTimeout(res, 300))
          const cards = Array.from(s.querySelectorAll<HTMLElement>('[data-lobby-guest-table-card]'))
          const b = cards[cards.length - 1].getBoundingClientRect()
          const vis = cards.filter((c) => { const r = c.getBoundingClientRect(); return r.left >= -0.5 && r.right <= innerWidth + 0.5 }).length
          s.scrollLeft = 0
          return { right: b.right, left: b.left, vis }
        })
        assert(m.scrollLeftMax > 0, 'no horizontal scroll range')
        assert(last.left >= -0.5 && last.right <= m.innerW + 0.5 && last.vis === 2, `last card ${last.left}..${last.right}, visible ${last.vis}`)
      })
      await check(`[L2] ${vp.name}: "Играй" — trial table plain, others guest-locked`, () => {
        for (const card of m.cards) {
          assert(card.button !== null && card.button.text === 'Играй' && card.button.cls.includes('lobby-violet-btn'), `card ${card.stake} button ${JSON.stringify(card.button)}`)
          assert(card.button!.stake === card.stake && card.button!.locked === (card.stake !== GUEST_TRIAL_STAKE), `card ${card.stake} locked=${card.button!.locked}`)
          assert(!card.button!.disabled, `card ${card.stake} disabled`)
        }
      })
      await check(`[L3] ${vp.name}: Ludo banner, private/info rows with the original attributes and counters`, () => {
        assert(m.ludoButton, 'Ludo "Създай игра" (data-lobby-guest-auth-gate) missing')
        const expected = [
          ['data-lobby-guest-auth-gate=1 data-lobby-guest-belot-private-row=1', 'Частни маси – Белот', '3'],
          ['data-lobby-guest-auth-gate=1', 'Частни маси – Не се сърди човече', null],
          ['data-lobby-daily-rewards-card=1', 'Ежедневни награди', null],
          ['data-lobby-missions-card=1', 'Дневни мисии', null],
          ['href=/rules data-lobby-rules-card=1', 'Правила на белота', null],
          ['href=/strategy data-lobby-strategy-card=1', 'Съвети и стратегии', null],
          ['href=/learn data-lobby-learn-card=1', 'Научи белот', null],
          ['href=/fair-play data-lobby-fair-play-card=1', 'Честна игра', null],
          ['href=/faq data-lobby-faq-card=1', 'Често задавани въпроси', null],
        ] as const
        assert(m.rows.length === expected.length, `rows ${m.rows.length}`)
        expected.forEach(([attrs, title, badge], i) => {
          const row = m.rows[i]
          for (const part of attrs.split(' ')) assert(row.attrs.includes(part), `row ${i} attrs "${row.attrs}" missing ${part}`)
          assert(row.text.startsWith(title), `row ${i} text "${row.text}"`)
          if (badge !== null) assert(row.text.includes(badge), `row ${i} badge ${badge} missing in "${row.text}"`)
        })
      })
      await check(`[L3] ${vp.name}: bottom nav (5 items) fixed at the bottom, icons loaded, placeholders sized`, () => {
        assert(m.bottomNav.map((n) => n.text).join(',') === 'Начало,Игри,Теми,Чат,Меню', `nav ${m.bottomNav.map((n) => n.text).join(',')}`)
        for (const item of m.bottomNav) assert(Math.abs(item.rect!.bottom - (vp.height - 6)) <= 1.5, `nav item bottom ${item.rect!.bottom}`)
        // Минималистични SVG икони (без изображения): 24px, stroke 2,
        // currentColor — виолетова активна, сиво-синя неактивна.
        m.bottomNav.forEach((item, i) => {
          assert(item.images === 0 && item.svg !== null && item.svg.w === 24 && item.svg.stroke === 'currentColor' && item.svg.strokeWidth === '2', `nav ${i} icon ${JSON.stringify(item.svg)} images ${item.images}`)
          assert(item.rect!.height === 58, `nav ${i} height ${item.rect!.height}`)
        })
        assert(m.bottomNav[0].color === 'rgb(121, 80, 232)' && m.bottomNav[0].svg!.color === 'rgb(121, 80, 232)' && m.bottomNav[0].background === 'rgb(238, 233, 255)', `active nav ${m.bottomNav[0].color} ${m.bottomNav[0].background}`)
        for (const item of m.bottomNav.slice(1)) assert(item.color === 'rgb(122, 127, 158)' && item.background === 'rgba(0, 0, 0, 0)', `inactive nav ${item.color} ${item.background}`)
        // Значката за известия: единственият data-mobile-menu-total-badge
        // (patch-ван от refreshTopicsUnreadDom) е върху "Меню".
        assert(m.menuBadgeCount === 1 && m.bottomNav[4].hasMenuBadge, `menu badge count ${m.menuBadgeCount}`)
        assert(m.brokenImages.length === 0, `broken images: ${m.brokenImages.join(', ')}`)
        const belot = m.placeholders.find((p) => p.slot === 'belot-table')!
        const ludo = m.placeholders.find((p) => p.slot === 'ludo-banner')!
        assert(Math.abs(belot.rect!.width / belot.rect!.height - 2) < 0.02, `belot slot ratio ${belot.rect!.width / belot.rect!.height}`)
        assert(Math.abs(ludo.rect!.width / ludo.rect!.height - 3.75) < 0.03, `ludo slot ratio ${ludo.rect!.width / ludo.rect!.height}`)
        // Едно общо изображение за всички маси на Белот + банер; запълват
        // контейнера (cover), заоблените ъгли се пазят от overflow:hidden.
        const belotSlots = m.placeholders.filter((p) => p.slot === 'belot-table')
        assert(belotSlots.length === m.cards.length && belotSlots.every((p) => p.src === '/assets/lobby-mobile/belot-table.webp'), `belot images ${belotSlots.map((p) => p.src).join(',')}`)
        assert(ludo.src === '/assets/lobby-mobile/ludo-banner.webp', `ludo image ${ludo.src}`)
        for (const p of [...belotSlots, ludo]) {
          assert(p.fit === 'cover' && p.overflow === 'hidden', `${p.slot} fit ${p.fit} overflow ${p.overflow}`)
          assert(Math.abs(p.imgRect!.width - p.rect!.width) < 0.5 && Math.abs(p.imgRect!.height - p.rect!.height) < 0.5, `${p.slot} image does not fill its slot`)
        }
        console.log(`  ·     ${vp.name}: belot image slot ${belot.rect!.width.toFixed(1)}×${belot.rect!.height.toFixed(1)}, ludo banner slot ${ludo.rect!.width.toFixed(1)}×${ludo.rect!.height.toFixed(1)}`)
      })
      if (screenshotsDir) await page.screenshot({ path: join(screenshotsDir, `${vp.name}.png`), fullPage: false })
      await page.context().close()
    }

    // ── B1: поведение (действията минават през съществуващия controller) ───
    {
      const vp = PHONE_VIEWPORTS[1]
      const fresh = async () => (await openPage(vp.width, vp.height, vp.touch)).page
      const authMode = (page: Page) => page.evaluate(() => {
        if (!document.querySelector('[data-lobby-auth-modal-root="1"]')) return 'closed'
        if (document.querySelector('[data-name-check-input="register"]')) return 'register'
        if (document.querySelector('[data-lobby-auth-modal-root="1"] input[name="password"]')) return 'login'
        if (document.querySelector('[data-lobby-auth-modal-root="1"] [data-lobby-auth-register-button="1"]')) return 'cta'
        return 'other'
      })

      let page = await fresh()
      await check('[B1] trial table "Играй" opens the guest trial popup', async () => {
        await clickAndSettle(page, `[data-lobby-guest-table-card="${GUEST_TRIAL_STAKE}"] [data-lobby-stake-card]`)
        assert(await page.locator('[data-guest-trial-modal-root="1"]').count() === 1, 'guest trial popup not shown')
      })
      await page.context().close()

      page = await fresh()
      await check('[B1] locked table "Играй" opens the guest-locked popup', async () => {
        await clickAndSettle(page, '[data-lobby-stake-card-guest-locked="1"]')
        assert(await page.locator('[data-guest-locked-stake-modal-root="1"]').count() === 1, 'guest locked popup not shown')
      })
      await page.context().close()

      // Светлият popup за пробните игри (маса 5 000): стил, побиране, състояния
      // (оставащи / 1 / изчерпани / loading), същите действия.
      for (const [w, h, trial, bonus] of [[360, 780, '3', '50000'], [390, 844, '3', '75000'], [360, 560, '3', '50000'], [390, 844, '1', '50000'], [390, 844, '0', '75000'], [390, 844, '0', '120000'], [390, 844, 'loading', '50000']] as const) {
        const trialPage = (await openPage(w, h, true, `trial=${trial}&bonus=${bonus}`)).page
        await check(`[B1] ${w}x${h} trial=${trial} bonus=${bonus}: light guest trial popup, texts and actions unchanged`, async () => {
          await clickAndSettle(trialPage, `[data-lobby-guest-table-card="${GUEST_TRIAL_STAKE}"] [data-lobby-stake-card]`)
          await trialPage.waitForTimeout(150)
          const info = await trialPage.evaluate(() => {
            const root = document.querySelector('[data-guest-trial-modal-root="1"]')!
            const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!
            const d = dialog.getBoundingClientRect()
            const buttons = Array.from(root.querySelectorAll<HTMLElement>('[data-guest-trial-play-button],[data-guest-trial-register-button],[data-guest-trial-login-button]'))
            return {
              light: root.hasAttribute('data-guest-trial-modal-light'),
              bg: getComputedStyle(dialog).backgroundColor, radius: getComputedStyle(dialog).borderTopLeftRadius,
              buttons: buttons.map((b) => `${b.getAttributeNames().find((n) => n.startsWith('data-guest-trial-'))}:${b.classList.contains('lobby-violet-btn')}:${getComputedStyle(b).borderTopLeftRadius}`),
              fits: d.left >= 0 && d.right <= window.innerWidth && d.top >= 0 && d.bottom <= window.innerHeight,
              text: root.textContent!.replace(/\s+/g, ' ').trim(),
            }
          })
          assert(info.light && info.bg === 'rgb(255, 255, 255)' && info.radius === '12px' && info.fits, `dialog ${JSON.stringify(info)}`)
          const body = `За по-силно изживяване създай профил, вземи ${new Intl.NumberFormat('bg-BG').format(Number(bonus)).replace(/\s/g, ' ')} жълтици, сприятелявай се с други играчи, играй с приятели, печели игри и трупай жълтици.`
          const expected = {
            '3': [`Имате 3 пробни игри като гост с виртуални играчи. ${body} Играй`, ['data-guest-trial-play-button:true:8px']],
            '1': [`Имате 1 пробна игра като гост с виртуални играчи. ${body} Играй`, ['data-guest-trial-play-button:true:8px']],
            '0': [`Изиграхте своите пробни игри като гост. ${body} Създай профил Вход`, ['data-guest-trial-register-button:true:8px', 'data-guest-trial-login-button:false:8px']],
            loading: ['Проверяваме пробните игри…', []],
          }[trial] as [string, string[]]
          assert(info.text === expected[0], `text "${info.text}"`)
          assert(JSON.stringify(info.buttons) === JSON.stringify(expected[1]), `buttons ${JSON.stringify(info.buttons)}`)
          if (screenshotsDir) await trialPage.screenshot({ path: join(screenshotsDir, `trial-${trial}-${w}x${h}.png`) })
          if (trial === '3' && w === 390) {
            await clickAndSettle(trialPage, '[data-guest-trial-play-button="1"]')
            const calls = await trialPage.evaluate(() => (window as any).__guestMobileLobbyPreview.calls as string[])
            assert(calls.includes(`joinGuestTrial:${GUEST_TRIAL_STAKE}`), `Играй did not start the trial: ${calls.join(',')}`)
          } else if (trial === '0') {
            await clickAndSettle(trialPage, '[data-guest-trial-register-button="1"]')
            assert(await authMode(trialPage) === 'register', 'Създай профил did not open register')
          } else {
            await clickAndSettle(trialPage, '[data-guest-trial-modal-close="1"]')
            assert(await trialPage.locator('[data-guest-trial-modal-root="1"]').count() === 0, 'X did not close')
          }
        })
        await trialPage.context().close()
      }

      // "Ежедневни награди" и "Дневни мисии" — светли в гост лобито (стил,
      // побиране, състояния, действия), тъмни на desktop.
      const lightPopupInfo = (page: Page, rootSel: string) => page.evaluate((sel) => {
        const root = document.querySelector(sel)
        if (!root) return null
        const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!
        const d = dialog.getBoundingClientRect()
        const cs = getComputedStyle(dialog)
        const close = root.querySelector<HTMLElement>('[data-daily-rewards-close="1"],[data-missions-popup-close="1"]')!
        const errors = Array.from(root.querySelectorAll<HTMLElement>('div')).filter((el) => getComputedStyle(el).backgroundColor === 'rgb(254, 243, 242)').map((el) => `${el.textContent!.trim()}|${getComputedStyle(el).color}`)
        return {
          light: Array.from(root.attributes).some((a) => a.name.endsWith('-light')),
          bg: cs.backgroundColor, radius: cs.borderTopLeftRadius,
          fits: d.left >= 0 && d.right <= window.innerWidth && d.top >= 0 && d.bottom <= window.innerHeight,
          closeSize: close.getBoundingClientRect().width,
          claim: Array.from(root.querySelectorAll<HTMLElement>('[data-daily-reward-claim],[data-mission-claim]')).map((b) => `${b.classList.contains('lobby-violet-btn')}:${getComputedStyle(b).borderTopLeftRadius}`),
          errors,
          text: root.textContent!.replace(/\s+/g, ' ').trim(),
        }
      }, rootSel)
      for (const [w, h, query] of [[360, 780, ''], [390, 844, ''], [360, 560, ''], [390, 844, 'rewards=none'], [390, 844, 'claim=error']] as const) {
        const rewardsPage = (await openPage(w, h, true, query)).page
        await check(`[B1] ${w}x${h}${query ? ` ${query}` : ''}: light "Ежедневни награди" popup, states and actions unchanged`, async () => {
          await clickAndSettle(rewardsPage, '[data-lobby-guest-rows="1"] [data-lobby-daily-rewards-card="1"]')
          await rewardsPage.waitForTimeout(150)
          const info = (await lightPopupInfo(rewardsPage, '[data-daily-rewards-backdrop="1"]'))!
          assert(info !== null && info.light && info.bg === 'rgb(255, 255, 255)' && info.radius === '12px' && info.fits && info.closeSize >= 32, `rewards ${JSON.stringify(info)}`)
          assert(info.text.startsWith('Ежедневни награди Рестартира се в полунощ.'), `text "${info.text}"`)
          if (query === 'rewards=none') {
            assert(JSON.stringify(info.errors) === JSON.stringify(['Системата не е налична.|rgb(180, 35, 24)']), `errors ${JSON.stringify(info.errors)}`)
          } else {
            assert(info.text.includes('1000 жълтици ✓ Взета') && JSON.stringify(info.claim) === JSON.stringify(['true:8px', 'true:8px']), `tiers "${info.text}" ${JSON.stringify(info.claim)}`)
            await clickAndSettle(rewardsPage, '[data-daily-reward-claim="preview-tier-2"]')
            await rewardsPage.waitForTimeout(150)
            const after = (await lightPopupInfo(rewardsPage, '[data-daily-rewards-backdrop="1"]'))!
            if (query === 'claim=error') {
              assert(JSON.stringify(after.errors) === JSON.stringify(['Тестова грешка: наградата не беше взета.|rgb(180, 35, 24)']), `claim errors ${JSON.stringify(after.errors)}`)
            } else {
              assert(after.text.includes('Получихте наградата! +2500 жълтици са добавени към вашия портфейл.') && after.claim.length === 1, `after claim "${after.text}"`)
            }
          }
          if (screenshotsDir) await rewardsPage.screenshot({ path: join(screenshotsDir, `rewards-${query || 'tiers'}-${w}x${h}.png`) })
          await clickAndSettle(rewardsPage, '[data-daily-rewards-close="1"]')
          assert(await rewardsPage.locator('[data-daily-rewards-backdrop="1"]').count() === 0, 'X did not close rewards')
        })
        await rewardsPage.context().close()
      }
      for (const [w, h] of [[360, 780], [390, 844]] as const) {
        const missionsPage = (await openPage(w, h, true)).page
        await check(`[B1] ${w}x${h}: light "Дневни мисии" popup keeps the login requirement`, async () => {
          await clickAndSettle(missionsPage, '[data-lobby-guest-rows="1"] [data-lobby-missions-card="1"]')
          const info = (await lightPopupInfo(missionsPage, '[data-missions-popup-root="1"]'))!
          assert(info !== null && info.light && info.bg === 'rgb(255, 255, 255)' && info.radius === '12px' && info.fits && info.closeSize >= 32, `missions ${JSON.stringify(info)}`)
          assert(info.text === 'Дневни мисии Влез в профила си, за да виждаш мисиите.', `text "${info.text}"`)
          if (screenshotsDir) await missionsPage.screenshot({ path: join(screenshotsDir, `missions-${w}x${h}.png`) })
          await clickAndSettle(missionsPage, '[data-missions-popup-close="1"]')
          assert(await missionsPage.locator('[data-missions-popup-root="1"]').count() === 0, 'X did not close missions')
          await clickAndSettle(missionsPage, '[data-lobby-guest-rows="1"] [data-lobby-missions-card="1"]')
          await missionsPage.mouse.click(6, 6)
          await missionsPage.waitForTimeout(150)
          assert(await missionsPage.locator('[data-missions-popup-root="1"]').count() === 0, 'backdrop did not close missions')
        })
        await missionsPage.context().close()
      }
      {
        const desktopPage = (await openPage(1366, 768, false)).page
        await check('[B1] desktop: "Ежедневни награди" and "Дневни мисии" stay dark', async () => {
          await clickAndSettle(desktopPage, '[data-lobby-daily-rewards-card="1"]')
          const rewards = await desktopPage.evaluate(() => document.querySelector('[data-daily-rewards-backdrop="1"]')?.hasAttribute('data-daily-rewards-light') ?? null)
          assert(rewards === false, `desktop rewards light=${rewards}`)
          await clickAndSettle(desktopPage, '[data-daily-rewards-close="1"]')
          await clickAndSettle(desktopPage, '[data-lobby-missions-card="1"]')
          const missions = await desktopPage.evaluate(() => document.querySelector('[data-missions-popup-root="1"]')?.hasAttribute('data-missions-popup-light') ?? null)
          assert(missions === false, `desktop missions light=${missions}`)
        })
        await desktopPage.context().close()
      }

      // ── I1: информационните екрани (гост, телефон) — същата светла рамка
      // (общият header + долна навигация), светло съдържание, скрол само на
      // съдържанието, нищо не остава под долната лента; навигацията работи.
      // И петте се отварят в приложението (без пълно зареждане — виж [I3]).
      for (const [key, title] of [['rules', 'Правила на белота'], ['strategy', 'Как да станеш по-добър на белот'], ['learn', 'Научи белот'], ['fair-play', 'Честна игра'], ['faq', 'Често задавани въпроси']] as const) {
        for (const [w, h] of [[360, 780], [390, 844]] as const) {
          const infoPage = (await openPage(w, h, true)).page
          await check(`[I1] ${w}x${h}: "${title}" opens in the light guest shell`, async () => {
            await clickAndSettle(infoPage, `[data-lobby-guest-rows="1"] [data-lobby-${key}-card="1"]`)
            await infoPage.waitForSelector('main article h1')
            const info = await infoPage.evaluate(() => {
              const root = document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')!
              const header = root.querySelector<HTMLElement>('[data-lobby-guest-mobile-header="1"]')
              const nav = root.querySelector<HTMLElement>('[data-lobby-guest-bottom-nav="1"]')
              const article = root.querySelector<HTMLElement>('main article')!
              const sections = Array.from(article.querySelectorAll<HTMLElement>('section, nav'))
              const goldish = Array.from(root.querySelectorAll<HTMLElement>('main *')).filter((el) => {
                const cs = getComputedStyle(el)
                return /201, 168, 76|212, 165, 32/.test(`${cs.color} ${cs.backgroundColor} ${cs.borderTopColor} ${cs.borderLeftColor}`)
              })
              const darkBg = Array.from(root.querySelectorAll<HTMLElement>('main *')).filter((el) => {
                const bg = getComputedStyle(el).backgroundColor
                return bg !== 'rgba(0, 0, 0, 0)' && /^rgba?\((0|5|8|13|20), (0|5|8|13|20), (0|5|8|13|32)/.test(bg)
              })
              return {
                light: root.hasAttribute('data-lobby-guest-mobile-light'),
                bg: getComputedStyle(root).backgroundColor,
                header: header ? `${header.querySelector('img')?.getAttribute('src')}|${header.textContent!.trim()}` : null,
                darkMenu: root.querySelector('[data-lobby-mobile-menu-summary="1"]') ? getComputedStyle(root.querySelector('[data-lobby-mobile-menu-summary="1"]')!).display : 'none',
                nav: nav ? Array.from(nav.children).map((el) => `${el.textContent!.trim()}:${el.hasAttribute('aria-current')}`).join(',') : null,
                h1: `${article.querySelector('h1')!.textContent!.trim()}|${getComputedStyle(article.querySelector('h1')!).color}`,
                sections: sections.length,
                sectionStyle: [...new Set(sections.map((s) => `${getComputedStyle(s).backgroundColor} ${getComputedStyle(s).borderTopLeftRadius}`))],
                h2: [...new Set(Array.from(article.querySelectorAll('h2')).map((el) => getComputedStyle(el).color))],
                goldish: goldish.map((el) => el.tagName).slice(0, 5),
                darkBg: darkBg.map((el) => el.tagName).slice(0, 5),
              }
            })
            assert(info.light && info.bg === 'rgb(245, 247, 252)', `shell ${JSON.stringify(info)}`)
            assert(info.header === '/assets/lobby-mobile/logo-pika-text.webp|Гост' && info.darkMenu === 'none', `header ${info.header} darkMenu ${info.darkMenu}`)
            assert(info.nav === 'Начало:false,Игри:false,Теми:false,Чат:false,Меню:false', `nav ${info.nav}`)
            assert(info.h1 === `${title}|rgb(23, 35, 60)` && info.sections > 2, `content ${info.h1} sections ${info.sections}`)
            assert(info.sectionStyle.every((s) => /^rgb\((255, 255, 255|244, 240, 255)\) 12px$/.test(s)) && JSON.stringify(info.h2) === '["rgb(23, 35, 60)"]', `sections ${JSON.stringify(info.sectionStyle)} h2 ${JSON.stringify(info.h2)}`)
            assert(info.goldish.length === 0 && info.darkBg.length === 0, `gold ${info.goldish.join(',')} dark ${info.darkBg.join(',')}`)
            // Скрол: header и навигацията остават видими; последният текст не е под лентата.
            await infoPage.evaluate(() => { const r = document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')!; r.scrollTop = r.scrollHeight })
            await infoPage.waitForTimeout(100)
            const scrolled = await infoPage.evaluate(() => {
              const header = document.querySelector('[data-lobby-guest-mobile-header="1"]')!.getBoundingClientRect()
              const nav = document.querySelector('[data-lobby-guest-bottom-nav="1"]')!.getBoundingClientRect()
              const links = Array.from(document.querySelectorAll('[data-lobby-mobile-footer-legal-link="1"]'))
              const last = links[links.length - 1].getBoundingClientRect()
              return { headerTop: header.top, navBottom: nav.bottom, navTop: nav.top, lastBottom: last.bottom, innerH: window.innerHeight }
            })
            assert(scrolled.headerTop === 0 && Math.abs(scrolled.navBottom - scrolled.innerH) < 1 && scrolled.lastBottom <= scrolled.navTop, `scroll ${JSON.stringify(scrolled)}`)
            if (screenshotsDir) {
              await infoPage.evaluate(() => { document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')!.scrollTop = 0 })
              await infoPage.screenshot({ path: join(screenshotsDir, `info-${key}-${w}x${h}.png`) })
            }
            // Действия: "Гост" → светъл auth popup; "Начало" → гост лобито.
            await clickAndSettle(infoPage, '[data-lobby-guest-profile-button="1"]')
            assert(await authMode(infoPage) === 'cta' && await infoPage.locator('[data-lobby-guest-auth-modal="1"]').count() === 1, 'Гост did not open the light auth popup')
            await clickAndSettle(infoPage, '[data-lobby-auth-modal-close="1"]')
            await clickAndSettle(infoPage, '[data-lobby-guest-bottom-nav="1"] [data-lobby-nav-lobby="1"]')
            assert(await infoPage.locator('[data-lobby-guest-mobile-main="1"]').count() === 1, 'Начало did not return to the guest lobby')
          })
          await infoPage.context().close()
        }
      }
      // ── I2: котвите от "Съдържание" превъртат в същата страница (без
      // връщане в лобито/начало на страницата), заглавието е под header-а,
      // навигацията остава. Отворено и с пътя на сайта (/rules — както след
      // пълно зареждане), и от лобито (пътят не се сменя).
      for (const [key, entry] of [['rules', 'path'], ['rules', 'card'], ['strategy', 'path'], ['learn', 'path'], ['fair-play', 'path'], ['faq', 'path']] as const) {
        const anchorPage = (await openPage(390, 844, true, entry === 'path' ? `path=/${key}` : '')).page
        await check(`[I2] ${key} (${entry === 'path' ? `/${key}` : 'from the lobby'}): "Съдържание" anchors scroll within the page`, async () => {
          if (entry === 'card') await clickAndSettle(anchorPage, `[data-lobby-guest-rows="1"] [data-lobby-${key}-card="1"]`)
          await anchorPage.waitForSelector('main article h1')
          const anchors = await anchorPage.evaluate(() => Array.from(document.querySelectorAll('main article a[href^="#"]')).map((a) => a.getAttribute('href')!))
          const missing = await anchorPage.evaluate((hrefs) => hrefs.filter((h) => !document.getElementById(decodeURIComponent(h.slice(1)))), anchors)
          assert(anchors.length >= 5 && missing.length === 0, `anchors ${anchors.length}, missing targets ${missing.join(',')}`)
          const picks = [...new Set([anchors[0], anchors[Math.floor(anchors.length / 2)], anchors[anchors.length - 1], ...(key === 'rules' ? ['#tese'] : [])])]
          const h1 = await anchorPage.evaluate(() => document.querySelector('main article h1')!.textContent!.trim())
          const screen = await anchorPage.evaluate(() => (window as any).__guestMobileLobbyPreview.controller.getCurrentScreen())
          for (const href of picks) {
            await anchorPage.evaluate(() => { document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')!.scrollTop = 0 })
            await anchorPage.locator(`main article a[href="${href}"]`).first().click()
            // Плавното превъртане — изчакай да спре (scrollTop стабилен).
            await anchorPage.waitForFunction(() => {
              const w = window as any
              const top = document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')!.scrollTop
              const now = performance.now()
              if (w.__lastTop !== top) { w.__lastTop = top; w.__lastTopAt = now; return false }
              return now - w.__lastTopAt > 300
            }, null, { polling: 50, timeout: 8000 })
            const r = await anchorPage.evaluate((h) => {
              const target = document.getElementById(decodeURIComponent(h.slice(1)))!
              const header = document.querySelector('[data-lobby-guest-mobile-header="1"]')!.getBoundingClientRect()
              const nav = document.querySelector('[data-lobby-guest-bottom-nav="1"]')!.getBoundingClientRect()
              const root = document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')!
              const heading = target.querySelector('h2') ?? target
              return {
                screen: (window as any).__guestMobileLobbyPreview.controller.getCurrentScreen(),
                h1: document.querySelector('main article h1')?.textContent?.trim(),
                targetTop: target.getBoundingClientRect().top, headingBottom: heading.getBoundingClientRect().bottom,
                headerTop: header.top, headerBottom: header.bottom, navBottom: nav.bottom, innerH: window.innerHeight,
                scrollTop: root.scrollTop, maxScroll: root.scrollHeight - root.clientHeight, hash: location.hash,
              }
            }, href)
            assert(r.screen === screen && r.h1 === h1, `${href}: left the page → ${r.screen} "${r.h1}"`)
            assert(r.headerTop === 0 && Math.abs(r.navBottom - r.innerH) < 1 && r.hash === '', `${href}: navigation moved ${JSON.stringify(r)}`)
            // Заглавието е видимо точно под header-а (или страницата е стигнала края).
            const atEnd = r.scrollTop >= r.maxScroll - 1
            assert(r.targetTop >= r.headerBottom - 1 && (r.targetTop <= r.headerBottom + 20 || atEnd) && r.headingBottom <= r.innerH, `${href}: target at ${r.targetTop}, header bottom ${r.headerBottom}, ${JSON.stringify(r)}`)
          }
          if (screenshotsDir && key === 'rules' && entry === 'path') await anchorPage.screenshot({ path: join(screenshotsDir, 'anchor-rules-tese.png') })
        })
        await anchorPage.context().close()
      }

      {
        const linkPage = (await openPage(390, 844, true)).page
        await check('[I1] internal links between info pages keep the light shell', async () => {
          await clickAndSettle(linkPage, '[data-lobby-guest-rows="1"] [data-lobby-learn-card="1"]')
          await linkPage.waitForSelector('main article a[href="/rules"]')
          await clickAndSettle(linkPage, 'main article a[href="/rules"]')
          await linkPage.waitForFunction(() => document.querySelector('main article h1')?.textContent?.trim() === 'Правила на белота')
          const r = await linkPage.evaluate(() => ({
            light: document.querySelector('[data-lobby-screen-root="1"]')!.hasAttribute('data-lobby-guest-mobile-light'),
            h1: document.querySelector('main article h1')?.textContent?.trim(),
          }))
          assert(r.light && r.h1 === 'Правила на белота', `after link ${JSON.stringify(r)}`)
        })
        await linkPage.context().close()
      }

      // ── I3: Научи белот / Честна игра / ЧЗВ — вътрешна навигация без пълно
      // зареждане (маркерът на window оцелява), от лобито и от друг
      // информационен екран; URL-ът се сменя, съдържанието започва отгоре,
      // header-ът и навигацията са на място; браузърното "Назад" работи.
      for (const [key, title] of [['learn', 'Научи белот'], ['fair-play', 'Честна игра'], ['faq', 'Често задавани въпроси']] as const) {
        const navPage = (await openPage(390, 844, true, 'routing=1')).page
        await check(`[I3] "${title}": opens in-app without a full reload, Back returns`, async () => {
          await navPage.evaluate(() => {
            (window as any).__noReloadMarker = 1
            document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')!.scrollTop = 400
          })
          const state = async () => navPage.evaluate(() => {
            const root = document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')!
            const header = root.querySelector('[data-lobby-guest-mobile-header="1"]')?.getBoundingClientRect()
            const nav = root.querySelector('[data-lobby-guest-bottom-nav="1"]')?.getBoundingClientRect()
            return {
              marker: (window as any).__noReloadMarker === 1, path: location.pathname,
              screen: (window as any).__guestMobileLobbyPreview.controller.getCurrentScreen(),
              light: root.hasAttribute('data-lobby-guest-mobile-light'), scrollTop: root.scrollTop,
              h1: document.querySelector('main article h1')?.textContent?.trim() ?? null,
              headerTop: header?.top ?? null, navOk: nav ? Math.abs(nav.bottom - window.innerHeight) < 1 : false,
            }
          })
          await clickAndSettle(navPage, `[data-lobby-guest-rows="1"] [data-lobby-${key}-card="1"]`)
          let r = await state()
          assert(r.marker && r.screen === key && r.path === `/${key}` && r.light && r.h1 === title && r.scrollTop === 0 && r.headerTop === 0 && r.navOk, `from lobby ${JSON.stringify(r)}`)
          // От друг информационен екран (връзка в съдържанието на "Научи белот" / "Честна игра" в ЧЗВ).
          const [fromKey, fromHref] = key === 'learn' ? ['faq', '/learn'] : key === 'fair-play' ? ['faq', '/fair-play'] : ['learn', '/faq']
          await navPage.evaluate(() => history.back())
          await navPage.waitForFunction(() => (window as any).__guestMobileLobbyPreview.controller.getCurrentScreen() === 'lobby')
          r = await state()
          assert(r.marker && r.path !== `/${key}` && r.headerTop === 0 && r.navOk, `Back ${JSON.stringify(r)}`)
          await clickAndSettle(navPage, `[data-lobby-guest-rows="1"] [data-lobby-${fromKey}-card="1"]`)
          await navPage.evaluate(() => { document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')!.scrollTop = 600 })
          await clickAndSettle(navPage, `main article a[href="${fromHref}"]`)
          r = await state()
          assert(r.marker && r.screen === key && r.path === `/${key}` && r.h1 === title && r.scrollTop === 0 && r.headerTop === 0 && r.navOk, `from ${fromKey} ${JSON.stringify(r)}`)
          await navPage.evaluate(() => history.back())
          await navPage.waitForFunction((k) => (window as any).__guestMobileLobbyPreview.controller.getCurrentScreen() === k, fromKey)
          r = await state()
          assert(r.marker && r.path === `/${fromKey}`, `Back to ${fromKey} ${JSON.stringify(r)}`)
        })
        await navPage.context().close()
        // Директно отваряне на адреса (както след въведен URL / нов таб).
        const directPage = (await openPage(390, 844, true, `routing=1&path=/${key}`)).page
        await check(`[I3] "${title}": direct /${key} opens the light page`, async () => {
          await directPage.waitForSelector('main article h1')
          const r = await directPage.evaluate(() => ({
            path: location.pathname, screen: (window as any).__guestMobileLobbyPreview.controller.getCurrentScreen(),
            light: document.querySelector('[data-lobby-screen-root="1"]')!.hasAttribute('data-lobby-guest-mobile-light'),
            h1: document.querySelector('main article h1')?.textContent?.trim(),
          }))
          assert(r.path === `/${key}` && r.screen === key && r.light && r.h1 === title, `direct ${JSON.stringify(r)}`)
        })
        await directPage.context().close()
      }

      // ── S1: "Меню" → "Магазин" (гост, телефон) — светлата рамка, без баланс,
      // без бутони за покупка (прегледът няма API за магазина → светлото
      // съобщение за грешка); табовете превключват. Пълната проверка с
      // реалните пакети е срещу истинското приложение (локален backend).
      {
        const shopPage = (await openPage(390, 844, true)).page
        await check('[S1] Меню → Магазин opens the light guest shop shell', async () => {
          await clickAndSettle(shopPage, '[data-lobby-guest-bottom-menu="1"]')
          await clickAndSettle(shopPage, '[data-lobby-mobile-menu="1"] [data-lobby-nav-shop="1"]')
          const read = () => shopPage.evaluate(() => {
            const root = document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')!
            const main = root.querySelector('main')!
            return {
              screen: (window as any).__guestMobileLobbyPreview.controller.getCurrentScreen(),
              light: root.hasAttribute('data-lobby-guest-mobile-light'),
              header: !!root.querySelector('[data-lobby-guest-mobile-header="1"]'), nav: !!root.querySelector('[data-lobby-guest-bottom-nav="1"]'),
              h1: main.querySelector('h1')?.textContent?.trim(), balance: main.textContent!.includes('Баланс'),
              tabs: root.querySelectorAll('[data-lobby-guest-shop-tabs="1"] [data-shop-tab]').length,
              message: main.querySelector('[data-lobby-guest-shop-message]')?.getAttribute('data-lobby-guest-shop-message') ?? null,
              darkBuy: main.querySelectorAll('[data-lobby-shop-package],[data-vip-purchase-package],[data-bundle-purchase-package]').length,
            }
          })
          let r = await read()
          assert(r.screen === 'shop' && r.light && r.header && r.nav && r.h1 === 'Магазин Жълтици' && !r.balance && r.tabs === 3 && r.message === 'error' && r.darkBuy === 0, `shop ${JSON.stringify(r)}`)
          await clickAndSettle(shopPage, '[data-shop-tab="vip"]')
          r = await read()
          assert(r.h1 === 'Магазин VIP' && r.light, `vip tab ${JSON.stringify(r)}`)
          await clickAndSettle(shopPage, '[data-lobby-guest-bottom-nav="1"] [data-lobby-nav-lobby="1"]')
          assert(await shopPage.locator('[data-lobby-guest-mobile-main="1"]').count() === 1, 'Начало did not return to the guest lobby')
        })
        await shopPage.context().close()
      }

      // Desktop (тъмният popup) — същата динамична сума от настройката.
      for (const [trial, bonus] of [['3', '75000'], ['0', '75000'], ['3', '120000'], ['0', '120000']] as const) {
        const desktopPage = (await openPage(1366, 768, false, `trial=${trial}&bonus=${bonus}`)).page
        await check(`[B1] desktop trial=${trial} bonus=${bonus}: dark guest trial popup shows the setting's amount`, async () => {
          await clickAndSettle(desktopPage, `[data-lobby-stake-card="${GUEST_TRIAL_STAKE}"]`)
          await desktopPage.waitForTimeout(150)
          const info = await desktopPage.evaluate(() => {
            const root = document.querySelector('[data-guest-trial-modal-root="1"]')
            return root ? { light: root.hasAttribute('data-guest-trial-modal-light'), text: root.textContent!.replace(/\s+/g, ' ').trim() } : null
          })
          const amount = new Intl.NumberFormat('bg-BG').format(Number(bonus)).replace(/\s/g, ' ')
          assert(info !== null && !info.light, `desktop popup ${JSON.stringify(info)}`)
          assert(info.text.includes(`вземи ${amount} жълтици`) && !info.text.includes('100 000'), `desktop text "${info.text}"`)
          assert(info.text.endsWith(trial === '0' ? 'Създай профил Вход' : 'Играй'), `desktop actions "${info.text}"`)
        })
        await desktopPage.context().close()
      }

      // Светлият popup за заключена маса: стил, побиране, същите действия.
      for (const [w, h] of [[360, 780], [390, 844], [360, 560]] as const) {
        const lockedPage = (await openPage(w, h, true)).page
        const openLocked = async () => {
          await clickAndSettle(lockedPage, '[data-lobby-stake-card-guest-locked="1"]')
          assert(await lockedPage.locator('[data-guest-locked-stake-modal-root="1"]').count() === 1, 'locked popup not open')
        }
        await check(`[B1] ${w}x${h}: light guest-locked popup fits, texts and actions unchanged`, async () => {
          await openLocked()
          const info = await lockedPage.evaluate(() => {
            const root = document.querySelector('[data-guest-locked-stake-modal-root="1"]')!
            const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!
            const d = dialog.getBoundingClientRect()
            const play = root.querySelector<HTMLElement>('[data-guest-locked-stake-play-5000-button="1"]')!
            const links = ['login', 'register'].map((k) => getComputedStyle(root.querySelector(`[data-guest-locked-stake-${k}-button="1"]`)!).color)
            return {
              light: root.hasAttribute('data-guest-locked-stake-modal-light'),
              bg: getComputedStyle(dialog).backgroundColor, radius: getComputedStyle(dialog).borderTopLeftRadius,
              play: `${play.classList.contains('lobby-violet-btn')} ${getComputedStyle(play).borderTopLeftRadius}`,
              links,
              fits: d.left >= 0 && d.right <= window.innerWidth && d.top >= 0 && d.bottom <= window.innerHeight,
              text: root.textContent!.replace(/\s+/g, ' ').trim(),
            }
          })
          assert(info.light && info.bg === 'rgb(255, 255, 255)' && info.radius === '12px', `dialog ${JSON.stringify(info)}`)
          assert(info.play === 'true 8px' && info.links.every((c) => c === 'rgb(121, 80, 232)') && info.fits, `${JSON.stringify(info)}`)
          assert(info.text === 'Като гост не можете да играете на маса с този залог. Пробвайте маса със залог 5 000 или влезте в профила си. Играй на 5 000 Вход Създай профил', `text "${info.text}"`)
          if (screenshotsDir) await lockedPage.screenshot({ path: join(screenshotsDir, `locked-${w}x${h}.png`) })
          await clickAndSettle(lockedPage, '[data-guest-locked-stake-modal-close="1"]')
          assert(await lockedPage.locator('[data-guest-locked-stake-modal-root="1"]').count() === 0, 'X did not close')
          await openLocked()
          await clickAndSettle(lockedPage, '[data-guest-locked-stake-login-button="1"]')
          assert(await authMode(lockedPage) === 'login', 'Вход did not open login')
          await clickAndSettle(lockedPage, '[data-lobby-auth-modal-close="1"]')
          await openLocked()
          await clickAndSettle(lockedPage, '[data-guest-locked-stake-register-button="1"]')
          assert(await authMode(lockedPage) === 'register', 'Създай профил did not open register')
          await clickAndSettle(lockedPage, '[data-lobby-auth-modal-close="1"]')
          await openLocked()
          await clickAndSettle(lockedPage, '[data-guest-locked-stake-play-5000-button="1"]')
          assert(await lockedPage.locator('[data-guest-locked-stake-modal-root="1"]').count() === 0, 'Играй на 5 000 did not close the popup')
          assert(await lockedPage.locator('[data-guest-trial-modal-root="1"]').count() === 1, 'Играй на 5 000 did not open the guest trial popup')
        })
        await lockedPage.context().close()
      }

      for (const [selector, expected, label] of [
        ['[data-lobby-guest-auth-card="1"] [data-lobby-auth-login="1"]', 'login', 'Вход'],
        ['[data-lobby-guest-auth-card="1"] [data-lobby-auth-register="1"]', 'register', 'Регистрация'],
        ['[data-lobby-guest-profile-button="1"]', 'cta', 'Гост (header)'],
        ['[data-lobby-guest-bottom-nav="1"] [data-lobby-guest-auth-gate="1"]', 'cta', 'Теми (bottom nav)'],
        ['[data-lobby-guest-ludo-create="1"]', 'cta', 'Не се сърди човече: Създай игра (Ludo изисква профил)'],
        ['[data-lobby-guest-ludo-private-row="1"]', 'cta', 'Частни маси – Не се сърди човече (Ludo изисква профил)'],
        ['[data-lobby-guest-bottom-nav="1"] [data-lobby-nav-chat="1"]', 'cta', 'Чат (bottom nav)'],
      ] as const) {
        page = await fresh()
        await check(`[B1] ${label} opens the auth modal (${expected})`, async () => {
          await clickAndSettle(page, selector)
          const mode = await authMode(page)
          assert(mode === expected, `auth modal ${mode}`)
        })
        await page.context().close()
      }

      // Светлият 'cta' popup: стил, побиране (вкл. ниска височина), блокиране
      // на лобито, същите действия и затваряне (X / фон).
      for (const [w, h] of [[360, 780], [390, 844], [360, 560]] as const) {
        const ctaPage = (await openPage(w, h, true)).page
        const open = async () => {
          await clickAndSettle(ctaPage, '[data-lobby-guest-profile-button="1"]')
          assert(await authMode(ctaPage) === 'cta', 'cta not open')
        }
        await check(`[B1] ${w}x${h}: light "Регистрирай се" popup fits, blocks the lobby, actions and closing unchanged`, async () => {
          await open()
          const info = await ctaPage.evaluate(() => {
            const root = document.querySelector('[data-lobby-auth-modal-root="1"]')!
            const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!
            const cs = getComputedStyle(dialog)
            const d = dialog.getBoundingClientRect()
            const reg = root.querySelector('[data-lobby-auth-register-button="1"]')!
            const login = root.querySelector('[data-lobby-auth-login-button="1"]')!
            const close = root.querySelector('[data-lobby-auth-modal-close="1"]')!
            const hit = document.elementFromPoint(window.innerWidth / 2, 20)
            return {
              light: root.hasAttribute('data-lobby-guest-auth-modal'),
              bg: cs.backgroundColor, radius: cs.borderTopLeftRadius,
              dialog: { left: d.left, right: d.right, top: d.top, bottom: d.bottom, scrollable: dialog.scrollHeight > dialog.clientHeight },
              innerW: window.innerWidth, innerH: window.innerHeight,
              text: root.textContent!.replace(/\s+/g, ' ').trim(),
              reg: { bg: getComputedStyle(reg).backgroundImage, violet3d: reg.classList.contains('lobby-violet-btn'), color: getComputedStyle(reg).color, radius: getComputedStyle(reg).borderTopLeftRadius },
              login: { bg: getComputedStyle(login).backgroundColor, color: getComputedStyle(login).color, border: getComputedStyle(login).borderTopColor },
              closeVisible: close.getBoundingClientRect().width >= 32,
              blocked: hit !== null && root.contains(hit),
            }
          })
          assert(info.light, 'not the light guest modal')
          assert(info.bg === 'rgb(255, 255, 255)' && info.radius === '12px', `dialog ${info.bg} ${info.radius}`)
          assert(info.reg.violet3d && info.reg.bg.startsWith('linear-gradient(rgb(137, 97, 240)') &&info.reg.color === 'rgb(255, 255, 255)' && info.reg.radius === '8px', `register ${JSON.stringify(info.reg)}`)
          assert(info.login.bg === 'rgb(255, 255, 255)' && info.login.color === 'rgb(23, 35, 60)', `login ${JSON.stringify(info.login)}`)
          assert(info.text.startsWith('Регистрирай се и вземи 50 000 жълтици Създай профил, избери име и отключи всички маси.') && info.text.endsWith('Регистрация Вход'), `text "${info.text}"`)
          assert(info.dialog.left >= 0 && info.dialog.right <= info.innerW && info.dialog.top >= 0 && info.dialog.bottom <= info.innerH, `dialog out of viewport ${JSON.stringify(info.dialog)}`)
          assert(info.closeVisible && info.blocked, `close ${info.closeVisible} blocked ${info.blocked}`)
          if (screenshotsDir) await ctaPage.screenshot({ path: join(screenshotsDir, `cta-${w}x${h}.png`) })
          await clickAndSettle(ctaPage, '[data-lobby-auth-modal-close="1"]')
          assert(await authMode(ctaPage) === 'closed', 'X did not close')
          await open()
          await ctaPage.mouse.click(8, info.innerH - 8)
          await ctaPage.waitForTimeout(150)
          assert(await authMode(ctaPage) === 'closed', 'backdrop did not close')
          await open()
          await clickAndSettle(ctaPage, '[data-lobby-auth-register-button="1"]')
          assert(await authMode(ctaPage) === 'register', 'Регистрация did not open register')
          // Формите в гост лобито — светли (бял прозорец 12px, светли полета,
          // 3D виолетов основен бутон), побират се по ширина и скролват по височина.
          const formInfo = () => ctaPage.evaluate(() => {
            const root = document.querySelector('[data-lobby-auth-modal-root="1"]')!
            const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!
            const d = dialog.getBoundingClientRect()
            const field = root.querySelector<HTMLElement>('input:not([type="checkbox"]):not([type="radio"]), .registration-contact-editor')!
            const submit = root.querySelector<HTMLElement>('button[type="submit"]')!
            const all = Array.from(root.querySelectorAll<HTMLElement>('*'))
            const gold = all.filter((el) => /212, 165, 32|rgb\(5, 5, 5\)|rgb\(8, 8, 8\)/.test(`${getComputedStyle(el).color} ${getComputedStyle(el).backgroundColor} ${getComputedStyle(el).borderTopColor}`))
            dialog.scrollTop = dialog.scrollHeight
            const submitBottom = submit.getBoundingClientRect().bottom
            dialog.scrollTop = 0
            return {
              light: root.hasAttribute('data-lobby-guest-auth-modal'),
              bg: getComputedStyle(dialog).backgroundColor, radius: getComputedStyle(dialog).borderTopLeftRadius,
              fits: d.left >= 0 && d.right <= window.innerWidth && d.top >= 0 && d.bottom <= window.innerHeight,
              field: `${getComputedStyle(field).backgroundColor} ${getComputedStyle(field).borderTopLeftRadius}`,
              violet: submit.classList.contains('lobby-violet-btn'),
              submitReachable: submitBottom <= window.innerHeight,
              gold: gold.map((el) => el.tagName).slice(0, 5),
            }
          })
          for (const mode of ['register', 'login', 'forgot-password'] as const) {
            if (mode !== 'register') await clickAndSettle(ctaPage, `[data-lobby-auth-mode="${mode}"]`)
            const f = await formInfo()
            assert(f.light && f.bg === 'rgb(255, 255, 255)' && f.radius === '12px', `${mode} not light: ${JSON.stringify(f)}`)
            assert(f.field === 'rgb(255, 255, 255) 8px' && f.violet && f.fits && f.submitReachable, `${mode}: ${JSON.stringify(f)}`)
            assert(f.gold.length === 0, `${mode}: dark/gold elements ${f.gold.join(',')}`)
            if (mode === 'register') {
              await ctaPage.locator('[data-gender-option="male"]').click()
              await ctaPage.waitForTimeout(250) // transition: border-color 0.15s
              const sel = await ctaPage.locator('[data-gender-option="male"]').evaluate((el) => getComputedStyle(el).borderTopColor)
              assert(sel === 'rgb(121, 80, 232)', `selected gender border ${sel}`)
            }
            if (screenshotsDir) await ctaPage.screenshot({ path: join(screenshotsDir, `${mode}-${w}x${h}.png`) })
          }
          await clickAndSettle(ctaPage, '[data-lobby-auth-mode="login"]')
          assert(await authMode(ctaPage) === 'login', 'Назад към вход did not return to login')
        })
        await ctaPage.context().close()
      }

      page = await fresh()
      await check('[B1] Игри (bottom nav) opens "Игри"', async () => {
        await clickAndSettle(page, '[data-lobby-guest-bottom-nav="1"] [data-lobby-nav-games="1"]')
        const screen = await page.evaluate(() => (window as any).__guestMobileLobbyPreview.controller.getCurrentScreen())
        assert(screen === 'more-games', `screen ${screen}`)
        // Светлият вариант; Ludo картата е auth gate (Ludo изисква профил).
        assert(await page.locator('[data-lobby-guest-mobile-light="1"] [data-more-games-light="1"]').count() === 1, 'light games page missing')
        assert(await page.locator('[data-ludo-play-card="1"][data-lobby-guest-auth-gate="1"]').count() === 1, 'ludo card is not an auth gate')
        assert(await page.locator('[data-ludo-play-button="1"]').count() === 0, 'ludo play button still present')
      })
      await page.context().close()

      page = await fresh()
      await check('[B1] Меню (bottom nav) opens and the backdrop closes the mobile menu', async () => {
        await clickAndSettle(page, '[data-lobby-guest-bottom-menu="1"]')
        assert(await page.evaluate(() => document.querySelector<HTMLDetailsElement>('[data-lobby-mobile-menu="1"]')!.open), 'menu not open')
        await page.mouse.click(20, vp.height / 2)
        await page.waitForTimeout(250)
        assert(!(await page.evaluate(() => document.querySelector<HTMLDetailsElement>('[data-lobby-mobile-menu="1"]')!.open)), 'menu still open after backdrop tap')
      })
      await check('[B1] posts banner opens the full-screen panel and collapses back', async () => {
        await clickAndSettle(page, '[data-lobby-guest-posts-banner="1"]')
        assert(await page.locator('[data-lobby-livechat-fullscreen="1"] [data-lobby-livechat-messages-scroll="1"]').count() === 1, 'full-screen posts not shown')
        await clickAndSettle(page, '[data-lobby-livechat-fullscreen="1"] [data-lobby-livechat-fullscreen-toggle="1"]')
        assert(await page.locator('[data-lobby-guest-posts-banner="1"]').count() === 1, 'banner not restored')
      })
      await check('[B1] private tables (Белот) — guest stays in the lobby, light auth popup (cta)', async () => {
        await clickAndSettle(page, '[data-lobby-guest-belot-private-row="1"]')
        const r = await page.evaluate(() => ({ calls: (window as any).__guestMobileLobbyPreview.calls as string[], screen: (window as any).__guestMobileLobbyPreview.controller.getCurrentScreen() }))
        assert(!r.calls.includes('onPrivateRoomsOpen') && r.screen === 'lobby', `calls ${r.calls.join(',')} screen ${r.screen}`)
        assert(await authMode(page) === 'cta' && await page.locator('[data-lobby-guest-auth-modal="1"]').count() === 1, 'light auth popup not shown')
        await clickAndSettle(page, '[data-lobby-auth-modal-close="1"]')
      })
      await check('[B1] Меню → Турнири — guest stays in the lobby, light auth popup (cta), menu closed', async () => {
        await clickAndSettle(page, '[data-lobby-guest-bottom-menu="1"]')
        await clickAndSettle(page, '[data-lobby-mobile-menu="1"] [data-lobby-guest-tournaments="1"]')
        const r = await page.evaluate(() => ({
          screen: (window as any).__guestMobileLobbyPreview.controller.getCurrentScreen(),
          menuOpen: document.querySelector<HTMLDetailsElement>('[data-lobby-mobile-menu="1"]')!.open,
          navTournaments: document.querySelectorAll('[data-lobby-guest-mobile-light="1"] [data-lobby-nav-tournaments]').length,
        }))
        assert(r.screen === 'lobby' && !r.menuOpen && r.navTournaments === 0, `screen ${r.screen} menuOpen ${r.menuOpen} navTournaments ${r.navTournaments}`)
        assert(await authMode(page) === 'cta' && await page.locator('[data-lobby-guest-auth-modal="1"]').count() === 1, 'light auth popup not shown')
        await clickAndSettle(page, '[data-lobby-auth-modal-close="1"]')
      })
      await page.context().close()


      page = await fresh()
      await check('[B1] Правила на белота opens /rules', async () => {
        await clickAndSettle(page, '[data-lobby-rules-card="1"]')
        const r = await page.evaluate(() => ({ screen: (window as any).__guestMobileLobbyPreview.controller.getCurrentScreen(), path: location.pathname }))
        assert(r.screen === 'rules', `screen ${r.screen} path ${r.path}`)
      })
      await page.context().close()
    }

    // ── B1: стойностите идват от данните (GET /api/rooms), не от frontend-а ──
    {
      const { page } = await openPage(390, 844, true)
      await check('[B1] admin change of prize/entry/enabled tables shows on the next normal rooms reload', async () => {
        await page.evaluate(() => {
          const h = (window as any).__guestMobileLobbyPreview
          h.setRooms([
            { stakeAmount: 5000, minLevel: 1, prizeAmount: 9100, isEnabled: true },
            { stakeAmount: 7000, minLevel: 1, prizeAmount: 11300, isEnabled: true },
            { stakeAmount: 8000, minLevel: 1, prizeAmount: 13000, isEnabled: false },
          ])
        })
        // нормалното обновяване: друг екран → обратно в лобито (loadMatchRooms)
        await clickAndSettle(page, '[data-lobby-guest-bottom-nav="1"] [data-lobby-nav-games="1"]')
        await page.evaluate(() => (document.querySelector('[data-lobby-nav-lobby="1"]') as HTMLElement).click())
        await page.waitForTimeout(400)
        const cards = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-lobby-guest-table-card]')).map((c) => c.textContent!.replace(/\s+/g, ' ').trim()))
        const normalized = cards.map((c) => c.replace(/\s/g, ' '))
        assert(JSON.stringify(normalized) === JSON.stringify(['Награда 9100 Вход 5000 Играй', 'Награда 11 300 Вход 7000 Играй']), `cards ${JSON.stringify(cards)}`)
      })
      await page.context().close()
    }

    // ── B2: Ludo flag изключен, зареждане, няма маси ────────────────────────
    for (const [query, label, verify] of [
      ['ludo=0', 'Ludo flag off: no Ludo banner and no Ludo row', async (page: Page) => {
        assert(await page.locator('[data-lobby-guest-ludo-section="1"], [data-lobby-guest-ludo-private-row="1"]').count() === 0, 'Ludo UI still rendered')
      }],
      ['loading=1', 'tables loading state', async (page: Page) => {
        const text = await page.locator('[data-lobby-guest-mobile-main="1"]').textContent()
        assert((text ?? '').includes('Зареждане на масите...') && await page.locator('[data-lobby-guest-table-card]').count() === 0, 'loading text missing')
      }],
      ['rooms=0', 'no active tables state', async (page: Page) => {
        const text = await page.locator('[data-lobby-guest-belot-section="1"]').textContent()
        assert((text ?? '').includes('Няма активни маси в момента.'), 'empty text missing')
      }],
    ] as const) {
      const { page } = await openPage(390, 844, true, query)
      await check(`[B2] ${label}`, () => verify(page))
      await page.context().close()
    }

    // ── U1: непроменено спрямо кода преди редизайна ─────────────────────────
    const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Record<string, string>
    for (const scenario of BASELINE_SCENARIOS) {
      await check(`[U1] ${scenario.name}: markup identical to the pre-redesign baseline`, async () => {
        const html = await captureRoot(scenario)
        assert(typeof baseline[scenario.name] === 'string' && baseline[scenario.name].length > 0, 'baseline missing')
        if (html !== baseline[scenario.name]) {
          let i = 0
          while (i < html.length && html[i] === baseline[scenario.name][i]) i++
          throw new Error(`differs at ${i}: now "${html.slice(Math.max(0, i - 60), i + 60)}" vs baseline "${baseline[scenario.name].slice(Math.max(0, i - 60), i + 60)}"`)
        }
        assert(!html.includes('data-lobby-guest-'), 'guest redesign markup leaked')
      })
    }

    // ── A1: иконите ─────────────────────────────────────────────────────────
    await check('[A1] lobby icons are WebP with alpha (VP8X); source PNGs kept', async () => {
      const files = (await readdir(ICON_DIR)).filter((f) => f.endsWith('.webp'))
      // icon-nav-chat.webp е премахната — "Публикации от Pika.bg" ползва Lucide messages-square.
      assert(files.length >= 17 && !files.includes('icon-card-players.webp') && !files.includes('icon-nav-chat.webp'), `icons ${files.length}`)
      for (const f of files) {
        const buf = await readFile(join(ICON_DIR, f))
        assert(buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.toString('ascii', 12, 16) === 'VP8X' && (buf[20] & 0x10) !== 0, `${f} is not WebP with alpha`)
      }
      const logo = await readFile('public/assets/lobby-mobile/logo-pika-text.webp')
      assert(logo.toString('ascii', 8, 16) === 'WEBPVP8X' && (logo[20] & 0x10) !== 0, 'logo-pika-text.webp is not WebP with alpha')
      for (const png of ['icon-menu-register.png', 'icon-nav-home.png', 'logo-spade.png', 'logo-pika-text.png', 'icon-learn-belot (1).png']) {
        assert((await stat(join('temp', png))).size > 0, `temp/${png} missing`)
      }
    })
  }
} catch (err) {
  fail('harness', err)
} finally {
  await browser?.close()
  await vite?.close()
}

if (!writeBaseline) console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
