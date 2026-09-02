import type {
  AdminRegisteredProfilesPeriod,
  AdminRegisteredProfileRow,
} from '../network/createGameServerClient'

export type AdminRegisteredProfilesModalState = {
  isOpen: boolean
  period: AdminRegisteredProfilesPeriod
  loading: boolean
  errorText: string | null
  rows: AdminRegisteredProfileRow[] | null
  /** Само за period==='all' — 1-based текуща страница (100 реда на страница). */
  page: number
  /** Само за period==='all' — общ брой регистрирани human профили (за "Страница X от Y"). */
  totalCount: number | null
}

const PERIOD_TITLES: Record<AdminRegisteredProfilesPeriod, string> = {
  today: 'Регистрирани профили — Днес',
  yesterday: 'Регистрирани профили — Вчера',
  all: 'Регистрирани профили — Всички',
}

const REGISTERED_PROFILES_PAGE_SIZE = 100

function fmtDate(iso: string): string {
  try {
    // created_at идва като SQLite UTC текст "YYYY-MM-DD HH:MM:SS" — Date parse-va го коректно.
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString('bg-BG', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
  } catch {
    return '—'
  }
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleTimeString('bg-BG', {
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

export function renderAdminRegisteredProfilesModal(
  state: AdminRegisteredProfilesModalState,
  esc: (s: string) => string,
): string {
  if (!state.isOpen) return ''

  let bodyHtml: string
  if (state.loading) {
    bodyHtml = `
      <div style="min-height:160px;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:14px;font-weight:800;">
        Зареждане...
      </div>
    `
  } else if (state.errorText) {
    bodyHtml = `
      <div style="min-height:120px;display:flex;align-items:center;justify-content:center;color:#fecaca;font-size:13px;font-weight:700;text-align:center;padding:0 16px;">
        ${esc(state.errorText)}
      </div>
    `
  } else if (!state.rows || state.rows.length === 0) {
    bodyHtml = `
      <div style="min-height:120px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.45);font-size:13px;font-style:italic;text-align:center;padding:0 16px;">
        Няма регистрирани профили за този период.
      </div>
    `
  } else {
    const rows = state.rows.map((r) => {
      const username = r.username?.trim() || r.displayName
      const email = r.email ?? '—'
      // riskDetected/linkedProfilesCount идват само за пълен admin viewer
      // (виж handleAdminRegisteredProfilesListRequest) — за subadmin просто
      // отсъстват, редът рендерира нормално без risk индикация.
      const isRisky = r.riskDetected === true
      const nameColor = isRisky ? '#ef4444' : '#ffffff'
      // riskCheckComplete===false = профилът е бил намерен само indirectly
      // (linked partner на друг target) — linkedProfilesCount е груб/частичен,
      // НЕ показвай го като точен (production QA fix). Показваме кратък
      // badge без число вместо това; след като профилът получи собствен full
      // analysis (следващ list fetch, докато самият той е в target batch-а),
      // riskCheckComplete става true и точното "Свързани: N" се показва.
      const riskBadge = isRisky
        ? (r.riskCheckComplete === false
          ? `<span style="margin-left:8px;font-size:10px;font-weight:800;color:#ef4444;background:rgba(239,68,68,0.14);border:1px solid rgba(239,68,68,0.45);border-radius:999px;padding:2px 8px;white-space:nowrap;">Свързан профил</span>`
          : `<span style="margin-left:8px;font-size:10px;font-weight:800;color:#ef4444;background:rgba(239,68,68,0.14);border:1px solid rgba(239,68,68,0.45);border-radius:999px;padding:2px 8px;white-space:nowrap;">Свързани: ${r.linkedProfilesCount ?? 0}</span>`)
        : ''
      return `
        <tr>
          <td style="padding:8px 10px;font-size:12px;color:rgba(255,255,255,0.65);white-space:nowrap;border-bottom:1px solid rgba(255,255,255,0.06);">${esc(fmtDate(r.createdAt))}</td>
          <td style="padding:8px 10px;font-size:12px;color:rgba(255,255,255,0.65);white-space:nowrap;border-bottom:1px solid rgba(255,255,255,0.06);">${esc(fmtTime(r.createdAt))}</td>
          <td style="padding:8px 10px;font-size:12px;border-bottom:1px solid rgba(255,255,255,0.06);word-break:break-word;">
            <button
              type="button"
              data-admin-registered-profiles-open-profile="${esc(r.profileId)}"
              style="background:none;border:none;padding:0;margin:0;cursor:pointer;font:inherit;font-size:12px;color:${nameColor};font-weight:700;text-decoration:underline;text-underline-offset:2px;text-align:left;"
            >${esc(username)}</button>${riskBadge}
          </td>
          <td style="padding:8px 10px;font-size:12px;color:rgba(255,255,255,0.55);border-bottom:1px solid rgba(255,255,255,0.06);word-break:break-word;">${esc(email)}</td>
        </tr>
      `
    }).join('')

    const paginationHtml = state.period === 'all' && state.totalCount !== null
      ? (() => {
          const totalPages = Math.max(1, Math.ceil(state.totalCount! / REGISTERED_PROFILES_PAGE_SIZE))
          const canPrev = state.page > 1
          const canNext = state.page < totalPages
          return `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);">
              <button
                type="button"
                data-admin-registered-profiles-page="prev"
                ${canPrev ? '' : 'disabled'}
                style="
                  min-height:34px;padding:0 14px;border:1px solid rgba(212,165,32,0.4);
                  border-radius:6px;background:${canPrev ? '#111' : 'rgba(255,255,255,0.04)'};
                  color:${canPrev ? '#d4a520' : 'rgba(255,255,255,0.3)'};font-size:12px;font-weight:800;
                  cursor:${canPrev ? 'pointer' : 'default'};
                "
              >← Предишна</button>
              <div style="font-size:12px;color:rgba(255,255,255,0.55);white-space:nowrap;">
                Страница ${state.page} от ${totalPages} · общо ${state.totalCount!.toLocaleString('bg-BG')}
              </div>
              <button
                type="button"
                data-admin-registered-profiles-page="next"
                ${canNext ? '' : 'disabled'}
                style="
                  min-height:34px;padding:0 14px;border:1px solid rgba(212,165,32,0.4);
                  border-radius:6px;background:${canNext ? '#111' : 'rgba(255,255,255,0.04)'};
                  color:${canNext ? '#d4a520' : 'rgba(255,255,255,0.3)'};font-size:12px;font-weight:800;
                  cursor:${canNext ? 'pointer' : 'default'};
                "
              >Следваща →</button>
            </div>
          `
        })()
      : ''

    bodyHtml = `
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;min-width:480px;">
          <thead>
            <tr style="position:sticky;top:0;background:#141414;">
              <th style="padding:8px 10px;font-size:10px;text-align:left;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.06em;">Дата</th>
              <th style="padding:8px 10px;font-size:10px;text-align:left;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.06em;">Час</th>
              <th style="padding:8px 10px;font-size:10px;text-align:left;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.06em;">Потребителско име</th>
              <th style="padding:8px 10px;font-size:10px;text-align:left;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.06em;">Имейл</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${paginationHtml}
    `
  }

  return `
    <style>
      @keyframes belot-admin-registered-profiles-backdrop-in {
        0% { opacity:0; }
        100% { opacity:1; }
      }
      @keyframes belot-admin-registered-profiles-card-in {
        0% { opacity:0; transform:translateY(12px) scale(0.98); }
        100% { opacity:1; transform:translateY(0) scale(1); }
      }
      @media (max-width: 640px) {
        [data-admin-registered-profiles-card="1"] {
          position:fixed !important;
          inset:0 !important;
          width:100% !important;
          max-height:100% !important;
          height:100% !important;
          border-radius:0 !important;
          border-left:none !important;
          border-right:none !important;
          border-top:none !important;
          border-bottom:none !important;
        }
      }
    </style>
    <div
      data-admin-registered-profiles-root="1"
      style="position:fixed;inset:0;z-index:12000;pointer-events:auto;"
    >
      <div
        data-admin-registered-profiles-backdrop="1"
        style="
          position:absolute;inset:0;background:rgba(0,0,0,0.72);
          -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);
          animation:belot-admin-registered-profiles-backdrop-in 140ms ease both;
        "
      ></div>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;">
        <div
          data-admin-registered-profiles-card="1"
          role="dialog"
          aria-modal="true"
          aria-label="${esc(PERIOD_TITLES[state.period])}"
          class="gold-scrollbar"
          style="
            position:relative;box-sizing:border-box;width:min(92vw, 680px);
            max-height:min(85vh, 720px);overflow:auto;border-radius:8px;
            background:linear-gradient(180deg, rgba(32,32,32,0.98) 0%, rgba(8,8,8,0.99) 100%);
            border:2px solid rgba(212,165,32,0.72);box-shadow:0 34px 80px rgba(0,0,0,0.42);
            padding:20px 20px 18px;
            animation:belot-admin-registered-profiles-card-in 160ms ease both;
          "
        >
          <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px;">
            <div style="font-size:15px;font-weight:800;color:#d4a520;letter-spacing:0.02em;min-width:0;overflow-wrap:break-word;">
              ${esc(PERIOD_TITLES[state.period])}
            </div>
            <button
              type="button"
              data-admin-registered-profiles-close="1"
              aria-label="Затвори"
              style="
                width:38px;height:38px;border:none;border-radius:999px;
                background:rgba(255,255,255,0.08);color:#f8fafc;font-size:20px;
                font-weight:900;cursor:pointer;flex:0 0 auto;
              "
            >×</button>
          </div>
          ${bodyHtml}
        </div>
      </div>
    </div>
  `
}
