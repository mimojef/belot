import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

export const MAX_IMAGE_ATTACHMENT_INPUT_BYTES = 10_000_000
export const MAX_IMAGE_ATTACHMENT_JSON_BYTES = 15_000_000
export const IMAGE_ATTACHMENT_MAX_DIMENSION_PX = 1920
export const IMAGE_ATTACHMENT_WEBP_QUALITY = 82
// Gift Item каталог override — по-висок quality за малки catalog icon-и (не
// голям chat/avatar volume), подаден explicit чрез processImageAttachmentToWebp
// options.quality. Останалите callers (avatars/chat/topics/support) не подават
// quality изобщо и продължават да ползват IMAGE_ATTACHMENT_WEBP_QUALITY по-горе.
export const GIFT_ITEM_IMAGE_WEBP_QUALITY = 90
// Gift изображенията се показват 1:1 при 100% fill върху avatar overlay
// slot-ове (table gift) — малък source (напр. 100x100), обработен през
// shared withoutEnlargement:true pipeline-а, оставаше на реалния си малък
// размер и после browser-ът го upscale-ваше визуално → pixelation. Затова
// gift-items upload route-ът подава explicit dimensionPx/allowEnlargement
// override-и, водещи до СТАНДАРТИЗИРАН output за ВСЯКО gift изображение
// (upscale ако source е по-малък, downscale ако е по-голям) — останалите
// callers (avatars/chat/topics/support) не подават тия опции и продължават
// с default 1920px/inside/withoutEnlargement поведението.
// 250 (не 512) — контролиран experiment: live diagnostic (getBoundingClientRect,
// computed CSS) доказа, че gift overlay <img> вече рендира в 1:1 идентичен
// box с normal avatar <img> (same rect, same CSS, same parent transforms).
// Единствената останала неизравнена променлива между двата беше source
// output dimension-ът (avatar route = createCroppedAvatarWebp() output
// 250x250, gift route тук = 512x512) — изравнено, за да се изолира дали
// самият source resolution mismatch допринася за възприетата разлика.
export const GIFT_ITEM_IMAGE_DIMENSION_PX = 250
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
  options: {
    enforceSourcePixelLimit?: boolean
    quality?: number
    /** Override за resize target dimension (квадрат). Default: IMAGE_ATTACHMENT_MAX_DIMENSION_PX. */
    dimensionPx?: number
    /** Override за withoutEnlargement. Default: false тук означава "позволи uplscale" — само gift-items route-ът подава true explicit; всички други callers не подават нищо и остават с shared withoutEnlargement:true поведението (виж resize() call-а по-долу). */
    allowEnlargement?: boolean
  } = {},
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

  const dimensionPx = options.dimensionPx ?? IMAGE_ATTACHMENT_MAX_DIMENSION_PX
  // fit:'cover' (не 'inside') само когда allowEnlargement===true (gift-items
  // route-ът) — гарантира ТОЧЕН dimensionPx x dimensionPx output дори ако
  // source не е перфектен квадрат (defense-in-depth, заданието casus: "gift
  // images са винаги квадратни", но upload-ът все пак validate-ва каквото
  // admin-ът реално качи). Останалите callers пазят непроменено 'inside' +
  // withoutEnlargement:true (default false тук означава "не позволявай
  // enlargement", т.е. withoutEnlargement:true остава default).
  const buffer = await sharp(imageBuffer)
    .rotate()
    .resize(dimensionPx, dimensionPx, {
      fit: options.allowEnlargement === true ? 'cover' : 'inside',
      withoutEnlargement: options.allowEnlargement !== true,
    })
    .webp({ quality: options.quality ?? IMAGE_ATTACHMENT_WEBP_QUALITY })
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
