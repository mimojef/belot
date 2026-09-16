// Браузърна тестова "сглобка" за checkLudoMovementRulesBrowser.ts — кара
// РЕАЛНИЯ createLudoFlowController() (не мокап), зареден през Vite dev
// server, в истински браузър (Playwright). Seed-ва конкретни pieces
// разположения през новия LudoFlowControllerOptions.initialState (виж
// task-а т.21 "temporary seeded/dev harness ако е нужно, не променяй
// permanently normal initial game state само за теста") — production call
// site-ът (createLobbyFlowController.ts) никога не подава тази опция,
// затова нормалният game start остава напълно недокоснат.
//
// Dice randomness (rollLudoMockDiceResult -> Math.random()) се контролира
// тук чрез временен override на window.Math.random — ЕДИНСТВЕНИЯТ начин да
// се получи детерминистичен dice резултат без да се пипа production кода
// (контролерът вика rollLudoMockDiceResult() directно, без injection seam).
import { createLudoFlowController } from '/src/app/games/ludo/createLudoFlowController.ts'
import type { LudoGameState, LudoGamePiece, LudoColor, LudoPieceSlot, LudoPiecePosition } from '/src/app/games/ludo/engine/ludoEngineTypes.ts'

const root = document.createElement('div')
document.body.appendChild(root)

let controller: { destroy: () => void } | null = null
let consoleErrors: string[] = []
window.addEventListener('error', (event) => {
  consoleErrors.push(String(event.message))
})

const COLORS: LudoColor[] = ['red', 'blue', 'yellow', 'green']

function fullRoster(overrides: Record<string, LudoPiecePosition>): LudoGamePiece[] {
  const pieces: LudoGamePiece[] = []
  for (const color of COLORS) {
    for (let slot = 0; slot < 4; slot += 1) {
      const key = `${color}-${slot}`
      const position = overrides[key] ?? { kind: 'home', slot: slot as LudoPieceSlot }
      pieces.push({ color, slot: slot as LudoPieceSlot, position })
    }
  }
  return pieces
}

function makeState(activeColor: LudoColor, overrides: Record<string, LudoPiecePosition>): LudoGameState {
  return {
    turnOrder: ['red', 'blue', 'yellow', 'green'],
    activeColor,
    turnPhase: 'waiting_for_roll',
    diceValue: null,
    legalMoves: [],
    pieces: fullRoster(overrides),
    status: 'in_progress',
    turnVersion: 0,
    pendingExtraRoll: false,
  }
}

function mountWithState(overrides: Record<string, LudoPiecePosition>, activeColor: LudoColor = 'red'): void {
  if (controller) {
    controller.destroy()
    controller = null
  }
  root.innerHTML = ''
  consoleErrors = []
  controller = createLudoFlowController({ root, onExit: () => {}, initialState: makeState(activeColor, overrides) })
}

function destroyController(): void {
  if (controller) {
    controller.destroy()
    controller = null
  }
}

let diceQueue: number[] = []
const originalRandom = Math.random.bind(Math)

// rollLudoMockDiceResult(): Math.floor(Math.random() * 6) + 1 === desired
// <=> Math.random() трябва да е в [(\desired-1)/6, desired/6) — центрираме
// с -0.5, за да сме defensive срещу floating-point ръб.
function randomValueForDiceResult(desired: number): number {
  return (desired - 0.5) / 6
}

function queueDiceValues(values: number[]): void {
  diceQueue = [...values]
  Math.random = () => {
    const next = diceQueue.length > 0 ? diceQueue.shift()! : 1
    return randomValueForDiceResult(next)
  }
}

function restoreDice(): void {
  Math.random = originalRandom
  diceQueue = []
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clickRoll(): void {
  root.querySelector<HTMLButtonElement>('[data-ludo-dice-roll-button="1"]')?.click()
}

function isRollButtonPresent(): boolean {
  return root.querySelector('[data-ludo-dice-roll-button="1"]') !== null
}

function getSelectablePieceIds(): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-ludo-piece-selectable="1"]'))
    .map((el) => el.getAttribute('data-ludo-piece'))
    .filter((value): value is string => value !== null)
}

function clickPiece(pieceId: string): void {
  root.querySelector<HTMLElement>(`[data-ludo-piece-selectable="1"][data-ludo-piece="${pieceId}"]`)?.click()
}

function isPieceOrGroupInCell(pieceId: string, cellId: string): boolean {
  const container = root.querySelector(`[data-ludo-cell-pieces="${cellId}"]`)
  if (!container) return false
  return container.querySelector(`[data-ludo-piece="${pieceId}"], [data-ludo-piece-group~="${pieceId}"]`) !== null
}

function hasHorizontalOverflow(): boolean {
  return document.documentElement.scrollWidth > window.innerWidth + 1
}

function countMovingPieces(pieceId?: string): number {
  const selector = pieceId ? `[data-ludo-moving-piece="${pieceId}"]` : '[data-ludo-moving-piece]'
  return root.querySelectorAll(selector).length
}

function countMoveTrails(pieceId?: string): number {
  const selector = pieceId ? `[data-ludo-move-trail="${pieceId}"]` : '[data-ludo-move-trail]'
  return root.querySelectorAll(selector).length
}

function countRenderedPieceInstances(pieceId: string): number {
  return root.querySelectorAll(`[data-ludo-piece="${pieceId}"], [data-ludo-piece-group~="${pieceId}"]`).length
}

function countStaticPieceInstances(pieceId: string): number {
  return Array.from(root.querySelectorAll<HTMLElement>(`[data-ludo-piece="${pieceId}"], [data-ludo-piece-group~="${pieceId}"]`)).filter(
    (el) => !el.closest('[data-ludo-moving-piece], [data-ludo-move-trail]'),
  ).length
}

;(window as any).__ludoMovementRulesBrowserHarness = {
  mountWithState,
  destroyController,
  queueDiceValues,
  restoreDice,
  wait,
  clickRoll,
  isRollButtonPresent,
  getSelectablePieceIds,
  clickPiece,
  isPieceOrGroupInCell,
  hasHorizontalOverflow,
  countMovingPieces,
  countMoveTrails,
  countRenderedPieceInstances,
  countStaticPieceInstances,
  getConsoleErrors: () => consoleErrors,
}
