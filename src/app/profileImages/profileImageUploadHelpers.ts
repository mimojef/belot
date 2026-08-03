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
export const PROFILE_IMAGE_EMPTY_FILE_MESSAGE =
  'Снимката е празна или не беше предадена от устройството. Моля, изберете я отново.'
export const PROFILE_IMAGE_UNSUPPORTED_FORMAT_MESSAGE =
  'Този формат не се поддържа. Моля, изберете JPG, PNG или WebP.'

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

type ProfileImageContentFormat = 'jpeg' | 'png' | 'webp' | 'heic' | 'avif' | 'unknown'

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
  if (file.size <= 0) {
    return PROFILE_IMAGE_EMPTY_FILE_MESSAGE
  }

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

function detectProfileImageContentFormat(header: Uint8Array): ProfileImageContentFormat {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'jpeg'
  }

  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  ) {
    return 'png'
  }

  if (
    header.length >= 12 &&
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x45 &&
    header[10] === 0x42 &&
    header[11] === 0x50
  ) {
    return 'webp'
  }

  if (
    header.length >= 12 &&
    header[4] === 0x66 &&
    header[5] === 0x74 &&
    header[6] === 0x79 &&
    header[7] === 0x70
  ) {
    const brand = String.fromCharCode(...header.slice(8, 12)).toLowerCase()
    if (brand === 'avif' || brand === 'avis') return 'avif'
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx' || brand === 'mif1' || brand === 'msf1') {
      return 'heic'
    }
  }

  return 'unknown'
}

async function readProfileImageHeader(file: File): Promise<Uint8Array | null> {
  try {
    const buffer = await file.slice(0, 32).arrayBuffer()
    return new Uint8Array(buffer)
  } catch {
    return null
  }
}

export async function validateProfileImageFileForUpload(file: File): Promise<string | null> {
  if (file.size <= 0) {
    return PROFILE_IMAGE_EMPTY_FILE_MESSAGE
  }

  if (file.size > MAX_PROFILE_IMAGE_UPLOAD_BYTES) {
    return 'Снимката трябва да е до 10 МБ.'
  }

  const header = await readProfileImageHeader(file)
  const contentFormat = header === null ? 'unknown' : detectProfileImageContentFormat(header)

  if (contentFormat === 'heic' || contentFormat === 'avif') {
    return PROFILE_IMAGE_UNSUPPORTED_FORMAT_MESSAGE
  }

  if (contentFormat === 'jpeg' || contentFormat === 'png' || contentFormat === 'webp') {
    return null
  }

  return validateProfileImageFile(file)
}

export async function readProfileImageFileAsDataUrl(file: File): Promise<string> {
  const validationError = await validateProfileImageFileForUpload(file)

  if (validationError !== null) {
    throw new Error(validationError)
  }

  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      resolve(String(reader.result ?? ''))
    })
    reader.addEventListener('error', () => {
      reject(new Error('Снимката не можа да бъде прочетена.'))
    })
    reader.readAsDataURL(file)
  })
}

export async function decodeProfileImageFile(
  file: File,
  deps: DecodeProfileImageFileDeps = {},
): Promise<{ ok: true; image: DecodedProfileImageFile } | { ok: false; message: string }> {
  const validationError = await validateProfileImageFileForUpload(file)
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
