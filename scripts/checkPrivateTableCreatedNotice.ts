/**
 * Общото известие „[Никнейм] създаде маса за [Игра].“ — целеви проверки.
 *
 *  [A] Сървърен нотификатор (privateTableCreatedNotice.ts): Белот/Свара/Човече,
 *      без създателя, ограничен достъп (Свара), грешка в проверката → не,
 *      без дублиране за едно създаване, примерна бъдеща игра без промяна в кода.
 *  [B] Истинското лоби на „Свара“: известие само след успешно създаване, не
 *      при отказано, не при reconnect/повторна заявка; достъп по роля.
 *  [C] Интеграционни точки в index.ts (Белот/Човече/Свара — само при успех).
 *  [D] Истинският попъп в Chromium: име и цвят за всяка игра, „Виж“ → навигацията
 *      от регистъра (без присъединяване), „✕“ затваря, без дублиране,
 *      непозната/изключена игра не се показва, бъдеща игра — само нов запис.
 *
 * Пускане: npx tsx scripts/checkPrivateTableCreatedNotice.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { createPrivateTableCreatedNotifier, type PrivateTableCreatedNoticeMessage } from '../server/src/notifications/privateTableCreatedNotice'
import { createSvaraLobby } from '../server/src/games/svara/createSvaraLobby'
import { createSvaraMatchRuntime } from '../server/src/games/svara/runtime/svaraMatchRuntime'
import type { SvaraAccessSession } from '../server/src/games/svara/svaraAccess'

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) { passed++; console.log(`  PASS  ${name}`) } else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── [A] Сървърен нотификатор ─────────────────────────────────────────────────
console.log('\n[A] Сървърен нотификатор')
{
  const recipients = [
    { connectionId: 'c-creator-1', profileId: 'creator' },
    { connectionId: 'c-creator-2', profileId: 'creator' },
    { connectionId: 'c-admin', profileId: 'admin' },
    { connectionId: 'c-user', profileId: 'user' },
    { connectionId: 'c-broken', profileId: 'broken' },
  ]
  const sent: Array<{ connectionId: string; message: PrivateTableCreatedNoticeMessage }> = []
  const errors: unknown[] = []
  const svaraAccess = new Set(['c-admin', 'c-creator-1', 'c-creator-2'])
  const notifier = createPrivateTableCreatedNotifier({
    games: {
      belot: {},
      ludo: {},
      svara: { canReceive: (r) => { if (r.connectionId === 'c-broken') throw new Error('session read failed'); return svaraAccess.has(r.connectionId) } },
    },
    listRecipients: () => recipients,
    isInActiveGame: (profileId) => profileId === 'user',
    send: (connectionId, message) => sent.push({ connectionId, message }),
    onError: (cause) => errors.push(cause),
  })
  const creator = { creatorProfileId: 'creator', creatorDisplayName: 'Иван', creatorAvatarUrl: null }
  const to = (gameId: string) => sent.filter((s) => s.message.gameId === gameId).map((s) => s.connectionId).sort().join(',')

  notifier.notify({ gameId: 'belot', tableId: 'room-1', ...creator })
  check('Белот: всички влезли без създателя (всичките му връзки)', to('belot') === 'c-admin,c-broken,c-user', to('belot'))
  const belotMsg = sent.find((s) => s.message.gameId === 'belot')!.message
  check('Белот: notificationId = gameId:tableId, без маршрут/чувствителни полета', belotMsg.notificationId === 'belot:room-1'
    && JSON.stringify(Object.keys(belotMsg).sort()) === JSON.stringify(['creatorAvatarUrl', 'creatorDisplayName', 'gameId', 'notificationId', 'recipientInActiveGame', 'type']))
  check('recipientInActiveGame — за всеки получател поотделно', sent.find((s) => s.connectionId === 'c-user')!.message.recipientInActiveGame === true
    && sent.find((s) => s.connectionId === 'c-admin')!.message.recipientInActiveGame === false)

  notifier.notify({ gameId: 'ludo', tableId: 'ludo-1', ...creator })
  check('Човече: всички влезли без създателя', to('ludo') === 'c-admin,c-broken,c-user', to('ludo'))

  notifier.notify({ gameId: 'svara', tableId: 'svara-1', ...creator })
  check('Свара: само получатели със сървърен достъп (тестов режим)', to('svara') === 'c-admin', to('svara'))
  check('Свара: грешка при проверката на достъпа → без известие (fail closed), логната', !to('svara').includes('c-broken') && errors.length === 1)

  const before = sent.length
  check('без дублиране: повторно notify за същото създаване → 0', notifier.notify({ gameId: 'belot', tableId: 'room-1', ...creator }) === 0 && sent.length === before)
  check('същата маса в друга игра е отделно известие', notifier.notify({ gameId: 'ludo', tableId: 'room-1', ...creator }) === 3)
  check('непозната игра → нищо', (notifier.notify as (input: unknown) => number)({ gameId: 'chess', tableId: 'x', ...creator }) === 0)

  // Примерна бъдеща игра: само запис в games — нотификаторът не се променя.
  const futureSent: PrivateTableCreatedNoticeMessage[] = []
  const future = createPrivateTableCreatedNotifier({
    games: { belot: {}, darts: { canReceive: (r) => r.profileId !== 'user' } },
    listRecipients: () => recipients,
    isInActiveGame: () => false,
    send: (_c, message) => futureSent.push(message),
  })
  future.notify({ gameId: 'darts', tableId: 'd-1', ...creator })
  check('бъдеща игра „darts“: регистрирана с един запис, доставката работи (с ограничение)', futureSent.length === 2 && futureSent.every((m) => m.gameId === 'darts' && m.notificationId === 'darts:d-1'))
}

// ── [B] Истинското лоби на „Свара“ ───────────────────────────────────────────
console.log('\n[B] Лобито на „Свара“: събитие само при успешно създаване, достъп по роля')
{
  process.env.SVARA_TEST_ENABLED = '1'
  const created: Array<{ matchId: string; creatorProfileId: string }> = []
  const lobby = createSvaraLobby({ runtime: createSvaraMatchRuntime(), hasOtherGameCommitment: (id) => id === 'busy', onPrivateTableCreated: (input) => created.push(input) })
  lobby.initializeRecovery()
  const frames = new Map<string, any[]>()
  const attach = (connectionId: string, profileId: string, role: string) => {
    const session = { account: { role }, profile: { profileId } } as SvaraAccessSession
    frames.set(connectionId, [])
    lobby.attachConnection(connectionId, { profileId, getSession: () => session, send: (f) => frames.get(connectionId)!.push(typeof f === 'string' ? JSON.parse(f) : f) })
  }
  attach('a', 'admin-1', 'admin')
  attach('u', 'user-1', 'user')
  attach('b', 'busy', 'admin')
  check('достъп: админ (тестова роля) — да; обикновен потребител — не', lobby.canConnectionAccess('a') && !lobby.canConnectionAccess('u'))
  check('непозната връзка — не', !lobby.canConnectionAccess('nobody'))
  const create = (id: string, entryFee = 5_000) => lobby.handle(id, { type: 'create_svara_table', requestId: randomUUID(), capacity: 2, entryFee, entryPercent: 1, startMode: 'auto' } as never)
  create('b')
  check('отказано създаване (друг игрови ангажимент) → без събитие', created.length === 0)
  create('a', 1)
  check('отказано създаване (невалиден вход) → без събитие', created.length === 0)
  create('u')
  check('отказано създаване (без достъп) → без събитие', created.length === 0)
  create('a')
  const table = frames.get('a')!.find((f) => f.type === 'svara_table_updated')?.table
  check('успешно създаване → точно едно събитие с matchId и създателя', created.length === 1 && created[0]!.matchId === table?.matchId && created[0]!.creatorProfileId === 'admin-1', JSON.stringify(created))
  lobby.reconnect('a')
  lobby.handle('a', { type: 'request_svara_table_state', matchId: table.matchId } as never)
  lobby.handle('a', { type: 'request_svara_tables_list' } as never)
  check('reconnect / refresh / повторна заявка → без ново събитие', created.length === 1)
  lobby.shutdown()
}

// ── [C] Интеграционни точки в index.ts ───────────────────────────────────────
console.log('\n[C] Интеграционни точки (index.ts)')
{
  const src = readFileSync(resolve('server/src/index.ts'), 'utf8').replace(/\r\n/g, '\n')
  const block = (start: string, end: string) => { const a = src.indexOf(start); const b = src.indexOf(end, a); assert(a >= 0 && b > a, start); return src.slice(a, b) }
  const belot = block(`if (message.type === 'create_private_room') {`, `if (message.type === 'join_private_room') {`)
  check('Белот: известие след успешното създаване, един път', belot.indexOf("notifyPrivateTableCreated('belot', createResult.room.id") > belot.indexOf('if (!createResult.ok) {')
    && (src.match(/notifyPrivateTableCreated\('belot'/g) ?? []).length === 1)
  const ludo = block(`if (message.type === 'create_ludo_room') {`, `if (message.type === 'join_ludo_room') {`)
  check('Човече: известие само в клона за успех, един път', /else \{\s*safeSendToConnection\(connection\.id, \{ type: 'ludo_room_updated'[^\n]*\n\s*notifyPrivateTableCreated\('ludo', result\.room\.id/.test(ludo)
    && (src.match(/notifyPrivateTableCreated\('ludo'/g) ?? []).length === 1)
  check('Свара: през onPrivateTableCreated на лобито; достъпът — svaraLobby.canConnectionAccess', src.includes("onPrivateTableCreated: ({ matchId, creatorProfileId }) => notifyPrivateTableCreated('svara', matchId, creatorProfileId)")
    && src.includes('svara: { canReceive: (recipient) => svaraLobby.canConnectionAccess(recipient.connectionId) }'))
  check('старата Белот-специфична функция е премахната (една система)', !src.includes('broadcastPrivateRoomCreatedNotice'))
}

// ── [D] Истинският попъп (Chromium) ──────────────────────────────────────────
console.log('\n[D] Попъпът')
const vite = await createServer({
  configFile: false, root: resolve('.'), logLevel: 'error',
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{ name: 'private-table-notice-qa', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== '/__private_table_notice_qa') return next()
      res.setHeader('Content-Type', 'text/html')
      res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="host"></div>')
    })
  } }],
})
await vite.listen()
const address = vite.httpServer!.address()
assert(address && typeof address !== 'string')
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } })
    await page.addInitScript('globalThis.__name = (target) => target')
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/__private_table_notice_qa`)
    const results = await page.evaluate(async () => {
      const { createPrivateRoomCreatedNotification } = await import('/src/ui/notifications/privateRoomCreatedNotification.ts' as string)
      const { PRIVATE_TABLE_NOTICE_GAMES, findPrivateTableNoticeGame } = await import('/src/ui/notifications/privateTableNoticeGames.ts' as string)
      const { __setLudoFeatureFlagOverrideForTests } = await import('/src/app/games/ludo/ludoFeatureFlag.ts' as string)
      const out: Array<[string, boolean, string?]> = []
      const ok = (name: string, condition: boolean, detail?: string) => out.push([name, condition, detail])
      const host = document.querySelector<HTMLElement>('#host')!
      const calls: string[] = []
      // Фалшиво лоби: само навигационните методи (никакво присъединяване/старт).
      const lobby = { navigateToPrivateRooms: () => calls.push('belot-list'), navigateToSvaraTables: () => calls.push('svara-list'), navigateToLudoLobby: () => calls.push('ludo-list') }
      const opened: string[] = []
      const widget = createPrivateRoomCreatedNotification({
        container: host, isInActiveGame: () => false, areInGameNotificationsEnabled: () => true, isSoundEnabled: () => false,
        onDisableInGameNotifications: () => {},
        // Същото като main.ts: навигация само от регистъра за gameId.
        onOpenTables: (notice: any) => { opened.push(notice.game.id); findPrivateTableNoticeGame(notice.game.id)?.openTables(lobby) },
      })
      __setLudoFeatureFlagOverrideForTests(true)
      const incoming = (gameId: string, id: string, games = PRIVATE_TABLE_NOTICE_GAMES) => {
        const game = findPrivateTableNoticeGame(gameId, games)
        if (!game) return false
        widget.handleIncoming({ notificationId: `${gameId}:${id}`, game: { id: game.id, name: game.name, color: game.color, lightColor: game.lightColor }, creatorDisplayName: 'Мария<b>', creatorAvatarUrl: null, recipientInActiveGame: false })
        return true
      }
      const card = () => host.querySelector<HTMLElement>('.private-room-created-card')
      const gameSpan = () => host.querySelector<HTMLElement>('[data-private-room-created-game]')
      const expected: Record<string, { name: string; color: string; list: string }> = {
        belot: { name: 'Белот', color: 'rgb(240, 192, 64)', list: 'belot-list' },
        svara: { name: 'Свара', color: 'rgb(74, 222, 128)', list: 'svara-list' },
        ludo: { name: 'Човече', color: 'rgb(192, 132, 252)', list: 'ludo-list' },
      }
      for (const [gameId, want] of Object.entries(expected)) {
        calls.length = 0
        incoming(gameId, 't1')
        const text = card()?.innerText.replace(/\s+/g, ' ') ?? ''
        const span = gameSpan()
        const body = span?.parentElement
        const style = span ? getComputedStyle(span) : null
        const bodyStyle = body ? getComputedStyle(body) : null
        ok(`${gameId}: текст „Мария<b> … създаде маса за ${want.name}. Присъедини се, ако искаш.“ (името е escape-нато)`, text.includes('Мария<b>') && text.includes(`създаде маса за ${want.name}. Присъедини се, ако искаш.`), text)
        ok(`${gameId}: само името на играта е в цвета ѝ, удебелено и по-голямо`, style?.color === want.color && Number(style?.fontWeight) >= 800
          && Number.parseFloat(style!.fontSize) > Number.parseFloat(bodyStyle!.fontSize) && bodyStyle?.color !== want.color, `${style?.color} ${style?.fontWeight} ${style?.fontSize}/${bodyStyle?.fontSize}`)
        const view = host.querySelector<HTMLButtonElement>('#private-room-created-enter-btn')
        ok(`${gameId}: бутон „Виж“ и „✕“`, view?.textContent?.trim() === 'Виж' && host.querySelector('#private-room-created-close-btn') !== null)
        view?.click()
        ok(`${gameId}: „Виж“ → само списъкът с масите на играта; попъпът се затваря`, JSON.stringify(calls) === JSON.stringify([want.list]) && card() === null, JSON.stringify(calls))
      }
      // ✕ затваря, без навигация.
      calls.length = 0
      incoming('belot', 't2')
      host.querySelector<HTMLButtonElement>('#private-room-created-close-btn')!.click()
      ok('„✕“ затваря известието без навигация', card() === null && calls.length === 0)
      // Без дублиране (reconnect/повторна доставка на същото събитие).
      incoming('svara', 't1')
      ok('повторна доставка на същото създаване → не се показва отново', card() === null)
      // Непозната / изключена игра.
      ok('непозната игра (маршрут не се приема от сървъра) → без известие', incoming('chess', 'x') === false && card() === null)
      __setLudoFeatureFlagOverrideForTests(false)
      ok('изключена игра (Човече без флага) → без известие', incoming('ludo', 't9') === false && card() === null)
      // Примерна бъдеща игра: само нов запис в регистъра; попъпът и обработчикът — същите.
      calls.length = 0
      const futureGames = [...PRIVATE_TABLE_NOTICE_GAMES, { id: 'darts', name: 'Дартс', color: '#38bdf8', lightColor: '#0369A1', openTables: () => calls.push('darts-list') }]
      incoming('darts', 'd1', futureGames)
      const futureColor = gameSpan() ? getComputedStyle(gameSpan()!).color : ''
      const futureText = card()?.innerText.replace(/\s+/g, ' ') ?? ''
      futureGames.find((g) => g.id === 'darts')!.openTables(lobby as never)
      ok('бъдеща игра „Дартс“: името, цветът и „Виж“ идват само от новия запис', futureText.includes('създаде маса за Дартс.') && futureColor === 'rgb(56, 189, 248)' && calls.includes('darts-list'), `${futureText} ${futureColor}`)
      ok('регистърът съдържа точно Белот, Свара, Човече', PRIVATE_TABLE_NOTICE_GAMES.map((g: any) => g.id).join() === 'belot,svara,ludo')
      ok('„Виж“ не присъединява и не стартира (само навигационните методи на лобито)', opened.every((id) => ['belot', 'svara', 'ludo'].includes(id)))
      widget.destroy()
      return out
    })
    for (const [name, condition, detail] of results) check(`[${width}px] ${name}`, condition, detail ?? '')
    check(`[${width}px] без грешки в страницата`, pageErrors.length === 0, pageErrors.join('; '))
    await page.close()
  }
} finally {
  await browser.close()
  await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
