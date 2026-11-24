/**
 * Свара — ОБЩАТА визуална сцена от демото в истинската маса.
 * Компилиран backend (собствена SQLite, реален часовник, контролирани тестета)
 * + тестови ботове + Chromium. Проверява реално поведение в DOM-а:
 *   • тестето е видимо само по време на раздаване; картите летят от него;
 *   • точно 3 карти на участник след раздаването (без дублиране);
 *   • анимациите са винаги включени: няма настройка „Анимации“, а
 *     prefers-reduced-motion и стара записана „изкл.“ настройка не ги спират;
 *   • обръщане (собствено „Погледни“ и при сравняване) като спрайт;
 *   • чипове (анте, залози) в банката; изплащане към победителя;
 *   • „СВАРА!“ банерът при равенство; заключената банка остава на масата;
 *   • reload по време на раздаване — без повторение; изход по време на
 *     анимация — лоби, без останали спрайтове; ограничен брой анимации.
 *
 *   --skip-build  --screenshots=DIR
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { createIsolatedSvaraRoot, runNode, startIsolatedSvaraBackend, startSvaraGateway, waitForHarnessCondition as wait } from './svaraRealIntegrationHarness'
import { buildSvaraDeckForHands } from '../server/src/games/svara/engine/svaraMatch'
import { svaraCardCode } from '../server/src/games/svara/engine/svaraCards'
import type { SvaraMatchSnapshotMessage } from '../server/src/games/svara/protocol/svaraSnapshotProtocol'

const root = process.cwd(), host = 'svara-integration.localhost'
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const screenshotDir = process.argv.find((a) => a.startsWith('--screenshots='))?.slice('--screenshots='.length) ?? null
type Frame = Record<string, any>
type Peer = { id: string; context: BrowserContext; page: Page; frames: Frame[]; faults: string[] }
const results: string[] = []
const shotsTaken = new Set<string>()
const ok = (name: string) => { results.push(name); console.log(`  ✓ ${name}`) }

console.log('Svara table motion — real backend/bots/Chromium')
if (!process.argv.includes('--skip-build')) {
  await runNode(root, ['node_modules/typescript/bin/tsc', '-p', 'server/tsconfig.json'])
  await runNode(root, ['node_modules/vite/bin/vite.js', 'build'])
}
const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1', '--no-proxy-server'] })
const isolated = await createIsolatedSvaraRoot(root)
let backend: Awaited<ReturnType<typeof startIsolatedSvaraBackend>> | undefined
let gateway: Awaited<ReturnType<typeof startSvaraGateway>> | undefined
let origin = ''
const db = <T>(fn: (d: DatabaseSync) => T) => { const d = new DatabaseSync(isolated.dbFile); try { return fn(d) } finally { d.close() } }

async function addPeer(viewport: { width: number; height: number }): Promise<Peer> {
  const email = `svara-motion-${randomUUID()}@example.test`
  const response = await fetch(`http://127.0.0.1:${backend!.port}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'SvaraMotion1!', displayName: `MO${randomUUID().slice(0, 8)}`, gender: 'male', visitorId: randomUUID() }) })
  assert.equal(response.status, 200)
  const body = await response.json() as { session: { profile: { profileId: string } } }
  const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!
  db((d) => d.prepare("UPDATE accounts SET role='admin' WHERE email=?").run(email))
  const context = await browser.newContext({ viewport })
  const separator = cookie.indexOf('=')
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }])
  await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  await context.addInitScript(`globalThis.__name = (t) => t; globalThis.__svaraSockets = []; const N = WebSocket;
    globalThis.WebSocket = new Proxy(N, { construct(t, a) { const s = new t(...a); globalThis.__svaraSockets.push(s); return s } });`)
  const page = await context.newPage(), peer: Peer = { id: body.session.profile.profileId, context, page, frames: [], faults: [] }
  page.on('pageerror', (e) => peer.faults.push(e.message))
  page.on('websocket', (s) => s.on('framereceived', ({ payload }) => { try { peer.frames.push(JSON.parse(String(payload))) } catch { /* ignore */ } }))
  await page.goto(`${origin}/games/svara`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-svara-lobby="1"]')
  await page.getByText('Приеми всички').click({ timeout: 1500 }).catch(() => {})
  return peer
}

async function raw(p: Peer, message: Record<string, unknown>) {
  await p.page.evaluate((payload) => {
    const s = (globalThis as unknown as { __svaraSockets: WebSocket[] }).__svaraSockets.findLast((x) => x.readyState === 1 && x.url.endsWith('/ws'))
    s?.send(JSON.stringify(payload))
  }, message)
}

type Probe = { cards: number; cardsMoving: number; chips: number; chipsMoving: number; banner: number; faces: number; deck: number
  handBySceneSeat: Record<string, number>; potChips: number; faceIds: string[]; cardIds: string[]; animations: number; sprites: number; stage: number; seats: number }
async function probe(p: Peer): Promise<Probe> {
  return p.page.evaluate(() => {
    const q = (s: string) => [...document.querySelectorAll<HTMLElement>(s)]
    const visible = (e: HTMLElement) => Number(getComputedStyle(e).opacity) > 0.5
    const cards = q('[data-svara-sprite-kind="card"]').filter((e) => !e.dataset.svaraSprite!.startsWith('deck-'))
    const handBySceneSeat: Record<string, number> = {}
    for (const card of cards) {
      if (!visible(card) || card.dataset.moving === '1') continue
      const seat = card.dataset.svaraSprite!.split('-').at(-2)!
      handBySceneSeat[seat] = (handBySceneSeat[seat] ?? 0) + 1
    }
    return {
      cards: cards.filter(visible).length,
      cardIds: cards.filter(visible).map((e) => e.dataset.svaraSprite!),
      cardsMoving: cards.filter((e) => e.dataset.moving === '1').length,
      chips: q('[data-svara-sprite-kind="chip"]').filter(visible).length,
      chipsMoving: q('[data-svara-sprite-kind="chip"][data-moving="1"]').length,
      banner: q('[data-svara-scene-banner]').filter((e) => Number(getComputedStyle(e).opacity) > 0.3).length,
      faces: cards.filter((e) => [...e.querySelectorAll('img')].some((img) => img.getAttribute('src') !== '/images/cards/card-back.webp' && Number(getComputedStyle(img).opacity) > 0.5)).length,
      faceIds: cards.filter((e) => visible(e) && [...e.querySelectorAll('img')].some((img) => img.getAttribute('src') !== '/images/cards/card-back.webp' && Number(getComputedStyle(img).opacity) > 0.5)).map((e) => e.dataset.svaraSprite!),
      deck: q('[data-svara-sprite^="deck-"]').filter((e) => Number(getComputedStyle(e).opacity) > 0.05).length,
      handBySceneSeat,
      potChips: Number(document.querySelector<HTMLElement>('[data-svara-real-scene]')?.dataset.svaraPotChips ?? 0),
      animations: document.getAnimations().length,
      sprites: q('[data-svara-sprite]').length,
      stage: q('[data-svara-real-scene]').length,
      seats: q('[data-svara-scene-seat][data-svara-seat-index]').length,
    }
  })
}

const latest = (p: Peer, matchId: string) => p.frames.findLast((f) => f.type === 'svara_match_snapshot' && f.matchId === matchId) as SvaraMatchSnapshotMessage | undefined

/** Наблюдава масата, докато `until` е изпълнено; връща агрегирани факти. */
async function observe(p: Peer, matchId: string, ms: number, act?: (s: SvaraMatchSnapshotMessage) => Promise<void>, until?: (facts: Facts) => boolean) {
  const facts: Facts = { trace: [], maxAnimations: 0, maxSprites: 0, violations: [], deals: 0, dealOk: 0, flips: 0, banner: false, chipsMovingSeen: false, cardsMovingSeen: false, maxChips: 0, deckSeen: false, payoutSeen: false, lockedChipsKept: false }
  const started = Date.now()
  let lastDealRound = ''
  while (Date.now() - started < ms && !(until?.(facts))) {
    const s = latest(p, matchId)
    if (s && act) await act(s)
    const pr = await probe(p)
    const snap = latest(p, matchId)
    const round = snap?.round
    facts.maxAnimations = Math.max(facts.maxAnimations, pr.animations)
    facts.maxSprites = Math.max(facts.maxSprites, pr.sprites)
    facts.maxChips = Math.max(facts.maxChips, pr.chips)
    const shot = async (name: string) => { if (screenshotDir && !shotsTaken.has(name)) { shotsTaken.add(name); await p.page.screenshot({ path: join(screenshotDir, `scene-${p.page.viewportSize()?.width}x${p.page.viewportSize()?.height}-${name}.png`) }) } }
    const dealing = !!round && (round.kind === 'ordinary' || round.kind === 'svara') && !!round.dealing
    if (pr.deck > 0) facts.deckSeen = true
    // Тестето: само по време на раздаване (+ ~200 ms избледняване след последната карта).
    if (pr.deck > 0 && !dealing) facts.violations.push(`deck visible outside dealing (${round?.kind ?? 'none'})`)
    // Лице на карта от ТЕКУЩАТА ръка преди „Погледни“/сравняване (прибиращите се стари карти не се броят).
    const currentFaces = round ? pr.faceIds.filter((id) => id.startsWith(`card-${round.roundId}-`)) : []
    if (currentFaces.length > 0 && round && round.kind !== 'showdown-display' && round.kind !== 'reveal-choice' && !snap!.you.looked && !snap!.you.cards) facts.violations.push(`face visible before look/showdown ${currentFaces.join(',')} round=${round.kind}:${round.roundId} dealing=${dealing}`)
    if (pr.faces > 0) { facts.flips += 1; await shot('flip') }
    if (pr.banner > 0) { facts.banner = true; await shot('banner') }
    if (pr.chipsMoving > 0 && (round?.kind === 'showdown-display' || round?.kind === 'reveal-choice')) await shot('payout')
    if (pr.cardsMoving > 2 && dealing) await shot('deal')
    if (round && (round.kind === 'ordinary' || round.kind === 'svara') && !dealing && pr.cardsMoving === 0 && pr.chipsMoving === 0) await shot('betting')
    if (pr.chipsMoving > 0) facts.chipsMovingSeen = true
    const traceItem = `${round?.kind ?? 'none'}${round && 'displayPhase' in round ? '/' + round.displayPhase : ''}:pot=${pr.potChips}:locked=${snap?.lockedPots.length ?? 0}`
    if (facts.trace.at(-1) !== traceItem) facts.trace.push(traceItem)
    if (pr.cardsMoving > 0) facts.cardsMovingSeen = true
    if (round?.kind === 'showdown-display' && round.displayPhase === 'payout' && pr.chipsMoving > 0) facts.payoutSeen = true
    if (round?.kind === 'reveal-choice' && pr.chipsMoving > 0) facts.payoutSeen = true
    // Свара: заключената банка остава на масата като графични чипове.
    if ((round?.kind === 'svara-joining' || round?.kind === 'svara') && (snap!.lockedPots.length > 0 || round.kind === 'svara') && pr.potChips > 0) facts.lockedChipsKept = true
    if (round && (round.kind === 'ordinary' || round.kind === 'svara')) {
      if (dealing) {
        if (lastDealRound !== round.roundId) { lastDealRound = round.roundId; facts.deals += 1 }
        // Картите на текущата ръка (старите, които се прибират към тестето, не се броят).
        const current = pr.cardIds.filter((id) => id.startsWith(`card-${round.roundId}-`)).length
        if (current > round.participants.length * 3) facts.violations.push(`dealing cards=${current} > ${round.participants.length * 3}`)
      } else if (lastDealRound === round.roundId && pr.cardsMoving === 0) {
        const active = snap!.seats.filter((x) => round.participants.includes(x.playerId) && !x.folded).length
        const settled = Object.values(pr.handBySceneSeat)
        if (settled.length === active && settled.every((n) => n === 3)) facts.dealOk = Math.max(facts.dealOk, facts.deals)
        if (settled.some((n) => n > 3)) facts.violations.push(`hand > 3 cards ${JSON.stringify(pr.handBySceneSeat)}`)
      }
    }
    await pause(60)
  }
  return facts
}
type Facts = { trace: string[]; maxAnimations: number; maxSprites: number; violations: string[]; deals: number; dealOk: number; flips: number; banner: boolean
  chipsMovingSeen: boolean; cardsMovingSeen: boolean; maxChips: number; deckSeen: boolean; payoutSeen: boolean; lockedChipsKept: boolean }


/** Човекът: поглежда, после плаща/залага минимално (никога не бяга). */
function humanPolicy(p: Peer, matchId: string, sent: Set<number>) {
  return async (s: SvaraMatchSnapshotMessage) => {
    if (s.phase !== 'in-progress' || sent.has(s.revision) || s.toActId !== p.id || !s.you.betting?.canAct) return
    const o = s.you.betting
    const command = o.lookRequired ? { type: 'look' }
      : o.call !== null ? { type: 'act', action: { kind: 'call' } }
        : o.bet ? { type: 'act', action: { kind: 'bet', total: o.bet.min } }
          : o.noBet ? { type: 'act', action: { kind: 'no-bet' } } : null
    if (!command) return
    sent.add(s.revision)
    await raw(p, { type: 'submit_svara_command', matchId, commandId: randomUUID(), expectedRevision: s.revision, command })
  }
}

async function createWithBots(p: Peer, capacity: 2 | 3 | 4): Promise<string> {
  const offset = p.frames.length
  await p.page.click('[data-svara-create-open]')
  await p.page.selectOption('[data-svara-create-form] select[name="capacity"]', String(capacity))
  await p.page.check('[data-svara-create-form] input[name="startMode"][value="auto"]')
  await p.page.click('[data-svara-create-form] button[type="submit"]')
  await wait('table', () => p.frames.slice(offset).some((f) => f.type === 'svara_table_updated'), 5_000)
  const matchId = p.frames.slice(offset).findLast((f) => f.type === 'svara_table_updated')!.table.matchId as string
  await p.page.click('[data-svara-table-fill-bots]')
  await wait('started', () => latest(p, matchId)?.phase === 'in-progress', 10_000)
  return matchId
}

async function leave(p: Peer, matchId: string) {
  const offset = p.frames.length
  await p.page.click('[data-svara-table-leave]')
  // Активна маса: иконата за изход първо отваря потвърждение — „Напусни“.
  if (await p.page.locator('[data-svara-exit-confirm]').count()) await p.page.click('[data-svara-exit-confirm]')
  await wait('left', () => p.frames.slice(offset).some((f) => f.type === 'svara_table_left' && f.matchId === matchId), 5_000)
  await p.page.waitForSelector('[data-svara-create-open]', { timeout: 5_000 })
}


try {
  backend = await startIsolatedSvaraBackend(isolated, { deckControl: true, extraEnv: { SVARA_TEST_BOTS_ENABLED: '1' } })
  gateway = await startSvaraGateway(join(root, 'dist'), () => backend?.port ?? null)
  origin = `http://${host}:${gateway.port}`
  db((d) => d.prepare("UPDATE admin_settings SET setting_value='direct' WHERE setting_key='registration_verification_mode'").run())

  // ── A. 2 играча, prefers-reduced-motion: reduce (анимациите остават вкл.):
  //       Свара (равенство) → заключена банка → изплащане ────────────────────
  {
    const p = await addPeer({ width: 1280, height: 860 })
    await p.page.emulateMedia({ reducedMotion: 'reduce' })
    const tie = (order: string[]) => buildSvaraDeckForHands(order, Object.fromEntries(order.map((id, i) => [id, i === 0 ? 'KH QH JH' : 'KS QS JS']))).map(svaraCardCode)
    const human = (order: string[]) => buildSvaraDeckForHands(order, Object.fromEntries(order.map((id, i) => [id, i === 0 ? 'KD QD JD' : 'AS AH AD']))).map(svaraCardCode)
    await backend.queueDecks([tie(['b', 'h']), human(['b', 'h']), human(['b', 'h']), human(['b', 'h'])])
    const matchId = await createWithBots(p, 2)
    assert.equal(await p.page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true)
    await p.page.click('[data-svara-settings-toggle]')
    assert.equal(await p.page.locator('[data-svara-animations-toggle]').count(), 0, 'no „Анимации“ setting in the menu')
    assert.equal(await p.page.locator('[data-svara-sounds-toggle]').count(), 1, '„Звуци в играта“ stays')
    await p.page.click('[data-svara-settings-close]')
    const sent = new Set<number>()
    const facts = await observe(p, matchId, 75_000, humanPolicy(p, matchId, sent), (f) => f.banner && f.payoutSeen && f.dealOk >= 2)
    if (screenshotDir) await p.page.screenshot({ path: join(screenshotDir, 'scene-2p.png') })
    assert.deepEqual(facts.violations, [], 'deck/cards/faces rules')
    assert(facts.deckSeen, 'deck visible during dealing')
    assert(facts.cardsMovingSeen && facts.deals >= 1 && facts.dealOk >= 1, `cards fly and settle as 3 (deals=${facts.deals}, ok=${facts.dealOk})`)
    assert(facts.flips > 0, 'faces after look / showdown')
    assert(facts.chipsMovingSeen, 'chips move (ante/bets)')
    assert(facts.banner, '„СВАРА!“ banner on the tie')
    const svaraSeen = facts.trace.some((t) => t.startsWith('svara'))
    assert(!svaraSeen || facts.lockedChipsKept, `locked pot chips stay on the table during Svara joining ${facts.trace.join(' → ')}`)
    assert(facts.payoutSeen, 'chips move from the pot to the winner')
    assert(facts.maxAnimations < 150, `bounded animations (${facts.maxAnimations})`)
    assert(facts.maxSprites < 90, `bounded sprites (${facts.maxSprites})`)
    assert.deepEqual(p.faults, [])
    ok(`2 играча при prefers-reduced-motion=reduce: анимациите работят; тесте само при раздаване, 3 карти, обръщане, чипове, „СВАРА!“, ${svaraSeen ? 'заключена банка в Свара, ' : ''}изплащане (${facts.deals} раздавания, макс. ${facts.maxAnimations} анимации, ${facts.maxSprites} спрайта)`)

    // Стара записана настройка „Анимации: изкл.“ вече не влияе: след refresh
    // анимациите продължават, а ключът се изчиства.
    await p.page.evaluate(() => localStorage.setItem('pika.svara.animations', 'off'))
    await p.page.reload({ waitUntil: 'domcontentloaded' })
    await p.page.waitForSelector('[data-svara-real-scene]')
    assert.equal(await p.page.evaluate(() => localStorage.getItem('pika.svara.animations')), null, 'old setting cleared')
    const onFacts = await observe(p, matchId, 30_000, humanPolicy(p, matchId, sent), (f) => f.deals >= 1 && f.dealOk >= 1 && f.cardsMovingSeen)
    assert(onFacts.cardsMovingSeen, `cards still move after an old „off“ setting (deals=${onFacts.deals}, ok=${onFacts.dealOk}, maxAnimations=${onFacts.maxAnimations}, phase=${latest(p, matchId)?.phase}, trace=${onFacts.trace.join(' → ')})`)
    assert.deepEqual(onFacts.violations, [])
    ok('стара „Анимации: изкл.“ настройка не спира анимациите и се изчиства; няма превключвател')
    await leave(p, matchId)
    const after = await probe(p)
    assert.equal(after.sprites + after.stage, 0, 'no sprites left in the lobby')
    await p.context.close()
  }

  // ── B. 3 и 4 играча (desktop / mobile portrait / landscape): раздаване,
  //       reload по време на раздаване без повторение, изход по време на анимация
  for (const [capacity, viewport] of [[3, { width: 1280, height: 800 }], [4, { width: 390, height: 844 }], [4, { width: 844, height: 390 }], [3, { width: 390, height: 844 }]] as const) {
    const p = await addPeer(viewport)
    const matchId = await createWithBots(p, capacity)
    const sent = new Set<number>()
    const facts = await observe(p, matchId, 30_000, humanPolicy(p, matchId, sent), (f) => f.dealOk >= 1 && f.chipsMovingSeen)
    assert.deepEqual(facts.violations, [], `rules (${capacity} players)`)
    assert(facts.dealOk >= 1, `${capacity * 3} cards dealt and settled as 3 per player`)
    assert.equal((await probe(p)).seats, capacity, 'one HUD seat per player')
    await wait('next dealing', () => { const r = latest(p, matchId)?.round; return !!r && (r.kind === 'ordinary' || r.kind === 'svara') && !!r.dealing }, 60_000)
    await pause(1_900)
    const offset = p.frames.length
    await p.page.reload({ waitUntil: 'domcontentloaded' })
    await wait('reconnect snapshot', () => p.frames.slice(offset).some((f) => f.type === 'svara_match_snapshot' && f.matchId === matchId), 10_000)
    await p.page.waitForSelector('[data-svara-real-scene]')
    await pause(120)
    const r = latest(p, matchId)?.round
    if (r && (r.kind === 'ordinary' || r.kind === 'svara') && r.dealing) {
      // Без повторение: картите, които вече са кацнали, не летят отново.
      // В тестето са най-много картите, които по темпото още не са излетели.
      const timingFrame = p.frames.findLast((f) => f.type === 'svara_match_timing' && f.matchId === matchId)
      const deadline = timingFrame?.deadlines.find((d: { kind: string }) => d.kind === 'dealing')
      const n = r.participants.length
      const elapsed = deadline ? Date.now() - (deadline.deadlineAt - (800 + n * 3 * 350)) : 0
      const stagger = (625 * n - 360) / (n * 3 - 1)
      const launched = Math.max(0, Math.floor((elapsed - 800) / stagger) + 1)
      const remaining = Math.max(0, n * 3 - launched)
      const atDeck = await p.page.evaluate((roundId) => {
        const deckEl = document.querySelector('[data-svara-sprite="deck-0"]')
        if (!deckEl) return -1
        const d = deckEl.getBoundingClientRect()
        return [...document.querySelectorAll<HTMLElement>(`[data-svara-sprite^="card-${roundId}-"]`)]
          .filter((e) => { const b = e.getBoundingClientRect(); return Math.hypot(b.left + b.width / 2 - d.left - d.width / 2, b.top + b.height / 2 - d.top - d.height / 2) < 14 }).length
      }, r.roundId)
      assert(atDeck >= 0 && atDeck <= remaining + 1, `resumed deal is not replayed (at deck=${atDeck}, not yet launched=${remaining})`)
      const resumed = await probe(p)
      assert(resumed.cardIds.filter((id) => id.startsWith(`card-${r.roundId}-`)).length <= n * 3, 'no extra cards after reload')
    }
    const post = await observe(p, matchId, 8_000, humanPolicy(p, matchId, sent), (f) => f.dealOk >= 1)
    assert.deepEqual(post.violations, [], 'rules after reload')
    if (screenshotDir) await p.page.screenshot({ path: join(screenshotDir, `scene-${capacity}p-${viewport.width}x${viewport.height}.png`) })
    await leave(p, matchId)
    const after = await probe(p)
    assert.equal(after.sprites + after.stage, 0, 'exit during an animation: lobby, no sprites left')
    assert.deepEqual(p.faults, [])
    ok(`${capacity} играча ${viewport.width}×${viewport.height}: ${capacity * 3} карти, reload по време на раздаване без повторение, изход по време на анимация`)
    await p.context.close()
  }

  console.log(`\nSvara table scene: ${results.length}/${results.length} passed`)
} catch (error) {
  console.error(backend?.output().slice(-2500))
  throw error
} finally {
  await browser.close().catch(() => {})
  await gateway?.close().catch(() => {})
  await backend?.stop().catch(() => {})
  await isolated.cleanup().catch(() => {})
}
