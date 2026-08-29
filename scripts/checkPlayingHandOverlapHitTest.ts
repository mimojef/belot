/**
 * checkPlayingHandOverlapHitTest.ts
 *
 * Regression test for the "I press one card but a different one gets
 * played" mobile/desktop bug (forensic report: pointer-events:none
 * fall-through). Real browser (Playwright), real production code
 * (renderPlayingScreen.ts via playingHandOverlapHitTestHarness.ts) — no
 * mocked layout/CSS. Real input synthesis (page.touchscreen.tap for
 * touch-enabled contexts, page.mouse.click for the desktop/no-touch
 * context) — not manually dispatched synthetic events.
 *
 * THE FIX under test (renderPlayingScreen.ts's renderBottomHandOverlay):
 *  - pointer-events is now unconditionally 'auto' for every hand card
 *    button, valid or not. An invalid (currently unplayable) card keeps its
 *    native `disabled` attribute — a disabled <button> still participates in
 *    hit-testing (elementFromPoint resolves to it, and it correctly BLOCKS
 *    the element behind it, unlike pointer-events:none which makes the
 *    element invisible to hit-testing) but the browser suppresses `click`
 *    on it entirely, and it never gets a 'click' listener attached in the
 *    first place (only `.play-hand-card--active`, i.e. canClick, buttons
 *    do) — so a tap that visually lands on an invalid card is correctly
 *    absorbed by it and produces NO submit, instead of silently falling
 *    through to whatever legal card happens to share that screen region.
 *  - invalid cards (isMyTurn && !isValid) now render at opacity 0.55 instead
 *    of an indistinguishable opacity:1.
 *
 * TEST METHODOLOGY NOTE (important — read before trusting the numbers):
 * The hand fan overlaps FAR more aggressively than "just adjacent cards" —
 * BOTTOM_HAND_MOBILE_CARD_WIDTH(211) vs BOTTOM_HAND_MOBILE_SPACING(70) means
 * a card's rect extends ~35px PAST its own center into its right neighbor's
 * territory, and that neighbor (higher z-index) legitimately covers that
 * region — i.e. even a card's own geometric CENTER can be rightfully owned
 * by its neighbor. Hardcoding "the click at point X must resolve to card Y"
 * is therefore fragile and was empirically wrong in an earlier version of
 * this script (verified by running it — see PR history). This version
 * instead asserts the actual invariant the fix guarantees, which does NOT
 * depend on knowing the exact winner in advance:
 *
 *   INVARIANT A — for ANY point, IF elementFromPoint() resolves to an
 *   ENABLED (playable) card, a real tap at that exact point MUST submit
 *   EXACTLY that resolved card's id (no fall-through, no mismatch).
 *   INVARIANT B — for ANY point, IF elementFromPoint() resolves to a
 *   DISABLED (invalid) card, a real tap at that exact point MUST submit
 *   NOTHING (the invalid card absorbs the tap; it never falls through to
 *   whatever sits underneath it).
 *
 * Both invariants are exactly "what you see is what gets played (or
 * nothing)" — the fall-through bug was a violation of invariant A specific
 * to the hazard polarity (invalid-on-top-of-valid). Probing multiple points
 * per card (left/center/right/overlap boundary, per the forensic task's own
 * checklist) and checking these two invariants at each is more thorough
 * AND more robust than hand-deriving z-order winners.
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

const W = '__playingHandOverlapHarness'

async function h(page: Page, path: string, ...args: unknown[]): Promise<any> {
  return page.evaluate(
    ([w, p, a]: any) => {
      const parts = p.split('.')
      let target: any = (window as any)[w]
      for (const part of parts) target = target[part]
      return typeof target === 'function' ? target(...a) : target
    },
    [W, path, args] as any,
  )
}

type Rect = { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number }
type CardInfo = { cardId: string; rect: Rect; zIndex: string; disabled: boolean; pointerEvents: string; opacity: string }
type Viewport = { label: string; width: number; height: number; isMobile: boolean; hasTouch: boolean }

const VIEWPORTS: Viewport[] = [
  { label: '320px', width: 320, height: 657, isMobile: true, hasTouch: true },
  { label: '360px', width: 360, height: 739, isMobile: true, hasTouch: true },
  { label: '375px', width: 375, height: 769, isMobile: true, hasTouch: true },
  { label: '390px', width: 390, height: 800, isMobile: true, hasTouch: true },
  { label: '412px', width: 412, height: 845, isMobile: true, hasTouch: true },
  { label: '430px', width: 430, height: 882, isMobile: true, hasTouch: true },
  { label: 'desktop 1440x900', width: 1440, height: 900, isMobile: false, hasTouch: false },
]

async function tap(page: Page, viewport: Viewport, x: number, y: number): Promise<void> {
  if (viewport.hasTouch) {
    await page.touchscreen.tap(x, y)
  } else {
    await page.mouse.click(x, y)
  }
}

function overlapRegion(a: Rect, b: Rect): { left: number; right: number; top: number; bottom: number } | null {
  const left = Math.max(a.left, b.left)
  const right = Math.min(a.right, b.right)
  const top = Math.max(a.top, b.top)
  const bottom = Math.min(a.bottom, b.bottom)
  if (right <= left || bottom <= top) return null
  return { left, right, top, bottom }
}

function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

// Ground truth за "кой елемент трябва да печели тук по z-index", computed от
// РЕАЛНИТЕ измерени rects/z-index на ВСИЧКИ карти (не само двойка, за която
// си мислим, че се застъпва) — виж методологичната бележка в горния коментар
// за защо hand-derived "картата вляво/вдясно печели" предположения са
// ненадеждни при overlap от този мащаб.
function groundTruthWinnerAt(cards: CardInfo[], x: number, y: number): CardInfo | null {
  let winner: CardInfo | null = null
  let winnerZ = -Infinity
  for (const c of cards) {
    if (!containsPoint(c.rect, x, y)) continue
    const z = Number.parseInt(c.zIndex, 10) || 0
    if (z > winnerZ) {
      winnerZ = z
      winner = c
    }
  }
  return winner
}

// Проверява INVARIANT A/B (виж горния коментар) в дадена точка: hit-test
// резултатът и реалният tap резултат трябва да са в перфектно съгласие.
//
// remount() се вика ПРЕДИ всеки реален tap — handleHandCardChoice гейтва на
// cache.pendingPlayCardSent, което остава true до следваща server snapshot
// (в реална игра — следващия ход); в този fixture (без реален сървър) то
// НИКОГА не се reset-ва между отделни tap-ове в СЪЩИЯ mount. Без remount, ВСЕКИ
// tap след първия успешен submit в дадена монтирана ръка би бил (правилно
// gated, но подвеждащо тук) отхвърлен от тази guard-логика, а не от
// hit-test/pointer-events механизма, който точно тестваме — remount()
// гарантира, че всеки отделен probe стартира от чисто, реалистично
// "готово за нов ход" състояние.
async function assertNoFallThroughAt(
  page: Page,
  viewport: Viewport,
  x: number,
  y: number,
  label: string,
  remount: () => Promise<void>,
): Promise<{ hitCardId: string | null; hitDisabled: boolean; submittedCardId: string | null }> {
  await remount()
  const hit = await h(page, 'hitTestAt', x, y)
  await h(page, 'clearSubmittedPlays')
  await tap(page, viewport, x, y)
  const submitted: Array<{ roomId: string; cardId: string }> = await h(page, 'getSubmittedPlays')

  if (hit.cardId === null) {
    assert(submitted.length === 0, `${label}: hit resolved to nothing, but a submit happened: ${JSON.stringify(submitted)}`)
  } else if (hit.disabled) {
    assert(submitted.length === 0, `${label}: hit resolved to DISABLED card ${hit.cardId}, but a submit happened: ${JSON.stringify(submitted)} — this is exactly the fall-through regression`)
  } else {
    assert(submitted.length === 1, `${label}: hit resolved to ENABLED card ${hit.cardId}, expected exactly one submit, got ${submitted.length}: ${JSON.stringify(submitted)}`)
    assert(submitted[0]!.cardId === hit.cardId, `${label}: hit resolved to ${hit.cardId} but submit was for ${submitted[0]!.cardId} (mismatch = wrong card played)`)
  }

  return { hitCardId: hit.cardId, hitDisabled: hit.disabled, submittedCardId: submitted[0]?.cardId ?? null }
}

console.log('\n═══ checkPlayingHandOverlapHitTest ═══\n')

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

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
      deviceScaleFactor: viewport.isMobile ? 2 : 1,
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto('/scripts/fixtures/playingHandOverlapHitTestHarness.html')

    if (viewport.isMobile) {
      await check(`[${viewport.label}] isPhoneLayoutViewport() reports mobile layout`, async () => {
        const isPhone = await h(page, 'isPhoneLayout')
        assert(isPhone === true, `expected mobile layout heuristic to be true at ${viewport.label} portrait`)
      })
    } else {
      await check(`[${viewport.label}] isPhoneLayoutViewport() reports DESKTOP layout`, async () => {
        const isPhone = await h(page, 'isPhoneLayout')
        assert(isPhone === false, `expected desktop layout heuristic (no touch, wide viewport) at ${viewport.label}`)
      })
    }

    // ─── [7] Config H: 3 suit groups, exercising BOTH overlap polarities ──
    // diamonds(2, invalid) | clubs(3, valid) | hearts(3, invalid) — sorted
    // order (SUIT_ORDER: diamonds<clubs<hearts<spades) keeps each group
    // contiguous IN THIS EXACT ORDER: [D0,D1, C0,C1,C2, Hr0,Hr1,Hr2]
    // (indices 0-7). trumpSuit is 'spades' (unused by any group here) so
    // rank order within each group stays the natural NO_TRUMPS_RANK_ORDER
    // (predictable, not trump-remapped).
    //   D1/C0 boundary: invalid UNDER valid -> "safe" polarity (already
    //     worked pre-fix; must still work).
    //   C2/Hr0 boundary: valid UNDER invalid -> the FIXED hazard polarity.
    const configH = {
      isMyTurn: true,
      groups: [
        { suit: 'diamonds', count: 2, valid: false },
        { suit: 'clubs', count: 3, valid: true },
        { suit: 'hearts', count: 3, valid: false },
      ],
    }
    const remountH = async (): Promise<void> => {
      await h(page, 'mount', configH)
    }
    await remountH()

    const cardsH: CardInfo[] = await h(page, 'getCardInfo')

    await check(`[${viewport.label}] [7] multi-suit hand renders 8 cards in 3 contiguous suit groups with correct legal/illegal split`, () => {
      assert(cardsH.length === 8, `expected 8 card buttons, got ${cardsH.length}`)
      assert(cardsH.slice(0, 2).every((c) => c.disabled), 'diamonds group (0-1) should be disabled (illegal)')
      assert(cardsH.slice(2, 5).every((c) => !c.disabled), 'clubs group (2-4) should be enabled (legal)')
      assert(cardsH.slice(5, 8).every((c) => c.disabled), 'hearts group (5-7) should be disabled (illegal)')
    })

    await check(`[${viewport.label}] all hand card buttons have pointer-events:auto regardless of legality (the actual fix)`, () => {
      for (const c of cardsH) {
        assert(c.pointerEvents === 'auto', `expected pointer-events:auto for card ${c.cardId} (disabled=${c.disabled}), got ${c.pointerEvents}`)
      }
    })

    await check(`[${viewport.label}] invalid cards are now visibly dimmed (opacity < 1) vs fully-opaque legal cards`, () => {
      const legalOpacities = new Set(cardsH.slice(2, 5).map((c) => c.opacity))
      const illegalOpacities = new Set([...cardsH.slice(0, 2), ...cardsH.slice(5, 8)].map((c) => c.opacity))
      assert(legalOpacities.size === 1 && legalOpacities.has('1'), `expected legal cards at opacity 1, got: ${[...legalOpacities].join(', ')}`)
      assert([...illegalOpacities].every((o) => Number(o) < 1), `expected illegal cards dimmed below opacity 1, got: ${[...illegalOpacities].join(', ')}`)
    })

    const d1 = cardsH[1]!
    const c0 = cardsH[2]!
    const c2 = cardsH[4]!
    const hr0 = cardsH[5]!

    const safeOverlap = overlapRegion(d1.rect, c0.rect)
    await check(`[${viewport.label}] safe-polarity boundary (invalid under valid) actually overlaps on screen`, () => {
      assert(safeOverlap !== null, 'expected D1/C0 to overlap')
    })
    if (safeOverlap) {
      const x = safeOverlap.left + (safeOverlap.right - safeOverlap.left) / 2
      const y = safeOverlap.top + (safeOverlap.bottom - safeOverlap.top) / 2
      await check(`[${viewport.label}] safe-polarity boundary resolves to an ENABLED (valid) card, not the disabled one behind it (ground truth sanity)`, () => {
        const winner = groundTruthWinnerAt(cardsH, x, y)
        assert(winner !== null && !winner.disabled, `expected ground truth at the safe boundary to be an enabled card, got ${JSON.stringify(winner)}`)
      })
      await check(`[${viewport.label}] no fall-through at the safe-polarity boundary (invariant A/B)`, async () => {
        await assertNoFallThroughAt(page, viewport, x, y, 'safe-polarity boundary', remountH)
      })
    }

    const hazardOverlap = overlapRegion(c2.rect, hr0.rect)
    await check(`[${viewport.label}] hazard-polarity boundary (valid under invalid) actually overlaps on screen`, () => {
      assert(hazardOverlap !== null, 'expected C2/Hr0 to overlap')
    })
    if (hazardOverlap) {
      const x = hazardOverlap.left + (hazardOverlap.right - hazardOverlap.left) / 2
      const y = hazardOverlap.top + (hazardOverlap.bottom - hazardOverlap.top) / 2

      await check(`[${viewport.label}] [1] elementFromPoint at the hazard boundary resolves to the visually-topmost INVALID card (the fixed hazard polarity is actually exercised here)`, () => {
        const winner = groundTruthWinnerAt(cardsH, x, y)
        assert(winner !== null && winner.disabled, `expected ground truth at the hazard boundary to be the disabled/invalid card (confirms this probe point IS the hazard polarity), got ${JSON.stringify(winner)}`)
      })

      await check(`[${viewport.label}] [2]/[3] no fall-through at the hazard boundary: tap does NOT submit the legal card underneath, produces NO submit at all`, async () => {
        const result = await assertNoFallThroughAt(page, viewport, x, y, 'hazard boundary', remountH)
        assert(result.hitDisabled === true, 'expected the resolved card at the hazard boundary to be disabled')
        assert(result.submittedCardId === null, 'expected zero submits at the hazard boundary')
      })
    }

    await check(`[${viewport.label}] no page errors during Config H mount/hit-test/tap`, () => {
      assert(errors.length === 0, `page errors: ${errors.join('; ')}`)
    })

    // ─── Config P: single suit, all 4 cards playable ──────────────────────
    // Tests [4] (interior card, left/center/right probes), [5] (adjacent
    // playable overlap), [6] (leftmost/rightmost, left/center/right probes).
    // trumpSuit stays 'diamonds' (unused) so NON_SEQUENTIAL_RANKS keeps its
    // natural ascending order — not load-bearing for this config's
    // assertions (which no longer hardcode which card ends up where), but
    // keeps the fixture's own internal declaration-avoidance reasoning valid.
    const configP = {
      isMyTurn: true,
      groups: [{ suit: 'clubs', count: 4, valid: true }],
    }
    const remountP = async (): Promise<void> => {
      await h(page, 'mount', configP)
    }
    await remountP()
    const cardsP: CardInfo[] = await h(page, 'getCardInfo')

    await check(`[${viewport.label}] Config P renders 4 fully-playable cards`, () => {
      assert(cardsP.length === 4, `expected 4 cards, got ${cardsP.length}`)
      assert(cardsP.every((c) => !c.disabled), 'expected all 4 cards to be enabled')
    })

    // [4]/[6]: probe left/center/right of EVERY card (leftmost, interior x2,
    // rightmost) — per the forensic task's own checklist. Every probe must
    // satisfy invariant A: whatever elementFromPoint resolves to (always an
    // enabled card here, since Config P has no disabled cards at all) must
    // be exactly what a real tap submits.
    for (let i = 0; i < cardsP.length; i++) {
      const card = cardsP[i]!
      const roleLabel = i === 0 ? 'leftmost' : i === cardsP.length - 1 ? 'rightmost' : `interior[${i}]`
      const probes: Array<[string, number, number]> = [
        ['left', card.rect.left + card.rect.width * 0.1, card.rect.top + card.rect.height / 2],
        ['center', card.rect.left + card.rect.width / 2, card.rect.top + card.rect.height / 2],
        ['right', card.rect.left + card.rect.width * 0.9, card.rect.top + card.rect.height / 2],
      ]
      for (const [pos, x, y] of probes) {
        await check(`[${viewport.label}] [4]/[6] ${roleLabel} card (${card.cardId}), ${pos} probe: no fall-through, playable-card taps submit exactly themselves`, async () => {
          await assertNoFallThroughAt(page, viewport, x, y, `${roleLabel} ${pos} probe`, remountP)
        })
      }
    }

    // [5]: overlap boundary between two adjacent playable cards — no
    // fall-through regardless of which of the two (or a third) is the
    // actual ground-truth winner there.
    for (let i = 0; i < cardsP.length - 1; i++) {
      const a = cardsP[i]!
      const b = cardsP[i + 1]!
      const region = overlapRegion(a.rect, b.rect)
      await check(`[${viewport.label}] [5] adjacent playable cards ${a.cardId}/${b.cardId} overlap on screen`, () => {
        assert(region !== null, `expected ${a.cardId}/${b.cardId} to overlap`)
      })
      if (region) {
        const x = region.left + (region.right - region.left) / 2
        const y = region.top + (region.bottom - region.top) / 2
        await check(`[${viewport.label}] [5] no fall-through at ${a.cardId}/${b.cardId} overlap boundary (normal fan behavior unchanged)`, async () => {
          const result = await assertNoFallThroughAt(page, viewport, x, y, `${a.cardId}/${b.cardId} overlap`, remountP)
          assert(result.hitDisabled === false, 'expected an enabled card to win a playable/playable overlap')
        })
      }
    }

    await check(`[${viewport.label}] no page errors during Config P mount/hit-test/tap`, () => {
      assert(errors.length === 0, `page errors: ${errors.join('; ')}`)
    })

    await context.close()
  }
} finally {
  try { await browser?.close() } catch {}
  try { await vite?.close() } catch {}
}

console.log(`\ncheckPlayingHandOverlapHitTest: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
