import type { TopicMessageSnapshot, TopicReplySnapshot } from '../network/createGameServerClient'
import type { LobbyScreenState } from './renderLobbyScreen'
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

function renderTopicsBarChip(topic: { topicId: string; title: string; isGeneral: boolean }, isActive: boolean): string {
  const activeStyle = isActive
    ? 'background:rgba(212,165,32,0.16);border-color:#d4a520;color:#d4a520;'
    : 'background:rgba(255,255,255,0.04);border-color:rgba(255,255,255,0.12);color:rgba(248,250,252,0.78);'

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
    >${escapeHtml(topic.title)}</button>
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
        aria-label="Нова тема (ще бъде налично скоро)"
        title="Скоро"
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

function renderTopicAuthorBlock(senderProfileId: string, senderDisplayName: string, senderAvatarUrl: string | null, createdAt: string): string {
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
        <span style="font-size:12px;color:rgba(248,250,252,0.42);">${formatTopicMessageTime(createdAt)}</span>
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
function renderInlineReplyComposer(state: LobbyScreenState, rootMessageId: string): string {
  const draft = state.topicReplyComposerDraftByRootId[rootMessageId] ?? ''
  const isSending = Boolean(state.topicReplyComposerPendingRequestIdByRootId[rootMessageId])
  const errorText = state.topicReplyComposerErrorTextByRootId[rootMessageId] ?? null

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

function renderTopicReplyRow(state: LobbyScreenState, reply: TopicReplySnapshot): string {
  return `
    <div data-topic-reply="${escapeHtml(reply.messageId)}">
      <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 4px 8px ${REPLY_INDENT_PX}px;">
        ${renderTopicAuthorBlock(reply.senderProfileId, reply.senderDisplayName, reply.senderAvatarUrl, reply.createdAt)}
      </div>
      <div style="margin:-6px 0 6px ${REPLY_INDENT_PX}px;">
        <div style="font-size:14px;line-height:1.4;color:#e2e8f0;word-break:break-word;white-space:pre-wrap;">${escapeHtml(reply.body)}</div>
        <div style="margin-top:2px;margin-left:-8px;">
          ${renderTopicLikeButton(state, reply.messageId, reply.likeCount, reply.viewerHasLiked)}
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

function renderTopicMessageRow(state: LobbyScreenState, message: TopicMessageSnapshot): string {
  return `
    <div data-topic-message="${escapeHtml(message.messageId)}">
      <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 4px 0;">
        ${renderTopicAuthorBlock(message.senderProfileId, message.senderDisplayName, message.senderAvatarUrl, message.createdAt)}
      </div>
      <div style="padding:0 4px 10px 46px;">
        <div style="margin-top:2px;font-size:15px;line-height:1.45;color:#e2e8f0;word-break:break-word;white-space:pre-wrap;">${escapeHtml(message.body)}</div>
        <div style="margin-top:4px;margin-left:-8px;display:flex;align-items:center;gap:10px;">
          ${renderTopicLikeButton(state, message.messageId, message.likeCount, message.viewerHasLiked)}
          ${renderTopicReplyButton(message.messageId, message.replyCount)}
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
      .topic-message-action-btn:hover::after,
      .topic-message-action-btn:focus-visible::after {
        opacity: 1;
      }
      /* Само hover устройства виждат tooltip-а изобщо — на touch (mobile)
         :hover може да "залепне" след tap и да остави tooltip видим. */
      @media (hover: none) and (pointer: coarse) {
        .topic-message-action-btn:hover::after { opacity: 0; }
        .topic-message-action-btn:focus-visible::after { opacity: 1; }
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
    ${renderTopicsInfoToast(state)}
  `
}
