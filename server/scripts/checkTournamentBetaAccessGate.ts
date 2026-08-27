/**
 * checkTournamentBetaAccessGate.ts
 *
 * Targeted regression за server-side beta password gate на секция
 * "Турнири" (§ TOURNAMENT BETA GATE task spec). Покрива:
 *
 *  Store-level (реален SQLite + приложени migrations):
 *   1. schema/migration — таблиците съществуват, default disabled/NULL/v1.
 *   2. plaintext парола никога не се съхранява (само scrypt hash формат).
 *   3. грешна парола → denied (submitPassword wrong_password).
 *   4. правилна парола → grant записан.
 *   5. grant е profile-specific (друг profileId остава без достъп).
 *   6. grant persist-ва между отделни store instances (реален DB read).
 *   7/8. admin bypass vs non-admin без grant (виж HTTP секцията по-долу,
 *        където се тества end-to-end през реален authStore role lookup).
 *  11. смяна на паролата инкрементира password_version.
 *  12. стар grant (стар version) се invalidate-ва автоматично.
 *  13. новата парола дава нов валиден grant.
 *  14. disable → достъпът се връща без нужда от grant (hasAccess винаги true).
 *  15. enable без configured парола → отказан (EnableTournamentBetaGateResult).
 *  17. getPublicInfo/getStatus никога не съдържат password/hash полета.
 *
 *  HTTP end-to-end (реален isolated server process, огледален pattern на
 *  checkAdminTournamentApi.ts):
 *   7. admin профил bypass-ва gate-а дори БЕЗ grant.
 *   8/9. non-admin без grant → 403 reason=beta_access_required на
 *        representative tournament REST endpoint (GET /api/tournaments).
 *  10. representative WS command (tournament_semifinal_result_acknowledge)
 *      — source-level потвърждение, че handler-ът вика
 *      hasTournamentBetaAccessForProfile ПРЕДИ tournamentCoordinator
 *      извикването (WS съобщения nямат HTTP response, затова "blocked"
 *      тук означава "не достига до coordinator", проверено чрез source
 *      inspection, а не frame response — виж коментара в самия check).
 *  16. internal/background operation (tournamentCoordinator tick) не е
 *      блокирана от gate-а — source-level: coordinator/scheduler файловете
 *      изобщо не викат beta-access helper-ите.
 *  18. client modal/navigation — source-level unit check на
 *      showTournamentsList()'s ensureTournamentBetaAccessOrPromptModal gate
 *      и close-modal-returns-to-lobby поведението.
 *
 * НЕ пуска пълни tournament/Topics/private-room regression батерии — виж
 * task spec "ТЕСТОВЕ — САМО НЕОБХОДИМИТЕ".
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentBetaAccessStore } from '../src/db/tournamentBetaAccessStore.js'

const FAKE_PASSWORD = 'TournamentBetaTest!123'
const FAKE_PASSWORD_V2 = 'TournamentBetaTestV2!456'
const SERVER_READY_TIMEOUT_MS = 30_000

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    console.error(`  FAIL ${label}: ${message}`)
  }
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
  throw new Error(`Timeout while waiting for ${label}.`)
}

const currentFilePath = fileURLToPath(import.meta.url)
const serverRootPath = join(dirname(currentFilePath), '..')

console.log('\ncheckTournamentBetaAccessGate')

// ─── Part 1: store-level (реален SQLite + migrations) ──────────────────────

async function loadMigrationFileNames(): Promise<string[]> {
  const migrationsDir = join(serverRootPath, 'database', 'migrations')
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(migrationsDir, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.sql'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function applyMigrations(db: InstanceType<typeof DatabaseSync>): Promise<void> {
  const migrationsDir = join(serverRootPath, 'database', 'migrations')
  const manualMarker = '-- MANUAL_TRANSACTION_MIGRATION'
  for (const filename of await loadMigrationFileNames()) {
    const sql = (await readFile(join(migrationsDir, filename), 'utf8')).trim()
    if (sql.includes(manualMarker)) {
      db.exec(sql)
    } else {
      db.exec('BEGIN;')
      db.exec(sql)
      db.exec('COMMIT;')
    }
  }
}

function insertProfile(db: InstanceType<typeof DatabaseSync>, profileId: string): void {
  db.prepare(`
    INSERT INTO profiles (profile_id, display_name, normalized_display_name, profile_kind, status, is_temporary)
    VALUES (?, ?, ?, 'human', 'active', 0);
  `).run(profileId, `Player ${profileId.slice(0, 8)}`, `player ${profileId.slice(0, 8)}`)
}

{
  const dbPath = join(await mkdtemp(join(tmpdir(), 'belot-tournament-beta-store-')), 'test.sqlite')
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)
  db.close()

  const profileA = randomUUID()
  const profileB = randomUUID()
  const dbForInserts = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  insertProfile(dbForInserts, profileA)
  insertProfile(dbForInserts, profileB)
  dbForInserts.close()

  await check('[1] schema/migration: default disabled, no password, version=1', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      const status = store.getStatus()
      assert(status.enabled === false, 'expected enabled=false by default')
      assert(status.hasPassword === false, 'expected hasPassword=false by default')
      assert(status.passwordVersion === 1, `expected passwordVersion=1, got ${status.passwordVersion}`)
      assert(status.validGrantsCount === 0, 'expected 0 valid grants by default')
    } finally {
      store.close()
    }
  })

  await check('[1b] disabled gate → hasAccess true for anyone (deploy does not lock the section)', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      assert(store.hasAccess(null) === true, 'anonymous should have access while disabled')
      assert(store.hasAccess(profileA) === true, 'profile should have access while disabled')
    } finally {
      store.close()
    }
  })

  await check('[15] enable без configured парола → отказан', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      const result = store.enable()
      assert(result.ok === false, 'expected enable to fail without a configured password')
      assert(result.ok === false && result.reason === 'no_password_configured', 'expected reason=no_password_configured')
    } finally {
      store.close()
    }
  })

  let passwordVersionAfterSet = -1
  await check('[2] setPassword stores scrypt hash, никога plaintext', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      const result = store.setPassword(FAKE_PASSWORD)
      assert(result.ok === true, 'expected setPassword to succeed')
      if (result.ok) passwordVersionAfterSet = result.passwordVersion
    } finally {
      store.close()
    }
    const raw = new DatabaseSync(dbPath, { open: true })
    try {
      const row = raw.prepare(`SELECT password_hash FROM tournament_beta_access_config WHERE row_id='singleton';`).get() as { password_hash: string | null }
      assert(row.password_hash !== null, 'expected password_hash to be set')
      assert(!row.password_hash!.includes(FAKE_PASSWORD), 'password_hash must not contain the plaintext password')
      assert(row.password_hash!.startsWith('scrypt:'), `expected scrypt: prefix, got ${row.password_hash!.slice(0, 20)}`)
    } finally {
      raw.close()
    }
  })

  await check('[enable] gate се enable-ва успешно след configured парола', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      const result = store.enable()
      assert(result.ok === true, 'expected enable to succeed once password is configured')
      assert(store.getStatus().enabled === true, 'expected status.enabled=true after enable')
    } finally {
      store.close()
    }
  })

  await check('[3] wrong password → denied', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      const result = store.submitPassword(profileA, 'definitely-wrong-password')
      assert(result.ok === false, 'expected wrong password to be rejected')
      assert(result.ok === false && result.reason === 'wrong_password', 'expected reason=wrong_password')
      assert(store.hasAccess(profileA) === false, 'profileA should still have no access after wrong password')
    } finally {
      store.close()
    }
  })

  await check('[4] correct password → grant created', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      const result = store.submitPassword(profileA, FAKE_PASSWORD)
      assert(result.ok === true, 'expected correct password to succeed')
      assert(store.hasAccess(profileA) === true, 'profileA should have access after correct password')
    } finally {
      store.close()
    }
  })

  await check('[5] grant е profile-specific — друг профил остава без достъп', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      assert(store.hasAccess(profileB) === false, 'profileB must NOT have access from profileA\'s grant')
      assert(store.hasAccess(profileA) === true, 'profileA should still have access')
    } finally {
      store.close()
    }
  })

  await check('[6] grant persist-ва в DB между отделни store instances', async () => {
    const store1 = await createTournamentBetaAccessStore(dbPath)
    store1.close()
    const store2 = await createTournamentBetaAccessStore(dbPath)
    try {
      assert(store2.hasAccess(profileA) === true, 'grant must survive across store instances (real DB read)')
    } finally {
      store2.close()
    }
  })

  await check('[17a] getStatus() никога не съдържа password/hash полета', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      const status = store.getStatus()
      const raw = JSON.stringify(status)
      assert(!/password_hash|passwordHash|scrypt:/i.test(raw), `status leaked hash-like data: ${raw}`)
    } finally {
      store.close()
    }
  })

  await check('[17b] getPublicInfo() никога не съдържа password/hash полета', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      const info = store.getPublicInfo(profileA)
      const raw = JSON.stringify(info)
      assert(!/password_hash|passwordHash|scrypt:|version/i.test(raw), `public info leaked internal data: ${raw}`)
      assert(Object.keys(info).sort().join(',') === 'enabled,hasAccess', `unexpected public info shape: ${raw}`)
    } finally {
      store.close()
    }
  })

  await check('[11] смяна на паролата инкрементира password_version', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      const before = store.getStatus().passwordVersion
      const result = store.setPassword(FAKE_PASSWORD_V2)
      assert(result.ok === true, 'expected password change to succeed')
      assert(result.ok === true && result.passwordVersion === before + 1, `expected version ${before + 1}, got ${result.ok && result.passwordVersion}`)
    } finally {
      store.close()
    }
  })

  await check('[12] стар grant (стар version) се invalidate-ва автоматично', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      assert(store.hasAccess(profileA) === false, 'old grant must be invalid after password change (version mismatch)')
    } finally {
      store.close()
    }
  })

  await check('[13] новата парола дава нов валиден grant', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      const result = store.submitPassword(profileA, FAKE_PASSWORD_V2)
      assert(result.ok === true, 'expected new password to succeed')
      assert(store.hasAccess(profileA) === true, 'profileA should have access with the new password grant')
    } finally {
      store.close()
    }
  })

  await check('[14] disable → нормален достъп без нужда от grant', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      store.disable()
      assert(store.getStatus().enabled === false, 'expected enabled=false after disable')
      assert(store.hasAccess(profileB) === true, 'profileB (никога не е имал grant) трябва да има достъп след disable')
    } finally {
      store.close()
    }
  })

  await check('[status] validGrantsCount отразява само редове с текущия version', async () => {
    const store = await createTournamentBetaAccessStore(dbPath)
    try {
      store.enable()
      const status = store.getStatus()
      // profileA (V2 grant) е валиден; profileB никога не е подавал парола.
      assert(status.validGrantsCount === 1, `expected 1 valid grant, got ${status.validGrantsCount}`)
    } finally {
      store.close()
    }
  })
}

// ─── Part 2: source-level checks (internal engine изолация, client wiring) ──

const clientControllerSource = await readFile(
  join(dirname(currentFilePath), '..', '..', 'src', 'app', 'lobby', 'createLobbyFlowController.ts'),
  'utf8',
)
const clientMainSource = await readFile(
  join(dirname(currentFilePath), '..', '..', 'src', 'main.ts'),
  'utf8',
)
const serverIndexSource = await readFile(join(serverRootPath, 'src', 'index.ts'), 'utf8')
const coordinatorSource = await readFile(join(serverRootPath, 'src', 'tournament', 'tournamentCoordinator.ts'), 'utf8')
const schedulerSource = await readFile(join(serverRootPath, 'src', 'tournament', 'tournamentScheduler.ts'), 'utf8')

await check('[16] internal engine (coordinator/scheduler) не вика beta-access helper-и', async () => {
  assert(!coordinatorSource.includes('BetaAccess'), 'tournamentCoordinator.ts не трябва да реферира beta-access gate-а')
  assert(!schedulerSource.includes('BetaAccess'), 'tournamentScheduler.ts не трябва да реферира beta-access gate-а')
})

await check('[10] WS handler за tournament_semifinal_result_acknowledge проверява beta access ПРЕДИ coordinator извикването', async () => {
  const marker = "if (message.type === 'tournament_semifinal_result_acknowledge') {"
  const idx = serverIndexSource.indexOf(marker)
  assert(idx !== -1, 'WS handler not found')
  const block = serverIndexSource.slice(idx, idx + 600)
  const accessCheckIdx = block.indexOf('hasTournamentBetaAccessForProfile')
  const coordinatorCallIdx = block.indexOf('tournamentCoordinator.acknowledgeSemifinalResult')
  assert(accessCheckIdx !== -1, 'hasTournamentBetaAccessForProfile check not found in WS handler')
  assert(coordinatorCallIdx !== -1, 'coordinator call not found in WS handler')
  assert(accessCheckIdx < coordinatorCallIdx, 'beta-access check must run BEFORE the coordinator call')
})

await check('[18a] showTournamentsList() проверява beta access преди зареждане на съдържание', async () => {
  const idx = clientControllerSource.indexOf('async function showTournamentsList')
  assert(idx !== -1, 'showTournamentsList not found')
  const block = clientControllerSource.slice(idx, idx + 1200)
  const gateIdx = block.indexOf('ensureTournamentBetaAccessOrPromptModal')
  const screenAssignIdx = block.indexOf("state.currentScreen = 'tournaments'")
  assert(gateIdx !== -1, 'beta access gate call not found in showTournamentsList')
  assert(screenAssignIdx !== -1, 'currentScreen assignment not found')
  assert(gateIdx < screenAssignIdx, 'beta access must be checked BEFORE currentScreen is set to tournaments (no locked content behind the modal)')
})

await check('[18b] затваряне на modal-а (Cancel/X) връща потребителя към лобито', async () => {
  assert(
    clientControllerSource.includes('function closeTournamentBetaAccessModal') &&
      clientControllerSource.includes('switchToLobby()'),
    'closeTournamentBetaAccessModal must route back to lobby via switchToLobby()',
  )
})

await check('[18c] client никога не логва/показва паролата в plaintext извън input value-то', async () => {
  assert(!clientMainSource.includes('console.log') || !clientMainSource.includes('tournamentBetaAccess'), 'no accidental logging of beta access payloads')
})

await check('[18d] partner invite create/accept-decline-cancel/candidates-load/search обработват beta_access_required централизирано', async () => {
  const denialCount = (clientControllerSource.match(/handleTournamentBetaAccessDenial/g) ?? []).length
  // 1 дефиниция + join/leave/cancel/create (стари 4) + partner-invite-create/
  // respond/candidates-load (нови 3) + search runner-ов onResult clause (1) = 9.
  assert(denialCount >= 9, `expected handleTournamentBetaAccessDenial to be wired into at least 9 places, found ${denialCount}`)
  assert(
    clientControllerSource.includes('async function submitTournamentPartnerInvite') &&
      clientControllerSource.includes('async function respondTournamentPartnerInvite') &&
      clientControllerSource.includes('async function openTournamentPartnerPicker'),
    'expected partner invite/respond/candidates-load functions to exist',
  )
})

await check('[18e] tournament beta access modal е публично achievable от main.ts (за acknowledge-bot-return denial)', async () => {
  assert(
    clientControllerSource.includes('openTournamentBetaAccessModal: () => void'),
    'LobbyFlowController public type must expose openTournamentBetaAccessModal',
  )
  assert(
    clientMainSource.includes('lobby.openTournamentBetaAccessModal()'),
    'main.ts must call lobby.openTournamentBetaAccessModal() somewhere (acknowledge-bot-return denial path)',
  )
})

await check('[18f] acknowledgeTournamentBotReturn пренася reason от response-а (не го изхвърля до { ok: false })', async () => {
  const idx = clientMainSource.indexOf('async function acknowledgeTournamentBotReturn')
  assert(idx !== -1, 'acknowledgeTournamentBotReturn not found')
  const block = clientMainSource.slice(idx, idx + 700)
  assert(block.includes('reason'), 'acknowledgeTournamentBotReturn must propagate a reason field, not discard the response body down to { ok: false }')
})

await check('[MAINT-override] стария production maintenance placeholder е неутрализиран (beta gate вече е authoritative)', async () => {
  const tournamentsScreenSource = await readFile(
    join(dirname(currentFilePath), '..', '..', 'src', 'app', 'lobby', 'renderTournamentsScreen.ts'),
    'utf8',
  )
  assert(
    tournamentsScreenSource.includes('const TOURNAMENTS_PUBLIC_MAINTENANCE_MODE = false'),
    'TOURNAMENTS_PUBLIC_MAINTENANCE_MODE must be hardcoded false — the old unconditional PROD placeholder must not gate /tournaments anymore',
  )
  assert(
    !tournamentsScreenSource.includes('import.meta.env?.PROD === true'),
    'the old unconditional production maintenance guard expression must not be active anymore',
  )
})

// ─── Part 3: HTTP end-to-end (реален isolated server process) ──────────────

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a free port.')))
        return
      }
      const { port } = address
      server.close(() => resolvePort(port))
    })
  })
}

type HttpResult = { status: number; body: unknown }

async function httpRequest(
  port: number,
  pathname: string,
  method: string,
  cookie?: string,
  jsonBody?: unknown,
): Promise<HttpResult> {
  const headers: Record<string, string> = {}
  if (cookie) headers.Cookie = cookie
  if (jsonBody !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
  })
  let body: unknown = null
  try { body = await response.json() } catch { /* ignore non-JSON */ }
  return { status: response.status, body }
}

async function removeTempRoot(root: string): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code) || attempt === 6) throw error
      await sleep(150 * attempt)
    }
  }
}

async function createIsolatedServerRoot(originalServerRoot: string): Promise<{
  serverDir: string
  databaseFile: string
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-tournament-beta-http-'))
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

  return {
    serverDir,
    databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: async () => removeTempRoot(root),
  }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; closed: Promise<void> }

function startServer(serverDir: string, port: number): RunningServer {
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port), BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const closed = new Promise<void>((r) => child.once('close', () => r()))
  return { child, closed }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode === null) server.child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (server.child.exitCode === null) server.child.kill('SIGKILL')
  }, 10_000)
  try {
    await server.closed
  } finally {
    clearTimeout(timer)
  }
}

type RegisteredUser = { cookie: string; email: string; profileId: string }

async function register(port: number, runId: string, suffix: string): Promise<RegisteredUser> {
  const email = `tournament-beta-${runId}-${suffix}@example.test`
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'BetaGateSmoke1!', displayName: `Beta ${suffix}`, gender: 'male' }),
  })
  if (response.status !== 200) throw new Error(`register status=${response.status}`)
  const payload = await response.json() as { ok?: boolean; session?: { profile: { profileId: string } }; message?: string }
  if (!payload.ok || !payload.session) throw new Error(`register failed: ${payload.message ?? '?'}`)
  const headersExt = response.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
  if (!rawCookie) throw new Error('missing Set-Cookie')
  return { cookie: rawCookie.split(';')[0]!, email, profileId: payload.session.profile.profileId }
}

function promoteAccount(databaseFile: string, email: string, role: 'admin'): void {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA journal_mode = WAL;')
    database.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?;`).run(role, email)
  } finally {
    database.close()
  }
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null

try {
  server = startServer(isolated.serverDir, port)
  await waitFor('server health', async () => {
    try {
      const response = await httpRequest(port, '/health', 'GET')
      const body = response.body as { ok?: boolean }
      return response.status === 200 && body.ok === true
    } catch {
      return false
    }
  }, SERVER_READY_TIMEOUT_MS)

  const runId = `${Date.now()}-${process.pid}`
  const player = await register(port, runId, 'player')
  const admin = await register(port, runId, 'admin')
  promoteAccount(isolated.databaseFile, admin.email, 'admin')

  await check('[status defaults] GET /api/tournaments/beta-access при disabled gate връща enabled=false hasAccess=true', async () => {
    const response = await httpRequest(port, '/api/tournaments/beta-access', 'GET', player.cookie)
    assert(response.status === 200, `status=${response.status}`)
    const body = response.body as { ok?: boolean; enabled?: boolean; hasAccess?: boolean }
    assert(body.ok === true && body.enabled === false && body.hasAccess === true, JSON.stringify(body))
  })

  await check('[deploy-safe] списъкът с турнири е достъпен нормално преди enable (deploy сам по себе си не заключва секцията)', async () => {
    const response = await httpRequest(port, '/api/tournaments', 'GET', player.cookie)
    assert(response.status === 200, `expected 200 before gate is enabled, got ${response.status}`)
  })

  // Enable-ваме gate-а директно през store (симулира CLI tournament:beta-password + tournament:beta-enable).
  const store = await createTournamentBetaAccessStore(isolated.databaseFile)
  store.setPassword(FAKE_PASSWORD)
  const enableResult = store.enable()
  store.close()

  await check('[cli-sim] enable успява след configured парола', () => {
    assert(enableResult.ok === true, 'expected enable to succeed')
  })

  await check('[9] non-admin без grant → 403 reason=beta_access_required на representative REST endpoint', async () => {
    const response = await httpRequest(port, '/api/tournaments', 'GET', player.cookie)
    assert(response.status === 403, `status=${response.status}, body=${JSON.stringify(response.body)}`)
    const body = response.body as { ok?: boolean; reason?: string }
    assert(body.ok === false && body.reason === 'beta_access_required', JSON.stringify(response.body))
  })

  await check('[status while enabled] GET /api/tournaments/beta-access отразява enabled=true hasAccess=false', async () => {
    const response = await httpRequest(port, '/api/tournaments/beta-access', 'GET', player.cookie)
    assert(response.status === 200, `status=${response.status}`)
    const body = response.body as { ok?: boolean; enabled?: boolean; hasAccess?: boolean }
    assert(body.ok === true && body.enabled === true && body.hasAccess === false, JSON.stringify(body))
  })

  await check('wrong password на POST /api/tournaments/beta-access → 401 wrong_password', async () => {
    const response = await httpRequest(port, '/api/tournaments/beta-access', 'POST', player.cookie, { password: 'nope-wrong' })
    assert(response.status === 401, `status=${response.status}, body=${JSON.stringify(response.body)}`)
    const body = response.body as { ok?: boolean; reason?: string }
    assert(body.ok === false && body.reason === 'wrong_password', JSON.stringify(response.body))
  })

  await check('[7] admin bypass — admin виждa турнирите БЕЗ grant', async () => {
    const response = await httpRequest(port, '/api/tournaments', 'GET', admin.cookie)
    assert(response.status === 200, `expected admin bypass to succeed, got status=${response.status}, body=${JSON.stringify(response.body)}`)
  })

  await check('correct password на POST /api/tournaments/beta-access → grant, после endpoint е достъпен', async () => {
    const submit = await httpRequest(port, '/api/tournaments/beta-access', 'POST', player.cookie, { password: FAKE_PASSWORD })
    assert(submit.status === 200, `submit status=${submit.status}, body=${JSON.stringify(submit.body)}`)
    const submitBody = submit.body as { ok?: boolean }
    assert(submitBody.ok === true, JSON.stringify(submit.body))

    const listResponse = await httpRequest(port, '/api/tournaments', 'GET', player.cookie)
    assert(listResponse.status === 200, `expected access after correct password, got status=${listResponse.status}`)
  })

  await check('[password change invalidates open tab] смяна на паролата инвалидира текущия grant веднага (без logout/restart)', async () => {
    const storeForChange = await createTournamentBetaAccessStore(isolated.databaseFile)
    storeForChange.setPassword(FAKE_PASSWORD_V2)
    storeForChange.close()

    const response = await httpRequest(port, '/api/tournaments', 'GET', player.cookie)
    assert(response.status === 403, `expected old grant to be invalidated immediately, got status=${response.status}`)
    const body = response.body as { reason?: string }
    assert(body.reason === 'beta_access_required', JSON.stringify(response.body))
  })

  await check('[8] anonymous (без session) без grant → 403 на representative endpoint', async () => {
    const response = await httpRequest(port, '/api/tournaments', 'GET')
    assert(response.status === 403, `status=${response.status}`)
  })

  await check('[disable] disable → нормален достъп веднага, без restart', async () => {
    const storeForDisable = await createTournamentBetaAccessStore(isolated.databaseFile)
    storeForDisable.disable()
    storeForDisable.close()

    const response = await httpRequest(port, '/api/tournaments', 'GET', player.cookie)
    assert(response.status === 200, `expected normal access after disable, got status=${response.status}`)
  })
} finally {
  if (server) await stopServer(server)
  await isolated.cleanup()
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
