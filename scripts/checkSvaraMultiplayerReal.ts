/** 2B.3.7.8B: real Chromium UI, HTTP registrations, authenticated native WS,
 * production real clock, private deterministic decks, owned SQLite ledger. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { createIsolatedSvaraRoot, runNode, startIsolatedSvaraBackend, startSvaraGateway, waitForHarnessCondition as wait } from './svaraRealIntegrationHarness'
import { assertSvaraMatchInvariants, buildSvaraDeckForHands } from '../server/src/games/svara/engine/svaraMatch'
import { svaraCardCode } from '../server/src/games/svara/engine/svaraCards'
import { createSvaraMatchSnapshotMessage, SVARA_SNAPSHOT_FORBIDDEN_KEYS } from '../server/src/games/svara/protocol/svaraSnapshotProtocol'
import type { SvaraStoredMatch } from '../server/src/games/svara/runtime/svaraPersistence'
import type { SvaraMatchSnapshotMessage, SvaraMatchTimingMessage } from '../src/app/network/createGameServerClient'
import { SVARA_CARD_BACK_SRC, svaraCardCodeToFaceSrc } from '../src/app/games/svara/table/svaraTableAssets'

const root = process.cwd(), host = 'svara-integration.localhost'
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
type Frame = Record<string, any>
type Peer = { id: string; context: BrowserContext; page: Page; frames: Frame[]; sent: Frame[]; faults: string[] }
const reports: Array<{ scenario: string; status: string; transport: string; detail?: string; evidence?: unknown }> = []
let current = '', passed = 0, failed = 0
const selection = process.argv.filter((arg) => arg.startsWith('--scenario=')).map((arg) => arg.slice('--scenario='.length))
console.log('Svara 2B.3.7.8B — real multiplayer sessions (no scenario retries)')
await runNode(root, ['node_modules/typescript/bin/tsc', '-p', 'server/tsconfig.json'])
await runNode(root, ['node_modules/vite/bin/vite.js', 'build'])
const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1', '--no-proxy-server'] })

async function scenario(label: string, count: 2 | 3 | 4, run: (session: Awaited<ReturnType<typeof game>>) => Promise<void>) {
  if (selection.length && !selection.some((part) => label.includes(part))) { reports.push({ scenario: label, status: 'not selected', transport: 'not run' }); return }
  current = label
  let g: Awaited<ReturnType<typeof game>> | undefined
  try {
    g = await game(count)
    await run(g)
    for (const p of g.peers) assert.deepEqual(p.faults, [])
    g.assertWallets()
    passed++; reports.push({ scenario: label, status: 'passed', transport: 'Chromium/HTTP/Auth/WS/SQLite', evidence: g.evidence() })
    console.log(`  PASS ${label}`)
  } catch (error) {
    failed++; const detail = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
    reports.push({ scenario: label, status: 'failed', transport: 'Chromium/HTTP/Auth/WS/SQLite', detail })
    if (g) await g.diagnostic(label)
    console.error(`  FAIL ${label}: ${detail}`)
    throw error
  } finally { if (g) await g.close() }
}

async function game(count: 2 | 3 | 4) {
  const isolated = await createIsolatedSvaraRoot(root)
  let backend: Awaited<ReturnType<typeof startIsolatedSvaraBackend>> | undefined
  let gateway: Awaited<ReturnType<typeof startSvaraGateway>> | undefined
  const peers: Peer[] = []
  let outsider: Peer | undefined
  const terminalExitEvidence: Array<Record<string, unknown>> = []
  let matchId = '', origin = ''
  const db = <T>(fn: (value: DatabaseSync) => T) => {
    const value = new DatabaseSync(isolated.dbFile)
    try { return fn(value) } finally { value.close() }
  }
  const wallets = () => db((d) => JSON.stringify(d.prepare('SELECT * FROM profile_wallets ORDER BY profile_id').all()))
  let initialWallets = ''
  function stored(): SvaraStoredMatch {
    return db((d) => {
      const row = d.prepare('SELECT snapshot_json FROM svara_match_snapshots WHERE match_id = ?').get(matchId) as { snapshot_json: string } | undefined
      assert(row, 'Match absent from owned SQLite')
      const value = JSON.parse(row.snapshot_json) as SvaraStoredMatch
      assertSvaraMatchInvariants(value.state)
      // Independent double-entry replay, including still-locked/carried money.
      const book: Record<string, number> = {}
      for (const e of value.state.ledger) { book[e.from] = (book[e.from] ?? 0) - e.amount; book[e.to] = (book[e.to] ?? 0) + e.amount }
      for (const id of value.state.seats) assert.equal(book[`stack:${id}`] ?? 0, value.state.stacks[id])
      assert.equal(-(book['buy-in'] ?? 0), value.state.totalChips)
      assert.equal(Object.values(book).reduce((a, b) => a + b, 0), 0)
      assert.equal(value.state.totalChips, count * value.state.startingChips)
      return value
    })
  }
  function snapshot(p: Peer): SvaraMatchSnapshotMessage {
    const frame = p.frames.findLast((f) => f.type === 'svara_match_snapshot' && f.matchId === matchId)
    assert(frame, 'Missing real browser WS snapshot'); return frame as SvaraMatchSnapshotMessage
  }
  function timing(p = peers[0]!): SvaraMatchTimingMessage {
    const frame = p.frames.findLast((f) => f.type === 'svara_match_timing' && f.matchId === matchId)
    assert(frame, 'Missing real browser WS timing'); return frame as SvaraMatchTimingMessage
  }
  async function sync(all = peers) {
    for (const p of all) {
      let captured: { snapshot: SvaraMatchSnapshotMessage; saved: SvaraStoredMatch; seats: Array<{ index: number; stack: number; dealer: boolean; cards: string[] }> } | undefined
      await wait('WS/DOM/SQLite same revision', async () => {
        const s = snapshot(p), saved = stored()
        if (s.revision !== saved.revision) return false
        // Capture revision and seats in one browser task. A lifecycle deadline
        // may commit between any two awaits; compare only one consistent sample.
        const view = await p.page.locator('[data-svara-lobby]').evaluateAll((roots) => {
          const root = roots[0]
          return { revision: root?.querySelector('[data-svara-diagnostics]')?.textContent?.trim(),
            seats: Array.from(root?.querySelectorAll('[data-svara-seat-index]') ?? []).map((seat) => ({
              index: Number((seat as HTMLElement).dataset.svaraSeatIndex),
              stack: Number(/^(\d+)/.exec(seat.querySelector('[data-svara-seat-total]')?.textContent?.trim() ?? '')?.[1]),
              dealer: !!seat.querySelector('[data-svara-dealer-badge]'),
              cards: Array.from(seat.querySelectorAll<HTMLImageElement>('[data-svara-seat-cards-mount] img')).map((i) => new URL(i.src).pathname),
            })) }
        })
        if (view.revision !== `rev ${s.revision}` || stored().revision !== saved.revision || snapshot(p).revision !== s.revision) return false
        captured = { snapshot: s, saved, seats: view.seats }
        return true
      }, 5000)
      assert(captured)
      const { snapshot: s, saved, seats: rendered } = captured
      assert.deepEqual(s, createSvaraMatchSnapshotMessage(matchId, saved.state, p.id))
      assert.deepEqual(p.faults, [])
      assert.equal(rendered.length, count)
      for (const seat of s.seats) {
        const view = rendered.find((v) => v.index === seat.seatIndex)!
        assert.equal(view.stack, seat.stack, 'DOM balance differs from real ledger')
        assert.equal(view.dealer, seat.isDealer)
        const publicHand = s.round?.kind === 'showdown-display' ? s.round.cards[seat.playerId]
          : s.round?.kind === 'reveal-choice' && s.round.decision === 'revealed' && s.round.winnerId === seat.playerId ? s.round.cards : null
        const allowed = publicHand ?? (seat.playerId === p.id ? s.you.cards : null) ?? []
        for (const src of view.cards) assert(src === SVARA_CARD_BACK_SRC || allowed.some((c) => svaraCardCodeToFaceSrc(c) === src), 'Unauthorized card in real DOM')
      }
    }
    assert.equal(wallets(), initialWallets, 'Virtual Svara changed yellow-coin wallets')
  }
  async function reload(p: Peer) { await p.page.reload({ waitUntil: 'domcontentloaded' }); await p.page.waitForSelector('[data-svara-diagnostics]'); await sync([p]) }
  async function reconnect(p: Peer, offline = false, active = true, retry = false) {
    const connected = p.frames.filter((f) => f.type === 'connected').length
    const offset = p.frames.length
    const sentOffset = p.sent.length
    if (offline) await p.context.setOffline(true)
    await p.page.evaluate(() => {
      const sockets = (globalThis as unknown as { __svaraSockets: WebSocket[] }).__svaraSockets
      for (const s of sockets) if (s.readyState === WebSocket.OPEN) s.close()
    })
    if (offline) {
      await pause(500)
      if (retry) await p.page.click('#offline-retry-btn')
      await p.context.setOffline(false)
    }
    await wait('native WS reconnect', () => p.frames.filter((f) => f.type === 'connected').length > connected, 10000)
    const openedAt = Date.now()
    if (!active) {
      await pause(900)
      assert.equal(await p.page.locator('[data-svara-diagnostics]').count(), 0, 'Reconnect reopened a left/unauthorized match')
      return
    }
    // A fresh snapshot alone is insufficient: the global onOpen policy can
    // schedule a navigation 300ms later. Verify the stable recovered view too.
    await wait('stable authoritative Svara recovery after WS reconnect', async () => {
      assert.equal(new URL(p.page.url()).pathname, '/games/svara', 'WS reconnect navigated away from the active Svara table')
      const fresh = p.frames.slice(offset).some((f) => f.type === 'svara_match_snapshot' && f.matchId === matchId)
      const text = await p.page.locator('[data-svara-diagnostics]').evaluateAll((nodes) => nodes[0]?.textContent?.trim())
      return fresh && text === `rev ${stored().revision}` && Date.now() - openedAt >= 800
    }, 5000)
    await wait('server confirmation removes recovery overlay', async () => await p.page.locator('#offline-retry-btn').count() === 0, 5000)
    assert(!p.sent.slice(sentOffset).some((f) => ['submit_svara_command', 'create_svara_table', 'join_svara_table', 'leave_svara_table', 'start_svara_table'].includes(f.type)), 'Recovery resent a gameplay/financial command')
    await sync([p])
  }
  async function remount(p: Peer) {
    await p.page.click('[data-svara-back-to-games]')
    await p.page.waitForURL(/\/games$/)
    await p.page.click('[data-svara-play-button]')
    await p.page.waitForSelector('[data-svara-diagnostics]')
    await sync([p])
  }
  async function restart(crash: boolean) {
    const old = backend!, before = stored(), connections = peers.map((p) => p.frames.filter((f) => f.type === 'connected').length)
    const sentOffsets = peers.map((p) => p.sent.length)
    // No upstream requests may reach a freed/unverified port during restart.
    backend = undefined
    if (crash) await old.crash()
    else await old.stop()
    backend = await startIsolatedSvaraBackend(isolated, { deckControl: true })
    assert.notEqual(backend.child.pid, old.child.pid)
    await wait('real Chromium reconnects to the verified restarted backend', () => peers.every((p, i) => p.frames.filter((f) => f.type === 'connected').length > connections[i]!), 12000)
    await pause(800)
    for (const [i, p] of peers.entries()) {
      assert.equal(new URL(p.page.url()).pathname, '/games/svara')
      assert(!p.sent.slice(sentOffsets[i]).some((f) => ['submit_svara_command', 'create_svara_table', 'join_svara_table', 'leave_svara_table', 'start_svara_table'].includes(f.type)), 'Restart recovery resent a game command')
    }
    await sync()
    assert.deepEqual(stored(), before, 'Restart changed cards, ledger or absolute turn deadline')
  }
  async function click(p: Peer, selector: string) {
    const rev = stored().revision
    // The production countdown replaces button nodes frequently. Resolve and
    // activate the visible enabled UI control in one browser task; no pointer
    // stability retry may consume the real 15s turn. Still the actual UI handler.
    await p.page.evaluate((query) => {
      const button = document.querySelector<HTMLButtonElement>(query)
      if (!button || !button.isConnected || button.disabled || !button.getClientRects().length) throw new Error(`Unavailable UI button ${query}`)
      button.click()
    }, selector)
    await wait(`server accepted UI ${selector}`, () => stored().revision > rev, 5000)
    await sync()
  }
  const actor = () => { const id = snapshot(peers[0]!).seats.find((s) => s.isToAct)?.playerId; assert(id, 'No authoritative actor'); return peers.find((p) => p.id === id)! }
  async function action(kind: string) { const p = actor(); await click(p, `[data-svara-action-button="${kind}"]`); return p }
  async function betting() { await wait('real dealing ends', () => { const r = stored().state.round; return !!r && (r.kind === 'ordinary' || r.kind === 'svara') && !r.dealing }, 8000); await sync() }
  const deck = (hands: string[], dealer = 0, participants = peers.map((_, i) => i)) => {
    const ids = peers.map((p) => p.id), order = [...ids.slice(dealer + 1), ...ids.slice(0, dealer + 1)]
    const selected = order.filter((id) => participants.includes(ids.indexOf(id)))
    return buildSvaraDeckForHands(selected, Object.fromEntries(selected.map((id) => [id, hands[ids.indexOf(id)]!]))).map(svaraCardCode)
  }
  async function start(decks: string[][]) {
    await backend!.queueDecks(decks)
    await peers[0]!.page.click('[data-svara-create-open]')
    await peers[0]!.page.selectOption('[data-svara-create-form] select[name="capacity"]', String(count))
    await peers[0]!.page.fill('[data-svara-create-form] input[name="entryFee"]', '1000')
    await peers[0]!.page.click('[data-svara-create-form] button[type="submit"]')
    await wait('real created table', () => !!peers[0]!.frames.findLast((f) => f.type === 'svara_table_updated'), 5000)
    matchId = peers[0]!.frames.findLast((f) => f.type === 'svara_table_updated')!.table.matchId
    for (const p of peers.slice(1)) await p.page.locator(`[data-svara-table-join="${matchId}"]`).click()
    await peers[0]!.page.locator('[data-svara-table-start]:not([disabled])').click()
    for (const p of peers) await p.page.waitForSelector('[data-svara-diagnostics]')
    await sync()
    const initial = stored(), r = initial.state.round
    assert(r?.kind === 'ordinary' && r.dealing)
    assert.equal(initial.state.ledger.filter((e) => e.type === 'entry').length, count)
    for (const p of peers) {
      assert.equal(initial.state.entryChips, 5)
      assert.equal(initial.state.stacks[p.id], 95); assert.equal(r.contributions[p.id], 5)
      assert.equal(await p.page.locator('[data-svara-action-button]').count(), 0)
    }
  }
  async function results(options: { showdownReconnect?: Peer; payoutReconnect?: Peer } = {}) {
    const before = stored(), r = before.state.round
    assert(r?.kind === 'showdown-display')
    const recordId = r.record?.roundId ?? before.state.history.at(-1)!.roundId
    const seen = new Set<string>()
    const bubbles = new Set<string>()
    const recoveries: Promise<void>[] = []
    let recoveryFailure: unknown
    function recoverDuringDisplay(p: Peer, saved: SvaraStoredMatch, kind: 'showdown-display' | 'payout-display') {
      const deadline = saved.deadlines.find((d) => d.kind === kind)!
      assert(deadline && Date.now() < deadline.deadlineAt, `Reconnect did not start during ${kind}`)
      recoveries.push((async () => {
        await reconnect(p)
        const after = stored(), live = after.deadlines.find((d) => d.kind === kind)
        if (live?.roundId === deadline.roundId) assert.equal(live.deadlineAt, deadline.deadlineAt)
        else assert(Date.now() >= deadline.deadlineAt, `${kind} ended before its real deadline`)
        assert.deepEqual(after.state.ledger.slice(0, saved.state.ledger.length), saved.state.ledger, 'Recovery changed committed ledger entries')
        assert.deepEqual(after.state.ledger.filter((e) => e.roundId === recordId), saved.state.ledger.filter((e) => e.roundId === recordId), 'Recovery repeated a result payment')
      })().catch((error) => { recoveryFailure = error }))
    }
    if (options.showdownReconnect) {
      recoverDuringDisplay(options.showdownReconnect, before, 'showdown-display')
    }
    let payoutReloaded = false
    const end = Date.now() + 20000
    while (stored().state.round?.kind === 'showdown-display' && stored().state.round?.roundId === r.roundId) {
      assert(Date.now() < end, 'Authoritative result phase did not close at its deadline')
      if (recoveryFailure) throw recoveryFailure
      for (const p of peers) {
        const observation = await p.page.locator('[data-svara-lobby]').evaluateAll((roots) => ({
          key: roots[0]?.querySelector('[data-svara-active-pot]')?.getAttribute('data-svara-active-pot'),
          bubbles: Array.from(roots[0]?.querySelectorAll<HTMLElement>('[data-svara-seat-index]') ?? []).map((seat) => ({
            index: Number(seat.dataset.svaraSeatIndex), text: seat.querySelector('[data-svara-win-bubble]')?.textContent ?? '',
          })),
        }))
        const key = observation.key
        if (key) {
          const step: (typeof r.payoutSteps)[number] = r.payoutSteps.find((candidate) => candidate.potId === key)!
          if (!step && stored().state.round?.roundId !== r.roundId) break
          assert(step, 'UI paid an unknown pot')
          seen.add(key)
          for (const id of step.winners) {
            const amount: number = step.share ?? step.amount
            const index = before.state.seats.indexOf(id)
            const text = observation.bubbles.find((bubble) => bubble.index === index)?.text ?? ''
            if (text) { assert.equal(text, `Печеля ${amount}!`); bubbles.add(`${step.potId}:${id}`) }
          }
          if (options.payoutReconnect && !payoutReloaded) {
            payoutReloaded = true
            recoverDuringDisplay(options.payoutReconnect, stored(), 'payout-display')
          }
        }
      }
      await pause(60)
    }
    await Promise.all(recoveries)
    if (recoveryFailure) throw recoveryFailure
    for (const step of r.payoutSteps) {
      assert(seen.has(step.potId), `Payout step missing from actual DOM: ${step.potId}`)
      for (const id of step.winners) assert(bubbles.has(`${step.potId}:${id}`), `Missing actual winner bubble: ${step.potId}`)
    }
    await sync()
  }
  async function allInToEnd(maxDeals = 5) {
    for (let n = 0; n < maxDeals && stored().state.phase !== 'finished'; n++) {
      await betting()
      for (let i = 0; i < count + 1 && ['ordinary', 'svara'].includes(stored().state.round?.kind ?? ''); i++) {
        const p = actor()
        if (!snapshot(p).you.looked) await action('look')
        await action('all-in')
      }
      await results()
    }
    const final = stored().state
    assert.equal(final.phase, 'finished', 'One deal is not a completed match')
    assert.equal(final.lockedPots.length, 0); assert.equal(final.carried.length, 0)
    assert.equal(Object.values(final.stacks).reduce((a, b) => a + b, 0) + final.removedChips, count * 100)
    return final
  }
  async function close() {
    try { for (const p of [...peers, ...(outsider ? [outsider] : [])]) await p.context.close() }
    finally { try { if (gateway) await gateway.close() } finally { try { if (backend) await backend.stop() } finally { await isolated.cleanup() } } }
  }
  async function raw(p: Peer, message: Frame, predicate = (f: Frame) => !!message.requestId && f.requestId === message.requestId || !!message.commandId && f.commandId === message.commandId) {
    const offset = p.frames.length
    await p.page.evaluate((value) => {
      const sockets = (globalThis as unknown as { __svaraSockets: WebSocket[] }).__svaraSockets
      const socket = sockets.findLast((s) => s.readyState === WebSocket.OPEN && s.url.endsWith('/ws'))
      if (!socket) throw new Error('No native authenticated browser socket')
      socket.send(JSON.stringify(value))
    }, message)
    await wait('real server response', () => p.frames.slice(offset).some(predicate), 5000)
    return p.frames.slice(offset).find(predicate)!
  }
  const archive = () => db((d) => JSON.stringify(d.prepare('SELECT * FROM svara_match_snapshots WHERE match_id = ?').get(matchId)))
  async function leave(options: { concurrent?: boolean; delayed?: boolean } = {}) {
    const before = stored().state
    const archived = archive()
    assert.equal(before.phase, 'finished')
    const denied = await raw(outsider!, { type: 'leave_svara_table', matchId, requestId: randomUUID() })
    assert.equal(denied.code, 'not_a_participant'); assert.equal(archive(), archived)
    // Still-open result survives a real page/WS reconnect before dismissal.
    await reload(peers[0]!)
    await reconnect(peers[0]!)
    const requests: Frame[] = []
    const exit = async (p: Peer) => {
      const offset = p.frames.length
      await p.page.locator('[data-svara-table-leave]').click()
      await wait('actual UI leave command sent', () => p.sent.some((f) => f.type === 'leave_svara_table' && f.matchId === matchId), 5000)
      const request = p.sent.findLast((f) => f.type === 'leave_svara_table' && f.matchId === matchId)!
      requests.push(request)
      await wait('actual server leave response', () => p.frames.slice(offset).some((f) => f.requestId === request.requestId), 5000)
      const reply = p.frames.slice(offset).find((f) => f.requestId === request.requestId)!
      terminalExitEvidence.push({ playerId: p.id, phase: before.phase, request, reply,
        activeTableRemains: await p.page.locator('[data-svara-diagnostics]').count() > 0,
        ledgerUnchanged: JSON.stringify(stored().state.ledger) === JSON.stringify(before.ledger) })
      assert.equal(reply.type, 'svara_table_left')
      await wait('real exit clears this table', async () => await p.page.locator('[data-svara-diagnostics]').count() === 0, 5000)
      assert.equal(archive(), archived, 'Finished SQL row/metadata changed on exit')
    }
    if (options.concurrent) await Promise.all(peers.map(exit))
    else {
      await exit(peers[0]!)
      await sync(peers.slice(1))
      assert((await backend!.runtimeStatus()).matchIds.includes(matchId), 'Review was released while other participants still view it')
      const repeat = await raw(peers[0]!, requests[0]!)
      assert.equal(repeat.type, 'svara_table_left'); assert.equal(archive(), archived)
      await peers[0]!.page.reload({ waitUntil: 'domcontentloaded' })
      await peers[0]!.page.waitForSelector('[data-svara-lobby]')
      assert.equal(await peers[0]!.page.locator('[data-svara-diagnostics]').count(), 0, 'Reconnect reopened a dismissed result')
      for (const p of peers.slice(1)) await exit(p)
    }
    assert(!(await backend!.runtimeStatus()).matchIds.includes(matchId), 'Last exit did not release finished runtime resources')
    assert.deepEqual(stored().state.stacks, before.stacks, 'Finished match exit changed balances')
    assert(terminalExitEvidence.every((e) => (e.reply as Frame).type === 'svara_table_left'),
      `Finished match UI exit rejected: ${terminalExitEvidence.map((e) => (e.reply as Frame).code).join(', ')}; expected svara_table_left`)
    for (const p of peers) await wait('explicit real UI exit clears active table', async () => await p.page.locator('[data-svara-diagnostics]').count() === 0, 5000)
    assert.equal((await raw(peers[0]!, requests[0]!)).type, 'svara_table_left', 'Released archive retry is not idempotent')
    if (options.delayed) {
      await peers[0]!.page.click('[data-svara-create-open]')
      await peers[0]!.page.click('[data-svara-create-form] button[type="submit"]')
      await peers[0]!.page.waitForSelector('[data-svara-table-leave]')
      const offset = peers[0]!.frames.length
      await raw(peers[0]!, requests[0]!, (f) => f.type === 'svara_tables_list')
      assert(!peers[0]!.frames.slice(offset).some((f) => f.type === 'svara_table_left'), 'Delayed old exit dismissed a newer table')
      assert.equal(await peers[0]!.page.locator('[data-svara-table-leave]').count(), 1)
    }
    assert.equal(archive(), archived)
  }
  try {
    backend = await startIsolatedSvaraBackend(isolated, { deckControl: true })
    gateway = await startSvaraGateway(join(root, 'dist'), () => backend?.port ?? null)
    origin = `http://${host}:${gateway.port}`
    db((d) => d.prepare("UPDATE admin_settings SET setting_value='direct' WHERE setting_key='registration_verification_mode'").run())
    for (let i = 0; i <= count; i++) {
      const email = `svara-multi-${randomUUID()}@example.test`
      const response: Response = await fetch(`http://127.0.0.1:${backend.port}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'SvaraMultiplayer1!', displayName: `SM${randomUUID().slice(0, 8)}`, gender: 'male', visitorId: randomUUID() }) })
      assert.equal(response.status, 200)
      const body = await response.json() as { session: { profile: { profileId: string } } }
      const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!, id = body.session.profile.profileId
      db((d) => { assert(d.prepare('SELECT profile_id FROM account_sessions WHERE profile_id = ?').get(id)); d.prepare("UPDATE accounts SET role='admin' WHERE email=?").run(email) })
      const context = await browser.newContext({ viewport: { width: 420, height: 900 } })
      const separator = cookie.indexOf('=')
      await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }])
      await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
      // Observe native sockets for negative/retry protocol tests; no server
      // frame interception or replacement. Positive actions use the real UI.
      await context.addInitScript(`globalThis.__name = (target) => target; globalThis.__svaraSockets = [];
        globalThis.__svaraHold = false; globalThis.__svaraHeld = [];
        const Native = WebSocket;
        globalThis.WebSocket = new Proxy(Native, { construct(target, args) {
          const socket = new target(...args); globalThis.__svaraSockets.push(socket);
          const listen = socket.addEventListener.bind(socket);
          socket.addEventListener = (type, listener, options) => listen(type, type !== 'message' ? listener : (event) => {
            const deliver = () => typeof listener === 'function' ? listener.call(socket, event) : listener.handleEvent(event);
            const frame = JSON.parse(event.data);
            if (globalThis.__svaraHold && ['svara_match_snapshot', 'svara_match_timing'].includes(frame.type)) globalThis.__svaraHeld.push(deliver);
            else deliver();
          }, options);
          return socket;
        } });`)
      const page = await context.newPage(), peer: Peer = { id, context, page, frames: [], sent: [], faults: [] }
      peers.push(peer)
      page.on('pageerror', (e) => peer.faults.push(e.message))
      page.on('websocket', (socket) => {
        if (socket.url() !== `${origin.replace('http:', 'ws:')}/ws`) peer.faults.push('Foreign WebSocket origin')
        socket.on('framereceived', ({ payload }) => {
          try {
            const frame: Frame = JSON.parse(String(payload))
            if (String(frame.type).startsWith('svara_')) {
              const inspect = (v: unknown): void => { if (v && typeof v === 'object') for (const [key, nested] of Object.entries(v)) { assert(!SVARA_SNAPSHOT_FORBIDDEN_KEYS.includes(key)); inspect(nested) } }
              inspect(frame)
            }
            peer.frames.push(frame)
          } catch { peer.faults.push('Invalid/private frame') }
        })
        socket.on('framesent', ({ payload }) => { try { peer.sent.push(JSON.parse(String(payload))) } catch { peer.faults.push('Invalid command') } })
      })
      await page.goto(`${origin}/games/svara`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-svara-lobby="1"]')
      await page.getByText('Приеми всички').click({ timeout: 2000 }).catch(() => {})
    }
    outsider = peers.pop()!
    assert.equal(new Set(peers.map((p) => p.id)).size, count)
    initialWallets = wallets()
    return { peers, stored, snapshot, timing, sync, click, actor, action, betting, deck, start, results, reload, reconnect, remount, restart, allInToEnd, close, leave, raw,
      evidence: () => {
        const saved = stored()
        return { pid: backend!.child.pid, port: backend!.port, dbFile: isolated.dbFile, matchId, revision: saved.revision,
          phase: saved.state.phase, stacks: peers.map((p) => saved.state.stacks[p.id]), totalChips: saved.state.totalChips,
          removedChips: saved.state.removedChips, ledgerEntries: saved.state.ledger.length, historyRounds: saved.state.history.length }
      },
      revokeAccess: (p: Peer) => db((d) => { assert.equal(d.prepare("UPDATE accounts SET role='player' WHERE account_id IN (SELECT account_id FROM account_sessions WHERE profile_id=?)").run(p.id).changes, 1) }),
      queue: (decks: string[][]) => backend!.queueDecks(decks),
      assertWallets: () => assert.equal(wallets(), initialWallets),
      diagnostic: async (label: string) => {
        await mkdir(join(root, 'tmp/svara-multiplayer'), { recursive: true })
        const state = matchId ? stored() : null
        const browsers = peers.map((p) => ({ playerId: p.id, url: p.page.url(), recentFrames: p.frames.filter((f) => f.type === 'connected' || String(f.type).startsWith('svara_')).slice(-18).map((f) => ({ type: f.type, matchId: f.matchId, revision: f.revision, phase: f.phase, code: f.code })) }))
        await writeFile(join(root, 'tmp/svara-multiplayer/failure.log'), JSON.stringify({ label, pid: backend?.child.pid, port: backend?.port, revision: state?.revision, phase: state?.state.phase, round: state?.state.round, deadlines: state?.deadlines, stacks: state?.state.stacks, ledger: state?.state.ledger, terminalExitEvidence, browsers }, null, 2))
        for (let i = 0; i < peers.length; i++) await peers[i]!.page.screenshot({ path: join(root, `tmp/svara-multiplayer/failure-${i}.png`) })
      } }
  } catch (error) { await close(); throw error }
}

try {
  for (const count of [2, 3, 4] as const) await scenario(`${count} players: ordinary deal, next deal, all-in and complete match`, count, async (g) => {
    const hands = ['AS KS QS', 'AH 8D 9C', 'AD 8H 9S', 'AC 10D JS'].slice(0, count)
    await g.start([g.deck(hands), g.deck(hands, 1)])
    const initialDeal = g.stored().state.round!.roundId
    await g.reload(g.peers[0]!) // server dealing deadline must survive refresh
    await g.betting()
    assert.equal(g.actor().id, g.peers[1]!.id)
    await g.action('look'); await g.action('pay')
    for (let i = 1; i < count; i++) await g.action('pay')
    await g.results()
    assert.notEqual(g.stored().state.round!.roundId, initialDeal)
    assert.equal(g.stored().state.history.length, 1)
    const final = await g.allInToEnd()
    assert.equal(final.winnerId, g.peers[0]!.id)
    assert.equal(final.stacks[final.winnerId!], count * 100)
    await g.leave({ delayed: count === 2, concurrent: count === 4 })
  })
  await scenario('2 players: simultaneous finished exit releases runtime and preserves archive', 2, async (g) => {
    await g.start([g.deck(['AS KS QS', 'AH 8D 9C'])])
    const final = await g.allInToEnd()
    assert.equal(final.stacks[g.peers[0]!.id], 200)
    await g.leave({ concurrent: true })
  })
  for (const attempt of [1, 2, 3]) await scenario(`2 players: reconnect during betting preserves active Svara view, independent session ${attempt}`, 2, async (g) => {
    await g.start([g.deck(['AS KS QS', 'AH 8D 9C'])])
    if (attempt === 1) {
      const dealing = g.stored()
      await g.reconnect(g.peers[0]!)
      assert.deepEqual(g.stored(), dealing, 'Dealing reconnect restarted or skipped the server deadline')
    }
    await g.betting(); await g.action('look'); await g.action('pay')
    const before = g.stored()
    await g.reconnect(g.peers[1]!)
    await g.reconnect(g.peers[1]!, attempt === 3, true, attempt === 3)
    await g.reload(g.peers[1]!)
    await g.remount(g.peers[1]!)
    assert.deepEqual(g.stored(), before, 'Reconnect changed authoritative state or absolute deadline')
    assert.equal(await g.peers[1]!.page.locator('[data-svara-bet-flash], [data-svara-look-flip], [data-svara-dealing-overlay]').count(), 0, 'Recovery replayed a completed animation')
    await g.allInToEnd(); await g.leave()
    const finished = g.stored()
    await g.reconnect(g.peers[1]!, false, false)
    assert.deepEqual(g.stored(), finished, 'Reconnect after explicit exit changed the finished archive')
  })
  await scenario('2 players: revoked access during reconnect clears the old Svara view', 2, async (g) => {
    await g.start([g.deck(['AS KS QS', 'AH 8D 9C'])]); await g.betting()
    const before = g.stored()
    g.revokeAccess(g.peers[1]!)
    await g.reconnect(g.peers[1]!, false, false)
    await wait('server access rejection removes Svara view', () => new URL(g.peers[1]!.page.url()).pathname === '/games', 5000)
    assert.deepEqual(g.stored(), before, 'Access rejection mutated the match')
  })
  await scenario('2 players: reconnect across an expired turn cannot restart its server deadline', 2, async (g) => {
    await g.start([g.deck(['AS KS QS', 'AH 8D 9C']), g.deck(['AS KS QS', 'AH 8D 9C'], 1)])
    await g.betting(); await g.action('look'); await g.action('pay')
    const before = g.stored(), timedOut = g.actor(), oldRound = before.state.round!.roundId
    const deadline = before.deadlines.find((d) => d.kind === 'turn')!
    await wait('real turn deadline approaches while no client command is sent', () => Date.now() >= deadline.deadlineAt - 250, 16000)
    await g.reconnect(timedOut, true)
    const after = g.stored()
    assert(after.revision > before.revision, 'Server timeout did not progress while disconnected')
    assert(after.state.round?.kind === 'reveal-choice', 'Expired turn did not advance to the server reveal window')
    assert.equal(after.state.round.record.roundId, oldRound)
    assert(after.state.round.record.folded.includes(timedOut.id))
    assert.equal(after.state.status[timedOut.id], 'absent')
    assert.deepEqual(g.peers.map((p) => after.state.stacks[p.id]), [95, 105])
    assert(!after.deadlines.some((d) => d.kind === 'turn' && d.deadlineAt === deadline.deadlineAt), 'Expired turn deadline remained live')
    assert.equal(after.state.ledger.filter((e) => e.type === 'pot-award' && e.roundId === oldRound).length, 1, 'Timeout award repeated')
    await wait('real reveal window closes into presence wait', () => g.stored().deadlines.some((d) => d.kind === 'presence-wait'), 9000)
    const waiting = g.stored()
    await g.reconnect(timedOut)
    assert.deepEqual(g.stored(), waiting, 'Presence-wait reconnect restarted its five-minute server deadline')
  })
  await scenario('2 players: delayed original snapshot/timing cannot reopen an exited previous table', 2, async (g) => {
    await g.start([g.deck(['AS KS QS', 'AH 8D 9C'])]); await g.allInToEnd()
    const p = g.peers[0]!, before = g.stored(), oldMatch = g.snapshot(p).matchId
    // Delay only original native MessageEvents from this authenticated backend.
    // No fabricated state/frame, replacement response or public test endpoint.
    await p.page.evaluate(() => { (globalThis as any).__svaraHold = true })
    await g.raw(p, { type: 'request_svara_table_state', matchId: oldMatch }, (f) => f.type === 'svara_match_timing')
    await wait('original native snapshot and timing held', () => p.page.evaluate(() => (globalThis as any).__svaraHeld.length === 2), 2000)
    await p.page.evaluate(() => { (globalThis as any).__svaraHold = false })
    await p.page.click('[data-svara-table-leave]')
    await wait('real exit cleared old table', async () => await p.page.locator('[data-svara-diagnostics]').count() === 0, 3000)
    await p.page.click('[data-svara-create-open]'); await p.page.click('[data-svara-create-form] button[type="submit"]')
    await p.page.waitForSelector('[data-svara-table-leave]')
    const newMatch = p.frames.findLast((f) => f.type === 'svara_table_updated')!.table.matchId
    assert.notEqual(newMatch, oldMatch)
    await p.page.evaluate(() => { for (const deliver of (globalThis as any).__svaraHeld.splice(0)) deliver() })
    await pause(400)
    assert.equal(await p.page.locator('[data-svara-diagnostics]').count(), 0, 'Delayed old snapshot reopened the old active table')
    assert.equal(await p.page.locator('[data-svara-table-leave]').count(), 1, 'Delayed old frame cleared the new waiting table')
    await g.raw(p, { type: 'request_svara_table_state', matchId: newMatch }, (f) => f.type === 'svara_match_snapshot' && f.matchId === newMatch)
    assert.deepEqual(g.stored(), before, 'Delayed original messages changed the finished archive')
  })
  for (const crash of [false, true]) await scenario(`2 players: real backend ${crash ? 'crash' : 'graceful restart'}, Chromium recovery and complete match`, 2, async (g) => {
    await g.start([g.deck(['AS KS QS', 'AH 8D 9C'])])
    await g.betting(); await g.action('look'); await g.action('pay')
    await g.restart(crash)
    await g.allInToEnd(); await g.leave()
  })
  await scenario('2 players: x2/x3/x4/x5, duplicate/revision/identity guards, reveal/hide/timeout', 2, async (g) => {
    const hands = ['AS KS QS', 'AH 8D 9C']
    await g.start([0, 1, 0, 1, 0].map((dealer) => g.deck(hands, dealer)))
    for (const [i, factor] of [2, 3, 4, 5].entries()) {
      await g.betting()
      const actor = g.actor()
      if (i > 0) await g.action('look')
      const before = g.stored()
      // First deal deliberately bets blind: its minimum is twice entry.
      // Later deals look first and use the ordinary minimum, still checked
      // independently against both the snapshot and the actual debit.
      const minimum = i === 0 ? 10 : 5
      const options = g.snapshot(actor).you.betting!
      assert.equal((options.blindBet ?? options.bet)!.min, minimum)
      await g.action(`x${factor}`)
      const command = actor.sent.findLast((f) => f.type === 'submit_svara_command')!, after = g.stored()
      assert.equal(before.state.stacks[actor.id]! - after.state.stacks[actor.id]!, minimum * factor)
      assert.equal(command.command.action.total, minimum * factor)
      if (i === 0) {
        assert.equal((await g.raw(actor, command)).status, 'duplicate'); assert.deepEqual(g.stored(), after)
        const base = { ...command, commandId: randomUUID(), expectedRevision: after.revision }
        assert.equal((await g.raw(actor, { ...base, profileId: g.actor().id, command: { type: 'look' } })).code, 'not_your_turn')
        assert.deepEqual(g.stored(), after, 'Forged identity mutated state')
        assert.equal((await g.raw(g.actor(), { ...base, commandId: randomUUID(), command: { type: 'look' }, expectedRevision: after.revision - 1 })).code, 'stale_action')
        assert.deepEqual(g.stored(), after, 'Stale revision mutated state')
        assert.equal((await g.raw(actor, { ...command, command: { type: 'act', action: { kind: 'fold' } } })).code, 'command_id_conflict')
        assert.deepEqual(g.stored(), after)
        for (const total of [1, 100000]) {
          const bad = await g.raw(g.actor(), { ...base, commandId: randomUUID(), command: { type: 'act', action: { kind: 'blind-bet', total } } })
          assert.equal(bad.type, 'svara_command_error'); assert.deepEqual(g.stored(), after, 'Illegal amount changed money')
        }
      }
      await g.action('fold')
      const choice = g.stored(), round = choice.state.round
      assert(round?.kind === 'reveal-choice' && round.winnerId === actor.id && round.decision === 'pending')
      const other = g.peers.find((p) => p.id !== actor.id)!
      assert.equal(await other.page.locator('[data-svara-decision-window]').count(), 0)
      if (i === 2) {
        const deadline = choice.deadlines.find((d) => d.kind === 'reveal-choice')!
        await g.reconnect(actor)
        assert.equal(g.stored().deadlines[0]!.deadlineAt, deadline.deadlineAt)
        await wait('real reveal-choice timeout', () => g.stored().state.round?.roundId !== round.roundId, 6500)
      } else {
        if (i === 0) await g.reload(actor)
        const sentAt = Date.now()
        await g.click(actor, `[data-svara-decision-action="${i === 1 ? 'hide' : 'reveal'}"]`)
        if (i !== 1) {
          const revealed = g.stored(), deadline = revealed.deadlines.find((d) => d.kind === 'reveal-display')!
          assert(deadline.deadlineAt >= sentAt + 2950 && deadline.deadlineAt <= Date.now() + 3000, 'Not the real 3-second reveal window')
          for (const p of g.peers) {
            const s = g.snapshot(p); assert(s.round?.kind === 'reveal-choice' && s.round.cards?.length === 3)
            await p.page.waitForSelector('[data-svara-reveal-cards]', { timeout: 1500 })
          }
          if (i === 3) await g.reconnect(other)
          else await g.reload(other)
          assert.deepEqual(g.stored().state.ledger, revealed.state.ledger, 'Refresh repeated the award')
          await wait('real 3-second reveal ends', () => g.stored().state.round?.roundId !== round.roundId, 4500)
        }
      }
      assert.equal(g.stored().state.ledger.filter((e) => e.type === 'pot-award' && e.roundId === round.record.roundId).length, 1)
    }
    await g.allInToEnd(); await g.leave()
  })
  for (const allinTie of [false, true]) await scenario(`4 players: main/side banks${allinTie ? ', all-in Svara' : ', different winners'}`, 4, async (g) => {
    const warmup = ['AH 8D 9C', 'AS KS QS', 'AD 8H 9S', 'AC 10D JS']
    const decided = ['KH QH JH', 'AD 8H 9S', 'AS KS QS', 'AC 10D JS']
    const tie = ['AS 8H 9D', 'AH 8D 9C', 'AD 8C 9H', 'AC 10D JS']
    await g.start([g.deck(warmup), g.deck(allinTie ? tie : decided, 1), ...(allinTie ? [g.deck(decided, -1)] : [])])
    await g.betting(); await g.action('look'); await g.action('x4'); await g.action('pay'); await g.action('fold'); await g.action('fold')
    await g.results(); await g.betting()
    assert.deepEqual(g.peers.map((p) => g.stored().state.stacks[p.id]), [90, 130, 70, 90])
    for (let i = 0; i < 4; i++) {
      if (!g.snapshot(g.actor()).you.looked) await g.action('look')
      await g.action('all-in')
    }
    const settled = g.stored(), round = settled.state.round
    assert(round?.kind === 'showdown-display')
    assert.deepEqual(round.record!.pots.map((p) => p.amount), [300, 60, 40])
    assert.deepEqual(round.record!.pots.map((p) => p.eligible.length), [4, 3, 1])
    assert.equal(round.record!.pots[2]!.outcome.kind, 'uncalled-return')
    if (allinTie) {
      assert.deepEqual(settled.state.lockedPots.map((p) => [p.kind, p.amount]), [['allin', 300], ['allin', 60]])
      for (const p of g.peers) {
        assert.equal(await p.page.locator('[data-svara-decision-window="joining"]').count(), 0)
        assert.equal(await p.page.locator('[data-svara-tie]').count(), 1)
      }
      await g.results()
      const resolved = g.stored(), display = resolved.state.round
      assert(display?.kind === 'showdown-display')
      assert.equal(resolved.state.history.at(-1)!.kind, 'allin-svara')
      assert.equal(resolved.state.lockedPots.length, 0)
      assert.deepEqual(display.payoutSteps.map((p) => [p.amount, p.winners[0]]), [[300, g.peers[2]!.id], [60, g.peers[0]!.id]])
    } else {
      assert.equal(settled.state.lockedPots.length, 0)
      assert.deepEqual(round.payoutSteps.map((p) => [p.amount, p.winners[0]]), [[300, g.peers[2]!.id], [60, g.peers[0]!.id]])
    }
    await g.queue([g.deck(['AH 8D 9C', 'AD 8H 9S', 'AS KS QS', 'AC 10D JS'], 2, [0, 1, 2])])
    await g.results({ showdownReconnect: g.peers[2], payoutReconnect: g.peers[0] })
    assert.equal(g.stored().state.removedChips, 0)
    const final = await g.allInToEnd()
    assert.equal(final.stacks[g.peers[2]!.id], 400)
    await g.leave()
  })
  for (const timeout of [false, true]) await scenario(`4 players: ordinary Svara, paid join, ${timeout ? '15-second timeout' : 'decline'}, reconnect and settlement`, 4, async (g) => {
    const tied = ['KS QS JS', 'KH QH JH', '8C 9D 10H', '8D 9C 10S']
    const resolved = ['AS KS QS', 'AH 8D 9C', 'AD 8H 9S', 'AC 10D JS']
    await g.start([g.deck(tied), g.deck(resolved, 1, [0, 1, 2])])
    await g.betting(); await g.action('look'); await g.action('pay'); await g.action('fold'); await g.action('fold'); await g.action('pay')
    assert.deepEqual(g.stored().state.lockedPots.map((p) => [p.kind, p.amount]), [['ordinary', 30]])
    for (const p of g.peers) await p.page.waitForSelector('[data-svara-tie]', { timeout: 1500 })
    await g.results()
    const joining = g.stored(), round = joining.state.round
    assert(round?.kind === 'svara-joining'); assert.equal(round.fee, 15)
    const deadline = joining.deadlines.find((d) => d.kind === 'svara-joining')!
    assert(deadline.deadlineAt - g.timing().serverNow > 14900 && deadline.deadlineAt - g.timing().serverNow <= 15000)
    const candidate = g.peers[2]!, declined = g.peers[3]!
    for (const p of [candidate, declined]) await p.page.waitForSelector('[data-svara-decision-window="joining"]', { timeout: 1500 })
    await g.reconnect(candidate)
    assert.equal(g.stored().deadlines[0]!.deadlineAt, deadline.deadlineAt)
    if (!timeout) {
      const balance = g.stored().state.stacks[declined.id]
      await g.click(declined, '[data-svara-decision-action="decline"]')
      const s = g.snapshot(candidate); assert(s.round?.kind === 'svara-joining')
      assert.equal(s.round.decisions.find((d) => d.playerId === declined.id)!.status, 'declined')
      assert.equal(g.stored().state.stacks[declined.id], balance)
    }
    const before = g.stored()
    await g.click(candidate, '[data-svara-decision-action="join"]')
    assert.equal(before.state.stacks[candidate.id]! - g.stored().state.stacks[candidate.id]!, 15)
    assert.equal(g.stored().state.lockedPots[0]!.amount, 45)
    const command = candidate.sent.findLast((f) => f.command?.type === 'svara-join')!, after = g.stored()
    assert.equal((await g.raw(candidate, command)).status, 'duplicate'); assert.deepEqual(g.stored(), after)
    if (timeout) {
      const s = g.snapshot(declined); assert(s.round?.kind === 'svara-joining')
      assert.equal(s.round.decisions.find((d) => d.playerId === candidate.id)!.status, 'joined')
      assert.equal(s.round.decisions.find((d) => d.playerId === declined.id)!.status, 'undecided')
      assert.equal(g.stored().deadlines[0]!.deadlineAt, deadline.deadlineAt)
      await wait('real joining deadline closes undecided choice', () => g.stored().state.round?.kind === 'svara', 17000)
      await g.reload(declined)
    }
    await g.betting()
    assert.equal(g.stored().state.round?.kind, 'svara'); assert.equal(g.actor().id, candidate.id)
    await g.action('look'); await g.action('pay'); await g.action('pay'); await g.action('pay')
    const paid = g.stored(), display = paid.state.round
    assert(display?.kind === 'showdown-display'); assert.equal(paid.state.lockedPots.length, 0)
    assert.deepEqual(display.payoutSteps.map((p) => [p.amount, p.winners[0]]), [[45, g.peers[0]!.id], [15, g.peers[0]!.id]])
    assert.equal(paid.state.ledger.filter((e) => e.type === 'svara-join-fee').length, 1)
    await g.queue([g.deck(resolved, 1)])
    await g.results({ payoutReconnect: candidate })
    const final = await g.allInToEnd(); assert.equal(final.stacks[g.peers[0]!.id], 400)
    await g.leave()
  })
} catch { process.exitCode = 1 }
finally {
  await browser.close()
  if (passed + failed === 0) { failed++; process.exitCode = 1; console.error('No scenario matched the requested selection') }
  await mkdir(join(root, 'tmp/svara-multiplayer'), { recursive: true })
  await writeFile(join(root, 'tmp/svara-multiplayer/report.log'), JSON.stringify({ current, passed, failed, reports }, null, 2))
  console.log(`Svara real multiplayer: ${passed} passed, ${failed} failed`)
}
