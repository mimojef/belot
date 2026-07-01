/**
 * checkPasswordReset.ts
 *
 * Automated checks за password reset store, migration и shared auth helpers.
 * Използва реален временен SQLite и реалните production migration файлове.
 *
 * [1]  Migration се прилага успешно
 * [2]  Съществуващите account/sessions migrations продължават да работят
 * [3]  Raw token не присъства в password_reset_tokens
 * [4]  token_hash е точно 64 lowercase hex символа
 * [5]  Expiry е приблизително 30 минути
 * [6]  Втори token обезсилва първия
 * [7]  Revoked token не може да се използва
 * [8]  Expired token не може да се използва
 * [9]  Used token не може да се използва повторно
 * [10] Валиден token сменя password_hash
 * [11] Новият hash се потвърждава чрез реалния verifyPassword helper
 * [12] Активните account_sessions получават revoked_at след consume
 * [13] Вече revoked сесии не се повреждат (revoked_at не се презаписва)
 * [14] Disabled account не може да бъде reset-нат
 * [15] Два consume опита дават точно един успех (race protection)
 * [16] Вторият consume не сменя паролата отново
 * [17] Rate limiter допуска точния разрешен брой събития
 * [18] Следващото събитие се блокира (limited = true)
 * [19] Различни scope-ове са независими
 * [20] Два store instance-а виждат един общ SQLite rate limit
 * [21] Raw IP не присъства в rate-limit таблицата
 * [22] Raw email не присъства в rate-limit таблицата
 * [23] Raw token не присъства в SQLite dump
 * [24] Cleanup не изтрива активен token
 * [25] Cleanup премахва достатъчно стари записи
 * [26] createPasswordResetStore хвърля при твърде кратък secret
 * [27] HMAC: еднакъв scope+subject+secret → еднакъв hash
 * [28] HMAC: различен scope → различен hash
 * [29] HMAC: различен secret → различен hash
 * [30] Token точно преди expiry е валиден
 * [31] Token точно след expiry е невалиден
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createPasswordResetStore } from '../src/db/passwordResetStore.js'
import { verifyPassword, hmacRateLimitSubject } from '../src/db/authHelpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')

const TEST_SECRET = 'test-secret-for-checks-at-least-32-chars!!'

// ─── Брояч ───────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

// ─── Migration helpers ───────────────────────────────────────────────────────

async function applyMigration(db: DatabaseSync, filename: string): Promise<void> {
  const sql = await readFile(join(migrationsDir, filename), 'utf8')
  db.exec('BEGIN;')
  try {
    db.exec(sql.trim())
    db.exec('COMMIT;')
  } catch (err) {
    db.exec('ROLLBACK;')
    throw err
  }
}

async function buildTestDatabase(dbPath: string): Promise<void> {
  const db = new DatabaseSync(dbPath, { open: true })
  try {
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec('PRAGMA journal_mode = WAL;')
    await applyMigration(db, '20260416_001_create_bot_profiles.sql')
    await applyMigration(db, '20260423_001_create_profiles_bot_runtime_tables.sql')
    await applyMigration(db, '20260510_003_create_accounts_and_sessions.sql')
    await applyMigration(db, '20260701_001_create_password_reset_tokens.sql')
  } finally {
    db.close()
  }
}

// ─── Seed helpers ────────────────────────────────────────────────────────────

function seedAccount(
  dbPath: string,
  opts: {
    accountId: string
    email: string
    passwordHash?: string
    status?: 'active' | 'disabled'
  },
): void {
  const db = new DatabaseSync(dbPath, { open: true })
  try {
    db.exec('PRAGMA foreign_keys = ON;')
    db.prepare(`
      INSERT INTO accounts (account_id, email, password_hash, role, status)
      VALUES (?, ?, ?, 'player', ?)
    `).run(
      opts.accountId,
      opts.email,
      opts.passwordHash ?? 'scrypt:aabbcc:ddeeff',
      opts.status ?? 'active',
    )
    db.prepare(`
      INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name)
      VALUES (?, ?, ?, ?)
    `).run(
      'prof-' + opts.accountId,
      opts.accountId,
      'Тест ' + opts.accountId,
      'test-' + opts.accountId,
    )
  } finally {
    db.close()
  }
}

function seedSession(
  dbPath: string,
  opts: { sessionId: string; accountId: string; tokenHash: string; revokedAt?: string },
): void {
  const db = new DatabaseSync(dbPath, { open: true })
  try {
    db.exec('PRAGMA foreign_keys = ON;')
    db.prepare(`
      INSERT INTO account_sessions
        (session_id, account_id, profile_id, token_hash, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, datetime('now', '+30 days'), ?)
    `).run(
      opts.sessionId,
      opts.accountId,
      'prof-' + opts.accountId,
      opts.tokenHash,
      opts.revokedAt ?? null,
    )
  } finally {
    db.close()
  }
}

function dbQuery<T = unknown>(dbPath: string, sql: string, params: unknown[] = []): T[] {
  const db = new DatabaseSync(dbPath, { open: true })
  try {
    db.exec('PRAGMA foreign_keys = ON;')
    return db.prepare(sql).all(...params) as T[]
  } finally {
    db.close()
  }
}

function dbDumpResetTokens(dbPath: string): string {
  const rows = dbQuery<Record<string, unknown>>(dbPath, `
    SELECT token_id, account_id, token_hash, expires_at, used_at, revoked_at
    FROM password_reset_tokens
  `)
  return JSON.stringify(rows)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const dir = await mkdtemp(join(tmpdir(), 'belot-pwd-reset-check-'))
const dbPath = join(dir, 'test.sqlite')

try {
  console.log('\n=== Password Reset Store Checks ===\n')

  // [1] Migration се прилага успешно
  await check('[1] Migration се прилага успешно', async () => {
    await buildTestDatabase(dbPath)
    const rows = dbQuery<{ name: string }>(dbPath, `
      SELECT name FROM sqlite_master
      WHERE type='table'
        AND name IN ('password_reset_tokens', 'password_reset_rate_limit_events')
      ORDER BY name;
    `)
    assert(rows.length === 2, `Очаквани 2 таблици, намерени: ${rows.length}`)
  })

  // [2] Съществуващите account/sessions migrations продължават да работят
  await check('[2] Account/sessions migrations работят', () => {
    const rows = dbQuery<{ name: string }>(dbPath, `
      SELECT name FROM sqlite_master
      WHERE type='table' AND name IN ('accounts', 'account_sessions')
      ORDER BY name;
    `)
    assert(rows.length === 2, 'Таблиците accounts и account_sessions трябва да съществуват')
  })

  // [26] createPasswordResetStore хвърля при твърде кратък secret
  await check('[26] Кратък secret хвърля грешка', async () => {
    let threw = false
    try {
      await createPasswordResetStore(dbPath, { rateLimitHashSecret: 'short' })
    } catch {
      threw = true
    }
    assert(threw, 'createPasswordResetStore трябва да хвърли при кратък secret')
  })

  // [27] HMAC: еднакъв scope+subject+secret → еднакъв hash
  await check('[27] HMAC: еднакъв вход → еднакъв hash', () => {
    const h1 = hmacRateLimitSubject('ip', '1.2.3.4', TEST_SECRET)
    const h2 = hmacRateLimitSubject('ip', '1.2.3.4', TEST_SECRET)
    assert(h1 === h2, 'Еднакъв вход трябва да дава еднакъв HMAC')
    assert(/^[0-9a-f]{64}$/.test(h1), `HMAC трябва да е 64 lowercase hex: ${h1}`)
  })

  // [28] HMAC: различен scope → различен hash
  await check('[28] HMAC: различен scope → различен hash', () => {
    const h1 = hmacRateLimitSubject('ip', '1.2.3.4', TEST_SECRET)
    const h2 = hmacRateLimitSubject('email', '1.2.3.4', TEST_SECRET)
    assert(h1 !== h2, 'Различен scope трябва да дава различен HMAC')
  })

  // [29] HMAC: различен secret → различен hash
  await check('[29] HMAC: различен secret → различен hash', () => {
    const h1 = hmacRateLimitSubject('ip', '1.2.3.4', TEST_SECRET)
    const h2 = hmacRateLimitSubject('ip', '1.2.3.4', TEST_SECRET + '-other-secret-which-is-long')
    assert(h1 !== h2, 'Различен secret трябва да дава различен HMAC')
  })

  // Seed base акаунт и стартираме store
  seedAccount(dbPath, { accountId: 'acc-reset-1', email: 'reset@example.com' })
  const store = await createPasswordResetStore(dbPath, { rateLimitHashSecret: TEST_SECRET })

  // [3] Raw token не присъства в password_reset_tokens
  await check('[3] Raw token не присъства в password_reset_tokens', () => {
    const result = store.createPasswordResetToken('acc-reset-1')
    assert(result.ok, 'createPasswordResetToken трябва да е ok')
    if (!result.ok) return
    const dump = dbDumpResetTokens(dbPath)
    assert(!dump.includes(result.rawToken), 'Raw token не трябва да е в DB dump')
    store.revokePasswordResetToken(result.tokenId)
  })

  // [4] token_hash е точно 64 lowercase hex символа
  await check('[4] token_hash е 64 lowercase hex символа', () => {
    const result = store.createPasswordResetToken('acc-reset-1')
    assert(result.ok, 'createPasswordResetToken трябва да е ok')
    if (!result.ok) return
    const rows = dbQuery<{ token_hash: string }>(dbPath,
      'SELECT token_hash FROM password_reset_tokens WHERE token_id = ?',
      [result.tokenId],
    )
    assert(rows.length === 1, 'Трябва да има точно 1 ред')
    assert(/^[0-9a-f]{64}$/.test(rows[0]!.token_hash), `token_hash не е 64 lowercase hex: ${rows[0]!.token_hash}`)
    store.revokePasswordResetToken(result.tokenId)
  })

  // [5] Expiry е приблизително 30 минути
  await check('[5] Expiry е приблизително 30 минути', () => {
    const result = store.createPasswordResetToken('acc-reset-1')
    assert(result.ok, 'createPasswordResetToken трябва да е ok')
    if (!result.ok) return
    const rows = dbQuery<{ expires_at: string }>(dbPath,
      'SELECT expires_at FROM password_reset_tokens WHERE token_id = ?',
      [result.tokenId],
    )
    // SQLite datetime() дава формат "YYYY-MM-DD HH:MM:SS" (UTC без Z).
    // Добавяме 'Z' за да го парсираме като UTC в JavaScript.
    const expiresAt = new Date(rows[0]!.expires_at + 'Z').getTime()
    const diffMinutes = (expiresAt - Date.now()) / 1000 / 60
    assert(diffMinutes >= 29 && diffMinutes <= 31,
      `Expiry трябва да е ~30 мин, намерено: ${diffMinutes.toFixed(2)} мин`)
    store.revokePasswordResetToken(result.tokenId)
  })

  // [6] Втори token обезсилва първия
  await check('[6] Втори token обезсилва първия', () => {
    const r1 = store.createPasswordResetToken('acc-reset-1')
    assert(r1.ok, 'Първи createPasswordResetToken трябва да е ok')
    if (!r1.ok) return
    const r2 = store.createPasswordResetToken('acc-reset-1')
    assert(r2.ok, 'Втори createPasswordResetToken трябва да е ok')
    if (!r2.ok) return
    const rows = dbQuery<{ revoked_at: string | null }>(dbPath,
      'SELECT revoked_at FROM password_reset_tokens WHERE token_id = ?',
      [r1.tokenId],
    )
    assert(rows[0]!.revoked_at !== null, 'Първият token трябва да е revoked след втори create')
    store.revokePasswordResetToken(r2.tokenId)
  })

  // [7] Revoked token не може да се използва
  await check('[7] Revoked token не може да се използва', () => {
    seedAccount(dbPath, { accountId: 'acc-revoke-test', email: 'revoke@example.com' })
    const r = store.createPasswordResetToken('acc-revoke-test')
    assert(r.ok, 'createPasswordResetToken трябва да е ok')
    if (!r.ok) return
    store.revokePasswordResetToken(r.tokenId)
    const consume = store.consumePasswordResetTokenAndChangePassword({
      rawToken: r.rawToken,
      newPassword: 'newpassword123',
    })
    assert(!consume.ok && consume.reason === 'invalid_token', 'Revoked token трябва да върне invalid_token')
  })

  // [8] Expired token не може да се използва
  await check('[8] Expired token не може да се използва', () => {
    seedAccount(dbPath, { accountId: 'acc-expired-test', email: 'expired@example.com' })
    const r = store.createPasswordResetToken('acc-expired-test')
    assert(r.ok, 'createPasswordResetToken трябва да е ok')
    if (!r.ok) return
    // Форсираме изтичане директно в DB.
    const db = new DatabaseSync(dbPath, { open: true })
    try {
      db.exec('PRAGMA foreign_keys = ON;')
      db.prepare(
        `UPDATE password_reset_tokens SET expires_at = datetime('now', '-1 minute') WHERE token_id = ?`
      ).run(r.tokenId)
    } finally {
      db.close()
    }
    const consume = store.consumePasswordResetTokenAndChangePassword({
      rawToken: r.rawToken,
      newPassword: 'newpassword123',
    })
    assert(!consume.ok && consume.reason === 'invalid_token', 'Expired token трябва да върне invalid_token')
  })

  // [30] Token точно преди expiry е валиден
  await check('[30] Token точно преди expiry е валиден', () => {
    seedAccount(dbPath, { accountId: 'acc-boundary-valid', email: 'boundary-valid@example.com',
      passwordHash: 'scrypt:aabbcc:ddeeff' })
    const r = store.createPasswordResetToken('acc-boundary-valid')
    assert(r.ok, 'createPasswordResetToken трябва да е ok')
    if (!r.ok) return
    // Поставяме expires_at в бъдещето — 1 секунда напред.
    const db = new DatabaseSync(dbPath, { open: true })
    try {
      db.exec('PRAGMA foreign_keys = ON;')
      db.prepare(
        `UPDATE password_reset_tokens SET expires_at = datetime('now', '+1 second') WHERE token_id = ?`
      ).run(r.tokenId)
    } finally {
      db.close()
    }
    const consume = store.consumePasswordResetTokenAndChangePassword({
      rawToken: r.rawToken,
      newPassword: 'valid-boundary-pass',
    })
    assert(consume.ok, 'Token 1 секунда преди expiry трябва да е валиден')
  })

  // [31] Token точно след expiry е невалиден
  await check('[31] Token точно след expiry е невалиден', () => {
    seedAccount(dbPath, { accountId: 'acc-boundary-expired', email: 'boundary-expired@example.com' })
    const r = store.createPasswordResetToken('acc-boundary-expired')
    assert(r.ok, 'createPasswordResetToken трябва да е ok')
    if (!r.ok) return
    // Поставяме expires_at в миналото — 1 секунда назад.
    const db = new DatabaseSync(dbPath, { open: true })
    try {
      db.exec('PRAGMA foreign_keys = ON;')
      db.prepare(
        `UPDATE password_reset_tokens SET expires_at = datetime('now', '-1 second') WHERE token_id = ?`
      ).run(r.tokenId)
    } finally {
      db.close()
    }
    const consume = store.consumePasswordResetTokenAndChangePassword({
      rawToken: r.rawToken,
      newPassword: 'expired-boundary-pass',
    })
    assert(!consume.ok && consume.reason === 'invalid_token', 'Token 1 секунда след expiry трябва да е невалиден')
  })

  // Seed акаунт с реална парола за consume тестовете
  const { createPasswordHash: makeHash } = await import('../src/db/authHelpers.js')
  const originalPasswordHash = makeHash('original-password')
  seedAccount(dbPath, {
    accountId: 'acc-consume-test',
    email: 'consume@example.com',
    passwordHash: originalPasswordHash,
  })
  seedSession(dbPath, { sessionId: 'sess-active-1', accountId: 'acc-consume-test', tokenHash: 'activehash1' })
  seedSession(dbPath, { sessionId: 'sess-active-2', accountId: 'acc-consume-test', tokenHash: 'activehash2' })
  seedSession(dbPath, {
    sessionId: 'sess-already-revoked',
    accountId: 'acc-consume-test',
    tokenHash: 'revokedhash1',
    revokedAt: '2026-01-01T00:00:00',
  })

  // [9] Used token не може да се използва повторно
  await check('[9] Used token не може да се използва повторно', () => {
    const r = store.createPasswordResetToken('acc-consume-test')
    assert(r.ok, 'createPasswordResetToken трябва да е ok')
    if (!r.ok) return
    const c1 = store.consumePasswordResetTokenAndChangePassword({ rawToken: r.rawToken, newPassword: 'newpass-attempt1' })
    assert(c1.ok, 'Първи consume трябва да успее')
    const c2 = store.consumePasswordResetTokenAndChangePassword({ rawToken: r.rawToken, newPassword: 'newpass-attempt2' })
    assert(!c2.ok && c2.reason === 'invalid_token', 'Втори consume на used token трябва да е invalid_token')
  })

  // Нов акаунт за consume тестове (consume-test е с нова парола след [9])
  const consume2Hash = makeHash('original-password2')
  seedAccount(dbPath, {
    accountId: 'acc-consume2-test',
    email: 'consume2@example.com',
    passwordHash: consume2Hash,
  })
  seedSession(dbPath, { sessionId: 'sess-c2-active', accountId: 'acc-consume2-test', tokenHash: 'c2activehash' })

  // [10] Валиден token сменя password_hash
  await check('[10] Валиден token сменя password_hash', () => {
    const r = store.createPasswordResetToken('acc-consume2-test')
    assert(r.ok, 'createPasswordResetToken трябва да е ok')
    if (!r.ok) return
    const consume = store.consumePasswordResetTokenAndChangePassword({ rawToken: r.rawToken, newPassword: 'brand-new-password' })
    assert(consume.ok, 'Consume трябва да е ok')
    const rows = dbQuery<{ password_hash: string }>(dbPath,
      'SELECT password_hash FROM accounts WHERE account_id = ?', ['acc-consume2-test'])
    assert(rows[0]!.password_hash !== consume2Hash, 'password_hash трябва да е сменен')
    assert(rows[0]!.password_hash.startsWith('scrypt:'), 'Новият hash трябва да е scrypt формат')
  })

  // [11] Новият hash се потвърждава чрез реалния verifyPassword helper
  await check('[11] Нов hash се потвърждава с verifyPassword', () => {
    const rows = dbQuery<{ password_hash: string }>(dbPath,
      'SELECT password_hash FROM accounts WHERE account_id = ?', ['acc-consume2-test'])
    assert(verifyPassword('brand-new-password', rows[0]!.password_hash), 'verifyPassword трябва да потвърди новата парола')
    assert(!verifyPassword('wrong-password', rows[0]!.password_hash), 'verifyPassword трябва да отхвърли грешна парола')
  })

  // [12] Активните account_sessions получават revoked_at след consume
  await check('[12] Активните сесии получават revoked_at след consume', () => {
    const rows = dbQuery<{ session_id: string; revoked_at: string | null }>(dbPath,
      `SELECT session_id, revoked_at FROM account_sessions WHERE account_id = ?`,
      ['acc-consume2-test'],
    )
    const active = rows.filter(r => r.revoked_at === null)
    assert(active.length === 0, `Всички активни сесии трябва да са revoked, останали: ${active.length}`)
  })

  // [13] Вече revoked сесии не се повреждат
  await check('[13] Вече revoked сесии не се повреждат', () => {
    const rows = dbQuery<{ revoked_at: string | null }>(dbPath,
      'SELECT revoked_at FROM account_sessions WHERE session_id = ?', ['sess-already-revoked'])
    assert(rows[0]!.revoked_at === '2026-01-01T00:00:00', 'Оригиналният revoked_at не трябва да се промени')
  })

  // [14] Disabled account не може да бъде reset-нат
  await check('[14] Disabled account не може да бъде reset-нат', async () => {
    seedAccount(dbPath, { accountId: 'acc-disabled-test', email: 'disabled@example.com', status: 'disabled' })
    const found = store.findActiveAccountByNormalizedEmail('disabled@example.com')
    assert(!found.found, 'Disabled акаунт не трябва да се намери като active')

    // Форсираме token директно и проверяваме, че consume го отказва.
    const { randomBytes, createHash, randomUUID: rUUID } = await import('node:crypto')
    const rawToken = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const tokenId = rUUID()
    const db = new DatabaseSync(dbPath, { open: true })
    try {
      db.exec('PRAGMA foreign_keys = ON;')
      db.prepare(`
        INSERT INTO password_reset_tokens (token_id, account_id, token_hash, expires_at)
        VALUES (?, ?, ?, datetime('now', '+30 minutes'))
      `).run(tokenId, 'acc-disabled-test', tokenHash)
    } finally {
      db.close()
    }
    const consume = store.consumePasswordResetTokenAndChangePassword({ rawToken, newPassword: 'newpassword123' })
    assert(!consume.ok && consume.reason === 'invalid_token', 'Disabled account трябва да върне invalid_token')
  })

  // [15] & [16] Race protection — два consume опита, точно един успех
  await check('[15] Два consume опита дават точно един успех', async () => {
    const raceHash = makeHash('race-original-password')
    seedAccount(dbPath, { accountId: 'acc-race-test', email: 'race@example.com', passwordHash: raceHash })
    const r = store.createPasswordResetToken('acc-race-test')
    assert(r.ok, 'createPasswordResetToken трябва да е ok')
    if (!r.ok) return

    const store2 = await createPasswordResetStore(dbPath, { rateLimitHashSecret: TEST_SECRET })
    const [c1, c2] = await Promise.all([
      Promise.resolve(store.consumePasswordResetTokenAndChangePassword({ rawToken: r.rawToken, newPassword: 'race-new-password-1' })),
      Promise.resolve(store2.consumePasswordResetTokenAndChangePassword({ rawToken: r.rawToken, newPassword: 'race-new-password-2' })),
    ])
    const successCount = [c1, c2].filter(c => c.ok).length
    assert(successCount === 1, `Трябва точно 1 успешен consume, намерени: ${successCount}`)
    store2.close()
  })

  await check('[16] Вторият consume не сменя паролата отново', () => {
    const rows = dbQuery<{ password_hash: string }>(dbPath,
      'SELECT password_hash FROM accounts WHERE account_id = ?', ['acc-race-test'])
    const finalHash = rows[0]!.password_hash
    const matchesPass1 = verifyPassword('race-new-password-1', finalHash)
    const matchesPass2 = verifyPassword('race-new-password-2', finalHash)
    assert(
      (matchesPass1 && !matchesPass2) || (!matchesPass1 && matchesPass2),
      'Точно едната нова парола трябва да е записана',
    )
  })

  // [17] Rate limiter допуска точния разрешен брой събития
  await check('[17] Rate limiter допуска maxEvents събития', () => {
    for (let i = 0; i < 3; i++) {
      const result = store.checkAndRecordRateLimit({
        scope: 'forgot-password-ip',
        rawSubject: '10.0.0.1',
        windowSeconds: 1800,
        maxEvents: 3,
      })
      assert(result.ok && !result.limited, `Събитие ${i + 1} трябва да е допуснато`)
    }
  })

  // [18] Следващото събитие се блокира
  await check('[18] Следващото събитие се блокира (limited)', () => {
    const result = store.checkAndRecordRateLimit({
      scope: 'forgot-password-ip',
      rawSubject: '10.0.0.1',
      windowSeconds: 1800,
      maxEvents: 3,
    })
    assert(result.ok && result.limited, '4-тото събитие трябва да е limited')
  })

  // [19] Различни scope-ове са независими
  await check('[19] Различни scope-ове са независими', () => {
    const result = store.checkAndRecordRateLimit({
      scope: 'forgot-password-acct',
      rawSubject: '10.0.0.1',
      windowSeconds: 1800,
      maxEvents: 3,
    })
    assert(result.ok && !result.limited, 'Различен scope трябва да е независим')
  })

  // [20] Два store instance-а виждат един общ SQLite rate limit
  await check('[20] Два store instance-а споделят rate limit', async () => {
    const storeB = await createPasswordResetStore(dbPath, { rateLimitHashSecret: TEST_SECRET })
    const result = storeB.checkAndRecordRateLimit({
      scope: 'forgot-password-ip',
      rawSubject: '10.0.0.1',
      windowSeconds: 1800,
      maxEvents: 3,
    })
    assert(result.ok && result.limited, 'Вторият store instance трябва да вижда вече достигнатия лимит')
    storeB.close()
  })

  // [21] Raw IP не присъства в rate-limit таблицата
  await check('[21] Raw IP не присъства в rate-limit таблицата', () => {
    const rows = dbQuery<Record<string, unknown>>(dbPath, 'SELECT * FROM password_reset_rate_limit_events')
    const dump = JSON.stringify(rows)
    assert(!dump.includes('10.0.0.1'), 'Raw IP адрес не трябва да е в rate-limit таблицата')
  })

  // [22] Raw email не присъства в rate-limit таблицата
  await check('[22] Raw email не присъства в rate-limit таблицата', () => {
    store.checkAndRecordRateLimit({
      scope: 'forgot-password-email',
      rawSubject: 'secret-email@example.com',
      windowSeconds: 1800,
      maxEvents: 5,
    })
    const rows = dbQuery<Record<string, unknown>>(dbPath, 'SELECT * FROM password_reset_rate_limit_events')
    const dump = JSON.stringify(rows)
    assert(!dump.includes('secret-email@example.com'), 'Raw email не трябва да е в rate-limit таблицата')
  })

  // [23] Raw token не присъства в SQLite dump
  await check('[23] Raw token не присъства в SQLite dump', () => {
    seedAccount(dbPath, { accountId: 'acc-dump-test', email: 'dump@example.com' })
    const r = store.createPasswordResetToken('acc-dump-test')
    assert(r.ok, 'createPasswordResetToken трябва да е ok')
    if (!r.ok) return
    const dump = dbDumpResetTokens(dbPath)
    assert(!dump.includes(r.rawToken), 'Raw token не трябва да присъства в DB dump')
    store.revokePasswordResetToken(r.tokenId)
  })

  // [24] Cleanup не изтрива активен token
  await check('[24] Cleanup не изтрива активен token', () => {
    seedAccount(dbPath, { accountId: 'acc-cleanup-test', email: 'cleanup@example.com' })
    const r1 = store.createPasswordResetToken('acc-cleanup-test')
    assert(r1.ok, 'Първи createPasswordResetToken трябва да е ok')
    if (!r1.ok) return
    // Вторият create trigger-ва opportunistic cleanup и обезсилва r1, но r2 остава.
    const r2 = store.createPasswordResetToken('acc-cleanup-test')
    assert(r2.ok, 'Втори createPasswordResetToken трябва да е ok')
    if (!r2.ok) return
    const rows = dbQuery<{ token_id: string }>(dbPath,
      `SELECT token_id FROM password_reset_tokens
       WHERE token_id = ? AND revoked_at IS NULL AND used_at IS NULL`,
      [r2.tokenId],
    )
    assert(rows.length === 1, 'Активният token трябва да е запазен след cleanup')
    store.revokePasswordResetToken(r2.tokenId)
  })

  // [25] Cleanup премахва достатъчно стари записи
  await check('[25] Cleanup премахва стари записи', () => {
    // Вмъкваме стар използван запис (8 дни назад).
    const db = new DatabaseSync(dbPath, { open: true })
    try {
      db.exec('PRAGMA foreign_keys = ON;')
      db.prepare(`
        INSERT INTO password_reset_tokens
          (token_id, account_id, token_hash, expires_at, used_at, created_at)
        VALUES (
          'old-token-cleanup',
          'acc-reset-1',
          'aaaaaabbbbbbccccccddddddeeeeeeffffffffaaaaaabbbbbbccccccddddddee',
          datetime('now', '-8 days'),
          datetime('now', '-8 days'),
          datetime('now', '-8 days')
        )
      `).run()
    } finally {
      db.close()
    }
    const before = dbQuery<{ token_id: string }>(dbPath,
      `SELECT token_id FROM password_reset_tokens WHERE token_id = 'old-token-cleanup'`)
    assert(before.length === 1, 'Старият ред трябва да е вмъкнат')

    // Нов create trigger-ва opportunistic cleanup.
    seedAccount(dbPath, { accountId: 'acc-cleanup2-test', email: 'cleanup2@example.com' })
    const r = store.createPasswordResetToken('acc-cleanup2-test')
    assert(r.ok, 'createPasswordResetToken трябва да е ok')
    if (!r.ok) return

    const after = dbQuery<{ token_id: string }>(dbPath,
      `SELECT token_id FROM password_reset_tokens WHERE token_id = 'old-token-cleanup'`)
    assert(after.length === 0, 'Старият ред трябва да е изтрит от cleanup')
    store.revokePasswordResetToken(r.tokenId)
  })

  store.close()

} finally {
  await rm(dir, { recursive: true, force: true })
}

// ─── Резултат ────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}
