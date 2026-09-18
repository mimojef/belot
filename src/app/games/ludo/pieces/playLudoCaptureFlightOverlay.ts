// Presentation-only "captured pawn flies home" overlay (виж task-а: shake +
// teleport не е достатъчно — victim трябва РЕАЛНО да прелети от target
// клетката до permanent home slot-а си). Reuse-ва СЪЩИЯ pattern като
// playLudoDiceFlightOverlay.ts (absolute-positioned document.body overlay,
// WAAPI container.animate() tween, measure real DOM rects) — не redesign,
// не нов visual език, само piece markup вместо dice markup.
//
// Overlay-ят е ЧИСТО presentation: не пипа engine state, не дублира capture
// rules. Origin/destination идват от РЕАЛНИ rendered rects (target cell,
// home slot cell), измерени в момента на impact-а — гарантирано viewer-
// perspective коректни, защото и двете клетки вече са render-нати през
// стандартния cell-id based board pipeline (виж renderLudoBoard.ts +
// applyLudoBoardContent), никаква отделна координатна логика тук.

import { renderLudoPieceHtml } from './renderLudoPieces'
import type { LudoPieceId } from '../ludoTypes'
import { LUDO_CAPTURE_FLIGHT_Z_INDEX } from '../ludoLayerHierarchy'

const FLIGHT_DURATION_MS = 500

export interface LudoCaptureFlightOptions {
  pieceId: LudoPieceId
  fromRect: DOMRect // target клетката (victim-ът стои тук в момента на impact-а)
  toRect: DOMRect // permanent home slot клетката на ТОЧНО тази piece
  pieceSizePx: number // реалният измерен размер на "живата" пионка на дъската — overlay-ят изглежда идентично, без отделна size formula
  // Bot-takeover popup layering fix (виж createLudoFlowController.ts
  // audit-а и playLudoDiceFlightOverlay.ts LudoDiceFlightOptions doc
  // коментара за пълния root cause): overlay-ят живее на document.body,
  // sibling на Ludo overlay root-а (не вложен в него), затова номинален
  // z-index сравнение с popup-a не е достатъчно — popup-ът е mount-нат
  // ВЪТРЕ в overlay root-а, чийто ограничен родителски stacking context
  // прави дори по-нисък-номер z-index sibling на body да застане визуално
  // над него. initiallyHidden се прилага ВЕДНАГА при DOM element creation
  // (не след flight-а завърши) — same fix pattern като dice overlay-я.
  initiallyHidden: boolean
}

// Резолвва се, когато flight-ът приключи — controller-ът маха overlay-а
// (виж call site-а в createLudoFlowController.ts::animateCapture) и чак
// ТОГАВА чисти presentation override-а, за да не се задублира визуално
// пионката (едновременно на target override-а И в canonical home-а).
export async function playLudoCaptureFlightOverlay(options: LudoCaptureFlightOptions): Promise<void> {
  const { pieceId, fromRect, toRect, pieceSizePx, initiallyHidden } = options
  const fromX = fromRect.left + fromRect.width / 2
  const fromY = fromRect.top + fromRect.height / 2
  const toX = toRect.left + toRect.width / 2
  const toY = toRect.top + toRect.height / 2

  const container = document.createElement('div')
  container.setAttribute('data-ludo-capture-flight', pieceId)
  container.style.cssText = `
    position:fixed;
    left:${fromX}px; top:${fromY}px;
    width:${pieceSizePx}px;
    transform:translate(-50%, -50%);
    z-index:${LUDO_CAPTURE_FLIGHT_Z_INDEX};
    pointer-events:none;
    visibility:${initiallyHidden ? 'hidden' : 'visible'};
  `
  // selectable=false (никога clickable по време на flight), count=1 (винаги
  // единична пионка тук — stack-ът вече се разпада в отделни flight-ове,
  // виж controller-а).
  container.innerHTML = renderLudoPieceHtml(pieceId, false, 1, [pieceId])
  document.body.appendChild(container)

  const flightAnimation = container.animate(
    [
      { left: `${fromX}px`, top: `${fromY}px`, opacity: 1, offset: 0 },
      { left: `${toX}px`, top: `${toY}px`, opacity: 1, offset: 1 },
    ],
    { duration: FLIGHT_DURATION_MS, easing: 'cubic-bezier(0.3, 0.6, 0.35, 1)', fill: 'forwards' },
  )

  await flightAnimation.finished
  container.remove()
}
