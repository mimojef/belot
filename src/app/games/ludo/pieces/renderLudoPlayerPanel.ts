// Player панел — адаптация на Belot "side seat" card-а (виж
// src/app/activeRoom/cutting/renderCuttingSeatPanels.ts:
// createCuttingSeatPanelHtml, side-seat клон ~1436-1519, и
// renderSideCuttingCountdownFooter ~219-296) — точно тази карта се
// вижда в реалния Belot gameplay екран (renderPlayingScreen.ts използва
// createCuttingSeatPanelsHtml за seat panel-ите по време на игра, не
// само в lobby/cutting).
//
// Взето директно от Belot pattern-а:
//  - голяма светла avatar кутия (inset 8px в картата), fallback инициали
//  - долен footer бар с името, тъмен фон + gold gradient countdown fill,
//    който drain-ва отляво надясно (border-top gold accent) — същият
//    визуален език като renderSideCuttingCountdownFooter.
// Адаптирано за Ludo (Belot няма per-seat цвят):
//  - card border/glow в цвета на играча — единственият identity сигнал
//    (текстов color badge беше премахнат: рамката сама е достатъчна) +
//    по-силен glow при активен ход, вместо Belot-овия неутрален gold
//    highlight;
//  - countdown fill-ът остава gold (както в Belot) — само появява се
//    и drain-ва за играча, чийто ред е сега, аналогично на
//    countdownSeat логиката в Belot.
// Не е взето (няма смисъл в Ludo): dealt card fans, bid/declaration
// балончета, gift икони, dealer badge, tournament bot replacement логика.
// Emoji reaction bubble-ът (виж renderLudoEmojiReactionBubble по-долу) Е
// взет — reuse-ва СЪЩИЯ animated-emoji каталог/asset URL-и като активна
// игра Белот (createActiveRoomFlowController.ts::addEmojiBubble +
// renderCuttingSeatPanels.ts::renderEmojiBubble), само позиционирането е
// адаптирано към Ludo card geometry (виж task-а "Ludo emoji" §5/§6).

import { LUDO_COLOR_HEX, LUDO_COLOR_LABEL } from '../ludoTypes'
import type { LudoColor, LudoPiece, LudoPlayer } from '../ludoTypes'
import { renderLudoDiceControl } from '../dice/renderLudoDiceControl'
import { getAnimatedEmojiUrl } from '../../../animatedEmoji/animatedEmojiAssets'
import { LUDO_EMOJI_REACTION_Z_INDEX } from '../ludoLayerHierarchy'

// Countdown продължителността вече е PARAMETRIZED (turnCountdownMs, виж
// renderLudoPlayerPanel сигнатурата) вместо fixed 20s — orchestrator-ът
// (createLudoFlowController.ts) подава реалната продължителност спрямо
// canonical turnPhase: 10s roll / 15s move / без countdown за bot (виж
// Phase 3A task-а т.19). Design-ът (SVG ring, footer fill, цветове) остава
// напълно непроменен — само числото се параметризира.
const DEFAULT_TURN_COUNTDOWN_MS = 20_000

// turnElapsedMs (подадено от renderLudoGameScreen, изчислено спрямо реален
// Date.now() deadline в createLudoFlowController.ts) се превръща в
// ОТРИЦАТЕЛЕН animation-delay — established pattern в проекта (виж
// renderCuttingCountdownFillStyle в renderCuttingSeatPanels.ts). Причина:
// countdown fill div-ът е чисто нов DOM node при ВСЕКИ render() (resize,
// dice roll, piece move — не само нов ход), а CSS animation на нов елемент
// винаги тръгва от 0%. Без този delay countdown-ът визуално би рестартирал
// на всеки такъв re-render — точно проблемът от audit-а (на mobile resize/
// viewport промени се случват много по-често заради динамичния browser
// chrome). С -elapsedMs delay, дори чисто нов елемент веднага "скача" на
// правилната текуща позиция, вместо да рестартира.
// Export-нат (не file-local) за directно pure тестване (виж task-а т.10 —
// checkLudoTimerPresentation.ts T1-T5/T8/T9) — самата формула е
// unchanged, само видимостта. Explicit параметри (turnElapsedMs,
// turnCountdownMs), без Date.now() вътре — детерминистично тестваем.
export function clampedTurnDelayMs(turnElapsedMs: number, turnCountdownMs: number): number {
  return Math.min(Math.max(turnElapsedMs, 0), turnCountdownMs)
}

// Mobile-only countdown визуализация (виж audit-а: 70px footer travel
// distance е твърде къс — на DPR1 mobile emulation се вижда стъпаловидно,
// въпреки перфектно smooth 60fps CSS анимация). Desktop countdown-ът
// (footer fill, по-долу в render-а) остава напълно непроменен.
//
// SVG rounded-square пръстен в празния inset между аватара и card border-а
// — периметър ~242px (срещу 70px на старата footer лента), затова същата
// 20s линейна drain-анимация показва видима промяна много по-често дори на
// DPR1. pathLength="100" нормализира дължината, за да не се налага ръчно
// пресмятане на точния геометричен периметър на заоблен path.
function buildMobileCountdownRingPath(size: number, inset: number, radius: number): string {
  const min = inset
  const max = size - inset
  const topMid = size / 2
  return [
    `M ${topMid},${min}`,
    `L ${max - radius},${min}`,
    `A ${radius},${radius} 0 0 1 ${max},${min + radius}`,
    `L ${max},${max - radius}`,
    `A ${radius},${radius} 0 0 1 ${max - radius},${max}`,
    `L ${min + radius},${max}`,
    `A ${radius},${radius} 0 0 1 ${min},${max - radius}`,
    `L ${min},${min + radius}`,
    `A ${radius},${radius} 0 0 1 ${min + radius},${min}`,
    `L ${topMid},${min}`,
  ].join(' ')
}

export interface LudoPlayerPanelDiceControl {
  isRollable: boolean
  // Единственото правило (виж renderLudoGameScreen.ts::renderPlayerPanelSlot
  // и task-а): true само когато ТОЗИ player е активен И
  // turnPhase==='waiting_for_roll' — не isDiceRolling/isRolling (временен UI
  // флаг, обвързан с "flight overlay в момента тече", а не с authoritative
  // turn phase — точно това беше root cause-ът на "arrows restart в
  // awaiting_move_selection" бъга).
  shouldRotateArrows: boolean
}

// Explicit "Изход" forfeit presentation (виж task-а "Explicit Изход от
// STARTED match" §2/§4):
//   'just-left' — първите 5 секунди след leave presentation-а: "Излезе от
//     играта", ясно червено, мигащо/pulsing, деликатна червена светлосенка.
//     Transient client-side presentation state (createLudoFlowController.ts
//     таймер), НЕ canonical — canonical-ото е само state.leftColors.
//   'left'      — постоянно СЛЕД тези 5 секунди (или веднага при foreground
//     snap/reconnect за исторически leave, виж task-а §8 "не replay-вай
//     historical leave animation"): "Напуснал", четимо червено, статично
//     (НЕ мига), сянка/сияние остава за четимост, без layout промяна.
// null (default) — normal display, никаква промяна спрямо преди тази задача.
export type LudoPlayerLeaveStatus = 'just-left' | 'left' | null

const LEAVE_STATUS_LABEL: Record<'just-left' | 'left', string> = {
  'just-left': 'Излезе от играта',
  left: 'Напуснал',
}

// Realtime emoji reaction bubble lifetime — идентично на Belot's
// EMOJI_BUBBLE_TOTAL_MS (renderCuttingSeatPanels.ts, активна игра Белот,
// проверено директно в кода) — виж task-а "Ludo emoji" §6 "Следвай Belot
// presentation-а максимално: ... lifetime". Единствен source на тази
// стойност — createLudoFlowController.ts (cleanup timer-ът) и keyframe-ът
// в ludoAnimationStyles.ts (фиксирани 5%/90% fade proceduri спрямо СЪЩАТА
// обща продължителност) я import-ват оттук.
export const LUDO_EMOJI_BUBBLE_TOTAL_MS = 4_000

export interface LudoPlayerEmojiReaction {
  emojiId: string
  elapsedMs: number
  reactionKey: string
}

// Посоката, в която bubble-ът "изниква" спрямо card-а — винаги НАВЪТРЕ към
// дъската (виж task-а §5/§6 "Не върху центъра на дъската" + §10 responsive/
// viewport overflow), не навън към viewport ръба. Изчислена в
// renderLudoGameScreen.ts спрямо реалната quadrant позиция на card-а.
export type LudoEmojiReactionDirection = 'up' | 'down' | 'left' | 'right'

// Gift icon side (виж task-а "Ludo подаръци — позициониране v2/v3", explicit
// user screenshot annotations):
//   MOBILE (2 реда карета над/под дъската) — 'left'/'right', вертикално
//     центриран спрямо ЦЯЛАТА височина на картата, extend towards
//     хоризонталния съсед в СЪЩИЯ ред ('right' за лявото каре, 'left' за
//     дясното). Потвърдено от user като финално — НЕ пипай mobile повече.
//   DESKTOP (2 колони карета от двете страни на дъската, top+bottom
//     stacked във всяка колона) — 'top'/'bottom', ХОРИЗОНТАЛНО центриран
//     спрямо ЦЯЛАТА широчина на картата, extend towards вертикалния съсед
//     в СЪЩАТА колона ('bottom' за горното каре в колоната, 'top' за
//     долното) — explicit user поправка: desktop-ът НЕ трябва да reuse-ва
//     mobile-овия left/right принцип (визуално изглеждаше идентично на
//     mobile), а вместо това бутонът стои в междинната междина между двете
//     stacked карета на СЪЩАТА колона.
// renderLudoGameScreen.ts::renderPlayerPanelSlot подава explicit тази
// стойност per call site (знае и layout-а, и quadrant-а директно) —
// НЕЗАВИСИМО от emojiDirection-а (up/down/left/right), който остава чисто
// за emoji bubble-а.
export type LudoGiftIconSide = 'left' | 'right' | 'top' | 'bottom'

// Дублирано копие (проектът НЕ споделя icon helper-и между render модули —
// established convention, виж renderCuttingSeatPanels.ts/
// renderPlayerProfilePopup.ts/renderLobbyScreen.ts за същия SVG). Идентичен
// на Belot's gift-box SVG — визуално 1:1 изискване (task-а "Ludo подаръци").
function renderLudoGiftBoxIcon(sizePx: number): string {
  return `<svg width="${sizePx}" height="${sizePx}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;flex:0 0 auto;vertical-align:-3px;" aria-hidden="true" focusable="false"><rect x="3" y="8" width="18" height="4"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/></svg>`
}

// Non-participant avatar placeholder (виж task-а "Ludo player cards —
// non-participant presentation") — заменя предишната инициал-буква ("H" от
// "Не участва") за slot-ове без реален participant. Чист кръгъл
// "забранителен" знак (кръг + диагонална черта), inline SVG, БЕЗ нов image
// asset. currentColor наследява родителския `color:#16314f` (същия navy
// тон като старата инициал-буква, за визуална консистентност с
// avatar кутията) — неутрален, не alarm-червен. viewBox 24x24 + explicit
// width/height в px (подадени от caller-а спрямо avatarSize) — мащабира се
// автоматично с avatar контейнера на desktop/mobile (same convention като
// renderLudoGiftBoxIcon по-горе).
function renderLudoNonParticipantSign(sizePx: number): string {
  return `<svg width="${sizePx}" height="${sizePx}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="display:block;" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.5"/><line x1="5.7" y1="18.3" x2="18.3" y2="5.7"/></svg>`
}

// Самостоятелен gift action бутон — outer edge badge, извън card-a
// (сравнимо с Belot's renderSeatGiftActionIcon), сега edge-centered вместо
// corner-based (виж LudoGiftIconSide doc коментара по-горе за пълния
// rationale/history). Pika.bg стил: dark/black background, gold border,
// gold SVG — 1:1 визуално с Belot/предишната версия (същите цветове/
// border/shadow/border-radius/размер), само позиционирането е сменено.
// useCompactLayout(mobile) ползва fixed literal px (established Ludo
// convention за compact layout, виж avatarSize/insetPx/... по-горе),
// desktop скалира с board-linked `scale`.
function renderLudoGiftActionIcon(
  color: LudoColor,
  side: LudoGiftIconSide,
  useCompactLayout: boolean,
  scale: number,
): string {
  const sizePx = useCompactLayout ? 30 : Math.max(18, Math.round(36 * scale))
  const iconSizePx = useCompactLayout ? 18 : Math.max(11, Math.round(22 * scale))
  // ИЗЦЯЛО ИЗВЪН картата, с explicit GAP_PX gap от ръба ѝ (6px, виж git
  // history за 3px->6px итерацията) — offsetPx = -(sizePx + GAP_PX): бутонът
  // се измества с целия си размер ПЛЮС GAP_PX извън card-а, значи
  // най-близкият му ръб седи точно GAP_PX от card edge-а, никакво
  // препокриване.
  //   'left'/'right' (mobile) — центриран по ВИСОЧИНА (top:50%), extend по
  //     хоризонталната ос.
  //   'top'/'bottom' (desktop) — центриран по ШИРОЧИНА (left:50%), extend
  //     по вертикалната ос.
  const GAP_PX = 6
  const offsetPx = -(sizePx + GAP_PX)
  const positionStyle =
    side === 'right' ? `top:50%; right:${offsetPx}px; transform:translateY(-50%);`
    : side === 'left' ? `top:50%; left:${offsetPx}px; transform:translateY(-50%);`
    : side === 'bottom' ? `bottom:${offsetPx}px; left:50%; transform:translateX(-50%);`
    : `top:${offsetPx}px; left:50%; transform:translateX(-50%);` // side === 'top'

  return `
    <div
      data-ludo-gift-icon="${color}"
      title="Изпрати подарък"
      role="button"
      style="
        position:absolute;
        ${positionStyle}
        width:${sizePx}px; height:${sizePx}px;
        border-radius:10px;
        display:flex;
        align-items:center;
        justify-content:center;
        background:linear-gradient(180deg, rgba(28,28,28,0.97) 0%, rgba(10,10,10,0.98) 100%);
        border:2px solid rgba(255,224,128,0.96);
        color:rgba(255,224,128,0.98);
        box-shadow:0 6px 14px rgba(0,0,0,0.4), 0 0 6px rgba(255,224,128,0.28);
        cursor:pointer;
        pointer-events:auto;
        z-index:9;
        transition:background 0.15s ease, border-color 0.15s ease;
      "
    >${renderLudoGiftBoxIcon(iconSizePx)}</div>
  `
}

/**
 * Празен slot за 60-секундния gift overlay (виж task-а "Ludo подаръци" §7/
 * §8) — mirror на Belot's renderSeatGiftOverlaySlot. Стои ВЪТРЕ в card-а,
 * ТОЧНО върху avatar/dice-control area-та (същите top/left/width/height
 * координати като data-ludo-dice-anchor кутията по-долу), z-index:6 над
 * avatar/dice control (и двата default z-index:auto, DOM-order painting).
 * Съдържанието се попълва императивно от createLudoFlowController.ts-овия
 * syncGiftOverlays(), затова тук винаги е рендиран празен и скрит
 * (display:none) — presentation state не живее в render-build markup-а.
 */
function renderLudoGiftOverlaySlot(color: LudoColor, insetPx: number, avatarSize: number, avatarRadius: string): string {
  return `
    <div
      data-ludo-gift-overlay="${color}"
      style="
        position:absolute;
        top:${insetPx}px; left:${insetPx}px;
        width:${avatarSize}px; height:${avatarSize}px;
        display:none;
        align-items:center;
        justify-content:center;
        border-radius:${avatarRadius};
        overflow:hidden;
        pointer-events:none;
        z-index:6;
      "
    ></div>
  `
}

// Реалната animated emoji презентация (не static preview от picker-а) —
// огледално на Belot's renderEmojiBubble (renderCuttingSeatPanels.ts):
// same бял кръгъл "bubble", same img treatment, same fade-in/hold/fade-out
// timing. Разликата е ЕДИНСТВЕНО позиционирането — тук е спрямо Ludo
// card-а (position:absolute дете на wrapper-а с position:relative в
// renderLudoPlayerPanel-овия return по-долу), не спрямо Belot-овия голям
// table stage. Размерът е derived от avatarSize (вече board-linked scale-
// нат, виж desktopPanelScale по-горе) — гарантира, че bubble-ът остава
// пропорционален на card-а на всеки viewport, вместо fixed 90px да изглежда
// огромен на силно смален mobile/тесен desktop card (виж task-а §10).
function renderLudoEmojiReactionBubble(
  reaction: LudoPlayerEmojiReaction,
  avatarSize: number,
  direction: LudoEmojiReactionDirection,
): string {
  const totalMs = LUDO_EMOJI_BUBBLE_TOTAL_MS
  const elapsed = Math.min(reaction.elapsedMs, totalMs)
  const delay = -elapsed / 1000
  // ~90/124 и ~85/90 са Belot's реални отношения (bubble diameter / avatar,
  // img size / bubble diameter) — same relative treatment, скалирано спрямо
  // ТОЗИ avatar (вече board-linked), не абсолютни px.
  const diameter = Math.max(30, Math.round(avatarSize * 0.72))
  const imgSize = Math.round(diameter * 0.94)
  const gapPx = Math.max(6, Math.round(avatarSize * 0.06))
  const placement = direction === 'right'
    ? `left:100%; top:50%; transform:translate(${gapPx}px, -50%);`
    : direction === 'left'
      ? `right:100%; top:50%; transform:translate(-${gapPx}px, -50%);`
      : direction === 'down'
        ? `top:100%; left:50%; transform:translate(-50%, ${gapPx}px);`
        : `bottom:100%; left:50%; transform:translate(-50%, -${gapPx}px);`

  return `
    <div
      data-ludo-emoji-reaction="${reaction.reactionKey}"
      style="
        position:absolute;
        ${placement}
        width:${diameter}px; height:${diameter}px;
        z-index:${LUDO_EMOJI_REACTION_Z_INDEX};
        pointer-events:none;
        animation:ludo-emoji-bubble-fade ${totalMs}ms linear both;
        animation-delay:${delay}s;
      "
    >
      <div style="
        position:relative; width:100%; height:100%;
        border-radius:50%;
        background:rgba(255,255,255,0.95);
        box-shadow:0 4px 16px rgba(0,0,0,0.22);
        display:flex; align-items:center; justify-content:center;
      ">
        <img src="${getAnimatedEmojiUrl(reaction.emojiId)}" alt="" style="width:${imgSize}px;height:${imgSize}px;object-fit:contain;">
      </div>
    </div>
  `
}

export function renderLudoPlayerPanel(
  player: LudoPlayer,
  pieces: LudoPiece[],
  isActive: boolean,
  useCompactLayout = false,
  turnElapsedMs = 0,
  diceControl: LudoPlayerPanelDiceControl | null = null,
  // Реалната countdown продължителност за ТОЗИ ход (10s roll / 15s move) —
  // подадена от orchestrator-а спрямо canonical turnPhase. Default пази
  // обратна съвместимост за евентуални call sites без нов параметър.
  turnCountdownMs = DEFAULT_TURN_COUNTDOWN_MS,
  // Разделя ДВЕ различни семантики (виж task-а "bot timer presentation" и
  // createLudoFlowController.ts::currentScreenState() коментара): дали
  // turnCountdownMs представлява РЕАЛЕН human reaction deadline (10s roll /
  // 15s move — трябва да се вижда като намаляващ countdown), или bot think
  // delay presentation-detail (~700ms LUDO_BOT_THINK_DELAY_MS — bot-ът
  // действа след толкова, но това НЕ е player-facing timeout и не трябва да
  // изглежда като бързо изтичащ timer). default true запазва старото
  // поведение за евентуални call sites без новия параметър.
  isCountdownActive = true,
  // Виж LudoPlayerLeaveStatus doc коментара по-горе.
  leaveStatus: LudoPlayerLeaveStatus = null,
  // Responsive board-linked scale (виж computeLudoDesktopPanelScale doc
  // коментара в renderLudoGameScreen.ts за пълния rationale/root cause) —
  // приложен САМО когато useCompactLayout===false (desktop). Компактният
  // mobile layout винаги игнорира тази стойност (собствен, вече установен
  // и тестван touch-optimized размер, непроменен от тази задача). 1 =
  // оригиналният fixed дизайн размер (голям desktop viewport).
  desktopPanelScale = 1,
  // Realtime emoji reaction (виж LudoPlayerEmojiReaction/renderLudoEmoji-
  // ReactionBubble doc коментарите по-горе) — null когато няма активна
  // reaction за ТОЗИ играч в момента (нормалният случай).
  emojiPresentation: { reaction: LudoPlayerEmojiReaction; direction: LudoEmojiReactionDirection } | null = null,
  // Виж LudoGiftIconSide doc коментара по-горе — null за local player-я
  // самия (не пращаш подарък на себе си) и за spectator view (виж task-а
  // §10 "spectator mode НЕ трябва да вижда gift buttons"), избрана страна за
  // всеки друг участник.
  giftIcon: LudoGiftIconSide | null = null,
  // Виж task-а "Ludo profile popup integration" — true САМО за реален,
  // друг (не-local) участник, независимо от viewMode (participant ИЛИ
  // spectator, виж createLudoFlowController.ts/renderLudoGameScreen.ts
  // gating коментарите). Прилага се ЕДИНСТВЕНО върху plain-avatar branch-а
  // по-долу — НИКОГА върху dice-control branch-а (dice click винаги си
  // остава roll action, виж task-а §6 — mutually exclusive branches, значи
  // няма нужда от допълнителен guard тук). Click handler-ът/profileId
  // resolve-ването живеят в createLudoFlowController.ts::wireEvents() (виж
  // data-ludo-avatar-clickable атрибута по-долу) — тук само presentation
  // (cursor + click target атрибут).
  isAvatarClickable = false,
): string {
  void pieces
  const hex = LUDO_COLOR_HEX[player.color]
  const initials = player.name.trim().slice(0, 1).toUpperCase()
  const scale = useCompactLayout ? 1 : desktopPanelScale
  // Readability floors (задачата explicit го позволява) — border/font
  // никога не изчезват визуално дори на MIN_SCALE (0.5) ръба.
  const scalePx = (basePx: number, minPx = 1) => Math.max(minPx, Math.round(basePx * scale))

  // Belot-овата side card е 186x234 (avatar top:8/left:8/right:8/bottom:64,
  // footer 52-64px) — тук avatar кутията е explicit width===height, за да
  // е гарантирано квадратна (Belot-овата е почти, но не точно квадратна).
  const borderWidthPx = useCompactLayout ? 2 : scalePx(2, 1)

  // insetPx е ЕДНАКЪВ gap от аватара до всичките 4 страни на рамката
  // (ляво/дясно/горе/долу-преди-footer-а) — за ДВАТА layout-а (desktop и
  // mobile compact), не само desktop. Картата ползва box-sizing:border-box,
  // а top/left/right на absolute-positioned аватар се мерят спрямо PADDING
  // BOX-а (вътре в border-а, не спрямо външния ръб) — ако cardWidth/
  // cardHeight се смятат само от avatarSize+insetPx*2 (без да се извади
  // border-а), padding box-ът излиза с border*2 (4px) по-тесен/нисък от
  // очакваното, и тези "изядени" 4px липсват само от дясната/долната страна
  // (лявата/горната са директно зададени top/left стойности, недокоснати).
  // Desktop вече беше поправен по-рано; compact (mobile) имаше СЪЩИЯ бъг
  // (6px ляво vs 2px дясно, и аватарът дори леко застъпваше footer-а
  // отдолу, защото липсваше и bottom-gap-преди-footer). Затова формулата е
  // ЕДНА обща за двата layout-а, border-ът се добавя ИЗРИЧНО обратно:
  //   paddingBoxWidth  = cardWidth  - 2*border = avatarSize + insetPx*2  ✓
  //   paddingBoxHeight = cardHeight - 2*border = avatarSize + insetPx*2 + footerHeight ✓
  // → дясно = paddingBoxWidth - insetPx - avatarSize = insetPx (= ляво)
  // → долу (преди footer-а) = insetPx (= горе), доказано алгебрично, не
  //   "на око".
  // Responsive (desktop non-compact): всички стойности по-долу минават
  // през scalePx/scale спрямо СЪЩИЯ board-linked фактор (виж
  // desktopPanelScale doc коментара по-горе и computeLudoDesktopPanelScale
  // в renderLudoGameScreen.ts) — при scale===1 (голям desktop viewport)
  // числата са ИДЕНТИЧНИ на предишния fixed дизайн (124/8/38/14/40/16/13),
  // нулева визуална промяна там. Compact (mobile) остава напълно
  // непроменен литерал, никога не минава през scale.
  const avatarSize = useCompactLayout ? 58 : scalePx(124, 62)
  const insetPx = useCompactLayout ? 6 : scalePx(8, 4)
  // Mobile name bar по-нисък от преди (30 → 24px) — по-компактно каре,
  // името остава четимо на същия font-size (footer-ът си остава
  // vertically-centered flex, не разчита на height за баланс на текста).
  const footerHeight = useCompactLayout ? 24 : scalePx(38, 22)
  const cardWidth = avatarSize + insetPx * 2 + borderWidthPx * 2
  const cardHeight = avatarSize + insetPx * 2 + footerHeight + borderWidthPx * 2
  const nameFontSize = useCompactLayout ? '11px' : `${scalePx(14, 10)}px`
  const fallbackFontSize = useCompactLayout ? '22px' : `${scalePx(40, 20)}px`
  const borderRadius = useCompactLayout ? '12px' : `${scalePx(16, 8)}px`
  const avatarRadius = useCompactLayout ? '9px' : `${scalePx(13, 6)}px`
  // Badge-ът с текстовия цвят ("ЧЕРВЕН"/"СИН"/...) е премахнат — рамката
  // сама носи идентичността вече, затова трябва да се разпознава ясно и
  // при неактивна карта, не само на активна (иначе 3 от 4 карти биха
  // изглеждали "безцветни" без badge-а). Вдигнат alpha за inactive от
  // 0x66 (40%) на 0x99 (60%).
  const borderColor = isActive ? hex : `${hex}99`
  // Border-ът е borderWidthPx (2px fixed на compact mobile; scale-нат с
  // floor 1px на desktop, виж borderWidthPx по-горе — задачата explicit
  // изисква "borders/glow визуалните размери" да следват board scale-а).
  // "По-дебела" рамка е постигната визуално чрез плътен box-shadow пръстен
  // веднага извън border-а, в СЪЩИЯ цвят и СЪЩАТА scale-ната дебелина —
  // реалният border box остава borderWidthPx, визуалната цветна лента е
  // ~2×borderWidthPx (border + solid shadow ring), без да пипа layout/
  // card-размерите (cardWidth/cardHeight формулата по-горе).
  const ringShadowPx = useCompactLayout ? 2 : borderWidthPx
  const thickenRingShadow = `0 0 0 ${ringShadowPx}px ${borderColor}`
  const glowBlurPx = useCompactLayout ? [26, 46] : [scalePx(26, 12), scalePx(46, 20)]
  const activeGlow = isActive ? `, 0 0 ${glowBlurPx[0]}px ${hex}80, 0 0 ${glowBlurPx[1]}px ${hex}45` : ''
  const depthShadowBlurPx = useCompactLayout ? (isActive ? 30 : 24) : scalePx(isActive ? 30 : 24, 10)
  const depthShadowOffsetPx = useCompactLayout ? (isActive ? 16 : 12) : scalePx(isActive ? 16 : 12, 6)
  const depthShadow = isActive
    ? `, 0 ${depthShadowOffsetPx}px ${depthShadowBlurPx}px rgba(0,0,0,0.3)`
    : `, 0 ${depthShadowOffsetPx}px ${depthShadowBlurPx}px rgba(0,0,0,0.24)`
  const shadow = `${thickenRingShadow}${activeGlow}${depthShadow}`

  // Outer wrapper (виж task-а "Ludo emoji" §5/§6 "да не бъде clipped от
  // player card") — самата card div долу пази overflow:hidden (клипва
  // avatar/footer ъглите в border-radius-а, established, недокоснато).
  // Emoji bubble-ът трябва да escape-не отвъд тази клип граница (изниква
  // ИЗВЪН card-а), затова е sibling в ТОЗИ non-clipping position:relative
  // wrapper, не child на card div-а. display:inline-block пази wrapper-а
  // shrink-to-fit (size = card-а), без да чупи desktop flex-column/mobile
  // absolute-positioned layout-а около renderPlayerPanelSlot() call sites.
  const emojiBubbleHtml = emojiPresentation
    ? renderLudoEmojiReactionBubble(emojiPresentation.reaction, avatarSize, emojiPresentation.direction)
    : ''

  return `
    <div style="position:relative; display:inline-block;">
    <div
      data-ludo-player-panel="${player.color}"
      style="
        position:relative;
        width:${cardWidth}px;
        height:${cardHeight}px;
        box-sizing:border-box;
        border-radius:${borderRadius};
        border:${borderWidthPx}px solid ${borderColor};
        background:
          radial-gradient(circle at 30% 25%, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.025) 18%, rgba(255,255,255,0.0) 40%),
          linear-gradient(180deg, rgba(34,34,34,0.97) 0%, rgba(18,18,18,0.98) 54%, rgba(8,8,8,0.99) 100%);
        box-shadow:${shadow};
        overflow:hidden;
        transition:box-shadow 200ms ease, border-color 200ms ease;
        flex-shrink:0;
      "
    >
      ${isActive && diceControl
        ? renderLudoDiceControl({
            color: player.color,
            hex,
            avatarSize,
            insetPx,
            avatarRadius,
            isRollable: diceControl.isRollable,
            shouldRotateArrows: diceControl.shouldRotateArrows,
          })
        : `
      <div
        data-ludo-dice-anchor="${player.color}"
        ${isAvatarClickable ? `data-ludo-avatar-clickable="${player.color}"` : ''}
        style="
        position:absolute;
        top:${insetPx}px; left:${insetPx}px;
        width:${avatarSize}px; height:${avatarSize}px;
        border-radius:${avatarRadius};
        background:linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(232,240,248,0.98) 100%);
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.8),
          0 10px 18px rgba(0,0,0,0.18);
        display:flex; align-items:center; justify-content:center;
        color:#16314f; font-weight:900; font-size:${fallbackFontSize};
        overflow:hidden;
        cursor:${isAvatarClickable ? 'pointer' : 'default'};
      ">
        ${player.avatarUrl
          ? `<img src="${player.avatarUrl}" alt="" style="width:100%;height:100%;object-fit:cover;">`
          // player.isBot===true е ЕДИНСТВЕНО за non-participant mock filler
          // slot-ове (виж createLobbyFlowController.ts::openLudoGameOverlay/
          // mountLudoSpectatorController — placeholder-и, никога overwrite-нати
          // от authoritative snapshot.players) — authoritative signal, НЕ
          // текстово сравнение с player.name==='Не участва'. Реален participant
          // винаги носи isBot:false тук, независимо от текущ bot-takeover
          // статус (viж botControlledColors, отделна orchestrator концепция).
          : player.isBot
            ? renderLudoNonParticipantSign(Math.round(avatarSize * 0.5))
            : initials}
      </div>
      `}

      ${renderLudoGiftOverlaySlot(player.color, insetPx, avatarSize, avatarRadius)}

      ${isActive && useCompactLayout ? (() => {
        const ringSize = avatarSize + insetPx * 2 // топ area над footer-а (58+6*2=70)
        const ringInset = 3 // център на 6px gap-а между avatar edge (6) и card padding-box edge (0)
        const ringRadius = 8
        const ringStrokeWidth = 2
        const ringPath = buildMobileCountdownRingPath(ringSize, ringInset, ringRadius)
        return `
          <svg
            data-ludo-seat-countdown-ring="${player.color}"
            width="${ringSize}" height="${ringSize}"
            viewBox="0 0 ${ringSize} ${ringSize}"
            style="position:absolute; top:0; left:0; z-index:4; pointer-events:none;"
          >
            <path
              d="${ringPath}"
              fill="none"
              stroke="#f5bb37"
              stroke-width="${ringStrokeWidth}"
              stroke-linecap="round"
              pathLength="100"
              style="
                stroke-dasharray:100;
                ${isCountdownActive ? `
                will-change:stroke-dashoffset;
                animation:ludo-seat-countdown-ring-drain ${turnCountdownMs}ms linear forwards;
                animation-delay:-${clampedTurnDelayMs(turnElapsedMs, turnCountdownMs)}ms;
                ` : `
                stroke-dashoffset:0;
                `}
              "
            ></path>
          </svg>
        `
      })() : ''}

      <div style="
        position:absolute; left:0; right:0; bottom:0; height:${footerHeight}px;
        background:rgba(10,10,10,0.94);
        border-top:1px solid ${isActive ? `${hex}99` : 'rgba(255,255,255,0.1)'};
        overflow:hidden;
      ">
        ${isActive && !useCompactLayout ? `
          <div
            data-ludo-seat-countdown-fill="${player.color}"
            style="
              position:absolute; inset:0;
              background:linear-gradient(90deg, rgba(245,187,55,0.98) 0%, rgba(255,166,0,0.98) 100%);
              box-shadow:inset 0 1px 0 rgba(255,255,255,0.22), 0 0 10px rgba(245,187,55,0.26);
              transform-origin:left center;
              ${isCountdownActive ? `
              will-change:transform;
              animation:ludo-seat-countdown-drain ${turnCountdownMs}ms linear forwards;
              animation-delay:-${clampedTurnDelayMs(turnElapsedMs, turnCountdownMs)}ms;
              ` : `
              transform:scaleX(1);
              `}
            "
          ></div>
        ` : ''}
        <div style="
          position:relative; z-index:2;
          height:100%;
          display:flex; align-items:center; justify-content:center;
          padding:0 6px;
          box-sizing:border-box;
        ">
          ${leaveStatus
            ? `<div
                data-ludo-leave-status="${player.color}"
                style="
                  font-size:${nameFontSize}; font-weight:900; color:#ff5a52;
                  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%;
                  text-shadow:0 0 ${useCompactLayout ? 6 : scalePx(6, 3)}px rgba(255,90,82,0.85), 0 0 ${useCompactLayout ? 14 : scalePx(14, 7)}px rgba(255,90,82,0.45), 0 1px 3px rgba(0,0,0,0.4);
                  ${leaveStatus === 'just-left' ? 'animation:ludo-leave-status-blink 0.9s ease-in-out infinite;' : ''}
                "
              >${LEAVE_STATUS_LABEL[leaveStatus]}</div>`
            : `<div style="
                font-size:${nameFontSize}; font-weight:900; color:#f4f8ff;
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%;
                text-shadow:0 1px 3px rgba(0,0,0,0.4);
              ">${player.name}</div>`}
        </div>
      </div>
    </div>
    ${giftIcon ? renderLudoGiftActionIcon(player.color, giftIcon, useCompactLayout, scale) : ''}
    ${emojiBubbleHtml}
    </div>
  `
}

export function ludoPlayerAriaLabel(player: LudoPlayer): string {
  return `${player.name} — ${LUDO_COLOR_LABEL[player.color]}`
}
