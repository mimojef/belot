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
      // Таблица „Микрофон“: първоначално / от панела, прекъсвания, getUserMedia, LiveKit и ротации.
      assert((await page.locator('[data-avc-mic="1"]').count()) === 1, 'картата „Микрофон“')
      const mic = ((await page.locator('[data-avc-mic="1"]').textContent()) ?? '').replace(/\s+/g, ' ')
      for (const text of ['Първоначално включване', 'Ръчно през панела', 'Възстановен', 'Изгубен', 'Възстановяване на връзката (LiveKit)',
        'Публикуване — отменено от reconnect', 'под 1 s', '5–15 s', 'Неуспешно републикуване след reconnect', 'Изтрита стая',
        'Отнето право за слушане (напускане/изгонване/бан)', 'След рестарт на сървъра']) {
        assert(mic.includes(text), `„Микрофон“: липсва „${text}“`)
      }
      await fullShot(page, 'stats-mic')
      // Етап H: „Медийно здраве“ — броячи, допълнителен сигнал и последните събития (в българско време).
      assert((await page.locator('[data-avc-media="1"]').count()) === 1, 'картата „Медийно здраве“')
      const media = ((await page.locator('[data-avc-media="1"]').textContent()) ?? '').replace(/\s+/g, ' ')
      for (const text of ['Медийно здраве', 'Подозрение: микрофонът не предава (RTP стои)', 'Capture-ът не дава кадри', 'Неочаквано спрян звук (пауза)',
        'Говори, но звукът не пристига (допълнителен сигнал)', 'Пуснат отново — успех', '„Включи звука“ — успех', 'iPhone/iPad · Safari', 'Android · Samsung Internet',
        'Последни събития (до 500', '18.11, 15:39', 'stall_suspected/capture_stalled/none', '„Подозрение“ не е доказан дефект']) {
        assert(media.includes(text), `„Медийно здраве“: липсва „${text}“`)
      }
      assert((await page.locator('[data-avc-media-recent="1"] [data-avc-media-recent-row="1"]').count()) === 4, 'четири последни събития')
      await page.locator('[data-avc-media="1"]').screenshot({ path: join(dir, 'stats-media-health.png') })
      // „Прекратяване на гласови сесии“: сървърни причини (вкл. причината от клиента), край на участието, откази, lease при токен; браузърни причини и етапи.
      assert((await page.locator('[data-avc-session-ends="1"]').count()) === 1, 'картата „Прекратяване на гласови сесии“')
      const ends = ((await page.locator('[data-avc-session-ends="1"]').textContent()) ?? '').replace(/\s+/g, ' ')
      for (const text of ['Напуснал екрана — Затваряне или скриване на страницата', 'Напуснал екрана — Без посочена причина (стар клиент)', 'Изтекло присъствие (lease)',
        '120 s без игрова връзка', 'Нова страница на същия играч — с ротация', 'Не е връзката на мястото', '„Напусни гласа“',
        'Неуспешно свързване („недостъпен“)', 'Присъствие (presence)', 'Свързване след ротация', 'под 5 s']) {
        assert(ends.includes(text), `„Прекратяване“: липсва „${text}“`)
      }
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

    // ─── Автоматично обновяване: пазене на изгледа (скрол, маркиране, полета), пауза, „Копирай лога“ ───
    // Без стила за скрийншоти: overlay-ът е position:fixed със собствен скрол, както в production.
    const openLive = async (extra: string): Promise<Page> => {
      const context = await browser!.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.mobile, isMobile: vp.mobile, deviceScaleFactor: vp.mobile ? 2 : 1 })
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      const page = await context.newPage()
      page.on('pageerror', (error) => console.error(`    pageerror: ${error.message}`))
      await page.goto(`${base}?scenario=full${extra}`)
      await page.waitForFunction(() => (window as any).__voiceAdminHarness?.ready() === true, undefined, { timeout: 20_000 })
      return page
    }
    const monitoringReads = (page: Page) => page.evaluate(() => ((window as any).__voiceAdminHarness.requests as Array<{ path: string }>).filter((r) => r.path === '/monitoring').length)
    const waitRefreshes = async (page: Page, count: number) => {
      const target = (await monitoringReads(page)) + count
      await page.waitForFunction((t) => ((window as any).__voiceAdminHarness.requests as Array<{ path: string }>).filter((r) => r.path === '/monitoring').length >= t, target, { timeout: 10_000 })
      await page.waitForTimeout(80)
    }
    const headerText = (page: Page) => page.evaluate(() => document.querySelector('[data-avc-updated="1"]')?.textContent ?? '')
    const scrollMedia = (page: Page, listTop: number) => page.evaluate((top) => {
      const host = document.getElementById('admin-voice-chat-panel')!
      const card = host.querySelector<HTMLElement>('[data-avc-media="1"]')!
      host.scrollTop += card.getBoundingClientRect().top - 40
      host.querySelector<HTMLElement>('[data-avc-media-recent="1"]')!.scrollTop = top
    }, listTop)
    const mediaView = (page: Page) => page.evaluate(() => {
      const host = document.getElementById('admin-voice-chat-panel')!
      const list = host.querySelector<HTMLElement>('[data-avc-media-recent="1"]')!
      const listTop = list.getBoundingClientRect().top
      const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-avc-media-recent-row="1"]'))
      const first = rows.find((row) => row.getBoundingClientRect().bottom > listTop)!
      return {
        hostTop: host.scrollTop,
        listScroll: list.scrollTop,
        firstText: first.textContent ?? '',
        firstOffset: first.getBoundingClientRect().top - listTop,
        cardTop: host.querySelector<HTMLElement>('[data-avc-media="1"]')!.getBoundingClientRect().top,
        rows: rows.length,
        newest: rows[0]!.textContent ?? '',
      }
    })

    if (vp.label !== 'mobile-320x568') {
      for (const [variant, extra] of [['буферът расте', ''], ['пълен буфер — най-старите отпадат', '&recentLimit=120']] as const) {
        await check(`${vp.label} „Медийно здраве“ (${variant}): автоматичното обновяване пази позицията в „Последни събития“ и на страницата`, async () => {
          const page = await openLive(`&refresh=300&recent=120&grow=1${extra}`)
          await openTab(page, 'stats')
          await scrollMedia(page, 1500)
          await page.waitForTimeout(50)
          const before = await mediaView(page)
          assert(before.listScroll > 1000 && before.firstText.includes('old-event-'), `начален скрол (${before.listScroll})`)
          await waitRefreshes(page, 3)
          const after = await mediaView(page)
          assert(after.newest !== before.newest && after.newest.includes('new-event-'), 'новите събития са в DOM-а (има прерисуване)')
          assert(after.firstText === before.firstText, `същият ред остава първи видим („${before.firstText}“ -> „${after.firstText}“)`)
          assert(Math.abs(after.firstOffset - before.firstOffset) <= 2, `отместване на реда ${before.firstOffset} -> ${after.firstOffset}`)
          assert(after.listScroll > before.listScroll, `списъкът е преместен с новите редове отгоре (${before.listScroll} -> ${after.listScroll})`)
          assert(Math.abs(after.cardTop - before.cardTop) <= 2 && Math.abs(after.hostTop - before.hostTop) <= 2, `страницата не мърда (карта ${before.cardTop} -> ${after.cardTop})`)
          await page.context().close()
        })
      }

      await check(`${vp.label} „Медийно здраве“: в началото на списъка новите събития се виждат (скролът остава 0)`, async () => {
        const page = await openLive('&refresh=300&recent=120&grow=1')
        await openTab(page, 'stats')
        await scrollMedia(page, 0)
        const before = await mediaView(page)
        await waitRefreshes(page, 2)
        const after = await mediaView(page)
        assert(after.listScroll === 0 && after.newest !== before.newest && after.newest.includes('new-event-'), `най-новото отгоре (${after.listScroll}, ${after.newest})`)
        await page.context().close()
      })

      await check(`${vp.label} „Медийно здраве“: маркираният текст остава; обновяването изчаква и се прилага след размаркиране`, async () => {
        const page = await openLive('&refresh=250&recent=120&grow=1')
        await openTab(page, 'stats')
        await scrollMedia(page, 1500)
        const selected = await page.evaluate(() => {
          const list = document.querySelector<HTMLElement>('[data-avc-media-recent="1"]')!
          const listTop = list.getBoundingClientRect().top
          const row = Array.from(list.querySelectorAll<HTMLElement>('[data-avc-media-recent-row="1"]')).find((r) => r.getBoundingClientRect().top >= listTop)!
          ;(window as any).__markedRow = row
          const range = document.createRange()
          range.setStart(row.firstElementChild!.firstChild!, 0)
          range.setEnd(row.lastElementChild!.firstChild!, (row.lastElementChild!.textContent ?? '').length)
          getSelection()!.removeAllRanges()
          getSelection()!.addRange(range)
          return getSelection()!.toString()
        })
        const before = await mediaView(page)
        await waitRefreshes(page, 3)
        const during = await page.evaluate(() => ({ text: getSelection()!.toString(), connected: (window as any).__markedRow.isConnected as boolean }))
        assert(during.text === selected && during.connected, `маркирането е непокътнато („${selected}“ -> „${during.text}“)`)
        assert((await headerText(page)).includes('изчакват маркирания текст'), 'заглавието показва, че обновяването изчаква')
        await page.evaluate(() => getSelection()!.removeAllRanges())
        await page.waitForTimeout(120)
        const after = await mediaView(page)
        assert(!(await page.evaluate(() => (window as any).__markedRow.isConnected as boolean)), 'след размаркиране — прерисувано с новите данни')
        assert(after.newest !== before.newest && after.firstText === before.firstText, 'и позицията пак е запазена')
        assert(!(await headerText(page)).includes('изчакват'), 'заглавието вече не изчаква')
        await page.context().close()
      })

      await check(`${vp.label} „Пауза на обновяването“ / „Възобнови обновяването“`, async () => {
        const page = await openLive('&refresh=200&recent=30&grow=1')
        await openTab(page, 'stats')
        await page.click('[data-avc-pause="1"]')
        const pause = page.locator('[data-avc-pause="1"]')
        assert((await pause.textContent()) === 'Възобнови обновяването' && (await pause.getAttribute('aria-pressed')) === 'true', 'бутонът сменя надписа')
        assert((await headerText(page)).includes('на пауза'), 'заглавието показва пауза')
        const paused = await monitoringReads(page)
        const newest = (await mediaView(page)).newest
        await page.waitForTimeout(900)
        assert((await monitoringReads(page)) === paused && (await mediaView(page)).newest === newest, 'без заявки и без промени по време на пауза')
        await page.click('[data-avc-refresh="1"]')
        await page.waitForTimeout(300)
        const manual = await monitoringReads(page)
        assert(manual === paused + 1, `„Обнови“ работи и при пауза (${paused} -> ${manual})`)
        await page.waitForTimeout(700)
        assert((await monitoringReads(page)) === manual, 'след ръчното обновяване паузата продължава')
        await page.click('[data-avc-pause="1"]')
        assert((await pause.textContent()) === 'Пауза на обновяването' && (await pause.getAttribute('aria-pressed')) === 'false', 'надписът се връща')
        await page.waitForTimeout(700)
        assert((await monitoringReads(page)) >= manual + 3, 'автоматичното обновяване продължава (веднага + по интервал)')
        assert(!(await overflow(page)), 'без хоризонтален overflow с новия бутон')
        await page.context().close()
      })

      await check(`${vp.label} „Управление“: въведен лимит, фокус, отворено потвърждение и маркиран текст остават при обновяване`, async () => {
        const page = await openLive('&refresh=250&baseTick=1')
        const pending = () => page.evaluate(() => (document.querySelector('[data-avc-body="1"]')?.textContent ?? '').match(/DeleteRoom\s*(\d+)/)?.[1] ?? '')
        await page.click('[data-avc-mode="public"]')
        await page.fill('[data-avc-limit-input="1"]', '7')
        const pendingBefore = await pending()
        await waitRefreshes(page, 2)
        assert((await pending()) !== pendingBefore, 'данните на таба са прерисувани')
        const state = await page.evaluate(() => {
          const input = document.querySelector<HTMLInputElement>('[data-avc-limit-input="1"]')!
          return { value: input.value, focused: document.activeElement === input }
        })
        assert(state.value === '7' && state.focused, `въведената стойност и фокусът (${state.value}, ${state.focused})`)
        assert((await page.locator('[data-avc-mode-confirm="1"]').count()) === 1, 'отвореното потвърждение остава')
        const selected = await page.evaluate(() => {
          const heading = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent === 'История на промените')!
          const range = document.createRange()
          range.selectNodeContents(heading)
          getSelection()!.removeAllRanges()
          getSelection()!.addRange(range)
          return getSelection()!.toString()
        })
        const pendingSelected = await pending()
        await waitRefreshes(page, 2)
        assert((await page.evaluate(() => getSelection()!.toString())) === selected && (await pending()) === pendingSelected, 'маркираното остава, прерисуването изчаква')
        await page.evaluate(() => getSelection()!.removeAllRanges())
        await page.waitForTimeout(120)
        assert((await pending()) !== pendingSelected, 'след размаркиране — новите данни')
        // Външният скрол на страницата.
        const scrolled = await page.evaluate(() => {
          const host = document.getElementById('admin-voice-chat-panel')!
          host.scrollTop = host.scrollHeight
          return host.scrollTop
        })
        await waitRefreshes(page, 2)
        const hostTop = await page.evaluate(() => document.getElementById('admin-voice-chat-panel')!.scrollTop)
        assert(Math.abs(hostTop - scrolled) <= 2, `скролът на страницата (${scrolled} -> ${hostTop})`)
        await page.context().close()
      })
    }

    if (vp.label === 'mobile-320x568') {
      await check(`${vp.label} лентата с табове пази хоризонталния скрол при обновяване`, async () => {
        const page = await openLive('&refresh=200&recent=30&grow=1&baseTick=1')
        const left = await page.evaluate(() => {
          const tabs = document.querySelector<HTMLElement>('[data-avc-tabs="1"]')!
          tabs.scrollLeft = 120
          return tabs.scrollLeft
        })
        assert(left > 0, 'табовете се скролират хоризонтално')
        await waitRefreshes(page, 2)
        assert((await page.evaluate(() => document.querySelector<HTMLElement>('[data-avc-tabs="1"]')!.scrollLeft)) === left, 'хоризонталният скрол остава')
        assert(!(await overflow(page)), 'без хоризонтален overflow (бутоните в заглавието се пренасят)')
        await page.context().close()
      })
    }

    if (vp.label === 'desktop-1280x800') {
      await check(`${vp.label} „Копирай лога“: всички събития и броячи като четим текст; резервен вариант и грешка`, async () => {
        const page = await openLive('&recent=25')
        await openTab(page, 'stats')
        await page.click('[data-avc-media-copy="1"]')
        await page.waitForFunction(() => (document.querySelector('[data-avc-media-copy-status="1"]')?.textContent ?? '').includes('Копирано'), undefined, { timeout: 3_000 })
        const status = await page.locator('[data-avc-media-copy-status="1"]').textContent()
        assert(status?.includes('Копирано: 25 събития') === true, `статус (${status})`)
        const text = await page.evaluate(() => navigator.clipboard.readText())
        for (const part of ['Гласови разговори — Медийно здраве', 'Генерирано:', 'Микрофон (собствен поток):', 'Подозрение: микрофонът не предава (RTP стои) [stall_suspected]: 2',
          'Входящ звук:', 'Автоматично възстановяване на звука:', 'По платформа (медийни събития):', 'Последни събития: 25 (до 500', '18.11, 14:00', '(2026-11-18T12:00Z UTC) | media_input | iPhone/iPad · Safari | old-event-0', 'old-event-24']) {
          assert(text.includes(part), `логът съдържа „${part}“`)
        }
        assert(text.split('\n').filter((line) => /\| media_(input|output|recovery) \|/.test(line)).length === 25, 'по един ред на събитие')
        // Резервен вариант (Clipboard API отказан): execCommand('copy').
        await page.evaluate(() => navigator.clipboard.writeText('стар клипборд'))
        await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')) })
        await page.click('[data-avc-media-copy="1"]')
        await page.waitForTimeout(200)
        const fallback = await page.evaluate(() => navigator.clipboard.readText())
        assert(fallback.startsWith('Гласови разговори — Медийно здраве') && fallback.includes('old-event-24'), 'резервното копиране работи')
        assert((await page.locator('#admin-voice-chat-panel textarea').count()) === 0, 'временното поле е премахнато')
        await page.evaluate(() => { document.execCommand = () => false })
        await page.click('[data-avc-media-copy="1"]')
        await page.waitForTimeout(200)
        assert(((await page.locator('[data-avc-media-copy-status="1"]').textContent()) ?? '').includes('Копирането не успя'), 'съобщение при неуспех')
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
