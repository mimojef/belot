// checkRegistrationDisplayNameReservationRace.ts
//
// INVESTIGATION (not a fix): real spawned isolated server, real HTTP API,
// no mocks. Proves — or disproves — whether the CURRENT registration
// architecture reserves a display name for a pending (unverified)
// registration, per the business rule under investigation:
//
//   "When check-name shows a name as available and the user submits
//    registration, that name must be reserved for that pending
//    registration until it completes OR the 24h pending-registration
//    window expires."
//
// STATIC EVIDENCE (see the investigation report):
//  - GET /api/profile/check-name -> playerProgressStore.isDisplayNameAvailable()
//    -> isReservedIdentityNameAvailable() queries ONLY the `profiles` table
//    (server/src/db/playerProgressStore.ts) — never `pending_registrations`.
//  - authStore.ts's register() has an "earlyNameConflict" check explicitly
//    commented as "Best-effort (НЕ authoritative)" and ALSO only queries
//    `profiles` (nameConflictStatement) — never other pending registrations.
//  - pending_registrations (server/database/migrations/20260914_001_create_
//    pending_registrations.sql) has display_name TEXT NOT NULL with NO
//    normalized column and NO unique index on it — only
//    UNIQUE(normalized_email).
//
// This test proves the concrete, end-to-end consequence: two DIFFERENT
// pending registrations can hold the exact same display name simultaneously,
// and whichever one verifies its email FIRST wins the name — the other gets
// DISPLAY_NAME_TAKEN only at verification time, not at submit time.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-name-race-'))
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
const EMAIL_VERIFICATION_SECRET = 'name-reservation-race-harness-throwaway-secret-32chars'
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

// Same HMAC-SHA256 scheme as server/src/db/authHelpers.ts — see prior
// checkLudoEmojiDiceInteraction.ts session for the identical technique.
// Pure local hashing against THIS harness's own throwaway secret/DB, no
// network, no production credentials.
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

async function registerPending(port: number, email: string, displayName: string): Promise<{ ok: true; pendingRegistrationId: string } | { ok: false; status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'RaceTest1!', displayName, gender: 'male', visitorId: randomVisitorUuid() }),
  })
  const body: any = await res.json()
  // EMAIL_DELIVERY_FAILED (503) is EXPECTED in this sandbox (no BREVO_API_KEY)
  // — the pending row is still created; only the email send itself fails.
  if (res.status === 503 && body.code === 'EMAIL_DELIVERY_FAILED' && body.pendingRegistrationId) {
    return { ok: true, pendingRegistrationId: body.pendingRegistrationId }
  }
  return { ok: false, status: res.status, body }
}

async function checkName(port: number, name: string): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${port}/api/profile/check-name?name=${encodeURIComponent(name)}`)
  const body: any = await res.json()
  return body.available === true
}

async function verifyPending(port: number, serverDir: string, pendingRegistrationId: string): Promise<{ status: number; body: any }> {
  const dbPath = join(serverDir, 'database', 'data', 'belot-v2.sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  let codeHash: string
  try {
    const row = db.prepare('SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?').get(pendingRegistrationId) as { code_hash: string } | undefined
    if (!row) throw new Error(`pending_registrations row not found for ${pendingRegistrationId} (already consumed/expired?)`)
    codeHash = row.code_hash
  } finally {
    db.close()
  }
  const code = recoverVerificationCode(codeHash)
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/verify-registration-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingRegistrationId, code }),
  })
  const body: any = await res.json()
  return { status: res.status, body }
}

console.log('\ncheckRegistrationDisplayNameReservationRace\n')

const isolated = await createIsolatedServerRoot()
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let server: RunningServer | null = null
try {
  const backendPort = await freePort()
  server = startServer(isolated.serverDir, backendPort)
  console.log(`Waiting for server on port ${backendPort}...`)
  if (!(await waitForHealth(backendPort))) { console.error(server.output()); throw new Error('server did not become ready') }
  console.log('Server ready.\n')

  const testDisplayName = `RaceName${runId.replace(/[^a-zA-Z0-9]/g, '').slice(-6)}`
  const emailA = `race-a-${runId}@example.test`
  const emailB = `race-b-${runId}@example.test`

  let pendingA: string | null = null
  let pendingB: string | null = null

  // ═══════════════════════════════════════════════════════════════════
  // Scenario (task spec Part 4):
  //   A) Registration A picks a unique name, sees "available", submits.
  //      Pending verification for A is created. A does NOT enter the code
  //      yet.
  //   B) Registration B tries the SAME display name.
  // ═══════════════════════════════════════════════════════════════════
  console.log('=== A: Registration A reserves (?) the name via check-name + submit ===')
  await check('[A1] check-name shows the fresh test name as available before anyone uses it', async () => {
    const available = await checkName(backendPort, testDisplayName)
    assert(available === true, `expected '${testDisplayName}' to be available before any registration, got unavailable`)
  })

  await check('[A2] Registration A submits with that name -> pending registration created (email verification not yet completed)', async () => {
    const result = await registerPending(backendPort, emailA, testDisplayName)
    assert(result.ok === true, `Registration A's register() call failed unexpectedly: ${JSON.stringify(result)}`)
    if (result.ok) pendingA = result.pendingRegistrationId
  })

  // ═══════════════════════════════════════════════════════════════════
  // THE CORE QUESTION: does B now see it as available?
  // ═══════════════════════════════════════════════════════════════════
  let bSawAvailable: boolean | null = null
  await check('[B1] check-name for Registration B, while A\'s pending registration (unverified) is still active and not expired', async () => {
    bSawAvailable = await checkName(backendPort, testDisplayName)
    // We do NOT assert a specific outcome here — we RECORD what actually
    // happens, per the task's "не гадай, покажи точния код и DB state"
    // instruction. The finding is reported below regardless of outcome.
  })
  console.log(`    [finding] check-name for B while A's pending registration is active: available=${bSawAvailable}`)

  let bRegisterResult: Awaited<ReturnType<typeof registerPending>> | null = null
  await check('[B2] Registration B attempts to submit register() with the SAME name while A\'s pending registration is still active', async () => {
    bRegisterResult = await registerPending(backendPort, emailB, testDisplayName)
  })
  console.log(`    [finding] Registration B's register() submit result: ${JSON.stringify(bRegisterResult)}`)

  const bWasAllowedToReserveSameName = bRegisterResult !== null && bRegisterResult.ok === true
  if (bWasAllowedToReserveSameName && bRegisterResult && bRegisterResult.ok) {
    pendingB = bRegisterResult.pendingRegistrationId
  }

  await check('[FINDING] classify: did the system allow B to also hold a pending registration for the SAME name as A?', async () => {
    if (bWasAllowedToReserveSameName) {
      throw new Error(
        `CONFIRMED DEFECT vs business rule: Registration B successfully created its OWN pending registration ` +
        `(pendingRegistrationId=${pendingB}) for the exact same display name '${testDisplayName}' while ` +
        `Registration A's pending registration (${pendingA}) was still active/unverified. ` +
        `check-name for B reported available=${bSawAvailable}. No reservation exists — the name was never locked to A.`,
      )
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // If B was allowed to proceed: let B finalize FIRST, then check whether
  // A (the ORIGINAL holder who saw "available" first) now gets
  // DISPLAY_NAME_TAKEN for a name it was first to claim.
  // ═══════════════════════════════════════════════════════════════════
  if (bWasAllowedToReserveSameName && pendingB) {
    console.log('\n=== B finalizes first, then A attempts to verify its ORIGINAL reservation ===')
    let bVerifyResult: { status: number; body: any } | null = null
    await check('[B3] Registration B completes email verification FIRST (finalizes the account)', async () => {
      bVerifyResult = await verifyPending(backendPort, isolated.serverDir, pendingB!)
      assert(bVerifyResult.status === 200 && bVerifyResult.body.ok === true, `B's verification unexpectedly failed: ${JSON.stringify(bVerifyResult)}`)
    })

    await check('[A3] Registration A (who saw "available" and submitted FIRST) now verifies its own still-valid, non-expired pending registration', async () => {
      const aVerifyResult = await verifyPending(backendPort, isolated.serverDir, pendingA!)
      console.log(`    [finding] A's verify-registration-email result: status=${aVerifyResult.status} body=${JSON.stringify(aVerifyResult.body)}`)
      if (aVerifyResult.body?.code === 'DISPLAY_NAME_TAKEN') {
        throw new Error(
          `CONFIRMED DEFECT vs business rule: Registration A, who saw the name as available FIRST and submitted ` +
          `registration FIRST, received DISPLAY_NAME_TAKEN at verification time because Registration B (who ` +
          `started LATER, while A's pending registration was still valid) was allowed to claim and verify the ` +
          `same name first. A's own valid, non-expired reservation (if one existed) was not honored — because ` +
          `no reservation exists.`,
        )
      }
      assert(aVerifyResult.status === 200 && aVerifyResult.body.ok === true, `A's verification failed for a reason OTHER than DISPLAY_NAME_TAKEN: ${JSON.stringify(aVerifyResult.body)}`)
    })
  } else {
    console.log('\n(B was NOT allowed to reserve the same name — business rule appears enforced at submit time; skipping the "B finalizes first" follow-up.)')
  }

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
