/**
 * Свара — автоматично отваряне на започнал мач (реален backend/WS/SQLite/Chromium).
 *
 * Седнал участник, който е в „Лафче“ (/topics), в друга секция (/games) или на
 * списъка с маси, се прехвърля на игровия екран само след потвърден от
 * сървъра старт (фаза 'in-progress'):
 *   [1] 2 играчи, автоматичен старт, създателят е в „Лафче“; без повторно
 *       пренасочване, ако след това сам излезе от екрана на играта.
 *   [2] 3 играчи, ръчен старт; участниците са в „Лафче“ и в „Игри“.
 *   [3] 4 играчи, автоматичен старт:
 *       - отказан старт (недостатъчен баланс) → никой не се прехвърля;
 *       - напуснал масата преди старта → не се прехвърля;
 *       - прекъсната връзка точно при старта → след възстановяването ѝ;
 *       - презареждане след старта → пак игровият екран.
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
type Peer = { name: string; id: string; context: BrowserContext; page: Page; frames: Frame[]; faults: string[] }

console.log('Svara auto-open of a started match — real backend/WS/SQLite/Chromium')
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
const phaseOf = (matchId: string) => db((d) => (d.prepare('SELECT match_status AS s FROM svara_match_snapshots WHERE match_id = ?').get(matchId) as { s: string } | undefined)?.s ?? null)
const setBalance = (p: Peer, amount: number) => db((d) => d.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?)
  ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance`).run(p.id, amount))

async function addPeer(name: string): Promise<Peer> {
  const email = `svara-auto-${randomUUID()}@example.test`
  const response = await fetch(`http://127.0.0.1:${backend!.port}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'SvaraAuto1!', displayName: `SA${randomUUID().slice(0, 8)}`, gender: 'male', visitorId: randomUUID() }) })
  assert.equal(response.status, 200)
  const body = await response.json() as { session: { profile: { profileId: string } } }
  const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!, id = body.session.profile.profileId
  db((d) => d.prepare("UPDATE accounts SET role='admin' WHERE email=?").run(email))
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } })
  const separator = cookie.indexOf('=')
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }])
  await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  // __svaraBlockWs: нови връзки отиват към затворен порт (прекъсната мрежа) — клиентът сам опитва пак.
  await context.addInitScript(`globalThis.__name = (target) => target; globalThis.__svaraSockets = []; globalThis.__svaraBlockWs = false;
    const Native = WebSocket;
    globalThis.WebSocket = new Proxy(Native, { construct(target, args) {
      const socket = globalThis.__svaraBlockWs ? new target('ws://127.0.0.1:9/blocked') : new target(...args)
      globalThis.__svaraSockets.push(socket); return socket } });`)
  const page = await context.newPage(), peer: Peer = { name, id, context, page, frames: [], faults: [] }
  page.on('pageerror', (e) => peer.faults.push(e.message))
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => { try { peer.frames.push(JSON.parse(String(payload))) } catch { /* binary/HMR */ } })
  })
  peers.push(peer)
  setBalance(peer, 100_000)
  return peer
}

const path = (p: Peer) => new URL(p.page.url()).pathname
const gameTables = (p: Peer) => p.page.locator('[data-svara-table="1"]').count()
/** Пълно зареждане на адрес + изчаква връзката към сървъра. */
async function open(p: Peer, url: string) {
  const offset = p.frames.length
  await p.page.goto(`${origin}${url}`, { waitUntil: 'domcontentloaded' })
  await wait(`${p.name} connected`, () => p.frames.slice(offset).some((f) => f.type === 'connected'), 15_000)
  await p.page.getByText('Приеми всички').click({ timeout: 1500 }).catch(() => {})
  await pause(800)
}
/** Навигация в приложението (без презареждане и без нова връзка). */
async function navigateInApp(p: Peer, url: string) {
  await p.page.evaluate((target) => { history.pushState({}, '', target); dispatchEvent(new PopStateEvent('popstate')) }, url)
  await wait(`${p.name} in-app ${url}`, () => path(p) === url, 5_000)
}
async function send(p: Peer, message: Record<string, unknown>) {
  await p.page.evaluate((frame) => {
    const sockets = (globalThis as unknown as { __svaraSockets: WebSocket[] }).__svaraSockets.filter((s) => s.readyState === WebSocket.OPEN)
    if (sockets.length === 0) throw new Error('no open socket')
    sockets[sockets.length - 1]!.send(JSON.stringify(frame))
  }, message)
}
async function request(p: Peer, message: Record<string, unknown>): Promise<Frame> {
  const requestId = randomUUID(), offset = p.frames.length
  await send(p, { ...message, requestId })
  await wait(`${p.name} ${String(message.type)} reply`, () => p.frames.slice(offset).some((f) => f.requestId === requestId || f.type === 'svara_lobby_error'), 8_000)
  const reply = p.frames.slice(offset).find((f) => f.requestId === requestId || f.type === 'svara_lobby_error')!
  assert.notEqual(reply.type, 'svara_lobby_error', `${p.name} ${String(message.type)}: ${reply.code} ${reply.message}`)
  return reply
}
async function create(p: Peer, capacity: 2 | 3 | 4, startMode: 'auto' | 'manual'): Promise<string> {
  const reply = await request(p, { type: 'create_svara_table', capacity, entryFee: 5000, entryPercent: 1, startMode })
  return reply.table.matchId as string
}
const joinTable = (p: Peer, matchId: string) => request(p, { type: 'join_svara_table', matchId })
async function expectGameScreen(p: Peer, label: string) {
  await wait(`${label}: ${p.name} on the game screen`, async () => path(p) === '/games/svara' && await gameTables(p) === 1, 15_000)
  assert.equal(await gameTables(p), 1, `${label}: ${p.name} has exactly one game screen`)
  assert.equal(await p.page.locator('[data-svara-lobby="1"]').count(), 1, `${label}: ${p.name} has one Svara mount`)
}
async function expectStays(p: Peer, url: string, label: string, ms = 2_500) {
  await pause(ms)
  assert.equal(path(p), url, `${label}: ${p.name} stays on ${url}`)
  assert.equal(await gameTables(p), 0, `${label}: ${p.name} sees no game screen`)
}
async function dropAndBlockSocket(p: Peer) {
  await p.page.evaluate(() => {
    const g = globalThis as unknown as { __svaraSockets: WebSocket[]; __svaraBlockWs: boolean }
    g.__svaraBlockWs = true
    for (const s of g.__svaraSockets) if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) s.close()
  })
}
const unblockSocket = (p: Peer) => p.page.evaluate(() => { (globalThis as unknown as { __svaraBlockWs: boolean }).__svaraBlockWs = false })

try {
  backend = await startIsolatedSvaraBackend(isolated, { extraEnv: { SVARA_PAID_MATCHES_ENABLED: '1' } })
  gateway = await startSvaraGateway(join(root, 'dist'), () => backend?.port ?? null)
  origin = `http://${host}:${gateway.port}`
  db((d) => d.prepare("UPDATE admin_settings SET setting_value='direct' WHERE setting_key='registration_verification_mode'").run())
  const [a, b, c, d, e] = [await addPeer('a'), await addPeer('b'), await addPeer('c'), await addPeer('d'), await addPeer('e')] as [Peer, Peer, Peer, Peer, Peer]

  // ── [1] 2 играчи, автоматичен старт, създателят е в „Лафче“ ───────────────
  {
    await open(a, '/games/svara'); await open(b, '/games/svara')
    const m = await create(a, 2, 'auto')
    await open(a, '/topics') // пълно зареждане: чакащата маса не отваря нищо
    await expectStays(a, '/topics', '[1] waiting table', 1_500)
    await joinTable(b, m)
    await wait('[1] started', () => phaseOf(m) === 'in-progress', 8_000)
    await expectGameScreen(a, '[1] from Лафче')
    await expectGameScreen(b, '[1] from the table list')
    // Сам излиза към „Лафче“ по време на мача → без повторно пренасочване.
    await navigateInApp(a, '/topics')
    const before = a.frames.filter((f) => f.type === 'svara_match_snapshot' && f.matchId === m).length
    await wait('[1] further match updates', () => a.frames.filter((f) => f.type === 'svara_match_snapshot' && f.matchId === m).length > before, 20_000)
    await expectStays(a, '/topics', '[1] after leaving the game screen manually', 1_000)
    ok('[1] 2 играчи, автоматичен старт: от „Лафче“ и от списъка → игровият екран; без повторно пренасочване')
  }

  // ── [2] 3 играчи, ръчен старт, участниците в „Лафче“ и „Игри“ ─────────────
  {
    for (const p of [c, d, e]) await open(p, '/games/svara')
    const m = await create(c, 3, 'manual')
    await joinTable(d, m); await joinTable(e, m)
    await open(d, '/topics'); await open(e, '/games')
    await expectStays(d, '/topics', '[2] full but not started', 800)
    await expectStays(e, '/games', '[2] full but not started', 0)
    await request(c, { type: 'start_svara_table', matchId: m })
    await wait('[2] started', () => phaseOf(m) === 'in-progress', 8_000)
    await expectGameScreen(d, '[2] from Лафче')
    await expectGameScreen(e, '[2] from Игри')
    await expectGameScreen(c, '[2] host')
    ok('[2] 3 играчи, ръчен старт: пълна маса не прехвърля; след „Старт“ — от „Лафче“ и „Игри“')
  }

  // ── [3] 4 играчи, автоматичен старт ───────────────────────────────────────
  {
    // Нови участници (предишните са заети с мачовете си).
    const [f, g, h, i, j] = [await addPeer('f'), await addPeer('g'), await addPeer('h'), await addPeer('i'), await addPeer('j')] as [Peer, Peer, Peer, Peer, Peer]
    for (const p of [f, g, h, i, j]) await open(p, '/games/svara')
    const m = await create(f, 4, 'auto')
    await joinTable(g, m); await joinTable(h, m)
    // h напуска чакащата маса и отива в „Лафче“.
    await request(h, { type: 'leave_svara_table', matchId: m })
    await open(h, '/topics')
    await open(g, '/topics')
    await joinTable(i, m)
    // Отказан старт: i вече няма достатъчно жълтици, когато j запълва масата.
    setBalance(i, 0)
    const jOffset = j.frames.length
    await send(j, { type: 'join_svara_table', matchId: m, requestId: randomUUID() })
    await wait('[3] start refused', () => i.frames.some((fr) => fr.type === 'svara_lobby_error' && fr.code === 'insufficient_entry_balance')
      || j.frames.slice(jOffset).some((fr) => fr.type === 'svara_lobby_error'), 8_000)
    assert.equal(phaseOf(m), 'lobby', '[3] refused start leaves the table waiting')
    await expectStays(g, '/topics', '[3] refused start')
    await expectStays(h, '/topics', '[3] refused start', 0)
    ok('[3] отказан старт (недостатъчен баланс) → никой не се прехвърля')
    // Връзката на g прекъсва точно преди старта.
    await dropAndBlockSocket(g)
    setBalance(i, 100_000)
    await joinTable(i, m)
    await wait('[3] started', () => phaseOf(m) === 'in-progress', 8_000)
    await expectGameScreen(f, '[3] host on the list')
    await expectGameScreen(i, '[3]')
    await expectStays(g, '/topics', '[3] while disconnected', 1_000)
    await unblockSocket(g)
    await expectGameScreen(g, '[3] after reconnect')
    ok('[3] 4 играчи: прекъсната връзка при старта → игровият екран след възстановяването')
    await expectStays(h, '/topics', '[3] left before the start', 0)
    ok('[3] напусналият чакащата маса не се прехвърля')
    // Презареждане след старта на друг адрес → възстановяване към мача.
    await open(j, '/topics')
    await expectGameScreen(j, '[3] after reload')
    ok('[3] презареждане след старта → игровият екран (съществуващото възстановяване)')
  }

  for (const p of peers) assert.equal(p.faults.length, 0, `${p.name} browser faults: ${p.faults.join('; ')}`)
  console.log(`\nSvara auto-open (real): ${passed}/${passed} passed`)
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
