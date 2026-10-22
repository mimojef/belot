// Публичните upload файлове (/uploads/avatars, /profile-gallery, /ad-campaigns,
// /gift-items, /campaign-themes) — разрешаване на URL към файл и безопасното
// му изтриване. Единственият източник на тези правила за index.ts
// (handleUploadsRequest, deleteUploadFileByUrl, архивът на кампанийни иконки).
//
// Защо отделен модул: предишната проверка в index.ts долепяше '\\' към
// разрешения root, което под Linux (production) никога не съвпада — Node не
// сервираше /uploads и deleteUploadFileByUrl не триеше нищо. Тук сравнението
// е през path.relative за конкретната платформа (pathApi се подава от
// тестовете, за да се провери POSIX поведението и под Windows).
//
// Правила:
//   * само whitelisted публични root-ове — личните директории (чат, поддръжка,
//     Теми, evidence) НЕ са сред тях и никога не се разрешават оттук;
//   * URL-ът трябва вече да е каноничен: без '.', '..', празни сегменти,
//     '\\', NUL, ':' и '%' след декодиране. Така проверките по URL
//     (скритата галерия на профил с активна заявка за изтриване) не могат
//     да бъдат заобиколени чрез "/uploads/avatars/..%2Fprofile-gallery/...";
//   * файлът се чете/трие само ако realpath-ът му е вътре в realpath-а на
//     своя root (защита от symlink/junction извън директорията); при
//     изтриване symlink изобщо не се пипа.

import { lstat, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'

export const PUBLIC_UPLOAD_ROUTE_PREFIX = '/uploads/'

export type UploadPathApi = Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>

export type PublicUploadPathResolution = {
  /** Абсолютен път до файла (без следване на symlink-ове). */
  filePath: string
  /** Разрешеният публичен root, в който е filePath. */
  publicRoot: string
  /** Декодираният каноничен URL (/uploads/...) — за проверките по URL. */
  canonicalPathname: string
}

const FORBIDDEN_DECODED_CHARACTERS_RE = /[\\\0:%]/

/** true само ако candidate е СТРОГО вътре в root (не самият root). */
export function isPathStrictlyInsideDirectory(root: string, candidate: string, pathApi: UploadPathApi = path): boolean {
  const relativePath = pathApi.relative(root, candidate)
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relativePath)
  )
}

export function resolvePublicUploadRequestPath(
  pathname: string,
  options: { uploadsRoot: string; publicRoots: readonly string[]; pathApi?: UploadPathApi },
): PublicUploadPathResolution | null {
  const pathApi = options.pathApi ?? path
  if (typeof pathname !== 'string' || !pathname.startsWith(PUBLIC_UPLOAD_ROUTE_PREFIX)) {
    return null
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(pathname.slice(PUBLIC_UPLOAD_ROUTE_PREFIX.length))
  } catch {
    return null
  }
  if (decoded.length === 0 || FORBIDDEN_DECODED_CHARACTERS_RE.test(decoded)) {
    return null
  }
  const segments = decoded.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null
  }

  const filePath = pathApi.resolve(options.uploadsRoot, ...segments)
  const publicRoot = options.publicRoots
    .map((root) => pathApi.resolve(root))
    .find((root) => isPathStrictlyInsideDirectory(root, filePath, pathApi))
  if (publicRoot === undefined) {
    return null
  }

  return { filePath, publicRoot, canonicalPathname: `${PUBLIC_UPLOAD_ROUTE_PREFIX}${segments.join('/')}` }
}

/**
 * Реалният път за четене — само ако след разрешаване на symlink-овете
 * файлът остава вътре в (реалния) си публичен root. null = да не се сервира.
 */
export async function resolveRealPublicUploadFilePath(resolution: PublicUploadPathResolution): Promise<string | null> {
  try {
    const [rootReal, fileReal] = await Promise.all([realpath(resolution.publicRoot), realpath(resolution.filePath)])
    return isPathStrictlyInsideDirectory(rootReal, fileReal) ? fileReal : null
  } catch {
    return null
  }
}

export type PublicUploadFileDeletionOutcome =
  | 'deleted'
  | 'missing'
  | 'not_public_upload'
  | 'still_referenced'
  | 'refused_symlink'
  | 'refused_not_regular_file'
  | 'refused_outside_root'

/**
 * Изтрива публичен upload файл по URL. Никога не трие: файл извън
 * whitelisted root-овете, symlink, не-обикновен файл, файл, чийто realpath е
 * извън root-а, или файл, който isStillReferenced(url) посочва като още
 * използван. Реални fs грешки се хвърлят (извикващият ги логва).
 */
export async function deletePublicUploadFile(
  uploadUrl: string,
  options: {
    uploadsRoot: string
    publicRoots: readonly string[]
    isStillReferenced?: (resolution: PublicUploadPathResolution) => boolean
  },
): Promise<PublicUploadFileDeletionOutcome> {
  const resolution = resolvePublicUploadRequestPath(uploadUrl.trim(), options)
  if (resolution === null) return 'not_public_upload'
  if (options.isStillReferenced?.(resolution) === true) return 'still_referenced'

  try {
    const stats = await lstat(resolution.filePath)
    if (stats.isSymbolicLink()) return 'refused_symlink'
    if (!stats.isFile()) return 'refused_not_regular_file'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }

  try {
    const [rootReal, parentReal] = await Promise.all([
      realpath(resolution.publicRoot),
      realpath(path.dirname(resolution.filePath)),
    ])
    // Родителската директория е самият root или е вътре в него (междинна
    // symlink/junction директория извън root-а се отказва).
    if (parentReal !== rootReal && !isPathStrictlyInsideDirectory(rootReal, parentReal)) return 'refused_outside_root'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }

  try {
    await unlink(resolution.filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
  return 'deleted'
}
