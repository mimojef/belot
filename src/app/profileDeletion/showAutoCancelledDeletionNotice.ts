// Самоизтриване, Етап 4K2 — еднократно уведомление след успешен вход, когато
// заявката за изтриване е била отменена автоматично (сървърът е установил
// заето място на маса или участие в игра). Текстът идва от сървъра и се
// изпраща само веднъж (сървърът го маркира като показан при входа) — тук
// няма локално съхранение.

const HOST_ID = 'profile-deletion-auto-cancel-notice'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function showAutoCancelledDeletionNotice(message: string): void {
  document.getElementById(HOST_ID)?.remove()

  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'position:fixed;inset:0;z-index:210000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.82);font-family:Arial,Helvetica,sans-serif;'
  host.innerHTML = `
    <div role="alertdialog" aria-modal="true" aria-labelledby="profile-deletion-auto-cancel-title" style="width:min(100%,440px);box-sizing:border-box;border-radius:8px;border:2px solid rgba(212,165,32,0.55);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
      <div id="profile-deletion-auto-cancel-title" style="font-size:21px;font-weight:900;color:#f8fafc;margin-bottom:14px;">Заявката за изтриване е отменена</div>
      <div data-profile-deletion-auto-cancel-text="1" style="font-size:15px;line-height:1.55;color:rgba(226,232,240,0.88);margin-bottom:16px;">${escapeHtml(message)}</div>
      <button type="button" data-profile-deletion-auto-cancel-ok="1" style="width:100%;min-height:44px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;font-family:inherit;">Разбрах</button>
    </div>
  `
  document.body.appendChild(host)
  const button = host.querySelector<HTMLButtonElement>('[data-profile-deletion-auto-cancel-ok="1"]')
  button?.addEventListener('click', () => host.remove())
  button?.focus()
}
