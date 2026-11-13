/**
 * checkVoiceAdminPanel.ts
 *
 * Гласов чат, Етап 6 — визуални и поведенчески проверки на админ панела
 * „Гласови разговори“ в реален Chromium: реалният showAdminVoiceChatPanel с
 * фиксирани отговори (scripts/fixtures/voiceAdminPanelHarness.ts). Не е тест
 * на реален LiveKit/VPS — проверява интерфейса, „Недостъпно“ вместо 0,
 * потвържденията и заявките към админ API-то.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceAdminPanel.ts
 *
 * Скрийншоти: <tmp>/belot-v2-voice-admin-screenshots/<viewport>/*.png
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('no port'))
      server.close(() => resolve(address.port))
    })
  })
}

const OUT = join(tmpdir(), 'belot-v2-voice-admin-screenshots')
const VIEWPORTS = [
  { label: 'desktop-1280x800', width: 1280, height: 800, mobile: false },
  { label: 'mobile-390x844', width: 390, height: 844, mobile: true },
  { label: 'mobile-320x568', width: 320, height: 568, mobile: true },
]
const TABS: Array<[string, string]> = [['control', 'Управление'], ['live', 'Текущо'], ['stats', 'Статистика'], ['vps', 'VPS']]

let vite: ViteDevServer | null = null
let browser: Browser | null = null
try {
  const port = await freePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()
  const base = `http://127.0.0.1:${port}/scripts/fixtures/voiceAdminPanelHarness.html`

  console.log('\ncheckVoiceAdminPanel\n')

  for (const vp of VIEWPORTS) {
    const dir = join(OUT, vp.label)
    await mkdir(dir, { recursive: true })
    const open = async (scenario: string, extra = ''): Promise<Page> => {
      const context = await browser!.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.mobile, isMobile: vp.mobile, deviceScaleFactor: vp.mobile ? 2 : 1 })
      const page = await context.newPage()
      page.on('pageerror', (error) => console.error(`    pageerror: ${error.message}`))
      await page.goto(`${base}?scenario=${scenario}${extra}`)
      await page.waitForFunction(() => (window as any).__voiceAdminHarness?.ready() === true, undefined, { timeout: 20_000 })
      // Само за скрийншотите: overlay-ът е position:fixed със собствен scroll —
      // в документа, за да влезе целият панел във fullPage скрийншота.
      await page.addStyleTag({ content: '#admin-voice-chat-panel{position:absolute!important;inset:auto!important;top:0!important;left:0!important;right:0!important;min-height:100%;overflow:visible!important}' })
      await page.waitForTimeout(150)
      return page
    }
    const openTab = async (page: Page, key: string) => {
      await page.click(`[data-avc-tab="${key}"]`)
      await page.waitForTimeout(100)
    }
    const fullShot = (page: Page, name: string) => page.screenshot({ path: join(dir, `${name}.png`), fullPage: true })
    const bodyText = (page: Page) => page.evaluate(() => document.querySelector('[data-avc-body="1"]')?.textContent ?? '')
    const overflow = (page: Page) => page.evaluate(() => {
      const section = document.querySelector('#admin-voice-chat-panel section')!
      return section.scrollWidth > section.clientWidth + 1 || document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    })

    console.log(`--- ${vp.label} ---`)

    await check(`${vp.label} пълни данни: 4 таба, стойностите са показани, без хоризонтален overflow`, async () => {
      const page = await open('full')
      for (const [index, [key]] of TABS.entries()) {
        await openTab(page, key)
        assert(!(await overflow(page)), `таб ${key}: хоризонтален overflow`)
        await fullShot(page, `full-${String(index + 1).padStart(2, '0')}-${key}`)
      }
      await openTab(page, 'live')
      const live = await bodyText(page)
      assert(live.includes('Резервирани маси') && live.includes('С включен микрофон') && live.includes('Само слушат'), 'плочките на текущото състояние')
      assert((await page.locator('[data-avc-table-row="1"]').count()) === 3, 'три гласови маси в списъка')
      assert(live.includes('Смяна на стаята'), 'маса с чакаща ротация')
      await openTab(page, 'vps')
      const vps = await bodyText(page)
      assert(vps.includes('1.13.11') && vps.includes('vCPU 3') && vps.includes('eth0'), 'версия, vCPU и интерфейс')
      assert(vps.includes('Mbit/s') || vps.includes('kbit/s'), 'трафик като скорост')
      assert(vps.includes('Натиск върху CPU (PSI)') && !vps.includes('Throttling (CPU pressure'), 'етикет „Натиск върху CPU (PSI)“')
      await openTab(page, 'stats')
      const stats = await bodyText(page)
      assert(stats.includes('През TURN') && stats.includes('16,3') && stats.includes('Смяна на стаята (изчакване)'), 'TURN % и причини за отказ')
      await page.context().close()
    })

    await check(`${vp.label} неконфигуриран VPS/LiveKit: „Недостъпно“ навсякъде, без 0 % за CPU/RAM`, async () => {
      const page = await open('unconfigured')
      await fullShot(page, 'unconfigured-01-control')
      const control = await bodyText(page)
      assert(control.includes('VOICE_VPS_METRICS_URL') && control.includes('Не е конфигурирано'), 'имената на липсващите настройки')
      await openTab(page, 'vps')
      await fullShot(page, 'unconfigured-04-vps')
      const vps = await bodyText(page)
      assert(vps.includes('не са конфигурирани') && vps.includes('Недостъпно'), 'VPS: недостъпно')
      assert(!/0[,.]0 %/.test(vps) && !/\b0 %/.test(vps), 'без 0 % за неналични стойности')
      await openTab(page, 'live')
      await fullShot(page, 'unconfigured-02-live')
      const live = await bodyText(page)
      assert(live.includes('LiveKit не е конфигуриран'), 'live статус')
      assert((await page.locator('[data-avc-tile="1"] [data-avc-unavailable="1"]').count()) >= 4, 'плочките показват „Недостъпно“ (не 0)')
      await page.context().close()
    })

    await check(`${vp.label} недостъпен VPS/LiveKit: причина, последно успешно, броевете „Недостъпно“`, async () => {
      const page = await open('offline')
      await openTab(page, 'live')
      await fullShot(page, 'offline-02-live')
      const live = await bodyText(page)
      assert(live.includes('LiveKit API недостъпно') && live.includes('circuit breaker'), 'причина за live')
      await openTab(page, 'vps')
      await fullShot(page, 'offline-04-vps')
      const vps = await bodyText(page)
      assert(vps.includes('timeout') && vps.includes('401') && vps.includes('Последно успешно'), 'причини и последно успешно четене')
      assert(!vps.includes('1.13.11'), 'без стара версия като актуална')
      await page.context().close()
    })

    if (vp.label === 'desktop-1280x800') {
      await check(`${vp.label} първо четене: скоростите „Изчислява се…“, не 0`, async () => {
        const page = await open('computing')
        await openTab(page, 'vps')
        await fullShot(page, 'computing-04-vps')
        const vps = await bodyText(page)
        assert(vps.includes('Изчислява се'), 'изчислява се')
        await page.context().close()
      })

      await check(`${vp.label} режим: изисква потвърждение; аварийно изключване -> POST mode=off, confirm:true; лимит -> POST`, async () => {
        const page = await open('full')
        const requests = () => page.evaluate(() => (window as any).__voiceAdminHarness.requests as Array<{ method: string; path: string; body: any }>)
        await page.click('[data-avc-mode="public"]')
        await page.waitForTimeout(100)
        assert((await page.locator('[data-avc-mode-confirm="1"]').count()) === 1, 'прозорец за потвърждение')
        assert(!(await requests()).some((r) => r.method === 'POST'), 'без заявка преди потвърждение')
        await page.click('[data-avc-mode-cancel="1"]')
        await page.click('[data-avc-emergency="1"]')
        await page.waitForTimeout(100)
        await fullShot(page, 'action-01-emergency-confirm')
        assert(!(await requests()).some((r) => r.method === 'POST'), 'аварийното също изисква потвърждение')
        await page.click('[data-avc-emergency-apply="1"]')
        await page.waitForTimeout(300)
        const post = (await requests()).find((r) => r.method === 'POST' && r.path === '/mode')
        assert(post !== undefined && post.body.mode === 'off' && post.body.confirm === true, 'POST /mode off + confirm')
        const notice = await page.evaluate(() => document.querySelector('[data-avc-notice="1"]')?.textContent ?? '')
        assert(notice.includes('Игрите продължават') && notice.includes('Прекратени гласови маси: 3'), 'съобщение с броя прекратени маси')
        assert(notice.includes('чака') && notice.includes('потвърждение') && !notice.includes('изтрити'), 'чакащото DeleteRoom не е представено като потвърдено')
        const control = await bodyText(page)
        assert(control.includes('Заети слотове: 0 / 10'), `резервираните слотове са 0 след изключването (${control.match(/Заети слотове: [^П]*/)?.[0] ?? '?'})`)
        assert(/DeleteRoom\s*2/.test(control), 'чакащите DeleteRoom се виждат (2)')
        await fullShot(page, 'action-02-emergency-done')
        await openTab(page, 'live')
        const liveAfter = await bodyText(page)
        assert(liveAfter.includes('Няма активни гласови маси') && (await page.locator('[data-avc-table-row="1"]').count()) === 0, 'без остарели маси в „Текущо състояние“')
        await fullShot(page, 'action-03-emergency-live')
        await openTab(page, 'control')
        await page.fill('[data-avc-limit-input="1"]', '7')
        await page.click('[data-avc-limit-save="1"]')
        await page.waitForTimeout(200)
        const limit = (await requests()).find((r) => r.method === 'POST' && r.path === '/limit')
        assert(limit !== undefined && limit.body.maxTables === 7, 'POST /limit 7')
        await page.fill('[data-avc-limit-input="1"]', '-3')
        await page.click('[data-avc-limit-save="1"]')
        await page.waitForTimeout(100)
        assert((await requests()).filter((r) => r.path === '/limit').length === 1, 'невалиден лимит не се изпраща')
        await page.context().close()
      })

      await check(`${vp.label} аварийно изключване: съобщението става „изтрити (потвърдено)“ едва когато чакащите DeleteRoom са 0`, async () => {
        const page = await open('full', '&refresh=250&confirmAfter=2')
        await page.click('[data-avc-emergency="1"]')
        await page.click('[data-avc-emergency-apply="1"]')
        await page.waitForTimeout(150)
        const notice = () => page.evaluate(() => document.querySelector('[data-avc-notice="1"]')?.textContent ?? '')
        assert((await notice()).includes('чака потвърждение'), 'първо: чака потвърждение')
        await page.waitForFunction(() => (document.querySelector('[data-avc-notice="1"]')?.textContent ?? '').includes('потвърдено'), undefined, { timeout: 5_000 })
        assert((await bodyText(page)).includes('Заети слотове: 0 / 10'), 'слотовете остават 0')
        await fullShot(page, 'action-04-emergency-confirmed')
        await page.context().close()
      })

      await check(`${vp.label} обновяване само докато панелът е отворен; след затваряне — без заявки`, async () => {
        const page = await open('full', '&refresh=200')
        await page.waitForTimeout(700)
        const count = () => page.evaluate(() => ((window as any).__voiceAdminHarness.requests as unknown[]).length)
        const whileOpen = await count()
        assert(whileOpen >= 4, `периодично обновяване (${whileOpen})`)
        await page.evaluate(() => (window as any).__voiceAdminHarness.close())
        const afterClose = await count()
        await page.waitForTimeout(700)
        assert((await count()) === afterClose, 'без заявки след затваряне')
        assert((await page.locator('#admin-voice-chat-panel').count()) === 0, 'панелът е премахнат')
        await page.context().close()
      })

      await check(`${vp.label} без права (403): съобщение, без данни`, async () => {
        const page = await open('forbidden').catch(async () => {
          // ready() не става true (няма данни) — отваряме директно.
          const context = await browser!.newContext({ viewport: { width: vp.width, height: vp.height } })
          const p = await context.newPage()
          await p.goto(`${base}?scenario=forbidden`)
          await p.waitForTimeout(600)
          return p
        })
        const text = await page.evaluate(() => document.querySelector('#admin-voice-chat-panel')?.textContent ?? '')
        assert(text.includes('Нямаш достъп'), 'съобщение за достъп')
        await fullShot(page, 'forbidden')
        await page.context().close()
      })
    }
  }
} finally {
  await browser?.close()
  await vite?.close()
}

console.log(`\nСкрийншоти: ${OUT}`)
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
