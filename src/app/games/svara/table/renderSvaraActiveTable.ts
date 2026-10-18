// Свара — визуално оформление на реалната игрова маса (Етап 2Б.3.7.3).
// Чиста render функция: вход е САМО вече получения server snapshot/timing,
// никаква локална игрова логика. Използва съществуващите визуални ресурси
// на демото (карти/аватари, виж svaraTableAssets.ts) в нов, мобилен-first
// layout — не пресъздава демо сценария/анимациите (тези остават 2Б.3.7.5+).
//
// Видимост на картите (задание §6): чужди карти винаги с гръб, освен
// изричен публичен reveal-choice показ за конкретния победител; собствените
// непогледнати карти също с гръб; собствените погледнати/разкрити карти —
// с лице, само за локалния играч.

import type {
  SvaraDeadlineInfo,
  SvaraMatchSnapshotMessage,
  SvaraMatchTimingMessage,
  SvaraPublicTable,
  SvaraSeatStatus,
  SvaraSnapshotRound,
  SvaraSnapshotSeat,
} from '../../../network/createGameServerClient'
import { assignSvaraVisualSlots, type SvaraVisualSlot } from './svaraSeatLayout'
import { computeSvaraRingState, SVARA_DEADLINE_LABEL, SVARA_DEADLINE_TOTAL_MS } from './svaraCountdown'
import { svaraCardCodeToFaceSrc, SVARA_CARD_BACK_SRC, svaraPlaceholderAvatarSrc, svaraPlaceholderName } from './svaraTableAssets'
import { deriveSvaraActionButtons, type SvaraActionButton } from './svaraBettingActions'
import { formatSvaraLastBetBadge, getLastSvaraBetBadge } from './svaraBettingBadges'
import { svaraDealingAnimationMs, type SvaraDealingVisualState } from './svaraTableAnimation'
import { sampleSvaraMove, type SvaraMove, type SvaraSpriteState } from '../demo/svaraDemoMotion'

/** Анимацията на летящ чип/карта спрямо вече избран доброволен отказ (задание §11). */
export type SvaraActiveFoldEffect = { seatIndex: number; voluntary: boolean; elapsedMs: number }
/** Задание §9/§10 — активно обръщане на собствените карти (ръчно или автоматично). */
export type SvaraActiveLookEffect = { elapsedMs: number }

const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)

const STATUS_BADGE_LABEL: Partial<Record<SvaraSeatStatus, string>> = {
  absent: 'ОТСЪСТВАЩ',
  eliminated: 'ОТПАДНАЛ',
}

export type RenderSvaraActiveTableInput = {
  table: SvaraPublicTable
  snapshot: SvaraMatchSnapshotMessage | null
  timing: SvaraMatchTimingMessage | null
  localProfileId: string
  serverNow: number
  isFullscreen: boolean
  fullscreenSupported: boolean
  leavePending: boolean
  /** Задание §15 — докато чака отговор на изпратена команда, никакъв бутон не е активен. */
  actionPending: boolean
  /** 2Б.3.7.5 §3/§4/§5 — прогрес на Входа/картите спрямо абсолютния dealing дедлайн; вече изчислен от контролера. */
  dealingVisual: SvaraDealingVisualState
  /** 2Б.3.7.5 §11/§13 — активни балончета/изчезващи карти при отказ (voluntary/forced), по seatIndex. */
  activeFoldEffects: readonly SvaraActiveFoldEffect[]
  /** 2Б.3.7.5 §9/§10 — активно обръщане на собствените карти (само за локалния играч). */
  activeLookEffect: SvaraActiveLookEffect | null
  /** Задание §15 — prefers-reduced-motion: без летящи спрайтове/флип завъртане, но СЪЩИЯТ сървърен timeline. */
  reducedMotion: boolean
}

const PANEL_WIDTH_VW_BY_SLOT: Record<SvaraVisualSlot, { base: number; min: number; max: number }> = {
  bottom: { base: 42, min: 150, max: 272 },
  top: { base: 30, min: 96, max: 192 },
  left: { base: 26, min: 82, max: 168 },
  right: { base: 26, min: 82, max: 168 },
}

// 2Б.3.7.5 §3/§4 — приблизителни позиции (в % от филца) на всеки слот и на
// банката, за летящите чипове/карти. Изчислени геометрично (не чрез DOM
// измерване, виж решението в коментара на svaraTableAnimation.ts) — не са
// пиксел-точни до реалния аватар, но достатъчно близки за визуален полет;
// самата финална статична позиция (аватар/карти) остава чистото CSS Grid от
// 2Б.3.7.3, непипнато. Center = банката/тестето.
const SLOT_PERCENT_POSITION: Record<SvaraVisualSlot | 'center', { x: number; y: number }> = {
  bottom: { x: 50, y: 84 },
  top: { x: 50, y: 16 },
  left: { x: 14, y: 50 },
  right: { x: 86, y: 50 },
  center: { x: 50, y: 50 },
}

/** Общата видима продължителност на fold балончето — контролерът спира да подава ефекта след това (виж createSvaraLobbyController.ts). */
export const SVARA_FOLD_BUBBLE_TOTAL_MS = 1800
const FOLD_BUBBLE_TOTAL_MS = SVARA_FOLD_BUBBLE_TOTAL_MS
const FOLD_CARD_FADE_MS = 280
const LOOK_FLIP_CARD_STAGGER_MS = 120
const LOOK_FLIP_CARD_DURATION_MS = 420
/** Общата продължителност на look-flip анимацията — контролерът спира да подава ефекта след това. */
export const SVARA_LOOK_FLIP_TOTAL_MS = 2 * LOOK_FLIP_CARD_STAGGER_MS + LOOK_FLIP_CARD_DURATION_MS

function spriteState(x: number, y: number, extra: Partial<SvaraSpriteState> = {}): SvaraSpriteState {
  return { x, y, rotation: 0, scale: 1, alpha: 1, z: 0, faceUp: true, ...extra }
}

/** Летящ чип от едно място към банката (Входа) — задание §3. */
function renderFlyingChip(seatIndex: number, slot: SvaraVisualSlot, progress: number): string {
  const from = spriteState(SLOT_PERCENT_POSITION[slot].x, SLOT_PERCENT_POSITION[slot].y, { scale: 0.9 })
  const to = spriteState(SLOT_PERCENT_POSITION.center.x, SLOT_PERCENT_POSITION.center.y, { scale: 0.7, alpha: 0.95 })
  const move: SvaraMove = { id: `chip-${seatIndex}`, from, to, delayMs: 0, durationMs: 1, easing: 'outCubic', rotationEasing: 'linear', curve: 0.06, lift: 0.3, liftPeak: 0.4, raisePx: 0, spinDeg: 60, bounce: 0 }
  const sampled = sampleSvaraMove(move, progress)
  return `<div style="position:absolute;left:${sampled.x}%;top:${sampled.y}%;width:clamp(10px,3.2vw,16px);height:clamp(10px,3.2vw,16px);transform:translate(-50%,-50%) scale(${sampled.scaleX.toFixed(3)});opacity:${sampled.alpha.toFixed(2)};border-radius:50%;background:radial-gradient(circle,#f6d27a 0 45%,#c98f13 55% 70%,transparent 75%);box-shadow:0 2px 5px rgba(0,0,0,.6);pointer-events:none;z-index:6;"></div>`
}

/** Летяща карта от тестето (центъра) към конкретно място — задание §4. */
function renderFlyingCard(slot: SvaraVisualSlot, progress: number, cardSizeClampPx: string): string {
  const from = spriteState(SLOT_PERCENT_POSITION.center.x, SLOT_PERCENT_POSITION.center.y, { scale: 0.85, faceUp: false })
  const to = spriteState(SLOT_PERCENT_POSITION[slot].x, SLOT_PERCENT_POSITION[slot].y, { scale: 1, faceUp: false })
  const move: SvaraMove = { id: 'deal-card', from, to, delayMs: 0, durationMs: 1, easing: 'outQuart', rotationEasing: 'outBackSoft', curve: 0.1, lift: 0.35, liftPeak: 0.35, raisePx: 6, spinDeg: 20, bounce: 0.12 }
  const sampled = sampleSvaraMove(move, progress)
  return `<img src="${SVARA_CARD_BACK_SRC}" alt="" draggable="false" style="position:absolute;left:${sampled.x}%;top:${sampled.y}%;width:${cardSizeClampPx};height:auto;aspect-ratio:300/420;border-radius:8%/6%;box-shadow:0 3px 8px rgba(0,0,0,.6);transform:translate(-50%,-50%) rotate(${sampled.rotation.toFixed(1)}deg) scale(${sampled.scaleX.toFixed(3)});opacity:${sampled.alpha.toFixed(2)};pointer-events:none;z-index:6;" />`
}

// Grid вместо ръчно absolute позициониране — гарантира ЛИПСА на застъпване
// по конструкция (top/bottom редовете се сгъват до съдържанието си, left/
// right колоните също; средният ред/колона поглъща остатъка), вместо
// hand-tuned проценти, които трябваше емпирично да се пипат за всеки
// viewport (виж заданието §18 — проверено на 320×568 реално в браузър).
function slotAnchorStyle(slot: SvaraVisualSlot, widthClamp: string): string {
  return `box-sizing:border-box;width:${widthClamp};grid-area:${slot};justify-self:center;align-self:center;`
}

function cardBackHtml(sizeClampPx: string, index: number, dim: boolean): string {
  const overlap = index === 0 ? '' : `margin-left:-${Math.round(parseInt(sizeClampPx.match(/\d+/)?.[0] ?? '28', 10) * 0.42)}px;`
  return `<img src="${SVARA_CARD_BACK_SRC}" alt="" draggable="false" style="width:${sizeClampPx};height:auto;aspect-ratio:300/420;border-radius:8%/6%;box-shadow:0 2px 6px rgba(0,0,0,.5);${overlap}${dim ? 'opacity:.45;filter:grayscale(.3);' : ''}" />`
}

function cardFaceHtml(src: string, sizeClampPx: string, index: number): string {
  const overlap = index === 0 ? '' : `margin-left:-${Math.round(parseInt(sizeClampPx.match(/\d+/)?.[0] ?? '28', 10) * 0.42)}px;`
  return `<img src="${src}" alt="" draggable="false" style="width:${sizeClampPx};height:auto;aspect-ratio:300/420;border-radius:8%/6%;box-shadow:0 2px 6px rgba(0,0,0,.6);${overlap}" />`
}

function ringSvg(fraction: number, isDanger: boolean, isActive: boolean): string {
  if (!isActive) return ''
  const circumference = 2 * Math.PI * 18
  const offset = circumference * (1 - Math.min(1, Math.max(0, fraction)))
  const color = isDanger ? '#ef4444' : '#f4c95b'
  return `<svg viewBox="0 0 40 40" data-svara-turn-ring="1" style="position:absolute;inset:-5px;width:calc(100% + 10px);height:calc(100% + 10px);transform:rotate(-90deg);pointer-events:none;">
    <circle cx="20" cy="20" r="18" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="3" />
    <circle cx="20" cy="20" r="18" fill="none" stroke="${color}" stroke-width="3" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" stroke-linecap="round" style="transition:stroke-dashoffset .2s linear,stroke .2s;" />
  </svg>`
}

/** Задание §11 — трите карти леко се повдигат и избледняват (~280ms), после изчезват изцяло. Винаги гръб (никога истински стойности, виж коментара в svaraTableAnimation.ts/svaraFoldAnimationTracker.ts). */
function foldingCardsHtml(cardSizeClampPx: string, elapsedMs: number, reducedMotion: boolean): string {
  if (elapsedMs >= FOLD_CARD_FADE_MS) return ''
  const t = reducedMotion ? 1 : Math.min(1, elapsedMs / FOLD_CARD_FADE_MS)
  const liftPx = reducedMotion ? 0 : Math.round(14 * t)
  const opacity = (1 - t).toFixed(2)
  return `<span style="display:inline-flex;transform:translateY(-${liftPx}px);opacity:${opacity};transition:none;">${Array.from({ length: 3 }, (_, i) => cardBackHtml(cardSizeClampPx, i, false)).join('')}</span>`
}

/** Задание §9/§10 — последователно обръщане на собствените карти, леко уголемяване, разтваряне във ветрило. */
function lookFlipCardsHtml(ownCards: string[], cardSizeClampPx: string, elapsedMs: number, reducedMotion: boolean): string {
  const cardsHtml = ownCards.map((code, i) => {
    const src = svaraCardCodeToFaceSrc(code)
    const startMs = i * LOOK_FLIP_CARD_STAGGER_MS
    const t = reducedMotion ? 1 : Math.min(1, Math.max(0, (elapsedMs - startMs) / LOOK_FLIP_CARD_DURATION_MS))
    // Средата на завъртането (t=.5) е моментът на смяна на лицето — same illusion as svaraDemoMotion's flip handling.
    const faceUp = t >= 0.5
    const flipScaleX = Math.max(0.05, Math.abs(Math.cos(Math.PI * t)))
    const bulge = 1 + 0.18 * Math.sin(Math.PI * t)
    const front = faceUp && src ? cardFaceHtml(src, cardSizeClampPx, i) : cardBackHtml(cardSizeClampPx, i, false)
    return `<span style="display:inline-block;transform:scale(${bulge.toFixed(3)}) scaleX(${flipScaleX.toFixed(3)});">${front}</span>`
  }).join('')
  return `<span data-svara-own-cards="1" data-svara-look-flip="1" style="display:inline-flex;">${cardsHtml}</span>`
}

function seatCardsHtml(
  seat: SvaraSnapshotSeat,
  isLocal: boolean,
  ownCards: string[] | null,
  publicReveal: { winnerId: string; cards: string[] } | null,
  cardSizeClampPx: string,
  landedCardCount: number | null,
  lookEffect: SvaraActiveLookEffect | null,
  foldEffect: SvaraActiveFoldEffect | null,
  reducedMotion: boolean,
): string {
  // Задание §11/§14 — активно избледняване при отказ има приоритет пред
  // всичко друго: веднъж отказал, нито собствените, нито чуждите карти се
  // показват повече (сървърният cardCount вече е 0 в същия snapshot, виж
  // коментара в svaraTableAnimation.ts) — тук само завършваме визуално
  // прехода, без реални стойности.
  if (foldEffect) return foldingCardsHtml(cardSizeClampPx, foldEffect.elapsedMs, reducedMotion)
  // Задание §3/§4 — по време на активната dealing фаза всички карти (вкл.
  // собствените) са само гръб, прогресивно по броя вече "кацнали"; look
  // изобщо не е възможен по време на дилинга (сървърно отказано), затова
  // ownCards/lookEffect не се проверяват тук.
  if (landedCardCount !== null) {
    if (landedCardCount <= 0) return ''
    return Array.from({ length: landedCardCount }, (_, i) => cardBackHtml(cardSizeClampPx, i, false)).join('')
  }
  if (isLocal && ownCards) {
    if (lookEffect) return lookFlipCardsHtml(ownCards, cardSizeClampPx, lookEffect.elapsedMs, reducedMotion)
    const cardsHtml = ownCards.map((code, i) => {
      const src = svaraCardCodeToFaceSrc(code)
      return src ? cardFaceHtml(src, cardSizeClampPx, i) : cardBackHtml(cardSizeClampPx, i, false)
    }).join('')
    return `<span data-svara-own-cards="1" style="display:inline-flex;">${cardsHtml}</span>`
  }
  if (publicReveal && publicReveal.winnerId === seat.playerId) {
    return publicReveal.cards.map((code, i) => {
      const src = svaraCardCodeToFaceSrc(code)
      return src ? cardFaceHtml(src, cardSizeClampPx, i) : cardBackHtml(cardSizeClampPx, i, false)
    }).join('')
  }
  if (seat.cardCount <= 0) return ''
  const dim = seat.folded || seat.status !== 'active'
  return Array.from({ length: seat.cardCount }, (_, i) => cardBackHtml(cardSizeClampPx, i, dim)).join('')
}

function seatStatusBadges(seat: SvaraSnapshotSeat, isLocal: boolean, youReturnPending: boolean, lastBetLabel: string | null): string {
  const badges: string[] = []
  // Постоянен бадж за последния залог (задание §11.А) — отделен от
  // статусните баджове по смисъл, но визуално в СЪЩИЯ компактен ред; остава
  // до следващото раздаване (виж svaraBettingBadges.ts doc коментара).
  if (lastBetLabel) badges.push(lastBetLabel)
  if (seat.folded) badges.push('ОТКАЗАЛ СЕ')
  if (seat.allIn) badges.push('ОЛ-ИН')
  const statusLabel = STATUS_BADGE_LABEL[seat.status]
  if (statusLabel) badges.push(statusLabel)
  if (isLocal && youReturnPending) badges.push('ВРЪЩА СЕ')
  if (badges.length === 0) return ''
  return `<div data-svara-seat-badges="1" style="display:flex;flex-wrap:wrap;justify-content:center;gap:3px;margin-top:3px;">${badges.map((b) => `<span style="font-size:clamp(8px,2.1vw,10px);font-weight:800;letter-spacing:.02em;padding:1px 5px;border-radius:999px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.18);color:#f4c95b;white-space:nowrap;">${esc(b)}</span>`).join('')}</div>`
}

/** Задание §11/§13 — "Бягам!" (доброволен) / "Времето изтече!" (принудителен) балонче над аватара. */
function foldSpeechBubbleHtml(effect: SvaraActiveFoldEffect, reducedMotion: boolean): string {
  const label = effect.voluntary ? 'Бягам!' : 'Времето изтече!'
  const fadeInMs = 150
  const fadeOutStartMs = FOLD_BUBBLE_TOTAL_MS - 250
  const opacity = reducedMotion
    ? (effect.elapsedMs < FOLD_BUBBLE_TOTAL_MS ? 1 : 0)
    : effect.elapsedMs < fadeInMs
      ? (effect.elapsedMs / fadeInMs).toFixed(2)
      : effect.elapsedMs > fadeOutStartMs
        ? Math.max(0, 1 - (effect.elapsedMs - fadeOutStartMs) / 250).toFixed(2)
        : '1'
  return `<div data-svara-fold-bubble="${effect.voluntary ? 'voluntary' : 'forced'}" style="position:absolute;left:50%;top:-6px;transform:translate(-50%,-100%);white-space:nowrap;background:rgba(10,10,10,.92);border:1px solid rgba(244,201,91,.5);border-radius:999px;padding:3px 10px;font-size:clamp(9px,2.4vw,12px);font-weight:800;color:#f4c95b;opacity:${opacity};pointer-events:none;z-index:9;box-shadow:0 2px 6px rgba(0,0,0,.6);">${esc(label)}</div>`
}

function seatPanelHtml(
  seat: SvaraSnapshotSeat,
  slot: SvaraVisualSlot,
  input: RenderSvaraActiveTableInput,
  turnDeadline: SvaraDeadlineInfo | undefined,
  publicReveal: { winnerId: string; cards: string[] } | null,
  round: SvaraSnapshotRound | null,
): string {
  const isLocal = seat.playerId === input.localProfileId
  const sizes = PANEL_WIDTH_VW_BY_SLOT[slot]
  const widthClamp = `clamp(${sizes.min}px, ${sizes.base}vw, ${sizes.max}px)`
  // min(Xvw,Ydvh) вместо чист vw — в landscape (широко, НИСКО) viewport-ите
  // чистият vw дава твърде големи панели спрямо оскъдната височина (виж
  // заданието §18, 844×390 реална проверка); dvh член-ът поема управлението
  // точно когато височината е по-ограничаваща от ширината.
  const avatarClamp = isLocal || slot === 'bottom' ? 'clamp(32px,min(13vw,11dvh),76px)' : 'clamp(24px,min(10vw,8dvh),58px)'
  const cardClamp = isLocal || slot === 'bottom' ? 'clamp(28px,min(12vw,10dvh),68px)' : 'clamp(18px,min(7.4vw,6dvh),42px)'
  const ownCards = isLocal ? input.snapshot?.you.cards ?? null : null
  const youReturnPending = isLocal ? (input.snapshot?.you.returnPending ?? false) : false
  const lastBet = getLastSvaraBetBadge(round, seat.playerId)
  const foldEffect = input.activeFoldEffects.find((e) => e.seatIndex === seat.seatIndex) ?? null
  const lookEffect = isLocal ? input.activeLookEffect : null
  const landedCardCount = input.dealingVisual.active ? input.dealingVisual.landedCardCountBySeatIndex.get(seat.seatIndex) ?? 0 : null

  let ring = ''
  if (seat.isToAct && turnDeadline) {
    const total = SVARA_DEADLINE_TOTAL_MS.turn
    const state = computeSvaraRingState(turnDeadline.deadlineAt, total, input.serverNow)
    ring = ringSvg(state.fraction, state.isDanger, true)
  }

  return `<div data-svara-seat-anchor="${slot}" data-svara-seat-index="${seat.seatIndex}" style="${slotAnchorStyle(slot, widthClamp)}z-index:${slot === 'bottom' ? 3 : 2};">
    <div data-svara-seat-flash-mount="1" style="position:relative;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:2px;padding:3px 6px 4px;border-radius:12px;background:${seat.isToAct ? 'rgba(244,201,91,.12)' : 'rgba(5,5,5,.72)'};border:1px solid ${seat.isToAct ? 'rgba(244,201,91,.6)' : 'rgba(255,255,255,.14)'};backdrop-filter:blur(2px);">
      ${foldEffect ? foldSpeechBubbleHtml(foldEffect, input.reducedMotion) : ''}
      <div style="position:relative;width:${avatarClamp};height:${avatarClamp};">
        ${ring}
        <img src="${svaraPlaceholderAvatarSrc(seat.playerId)}" alt="" draggable="false" style="width:100%;height:100%;border-radius:50%;object-fit:cover;border:2px solid ${seat.isDealer ? '#f4c95b' : 'rgba(255,255,255,.25)'};box-sizing:border-box;" />
        ${seat.isDealer ? `<span data-svara-dealer-badge="1" title="Дилър" style="position:absolute;right:-2px;bottom:-2px;width:16px;height:16px;border-radius:50%;background:#d4a520;color:#1a1200;font-size:9px;font-weight:900;display:flex;align-items:center;justify-content:center;border:2px solid #090909;">Д</span>` : ''}
      </div>
      <div style="font-size:clamp(9px,2.6vw,13px);font-weight:800;color:#fff;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;line-height:1.15;">${esc(svaraPlaceholderName(seat.playerId))}${isLocal ? ' (ти)' : ''}</div>
      <div data-svara-seat-total="1" style="font-size:clamp(8px,2.3vw,11px);color:#f4c95b;font-weight:700;line-height:1.15;" title="Общо внесени в това раздаване (вкл. Вход)">${seat.stack}${seat.roundContribution > 0 ? ` · общо ${seat.roundContribution}` : ''}</div>
      <div style="display:flex;justify-content:center;">${seatCardsHtml(seat, isLocal, ownCards, publicReveal, cardClamp, landedCardCount, lookEffect, foldEffect, input.reducedMotion)}</div>
      ${seatStatusBadges(seat, isLocal, youReturnPending, lastBet ? formatSvaraLastBetBadge(lastBet) : null)}
    </div>
  </div>`
}

function deadlineStatusText(timing: SvaraMatchTimingMessage | null, serverNow: number, round: SvaraSnapshotRound | null): string {
  const entry = timing?.deadlines.find((d) => d.kind !== 'turn')
  if (!entry) return ''
  // 2Б.3.7.5 — заменя provisional SVARA_DEADLINE_TOTAL_MS.dealing (5000ms
  // placeholder) с реалната продължителност по действителния брой участници
  // в раздаването (виж свariaDealingAnimationMs в svaraTableAnimation.ts),
  // точно коментара в svaraCountdown.ts, който го предвиждаше.
  const totalMs = entry.kind === 'dealing' && round && (round.kind === 'ordinary' || round.kind === 'svara')
    ? svaraDealingAnimationMs(round.participants.length)
    : SVARA_DEADLINE_TOTAL_MS[entry.kind]
  const state = computeSvaraRingState(entry.deadlineAt, totalMs, serverNow)
  return `<div data-svara-other-deadline="1" style="margin-top:4px;font-size:clamp(10px,2.6vw,12px);color:${state.isDanger ? '#ef4444' : 'rgba(255,255,255,.75)'};font-weight:700;">${esc(SVARA_DEADLINE_LABEL[entry.kind])}: ${state.remainingSeconds}с</div>`
}

function feltCenterHtml(input: RenderSvaraActiveTableInput): string {
  const round = input.snapshot?.round ?? null
  const roundLabel = round
    ? round.kind === 'reveal-choice'
      ? round.decision === 'pending' ? 'Избор за показване на карти' : 'Показване на карти'
      : round.kind === 'allin-svara' ? 'Свара с ол-ин'
        : round.kind === 'svara-joining' ? 'Включване в Свара'
          : round.kind === 'svara' ? 'Свара'
            : 'Обикновено раздаване'
    : 'Чакане на следващо раздаване'
  const potTotal = round && 'potTotal' in round ? round.potTotal : null
  const carried = input.snapshot?.carriedTotal ?? 0
  // grid-area:center — централната grid клетка (остатъчното пространство
  // между top/bottom редовете и left/right колоните), никога не се
  // застъпва с тях по конструкция (виж slotAnchorStyle по-горе).
  return `<div data-svara-felt-center="1" style="grid-area:center;justify-self:center;align-self:center;text-align:center;max-width:100%;overflow:hidden;pointer-events:none;padding:0 2px;">
    <div style="font-size:clamp(9px,2.6vw,14px);font-weight:900;color:rgba(255,255,255,.85);text-shadow:0 1px 3px rgba(0,0,0,.8);white-space:nowrap;">${esc(roundLabel)}</div>
    ${potTotal !== null ? `<div style="margin-top:2px;font-size:clamp(11px,3.2vw,17px);font-weight:900;color:#f4c95b;text-shadow:0 1px 3px rgba(0,0,0,.8);">Банка: ${potTotal}</div>` : ''}
    ${carried > 0 ? `<div style="margin-top:1px;font-size:clamp(8px,2.1vw,10px);color:rgba(255,255,255,.6);">+ пренесени ${carried}</div>` : ''}
    ${deadlineStatusText(input.timing, input.serverNow, round)}
  </div>`
}

const ACTION_BUTTON_STYLE: Record<'default' | 'primary' | 'danger', string> = {
  default: 'background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.22);color:#f4c95b;',
  primary: 'background:linear-gradient(135deg,#f6d27a 0%,#d4a520 55%,#c98f13 100%);border:1px solid rgba(244,201,91,.6);color:#1a1200;',
  danger: 'background:rgba(239,68,68,.14);border:1px solid rgba(239,68,68,.55);color:#fca5a5;',
}

function actionButtonVariant(kind: SvaraActionButton['kind']): 'default' | 'primary' | 'danger' {
  if (kind === 'fold') return 'danger'
  if (kind === 'pay' || kind === 'all-in' || kind === 'look') return 'primary'
  return 'default'
}

// Задание §10 — под собствените карти, долу, компактно; НЕ бутон за ръчно
// въвеждане. Всеки бутон вече носи готовата сървърна команда (виж
// deriveSvaraActionButtons) — тук само се рендира, wiring-ът е в контролера.
function actionBarHtml(buttons: SvaraActionButton[], actionPending: boolean, showReturn: boolean): string {
  if (buttons.length === 0 && !showReturn) return ''
  const buttonsHtml = buttons.map((b) => `<button
      data-svara-action-button="${b.kind}"
      ${b.disabled || actionPending ? 'disabled' : ''}
      style="min-height:38px;min-width:54px;padding:0 10px;border-radius:9px;font-size:12px;font-weight:800;cursor:pointer;${ACTION_BUTTON_STYLE[actionButtonVariant(b.kind)]}${b.disabled || actionPending ? 'opacity:.4;cursor:not-allowed;' : ''}"
    >${esc(b.label)}</button>`).join('')
  const returnButton = showReturn
    ? `<button data-svara-action-button="request-return" ${actionPending ? 'disabled' : ''} style="min-height:38px;min-width:54px;padding:0 10px;border-radius:9px;font-size:12px;font-weight:800;cursor:pointer;${ACTION_BUTTON_STYLE.default}${actionPending ? 'opacity:.4;cursor:not-allowed;' : ''}">Върни се</button>`
    : ''
  return `<div data-svara-action-bar="1" style="flex:0 0 auto;display:flex;flex-wrap:wrap;justify-content:center;gap:5px;padding:3px 2px 1px;">${buttonsHtml}${returnButton}</div>`
}

export function renderSvaraActiveTable(input: RenderSvaraActiveTableInput): string {
  const { table } = input
  // Defensive matchId consistency guard: snapshot/timing се кешират и
  // replay-ват отделно от table (виж _svaraLastSnapshot в
  // createLobbyFlowController.ts) — ако по някаква причина принадлежат на
  // РАЗЛИЧНА маса (напр. временно разминаване по време на преход между
  // маси), никога не показвай местата/картите им за ТЕКУЩАТА маса.
  const snapshot = input.snapshot && input.snapshot.matchId === table.matchId ? input.snapshot : null
  const timing = input.timing && input.timing.matchId === table.matchId ? input.timing : null
  // Всички долни helper-и четат snapshot/timing от input — подаваме
  // нормализирания (matchId-проверен) вариант навсякъде, не суровия входен
  // обект, иначе guard-ът по-горе би бил заобиколен.
  const safeInput: RenderSvaraActiveTableInput = { ...input, snapshot, timing }
  const seats = snapshot?.seats ?? []
  const localSeatIndex = snapshot?.you.seatIndex ?? null
  const turnDeadline = timing?.deadlines.find((d) => d.kind === 'turn')
  const round = snapshot?.round ?? null
  const publicReveal = round && round.kind === 'reveal-choice' && round.decision === 'revealed' && round.cards
    ? { winnerId: round.winnerId, cards: round.cards }
    : null

  const slotsBySeat = assignSvaraVisualSlots(seats, localSeatIndex, table.capacity)
  const seatsHtml = seats.length > 0
    ? slotsBySeat.map(({ seat, slot }) => seatPanelHtml(seat, slot, safeInput, turnDeadline, publicReveal, round)).join('')
    : `<div style="grid-area:center;justify-self:center;align-self:center;color:rgba(255,255,255,.55);font-size:13px;">Зареждане на масата…</div>`

  // Задание §3/§4/§15 — летящите чипове/карти на Входа/раздаването, НАД
  // статичните места (вижда §5: прогресът вече идва готов от контролера
  // спрямо абсолютния dealing дедлайн — тук само се визуализира). При
  // prefers-reduced-motion не рендираме летящи спрайтове (сървърният
  // timeline/прогресивното разкриване на картите остава непроменено).
  const slotBySeatIndex = new Map(slotsBySeat.map(({ seat, slot }) => [seat.seatIndex, slot]))
  const dealingOverlayHtml = input.reducedMotion ? '' : (() => {
    const { dealingVisual } = safeInput
    if (!dealingVisual.active) return ''
    const parts: string[] = []
    if (dealingVisual.entry) {
      for (const chip of dealingVisual.entry.chips) {
        const slot = slotBySeatIndex.get(chip.seatIndex)
        if (slot) parts.push(renderFlyingChip(chip.seatIndex, slot, chip.progress))
      }
    }
    if (dealingVisual.flyingCard) {
      const slot = slotBySeatIndex.get(dealingVisual.flyingCard.seatIndex)
      const dealCardSize = 'clamp(28px,min(12vw,10dvh),68px)'
      if (slot) parts.push(renderFlyingCard(slot, dealingVisual.flyingCard.progress, dealCardSize))
    }
    return parts.join('')
  })()

  const resultBanner = snapshot?.result.finished
    ? `<div data-svara-result-banner="1" style="position:absolute;left:50%;top:12%;transform:translateX(-50%);max-width:88%;text-align:center;background:rgba(0,0,0,.82);border:1px solid rgba(212,165,32,.6);border-radius:10px;padding:8px 14px;font-size:clamp(11px,3vw,14px);font-weight:800;color:#f4c95b;">${esc(snapshot.result.message ?? 'Мачът приключи.')}</div>`
    : ''

  const fullscreenButton = input.fullscreenSupported
    ? `<button data-svara-fullscreen-toggle="1" title="${input.isFullscreen ? 'Изход от цял екран' : 'Цял екран'}" style="min-height:28px;min-width:28px;border-radius:7px;border:1px solid rgba(255,255,255,.22);background:rgba(0,0,0,.6);color:#f4c95b;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;">${input.isFullscreen ? '⤡' : '⤢'}</button>`
    : ''

  // Задание §9/§10 — реалните разрешени действия ТОЧНО от you.betting (не
  // клиентско преизчисление); "Върни се" е независим от betting.canAct,
  // достъпен докато статусът е 'absent' и все още няма заявен return.
  const actionButtons = deriveSvaraActionButtons(snapshot?.you.betting ?? null, snapshot?.you.looked ?? false)
  const showReturnButton = snapshot?.you.status === 'absent' && snapshot?.you.returnPending === false
  const actionBar = actionBarHtml(actionButtons, input.actionPending, showReturnButton)

  // Контролният бар е ИЗВЪН филца (отделен ред над него) умишлено — и
  // "Обнови"/"Изход", и бутоните на местата (горе/долу/ляво/дясно) се
  // позиционират спрямо пълната ширина на масата; държейки ги в отделни
  // редове елиминираме всякакъв риск от визуално застъпване дори на
  // най-тесните поддържани телефони (320px, виж заданието §18).
  return `<div data-svara-table="1" style="
      box-sizing:border-box;
      width:100%;
      display:flex;
      flex-direction:column;
      gap:4px;
      height:min(66dvh,620px);
      min-height:320px;
      background:#050505;
      border-radius:16px;
      border:2px solid rgba(212,165,32,.4);
      padding:4px;
      touch-action:manipulation;
    ">
    <div style="flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;gap:6px;padding:2px 2px 0;">
      <div style="display:flex;gap:6px;">
        <button data-svara-table-refresh="1" style="min-height:28px;padding:0 9px;border-radius:7px;border:1px solid rgba(255,255,255,.22);background:rgba(0,0,0,.6);color:#f4c95b;font-size:10px;font-weight:700;cursor:pointer;">Обнови</button>
        <button data-svara-table-leave="1" ${input.leavePending ? 'disabled' : ''} style="min-height:28px;padding:0 9px;border-radius:7px;border:1px solid rgba(255,255,255,.22);background:rgba(0,0,0,.6);color:#f4c95b;font-size:10px;font-weight:700;cursor:pointer;${input.leavePending ? 'opacity:.55;cursor:wait;' : ''}">${input.leavePending ? '…' : 'Изход'}</button>
      </div>
      ${fullscreenButton}
    </div>
    <div data-svara-felt="1" style="
        position:relative;
        flex:1 1 auto;
        min-height:0;
        border-radius:12px;
        overflow:hidden;
        background:radial-gradient(ellipse at center,#0c2a16 0%,#071a0e 62%,#040b06 100%);
        display:grid;
        grid-template-columns:minmax(0,auto) minmax(0,1fr) minmax(0,auto);
        grid-template-rows:minmax(0,auto) minmax(0,1fr) minmax(0,auto);
        grid-template-areas:'. top .' 'left center right' '. bottom .';
        padding:4px;
        row-gap:2px;
        column-gap:2px;
      ">
      ${feltCenterHtml(safeInput)}
      ${seatsHtml}
      ${dealingOverlayHtml ? `<div data-svara-dealing-overlay="1" style="position:absolute;inset:0;pointer-events:none;z-index:5;">${dealingOverlayHtml}</div>` : ''}
      ${resultBanner}
      <div data-svara-diagnostics="1" style="position:absolute;left:6px;bottom:6px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:9px;color:rgba(255,255,255,.35);z-index:1;">rev ${snapshot?.revision ?? '—'}</div>
    </div>
    ${actionBar}
  </div>`
}
