// "Roll result presentation" слой — умишлено ОТДЕЛЕН от dice control
// launcher-а в player card-а (renderLudoDiceControl.ts). Launcher-ът е само
// бутон: статична картинка + въртящи се стрелки, НИКОГА не показва
// резултата (виж task-а). Тук, вместо това, живее РЕАЛНОТО хвърляне —
// зарче, което лети от карето на активния играч към центъра на дъската,
// върти се в истинско 3D по пътя, и едва като кацне показва падналото
// число.
//
// Преизползва СЪЩЕСТВУВАЩИЯ (по-рано незакачен никъде) 3D dice cube —
// renderLudoDice.ts + computeLudoDiceThrowTransform от ludoDiceState.ts —
// вместо нов dice visual: реален rotateX/rotateY tumble до точно
// правилната страна, готов, тестван код, не преоткриваме колелото.
//
// Overlay-ят се append-ва в document.body (НЕ в screen root-а), за да
// оцелее евентуален render() re-render на екрана по време на полета (виж
// createLudoFlowController.ts — render() прави пълен innerHTML replace на
// root-а, което би унищожило overlay-а, ако беше негов child).

import { renderLudoDice } from './renderLudoDice'
import { computeLudoDiceThrowTransform, type LudoDiceFace } from './ludoDiceState'
import { LUDO_DICE_OVERLAY_Z_INDEX } from '../ludoLayerHierarchy'

// = точно вградения 900ms transition в renderLudoDice.ts (data-ludo-dice-
// cube style), за да кацват "полетът" (WAAPI, container-а) и "завъртането"
// (CSS transition, кубчето) ЕДНОВРЕМЕННО, като едно цяло движение.
const FLIGHT_DURATION_MS = 900

const DICE_ROLL_SOUND_SRC = '/audio/ludo/dice-roll.mp3'

// Минимален presentation audio side effect — НЕ gameplay logic, не мутира
// game state. Нов Audio() instance на всеки roll (не pooled), тъй като dice
// roll не е latency-critical/high-frequency като card-sfx (виж
// createGameAudioController.ts CARD_SFX_POOL_SIZE коментара) — просто
// презапочва играенето, ако предходният roll звук все още звучи. play()
// rejection (autoplay restriction, тих tab, etc.) се игнорира тихо — звукът
// е чисто декоративен, никога не трябва да чупи хвърлянето.
function playLudoDiceRollSound(): void {
  if (typeof Audio === 'undefined') return
  const audio = new Audio(DICE_ROLL_SOUND_SRC)
  void audio.play().catch(() => {})
}

// Responsive dice sizing (виж task-а — bug fix: зарът преди беше твърд
// 64px, на mobile дъската се смалява, но той не, значи изглеждаше
// прекалено голям). BOARD_COLUMNS=15 — Ludo дъската е 15x15 grid (виж
// renderLudoBoard.ts GRID_SIZE). DICE_TO_CELL_RATIO е ИЗМЕРЕНА (не
// произволна) стойност: на референтния desktop layout (1440x900)
// boardGridWidth=642px → cellSize=642/15=42.8px, а одобреният визуален
// dice размер там беше 64px → 64/42.8 ≈ 1.4953, закръглено до 1.5 (delta
// spрямо desktop <0.3px, практически незабележимо — desktop визуалният
// размер остава same). Формулата се прилага ЕДНАКВО на всеки viewport:
// diceSize = (boardGridWidthPx / BOARD_COLUMNS) * DICE_TO_CELL_RATIO —
// няма отделни hardcoded desktop/mobile стойности никъде.
const BOARD_COLUMNS = 15
const DICE_TO_CELL_RATIO = 1.5

export interface LudoDiceFlightOptions {
  fromRect: DOMRect // launcher-ът в player card-а, измерен ПРЕДИ click re-render-а
  toRect: DOMRect // data-ludo-board-center="1" — реалният геометричен център на дъската
  boardGridWidthPx: number // [data-ludo-board="1"] ширина, измерена ПРЕДИ click re-render-а — извежда responsive dice размера (виж DICE_TO_CELL_RATIO по-горе)
  result: LudoDiceFace
  // Начално visibility състояние на container-а, приложено ВЕДНАГА при
  // създаването му, ПРЕДИ да бъде appended и flight анимацията да започне
  // (виж bug fix audit-а в createLudoDiceResultOverlayController по-долу —
  // предишната версия прилагаше hidden state едва СЛЕД await на целия
  // 900ms flight, значи летящото зарче оставаше видимо цялото това време
  // дори ако bot-takeover popup-ът вече беше отворен).
  initiallyHidden: boolean
}

// Резолвва се с DOM елемента на "кацналото" зарче — то остава видимо в
// центъра (показва резултата), докато следващото хвърляне не го премахне
// (виж landedDiceOverlayEl в createLudoFlowController.ts). Overlay-ът е
// pointer-events:none през цялото време — не пречи на нищо под него.
export async function playLudoDiceFlightOverlay(options: LudoDiceFlightOptions): Promise<HTMLElement> {
  const { fromRect, toRect, boardGridWidthPx, result, initiallyHidden } = options
  const fromX = fromRect.left + fromRect.width / 2
  const fromY = fromRect.top + fromRect.height / 2
  const toX = toRect.left + toRect.width / 2
  const toY = toRect.top + toRect.height / 2
  // Лек арк нагоре по средата на пътя — четимо като "хвърляне", не плъзгане
  // по права линия. Умерен offset (max 60px), за да остане елегантно.
  const arcLiftPx = Math.min(60, Math.max(24, Math.abs(toY - fromY) * 0.3))
  const midX = (fromX + toX) / 2
  const midY = (fromY + toY) / 2 - arcLiftPx

  // Реалният cell размер спрямо ТЕКУЩИЯ (в момента на click-а) layout —
  // виж DICE_TO_CELL_RATIO по-горе. Един и същ diceSize се ползва и за
  // летящото, и за кацналото зарче (СЪЩИЯТ DOM node цялото време, виж
  // по-долу), значи няма resize/pop между полет и landing.
  const cellSizePx = boardGridWidthPx / BOARD_COLUMNS
  const diceSizePx = cellSizePx * DICE_TO_CELL_RATIO

  const container = document.createElement('div')
  container.setAttribute('data-ludo-dice-flight', '1')
  container.style.cssText = `
    position:fixed;
    left:${fromX}px; top:${fromY}px;
    transform:translate(-50%, -50%) scale(0.8);
    z-index:${LUDO_DICE_OVERLAY_Z_INDEX};
    pointer-events:none;
    visibility:${initiallyHidden ? 'hidden' : 'visible'};
  `
  // isRolling=false тук нарочно — начална поза БЕЗ transition (иначе кубът
  // би "долетял" визуално от произволна предходна rotation стойност).
  // Реалният tumble се включва отделно, 1 кадър по-късно, директно през
  // style.transition — виж долу.
  container.innerHTML = renderLudoDice(diceSizePx, { x: 0, y: 0 }, false)
  document.body.appendChild(container)

  const cubeEl = container.querySelector<HTMLElement>('[data-ludo-dice-cube="1"]')

  // ВАЖНО (виж audit-а в task-а — "pop" bug fix): border-radius/width/
  // height/face geometry НИКОГА не се променят тук или в renderLudoDice.ts
  // — единственото, което варира по време на полета, е transform:scale на
  // ТОЗИ container (външен wrapper около целия dice markup). Старата версия
  // имаше overshoot ДО scale(1.16) чак на offset:0.9, после рязко се
  // връщаше на scale(1) за последните 90ms от 900ms анимацията — тази
  // рязка АБСОЛЮТНА промяна в размера (border-radius е фиксирана px
  // стойност, при по-голям visual scale изглежда пропорционално по-
  // заоблена, после рязко "щраква" по-остра при връщането) създаваше
  // видимо "pop" точно преди landing. Сега overshoot-ът е по-рано (offset
  // 0.45, далеч от края) и е много по-умерен (1.05 вместо 1.16), а
  // settle-ването към scale(1) е разпределено над ОСТАТЪЧНАТА половина
  // от анимацията (0.45 → 1.0 = 495ms), не концентрирано в последните
  // ~90ms — визуално плавно, без резки промени точно преди кацането.
  const flightAnimation = container.animate(
    [
      { left: `${fromX}px`, top: `${fromY}px`, transform: 'translate(-50%, -50%) scale(0.85)', offset: 0 },
      { left: `${midX}px`, top: `${midY}px`, transform: 'translate(-50%, -50%) scale(1.05)', offset: 0.45 },
      { left: `${toX}px`, top: `${toY}px`, transform: 'translate(-50%, -50%) scale(1)', offset: 1 },
    ],
    { duration: FLIGHT_DURATION_MS, easing: 'cubic-bezier(0.32, 0.64, 0.3, 1)', fill: 'forwards' },
  )

  requestAnimationFrame(() => {
    if (!cubeEl) return
    const target = computeLudoDiceThrowTransform(result)
    cubeEl.style.transition = `transform ${FLIGHT_DURATION_MS}ms cubic-bezier(0.25, 0.8, 0.3, 1)`
    cubeEl.style.transform = `rotateX(${target.x}deg) rotateY(${target.y}deg)`
  })

  await flightAnimation.finished
  return container
}

// --- Lifecycle API -------------------------------------------------------
// Единствено място, което пипа DOM-а на "кацналото" зарче (create/remove) —
// controller-ът (createLudoFlowController.ts) не прави собствен
// querySelector/remove никъде, само вика тези методи. Целта: зарчето в
// центъра живее СПРЯМО ХОДА (roll → избор на пионка → move/capture
// animation), не спрямо render() цикъла — то трябва да изчезне веднага
// след завършен ход, не да чака следващото хвърляне (виж task-а).
export interface LudoDiceResultOverlayController {
  // Спира (ако има) предходно "кацнало" зарче, пуска нов полет, пази
  // резултата като текущия "landed" overlay. Само ЕДИН overlay може да
  // съществува в даден момент — гарантирано тук, не разчита callers-ите
  // да го спазват сами. initiallyHidden НЕ е част от caller-ските опции —
  // controller-ът никога не мисли за hidden state per-call, той просто
  // вика playFlight(); текущото isHidden се инжектира вътрешно (виж
  // setHidden по-долу).
  playFlight(options: Omit<LudoDiceFlightOptions, 'initiallyHidden'>): Promise<void>
  // Маха текущото "кацнало" зарче (ако има) — вика се explicit СЛЕД
  // завършен ход (normal move: след step анимацията; capture move: след
  // целия animateCapture); ../createLudoFlowController.ts::handlePieceSelected),
  // и defensively при resize/destroy/нов roll.
  clearLanded(): void
  // Визуално скрива/показва overlay-а (whatever е mount-нат в момента, и
  // всеки БЪДЕЩ playFlight() докато е скрит) БЕЗ да го маха от DOM-а —
  // pointer-events вече е none, animation lifecycle-ът остава напълно
  // недокоснат (flight/rotation продължават да текат зад кулисите, само
  // visibility:hidden спира визуалния рендер). Използва се, докато
  // bot-takeover popup-ът е отворен — overlay-ят живее на document.body с
  // z-index над Ludo overlay root-а (виж коментара по-горе), затова не може
  // да остане визуално ПОД popup-а само чрез z-index подредба, без да
  // счупи нормалния "зар лети над дъската" изглед (виж createLudoFlowController.ts
  // audit-а за root cause).
  setHidden(hidden: boolean): void
}

export function createLudoDiceResultOverlayController(): LudoDiceResultOverlayController {
  let landedEl: HTMLElement | null = null
  let isHidden = false
  let flightGeneration = 0

  function applyHiddenState(el: HTMLElement): void {
    el.style.visibility = isHidden ? 'hidden' : 'visible'
  }

  function clearLanded(): void {
    flightGeneration += 1
    landedEl?.remove()
    landedEl = null
    document.querySelectorAll('[data-ludo-dice-flight="1"]').forEach((element) => element.remove())
  }

  async function playFlight(options: Omit<LudoDiceFlightOptions, 'initiallyHidden'>): Promise<void> {
    clearLanded()
    const generation = flightGeneration
    playLudoDiceRollSound()
    // isHidden се подава ВЕДНАГА, преди container-ът изобщо да бъде
    // appended — не изчакваме края на 900ms flight анимацията (виж bug fix
    // audit-а в LudoDiceFlightOptions по-горе), затова летящото зарче
    // никога не блясва видимо, ако popup-ът вече е отворен в момента, в
    // който bot-ъТ хвърля.
    const nextLandedEl = await playLudoDiceFlightOverlay({ ...options, initiallyHidden: isHidden })
    if (generation !== flightGeneration) {
      nextLandedEl.remove()
      return
    }
    landedEl = nextLandedEl
    applyHiddenState(landedEl)
  }

  function setHidden(hidden: boolean): void {
    isHidden = hidden
    if (landedEl) applyHiddenState(landedEl)
  }

  return { playFlight, clearLanded, setHidden }
}
