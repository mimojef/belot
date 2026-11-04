import type { LudoRoomMatchSnapshot, LudoRoomSnapshot, MatchStake } from '../../network/createGameServerClient'
import { VIOLET_3D_BUTTON_CLASS } from '../../../ui/layout/violet3dButton'

type Options = {
  root: HTMLElement
  localProfileId: string
  stakes: MatchStake[]
  onBack: () => void
  onRefresh: () => void
  onRefreshGames: () => void
  onCreate: (stake: MatchStake, playerCount: 2 | 4, manualStart: boolean) => void
  onJoin: (roomId: string) => void
  onLeave: () => void
  onKick: (profileId: string) => void
  onStart: () => void
  // "Гледай" (Spectator mode, Phase 2) — само за 'playing' game cards.
  onWatch: (matchId: string) => void
}

type LifecycleTab = 'waiting' | 'playing' | 'finished'

// Вид на съобщението под банера — само визуален (светлият вариант го
// различава с цвят); тъмният вариант го показва по старому.
export type LudoLobbyMessageKind = 'info' | 'warning' | 'error'

const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)

const COLOR_DOT: Record<'red' | 'blue' | 'green' | 'yellow', string> = {
  red: '#e0473e',
  blue: '#3b82f6',
  green: '#22a559',
  yellow: '#f4c95b',
}

// Mirror на TEAM_SLOT_CSS/prl-* класовете в renderPrivateRoomsPage
// (renderLobbyScreen.ts) — същия avatar-slot UX модел, Ludo gold/dark
// цветова схема вместо purple accent, 2x2 N-up grid вместо 2-team grid
// (Ludo е individual game, без отбори).
const SLOT_CSS = `
  .ludo-slots {
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:clamp(6px, 2vw, 12px);
  }
  .ludo-slot-occupant {
    display:flex;
    align-items:center;
    gap:6px;
    min-width:0;
    width:100%;
    box-sizing:border-box;
    border:1px solid rgba(255,255,255,0.12);
    border-radius:9px;
    padding:7px 8px;
  }
  .ludo-slot-avatar-wrap {
    position:relative;
    box-sizing:border-box;
    width:clamp(28px, 9vw, 40px);
    height:clamp(28px, 9vw, 40px);
    flex-shrink:0;
    border-radius:9px;
    overflow:visible;
    background:rgba(255,255,255,0.08);
    border:1px solid rgba(255,255,255,0.15);
  }
  .ludo-slot-name-wrap {
    min-width:0;
    display:flex;
    flex-direction:column;
    gap:2px;
  }
  .ludo-slot-name {
    font-size:11px;
    font-weight:700;
    color:rgba(255,255,255,0.88);
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
    min-width:0;
  }
  .ludo-slot-creator {
    font-size:9px;
    font-weight:800;
    color:#f4c95b;
  }
  .ludo-slot-empty {
    box-sizing:border-box;
    width:100%;
    min-height:50px;
    border-radius:9px;
    border:1px dashed rgba(255,255,255,0.14);
    background:rgba(255,255,255,0.03);
    color:rgba(255,255,255,0.35);
    font-size:11px;
    display:flex;
    align-items:center;
    justify-content:center;
    text-align:center;
    padding:6px;
  }
  @media (min-width: 421px) {
    .ludo-slot-name { font-size:12px; }
    .ludo-slot-creator { font-size:10px; }
    .ludo-slot-empty { font-size:12px; min-height:56px; padding:8px; }
  }
`

// ─── Светъл мобилен вариант (телефон, обща светла рамка на лобито) ──────
// Включва се, когато mount-ът е вътре в data-lobby-member-mobile-light
// (проверява се при всеки render — и след повторно монтиране). Правилата са
// само под data-ludo-light="1"; desktop/таблет получават тъмния вариант.
const LIGHT_TITLE_ICON_URL = '/assets/lobby-mobile/icons/icon-private-tables-ludo.webp'
const LIGHT_PANEL_STYLE = 'box-sizing:border-box;min-width:0;background:#FFFFFF;border:1px solid #E4E7EC;border-radius:12px;padding:12px;box-shadow:0 1px 2px rgba(16,24,40,0.05);'
// Основните бутони са .lobby-violet-btn (фонът идва от класа).
const LIGHT_PRIMARY_BUTTON_STYLE = 'border:0;border-radius:10px;color:#FFFFFF;font-family:inherit;font-weight:800;cursor:pointer;white-space:nowrap;'
const LIGHT_SECONDARY_BUTTON_STYLE = 'box-sizing:border-box;border:1px solid #D0D5DD;border-radius:10px;background:#FFFFFF;color:#6941C6;font-family:inherit;font-weight:800;cursor:pointer;white-space:nowrap;'
const LIGHT_DANGER_BUTTON_STYLE = 'box-sizing:border-box;border:1px solid #FECDCA;border-radius:10px;background:#FFFFFF;color:#B42318;font-family:inherit;font-weight:800;cursor:pointer;white-space:nowrap;'
const LIGHT_META_STYLE = 'font-size:12.5px;line-height:1.4;font-weight:600;color:#667085;'
const LIGHT_FIELD_STYLE = 'width:100%;max-width:100%;min-width:0;box-sizing:border-box;height:44px;background:#FFFFFF;color:#111827;border:1px solid #D0D5DD;border-radius:8px;padding:0 12px;font-family:inherit;font-size:16px;color-scheme:light;'
const LIGHT_MESSAGE_STYLE: Record<LudoLobbyMessageKind, string> = {
  info: 'background:#EFF8FF;border:1px solid #B2DDFF;color:#175CD3;',
  warning: 'background:#FFFAEB;border:1px solid #FEDF89;color:#B54708;',
  error: 'background:#FEF3F2;border:1px solid #FECDCA;color:#B42318;',
}
const LIGHT_CSS = `
  [data-ludo-light="1"].ludo-lobby-page { padding:4px 0 20px; }
  [data-ludo-light="1"] .ludo-tabs-row { display:flex; gap:6px; }
  [data-ludo-light="1"] .ludo-slots { grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:8px; }
  [data-ludo-light="1"] .ludo-slot-occupant { border-color:#E4E7EC; background:#F9FAFB; }
  [data-ludo-light="1"] .ludo-slot-avatar-wrap { background:#F4F0FF; border-color:#D9CCFF; }
  [data-ludo-light="1"] .ludo-slot-name { color:#111827; }
  [data-ludo-light="1"] .ludo-slot-creator { color:#6941C6; }
  [data-ludo-light="1"] .ludo-slot-empty { border-color:#D0D5DD; background:#FFFFFF; color:#667085; }
`

export function createLudoLobbyController(options: Options) {
  let rooms: LudoRoomSnapshot[] = []
  let myRoom: LudoRoomSnapshot | null = null
  let playingGames: LudoRoomMatchSnapshot[] = []
  let finishedGames: LudoRoomMatchSnapshot[] = []
  let lifecycleTab: LifecycleTab = 'waiting'
  let createOpen = false
  let message = ''
  let messageKind: LudoLobbyMessageKind = 'error'
  let leavePending = false
  // Светлият вариант — преизчислява се в началото на всеки render().
  let light = false

  const button = 'border:1px solid rgba(212,165,32,.55);border-radius:7px;background:#0b0b0b;color:#f4c95b;min-height:42px;padding:0 16px;font-weight:800;cursor:pointer;'
  const panel = 'background:#090909;border:1px solid rgba(212,165,32,.35);border-radius:8px;padding:16px;'
  const backButtonStyle = 'box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 16px 0 12px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:rgba(255,255,255,.03);color:rgba(255,255,255,.82);font-size:14px;line-height:normal;font-weight:700;cursor:pointer;transition:border-color .15s ease,color .15s ease,background .15s ease;'
  const createButtonStyle = 'box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 20px;flex:1 1 auto;min-width:0;max-width:220px;border:1px solid rgba(244,201,91,.5);border-radius:10px;background:linear-gradient(135deg,#f6d27a 0%,#d4a520 55%,#c98f13 100%);color:#1a1200;font-size:14px;line-height:normal;font-weight:800;cursor:pointer;box-shadow:0 1px 0 rgba(255,255,255,.25) inset,0 6px 16px rgba(212,165,32,.22);white-space:nowrap;'
  const backChevronSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 18l-6-6 6-6"/></svg>'
  const createPlusSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg>'

  function formatDateTime(timestampMs: number): string {
    const date = new Date(timestampMs)
    const datePart = date.toLocaleDateString('bg-BG', { day: '2-digit', month: '2-digit' })
    const timePart = date.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })
    return `${datePart} ${timePart}`
  }

  // Заета маса — ако room е дадена, чете hostProfileId от нея (waiting tab);
  // иначе (playing/finished tab, LudoRoomMatchSnapshot occupant) показва
  // цветния dot вместо ★ badge, тъй като match snapshot-ите нямат isHost
  // флаг (само color assignment) — creator marker е специфичен само за
  // чакалнята, mirror на task spec §4.
  function occupantSlotHtml(params: {
    displayName: string
    avatarUrl: string | null
    isCreator: boolean
    color: 'red' | 'blue' | 'green' | 'yellow' | null
    onProfileClickAttr: string
  }): string {
    const { displayName, avatarUrl, isCreator, color, onProfileClickAttr } = params
    const avatarInner = avatarUrl
      ? `<img src="${esc(avatarUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:9px;" />`
      : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:16px;color:rgba(255,255,255,0.5);">👤</div>`
    const colorDot = color
      ? `<div style="position:absolute;top:-4px;right:-4px;background:${COLOR_DOT[color]};border-radius:50%;width:12px;height:12px;border:1.5px solid ${light ? '#FFFFFF' : '#090909'};"></div>`
      : ''
    const creatorBadge = isCreator ? `<div class="ludo-slot-creator">Създател</div>` : ''
    return `<div class="ludo-slot-occupant"${onProfileClickAttr}>
      <div class="ludo-slot-avatar-wrap">
        <div style="width:100%;height:100%;border-radius:9px;overflow:hidden;">${avatarInner}</div>
        ${colorDot}
      </div>
      <div class="ludo-slot-name-wrap">
        <div class="ludo-slot-name">${esc(displayName)}</div>
        ${creatorBadge}
      </div>
    </div>`
  }

  function render(): void {
    light = options.root.closest('[data-lobby-member-mobile-light="1"]') !== null
    const body = myRoom ? renderWaiting(myRoom) : renderTabbedList()
    if (light) {
      options.root.innerHTML = `<section data-ludo-lobby="1" data-ludo-light="1" class="ludo-lobby-page" style="background:transparent;color:#111827;font-family:inherit;box-sizing:border-box;overflow-x:hidden;">
      <style>
        .ludo-action-row { flex-wrap:nowrap; gap:8px; }
        ${SLOT_CSS}
        ${LIGHT_CSS}
      </style>
      <div style="max-width:920px;margin:0 auto;">
        <div style="display:flex;align-items:center;gap:10px;min-width:0;margin-bottom:12px;">
          <img src="${LIGHT_TITLE_ICON_URL}" alt="" width="36" height="36" decoding="async" style="width:36px;height:36px;flex:0 0 auto;display:block;object-fit:contain;">
          <h1 style="margin:0;min-width:0;color:#17233C;font-size:20px;font-weight:800;line-height:1.2;overflow-wrap:anywhere;">Частни маси – Не се сърди човече</h1>
        </div>
        <div style="border:1px solid #E4E7EC;border-radius:12px;overflow:hidden;line-height:0;margin-bottom:12px;background:#FFFFFF;box-shadow:0 1px 2px rgba(16,24,40,0.05);">
          <img src="/images/games/ludo-lobby-banner.webp" alt="Не се сърди човече" style="display:block;width:100%;height:auto;">
        </div>
        ${message ? `<div data-ludo-lobby-message="${messageKind}" role="${messageKind === 'error' ? 'alert' : 'status'}" style="${LIGHT_MESSAGE_STYLE[messageKind]}margin-bottom:12px;padding:10px 12px;border-radius:10px;font-size:13.5px;font-weight:700;line-height:1.4;overflow-wrap:anywhere;">${esc(message)}</div>` : ''}
        ${body}
      </div>
      ${createOpen ? renderCreateModal() : ''}
    </section>`
      wire()
      return
    }
    options.root.innerHTML = `<section data-ludo-lobby="1" class="ludo-lobby-page" style="background:#030303;color:#fff;font-family:Arial,sans-serif;box-sizing:border-box;overflow-x:hidden;">
      <style>
        [data-ludo-lobby-back]:hover { border-color:rgba(212,165,32,.55); color:#f4c95b; background:rgba(212,165,32,.08); }
        [data-ludo-lifecycle-tab]:hover { filter:brightness(1.1); }
        .ludo-lobby-page { padding:clamp(14px,3vw,32px); }
        .ludo-action-row { flex-wrap:nowrap; gap:10px; }
        .ludo-tabs-row { display:flex; gap:8px; }
        @media (max-width: 480px) {
          /* Mobile lobby shell-ът (renderMobileLobbyScreenContent,
             renderLobbyScreen.ts) mount-ва Ludo вътре в <main style="padding:12px">
             — споделен wrapper за всички mobile views (private-rooms/players/shop
             и т.н.), не може да се промени глобално без да засегне тях.
             Компенсираме точно тези 12px чрез negative margin, само в Ludo
             mobile контекста, за да остане ~7px реален safe inset. */
          .ludo-lobby-page { padding:12px 7px; margin:0 -12px; }
          .ludo-action-row { gap:8px; }
          .ludo-tabs-row {
            display:grid;
            grid-template-columns:1fr 1fr;
            grid-template-areas:"playing finished" "waiting waiting";
            gap:6px;
          }
          [data-ludo-lifecycle-tab] { font-size:12px; }
          [data-ludo-create-open] { padding:0 12px; }
        }
        ${SLOT_CSS}
      </style>
      <div style="max-width:920px;margin:0 auto;">
        <div style="border:2px solid rgba(212,165,32,0.78);border-radius:14px;overflow:hidden;line-height:0;margin-bottom:18px;background:#000000;">
          <img src="/images/games/ludo-lobby-banner.webp" alt="Не се сърди човече" style="display:block;width:100%;height:auto;border-radius:12px;">
        </div>
        ${message ? `<div style="margin-bottom:14px;color:#f4c95b;">${esc(message)}</div>` : ''}
        ${body}
      </div>
      ${createOpen ? renderCreateModal() : ''}
    </section>`
    wire()
  }

  function renderActionRow(rightContent: string): string {
    const backStyle = light
      ? `${LIGHT_SECONDARY_BUTTON_STYLE}display:inline-flex;align-items:center;gap:6px;height:42px;padding:0 14px 0 10px;color:#344054;font-size:14px;line-height:normal;`
      : backButtonStyle
    return `<div class="ludo-action-row" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${light ? '12px' : '20px'};">
      <button data-ludo-lobby-back="1" aria-label="Назад" style="${backStyle}flex-shrink:0;">${backChevronSvg}<span>Назад</span></button>
      ${rightContent}
    </div>`
  }

  function renderEmptyState(text: string): string {
    const dieFill = light ? '#F4F0FF' : '#141414'
    const dieStroke = light ? '#7950E8' : '#f4c95b'
    const containerStyle = light
      ? `${LIGHT_PANEL_STYLE}padding:28px 16px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;`
      : 'background:linear-gradient(180deg,#0d0d0d 0%,#080808 100%);border:1px solid rgba(212,165,32,.4);border-radius:16px;padding:clamp(28px,5vw,44px) 20px;box-shadow:0 1px 0 rgba(255,255,255,.03) inset,0 14px 34px rgba(0,0,0,.35);display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;'
    return `<div style="${containerStyle}">
      <svg width="112" height="80" viewBox="0 0 112 80" fill="none" aria-hidden="true" focusable="false">
        <circle cx="24" cy="52" r="13" fill="none" stroke="#e0473e" stroke-width="2.2" opacity=".85"/>
        <circle cx="52" cy="60" r="13" fill="none" stroke="#3b82f6" stroke-width="2.2" opacity=".85"/>
        <circle cx="80" cy="52" r="13" fill="none" stroke="#22a559" stroke-width="2.2" opacity=".85"/>
        <g transform="translate(40,10)">
          <rect x="0" y="0" width="32" height="32" rx="8" fill="${dieFill}" stroke="${dieStroke}" stroke-width="1.6"/>
          <circle cx="9" cy="9" r="2.4" fill="${dieStroke}"/>
          <circle cx="23" cy="9" r="2.4" fill="${dieStroke}"/>
          <circle cx="9" cy="23" r="2.4" fill="${dieStroke}"/>
          <circle cx="23" cy="23" r="2.4" fill="${dieStroke}"/>
          <circle cx="16" cy="16" r="2.4" fill="${dieStroke}"/>
        </g>
      </svg>
      <div>
        <div style="${light ? 'font-size:15px;font-weight:700;color:#667085;line-height:1.45;' : 'font-size:17px;font-weight:800;color:#fff;'}">${esc(text)}</div>
      </div>
    </div>`
  }

  function waitingRoomCardHtml(room: LudoRoomSnapshot): string {
    const host = room.players.find((player) => player.isHost)
    const slotsHtml = Array.from({ length: room.playerCount }, (_, index) => {
      const player = room.players[index]
      if (!player) return `<div class="ludo-slot-empty">Свободно място</div>`
      return occupantSlotHtml({
        displayName: player.displayName,
        avatarUrl: player.avatarUrl,
        isCreator: player.isHost,
        color: null,
        onProfileClickAttr: '',
      })
    }).join('')
    if (light) {
      return `<article style="${LIGHT_PANEL_STYLE}">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:12px;">
        <div style="flex:1;min-width:0;">
          <strong style="display:block;min-width:0;font-size:15px;font-weight:800;line-height:1.3;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(host?.displayName ?? 'Играч')}</strong>
          <div style="${LIGHT_META_STYLE}margin-top:3px;">${room.players.length}/${room.playerCount} · Вход ${room.stake} · ${room.manualStart ? 'Ръчен старт' : 'При запълване'}</div>
        </div>
        <button data-ludo-room-join="${esc(room.id)}" aria-label="Влез в играта" class="lobby-violet-btn ${VIOLET_3D_BUTTON_CLASS}" style="${LIGHT_PRIMARY_BUTTON_STYLE}flex:0 0 auto;width:44px;height:44px;padding:0;font-size:24px;line-height:1;">+</button>
      </div>
      <div class="ludo-slots">${slotsHtml}</div>
    </article>`
    }
    return `<article style="${panel}">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;margin-bottom:12px;">
        <div>
          <strong>${esc(host?.displayName ?? 'Играч')}</strong>
          <div style="margin-top:6px;color:rgba(255,255,255,.62);font-size:13px;">${room.players.length}/${room.playerCount} · Вход ${room.stake} · ${room.manualStart ? 'Ръчен старт' : 'При запълване'}</div>
        </div>
        <button data-ludo-room-join="${esc(room.id)}" aria-label="Влез в играта" style="${button}width:46px;padding:0;font-size:25px;">+</button>
      </div>
      <div class="ludo-slots">${slotsHtml}</div>
    </article>`
  }

  function gameCardHtml(game: LudoRoomMatchSnapshot, kind: 'playing' | 'finished'): string {
    const slotsHtml = Array.from({ length: game.playerCount }, (_, index) => {
      const player = game.players[index]
      if (!player) return `<div class="ludo-slot-empty">—</div>`
      return occupantSlotHtml({
        displayName: player.displayName,
        avatarUrl: player.avatarUrl,
        isCreator: false,
        color: player.color,
        onProfileClickAttr: '',
      })
    }).join('')
    const winner = kind === 'finished' && game.winnerProfileId !== null
      ? game.players.find((player) => player.profileId === game.winnerProfileId) ?? null
      : null
    const statusLabel = kind === 'playing' ? 'Играе се' : 'Приключила'
    const footerLine = kind === 'finished' && game.finishedAt !== null
      ? `<div style="margin-top:10px;${light ? 'font-size:12px;font-weight:600;color:#667085;' : 'font-size:11px;color:rgba(255,255,255,.45);'}">Приключила: ${formatDateTime(game.finishedAt)}</div>`
      : ''
    const winnerLine = winner
      ? `<div style="margin-top:10px;font-size:12px;font-weight:800;color:${light ? '#B54708;overflow-wrap:anywhere' : '#f4c95b'};">🏆 Победител: ${esc(winner.displayName)}</div>`
      : ''
    // "Гледай" (Spectator mode, Phase 2) — само за реално активни ('playing')
    // игри, никога за приключили (виж task-а т.7 "Ludo Spectator Mode
    // Phase 1" audit-а — matchId вече е наличен в LudoRoomMatchSnapshot,
    // нулева backend промяна нужна тук).
    const watchButtonHtml = kind === 'playing'
      ? `<button type="button" data-ludo-watch-match="${esc(game.matchId)}" style="${light ? `${LIGHT_SECONDARY_BUTTON_STYLE}height:36px;padding:0 14px;font-size:13px;` : `${button}min-height:34px;padding:0 14px;font-size:12px;`}">Гледай</button>`
      : ''
    const statusColor = light
      ? (kind === 'playing' ? '#6941C6' : '#475467')
      : (kind === 'playing' ? '#f4c95b' : 'rgba(255,255,255,.85)')
    return `<article style="${light ? LIGHT_PANEL_STYLE : panel}">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:12px;">
        <strong style="color:${statusColor};">${statusLabel}</strong>
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="${light ? LIGHT_META_STYLE : 'color:rgba(255,255,255,.62);font-size:13px;'}">Вход ${game.stake}</div>
          ${watchButtonHtml}
        </div>
      </div>
      <div class="ludo-slots">${slotsHtml}</div>
      ${winnerLine}
      ${footerLine}
    </article>`
  }

  function lifecycleTabButtonHtml(tab: LifecycleTab, label: string, count: number): string {
    const isActive = lifecycleTab === tab
    if (light) {
      return `<button type="button" data-ludo-lifecycle-tab="${tab}" data-active="${isActive ? 'true' : 'false'}" aria-selected="${isActive ? 'true' : 'false'}" style="
      flex:1 1 0;min-width:0;display:flex;align-items:center;justify-content:center;gap:4px;
      height:40px;padding:0 4px;box-sizing:border-box;border-radius:10px;
      border:1px solid ${isActive ? '#D9CCFF' : '#E4E7EC'};background:${isActive ? '#F4F0FF' : '#FFFFFF'};
      color:${isActive ? '#6941C6' : '#475467'};box-shadow:0 1px 2px rgba(16,24,40,0.05);
      font-family:inherit;font-size:12px;font-weight:800;cursor:pointer;white-space:nowrap;
    "><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">${label}</span>
      <span style="
        flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;
        background:${isActive ? '#7950E8' : '#F2F4F7'};color:${isActive ? '#FFFFFF' : '#475467'};
        border-radius:999px;font-size:11px;font-weight:800;
      ">${count}</span>
    </button>`
    }
    // grid-area имена за mobile 2-row layout-а (виж .ludo-tabs-row по-долу) —
    // без ефект на desktop, където .ludo-tabs-row е display:flex и
    // grid-area просто се игнорира.
    const gridArea = tab === 'waiting' ? 'waiting' : tab === 'playing' ? 'playing' : 'finished'
    return `<button type="button" data-ludo-lifecycle-tab="${tab}" data-active="${isActive ? 'true' : 'false'}" aria-selected="${isActive ? 'true' : 'false'}" style="
      display:flex;align-items:center;gap:4px;min-width:0;grid-area:${gridArea};
      background:${isActive ? 'rgba(212,165,32,0.18)' : 'rgba(255,255,255,0.05)'};
      border:1px solid ${isActive ? 'rgba(212,165,32,0.55)' : 'rgba(255,255,255,0.1)'};
      border-radius:9px;color:${isActive ? '#f4c95b' : 'rgba(255,255,255,0.6)'};
      font-size:13px;font-weight:700;cursor:pointer;flex:1 1 auto;justify-content:center;padding:7px 4px;
    "><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">${label}</span>
      <span style="
        display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 4px;flex-shrink:0;
        background:${isActive ? 'rgba(212,165,32,0.35)' : 'rgba(255,255,255,0.1)'};
        border-radius:999px;font-size:11px;font-weight:800;
      ">${count}</span>
    </button>`
  }

  function renderTabbedList(): string {
    const createButton = light
      ? `<button data-ludo-create-open="1" class="lobby-violet-btn ${VIOLET_3D_BUTTON_CLASS}" style="${LIGHT_PRIMARY_BUTTON_STYLE}display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 14px;flex:1 1 auto;min-width:0;font-size:14px;line-height:normal;">${createPlusSvg}<span>Създай игра</span></button>`
      : `<button data-ludo-create-open="1" style="${createButtonStyle}">${createPlusSvg}<span>Създай игра</span></button>`
    const tabsHtml = `<div class="ludo-tabs-row" style="margin-bottom:${light ? '12px' : '16px'};" role="tablist">
      ${lifecycleTabButtonHtml('waiting', 'Чакащи', rooms.length)}
      ${lifecycleTabButtonHtml('playing', 'Играещи', playingGames.length)}
      ${lifecycleTabButtonHtml('finished', 'Приключили', finishedGames.length)}
    </div>`

    const content = lifecycleTab === 'waiting'
      ? (rooms.length === 0
        ? renderEmptyState('В момента няма чакащи игри.')
        : `<div style="display:grid;gap:10px;">${rooms.map(waitingRoomCardHtml).join('')}</div>`)
      : lifecycleTab === 'playing'
        ? (playingGames.length === 0
          ? renderEmptyState('В момента няма играещи игри.')
          : `<div style="display:grid;gap:10px;">${playingGames.map((game) => gameCardHtml(game, 'playing')).join('')}</div>`)
        : (finishedGames.length === 0
          ? renderEmptyState('В момента няма приключили игри.')
          : `<div style="display:grid;gap:10px;">${finishedGames.map((game) => gameCardHtml(game, 'finished')).join('')}</div>`)

    return `${renderActionRow(lifecycleTab === 'waiting' ? createButton : '')}
      ${tabsHtml}
      ${content}`
  }

  function renderWaiting(room: LudoRoomSnapshot): string {
    const isHost = room.players.some((player) => player.profileId === options.localProfileId && player.isHost)
    const slotsHtml = Array.from({ length: room.playerCount }, (_, index) => {
      const player = room.players[index]
      if (!player) return `<div class="ludo-slot-empty">Свободно място</div>`
      const kickButton = isHost && !player.isHost
        ? `<button data-ludo-room-kick="${esc(player.profileId)}" style="${light ? `${LIGHT_DANGER_BUTTON_STYLE}min-height:32px;padding:0 10px;font-size:12px;margin-top:4px;` : `${button}min-height:30px;padding:0 10px;font-size:11px;color:#fecaca;margin-top:4px;`}">Премахни</button>`
        : ''
      return `<div${light ? ' style="min-width:0;"' : ''}>${occupantSlotHtml({
        displayName: player.displayName,
        avatarUrl: player.avatarUrl,
        isCreator: player.isHost,
        color: null,
        onProfileClickAttr: '',
      })}${kickButton}</div>`
    }).join('')
    if (light) {
      return `<div style="${LIGHT_PANEL_STYLE}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:14px;"><div style="flex:1;min-width:0;"><strong style="font-size:15px;font-weight:800;color:#17233C;">Чакаща</strong><div style="${LIGHT_META_STYLE}margin-top:3px;">${room.players.length}/${room.playerCount} · Вход ${room.stake} · ${room.manualStart ? 'Ръчен старт' : 'При запълване'}</div></div><button data-ludo-room-leave="1" ${leavePending ? 'disabled' : ''} style="${LIGHT_DANGER_BUTTON_STYLE}flex:0 0 auto;height:40px;padding:0 14px;font-size:14px;${leavePending ? 'opacity:.55;cursor:wait;' : ''}">${leavePending ? 'Напускане…' : 'Напусни'}</button></div>
      <div class="ludo-slots">${slotsHtml}</div>
      ${room.manualStart && isHost ? `<button data-ludo-room-start="1" class="lobby-violet-btn ${VIOLET_3D_BUTTON_CLASS}" ${room.canManualStart ? '' : 'disabled'} style="${LIGHT_PRIMARY_BUTTON_STYLE}width:100%;height:44px;margin-top:14px;font-size:15px;cursor:${room.canManualStart ? 'pointer' : 'not-allowed'};">Старт</button>` : ''}
    </div>`
    }
    return `<div style="${panel}">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px;"><div><strong>Чакаща</strong><div style="color:rgba(255,255,255,.62);margin-top:5px;">${room.players.length}/${room.playerCount} · Вход ${room.stake} · ${room.manualStart ? 'Ръчен старт' : 'При запълване'}</div></div><button data-ludo-room-leave="1" ${leavePending ? 'disabled' : ''} style="${button}${leavePending ? 'opacity:.55;cursor:wait;' : ''}">${leavePending ? 'Напускане…' : 'Напусни'}</button></div>
      <div class="ludo-slots">${slotsHtml}</div>
      ${room.manualStart && isHost ? `<button data-ludo-room-start="1" ${room.canManualStart ? '' : 'disabled'} style="${button}width:100%;margin-top:16px;background:${room.canManualStart ? '#d4a520' : '#242424'};color:${room.canManualStart ? '#050505' : '#777'};cursor:${room.canManualStart ? 'pointer' : 'not-allowed'};">Старт</button>` : ''}
    </div>`
  }

  function renderCreateModal(): string {
    const stakes = options.stakes.length ? options.stakes : [0]
    if (light) {
      // z-index 9500 — над общия хедър (120), менюто (140) и долната навигация
      // (110) в същия stacking context на лобито; същият слой като "Нова маса".
      const labelStyle = 'display:grid;gap:6px;margin-bottom:14px;min-width:0;font-size:13px;font-weight:700;color:#17233C;'
      const choiceStyle = 'display:flex;align-items:center;gap:10px;min-height:44px;padding:0 12px;box-sizing:border-box;border:1px solid #D0D5DD;border-radius:10px;background:#FFFFFF;font-size:14px;font-weight:700;color:#111827;cursor:pointer;'
      const radioStyle = 'width:18px;height:18px;margin:0;flex-shrink:0;accent-color:#7950E8;cursor:pointer;'
      return `<div data-ludo-create-backdrop="1" style="position:fixed;inset:0;z-index:9500;background:rgba(16,24,40,0.45);display:grid;place-items:center;padding:16px;box-sizing:border-box;overflow-y:auto;font-family:inherit;"><form data-ludo-create-form="1" role="dialog" aria-modal="true" aria-label="Създай игра" style="width:min(100%,420px);max-width:100%;min-width:0;max-height:calc(100dvh - 32px);overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box;margin:auto;padding:20px;background:#FFFFFF;border:1px solid #E4E7EC;border-radius:16px;box-shadow:0 20px 48px rgba(16,24,40,0.18);color:#111827;">
      <h2 style="margin:0 0 16px;letter-spacing:0;color:#17233C;font-size:20px;font-weight:800;line-height:1.2;">Създай игра</h2>
      <label style="${labelStyle}">Брой играчи<select name="playerCount" style="${LIGHT_FIELD_STYLE}"><option value="2">2</option><option value="4">4</option></select></label>
      <label style="${labelStyle}">Вход<select name="stake" style="${LIGHT_FIELD_STYLE}">${stakes.map((stake) => `<option value="${stake}">${stake} жълтици</option>`).join('')}</select></label>
      <fieldset style="border:0;padding:0;margin:0 0 18px;display:grid;gap:8px;min-width:0;"><legend style="padding:0;margin-bottom:6px;font-size:13px;font-weight:700;color:#17233C;">Старт</legend><label style="${choiceStyle}"><input type="radio" name="startMode" value="auto" checked style="${radioStyle}"> При запълване</label><label style="${choiceStyle}"><input type="radio" name="startMode" value="manual" style="${radioStyle}"> Ръчен старт</label></fieldset>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;"><button type="button" data-ludo-create-close="1" style="${LIGHT_SECONDARY_BUTTON_STYLE}height:44px;color:#344054;font-size:14px;">Отказ</button><button type="submit" class="lobby-violet-btn ${VIOLET_3D_BUTTON_CLASS}" style="${LIGHT_PRIMARY_BUTTON_STYLE}height:44px;font-size:15px;">Създай</button></div>
    </form></div>`
    }
    return `<div data-ludo-create-backdrop="1" style="position:fixed;inset:0;background:rgba(0,0,0,.78);display:grid;place-items:center;padding:14px;z-index:2;"><form data-ludo-create-form="1" style="${panel}width:min(100%,420px);max-width:100%;min-width:0;max-height:calc(100dvh - 28px);overflow-y:auto;box-sizing:border-box;">
      <h2 style="margin:0 0 18px;letter-spacing:0;">Създай игра</h2>
      <label style="display:grid;gap:7px;margin-bottom:14px;min-width:0;">Брой играчи<select name="playerCount" style="width:100%;max-width:100%;min-width:0;box-sizing:border-box;min-height:42px;background:#111;color:#fff;border:1px solid #555;border-radius:7px;padding:0 10px;"><option value="2">2</option><option value="4">4</option></select></label>
      <label style="display:grid;gap:7px;margin-bottom:14px;min-width:0;">Вход<select name="stake" style="width:100%;max-width:100%;min-width:0;box-sizing:border-box;min-height:42px;background:#111;color:#fff;border:1px solid #555;border-radius:7px;padding:0 10px;">${stakes.map((stake) => `<option value="${stake}">${stake} жълтици</option>`).join('')}</select></label>
      <fieldset style="border:0;padding:0;margin:0 0 18px;display:grid;gap:10px;"><legend style="margin-bottom:8px;">Старт</legend><label><input type="radio" name="startMode" value="auto" checked> При запълване</label><label><input type="radio" name="startMode" value="manual"> Ръчен старт</label></fieldset>
      <div style="display:flex;justify-content:flex-end;gap:8px;"><button type="button" data-ludo-create-close="1" style="${button}">Отказ</button><button type="submit" style="${button}background:#d4a520;color:#050505;">Създай</button></div>
    </form></div>`
  }

  function wire(): void {
    options.root.querySelector('[data-ludo-lobby-back]')?.addEventListener('click', () => {
      requestExit()
    })
    options.root.querySelectorAll<HTMLElement>('[data-ludo-lifecycle-tab]').forEach((el) => el.addEventListener('click', () => {
      const tab = el.dataset.ludoLifecycleTab as LifecycleTab
      if (tab === lifecycleTab) return
      lifecycleTab = tab
      render()
    }))
    options.root.querySelector('[data-ludo-create-open]')?.addEventListener('click', () => { createOpen = true; render() })
    options.root.querySelector('[data-ludo-create-close]')?.addEventListener('click', () => { createOpen = false; render() })
    options.root.querySelectorAll<HTMLElement>('[data-ludo-room-join]').forEach((el) => el.addEventListener('click', () => options.onJoin(el.dataset.ludoRoomJoin!)))
    options.root.querySelector('[data-ludo-room-leave]')?.addEventListener('click', () => {
      requestExit()
    })
    options.root.querySelectorAll<HTMLElement>('[data-ludo-room-kick]').forEach((el) => el.addEventListener('click', () => options.onKick(el.dataset.ludoRoomKick!)))
    options.root.querySelector('[data-ludo-room-start]')?.addEventListener('click', options.onStart)
    options.root.querySelectorAll<HTMLElement>('[data-ludo-watch-match]').forEach((el) => el.addEventListener('click', () => options.onWatch(el.dataset.ludoWatchMatch!)))
    options.root.querySelector<HTMLFormElement>('[data-ludo-create-form]')?.addEventListener('submit', (event) => {
      event.preventDefault()
      const data = new FormData(event.currentTarget as HTMLFormElement)
      createOpen = false
      options.onCreate(Number(data.get('stake')), Number(data.get('playerCount')) as 2 | 4, data.get('startMode') === 'manual')
      render()
    })
  }

  function requestExit(): void {
    if (leavePending) return
    if (myRoom === null) {
      options.onBack()
      return
    }
    leavePending = true
    message = ''
    render()
    options.onLeave()
  }

  render()
  options.onRefresh()
  options.onRefreshGames()
  return {
    setRooms(next: LudoRoomSnapshot[]) { rooms = next; myRoom = next.find((room) => room.players.some((player) => player.profileId === options.localProfileId)) ?? null; render() },
    setMyRoom(room: LudoRoomSnapshot | null) { myRoom = room; leavePending = false; render() },
    setGames(playing: LudoRoomMatchSnapshot[], finished: LudoRoomMatchSnapshot[]) { playingGames = playing; finishedGames = finished; render() },
    // kind — само визуален (светлият вариант); по подразбиране 'error' —
    // сървърните грешки минават без втори аргумент.
    showMessage(next: string, kind: LudoLobbyMessageKind = 'error') { message = next; messageKind = kind; render() },
    requestExit,
    destroy() { options.root.innerHTML = '' },
  }
}
