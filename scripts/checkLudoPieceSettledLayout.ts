/**
 * checkLudoPieceSettledLayout.ts
 *
 * Regression тест за production visual bug-а от dd7492b ("fix: remove mobile
 * tap highlight from ludo pawns"): CSS коментар вътре в inline style="..." на
 * renderLudoPieceHtml съдържаше двойни кавички ("#app *"), които затваряха
 * style атрибута по-рано. Всичко след тях — включително ${extraStyle}
 * (position:absolute + left/top 50% + translate(...) scale(...) + z-index на
 * settled/cluster пионките) — се губеше при HTML parse-а. Movement overlay-ят
 * не ползва extraStyle (центрира собствения си wrapper), затова анимацията
 * беше вярна, а settled пионката "скачаше" и shared-cell cluster-ът се чупеше.
 *
 * Мери в реален Chromium (Vite + Playwright, fixture
 * scripts/fixtures/ludoPieceSettledLayoutHarness.*) при 2 размера на клетка.
 *
 * Покрива:
 *   [S1] single settled pawn: style атрибутът пази cluster layout-а
 *        (position:absolute + z-index) и пионката е центрирана в клетката
 *        (с established -4px lift)
 *   [S2] final movement-overlay позиция == settled позиция (център и размер)
 *   [S3] 2 пионки в една клетка: по-малки от single, една до друга (същото
 *        Y, различно X), симетрично около центъра
 *   [S4] RED + YELLOW върху RED start cell (track-0), local=red
 *   [S5] 3 пионки
 *   [S6] 4 пионки
 *   [S7] всички cluster пионки остават вътре в клетката (център + хоризонтални
 *        граници с tolerance за established overlap дизайна)
 *   [S8] cluster пионките са по-малки от single пионката
 *   [S9] renderLudoPieceHtml style атрибутът никога не съдържа двойна кавичка
 *        (структурна защита срещу точно този root cause)
 *
 * Изход: process.exitCode = 1 при FAIL. `--debug` печата измерванията.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DEBUG = process.argv.includes('--debug')

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
function near(actual: number, expected: number, tolerance: number, label: string): void {
  assert(Math.abs(actual - expected) <= tolerance, `${label}: ${actual.toFixed(2)} != ${expected.toFixed(2)} (±${tolerance})`)
}

function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') return reject(new Error('no free port'))
      srv.close(() => resolvePort(address.port))
    })
  })
}

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number; cx: number; cy: number }
type Measurement = {
  cell: Rect
  tokens: Array<{ pieceId: string; rect: Rect; styleAttribute: string; position: string }>
  overlayFinal: Rect | null
}
type PieceInput = { id: string; color: string; cell: string }

async function measure(page: Page, pieces: PieceInput[], localColor: string | null, cellSizePx: number, overlayPieceId: string | null): Promise<Measurement> {
  return page.evaluate(
    ([p, l, s, o]: any) => (window as any).__ludoPieceLayout.measureCluster(p, l, s, o),
    [pieces, localColor, cellSizePx, overlayPieceId] as any,
  )
}

function assertClusterLayout(m: Measurement, expectedCount: number, singleWidth: number, cellSizePx: number): void {
  assert(m.tokens.length === expectedCount, `expected ${expectedCount} tokens, got ${m.tokens.length}`)
  for (const token of m.tokens) {
    assert(token.position === 'absolute', `${token.pieceId}: computed position=${token.position} (cluster layout style lost)`)
    assert(/z-index:\s*\d+/.test(token.styleAttribute), `${token.pieceId}: style attribute lost z-index`)
    // [S8] по-малки от single пионката
    assert(token.rect.width < singleWidth - 0.5, `${token.pieceId}: width ${token.rect.width.toFixed(2)} не е по-малък от single ${singleWidth.toFixed(2)}`)
    // [S7] вътре в клетката: центърът задължително; хоризонталните граници
    // с tolerance 20% от клетката. TWO_SLOTS/FOUR_SLOTS ползват фиксирани
    // ±7px/±5px offset-и, затова при малка клетка (26px) established дизайнът
    // излиза с ~4.7px — измерено идентично и на good commit 02ac8fc. При
    // dd7492b layout-ът изобщо не се прилага (position != absolute, flow
    // stacking), което тук пада много преди tolerance-а.
    assert(token.rect.cx > m.cell.left && token.rect.cx < m.cell.right, `${token.pieceId}: center X извън клетката`)
    assert(token.rect.cy > m.cell.top && token.rect.cy < m.cell.bottom, `${token.pieceId}: center Y извън клетката`)
    const tolerance = cellSizePx * 0.2
    assert(token.rect.left >= m.cell.left - tolerance && token.rect.right <= m.cell.right + tolerance,
      `${token.pieceId}: хоризонтално излиза от клетката (${token.rect.left.toFixed(1)}..${token.rect.right.toFixed(1)} vs ${m.cell.left}..${m.cell.right})`)
  }
  // Различни позиции (не наслагани една върху друга в flow).
  const keys = new Set(m.tokens.map((token) => `${Math.round(token.rect.cx)}:${Math.round(token.rect.cy)}`))
  assert(keys.size === m.tokens.length, 'два token-а са на една и съща позиция')
}

console.log('\n═══ checkLudoPieceSettledLayout ═══\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 800, height: 600 } })
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await page.goto('/scripts/fixtures/ludoPieceSettledLayoutHarness.html')
  await page.waitForFunction(() => (window as any).__ludoPieceLayout !== undefined)

  for (const cellSizePx of [40, 26]) {
    const label = `cell ${cellSizePx}px`
    const single = await measure(page, [{ id: 'blue-2', color: 'blue', cell: 'track-17' }], 'red', cellSizePx, 'blue-2')
    const singleWidth = single.tokens[0]?.rect.width ?? 0
    if (DEBUG) console.log(label, 'single', JSON.stringify(single))

    await check(`[S1] ${label} — single settled pawn пази layout style и е центрирана в клетката`, () => {
      assert(single.tokens.length === 1, 'expected 1 token')
      const token = single.tokens[0]!
      assert(token.position === 'absolute', `computed position=${token.position} (extraStyle lost)`)
      assert(/z-index:\s*\d+/.test(token.styleAttribute), 'style attribute lost z-index')
      near(token.rect.cx, single.cell.cx, 1, 'center X')
      near(token.rect.cy, single.cell.cy - 4, 1.5, 'center Y (-4px lift)')
    })

    await check(`[S2] ${label} — final movement-overlay позиция == settled позиция`, () => {
      const token = single.tokens[0]!
      assert(single.overlayFinal !== null, 'overlay не е измерен')
      near(single.overlayFinal!.cx, token.rect.cx, 1, 'overlay vs settled center X')
      near(single.overlayFinal!.cy, token.rect.cy, 1.5, 'overlay vs settled center Y')
      near(single.overlayFinal!.width, token.rect.width, 1, 'overlay vs settled width')
    })

    const two = await measure(page, [
      { id: 'blue-0', color: 'blue', cell: 'track-17' },
      { id: 'green-1', color: 'green', cell: 'track-17' },
    ], 'red', cellSizePx, null)
    if (DEBUG) console.log(label, 'two', JSON.stringify(two))
    await check(`[S3] ${label} — 2 пионки: по-малки, една до друга, симетрично`, () => {
      assertClusterLayout(two, 2, singleWidth, cellSizePx)
      const [a, b] = two.tokens
      near(a!.rect.cy, b!.rect.cy, 1, 'същото Y')
      assert(Math.abs(a!.rect.cx - b!.rect.cx) >= 8, 'твърде близо по X — не стоят една до друга')
      near((a!.rect.cx + b!.rect.cx) / 2, two.cell.cx, 1, 'симетрия около центъра')
    })

    const redStart = await measure(page, [
      { id: 'red-0', color: 'red', cell: 'track-0' },
      { id: 'yellow-1', color: 'yellow', cell: 'track-0' },
    ], 'red', cellSizePx, null)
    if (DEBUG) console.log(label, 'redStart', JSON.stringify(redStart))
    await check(`[S4] ${label} — RED + YELLOW върху RED start cell (track-0)`, () => {
      assertClusterLayout(redStart, 2, singleWidth, cellSizePx)
      const ids = redStart.tokens.map((token) => token.pieceId).sort()
      assert(ids.join(',') === 'red-0,yellow-1', `tokens: ${ids.join(',')}`)
      near(redStart.tokens[0]!.rect.cy, redStart.tokens[1]!.rect.cy, 1, 'същото Y')
    })

    const three = await measure(page, [
      { id: 'blue-0', color: 'blue', cell: 'track-17' },
      { id: 'green-1', color: 'green', cell: 'track-17' },
      { id: 'yellow-2', color: 'yellow', cell: 'track-17' },
    ], 'red', cellSizePx, null)
    await check(`[S5] ${label} — 3 пионки в compact cluster`, () => assertClusterLayout(three, 3, singleWidth, cellSizePx))

    const four = await measure(page, [
      { id: 'red-3', color: 'red', cell: 'track-17' },
      { id: 'blue-0', color: 'blue', cell: 'track-17' },
      { id: 'green-1', color: 'green', cell: 'track-17' },
      { id: 'yellow-2', color: 'yellow', cell: 'track-17' },
    ], 'red', cellSizePx, null)
    await check(`[S6] ${label} — 4 пионки в 2x2 cluster`, () => assertClusterLayout(four, 4, singleWidth, cellSizePx))
  }

  await check('[S9] renderLudoPieceHtml style атрибутът не съдържа двойна кавичка', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/app/games/ludo/pieces/renderLudoPieces.ts'), 'utf8')
    const start = src.indexOf('export function renderLudoPieceHtml(')
    const styleStart = src.indexOf('style="', start)
    const styleEnd = src.indexOf('\n      "', styleStart)
    assert(start >= 0 && styleStart > start && styleEnd > styleStart, 'не намерих style блока')
    const styleBody = src.slice(styleStart + 'style="'.length, styleEnd)
    assert(!styleBody.includes('"'), 'style атрибутът съдържа " — ще затвори атрибута по-рано')
  })

  await check('no page errors', () => assert(pageErrors.length === 0, pageErrors.join(' | ')))
  await context.close()
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
console.log('═'.repeat(64) + '\n')
if (failed > 0) process.exitCode = 1
