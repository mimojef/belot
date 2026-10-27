import sharp from 'sharp'
import { processImageAttachmentToWebp } from '../uploads/imageAttachments.js'

// "Визия на Белот" — оптимизиран WebP за масата (desktop/mobile) и гърба на
// картите. Преизползва общия processImageAttachmentToWebp (валидация на
// формата PNG/JPEG/WebP, лимит на пикселите, EXIF rotate, fit:'inside' без
// изкривяване и без увеличаване, запазена alpha) — само с по-високо
// качество и избор lossy/lossless. Кампанийните изображения не минават оттук.

export const BELOT_VISUAL_WEBP_QUALITY = 92

// PNG източник (графика: чисти ръбове, плътни цветове, текст, прозрачност)
// се кодира и lossless; lossless версията се избира, ако е най-много с
// толкова по-тежка от lossy q92 — така фините детайли остават пиксел-точни,
// а снимки, записани като PNG, не стават многократно по-тежки.
export const BELOT_VISUAL_LOSSLESS_MAX_SIZE_RATIO = 1.05

export type ProcessedBelotVisualImage = {
  buffer: Buffer
  width: number
  height: number
  mode: 'lossy' | 'lossless'
}

export async function processBelotVisualImageToWebp(
  imageBuffer: Buffer,
  dimensionPx: number,
): Promise<ProcessedBelotVisualImage | null> {
  const common = { enforceSourcePixelLimit: true, dimensionPx, effort: 5 } as const
  const lossy = await processImageAttachmentToWebp(imageBuffer, {
    ...common,
    quality: BELOT_VISUAL_WEBP_QUALITY,
    alphaQuality: 100,
    smartSubsample: true,
  })
  if (lossy === null) return null

  const sourceFormat = (await sharp(imageBuffer).metadata().catch(() => null))?.format
  if (sourceFormat === 'png') {
    const lossless = await processImageAttachmentToWebp(imageBuffer, { ...common, lossless: true })
    if (lossless !== null && lossless.buffer.length <= lossy.buffer.length * BELOT_VISUAL_LOSSLESS_MAX_SIZE_RATIO) {
      return { ...lossless, mode: 'lossless' }
    }
  }

  return { ...lossy, mode: 'lossy' }
}
