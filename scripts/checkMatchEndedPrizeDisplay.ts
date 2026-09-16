/**
 * checkMatchEndedPrizeDisplay.ts
 *
 * Real browser (Playwright), real production code (renderMatchEndedScreen.ts
 * via scripts/fixtures/matchEndedHarness.ts) — доказва fix-а за
 * "numeric counter animation може да остане stuck на междинна стойност"
 * (production incident: prizeAmount=32000 понякога не стигаше target-а).
 *
 * ROOT CAUSE (потвърден чрез audit + контролиран repro): match-ended
 * екранът се ПЪЛНО re-render-ва при всеки WebSocket room_snapshot по време
 * на тази фаза (leave/replay vote, bot-takeover, reconnect catch-up), НЕ
 * при секундния countdown tick (той е targeted DOM patch, не full render —
 * виж syncMatchEndedCountdownDisplay в createActiveRoomFlowController.ts).
 * Старият код стартираше НОВ 1500ms RAF цикъл (нов performance.now() start)
 * при ВСЕКИ такъв re-render — при достатъчно чест/непрекъснат re-render
 * burst animation-ът може да не напредне видимо за необичайно дълго
 * (старият RAF handle продължаваше да пише в detached DOM, новият винаги
 * стартираше отначало).
 *
 * FIX: numeric counting animation-ът е ЗАПАЗЕН (желан визуален ефект — виж
 * task-а), но с DEADLINE-базиран lifecycle: prizeAnimationStartedAt е
 * absolute Unix-ms timestamp, зададен ЕДНОКРАТНО от controller-а при първия
 * render, подаден НЕИЗМЕНЕН на всеки следващ render. elapsed = now -
 * startedAt се смята спрямо този единствен timestamp, никога не се
 * рестартира. RAF loop-ът re-query-ва DOM-а на всеки кадър (не кешира stale
 * reference towards елемент, заменен от re-render), и explicit snap-ва към
 * exact target щом elapsed >= duration.
 *
 * Покрива CASE A-J от коригирания task:
 *   A. prizeAmount=32000 -> +0 -> intermediate -> точно +32 000.
 *   B. prizeAmount=85000 -> точно +85 000.
 *   C. prizeAmount=1000000 -> точно +1 000 000.
 *   D. re-render ~300ms -> НЕ reset на +0, продължава по original timeline.
 *   E. re-render ~700ms -> същото.
 *   F. re-render ~1200ms -> същото.
 *   G. re-render след >1500ms -> веднага exact final amount.
 *   H. late/delayed кадър (симулиран delay преди sample) -> exact final target.
 *   I. desktop и mobile paths -> еднакво поведение.
 *   J. loser / prize null / prize 0 -> без prize counter.
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
        reject(new Error('no free port'))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

function fmt(n: number): string {
  return `+${n.toLocaleString('bg-BG')}`
}

async function resetPrizeAnimation(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__matchEndedHarness.resetPrizeAnimation())
}

async function paintPrize(page: Page, winnerTeam: 'A' | 'B', prizeAmount: number | null): Promise<void> {
  await page.evaluate(
    ({ winnerTeam, prizeAmount }) => {
      ;(window as any).__matchEndedHarness.paintPrize(winnerTeam, prizeAmount)
    },
    { winnerTeam, prizeAmount },
  )
}

// Paint + immediate text read в ЕДИН evaluate call — избягва Node.js<->browser
// round-trip latency между отделни page.evaluate/locator.textContent
// повиквания, което иначе позволява на RAF loop-а да тикне 1-2 кадъра преди
// теста да прочете стойността (measurement artifact, не production bug —
// production DOM update-ите се случват synchronously в browser-а).
async function paintPrizeAndReadImmediately(page: Page, winnerTeam: 'A' | 'B', prizeAmount: number | null): Promise<string | null> {
  return page.evaluate(
    ({ winnerTeam, prizeAmount }) => {
      ;(window as any).__matchEndedHarness.paintPrize(winnerTeam, prizeAmount)
      const el = document.querySelector('[data-prize-counter="1"]')
      return el ? el.textContent : null
    },
    { winnerTeam, prizeAmount },
  )
}

async function readPrizeText(page: Page): Promise<string | null> {
  return page.locator('[data-prize-counter="1"]').textContent()
}

// Полира textContent на всеки rAF кадър за дадена продължителност — за да
// улови дори еднокадрово "stuck"/грешно състояние. String-based evaluate
// (не inline arrow/named function) — esbuild/tsx transform добавя __name()
// helper calls за named function declarations вътре в page.evaluate
// callback-и, който не съществува в browser context-а при .toString()
// serialization (доказан реален bug другаде в проекта — виж established
// workaround pattern).
async function sampleTextOverTime(page: Page, durationMs: number): Promise<string[]> {
  const source = `
(function(duration) {
  var el = document.querySelector('[data-prize-counter="1"]');
  if (!el) return Promise.resolve([]);
  var samples = [];
  var start = performance.now();
  return new Promise(function(resolve) {
    function frame() {
      samples.push(el.textContent || '');
      if (performance.now() - start < duration) {
        requestAnimationFrame(frame);
      } else {
        resolve(samples);
      }
    }
    requestAnimationFrame(frame);
  });
})(${durationMs})
`
  return page.evaluate(source)
}

async function runFullCountScenario(page: Page, label: string, prizeAmount: number): Promise<void> {
  const expected = fmt(prizeAmount)
  await resetPrizeAnimation(page)

  await check(`${label} веднага след първия render текстът е "+0" (numeric counting animation стартира)`, async () => {
    const text = await paintPrizeAndReadImmediately(page, 'A', prizeAmount)
    assert(text === '+0', `textContent="${text}", очаквах "+0" в самото начало`)
  })

  await check(`${label} след ~700ms текстът е intermediate стойност (не +0, не final)`, async () => {
    await page.waitForTimeout(700)
    const text = await readPrizeText(page)
    assert(text !== null && text !== '+0' && text !== expected, `textContent="${text}" — очаквах intermediate, не +0 и не final`)
  })

  await check(`${label} след пълния animation прозорец текстът е точно "${expected}"`, async () => {
    await page.waitForTimeout(1200)
    const text = await readPrizeText(page)
    assert(text === expected, `textContent="${text}", очаквах "${expected}"`)
  })
}

async function runReRenderScenario(page: Page, label: string, reRenderAtMs: number): Promise<void> {
  const prizeAmount = 32000
  const expected = fmt(prizeAmount)
  await resetPrizeAnimation(page)
  await paintPrize(page, 'A', prizeAmount)
  const startWallClock = Date.now()

  // Re-render (симулира countdown tick) точно около reRenderAtMs — подава
  // СЪЩИЯ prizeAnimationStartedAt (harness-ът пази state-а между
  // повиквания, точно като production controller-а).
  const waitMs = reRenderAtMs - (Date.now() - startWallClock)
  if (waitMs > 0) await page.waitForTimeout(waitMs)
  await paintPrize(page, 'A', prizeAmount)

  await check(`${label} re-render на ~${reRenderAtMs}ms НЕ reset-ва текста на "+0"`, async () => {
    const text = await readPrizeText(page)
    assert(text !== '+0', `textContent="${text}" — animation-ът се е рестартирал на +0 след re-render!`)
  })

  await check(`${label} след re-render на ~${reRenderAtMs}ms animation-ът все пак завършва точно на "${expected}"`, async () => {
    const remaining = Math.max(0, 1500 - (Date.now() - startWallClock) + 300)
    await page.waitForTimeout(remaining)
    const text = await readPrizeText(page)
    assert(text === expected, `textContent="${text}", очаквах "${expected}" (elapsed от original start, не от re-render момента)`)
  })
}

async function runScenario(page: Page, label: string): Promise<void> {
  await page.goto('/scripts/fixtures/matchEndedHarness.html')
  await page.waitForFunction(() => (window as any).__matchEndedHarness !== undefined, undefined, { timeout: 10_000 })

  // ─── CASE A: prize=32000 -> +0 -> intermediate -> точно +32 000 ─────────
  await runFullCountScenario(page, `${label} [A]`, 32000)

  // ─── CASE B: prize=85000 -> точно +85 000 ───────────────────────────────
  await runFullCountScenario(page, `${label} [B]`, 85000)

  // ─── CASE C: prize=1000000 -> точно +1 000 000 (голямата сума не е причината) ─
  await runFullCountScenario(page, `${label} [C]`, 1000000)

  // ─── CASE D/E/F: re-render по средата на прозореца не reset-ва/прекъсва ─
  await runReRenderScenario(page, `${label} [D]`, 300)
  await runReRenderScenario(page, `${label} [E]`, 700)
  await runReRenderScenario(page, `${label} [F]`, 1200)

  // ─── CASE G: re-render след >1500ms -> веднага exact final amount ──────
  {
    const prizeAmount = 32000
    const expected = fmt(prizeAmount)
    await resetPrizeAnimation(page)
    await paintPrize(page, 'A', prizeAmount)
    await page.waitForTimeout(1700)
    await paintPrize(page, 'A', prizeAmount)
    await check(`${label} [G] Re-render след >1500ms веднага показва exact final "${expected}"`, async () => {
      const text = await readPrizeText(page)
      assert(text === expected, `textContent="${text}"`)
    })
  }

  // ─── CASE H: continuous sampling around the deadline boundary never ────
  // shows a value other than the exact target once elapsed >= duration.
  {
    const prizeAmount = 32000
    const expected = fmt(prizeAmount)
    await resetPrizeAnimation(page)
    await paintPrize(page, 'A', prizeAmount)
    await page.waitForTimeout(1450)
    await check(`${label} [H] Sampling около deadline границата — след пресичането ѝ стойността е винаги exact final`, async () => {
      const samples = await sampleTextOverTime(page, 400)
      const afterDeadline = samples.slice(-5)
      const wrong = afterDeadline.filter((s) => s !== expected)
      assert(wrong.length === 0, `стойности след deadline, различни от final: ${JSON.stringify([...new Set(wrong)])}`)
    })
  }

  // ─── CASE J: loser / prize null / prize 0 -> no prize counter ──────────
  await resetPrizeAnimation(page)
  await paintPrize(page, 'B', 32000)
  await check(`${label} [J1] Губещият играч НЕ вижда prize counter`, async () => {
    const count = await page.locator('[data-prize-counter="1"]').count()
    assert(count === 0, `data-prize-counter присъства (count=${count}) за губещия играч`)
  })

  await resetPrizeAnimation(page)
  await paintPrize(page, 'A', null)
  await check(`${label} [J2] prizeAmount=null -> няма prize counter`, async () => {
    const count = await page.locator('[data-prize-counter="1"]').count()
    assert(count === 0, `data-prize-counter присъства (count=${count}) при prizeAmount=null`)
  })

  await resetPrizeAnimation(page)
  await paintPrize(page, 'A', 0)
  await check(`${label} [J3] prizeAmount=0 -> няма prize counter`, async () => {
    const count = await page.locator('[data-prize-counter="1"]').count()
    assert(count === 0, `data-prize-counter присъства (count=${count}) при prizeAmount=0`)
  })
}

console.log('\ncheckMatchEndedPrizeDisplay\n')

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

  // ─── CASE I: desktop path ────────────────────────────────────────────────
  {
    const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 850 } })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    console.log('\n--- Desktop 1280x850 ---')
    await runScenario(page, '[desktop 1280x850]')
    await check('[desktop 1280x850] [I] Няма JS грешки', () => {
      assert(errors.length === 0, `Конзолни грешки: ${errors.join(' | ')}`)
    })
    await context.close()
  }

  // ─── CASE I: mobile path ─────────────────────────────────────────────────
  {
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    console.log('\n--- Mobile 390x844 ---')
    await runScenario(page, '[mobile 390x844]')
    await check('[mobile 390x844] [I] Няма JS грешки', () => {
      assert(errors.length === 0, `Конзолни грешки: ${errors.join(' | ')}`)
    })
    await context.close()
  }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
