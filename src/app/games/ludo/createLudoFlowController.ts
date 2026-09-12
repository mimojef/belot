// Контролер за Ludo visual prototype — държи mock state, mount-ва екрана в
// root елемента, wire-ва клик събития (piece select, roll dice, bottom bar).
// Изцяло frontend simulation: няма WebSocket, няма реален engine, няма
// database. Следва controller pattern-а от lobby/activeRoom (state обект +
// render() + querySelectorAll wiring), но е напълно изолиран от техния код.

import { isPhoneLayoutViewport } from '../../../ui/layout/viewportStage'
import { renderLudoGameScreen, applyLudoBoardContent, type LudoGameScreenState } from './renderLudoGameScreen'
import { renderLudoMockPopup } from './renderLudoBottomBar'
import { createLudoMockPlayers, createLudoMockPieces } from './mock/ludoMockState'
import { buildLudoMoveRoute } from './board/ludoMoveRoute'
import { computeLudoLegalMoves } from './board/computeLudoLegalMoves'
import { findLudoCaptureVictims, applyLudoCaptureToHome } from './board/resolveLudoCapture'
import { rollLudoMockDiceResult } from './dice/ludoDiceState'
import { createLudoDiceResultOverlayController } from './dice/playLudoDiceFlightOverlay'
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
  // Празни, докато няма хвърлен зар — виж handleRollDice. Преди първо
  // хвърляне не трябва да има selectable пионки/highlights/capture ring
  // (виж audit-а: старите hardcoded legalMoves нарушаваха точно това).
  let legalMoves: LudoLegalMove[] = []
  let activeColor: LudoColor = 'red'
  // Момент (Date.now()), в който активният играч е получил хода си —
  // deadline-базирана основа за countdown fill-а в player card-а (виж
  // renderLudoPlayerPanel), НЕ JS tick брояч. Персистира през render() call-ове,
  // предизвикани от несвързани причини (resize, dice roll, piece move
  // animation) — countdown-ът визуално НЕ трябва да рестартира при тях
  // (виж audit-а: старата реализация не защитаваше срещу точно това — при
  // всеки re-render countdown-fill div-ът е нов DOM node и CSS animation-ът
  // му тръгва отначало, освен ако не му се подаде правилен animation-delay).
  // При бъдещо реално turn-advancement (извън обхвата тук) присвояването на
  // нов activeColor ТРЯБВА да reset-не и turnStartedAt = Date.now().
  let turnStartedAt = Date.now()
  let isDiceRolling = false
  let canRollDice = true
  let isAnimatingMove = false
  let activePopup: 'emoji' | 'phrase' | null = null
  // "Кацналото" зарче в центъра на дъската (document.body overlay) — живее
  // СПРЯМО ХОДА (roll → избор на пионка → move/capture animation), не
  // спрямо render() цикъла или следващото хвърляне: playFlight/clearLanded
  // са единственото място, което пипа неговия DOM (виж
  // playLudoDiceFlightOverlay.ts — createLudoDiceResultOverlayController).
  // Не е част от LudoGameScreenState.
  const diceResultOverlay = createLudoDiceResultOverlayController()

  function currentScreenState(): LudoGameScreenState {
    return {
      players,
      pieces,
      legalMoves: isAnimatingMove ? [] : legalMoves,
      activeColor,
      turnStartedAt,
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
    resizeTimer = setTimeout(() => {
      // Layout-ът (и с него board центърът) се измества при resize —
      // "кацналото" зарче е position:fixed на замразени viewport
      // координати, затова вече не би стояло подравнено с новия board
      // център. По-просто и коректно да изчезне, отколкото да остане
      // визуално разминато до следващото хвърляне.
      diceResultOverlay.clearLanded()
      render()
    }, 120)
  }

  async function handleRollDice(): Promise<void> {
    if (!canRollDice || isAnimatingMove) return
    // Launcher-ът (data-ludo-dice-roll-button), центърът на дъската
    // (data-ludo-board-center) и самата board grid (data-ludo-board, за
    // responsive dice sizing — виж playLudoDiceFlightOverlay.ts) трябва да
    // се измерят ПРЕДИ render()-а долу — render() маха isRollable→false
    // клона, значи самият launcher елемент (с това ИМЕ на атрибута)
    // изчезва от DOM-а веднага след него.
    const triggerEl = options.root.querySelector<HTMLElement>('[data-ludo-dice-roll-button="1"]')
    const centerEl = options.root.querySelector<HTMLElement>('[data-ludo-board-center="1"]')
    const boardGridEl = options.root.querySelector<HTMLElement>('[data-ludo-board="1"]')
    if (!triggerEl || !centerEl || !boardGridEl) return
    const fromRect = triggerEl.getBoundingClientRect()
    const toRect = centerEl.getBoundingClientRect()
    const boardGridWidthPx = boardGridEl.getBoundingClientRect().width

    // Само едно "кацнало" зарче видимо в даден момент — премахваме
    // предходния резултат веднага при ново хвърляне. (playFlight също
    // прави собствен clearLanded() отвътре, но правим го и тук изрично, за
    // да изчезне старият резултат СРЕЩУ launcher-а веднага при click, не
    // едва когато новият полет приключи.)
    diceResultOverlay.clearLanded()

    canRollDice = false
    isDiceRolling = true
    render()

    const result = rollLudoMockDiceResult()
    // Полет + 3D завъртане до правилната страна, визуализирано изцяло в
    // overlay-а (виж playLudoDiceFlightOverlay.ts) — player card launcher-ът
    // междувременно остава напълно статичен (само стрелките спират, виж
    // isDiceRolling по-горе). Резолвва се едва след кацването; зарчето
    // остава видимо в центъра ПОСЛЕ това (виж handlePieceSelected за
    // единственото място, което го маха — след завършен ход).
    await diceResultOverlay.playFlight({ fromRect, toRect, boardGridWidthPx, result })

    // Legal moves се пресмятат ЕДИНСТВЕНО тук, СЛЕД кацването — само за
    // играча на ход (activeColor === currentPlayerId в този mock) и само
    // спрямо реално показания dice резултат. targetTrackIndex =
    // (currentTrackIndex + diceValue) % LUDO_TRACK_LENGTH, capture само ако
    // противникова пионка стои точно на target-а — виж computeLudoLegalMoves.
    legalMoves = computeLudoLegalMoves(pieces, activeColor, result)
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

    // Ходът е ЗАВЪРШЕН (стъпките + евентуалния capture) — зарчето в
    // центъра вече няма причина да стои (виж task-а: не чакай следващото
    // хвърляне, махни го веднага тук, след целия move/capture sequence).
    diceResultOverlay.clearLanded()

    legalMoves = []
    isAnimatingMove = false
    render()
  }

  // Удря ВСИЧКИ противникови пионки на target клетката, не само първата
  // намерена (виж task-а — ако target-ът е stack от 2-4 противникови
  // пионки, всички се прибират, не само visual representative-а). Own-
  // color пионки на target-а НЕ се пипат — те просто образуват/растат
  // stack с пристигащата пионка (виж handlePieceSelected — move.type е
  // 'capture' само ако computeLudoLegalMoves намери поне 1 opponent на
  // target-а; victims тук филтрира по цвят defensively, независимо колко
  // различни opponent цвята евентуално се окажат на same cell).
  async function animateCapture(targetCellId: LudoCellId, capturingColor: LudoColor): Promise<void> {
    const victims = findLudoCaptureVictims(pieces, targetCellId, capturingColor)
    if (victims.length === 0) return

    // ЕДИН общ impact момент за цялата target клетка (не N последователни
    // shake-а един след друг) — всички victim DOM елементи получават
    // анимацията едновременно, после ЕДНО общо изчакване. Stacked victims
    // от същия цвят споделят един и същ representative DOM node (виж
    // renderLudoPieces.ts), затова dedupe-ваме елементите, не victim-ите.
    const victimEls = victims
      .map((victim) =>
        options.root.querySelector<HTMLElement>(
          `[data-ludo-piece="${victim.id}"], [data-ludo-piece-group~="${victim.id}"]`,
        ),
      )
      .filter((el): el is HTMLElement => el !== null)
    const uniqueVictimEls = Array.from(new Set(victimEls))
    uniqueVictimEls.forEach((el) => el.style.setProperty('animation', 'ludo-piece-shake 400ms ease-in-out'))
    await wait(IMPACT_ANIMATION_MS)

    // Реалната state мутация (кой отива на кой home slot) живее в
    // resolveLudoCapture.ts — чист, независимо тестваем модул (виж
    // task-а за deterministic checks).
    applyLudoCaptureToHome(victims)
    render()
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function destroy(): void {
    window.removeEventListener('resize', handleResize)
    if (resizeTimer) clearTimeout(resizeTimer)
    diceResultOverlay.clearLanded()
  }

  render()

  return { destroy }
}
