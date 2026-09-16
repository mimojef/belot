/**
 * checkLudoSharedCellStacking.ts
 *
 * Real browser (Playwright), real production rendering code
 * (renderLudoGameScreen/applyLudoBoardContent), real DOM — regression for a
 * visual bug: on a 4-piece shared safe/star cell, one or more pawns could
 * appear partially hidden behind a neighboring board square.
 *
 * ROOT CAUSE (proven, not assumed): each track/finish cell
 * (board/renderLudoBoard.ts) rendered its data-ludo-cell-pieces container
 * NESTED inside the data-ludo-cell div, which carries `position:relative`
 * plus a numeric `z-index:point.row` (intentional — "the lower row's piece
 * covers its upper neighbor when they visually overflow into each other").
 * Per the CSS stacking-context spec, position!=static + z-index!=auto
 * creates a NEW stacking context — so EVERY cell became its own isolated
 * stacking context, and a piece token's z-index (even the local-color
 * z-index:100) could only ever be compared against SIBLINGS inside the SAME
 * cell, never against a neighboring cell. When a 3-4-piece cluster's fixed
 * quadrant offsets (FOUR_SLOTS in pieces/renderLudoPieces.ts) pushed a token
 * visually past its own cell's edge, that overflow landed underneath the
 * OPAQUE BACKGROUND of whichever neighboring cell happened to have a higher
 * row-based z-index — the neighboring cell itself (not another piece) hid
 * it, regardless of the token's own z-index.
 *
 * FIX: the piece layer was extracted into its own overlay grid
 * (data-ludo-piece-layer), a sibling of the cell-background grid, using the
 * SAME grid-template so coordinates line up 1:1 — mirroring the identical,
 * already-proven fix pattern used for capture rings
 * (data-ludo-effects-overlay, see applyLudoBoardContent's doc comment).
 * Every data-ludo-cell-pieces container now lives in ONE shared stacking
 * context, so z-index comparisons are global; the row-based cross-cell
 * overlap effect is preserved (each container still carries
 * z-index:point.row), but nothing opaque can hide an overflowing piece
 * anymore since the overlay containers carry no background of their own.
 *
 * This test drives the REAL rendering pipeline through a fixture harness
 * (scripts/fixtures/ludoSharedCellStackingHarness.ts): renders 4 different-
 * colored pawns sharing ONE safe cell (track-8), across all 4 possible
 * viewer perspectives, and asserts — via document.elementFromPoint at each
 * token's own bounding-box center (with pointer-events forced to `auto` via
 * a test-only injected stylesheet, since pointer-events:none would
 * otherwise make elementFromPoint skip the very elements being tested) —
 * that the TOPMOST painted element at that point is the piece itself, never
 * a neighboring board cell. Covers desktop + mobile.
 *
 * SECOND edge case (added on review, see mountTwoAdjacentClusters): the new
 * data-ludo-cell-pieces containers in the piece-layer overlay are grid items
 * carrying their own numeric z-index:point.row — per the CSS stacking-context
 * spec, a grid/flex item with z-index!=auto ALSO establishes a new stacking
 * context. So a local pawn's z-index:100 is only topmost RELATIVE TO ITS OWN
 * CONTAINER's siblings — a NEIGHBORING cell's entire container (any of its
 * pieces) could in principle still beat it if that neighbor's row-based
 * z-index happens to be higher. This is tested explicitly at mobile 360x800
 * (the exact viewport from the original bug report) with TWO adjacent track
 * cells (track-8/track-9), each holding its own multi-piece cluster whose
 * silhouettes visually approach/overlap — including the local viewer's own
 * pawn on BOTH sides, for all 4 possible viewers.
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

type VisibilityResult = { ok: boolean; failures: Array<{ point: string; hit: { kind: string; hitTag: string; hitAttrs: string; detail: string } }> }
type Rect = { left: number; top: number; right: number; bottom: number }
type PaintOrder = { centerX: number; centerY: number; zIndex: number }

type H = {
  mountSharedCell: (localColor: string) => Promise<void>
  mountCompactCluster: (count: 3 | 4, localColor: string) => Promise<void>
  mountTwoAdjacentClusters: (localColor: string) => Promise<void>
  isTokenFullyVisible: (pieceId: string) => Promise<VisibilityResult>
  getPieceRect: (pieceId: string) => Promise<Rect | null>
  getPiecePaintOrder: (pieceId: string) => Promise<PaintOrder | null>
  getCellRect: (cellId: string) => Promise<Rect | null>
  hasHorizontalOverflow: () => Promise<boolean>
}

async function harness(page: Page): Promise<H> {
  const w = '__ludoSharedCellStackingHarness'
  return {
    mountSharedCell: (localColor) => page.evaluate(([k, c]: any) => (window as any)[k].mountSharedCell(c), [w, localColor] as any),
    mountCompactCluster: (count, localColor) =>
      page.evaluate(([k, n, c]: any) => (window as any)[k].mountCompactCluster(n, c), [w, count, localColor] as any),
    mountTwoAdjacentClusters: (localColor) =>
      page.evaluate(([k, c]: any) => (window as any)[k].mountTwoAdjacentClusters(c), [w, localColor] as any),
    isTokenFullyVisible: (pieceId) =>
      page.evaluate(([k, p]: any) => (window as any)[k].isTokenFullyVisible(p), [w, pieceId] as any),
    getPieceRect: (pieceId) => page.evaluate(([k, p]: any) => (window as any)[k].getPieceRect(p), [w, pieceId] as any),
    getPiecePaintOrder: (pieceId) => page.evaluate(([k, p]: any) => (window as any)[k].getPiecePaintOrder(p), [w, pieceId] as any),
    getCellRect: (cellId) => page.evaluate(([k, c]: any) => (window as any)[k].getCellRect(c), [w, cellId] as any),
    hasHorizontalOverflow: () => page.evaluate((k: any) => (window as any)[k].hasHorizontalOverflow(), w),
  }
}

console.log('\n═══ checkLudoSharedCellStacking ═══\n')

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
  const baseUrl = `http://127.0.0.1:${port}`
  browser = await chromium.launch()

  const PIECE_IDS = ['red-0', 'blue-0', 'yellow-0', 'green-0']
  const VIEWERS = ['red', 'blue', 'yellow', 'green']

  async function runAtViewport(width: number, height: number, label: string): Promise<void> {
    const context = await browser!.newContext({ baseURL: baseUrl, viewport: { width, height } })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await page.goto('/scripts/fixtures/ludoSharedCellStackingHarness.html')
    const h = await harness(page)

    for (const viewer of VIEWERS) {
      await check(`[${label}] viewer=${viewer} — no pawn on the shared safe cell is hidden behind a neighboring square`, async () => {
        await h.mountSharedCell(viewer)

        for (const pieceId of PIECE_IDS) {
          const result = await h.isTokenFullyVisible(pieceId)
          assert(
            result.ok,
            `${pieceId} (viewer=${viewer}) is occluded by a neighboring cell at ${result.failures.length} sample point(s): ` +
              result.failures.map((f) => `[${f.point}] ${f.hit.detail} (<${f.hit.hitTag} ${f.hit.hitAttrs}>)`).join('; '),
          )
        }

        // Bonus structural check: every token's bounding box stays close to
        // its own cell's box (small overflow allowed by design — teardrop
        // silhouette overhang — but not wildly displaced into an unrelated
        // cell), confirming the compact cluster layout itself is intact.
        const cellRect = await h.getCellRect('track-8')
        assert(cellRect !== null, 'expected the shared cell (track-8) to be present in the DOM')
        for (const pieceId of PIECE_IDS) {
          const pieceRect = await h.getPieceRect(pieceId)
          assert(pieceRect !== null, `expected a rendered token for ${pieceId}`)
          const cellWidth = cellRect!.right - cellRect!.left
          const overflowMargin = cellWidth * 0.6 // generous — only guards against gross mispositioning
          assert(
            pieceRect!.left > cellRect!.left - overflowMargin &&
              pieceRect!.right < cellRect!.right + overflowMargin &&
              pieceRect!.top > cellRect!.top - overflowMargin &&
              pieceRect!.bottom < cellRect!.bottom + overflowMargin,
            `${pieceId} bounding box is implausibly far from its cell (cluster layout regression), cell=${JSON.stringify(cellRect)} piece=${JSON.stringify(pieceRect)}`,
          )
        }
      })

      for (const count of [3, 4] as const) {
        const scenario = count === 3 ? '2-piece vertical overlap inside 3-piece compact cluster' : '4-piece 2x2 compact cluster'
        await check(`[${label}] viewer=${viewer} — ${scenario} paints lower tokens above upper tokens`, async () => {
          await h.mountCompactCluster(count, viewer)
          const ids = PIECE_IDS.slice(0, count)
          const paintOrders = await Promise.all(ids.map(async (id) => ({ id, order: await h.getPiecePaintOrder(id) })))
          for (const item of paintOrders) assert(item.order !== null, `${item.id} paint order is missing`)

          let verticalPairs = 0
          for (const upper of paintOrders) {
            for (const lower of paintOrders) {
              if (lower.order!.centerY <= upper.order!.centerY + 1) continue
              if (Math.abs(lower.order!.centerX - upper.order!.centerX) > 2) continue
              verticalPairs++
              assert(
                lower.order!.zIndex > upper.order!.zIndex,
                `${lower.id} is lower (y=${lower.order!.centerY}) but z=${lower.order!.zIndex} is not above ${upper.id} (y=${upper.order!.centerY}, z=${upper.order!.zIndex})`,
              )
            }
          }
          assert(verticalPairs > 0, `${count}-piece cluster did not expose a vertical overlap pair`)

          if (count === 4) {
            const local = paintOrders.find((item) => item.id.startsWith(`${viewer}-`))!
            const equalYPeer = paintOrders.find(
              (item) => item.id !== local.id && Math.abs(item.order!.centerY - local.order!.centerY) <= 1,
            )
            assert(equalYPeer !== undefined, `local ${local.id} has no equal-Y tiebreak peer`)
            assert(
              local.order!.zIndex > equalYPeer!.order!.zIndex,
              `local ${local.id} must win equal-Y tie over ${equalYPeer!.id}`,
            )
          }
        })
      }
    }

    await check(`[${label}] no console/page errors across the whole scenario`, () => {
      assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
    })

    await check(`[${label}] no horizontal overflow at ${width}x${height}`, async () => {
      assert(!(await h.hasHorizontalOverflow()), `horizontal overflow detected at ${width}x${height}`)
    })

    await context.close()
  }

  await runAtViewport(1280, 850, 'desktop')
  await runAtViewport(390, 844, 'mobile')

  // --- SECOND edge case: two ADJACENT cells, each with its own multi-piece
  // cluster, silhouettes visually approaching/overlapping — targeted at
  // mobile 360x800 (the exact viewport from the original bug report),
  // across all 4 possible viewers, checking the LOCAL pawn specifically on
  // BOTH sides (track-8 and track-9 each hold one of the viewer's pawns).
  {
    const context = await browser!.newContext({ baseURL: baseUrl, viewport: { width: 360, height: 800 } })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await page.goto('/scripts/fixtures/ludoSharedCellStackingHarness.html')
    const h = await harness(page)

    for (const viewer of VIEWERS) {
      await check(
        `[mobile-360x800] viewer=${viewer} — two adjacent clusters (track-8/track-9): the LOCAL pawn is never hidden by a neighboring cell OR a neighboring cluster's container, on EITHER side`,
        async () => {
          await h.mountTwoAdjacentClusters(viewer)

          // Scope: the LOCAL player's own pawns specifically (one in each of
          // the two adjacent cells, viewer-0 on track-8 and viewer-1 on
          // track-9 — see mountTwoAdjacentClusters). This is the exact
          // z-index edge case under review: does the piece-layer container's
          // own numeric z-index (a stacking context per CSS spec) trap the
          // local pawn's z-index:100 so a neighboring cell's cluster can
          // still hide it? Foreign-vs-foreign occlusion between two NON-
          // local pieces from different cells is intentionally NOT asserted
          // here — that is the pre-existing, documented "lower row covers
          // its upper neighbor" depth effect (task requirement, unchanged),
          // not the local-visibility guarantee this test targets.
          for (const pieceId of [`${viewer}-0`, `${viewer}-1`]) {
            const result = await h.isTokenFullyVisible(pieceId)
            assert(
              result.ok,
              `${pieceId} (LOCAL, viewer=${viewer}, two-adjacent-clusters) is occluded at ${result.failures.length} sample point(s): ` +
                result.failures.map((f) => `[${f.point}] ${f.hit.detail} (<${f.hit.hitTag} ${f.hit.hitAttrs}>)`).join('; '),
            )
          }
        },
      )
    }

    await check('[mobile-360x800] no console/page errors across the two-adjacent-clusters scenario', () => {
      assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
    })

    await check('[mobile-360x800] no horizontal page overflow', async () => {
      assert(!(await h.hasHorizontalOverflow()), 'horizontal overflow detected at 360x800')
    })

    await context.close()
  }

  console.log('\n' + '═'.repeat(64))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exit(1)
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}
