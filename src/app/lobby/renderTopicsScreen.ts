import type { TopicMessageSnapshot, TopicReplySnapshot, TopicAttachmentSnapshot, TopicReportStatus } from '../network/createGameServerClient'
import type { LobbyScreenState } from './renderLobbyScreen'
import { resolveAttachmentUrl, renderLinkifiedChatMessageBody } from './renderLobbyScreen'
import { renderVipRequiredPopup } from '../../ui/overlays/renderVipRequiredPopup'

// Read-only Етап 1 — root history + navigation. Етап 2 добави real composer
// (root send, VIP gate, launch gift). Етап 3 добавя реални likes (root +
// replies) и едно-ниво replies (expand/collapse, inline VIP composer) — виж
// CLAUDE.md / project memory за пълния roadmap на следващите етапи (Етап 4+
// все още не са започнати: create-topic, moderation, unread badges).

// Indentation на replies спрямо златната вертикала — намалено от 46px до
// 14px (UI polish: "не залепвай съдържанието до линията, но значително
// по-малко от сегашното"), особено ценно на mobile ширина.
const REPLY_INDENT_PX = 14
const TOPIC_MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000

// Предварително планирани duration опции (Топикс moderation брифа т.2) —
// точно ТЕЗИ 4 стойности, валидирани и server-side (виж
// TOPIC_MODERATION_ALLOWED_DURATIONS_MS в index.ts). Споделени между lock и
// mute popup-а (не отделен модел за всеки).
const TOPIC_MODERATION_DURATION_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 30 * 60 * 1000, label: '30 минути' },
  { ms: 60 * 60 * 1000, label: '1 час' },
  { ms: 3 * 60 * 60 * 1000, label: '3 часа' },
  { ms: 24 * 60 * 60 * 1000, label: '24 часа' },
]

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatTopicMessageTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('bg-BG', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function isTopicMessageEditWindowExpired(createdAt: string): boolean {
  const createdAtMs = Date.parse(createdAt)
  if (!Number.isFinite(createdAtMs)) return false
  return Date.now() - createdAtMs >= TOPIC_MESSAGE_EDIT_WINDOW_MS
}

export function formatTopicUnreadBadgeCount(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null
  const normalized = Math.floor(count)
  return String(Math.min(normalized, 99))
}

// Реален avatar от canonical profile data (senderAvatarUrl е derived
// server-side, виж коментара в TopicMessageSnapshot) — letter fallback само
// когато профилът действително няма avatar. URL винаги минава през
// escapeHtml преди инжектиране в src атрибута (без raw/unsafe rendering).
function renderMessageAvatar(senderDisplayName: string, senderAvatarUrl: string | null): string {
  const trimmedUrl = senderAvatarUrl?.trim() ?? ''
  const inner = trimmedUrl
    ? `<img src="${escapeHtml(trimmedUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`
    : escapeHtml(senderDisplayName.trim().charAt(0).toUpperCase() || '?')

  return `
    <div data-topic-message-avatar="1" style="width:36px;height:36px;border-radius:50%;flex:0 0 auto;background:linear-gradient(180deg,#2a2a2a 0%,#141414 100%);border:1px solid rgba(212,165,32,0.34);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;color:#d4a520;overflow:hidden;">${inner}</div>
  `
}

function renderTopicsBarChip(topic: { topicId: string; title: string; isGeneral: boolean; unreadCount?: number }, isActive: boolean): string {
  const activeStyle = isActive
    ? 'background:rgba(212,165,32,0.16);border-color:#d4a520;color:#d4a520;'
    : 'background:rgba(255,255,255,0.04);border-color:rgba(255,255,255,0.12);color:rgba(248,250,252,0.78);'
  const unreadBadge = isActive ? null : formatTopicUnreadBadgeCount(topic.unreadCount ?? 0)

  return `
    <button
      type="button"
      data-topic-chip="${escapeHtml(topic.topicId)}"
      class="topic-chip"
      ${isActive ? 'data-active="1"' : ''}
      style="
        flex:0 0 auto;
        display:inline-flex;
        align-items:center;
        gap:6px;
        padding:0 16px;
        border-radius:999px;
        border:1px solid;
        ${activeStyle}
        font-size:13px;
        font-weight:800;
        white-space:nowrap;
        cursor:pointer;
        scroll-snap-align:start;
      "
    ><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(topic.title)}</span>${unreadBadge !== null ? `<span class="topic-unread-badge">${escapeHtml(unreadBadge)}</span>` : ''}</button>
  `
}

function renderTopicsArrowControl(direction: 'left' | 'right'): string {
  // Скрити на touch devices (там навигацията е чрез swipe, виж CSS правилото
  // по-долу) — видими само за mouse/desktop layout. disabled по подразбиране
  // при render; enable/disable state-ът се управлява от JS wiring
  // (updateTopicsArrowState в renderLobbyScreen.ts) спрямо реалната
  // scrollLeft/scrollWidth позиция, не статично.
  const isLeft = direction === 'left'
  return `
    <button
      type="button"
      data-topics-arrow="${direction}"
      class="topics-arrow-control"
      aria-label="${isLeft ? 'Превърти темите наляво' : 'Превърти темите надясно'}"
      disabled
      style="
        flex:0 0 auto;
        align-items:center;
        justify-content:center;
        width:24px;
        height:36px;
        border:0;
        background:transparent;
        color:rgba(248,250,252,0.62);
        cursor:pointer;
        font-size:16px;
        line-height:1;
      "
    >${isLeft ? '&#8249;' : '&#8250;'}</button>
  `
}

function renderTopicsBar(state: LobbyScreenState): string {
  const topics = state.topics ?? []

  // Структура: outer flex row (data-topics-bar-row, НЕ scroll-ва) съдържа
  // "+" (flex:0 0 auto, извън scroll flow-а на чиповете), опционални ‹ ›
  // arrow controls (desktop/mouse само), и inner horizontal-scroll
  // container (data-topics-bar-scroll) само за реалните topic chips. "+"
  // никога не участва в horizontal scroll/snap/wheel movement.
  return `
    <style>
      /* Desktop може да остане по-компактен (36px); mobile изисква ~44px
         effective touch target (т.5 от корекциите) без визуално да изглежда
         прекалено голямо — само height/width растат, padding/font остават. */
      .topic-chip, .topic-create-chip { height:36px; }
      .topic-create-chip { width:36px; }
      @media (hover: none) and (pointer: coarse) {
        .topic-chip, .topic-create-chip { height:44px; }
        .topic-create-chip { width:44px; }
      }
      /* Native horizontal scrollbar скрит cross-browser — swipe/wheel/arrow
         навигацията остава напълно функционална, само визуалният scrollbar
         (който преди се показваше върху/под chips-овете) изчезва. */
      [data-topics-bar-scroll] { scrollbar-width: none; }
      [data-topics-bar-scroll]::-webkit-scrollbar { display: none; }
      /* Arrow controls са за mouse/desktop навигация — на реални touch
         устройства потребителят вече swipe-ва директно, стрелките само биха
         отнели ширина без полза. */
      .topics-arrow-control { display: inline-flex; }
      @media (hover: none) and (pointer: coarse) {
        .topics-arrow-control { display: none; }
      }
      .topics-arrow-control:disabled { opacity: 0.25; cursor: default; }
      .topics-arrow-control:not(:disabled):hover { color: #d4a520; }
      .topic-create-chip:hover { filter:brightness(1.12); }
      .topic-create-chip:active { filter:brightness(0.95); }
      .topic-unread-badge {
        min-width:18px;
        height:18px;
        border-radius:9px;
        background:#ef4444;
        color:#ffffff;
        padding:0 5px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        font-size:10px;
        font-weight:900;
        line-height:1;
        flex:0 0 auto;
      }
    </style>
    <div
      data-topics-bar-row="1"
      style="
        display:flex;
        align-items:center;
        gap:4px;
        min-width:0;
        padding:10px 4px;
      "
    >
      <button
        type="button"
        data-topics-create="1"
        class="topic-create-chip"
        aria-label="Нова тема"
        style="
          flex:0 0 auto;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          border-radius:50%;
          border:1px solid rgba(74,222,128,0.4);
          background:linear-gradient(135deg,#22c55e 0%,#16a34a 100%);
          color:#ffffff;
          font-size:18px;
          font-weight:900;
          cursor:pointer;
          margin-right:4px;
          box-shadow:0 2px 8px rgba(34,197,94,0.35);
        "
      >+</button>
      ${renderTopicsArrowControl('left')}
      <div
        data-topics-bar-scroll="1"
        style="
          flex:1;
          min-width:0;
          display:flex;
          align-items:center;
          gap:8px;
          overflow-x:auto;
          overflow-y:hidden;
          -webkit-overflow-scrolling:touch;
          scroll-snap-type:x proximity;
        "
      >
        ${topics.map((topic) => renderTopicsBarChip(topic, topic.topicId === state.activeTopicId)).join('')}
      </div>
      ${renderTopicsArrowControl('right')}
    </div>
  `
}

// Like бутон — icon-only (♡/♥), с малък числов counter до иконата (Етап 3
// брифа: "До иконата трябва да може да се показва малък числов counter",
// "Не искам постоянния текст «Харесай»" — само tooltip, не visible label).
// Reuse-ва СЪЩИЯ likeCount/viewerHasLiked overrides map за root И reply
// (виж т.13 — state.topicMessageLikeCountById/topicMessageViewerHasLikedById
// е authoritative, НЕ директно полето от snapshot-а, за realtime updates).
function renderTopicLikeButton(state: LobbyScreenState, messageId: string, snapshotLikeCount: number, snapshotViewerHasLiked: boolean): string {
  const likeCount = state.topicMessageLikeCountById[messageId] ?? snapshotLikeCount
  const viewerHasLiked = state.topicMessageViewerHasLikedById[messageId] ?? snapshotViewerHasLiked
  const isPending = Boolean(state.topicMessageLikePendingRequestIdById[messageId])

  return `
    <button
      type="button"
      data-topic-message-like="${escapeHtml(messageId)}"
      class="topic-message-action-btn${viewerHasLiked ? ' topic-message-action-btn-liked' : ''}"
      aria-label="Харесай"
      aria-pressed="${viewerHasLiked ? 'true' : 'false'}"
      data-tooltip="Харесай"
      ${isPending ? 'disabled' : ''}
    ><span class="topic-message-action-icon" aria-hidden="true">${viewerHasLiked ? '&#9829;' : '&#9825;'}</span>${likeCount > 0 ? `<span class="topic-message-action-count">${likeCount}</span>` : ''}</button>
  `
}

function renderTopicReplyButton(rootMessageId: string, replyCount: number): string {
  return `
    <button
      type="button"
      data-topic-message-reply="${escapeHtml(rootMessageId)}"
      class="topic-message-action-btn"
      aria-label="Отговори"
      data-tooltip="Отговори"
    ><span class="topic-message-action-icon" aria-hidden="true">&#128172;</span>${replyCount > 0 ? `<span class="topic-message-action-count">${replyCount}</span>` : ''}</button>
  `
}

// Individual message/reply delete — icon-only, до Like/Reply action
// бутоните (root) или до Like бутона (reply). Visibility: moderator (5
// роли) ИЛИ author на самото съобщение (own-delete-own-content брифа §21).
// Author+moderator overlap показва САМО ЕДИН бутон (следва moderator
// capability — §23), не два.
//
// Semantics при клик зависят от viewer capability, не от isRoot сам по
// себе си:
//  - Moderator: винаги enabled за live target, root delete триe thread-а
//    (established, непроменено).
//  - Ordinary author (НЕ moderator): reply винаги enabled; root enabled
//    САМО ако replyCount===0, ИНАЧЕ disabled (видим, НЕ скрит — §21/§22).
//    Server е authoritative за реалната проверка (race-safe вътре в
//    транзакцията, виж deleteOwnMessage()) — клиентският replyCount е само
//    UX hint за disabled state, не security boundary.
function renderTopicMessageDeleteButton(
  state: LobbyScreenState,
  messageId: string,
  isRoot: boolean,
  senderProfileId: string,
  replyCount: number,
): string {
  const isModerator = state.isTopicMessageModerator
  const isOwner = state.profile.profileId !== null && senderProfileId === state.profile.profileId
  if (!isModerator && !isOwner) return ''

  // Moderator capability има предимство при overlap — root с replies остава
  // enabled, thread-wide delete (§7/§23), независимо че viewer е и author.
  const isBlockedOwnRootWithReplies = !isModerator && isOwner && isRoot && replyCount > 0

  // isModeratorAction определя confirmation текста (root: "и всички
  // отговори" САМО ако действа moderator capability-то; ordinary own-root
  // delete по дефиниция е 0-replies, значи текстът не бива да ги споменава
  // — §24). Пренасяме го през data-attribute, тъй като render-ът тук вече
  // знае authoritative viewer capability (isModerator/isOwner), докато click
  // handler-ът долу (renderLobbyScreen.ts) само чете DOM.
  const isModeratorAction = isModerator

  return `
    <button
      type="button"
      data-topic-message-delete="${escapeHtml(messageId)}"
      data-topic-message-delete-is-root="${isRoot ? '1' : '0'}"
      data-topic-message-delete-is-moderator-action="${isModeratorAction ? '1' : '0'}"
      class="topic-message-action-btn"
      aria-label="Изтрий"
      data-tooltip="${isBlockedOwnRootWithReplies ? 'Не можете да изтриете публикация, към която вече има отговори.' : 'Изтрий'}"
      ${isBlockedOwnRootWithReplies ? 'aria-disabled="true" data-topic-message-delete-blocked="1"' : ''}
      style="${isBlockedOwnRootWithReplies ? 'opacity:0.4;cursor:not-allowed;' : ''}"
    ><span class="topic-message-action-icon" aria-hidden="true">&#128465;</span></button>
  `
}

function renderTopicMessageEditButton(
  state: LobbyScreenState,
  messageId: string,
  isRoot: boolean,
  senderProfileId: string,
  createdAt: string,
  replyCount: number,
): string {
  const isOwner = state.profile.profileId !== null && senderProfileId === state.profile.profileId
  if (!isOwner) return ''

  const isLocked = Boolean(state.activeTopicLock?.isLocked)
  const isExpired = isTopicMessageEditWindowExpired(createdAt)
  const hasLiveReplies = isRoot && replyCount > 0
  const blockedReason = isLocked
    ? 'Темата е заключена.'
    : hasLiveReplies
      ? 'Не можете да редактирате публикация, към която вече има отговори.'
      : isExpired
        ? 'Времето за редакция изтече.'
        : null

  return `
    <button
      type="button"
      data-topic-message-edit="${escapeHtml(messageId)}"
      class="topic-message-action-btn"
      aria-label="Редактирай"
      data-tooltip="${escapeHtml(blockedReason ?? 'Редактирай')}"
      ${blockedReason ? 'aria-disabled="true" data-topic-message-edit-blocked="1"' : ''}
      style="${blockedReason ? 'opacity:0.4;cursor:not-allowed;' : ''}"
    ><span class="topic-message-action-icon" aria-hidden="true">&#9998;</span></button>
  `
}

function renderTopicMessageEditForm(state: LobbyScreenState, messageId: string): string {
  const edit = state.topicMessageEdit
  if (edit === null || edit.messageId !== messageId) return ''

  const busy = state.topicMessageEditBusy
  const errorText = state.topicMessageEditErrorText
  return `
    <form data-topic-message-edit-form="${escapeHtml(messageId)}" style="display:grid;gap:8px;margin-top:2px;">
      <textarea
        data-topic-message-edit-text="${escapeHtml(messageId)}"
        rows="3"
        maxlength="2000"
        ${busy ? 'disabled' : ''}
        style="box-sizing:border-box;width:100%;min-height:76px;max-height:180px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#f8fafc;padding:9px 10px;font-size:14px;font-weight:600;outline:none;resize:vertical;font-family:inherit;line-height:1.45;"
      >${escapeHtml(edit.draft)}</textarea>
      <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;">
        <button
          type="button"
          data-topic-message-edit-cancel="${escapeHtml(messageId)}"
          ${busy ? 'disabled' : ''}
          style="height:34px;padding:0 10px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:transparent;color:rgba(248,250,252,0.72);font-size:12px;font-weight:800;cursor:${busy ? 'default' : 'pointer'};"
        >Откажи</button>
        <button
          type="submit"
          data-topic-message-edit-save="${escapeHtml(messageId)}"
          ${busy ? 'disabled' : ''}
          style="height:34px;padding:0 12px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:12px;font-weight:900;cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.6' : '1'};"
        >Запази</button>
      </div>
      ${errorText ? `<div style="font-size:11px;color:#f87171;">${escapeHtml(errorText)}</div>` : ''}
    </form>
  `
}

function renderTopicAuthorBlock(state: LobbyScreenState, senderProfileId: string, senderDisplayName: string, senderAvatarUrl: string | null, createdAt: string, editedAt: string | null): string {
  // MUTE/UNMUTE compact icon бутон — само за модератор, само за активната
  // тема (mute е topic-specific, брифа т.4), скрит за собствения профил на
  // viewer-a (модератор не мутира себе си). Не претрупва обикновения
  // потребителски изглед — виждан само от isTopicModerator.
  const ownProfileId = state.profile.profileId
  const canModerateThisAuthor = state.isTopicModerator && state.activeTopicId !== null && senderProfileId !== ownProfileId
  const isMuteStatusLoading = state.topicMuteStatusLoadingProfileId === senderProfileId
  const muteControl = canModerateThisAuthor
    ? `
      <button
        type="button"
        data-topic-mute-toggle="${escapeHtml(senderProfileId)}"
        data-topic-mute-toggle-name="${escapeHtml(senderDisplayName)}"
        title="Модерация"
        aria-label="Модерация на ${escapeHtml(senderDisplayName)}"
        ${isMuteStatusLoading ? 'disabled' : ''}
        style="border:0;background:transparent;padding:2px 4px;cursor:${isMuteStatusLoading ? 'default' : 'pointer'};color:rgba(248,250,252,0.38);font-size:14px;line-height:1;flex:0 0 auto;opacity:${isMuteStatusLoading ? '0.5' : '1'};"
      >&#9881;</button>
    `
    : ''

  return `
    <button
      type="button"
      data-topic-message-author="${escapeHtml(senderProfileId)}"
      data-topic-message-author-name="${escapeHtml(senderDisplayName)}"
      style="border:0;background:transparent;padding:0;cursor:pointer;flex:0 0 auto;"
      aria-label="Профил на ${escapeHtml(senderDisplayName)}"
    >${renderMessageAvatar(senderDisplayName, senderAvatarUrl)}</button>
    <div style="flex:1;min-width:0;">
      <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
        <button
          type="button"
          data-topic-message-author="${escapeHtml(senderProfileId)}"
          data-topic-message-author-name="${escapeHtml(senderDisplayName)}"
          style="border:0;background:transparent;padding:0;cursor:pointer;font-size:14px;font-weight:900;color:#f8fafc;"
        >${escapeHtml(senderDisplayName)}</button>
        <span style="font-size:12px;color:rgba(248,250,252,0.42);">${formatTopicMessageTime(createdAt)}${editedAt !== null ? ' · редактирано' : ''}</span>
        ${muteControl}
      </div>
    </div>
  `
}

/** Inline reply composer — reuse на renderTopicsComposer VIP-gated textarea pattern-а, но БЕЗ readonly escape hatch: composer-ът се render-ва САМО за VIP (non-VIP click отваря VIP popup-а вместо да отвори composer-а, виж onTopicReplyClick в controller-а), затова тук винаги е editable. */
// Desktop пази текстовите бутони ("Откажи"/"Изпрати") — mobile (touch/coarse
// pointer) ги свива до icon-only, за да не изяждат хоризонталното място на
// reply composer-а (виж CSS по-долу, огледално на established
// @media (hover:none) and (pointer:coarse) конвенцията, ползвана вече за
// .topics-arrow-control/.topic-message-action-btn в този файл). Едно DOM
// рендиране за двата layout-а — label текст + icon glyph са и двата
// маркирани с CSS класове, видимостта им се превключва по media query, не
// JS device detection.
// Компактен icon-only image picker, споделен между root и reply composer-а
// (Attachment feature брифа т.2/3) — reuse на layout-а от
// renderChatImagePickerControls (renderLobbyScreen.ts), но с VIP gate:
// non-VIP клик отваря СЪЩИЯ VIP popup като текстовото поле, БЕЗ да отваря
// file picker (data-topics-image-pick-vip-locked маркира интерцепцията,
// wiring-ът е в renderLobbyScreen.ts, огледално на data-topics-composer-vip-locked).
function renderTopicsImagePickerControls(options: {
  kind: 'root' | 'reply'
  key: string
  pending: { previewUrl: string } | null
  isSending: boolean
  isVip: boolean
}): string {
  const { kind, key, pending, isSending, isVip } = options
  const disabled = isSending
  const inputAttr = kind === 'root' ? `data-topics-image-input="${escapeHtml(key)}"` : `data-topics-reply-image-input="${escapeHtml(key)}"`
  const pickAttr = kind === 'root' ? `data-topics-image-pick="${escapeHtml(key)}"` : `data-topics-reply-image-pick="${escapeHtml(key)}"`
  const removeAttr = kind === 'root' ? `data-topics-image-remove="${escapeHtml(key)}"` : `data-topics-reply-image-remove="${escapeHtml(key)}"`
  const vipLockedAttr = isVip ? '' : 'data-topics-image-vip-locked="1"'
  const size = kind === 'root' ? 40 : 36

  return `
    <input
      type="file"
      accept="image/jpeg,image/png,image/webp"
      ${inputAttr}
      style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;"
      ${disabled ? 'disabled' : ''}
    >
    <button
      type="button"
      ${pickAttr}
      ${vipLockedAttr}
      title="Добави снимка"
      aria-label="Добави снимка"
      ${disabled ? 'disabled' : ''}
      style="height:${size}px;width:${size}px;flex:0 0 auto;border:1px solid rgba(212,165,32,0.34);border-radius:8px;background:#050505;color:#d4a520;display:flex;align-items:center;justify-content:center;cursor:${disabled ? 'default' : 'pointer'};opacity:${disabled ? '0.5' : '1'};"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>
    </button>
    ${pending ? `
      <div style="position:relative;flex:0 0 auto;">
        <img src="${escapeHtml(pending.previewUrl)}" alt="" style="width:${size}px;height:${size}px;object-fit:cover;border-radius:8px;border:1px solid rgba(212,165,32,0.48);display:block;">
        <button
          type="button"
          ${removeAttr}
          title="Премахни снимката"
          aria-label="Премахни снимката"
          ${disabled ? 'disabled' : ''}
          style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:0;background:#ef4444;color:#fff;font-size:11px;font-weight:900;line-height:1;display:flex;align-items:center;justify-content:center;cursor:${disabled ? 'default' : 'pointer'};padding:0;"
        >✕</button>
      </div>
    ` : ''}
  `
}

function renderInlineReplyComposer(state: LobbyScreenState, rootMessageId: string): string {
  const draft = state.topicReplyComposerDraftByRootId[rootMessageId] ?? ''
  const isSending = Boolean(state.topicReplyComposerPendingRequestIdByRootId[rootMessageId])
  const errorText = state.topicReplyComposerErrorTextByRootId[rootMessageId] ?? null
  const pendingImage = state.topicReplyComposerPendingImageByRootId[rootMessageId] ?? null
  const isVip = state.topicsVipGate?.isActive ?? false

  return `
    <style>
      .topics-reply-composer-btn { display:inline-flex; align-items:center; justify-content:center; }
      .topics-reply-composer-btn-icon { display:none; font-size:16px; line-height:1; }
      @media (hover: none) and (pointer: coarse) {
        .topics-reply-composer-btn { width:36px; padding:0 !important; }
        .topics-reply-composer-btn-label { display:none; }
        .topics-reply-composer-btn-icon { display:inline-flex; }
      }
    </style>
    <div style="margin:6px 0 10px;padding-left:${REPLY_INDENT_PX}px;">
      <form
        data-topics-reply-composer-form="1"
        data-topics-reply-composer-root-id="${escapeHtml(rootMessageId)}"
        style="display:flex;align-items:flex-end;gap:8px;"
      >
        ${renderTopicsImagePickerControls({
          kind: 'reply',
          key: rootMessageId,
          pending: pendingImage,
          isSending,
          isVip,
        })}
        <textarea
          data-topics-reply-composer-text="1"
          name="body"
          rows="1"
          maxlength="2000"
          placeholder="Напиши отговор..."
          style="
            flex:1;min-width:0;max-height:100px;min-height:36px;box-sizing:border-box;
            border-radius:8px;border:1px solid rgba(212,165,32,0.24);background:#050505;
            color:#f8fafc;padding:8px 10px;font-size:13px;font-weight:600;outline:none;
            resize:none;font-family:inherit;line-height:1.4;overflow-y:auto;
          "
        >${escapeHtml(draft)}</textarea>
        <button
          type="button"
          data-topics-reply-composer-cancel="${escapeHtml(rootMessageId)}"
          class="topics-reply-composer-btn"
          aria-label="Откажи отговора"
          style="flex:0 0 auto;height:36px;padding:0 10px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:transparent;color:rgba(248,250,252,0.62);font-size:12px;font-weight:800;cursor:pointer;"
        ><span class="topics-reply-composer-btn-label">Откажи</span><span class="topics-reply-composer-btn-icon" aria-hidden="true">&#10005;</span></button>
        <button
          data-topics-reply-composer-send="1"
          type="submit"
          class="topics-reply-composer-btn"
          aria-label="Изпрати отговора"
          ${isSending ? 'disabled' : ''}
          style="
            flex:0 0 auto;height:36px;padding:0 12px;border:0;border-radius:8px;
            background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;
            font-size:12px;font-weight:900;cursor:${isSending ? 'default' : 'pointer'};opacity:${isSending ? '0.6' : '1'};
          "
        ><span class="topics-reply-composer-btn-label">Изпрати</span><span class="topics-reply-composer-btn-icon" aria-hidden="true">&#10148;</span></button>
      </form>
      ${errorText ? `<div style="padding:4px 0 0;font-size:11px;color:#f87171;">${escapeHtml(errorText)}</div>` : ''}
    </div>
  `
}

export function renderTopicReplyRow(state: LobbyScreenState, reply: TopicReplySnapshot): string {
  const isEditing = state.topicMessageEdit?.messageId === reply.messageId
  return `
    <div data-topic-reply="${escapeHtml(reply.messageId)}">
      <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 4px 8px ${REPLY_INDENT_PX}px;">
        ${renderTopicAuthorBlock(state, reply.senderProfileId, reply.senderDisplayName, reply.senderAvatarUrl, reply.createdAt, reply.editedAt)}
      </div>
      <div style="margin:-6px 0 6px ${REPLY_INDENT_PX}px;">
        ${isEditing
          ? renderTopicMessageEditForm(state, reply.messageId)
          : (reply.body.length > 0 ? `<div style="font-size:14px;line-height:1.4;color:#e2e8f0;word-break:break-word;overflow-wrap:anywhere;">${renderLinkifiedChatMessageBody(reply.body)}</div>` : '')
        }
        ${reply.attachment ? renderTopicAttachment(reply.attachment, state.apiBaseUrl) : ''}
        <div style="margin-top:2px;margin-left:-8px;display:flex;align-items:center;gap:10px;">
          ${renderTopicLikeButton(state, reply.messageId, reply.likeCount, reply.viewerHasLiked)}
          ${renderTopicMessageEditButton(state, reply.messageId, false, reply.senderProfileId, reply.createdAt, 0)}
          ${renderTopicMessageDeleteButton(state, reply.messageId, false, reply.senderProfileId, 0)}
        </div>
      </div>
    </div>
  `
}

function renderRepliesSection(state: LobbyScreenState, rootMessageId: string): string {
  const isExpanded = state.topicExpandedReplyRootIds.includes(rootMessageId)
  if (!isExpanded) return ''

  const replies = state.topicRepliesByRootId[rootMessageId]
  const isLoading = Boolean(state.topicRepliesLoadingByRootId[rootMessageId])
  const hasMore = Boolean(state.topicRepliesHasMoreByRootId[rootMessageId])

  const listHtml = replies === null || replies === undefined
    ? (isLoading ? `<div style="padding:8px 0 8px ${REPLY_INDENT_PX}px;color:rgba(248,250,252,0.42);font-size:12px;">Зареждане на отговори...</div>` : '')
    : replies.length === 0
      ? `<div style="padding:4px 0 8px ${REPLY_INDENT_PX}px;color:rgba(248,250,252,0.36);font-size:12px;">Все още няма отговори.</div>`
      : replies.map((r) => renderTopicReplyRow(state, r)).join('')

  const loadMoreHtml = hasMore && replies !== null && replies !== undefined
    ? `
      <div style="padding-left:${REPLY_INDENT_PX}px;padding-bottom:6px;">
        <button
          type="button"
          data-topic-replies-load-more="${escapeHtml(rootMessageId)}"
          ${isLoading ? 'disabled' : ''}
          style="border:0;background:transparent;color:#d4a520;font-size:12px;font-weight:800;cursor:${isLoading ? 'default' : 'pointer'};padding:4px 0;"
        >${isLoading ? 'Зареждане...' : 'Покажи още'}</button>
      </div>
    `
    : ''

  const composerHtml = state.topicReplyComposerOpenRootId === rootMessageId
    ? renderInlineReplyComposer(state, rootMessageId)
    : ''

  // Златната вертикала — по-ярка и по-ясно видима (т.1 от брифа: "около 2px",
  // "малко по-ярка", "без прекален glow") — alpha вдигнат от 0.16 на 0.55,
  // без box-shadow/glow ефект, за да остане елегантен, не крещящ.
  return `
    <div data-topic-replies-section="${escapeHtml(rootMessageId)}" style="border-left:2px solid rgba(212,165,32,0.55);margin-left:18px;">
      ${listHtml}
      ${loadMoreHtml}
      ${composerHtml}
    </div>
  `
}

// Публикувана снимка — компактно, responsive, запазено aspect ratio,
// rounded corners в Pika.bg стил (Attachment брифа т.9: desktop max
// ~320-400px, mobile max-width:100%). Click отваря reusable in-app viewer
// (data-image-viewer-open, wiring в renderLobbyScreen.ts) — НЕ target="_blank".
export function renderTopicAttachment(attachment: TopicAttachmentSnapshot, apiBaseUrl: string): string {
  // Reuse на established API origin resolver-а (main.ts getApiBaseUrl, виж
  // resolveAttachmentUrl в renderLobbyScreen.ts) — в local dev frontend-ът
  // тича на отделен Vite origin (:5173), докато сървърът (и protected
  // attachment route-а) е на :3001. viewUrl/downloadUrl от сървъра са
  // relative (/api/topics/.../attachments/...) — без resolve, browser-ът ги
  // зарежда спрямо :5173 и удря SPA fallback-а (text/html вместо image/webp).
  const viewUrl = resolveAttachmentUrl(apiBaseUrl, attachment.viewUrl)
  const downloadUrl = resolveAttachmentUrl(apiBaseUrl, attachment.downloadUrl)
  return `
    <div style="margin-top:8px;display:grid;gap:6px;max-width:min(360px, calc(100% - 12px));width:100%;">
      <button
        type="button"
        data-image-viewer-open="1"
        data-image-viewer-view-url="${escapeHtml(viewUrl)}"
        data-image-viewer-download-url="${escapeHtml(downloadUrl)}"
        style="display:block;border-radius:10px;overflow:hidden;line-height:0;border:0;padding:0;background:transparent;cursor:pointer;text-align:left;width:100%;"
      >
        <img
          src="${escapeHtml(viewUrl)}"
          width="${attachment.width}"
          height="${attachment.height}"
          loading="lazy"
          alt=""
          style="display:block;max-width:100%;width:100%;height:auto;border-radius:10px;background:rgba(255,255,255,0.06);pointer-events:none;"
        >
      </button>
      <a href="${escapeHtml(downloadUrl)}" download style="display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:900;color:rgba(248,250,252,0.72);text-decoration:none;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>
        Изтегли
      </a>
    </div>
  `
}

export function renderTopicMessageRow(state: LobbyScreenState, message: TopicMessageSnapshot): string {
  const isEditing = state.topicMessageEdit?.messageId === message.messageId
  return `
    <div data-topic-message="${escapeHtml(message.messageId)}">
      <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 4px 0;">
        ${renderTopicAuthorBlock(state, message.senderProfileId, message.senderDisplayName, message.senderAvatarUrl, message.createdAt, message.editedAt)}
      </div>
      <div style="padding:0 4px 10px 46px;">
        ${isEditing
          ? renderTopicMessageEditForm(state, message.messageId)
          : (message.body.length > 0 ? `<div style="margin-top:2px;font-size:15px;line-height:1.45;color:#e2e8f0;word-break:break-word;overflow-wrap:anywhere;">${renderLinkifiedChatMessageBody(message.body)}</div>` : '')
        }
        ${message.attachment ? renderTopicAttachment(message.attachment, state.apiBaseUrl) : ''}
        <div style="margin-top:4px;margin-left:-8px;display:flex;align-items:center;gap:10px;">
          ${renderTopicLikeButton(state, message.messageId, message.likeCount, message.viewerHasLiked)}
          ${renderTopicReplyButton(message.messageId, message.replyCount)}
          ${renderTopicMessageEditButton(state, message.messageId, true, message.senderProfileId, message.createdAt, message.replyCount)}
          ${renderTopicMessageDeleteButton(state, message.messageId, true, message.senderProfileId, message.replyCount)}
        </div>
      </div>
      ${renderRepliesSection(state, message.messageId)}
    </div>
  `
}

function renderTopicMessageStream(state: LobbyScreenState): string {
  if (state.topicMessagesLoading && (state.topicMessages === null || state.topicMessages.length === 0)) {
    return `
      <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;color:rgba(248,250,252,0.5);font-size:14px;">
        Зареждане...
      </div>
    `
  }

  if (state.topicMessagesErrorText) {
    return `
      <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;color:#f87171;font-size:14px;text-align:center;padding:0 16px;">
        ${escapeHtml(state.topicMessagesErrorText)}
      </div>
    `
  }

  const messages = state.topicMessages ?? []

  if (messages.length === 0) {
    return `
      <div data-topic-messages-empty="1" style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;color:rgba(248,250,252,0.42);font-size:14px;">
        Все още няма съобщения.
      </div>
    `
  }

  const loadOlderIndicator = state.topicOlderMessagesLoading
    ? `<div style="text-align:center;padding:8px 0;color:rgba(248,250,252,0.42);font-size:12px;">Зареждане на по-стари...</div>`
    : ''

  // flex:1;min-height:0 е ключовото за "само това да scroll-ва вертикално" —
  // min-height:0 override-ва default flex item min-height:auto (иначе flex
  // item-ът би отказал да се свие под content-a си и overflow-y:auto никога
  // не би се активирал в родителски-ограничена височина).
  return `
    <style>
      /* Like/Reply — само икона (без постоянен текст), второстепенни спрямо
         съобщението (приглушен цвят), но с реална tap/click зона по-голяма
         от самата глифа (padding) — desktop ~38px effective размер, mobile
         ~44px (media query), огледално на .topic-chip/.topic-create-chip
         конвенцията за touch target-и. position:relative тук е anchor-ът за
         ::after tooltip-а по-долу (същия pattern като
         .lobby-nav-btn-icon-only в renderNav — виж коментара там). */
      .topic-message-action-btn {
        position:relative;
        display:inline-flex;align-items:center;justify-content:center;
        gap:4px;
        border:0;background:transparent;border-radius:8px;
        padding:9px;
        color:rgba(248,250,252,0.46);
        cursor:pointer;
      }
      .topic-message-action-icon {
        font-size:20px;
        line-height:1;
      }
      .topic-message-action-count {
        font-size:12px;
        font-weight:800;
        color:inherit;
      }
      .topic-message-action-btn:hover { background:rgba(255,255,255,0.06); color:rgba(248,250,252,0.8); }
      .topic-message-action-btn:active { background:rgba(255,255,255,0.10); }
      /* Active liked state — ясно различимо (Pika.bg gold accent + filled
         heart glyph), но остава в icon-only стилистиката (Етап 3 брифа: "Не
         искам постоянния текст «Харесай»"). */
      .topic-message-action-btn-liked { color:#d4a520; }
      .topic-message-action-btn-liked:hover { color:#f4c95b; }
      .topic-message-action-btn:disabled { opacity:0.6; cursor:default; }
      @media (hover: none) and (pointer: coarse) {
        .topic-message-action-btn { padding:11px; }
      }
      /* Desktop hover/keyboard-focus tooltip — reuse на established
         Pika.bg icon-only tooltip pattern (виж .lobby-nav-btn-icon-only в
         renderNav, renderLobbyScreen.ts), не browser-native title атрибут.
         position:absolute маха tooltip-а от normal flow — не мести layout-а. */
      .topic-message-action-btn::after {
        content: attr(data-tooltip);
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%) translateY(6px);
        background: #0a0a0a;
        border: 1px solid rgba(212,165,32,0.35);
        color: #d4a520;
        font-size: 11px; font-weight: 700;
        padding: 5px 10px;
        border-radius: 6px;
        white-space: nowrap;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease;
        z-index: 1000;
      }
      /* Blocked own-root-with-replies tooltip е пълно изречение, не 1 дума
         (own-delete-own-content брифа §22) — nowrap би overflow-нал извън
         viewport-а, затова explicit wrap + width bound само за този case. */
      .topic-message-action-btn[data-topic-message-delete-blocked="1"]::after {
        white-space: normal;
        width: 200px;
        text-align: center;
        line-height: 1.4;
      }
      .topic-message-action-btn[data-topic-message-edit-blocked="1"]::after {
        white-space: normal;
        width: 220px;
        text-align: center;
        line-height: 1.4;
      }
      .topic-message-action-btn:hover::after,
      .topic-message-action-btn:focus-visible::after,
      .topic-message-action-btn:focus::after,
      .topic-message-action-btn[data-tooltip-open="1"]::after {
        opacity: 1;
      }
      /* Само hover устройства виждат tooltip-а изобщо — на touch (mobile)
         :hover може да "залепне" след tap и да остави tooltip видим. */
      @media (hover: none) and (pointer: coarse) {
        .topic-message-action-btn:hover::after { opacity: 0; }
        .topic-message-action-btn:focus-visible::after,
        .topic-message-action-btn:focus::after,
        .topic-message-action-btn[data-tooltip-open="1"]::after { opacity: 1; }
      }
    </style>
    <div data-topic-messages-scroll="1" style="flex:1;min-height:0;display:flex;flex-direction:column;overflow-y:auto;overscroll-behavior-y:contain;-webkit-overflow-scrolling:touch;">
      ${loadOlderIndicator}
      <div data-topic-messages-list="1" style="display:flex;flex-direction:column;">
        ${messages.map((m) => renderTopicMessageRow(state, m)).join('')}
      </div>
    </div>
  `
}

// Реален composer (Етап 2) — textarea (Enter=send, Shift+Enter=newline,
// bounded auto-grow, wiring в renderLobbyScreen.ts), VIP-gated за Non-VIP:
//
// - VIP (isActive=true): нормално editable поле.
// - Non-VIP (isActive=false, вкл. все още незареден gate статус): textarea
//   е `readonly` (НЕ `disabled`) — визуално изглежда като нормално поле,
//   без сив/disabled стил. `data-topics-composer-vip-locked="1"` маркира
//   състоянието за renderLobbyScreen.ts да прикачи pointerdown interception
//   (preventDefault ПРЕДИ focus/mobile keyboard) вместо нормален focus.
function renderTopicsComposer(state: LobbyScreenState, topicId: string): string {
  const isVip = state.topicsVipGate?.isActive ?? false
  const draft = state.topicComposerDraftByTopicId[topicId] ?? ''
  const isSending = Boolean(state.topicComposerPendingRequestIdByTopicId[topicId])
  const errorText = state.topicComposerErrorTextByTopicId[topicId] ?? null
  const pendingImage = state.topicComposerPendingImageByTopicId[topicId] ?? null

  // Mobile Send бутон става icon-only (СЪЩИЯТ CSS class/media query pattern
  // като inline reply composer-a, виж renderInlineReplyComposer) — desktop
  // пази текстовия label непроменен. Класовете са споделени/идентични с
  // .topics-reply-composer-btn*, затова CSS правилата не влизат в конфликт,
  // ако двата composer-а са в DOM-а едновременно (root + expanded reply).
  return `
    <style>
      .topics-reply-composer-btn { display:inline-flex; align-items:center; justify-content:center; }
      .topics-reply-composer-btn-icon { display:none; font-size:16px; line-height:1; }
      @media (hover: none) and (pointer: coarse) {
        .topics-reply-composer-btn { width:40px; padding:0 !important; }
        .topics-reply-composer-btn-label { display:none; }
        .topics-reply-composer-btn-icon { display:inline-flex; }
      }
    </style>
    <form
      data-topics-composer-form="1"
      data-topics-composer-topic-id="${escapeHtml(topicId)}"
      ${isVip ? '' : 'data-topics-composer-vip-locked="1"'}
      style="
        flex:0 0 auto;
        display:flex;
        align-items:flex-end;
        gap:8px;
        padding:10px 12px;
        border:1px solid rgba(255,255,255,0.10);
        border-top:1px solid rgba(255,255,255,0.14);
        border-radius:0 0 12px 12px;
        background:#0a0a0a;
      "
    >
      ${renderTopicsImagePickerControls({
        kind: 'root',
        key: topicId,
        pending: pendingImage,
        isSending,
        isVip,
      })}
      <textarea
        data-topics-composer-text="1"
        name="body"
        rows="1"
        maxlength="2000"
        placeholder="Напиши съобщение..."
        ${isVip ? '' : 'readonly'}
        style="
          flex:1;
          min-width:0;
          max-height:120px;
          min-height:40px;
          box-sizing:border-box;
          border-radius:8px;
          border:1px solid rgba(212,165,32,0.24);
          background:#050505;
          color:#f8fafc;
          padding:10px 12px;
          font-size:14px;
          font-weight:600;
          outline:none;
          resize:none;
          font-family:inherit;
          line-height:1.4;
          overflow-y:auto;
        "
      >${escapeHtml(draft)}</textarea>
      <button
        data-topics-composer-send="1"
        type="submit"
        class="topics-reply-composer-btn"
        aria-label="Изпрати съобщението"
        ${isSending ? 'disabled' : ''}
        style="
          flex:0 0 auto;
          height:40px;
          padding:0 16px;
          border:0;
          border-radius:8px;
          background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
          color:#080808;
          font-size:13px;
          font-weight:900;
          cursor:${isSending ? 'default' : 'pointer'};
          opacity:${isSending ? '0.6' : '1'};
        "
      ><span class="topics-reply-composer-btn-label">Изпрати</span><span class="topics-reply-composer-btn-icon" aria-hidden="true">&#10148;</span></button>
    </form>
    ${errorText ? `<div data-topics-composer-error="1" style="flex:0 0 auto;padding:4px 12px 0;font-size:12px;color:#f87171;">${escapeHtml(errorText)}</div>` : ''}
  `
}

// Кратък "ще бъде налично скоро" toast за create-topic/like/reply (все още
// неимплементирани, UI polish pass) — огледално на renderSubadminActionToast
// в renderLobbyScreen.ts (същия layout/анимация), но локален за Topics
// екрана, вместо да пипаме глобалните mobile/desktop mount точки.
function renderTopicsInfoToast(state: LobbyScreenState): string {
  const toast = state.topicsInfoToast
  if (!toast) return ''

  return `
    <div style="
      position:fixed;inset:0;z-index:9700;
      display:flex;align-items:flex-end;justify-content:center;
      padding-bottom:64px;
      pointer-events:none;
    ">
      <div style="
        pointer-events:auto;
        background:#1a1a2e;
        border:1px solid rgba(212,165,32,0.55);
        border-radius:12px;
        padding:14px 22px;
        text-align:center;
        box-shadow:0 8px 40px rgba(0,0,0,0.7);
        max-width:calc(100vw - 48px);
        animation:topicsInfoToastIn 0.18s ease both;
      ">
        <style>
          @keyframes topicsInfoToastIn {
            from { opacity:0; transform:scale(0.92); }
            to   { opacity:1; transform:scale(1); }
          }
        </style>
        <div style="font-size:14px;font-weight:800;color:#fde68a;">${escapeHtml(toast.text)}</div>
      </div>
    </div>
  `
}

// Lock/Mute action popup — единна форма (kind='lock'|'mute'), огледална на
// renderSubadminActionConfirmPopup стила (fullscreen dark backdrop,
// centered card), но с duration избор + кратко reason поле (брифа т.5:
// "1. избор на duration; 2. поле за причина; 3. потвърждение" — потвърждение
// е самия Submit бутон тук, single-step е достатъчно за lock/mute, за
// разлика от delete, който изисква двустъпков confirm).
function renderTopicModerationActionPopup(state: LobbyScreenState): string {
  const pending = state.topicModerationActionPopup
  if (!pending) return ''

  if (pending.kind === 'unmute') {
    const busy = state.topicModerationActionBusy
    return `
      <div style="position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);padding:16px;">
        <div style="background:#1a1a2e;border:1px solid rgba(212,165,32,0.35);border-radius:16px;padding:24px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.6);">
          <div style="font-size:17px;font-weight:900;color:#fff;margin-bottom:4px;">Отглуши потребител?</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.55);margin-bottom:20px;">
            ${escapeHtml(pending.targetDisplayName)} е заглушен в тази тема${pending.mutedUntil ? ` до ${escapeHtml(formatModerationExpiry(pending.mutedUntil))}` : ''}.
          </div>
          ${state.topicModerationActionErrorText ? `<div style="font-size:12px;color:#f87171;margin-bottom:8px;">${escapeHtml(state.topicModerationActionErrorText)}</div>` : ''}
          <div style="display:flex;gap:12px;">
            <button type="button" data-topic-moderation-cancel="1" ${busy ? 'disabled' : ''} style="
              flex:1;padding:11px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);
              border-radius:10px;color:rgba(255,255,255,0.7);font-size:14px;font-weight:700;
              cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.6' : '1'};
            ">Отказ</button>
            <button type="button" data-topic-moderation-submit="1" ${busy ? 'disabled' : ''} style="
              flex:1;padding:11px;border:1px solid rgba(74,222,128,0.5);background:rgba(74,222,128,0.16);
              border-radius:10px;color:#4ade80;font-size:14px;font-weight:900;
              cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.7' : '1'};
            ">${busy ? 'Изчакай…' : 'Отглуши'}</button>
          </div>
        </div>
      </div>
    `
  }

  const isLock = pending.kind === 'lock'
  const title = isLock ? 'Заключи темата' : 'Заглуши потребител'
  const subtitle = isLock
    ? escapeHtml(pending.topicTitle)
    : `${escapeHtml(pending.targetDisplayName)} — в тази тема`
  const busy = state.topicModerationActionBusy
  const selectedDurationMs = state.topicModerationActionDurationMs

  return `
    <div style="position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);padding:16px;">
      <div style="background:#1a1a2e;border:1px solid rgba(212,165,32,0.35);border-radius:16px;padding:24px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.6);">
        <div style="font-size:17px;font-weight:900;color:#fff;margin-bottom:4px;">${escapeHtml(title)}</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.55);margin-bottom:16px;">${subtitle}</div>

        <div style="font-size:12px;font-weight:800;color:rgba(255,255,255,0.7);margin-bottom:8px;">Продължителност</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">
          ${TOPIC_MODERATION_DURATION_OPTIONS.map((opt) => {
            const isSelected = selectedDurationMs === opt.ms
            return `
              <button type="button" data-topic-moderation-duration="${opt.ms}" ${busy ? 'disabled' : ''} style="
                padding:9px;border-radius:8px;font-size:13px;font-weight:800;cursor:${busy ? 'default' : 'pointer'};
                border:1px solid ${isSelected ? 'rgba(212,165,32,0.7)' : 'rgba(255,255,255,0.16)'};
                background:${isSelected ? 'rgba(212,165,32,0.18)' : 'rgba(255,255,255,0.05)'};
                color:${isSelected ? '#fde68a' : 'rgba(255,255,255,0.75)'};
              ">${opt.label}</button>
            `
          }).join('')}
        </div>

        <div style="font-size:12px;font-weight:800;color:rgba(255,255,255,0.7);margin-bottom:8px;">Причина</div>
        <textarea
          data-topic-moderation-reason="1"
          rows="2"
          maxlength="200"
          placeholder="Кратка причина..."
          ${busy ? 'disabled' : ''}
          style="width:100%;box-sizing:border-box;border-radius:8px;border:1px solid rgba(212,165,32,0.24);background:#050505;color:#f8fafc;padding:9px 10px;font-size:13px;font-weight:600;outline:none;resize:none;font-family:inherit;margin-bottom:8px;"
        >${escapeHtml(state.topicModerationActionReason)}</textarea>

        ${state.topicModerationActionErrorText ? `<div style="font-size:12px;color:#f87171;margin-bottom:8px;">${escapeHtml(state.topicModerationActionErrorText)}</div>` : ''}

        <div style="display:flex;gap:12px;margin-top:8px;">
          <button type="button" data-topic-moderation-cancel="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);
            border-radius:10px;color:rgba(255,255,255,0.7);font-size:14px;font-weight:700;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.6' : '1'};
          ">Отказ</button>
          <button type="button" data-topic-moderation-submit="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(212,165,32,0.62);
            background:linear-gradient(180deg, rgba(244,201,91,0.98) 0%, rgba(201,143,19,0.98) 100%);
            border-radius:10px;color:#080808;font-size:14px;font-weight:900;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.7' : '1'};
          ">${busy ? 'Изчакай…' : (isLock ? 'Заключи' : 'Заглуши')}</button>
        </div>
      </div>
    </div>
  `
}

// Двустъпков confirm (защита от accidental single-click deletion, брифа
// т.5) — 'reason' стъпка пази кратка причина, 'confirm' стъпка е финалният
// "сигурен ли си" екран, който реално изпраща DELETE-а.
function renderTopicDeleteConfirmPopup(state: LobbyScreenState): string {
  const pending = state.topicDeleteConfirm
  if (!pending) return ''

  const busy = state.topicDeleteBusy

  if (pending.step === 'reason') {
    return `
      <div style="position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);padding:16px;">
        <div style="background:#1a1a2e;border:1px solid rgba(239,68,68,0.4);border-radius:16px;padding:24px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.6);">
          <div style="font-size:17px;font-weight:900;color:#fff;margin-bottom:4px;">Изтрий темата?</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.55);margin-bottom:16px;">${escapeHtml(pending.topicTitle)}</div>

          <div style="font-size:12px;font-weight:800;color:rgba(255,255,255,0.7);margin-bottom:8px;">Причина</div>
          <textarea
            data-topic-delete-reason="1"
            rows="2"
            maxlength="200"
            placeholder="Кратка причина..."
            ${busy ? 'disabled' : ''}
            style="width:100%;box-sizing:border-box;border-radius:8px;border:1px solid rgba(239,68,68,0.24);background:#050505;color:#f8fafc;padding:9px 10px;font-size:13px;font-weight:600;outline:none;resize:none;font-family:inherit;margin-bottom:8px;"
          >${escapeHtml(state.topicDeleteReason)}</textarea>

          ${state.topicDeleteErrorText ? `<div style="font-size:12px;color:#f87171;margin-bottom:8px;">${escapeHtml(state.topicDeleteErrorText)}</div>` : ''}

          <div style="display:flex;gap:12px;margin-top:8px;">
            <button type="button" data-topic-delete-cancel="1" ${busy ? 'disabled' : ''} style="
              flex:1;padding:11px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);
              border-radius:10px;color:rgba(255,255,255,0.7);font-size:14px;font-weight:700;cursor:pointer;
            ">Отказ</button>
            <button type="button" data-topic-delete-advance="1" ${busy ? 'disabled' : ''} style="
              flex:1;padding:11px;border:1px solid rgba(239,68,68,0.62);background:rgba(239,68,68,0.85);
              border-radius:10px;color:#fff;font-size:14px;font-weight:900;cursor:pointer;
            ">Продължи</button>
          </div>
        </div>
      </div>
    `
  }

  // step === 'confirm' — финален "сигурен ли си" екран, отделна ясна
  // потвърждение стъпка срещу случайно единично кликване.
  return `
    <div style="position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);padding:16px;">
      <div style="background:#1a1a2e;border:1px solid rgba(239,68,68,0.5);border-radius:16px;padding:24px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.6);">
        <div style="font-size:17px;font-weight:900;color:#fff;margin-bottom:8px;">Сигурен ли си?</div>
        <div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.5;margin-bottom:20px;">
          Темата „${escapeHtml(pending.topicTitle)}“ и всички съобщения в нея ще бъдат премахнати. Това действие не може да бъде отменено от потребителите.
        </div>
        <div style="display:flex;gap:12px;">
          <button type="button" data-topic-delete-cancel="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);
            border-radius:10px;color:rgba(255,255,255,0.7);font-size:14px;font-weight:700;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.6' : '1'};
          ">Отказ</button>
          <button type="button" data-topic-delete-confirm="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(239,68,68,0.7);background:rgba(239,68,68,0.9);
            border-radius:10px;color:#fff;font-size:14px;font-weight:900;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.7' : '1'};
          ">${busy ? 'Изчакай…' : 'Изтрий темата'}</button>
        </div>
      </div>
    </div>
  `
}

// Individual root съобщение/reply moderation delete confirm — single-step
// (без reason поле, за разлика от renderTopicDeleteConfirmPopup по-горе,
// individual-message-moderation брифа §19). isRoot определя предупредителния
// текст (root: "и всички отговори" — explicit thread-wide consequence,
// reply: само отговора).
function renderTopicMessageDeleteConfirmPopup(state: LobbyScreenState): string {
  const pending = state.topicMessageDeleteConfirm
  if (!pending) return ''

  const busy = state.topicMessageDeleteBusy
  const title = pending.isRoot ? 'Изтриване на съобщение' : 'Изтриване на отговор'
  // Moderator root delete е thread-wide (established, replies винаги
  // премахнати заедно) — предупреждението остава непроменено. Own-root
  // delete е позволен САМО при 0 live replies (own-delete-own-content брифа
  // §1/§14/§24), значи текстът за него никога не бива да споменава replies —
  // те по дефиниция не съществуват в този сценарий.
  const bodyText = pending.isRoot
    ? (pending.isModeratorAction
      ? 'Съобщението и всички отговори към него ще бъдат премахнати.'
      : 'Съобщението ще бъде премахнато.')
    : 'Отговорът ще бъде премахнат.'

  return `
    <div data-topic-message-delete-confirm-backdrop="1" style="position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);padding:16px;">
      <div style="background:#1a1a2e;border:1px solid rgba(239,68,68,0.5);border-radius:16px;padding:24px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.6);">
        <div style="font-size:17px;font-weight:900;color:#fff;margin-bottom:8px;">${escapeHtml(title)}</div>
        ${state.topicMessageDeleteErrorText ? `<div style="font-size:12px;color:#f87171;margin-bottom:12px;">${escapeHtml(state.topicMessageDeleteErrorText)}</div>` : ''}
        <div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.5;margin-bottom:20px;">
          ${escapeHtml(bodyText)}
        </div>
        <div style="display:flex;gap:12px;">
          <button type="button" data-topic-message-delete-cancel="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);
            border-radius:10px;color:rgba(255,255,255,0.7);font-size:14px;font-weight:700;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.6' : '1'};
          ">Отказ</button>
          <button type="button" data-topic-message-delete-confirm="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(239,68,68,0.7);background:rgba(239,68,68,0.9);
            border-radius:10px;color:#fff;font-size:14px;font-weight:900;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.7' : '1'};
          ">${busy ? 'Изчакай…' : 'Изтрий'}</button>
        </div>
      </div>
    </div>
  `
}

// Report popup — достъпен за обикновен потребител (не-модератор), кратко
// reason поле, без duration избор.
function renderTopicReportPopup(state: LobbyScreenState): string {
  if (!state.topicReportPopupOpen) return ''

  const busy = state.topicReportBusy

  return `
    <div style="position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);padding:16px;">
      <div style="background:#1a1a2e;border:1px solid rgba(212,165,32,0.35);border-radius:16px;padding:24px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.6);">
        <div style="font-size:17px;font-weight:900;color:#fff;margin-bottom:16px;">Докладвай темата</div>

        <div style="font-size:12px;font-weight:800;color:rgba(255,255,255,0.7);margin-bottom:8px;">Причина</div>
        <textarea
          data-topic-report-reason="1"
          rows="3"
          maxlength="300"
          placeholder="Опиши накратко проблема..."
          ${busy ? 'disabled' : ''}
          style="width:100%;box-sizing:border-box;border-radius:8px;border:1px solid rgba(212,165,32,0.24);background:#050505;color:#f8fafc;padding:9px 10px;font-size:13px;font-weight:600;outline:none;resize:none;font-family:inherit;margin-bottom:8px;"
        >${escapeHtml(state.topicReportReason)}</textarea>

        ${state.topicReportErrorText ? `<div style="font-size:12px;color:#f87171;margin-bottom:8px;">${escapeHtml(state.topicReportErrorText)}</div>` : ''}

        <div style="display:flex;gap:12px;margin-top:8px;">
          <button type="button" data-topic-report-cancel="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);
            border-radius:10px;color:rgba(255,255,255,0.7);font-size:14px;font-weight:700;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.6' : '1'};
          ">Отказ</button>
          <button type="button" data-topic-report-submit="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(212,165,32,0.62);
            background:linear-gradient(180deg, rgba(244,201,91,0.98) 0%, rgba(201,143,19,0.98) 100%);
            border-radius:10px;color:#080808;font-size:14px;font-weight:900;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.7' : '1'};
          ">${busy ? 'Изчакай…' : 'Докладвай'}</button>
        </div>
      </div>
    </div>
  `
}

function renderTopicReportSuccessToast(state: LobbyScreenState): string {
  if (!state.topicReportSuccessToast) return ''

  return `
    <div style="position:fixed;inset:0;z-index:9700;display:flex;align-items:flex-end;justify-content:center;padding-bottom:64px;pointer-events:none;">
      <div style="pointer-events:auto;background:#1a1a2e;border:1px solid rgba(212,165,32,0.55);border-radius:12px;padding:14px 22px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,0.7);max-width:calc(100vw - 48px);">
        <div style="font-size:14px;font-weight:800;color:#fde68a;">Докладът беше изпратен. Благодарим ти!</div>
      </div>
    </div>
  `
}

// Компактни icon-only moderation action бутони — Заключи/Отключи/Изтрий
// САМО за whole-topic модератор (isWholeTopicModerator: admin/subadmin/
// top_chat_admin — corrective pass §A1), Докладвай за обикновен
// потребител. Topic-moderator-но-не-whole-topic (pika_team/chat_admin,
// isTopicModerator=true но isWholeTopicModerator=false) вижда НИТО едното —
// те имат mute права (отделен per-message control, виж
// renderTopicAuthorBlock), но не и destructive whole-topic контроли, и не
// са "обикновени потребители" за да им се предложи Report. Не претрупва
// нормалния Topics UI (брифа т.5) — само 44px icon бутони в header реда,
// popup-ите за duration/reason/confirm се отварят при click.
function renderTopicHeaderModerationControls(state: LobbyScreenState, activeTopic: NonNullable<LobbyScreenState['topics']>[number]): string {
  if (activeTopic.isGeneral) return ''

  const isLocked = state.activeTopicLock?.isLocked ?? (activeTopic.status === 'locked')
  const buttons: string[] = []

  if (state.isWholeTopicModerator) {
    if (isLocked) {
      buttons.push(`
        <button type="button" data-topic-unlock="${escapeHtml(activeTopic.topicId)}" title="Отключи темата" aria-label="Отключи темата"
          style="height:36px;width:36px;border:1px solid rgba(212,165,32,0.34);border-radius:8px;background:#050505;color:#4ade80;display:flex;align-items:center;justify-content:center;cursor:pointer;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
        </button>
      `)
    } else {
      buttons.push(`
        <button type="button" data-topic-lock="${escapeHtml(activeTopic.topicId)}" data-topic-lock-title="${escapeHtml(activeTopic.title)}" title="Заключи темата" aria-label="Заключи темата"
          style="height:36px;width:36px;border:1px solid rgba(212,165,32,0.34);border-radius:8px;background:#050505;color:#d4a520;display:flex;align-items:center;justify-content:center;cursor:pointer;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </button>
      `)
    }
    buttons.push(`
      <button type="button" data-topic-delete="${escapeHtml(activeTopic.topicId)}" data-topic-delete-title="${escapeHtml(activeTopic.title)}" title="Изтрий темата" aria-label="Изтрий темата"
        style="height:36px;width:36px;border:1px solid rgba(239,68,68,0.34);border-radius:8px;background:#050505;color:#f87171;display:flex;align-items:center;justify-content:center;cursor:pointer;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      </button>
    `)
  } else if (!state.isTopicModerator) {
    // Report бутонът е за обикновени потребители — topic-moderator-но-не-
    // whole-topic (pika_team/chat_admin) остава без бутон тук изобщо, точно
    // както преди corrective pass-а (isTopicModerator branch-ът винаги ги е
    // изключвал от Report бутона).
    buttons.push(`
      <button type="button" data-topic-report="1" title="Докладвай темата" aria-label="Докладвай темата"
        style="height:36px;width:36px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:#050505;color:rgba(248,250,252,0.62);display:flex;align-items:center;justify-content:center;cursor:pointer;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/></svg>
      </button>
    `)
  }

  return `<div style="margin-left:auto;display:flex;align-items:center;gap:6px;">${buttons.join('')}</div>`
}

// Ясен, но ненатрапчив banner при заключена/muted тема (брифа т.3/т.4:
// "Темата е заключена до 14:30" / "Заглушен сте в тази тема до 14:30").
// server-authoritative timestamp формат-нат локално (Bulgarian час/дата).
function formatModerationExpiry(iso: string): string {
  try {
    return new Date(iso).toLocaleString('bg-BG', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

function renderTopicModerationBanners(state: LobbyScreenState): string {
  const banners: string[] = []

  if (state.activeTopicLock?.isLocked && state.activeTopicLock.lockedUntil) {
    banners.push(`
      <div style="padding:8px 12px;background:rgba(239,68,68,0.12);border-bottom:1px solid rgba(239,68,68,0.28);color:#fca5a5;font-size:12px;font-weight:800;text-align:center;">
        🔒 Темата е заключена до ${escapeHtml(formatModerationExpiry(state.activeTopicLock.lockedUntil))}${state.activeTopicLock.lockedReason ? ` — ${escapeHtml(state.activeTopicLock.lockedReason)}` : ''}
      </div>
    `)
  }

  if (state.activeTopicViewerMute?.isMuted && state.activeTopicViewerMute.mutedUntil) {
    banners.push(`
      <div style="padding:8px 12px;background:rgba(212,165,32,0.12);border-bottom:1px solid rgba(212,165,32,0.28);color:#fde68a;font-size:12px;font-weight:800;text-align:center;">
        🔇 Заглушен сте в тази тема до ${escapeHtml(formatModerationExpiry(state.activeTopicViewerMute.mutedUntil))}
      </div>
    `)
  }

  return banners.join('')
}

function renderTopicsHeader(state: LobbyScreenState): string {
  const activeTopic = (state.topics ?? []).find((t) => t.topicId === state.activeTopicId) ?? null
  const isGeneral = activeTopic?.isGeneral ?? true

  if (isGeneral || activeTopic === null) {
    return `<h1 style="margin:0;font-size:20px;font-weight:900;color:#f8fafc;">Теми</h1>`
  }

  return `
    <div style="display:flex;align-items:center;gap:12px;">
      <button type="button" data-topics-back-to-general="1" style="display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:#d4a520;font-size:14px;font-weight:800;cursor:pointer;padding:0;">
        &larr; Общ чат
      </button>
      <h1 style="margin:0;font-size:18px;font-weight:900;color:#f8fafc;">${escapeHtml(activeTopic.title)}</h1>
      ${renderTopicHeaderModerationControls(state, activeTopic)}
    </div>
  `
}

// Create Topic popup (Custom Topic Creation) — mirror на renderVipRequiredPopup.ts
// структурата (единствена card, position:fixed;inset:0 backdrop, X бутон),
// но с form+input вместо статичен текст. Минимален — само заглавие поле,
// НЕ description/category/privacy (spec т.4). Grешка при неуспешен submit
// остава inline, title draft-а НЕ се чисти (потребителят не губи текста).
function renderTopicCreatePopup(state: LobbyScreenState): string {
  if (!state.topicCreatePopupOpen) return ''

  const draft = state.topicCreateTitleDraft
  const trimmedLength = draft.trim().length
  const canSubmit = trimmedLength > 0 && !state.topicCreateBusy

  return `
    <div data-topic-create-backdrop="1" style="
      position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,0.6);
      display:flex;align-items:center;justify-content:center;padding:16px;
    ">
      <div data-topic-create-card="1" style="
        width:100%;max-width:360px;box-sizing:border-box;
        background:#141414;border:1px solid rgba(212,165,32,0.24);border-radius:16px;
        padding:22px 20px;box-shadow:0 20px 60px rgba(0,0,0,0.5);
      ">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
          <span style="font-size:15px;font-weight:900;color:#f8fafc;">Създай тема</span>
          <button
            type="button"
            data-topic-create-close="1"
            aria-label="Затвори"
            style="border:0;background:transparent;color:rgba(248,250,252,0.6);font-size:20px;line-height:1;cursor:pointer;padding:4px;"
          >&times;</button>
        </div>
        <form data-topic-create-form="1">
          <input
            type="text"
            data-topic-create-title-input="1"
            name="title"
            maxlength="80"
            placeholder="Име на темата"
            autocomplete="off"
            value="${escapeHtml(draft)}"
            ${state.topicCreateBusy ? 'disabled' : ''}
            style="
              width:100%;box-sizing:border-box;padding:12px 14px;margin-bottom:14px;
              border:1px solid rgba(255,255,255,0.14);border-radius:10px;
              background:#0a0a0a;color:#f8fafc;font-size:15px;
            "
          >
          ${state.topicCreateErrorText ? `<p style="margin:0 0 14px;font-size:13px;color:#f87171;">${escapeHtml(state.topicCreateErrorText)}</p>` : ''}
          <div style="display:flex;gap:10px;">
            <button
              type="button"
              data-topic-create-cancel="1"
              ${state.topicCreateBusy ? 'disabled' : ''}
              style="
                flex:1;padding:12px 16px;border:1px solid rgba(255,255,255,0.14);border-radius:10px;
                background:transparent;color:rgba(248,250,252,0.72);font-size:14px;font-weight:700;cursor:pointer;
              "
            >Отказ</button>
            <button
              type="submit"
              data-topic-create-submit="1"
              ${canSubmit ? '' : 'disabled'}
              style="
                flex:1;padding:12px 16px;border:0;border-radius:10px;
                background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
                color:#080808;font-size:14px;font-weight:900;cursor:pointer;
                opacity:${canSubmit ? '1' : '0.5'};
              "
            >${state.topicCreateBusy ? 'Изчакай...' : 'Създай'}</button>
          </div>
        </form>
      </div>
    </div>
  `
}

export function renderTopicsScreen(state: LobbyScreenState): string {
  if (state.topicsLoading && state.topics === null) {
    return `
      <section style="padding:0 4px;">
        <div style="min-height:420px;display:flex;align-items:center;justify-content:center;color:rgba(248,250,252,0.5);font-size:14px;">
          Зареждане на теми...
        </div>
      </section>
    `
  }

  if (state.topicsErrorText) {
    return `
      <section style="padding:0 4px;">
        <div style="min-height:420px;display:flex;align-items:center;justify-content:center;color:#f87171;font-size:14px;text-align:center;">
          ${escapeHtml(state.topicsErrorText)}
        </div>
      </section>
    `
  }

  // data-topics-screen е ЧИСТО flex:1;min-height:0 дете на родителска flex
  // column height chain (виж renderLobbyScreen.ts — mobile data-lobby-screen-root
  // и desktop data-lobby-scale-stage/съдържащ div стават display:flex;
  // flex-direction:column САМО за topics view, без zoom/overflow-y:auto).
  // Никаква JS-measured pixel height тук вече — родителската верига
  // гарантира точната налична височина автоматично, при resize/orientation
  // промяна render() се преизпълнява и flex преизчислява сам.
  //
  // Три flex:0 0 auto/flex:1 секции отгоре надолу:
  //   1) data-topics-fixed-top  — заглавие + topics bar, никога не мърда
  //   2) data-topics-stream-container — flex:1;min-height:0, ЕДИНСТВЕНИЯТ
  //      vertical scroll container (виж renderTopicMessageStream)
  //   3) composer form (Етап 2) — flex:0 0 auto, фиксиран на дъното
  const activeTopicId = state.activeTopicId
  return `
    <section data-topics-screen="1" style="flex:1;min-height:0;display:flex;flex-direction:column;padding:0 4px;overflow:hidden;">
      <div data-topics-fixed-top="1" style="flex:0 0 auto;display:flex;flex-direction:column;gap:12px;padding-bottom:12px;">
        ${renderTopicsHeader(state)}
        ${renderTopicsBar(state)}
      </div>
      <div data-topics-stream-container="1" style="flex:1;min-height:0;border:1px solid rgba(255,255,255,0.10);border-radius:12px 12px 0 0;border-bottom:0;background:#0a0a0a;display:flex;flex-direction:column;overflow:hidden;">
        ${renderTopicModerationBanners(state)}
        ${renderTopicMessageStream(state)}
      </div>
      ${activeTopicId ? renderTopicsComposer(state, activeTopicId) : ''}
    </section>
    ${renderVipRequiredPopup({
      open: state.topicsVipPopupOpen,
      hasClaimedLaunchGift: state.topicsVipGate ? state.topicsVipGate.hasClaimedLaunchGift : null,
      claimSubmitting: state.topicsVipClaimSubmitting,
      claimErrorText: state.topicsVipClaimErrorText,
      seePlansMessageVisible: state.topicsVipSeePlansMessageVisible,
    })}
    ${renderTopicCreatePopup(state)}
    ${renderTopicsInfoToast(state)}
    ${renderTopicModerationActionPopup(state)}
    ${renderTopicDeleteConfirmPopup(state)}
    ${renderTopicMessageDeleteConfirmPopup(state)}
    ${renderTopicReportPopup(state)}
    ${renderTopicReportSuccessToast(state)}
  `
}

// Admin reports queue — компактен popup panel (брифа т.6: "Не създавай
// отделно огромно admin приложение само за Topics reports"), отворен от
// mail dropdown-a (renderLobbyScreen.ts data-lobby-nav-admin-topic-reports),
// НЕ отделен screen/route. Достъпен за всички Topics moderator roles
// (isTopicModerator), не само пълен admin — reuse на established
// fullscreen popup стил (subadminActionConfirm/lock-mute popup-ите).
export function renderAdminTopicReportsPanel(state: LobbyScreenState): string {
  if (!state.adminTopicReportsPopupOpen) return ''

  const filter = state.adminTopicReportsFilter
  const filterOptions: Array<{ value: TopicReportStatus | null; label: string }> = [
    { value: 'pending', label: 'Чакащи' },
    { value: 'reviewed', label: 'Прегледани' },
    { value: 'dismissed', label: 'Отхвърлени' },
    { value: null, label: 'Всички' },
  ]

  const reports = state.adminTopicReports ?? []

  return `
    <div style="position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);padding:16px;">
      <div style="background:#1a1a2e;border:1px solid rgba(212,165,32,0.35);border-radius:16px;padding:20px;max-width:560px;width:100%;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.6);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex:0 0 auto;">
          <div style="font-size:17px;font-weight:900;color:#fff;">Доклади за теми</div>
          <button type="button" data-admin-topic-reports-close="1" aria-label="Затвори" style="border:0;background:transparent;color:rgba(255,255,255,0.6);font-size:20px;line-height:1;cursor:pointer;padding:4px;">&#10005;</button>
        </div>

        <div style="display:flex;gap:6px;margin-bottom:14px;flex:0 0 auto;flex-wrap:wrap;">
          ${filterOptions.map((opt) => {
            const isSelected = filter === opt.value
            return `
              <button type="button" data-admin-topic-reports-filter="${opt.value ?? 'all'}" style="
                padding:7px 12px;border-radius:999px;font-size:12px;font-weight:800;cursor:pointer;
                border:1px solid ${isSelected ? 'rgba(212,165,32,0.7)' : 'rgba(255,255,255,0.16)'};
                background:${isSelected ? 'rgba(212,165,32,0.18)' : 'rgba(255,255,255,0.05)'};
                color:${isSelected ? '#fde68a' : 'rgba(255,255,255,0.75)'};
              ">${opt.label}</button>
            `
          }).join('')}
        </div>

        <div style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;">
          ${state.adminTopicReportsLoading ? `<div style="text-align:center;color:rgba(255,255,255,0.5);font-size:13px;padding:20px 0;">Зареждане...</div>` : ''}
          ${state.adminTopicReportsErrorText ? `<div style="text-align:center;color:#f87171;font-size:13px;padding:20px 0;">${escapeHtml(state.adminTopicReportsErrorText)}</div>` : ''}
          ${!state.adminTopicReportsLoading && !state.adminTopicReportsErrorText && reports.length === 0 ? `<div style="text-align:center;color:rgba(255,255,255,0.42);font-size:13px;padding:20px 0;">Няма доклади.</div>` : ''}
          ${reports.map((report) => {
            const isBusy = state.adminTopicReportActionBusyId === report.reportId
            const statusColor = report.status === 'pending' ? '#fde68a' : report.status === 'reviewed' ? '#4ade80' : 'rgba(255,255,255,0.5)'
            const statusLabel = report.status === 'pending' ? 'Чака' : report.status === 'reviewed' ? 'Прегледан' : 'Отхвърлен'
            return `
              <div style="border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:10px 12px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
                  <span style="font-size:11px;font-weight:900;color:${statusColor};">${statusLabel}</span>
                  <span style="font-size:11px;color:rgba(255,255,255,0.4);">${escapeHtml(formatModerationExpiry(report.createdAt))}</span>
                </div>
                <div style="font-size:13px;color:#f8fafc;line-height:1.4;margin-bottom:8px;word-break:break-word;">${escapeHtml(report.reason)}</div>
                <div style="font-size:11px;color:rgba(255,255,255,0.38);margin-bottom:8px;">Тема: ${escapeHtml(report.topicId)}</div>
                ${report.status === 'pending' ? `
                  <div style="display:flex;gap:8px;">
                    <button type="button" data-admin-topic-report-review="${escapeHtml(report.reportId)}" data-admin-topic-report-review-status="reviewed" ${isBusy ? 'disabled' : ''} style="
                      flex:1;padding:7px;border-radius:8px;font-size:12px;font-weight:800;cursor:${isBusy ? 'default' : 'pointer'};
                      border:1px solid rgba(74,222,128,0.4);background:rgba(74,222,128,0.12);color:#4ade80;
                    ">Прегледан</button>
                    <button type="button" data-admin-topic-report-review="${escapeHtml(report.reportId)}" data-admin-topic-report-review-status="dismissed" ${isBusy ? 'disabled' : ''} style="
                      flex:1;padding:7px;border-radius:8px;font-size:12px;font-weight:800;cursor:${isBusy ? 'default' : 'pointer'};
                      border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.7);
                    ">Отхвърли</button>
                  </div>
                ` : ''}
              </div>
            `
          }).join('')}
        </div>
      </div>
    </div>
  `
}
