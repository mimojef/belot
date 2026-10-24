// Снимки от профилната галерия — достъп през Node.
//
// Защо: файловете живеят в uploads/profile-gallery/<profileId>/<imageId>.webp
// и в базата (profile_gallery_images.image_url / thumbnail_url) се пази URL
// /uploads/profile-gallery/... Production nginx отказва този префикс с 403
// (защита на личните качени файлове), така че директният URL е счупен за
// всеки, който няма снимката в браузърния кеш. Галерията се отдава САМО през
//   GET /api/profiles/:profileId/gallery/:imageId
// със същите правила за достъп като самия профил (handleProfileByIdRequest).
//
// Сигурност (самостоятелна проверка, без общия /uploads маршрут):
//   * пътят към файла НИКОГА не идва от заявката — само profileId + imageId,
//     по които се намира редът в базата; файлът е този от записания URL;
//   * записаният URL трябва да е точно /uploads/profile-gallery/<profileId>/<файл>.webp
//     за СЪЩИЯ профил, с име на файл само от [A-Za-z0-9_-] (без '..', '/',
//     '\\', ':', '%' след декодиране, без поддиректории);
//   * четене само ако realpath-ът на файла е вътре в realpath-а на галерията
//     (без symlink/junction извън нея).

import { realpath } from 'node:fs/promises'
import path from 'node:path'

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const FILE_NAME_RE = /^[A-Za-z0-9_-]{1,128}\.webp$/
const API_PATH_RE = /^\/api\/profiles\/([^/]+)\/gallery\/([^/]+)$/
const STORED_URL_RE = /^\/uploads\/profile-gallery\/([^/]+)\/([^/]+)$/

/** URL-ът, който клиентът получава в galleryImages[].imageUrl. */
export function buildProfileGalleryImageApiUrl(profileId: string, imageId: string): string {
  return `/api/profiles/${encodeURIComponent(profileId)}/gallery/${encodeURIComponent(imageId)}`
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** profileId/imageId от пътя на заявката — само строг формат, иначе null. */
export function parseProfileGalleryImageApiPath(pathname: string): { profileId: string; imageId: string } | null {
  const match = API_PATH_RE.exec(pathname)
  if (match === null) return null
  const profileId = safeDecode(match[1] ?? '')
  const imageId = safeDecode(match[2] ?? '')
  if (profileId === null || imageId === null || !ID_RE.test(profileId) || !ID_RE.test(imageId)) return null
  return { profileId, imageId }
}

function isStrictlyInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Файлът за записан URL на снимка от галерията на profileId — само ако URL-ът
 * е точно /uploads/profile-gallery/<profileId>/<име>.webp и realpath-ът му е
 * в галерията. null = да не се сервира.
 */
export async function resolveProfileGalleryImageFile(input: {
  storedImageUrl: string
  profileId: string
  galleryRoot: string
}): Promise<string | null> {
  const match = STORED_URL_RE.exec(input.storedImageUrl.trim())
  if (match === null) return null
  const profileSegment = safeDecode(match[1] ?? '')
  const fileName = safeDecode(match[2] ?? '')
  if (profileSegment === null || fileName === null) return null
  if (profileSegment !== input.profileId || !ID_RE.test(profileSegment) || !FILE_NAME_RE.test(fileName)) return null
  const galleryRoot = path.resolve(input.galleryRoot)
  const filePath = path.resolve(galleryRoot, profileSegment, fileName)
  if (!isStrictlyInside(galleryRoot, filePath)) return null
  try {
    const [rootReal, fileReal] = await Promise.all([realpath(galleryRoot), realpath(filePath)])
    // Файлът трябва реално да е директно в папката на СЪЩИЯ профил
    // (junction/symlink към друга папка — вкл. на друг профил — се отказва).
    const sameProfileFolder = path.dirname(fileReal) === path.join(rootReal, profileSegment)
    return isStrictlyInside(rootReal, fileReal) && sameProfileFolder ? fileReal : null
  } catch {
    return null
  }
}
