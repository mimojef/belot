// Гласов чат — гласов панел и прозорец за включване (Етап 4, мобилно).
//
// LAZY chunk (assets/voice-*, извън PWA precache-а): зарежда се от
// createVoiceMobileUi само на гласова маса (предварително при влизане в
// чакалнята/играта) — не тежи на основния bundle.
//
// Чисто рендериране от VoiceSnapshot (controller-ът е единственият източник
// на логиката). Две теми: 'light' (чакалнята — светлият мобилен език) и
// 'dark' (игралната маса — тъмно/златно). Текстовете са одобрените в
// HANDOFF (2.5, 2.8Б, 2.11А, 2.15). Само data-* атрибути за действията.

import type { VoiceSnapshot } from '../createVoiceController'
import { renderVoiceSpeakingSlot } from './voiceSpeakingIndicator'
import { lucideIcon, voiceIcon as baseIcon } from './voiceUiIcons'
import { describeVoiceStatus, isInVoice, type VoiceUiSeat, type VoiceUiTheme } from './voiceUiStatus'

// Иконите само на панела — в този lazy chunk.
const voiceIcon = {
  ...baseIcon,
  volume: (size = 18) => lucideIcon(size, '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>'),
  volumeOff: (size = 18) => lucideIcon(size, '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>'),
  lock: (size = 16) => lucideIcon(size, '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  close: (size = 18) => lucideIcon(size, '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  leave: (size = 16) => lucideIcon(size, '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>'),
  alert: (size = 16) => lucideIcon(size, '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>'),
}

const PANEL_STYLE_ID = 'pika-voice-panel-ui'

/** Стиловете на панела/прозорците — заедно с този chunk, веднъж. */
export function ensureVoicePanelStyles(doc: Document): void {
  if (doc.getElementById(PANEL_STYLE_ID) !== null) return
  const style = doc.createElement('style')
  style.id = PANEL_STYLE_ID
  style.textContent = VOICE_PANEL_STYLES
  doc.head.appendChild(style)
}

export type VoicePanelOptions = {
  snapshot: VoiceSnapshot
  seats: readonly VoiceUiSeat[]
  theme: VoiceUiTheme
  isOwnVip: boolean
  /** „Вземи VIP“ само където магазинът е достъпен (чакалнята), не в активна игра. */
  canOpenShop: boolean
}

export const VOICE_PRIVACY_NOTE = 'Разговорите се предават през гласовия сървър на Pika.bg и не се записват от сайта. Другите участници могат да ги запишат със собствените си устройства.'

/**
 * Раздел 6А на Политиката (= VOICE_CHAT_PRIVACY_PATH в lobby/publicLegalPages.ts;
 * равенството се проверява от scripts/checkVoiceLegalTexts.ts). Локална
 * константа — lazy chunk-ът на панела не импортира правните текстове.
 */
export const VOICE_PRIVACY_POLICY_PATH = '/privacy#voice-chat'

/**
 * Бележката при първо включване (и в панела) с връзка към Политиката. Нов таб —
 * навигацията в същото приложение би извела играча от масата и би спряла гласа.
 */
export function renderVoicePrivacyNote(): string {
  return `<p class="pvp-note">${escapeHtml(VOICE_PRIVACY_NOTE)} <a class="pvp-note-link" data-voice-privacy-link="1" href="${VOICE_PRIVACY_POLICY_PATH}" target="_blank" rel="noopener noreferrer">Политика за поверителност</a></p>`
}

const MIC_ERROR_TEXT: Record<string, string> = {
  mic_not_found: 'Не е открит микрофон. Свържете слушалки с микрофон или продължете само да слушате.',
  mic_permission_denied: 'Pika.bg няма достъп до микрофона. Разрешете го от настройките на браузъра (🔒 до адреса → Микрофон) и опитайте пак. Можете да продължите само да слушате.',
  mic_unavailable: 'Микрофонът не е достъпен. Можете да продължите само да слушате.',
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/** Грешка на микрофона с единствен бутон „Опитай отново“ (без дублиращо „Включи микрофона“). */
function hasMicErrorNotice(snapshot: VoiceSnapshot): boolean {
  const code = snapshot.uiError?.code
  return code !== undefined && MIC_ERROR_TEXT[code] !== undefined && snapshot.speak?.blockedReason !== 'muted'
}

function formatMutedUntil(iso: string | null): string | null {
  if (iso === null) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const now = new Date()
  const time = date.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay ? `до ${time} ч.` : `до ${date.toLocaleDateString('bg-BG', { day: 'numeric', month: 'long' })}, ${time} ч.`
}

function button(attrs: string, label: string, variant: 'primary' | 'secondary' | 'quiet' | 'vip' | 'danger', icon = '', disabled = false): string {
  return `<button type="button" class="pvp-btn pvp-btn--${variant}" ${attrs}${disabled ? ' disabled' : ''}>${icon}<span>${label}</span></button>`
}

function renderNotices(options: VoicePanelOptions): string {
  const { snapshot, canOpenShop } = options
  const notices: string[] = []
  const notice = (tone: 'warn' | 'error' | 'info', title: string, text: string | null, action = '') => {
    notices.push(`<div class="pvp-notice pvp-notice--${tone}" role="status">${voiceIcon.alert(16)}<div class="pvp-notice-body"><div class="pvp-notice-title">${escapeHtml(title)}</div>${text ? `<div class="pvp-notice-text">${escapeHtml(text)}</div>` : ''}${action}</div></div>`)
  }
  const connected = snapshot.status === 'connected_listening' || snapshot.status === 'connected_speaking' || snapshot.status === 'connected_muted'
  if (connected && snapshot.playbackBlocked) {
    notice('warn', 'Браузърът спря звука.', 'Натиснете, за да чувате останалите.', button('data-voice-action="unlock-audio"', 'Включи звука', 'primary', voiceIcon.volume(16)))
  }
  const code = snapshot.uiError?.code ?? null
  const muted = snapshot.speak?.blockedReason === 'muted'
  if (muted || code === 'mic_blocked') {
    // 2.8Б: срокът само за самия наказан (speak е само на този играч).
    const until = formatMutedUntil(snapshot.speak?.mutedUntil ?? null)
    notice('error', 'Микрофонът е блокиран', `Имате активно наказание за чат. Можете да слушате останалите участници.${until ? ` Наказанието е ${until}` : ''}`)
  } else if (code !== null && MIC_ERROR_TEXT[code] !== undefined) {
    // Нов микрофон след грешката — същото съобщение, същият единствен бутон.
    const title = snapshot.microphoneDevicesChanged
      ? 'Открит е микрофон.'
      : code === 'mic_not_found' ? 'Няма микрофон' : code === 'mic_permission_denied' ? 'Няма достъп до микрофона' : 'Микрофонът не е достъпен'
    const text = snapshot.microphoneDevicesChanged ? 'Натиснете „Опитай отново“, за да го включите.' : MIC_ERROR_TEXT[code]!
    notice('error', title, text, button('data-voice-action="retry-mic"', 'Опитай отново', 'secondary'))
  } else if (code === 'vip_required') {
    notice('info', 'Говоренето е VIP привилегия.', 'Можете да слушате разговора безплатно.', canOpenShop ? button('data-voice-action="get-vip"', 'Вземи VIP', 'vip') : '')
  } else if (code === 'service_unavailable') {
    notice('error', 'Гласовият чат временно е недостъпен.', 'Играта продължава нормално.', button(connected ? 'data-voice-action="retry-mic"' : 'data-voice-action="retry-connection"', 'Опитай отново', 'secondary'))
  }
  return notices.join('')
}

function renderAvatar(seat: VoiceUiSeat): string {
  const initial = escapeHtml((seat.displayName.trim()[0] ?? '?').toUpperCase())
  const img = seat.avatarUrl ? `<img src="${escapeHtml(seat.avatarUrl)}" alt="" draggable="false">` : `<span>${seat.isBot ? '🤖' : initial}</span>`
  return `<span class="pvp-ava${seat.isBot ? ' pvp-ava--bot' : ''}">${img}${renderVoiceSpeakingSlot(seat.profileId, { sizePx: 16, insetPx: -4, corner: 'top-right', zIndex: 2, force: true })}</span>`
}

function renderRows(options: VoicePanelOptions): string {
  const { snapshot, seats } = options
  const byProfile = new Map(snapshot.participants.map((p) => [p.profileId, p]))
  return seats.map((seat) => {
    let sub = ''
    let stateIcon = ''
    let trailing = ''
    if (seat.isBot || seat.profileId === null) {
      sub = 'Бот · не участва'
    } else {
      const p = byProfile.get(seat.profileId)
      if (seat.isSelf) {
        if (!isInVoice(snapshot) || p === undefined || p.unknown) {
          sub = 'Не сте включени'
        } else if (snapshot.speak?.blockedReason === 'muted') {
          // Причината е само в съобщението горе — тук без повторение.
          sub = 'Слуша'
          stateIcon = voiceIcon.micOff(16)
        } else if (snapshot.microphone === 'live') {
          sub = 'Микрофон вкл.'
          stateIcon = voiceIcon.mic(16)
        } else {
          sub = 'Слуша'
          stateIcon = voiceIcon.headphones(16)
        }
      } else if (p === undefined || p.unknown || p.voiceConnected === null) {
        // 2.12: без свързване LiveKit информацията не е потвърдена — не се показва.
        sub = ''
      } else if (!p.voiceConnected) {
        sub = 'Не е в гласовия чат'
      } else {
        sub = p.microphonePublished ? 'Микрофон вкл.' : 'Слуша'
        stateIcon = p.microphonePublished ? voiceIcon.mic(16) : voiceIcon.headphones(16)
        if (p.locallyMuted) sub += ' · заглушен за вас'
        trailing = `<button type="button" class="pvp-mute${p.locallyMuted ? ' pvp-mute--on' : ''}" data-voice-mute-toggle="${escapeHtml(seat.profileId)}" aria-pressed="${p.locallyMuted}" aria-label="${p.locallyMuted ? `Пусни звука на ${escapeHtml(seat.displayName)}` : `Заглуши ${escapeHtml(seat.displayName)} за мен`}">${p.locallyMuted ? voiceIcon.volumeOff(18) : voiceIcon.volume(18)}</button>`
      }
    }
    return `
      <li class="pvp-row${seat.isBot ? ' pvp-row--bot' : ''}">
        ${renderAvatar(seat)}
        <span class="pvp-who">
          <span class="pvp-name">${escapeHtml(seat.displayName)}${seat.isSelf ? '<em>Ти</em>' : ''}</span>
          ${sub ? `<span class="pvp-sub">${escapeHtml(sub)}</span>` : ''}
        </span>
        ${stateIcon ? `<span class="pvp-state">${stateIcon}</span>` : ''}
        ${trailing}
      </li>
    `
  }).join('')
}

function renderActions(options: VoicePanelOptions): string {
  const { snapshot, isOwnVip, canOpenShop } = options
  if (!isInVoice(snapshot)) {
    if (snapshot.status === 'unavailable' || snapshot.status === 'error') {
      return button('data-voice-action="retry-connection"', 'Опитай отново', 'primary')
    }
    if (snapshot.canRestore) {
      return button('data-voice-action="join-listen"', 'Възстанови гласовия чат', 'primary', voiceIcon.headphones(18))
    }
    return isOwnVip
      ? `${button('data-voice-action="join-mic"', 'Включи микрофона', 'primary', voiceIcon.mic(18))}${button('data-voice-action="join-listen"', 'Само слушай', 'secondary', voiceIcon.headphones(18))}`
      : `${button('data-voice-action="join-listen"', 'Само слушай', 'primary', voiceIcon.headphones(18))}${canOpenShop ? button('data-voice-action="get-vip"', 'Вземи VIP', 'vip') : ''}`
  }
  const connecting = snapshot.status === 'connecting' || snapshot.status === 'rotating' || snapshot.status === 'disconnecting'
  let mic: string
  if (connecting || snapshot.speak === null) {
    mic = button('', 'Свързване…', 'secondary', voiceIcon.mic(18), true)
  } else if (snapshot.speak.blockedReason === 'muted') {
    // Административен mute: съобщението горе е достатъчно — без втори блокиран бутон.
    mic = ''
  } else if (hasMicErrorNotice(snapshot) && snapshot.microphone === 'off') {
    // Грешка на микрофона: единственото действие е „Опитай отново“ в съобщението.
    mic = ''
  } else if (!snapshot.speak.canSpeak) {
    // Tap = авторитетна backend проверка (придобит VIP); без заявка към браузъра при отказ.
    mic = button('data-voice-action="mic-on"', 'Микрофон · само VIP', 'secondary', voiceIcon.lock(16))
  } else if (snapshot.microphone === 'requesting') {
    mic = button('', 'Включване…', 'secondary', voiceIcon.mic(18), true)
  } else if (snapshot.microphone === 'live') {
    mic = button('data-voice-action="mic-off"', 'Изключи микрофона', 'danger', voiceIcon.micOff(18))
  } else {
    mic = button('data-voice-action="mic-on"', 'Включи микрофона', 'primary', voiceIcon.mic(18))
  }
  return `${mic}${button('data-voice-action="leave"', 'Напусни гласовия чат', 'quiet', voiceIcon.leave(16), snapshot.status === 'disconnecting')}`
}

/** Компактният гласов панел (без позициониране — то е на контейнера). */
export function renderVoicePanel(options: VoicePanelOptions): string {
  const status = describeVoiceStatus(options.snapshot)
  const idleNote = !isInVoice(options.snapshot) && options.snapshot.status !== 'unavailable' && options.snapshot.status !== 'error'
    ? renderVoicePrivacyNote()
    : ''
  return `
    <section class="pvp pvp--${options.theme}" role="dialog" aria-label="Гласов чат" data-voice-panel="1">
      <header class="pvp-head">
        <span class="pvp-title">${voiceIcon.mic(16)}Гласов чат</span>
        <span class="pvp-status pvp-status--${status.tone}"><i aria-hidden="true"></i>${escapeHtml(status.label)}</span>
        <button type="button" class="pvp-close" data-voice-action="close" aria-label="Затвори">${voiceIcon.close(18)}</button>
      </header>
      ${renderNotices(options)}
      <ul class="pvp-list">${renderRows(options)}</ul>
      <div class="pvp-actions">${renderActions(options)}</div>
      ${idleNote}
    </section>
  `
}

/** Прозорец за включване (2.5) — само в чакалнята, веднъж за посещение. light: мобилно; dark: desktop. */
export function renderVoiceJoinPrompt(options: { isOwnVip: boolean; canOpenShop: boolean; theme?: VoiceUiTheme }): string {
  const theme = options.theme ?? 'light'
  const body = options.isOwnVip
    ? `
      <p class="pvp-prompt-text">Говорете с останалите играчи на масата.</p>
      <div class="pvp-prompt-actions">
        ${button('data-voice-action="join-mic"', 'Включи микрофона', 'primary', voiceIcon.mic(18))}
        ${button('data-voice-action="join-listen"', 'Само слушай', 'secondary', voiceIcon.headphones(18))}
        ${button('data-voice-action="not-now"', 'Не сега', 'quiet')}
      </div>`
    : `
      <p class="pvp-prompt-text">Можеш да слушаш разговора безплатно. Говоренето през микрофона е VIP привилегия.</p>
      <div class="pvp-prompt-actions">
        ${button('data-voice-action="join-listen"', 'Само слушай', 'primary', voiceIcon.headphones(18))}
        ${options.canOpenShop ? button('data-voice-action="get-vip"', 'Вземи VIP', 'vip') : ''}
        ${button('data-voice-action="not-now"', 'Не сега', 'quiet')}
      </div>`
  return `
    <div class="pvp-prompt-backdrop pvp-prompt-backdrop--${theme}" data-voice-prompt="1">
      <section class="pvp pvp--${theme} pvp-prompt" role="dialog" aria-modal="true" aria-label="Гласов чат">
        <header class="pvp-head">
          <span class="pvp-title pvp-title--lg"><span class="pvp-title-badge">${voiceIcon.mic(18)}</span>Гласов чат</span>
          <button type="button" class="pvp-close" data-voice-action="not-now" aria-label="Затвори">${voiceIcon.close(18)}</button>
        </header>
        ${body}
        ${renderVoicePrivacyNote()}
      </section>
    </div>
  `
}

export const VOICE_PANEL_STYLES = `
  .pvp { box-sizing:border-box; font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif; border-radius:14px; padding:12px; display:flex; flex-direction:column; gap:10px; -webkit-tap-highlight-color:transparent; }
  .pvp * { box-sizing:border-box; }
  .pvp--dark { background:rgba(20,20,24,0.985); border:1px solid rgba(212,165,32,0.55); color:#F8FAFC; box-shadow:0 10px 32px rgba(0,0,0,0.55); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); }
  .pvp--light { background:#FFFFFF; border:1px solid #E4E7EC; color:#111827; box-shadow:0 20px 48px rgba(16,24,40,0.22); }
  .pvp-head { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:8px; min-height:32px; }
  .pvp-prompt .pvp-head { display:flex; }
  .pvp-title { display:inline-flex; align-items:center; gap:6px; font-size:15px; font-weight:800; white-space:nowrap; }
  .pvp--dark .pvp-title { color:#F4C432; }
  .pvp--light .pvp-title { color:#17233C; }
  .pvp-title--lg { font-size:18px; gap:10px; }
  .pvp-title-badge { width:34px; height:34px; border-radius:999px; display:inline-flex; align-items:center; justify-content:center; background:#F4F0FF; border:1px solid #D9CCFF; color:#6941C6; }
  .pvp-status { display:inline-flex; align-items:center; gap:5px; justify-self:end; min-width:0; font-size:12px; font-weight:700; line-height:1.25; text-align:right; }
  .pvp-status i { width:7px; height:7px; flex:0 0 auto; border-radius:999px; background:currentColor; display:inline-block; }
  .pvp--dark .pvp-status--ok { color:#4ADE80; } .pvp--light .pvp-status--ok { color:#067647; }
  .pvp--dark .pvp-status--busy { color:#FBBF24; } .pvp--light .pvp-status--busy { color:#B54708; }
  .pvp--dark .pvp-status--idle { color:rgba(248,250,252,0.6); } .pvp--light .pvp-status--idle { color:#667085; }
  .pvp--dark .pvp-status--error { color:#F87171; } .pvp--light .pvp-status--error { color:#B42318; }
  .pvp-close { width:32px; height:32px; flex:0 0 auto; border:0; border-radius:8px; display:flex; align-items:center; justify-content:center; padding:0; cursor:pointer; }
  .pvp--dark .pvp-close { background:rgba(255,255,255,0.08); color:rgba(248,250,252,0.75); }
  .pvp--light .pvp-close { background:#F2F4F7; color:#475467; }
  .pvp-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px; }
  .pvp-row { display:flex; align-items:center; gap:10px; min-height:44px; padding:4px 2px; }
  .pvp-row--bot { opacity:0.55; }
  .pvp-ava { position:relative; width:34px; height:34px; flex:0 0 auto; border-radius:999px; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:800; }
  .pvp-ava img { width:100%; height:100%; border-radius:999px; object-fit:cover; display:block; }
  .pvp--dark .pvp-ava { background:linear-gradient(180deg,#FFFFFF 0%,#E8F0F8 100%); color:#16314F; }
  .pvp--light .pvp-ava { background:#F4F0FF; border:1px solid #D9CCFF; color:#6941C6; }
  .pvp-who { min-width:0; flex:1 1 auto; display:flex; flex-direction:column; gap:1px; }
  .pvp-name { font-size:14px; font-weight:700; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pvp-name em { font-style:normal; font-size:11px; font-weight:800; margin-left:6px; }
  .pvp--dark .pvp-name em { color:#F4C432; } .pvp--light .pvp-name em { color:#7950E8; }
  .pvp-sub { font-size:12px; font-weight:600; line-height:1.3; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pvp--dark .pvp-sub { color:rgba(248,250,252,0.6); } .pvp--light .pvp-sub { color:#667085; }
  .pvp-state { flex:0 0 auto; display:flex; }
  .pvp--dark .pvp-state { color:rgba(248,250,252,0.75); } .pvp--light .pvp-state { color:#475467; }
  .pvp-mute { width:40px; height:40px; flex:0 0 auto; border-radius:10px; display:flex; align-items:center; justify-content:center; padding:0; cursor:pointer; }
  .pvp--dark .pvp-mute { background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.14); color:#F8FAFC; }
  .pvp--light .pvp-mute { background:#FFFFFF; border:1px solid #D0D5DD; color:#344054; }
  .pvp--dark .pvp-mute--on { background:rgba(248,113,113,0.14); border-color:rgba(248,113,113,0.45); color:#FCA5A5; }
  .pvp--light .pvp-mute--on { background:#FEF3F2; border-color:#FDA29B; color:#B42318; }
  .pvp-actions, .pvp-prompt-actions { display:flex; flex-direction:column; gap:8px; }
  .pvp-btn { width:100%; min-height:44px; border-radius:10px; padding:0 14px; display:inline-flex; align-items:center; justify-content:center; gap:8px; font-family:inherit; font-size:15px; font-weight:800; cursor:pointer; border:1px solid transparent; }
  .pvp-btn:disabled { cursor:default; opacity:0.6; }
  .pvp--dark .pvp-btn--primary { background:linear-gradient(180deg,#F4C95B 0%,#C98F13 100%); color:#080808; }
  .pvp--dark .pvp-btn--secondary { background:rgba(255,255,255,0.06); border-color:rgba(212,165,32,0.55); color:#F4C432; }
  .pvp--dark .pvp-btn--danger { background:rgba(248,113,113,0.12); border-color:rgba(248,113,113,0.5); color:#FCA5A5; }
  .pvp--dark .pvp-btn--quiet { background:transparent; color:rgba(248,250,252,0.7); min-height:40px; font-size:14px; font-weight:700; }
  .pvp--light .pvp-btn--primary { background:#7950E8; color:#FFFFFF; box-shadow:0 1px 2px rgba(16,24,40,0.08); }
  .pvp--light .pvp-btn--secondary { background:#FFFFFF; border-color:#D0D5DD; color:#344054; }
  .pvp--light .pvp-btn--danger { background:#FFFFFF; border-color:#FDA29B; color:#B42318; }
  .pvp--light .pvp-btn--quiet { background:transparent; color:#475467; min-height:40px; font-size:14px; font-weight:700; }
  .pvp-btn--vip { background:linear-gradient(180deg,#F7D774 0%,#E0A526 100%) !important; color:#17233C !important; }
  .pvp-notice { display:flex; gap:8px; align-items:flex-start; border-radius:10px; padding:10px; font-size:13px; line-height:1.4; }
  .pvp-notice > svg { flex:0 0 auto; margin-top:1px; }
  .pvp-notice-body { min-width:0; display:flex; flex-direction:column; gap:4px; }
  .pvp-notice-title { font-weight:800; }
  .pvp-notice .pvp-btn { margin-top:4px; min-height:40px; font-size:14px; }
  .pvp--dark .pvp-notice--warn { background:rgba(251,191,36,0.12); color:#FDE68A; }
  .pvp--dark .pvp-notice--error { background:rgba(248,113,113,0.12); color:#FECACA; }
  .pvp--dark .pvp-notice--info { background:rgba(255,255,255,0.06); color:rgba(248,250,252,0.85); }
  .pvp--light .pvp-notice--warn { background:#FFFAEB; color:#93370D; }
  .pvp--light .pvp-notice--error { background:#FEF3F2; color:#912018; }
  .pvp--light .pvp-notice--info { background:#F4F0FF; color:#5B3CC4; }
  .pvp-note { margin:0; font-size:11px; line-height:1.4; }
  .pvp--dark .pvp-note { color:rgba(248,250,252,0.5); } .pvp--light .pvp-note { color:#667085; }
  .pvp-note-link { color:inherit; font-weight:700; text-decoration:underline; text-underline-offset:2px; }
  .pvp-prompt-backdrop { position:fixed; inset:0; z-index:1250; background:rgba(16,24,40,0.55); display:flex; align-items:center; justify-content:center; padding:16px; }
  .pvp-prompt { width:100%; max-width:360px; padding:16px 18px 18px; gap:12px; }
  .pvp-prompt .pvp-close { margin-left:auto; }
  .pvp-prompt-text { margin:0; font-size:15px; line-height:1.5; color:#344054; }
  /* Desktop (Етап 5): тъмният черно-златист вариант на същите елементи. */
  .pvp-prompt-backdrop--dark { background:rgba(0,0,0,0.6); }
  .pvp--dark.pvp-prompt { max-width:380px; padding:18px 20px 20px; }
  .pvp--dark .pvp-prompt-text { color:rgba(248,250,252,0.85); }
  .pvp--dark .pvp-title-badge { background:rgba(212,165,32,0.14); border-color:rgba(212,165,32,0.55); color:#F4C432; }
  /* На тъмен фон „Вземи VIP“ се различава от основния златен бутон. */
  .pvp--dark .pvp-btn--vip { background:rgba(212,165,32,0.08) !important; border-color:rgba(244,201,91,0.8); color:#F4C95B !important; }
`
