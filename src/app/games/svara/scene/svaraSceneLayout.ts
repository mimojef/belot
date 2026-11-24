// Свара — обща визуална сцена: оформление.
//
// ЕДИН източник на геометрията за демото И за истинската игра (изнесено от
// demo/svaraDemoScript.ts без промяна на формулите): размер на масата,
// аватари, ветрила, тесте, банка, купчинки чипове, голямо ветрило на
// обърнатите собствени карти.
//
// Местата са по визуален слот. Индексите 0..3 са в реда на демото
// (0 долу, 1 ляво, 2 горе, 3 дясно), за да остане демото непроменено; за
// 2 и 3 играчи истинската игра ползва само заетите слотове.

import type { SvaraSpriteState } from '../demo/svaraDemoMotion'

export type SvaraSeatIndex = 0 | 1 | 2 | 3
export type SvaraSceneSlot = 'bottom' | 'left' | 'top' | 'right'
/** Ред на слотовете по индекс на мястото в сцената (както в демото). */
export const SVARA_SCENE_SLOTS: readonly SvaraSceneSlot[] = ['bottom', 'left', 'top', 'right']

export type SvaraPoint = { x: number; y: number }

export type SvaraSeatLayout = {
  index: SvaraSeatIndex
  slot: SvaraSceneSlot
  avatar: SvaraPoint
  /** Единичен вектор от мястото към центъра. */
  inward: SvaraPoint
  /** Единичен вектор по „ветрилото“ на картите. */
  tangent: SvaraPoint
  /** Ротация на картите на мястото (градуси). */
  cardRotation: number
  /** Купчинката чипове на играча (основа). */
  chipStack: SvaraPoint
  /** Размерът на мястото (аватар в демото; профилното каре в истинската игра). */
  box: { w: number; h: number }
  /** Половината от размера на мястото по посоката към центъра. */
  inwardHalf: number
  /** Отстъп на информацията (баланс) от мястото — да не застъпва картите зад карето (ръце като в Белот). */
  infoGap?: number
  /** Центърът на разкритите карти върху карето (ръце като в Белот). */
  revealCenter?: SvaraPoint
  /** Баджът със залога е под купчинката (горното място при ръце като в Белот), а не встрани. */
  betBadgeBelow?: boolean
}

/** Ветрилото на картите: отместване и наклон на карта index от count (CSS px). */
export type SvaraFanOffset = { x: number; y: number; rotate: number }

/**
 * Картите като в Белот (истинската игра, телефон/портрет): размери, ветрила и
 * центрове спрямо центъра на видимото профилно каре — виж table/svaraBelotHands.ts.
 */
export type SvaraBelotHandsSpec = {
  oppCard: { w: number; h: number }
  ownCard: { w: number; h: number }
  fanCenter: Record<SvaraSceneSlot, SvaraPoint>
  fanRotation: Record<SvaraSceneSlot, number>
  oppFan: (index: number, count: number) => SvaraFanOffset
  ownFan: (index: number, count: number) => SvaraFanOffset
  revealFan: (index: number, count: number) => SvaraFanOffset
}

export type SvaraSceneLayout = {
  width: number
  height: number
  isPortrait: boolean
  avatarSize: number
  cardWidth: number
  cardHeight: number
  chipSize: number
  /** Вертикално отместване между чиповете в купчинка. */
  chipStep: number
  deck: SvaraPoint
  pot: SvaraPoint
  /** Малките купчинки в банката — по една на място (индекс на мястото). */
  potStacks: SvaraPoint[]
  /** Къде стои надписът на банката (център на надписа). */
  potLabel: SvaraPoint
  /** Надписът на банката на 1 ред („Банка: N“) или на 2 реда („Банка“ / N — телефон, ръце като в Белот). */
  potLabelLines: 1 | 2
  /** Къде се събира банката преди прибирането (основа на купчинката). */
  potGather: SvaraPoint
  /** Мащаб на картите на мястото (страничните на телефон са по-малки). */
  handScale: number[]
  /** Колко навътре от мястото е ветрилото му (в височини на карта; демото — 0.64). */
  handReach: number
  revealScale: number
  /** Допълнително повдигане на обърнатите собствени карти (0 в демото). */
  revealLift: number
  /** Винаги 4 места по индекс 0..3 (виж SVARA_SCENE_SLOTS). */
  seats: SvaraSeatLayout[]
  /** Размерът на спрайта на картата (демото: cardWidth × cardHeight). */
  cardSprite: { w: number; h: number }
  /** Мащабът на карта „на масата“ (тесте, прибиране) спрямо спрайта (демото: 1). */
  cardUnit: number
  /** Картите като в Белот (само истинската игра на телефон); null — ветрилата на демото. */
  belotHands: SvaraBelotHandsSpec | null
}

export const SVARA_SCENE_REVEAL_SCALE = 1.32
const PORTRAIT_SIDE_HAND_SCALE = 0.78

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function svaraSceneSeatIndexOf(slot: SvaraSceneSlot): SvaraSeatIndex {
  return SVARA_SCENE_SLOTS.indexOf(slot) as SvaraSeatIndex
}

/** Колко излиза пръстенът на хода извън аватара (виж ringSvg: inset:-9px). */
const TURN_RING_OUTSET = 9
/** Минимален отстъп между купчинката и пръстена/аватара. */
const SIDE_CHIP_GAP = 4
/** Височина на етикета с името (11px шрифт + отстъп); виси с 45% под аватара. */
const NAME_LABEL_HEIGHT = 17
/** Портрет (истинска игра): мащаб на обърнатите собствени карти. */
const PORTRAIT_OWN_REVEAL_SCALE = 1.6
/** Отстъп около обърнатите собствени карти (до аватара/чиповете/банката). */
const OWN_REVEAL_GAP = 6
/** Наклон на крайните обърнати карти (виж svaraOwnRevealCardState). */
const OWN_REVEAL_TILT_DEG = 7
/** Тестето: 20 карти по 0.3 px нагоре (виж svaraDeckCardState). */
const DECK_STACK_RISE = 6

export type SvaraSceneLayoutOptions = {
  /**
   * Истинската игра: купчинките на лявото И дясното място са над аватара
   * (огледално), с отстъп от пръстена на хода — никога под/върху аватара.
   * Демото не подава опцията и пази оригиналното си оформление.
   */
  mirroredSideChips?: boolean
  /**
   * Истинската игра на телефон (портрет): по-големи обърнати собствени карти
   * непосредствено над аватара; банката и тестето се подреждат над тях.
   * Хоризонталното оформление (desktop) не се променя.
   */
  ownCardsFirstOnPortrait?: boolean
  /**
   * Истинската игра: местата са профилните карета от Белот (не квадратни
   * аватари) — страничните и горното са вертикални, долното е хоризонтално;
   * `margin` е отстъпът им от ръба на сукното. Картите, чиповете и банката се
   * подреждат около реалния размер на каретата.
   */
  seatCards?: { side: { w: number; h: number }; bottom: { w: number; h: number }; margin: number }
  /**
   * Истинската игра: картите като в Белот — противниците зад каретата, собствените
   * зад долното каре, разкриването върху карето. Прилага се заедно с `seatCards`
   * (портрет — телефонните ветрила, хоризонтално — тези за desktop).
   */
  belotHands?: SvaraBelotHandsSpec
}

/** Надписът на банката на 2 реда: височина на ред и отстъп от чиповете. */
const POT_LABEL_LINE_HEIGHT = 1.15
const POT_LABEL_GAP = 4
/** Отстъп на тестето до горните карти и до банката (телефон, ръце като в Белот). */
const DECK_GAP = 3
/** Разкритите карти не стигат по-близо от това до ръба на сукното. */
const REVEAL_EDGE = 2
/** Отстъп между разкритите карти на съседни места и до етикета „Банка“. */
const REVEAL_GAP = 2

/**
 * Обхватът на ветрило от count карти (card w×h, наклон по картата + завъртане
 * на цялото ветрило) спрямо центъра на ветрилото.
 */
function fanBounds(fan: (index: number, count: number) => SvaraFanOffset, card: { w: number; h: number }, wrapperDeg: number, count: number): { l: number; t: number; r: number; b: number } {
  const wr = (wrapperDeg * Math.PI) / 180
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
  for (let i = 0; i < count; i += 1) {
    const o = fan(i, count)
    const cxl = o.x * Math.cos(wr) - o.y * Math.sin(wr)
    const cyl = o.x * Math.sin(wr) + o.y * Math.cos(wr)
    const a = ((o.rotate + wrapperDeg) * Math.PI) / 180
    const hw = (Math.abs(card.w * Math.cos(a)) + Math.abs(card.h * Math.sin(a))) / 2
    const hh = (Math.abs(card.w * Math.sin(a)) + Math.abs(card.h * Math.cos(a))) / 2
    l = Math.min(l, cxl - hw); r = Math.max(r, cxl + hw); t = Math.min(t, cyl - hh); b = Math.max(b, cyl + hh)
  }
  return { l, t, r, b }
}

/** Място над купчинката на страничните места за баджа със залога. */
const BET_BADGE_ROOM = 18
/** Половин ширина на баджа със залога (до 4 цифри). */
const BET_BADGE_HALF_WIDTH = 20
/** Най-високата купчинка чипове на място (виж MAX_STACK_CHIPS в svaraRealScene.ts). */
const MAX_STACK_CHIPS = 10
/** Ветрилото на мястото: 0.5 карта + отстъп (демото: 0.14 карта; каретата на телефон: 0.08). */
const DEFAULT_HAND_REACH = 0.64
const PORTRAIT_CARD_HAND_REACH = 0.58
/** Минимален хоризонтален отстъп между страничните ръце и горната. */
const HANDS_MIN_GAP = 2

export function computeSvaraSceneLayout(width: number, height: number, options: SvaraSceneLayoutOptions = {}): SvaraSceneLayout {
  const w = Math.max(240, width)
  const h = Math.max(240, height)
  const isPortrait = h > w * 0.9
  const avatarSize = clamp(Math.min(w, h) * 0.14, 44, 84)
  const cardWidth = clamp(Math.min(w * 0.125, h * 0.13), 38, 96)
  // Картите като в Белот — с каретата от Белот (портрет: телефон; хоризонтално: desktop).
  const belot = options.seatCards && options.belotHands ? options.belotHands : null
  // (пропорциите на картата на Белот: 284 / 195)
  const cardHeight = belot ? cardWidth * (belot.oppCard.h / belot.oppCard.w) : cardWidth * 1.4
  const chipSize = clamp(cardWidth * 0.5, 22, 46)
  const chipStep = chipSize * 0.13
  const cx = w / 2
  const cy = h / 2
  const cards = options.seatCards
  // Размер на мястото по индекс (0 долу, 1 ляво, 2 горе, 3 дясно).
  const boxes = [0, 1, 2, 3].map((i) => cards ? (i === 0 ? cards.bottom : cards.side) : { w: avatarSize, h: avatarSize })
  const inwardHalf = boxes.map((box, i) => (i === 1 || i === 3 ? box.w : box.h) / 2)
  // Разстояние от ръба на сукното до центъра на мястото.
  const edgeOf = (i: number) => cards ? cards.margin + inwardHalf[i]! : avatarSize * 0.62 + 6
  const edge = edgeOf(2)
  const bottomEdge = edgeOf(0)
  // Отстъп над/около мястото: в демото — за пръстена на хода около аватара.
  const seatOutset = cards ? 0 : TURN_RING_OUTSET

  const seatBase: Array<{ avatar: SvaraPoint; inward: SvaraPoint; cardRotation: number }> = [
    { avatar: { x: cx, y: h - bottomEdge }, inward: { x: 0, y: -1 }, cardRotation: 0 },
    { avatar: { x: edgeOf(1), y: cy }, inward: { x: 1, y: 0 }, cardRotation: 90 },
    { avatar: { x: cx, y: edge }, inward: { x: 0, y: 1 }, cardRotation: 180 },
    { avatar: { x: w - edgeOf(3), y: cy }, inward: { x: -1, y: 0 }, cardRotation: -90 },
  ]

  const gx = chipSize * 0.66
  const gy = chipSize * 0.4
  // Горе/долу: основата на купчинката е малко под центъра на аватара (както в
  // демото), но в истинската игра никога толкова ниско, че чипът да опре
  // етикета с името (той виси под аватара и може да е по-широк от него).
  const nameTop = cards ? inwardHalf[0]! : avatarSize * 0.5 - NAME_LABEL_HEIGHT * 0.55
  const rowDrop = options.mirroredSideChips ? Math.min(chipSize * 0.2, nameTop - SIDE_CHIP_GAP - chipSize * 0.5) : chipSize * 0.2

  // Портрет: тестето и банката са в централна колона (страничните ръце са
  // по-малки и не навлизат в нея). Хоризонтално: банката е над центъра,
  // за да не я застъпват обърнатите карти на играча.
  // Хоризонтално: средата на пролуката между долния ръб на горната ръка и
  // горния ръб на обърнатите карти.
  // Портрет с каретата от Белот: горната ръка е с мащаба на страничните (иначе
  // ветрилото ѝ опира страничните ръце, които са по-навътре заради широките карета).
  // Хоризонтално — същото, когато между горната ръка и обърнатите карти не остава
  // място за банката (ниско сукно на таблет/телефон в landscape).
  const middleRoom = h - bottomEdge - inwardHalf[0]! - cardHeight * SVARA_SCENE_REVEAL_SCALE * 1.1 - (edge + inwardHalf[2]! + cardHeight * (DEFAULT_HAND_REACH + 0.5))
  const compactHands = !!cards && (isPortrait || middleRoom < chipSize * 3 + 30)
  const topHandScale = compactHands ? PORTRAIT_SIDE_HAND_SCALE : 1
  // …и ветрилата са съвсем близо до каретата (както в Белот), за да остане място в средата.
  const handReach = compactHands ? PORTRAIT_CARD_HAND_REACH : DEFAULT_HAND_REACH
  // (1.14 = 0.64 + 0.5 — същият израз като в демото, без закръгляне)
  const topHandBottom = edge + inwardHalf[2]! + cardHeight * topHandScale * (compactHands ? handReach + 0.5 : 1.14)
  const revealTop = h - bottomEdge - inwardHalf[0]! - cardHeight * SVARA_SCENE_REVEAL_SCALE * 1.1
  const midY = (topHandBottom + revealTop) / 2
  let deck = isPortrait ? { x: cx, y: cy - cardHeight * 0.7 } : { x: cx - Math.max(cardWidth * 1.9, w * 0.17), y: midY }
  let pot = isPortrait ? { x: cx, y: cy + cardHeight * 0.45 } : { x: cx + cardWidth * 0.5, y: midY }
  let revealScale = SVARA_SCENE_REVEAL_SCALE
  let revealLift = 0
  let bottomChipX: number | null = null
  // Отстъп между страничното каре и купчинката над него (картите се подават над карето).
  let mirroredChipClearance = 0
  // Надписът на банката (телефон, ръце като в Белот: на 2 реда, по-близо до центъра).
  let potLabelPoint: SvaraPoint | null = null
  let potLabelLines: 1 | 2 = 1
  // Картите като в Белот: допълнителните отстъпи на информацията и центровете на разкриването.
  const infoGaps: Array<number | undefined> = [undefined, undefined, undefined, undefined]
  const revealCenters: Array<SvaraPoint | undefined> = [undefined, undefined, undefined, undefined]
  let topChipSide: number | null = null
  if (belot && cards && !isPortrait) {
    // ── Desktop, ръце като в Белот ─────────────────────────────────────────
    // Каретата са на местата си; противниците — с картите зад каретата, при
    // сравняване — върху него; собствените — зад долното каре. Тестето и
    // банката са в средата между горните и собствените карти (както досега).
    const side = cards.side, bottom = cards.bottom
    const topY = edge
    const bottomY = h - bottomEdge
    const own = fanBounds(belot.ownFan, belot.ownCard, belot.fanRotation.bottom, 3)
    const ownTop = bottomY + belot.fanCenter.bottom.y + own.t
    const ownHalfWidth = Math.max(-own.l, own.r)
    const topFan = fanBounds(belot.oppFan, belot.oppCard, belot.fanRotation.top, 3)
    const topFanBottom = topY + belot.fanCenter.top.y + topFan.b
    const topFanHalfWidth = Math.max(-topFan.l, topFan.r)
    const sideFan = fanBounds(belot.oppFan, belot.oppCard, belot.fanRotation.left, 3)
    const sidePeekAbove = Math.max(0, -(belot.fanCenter.left.y + sideFan.t) - side.h / 2)
    const sidePeekBelow = Math.max(0, belot.fanCenter.left.y + sideFan.b - side.h / 2)
    const reveal = fanBounds(belot.revealFan, belot.oppCard, 0, 3)
    const revealHalfWidth = Math.max(-reveal.l, reveal.r)
    const revealHeight = reveal.b - reveal.t
    const revealAbove = Math.max(0, -reveal.t - side.h / 2)
    const revealBelow = Math.max(0, reveal.b - side.h / 2)
    const topRevealTop = Math.max(REVEAL_EDGE, topY + reveal.t)
    revealCenters[2] = { x: cx, y: topRevealTop - reveal.t }
    const topRevealBottom = topRevealTop + revealHeight
    // Страничните: разкритите карти върху карето, в сукното (по ширина и височина).
    const sideX = edgeOf(1), sideY = seatBase[1]!.avatar.y
    const sideRevealLeft = Math.max(REVEAL_EDGE, sideX + reveal.l)
    const sideRevealY = Math.min(h - REVEAL_EDGE - reveal.b, Math.max(REVEAL_EDGE - reveal.t, sideY))
    revealCenters[1] = { x: sideRevealLeft - reveal.l, y: sideRevealY }
    revealCenters[3] = { x: w - (sideRevealLeft - reveal.l), y: sideRevealY }
    // Тестето и банката: средата между горните карти (скрити/разкрити) и собствените.
    const midY = (Math.max(topFanBottom, topRevealBottom) + ownTop) / 2
    deck = { x: deck.x, y: midY }
    pot = { x: pot.x, y: midY }
    // Чиповете и информацията — извън картите, които се подават иззад каретата.
    bottomChipX = cx - Math.max(bottom.w / 2, ownHalfWidth) - SIDE_CHIP_GAP - chipSize * 0.5
    topChipSide = Math.max(side.w / 2, topFanHalfWidth, revealHalfWidth) + SIDE_CHIP_GAP + chipSize * 0.5
    infoGaps[0] = Math.max(10, ownHalfWidth - bottom.w / 2 + 6)
    infoGaps[2] = Math.max(10, Math.max(topFanHalfWidth, revealHalfWidth) - side.w / 2 + 6)
    infoGaps[1] = infoGaps[3] = Math.max(6, sidePeekBelow + 4, revealBelow + 4)
    revealScale = belot.ownCard.w / belot.oppCard.w
    revealLift = 0
    mirroredChipClearance = Math.max(sidePeekAbove, revealAbove)
  } else if (belot && cards) {
    // ── Телефон, ръце като в Белот ─────────────────────────────────────────
    // Противниците: картите са зад каретата (подават се малко); при сравняване
    // излизат ВЪРХУ карето. Собствените: зад долното каре, горната им част се
    // вижда над него. Каретата остават на ръбовете; банката е над собствените
    // карти, страничните места — между горното каре и банката.
    const labelHeight = Math.max(12, chipSize * 0.5) * 1.25 + 10
    const labelHalfWidth = (Math.max(12, chipSize * 0.5) * 0.62 * 11 + 22) / 2
    const side = cards.side, bottom = cards.bottom
    const topY = edge
    const bottomY = h - bottomEdge
    const own = fanBounds(belot.ownFan, belot.ownCard, belot.fanRotation.bottom, 3)
    const ownTop = bottomY + belot.fanCenter.bottom.y + own.t
    const ownHalfWidth = Math.max(-own.l, own.r)
    const topFan = fanBounds(belot.oppFan, belot.oppCard, belot.fanRotation.top, 3)
    const topFanBottom = topY + belot.fanCenter.top.y + topFan.b
    const topFanHalfWidth = Math.max(-topFan.l, topFan.r)
    const sideFan = fanBounds(belot.oppFan, belot.oppCard, belot.fanRotation.left, 3)
    const sidePeekAbove = Math.max(0, -(belot.fanCenter.left.y + sideFan.t) - side.h / 2)
    const sidePeekBelow = Math.max(0, belot.fanCenter.left.y + sideFan.b - side.h / 2)
    const reveal = fanBounds(belot.revealFan, belot.oppCard, 0, 3)
    const revealHalfWidth = Math.max(-reveal.l, reveal.r)
    const revealHeight = reveal.b - reveal.t
    const revealAbove = Math.max(0, -reveal.t - side.h / 2)
    const revealBelow = Math.max(0, reveal.b - side.h / 2)
    // Банката: етикетът е непосредствено над видимите собствени карти.
    const labelY = ownTop - OWN_REVEAL_GAP - labelHeight / 2
    pot = { x: cx, y: labelY - (gy + chipSize * 0.5 + 14) }
    const potTop = pot.y - gy - 4 * chipStep - chipSize * 0.5
    // Разкритите карти на горното място: върху карето, в сукното.
    const topRevealTop = Math.max(REVEAL_EDGE, topY + reveal.t)
    revealCenters[2] = { x: cx, y: topRevealTop - reveal.t }
    const topRevealBottom = topRevealTop + revealHeight
    // Страничните места: купчинката (с баджа) над картите им в сукното; разкритите
    // им карти — под разкритите горни и над етикета „Банка“ (там, където се засичат по ширина).
    const sideX = edgeOf(1)
    const sideRevealLeft = Math.max(REVEAL_EDGE, sideX + reveal.l)
    const sideRevealRight = sideRevealLeft + (reveal.r - reveal.l)
    const minFromChips = cards.margin + BET_BADGE_ROOM + chipSize + (MAX_STACK_CHIPS - 1) * chipStep + SIDE_CHIP_GAP + Math.max(sidePeekAbove, revealAbove) + side.h / 2
    const minFromTopReveal = sideRevealRight > cx - revealHalfWidth ? topRevealBottom + REVEAL_GAP - reveal.t : -Infinity
    const maxFromLabel = sideRevealRight > cx - labelHalfWidth ? labelY - labelHeight / 2 - REVEAL_GAP - reveal.b : Infinity
    const low = Math.max(minFromChips, minFromTopReveal)
    // Ако няма място и за двете, предимство има етикетът „Банка“ (разкритите карти
    // на горното и страничните места се допират само в ъглите).
    const sideY = Math.min(Math.max(low, Math.min(cy, maxFromLabel)), Math.max(minFromChips, maxFromLabel))
    seatBase[1]!.avatar.y = sideY
    seatBase[3]!.avatar.y = sideY
    revealCenters[1] = { x: sideRevealLeft - reveal.l, y: sideY }
    revealCenters[3] = { x: w - (sideRevealLeft - reveal.l), y: sideY }
    void potTop
    // Чиповете и информацията — извън картите, които се подават иззад каретата.
    bottomChipX = cx - Math.max(bottom.w / 2, ownHalfWidth) - SIDE_CHIP_GAP - chipSize * 0.5
    // (баджът със залога е под купчинката — по-широк от чипа)
    topChipSide = Math.max(side.w / 2, topFanHalfWidth, revealHalfWidth) + SIDE_CHIP_GAP + Math.max(chipSize * 0.5, BET_BADGE_HALF_WIDTH)
    infoGaps[0] = Math.max(10, ownHalfWidth - bottom.w / 2 + 6)
    infoGaps[2] = Math.max(10, Math.max(topFanHalfWidth, revealHalfWidth) - side.w / 2 + 6)
    infoGaps[1] = infoGaps[3] = Math.max(6, sidePeekBelow + 4, revealBelow + 4)
    revealScale = belot.ownCard.w / belot.oppCard.w
    revealLift = 0
    mirroredChipClearance = Math.max(sidePeekAbove, revealAbove)
    // Банката (чиповете + надписът на 2 реда) — един блок в средната колона,
    // центриран по височина между лявото и дясното място. Каретата и картите
    // по-горе не зависят от него. Над блока остава място за тестето (раздаване),
    // под него — собствените карти.
    const potFont = Math.max(12, chipSize * 0.5)
    const labelTwoLineHeight = potFont * POT_LABEL_LINE_HEIGHT * 2 + 10
    const chipsAbove = gy + 4 * chipStep + chipSize * 0.5
    const labelOffset = gy + chipSize * 0.5 + POT_LABEL_GAP + labelTwoLineHeight / 2
    const blockTop = -chipsAbove
    const blockBottom = labelOffset + labelTwoLineHeight / 2
    const blockHalf = (blockBottom - blockTop) / 2
    const blockMid = (blockTop + blockBottom) / 2
    const deckHeight = cardHeight + DECK_STACK_RISE
    const minCenter = topFanBottom + DECK_GAP + deckHeight + DECK_GAP + blockHalf
    const maxCenter = ownTop - OWN_REVEAL_GAP - blockHalf
    const blockCenter = Math.min(maxCenter, Math.max(minCenter, sideY))
    pot = { x: cx, y: blockCenter - blockMid }
    potLabelPoint = { x: cx, y: pot.y + labelOffset }
    potLabelLines = 2
    // (тестето се вижда само при раздаване — разкритите карти на горното място — само при сравняване)
    deck = { x: cx, y: (topFanBottom + blockCenter - blockHalf) / 2 + DECK_STACK_RISE / 2 }
  } else if (isPortrait && options.ownCardsFirstOnPortrait) {
    // Истинската игра на телефон: приоритет СОБСТВЕНИ КАРТИ → банка → аватари
    // → чипове. Обърнатите карти са по-големи и стоят непосредствено над
    // аватара (купчинката на долното място е встрани от тях); банката с
    // етикета е над тях, страничните места — над етикета.
    const avatarY = h - bottomEdge
    const tilt = (OWN_REVEAL_TILT_DEG * Math.PI) / 180
    const fanTilt = (8 * Math.PI) / 180 // виж svaraSeatFanState: offset * 8
    const labelHeight = Math.max(12, chipSize * 0.5) * 1.25 + 10
    // Над пръстена на хода (купчинката на долното място е изнесена встрани от картите).
    const fanFloor = avatarY - inwardHalf[0]! - seatOutset - 3
    // Страничните ръце (по-малки на телефон) — полувисочина на ветрилото им.
    const sideHalf = cardWidth * PORTRAIT_SIDE_HAND_SCALE * 0.52
      + (cardWidth * PORTRAIT_SIDE_HAND_SCALE / 2) * Math.cos(fanTilt) + (cardHeight * PORTRAIT_SIDE_HAND_SCALE / 2) * Math.sin(fanTilt)
    let sideLowest = topHandBottom + sideHalf + OWN_REVEAL_GAP
    if (cards) {
      // Каретата: купчинката (с баджа на залога) над страничното каре да е в сукното.
      const minSideY = cards.margin + BET_BADGE_ROOM + chipSize + (MAX_STACK_CHIPS - 1) * chipStep + SIDE_CHIP_GAP + cards.side.h / 2
      // Ако страничните ръце са встрани от горната (не се засичат по ширина),
      // могат да са и на нейната височина.
      const sideHandScale = PORTRAIT_SIDE_HAND_SCALE
      const sideHandInner = edgeOf(1) + inwardHalf[1]! + cardHeight * sideHandScale * handReach
        + (cardHeight * sideHandScale / 2) * Math.cos(fanTilt) + (cardWidth * sideHandScale / 2) * Math.sin(fanTilt)
      const topHandOuter = cx - (cardWidth * topHandScale * 0.52 + (cardWidth * topHandScale / 2) * Math.cos(fanTilt) + (cardHeight * topHandScale / 2) * Math.sin(fanTilt))
      sideLowest = sideHandInner + HANDS_MIN_GAP <= topHandOuter ? minSideY : Math.max(minSideY, sideLowest)
    }
    const plan = (scale: number) => {
      const revealH = cardHeight * scale
      const revealW = cardWidth * scale
      // Същите формули като svaraOwnRevealCardState (средна карта + наклонените крайни).
      const midCenter = avatarY - inwardHalf[0]! - revealH * 0.6
      const lowest = midCenter + cardHeight * 0.06 + (revealH / 2) * Math.cos(tilt) + (revealW / 2) * Math.sin(tilt)
      const lift = Math.max(0, lowest - fanFloor)
      const fanTop = midCenter - lift - revealH / 2 - 2
      const fanHalfWidth = revealW * 0.6 + (revealW / 2) * Math.cos(tilt) + (revealH / 2) * Math.sin(tilt)
      const labelY = fanTop - OWN_REVEAL_GAP - labelHeight / 2
      // Страничните места: над етикета „Банка“ (иначе ръцете им опират в него).
      const sideY = Math.min(cy, labelY - labelHeight / 2 - OWN_REVEAL_GAP - sideHalf)
      return { scale, lift, fanTop, fanHalfWidth, labelY, sideY }
    }
    // Най-големият мащаб (до PORTRAIT_OWN_REVEAL_SCALE), при който страничните
    // ръце не опират горната; иначе мащабът на демото.
    let chosen = plan(SVARA_SCENE_REVEAL_SCALE)
    for (let scale = PORTRAIT_OWN_REVEAL_SCALE; scale > SVARA_SCENE_REVEAL_SCALE; scale -= 0.04) {
      const candidate = plan(scale)
      if (candidate.sideY >= sideLowest) { chosen = candidate; break }
    }
    revealScale = chosen.scale
    revealLift = chosen.lift
    pot = { x: cx, y: chosen.labelY - (gy + chipSize * 0.5 + 14) }
    // Тестето се вижда само при раздаване, когато обърнатите карти ги няма:
    // стои под етикета, в зоната на бъдещото ветрило.
    deck = { x: cx, y: chosen.labelY + labelHeight / 2 + OWN_REVEAL_GAP + DECK_STACK_RISE + cardHeight / 2 }
    const sideY = Math.max(chosen.sideY, cards ? sideLowest : edge + avatarSize * 1.5)
    seatBase[1]!.avatar.y = sideY
    seatBase[3]!.avatar.y = sideY
    const bottomSide = cards ? boxes[0]!.w / 2 + SIDE_CHIP_GAP + chipSize * 0.5 : avatarSize * 0.98
    bottomChipX = Math.min(cx - bottomSide, cx - chosen.fanHalfWidth - chipSize * 0.5 - SIDE_CHIP_GAP)
  }
  if (cards && !isPortrait && !belot) {
    // Хоризонтално с каретата: купчинката на долното място е и извън
    // обърнатите собствени карти (не само извън широкото долно каре).
    const tilt = (OWN_REVEAL_TILT_DEG * Math.PI) / 180
    const revealW = cardWidth * revealScale, revealH = cardHeight * revealScale
    const fanHalfWidth = revealW * 0.6 + (revealW / 2) * Math.cos(tilt) + (revealH / 2) * Math.sin(tilt)
    bottomChipX = Math.min(cx - (boxes[0]!.w / 2 + SIDE_CHIP_GAP + chipSize * 0.5), cx - fanHalfWidth - chipSize * 0.5 - SIDE_CHIP_GAP)
  }
  // Купчинките в банката: по една за всяко място (seat 0..3).
  const potStacks = [
    { x: pot.x + gx, y: pot.y + gy },
    { x: pot.x - gx, y: pot.y + gy },
    { x: pot.x - gx, y: pot.y - gy },
    { x: pot.x + gx, y: pot.y - gy },
  ]

  return {
    width: w,
    height: h,
    isPortrait,
    avatarSize,
    cardWidth,
    cardHeight,
    chipSize,
    chipStep,
    deck,
    pot,
    potStacks,
    potLabel: potLabelPoint ?? (isPortrait ? { x: pot.x, y: pot.y + gy + chipSize * 0.5 + 14 } : { x: pot.x + chipSize * 1.55 + 62, y: pot.y }),
    potLabelLines,
    potGather: isPortrait ? { x: pot.x, y: pot.y + chipSize * 0.35 } : { x: pot.x, y: pot.y + chipSize * 0.2 },
    handScale: [1, isPortrait ? PORTRAIT_SIDE_HAND_SCALE : 1, topHandScale, isPortrait ? PORTRAIT_SIDE_HAND_SCALE : 1],
    handReach,
    revealScale,
    revealLift,
    seats: seatBase.map((seat, index) => {
      const tangent = { x: -seat.inward.y, y: seat.inward.x }
      const box = boxes[index]!
      // Купчинката встрани от мястото (горе/долу): в демото — до аватара; с каретата — до ръба на карето.
      const side = index === 2 && topChipSide !== null ? topChipSide : cards ? box.w / 2 + SIDE_CHIP_GAP + chipSize * 0.5 : avatarSize * 0.98
      const isSideSeat = seat.inward.y === 0
      const chipStack = options.mirroredSideChips && isSideSeat
        ? { x: seat.avatar.x, y: seat.avatar.y - (box.h * 0.5 + seatOutset + mirroredChipClearance + SIDE_CHIP_GAP + chipSize * 0.5) }
        : { x: index === 0 && bottomChipX !== null ? bottomChipX : seat.avatar.x - tangent.x * side, y: seat.avatar.y - tangent.y * side + rowDrop }
      return {
        index: index as SvaraSeatIndex,
        slot: SVARA_SCENE_SLOTS[index]!,
        avatar: seat.avatar,
        inward: seat.inward,
        tangent,
        cardRotation: seat.cardRotation,
        chipStack,
        box,
        inwardHalf: inwardHalf[index]!,
        ...(infoGaps[index] !== undefined ? { infoGap: infoGaps[index] } : {}),
        ...(revealCenters[index] ? { revealCenter: revealCenters[index] } : {}),
        // Горното място при ръце като в Белот: встрани от купчинката е баджът на страничното място.
        ...(belot && isPortrait && index === 2 ? { betBadgeBelow: true } : {}),
      }
    }),
    // Белот: спрайтът е с реалния размер на картата на противника (иначе увеличената
    // карта е размазана); картите „на масата“ (тесте, прибиране) са с мащаб cardUnit.
    cardSprite: belot ? { w: belot.oppCard.w, h: belot.oppCard.h } : { w: cardWidth, h: cardHeight },
    cardUnit: belot ? cardWidth / belot.oppCard.w : 1,
    belotHands: belot,
  }
}

// ── Състояния на спрайтовете (формулите на демото) ──────────────────────────

/** Карта от тестето на позиция i (0 = най-долна). */
export function svaraDeckCardState(layout: SvaraSceneLayout, i: number): SvaraSpriteState {
  return { x: layout.deck.x + (i % 3) * 0.25, y: layout.deck.y - i * 0.3, rotation: -4 + (i % 5) * 0.3, scale: layout.cardUnit, alpha: 1, z: i, faceUp: false }
}

/**
 * Картите като в Белот: z под слоя с профилните карета (отрицателен маркер —
 * рендерът ги поставя под каретата; всичко останало е над тях).
 */
export const SVARA_BEHIND_SEAT_Z = -40
function belotFanCardState(layout: SvaraSceneLayout, seat: SvaraSeatLayout, slot: number, count: number, faceUp: boolean): SvaraSpriteState {
  const belot = layout.belotHands!
  const own = seat.index === 0
  const card = own ? belot.ownCard : belot.oppCard
  const o = (own ? belot.ownFan : belot.oppFan)(slot, count)
  const deg = belot.fanRotation[seat.slot]
  const r = (deg * Math.PI) / 180
  const center = belot.fanCenter[seat.slot]
  return {
    x: seat.avatar.x + center.x + o.x * Math.cos(r) - o.y * Math.sin(r),
    y: seat.avatar.y + center.y + o.x * Math.sin(r) + o.y * Math.cos(r),
    rotation: o.rotate + deg,
    scale: card.w / layout.cardSprite.w,
    alpha: 1,
    z: SVARA_BEHIND_SEAT_Z + seat.index * 4 + slot,
    faceUp,
  }
}

/** Картите като в Белот: разкритите карти на противник — изправени, върху карето му. */
export function svaraBelotRevealCardState(layout: SvaraSceneLayout, seat: SvaraSeatLayout, slot: number, z: number): SvaraSpriteState {
  const belot = layout.belotHands!
  const o = belot.revealFan(slot, 3)
  const center = seat.revealCenter ?? seat.avatar
  return { x: center.x + o.x, y: center.y + o.y, rotation: o.rotate, scale: belot.oppCard.w / layout.cardSprite.w, alpha: 1, z, faceUp: true }
}

/** Позиция на карта slot в ветрило от count карти на мястото. */
export function svaraSeatFanState(layout: SvaraSceneLayout, seat: SvaraSeatLayout, slot: number, count: number, z: number): SvaraSpriteState {
  if (layout.belotHands) return belotFanCardState(layout, seat, slot, count, false)
  const offset = slot - (count - 1) / 2
  const scale = layout.handScale[seat.index] ?? 1
  const reach = seat.inwardHalf + layout.cardHeight * scale * layout.handReach
  const spread = layout.cardWidth * scale * 0.52
  const tuck = Math.abs(offset) * layout.cardHeight * scale * 0.03
  return {
    x: seat.avatar.x + seat.inward.x * (reach - tuck) + seat.tangent.x * offset * spread,
    y: seat.avatar.y + seat.inward.y * (reach - tuck) + seat.tangent.y * offset * spread,
    rotation: seat.cardRotation + offset * 8,
    scale,
    alpha: 1,
    z,
    faceUp: false,
  }
}

/** Голямото ветрило на обърнатите собствени карти (долното място). */
export function svaraOwnRevealCardState(layout: SvaraSceneLayout, slot: number, z: number): SvaraSpriteState {
  // Картите като в Белот: обръщат се на място — зад долното каре, горната им част се вижда.
  if (layout.belotHands) return belotFanCardState(layout, layout.seats[0]!, slot, 3, true)
  const seat = layout.seats[0]!
  const offset = slot - 1
  const scale = layout.revealScale
  const reach = seat.inwardHalf + layout.cardHeight * scale * 0.6
  return {
    x: seat.avatar.x + offset * layout.cardWidth * scale * 0.6,
    y: seat.avatar.y - reach - layout.revealLift + Math.abs(offset) * layout.cardHeight * 0.06,
    rotation: offset * OWN_REVEAL_TILT_DEG,
    scale,
    alpha: 1,
    z,
    faceUp: true,
  }
}

export function svaraChipOnStack(point: SvaraPoint, level: number, layout: SvaraSceneLayout, z: number, rotation: number): SvaraSpriteState {
  return { x: point.x, y: point.y - level * layout.chipStep, rotation, scale: 1, alpha: 1, z, faceUp: false }
}
