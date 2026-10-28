/**
 * checkPrivateRoomNoticeMobileLayout.ts
 *
 * Визуална проверка (Playwright, реален production код, без backend) на
 * глобалните известия за частната маса: отказ, изтичане, "не може", прието и
 * "масата се запълни" — при отворени "Теми" и скролирана страница, на
 * 320/360/375/390/430 px (mobile, touch) и 1280 px (desktop).
 *
 * За всяка ширина и вид:
 *  - картичката е изцяло в екрана, без хоризонтален скрол на страницата;
 *  - текстът не е изрязан (и при много дълго име);
 *  - всеки бутон е видим, в екрана, ≥ 44×44 px, не е закрит (реален hit-test
 *    в центъра му) и текстът му не е изрязан; при 320 px двата бутона са един
 *    под друг;
 *  - контраст на текста ≥ 7:1 спрямо фона на картичката;
 *  - не блокира страницата: без затъмняващ фон, hit-test извън картичката
 *    стига до страницата, скролът работи, а "Теми" не се прерисува;
 *  - чакалнята: известието е в потока на екрана и не закрива СТАРТ/чата.
 * Скрийншоти: <scratchpad>/notice-screens/ (подава се с --shots=<dir>).
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
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

const shotsDir = resolve(process.argv.slice(2).find((a) => a.startsWith('--shots='))?.slice('--shots='.length) ?? join(process.cwd(), 'tmp', 'notice-screens'))
const LOCAL = { profileId: 'host-profile-1', displayName: 'Домакин' }
const LONG_NAME = 'Максимилиан-Александър Константинов-Златаров'

function roomSnapshot(opts: { notice?: { kind: string; toDisplayName: string } | null; full?: boolean }) {
  const occupant = (profileId: string, displayName: string, isHost = false) => ({ profileId, displayName, avatarUrl: null, level: 1, rankTitle: null, isHost, isBot: false })
  return {
    id: 'room-visual-1',
    kind: 'open',
    stake: 5000,
    slots: [
      { team: 'A', slotIndex: 0, occupant: occupant(LOCAL.profileId, LOCAL.displayName, true) },
      { team: 'A', slotIndex: 1, occupant: opts.full ? occupant('p-a1', 'Партньор') : null },
      { team: 'B', slotIndex: 0, occupant: occupant('p-b0', 'Играч Б0') },
      { team: 'B', slotIndex: 1, occupant: opts.full ? occupant('p-b1', 'Играч Б1') : null },
    ],
    createdAt: Date.now(),
    expiresAt: Date.now() + 15 * 60_000,
    manualStart: opts.full === true,
    humanTurnTimeoutMs: 15000,
    canManualStart: opts.full === true,
    partnerReservation: {
      team: 'A',
      slotIndex: 1,
      invitePending: false,
      invite: null,
      notice: opts.notice ? { ...opts.notice, createdAt: Date.now() } : null,
    },
  }
}

const KINDS = [
  { id: 'declined', notice: { kind: 'declined', toDisplayName: 'Иван' }, buttons: ['Покани друг', 'Освободи мястото'] },
  { id: 'expired', notice: { kind: 'expired', toDisplayName: 'Иван' }, buttons: ['Покани друг', 'Освободи мястото'] },
  { id: 'unavailable', notice: { kind: 'unavailable', toDisplayName: 'Иван' }, buttons: ['Покани друг', 'Освободи мястото'] },
  { id: 'expired-long-name', notice: { kind: 'expired', toDisplayName: LONG_NAME }, buttons: ['Покани друг', 'Освободи мястото'] },
  { id: 'accepted', notice: { kind: 'accepted', toDisplayName: 'Иван' }, buttons: ['ОК'] },
  { id: 'manual-start-full', notice: null, full: true, buttons: ['Към масата'] },
] as const

const VIEWPORTS = [
  { label: 'mobile-320', width: 320, height: 640, mobile: true },
  { label: 'mobile-360', width: 360, height: 740, mobile: true },
  { label: 'mobile-375', width: 375, height: 667, mobile: true },
  { label: 'mobile-390', width: 390, height: 844, mobile: true },
  { label: 'mobile-430', width: 430, height: 932, mobile: true },
  { label: 'desktop-1280', width: 1280, height: 800, mobile: false },
] as const

// WCAG относителна яркост.
function luminance(hex: string): number {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!
}
const contrast = (a: string, b: string) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (l1 + 0.05) / (l2 + 0.05)
}

console.log('\ncheckPrivateRoomNoticeMobileLayout\n')
await mkdir(shotsDir, { recursive: true })

let vite: ViteDevServer | null = null
let browser: Browser | null = null
try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()

  for (const vp of VIEWPORTS) {
    console.log(`--- ${vp.label} (${vp.width}x${vp.height}) ---`)
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: vp.mobile ? 2 : 1 })
    const page: Page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/privateRoomPartnerInviteHarness.html`)
    await page.waitForFunction(() => (window as any).__partnerHarness !== undefined, undefined, { timeout: 15_000 })
    await page.evaluate(({ profileId, displayName }) => (window as any).__partnerHarness.setLocalProfile(profileId, displayName), LOCAL)
    // Без backend: както main.ts при отворен WebSocket — скрива началния екран за зареждане.
    await page.evaluate(() => (window as any).__partnerHarness.controller.setConnected(true))
    // Началният екран се скрива с анимация (~0.6 сек) — изчакваме да изчезне.
    await page.waitForFunction(() => document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.closest('[data-lobby-screen-root="1"], body') !== null && ![...document.body.children].some((el) => el !== document.querySelector('[data-private-room-notice-host="1"]') && getComputedStyle(el).position === 'fixed' && el.getBoundingClientRect().width >= window.innerWidth && Number(getComputedStyle(el).zIndex) > 9000), null, { timeout: 5_000 })
    await page.evaluate(() => (window as any).__partnerHarness.goToTopics())
    await page.waitForFunction(() => (window as any).__partnerHarness.getCurrentScreen() === 'topics', null, { timeout: 5_000 })
    // Дълга, скролирана страница "Теми".
    await page.evaluate(() => {
      document.body.style.minHeight = '5000px'
      window.scrollTo(0, 1200)
      ;(window as any).__rootMarker = document.querySelector('[data-lobby-screen-root="1"]')
    })

    for (const kind of KINDS) {
      await page.evaluate((room) => (window as any).__partnerHarness.inject({ type: 'private_room_updated', room }), roomSnapshot({ notice: kind.notice as any, full: (kind as any).full === true }))
      const cardSelector = kind.id === 'manual-start-full' ? '[data-private-room-manual-start-notice="1"]' : '[data-private-room-partner-notice]'
      await page.locator(cardSelector).waitFor({ state: 'visible', timeout: 3_000 })

      await check(`${vp.label} ${kind.id}: картичка в екрана, без хоризонтален скрол, текстът не е изрязан`, async () => {
        const m = await page.evaluate((sel) => {
          const card = document.querySelector(sel)!.firstElementChild as HTMLElement
          const r = card.getBoundingClientRect()
          const text = card.querySelector('[data-private-room-notice-text="1"]') as HTMLElement
          return {
            r: { l: r.left, t: r.top, rr: r.right, b: r.bottom },
            vw: document.documentElement.clientWidth,
            vh: window.innerHeight,
            pageScrollW: document.documentElement.scrollWidth,
            textClipped: text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1,
            cardScrolls: card.parentElement!.scrollHeight > card.parentElement!.clientHeight + 1,
          }
        }, cardSelector)
        assert(m.r.l >= 0 && m.r.t >= 0 && m.r.rr <= m.vw + 0.5 && m.r.b <= m.vh + 0.5, `card out of viewport ${JSON.stringify(m.r)} vw=${m.vw} vh=${m.vh}`)
        assert(m.pageScrollW <= m.vw + 1, `horizontal scroll ${m.pageScrollW} > ${m.vw}`)
        assert(!m.textClipped, 'text clipped')
        assert(!m.cardScrolls, 'card content overflows (needs inner scroll)')
      })

      await check(`${vp.label} ${kind.id}: бутоните са видими, ≥44×44, кликаеми (hit-test) и с пълен текст`, async () => {
        const buttons = await page.evaluate((sel) => {
          return [...document.querySelectorAll(`${sel} button`)].map((b) => {
            const r = b.getBoundingClientRect()
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            return {
              text: b.textContent?.trim(),
              w: r.width, h: r.height, l: r.left, rr: r.right, t: r.top, b: r.bottom,
              hitOk: hit === b || b.contains(hit),
              clipped: (b as HTMLElement).scrollWidth > (b as HTMLElement).clientWidth + 1,
              visible: getComputedStyle(b).visibility === 'visible' && getComputedStyle(b).display !== 'none' && Number(getComputedStyle(b).opacity) > 0.9,
            }
          })
        }, cardSelector)
        assert(JSON.stringify(buttons.map((b) => b.text)) === JSON.stringify(kind.buttons), `buttons ${JSON.stringify(buttons.map((b) => b.text))}`)
        const vw = vp.width
        for (const b of buttons) {
          assert(b.visible, `${b.text}: not visible`)
          assert(b.w >= 44 && b.h >= 44, `${b.text}: ${b.w.toFixed(0)}x${b.h.toFixed(0)} < 44x44`)
          assert(b.l >= 0 && b.rr <= vw + 0.5 && b.t >= 0 && b.b <= vp.height + 0.5, `${b.text}: off-screen`)
          assert(b.hitOk, `${b.text}: covered by another element`)
          assert(!b.clipped, `${b.text}: text clipped`)
        }
        if (buttons.length === 2 && vp.width <= 320) {
          assert(buttons[1]!.t >= buttons[0]!.b - 0.5, 'buttons not stacked at 320px')
        }
      })

      await check(`${vp.label} ${kind.id}: контраст на текста ≥ 7:1`, async () => {
        const color = await page.evaluate((sel) => getComputedStyle(document.querySelector(`${sel} [data-private-room-notice-text="1"]`)!).color, cardSelector)
        const rgb = color.match(/\d+/g)!.slice(0, 3).map(Number)
        const hex = `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`
        const worst = Math.min(contrast(hex, '#1c1c33'), contrast(hex, '#13132a'))
        assert(worst >= 7, `contrast ${worst.toFixed(2)}`)
      })

      await check(`${vp.label} ${kind.id}: не блокира страницата (без фон, hit-test и скрол работят, "Теми" не е прерисувана)`, async () => {
        const res = await page.evaluate(async (sel) => {
          const card = document.querySelector(sel)!
          const before = card.firstElementChild!.getBoundingClientRect().top
          const hit = document.elementFromPoint(window.innerWidth / 2, 60)
          const y0 = window.scrollY
          window.scrollBy(0, 300)
          await new Promise((r) => requestAnimationFrame(() => r(null)))
          const y1 = window.scrollY
          window.scrollBy(0, -300)
          const after = card.firstElementChild!.getBoundingClientRect().top
          const host = document.querySelector('[data-private-room-notice-host="1"]')!
          return {
            blocks: hit !== null && card.contains(hit),
            scrolled: y1 - y0,
            fixed: Math.abs(after - before) < 1,
            hostCoversScreen: (() => { const r = host.getBoundingClientRect(); return r.width >= window.innerWidth && r.height >= window.innerHeight })(),
            sameRoot: (window as any).__rootMarker?.isConnected === true,
          }
        }, cardSelector)
        assert(!res.blocks, 'notice blocks the top of the page')
        assert(res.scrolled > 200, `page did not scroll (${res.scrolled})`)
        assert(res.fixed, 'notice moved with the page')
        assert(!res.hostCoversScreen, 'notice host covers the whole screen (backdrop)')
        assert(res.sameRoot, 'Topics page was re-rendered')
      })

      await page.screenshot({ path: join(shotsDir, `${vp.label}-${kind.id}.png`) })
    }

    await check(`${vp.label}: известието изчезва без прерисуване на "Теми"`, async () => {
      await page.evaluate((room) => (window as any).__partnerHarness.inject({ type: 'private_room_updated', room }), roomSnapshot({ notice: null }))
      await page.locator('[data-private-room-notice-host="1"]').waitFor({ state: 'detached', timeout: 3_000 })
      const ok = await page.evaluate(() => (window as any).__rootMarker?.isConnected === true && Math.abs(window.scrollY - 1200) <= 2)
      assert(ok, 'Topics re-rendered or scroll moved')
    })

    await check(`${vp.label}: чакалнята — известието е в потока, не закрива СТАРТ/чата`, async () => {
      const waitingRoom = roomSnapshot({ notice: { kind: 'accepted', toDisplayName: 'Иван' }, full: true })
      await page.evaluate((room) => (window as any).__partnerHarness.inject({ type: 'private_room_updated', room }), waitingRoom)
      await page.evaluate((room) => (window as any).__partnerHarness.inject({ type: 'private_rooms_list', rooms: [room] }), waitingRoom)
      await page.evaluate(() => { document.body.style.minHeight = ''; (window as any).__partnerHarness.controller.navigateToPrivateRooms() })
      await page.click('[data-private-room-list-enter="room-visual-1"]')
      await page.waitForFunction(() => (window as any).__partnerHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 5_000 })
      const res = await page.evaluate(() => {
        const notice = document.querySelector('[data-private-room-partner-notice]') as HTMLElement | null
        const start = document.querySelector('[data-private-room-manual-start="1"]') as HTMLElement | null
        const chatInput = document.querySelector('[data-private-waiting-chat-input="1"]') as HTMLElement | null
        const [startHit, chatHit, noticeButtonHit] = [start, chatInput, (notice?.querySelector('button') ?? null) as HTMLElement | null].map((el) => {
          if (!el) return false
          el.scrollIntoView({ block: 'center' })
          const r = el.getBoundingClientRect()
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return hit === el || el.contains(hit!)
        })
        return {
          inFlow: notice !== null && getComputedStyle(notice).position === 'static',
          floatingHost: document.querySelector('[data-private-room-notice-host="1"]') !== null,
          manualNoticeInWaiting: document.querySelector('[data-private-room-manual-start-notice="1"]') !== null,
          startHit,
          chatHit,
          noticeButtonHit,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        }
      })
      assert(res.inFlow && !res.floatingHost, `notice not inline: ${JSON.stringify(res)}`)
      assert(!res.manualNoticeInWaiting, 'manual-start popup shown in the waiting room')
      assert(res.startHit && res.chatHit && res.noticeButtonHit, `covered controls: ${JSON.stringify(res)}`)
      assert(!res.overflow, 'horizontal overflow in the waiting room')
      await page.locator('[data-private-room-partner-notice]').scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(shotsDir, `${vp.label}-waiting-room-accepted.png`) })
    })

    await check(`${vp.label}: без грешки в страницата`, () => {
      assert(errors.length === 0, errors.join(' | '))
    })
    await context.close()
  }
} finally {
  await browser?.close()
  await vite?.close()
}

console.log(`\nScreenshots: ${shotsDir}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
