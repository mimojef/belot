// Споделена popup markup/CSS между renderPrivateRoomWaitingScreen.ts (member
// waiting room) и renderLobbyScreen.ts (списъка "Частни маси" — директен "+"
// join). И двата екрана трябва да показват идентичния join-confirm и
// X-only blocked-partner popup, но никога не са монтирани едновременно
// (само едно currentScreen наведнъж), затова споделянето на markup/CSS тук
// е безопасно — еднакви data-* атрибути, wiring-ът се прави отделно във
// всеки от двата файла (различни render/wire дървета).
import type { Team } from '../network/createGameServerClient'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const PRIVATE_ROOM_POPUP_STYLES = `
  .prw-popup-backdrop {
    position:fixed;
    inset:0;
    z-index:9400;
    background:rgba(0,0,0,0.7);
    display:flex;
    align-items:center;
    justify-content:center;
    padding:20px;
  }

  .prw-popup-box {
    position:relative;
    width:min(100%, 380px);
    background:#1a1a2e;
    border:1px solid rgba(212,165,32,0.35);
    border-radius:14px;
    padding:20px;
    display:grid;
    gap:12px;
  }

  .prw-popup-title {
    font-size:15px;
    font-weight:900;
    color:#f4c95b;
  }

  .prw-popup-text {
    font-size:13px;
    font-weight:600;
    color:#f8fafc;
    line-height:1.5;
  }

  .prw-popup-actions {
    display:flex;
    gap:10px;
  }

  .prw-popup-close-x {
    position:absolute;
    top:10px;
    right:10px;
    width:28px;
    height:28px;
    border-radius:50%;
    border:1px solid rgba(255,255,255,0.18);
    background:rgba(255,255,255,0.06);
    color:#f8fafc;
    font-size:14px;
    cursor:pointer;
  }

  .prw-confirm-yes,
  .prw-confirm-cancel {
    flex:1;
    height:40px;
    border-radius:8px;
    font-size:13px;
    font-weight:900;
    cursor:pointer;
  }

  .prw-confirm-yes {
    border:0;
    background:linear-gradient(180deg, #f4c95b 0%, #c98f13 100%);
    color:#101010;
  }

  .prw-confirm-cancel {
    border:1px solid rgba(255,255,255,0.18);
    background:transparent;
    color:rgba(255,255,255,0.75);
  }

  .prw-confirm-yes.prw-confirm-danger {
    background:#ef4444;
    color:#fff;
  }

  .prw-invite-box {
    width:min(100%, 420px);
    max-height:80vh;
  }

  .prw-invite-list {
    overflow-y:auto;
    max-height:min(60vh, 420px);
    display:grid;
    gap:8px;
  }

  .prw-invite-empty {
    text-align:center;
    padding:28px 0;
    color:rgba(248,250,252,0.5);
    font-size:13px;
  }

  .prw-invite-row {
    display:flex;
    align-items:center;
    gap:10px;
    padding:8px;
    border-radius:10px;
    background:rgba(255,255,255,0.03);
  }

  .prw-invite-avatar {
    width:40px;
    height:40px;
    border-radius:50%;
    overflow:hidden;
    flex-shrink:0;
    border:1.5px solid rgba(212,165,32,0.4);
  }

  .prw-invite-avatar-img {
    width:100%;
    height:100%;
    object-fit:cover;
  }

  .prw-invite-avatar-fallback {
    width:100%;
    height:100%;
    display:flex;
    align-items:center;
    justify-content:center;
    font-size:18px;
  }

  .prw-invite-info {
    flex:1;
    min-width:0;
  }

  .prw-invite-name {
    font-size:13px;
    font-weight:700;
    color:#f8fafc;
    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap;
  }

  .prw-invite-status {
    font-size:11px;
    margin-top:1px;
  }

  .prw-invite-status-online {
    color:#4ade80;
  }

  .prw-invite-status-offline {
    color:rgba(248,250,252,0.45);
  }

  .prw-invite-status-busy {
    color:#f87171;
  }

  .prw-invite-send-btn {
    flex-shrink:0;
    height:32px;
    padding:0 14px;
    border-radius:8px;
    border:0;
    background:linear-gradient(180deg, #f4c95b 0%, #c98f13 100%);
    color:#101010;
    font-size:12px;
    font-weight:800;
    cursor:pointer;
  }

  .prw-invite-send-btn:disabled {
    background:rgba(255,255,255,0.10);
    color:rgba(248,250,252,0.4);
    cursor:not-allowed;
  }

  .prw-partner-picker-box {
    overflow-y:auto;
    overscroll-behavior:contain;
  }

  .prw-partner-search {
    width:100%;
    height:40px;
    box-sizing:border-box;
    padding:0 12px;
    border-radius:8px;
    border:1px solid rgba(255,255,255,0.16);
    background:#141414;
    color:#f8fafc;
    /* 16px — iOS Safari не zoom-ва при focus. */
    font-size:16px;
    font-weight:600;
    outline:none;
  }

  .prw-partner-list {
    max-height:min(50vh, 380px);
    overscroll-behavior:contain;
  }

  .prw-invite-row[hidden],
  .prw-invite-empty[hidden] {
    display:none;
  }
`

// ─── Глобални известия за частната маса (към домакина) ──────────────────
// Рендерират се в собствен контейнер в document.body (виж
// syncPrivateRoomNoticeHost в createLobbyFlowController.ts) — НЕ в root-а на
// лобито, така че появата/изчезването им не прерисува страницата (скролът в
// "Теми", отворените панели и полетата остават непокътнати). Не блокират
// сайта: без backdrop, само картичката приема кликове. Не се скриват с
// таймер — само при действие, нов snapshot или при крайния срок на масата.

export type PrivateRoomPartnerNoticeView = {
  kind: 'declined' | 'expired' | 'unavailable' | 'accepted'
  toDisplayName: string
}

export const PRIVATE_ROOM_MANUAL_START_READY_TEXT =
  'Създадената от теб маса се запълни. Всички играчи са готови. Върни се, за да стартираш играта.'

export function getPrivateRoomPartnerNoticeText(notice: PrivateRoomPartnerNoticeView): string {
  switch (notice.kind) {
    case 'declined':
      return `${notice.toDisplayName} отказа твоята покана за партньор.`
    case 'expired':
      return `Изтекоха 60 секунди. ${notice.toDisplayName} не отговори на поканата.`
    case 'unavailable':
      return `${notice.toDisplayName} не може да приеме поканата.`
    case 'accepted':
      return `${notice.toDisplayName} прие поканата ти и седна на масата.`
  }
}

// flex-basis 140px: при картичка под ~300px съдържание (телефон 320px) двата
// бутона минават един под друг; min-height 44px — удобна цел за пръст.
const NOTICE_BUTTON_BASE = 'flex:1 1 140px;min-height:44px;padding:8px 12px;border-radius:10px;font-family:inherit;font-size:14px;font-weight:900;line-height:1.2;cursor:pointer;white-space:normal;overflow-wrap:anywhere;'
const NOTICE_BUTTON_PRIMARY = `${NOTICE_BUTTON_BASE}border:0;background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;`
const NOTICE_BUTTON_SECONDARY = `${NOTICE_BUTTON_BASE}border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.88);`

// 'inline' — в чакалнята: в потока на екрана (под бутоните), без да закрива
// СТАРТ или полето за чат.
export type PrivateRoomNoticePlacement = 'bottom' | 'inline'

function renderPrivateRoomNoticeCard(params: {
  dataAttr: string
  title: string
  text: string
  accent: 'violet' | 'green' | 'gold'
  actionsHtml: string
  placement: PrivateRoomNoticePlacement
}): string {
  const border = params.accent === 'green' ? 'rgba(74,222,128,0.5)' : params.accent === 'gold' ? 'rgba(244,201,91,0.6)' : 'rgba(167,139,250,0.55)'
  const titleColor = params.accent === 'green' ? '#86efac' : params.accent === 'gold' ? '#f4c95b' : 'rgba(196,181,253,0.85)'
  return `
    <style>
      /* Лоби: долу (мобилното лоби няма долна навигация — менюто е горе).
         Чакалня: в потока на екрана. Отстъпи по safe-area
         (notch/системни ленти); никога по-широко от екрана; при много дълъг
         текст картичката се свива по височина и скролира вътрешно. */
      .prw-partner-notice {
        position:fixed;
        left:50%;
        transform:translateX(-50%);
        z-index:9050;
        width:min(440px, calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
        max-height:calc(100dvh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
        overflow-y:auto;
        overscroll-behavior:contain;
        box-sizing:border-box;
        pointer-events:auto;
        font-family:Inter, Arial, sans-serif;
      }
      .prw-partner-notice[data-placement="bottom"] {
        bottom:calc(24px + env(safe-area-inset-bottom, 0px));
      }
      .prw-partner-notice[data-placement="inline"] {
        position:static;
        left:auto;
        transform:none;
        width:100%;
        max-height:none;
        overflow:visible;
      }
      @media (max-width: 640px) {
        .prw-partner-notice[data-placement="bottom"] {
          bottom:calc(12px + env(safe-area-inset-bottom, 0px));
        }
      }
    </style>
    <div class="prw-partner-notice" data-placement="${params.placement}" ${params.dataAttr} role="status" aria-live="polite">
      <div style="background:linear-gradient(160deg,#1c1c33,#13132a);border:1.5px solid ${border};border-radius:14px;padding:14px;box-shadow:0 10px 36px rgba(0,0,0,0.75);display:grid;gap:10px;box-sizing:border-box;">
        <div style="font-size:11px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:${titleColor};">${escapeHtml(params.title)}</div>
        <div data-private-room-notice-text="1" style="font-size:15px;font-weight:700;color:#ffffff;line-height:1.4;overflow-wrap:anywhere;">${escapeHtml(params.text)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">${params.actionsHtml}</div>
      </div>
    </div>
  `
}

export function renderPrivateRoomPartnerNotice(params: {
  notice: PrivateRoomPartnerNoticeView | null
  busy: boolean
  placement: PrivateRoomNoticePlacement
}): string {
  const notice = params.notice
  if (notice === null) return ''
  const disabled = params.busy ? 'disabled' : ''
  const actionsHtml = notice.kind === 'accepted'
    ? `<button type="button" data-private-room-partner-notice-dismiss="1" style="${NOTICE_BUTTON_PRIMARY}" ${disabled}>ОК</button>`
    : `
      <button type="button" data-private-room-partner-notice-invite="1" style="${NOTICE_BUTTON_PRIMARY}" ${disabled}>Покани друг</button>
      <button type="button" data-private-room-partner-notice-release="1" style="${NOTICE_BUTTON_SECONDARY}" ${disabled}>Освободи мястото</button>
    `
  return renderPrivateRoomNoticeCard({
    dataAttr: `data-private-room-partner-notice="${notice.kind}"`,
    title: 'Покана за партньор',
    text: getPrivateRoomPartnerNoticeText(notice),
    accent: notice.kind === 'accepted' ? 'green' : 'violet',
    actionsHtml,
    placement: params.placement,
  })
}

// Маса с ръчен старт е 4/4 и чака домакина ("Изчакай в лоби").
export function renderPrivateRoomManualStartReadyNotice(placement: PrivateRoomNoticePlacement): string {
  return renderPrivateRoomNoticeCard({
    dataAttr: 'data-private-room-manual-start-notice="1"',
    title: 'Частна маса',
    text: PRIVATE_ROOM_MANUAL_START_READY_TEXT,
    accent: 'gold',
    actionsHtml: `<button type="button" data-private-room-manual-start-notice-open="1" style="${NOTICE_BUTTON_PRIMARY}">Към масата</button>`,
    placement,
  })
}

// Краткото информационно съобщение за частните маси ("Х излезе от масата."
// и т.н.) — преместено от root-а на лобито в същия изолиран контейнер, за да
// не прерисува страницата при поява/скриване. Скрива се след 3 сек (както
// преди) — таймерът е в контролера.
export function renderPrivateRoomInfoToast(text: string | null): string {
  if (!text) return ''
  return `
    <div data-private-room-info-toast="1" style="position:fixed;inset:0;z-index:9500;display:flex;align-items:center;justify-content:center;pointer-events:none;padding:0 16px;">
      <div style="pointer-events:auto;background:#1a1a2e;border:1px solid rgba(167,139,250,0.5);border-radius:16px;padding:22px 28px;text-align:center;box-shadow:0 8px 48px rgba(0,0,0,0.8);min-width:min(260px, calc(100vw - 48px));max-width:calc(100vw - 48px);box-sizing:border-box;animation:prInfoIn 0.18s ease both;">
        <style>
          @keyframes prInfoIn {
            from { opacity:0; transform:scale(0.92); }
            to   { opacity:1; transform:scale(1); }
          }
        </style>
        <div style="font-size:15px;font-weight:600;color:rgba(255,255,255,0.9);overflow-wrap:anywhere;">${escapeHtml(text)}</div>
      </div>
    </div>
  `
}

export function attachPrivateRoomNoticeHandlers(
  root: ParentNode,
  handlers: { onInviteOther: () => void; onRelease: () => void; onDismiss: () => void; onOpenTable: () => void },
): void {
  const bind = (selector: string, handler: () => void) => {
    root.querySelector<HTMLButtonElement>(selector)?.addEventListener('click', (event) => {
      if ((event.currentTarget as HTMLButtonElement).disabled) return
      handler()
    })
  }
  bind('[data-private-room-partner-notice-invite="1"]', handlers.onInviteOther)
  bind('[data-private-room-partner-notice-release="1"]', handlers.onRelease)
  bind('[data-private-room-partner-notice-dismiss="1"]', handlers.onDismiss)
  bind('[data-private-room-manual-start-notice-open="1"]', handlers.onOpenTable)
}

// ─── "Покани партньор" picker ────────────────────────────────────────────
// Същите редове/стилове като "Покани приятели" (prw-invite-*), но за едно
// конкретно място: търсачка, подредба по наличност и само "свободни онлайн"
// приятели могат да бъдат поканени. Сървърът остава authority (приятелство,
// онлайн, "играе" се проверяват отново при invite_private_room_partner).

export type PrivateRoomPartnerCandidate = {
  profileId: string
  displayName: string
  avatarUrl: string | null
  availability: 'available' | 'playing' | 'offline'
}

const PARTNER_AVAILABILITY_RANK: Record<PrivateRoomPartnerCandidate['availability'], number> = {
  available: 0,
  playing: 1,
  offline: 2,
}

// Свободни онлайн → онлайн играещи → офлайн; в рамките на група по име.
export function sortPrivateRoomPartnerCandidates(candidates: PrivateRoomPartnerCandidate[]): PrivateRoomPartnerCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      PARTNER_AVAILABILITY_RANK[a.availability] - PARTNER_AVAILABILITY_RANK[b.availability] ||
      a.displayName.localeCompare(b.displayName, 'bg'),
  )
}

export function normalizePrivateRoomPartnerQuery(value: string): string {
  return value.trim().toLocaleLowerCase('bg')
}

export function matchesPrivateRoomPartnerQuery(displayName: string, normalizedQuery: string): boolean {
  return normalizedQuery === '' || displayName.toLocaleLowerCase('bg').includes(normalizedQuery)
}

// FNV-1a 32-bit — кратък ключ на СЪДЪРЖАНИЕТО на списъка (кои хора, в какъв
// ред). Чакалнята пренася scrollTop през пълен re-render само при същия ключ.
function hashPartnerListKey(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function renderPrivateRoomPartnerPickerPopup(params: {
  isOpen: boolean
  candidates: PrivateRoomPartnerCandidate[] | null
  query: string
  inviteInFlight: boolean
}): string {
  if (!params.isOpen) return ''

  const normalizedQuery = normalizePrivateRoomPartnerQuery(params.query)
  const candidates = params.candidates === null ? null : sortPrivateRoomPartnerCandidates(params.candidates)
  const listKey = candidates === null
    ? 'loading'
    : `list-${hashPartnerListKey(candidates.map((c) => c.profileId).join('\n'))}`

  let listHtml: string
  if (candidates === null) {
    listHtml = `<div class="prw-invite-empty">Зарежда...</div>`
  } else if (candidates.length === 0) {
    listHtml = `<div class="prw-invite-empty">Нямате приятели, които да поканите.</div>`
  } else {
    const anyVisible = candidates.some((c) => matchesPrivateRoomPartnerQuery(c.displayName, normalizedQuery))
    listHtml = candidates.map((c) => {
      const avatarHtml = c.avatarUrl
        ? `<img src="${escapeHtml(c.avatarUrl)}" alt="" class="prw-invite-avatar-img">`
        : `<div class="prw-invite-avatar-fallback">👤</div>`
      const statusText = c.availability === 'playing' ? 'Играе' : c.availability === 'available' ? 'Онлайн' : 'Офлайн'
      const statusClass = c.availability === 'playing'
        ? 'prw-invite-status-busy'
        : c.availability === 'available' ? 'prw-invite-status-online' : 'prw-invite-status-offline'
      const canInvite = c.availability === 'available' && !params.inviteInFlight
      return `
        <div
          class="prw-invite-row"
          data-private-room-partner-row="1"
          data-private-room-partner-name="${escapeHtml(c.displayName.toLocaleLowerCase('bg'))}"
          ${matchesPrivateRoomPartnerQuery(c.displayName, normalizedQuery) ? '' : 'hidden'}
        >
          <div class="prw-invite-avatar">${avatarHtml}</div>
          <div class="prw-invite-info">
            <div class="prw-invite-name">${escapeHtml(c.displayName)}</div>
            <div class="prw-invite-status ${statusClass}">${statusText}</div>
          </div>
          <button
            type="button"
            data-private-room-partner-send="${escapeHtml(c.profileId)}"
            class="prw-invite-send-btn"
            ${canInvite ? '' : 'disabled'}
          >Покани</button>
        </div>
      `
    }).join('') + `<div class="prw-invite-empty" data-private-room-partner-no-match="1" ${anyVisible ? 'hidden' : ''}>Няма приятел с това име.</div>`
  }

  return `
    <div class="prw-popup-backdrop" data-private-room-partner-picker-backdrop="1">
      <div class="prw-popup-box prw-invite-box prw-partner-picker-box" data-private-room-partner-picker-panel="1" role="dialog" aria-modal="true" aria-label="Покани партньор">
        <button type="button" data-private-room-partner-picker-close="1" class="prw-popup-close-x" aria-label="Затвори">✕</button>
        <div class="prw-popup-title">Покани партньор</div>
        <div class="prw-popup-text">Изберете приятел за мястото до вас.</div>
        <input
          type="search"
          data-private-room-partner-search="1"
          class="prw-partner-search"
          value="${escapeHtml(params.query)}"
          placeholder="Търси приятел..."
          autocomplete="off"
          maxlength="64"
        >
        <div
          class="prw-invite-list prw-partner-list"
          data-private-room-partner-list="1"
          data-private-room-partner-list-key="${listKey}"
        >${listHtml}</div>
      </div>
    </div>
  `
}

export function renderPrivateRoomJoinConfirmPopup(popup: { team: Team } | null): string {
  if (!popup) return ''
  return `
    <div class="prw-popup-backdrop" data-private-room-join-popup-backdrop="1">
      <div class="prw-popup-box">
        <div class="prw-popup-title">Влизане в частна маса</div>
        <div class="prw-popup-text">Вие ще седнете на тази маса в Отбор ${popup.team === 'A' ? 'А' : 'Б'}.</div>
        <div class="prw-popup-actions">
          <button type="button" data-private-room-join-popup-confirm="1" class="prw-confirm-yes">Влез</button>
          <button type="button" data-private-room-join-popup-cancel="1" class="prw-confirm-cancel">Отказ</button>
        </div>
      </div>
    </div>
  `
}

export function renderPrivateRoomKickConfirmPopup(popup: { displayName: string } | null): string {
  if (!popup) return ''
  return `
    <div class="prw-popup-backdrop" data-private-room-kick-popup-backdrop="1">
      <div class="prw-popup-box">
        <div class="prw-popup-title">Премахване на играч</div>
        <div class="prw-popup-text">Сигурни ли сте, че искате да премахнете ${escapeHtml(popup.displayName)} от масата?</div>
        <div class="prw-popup-actions">
          <button type="button" data-private-room-kick-popup-confirm="1" class="prw-confirm-yes prw-confirm-danger">Премахни</button>
          <button type="button" data-private-room-kick-popup-cancel="1" class="prw-confirm-cancel">Отказ</button>
        </div>
      </div>
    </div>
  `
}

export function renderPrivateRoomBlockedPopup(blockedPopupText: string | null): string {
  if (!blockedPopupText) return ''
  return `
    <div class="prw-popup-backdrop" data-private-room-blocked-popup-backdrop="1">
      <div class="prw-popup-box">
        <button type="button" data-private-room-blocked-popup-close="1" class="prw-popup-close-x" aria-label="Затвори">✕</button>
        <div class="prw-popup-title">Не можете да влезете в този отбор</div>
        <div class="prw-popup-text">${escapeHtml(blockedPopupText)}</div>
      </div>
    </div>
  `
}

// Текстът е клиентски, закачен за кода 'private_room_creator_blocked_you' —
// НЕ се парсва от server message-а (виж createLobbyFlowController error handler).
export const PRIVATE_ROOM_CREATOR_BLOCKED_POPUP_LINES = [
  'Вие не можете да седнете в тази маса.',
  'Създателят ви е блокирал.',
] as const

export function renderPrivateRoomCreatorBlockedPopup(isOpen: boolean): string {
  if (!isOpen) return ''
  return `
    <div class="prw-popup-backdrop" data-private-room-creator-blocked-popup-backdrop="1">
      <div class="prw-popup-box" role="alertdialog" aria-modal="true">
        <div class="prw-popup-text">${PRIVATE_ROOM_CREATOR_BLOCKED_POPUP_LINES.map(escapeHtml).join('<br>')}</div>
        <div class="prw-popup-actions">
          <button type="button" data-private-room-creator-blocked-popup-ok="1" class="prw-confirm-yes">ОК</button>
        </div>
      </div>
    </div>
  `
}

// "Покани партньор" — сървърът отказа поканата, защото приятелят не
// отговаря на условията на масата: няма жълтици за входа
// ('private_room_partner_insufficient_balance') или нужното ниво
// ('private_room_partner_level_required'). Текстът идва от сървъра; ОК само
// затваря — резервацията не се променя.
export function renderPrivateRoomPartnerEligibilityPopup(text: string | null): string {
  if (!text) return ''
  return `
    <div class="prw-popup-backdrop" data-private-room-partner-eligibility-popup="1">
      <div class="prw-popup-box" role="alertdialog" aria-modal="true">
        <div class="prw-popup-text" data-private-room-partner-eligibility-text="1">${escapeHtml(text)}</div>
        <div class="prw-popup-actions">
          <button type="button" data-private-room-partner-eligibility-ok="1" class="prw-confirm-yes">ОК</button>
        </div>
      </div>
    </div>
  `
}

// Eligible = вече изключени: самия viewer, вече седнали в масата хора.
// "sent" state се пази client-side (виж createLobbyFlowController.ts's
// privateRoomInvitedProfileIds) — сървърът не излага pendingInvites в
// PrivateRoomSnapshot, затова UI-ът проследява собствените си изпратени
// покани оптимистично; сървърът си остава authority срещу реален spam
// (inviteFriend отхвърля дубликат с 'Вече е изпратена покана до този играч.').
export type PrivateRoomInviteEligibleFriend = {
  profileId: string
  displayName: string
  avatarUrl: string | null
  isOnline: boolean
  isInGame: boolean
  status: 'invitable' | 'sent'
}

export function renderPrivateRoomInviteFriendsPopup(params: {
  isOpen: boolean
  freeSeats: number
  friends: PrivateRoomInviteEligibleFriend[] | null
}): string {
  if (!params.isOpen) return ''

  const listHtml = params.friends === null
    ? `<div class="prw-invite-empty">Зарежда...</div>`
    : params.friends.length === 0
      ? `<div class="prw-invite-empty">Нямаш приятели, които можеш да поканиш в момента.</div>`
      : params.friends.map((f) => {
          const avatarHtml = f.avatarUrl
            ? `<img src="${escapeHtml(f.avatarUrl)}" alt="" class="prw-invite-avatar-img">`
            : `<div class="prw-invite-avatar-fallback">👤</div>`
          const statusText = f.isInGame ? 'В игра' : f.isOnline ? 'Онлайн' : 'Офлайн'
          const statusClass = f.isInGame ? 'prw-invite-status-busy' : f.isOnline ? 'prw-invite-status-online' : 'prw-invite-status-offline'
          const buttonDisabled = f.isInGame || f.status === 'sent'
          const buttonLabel = f.status === 'sent' ? 'Изпратена' : 'Покани'
          return `
            <div class="prw-invite-row">
              <div class="prw-invite-avatar">${avatarHtml}</div>
              <div class="prw-invite-info">
                <div class="prw-invite-name">${escapeHtml(f.displayName)}</div>
                <div class="prw-invite-status ${statusClass}">${statusText}</div>
              </div>
              <button
                type="button"
                data-private-room-invite-send="${escapeHtml(f.profileId)}:${escapeHtml(f.displayName)}"
                class="prw-invite-send-btn"
                ${buttonDisabled ? 'disabled' : ''}
              >${buttonLabel}</button>
            </div>
          `
        }).join('')

  return `
    <div class="prw-popup-backdrop" data-private-room-invite-backdrop="1">
      <div class="prw-popup-box prw-invite-box">
        <button type="button" data-private-room-invite-close="1" class="prw-popup-close-x" aria-label="Затвори">✕</button>
        <div class="prw-popup-title">Покани приятели</div>
        <div class="prw-popup-text">Свободни места: ${params.freeSeats}</div>
        <div class="prw-invite-list">${listHtml}</div>
      </div>
    </div>
  `
}
