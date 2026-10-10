import type {
  AdminCampaignEditorDraft,
  AdminCampaignReferenceData,
  AdminCampaignRewardType,
  AdminCampaignRow,
  AdminCampaignStatus,
  AdminCampaignTierReward,
} from './adminCampaignTypes'

export type AdminCampaignFilter = AdminCampaignStatus | 'all' | 'deleted'
export type AdminCampaignAction = 'schedule' | 'activate' | 'stop' | 'clone' | 'delete'

export type AdminCampaignsPanelState = {
  adminCampaigns: AdminCampaignRow[]
  adminCampaignsReferenceData: AdminCampaignReferenceData | null
  adminCampaignsLoading: boolean
  adminCampaignsErrorText: string | null
  adminCampaignsSuccessText: string | null
  adminCampaignsFilter: AdminCampaignFilter
  adminCampaignEditorDraft: AdminCampaignEditorDraft | null
}

export type AdminCampaignsPanelHandlers = {
  onBack: () => void
  onCreate: () => void
  onEdit: (campaignId: string) => void
  onFilter: (filter: AdminCampaignFilter) => void
  onDraftChange: (draft: AdminCampaignEditorDraft) => void
  onSave: (draft: AdminCampaignEditorDraft) => void
  onAction: (campaignId: string, action: AdminCampaignAction) => void
  onMarketingSenderSave: (campaignId: string, giftSenderProfileId: string | null) => void
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

function datetimeLocalValue(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const offsetMs = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16)
}

function statusLabel(status: AdminCampaignStatus): string {
  switch (status) {
    case 'draft': return 'Чернова'
    case 'scheduled': return 'Планирана'
    case 'active': return 'Активна'
    case 'finished': return 'Приключила'
    case 'stopped': return 'Спряна'
  }
}

function rewardLabel(reward: AdminCampaignTierReward, referenceData: AdminCampaignReferenceData): string {
  if (reward.rewardType === 'yellow_coins') return `${formatNumber(reward.amount)} жълтици`
  if (reward.rewardType === 'vip_days') return `${formatNumber(reward.days)} VIP дни`
  const item = referenceData.giftItems.find((gift) => gift.giftItemId === reward.giftItemId)
  return item ? `Подарък: ${item.name}` : `Подарък: ${reward.giftItemId}`
}

function renderStatusBadge(row: AdminCampaignRow): string {
  const color =
    row.deletedAt !== null ? '#94a3b8' :
    row.status === 'active' ? '#34d399' :
    row.status === 'scheduled' ? '#fbbf24' :
    row.status === 'draft' ? '#93c5fd' :
    '#c4b5fd'
  const label = row.deletedAt !== null ? 'Изтрита' : statusLabel(row.status)
  return `<span style="display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:6px;border:1px solid ${color}55;color:${color};font-size:11px;font-weight:900;">${label}</span>`
}

function renderPackageOption(pack: AdminCampaignReferenceData['purchasePackages'][number]): string {
  const label = `${pack.kind === 'bundle' ? 'Bundle' : 'Coins'} · ${pack.title} · ${formatNumber(pack.yellowCoinsAmount)}`
  return `<option value="${esc(pack.packageKey)}">${esc(label)} (${esc(pack.packageKey)})</option>`
}

function renderMarketingOptions(referenceData: AdminCampaignReferenceData, selectedId: string | null): string {
  return [
    `<option value="">Без подател</option>`,
    ...referenceData.marketingProfiles.map((profile) =>
      `<option value="${esc(profile.profileId)}" ${profile.profileId === selectedId ? 'selected' : ''}>${esc(profile.displayName)}</option>`,
    ),
  ].join('')
}

function renderStakeOptions(stakes: number[], selected: number): string {
  return stakes.map((stake) => `<option value="${stake}" ${stake === selected ? 'selected' : ''}>${formatNumber(stake)}</option>`).join('')
}

function renderGiftOptions(referenceData: AdminCampaignReferenceData, selectedId: string): string {
  return referenceData.giftItems
    .filter((item) => item.isActive || item.giftItemId === selectedId)
    .map((item) => `<option value="${esc(item.giftItemId)}" ${item.giftItemId === selectedId ? 'selected' : ''}>${esc(item.name)} · ${formatNumber(item.price)}</option>`)
    .join('')
}

function renderRewardEditor(
  reward: AdminCampaignTierReward,
  tierIndex: number,
  rewardIndex: number,
  referenceData: AdminCampaignReferenceData,
  disabled: boolean,
): string {
  const rewardType = reward.rewardType
  const valueControl =
    rewardType === 'yellow_coins'
      ? `<input data-admin-campaign-reward-value="1" type="number" min="1" value="${reward.amount}" ${disabled ? 'disabled' : ''} style="width:120px;height:34px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 8px;font-size:12px;font-weight:800;">`
      : rewardType === 'vip_days'
        ? `<input data-admin-campaign-reward-value="1" type="number" min="1" value="${reward.days}" ${disabled ? 'disabled' : ''} style="width:120px;height:34px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 8px;font-size:12px;font-weight:800;">`
        : `<select data-admin-campaign-reward-value="1" ${disabled ? 'disabled' : ''} style="min-width:210px;height:34px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 8px;font-size:12px;font-weight:800;">${renderGiftOptions(referenceData, reward.giftItemId)}</select>`

  return `
    <div data-admin-campaign-reward-row="1" data-tier-index="${tierIndex}" data-reward-index="${rewardIndex}" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
      <select data-admin-campaign-reward-type="1" ${disabled ? 'disabled' : ''} style="height:34px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 8px;font-size:12px;font-weight:800;">
        <option value="yellow_coins" ${rewardType === 'yellow_coins' ? 'selected' : ''}>Жълтици</option>
        <option value="vip_days" ${rewardType === 'vip_days' ? 'selected' : ''}>VIP дни</option>
        <option value="gift_item" ${rewardType === 'gift_item' ? 'selected' : ''}>Подарък</option>
      </select>
      ${valueControl}
      ${disabled ? '' : `<button type="button" data-admin-campaign-remove-reward="${tierIndex}:${rewardIndex}" style="height:34px;border:1px solid rgba(248,113,113,0.35);border-radius:6px;background:rgba(127,29,29,0.32);color:#fecaca;font-size:11px;font-weight:900;cursor:pointer;">Премахни</button>`}
    </div>
  `
}

function renderEditor(draft: AdminCampaignEditorDraft, referenceData: AdminCampaignReferenceData, isLocked: boolean): string {
  const allowedBelotStakes = referenceData.allowedStakes.belot
  const allowedLudoStakes = referenceData.allowedStakes.ludo
  const selectedCampaignId = draft.campaignId ?? ''

  const earnRows = draft.earnRules.map((rule, index) => {
    const stakes = rule.gameKind === 'belot' ? allowedBelotStakes : allowedLudoStakes
    return `
      <div data-admin-campaign-earn-rule="1" style="display:grid;grid-template-columns:minmax(90px,0.8fr) minmax(110px,1fr) minmax(110px,1fr) auto;gap:8px;align-items:center;">
        <select data-admin-campaign-earn-game="1" ${isLocked ? 'disabled' : ''} style="height:36px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 8px;font-size:12px;font-weight:800;">
          <option value="belot" ${rule.gameKind === 'belot' ? 'selected' : ''}>Belot</option>
          <option value="ludo" ${rule.gameKind === 'ludo' ? 'selected' : ''}>Ludo</option>
        </select>
        <select data-admin-campaign-earn-stake="1" ${isLocked ? 'disabled' : ''} style="height:36px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 8px;font-size:12px;font-weight:800;">${renderStakeOptions(stakes, rule.stakeAmount)}</select>
        <input data-admin-campaign-earn-units="1" type="number" min="1" value="${rule.unitsPerWin}" ${isLocked ? 'disabled' : ''} style="height:36px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 8px;font-size:12px;font-weight:800;">
        ${isLocked ? '' : `<button type="button" data-admin-campaign-remove-earn="${index}" style="height:36px;border:1px solid rgba(248,113,113,0.35);border-radius:6px;background:rgba(127,29,29,0.32);color:#fecaca;font-size:11px;font-weight:900;cursor:pointer;">Премахни</button>`}
      </div>
    `
  }).join('')

  const packageRows = draft.packageEarnRules.map((rule, index) => `
    <div data-admin-campaign-package-rule="1" style="display:grid;grid-template-columns:minmax(180px,1fr) minmax(120px,0.45fr) auto;gap:8px;align-items:center;">
      <select data-admin-campaign-package-key="1" ${isLocked ? 'disabled' : ''} style="height:36px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 8px;font-size:12px;font-weight:800;">
        ${referenceData.purchasePackages.map((pack) => renderPackageOption(pack).replace(`value="${esc(pack.packageKey)}"`, `value="${esc(pack.packageKey)}" ${pack.packageKey === rule.packageKey ? 'selected' : ''}`)).join('')}
      </select>
      <input data-admin-campaign-package-units="1" type="number" min="1" value="${rule.unitsPerPurchase}" ${isLocked ? 'disabled' : ''} style="height:36px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 8px;font-size:12px;font-weight:800;">
      ${isLocked ? '' : `<button type="button" data-admin-campaign-remove-package="${index}" style="height:36px;border:1px solid rgba(248,113,113,0.35);border-radius:6px;background:rgba(127,29,29,0.32);color:#fecaca;font-size:11px;font-weight:900;cursor:pointer;">Премахни</button>`}
    </div>
  `).join('')

  const tierRows = draft.rewardTiers.map((tier, tierIndex) => `
    <div data-admin-campaign-tier="1" style="border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:12px;background:rgba(255,255,255,0.035);display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;">
        <label style="display:flex;align-items:center;gap:8px;color:rgba(255,255,255,0.72);font-size:12px;font-weight:900;">Праг
          <input data-admin-campaign-tier-threshold="1" type="number" min="1" value="${tier.thresholdUnits}" ${isLocked ? 'disabled' : ''} style="width:130px;height:34px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 8px;font-size:12px;font-weight:800;">
        </label>
        <div style="display:flex;gap:8px;">
          ${isLocked ? '' : `<button type="button" data-admin-campaign-add-reward="${tierIndex}" style="height:34px;border:1px solid rgba(52,211,153,0.35);border-radius:6px;background:rgba(6,78,59,0.28);color:#bbf7d0;font-size:11px;font-weight:900;cursor:pointer;">+ Награда</button>`}
          ${isLocked ? '' : `<button type="button" data-admin-campaign-remove-tier="${tierIndex}" style="height:34px;border:1px solid rgba(248,113,113,0.35);border-radius:6px;background:rgba(127,29,29,0.32);color:#fecaca;font-size:11px;font-weight:900;cursor:pointer;">Премахни праг</button>`}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">${tier.rewards.map((reward, rewardIndex) => renderRewardEditor(reward, tierIndex, rewardIndex, referenceData, isLocked)).join('')}</div>
    </div>
  `).join('')

  return `
    <form data-admin-campaign-form="1" data-campaign-id="${esc(selectedCampaignId)}" style="border:1px solid rgba(255,255,255,0.12);border-radius:8px;background:rgba(0,0,0,0.34);padding:14px;display:flex;flex-direction:column;gap:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div style="font-size:16px;font-weight:950;color:#fff;">${draft.campaignId ? 'Редакция на кампания' : 'Нова кампания'}</div>
        <div style="display:flex;gap:8px;">
          ${draft.campaignId && isLocked ? `<button type="button" data-admin-campaign-save-marketing="${esc(draft.campaignId)}" style="height:36px;border:1px solid rgba(147,197,253,0.35);border-radius:6px;background:rgba(30,64,175,0.28);color:#bfdbfe;font-size:12px;font-weight:900;cursor:pointer;">Запази подател</button>` : ''}
          ${isLocked ? '' : `<button type="submit" style="height:36px;border:1px solid rgba(52,211,153,0.45);border-radius:6px;background:rgba(6,78,59,0.36);color:#bbf7d0;font-size:12px;font-weight:950;cursor:pointer;">Запази</button>`}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;">
        <label style="display:flex;flex-direction:column;gap:5px;font-size:11px;font-weight:900;color:rgba(255,255,255,0.56);">Име<input data-admin-campaign-name="1" value="${esc(draft.name)}" ${isLocked ? 'disabled' : ''} style="height:38px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 10px;font-size:13px;font-weight:800;"></label>
        <label style="display:flex;flex-direction:column;gap:5px;font-size:11px;font-weight:900;color:rgba(255,255,255,0.56);">Старт<input data-admin-campaign-starts="1" type="datetime-local" value="${datetimeLocalValue(draft.startsAt)}" ${isLocked ? 'disabled' : ''} style="height:38px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 10px;font-size:13px;font-weight:800;"></label>
        <label style="display:flex;flex-direction:column;gap:5px;font-size:11px;font-weight:900;color:rgba(255,255,255,0.56);">Край<input data-admin-campaign-ends="1" type="datetime-local" value="${datetimeLocalValue(draft.endsAt)}" ${isLocked ? 'disabled' : ''} style="height:38px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 10px;font-size:13px;font-weight:800;"></label>
        <label style="display:flex;flex-direction:column;gap:5px;font-size:11px;font-weight:900;color:rgba(255,255,255,0.56);">Единица<input data-admin-campaign-unit-singular="1" value="${esc(draft.unitNameSingular)}" ${isLocked ? 'disabled' : ''} style="height:38px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 10px;font-size:13px;font-weight:800;"></label>
        <label style="display:flex;flex-direction:column;gap:5px;font-size:11px;font-weight:900;color:rgba(255,255,255,0.56);">Единици<input data-admin-campaign-unit-plural="1" value="${esc(draft.unitNamePlural)}" ${isLocked ? 'disabled' : ''} style="height:38px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 10px;font-size:13px;font-weight:800;"></label>
        <label style="display:flex;flex-direction:column;gap:5px;font-size:11px;font-weight:900;color:rgba(255,255,255,0.56);">Marketing подател<select data-admin-campaign-sender="1" style="height:38px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:#050505;color:#fff;padding:0 10px;font-size:13px;font-weight:800;">${renderMarketingOptions(referenceData, draft.giftSenderProfileId)}</select></label>
      </div>
      <section style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;"><div style="font-size:13px;font-weight:950;color:#fff;">Правила за игри</div>${isLocked ? '' : `<button type="button" data-admin-campaign-add-earn="1" style="height:32px;border:1px solid rgba(52,211,153,0.35);border-radius:6px;background:rgba(6,78,59,0.28);color:#bbf7d0;font-size:11px;font-weight:900;cursor:pointer;">+ Правило</button>`}</div>
        <div style="display:flex;flex-direction:column;gap:8px;">${earnRows || '<div style="color:rgba(255,255,255,0.45);font-size:12px;font-weight:800;">Няма правила за игри.</div>'}</div>
      </section>
      <section style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;"><div style="font-size:13px;font-weight:950;color:#fff;">Правила за покупки</div>${isLocked ? '' : `<button type="button" data-admin-campaign-add-package="1" style="height:32px;border:1px solid rgba(52,211,153,0.35);border-radius:6px;background:rgba(6,78,59,0.28);color:#bbf7d0;font-size:11px;font-weight:900;cursor:pointer;">+ Пакет</button>`}</div>
        <div style="display:flex;flex-direction:column;gap:8px;">${packageRows || '<div style="color:rgba(255,255,255,0.45);font-size:12px;font-weight:800;">Няма правила за покупки.</div>'}</div>
      </section>
      <section style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;"><div style="font-size:13px;font-weight:950;color:#fff;">Наградни прагове</div>${isLocked ? '' : `<button type="button" data-admin-campaign-add-tier="1" style="height:32px;border:1px solid rgba(52,211,153,0.35);border-radius:6px;background:rgba(6,78,59,0.28);color:#bbf7d0;font-size:11px;font-weight:900;cursor:pointer;">+ Праг</button>`}</div>
        <div style="display:flex;flex-direction:column;gap:10px;">${tierRows || '<div style="color:rgba(255,255,255,0.45);font-size:12px;font-weight:800;">Няма наградни прагове.</div>'}</div>
      </section>
    </form>
  `
}

export function renderAdminCampaignsPanel(state: AdminCampaignsPanelState, isMobile = false): string {
  const referenceData = state.adminCampaignsReferenceData
  const filter = state.adminCampaignsFilter
  const campaigns = state.adminCampaigns.filter((campaign) => {
    if (filter === 'deleted') return campaign.deletedAt !== null
    if (campaign.deletedAt !== null) return false
    return filter === 'all' || campaign.status === filter
  })

  const rowsHtml = campaigns.length === 0
    ? `<div style="padding:18px;border:1px dashed rgba(255,255,255,0.14);border-radius:8px;color:rgba(255,255,255,0.48);font-size:13px;font-weight:800;">Няма кампании за избрания филтър.</div>`
    : campaigns.map((campaign) => {
      const canSchedule = campaign.status === 'draft' && campaign.deletedAt === null
      const canActivate = (campaign.status === 'draft' || campaign.status === 'scheduled') && campaign.deletedAt === null
      const canStop = campaign.status === 'active' && campaign.deletedAt === null
      const canDelete = campaign.status !== 'active' && campaign.deletedAt === null
      return `
        <article data-admin-campaign-row="${esc(campaign.campaignId)}" style="border:1px solid rgba(255,255,255,0.12);border-radius:8px;background:rgba(0,0,0,0.28);padding:12px;display:grid;grid-template-columns:${isMobile ? '1fr' : 'minmax(220px,1.2fr) minmax(180px,0.8fr) minmax(260px,1fr)'};gap:10px;align-items:center;">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${renderStatusBadge(campaign)}<strong style="color:#fff;font-size:14px;">${esc(campaign.name)}</strong></div>
            <div style="margin-top:5px;color:rgba(255,255,255,0.48);font-size:11px;font-weight:800;">${esc(campaign.unitNameSingular)} / ${esc(campaign.unitNamePlural)}</div>
            ${referenceData && campaign.rewardTiers.length > 0 ? `<div style="margin-top:5px;color:rgba(255,255,255,0.4);font-size:11px;font-weight:700;">${campaign.rewardTiers.map((tier) => `${formatNumber(tier.thresholdUnits)}: ${tier.rewards.map((reward) => rewardLabel(reward, referenceData)).join(', ')}`).join(' · ')}</div>` : ''}
          </div>
          <div style="color:rgba(255,255,255,0.68);font-size:12px;font-weight:800;line-height:1.45;">
            <div>${new Date(campaign.startsAt).toLocaleString('bg-BG')}</div>
            <div>${new Date(campaign.endsAt).toLocaleString('bg-BG')}</div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:${isMobile ? 'flex-start' : 'flex-end'};">
            <button type="button" data-admin-campaign-edit="${esc(campaign.campaignId)}" style="height:32px;border:1px solid rgba(147,197,253,0.35);border-radius:6px;background:rgba(30,64,175,0.22);color:#bfdbfe;font-size:11px;font-weight:900;cursor:pointer;">Преглед</button>
            ${canSchedule ? `<button type="button" data-admin-campaign-action="schedule" data-campaign-id="${esc(campaign.campaignId)}" style="height:32px;border:1px solid rgba(251,191,36,0.35);border-radius:6px;background:rgba(120,53,15,0.28);color:#fde68a;font-size:11px;font-weight:900;cursor:pointer;">Планирай</button>` : ''}
            ${canActivate ? `<button type="button" data-admin-campaign-action="activate" data-campaign-id="${esc(campaign.campaignId)}" style="height:32px;border:1px solid rgba(52,211,153,0.35);border-radius:6px;background:rgba(6,78,59,0.28);color:#bbf7d0;font-size:11px;font-weight:900;cursor:pointer;">Активирай</button>` : ''}
            ${canStop ? `<button type="button" data-admin-campaign-action="stop" data-campaign-id="${esc(campaign.campaignId)}" style="height:32px;border:1px solid rgba(248,113,113,0.35);border-radius:6px;background:rgba(127,29,29,0.30);color:#fecaca;font-size:11px;font-weight:900;cursor:pointer;">Спри</button>` : ''}
            <button type="button" data-admin-campaign-action="clone" data-campaign-id="${esc(campaign.campaignId)}" style="height:32px;border:1px solid rgba(196,181,253,0.35);border-radius:6px;background:rgba(76,29,149,0.24);color:#ddd6fe;font-size:11px;font-weight:900;cursor:pointer;">Клонирай</button>
            ${canDelete ? `<button type="button" data-admin-campaign-action="delete" data-campaign-id="${esc(campaign.campaignId)}" style="height:32px;border:1px solid rgba(248,113,113,0.35);border-radius:6px;background:rgba(127,29,29,0.30);color:#fecaca;font-size:11px;font-weight:900;cursor:pointer;">Изтрий</button>` : ''}
          </div>
        </article>
      `
    }).join('')

  const editorRow = state.adminCampaignEditorDraft && referenceData
    ? state.adminCampaigns.find((row) => row.campaignId === state.adminCampaignEditorDraft?.campaignId) ?? null
    : null
  const editorLocked = editorRow !== null && editorRow.status !== 'draft' && editorRow.status !== 'scheduled'

  return `
    <div data-admin-campaigns-panel="1" style="width:100%;max-width:1180px;margin:0 auto;padding:${isMobile ? '12px' : '22px'};box-sizing:border-box;display:flex;flex-direction:column;gap:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <div>
          <div style="font-size:22px;font-weight:950;color:#fff;">Кампании</div>
          <div style="margin-top:3px;color:rgba(255,255,255,0.48);font-size:12px;font-weight:800;">Периоди, правила за трупане и наградни прагове</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" data-admin-campaigns-back="1" style="height:36px;border:1px solid rgba(255,255,255,0.14);border-radius:6px;background:rgba(255,255,255,0.06);color:#fff;font-size:12px;font-weight:900;cursor:pointer;">Назад</button>
          <button type="button" data-admin-campaign-create="1" style="height:36px;border:1px solid rgba(52,211,153,0.42);border-radius:6px;background:rgba(6,78,59,0.34);color:#bbf7d0;font-size:12px;font-weight:950;cursor:pointer;">Нова кампания</button>
        </div>
      </div>
      ${state.adminCampaignsErrorText ? `<div style="border:1px solid rgba(248,113,113,0.28);border-radius:8px;background:rgba(127,29,29,0.36);color:#fecaca;padding:10px 12px;font-size:13px;font-weight:850;">${esc(state.adminCampaignsErrorText)}</div>` : ''}
      ${state.adminCampaignsSuccessText ? `<div style="border:1px solid rgba(52,211,153,0.28);border-radius:8px;background:rgba(6,78,59,0.28);color:#bbf7d0;padding:10px 12px;font-size:13px;font-weight:850;">${esc(state.adminCampaignsSuccessText)}</div>` : ''}
      <div data-admin-campaigns-filters="1" style="display:flex;gap:6px;flex-wrap:wrap;">
        ${(['all', 'draft', 'scheduled', 'active', 'finished', 'stopped', 'deleted'] as AdminCampaignFilter[]).map((item) => `<button type="button" data-admin-campaign-filter="${item}" style="height:30px;border:1px solid ${filter === item ? 'rgba(212,165,32,0.55)' : 'rgba(255,255,255,0.12)'};border-radius:6px;background:${filter === item ? 'rgba(212,165,32,0.16)' : 'rgba(255,255,255,0.045)'};color:${filter === item ? '#fde68a' : 'rgba(255,255,255,0.72)'};font-size:11px;font-weight:900;cursor:pointer;">${item === 'all' ? 'Всички' : item === 'deleted' ? 'Изтрити' : statusLabel(item)}</button>`).join('')}
      </div>
      ${state.adminCampaignsLoading ? '<div style="padding:20px;color:#d4a520;font-size:13px;font-weight:900;text-align:center;">Зареждане…</div>' : ''}
      <div style="display:flex;flex-direction:column;gap:10px;">${rowsHtml}</div>
      ${state.adminCampaignEditorDraft && referenceData ? renderEditor(state.adminCampaignEditorDraft, referenceData, editorLocked) : ''}
      ${referenceData && state.adminCampaignEditorDraft ? `
        <div style="display:flex;flex-wrap:wrap;gap:8px;color:rgba(255,255,255,0.44);font-size:11px;font-weight:800;">
          <span>Залози: ${referenceData.allowedStakes.belot.map(formatNumber).join(', ') || 'няма'}</span>
          <span>Пакети: ${referenceData.purchasePackages.length}</span>
          <span>Подаръци: ${referenceData.giftItems.filter((gift) => gift.isActive).length}</span>
          <span>Marketing профили: ${referenceData.marketingProfiles.length}</span>
        </div>
      ` : ''}
    </div>
  `
}

function selectedValue(root: ParentNode, selector: string, fallback = ''): string {
  return root.querySelector<HTMLSelectElement | HTMLInputElement>(selector)?.value ?? fallback
}

function selectedNumber(root: ParentNode, selector: string, fallback = 0): number {
  const value = Number(selectedValue(root, selector, String(fallback)))
  return Number.isFinite(value) ? value : fallback
}

function collectDraftFromForm(form: HTMLFormElement, previous: AdminCampaignEditorDraft): AdminCampaignEditorDraft {
  const earnRules = [...form.querySelectorAll<HTMLElement>('[data-admin-campaign-earn-rule="1"]')].map((row) => ({
    gameKind: selectedValue(row, '[data-admin-campaign-earn-game="1"]') === 'ludo' ? 'ludo' as const : 'belot' as const,
    stakeAmount: selectedNumber(row, '[data-admin-campaign-earn-stake="1"]', 0),
    unitsPerWin: selectedNumber(row, '[data-admin-campaign-earn-units="1"]', 1),
  }))

  const packageEarnRules = [...form.querySelectorAll<HTMLElement>('[data-admin-campaign-package-rule="1"]')].map((row) => ({
    packageKey: selectedValue(row, '[data-admin-campaign-package-key="1"]'),
    unitsPerPurchase: selectedNumber(row, '[data-admin-campaign-package-units="1"]', 1),
  }))

  const rewardTiers = [...form.querySelectorAll<HTMLElement>('[data-admin-campaign-tier="1"]')].map((tierRow) => {
    const rewards = [...tierRow.querySelectorAll<HTMLElement>('[data-admin-campaign-reward-row="1"]')].map((rewardRow) => {
      const rewardType = selectedValue(rewardRow, '[data-admin-campaign-reward-type="1"]') as AdminCampaignRewardType
      if (rewardType === 'vip_days') return { rewardType, days: selectedNumber(rewardRow, '[data-admin-campaign-reward-value="1"]', 1) }
      if (rewardType === 'gift_item') return { rewardType, giftItemId: selectedValue(rewardRow, '[data-admin-campaign-reward-value="1"]') }
      return { rewardType: 'yellow_coins' as const, amount: selectedNumber(rewardRow, '[data-admin-campaign-reward-value="1"]', 1) }
    })
    return {
      tierId: null,
      thresholdUnits: selectedNumber(tierRow, '[data-admin-campaign-tier-threshold="1"]', 1),
      rewards,
    }
  })

  return {
    ...previous,
    name: selectedValue(form, '[data-admin-campaign-name="1"]', previous.name),
    startsAt: selectedValue(form, '[data-admin-campaign-starts="1"]', previous.startsAt),
    endsAt: selectedValue(form, '[data-admin-campaign-ends="1"]', previous.endsAt),
    unitNameSingular: selectedValue(form, '[data-admin-campaign-unit-singular="1"]', previous.unitNameSingular),
    unitNamePlural: selectedValue(form, '[data-admin-campaign-unit-plural="1"]', previous.unitNamePlural),
    giftSenderProfileId: selectedValue(form, '[data-admin-campaign-sender="1"]') || null,
    earnRules,
    packageEarnRules,
    rewardTiers,
  }
}

function currentDraft(root: HTMLElement, state: AdminCampaignsPanelState): AdminCampaignEditorDraft | null {
  const form = root.querySelector<HTMLFormElement>('[data-admin-campaign-form="1"]')
  if (!form || !state.adminCampaignEditorDraft) return state.adminCampaignEditorDraft
  return collectDraftFromForm(form, state.adminCampaignEditorDraft)
}

export function attachAdminCampaignsHandlers(
  root: HTMLElement,
  state: AdminCampaignsPanelState,
  handlers: AdminCampaignsPanelHandlers,
): void {
  root.querySelector<HTMLElement>('[data-admin-campaigns-back="1"]')?.addEventListener('click', handlers.onBack)
  root.querySelector<HTMLElement>('[data-admin-campaign-create="1"]')?.addEventListener('click', handlers.onCreate)

  root.querySelectorAll<HTMLElement>('[data-admin-campaign-filter]').forEach((button) => {
    button.addEventListener('click', () => handlers.onFilter((button.dataset.adminCampaignFilter ?? 'all') as AdminCampaignFilter))
  })

  root.querySelectorAll<HTMLElement>('[data-admin-campaign-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const campaignId = button.dataset.adminCampaignEdit?.trim() ?? ''
      if (campaignId) handlers.onEdit(campaignId)
    })
  })

  root.querySelectorAll<HTMLElement>('[data-admin-campaign-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const campaignId = button.dataset.campaignId?.trim() ?? ''
      const action = button.dataset.adminCampaignAction as AdminCampaignAction | undefined
      if (!campaignId || !action) return
      if ((action === 'delete' || action === 'stop' || action === 'activate') && !confirm('Сигурен ли си?')) return
      handlers.onAction(campaignId, action)
    })
  })

  const form = root.querySelector<HTMLFormElement>('[data-admin-campaign-form="1"]')
  if (!form || !state.adminCampaignEditorDraft || !state.adminCampaignsReferenceData) return

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    handlers.onSave(collectDraftFromForm(form, state.adminCampaignEditorDraft!))
  })

  form.addEventListener('change', () => {
    handlers.onDraftChange(collectDraftFromForm(form, state.adminCampaignEditorDraft!))
  })

  root.querySelector<HTMLElement>('[data-admin-campaign-add-earn="1"]')?.addEventListener('click', () => {
    const draft = currentDraft(root, state)
    const stake = state.adminCampaignsReferenceData?.allowedStakes.belot[0] ?? 1
    if (draft) handlers.onDraftChange({ ...draft, earnRules: [...draft.earnRules, { gameKind: 'belot', stakeAmount: stake, unitsPerWin: 1 }] })
  })

  root.querySelectorAll<HTMLElement>('[data-admin-campaign-remove-earn]').forEach((button) => {
    button.addEventListener('click', () => {
      const draft = currentDraft(root, state)
      const index = Number(button.dataset.adminCampaignRemoveEarn)
      if (draft && Number.isInteger(index)) handlers.onDraftChange({ ...draft, earnRules: draft.earnRules.filter((_, i) => i !== index) })
    })
  })

  root.querySelector<HTMLElement>('[data-admin-campaign-add-package="1"]')?.addEventListener('click', () => {
    const draft = currentDraft(root, state)
    const packageKey = state.adminCampaignsReferenceData?.purchasePackages[0]?.packageKey ?? ''
    if (draft && packageKey) handlers.onDraftChange({ ...draft, packageEarnRules: [...draft.packageEarnRules, { packageKey, unitsPerPurchase: 1 }] })
  })

  root.querySelectorAll<HTMLElement>('[data-admin-campaign-remove-package]').forEach((button) => {
    button.addEventListener('click', () => {
      const draft = currentDraft(root, state)
      const index = Number(button.dataset.adminCampaignRemovePackage)
      if (draft && Number.isInteger(index)) handlers.onDraftChange({ ...draft, packageEarnRules: draft.packageEarnRules.filter((_, i) => i !== index) })
    })
  })

  root.querySelector<HTMLElement>('[data-admin-campaign-add-tier="1"]')?.addEventListener('click', () => {
    const draft = currentDraft(root, state)
    if (draft) handlers.onDraftChange({ ...draft, rewardTiers: [...draft.rewardTiers, { tierId: null, thresholdUnits: 1, rewards: [{ rewardType: 'yellow_coins', amount: 1000 }] }] })
  })

  root.querySelectorAll<HTMLElement>('[data-admin-campaign-remove-tier]').forEach((button) => {
    button.addEventListener('click', () => {
      const draft = currentDraft(root, state)
      const index = Number(button.dataset.adminCampaignRemoveTier)
      if (draft && Number.isInteger(index)) handlers.onDraftChange({ ...draft, rewardTiers: draft.rewardTiers.filter((_, i) => i !== index) })
    })
  })

  root.querySelectorAll<HTMLElement>('[data-admin-campaign-add-reward]').forEach((button) => {
    button.addEventListener('click', () => {
      const draft = currentDraft(root, state)
      const index = Number(button.dataset.adminCampaignAddReward)
      if (!draft || !Number.isInteger(index)) return
      handlers.onDraftChange({
        ...draft,
        rewardTiers: draft.rewardTiers.map((tier, i) => i === index ? { ...tier, rewards: [...tier.rewards, { rewardType: 'yellow_coins', amount: 1000 }] } : tier),
      })
    })
  })

  root.querySelectorAll<HTMLElement>('[data-admin-campaign-remove-reward]').forEach((button) => {
    button.addEventListener('click', () => {
      const draft = currentDraft(root, state)
      const [tierRaw, rewardRaw] = (button.dataset.adminCampaignRemoveReward ?? '').split(':')
      const tierIndex = Number(tierRaw)
      const rewardIndex = Number(rewardRaw)
      if (!draft || !Number.isInteger(tierIndex) || !Number.isInteger(rewardIndex)) return
      handlers.onDraftChange({
        ...draft,
        rewardTiers: draft.rewardTiers.map((tier, i) => i === tierIndex ? { ...tier, rewards: tier.rewards.filter((_, ri) => ri !== rewardIndex) } : tier),
      })
    })
  })

  root.querySelectorAll<HTMLElement>('[data-admin-campaign-save-marketing]').forEach((button) => {
    button.addEventListener('click', () => {
      const draft = currentDraft(root, state)
      const campaignId = button.dataset.adminCampaignSaveMarketing?.trim() ?? ''
      if (draft && campaignId) handlers.onMarketingSenderSave(campaignId, draft.giftSenderProfileId)
    })
  })
}
