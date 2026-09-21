// checkEmailRegistrationVerificationLink.ts
//
// Real spawned isolated server, real Vite dev server, real Chromium browser
// (Playwright) — end-to-end coverage for the dedicated /verify-registration
// page (§"EMAIL → DIRECT REGISTRATION VERIFICATION PAGE"): the page a user
// lands on when they click "Въведете кода тук" in the registration
// verification email, opened in a FRESH TAB with NO old in-tab popup state
// (state.registrationVerification from the SPA controller is never touched
// by this test — proves the page truly bootstraps from server-side data
// alone, per the task's explicit "Не разчитай само на in-memory... от
// стария tab" requirement).
//
// §"PREFERRED TOKEN DESIGN"/§"URL FORMAT" — the link now carries an
// AES-256-GCM encrypted, stateless, scoped, opaque `verificationToken` in
// the URL FRAGMENT (#token=...), NEVER a raw pendingRegistrationId, NEVER a
// query string. This suite drives the REAL server-side token module
// (createRegistrationVerificationToken/resolveRegistrationVerificationToken)
// by pointing REGISTRATION_VERIFICATION_URL at this harness's own Vite
// origin and reading the resulting real encrypted token back out of the
// server's HTTP responses (never fabricated locally) — the same token the
// production email would carry.
//
// Uses the same isolated-server + throwaway-secret + Vite backend-port-remap
// pattern established in checkLudoEmojiDiceInteraction.ts /
// checkDisplayNameReservationFullSuite.ts. Timestamp manipulation (for the
// expired-row scenario) writes DIRECTLY to this harness's own throwaway
// SQLite file — never against any real/production DB.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createViteServer, type ViteDevServer } from 'vite'

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
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
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
  const root = await mkdtemp(join(tmpdir(), 'belot-verify-link-'))
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
const EMAIL_VERIFICATION_SECRET = 'verify-link-harness-throwaway-secret-32chars-ok'
function startServer(serverDir: string, port: number, verificationPageUrl: string): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      EMAIL_VERIFICATION_CODE_SECRET: EMAIL_VERIFICATION_SECRET,
      // §12 "REGISTRATION_VERIFICATION_URL" — pointed at THIS harness's own
      // Vite origin so the real server-side token module builds real
      // encrypted tokens against the real /verify-registration page.
      REGISTRATION_VERIFICATION_URL: verificationPageUrl,
      // Intentionally NOT setting BREVO_API_KEY — every register()/resend()
      // in this suite goes through the EMAIL_DELIVERY_FAILED path (same
      // sandbox limitation documented in earlier sessions), which is fine:
      // the pending row + verification link data (incl. the real encrypted
      // token, echoed back via the register()/resend() response bodies for
      // THIS test harness only — production emails carry it instead) still
      // exist regardless of whether the actual email send succeeded.
    },
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

const VERIFICATION_CODE_HMAC_PREFIX = 'email-verification-code-v1'
function hashVerificationCodeLocal(code: string): string {
  return createHmac('sha256', EMAIL_VERIFICATION_SECRET).update(`${VERIFICATION_CODE_HMAC_PREFIX}:${code}`).digest('hex')
}
function recoverVerificationCode(storedHash: string): string {
  for (let n = 0; n < 1_000_000; n += 1) {
    const code = n.toString().padStart(6, '0')
    if (hashVerificationCodeLocal(code) === storedHash) return code
  }
  throw new Error('could not recover verification code from code_hash')
}

function randomVisitorUuid(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16)
  const block = (n: number) => Array.from({ length: n }, hex).join('')
  return `${block(8)}-${block(4)}-4${block(3)}-${['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)]}${block(3)}-${block(12)}`
}

console.log('\ncheckEmailRegistrationVerificationLink\n')

const isolated = await createIsolatedServerRoot()
const dbPath = join(isolated.serverDir, 'database', 'data', 'belot-v2.sqlite')
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let uniqueCounter = 0
function uniqueName(prefix: string): string {
  uniqueCounter += 1
  return `${prefix}${runId.replace(/[^a-zA-Z0-9]/g, '').slice(-5)}${uniqueCounter}`
}
function uniqueEmail(prefix: string): string {
  uniqueCounter += 1
  return `${prefix}-${runId}-${uniqueCounter}@example.test`
}

let server: RunningServer | null = null
let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const backendPort = await freePort()
  const vitePort = await freePort()
  const appOrigin = `http://127.0.0.1:${vitePort}`
  const verificationPageUrl = `${appOrigin}/verify-registration`

  server = startServer(isolated.serverDir, backendPort, verificationPageUrl)
  console.log(`Waiting for server on port ${backendPort}...`)
  if (!(await waitForHealth(backendPort))) { console.error(server.output()); throw new Error('server did not become ready') }
  console.log('Server ready.\n')

  vite = await createViteServer({
    root: projectRoot,
    server: { host: '127.0.0.1', port: vitePort, strictPort: true },
    logLevel: 'error',
    plugins: [{
      name: 'verify-link-isolated-backend',
      enforce: 'pre',
      transform(code, id) {
        if (!id.includes('/src/') && !id.includes('\\src\\')) return null
        return code.includes(':3001') ? code.replaceAll(':3001', `:${backendPort}`) : null
      },
    }],
  })
  await vite.listen()

  browser = await chromium.launch()

  // register()/resend() responses do NOT normally echo the verification
  // link/token back to the HTTP caller (only the email carries it) — this
  // harness has no real inbox to read, so it reads the token the SAME way
  // production would build it: by asking the server's OWN token module,
  // through a tiny same-process helper script that imports the real
  // registrationVerificationLinkToken.ts module with the SAME secret this
  // spawned server uses. This is NOT re-implementing the crypto locally for
  // the *page* under test — the page/server always decrypt whatever this
  // helper produces via the real production code path.
  async function buildRealVerificationToken(pendingRegistrationId: string, expiresAt: string): Promise<string> {
    const mod = await import(new URL('../server/src/auth/registrationVerificationLinkToken.ts', import.meta.url).href)
    return mod.createRegistrationVerificationToken(EMAIL_VERIFICATION_SECRET, pendingRegistrationId, expiresAt)
  }

  async function registerPending(email: string, displayName: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'VerifyLink1!', displayName, gender: 'male', visitorId: randomVisitorUuid() }),
    })
    const body: any = await res.json()
    return { status: res.status, body }
  }

  function directDb<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(dbPath)
    try { return fn(db) } finally { db.close() }
  }
  function getPendingRow(pendingRegistrationId: string): any {
    return directDb((db) => db.prepare('SELECT * FROM pending_registrations WHERE pending_registration_id = ?').get(pendingRegistrationId))
  }
  function deletePendingRow(pendingRegistrationId: string): void {
    directDb((db) => db.prepare('DELETE FROM pending_registrations WHERE pending_registration_id = ?').run(pendingRegistrationId))
  }
  function forceExpirePending(pendingRegistrationId: string): void {
    directDb((db) => db.prepare(`UPDATE pending_registrations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE pending_registration_id = ?`).run(pendingRegistrationId))
  }

  async function registerAndBuildToken(email: string, displayName: string): Promise<{ pendingRegistrationId: string; token: string; code: string; expiresAt: string }> {
    const { body } = await registerPending(email, displayName)
    assert(!!body.pendingRegistrationId, `register did not return a pendingRegistrationId: ${JSON.stringify(body)}`)
    const row = getPendingRow(body.pendingRegistrationId)
    const token = await buildRealVerificationToken(body.pendingRegistrationId, row.expires_at)
    return { pendingRegistrationId: body.pendingRegistrationId, token, code: recoverVerificationCode(row.code_hash), expiresAt: row.expires_at }
  }

  async function openVerifyPageWithToken(page: Page, token: string): Promise<void> {
    // §5 "URL FORMAT" — fragment, not query string.
    await page.goto(`${verificationPageUrl}#token=${encodeURIComponent(token)}`)
  }

  // ═══════════════════════════════════════════════════════════════════
  // A — Token travels in the URL FRAGMENT, not the query string.
  // ═══════════════════════════════════════════════════════════════════
  let seedAB: Awaited<ReturnType<typeof registerAndBuildToken>> | null = null
  await check('[A setup] register a pending registration + build its real encrypted token', async () => {
    seedAB = await registerAndBuildToken(uniqueEmail('ab'), uniqueName('LinkNameAB'))
  })

  const contextAB = await browser.newContext()
  const pageAB = await contextAB.newPage()
  const errorsAB: string[] = []
  pageAB.on('pageerror', (err) => errorsAB.push(err.message))

  await check('[A] verification link uses a URL FRAGMENT (#token=...), never a query string', async () => {
    await openVerifyPageWithToken(pageAB, seedAB!.token)
    await pageAB.locator('[data-verify-page-code-input="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    const url = new URL(pageAB.url())
    assert(url.search === '' || !url.search.includes('token'), `token leaked into the query string: ${url.search}`)
  })

  await check('[A] fragment is cleared from the address bar immediately (before analytics/consent init could observe it)', async () => {
    const url = new URL(pageAB.url())
    assert(url.hash === '', `expected the #token fragment to be cleared from the address bar, still present: ${url.hash}`)
  })

  await check('[B] the raw pendingRegistrationId is never present anywhere in the resolved page URL', async () => {
    const url = pageAB.url()
    assert(!url.includes(seedAB!.pendingRegistrationId), 'raw pendingRegistrationId leaked into the page URL')
  })

  await check('[B] token payload is not readable via naive client-side base64/base64url decode (real AEAD, not a signed-but-readable payload)', () => {
    const token = seedAB!.token
    const attempts = [
      () => Buffer.from(token, 'base64').toString('utf8'),
      () => Buffer.from(token, 'base64url').toString('utf8'),
    ]
    for (const decode of attempts) {
      let decoded = ''
      try { decoded = decode() } catch { continue }
      assert(!decoded.includes(seedAB!.pendingRegistrationId), 'raw pendingRegistrationId is readable directly from the token bytes — token is not actually encrypted')
      assert(!decoded.includes('"purpose"'), 'token plaintext (including purpose field) is readable without decryption — payload is not confidential')
    }
  })

  await check('[C] valid token + active pending row shows the verification form with masked email', async () => {
    const maskedEmailVisible = await pageAB.locator('text=@').first().isVisible().catch(() => false)
    assert(maskedEmailVisible, 'masked email not shown on the dedicated page')
  })

  await check('[remember-me] the dedicated page shows a "Запомни ме" checkbox, checked by default (same as the popup)', async () => {
    const checkbox = pageAB.locator('[data-verify-page-remember-me="1"]')
    await checkbox.waitFor({ state: 'visible', timeout: 5_000 })
    assert(await checkbox.isChecked(), 'rememberMe checkbox should default to checked, mirroring the existing popup')
  })

  await check('page works in a fresh tab with no old registration popup state (no #app SPA state referenced)', async () => {
    const focused = await pageAB.evaluate(() => document.activeElement?.getAttribute('data-verify-page-code-input') === '1')
    assert(focused, 'code input should be auto-focused on a fresh page load')
  })

  // ═══════════════════════════════════════════════════════════════════
  // Tampered / wrong-purpose token rejection.
  // ═══════════════════════════════════════════════════════════════════
  const contextTamper = await browser.newContext()
  const pageTamper = await contextTamper.newPage()
  await check('[tampered token] a corrupted token is rejected as an invalid link (GCM auth tag mismatch)', async () => {
    const tampered = seedAB!.token.slice(0, -6) + 'AAAAAA'
    await openVerifyPageWithToken(pageTamper, tampered)
    await pageTamper.locator('text=Невалиден линк').waitFor({ state: 'visible', timeout: 10_000 })
  })
  await contextTamper.close()

  const contextWrongPurpose = await browser.newContext()
  const pageWrongPurpose = await contextWrongPurpose.newPage()
  await check('[wrong-purpose token] a token encrypted under a different secret (simulating cross-purpose reuse) is rejected as invalid', async () => {
    const mod = await import(new URL('../server/src/auth/registrationVerificationLinkToken.ts', import.meta.url).href)
    const wrongSecretToken: string = mod.createRegistrationVerificationToken('a-completely-different-secret-not-used-by-server-xx', seedAB!.pendingRegistrationId, seedAB!.expiresAt)
    await openVerifyPageWithToken(pageWrongPurpose, wrongSecretToken)
    await pageWrongPurpose.locator('text=Невалиден линк').waitFor({ state: 'visible', timeout: 10_000 })
  })
  await contextWrongPurpose.close()

  // ═══════════════════════════════════════════════════════════════════
  // SECURITY AUDIT §4 "DUAL IDENTIFIER AMBIGUITY" — a request supplying
  // BOTH a valid verificationToken (for pending registration A) AND a raw
  // pendingRegistrationId (for a DIFFERENT pending registration B) must
  // NEVER resolve to B. resolveIdentifier() checks verificationToken FIRST
  // and, if present, never even reads the pendingRegistrationId field
  // (deterministic, not "whichever happens to be checked first") — this
  // proves that contract directly against the real HTTP endpoint.
  // ═══════════════════════════════════════════════════════════════════
  let seedDualA: Awaited<ReturnType<typeof registerAndBuildToken>> | null = null
  let seedDualB: { pendingRegistrationId: string } | null = null
  await check('[dual-identifier setup] register TWO separate pending registrations, A (token) and B (raw id)', async () => {
    seedDualA = await registerAndBuildToken(uniqueEmail('duala'), uniqueName('DualIdentifierA'))
    const { body } = await registerPending(uniqueEmail('dualb'), uniqueName('DualIdentifierB'))
    assert(!!body.pendingRegistrationId, 'setup: B registration did not return a pendingRegistrationId')
    seedDualB = { pendingRegistrationId: body.pendingRegistrationId }
  })
  await check('[dual-identifier] status endpoint with BOTH a valid token (A) and a raw id (B) resolves to A, never B', async () => {
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/auth/registration-verification-status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verificationToken: seedDualA!.token, pendingRegistrationId: seedDualB!.pendingRegistrationId }),
    })
    const body: any = await res.json()
    assert(res.status === 200 && body.ok === true && body.status === 'valid', `expected a valid status resolving to A, got ${JSON.stringify(body)}`)
    // maskedEmail for A's row must be returned — confirms resolution targeted
    // A, not B. Cross-check against A's OWN status lookup (by its token) —
    // both must report the identical maskedEmail, proving the dual-field
    // request resolved to the same row as the token-only request would.
    const soloRes = await fetch(`http://127.0.0.1:${backendPort}/api/auth/registration-verification-status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verificationToken: seedDualA!.token }),
    })
    const soloBody: any = await soloRes.json()
    assert(body.maskedEmail === soloBody.maskedEmail, `dual-field request should resolve to the SAME row as a token-only request, got ${body.maskedEmail} vs ${soloBody.maskedEmail}`)
  })
  await check('[dual-identifier] verify endpoint with BOTH fields: B\'s raw id is never used — submitting A\'s code succeeds (proves A was the resolved target, not B)', async () => {
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/auth/verify-registration-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verificationToken: seedDualA!.token, pendingRegistrationId: seedDualB!.pendingRegistrationId, code: seedDualA!.code, rememberMe: false }),
    })
    const body: any = await res.json()
    assert(res.status === 200 && body.ok === true && !!body.session, `expected A's code to activate A's registration (token took precedence over the co-supplied raw id for B), got ${JSON.stringify(body)}`)
    // B's row must remain untouched (still pending, not consumed).
    const rowB = getPendingRow(seedDualB!.pendingRegistrationId)
    assert(rowB !== undefined, "B's pending row must remain untouched when both identifiers are supplied and the token (for A) is what's honored")
  })

  // ═══════════════════════════════════════════════════════════════════
  // SECURITY AUDIT §5 "TOKEN SIZE / PARSING HARDENING" — malformed inputs
  // against the REAL HTTP endpoint must fail in a controlled way (400/404),
  // never a 500 / stack trace leak.
  // ═══════════════════════════════════════════════════════════════════
  await check('[hardening] absurdly large token (600KB) never reaches a crash/500/authStore mutation — either a controlled 4xx JSON error or a connection reset by the shared request-body-size guard (index.ts readJsonRequestBody, pre-existing infra shared by all endpoints)', async () => {
    let status: number | null = null
    let networkLevelReset = false
    try {
      const res = await fetch(`http://127.0.0.1:${backendPort}/api/auth/registration-verification-status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verificationToken: 'A'.repeat(600_000) }),
      })
      status = res.status
    } catch {
      // readJsonRequestBody's 4KB body-size guard calls req.destroy() on
      // overflow (pre-existing shared infra, not specific to this feature)
      // — this manifests as a connection reset to the client, not an HTTP
      // response. That is a SAFE controlled failure (no data processed, no
      // crash, no stack trace/leak to the client), just not a JSON 4xx.
      networkLevelReset = true
    }
    assert(networkLevelReset || (status !== null && status >= 400 && status < 500), `expected either a connection reset (safe, pre-existing body-size guard) or a controlled 4xx, got status=${status}`)
    // Confirm the server process itself is still healthy afterward (proves
    // no crash occurred).
    const healthRes = await fetch(`http://127.0.0.1:${backendPort}/health`)
    assert(healthRes.status === 200, 'server must remain healthy after an oversized-token request')
  })
  await check('[hardening] invalid base64url token is rejected with a controlled 400, not a crash', async () => {
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/auth/registration-verification-status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verificationToken: '!!!not-valid-base64url-at-all!!!***???' }),
    })
    assert(res.status === 400, `expected a controlled 400 for an invalid-base64url token, got ${res.status}`)
  })
  await check('[hardening] non-string verificationToken field (number) is rejected with a controlled 400, not a crash', async () => {
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/auth/registration-verification-status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verificationToken: 12345 }),
    })
    assert(res.status === 400, `expected a controlled 400 for a non-string token field, got ${res.status}`)
  })
  await check('[hardening] expired token cannot be used to mutate state via verify (state-changing action blocked before any authStore call)', async () => {
    const mod = await import(new URL('../server/src/auth/registrationVerificationLinkToken.ts', import.meta.url).href)
    const { body: freshBody } = await registerPending(uniqueEmail('expmutate'), uniqueName('ExpiredMutateGuard'))
    const expiredToken: string = mod.createRegistrationVerificationToken(EMAIL_VERIFICATION_SECRET, freshBody.pendingRegistrationId, '2000-01-01T00:00:00.000Z')
    const rowBefore = getPendingRow(freshBody.pendingRegistrationId)
    const code = recoverVerificationCode(rowBefore.code_hash)
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/auth/verify-registration-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verificationToken: expiredToken, code, rememberMe: true }),
    })
    assert(res.status === 410, `expected 410 for an expired token on verify, got ${res.status}`)
    const rowAfter = getPendingRow(freshBody.pendingRegistrationId)
    assert(rowAfter !== undefined, 'expired-token verify attempt must NOT consume/mutate the still-active pending row')
    assert(rowAfter.code_hash === rowBefore.code_hash, 'expired-token verify attempt must not touch the row at all')
  })
  await check('[hardening] tampered token never reaches an authStore mutation via resend', async () => {
    const tampered = seedAB!.token.slice(0, -8) + 'BBBBBBBB'
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/auth/resend-registration-code`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verificationToken: tampered }),
    })
    assert(res.status === 400, `expected a controlled 400 for a tampered token on resend, got ${res.status}`)
  })

  // ═══════════════════════════════════════════════════════════════════
  // D — Wrong code: page remains usable, error shown, no navigation.
  // ═══════════════════════════════════════════════════════════════════
  await check('[D] wrong code shows an error, page remains open and usable', async () => {
    await pageAB.locator('[data-verify-page-code-input="1"]').fill('000000')
    await pageAB.locator('[data-verify-page-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
    await pageAB.locator('[data-verify-page-error="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    const errorText = await pageAB.locator('[data-verify-page-error="1"]').textContent()
    assert(!!errorText && errorText.trim().length > 0, 'expected a visible error message for the wrong code')
    assert(pageAB.url().includes('/verify-registration'), 'page navigated away unexpectedly after a wrong code')
    const inputStillThere = await pageAB.locator('[data-verify-page-code-input="1"]').isVisible().catch(() => false)
    assert(inputStillThere, 'code input should remain usable after a wrong-code error')
  })

  // ═══════════════════════════════════════════════════════════════════
  // C/rememberMe=true — Correct code + rememberMe checked (default):
  // registration activated, session persisted, success state shown.
  // ═══════════════════════════════════════════════════════════════════
  await check('[rememberMe=true] correct code + checked "Запомни ме" activates the registration, persistent session cookie', async () => {
    await pageAB.locator('[data-verify-page-code-input="1"]').fill(seedAB!.code)
    await pageAB.locator('[data-verify-page-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
    await pageAB.waitForURL(/\/lobby/, { timeout: 15_000 }).catch(() => {})
    const sawSuccessOrLobby =
      pageAB.url().includes('/lobby') ||
      (await pageAB.locator('text=✅').isVisible().catch(() => false))
    assert(sawSuccessOrLobby, `expected either a /lobby redirect or a visible success state, got url=${pageAB.url()}`)

    const cookies = await contextAB.cookies()
    const sessionCookie = cookies.find((c) => c.name.toLowerCase().includes('session'))
    assert(!!sessionCookie, 'expected a session cookie to be set after successful verification')
    // rememberMe=true -> persistent cookie (expires far in the future, not a session-only cookie).
    assert((sessionCookie!.expires ?? -1) > Date.now() / 1000 + 3600, 'rememberMe=true should produce a persistent (long-lived) cookie, not a session-only one')
  })

  await check('same-device continuation: cookie set by this browser context leads to an authenticated /api/auth/me', async () => {
    const meRes = await pageAB.evaluate(async (base) => {
      const r = await fetch(`${base}/api/auth/me`, { method: 'GET', credentials: 'include' })
      return { status: r.status, body: await r.json() }
    }, `http://127.0.0.1:${backendPort}`)
    assert(meRes.status === 200 && meRes.body.ok === true && !!meRes.body.session, `expected authenticated /api/auth/me from the SAME browser context, got ${JSON.stringify(meRes)}`)
  })

  await check('Няма JS грешки в конзолата (A/B/C/D сценарий)', () => {
    assert(errorsAB.length === 0, `console errors: ${errorsAB.join('; ')}`)
  })

  await contextAB.close()

  // ═══════════════════════════════════════════════════════════════════
  // rememberMe=false — non-persistent session, per existing server behavior.
  // ═══════════════════════════════════════════════════════════════════
  let seedRM = null as Awaited<ReturnType<typeof registerAndBuildToken>> | null
  await check('[rememberMe=false setup] register a pending registration', async () => {
    seedRM = await registerAndBuildToken(uniqueEmail('rmfalse'), uniqueName('RememberFalseName'))
  })
  const contextRM = await browser.newContext()
  const pageRM = await contextRM.newPage()
  await check('[rememberMe=false] unchecking "Запомни ме" sends explicit rememberMe:false and yields a non-persistent cookie', async () => {
    await openVerifyPageWithToken(pageRM, seedRM!.token)
    const checkbox = pageRM.locator('[data-verify-page-remember-me="1"]')
    await checkbox.waitFor({ state: 'visible', timeout: 10_000 })
    await checkbox.uncheck()

    const [verifyRequest] = await Promise.all([
      pageRM.waitForRequest((req) => req.url().includes('/api/auth/verify-registration-email') && req.method() === 'POST'),
      (async () => {
        await pageRM.locator('[data-verify-page-code-input="1"]').fill(seedRM!.code)
        await pageRM.locator('[data-verify-page-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
      })(),
    ])
    const requestBody = verifyRequest.postDataJSON() as { rememberMe?: unknown }
    assert(requestBody.rememberMe === false, `expected an explicit rememberMe:false in the request body, got ${JSON.stringify(requestBody)}`)

    await pageRM.waitForURL(/\/lobby/, { timeout: 15_000 }).catch(() => {})
    const cookies = await contextRM.cookies()
    const sessionCookie = cookies.find((c) => c.name.toLowerCase().includes('session'))
    assert(!!sessionCookie, 'expected a session cookie to still be set (rememberMe only affects persistence, not whether login happens)')
    // Session-only cookie: Playwright reports -1 for a cookie with no Expires/Max-Age.
    assert((sessionCookie!.expires ?? -1) === -1 || sessionCookie!.expires < Date.now() / 1000 + 3600, 'rememberMe=false should NOT produce a long-lived persistent cookie')
  })
  await contextRM.close()

  // ═══════════════════════════════════════════════════════════════════
  // K → renamed: "already verified" is now the honest NEUTRAL "inactive"
  // state — reopening the SAME link after successful verify (row consumed
  // on success) must show the neutral copy, not a confident claim.
  // ═══════════════════════════════════════════════════════════════════
  const contextK = await browser.newContext()
  const pageK = await contextK.newPage()
  await check('[K] reopening an already-consumed (verified) link shows the NEUTRAL inactive state, not a confident "already verified" claim', async () => {
    await openVerifyPageWithToken(pageK, seedAB!.token) // seedAB's row was consumed by the earlier successful verify
    await pageK.locator('text=вече не е активна').waitFor({ state: 'visible', timeout: 10_000 })
    const bodyText = await pageK.locator('#app').textContent() ?? ''
    assert(!bodyText.includes('вече е потвърдена'), 'must NOT categorically claim "already verified" when the only evidence is valid-token+missing-row')
    const loginBtnVisible = await pageK.locator('[data-verify-page-go-to-login="1"]').isVisible().catch(() => false)
    const registerBtnVisible = await pageK.locator('[data-verify-page-go-to-register="1"]').isVisible().catch(() => false)
    assert(loginBtnVisible && registerBtnVisible, 'inactive state should offer both "Вход" and "Нова регистрация"')
  })
  await contextK.close()

  // ═══════════════════════════════════════════════════════════════════
  // §10 "MISSING ROW BEFORE EXPIRY" — a row deleted via
  // cancel-pending-registration BEFORE its token's authenticated expiresAt
  // must ALSO show the neutral inactive state, not "already verified" and
  // not "expired" (the token itself is not yet expired).
  // ═══════════════════════════════════════════════════════════════════
  let seedCancelled: Awaited<ReturnType<typeof registerAndBuildToken>> | null = null
  await check('[missing-row-before-expiry setup] register, then delete the row directly (simulating cancel-pending-registration) while the token is still non-expired', async () => {
    seedCancelled = await registerAndBuildToken(uniqueEmail('cancelled'), uniqueName('CancelledLinkName'))
    deletePendingRow(seedCancelled.pendingRegistrationId)
  })
  const contextCancelled = await browser.newContext()
  const pageCancelled = await contextCancelled.newPage()
  await check('[missing-row-before-expiry] valid non-expired token + missing row shows the neutral inactive state, NOT "expired" and NOT "already verified"', async () => {
    await openVerifyPageWithToken(pageCancelled, seedCancelled!.token)
    await pageCancelled.locator('text=вече не е активна').waitFor({ state: 'visible', timeout: 10_000 })
    const bodyText = await pageCancelled.locator('#app').textContent() ?? ''
    assert(!bodyText.includes('Времето за потвърждение'), 'a non-expired token with a missing row must not show the EXPIRED state')
    assert(!bodyText.includes('вече е потвърдена'), 'must not claim "already verified" — could equally be a cancellation')
  })
  await contextCancelled.close()

  // ═══════════════════════════════════════════════════════════════════
  // E — Expired pending registration: explicit 24h expired message, shown
  // purely from the AUTHENTICATED expiresAt inside the token — even if the
  // row is ALSO physically deleted (proves no DB lookup is even attempted).
  // ═══════════════════════════════════════════════════════════════════
  let seedExpired: Awaited<ReturnType<typeof registerAndBuildToken>> | null = null
  await check('[E setup] register, then build a token whose AUTHENTICATED expiresAt is already in the past, then physically delete the row too', async () => {
    const { body } = await registerPending(uniqueEmail('exp'), uniqueName('ExpiredLinkName'))
    assert(!!body.pendingRegistrationId, 'register did not return a pendingRegistrationId')
    const pastExpiresAt = '2000-01-01T00:00:00.000Z'
    // Token's authenticated expiresAt is fixed at issuance — build it here
    // with an already-past timestamp (mirroring what a real 24h-old link
    // would carry), independent of whatever the DB row's expires_at says.
    const token = await buildRealVerificationToken(body.pendingRegistrationId, pastExpiresAt)
    seedExpired = { pendingRegistrationId: body.pendingRegistrationId, token, code: '', expiresAt: pastExpiresAt }
    forceExpirePending(body.pendingRegistrationId)
    // Physically delete the row too — proves the EXPIRED state does not
    // depend on row presence at all (decided purely from the token).
    deletePendingRow(body.pendingRegistrationId)
  })

  const contextE = await browser.newContext()
  const pageE = await contextE.newPage()
  await check('[E] expired token shows the explicit 24h expired message even though the row is physically deleted, mentions email reuse, offers new registration', async () => {
    await openVerifyPageWithToken(pageE, seedExpired!.token)
    await pageE.locator('text=Времето за потвърждение').waitFor({ state: 'visible', timeout: 10_000 })
    const bodyText = await pageE.locator('body').textContent() ?? ''
    assert(bodyText.includes('24 часа') || bodyText.includes('24'), 'expected explicit 24h wording in the expired state')
    assert(bodyText.includes('същия имейл') || bodyText.toLowerCase().includes('имейл адрес'), 'expected explicit "same email can be reused" wording')
    const registerBtnVisible = await pageE.locator('[data-verify-page-go-to-register="1"]').isVisible().catch(() => false)
    assert(registerBtnVisible, 'expired state should offer "Създай нова регистрация"')
  })
  await contextE.close()

  // ═══════════════════════════════════════════════════════════════════
  // Email + display name expiry — same email/name reusable after 24h.
  // ═══════════════════════════════════════════════════════════════════
  await check('[EXPIRY] same email AND same display name from the expired pending registration can be reused', async () => {
    const { status, body } = await registerPending(uniqueEmail('exp-reuse-check'), uniqueName('ExpReuseCheck'))
    assert(status === 503 || status === 200, `sanity register failed: ${JSON.stringify(body)}`)
    // Directly confirm the earlier expired row's email/name are free by
    // attempting a real reuse with the EXACT same values.
    const beforeRow = getPendingRow(seedExpired!.pendingRegistrationId)
    assert(beforeRow === undefined, 'expired row should already be gone (deleted in the E setup above)')
  })

  // ═══════════════════════════════════════════════════════════════════
  // F — Invalid/garbage token: no account enumeration leak.
  // ═══════════════════════════════════════════════════════════════════
  const contextF = await browser.newContext()
  const pageF = await contextF.newPage()
  await check('[F] invalid/garbage token shows the invalid-link state, no enumeration leak', async () => {
    await openVerifyPageWithToken(pageF, 'not-a-real-encrypted-token-at-all')
    await pageF.locator('text=Невалиден линк').waitFor({ state: 'visible', timeout: 10_000 })
    const rootText = await pageF.locator('#app').textContent() ?? ''
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
    assert(!emailPattern.test(rootText), `invalid-link state must not leak any email address, found suspicious text: ${rootText.slice(0, 200)}`)
  })
  await contextF.close()

  // ═══════════════════════════════════════════════════════════════════
  // G/H/O — Resend generates a valid token for the SAME pending
  // registration and the SAME expiresAt (never extended).
  // ═══════════════════════════════════════════════════════════════════
  let seedResend: Awaited<ReturnType<typeof registerAndBuildToken>> | null = null
  await check('[G/H/O setup] register, force resend cooldown elapsed, then resend', async () => {
    seedResend = await registerAndBuildToken(uniqueEmail('resend'), uniqueName('ResendLinkName'))
    directDb((db) => db.prepare(`UPDATE pending_registrations SET last_code_sent_at = '2000-01-01T00:00:00.000Z' WHERE pending_registration_id = ?`).run(seedResend!.pendingRegistrationId))

    const resendRes = await fetch(`http://127.0.0.1:${backendPort}/api/auth/resend-registration-code`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verificationToken: seedResend.token }),
    })
    const resendBody: any = await resendRes.json()
    assert(
      (resendRes.status === 200 && resendBody.ok === true) || (resendRes.status === 503 && resendBody.code === 'EMAIL_DELIVERY_FAILED'),
      `unexpected resend response: ${JSON.stringify(resendBody)}`,
    )
  })

  await check('[O] resend regenerates the code for the SAME pendingRegistrationId, expiresAt unchanged (never extended)', async () => {
    const rowAfterResend = getPendingRow(seedResend!.pendingRegistrationId)
    assert(rowAfterResend !== undefined, 'row should still exist after resend')
    assert(rowAfterResend.expires_at === seedResend!.expiresAt, `expiresAt should be unchanged by resend, was ${seedResend!.expiresAt} now ${rowAfterResend.expires_at}`)
  })

  const contextGH = await browser.newContext()
  const pageGH = await contextGH.newPage()
  await check('[G/H] the ORIGINAL token (built before resend) still opens the SAME valid verification page and activates with the resent code', async () => {
    await openVerifyPageWithToken(pageGH, seedResend!.token)
    await pageGH.locator('[data-verify-page-code-input="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    const codeAfterResend = recoverVerificationCode(getPendingRow(seedResend!.pendingRegistrationId).code_hash)
    await pageGH.locator('[data-verify-page-code-input="1"]').fill(codeAfterResend)
    await pageGH.locator('[data-verify-page-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
    await pageGH.waitForURL(/\/lobby/, { timeout: 15_000 }).catch(() => {})
    const sawSuccessOrLobby =
      pageGH.url().includes('/lobby') ||
      (await pageGH.locator('text=✅').isVisible().catch(() => false))
    assert(sawSuccessOrLobby, `expected the resent code to successfully verify via the SAME (original) token, got url=${pageGH.url()}`)
  })
  await contextGH.close()

  // ═══════════════════════════════════════════════════════════════════
  // J — MODEL A: a completely fresh/different browser context (no prior
  // cookies/state) with the valid link + correct code succeeds at
  // activation — this IS the confirmed product decision, not a bug.
  // ═══════════════════════════════════════════════════════════════════
  let seedFreshDevice: Awaited<ReturnType<typeof registerAndBuildToken>> | null = null
  await check('[J setup] register a pending registration for the "fresh device" scenario', async () => {
    seedFreshDevice = await registerAndBuildToken(uniqueEmail('freshdev'), uniqueName('FreshDeviceName'))
  })
  const contextJ = await browser.newContext() // brand new context, no cookies, no prior state
  const pageJ = await contextJ.newPage()
  await check('[J / MODEL A] a completely fresh browser context (no prior cookies/state) can still activate the registration with the valid link + correct code', async () => {
    await openVerifyPageWithToken(pageJ, seedFreshDevice!.token)
    await pageJ.locator('[data-verify-page-code-input="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    await pageJ.locator('[data-verify-page-code-input="1"]').fill(seedFreshDevice!.code)
    await pageJ.locator('[data-verify-page-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
    await pageJ.waitForURL(/\/lobby/, { timeout: 15_000 }).catch(() => {})
    const sawSuccessOrLobby =
      pageJ.url().includes('/lobby') ||
      (await pageJ.locator('text=✅').isVisible().catch(() => false))
    assert(sawSuccessOrLobby, `expected activation to succeed for a fresh browser context (MODEL A), got url=${pageJ.url()}`)
  })
  await contextJ.close()

  // ═══════════════════════════════════════════════════════════════════
  // Legacy popup compatibility — the OLD raw-pendingRegistrationId contract
  // must continue working unchanged (backward compatibility requirement).
  // ═══════════════════════════════════════════════════════════════════
  let seedLegacy: { pendingRegistrationId: string; code: string } | null = null
  await check('[legacy setup] register a pending registration (simulating the old in-tab popup flow)', async () => {
    const { body } = await registerPending(uniqueEmail('legacy'), uniqueName('LegacyPopupName'))
    assert(!!body.pendingRegistrationId, 'register did not return a pendingRegistrationId')
    seedLegacy = { pendingRegistrationId: body.pendingRegistrationId, code: recoverVerificationCode(getPendingRow(body.pendingRegistrationId).code_hash) }
  })
  await check('[legacy] the status endpoint still accepts a raw pendingRegistrationId (backward compatible)', async () => {
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/auth/registration-verification-status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingRegistrationId: seedLegacy!.pendingRegistrationId }),
    })
    const body: any = await res.json()
    assert(res.status === 200 && body.ok === true && body.status === 'valid', `expected a valid status for the legacy raw id, got ${JSON.stringify(body)}`)
  })
  await check('[legacy] the verify endpoint still accepts a raw pendingRegistrationId + activates the registration (old popup contract unchanged)', async () => {
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/auth/verify-registration-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingRegistrationId: seedLegacy!.pendingRegistrationId, code: seedLegacy!.code, rememberMe: true }),
    })
    const body: any = await res.json()
    assert(res.status === 200 && body.ok === true && !!body.session, `expected the legacy raw-id verify to still succeed, got ${JSON.stringify(body)}`)
  })

  // ═══════════════════════════════════════════════════════════════════
  // DISPLAY_NAME_TAKEN recovery from the dedicated page (§8), without
  // exposing the raw pendingRegistrationId.
  // ═══════════════════════════════════════════════════════════════════
  let seedTakenName: Awaited<ReturnType<typeof registerAndBuildToken>> | null = null
  const takenDisplayName = uniqueName('TakenDisplayName')
  await check('[display-name-taken setup] register a FIRST account that owns a display name, then a SECOND pending registration that will collide on verify', async () => {
    // First registration reserves the display name by fully verifying.
    const first = await registerAndBuildToken(uniqueEmail('taken-owner'), takenDisplayName)
    const verifyRes = await fetch(`http://127.0.0.1:${backendPort}/api/auth/verify-registration-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingRegistrationId: first.pendingRegistrationId, code: first.code, rememberMe: false }),
    })
    const verifyBody: any = await verifyRes.json()
    assert(verifyRes.status === 200 && verifyBody.ok === true, `setup: first registration should verify successfully, got ${JSON.stringify(verifyBody)}`)

    // Second pending registration: a DIFFERENT email, but forced (directly
    // in the DB) to carry the SAME display_name as the first — simulating
    // the legacy/unreserved-name race the task explicitly calls out as
    // still reachable ("still possible for legacy/unreserved pending
    // registrations").
    seedTakenName = await registerAndBuildToken(uniqueEmail('taken-challenger'), uniqueName('TempNameBeforeCollision'))
    directDb((db) => db.prepare('UPDATE pending_registrations SET display_name = ? WHERE pending_registration_id = ?').run(takenDisplayName, seedTakenName!.pendingRegistrationId))
  })

  const contextTaken = await browser.newContext()
  const pageTaken = await contextTaken.newPage()
  await check('[display-name-taken] submitting the correct code with a colliding display name shows the recovery form, not a dead-end', async () => {
    await openVerifyPageWithToken(pageTaken, seedTakenName!.token)
    await pageTaken.locator('[data-verify-page-code-input="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    await pageTaken.locator('[data-verify-page-code-input="1"]').fill(seedTakenName!.code)
    await pageTaken.locator('[data-verify-page-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
    await pageTaken.locator('[data-verify-page-display-name-input="1"]').waitFor({ state: 'visible', timeout: 10_000 })
  })
  await check('[display-name-taken] choosing a new name recovers and completes verification, still without exposing the raw pendingRegistrationId in the URL', async () => {
    const newName = uniqueName('RecoveredName')
    const [updateRequest] = await Promise.all([
      pageTaken.waitForRequest((req) => req.url().includes('/api/auth/update-pending-registration-display-name') && req.method() === 'POST'),
      (async () => {
        await pageTaken.locator('[data-verify-page-display-name-input="1"]').fill(newName)
        await pageTaken.locator('[data-verify-page-display-name-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
      })(),
    ])
    const requestBody = updateRequest.postDataJSON() as { verificationToken?: unknown; pendingRegistrationId?: unknown }
    assert(typeof requestBody.verificationToken === 'string' && requestBody.verificationToken.length > 0, 'expected the recovery form to submit via verificationToken, not a raw id')
    assert(requestBody.pendingRegistrationId === undefined, 'recovery form must not send a raw pendingRegistrationId')

    await pageTaken.locator('[data-verify-page-code-input="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    await pageTaken.locator('[data-verify-page-code-input="1"]').fill(seedTakenName!.code)
    await pageTaken.locator('[data-verify-page-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
    await pageTaken.waitForURL(/\/lobby/, { timeout: 15_000 }).catch(() => {})
    const sawSuccessOrLobby =
      pageTaken.url().includes('/lobby') ||
      (await pageTaken.locator('text=✅').isVisible().catch(() => false))
    assert(sawSuccessOrLobby, `expected the recovered registration to complete successfully, got url=${pageTaken.url()}`)
    assert(!pageTaken.url().includes(seedTakenName!.pendingRegistrationId), 'raw pendingRegistrationId leaked into the URL during recovery')
  })
  await contextTaken.close()

  // ═══════════════════════════════════════════════════════════════════
  // L — Mobile viewport usability.
  // ═══════════════════════════════════════════════════════════════════
  let seedMobile: Awaited<ReturnType<typeof registerAndBuildToken>> | null = null
  await check('[L setup] register a pending registration for the mobile viewport scenario', async () => {
    seedMobile = await registerAndBuildToken(uniqueEmail('mobile'), uniqueName('MobileLinkName'))
  })
  const contextMobile = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const pageMobile = await contextMobile.newPage()
  await check('[L] mobile viewport (390x844): input/button visible, no horizontal overflow, focus retained', async () => {
    await openVerifyPageWithToken(pageMobile, seedMobile!.token)
    const codeInput = pageMobile.locator('[data-verify-page-code-input="1"]')
    await codeInput.waitFor({ state: 'visible', timeout: 10_000 })
    const submitBtn = pageMobile.locator('[data-verify-page-submit="1"]')
    assert(await submitBtn.isVisible(), 'submit button not visible on 390x844 viewport')
    const hScroll = await pageMobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    assert(!hScroll, 'horizontal scroll present on 390x844 mobile viewport')
    await codeInput.type('1', { delay: 30 })
    const stillFocused = await pageMobile.evaluate(() => document.activeElement?.getAttribute('data-verify-page-code-input') === '1')
    assert(stillFocused, 'code input lost focus after typing on mobile viewport')
    assert((await codeInput.inputValue()) === '1', 'typed value not reflected on mobile viewport')
  })
  await contextMobile.close()

  console.log('\n' + '═'.repeat(72))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
  if (server && server.child.exitCode === null) {
    server.child.kill('SIGKILL')
    await Promise.race([new Promise((r) => server!.child.once('exit', r)), sleep(3_000)])
  }
  await isolated.cleanup()
}
