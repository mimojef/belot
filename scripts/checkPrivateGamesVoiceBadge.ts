/**
 * checkPrivateGamesVoiceBadge.ts — индикаторът за гласов чат в „Играещи“ и
 * „Приключили“ (частни маси). Реален браузър, реалният lobby контролер и
 * renderer през Vite (fixture voiceMobileUiHarness), реално съобщение
 * private_games_list.
 *
 *   [V1] значка само на мача с voiceEnabled === true, на реда с входната такса;
 *   [V2] без значка за мач без глас и за стар запис (полето липсва);
 *   [V3] същата значка като в „Чакащи“ (размер, фон, рамка, aria-label);
 *   — за „Играещи“ и „Приключили“, на mobile (390, 320) и desktop (1280).
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkPrivateGamesVoiceBadge.ts
 */

import { createServer as createNetServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      srv.close(() => resolve(address.port))
    })
  })
}

const OUT = join(tmpdir(), 'belot-v2-private-games-voice-badge')
const VIEWPORTS = [
  { label: '390x844', width: 390, height: 844, mobile: true },
  { label: '320x640', width: 320, height: 640, mobile: true },
  { label: '1280x800', width: 1280, height: 800, mobile: false },
]

type StakeLine = { text: string; badge: { w: number; h: number; bg: string; border: string; radius: string; aria: string | null } | null; aligned: boolean }

async function readStakeLines(page: Page): Promise<StakeLine[]> {
  return page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll<HTMLElement>('div')).filter((div) => {
      const first = div.firstElementChild
      return first?.tagName === 'SPAN' && (first.textContent ?? '').trim().startsWith('Вход ') && div.children.length <= 2
    })
    return lines.map((line) => {
      const span = line.firstElementChild as HTMLElement
      const badge = line.querySelector<HTMLElement>('[data-private-room-voice-badge="1"]')
      if (badge === null) return { text: span.textContent!.trim(), badge: null, aligned: true }
      const s = span.getBoundingClientRect()
      const b = badge.getBoundingClientRect()
      const style = getComputedStyle(badge)
      return {
        text: span.textContent!.trim(),
        badge: { w: b.width, h: b.height, bg: style.backgroundColor, border: style.borderTopColor, radius: style.borderTopLeftRadius, aria: badge.getAttribute('aria-label') },
        aligned: Math.abs((s.top + s.height / 2) - (b.top + b.height / 2)) <= 3,
      }
    })
  })
}

async function readWaitingBadge(page: Page): Promise<StakeLine['badge']> {
  return page.evaluate(() => {
    const badge = document.querySelector<HTMLElement>('[data-private-room-voice-badge="1"]')
    if (badge === null) return null
    const b = badge.getBoundingClientRect()
    const style = getComputedStyle(badge)
    return { w: b.width, h: b.height, bg: style.backgroundColor, border: style.borderTopColor, radius: style.borderTopLeftRadius, aria: badge.getAttribute('aria-label') }
  })
}

console.log('\ncheckPrivateGamesVoiceBadge\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null
try {
  const port = await freePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()
  const base = `http://127.0.0.1:${port}/scripts/fixtures/voiceMobileUiHarness.html?vip=1`

  for (const vp of VIEWPORTS) {
    const dir = join(OUT, vp.label)
    await mkdir(dir, { recursive: true })
    const open = async (): Promise<Page> => {
      const context = await browser!.newContext(vp.mobile
        ? { viewport: { width: vp.width, height: vp.height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
        : { viewport: { width: vp.width, height: vp.height } })
      const page = await context.newPage()
      page.on('pageerror', (error) => console.error(`    pageerror: ${error.message}`))
      await page.goto(base)
      await page.waitForFunction(() => (window as any).__voiceUiHarness !== undefined, undefined, { timeout: 20_000 })
      await page.waitForFunction(() => ![...document.body.children].some((el) => (el as HTMLElement).style.zIndex === '99999'), undefined, { timeout: 15_000 }).catch(() => {})
      return page
    }

    // Еталонът — значката в „Чакащи“ (същия viewport/тема).
    const refPage = await open()
    await refPage.evaluate(() => (window as any).__voiceUiHarness.showList())
    await refPage.waitForSelector('[data-private-room-voice-badge="1"]', { timeout: 5000 })
    const reference = await readWaitingBadge(refPage)
    await refPage.context().close()

    for (const tab of ['playing', 'finished'] as const) {
      const label = tab === 'playing' ? 'Играещи' : 'Приключили'
      await check(`${vp.label} „${label}“: значка само на гласовия мач, на реда с таксата; без значка за мач без глас и стар запис; същата като в „Чакащи“`, async () => {
        const page = await open()
        await page.evaluate((t) => (window as any).__voiceUiHarness.showGames(t), tab)
        await page.waitForTimeout(300)
        await page.screenshot({ path: join(dir, `${tab}.png`), fullPage: false })
        const lines = await readStakeLines(page)
        assert(lines.length === 3, `редове с такса: ${JSON.stringify(lines.map((l) => l.text))}`)
        const withBadge = lines.filter((l) => l.badge !== null)
        assert(withBadge.length === 1 && /^Вход 5\D?000/.test(withBadge[0]!.text), `значка: ${JSON.stringify(lines.map((l) => [l.text, l.badge !== null]))}`)
        assert(withBadge[0]!.aligned, 'значката не е на реда с таксата')
        assert(reference !== null, 'няма еталонна значка от „Чакащи“')
        const badge = withBadge[0]!.badge!
        assert(Math.abs(badge.w - reference!.w) < 0.5 && Math.abs(badge.h - reference!.h) < 0.5, `размер ${badge.w}x${badge.h} срещу ${reference!.w}x${reference!.h}`)
        assert(badge.bg === reference!.bg && badge.border === reference!.border && badge.radius === reference!.radius, `стил ${JSON.stringify(badge)} срещу ${JSON.stringify(reference)}`)
        assert(badge.aria === 'Гласов чат', `aria-label: ${badge.aria}`)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
        assert(!overflow, 'хоризонтален скрол')
        await page.context().close()
      })
    }
  }
} finally {
  await browser?.close()
  await vite?.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
console.log(`Скрийншоти: ${OUT}`)
if (failed > 0) process.exit(1)
