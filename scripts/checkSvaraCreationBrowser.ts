/** Fresh builds required: npm run build and tsc -p server/tsconfig.json.
 * Real Chromium/HTTP/Auth/WS/SQLite. Only private disposable fixtures. */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type NodeSocketType from 'ws'
import { createIsolatedSvaraRoot, startIsolatedSvaraBackend, startSvaraGateway, waitForHarnessCondition } from './svaraRealIntegrationHarness'

const root = resolve('.')
const NodeSocket = createRequire(new URL('../server/package.json', import.meta.url))('ws') as typeof NodeSocketType
const host = 'svara-integration.localhost'
const fees = [5000, 8000, 15000, 20000, 35000, 50000, 60000, 80000, 100000, 130000, 150000, 180000, 200000]
// Expected display grouping independent of Intl's implementation (NBSP).
const grouped = (amount: number) => String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')
const artifacts = join(root, 'tmp/svara-multiplayer/creation')
await mkdir(artifacts, { recursive: true })
const browser: Browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1', '--no-proxy-server'] })
let passed = 0
try {
  for (const capacity of [2, 3, 4]) for (const mode of ['auto', 'manual']) {
    const isolated = await createIsolatedSvaraRoot(root)
    let backend: Awaited<ReturnType<typeof startIsolatedSvaraBackend>> | undefined
    let gateway: Awaited<ReturnType<typeof startSvaraGateway>> | undefined
    const contexts: BrowserContext[] = []
    let attack: NodeSocketType | undefined
    try {
      backend = await startIsolatedSvaraBackend(isolated)
      gateway = await startSvaraGateway(join(root, 'dist'), backend.port)
      const origin = `http://${host}:${gateway.port}`
      const backendOrigin = `http://127.0.0.1:${backend.port}`
      function db<T>(read: (connection: DatabaseSync) => T): T {
        const connection = new DatabaseSync(isolated.dbFile)
        try { return read(connection) } finally { connection.close() }
      }
      db((connection) => connection.prepare("UPDATE admin_settings SET setting_value='direct' WHERE setting_key='registration_verification_mode'").run())
      const users: Array<{ id: string; cookie: string; displayName: string; avatarUrl: string | null }> = []
      for (let i = 0; i < capacity + 1; i++) {
        const email = `create-${randomUUID()}@example.test`
        const response = await fetch(`${backendOrigin}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: 'SvaraCreation1!', displayName: `SC ${randomUUID().slice(0, 8)}`, gender: 'male', visitorId: randomUUID() }) })
        assert.equal(response.status, 200)
        const body = await response.json()
        const cookie = response.headers.getSetCookie().find((value) => value.startsWith('belot_session='))!.split(';')[0]!
        db((connection) => connection.prepare("UPDATE accounts SET role='admin' WHERE email=?").run(email))
        const id = body.session.profile.profileId as string
        const displayName = `Участник ${i + 1} ${randomUUID().slice(0, 4)}`
        const avatarUrl = i === 0 ? '/assets/avatars/male/male-avatar-01.webp' : null
        db((connection) => connection.prepare('UPDATE profiles SET display_name=?, avatar_url=? WHERE profile_id=?').run(displayName, avatarUrl, id))
        users.push({ id, cookie, displayName, avatarUrl })
      }
      const wallets = () => db((connection) => connection.prepare('SELECT * FROM profile_wallets ORDER BY profile_id').all())
      const beforeWallets = wallets()
      const frames: Record<string, unknown>[] = []
      const errors: string[] = []
      const sockets = new Map<Page, { opened: number; closed: number }>()
      async function open(user: typeof users[number], path = '/games/svara'): Promise<Page> {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
        contexts.push(context)
        const [name, value] = user.cookie.split('=')
        await context.addCookies([{ name: name!, value: value!, domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }])
        await context.route('**/*', (route) => new URL(route.request().url()).hostname === host ? route.continue() : route.abort())
        await context.addInitScript('globalThis.__name = (target) => target')
        await context.addInitScript(() => {
          const NativeSocket = window.WebSocket
          window.WebSocket = class extends NativeSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
              super(url, protocols)
              if (String(url).endsWith('/ws')) (window as Window & { svaraSocket?: WebSocket }).svaraSocket = this
            }
          }
        })
        const page = await context.newPage()
        const connectionCounts = { opened: 0, closed: 0 }
        sockets.set(page, connectionCounts)
        page.on('pageerror', (error) => errors.push(error.message))
        page.on('websocket', (socket) => {
          connectionCounts.opened++
          socket.on('close', () => { connectionCounts.closed++ })
          assert.equal(socket.url(), `${origin.replace('http:', 'ws:')}/ws`)
          socket.on('framesent', ({ payload }) => frames.push(JSON.parse(String(payload))))
        })
        await page.goto(origin + path, { waitUntil: 'domcontentloaded' })
        await page.getByText('Приеми всички').click({ timeout: 3000 }).catch(() => {})
        return page
      }
      const pages: Page[] = []
      for (const user of users.slice(0, capacity)) {
        const page = await open(user)
        await page.waitForSelector('[data-svara-create-open]')
        pages.push(page)
      }
      const first = pages[0]!
      await first.click('[data-svara-create-open]')
      const form = first.locator('[data-svara-create-form]')
      await form.waitFor()
      assert.equal(await form.locator('[name="capacity"]').inputValue(), '2')
      assert.equal(await form.locator('[name="entryFee"]').inputValue(), '5000')
      assert.equal(await form.locator('[name="startMode"]:checked').inputValue(), 'auto')
      assert.deepEqual(await form.locator('[name="entryFee"] option').evaluateAll((options) => options.map((option) => Number((option as HTMLOptionElement).value))), fees)
      assert.deepEqual(await form.locator('[name="entryFee"] option').allTextContents(), fees.map((fee) => `${grouped(fee)} жълтици`))
      assert.equal(await form.locator('[data-svara-create-chips]').textContent(), 'Получаваш: 500 виртуални чипа')
      assert.equal(await form.locator('input[name="entryFee"]').count(), 0)
      if (capacity === 2 && mode === 'auto') {
        for (const count of [2, 3, 4]) for (const fee of fees) {
          await form.locator('[name="capacity"]').selectOption(String(count))
          await form.locator('[name="entryFee"]').selectOption(String(fee))
          assert.equal(await form.locator('[name="entryFee"] option:checked').textContent(), `${grouped(fee)} жълтици`)
          assert.equal(await form.locator('[data-svara-create-chips]').textContent(), `Получаваш: ${grouped(fee / 10)} виртуални чипа`)
          assert.equal(await form.locator('[data-svara-create-ante]').textContent(), `Анте за раздаване: ${grouped(fee / 1000)} чипа`)
          assert.equal(await form.locator('[data-svara-create-prize]').textContent(), `Изчислена тестова награда: ${grouped(fee * count * 4 / 5)} жълтици (не се изплаща)`)
        }
        // Compare the actual Ludo dialog, read-only; never create a Ludo room.
        const ludo = await open(users.at(-1)!, '/games/ludo')
        await ludo.locator('[data-ludo-create-open]').click()
        const style = (element: HTMLElement) => {
          const css = getComputedStyle(element)
          // CSS zoom quantizes Ludo's computed border and subpixel width;
          // compare its declared border and the rounded intended CSS width.
          return { background: css.backgroundColor, borderColor: css.borderColor, borderStyle: css.borderStyle,
            borderWidth: element.style.borderWidth, radius: css.borderRadius, padding: css.padding, width: Math.round(parseFloat(css.width)) }
        }
        const reference = await ludo.locator('[data-ludo-create-form]').evaluate(style)
        const actual = await first.locator('[data-svara-create-panel]').evaluate(style)
        assert.deepEqual(actual, reference, 'Svara modal differs from Ludo panel styles')
        assert.equal(await form.locator('[name="capacity"]').inputValue(), '4', 'Parent refresh lost the draft')
        assert.equal(await form.locator('[name="entryFee"]').inputValue(), '200000', 'Parent refresh lost the entry')
        assert.equal(await first.locator('body > dialog[data-svara-create-backdrop]').count(), 1, 'Dialog ownership leaked or remained inside the zoomed shell')
        await ludo.context().close()
        for (const [width, height] of [[1280, 900], [390, 844], [844, 390], [320, 568]]) {
          await first.setViewportSize({ width: width!, height: height! })
          const bounds = await first.locator('[data-svara-create-panel]').evaluate((element) => {
            const rect = element.getBoundingClientRect()
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, overflow: element.scrollWidth > element.clientWidth }
          })
          assert(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= width! && bounds.bottom <= height! && !bounds.overflow)
          assert.equal(Math.round(bounds.width), Math.min(420, width! - 28), 'Shell scaling made the modal too small')
          await form.locator('[data-svara-create-close]').scrollIntoViewIfNeeded()
          assert(await form.locator('[data-svara-create-close]').isVisible())
          await first.screenshot({ path: join(artifacts, `create-${width}x${height}.png`) })
        }
        await first.setViewportSize({ width: 1280, height: 900 })
        await form.locator('[data-svara-create-close]').click()
        assert.equal(await first.locator('[data-svara-create-backdrop]').count(), 0, 'Cancel leaked the body dialog')
        assert.equal(frames.filter((frame) => frame.type === 'create_svara_table').length, 0, 'Cancel sent a command')
        await first.click('[data-svara-create-open]')
        await form.waitFor()
        await first.keyboard.press('Escape')
        assert.equal(await first.locator('[data-svara-create-backdrop]').count(), 0, 'Escape did not release the modal')
        await first.click('[data-svara-create-open]')
        await form.waitFor()
        await first.screenshot({ path: join(artifacts, 'create-default.png') })
        await form.locator('[name="entryFee"]').selectOption('150000')
        assert.equal(await form.locator('[data-svara-create-chips]').textContent(), 'Получаваш: 15\u00a0000 виртуални чипа')
        assert.equal(await form.locator('[data-svara-create-ante]').textContent(), 'Анте за раздаване: 150 чипа')
        await first.screenshot({ path: join(artifacts, 'create-150000.png') })
      }
      // Real authenticated WS attacks use a separate profile and socket.
      attack = new NodeSocket(`ws://127.0.0.1:${backend.port}/ws`, { headers: { Cookie: users.at(-1)!.cookie } })
      await new Promise<void>((done, reject) => { attack!.once('open', done); attack!.once('error', reject) })
      const attackFrames: Array<{ type: string; requestId?: string; code?: string }> = []
      attack.on('message', (data) => attackFrames.push(JSON.parse(String(data))))
      async function rejected(extra: Record<string, unknown>, code = 'invalid_input') {
        const requestId = randomUUID()
        attack!.send(JSON.stringify({ type: 'create_svara_table', requestId, capacity: 2, entryFee: 5000, startMode: 'auto', ...extra }))
        await waitForHarnessCondition('real WS rejects tampering', () => attackFrames.some((frame) => frame.type === 'svara_lobby_error' && frame.code === code && frame.requestId === requestId), 5000)
        attackFrames.length = 0
      }
      if (capacity === 2 && mode === 'auto') {
        for (const entryFee of [1000, 10000, 5100, 200010]) await rejected({ entryFee })
        for (const entryPercent of [5, 2, 3, 0, '1']) await rejected({ entryPercent })
        assert.equal(db((connection) => connection.prepare('SELECT COUNT(*) AS n FROM svara_match_snapshots').get()!.n), 0)
      }
      const fee = fees[passed === 5 ? 12 : passed]!
      await form.locator('[name="capacity"]').selectOption(String(capacity))
      await form.locator('[name="entryFee"]').selectOption(String(fee))
      await form.locator(`[name="startMode"][value="${mode}"]`).check()
      await form.locator('button[type="submit"]').click()
      await first.locator('[data-svara-table-leave]').waitFor()
      const read = () => db((connection) => {
        const row = connection.prepare('SELECT snapshot_json FROM svara_match_snapshots').get() as { snapshot_json: string }
        return JSON.parse(row.snapshot_json)
      })
      const matchId = read().matchId as string
      async function checkWaiting(page: Page, participants: typeof users, viewport?: { width: number; height: number }) {
        if (viewport) await page.setViewportSize(viewport)
        const waiting = page.locator('[data-svara-waiting="1"]')
        await waiting.waitFor()
        assert.equal((await waiting.locator('[data-svara-waiting-entry]').innerText()).replace(/\n/g, ' '), `Вход: ${grouped(fee)} жълтици`)
        assert.equal((await waiting.locator('[data-svara-waiting-prize]').innerText()).replace(/\n/g, ' '), `Тестова награда: ${grouped(fee * capacity * 4 / 5)} жълтици (Не се изплаща)`)
        await waitForHarnessCondition('live participant rendering', async () => await waiting.locator('[data-svara-waiting-seat]').count() === participants.length, 5000)
        for (const user of participants) {
          const seat = waiting.locator(`[data-svara-waiting-seat="${user.id}"]`)
          assert.equal(await seat.locator('[data-svara-player-name]').textContent(), user.displayName)
          assert.equal(await seat.locator('[data-svara-player-name]').evaluate((element) => element.scrollWidth > element.clientWidth + 1), false, 'A short profile name was unnecessarily truncated')
          assert.equal(await seat.locator('[data-svara-creator]').count(), user.id === users[0]!.id ? 1 : 0)
          assert.equal(await seat.locator('[data-svara-player-status]').textContent(), 'активен')
          if (user.avatarUrl) {
            const avatar = seat.locator('[data-svara-player-avatar]')
            assert.equal(await avatar.getAttribute('src'), user.avatarUrl)
            await avatar.evaluate((element) => (element as HTMLImageElement).decode())
            const shape = await avatar.evaluate((element) => { const rect = element.getBoundingClientRect(); return [rect.width, rect.height] })
            assert(Math.abs(shape[0]! - shape[1]!) < 0.5, 'Avatar is not square')
          } else assert.equal(await seat.locator('[data-svara-avatar-placeholder]').textContent(), user.displayName[0]!.toUpperCase())
        }
        assert.equal(await waiting.getByText('Свободно място', { exact: true }).count(), capacity - participants.length)
        for (const coin of await waiting.locator('img[src="/assets/lobby/icon-coin.png"]').all()) await coin.evaluate((element) => (element as HTMLImageElement).decode())
        assert.equal(await waiting.locator('img[src="/assets/lobby/icon-coin.png"]').count(), 2)
        const overflow = await waiting.evaluate((element) => element.scrollWidth > element.clientWidth + 1)
        assert.equal(overflow, false, 'Waiting table content overflows')
      }
      async function checkProfile(page: Page, user: typeof users[number], target: 'name' | 'avatar') {
        const before = read()
        const connectionCounts = { ...sockets.get(page)! }
        const commands = frames.filter((frame) => ['create_svara_table', 'join_svara_table', 'leave_svara_table', 'start_svara_table', 'submit_svara_command'].includes(String(frame.type))).length
        const profile = page.locator(`[data-svara-profile-id="${user.id}"]`)
        await (target === 'name' ? profile.locator('[data-svara-player-name]') : profile.locator('[data-svara-player-avatar], [data-svara-avatar-placeholder]')).click()
        const popup = page.locator('[data-player-profile-popup-root="1"]')
        await popup.waitFor()
        assert.equal((await popup.locator('[data-player-profile-title="1"] > div').first().textContent())?.trim(), user.displayName)
        await popup.locator('[data-player-profile-popup-close="1"]').click()
        await popup.waitFor({ state: 'detached' })
        await page.locator('[data-svara-waiting="1"]').waitFor()
        assert.equal(new URL(page.url()).pathname, '/games/svara')
        assert.deepEqual(sockets.get(page), connectionCounts, 'Opening a profile interrupted the native WS')
        assert.deepEqual(read(), before, 'Opening a profile mutated the waiting table')
        assert.equal(frames.filter((frame) => ['create_svara_table', 'join_svara_table', 'leave_svara_table', 'start_svara_table', 'submit_svara_command'].includes(String(frame.type))).length, commands)
      }
      await checkWaiting(first, [users[0]!])
      await checkProfile(first, users[0]!, 'avatar')
      const waiting = read()
      await first.reload({ waitUntil: 'domcontentloaded' })
      await first.locator('[data-svara-table-leave]').waitFor()
      assert.deepEqual(read(), waiting, 'Waiting refresh changed the table')
      await checkWaiting(first, [users[0]!])
      await Promise.all(pages.slice(1).map((page) => page.locator(`[data-svara-table-join="${matchId}"]`).click()))
      await waitForHarnessCondition('all real UI joins are durable', () => read().state.seats.length === capacity, 5000)
      if (mode === 'manual') {
        for (const page of pages) await checkWaiting(page, users.slice(0, capacity))
        await checkProfile(first, users[1]!, 'name')
        await checkProfile(pages[1]!, users[0]!, 'avatar')
        if (capacity === 2) {
          // Existing block policy remains authoritative, even for a known seat.
          const before = read()
          const connectionCounts = { ...sockets.get(first)! }
          db((connection) => connection.prepare('INSERT INTO player_blocks (blocker_profile_id, blocked_profile_id) VALUES (?, ?)').run(users[1]!.id, users[0]!.id))
          await first.locator(`[data-svara-profile-id="${users[1]!.id}"]`).click()
          const blocked = first.locator('[data-profile-access-block-popup-root="1"]')
          await blocked.waitFor()
          assert((await blocked.innerText()).includes('Този потребител ви е блокирал.'))
          assert.equal(await first.locator('[data-player-profile-popup-root="1"]').count(), 0)
          await blocked.locator('[data-profile-access-block-close="1"]').last().click()
          await blocked.waitFor({ state: 'detached' })
          assert.deepEqual(sockets.get(first), connectionCounts)
          assert.deepEqual(read(), before)
          db((connection) => connection.prepare('DELETE FROM player_blocks WHERE blocker_profile_id=? AND blocked_profile_id=?').run(users[1]!.id, users[0]!.id))
        }
        for (const [width, height] of [[1280, 900], [390, 844], [844, 390]]) {
          await checkWaiting(first, users.slice(0, capacity), { width: width!, height: height! })
          await first.screenshot({ path: join(artifacts, `waiting-${capacity}-${width}x${height}.png`) })
          await checkProfile(first, users[1]!, 'name')
        }
        await first.setViewportSize({ width: 1280, height: 900 })
        const member = pages[1]!
        await member.locator('[data-svara-table-leave]').click()
        await member.locator('[data-svara-create-open]').waitFor()
        await checkWaiting(first, users.slice(0, capacity).filter((user) => user.id !== users[1]!.id))
        await member.locator(`[data-svara-table-join="${matchId}"]`).click()
        await checkWaiting(first, users.slice(0, capacity))
        const waitingBeforeReconnect = read()
        await first.reload({ waitUntil: 'domcontentloaded' })
        await checkWaiting(first, users.slice(0, capacity))
        await checkProfile(first, users[1]!, 'name')
        await first.evaluate(() => (window as Window & { svaraSocket?: WebSocket }).svaraSocket!.close())
        await first.waitForFunction(() => (window as Window & { svaraSocket?: WebSocket }).svaraSocket?.readyState === 1, undefined, { timeout: 15000 })
        await checkWaiting(first, users.slice(0, capacity))
        await checkProfile(first, users[1]!, 'name')
        assert.deepEqual(read(), waitingBeforeReconnect, 'Waiting refresh/reconnect changed the stored table')
        assert.equal(read().state.phase, 'lobby')
        const before = read()
        const requestId = randomUUID()
        attack.send(JSON.stringify({ type: 'start_svara_table', requestId, matchId }))
        await waitForHarnessCondition('outsider cannot start', () => attackFrames.some((frame) => frame.type === 'svara_lobby_error' && frame.requestId === requestId), 5000)
        assert.deepEqual(read(), before)
        assert.equal(await pages[1]!.locator('[data-svara-table-start]').count(), 0)
        await first.locator('[data-svara-table-start]:not([disabled])').click()
      }
      await waitForHarnessCondition('server started', () => read().state.phase === 'in-progress', 5000)
      for (const page of pages) await page.locator('[data-svara-diagnostics]').waitFor()
      let stored = read()
      assert.equal(stored.state.config.startMode, mode)
      assert.equal(stored.state.startingChips, fee / 10)
      assert.equal(stored.state.config.entryPercent, 1)
      assert.equal(stored.state.entryChips, fee / 1000)
      assert.equal(stored.state.ledger.filter((entry: { type: string }) => entry.type === 'entry').length, capacity)
      assert(Object.values(stored.state.round.contributions).every((amount) => amount === fee / 1000))
      assert.equal(stored.state.totalChips, fee / 10 * capacity)
      const ledger = structuredClone(stored.state.ledger)
      const creates = frames.filter((frame) => frame.type === 'create_svara_table').length
      await first.evaluate(() => (window as Window & { svaraSocket?: WebSocket }).svaraSocket!.close())
      await first.waitForFunction(() => (window as Window & { svaraSocket?: WebSocket }).svaraSocket?.readyState === 1, undefined, { timeout: 15000 })
      await first.locator('[data-svara-diagnostics]').waitFor()
      stored = read()
      assert.deepEqual(stored.state.ledger, ledger, 'Reconnect repeated an ante or start')
      assert.equal(frames.filter((frame) => frame.type === 'create_svara_table').length, creates)
      assert.deepEqual(wallets(), beforeWallets, 'Virtual game changed profile wallets')
      assert.deepEqual(errors, [])
      passed++
      console.log(`PASS Chromium ${capacity} players / ${mode} / entry ${fee}: HTTP auth, waiting names/avatar/prize/profile, real concurrent WS joins, initial ante, refresh/reconnect, unchanged wallets; PID=${backend.child.pid} port=${backend.port}`)
    } finally {
      if (attack) { attack.terminate() }
      for (const context of contexts) await context.close()
      if (gateway) await gateway.close()
      if (backend) await backend.stop()
      await isolated.cleanup()
    }
  }
} finally { await browser.close() }
console.log(`PASS ${passed}/6 real creation/start scenarios; 39 previews, 13 fees, four dialog viewports; waiting tables 2/3/4 across desktop/portrait/landscape, own/other/blocked profiles, leave/rejoin, refresh and native WS reconnect`)
