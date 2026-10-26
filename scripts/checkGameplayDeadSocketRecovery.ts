/**
 * checkGameplayDeadSocketRecovery.ts
 *
 * Регресия за "Белот замръзва при хвърляне на карта": картата само се
 * повдига, таймерът изтича, нищо не се случва; сървърът и останалите играчи
 * продължават; Refresh връща играча в актуалното състояние.
 *
 * ДОКАЗАНА ПРИЧИНА: полуотворена TCP връзка (мобилна мрежа, Wi-Fi/4G смяна,
 * събуждане от sleep). Браузърният WebSocket остава readyState OPEN без
 * 'close'; send() "успява", но нищо не стига до сървъра и нищо не идва
 * обратно. Нямаше heartbeat (нито клиент, нито сървър). Submit watchdog-ът
 * от b4f2271 стигаше до client.disconnect() -> ws.close(), но при мъртъв път
 * Chromium чака Close frame 60 сек преди 'close' (измерено: 60016 ms), а
 * reconnect-ът чакаше точно това събитие; накрая минаваше през целоекранния
 * offline overlay -> forced lobby reload.
 *
 * Тестът кара РЕАЛНИЯ транспорт/liveness/policy/controller (виж harness-а)
 * срещу реален WS сървър зад TCP proxy, който замразява съществуващата
 * връзка без FIN/RST. Сървърът е протоколно верен минимален Белот playing
 * цикъл: сървърен таймер за ход (изтича -> играе първата валидна карта вместо
 * човека, като реалния bot takeover), ботове, взятки, resume_room ->
 * room_resumed + room_snapshot, ping -> pong.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import net from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(label: string, fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs: number): Promise<{ value: T; elapsedMs: number }> {
  const startedAt = Date.now()
  let last: T = await fn()
  while (!predicate(last)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`${label}: timeout after ${timeoutMs}ms (last=${JSON.stringify(last)})`)
    }
    await wait(100)
    last = await fn()
  }
  return { value: last, elapsedMs: Date.now() - startedAt }
}

// ── Минимален, протоколно верен Белот playing сървър ─────────────────────
type Seat = 'bottom' | 'right' | 'top' | 'left'
type Card = { id: string; suit: 'clubs' | 'diamonds' | 'hearts' | 'spades'; rank: string }
const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']
const HUMAN_TURN_TIMEOUT_MS = 5_000 // частна маса с 5 сек ход (най-краткият вариант)
const BOT_DELAY_MS = 250
const ROOM_ID = 'room-dead-socket'

function makeHand(prefix: string): Card[] {
  const suits: Card['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades']
  const ranks = ['7', '9', 'J', 'A', 'K', '10', 'Q', '8']
  return ranks.map((rank, index) => ({ id: `${prefix}-${suits[index % 4]}-${rank}`, suit: suits[index % 4], rank }))
}

class FakeBelotServer {
  hands: Record<Seat, Card[]> = { bottom: makeHand('b'), right: makeHand('r'), top: makeHand('t'), left: makeHand('l') }
  turn: Seat = 'bottom'
  trick: Array<{ seat: Seat; card: Card }> = []
  completedTricks = 0
  latestCompletedTrick: { trickIndex: number; leaderSeat: Seat; plays: Array<{ seat: Seat; card: Card }>; winnerSeat: Seat } | null = null
  turnDeadlineAt = 0
  turnTimerId: NodeJS.Timeout | null = null
  attached = new Set<WebSocket>()
  humanSubmits: string[] = []
  humanRejected = 0
  serverAutoPlaysForHuman = 0
  resumeCount = 0
  pingCount = 0
  resumeDelayMs = 0

  attach(ws: WebSocket): void {
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { type: string; roomId?: string; cardId?: string }
      if (message.type === 'ping') {
        this.pingCount += 1
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
        return
      }
      if (message.type === 'resume_room') {
        this.resumeCount += 1
        // Реалният сървър attach-ва connection-а и отговаря синхронно; забавянето
        // симулира бавна мрежа/сървър между reconnect-а и авторитетния snapshot.
        const respond = () => {
          this.attached.add(ws)
          ws.send(JSON.stringify({ type: 'room_resumed', roomId: ROOM_ID, seat: 'bottom' }))
          ws.send(JSON.stringify(this.snapshot()))
        }
        if (this.resumeDelayMs > 0) setTimeout(respond, this.resumeDelayMs)
        else respond()
        return
      }
      if (message.type === 'submit_play_card') {
        this.humanSubmits.push(message.cardId ?? '')
        const card = this.hands.bottom.find((candidate) => candidate.id === message.cardId)
        if (this.turn !== 'bottom' || card === undefined) {
          this.humanRejected += 1
          ws.send(JSON.stringify({ type: 'error', message: 'Not your turn' }))
          return
        }
        this.play('bottom', card)
      }
    })
    ws.on('close', () => this.attached.delete(ws))
  }

  start(): void {
    this.beginTurn()
  }

  beginTurn(): void {
    if (this.turnTimerId) clearTimeout(this.turnTimerId)
    if (this.hands[this.turn].length === 0) {
      this.turnDeadlineAt = 0
      this.broadcast()
      return
    }
    if (this.turn === 'bottom') {
      this.turnDeadlineAt = Date.now() + HUMAN_TURN_TIMEOUT_MS
      // Сървърният таймер за ход — при изтичане сървърът играе вместо човека.
      this.turnTimerId = setTimeout(() => {
        this.serverAutoPlaysForHuman += 1
        this.play('bottom', this.hands.bottom[0])
      }, HUMAN_TURN_TIMEOUT_MS)
    } else {
      this.turnDeadlineAt = Date.now() + BOT_DELAY_MS
      const seat = this.turn
      this.turnTimerId = setTimeout(() => this.play(seat, this.hands[seat][0]), BOT_DELAY_MS)
    }
    this.broadcast()
  }

  play(seat: Seat, card: Card): void {
    if (this.turnTimerId) clearTimeout(this.turnTimerId)
    this.turnTimerId = null
    this.hands[seat] = this.hands[seat].filter((candidate) => candidate.id !== card.id)
    this.trick.push({ seat, card })
    if (this.trick.length === 4) {
      // Детерминистичен победител: 'left' -> следващият ход след него е 'bottom'.
      this.latestCompletedTrick = { trickIndex: this.completedTricks, leaderSeat: this.trick[0].seat, plays: this.trick, winnerSeat: 'left' }
      this.completedTricks += 1
      this.trick = []
      this.turn = 'left'
    } else {
      this.turn = SEAT_ORDER[(SEAT_ORDER.indexOf(seat) + 1) % 4]
    }
    this.beginTurn()
  }

  snapshot(): unknown {
    const ownHand = this.hands.bottom
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
        phase: 'playing',
        authoritativePhase: 'playing',
        timerDeadlineAt: this.turnDeadlineAt || null,
        serverNow: Date.now(),
        humanTurnTimeoutMs: HUMAN_TURN_TIMEOUT_MS,
        dealerSeat: 'right',
        firstDealSeat: 'bottom',
        cutting: null,
        bidding: null,
        playing: {
          winningBid: { seat: 'bottom', contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false },
          currentTurnSeat: this.hands[this.turn].length > 0 ? this.turn : null,
          currentTrickPlays: this.trick,
          completedTricksCount: this.completedTricks,
          latestCompletedTrick: this.latestCompletedTrick,
          validCardIds: this.turn === 'bottom' ? ownHand.map((card) => card.id) : null,
          sweepOffer: null,
          sweepResolution: null,
        },
        scoring: null,
        matchEnded: null,
        declarations: [],
        ownDeclarationKeys: [],
        score: { match: { teamA: 0, teamB: 0 } },
        handCounts: { bottom: ownHand.length, right: this.hands.right.length, top: this.hands.top.length, left: this.hands.left.length },
        ownHand,
      },
      isGuestTrial: false,
      isPrivateTableOrigin: true,
      isTournamentMatchOrigin: false,
      stakeAmount: 5000,
    }
  }

  broadcast(): void {
    const payload = JSON.stringify(this.snapshot())
    for (const ws of this.attached) {
      try { ws.send(payload) } catch { /* мъртъв socket — сървърът не знае */ }
    }
  }

  stop(): void {
    if (this.turnTimerId) clearTimeout(this.turnTimerId)
  }
}

// TCP proxy: freezeExisting() спира препращането на ВСИЧКИ текущи връзки (без
// FIN/RST — полуотворена връзка); новите връзки минават нормално.
function createFreezableProxy(targetPort: number) {
  const connections: Array<{ frozen: boolean; thawed: boolean; clientSocket: net.Socket }> = []
  const server = net.createServer((clientSocket) => {
    const state = { frozen: false, thawed: false, clientSocket }
    connections.push(state)
    const upstream = net.connect(targetPort, '127.0.0.1')
    clientSocket.on('data', (data) => { if (!state.frozen) upstream.write(data) })
    upstream.on('data', (data) => { if (!state.frozen) clientSocket.write(data) })
    clientSocket.on('error', () => {})
    upstream.on('error', () => {})
    clientSocket.on('close', () => { if (!state.frozen) upstream.destroy() })
    upstream.on('close', () => { if (!state.frozen) clientSocket.destroy() })
  })
  return {
    server,
    freezeExisting: () => { for (const connection of connections) connection.frozen = true },
    // "Мъртвата" връзка внезапно оживява: закъснелите сървърни snapshot-и
    // стигат до изоставения browser socket.
    thawFrozen: () => {
      for (const connection of connections) {
        if (connection.frozen) { connection.frozen = false; connection.thawed = true }
      }
    },
    // ...и после TCP RST — browser-ът праща 'error'/'close' на изоставения socket.
    resetThawed: () => {
      for (const connection of connections) {
        if (connection.thawed) connection.clientSocket.resetAndDestroy()
      }
    },
    connectionCount: () => connections.length,
    destroyAll: () => {
      for (const connection of connections) connection.clientSocket.destroy()
    },
  }
}

type H = {
  handCardIds: () => Promise<string[]>
  activeHandCardIds: () => Promise<string[]>
  clickCard: (cardId: string) => Promise<boolean>
  cardTransform: (cardId: string) => Promise<string | null>
  tableCardIds: () => Promise<string[]>
  bannerText: () => Promise<string | null>
  noticeText: () => Promise<string | null>
  isTransportConnected: () => Promise<boolean>
  openCount: () => Promise<number>
  recoverCalls: () => Promise<string[]>
  unexpectedCloseDecisions: () => Promise<number>
  log: () => Promise<string[]>
}

function harness(page: Page): H {
  const call = (name: string, ...args: unknown[]) =>
    page.evaluate(([n, a]: any) => (window as any).__deadSocketHarness[n](...a), [name, args] as any)
  return {
    handCardIds: () => call('handCardIds') as Promise<string[]>,
    activeHandCardIds: () => call('activeHandCardIds') as Promise<string[]>,
    clickCard: (cardId) => call('clickCard', cardId) as Promise<boolean>,
    cardTransform: (cardId) => call('cardTransform', cardId) as Promise<string | null>,
    tableCardIds: () => call('tableCardIds') as Promise<string[]>,
    bannerText: () => call('bannerText') as Promise<string | null>,
    noticeText: () => call('noticeText') as Promise<string | null>,
    isTransportConnected: () => call('isTransportConnected') as Promise<boolean>,
    openCount: () => call('openCount') as Promise<number>,
    recoverCalls: () => call('recoverCalls') as Promise<string[]>,
    unexpectedCloseDecisions: () => call('unexpectedCloseDecisions') as Promise<number>,
    log: () => call('log') as Promise<string[]>,
  }
}

// Горна граница за възстановяване: watchdog (1.5 сек при 5 сек ход) + resync
// timeout (5 сек) + reconnect (1 сек) + resume; liveness: 6 сек тишина + 5
// сек pong timeout + tick. Старият път (close handshake) — ≥ 60 сек.
const RECOVERY_BOUND_MS = 15_000

async function runScenario(browser: Browser, viteBaseUrl: string, label: string, viewport: { width: number; height: number }): Promise<void> {
  console.log(`\n── ${label} (${viewport.width}x${viewport.height}) ──`)
  const httpServer: HttpServer = createHttpServer()
  const wss = new WebSocketServer({ server: httpServer })
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()))
  const gamePort = (httpServer.address() as net.AddressInfo).port
  const game = new FakeBelotServer()
  wss.on('connection', (ws) => game.attach(ws))
  const proxy = createFreezableProxy(gamePort)
  await new Promise<void>((r) => proxy.server.listen(0, '127.0.0.1', () => r()))
  const proxyPort = (proxy.server.address() as net.AddressInfo).port

  const context = await browser.newContext({ baseURL: viteBaseUrl, viewport })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  await page.goto(`/scripts/fixtures/gameplayDeadSocketRecoveryHarness.html?ws=${encodeURIComponent(`ws://127.0.0.1:${proxyPort}`)}`)
  await page.waitForFunction(() => (window as any).__deadSocketHarness?.ready === true)
  const h = harness(page)

  try {
    await check(`[${label}][1] нормално изиграване: картата отива на масата, без resync/reconnect`, async () => {
      // Ходовият таймер на сървъра тръгва едва след входната (deal) презентация.
      await waitFor('ръката е показана', () => h.handCardIds(), (ids) => ids.length === 8, 15_000)
      await wait(3_000)
      game.start()
      const { value: active } = await waitFor('ръката става активна', () => h.activeHandCardIds(), (ids) => ids.length === 8, 15_000)
      const cardId = active[0]
      assert(await h.clickCard(cardId), 'кликът не мина')
      await waitFor('картата е на масата', () => h.tableCardIds(), (ids) => ids.includes(`bottom:${cardId}`), 5_000)
      assert(!(await h.handCardIds()).includes(cardId), 'картата е още в ръката')
      assert(game.humanSubmits.length === 1, `сървърът получи ${game.humanSubmits.length} хода`)
      assert((await h.recoverCalls()).length === 0, 'неочакван recover при нормална игра')
    })

    await check(`[${label}][2] мъртва връзка по време на хода: tap -> повдигане -> възстановяване без Refresh за < ${RECOVERY_BOUND_MS / 1000} сек`, async () => {
      // Изчакай следващия наш ход (3 бота + прибиране на взятката).
      await waitFor('отново наш ход', () => h.activeHandCardIds(), (ids) => ids.length === 7, 15_000)
      const autoPlaysBefore = game.serverAutoPlaysForHuman
      const submitsBefore = game.humanSubmits.length
      const handBefore = await h.handCardIds()
      proxy.freezeExisting()
      const cardId = (await h.activeHandCardIds())[0]
      const tappedAt = Date.now()
      assert(await h.clickCard(cardId), 'кликът не мина')
      assert(((await h.cardTransform(cardId)) ?? '').includes('translateY'), 'натиснатата карта не е повдигната (pending)')
      assert(await h.isTransportConnected(), 'очакван "жив" OPEN socket след замразяването (полуотворена връзка)')

      // Сървърът не получава нищо; ходът му изтича и играе вместо човека.
      await waitFor('сървърът играе вместо човека', async () => game.serverAutoPlaysForHuman, (n) => n === autoPlaysBefore + 1, 10_000)
      assert(game.humanSubmits.length === submitsBefore, 'картата НЕ трябва да стига до сървъра през мъртвата връзка')

      // Клиентът сам засича мъртвата връзка и показва видимо състояние.
      await waitFor('банер за възстановяване', () => h.bannerText(), (text) => text !== null, RECOVERY_BOUND_MS)
      const { elapsedMs } = await waitFor(
        'UI показва авторитетното състояние',
        async () => ({ hand: await h.handCardIds(), banner: await h.bannerText() }),
        (state) => state.hand.length === handBefore.length - 1 && state.banner === null,
        RECOVERY_BOUND_MS,
      )
      const recoveredAfterMs = Date.now() - tappedAt
      void elapsedMs
      assert(recoveredAfterMs < RECOVERY_BOUND_MS, `възстановяването отне ${recoveredAfterMs}ms`)
      assert((await h.recoverCalls()).includes('submit_watchdog'), `очакван recover от submit watchdog-а, има ${JSON.stringify(await h.recoverCalls())}`)
      assert((await h.unexpectedCloseDecisions()) === 0, 'reconnect мина през offline/reload пътя')
      assert(game.resumeCount >= 2, 'няма resume_room след reconnect')
      console.log(`        (възстановено ${recoveredAfterMs}ms след tap-а)`)
    })

    await check(`[${label}][3] без двойно изиграване: сървърът е изиграл точно една карта за хода`, async () => {
      const playedByBottom = 8 - game.hands.bottom.length
      assert(playedByBottom === 2, `bottom е изиграл ${playedByBottom} карти, очаквани 2`)
      assert(game.humanRejected === 0, `сървърът отхвърли ${game.humanRejected} хода`)
    })

    await check(`[${label}][4] играта продължава без Refresh: следващата карта се играе нормално`, async () => {
      const { value: active } = await waitFor('отново наш ход', () => h.activeHandCardIds(), (ids) => ids.length === 6, 15_000)
      const submitsBefore = game.humanSubmits.length
      assert(await h.clickCard(active[0]), 'кликът не мина')
      await waitFor('картата е на масата', () => h.tableCardIds(), (ids) => ids.includes(`bottom:${active[0]}`), 5_000)
      assert(game.humanSubmits.length === submitsBefore + 1, 'ходът не стигна до сървъра')
    })

    await check(`[${label}][5] мъртва връзка докато чакаме (без tap): liveness я засича и UI наваксва`, async () => {
      await waitFor('след нашия ход', () => h.activeHandCardIds(), (ids) => ids.length === 0, 5_000)
      const recoverBefore = (await h.recoverCalls()).length
      const pingsBefore = game.pingCount
      const autoPlaysBefore = game.serverAutoPlaysForHuman
      const frozenAt = Date.now()
      proxy.freezeExisting()
      // Сървърът продължава: ботове, после нашият ход изтича -> сървърът играе за нас.
      await waitFor('сървърът наваксва без клиента', async () => game.serverAutoPlaysForHuman, (n) => n === autoPlaysBefore + 1, 15_000)
      const staleHand = await h.handCardIds()
      assert(staleHand.length === game.hands.bottom.length + 1, 'клиентът трябва още да показва старата ръка (замразена връзка)')
      // Клиентът сам засича тишината (ping без pong) — без tap, без Refresh.
      await waitFor('liveness recover', () => h.recoverCalls(), (calls) => calls.length === recoverBefore + 1, RECOVERY_BOUND_MS)
      const calls = await h.recoverCalls()
      assert(calls[calls.length - 1] === 'liveness_timeout', `очакван liveness recover, има ${JSON.stringify(calls)}`)
      await waitFor(
        'клиентът сам показва актуалната ръка',
        () => h.handCardIds(),
        (ids) => ids.length === game.hands.bottom.length,
        5_000,
      )
      // Пингът е изпратен в мъртвата връзка — сървърът не го е получил.
      assert(game.pingCount === pingsBefore, 'пинг през замразената връзка не трябва да стига до сървъра')
      console.log(`        (наваксано ${Date.now() - frozenAt}ms след замразяването, без действие от играча)`)
      await waitFor('банерът изчезва', () => h.bannerText(), (text) => text === null, 3_000)
      assert((await h.unexpectedCloseDecisions()) === 0, 'reconnect мина през offline/reload пътя')
    })

    await check(`[${label}][5b] закъснели message/error/close от изоставените socket-и се игнорират`, async () => {
      const opensBefore = await h.openCount()
      const recoverBefore = (await h.recoverCalls()).length
      // Сървърът още държи старите връзки attach-нати и им праща snapshot-и.
      proxy.thawFrozen()
      await wait(1_500)
      proxy.resetThawed() // TCP RST -> 'error' + 'close' на изоставените socket-и
      await wait(1_500)
      assert((await h.openCount()) === opensBefore, 'закъснялото събитие предизвика нов reconnect')
      assert((await h.recoverCalls()).length === recoverBefore, 'закъснялото събитие предизвика recovery')
      assert((await h.unexpectedCloseDecisions()) === 0, 'close на изоставен socket стигна до onClose')
      assert(await h.isTransportConnected(), 'живата връзка е засегната')
      assert((await h.bannerText()) === null, 'банерът се появи от изоставен socket')
      await waitFor('ръката следва живата връзка', () => h.handCardIds(), (ids) => ids.length === game.hands.bottom.length, 5_000)
    })

    await check(`[${label}][6] жива, но тиха връзка (13 сек без snapshot): само ping/pong, без reconnect`, async () => {
      const recoverBefore = (await h.recoverCalls()).length
      const pingsBefore = game.pingCount
      const opensBefore = await h.openCount()
      game.stop() // сървърът мълчи (напр. бавен човек на ход), връзката е жива
      await wait(13_000) // > 6 сек тишина + 5 сек pong timeout
      assert(game.pingCount > pingsBefore, 'liveness не е пингнал при тишина')
      assert((await h.recoverCalls()).length === recoverBefore, `неочакван recover при жива връзка: ${JSON.stringify(await h.recoverCalls())}`)
      assert((await h.openCount()) === opensBefore, 'неочакван reconnect при жива връзка')
      game.beginTurn()
    })

    await check(`[${label}][7] след reconnect, преди авторитетния snapshot: ръката не изпраща ход, банерът стои`, async () => {
      await waitFor('наш ход', () => h.activeHandCardIds(), (ids) => ids.length > 0, 15_000)
      const submitsBefore = game.humanSubmits.length
      const opensBefore = await h.openCount()
      game.resumeDelayMs = 2_500
      proxy.freezeExisting()
      assert(await h.clickCard((await h.activeHandCardIds())[0]), 'първият клик не мина')
      // watchdog -> resync -> abandon -> reconnect; resume отговорът закъснява.
      await waitFor('reconnect', () => h.openCount(), (count) => count === opensBefore + 1, RECOVERY_BOUND_MS)
      assert((await h.bannerText()) !== null, 'банерът изчезна преди авторитетния snapshot')
      const staleActive = await h.activeHandCardIds()
      assert(staleActive.length > 0, 'очаквана стара "твой ред" ръка в прозореца преди snapshot-а')
      await h.clickCard(staleActive[0])
      await wait(500)
      assert(game.humanSubmits.length === submitsBefore, `ход изпратен преди авторитетния snapshot (${game.humanSubmits.length - submitsBefore})`)
      assert(((await h.noticeText()) ?? '').includes('Изчаква се'), `очаквано обяснение, има ${await h.noticeText()}`)
      await waitFor('банерът изчезва след snapshot-а', () => h.bannerText(), (text) => text === null, 5_000)
      game.resumeDelayMs = 0
      assert(game.humanRejected === 0, `сървърът отхвърли ${game.humanRejected} хода`)
      // След авторитетния snapshot играта продължава нормално.
      const { value: active } = await waitFor('отново наш ход', () => h.activeHandCardIds(), (ids) => ids.length > 0, 15_000)
      assert(await h.clickCard(active[0]), 'клик след възстановяването не мина')
      await waitFor('ходът е приет', async () => game.humanSubmits.length, (n) => n === submitsBefore + 1, 5_000)
      assert(game.humanRejected === 0, 'ходът след възстановяването е отхвърлен')
    })

    await check(`[${label}] няма JS грешки`, () => {
      assert(errors.length === 0, `page errors: ${errors.join('; ')}`)
    })
  } finally {
    game.stop()
    await context.close()
    // Замразените връзки никога не се затварят сами — иначе държат процеса жив.
    proxy.destroyAll()
    for (const ws of wss.clients) ws.terminate()
    proxy.server.close()
    wss.close()
    httpServer.close()
  }
}

console.log('\n═══ checkGameplayDeadSocketRecovery ═══')

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
  await runScenario(browser, baseUrl, 'desktop', { width: 1366, height: 820 })
  await runScenario(browser, baseUrl, 'phone', { width: 390, height: 844 })
  console.log('\n' + '═'.repeat(64))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}
