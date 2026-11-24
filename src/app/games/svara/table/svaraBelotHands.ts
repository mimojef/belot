// Свара — картите на играчите като в Белот (Етап 4А, само телефон/портрет).
//
// Същите размери, мащабиране и разположение спрямо профилните карета като
// ветрилата в Белот (activeRoom/cutting/renderCuttingSeatPanels.ts:
// renderPanelDealtCard / getFanOffset / renderPanelCardFanWrapper) на телефон:
//   • противници — карта 195×284 (PANEL_CARD_WIDTH/HEIGHT) × panelScale,
//     компактното телефонно ветрило (стъпка 42, наклон 3.4°, спад 20), завъртяно
//     горе 180°, отляво 90°, отдясно −90°, зад карето;
//   • собствените — 211×307 (BOTTOM_HAND_MOBILE_CARD_*) × panelScale ×
//     getBottomHandMobileFanScale(panelScale), ветрило със стъпка 70, наклон 5°;
//   • центровете на ветрилата спрямо котвата на карето (fanCenterX/Y на Белот за
//     телефон), преизчислени спрямо центъра на видимото каре.
// Белот не се променя — константите, които не са експортирани там, са
// повторени тук с препратка към източника.

import { getHandFanOffset, HAND_FAN_EDGE_DROP, HAND_FAN_ROTATION_STEP } from '../../../activeRoom/handFanGeometry'
import {
  BOTTOM_HAND_MOBILE_CARD_HEIGHT,
  BOTTOM_HAND_MOBILE_CARD_WIDTH,
  BOTTOM_HAND_MOBILE_CENTER_Y_OFFSET,
  BOTTOM_HAND_MOBILE_SPACING,
  getBottomHandMobileFanScale,
} from '../../../activeRoom/activeRoomShared'
import type { SvaraBelotHandsSpec } from '../scene/svaraSceneLayout'

/** renderCuttingSeatPanels.ts: PANEL_CARD_WIDTH / PANEL_CARD_HEIGHT. */
const PANEL_CARD_WIDTH = 195
const PANEL_CARD_HEIGHT = 284
/** getFanOffset(compact) на телефон: стъпка, спад на краищата, наклон. */
const COMPACT_FAN = { spacing: 42, edgeDropMax: 20, rotationStep: 3.4 }
/** renderPanelCardFanWrapper: mobileSideFanOutset на телефон. */
const MOBILE_SIDE_FAN_OUTSET = 34
/** Каретата (createCuttingSeatPanelHtml): вертикално 186×234 / scale 0.9, долу 360×138 / scale 0.8. */
const SIDE_PANEL = { w: 186, h: 234, k: 0.9 }
const BOTTOM_PANEL = { w: 360, h: 138, k: 0.8 }

/**
 * Геометрията на ръцете за сцената. `cssScale` — мащабът на каретата в CSS px на
 * сцената (svaraBelotCardScale); `visualScale` — същият мащаб във видими пиксели
 * (= stageScale на Белот за този размер; за телефон zoom = 1 и двата съвпадат).
 */
export function svaraBelotHandsSpec(cssScale: number, visualScale: number): SvaraBelotHandsSpec {
  const s = cssScale
  const bottomFanScale = getBottomHandMobileFanScale(visualScale)
  // Центровете на ветрилата в координатите на котвата на Белот (телефон)…
  const topFanY = SIDE_PANEL.h + PANEL_CARD_HEIGHT / 2 + 8 - 300
  const leftFanX = SIDE_PANEL.w + PANEL_CARD_WIDTH / 2 + 12 - 200 - MOBILE_SIDE_FAN_OUTSET
  const rightFanX = -(PANEL_CARD_WIDTH / 2 + 12) + 200 + MOBILE_SIDE_FAN_OUTSET
  const ownFanY = (-PANEL_CARD_HEIGHT / 2 - 8 + 200) + BOTTOM_HAND_MOBILE_CENTER_Y_OFFSET
  // …спрямо центъра на видимото каре (вътрешният scale с transform-origin на Белот).
  const sideCenter = {
    top: { x: SIDE_PANEL.w / 2, y: (SIDE_PANEL.h * SIDE_PANEL.k) / 2 },
    left: { x: (SIDE_PANEL.w * SIDE_PANEL.k) / 2, y: SIDE_PANEL.h / 2 },
    right: { x: SIDE_PANEL.w - (SIDE_PANEL.w * SIDE_PANEL.k) / 2, y: SIDE_PANEL.h / 2 },
  }
  const bottomCenter = { x: BOTTOM_PANEL.w / 2, y: BOTTOM_PANEL.h - (BOTTOM_PANEL.h * BOTTOM_PANEL.k) / 2 }
  const scaled = (o: { x: number; y: number; rotate: number }) => ({ x: o.x * s, y: o.y * s, rotate: o.rotate })
  return {
    oppCard: { w: PANEL_CARD_WIDTH * s, h: PANEL_CARD_HEIGHT * s },
    ownCard: { w: BOTTOM_HAND_MOBILE_CARD_WIDTH * bottomFanScale * s, h: BOTTOM_HAND_MOBILE_CARD_HEIGHT * bottomFanScale * s },
    fanCenter: {
      top: { x: 0, y: (topFanY - sideCenter.top.y) * s },
      left: { x: (leftFanX - sideCenter.left.x) * s, y: 0 },
      right: { x: (rightFanX - sideCenter.right.x) * s, y: 0 },
      bottom: { x: 0, y: (ownFanY - bottomCenter.y) * s },
    },
    fanRotation: { top: 180, left: 90, right: -90, bottom: 0 },
    oppFan: (index, count) => scaled(getHandFanOffset(index, count, COMPACT_FAN)),
    ownFan: (index, count) => scaled(getHandFanOffset(index, count, {
      spacing: BOTTOM_HAND_MOBILE_SPACING * bottomFanScale,
      edgeDropMax: HAND_FAN_EDGE_DROP,
      rotationStep: HAND_FAN_ROTATION_STEP,
      edgeDropScale: bottomFanScale,
    })),
    // Разкриване при сравняване — същото компактно ветрило, изправено, върху карето.
    revealFan: (index, count) => scaled(getHandFanOffset(index, count, COMPACT_FAN)),
  }
}
