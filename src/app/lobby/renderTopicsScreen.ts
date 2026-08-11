import type { TopicMessageSnapshot } from '../network/createGameServerClient'
import type { LobbyScreenState } from './renderLobbyScreen'
import { renderVipRequiredPopup } from '../../ui/overlays/renderVipRequiredPopup'

// Read-only Етап 1 — няма likes, create-topic, moderation, unread badges.
// Етап 2 добави real composer (root send, VIP gate, launch gift) — виж
// CLAUDE.md / project memory за пълния roadmap на следващите етапи.

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
        <div style="margin-top:4px;margin-left:-8px;display:flex;align-items:center;gap:10px;">
          <button
            type="button"
            data-topic-message-like="1"
            class="topic-message-action-btn"
            aria-label="Харесай"
            data-tooltip="Харесай"
          ><span class="topic-message-action-icon" aria-hidden="true">&#9825;</span></button>
          <button
            type="button"
            data-topic-message-reply="1"
            class="topic-message-action-btn"
            aria-label="Отговори"
            data-tooltip="Отговори"
          ><span class="topic-message-action-icon" aria-hidden="true">&#128172;</span></button>
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
        border:0;background:transparent;border-radius:8px;
        padding:9px;
        color:rgba(248,250,252,0.46);
        cursor:pointer;
      }
      .topic-message-action-icon {
        font-size:20px;
        line-height:1;
      }
      .topic-message-action-btn:hover { background:rgba(255,255,255,0.06); color:rgba(248,250,252,0.8); }
      .topic-message-action-btn:active { background:rgba(255,255,255,0.10); }
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
        ${messages.map(renderTopicMessageRow).join('')}
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

  return `
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
      >Изпрати</button>
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
