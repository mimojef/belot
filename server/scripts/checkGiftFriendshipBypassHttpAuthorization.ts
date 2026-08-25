/**
 * checkGiftFriendshipBypassHttpAuthorization.ts
 *
 * E2E тест на новия pika_team friendship-gate bypass endpoint:
 * POST /api/friends/gift-coins/direct.
 * Спъва изолирано копие на реалния сървър (собствена temp SQLite база,
 * реални migrations, реален HTTP слой) — огледално на
 * checkAdminVipGrantHttpAuthorization.ts — за да изпълни РЕАЛНО permission
 * gate-а (isPikaTeamGiftFriendshipBypassSession) и store path-а
 * (yellowCoinGiftStore.sendGiftToProfile), не само source-string assertions.
 *
 * Покрива (production hotfix брифа §2):
 *  [A] pika_team + non-friend → direct gift succeeds (200, balances/ledger коректни)
 *  [B] normal player + non-friend → 403 на СЪЩИЯ endpoint
 *  [C] pika_team → себе си → rejected (400), без промяна на баланса
 *  [D] pika_team + insufficient balance → rejected, balances/ledger непроменени
 *  [E] successful direct gift → sender -amount, recipient +amount,
 *      точно 1 нов ledger ред, friendship_id = NULL
 *  [extra] guest (без cookie) → 401 (не 403 — сесията изобщо липсва)
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'GiftBypassSmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed++
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${msg}`)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

function getFreePort(): Promise<number> {
  return new Promise((res, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Не може да се намери свободен порт.')))
        return
      }
      const { port } = addr
      srv.close(() => res(port))
    })
  })
}

type HttpResult = { status: number; body: unknown }

function httpRequest(
  port: number,
  pathname: string,
  method: string,
  cookie?: string,
  jsonBody?: unknown,
): Promise<HttpResult> {
  return new Promise((res, reject) => {
    const headers: Record<string, string> = {}
    if (cookie) headers['Cookie'] = cookie
    let payload: string | undefined
    if (jsonBody !== undefined) {
      payload = JSON.stringify(jsonBody)
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(payload))
    }

    const req = request(
      { hostname: '127.0.0.1', port, path: pathname, method, headers, timeout: 5000 },
      (r) => {
        const chunks: Buffer[] = []
        r.on('data', (c) => chunks.push(Buffer.from(c)))
        r.on('end', () => {
          let body: unknown = null
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON */ }
          res({ status: r.statusCode ?? 0, body })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('HTTP timeout.')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

async function createIsolatedServerRoot(originalServerRoot: string): Promise<{
  root: string
  serverDir: string
  databaseFile: string
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-gift-bypass-smoke-'))
  const serverDir = join(root, 'server')

  await mkdir(serverDir, { recursive: true })
  await cp(join(originalServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(originalServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })

  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(originalServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(originalServerRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)

  const databaseFile = join(serverDir, 'database', 'data', 'belot-v2.sqlite')

  return {
    root,
    serverDir,
    databaseFile,
    cleanup: async () => { await rm(root, { recursive: true, force: true }) },
  }
}

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        PORT: String(port),
        BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
        BELOT_GAME_WORKER_COUNT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((res) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); res() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); res() })
  })
}

function promoteRole(databaseFile: string, email: string, role: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?`).run(role, email)
  db.close()
}

function setWalletBalance(databaseFile: string, profileId: string, balance: number): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance;
  `).run(profileId, balance)
  db.close()
}

function getWalletBalance(databaseFile: string, profileId: string): number {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?`).get(profileId) as
    | { yellow_coins_balance: number }
    | undefined
  db.close()
  return row?.yellow_coins_balance ?? 0
}

function countGiftLedgerRows(databaseFile: string, senderProfileId: string, recipientProfileId: string): number {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM yellow_coin_gift_ledger
    WHERE sender_profile_id = ? AND recipient_profile_id = ?
  `).get(senderProfileId, recipientProfileId) as { c: number }
  db.close()
  return row.c
}

function getLatestGiftLedgerRow(databaseFile: string, senderProfileId: string, recipientProfileId: string): {
  friendship_id: string | null
  amount: number
  sender_balance_after: number
  recipient_balance_after: number
} | undefined {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`
    SELECT friendship_id, amount, sender_balance_after, recipient_balance_after
    FROM yellow_coin_gift_ledger
    WHERE sender_profile_id = ? AND recipient_profile_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(senderProfileId, recipientProfileId) as {
    friendship_id: string | null
    amount: number
    sender_balance_after: number
    recipient_balance_after: number
  } | undefined
  db.close()
  return row
}

type RegisteredUser = { cookie: string; profileId: string; accountId: string; email: string }

async function register(port: number, runId: string, suffix: string): Promise<RegisteredUser> {
  const email = `gift-bypass-smoke-${runId}-${suffix}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName: `Smoke ${suffix}`, gender: 'male' }),
  })
  if (res.status !== 200) throw new Error(`Регистрацията (${suffix}) върна status ${res.status}.`)
  const payload = await res.json() as { ok?: boolean; session?: { profile: { profileId: string }; account: { accountId: string } }; message?: string }
  if (!payload.ok || !payload.session) throw new Error(`Регистрацията (${suffix}) не е успешна: ${payload.message ?? '?'}`)

  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  if (!rawCookie) throw new Error(`Липсва Set-Cookie при регистрация (${suffix}).`)
  return {
    cookie: rawCookie.split(';')[0]!,
    profileId: payload.session.profile.profileId,
    accountId: payload.session.account.accountId,
    email,
  }
}

async function login(port: number, email: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const payload = await res.json() as { ok?: boolean }
  if (!payload.ok) throw new Error(`Login не е успешен за ${email}.`)
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  if (!rawCookie) throw new Error(`Липсва Set-Cookie при login за ${email}.`)
  return rawCookie.split(';')[0]!
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\n═══ pika_team gift friendship-bypass HTTP authorization E2E test ═══')
console.log(`Server root: ${sourceServerRoot}`)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null

try {
  server = startServer(isolated.serverDir, port)

  console.log(`\n[startup] Чакам сървъра на порт ${port}...`)
  await waitFor('server health ready', async () => {
    try {
      const r = await httpRequest(port, '/health', 'GET')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
  console.log('  Сървърът е готов.')

  const runId = `${Date.now()}-${process.pid}`

  console.log('\n[setup] Регистрация на pika_team + normal player + non-friend recipients...')
  const pikaCandidate = await register(port, runId, 'pikateam')
  const playerCandidate = await register(port, runId, 'player')
  const recipientA = await register(port, runId, 'recipienta')
  const recipientB = await register(port, runId, 'recipientb')
  const recipientD = await register(port, runId, 'recipientd')
  const recipientE = await register(port, runId, 'recipiente')

  promoteRole(isolated.databaseFile, pikaCandidate.email, 'pika_team')

  const pikaCookie = await login(port, pikaCandidate.email)
  const playerCookie = await login(port, playerCandidate.email)

  console.log('  Регистрирани: pika_team sender, normal player sender, 4 non-friend получатели.')
  console.log('  Никой от recipientA/B/D/E НЕ е приятел с изпращачите (accepted friendship никъде не е създадена).')

  // ── [A] pika_team + non-friend → succeeds ────────────────────────────────
  console.log('\n[A] pika_team + non-friend получател → direct gift succeeds')
  setWalletBalance(isolated.databaseFile, pikaCandidate.profileId, 50_000)
  await check('[A] pika_team -> POST gift-coins/direct (non-friend) => 200 ok:true', async () => {
    const r = await httpRequest(port, '/api/friends/gift-coins/direct', 'POST', pikaCookie, {
      recipientProfileId: recipientA.profileId,
      amount: 5_000,
    })
    const b = r.body as { ok?: boolean; senderProfile?: unknown; recipientProfile?: unknown }
    if (r.status !== 200 || b.ok !== true || !b.senderProfile || !b.recipientProfile) {
      throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    }
  })

  // ── [B] normal player + non-friend → 403 на СЪЩИЯ endpoint ──────────────
  console.log('\n[B] normal player + non-friend получател → 403 на /api/friends/gift-coins/direct')
  setWalletBalance(isolated.databaseFile, playerCandidate.profileId, 50_000)
  const recipientBBalanceBefore = getWalletBalance(isolated.databaseFile, recipientB.profileId)
  await check('[B] player -> POST gift-coins/direct => 403 (не 200, не 400 validation)', async () => {
    const r = await httpRequest(port, '/api/friends/gift-coins/direct', 'POST', playerCookie, {
      recipientProfileId: recipientB.profileId,
      amount: 5_000,
    })
    if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[B.1] player отказаният опит не е променил recipientB баланса', () => {
    const bal = getWalletBalance(isolated.databaseFile, recipientB.profileId)
    if (bal !== recipientBBalanceBefore) throw new Error(`recipientB balance=${bal}, очаквах непроменен ${recipientBBalanceBefore}`)
  })

  // ── [extra] guest (без cookie) → 401, не 403 ─────────────────────────────
  await check('[extra] guest (без cookie) -> POST gift-coins/direct => 401', async () => {
    const r = await httpRequest(port, '/api/friends/gift-coins/direct', 'POST', undefined, {
      recipientProfileId: recipientB.profileId,
      amount: 5_000,
    })
    if (r.status !== 401) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ── [C] pika_team → себе си → rejected ───────────────────────────────────
  console.log('\n[C] pika_team подарък към себе си → rejected, без промяна на баланса')
  const pikaBalanceBeforeSelf = getWalletBalance(isolated.databaseFile, pikaCandidate.profileId)
  await check('[C] pika_team -> POST gift-coins/direct (recipientProfileId = себе си) => ok:false', async () => {
    const r = await httpRequest(port, '/api/friends/gift-coins/direct', 'POST', pikaCookie, {
      recipientProfileId: pikaCandidate.profileId,
      amount: 5_000,
    })
    const b = r.body as { ok?: boolean; message?: string }
    if (b.ok !== false) throw new Error(`status=${r.status}, body=${JSON.stringify(b)} — очаквах ok:false`)
  })
  await check('[C.1] self-gift опитът не е променил pika_team баланса', () => {
    const bal = getWalletBalance(isolated.databaseFile, pikaCandidate.profileId)
    if (bal !== pikaBalanceBeforeSelf) throw new Error(`balance=${bal}, очаквах непроменен ${pikaBalanceBeforeSelf}`)
  })

  // ── [D] pika_team + insufficient balance → rejected ──────────────────────
  console.log('\n[D] pika_team с недостатъчен баланс → rejected, balances/ledger непроменени')
  setWalletBalance(isolated.databaseFile, pikaCandidate.profileId, 500)
  const recipientDBalanceBefore = getWalletBalance(isolated.databaseFile, recipientD.profileId)
  const ledgerCountBefore = countGiftLedgerRows(isolated.databaseFile, pikaCandidate.profileId, recipientD.profileId)
  await check('[D] pika_team (500 баланс) -> подарък 1 000 => ok:false ("Нямаш достатъчно жълтици...")', async () => {
    const r = await httpRequest(port, '/api/friends/gift-coins/direct', 'POST', pikaCookie, {
      recipientProfileId: recipientD.profileId,
      amount: 1_000,
    })
    const b = r.body as { ok?: boolean; message?: string }
    if (b.ok !== false || !b.message?.includes('Нямаш достатъчно')) {
      throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    }
  })
  await check('[D.1] sender balance непроменен (все още 500)', () => {
    const bal = getWalletBalance(isolated.databaseFile, pikaCandidate.profileId)
    if (bal !== 500) throw new Error(`sender balance=${bal}, очаквах непроменен 500`)
  })
  await check('[D.2] recipient balance непроменен', () => {
    const bal = getWalletBalance(isolated.databaseFile, recipientD.profileId)
    if (bal !== recipientDBalanceBefore) throw new Error(`recipient balance=${bal}, очаквах непроменен ${recipientDBalanceBefore}`)
  })
  await check('[D.3] без нов ledger ред', () => {
    const count = countGiftLedgerRows(isolated.databaseFile, pikaCandidate.profileId, recipientD.profileId)
    if (count !== ledgerCountBefore) throw new Error(`ledger rows=${count}, очаквах непроменено ${ledgerCountBefore}`)
  })

  // ── [E] successful direct gift → точни balances + exactly one ledger row + friendship_id=NULL
  console.log('\n[E] Успешен direct gift → sender -amount, recipient +amount, 1 ledger ред, friendship_id=NULL')
  setWalletBalance(isolated.databaseFile, pikaCandidate.profileId, 50_000)
  setWalletBalance(isolated.databaseFile, recipientE.profileId, 2_000)
  const senderBalanceBeforeE = getWalletBalance(isolated.databaseFile, pikaCandidate.profileId)
  const recipientBalanceBeforeE = getWalletBalance(isolated.databaseFile, recipientE.profileId)
  const ledgerCountBeforeE = countGiftLedgerRows(isolated.databaseFile, pikaCandidate.profileId, recipientE.profileId)

  await check('[E] pika_team -> подарък 3 000 на recipientE => 200 ok:true', async () => {
    const r = await httpRequest(port, '/api/friends/gift-coins/direct', 'POST', pikaCookie, {
      recipientProfileId: recipientE.profileId,
      amount: 3_000,
    })
    const b = r.body as { ok?: boolean }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })
  await check('[E.1] sender balance = преди - 3000', () => {
    const bal = getWalletBalance(isolated.databaseFile, pikaCandidate.profileId)
    if (bal !== senderBalanceBeforeE - 3_000) throw new Error(`sender balance=${bal}, очаквах ${senderBalanceBeforeE - 3_000}`)
  })
  await check('[E.2] recipient balance = преди + 3000', () => {
    const bal = getWalletBalance(isolated.databaseFile, recipientE.profileId)
    if (bal !== recipientBalanceBeforeE + 3_000) throw new Error(`recipient balance=${bal}, очаквах ${recipientBalanceBeforeE + 3_000}`)
  })
  await check('[E.3] точно 1 нов ledger ред за тази двойка sender/recipient', () => {
    const count = countGiftLedgerRows(isolated.databaseFile, pikaCandidate.profileId, recipientE.profileId)
    if (count !== ledgerCountBeforeE + 1) throw new Error(`ledger rows=${count}, очаквах ${ledgerCountBeforeE + 1}`)
  })
  await check('[E.4] последният ledger ред: friendship_id=NULL, amount=3000, balances after съвпадат', () => {
    const row = getLatestGiftLedgerRow(isolated.databaseFile, pikaCandidate.profileId, recipientE.profileId)
    if (!row) throw new Error('Липсва ledger ред')
    if (row.friendship_id !== null) throw new Error(`friendship_id=${row.friendship_id}, очаквах NULL (direct/bypass gift)`)
    if (row.amount !== 3_000) throw new Error(`amount=${row.amount}, очаквах 3000`)
    if (row.sender_balance_after !== senderBalanceBeforeE - 3_000) throw new Error(`sender_balance_after=${row.sender_balance_after}`)
    if (row.recipient_balance_after !== recipientBalanceBeforeE + 3_000) throw new Error(`recipient_balance_after=${row.recipient_balance_after}`)
  })

} catch (err) {
  fail('Непредвидена грешка в E2E теста', err)
  if (server !== null) {
    console.error('\n[server output tail]:\n' + server.output().slice(-3000))
  }
  console.error(err)
} finally {
  console.log('\n[cleanup] Спиране на сървъра и изтриване на временните файлове...')
  if (server !== null) {
    try {
      await stopServer(server)
      console.log('  Сървърът е спрян.')
    } catch (err) {
      fail('Спиране на сървъра', err)
      console.error(server.output().slice(-3000))
    }
  }
  let cleanupOk = false
  for (let attempt = 0; attempt < 5 && !cleanupOk; attempt++) {
    try {
      if (attempt > 0) await sleep(500)
      await isolated.cleanup()
      cleanupOk = true
    } catch {
      // ще опитаме пак
    }
  }
  if (cleanupOk) {
    console.log('  Временните файлове са изтрити.')
  } else {
    console.warn('  [warn] Временните файлове не бяха изтрити (Windows file lock) — не е тестов провал.')
  }
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
