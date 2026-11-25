/**
 * checkBelotErrorIsolation.ts — Етап 1: грешки от друга игра и чужди грешки
 * не пипат Белот масата; банерът има две състояния; червените съобщения не
 * се застъпват с банера.
 *
 * Реален Chromium + реален createActiveRoomFlowController + реален
 * createGameServerClient (scripts/fixtures/belotErrorIsolationHarness.ts)
 * срещу фалшив Белот сървър по реален WebSocket. Сървърът може да задържи
 * изиграната карта (тя остава „чакаща“) и да инжектира грешки.
 *
 *   [E1] чакаща карта + Ludo грешка (ludo_match_not_found) -> без resync,
 *        картата остава чакаща, текстът не се показва никъде
 *   [E2] чакаща карта + чужда обща грешка (requestType друга заявка) -> без resync
 *   [E3] чакаща карта + грешка без корелация (requestType: null) -> без resync
 *   [E4] чакаща карта + грешка за submit_play_card -> resync; ръката се
 *        отключва с „Ходът не беше приет“
 *   [E5] стар сървър (без requestType) -> досегашното поведение (resync)
 *   [E6] банер: затворен транспорт -> „Връзката със сървъра се възстановява...“;
 *        отворен, преди синхронизацията -> „Възстановяване на играта...“;
 *        след room_resumed + snapshot -> няма банер
 *   [E7] червеното съобщение при блокиран ход е ПОД банера (и в двете състояния)
 *   [E8] bidding: червената грешка е под банера; Ludo грешка в прозореца на
 *        синхронизацията не се показва; текстът на банера не се дублира в червено
 *   [E9] без JS грешки
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkBelotErrorIsolation.ts
 */
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createHttpServer } from 'node:http'
import net from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

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
function assert(condition: boolean, msg: string): asserts condition {
  if (!condition) throw new Error(msg)
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(label: string, fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const startedAt = Date.now()
  let last = await fn()
  while (!predicate(last)) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`${label}: timeout (last=${JSON.stringify(last)})`)
    await wait(80)
    last = await fn()
  }
  return last
}

type Seat = 'bottom' | 'right' | 'top' | 'left'
type Card = { id: string; suit: 'clubs' | 'diamonds' | 'hearts' | 'spades'; rank: string }
const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']
const ROOM_ID = 'room-error-isolation'
const HUMAN_TURN_TIMEOUT_MS = 60_000
const RECONNECTING = 'Връзката със сървъра се възстановява...'
const RESYNCING = 'Възстановяване на играта...'
const LUDO_TEXT = 'Ludo играта не беше намерена.'

function makeHand(prefix: string, count = 8): Card[] {
  const suits: Card['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades']
  const ranks = ['7', '9', 'J', 'A', 'K', '10', 'Q', '8']
  return ranks.slice(0, count).map((rank, index) => ({ id: `${prefix}-${suits[index % 4]}-${rank}`, suit: suits[index % 4], rank }))
}

class FakeBelotServer {
  mode: 'playing' | 'bidding' = 'playing'
  hand: Card[] = makeHand('b')
  sockets = new Set<WebSocket>()
  attached = new Set<WebSocket>()
  submits: string[] = []
  resumeCount = 0

  attach(ws: WebSocket): void {
    this.sockets.add(ws)
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { type: string; cardId?: string }
      if (message.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() })); return }
      if (message.type === 'resume_room') {
        this.resumeCount += 1
        this.attached.add(ws)
        ws.send(JSON.stringify({ type: 'room_resumed', roomId: ROOM_ID, seat: 'bottom' }))
        ws.send(JSON.stringify(this.snapshot()))
        return
      }
      // Изиграната карта се задържа (без отговор) — остава чакаща в клиента.
      if (message.type === 'submit_play_card') this.submits.push(message.cardId ?? '')
    })
    ws.on('close', () => { this.sockets.delete(ws); this.attached.delete(ws) })
  }

  inject(payload: Record<string, unknown>): void {
    for (const ws of this.sockets) ws.send(JSON.stringify(payload))
  }

  broadcast(): void {
    for (const ws of this.attached) ws.send(JSON.stringify(this.snapshot()))
  }

  snapshot(): unknown {
    const bidding = this.mode === 'bidding'
    const ownHand = bidding ? this.hand.slice(0, 5) : this.hand
    return {
      type: 'room_snapshot',
      roomId: ROOM_ID,
      roomStatus: 'playing',
      yourSeat: 'bottom',
      reconnectToken: 'token-1',
      seats: SEAT_ORDER.map((seat, index) => ({
        seat, isOccupied: true, isConnected: true, isBot: index !== 0, isControlledByBot: false,
        displayName: index === 0 ? 'Human' : `Bot ${index}`, avatarUrl: null, gender: null, level: 1, rankTitle: null, skillRating: null,
      })),
      game: {
        phase: bidding ? 'bidding' : 'playing',
        authoritativePhase: bidding ? 'bidding' : 'playing',
        timerDeadlineAt: Date.now() + HUMAN_TURN_TIMEOUT_MS,
        serverNow: Date.now(),
        humanTurnTimeoutMs: HUMAN_TURN_TIMEOUT_MS,
        dealerSeat: 'right',
        firstDealSeat: 'bottom',
        cutting: null,
        bidding: bidding
          ? { currentBidderSeat: 'right', canSubmitBid: false, entries: [], winningBid: { contract: null, trumpSuit: null, seat: null, doubled: false, redoubled: false }, validActions: null }
          : null,
        playing: bidding ? null : {
          winningBid: { seat: 'bottom', contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false },
          currentTurnSeat: 'bottom',
          currentTrickPlays: [],
          completedTricksCount: 0,
          latestCompletedTrick: null,
          validCardIds: ownHand.map((card) => card.id),
          sweepOffer: null,
          sweepResolution: null,
        },
        scoring: null,
        matchEnded: null,
        declarations: [],
        ownDeclarationKeys: [],
        score: { match: { teamA: 0, teamB: 0 } },
        handCounts: { bottom: ownHand.length, right: ownHand.length, top: ownHand.length, left: ownHand.length },
        ownHand,
      },
      isGuestTrial: false,
      isPrivateTableOrigin: true,
      isTournamentMatchOrigin: false,
      stakeAmount: 5000,
    }
  }
}

type H = Record<string, (...args: any[]) => Promise<any>>
function harness(page: Page): H {
  const names = ['activeHandCardIds', 'clickCard', 'cardTransform', 'bannerText', 'bannerRect', 'noticeText', 'noticeRect', 'biddingErrorText', 'biddingErrorRect', 'bodyText', 'isTransportConnected', 'drop', 'reconnect', 'resume']
  const h: H = {}
  for (const name of names) {
    h[name] = (...args: unknown[]) => page.evaluate(([n, a]: any) => (window as any).__errorIsolationHarness[n](...a), [name, args] as any)
  }
  return h
}

async function scenario(browser: Browser, baseUrl: string, label: string, viewport: { width: number; height: number }): Promise<void> {
  console.log(`\n── ${label} (${viewport.width}x${viewport.height}) ──`)
  const httpServer = createHttpServer()
  const wss = new WebSocketServer({ server: httpServer })
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()))
  const port = (httpServer.address() as net.AddressInfo).port
  const game = new FakeBelotServer()
  wss.on('connection', (ws) => game.attach(ws))
  const context = await browser.newContext({ baseURL: baseUrl, viewport })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  await page.goto(`/scripts/fixtures/belotErrorIsolationHarness.html?ws=${encodeURIComponent(`ws://127.0.0.1:${port}`)}`)
  await page.waitForFunction(() => (window as any).__errorIsolationHarness?.ready === true)
  const h = harness(page)
  try {
    await waitFor('ръката е активна', () => h.activeHandCardIds(), (ids: string[]) => ids.length > 0, 10_000)

    /** Изиграва карта, която сървърът задържа -> чакаща в клиента. */
    const playPendingCard = async (): Promise<string> => {
      const ids: string[] = await waitFor('активна карта', () => h.activeHandCardIds(), (v: string[]) => v.length > 0)
      const submitsBefore = game.submits.length
      assert(await h.clickCard(ids[0]), 'кликът не мина')
      await waitFor('submit_play_card', async () => game.submits.length, (n) => n === submitsBefore + 1)
      return ids[0]!
    }
    // Чакащата карта: повдигната, а клик върху друга карта НЕ праща втори ход.
    const expectNoResync = async (labelText: string, pending: string): Promise<void> => {
      const before = game.resumeCount
      await wait(700)
      assert(game.resumeCount === before, `${labelText}: resync (resume_room) беше поискан`)
      assert(((await h.cardTransform(pending)) ?? '').includes('translateY'), `${labelText}: чакащата карта вече не е повдигната`)
      const other = ((await h.activeHandCardIds()) as string[]).find((id) => id !== pending)
      const submitsBefore = game.submits.length
      if (other !== undefined) await h.clickCard(other)
      await wait(400)
      assert(game.submits.length === submitsBefore, `${labelText}: изпратен е втори ход — чакащата карта е изгубена`)
    }

    // E1–E3: картата остава чакаща (сървърът не отговаря) през чуждите грешки.
    const pendingCard = await playPendingCard()
    await check(`[${label}][E1] чакаща карта + Ludo грешка -> без resync, картата остава чакаща, текстът не се показва`, async () => {
      game.inject({ type: 'error', code: 'ludo_match_not_found', message: LUDO_TEXT, requestType: 'ludo_game_state_request' })
      await expectNoResync('E1', pendingCard)
      assert(!(await h.bodyText()).includes(LUDO_TEXT), 'Ludo текстът се показа на масата')
    })
    await check(`[${label}][E2] чакаща карта + чужда обща грешка (друга заявка) -> без resync`, async () => {
      game.inject({ type: 'error', message: 'Приятелството вече съществува.', requestType: 'send_friend_request' })
      await expectNoResync('E2', pendingCard)
    })
    await check(`[${label}][E3] чакаща карта + грешка без корелация (requestType: null) -> без resync`, async () => {
      game.inject({ type: 'error', message: 'Invalid message payload.', requestType: null })
      await expectNoResync('E3', pendingCard)
    })
    await check(`[${label}][E4] грешка за submit_play_card -> resync; ръката се отключва с „Ходът не беше приет“`, async () => {
      const before = game.resumeCount
      game.inject({ type: 'error', message: 'Not your turn', requestType: 'submit_play_card' })
      await waitFor('resync', async () => game.resumeCount, (n) => n === before + 1)
      await waitFor('ръката отключена', () => h.activeHandCardIds(), (ids: string[]) => ids.includes(pendingCard))
      const notice = await waitFor('notice', () => h.noticeText(), (t: string | null) => t !== null)
      assert(notice === 'Ходът не беше приет. Опитайте отново.', `notice=${notice}`)
    })
    await check(`[${label}][E5] стар сървър (без requestType) -> досегашното поведение: resync`, async () => {
      await wait(2_800) // предишното съобщение изтича
      await playPendingCard()
      const before = game.resumeCount
      game.inject({ type: 'error', message: 'Not your turn' })
      await waitFor('resync', async () => game.resumeCount, (n) => n === before + 1)
      await waitFor('ръката отключена', () => h.activeHandCardIds(), (ids: string[]) => ids.length > 0)
    })

    // E6–E7: банерът и червеното съобщение при блокиран ход.
    await wait(2_800)
    await check(`[${label}][E6] банер: затворен -> „…се възстановява...“; отворен преди синхронизацията -> „Възстановяване на играта...“; след snapshot -> няма`, async () => {
      await h.drop()
      await waitFor('транспортът е затворен', () => h.isTransportConnected(), (v: boolean) => v === false)
      assert((await h.bannerText()) === RECONNECTING, `затворен: ${await h.bannerText()}`)
      await h.reconnect()
      await waitFor('банер: синхронизация', () => h.bannerText(), (t: string | null) => t === RESYNCING)
      assert(await h.isTransportConnected(), 'транспортът не е отворен')
    })
    await check(`[${label}][E7] червеното съобщение при блокиран ход е под банера (отворен транспорт) — без застъпване`, async () => {
      const ids: string[] = await waitFor('стара ръка', async () => (await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('[data-playing-bottom-hand-host] [data-card-id]')).map((b) => b.dataset.cardId ?? ''))), (v: string[]) => v.length > 0)
      await h.clickCard(ids[0])
      const notice = await waitFor('notice', () => h.noticeText(), (t: string | null) => t !== null)
      assert(notice === 'Изчаква се актуалното състояние на играта. Картата не е изиграна.', `notice=${notice}`)
      const banner = await h.bannerRect()
      const box = await h.noticeRect()
      assert(banner !== null && box !== null, 'няма банер/съобщение')
      assert(box.top >= banner.bottom, `застъпване: банер до ${banner.bottom}, съобщение от ${box.top}`)
    })
    await check(`[${label}][E6b] след room_resumed + авторитетен snapshot банерът изчезва`, async () => {
      await h.resume()
      await waitFor('без банер', () => h.bannerText(), (t: string | null) => t === null)
    })
    await check(`[${label}][E7b] червеното съобщение при затворен транспорт също е под банера`, async () => {
      await wait(2_800)
      await h.drop()
      await waitFor('банер', () => h.bannerText(), (t: string | null) => t === RECONNECTING)
      const ids: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('[data-playing-bottom-hand-host] [data-card-id]')).map((b) => b.dataset.cardId ?? ''))
      await h.clickCard(ids[0])
      const notice = await waitFor('notice', () => h.noticeText(), (t: string | null) => t !== null)
      assert(notice === 'Няма връзка със сървъра. Картата не е изиграна.', `notice=${notice}`)
      const banner = await h.bannerRect()
      const box = await h.noticeRect()
      assert(banner !== null && box !== null && box.top >= banner.bottom, `застъпване: ${JSON.stringify({ banner, box })}`)
      await h.reconnect()
      await waitFor('синхронизация', () => h.bannerText(), (t: string | null) => t === RESYNCING)
      await h.resume()
      await waitFor('без банер', () => h.bannerText(), (t: string | null) => t === null)
    })

    // E8: bidding — червената грешка под банера; Ludo грешка не се показва.
    await check(`[${label}][E8] bidding: червената грешка е под банера; Ludo грешката не се показва; банерът не се дублира в червено`, async () => {
      game.mode = 'bidding'
      game.broadcast()
      await page.waitForSelector('[data-bidding-popup="1"], [data-seat-panel], [data-seat-panels-host="1"]', { timeout: 10_000 }).catch(() => undefined)
      await h.drop()
      await waitFor('банер', () => h.bannerText(), (t: string | null) => t === RECONNECTING)
      assert((await h.biddingErrorText()) === null, `червен блок при прекъсване: ${await h.biddingErrorText()}`)
      await h.reconnect()
      await waitFor('синхронизация', () => h.bannerText(), (t: string | null) => t === RESYNCING)
      game.inject({ type: 'error', code: 'ludo_match_not_found', message: LUDO_TEXT, requestType: 'ludo_game_state_request' })
      await wait(500)
      assert((await h.biddingErrorText()) === null && !(await h.bodyText()).includes(LUDO_TEXT), 'Ludo грешката се показа в bidding')
      game.inject({ type: 'error', message: 'Обща грешка за проба.', requestType: 'send_friend_request' })
      const text = await waitFor('червена грешка', () => h.biddingErrorText(), (t: string | null) => t !== null)
      assert(text === 'Обща грешка за проба.', `text=${text}`)
      const banner = await h.bannerRect()
      const box = await h.biddingErrorRect()
      assert(banner !== null && box !== null && box.top >= banner.bottom, `застъпване: ${JSON.stringify({ banner, box })}`)
      assert(!(text ?? '').includes(RESYNCING) && !(text ?? '').includes(RECONNECTING), 'текстът на банера е в червения блок')
      await h.resume()
      await waitFor('без банер', () => h.bannerText(), (t: string | null) => t === null)
    })

    await check(`[${label}][E9] без JS грешки`, () => {
      assert(errors.length === 0, errors.slice(0, 3).join(' | '))
    })
  } finally {
    await context.close()
    for (const ws of wss.clients) ws.terminate()
    wss.close()
    await new Promise<void>((r) => httpServer.close(() => r()))
  }
}

console.log('\n═══ checkBelotErrorIsolation ═══')
let vite: ViteDevServer | null = null
let browser: Browser | null = null
try {
  const port = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(p))
    })
  })
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()
  const baseUrl = `http://127.0.0.1:${port}`
  await scenario(browser, baseUrl, 'desktop', { width: 1366, height: 820 })
  await scenario(browser, baseUrl, 'phone', { width: 390, height: 844 })
  console.log('\n' + '═'.repeat(64))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}
