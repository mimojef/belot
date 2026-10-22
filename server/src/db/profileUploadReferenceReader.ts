// Дали публичен upload URL на профил (аватар / снимка от галерията) още се
// реферира от жив ред в базата. Ползва се от index.ts's deleteUploadFileByUrl
// преди физическо изтриване — файл, който още е аватар или снимка в галерия
// (на същия или на друг профил), не се трие. Mirror на shared-file проверката
// на worker-а за самоизтриване (profileDeletionExecutor.isStorageRefReferenced).

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export const PROFILE_UPLOAD_URL_PREFIXES = ['/uploads/avatars/', '/uploads/profile-gallery/'] as const

export type ProfileUploadReferenceReader = {
  /** false за URL извън аватарите/галерията (за тях отговарят собствените им проверки). */
  isProfileUploadUrlReferenced: (uploadUrl: string) => boolean
  close: () => void
}

export async function createProfileUploadReferenceReader(databaseFilePath: string): Promise<ProfileUploadReferenceReader> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true })
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectReferenceStatement = database.prepare(`
    SELECT 1 AS found FROM profiles WHERE avatar_url = ?1
    UNION ALL
    SELECT 1 AS found FROM profile_gallery_images WHERE image_url = ?1 OR thumbnail_url = ?1
    LIMIT 1;
  `)

  return {
    isProfileUploadUrlReferenced: (uploadUrl) =>
      PROFILE_UPLOAD_URL_PREFIXES.some((prefix) => uploadUrl.startsWith(prefix)) &&
      selectReferenceStatement.get(uploadUrl) !== undefined,
    close: () => database.close(),
  }
}
