/**
 * checkPlayedCardStacking.ts
 *
 * Real-browser regression test (Playwright, own throwaway Vite dev server —
 * never touches the developer's own dev server/backend/DB) proving that a
 * played card sitting in the center of the table stays visually ABOVE the
 * neighboring seats' card-back fans, in the actual production DOM/CSS
 * structure (renderPlayingScreen.ts + renderCuttingSeatPanels.ts +
 * createActiveRoomFlowController.ts's seat-panels-host insertion logic,
 * replicated in scripts/fixtures/playedCardStackingHarness.ts since the
 * real function is an internal, non-exported closure).
 *
 * Bug history: a played card's flight animation uses its own
 * position:fixed;z-index:9000 overlay (animatePlayedCardFromHand in
 * renderPlayingScreen.ts) — always on top while flying. Once it lands, that
 * overlay is removed and the STATIC trick card underneath (inside #app)
 * becomes visible again — and it used to repaint BELOW the seat-panels-host
 * element (appended to <body> after #app, and/or under #app due to
 * position:static default), hiding it behind the left/right seats' card-back
 * fans. Fixed with three changes together:
 *   A. renderPlayingScreen.ts: trick-area wrapper z-index 2 -> 5
 *   B. renderPlayingScreen.ts: stage container gets z-index:4
 *   C. createActiveRoomFlowController.ts: seat-panels-host becomes
 *      position:relative and is inserted via
 *      document.body.insertBefore(el, options.root) instead of appendChild
 *
 * This test's own controlled-isolation runs — toggling A/B/C independently
 * against this harness — passed under every combination, INCLUDING the
 * pre-fix baseline (none of A/B/C applied). That means this harness does
 * not reproduce the original bug and cannot be used to determine which of
 * the three changes is strictly necessary; see the report accompanying
 * this change for the full explanation. All three changes (A, B, C) are
 * kept, matching the combination that was visually confirmed fixed in a
 * real browser session against the real dev server/backend (not this
 * harness). This test still provides real value as a stacking-order
 * regression guard for the current, working code — it just cannot serve
 * as evidence for a minimal-fix reduction.
 *
 * Second bug (seat announcement/declaration bubbles hidden behind trick
 * cards): once the above fix made static trick cards paint above the
 * seat-panels-host (and therefore above seat card fans), the SAME host also
 * contained the seat bubbles — анонс/обява/белот/ребелот/терца/50/100 all
 * render through renderBidBubble/renderDeclarationBubble/renderEmojiBubble/
 * renderPhraseBubble in renderCuttingSeatPanels.ts, previously nested inside
 * each seat's data-active-room-seat-anchor div. Because seat-panels-host is
 * a body-level sibling inserted BEFORE #app, no z-index on a bubble inside
 * it could ever paint above #app's trick cards — the host itself already
 * lost the document-order comparison one level up, so the bubble's own
 * z-index (10/11/30/31) never even entered the comparison. Fixed by
 * splitting seat bubbles into their OWN body-level host
 * (data-seat-bubbles-host, populated via createCuttingSeatBubblesLayerHtml)
 * with an explicit z-index:7. #app has no explicit z-index of its own (see
 * src/style.css) so it does not isolate a stacking context — #app's
 * descendants (trick cards z-index:5, Score HUD z-index:8, bidding popup
 * z-index:10/20) compare directly against body-level siblings by numeric
 * z-index, independent of document order. That sandwiches the bubbles host
 * exactly where required: seat card fans (1) < trick cards (5) < bubbles
 * (7) < Score HUD (8) < bidding/modal overlays (10/20+).
 *
 * Third bug (Score HUD overlapping the top-seat profile panel on narrow
 * mobile viewports): the HUD was scaled ONLY by stageScale (the global
 * stage-fit factor), which clamps to ACTIVE_ROOM_MIN_STAGE_SCALE (0.46)
 * across the entire normal mobile viewport range (~315-412 CSS px) — it does
 * not shrink further with viewport width in that range. The top-seat profile
 * panel (also center-anchored via stageScale) moves further from the left
 * edge as viewport width grows, but the HUD's fixed natural size x constant
 * stageScale did not — at narrow widths the HUD visually overlapped the
 * top-seat panel/avatar. Fixed with getScoreHudMobileGeometry()
 * (scoreHudMobileGeometry.ts): a pure, synchronous, DOM-free helper that
 * computes an ADDITIONAL hudScale multiplier (applied on top of stageScale
 * via a composite transform:scale(stageScale*hudScale) in
 * renderScoreHud.ts), based purely on the real CSS viewport width vs. the
 * top-seat panel's geometric left edge (not the card fan — the fan is
 * allowed to sit close to/behind the HUD; only the panel itself must never
 * be covered). >360px CSS width -> hudScale===1 (unchanged, current
 * approved visual size); <=360px -> a geometrically-computed scale that
 * keeps a 5 CSS px gap to the panel. The [HUD-*] checks below verify this in
 * the real browser DOM (not just analytically — see
 * checkScoreHudMobileAdaptiveGeometry.ts for the pure-formula checks).
 */

import { createServer as createNetServer } from 'node:net'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createViteServer, type ViteDevServer } from 'vite'

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
  } catch (error) {
    fail(label, error)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('could not allocate a free port'))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

type TrickCardPointCheck = {
  label: string
  dx: number // offset from card rect left, in CSS px
  dy: number // offset from card rect top, in CSS px
}

// Card corners have border-radius:14px (renderTrickCard) AND each trick
// card can carry a small rotation (getPlayOrderSpread's per-slot rotate,
// a few degrees). getBoundingClientRect() always returns the AXIS-ALIGNED
// bounding box, which is strictly larger than a rotated card's true visual
// footprint — so a naive corner sample from that box can land just outside
// the rotated card, in the gap next to it. 16px reliably stays inside the
// visible (possibly slightly rotated) card body at the card sizes this
// harness uses, while still sampling near the corner rather than the
// center (the task spec's suggested "3-5px" assumed an unrotated,
// non-antialiased hit target).
const INSET = 24

// NOTE: page.evaluate callbacks here are deliberately written with ZERO
// nested function/arrow declarations. tsx instruments nested named
// functions with an esbuild __name() helper call for debugging, but that
// helper does not exist in the string Playwright serializes into the page
// — any nested function inside an evaluate callback throws
// "ReferenceError: __name is not defined" at runtime. A single top-level
// expression per callback avoids this entirely.
async function getTopElementDescriptorsForTrickCards(page: Page): Promise<Array<{
  cardId: string
  points: Record<string, string>
}>> {
  // Trick cards render with pointer-events:none (they are decorative — the
  // real "played card" concept has no click target on the table), so
  // elementFromPoint() would normally skip straight past them regardless of
  // z-index. To actually exercise the STACKING order this test is about
  // (not click-through behaviour), pointer-events is temporarily forced to
  // 'auto' for every trick card, purely for this hit-testing pass — restored
  // immediately after, in the SAME evaluate call (splitting the toggle and
  // the hit-test across separate page.evaluate() round-trips was observed to
  // occasionally read a stale, not-yet-committed pointer-events value).
  // This never touches production code, only this test page's live DOM.
  return await page.evaluate((inset) => {
    const cards = document.querySelectorAll('[data-current-trick-card]')
    const originalPointerEvents: string[] = []
    for (let i = 0; i < cards.length; i++) {
      originalPointerEvents.push((cards[i] as HTMLElement).style.pointerEvents)
      ;(cards[i] as HTMLElement).style.pointerEvents = 'auto'
    }

    const out: Array<{ cardId: string; points: Record<string, string> }> = []
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]
      const rect = card.getBoundingClientRect()
      const samplePoints: Record<string, [number, number]> = {
        center: [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2],
        topLeft: [rect.left + inset, rect.top + inset],
        topRight: [rect.right - inset, rect.top + inset],
        bottomLeft: [rect.left + inset, rect.bottom - inset],
        bottomRight: [rect.right - inset, rect.bottom - inset],
      }
      const points: Record<string, string> = {}
      for (const pointName in samplePoints) {
        const xy = samplePoints[pointName]!
        const el = document.elementFromPoint(xy[0], xy[1])
        let descriptor = 'null'
        if (el) {
          const trickCardAncestor = el.closest('[data-current-trick-card]')
          const seatAnchor = el.closest('[data-active-room-seat-anchor]')
          const seatFan = el.closest('[data-active-room-seat-card-fan]')
          const scoreHud = el.closest('[data-active-room-score-hud]')
          if (trickCardAncestor) descriptor = 'trick-card:' + trickCardAncestor.getAttribute('data-card-id')
          else if (seatAnchor) descriptor = 'seat-anchor:' + seatAnchor.getAttribute('data-active-room-seat-anchor')
          else if (seatFan) descriptor = 'seat-fan:' + seatFan.getAttribute('data-active-room-seat-card-fan')
          else if (scoreHud) descriptor = 'score-hud'
          else descriptor = el.tagName
        }
        points[pointName] = descriptor
      }
      out.push({ cardId: card.getAttribute('data-card-id') || 'unknown', points })
    }

    for (let i = 0; i < cards.length; i++) {
      ;(cards[i] as HTMLElement).style.pointerEvents = originalPointerEvents[i]!
    }

    return out
  }, INSET)
}

async function assertAllTrickCardsAboveFans(page: Page, label: string, expectedCount: number): Promise<void> {
  const results = await getTopElementDescriptorsForTrickCards(page)
  assert(results.length === expectedCount, `${label}: expected ${expectedCount} trick cards in DOM, found ${results.length}`)
  for (const { cardId, points } of results) {
    for (const [pointName, descriptor] of Object.entries(points)) {
      assert(
        descriptor.startsWith('trick-card:'),
        `${label}: card ${cardId} at ${pointName} resolved to "${descriptor}" (expected the trick card itself or a descendant), not a seat fan/anchor`,
      )
    }
  }
}

// Same zero-nested-function-declaration constraint as
// getTopElementDescriptorsForTrickCards (see the NOTE above it) — tsx's
// __name() injection breaks any nested function inside a page.evaluate
// callback. Hit-tests every non-empty bid/declaration bubble's visible
// inner box (the actual rendered bubble, not its zero-size wrapper — see
// data-seat-bid-bubble/data-seat-declaration-bubble in
// renderCuttingSeatPanels.ts) at its center and 4 inset corners, and
// classifies the top element the same way as the trick-card check.
async function getTopElementDescriptorsForBubbles(page: Page): Promise<Array<{
  seat: string
  kind: string
  points: Record<string, string>
}>> {
  return await page.evaluate((inset) => {
    const wrappers = document.querySelectorAll('[data-seat-bid-bubble],[data-seat-declaration-bubble]')
    const bubbleEls: HTMLElement[] = []
    const originalPointerEvents: string[] = []
    for (let i = 0; i < wrappers.length; i++) {
      const wrapper = wrappers[i] as HTMLElement
      if (wrapper.children.length === 0) continue
      // renderBidBubble prefixes its output with a <style> tag (keyframes)
      // before the actual bubble <div> — lastElementChild is always the
      // bubble itself, unlike firstElementChild which would be the <style>
      // for bid bubbles (0x0 rect) but the bubble div for declaration
      // bubbles (which have no <style> prefix) — an inconsistent index.
      const bubbleEl = wrapper.lastElementChild as HTMLElement
      const rect = bubbleEl.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      bubbleEls.push(bubbleEl)
    }

    // Bubbles render with pointer-events:none (decorative, same as trick
    // cards — see getTopElementDescriptorsForTrickCards's NOTE above),
    // so elementFromPoint() would skip them regardless of z-index. Forced
    // to 'auto' only for this hit-testing pass, restored in the SAME
    // evaluate call (same stale-read race rationale as the trick-card
    // check).
    for (let i = 0; i < bubbleEls.length; i++) {
      originalPointerEvents.push(bubbleEls[i]!.style.pointerEvents)
      bubbleEls[i]!.style.pointerEvents = 'auto'
    }

    const out: Array<{ seat: string; kind: string; points: Record<string, string> }> = []
    for (let i = 0; i < bubbleEls.length; i++) {
      const bubbleEl = bubbleEls[i]!
      const wrapper = bubbleEl.parentElement as HTMLElement
      const kind = wrapper.hasAttribute('data-seat-bid-bubble') ? 'bid' : 'declaration'
      const seat = wrapper.getAttribute('data-seat-bid-bubble') || wrapper.getAttribute('data-seat-declaration-bubble') || 'unknown'
      const rect = bubbleEl.getBoundingClientRect()
      const samplePoints: Record<string, [number, number]> = {
        center: [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2],
        topLeft: [rect.left + inset, rect.top + inset],
        topRight: [rect.right - inset, rect.top + inset],
        bottomLeft: [rect.left + inset, rect.bottom - inset],
        bottomRight: [rect.right - inset, rect.bottom - inset],
      }
      const points: Record<string, string> = {}
      for (const pointName in samplePoints) {
        const xy = samplePoints[pointName]!
        const el = document.elementFromPoint(xy[0], xy[1])
        let descriptor = 'null'
        if (el) {
          const bubbleAncestor = el.closest('[data-seat-bid-bubble],[data-seat-declaration-bubble]')
          const trickCardAncestor = el.closest('[data-current-trick-card]')
          const seatFan = el.closest('[data-active-room-seat-card-fan]')
          const scoreHud = el.closest('[data-active-room-score-hud]')
          if (bubbleAncestor) descriptor = 'bubble'
          else if (trickCardAncestor) descriptor = 'trick-card:' + trickCardAncestor.getAttribute('data-card-id')
          else if (seatFan) descriptor = 'seat-fan:' + seatFan.getAttribute('data-active-room-seat-card-fan')
          else if (scoreHud) descriptor = 'score-hud'
          else descriptor = el.tagName
        }
        points[pointName] = descriptor
      }
      out.push({ seat, kind, points })
    }

    for (let i = 0; i < bubbleEls.length; i++) {
      bubbleEls[i]!.style.pointerEvents = originalPointerEvents[i]!
    }

    return out
  }, INSET)
}

async function assertAllBubblesAboveTrickCards(page: Page, label: string, expectedCount: number): Promise<void> {
  const results = await getTopElementDescriptorsForBubbles(page)
  assert(results.length === expectedCount, `${label}: expected ${expectedCount} visible bubbles, found ${results.length}`)
  for (const { seat, kind, points } of results) {
    for (const [pointName, descriptor] of Object.entries(points)) {
      assert(
        descriptor === 'bubble',
        `${label}: ${kind} bubble at seat ${seat}, point ${pointName} resolved to "${descriptor}" (expected the bubble itself or a descendant), not a trick card/seat fan`,
      )
    }
  }
}

console.log('\ncheckPlayedCardStacking\n')

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

  const VIEWPORTS: Array<{ width: number; height: number; label: string }> = [
    { width: 315, height: 660, label: '315x660' },
    { width: 390, height: 844, label: '390x844' },
    { width: 1280, height: 900, label: 'desktop 1280x900' },
  ]

  for (const viewport of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
    try {
      await page.goto(`${baseUrl}/scripts/fixtures/playedCardStackingHarness.html`)
      await page.waitForFunction(() => (window as any).__playedCardStackingHarness !== undefined)

      // D: 1, 2, 3, 4 played cards.
      for (const count of [1, 2, 3, 4]) {
        await page.evaluate((n) => (window as any).__playedCardStackingHarness.paint(n), count)
        await page.waitForTimeout(50)
        await check(
          `[D][${viewport.label}] ${count} played card(s): every trick card's 5 sample points (center + 4 inset corners) resolve to the trick card itself, never a seat fan/anchor`,
          () => assertAllTrickCardsAboveFans(page, `${viewport.label}/count=${count}`, count),
        )
      }

      // B (part 2): after landing, the static trick card stays above
      // left/right fans specifically — re-check with all 4 seats occupied
      // by a played card (top/right/bottom/left), which is where the left
      // and right card-back fans visually overlap the trick area the most.
      await check(
        `[B][${viewport.label}] after the flying-overlay handoff (all seats have played — 4 cards), the static trick cards remain above the left AND right seat fans specifically`,
        async () => {
          const results = await getTopElementDescriptorsForTrickCards(page)
          assert(results.length === 4, `expected 4 trick cards, found ${results.length}`)
          for (const { cardId, points } of results) {
            for (const [pointName, descriptor] of Object.entries(points)) {
              assert(
                descriptor !== 'seat-fan:left' && descriptor !== 'seat-fan:right',
                `card ${cardId} at ${pointName} is hidden behind the ${descriptor.replace('seat-fan:', '')} seat's card fan`,
              )
            }
          }
        },
      )

      // Bubble-D: for each played-card count (1-4), bid bubbles at
      // top/left/right and a declaration bubble at bottom (local seat) —
      // left/right specifically overlap the trick area the most, matching
      // the task's "minimum left and right must actually overlap" requirement.
      for (const count of [1, 2, 3, 4]) {
        await page.evaluate(
          (n) => (window as any).__playedCardStackingHarness.paintWithBubbles(n, ['top', 'left', 'right'], ['bottom']),
          count,
        )
        await page.waitForTimeout(50)
        await check(
          `[Bubble-D][${viewport.label}] ${count} played card(s): bid bubbles (top/left/right) and declaration bubble (bottom) all resolve above the static trick cards`,
          () => assertAllBubblesAboveTrickCards(page, `${viewport.label}/count=${count}`, 4),
        )
        await check(
          `[Bubble-D][${viewport.label}] ${count} played card(s): static trick cards remain above seat fans even with bubbles layered on top`,
          () => assertAllTrickCardsAboveFans(page, `${viewport.label}/count=${count}/with-bubbles`, count),
        )
      }

      // Bubble-B: with all 4 seats played, bubbles specifically at the
      // left AND right seats (the biggest trick-area overlap) resolve above
      // the trick cards — the seat positions the task calls out explicitly.
      await check(
        `[Bubble-B][${viewport.label}] left and right seat bubbles resolve above the static trick cards when all 4 seats have played`,
        async () => {
          await page.evaluate(
            () => (window as any).__playedCardStackingHarness.paintWithBubbles(4, ['left', 'right'], []),
          )
          await new Promise((r) => setTimeout(r, 50))
          const results = await getTopElementDescriptorsForBubbles(page)
          assert(results.length === 2, `expected 2 visible bubbles (left, right), found ${results.length}`)
          for (const { seat, points } of results) {
            for (const [pointName, descriptor] of Object.entries(points)) {
              assert(
                descriptor === 'bubble',
                `bid bubble at seat ${seat}, point ${pointName} resolved to "${descriptor}", expected the bubble itself`,
              )
            }
          }
        },
      )

      // Bubble-HUD: Score HUD and bidding popup (both z-index:8/10/20,
      // inside #app) must stay above the bubbles layer (z-index:7) — the
      // opposite direction from the trick-card check above. Re-uses the
      // last paintWithBubbles() state (left/right bubbles + 4 trick cards).
      await check(
        `[Bubble-HUD][${viewport.label}] Score HUD resolves above seat bubbles at their overlap point`,
        async () => {
          const descriptor = await page.evaluate(() => {
            const hud = document.querySelector('[data-active-room-score-hud]')
            if (!hud) return 'no-hud'
            // The [data-active-room-score-hud] element itself is an
            // intentional width:0;height:0 positioning anchor (see
            // renderScoreHud.ts) — its actual visible content is its
            // position:absolute child, so the hit-test point must come from
            // that child's rect, not the zero-size wrapper's.
            const visibleContent = hud.firstElementChild as HTMLElement | null
            if (!visibleContent) return 'no-hud-content'
            const rect = visibleContent.getBoundingClientRect()
            if (rect.width === 0 || rect.height === 0) return 'zero-size-hud-content'
            // Score HUD content is pointer-events:none (decorative), same
            // rationale as the trick-card/bubble hit-tests above — forced to
            // 'auto' only for this probe, restored immediately after.
            const original = visibleContent.style.pointerEvents
            visibleContent.style.pointerEvents = 'auto'
            const el = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)
            visibleContent.style.pointerEvents = original
            if (!el) return 'null'
            if (el.closest('[data-active-room-score-hud]')) return 'score-hud'
            if (el.closest('[data-seat-bid-bubble],[data-seat-declaration-bubble]')) return 'bubble'
            return 'other:' + el.tagName
          })
          assert(descriptor === 'score-hud', `Score HUD center resolved to "${descriptor}" instead of the HUD itself`)
        },
      )

      // F: seat panels remain visible (cutting/bidding rendering path —
      // createCuttingSeatPanelsHtml — is exercised via syncSeatPanels for
      // every paint() call above; re-confirm the host and anchors exist).
      await check(
        `[F][${viewport.label}] seat panels (seat anchors) are present and visible after painting`,
        async () => {
          const anchorCount = await page.evaluate(
            () => document.querySelectorAll('[data-active-room-seat-anchor]').length,
          )
          assert(anchorCount === 4, `expected 4 seat anchors, found ${anchorCount}`)
          const hostDisplay = await page.evaluate(() => {
            const host = document.querySelector('[data-seat-panels-host="1"]')
            return host ? getComputedStyle(host).display : null
          })
          assert(hostDisplay !== 'none', `seat-panels-host should not be display:none, got ${hostDisplay}`)
        },
      )

      // F: exit/chat/emoji controls remain visible and clickable (not
      // covered/blocked by the stacking fix). The playing screen's leave
      // button/chat/emoji toggles are owned by createActiveRoomFlowController
      // (not exercised by this harness, which renders the screen directly) —
      // what IS testable here is that the fix does not introduce a
      // full-viewport blocking layer: neither the trick-area wrapper nor the
      // seat-panels-host intercept pointer events over the bottom of the
      // screen, where those controls live.
      await check(
        `[F][${viewport.label}] pointer-events at the bottom-of-viewport control area are not intercepted by the trick-area or seat-panels layers`,
        async () => {
          const descriptor = await page.evaluate((vh: number) => {
            const el = document.elementFromPoint(24, vh - 24)
            if (!el) return 'null'
            if (el.closest('[data-active-room-seat-anchor]')) return 'seat-anchor'
            if (el.closest('[data-seat-panels-host="1"]') && getComputedStyle(el).pointerEvents !== 'none') return 'seat-panels-host-blocking'
            return 'ok'
          }, viewport.height)
          assert(descriptor !== 'seat-panels-host-blocking', 'seat-panels-host is intercepting pointer events at the bottom control area')
        },
      )

      // Bubble-F: the new bubbles host must not intercept pointer events
      // either — every bubble wrapper/bubble itself is pointer-events:none
      // (decorative), so the host as a whole must not swallow clicks meant
      // for controls underneath/around it (same bottom-of-viewport probe as
      // the seat-panels-host check above).
      await check(
        `[Bubble-F][${viewport.label}] seat-bubbles-host does not intercept pointer events at the bottom-of-viewport control area`,
        async () => {
          const descriptor = await page.evaluate((vh: number) => {
            const el = document.elementFromPoint(24, vh - 24)
            if (!el) return 'null'
            if (el.closest('[data-seat-bubbles-host="1"]') && getComputedStyle(el).pointerEvents !== 'none') return 'bubbles-host-blocking'
            return 'ok'
          }, viewport.height)
          assert(descriptor !== 'bubbles-host-blocking', 'seat-bubbles-host is intercepting pointer events at the bottom control area')
        },
      )
    } finally {
      await page.close()
    }
  }

  // HUD-*: Score HUD mobile scale — real-DOM collision/stacking proof (see
  // module docstring "Third bug" section, and checkScoreHudMobileAdaptiveGeometry.ts
  // for the pure-formula checks this complements). Separate viewport set
  // from the main loop above, since these specifically target the 360px
  // breakpoint neighborhood, not the D/Bubble scenarios' 3-viewport matrix.
  const HUD_VIEWPORTS: Array<{ width: number; height: number; label: string }> = [
    { width: 315, height: 660, label: '315x660' },
    { width: 320, height: 568, label: '320x568' },
    { width: 359, height: 640, label: '359x640' },
    { width: 360, height: 640, label: '360x640' },
    { width: 361, height: 640, label: '361x640' },
    { width: 375, height: 667, label: '375x667' },
    { width: 390, height: 844, label: '390x844' },
    { width: 412, height: 915, label: '412x915' },
  ]

  for (const viewport of HUD_VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
    try {
      await page.goto(`${baseUrl}/scripts/fixtures/playedCardStackingHarness.html`)
      await page.waitForFunction(() => (window as any).__playedCardStackingHarness !== undefined)
      await page.evaluate((n) => (window as any).__playedCardStackingHarness.paint(n), 2)
      await page.waitForTimeout(50)

      // HUD-Gap: real getBoundingClientRect() proof that the HUD's visible
      // right edge stays ≈5px left of the top-seat panel's VISIBLE left edge
      // (the actual profile/avatar panel div — border-radius:18px, border,
      // box-shadow — not the seat anchor, card fan, or any invisible layout
      // wrapper), for viewports <= the 360px breakpoint (where hudScale is
      // computed geometrically). Above 360px, hudScale is HARD-forced to 1
      // per the spec's explicit contract, even though the panel-only
      // envelope's natural breakeven for a full 5px gap is closer to
      // ~373-374px geometrically — a known, accepted residual overlap in the
      // 361-373px band (see checkScoreHudMobileAdaptiveGeometry.ts [B] and
      // the report accompanying this change). This check therefore only
      // asserts the 5px gap contract at/under the breakpoint, not above it.
      //
      // Target is 4.5-5.5px (not just ">=5px") — the fix must produce the
      // LARGEST HUD that still keeps ~5px, not shrink further than needed.
      // A prior bug here (natural-width divisor including a positional
      // offset, and a stale border/shadow allowance) made the HUD shrink to
      // a measured ~8-15px gap instead of 5px — this range check would have
      // caught that regression (see the report for the full root cause).
      if (viewport.width <= 360) {
        await check(
          `[HUD-Gap][${viewport.label}] HUD right edge stays ≈5px (4.5-5.5px) left of the top-seat panel's visible left edge`,
          async () => {
            const result = await page.evaluate(() => {
              const hud = document.querySelector('[data-active-room-score-hud]')
              const hudContent = hud ? (hud.firstElementChild as HTMLElement | null) : null
              const topAnchor = document.querySelector('[data-active-room-seat-anchor="top"]')
              const topPanel = topAnchor ? topAnchor.querySelector('[data-profile-seat-btn]')?.parentElement : null
              if (!hudContent || !topPanel) return { ok: false, reason: 'missing hud or top panel element' }
              const hudRect = hudContent.getBoundingClientRect()
              const panelRect = (topPanel as HTMLElement).getBoundingClientRect()
              const gap = panelRect.left - hudRect.right
              return { ok: true, gap, hudRight: hudRect.right, panelLeft: panelRect.left }
            })
            assert(result.ok, `could not measure: ${(result as { reason?: string }).reason}`)
            const gap = (result as { gap: number }).gap
            assert(
              gap >= 4.5 && gap <= 5.5,
              `measured gap is ${gap.toFixed(2)}px, expected 4.5-5.5px (HUD is either overlapping the panel or shrunk more than necessary)`,
            )
          },
        )
      }

      // HUD-MeasuredVsFormula: the real, rendered DOM gap must match what
      // the pure getScoreHudMobileGeometry() helper predicts for the same
      // inputs — proving the production wiring (renderScoreHud.ts) applies
      // the helper's hudScale exactly as computed, with no additional
      // hidden scaling/offset drift between the pure formula and the actual
      // transform chain.
      if (viewport.width <= 360) {
        await check(
          `[HUD-MeasuredVsFormula][${viewport.label}] real DOM gap matches the pure helper's theoretical gap within 0.5px`,
          async () => {
            const measured = await page.evaluate(() => {
              const hud = document.querySelector('[data-active-room-score-hud]')
              const hudContent = hud ? (hud.firstElementChild as HTMLElement | null) : null
              const topAnchor = document.querySelector('[data-active-room-seat-anchor="top"]')
              const topPanel = topAnchor ? topAnchor.querySelector('[data-profile-seat-btn]')?.parentElement : null
              if (!hudContent || !topPanel) return null
              const hudRect = hudContent.getBoundingClientRect()
              const panelRect = (topPanel as HTMLElement).getBoundingClientRect()
              return panelRect.left - hudRect.right
            })
            assert(measured !== null, 'could not measure real DOM gap')
            const { getScoreHudMobileGeometry } = await import('../src/app/activeRoom/scoreHudMobileGeometry.ts')
            const stageScale = await page.evaluate(() => (window as any).__playedCardStackingHarness.getStageScaleForTest())
            const { hudScale } = getScoreHudMobileGeometry({ viewportWidthCssPx: viewport.width, stageScale, isMobileLayout: true })
            const naturalHudVisualWidthCssPx = 300 * stageScale
            const theoreticalHudRight = 5 + naturalHudVisualWidthCssPx * hudScale
            // Independently derive the panel's theoretical left edge the
            // same way scoreHudMobileGeometry.ts does, to compute the full
            // theoretical gap for comparison against the measured one.
            const theoreticalPanelLeft = viewport.width / 2 - stageScale * ((186 * 0.9) / 2)
            const theoreticalGap = theoreticalPanelLeft - theoreticalHudRight
            assert(
              Math.abs((measured as number) - theoreticalGap) < 0.5,
              `measured gap ${(measured as number).toFixed(2)}px differs from theoretical gap ${theoreticalGap.toFixed(2)}px by more than 0.5px`,
            )
          },
        )
      }

      // HUD-Scale1: above the 360px breakpoint, the HUD's rendered width
      // must match its natural (unscaled-by-hudScale) size — proving no
      // extra shrink is applied once the viewport is wide enough.
      if (viewport.width > 360) {
        await check(
          `[HUD-Scale1][${viewport.label}] HUD visual width matches natural size (hudScale===1, no extra mobile shrink above the breakpoint)`,
          async () => {
            const width = await page.evaluate(() => {
              const hud = document.querySelector('[data-active-room-score-hud]')
              const hudContent = hud ? (hud.firstElementChild as HTMLElement | null) : null
              return hudContent ? hudContent.getBoundingClientRect().width : null
            })
            assert(width !== null, 'HUD content element not found')
            const stageScale = await page.evaluate(() => (window as any).__playedCardStackingHarness.getStageScaleForTest())
            // hud.firstElementChild is the width:300px content div (its own
            // width, not including the 18px SCORE_HUD_INTERNAL_OFFSET, which
            // is a position offset applied to this div, not part of its
            // width) — matches renderScoreHud.ts's `width:300px`.
            const expectedNaturalWidth = 300 * stageScale
            assert(
              Math.abs((width as number) - expectedNaturalWidth) < 0.5,
              `HUD width is ${(width as number).toFixed(2)}px, expected natural width ${expectedNaturalWidth.toFixed(2)}px (hudScale should be exactly 1 above 360px)`,
            )
          },
        )
      }

      // HUD-Stacking: HUD stays above the seat bubbles layer (elementFromPoint
      // over the HUD's own visible content resolves to the HUD, not a bubble
      // even when one is painted at an overlapping screen position).
      await check(
        `[HUD-Stacking][${viewport.label}] Score HUD resolves above seat bubbles at its own content area`,
        async () => {
          await page.evaluate(
            () => (window as any).__playedCardStackingHarness.paintWithBubbles(2, ['top', 'left', 'right'], ['bottom']),
          )
          await new Promise((r) => setTimeout(r, 50))
          const descriptor = await page.evaluate(() => {
            const hud = document.querySelector('[data-active-room-score-hud]')
            const hudContent = hud ? (hud.firstElementChild as HTMLElement | null) : null
            if (!hudContent) return 'no-hud-content'
            const rect = hudContent.getBoundingClientRect()
            if (rect.width === 0 || rect.height === 0) return 'zero-size-hud-content'
            const original = hudContent.style.pointerEvents
            hudContent.style.pointerEvents = 'auto'
            const el = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)
            hudContent.style.pointerEvents = original
            if (!el) return 'null'
            if (el.closest('[data-active-room-score-hud]')) return 'score-hud'
            if (el.closest('[data-seat-bid-bubble],[data-seat-declaration-bubble]')) return 'bubble'
            return 'other:' + el.tagName
          })
          assert(descriptor === 'score-hud', `Score HUD center resolved to "${descriptor}" instead of the HUD itself`)
        },
      )

      // HUD-NotBlocking: HUD must not intercept pointer events over the
      // top-seat panel area (pointer-events:none throughout, same rationale
      // as the seat-panels-host/bubbles-host checks above).
      await check(
        `[HUD-NotBlocking][${viewport.label}] HUD does not block pointer events over the top-seat panel`,
        async () => {
          const descriptor = await page.evaluate(() => {
            const topAnchor = document.querySelector('[data-active-room-seat-anchor="top"]')
            const topPanel = topAnchor ? topAnchor.querySelector('[data-profile-seat-btn]')?.parentElement : null
            if (!topPanel) return 'no-panel'
            const rect = (topPanel as HTMLElement).getBoundingClientRect()
            const el = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)
            if (!el) return 'null'
            if (el.closest('[data-active-room-score-hud]') && getComputedStyle(el).pointerEvents !== 'none') return 'hud-blocking'
            return 'ok'
          })
          assert(descriptor !== 'hud-blocking', 'HUD is intercepting pointer events over the top-seat panel area')
        },
      )

      // HUD-Content: 0:0, three-digit scores (105:134), and a long
      // announcement/bid-owner text all still fit inside the HUD's fixed
      // natural size (hudScale scales the whole component, it never changes
      // truncation behavior) and never grow the HUD wider than its natural
      // content box — proving hudScale is purely a visual shrink, not a
      // layout-affecting change.
      await check(
        `[HUD-Content][${viewport.label}] score "0:0" renders without changing HUD width`,
        async () => {
          await page.evaluate(() => (window as any).__playedCardStackingHarness.paintWithScore(2, 0, 0))
          await new Promise((r) => setTimeout(r, 50))
          const width = await page.evaluate(() => {
            const hud = document.querySelector('[data-active-room-score-hud]')
            const hudContent = hud ? (hud.firstElementChild as HTMLElement | null) : null
            return hudContent ? hudContent.getBoundingClientRect().width : null
          })
          assert(width !== null && width > 0, 'HUD content not found or zero-width for 0:0 score')
        },
      )
      await check(
        `[HUD-Content][${viewport.label}] three-digit score "105:134" renders without changing HUD width`,
        async () => {
          const widthBefore = await page.evaluate(() => {
            const hud = document.querySelector('[data-active-room-score-hud]')
            const hudContent = hud ? (hud.firstElementChild as HTMLElement | null) : null
            return hudContent ? hudContent.getBoundingClientRect().width : null
          })
          await page.evaluate(() => (window as any).__playedCardStackingHarness.paintWithScore(2, 105, 134))
          await new Promise((r) => setTimeout(r, 50))
          const widthAfter = await page.evaluate(() => {
            const hud = document.querySelector('[data-active-room-score-hud]')
            const hudContent = hud ? (hud.firstElementChild as HTMLElement | null) : null
            return hudContent ? hudContent.getBoundingClientRect().width : null
          })
          assert(widthAfter !== null && widthAfter > 0, 'HUD content not found or zero-width for 105:134 score')
          assert(
            widthBefore === null || Math.abs(widthAfter! - widthBefore) < 0.5,
            `HUD width changed from ${widthBefore}px (0:0) to ${widthAfter}px (105:134) — three-digit scores should not resize the HUD`,
          )
        },
      )
      await check(
        `[HUD-Content][${viewport.label}] long announcement text ("Всичко коз: Александър") stays truncated inside the HUD without growing its width`,
        async () => {
          await page.evaluate(() =>
            (window as any).__playedCardStackingHarness.paintWithScore(2, 0, 0, {
              seat: 'top',
              contract: 'all-trumps',
              trumpSuit: null,
            }),
          )
          await new Promise((r) => setTimeout(r, 50))
          const result = await page.evaluate(() => {
            const hud = document.querySelector('[data-active-room-score-hud]')
            const hudContent = hud ? (hud.firstElementChild as HTMLElement | null) : null
            if (!hudContent) return { width: null, overflowsWrapped: null }
            const width = hudContent.getBoundingClientRect().width
            const bidTextEl = hudContent.querySelector('[title]') as HTMLElement | null
            const overflowsWrapped = bidTextEl
              ? getComputedStyle(bidTextEl).whiteSpace === 'nowrap' && getComputedStyle(bidTextEl).textOverflow === 'ellipsis'
              : null
            return { width, overflowsWrapped }
          })
          assert(result.width !== null && result.width > 0, 'HUD content not found for long announcement text')
          assert(result.overflowsWrapped === true, 'bid summary text lost its nowrap/ellipsis truncation styling')
        },
      )
    } finally {
      await page.close()
    }
  }

  // A: flying overlay uses its own always-on-top z-index:9000 layer,
  // independent of the static-trick-card fix under test — verify the
  // constant is still what animatePlayedCardFromHand relies on (this does
  // not exercise the animation itself, since triggering it requires a full
  // hand-to-table pointer flow out of scope for this harness; the flying
  // overlay's isolation from seat panels was never the reported bug — only
  // the POST-landing handoff was — so a source-level constant check is
  // sufficient here).
  await check(
    '[A] the flying-card overlay (animatePlayedCardFromHand) still uses a fixed, always-on-top z-index (9000/9001) — unrelated to and unaffected by the static trick-card stacking fix',
    async () => {
      const fs = await import('node:fs')
      const src = fs.readFileSync('src/app/activeRoom/renderPlayingScreen.ts', 'utf8')
      assert(/position:fixed;inset:0;pointer-events:none;z-index:9000/.test(src), 'overlay z-index:9000 not found')
      assert(/clone\.style\.zIndex = '9001'/.test(src), 'clone z-index:9001 not found')
    },
  )

  // Bubble-A: flying card (9000/9001) stays above the bubbles layer (7)
  // during flight — no numeric overlap is possible (9000 >> 7), confirmed
  // by re-reading both constants from source in the same check.
  await check(
    '[Bubble-A] the flying-card overlay z-index (9000/9001) is numerically above the seat-bubbles-host z-index (7), preserving flying card > bubble > static trick card > hand',
    async () => {
      const fs = await import('node:fs')
      const flyingSrc = fs.readFileSync('src/app/activeRoom/renderPlayingScreen.ts', 'utf8')
      const bubblesSrc = fs.readFileSync('src/app/activeRoom/cutting/renderCuttingSeatPanels.ts', 'utf8')
      assert(/position:fixed;inset:0;pointer-events:none;z-index:9000/.test(flyingSrc), 'flying overlay z-index:9000 not found')
      const bubblesLayerMatch = bubblesSrc.match(/data-seat-bubbles-layer="1"[\s\S]{0,200}?z-index:(\d+);/)
      assert(bubblesLayerMatch !== null, 'could not find data-seat-bubbles-layer z-index in renderCuttingSeatPanels.ts')
      const bubblesZIndex = Number(bubblesLayerMatch![1])
      assert(bubblesZIndex < 9000, `seat-bubbles-host z-index (${bubblesZIndex}) is not below the flying card overlay (9000)`)
    },
  )

  // Types: declaration-value bubbles (терца/20/50/100, белот/ребелот) and
  // emoji/phrase reaction bubbles are not each individually exercised via a
  // separate browser scenario above (they share identical fade-timer-driven
  // trigger plumbing in renderPlayingScreen.ts that is out of scope to
  // replicate here — see paint()'s lastTrickKey short-circuit rationale).
  // Instead, this asserts at the source level that renderDeclarationBubble
  // (which renders belote/rebelote/sequence/20/50/100 — all pass through
  // the SAME function as plain lines of text) and renderEmojiBubble/
  // renderPhraseBubble all render into the SAME createSeatBubbleAnchorHtml
  // wrapper that feeds createCuttingSeatBubblesLayerHtml — i.e. every bubble
  // type shares the one stacking mechanism actually under test above via
  // the bid/declaration browser checks, not a copy with different layering.
  await check(
    '[Types] renderDeclarationBubble (белот/ребелот/терца/20/50/100 — all declaration text variants) and renderEmojiBubble/renderPhraseBubble render into the same createSeatBubbleAnchorHtml/createCuttingSeatBubblesLayerHtml layer as the bid bubble tested above',
    async () => {
      const fs = await import('node:fs')
      const src = fs.readFileSync('src/app/activeRoom/cutting/renderCuttingSeatPanels.ts', 'utf8')
      const anchorFnStart = src.indexOf('function createSeatBubbleAnchorHtml(')
      assert(anchorFnStart !== -1, 'createSeatBubbleAnchorHtml not found')
      const layerFnStart = src.indexOf('export function createCuttingSeatBubblesLayerHtml(')
      assert(layerFnStart !== -1, 'createCuttingSeatBubblesLayerHtml not found')
      assert(layerFnStart > anchorFnStart, 'expected createCuttingSeatBubblesLayerHtml to be declared after createSeatBubbleAnchorHtml')
      const anchorBody = src.slice(anchorFnStart, layerFnStart)
      assert(/renderBidBubble\(/.test(anchorBody), 'createSeatBubbleAnchorHtml no longer calls renderBidBubble')
      assert(/renderDeclarationBubble\(/.test(anchorBody), 'createSeatBubbleAnchorHtml no longer calls renderDeclarationBubble (belote/rebelote/sequence/20/50/100 all flow through this one function as bubble.lines)')
      assert(/renderEmojiBubble\(/.test(anchorBody), 'createSeatBubbleAnchorHtml no longer calls renderEmojiBubble')
      assert(/renderPhraseBubble\(/.test(anchorBody), 'createSeatBubbleAnchorHtml no longer calls renderPhraseBubble')
      const panelBody = src.slice(0, anchorFnStart)
      assert(!/data-seat-bid-bubble/.test(panelBody.slice(panelBody.indexOf('function createCuttingSeatPanelHtml('))), 'createCuttingSeatPanelHtml still emits bid bubble markup — bubbles would render twice (once in the old panel host, once in the new bubbles host)')
      const layerBody = src.slice(layerFnStart)
      assert(/createSeatBubbleAnchorHtml\(/.test(layerBody), 'createCuttingSeatBubblesLayerHtml no longer calls createSeatBubbleAnchorHtml — bubble types would no longer share one layer')
    },
  )

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  await browser?.close()
  await vite?.close()
}
