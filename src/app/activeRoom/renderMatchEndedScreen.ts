import type {
  RoomGameSnapshot,
  RoomSeatSnapshot,
  Seat,
  Team,
} from '../network/createGameServerClient'
import {
  ACTIVE_ROOM_MOBILE_TABLE_BACKGROUND,
  ACTIVE_ROOM_TABLE_BACKGROUND,
  ACTIVE_ROOM_STAGE_HEIGHT,
  ACTIVE_ROOM_STAGE_WIDTH,
  escapeHtml,
} from './activeRoomShared'
import { isPhoneLayoutViewport } from '../../ui/layout/viewportStage'

// Module-level run counter — гарантира, че при бърз повторен render() (напр.
// countdown tick, докато numeric prize animation-ът още тече) само
// НАЙ-НОВИЯТ RAF loop продължава да пише в DOM-а (виж call site-а в
// renderMatchEndedScreen по-долу). И двата loop-а (стар/нов) computират
// elapsed спрямо СЪЩИЯ prizeAnimationStartedAt, значи никога няма видима
// разлика в стойността — това е чисто defense-in-depth срещу дублирано
// scheduling work, не корекция на грешна стойност.
let prizeAnimationRunSeq = 0

type RenderMatchEndedScreenOptions = {
  root: HTMLDivElement
  game: RoomGameSnapshot
  seats: RoomSeatSnapshot[]
  localSeat: Seat
  stageScale: number
  scaledStageWidth: number
  scaledStageHeight: number
  prizeAmount?: number | null
  // Absolute Unix-ms timestamp, зададен ЕДНОКРАТНО от повикващия
  // (createActiveRoomFlowController.ts) при ПЪРВИЯ render на match-ended
  // екрана с награда — НЕ locally computиран performance.now() тук (виж
  // "ROOT CAUSE" коментара по-долу до RAF loop-а: match-ended screen-ът се
  // ПЪЛНО re-render-ва при всеки WebSocket room_snapshot по време на тази
  // фаза — leave/replay vote, bot-takeover, reconnect catch-up и т.н., НЕ
  // самия секунден countdown tick — а стар вариант стартираше НОВ 1500ms
  // цикъл при всеки такъв re-render, което при достатъчно чест/непрекъснат
  // re-render burst може да остави animation-а stuck на междинна/нулева
  // стойност).
  // Deadline-базиран модел (established pattern в проекта — виж Ludo
  // orchestrator turnStartedAt/rollDeadlineAt) — elapsed се смята СПРЯМО
  // този единствен timestamp на всеки render/RAF кадър, никога не се
  // рестартира. null означава "все още няма прогрес" (viewer никога не е
  // видял тази награда) — render-ът тогава инициализира стойността чрез
  // onPrizeAnimationStart callback-а по-долу.
  prizeAnimationStartedAt?: number | null
  onPrizeAnimationStart?: (startedAt: number) => void
  // Authoritative/stable флаг, собственост на повикващия
  // (createActiveRoomFlowController.ts) — виж onPartnerRatingSubmitted
  // по-долу и doc коментара при click handler-a. Same clas bug като prize
  // animation-a: предишната версия disable-ваше бутоните само с DOM
  // mutation след click, без да пази state в controller-а — следващ пълен
  // re-render (room_snapshot от leave/replay vote, bot-takeover, reconnect)
  // пресъздаваше root.innerHTML от нула и връщаше активните бутони,
  // позволявайки повторен submit.
  //
  // Tri-state, НЕ boolean — виж post-fix audit-а за "false-success UI"
  // риска: клик сам по себе си НЕ е server-confirmed success.
  //   'idle'       — активни бутони, потребителят все още не е оценил.
  //   'submitting' — temporary optimistic disable (предотвратява
  //                  double-click докато чакаме server response), показва
  //                  "Изпращане..." — НЕ permanent completed текст.
  //   'submitted'  — server-confirmed success (ИЛИ alreadyRated duplicate
  //                  response) — permanent "Оценката е изпратена".
  partnerRatingStatus?: 'idle' | 'submitting' | 'submitted'
  countdownSeconds: number
  isPrivateTableOrigin?: boolean
  onReturnToLobby: () => void
  onStartNewGame?: () => void
  onSubmitPartnerRating?: (ratingValue: number) => void
  // Извиква се веднага след клик върху rating бутон (преди самия
  // onSubmitPartnerRating fire-and-forget WebSocket send) — повикващият
  // трябва да закачи 'submitting' state тук (виж partnerRatingStatus
  // по-горе), НЕ да разчита DOM mutation-а по-долу да оцелее re-render.
  onPartnerRatingSubmitted?: () => void
  onReplayVote?: () => void
  onLeaveVote?: () => void
}

function getTeamBySeat(seat: Seat): Team {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

function getOpponentTeam(team: Team): Team {
  return team === 'A' ? 'B' : 'A'
}

function getPartnerSeat(seat: Seat): Seat {
  if (seat === 'bottom') return 'top'
  if (seat === 'top') return 'bottom'
  if (seat === 'left') return 'right'
  return 'left'
}

function getTeamScore(
  score: RoomGameSnapshot['score']['match'],
  team: Team,
): number {
  return team === 'A' ? score.teamA : score.teamB
}

// Стабилен, deadline-базиран numeric counting модел (виж
// RenderMatchEndedScreenOptions.prizeAnimationStartedAt doc коментара за
// пълния root cause/rationale). ЕДИН source на truth за duration/easing/
// текстовата формула, споделен между initial HTML render (за да не мигне
// "+0" дори за 1 кадър, ако render-ът се случи late — CASE G/re-render >
// duration) и RAF loop-а по-долу — гарантира, че двете НИКОГА не могат да
// изчислят различна стойност за same elapsed.
const PRIZE_COUNT_DURATION_MS = 1500

function computePrizeDisplayAmount(target: number, elapsedMs: number): number {
  const t = Math.min(Math.max(elapsedMs, 0) / PRIZE_COUNT_DURATION_MS, 1)
  const eased = 1 - Math.pow(1 - t, 3)
  return t >= 1 ? target : Math.round(eased * target)
}

function formatPrizeText(amount: number): string {
  return `+${amount.toLocaleString('bg-BG')}`
}

function getSeatInitial(displayName: string): string {
  const trimmedName = displayName.trim()

  if (!trimmedName) {
    return '?'
  }

  return trimmedName.slice(0, 1).toUpperCase()
}

function renderLevelBadge(level: number | null | undefined): string {
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 1) return ''
  return `<div style="position:absolute;right:4px;bottom:4px;min-width:20px;height:20px;border-radius:999px;background:#000000;display:flex;align-items:center;justify-content:center;padding:0 3px;line-height:1;z-index:1;color:#ffffff;font-size:11px;font-weight:700;">${Math.trunc(level)}</div>`
}

const REPLAY_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`
const LEAVE_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`

function renderVoteBadge(hasVotedReplay: boolean, hasVotedLeave: boolean, size = 22, top = 7, right = 7): string {
  if (!hasVotedReplay && !hasVotedLeave) return ''

  const background = hasVotedLeave ? '#ef4444' : '#22c55e'
  const icon = hasVotedLeave ? LEAVE_ICON_SVG : REPLAY_ICON_SVG
  const label = hasVotedLeave ? 'Гласувал за излизане' : 'Гласувал за преиграване'

  return `
    <div
      title="${label}"
      aria-label="${label}"
      style="
        position:absolute;
        top:${top}px;
        right:${right}px;
        width:${size}px;
        height:${size}px;
        border-radius:50%;
        background:${background};
        display:flex;
        align-items:center;
        justify-content:center;
        color:#ffffff;
        z-index:2;
        box-shadow:0 0 0 2px rgba(0,0,0,0.72), 0 6px 14px rgba(0,0,0,0.38);
        pointer-events:none;
      "
    >
      ${icon}
    </div>
  `
}

function renderPlayerTile(seat: RoomSeatSnapshot, hasVotedReplay = false, hasVotedLeave = false): string {
  const displayName = seat.isOccupied ? seat.displayName : 'Свободно място'

  return `
    <div
      style="
        position:relative;
        min-width:0;
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        gap:11px;
        min-height:172px;
        padding:18px 14px 14px;
        border-radius:8px;
        background:rgba(18,18,18,0.92);
        border:1px solid rgba(250,204,21,0.28);
      "
    >
      ${renderVoteBadge(hasVotedReplay, hasVotedLeave)}
      <div
        ${seat.isOccupied ? `data-profile-seat-btn="${seat.seat}" title="Виж профила на ${escapeHtml(displayName)}"` : ''}
        style="position:relative;width:116px;height:116px;flex:0 0 116px;${seat.isOccupied ? 'cursor:pointer;' : ''}"
      >
        <div
          style="
            width:100%;
            height:100%;
            border-radius:8px;
            overflow:hidden;
            background:rgba(10,10,10,0.86);
            border:1px solid rgba(250,204,21,0.22);
            display:flex;
            align-items:center;
            justify-content:center;
            color:#facc15;
            font-size:42px;
            font-weight:900;
          "
        >
          ${
            seat.avatarUrl
              ? `<img
                  src="${escapeHtml(seat.avatarUrl)}"
                  alt="${escapeHtml(displayName)}"
                  draggable="false"
                  style="width:100%;height:100%;object-fit:cover;display:block;"
                />`
              : escapeHtml(getSeatInitial(displayName))
          }
        </div>
        ${renderLevelBadge(seat.level)}
      </div>

      <div style="min-width:0;width:100%;text-align:center;">
        <div
          style="
            color:#f8fafc;
            font-size:15px;
            line-height:1.2;
            font-weight:800;
            white-space:nowrap;
            overflow:hidden;
            text-overflow:ellipsis;
          "
          title="${escapeHtml(displayName)}"
        >
          ${escapeHtml(displayName)}
        </div>
      </div>
    </div>
  `
}

function renderTeamPlayers(
  title: string,
  seats: RoomSeatSnapshot[],
  score: number,
  replayVotes: Seat[],
  leaveVotes: Seat[],
  footer = '',
): string {
  return `
    <div style="min-width:0;">
      <div
        style="
          margin-bottom:10px;
          display:flex;
          align-items:baseline;
          gap:10px;
        "
      >
        <div
          style="
            color:#facc15;
            font-size:30px;
            font-weight:900;
            letter-spacing:0.08em;
            text-transform:uppercase;
          "
        >
          ${escapeHtml(title)}
        </div>
        <div style="color:#f8fafc;font-size:30px;font-weight:900;line-height:1;">
          ${score}
        </div>
      </div>
      <div
        style="
          display:grid;
          grid-template-columns:repeat(2, minmax(0, 1fr));
          gap:10px;
        "
      >
        ${seats.map((s) => renderPlayerTile(s, replayVotes.includes(s.seat), leaveVotes.includes(s.seat))).join('')}
      </div>
      ${footer}
    </div>
  `
}

function renderPartnerRating(
  localSeat: Seat,
  seats: RoomSeatSnapshot[],
  partnerRatingStatus: 'idle' | 'submitting' | 'submitted',
): string {
  const partnerSeat = getPartnerSeat(localSeat)
  const partner = seats.find((seat) => seat.seat === partnerSeat) ?? null

  if (!partner || !partner.isOccupied) {
    return ''
  }

  if (partnerRatingStatus === 'submitted') {
    return `
      <div data-partner-rating-panel="1" style="margin-top:14px;">
        <div style="color:#bef264;font-size:13px;font-weight:900;">Оценката е изпратена.</div>
      </div>
    `
  }

  const isSubmitting = partnerRatingStatus === 'submitting'

  return `
    <div data-partner-rating-panel="1" style="margin-top:14px;">
      <div style="font-size:12px;font-weight:900;color:rgba(226,232,240,0.60);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:9px;">
        ${isSubmitting ? 'Изпращане...' : 'Оцени партньор'}
      </div>
      <div style="display:flex;gap:8px;${isSubmitting ? 'opacity:0.5;' : ''}">
        ${[1, 2, 3, 4, 5, 6]
          .map((rating) => `
            <button
              type="button"
              data-partner-rating-value="${rating}"
              aria-label="Оцени с ${rating}"
              title="${rating}/6"
              ${isSubmitting ? 'disabled' : ''}
              style="
                width:28px;
                height:28px;
                border-radius:50%;
                border:0;
                background:#facc15;
                color:#101010;
                font-size:13px;
                font-weight:900;
                cursor:${isSubmitting ? 'default' : 'pointer'};
                display:flex;
                align-items:center;
                justify-content:center;
                flex-shrink:0;
              "
            >
              ${rating}
            </button>
          `)
          .join('')}
      </div>
    </div>
  `
}

function renderMobilePlayerTile(
  seat: RoomSeatSnapshot,
  hasVotedReplay = false,
  hasVotedLeave = false,
): string {
  const displayName = seat.isOccupied ? seat.displayName : 'Свободно място'

  return `
    <div
      style="
        position:relative;
        min-width:0;
        display:flex;
        align-items:center;
        gap:8px;
        min-height:62px;
        padding:8px;
        border-radius:8px;
        background:rgba(18,18,18,0.94);
        border:1px solid rgba(250,204,21,0.30);
        box-sizing:border-box;
      "
    >
      ${renderVoteBadge(hasVotedReplay, hasVotedLeave, 19, 5, 5)}
      <div
        ${seat.isOccupied ? `data-profile-seat-btn="${seat.seat}" title="Виж профила на ${escapeHtml(displayName)}"` : ''}
        style="position:relative;width:46px;height:46px;flex:0 0 46px;${seat.isOccupied ? 'cursor:pointer;' : ''}"
      >
        <div
          style="
            width:100%;
            height:100%;
            border-radius:7px;
            overflow:hidden;
            background:rgba(10,10,10,0.86);
            border:1px solid rgba(250,204,21,0.24);
            display:flex;
            align-items:center;
            justify-content:center;
            color:#d4a520;
            font-size:22px;
            font-weight:900;
          "
        >
          ${
            seat.avatarUrl
              ? `<img
                  src="${escapeHtml(seat.avatarUrl)}"
                  alt="${escapeHtml(displayName)}"
                  draggable="false"
                  style="width:100%;height:100%;object-fit:cover;display:block;"
                />`
              : escapeHtml(getSeatInitial(displayName))
          }
        </div>
        ${renderLevelBadge(seat.level)}
      </div>
      <div style="min-width:0;display:flex;flex-direction:column;gap:3px;">
        <div
          style="
            color:#f8fafc;
            font-size:13px;
            line-height:1.15;
            font-weight:900;
            white-space:nowrap;
            overflow:hidden;
            text-overflow:ellipsis;
          "
          title="${escapeHtml(displayName)}"
        >
          ${escapeHtml(displayName)}
        </div>
        <div style="color:rgba(226,232,240,0.56);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;">
          ${escapeHtml(getTeamBySeat(seat.seat) === 'A' ? 'Отбор A' : 'Отбор B')}
        </div>
      </div>
    </div>
  `
}

function renderMobilePartnerRating(
  localSeat: Seat,
  seats: RoomSeatSnapshot[],
  partnerRatingStatus: 'idle' | 'submitting' | 'submitted',
): string {
  const partnerSeat = getPartnerSeat(localSeat)
  const partner = seats.find((seat) => seat.seat === partnerSeat) ?? null

  if (!partner || !partner.isOccupied) {
    return ''
  }

  if (partnerRatingStatus === 'submitted') {
    return `
      <div data-partner-rating-panel="1" style="display:grid;gap:8px;">
        <div style="color:#bef264;font-size:13px;font-weight:900;text-align:center;">Оценката е изпратена.</div>
      </div>
    `
  }

  const isSubmitting = partnerRatingStatus === 'submitting'

  return `
    <div data-partner-rating-panel="1" style="display:grid;gap:8px;">
      <div style="font-size:11px;font-weight:900;color:rgba(226,232,240,0.62);text-transform:uppercase;letter-spacing:0.06em;">
        ${isSubmitting ? 'Изпращане...' : 'Оцени партньор'}
      </div>
      <div style="display:flex;gap:7px;justify-content:center;${isSubmitting ? 'opacity:0.5;' : ''}">
        ${[1, 2, 3, 4, 5, 6]
          .map((rating) => `
            <button
              type="button"
              data-partner-rating-value="${rating}"
              aria-label="Оцени с ${rating}"
              title="${rating}/6"
              ${isSubmitting ? 'disabled' : ''}
              style="
                width:30px;
                height:30px;
                border-radius:50%;
                border:0;
                background:#d4a520;
                color:#101010;
                font-size:13px;
                font-weight:900;
                cursor:${isSubmitting ? 'default' : 'pointer'};
                display:flex;
                align-items:center;
                justify-content:center;
                flex-shrink:0;
              "
            >
              ${rating}
            </button>
          `)
          .join('')}
      </div>
    </div>
  `
}

function renderMobileMatchEndedPanel(
  game: RoomGameSnapshot,
  seats: RoomSeatSnapshot[],
  localSeat: Seat,
  prizeAmount: number | null | undefined,
  prizeAnimationStartedAt: number | null,
  renderNow: number,
  partnerRatingStatus: 'idle' | 'submitting' | 'submitted',
  countdownSeconds = 120,
  isPrivateTableOrigin = false,
): string {
  const localTeam = getTeamBySeat(localSeat)
  const opponentTeam = getOpponentTeam(localTeam)
  const matchEnded = game.matchEnded
  const finalScore = matchEnded?.finalScore ?? game.score.match
  const ourScore = getTeamScore(finalScore, localTeam)
  const theirScore = getTeamScore(finalScore, opponentTeam)
  const winnerTeam = matchEnded?.winnerTeam ?? null
  const resultLabel =
    winnerTeam === null
      ? 'КРАЙ НА ИГРАТА'
      : winnerTeam === localTeam
        ? 'ПОБЕДИТЕЛ'
        : 'ГУБЕЩ'
  const resultColor = winnerTeam === null
    ? '#e2e8f0'
    : winnerTeam === localTeam
      ? '#d4a520'
      : '#cbd5e1'
  const replayVotes = game.matchEnded?.replayVotes ?? []
  const leaveVotes = game.matchEnded?.leaveVotes ?? []
  const sortedSeats = seats.slice().sort((a, b) => {
    const order: Record<Seat, number> = { bottom: 0, top: 1, left: 2, right: 3 }
    return order[a.seat] - order[b.seat]
  })

  return `
    <section
      style="
        width:min(100%, 390px);
        border-radius:10px;
        background:linear-gradient(180deg, rgba(22,22,22,0.98) 0%, rgba(8,8,8,0.99) 100%);
        border:2px solid rgba(212,165,32,0.88);
        box-shadow:0 18px 52px rgba(2,6,23,0.46);
        color:#f8fafc;
        overflow:hidden;
      "
    >
      <div style="padding:14px;display:grid;gap:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div
            style="
              color:${resultColor};
              font-size:24px;
              line-height:1;
              font-weight:900;
              letter-spacing:0.03em;
              white-space:nowrap;
            "
          >
            ${resultLabel}
          </div>
          ${winnerTeam === localTeam && prizeAmount && prizeAmount > 0 ? `<div data-prize-counter="1" style="color:#22c55e;font-size:20px;font-weight:900;white-space:nowrap;">${formatPrizeText(computePrizeDisplayAmount(prizeAmount, prizeAnimationStartedAt === null ? 0 : renderNow - prizeAnimationStartedAt))}</div>` : ''}
        </div>

        <div
          style="
            display:grid;
            grid-template-columns:1fr 1fr;
            gap:8px;
          "
        >
          <div style="border:1px solid rgba(212,165,32,0.34);border-radius:8px;padding:8px 10px;background:rgba(10,10,10,0.76);">
            <div style="color:rgba(226,232,240,0.62);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.08em;">Ние</div>
            <div style="color:#f8fafc;font-size:28px;line-height:1;font-weight:900;">${ourScore}</div>
          </div>
          <div style="border:1px solid rgba(212,165,32,0.34);border-radius:8px;padding:8px 10px;background:rgba(10,10,10,0.76);">
            <div style="color:rgba(226,232,240,0.62);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.08em;">Вие</div>
            <div style="color:#f8fafc;font-size:28px;line-height:1;font-weight:900;">${theirScore}</div>
          </div>
        </div>

        <div
          style="
            display:grid;
            grid-template-columns:repeat(2, minmax(0, 1fr));
            gap:8px;
          "
        >
          ${sortedSeats.map((s) => renderMobilePlayerTile(s, replayVotes.includes(s.seat), leaveVotes.includes(s.seat))).join('')}
        </div>

        ${renderMobilePartnerRating(localSeat, seats, partnerRatingStatus)}

        <div style="display:grid;gap:8px;">
          <button
            type="button"
            data-match-ended-lobby-button="1"
            style="
              height:40px;
              border:1px solid rgba(212,165,32,0.58);
              border-radius:8px;
              padding:0 14px;
              background:rgba(10,10,10,0.78);
              color:#f8fafc;
              font-family:Inter, system-ui, sans-serif;
              font-size:14px;
              font-weight:900;
              cursor:pointer;
            "
          >
            Към лобито
          </button>
          <div style="display:grid;grid-template-columns:${isPrivateTableOrigin ? '1fr' : '1fr 1fr'};gap:8px;">
            <button
              type="button"
              data-match-ended-replay-button="1"
              style="
                height:40px;
                border:1px solid rgba(212,165,32,0.58);
                border-radius:8px;
                padding:0 10px;
                background:rgba(10,10,10,0.78);
                color:#f8fafc;
                font-family:Inter, system-ui, sans-serif;
                font-size:13px;
                font-weight:900;
                cursor:pointer;
                display:flex;
                align-items:center;
                justify-content:center;
                gap:6px;
              "
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
              Преиграй
            </button>
            ${isPrivateTableOrigin ? '' : `
            <button
              type="button"
              data-match-ended-new-game-button="1"
              style="
                height:40px;
                border:0;
                border-radius:8px;
                padding:0 10px;
                background:linear-gradient(180deg, #f6d36b 0%, #c98b1a 100%);
                color:#101010;
                font-family:Inter, system-ui, sans-serif;
                font-size:13px;
                font-weight:900;
                cursor:pointer;
              "
            >
              Нова игра
            </button>
            `}
          </div>
        </div>

        <div style="display:flex;justify-content:flex-end;">
          <div
            data-match-ended-countdown="1"
            style="
              font-size:11px;
              font-weight:900;
              color:${countdownSeconds <= 30 ? '#f87171' : 'rgba(226,232,240,0.44)'};
              font-variant-numeric:tabular-nums;
            "
          >${countdownSeconds}с</div>
        </div>
      </div>
    </section>
  `
}

function renderMatchEndedPanel(
  game: RoomGameSnapshot,
  seats: RoomSeatSnapshot[],
  localSeat: Seat,
  prizeAmount: number | null | undefined,
  prizeAnimationStartedAt: number | null,
  renderNow: number,
  partnerRatingStatus: 'idle' | 'submitting' | 'submitted',
  _onReplayVote?: () => void,
  countdownSeconds = 120,
  isPrivateTableOrigin = false,
): string {
  const localTeam = getTeamBySeat(localSeat)
  const opponentTeam = getOpponentTeam(localTeam)
  const matchEnded = game.matchEnded
  const finalScore = matchEnded?.finalScore ?? game.score.match
  const ourScore = getTeamScore(finalScore, localTeam)
  const theirScore = getTeamScore(finalScore, opponentTeam)
  const winnerTeam = matchEnded?.winnerTeam ?? null
  const resultLabel =
    winnerTeam === null
      ? 'КРАЙ НА ИГРАТА'
      : winnerTeam === localTeam
        ? 'ПОБЕДИТЕЛ'
        : 'ГУБЕЩ'
  const resultColor = winnerTeam === null
    ? '#e2e8f0'
    : winnerTeam === localTeam
      ? '#facc15'
      : '#cbd5e1'
  const ourSeats = seats.filter((seat) => getTeamBySeat(seat.seat) === localTeam)
  const theirSeats = seats.filter((seat) => getTeamBySeat(seat.seat) === opponentTeam)
  const replayVotes = game.matchEnded?.replayVotes ?? []
  const leaveVotes = game.matchEnded?.leaveVotes ?? []

  return `
    <section
      style="
        width:min(940px, calc(100vw - 44px));
        border-radius:14px;
        background:linear-gradient(180deg, rgba(22,22,22,0.98) 0%, rgba(8,8,8,0.99) 100%);
        border:3px solid rgba(250,204,21,0.82);
        box-shadow:0 30px 80px rgba(2,6,23,0.42);
        color:#f8fafc;
        overflow:hidden;
      "
    >
      <div style="padding:26px 32px 30px;">
        <div
          style="
            display:flex;
            align-items:center;
            justify-content:center;
            margin-bottom:16px;
            text-align:center;
          "
        >
          <div
            style="
              color:${resultColor};
              font-size:36px;
              line-height:1.08;
              font-weight:900;
              letter-spacing:0.04em;
            "
          >
            ${resultLabel}${winnerTeam === localTeam && prizeAmount && prizeAmount > 0 ? `<span data-prize-counter="1" style="margin-left:16px;color:#22c55e;">${formatPrizeText(computePrizeDisplayAmount(prizeAmount, prizeAnimationStartedAt === null ? 0 : renderNow - prizeAnimationStartedAt))}</span>` : ''}
          </div>
        </div>
        <div style="height:2px;background:linear-gradient(90deg, transparent 0%, #facc15 30%, #facc15 70%, transparent 100%);margin-bottom:20px;border-radius:1px;"></div>

        <div
          style="
            display:grid;
            grid-template-columns:minmax(0,1fr) 2px minmax(0,1fr);
            column-gap:18px;
            align-items:stretch;
          "
        >
          ${renderTeamPlayers('Ние', ourSeats, ourScore, replayVotes, leaveVotes, renderPartnerRating(localSeat, seats, partnerRatingStatus))}
          <div style="background:linear-gradient(180deg,transparent 0%,#facc15 25%,#facc15 75%,transparent 100%);border-radius:1px;"></div>
          ${renderTeamPlayers('Вие', theirSeats, theirScore, replayVotes, leaveVotes)}
        </div>

        <div
          style="
            margin-top:24px;
            display:flex;
            align-items:center;
            justify-content:center;
            gap:12px;
            flex-wrap:wrap;
          "
        >
          <button
            type="button"
            data-match-ended-lobby-button="1"
            style="
              height:52px;
              min-width:168px;
              border:1px solid rgba(250,204,21,0.58);
              border-radius:8px;
              padding:0 22px;
              background:rgba(10,10,10,0.78);
              color:#f8fafc;
              font-family:Inter, system-ui, sans-serif;
              font-size:16px;
              font-weight:900;
              cursor:pointer;
              box-shadow:0 16px 34px rgba(0,0,0,0.18);
            "
          >
            Към лобито
          </button>

          <button
            type="button"
            data-match-ended-replay-button="1"
            style="
              height:52px;
              min-width:168px;
              border:1px solid rgba(250,204,21,0.58);
              border-radius:8px;
              padding:0 22px;
              background:rgba(10,10,10,0.78);
              color:#f8fafc;
              font-family:Inter, system-ui, sans-serif;
              font-size:16px;
              font-weight:900;
              cursor:pointer;
              box-shadow:0 16px 34px rgba(0,0,0,0.18);
              display:flex;
              align-items:center;
              justify-content:center;
              gap:8px;
            "
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            Преиграй
          </button>

          ${isPrivateTableOrigin ? '' : `
          <button
            type="button"
            data-match-ended-new-game-button="1"
            style="
              height:52px;
              min-width:168px;
              border:0;
              border-radius:8px;
              padding:0 22px;
              background:linear-gradient(180deg, #facc15 0%, #eab308 100%);
              color:#101010;
              font-family:Inter, system-ui, sans-serif;
              font-size:16px;
              font-weight:900;
              cursor:pointer;
              box-shadow:0 16px 34px rgba(0,0,0,0.26);
            "
          >
            Нова игра
          </button>
          `}
        </div>

        <div style="display:flex;justify-content:flex-end;margin-top:14px;">
          <div
            data-match-ended-countdown="1"
            style="
              font-size:13px;
              font-weight:900;
              color:${countdownSeconds <= 30 ? '#f87171' : 'rgba(226,232,240,0.44)'};
              font-variant-numeric:tabular-nums;
            "
          >${countdownSeconds}с</div>
        </div>
      </div>
    </section>
  `
}

export function renderMatchEndedScreen(options: RenderMatchEndedScreenOptions): void {
  const {
    root,
    game,
    seats,
    localSeat,
    stageScale,
    scaledStageWidth,
    scaledStageHeight,
    prizeAmount,
    prizeAnimationStartedAt: prizeAnimationStartedAtOption = null,
    onPrizeAnimationStart,
    partnerRatingStatus = 'idle',
    countdownSeconds,
    isPrivateTableOrigin = false,
    onReturnToLobby,
    onStartNewGame,
    onSubmitPartnerRating,
    onPartnerRatingSubmitted,
    onReplayVote,
    onLeaveVote,
  } = options
  const renderNow = Date.now()
  // Инициализира се ЕДНОКРАТНО, при първия render с реална награда — виж
  // doc коментара на prizeAnimationStartedAt по-горе. Ако повикващият вече
  // подава timestamp (следващ re-render на СЪЩИЯ match-ended екран), той се
  // ползва directно — elapsed никога не се пресмята спрямо нов "now",
  // прекъсвайки/рестартирайки прогреса.
  let prizeAnimationStartedAt = prizeAnimationStartedAtOption
  if (prizeAnimationStartedAt === null && prizeAmount && prizeAmount > 0) {
    prizeAnimationStartedAt = renderNow
    onPrizeAnimationStart?.(prizeAnimationStartedAt)
  }
  const isPhoneLayout = isPhoneLayoutViewport()
  const mobileLayoutAttribute = isPhoneLayout ? 'data-mobile-layout="1"' : ''
  const tableBackground = isPhoneLayout
    ? ACTIVE_ROOM_MOBILE_TABLE_BACKGROUND
    : ACTIVE_ROOM_TABLE_BACKGROUND

  if (isPhoneLayout) {
    root.innerHTML = `
      <div
        data-mobile-layout="1"
        style="
          position:relative;
          min-height:100dvh;
          width:100%;
          box-sizing:border-box;
          display:flex;
          align-items:center;
          justify-content:center;
          overflow-y:auto;
          overflow-x:hidden;
          padding:14px;
          background:${tableBackground};
          font-family:Inter, system-ui, sans-serif;
        "
      >
        ${renderMobileMatchEndedPanel(game, seats, localSeat, prizeAmount, prizeAnimationStartedAt, renderNow, partnerRatingStatus, countdownSeconds, isPrivateTableOrigin)}
      </div>
    `
  } else {
  root.innerHTML = `
    <div
      ${mobileLayoutAttribute}
      style="
        position:relative;
        min-height:100vh;
        width:100%;
        box-sizing:border-box;
        display:flex;
        align-items:center;
        justify-content:center;
        overflow:hidden;
        background:${tableBackground};
        font-family:Inter, system-ui, sans-serif;
      "
    >
      <div
        style="
          position:relative;
          width:${scaledStageWidth}px;
          height:${scaledStageHeight}px;
          flex:0 0 auto;
        "
      >
        <div
          style="
            position:absolute;
            left:50%;
            top:50%;
            width:${ACTIVE_ROOM_STAGE_WIDTH}px;
            height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
            transform:translate(-50%, -50%) scale(${stageScale});
            transform-origin:center center;
          "
        >
          <div
            style="
              position:absolute;
              inset:0;
              display:flex;
              align-items:center;
              justify-content:center;
              padding:42px 24px;
              box-sizing:border-box;
            "
          >
            ${renderMatchEndedPanel(game, seats, localSeat, prizeAmount, prizeAnimationStartedAt, renderNow, partnerRatingStatus, onReplayVote, countdownSeconds, isPrivateTableOrigin)}
          </div>
        </div>
      </div>
    </div>
  `
  }

  // Numeric counting animation (запазена — виж task-а: "красиво броене е
  // желан визуален ефект"), но с DEADLINE-базиран lifecycle (виж
  // prizeAnimationStartedAt doc коментара по-горе), не time-since-render.
  // ROOT CAUSE на предишния bug (верифициран чрез code audit +
  // контролиран repro, не предположение): match-ended екранът се
  // re-render-ва пълноценно (renderMatchEndedScreen(), не само countdown
  // patch-а от syncMatchEndedCountdownDisplay) при всеки WebSocket
  // room_snapshot push, обработен от applyRoomSnapshotToActiveRoom() ->
  // scheduleActiveRoomRender() (createActiveRoomFlowController.ts) — leave
  // vote от партньор, replay vote, bot-takeover при disconnect, reconnect
  // catch-up и др., НЕ секундния countdown tick. Старият вариант
  // стартираше НОВА 1500ms RAF последователност от performance.now() при
  // ВСЕКИ такъв re-render, докато стария RAF handle продължаваше да
  // тиктака towards detached DOM (без видим ефект). Контролиран repro
  // показа, че единичен/спорадичен re-render в прозореца само забавя, но
  // не трайно заклещва стойността — последният стартиран loop сам
  // довършва до target-а. Реално доказан "може да остане перманентно на
  // междинна/нулева стойност" сценарий изисква НЕПРЕКЪСНАТ re-render
  // burst, по-чест от 1500ms, БЕЗ прекъсване (напр. патологичен snapshot
  // poток) — рядък, но възможен ръб на предишната архитектура и напълно
  // отстранен тук, тъй като elapsed вече не зависи от render момента.
  // Тук loop-ът computира elapsed СПРЯМО единствения prizeAnimationStartedAt
  // (никога нов "now"), и на всеки кадър RE-QUERY-ва DOM-а
  // (root.querySelector), за да продължи да пише в текущия (може би
  // сменен от re-render) DOM node, вместо да държи stale reference. Ако
  // elapsed вече >= duration (late render/re-render след прозореца — CASE
  // G), computePrizeDisplayAmount връща directno target-а — само 1 кадър се
  // изпълнява.
  if (prizeAmount && prizeAmount > 0 && prizeAnimationStartedAt !== null) {
    const target = prizeAmount
    const startedAt = prizeAnimationStartedAt
    const initialElapsed = renderNow - startedAt
    if (initialElapsed < PRIZE_COUNT_DURATION_MS) {
      const runId = ++prizeAnimationRunSeq
      const tick = (): void => {
        // Ако друг render() вече е стартирал по-нов run (нов prize/нов
        // screen lifecycle), тази loop спира — по дизайн само ЕДИН активен
        // run обновява DOM-а per prize lifecycle. Reuse-ването на same
        // startedAt между re-render-и (виж controller-а) означава, че
        // нормалните countdown re-render-и НЕ arm-ват нов run (elapsed вече
        // напреднал towards >= duration или identical startedAt не тригерва
        // нова инициализация тук отделно) — runId guard-ът е защита само
        // срещу истински НОВ prize lifecycle, започнал по средата.
        if (runId !== prizeAnimationRunSeq) return
        const el = root.querySelector<HTMLElement>('[data-prize-counter="1"]')
        if (!el) return
        const elapsed = Date.now() - startedAt
        const amount = computePrizeDisplayAmount(target, elapsed)
        el.textContent = formatPrizeText(amount)
        if (elapsed < PRIZE_COUNT_DURATION_MS) {
          requestAnimationFrame(tick)
        } else {
          // Explicit final snap (виж task-а т.4: "не разчитай само на
          // rounded intermediate calculation") — computePrizeDisplayAmount
          // вече връща exact target при elapsed>=duration, но презаписваме
          // изрично тук за защита срещу бъдещи промени във формулата.
          el.textContent = formatPrizeText(target)
        }
      }
      requestAnimationFrame(tick)
    }
  }

  root
    .querySelector<HTMLButtonElement>('[data-match-ended-lobby-button="1"]')
    ?.addEventListener('click', () => {
      onLeaveVote?.()
      onReturnToLobby()
    })

  root
    .querySelector<HTMLButtonElement>('[data-match-ended-replay-button="1"]')
    ?.addEventListener('click', onReplayVote ?? onStartNewGame ?? onReturnToLobby)

  root
    .querySelector<HTMLButtonElement>('[data-match-ended-new-game-button="1"]')
    ?.addEventListener('click', () => {
      onLeaveVote?.()
      ;(onStartNewGame ?? onReturnToLobby)()
    })

  if (partnerRatingStatus === 'idle') {
    root
      .querySelectorAll<HTMLButtonElement>('[data-partner-rating-value]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          const ratingValue = Number(button.dataset.partnerRatingValue)

          if (!Number.isInteger(ratingValue)) {
            return
          }

          // Веднага disable-ваме тукущите бутони (instant feedback преди
          // повикващият да е стигнал до следващия си re-render), НО
          // authoritative-ят "submitted" state живее в повикващия (виж
          // partnerRatingStatus doc коментара по-горе) и се задава ЕДИНСТВЕНО
          // след server-confirmed response — onPartnerRatingSubmitted тук
          // закача само временно 'submitting', за да не се върнат активните
          // бутони при следващ пълен re-render (root cause на предишния bug:
          // DOM-only disable без controller-level state), И за да не се
          // предполага success преди server-ът реално да го потвърди
          // (false-success UI риска — виж audit-а).
          root
            .querySelectorAll<HTMLButtonElement>('[data-partner-rating-value]')
            .forEach((ratingButton) => {
              ratingButton.disabled = true
              ratingButton.style.cursor = 'default'
              ratingButton.style.opacity = ratingButton === button ? '1' : '0.45'
            })

          onPartnerRatingSubmitted?.()
          onSubmitPartnerRating?.(ratingValue)
        })
      })
  }
}
