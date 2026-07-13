import { createChatNotificationQueue, type ChatNotificationEvent, type ChatNotificationMarkReadResult } from './chatNotificationQueue'

type ChatMessageNotif = {
  friendshipId: string
  fromDisplayName: string
}

type NotificationController = {
  /** Подава входящо chat_message_received събитие; helper-ът решава дали да
   * покаже popup сега, да го опаши, или да го пропусне (дубликат/не е първо
   * непрочетено/разговорът вече е notified). */
  handleIncoming: (event: ChatNotificationEvent) => void
  /** Разговорът е реално отворен и прочетен — възстановява правото за ново
   * известие от този подател. Ако точно този подател е бил АКТИВНИЯТ (в
   * момента показан) popup, той се прекратява веднага (без fade delay — не
   * е нужна визуална анимация, потребителят вече не гледа този банер) и
   * следващият валиден от опашката (ако има) се показва незабавно. */
  markRead: (friendshipId: string) => void
  destroy: () => void
}

const AUTO_DISMISS_MS = 6_000

export function createChatMessageNotification(options: {
  container: HTMLElement
  isInGame: () => boolean
  onView: (friendshipId: string) => void
}): NotificationController {
  const queue = createChatNotificationQueue()
  let current: ChatMessageNotif | null = null
  let dismissTimer: ReturnType<typeof setTimeout> | null = null
  // Инкрементира се при всяка UI transition (нов show ИЛИ принудително
  // прекратяване). Всеки pending fadeOutAndClear callback пази поколението,
  // за което е стартиран, и проверява дали то все още е текущото преди да
  // пипа state — предпазва от race, когато markRead() принудително прекрати
  // активния popup и веднага презентира следващия, докато стар fade timeout
  // (от обикновен "Затвори"/auto-hide) все още изчаква своите 420ms.
  let renderGeneration = 0

  function clearDismissTimer(): void {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer)
      dismissTimer = null
    }
  }

  function playSound(): void {
    const audio = new Audio('/audio/ui/player-seat-fill.mp3')
    audio.volume = 0.6
    void audio.play().catch(() => {/* autoplay policy */})
  }

  function fadeOutAndClear(generation: number, afterFade: () => void): void {
    const div = options.container.querySelector<HTMLElement>('div[style*="position:fixed"]')
    if (!div) {
      afterFade()
      return
    }
    div.style.transition = 'opacity 0.4s ease, transform 0.4s ease'
    div.style.opacity = '0'
    div.style.transform = 'translateX(-50%) translateY(-10px)'
    setTimeout(() => {
      // Ако между стартирането на fade-а и сега вече е имало нова
      // transition (напр. markRead принудително прекрати и показа следващия
      // popup), този закъснял callback е остарял — не трябва да пипа
      // нито новия DOM, нито да напредва опашката повторно.
      if (generation !== renderGeneration) return
      afterFade()
    }, 420)
  }

  // Извиква се и от ръчния "Затвори" бутон, и от auto-dismiss таймера —
  // и в двата случая popup-ът просто приключва; следващото от опашката (ако
  // има) идва от queue.handleDismissed(), не рестартира правото за текущия.
  function dismiss(): void {
    clearDismissTimer()
    const generation = renderGeneration
    fadeOutAndClear(generation, () => {
      current = null
      render()
      advanceQueue()
    })
  }

  function advanceQueue(): void {
    const decision = queue.handleDismissed()
    if (decision.action === 'show') {
      presentAndSchedule({ friendshipId: decision.friendshipId, fromDisplayName: decision.fromDisplayName })
    }
  }

  function presentAndSchedule(notif: ChatMessageNotif): void {
    renderGeneration += 1
    current = notif
    clearDismissTimer()
    render()
    playSound()
    dismissTimer = setTimeout(dismiss, AUTO_DISMISS_MS)
  }

  // Принудително прекратява текущия popup БЕЗ fade анимация и БЕЗ да вика
  // playSound за следващия тук — presentAndSchedule (извикан по-долу от
  // markRead при decision==='show') си пуска звука само когато следващият
  // ДЕЙСТВИТЕЛНО се покаже. Нова renderGeneration обезсилва всеки pending
  // fade callback от предишен обикновен dismiss()/auto-hide.
  function forceClearActive(): void {
    renderGeneration += 1
    clearDismissTimer()
    current = null
    render()
  }

  function render(): void {
    if (current === null) {
      options.container.innerHTML = ''
      return
    }

    const notif = current
    const inGame = options.isInGame()

    const viewButtonHtml = inGame
      ? ''
      : `<button id="chat-notif-view-btn" type="button" style="
          padding:7px 14px;border:none;
          background:linear-gradient(135deg,#b8960c,#d4af37,#f0c040);
          border-radius:8px;color:#1a1200;font-size:13px;font-weight:800;cursor:pointer;
          white-space:nowrap;
          transition:filter 0.15s,transform 0.15s;
          box-shadow:0 2px 8px rgba(212,175,55,0.3);
        ">Виж</button>`

    options.container.innerHTML = `
      <style>
        @keyframes chatNotifSlideIn {
          from { opacity:0; transform:translateX(-50%) translateY(-20px); }
          to   { opacity:1; transform:translateX(-50%) translateY(0); }
        }
        #chat-notif-progress {
          animation: chatNotifProgress ${AUTO_DISMISS_MS}ms linear forwards;
        }
        @keyframes chatNotifProgress {
          from { width:100%; }
          to   { width:0%; }
        }
        #chat-notif-view-btn:hover { filter:brightness(1.15); transform:translateY(-1px); }
        #chat-notif-close-btn:hover { filter:brightness(1.3); color:rgba(255,255,255,0.9) !important; }
      </style>
      <div style="
        position:fixed;top:calc(16px + env(safe-area-inset-top, 0px));left:50%;transform:translateX(-50%);
        z-index:99999;
        background:linear-gradient(135deg,rgba(18,14,6,0.98),rgba(10,8,3,0.98));
        border:1px solid rgba(212,175,55,0.45);
        border-radius:16px;
        padding:12px 14px 15px 14px;
        display:flex;align-items:center;gap:12px;
        box-shadow:0 8px 40px rgba(0,0,0,0.85),0 0 24px rgba(212,175,55,0.08);
        min-width:280px;max-width:90vw;
        animation:chatNotifSlideIn 0.3s ease;
        overflow:hidden;
        pointer-events:auto;
      ">
        <div style="font-size:24px;line-height:1;flex-shrink:0;">💬</div>

        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            Имате входящ чат с <span style="color:#d4af37;">${notif.fromDisplayName}</span>
          </div>
        </div>

        <div style="display:flex;flex-direction:row;align-items:center;gap:8px;flex-shrink:0;">
          ${viewButtonHtml}
          <button id="chat-notif-close-btn" type="button" style="
            width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,0.15);
            background:rgba(255,255,255,0.07);color:#fff;
            font-size:15px;font-weight:700;line-height:1;cursor:pointer;
            display:flex;align-items:center;justify-content:center;
            padding:0;flex-shrink:0;
            transition:filter 0.15s;
          ">✕</button>
        </div>

        <div style="
          position:absolute;bottom:0;left:0;height:3px;
          background:linear-gradient(90deg,#b8960c,#d4af37,#f0c040);
          border-radius:0 0 0 16px;
        " id="chat-notif-progress"></div>
      </div>
    `

    options.container.querySelector('#chat-notif-close-btn')?.addEventListener('click', dismiss)

    options.container.querySelector('#chat-notif-view-btn')?.addEventListener('click', () => {
      const friendshipId = notif.friendshipId
      dismiss()
      options.onView(friendshipId)
    })
  }

  function handleIncoming(event: ChatNotificationEvent): void {
    const decision = queue.handleIncoming(event)
    if (decision.action === 'show') {
      presentAndSchedule({ friendshipId: decision.friendshipId, fromDisplayName: decision.fromDisplayName })
    }
    // 'queue' и 'skip' не пипат UI/звук — известието или чака своя ред, или е дубликат/вече notified.
  }

  function markRead(friendshipId: string): void {
    const result: ChatNotificationMarkReadResult = queue.markRead(friendshipId)

    if (!result.wasActive) {
      // Прочетеният е бил само чакащ в опашката (или изобщо не notified) —
      // текущо показаният popup е за ДРУГ подател, не трябва да го пипаме.
      return
    }

    // Точно активният (в момента показан) popup е бил прочетен директно —
    // прекратяваме го веднага, БЕЗ fade анимация (потребителят вече не
    // гледа този банер, той е в самия разговор).
    forceClearActive()

    if (result.next !== null) {
      // Опашката имаше следващ валиден изпращач — показва се веднага.
      presentAndSchedule(result.next)
    }
    // Ако result.next === null, опашката е празна — forceClearActive() вече
    // изчисти банера; няма следващ popup за показване.
  }

  function destroy(): void {
    clearDismissTimer()
    options.container.innerHTML = ''
  }

  return { handleIncoming, markRead, destroy }
}
