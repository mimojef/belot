import type { CampaignGrantedRewardSummary } from '../../app/network/createGameServerClient'

/**
 * Фаза 9 — поздравителен popup за ДЕЙСТВИТЕЛНО предоставени кампанийни
 * награди (жълтици/VIP дни/подарък), ОТДЕЛЕН от "спечелени тематични
 * единици" (вече показани в Белот/Ludo End Game екраните, Фаза 6/7).
 *
 * Данните идват ИЗКЛЮЧИТЕЛНО от campaign_reward_notifications редове
 * (campaignCreditStore.ts::listPendingNotifications), записани САМО когато
 * наградата реално е предоставена (grantYellowCoinsInline/grantVipDaysInline/
 * grantCampaignGiftItemInline са вече изпълнени успешно в същата
 * транзакция, виж creditCore/grantDueRewardsInCurrentTransaction) — никога
 * само защото прагът е достигнат. Неуспешна gift-item доставка НЕ създава
 * известие (campaign_reward_claims ред не се пише), затова никога не се
 * появява тук, докато retryPendingGiftReward не я предостави успешно по-късно
 * (което пише НОВО известие за самата нея).
 *
 * `CampaignRewardCongratulationsGroup` е ЕДНА или НЯКОЛКО durable
 * notification redове, слети от controller-а (виж
 * createLobbyFlowController.ts::enqueueCampaignRewardNotifications) по
 * campaignId — "Не смесвай награди от различни кампании" (§4) means всеки
 * group е single-campaign; множество durable редове за СЪЩАТА кампания
 * (напр. един нормален grant + един по-късен successful gift retry) се
 * показват в ЕДИН popup. `notificationIds` носи ВСИЧКИТЕ слети
 * notification_id-та — затварянето на popup-а acknowledge-ва всички
 * наведнъж (виж onClose call site-а в контролера).
 */
export type CampaignRewardCongratulationsGroup = {
  campaignId: string
  campaignName: string
  unitNameSingular: string
  unitNamePlural: string
  unitIconUrl?: string | null
  unitsTotal: number
  rewards: CampaignGrantedRewardSummary[]
  notificationIds: string[]
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatNumber(amount: number): string {
  return new Intl.NumberFormat('bg-BG', { useGrouping: 'always' }).format(amount)
}

function formatUnitsLabel(amount: number, singular: string, plural: string): string {
  const unitLabel = Math.abs(amount) === 1 ? singular : plural
  return `${formatNumber(amount)} ${escapeHtml(unitLabel)}`
}

function formatVipIntervalLabel(unit: 'days' | 'months' | 'years', amount: number): string {
  const words: Record<'days' | 'months' | 'years', [string, string]> = {
    days: ['ден', 'дни'],
    months: ['месец', 'месеца'],
    years: ['година', 'години'],
  }
  const [singular, plural] = words[unit]
  return `${amount} ${amount === 1 ? singular : plural}`
}

type GiftRewardGroupKey = string

/**
 * §10 "Количество, ако са предоставени няколко" — ЕДИНСТВЕНО за gift_item
 * (yellow_coins/vip_days остават отделни редове, mirror на §4's example,
 * "без загуба на точност"). Групира по (giftItemId+senderDisplayName) —
 * различен подател (напр. admin смени marketing подателя между два прага)
 * никога не се обединява под един ред.
 */
function groupGiftItemRewards(
  rewards: Array<Extract<CampaignGrantedRewardSummary, { type: 'gift_item' }>>,
): Array<{ reward: Extract<CampaignGrantedRewardSummary, { type: 'gift_item' }>; count: number }> {
  const order: GiftRewardGroupKey[] = []
  const byKey = new Map<GiftRewardGroupKey, { reward: Extract<CampaignGrantedRewardSummary, { type: 'gift_item' }>; count: number }>()
  for (const reward of rewards) {
    const key = `${reward.giftItemId}::${reward.senderDisplayName}`
    const existing = byKey.get(key)
    if (existing) {
      existing.count += 1
      continue
    }
    byKey.set(key, { reward, count: 1 })
    order.push(key)
  }
  return order.map((key) => byKey.get(key)!)
}

function renderRewardRowHtml(reward: CampaignGrantedRewardSummary): string {
  if (reward.type === 'yellow_coins') {
    return `
      <div data-campaign-congrats-reward-row="1" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);">
        <img src="/assets/lobby/icon-coin.png" alt="" style="width:26px;height:26px;object-fit:contain;flex:0 0 auto;" />
        <div style="font-size:15px;font-weight:900;color:#f8fafc;">${formatNumber(reward.amount)} жълтици</div>
      </div>
    `
  }

  if (reward.type === 'vip_days') {
    return `
      <div data-campaign-congrats-reward-row="1" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:rgba(212,165,32,0.08);border:1px solid rgba(212,165,32,0.35);">
        <span style="font-size:20px;flex:0 0 auto;" aria-hidden="true">👑</span>
        <div style="font-size:15px;font-weight:900;color:#d4a520;">${formatVipIntervalLabel(reward.interval.unit, reward.interval.amount)} VIP</div>
      </div>
    `
  }

  // gift_item — реалната снимка/име от каталога + видимия marketing подател.
  const imageHtml = reward.imageUrl
    ? `<img src="${escapeHtml(reward.imageUrl)}" alt="${escapeHtml(reward.name)}" style="width:72px;height:72px;object-fit:contain;flex:0 0 auto;border-radius:10px;background:rgba(255,255,255,0.04);" onerror="this.style.display='none'" />`
    : `<div style="width:72px;height:72px;flex:0 0 auto;border-radius:10px;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center;font-size:30px;" aria-hidden="true">🎁</div>`

  return `
    <div data-campaign-congrats-reward-row="1" data-campaign-congrats-reward-row-gift="1" style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px;border-radius:12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);text-align:center;">
      ${imageHtml}
      <div style="font-size:15px;font-weight:900;color:#f8fafc;overflow-wrap:anywhere;">${escapeHtml(reward.name)}</div>
      <div style="font-size:12px;font-weight:700;color:rgba(226,232,240,0.70);">От: ${escapeHtml(reward.senderDisplayName)}</div>
    </div>
  `
}

function renderGiftRewardRowWithCountHtml(entry: { reward: Extract<CampaignGrantedRewardSummary, { type: 'gift_item' }>; count: number }): string {
  const base = renderRewardRowHtml(entry.reward)
  if (entry.count <= 1) return base
  return base.replace(
    `${escapeHtml(entry.reward.name)}</div>`,
    `${escapeHtml(entry.reward.name)} <span style="color:#d4a520;">× ${entry.count}</span></div>`,
  )
}

/** "Събрахте X {единица}!" — unitsTotal е авторитетният тотал от payload-а. */
function renderCollectedHtml(group: CampaignRewardCongratulationsGroup): string {
  return `Събрахте ${formatUnitsLabel(group.unitsTotal, group.unitNameSingular.toLocaleLowerCase('bg-BG'), group.unitNamePlural.toLocaleLowerCase('bg-BG'))}!`
}

/**
 * "Печелите X жълтици!" — X е сумата на ВСИЧКИ показани (вече начислени)
 * жълтици. При смесени награди се изброяват и VIP периодите/подаръците, за
 * да не изглежда, че всичко е жълтици.
 */
function renderWinningsHeadline(rewards: CampaignGrantedRewardSummary[]): string {
  const parts: string[] = []
  const coinsTotal = rewards.reduce((sum, r) => (r.type === 'yellow_coins' ? sum + r.amount : sum), 0)
  if (coinsTotal > 0) parts.push(`${formatNumber(coinsTotal)} жълтици`)

  const vipTotals: Record<'days' | 'months' | 'years', number> = { days: 0, months: 0, years: 0 }
  for (const r of rewards) if (r.type === 'vip_days') vipTotals[r.interval.unit] += r.interval.amount
  const vipParts = (['years', 'months', 'days'] as const)
    .filter((unit) => vipTotals[unit] > 0)
    .map((unit) => formatVipIntervalLabel(unit, vipTotals[unit]))
  if (vipParts.length > 0) parts.push(`${vipParts.join(' и ')} VIP`)

  const giftCount = rewards.filter((r) => r.type === 'gift_item').length
  if (giftCount === 1) parts.push('подарък')
  else if (giftCount > 1) parts.push(`${giftCount} подаръка`)

  if (parts.length === 0) return ''
  const joined = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} и ${parts[parts.length - 1]}`
  return `Печелите ${joined}!`
}

function renderHeroIconHtml(group: CampaignRewardCongratulationsGroup): string {
  const emojiHtml = `<div data-campaign-congrats-hero-emoji="1" style="font-size:36px;line-height:1;" aria-hidden="true">🎉</div>`
  if (!group.unitIconUrl) return `<div style="margin-bottom:8px;">${emojiHtml}</div>`
  return `
    <div style="display:flex;justify-content:center;margin-bottom:6px;">
      <img data-campaign-congrats-unit-icon="1" src="${escapeHtml(group.unitIconUrl)}" alt="" style="width:60px;height:60px;object-fit:contain;display:block;" onerror="this.style.display='none';this.nextElementSibling.style.display='block'" />
      <div style="display:none;">${emojiHtml}</div>
    </div>
  `
}

export function renderCampaignRewardCongratulationsPopup(
  group: CampaignRewardCongratulationsGroup | null,
  skipAnimation?: boolean,
): string {
  if (group === null) return ''

  const giftRewards = group.rewards.filter((r): r is Extract<CampaignGrantedRewardSummary, { type: 'gift_item' }> => r.type === 'gift_item')
  const nonGiftRewards = group.rewards.filter((r) => r.type !== 'gift_item')
  const groupedGiftRewards = groupGiftItemRewards(giftRewards)

  const rewardRowsHtml = [
    ...nonGiftRewards.map((r) => renderRewardRowHtml(r)),
    ...groupedGiftRewards.map((entry) => renderGiftRewardRowWithCountHtml(entry)),
  ].join('')

  return `
    <style>
      @keyframes belot-campaign-congrats-fade-in {
        0% { opacity:0; transform:translateY(12px) scale(0.98); }
        100% { opacity:1; transform:translateY(0) scale(1); }
      }
      @keyframes belot-campaign-congrats-backdrop-in {
        0% { opacity:0; }
        100% { opacity:1; }
      }
      @media (max-width: 480px) {
        [data-campaign-congrats-card="1"] {
          width:100% !important;
          max-height:100% !important;
          border-radius:0 !important;
        }
      }
    </style>
    <div
      data-campaign-reward-congratulations-backdrop="1"
      style="
        position:fixed;
        inset:0;
        z-index:14200;
        background:rgba(0,0,0,0.76);
        -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);
        display:flex;
        align-items:center;
        justify-content:center;
        padding:20px;
        box-sizing:border-box;
        animation:${skipAnimation ? 'none' : 'belot-campaign-congrats-backdrop-in 140ms ease both'};
      "
    >
      <div
        data-campaign-congrats-card="1"
        role="dialog"
        aria-modal="true"
        aria-label="Поздравления"
        class="gold-scrollbar"
        style="
          box-sizing:border-box;
          width:min(92vw, 420px);
          max-height:min(88vh, 720px);
          overflow:auto;
          border-radius:16px;
          background:linear-gradient(180deg, rgba(32,32,32,0.98) 0%, rgba(8,8,8,0.99) 100%);
          border:2px solid rgba(212,165,32,0.72);
          box-shadow:0 34px 80px rgba(0,0,0,0.5);
          padding:22px 20px 20px;
          text-align:center;
          animation:${skipAnimation ? 'none' : 'belot-campaign-congrats-fade-in 180ms ease both'};
        "
      >
        ${renderHeroIconHtml(group)}
        <div data-campaign-congrats-title="1" style="font-size:24px;font-weight:900;color:#f8fafc;line-height:1.25;">Поздравления!</div>
        <div data-campaign-congrats-collected="1" style="margin-top:4px;font-size:15px;font-weight:800;color:rgba(226,232,240,0.88);overflow-wrap:anywhere;">${renderCollectedHtml(group)}</div>

        <div data-campaign-congrats-rewards-heading="1" style="margin-top:14px;font-size:18px;font-weight:900;color:#d4a520;line-height:1.3;overflow-wrap:anywhere;">${renderWinningsHeadline(group.rewards)}</div>

        <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">
          ${rewardRowsHtml}
        </div>

        <div data-campaign-congrats-credited-note="1" style="margin-top:12px;font-size:13px;font-weight:400;color:rgba(203,213,225,0.82);">Наградата ви е начислена.</div>

        <button
          type="button"
          data-campaign-reward-congratulations-close="1"
          style="
            margin-top:14px;
            width:100%;
            min-height:50px;
            padding:0 28px;
            border:0;
            border-radius:12px;
            background:linear-gradient(135deg,#f4c95b 0%,#c98f13 100%);
            color:#000000;
            font-size:18px;
            font-weight:900;
            cursor:pointer;
          "
        >ОК</button>
      </div>
    </div>
  `
}

export type CampaignRewardCongratulationsPopupOptions = {
  onClose: () => void
}

export function attachCampaignRewardCongratulationsPopupEventListeners(
  root: ParentNode,
  options: CampaignRewardCongratulationsPopupOptions,
): void {
  // Само "ОК" затваря (и потвърждава) — случаен клик извън картата не
  // трябва да "изяде" известието, преди играчът да е видял наградите.
  root.querySelector('[data-campaign-reward-congratulations-close="1"]')?.addEventListener('click', () => {
    options.onClose()
  })
}
