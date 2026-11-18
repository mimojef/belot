// Свара — истинската игрова маса: рамка, контроли и HUD за общата сцена.
//
// Самата маса (сукно, места, аватари, тесте, карти, чипове, банка, банер,
// пръстен, спечелена сума) е ОБЩАТА визуална сцена на демото
// (../scene/, управлявана от svaraRealScene.ts). Тук остават:
//   • рамката на масата: Обнови / Изход / Анимации / цял екран;
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
   * true = игровите анимации са ИЗКЛЮЧЕНИ от настройката „Анимации“ в Свара
   * (не от системното prefers-reduced-motion — то не ги изключва).
   */
  reducedMotion: boolean
  /** Internal presentation sample; callers may omit it. */
  resultVisual?: SvaraResultVisualState
  decisionPending?: boolean
  decisionMessage?: string
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
  /** Пръстенът на хода (SVG) или ''. */
  turnRingHtml: string
  /** Информацията до аватара: САМО наличният баланс (статусите/точките — за четци на екрана). */
  infoHtml: string
  /** Сумата на текущия залог (вноската в раздаването) — до чиповете; 0 = няма. */
  bet: number
  /** Отпаднал/отсъстващ — аватарът се затъмнява вместо надпис. */
  dim: 'eliminated' | 'absent' | null
}

/** Визуално скрито, но достъпно за четци на екрана (и за проверките). */
const SR_ONLY = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;'

function ringSvg(fraction: number, isDanger: boolean): string {
  const circumference = 2 * Math.PI * 18
  const offset = circumference * (1 - Math.min(1, Math.max(0, fraction)))
  const color = isDanger ? '#ef4444' : '#f4c95b'
  return `<svg viewBox="0 0 40 40" data-svara-turn-ring="1" style="position:absolute;inset:-9px;width:calc(100% + 18px);height:calc(100% + 18px);transform:rotate(-90deg);pointer-events:none;">
    <circle cx="20" cy="20" r="18" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="2.4" />
    <circle cx="20" cy="20" r="18" fill="none" stroke="${color}" stroke-width="2.4" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" stroke-linecap="round" style="transition:stroke-dashoffset .2s linear,stroke .2s;" />
  </svg>`
}

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
    let turnRingHtml = ''
    if (seat.isToAct && turnDeadline) {
      const state = computeSvaraRingState(turnDeadline.deadlineAt, SVARA_DEADLINE_TOTAL_MS.turn, input.serverNow)
      turnRingHtml = ringSvg(state.fraction, state.isDanger)
    }
    const compared = round?.kind === 'showdown-display' && round.comparedPlayers.includes(seat.playerId) && visual.showCards
    const revealedWinner = round?.kind === 'reveal-choice' && round.decision === 'revealed' && round.winnerId === seat.playerId && visual.showCards
    const points = compared ? round.comparisonPoints[seat.playerId] ?? null : revealedWinner ? round.handPoints : null
    const recipient = visual.payout?.recipients.find((entry) => entry.playerId === seat.playerId)
    // Върху сукното: само наличният баланс. Статусите, точките, „Бягам!“ и
    // „Печеля X!“ остават достъпни за четци на екрана, без да се виждат
    // (сцената показва същото графично: прибрани карти, пръстен, „+X“).
    const infoHtml = `<div data-svara-seat-flash-mount="1" style="position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;">
      <span data-svara-seat-total="1" title="Баланс" style="padding:1px 7px;border-radius:999px;background:rgba(0,0,0,.62);color:#f5d06f;font-size:11px;font-weight:900;">${seat.stack}</span>
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
      turnRingHtml,
      infoHtml,
      bet: betting && !snapshot.result.finished ? seat.roundContribution : 0,
      dim: seat.status === 'eliminated' ? 'eliminated' : seat.status === 'absent' && !snapshot.result.finished ? 'absent' : null,
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

// ── Бутони и рамка ──────────────────────────────────────────────────────────

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

const TOP_BUTTON = 'min-height:28px;padding:0 9px;border-radius:7px;border:1px solid rgba(255,255,255,.22);background:rgba(0,0,0,.6);color:#f4c95b;font-size:10px;font-weight:700;cursor:pointer;'

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

  const fullscreenButton = input.fullscreenSupported
    ? `<button data-svara-fullscreen-toggle="1" title="${input.isFullscreen ? 'Изход от цял екран' : 'Цял екран'}" style="min-height:28px;min-width:28px;border-radius:7px;border:1px solid rgba(255,255,255,.22);background:rgba(0,0,0,.6);color:#f4c95b;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;">${input.isFullscreen ? '⤡' : '⤢'}</button>`
    : ''

  // Реалните разрешени действия ТОЧНО от you.betting; „Върни се“ е независим
  // от betting.canAct, докато статусът е 'absent' и няма заявен return.
  const actionButtons = deriveSvaraActionButtons(snapshot?.you.betting ?? null, snapshot?.you.looked ?? false)
  // Приключил мач: няма към какво да се върнеш — само „Изход“.
  const showReturnButton = snapshot?.result.finished !== true && snapshot?.you.status === 'absent' && snapshot?.you.returnPending === false
  const actionBar = actionBarHtml(actionButtons, input.actionPending, showReturnButton)
  const decisionWindow = getSvaraDecisionWindow(snapshot, timing, input.serverNow, input.localProfileId)
  const decisionPending = input.decisionPending ?? input.actionPending
  const decisionMessage = input.decisionMessage ?? ''
  const animationsOn = !input.reducedMotion

  return `<div data-svara-table="1" style="position:relative;box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:4px;background:#050505;border-radius:16px;border:2px solid rgba(212,165,32,.4);padding:4px;touch-action:manipulation;">
    <div style="flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;gap:6px;padding:2px 2px 0;">
      <div style="display:flex;gap:6px;">
        <button data-svara-table-refresh="1" style="${TOP_BUTTON}">Обнови</button>
        <button data-svara-table-leave="1" ${input.leavePending ? 'disabled' : ''} style="${TOP_BUTTON}${input.leavePending ? 'opacity:.55;cursor:wait;' : ''}">${input.leavePending ? '…' : 'Изход'}</button>
        <button data-svara-animations-toggle="1" aria-pressed="${animationsOn}" title="Игрови анимации" style="${TOP_BUTTON}">Анимации: ${animationsOn ? 'вкл.' : 'изкл.'}</button>
      </div>
      ${fullscreenButton}
    </div>
    <div data-svara-felt="1" data-svara-scene-host="1" style="position:relative;flex:0 0 auto;min-height:240px;border-radius:12px;">
      ${resultBanner}
      <div data-svara-diagnostics="1" style="${SR_ONLY}">rev ${snapshot?.revision ?? '—'}</div>
    </div>
    ${actionBar}
    <div data-svara-decision-mount="1" data-structure-key="${esc(svaraDecisionStructureKey(decisionWindow, decisionPending, decisionMessage))}" style="position:absolute;inset:42px 6px 6px;display:grid;place-items:center;pointer-events:none;z-index:40;">${renderSvaraDecisionWindow(decisionWindow, decisionPending, decisionMessage)}</div>
  </div>`
}
