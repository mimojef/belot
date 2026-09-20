import { CURRENT_BUILD_ID } from '../../buildId'

export function getAnimatedEmojiUrl(emojiId: string): string {
  return `/assets/animated-emoji/emoji-${emojiId}.webp?v=${CURRENT_BUILD_ID}`
}

export function getAnimatedEmojiPreviewUrl(emojiId: string): string {
  return `/assets/animated-emoji/preview/preview-emoji-${emojiId}.png?v=${CURRENT_BUILD_ID}`
}

// Общ каталог размер (реален брой animated emoji asset-и, виж assets/
// animated-emoji/) — единствен source of truth за нови call sites (Ludo
// emoji reaction feature), за да не се копира отделна "24" константа.
// Belot's createActiveRoomFlowController.ts си пази собствена локална
// EMOJI_COUNT=24 (не е пипана тук — това е ЧИСТО addition, нулев behavior
// change за Belot), но стойността е идентична, проверена директно в кода.
export const ANIMATED_EMOJI_COUNT = 24

// Emoji ID-тата са "01".."24" (zero-padded 2-digit), огледално на Belot's
// renderEmojiPickerHtml id генерирането (String(i).padStart(2,'0')).
export function isValidAnimatedEmojiId(id: string): boolean {
  if (!/^\d{2}$/.test(id)) return false
  const n = Number(id)
  return n >= 1 && n <= ANIMATED_EMOJI_COUNT
}
