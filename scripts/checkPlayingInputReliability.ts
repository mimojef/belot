/**
 * checkPlayingInputReliability.ts
 *
 * Регресионни тестове за оплакванията "натискам карта и не хвърля", "бави,
 * натискам няколко пъти", "натискам едно, друго хвърля" (20.10.2026).
 *
 * Реален браузър (Playwright), реален createActiveRoomFlowController() +
 * renderPlayingScreen(), реален DOM (fixture: playingInputReliabilityHarness).
 * Card click-овете са DOM click() по конкретния бутон — геометрията/hit-test
 * на ветрилото се покрива отделно от checkPlayingHandOverlapHitTest.ts.
 * 5-сек watchdog таймерите се пускат ръчно (детерминистично, без реално чакане).
 *
 *  [1] tap -> точно 1 команда със същия cardId + незабавна визуална обратна
 *      връзка; повторни tap-ове (същата или друга карта) НЕ пращат нищо.
 *  [2] snapshot, пристигнал преди сървърът да обработи картата, НЕ отключва
 *      ръката (иначе: in-flight карта + втора карта).
 *  [3] изгубена команда: watchdog -> resync; snapshot след resync, който
 *      показва, че още сме на ход -> ръката се отключва + съобщение; картата
 *      НЕ се изпраща автоматично; следващият tap праща ИЗБРАНАТА нова карта.
 *  [4] без отговор и на resync -> reconnect fallback; затворена връзка
 *      (setConnectionState(false)) освобождава ръката.
 *  [5] нормално потвърждение -> watchdog-ът се отменя, няма resync.
 *  [6] tap без връзка -> нищо не се изпраща, ръката НЕ се заключва,
 *      съобщение; след връзка tap-ът работи.
 *  [7] отхвърлен ход (server error) -> видимо съобщение + отключване.
 *  [8] declaration prompt: re-render-и не пресъздават overlay-я (иначе tap
 *      по "Продължи" се губи); "Продължи" праща избраната карта.
 *  [10] забавен сървър: snapshot отпреди обработката на картата, пристигнал
 *      след resync заявката, НЕ отключва; приложена карта -> точно 1 действие.
 *  [11] несвързан server error, докато картата още чака -> без отключване.
 *  [12] ход 5/10/15 сек -> първа watchdog проверка на 1.5/3/4.5 сек.
 *  [13] (mobile) бързи последователни докосвания -> точно 1 действие, първата карта.
 *  [9] пълна маса, реален вход по цялото ветрило (mobile: CDP touch с радиус
 *      0/14px; desktop: мишка), вкл. затъмнена карта: изпраща се само картата
 *      под центъра на докосването или нищо — никога съседна карта.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
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
async function check(label: string, fn: () => Promise<void>): Promise<void> {
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
        reject(new Error('no free port'))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

type PlayCommand = { roomId: string; cardId: string; declarationKeys: string[] }

function h<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([m, a]) => (window as any).__playingInputHarness[m as string](...(a as unknown[])),
    [method, args] as const,
  ) as Promise<T>
}

const PENDING_LIFT = 'translateY(-28px)'

async function runSuite(page: Page, label: string): Promise<void> {
  const commands = () => h<PlayCommand[]>(page, 'getPlayCommands')

  await check(`[${label}][1] tap -> exactly one command for the tapped card, immediate feedback, no double submit`, async () => {
    await h(page, 'reset')
    await h(page, 'enterPlaying')
    assert(await h<boolean>(page, 'clickCard', 'c7'), 'c7 трябва да е активна')
    const afterFirst = await commands()
    assert(afterFirst.length === 1 && afterFirst[0]!.cardId === 'c7', `очаквана 1 команда c7, получено ${JSON.stringify(afterFirst)}`)
    const transform = await h<string | null>(page, 'cardTransform', 'c7')
    assert(transform?.includes(PENDING_LIFT) === true, `изпратената карта трябва веднага да е повдигната, transform=${transform}`)
    await h(page, 'clickCard', 'd9')
    await h(page, 'clickCard', 'c7')
    await h(page, 'clickCard', 'sA')
    assert((await commands()).length === 1, 'повторните tap-ове не трябва да пращат нови команди')
  })

  await check(`[${label}][2] in-flight snapshot does not unlock the hand and keeps the pending highlight`, async () => {
    // Продължава от [1]: c7 е pending, сървърът още не я е обработил.
    const roomId = (await commands())[0]!.roomId
    await h(page, 'snapshot', roomId, await h(page, 'playingGame'))
    await h(page, 'rerender')
    await h(page, 'clickCard', 'd9')
    assert((await commands()).length === 1, 'snapshot преди потвърждение не бива да позволява втора карта')
    assert((await h<string | null>(page, 'noticeText')) === null, 'не трябва да има съобщение за грешка')
    const transform = await h<string | null>(page, 'cardTransform', 'c7')
    assert(transform?.includes(PENDING_LIFT) === true, `pending визуализацията трябва да оцелее след re-render, transform=${transform}`)
  })

  await check(`[${label}][3] lost command: watchdog -> resync -> unlock + notice; no auto-resend; next tap sends the newly chosen card`, async () => {
    const roomId = (await commands())[0]!.roomId
    assert((await h<number>(page, 'fireWatchdogTimers')) >= 1, 'трябва да има активен watchdog')
    assert((await h<number>(page, 'getResyncRequestCount')) === 1, 'watchdog-ът трябва да поиска resync')
    // Реалният отговор на resync: room_resumed + snapshot.
    await h(page, 'resumed', roomId)
    await h(page, 'snapshot', roomId, await h(page, 'playingGame'))
    const notice = await h<string | null>(page, 'noticeText')
    assert(notice?.includes('не беше потвърдена') === true, `очаквано съобщение за непотвърдена карта, получено ${notice}`)
    assert((await commands()).length === 1, 'картата не трябва да се изпраща автоматично повторно')
    assert(await h<boolean>(page, 'clickCard', 'd9'), 'd9 трябва да е активна след отключване')
    const after = await commands()
    assert(after.length === 2 && after[1]!.cardId === 'd9', `втората команда трябва да е d9, получено ${JSON.stringify(after)}`)
  })

  await check(`[${label}][4] no resync response -> reconnect fallback; closed connection releases the hand`, async () => {
    await h(page, 'reset')
    const roomId = await h<string>(page, 'enterPlaying')
    await h(page, 'clickCard', 'c7')
    await h(page, 'fireWatchdogTimers')
    assert((await h<number>(page, 'getResyncRequestCount')) === 1, 'resync трябва да е поискан')
    await h(page, 'fireWatchdogTimers')
    assert((await h<number>(page, 'getReconnectFallbackCount')) === 1, 'без отговор -> reconnect fallback')
    await h(page, 'setConnectionState', false)
    await h(page, 'setConnectionState', true)
    await h(page, 'snapshot', roomId, await h(page, 'playingGame'))
    assert(await h<boolean>(page, 'clickCard', 'hJ'), 'hJ трябва да е активна')
    const after = await commands()
    assert(after.length === 2 && after[1]!.cardId === 'hJ', `след reconnect tap-ът трябва да работи, получено ${JSON.stringify(after)}`)
  })

  await check(`[${label}][5] confirmed play cancels the watchdog (no resync)`, async () => {
    await h(page, 'reset')
    const roomId = await h<string>(page, 'enterPlaying')
    await h(page, 'clickCard', 'c7')
    await h(page, 'snapshot', roomId, await h(page, 'playingGame', { turnSeat: 'right', removeCardId: 'c7' }))
    assert((await h<number>(page, 'heldTimerCount')) === 0, 'watchdog таймерът трябва да е отменен')
    await h(page, 'fireWatchdogTimers')
    assert((await h<number>(page, 'getResyncRequestCount')) === 0, 'не трябва да има resync след потвърждение')
    assert((await h<string | null>(page, 'cardTransform', 'c7')) === null, 'изиграната карта трябва да е махната от ръката')
  })

  await check(`[${label}][6] offline tap sends nothing and does not lock the hand`, async () => {
    await h(page, 'reset')
    await h(page, 'enterPlaying')
    await h(page, 'setTransportConnected', false)
    await h(page, 'clickCard', 'c7')
    assert((await commands()).length === 0, 'без връзка не трябва да се праща нищо')
    const notice = await h<string | null>(page, 'noticeText')
    assert(notice?.includes('Няма връзка') === true, `очаквано съобщение "Няма връзка", получено ${notice}`)
    const transform = await h<string | null>(page, 'cardTransform', 'c7')
    assert(transform?.includes(PENDING_LIFT) !== true, 'неизпратената карта не трябва да изглежда изпратена')
    await h(page, 'setTransportConnected', true)
    assert(await h<boolean>(page, 'clickCard', 'c7'), 'c7 трябва да остане активна')
    const after = await commands()
    assert(after.length === 1 && after[0]!.cardId === 'c7', `след връзка tap-ът трябва да работи, получено ${JSON.stringify(after)}`)
  })

  await check(`[${label}][7] server rejection: resync first (error is uncorrelated), then visible notice + unlock`, async () => {
    await h(page, 'reset')
    const roomId = await h<string>(page, 'enterPlaying')
    await h(page, 'clickCard', 'c7')
    await h(page, 'serverError', 'Not your turn.')
    assert((await h<number>(page, 'getResyncRequestCount')) === 1, 'error по време на чакаща карта -> незабавен resync')
    await h(page, 'clickCard', 'd9')
    assert((await commands()).length === 1, 'преди отговора на resync ръката остава заключена')
    await h(page, 'resumed', roomId)
    await h(page, 'snapshot', roomId, await h(page, 'playingGame'))
    const notice = await h<string | null>(page, 'noticeText')
    assert(notice?.includes('не беше приет') === true, `очаквано съобщение за отхвърлен ход, получено ${notice}`)
    assert(await h<boolean>(page, 'clickCard', 'd9'), 'd9 трябва да е активна')
    const after = await commands()
    assert(after.length === 2 && after[1]!.cardId === 'd9', `след отхвърляне tap-ът трябва да работи, получено ${JSON.stringify(after)}`)
  })

  await check(`[${label}][10] delayed server: pre-play snapshot arriving after the resync request does NOT unlock; card applied -> exactly one action`, async () => {
    await h(page, 'reset')
    const roomId = await h<string>(page, 'enterPlaying')
    await h(page, 'clickCard', 'c7')
    await h(page, 'fireWatchdogTimers')
    assert((await h<number>(page, 'getResyncRequestCount')) === 1, 'resync поискан')
    // Snapshot, генериран ПРЕДИ сървърът да обработи c7 (напр. emoji на друг
    // играч от същия backlog), пристига след resync заявката.
    await h(page, 'snapshot', roomId, await h(page, 'playingGame'))
    assert((await h<string | null>(page, 'noticeText')) === null, 'не трябва да има съобщение')
    await h(page, 'clickCard', 'd9')
    assert((await commands()).length === 1, 'in-flight snapshot не бива да позволява втора карта')
    // Сървърът обработва c7, после resume_room.
    await h(page, 'snapshot', roomId, await h(page, 'playingGame', { turnSeat: 'right', removeCardId: 'c7' }))
    await h(page, 'resumed', roomId)
    await h(page, 'snapshot', roomId, await h(page, 'playingGame', { turnSeat: 'right', removeCardId: 'c7' }))
    const all = await commands()
    assert(all.length === 1 && all[0]!.cardId === 'c7', `точно едно действие (c7), получено ${JSON.stringify(all)}`)
    assert((await h<string | null>(page, 'noticeText')) === null, 'приложена карта -> без съобщение за грешка')
  })

  await check(`[${label}][11] unrelated error while the card is still queued -> no unlock; card applied -> exactly one action`, async () => {
    await h(page, 'reset')
    const roomId = await h<string>(page, 'enterPlaying')
    await h(page, 'clickCard', 'c7')
    await h(page, 'serverError', 'Подаръкът не може да бъде изпратен.')
    await h(page, 'clickCard', 'd9')
    assert((await commands()).length === 1, 'несвързан error не бива да отключва ръката')
    await h(page, 'snapshot', roomId, await h(page, 'playingGame', { turnSeat: 'right', removeCardId: 'c7' }))
    await h(page, 'resumed', roomId)
    await h(page, 'snapshot', roomId, await h(page, 'playingGame', { turnSeat: 'right', removeCardId: 'c7' }))
    const all = await commands()
    assert(all.length === 1 && all[0]!.cardId === 'c7', `точно едно действие (c7), получено ${JSON.stringify(all)}`)
  })

  for (const [turnMs, expectedDelay] of [[5000, 1500], [10000, 3000], [15000, 4500]] as const) {
    await check(`[${label}][12] ${turnMs / 1000}s turn: first watchdog check at ${expectedDelay}ms (turn timer unchanged)`, async () => {
      await h(page, 'reset')
      await h(page, 'setTurnTimeoutMs', turnMs)
      await h(page, 'enterPlaying')
      await h(page, 'clickCard', 'c7')
      const delays = await h<number[]>(page, 'heldTimerDelays')
      assert(delays.length === 1 && delays[0] === expectedDelay, `очакван watchdog ${expectedDelay}ms, получено ${JSON.stringify(delays)}`)
    })
  }

  if (label.startsWith('mobile')) {
    await check(`[${label}][13] rapid consecutive finger taps on different cards -> exactly one action, the first tapped card`, async () => {
      await h(page, 'reset')
      const roomId = await h<string>(page, 'enterPlaying')
      const rects = await h<Array<{ cardId: string; left: number; top: number }>>(page, 'handCardRects')
      const cdp = await page.context().newCDPSession(page)
      const tap = async (x: number, y: number): Promise<void> => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 14, radiusY: 14, force: 1, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      }
      // Точка в средата на видимата ивица на всяка карта.
      const points = rects.map((rect, index) => {
        const next = rects[index + 1]
        const right = next ? next.left : rect.left + 60
        return { cardId: rect.cardId, x: (rect.left + right) / 2, y: rect.top + 70 }
      })
      for (let round = 0; round < 3; round++) {
        const before = (await commands()).length
        const order = round % 2 === 0 ? points : [...points].reverse()
        const expectedHit = await h<{ cardId: string | null }>(page, 'hitTestAt', order[0]!.x, order[0]!.y)
        for (const point of order) await tap(point.x, point.y)
        await page.waitForTimeout(200)
        const sent = (await commands()).slice(before)
        assert(sent.length === 1, `рунд ${round}: очаквано точно 1 действие, получено ${JSON.stringify(sent)}`)
        assert(sent[0]!.cardId === expectedHit.cardId, `рунд ${round}: трябва да е първата докосната карта ${expectedHit.cardId}, получено ${sent[0]!.cardId}`)
        // Сървърът отхвърля -> resync отговор -> отключване за следващия рунд.
        await h(page, 'serverError', 'probe reset')
        await h(page, 'resumed', roomId)
        await h(page, 'snapshot', roomId, await h(page, 'playingGame'))
        await h(page, 'clearNotice')
        await page.waitForTimeout(250)
      }
      await cdp.detach()
    })
  }

  // [9] Реален вход по цялата ръка в пълната маса. Mobile: CDP touch с радиус
  // 0 и 14px (площ на пръст) — точно пътят, по който браузърът таргетира
  // synthesized click; desktop: реална мишка. Инвариант: изпраща се САМО
  // картата под центъра на докосването (или нищо) — никога съседна карта,
  // включително когато докоснатата карта е затъмнена/неиграема.
  for (const scenario of ['all cards playable', 'c7 not playable'] as const) {
    const radii = label.startsWith('mobile') ? [0, 14] : [null]
    for (const radius of radii) {
      const inputLabel = radius === null ? 'mouse' : `touch r=${radius}px`
      await check(`[${label}][9] ${scenario}, ${inputLabel}: never sends a card other than the one under the finger`, async () => {
        await h(page, 'reset')
        const roomId = await h<string>(page, 'enterPlaying')
        const game = await h<any>(page, 'playingGame')
        if (scenario === 'c7 not playable') {
          game.playing.validCardIds = game.playing.validCardIds.filter((id: string) => id !== 'c7')
          await h(page, 'snapshot', roomId, game)
        }
        const rects = await h<Array<{ left: number; right: number }>>(page, 'handCardRects')
        const cdp = radius === null ? null : await page.context().newCDPSession(page)
        const wrong: string[] = []
        let onCard = 0
        let dropped = 0
        const reached = new Set<string>()
        for (let x = rects[0]!.left + 2; x < rects[rects.length - 1]!.right; x += 10) {
          for (let y = 640; y < 800; y += 30) {
            await page.waitForTimeout(200)
            const hit = await h<{ cardId: string | null; enabled: boolean; owner: string }>(page, 'hitTestAt', x, y)
            if (hit.owner !== 'hand' || hit.cardId === null) continue
            onCard++
            const before = (await commands()).length
            if (cdp !== null) {
              const point = { x, y, radiusX: radius!, radiusY: radius!, force: 1, id: 1 }
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
              await page.waitForTimeout(40)
            } else {
              await page.mouse.click(x, y)
            }
            const sent = (await commands()).slice(before).map((command) => command.cardId)
            if (sent.length === 0) {
              if (hit.enabled) dropped++
            } else if (sent.length !== 1 || sent[0] !== hit.cardId || !hit.enabled) {
              wrong.push(`(${x.toFixed(0)},${y}) under=${hit.cardId}${hit.enabled ? '' : '(disabled)'} sent=${sent.join(',')}`)
            } else {
              reached.add(hit.cardId)
            }
            if (sent.length > 0) {
              // отхвърляне -> resync отговор -> отключване за следващия probe
              await h(page, 'serverError', 'probe reset')
              await h(page, 'resumed', roomId)
              await h(page, 'snapshot', roomId, game)
              await h(page, 'clearNotice')
            }
          }
        }
        await cdp?.detach()
        console.log(`        on-card points=${onCard} wrong-card=${wrong.length} dropped=${dropped} reached=${[...reached].sort().join(',')}`)
        assert(wrong.length === 0, `изпратена карта, различна от тази под пръста: ${wrong.slice(0, 5).join('; ')}`)
        const expectedReachable = scenario === 'c7 not playable' ? 4 : 5
        assert(reached.size === expectedReachable, `всяка играема карта трябва да е достижима, достижими: ${[...reached].join(',')}`)
        if (radius === null) assert(dropped === 0, `с мишка не бива да има изпуснати click-ове (${dropped})`)
      })
    }
  }

  await check(`[${label}][8] declaration prompt survives unrelated re-renders; "Продължи" submits the chosen card`, async () => {
    await h(page, 'reset')
    const roomId = await h<string>(page, 'enterPlaying', 'tierce')
    await h(page, 'clickCard', 'c7')
    assert(await h<boolean>(page, 'declarationPromptNode'), 'очакван declaration prompt (терца 7-8-9 спатия)')
    assert((await commands()).length === 0, 'докато prompt-ът е отворен нищо не се праща')
    assert(await h<boolean>(page, 'markDeclarationPrompt'), 'prompt node')
    await h(page, 'rerender')
    await h(page, 'snapshot', roomId, await h(page, 'playingGame', { hand: 'tierce' }))
    await h(page, 'rerender')
    assert(await h<boolean>(page, 'isDeclarationPromptSameNode'), 're-render не бива да пресъздава prompt overlay-я')
    assert(await h<boolean>(page, 'clickDeclarationContinue'), '"Продължи" бутон')
    const after = await commands()
    assert(after.length === 1 && after[0]!.cardId === 'c7', `"Продължи" трябва да изпрати c7, получено ${JSON.stringify(after)}`)
  })
}

console.log('\n═══ checkPlayingInputReliability ═══\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({
    root: process.cwd(),
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
  })
  await vite.listen()
  browser = await chromium.launch()
  const baseUrl = `http://127.0.0.1:${port}`

  const VIEWPORTS = [
    { width: 390, height: 844, label: 'mobile 390x844', mobile: true },
    { width: 1280, height: 800, label: 'desktop 1280x800', mobile: false },
  ]

  for (const vp of VIEWPORTS) {
    console.log(`\n--- ${vp.label} ---`)
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.mobile,
      isMobile: vp.mobile,
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto('/scripts/fixtures/playingInputReliabilityHarness.html')
    await page.waitForFunction(() => (window as any).__playingInputHarness?.ready === true, undefined, { timeout: 20_000 })

    await runSuite(page, vp.label)

    await check(`[${vp.label}] no page errors`, async () => {
      assert(errors.length === 0, errors.join(' | '))
    })
    await context.close()
  }
} catch (err) {
  fail('suite setup', err)
} finally {
  await browser?.close()
  await vite?.close()
}

console.log(`\ncheckPlayingInputReliability: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
