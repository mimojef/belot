// Production room games are server-authoritative: this controller sends only
// roll/move/reclaim intents and presents revision-ordered server snapshots.
// The local reducer/RNG path remains solely for isolated manual and test
// harnesses that construct the controller without `authoritative` options.
//
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
// Local dispatch/timer details above describe only the isolated fallback;
// authoritative production transitions arrive through applyAuthoritativeSnapshot().

import { isPhoneLayoutViewport } from '../../../ui/layout/viewportStage'
import { renderLudoGameScreen, applyLudoBoardContent, computeLudoDesktopPanelScale, type LudoGameScreenState } from './renderLudoGameScreen'
import { renderLudoEmojiPickerHtml } from './renderLudoBottomBar'
import { renderLudoBotTakeoverPopup } from './renderLudoBotTakeoverPopup'
import { renderLudoGameEndPopup } from './renderLudoGameEndPopup'
import { renderLudoExitConfirmPopup } from './renderLudoExitConfirmPopup'
import { renderLudoSettingsPopup } from './renderLudoSettingsPopup'
import { isLudoDiceSoundEnabled, isLudoGameSoundsEnabled, setLudoDiceSoundEnabled, setLudoGameSoundsEnabled } from './ludoSoundSettings'
import { isValidAnimatedEmojiId } from '../../animatedEmoji/animatedEmojiAssets'
import { LUDO_EMOJI_BUBBLE_TOTAL_MS } from './pieces/renderLudoPlayerPanel'
import { LUDO_MODAL_LAYER_Z_INDEX } from './ludoLayerHierarchy'
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
import { playLudoEndGameSound, playLudoMoveRouteOverlay } from './pieces/playLudoMoveRouteOverlay'
import { LUDO_BOARD_PAWN_SCALE } from './pieces/renderLudoPieces'
import { parseLudoCellId } from './board/ludoBoardGeometry'
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
import type { LudoGameState, LudoPieceSlot, LudoTurnPhase } from './engine/ludoEngineTypes'
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
import type { LudoColor, LudoPiece, LudoPieceId, LudoPlayer } from './ludoTypes'
import type { LudoGameStateSnapshot } from '../../network/createGameServerClient'

const IMPACT_ANIMATION_MS = 450

export interface LudoFlowControllerOptions {
  root: HTMLElement
  onExit: (matchId?: string) => void
  onGameEndAcknowledged?: (matchId: string) => void
  players?: Record<LudoColor, LudoPlayer>
  localColor?: LudoColor
  authoritative?: {
    initialSnapshot: LudoGameStateSnapshot
    onRollRequest: (matchId: string, expectedRevision: number) => void
    onMoveRequest: (matchId: string, expectedRevision: number, slot: LudoPieceSlot) => void
    onReclaimRequest: (matchId: string, expectedRevision: number) => void
    onStateRefreshRequest?: () => void
    // Realtime social reaction (виж task-а "Ludo emoji") — само за
    // authoritative multiplayer match-ове, огледално на onRollRequest/
    // onMoveRequest wiring-а. Не съществува в non-authoritative (dev
    // harness) режим — emoji picker-ът остава скрит там (виж wireEvents()).
    onEmojiReactionSend?: (matchId: string, emojiId: string) => void
  }
  // Test/dev seeding seam (Phase 3B browser verification, виж task-а т.21:
  // "temporary seeded/dev harness ако е нужно, не променяй permanently
  // normal initial game state само за теста") — по подразбиране липсва,
  // controller-ът вика createLudoEngineInitialState() точно както преди.
  // Production call site (createLobbyFlowController.ts) никога не я подава.
  initialState?: LudoGameState
}

export function createLudoFlowController(options: LudoFlowControllerOptions) {
  const modalLayerRoot = document.createElement('div')
  modalLayerRoot.setAttribute('data-ludo-modal-layer', '1')
  modalLayerRoot.style.cssText = `position:fixed;inset:0;z-index:${LUDO_MODAL_LAYER_Z_INDEX};pointer-events:none;`
  document.body.appendChild(modalLayerRoot)

  function syncModalLayerInteractivity(): void {
    modalLayerRoot.style.pointerEvents = modalLayerRoot.childElementCount > 0 ? 'auto' : 'none'
  }

  const players: Record<LudoColor, LudoPlayer> = options.players ?? createLudoMockPlayers()
  const botControlledColorsInitial = new Set<LudoColor>(
    (Object.values(players) as LudoPlayer[]).filter((p) => p.isBot).map((p) => p.color),
  )

  // Canonical game state — ЕДИНСТВЕНИЯТ source of truth за pieces/
  // activeColor/turnPhase/diceValue/legalMoves. Мутира се ИЗКЛЮЧИТЕЛНО
  // чрез dispatch() -> reduceLudoGame(); контролерът никога не пипа тези
  // полета directno.
  let engineState: LudoGameState = options.authoritative?.initialSnapshot.state ?? options.initialState ?? createLudoEngineInitialState()
  let authoritativeRevision = options.authoritative?.initialSnapshot.revision ?? -1
  let highestReceivedAuthoritativeRevision = authoritativeRevision
  let authoritativeSnapshot = options.authoritative?.initialSnapshot ?? null
  // Authoritative payout сума за local player-а, ако е match winner — виж
  // renderLudoGameEndPopup.ts коментара. Никога null-ва вече известна
  // стойност (само presentGameEndOnce я чете) — защитава срещу edge-case
  // reconnect snapshot с prizeAmount:null, който теоретично би могъл да
  // пристигне СЛЕД finish (виж applyAuthoritativeSnapshot по-долу).
  let latestPrizeAmount: number | null = null
  let authoritativeTransitionQueue = Promise.resolve()
  let presentationEpoch = 0
  let awaitingVisibilityResync = false

  // PRESENTATION GATE (виж task-а "opponent avatar swaps to dice control
  // while pawn still animating"): server-ят auto-advance-ва turn-а В РАМКИТЕ
  // на СЪЩИЯ commit като move-а (server ludoMatchRuntime.ts::applyMove ->
  // advanceCompletedTurn, синхронно, преди commit()) — снапшотът, който носи
  // piece_moved event-а, вече носи СЛЕДВАЩИЯ activeColor/turnPhase. Canonical
  // engineState/authoritativeRevision се ъпдейтват веднага, точно както
  // преди (НИКАКВО забавяне/подправяне на server state) — гейтът е ЧИСТО
  // presentation слой: докато е non-null, currentScreenState() показва ТОЗИ
  // замразен (pre-move) turn snapshot вместо да чете engineState/turnStartedAt
  // директно, за да не "прескочи" следващия играч avatar->dice swap +
  // countdown UI преди движещата се пионка реално да стъпи на последното си
  // поле. Отваря се в presentAuthoritativeMove (веднага преди engineState да
  // се презапише), затваря се СЛЕД финалния landing render (route overlay
  // resolved) — capture impact/flight продължава да тече след release-а
  // (различен visual слой, board-level, не player панела). Reset-ва се и в
  // invalidateAuthoritativePresentations() (foreground snap/epoch
  // invalidation) — same established pattern като isAnimatingMove/
  // movingPieceSuppressedId/captureVictimOverrides там, за да не остане stale
  // "замразен" гейт отворен след прекъснат presentation queue.
  let presentationGateSnapshot: {
    activeColor: LudoColor
    turnPhase: LudoTurnPhase
    turnStartedAt: number
    turnCountdownMs: number
    isHumanCountdownActive: boolean
  } | null = null

  // Orchestrator state (т.2: PRESENTATION/ORCHESTRATION) — bot-controlled
  // flag-ове + roll/move deadlines. Мутира се ИЗКЛЮЧИТЕЛНО чрез
  // computeLudoDeadlineStateForPhase/markLudoColorBotControlled (pure
  // helpers), контролерът само presисва резултата обратно тук.
  let orchestrator: LudoOrchestratorState = createLudoOrchestratorInitialState(
    options.authoritative ? new Set(options.authoritative.initialSnapshot.botControlledColors) : botControlledColorsInitial,
  )

  // ---- PRESENTATION-ONLY state (engine-ът не знае нищо за тях) ----
  // Момент (Date.now()), в който активният играч е получил хода си —
  // deadline-базирана основа за countdown fill-а в player card-а (виж
  // renderLudoPlayerPanel), НЕ JS tick брояч. Reset-ва се при всяка нова
  // deadline фаза (roll/move/bot-think).
  let turnStartedAt = Date.now()
  let isDiceRolling = false
  let isAnimatingMove = false
  let isDestroyed = false
  let isEmojiPickerOpen = false
  let hasPresentedGameEnd = false
  let isGameEndPopupOpen = false
  let isExitConfirmOpen = false
  let isExitLeavePending = false
  let isSettingsPopupOpen = false
  // Показва bot-takeover popup-а веднъж, СЛЕД move timeout (т.15) — sticky
  // до следващия път, когато local player-ът получи хода си (не reset-ва
  // се автоматично, аналог на Belot persistent popup).
  let showBotTakeoverPopup = options.authoritative?.initialSnapshot.botControlledColors.includes(options.localColor ?? 'red') ?? false
  // Presentation route buffer: докато движеща се пионка still-steps по
  // маршрута си, engine-ът ВЕЧЕ показва финалната ѝ позиция (dispatch е
  // synchronous и моментален). За да не "телепортира" визуално пионката,
  // за времетраенето на анимацията override-ваме САМО нейната cell в
  // adapted UI pieces масива — presentation frame, никога записан обратно
  // в engineState. null означава "няма активна route анимация в момента".
  // Множествено число (Set, не единична стойност) — виж task-а "Explicit
  // Изход" §2.1: до 4 пионки на forfeit-налия цвят могат да летят ЕДНОВРЕМЕННО
  // (Promise.all), затова единичен movingPieceSuppressedId вече не стига.
  // Move presentation-ът продължава да добавя/маха точно ЕДНА piece id тук —
  // множественото API е строг superset, поведението му за 1 елемент е
  // идентично на преди.
  const suppressedPieceIds = new Set<LudoPieceId>()
  let activeMoveOverlayCancel: (() => void) | null = null
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
  // Explicit "Изход" forfeit presentation (виж task-а §2/§4/§8) — чисто
  // presentation-only, transient. Показва "Излезе от играта" (мигащо) за
  // ТОЧНО този цвят за 5 секунди, СЛЕД което автоматично се reset-ва (панелът
  // пада обратно на постоянното "Напуснал", четено директно от
  // engineState.leftColors — canonical, не transient). НЕ подава се при
  // foreground snap/reconnect за исторически leave (виж §8 — snapToAuthoritative-
  // Snapshot никога не пипа тези две полета, само applyAuthoritativeTransition
  // за LIVE, only-just-observed forfeit събития).
  let justLeftColor: LudoColor | null = null
  let justLeftColorTimer: ReturnType<typeof setTimeout> | null = null
  function clearJustLeftColorTimer(): void {
    if (justLeftColorTimer) clearTimeout(justLeftColorTimer)
    justLeftColorTimer = null
  }

  // Realtime emoji reaction bubbles (виж task-а "Ludo emoji" §7/§9) —
  // ЧИСТО presentation, никога не участва в engineState/snapshot. Reuse-ва
  // СЪЩИЯ pattern като Belot's emojiReactionUiState/addEmojiBubble
  // (createActiveRoomFlowController.ts): ЕДНА активна bubble на цвят —
  // ново emoji от СЪЩИЯ цвят докато старата още се показва REPLACE-ва я
  // (не queue/accumulate), отменяйки pending cleanup timer-а на старата,
  // адаптирано към color вместо seat. startedAt е Date.now() (Ludo
  // convention, виж turnStartedAt по-горе), не performance.now() (Belot) —
  // само вътрешна elapsed-time аритметика, часовникът не се сравнява cross-
  // process. render() е full innerHTML replace (виж render() по-долу),
  // затова презентацията (renderLudoPlayerPanel) използва СЪЩИЯ negative
  // animation-delay trick като countdown bar-а, за да не рестартира
  // анимацията на всеки re-render.
  let emojiReactions: Partial<Record<LudoColor, { emojiId: string; startedAt: number }>> = {}
  let emojiReactionTimers: Partial<Record<LudoColor, ReturnType<typeof setTimeout>>> = {}
  function clearEmojiReactionTimers(): void {
    for (const timerId of Object.values(emojiReactionTimers)) {
      if (timerId !== undefined) clearTimeout(timerId)
    }
    emojiReactionTimers = {}
    emojiReactions = {}
  }
  function addEmojiReaction(color: LudoColor, emojiId: string): void {
    const existingTimer = emojiReactionTimers[color]
    if (existingTimer !== undefined) clearTimeout(existingTimer)
    emojiReactions = { ...emojiReactions, [color]: { emojiId, startedAt: Date.now() } }
    emojiReactionTimers[color] = setTimeout(() => {
      delete emojiReactionTimers[color]
      const next = { ...emojiReactions }
      delete next[color]
      emojiReactions = next
      render()
    }, LUDO_EMOJI_BUBBLE_TOTAL_MS)
    render()
  }

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
  const localColor: LudoColor = options.localColor ?? (
    (Object.values(players) as LudoPlayer[]).find((p) => !p.isBot)?.color ?? 'red'
  )

  // Прилага presentation override-ите (route buffer за attacker-а, capture
  // buffer за victims) върху canonical adapted pieces — ЕДИНСТВЕНОТО място,
  // където presentation override докосва piece позиция за render. Engine
  // pieces масивът остава недокоснат.
  function currentUiPieces(): LudoPiece[] {
    const uiPieces = ludoEnginePiecesToUiPieces(engineState.pieces)
    const presentationPieces = applyLudoPresentationOverrides(uiPieces, null, captureVictimOverrides)
    return suppressedPieceIds.size > 0
      ? presentationPieces.filter((piece) => !suppressedPieceIds.has(piece.id))
      : presentationPieces
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
    if (authoritativeSnapshot?.deadlineAt != null) {
      return engineState.turnPhase === 'awaiting_move_selection' ? LUDO_MOVE_TIMEOUT_MS : LUDO_ROLL_TIMEOUT_MS
    }
    const pending = resolveLudoPendingDeadlineKind(engineState.turnPhase, engineState.activeColor, orchestrator.botControlledColors)
    if (pending === 'roll') return LUDO_ROLL_TIMEOUT_MS // (A) human roll deadline — НИКОГА bot delay
    if (pending === 'move') return LUDO_MOVE_TIMEOUT_MS // (A) human move deadline — НИКОГА bot delay
    return LUDO_BOT_THINK_DELAY_MS // (B) bot think delay — само когато pending==='none' (bot-controlled actor)
  }

  // LIVE turn-presentation snapshot — directно от engineState/orchestrator,
  // спрямо ТЕКУЩИЯ момент. Използва се и (а) като нормалната стойност,
  // връщана от displayedTurnPresentation(), когато presentation gate-ът не е
  // active, и (б) за да "замрази" pre-move snapshot-а В МОМЕНТА, В КОЙТО
  // presentAuthoritativeMove отваря гейта (извикана ПРЕДИ engineState да се
  // презапише там — виж call site-а).
  function liveTurnPresentationSnapshot() {
    return {
      activeColor: engineState.activeColor,
      turnPhase: engineState.turnPhase,
      turnStartedAt,
      turnCountdownMs: currentTurnCountdownMs(),
      isHumanCountdownActive: resolveLudoPendingDeadlineKind(engineState.turnPhase, engineState.activeColor, orchestrator.botControlledColors) !== 'none',
    }
  }

  // Единствената точка, през която currentScreenState() научава "кой е
  // активен/каква фаза е turn-ът" — връща замразения presentationGateSnapshot
  // докато гейтът е отворен (move presentation в момента тече), иначе живия
  // engineState-based snapshot. Виж presentationGateSnapshot doc коментара
  // по-горе за пълния rationale.
  function displayedTurnPresentation() {
    return presentationGateSnapshot ?? liveTurnPresentationSnapshot()
  }

  function currentScreenState(): LudoGameScreenState {
    // Gate-aware turn presentation (виж presentationGateSnapshot doc
    // коментара при декларацията му) — ВСИЧКИ "кой е активен/каква е фазата"
    // полета по-долу четат ОТТУК, никога directно engineState.activeColor/
    // turnPhase/turnStartedAt — това е ЕДИНСТВЕНАТА точка, в която гейтът
    // реално влияе на UI-а. pieces/legalMoves остават LIVE (board-ът борави
    // с presentation override-и по свой отделен механизъм, виж currentUiPieces).
    const turnDisplay = displayedTurnPresentation()
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
      activeColor: turnDisplay.activeColor,
      turnPhase: turnDisplay.turnPhase,
      turnStartedAt: turnDisplay.turnStartedAt,
      turnCountdownMs: turnDisplay.turnCountdownMs,
      // (A) vs (B) разделяне на presentation ниво (виж currentTurnCountdownMs
      // doc коментара по-горе) — true само когато turnCountdownMs реално
      // представлява human reaction deadline (10s/15s), false когато е bot
      // think delay (~700ms). Player панелът (renderLudoPlayerPanel) ползва
      // това да реши countdown animation vs static presentation — bot-овете
      // (истински или temporary-takeover-нат local player) никога не трябва
      // да изглеждат като "player timeout, изтичащ за 700ms".
      isHumanCountdownActive: turnDisplay.isHumanCountdownActive,
      isDiceRolling,
      // Interaction lock: DOM disabled state следва engine turnPhase, но
      // НЕ е authoritative за правилата — engine stale-action защитата
      // (turnVersion) е вторият защитен слой (виж task-а т.21). local
      // player-ят може да roll-не само когато е реално негов ред — bot-
      // controlled цветове (включително sticky-takeover-натия local цвят)
      // никога не показват clickable launcher за друг клиент да натисне.
      // presentationGateSnapshot===null е explicit defense-in-depth тук —
      // докато гейтът е отворен turnDisplay.turnPhase вече е замразен на
      // pre-move стойност (типично 'awaiting_move_selection', никога
      // 'waiting_for_roll' за next player-a), затова тази проверка е
      // структурно redundant, но пази инварианта дори ако displayedTurn-
      // Presentation()-ната логика някога се промени.
      canRollDice:
        turnDisplay.turnPhase === 'waiting_for_roll' &&
        !isAnimatingMove &&
        presentationGateSnapshot === null &&
        !orchestrator.botControlledColors.has(turnDisplay.activeColor) &&
        (!options.authoritative || turnDisplay.activeColor === localColor),
      turnSecondsLeft: Math.round(turnDisplay.turnCountdownMs / 1000),
      useMobileLayout: isPhoneLayoutViewport(),
      // Виж task-а §3/§4/§8 — leftColors е canonical (engineState, персистира,
      // преживява restart), justLeftColor е чисто presentation-only 5s window
      // (виж декларацията му по-горе).
      leftColors: engineState.leftColors,
      justLeftColor,
      // Responsive player-panel scale (виж computeLudoDesktopPanelScale doc
      // коментара в renderLudoGameScreen.ts) — четено live от window всеки
      // render() (вкл. debounced 'resize' handler-а по-долу, виж
      // handleResize), огледално на isPhoneLayoutViewport() реда точно
      // по-горе. Игнориран от renderLudoPlayerPanel при useMobileLayout.
      desktopPanelScale: computeLudoDesktopPanelScale(window.innerWidth, window.innerHeight),
      // Realtime emoji reaction bubbles (виж emojiReactions doc коментара
      // при декларацията му по-горе) — суровите startedAt timestamps се
      // подават directno, elapsed се смята в renderPlayerPanelSlot (СЪЩИЯТ
      // pattern като turnElapsedMs, изчислен там спрямо turnStartedAt).
      emojiReactions,
    }
  }

  function render(): void {
    if (isDestroyed) return
    options.root.innerHTML = renderLudoGameScreen(currentScreenState())
    applyLudoBoardContent(options.root, currentScreenState())
    if (isEmojiPickerOpen) mountEmojiPicker()
    if (showBotTakeoverPopup) mountBotTakeoverPopup()
    if (isGameEndPopupOpen) mountGameEndPopup()
    if (isExitConfirmOpen) mountExitConfirmPopup()
    if (isSettingsPopupOpen) mountSettingsPopup()
    wireEvents()
  }

  // Ludo "Настройки" popup (виж task-а "Ludo sound settings") — reuse-ва
  // СЪЩИЯ mount pattern като mountExitConfirmPopup по-горе (backdrop +
  // centered card в modalLayerRoot, pointer-events:auto докато е отворен).
  // Чисто presentation — НЕ пипа turn/dice логика, играта продължава
  // нормално server-side. Toggle кликовете обновяват съответния бутон
  // directno (style + символ), без нужда от пълен re-mount на popup-а.
  function mountSettingsPopup(): void {
    if (modalLayerRoot.querySelector('[data-ludo-settings-backdrop="1"]')) return
    const container = document.createElement('div')
    container.innerHTML = renderLudoSettingsPopup()
    const backdrop = container.firstElementChild
    if (!(backdrop instanceof HTMLElement)) return
    backdrop.style.pointerEvents = 'auto'
    modalLayerRoot.appendChild(backdrop)
    syncModalLayerInteractivity()

    modalLayerRoot.querySelector('[data-ludo-settings-close="1"]')?.addEventListener('click', closeSettingsPopup)
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeSettingsPopup()
    })
    modalLayerRoot.querySelectorAll<HTMLButtonElement>('[data-ludo-settings-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.getAttribute('data-ludo-settings-toggle')
        const nextEnabled = key === 'gameSounds'
          ? !isLudoGameSoundsEnabled()
          : !isLudoDiceSoundEnabled()
        if (key === 'gameSounds') setLudoGameSoundsEnabled(nextEnabled)
        else if (key === 'dice') setLudoDiceSoundEnabled(nextEnabled)
        const onColor = '#22c55e'
        const offColor = '#ef4444'
        const color = nextEnabled ? onColor : offColor
        button.setAttribute('aria-pressed', nextEnabled ? 'true' : 'false')
        button.style.borderColor = color
        button.style.color = color
        button.style.background = nextEnabled ? 'rgba(34,197,94,0.16)' : 'rgba(239,68,68,0.16)'
        button.innerHTML = nextEnabled ? '&#10003;' : '&#10005;'
      })
    })
  }

  function openSettingsPopup(): void {
    if (isSettingsPopupOpen) return
    isSettingsPopupOpen = true
    mountSettingsPopup()
  }

  function closeSettingsPopup(): void {
    isSettingsPopupOpen = false
    modalLayerRoot.querySelector('[data-ludo-settings-backdrop="1"]')?.remove()
    syncModalLayerInteractivity()
  }

  function mountExitConfirmPopup(): void {
    if (modalLayerRoot.querySelector('[data-ludo-exit-confirm-backdrop="1"]')) return
    const container = document.createElement('div')
    container.innerHTML = renderLudoExitConfirmPopup(authoritativeSnapshot?.stake ?? null, isExitLeavePending)
    const backdrop = container.firstElementChild
    if (backdrop instanceof HTMLElement) {
      backdrop.style.pointerEvents = 'auto'
      modalLayerRoot.appendChild(backdrop)
      syncModalLayerInteractivity()
    }
    modalLayerRoot.querySelector('[data-ludo-exit-confirm-cancel="1"]')?.addEventListener('click', () => {
      if (isExitLeavePending) return
      isExitConfirmOpen = false
      modalLayerRoot.querySelector('[data-ludo-exit-confirm-backdrop="1"]')?.remove()
      syncModalLayerInteractivity()
    })
    modalLayerRoot.querySelector('[data-ludo-exit-confirm-submit="1"]')?.addEventListener('click', () => {
      if (isExitLeavePending) return
      isExitLeavePending = true
      modalLayerRoot.querySelectorAll<HTMLButtonElement>('[data-ludo-exit-confirm-cancel="1"], [data-ludo-exit-confirm-submit="1"]').forEach((button) => {
        button.disabled = true
      })
      const submit = modalLayerRoot.querySelector<HTMLButtonElement>('[data-ludo-exit-confirm-submit="1"]')
      if (submit) submit.textContent = 'Напускане...'
      requestExit()
    })
  }

  function openExitConfirmPopup(): void {
    if (isExitConfirmOpen || isExitLeavePending || engineState.status === 'finished') return
    isExitConfirmOpen = true
    mountExitConfirmPopup()
  }

  function mountGameEndPopup(): void {
    if (modalLayerRoot.querySelector('[data-ludo-game-end-backdrop="1"]')) return
    const container = document.createElement('div')
    container.innerHTML = renderLudoGameEndPopup(engineState.winnerColor === localColor, latestPrizeAmount)
    const backdrop = container.firstElementChild
    if (backdrop instanceof HTMLElement) {
      backdrop.style.pointerEvents = 'auto'
      modalLayerRoot.appendChild(backdrop)
      syncModalLayerInteractivity()
    }
    modalLayerRoot.querySelector('[data-ludo-game-end-dismiss="1"]')?.addEventListener('click', () => {
      isGameEndPopupOpen = false
      modalLayerRoot.querySelector('[data-ludo-game-end-backdrop="1"]')?.remove()
      syncModalLayerInteractivity()
      if (options.authoritative && authoritativeSnapshot) options.onGameEndAcknowledged?.(authoritativeSnapshot.matchId)
    })
  }

  function presentGameEndOnce(playSound = false): void {
    if (hasPresentedGameEnd || engineState.status !== 'finished' || engineState.winnerColor === null) return
    hasPresentedGameEnd = true
    if (playSound) playLudoEndGameSound()
    isGameEndPopupOpen = true
    isExitConfirmOpen = false
    isExitLeavePending = false
    isEmojiPickerOpen = false
    isSettingsPopupOpen = false
    modalLayerRoot.replaceChildren()
    syncModalLayerInteractivity()
    clearScheduledTimers()
    showBotTakeoverPopup = false
    render()
  }

  // Realtime emoji picker (виж task-а "Ludo emoji" §2/§3) — reuse-ва
  // СЪЩИЯ animated-emoji каталог/asset URL-и/id scheme като активна игра
  // Белот (renderLudoEmojiPickerHtml в renderLudoBottomBar.ts). За разлика
  // от exit-confirm/game-end popup-ите, ТОВА НЕ е full-screen blocking
  // modal — лек floating panel, който не бива да пречи на dice/board
  // кликове извън себе си (виж task-а §6 "да не блокира dice click").
  // Затова explicit НЕ минава през syncModalLayerInteractivity() (която
  // прави ЦЕЛИЯ viewport-size modalLayerRoot pointer-events:auto само защото
  // childElementCount>0) — вместо това panel-ът сам носи pointer-events:auto,
  // modalLayerRoot остава pointer-events:none наоколо него.
  function mountEmojiPicker(): void {
    if (modalLayerRoot.querySelector('[data-ludo-emoji-picker="1"]')) return
    const container = document.createElement('div')
    container.innerHTML = renderLudoEmojiPickerHtml()
    const panel = container.firstElementChild
    if (!(panel instanceof HTMLElement)) return
    panel.style.pointerEvents = 'auto'
    modalLayerRoot.appendChild(panel)
    panel.querySelectorAll<HTMLButtonElement>('[data-ludo-emoji-pick]').forEach((button) => {
      button.addEventListener('click', () => {
        const emojiId = button.getAttribute('data-ludo-emoji-pick')
        if (!emojiId) return
        closeEmojiPicker()
        if (options.authoritative && authoritativeSnapshot) {
          options.authoritative.onEmojiReactionSend?.(authoritativeSnapshot.matchId, emojiId)
        } else {
          // Non-authoritative dev/manual harness (виж task-а т.21 doc
          // коментара при LudoFlowControllerOptions.initialState) — няма
          // сървър да echo-не обратно, затова local preview directno тук
          // (не production multiplayer път, единствения начин изобщо да се
          // тества презентацията без реален match).
          addEmojiReaction(localColor, emojiId)
        }
      })
    })
    document.addEventListener('click', handleEmojiPickerOutsideClick, { capture: true })
  }

  function closeEmojiPicker(): void {
    isEmojiPickerOpen = false
    modalLayerRoot.querySelector('[data-ludo-emoji-picker="1"]')?.remove()
    document.removeEventListener('click', handleEmojiPickerOutsideClick, { capture: true })
  }

  function handleEmojiPickerOutsideClick(event: MouseEvent): void {
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('[data-ludo-emoji-picker="1"]') || target.closest('[data-ludo-emoji-button="1"]')) return
    closeEmojiPicker()
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
    if (modalLayerRoot.querySelector('[data-ludo-bot-takeover-backdrop="1"]')) return
    const container = document.createElement('div')
    container.innerHTML = renderLudoBotTakeoverPopup()
    const backdrop = container.firstElementChild
    if (backdrop instanceof HTMLElement) {
      backdrop.style.pointerEvents = 'auto'
      modalLayerRoot.appendChild(backdrop)
      syncModalLayerInteractivity()
    }
    modalLayerRoot.querySelector('[data-ludo-bot-takeover-dismiss="1"]')?.addEventListener('click', () => {
      if (options.authoritative && authoritativeSnapshot) {
        const button = modalLayerRoot.querySelector<HTMLButtonElement>('[data-ludo-bot-takeover-dismiss="1"]')
        if (button?.disabled) return
        if (button) {
          button.disabled = true
          button.textContent = 'Изчакай...'
        }
        options.authoritative.onReclaimRequest(authoritativeSnapshot.matchId, authoritativeRevision)
        return
      }
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
      const el = modalLayerRoot.querySelector('[data-ludo-bot-takeover-backdrop="1"]')
      el?.remove()
      syncModalLayerInteractivity()
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
      openExitConfirmPopup()
    })

    options.root.querySelector('[data-ludo-settings-button="1"]')?.addEventListener('click', () => {
      openSettingsPopup()
    })

    options.root.querySelector('[data-ludo-dice-roll-button="1"]')?.addEventListener('click', () => {
      if (options.authoritative && authoritativeSnapshot) {
        options.authoritative.onRollRequest(authoritativeSnapshot.matchId, authoritativeRevision)
      } else {
        void handleHumanRollClick()
      }
    })

    options.root.querySelector('[data-ludo-emoji-button="1"]')?.addEventListener('click', () => {
      if (isEmojiPickerOpen) { closeEmojiPicker(); return }
      isEmojiPickerOpen = true
      mountEmojiPicker()
    })

    options.root.querySelectorAll<HTMLElement>('[data-ludo-piece-selectable="1"]').forEach((el) => {
      el.addEventListener('click', () => {
        const pieceId = el.getAttribute('data-ludo-piece') as LudoPieceId | null
        if (!pieceId) return
        if (options.authoritative && authoritativeSnapshot) {
          const slot = ludoUiPieceIdToSlot(pieceId)
          options.authoritative.onMoveRequest(authoritativeSnapshot.matchId, authoritativeRevision, slot)
        } else {
          void handleHumanPieceClick(pieceId)
        }
      })
    })

    window.addEventListener('resize', handleResize)
  }

  function requestExit(): void {
    options.onExit(authoritativeSnapshot?.matchId)
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
      activeMoveOverlayCancel?.()
      activeMoveOverlayCancel = null
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
    const targetCellId = ludoEnginePositionToCellId(move.targetPosition, color)
    const sourcePieceEl = options.root.querySelector<HTMLElement>(
      `[data-ludo-piece="${pieceId}"], [data-ludo-piece-group~="${pieceId}"]`,
    )
    const sourceCellEl = options.root.querySelector<HTMLElement>(`[data-ludo-cell-pieces="${fromCellId}"]`)
    const targetCellEl = options.root.querySelector<HTMLElement>(`[data-ludo-cell-pieces="${targetCellId}"]`)
    const sourcePieceRect = sourcePieceEl?.getBoundingClientRect()
    const sourceCellRect = sourceCellEl?.getBoundingClientRect()
    const targetCellRect = targetCellEl?.getBoundingClientRect()
    const sourceIsHome = parseLudoCellId(fromCellId).kind === 'home'
    const boardPieceSizePx = Math.min(30, (targetCellRect?.width ?? sourceCellRect?.width ?? 38) * 0.8) * LUDO_BOARD_PAWN_SCALE
    const pieceSizePx = sourceIsHome ? boardPieceSizePx : (sourcePieceRect?.width ?? boardPieceSizePx)

    isAnimatingMove = true
    clearScheduledTimers()

    const moveResult = dispatch({ type: 'MOVE_REQUESTED', color, slot, expectedTurnVersion: engineState.turnVersion })
    const isGameWinningMove = moveResult.state.status === 'finished' && moveResult.state.winnerColor === color
    const capturedEvent = moveResult.events.find((e) => e.type === 'pieces_captured')
    const capturedPieceIds = capturedEvent && capturedEvent.type === 'pieces_captured' ? capturedEvent.capturedPieceIds : []

    // Phase 3B (виж task-а т.12): buildLudoMoveRoute вече покрива И четирите
    // canonical прехода (home->track/track->track/track->finish/finish->
    // finish, виж board/ludoMoveRoute.ts) — вече няма нужда от отделен
    // early-return за "target.kind !== 'track'" (Phase 3A special case);
    // route loop-ът по-долу работи еднакво за всички.
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
    suppressedPieceIds.add(pieceId)
    render()
    const moveOverlay = playLudoMoveRouteOverlay({
      root: options.root,
      pieceId,
      fromCellId,
      route,
      pieceSizePx,
      initiallyHidden: areGameplayOverlaysHiddenForPopup,
      isGameWinningMove,
    })
    activeMoveOverlayCancel = moveOverlay.cancel
    await moveOverlay.finished
    activeMoveOverlayCancel = null
    if (isDestroyed) return
    suppressedPieceIds.delete(pieceId)
    render()

    // Attacker-ът вече е визуално пристигнал на target клетката (route
    // loop-ът завърши) — чак СЕГА следва impact/capture анимацията. Victims
    // все още стоят на target-а (captureVictimOverrides по-горе), точно
    // както изисква task-а: "attacker reaches target → collision/capture →
    // victim flies home", не обратно.
    if (capturedPieceIds.length > 0) {
      await animateCapture(capturedPieceIds)
      if (isDestroyed) return
      // Impact анимацията приключи — маха се presentation override-ът за
      // ТОЧНО тези victim id-та (не целия map — defensive за евентуален
      // бъдещ overlapping capture, макар Phase 3A да няма такъв сценарий).
      // Следващият render() вече показва canonical home позициите directno
      // от engineState.pieces.
      captureVictimOverrides = clearLudoCaptureVictimOverrides(capturedPieceIds, captureVictimOverrides)
    }

    diceResultOverlay.clearLanded()
    activeMoveOverlayCancel = null
    suppressedPieceIds.delete(pieceId)
    isAnimatingMove = false
    render()

    if (isGameWinningMove) {
      presentGameEndOnce()
      return
    }

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
  async function animateCapture(capturedPieceIds: readonly LudoPieceId[], isPresentationCurrent: () => boolean = () => true): Promise<void> {
    const representativeEl = options.root.querySelector<HTMLElement>(
      `[data-ludo-piece="${capturedPieceIds[0]}"], [data-ludo-piece-group~="${capturedPieceIds[0]}"]`,
    )
    if (!representativeEl) return
    representativeEl.style.setProperty('animation', 'ludo-piece-shake 400ms ease-in-out')
    await wait(IMPACT_ANIMATION_MS)
    if (!isPresentationCurrent()) return

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
    if (!isPresentationCurrent()) return

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
        if (!isPresentationCurrent()) return
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

  function syncAuthoritativeDeadline(snapshot: LudoGameStateSnapshot): void {
    if (snapshot.deadlineAt === null) {
      turnStartedAt = Date.now()
      return
    }
    const duration = snapshot.state.turnPhase === 'awaiting_move_selection' ? LUDO_MOVE_TIMEOUT_MS : LUDO_ROLL_TIMEOUT_MS
    const localDeadline = Date.now() + Math.max(0, snapshot.deadlineAt - snapshot.serverNow)
    turnStartedAt = localDeadline - duration
  }

  function invalidateAuthoritativePresentations(): void {
    presentationEpoch += 1
    authoritativeTransitionQueue = Promise.resolve()
    activeMoveOverlayCancel?.()
    activeMoveOverlayCancel = null
    diceResultOverlay.clearLanded()
    document.querySelectorAll('[data-ludo-capture-flight], [data-ludo-capture-impact]').forEach((element) => element.remove())
    suppressedPieceIds.clear()
    captureVictimOverrides = new Map()
    isDiceRolling = false
    isAnimatingMove = false
    // Виж justLeftColor doc коментара при декларацията му — foreground snap/
    // epoch invalidation не бива да остави stale "Излезе от играта" blink
    // window/timer нито stale презаписан forfeit-flight в опашката (виж §8
    // "не replay-вай historical leave animation").
    justLeftColor = null
    clearJustLeftColorTimer()
    // Realtime emoji reactions са transient presentation, никога не се
    // персистират/replay-ват от snapshot (виж task-а "Ludo emoji" §9) —
    // foreground snap/revision-gap resync не бива да остави stale bubble,
    // видима седейки от преди прозореца на прекъсването.
    clearEmojiReactionTimers()
    // Presentation gate reset (виж presentationGateSnapshot doc коментара) —
    // same established pattern като isAnimatingMove/movingPieceSuppressedId
    // по-горе: foreground snap/epoch invalidation не бива да остави "замразен"
    // gate отворен, докато stale presentAuthoritativeMove promise-ът никога
    // не стигне до собствения си release (epoch guard-ът там просто връща
    // рано, виж call site-а) — reset-ва се ТУК, синхронно, независимо от
    // изхода на прекъснатия promise.
    presentationGateSnapshot = null
  }

  function snapToAuthoritativeSnapshot(snapshot: LudoGameStateSnapshot): void {
    invalidateAuthoritativePresentations()
    authoritativeRevision = snapshot.revision
    highestReceivedAuthoritativeRevision = Math.max(highestReceivedAuthoritativeRevision, snapshot.revision)
    authoritativeSnapshot = snapshot
    engineState = snapshot.state
    orchestrator = { ...orchestrator, botControlledColors: new Set(snapshot.botControlledColors) }
    showBotTakeoverPopup = snapshot.state.status !== 'finished' && snapshot.botControlledColors.includes(localColor)
    if (!showBotTakeoverPopup) {
      diceResultOverlay.setHidden(false)
      areGameplayOverlaysHiddenForPopup = false
      modalLayerRoot.querySelector('[data-ludo-bot-takeover-backdrop="1"]')?.remove()
      syncModalLayerInteractivity()
    }
    syncAuthoritativeDeadline(snapshot)
    if (snapshot.state.status === 'finished' && snapshot.state.winnerColor !== null) {
      presentGameEndOnce(false)
      return
    }
    render()
  }

  function handleVisibilityChange(): void {
    if (!options.authoritative) return
    if (document.visibilityState === 'hidden') {
      invalidateAuthoritativePresentations()
      return
    }
    awaitingVisibilityResync = true
    if (authoritativeSnapshot) snapToAuthoritativeSnapshot(authoritativeSnapshot)
    options.authoritative.onStateRefreshRequest?.()
  }

  async function presentAuthoritativeRoll(snapshot: LudoGameStateSnapshot, epoch: number): Promise<boolean> {
    if (epoch !== presentationEpoch) return false
    const event = snapshot.events.find((item) => item.type === 'dice_accepted')
    if (!event || event.type !== 'dice_accepted') return true
    isDiceRolling = true
    render()
    const triggerEl = options.root.querySelector<HTMLElement>(`[data-ludo-dice-anchor="${event.color}"]`)
    const centerEl = options.root.querySelector<HTMLElement>('[data-ludo-board-center="1"]')
    const boardEl = options.root.querySelector<HTMLElement>('[data-ludo-board="1"]')
    if (!centerEl || !boardEl) {
      isDiceRolling = false
      return true
    }
    await diceResultOverlay.playFlight({
      fromRect: (triggerEl ?? centerEl).getBoundingClientRect(),
      toRect: centerEl.getBoundingClientRect(),
      boardGridWidthPx: boardEl.getBoundingClientRect().width,
      result: event.value as 1 | 2 | 3 | 4 | 5 | 6,
    })
    if (epoch !== presentationEpoch) return false
    isDiceRolling = false
    return true
  }

  async function presentAuthoritativeMove(previous: LudoGameState, snapshot: LudoGameStateSnapshot, epoch: number): Promise<boolean> {
    if (epoch !== presentationEpoch) return false
    const moved = snapshot.events.find((item) => item.type === 'piece_moved')
    if (!moved || moved.type !== 'piece_moved') return true
    const pieceId = `${moved.color}-${moved.slot}` as LudoPieceId
    const fromCellId = ludoEnginePositionToCellId(moved.fromPosition, moved.color)
    const targetCellId = ludoEnginePositionToCellId(moved.toPosition, moved.color)
    const sourcePieceEl = options.root.querySelector<HTMLElement>(`[data-ludo-piece="${pieceId}"], [data-ludo-piece-group~="${pieceId}"]`)
    const sourceCellEl = options.root.querySelector<HTMLElement>(`[data-ludo-cell-pieces="${fromCellId}"]`)
    const targetCellEl = options.root.querySelector<HTMLElement>(`[data-ludo-cell-pieces="${targetCellId}"]`)
    const sourceRect = sourcePieceEl?.getBoundingClientRect()
    const sourceCellRect = sourceCellEl?.getBoundingClientRect()
    const targetRect = targetCellEl?.getBoundingClientRect()
    const sourceIsHome = parseLudoCellId(fromCellId).kind === 'home'
    const boardPieceSize = Math.min(30, (targetRect?.width ?? sourceCellRect?.width ?? 38) * 0.8) * LUDO_BOARD_PAWN_SCALE
    const pieceSizePx = sourceIsHome ? boardPieceSize : (sourceRect?.width ?? boardPieceSize)
    const capture = snapshot.events.find((item) => item.type === 'pieces_captured')
    const capturedPieceIds = capture?.type === 'pieces_captured' ? capture.capturedPieceIds : []
    if (capturedPieceIds.length > 0) {
      captureVictimOverrides = createLudoCaptureVictimOverrides(capturedPieceIds, targetCellId, captureVictimOverrides)
    }
    isAnimatingMove = true
    // Отваряме presentation gate-а ТУК — ПРЕДИ engineState да се презапише
    // на реда отдолу — liveTurnPresentationSnapshot() затова все още чете
    // ПРЕДИШНИЯ (pre-move) engineState/turnStartedAt (== `previous`, същия
    // reference), а не вече-авансирания snapshot.state (виж
    // presentationGateSnapshot doc коментара при декларацията му за пълния
    // root-cause rationale). Затваря се долу, СЛЕД финалния landing render.
    presentationGateSnapshot = liveTurnPresentationSnapshot()
    suppressedPieceIds.add(pieceId)
    engineState = snapshot.state
    render()
    const overlay = playLudoMoveRouteOverlay({
      root: options.root,
      pieceId,
      fromCellId,
      route: buildLudoMoveRoute(fromCellId, targetCellId),
      pieceSizePx,
      initiallyHidden: false,
      isGameWinningMove: previous.status !== 'finished' && snapshot.state.status === 'finished',
    })
    activeMoveOverlayCancel = overlay.cancel
    await overlay.finished
    if (epoch !== presentationEpoch) return false
    activeMoveOverlayCancel = null
    suppressedPieceIds.delete(pieceId)
    // RELEASE presentation gate — точно тук, веднага след движещата се
    // пионка стъпи на последното си поле (route overlay resolved), ПРЕДИ
    // render()-а веднага долу — следващия render() вече показва LIVE
    // engineState (следващия играч avatar->dice swap + countdown UI се
    // появяват точно СЕГА, не по-рано). Capture impact/flight (ако има) тече
    // СЛЕД това — отделен board-level visual слой, не player панела, затова
    // gate-ът не чака и него (виж task-а: "не по-рано от final landing",
    // изрично позволено да не чака ЦЕЛИЯ presentation).
    presentationGateSnapshot = null
    render()
    if (capturedPieceIds.length > 0) {
      await animateCapture(capturedPieceIds, () => epoch === presentationEpoch)
      if (epoch !== presentationEpoch) return false
      captureVictimOverrides = clearLudoCaptureVictimOverrides(capturedPieceIds, captureVictimOverrides)
    }
    diceResultOverlay.clearLanded()
    isAnimatingMove = false
    return true
  }

  // Explicit "Изход" forfeit presentation (виж task-а §2/§4/§8). Reuse-ва
  // playLudoCaptureFlightOverlay (директен smooth flight, СЪЩИЯТ pattern
  // като capture victim flight-а) за ВСЯКА извадена пионка на forfeit-налия
  // цвят, паралелно (Promise.all) — "не прави duplicate animation
  // framework". Presentation gate (presentationGateSnapshot + isAnimatingMove,
  // reuse-нати от move presentation-а) остава отворен докато flights текат,
  // за да не изскочи next-turn dice control преди пионките реално да са
  // "кацнали" в home (виж §8). Отделен, независим 5-секунден "Излезе от
  // играта" blink прозорец (justLeftColor) стартира В МОМЕНТА на presentation-а
  // (§2.3) — продължава дори след flights/gate release-а за non-finishing
  // случая (§7 4-player, играта продължава веднага след flight-а завърши,
  // остатъкът от blink-а е чисто декоративен, не блокира никого).
  async function presentAuthoritativeForfeit(previous: LudoGameState, snapshot: LudoGameStateSnapshot, epoch: number): Promise<boolean> {
    if (epoch !== presentationEpoch) return false
    const forfeitEvent = snapshot.events.find((item) => item.type === 'player_forfeited')
    if (!forfeitEvent || forfeitEvent.type !== 'player_forfeited') return true

    // Измерваме ВСЯКА извадена пионка ПРЕДИ engineState да се презапише —
    // DOM-ът още показва previous позициите (mirror-нато на
    // presentAuthoritativeMove's sourcePieceEl измерване).
    const flightTargets = forfeitEvent.collectedPieceIds.flatMap((pieceId) => {
      const pieceEl = options.root.querySelector<HTMLElement>(
        `[data-ludo-piece="${pieceId}"], [data-ludo-piece-group~="${pieceId}"]`,
      )
      const [color, slotStr] = pieceId.split('-')
      const homeCellId = `home-${color}-${slotStr}`
      const homeEl = options.root.querySelector<HTMLElement>(`[data-ludo-cell-pieces="${homeCellId}"]`)
      if (!pieceEl || !homeEl) return []
      return [{
        pieceId,
        fromRect: pieceEl.getBoundingClientRect(),
        toRect: homeEl.getBoundingClientRect(),
        pieceSizePx: pieceEl.getBoundingClientRect().width,
      }]
    })

    const isMatchFinishingHere = previous.status !== 'finished' && snapshot.state.status === 'finished'

    presentationGateSnapshot = liveTurnPresentationSnapshot()
    isAnimatingMove = true
    flightTargets.forEach(({ pieceId }) => suppressedPieceIds.add(pieceId))
    justLeftColor = forfeitEvent.color
    clearJustLeftColorTimer()
    justLeftColorTimer = setTimeout(() => {
      justLeftColorTimer = null
      if (epoch !== presentationEpoch) return
      justLeftColor = null
      render()
    }, 5_000)

    engineState = snapshot.state
    render()

    const flightStartedAt = Date.now()
    const flightsCompleted = Promise.all(
      flightTargets.map(({ pieceId, fromRect, toRect, pieceSizePx }) =>
        playLudoCaptureFlightOverlay({ pieceId, fromRect, toRect, pieceSizePx, initiallyHidden: areGameplayOverlaysHiddenForPopup }),
      ),
    )

    // Всяка playLudoCaptureFlightOverlay премахва СВОЯ overlay възел веднага
    // щом СОБСТВЕНАТА ѝ ~500ms анимация приключи (виж doc коментара в
    // playLudoCaptureFlightOverlay.ts) — НЕЗАВИСИМО от долния max(5s, flights)
    // изчакване. Затова reveal-ът (suppressedPieceIds delete + render) ТРЯБВА
    // да стане веднага щом flightsCompleted резолвне, а НЕ да чака и
    // остатъка от 5-те секунди — иначе overlay-ят изчезва (self-removed), но
    // static board рендерът пак филтрира пионката (все още suppressed), и тя
    // остава невидима до края на wait-а ("кацат, веднага след това изчезват"
    // bug). Гейтът (presentationGateSnapshot/isAnimatingMove — управлява
    // dice/turn UI + winner popup timing, НЕ piece visibility) остава
    // отделно, освобождава се едва след пълния max(5s, flights).
    await flightsCompleted
    if (epoch !== presentationEpoch) return false
    flightTargets.forEach(({ pieceId }) => suppressedPieceIds.delete(pieceId))
    render()

    // Winner popup чака max(5s, flights) — виж task-а §2.3 "И pawn-return
    // flight animation-ите да са приключили". За non-finishing forfeit
    // (играта продължава) НЕ изкуствено забавяме следващия играч — гейтът
    // release-ва веднага след flights (§8), 5-те секунди за blink-а текат
    // независимо чрез justLeftColorTimer по-горе.
    if (isMatchFinishingHere) {
      const remainingMs = 5_000 - (Date.now() - flightStartedAt)
      if (remainingMs > 0) await wait(remainingMs)
      if (epoch !== presentationEpoch) return false
    }

    presentationGateSnapshot = null
    isAnimatingMove = false
    render()
    return true
  }

  async function applyAuthoritativeTransition(snapshot: LudoGameStateSnapshot, epoch: number): Promise<void> {
    if (epoch !== presentationEpoch) return
    if (!options.authoritative || snapshot.matchId !== options.authoritative.initialSnapshot.matchId) return
    if (snapshot.revision <= authoritativeRevision) return
    const previous = engineState
    authoritativeRevision = snapshot.revision
    authoritativeSnapshot = snapshot
    orchestrator = { ...orchestrator, botControlledColors: new Set(snapshot.botControlledColors) }
    if (snapshot.events.some((item) => item.type === 'bot_takeover_started' && item.color === localColor)) {
      showBotTakeoverPopup = true
    }
    if (!snapshot.botControlledColors.includes(localColor)) {
      showBotTakeoverPopup = false
      diceResultOverlay.setHidden(false)
      areGameplayOverlaysHiddenForPopup = false
      modalLayerRoot.querySelector('[data-ludo-bot-takeover-backdrop="1"]')?.remove()
      syncModalLayerInteractivity()
    }
    syncAuthoritativeDeadline(snapshot)
    if (snapshot.events.some((item) => item.type === 'dice_accepted')) {
      if (!await presentAuthoritativeRoll(snapshot, epoch)) return
    }
    if (snapshot.events.some((item) => item.type === 'piece_moved')) {
      if (!await presentAuthoritativeMove(previous, snapshot, epoch)) return
    } else if (snapshot.events.some((item) => item.type === 'player_forfeited')) {
      if (!await presentAuthoritativeForfeit(previous, snapshot, epoch)) return
    } else {
      engineState = snapshot.state
    }
    render()
    if (previous.status !== 'finished' && snapshot.state.status === 'finished') {
      presentGameEndOnce(!snapshot.events.some((item) => item.type === 'piece_moved'))
    }
  }

  // Realtime emoji reaction — реален server echo (виж task-а "Ludo emoji"
  // §4), НЕ optimistic local render дори за самия sender (огледално на
  // Belot's send_emoji_reaction/emoji_reaction flow — клиентът винаги чака
  // сървъра). matchId guard-ът пази срещу late-arriving съобщение за
  // предишен match instance (същия pattern като applyAuthoritativeSnapshot
  // по-долу). emojiId се re-validate-ва и client-side (defense-in-depth,
  // сървърът вече е validate-нал каталог range-а в parseClientMessage.ts) —
  // невалиден id никога не стига до getAnimatedEmojiUrl().
  function applyEmojiReaction(matchId: string, color: LudoColor, emojiId: string): void {
    if (!options.authoritative || matchId !== options.authoritative.initialSnapshot.matchId) return
    if (!isValidAnimatedEmojiId(emojiId)) return
    addEmojiReaction(color, emojiId)
  }

  function applyAuthoritativeSnapshot(snapshot: LudoGameStateSnapshot, prizeAmount: number | null): void {
    if (!options.authoritative || snapshot.matchId !== options.authoritative.initialSnapshot.matchId) return
    if (prizeAmount !== null) latestPrizeAmount = prizeAmount
    if (document.visibilityState === 'hidden') {
      if (snapshot.revision > highestReceivedAuthoritativeRevision) snapToAuthoritativeSnapshot(snapshot)
      return
    }
    if (awaitingVisibilityResync) {
      if (snapshot.revision >= authoritativeRevision) snapToAuthoritativeSnapshot(snapshot)
      awaitingVisibilityResync = false
      return
    }
    if (snapshot.revision <= highestReceivedAuthoritativeRevision) return
    const hasRevisionGap = snapshot.revision > highestReceivedAuthoritativeRevision + 1
    highestReceivedAuthoritativeRevision = snapshot.revision
    if (hasRevisionGap) {
      snapToAuthoritativeSnapshot(snapshot)
      return
    }
    const epoch = presentationEpoch
    authoritativeTransitionQueue = authoritativeTransitionQueue.then(() => applyAuthoritativeTransition(snapshot, epoch))
  }

  function destroy(): void {
    isDestroyed = true
    window.removeEventListener('resize', handleResize)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    document.removeEventListener('click', handleEmojiPickerOutsideClick, { capture: true })
    if (resizeTimer) clearTimeout(resizeTimer)
    clearScheduledTimers()
    clearEmojiReactionTimers()
    activeMoveOverlayCancel?.()
    activeMoveOverlayCancel = null
    diceResultOverlay.clearLanded()
    modalLayerRoot.remove()
  }

  // scheduleNextDeadline() ПРЕДИ render() — same fix принцип за консистентност
  // (виж advanceTurn/performRollSequence коментарите по-горе), макар тук
  // ефектът да е незначителен (turnStartedAt вече е Date.now() от module
  // init, разликата е под 1ms).
  if (options.authoritative) syncAuthoritativeDeadline(options.authoritative.initialSnapshot)
  else scheduleNextDeadline()
  document.addEventListener('visibilitychange', handleVisibilityChange)
  render()

  return { destroy, applyAuthoritativeSnapshot, applyEmojiReaction, requestExit }
}
