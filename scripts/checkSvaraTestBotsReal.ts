/**
 * ВРЕМЕННО — реална E2E проверка на тестовите ботове в Свара
 * (docs/svara-test-bots-local.md). Премахва се заедно с модула testBots/.
 *
 * Изолиран компилиран backend (собствена SQLite, реален часовник, NODE_ENV=test,
 * SVARA_TEST_BOTS_ENABLED=1), loopback gateway и Chromium. „Създай“, „Запълни с
 * ботове“ и „Старт“ минават през истинския UI; ходовете на човека — през
 * истинския WebSocket на страницата, по последния получен snapshot.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { createIsolatedSvaraRoot, runNode, startIsolatedSvaraBackend, startSvaraGateway, waitForHarnessCondition as wait } from './svaraRealIntegrationHarness'
import { assertSvaraMatchInvariants } from '../server/src/games/svara/engine/svaraMatch'
import { SVARA_SNAPSHOT_FORBIDDEN_KEYS, type SvaraMatchSnapshotMessage } from '../server/src/games/svara/protocol/svaraSnapshotProtocol'
import type { SvaraStoredMatch } from '../server/src/games/svara/runtime/svaraPersistence'
import { decideSvaraTestBotCommand, svaraTestBotHasDecision } from '../server/src/games/svara/testBots/svaraTestBotStrategy'
import { isSvaraTestBotId } from '../server/src/games/svara/testBots/svaraTestBotIdentity'

const root = process.cwd(), host = 'svara-integration.localhost'
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
type Frame = Record<string, any>
type Peer = { id: string; context: BrowserContext; page: Page; frames: Frame[]; faults: string[]; sentRevisions: Set<string> }

console.log('Svara test bots — real backend/WS/SQLite/Chromium')
if (!process.argv.includes('--skip-build')) {
  await runNode(root, ['node_modules/typescript/bin/tsc', '-p', 'server/tsconfig.json'])
  await runNode(root, ['node_modules/vite/bin/vite.js', 'build'])
}

const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1', '--no-proxy-server'] })
const isolated = await createIsolatedSvaraRoot(root)
const botEnv = { SVARA_TEST_BOTS_ENABLED: '1' }
let backend: Awaited<ReturnType<typeof startIsolatedSvaraBackend>> | undefined
let gateway: Awaited<ReturnType<typeof startSvaraGateway>> | undefined
const peers: Peer[] = []
const results: string[] = []
const ok = (name: string) => { results.push(name); console.log(`  ✓ ${name}`) }
/** По избор: --screenshots=<папка> записва изгледа на чакащата и активната маса. */
const screenshotDir = process.argv.find((arg) => arg.startsWith('--screenshots='))?.slice('--screenshots='.length) ?? null

const db = <T>(fn: (value: DatabaseSync) => T) => {
  const value = new DatabaseSync(isolated.dbFile)
  try { return fn(value) } finally { value.close() }
}
const wallets = () => db((d) => JSON.stringify(d.prepare('SELECT * FROM profile_wallets ORDER BY profile_id').all()))
function stored(matchId: string): SvaraStoredMatch {
  return db((d) => {
    const row = d.prepare('SELECT snapshot_json FROM svara_match_snapshots WHERE match_id = ?').get(matchId) as { snapshot_json: string } | undefined
    assert(row, 'match absent from SQLite')
    const value = JSON.parse(row.snapshot_json) as SvaraStoredMatch
    assertSvaraMatchInvariants(value.state)
    return value
  })
}
/** Ботовете не оставят следи извън snapshot-а на мача (никакви профили/акаунти). */
function botRowsOutsideSnapshots(): string[] {
  return db((d) => {
    const found: string[] = []
    const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'svara_match_snapshots'").all() as Array<{ name: string }>
    for (const { name } of tables) {
      const columns = (d.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; type: string }>).filter((c) => /TEXT|CHAR|^$/i.test(c.type))
      for (const column of columns) {
        const row = d.prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE "${column.name}" LIKE '%svara-test-bot:%'`).get() as { n: number }
        if (row.n > 0) found.push(`${name}.${column.name}`)
      }
    }
    return found
  })
}

async function addPeer(role: string, origin: string): Promise<Peer> {
  const email = `svara-bots-${randomUUID()}@example.test`
  const response = await fetch(`http://127.0.0.1:${backend!.port}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'SvaraBots1!', displayName: `SB${randomUUID().slice(0, 8)}`, gender: 'male', visitorId: randomUUID() }) })
  assert.equal(response.status, 200)
  const body = await response.json() as { session: { profile: { profileId: string } } }
  const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!, id = body.session.profile.profileId
  db((d) => d.prepare('UPDATE accounts SET role=? WHERE email=?').run(role, email))
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } })
  const separator = cookie.indexOf('=')
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }])
  await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  await context.addInitScript(`globalThis.__name = (target) => target; globalThis.__svaraSockets = [];
    const Native = WebSocket;
    globalThis.WebSocket = new Proxy(Native, { construct(target, args) { const socket = new target(...args); globalThis.__svaraSockets.push(socket); return socket } });`)
  const page = await context.newPage(), peer: Peer = { id, context, page, frames: [], faults: [], sentRevisions: new Set() }
  page.on('pageerror', (e) => peer.faults.push(e.message))
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    try {
      const frame: Frame = JSON.parse(String(payload))
      if (String(frame.type).startsWith('svara_')) {
        const inspect = (v: unknown): void => { if (v && typeof v === 'object') for (const [key, nested] of Object.entries(v)) { assert(!SVARA_SNAPSHOT_FORBIDDEN_KEYS.includes(key), key); inspect(nested) } }
        inspect(frame)
      }
      peer.frames.push(frame)
    } catch { peer.faults.push('Invalid/private frame') }
  }))
  await page.goto(`${origin}/games/svara`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-svara-lobby="1"]')
  await page.getByText('Приеми всички').click({ timeout: 2000 }).catch(() => {})
  peers.push(peer)
  return peer
}

async function raw(p: Peer, message: Record<string, unknown>) {
  await wait('open page socket', () => p.page.evaluate(() => (globalThis as unknown as { __svaraSockets: WebSocket[] }).__svaraSockets
    .some((s) => s.readyState === WebSocket.OPEN && s.url.endsWith('/ws'))), 10_000)
  await p.page.evaluate((payload) => {
    const sockets = (globalThis as unknown as { __svaraSockets: WebSocket[] }).__svaraSockets
    const socket = sockets.findLast((s) => s.readyState === WebSocket.OPEN && s.url.endsWith('/ws'))
    if (!socket) throw new Error('no open socket')
    socket.send(JSON.stringify(payload))
  }, message)
}

async function createViaUi(p: Peer, capacity: 2 | 3 | 4, startMode: 'auto' | 'manual'): Promise<string> {
  const offset = p.frames.length
  await p.page.click('[data-svara-create-open]')
  await p.page.selectOption('[data-svara-create-form] select[name="capacity"]', String(capacity))
  await p.page.selectOption('[data-svara-create-form] select[name="entryFee"]', '5000')
  await p.page.check(`[data-svara-create-form] input[name="startMode"][value="${startMode}"]`)
  await p.page.click('[data-svara-create-form] button[type="submit"]')
  await wait('table created', () => p.frames.slice(offset).some((f) => f.type === 'svara_table_updated'), 5000)
  return p.frames.slice(offset).findLast((f) => f.type === 'svara_table_updated')!.table.matchId
}

async function fillViaUi(p: Peer, matchId: string, capacity: number) {
  await p.page.waitForSelector('[data-svara-table-fill-bots]', { timeout: 5000 })
  await p.page.click('[data-svara-table-fill-bots]')
  await wait('bots seated', () => stored(matchId).state.seats.length === capacity, 5000)
}

function latestSnapshot(p: Peer, matchId: string): SvaraMatchSnapshotMessage | undefined {
  return p.frames.findLast((f) => f.type === 'svara_match_snapshot' && f.matchId === matchId) as SvaraMatchSnapshotMessage | undefined
}

/** Хората играят по последния истински snapshot, докато се изиграят `rounds` раздавания. */
async function playRounds(humans: Peer[], matchId: string, rounds: number, seed: number) {
  let a = seed
  const random = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648 }
  const target = stored(matchId).state.history.length + rounds
  const deadline = Date.now() + rounds * 60_000
  while (Date.now() < deadline) {
    const state = stored(matchId).state
    if (state.phase !== 'in-progress' || state.history.length >= target) return
    if (!humans.some((h) => ['active', 'absent'].includes(state.status[h.id]!))) return
    for (const h of humans) {
      const snapshot = latestSnapshot(h, matchId)
      if (!snapshot || !svaraTestBotHasDecision(snapshot)) continue
      const key = `${snapshot.revision}`
      if (h.sentRevisions.has(key)) continue
      const command = decideSvaraTestBotCommand(snapshot, random)
      if (!command) continue
      h.sentRevisions.add(key)
      await raw(h, { type: 'submit_svara_command', matchId, commandId: randomUUID(), expectedRevision: snapshot.revision, command })
    }
    await pause(250)
  }
  assert.fail('rounds did not complete in time')
}

/** Хората излизат → ботовете трябва сами да излязат и мачът да приключи; след това нищо не тиктака. */
/**
 * Хората натискат истинския бутон „Изход“ един след друг. Докато остава друг
 * реален играч, мачът продължава; изходът на последния прекратява мача
 * веднага (без победител), връща в лобито и позволява нова маса веднага.
 */
async function exitAndVerifyRelease(humans: Peer[], matchId: string) {
  const playing = humans.filter((h) => ['active', 'absent'].includes(stored(matchId).state.status[h.id]!))
  if (stored(matchId).state.phase !== 'in-progress' || playing.length === 0) return
  for (const [index, h] of playing.entries()) {
    const offset = h.frames.length
    await h.page.click('[data-svara-table-leave]')
    // Активна маса: иконата за изход първо отваря потвърждение — „Напусни“.
    if (await h.page.locator('[data-svara-exit-confirm]').count()) await h.page.click('[data-svara-exit-confirm]')
    await wait('back in the Svara lobby', () => h.frames.slice(offset).some((f) => f.type === 'svara_table_left' && f.matchId === matchId), 5_000)
    // Сървърът отговаря със svara_table_left СЛЕД прекратяването в същата заявка —
    // затова мачът трябва вече да е приключил, без да чакаме бот/дисплей таймери.
    const s = stored(matchId).state
    await h.page.waitForSelector('[data-svara-create-open]', { timeout: 5_000 })
    if (index < playing.length - 1) {
      assert.equal(s.phase, 'in-progress', 'another real player remains: the match continues')
      continue
    }
    assert.equal(s.phase, 'finished', 'the last human exit ends the match immediately (same request)')
    assert.equal(s.winnerId, null, 'no fictitious winner')
    // Нова маса веднага след изхода.
    const createOffset = h.frames.length
    await h.page.click('[data-svara-create-open]')
    await h.page.click('[data-svara-create-form] button[type="submit"]')
    await wait('new table right away', () => h.frames.slice(createOffset).some((f) => f.type === 'svara_table_updated' || f.type === 'svara_lobby_error'), 5_000)
    const created = h.frames.slice(createOffset).find((f) => f.type === 'svara_table_updated' || f.type === 'svara_lobby_error')!
    assert.equal(created.type, 'svara_table_updated', `new table right away (${created.code ?? ''})`)
    await h.page.click('[data-svara-table-leave]')
    await wait('left the new waiting table', () => h.frames.slice(createOffset).some((f) => f.type === 'svara_table_left' && f.matchId === created.table.matchId), 5_000)
  }
  const revision = stored(matchId).revision
  await pause(4_000)
  assert.equal(stored(matchId).revision, revision, 'no bot/system activity after the match finished')
  assert.equal(stored(matchId).state.phase, 'finished', 'SQLite history retained')
  assert(!backend!.output().includes('[svara-test-bots] failed'), 'bot controller reported a failure')
}

const initial: { wallets?: string } = {}
try {
  backend = await startIsolatedSvaraBackend(isolated, { extraEnv: botEnv })
  assert(backend.output().includes('[svara-test-bots] ENABLED'), 'startup warns that bots are enabled')
  gateway = await startSvaraGateway(join(root, 'dist'), () => backend?.port ?? null)
  const origin = `http://${host}:${gateway.port}`
  db((d) => d.prepare("UPDATE admin_settings SET setting_value='direct' WHERE setting_key='registration_verification_mode'").run())
  const admin = await addPeer('admin', origin)
  const other = await addPeer('subadmin', origin)
  initial.wallets = wallets()

  // A. 1 човек срещу 1 бот, „При запълване“
  {
    const matchId = await createViaUi(admin, 2, 'auto')
    await fillViaUi(admin, matchId, 2)
    await wait('auto start', () => stored(matchId).state.phase === 'in-progress', 5000)
    await playRounds([admin], matchId, 2, 11)
    assert.equal(stored(matchId).state.seats.filter(isSvaraTestBotId).length, 1)
    await exitAndVerifyRelease([admin], matchId)
    ok('1 човек срещу 1 бот: UI запълване, авто старт, игра, „Изход“ → незабавен край без победител, лоби, нова маса, нищо не тиктака')
  }

  // A2. 1 човек срещу 2 бота, „При запълване“
  {
    const matchId = await createViaUi(admin, 3, 'auto')
    await fillViaUi(admin, matchId, 3)
    await wait('auto start', () => stored(matchId).state.phase === 'in-progress', 5000)
    await playRounds([admin], matchId, 2, 12)
    assert.equal(stored(matchId).state.seats.filter(isSvaraTestBotId).length, 2)
    await exitAndVerifyRelease([admin], matchId)
    ok('1 човек срещу 2 бота: авто старт, игра, „Изход“ → незабавен край, лоби, нова маса')
  }

  // B. Смесена маса: 2 души + 1 бот, „При запълване“; subadmin не вижда бутона
  {
    const matchId = await createViaUi(admin, 3, 'auto')
    await other.page.waitForSelector(`[data-svara-table-join="${matchId}"]`, { timeout: 5000 })
    await other.page.click(`[data-svara-table-join="${matchId}"]`)
    await wait('human joined', () => stored(matchId).state.seats.includes(other.id), 5000)
    await other.page.waitForSelector('[data-svara-waiting]')
    assert.equal(await other.page.locator('[data-svara-table-fill-bots]').count(), 0, 'not the creator: no button')
    const offset = other.frames.length
    await raw(other, { type: 'fill_svara_table_with_bots', matchId, requestId: randomUUID() })
    await wait('server rejects a forged fill', () => other.frames.slice(offset).some((f) => f.type === 'svara_lobby_error'), 5000)
    assert.equal(other.frames.slice(offset).findLast((f) => f.type === 'svara_lobby_error')!.code, 'forbidden_role')
    await fillViaUi(admin, matchId, 3)
    await wait('auto start', () => stored(matchId).state.phase === 'in-progress', 5000)
    await playRounds([admin, other], matchId, 2, 22)
    await exitAndVerifyRelease([admin, other], matchId)
    ok('смесена маса 2 души + 1 бот: бутон само за admin създателя, подправена заявка отказана, авто старт')
  }

  // C. 1 човек срещу 3 бота, „Ръчен старт“, reload, рестарт на сървъра
  {
    const matchId = await createViaUi(admin, 4, 'manual')
    await fillViaUi(admin, matchId, 4)
    await admin.page.waitForSelector('[data-svara-bot-badge]')
    assert.equal(await admin.page.locator('[data-svara-bot-badge]').count(), 3, 'bots are clearly marked')
    const names = await admin.page.locator('[data-svara-waiting-seat] [data-svara-player-name]').allTextContents()
    assert.equal(names.filter((n) => n.startsWith('Бот ')).length, 3)
    assert.equal(await admin.page.locator('[data-svara-waiting-seat] img[data-svara-player-avatar]').count() >= 3, true, 'bot avatars render')
    await pause(3_000)
    assert.equal(stored(matchId).state.phase, 'lobby', 'manual table waits for the creator')
    if (screenshotDir) await admin.page.screenshot({ path: join(screenshotDir, 'svara-bots-waiting.png'), fullPage: true })
    await admin.page.click('[data-svara-table-start]')
    await wait('manual start', () => stored(matchId).state.phase === 'in-progress', 5000)
    if (screenshotDir) { await pause(6_000); await admin.page.screenshot({ path: join(screenshotDir, 'svara-bots-table.png') }) }
    await playRounds([admin], matchId, 1, 33)
    // Reload (reconnect) на страницата.
    const reloadOffset = admin.frames.length
    await admin.page.reload({ waitUntil: 'domcontentloaded' })
    await wait('reconnect snapshot', () => admin.frames.slice(reloadOffset).some((f) => f.type === 'svara_match_snapshot' && f.matchId === matchId), 10_000)
    admin.sentRevisions.clear()
    await playRounds([admin], matchId, 1, 34)
    // Рестарт на сървъра посред мач.
    if (stored(matchId).state.phase === 'in-progress') {
      await backend.stop()
      backend = await startIsolatedSvaraBackend(isolated, { extraEnv: botEnv })
      const restartOffset = admin.frames.length
      await admin.page.reload({ waitUntil: 'domcontentloaded' })
      const before = stored(matchId).revision
      await wait('restored snapshot after restart', () => admin.frames.slice(restartOffset).some((f) => f.type === 'svara_match_snapshot' && f.matchId === matchId && f.revision >= before), 15_000)
      admin.sentRevisions.clear()
      await playRounds([admin], matchId, 1, 35)
      assert(stored(matchId).revision > before, 'the match continues after restart')
      console.log(`    рестарт посред мач: revision ${before} → ${stored(matchId).revision}`)
    } else console.log('    (мачът приключи преди точката на рестарт — рестартът е покрит от checkSvaraTestBots.ts)')
    await exitAndVerifyRelease([admin], matchId)
    ok('1 човек срещу 3 бота: ръчен старт, обозначения/аватари, reload, рестарт на сървъра, изход')
  }

  // D. Същият сървър без флага за ботове: няма бутон, сървърът отказва.
  {
    await backend.stop()
    backend = await startIsolatedSvaraBackend(isolated)
    assert(!backend.output().includes('[svara-test-bots] ENABLED'))
    await admin.page.reload({ waitUntil: 'domcontentloaded' })
    await admin.page.waitForSelector('[data-svara-lobby="1"]')
    const matchId = await createViaUi(admin, 2, 'auto')
    await admin.page.waitForSelector('[data-svara-waiting]')
    assert.equal(await admin.page.locator('[data-svara-table-fill-bots]').count(), 0, 'no button without the flag')
    const offset = admin.frames.length
    await raw(admin, { type: 'fill_svara_table_with_bots', matchId, requestId: randomUUID() })
    await wait('disabled fill rejected', () => admin.frames.slice(offset).some((f) => f.type === 'svara_lobby_error'), 5000)
    assert.equal(admin.frames.slice(offset).findLast((f) => f.type === 'svara_lobby_error')!.code, 'feature_disabled')
    assert.equal(stored(matchId).state.seats.length, 1)
    await raw(admin, { type: 'leave_svara_table', matchId, requestId: randomUUID() })
    ok('без SVARA_TEST_BOTS_ENABLED: няма бутон, заявката → feature_disabled')
  }

  assert.equal(wallets(), initial.wallets, 'no real yellow coins moved')
  assert.deepEqual(botRowsOutsideSnapshots(), [], 'no bot profiles/rows outside match snapshots')
  for (const p of peers) assert.deepEqual(p.faults, [], `browser faults: ${p.faults.join('; ')}`)
  ok('без реални жълтици, без бот профили в базата, без грешки в браузъра')
  console.log(`\nSvara test bots (real): ${results.length}/${results.length} passed`)
} catch (error) {
  console.error(backend?.output().slice(-4000))
  throw error
} finally {
  for (const p of peers) await p.context.close().catch(() => {})
  await browser.close().catch(() => {})
  await gateway?.close().catch(() => {})
  await backend?.stop().catch(() => {})
  await isolated.cleanup().catch(() => {})
}
