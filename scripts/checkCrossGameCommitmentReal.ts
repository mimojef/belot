/**
 * Конфликт с вече съществуващо участие в друга игра — един общ отказ за
 * Белот / Свара / Не се сърди човече (реален backend/WS/SQLite/Chromium).
 *
 * Сървърът връща cross_game_commitment_blocked с местоположението на
 * съществуващото участие; клиентът показва общия попъп „Вече участвате в друга
 * игра.“ с „Затвори“ и „Виж“ (отваря правилната игра и маса).
 *
 *   [1] Чакаща маса в Човече → „+“ на маса в Свара (реалният случай).
 *   [2] Чакаща маса в Свара → създаване на маса в Белот и в Човече.
 *   [3] Започнал мач в Свара → създаване на маса в Белот → „Виж“ = игровият екран.
 *   [4] Чакаща маса в Белот → „+“ на маса в Свара.
 * Навсякъде: без двойно участие, първата маса остава, без промяна в жълтиците,
 * без повторни опити и без „+“, който остава да чака.
 *
 *   --skip-build   без tsc/vite build
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { createIsolatedSvaraRoot, runNode, startIsolatedSvaraBackend, startSvaraGateway, waitForHarnessCondition as wait } from './svaraRealIntegrationHarness'

const root = process.cwd(), host = 'svara-integration.localhost'
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
type Frame = Record<string, any>
type Peer = { name: string; id: string; context: BrowserContext; page: Page; frames: Frame[]; sent: Frame[]; faults: string[] }

console.log('Cross-game commitment conflict — real backend/WS/SQLite/Chromium')
if (!process.argv.includes('--skip-build')) {
  await runNode(root, ['node_modules/typescript/bin/tsc', '-p', 'server/tsconfig.json'])
  await runNode(root, ['node_modules/vite/bin/vite.js', 'build'])
}

const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1', '--no-proxy-server'] })
const isolated = await createIsolatedSvaraRoot(root)
let backend: Awaited<ReturnType<typeof startIsolatedSvaraBackend>> | undefined
let gateway: Awaited<ReturnType<typeof startSvaraGateway>> | undefined
let origin = ''
const peers: Peer[] = []
let passed = 0
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`) }

const db = <T>(fn: (value: DatabaseSync) => T) => {
  const value = new DatabaseSync(isolated.dbFile)
  try { return fn(value) } finally { value.close() }
}
const wallet = (p: Peer) => db((d) => (d.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(p.id) as { b: number } | undefined)?.b ?? 0)

async function addPeer(name: string): Promise<Peer> {
  const email = `cross-game-${randomUUID()}@example.test`
  const response = await fetch(`http://127.0.0.1:${backend!.port}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'CrossGame1!', displayName: `CG${randomUUID().slice(0, 8)}`, gender: 'male', visitorId: randomUUID() }) })
  assert.equal(response.status, 200)
  const body = await response.json() as { session: { profile: { profileId: string } } }
  const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!, id = body.session.profile.profileId
  db((d) => d.prepare("UPDATE accounts SET role='admin' WHERE email=?").run(email))
  db((d) => d.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 100000)
    ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = 100000`).run(id))
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } })
  const separator = cookie.indexOf('=')
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }])
  await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  await context.addInitScript(`globalThis.__name = (target) => target; globalThis.__svaraSockets = [];
    const Native = WebSocket;
    globalThis.WebSocket = new Proxy(Native, { construct(target, args) { const socket = new target(...args); globalThis.__svaraSockets.push(socket); return socket } });`)
  const page = await context.newPage(), peer: Peer = { name, id, context, page, frames: [], sent: [], faults: [] }
  page.on('pageerror', (e) => peer.faults.push(e.message))
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => { try { peer.frames.push(JSON.parse(String(payload))) } catch { /* binary */ } })
    socket.on('framesent', ({ payload }) => { try { peer.sent.push(JSON.parse(String(payload))) } catch { /* binary */ } })
  })
  peers.push(peer)
  return peer
}

const path = (p: Peer) => new URL(p.page.url()).pathname
async function open(p: Peer, url: string) {
  const offset = p.frames.length
  await p.page.goto(`${origin}${url}`, { waitUntil: 'domcontentloaded' })
  await wait(`${p.name} connected`, () => p.frames.slice(offset).some((f) => f.type === 'connected'), 15_000)
  await p.page.getByText('Приеми всички').click({ timeout: 1500 }).catch(() => {})
  await pause(800)
}
async function send(p: Peer, message: Record<string, unknown>) {
  await p.page.evaluate((frame) => {
    const sockets = (globalThis as unknown as { __svaraSockets: WebSocket[] }).__svaraSockets.filter((s) => s.readyState === WebSocket.OPEN)
    sockets[sockets.length - 1]!.send(JSON.stringify(frame))
  }, message)
}
async function createSvara(p: Peer, capacity: 2 | 3 | 4 = 3): Promise<string> {
  const requestId = randomUUID(), offset = p.frames.length
  await send(p, { type: 'create_svara_table', requestId, capacity, entryFee: 5000, entryPercent: 1, startMode: 'auto' })
  await wait(`${p.name} svara table`, () => p.frames.slice(offset).some((f) => f.requestId === requestId), 8_000)
  return p.frames.slice(offset).find((f) => f.requestId === requestId)!.table.matchId
}
const svaraSeats = async (p: Peer, matchId: string) => p.page.locator(`[data-svara-seat-join^="${matchId}:"]`)
const modal = (p: Peer) => p.page.locator('#cross-game-commitment-modal')

/** Изчаква отказа и проверява общия попъп; връща местоположението от сървъра. */
async function expectBlocked(p: Peer, offset: number, label: string): Promise<Frame> {
  await wait(`${label}: refusal`, () => p.frames.slice(offset).some((f) => f.type === 'cross_game_commitment_blocked' || f.type === 'svara_lobby_error' || (f.type === 'error' && f.code)), 8_000)
  const refusal = p.frames.slice(offset).find((f) => f.type === 'cross_game_commitment_blocked' || f.type === 'svara_lobby_error' || (f.type === 'error' && f.code))!
  assert.equal(refusal.type, 'cross_game_commitment_blocked', `${label}: the server refuses with the shared cross-game refusal (got ${refusal.type} ${refusal.code ?? ''})`)
  await modal(p).waitFor({ state: 'visible', timeout: 5_000 })
  const text = (await modal(p).innerText()).replace(/\s+/g, ' ')
  assert(text.includes('Вече участвате в друга игра.') && text.includes('Затвори') && text.includes('Виж'), `${label}: clear popup with Затвори and Виж (got "${text}")`)
  return refusal.location
}
async function clickView(p: Peer) {
  await p.page.click('[data-cross-game-modal-view="1"]')
  await wait('modal closed', async () => await modal(p).count() === 0, 3_000)
}

try {
  backend = await startIsolatedSvaraBackend(isolated)
  gateway = await startSvaraGateway(join(root, 'dist'), () => backend?.port ?? null)
  origin = `http://${host}:${gateway.port}`
  db((d) => d.prepare("UPDATE admin_settings SET setting_value='direct' WHERE setting_key='registration_verification_mode'").run())
  const stake = db((d) => (d.prepare('SELECT stake_amount AS s FROM match_rooms WHERE is_enabled = 1 ORDER BY stake_amount LIMIT 1').get() as { s: number }).s)
  const [a, b, c, d] = [await addPeer('a'), await addPeer('b'), await addPeer('c'), await addPeer('d')] as [Peer, Peer, Peer, Peer]

  // ── [1] Чакаща маса в Човече → „+“ на маса в Свара ─────────────────────────
  {
    await open(a, '/games/ludo')
    const ludoOffset = a.frames.length
    await send(a, { type: 'create_ludo_room', stake, playerCount: 2, manualStart: false })
    await wait('[1] ludo room', () => a.frames.slice(ludoOffset).some((f) => f.type === 'ludo_room_updated'), 8_000)
    const ludoRoomId = a.frames.slice(ludoOffset).find((f) => f.type === 'ludo_room_updated').room.id
    const before = wallet(a)
    await open(b, '/games/svara')
    const matchId = await createSvara(b)
    await open(a, '/games/svara')
    await wait('[1] table listed', async () => await (await svaraSeats(a, matchId)).count() > 0, 10_000)
    const sentBefore = a.sent.filter((f) => f.type === 'join_svara_table').length
    const offset = a.frames.length
    await (await svaraSeats(a, matchId)).first().click()
    const location = await expectBlocked(a, offset, '[1]')
    assert.deepEqual(location, { gameType: 'ludo', kind: 'waiting_room', ludoRoomId }, '[1] location = the Ludo waiting room')
    assert(!a.frames.slice(offset).some((f) => f.type === 'svara_lobby_error'), '[1] no inline Svara error')
    await pause(2_500)
    assert.equal(a.sent.filter((f) => f.type === 'join_svara_table').length, sentBefore + 1, '[1] exactly one join request — no retries')
    assert(await (await svaraSeats(a, matchId)).first().isEnabled(), '[1] the "+" button is released (not left pending)')
    const listed = a.frames.filter((f) => f.type === 'svara_tables_list').at(-1)?.tables.find((t: any) => t.matchId === matchId)
    assert(!listed?.players.some((p: any) => p.playerId === a.id), '[1] not seated in Svara (no double participation)')
    // „Затвори“ затваря; повторен опит → пак само попъпът.
    await a.page.click('[data-cross-game-modal-close="1"]')
    assert.equal(await modal(a).count(), 0, '[1] Затвори closes the popup')
    const offset2 = a.frames.length
    await (await svaraSeats(a, matchId)).first().click()
    await expectBlocked(a, offset2, '[1] second attempt')
    await clickView(a)
    await wait('[1] Виж → Ludo lobby', () => path(a) === '/games/ludo', 5_000)
    await wait('[1] own Ludo room shown', async () => await a.page.locator('[data-ludo-room-leave]').count() > 0, 8_000)
    assert.equal(wallet(a), before, '[1] no coins moved')
    ok('[1] Човече (чакаща) → „+“ в Свара: общ попъп, „Затвори“, „Виж“ → собствената стая в Човече; без двойно участие и повторни опити')
    await send(a, { type: 'leave_ludo_room' })
    await pause(800)
  }

  // ── [2] Чакаща маса в Свара → маса в Белот и в Човече ──────────────────────
  let aSvara = ''
  {
    await open(a, '/games/svara')
    aSvara = await createSvara(a, 2)
    const before = wallet(a)
    for (const [label, message] of [['Белот', { type: 'create_private_room', stake, isLocked: false, waitMinutes: 10, manualStart: false, humanTurnTimeoutMs: 15000, invitePartner: false }],
      ['Човече', { type: 'create_ludo_room', stake, playerCount: 2, manualStart: false }]] as const) {
      await open(a, '/lobby')
      const offset = a.frames.length
      await send(a, message)
      const location = await expectBlocked(a, offset, `[2] ${label}`)
      assert.deepEqual(location, { gameType: 'svara', kind: 'waiting_room', matchId: aSvara }, `[2] ${label}: location = the waiting Svara table`)
      await clickView(a)
      await wait(`[2] ${label}: Виж → Свара`, () => path(a) === '/games/svara', 5_000)
      await wait(`[2] ${label}: own waiting table`, async () => await a.page.locator('[data-svara-table-leave]').count() > 0, 8_000)
      assert(!a.frames.slice(offset).some((f) => f.type === 'private_room_updated' || f.type === 'ludo_room_updated'), `[2] ${label}: nothing created`)
    }
    assert.equal(wallet(a), before, '[2] no coins moved')
    ok('[2] Свара (чакаща) → Белот / Човече: общ попъп, „Виж“ → собствената чакаща маса в Свара')
  }

  // ── [3] Започнал мач в Свара → маса в Белот ────────────────────────────────
  {
    await open(b, '/games/svara')
    // b още е създател на маса от [1] — освобождава я и сяда при a (2 играчи → старт).
    const leaveOffset = b.frames.length
    await send(b, { type: 'leave_svara_table', matchId: b.frames.filter((f) => f.type === 'svara_table_updated').at(-1)!.table.matchId, requestId: randomUUID() })
    await wait('[3] b left', () => b.frames.slice(leaveOffset).some((f) => f.type === 'svara_table_left'), 8_000)
    const joinOffset = b.frames.length
    await send(b, { type: 'join_svara_table', matchId: aSvara, requestId: randomUUID() })
    await wait('[3] started', () => b.frames.slice(joinOffset).some((f) => f.type === 'svara_table_updated' && f.table.phase === 'in-progress'), 8_000)
    await open(a, '/lobby')
    const offset = a.frames.length
    await send(a, { type: 'create_private_room', stake, isLocked: false, waitMinutes: 10, manualStart: false, humanTurnTimeoutMs: 15000, invitePartner: false })
    const location = await expectBlocked(a, offset, '[3]')
    assert.deepEqual(location, { gameType: 'svara', kind: 'active_match', matchId: aSvara }, '[3] location = the started Svara match')
    await clickView(a)
    await wait('[3] Виж → игровият екран', async () => path(a) === '/games/svara' && await a.page.locator('[data-svara-table="1"]').count() === 1, 10_000)
    ok('[3] Свара (започнал мач) → Белот: общ попъп, „Виж“ → игровият екран на мача')
  }

  // ── [4] Чакаща маса в Белот → „+“ на маса в Свара ──────────────────────────
  {
    await open(c, '/lobby')
    const createOffset = c.frames.length
    await send(c, { type: 'create_private_room', stake, isLocked: false, waitMinutes: 10, manualStart: false, humanTurnTimeoutMs: 15000, invitePartner: false })
    await wait('[4] belot room', () => c.frames.slice(createOffset).some((f) => f.type === 'private_room_updated'), 8_000)
    const privateRoomId = c.frames.slice(createOffset).find((f) => f.type === 'private_room_updated').room.id
    await open(d, '/games/svara')
    const matchId = await createSvara(d)
    await open(c, '/games/svara')
    await wait('[4] table listed', async () => await (await svaraSeats(c, matchId)).count() > 0, 10_000)
    const offset = c.frames.length
    await (await svaraSeats(c, matchId)).first().click()
    const location = await expectBlocked(c, offset, '[4]')
    assert.deepEqual(location, { gameType: 'belot', kind: 'waiting_room', privateRoomId }, '[4] location = the waiting Belot table')
    assert(await (await svaraSeats(c, matchId)).first().isEnabled(), '[4] the "+" button is released')
    await clickView(c)
    await wait('[4] Виж → чакащата маса в Белот', async () => await c.page.locator('[data-private-room-leave-slot]').count() > 0
      || await c.page.locator('[data-private-waiting-chat-form]').count() > 0, 8_000)
    ok('[4] Белот (чакаща) → „+“ в Свара: общ попъп, „Виж“ → собствената чакаща маса в Белот')
  }

  for (const p of peers) assert.equal(p.faults.length, 0, `${p.name} browser faults: ${p.faults.join('; ')}`)
  console.log(`\nCross-game commitment (real): ${passed}/${passed} passed`)
} catch (error) {
  console.error(backend?.output().slice(-3000))
  throw error
} finally {
  for (const p of peers) await p.context.close().catch(() => {})
  await browser.close().catch(() => {})
  await gateway?.close().catch(() => {})
  await backend?.stop().catch(() => {})
  await isolated.cleanup().catch(() => {})
}
