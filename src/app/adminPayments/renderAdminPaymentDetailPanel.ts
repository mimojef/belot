import type { AdminPaymentDetailRow } from './adminPaymentsTypes'
import { getPaymentMethodLabel, CARD_BRAND_LABELS } from './renderAdminPaymentsPanel'

export type AdminPaymentDetailState = {
  isAdmin: boolean
  loading: boolean
  errorText: string | null
  purchase: AdminPaymentDetailRow | null
}

export type AdminPaymentDetailCallbacks = {
  onBack: () => void
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatSofiaDate(isoUtc: string): string {
  try {
    return new Intl.DateTimeFormat('bg-BG', {
      timeZone: 'Europe/Sofia',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(isoUtc))
  } catch {
    return isoUtc
  }
}

// VIP редове нямат yellowCoinsAmount (различна domain схема) — виж
// renderAdminPaymentsPanel.ts formatCoins за същия null-safe контракт.
function formatCoins(n: number | null): string {
  if (n === null) return '—'
  return n.toLocaleString('bg-BG')
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('bg-BG', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

function formatCardBrand(brand: string | null): string {
  if (!brand) return ''
  return CARD_BRAND_LABELS[brand.toLowerCase()] ?? brand
}

function copyBtn(id: string, value: string): string {
  return `<button type="button"
    data-copy-detail="${escapeHtml(value)}"
    title="Копирай"
    style="
      background:none;border:1px solid rgba(255,255,255,0.18);border-radius:4px;
      color:rgba(255,255,255,0.5);font-size:10px;padding:1px 6px;cursor:pointer;
      vertical-align:middle;margin-left:6px;
    "
    aria-label="Копирай ${escapeHtml(id)}"
  >⧉</button>`
}

function row(label: string, value: string, extra = ''): string {
  return `
    <tr>
      <td style="padding:9px 12px;font-size:11px;font-weight:700;letter-spacing:0.07em;
        text-transform:uppercase;color:rgba(255,255,255,0.35);white-space:nowrap;
        vertical-align:top;width:180px;">${escapeHtml(label)}</td>
      <td style="padding:9px 12px;font-size:13px;color:rgba(255,255,255,0.85);
        vertical-align:top;word-break:break-all;">${value}${extra}</td>
    </tr>
  `
}

function section(title: string, content: string): string {
  return `
    <div style="margin-bottom:24px;background:#0d0d0d;border:1px solid rgba(255,255,255,0.1);
      border-radius:12px;overflow:hidden;">
      <div style="padding:12px 16px;background:rgba(255,255,255,0.04);
        border-bottom:1px solid rgba(255,255,255,0.08);">
        <h3 style="margin:0;font-size:11px;font-weight:800;letter-spacing:0.12em;
          text-transform:uppercase;color:rgba(255,255,255,0.4);">${escapeHtml(title)}</h3>
      </div>
      <table style="width:100%;border-collapse:collapse;">${content}</table>
    </div>
  `
}

function statusBadge(status: string): string {
  const color = status === 'paid' ? '#22c55e'
    : status === 'pending' ? '#f59e0b'
    : status === 'canceled' ? '#94a3b8'
    : '#ef4444'
  const bg = status === 'paid' ? 'rgba(34,197,94,0.12)'
    : status === 'pending' ? 'rgba(245,158,11,0.12)'
    : status === 'canceled' ? 'rgba(148,163,184,0.12)'
    : 'rgba(239,68,68,0.12)'
  const border = status === 'paid' ? 'rgba(34,197,94,0.3)'
    : status === 'pending' ? 'rgba(245,158,11,0.3)'
    : status === 'canceled' ? 'rgba(148,163,184,0.3)'
    : 'rgba(239,68,68,0.3)'
  return `<span style="background:${bg};color:${color};border:1px solid ${border};
    border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700;">${escapeHtml(status)}</span>`
}

export function renderAdminPaymentDetailPanel(
  state: AdminPaymentDetailState,
  _callbacks: AdminPaymentDetailCallbacks,
): string {
  if (!state.isAdmin) {
    return `<div style="min-height:520px;display:flex;align-items:center;justify-content:center;
      color:#fecaca;font-size:15px;font-weight:800;">Нямаш достъп.</div>`
  }

  const header = `
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap;">
      <button type="button" data-payment-detail-back="1" style="
        height:36px;padding:0 16px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;
        border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);
        color:rgba(255,255,255,0.7);
      ">← Назад</button>
      <h2 style="font-size:18px;font-weight:800;color:#d4a520;margin:0;
        letter-spacing:0.04em;text-transform:uppercase;">Детайли за плащане</h2>
    </div>
  `

  if (state.loading) {
    return `<section style="padding:0 4px;" aria-label="Детайли за плащане">
      ${header}
      <div style="padding:60px;text-align:center;color:#d4a520;font-size:18px;font-weight:900;">Зареждане…</div>
    </section>`
  }

  if (state.errorText) {
    return `<section style="padding:0 4px;" aria-label="Детайли за плащане">
      ${header}
      <div style="padding:40px;text-align:center;color:#fecaca;font-size:14px;font-weight:700;">${escapeHtml(state.errorText)}</div>
    </section>`
  }

  const p = state.purchase
  if (!p) {
    return `<section style="padding:0 4px;" aria-label="Детайли за плащане">
      ${header}
      <div style="padding:40px;text-align:center;color:rgba(255,255,255,0.35);font-size:14px;">Плащането не е намерено.</div>
    </section>`
  }

  const methodLabel = getPaymentMethodLabel({ walletType: p.walletType, paymentMethodType: p.paymentMethodType })
  const brandLabel = formatCardBrand(p.cardBrand)
  const cardDisplay = brandLabel && p.cardLast4
    ? `${brandLabel} •••• ${p.cardLast4}`
    : brandLabel || (p.cardLast4 ? `•••• ${p.cardLast4}` : '—')

  const profileLabel = p.displayName || p.username || 'Липсващ профил'

  const sectionA = section('А. Покупка', [
    row('Дата на създаване', p.createdAt ? escapeHtml(formatSofiaDate(p.createdAt)) : '—'),
    row('Дата на начисляване', p.creditedAt ? escapeHtml(formatSofiaDate(p.creditedAt)) : '—'),
    row('Статус', statusBadge(p.status)),
    row('Пакет', `<strong>${escapeHtml(p.packageTitle)}</strong>${p.packageKey !== null ? ` <span style="color:rgba(255,255,255,0.35);font-size:11px;">${escapeHtml(p.packageKey)}</span>` : ''}`),
    row('Жълтици', p.yellowCoinsAmount !== null ? escapeHtml(formatCoins(p.yellowCoinsAmount)) + ' 🟡' : '—'),
    row('Сума', `<strong style="color:#d4a520;">${escapeHtml(formatMoney(p.priceCents, p.currency))}</strong>`),
  ].join(''))

  const sectionB = section('Б. Клиент', [
    row('Потребител', escapeHtml(profileLabel)),
    row('Profile ID', `<span style="font-family:monospace;font-size:12px;">${escapeHtml(p.profileId)}</span>`, copyBtn('profile-id', p.profileId)),
    row('Account ID', p.accountId ? `<span style="font-family:monospace;font-size:12px;">${escapeHtml(p.accountId)}</span>` : '—'),
    row('Email', p.email ? escapeHtml(p.email) : '—'),
    row('Текущ баланс', p.currentYellowCoinsBalance !== null ? escapeHtml(formatCoins(p.currentYellowCoinsBalance)) + ' 🟡' : '—'),
  ].join(''))

  const sectionC = section('В. Метод на плащане', [
    row('Метод', escapeHtml(methodLabel)),
    row('Карта', escapeHtml(cardDisplay)),
    row('Държава', p.cardCountry ? escapeHtml(p.cardCountry) : '—'),
    row('Checkout Session',
      p.providerCheckoutSessionId
        ? `<span style="font-family:monospace;font-size:11px;">${escapeHtml(p.providerCheckoutSessionId)}</span>`
        : '—',
      p.providerCheckoutSessionId ? copyBtn('checkout-session', p.providerCheckoutSessionId) : '',
    ),
    row('PaymentIntent ID',
      p.stripePaymentIntentId
        ? `<span style="font-family:monospace;font-size:11px;">${escapeHtml(p.stripePaymentIntentId)}</span>`
        : '—',
      p.stripePaymentIntentId ? copyBtn('payment-intent-id', p.stripePaymentIntentId) : '',
    ),
    row('Charge ID',
      p.stripeChargeId
        ? `<span style="font-family:monospace;font-size:11px;">${escapeHtml(p.stripeChargeId)}</span>`
        : '—',
      p.stripeChargeId ? copyBtn('charge-id', p.stripeChargeId) : '',
    ),
  ].join(''))

  const sectionD = section('Г. Системна информация', [
    row('Purchase ID',
      `<span style="font-family:monospace;font-size:12px;">${escapeHtml(p.purchaseId)}</span>`,
      copyBtn('purchase-id', p.purchaseId),
    ),
    row('Provider', escapeHtml(p.provider)),
    row('Актуализирано', p.updatedAt ? escapeHtml(formatSofiaDate(p.updatedAt)) : '—'),
    row('Скрито от потребител', p.hiddenAt ? escapeHtml(formatSofiaDate(p.hiddenAt)) : '—'),
  ].join(''))

  return `
    <section style="padding:0 4px;max-width:760px;" aria-label="Детайли за плащане">
      ${header}
      ${sectionA}
      ${sectionB}
      ${sectionC}
      ${sectionD}
    </section>
  `
}

export function attachAdminPaymentDetailHandlers(
  root: HTMLElement,
  callbacks: AdminPaymentDetailCallbacks,
): void {
  root.querySelector<HTMLButtonElement>('[data-payment-detail-back="1"]')?.addEventListener('click', () => {
    callbacks.onBack()
  })

  root.querySelectorAll<HTMLButtonElement>('[data-copy-detail]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.copyDetail ?? ''
      if (!navigator.clipboard) {
        btn.textContent = '✗'
        setTimeout(() => { btn.textContent = '⧉' }, 1500)
        return
      }
      navigator.clipboard.writeText(value).then(() => {
        btn.textContent = '✓'
        setTimeout(() => { btn.textContent = '⧉' }, 1500)
      }).catch(() => {
        btn.textContent = '✗'
        setTimeout(() => { btn.textContent = '⧉' }, 1500)
      })
    })
  })
}
