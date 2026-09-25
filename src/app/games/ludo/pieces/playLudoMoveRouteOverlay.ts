import { renderLudoPieceHtml } from './renderLudoPieces'
import type { LudoCellId, LudoPieceId } from '../ludoTypes'
import { ludoSafeCellIds, parseLudoCellId } from '../board/ludoBoardGeometry'
import { LUDO_FINISH_LENGTH } from '../ludoGeometryConstants'
import { playLudoSound } from '../ludoSoundSettings'

const MOVE_TRAVEL_MS = 165
const STEP_TOTAL_MS = 260
const TRAIL_FADE_MS = 320
const EARLY_TRAVEL_SCALE = 1.08
const MID_TRAVEL_SCALE = 1.23

const PAWN_STEP_SOUND_SRC = '/audio/ludo/pawn-step.mp3'
const STAR_LANDING_SOUND_SRC = '/audio/ludo/star-landing.mp3'
const TRIANGLE_ENTRY_SOUND_SRC = '/audio/ludo/triangle-entry.mp3'
const END_GAME_SOUND_SRC = '/audio/ludo/end-game.mp3'
const PAWN_EXIT_BASE_SOUND_SRC = '/audio/ludo/pawn-exit-base.mp3'

// Canonical star/safe cell membership — reuse-ва СЪЩИЯ source of truth като
// board rendering-а (ludoSafeCellIds() -> LUDO_SAFE_TRACK_INDICES в
// ludoGeometryConstants.ts, споделен и с capture eligibility в
// engine/ludoEngineLegalMoves.ts). Изчислено ВЕДНЪЖ на module load (списъкът
// е статичен — 4 индекса, по един на цвят), не пресмятано наново на всяка
// route стъпка. Set за O(1) membership check вместо Array.includes().
const LUDO_SAFE_CELL_ID_SET = new Set(ludoSafeCellIds())

// Минимален presentation audio side effect (не gameplay logic, не мутира
// state) — минава през централния playLudoSound() gate (виж
// ludoSoundSettings.ts), 'gameplay' категория (gate-ната само зад master
// "Звуци в играта", НЕ зад "Звук на зара" — тази настройка засяга
// изключително dice-roll звука). По един нов Audio() instance на всяка
// route стъпка, вместо reused/pooled element. Стъпките се редуват на ~260ms
// (виж STEP_TOTAL_MS), значи предходният playback обикновено още не е
// приключил, когато следва новото стъпване — reset-ване на currentTime на
// споделен елемент би звучало като прекъснат/накъсан звук вместо чист
// повторен "tap"; отделен instance на всяка стъпка позволява
// презастъпващи се опашки да звучат естествено (всеки играе изцяло,
// независимо от следващия). play() rejection (autoplay restriction и т.н.)
// се игнорира тихо — звукът е чисто декоративен, никога не трябва да чупи
// движението.
function playLudoPawnStepSound(): void {
  playLudoSound(PAWN_STEP_SOUND_SRC, 'gameplay')
}

// Star/safe landing вариант — играе се ВМЕСТО pawn-step (никога заедно с
// него, виж call site-а в route loop-а по-долу) само когато финалната
// destination клетка на целия move е canonical safe/star cell. Междинно
// преминаване през star (route има повече клетки след нея) си остава
// нормалният pawn-step звук — star sound маркира "спрях тук", не "минах
// оттук".
function playLudoStarLandingSound(): void {
  playLudoSound(STAR_LANDING_SOUND_SRC, 'gameplay')
}

function playLudoTriangleEntrySound(): void {
  playLudoSound(TRIANGLE_ENTRY_SOUND_SRC, 'gameplay')
}

export function playLudoEndGameSound(): void {
  playLudoSound(END_GAME_SOUND_SRC, 'gameplay')
}

// "Излизане от базата" — играе се ИЗКЛЮЧИТЕЛНО на действието home -> track
// (реален gameplay transition, дадено explicit от caller-а чрез
// options.isLeavingBase — mirror на established sourceIsHome изчисление в
// createLudoFlowController.ts, reuse-нато, НЕ ново/дублирано home detection).
// Умишлено НЕ зависи от coordinate/index на destination клетката (никакво
// LUDO_SAFE_CELL_ID_SET membership check тук) — дори ако собственото начално
// поле съвпада с canonical safe/star cell, тук ЗАДЪЛЖИТЕЛНО играе exit-base
// звукът, не star-landing (виж call site-а в route loop-а по-долу за
// priority реда). Друга пионка, която по-късно стъпи/премине през СЪЩАТА
// клетка чрез нормално track движение, никога не подава isLeavingBase=true —
// получава established pawn-step/star-landing поведение непроменено.
function playLudoPawnExitBaseSound(): void {
  playLudoSound(PAWN_EXIT_BASE_SOUND_SRC, 'gameplay')
}

function isCenterTriangleCell(cellId: LudoCellId): boolean {
  const cell = parseLudoCellId(cellId)
  return cell.kind === 'finish' && cell.slot === LUDO_FINISH_LENGTH - 1
}

export interface LudoMoveRouteOverlayOptions {
  root: ParentNode
  pieceId: LudoPieceId
  fromCellId: LudoCellId
  route: readonly LudoCellId[]
  pieceSizePx: number
  initiallyHidden: boolean
  isGameWinningMove?: boolean
  /**
   * true САМО за home -> track прехода на ТОЗИ конкретен move (пионката
   * реално напуска базата/двора след хвърлена 6) — подадено explicit от
   * caller-а (performMoveSequence/presentAuthoritativeMove), reuse-вайки
   * established `parseLudoCellId(fromCellId).kind === 'home'` изчисление,
   * не нова detection логика тук. buildLudoMoveRoute() гарантира точно 1
   * route стъпка за home->track (виж board/ludoMoveRoute.ts коментара:
   * "излизане от базата няма междинни стъпки") — затова тази проверка е
   * relevant само при stepIndex===0 в route loop-а по-долу.
   */
  isLeavingBase?: boolean
  debugSpeedScale?: number
}

export interface LudoMoveRouteOverlayResult {
  finished: Promise<void>
  cancel: () => void
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function centerRelativeToOverlay(cell: Element, overlay: HTMLElement): { x: number; y: number } {
  const cellRect = cell.getBoundingClientRect()
  const overlayRect = overlay.getBoundingClientRect()
  return {
    x: cellRect.left - overlayRect.left + cellRect.width / 2,
    y: cellRect.top - overlayRect.top + cellRect.height / 2,
  }
}

function cellCenter(root: ParentNode, overlay: HTMLElement, cellId: LudoCellId): { x: number; y: number } | null {
  const cell = root.querySelector(`[data-ludo-cell-pieces="${cellId}"]`)
  if (!cell) return null
  return centerRelativeToOverlay(cell, overlay)
}

function createPieceNode(pieceId: LudoPieceId, pieceSizePx: number, kind: 'moving' | 'trail'): HTMLElement {
  const node = document.createElement('div')
  node.setAttribute(kind === 'moving' ? 'data-ludo-moving-piece' : 'data-ludo-move-trail', pieceId)
  node.style.cssText = `
    position:absolute;
    width:${pieceSizePx}px;
    left:0;
    top:0;
    transform:translate(-50%, -50%);
    transform-origin:center center;
    pointer-events:none;
    will-change:left, top, opacity, transform;
    z-index:${kind === 'moving' ? 80 : 60};
  `
  node.innerHTML = renderLudoPieceHtml(pieceId, false, 1, [pieceId])
  if (kind === 'moving') {
    const renderedPiece = node.querySelector<HTMLElement>(`[data-ludo-piece="${pieceId}"]`)
    if (renderedPiece) {
      // pieceSizePx is already the canonical pawn's rendered width. The shared
      // renderer normally sizes itself to 80% of a cell, so remove that second
      // 80% when it is nested inside this already-sized moving wrapper.
      renderedPiece.style.width = '100%'
      renderedPiece.style.maxWidth = 'none'
    }
  }
  if (kind === 'trail') {
    node.style.opacity = '0.34'
    node.style.filter = 'drop-shadow(0 0 5px currentColor) saturate(1.1)'
  }
  return node
}

function place(node: HTMLElement, point: { x: number; y: number }): void {
  node.style.left = `${point.x}px`
  node.style.top = `${point.y}px`
}

function playTrail(overlay: HTMLElement, pieceId: LudoPieceId, pieceSizePx: number, point: { x: number; y: number }, speedScale: number): Animation | null {
  const trail = createPieceNode(pieceId, pieceSizePx, 'trail')
  place(trail, point)
  overlay.appendChild(trail)
  const animation = trail.animate(
    [
      { opacity: 0.34, transform: 'translate(-50%, -50%) scale(0.96)' },
      { opacity: 0.18, transform: 'translate(-50%, -50%) scale(1.04)', offset: 0.42 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(1.12)' },
    ],
    { duration: TRAIL_FADE_MS * speedScale, easing: 'cubic-bezier(0.2, 0.6, 0.25, 1)', fill: 'forwards' },
  )
  animation.finished.finally(() => trail.remove()).catch(() => trail.remove())
  return animation
}

export function playLudoMoveRouteOverlay(options: LudoMoveRouteOverlayOptions): LudoMoveRouteOverlayResult {
  const { root, pieceId, fromCellId, route, pieceSizePx, initiallyHidden } = options
  const speedScale = Math.max(0.1, options.debugSpeedScale ?? 1)
  const overlay = root.querySelector<HTMLElement>('[data-ludo-effects-overlay="1"]')
  if (!overlay || route.length === 0) return { finished: Promise.resolve(), cancel: () => {} }

  const start = cellCenter(root, overlay, fromCellId)
  if (!start) return { finished: Promise.resolve(), cancel: () => {} }

  const moving = createPieceNode(pieceId, pieceSizePx, 'moving')
  moving.style.visibility = initiallyHidden ? 'hidden' : 'visible'
  place(moving, start)
  overlay.appendChild(moving)

  const trailAnimations: Animation[] = []
  let cancelled = false
  let activeAnimation: Animation | null = null

  const cleanup = () => {
    cancelled = true
    activeAnimation?.cancel()
    for (const animation of trailAnimations) animation.cancel()
    overlay.querySelectorAll(`[data-ludo-moving-piece="${pieceId}"], [data-ludo-move-trail="${pieceId}"]`).forEach((node) => node.remove())
  }

  const finished = (async () => {
    let current = start
    try {
      for (let stepIndex = 0; stepIndex < route.length; stepIndex += 1) {
        const cellId = route[stepIndex]!
        if (cancelled) return
        const next = cellCenter(root, overlay, cellId)
        if (!next) return

        const trail = playTrail(overlay, pieceId, pieceSizePx, current, speedScale)
        if (trail) trailAnimations.push(trail)

        activeAnimation = moving.animate(
          [
            { left: `${current.x}px`, top: `${current.y}px`, transform: 'translate(-50%, -50%) scale(1)' },
            {
              left: `${current.x + (next.x - current.x) * 0.2}px`,
              top: `${current.y + (next.y - current.y) * 0.2}px`,
              transform: `translate(-50%, -50%) scale(${EARLY_TRAVEL_SCALE})`,
              offset: 0.2,
            },
            {
              left: `${current.x + (next.x - current.x) * 0.5}px`,
              top: `${current.y + (next.y - current.y) * 0.5}px`,
              transform: `translate(-50%, -50%) scale(${MID_TRAVEL_SCALE})`,
              offset: 0.5,
            },
            {
              left: `${current.x + (next.x - current.x) * 0.8}px`,
              top: `${current.y + (next.y - current.y) * 0.8}px`,
              transform: `translate(-50%, -50%) scale(${EARLY_TRAVEL_SCALE})`,
              offset: 0.8,
            },
            { left: `${next.x}px`, top: `${next.y}px`, transform: 'translate(-50%, -50%) scale(1)' },
          ],
          { duration: MOVE_TRAVEL_MS * speedScale, easing: 'linear', fill: 'forwards' },
        )
        try {
          await activeAnimation.finished
        } catch {
          return
        }
        if (cancelled) return
        place(moving, next)
        moving.style.transform = 'translate(-50%, -50%) scale(1)'
        const isFinalStep = stepIndex === route.length - 1
        if (isFinalStep && options.isGameWinningMove) {
          playLudoEndGameSound()
        } else if (stepIndex === 0 && options.isLeavingBase) {
          // Priority над triangle/star/pawn-step по-долу — дори ако
          // собственото start поле СЪВПАДА с canonical safe/star cell
          // (typичен Ludo дизайн), самото действие "напусна базата" винаги
          // трябва да звучи различно от "стъпи на star" (established
          // pattern за другите move-specific звуци тук). Не проверява
          // cellId/index — само caller-подадения gameplay signal.
          playLudoPawnExitBaseSound()
        } else if (isFinalStep && isCenterTriangleCell(cellId)) {
          playLudoTriangleEntrySound()
        } else if (isFinalStep && LUDO_SAFE_CELL_ID_SET.has(cellId)) {
          playLudoStarLandingSound()
        } else {
          playLudoPawnStepSound()
        }
        current = next
        await wait(Math.max(0, STEP_TOTAL_MS - MOVE_TRAVEL_MS) * speedScale)
      }
    } finally {
      moving.remove()
    }
  })()

  return { finished, cancel: cleanup }
}
