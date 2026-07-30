import type {
  TournamentCreateInput,
  TournamentDetailSnapshot,
  TournamentPartnerCandidateSnapshot,
  TournamentPartnerInviteSnapshot,
  TournamentSummarySnapshot,
  TournamentVisibility,
  TournamentStartMode,
} from '../network/createGameServerClient'
import type { LobbyScreenState } from './renderLobbyScreen'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat('bg-BG').format(value)
}

function fmtLocalDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('bg-BG', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function formatInviteCountdown(expiresAt: string): string {
  const remainingMs = new Date(expiresAt).getTime() - Date.now()
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'изтича'
  const minutes = Math.floor(remainingMs / 60000)
  if (minutes < 60) return `${minutes} мин.`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${hours} ч. ${rest} мин.`
}

// ── Позволени входни стойности (огледално на server ALLOWED_TOURNAMENT_ENTRY_FEES) ──
export const TOURNAMENT_ENTRY_FEE_OPTIONS = [5000, 10000, 20000, 50000, 100000] as const

// UTC ISO → стойност за <input type="datetime-local"> (local timezone, без 'Z').
function isoToDatetimeLocalValue(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function computePrizePreview(entryFee: number, playerCapacity = 8): {
  totalEntryFees: number
  systemFee: number
  prizePool: number
  firstTeamPrize: number
  secondTeamPrize: number
  firstPlayerPrize: number
  secondPlayerPrize: number
} {
  const totalEntryFees = entryFee * playerCapacity
  const systemFee = Math.trunc(totalEntryFees * 0.2)
  const prizePool = totalEntryFees - systemFee
  const firstTeamPrize = Math.trunc(prizePool * 0.65)
  const secondTeamPrize = prizePool - firstTeamPrize
  const firstPlayerPrize = Math.trunc(firstTeamPrize / 2)
  const secondPlayerPrize = Math.trunc(secondTeamPrize / 2)
  return { totalEntryFees, systemFee, prizePool, firstTeamPrize, secondTeamPrize, firstPlayerPrize, secondPlayerPrize }
}

function startModeLabel(t: TournamentSummarySnapshot): string {
  if (t.startMode === 'fill') return 'При запълване'
  if (t.scheduledStartAt) return fmtLocalDateTime(t.scheduledStartAt)
  return 'Насрочен'
}

function statusBadgeColor(status: TournamentSummarySnapshot['status']): string {
  if (status === 'open') return '#22c55e'
  if (status === 'starting' || status === 'semifinal_in_progress' || status === 'final_in_progress') return '#d4a520'
  if (status === 'finished') return 'rgba(255,255,255,0.5)'
  return '#f87171'
}

// ─── Списък с турнири ────────────────────────────────────────────────────

function renderTournamentCard(t: TournamentSummarySnapshot): string {
  const avatarLetter = t.creator.displayName.slice(0, 1).toUpperCase()
  return `
    <article data-tournament-card="${escapeHtml(t.tournamentId)}" style="
      border:1px solid rgba(212,165,32,0.32);border-radius:8px;
      background:linear-gradient(180deg,#141414 0%,#050505 100%);
      padding:14px;display:flex;flex-direction:column;gap:10px;cursor:pointer;min-width:0;
    ">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="font-size:15px;font-weight:900;color:#ffffff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(t.name)}</div>
        <span style="flex-shrink:0;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:0.04em;color:${statusBadgeColor(t.status)};border:1px solid ${statusBadgeColor(t.status)}55;border-radius:999px;padding:3px 9px;">${escapeHtml(t.statusLabel)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="width:26px;height:26px;border-radius:999px;background:#101010;border:1px solid rgba(212,165,32,0.4);overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:12px;font-weight:900;flex-shrink:0;">
          ${t.creator.avatarUrl ? `<img src="${escapeHtml(t.creator.avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : avatarLetter}
        </div>
        <span style="font-size:12px;color:rgba(255,255,255,0.6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(t.creator.displayName)}${t.isMine ? ' (ти)' : ''}</span>
        ${t.requiresPassword ? '<span title="С парола" style="margin-left:auto;flex-shrink:0;font-size:14px;">🔒</span>' : ''}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;font-size:11px;">
        <span style="background:rgba(212,165,32,0.1);border:1px solid rgba(212,165,32,0.3);border-radius:6px;padding:3px 8px;color:#d4a520;font-weight:800;">${formatAmount(t.entryFee)} вход</span>
        <span style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:3px 8px;color:rgba(255,255,255,0.7);font-weight:800;">${t.confirmedEntriesCount} / ${t.playerCapacity} играчи</span>
        <span style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:3px 8px;color:rgba(255,255,255,0.7);font-weight:800;">${t.completedTeamsCount} / 4 отбора</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:rgba(255,255,255,0.45);">
        <span>${escapeHtml(startModeLabel(t))}</span>
        <span style="color:#d4a520;font-weight:800;">Награден фонд: ${formatAmount(t.prizePreview.prizePool)}</span>
      </div>
      <button type="button" disabled style="
        margin-top:2px;height:34px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);
        background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.35);font-size:12px;font-weight:800;
        cursor:not-allowed;
      ">Записването ще бъде достъпно скоро</button>
    </article>
  `
}

function renderIncomingInviteCard(invite: TournamentPartnerInviteSnapshot): string {
  return `
    <article style="border:1px solid rgba(34,197,94,0.32);border-radius:8px;background:#0d0d0d;padding:12px;display:grid;gap:8px;">
      <div style="display:flex;align-items:center;gap:8px;min-width:0;">
        <div style="width:30px;height:30px;border-radius:999px;background:#141414;border:1px solid rgba(255,255,255,0.14);overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:12px;font-weight:900;flex-shrink:0;">
          ${invite.inviter.avatarUrl ? `<img src="${escapeHtml(invite.inviter.avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : escapeHtml(invite.inviter.displayName.slice(0, 1).toUpperCase())}
        </div>
        <div style="min-width:0;">
          <div style="font-size:13px;font-weight:900;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(invite.inviter.displayName)} те кани</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(invite.tournamentName ?? 'Турнир')}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:rgba(255,255,255,0.65);">
        ${invite.entryFee !== undefined ? `<span>${formatAmount(invite.entryFee)} вход</span>` : ''}
        <span>Остава ${escapeHtml(formatInviteCountdown(invite.expiresAt))}</span>
        ${invite.scheduledStartAt ? `<span>${escapeHtml(fmtLocalDateTime(invite.scheduledStartAt))}</span>` : ''}
      </div>
      <button type="button" data-tournament-card="${escapeHtml(invite.tournamentId)}" style="height:34px;border-radius:6px;border:1px solid rgba(212,165,32,0.36);background:rgba(212,165,32,0.10);color:#d4a520;font-size:12px;font-weight:900;cursor:pointer;">Виж турнира</button>
    </article>
  `
}

function renderIncomingInvitesSection(state: LobbyScreenState): string {
  if (state.profile.profileId === null || state.tournamentPartnerInvites.length === 0) return ''
  return `
    <section style="margin-bottom:16px;">
      <div style="font-size:13px;font-weight:900;color:#22c55e;margin-bottom:8px;">Покани към теб</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;">
        ${state.tournamentPartnerInvites.map(renderIncomingInviteCard).join('')}
      </div>
    </section>
  `
}

export function renderTournamentsScreen(state: LobbyScreenState): string {
  const isMineFilter = state.tournamentsFilter === 'mine'

  const header = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
      <h2 style="font-size:22px;font-weight:900;color:#ffffff;margin:0;">Турнири</h2>
      <button type="button" data-tournament-create-open="1" style="
        height:40px;padding:0 18px;border:0;border-radius:8px;
        background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;
        font-size:13px;font-weight:900;cursor:pointer;
      ">+ Създай турнир</button>
    </div>
  `

  const filters = state.profile.profileId !== null ? `
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      <button type="button" data-tournament-filter="all" style="
        height:32px;padding:0 14px;border-radius:999px;cursor:pointer;font-size:12px;font-weight:800;
        border:1px solid ${!isMineFilter ? '#d4a520' : 'rgba(255,255,255,0.16)'};
        background:${!isMineFilter ? 'rgba(212,165,32,0.12)' : 'transparent'};
        color:${!isMineFilter ? '#d4a520' : 'rgba(255,255,255,0.6)'};
      ">Всички</button>
      <button type="button" data-tournament-filter="mine" style="
        height:32px;padding:0 14px;border-radius:999px;cursor:pointer;font-size:12px;font-weight:800;
        border:1px solid ${isMineFilter ? '#d4a520' : 'rgba(255,255,255,0.16)'};
        background:${isMineFilter ? 'rgba(212,165,32,0.12)' : 'transparent'};
        color:${isMineFilter ? '#d4a520' : 'rgba(255,255,255,0.6)'};
      ">Моите</button>
    </div>
  ` : ''

  let body: string
  if (state.tournamentsLoading) {
    body = `<div style="min-height:320px;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:16px;font-weight:800;">Зареждане...</div>`
  } else if (state.tournamentsErrorText) {
    body = `<div style="min-height:320px;display:flex;align-items:center;justify-content:center;color:#fecaca;font-size:14px;font-weight:800;text-align:center;padding:20px;">${escapeHtml(state.tournamentsErrorText)}</div>`
  } else if (state.tournaments.length === 0) {
    body = `
      <div style="min-height:320px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:20px;">
        <div style="font-size:17px;font-weight:900;color:#ffffff;">Все още няма активни турнири.</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.55);max-width:360px;">Създай турнир, покани приятели и се състезавайте за наградния фонд.</div>
        <button type="button" data-tournament-create-open="1" style="
          margin-top:6px;height:40px;padding:0 20px;border:0;border-radius:8px;
          background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;
          font-size:13px;font-weight:900;cursor:pointer;
        ">Създай турнир</button>
      </div>
    `
  } else {
    body = `
      <div class="tournaments-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;">
        ${state.tournaments.map(renderTournamentCard).join('')}
      </div>
    `
  }

  return `
    <section style="padding:0 4px;">
      ${header}
      ${filters}
      ${renderIncomingInvitesSection(state)}
      ${body}
      ${state.tournamentCreatePopupOpen ? renderTournamentCreatePopup(state) : ''}
    </section>
  `
}

// ─── Popup "Създай турнир" ───────────────────────────────────────────────

function renderTournamentCreatePopup(state: LobbyScreenState): string {
  const defaultEntryFee = TOURNAMENT_ENTRY_FEE_OPTIONS[0]
  const preview = computePrizePreview(defaultEntryFee)
  const nowPlus30Min = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const defaultScheduled = isoToDatetimeLocalValue(nowPlus30Min)
  const defaultName = `Турнирът на ${state.profile.displayName || state.displayName || 'Играч'}`

  return `
    <div data-tournament-create-backdrop="1" style="position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto;">
      <div style="background:#111118;border:1px solid rgba(212,165,32,0.4);border-radius:16px;width:440px;max-width:100%;padding:24px;box-shadow:0 8px 40px rgba(0,0,0,0.7);max-height:92vh;overflow-y:auto;box-sizing:border-box;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
          <div style="font-size:17px;font-weight:900;color:#d4a520;">Създай турнир</div>
          <button type="button" data-tournament-create-close="1" style="width:32px;height:32px;border:none;background:rgba(255,255,255,0.08);border-radius:7px;color:rgba(255,255,255,0.6);font-size:18px;font-weight:700;cursor:pointer;">×</button>
        </div>

        ${state.tournamentCreateErrorText ? `
          <div style="margin-bottom:14px;padding:10px 12px;border:1px solid rgba(248,113,113,0.4);background:rgba(127,29,29,0.25);border-radius:8px;color:#fecaca;font-size:13px;font-weight:700;">${escapeHtml(state.tournamentCreateErrorText)}</div>
        ` : ''}

        <form data-tournament-create-form="1" style="display:flex;flex-direction:column;gap:14px;">
          <div>
            <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;">Име на турнира</div>
            <input type="text" name="name" value="${escapeHtml(defaultName)}" maxlength="40" style="width:100%;box-sizing:border-box;padding:10px 12px;background:#1a1a24;border:1px solid rgba(255,255,255,0.18);border-radius:8px;color:#fff;font-size:14px;">
          </div>

          <div>
            <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;">Вход на играч</div>
            <select name="entryFee" data-tournament-create-entryfee="1" style="width:100%;box-sizing:border-box;padding:10px 12px;background:#1a1a24;border:1px solid rgba(255,255,255,0.18);border-radius:8px;color:#fff;font-size:14px;color-scheme:dark;">
              ${TOURNAMENT_ENTRY_FEE_OPTIONS.map((fee) => `<option value="${fee}">${formatAmount(fee)} жълтици</option>`).join('')}
            </select>
          </div>

          <div data-tournament-create-preview="1" style="background:rgba(212,165,32,0.06);border:1px solid rgba(212,165,32,0.24);border-radius:8px;padding:12px;font-size:12px;color:rgba(255,255,255,0.75);display:grid;gap:4px;">
            <div style="display:flex;justify-content:space-between;"><span>Участници</span><span style="font-weight:800;">8</span></div>
            <div style="display:flex;justify-content:space-between;" data-preview-total><span>Общо входове</span><span style="font-weight:800;">${formatAmount(preview.totalEntryFees)}</span></div>
            <div style="display:flex;justify-content:space-between;" data-preview-fee><span>Системна такса (20%)</span><span style="font-weight:800;">${formatAmount(preview.systemFee)}</span></div>
            <div style="display:flex;justify-content:space-between;color:#d4a520;" data-preview-pool><span>Награден фонд</span><span style="font-weight:900;">${formatAmount(preview.prizePool)}</span></div>
            <div style="display:flex;justify-content:space-between;" data-preview-first><span>Първи отбор (65%)</span><span style="font-weight:800;">${formatAmount(preview.firstTeamPrize)}</span></div>
            <div style="display:flex;justify-content:space-between;" data-preview-second><span>Втори отбор (35%)</span><span style="font-weight:800;">${formatAmount(preview.secondTeamPrize)}</span></div>
          </div>

          <div>
            <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;">Видимост</div>
            <div style="display:flex;gap:8px;">
              <label style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;height:38px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);cursor:pointer;font-size:13px;color:rgba(255,255,255,0.8);">
                <input type="radio" name="visibility" value="public" checked style="accent-color:#d4a520;">
                Публичен
              </label>
              <label style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;height:38px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);cursor:pointer;font-size:13px;color:rgba(255,255,255,0.8);">
                <input type="radio" name="visibility" value="password" style="accent-color:#d4a520;">
                С парола
              </label>
            </div>
          </div>

          <div data-tournament-create-password-field="1" style="display:none;">
            <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;">Парола (4-32 знака)</div>
            <input type="password" name="password" minlength="4" maxlength="32" style="width:100%;box-sizing:border-box;padding:10px 12px;background:#1a1a24;border:1px solid rgba(255,255,255,0.18);border-radius:8px;color:#fff;font-size:14px;">
          </div>

          <div>
            <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;">Начало</div>
            <div style="display:flex;gap:8px;">
              <label style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;height:38px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);cursor:pointer;font-size:13px;color:rgba(255,255,255,0.8);">
                <input type="radio" name="startMode" value="fill" checked style="accent-color:#d4a520;">
                При запълване
              </label>
              <label style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;height:38px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);cursor:pointer;font-size:13px;color:rgba(255,255,255,0.8);">
                <input type="radio" name="startMode" value="scheduled" style="accent-color:#d4a520;">
                Насрочен старт
              </label>
            </div>
          </div>

          <div data-tournament-create-scheduled-field="1" style="display:none;">
            <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;">Дата и час (местно време)</div>
            <input type="datetime-local" name="scheduledStartAt" value="${defaultScheduled}" style="width:100%;box-sizing:border-box;padding:10px 12px;background:#1a1a24;border:1px solid rgba(255,255,255,0.18);border-radius:8px;color:#fff;font-size:14px;color-scheme:dark;">
            <div style="margin-top:4px;font-size:11px;color:rgba(255,255,255,0.4);">Между 30 минути и 7 дни от сега.</div>
          </div>

          <button type="submit" ${state.tournamentCreateBusy ? 'disabled' : ''} style="
            margin-top:4px;height:42px;border:0;border-radius:8px;
            background:${state.tournamentCreateBusy ? 'rgba(212,165,32,0.35)' : 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)'};
            color:#080808;font-size:14px;font-weight:900;cursor:${state.tournamentCreateBusy ? 'default' : 'pointer'};
          ">${state.tournamentCreateBusy ? 'Създаване...' : 'Създай турнир'}</button>
        </form>
      </div>
    </div>
  `
}

// ─── Детайли на турнир ────────────────────────────────────────────────────

function tournamentMatchStatusLabel(status: string, roomReady: boolean): string {
  if (status === 'completed') return 'Завършен'
  if (status === 'in_progress') return roomReady ? 'Играе се' : 'Чака играчите'
  if (status === 'awaiting_players' || status === 'countdown') {
    return roomReady ? 'Чака играчите' : 'Масата се подготвя'
  }
  return status
}

function tournamentResultKindLabel(resultKind: string | null): string {
  if (resultKind === 'walkover') return 'Служебна победа'
  if (resultKind === 'played_with_bots') return 'Играно с бот'
  if (resultKind === 'played') return 'Нормално изигран'
  return ''
}

function renderTournamentMatchAssignmentCallout(t: TournamentDetailSnapshot): string {
  const assignment = t.myActiveMatch
  if (assignment === null) return ''
  const heading = assignment.roundType === 'final'
    ? 'Финалната ти маса е готова.'
    : 'Полуфиналната ти маса е готова.'
  const token = assignment.reconnectToken ?? ''
  return `
    <div style="border:1px solid rgba(34,197,94,0.45);background:rgba(20,83,45,0.28);border-radius:10px;padding:12px 14px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
      <div>
        <div style="font-size:14px;font-weight:900;color:#dcfce7;">${heading}</div>
        <div style="font-size:12px;font-weight:700;color:rgba(220,252,231,0.72);margin-top:3px;">${escapeHtml(t.name)}</div>
      </div>
      <button type="button" data-tournament-enter-active-match="1" data-room-id="${escapeHtml(assignment.roomId)}" data-reconnect-token="${escapeHtml(token)}" ${token ? '' : 'disabled'} style="height:38px;border:0;border-radius:8px;padding:0 14px;background:${token ? 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)' : 'rgba(255,255,255,0.12)'};color:${token ? '#080808' : 'rgba(255,255,255,0.45)'};font-size:13px;font-weight:900;cursor:${token ? 'pointer' : 'default'};">Влез в масата</button>
    </div>
  `
}

function renderTournamentRounds(t: TournamentDetailSnapshot): string {
  if (!t.rounds || t.rounds.length === 0) {
    return '<div style="font-size:13px;color:rgba(255,255,255,0.4);font-style:italic;">Схемата ще се появи, след като турнирът стартира.</div>'
  }
  return `
    <div style="display:grid;gap:10px;">
      ${t.rounds.map((round) => `
        <div style="border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px;background:rgba(255,255,255,0.03);">
          <div style="font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;color:#d4a520;margin-bottom:8px;">${round.roundType === 'final' ? 'Финал' : `Полуфинал ${round.roundIndex}`}</div>
          <div style="display:grid;gap:8px;">
            ${round.matches.map((match) => `
              <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;">
                <div style="font-size:13px;font-weight:800;color:rgba(255,255,255,0.78);min-width:0;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(match.teamAId.slice(0, 8))} срещу ${escapeHtml(match.teamBId.slice(0, 8))}</div>
                <div style="font-size:11px;font-weight:900;color:${match.status === 'completed' ? '#86efac' : '#fde68a'};white-space:nowrap;text-align:right;">${escapeHtml(match.progressLabel ?? tournamentMatchStatusLabel(match.status, match.roomReady))}${tournamentResultKindLabel(match.resultKind) ? `<div style="margin-top:3px;color:#cbd5e1;">${escapeHtml(tournamentResultKindLabel(match.resultKind))}</div>` : ''}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `
}

export function renderTournamentDetailScreen(state: LobbyScreenState): string {
  if (state.tournamentDetailLoading) {
    return `<section style="padding:0 4px;"><div style="min-height:320px;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:16px;font-weight:800;">Зареждане...</div></section>`
  }

  if (state.tournamentDetailRequiresPassword) {
    return `
      <section style="padding:0 4px;max-width:420px;margin:0 auto;">
        <div style="border:1px solid rgba(212,165,32,0.32);border-radius:12px;background:#0d0d0d;padding:28px;text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;">
          <div style="font-size:30px;">🔒</div>
          <div style="font-size:15px;font-weight:800;color:#ffffff;">Този турнир е защитен с парола.</div>
          ${state.tournamentDetailUnlockErrorText ? `
            <div style="width:100%;padding:8px 10px;border:1px solid rgba(248,113,113,0.4);background:rgba(127,29,29,0.25);border-radius:8px;color:#fecaca;font-size:12px;font-weight:700;box-sizing:border-box;">${escapeHtml(state.tournamentDetailUnlockErrorText)}</div>
          ` : ''}
          <input
            type="password"
            data-tournament-unlock-password="1"
            value="${escapeHtml(state.tournamentDetailPasswordDraft)}"
            placeholder="Парола"
            style="width:100%;box-sizing:border-box;padding:10px 12px;background:#1a1a24;border:1px solid rgba(255,255,255,0.18);border-radius:8px;color:#fff;font-size:14px;"
          >
          <button type="button" data-tournament-unlock-submit="1" ${state.tournamentDetailUnlockBusy ? 'disabled' : ''} style="
            width:100%;height:40px;border:0;border-radius:8px;
            background:${state.tournamentDetailUnlockBusy ? 'rgba(212,165,32,0.35)' : 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)'};
            color:#080808;font-size:14px;font-weight:900;cursor:${state.tournamentDetailUnlockBusy ? 'default' : 'pointer'};
          ">${state.tournamentDetailUnlockBusy ? 'Проверка...' : 'Отвори турнира'}</button>
        </div>
      </section>
    `
  }

  if (state.tournamentDetailErrorText) {
    return `<section style="padding:0 4px;"><div style="min-height:320px;display:flex;align-items:center;justify-content:center;color:#fecaca;font-size:14px;font-weight:800;text-align:center;padding:20px;">${escapeHtml(state.tournamentDetailErrorText)}</div></section>`
  }

  const t: TournamentDetailSnapshot | null = state.tournamentDetail
  if (t === null) {
    return `<section style="padding:0 4px;"><div style="min-height:320px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.5);font-size:14px;">Турнирът не е намерен.</div></section>`
  }

  const avatarLetter = t.creator.displayName.slice(0, 1).toUpperCase()

  return `
    <section style="padding:0 4px;max-width:720px;margin:0 auto;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap;">
        <h2 style="font-size:22px;font-weight:900;color:#ffffff;margin:0;">${escapeHtml(t.name)}</h2>
        <span style="font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.04em;color:${statusBadgeColor(t.status)};border:1px solid ${statusBadgeColor(t.status)}55;border-radius:999px;padding:3px 10px;">${escapeHtml(t.statusLabel)}</span>
        ${t.requiresPassword ? '<span title="С парола" style="font-size:15px;">🔒</span>' : ''}
      </div>

      <div style="display:flex;align-items:center;gap:8px;margin-bottom:18px;">
        <div style="width:28px;height:28px;border-radius:999px;background:#101010;border:1px solid rgba(212,165,32,0.4);overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:13px;font-weight:900;flex-shrink:0;">
          ${t.creator.avatarUrl ? `<img src="${escapeHtml(t.creator.avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : avatarLetter}
        </div>
        <span style="font-size:13px;color:rgba(255,255,255,0.65);">Създател: ${escapeHtml(t.creator.displayName)}${t.isMine ? ' (ти)' : ''}</span>
      </div>

      ${renderTournamentMatchAssignmentCallout(t)}

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:20px;">
        <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:10px;padding:12px 14px;">
          <div style="font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-bottom:4px;">Вход</div>
          <div style="font-size:18px;font-weight:900;color:#ffffff;">${formatAmount(t.entryFee)}</div>
        </div>
        <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:10px;padding:12px 14px;">
          <div style="font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-bottom:4px;">Участници</div>
          <div style="font-size:18px;font-weight:900;color:#ffffff;">${t.confirmedEntriesCount} / ${t.playerCapacity}</div>
        </div>
        <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:10px;padding:12px 14px;">
          <div style="font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-bottom:4px;">Отбори</div>
          <div style="font-size:18px;font-weight:900;color:#ffffff;">${t.completedTeamsCount} / 4</div>
        </div>
        <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:10px;padding:12px 14px;">
          <div style="font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-bottom:4px;">Старт</div>
          <div style="font-size:13px;font-weight:800;color:#ffffff;">${escapeHtml(startModeLabel(t))}</div>
        </div>
      </div>

      <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:10px;padding:16px;margin-bottom:20px;">
        <div style="font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-bottom:12px;">Формат</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;font-size:12px;">
          <span style="background:rgba(255,255,255,0.06);border-radius:6px;padding:4px 10px;color:rgba(255,255,255,0.75);">8 играчи</span>
          <span style="background:rgba(255,255,255,0.06);border-radius:6px;padding:4px 10px;color:rgba(255,255,255,0.75);">4 отбора</span>
          <span style="background:rgba(255,255,255,0.06);border-radius:6px;padding:4px 10px;color:rgba(255,255,255,0.75);">2 полуфинала</span>
          <span style="background:rgba(255,255,255,0.06);border-radius:6px;padding:4px 10px;color:rgba(255,255,255,0.75);">1 финал</span>
          <span style="background:rgba(255,255,255,0.06);border-radius:6px;padding:4px 10px;color:rgba(255,255,255,0.75);">Без мач за трето място</span>
          <span style="background:rgba(255,255,255,0.06);border-radius:6px;padding:4px 10px;color:rgba(255,255,255,0.75);">Игра до 151</span>
        </div>
        <div style="font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-bottom:10px;">Награден фонд</div>
        <div style="display:grid;gap:5px;font-size:13px;color:rgba(255,255,255,0.75);">
          <div style="display:flex;justify-content:space-between;"><span>Единичен вход за целия турнир</span><span style="font-weight:800;">${formatAmount(t.entryFee)}</span></div>
          <div style="display:flex;justify-content:space-between;"><span>Общо входове (при пълен турнир)</span><span style="font-weight:800;">${formatAmount(t.prizePreview.totalEntryFees)}</span></div>
          <div style="display:flex;justify-content:space-between;"><span>Системна такса (20%)</span><span style="font-weight:800;">${formatAmount(t.prizePreview.systemFee)}</span></div>
          <div style="display:flex;justify-content:space-between;color:#d4a520;"><span>Награден фонд (90%)</span><span style="font-weight:900;">${formatAmount(t.prizePreview.prizePool)}</span></div>
          <div style="display:flex;justify-content:space-between;"><span>Първо място (65%)</span><span style="font-weight:800;">${formatAmount(t.prizePreview.firstTeamPrize)}</span></div>
          <div style="display:flex;justify-content:space-between;"><span>Второ място (35%)</span><span style="font-weight:800;">${formatAmount(t.prizePreview.secondTeamPrize)}</span></div>
        </div>
      </div>

      <div style="background:#0d0d0d;border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:16px;margin-bottom:14px;">
        <div style="font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-bottom:8px;">Отбори</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.4);font-style:italic;">Все още няма сформирани отбори.</div>
      </div>

      <div style="background:#0d0d0d;border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:16px;margin-bottom:14px;">
        <div style="font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-bottom:8px;">Турнирна схема</div>
        ${renderTournamentRounds(t)}
      </div>

      ${renderTournamentPartnerPanel(state, t)}
      ${renderTournamentParticipationActions(state, t)}

      <div style="font-size:11px;color:rgba(255,255,255,0.35);">Създаден: ${fmtLocalDateTime(t.createdAt)}</div>
    </section>

    ${state.tournamentJoinConfirmOpen ? renderTournamentJoinConfirmPopup(state, t) : ''}
    ${state.tournamentPartnerPickerOpen ? renderTournamentPartnerPickerPopup(state, t) : ''}
    ${state.tournamentLeaveConfirmOpen ? renderTournamentLeaveConfirmPopup(state, t) : ''}
    ${state.tournamentCancelConfirmOpen ? renderTournamentCancelConfirmPopup(state) : ''}
  `
}

function renderTournamentPartnerPanel(state: LobbyScreenState, t: TournamentDetailSnapshot): string {
  const error = state.tournamentPartnerInviteErrorText
    ? `<div style="margin-bottom:10px;padding:8px 10px;border:1px solid rgba(248,113,113,0.4);background:rgba(127,29,29,0.25);border-radius:8px;color:#fecaca;font-size:12px;font-weight:700;">${escapeHtml(state.tournamentPartnerInviteErrorText)}</div>`
    : ''
  if (t.incomingPartnerInvite) {
    const invite = t.incomingPartnerInvite
    return `<div style="background:#0d0d0d;border:1px solid rgba(34,197,94,0.36);border-radius:10px;padding:16px;margin-bottom:14px;">${error}<div style="font-size:14px;font-weight:900;color:#22c55e;margin-bottom:8px;">${escapeHtml(invite.inviter.displayName)} те кани да участвате като партньори.</div><div style="font-size:12px;color:rgba(255,255,255,0.62);margin-bottom:12px;">При приемане ще бъдат приспаднати ${formatAmount(t.entryFee)} жълтици. Остава ${escapeHtml(formatInviteCountdown(invite.expiresAt))}.</div><div style="display:flex;gap:8px;flex-wrap:wrap;"><button type="button" data-tournament-partner-accept="${escapeHtml(invite.inviteId)}" data-tournament-id="${escapeHtml(t.tournamentId)}" ${state.tournamentPartnerInviteBusy ? 'disabled' : ''} style="height:38px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#4ade80 0%,#16a34a 100%);color:#06120a;font-size:13px;font-weight:900;cursor:pointer;">Приеми поканата</button><button type="button" data-tournament-partner-decline="${escapeHtml(invite.inviteId)}" data-tournament-id="${escapeHtml(t.tournamentId)}" ${state.tournamentPartnerInviteBusy ? 'disabled' : ''} style="height:38px;padding:0 16px;border-radius:8px;border:1px solid rgba(248,113,113,0.4);background:rgba(127,29,29,0.2);color:#fca5a5;font-size:13px;font-weight:800;cursor:pointer;">Откажи</button></div></div>`
  }
  if (t.outgoingPartnerInvite) {
    const invite = t.outgoingPartnerInvite
    return `<div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.32);border-radius:10px;padding:16px;margin-bottom:14px;">${error}<div style="font-size:14px;font-weight:900;color:#d4a520;margin-bottom:8px;">Чакаме отговор от ${escapeHtml(invite.invitee.displayName)}</div><div style="font-size:12px;color:rgba(255,255,255,0.62);margin-bottom:12px;">Мястото е временно резервирано. Остава ${escapeHtml(formatInviteCountdown(invite.expiresAt))}.</div><button type="button" data-tournament-partner-cancel="${escapeHtml(invite.inviteId)}" data-tournament-id="${escapeHtml(t.tournamentId)}" ${state.tournamentPartnerInviteBusy ? 'disabled' : ''} style="height:38px;padding:0 16px;border-radius:8px;border:1px solid rgba(248,113,113,0.4);background:rgba(127,29,29,0.2);color:#fca5a5;font-size:13px;font-weight:800;cursor:pointer;">Отмени поканата</button></div>`
  }
  if (t.myTeam && t.myTeam.status === 'complete') {
    return `<div style="background:#0d0d0d;border:1px solid rgba(34,197,94,0.32);border-radius:10px;padding:16px;margin-bottom:14px;"><div style="font-size:14px;font-weight:900;color:#22c55e;margin-bottom:10px;">Отборът е готов</div><div style="display:flex;gap:10px;flex-wrap:wrap;">${t.myTeam.members.map((member) => `<div style="display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.10);border-radius:8px;padding:7px 9px;"><span style="width:26px;height:26px;border-radius:999px;overflow:hidden;background:#171717;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:11px;font-weight:900;">${member.avatarUrl ? `<img src="${escapeHtml(member.avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : escapeHtml(member.displayName.slice(0, 1).toUpperCase())}</span><span style="font-size:12px;color:#fff;font-weight:800;">${escapeHtml(member.displayName)}</span></div>`).join('')}</div></div>`
  }
  if (t.status === 'open' && !t.incomingPartnerInvite && !t.outgoingPartnerInvite && t.viewer.canInvitePartner) {
    const label = t.viewer.isParticipant ? 'Покани приятел за партньор' : 'Участвай с партньор'
    return `<div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:10px;padding:16px;margin-bottom:14px;">${error}<button type="button" data-tournament-partner-picker-open="1" style="width:100%;height:40px;border-radius:8px;border:1px solid rgba(212,165,32,0.42);background:rgba(212,165,32,0.10);color:#d4a520;font-size:14px;font-weight:900;cursor:pointer;">${label}</button></div>`
  }
  return ''
}

function renderTournamentParticipationActions(state: LobbyScreenState, t: TournamentDetailSnapshot): string {
  const errorBox = (text: string | null) =>
    text
      ? `<div style="margin-bottom:10px;padding:8px 10px;border:1px solid rgba(248,113,113,0.4);background:rgba(127,29,29,0.25);border-radius:8px;color:#fecaca;font-size:12px;font-weight:700;">${escapeHtml(text)}</div>`
      : ''

  if (t.viewer.isParticipant) {
    return `
      <div style="background:#0d0d0d;border:1px solid rgba(34,197,94,0.32);border-radius:10px;padding:16px;margin-bottom:14px;">
        ${errorBox(state.tournamentLeaveErrorText)}
        <div style="font-size:14px;font-weight:800;color:#22c55e;margin-bottom:10px;">✓ Записан си самостоятелно</div>
        <button type="button" data-tournament-leave-open="1" style="
          height:38px;padding:0 18px;border-radius:8px;border:1px solid rgba(248,113,113,0.4);
          background:rgba(127,29,29,0.2);color:#fca5a5;font-size:13px;font-weight:800;cursor:pointer;
        ">Откажи участие</button>
        ${t.viewer.canCancel ? renderCreatorCancelBlock(state) : ''}
      </div>
    `
  }

  if (t.viewer.canJoinSolo) {
    return `
      <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:10px;padding:16px;margin-bottom:14px;">
        ${errorBox(state.tournamentJoinErrorText)}
        <button type="button" data-tournament-join-open="1" style="
          width:100%;height:42px;border:0;border-radius:8px;
          background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;
          font-size:14px;font-weight:900;cursor:pointer;
        ">Запиши се сам</button>
        <div style="margin-top:8px;font-size:12px;color:rgba(255,255,255,0.5);text-align:center;">
          Входът се плаща еднократно за целия турнир: ${formatAmount(t.entryFee)} жълтици.
        </div>
        <div style="margin-top:6px;font-size:12px;color:rgba(255,255,255,0.4);text-align:center;font-style:italic;">
          Можеш да се запишеш сам или да поканиш приятел от списъка си.
        </div>
      </div>
    `
  }

  if (t.isFull && t.status === 'open') {
    return `
      <div style="background:#0d0d0d;border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:16px;margin-bottom:14px;">
        <button type="button" disabled style="
          width:100%;height:42px;border:1px solid rgba(255,255,255,0.12);border-radius:8px;
          background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.35);font-size:13px;font-weight:800;cursor:not-allowed;
        ">Турнирът е запълнен</button>
        ${t.viewer.canCancel ? renderCreatorCancelBlock(state) : ''}
      </div>
    `
  }

  // Терминален viewer статус (refunded/withdrawn) или турнирът вече не е open —
  // няма join действие, но creator cancel блок все пак може да е relevant
  // (напр. isMine, status=open, viewer никога не се е записвал).
  if (t.viewer.canCancel) {
    return `
      <div style="background:#0d0d0d;border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:16px;margin-bottom:14px;">
        ${renderCreatorCancelBlock(state)}
      </div>
    `
  }

  return ''
}

function renderCreatorCancelBlock(state: LobbyScreenState): string {
  return `
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.08);">
      ${state.tournamentCancelErrorText ? `
        <div style="margin-bottom:10px;padding:8px 10px;border:1px solid rgba(248,113,113,0.4);background:rgba(127,29,29,0.25);border-radius:8px;color:#fecaca;font-size:12px;font-weight:700;">${escapeHtml(state.tournamentCancelErrorText)}</div>
      ` : ''}
      <button type="button" data-tournament-cancel-open="1" style="
        height:38px;padding:0 18px;border-radius:8px;border:1px solid rgba(248,113,113,0.4);
        background:rgba(127,29,29,0.2);color:#fca5a5;font-size:13px;font-weight:800;cursor:pointer;
      ">Отмени турнира</button>
    </div>
  `
}

function renderTournamentJoinConfirmPopup(state: LobbyScreenState, t: TournamentDetailSnapshot): string {
  return `
    <div data-tournament-join-backdrop="1" style="position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:16px;">
      <div style="background:#111118;border:1px solid rgba(212,165,32,0.4);border-radius:16px;width:100%;max-width:380px;padding:24px;box-sizing:border-box;">
        <div style="font-size:16px;font-weight:900;color:#d4a520;margin-bottom:12px;">Запиши се сам</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.75);line-height:1.5;margin-bottom:6px;">
          Ще платиш еднократен вход от <strong style="color:#fff;">${formatAmount(t.entryFee)} жълтици</strong> за целия турнир.
        </div>
        <div style="font-size:12px;color:rgba(255,255,255,0.5);line-height:1.5;margin-bottom:16px;">
          Ако се откажеш преди старта на турнира, сумата се връща изцяло.
        </div>
        ${state.tournamentJoinErrorText ? `
          <div style="margin-bottom:14px;padding:8px 10px;border:1px solid rgba(248,113,113,0.4);background:rgba(127,29,29,0.25);border-radius:8px;color:#fecaca;font-size:12px;font-weight:700;">${escapeHtml(state.tournamentJoinErrorText)}</div>
        ` : ''}
        <div style="display:flex;gap:10px;">
          <button type="button" data-tournament-join-close="1" ${state.tournamentJoinBusy ? 'disabled' : ''} style="
            flex:1;height:40px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);
            background:transparent;color:rgba(255,255,255,0.75);font-size:13px;font-weight:800;
            cursor:${state.tournamentJoinBusy ? 'default' : 'pointer'};
          ">Отказ</button>
          <button type="button" data-tournament-join-submit="1" ${state.tournamentJoinBusy ? 'disabled' : ''} style="
            flex:1;height:40px;border:0;border-radius:8px;
            background:${state.tournamentJoinBusy ? 'rgba(212,165,32,0.35)' : 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)'};
            color:#080808;font-size:13px;font-weight:900;cursor:${state.tournamentJoinBusy ? 'default' : 'pointer'};
          ">${state.tournamentJoinBusy ? 'Записване...' : 'Потвърди'}</button>
        </div>
      </div>
    </div>
  `
}

function renderTournamentPartnerPickerPopup(state: LobbyScreenState, t: TournamentDetailSnapshot): string {
  const query = state.tournamentPartnerInviteQuery.trim().toLowerCase()
  const candidates = state.tournamentPartnerCandidates
    .filter((candidate) => query.length === 0 || candidate.displayName.toLowerCase().includes(query))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName, 'bg'))
  const body = state.tournamentPartnerPickerLoading
    ? `<div style="padding:26px;text-align:center;color:#d4a520;font-weight:800;">Зареждане...</div>`
    : state.tournamentPartnerPickerErrorText
      ? `<div style="padding:14px;border:1px solid rgba(248,113,113,0.4);background:rgba(127,29,29,0.25);border-radius:8px;color:#fecaca;font-size:13px;font-weight:700;">${escapeHtml(state.tournamentPartnerPickerErrorText)}</div>`
      : candidates.length === 0
        ? `<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.55);font-size:13px;">Няма приятели за показване.</div>`
        : candidates.map((candidate) => renderPartnerCandidateRow(candidate, state)).join('')
  return `
    <div data-tournament-partner-picker-backdrop="1" style="position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,0.72);display:flex;align-items:center;justify-content:center;padding:14px;">
      <div style="background:#111118;border:1px solid rgba(212,165,32,0.4);border-radius:14px;width:100%;max-width:460px;padding:18px;box-sizing:border-box;max-height:92vh;overflow:auto;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;">
          <div style="font-size:16px;font-weight:900;color:#d4a520;">Избери партньор</div>
          <button type="button" data-tournament-partner-picker-close="1" ${state.tournamentPartnerInviteBusy ? 'disabled' : ''} style="width:32px;height:32px;border:none;background:rgba(255,255,255,0.08);border-radius:7px;color:rgba(255,255,255,0.65);font-size:18px;font-weight:800;cursor:pointer;">x</button>
        </div>
        <div style="font-size:12px;color:rgba(255,255,255,0.62);line-height:1.45;margin-bottom:12px;">Ще платиш вход от ${formatAmount(t.entryFee)} жълтици. Поканеният приятел ще плати своя вход само ако приеме.</div>
        ${state.tournamentPartnerInviteErrorText ? `<div style="margin-bottom:10px;padding:8px 10px;border:1px solid rgba(248,113,113,0.4);background:rgba(127,29,29,0.25);border-radius:8px;color:#fecaca;font-size:12px;font-weight:700;">${escapeHtml(state.tournamentPartnerInviteErrorText)}</div>` : ''}
        <input type="search" data-tournament-partner-query="1" value="${escapeHtml(state.tournamentPartnerInviteQuery)}" placeholder="Търси в приятелите" style="width:100%;height:38px;box-sizing:border-box;margin-bottom:10px;padding:0 11px;background:#1a1a24;border:1px solid rgba(255,255,255,0.16);border-radius:8px;color:#fff;font-size:13px;">
        <div style="display:grid;gap:8px;">${body}</div>
      </div>
    </div>
  `
}

function renderPartnerCandidateRow(candidate: TournamentPartnerCandidateSnapshot, state: LobbyScreenState): string {
  const status = candidate.online ? 'Онлайн' : 'Офлайн'
  const disabledReason = candidate.unavailableReason ? ` (${candidate.unavailableReason})` : ''
  return `
    <button type="button" data-tournament-partner-invite="${escapeHtml(candidate.profileId)}" ${!candidate.eligible || state.tournamentPartnerInviteBusy ? 'disabled' : ''} style="width:100%;min-height:48px;border-radius:8px;border:1px solid ${candidate.eligible ? 'rgba(212,165,32,0.28)' : 'rgba(255,255,255,0.10)'};background:${candidate.eligible ? 'rgba(212,165,32,0.07)' : 'rgba(255,255,255,0.03)'};display:flex;align-items:center;gap:9px;padding:8px 10px;cursor:${candidate.eligible && !state.tournamentPartnerInviteBusy ? 'pointer' : 'not-allowed'};text-align:left;">
      <span style="width:30px;height:30px;border-radius:999px;background:#171717;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:12px;font-weight:900;flex-shrink:0;">${candidate.avatarUrl ? `<img src="${escapeHtml(candidate.avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : escapeHtml(candidate.displayName.slice(0, 1).toUpperCase())}</span>
      <span style="min-width:0;display:grid;gap:2px;">
        <span style="font-size:13px;font-weight:900;color:${candidate.eligible ? '#fff' : 'rgba(255,255,255,0.42)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(candidate.displayName)}</span>
        <span style="font-size:11px;color:${candidate.online ? '#22c55e' : 'rgba(255,255,255,0.45)'};">${status}${escapeHtml(disabledReason)}</span>
      </span>
    </button>
  `
}

function renderTournamentLeaveConfirmPopup(state: LobbyScreenState, t: TournamentDetailSnapshot): string {
  return `
    <div data-tournament-leave-backdrop="1" style="position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:16px;">
      <div style="background:#111118;border:1px solid rgba(248,113,113,0.4);border-radius:16px;width:100%;max-width:380px;padding:24px;box-sizing:border-box;">
        <div style="font-size:16px;font-weight:900;color:#fca5a5;margin-bottom:12px;">Откажи участие</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.75);line-height:1.5;margin-bottom:16px;">
          Ще получиш обратно <strong style="color:#fff;">${formatAmount(t.entryFee)} жълтици</strong>. Ще напуснеш турнира.
        </div>
        ${state.tournamentLeaveErrorText ? `
          <div style="margin-bottom:14px;padding:8px 10px;border:1px solid rgba(248,113,113,0.4);background:rgba(127,29,29,0.25);border-radius:8px;color:#fecaca;font-size:12px;font-weight:700;">${escapeHtml(state.tournamentLeaveErrorText)}</div>
        ` : ''}
        <div style="display:flex;gap:10px;">
          <button type="button" data-tournament-leave-close="1" ${state.tournamentLeaveBusy ? 'disabled' : ''} style="
            flex:1;height:40px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);
            background:transparent;color:rgba(255,255,255,0.75);font-size:13px;font-weight:800;
            cursor:${state.tournamentLeaveBusy ? 'default' : 'pointer'};
          ">Отказ</button>
          <button type="button" data-tournament-leave-submit="1" ${state.tournamentLeaveBusy ? 'disabled' : ''} style="
            flex:1;height:40px;border:0;border-radius:8px;
            background:${state.tournamentLeaveBusy ? 'rgba(248,113,113,0.35)' : 'linear-gradient(180deg,#f87171 0%,#dc2626 100%)'};
            color:#080808;font-size:13px;font-weight:900;cursor:${state.tournamentLeaveBusy ? 'default' : 'pointer'};
          ">${state.tournamentLeaveBusy ? 'Отказване...' : 'Потвърди'}</button>
        </div>
      </div>
    </div>
  `
}

function renderTournamentCancelConfirmPopup(state: LobbyScreenState): string {
  return `
    <div data-tournament-cancel-backdrop="1" style="position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:16px;">
      <div style="background:#111118;border:1px solid rgba(248,113,113,0.4);border-radius:16px;width:100%;max-width:400px;padding:24px;box-sizing:border-box;">
        <div style="font-size:16px;font-weight:900;color:#fca5a5;margin-bottom:12px;">Отмени турнира</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.75);line-height:1.5;margin-bottom:16px;">
          Всички записани участници ще получат пълния си вход обратно. Турнирът не може да бъде възстановен.
        </div>
        ${state.tournamentCancelErrorText ? `
          <div style="margin-bottom:14px;padding:8px 10px;border:1px solid rgba(248,113,113,0.4);background:rgba(127,29,29,0.25);border-radius:8px;color:#fecaca;font-size:12px;font-weight:700;">${escapeHtml(state.tournamentCancelErrorText)}</div>
        ` : ''}
        <div style="display:flex;gap:10px;">
          <button type="button" data-tournament-cancel-close="1" ${state.tournamentCancelBusy ? 'disabled' : ''} style="
            flex:1;height:40px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);
            background:transparent;color:rgba(255,255,255,0.75);font-size:13px;font-weight:800;
            cursor:${state.tournamentCancelBusy ? 'default' : 'pointer'};
          ">Назад</button>
          <button type="button" data-tournament-cancel-submit="1" ${state.tournamentCancelBusy ? 'disabled' : ''} style="
            flex:1;height:40px;border:0;border-radius:8px;
            background:${state.tournamentCancelBusy ? 'rgba(248,113,113,0.35)' : 'linear-gradient(180deg,#f87171 0%,#dc2626 100%)'};
            color:#080808;font-size:13px;font-weight:900;cursor:${state.tournamentCancelBusy ? 'default' : 'pointer'};
          ">${state.tournamentCancelBusy ? 'Отменяне...' : 'Отмени турнира'}</button>
        </div>
      </div>
    </div>
  `
}

// ─── Client-side валидация преди submit (defense-in-depth, сървърът е authoritative) ──

export function extractTournamentCreateInputFromForm(form: HTMLFormElement): TournamentCreateInput | null {
  const data = new FormData(form)
  const name = String(data.get('name') ?? '').trim()
  const entryFee = Number(data.get('entryFee'))
  const visibility = String(data.get('visibility') ?? 'public') as TournamentVisibility
  const startMode = String(data.get('startMode') ?? 'fill') as TournamentStartMode
  const password = String(data.get('password') ?? '')
  const scheduledStartAtLocal = String(data.get('scheduledStartAt') ?? '')

  if (name.length === 0) return null
  if (!Number.isFinite(entryFee)) return null

  const input: TournamentCreateInput = { name, entryFee, visibility, startMode }
  if (visibility === 'password') {
    input.password = password
  }
  if (startMode === 'scheduled' && scheduledStartAtLocal) {
    const parsed = new Date(scheduledStartAtLocal)
    if (!Number.isNaN(parsed.getTime())) {
      input.scheduledStartAt = parsed.toISOString()
    }
  }
  return input
}
