import type { AdminPaymentListRow, AdminPaymentPeriod } from './adminPaymentsTypes'

export type AdminPaymentsPanelState = {
  isAdmin: boolean
  period: AdminPaymentPeriod
  loading: boolean
  errorText: string | null
  rows: AdminPaymentListRow[]
  total: number
  totalsByCurrency: Record<string, number>
  offset: number
  limit: number
}

export type AdminPaymentsPanelCallbacks = {
  onBack: () => void
  onPeriodChange: (period: AdminPaymentPeriod) => void
  onPageChange: (offset: number) => void
}

export const ADMIN_PAYMENT_PERIODS: AdminPaymentPeriod[] = [
  'today',
  'yesterday',
  'last7days',
  'thisMonth',
  'allTime',
]

export const ADMIN_PAYMENT_PERIOD_LABELS: Record<AdminPaymentPeriod, string> = {
  today: 'Днес',
  yesterday: 'Вчера',
  last7days: 'Последните 7 дни',
  thisMonth: 'Този месец',
  allTime: 'Общо (всички времена)',
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
    const d = new Date(isoUtc)
    return new Intl.DateTimeFormat('bg-BG', {
      timeZone: 'Europe/Sofia',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d)
  } catch {
    return isoUtc
  }
}

function formatCoins(n: number): string {
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
    // Fallback for unknown currency codes
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

function getProfileLabel(row: AdminPaymentListRow): string {
  if (row.displayName) return row.displayName
  if (row.username) return row.username
  return 'Липсващ профил'
}

function shortenSessionId(id: string | null): string {
  if (!id) return '—'
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}…${id.slice(-8)}`
}

// Returns human-readable payment method label.
// walletType takes precedence over paymentMethodType for Google/Apple Pay detection.
export function getPaymentMethodLabel(row: {
  walletType: string | null
  paymentMethodType: string | null
}): string {
  if (row.walletType === 'google_pay') return 'Google Pay'
  if (row.walletType === 'apple_pay') return 'Apple Pay'
  if (row.walletType === 'samsung_pay') return 'Samsung Pay'
  if (row.walletType === 'link') return 'Link'
  if (row.walletType && row.walletType !== '') {
    // Other wallet types: format safely
    return row.walletType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  }
  if (row.paymentMethodType === 'card') return 'Карта'
  if (row.paymentMethodType && row.paymentMethodType !== '') {
    return row.paymentMethodType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  }
  return 'Неизвестен'
}

const CARD_BRAND_LABELS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'Amex',
  discover: 'Discover',
  diners: 'Diners',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  link: 'Link',
  unknown: '',
}

function formatCardBrand(brand: string | null): string {
  if (!brand) return ''
  return CARD_BRAND_LABELS[brand.toLowerCase()] ?? brand
}

function renderRow(row: AdminPaymentListRow): string {
  const profileLabel = getProfileLabel(row)
  const email = row.email ?? '—'
  const sessionId = row.providerCheckoutSessionId
  const sessionShort = shortenSessionId(sessionId)
  const creditedAt = row.creditedAt ? formatSofiaDate(row.creditedAt) : '—'
  const money = formatMoney(row.priceCents, row.currency)
  const coins = formatCoins(row.yellowCoinsAmount)
  const methodLabel = getPaymentMethodLabel(row)
  const brandLabel = formatCardBrand(row.cardBrand)
  const last4 = row.cardLast4 ?? null
  const cardDisplay = brandLabel && last4
    ? `${brandLabel} •••• ${last4}`
    : brandLabel || (last4 ? `•••• ${last4}` : '—')

  const copyBtn = sessionId
    ? ` <button type="button" data-copy-session="${escapeHtml(sessionId)}" title="Копирай пълния Session ID" style="
        background:none;border:1px solid rgba(255,255,255,0.18);border-radius:4px;
        color:rgba(255,255,255,0.5);font-size:10px;padding:1px 6px;cursor:pointer;
        vertical-align:middle;margin-left:4px;
      ">⧉</button>`
    : ''

  return `
    <tr style="border-bottom:1px solid rgba(255,255,255,0.07);">
      <td style="${tdStyle}">${escapeHtml(creditedAt)}</td>
      <td style="${tdStyle}">
        <div style="font-weight:700;color:#fff;">${escapeHtml(profileLabel)}</div>
        <div style="font-size:10px;color:rgba(255,255,255,0.35);">${escapeHtml(row.profileId.slice(0, 8))}…</div>
      </td>
      <td style="${tdStyle}">${escapeHtml(email)}</td>
      <td style="${tdStyle}">
        <div style="font-weight:600;">${escapeHtml(row.packageTitle)}</div>
        <div style="font-size:10px;color:rgba(255,255,255,0.35);">${escapeHtml(row.packageKey)}</div>
      </td>
      <td style="${tdStyle};text-align:right;font-variant-numeric:tabular-nums;">${escapeHtml(coins)} 🟡</td>
      <td style="${tdStyle};text-align:right;font-weight:700;color:#d4a520;font-variant-numeric:tabular-nums;">${escapeHtml(money)}</td>
      <td style="${tdStyle}">${escapeHtml(methodLabel)}</td>
      <td style="${tdStyle};font-variant-numeric:tabular-nums;">${escapeHtml(cardDisplay)}</td>
      <td style="${tdStyle}">
        <span style="background:rgba(34,197,94,0.12);color:#22c55e;border:1px solid rgba(34,197,94,0.3);
          border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700;">${escapeHtml(row.status)}</span>
      </td>
      <td style="${tdStyle};font-family:monospace;font-size:11px;max-width:160px;">
        <span title="${escapeHtml(sessionId ?? '')}">${escapeHtml(sessionShort)}</span>${copyBtn}
      </td>
      <td style="${tdStyle};text-align:center;">
        <button type="button" disabled title="Детайлна страница предстои" style="
          background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:6px;
          color:rgba(255,255,255,0.35);font-size:11px;font-weight:700;padding:4px 10px;cursor:not-allowed;
        ">Детайли</button>
      </td>
    </tr>
  `
}

const thStyle = `
  padding:10px 12px;font-size:10px;font-weight:800;letter-spacing:0.09em;
  text-transform:uppercase;color:rgba(255,255,255,0.4);white-space:nowrap;
  border-bottom:1px solid rgba(255,255,255,0.12);text-align:left;
`

const tdStyle = `padding:11px 12px;font-size:12px;color:rgba(255,255,255,0.8);vertical-align:middle;`

export function renderAdminPaymentsPanel(
  state: AdminPaymentsPanelState,
  callbacks: AdminPaymentsPanelCallbacks,
): string {
  void callbacks

  if (!state.isAdmin) {
    return `<div style="min-height:520px;display:flex;align-items:center;justify-content:center;color:#fecaca;font-size:15px;font-weight:800;">Нямаш достъп.</div>`
  }

  const { period, loading, errorText, rows, total, totalsByCurrency, offset, limit } = state
  const periodLabel = ADMIN_PAYMENT_PERIOD_LABELS[period]

  const periodTabs = ADMIN_PAYMENT_PERIODS.map((p) => {
    const active = p === period
    const label = ADMIN_PAYMENT_PERIOD_LABELS[p]
    return `<button
      type="button"
      data-admin-payments-period="${escapeHtml(p)}"
      aria-pressed="${active ? 'true' : 'false'}"
      style="
        height:34px;padding:0 16px;border-radius:7px;font-size:12px;font-weight:700;
        cursor:pointer;letter-spacing:0.03em;white-space:nowrap;
        border:1px solid ${active ? 'rgba(212,165,32,0.6)' : 'rgba(255,255,255,0.15)'};
        background:${active ? 'rgba(212,165,32,0.12)' : 'transparent'};
        color:${active ? '#d4a520' : 'rgba(255,255,255,0.55)'};
        outline:${active ? '2px solid rgba(212,165,32,0.35)' : 'none'};
        outline-offset:2px;
      "
    >${escapeHtml(label)}</button>`
  }).join('')

  const summaryHtml = (() => {
    if (loading) return ''
    const currencies = Object.keys(totalsByCurrency)
    if (currencies.length === 0) return ''
    return `
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center;margin-bottom:16px;">
        <div style="font-size:12px;color:rgba(255,255,255,0.45);">
          <span style="font-size:22px;font-weight:900;color:#fff;">${total.toLocaleString('bg-BG')}</span>
          <span style="margin-left:6px;">плащания</span>
        </div>
        ${currencies.map(cur => `
          <div style="font-size:12px;color:rgba(255,255,255,0.45);">
            <span style="font-size:20px;font-weight:800;color:#d4a520;">${escapeHtml(formatMoney(totalsByCurrency[cur] ?? 0, cur))}</span>
          </div>
        `).join('')}
      </div>
    `
  })()

  let bodyHtml: string
  if (loading) {
    bodyHtml = `<div style="padding:60px;text-align:center;color:#d4a520;font-size:18px;font-weight:900;">Зареждане…</div>`
  } else if (errorText) {
    bodyHtml = `<div style="padding:40px;text-align:center;color:#fecaca;font-size:14px;font-weight:700;">${escapeHtml(errorText)}</div>`
  } else if (rows.length === 0) {
    bodyHtml = `<div style="padding:60px;text-align:center;color:rgba(255,255,255,0.35);font-size:15px;font-weight:700;">Няма плащания за избрания период.</div>`
  } else {
    const tableRows = rows.map(renderRow).join('')
    bodyHtml = `
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">
        <table style="width:100%;border-collapse:collapse;min-width:1000px;">
          <thead>
            <tr>
              <th style="${thStyle}">Дата (начисляване)</th>
              <th style="${thStyle}">Профил</th>
              <th style="${thStyle}">Имейл</th>
              <th style="${thStyle}">Пакет</th>
              <th style="${thStyle};text-align:right;">Жълтици</th>
              <th style="${thStyle};text-align:right;">Сума</th>
              <th style="${thStyle}">Метод</th>
              <th style="${thStyle}">Карта</th>
              <th style="${thStyle}">Статус</th>
              <th style="${thStyle}">Stripe Session</th>
              <th style="${thStyle};text-align:center;">Действие</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    `
  }

  const hasMore = offset + rows.length < total
  const hasPrev = offset > 0
  const nextOffset = offset + limit
  const prevOffset = Math.max(0, offset - limit)
  const currentPage = Math.floor(offset / limit) + 1
  const totalPages = Math.max(1, Math.ceil(total / limit))

  const paginationHtml = !loading && total > 0 ? `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.08);">
      <div style="font-size:12px;color:rgba(255,255,255,0.4);">
        Страница ${currentPage} от ${totalPages}
        · Резултати ${offset + 1}–${Math.min(offset + rows.length, total)} от ${total.toLocaleString('bg-BG')}
      </div>
      <div style="display:flex;gap:8px;">
        <button type="button" data-admin-payments-page="${prevOffset}" ${!hasPrev ? 'disabled aria-disabled="true"' : ''} style="
          height:34px;padding:0 18px;border-radius:7px;font-size:12px;font-weight:700;cursor:${hasPrev ? 'pointer' : 'not-allowed'};
          border:1px solid rgba(255,255,255,${hasPrev ? '0.25' : '0.1'});background:transparent;
          color:rgba(255,255,255,${hasPrev ? '0.7' : '0.25'});
        ">← Предишна</button>
        <button type="button" data-admin-payments-page="${nextOffset}" ${!hasMore ? 'disabled aria-disabled="true"' : ''} style="
          height:34px;padding:0 18px;border-radius:7px;font-size:12px;font-weight:700;cursor:${hasMore ? 'pointer' : 'not-allowed'};
          border:1px solid rgba(255,255,255,${hasMore ? '0.25' : '0.1'});background:transparent;
          color:rgba(255,255,255,${hasMore ? '0.7' : '0.25'});
        ">Следваща →</button>
      </div>
    </div>
  ` : ''

  return `
    <section style="padding:0 4px;" aria-label="Плащания">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap;">
        <button type="button" data-admin-payments-back="1" style="
          height:36px;padding:0 16px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;
          border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);
          color:rgba(255,255,255,0.7);
        ">← Назад</button>
        <h2 style="font-size:18px;font-weight:800;color:#d4a520;margin:0;letter-spacing:0.04em;text-transform:uppercase;">
          Плащания
        </h2>
        <span style="font-size:13px;color:rgba(255,255,255,0.4);font-weight:600;">${escapeHtml(periodLabel)}</span>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;" role="group" aria-label="Избор на период">
        ${periodTabs}
      </div>

      ${summaryHtml}

      ${bodyHtml}

      ${paginationHtml}
    </section>
  `
}

export function attachAdminPaymentsPanelHandlers(
  root: HTMLElement,
  callbacks: AdminPaymentsPanelCallbacks,
): void {
  root.querySelector<HTMLButtonElement>('[data-admin-payments-back="1"]')?.addEventListener('click', () => {
    callbacks.onBack()
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-payments-period]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.adminPaymentsPeriod ?? 'today'
      callbacks.onPeriodChange(p as AdminPaymentPeriod)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-payments-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return
      const pg = parseInt(btn.dataset.adminPaymentsPage ?? '0', 10)
      callbacks.onPageChange(isNaN(pg) ? 0 : pg)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-copy-session]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.copySession ?? ''
      if (!navigator.clipboard) {
        btn.textContent = '✗'
        setTimeout(() => { btn.textContent = '⧉' }, 1500)
        return
      }
      navigator.clipboard.writeText(id).then(() => {
        btn.textContent = '✓'
        setTimeout(() => { btn.textContent = '⧉' }, 1500)
      }).catch(() => {
        btn.textContent = '✗'
        setTimeout(() => { btn.textContent = '⧉' }, 1500)
      })
    })
  })
}
