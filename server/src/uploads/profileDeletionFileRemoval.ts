// Самоизтриване на профили — Етап 4: безопасно физическо изтриване на един
// файл от profile_deletion_file_queue.
//
// Собствен resolver вместо index.ts's resolveUploadRequestPath/
// deleteUploadFileByUrl: той долепя '\\' като разделител към whitelisted
// root-а, което под Linux (production) никога не съвпада — затова там
// аватари/галерии не се трият физически. Тук сравнението е през
// path.relative + realpath и работи еднакво под Windows и Linux.
//
// Защити:
//   * всеки вид файл има ТОЧНО една разрешена директория и точна форма на
//     storage_ref (брой сегменти, позволени символи, без '..', '\', NUL);
//   * символни връзки НЕ се следват — нито файлът, нито междинна
//     директория; такъв файл се отказва (постоянна грешка, ръчна проверка);
//   * realpath на родителската директория трябва да е вътре в realpath на
//     разрешения root (защита и при symlink-нат root, напр. отделен volume);
//   * изтрива се само обикновен файл; липсващ файл (ENOENT) = вече чисто.

import { lstat, realpath, rmdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { IMAGE_ATTACHMENT_FILENAME_PATTERN } from './imageAttachments.js'

export type ProfileDeletionFileKind =
  | 'avatar'
  | 'gallery_image'
  | 'gallery_thumbnail'
  | 'chat_attachment'
  | 'topic_attachment'
  | 'topic_mute_evidence_attachment'
  | 'support_attachment'

export type ProfileDeletionUploadRoots = {
  avatars: string
  profileGallery: string
  chatAttachments: string
  topicAttachments: string
  topicMuteEvidenceAttachments: string
  supportAttachments: string
}

/** Постоянни откази — повторен опит не помага, нужна е ръчна проверка. */
export type ProfileDeletionFileRejectCode =
  | 'invalid_storage_ref'
  | 'symlink_refused'
  | 'not_regular_file'
  | 'outside_allowed_root'

export type ProfileDeletionFileRemovalOutcome =
  | { outcome: 'deleted' }
  | { outcome: 'missing' }
  | { outcome: 'rejected'; code: ProfileDeletionFileRejectCode }
  | { outcome: 'error'; code: string }

const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

type ParsedRef = { root: string; segments: string[] }

function parseUrlSegments(storageRef: string, prefix: string, expectedSegments: number): string[] | null {
  if (!storageRef.startsWith(prefix)) return null
  const rawSegments = storageRef.slice(prefix.length).split('/')
  if (rawSegments.length !== expectedSegments) return null
  const segments: string[] = []
  for (const raw of rawSegments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (!SAFE_SEGMENT_RE.test(decoded) || decoded.includes('..')) return null
    segments.push(decoded)
  }
  return segments
}

export function parseProfileDeletionStorageRef(
  kind: ProfileDeletionFileKind,
  storageRef: string,
  roots: ProfileDeletionUploadRoots,
): ParsedRef | null {
  if (typeof storageRef !== 'string' || storageRef.length === 0 || storageRef.length > 512) return null
  if (storageRef.includes('\\') || storageRef.includes('\0')) return null
  switch (kind) {
    case 'avatar': {
      const segments = parseUrlSegments(storageRef, '/uploads/avatars/', 1)
      return segments === null ? null : { root: roots.avatars, segments }
    }
    case 'gallery_image':
    case 'gallery_thumbnail': {
      const segments = parseUrlSegments(storageRef, '/uploads/profile-gallery/', 2)
      return segments === null ? null : { root: roots.profileGallery, segments }
    }
    case 'chat_attachment':
    case 'topic_attachment':
    case 'topic_mute_evidence_attachment':
    case 'support_attachment': {
      if (!IMAGE_ATTACHMENT_FILENAME_PATTERN.test(storageRef)) return null
      const root = kind === 'chat_attachment'
        ? roots.chatAttachments
        : kind === 'topic_attachment'
          ? roots.topicAttachments
          : kind === 'topic_mute_evidence_attachment'
            ? roots.topicMuteEvidenceAttachments
            : roots.supportAttachments
      return { root, segments: [storageRef] }
    }
    default:
      return null
  }
}

function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'fs_error'
}

function isInside(rootReal: string, candidateReal: string): boolean {
  const rel = relative(rootReal, candidateReal)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export async function removeProfileDeletionFile(
  kind: ProfileDeletionFileKind,
  storageRef: string,
  roots: ProfileDeletionUploadRoots,
): Promise<ProfileDeletionFileRemovalOutcome> {
  const parsed = parseProfileDeletionStorageRef(kind, storageRef, roots)
  if (parsed === null) return { outcome: 'rejected', code: 'invalid_storage_ref' }

  let rootReal: string
  try {
    rootReal = await realpath(parsed.root)
  } catch (error) {
    return errnoCode(error) === 'ENOENT' ? { outcome: 'missing' } : { outcome: 'error', code: errnoCode(error) }
  }

  // Междинни директории (само галерията има такава): без symlink.
  for (let index = 1; index < parsed.segments.length; index += 1) {
    const intermediate = join(parsed.root, ...parsed.segments.slice(0, index))
    try {
      const stats = await lstat(intermediate)
      if (stats.isSymbolicLink()) return { outcome: 'rejected', code: 'symlink_refused' }
      if (!stats.isDirectory()) return { outcome: 'rejected', code: 'not_regular_file' }
    } catch (error) {
      return errnoCode(error) === 'ENOENT' ? { outcome: 'missing' } : { outcome: 'error', code: errnoCode(error) }
    }
  }

  const target = join(parsed.root, ...parsed.segments)
  try {
    const stats = await lstat(target)
    if (stats.isSymbolicLink()) return { outcome: 'rejected', code: 'symlink_refused' }
    if (!stats.isFile()) return { outcome: 'rejected', code: 'not_regular_file' }
  } catch (error) {
    return errnoCode(error) === 'ENOENT' ? { outcome: 'missing' } : { outcome: 'error', code: errnoCode(error) }
  }

  try {
    const parentReal = await realpath(dirname(target))
    if (!isInside(rootReal, parentReal)) return { outcome: 'rejected', code: 'outside_allowed_root' }
  } catch (error) {
    return errnoCode(error) === 'ENOENT' ? { outcome: 'missing' } : { outcome: 'error', code: errnoCode(error) }
  }

  try {
    await unlink(target)
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') return { outcome: 'error', code: errnoCode(error) }
    return { outcome: 'missing' }
  }

  // Празната per-profile директория на галерията се премахва (rmdir трие
  // само празна директория; всяка грешка е безвредна и се игнорира).
  if (parsed.segments.length > 1) {
    try {
      await rmdir(dirname(target))
    } catch {
      // не е празна / вече липсва
    }
  }
  return { outcome: 'deleted' }
}
