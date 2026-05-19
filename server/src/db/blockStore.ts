type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export const BLOCK_LIMIT = 50

export type BlockStore = {
  isBlocked: (blockerProfileId: string, blockedProfileId: string) => boolean
  toggleBlock: (
    blockerProfileId: string,
    blockedProfileId: string,
  ) => { blocked: boolean; limitReached?: true }
  getBlockedProfileIds: (blockerProfileId: string) => string[]
  getBlockedCount: (blockerProfileId: string) => number
  close: () => void
}

export async function createBlockStore(databaseFilePath: string): Promise<BlockStore> {
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(databaseFilePath, { open: true }) as SqliteDatabase

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

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

  function toggleBlock(
    blockerProfileId: string,
    blockedProfileId: string,
  ): { blocked: boolean; limitReached?: true } {
    if (isBlocked(blockerProfileId, blockedProfileId)) {
      deleteBlockStatement.run(blockerProfileId, blockedProfileId)
      return { blocked: false }
    }

    if (getBlockedCount(blockerProfileId) >= BLOCK_LIMIT) {
      return { blocked: false, limitReached: true }
    }

    insertBlockStatement.run(blockerProfileId, blockedProfileId)
    return { blocked: true }
  }

  function close(): void {
    database.close()
  }

  return { isBlocked, toggleBlock, getBlockedProfileIds, getBlockedCount, close }
}
