// checkDisplayNameReservationFullSuite.ts
//
// FINAL PLAN v5 — focused test suite for the Display Name Reservation
// implementation. Real spawned isolated server, real HTTP API, real SQLite
// file (no mocks for the reservation logic itself). Covers the 22-item test
// list from the approved plan (some collapsed where one real-server scenario
// naturally proves two adjacent list items).
//
// Uses the same isolated-server + throwaway-secret + brute-force-code
// pattern established in checkRegistrationDisplayNameReservationRace.ts /
// checkLudoEmojiDiceInteraction.ts. Timestamp-manipulation tests (expiry,
// resend cooldown) write DIRECTLY to this harness's own throwaway SQLite
// file between HTTP calls — never against any real/production DB.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-name-reservation-suite-'))
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
const EMAIL_VERIFICATION_SECRET = 'name-reservation-full-suite-throwaway-secret-32chars'
function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), EMAIL_VERIFICATION_CODE_SECRET: EMAIL_VERIFICATION_SECRET },
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

console.log('\ncheckDisplayNameReservationFullSuite\n')

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
try {
  const port = await freePort()
  server = startServer(isolated.serverDir, port)
  console.log(`Waiting for server on port ${port}...`)
  if (!(await waitForHealth(port))) { console.error(server.output()); throw new Error('server did not become ready') }
  console.log('Server ready.\n')

  async function registerPending(email: string, displayName: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'SuiteTest1!', displayName, gender: 'male', visitorId: randomVisitorUuid() }),
    })
    const body: any = await res.json()
    return { status: res.status, body }
  }

  async function checkName(name: string): Promise<boolean> {
    const res = await fetch(`http://127.0.0.1:${port}/api/profile/check-name?name=${encodeURIComponent(name)}`)
    const body: any = await res.json()
    return body.available === true
  }

  function readCodeHash(pendingRegistrationId: string): string {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db.prepare('SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?').get(pendingRegistrationId) as { code_hash: string } | undefined
      if (!row) throw new Error(`pending row not found for ${pendingRegistrationId}`)
      return row.code_hash
    } finally {
      db.close()
    }
  }

  async function verifyPending(pendingRegistrationId: string, codeOverride?: string): Promise<{ status: number; body: any }> {
    const code = codeOverride ?? recoverVerificationCode(readCodeHash(pendingRegistrationId))
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/verify-registration-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingRegistrationId, code }),
    })
    const body: any = await res.json()
    return { status: res.status, body }
  }

  async function updatePendingDisplayName(pendingRegistrationId: string, displayName: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/update-pending-registration-display-name`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingRegistrationId, displayName }),
    })
    const body: any = await res.json()
    return { status: res.status, body }
  }

  async function resendCode(pendingRegistrationId: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/resend-registration-code`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingRegistrationId }),
    })
    const body: any = await res.json()
    return { status: res.status, body }
  }

  function directDb<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(dbPath)
    try {
      return fn(db)
    } finally {
      db.close()
    }
  }

  function getPendingRow(pendingRegistrationId: string): any {
    return directDb((db) => db.prepare('SELECT * FROM pending_registrations WHERE pending_registration_id = ?').get(pendingRegistrationId))
  }

  function forceExpirePending(pendingRegistrationId: string): void {
    directDb((db) => db.prepare(`UPDATE pending_registrations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE pending_registration_id = ?`).run(pendingRegistrationId))
  }

  function forceResendCooldownElapsed(pendingRegistrationId: string): void {
    directDb((db) => db.prepare(`UPDATE pending_registrations SET last_code_sent_at = '2000-01-01T00:00:00.000Z' WHERE pending_registration_id = ?`).run(pendingRegistrationId))
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 1 — Register NameX -> reservation exists (DB assertion).
  // ═══════════════════════════════════════════════════════════════════
  let t1PendingId = ''
  const t1Name = uniqueName('ReserveA')
  await check('[TEST 1] register NameX -> normalized_display_name reservation exists in DB', async () => {
    const { status, body } = await registerPending(uniqueEmail('t1'), t1Name)
    assert(status === 503 && body.code === 'EMAIL_DELIVERY_FAILED' && body.pendingRegistrationId, `unexpected register response: ${JSON.stringify(body)}`)
    t1PendingId = body.pendingRegistrationId
    const row = getPendingRow(t1PendingId)
    assert(row !== undefined, 'pending row not found')
    assert(row.normalized_display_name === t1Name.toLocaleLowerCase('bg-BG'), `expected normalized_display_name='${t1Name.toLocaleLowerCase('bg-BG')}', got '${row.normalized_display_name}'`)
  })

  // ═══════════════════════════════════════════════════════════════════
  // TEST 2 — Pending NameX -> check-name(NameX) unavailable.
  // ═══════════════════════════════════════════════════════════════════
  await check('[TEST 2] pending NameX -> check-name(NameX) reports unavailable', async () => {
    const available = await checkName(t1Name)
    assert(available === false, 'expected check-name to report unavailable while pending reservation is active')
  })

  // ═══════════════════════════════════════════════════════════════════
  // TEST 3 — Pending NameX -> second register NameX -> DISPLAY_NAME_TAKEN immediately.
  // ═══════════════════════════════════════════════════════════════════
  await check('[TEST 3] second register(NameX) while first pending is active -> immediate DISPLAY_NAME_TAKEN', async () => {
    const { status, body } = await registerPending(uniqueEmail('t3'), t1Name)
    assert(status === 400, `expected 400, got ${status}`)
    assert(body.code === 'DISPLAY_NAME_TAKEN', `expected code DISPLAY_NAME_TAKEN, got ${JSON.stringify(body)}`)
  })

  // ═══════════════════════════════════════════════════════════════════
  // TEST 4 — Owner verify NameX -> success.
  // ═══════════════════════════════════════════════════════════════════
  await check('[TEST 4] owner verifies NameX -> success, profile created', async () => {
    const { status, body } = await verifyPending(t1PendingId)
    assert(status === 200 && body.ok === true, `expected successful verify, got ${JSON.stringify(body)}`)
    const profile = directDb((db) => db.prepare('SELECT profile_id FROM profiles WHERE normalized_display_name = ?').get(t1Name.toLocaleLowerCase('bg-BG')))
    assert(profile !== undefined, 'profile row not found after successful verify')
    const pendingAfter = getPendingRow(t1PendingId)
    assert(pendingAfter === undefined, 'pending row should be consumed (deleted) after successful verify')
  })

  // ═══════════════════════════════════════════════════════════════════
  // TEST 5 — Expired NameX -> new registration can claim NameX.
  // ═══════════════════════════════════════════════════════════════════
  let t5PendingId = ''
  const t5Name = uniqueName('ExpireMe')
  await check('[TEST 5 setup] create a pending registration to force-expire', async () => {
    const { body } = await registerPending(uniqueEmail('t5a'), t5Name)
    t5PendingId = body.pendingRegistrationId
    assert(!!t5PendingId, 'setup failed to create pending row')
  })
  await check('[TEST 5] expired pending NameX -> new registration CAN claim NameX', async () => {
    forceExpirePending(t5PendingId)
    const { status, body } = await registerPending(uniqueEmail('t5b'), t5Name)
    assert(status === 503 && body.code === 'EMAIL_DELIVERY_FAILED', `expected the new registration to succeed (past validation), got ${JSON.stringify(body)}`)
    const oldRow = getPendingRow(t5PendingId)
    assert(oldRow === undefined, 'old expired row should have been cleaned up by the new claim')
  })

  // ═══════════════════════════════════════════════════════════════════
  // TEST 6 — Two concurrent register attempts, different emails, same
  // name -> exactly one winner.
  // ═══════════════════════════════════════════════════════════════════
  await check('[TEST 6] two truly-concurrent register() calls, same name, different emails -> exactly one winner', async () => {
    const name = uniqueName('ConcurName')
    const [r1, r2] = await Promise.all([
      registerPending(uniqueEmail('t6a'), name),
      registerPending(uniqueEmail('t6b'), name),
    ])
    const results = [r1, r2]
    const winners = results.filter((r) => r.status === 503 && r.body.code === 'EMAIL_DELIVERY_FAILED')
    const losers = results.filter((r) => r.status === 400 && r.body.code === 'DISPLAY_NAME_TAKEN')
    assert(winners.length === 1, `expected exactly 1 winner, got ${winners.length} (results: ${JSON.stringify(results)})`)
    assert(losers.length === 1, `expected exactly 1 loser (DISPLAY_NAME_TAKEN), got ${losers.length} (results: ${JSON.stringify(results)})`)
  })

  // ═══════════════════════════════════════════════════════════════════
  // TEST 7 — Failed pending display-name change preserves old reservation.
  // ═══════════════════════════════════════════════════════════════════
  let t7PendingA = ''
  let t7PendingB = ''
  const t7NameA = uniqueName('OwnsNameA')
  const t7NameB = uniqueName('OwnsNameB')
  await check('[TEST 7 setup] A owns NameA, B owns NameB', async () => {
    const ra = await registerPending(uniqueEmail('t7a'), t7NameA)
    const rb = await registerPending(uniqueEmail('t7b'), t7NameB)
    t7PendingA = ra.body.pendingRegistrationId
    t7PendingB = rb.body.pendingRegistrationId
    assert(!!t7PendingA && !!t7PendingB, 'setup failed to create both pending rows')
  })
  await check('[TEST 7] A tries pending-name-change to NameB (owned by B) -> fails, A still owns NameA', async () => {
    const { status, body } = await updatePendingDisplayName(t7PendingA, t7NameB)
    assert(status !== 200, `expected update to fail, got 200: ${JSON.stringify(body)}`)
    const rowA = getPendingRow(t7PendingA)
    assert(rowA.normalized_display_name === t7NameA.toLocaleLowerCase('bg-BG'), `A's reservation should remain '${t7NameA}', got '${rowA.normalized_display_name}'`)
    assert(rowA.display_name === t7NameA, `A's display_name should remain '${t7NameA}', got '${rowA.display_name}'`)
  })

  // ═══════════════════════════════════════════════════════════════════
  // TEST 8 — A NameA -> changes to free NameC -> NameA available, NameC reserved.
  // ═══════════════════════════════════════════════════════════════════
  const t8NameC = uniqueName('FreeNameC')
  await check('[TEST 8] successful pending display-name change releases old / claims new', async () => {
    const availableBefore = await checkName(t8NameC)
    assert(availableBefore === true, 'setup invalid: NameC should be available before the change')

    const { status, body } = await updatePendingDisplayName(t7PendingA, t8NameC)
    assert(status === 200 && body.ok === true, `expected successful update, got ${JSON.stringify(body)}`)

    const nameAAvailable = await checkName(t7NameA)
    assert(nameAAvailable === true, 'old NameA should become available after the change')
    const nameCAvailable = await checkName(t8NameC)
    assert(nameCAvailable === false, 'new NameC should now be reserved')

    const rowA = getPendingRow(t7PendingA)
    assert(rowA.normalized_display_name === t8NameC.toLocaleLowerCase('bg-BG'), `expected reservation moved to NameC, got '${rowA.normalized_display_name}'`)
  })

  // ═══════════════════════════════════════════════════════════════════
  // TEST 9 — Resend preserves reservation and does not extend expires_at.
  // ═══════════════════════════════════════════════════════════════════
  await check('[TEST 9] resend preserves reservation, does not change expires_at', async () => {
    const rowBefore = getPendingRow(t7PendingB)
    forceResendCooldownElapsed(t7PendingB)
    const { status, body } = await resendCode(t7PendingB)
    // This sandbox has no BREVO_API_KEY, so the DB-level resend (code_hash
    // regenerated, resend_count incremented) ALREADY succeeded before the
    // (expected, unrelated) email-send step fails with 503
    // EMAIL_DELIVERY_FAILED — same sandbox limitation as every other email
    // send in this suite. What matters for the reservation invariant is the
    // DB state, asserted directly below, not the HTTP email-delivery outcome.
    assert(
      (status === 200 && body.ok === true) || (status === 503 && body.code === 'EMAIL_DELIVERY_FAILED'),
      `expected resend to succeed at the DB level (200 ok, or 503 EMAIL_DELIVERY_FAILED after a successful DB update), got ${JSON.stringify(body)}`,
    )
    const rowAfter = getPendingRow(t7PendingB)
    assert(rowAfter.normalized_display_name === rowBefore.normalized_display_name, 'reservation changed after resend')
    assert(rowAfter.expires_at === rowBefore.expires_at, `expires_at should not change on resend (before=${rowBefore.expires_at}, after=${rowAfter.expires_at})`)
    assert(rowAfter.resend_count === rowBefore.resend_count + 1, `resend_count should increment by 1 (before=${rowBefore.resend_count}, after=${rowAfter.resend_count})`)
  })

  // ═══════════════════════════════════════════════════════════════════
  // TEST 10 — Active completed profile NameX blocks new pending claim.
  // ═══════════════════════════════════════════════════════════════════
  const t10Name = uniqueName('CompletedProfile')
  await check('[TEST 10 setup] complete a registration for NameX', async () => {
    const { body } = await registerPending(uniqueEmail('t10'), t10Name)
    const { status, body: verifyBody } = await verifyPending(body.pendingRegistrationId)
    assert(status === 200 && verifyBody.ok === true, 'setup failed to complete registration')
  })
  await check('[TEST 10] active completed profile blocks new pending claim', async () => {
    const { status, body } = await registerPending(uniqueEmail('t10b'), t10Name)
    assert(status === 400 && body.code === 'DISPLAY_NAME_TAKEN', `expected DISPLAY_NAME_TAKEN, got ${JSON.stringify(body)}`)
  })

  // ═══════════════════════════════════════════════════════════════════
  // TEST 11 — Active pending reservation blocks paid rename.
  // TEST 12 — Active pending reservation blocks admin rename.
  // (Exercised directly against playerProgressStore, not HTTP — these
  // require an authenticated profile + wallet balance / admin session,
  // which is orthogonal plumbing unrelated to the reservation logic under
  // test. Direct module-level invocation proves the SAME code path the
  // HTTP handlers call into.)
  // ═══════════════════════════════════════════════════════════════════
  await check('[TEST 11] active pending reservation blocks paid profile rename', async () => {
    const reservedName = uniqueName('PaidRenameTarget')
    const { body: pendingBody } = await registerPending(uniqueEmail('t11pending'), reservedName)
    assert(!!pendingBody.pendingRegistrationId, 'setup failed to reserve target name via pending registration')

    // Complete a separate, real profile to rename FROM.
    const renamerName = uniqueName('PaidRenamer')
    const { body: renamerPendingBody } = await registerPending(uniqueEmail('t11renamer'), renamerName)
    const { status: verifyStatus, body: verifyBody } = await verifyPending(renamerPendingBody.pendingRegistrationId)
    assert(verifyStatus === 200 && verifyBody.ok === true, 'setup failed to complete the renamer profile')
    const profileId = verifyBody.session.profile.profileId as string

    // Give the profile enough coins to attempt the rename (import module
    // directly against the SAME isolated DB file to invoke changeProfileDisplayName()).
    const { createPlayerProgressStore } = await import(pathToFileURL(join(isolated.serverDir, 'dist', 'db', 'playerProgressStore.js')).href)
    const store = await createPlayerProgressStore(dbPath)
    try {
      const result = store.changeProfileDisplayName(profileId, reservedName, 0)
      assert(result.ok === false, `expected rename to fail (blocked by active pending reservation), got: ${JSON.stringify(result)}`)
    } finally {
      store.close()
    }
  })

  await check('[TEST 12] active pending reservation blocks admin rename', async () => {
    const reservedName = uniqueName('AdminRenameTarget')
    const { body: pendingBody } = await registerPending(uniqueEmail('t12pending'), reservedName)
    assert(!!pendingBody.pendingRegistrationId, 'setup failed to reserve target name via pending registration')

    const targetName = uniqueName('AdminRenameSubject')
    const { body: subjectPendingBody } = await registerPending(uniqueEmail('t12subject'), targetName)
    const { status: verifyStatus, body: verifyBody } = await verifyPending(subjectPendingBody.pendingRegistrationId)
    assert(verifyStatus === 200 && verifyBody.ok === true, 'setup failed to complete the subject profile')
    const profileId = verifyBody.session.profile.profileId as string

    const { createPlayerProgressStore } = await import(pathToFileURL(join(isolated.serverDir, 'dist', 'db', 'playerProgressStore.js')).href)
    const store = await createPlayerProgressStore(dbPath)
    try {
      const result = store.adminRenameProfileDisplayName(profileId, reservedName)
      assert(result.ok === false, `expected admin rename to fail (blocked by active pending reservation), got: ${JSON.stringify(result)}`)
    } finally {
      store.close()
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // TEST 16 — Unreserved loser cannot verify and steal winner's reservation.
  // (TESTS 13/14/15/17/20/21/22 are covered separately by
  //  checkDisplayNameReservationMigrationSuite.ts, which needs to seed a DB
  //  BEFORE the migration runs — orthogonal harness shape from this
  //  runtime-behavior suite.)
  // ═══════════════════════════════════════════════════════════════════
  await check('[TEST 16] unreserved (NULL) pending row cannot verify and steal a name reserved by another pending row', async () => {
    const contestedName = uniqueName('StolenName')
    const { body: winnerBody } = await registerPending(uniqueEmail('t16winner'), contestedName)
    const winnerPendingId = winnerBody.pendingRegistrationId
    assert(!!winnerPendingId, 'setup failed to create winner pending row')

    // Simulate a "loser" pending row directly: same normalized name is
    // impossible to create via register() (blocked by TEST 3's exact
    // mechanism) — so this row represents what a migration-produced loser
    // looks like: a real pending row whose normalized_display_name is NULL,
    // but whose raw display_name still equals the contested name (exactly
    // the migration's "loser -> NULL, never deleted" outcome).
    const loserPendingId = directDb((db) => {
      const id = randomVisitorUuid()
      db.prepare(`
        INSERT INTO pending_registrations (
          pending_registration_id, normalized_email, password_hash, display_name,
          gender, visitor_id, ip_address, user_agent, code_hash, expires_at, last_code_sent_at,
          normalized_display_name
        ) VALUES (?, ?, 'x', ?, NULL, NULL, NULL, NULL, ?, ?, ?, NULL);
      `).run(
        id,
        uniqueEmail('t16loser'),
        contestedName,
        hashVerificationCodeLocal('123456'),
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        new Date().toISOString(),
      )
      return id
    })

    const { status, body } = await verifyPending(loserPendingId, '123456')
    assert(status !== 200 || body.ok !== true, `loser (unreserved) row should NOT be able to verify successfully with the contested name, got ${JSON.stringify(body)}`)
    assert(body.code === 'DISPLAY_NAME_TAKEN' || body.reason === 'display_name_taken', `expected a display-name-taken style rejection, got ${JSON.stringify(body)}`)

    // Winner should still be able to verify successfully afterward.
    const winnerResult = await verifyPending(winnerPendingId)
    assert(winnerResult.status === 200 && winnerResult.body.ok === true, `winner should still be able to verify, got ${JSON.stringify(winnerResult.body)}`)
  })

  // ═══════════════════════════════════════════════════════════════════
  // TEST 17 — Email delivery failure keeps BOTH reservations intact and
  // resend remains possible.
  // ═══════════════════════════════════════════════════════════════════
  await check('[TEST 17] email delivery failure (EMAIL_DELIVERY_FAILED) keeps BOTH email and display-name reservations intact', async () => {
    const name = uniqueName('EmailFailName')
    const email = uniqueEmail('t17')
    const { status, body } = await registerPending(email, name)
    // In this sandbox there is no BREVO_API_KEY configured, so EVERY
    // registration already goes through the EMAIL_DELIVERY_FAILED path —
    // this IS the real failure scenario, not a simulation.
    assert(status === 503 && body.code === 'EMAIL_DELIVERY_FAILED', `expected EMAIL_DELIVERY_FAILED, got ${JSON.stringify(body)}`)
    const row = getPendingRow(body.pendingRegistrationId)
    assert(row !== undefined, 'pending row should NOT be discarded on email delivery failure')
    assert(row.normalized_display_name === name.toLocaleLowerCase('bg-BG'), 'display-name reservation should remain intact after email delivery failure')
    assert(row.normalized_email === email.toLocaleLowerCase(), 'email reservation should remain intact after email delivery failure')

    // Resend must still work (at the DB level — see TEST 9's comment for why
    // this sandbox's own email step also 503s) from this exact state.
    forceResendCooldownElapsed(body.pendingRegistrationId)
    const rowBeforeResend = getPendingRow(body.pendingRegistrationId)
    const resendResult = await resendCode(body.pendingRegistrationId)
    assert(
      (resendResult.status === 200 && resendResult.body.ok === true) ||
        (resendResult.status === 503 && resendResult.body.code === 'EMAIL_DELIVERY_FAILED'),
      `resend should succeed at the DB level from the EMAIL_DELIVERY_FAILED state, got ${JSON.stringify(resendResult.body)}`,
    )
    const rowAfterResend = getPendingRow(body.pendingRegistrationId)
    assert(rowAfterResend.resend_count === rowBeforeResend.resend_count + 1, 'resend did not actually regenerate the code at the DB level')
    assert(rowAfterResend.normalized_display_name === row.normalized_display_name, 'reservation lost across resend')
  })

  // ═══════════════════════════════════════════════════════════════════
  // TEST 18 — Expiry releases BOTH email and display name (whole-row DELETE).
  // ═══════════════════════════════════════════════════════════════════
  await check('[TEST 18a] expiry releases BOTH email and display name — same email, new name', async () => {
    const oldName = uniqueName('OldNameA')
    const email = uniqueEmail('t18a')
    const { body } = await registerPending(email, oldName)
    forceExpirePending(body.pendingRegistrationId)

    const newName = uniqueName('NewNameA')
    const { status, body: newBody } = await registerPending(email, newName)
    assert(status === 503 && newBody.code === 'EMAIL_DELIVERY_FAILED', `expected the same-email retry (new name) to succeed after expiry, got ${JSON.stringify(newBody)}`)
    const oldRow = getPendingRow(body.pendingRegistrationId)
    assert(oldRow === undefined, 'old expired row should be gone (email-scoped cleanup)')
    const oldNameAvailable = await checkName(oldName)
    assert(oldNameAvailable === true, 'old display name should be free again after expiry')
  })

  await check('[TEST 18b] expiry releases BOTH email and display name — new email, same old name', async () => {
    const sharedName = uniqueName('SharedNameB')
    const oldEmail = uniqueEmail('t18b-old')
    const { body } = await registerPending(oldEmail, sharedName)
    forceExpirePending(body.pendingRegistrationId)

    const newEmail = uniqueEmail('t18b-new')
    const { status, body: newBody } = await registerPending(newEmail, sharedName)
    assert(status === 503 && newBody.code === 'EMAIL_DELIVERY_FAILED', `expected the new-email registration (old name) to succeed after expiry, got ${JSON.stringify(newBody)}`)
    const oldRow = getPendingRow(body.pendingRegistrationId)
    assert(oldRow === undefined, 'old expired row should be gone (display-name-scoped cleanup)')
    const oldEmailNowFree = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: oldEmail, password: 'SuiteTest1!', displayName: uniqueName('YetAnother'), gender: 'male', visitorId: randomVisitorUuid() }),
    }).then((r) => r.json())
    assert(oldEmailNowFree.code === 'EMAIL_DELIVERY_FAILED', `expected old email to be free again, got ${JSON.stringify(oldEmailNowFree)}`)
  })

  console.log('\n' + '═'.repeat(72))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  if (server && server.child.exitCode === null) {
    server.child.kill('SIGKILL')
    await Promise.race([new Promise((r) => server!.child.once('exit', r)), sleep(3_000)])
  }
  await isolated.cleanup()
}
