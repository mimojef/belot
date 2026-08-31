import { CURRENT_BUILD_ID } from '../../buildId'

export function getAnimatedEmojiUrl(emojiId: string): string {
  return `/assets/animated-emoji/emoji-${emojiId}.webp?v=${CURRENT_BUILD_ID}`
}

export function getAnimatedEmojiPreviewUrl(emojiId: string): string {
  return `/assets/animated-emoji/preview/preview-emoji-${emojiId}.png?v=${CURRENT_BUILD_ID}`
}
