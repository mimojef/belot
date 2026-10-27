import type { BelotVisualAssets } from '../protocol/messageTypes.js'
import type { BelotVisualOverrideSnapshot } from './belotVisualOverrideStore.js'

export type { BelotVisualAssets }

// Ефективната визия на Белот масата — поотделно за всяко от трите
// изображения:
//   1. ръчната визия, ако е включена И изображението е качено;
//   2. иначе изображението на активната кампания (ако има);
//   3. иначе null → клиентът показва стандартната визия.
// Липсващо ръчно изображение никога не "изпразва" слота — пада към (2)/(3).

export function resolveBelotVisual(
  override: BelotVisualOverrideSnapshot | null,
  campaignTheme: BelotVisualAssets | null,
): BelotVisualAssets {
  const manual = override !== null && override.enabled ? override : null
  return {
    tableBgDesktopUrl: manual?.tableBgDesktopUrl ?? campaignTheme?.tableBgDesktopUrl ?? null,
    tableBgMobileUrl: manual?.tableBgMobileUrl ?? campaignTheme?.tableBgMobileUrl ?? null,
    cardBackUrl: manual?.cardBackUrl ?? campaignTheme?.cardBackUrl ?? null,
  }
}
