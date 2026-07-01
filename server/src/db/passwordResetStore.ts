import { randomUUID } from 'node:crypto'
import {
  createPasswordHash,
  generateRawResetToken,
  generateUUID,
  hmacRateLimitSubject,
  hashResetToken,
  validatePassword,
  validateRateLimitSecret,
} from './authHelpers.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

// ─── Types ────────────────────────────────────────────────────────────────────

export type PasswordResetStoreOptions = {
  // HMAC secret за rate-limit subject hashing.
  // Минимум 32 символа. Идва от env (PASSWORD_RESET_RATE_LIMIT_SECRET).
  // Store-ът го получава като параметър за testability — не чете process.env.
  rateLimitHashSecret: string
}

export type PasswordResetStore = {
  findActiveAccountByNormalizedEmail: (normalizedEmail: string) => ActiveAccountResult
  createPasswordResetToken: (accountId: string) => CreateTokenResult
  revokePasswordResetToken: (tokenId: string) => RevokeTokenResult
  consumePasswordResetTokenAndChangePassword: (input: ConsumeInput) => ConsumeResult
  checkAndRecordRateLimit: (input: RateLimitInput) => RateLimitResult
  close: () => void
}

export type ActiveAccountResult =
  | { found: true; accountId: string; email: string }
  | { found: false }

export type CreateTokenResult =
  | { ok: true; tokenId: string; rawToken: string; expiresAt: string }
  | { ok: false; message: string }

export type RevokeTokenResult =
  | { ok: true; revoked: true }
  | { ok: true; revoked: false }
  | { ok: false; message: string }

export type ConsumeInput = {
  rawToken: string
  newPassword: string
}

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_password' | 'invalid_token' }

export type RateLimitInput = {
  scope: string
  rawSubject: string
  windowSeconds: number
  maxEvents: number
}

export type RateLimitResult =
  | { ok: true; limited: false }
  | { ok: true; limited: true }
  | { ok: false; message: string }

// ─── Internal row types ───────────────────────────────────────────────────────

type TokenRow = {
  token_id: string
  account_id: string
  expires_at: string
  used_at: string | null
  revoked_at: string | null
}

type AccountStatusRow = {
  status: string
}

// ─── Cleanup thresholds ───────────────────────────────────────────────────────

// Изтрива употребени/обезсилени/изтекли token-и, по-стари от 7 дни.
const CLEANUP_TOKEN_OLDER_THAN_DAYS = 7

// Rate-limit event retention: пазим events за 48 часа.
// Избрано да е по-дълго от всеки реален rate-limit прозорец (max очакван: 1 час).
// Ако бъде конфигуриран прозорец > 48 часа, трябва да се увеличи тази стойност.
const CLEANUP_RATE_LIMIT_RETENTION_SECONDS = 48 * 60 * 60

// ─── Factory ──────────────────────────────────────────────────────────────────

export async function createPasswordResetStore(
  databaseFilePath: string,
  options: PasswordResetStoreOptions,
): Promise<PasswordResetStore> {
  if (!validateRateLimitSecret(options.rateLimitHashSecret)) {
    throw new Error(
      'createPasswordResetStore: rateLimitHashSecret must be at least 32 characters. ' +
      'Set PASSWORD_RESET_RATE_LIMIT_SECRET in env.',
    )
  }

  const secret = options.rateLimitHashSecret

  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  // ─── Prepared statements ───────────────────────────────────────────────────

  const selectActiveAccountByEmailStmt = database.prepare(`
    SELECT account_id, email
    FROM accounts
    WHERE email = ?
      AND status = 'active'
    LIMIT 1;
  `)

  const selectTokenByHashStmt = database.prepare(`
    SELECT
      prt.token_id,
      prt.account_id,
      prt.expires_at,
      prt.used_at,
      prt.revoked_at
    FROM password_reset_tokens prt
    WHERE prt.token_hash = ?
    LIMIT 1;
  `)

  const selectAccountStatusStmt = database.prepare(`
    SELECT status
    FROM accounts
    WHERE account_id = ?
    LIMIT 1;
  `)

  const revokeAllActiveTokensForAccountStmt = database.prepare(`
    UPDATE password_reset_tokens
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE account_id = ?
      AND used_at IS NULL
      AND revoked_at IS NULL;
  `)

  const insertTokenStmt = database.prepare(`
    INSERT INTO password_reset_tokens (
      token_id,
      account_id,
      token_hash,
      expires_at
    ) VALUES (?, ?, ?, datetime('now', '+30 minutes'));
  `)

  const selectExpiresAtStmt = database.prepare(`
    SELECT expires_at FROM password_reset_tokens WHERE token_id = ? LIMIT 1;
  `)

  const revokeTokenByIdStmt = database.prepare(`
    UPDATE password_reset_tokens
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE token_id = ?
      AND used_at IS NULL
      AND revoked_at IS NULL;
  `)

  // Conditional update — гарантира еднократна употреба дори при race condition.
  // Само първият успешен UPDATE (changes === 1) продължава напред.
  const consumeTokenStmt = database.prepare(`
    UPDATE password_reset_tokens
    SET used_at = CURRENT_TIMESTAMP
    WHERE token_id = ?
      AND used_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP;
  `)

  const updatePasswordHashStmt = database.prepare(`
    UPDATE accounts
    SET password_hash = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE account_id = ?;
  `)

  const revokeAllSessionsStmt = database.prepare(`
    UPDATE account_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE account_id = ?
      AND revoked_at IS NULL;
  `)

  const cleanupOldTokensStmt = database.prepare(`
    DELETE FROM password_reset_tokens
    WHERE (used_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= CURRENT_TIMESTAMP)
      AND created_at <= datetime('now', '-${CLEANUP_TOKEN_OLDER_THAN_DAYS} days');
  `)

  const countRateLimitEventsStmt = database.prepare(`
    SELECT COUNT(*) AS cnt
    FROM password_reset_rate_limit_events
    WHERE scope = ?
      AND subject_hash = ?
      AND created_at > datetime('now', ? || ' seconds');
  `)

  const insertRateLimitEventStmt = database.prepare(`
    INSERT INTO password_reset_rate_limit_events (event_id, scope, subject_hash)
    VALUES (?, ?, ?);
  `)

  const cleanupRateLimitEventsStmt = database.prepare(`
    DELETE FROM password_reset_rate_limit_events
    WHERE created_at <= datetime('now', '-${CLEANUP_RATE_LIMIT_RETENTION_SECONDS} seconds');
  `)

  // ─── Operations ───────────────────────────────────────────────────────────

  function findActiveAccountByNormalizedEmail(normalizedEmail: string): ActiveAccountResult {
    const row = selectActiveAccountByEmailStmt.get(normalizedEmail) as
      | { account_id: string; email: string }
      | undefined

    if (!row) return { found: false }
    return { found: true, accountId: row.account_id, email: row.email }
  }

  function createPasswordResetToken(accountId: string): CreateTokenResult {
    try {
      database.exec('BEGIN IMMEDIATE;')

      // Opportunistic cleanup на стари token-и (не засяга активни).
      cleanupOldTokensStmt.run()

      // Обезсилване на всички предишни активни token-и за акаунта.
      revokeAllActiveTokensForAccountStmt.run(accountId)

      // Генериране на нов token — raw token съществува само в паметта и в имейла.
      const tokenId = generateUUID()
      const rawToken = generateRawResetToken()
      const tokenHash = hashResetToken(rawToken)

      insertTokenStmt.run(tokenId, accountId, tokenHash)

      // Прочитаме expires_at от базата в рамките на транзакцията.
      const inserted = selectExpiresAtStmt.get(tokenId) as { expires_at: string } | undefined

      database.exec('COMMIT;')

      return { ok: true, tokenId, rawToken, expiresAt: inserted?.expires_at ?? '' }
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch { /* ignore rollback failure */ }
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message }
    }
  }

  function revokePasswordResetToken(tokenId: string): RevokeTokenResult {
    try {
      const result = revokeTokenByIdStmt.run(tokenId) as { changes: number }
      return { ok: true, revoked: result.changes === 1 }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message }
    }
  }

  function consumePasswordResetTokenAndChangePassword(input: ConsumeInput): ConsumeResult {
    if (!validatePassword(input.newPassword)) {
      return { ok: false, reason: 'invalid_password' }
    }

    const tokenHash = hashResetToken(input.rawToken)

    try {
      database.exec('BEGIN IMMEDIATE;')

      // 1. Намираме token-а (без WHERE filтри — ще проверим ред по ред).
      const tokenRow = selectTokenByHashStmt.get(tokenHash) as TokenRow | undefined

      if (!tokenRow) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'invalid_token' }
      }

      // 2. Проверка за статус на акаунта.
      const accountRow = selectAccountStatusStmt.get(tokenRow.account_id) as AccountStatusRow | undefined
      if (!accountRow || accountRow.status !== 'active') {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'invalid_token' }
      }

      // 3. Conditional consume UPDATE — race protection.
      //    Проверява used_at IS NULL, revoked_at IS NULL, expires_at > CURRENT_TIMESTAMP.
      //    При два паралелни опита само един получава changes === 1.
      const consumeResult = consumeTokenStmt.run(tokenRow.token_id) as { changes: number }
      if (consumeResult.changes !== 1) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'invalid_token' }
      }

      // 4. Генерираме новия hash едва след успешен consume.
      const newHash = createPasswordHash(input.newPassword)

      // 5. UPDATE accounts.
      const accountUpdate = updatePasswordHashStmt.run(newHash, tokenRow.account_id) as { changes: number }
      if (accountUpdate.changes !== 1) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'invalid_token' }
      }

      // 6. Прекратяване на всички активни сесии.
      revokeAllSessionsStmt.run(tokenRow.account_id)

      // 7. Обезсилване на всички останали неизползвани token-и за акаунта.
      revokeAllActiveTokensForAccountStmt.run(tokenRow.account_id)

      // 8. COMMIT.
      database.exec('COMMIT;')
      return { ok: true }
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch { /* ignore rollback failure */ }
      return { ok: false, reason: 'invalid_token' }
    }
  }

  function checkAndRecordRateLimit(input: RateLimitInput): RateLimitResult {
    // HMAC-SHA256 с domain separation — защитава срещу offline guessing на IPv4.
    const subjectHash = hmacRateLimitSubject(input.scope, input.rawSubject, secret)
    const windowSecondsStr = `-${input.windowSeconds}`

    try {
      database.exec('BEGIN IMMEDIATE;')

      // Opportunistic cleanup: изтриваме events по-стари от retention прозореца.
      // Retention (48h) е по-дълъг от всеки реален rate-limit прозорец.
      cleanupRateLimitEventsStmt.run()

      // Брой events в прозореца за scope + subject.
      const countRow = countRateLimitEventsStmt.get(
        input.scope,
        subjectHash,
        windowSecondsStr,
      ) as { cnt: number } | undefined

      const count = countRow?.cnt ?? 0

      if (count >= input.maxEvents) {
        database.exec('ROLLBACK;')
        return { ok: true, limited: true }
      }

      // Записваме event — само UUID, scope, subject_hash и created_at (auto).
      // Raw subject (IP/email) никога не се записва.
      insertRateLimitEventStmt.run(randomUUID(), input.scope, subjectHash)

      database.exec('COMMIT;')
      return { ok: true, limited: false }
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch { /* ignore rollback failure */ }
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message }
    }
  }

  function close(): void {
    database.close()
  }

  return {
    findActiveAccountByNormalizedEmail,
    createPasswordResetToken,
    revokePasswordResetToken,
    consumePasswordResetTokenAndChangePassword,
    checkAndRecordRateLimit,
    close,
  }
}
