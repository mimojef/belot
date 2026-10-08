// Глобален popup "Заглушението изтече" / "Заглушението е премахнато" —
// известия за приключил мют, доставени от сървъра (mute_end_notices).
//
// Монтира се директно в document.body (z-index 200001, огледално на
// showCrossGameCommitmentModal/showLudoInsufficientBalanceModal в main.ts),
// затова се показва над лобито, чакалнята И активната игра, без да пипа
// игровия DOM/state machine. Опашка с dedupe по noticeId: един видим
// прозорец, следващият се показва след OK; повторна доставка (reconnect,
// втора сесия) не дублира popup. OK -> onAcknowledge (сървърът маркира
// известието за целия профил); clear() затваря/маха известия, обработени
// другаде (OK на друго устройство или супресирани от нов мют).

import type { MuteEndNoticeSnapshot } from '../../app/network/createGameServerClient'

const OVERLAY_ID = 'mute-end-notice-modal'

export const MUTE_END_NOTICE_TEXT: Record<MuteEndNoticeSnapshot['kind'], { title: string; body: string }> = {
  expired: {
    title: 'Заглушението изтече',
    body: 'Вашето заглушение изтече. Вече можете да пишете в Лафче, Теми и чатовете на частните маси.',
  },
  unmuted: {
    title: 'Заглушението е премахнато',
    body: 'Вашето заглушение беше премахнато предсрочно. Вече можете да пишете в Лафче, Теми и чатовете на частните маси.',
  },
}

export type MuteEndNoticePopupController = {
  enqueue: (notices: readonly MuteEndNoticeSnapshot[]) => void
  clear: (noticeIds: readonly string[]) => void
  getVisibleNoticeId: () => string | null
  getQueuedNoticeIds: () => string[]
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function createMuteEndNoticePopupController(options: {
  onAcknowledge: (noticeId: string) => void
}): MuteEndNoticePopupController {
  const queue: MuteEndNoticeSnapshot[] = []
  // Потвърдени/изчистени в тази сесия — защита от повторно показване, ако
  // сървърът ги изпрати отново преди ack-ът да е обработен.
  const handledNoticeIds = new Set<string>()
  let visible: MuteEndNoticeSnapshot | null = null
  let overlay: HTMLDivElement | null = null

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' || event.key === 'Enter') acknowledgeVisible()
  }

  function unmount(): void {
    document.removeEventListener('keydown', onKeydown)
    overlay?.remove()
    overlay = null
    visible = null
  }

  function showNext(): void {
    if (visible !== null) return
    const next = queue.shift()
    if (!next) return
    visible = next
    const text = MUTE_END_NOTICE_TEXT[next.kind]

    document.getElementById(OVERLAY_ID)?.remove()
    overlay = document.createElement('div')
    overlay.id = OVERLAY_ID
    overlay.setAttribute('data-mute-end-notice-id', next.noticeId)
    overlay.setAttribute('data-mute-end-notice-kind', next.kind)
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:200001;display:flex;align-items:center;justify-content:center;padding:24px;font-family:Arial,Helvetica,sans-serif;'
    overlay.innerHTML = `
      <div style="position:absolute;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);"></div>
      <div role="dialog" aria-modal="true" aria-label="${escapeHtml(text.title)}" style="position:relative;width:min(92vw,440px);border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.55);padding:24px;">
        <div style="display:grid;gap:16px;text-align:center;">
          <div data-mute-end-notice-title="1" style="font-size:20px;line-height:1.35;font-weight:900;color:#f8fafc;">${escapeHtml(text.title)}</div>
          <div data-mute-end-notice-body="1" style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.72);font-weight:700;">${escapeHtml(text.body)}</div>
          <div style="display:flex;justify-content:center;margin-top:6px;">
            <button type="button" data-mute-end-notice-ok="1" style="height:46px;min-width:130px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;">OK</button>
          </div>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    document.addEventListener('keydown', onKeydown)
    overlay.querySelector('[data-mute-end-notice-ok="1"]')?.addEventListener('click', acknowledgeVisible)
  }

  function acknowledgeVisible(): void {
    if (visible === null) return
    const noticeId = visible.noticeId
    handledNoticeIds.add(noticeId)
    unmount()
    options.onAcknowledge(noticeId)
    showNext()
  }

  function enqueue(notices: readonly MuteEndNoticeSnapshot[]): void {
    for (const notice of notices) {
      if (handledNoticeIds.has(notice.noticeId)) {
        // Вече потвърдено в тази сесия, но сървърът още го смята за pending
        // (ack-ът е изпратен без връзка) — потвърждаваме тихо, без popup.
        options.onAcknowledge(notice.noticeId)
        continue
      }
      if (visible?.noticeId === notice.noticeId) continue
      if (queue.some((queued) => queued.noticeId === notice.noticeId)) continue
      queue.push(notice)
    }
    showNext()
  }

  function clear(noticeIds: readonly string[]): void {
    for (const noticeId of noticeIds) {
      handledNoticeIds.add(noticeId)
      const index = queue.findIndex((queued) => queued.noticeId === noticeId)
      if (index >= 0) queue.splice(index, 1)
    }
    if (visible !== null && noticeIds.includes(visible.noticeId)) {
      unmount()
      showNext()
    }
  }

  return {
    enqueue,
    clear,
    getVisibleNoticeId: () => visible?.noticeId ?? null,
    getQueuedNoticeIds: () => queue.map((notice) => notice.noticeId),
  }
}
