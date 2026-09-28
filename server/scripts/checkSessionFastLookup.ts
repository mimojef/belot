/**
 * checkSessionFastLookup.ts
 *
 * Regression coverage за session fast lookup (CPU hotspot fix):
 * account_sessions.token_lookup_hash = SHA-256(raw token) + lazy backfill на
 * legacy сесии (token_lookup_hash IS NULL), чийто lookup минава през стария
 * scrypt token_hash само веднъж.
 *
 * "Legacy" сесия се симулира детерминирано: нормално създадена сесия, на
 * която token_lookup_hash е нулиран с raw SQL — точно състоянието на ред,
 * създаден преди migration 20260928_001 (token_hash е същият scrypt hash).
 *
 * Scrypt instrumentation: createAuthStore options.onLegacySessionHash се
 * вика при ВСЯКО изчисление на legacy scrypt hash — тестовете броят
 * извикванията, за да докажат, че fast path-ът не изпълнява scrypt.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'

import { createAuthStore } from '../src/db/authStore.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')

const PASSWORD = 'SessionFastLookup1!'
const DAY_MS = 1000 * 60 * 60 * 24
const NINETY_DAYS_MS = DAY_MS * 90
const TEST_REGISTRATION_SECRET = 'session-fast-lookup-test-secret-0123456789'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function applyMigrations(databaseFilePath: string): Promise<void> {
  const db = new DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  const migrationFiles = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()
  for (const file of migrationFiles) {
    db.exec(await readFile(join(migrationsDir, file), 'utf8'))
  }
  db.close()
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

type SessionDbRow = {
  session_id: string
  token_hash: string
  token_lookup_hash: string | null
  expires_at: string
  revoked_at: string | null
  remember_me: number
}

console.log('\ncheckSessionFastLookup')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-session-fast-lookup-'))
const dbPath = join(tempDir, 'session-fast-lookup.sqlite')
let legacyHashCalls = 0
let db: DatabaseSync | null = null

try {
  await applyMigrations(dbPath)
  const progressStore = await createPlayerProgressStore(dbPath)
  const authStore = await createAuthStore(dbPath, progressStore, {
    registrationVerificationCodeSecret: TEST_REGISTRATION_SECRET,
    onLegacySessionHash: () => { legacyHashCalls++ },
  })
  // Втори authStore върху СЪЩИЯ файл — mirror на два PM2 процеса.
  let secondStoreLegacyHashCalls = 0
  const secondAuthStore = await createAuthStore(dbPath, progressStore, {
    registrationVerificationCodeSecret: TEST_REGISTRATION_SECRET,
    onLegacySessionHash: () => { secondStoreLegacyHashCalls++ },
  })
  db = new DatabaseSync(dbPath, { open: true })
  db.exec('PRAGMA journal_mode = WAL;')
  const localDb = db

  function readRow(sessionId: string): SessionDbRow {
    const row = localDb.prepare(`
      SELECT session_id, token_hash, token_lookup_hash, expires_at, revoked_at, remember_me
      FROM account_sessions WHERE session_id = ?
    `).get(sessionId) as SessionDbRow | undefined
    if (!row) throw new Error(`session row not found: ${sessionId}`)
    return row
  }
  function makeLegacy(sessionId: string): void {
    localDb.prepare(`UPDATE account_sessions SET token_lookup_hash = NULL WHERE session_id = ?`).run(sessionId)
  }
  function setExpiresAt(sessionId: string, isoValue: string): void {
    localDb.prepare(`UPDATE account_sessions SET expires_at = ? WHERE session_id = ?`).run(isoValue, sessionId)
  }
  function setRevoked(sessionId: string): void {
    localDb.prepare(`UPDATE account_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE session_id = ?`).run(sessionId)
  }

  const accounts: Record<string, string> = {}
  function registerFresh(suffix: string): { sessionToken: string; sessionId: string } {
    const email = `fast-${suffix}@example.test`
    const pendingResult = authStore.register({
      email,
      password: PASSWORD,
      displayName: `Fast${suffix}`,
      gender: 'male',
      visitorId: randomUUID(),
    })
    assert(pendingResult.ok, `register(${suffix}) failed: ${!pendingResult.ok ? pendingResult.message : ''}`)
    if (!pendingResult.ok || pendingResult.mode !== 'email_code') throw new Error('expected email_code registration mode')
    const verifyResult = authStore.verifyRegistrationEmail({
      pendingRegistrationId: pendingResult.pendingRegistrationId,
      code: pendingResult.rawCode,
      rememberMe: true,
      ipAddress: null,
      userAgent: null,
    })
    assert(verifyResult.ok, `verifyRegistrationEmail(${suffix}) failed`)
    if (!verifyResult.ok) throw new Error('unreachable')
    accounts[suffix] = email
    return { sessionToken: verifyResult.sessionToken, sessionId: verifyResult.session.sessionId }
  }
  function loginFresh(suffix: string, rememberMe: boolean): { sessionToken: string; sessionId: string } {
    const result = authStore.login({ email: accounts[suffix]!, password: PASSWORD, rememberMe })
    assert(result.ok === true, `login(${suffix}) failed`)
    if (result.ok !== true) throw new Error('unreachable')
    return { sessionToken: result.sessionToken, sessionId: result.session.sessionId }
  }

  // ── Schema ────────────────────────────────────────────────────────────
  await check('[0] migration: token_lookup_hash nullable + partial UNIQUE index; token_hash NOT NULL UNIQUE непроменен', () => {
    const columns = localDb.prepare(`PRAGMA table_info('account_sessions')`).all() as Array<{ name: string; notnull: number }>
    const lookup = columns.find((column) => column.name === 'token_lookup_hash')
    assert(lookup !== undefined && lookup.notnull === 0, 'token_lookup_hash липсва или е NOT NULL')
    assert(columns.find((column) => column.name === 'token_hash')?.notnull === 1, 'token_hash вече не е NOT NULL')
    const index = localDb.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_account_sessions_token_lookup_hash'`).get() as { sql: string } | undefined
    assert(index !== undefined && /UNIQUE/i.test(index.sql) && /WHERE\s+token_lookup_hash\s+IS\s+NOT\s+NULL/i.test(index.sql), `index sql: ${index?.sql}`)
    const tableSql = (localDb.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'account_sessions'`).get() as { sql: string }).sql
    assert(/token_hash TEXT NOT NULL UNIQUE/.test(tableSql), 'token_hash UNIQUE constraint променен')
  })

  // ── [1] New session ───────────────────────────────────────────────────
  await check('[1] нова сесия: token_lookup_hash = SHA-256(token), token_hash (legacy) също записан, getSession без scrypt', () => {
    const before = legacyHashCalls
    const { sessionToken, sessionId } = registerFresh('new')
    assert(legacyHashCalls - before === 1, `createSession трябваше да изчисли legacy hash точно веднъж, got ${legacyHashCalls - before}`)
    const row = readRow(sessionId)
    assert(row.token_lookup_hash === sha256Hex(sessionToken), 'token_lookup_hash != SHA-256(token)')
    assert(/^[0-9a-f]{64}$/.test(row.token_hash) && row.token_hash !== row.token_lookup_hash, 'legacy token_hash не е scrypt hex')

    const afterCreate = legacyHashCalls
    const first = authStore.getSession(sessionToken)
    const second = authStore.getSession(sessionToken)
    assert(first !== null && second !== null && first.sessionId === sessionId, 'getSession върна null за нова сесия')
    assert(legacyHashCalls === afterCreate, `fast lookup изпълни scrypt ${legacyHashCalls - afterCreate} пъти`)
  })

  // ── [2] Legacy session migration ──────────────────────────────────────
  await check('[2] legacy сесия (lookup NULL): първи lookup -> scrypt fallback + backfill; следващи -> fast, без scrypt', () => {
    const { sessionToken, sessionId } = registerFresh('legacy')
    makeLegacy(sessionId)
    assert(readRow(sessionId).token_lookup_hash === null, 'setup: lookup hash не е NULL')

    const before = legacyHashCalls
    const first = authStore.getSession(sessionToken)
    assert(first !== null && first.sessionId === sessionId, 'първият legacy lookup върна null')
    assert(legacyHashCalls - before === 1, `очаквах 1 scrypt при migration lookup, got ${legacyHashCalls - before}`)
    assert(readRow(sessionId).token_lookup_hash === sha256Hex(sessionToken), 'token_lookup_hash не беше backfill-нат')

    const afterMigration = legacyHashCalls
    for (let i = 0; i < 5; i++) {
      assert(authStore.getSession(sessionToken)?.sessionId === sessionId, `lookup #${i} след migration върна null`)
    }
    assert(authStore.touchSession(sessionToken).session !== null, 'touchSession след migration върна null')
    assert(legacyHashCalls === afterMigration, `след migration имаше ${legacyHashCalls - afterMigration} scrypt извиквания`)
  })

  // ── [3] Expired legacy ────────────────────────────────────────────────
  await check('[3] изтекла legacy сесия -> null, БЕЗ backfill', () => {
    const { sessionToken, sessionId } = registerFresh('expired')
    makeLegacy(sessionId)
    setExpiresAt(sessionId, new Date(Date.now() - 1000).toISOString())
    assert(authStore.getSession(sessionToken) === null, 'изтекла сесия върна non-null (getSession)')
    assert(authStore.touchSession(sessionToken).session === null, 'изтекла сесия върна non-null (touchSession)')
    assert(readRow(sessionId).token_lookup_hash === null, 'изтекла сесия получи backfill')
  })

  // ── [4] Revoked legacy ────────────────────────────────────────────────
  await check('[4] revoked legacy сесия -> null, БЕЗ backfill', () => {
    const { sessionToken, sessionId } = registerFresh('revoked')
    makeLegacy(sessionId)
    setRevoked(sessionId)
    assert(authStore.getSession(sessionToken) === null, 'revoked сесия върна non-null (getSession)')
    assert(authStore.touchSession(sessionToken).session === null, 'revoked сесия върна non-null (touchSession)')
    assert(readRow(sessionId).token_lookup_hash === null, 'revoked сесия получи backfill')
  })

  await check('[4b] fast-hash сесия, изтекла/revoked -> null (fast path пази същата validation)', () => {
    const a = registerFresh('fastexp')
    setExpiresAt(a.sessionId, new Date(Date.now() - 1000).toISOString())
    assert(authStore.getSession(a.sessionToken) === null, 'изтекла fast сесия върна non-null')
    const b = registerFresh('fastrev')
    setRevoked(b.sessionId)
    assert(authStore.getSession(b.sessionToken) === null, 'revoked fast сесия върна non-null')
  })

  await check('[4c] непознат token -> null, без backfill/insert', () => {
    const countBefore = (localDb.prepare(`SELECT COUNT(*) AS c FROM account_sessions WHERE token_lookup_hash IS NOT NULL`).get() as { c: number }).c
    assert(authStore.getSession('bogus-token-value') === null, 'bogus token върна non-null')
    assert(authStore.getSession(null) === null, 'null token върна non-null')
    const countAfter = (localDb.prepare(`SELECT COUNT(*) AS c FROM account_sessions WHERE token_lookup_hash IS NOT NULL`).get() as { c: number }).c
    assert(countBefore === countAfter, 'bogus token промени lookup hashes')
  })

  // ── [5] touchSession semantics ────────────────────────────────────────
  await check('[5] touchSession на legacy сесия: 90-дневен renewal + throttle + remember_me непроменени', () => {
    registerFresh('touch')
    const { sessionToken, sessionId } = loginFresh('touch', false)
    makeLegacy(sessionId)
    setExpiresAt(sessionId, new Date(Date.now() + 5 * DAY_MS).toISOString())

    const first = authStore.touchSession(sessionToken)
    assert(first.session !== null && first.renewed === true, `очаквах renewed=true, got ${JSON.stringify({ s: first.session !== null, r: first.renewed })}`)
    assert(first.rememberMe === false, 'remember_me=0 не беше запазен (legacy path)')
    const renewedRow = readRow(sessionId)
    const drift = Math.abs(new Date(renewedRow.expires_at).getTime() - (Date.now() + NINETY_DAYS_MS))
    assert(drift < 60_000, `expires_at drift ${drift}ms`)
    assert(renewedRow.token_lookup_hash === sha256Hex(sessionToken), 'touchSession не backfill-на')
    assert(renewedRow.remember_me === 0, 'remember_me колоната се промени')

    const expiresAfterFirst = renewedRow.expires_at
    const second = authStore.touchSession(sessionToken)
    assert(second.session !== null && second.renewed === false, 'throttle: вторият touch renew-на отново')
    assert(second.rememberMe === false, 'remember_me=0 не беше запазен (fast path)')
    assert(readRow(sessionId).expires_at === expiresAfterFirst, 'throttle: expires_at се промени')
  })

  await check('[5b] touchSession на нова (fast) сесия: renewal когато е due, remember_me=true', () => {
    const { sessionToken, sessionId } = registerFresh('touchfast')
    const fresh = authStore.touchSession(sessionToken)
    assert(fresh.session !== null && fresh.renewed === false && fresh.rememberMe === true, 'току-що създадена сесия не трябва да renew-ва')
    setExpiresAt(sessionId, new Date(Date.now() + 10 * DAY_MS).toISOString())
    const before = legacyHashCalls
    const due = authStore.touchSession(sessionToken)
    assert(due.renewed === true, 'due fast сесия не renew-на')
    assert(legacyHashCalls === before, 'fast touchSession изпълни scrypt')
  })

  // ── [6] Logout ────────────────────────────────────────────────────────
  await check('[6a] logout на нова сесия -> revoke по lookup hash, без scrypt', () => {
    const { sessionToken, sessionId } = registerFresh('logoutfast')
    const before = legacyHashCalls
    authStore.logout(sessionToken)
    assert(legacyHashCalls === before, 'fast logout изпълни scrypt')
    assert(readRow(sessionId).revoked_at !== null, 'сесията не беше revoked')
    assert(authStore.getSession(sessionToken) === null, 'getSession след logout != null')
  })

  await check('[6b] logout на legacy сесия -> legacy fallback revoke', () => {
    const { sessionToken, sessionId } = registerFresh('logoutlegacy')
    makeLegacy(sessionId)
    const before = legacyHashCalls
    authStore.logout(sessionToken)
    assert(legacyHashCalls - before === 1, `очаквах 1 scrypt при legacy logout, got ${legacyHashCalls - before}`)
    const row = readRow(sessionId)
    assert(row.revoked_at !== null, 'legacy сесията не беше revoked')
    assert(row.token_lookup_hash === null, 'logout backfill-на lookup hash')
    assert(authStore.getSession(sessionToken) === null, 'getSession след legacy logout != null')
  })

  await check('[6c] logout изолира само своята сесия (multi-device)', () => {
    registerFresh('multi')
    const a = loginFresh('multi', true)
    const b = loginFresh('multi', true)
    authStore.logout(a.sessionToken)
    assert(authStore.getSession(a.sessionToken) === null, 'a не е logout-нат')
    assert(authStore.getSession(b.sessionToken) !== null, 'b беше засегнат от logout на a')
  })

  // ── [7] Backfill idempotency / concurrency ────────────────────────────
  await check('[7a] два store-а (≈ два PM2 процеса) върху legacy сесия: един backfill, втори минава по fast path', () => {
    const { sessionToken, sessionId } = registerFresh('twoproc')
    makeLegacy(sessionId)
    assert(authStore.getSession(sessionToken) !== null, 'store A: null')
    const backfilled = readRow(sessionId).token_lookup_hash
    const beforeB = secondStoreLegacyHashCalls
    assert(secondAuthStore.getSession(sessionToken) !== null, 'store B: null')
    assert(secondStoreLegacyHashCalls === beforeB, 'store B изпълни scrypt въпреки backfill-а на A')
    assert(readRow(sessionId).token_lookup_hash === backfilled, 'lookup hash се промени')
  })

  await check('[7b] backfill guard (token_lookup_hash IS NULL) никога не презаписва вече попълнена стойност (конкурентен победител)', () => {
    const { sessionToken, sessionId } = registerFresh('guard')
    // Симулира: друг процес вече е записал стойност между нашия fast miss и
    // нашия backfill UPDATE (стойността тук е различна, за да е наблюдаемо).
    const sentinel = 'f'.repeat(64)
    localDb.prepare(`UPDATE account_sessions SET token_lookup_hash = ? WHERE session_id = ?`).run(sentinel, sessionId)
    const session = authStore.getSession(sessionToken)
    assert(session !== null && session.sessionId === sessionId, 'legacy fallback не върна валидната сесия')
    assert(readRow(sessionId).token_lookup_hash === sentinel, 'backfill презаписа вече попълнена стойност')
  })

  await check('[7c] UNIQUE конфликт при backfill не проваля auth lookup-а (UPDATE OR IGNORE)', () => {
    const victim = registerFresh('uniqvictim')
    const other = registerFresh('uniqother')
    makeLegacy(victim.sessionId)
    // Друг (revoked -> невидим за fast SELECT) ред вече държи SHA-256 на victim token-а.
    localDb.prepare(`UPDATE account_sessions SET token_lookup_hash = ?, revoked_at = CURRENT_TIMESTAMP WHERE session_id = ?`)
      .run(sha256Hex(victim.sessionToken), other.sessionId)
    const session = authStore.getSession(victim.sessionToken)
    assert(session !== null && session.sessionId === victim.sessionId, 'lookup-ът беше провален от UNIQUE конфликт')
    assert(readRow(victim.sessionId).token_lookup_hash === null, 'конфликтният backfill не беше игнориран')
  })

  await check('[7d] повторни lookup-и след backfill са idempotent (стойност непроменена, 0 scrypt)', () => {
    const { sessionToken, sessionId } = registerFresh('idem')
    makeLegacy(sessionId)
    authStore.getSession(sessionToken)
    const value = readRow(sessionId).token_lookup_hash
    const before = legacyHashCalls
    for (let i = 0; i < 3; i++) authStore.touchSession(sessionToken)
    assert(readRow(sessionId).token_lookup_hash === value, 'стойността се промени')
    assert(legacyHashCalls === before, 'повторните lookup-и изпълниха scrypt')
  })

  authStore.close()
  secondAuthStore.close()
} finally {
  db?.close()
  await rm(tempDir, { recursive: true, force: true }).catch(() => {})
}

if (failed > 0) {
  console.error(`checkSessionFastLookup failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`checkSessionFastLookup passed: ${passed} checks.`)
