// Контролер за Ludo visual prototype — mount-ва екрана в root елемента,
// wire-ва клик събития (piece select, roll dice, bottom bar). Canonical
// game state/turn logic живее в pure engine слоя (engine/) — контролерът
// е adapter между dispatch(action) и текущия string-based renderer, плюс
// presentation-only state (route animation buffer, landed dice overlay,
// countdown timestamps, interaction locks), което engine-ът съзнателно не
// познава.
//
// Engine flow: ROLL_STARTED -> (external RNG) -> ROLL_RESOLVED(value) ->
// awaiting_move_selection -> MOVE_REQUESTED(slot) -> canonical result/events.
// Engine-ът мутира state-а МОМЕНТАЛНО при dispatch — никога не чака
// анимация. Route stepping animation-ът е ЧИСТО presentation: контролерът
// изчислява route-а от stateBefore/stateAfter и показва движещата се
// пионка на междинна визуална позиция чрез presentation override, докато
// canonical engine state вече е финален (виж movingPieceOverrideCell по-
// долу) — presentation frame state ≠ canonical state.
//
// Все още няма WebSocket/database — engine-ът е готов за server reuse
// по-късно, но тук се вика directno, синхронно, в браузъра.

import { isPhoneLayoutViewport } from '../../../ui/layout/viewportStage'
import { renderLudoGameScreen, applyLudoBoardContent, type LudoGameScreenState } from './renderLudoGameScreen'
import { renderLudoMockPopup } from './renderLudoBottomBar'
import { createLudoMockPlayers } from './mock/ludoMockState'
import { buildLudoMoveRoute } from './board/ludoMoveRoute'
import { rollLudoMockDiceResult } from './dice/ludoDiceState'
import { createLudoDiceResultOverlayController } from './dice/playLudoDiceFlightOverlay'
import { reduceLudoGame } from './engine/ludoEngineReducer'
import { createLudoEngineInitialState } from './engine/ludoEngineState'
import {
  ludoEnginePiecesToUiPieces,
  ludoEngineLegalMovesToUiMoves,
  ludoEnginePositionToCellId,
  ludoUiPieceIdToSlot,
} from './engine/ludoEngineAdapter'
import type { LudoGameState } from './engine/ludoEngineTypes'
import type { LudoEngineAction } from './engine/ludoEngineActions'
import type { LudoCellId, LudoPiece, LudoPieceId } from './ludoTypes'

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

  // Canonical game state — ЕДИНСТВЕНИЯТ source of truth за pieces/
  // activeColor/turnPhase/diceValue/legalMoves. Мутира се ИЗКЛЮЧИТЕЛНО
  // чрез dispatch() -> reduceLudoGame(); контролерът никога не пипа тези
  // полета directno.
  let engineState: LudoGameState = createLudoEngineInitialState()

  // ---- PRESENTATION-ONLY state (engine-ът не знае нищо за тях) ----
  // Момент (Date.now()), в който активният играч е получил хода си —
  // deadline-базирана основа за countdown fill-а в player card-а (виж
  // renderLudoPlayerPanel), НЕ JS tick брояч. Reset-ва се при TURN_ADVANCED.
  let turnStartedAt = Date.now()
  let isDiceRolling = false
  let isAnimatingMove = false
  let activePopup: 'emoji' | 'phrase' | null = null
  // Presentation route buffer: докато движеща се пионка still-steps по
  // маршрута си, engine-ът ВЕЧЕ показва финалната ѝ позиция (dispatch е
  // synchronous и моментален). За да не "телепортира" визуално пионката,
  // за времетраенето на анимацията override-ваме САМО нейната cell в
  // adapted UI pieces масива — presentation frame, никога записан обратно
  // в engineState. null означава "няма активна route анимация в момента".
  let movingPieceOverride: { pieceId: LudoPieceId; cellId: LudoCellId } | null = null
  // "Кацналото" зарче в центъра на дъската (document.body overlay) — живее
  // СПРЯМО ХОДА (roll → избор на пионка → move/capture animation), не
  // спрямо render() цикъла или следващото хвърляне: playFlight/clearLanded
  // са единственото място, което пипа неговия DOM (виж
  // playLudoDiceFlightOverlay.ts — createLudoDiceResultOverlayController).
  // Не е част от LudoGameScreenState.
  const diceResultOverlay = createLudoDiceResultOverlayController()

  // Единствената точка, през която engineState се променя — reject-натите
  // действия (грешен player, wrong phase, stale turnVersion) връщат СЪЩИЯ
  // state reference (виж reduceLudoGame contract), затова dispatch просто
  // презаписва engineState безусловно и връща events-а за евентуална
  // допълнителна логика (анимации в отговор на event-ите, не engine-ът
  // чакащ анимация — виж task-а т.7).
  function dispatch(action: LudoEngineAction) {
    const result = reduceLudoGame(engineState, action)
    engineState = result.state
    return result
  }

  // Прилага presentation route buffer-а върху canonical adapted pieces —
  // ЕДИНСТВЕНОТО място, където presentation override докосва piece
  // позиция за render. Engine pieces масивът остава недокоснат.
  function currentUiPieces(): LudoPiece[] {
    const uiPieces = ludoEnginePiecesToUiPieces(engineState.pieces)
    if (!movingPieceOverride) return uiPieces
    return uiPieces.map((p) =>
      p.id === movingPieceOverride!.pieceId ? { ...p, cell: movingPieceOverride!.cellId } : p,
    )
  }

  function currentScreenState(): LudoGameScreenState {
    return {
      players,
      pieces: currentUiPieces(),
      // По време на анимация не показваме legal-move highlights/capture
      // ring-ове — вече е избран конкретен ход, engine-ът е в turn_complete
      // (legalMoves вече е [] там), но пазим explicit guard-а тук за яснота.
      legalMoves: isAnimatingMove ? [] : ludoEngineLegalMovesToUiMoves(engineState.legalMoves),
      activeColor: engineState.activeColor,
      turnStartedAt,
      isDiceRolling,
      // Interaction lock: DOM disabled state следва engine turnPhase, но
      // НЕ е authoritative за правилата — engine stale-action защитата
      // (turnVersion) е вторият защитен слой (виж task-а т.9).
      canRollDice: engineState.turnPhase === 'waiting_for_roll' && !isAnimatingMove,
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
    // Interaction lock (т.9): дублиращ click по време на flight/move/
    // capture анимация се игнорира тук, ПРЕДИ да опитаме dispatch. Engine
    // turnPhase guard-ът е вторият, authoritative защитен слой.
    if (engineState.turnPhase !== 'waiting_for_roll' || isAnimatingMove) return

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

    const rollingColor = engineState.activeColor
    const rollStarted = dispatch({
      type: 'ROLL_STARTED',
      color: rollingColor,
      expectedTurnVersion: engineState.turnVersion,
    })
    // ROLL_STARTED rejected (грешен player/phase/stale turnVersion) — не би
    // трябвало да се случи зад вече минатия DOM guard по-горе, но engine-ът
    // остава authoritative: rejected -> без визуален ефект.
    if (rollStarted.state.turnPhase !== 'rolling') return

    // Само едно "кацнало" зарче видимо в даден момент — премахваме
    // предходния резултат веднага при ново хвърляне. (playFlight също
    // прави собствен clearLanded() отвътре, но правим го и тук изрично, за
    // да изчезне старият резултат СРЕЩУ launcher-а веднага при click, не
    // едва когато новият полет приключи.)
    diceResultOverlay.clearLanded()

    isDiceRolling = true
    render()

    // External RNG (Math.random остава ИЗВЪН engine-а) — резултатът е
    // INPUT към ROLL_RESOLVED, не engine-ът сам хвърля зара (виж task-а т.7).
    const result = rollLudoMockDiceResult()
    // Полет + 3D завъртане до правилната страна, визуализирано изцяло в
    // overlay-а (виж playLudoDiceFlightOverlay.ts) — player card launcher-ът
    // междувременно остава напълно статичен (само стрелките спират, виж
    // isDiceRolling по-горе). Резолвва се едва след кацването; зарчето
    // остава видимо в центъра ПОСЛЕ това (виж handlePieceSelected за
    // единственото място, което го маха — след завършен ход).
    await diceResultOverlay.playFlight({ fromRect, toRect, boardGridWidthPx, result })

    // ROLL_RESOLVED мества engine-а в awaiting_move_selection (или директно
    // turn_complete, ако няма legal moves) и изчислява legalMoves —
    // canonical, deterministic, виж ludoEngineLegalMoves.ts.
    const rollResolved = dispatch({
      type: 'ROLL_RESOLVED',
      color: rollingColor,
      value: result,
      expectedTurnVersion: engineState.turnVersion,
    })

    isDiceRolling = false
    render()

    // Ако няма legal moves (rare в текущия начален mock state, но engine-ът
    // вече го обработва коректно), ходът е автоматично complete — напред.
    if (rollResolved.state.turnPhase === 'turn_complete') {
      advanceTurn()
    }
  }

  async function handlePieceSelected(pieceId: LudoPieceId): Promise<void> {
    // Interaction lock — виж handleRollDice за същия pattern.
    if (isAnimatingMove) return
    if (engineState.turnPhase !== 'awaiting_move_selection') return

    const slot = ludoUiPieceIdToSlot(pieceId)
    const color = engineState.activeColor
    const move = engineState.legalMoves.find((m) => m.color === color && m.slot === slot)
    if (!move) return

    // stateBefore — за да изчислим route-а от РЕАЛНАТА текуща позиция
    // (виж task-а т.5 стъпка 1/4).
    const movingPieceBefore = engineState.pieces.find((p) => p.color === color && p.slot === slot)
    if (!movingPieceBefore) return
    const fromCellId = ludoEnginePositionToCellId(movingPieceBefore.position, color)

    isAnimatingMove = true
    render()

    // Engine-ът мутира state-а МОМЕНТАЛНО тук (dispatch е synchronous) —
    // не чака анимацията (виж task-а т.4/т.5 стъпки 2-3). stateAfter вече е
    // canonical final state; capture (ако има) вече е приложен.
    const moveResult = dispatch({ type: 'MOVE_REQUESTED', color, slot, expectedTurnVersion: engineState.turnVersion })
    const capturedEvent = moveResult.events.find((e) => e.type === 'pieces_captured')
    const capturedPieceIds = capturedEvent && capturedEvent.type === 'pieces_captured' ? capturedEvent.capturedPieceIds : []

    if (move.targetPosition.kind !== 'track') {
      isAnimatingMove = false
      render()
      return
    }
    const targetCellId = ludoEnginePositionToCellId(move.targetPosition, color)

    // Route stepping е ЧИСТО presentation (виж task-а т.5 стъпки 5-6):
    // canonical engine state вече е final, движим само movingPieceOverride
    // през междинните клетки на route-а, render() при всяка стъпка показва
    // presentation frame-а (adapted engine pieces + override), НЕ мутация
    // на engine.pieces.
    const route = buildLudoMoveRoute(fromCellId, targetCellId)
    for (const stepCellId of route) {
      movingPieceOverride = { pieceId, cellId: stepCellId }
      render()
      await wait(STEP_ANIMATION_MS)
    }

    if (capturedPieceIds.length > 0) {
      await animateCapture(capturedPieceIds)
    }

    // Ходът е ЗАВЪРШЕН (стъпките + евентуалния capture) — зарчето в
    // центъра вече няма причина да стои. Presentation override-ът се маха
    // (т.5 стъпка 8) — renderer-ът показва canonical final state оттук
    // нататък.
    diceResultOverlay.clearLanded()

    movingPieceOverride = null
    isAnimatingMove = false
    render()

    advanceTurn()
  }

  // Удря ВСИЧКИ противникови пионки, чиито id-та идват директно от
  // pieces_captured.capturedPieceIds (виж task-а т.2 — engine-ът вече знае
  // точно кои real pieces са captured, никакво color/slot guessing тук).
  async function animateCapture(capturedPieceIds: readonly LudoPieceId[]): Promise<void> {
    // ЕДИН общ impact момент за цялата target клетка (не N последователни
    // shake-а един след друг) — всички victim DOM елементи получават
    // анимацията едновременно, после ЕДНО общо изчакване. Stacked victims
    // от същия цвят споделят един и същ representative DOM node (виж
    // renderLudoPieces.ts), затова dedupe-ваме елементите, не victim-ите.
    const victimEls = capturedPieceIds
      .map((id) =>
        options.root.querySelector<HTMLElement>(
          `[data-ludo-piece="${id}"], [data-ludo-piece-group~="${id}"]`,
        ),
      )
      .filter((el): el is HTMLElement => el !== null)
    const uniqueVictimEls = Array.from(new Set(victimEls))
    uniqueVictimEls.forEach((el) => el.style.setProperty('animation', 'ludo-piece-shake 400ms ease-in-out'))
    await wait(IMPACT_ANIMATION_MS)
    // Canonical victim positions вече са home (engine-ът приложи capture-а
    // синхронно при dispatch по-горе) — следващият render() (в
    // handlePieceSelected след тази функция) показва финалния резултат.
  }

  // Автоматично напредва хода след завършен move (или след roll без legal
  // moves) — MOCK_TURN_SECONDS countdown UI все още не задейства реално
  // turn timeout (extra roll on 6, capture extra roll, finish rules — извън
  // Phase 2 обхвата), но explicit TURN_ADVANCED след всеки завършен ход
  // прави prototype-а playable за демонстрация на последователни ходове от
  // всичките 4 цвята (виж task-а т.8).
  function advanceTurn(): void {
    const result = dispatch({
      type: 'TURN_ADVANCED',
      color: engineState.activeColor,
      expectedTurnVersion: engineState.turnVersion,
    })
    if (result.events.some((e) => e.type === 'turn_advanced')) {
      turnStartedAt = Date.now()
    }
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
