// Контролер за Ludo visual prototype — държи mock state, mount-ва екрана в
// root елемента, wire-ва клик събития (piece select, roll dice, bottom bar).
// Изцяло frontend simulation: няма WebSocket, няма реален engine, няма
// database. Следва controller pattern-а от lobby/activeRoom (state обект +
// render() + querySelectorAll wiring), но е напълно изолиран от техния код.

import { isPhoneLayoutViewport } from '../../../ui/layout/viewportStage'
import { renderLudoGameScreen, applyLudoBoardContent, type LudoGameScreenState } from './renderLudoGameScreen'
import { renderLudoMockPopup } from './renderLudoBottomBar'
import { createLudoMockPlayers, createLudoMockPieces, createLudoMockLegalMoves } from './mock/ludoMockState'
import { buildLudoMoveRoute } from './board/ludoMoveRoute'
import { rollLudoMockDiceResult, computeLudoDiceThrowTransform } from './dice/ludoDiceState'
import type { LudoDiceFace } from './dice/ludoDiceState'
import type { LudoCellId, LudoColor, LudoLegalMove, LudoPiece, LudoPieceId } from './ludoTypes'

const MOCK_TURN_SECONDS = 20
const STEP_ANIMATION_MS = 220
const IMPACT_ANIMATION_MS = 450

const EMOJI_MOCK_ITEMS = ['😀', '😂', '😮', '😢', '😡', '👍', '👏', '🎉']
const PHRASE_MOCK_ITEMS = ['Браво!', 'Добър ход!', 'Late удар!', 'Хайде пак!', 'Извинявай!', 'Дай шест!']

export interface LudoFlowControllerOptions {
  root: HTMLElement
  onExit: () => void
}

export function createLudoFlowController(options: LudoFlowControllerOptions) {
  const players = createLudoMockPlayers()
  let pieces: LudoPiece[] = createLudoMockPieces()
  let legalMoves: LudoLegalMove[] = createLudoMockLegalMoves()
  let activeColor: LudoColor = 'red'
  let diceResult: LudoDiceFace | null = null
  let diceRotation = { x: 0, y: 0 }
  let isDiceRolling = false
  let canRollDice = true
  let isAnimatingMove = false
  let activePopup: 'emoji' | 'phrase' | null = null

  function currentScreenState(): LudoGameScreenState {
    return {
      players,
      pieces,
      legalMoves: isAnimatingMove ? [] : legalMoves,
      activeColor,
      diceResult,
      diceRotation,
      isDiceRolling,
      canRollDice: canRollDice && !isAnimatingMove,
      turnSecondsLeft: MOCK_TURN_SECONDS,
      useMobileLayout: isPhoneLayoutViewport(),
    }
  }

  function render(): void {
    options.root.innerHTML = renderLudoGameScreen(currentScreenState())
    applyLudoBoardContent(options.root, currentScreenState())
    if (activePopup) mountPopup(activePopup)
    wireEvents()
  }

  function mountPopup(kind: 'emoji' | 'phrase'): void {
    const container = document.createElement('div')
    container.innerHTML = renderLudoMockPopup(
      kind === 'emoji' ? 'Емоджита' : 'Фрази',
      kind === 'emoji' ? EMOJI_MOCK_ITEMS : PHRASE_MOCK_ITEMS,
    )
    const backdrop = container.firstElementChild
    if (backdrop) options.root.appendChild(backdrop)
  }

  function closePopup(): void {
    activePopup = null
    const backdrop = options.root.querySelector('[data-ludo-mock-popup-backdrop="1"]')
    backdrop?.remove()
  }

  function wireEvents(): void {
    options.root.querySelector('[data-ludo-exit-button="1"]')?.addEventListener('click', () => {
      options.onExit()
    })

    options.root.querySelector('[data-ludo-dice-roll-button="1"]')?.addEventListener('click', () => {
      void handleRollDice()
    })

    options.root.querySelector('[data-ludo-emoji-button="1"]')?.addEventListener('click', () => {
      activePopup = 'emoji'
      mountPopup('emoji')
      wirePopupEvents()
    })

    options.root.querySelector('[data-ludo-phrase-button="1"]')?.addEventListener('click', () => {
      activePopup = 'phrase'
      mountPopup('phrase')
      wirePopupEvents()
    })

    options.root.querySelectorAll<HTMLElement>('[data-ludo-piece-selectable="1"]').forEach((el) => {
      el.addEventListener('click', () => {
        const pieceId = el.getAttribute('data-ludo-piece') as LudoPieceId | null
        if (pieceId) void handlePieceSelected(pieceId)
      })
    })

    window.addEventListener('resize', handleResize)
  }

  function wirePopupEvents(): void {
    options.root.querySelector('[data-ludo-mock-popup-close="1"]')?.addEventListener('click', closePopup)
    options.root.querySelector('[data-ludo-mock-popup-backdrop="1"]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closePopup()
    })
    options.root.querySelectorAll('[data-ludo-mock-popup-item="1"]').forEach((el) => {
      el.addEventListener('click', closePopup)
    })
  }

  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  function handleResize(): void {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => render(), 120)
  }

  async function handleRollDice(): Promise<void> {
    if (!canRollDice || isAnimatingMove) return
    canRollDice = false
    isDiceRolling = true
    const result = rollLudoMockDiceResult()
    diceRotation = computeLudoDiceThrowTransform(result)
    render()

    await wait(950)
    diceResult = result
    isDiceRolling = false
    canRollDice = true
    render()
  }

  async function handlePieceSelected(pieceId: LudoPieceId): Promise<void> {
    if (isAnimatingMove) return
    const move = legalMoves.find((m) => m.pieceId === pieceId)
    if (!move) return

    isAnimatingMove = true
    render()

    const piece = pieces.find((p) => p.id === pieceId)
    if (!piece) {
      isAnimatingMove = false
      render()
      return
    }

    const route = buildLudoMoveRoute(piece.cell, move.targetCell)
    for (const stepCellId of route) {
      piece.cell = stepCellId
      render()
      await wait(STEP_ANIMATION_MS)
    }

    if (move.type === 'capture') {
      await animateCapture(move.targetCell, piece.color)
    }

    legalMoves = []
    isAnimatingMove = false
    render()
  }

  async function animateCapture(targetCellId: LudoCellId, capturingColor: LudoColor): Promise<void> {
    const victim = pieces.find((p) => p.cell === targetCellId && p.color !== capturingColor)
    if (!victim) return

    const victimEl = options.root.querySelector<HTMLElement>(`[data-ludo-piece="${victim.id}"]`)
    victimEl?.style.setProperty('animation', 'ludo-piece-shake 400ms ease-in-out')
    await wait(IMPACT_ANIMATION_MS)

    const homeSlot = pieces.filter((p) => p.color === victim.color && p.cell.startsWith('home-')).length
    victim.cell = `home-${victim.color}-${Math.min(homeSlot, 3)}`
    render()
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function destroy(): void {
    window.removeEventListener('resize', handleResize)
    if (resizeTimer) clearTimeout(resizeTimer)
  }

  render()

  return { destroy }
}
