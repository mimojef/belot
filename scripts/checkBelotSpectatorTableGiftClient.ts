/**
 * checkBelotSpectatorTableGiftClient.ts
 *
 * Belot spectator table gifts — client side. Real browser (Playwright), real
 * production код (createActiveRoomFlowController + renderCuttingSeatPanels +
 * renderBelotSpectatorViewers) през activeRoomSpectatorHarness.ts.
 *
 *   [C1]  spectator вижда gift иконата на всичките 4 заети места
 *   [C2]  без gameplay/social контроли освен gift + Настройки + Изход
 *   [C3]  click отваря съществуващия table gift модал
 *   [C4]  визуално долният играч е giftable от spectator
 *   [C5]  получателят е правилен
 *   [C6]  spectator gift: origin = горе вдясно (viewer anchor)
 *   [C7]  participant viewer: origin = реалният viewer icon DOM rect
 *   [C8]  spectator viewer: невидим еквивалентен rect (без видима икона)
 *   [C9]  дестинация = правилният получател
 *   [C10] "От X" се показва само след landing
 *   [C11] надписът стои ~4000 ms
 *   [C12] participant gift без нов надпис
 *   [C13] escaping на senderDisplayName
 *   [C14] едновременни подаръци към различни получатели пазят различни имена
 *   [C15] два подаръка към един получател -> последният печели
 *   [C16] Изход прекратява полет + label timer
 *   [C17] desktop (блоковете по-горе)
 *   [C18] mobile
 *   [C19] spectator продължава да не вижда viewer иконата
 *   [R1]  source review
 */


import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(150)
  }
  throw new Error('waitUntil: timed out')
}
function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      const { port } = address
      srv.close(() => resolveFree(port))
    })
  })
}

type H = any

async function call<T>(page: Page, fn: (h: H, arg: any) => T, arg: any = undefined): Promise<T> {
  return page.evaluate(
    ({ fn: fnStr, arg: a }) => {
      const h = (window as any).__activeRoomSpectatorHarness
      // eslint-disable-next-line no-eval
      const resolved = (0, eval)(fnStr) as (h: H, arg: any) => T
      return resolved(h, a)
    },
    { fn: fn.toString(), arg },
  )
}



const FLIGHT_MS = 1600
const LABEL_MS = 4000
let txSeq = 0
function giftEvent(roomId: string, o: { senderKind: 'participant' | 'spectator'; senderSeat: string | null; senderDisplayName: string; recipientSeat: string; transactionId?: string }) {
  const now = Date.now()
  txSeq += 1
  return {
    type: 'table_gift_item_sent', roomId, transactionId: o.transactionId ?? `tx-${txSeq}-${now}`,
    giftItemId: 'gift-rose', giftName: 'Роза', imageUrl: '/images/belot/belot-spectator-viewer.webp',
    senderProfileId: `sender-${txSeq}`, senderKind: o.senderKind, senderSeat: o.senderSeat, senderDisplayName: o.senderDisplayName,
    recipientSeat: o.recipientSeat, sentAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
  }
}
const dist = (a: { cx: number; cy: number } | null | undefined, b: { cx: number; cy: number } | null | undefined) =>
  a && b ? Math.hypot(a.cx - b.cx, a.cy - b.cy) : Number.POSITIVE_INFINITY

console.log('\ncheckBelotSpectatorTableGiftClient\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/activeRoomSpectatorHarness.html`
  browser = await chromium.launch()

  async function newPage(mobile = false): Promise<Page> {
    const context = await browser!.newContext(mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__activeRoomSpectatorHarness !== undefined, undefined, { timeout: 10_000 })
    ;(page as any).__pageErrors = pageErrors
    return page
  }
  function assertNoPageErrors(page: Page, label: string): void {
    const errors = (page as any).__pageErrors as string[]
    assert(errors.length === 0, `${label}: unexpected page errors: ${errors.join(' | ')}`)
  }
  async function enterSettledSpectator(page: Page, roomId: string): Promise<void> {
    await call(page, (h: H, r: string) => h.enterAsSpectator(r, h.playingGame()), roomId)
    await waitUntil(() => call(page, (h: H) => ['bottom', 'right', 'top', 'left'].every((s) => h.fanMetrics(s)?.visible === 8)))
    await sleep(1_500)
  }
  async function enterSettledParticipant(page: Page, roomId: string): Promise<void> {
    await call(page, (h: H, r: string) => h.enterAsParticipant(r, 'bottom'), roomId)
    await call(page, (h: H, r: string) => h.applyParticipantSnapshot(r, h.playingGame()), roomId)
    await waitUntil(() => call(page, (h: H) => ['right', 'top', 'left'].every((s) => h.fanMetrics(s)?.visible === 8)))
    await sleep(1_500)
  }
  const inject = (page: Page, message: unknown) => call(page, (h: H, m: unknown) => h.injectServerMessage(m), message)
  const labels = (page: Page) => call(page, (h: H) => h.giftSenderLabels())

  // ── Spectator desktop: C1-C6, C8-C11, C13-C16, C19 ──────────────────────
  {
    const page = await newPage()
    await enterSettledSpectator(page, 'room-g')

    await check('[C1] spectator sees the gift icon on all 4 occupied player seats', async () => {
      assertEqual(JSON.stringify(await call(page, (h: H) => h.giftIconSeats())), JSON.stringify(['bottom', 'left', 'right', 'top']), 'gift icon seats')
    })

    await check('[C2/C19] no gameplay/social controls except gift + Settings + Exit; no viewer icon for the spectator', async () => {
      assertEqual(await call(page, (h: H) => h.hasEmojiToggle()), false, 'emoji')
      assertEqual(await call(page, (h: H) => h.hasPhraseToggle()), false, 'phrase')
      assertEqual(await call(page, (h: H) => h.hasBiddingPopup()), false, 'bid')
      assertEqual(await call(page, (h: H) => h.hasBottomHandOverlay()), false, 'own hand / cards')
      assertEqual(await call(page, (h: H) => h.hasBotTakeoverPopup()), false, 'bot reclaim')
      assertEqual(await call(page, (h: H) => h.hasSettingsButton()), true, 'settings')
      assertEqual(await call(page, (h: H) => h.hasLeaveButton()), true, 'exit')
      assertEqual((await call(page, (h: H) => h.viewerIndicatorInfo())).icon, null, 'no viewer icon for spectator')
      // Profile click остава no-op.
      await call(page, (h: H) => h.clickSeatProfile('right'))
      assertEqual(await call(page, (h: H) => h.hasProfilePopupOpen()), false, 'profile popup stays disabled')
    })

    await check('[C3] clicking a gift icon opens the existing table gift modal', async () => {
      await call(page, (h: H) => h.clickGiftIcon('top'))
      await waitUntil(() => call(page, (h: H) => h.tableGiftModalInfo().pickIds.length > 0), 3_000)
      const modal = await call(page, (h: H) => h.tableGiftModalInfo())
      assert(modal.open && modal.pickIds.includes('gift-rose'), JSON.stringify(modal))
      await page.locator('[data-table-gift-modal-close="1"]').click()
    })

    await check('[C4/C5] the visual bottom seat is giftable; send uses the right recipient', async () => {
      await call(page, (h: H) => h.clickGiftIcon('bottom'))
      await waitUntil(() => call(page, (h: H) => h.tableGiftModalInfo().pickIds.length > 0), 3_000)
      await call(page, (h: H) => h.pickTableGift('gift-rose'))
      const sends = (await call(page, (h: H) => h.getCalls())).filter((c: any) => c.name === 'sendTableGift')
      assertEqual(sends.length, 1, 'one sendTableGift call')
      assertEqual(sends[0].args[0], 'room-g', 'roomId')
      assertEqual(sends[0].args[1], 'profile-bottom', 'recipient profileId (visual bottom player)')
      assertEqual(sends[0].args[2], 'gift-rose', 'giftItemId')
      await inject(page, { type: 'table_gift_send_result', roomId: 'room-g', requestId: sends[0].args[3], ok: true, transactionId: 'tx-res', chargedPrice: 100, senderBalanceAfter: 49_900 })
    })

    await check('[C6/C8/C9/C10/C11] spectator gift: origin = invisible top-right anchor, lands on recipient, "От X" only after landing, ~4 s', async () => {
      const anchor = await call(page, (h: H) => h.viewerOriginRect())
      assertEqual(await page.locator('[data-belot-spectator-viewer-anchor-probe]').count(), 0, 'probe removed')
      await inject(page, giftEvent('room-g', { senderKind: 'spectator', senderSeat: null, senderDisplayName: 'Ани', recipientSeat: 'top' }))
      await sleep(60)
      // Origin = първият keyframe (детерминистично; flyer-ът тръгва веднага по пътя).
      const early = (await call(page, (h: H) => h.giftFlightKeyframes()))![0]
      assert(dist(early, anchor) < 3, `flight starts at the top-right anchor: flyer ${JSON.stringify(early)} anchor ${JSON.stringify(anchor)}`)
      assert(anchor.cx > 1180 && anchor.cy < 70, `anchor is top-right: ${JSON.stringify(anchor)}`)
      await sleep(800)
      assertEqual((await labels(page)).length, 0, 'no label before landing')
      await sleep(FLIGHT_MS - 800 - 60 - 180)
      const late = (await call(page, (h: H) => h.flyerCenters()))[0]
      const target = await call(page, (h: H) => h.profileCenter('top'))
      assert(dist(late, target) < 45, `lands on recipient top: flyer ${JSON.stringify(late)} target ${JSON.stringify(target)}`)
      await waitUntil(async () => (await labels(page)).length === 1, 1_500)
      const l = (await labels(page))[0]
      assertEqual(l.text, 'От Ани', 'label text')
      assertEqual(l.seat, 'top', 'label seat')
      assertEqual(l.pointerEvents, 'none', 'pointer-events none')
      assert(dist({ cx: l.centerX, cy: 0 }, { cx: target!.cx, cy: 0 }) < 3, 'label centered on the recipient')
      await sleep(LABEL_MS - 600)
      assertEqual((await labels(page)).length, 1, 'label still visible at ~3.4 s')
      await sleep(1_000)
      assertEqual((await labels(page)).length, 0, 'label removed after ~4 s')
      assertEqual((await call(page, (h: H) => h.tableGiftOverlayInfo('top'))).imgCount, 1, 'gift overlay keeps its normal lifecycle')
    })

    await check('[C13] sender name is rendered as text (escaped)', async () => {
      await inject(page, giftEvent('room-g', { senderKind: 'spectator', senderSeat: null, senderDisplayName: '<b>Хакер</b>', recipientSeat: 'right' }))
      await waitUntil(async () => (await labels(page)).some((x) => x.seat === 'right'), 3_000)
      const l = (await labels(page)).find((x) => x.seat === 'right')!
      assertEqual(l.text, 'От <b>Хакер</b>', 'literal text')
      assertEqual(await page.locator('[data-table-gift-sender-label] b').count(), 0, 'no injected element')
    })

    await check('[C14] simultaneous spectator gifts to different recipients keep their own names', async () => {
      await sleep(LABEL_MS + 200)
      await inject(page, giftEvent('room-g', { senderKind: 'spectator', senderSeat: null, senderDisplayName: 'Ани', recipientSeat: 'left' }))
      await inject(page, giftEvent('room-g', { senderKind: 'spectator', senderSeat: null, senderDisplayName: 'Боби', recipientSeat: 'bottom' }))
      assertEqual((await call(page, (h: H) => h.flyerCenters())).length, 2, 'two independent flights')
      await waitUntil(async () => (await labels(page)).length === 2, 3_000)
      const bySeat = Object.fromEntries((await labels(page)).map((x) => [x.seat, x.text]))
      assertEqual(bySeat.left, 'От Ани', 'left label')
      assertEqual(bySeat.bottom, 'От Боби', 'bottom label')
    })

    await check('[C15] two gifts to the same recipient -> last gift/label wins', async () => {
      await sleep(LABEL_MS + 200)
      await inject(page, giftEvent('room-g', { senderKind: 'spectator', senderSeat: null, senderDisplayName: 'Първи', recipientSeat: 'top', transactionId: 'tx-same-1' }))
      await sleep(150)
      await inject(page, giftEvent('room-g', { senderKind: 'spectator', senderSeat: null, senderDisplayName: 'Втори', recipientSeat: 'top', transactionId: 'tx-same-2' }))
      await sleep(FLIGHT_MS + 500)
      const topLabels = (await labels(page)).filter((x) => x.seat === 'top')
      assertEqual(topLabels.length, 1, 'one label for the recipient')
      assertEqual(topLabels[0].text, 'От Втори', 'last gift label wins')
      assertEqual(topLabels[0].transactionId, 'tx-same-2', 'label bound to the last transaction')
      await sleep(LABEL_MS)
      assertEqual((await labels(page)).filter((x) => x.seat === 'top').length, 0, 'stale timer did not leave a label behind')
    })

    await check('[C16] Exit during a flight cleans flight + label timer', async () => {
      await inject(page, giftEvent('room-g', { senderKind: 'spectator', senderSeat: null, senderDisplayName: 'Ани', recipientSeat: 'left' }))
      await sleep(300)
      assertEqual((await call(page, (h: H) => h.flyerCenters())).length, 1, 'precondition: flying')
      await call(page, (h: H) => h.exitSpectator())
      assertEqual((await call(page, (h: H) => h.flyerCenters())).length, 0, 'flight cancelled on exit')
      await sleep(FLIGHT_MS + 500)
      assertEqual((await labels(page)).length, 0, 'no label after exit')
      assertEqual((await call(page, (h: H) => h.flyerCenters())).length, 0, 'nothing flies over the lobby')
    })
    assertNoPageErrors(page, 'spectator desktop')
    await page.close()
  }

  // ── Participant viewer: C7, C12 ─────────────────────────────────────────
  {
    const page = await newPage()
    await enterSettledParticipant(page, 'room-p')

    await check('[C-participant] participant still gifts only the other 3 seats', async () => {
      assertEqual(JSON.stringify(await call(page, (h: H) => h.giftIconSeats())), JSON.stringify(['left', 'right', 'top']), 'participant gift seats')
    })

    await check('[C7] participant viewer: spectator gift starts at the actual viewer icon DOM rect', async () => {
      await inject(page, { type: 'belot_room_spectators', roomId: 'room-p', spectators: [{ profileId: 'spec-1', displayName: 'Ани' }] })
      const icon = (await call(page, (h: H) => h.viewerIndicatorInfo())).icon
      assert(icon !== null, 'viewer icon visible for participant')
      const iconCenter = { cx: Math.round(icon!.left + icon!.width / 2), cy: Math.round(icon!.top + icon!.height / 2) }
      await inject(page, giftEvent('room-p', { senderKind: 'spectator', senderSeat: null, senderDisplayName: 'Ани', recipientSeat: 'right' }))
      await sleep(60)
      // Origin = първият keyframe (детерминистично; flyer-ът тръгва веднага по пътя).
      const early = (await call(page, (h: H) => h.giftFlightKeyframes()))![0]
      assert(dist(early, iconCenter) < 3, `flight starts at the viewer icon: ${JSON.stringify(early)} vs ${JSON.stringify(iconCenter)}`)
      await waitUntil(async () => (await labels(page)).length === 1, 3_000)
      assertEqual((await labels(page))[0].text, 'От Ани', 'participants see the label too')
    })

    await check('[C12] participant -> participant gift has NO "От X" label', async () => {
      await sleep(LABEL_MS + 200)
      await inject(page, giftEvent('room-p', { senderKind: 'participant', senderSeat: 'left', senderDisplayName: 'Играч', recipientSeat: 'top' }))
      await sleep(FLIGHT_MS + 700)
      assertEqual((await labels(page)).length, 0, 'no label for participant gifts')
      assertEqual((await call(page, (h: H) => h.tableGiftOverlayInfo('top'))).imgCount, 1, 'normal overlay shown')
    })
    assertNoPageErrors(page, 'participant')
    await page.close()
  }

  // ── Mobile: C17/C18 ─────────────────────────────────────────────────────
  await check('[C18] mobile spectator: gift icons, top-right anchor origin, label inside the viewport', async () => {
    const page = await newPage(true)
    await enterSettledSpectator(page, 'room-m')
    assertEqual(JSON.stringify(await call(page, (h: H) => h.giftIconSeats())), JSON.stringify(['bottom', 'left', 'right', 'top']), 'mobile gift seats')
    const anchor = await call(page, (h: H) => h.viewerOriginRect())
    assert(anchor.cx > 300 && anchor.cy < 70, `mobile anchor top-right: ${JSON.stringify(anchor)}`)
    await inject(page, giftEvent('room-m', { senderKind: 'spectator', senderSeat: null, senderDisplayName: 'Много дълго потребителско име за тест на мобилен', recipientSeat: 'left' }))
    await sleep(60)
    // Origin = първият keyframe (детерминистично; flyer-ът тръгва веднага по пътя).
    const early = (await call(page, (h: H) => h.giftFlightKeyframes()))![0]
    assert(dist(early, anchor) < 3, `mobile origin: ${JSON.stringify(early)} vs ${JSON.stringify(anchor)}`)
    await waitUntil(async () => (await labels(page)).length === 1, 3_000)
    const l = (await labels(page))[0]
    assert(l.text.startsWith('От Много'), 'label text')
    assertEqual(l.overflow, false, 'label stays inside the viewport (ellipsis)')
    assertNoPageErrors(page, 'mobile')
    await page.close()
  })
  // C17 (desktop) е покрит от desktop блока по-горе.

  // ── Flight path: spectator 2-stage, participant unchanged ───────────────
  await check('[P1] spectator gift: 2-stage route origin -> table center -> recipient (keyframes + real motion)', async () => {
    const page = await newPage()
    await enterSettledSpectator(page, 'room-path')
    const anchor = await call(page, (h: H) => h.viewerOriginRect())
    const center = await call(page, (h: H) => h.tableCenterFromProfiles())
    const target = await call(page, (h: H) => h.profileCenter('left'))
    await inject(page, giftEvent('room-path', { senderKind: 'spectator', senderSeat: null, senderDisplayName: 'Ани', recipientSeat: 'left' }))
    const kf = await call(page, (h: H) => h.giftFlightKeyframes())
    assert(kf !== null && kf.length === 5, `keyframes ${JSON.stringify(kf)}`)
    assertEqual(JSON.stringify(kf!.map((k: any) => k.offset)), JSON.stringify([0, 0.1, 0.48, 0.88, 1]), 'offsets')
    assert(dist(kf![0], anchor) < 3 && dist(kf![1], anchor) < 3, `segment 1 starts at the spectator origin: ${JSON.stringify(kf![0])} vs ${JSON.stringify(anchor)}`)
    assert(dist(kf![2], center) < 3, `waypoint is the table center: ${JSON.stringify(kf![2])} vs ${JSON.stringify(center)}`)
    assert(dist(kf![4], target) < 3, `segment 2 ends at the recipient: ${JSON.stringify(kf![4])} vs ${JSON.stringify(target)}`)
    // Реалното движение минава през центъра (а не по горния ръб).
    let minToCenter = Number.POSITIVE_INFINITY
    let topEdgeSamples = 0
    for (let i = 0; i < 45; i++) {
      const f = (await call(page, (h: H) => h.flyerCenters()))[0]
      if (!f) break
      minToCenter = Math.min(minToCenter, dist(f, center))
      if (f.cy < 60 && dist(f, anchor) > 80) topEdgeSamples++
      await sleep(35)
    }
    assert(minToCenter < 40, `flyer passes the table center (min distance ${Math.round(minToCenter)})`)
    assertEqual(topEdgeSamples, 0, 'no travel along the top edge away from the origin')
    assertNoPageErrors(page, 'P1')
    await page.close()
  })

  {
    const page = await newPage()
    await enterSettledParticipant(page, 'room-path-p')

    await check('[P2] participant viewer: spectator gift uses the same 2-stage route from the real viewer icon', async () => {
      await inject(page, { type: 'belot_room_spectators', roomId: 'room-path-p', spectators: [{ profileId: 'spec-1', displayName: 'Ани' }] })
      const icon = (await call(page, (h: H) => h.viewerIndicatorInfo())).icon!
      const iconCenter = { cx: Math.round(icon.left + icon.width / 2), cy: Math.round(icon.top + icon.height / 2) }
      const center = await call(page, (h: H) => h.tableCenterFromProfiles())
      await inject(page, giftEvent('room-path-p', { senderKind: 'spectator', senderSeat: null, senderDisplayName: 'Ани', recipientSeat: 'top' }))
      const kf = (await call(page, (h: H) => h.giftFlightKeyframes()))!
      assert(dist(kf[0], iconCenter) < 3, `origin = viewer icon: ${JSON.stringify(kf[0])} vs ${JSON.stringify(iconCenter)}`)
      assert(dist(kf[2], center) < 3, `waypoint = table center: ${JSON.stringify(kf[2])} vs ${JSON.stringify(center)}`)
    })

    await check('[P3] participant -> participant gift path is unchanged (arc, offsets 0/0.13/0.62/0.88/1)', async () => {
      await sleep(FLIGHT_MS + 300)
      const from = await call(page, (h: H) => h.profileCenter('left'))
      const to = await call(page, (h: H) => h.profileCenter('right'))
      await inject(page, giftEvent('room-path-p', { senderKind: 'participant', senderSeat: 'left', senderDisplayName: 'Играч', recipientSeat: 'right' }))
      const kf = (await call(page, (h: H) => h.giftFlightKeyframes()))!
      assertEqual(JSON.stringify(kf.map((k: any) => k.offset)), JSON.stringify([0, 0.13, 0.62, 0.88, 1]), 'participant offsets unchanged')
      assert(dist(kf[0], from) < 3 && dist(kf[4], to) < 3, 'seat to seat')
      assert(Math.abs(kf[2].cx - Math.round((from!.cx + to!.cx) / 2)) <= 2, `arc midpoint x: ${kf[2].cx}`)
      assert(Math.abs(kf[2].cy - (Math.min(from!.cy, to!.cy) - 60)) <= 2, `arc lifts 60px above: ${kf[2].cy}`)
    })
    assertNoPageErrors(page, 'P2/P3')
    await page.close()
  }

  // ── Gift picker stacking: above played-card flight ──────────────────────
  for (const [mobile, label] of [[false, '[L1] desktop'], [true, '[L2] mobile']] as const) {
    await check(`${label} gift picker stays above a played-card flight and remains interactable`, async () => {
      const page = await newPage(mobile)
      await enterSettledSpectator(page, 'room-layer')
      await call(page, (h: H) => h.clickGiftIcon('top'))
      await waitUntil(() => call(page, (h: H) => h.tableGiftModalInfo().pickIds.length > 0), 3_000)
      // Играч хвърля карта, докато picker-ът е отворен.
      const result = await page.evaluate(async () => {
        const h = (window as any).__activeRoomSpectatorHarness
        await h.applySpectatorSnapshot('room-layer', h.playingGame({
          handCounts: { bottom: 8, right: 7, top: 8, left: 8 },
          playing: {
            winningBid: { seat: 'bottom', contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false },
            currentTurnSeat: 'top', currentTrickPlays: [{ seat: 'right', card: { id: 'hearts-A', suit: 'hearts', rank: 'A' } }],
            completedTricksCount: 0, latestCompletedTrick: null, validCardIds: null, sweepOffer: null, sweepResolution: null,
          },
        }))
        return h.giftModalTopmostCheck()
      })
      assert(result !== null, 'modal open')
      assert(result!.flyOverlayZ !== null, 'precondition: a played-card flight is in progress')
      assert(Number(result!.hostZ) > Number(result!.flyOverlayZ), `picker z ${result!.hostZ} > played card z ${result!.flyOverlayZ}`)
      assertEqual(result!.pickOnTop, true, 'gift pick button is the topmost element')
      await sleep(400)
      assertEqual((await call(page, (h: H) => h.giftModalTopmostCheck()))!.pickOnTop, true, 'still on top after the card landed')
      await call(page, (h: H) => h.pickTableGift('gift-rose'))
      const sends = (await call(page, (h: H) => h.getCalls())).filter((c: any) => c.name === 'sendTableGift')
      assertEqual(sends.length, 1, 'picker remains interactable (send fired)')
      assertNoPageErrors(page, label)
      await page.close()
    })
  }

  await check('[R1] source review: flight origin API without fake seat; label bound to live landing only', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const controller = (await readFile(join(here, '..', 'src', 'app', 'activeRoom', 'createActiveRoomFlowController.ts'), 'utf8')).replace(/\r\n/g, '\n')
    assert(controller.includes("type TableGiftFlightOrigin = { kind: 'seat'; seat: Seat } | { kind: 'spectator' }"), 'origin union')
    assert(controller.includes("? getBelotSpectatorViewerOriginRect()"), 'spectator origin rect')
    const snapshotApply = controller.slice(controller.indexOf('function applyActiveTableGiftsFromSnapshot('), controller.indexOf('function clearTableGiftOverlayTimer('))
    assert(!snapshotApply.includes('showSpectatorGiftSenderLabel') && !snapshotApply.includes('landTableGift'), 'snapshot hydration never shows the label')
    assert(controller.includes("if (controlledSeat !== null && recipientSeat === controlledSeat) return"), 'perspective fix in openTableGiftModal')
  })
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
process.exit(0)
