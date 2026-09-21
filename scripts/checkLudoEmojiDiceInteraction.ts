// checkLudoEmojiDiceInteraction.ts
//
// Focused investigation (real spawned-server + real browser, Playwright,
// production authoritative WS controller) for a reported UX bug: "понякога
// след като пусна emoji, бутонът за хвърляне на зара изглежда/се държи
// блокиран". This harness proves — or disproves — that sending/receiving an
// animated emoji reaction has ANY effect on the local player's ability to
// roll dice, across the exact repro scenarios in the task spec (A-F).
//
// It reuses the exact page/room/color helpers from checkLudoEmojiReaction.ts
// (same isolated server root / vite dev server / WS color-tracking pattern)
// rather than duplicating a second bespoke harness.
//
// Observable ground truth used throughout: whenever a real click on
// `[data-ludo-dice-roll-button="1"]` should roll, we assert a real
// `ludo_roll_request` WS frame is actually sent by that page (not just that
// the DOM LOOKS clickable) — this is the only way to distinguish "button
// enabled but overlay eats the click" from "click reaches the handler".

import { createHmac } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type Page } from 'playwright'
import { createServer as createViteServer } from 'vite'

// Registration now goes through pending-registration + emailed 6-digit code
// (server/src/db/authStore.ts, added after checkLudoEmojiReaction.ts was
// written — see hashVerificationCode/verifyVerificationCode in
// server/src/db/authHelpers.ts: HMAC-SHA256(secret, "email-verification-
// code-v1:<code>")). This sandbox has no BREVO_API_KEY, so the real email
// never sends. Since this harness spawns its OWN throwaway isolated server
// with a harness-local EMAIL_VERIFICATION_CODE_SECRET it controls, it can
// read that server's own SQLite code_hash and recompute which of the
// 1,000,000 possible 6-digit codes matches — pure local hashing, no network,
// no production credentials, no bypass of any REAL server's verification.
const EMAIL_VERIFICATION_SECRET = 'ludo-emoji-dice-harness-throwaway-secret-32chars'
const VERIFICATION_CODE_HMAC_PREFIX = 'email-verification-code-v1'
function hashVerificationCodeLocal(code: string): string {
  return createHmac('sha256', EMAIL_VERIFICATION_SECRET).update(`${VERIFICATION_CODE_HMAC_PREFIX}:${code}`).digest('hex')
}
function recoverVerificationCode(storedHash: string): string {
  for (let n = 0; n < 1_000_000; n += 1) {
    const code = n.toString().padStart(6, '0')
    if (hashVerificationCodeLocal(code) === storedHash) return code
  }
  throw new Error('could not recover verification code from code_hash — hash algorithm/secret mismatch')
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
const freePort = () => new Promise<number>((done, failPort) => {
  const server = createNetServer().once('error', failPort).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return failPort(new Error('No free port'))
    server.close(() => done(address.port))
  })
})

const projectRoot = process.cwd()

async function createIsolatedServerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'belot-ludo-emoji-dice-'))
  const serverDir = join(root, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(projectRoot, 'server', 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(projectRoot, 'server', 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(projectRoot, 'server', 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(projectRoot, 'server', 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(projectRoot, 'server', 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'), linkType)
  return { serverDir, cleanup: () => rm(root, { recursive: true, force: true }).catch(() => undefined) }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }
function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    // Throwaway harness-local secret (32+ chars) — this sandbox's real
    // server/.env has no EMAIL_VERIFICATION_CODE_SECRET/PASSWORD_RESET_
    // RATE_LIMIT_SECRET configured, so POST /api/auth/register 503s without
    // it (see server/src/index.ts:776-785, server/src/db/authStore.ts:1363).
    // Scoped ONLY to this spawned isolated server's env — never written to
    // any real .env file, never affects the actual project config.
    env: { ...process.env, PORT: String(port), EMAIL_VERIFICATION_CODE_SECRET: 'ludo-emoji-dice-harness-throwaway-secret-32chars' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c)); child.stderr.on('data', (c) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}
async function waitForHealth(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      const h: any = await r.json()
      if (r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready') return true
    } catch { /* retry */ }
    await sleep(200)
  }
  return false
}

function randomVisitorUuid(): string {
  // v4-shaped UUID matching VISITOR_UUID_RE (server/src/index.ts) — doesn't
  // need cryptographic randomness, just the right shape.
  const hex = () => Math.floor(Math.random() * 16).toString(16)
  const block = (n: number) => Array.from({ length: n }, hex).join('')
  return `${block(8)}-${block(4)}-4${block(3)}-${['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)]}${block(3)}-${block(12)}`
}

async function register(port: number, tag: string, runId: string, serverDir: string) {
  const email = `ludo-ed-${tag}-${runId}@example.test`
  const registerRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, password: 'LudoEmojiDice1!',
      displayName: `LED${tag.replace(/[^a-zA-Z0-9]/g, '')}${runId.slice(-5)}`,
      gender: 'male', visitorId: randomVisitorUuid(),
    }),
  })
  const registerBody: any = await registerRes.json()
  // EMAIL_DELIVERY_FAILED (503) is EXPECTED in this sandbox (no BREVO_API_KEY)
  // — the pending row + rawCode are still created server-side; only the
  // actual email send fails. Any OTHER failure is a real problem.
  if (registerRes.status !== 503 || registerBody.code !== 'EMAIL_DELIVERY_FAILED') {
    throw new Error(`register ${tag}: unexpected response ${registerRes.status} ${JSON.stringify(registerBody)}`)
  }
  const pendingRegistrationId = registerBody.pendingRegistrationId as string
  if (!pendingRegistrationId) throw new Error(`register ${tag}: no pendingRegistrationId in response`)

  // Read this harness's OWN throwaway SQLite file (recreated per run, own
  // EMAIL_VERIFICATION_CODE_SECRET) to recover the code — see the
  // recoverVerificationCode() doc comment above for why this is safe/local.
  const dbPath = join(serverDir, 'database', 'data', 'belot-v2.sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  let codeHash: string
  try {
    const row = db.prepare('SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?').get(pendingRegistrationId) as { code_hash: string } | undefined
    if (!row) throw new Error(`register ${tag}: pending_registrations row not found for ${pendingRegistrationId}`)
    codeHash = row.code_hash
  } finally {
    db.close()
  }
  const code = recoverVerificationCode(codeHash)

  const verifyRes = await fetch(`http://127.0.0.1:${port}/api/auth/verify-registration-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingRegistrationId, code }),
  })
  const verifyBody: any = await verifyRes.json()
  if (verifyRes.status !== 200) throw new Error(`verify-registration-email ${tag} failed: ${JSON.stringify(verifyBody)}`)
  const setCookie = (verifyRes.headers.getSetCookie?.()[0] ?? verifyRes.headers.get('set-cookie'))?.split(';')[0] ?? null
  if (!setCookie) throw new Error('no cookie returned from verify-registration-email')
  return { cookie: setCookie.split('=')[1]!, profileId: verifyBody.session.profile.profileId as string }
}

console.log('\ncheckLudoEmojiDiceInteraction\n')

const isolated = await createIsolatedServerRoot()
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let server: RunningServer | null = null
const browser = await chromium.launch({ headless: true })
let vite: Awaited<ReturnType<typeof createViteServer>> | null = null

try {
  const backendPort = await freePort()
  server = startServer(isolated.serverDir, backendPort)
  console.log(`Waiting for server on port ${backendPort}...`)
  if (!(await waitForHealth(backendPort))) { console.error(server.output()); throw new Error('server did not become ready') }
  console.log('Server ready.\n')

  const vitePort = await freePort()
  vite = await createViteServer({
    root: projectRoot,
    server: { host: '127.0.0.1', port: vitePort, strictPort: true },
    logLevel: 'error',
    plugins: [{
      name: 'ludo-emoji-dice-isolated-backend',
      enforce: 'pre',
      transform(code, id) {
        if (!id.includes('/src/') && !id.includes('\\src\\')) return null
        return code.includes(':3001') ? code.replaceAll(':3001', `:${backendPort}`) : null
      },
    }],
  })
  await vite.listen()
  const appOrigin = `http://127.0.0.1:${vitePort}`
  const backendOrigin = `http://127.0.0.1:${backendPort}`

  const matchInfoByPage = new WeakMap<Page, { matchId: string | null; colorByProfile: Map<string, string> }>()
  // Tracks whether THIS page's browser socket has sent a 'ludo_roll_request'
  // frame since the tracker was last armed — the one true signal that a
  // dice click reached the real production handler
  // (options.authoritative.onRollRequest -> client.requestLudoRoll ->
  // WS send), as opposed to merely "looking" clickable in the DOM.
  const rollRequestSeenByPage = new WeakMap<Page, { count: number }>()

  async function open(profile: { cookie: string; profileId: string }, viewport: { width: number; height: number }): Promise<Page> {
    const context = await browser.newContext({ viewport })
    await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: backendOrigin }])
    const page = await context.newPage()
    const info = { matchId: null as string | null, colorByProfile: new Map<string, string>() }
    matchInfoByPage.set(page, info)
    const rollTracker = { count: 0 }
    rollRequestSeenByPage.set(page, rollTracker)
    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => {
        try {
          const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')
          const msg = JSON.parse(payload)
          if ((msg.type === 'ludo_game_started' || msg.type === 'ludo_game_state') && msg.snapshot) {
            info.matchId = msg.snapshot.matchId
            for (const p of msg.snapshot.players) info.colorByProfile.set(p.profileId, p.color)
          }
        } catch { /* ignore non-JSON/binary frames */ }
      })
      // Client -> server frames are 'framesent' in Playwright's WebSocket API.
      ws.on('framesent', (frame) => {
        try {
          const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')
          const msg = JSON.parse(payload)
          if (msg.type === 'ludo_roll_request') rollTracker.count += 1
        } catch { /* ignore */ }
      })
    })
    await page.goto(`${appOrigin}/games/ludo`)
    const consentButton = page.locator('[data-consent-accept-all="1"]')
    if (await consentButton.isVisible().catch(() => false)) await consentButton.click()
    await page.locator('[data-ludo-lobby="1"]').waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(300)
    return page
  }

  async function createRoom(page: Page, playerCount: '2' | '4'): Promise<void> {
    await page.locator('[data-ludo-create-open="1"]').click()
    await page.locator('[data-ludo-create-form="1"]').waitFor({ state: 'visible' })
    await page.locator('[data-ludo-create-form="1"] select[name="playerCount"]').selectOption(playerCount)
    const stakeSelect = page.locator('[data-ludo-create-form="1"] select[name="stake"]')
    const firstStakeValue = await stakeSelect.locator('option').first().getAttribute('value')
    await stakeSelect.selectOption(firstStakeValue!)
    await page.locator('[data-ludo-create-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
  }

  async function colorOf(page: Page, profileId: string): Promise<string> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const color = matchInfoByPage.get(page)?.colorByProfile.get(profileId)
      if (color) return color
      await sleep(80)
    }
    throw new Error('color for profile not observed via WS traffic in time')
  }

  async function sendEmoji(page: Page, emojiId: string): Promise<void> {
    await page.locator('[data-ludo-emoji-button="1"]').click()
    await page.locator('[data-ludo-emoji-picker="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    await page.locator(`[data-ludo-emoji-pick="${emojiId}"]`).click()
  }

  // Waits until it's genuinely this page's turn to roll (production
  // authoritative canRollDice gate open) — the SAME DOM attribute the real
  // controller gates on (data-ludo-dice-roll-button="1"), never guessed.
  async function waitForOwnRollTurn(page: Page, color: string, timeoutMs = 20_000): Promise<void> {
    await page.locator(`[data-ludo-dice-anchor="${color}"][data-ludo-dice-roll-button="1"]`).waitFor({ state: 'visible', timeout: timeoutMs })
  }

  // After a roll, the engine sits in awaiting_move_selection until a piece
  // is clicked (production is server-authoritative but STILL requires an
  // explicit onMoveRequest — nothing auto-advances). A roll of non-6 with
  // all 4 pieces still in home has NO legal move at all (home exit needs a
  // 6) — the reducer's own ROLL_RESOLVED handling resolves that "no legal
  // moves" case by transitioning straight to 'turn_complete' server-side
  // (see server/src/game/ludoEngine/ludoEngineReducer.ts:97), so this helper
  // only needs to click a selectable piece WHEN one actually appears.
  async function completePendingMoveIfAny(page: Page, timeoutMs = 2_000): Promise<void> {
    const piece = page.locator('[data-ludo-piece-selectable="1"]').first()
    const appeared = await piece.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true).catch(() => false)
    if (appeared) await piece.click()
  }

  // Rolls, asserts the real ludo_roll_request WS frame fired (the ground
  // truth for "click reached the production handler"), then completes the
  // resulting move (if any) so the match cleanly cycles to the next
  // player's waiting_for_roll instead of stalling in awaiting_move_selection
  // until the 15s human move-timeout forces a bot-takeover popup.
  async function clickDiceAndExpectRollRequest(page: Page, color: string, label: string): Promise<void> {
    const tracker = rollRequestSeenByPage.get(page)!
    const before = tracker.count
    await page.locator(`[data-ludo-dice-anchor="${color}"]`).click()
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline && tracker.count === before) await sleep(50)
    if (tracker.count === before) throw new Error(`${label}: dice click did not produce a ludo_roll_request WS frame`)
    await sleep(300) // let the authoritative roll snapshot land before checking for a move
    await completePendingMoveIfAny(page)
  }

  // ═══════════════════════════════════════════════════════════════════
  // Shared 2-player room setup — A is the human under test, B is a live
  // second real browser (needed so turns actually alternate and B can
  // send emoji to A in scenario D).
  // ═══════════════════════════════════════════════════════════════════
  const aProfile = await register(backendPort, 'a', runId, isolated.serverDir)
  const bProfile = await register(backendPort, 'b', runId, isolated.serverDir)
  const aPage = await open(aProfile, { width: 1280, height: 850 })
  await createRoom(aPage, '2')
  await aPage.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
  const bPage = await open(bProfile, { width: 1280, height: 850 })
  await bPage.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
  await bPage.locator('[data-ludo-room-join]').first().click()
  await aPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
  await bPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
  const aColor = await colorOf(aPage, aProfile.profileId)
  const bColor = await colorOf(bPage, bProfile.profileId)

  // Helper: rolls+advances turns (as whichever side is currently active,
  // human clicks preferred, but bot-driven if needed is out of scope here —
  // 2-player room means turns strictly alternate between A and B) until it
  // becomes A's own waiting_for_roll turn again. Used between scenarios so
  // each one starts from a clean "it is genuinely A's turn" state.
  async function ensureBackToOwnRollTurn(): Promise<void> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const aReady = await aPage.locator(`[data-ludo-dice-anchor="${aColor}"][data-ludo-dice-roll-button="1"]`).isVisible().catch(() => false)
      if (aReady) return
      const bReady = await bPage.locator(`[data-ludo-dice-anchor="${bColor}"][data-ludo-dice-roll-button="1"]`).isVisible().catch(() => false)
      if (bReady) {
        await bPage.locator(`[data-ludo-dice-anchor="${bColor}"]`).click()
        await sleep(400)
        // Same as clickDiceAndExpectRollRequest: complete B's move too,
        // otherwise the match stalls in awaiting_move_selection on B's side
        // and never actually comes back to A (was the root cause of the
        // earlier bot-takeover-popup timeout seen while developing this
        // harness — a test-loop gap, not a product bug: see report).
        await completePendingMoveIfAny(bPage)
        await sleep(300)
      } else {
        await sleep(200)
      }
    }
    throw new Error('timed out waiting to cycle back to A\'s own roll turn')
  }

  // ═══════════════════════════════════════════════════════════════════
  // A) My turn, dice enabled. Send 1 emoji. Immediately after picker
  //    closes, click dice. => roll request must fire.
  // ═══════════════════════════════════════════════════════════════════
  console.log('=== A: emoji then immediate dice click ===')
  await waitForOwnRollTurn(aPage, aColor)
  await check('[A] canRollDice unaffected: dice click right after emoji send reaches onRollRequest', async () => {
    await sendEmoji(aPage, '01')
    // Picker auto-closes synchronously in the emoji-pick click handler
    // (closeEmojiPicker() before onEmojiReactionSend) — no artificial wait,
    // this is exactly "веднага след затваряне на picker-а".
    await clickDiceAndExpectRollRequest(aPage, aColor, '[A]')
  })

  // ═══════════════════════════════════════════════════════════════════
  // B) My turn. Send emoji. While the 4s bubble is still visible, click
  //    dice. => must still be able to roll.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== B: dice click while emoji bubble still presenting ===')
  await ensureBackToOwnRollTurn()
  await check('[B] emoji presentation (bubble still on screen) does not block dice click', async () => {
    await sendEmoji(aPage, '02')
    // The bubble only appears once the server ECHOES the reaction back over
    // WS (send is fire-and-forget, see onEmojiReactionSend in
    // createLudoFlowController.ts) — wait for the real round trip instead of
    // asserting visibility synchronously right after the local send.
    await aPage.locator('[data-ludo-emoji-reaction]').first().waitFor({ state: 'visible', timeout: 3_000 })
    await clickDiceAndExpectRollRequest(aPage, aColor, '[B]')
  })

  // ═══════════════════════════════════════════════════════════════════
  // C) My turn. Send emoji A, then emoji B before A disappears.
  //    Replacement semantics must not block dice.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== C: rapid emoji replacement before dice click ===')
  await ensureBackToOwnRollTurn()
  await check('[C] rapid emoji replacement (A then B before A expires) leaves no stale interaction lock on dice', async () => {
    await sendEmoji(aPage, '03')
    await sleep(200)
    await sendEmoji(aPage, '04')
    await clickDiceAndExpectRollRequest(aPage, aColor, '[C]')
  })

  // ═══════════════════════════════════════════════════════════════════
  // D) Another player sends ME an emoji right as it becomes my turn.
  //    The incoming emoji must not block dice.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== D: incoming emoji from opponent does not block dice ===')
  await ensureBackToOwnRollTurn()
  await check('[D] incoming emoji reaction (from B) right as it is A\'s turn does not block A\'s dice click', async () => {
    await sendEmoji(bPage, '06')
    // B's bubble renders on A's screen too (realtime broadcast) — confirm
    // it actually arrived, then prove it doesn't block A's own dice.
    const deadline = Date.now() + 3_000
    let arrived = false
    while (Date.now() < deadline && !arrived) {
      arrived = await aPage.evaluate((c) => {
        const panel = document.querySelector(`[data-ludo-player-panel="${c}"]`)
        return !!panel?.parentElement?.querySelector('[data-ludo-emoji-reaction]')
      }, bColor)
      if (!arrived) await sleep(80)
    }
    if (!arrived) throw new Error('setup invalid: B\'s incoming bubble never arrived on A\'s screen')
    await clickDiceAndExpectRollRequest(aPage, aColor, '[D]')
  })

  // ═══════════════════════════════════════════════════════════════════
  // E) Mobile viewport: emoji overlay/picker must not cover the dice
  //    hitbox, and dice must still be clickable.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== E: mobile viewport — picker does not cover dice hitbox ===')
  await ensureBackToOwnRollTurn()
  await aPage.setViewportSize({ width: 360, height: 800 })
  await aPage.waitForTimeout(200)
  await check('[E] mobile viewport: emoji picker panel does not geometrically overlap the dice hitbox', async () => {
    await aPage.locator('[data-ludo-emoji-button="1"]').click()
    await aPage.locator('[data-ludo-emoji-picker="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    const diceBox = await aPage.locator(`[data-ludo-dice-anchor="${aColor}"]`).boundingBox()
    const pickerBox = await aPage.locator('[data-ludo-emoji-picker="1"]').boundingBox()
    if (!diceBox || !pickerBox) throw new Error('dice or picker bounding box not found on mobile viewport')
    const overlaps = pickerBox.x < diceBox.x + diceBox.width && diceBox.x < pickerBox.x + pickerBox.width &&
      pickerBox.y < diceBox.y + diceBox.height && diceBox.y < pickerBox.y + pickerBox.height
    if (overlaps) throw new Error(`emoji picker overlaps dice hitbox on 360px mobile viewport: dice=${JSON.stringify(diceBox)} picker=${JSON.stringify(pickerBox)}`)
    await aPage.locator('[data-ludo-emoji-pick="07"]').click()
  })
  await check('[E] mobile viewport: dice remains clickable after closing the picker via emoji pick', async () => {
    await clickDiceAndExpectRollRequest(aPage, aColor, '[E]')
  })
  await aPage.setViewportSize({ width: 1280, height: 850 })
  await aPage.waitForTimeout(200)

  // ═══════════════════════════════════════════════════════════════════
  // F) Emoji closes exactly as an authoritative turn update lands — dice
  //    state must stay derived from the latest authoritative snapshot,
  //    not some stale pre-emoji presentation.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== F: emoji close racing an authoritative turn update ===')
  await ensureBackToOwnRollTurn()
  await check('[F] dice state after a same-tick emoji-close + authoritative update still reflects the live snapshot', async () => {
    // Fire the emoji pick (closes picker synchronously) and roll click back
    // to back with no artificial delay, so any pending authoritative
    // snapshot in flight for THIS roll lands right on top of the emoji
    // close — exactly the race the task describes.
    await aPage.locator('[data-ludo-emoji-button="1"]').click()
    await aPage.locator('[data-ludo-emoji-picker="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    await aPage.locator('[data-ludo-emoji-pick="08"]').click()
    await clickDiceAndExpectRollRequest(aPage, aColor, '[F]')
    // After the roll resolves, the engine transitions this color out of
    // waiting_for_roll — confirm the button's presence/absence tracks that
    // authoritative transition (not stuck on a stale pre-roll state).
    await aPage.locator(`[data-ludo-dice-anchor="${aColor}"][data-ludo-dice-roll-button="1"]`).waitFor({ state: 'hidden', timeout: 10_000 })
  })

  await bPage.close()
  await aPage.close()

  console.log('\n' + '═'.repeat(72))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  await browser.close()
  if (vite) await vite.close()
  if (server && server.child.exitCode === null) {
    server.child.kill('SIGKILL')
    await Promise.race([new Promise((r) => server!.child.once('exit', r)), sleep(3_000)])
  }
  await isolated.cleanup()
}
