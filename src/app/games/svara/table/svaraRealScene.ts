// Свара — адаптер между авторитетните сървърни snapshot-и и ОБЩАТА визуална
// сцена на демото (../scene/).
//
//   сървърни snapshot-и/срокове → [проектор + детектор + планировчик] → сцена
//
// • Проектор: от snapshot — крайното визуално състояние (места, карти, лица,
//   купчинки чипове, банка, тесте). Ползва се при baseline/refresh/reconnect,
//   преоразмеряване и при изключени анимации.
// • Детектор: разлика спрямо предишния snapshot → визуални събития
//   (раздаване, анте, залог, „Погледни“, отказ, сравняване, „СВАРА!“,
//   стъпка на изплащане, край на раздаването). Всяко събитие има ключ
//   (roundId/стъпка) и се изпълнява най-много веднъж.
// • Планировчик: събитие → движения от хореографията на демото, със
//   старт, изчислен от сървърния срок (превъртане при късно откриване).
//
// Сцената никога не определя игровото състояние: тя само следва snapshot-а.
// Числата (баланси, залози, банки) идват винаги от сървъра; чиповете са
// само визуално представяне без номинали.

import type { SvaraMatchSnapshotMessage, SvaraMatchTimingMessage, SvaraPublicTable } from '../../../network/createGameServerClient'
import { stateToSampled, type SvaraChipColor, type SvaraSpriteDef, type SvaraSpriteState } from '../demo/svaraDemoMotion'
import {
  resolveSvaraMoves, svaraBetChipMove, svaraCollectCardMove, svaraDealCardMove, svaraFadeMove, svaraFlipInPlaceMove, svaraGatherChipMove,
  svaraOwnRevealMove, svaraRespreadMove, svaraSvarkaHopMove, svaraTransferChipMove, svaraTransferStartMs, SVARA_SCENE_TIMING, type SvaraMoveInput,
} from '../scene/svaraSceneChoreography'
import { createSvaraSceneDomRenderer } from '../scene/svaraSceneDomRenderer'
import {
  computeSvaraSceneLayout, svaraBelotRevealCardState, svaraChipOnStack, svaraDeckCardState, svaraOwnRevealCardState, svaraSceneSeatIndexOf, svaraSeatFanState,
  type SvaraSceneLayout,
} from '../scene/svaraSceneLayout'
import { createSvaraSceneShell, svaraSceneStageZ } from '../scene/svaraSceneShell'
import { svaraBelotHandsSpec } from './svaraBelotHands'
import { renderSvaraBelotSeatCardHtml, svaraBelotCardScale, svaraBelotCardSize, SVARA_BELOT_CARD_EDGE_MARGIN_PX } from './svaraBelotSeatCard'
import { SVARA_DEADLINE_TOTAL_MS } from './svaraCountdown'
import { playGameSound } from '../../../audio/gameSoundSettings'
import { getSvaraVisualSlot } from './svaraSeatLayout'
import { svaraCardCodeToFaceSrc } from './svaraTableAssets'
import { svaraDealingAnimationMs } from './svaraTableAnimation'
import { SVARA_PAYOUT_STEP_MS, SVARA_SHOWDOWN_MS, type SvaraResultVisualState } from './svaraResultAnimation'
import { SVARA_ACTION_PANEL_HEIGHT_DESKTOP_PX, SVARA_ACTION_PANEL_HEIGHT_PHONE_PX, type SvaraSceneSeatHud } from './renderSvaraActiveTable'

// ── Одобрени времена (сцена) ────────────────────────────────────────────────
/** Анте — преди раздаването (= сървърния прозорец „Вход“). */
export const SVARA_REAL_ANTE_MS = 800
/** Целият полет на картите до кацането на последната: 2/3/4 играчи → 1250/1875/2500 ms. */
export function svaraRealDealDurationMs(participants: number): number {
  return 625 * Math.max(2, Math.min(4, participants))
}
/** Одобрено изплащане на стъпка; докато сървърът дава по-кратък прозорец, хореографията се сгъстява в него. */
export const SVARA_REAL_PAYOUT_STEP_TARGET_MS = 1800

const DECK_SPRITES = 20
// Звукът на раздаването — същият файл и сила като в демото (svaraDemoScript.ts).
const DEAL_SOUND_SRC = '/audio/card-sfx/card-move.mp3'
const DEAL_SOUND_VOLUME = 0.35
/** Две карти по-близо от това не звучат двойно (без натрупване/усилване). */
const DEAL_SOUND_MIN_GAP_MS = 90
/** Закъсняла карта (таймерът е изпълнен късно) все още звучи, ако е излетяла преди толкова. */
const DEAL_SOUND_LATE_MS = 40
const CHIP_COLORS: SvaraChipColor[] = ['red', 'blue', 'green']
const MAX_STACK_CHIPS = 10
/** Истинската маса: огледални купчинки отляво/отдясно (над аватара). */
const REAL_LAYOUT_OPTIONS = { mirroredSideChips: true, ownCardsFirstOnPortrait: true } as const
/** Последното собствено обръщане приключва: 2 стъпки + полетът (виж svaraOwnRevealMove). */
const OWN_REVEAL_DONE_MS = 2 * SVARA_SCENE_TIMING.revealStaggerMs + SVARA_SCENE_TIMING.revealFlightMs
/** Показ на бройките: ~0.2 s поява, ~0.65 s задържане, ~0.3 s избледняване (≈1 s видимо). */
const OWN_POINTS_SHOW_MS = 1350
/** Сравняване: стъпка между ръцете при обръщането. */
const SHOWDOWN_HAND_STAGGER_MS = 120
/** Значките при сравняване: поява / изчезване при прибирането. */
const COMPARE_BADGE_IN_MS = 320
const COMPARE_BADGE_OUT_MS = 200
/** Място под сукното за постоянния панел с бутоните (телефон: 2 реда; desktop: 1 ред) + отстъп. */
const PHONE_ACTION_BAR_RESERVE_PX = SVARA_ACTION_PANEL_HEIGHT_PHONE_PX + 4
const DESKTOP_ACTION_BAR_RESERVE_PX = SVARA_ACTION_PANEL_HEIGHT_DESKTOP_PX + 8
/** Отстъп между ръба на купчинката (при максимална височина) и баджа на залога. */
const BET_BADGE_GAP_PX = 5

export type SvaraRealSceneInput = {
  snapshot: SvaraMatchSnapshotMessage
  timing: SvaraMatchTimingMessage | null
  serverNow: number
  localProfileId: string
  /** Игровите анимации (истинската игра винаги подава true; prefers-reduced-motion НЕ ги изключва). */
  animations: boolean
  table: SvaraPublicTable
  resultVisual: SvaraResultVisualState
  seatHuds: SvaraSceneSeatHud[]
  statusHtml: string
  potTotal: number
}

export type SvaraRealScene = {
  update(host: HTMLElement, input: SvaraRealSceneInput): void
  onBets(entries: Array<{ seatIndex: number; added: number }>): void
  onLook(): void
  reset(): void
  destroy(): void
  debug(): { sprites: number; animations: number; pot: number; deck: boolean }
}

type CardHand = { key: string; ids: string[]; faces: (string | null)[]; revealed: boolean }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const sameState = (a: SvaraSpriteState | undefined, b: SvaraSpriteState) => !!a && a.x === b.x && a.y === b.y && a.rotation === b.rotation && a.alpha === b.alpha && a.scale === b.scale && a.faceUp === b.faceUp

/**
 * Кои лица на карти сцената има право да покаже (по playerId) — САМО каквото
 * сървърът е изпратил на този играч: собствените карти след „Погледни“;
 * при сравняване — само сравняваните, неотказали се участници; при „Покажи“ —
 * само картите на победителя. Всичко останало е гръб.
 */
export function svaraSceneVisibleFaces(snapshot: SvaraMatchSnapshotMessage | null, localProfileId: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!snapshot) return out
  const round = snapshot.round
  const faces = (codes: readonly string[]) => codes.map((c) => svaraCardCodeToFaceSrc(c)).filter((src): src is string => !!src)
  const folded = (playerId: string) => snapshot.seats.find((seat) => seat.playerId === playerId)?.folded !== false
  if (round?.kind === 'showdown-display') {
    for (const playerId of round.comparedPlayers) {
      const cards = round.cards[playerId]
      if (cards && !folded(playerId)) out[playerId] = faces(cards)
    }
  }
  if (round?.kind === 'reveal-choice' && round.decision === 'revealed' && round.cards) out[round.winnerId] = faces(round.cards)
  if (snapshot.you.cards && snapshot.you.playerId === localProfileId) out[localProfileId] = faces(snapshot.you.cards)
  return out
}

export function createSvaraRealScene(options: { onOpenProfile?: (playerId: string) => void } = {}): SvaraRealScene {
  const shell = createSvaraSceneShell({ bannerText: 'СВАРА!', avatarSrcs: [], names: [], frameless: true, seatStyle: 'card' })
  shell.stage.dataset.svaraRealScene = '1'
  // Кликовете (профил) минават през слоя със спрайтовете към местата.
  shell.spritesHost.style.pointerEvents = 'none'
  // Картите като в Белот: спрайтовете се подреждат по z заедно с профилните карета.
  const renderer = createSvaraSceneDomRenderer({ stageZ: svaraSceneStageZ })
  let mounted = false
  let layout: SvaraSceneLayout | null = null
  let sizeKey = ''
  let host: HTMLElement | null = null
  let resizeObserver: ResizeObserver | null = null
  let input: SvaraRealSceneInput | null = null
  let previous: SvaraMatchSnapshotMessage | null = null
  // Сроковете идват с отделно съобщение — събитията, чакащи срок (раздаване,
  // сравняване), се откриват и когато пристигне синхронизираният срок.
  let previousTimingKey = ''
  let lastAnimations = true
  let matchKey: string | null = null
  let seq = 0
  const random = (() => { let a = 0x51a7a; return () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648 } })()
  const jitter = (amount: number) => (random() - 0.5) * 2 * amount

  // Логически модел (последните зададени цели) — никога източник на игрово състояние.
  let states: Record<string, SvaraSpriteState> = {}
  const hands = new Map<number, CardHand>() // по място в сцената (0 долу, 1 ляво, 2 горе, 3 дясно)
  const stacks = new Map<number, string[]>() // купчинка чипове на играча (отдолу нагоре)
  let pot: Array<{ id: string; stack: number }> = []
  let deckVisible = false
  const done = new Set<string>()
  const busySeats = new Map<number, number>() // място → момент (performance.now), до който купчинката е „заета“
  let pendingBets: Array<{ seatIndex: number; added: number }> = []
  let pendingLook = false
  let reconcileTimer: number | null = null
  const timers = new Set<number>()
  const hudCache = new Map<number, string>()
  /** Последно нарисуваното профилно каре по място (ключ на входните данни). */
  const cardCache = new Map<number, string>()
  /** Мащабът на профилните карета от Белот (CSS px на сцената). */
  let cardScale = 1

  // Лицата на картите се зареждат предварително (публични файлове — никакво
  // разкриване): обръщането не чака мрежата.
  const preloaded = new Set<string>()
  function preloadFace(src: string | null): void {
    if (!src || preloaded.has(src)) return
    preloaded.add(src)
    const img = new Image()
    img.src = src
  }

  // Звукът на раздаването: през общата система (настройката „Звуци в
  // играта“; грешките при блокирано от браузъра аудио се поглъщат тихо).
  // Файлът се зарежда предварително, за да звучи точно при излитането.
  // ── Бройките върху собствените карти след „Погледни“ ────────────────────
  let ownPointsEl: HTMLElement | null = null
  function removeOwnPoints(): void {
    ownPointsEl?.getAnimations().forEach((animation) => animation.cancel())
    ownPointsEl?.remove()
    ownPointsEl = null
  }
  /** Значка с бройки (общ стил: златна рамка, тъмен полупрозрачен фон), центрирана в (x, y). */
  function pointsBadge(points: number, x: number, y: number, fontPx: number): HTMLElement {
    const el = document.createElement('div')
    el.setAttribute('aria-hidden', 'true')
    el.textContent = String(points)
    el.style.cssText = 'position:absolute;left:0;top:0;transform:translate(-50%,-50%);pointer-events:none;z-index:5;'
      + 'min-width:1.6em;padding:.06em .34em;border-radius:999px;text-align:center;line-height:1.1;'
      + 'background:rgba(10,14,12,.78);border:2px solid #f5d06f;color:#ffe49a;font-weight:900;'
      + 'text-shadow:0 2px 4px rgba(0,0,0,.8);box-shadow:0 6px 18px rgba(0,0,0,.55);opacity:0;will-change:transform,opacity;'
    el.style.left = `${Math.round(x)}px`
    el.style.top = `${Math.round(y)}px`
    el.style.fontSize = `${Math.round(fontPx)}px`
    shell.hudLayer.appendChild(el)
    return el
  }
  /** Размер на значката върху голямото собствено ветрило (както след „Погледни“). */
  function ownBadgeFontPx(): number {
    return Math.max(22, Math.min(44, layout!.cardHeight * layout!.revealScale * 0.3))
  }
  /**
   * Къде е значката върху собствените обърнати карти. Като в Белот картите са
   * зад долното каре — значката е във видимата им част над него.
   */
  function ownPointsAnchor(): { x: number; y: number; font: number } {
    const center = svaraOwnRevealCardState(layout!, 1, 0)
    if (!layout!.belotHands) return { x: center.x, y: center.y, font: ownBadgeFontPx() }
    const seat = layout!.seats[0]!
    const visibleTop = center.y - layout!.belotHands.ownCard.h / 2
    const visibleBottom = seat.avatar.y - seat.box.h / 2
    return { x: center.x, y: (visibleTop + visibleBottom) / 2, font: Math.max(18, Math.min(32, (visibleBottom - visibleTop) * 0.42)) }
  }
  /** Лек показ (появяване с мащаб → задържане → избледняване), центриран върху ветрилото. */
  function showOwnPoints(points: number): void {
    if (!layout || !input?.animations) return
    removeOwnPoints()
    // Центърът на ветрилото = средната карта (същото състояние като в обръщането).
    const center = ownPointsAnchor()
    const el = pointsBadge(points, center.x, center.y, center.font)
    el.dataset.svaraOwnPoints = String(points)
    ownPointsEl = el
    const animation = el.animate([
      { opacity: 0, transform: 'translate(-50%,-50%) scale(.6)' },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(1.08)', offset: 0.16 },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.26 },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.78 },
      { opacity: 0, transform: 'translate(-50%,-50%) scale(1.04)' },
    ], { duration: OWN_POINTS_SHOW_MS, easing: 'ease-out', fill: 'forwards' })
    animation.finished.then(() => { if (ownPointsEl === el) removeOwnPoints() }, () => {})
  }

  // ── Бройките при сравняване: върху всяка сравнявана ръка, до прибирането ──
  const compareBadges = new Map<number, HTMLElement>() // по място в сцената
  let compareRoundId: string | null = null
  function clearCompareBadges(): void {
    for (const el of compareBadges.values()) { el.getAnimations().forEach((a) => a.cancel()); el.remove() }
    compareBadges.clear()
    compareRoundId = null
  }
  /** Картите на мястото започват да се прибират — значката изчезва с тях. */
  function fadeCompareBadge(sceneSeat: number, delayMs: number): void {
    const el = compareBadges.get(sceneSeat)
    if (!el) return
    compareBadges.delete(sceneSeat)
    if (!input?.animations) { el.remove(); return }
    el.getAnimations().forEach((a) => a.cancel())
    el.style.opacity = '1'
    el.animate([{ opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(.85)' }],
      { duration: COMPARE_BADGE_OUT_MS, delay: delayMs, easing: 'ease-in', fill: 'forwards' })
      .finished.then(() => el.remove(), () => el.remove())
  }
  /** Центърът на ветрилото (средната карта) и размерът на значката за мястото. */
  function compareBadgeAnchor(sceneSeat: number, ownReveal: boolean): { x: number; y: number; font: number } {
    if (sceneSeat === 0 && ownReveal) return ownPointsAnchor()
    const seat = layout!.seats[sceneSeat]!
    if (layout!.belotHands) {
      // Като в Белот: върху разкритите карти (пред карето), по средата на ветрилото.
      const c = revealedState(sceneSeat, 1)
      return { x: c.x, y: c.y, font: Math.max(14, Math.min(30, layout!.belotHands.oppCard.h * 0.22)) }
    }
    const c = fanState(sceneSeat, 1, 3, 0)
    const cardH = layout!.cardSprite.h * c.scale
    // Леко навътре от средата на ветрилото — далеч от аватара.
    const shift = cardH * 0.12
    return { x: c.x + seat.inward.x * shift, y: c.y + seat.inward.y * shift, font: Math.max(14, Math.min(36, cardH * 0.32)) }
  }
  /**
   * Значки за всички сравнявани (само `comparedPlayers`, бройките са сървърните
   * `comparisonPoints`). `appearInMs` = кога се появяват анимирано; null = веднага, без анимация.
   */
  function showCompareBadges(round: Extract<NonNullable<SvaraMatchSnapshotMessage['round']>, { kind: 'showdown-display' }>, appearInMs: number | null): void {
    if (!layout) return
    clearCompareBadges()
    compareRoundId = round.roundId
    const entries: Array<{ sceneSeat: number; points: number }> = []
    for (const playerId of round.comparedPlayers) {
      const points = round.comparisonPoints[playerId]
      const seat = seatOfPlayer(playerId)
      if (typeof points !== 'number' || !seat) continue
      entries.push({ sceneSeat: sceneSeatOf(seat.seatIndex), points })
    }
    const render = (animate: boolean) => {
      if (compareRoundId !== round.roundId) return
      for (const { sceneSeat, points } of entries) {
        const at = compareBadgeAnchor(sceneSeat, hands.get(sceneSeat)?.revealed ?? false)
        const el = pointsBadge(points, at.x, at.y, at.font)
        el.dataset.svaraComparePoints = String(points)
        el.dataset.svaraCompareSeat = String(sceneSeat)
        compareBadges.set(sceneSeat, el)
        if (!animate) { el.style.opacity = '1'; continue }
        el.animate([
          { opacity: 0, transform: 'translate(-50%,-50%) scale(.6)' },
          { opacity: 1, transform: 'translate(-50%,-50%) scale(1.08)', offset: 0.6 },
          { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' },
        ], { duration: COMPARE_BADGE_IN_MS, easing: 'ease-out', fill: 'forwards' })
      }
    }
    if (appearInMs === null || !input?.animations) render(false)
    else later(appearInMs, () => render(true))
  }

  let dealSoundPreloaded = false
  let lastDealSoundAt = -Infinity
  function playDealSound(): void {
    if (!input?.animations) return
    const now = performance.now()
    if (now - lastDealSoundAt < DEAL_SOUND_MIN_GAP_MS) return
    lastDealSoundAt = now
    playGameSound(DEAL_SOUND_SRC, { volume: DEAL_SOUND_VOLUME })
  }
  function preloadDealSound(): void {
    if (dealSoundPreloaded || typeof Audio === 'undefined') return
    dealSoundPreloaded = true
    const audio = new Audio()
    audio.preload = 'auto'
    audio.src = DEAL_SOUND_SRC
  }

  // ── Места ───────────────────────────────────────────────────────────────
  const localSeatIndex = () => input?.snapshot.you.seatIndex ?? 0
  const capacity = () => input?.table.capacity ?? 4
  const sceneSeatOf = (seatIndex: number) => svaraSceneSeatIndexOf(getSvaraVisualSlot(seatIndex, localSeatIndex(), capacity()))
  const seatOfPlayer = (playerId: string) => input?.snapshot.seats.find((s) => s.playerId === playerId) ?? null

  // ── Размер на сцената ──────────────────────────────────────────────────
  function stageSize(target: HTMLElement): { width: number; height: number } {
    const width = Math.max(240, Math.round(target.clientWidth))
    const rect = target.getBoundingClientRect()
    const zoom = target.offsetWidth > 0 ? rect.width / target.offsetWidth : 1
    const viewportHeight = window.innerHeight / (zoom || 1)
    const fullscreen = document.fullscreenElement !== null && document.fullscreenElement.contains(target)
    // Място за бутоните за действие и рамката (и заглавката, ако не е цял екран).
    const available = viewportHeight - (fullscreen ? 90 : 160)
    if (width >= 560) {
      // Сукното е по цялата ширина — височината е мястото от горния му ръб до
      // долния край на екрана, без лентата с бутоните за действие (до 0.6×
      // ширината, както досега).
      // Позиция в оформлението, независимо от превъртането.
      let scrolled = fullscreen ? 0 : window.scrollY
      for (let el = target.parentElement; el; el = el.parentElement) {
        scrolled += el.scrollTop
        if (el === document.fullscreenElement) break
      }
      const top = (rect.top + scrolled) / (zoom || 1)
      const room = viewportHeight - top - DESKTOP_ACTION_BAR_RESERVE_PX
      return { width, height: Math.round(Math.max(240, Math.min(width * 0.6, room))) }
    }
    // Телефон: сукното расте (до 1.5× ширината) само докато под него остава
    // място за постоянния панел с бутоните (2 реда) — никога по-ниско от
    // 1.2× (сукното е по цялата ширина на екрана, затова собствените карти
    // остават поне толкова големи, колкото бяха в рамката при 1.35×).
    // Позиция в оформлението (независимо от превъртането).
    let stageTop = 0
    for (let el: HTMLElement | null = target; el; el = el.offsetParent as HTMLElement | null) stageTop += el.offsetTop
    const room = viewportHeight - stageTop - PHONE_ACTION_BAR_RESERVE_PX
    const wanted = Math.max(width * 1.2, Math.min(width * 1.5, room))
    return { width, height: Math.round(Math.max(240, Math.min(wanted, available))) }
  }

  // ── Спрайтове ───────────────────────────────────────────────────────────
  function add(def: SvaraSpriteDef, state: SvaraSpriteState): void {
    renderer.addSprites([def], { [def.id]: state })
    states[def.id] = state
  }
  function remove(ids: string[]): void {
    renderer.removeSprites(ids)
    for (const id of ids) delete states[id]
  }
  function setNow(next: Record<string, SvaraSpriteState>): void {
    renderer.setStates(next)
    Object.assign(states, next)
  }
  /** Движения по хореографията; без анимации — направо крайното състояние. */
  function play(inputs: SvaraMoveInput[], elapsedMs = 0, timeScale = 1): number {
    if (inputs.length === 0 || !layout) return 0
    const scaled = timeScale === 1 ? inputs : inputs.map((m) => ({ ...m, delayMs: m.delayMs * timeScale, durationMs: Math.max(1, m.durationMs * timeScale) }))
    const { moves, states: after } = resolveSvaraMoves(scaled, states)
    const end = Math.max(...moves.map((m) => m.delayMs + m.durationMs))
    if (!input?.animations) {
      const finals: Record<string, SvaraSpriteState> = {}
      for (const move of moves) finals[move.id] = after[move.id]!
      setNow(finals)
      return 0
    }
    void renderer.playFrom(moves, elapsedMs)
    Object.assign(states, after)
    return Math.max(0, end - elapsedMs)
  }
  function later(ms: number, fn: () => void): void {
    if (!input?.animations || ms <= 0) { fn(); return }
    const timer = window.setTimeout(() => { timers.delete(timer); fn() }, ms)
    timers.add(timer)
  }
  function markBusy(sceneSeat: number, ms: number): void {
    busySeats.set(sceneSeat, Math.max(busySeats.get(sceneSeat) ?? 0, performance.now() + ms + 60))
    scheduleReconcile(ms + 80)
  }

  // ── Тесте ───────────────────────────────────────────────────────────────
  function ensureDeck(): void {
    if (!layout) return
    for (let i = 0; i < DECK_SPRITES; i += 1) {
      const id = `deck-${i}`
      if (!renderer.hasSprite(id)) add({ id, kind: 'card', faceSrc: null }, { ...svaraDeckCardState(layout, i), alpha: 0 })
    }
  }
  function setDeck(visible: boolean, delayMs = 0, elapsedMs = 0): void {
    if (!layout) return
    ensureDeck()
    if (deckVisible === visible && delayMs === 0) return
    deckVisible = visible
    const inputs: SvaraMoveInput[] = []
    for (let i = 0; i < DECK_SPRITES; i += 1) {
      const id = `deck-${i}`
      const at = svaraDeckCardState(layout, i)
      inputs.push(svaraFadeMove(id, at, delayMs, visible ? 150 : SVARA_SCENE_TIMING.deckFadeMs, visible ? 1 : 0))
    }
    play(inputs, elapsedMs)
  }

  // ── Купчинки чипове на играчите ─────────────────────────────────────────
  function stackCount(stack: number): number {
    const starting = input?.snapshot.table.startingChips ?? 1
    return stack <= 0 ? 0 : clamp(Math.round((5 * stack) / Math.max(1, starting)), 1, MAX_STACK_CHIPS)
  }
  function stackState(sceneSeat: number, level: number): SvaraSpriteState {
    const seat = layout!.seats[sceneSeat]!
    return svaraChipOnStack(seat.chipStack, level, layout!, 200 + sceneSeat * 20 + level, ((sceneSeat * 7 + level * 13) % 24) - 12)
  }
  function newChip(sceneSeat: number, level: number, state: SvaraSpriteState): string {
    const id = `chip-${seq += 1}`
    add({ id, kind: 'chip', color: CHIP_COLORS[(sceneSeat + level) % CHIP_COLORS.length]! }, state)
    return id
  }
  /** Купчинката на мястото да отразява сървърния баланс (появяване/изчезване на върха). */
  function reconcileStack(sceneSeat: number, count: number, animate: boolean): void {
    const ids = stacks.get(sceneSeat) ?? []
    stacks.set(sceneSeat, ids)
    const inputs: SvaraMoveInput[] = []
    while (ids.length > count) {
      const id = ids.pop()!
      if (animate && input?.animations) { inputs.push(svaraFadeMove(id, states[id]!, 0, 220)); later(260, () => remove([id])) } else remove([id])
    }
    while (ids.length < count) {
      const level = ids.length
      const target = stackState(sceneSeat, level)
      const id = newChip(sceneSeat, level, animate ? { ...target, alpha: 0 } : target)
      ids.push(id)
      if (animate) inputs.push(svaraFadeMove(id, target, 0, 220, 1))
    }
    // Чиповете, кацнали отгоре (изплащане), се подреждат в купчинката.
    ids.forEach((id, level) => {
      const target = stackState(sceneSeat, level)
      if (!sameState(states[id], target) && states[id]?.alpha !== 0) {
        if (animate) inputs.push({ id, to: target, delayMs: 0, durationMs: 180, easing: 'outCubic', lift: 0 })
        else setNow({ [id]: target })
      }
    })
    play(inputs)
  }

  // ── Банка ───────────────────────────────────────────────────────────────
  function potLevel(stack: number): number {
    return pot.filter((chip) => chip.stack === stack).length
  }
  function potChipState(stack: number, level: number, z: number): SvaraSpriteState {
    return svaraChipOnStack(layout!.potStacks[stack % 4]!, level, layout!, z, jitter(18))
  }

  /** k чипа от купчинката на играча към неговата малка купчинка в банката (полетът на демото). */
  function betChips(sceneSeat: number, k: number, delayMs: number, elapsedMs = 0): number {
    const ids = stacks.get(sceneSeat) ?? []
    stacks.set(sceneSeat, ids)
    const inputs: SvaraMoveInput[] = []
    for (let j = 0; j < k; j += 1) {
      let id = ids.pop()
      if (!id) id = newChip(sceneSeat, 0, stackState(sceneSeat, 0))
      const level = potLevel(sceneSeat)
      pot.push({ id, stack: sceneSeat })
      inputs.push(svaraBetChipMove(layout!, id, layout!.potStacks[sceneSeat]!, level, 300 + pot.length, delayMs + j * SVARA_SCENE_TIMING.betChipStaggerMs, jitter))
    }
    const remaining = play(inputs, elapsedMs)
    markBusy(sceneSeat, remaining)
    return remaining
  }

  /** Демо: събиране в банката → каскада към купчинката на победителя/ите (там остават). */
  function payout(recipients: number[], share: number, windowMs: number, elapsedMs: number, amounts: Map<number, number>): void {
    if (!layout || recipients.length === 0) return
    let chips = pot.splice(Math.max(0, pot.length - Math.max(1, Math.ceil(pot.length * share))))
    if (chips.length === 0) {
      chips = Array.from({ length: 3 }, (_, i) => {
        const id = `chip-${seq += 1}`
        const state = potChipState(i, i, 400 + i)
        add({ id, kind: 'chip', color: CHIP_COLORS[i % 3]! }, state)
        return { id, stack: i }
      })
    }
    const gather: SvaraMoveInput[] = chips.map((chip, idx) => svaraGatherChipMove(layout!, chip.id, idx, 3, jitter))
    const groups = Math.max(1, Math.ceil(chips.length / 3))
    const transferStart = svaraTransferStartMs(groups)
    const order = [...chips].reverse()
    const transfer: SvaraMoveInput[] = order.map((chip, n) => {
      const sceneSeat = recipients[n % recipients.length]!
      const ids = stacks.get(sceneSeat) ?? []
      stacks.set(sceneSeat, ids)
      ids.push(chip.id)
      const seat = layout!.seats[sceneSeat]!
      return svaraTransferChipMove(layout!, chip.id, seat.chipStack, ids.length - 1, 500 + n, transferStart + n * SVARA_SCENE_TIMING.transferStaggerMs, jitter)
    })
    const natural = transferStart + (order.length - 1) * SVARA_SCENE_TIMING.transferStaggerMs + SVARA_SCENE_TIMING.transferMs
    // Одобрено: 1800 ms на стъпка. Докато сървърният прозорец е по-кратък, хореографията се сгъстява в него.
    const scale = Math.min(1, Math.max(0.35, (Math.min(windowMs, SVARA_REAL_PAYOUT_STEP_TARGET_MS) - 80) / natural))
    const remaining = play([...gather, ...transfer], elapsedMs / scale, scale)
    for (const sceneSeat of recipients) markBusy(sceneSeat, remaining)
    later(Math.max(0, remaining - 40), () => {
      for (const sceneSeat of recipients) shell.showWinner(sceneSeat, amounts.get(sceneSeat) ?? 0, !!input?.animations)
    })
  }

  // ── Карти ───────────────────────────────────────────────────────────────
  function handKey(roundId: string) { return roundId }
  function cardFaceFor(playerId: string, snapshot: SvaraMatchSnapshotMessage): (string | null)[] | null {
    return svaraSceneVisibleFaces(snapshot, input?.localProfileId ?? '')[playerId] ?? null
  }
  function fanState(sceneSeat: number, slot: number, count: number, z: number): SvaraSpriteState {
    return svaraSeatFanState(layout!, layout!.seats[sceneSeat]!, slot, count, z)
  }
  /**
   * Разкритите карти на противник: като в Белот — изправени, върху карето му
   * (пред него); иначе обърнатото ветрило на мястото.
   */
  function revealedState(sceneSeat: number, slot: number): SvaraSpriteState {
    const z = 100 + sceneSeat * 3 + slot
    return layout!.belotHands
      ? svaraBelotRevealCardState(layout!, layout!.seats[sceneSeat]!, slot, 150 + z)
      : { ...fanState(sceneSeat, slot, 3, z), faceUp: true }
  }
  /** Крайно положение на ръката: ветрило; собствените обърнати — голямото ветрило на демото. */
  function settledHandStates(sceneSeat: number, hand: CardHand): Record<string, SvaraSpriteState> {
    const out: Record<string, SvaraSpriteState> = {}
    hand.ids.forEach((id, slot) => {
      out[id] = hand.revealed && sceneSeat === 0
        ? svaraOwnRevealCardState(layout!, slot, 150 + slot)
        : hand.revealed
          ? revealedState(sceneSeat, slot)
          : { ...fanState(sceneSeat, slot, hand.ids.length, 100 + sceneSeat * 3 + slot), faceUp: false }
    })
    return out
  }
  function createHand(sceneSeat: number, key: string, faces: (string | null)[] | null, revealed: boolean, at: (slot: number) => SvaraSpriteState): CardHand {
    const ids = [0, 1, 2].map((slot) => {
      const id = `card-${key}-${sceneSeat}-${slot}`
      const face = faces?.[slot] ?? null
      preloadFace(face)
      add({ id, kind: 'card', faceSrc: face }, at(slot))
      return id
    })
    const hand: CardHand = { key, ids, faces: faces ?? [null, null, null], revealed }
    hands.set(sceneSeat, hand)
    return hand
  }
  /** Карти към позицията на (скритото) тесте, с избледняване. */
  function collectHand(sceneSeat: number, delayMs = 0): void {
    const hand = hands.get(sceneSeat)
    if (!hand || !layout) return
    hands.delete(sceneSeat)
    fadeCompareBadge(sceneSeat, delayMs)
    // Прибиращите се карти вече не принадлежат на място (маркерите се махат).
    for (const id of hand.ids) {
      const el = shell.spritesHost.querySelector<HTMLElement>(`[data-svara-sprite="${id}"]`)
      if (!el) continue
      delete el.dataset.svaraCardSeat; delete el.dataset.svaraCardIndex; delete el.dataset.svaraOwnCard
      el.dataset.svaraCardCollecting = '1'
    }
    const inputs = hand.ids.map((id, i) => {
      const move = svaraCollectCardMove(layout!, id, i, !!states[id]?.faceUp, jitter, delayMs + i * SVARA_SCENE_TIMING.collectCardsStaggerMs)
      // Картите като в Белот: скритите карти излизат иззад карето и остават под
      // каретата по пътя (иначе в началото на хода изскачат пред карето).
      const z = states[id]?.z
      return z !== undefined && z < 0 ? { ...move, to: { ...move.to, z } } : move
    })
    const remaining = play(inputs)
    later(remaining + 30, () => remove(hand.ids))
  }
  function setHandFaces(hand: CardHand, faces: (string | null)[]): void {
    faces.forEach((face, slot) => {
      if (!face || hand.faces[slot] === face) return
      preloadFace(face)
      renderer.setFace(hand.ids[slot]!, face)
      hand.faces[slot] = face
    })
  }

  /** Раздаването по одобреното темпо, превъртяно спрямо сървърния срок. */
  function startDeal(snapshot: SvaraMatchSnapshotMessage, roundId: string, participants: string[], deadlineAt: number): void {
    if (!layout || !input) return
    const n = participants.length
    const serverTotal = svaraDealingAnimationMs(n)
    const elapsed = Math.max(0, input.serverNow - (deadlineAt - serverTotal))
    const cardsTotal = n * 3
    const dealMs = svaraRealDealDurationMs(n)
    const stagger = cardsTotal > 1 ? (dealMs - SVARA_SCENE_TIMING.dealFlightMs) / (cardsTotal - 1) : 0
    const lastLanding = SVARA_REAL_ANTE_MS + dealMs
    // Тестето се появява; изчезва ~200 ms след последната кацнала карта.
    if (elapsed < lastLanding) {
      setDeck(true, 0, elapsed)
      later(Math.max(0, lastLanding - elapsed), () => setDeck(false))
    } else setDeck(false)
    // Анте: по един чип от купчинката на всяко платило място (в прозореца „Вход“).
    participants.forEach((playerId, order) => {
      const seat = snapshot.seats.find((s) => s.playerId === playerId)
      if (!seat || seat.roundContribution <= 0 || snapshot.round?.kind !== 'ordinary') return
      betChips(sceneSeatOf(seat.seatIndex), 1, 100 + order * 120, elapsed)
    })
    // Карти: една по една, кръгово; ветрилото се разтваря при всяка нова.
    const created = new Map<number, CardHand>()
    const inputs: SvaraMoveInput[] = []
    const z = new Map<string, number>()
    const counts = new Map<number, string[]>()
    for (let k = 0; k < cardsTotal; k += 1) {
      const seat = snapshot.seats.find((s) => s.playerId === participants[k % n])
      if (!seat) continue
      const sceneSeat = sceneSeatOf(seat.seatIndex)
      let hand = created.get(sceneSeat)
      if (!hand) {
        hand = createHand(sceneSeat, handKey(roundId), null, false, () => svaraDeckCardState(layout!, DECK_SPRITES + cardsTotal - 1 - k))
        created.set(sceneSeat, hand)
      }
      const ids = counts.get(sceneSeat) ?? []
      const id = hand.ids[ids.length]!
      // Картата е отгоре на тестето и се появява заедно с него.
      const atDeck = svaraDeckCardState(layout, DECK_SPRITES + cardsTotal - 1 - k)
      setNow({ [id]: { ...atDeck, alpha: 0 } })
      inputs.push(svaraFadeMove(id, atDeck, 0, 150, 1))
      const launch = SVARA_REAL_ANTE_MS + k * stagger
      const count = ids.length + 1
      const seatLayout = layout.seats[sceneSeat]!
      inputs.push(svaraDealCardMove(layout, seatLayout, id, count - 1, count, 100 + k, launch))
      ids.forEach((existing, slot) => inputs.push(svaraRespreadMove(layout!, seatLayout, existing, slot, count, z.get(existing)!, launch)))
      ids.push(id)
      z.set(id, 100 + k)
      counts.set(sceneSeat, ids)
      // Звук при излитането на картата (като в демото). При превъртане след
      // reconnect вече излетелите карти не звучат отново.
      if (launch >= elapsed - DEAL_SOUND_LATE_MS) later(Math.max(0, launch - elapsed), playDealSound)
    }
    play(inputs, elapsed)
  }

  // ── Проектор: крайната сцена от snapshot-а (baseline / refresh / без анимации) ─
  function settle(snapshot: SvaraMatchSnapshotMessage): void {
    if (!layout) return
    renderer.cancel()
    for (const timer of timers) window.clearTimeout(timer)
    timers.clear()
    removeOwnPoints()
    clearCompareBadges()
    busySeats.clear()
    const round = snapshot.round
    const betting = round && (round.kind === 'ordinary' || round.kind === 'svara') ? round : null
    // Тесте: само по време на раздаване.
    ensureDeck()
    deckVisible = !!betting?.dealing
    const deckStates: Record<string, SvaraSpriteState> = {}
    for (let i = 0; i < DECK_SPRITES; i += 1) deckStates[`deck-${i}`] = { ...svaraDeckCardState(layout, i), alpha: deckVisible ? 1 : 0 }
    setNow(deckStates)
    // Карти.
    const keep = new Set<number>()
    const showing = round?.kind === 'showdown-display' || round?.kind === 'reveal-choice'
    for (const seat of snapshot.seats) {
      const sceneSeat = sceneSeatOf(seat.seatIndex)
      const inHand = betting ? betting.participants.includes(seat.playerId) && !seat.folded && seat.cardCount > 0
        : round?.kind === 'showdown-display' ? round.comparedPlayers.includes(seat.playerId)
          : round?.kind === 'reveal-choice' ? round.winnerId === seat.playerId : false
      if (!inHand) continue
      keep.add(sceneSeat)
      const faces = cardFaceFor(seat.playerId, snapshot)
      const key = betting ? handKey(betting.roundId) : hands.get(sceneSeat)?.key ?? `show-${round!.roundId}`
      let hand = hands.get(sceneSeat)
      if (!hand || (betting && hand.key !== key)) {
        if (hand) remove(hand.ids)
        hand = createHand(sceneSeat, key, faces, !!faces, () => ({ ...svaraDeckCardState(layout!, 0), alpha: 0 }))
      } else {
        if (faces) setHandFaces(hand, faces)
        hand.revealed = !!faces
      }
      void showing
      setNow(settledHandStates(sceneSeat, hand))
    }
    for (const [sceneSeat, hand] of [...hands]) if (!keep.has(sceneSeat)) { remove(hand.ids); hands.delete(sceneSeat) }
    // Сравняване: бройките върху сравняваните ръце (текущо състояние, без анимация).
    if (round?.kind === 'showdown-display') showCompareBadges(round, null)
    // Купчинки на играчите.
    for (const seat of snapshot.seats) reconcileStack(sceneSeatOf(seat.seatIndex), stackCount(seat.stack), false)
    // Банка: по малка купчинка на всяко място с вноска; заключените — отделно.
    remove(pot.map((chip) => chip.id))
    pot = []
    if (betting) {
      for (const seat of snapshot.seats) {
        if (seat.roundContribution <= 0) continue
        const sceneSeat = sceneSeatOf(seat.seatIndex)
        const count = clamp(1 + Math.floor(Math.log2(Math.max(1, seat.roundContribution / Math.max(1, snapshot.table.entryChips)))), 1, 4)
        for (let j = 0; j < count; j += 1) {
          const id = `chip-${seq += 1}`
          add({ id, kind: 'chip', color: CHIP_COLORS[(sceneSeat + j) % 3]! }, potChipState(sceneSeat, potLevel(sceneSeat), 300 + pot.length))
          pot.push({ id, stack: sceneSeat })
        }
      }
    }
    const locked = snapshot.lockedPots.reduce((sum, p) => sum + p.amount, 0)
    const remainingPayout = round?.kind === 'showdown-display' ? round.payout.reduce((sum, step) => sum + step.amount, 0) : 0
    const extra = locked + (betting ? 0 : remainingPayout)
    if (extra > 0) {
      const count = clamp(Math.ceil(extra / Math.max(1, snapshot.table.entryChips * 2)), 2, 9)
      for (let j = 0; j < count; j += 1) {
        const id = `chip-${seq += 1}`
        add({ id, kind: 'chip', color: CHIP_COLORS[j % 3]! }, potChipState(j % 4, potLevel(j % 4), 300 + pot.length))
        pot.push({ id, stack: j % 4 })
      }
    }
    shell.hideWinner()
  }

  // ── Детектор + планировчик ───────────────────────────────────────────────
  function detect(prev: SvaraMatchSnapshotMessage, snapshot: SvaraMatchSnapshotMessage): void {
    if (!layout || !input) return
    const round = snapshot.round
    const prevRound = prev.round
    const betting = round && (round.kind === 'ordinary' || round.kind === 'svara') ? round : null
    const synced = input.timing && input.timing.matchId === snapshot.matchId && input.timing.revision === snapshot.revision ? input.timing : null

    // Нова ръка: старите карти се прибират към (скритото) тесте; пръстенът изчезва.
    const handStillShown = round?.kind === 'showdown-display' || round?.kind === 'reveal-choice'
    if (!handStillShown) {
      for (const [sceneSeat, hand] of [...hands]) if (!betting || hand.key !== handKey(betting.roundId)) collectHand(sceneSeat)
    }
    if (betting && prevRound?.roundId !== betting.roundId) shell.hideWinner()

    // Раздаване.
    if (betting?.dealing && !done.has(`deal:${betting.roundId}`)) {
      const deadline = synced?.deadlines.find((d) => d.kind === 'dealing')
      if (deadline) {
        done.add(`deal:${betting.roundId}`)
        startDeal(snapshot, betting.roundId, betting.participants, deadline.deadlineAt)
      }
    } else if (betting && !betting.dealing && !done.has(`deal:${betting.roundId}`)) {
      // Раздаването е пропуснато (късно свързване) — картите направо на местата.
      done.add(`deal:${betting.roundId}`)
      setDeck(false)
      for (const playerId of betting.participants) {
        const seat = seatOfPlayer(playerId)
        if (!seat || seat.folded) continue
        const sceneSeat = sceneSeatOf(seat.seatIndex)
        if (hands.get(sceneSeat)?.key === handKey(betting.roundId)) continue
        const hand = createHand(sceneSeat, handKey(betting.roundId), null, false, () => ({ ...svaraDeckCardState(layout!, 0), alpha: 0 }))
        play(hand.ids.map((id, slot) => ({ id, to: fanState(sceneSeat, slot, 3, 100 + slot), delayMs: slot * 40, durationMs: 220, easing: 'outCubic' as const, lift: 0.1 })))
      }
    }

    // Отказ: картите се прибират към скритото тесте.
    if (betting) for (const seat of snapshot.seats) {
      const before = prev.seats.find((s) => s.seatIndex === seat.seatIndex)
      if (seat.folded && !before?.folded) collectHand(sceneSeatOf(seat.seatIndex))
    }

    // „Погледни“: собствените карти — вдигане, обръщане, голямо ветрило.
    if (pendingLook || (snapshot.you.cards && !prev.you.cards && betting)) {
      pendingLook = false
      const own = hands.get(0)
      if (own && snapshot.you.cards && !own.revealed) {
        setHandFaces(own, snapshot.you.cards.map((c) => svaraCardCodeToFaceSrc(c)))
        own.revealed = true
        play(own.ids.map((id, slot) => svaraOwnRevealMove(layout!, id, slot, 150 + slot)))
        // Бройките върху обърнатите карти — веднъж за раздаването, след
        // последното обръщане (не при refresh/reconnect: тогава няма събитие).
        const roundId = betting?.roundId
        const points = snapshot.you.handPoints ?? null
        if (roundId && points !== null && input?.animations && !done.has(`points:${roundId}`)) {
          done.add(`points:${roundId}`)
          later(OWN_REVEAL_DONE_MS, () => showOwnPoints(points))
        }
      }
    }

    // Залози → чипове към банката.
    if (pendingBets.length) {
      const bets = pendingBets
      pendingBets = []
      bets.forEach((bet, order) => {
        const k = bet.added <= snapshot.table.entryChips ? 1 : bet.added <= 4 * snapshot.table.entryChips ? 2 : 3
        betChips(sceneSeatOf(bet.seatIndex), k, order * SVARA_SCENE_TIMING.betSeatStaggerMs)
      })
    }

    // Сравняване: картите се обръщат (като в демото); при равенство — „СВАРА!“.
    if (round?.kind === 'showdown-display' && round.displayPhase === 'showdown' && !done.has(`show:${round.roundId}`) && synced) {
      done.add(`show:${round.roundId}`)
      const deadline = synced.deadlines.find((d) => d.kind === 'showdown-display')
      const elapsed = deadline ? Math.max(0, input.serverNow - (deadline.deadlineAt - SVARA_SHOWDOWN_MS)) : 0
      round.comparedPlayers.forEach((playerId, order) => {
        const seat = seatOfPlayer(playerId)
        if (!seat) return
        const sceneSeat = sceneSeatOf(seat.seatIndex)
        const faces = cardFaceFor(playerId, snapshot)
        if (!faces) return
        let hand = hands.get(sceneSeat)
        if (!hand) hand = createHand(sceneSeat, `show-${round.roundId}`, null, false, (slot) => ({ ...fanState(sceneSeat, slot, 3, 100 + slot), alpha: 1 }))
        setHandFaces(hand, faces)
        if (hand.revealed) return
        hand.revealed = true
        const delay = order * SHOWDOWN_HAND_STAGGER_MS
        play(hand.ids.map((id, slot) => sceneSeat === 0
          ? svaraOwnRevealMove(layout!, id, slot, 150 + slot, delay + slot * SVARA_SCENE_TIMING.revealStaggerMs)
          : svaraFlipInPlaceMove(layout!, id, revealedState(sceneSeat, slot), slot, delay + slot * SVARA_SCENE_TIMING.revealStaggerMs)), elapsed)
      })
      // Бройките: едновременно, след като се обърне последната сравнявана ръка.
      const appearAt = Math.max(0, round.comparedPlayers.length - 1) * SHOWDOWN_HAND_STAGGER_MS + OWN_REVEAL_DONE_MS
      showCompareBadges(round, appearAt > elapsed ? appearAt - elapsed : null)
      if (round.svaraTie && elapsed < SVARA_SHOWDOWN_MS - 300) {
        shell.playBanner(SVARA_SHOWDOWN_MS - 200, elapsed)
        play(pot.map((chip, idx) => svaraSvarkaHopMove(layout!, chip.id, states[chip.id]!, idx, 3)), elapsed)
      }
    }

    // Сравняването вече е показано (напр. свързване по време на изплащането) — значките без анимация.
    if (round?.kind === 'showdown-display' && done.has(`show:${round.roundId}`) && compareRoundId !== round.roundId) showCompareBadges(round, null)

    // Изплащане на стъпка (основна, после страничните).
    const pay = input.resultVisual.payout
    if (pay && !done.has(`pay:${pay.key}`)) {
      done.add(`pay:${pay.key}`)
      const stepElapsed = Math.round(pay.progress * SVARA_PAYOUT_STEP_MS)
      if (stepElapsed < SVARA_PAYOUT_STEP_MS - 100) {
        const recipients = pay.recipients.map((r) => seatOfPlayer(r.playerId)).filter((s) => s !== null).map((s) => sceneSeatOf(s!.seatIndex))
        const amounts = new Map(pay.recipients.map((r) => [sceneSeatOf(seatOfPlayer(r.playerId)?.seatIndex ?? 0), r.amount]))
        payout(recipients, 1 / Math.max(1, input.resultVisual.remainingSteps.length), SVARA_PAYOUT_STEP_MS, stepElapsed, amounts)
      }
    }

    // „Всички избягаха“: банката отива при победителя (той избира „Покажи“/„Скрий“).
    if (round?.kind === 'reveal-choice' && !done.has(`award:${round.roundId}`)) {
      done.add(`award:${round.roundId}`)
      const seat = seatOfPlayer(round.winnerId)
      if (seat) {
        const before = prev.seats.find((s) => s.seatIndex === seat.seatIndex)?.stack ?? seat.stack
        payout([sceneSeatOf(seat.seatIndex)], 1, SVARA_REAL_PAYOUT_STEP_TARGET_MS, 0, new Map([[sceneSeatOf(seat.seatIndex), Math.max(0, seat.stack - before)]]))
      }
    }
    if (round?.kind === 'reveal-choice' && round.decision === 'revealed' && round.cards && !done.has(`reveal:${round.roundId}`)) {
      done.add(`reveal:${round.roundId}`)
      const seat = seatOfPlayer(round.winnerId)
      const hand = seat ? hands.get(sceneSeatOf(seat.seatIndex)) : undefined
      if (seat && hand && !hand.revealed) {
        const sceneSeat = sceneSeatOf(seat.seatIndex)
        setHandFaces(hand, round.cards.map((c) => svaraCardCodeToFaceSrc(c)))
        hand.revealed = true
        play(hand.ids.map((id, slot) => sceneSeat === 0 ? svaraOwnRevealMove(layout!, id, slot, 150 + slot) : svaraFlipInPlaceMove(layout!, id, revealedState(sceneSeat, slot), slot)))
      }
    }

    // Без раздаване и без заключена банка — остатъкът от банката изчезва.
    if (!round && snapshot.lockedPots.length === 0 && pot.length > 0) {
      const chips = pot.splice(0)
      play(chips.map((chip) => svaraFadeMove(chip.id, states[chip.id]!, 0, 260)))
      later(300, () => remove(chips.map((chip) => chip.id)))
    }
  }

  /** Купчинките да следват сървърните баланси, когато не са заети от полет. */
  function reconcileStacks(animate: boolean): void {
    if (!input || !layout) return
    const now = performance.now()
    for (const seat of input.snapshot.seats) {
      const sceneSeat = sceneSeatOf(seat.seatIndex)
      if ((busySeats.get(sceneSeat) ?? 0) > now) continue
      reconcileStack(sceneSeat, stackCount(seat.stack), animate)
    }
  }
  function scheduleReconcile(ms: number): void {
    if (reconcileTimer !== null) window.clearTimeout(reconcileTimer)
    reconcileTimer = window.setTimeout(() => { reconcileTimer = null; reconcileStacks(true) }, Math.max(0, ms))
  }

  // ── HUD ─────────────────────────────────────────────────────────────────
  function renderHud(): void {
    if (!input || !layout) return
    const visible: number[] = []
    for (const hud of input.seatHuds) {
      const sceneSeat = sceneSeatOf(hud.seatIndex)
      visible.push(sceneSeat)
      const node = shell.seats[sceneSeat]!
      node.node.dataset.svaraSeatIndex = String(hud.seatIndex)
      node.node.dataset.svaraSeatAnchor = layout.seats[sceneSeat]!.slot === 'left' ? 'left' : layout.seats[sceneSeat]!.slot === 'right' ? 'right' : layout.seats[sceneSeat]!.slot
      node.node.dataset.svaraSceneProfile = hud.playerId
      node.node.style.cursor = hud.isBot ? 'default' : 'pointer'
      node.node.style.pointerEvents = 'auto'
      node.avatar.dataset.svaraAvatar = String(hud.seatIndex)
      if (node.avatar.getAttribute('src') !== hud.avatarSrc) node.avatar.setAttribute('src', hud.avatarSrc)
      if (node.name.textContent !== hud.name) node.name.textContent = hud.name
      if (hud.isBot) node.name.dataset.svaraBotBadge = '1'; else delete node.name.dataset.svaraBotBadge
      if (hud.isToAct) node.node.dataset.svaraToAct = '1'; else delete node.node.dataset.svaraToAct
      // Профилното каре от Белот (същият компонент, мащаб и таймер в полето с името).
      const slot = layout.seats[sceneSeat]!.slot
      const cardKey = JSON.stringify([slot, hud.name, hud.avatarSrc, hud.isBot, hud.isLocal, hud.isDealer, hud.isToAct, hud.turnTimer?.deadlineAt ?? null, cardScale])
      if (node.card && cardCache.get(sceneSeat) !== cardKey) {
        cardCache.set(sceneSeat, cardKey)
        node.card.innerHTML = renderSvaraBelotSeatCardHtml({
          slot, name: hud.name, avatarSrc: hud.avatarSrc, isBot: hud.isBot, isLocal: hud.isLocal, isDealer: hud.isDealer,
          turn: hud.turnTimer ? { remainingMs: hud.turnTimer.fraction * SVARA_DEADLINE_TOTAL_MS.turn, totalMs: SVARA_DEADLINE_TOTAL_MS.turn, key: String(hud.turnTimer.deadlineAt) } : null,
          scale: cardScale,
        })
      }
      // Отпаднал/отсъстващ: затъмнено каре вместо надпис.
      const filter = hud.dim === 'eliminated' ? 'grayscale(1) brightness(.45)' : hud.dim === 'absent' ? 'grayscale(.6) brightness(.7)' : ''
      const dimTarget = node.card ?? node.avatar
      if (dimTarget.style.filter !== filter) dimTarget.style.filter = filter
      // Информацията (баланс, залог, статуси) — от другата страна на купчинката чипове.
      const seatLayout = layout.seats[sceneSeat]!
      const dx = seatLayout.avatar.x - seatLayout.chipStack.x, dy = seatLayout.avatar.y - seatLayout.chipStack.y
      const vertical = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'below' : 'above')
      // Местата отляво/отдясно: информацията е подравнена навътре (не излиза извън сукното).
      const side = vertical === 'below' || vertical === 'above' ? `${vertical}-${seatLayout.slot === 'left' ? 'start' : seatLayout.slot === 'right' ? 'end' : 'center'}` : vertical
      // Отстъп от карето: картите като в Белот се подават иззад него — балансът е извън тях.
      const gapX = Math.round(seatLayout.infoGap ?? 10), gapBelow = Math.round(seatLayout.infoGap ?? 6)
      const sideKey = `${side}:${gapX}`
      if (node.info.dataset.side !== sideKey) {
        node.info.dataset.side = sideKey
        node.info.style.cssText = 'position:absolute;display:flex;flex-direction:column;gap:2px;white-space:nowrap;pointer-events:none;z-index:3;' + (
          side === 'right' ? `left:calc(100% + ${gapX}px);top:50%;transform:translate(0,-50%);align-items:flex-start;`
            : side === 'left' ? `right:calc(100% + ${gapX}px);top:50%;transform:translate(0,-50%);align-items:flex-end;`
              : (side.startsWith('below') ? `top:calc(100% + ${gapBelow}px);` : 'bottom:calc(100% + 8px);') + (
                side.endsWith('start') ? 'left:0;align-items:flex-start;' : side.endsWith('end') ? 'right:0;align-items:flex-end;' : 'left:50%;transform:translate(-50%,0);align-items:center;'))
      }
      // Собственото място (без „(ти)“ в името).
      if (hud.isLocal) node.node.dataset.svaraLocalSeat = '1'; else delete node.node.dataset.svaraLocalSeat
      if (hud.dim) node.node.dataset.svaraSeatDim = hud.dim; else delete node.node.dataset.svaraSeatDim
      // Сумата на текущия залог — до купчинката чипове, откъм външната ѝ страна.
      // Закача се за РЪБА на купчинката при максимална височина (не за центъра),
      // така че чиповете никога не я застъпват, независимо от ширината на числото:
      // отляво/отдясно — над купчинката; горе/долу — встрани от нея.
      let bet = node.node.querySelector<HTMLElement>('[data-svara-seat-bet]')
      if (hud.bet > 0) {
        if (!bet) {
          bet = document.createElement('span')
          bet.dataset.svaraSeatBet = '1'
          bet.title = 'Текущ залог'
          bet.style.cssText = 'position:absolute;padding:1px 6px;border-radius:999px;background:rgba(0,0,0,.72);border:1px solid rgba(245,208,111,.7);color:#ffe49a;font-size:11px;font-weight:900;white-space:nowrap;pointer-events:none;z-index:3;'
          node.node.appendChild(bet)
        }
        const chipHalf = layout.chipSize / 2
        const stackX = seatLayout.box.w / 2 - dx, stackY = seatLayout.box.h / 2 - dy
        let left: number, top: number, transform: string
        if (seatLayout.betBadgeBelow) {
          // Под основата на купчинката (встрани е баджът на съседното място).
          left = stackX
          top = stackY + chipHalf + BET_BADGE_GAP_PX
          transform = 'translate(-50%,0)'
        } else if (Math.abs(dy) >= Math.abs(dx)) {
          // Купчинката е над/под аватара: баджът над най-горния възможен чип.
          left = stackX
          top = stackY - (MAX_STACK_CHIPS - 1) * layout.chipStep - chipHalf - BET_BADGE_GAP_PX
          transform = 'translate(-50%,-100%)'
        } else {
          const outward = dx > 0 ? -1 : 1
          left = stackX + outward * (chipHalf + BET_BADGE_GAP_PX)
          top = stackY
          transform = outward < 0 ? 'translate(-100%,-50%)' : 'translate(0,-50%)'
        }
        bet.style.left = `${Math.round(left)}px`
        bet.style.top = `${Math.round(top)}px`
        if (bet.style.transform !== transform) bet.style.transform = transform
        if (bet.textContent !== String(hud.bet)) bet.textContent = String(hud.bet)
      } else bet?.remove()
      if (hudCache.get(sceneSeat) !== hud.infoHtml) {
        hudCache.set(sceneSeat, hud.infoHtml)
        // Летящите „+N“ (WAAPI) оцеляват при обновяване на информацията.
        const flashes = [...node.info.querySelectorAll<HTMLElement>('[data-svara-bet-flash]')]
        node.info.innerHTML = hud.infoHtml
        const mount = node.info.querySelector('[data-svara-seat-flash-mount]')
        for (const flash of flashes) mount?.appendChild(flash)
      }
    }
    for (let i = 0; i < 4; i += 1) {
      if (visible.includes(i)) continue
      const seat = shell.seats[i]!
      for (const key of ['svaraSeatIndex', 'svaraSeatAnchor', 'svaraSceneProfile', 'svaraLocalSeat', 'svaraSeatDim', 'svaraToAct'] as const) delete seat.node.dataset[key]
      if (seat.card) seat.card.innerHTML = ''
      cardCache.delete(i)
      delete seat.avatar.dataset.svaraAvatar
      seat.avatar.style.filter = ''
      seat.node.querySelector('[data-svara-seat-bet]')?.remove()
      seat.node.querySelectorAll('[data-svara-dealer-badge]').forEach((el) => el.remove())
      seat.info.innerHTML = ''
      hudCache.delete(i)
    }
    shell.applyLayout(layout, visible)
    shell.setPot(input.potTotal, false)
    let status = shell.hudLayer.querySelector<HTMLElement>('[data-svara-scene-status]')
    if (!status) {
      status = document.createElement('div')
      status.dataset.svaraSceneStatus = '1'
      status.style.cssText = 'position:absolute;left:0;top:0;transform:translate(-50%,0);pointer-events:none;'
      shell.hudLayer.appendChild(status)
    }
    status.style.left = `${layout.potLabel.x}px`
    status.style.width = `${Math.round(Math.min(320, layout.width * 0.5))}px`
    // Телефон (портрет): под етикета „Банка“ са собствените карти, затова
    // видимото „СВАРА!“ (при изключени анимации) е над купчинките на банката.
    if (layout.isPortrait) {
      status.style.top = `${layout.pot.y - layout.chipSize * 0.9 - 6}px`
      status.style.transform = 'translate(-50%,-100%)'
    } else {
      status.style.top = `${layout.potLabel.y + Math.max(14, layout.chipSize * 0.45)}px`
      status.style.transform = 'translate(-50%,0)'
    }
    if (status.dataset.html !== input.statusHtml) { status.innerHTML = input.statusHtml; status.dataset.html = input.statusHtml }
  }

  /** Семантични маркери за достъпност/проверки: мястото на всяка карта и собствените открити карти. */
  function markScene(): void {
    shell.stage.dataset.svaraPotChips = String(pot.length)
    if (!input) return
    const seatIndexOf = new Map<number, number>(input.snapshot.seats.map((seat) => [sceneSeatOf(seat.seatIndex), seat.seatIndex]))
    const ownRevealed = !!input.snapshot.you.cards
    // Инвариант: никога лице, което текущият snapshot не позволява (напр.
    // „Избор за показване“ вече не носи собствените карти) — обратно на гръб.
    const allowed = svaraSceneVisibleFaces(input.snapshot, input.localProfileId)
    for (const [sceneSeat, hand] of hands) {
      const playerId = input.snapshot.seats.find((seat) => seat.seatIndex === seatIndexOf.get(sceneSeat))?.playerId
      const permitted = (playerId && allowed[playerId]) || []
      if (hand.faces.every((face) => face === null || permitted.includes(face))) continue
      hand.ids.forEach((id) => renderer.setFace(id, null))
      hand.faces = hand.ids.map(() => null)
      hand.revealed = false
      if (layout) setNow(settledHandStates(sceneSeat, hand))
    }
    for (const [sceneSeat, hand] of hands) {
      hand.ids.forEach((id, slot) => {
        const el = shell.spritesHost.querySelector<HTMLElement>(`[data-svara-sprite="${id}"]`)
        if (!el) return
        const seatIndex = String(seatIndexOf.get(sceneSeat) ?? '')
        if (el.dataset.svaraCardSeat !== seatIndex) el.dataset.svaraCardSeat = seatIndex
        el.dataset.svaraCardIndex = String(slot)
        if (sceneSeat === 0 && ownRevealed && hand.revealed) el.dataset.svaraOwnCard = '1'
        else delete el.dataset.svaraOwnCard
      })
    }
  }

  function relayout(target: HTMLElement): boolean {
    const size = stageSize(target)
    const rect = target.getBoundingClientRect()
    const zoom = target.offsetWidth > 0 ? rect.width / target.offsetWidth : 1
    const scale = svaraBelotCardScale(size.width, size.height, zoom)
    const key = `${size.width}x${size.height}@${scale.toFixed(4)}`
    if (key === sizeKey) return false
    sizeKey = key
    cardScale = scale
    layout = computeSvaraSceneLayout(size.width, size.height, {
      ...REAL_LAYOUT_OPTIONS,
      seatCards: { side: svaraBelotCardSize('left', scale), bottom: svaraBelotCardSize('bottom', scale), margin: SVARA_BELOT_CARD_EDGE_MARGIN_PX },
      // Картите като в Белот (оформлението ги прилага само в портрет — телефон).
      belotHands: svaraBelotHandsSpec(scale, scale * zoom),
    })
    shell.applyLayout(layout)
    renderer.setLayout(layout)
    return true
  }

  function clearAll(): void {
    removeOwnPoints()
    clearCompareBadges()
    renderer.cancel()
    remove(renderer.spriteIds())
    states = {}
    hands.clear()
    stacks.clear()
    pot = []
    deckVisible = false
    done.clear()
    busySeats.clear()
    hudCache.clear()
    cardCache.clear()
    pendingBets = []
    pendingLook = false
    for (const timer of timers) window.clearTimeout(timer)
    timers.clear()
    if (reconcileTimer !== null) window.clearTimeout(reconcileTimer)
    reconcileTimer = null
    shell.resetHud()
    previous = null
  }

  shell.seatsLayer.addEventListener('click', (event) => {
    const node = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-svara-scene-seat]') : null
    const playerId = node?.dataset.svaraSceneProfile
    if (!playerId || !input) return
    const player = input.table.players.find((p) => p.playerId === playerId)
    if (player && !player.isBot) options.onOpenProfile?.(playerId)
  })

  return {
    update(target, next) {
      input = next
      if (host !== target || shell.stage.parentElement !== target) {
        host = target
        target.prepend(shell.stage)
        resizeObserver?.disconnect()
        resizeObserver = new ResizeObserver(() => { if (host && input && relayout(host)) { settle(input.snapshot); renderHud() } })
        resizeObserver.observe(target)
      }
      if (!mounted) {
        mounted = true
        layout = computeSvaraSceneLayout(Math.max(240, target.clientWidth), 400, {
          ...REAL_LAYOUT_OPTIONS,
          seatCards: { side: svaraBelotCardSize('left', cardScale), bottom: svaraBelotCardSize('bottom', cardScale), margin: SVARA_BELOT_CARD_EDGE_MARGIN_PX },
        })
        void renderer.mount(shell.spritesHost, [], layout)
        preloadDealSound()
      }
      const resized = relayout(target)
      const snapshot = next.snapshot
      if (matchKey !== snapshot.matchId) { clearAll(); matchKey = snapshot.matchId }
      renderHud()
      // Baseline (refresh/reconnect/нова маса), нов размер или изключени анимации:
      // крайното състояние директно; текущо раздаване/показ — превъртяни.
      const modeChanged = next.animations !== lastAnimations
      lastAnimations = next.animations
      // Изключени анимации: без промяна в snapshot-а няма какво да се прерисува.
      if (previous && !resized && !next.animations && !modeChanged && previous.revision === snapshot.revision) return
      if (!previous || resized || !next.animations) {
        const fresh = !previous
        settle(snapshot)
        if (fresh && next.animations) {
          // Започнато раздаване или показ при свързване: превъртане, без повторение.
          const round = snapshot.round
          if (round && (round.kind === 'ordinary' || round.kind === 'svara') && round.dealing) {
            for (const [sceneSeat, hand] of [...hands]) { remove(hand.ids); hands.delete(sceneSeat) }
            remove(pot.map((chip) => chip.id)); pot = []
            reconcileStacks(false)
            detect({ ...snapshot, round: null, seats: snapshot.seats.map((s) => ({ ...s, folded: false })) }, snapshot)
          } else {
            if (round && (round.kind === 'ordinary' || round.kind === 'svara')) done.add(`deal:${round.roundId}`)
            if (round?.kind === 'showdown-display') done.add(`show:${round.roundId}`)
            if (round?.kind === 'reveal-choice') { done.add(`award:${round.roundId}`); done.add(`reveal:${round.roundId}`) }
            // Текущата стъпка на изплащане продължава от изминалото време
            // (вече изплатените стъпки не се повтарят).
            if (next.resultVisual.payout) detect(snapshot, snapshot)
          }
        } else if (!next.animations) {
          const round = snapshot.round
          if (round && (round.kind === 'ordinary' || round.kind === 'svara')) done.add(`deal:${round.roundId}`)
          if (round?.kind === 'showdown-display') done.add(`show:${round.roundId}`)
          if (round?.kind === 'reveal-choice') { done.add(`award:${round.roundId}`); done.add(`reveal:${round.roundId}`) }
          const pay = next.resultVisual.payout
          if (pay) done.add(`pay:${pay.key}`)
          pendingBets = []
          pendingLook = false
        }
        previous = snapshot
        markScene()
        return
      }
      const timingKey = next.timing ? `${next.timing.matchId}:${next.timing.revision}:${next.timing.deadlines.map((d) => d.kind + d.deadlineAt).join(',')}` : ''
      const timingChanged = timingKey !== previousTimingKey
      previousTimingKey = timingKey
      if (previous.revision !== snapshot.revision || timingChanged || pendingBets.length || pendingLook || next.resultVisual.payout) {
        detect(previous, snapshot)
        previous = snapshot
      }
      reconcileStacks(true)
      markScene()
    },
    onBets(entries) { pendingBets.push(...entries) },
    onLook() { pendingLook = true },
    reset() { clearAll(); matchKey = null; shell.stage.remove(); host = null; resizeObserver?.disconnect(); resizeObserver = null },
    destroy() { clearAll(); resizeObserver?.disconnect(); renderer.destroy(); shell.destroy() },
    debug() { const s = renderer.stats(); return { ...s, pot: pot.length, deck: deckVisible } },
  }
}

export { stateToSampled }
