/**
 * Свара — реална проверка на приключили/прекратени маси (заседнал all-absent мач).
 *
 * Изолиран компилиран backend (собствена SQLite, реален часовник) + Chromium.
 * Мачовете се засяват в SQLite като ВАЛИДНИ незавършени мачове, създадени през
 * реалния runtime (join → старт → отсъствие), чийто финален срок за присъствие (15 s)
 * вече е изтекъл. При стартиране recovery-то на backend-а сам ги приключва с
 * all-absent / prolonged-absence — същото състояние като в production.
 *
 *   --probe           само показва наблюденията (без проверки) — за диагностика
 *   --screenshots=DIR записва изгледите
 *   --skip-build      без tsc/vite build
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { createIsolatedSvaraRoot, runNode, startIsolatedSvaraBackend, startSvaraGateway, waitForHarnessCondition as wait } from './svaraRealIntegrationHarness'
import { createSvaraMatchRuntime } from '../server/src/games/svara/runtime/svaraMatchRuntime'
import { createSvaraMatchSnapshotStore } from '../server/src/db/svaraMatchSnapshotStore'
import { SVARA_PRESENCE_WAIT_MS } from '../server/src/games/svara/runtime/svaraDeadlines'
import type { SvaraStoredMatch } from '../server/src/games/svara/runtime/svaraPersistence'

const root = process.cwd(), host = 'svara-integration.localhost'
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
type Frame = Record<string, any>
type Peer = { id: string; context: BrowserContext; page: Page; frames: Frame[]; sent: Frame[]; faults: string[] }
const probe = process.argv.includes('--probe')
const screenshotDir = process.argv.find((arg) => arg.startsWith('--screenshots='))?.slice('--screenshots='.length) ?? null

console.log(`Svara finished/aborted table exit — real backend/WS/SQLite/Chromium${probe ? ' (probe)' : ''}`)
if (!process.argv.includes('--skip-build')) {
  await runNode(root, ['node_modules/typescript/bin/tsc', '-p', 'server/tsconfig.json'])
  await runNode(root, ['node_modules/vite/bin/vite.js', 'build'])
}

const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1', '--no-proxy-server'] })
const isolated = await createIsolatedSvaraRoot(root)
const backendOptions = { deckControl: true, extraEnv: { SVARA_TEST_BOTS_ENABLED: '1' } }
let backend: Awaited<ReturnType<typeof startIsolatedSvaraBackend>> | undefined
let gateway: Awaited<ReturnType<typeof startSvaraGateway>> | undefined
let origin = ''
const peers: Peer[] = []
const results: string[] = []
const ok = (name: string) => { results.push(name); console.log(`  ✓ ${name}`) }
const check = (condition: unknown, message: string) => { if (probe) { if (!condition) console.log(`    probe ✗ ${message}`) } else assert(condition, message) }

const db = <T>(fn: (value: DatabaseSync) => T) => {
  const value = new DatabaseSync(isolated.dbFile)
  try { return fn(value) } finally { value.close() }
}
function stored(matchId: string): SvaraStoredMatch {
  return db((d) => {
    const row = d.prepare('SELECT snapshot_json FROM svara_match_snapshots WHERE match_id = ?').get(matchId) as { snapshot_json: string } | undefined
    assert(row, 'match history absent from SQLite')
    return JSON.parse(row.snapshot_json) as SvaraStoredMatch
  })
}
const wallets = () => db((d) => JSON.stringify(d.prepare('SELECT * FROM profile_wallets ORDER BY profile_id').all()))
const inRam = async (matchId: string) => (await backend!.runtimeStatus()).matchIds.includes(matchId)

async function restartBackend() {
  await backend?.stop()
  backend = await startIsolatedSvaraBackend(isolated, backendOptions)
}

/** Валиден незавършен мач през реалния runtime; `absent` са отсъстващи; при `expired` срокът за присъствие е изтекъл. */
async function seedMatch(seats: string[], absent: string[], expired = true): Promise<string> {
  await backend?.stop()
  backend = undefined
  const store = await createSvaraMatchSnapshotStore(isolated.dbFile)
  try {
    const now = expired ? Date.now() - SVARA_PRESENCE_WAIT_MS - 60_000 : Date.now()
    const runtime = createSvaraMatchRuntime({ persistence: store, now: () => now })
    const matchId = randomUUID()
    runtime.registerMatch({ matchId, creator: { playerId: seats[0]! }, capacity: seats.length as 2 | 3 | 4, entryFee: 5000, entryPercent: 1, startMode: 'auto' })
    for (const playerId of seats.slice(1)) runtime.executeParticipantCommand(matchId, { playerId }, `seed-join-${playerId}`, { type: 'join-seat' })
    assert.equal(runtime.getPublicTable(matchId).phase, 'in-progress')
    for (const playerId of absent) runtime.executeSystemCommand(matchId, `seed-absent-${playerId}`, { type: 'set-absent', playerId, absent: true })
    return matchId
  } finally { store.close() }
  // (backend се стартира от извикващия)
}

async function addPeer(role: string): Promise<Peer> {
  const email = `svara-fin-${randomUUID()}@example.test`
  const response = await fetch(`http://127.0.0.1:${backend!.port}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'SvaraFinish1!', displayName: `SF${randomUUID().slice(0, 8)}`, gender: 'male', visitorId: randomUUID() }) })
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
  const page = await context.newPage(), peer: Peer = { id, context, page, frames: [], sent: [], faults: [] }
  page.on('pageerror', (e) => peer.faults.push(e.message))
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => { try { peer.frames.push(JSON.parse(String(payload))) } catch { /* binary/HMR */ } })
    socket.on('framesent', ({ payload }) => { try { peer.sent.push(JSON.parse(String(payload))) } catch { /* ignore */ } })
  })
  peers.push(peer)
  return peer
}

async function openSvara(p: Peer) {
  await p.page.goto(`${origin}/games/svara`, { waitUntil: 'domcontentloaded' })
  await p.page.waitForSelector('[data-svara-lobby="1"]')
  await p.page.getByText('Приеми всички').click({ timeout: 1500 }).catch(() => {})
}

type View = { banner: number; bannerText: string; returnButton: number; waitingNextDeal: boolean; absentLabel: boolean; resultExit: number }
async function view(p: Peer): Promise<View> {
  const text = (await p.page.locator('[data-svara-lobby="1"]').innerText()).replace(/\s+/g, ' ')
  return {
    banner: await p.page.locator('[data-svara-result-banner]').count(),
    bannerText: (await p.page.locator('[data-svara-result-banner]').allInnerTexts()).join(' ').replace(/\s+/g, ' '),
    returnButton: await p.page.locator('[data-svara-action-button="request-return"]').count(),
    waitingNextDeal: text.includes('Чакане на следващо раздаване'),
    absentLabel: /ОТСЪСТВАЩ/i.test(text),
    resultExit: await p.page.locator('[data-svara-result-exit]').count(),
  }
}

/** Отваря/презарежда и изчаква авторитетния отговор за масата (резултат или празно лоби). */
async function load(p: Peer, matchId: string, reload = false) {
  const offset = p.frames.length
  if (reload) await p.page.reload({ waitUntil: 'domcontentloaded' })
  else await openSvara(p)
  await p.page.waitForSelector('[data-svara-lobby="1"]')
  await wait('server answered', () => p.frames.slice(offset).some((f) => f.type === 'svara_tables_list'), 10_000)
  await pause(1_200)
  return { restored: p.frames.slice(offset).some((f) => f.type === 'svara_match_snapshot' && f.matchId === matchId), view: await view(p) }
}

function assertFinishedView(v: View, label: string, expectedText: string) {
  check(v.banner === 1, `${label}: result banner shown`)
  check(v.bannerText.includes(expectedText), `${label}: banner says "${expectedText}" (got "${v.bannerText}")`)
  check(v.resultExit === 1, `${label}: Изход in the result banner`)
  check(v.returnButton === 0, `${label}: no "Върни се" on a finished match`)
  check(!v.waitingNextDeal, `${label}: no "Чакане на следващо раздаване" on a finished match`)
  check(!v.absentLabel, `${label}: no "отсъстващ" status on a finished match`)
}

async function exit(p: Peer, matchId: string, selector: string) {
  const sentOffset = p.sent.length, offset = p.frames.length
  await p.page.click(selector)
  // Активна маса: иконата за изход първо отваря потвърждение — „Напусни“.
  if (await p.page.locator('[data-svara-exit-confirm]').count()) await p.page.click('[data-svara-exit-confirm]')
  await wait('exit reply', () => p.frames.slice(offset).some((f) => (f.type === 'svara_table_left' && f.matchId === matchId)
    || f.type === 'svara_lobby_error' || f.type === 'svara_command_error'), 8_000)
  const sent = p.sent.slice(sentOffset).filter((f) => String(f.type).includes('svara'))
  const received = p.frames.slice(offset).filter((f) => String(f.type).startsWith('svara_'))
  if (probe) console.log(`    probe exit via ${selector}:`, JSON.stringify(sent.map((f) => f.type)), JSON.stringify(received.map((f) => [f.type, f.code])))
  check(sent.some((f) => f.type === 'leave_svara_table' && f.matchId === matchId), 'Изход sends leave_svara_table')
  check(!sent.some((f) => f.type === 'submit_svara_command'), 'Изход sends no gameplay command')
  check(received.some((f) => f.type === 'svara_table_left'), 'server confirms svara_table_left')
  await wait('finished view closed', async () => await p.page.locator('[data-svara-result-banner]').count() === 0, 5_000)
}

async function dropSocket(p: Peer) {
  const connected = p.frames.filter((f) => f.type === 'connected').length
  await p.page.evaluate(() => {
    for (const s of (globalThis as unknown as { __svaraSockets: WebSocket[] }).__svaraSockets) if (s.readyState === WebSocket.OPEN) s.close()
  })
  await wait('websocket recovered without reload', () => p.frames.filter((f) => f.type === 'connected').length > connected, 20_000)
  await pause(2_000)
}

try {
  backend = await startIsolatedSvaraBackend(isolated, backendOptions)
  gateway = await startSvaraGateway(join(root, 'dist'), () => backend?.port ?? null)
  origin = `http://${host}:${gateway.port}`
  db((d) => d.prepare("UPDATE admin_settings SET setting_value='direct' WHERE setting_key='registration_verification_mode'").run())
  const a = await addPeer('admin'), b = await addPeer('admin')
  const initialWallets = wallets()

  // ── 1. all-absent (production случаят) ───────────────────────────────────
  {
    const matchId = await seedMatch([a.id, b.id], [a.id, b.id])
    await restartBackend()
    const saved = stored(matchId)
    assert.equal(saved.state.phase, 'finished')
    assert.equal(saved.state.finishReason, 'all-absent')
    const first = await load(a, matchId)
    if (probe) console.log('    probe all-absent view:', JSON.stringify(first))
    check(first.restored, 'returning participant sees the aborted match')
    assertFinishedView(first.view, 'all-absent', 'Мачът е прекратен')
    if (screenshotDir) await a.page.screenshot({ path: join(screenshotDir, 'svara-finished-all-absent.png') })
    // Reconnect без reload: прегледът остава, докато не бъде затворен.
    await dropSocket(a)
    check(await a.page.locator('[data-svara-result-banner]').count() === 1, 'reconnect keeps the not-yet-closed review')
    await exit(a, matchId, '[data-svara-result-exit]')
    const reloaded = await load(a, matchId, true)
    check(!reloaded.restored && reloaded.view.banner === 0, 'refresh does not restore the left match')
    await dropSocket(a)
    check(await a.page.locator('[data-svara-result-banner]').count() === 0, 'reconnect does not restore the left match')
    check(await inRam(matchId), 'b has not closed it yet: still reviewable')
    // b излиза с горния бутон „Изход“ → последният преглед → освобождаване от RAM.
    const second = await load(b, matchId)
    assertFinishedView(second.view, 'all-absent (b)', 'Мачът е прекратен')
    await exit(b, matchId, '[data-svara-table-leave]')
    await wait('released from RAM', async () => !await inRam(matchId), 5_000).catch(() => check(false, 'released from RAM after the last exit'))
    const after = stored(matchId)
    check(after.state.phase === 'finished' && after.revision === saved.revision, 'SQLite history retained unchanged')
    ok('all-absent: прекратен резултат без „Върни се“/„Чакане…“/„отсъстващ“; Изход → leave_svara_table; refresh/reconnect не възстановяват; RAM освободен; SQLite история')
  }

  // ── 2. prolonged-absence: загубилият и победителят ───────────────────────
  {
    const matchId = await seedMatch([a.id, b.id], [a.id])
    await restartBackend()
    assert.equal(stored(matchId).state.finishReason, 'prolonged-absence')
    const loser = await load(a, matchId)
    assertFinishedView(loser.view, 'prolonged-absence (отсъстващ)', 'Победа поради продължително отсъствие')
    const winner = await load(b, matchId)
    assertFinishedView(winner.view, 'prolonged-absence (победител)', 'Победа поради продължително отсъствие')
    await exit(a, matchId, '[data-svara-table-leave]')
    await exit(b, matchId, '[data-svara-result-exit]')
    await wait('released from RAM', async () => !await inRam(matchId), 5_000).catch(() => check(false, 'released from RAM'))
    for (const p of [a, b]) check(!(await load(p, matchId, true)).restored, 'not restored after refresh')
    ok('prolonged-absence: двамата излизат, не се възстановява, RAM освободен')
  }

  // ── 3. Маса с тестов бот: човекът отсъства, ботът печели ─────────────────
  {
    const bot = `svara-test-bot:0:${randomUUID()}`
    const matchId = await seedMatch([a.id, bot], [a.id])
    await restartBackend()
    assert.equal(stored(matchId).state.winnerId, bot)
    const seen = await load(a, matchId)
    assertFinishedView(seen.view, 'bot table', 'Победа поради продължително отсъствие')
    await exit(a, matchId, '[data-svara-result-exit]')
    await wait('released from RAM', async () => !await inRam(matchId), 5_000).catch(() => check(false, 'bot does not keep the match in RAM'))
    check(!(await load(a, matchId, true)).restored, 'not restored after refresh')
    ok('маса с бот: човекът излиза, ботът не задържа мача, не се възстановява')
  }

  // ── 4. Повторно създаване на маса след напуснат приключил мач ────────────
  {
    const offset = a.frames.length
    await a.page.click('[data-svara-create-open]')
    await a.page.click('[data-svara-create-form] button[type="submit"]')
    await wait('new table', () => a.frames.slice(offset).some((f) => f.type === 'svara_table_updated' || f.type === 'svara_lobby_error'), 5_000)
    const reply = a.frames.slice(offset).find((f) => f.type === 'svara_table_updated' || f.type === 'svara_lobby_error')!
    check(reply.type === 'svara_table_updated', `a new table can be created (got ${reply.type} ${reply.code ?? ''})`)
    if (reply.type === 'svara_table_updated') await exitWaiting(a, reply.table.matchId)
    ok('повторно създаване на маса след напуснат приключил мач')
  }

  // ── 5. Незавършен мач: временно отсъстващ играч се връща ─────────────────
  {
    const matchId = await seedMatch([a.id, b.id], [a.id], false)
    await restartBackend()
    const seen = await load(a, matchId)
    check(seen.restored && seen.view.banner === 0, 'unfinished match restored without a result banner')
    check(seen.view.returnButton === 1, '"Върни се" still offered in an unfinished match')
    await a.page.click('[data-svara-action-button="request-return"]')
    await wait('absent player returned', () => stored(matchId).state.status[a.id] === 'active', 10_000).catch(() => check(false, 'return to the unfinished match'))
    check(stored(matchId).state.phase === 'in-progress', 'match continues')
    ok('незавършен мач: „Върни се“ работи както преди')
  }

  check(wallets() === initialWallets, 'no real yellow coins moved')
  for (const p of peers) check(p.faults.length === 0, `browser faults: ${p.faults.join('; ')}`)
  if (!probe) console.log(`\nSvara finished exit (real): ${results.length}/${results.length} passed`)
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

async function exitWaiting(p: Peer, matchId: string) {
  const offset = p.frames.length
  await p.page.click('[data-svara-table-leave]')
  await wait('left waiting table', () => p.frames.slice(offset).some((f) => f.type === 'svara_table_left' && f.matchId === matchId), 5_000)
}
