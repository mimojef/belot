import type { TournamentMatchAssignmentSnapshot } from '../../app/network/createGameServerClient.js'

type TournamentMatchStartPopupController = {
  setAssignment: (assignment: TournamentMatchAssignmentSnapshot | null) => void
  /** Изчиства текущия assignment САМО ако сочи точно към roomId — вика се
   * при напускане/приключване на конкретна стая (виж showLobby wiring в
   * main.ts), за да не остане stale countdown/CTA сочещ към вече затворена
   * турнирна стая, без да засяга легитимен по-нов assignment за друг мач. */
  clearAssignmentForRoom: (roomId: string) => void
  tick: () => void
  destroy: () => void
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function formatRemaining(deadlineAt: string | null): string {
  if (deadlineAt === null) return '00:00'
  const remainingMs = new Date(deadlineAt).getTime() - Date.now()
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '00:00'
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

// Показва postоянен извън-игра popup, когато играчът получи turnament_match_assigned
// и в момента НЕ гледа самата турнирна стая (§3/§4 в task spec-а). Два варианта:
//   - "свободен" — играчът не е в друга активна игра, единствен бутон "Влез в турнира".
//   - "конфликт" — играчът в момента е в друга (нетурнирна) активна маса; избор
//     между "Напусни мача и влез в турнира" (authoritative leave + penalty,
//     съществуващият leave flow) или "Остани в текущия мач" (не прекъсва нищо,
//     местото в турнира го поема бот при timeout — countdown-ът продължава
//     независимо от popup-а).
export function createTournamentMatchStartPopup(options: {
  container: HTMLElement
  isInOtherActiveGame: () => { roomId: string; stakeAmount: number } | null
  isViewingAssignedRoom: (roomId: string) => boolean
  onEnterTournamentMatch: (assignment: TournamentMatchAssignmentSnapshot) => void
  onLeaveAndEnterTournamentMatch: (assignment: TournamentMatchAssignmentSnapshot, conflictRoomId: string) => void
}): TournamentMatchStartPopupController {
  let current: TournamentMatchAssignmentSnapshot | null = null
  let minimizedMatchId: string | null = null
  let hadConflictForMatchId: string | null = null

  function render(): void {
    if (current === null || options.isViewingAssignedRoom(current.roomId)) {
      options.container.innerHTML = ''
      return
    }

    const assignment = current
    const conflict = options.isInOtherActiveGame()
    const deadlineText = formatRemaining(assignment.attendanceDeadlineAt)
    const isFirstMatch = assignment.deadlineKind !== 'round_transition'

    // Минимизирано състояние (§3: "не може да бъде окончателно затворен с X,
    // може да бъде минимизиран, но countdown-ът и достъпът до мача трябва да
    // останат видими") — компактна лента вместо пълния popup, с все още жив
    // countdown и бутон за влизане.
    if (minimizedMatchId === assignment.matchId) {
      options.container.innerHTML = `
        <div id="tms-popup-mini" role="dialog" aria-live="polite" style="position:fixed;top:18px;right:18px;z-index:100000;display:flex;align-items:center;gap:10px;border:1px solid rgba(148,163,253,0.42);border-radius:8px;background:#101625;color:#f8fafc;box-shadow:0 18px 54px rgba(0,0,0,0.55);padding:8px 12px;font-family:Inter,system-ui,sans-serif;">
          <span style="font-size:12px;font-weight:900;color:#facc15;">${deadlineText}</span>
          <span style="font-size:12px;font-weight:700;">Турнирен мач</span>
          <button type="button" data-tms-expand="1" style="height:28px;padding:0 10px;border:0;border-radius:6px;background:#facc15;color:#1c1400;font-size:12px;font-weight:900;cursor:pointer;">Влез</button>
        </div>
      `
      options.container.querySelector('[data-tms-expand]')?.addEventListener('click', () => {
        minimizedMatchId = null
        render()
      })
      return
    }

    if (conflict !== null) {
      hadConflictForMatchId = assignment.matchId
    }

    if (conflict === null) {
      // Текущият конфликтен мач е приключил (или играчът никога не е бил в
      // конфликт) — играчът не дължи глоба в тази ситуация, защото не е
      // избрал explicit "напусни", просто изчакал играта да свърши сама.
      const justFinishedConflict = hadConflictForMatchId === assignment.matchId
      const introText = justFinishedConflict
        ? 'Вашият мач вече е започнал.'
        : isFirstMatch
          ? 'Вашият мач вече е започнал.'
          : 'Вашият мач вече е започнал.'
      options.container.innerHTML = `
        <div id="tms-popup" role="dialog" aria-live="polite" style="${popupShellStyle()}">
          <button type="button" data-tms-minimize="1" aria-label="Минимизирай" style="${minimizeButtonStyle()}">—</button>
          <div style="font-size:13px;font-weight:900;color:#93c5fd;text-transform:uppercase;letter-spacing:0.04em;padding-right:28px;">${escapeHtml(assignment.tournamentName)}</div>
          <div style="margin-top:8px;font-size:16px;font-weight:900;line-height:1.3;">Участвате в активен турнир</div>
          <div style="margin-top:6px;font-size:12px;line-height:1.5;color:rgba(248,250,252,0.72);">${escapeHtml(introText)}</div>
          <div style="margin-top:14px;display:flex;justify-content:flex-end;">
            <button type="button" data-tms-enter="1" style="${primaryButtonStyle()}">Продължи играта</button>
          </div>
        </div>
      `
      options.container.querySelector('[data-tms-enter]')?.addEventListener('click', () => {
        options.onEnterTournamentMatch(assignment)
      })
      options.container.querySelector('[data-tms-minimize]')?.addEventListener('click', () => {
        minimizedMatchId = assignment.matchId
        render()
      })
      return
    }

    options.container.innerHTML = `
      <div id="tms-popup" role="dialog" aria-live="polite" style="${popupShellStyle()}">
        <button type="button" data-tms-minimize="1" aria-label="Минимизирай" style="${minimizeButtonStyle()}">—</button>
        <div style="font-size:13px;font-weight:900;color:#93c5fd;text-transform:uppercase;letter-spacing:0.04em;padding-right:28px;">${escapeHtml(assignment.tournamentName)}</div>
        <div style="margin-top:8px;font-size:16px;font-weight:900;line-height:1.3;">Твоят турнирен мач започва след ${deadlineText}</div>
        <div style="margin-top:6px;font-size:12px;line-height:1.5;color:rgba(248,250,252,0.72);">В момента участваш в друг мач.</div>
        <div style="margin-top:10px;font-size:12px;line-height:1.5;color:rgba(248,250,252,0.72);">
          Можеш да напуснеш текущия мач и да влезеш в турнира. Ще бъде начислена стандартната глоба за напускане: <strong style="color:#fecaca;">${conflict.stakeAmount.toLocaleString('bg-BG')} жълтици</strong>.
        </div>
        <div style="margin-top:8px;font-size:12px;line-height:1.5;color:rgba(248,250,252,0.72);">
          Ако останеш, мястото ти в турнирния мач ще бъде заето от бот. Ще можеш да поемеш мястото си по-късно, ако отборът ти още не е отпаднал.
        </div>
        <div style="margin-top:14px;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;">
          <button type="button" data-tms-stay="1" style="${secondaryButtonStyle()}">Остани в текущия мач</button>
          <button type="button" data-tms-leave="1" style="${primaryButtonStyle()}">Напусни мача и влез в турнира</button>
        </div>
      </div>
    `
    options.container.querySelector('[data-tms-leave]')?.addEventListener('click', () => {
      options.onLeaveAndEnterTournamentMatch(assignment, conflict.roomId)
    })
    options.container.querySelector('[data-tms-stay]')?.addEventListener('click', () => {
      minimizedMatchId = assignment.matchId
      render()
    })
    options.container.querySelector('[data-tms-minimize]')?.addEventListener('click', () => {
      minimizedMatchId = assignment.matchId
      render()
    })
  }

  return {
    setAssignment(assignment) {
      if (assignment === null) {
        current = null
        minimizedMatchId = null
        hadConflictForMatchId = null
        render()
        return
      }
      if (current === null || current.matchId !== assignment.matchId) {
        minimizedMatchId = null
      }
      current = assignment
      render()
    },
    clearAssignmentForRoom(roomId) {
      if (current === null || current.roomId !== roomId) return
      current = null
      minimizedMatchId = null
      hadConflictForMatchId = null
      render()
    },
    tick() {
      if (current === null) return
      render()
    },
    destroy() {
      options.container.innerHTML = ''
      current = null
    },
  }
}

function popupShellStyle(): string {
  return [
    'position:fixed;top:18px;right:18px;z-index:100000;',
    'width:min(400px, calc(100vw - 32px));box-sizing:border-box;',
    'border:1px solid rgba(148,163,253,0.42);border-radius:8px;background:#101625;color:#f8fafc;',
    'box-shadow:0 18px 54px rgba(0,0,0,0.55);padding:14px 14px 12px 14px;font-family:Inter,system-ui,sans-serif;',
  ].join('')
}

function minimizeButtonStyle(): string {
  return 'position:absolute;top:8px;right:8px;width:26px;height:26px;border:1px solid rgba(255,255,255,0.16);border-radius:6px;background:#182018;color:#d1fae5;font-size:14px;font-weight:900;cursor:pointer;line-height:1;'
}

function primaryButtonStyle(): string {
  return 'height:38px;padding:0 14px;border:0;border-radius:8px;background:#facc15;color:#1c1400;font-size:13px;font-weight:900;cursor:pointer;'
}

function secondaryButtonStyle(): string {
  return 'height:38px;padding:0 14px;border:1px solid rgba(255,255,255,0.22);border-radius:8px;background:transparent;color:#e2e8f0;font-size:13px;font-weight:800;cursor:pointer;'
}
