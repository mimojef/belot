// Фаза 11 — admin "Приключили кампании" екран: списък (finished/stopped,
// вкл. все още неархивирани) + детайл (обобщена статистика + замразен
// Топ 10). Mirror архитектурно на renderAdminCampaignsPanel.ts (plain
// template-string render + data-attribute event delegation), отделен
// файл — тоя екран е read-mostly (само "Архивирай сега" trigger), не
// споделя форми/state с основния campaigns editor.
import type {
  AdminCampaignArchiveListRow,
  AdminCampaignArchiveDetailResponse,
} from './adminCampaignTypes'

export type AdminCampaignArchivePanelState = {
  adminCampaignArchiveList: AdminCampaignArchiveListRow[]
  adminCampaignArchiveLoading: boolean
  adminCampaignArchiveErrorText: string | null
  adminCampaignArchiveSuccessText: string | null
  adminCampaignArchiveSelectedId: string | null
  adminCampaignArchiveDetail: AdminCampaignArchiveDetailResponse | null
}

export type AdminCampaignArchivePanelHandlers = {
  onBack: () => void
  onSelect: (campaignId: string) => void
  onCloseDetail: () => void
  onArchiveNow: (campaignId: string) => void
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatNumber(value: number): string {
  return value.toLocaleString('bg-BG')
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('bg-BG') : value
}

function statusBadge(row: AdminCampaignArchiveListRow): string {
  if (row.archivedAt !== null) {
    return `<span style="display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;border:1px solid #34d39955;color:#34d399;font-size:11px;font-weight:900;">Архивирана</span>`
  }
  return `<span style="display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;border:1px solid #fbbf2455;color:#fbbf24;font-size:11px;font-weight:900;">Чака архивиране</span>`
}

function renderListRow(row: AdminCampaignArchiveListRow, isSelected: boolean): string {
  const statusLabel = row.status === 'stopped' ? 'Спряна' : 'Приключила'
  const totalsText = row.totalUnits === null
    ? '— (очаква reconciliation/архивиране)'
    : `${formatNumber(row.totalUnits)} / ${formatNumber(row.participantsCount ?? 0)} участника`
  return `
    <article data-admin-campaign-archive-row="${esc(row.campaignId)}" style="border:1px solid ${isSelected ? 'rgba(212,165,32,0.55)' : 'rgba(255,255,255,0.12)'};border-radius:8px;background:rgba(0,0,0,0.28);padding:12px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;">
      <div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${statusBadge(row)}<strong style="color:#fff;font-size:14px;">${esc(row.name)}</strong><span style="color:rgba(255,255,255,0.45);font-size:11px;font-weight:800;">(${statusLabel})</span></div>
        <div style="margin-top:5px;color:rgba(255,255,255,0.55);font-size:11px;font-weight:800;">${formatDate(row.startsAt)} – ${formatDate(row.endsAt)}</div>
        <div style="margin-top:3px;color:rgba(255,255,255,0.45);font-size:11px;font-weight:700;">${esc(row.unitNamePlural)}: ${totalsText}</div>
      </div>
      <button type="button" data-admin-campaign-archive-view="${esc(row.campaignId)}" style="height:32px;border:1px solid rgba(147,197,253,0.35);border-radius:6px;background:rgba(30,64,175,0.22);color:#bfdbfe;font-size:11px;font-weight:900;cursor:pointer;">Виж резултатите</button>
    </article>
  `
}

function renderReadinessPending(label: string, count: number): string {
  if (count === 0) return ''
  return `<li>${esc(label)}: ${formatNumber(count)}</li>`
}

function renderDetailPanel(campaignId: string, response: AdminCampaignArchiveDetailResponse): string {
  if (!response.ok) {
    return `<div style="border:1px solid rgba(248,113,113,0.28);border-radius:8px;background:rgba(127,29,29,0.36);color:#fecaca;padding:12px;font-size:13px;font-weight:850;">${esc(response.message ?? 'Грешка при зареждане на резултатите.')}</div>`
  }

  if (!response.archived) {
    const pendingItems = [
      renderReadinessPending('Белот начисления', response.readiness.pendingBelotWin),
      renderReadinessPending('Белот (стари мачове)', response.readiness.pendingBelotLegacy),
      renderReadinessPending('Ludo начисления', response.readiness.pendingLudoWin),
      renderReadinessPending('Покупки жълтици', response.readiness.pendingPurchaseCoin),
      renderReadinessPending('Покупки пакети', response.readiness.pendingPurchaseBundle),
      renderReadinessPending('Покупки VIP', response.readiness.pendingPurchaseVip),
      renderReadinessPending('Дължими награди', response.readiness.pendingGiftRewardGaps),
    ].filter(Boolean).join('')
    return `
      <div style="border:1px solid rgba(251,191,36,0.3);border-radius:8px;background:rgba(120,53,15,0.24);padding:14px;display:flex;flex-direction:column;gap:10px;">
        <div style="font-size:14px;font-weight:950;color:#fde68a;">Кампанията е приключила, но все още чака ${response.ready ? 'архивиране' : 'reconciliation'}.</div>
        ${pendingItems ? `<ul style="margin:0;padding-left:18px;color:rgba(255,255,255,0.75);font-size:12px;font-weight:700;line-height:1.6;">${pendingItems}</ul>` : ''}
        <button type="button" data-admin-campaign-archive-now="${esc(campaignId)}" ${response.ready ? '' : 'disabled'} style="align-self:flex-start;height:34px;border:1px solid rgba(52,211,153,0.45);border-radius:6px;background:rgba(6,78,59,0.36);color:#bbf7d0;font-size:12px;font-weight:950;cursor:pointer;opacity:${response.ready ? '1' : '0.5'};">Архивирай сега</button>
      </div>
    `
  }

  const { detail } = response
  const iconHtml = detail.summary.unitIconUrlAtArchive
    ? `<img src="${esc(detail.summary.unitIconUrlAtArchive)}" alt="" style="width:40px;height:40px;object-fit:contain;border-radius:8px;background:rgba(255,255,255,0.08);" onerror="this.style.display='none'">`
    : ''
  const top10Rows = detail.top10.length === 0
    ? `<div style="color:rgba(255,255,255,0.45);font-size:12px;font-weight:800;">Няма участници.</div>`
    : `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="color:rgba(255,255,255,0.55);text-align:left;">
          <th style="padding:6px 8px;">Място</th><th style="padding:6px 8px;">Играч</th><th style="padding:6px 8px;">Ранг</th><th style="padding:6px 8px;text-align:right;">${esc(detail.unitNamePlural)}</th>
        </tr></thead>
        <tbody>
          ${detail.top10.map((entry) => `
            <tr style="border-top:1px solid rgba(255,255,255,0.08);color:#fff;font-weight:800;">
              <td style="padding:6px 8px;">${entry.rank}</td>
              <td style="padding:6px 8px;">${esc(entry.displayNameAtArchive)}${entry.profileId === null ? ' <span style="color:rgba(255,255,255,0.4);font-weight:700;">(изтрит профил)</span>' : ''}</td>
              <td style="padding:6px 8px;color:rgba(255,255,255,0.6);">${esc(entry.rankTitleAtArchive ?? '—')}</td>
              <td style="padding:6px 8px;text-align:right;">${formatNumber(entry.unitsTotal)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `

  return `
    <div style="border:1px solid rgba(255,255,255,0.12);border-radius:8px;background:rgba(0,0,0,0.34);padding:16px;display:flex;flex-direction:column;gap:14px;">
      <div style="display:flex;align-items:center;gap:12px;">
        ${iconHtml}
        <div>
          <div style="font-size:16px;font-weight:950;color:#fff;">${esc(detail.name)}</div>
          <div style="color:rgba(255,255,255,0.5);font-size:11px;font-weight:800;">${formatDate(detail.startsAt)} – ${formatDate(detail.endsAt)} · ${detail.summary.endedReason === 'stopped' ? 'Спряна ръчно' : 'Изтекла автоматично'} · Архивирана: ${formatDate(detail.summary.archivedAt)}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;">
        <div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:10px;"><div style="color:rgba(255,255,255,0.5);font-size:11px;font-weight:800;">Общо ${esc(detail.unitNamePlural)}</div><div style="color:#fff;font-size:18px;font-weight:950;">${formatNumber(detail.summary.totalUnits)}</div></div>
        <div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:10px;"><div style="color:rgba(255,255,255,0.5);font-size:11px;font-weight:800;">Участници</div><div style="color:#fff;font-size:18px;font-weight:950;">${formatNumber(detail.summary.participantsCount)}</div></div>
        <div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:10px;"><div style="color:rgba(255,255,255,0.5);font-size:11px;font-weight:800;">Предоставени награди</div><div style="color:#fff;font-size:18px;font-weight:950;">${formatNumber(detail.summary.rewardsGrantedCount)}</div></div>
        <div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:10px;"><div style="color:rgba(255,255,255,0.5);font-size:11px;font-weight:800;">От Белот/Ludo/покупки/корекции</div><div style="color:#fff;font-size:13px;font-weight:900;">${formatNumber(detail.summary.unitsFromBelot)} / ${formatNumber(detail.summary.unitsFromLudo)} / ${formatNumber(detail.summary.unitsFromPurchases)} / ${formatNumber(detail.summary.unitsFromAdminAdjustments)}</div></div>
      </div>
      <div>
        <div style="font-size:13px;font-weight:950;color:#fff;margin-bottom:8px;">Топ 10</div>
        ${top10Rows}
      </div>
    </div>
  `
}

export function renderAdminCampaignArchivePanel(state: AdminCampaignArchivePanelState, isMobile = false): string {
  const rowsHtml = state.adminCampaignArchiveList.length === 0
    ? `<div style="padding:18px;border:1px dashed rgba(255,255,255,0.14);border-radius:8px;color:rgba(255,255,255,0.48);font-size:13px;font-weight:800;">Няма приключили кампании.</div>`
    : state.adminCampaignArchiveList.map((row) => renderListRow(row, row.campaignId === state.adminCampaignArchiveSelectedId)).join('')

  return `
    <div data-admin-campaign-archive-panel="1" style="width:100%;max-width:1180px;margin:0 auto;padding:${isMobile ? '12px' : '22px'};box-sizing:border-box;display:flex;flex-direction:column;gap:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <div>
          <div style="font-size:22px;font-weight:950;color:#fff;">Приключили кампании</div>
          <div style="margin-top:3px;color:rgba(255,255,255,0.48);font-size:12px;font-weight:800;">Окончателни резултати и замразена класация Топ 10</div>
        </div>
        <button type="button" data-admin-campaign-archive-back="1" style="height:36px;border:1px solid rgba(255,255,255,0.14);border-radius:6px;background:rgba(255,255,255,0.06);color:#fff;font-size:12px;font-weight:900;cursor:pointer;">Назад към Кампании</button>
      </div>
      ${state.adminCampaignArchiveErrorText ? `<div style="border:1px solid rgba(248,113,113,0.28);border-radius:8px;background:rgba(127,29,29,0.36);color:#fecaca;padding:10px 12px;font-size:13px;font-weight:850;">${esc(state.adminCampaignArchiveErrorText)}</div>` : ''}
      ${state.adminCampaignArchiveSuccessText ? `<div style="border:1px solid rgba(52,211,153,0.28);border-radius:8px;background:rgba(6,78,59,0.28);color:#bbf7d0;padding:10px 12px;font-size:13px;font-weight:850;">${esc(state.adminCampaignArchiveSuccessText)}</div>` : ''}
      ${state.adminCampaignArchiveLoading ? '<div style="padding:20px;color:#d4a520;font-size:13px;font-weight:900;text-align:center;">Зареждане…</div>' : ''}
      <div style="display:flex;flex-direction:column;gap:10px;">${rowsHtml}</div>
      ${state.adminCampaignArchiveSelectedId !== null && state.adminCampaignArchiveDetail !== null
        ? `<div>
            <div style="display:flex;justify-content:flex-end;margin-bottom:8px;"><button type="button" data-admin-campaign-archive-close-detail="1" style="height:30px;border:1px solid rgba(255,255,255,0.14);border-radius:6px;background:rgba(255,255,255,0.06);color:#fff;font-size:11px;font-weight:900;cursor:pointer;">Затвори</button></div>
            ${renderDetailPanel(state.adminCampaignArchiveSelectedId, state.adminCampaignArchiveDetail)}
          </div>`
        : ''}
    </div>
  `
}

export function attachAdminCampaignArchivePanelHandlers(
  root: HTMLElement,
  handlers: AdminCampaignArchivePanelHandlers,
): void {
  root.querySelector<HTMLElement>('[data-admin-campaign-archive-back="1"]')?.addEventListener('click', handlers.onBack)
  root.querySelector<HTMLElement>('[data-admin-campaign-archive-close-detail="1"]')?.addEventListener('click', handlers.onCloseDetail)

  root.querySelectorAll<HTMLElement>('[data-admin-campaign-archive-view]').forEach((button) => {
    button.addEventListener('click', () => {
      const campaignId = button.dataset.adminCampaignArchiveView?.trim() ?? ''
      if (campaignId) handlers.onSelect(campaignId)
    })
  })

  root.querySelectorAll<HTMLElement>('[data-admin-campaign-archive-now]').forEach((button) => {
    button.addEventListener('click', () => {
      const campaignId = button.dataset.adminCampaignArchiveNow?.trim() ?? ''
      if (!campaignId) return
      if (!confirm('Архивирай кампанията сега? Резултатът ще бъде замразен окончателно.')) return
      handlers.onArchiveNow(campaignId)
    })
  })
}
