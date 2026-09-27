// Generic in-game "gift flight" animation — извлечена от Belot table gift-а
// (createActiveRoomFlowController.ts::playTableGiftFlightAnimation, Stage 2)
// в generic, presentation-only helper. Belot-овата версия НЕ е migrate-ната
// към тоя shared module (тя си остава непроменена, тествана единствено
// ръчно — виж task-а "Ludo подаръци" §12 финалния отчет за rationale), но
// самата функция е написана generic-но (fromEl/toEl adapters, не seat/
// roomId-specific selectors), за да може бъдещ dedicated refactor да
// premine Belot към нея без duplication. Ludo (createLudoFlowController.ts)
// е първият/единствен consumer засега.
//
// Same math/easing/timing като Belot оригинала: fly from sender anchor to
// recipient anchor с лека дъга нагоре + bounce landing, landing size = TO
// rect (нула visual "jump" при прехвърляне към permanent overlay-а).

export interface GiftFlightAnimationOptions {
  /** Елементът, от който подаръкът "излита" (sender anchor). */
  fromEl: HTMLElement
  /** Елементът, върху който каца (recipient anchor/avatar container). */
  toEl: HTMLElement
  imageUrl: string
  /**
   * Уникален data-атрибут за fixed overlay layer-а (напр.
   * 'data-ludo-gift-flight-layer') — отделен layer per game, за да не се
   * бъркат/преизползват DOM nodes между Belot/Ludo, ако някога коекзистират
   * в една страница (в момента никога не се случва, но е евтина изолация).
   */
  layerAttribute: string
  /** Default 1600ms — идентично на Belot TABLE_GIFT_FLIGHT_MS. */
  durationMs?: number
  /**
   * z-index на fixed overlay layer-а. Default 60 (Belot-овата стойност) —
   * ЗАДЪЛЖИТЕЛНО подавай explicit стойност от играта, ако тя ползва различна
   * z-index скала (напр. Ludo, виж ludoLayerHierarchy.ts LUDO_GIFT_FLIGHT_Z_INDEX
   * — Ludo-related z-index-ите са в хиляди, не десетки, default 60 би бил
   * невидим зад board-а).
   */
  zIndex?: number
  /** Извиква се точно веднъж, когато полетът приключи нормално. */
  onLanded: () => void
  /** Извиква се вместо onLanded, ако анимацията е cancel-ната (напр. epoch/teardown). */
  onCancelled?: () => void
}

const DEFAULT_FLIGHT_DURATION_MS = 1600

export function playGiftFlightAnimation(options: GiftFlightAnimationOptions): void {
  const { fromEl, toEl, imageUrl, layerAttribute, onLanded } = options
  const durationMs = options.durationMs ?? DEFAULT_FLIGHT_DURATION_MS

  // Fallback (виж Belot-овия §7 rationale): ако анимацията не може безопасно
  // да стартира (без Web Animations API, липсващ anchor, zero-size rect —
  // все още не е layout-нато), overlay-ът НЕ бива да остане hidden завинаги
  // — веднага release-ваме и показваме canonical state-а директно.
  if (typeof document.createElement('div').animate !== 'function') {
    onLanded()
    return
  }

  const fromRect = fromEl.getBoundingClientRect()
  const toRect = toEl.getBoundingClientRect()

  if (fromRect.width === 0 || toRect.width === 0) {
    onLanded()
    return
  }

  let layer = document.body.querySelector<HTMLElement>(`[${layerAttribute}="1"]`)
  if (!layer) {
    layer = document.createElement('div')
    layer.setAttribute(layerAttribute, '1')
    layer.style.cssText = ['position:fixed', 'inset:0', 'pointer-events:none', `z-index:${options.zIndex ?? 60}`].join(';')
    document.body.appendChild(layer)
  }

  const flyer = document.createElement('img')
  flyer.src = imageUrl
  flyer.alt = ''
  // Landing-геометрия: базовият flyer размер е ТОЧНО recipient rect-а
  // (toRect), не fixed константа — при landing (scale 1, offset 1 в
  // keyframe-овете по-долу) flyer-ът вече съвпада 1:1 с permanent overlay-а,
  // нула visual "jump" при прехвърлянето. minWidthPx/minHeightPx guard-ват
  // срещу изроден 0px rect edge case.
  const minWidthPx = Math.max(toRect.width, 1)
  const minHeightPx = Math.max(toRect.height, 1)
  flyer.style.cssText = [
    'position:absolute',
    'left:0',
    'top:0',
    `width:${minWidthPx}px`,
    `height:${minHeightPx}px`,
    'object-fit:cover',
    'filter:drop-shadow(0 8px 18px rgba(0,0,0,0.5))',
    'will-change:transform,opacity',
  ].join(';')
  layer.appendChild(flyer)

  const fromX = fromRect.left + fromRect.width / 2 - minWidthPx / 2
  const fromY = fromRect.top + fromRect.height / 2 - minHeightPx / 2
  const toX = toRect.left + toRect.width / 2 - minWidthPx / 2
  const toY = toRect.top + toRect.height / 2 - minHeightPx / 2

  const animation = flyer.animate(
    [
      // Поява при изпращача.
      { transform: `translate(${fromX}px, ${fromY}px) scale(0.2)`, opacity: 0, offset: 0 },
      { transform: `translate(${fromX}px, ${fromY}px) scale(1)`, opacity: 1, offset: 0.13 },
      // Полет с лека дъга нагоре.
      {
        transform: `translate(${(fromX + toX) / 2}px, ${Math.min(fromY, toY) - 60}px) scale(1.08)`,
        opacity: 1,
        offset: 0.62,
      },
      // Кацане + bounce.
      { transform: `translate(${toX}px, ${toY}px) scale(1.22)`, opacity: 1, offset: 0.88 },
      { transform: `translate(${toX}px, ${toY}px) scale(0.92)`, opacity: 0.9, offset: 1 },
    ],
    {
      duration: durationMs,
      easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
      fill: 'both',
    },
  )

  animation.onfinish = () => {
    flyer.remove()
    onLanded()
  }
  animation.oncancel = () => {
    flyer.remove()
    ;(options.onCancelled ?? onLanded)()
  }
}
