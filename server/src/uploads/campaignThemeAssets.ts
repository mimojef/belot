// Фаза 10 (тематични изображения на кампаниите) — валидация за анимираната
// GIF тематична иконка. ОТДЕЛЕН модул от imageAttachments.ts нарочно:
// sharp.block({ operation: ['VipsForeignLoadNsgif', ...] }) в index.ts
// ГЛОБАЛНО блокира sharp/libvips от зареждане на GIF файлове (умишлена
// security hardening мярка) — processImageAttachmentToWebp НЕ може да се
// използва за GIF, и дори да можеше, re-encode през sharp би унищожил
// анимацията. Затова GIF upload-ът тук НИКОГА не минава през sharp:
// валидацията е чисто сигнатурна (magic bytes) + fixed-offset integer
// read на logical screen descriptor-а (ширина/височина) — безопасно, без
// decompression/decode на самите frame данни. Файлът се съхранява като
// opaque, непроменен blob; самото decode-ване на анимацията се случва
// единствено в браузъра на играча (стандартен <img>/CSS background-image
// GIF decode, същия security модел като за всяко друго изображение,
// качено от потребител в интернет).
//
// Съхранение/изтриване reuse-ва СЪЩИТЕ generic helper-и като останалите
// upload типове (writeWebpUploadFile — въпреки името, е чисто mkdir+writeFile,
// не прави webp-специфична обработка; deleteUploadFileByUrl — resolve-ва
// срещу PUBLIC_UPLOAD_SUBDIRECTORY_ROOTS whitelist-а, не filename regex,
// затова работи еднакво добре за .gif и .webp) — виж index.ts.

export const MAX_CAMPAIGN_GIF_INPUT_BYTES = 3_000_000
export const CAMPAIGN_GIF_MAX_DIMENSION_PX = 512

const GIF_MAGIC_87A = Buffer.from('GIF87a', 'ascii')
const GIF_MAGIC_89A = Buffer.from('GIF89a', 'ascii')

/** Decode + size cap, mirror на decodeImageAttachmentDataUrl-ия data-URL contract, но за `image/gif`. */
export function decodeCampaignGifUploadDataUrl(value: string): Buffer | null {
  const match = /^data:image\/gif;base64,([a-zA-Z0-9+/=]+)$/.exec(value.trim())

  if (!match) {
    return null
  }

  const buffer = Buffer.from(match[1], 'base64')

  if (buffer.length === 0 || buffer.length > MAX_CAMPAIGN_GIF_INPUT_BYTES) {
    return null
  }

  return buffer
}

/**
 * Истинска format sniffing (не разчита на разширение/Content-Type) — GIF87a/
 * GIF89a ASCII сигнатура в първите 6 байта, после logical screen descriptor
 * (GIF спецификация, фиксиран offset): ширина = bytes[6..7] LE uint16,
 * височина = bytes[8..9] LE uint16. Не decode-ва палитра/frame данни —
 * чисто header read, нулев decompression риск. Защита срещу "неоправдано
 * голям GIF" (§4 от задачата) е комбинация от тая dimension граница +
 * MAX_CAMPAIGN_GIF_INPUT_BYTES байтовия таван по-горе.
 */
export function isValidCampaignGifBuffer(buffer: Buffer): boolean {
  if (buffer.length < 10) {
    return false
  }

  const header = buffer.subarray(0, 6)
  if (!header.equals(GIF_MAGIC_87A) && !header.equals(GIF_MAGIC_89A)) {
    return false
  }

  const width = buffer.readUInt16LE(6)
  const height = buffer.readUInt16LE(8)

  return (
    width > 0 &&
    height > 0 &&
    width <= CAMPAIGN_GIF_MAX_DIMENSION_PX &&
    height <= CAMPAIGN_GIF_MAX_DIMENSION_PX
  )
}
