import { getActiveCampaignTheme } from '../activeRoom/activeRoomShared'

// Кампании — "+X <икона>" до пакетите в магазина. Данните идват
// ИЗКЛЮЧИТЕЛНО от `active_campaign_theme.packageUnits` (сървърът ги чете от
// campaign_package_earn_rules на АКТИВНАТА кампания — същото число, което
// campaignPurchaseHooks начислява при покупка). Без активна кампания, без
// правило за пакета, с 0 единици или без качена иконка -> празен низ, т.е.
// магазинът изглежда точно както досега. Чисто визуално — не пипа цени,
// плащания или начисляване.

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function getCampaignPackageUnits(packageKey: string): number {
  const units = getActiveCampaignTheme()?.packageUnits?.[packageKey]
  return typeof units === 'number' && Number.isInteger(units) && units > 0 ? units : 0
}

export function renderCampaignPackageUnitsBadge(packageKey: string, iconSizePx: number, fontSizePx?: number): string {
  const theme = getActiveCampaignTheme()
  const units = getCampaignPackageUnits(packageKey)
  if (units === 0 || !theme?.unitIconUrl) return ''
  const amount = new Intl.NumberFormat('bg-BG', { useGrouping: 'always' }).format(units)
  return `<span data-shop-campaign-units="${escapeHtml(packageKey)}" style="display:inline-flex;align-items:center;gap:2px;margin-left:6px;flex:0 0 auto;white-space:nowrap;font-size:${fontSizePx ? `${fontSizePx}px` : '0.82em'};font-weight:900;line-height:1;color:#f8fafc;">+${amount}<img src="${escapeHtml(theme.unitIconUrl)}" alt="" style="width:${iconSizePx}px;height:${iconSizePx}px;margin:-4px 0;object-fit:contain;display:block;flex:0 0 auto;" onerror="this.parentElement.style.display='none'" /></span>`
}
