import { isProtectedStaffRole } from '../core/protectedStaffProfiles.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export const BLOCK_LIMIT = 50

export type ToggleBlockResult =
  | { blocked: boolean; limitReached?: true; protectedStaffProfile?: undefined }
  | { blocked: false; protectedStaffProfile: true; limitReached?: undefined }

export type BlockStore = {
  isBlocked: (blockerProfileId: string, blockedProfileId: string) => boolean
  toggleBlock: (
    blockerProfileId: string,
    blockedProfileId: string,
  ) => ToggleBlockResult
  getBlockedProfileIds: (blockerProfileId: string) => string[]
  getBlockedCount: (blockerProfileId: string) => number
  close: () => void
}

export async function createBlockStore(databaseFilePath: string): Promise<BlockStore> {
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(databaseFilePath, { open: true }) as SqliteDatabase

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  // toggleBlock е BEGIN IMMEDIATE транзакция на тази връзка — изчаква (вместо
  // SQLITE_BUSY) чужд writer, напр. role promotion транзакцията в authStore.
  database.exec('PRAGMA busy_timeout = 5000;')

  const isBlockedStatement = database.prepare(`
    SELECT 1 as found FROM player_blocks
    WHERE blocker_profile_id = ? AND blocked_profile_id = ?
    LIMIT 1
  `)

  const countStatement = database.prepare(`
    SELECT COUNT(*) as count FROM player_blocks WHERE blocker_profile_id = ?
  `)

  const listBlockedStatement = database.prepare(`
    SELECT blocked_profile_id FROM player_blocks
    WHERE blocker_profile_id = ?
    ORDER BY created_at DESC
  `)

  const insertBlockStatement = database.prepare(`
    INSERT OR IGNORE INTO player_blocks (blocker_profile_id, blocked_profile_id) VALUES (?, ?)
  `)

  const deleteBlockStatement = database.prepare(`
    DELETE FROM player_blocks WHERE blocker_profile_id = ? AND blocked_profile_id = ?
  `)

  // Authoritative account role на target профила (NULL за ботове/временни/
  // профили без акаунт). Чете се ВЪТРЕ в toggleBlock транзакцията.
  const selectTargetAccountRoleStatement = database.prepare(`
    SELECT accounts.role AS role
    FROM profiles
    INNER JOIN accounts ON accounts.account_id = profiles.account_id
    WHERE profiles.profile_id = ?
    LIMIT 1
  `)

  function isBlocked(blockerProfileId: string, blockedProfileId: string): boolean {
    const row = isBlockedStatement.get(blockerProfileId, blockedProfileId)
    return row !== undefined
  }

  function getBlockedCount(blockerProfileId: string): number {
    const row = countStatement.get(blockerProfileId) as { count: number } | undefined
    return row?.count ?? 0
  }

  function getBlockedProfileIds(blockerProfileId: string): string[] {
    const rows = listBlockedStatement.all(blockerProfileId) as { blocked_profile_id: string }[]
    return rows.map((r) => r.blocked_profile_id)
  }

  // Invariant: нов ред в player_blocks към профил от екипа на Pika.bg
  // (isProtectedStaffRole) НИКОГА не се създава. Проверката на ролята и
  // INSERT-ът са в една BEGIN IMMEDIATE транзакция: write lock-ът е взет
  // преди прочита, затова role promotion (authStore.changeElevatedRole, също
  // BEGIN IMMEDIATE + DELETE на incoming blocks) се сериализира изцяло преди
  // или изцяло след нея — независимо от връзка/процес. Съществуващ (legacy/
  // stale) block към защитен профил остава премахваем (toggle -> unblock).
  function toggleBlock(
    blockerProfileId: string,
    blockedProfileId: string,
  ): ToggleBlockResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      let result: ToggleBlockResult
      if (isBlocked(blockerProfileId, blockedProfileId)) {
        deleteBlockStatement.run(blockerProfileId, blockedProfileId)
        result = { blocked: false }
      } else {
        const targetRole = (selectTargetAccountRoleStatement.get(blockedProfileId) as { role: string } | undefined)?.role ?? null
        if (isProtectedStaffRole(targetRole)) {
          result = { blocked: false, protectedStaffProfile: true }
        } else if (getBlockedCount(blockerProfileId) >= BLOCK_LIMIT) {
          result = { blocked: false, limitReached: true }
        } else {
          insertBlockStatement.run(blockerProfileId, blockedProfileId)
          result = { blocked: true }
        }
      }
      database.exec('COMMIT;')
      return result
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch { /* keep original error */ }
      throw error
    }
  }

  function close(): void {
    database.close()
  }

  return { isBlocked, toggleBlock, getBlockedProfileIds, getBlockedCount, close }
}
