import { isPhoneLayoutViewport } from './viewportStage'

// Шрифтът на светлия мобилен дизайн. Без двойни кавички — стойността влиза
// в inline style="..." атрибути.
export const MOBILE_LIGHT_FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"

// Кой светъл мобилен екран е монтиран в момента — за попъпи и известия,
// които живеят в document.body (извън рамката на лобито) и избират вида и
// мястото си в момента на показване, а не по CSS родител:
//   'frame'      — светлата рамка на лобито (хедър + долна навигация);
//   'standalone' — самостоятелен светъл екран без навигация (чакалнята на
//                  частна маса);
//   null         — desktop/таблет, тъмен мобилен екран или игра.
export type MobileLightUiContext = 'frame' | 'standalone'

export function getMobileLightUiContext(): MobileLightUiContext | null {
  if (typeof document === 'undefined' || !isPhoneLayoutViewport()) return null
  const app = document.getElementById('app') ?? document.body
  if (app.querySelector('[data-lobby-screen-root="1"][data-lobby-member-mobile-light], [data-lobby-screen-root="1"][data-lobby-guest-mobile-light]') !== null) {
    return 'frame'
  }
  if (app.querySelector('[data-private-room-waiting-screen="1"][data-private-room-light="1"]') !== null) {
    return 'standalone'
  }
  return null
}
