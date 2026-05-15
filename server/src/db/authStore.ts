import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type { AccountId, PlayerPublicProfileSnapshot, ProfileId } from '../core/serverTypes.js'
import { normalizeProfileDisplayName, normalizeProfileUsername } from './normalizeProfileIdentityText.js'
import type { PlayerProgressStore } from './playerProgressStore.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type AuthAccountSnapshot = {
  accountId: AccountId
  email: string
  role: 'player' | 'admin'
  status: 'active' | 'disabled'
}

export type AuthSessionSnapshot = {
  sessionId: string
  account: AuthAccountSnapshot
  profile: PlayerPublicProfileSnapshot
}

export type AuthStore = {
  register: (input: {
    email: string
    password: string
    displayName: string
    gender?: 'male' | 'female' | null
  }) => { ok: true; sessionToken: string; session: AuthSessionSnapshot } | { ok: false; message: string }
  login: (input: {
    email: string
    password: string
  }) => { ok: true; sessionToken: string; session: AuthSessionSnapshot } | { ok: false; message: string }
  getSession: (sessionToken: string | null) => AuthSessionSnapshot | null
  logout: (sessionToken: string | null) => void
  close: () => void
}

type CreateAuthStoreOptions = {
  getSignupBonusYellowCoins?: () => number
}

type AccountRow = {
  account_id: string
  email: string
  password_hash: string
  role: 'player' | 'admin'
  status: 'active' | 'disabled'
}

type SessionRow = {
  session_id: string
  account_id: string
  profile_id: string
  email: string
  role: 'player' | 'admin'
  status: 'active' | 'disabled'
}

const SESSION_COOKIE_NAME = 'belot_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30
const PASSWORD_MIN_LENGTH = 6
const SCRYPT_KEY_LENGTH = 64

function normalizeEmail(value: string): string | null {
  const trimmed = value.trim().toLocaleLowerCase('en-US')

  if (!trimmed || !trimmed.includes('@') || trimmed.length > 254) {
    return null
  }

  return trimmed
}

function validatePassword(value: string): boolean {
  return value.length >= PASSWORD_MIN_LENGTH && value.length <= 256
}

function createPasswordHash(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('hex')

  return `scrypt:${salt}:${hash}`
}

function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':')

  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false
  }

  const [, salt, expectedHashHex] = parts

  if (!salt || !expectedHashHex) {
    return false
  }

  const actualHash = scryptSync(password, salt, SCRYPT_KEY_LENGTH)
  const expectedHash = Buffer.from(expectedHashHex, 'hex')

  if (actualHash.length !== expectedHash.length) {
    return false
  }

  return timingSafeEqual(actualHash, expectedHash)
}

function createSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

function hashSessionToken(token: string): string {
  return scryptSync(token, 'belot-v2-session-v1', 32).toString('hex')
}

function createCookieExpiresAt(): Date {
  return new Date(Date.now() + SESSION_TTL_MS)
}

function createIsoExpiresAt(): string {
  return createCookieExpiresAt().toISOString()
}

export function createSessionCookieHeader(sessionToken: string): string {
  return [
    `${SESSION_COOKIE_NAME}=${sessionToken}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ].join('; ')
}

export function createClearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export function getSessionTokenFromCookieHeader(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null
  }

  const cookies = cookieHeader.split(';')

  for (const cookie of cookies) {
    const [rawName, ...rawValueParts] = cookie.trim().split('=')

    if (rawName === SESSION_COOKIE_NAME) {
      return rawValueParts.join('=') || null
    }
  }

  return null
}

function toAccountSnapshot(row: AccountRow | SessionRow): AuthAccountSnapshot {
  return {
    accountId: row.account_id,
    email: row.email,
    role: row.role,
    status: row.status,
  }
}

export async function createAuthStore(
  databaseFilePath: string,
  playerProgressStore: PlayerProgressStore,
  options: CreateAuthStoreOptions = {},
): Promise<AuthStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const selectAccountByEmailStatement = database.prepare(`
    SELECT account_id, email, password_hash, role, status
    FROM accounts
    WHERE email = ?
    LIMIT 1;
  `)

  const insertAccountStatement = database.prepare(`
    INSERT INTO accounts (
      account_id,
      email,
      password_hash,
      role,
      status
    ) VALUES (
      ?,
      ?,
      ?,
      'player',
      'active'
    );
  `)

  const insertProfileStatement = database.prepare(`
    INSERT INTO profiles (
      profile_id,
      account_id,
      profile_kind,
      username,
      normalized_username,
      display_name,
      normalized_display_name,
      avatar_url,
      level,
      rank_title,
      skill_rating,
      gender,
      status
    ) VALUES (
      ?,
      ?,
      'human',
      ?,
      ?,
      ?,
      ?,
      NULL,
      1,
      'Ранг 1',
      1000,
      ?,
      'active'
    );
  `)

  const insertWalletStatement = database.prepare(`
    INSERT INTO profile_wallets (
      profile_id,
      yellow_coins_balance
    ) VALUES (
      ?,
      ?
    );
  `)

  const insertProgressStatement = database.prepare(`
    INSERT INTO profile_progress (
      profile_id,
      completed_games_count,
      won_games_count,
      rank_level
    ) VALUES (
      ?,
      0,
      0,
      1
    );
  `)

  const insertSessionStatement = database.prepare(`
    INSERT INTO account_sessions (
      session_id,
      account_id,
      profile_id,
      token_hash,
      expires_at
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?
    );
  `)

  const selectSessionStatement = database.prepare(`
    SELECT
      s.session_id,
      s.account_id,
      s.profile_id,
      a.email,
      a.role,
      a.status
    FROM account_sessions s
    JOIN accounts a
      ON a.account_id = s.account_id
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > CURRENT_TIMESTAMP
    LIMIT 1;
  `)

  const revokeSessionStatement = database.prepare(`
    UPDATE account_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE token_hash = ?
      AND revoked_at IS NULL;
  `)

  const updateLastLoginStatement = database.prepare(`
    UPDATE accounts
    SET last_login_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE account_id = ?;
  `)

  function createSession(account: AccountRow | SessionRow, profileId: ProfileId): {
    sessionToken: string
    session: AuthSessionSnapshot
  } {
    const sessionToken = createSessionToken()
    const sessionId = randomUUID()

    insertSessionStatement.run(
      sessionId,
      account.account_id,
      profileId,
      hashSessionToken(sessionToken),
      createIsoExpiresAt(),
    )
    updateLastLoginStatement.run(account.account_id)

    const profile = playerProgressStore.getPublicProfile(profileId)

    if (profile === null) {
      throw new Error('Profile was not found after session creation.')
    }

    return {
      sessionToken,
      session: {
        sessionId,
        account: toAccountSnapshot(account),
        profile,
      },
    }
  }

  function register(input: {
    email: string
    password: string
    displayName: string
    gender?: 'male' | 'female' | null
  }): { ok: true; sessionToken: string; session: AuthSessionSnapshot } | { ok: false; message: string } {
    const email = normalizeEmail(input.email)
    const displayName = input.displayName.trim()
    const normalizedDisplayName = normalizeProfileDisplayName(displayName)

    if (email === null) {
      return { ok: false, message: 'Невалиден email адрес.' }
    }

    if (!validatePassword(input.password)) {
      return { ok: false, message: 'Паролата трябва да е поне 6 символа.' }
    }

    if (normalizedDisplayName === null) {
      return { ok: false, message: 'Въведи име в играта.' }
    }

    const existingAccount = selectAccountByEmailStatement.get(email) as AccountRow | undefined

    if (existingAccount) {
      return { ok: false, message: 'Вече има регистрация с този email.' }
    }

    const accountId = randomUUID()
    const profileId = randomUUID()
    const normalizedUsername = normalizeProfileUsername(displayName) ?? normalizedDisplayName
    const passwordHash = createPasswordHash(input.password)

    try {
      database.exec('BEGIN;')
      insertAccountStatement.run(accountId, email, passwordHash)
      const gender = input.gender === 'male' || input.gender === 'female' ? input.gender : null
      insertProfileStatement.run(
        profileId,
        accountId,
        displayName,
        normalizedUsername,
        displayName,
        normalizedDisplayName,
        gender,
      )
      insertWalletStatement.run(
        profileId,
        Math.max(0, Math.trunc(options.getSignupBonusYellowCoins?.() ?? 0)),
      )
      insertProgressStatement.run(profileId)
      database.exec('COMMIT;')

      const accountRow: AccountRow = {
        account_id: accountId,
        email,
        password_hash: passwordHash,
        role: 'player',
        status: 'active',
      }
      const session = createSession(accountRow, profileId)

      return {
        ok: true,
        ...session,
      }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // keep original error
      }

      const message = error instanceof Error ? error.message : String(error)

      if (message.includes('normalized_display_name')) {
        return { ok: false, message: 'Това име вече е заето.' }
      }

      return { ok: false, message: 'Регистрацията не беше успешна.' }
    }
  }

  function login(input: {
    email: string
    password: string
  }): { ok: true; sessionToken: string; session: AuthSessionSnapshot } | { ok: false; message: string } {
    const email = normalizeEmail(input.email)

    if (email === null) {
      return { ok: false, message: 'Невалиден email адрес.' }
    }

    const account = selectAccountByEmailStatement.get(email) as AccountRow | undefined

    if (!account || !verifyPassword(input.password, account.password_hash)) {
      return { ok: false, message: 'Грешен email или парола.' }
    }

    if (account.status !== 'active') {
      return { ok: false, message: 'Профилът е деактивиран.' }
    }

    const profileIdRow = database.prepare(`
      SELECT profile_id
      FROM profiles
      WHERE account_id = ?
        AND profile_kind = 'human'
      ORDER BY created_at ASC
      LIMIT 1;
    `).get(account.account_id) as { profile_id: string } | undefined

    if (!profileIdRow) {
      return { ok: false, message: 'Профилът не беше намерен.' }
    }

    return {
      ok: true,
      ...createSession(account, profileIdRow.profile_id),
    }
  }

  function getSession(sessionToken: string | null): AuthSessionSnapshot | null {
    if (sessionToken === null) {
      return null
    }

    const row = selectSessionStatement.get(hashSessionToken(sessionToken)) as SessionRow | undefined

    if (!row || row.status !== 'active') {
      return null
    }

    const profile = playerProgressStore.getPublicProfile(row.profile_id)

    if (profile === null) {
      return null
    }

    return {
      sessionId: row.session_id,
      account: toAccountSnapshot(row),
      profile,
    }
  }

  function logout(sessionToken: string | null): void {
    if (sessionToken === null) {
      return
    }

    revokeSessionStatement.run(hashSessionToken(sessionToken))
  }

  function close(): void {
    database.close()
  }

  return {
    register,
    login,
    getSession,
    logout,
    close,
  }
}
