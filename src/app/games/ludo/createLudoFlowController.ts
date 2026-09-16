// Контролер за Ludo visual prototype — mount-ва екрана в root елемента,
// wire-ва клик събития (piece select, roll dice, bottom bar), оркестрира
// bot turns и human roll/move timeouts. Canonical game state/turn logic
// живее в pure engine слоя (engine/); timers/deadlines/bot policy живеят в
// orchestrator/ (виж Phase 3A task-а т.2) — и двата НЕ познават DOM/
// Date.now()/setTimeout пряко, контролерът е единственото място, което ги
// свързва с реалния браузър.
//
// Engine flow: ROLL_STARTED -> (external RNG) -> ROLL_RESOLVED(value) ->
// awaiting_move_selection -> MOVE_REQUESTED(slot) -> canonical result/events.
// Engine-ът мутира state-а МОМЕНТАЛНО при dispatch — никога не чака
// анимация/timer. Route stepping animation-ът е ЧИСТО presentation:
// контролерът изчислява route-а от stateBefore/stateAfter и показва
// движещата се пионка на междинна визуална позиция чрез presentation
// override, докато canonical engine state вече е финален.
//
// Bot turns (т.16): bot НЕ чака 10s/15s human timers — при active color =
// bot-controlled, controller-ът стартира кратък presentation "think delay"
// (LUDO_BOT_THINK_DELAY_MS), после сам roll-ва и move-ва през СЪЩИТЕ
// dispatch пътища като human click (никакво дублиране на game rules).
//
// Human timeouts (т.13/14): roll timeout (10s) -> auto-roll вместо human
// (без bot takeover); move timeout (15s) -> bot takeover (sticky flag) +
// popup. Deadlines се пазят с asssociated turnVersion — stale timeout от
// стар ход се игнорира (виж isLudoDeadlineStillValid).
//
// Все още няма WebSocket/database — engine-ът е готов за server reuse
// по-късно (виж task-а т.22), но тук се вика directno, синхронно, в браузъра.

import { isPhoneLayoutViewport } from '../../../ui/layout/viewportStage'
import { renderLudoGameScreen, applyLudoBoardContent, type LudoGameScreenState } from './renderLudoGameScreen'
import { renderLudoMockPopup } from './renderLudoBottomBar'
import { renderLudoBotTakeoverPopup } from './renderLudoBotTakeoverPopup'
import { createLudoMockPlayers } from './mock/ludoMockState'
import { buildLudoMoveRoute } from './board/ludoMoveRoute'
import {
  applyLudoPresentationOverrides,
  createLudoCaptureVictimOverrides,
  clearLudoCaptureVictimOverrides,
  type LudoCaptureVictimOverrides,
} from './board/ludoCapturePresentation'
import { playLudoCaptureFlightOverlay } from './pieces/playLudoCaptureFlightOverlay'
import { playLudoCaptureImpactOverlay } from './pieces/playLudoCaptureImpactOverlay'
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
import type { LudoGameState, LudoPieceSlot } from './engine/ludoEngineTypes'
import type { LudoEngineAction } from './engine/ludoEngineActions'
import {
  createLudoOrchestratorInitialState,
  computeLudoDeadlineStateForPhase,
  isLudoDeadlineStillValid,
  markLudoColorBotControlled,
  resumeLudoHumanControl,
  resolveLudoPendingDeadlineKind,
  pickLudoBotMove,
  LUDO_ROLL_TIMEOUT_MS,
  LUDO_MOVE_TIMEOUT_MS,
  LUDO_BOT_THINK_DELAY_MS,
  type LudoOrchestratorState,
} from './orchestrator'
import type { LudoCellId, LudoColor, LudoPiece, LudoPieceId, LudoPlayer } from './ludoTypes'

const STEP_ANIMATION_MS = 220
const IMPACT_ANIMATION_MS = 450

const EMOJI_MOCK_ITEMS = ['😀', '😂', '😮', '😢', '😡', '👍', '👏', '🎉']
const PHRASE_MOCK_ITEMS = ['Браво!', 'Добър ход!', 'Late удар!', 'Хайде пак!', 'Извинявай!', 'Дай шест!']

export interface LudoFlowControllerOptions {
  root: HTMLElement
  onExit: () => void
  // Test/dev seeding seam (Phase 3B browser verification, виж task-а т.21:
  // "temporary seeded/dev harness ако е нужно, не променяй permanently
  // normal initial game state само за теста") — по подразбиране липсва,
  // controller-ът вика createLudoEngineInitialState() точно както преди.
  // Production call site (createLobbyFlowController.ts) никога не я подава.
  initialState?: LudoGameState
}

export function createLudoFlowController(options: LudoFlowControllerOptions) {
  const players: Record<LudoColor, LudoPlayer> = createLudoMockPlayers()
  const botControlledColorsInitial = new Set<LudoColor>(
    (Object.values(players) as LudoPlayer[]).filter((p) => p.isBot).map((p) => p.color),
  )

  // Canonical game state — ЕДИНСТВЕНИЯТ source of truth за pieces/
  // activeColor/turnPhase/diceValue/legalMoves. Мутира се ИЗКЛЮЧИТЕЛНО
  // чрез dispatch() -> reduceLudoGame(); контролерът никога не пипа тези
  // полета directno.
  let engineState: LudoGameState = options.initialState ?? createLudoEngineInitialState()

  // Orchestrator state (т.2: PRESENTATION/ORCHESTRATION) — bot-controlled
  // flag-ове + roll/move deadlines. Мутира се ИЗКЛЮЧИТЕЛНО чрез
  // computeLudoDeadlineStateForPhase/markLudoColorBotControlled (pure
  // helpers), контролерът само presисва резултата обратно тук.
  let orchestrator: LudoOrchestratorState = createLudoOrchestratorInitialState(botControlledColorsInitial)

  // ---- PRESENTATION-ONLY state (engine-ът не знае нищо за тях) ----
  // Момент (Date.now()), в който активният играч е получил хода си —
  // deadline-базирана основа за countdown fill-а в player card-а (виж
  // renderLudoPlayerPanel), НЕ JS tick брояч. Reset-ва се при всяка нова
  // deadline фаза (roll/move/bot-think).
  let turnStartedAt = Date.now()
  let isDiceRolling = false
  let isAnimatingMove = false
  let activePopup: 'emoji' | 'phrase' | null = null
  // Показва bot-takeover popup-а веднъж, СЛЕД move timeout (т.15) — sticky
  // до следващия път, когато local player-ът получи хода си (не reset-ва
  // се автоматично, аналог на Belot persistent popup).
  let showBotTakeoverPopup = false
  // Presentation route buffer: докато движеща се пионка still-steps по
  // маршрута си, engine-ът ВЕЧЕ показва финалната ѝ позиция (dispatch е
  // synchronous и моментален). За да не "телепортира" визуално пионката,
  // за времетраенето на анимацията override-ваме САМО нейната cell в
  // adapted UI pieces масива — presentation frame, никога записан обратно
  // в engineState. null означава "няма активна route анимация в момента".
  let movingPieceOverride: { pieceId: LudoPieceId; cellId: LudoCellId } | null = null
  // Capture presentation buffer (виж task-а): dispatch(MOVE_REQUESTED) връща
  // МОМЕНТАЛНО final canonical state — captured victims вече са в home-а си
  // в engineState.pieces, ОЩЕ ПРЕДИ attacker-ът визуално да е започнал route
  // анимацията. Без този override victim-ите биха изчезнали от target
  // клетката веднага, много преди attacker-ът реално да "пристигне" отгоре
  // им. Затова, докато presentation route/impact анимацията тече, ВСЕКИ
  // captured piece id тук се "закача" обратно на target клетката (същата,
  // където е стоял преди хода — capture винаги значи victim е бил точно на
  // target-а), независимо от engine-ния home slot. Съдържа >1 запис за stack
  // capture (2-4 real victim pieces на еднa клетка) — badge-ът/целия stack
  // остава видим до impact. Изчиства се едва СЛЕД animateCapture() приключи,
  // точно преди финалния render(), който вече показва canonical home
  // позициите от engine state.
  let captureVictimOverrides: LudoCaptureVictimOverrides = new Map()
  // "Кацналото" зарче в центъра на дъската (document.body overlay) — живее
  // СПРЯМО ХОДА (roll → избор на пионка → move/capture animation), не
  // спрямо render() цикъла или следващото хвърляне: playFlight/clearLanded
  // са единственото място, което пипа неговия DOM (виж
  // playLudoDiceFlightOverlay.ts — createLudoDiceResultOverlayController).
  // Не е част от LudoGameScreenState.
  const diceResultOverlay = createLudoDiceResultOverlayController()
  // Bot-takeover popup layering fix (виж audit-а в mountBotTakeoverPopup по-
  // долу и dice overlay-я setHidden contract-а): capture impact/flight
  // overlay-ите живеят на document.body (sibling на Ludo overlay root-а,
  // не вложен в него), затова popup-ът (mount-нат ВЪТРЕ в overlay root-а) не
  // може да ги покрие само чрез собствения си z-index — same root cause като
  // dice overlay-я, поправен по-рано. Флагът се чете при DOM element
  // creation (initiallyHidden параметър, виж playLudoCaptureImpactOverlay.ts/
  // playLudoCaptureFlightOverlay.ts) — не runtime toggle mid-animation,
  // защото capture sequence-ът е awaited/synchronous спрямо turn state
  // (isAnimatingMove guard-ва paralelни ходове), затова popup-ът винаги е
  // или вече отворен, или все още затворен в момента, в който нов capture
  // overlay реално се създава — никога не се отваря по средата на вече
  // стартирал impact/flight.
  let areGameplayOverlaysHiddenForPopup = false
  // "ВЪРНИ СЕ" reclaim flow (виж task-а): human натиска бутона в bot-
  // takeover popup-а, за да поиска local player-ът да спре да е temporary
  // bot-controlled. НЕ прилагаме resumeLudoHumanControl веднага безусловно —
  // ако bot вече е в средата на собствен roll/move sequence (хвърлил е зара,
  // но още не е избрал ход, или тъкмо мести пионка), моментално отнемане на
  // bot-control би оставило sequence-а "осиротял" по средата (bot-ът вече е
  // commit-нал roll резултат/move избор, но local е вече human, значи никой
  // guard не съвпада правилно — виж т.3 "не прекъсвай активна bot
  // анимация"). Затова: ако в момента на click-а local color-ът реално чака
  // НОВ waiting_for_roll decision (не насред собствен вече-стартирал turn),
  // reclaim-ваме веднага. Иначе само маркираме заявката тук — приложена е
  // безопасно вътре в scheduleNextDeadline() (единствената точка, викана
  // ВИНАГИ на вече завършен state transition, никога по средата на
  // анимация), guard-ната там explicit с turnPhase==='waiting_for_roll', за
  // да не прекъсне bot's roll->move sequence по средата (виж т.4).
  let pendingHumanReclaimColor: LudoColor | null = null

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

  // ЕДИНСТВЕНОТО място в целия Ludo модул, което пресмята "кой съм АЗ" —
  // board perspective (renderLudoBoard), piece stacking z-order
  // (renderLudoPieceCluster) и rollable/reclaim/popup логиката ТУК долу
  // всички четат СЪЩАТА тази константа (директно, или чрез
  // currentScreenState().localColor). Преди fix-а renderLudoGameScreen.ts
  // независимо предефинираше "find first non-bot" отделно — работеше само
  // защото засега има точно 1 non-bot в createLudoMockPlayers() (Иван/red).
  // "find first non-bot" остава единственият наличен сигнал, защото Ludo
  // все още е single-client prototype без реално server/profileId wiring
  // (createLobbyFlowController.ts::openLudoGameOverlay не подава roomId/
  // profileId/seat на createLudoFlowController — виж task-а "AUDIT LOCAL
  // VIEWER IDENTITY": реален multiplayer identity source не съществува
  // архитектурно още). Когато такъв source се появи (server snapshot със
  // seat/profileId), само ТУК трябва да се смени resolution логиката —
  // всичко downstream (render layer, tests) вече чете localColor като
  // explicit подадена стойност, не я пресмята повторно.
  const localColor: LudoColor = (
    (Object.values(players) as LudoPlayer[]).find((p) => !p.isBot)?.color ?? 'red'
  )

  // Прилага presentation override-ите (route buffer за attacker-а, capture
  // buffer за victims) върху canonical adapted pieces — ЕДИНСТВЕНОТО място,
  // където presentation override докосва piece позиция за render. Engine
  // pieces масивът остава недокоснат.
  function currentUiPieces(): LudoPiece[] {
    const uiPieces = ludoEnginePiecesToUiPieces(engineState.pieces)
    return applyLudoPresentationOverrides(uiPieces, movingPieceOverride, captureVictimOverrides)
  }

  // Timer/orchestrator state isolation (виж task-а т.2): ДВЕ различни
  // семантики, explicit разделени тук, за да няма никакъв риск от leakage
  // между тях:
  //   A) HUMAN GAMEPLAY DEADLINE — 10s roll / 15s move, authoritative
  //      продължителност на реален human decision timer. Единствените
  //      стойности, които реален (не temporary-bot-controlled) местен играч
  //      трябва някога да види.
  //   B) BOT THINK DELAY — ~700ms presentation-only забавяне ПРЕДИ bot
  //      action (LUDO_BOT_THINK_DELAY_MS) — НИКОГА authoritative deadline,
  //      никога не трябва да "наследи" се от следващ human turn.
  // currentTurnCountdownMs() е ЕДИНСТВЕНАТА точка, computing коя от двете
  // важи в момента — винаги computed LIVE спрямо ТЕКУЩИЯ
  // engineState.turnPhase/activeColor/orchestrator.botControlledColors
  // (никога cache-вана/carry-over-ната стойност), затова структурно не може
  // да "leak-не" стара bot-delay стойност към нов human turn. Единственият
  // реален risk беше НЕ в тази функция самата, а в call sites-и, които
  // рендираха ПРЕДИ turnStartedAt да е синхронизиран с новата фаза (виж
  // handleMoveTimeout fix-а по-долу — scheduleNextDeadline() ПРЕДИ render()
  // навсякъде, established pattern).
  function currentTurnCountdownMs(): number {
    const pending = resolveLudoPendingDeadlineKind(engineState.turnPhase, engineState.activeColor, orchestrator.botControlledColors)
    if (pending === 'roll') return LUDO_ROLL_TIMEOUT_MS // (A) human roll deadline — НИКОГА bot delay
    if (pending === 'move') return LUDO_MOVE_TIMEOUT_MS // (A) human move deadline — НИКОГА bot delay
    return LUDO_BOT_THINK_DELAY_MS // (B) bot think delay — само когато pending==='none' (bot-controlled actor)
  }

  function currentScreenState(): LudoGameScreenState {
    return {
      players,
      // Единствен source of truth за "кой съм АЗ" (виж localColor const
      // по-горе) — подаден explicit, не преизчислен в render layer-a (виж
      // LudoGameScreenState.localColor doc коментара в
      // renderLudoGameScreen.ts за пълния rationale).
      localColor,
      pieces: currentUiPieces(),
      // По време на анимация не показваме legal-move highlights/capture
      // ring-ове — вече е избран конкретен ход, engine-ът е в turn_complete
      // (legalMoves вече е [] там), но пазим explicit guard-а тук за яснота.
      legalMoves: isAnimatingMove ? [] : ludoEngineLegalMovesToUiMoves(engineState.legalMoves),
      activeColor: engineState.activeColor,
      turnPhase: engineState.turnPhase,
      turnStartedAt,
      turnCountdownMs: currentTurnCountdownMs(),
      // (A) vs (B) разделяне на presentation ниво (виж currentTurnCountdownMs
      // doc коментара по-горе) — true само когато turnCountdownMs реално
      // представлява human reaction deadline (10s/15s), false когато е bot
      // think delay (~700ms). Player панелът (renderLudoPlayerPanel) ползва
      // това да реши countdown animation vs static presentation — bot-овете
      // (истински или temporary-takeover-нат local player) никога не трябва
      // да изглеждат като "player timeout, изтичащ за 700ms".
      isHumanCountdownActive: resolveLudoPendingDeadlineKind(engineState.turnPhase, engineState.activeColor, orchestrator.botControlledColors) !== 'none',
      isDiceRolling,
      // Interaction lock: DOM disabled state следва engine turnPhase, но
      // НЕ е authoritative за правилата — engine stale-action защитата
      // (turnVersion) е вторият защитен слой (виж task-а т.21). local
      // player-ят може да roll-не само когато е реално негов ред — bot-
      // controlled цветове (включително sticky-takeover-натия local цвят)
      // никога не показват clickable launcher за друг клиент да натисне.
      canRollDice:
        engineState.turnPhase === 'waiting_for_roll' &&
        !isAnimatingMove &&
        !orchestrator.botControlledColors.has(engineState.activeColor),
      turnSecondsLeft: Math.round(currentTurnCountdownMs() / 1000),
      useMobileLayout: isPhoneLayoutViewport(),
    }
  }

  function render(): void {
    options.root.innerHTML = renderLudoGameScreen(currentScreenState())
    applyLudoBoardContent(options.root, currentScreenState())
    if (activePopup) mountPopup(activePopup)
    if (showBotTakeoverPopup) mountBotTakeoverPopup()
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

  // Bot-takeover popup (т.15) — reuse-ва Belot-овия УХ pattern (scrim +
  // centered card + съобщение + dismiss бутон), но е НОВ, Ludo-local
  // компонент (renderLudoBotTakeoverPopup.ts), не import от Belot код (виж
  // audit-а — Belot popup-ите са private closures, тясно обвързани със
  // Seat/RoomBiddingSnapshot типове, не safe за directen import).
  function mountBotTakeoverPopup(): void {
    // Dice flight/landed overlay-ят живее на document.body с по-висок
    // z-index от Ludo overlay root-а (виж playLudoDiceFlightOverlay.ts —
    // нарочно, за да лети зарчето над дъската), затова popup-ът (mount-нат
    // ВЪТРЕ в options.root) не може да го покрие само чрез собствения си
    // z-index — родителският stacking context на options.root е ограничен
    // отвън. Скриваме dice overlay-a визуално (не unmount — animation
    // lifecycle-ът остава недокоснат), докато popup-ът стои отворен. Same
    // root cause и fix за capture impact/flight overlay-ите (виж
    // areGameplayOverlaysHiddenForPopup doc коментара по-горе — реален
    // browser regression test потвърди explosion burst и victim flight
    // пробиваха над popup-a преди този флаг).
    diceResultOverlay.setHidden(true)
    areGameplayOverlaysHiddenForPopup = true
    if (options.root.querySelector('[data-ludo-bot-takeover-backdrop="1"]')) return
    const container = document.createElement('div')
    container.innerHTML = renderLudoBotTakeoverPopup()
    const backdrop = container.firstElementChild
    if (backdrop) options.root.appendChild(backdrop)
    options.root.querySelector('[data-ludo-bot-takeover-dismiss="1"]')?.addEventListener('click', () => {
      // "ВЪРНИ СЕ" (виж task-а — преди беше "Разбрах", чисто dismiss без
      // ефект). Popup lifecycle-ът (hide/close/overlay unhide) остава
      // напълно същият, независимо дали bot-ът в момента действа —
      // reclaim-ът самият е безопасно guard-нат вътре в
      // scheduleNextDeadline() (виж pendingHumanReclaimColor doc коментара),
      // затова тук просто маркираме заявката безусловно.
      pendingHumanReclaimColor = localColor
      showBotTakeoverPopup = false
      diceResultOverlay.setHidden(false)
      areGameplayOverlaysHiddenForPopup = false
      const el = options.root.querySelector('[data-ludo-bot-takeover-backdrop="1"]')
      el?.remove()
      // Ако В МОМЕНТА на click-а няма активна bot анимация И local color-ът
      // реално чака нов waiting_for_roll decision (bot think-delay timer-ът
      // все още не е изстрелял действие), safe boundary-то вече е тук —
      // scheduleNextDeadline() веднага consume-ва pendingHumanReclaimColor-а
      // и въоръжава нормалния 10s human roll timer, вместо да чакаме bot
      // think-delay-a/следващия turn cycle. Ако bot вече действа
      // (isAnimatingMove/isDiceRolling), тази проверка е false — reclaim-ът
      // остава pending, приложен автоматично при следващия
      // scheduleNextDeadline() call (след като текущото bot действие
      // приключи безопасно).
      if (
        !isAnimatingMove &&
        !isDiceRolling &&
        engineState.activeColor === localColor &&
        engineState.turnPhase === 'waiting_for_roll'
      ) {
        scheduleNextDeadline()
      }
      render()
    })
  }

  function wireEvents(): void {
    options.root.querySelector('[data-ludo-exit-button="1"]')?.addEventListener('click', () => {
      options.onExit()
    })

    options.root.querySelector('[data-ludo-dice-roll-button="1"]')?.addEventListener('click', () => {
      void handleHumanRollClick()
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
        if (pieceId) void handleHumanPieceClick(pieceId)
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
      // визуално разминато до следващото хвърляне. Deadline-ите НЕ се
      // пипат тук (т.18: rerender/resize не бива да ги ресетва).
      diceResultOverlay.clearLanded()
      render()
    }, 120)
  }

  // ==================== TIMERS / DEADLINE SCHEDULING ====================

  let pendingTimeoutHandle: ReturnType<typeof setTimeout> | null = null
  let pendingBotHandle: ReturnType<typeof setTimeout> | null = null

  function clearScheduledTimers(): void {
    if (pendingTimeoutHandle) {
      clearTimeout(pendingTimeoutHandle)
      pendingTimeoutHandle = null
    }
    if (pendingBotHandle) {
      clearTimeout(pendingBotHandle)
      pendingBotHandle = null
    }
  }

  // Извиква се СЛЕД всяка engine мутация, която потенциално сменя
  // turnPhase/activeColor — преизчислява orchestrator deadline state-а и
  // програмира точно ЕДИН нов timeout (roll timeout / move timeout / bot
  // think delay), guard-нат с turnVersion за stale защита (т.18/TIMER10).
  // Никога не се извиква посред анимация (isAnimatingMove) — timers пазят
  // interaction lock-а indirectно, защото UI бутоните вече са disabled там.
  function scheduleNextDeadline(): void {
    clearScheduledTimers()

    // "ВЪРНИ СЕ" reclaim — приложен ТУК, защото scheduleNextDeadline() се
    // вика ВИНАГИ на вече завършен state transition (никога по средата на
    // roll flight/route animation/capture sequence — виж
    // pendingHumanReclaimColor doc коментара по-горе). Explicit guard-нато
    // с turnPhase==='waiting_for_roll': ако pending reclaim-ът съвпада с
    // текущия activeColor, НО той вече е насред awaiting_move_selection
    // (bot вече е хвърлил зара за този turn и still trябва да избере ход),
    // изчакваме — reclaim-ът остава pending до следващия waiting_for_roll
    // за същия цвят (следващия full turn cycle), за да не прекъснем bot's
    // вече-стартиран roll->move sequence по средата.
    if (
      pendingHumanReclaimColor !== null &&
      pendingHumanReclaimColor === engineState.activeColor &&
      engineState.turnPhase === 'waiting_for_roll'
    ) {
      orchestrator = resumeLudoHumanControl(orchestrator, pendingHumanReclaimColor)
      pendingHumanReclaimColor = null
    }

    const now = Date.now()
    orchestrator = computeLudoDeadlineStateForPhase(
      orchestrator,
      engineState.turnPhase,
      engineState.activeColor,
      engineState.turnVersion,
      now,
    )
    turnStartedAt = now

    const isBotTurn = orchestrator.botControlledColors.has(engineState.activeColor)
    if (isBotTurn) {
      if (engineState.turnPhase === 'waiting_for_roll' || engineState.turnPhase === 'awaiting_move_selection') {
        const registeredTurnVersion = engineState.turnVersion
        pendingBotHandle = setTimeout(() => {
          if (!isLudoDeadlineStillValid(orchestrator, registeredTurnVersion)) return
          void performBotTurnStep()
        }, LUDO_BOT_THINK_DELAY_MS)
      }
      return
    }

    if (orchestrator.rollDeadlineAt !== null) {
      const registeredTurnVersion = engineState.turnVersion
      pendingTimeoutHandle = setTimeout(() => {
        if (!isLudoDeadlineStillValid(orchestrator, registeredTurnVersion)) return
        void handleRollTimeout()
      }, LUDO_ROLL_TIMEOUT_MS)
    } else if (orchestrator.moveDeadlineAt !== null) {
      const registeredTurnVersion = engineState.turnVersion
      pendingTimeoutHandle = setTimeout(() => {
        if (!isLudoDeadlineStillValid(orchestrator, registeredTurnVersion)) return
        void handleMoveTimeout()
      }, LUDO_MOVE_TIMEOUT_MS)
    }
  }

  // Roll timeout (т.13): системата хвърля зара ВМЕСТО human-а — НЕ bot
  // takeover, местото просто auto-roll-ва през СЪЩИЯ dispatch път.
  async function handleRollTimeout(): Promise<void> {
    if (isAnimatingMove) return
    await performRollSequence(engineState.activeColor)
  }

  // Move timeout (т.14): BOT TAKEOVER — местото се маркира bot-controlled
  // (sticky), после веднага bot избира и изпълнява ход.
  //
  // Timer/orchestrator state isolation fix (виж task-а): преди тази поправка
  // тук се викаше directно render() след markLudoColorBotControlled, БЕЗ
  // scheduleNextDeadline() между тях — turnStartedAt оставаше stale (все
  // още сочещ към момента, в който 15s human move deadline-ът стартира,
  // ~15s назад), докато currentTurnCountdownMs() вече computed 700ms
  // (LUDO_BOT_THINK_DELAY_MS, защото botControlledColors вече включва
  // color-а). clampedTurnDelayMs(~15000, 700) clamp-ва до 700, значи
  // animation-delay излизаше -700ms спрямо duration:700ms — invalid
  // "stale elapsed vs нов кратък duration" combination (leakage concept от
  // task-а т.2/т.6), макар да не е директно visible зад popup-a. Затова
  // scheduleNextDeadline() ТРЯБВА да се извика ПРЕДИ render() тук — same
  // fix принцип като performRollSequence/performMoveSequence/advanceTurn
  // (виж техните коментари за пълния timer-sync rationale) — тя
  // преизчислява turnStartedAt=now за НОВАТА (bot-controlled) фаза, преди
  // DOM-ът да покаже каквото и да е countdown state за нея.
  async function handleMoveTimeout(): Promise<void> {
    if (isAnimatingMove) return
    const color = engineState.activeColor
    orchestrator = markLudoColorBotControlled(orchestrator, color)
    showBotTakeoverPopup = true
    scheduleNextDeadline()
    render()
    await performBotMoveForCurrentPhase()
  }

  // ==================== HUMAN INPUT ====================

  async function handleHumanRollClick(): Promise<void> {
    if (engineState.turnPhase !== 'waiting_for_roll' || isAnimatingMove) return
    if (orchestrator.botControlledColors.has(engineState.activeColor)) return
    clearScheduledTimers()
    await performRollSequence(engineState.activeColor)
  }

  async function handleHumanPieceClick(pieceId: LudoPieceId): Promise<void> {
    if (isAnimatingMove) return
    if (engineState.turnPhase !== 'awaiting_move_selection') return
    if (orchestrator.botControlledColors.has(engineState.activeColor)) return
    clearScheduledTimers()
    const slot = ludoUiPieceIdToSlot(pieceId)
    await performMoveSequence(engineState.activeColor, slot)
  }

  // ==================== BOT TURN ORCHESTRATION (т.16/17) ====================

  // Изпълнява ЕДНА bot стъпка спрямо ТЕКУЩАТА engine фаза — roll ако чакаме
  // roll, move ако вече има legal moves. Викана от bot think-delay timer-а
  // (scheduleNextDeadline) при нормален bot ход, и рекурсивно продължава
  // сама себе си чрез render()->scheduleNextDeadline() цикъла за extra
  // rolls (Phase 3B: handleTurnAdvanced в reducer-а вече МОЖЕ да остави
  // activeColor същия, ако pendingExtraRoll е true — advanceTurn() пак
  // вика scheduleNextDeadline(), който за bot-controlled цвят пак
  // програмира performBotTurnStep() след LUDO_BOT_THINK_DELAY_MS, затова
  // bot-ът естествено продължава да хвърля/мести без никаква допълнителна
  // логика тук).
  async function performBotTurnStep(): Promise<void> {
    if (isAnimatingMove) return
    const color = engineState.activeColor
    if (!orchestrator.botControlledColors.has(color)) return

    if (engineState.turnPhase === 'waiting_for_roll') {
      await performRollSequence(color)
      return
    }
    if (engineState.turnPhase === 'awaiting_move_selection') {
      await performBotMoveForCurrentPhase()
    }
  }

  async function performBotMoveForCurrentPhase(): Promise<void> {
    if (engineState.turnPhase !== 'awaiting_move_selection') return
    const move = pickLudoBotMove(engineState.legalMoves)
    if (!move) return
    await performMoveSequence(move.color, move.slot)
  }

  // ==================== SHARED ROLL/MOVE SEQUENCES ====================
  // Извиквани еднакво от human click, roll timeout auto-roll, и bot turn
  // orchestration — никаква разлика в game-rule пътя (т.16/17: bot и human
  // dispatch-ват СЪЩИТЕ actions, engine-ът не различава origin-а им).

  async function performRollSequence(rollingColor: LudoColor): Promise<void> {
    // Origin resolution е ЕДИНЕН за трите roll source-а (manual human click,
    // roll-timeout auto-roll, bot auto-roll) — всичките минават през тази
    // функция и всичките резолват origin-а по ЦВЯТ, не по "дали е local
    // player" (виж task-а — старата версия ползваше data-ludo-dice-roll-
    // button="1", който съществува САМО за local rollable launcher-а, затова
    // bot/друг играч roll-ваше видимо "телепортиран" в центъра). data-ludo-
    // dice-anchor="${color}" (renderLudoPlayerPanel/renderLudoDiceControl)
    // е стабилен, винаги-налично DOM marker за ВСЕКИ цвят — реалната avatar/
    // dice зона в player card-а, вече завъртяна спрямо viewer perspective
    // (renderLudoGameScreen viewerColorAt/renderPlayerPanelSlot), затова
    // origin автоматично излиза правилен и при различен local color.
    const triggerEl = options.root.querySelector<HTMLElement>(`[data-ludo-dice-anchor="${rollingColor}"]`)
    const centerEl = options.root.querySelector<HTMLElement>('[data-ludo-board-center="1"]')
    const boardGridEl = options.root.querySelector<HTMLElement>('[data-ludo-board="1"]')
    if (!centerEl || !boardGridEl) return
    // Defensive fallback само ако anchor елементът реално липсва в DOM-а
    // (не би трябвало да се случи — всеки цвят винаги рендира анкора си) —
    // пада назад към центъра, за да остане flight анимацията видима дори
    // в неочакван edge case, вместо throw.
    const fromRect = (triggerEl ?? centerEl).getBoundingClientRect()
    const toRect = centerEl.getBoundingClientRect()
    const boardGridWidthPx = boardGridEl.getBoundingClientRect().width

    const rollStarted = dispatch({
      type: 'ROLL_STARTED',
      color: rollingColor,
      expectedTurnVersion: engineState.turnVersion,
    })
    if (rollStarted.state.turnPhase !== 'rolling') return

    diceResultOverlay.clearLanded()
    isDiceRolling = true
    render()

    const result = rollLudoMockDiceResult()
    await diceResultOverlay.playFlight({ fromRect, toRect, boardGridWidthPx, result })

    const rollResolved = dispatch({
      type: 'ROLL_RESOLVED',
      color: rollingColor,
      value: result,
      expectedTurnVersion: engineState.turnVersion,
    })

    isDiceRolling = false

    if (rollResolved.state.turnPhase === 'turn_complete') {
      advanceTurn()
      return
    }
    // ВАЖНО (виж task-а — timer sync bug fix): scheduleNextDeadline() ТРЯБВА
    // да се извика ПРЕДИ render() тук, не след. scheduleNextDeadline()
    // задава turnStartedAt=now за НОВАТА фаза (awaiting_move_selection,
    // moveDeadlineAt=now+15000) — ако render() се случи първо (старият ред),
    // countdown fill/ring-ът се render-ва с turnElapsedMs, изчислен спрямо
    // СТАРИЯ turnStartedAt (все още от waiting_for_roll фазата, отпреди roll
    // click-а + flight-а), затова CSS animation-delay излиза грешно голям —
    // visual timer стартира от "средата" и после изтича реално-time рано
    // спрямо истинския 15s moveDeadlineAt (setTimeout-ът остава коректен,
    // само presentation-ът е разминат). Няма следващ render() до
    // move-timeout/piece click, затова тази единствена грешка остава
    // видима за цялата продължителност на countdown-а.
    scheduleNextDeadline()
    render()
  }

  async function performMoveSequence(color: LudoColor, slot: LudoPieceSlot): Promise<void> {
    const move = engineState.legalMoves.find((m) => m.color === color && m.slot === slot)
    if (!move) return

    const pieceId = `${color}-${slot}` as LudoPieceId
    const movingPieceBefore = engineState.pieces.find((p) => p.color === color && p.slot === slot)
    if (!movingPieceBefore) return
    const fromCellId = ludoEnginePositionToCellId(movingPieceBefore.position, color)

    isAnimatingMove = true
    clearScheduledTimers()
    render()

    const moveResult = dispatch({ type: 'MOVE_REQUESTED', color, slot, expectedTurnVersion: engineState.turnVersion })
    const capturedEvent = moveResult.events.find((e) => e.type === 'pieces_captured')
    const capturedPieceIds = capturedEvent && capturedEvent.type === 'pieces_captured' ? capturedEvent.capturedPieceIds : []

    // Phase 3B (виж task-а т.12): buildLudoMoveRoute вече покрива И четирите
    // canonical прехода (home->track/track->track/track->finish/finish->
    // finish, виж board/ludoMoveRoute.ts) — вече няма нужда от отделен
    // early-return за "target.kind !== 'track'" (Phase 3A special case);
    // route loop-ът по-долу работи еднакво за всички.
    const targetCellId = ludoEnginePositionToCellId(move.targetPosition, color)

    // Capture presentation buffer (виж task-а и коментара при
    // captureVictimOverrides по-горе): engine-ът вече е resolve-нал
    // captured victims в home-а им (dispatch по-горе е МОМЕНТАЛЕН), но
    // визуално те трябва да останат на target клетката ЦЯЛОТО време, докато
    // attacker-ът извървява route-а до нея — попълваме override-а ПРЕДИ
    // route loop-а изобщо да стартира, за да не изчезнат victims-ите на
    // самия ПЪРВИ render() кадър от анимацията.
    if (capturedPieceIds.length > 0) {
      captureVictimOverrides = createLudoCaptureVictimOverrides(capturedPieceIds, targetCellId, captureVictimOverrides)
    }

    const route = buildLudoMoveRoute(fromCellId, targetCellId)
    for (const stepCellId of route) {
      movingPieceOverride = { pieceId, cellId: stepCellId }
      render()
      await wait(STEP_ANIMATION_MS)
    }

    // Attacker-ът вече е визуално пристигнал на target клетката (route
    // loop-ът завърши) — чак СЕГА следва impact/capture анимацията. Victims
    // все още стоят на target-а (captureVictimOverrides по-горе), точно
    // както изисква task-а: "attacker reaches target → collision/capture →
    // victim flies home", не обратно.
    if (capturedPieceIds.length > 0) {
      await animateCapture(capturedPieceIds)
      // Impact анимацията приключи — маха се presentation override-ът за
      // ТОЧНО тези victim id-та (не целия map — defensive за евентуален
      // бъдещ overlapping capture, макар Phase 3A да няма такъв сценарий).
      // Следващият render() вече показва canonical home позициите directno
      // от engineState.pieces.
      captureVictimOverrides = clearLudoCaptureVictimOverrides(capturedPieceIds, captureVictimOverrides)
    }

    diceResultOverlay.clearLanded()
    movingPieceOverride = null
    isAnimatingMove = false
    render()

    advanceTurn()
  }

  // Impact момент — извиква се ЕДИНСТВЕНО след attacker-ът вече е визуално
  // пристигнал на target клетката (виж call site-а в performMoveSequence).
  // Sequence (виж task-а): shake (impact индикация, reuse на съществуващия
  // ludo-piece-shake ефект, без redesign) → кратък impact/explosion burst
  // ВЪРХУ target клетката (playLudoCaptureImpactOverlay.ts, ЕДИН път дори
  // при stack capture — виж т.по-долу) → ВСЕКИ captured piece реално
  // прелита от target клетката до собствения си permanent home slot
  // (playLudoCaptureFlightOverlay.ts) → чак СЛЕД flight-ът приключи,
  // caller-ът (performMoveSequence) чисти presentation override-а.
  //
  // Origin rect се измерва от представителния DOM token на target клетката
  // (querySelector по data-ludo-piece ИЛИ data-ludo-piece-group — stack
  // capture показва 1 group token с badge за N victims, виж
  // renderLudoPieceCluster, затова НЕ всеки captured id има собствен DOM
  // елемент; representative token-ът стои на СЪЩАТА позиция за целия stack,
  // затова служи и като origin за impact burst-а, и за всеки отделен flight —
  // ЕДИН measurement, reuse-нат за двете, без дублирана geometry логика).
  // Destination rect е РЕАЛНАТА home клетка на ТОЧНО тази piece id
  // (data-ludo-cell-pieces="home-${color}-${slot}") — тези контейнери СЕ
  // рендират в DOM-а винаги (renderLudoBoard.ts), независимо дали в момента
  // има пионка вътре, затова measurement-ът работи без да чака override
  // cleanup. И origin, и destination минават през стандартния cell-id based
  // board render pipeline (viewer-rotated при build time), затова flight
  // route-ът е автоматично perspective-коректен без отделна координатна
  // логика тук — same важи и за impact overlay-а (target rect вече е
  // viewer-relative, playLudoCaptureImpactOverlay.ts само центрира спрямо
  // него, не преизчислява никаква perspective).
  async function animateCapture(capturedPieceIds: readonly LudoPieceId[]): Promise<void> {
    const representativeEl = options.root.querySelector<HTMLElement>(
      `[data-ludo-piece="${capturedPieceIds[0]}"], [data-ludo-piece-group~="${capturedPieceIds[0]}"]`,
    )
    if (!representativeEl) return
    representativeEl.style.setProperty('animation', 'ludo-piece-shake 400ms ease-in-out')
    await wait(IMPACT_ANIMATION_MS)

    const fromRect = representativeEl.getBoundingClientRect()
    const pieceSizePx = fromRect.width

    // Impact/explosion burst — ЕДИН път на target клетката, независимо дали
    // capture-ът е единичен или stack (capturedPieceIds.length > 1). Викан
    // ТОЧНО тук: attacker вече е на target (route loop завърши преди
    // animateCapture да се извика — виж performMoveSequence), shake вече
    // приключи (await wait по-горе), victim-ите все още стоят видимо на
    // target-а (captureVictimOverrides остава недокоснат тук — само визуален
    // burst overlay, никаква presentation state промяна). Awaited преди
    // representativeEl да се скрие — burst-ът се вижда ВЪРХУ все още видимия
    // victim, точно както изисква task-а sequencing (shake -> impact ->
    // victim се скрива -> flight).
    await playLudoCaptureImpactOverlay({ targetRect: fromRect, initiallyHidden: areGameplayOverlaysHiddenForPopup })

    // Скриваме статичния representative token НА target клетката веднага,
    // преди flight overlay-ите да стартират — иначе pionkata би изглеждала
    // ДУБЛИРАНА (едновременно статична на target-а И летяща към home-а, виж
    // task-а т.5 "не трябва да се дублира едновременно и на target, и в
    // home"). captureVictimOverrides остава активен през целия flight
    // (canonical home render still suppressed) — само визуалният DOM token
    // на target-а се скрива, не самия presentation state.
    representativeEl.style.visibility = 'hidden'

    // Всички victims летят ПАРАЛЕЛНО (Promise.all) — визуално едновременно,
    // не последователно stagger (task-ът позволява "може последователно
    // или с малък stagger" — паралелно е по-четимо/по-бързо за 2-4 pieces,
    // без нов timing параметър за конфигуриране).
    await Promise.all(
      capturedPieceIds.map(async (pieceId) => {
        const [color] = pieceId.split('-')
        const slot = pieceId.slice(pieceId.lastIndexOf('-') + 1)
        const homeCellId = `home-${color}-${slot}`
        const homeContainer = options.root.querySelector<HTMLElement>(`[data-ludo-cell-pieces="${homeCellId}"]`)
        if (!homeContainer) return
        const toRect = homeContainer.getBoundingClientRect()
        await playLudoCaptureFlightOverlay({ pieceId, fromRect, toRect, pieceSizePx, initiallyHidden: areGameplayOverlaysHiddenForPopup })
      }),
    )
  }

  // Автоматично напредва хода след завършен move (или след roll без legal
  // moves). След TURN_ADVANCED веднага проверява дали новият активен играч
  // е local (реален popup вече е показан по-рано, ако е нужно) и програмира
  // следващия roll/move/bot-think deadline (т.16: bot turns не чакат човешки
  // таймери — scheduleNextDeadline() решава това автоматично спрямо
  // botControlledColors).
  function advanceTurn(): void {
    const result = dispatch({
      type: 'TURN_ADVANCED',
      color: engineState.activeColor,
      expectedTurnVersion: engineState.turnVersion,
    })
    // Local player-ът получи ход обратно (напр. следващия кръг стигна пак
    // до него) — bot-takeover popup-ът вече не е релевантен за новия му ход,
    // маха се автоматично (аналог на Belot: popup-ът изчезва щом играчът
    // реално си върне контрола следващия път, когато е негов ред).
    if (result.state.activeColor === localColor && !orchestrator.botControlledColors.has(localColor)) {
      showBotTakeoverPopup = false
    }
    // scheduleNextDeadline() ПРЕДИ render() — виж timer sync bug fix
    // коментара в performRollSequence по-горе. advanceTurn() е ГЛАВНИЯТ
    // call site на този проблем: вика се след ВСЕКИ завършен ход
    // (performMoveSequence) и след turn_complete roll — т.е. точно моментът,
    // в който следващият играч влиза в waiting_for_roll (или, за extra
    // rolls, остава в awaiting_move_selection). Стария ред (render() first)
    // би показал countdown-а на новия активен играч спрямо STARIYA
    // turnStartedAt на PREDISHNIYA играч — визуален timer, стартиращ от
    // грешна (обикновено много по-напреднала) позиция.
    scheduleNextDeadline()
    render()
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function destroy(): void {
    window.removeEventListener('resize', handleResize)
    if (resizeTimer) clearTimeout(resizeTimer)
    clearScheduledTimers()
    diceResultOverlay.clearLanded()
  }

  // scheduleNextDeadline() ПРЕДИ render() — same fix принцип за консистентност
  // (виж advanceTurn/performRollSequence коментарите по-горе), макар тук
  // ефектът да е незначителен (turnStartedAt вече е Date.now() от module
  // init, разликата е под 1ms).
  scheduleNextDeadline()
  render()

  return { destroy }
}
