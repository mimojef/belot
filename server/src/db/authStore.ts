import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import type { AccountId, PlayerPublicProfileSnapshot, ProfileId } from '../core/serverTypes.js'
import {
  createPasswordHash,
  normalizeEmail,
  validatePassword,
  verifyPassword,
} from './authHelpers.js'
import { validateProfileDisplayName } from './normalizeProfileIdentityText.js'
import type { PlayerProgressStore } from './playerProgressStore.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type AccountRoleValue = 'player' | 'chat_admin' | 'pika_team' | 'subadmin' | 'admin'

export type AuthAccountSnapshot = {
  accountId: AccountId
  email: string
  role: AccountRoleValue
  status: 'active' | 'disabled'
  createdAt: string
}

export type AuthSessionSnapshot = {
  sessionId: string
  account: AuthAccountSnapshot
  profile: PlayerPublicProfileSnapshot
}

/**
 * Пълен администратор — единствената роля с достъп до "Настройки",
 * редакция/модериране на профили, чат с поддръжката и управление на роли.
 *
 * Type predicate (не просто boolean) — след `if (!isFullAdminSession(session)) return`
 * TypeScript стеснява `session` до non-null за остатъка от функцията, точно
 * както правеше досегашният inline `session === null || session.account.role !== 'admin'`.
 */
export function isFullAdminSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && session.account.role === 'admin'
}

/**
 * Read-only административен достъп ("Информация" / "Сървър") —
 * субадмин ИЛИ пълен администратор. Виж isFullAdminSession за защо е type predicate.
 */
export function isAdminOrSubadminSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && (session.account.role === 'admin' || session.account.role === 'subadmin')
}

/**
 * Единственото право на chat_admin: изтриване на съобщения от общия лайв чат
 * в лобито. НЕ дава достъп до нищо друго — admin/subadmin/chat_admin,
 * нищо повече (никакви други "OR" комбинации с chat_admin другаде в кода).
 */
export function isLobbyChatModeratorSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'subadmin'
    || session.account.role === 'chat_admin'
    || session.account.role === 'pika_team'
  )
}

export type ElevatedRole = 'subadmin' | 'chat_admin' | 'pika_team'

export type SubadminRoleChangeErrorCode =
  | 'not_found'
  | 'no_account'
  | 'self'
  | 'target_is_admin'
  | 'conflict'
  | 'profile_inactive'
  | 'profile_temporary'
  | 'account_inactive'

export type SubadminRoleChangeResult =
  | { ok: true; role: 'subadmin' | 'player' }
  | { ok: false; code: SubadminRoleChangeErrorCode; message: string }

export type ChatAdminRoleChangeErrorCode = SubadminRoleChangeErrorCode

export type ChatAdminRoleChangeResult =
  | { ok: true; role: 'chat_admin' | 'player' }
  | { ok: false; code: ChatAdminRoleChangeErrorCode; message: string }

export type PikaTeamRoleChangeErrorCode = SubadminRoleChangeErrorCode

export type PikaTeamRoleChangeResult =
  | { ok: true; role: 'pika_team' | 'player' }
  | { ok: false; code: PikaTeamRoleChangeErrorCode; message: string }

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
  changePassword: (input: {
    accountId: string
    currentPassword: string
    newPassword: string
  }) => { ok: true } | { ok: false; message: string }
  getSession: (sessionToken: string | null) => AuthSessionSnapshot | null
  logout: (sessionToken: string | null) => void
  /**
   * Назначава/премахва субадмин роля за профила зад `targetProfileId`.
   * Ролята принадлежи на АКАУНТА (не профила) — виж AccountRow.role.
   * Атомарно: role UPDATE + admin_role_audit_log INSERT в една транзакция.
   * Идемпотентно: повторно грантване на вече-субадмин (или повторно
   * revoke на вече-player) връща ok:true без нов audit ред.
   * Ако акаунтът в момента е chat_admin, grant('subadmin') го ПРЕВКЛЮЧВА
   * директно на subadmin (chat_admin/subadmin са взаимно изключващи се);
   * revoke('subadmin'), докато акаунтът реално е chat_admin, се отказва
   * ('conflict') — не пипа чуждата роля по подразбиране.
   */
  setSubadminRole: (input: {
    actorAccountId: string
    targetProfileId: string
    action: 'grant' | 'revoke'
  }) => SubadminRoleChangeResult
  /** Огледално на setSubadminRole, но за chat_admin роля — виж коментара там. */
  setChatAdminRole: (input: {
    actorAccountId: string
    targetProfileId: string
    action: 'grant' | 'revoke'
  }) => ChatAdminRoleChangeResult
  setPikaTeamRole: (input: {
    actorAccountId: string
    targetProfileId: string
    action: 'grant' | 'revoke'
  }) => PikaTeamRoleChangeResult
  /** Роля на акаунта зад даден профил — само за UI показване (badge), null ако профилът няма акаунт (бот/гост/изтрит). */
  getAccountRoleForProfile: (profileId: string) => AccountRoleValue | null
  close: () => void
}

type CreateAuthStoreOptions = {
  getSignupBonusYellowCoins?: () => number
}

type AccountRow = {
  account_id: string
  email: string
  password_hash: string
  role: AccountRoleValue
  status: 'active' | 'disabled'
  created_at: string
}

type SessionRow = {
  session_id: string
  account_id: string
  profile_id: string
  email: string
  role: AccountRoleValue
  status: 'active' | 'disabled'
  account_created_at: string
}

const SESSION_COOKIE_NAME = 'belot_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30

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
  const createdAt = 'account_created_at' in row ? row.account_created_at : row.created_at
  return {
    accountId: row.account_id,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt,
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
      a.status,
      a.created_at AS account_created_at
    FROM account_sessions s
    JOIN accounts a
      ON a.account_id = s.account_id
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > CURRENT_TIMESTAMP
    LIMIT 1;
  `)

  const selectAccountByIdStatement = database.prepare(`
    SELECT account_id, email, password_hash, role, status, created_at
    FROM accounts
    WHERE account_id = ?
    LIMIT 1;
  `)

  // status/is_temporary се ползват само от setSubadminRole (grant eligibility) —
  // getAccountRoleForProfile чете единствено account_id и игнорира останалото.
  const selectProfileRoleEligibilityStatement = database.prepare(`
    SELECT account_id, status, is_temporary
    FROM profiles
    WHERE profile_id = ?
    LIMIT 1;
  `)

  const conditionalUpdateAccountRoleStatement = database.prepare(`
    UPDATE accounts
    SET role = ?, updated_at = CURRENT_TIMESTAMP
    WHERE account_id = ?
      AND role = ?;
  `)

  const insertAdminRoleAuditLogStatement = database.prepare(`
    INSERT INTO admin_role_audit_log (
      log_id,
      actor_account_id,
      target_account_id,
      action,
      previous_role,
      new_role
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    );
  `)

  const updatePasswordHashStatement = database.prepare(`
    UPDATE accounts
    SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
    WHERE account_id = ?;
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
    const displayNameResult = validateProfileDisplayName(input.displayName)

    if (email === null) {
      return { ok: false, message: 'Невалиден email адрес.' }
    }

    if (!validatePassword(input.password)) {
      return { ok: false, message: 'Паролата трябва да е поне 6 символа.' }
    }

    if (!displayNameResult.ok) {
      return { ok: false, message: displayNameResult.message }
    }

    const existingAccount = selectAccountByEmailStatement.get(email) as AccountRow | undefined

    if (existingAccount) {
      return { ok: false, message: 'Вече има регистрация с този email.' }
    }

    const accountId = randomUUID()
    const profileId = randomUUID()
    const displayName = displayNameResult.canonicalDisplayName
    const normalizedDisplayName = displayNameResult.normalizedKey
    const normalizedUsername = normalizedDisplayName
    const passwordHash = createPasswordHash(input.password)

    try {
      database.exec('BEGIN IMMEDIATE;')

      const nameConflict = database.prepare(`
        SELECT profile_id FROM profiles
        WHERE status = 'active'
          AND (normalized_display_name = ? OR normalized_username = ?)
        LIMIT 1;
      `).get(normalizedDisplayName, normalizedUsername) as { profile_id: string } | undefined

      if (nameConflict !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, message: 'Това име вече е заето.' }
      }

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
        created_at: new Date().toISOString(),
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

      if (
        message.includes('normalized_display_name') ||
        message.includes('normalized_username')
      ) {
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

  function changePassword(input: {
    accountId: string
    currentPassword: string
    newPassword: string
  }): { ok: true } | { ok: false; message: string } {
    const account = selectAccountByIdStatement.get(input.accountId) as AccountRow | undefined

    if (!account) {
      return { ok: false, message: 'Профилът не беше намерен.' }
    }

    if (!verifyPassword(input.currentPassword, account.password_hash)) {
      return { ok: false, message: 'Грешна текуща парола.' }
    }

    if (!validatePassword(input.newPassword)) {
      return { ok: false, message: 'Новата парола трябва да е поне 6 символа.' }
    }

    const newHash = createPasswordHash(input.newPassword)
    updatePasswordHashStatement.run(newHash, input.accountId)

    return { ok: true }
  }

  function logout(sessionToken: string | null): void {
    if (sessionToken === null) {
      return
    }

    revokeSessionStatement.run(hashSessionToken(sessionToken))
  }

  function getAccountRoleForProfile(profileId: string): AccountRoleValue | null {
    const profileRow = selectProfileRoleEligibilityStatement.get(profileId) as
      | { account_id: string | null }
      | undefined

    if (!profileRow || profileRow.account_id === null) {
      return null
    }

    const accountRow = selectAccountByIdStatement.get(profileRow.account_id) as AccountRow | undefined
    return accountRow?.role ?? null
  }

  /**
   * Споделена имплементация за setSubadminRole/setChatAdminRole — двете
   * "елевирани" роли (subadmin, chat_admin) са взаимно изключващи се и имат
   * идентични защити (self/target-is-admin/grant-eligibility/idempotency/audit),
   * разликата е само коя стойност се пише в role колоната.
   *
   * fromRole се чете от РЕАЛНАТА текуща роля на акаунта (не се хардкодва
   * 'player'), за да поддържа директно превключване между subadmin ↔
   * chat_admin (grant на едната, докато акаунтът е другата, просто я
   * заменя — единична role колона, няма нужда от изричен revoke стъпка).
   * REVOKE изисква текущата роля да съвпада точно с input.role — опит за
   * revoke на роля, която акаунтът реално няма (напр. "revoke chat_admin"
   * върху subadmin акаунт), се отказва с 'conflict', вместо тихо да пипне
   * другата роля.
   */
  function changeElevatedRole(input: {
    actorAccountId: string
    targetProfileId: string
    role: ElevatedRole
    action: 'grant' | 'revoke'
  }): { ok: true; role: 'player' | ElevatedRole } | { ok: false; code: SubadminRoleChangeErrorCode; message: string } {
    const profileRow = selectProfileRoleEligibilityStatement.get(input.targetProfileId) as
      | { account_id: string | null; status: 'active' | 'disabled'; is_temporary: number }
      | undefined

    if (!profileRow) {
      return { ok: false, code: 'not_found', message: 'Профилът не беше намерен.' }
    }

    const targetAccountId = profileRow.account_id

    if (targetAccountId === null) {
      return {
        ok: false,
        code: 'no_account',
        message: 'Този потребител няма регистриран акаунт и не може да получи административна роля.',
      }
    }

    if (targetAccountId === input.actorAccountId) {
      return { ok: false, code: 'self', message: 'Не можеш да промениш собствената си роля.' }
    }

    const targetAccount = selectAccountByIdStatement.get(targetAccountId) as AccountRow | undefined

    if (!targetAccount) {
      return { ok: false, code: 'not_found', message: 'Акаунтът не беше намерен.' }
    }

    if (targetAccount.role === 'admin') {
      return {
        ok: false,
        code: 'target_is_admin',
        message: 'Не можеш да промениш ролята на друг администратор.',
      }
    }

    // Одобрено продуктово решение: елевирана роля може да бъде НАЗНАЧЕНА само
    // на активен, постоянен човешки профил със свързан активен акаунт. REVOKE
    // остава разрешен независимо от статуса — пълният admin трябва винаги
    // да може да премахне правата, дори ако профилът/акаунтът вече е
    // деактивиран междувременно. Автоматично отнемане при деактивиране НЕ се
    // прави тук — извън обхвата на тази проверка (умишлено, отделно решение).
    // Проверките важат безусловно за всеки grant (дори "идемпотентен" повторен
    // grant на вече-същата роля) — запазва точното досегашно поведение.
    if (input.action === 'grant') {
      if (profileRow.is_temporary === 1) {
        return {
          ok: false,
          code: 'profile_temporary',
          message: `Не можеш да направиш временен профил ${
            input.role === 'chat_admin' ? 'чат админ' : input.role === 'pika_team' ? 'Екип Pika.bg' : 'субадмин'
          }.`,
        }
      }

      if (profileRow.status !== 'active') {
        return {
          ok: false,
          code: 'profile_inactive',
          message: `Не можеш да направиш неактивен профил ${
            input.role === 'chat_admin' ? 'чат админ' : input.role === 'pika_team' ? 'Екип Pika.bg' : 'субадмин'
          }.`,
        }
      }

      if (targetAccount.status !== 'active') {
        return {
          ok: false,
          code: 'account_inactive',
          message: `Не можеш да направиш неактивен акаунт ${
            input.role === 'chat_admin' ? 'чат админ' : input.role === 'pika_team' ? 'Екип Pika.bg' : 'субадмин'
          }.`,
        }
      }
    }

    const currentRole = targetAccount.role

    if (input.action === 'grant' && currentRole === input.role) {
      // Идемпотентно повторение — вече е в желаната роля, без нов audit ред.
      return { ok: true, role: input.role }
    }

    if (input.action === 'revoke' && currentRole === 'player') {
      // Идемпотентно повторение — вече е обикновен player.
      return { ok: true, role: 'player' }
    }

    if (input.action === 'revoke' && currentRole !== input.role) {
      // Акаунтът реално има ДРУГАТА елевирана роля (напр. опит за
      // "revoke chat_admin" върху subadmin акаунт) — отказваме, не пипаме
      // чуждата роля мълчаливо.
      return {
        ok: false,
        code: 'conflict',
        message: 'Ролята на потребителя е променена междувременно. Презареди и опитай пак.',
      }
    }

    const fromRole = currentRole
    const toRole: 'player' | ElevatedRole = input.action === 'grant' ? input.role : 'player'
    const auditAction = `${input.action}_${input.role}` as
      | 'grant_subadmin' | 'revoke_subadmin'
      | 'grant_chat_admin' | 'revoke_chat_admin'
      | 'grant_pika_team' | 'revoke_pika_team'

    database.exec('BEGIN IMMEDIATE;')

    try {
      const changeResult = conditionalUpdateAccountRoleStatement.run(toRole, targetAccountId, fromRole)

      if (changeResult.changes === 0) {
        // Състоянието се е променило между прочита по-горе и тази транзакция
        // (race) — прочитаме текущата роля вътре в същата транзакция, за да
        // върнем коректен резултат без частична промяна в базата.
        const currentAccount = selectAccountByIdStatement.get(targetAccountId) as AccountRow
        database.exec('ROLLBACK;')

        if (currentAccount.role === toRole) {
          return { ok: true, role: toRole }
        }

        if (currentAccount.role === 'admin') {
          return {
            ok: false,
            code: 'target_is_admin',
            message: 'Не можеш да промениш ролята на друг администратор.',
          }
        }

        return {
          ok: false,
          code: 'conflict',
          message: 'Ролята на потребителя е променена междувременно. Презареди и опитай пак.',
        }
      }

      insertAdminRoleAuditLogStatement.run(
        randomUUID(),
        input.actorAccountId,
        targetAccountId,
        auditAction,
        fromRole,
        toRole,
      )

      database.exec('COMMIT;')

      return { ok: true, role: toRole }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // ignore rollback failure and surface the original error
      }

      throw error
    }
  }

  function setSubadminRole(input: {
    actorAccountId: string
    targetProfileId: string
    action: 'grant' | 'revoke'
  }): SubadminRoleChangeResult {
    return changeElevatedRole({ ...input, role: 'subadmin' }) as SubadminRoleChangeResult
  }

  function setChatAdminRole(input: {
    actorAccountId: string
    targetProfileId: string
    action: 'grant' | 'revoke'
  }): ChatAdminRoleChangeResult {
    return changeElevatedRole({ ...input, role: 'chat_admin' }) as ChatAdminRoleChangeResult
  }

  function setPikaTeamRole(input: {
    actorAccountId: string
    targetProfileId: string
    action: 'grant' | 'revoke'
  }): PikaTeamRoleChangeResult {
    return changeElevatedRole({ ...input, role: 'pika_team' }) as PikaTeamRoleChangeResult
  }

  function close(): void {
    database.close()
  }

  return {
    register,
    login,
    changePassword,
    getSession,
    logout,
    setSubadminRole,
    setChatAdminRole,
    setPikaTeamRole,
    getAccountRoleForProfile,
    close,
  }
}
