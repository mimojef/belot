import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

export const MAX_IMAGE_ATTACHMENT_INPUT_BYTES = 10_000_000
export const MAX_IMAGE_ATTACHMENT_JSON_BYTES = 15_000_000
export const IMAGE_ATTACHMENT_MAX_DIMENSION_PX = 1920
export const IMAGE_ATTACHMENT_WEBP_QUALITY = 82
export const IMAGE_ATTACHMENT_FILENAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/
export const IMAGE_ATTACHMENT_MAX_SOURCE_DIMENSION_PX = 12_000
export const IMAGE_ATTACHMENT_MAX_SOURCE_PIXELS = 50_000_000

export type ProcessedImageAttachment = {
  buffer: Buffer
  width: number
  height: number
}

export function decodeImageAttachmentDataUrl(value: string): Buffer | null {
  const match = /^data:image\/(png|jpe?g|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(value.trim())

  if (!match) {
    return null
  }

  const buffer = Buffer.from(match[2], 'base64')

  if (buffer.length === 0 || buffer.length > MAX_IMAGE_ATTACHMENT_INPUT_BYTES) {
    return null
  }

  return buffer
}

export async function processImageAttachmentToWebp(
  imageBuffer: Buffer,
  options: { enforceSourcePixelLimit?: boolean } = {},
): Promise<ProcessedImageAttachment | null> {
  const metadata = await sharp(imageBuffer).metadata().catch(() => null)

  if (
    metadata === null ||
    (metadata.format !== 'jpeg' && metadata.format !== 'png' && metadata.format !== 'webp')
  ) {
    return null
  }

  const imageWidth = metadata.width ?? 0
  const imageHeight = metadata.height ?? 0

  if (imageWidth <= 0 || imageHeight <= 0) {
    return null
  }

  if (options.enforceSourcePixelLimit === true) {
    if (
      imageWidth > IMAGE_ATTACHMENT_MAX_SOURCE_DIMENSION_PX ||
      imageHeight > IMAGE_ATTACHMENT_MAX_SOURCE_DIMENSION_PX ||
      imageWidth * imageHeight > IMAGE_ATTACHMENT_MAX_SOURCE_PIXELS
    ) {
      return null
    }
  }

  const buffer = await sharp(imageBuffer)
    .rotate()
    .resize(IMAGE_ATTACHMENT_MAX_DIMENSION_PX, IMAGE_ATTACHMENT_MAX_DIMENSION_PX, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: IMAGE_ATTACHMENT_WEBP_QUALITY })
    .toBuffer()

  const outputMetadata = await sharp(buffer).metadata().catch(() => null)
  const outputWidth = outputMetadata?.width ?? 0
  const outputHeight = outputMetadata?.height ?? 0

  if (outputWidth <= 0 || outputHeight <= 0) {
    return null
  }

  return { buffer, width: outputWidth, height: outputHeight }
}

export async function writeWebpAttachmentFile(
  directoryPath: string,
  filename: string,
  buffer: Buffer,
): Promise<string> {
  await mkdir(directoryPath, { recursive: true })
  const filePath = join(directoryPath, filename)
  await writeFile(filePath, buffer)

  return filePath
}

export async function deleteAttachmentFileByFilename(
  directoryPath: string,
  filename: string,
): Promise<boolean> {
  if (!IMAGE_ATTACHMENT_FILENAME_PATTERN.test(filename)) {
    return false
  }

  const filePath = join(directoryPath, filename)

  try {
    await unlink(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true
    }
    return false
  }
}
