/**
 * checkLobbyOffersFit.ts — сумите в "Оферти" (лоби) се побират в карето си.
 *
 * Реалните renderMobileOffersSection / renderBottomSection в Chromium, суми
 * 50 000 … 10 000 000, без и с кампаниен бонус "+X <икона>", на 320/360/375/390
 * px и Desktop. Проверява: (1) редът със сумата/бонуса е изцяло вътре в
 * карето; (2) пълната сума е видима (без многоточие, без промяна на текста);
 * (3) кратките суми запазват 21px, дългите получават по-малък шрифт >= 12px;
 * (4) карето/изображението/бутонът не променят размера си от бонуса;
 * (5) хоризонталното прелистване на мобилните оферти е запазено.
 *
 * Usage: npx tsx scripts/checkLobbyOffersFit.ts [--shots=<dir>]
 */
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser } from 'playwright'
import { createServer as createNetServer } from 'node:net'

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
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') return reject(new Error('no free port'))
      srv.close(() => resolve(address.port))
    })
  })
}

const shotsDir = process.argv.find((a) => a.startsWith('--shots='))?.slice('--shots='.length) ?? null
const norm = (text: string) => text.replace(/\s/g, ' ').trim()

type Row = { amount: string; fontPx: number; fitsAtMax: boolean; inside: boolean; detail: string; cardW: number; cardH: number; imgW: number; buttonH: number; ellipsis: boolean }

console.log('\n═══ checkLobbyOffersFit ═══\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null
try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()

  const viewports = [
    { label: 'mobile 320', width: 320, height: 700, mode: 'mobile' as const },
    { label: 'mobile 360', width: 360, height: 760, mode: 'mobile' as const },
    { label: 'mobile 375', width: 375, height: 760, mode: 'mobile' as const },
    { label: 'mobile 390', width: 390, height: 844, mode: 'mobile' as const },
    { label: 'desktop 1280', width: 1280, height: 900, mode: 'desktop' as const },
    { label: 'desktop 1024', width: 1024, height: 800, mode: 'desktop' as const },
  ]
  const expected = new Set(['50 000', '400 000', '1 500 000', '3 200 000', '10 000 000'])

  for (const vp of viewports) {
    const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: vp.width, height: vp.height }, isMobile: vp.mode === 'mobile', hasTouch: vp.mode === 'mobile' })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/scripts/fixtures/lobbyOffersFitHarness.html')
    await page.waitForFunction(() => (window as any).__lobbyOffersFitHarness !== undefined, undefined, { timeout: 15_000 })

    const measure = (withBonus: boolean): Promise<Row[]> => page.evaluate(async ({ mode, withBonus }) => {
      ;(window as any).__lobbyOffersFitHarness.mount(mode, withBonus)
      await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r }))))
      return [...document.querySelectorAll<HTMLElement>('[data-lobby-offer-amount="1"]')].map((row) => {
        let card: HTMLElement | null = row.parentElement
        while (card && parseFloat(getComputedStyle(card).borderTopWidth) < 2) card = card.parentElement
        const c = card!.getBoundingClientRect()
        const parts = [row, ...row.querySelectorAll<HTMLElement>('*')]
        const outside = parts.filter((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && (r.left < c.left + 1 || r.right > c.right - 1 || r.top < c.top || r.bottom > c.bottom)
        })
        const img = card!.querySelector<HTMLImageElement>('img')!
        const button = card!.querySelector<HTMLElement>('button')!
        const amountSpan = row.querySelector<HTMLElement>('[data-lobby-offer-amount-value="1"]')!
        const coin = row.querySelector('img')!.getBoundingClientRect().width
        const gap = parseFloat(getComputedStyle(row).columnGap || '0')
        const fontPx = parseFloat(getComputedStyle(row).fontSize)
        // Би ли се побрала сумата (сама) на 21px в тая колона? (естествена ширина, скалирана до 21px)
        const naturalAt21 = amountSpan.getBoundingClientRect().width * (21 / fontPx) + coin + gap
        return {
          amount: (amountSpan.textContent ?? '').trim(),
          fontPx,
          // 5% резерв = съзнателната предпазна граница на оценката (0.64em/знак срещу ~0.61em измерени).
          fitsAtMax: naturalAt21 <= row.parentElement!.getBoundingClientRect().width * 0.95,
          inside: outside.length === 0,
          detail: outside.map((el) => `${el.tagName}[${Math.round(el.getBoundingClientRect().left)}-${Math.round(el.getBoundingClientRect().right)}] card[${Math.round(c.left)}-${Math.round(c.right)}]`).join(', '),
          cardW: Math.round(c.width), cardH: Math.round(c.height), imgW: Math.round(img.getBoundingClientRect().width), buttonH: Math.round(button.getBoundingClientRect().height),
          ellipsis: parts.some((el) => getComputedStyle(el).textOverflow === 'ellipsis'),
        }
      })
    }, { mode: vp.mode, withBonus })

    const plain = await measure(false)
    if (shotsDir) await page.screenshot({ path: `${shotsDir}/offers-${vp.width}-plain.png` })
    const bonus = await measure(true)
    if (shotsDir) await page.screenshot({ path: `${shotsDir}/offers-${vp.width}-bonus.png` })

    for (const [label, rows] of [['без бонус', plain], ['с бонус +X', bonus]] as const) {
      await check(`[${vp.label}] ${label}: всички суми са изцяло в карето, пълни, без многоточие`, () => {
        assert(rows.length > 0, 'no offer rows rendered')
        for (const r of rows) {
          assert(expected.has(norm(r.amount)), `amount text changed: "${r.amount}"`)
          assert(r.inside, `"${norm(r.amount)}" (${r.fontPx}px) leaks outside: ${r.detail}`)
          assert(!r.ellipsis, `"${norm(r.amount)}" uses ellipsis`)
          assert(r.fontPx >= 12 && r.fontPx <= 21, `"${norm(r.amount)}" font ${r.fontPx}px out of [12, 21]`)
        }
      })
    }

    await check(`[${vp.label}] суми, които се побират на 21px, го запазват; по-дългите не са по-едри от по-кратките`, () => {
      for (const r of plain) if (r.fitsAtMax) assert(r.fontPx === 21, `"${norm(r.amount)}" fits at 21px but got ${r.fontPx}px`)
      if (vp.width === 1280 || (vp.mode === 'mobile' && vp.width >= 360)) assert(plain.some((r) => r.fitsAtMax), 'expected at least one short amount to keep 21px')
      const byLen = [...plain].sort((a, b) => a.amount.length - b.amount.length)
      for (let i = 1; i < byLen.length; i++) assert(byLen[i]!.fontPx <= byLen[i - 1]!.fontPx + 0.01, `longer amount got a bigger font: ${JSON.stringify(byLen.map((r) => [norm(r.amount), r.fontPx]))}`)
      console.log(`        без бонус: ${plain.map((r) => `${norm(r.amount)}=${r.fontPx.toFixed(1)}px`).join(' · ')}`)
      console.log(`        с бонус:   ${bonus.map((r) => `${norm(r.amount)}=${r.fontPx.toFixed(1)}px`).join(' · ')}`)
    })

    await check(`[${vp.label}] карето, изображението и бутонът не променят размера си от бонуса`, () => {
      plain.forEach((p, i) => {
        const b = bonus[i]!
        assert(p.cardW === b.cardW && p.imgW === b.imgW && p.buttonH === b.buttonH, `card/img/button changed for ${norm(p.amount)}: ${JSON.stringify([p, b])}`)
      })
    })

    if (vp.mode === 'mobile') {
      await check(`[${vp.label}] хоризонталното прелистване на офертите е запазено, без overflow на страницата`, async () => {
        const r = await page.evaluate(() => {
          const scroller = document.querySelector<HTMLElement>('[data-lobby-offer-amount="1"]')!.closest('article')!.parentElement!
          return { scrolls: scroller.scrollWidth > scroller.clientWidth, overflowX: getComputedStyle(scroller).overflowX, pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }
        })
        assert(r.scrolls && r.overflowX === 'auto', `expected the offers row to scroll horizontally: ${JSON.stringify(r)}`)
        assert(!r.pageOverflow, 'page must not overflow horizontally')
      })
    }

    await check(`[${vp.label}] няма JS грешки`, () => assert(errors.length === 0, errors.join('; ')))
    await context.close()
  }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
