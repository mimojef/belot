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
  SvaraSnapshotSeat,
} from '../../../network/createGameServerClient'
import { assignSvaraVisualSlots, type SvaraVisualSlot } from './svaraSeatLayout'
import { computeSvaraRingState, SVARA_DEADLINE_LABEL, SVARA_DEADLINE_TOTAL_MS } from './svaraCountdown'
import { svaraCardCodeToFaceSrc, SVARA_CARD_BACK_SRC, svaraPlaceholderAvatarSrc, svaraPlaceholderName } from './svaraTableAssets'

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
}

const PANEL_WIDTH_VW_BY_SLOT: Record<SvaraVisualSlot, { base: number; min: number; max: number }> = {
  bottom: { base: 42, min: 150, max: 272 },
  top: { base: 30, min: 96, max: 192 },
  left: { base: 26, min: 82, max: 168 },
  right: { base: 26, min: 82, max: 168 },
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

function seatCardsHtml(
  seat: SvaraSnapshotSeat,
  isLocal: boolean,
  ownCards: string[] | null,
  publicReveal: { winnerId: string; cards: string[] } | null,
  cardSizeClampPx: string,
): string {
  if (isLocal && ownCards) {
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

function seatStatusBadges(seat: SvaraSnapshotSeat, isLocal: boolean, youReturnPending: boolean): string {
  const badges: string[] = []
  if (seat.folded) badges.push('ОТКАЗАЛ СЕ')
  if (seat.allIn) badges.push('ОЛ-ИН')
  const statusLabel = STATUS_BADGE_LABEL[seat.status]
  if (statusLabel) badges.push(statusLabel)
  if (isLocal && youReturnPending) badges.push('ВРЪЩА СЕ')
  if (badges.length === 0) return ''
  return `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;">${badges.map((b) => `<span style="font-size:clamp(8px,2.1vw,10px);font-weight:800;letter-spacing:.02em;padding:1px 5px;border-radius:999px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.18);color:#f4c95b;white-space:nowrap;">${esc(b)}</span>`).join('')}</div>`
}

function seatPanelHtml(
  seat: SvaraSnapshotSeat,
  slot: SvaraVisualSlot,
  input: RenderSvaraActiveTableInput,
  turnDeadline: SvaraDeadlineInfo | undefined,
  publicReveal: { winnerId: string; cards: string[] } | null,
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

  let ring = ''
  if (seat.isToAct && turnDeadline) {
    const total = SVARA_DEADLINE_TOTAL_MS.turn
    const state = computeSvaraRingState(turnDeadline.deadlineAt, total, input.serverNow)
    ring = ringSvg(state.fraction, state.isDanger, true)
  }

  return `<div data-svara-seat-anchor="${slot}" data-svara-seat-index="${seat.seatIndex}" style="${slotAnchorStyle(slot, widthClamp)}z-index:${slot === 'bottom' ? 3 : 2};">
    <div style="box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:2px;padding:3px 6px 4px;border-radius:12px;background:${seat.isToAct ? 'rgba(244,201,91,.12)' : 'rgba(5,5,5,.72)'};border:1px solid ${seat.isToAct ? 'rgba(244,201,91,.6)' : 'rgba(255,255,255,.14)'};backdrop-filter:blur(2px);">
      <div style="position:relative;width:${avatarClamp};height:${avatarClamp};">
        ${ring}
        <img src="${svaraPlaceholderAvatarSrc(seat.playerId)}" alt="" draggable="false" style="width:100%;height:100%;border-radius:50%;object-fit:cover;border:2px solid ${seat.isDealer ? '#f4c95b' : 'rgba(255,255,255,.25)'};box-sizing:border-box;" />
        ${seat.isDealer ? `<span data-svara-dealer-badge="1" title="Дилър" style="position:absolute;right:-2px;bottom:-2px;width:16px;height:16px;border-radius:50%;background:#d4a520;color:#1a1200;font-size:9px;font-weight:900;display:flex;align-items:center;justify-content:center;border:2px solid #090909;">Д</span>` : ''}
      </div>
      <div style="font-size:clamp(9px,2.6vw,13px);font-weight:800;color:#fff;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;line-height:1.15;">${esc(svaraPlaceholderName(seat.playerId))}${isLocal ? ' (ти)' : ''}</div>
      <div style="font-size:clamp(8px,2.3vw,11px);color:#f4c95b;font-weight:700;line-height:1.15;">${seat.stack}${seat.roundContribution > 0 ? ` · залог ${seat.roundContribution}` : ''}</div>
      <div style="display:flex;justify-content:center;">${seatCardsHtml(seat, isLocal, ownCards, publicReveal, cardClamp)}</div>
      ${seatStatusBadges(seat, isLocal, youReturnPending)}
    </div>
  </div>`
}

function deadlineStatusText(timing: SvaraMatchTimingMessage | null, serverNow: number): string {
  const entry = timing?.deadlines.find((d) => d.kind !== 'turn')
  if (!entry) return ''
  const state = computeSvaraRingState(entry.deadlineAt, SVARA_DEADLINE_TOTAL_MS[entry.kind], serverNow)
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
    ${deadlineStatusText(input.timing, input.serverNow)}
  </div>`
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
  const round = snapshot?.round
  const publicReveal = round && round.kind === 'reveal-choice' && round.decision === 'revealed' && round.cards
    ? { winnerId: round.winnerId, cards: round.cards }
    : null

  const seatsHtml = seats.length > 0
    ? assignSvaraVisualSlots(seats, localSeatIndex, table.capacity)
      .map(({ seat, slot }) => seatPanelHtml(seat, slot, safeInput, turnDeadline, publicReveal))
      .join('')
    : `<div style="grid-area:center;justify-self:center;align-self:center;color:rgba(255,255,255,.55);font-size:13px;">Зареждане на масата…</div>`

  const resultBanner = snapshot?.result.finished
    ? `<div data-svara-result-banner="1" style="position:absolute;left:50%;top:12%;transform:translateX(-50%);max-width:88%;text-align:center;background:rgba(0,0,0,.82);border:1px solid rgba(212,165,32,.6);border-radius:10px;padding:8px 14px;font-size:clamp(11px,3vw,14px);font-weight:800;color:#f4c95b;">${esc(snapshot.result.message ?? 'Мачът приключи.')}</div>`
    : ''

  const fullscreenButton = input.fullscreenSupported
    ? `<button data-svara-fullscreen-toggle="1" title="${input.isFullscreen ? 'Изход от цял екран' : 'Цял екран'}" style="min-height:28px;min-width:28px;border-radius:7px;border:1px solid rgba(255,255,255,.22);background:rgba(0,0,0,.6);color:#f4c95b;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;">${input.isFullscreen ? '⤡' : '⤢'}</button>`
    : ''

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
      ${resultBanner}
      <div data-svara-diagnostics="1" style="position:absolute;left:6px;bottom:6px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:9px;color:rgba(255,255,255,.35);z-index:1;">rev ${snapshot?.revision ?? '—'}</div>
    </div>
  </div>`
}
