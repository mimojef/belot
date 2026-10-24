// Снимки от профилната галерия — удостоверен достъп през Node.
//
// Защо: файловете живеят в uploads/profile-gallery/<profileId>/<imageId>.webp
// и в базата (profile_gallery_images.image_url / thumbnail_url) се пази
// публичен URL /uploads/profile-gallery/... Production nginx отказва този
// префикс с 403 (аварийната защита в deploy/nginx-private-uploads-emergency-block.conf),
// така че директният URL е счупен за всеки, който няма снимката в браузърния
// кеш. Галерията вече се отдава САМО през
//   GET /api/profiles/:profileId/gallery/:imageId
// с правилата за видимост на самия профил (handleProfileByIdRequest).
//
// Сигурност:
//   * пътят към файла НИКОГА не идва от заявката — само profileId + imageId,
//     по които се намира редът в базата; файлът е този от записания URL;
//   * записаният URL минава през каноничната проверка на publicUploadPath
//     (без '..', '%', '\\', ':' ...) и трябва да е точно в
//     profile-gallery/<profileId>/ на СЪЩИЯ профил;
//   * четене само ако realpath-ът остава в realpath-а на галерията (без
//     symlink/junction извън нея).

import path from 'node:path'
import {
  resolvePublicUploadRequestPath,
  resolveRealPublicUploadFilePath,
} from './publicUploadPath.js'

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const API_PATH_RE = /^\/api\/profiles\/([^/]+)\/gallery\/([^/]+)$/

export const PROFILE_GALLERY_UPLOAD_SUBDIRECTORY = 'profile-gallery'

/** URL-ът, който клиентът получава в galleryImages[].imageUrl. */
export function buildProfileGalleryImageApiUrl(profileId: string, imageId: string): string {
  return `/api/profiles/${encodeURIComponent(profileId)}/gallery/${encodeURIComponent(imageId)}`
}

/** profileId/imageId от пътя на заявката — само строг формат, иначе null. */
export function parseProfileGalleryImageApiPath(pathname: string): { profileId: string; imageId: string } | null {
  const match = API_PATH_RE.exec(pathname)
  if (match === null) return null
  let profileId: string
  let imageId: string
  try {
    profileId = decodeURIComponent(match[1] ?? '')
    imageId = decodeURIComponent(match[2] ?? '')
  } catch {
    return null
  }
  if (!ID_RE.test(profileId) || !ID_RE.test(imageId)) return null
  return { profileId, imageId }
}

/**
 * Файлът за записан URL на снимка от галерията на profileId — само ако URL-ът
 * е каноничен, е точно в profile-gallery/<profileId>/ и realpath-ът му е в
 * галерията. null = да не се сервира.
 */
export async function resolveProfileGalleryImageFile(input: {
  storedImageUrl: string
  profileId: string
  uploadsRoot: string
  galleryRoot: string
  pathApi?: Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>
}): Promise<string | null> {
  const resolution = resolvePublicUploadRequestPath(input.storedImageUrl.trim(), {
    uploadsRoot: input.uploadsRoot,
    publicRoots: [input.galleryRoot],
    pathApi: input.pathApi,
  })
  if (resolution === null) return null
  const expectedPrefix = `/uploads/${PROFILE_GALLERY_UPLOAD_SUBDIRECTORY}/${input.profileId}/`
  const rest = resolution.canonicalPathname.startsWith(expectedPrefix)
    ? resolution.canonicalPathname.slice(expectedPrefix.length)
    : null
  // Точно един файл директно в папката на профила (без поддиректории).
  if (rest === null || rest.length === 0 || rest.includes('/')) return null
  return await resolveRealPublicUploadFilePath(resolution)
}
