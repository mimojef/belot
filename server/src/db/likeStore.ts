type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

const LIKE_COOLDOWN_HOURS = 4

export type LikeStore = {
  getLikesCount: (profileId: string) => number
  hasLikedRecently: (likerProfileId: string, likedProfileId: string) => boolean
  addLike: (likerProfileId: string, likedProfileId: string) => { ok: boolean; likesCount: number }
  close: () => void
}

export async function createLikeStore(databaseFilePath: string): Promise<LikeStore> {
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(databaseFilePath, { open: true })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const countStatement = database.prepare(`
    SELECT COALESCE(SUM(total_given), 0) as count FROM profile_likes WHERE liked_profile_id = ?
  `)

  const hasLikedRecentlyStatement = database.prepare(`
    SELECT 1 as found FROM profile_likes
    WHERE liker_profile_id = ? AND liked_profile_id = ?
      AND last_liked_at > datetime('now', '-${LIKE_COOLDOWN_HOURS} hours')
    LIMIT 1
  `)

  const upsertStatement = database.prepare(`
    INSERT INTO profile_likes (liker_profile_id, liked_profile_id, last_liked_at, total_given)
    VALUES (?, ?, datetime('now'), 1)
    ON CONFLICT(liker_profile_id, liked_profile_id)
    DO UPDATE SET total_given = total_given + 1, last_liked_at = datetime('now')
  `)

  function getLikesCount(profileId: string): number {
    const row = countStatement.get(profileId) as { count: number } | undefined
    return row?.count ?? 0
  }

  function hasLikedRecently(likerProfileId: string, likedProfileId: string): boolean {
    const row = hasLikedRecentlyStatement.get(likerProfileId, likedProfileId)
    return row !== undefined
  }

  function addLike(likerProfileId: string, likedProfileId: string): { ok: boolean; likesCount: number } {
    if (hasLikedRecently(likerProfileId, likedProfileId)) {
      return { ok: false, likesCount: getLikesCount(likedProfileId) }
    }
    upsertStatement.run(likerProfileId, likedProfileId)
    return { ok: true, likesCount: getLikesCount(likedProfileId) }
  }

  function close(): void {
    database.close()
  }

  return { getLikesCount, hasLikedRecently, addLike, close }
}
