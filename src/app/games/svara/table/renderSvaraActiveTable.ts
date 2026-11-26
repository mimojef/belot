// Свара — истинската игрова маса: рамка, контроли и HUD за общата сцена.
//
// Самата маса (сукно, места, аватари, тесте, карти, чипове, банка, банер,
// пръстен, спечелена сума) е ОБЩАТА визуална сцена на демото
// (../scene/, управлявана от svaraRealScene.ts). Тук остават:
//   • горният бар: Изход, цял екран и меню „Настройки“ (Звуци в играта);
//   • домакинът на сцената (data-svara-scene-host) — НЕ се преизгражда;
//   • бутоните за действие, прозорците за решения, банерът при край на мача;
//   • чист HTML на HUD-а за сцената: информация за мястото (баланс, залог,
//     статуси, точки, „Печеля X“) и статус в центъра (етап, банки, срок).
//
// Видимост на картите: рисува ги сцената — лице само ако сървърът го е
// изпратил (собствените след „Погледни“, сравняването, „Покажи“).

import type {
  SvaraMatchSnapshotMessage,
  SvaraMatchTimingMessage,
  SvaraPublicTable,
  SvaraSeatStatus,
  SvaraSnapshotRound,
  SvaraSnapshotSeat,
} from '../../../network/createGameServerClient'
import { computeSvaraRingState, SVARA_DEADLINE_LABEL, SVARA_DEADLINE_TOTAL_MS } from './svaraCountdown'
import { svaraPlaceholderAvatarSrc, svaraPlaceholderName } from './svaraTableAssets'
import { deriveSvaraActionButtons, type SvaraActionButton } from './svaraBettingActions'
import { formatSvaraLastBetBadge, getLastSvaraBetBadge } from './svaraBettingBadges'
import { svaraDealingAnimationMs, type SvaraDealingVisualState } from './svaraTableAnimation'
import { computeSvaraResultVisualState, type SvaraResultVisualState } from './svaraResultAnimation'
import { getSvaraDecisionWindow, renderSvaraDecisionWindow, svaraJoiningStatus, svaraDecisionStructureKey } from './svaraDecisionWindows'
import { renderGameSoundsToggleState } from '../../../activeRoom/renderActiveRoomActionBar'
import { renderSvaraAnteIndicatorHtml } from './svaraAnteIndicator'

/** Активно балонче при отказ (voluntary/forced), по seatIndex. */
export type SvaraActiveFoldEffect = { seatIndex: number; voluntary: boolean; elapsedMs: number; startedAtServerMs?: number }
/** Активно обръщане на собствените карти (самата анимация е в сцената). */
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
  /** Докато чака отговор на изпратена команда, никакъв бутон не е активен. */
  actionPending: boolean
  /** Прогрес на Входа/картите спрямо абсолютния dealing дедлайн (за изключени анимации). */
  dealingVisual: SvaraDealingVisualState
  /** Активни балончета при отказ (voluntary/forced), по seatIndex. */
  activeFoldEffects: readonly SvaraActiveFoldEffect[]
  /** Активно обръщане на собствените карти. */
  activeLookEffect: SvaraActiveLookEffect | null
  /**
   * true = рисуване без игрови анимации (само за тестовите фикстури)
   * (не от системното prefers-reduced-motion — то не ги изключва). Истинската
   * игра винаги подава false: анимациите в Свара са винаги включени.
   */
  reducedMotion: boolean
  /** Internal presentation sample; callers may omit it. */
  resultVisual?: SvaraResultVisualState
  decisionPending?: boolean
  decisionMessage?: string
  /** Отворено ли е менюто „Настройки“ от горния бар. */
  settingsOpen?: boolean
  /** Отворен ли е прозорецът за потвърждение на напускането (иконата за изход). */
  exitConfirmOpen?: boolean
  /** Общата настройка „Звуци в играта“ (gameSoundSettings.ts). */
  gameSoundsEnabled?: boolean
}

/** Общата видима продължителност на fold балончето — контролерът спира да подава ефекта след това. */
export const SVARA_FOLD_BUBBLE_TOTAL_MS = 1800
const FOLD_BUBBLE_TOTAL_MS = SVARA_FOLD_BUBBLE_TOTAL_MS
/** Продължителност на обръщането след „Погледни“ (същото като в демото: 2 × 95 + 460 ms). */
export const SVARA_LOOK_FLIP_TOTAL_MS = 2 * 95 + 460

function safeResultInput(input: RenderSvaraActiveTableInput): RenderSvaraActiveTableInput {
  const snapshot = input.snapshot?.matchId === input.table.matchId ? input.snapshot : null
  const timing = input.timing?.matchId === input.table.matchId ? input.timing : null
  return { ...input, snapshot, timing, resultVisual: computeSvaraResultVisualState(snapshot, timing, input.serverNow) }
}

function playerName(input: RenderSvaraActiveTableInput, playerId: string): string {
  const player = input.table.players.find((p) => p.playerId === playerId)
  return player?.displayName?.trim() || svaraPlaceholderName(playerId)
}

// ── HUD на мястото (над/под аватара в сцената) ─────────────────────────────

export type SvaraSceneSeatHud = {
  seatIndex: number
  playerId: string
  name: string
  avatarSrc: string
  isBot: boolean
  isLocal: boolean
  isDealer: boolean
  isToAct: boolean
  /** Таймерът за хода (в полето с името, както в Белот): оставаща част 0..1; null — не е на ход. */
  turnTimer: { fraction: number; isDanger: boolean; deadlineAt: number } | null
  /** Информацията до аватара: САМО наличният баланс (статусите/точките — за четци на екрана). */
  infoHtml: string
  /** Сумата на текущия залог (вноската в раздаването) — до чиповете; 0 = няма. */
  bet: number
  /** Отпаднал/отсъстващ — аватарът се затъмнява вместо надпис. */
  dim: 'eliminated' | 'absent' | null
  /** Общият бюджет за отсъствие: сървърният момент на изчерпване (MM:SS върху карето), само докато тече. */
  absenceDeadlineAt: number | null
}

/**
 * Наличността на играча — по-голяма и отличима от останалите баджове (син фон,
 * дебел златист бордър, бял текст), за да се разпознава веднага.
 */
const SEAT_TOTAL_STYLE = 'display:inline-block;padding:2px 10px;border-radius:999px;background:linear-gradient(180deg,#2563eb 0%,#1e3a8a 100%);border:2px solid #f5d06f;color:#fff;font-size:14px;font-weight:900;line-height:1.15;text-shadow:0 1px 2px rgba(0,0,0,.6);box-shadow:0 2px 6px rgba(0,0,0,.45);'

/** Визуално скрито, но достъпно за четци на екрана (и за проверките). */
const SR_ONLY = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;'

function seatStatusBadges(seat: SvaraSnapshotSeat, isLocal: boolean, youReturnPending: boolean, lastBetLabel: string | null, joiningStatus: string | null, matchFinished = false): string {
  // Приключил/прекратен мач: статусите „отсъстващ“/„връща се“ вече нямат
  // смисъл (няма следващо раздаване) — показваме само крайния резултат.
  if (matchFinished) return ''
  const badges: string[] = []
  if (joiningStatus) badges.push(joiningStatus)
  // Постоянен бадж за последния залог — до следващото раздаване.
  if (lastBetLabel) badges.push(lastBetLabel)
  if (seat.folded) badges.push('ОТКАЗАЛ СЕ')
  if (seat.allIn) badges.push('ОЛ-ИН')
  const statusLabel = STATUS_BADGE_LABEL[seat.status]
  if (statusLabel) badges.push(statusLabel)
  if (isLocal && youReturnPending) badges.push('ВРЪЩА СЕ')
  if (badges.length === 0) return ''
  return `<div data-svara-seat-badges="1">${badges.map((b) => `<span>${esc(b)} </span>`).join('')}</div>`
}

/** „Бягам!“ (доброволен) / „Времето изтече!“ (принудителен) — стабилен HTML; появата е WAAPI анимация от контролера. */
function foldSpeechBubbleHtml(effect: SvaraActiveFoldEffect, reducedMotion: boolean): string {
  const label = effect.voluntary ? 'Бягам!' : 'Времето изтече!'
  const opacity = reducedMotion && effect.elapsedMs >= FOLD_BUBBLE_TOTAL_MS ? 0 : 1
  void opacity
  return `<span data-svara-fold-bubble="${effect.voluntary ? 'voluntary' : 'forced'}" data-svara-fold-start="${effect.startedAtServerMs ?? ''}">${esc(label)} </span>`
}

function isResultRound(input: RenderSvaraActiveTableInput): boolean {
  const round = input.snapshot?.round
  return round?.kind === 'showdown-display' || (round?.kind === 'reveal-choice' && round.decision === 'revealed')
}

/** HUD на всички места от snapshot-а (ред по seatIndex). */
export function renderSvaraSceneSeatHuds(rawInput: RenderSvaraActiveTableInput): SvaraSceneSeatHud[] {
  const input = safeResultInput(rawInput)
  const snapshot = input.snapshot
  if (!snapshot) return []
  const round = snapshot.round
  const turnDeadline = input.timing?.deadlines.find((d) => d.kind === 'turn')
  const visual = input.resultVisual!
  return snapshot.seats.map((seat) => {
    const isLocal = seat.playerId === input.localProfileId
    // ВРЕМЕННО — тестови ботове: сървърно обозначение от публичната маса (само представяне).
    const player = input.table.players.find((p) => p.playerId === seat.playerId)
    const isBot = player?.isBot === true
    const lastBet = getLastSvaraBetBadge(round, seat.playerId)
    const foldEffect = input.activeFoldEffects.find((e) => e.seatIndex === seat.seatIndex) ?? null
    let turnTimer: SvaraSceneSeatHud['turnTimer'] = null
    if (seat.isToAct && turnDeadline) {
      const state = computeSvaraRingState(turnDeadline.deadlineAt, SVARA_DEADLINE_TOTAL_MS.turn, input.serverNow)
      turnTimer = { fraction: Math.min(1, Math.max(0, state.fraction)), isDanger: state.isDanger, deadlineAt: turnDeadline.deadlineAt }
    }
    const compared = round?.kind === 'showdown-display' && round.comparedPlayers.includes(seat.playerId) && visual.showCards
    const revealedWinner = round?.kind === 'reveal-choice' && round.decision === 'revealed' && round.winnerId === seat.playerId && visual.showCards
    const points = compared ? round.comparisonPoints[seat.playerId] ?? null : revealedWinner ? round.handPoints : null
    const recipient = visual.payout?.recipients.find((entry) => entry.playerId === seat.playerId)
    // Върху сукното: само наличният баланс. Статусите, точките, „Бягам!“ и
    // „Печеля X!“ остават достъпни за четци на екрана, без да се виждат
    // (сцената показва същото графично: прибрани карти, пръстен, „+X“).
    const infoHtml = `<div data-svara-seat-flash-mount="1" style="position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;">
      <span data-svara-seat-total="1" title="Баланс" style="${SEAT_TOTAL_STYLE}">${seat.stack}</span>
      <div data-svara-seat-sr="1" style="${SR_ONLY}">
        ${foldEffect ? foldSpeechBubbleHtml(foldEffect, input.reducedMotion) : ''}
        ${points === null ? '' : `<span data-svara-${compared ? 'showdown' : 'reveal'}-points="1">${points}</span> `}
        ${seatStatusBadges(seat, isLocal, isLocal ? snapshot.you.returnPending : false, lastBet ? formatSvaraLastBetBadge(lastBet) : null, svaraJoiningStatus(round, seat.playerId), snapshot.result.finished)}
        ${recipient ? `<span data-svara-win-bubble="1" data-svara-payout-key="${esc(visual.payout!.key)}">Печеля ${recipient.amount}!</span>` : ''}
      </div>
    </div>`
    const betting = round?.kind === 'ordinary' || round?.kind === 'svara'
    return {
      seatIndex: seat.seatIndex,
      playerId: seat.playerId,
      name: playerName(input, seat.playerId),
      avatarSrc: (isBot ? player?.avatarUrl : null) || player?.avatarUrl || svaraPlaceholderAvatarSrc(seat.playerId),
      isBot,
      isLocal,
      isDealer: seat.isDealer,
      isToAct: seat.isToAct,
      turnTimer,
      infoHtml,
      bet: betting && !snapshot.result.finished ? seat.roundContribution : 0,
      dim: seat.status === 'eliminated' ? 'eliminated' : seat.status === 'absent' && !snapshot.result.finished ? 'absent' : null,
      absenceDeadlineAt: seat.status === 'absent' && !snapshot.result.finished ? seat.absenceDeadlineAt ?? null : null,
    }
  })
}

// ── Статус в центъра (етап, банки, срок) ───────────────────────────────────

function deadlineStatusText(timing: SvaraMatchTimingMessage | null, serverNow: number, round: SvaraSnapshotRound | null): string {
  const entry = timing?.deadlines.find((d) => d.kind !== 'turn')
  if (!entry) return ''
  const totalMs = entry.kind === 'dealing' && round && (round.kind === 'ordinary' || round.kind === 'svara')
    ? svaraDealingAnimationMs(round.participants.length)
    : SVARA_DEADLINE_TOTAL_MS[entry.kind]
  const state = computeSvaraRingState(entry.deadlineAt, totalMs, serverNow)
  return `<div data-svara-other-deadline="1" style="font-size:11px;color:${state.isDanger ? '#fca5a5' : 'rgba(255,255,255,.8)'};font-weight:800;">${esc(SVARA_DEADLINE_LABEL[entry.kind])}: ${state.remainingSeconds}с</div>`
}

/** Основната/страничните/заключените банки и правоимащите — само `eligible` от сървъра. */
function banksBreakdownHtml(input: RenderSvaraActiveTableInput): string {
  const snapshot = input.snapshot
  const round = snapshot?.round ?? null
  const rows: Array<{ label: string; amount: number; eligible: string[] }> = []
  if (round && 'provisionalPots' in round) {
    for (const layer of round.provisionalPots) {
      if (layer.amount <= 0) continue
      rows.push({ label: layer.index === 0 ? 'Основна банка' : `Странична банка ${layer.index}`, amount: layer.amount, eligible: layer.eligible })
    }
  }
  for (const pot of snapshot?.lockedPots ?? []) rows.push({ label: 'Заключена банка (Свара)', amount: pot.amount, eligible: pot.eligible })
  // Една обикновена банка = етикетът „Банка“ до чиповете; разбивка само при
  // странични/заключени банки.
  if (rows.length === 0 || (rows.length === 1 && rows[0]!.label === 'Основна банка')) return ''
  return `<div data-svara-banks-breakdown="1" style="display:flex;flex-direction:column;gap:1px;">
    ${rows.map((row) => `<div style="font-size:10px;line-height:1.2;color:rgba(255,255,255,.82);white-space:normal;">${esc(row.label)}: <b style="color:#f5d06f;">${row.amount}</b> <span style="color:rgba(255,255,255,.55);">(${row.eligible.map((id) => esc(playerName(input, id))).join(', ')})</span></div>`).join('')}
  </div>`
}

function showdownDisplayStatusHtml(round: SvaraSnapshotRound | null, visual: SvaraResultVisualState, _input: { reducedMotion: boolean }): string {
  if (!round || round.kind !== 'showdown-display') return ''
  const phaseLabel = round.displayPhase === 'showdown' ? 'Сравняване на картите' : 'Изплащане на банките'
  const step = visual.payout?.step
  return `<div data-svara-showdown-status="1">
    ${!visual.tie && !step ? `<div style="font-size:11px;font-weight:800;color:#fff;">${esc(phaseLabel)}</div>` : ''}
    ${visual.tie ? '<div data-svara-tie="1" data-svara-tie-sound-slot="awaiting-owner-asset" role="status">СВАРА!</div>' : ''}
    ${step ? `<div data-svara-active-pot="${esc(step.potId)}" data-svara-payout-key="${esc(visual.payout!.key)}" style="display:inline-block;padding:1px 6px;border:1px solid #f4c95b;border-radius:6px;background:#33280dcc;font-size:11px;font-weight:900;color:#ffe49a;">${step.isMain ? 'Основна банка' : 'Странична банка'}: ${step.amount}</div>` : ''}
  </div>`
}

/** Общата сума на всички текущи банки (текущо раздаване + заключени + пренесени + неизплатени стъпки). */
export function svaraScenePotTotal(rawInput: RenderSvaraActiveTableInput): number {
  const input = safeResultInput(rawInput)
  const round = input.snapshot?.round ?? null
  const potTotal = round && 'potTotal' in round ? round.potTotal : 0
  const carried = input.snapshot?.carriedTotal ?? 0
  const lockedTotal = (input.snapshot?.lockedPots ?? []).reduce((sum, pot) => sum + pot.amount, 0)
  const remainingPayoutTotal = input.resultVisual!.remainingSteps.reduce((sum, step) => sum + step.amount, 0)
  return potTotal + lockedTotal + carried + remainingPayoutTotal
}

/** Статусът в центъра на сцената (без общата сума — тя е в етикета „Банка“ до чиповете). */
export function renderSvaraSceneStatusHtml(rawInput: RenderSvaraActiveTableInput): string {
  const input = safeResultInput(rawInput)
  const round = input.snapshot?.round ?? null
  const roundLabel = round
    ? round.kind === 'reveal-choice'
      ? round.decision === 'pending' ? 'Избор за показване на карти' : 'Показване на карти'
      : round.kind === 'showdown-display' ? ''
        : round.kind === 'allin-svara' ? 'Свара с ол-ин'
          : round.kind === 'svara-joining' ? 'Включване в Свара'
            : round.kind === 'svara' ? 'Свара'
              : 'Обикновено раздаване'
    // Приключил мач няма следващо раздаване — резултатът е в банера.
    : input.snapshot?.result.finished ? '' : 'Чакане на следващо раздаване'
  const carried = input.snapshot?.carriedTotal ?? 0
  void input.reducedMotion
  // Върху сукното няма помощни текстове: етапът, банките, сроковете и
  // статусите са само за четци на екрана. Видими са етикетът „Банка“ и —
  // при изключени анимации, когато банерът не се пуска — „СВАРА!“.
  const tieVisible = input.reducedMotion && input.resultVisual!.tie
    ? '<div data-svara-tie-visible="1" style="font-size:22px;font-weight:900;line-height:1.1;color:#ffd66e;text-shadow:0 2px 4px #000,0 0 12px #ef4444;text-align:center;">СВАРА!</div>'
    : ''
  return `${tieVisible}<div data-svara-felt-center="1" style="${SR_ONLY}">
    ${roundLabel ? `<div style="font-size:12px;font-weight:900;color:rgba(255,255,255,.88);">${esc(roundLabel)}</div>` : ''}
    ${carried > 0 ? `<div style="font-size:10px;color:rgba(255,255,255,.7);">+ пренесени ${carried}</div>` : ''}
    ${banksBreakdownHtml(input)}
    ${showdownDisplayStatusHtml(round, input.resultVisual!, input)}
    ${round?.kind === 'reveal-choice' && round.decision === 'pending' && !input.snapshot?.you.revealChoice?.canDecide ? '<div data-svara-reveal-waiting="1" style="font-size:11px;color:#f4c95b;">Изчаква се решение на победителя.</div>' : ''}
    ${deadlineStatusText(input.timing, input.serverNow, round)}
  </div>`
}

/** Обратна съвместимост: прозорците за решения обновяват статуса чрез сцената. */
export function patchSvaraDecisionTable(_root: HTMLElement, _input: RenderSvaraActiveTableInput): void {}

/** Обратна съвместимост: показът на резултата е изцяло в сцената. Връща дали има активен показ. */
export function patchSvaraResultPresentation(_root: HTMLElement, rawInput: RenderSvaraActiveTableInput): boolean {
  return isResultRound(safeResultInput(rawInput))
}

// ── Бутони за действие ──────────────────────────────────────────────────────

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

// ── Постоянен долен панел с бутоните ───────────────────────────────────────
//
// Винаги на мястото си под сукното и с постоянна височина (масата не
// подскача): 8 фиксирани места —
//   Виж | Плати X | ×5 | ×10
//   ×20 | ×50 | Ол-ин | Бягам
// (телефон: 2 реда по 4; desktop: един ред). Недостъпното действие е
// неактивен бутон на същото място. Винаги точно 8 места (телефон: никога
// повече от 4 на ред). „Без залог“ (специалното 4-то раздаване на двама) и
// „Върни се“ заемат мястото на „Виж“, когато то не е нужно. „Без залог“ не
// изключва „Плати“ (там то открива с минимума), затова в единственото
// решение, в което „Без залог“ и „Виж“ са нужни едновременно (преди „Виж“),
// „Без залог“ заема мястото на „×50“.

/** Телефон: ширина на екрана, до която панелът е 2 реда по 4 (виж stageSize в svaraRealScene.ts). */
export const SVARA_ACTION_PANEL_PHONE_MAX_WIDTH_PX = 559
const ACTION_BUTTON_HEIGHT_PX = 40
const ACTION_PANEL_GAP_PX = 6
const ACTION_PANEL_PAD_PX = 6
/** Постоянната височина на панела: телефон (2 реда) и desktop (1 ред). */
export const SVARA_ACTION_PANEL_HEIGHT_PHONE_PX = 2 * ACTION_BUTTON_HEIGHT_PX + ACTION_PANEL_GAP_PX + 2 * ACTION_PANEL_PAD_PX
export const SVARA_ACTION_PANEL_HEIGHT_DESKTOP_PX = ACTION_BUTTON_HEIGHT_PX + 2 * ACTION_PANEL_PAD_PX

const ACTION_SLOTS: ReadonlyArray<{ kind: SvaraActionButton['kind']; label: string }> = [
  { kind: 'look', label: 'Виж' },
  { kind: 'pay', label: 'Плати' },
  { kind: 'x5', label: '×5' },
  { kind: 'x10', label: '×10' },
  { kind: 'x20', label: '×20' },
  { kind: 'x50', label: '×50' },
  { kind: 'all-in', label: 'Ол-ин' },
  { kind: 'fold', label: 'Бягам' },
]

const ACTION_BUTTON_BASE = `box-sizing:border-box;width:100%;height:${ACTION_BUTTON_HEIGHT_PX}px;min-width:0;padding:0 4px;border-radius:9px;font-size:12px;font-weight:800;line-height:1.1;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`
const DISABLED_STYLE = 'opacity:.4;cursor:not-allowed;'

const actionAmountFormatter = new Intl.NumberFormat('bg-BG', { useGrouping: 'always' })

function actionButtonContent(label: string, amount: number | null, kind: SvaraActionButton['kind']): string {
  // „Плати“: винаги на два реда — „Плати“ и цялата сума отдолу (иначе при
  // големи суми се изрязва в тесния бутон, особено на телефон).
  // Първият ред е действието от надписа („Плати“, „Тъмни“ или „Заложи“ — виж svaraBettingActions).
  if (kind === 'pay' && amount !== null) {
    const title = label.startsWith('Тъмни') ? 'Тъмни' : label.startsWith('Заложи') ? 'Заложи' : 'Плати'
    return `${title}<span data-svara-pay-amount="1" style="display:block;">${esc(actionAmountFormatter.format(amount))}</span>`
  }
  // Ол-ин: сумата от сървъра на втори ред (надписът остава „Ол-ин“).
  return kind === 'all-in' && amount !== null
    ? `${esc(label)}<span style="display:block;font-size:10px;font-weight:700;opacity:.85;">${amount}</span>`
    : esc(label)
}

export function renderSvaraActionPanelHtml(buttons: SvaraActionButton[], actionPending: boolean, showReturn: boolean): string {
  const byKind = new Map(buttons.map((b) => [b.kind, b]))
  const real = (b: SvaraActionButton) => {
    const disabled = b.disabled || actionPending
    return `<button type="button" data-svara-action-button="${b.kind}" ${disabled ? 'disabled' : ''} style="${ACTION_BUTTON_BASE}${ACTION_BUTTON_STYLE[actionButtonVariant(b.kind)]}${disabled ? DISABLED_STYLE : ''}">${actionButtonContent(b.label, b.amount, b.kind)}</button>`
  }
  const placeholder = (kind: SvaraActionButton['kind'], label: string) =>
    `<button type="button" data-svara-action-slot="${kind}" disabled aria-disabled="true" style="${ACTION_BUTTON_BASE}${ACTION_BUTTON_STYLE[actionButtonVariant(kind)]}${DISABLED_STYLE}">${esc(label)}</button>`
  const returnButton = `<button type="button" data-svara-action-button="request-return" ${actionPending ? 'disabled' : ''} style="${ACTION_BUTTON_BASE}${ACTION_BUTTON_STYLE.default}${actionPending ? DISABLED_STYLE : ''}">Върни се</button>`
  const noBet = byKind.get('no-bet')
  const noBetSlot = noBet ? (byKind.has('look') ? 'x50' : 'look') : null
  const cells = ACTION_SLOTS.map((slot, i) => {
    if (noBet && slot.kind === noBetSlot) return real(noBet)
    const button = byKind.get(slot.kind)
    if (button) return real(button)
    if (i === 0 && showReturn) return returnButton
    return placeholder(slot.kind, slot.label)
  })
  const phoneColumns = ACTION_SLOTS.length / 2
  return `<div data-svara-action-bar="1" style="flex:0 0 auto;box-sizing:border-box;padding:${ACTION_PANEL_PAD_PX}px;background:#030303;">
    <style data-svara-action-panel-style="1">
      [data-svara-action-bar] { height:${SVARA_ACTION_PANEL_HEIGHT_DESKTOP_PX}px; }
      [data-svara-action-grid] { grid-template-columns:repeat(${cells.length},minmax(0,1fr)); }
      @media (max-width:${SVARA_ACTION_PANEL_PHONE_MAX_WIDTH_PX}px) {
        [data-svara-action-bar] { height:${SVARA_ACTION_PANEL_HEIGHT_PHONE_PX}px; }
        [data-svara-action-grid] { grid-template-columns:repeat(${phoneColumns},minmax(0,1fr)); max-width:none; }
      }
    </style>
    <div data-svara-action-grid="1" style="display:grid;grid-auto-rows:${ACTION_BUTTON_HEIGHT_PX}px;gap:${ACTION_PANEL_GAP_PX}px;max-width:860px;margin:0 auto;">${cells.join('')}</div>
  </div>`
}

// ── Горен бар (в стила на Белот: златни икони без фон и рамка) ─────────────

/** Височина на горния бар; прозорците за решения започват под него. */
export const SVARA_TOP_BAR_HEIGHT_PX = 40
const TOP_ICON_HIT_PX = 40

const TOP_BAR_STYLE = `<style data-svara-top-bar-style="1">
  [data-svara-top-icon] svg { display:block; transition:transform 140ms ease, color 140ms ease, filter 140ms ease; }
  @media (hover:hover) { [data-svara-top-icon]:not(:disabled):hover svg { color:#ffe08a; transform:scale(1.1); } }
  [data-svara-top-icon]:not(:disabled):active svg, [data-svara-top-icon][aria-expanded="true"] svg { color:#ffe08a; transform:scale(0.94); }
  [data-svara-top-icon]:focus-visible svg { filter:drop-shadow(0 0 4px rgba(246,211,107,0.85)); }
</style>`

const TOP_ICON_BUTTON = `width:${TOP_ICON_HIT_PX}px;height:${TOP_ICON_HIT_PX}px;box-sizing:border-box;border:0;outline:0;padding:0;margin:0;display:flex;align-items:center;justify-content:center;background:transparent;box-shadow:none;color:#f6d36b;cursor:pointer;-webkit-tap-highlight-color:transparent;-webkit-appearance:none;appearance:none;`

const svgIcon = (body: string, size = 24) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
// Изход — стрелката сочи наляво (връщане), вратата е вдясно.
const EXIT_ICON = svgIcon('<path d="M15 21h4a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4"></path><polyline points="8 17 3 12 8 7"></polyline><line x1="3" y1="12" x2="15" y2="12"></line>')
// Същата икона като „Настройки“ в Белот (renderActiveRoomActionBar.ts).
const GEAR_ICON = svgIcon('<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>', 22)
const FULLSCREEN_ON_ICON = svgIcon('<polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line>', 20)
const FULLSCREEN_OFF_ICON = svgIcon('<polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line>', 20)

function topBarHtml(input: RenderSvaraActiveTableInput): string {
  const settingsOpen = input.settingsOpen === true
  const fullscreen = input.fullscreenSupported
    ? `<button type="button" data-svara-top-icon="fullscreen" data-svara-fullscreen-toggle="1" title="${input.isFullscreen ? 'Изход от цял екран' : 'Цял екран'}" aria-label="${input.isFullscreen ? 'Изход от цял екран' : 'Цял екран'}" style="${TOP_ICON_BUTTON}">${input.isFullscreen ? FULLSCREEN_OFF_ICON : FULLSCREEN_ON_ICON}</button>`
    : ''
  return `<div data-svara-top-bar="1" style="flex:0 0 auto;height:${SVARA_TOP_BAR_HEIGHT_PX}px;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;padding:0 4px;background:#000;">
    <button type="button" data-svara-top-icon="leave" data-svara-table-leave="1" title="Напусни масата" aria-label="Напусни масата" aria-haspopup="dialog" ${input.leavePending ? 'disabled' : ''} style="${TOP_ICON_BUTTON}${input.leavePending ? 'opacity:.5;cursor:wait;' : ''}">${EXIT_ICON}</button>
    <div style="display:flex;align-items:center;gap:2px;">
      ${fullscreen}
      <button type="button" data-svara-top-icon="settings" data-svara-settings-toggle="1" title="Настройки" aria-label="Настройки" aria-haspopup="dialog" aria-expanded="${settingsOpen}" style="${TOP_ICON_BUTTON}">${GEAR_ICON}</button>
    </div>
    ${TOP_BAR_STYLE}
  </div>`
}

/**
 * Ред в менюто „Настройки“. Менюто се строи от списък, за да могат по-късно
 * да се добавят настройки на гласовия чат (напр. микрофон, звук на гласовете)
 * — само когато наистина работят; засега няма неработещи опции.
 */
type SvaraSettingsRow = { attr: string; label: string; enabled: boolean }

function settingsToggleHtml(row: SvaraSettingsRow): string {
  const toggle = renderGameSoundsToggleState(row.enabled)
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
    <span style="font-size:14px;font-weight:700;line-height:1.3;">${esc(row.label)}</span>
    <button type="button" role="switch" ${row.attr}="1" aria-checked="${row.enabled}" style="flex-shrink:0;min-width:64px;height:34px;padding:0 10px;border-radius:8px;border:2px solid ${toggle.borderColor};background:${toggle.background};color:${toggle.color};font-size:14px;font-weight:900;cursor:pointer;">${toggle.label}</button>
  </div>`
}

/**
 * Потвърждение за напускане (стилът на потвърдителните прозорци в Pika.bg,
 * виж renderLudoExitConfirmPopup.ts); затворено — празен контейнер.
 */
function exitConfirmMountHtml(input: RenderSvaraActiveTableInput): string {
  if (input.exitConfirmOpen !== true) return '<div data-svara-exit-confirm-mount="1"></div>'
  const leaving = input.leavePending
  return `<div data-svara-exit-confirm-mount="1">
    <div data-svara-exit-confirm-backdrop="1" style="position:fixed;inset:0;z-index:70;background:rgba(2,6,23,0.68);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;">
      <div role="dialog" aria-modal="true" aria-labelledby="svara-exit-confirm-title" aria-describedby="svara-exit-confirm-text" data-svara-exit-confirm-dialog="1" style="width:min(390px, 100%);box-sizing:border-box;background:rgba(15,23,42,0.98);border:1px solid rgba(212,165,32,0.4);border-radius:20px;padding:26px 22px 22px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.55);">
        <div id="svara-exit-confirm-title" style="color:#f4f8ff;font-size:18px;font-weight:800;line-height:1.45;">Напускане на масата</div>
        <div id="svara-exit-confirm-text" style="margin-top:12px;color:rgba(248,250,252,0.82);font-size:14px;font-weight:600;line-height:1.5;">Сигурни ли сте, че искате да напуснете масата?</div>
        <div style="display:flex;justify-content:center;gap:10px;margin-top:24px;flex-wrap:wrap;">
          <button type="button" data-svara-exit-cancel="1" ${leaving ? 'disabled' : ''} style="min-width:112px;min-height:42px;padding:10px 20px;border:1px solid rgba(255,255,255,0.18);border-radius:8px;background:#080808;color:#f8fafc;font-size:14px;font-weight:800;cursor:${leaving ? 'default' : 'pointer'};opacity:${leaving ? '0.55' : '1'};">Отказ</button>
          <button type="button" data-svara-exit-confirm="1" ${leaving ? 'disabled' : ''} style="min-width:112px;min-height:42px;padding:10px 20px;border:1px solid rgba(248,113,113,0.7);border-radius:8px;background:rgba(127,29,29,0.88);color:#fee2e2;font-size:14px;font-weight:900;cursor:${leaving ? 'wait' : 'pointer'};opacity:${leaving ? '0.7' : '1'};">${leaving ? 'Напускане...' : 'Напусни'}</button>
        </div>
      </div>
    </div>
  </div>`
}

/** Менюто „Настройки“ (стилът на панела от Белот); затворено — празен контейнер. */
function settingsMountHtml(input: RenderSvaraActiveTableInput): string {
  if (input.settingsOpen !== true) return '<div data-svara-settings-mount="1"></div>'
  const rows: SvaraSettingsRow[] = [
    { attr: 'data-svara-sounds-toggle', label: 'Звуци в играта', enabled: input.gameSoundsEnabled !== false },
  ]
  return `<div data-svara-settings-mount="1">
    <div data-svara-settings-backdrop="1" style="position:fixed;inset:0;z-index:59;background:transparent;"></div>
    <div data-svara-settings-panel="1" role="dialog" aria-label="Настройки" style="position:absolute;top:${SVARA_TOP_BAR_HEIGHT_PX + 4}px;right:6px;z-index:60;width:min(280px, calc(100% - 12px));box-sizing:border-box;padding:12px 14px 14px;background:rgba(15,23,42,0.98);border:1px solid rgba(212,165,32,0.45);border-radius:14px;box-shadow:0 16px 40px rgba(0,0,0,0.55);color:#f4f8ff;font-family:inherit;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-size:16px;font-weight:900;color:#f6d36b;">Настройки</div>
        <button type="button" data-svara-settings-close="1" aria-label="Затвори" style="width:28px;height:28px;border:0;border-radius:8px;background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.75);font-size:18px;font-weight:700;line-height:1;cursor:pointer;">&times;</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">${rows.map(settingsToggleHtml).join('')}</div>
    </div>
  </div>`
}

export function renderSvaraActiveTable(input: RenderSvaraActiveTableInput): string {
  const { table } = input
  // Defensive matchId consistency guard: snapshot/timing се кешират и
  // replay-ват отделно от table — ако принадлежат на РАЗЛИЧНА маса, никога
  // не ги показвай за ТЕКУЩАТА маса.
  const snapshot = input.snapshot && input.snapshot.matchId === table.matchId ? input.snapshot : null
  const timing = input.timing && input.timing.matchId === table.matchId ? input.timing : null

  // Приключил/прекратен мач: банерът е в центъра, над сцената, с ясен „Изход“.
  const resultBanner = snapshot?.result.finished
    ? `<div data-svara-result-banner="1" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:30;width:max-content;max-width:80%;text-align:center;background:rgba(0,0,0,.88);border:1px solid rgba(212,165,32,.6);border-radius:10px;padding:10px 14px;font-size:clamp(11px,3vw,14px);font-weight:800;color:#f4c95b;">
        <div>${esc(snapshot.result.message ?? 'Мачът приключи.')}</div>
        <button data-svara-result-exit="1" ${input.leavePending ? 'disabled' : ''} style="margin-top:8px;min-height:34px;padding:0 18px;border-radius:8px;border:1px solid rgba(244,201,91,.6);background:#d4a520;color:#1a1200;font-size:13px;font-weight:900;cursor:pointer;${input.leavePending ? 'opacity:.55;cursor:wait;' : ''}">${input.leavePending ? 'Излизане…' : 'Изход'}</button>
      </div>`
    : ''

  // Реалните разрешени действия ТОЧНО от you.betting; „Върни се“ е независим
  // от betting.canAct, докато статусът е 'absent' и няма заявен return.
  const actionButtons = deriveSvaraActionButtons(snapshot?.you.betting ?? null, snapshot?.you.looked ?? false, snapshot?.table.entryChips)
  // Приключил мач: няма към какво да се върнеш — само „Изход“.
  const showReturnButton = snapshot?.result.finished !== true && snapshot?.you.status === 'absent' && snapshot?.you.returnPending === false
  const actionBar = renderSvaraActionPanelHtml(actionButtons, input.actionPending, showReturnButton)
  const decisionWindow = getSvaraDecisionWindow(snapshot, timing, input.serverNow, input.localProfileId)
  const decisionPending = input.decisionPending ?? input.actionPending
  const decisionMessage = input.decisionMessage ?? ''

  // Без рамка: компактен горен бар и зелено сукно през цялата ширина (като
  // масата в Белот); под сукното остава мястото за бутоните за действие.
  return `<div data-svara-table="1" style="position:relative;box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:0;background:#030303;touch-action:manipulation;">
    ${topBarHtml(input)}
    <div data-svara-felt="1" data-svara-scene-host="1" style="position:relative;flex:0 0 auto;min-height:240px;">
      ${renderSvaraAnteIndicatorHtml(snapshot, input.serverNow)}
      ${resultBanner}
      <div data-svara-diagnostics="1" style="${SR_ONLY}">rev ${snapshot?.revision ?? '—'}</div>
    </div>
    ${actionBar}
    <div data-svara-decision-mount="1" data-structure-key="${esc(svaraDecisionStructureKey(decisionWindow, decisionPending, decisionMessage))}" style="position:absolute;inset:${SVARA_TOP_BAR_HEIGHT_PX + 2}px 6px 6px;display:grid;place-items:center;pointer-events:none;z-index:40;">${renderSvaraDecisionWindow(decisionWindow, decisionPending, decisionMessage)}</div>
    ${settingsMountHtml(input)}
    ${exitConfirmMountHtml(input)}
  </div>`
}
