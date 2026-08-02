const SUPPORTED_PROFILE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const SUPPORTED_PROFILE_IMAGE_EXTENSIONS = new Map([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
])
const UNSUPPORTED_HEIC_EXTENSIONS = new Set(['heic', 'heif'])

export const MAX_PROFILE_IMAGE_UPLOAD_BYTES = 10_000_000
export const PROFILE_IMAGE_DECODE_ERROR_MESSAGE =
  'Снимката е повредена или не може да бъде прочетена. Моля, изберете друг файл.'

export type DecodedProfileImageFile = {
  imageUrl: string
  width: number
  height: number
  revoke: () => void
}

type DecodeProfileImageFileDeps = {
  createObjectUrl?: (file: File) => string
  revokeObjectUrl?: (url: string) => void
  createImage?: () => HTMLImageElement
}

export function getProfileImageFileExtension(fileName: string): string {
  const lastSegment = fileName.trim().split(/[\\/]/).pop() ?? ''
  const dotIndex = lastSegment.lastIndexOf('.')
  return dotIndex === -1 ? '' : lastSegment.slice(dotIndex + 1).toLowerCase()
}

export function getSupportedProfileImageMimeType(file: Pick<File, 'name' | 'type'>): string | null {
  const reportedType = file.type.trim().toLowerCase()
  if (SUPPORTED_PROFILE_IMAGE_MIME_TYPES.has(reportedType)) return reportedType

  const extension = getProfileImageFileExtension(file.name)
  if (UNSUPPORTED_HEIC_EXTENSIONS.has(extension)) return null

  if (reportedType === '' || reportedType === 'application/octet-stream') {
    return SUPPORTED_PROFILE_IMAGE_EXTENSIONS.get(extension) ?? null
  }

  return null
}

export function validateProfileImageFile(file: Pick<File, 'name' | 'type' | 'size'>): string | null {
  if (file.size > MAX_PROFILE_IMAGE_UPLOAD_BYTES) {
    return 'Снимката трябва да е до 10 МБ.'
  }

  const extension = getProfileImageFileExtension(file.name)
  if (extension === 'heic' || extension === 'heif') {
    return 'HEIC/HEIF снимки не се поддържат. Моля, избери JPEG, PNG или WebP.'
  }

  if (getSupportedProfileImageMimeType(file) === null) {
    return 'Позволени са само JPEG, PNG и WebP снимки.'
  }

  return null
}

export async function decodeProfileImageFile(
  file: File,
  deps: DecodeProfileImageFileDeps = {},
): Promise<{ ok: true; image: DecodedProfileImageFile } | { ok: false; message: string }> {
  const validationError = validateProfileImageFile(file)
  if (validationError !== null) return { ok: false, message: validationError }

  const createObjectUrl = deps.createObjectUrl ?? URL.createObjectURL.bind(URL)
  const revokeObjectUrl = deps.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL)
  const createImage = deps.createImage ?? (() => new Image())
  const imageUrl = createObjectUrl(file)
  let revoked = false
  const revoke = (): void => {
    if (revoked) return
    revoked = true
    revokeObjectUrl(imageUrl)
  }

  try {
    const image = createImage()
    image.decoding = 'async'
    image.src = imageUrl

    if (typeof image.decode === 'function') {
      await image.decode()
    } else {
      await new Promise<void>((resolve, reject) => {
        image.addEventListener('load', () => resolve(), { once: true })
        image.addEventListener('error', () => reject(new Error('decode failed')), { once: true })
      })
    }

    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      throw new Error('empty image dimensions')
    }

    return {
      ok: true,
      image: {
        imageUrl,
        width: image.naturalWidth,
        height: image.naturalHeight,
        revoke,
      },
    }
  } catch {
    revoke()
    return { ok: false, message: PROFILE_IMAGE_DECODE_ERROR_MESSAGE }
  }
}
