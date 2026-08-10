import type { TopicMessageSnapshot } from '../network/createGameServerClient'
import type { LobbyScreenState } from './renderLobbyScreen'

// Read-only Етап 1 — няма composer, likes, create-topic, moderation.
// Виж CLAUDE.md / project memory за пълния roadmap на следващите етапи.

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
        data-topics-create-inert="1"
        class="topic-create-chip"
        aria-disabled="true"
        title="Скоро"
        style="
          flex:0 0 auto;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          border-radius:50%;
          border:1px solid rgba(255,255,255,0.14);
          background:rgba(255,255,255,0.03);
          color:rgba(248,250,252,0.38);
          font-size:18px;
          font-weight:900;
          cursor:default;
          margin-right:4px;
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

function renderTopicMessageRow(message: TopicMessageSnapshot): string {
  return `
    <div data-topic-message="${escapeHtml(message.messageId)}" style="display:flex;align-items:flex-start;gap:10px;padding:10px 4px;">
      <button
        type="button"
        data-topic-message-author="${escapeHtml(message.senderProfileId)}"
        data-topic-message-author-name="${escapeHtml(message.senderDisplayName)}"
        style="border:0;background:transparent;padding:0;cursor:pointer;flex:0 0 auto;"
        aria-label="Профил на ${escapeHtml(message.senderDisplayName)}"
      >${renderMessageAvatar(message.senderDisplayName, message.senderAvatarUrl)}</button>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
          <button
            type="button"
            data-topic-message-author="${escapeHtml(message.senderProfileId)}"
            data-topic-message-author-name="${escapeHtml(message.senderDisplayName)}"
            style="border:0;background:transparent;padding:0;cursor:pointer;font-size:14px;font-weight:900;color:#f8fafc;"
          >${escapeHtml(message.senderDisplayName)}</button>
          <span style="font-size:12px;color:rgba(248,250,252,0.42);">${formatTopicMessageTime(message.createdAt)}</span>
        </div>
        <div style="margin-top:2px;font-size:15px;line-height:1.45;color:#e2e8f0;word-break:break-word;white-space:pre-wrap;">${escapeHtml(message.body)}</div>
        <div style="margin-top:6px;display:flex;align-items:center;gap:16px;font-size:12px;color:rgba(248,250,252,0.34);">
          <span data-topic-message-like-slot="1">&#9825;</span>
          <span data-topic-message-reply-slot="1">&#128172;</span>
        </div>
      </div>
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
    <div data-topic-messages-scroll="1" style="flex:1;min-height:0;display:flex;flex-direction:column;overflow-y:auto;overscroll-behavior-y:contain;-webkit-overflow-scrolling:touch;">
      ${loadOlderIndicator}
      <div data-topic-messages-list="1" style="display:flex;flex-direction:column;">
        ${messages.map(renderTopicMessageRow).join('')}
      </div>
    </div>
  `
}

// Визуален shell за бъдещия composer (Етап 2 wiring: send_topic_message,
// VIP gating, launch gift popup) — тук е САМО геометрията/стилът, за да може
// реалната крайна layout геометрия на екрана да се тества сега. Полето е
// disabled (не readonly с fake активност) — коректно отразява, че писането
// още не е функционално, вместо да имитира работещ composer без backend.
// НЕ добавяй event listeners/click handlers към него в Етап 1.
function renderTopicsComposerShell(): string {
  return `
    <div
      data-topics-composer-shell="1"
      style="
        flex:0 0 auto;
        display:flex;
        align-items:center;
        gap:8px;
        padding:10px 12px;
        border:1px solid rgba(255,255,255,0.10);
        border-top:1px solid rgba(255,255,255,0.14);
        border-radius:0 0 12px 12px;
        background:#0a0a0a;
      "
    >
      <input
        type="text"
        disabled
        placeholder="Напиши съобщение..."
        style="
          flex:1;
          min-width:0;
          height:40px;
          border-radius:8px;
          border:1px solid rgba(212,165,32,0.24);
          background:#050505;
          color:rgba(248,250,252,0.42);
          padding:0 12px;
          font-size:14px;
          font-weight:700;
          outline:none;
        "
      >
      <button
        type="button"
        disabled
        style="
          flex:0 0 auto;
          height:40px;
          padding:0 16px;
          border:0;
          border-radius:8px;
          background:rgba(212,165,32,0.18);
          color:rgba(248,250,252,0.38);
          font-size:13px;
          font-weight:900;
          cursor:default;
        "
      >Изпрати</button>
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
  //   3) data-topics-composer-shell — визуален shell за бъдещия composer
  //      (Етап 2), flex:0 0 auto, фиксиран на дъното, БЕЗ send логика тук.
  return `
    <section data-topics-screen="1" style="flex:1;min-height:0;display:flex;flex-direction:column;padding:0 4px;overflow:hidden;">
      <div data-topics-fixed-top="1" style="flex:0 0 auto;display:flex;flex-direction:column;gap:12px;padding-bottom:12px;">
        ${renderTopicsHeader(state)}
        ${renderTopicsBar(state)}
      </div>
      <div data-topics-stream-container="1" style="flex:1;min-height:0;border:1px solid rgba(255,255,255,0.10);border-radius:12px 12px 0 0;border-bottom:0;background:#0a0a0a;display:flex;flex-direction:column;overflow:hidden;">
        ${renderTopicMessageStream(state)}
      </div>
      ${renderTopicsComposerShell()}
    </section>
  `
}
