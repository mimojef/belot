import { createPasswordHash, verifyPassword } from './authHelpers.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type TournamentBetaAccessStatus = {
  enabled: boolean
  hasPassword: boolean
  passwordVersion: number
  validGrantsCount: number
  updatedAt: string
}

export type TournamentBetaAccessPublicInfo = {
  enabled: boolean
  hasAccess: boolean
}

export type SetTournamentBetaPasswordResult =
  | { ok: true; passwordVersion: number }
  | { ok: false; reason: 'invalid_password' }

export type EnableTournamentBetaGateResult =
  | { ok: true }
  | { ok: false; reason: 'no_password_configured' }

export type SubmitTournamentBetaPasswordResult =
  | { ok: true }
  | { ok: false; reason: 'not_enabled' | 'no_password_configured' | 'wrong_password' | 'invalid_password' }

export type TournamentBetaAccessStore = {
  /**
   * Единствен authoritative gate check — консумира се от ВСЕКИ human-facing
   * tournament HTTP/WS entry point (виж requireTournamentBetaAccess в
   * index.ts). Директен SQL read всеки път (без in-memory cache), за да
   * важат CLI enable/disable/password промени веднага, без restart (виж
   * task spec "Не кеширай beta config по начин, който изисква restart").
   */
  hasAccess: (profileId: string | null) => boolean
  getPublicInfo: (profileId: string | null) => TournamentBetaAccessPublicInfo
  submitPassword: (profileId: string, password: string) => SubmitTournamentBetaPasswordResult
  getStatus: () => TournamentBetaAccessStatus
  enable: () => EnableTournamentBetaGateResult
  disable: () => void
  setPassword: (password: string) => SetTournamentBetaPasswordResult
  close: () => void
}

type ConfigRow = {
  enabled: number
  password_hash: string | null
  password_version: number
  updated_at: string
}

const BETA_PASSWORD_MIN_LENGTH = 4
const BETA_PASSWORD_MAX_LENGTH = 256

function isValidBetaPasswordShape(password: string): boolean {
  return (
    typeof password === 'string' &&
    password.length >= BETA_PASSWORD_MIN_LENGTH &&
    password.length <= BETA_PASSWORD_MAX_LENGTH
  )
}

export async function createTournamentBetaAccessStore(
  databaseFilePath: string,
): Promise<TournamentBetaAccessStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const selectConfigStatement = database.prepare(`
    SELECT enabled, password_hash, password_version, updated_at
    FROM tournament_beta_access_config
    WHERE row_id = 'singleton';
  `)

  const updateConfigStatement = database.prepare(`
    UPDATE tournament_beta_access_config
    SET enabled = ?, password_hash = ?, password_version = ?, updated_at = CURRENT_TIMESTAMP
    WHERE row_id = 'singleton';
  `)

  const selectGrantStatement = database.prepare(`
    SELECT password_version
    FROM tournament_beta_access_grants
    WHERE profile_id = ?;
  `)

  const upsertGrantStatement = database.prepare(`
    INSERT INTO tournament_beta_access_grants (profile_id, password_version)
    VALUES (?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET
      password_version = excluded.password_version,
      granted_at = CURRENT_TIMESTAMP;
  `)

  const countValidGrantsStatement = database.prepare(`
    SELECT COUNT(*) as count
    FROM tournament_beta_access_grants
    WHERE password_version = ?;
  `)

  function getConfig(): ConfigRow {
    const row = selectConfigStatement.get() as ConfigRow | undefined
    // Fallback за изолирана тестова база, seed-ната преди migration-а да е
    // приложена — fail-closed (enabled=0) е безопасно тук, защото 0
    // означава "gate-ът е disabled", не "всичко е позволено без проверка"
    // (виж hasAccess по-долу: enabled=false винаги връща true).
    return row ?? { enabled: 0, password_hash: null, password_version: 1, updated_at: new Date().toISOString() }
  }

  function hasValidGrant(profileId: string, passwordVersion: number): boolean {
    const row = selectGrantStatement.get(profileId) as { password_version: number } | undefined
    return row !== undefined && row.password_version === passwordVersion
  }

  function hasAccess(profileId: string | null): boolean {
    const config = getConfig()
    if (config.enabled !== 1) return true
    if (profileId === null) return false
    return hasValidGrant(profileId, config.password_version)
  }

  function getPublicInfo(profileId: string | null): TournamentBetaAccessPublicInfo {
    const config = getConfig()
    const enabled = config.enabled === 1
    return {
      enabled,
      hasAccess: !enabled || (profileId !== null && hasValidGrant(profileId, config.password_version)),
    }
  }

  function submitPassword(profileId: string, password: string): SubmitTournamentBetaPasswordResult {
    if (!isValidBetaPasswordShape(password)) {
      return { ok: false, reason: 'invalid_password' }
    }

    const config = getConfig()
    if (config.enabled !== 1) {
      return { ok: false, reason: 'not_enabled' }
    }
    if (config.password_hash === null) {
      return { ok: false, reason: 'no_password_configured' }
    }

    if (!verifyPassword(password, config.password_hash)) {
      return { ok: false, reason: 'wrong_password' }
    }

    upsertGrantStatement.run(profileId, config.password_version)
    return { ok: true }
  }

  function getStatus(): TournamentBetaAccessStatus {
    const config = getConfig()
    const validGrants = countValidGrantsStatement.get(config.password_version) as { count: number }
    return {
      enabled: config.enabled === 1,
      hasPassword: config.password_hash !== null,
      passwordVersion: config.password_version,
      validGrantsCount: validGrants.count,
      updatedAt: config.updated_at,
    }
  }

  function enable(): EnableTournamentBetaGateResult {
    const config = getConfig()
    if (config.password_hash === null) {
      return { ok: false, reason: 'no_password_configured' }
    }
    updateConfigStatement.run(1, config.password_hash, config.password_version)
    return { ok: true }
  }

  function disable(): void {
    const config = getConfig()
    updateConfigStatement.run(0, config.password_hash, config.password_version)
  }

  function setPassword(password: string): SetTournamentBetaPasswordResult {
    if (!isValidBetaPasswordShape(password)) {
      return { ok: false, reason: 'invalid_password' }
    }
    const config = getConfig()
    const nextVersion = config.password_version + 1
    const hash = createPasswordHash(password)
    // enabled state непроменено тук нарочно — смяна на паролата не трябва
    // сама по себе си да enable-ва gate-а, ако е бил disabled (и обратно).
    // Old grants стават невалидни автоматично чрез version mismatch, без да
    // се трие физически tournament_beta_access_grants (виж task spec DB
    // DESIGN "Не е задължително физически да delete-ваш старите grant rows").
    updateConfigStatement.run(config.enabled, hash, nextVersion)
    return { ok: true, passwordVersion: nextVersion }
  }

  function close(): void {
    database.close()
  }

  return {
    hasAccess,
    getPublicInfo,
    submitPassword,
    getStatus,
    enable,
    disable,
    setPassword,
    close,
  }
}
