// Generic in-game gift picker modal — извлечена от Belot table gift-а
// (createActiveRoomFlowController.ts::tableGiftModal state machine +
// renderTableGiftModalInnerHtml/syncTableGiftModal/showTableGiftToast,
// Stage 2) в generic, presentation-only factory. Belot-овата версия НЕ е
// migrate-ната към тоя shared module (виж task-а "Ludo подаръци" §12
// финалния отчет за rationale — нула automated frontend test покрива
// Belot-овия picker/animation, само resolveTableGiftParticipants е unit-
// tested; refactor-ване на untested production код носи неоткриваем
// regression риск). Ludo (createLudoFlowController.ts) е първият/единствен
// consumer засега — написана generic-но (recipientKey/recipientProfileId/
// recipientName + callbacks), за да може бъдещ dedicated Belot refactor да
// я приеме без duplication.
//
// Визуално/behavioral 1:1 с Belot: същия catalog grid, същия balance текст,
// same insufficient-funds disable/opacity, same close behavior (backdrop/×),
// same success toast, same error UX.

export type GiftPickerCatalogItem = {
  giftItemId: string
  name: string
  imageUrl: string
  price: number
}

export type GiftPickerCatalogLoadResult =
  | { ok: true; items: GiftPickerCatalogItem[] }
  | { ok: false; message: string }

export type GiftPickerSendResult = {
  ok: boolean
  message?: string
  chargedPrice?: number
  senderBalanceAfter?: number
}

export interface GiftPickerModalConfig {
  /** Уникален data-атрибут за modal host div-а, напр. 'data-ludo-gift-modal-host'. */
  hostAttribute: string
  /** Уникален data-атрибут за toast div-а, напр. 'data-ludo-gift-toast'. */
  toastAttribute: string
  /** z-index на самия modal host (над game screen-а, под евентуален по-горен layer). */
  zIndex: number
  onCatalogLoad: () => Promise<GiftPickerCatalogLoadResult>
  /** Текущият баланс на локалния играч (null = неизвестен, показва "—"). */
  getBalance: () => number | null
  isConnected: () => boolean
  /** requestId е generated тук (crypto.randomUUID()) — idempotency key. */
  onSubmit: (recipientKey: string, recipientProfileId: string, giftItemId: string, requestId: string) => void
  /** Извиква се точно преди success close+toast — caller-ят пише новия баланс в собствения си state. */
  onBalanceUpdate?: (newBalance: number) => void
  /** Optional: извиква се след всяко затваряне на отворен picker (×, backdrop, success). */
  onClose?: () => void
}

type GiftPickerModalState = {
  recipientKey: string
  recipientProfileId: string
  recipientName: string
  items: GiftPickerCatalogItem[]
  isLoading: boolean
  errorText: string | null
  submittingGiftItemId: string | null
  pendingRequestId: string | null
}

export interface GiftPickerModal {
  open(recipientKey: string, recipientProfileId: string, recipientName: string): void
  close(): void
  /** Извиква се при получаване на send-result съобщението от сървъра. */
  handleSendResult(requestId: string, result: GiftPickerSendResult): void
  /** true ако модалът в момента е отворен за точно тоя recipientKey. */
  isOpenFor(recipientKey: string): boolean
  /** Съществуващия non-blocking toast — напр. неуспешна проверка преди open(). */
  showToast(text: string): void
  /** Премахва DOM nodes + timers — извиква се при controller destroy/reconnect invalidate. */
  destroy(): void
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function createGiftPickerModal(config: GiftPickerModalConfig): GiftPickerModal {
  let modal: GiftPickerModalState | null = null
  let catalogRequestToken = 0
  let toastTimerId: number | null = null

  function syncModal(): void {
    const existing = document.body.querySelector<HTMLElement>(`[${config.hostAttribute}="1"]`)

    if (modal === null) {
      existing?.remove()
      return
    }

    if (existing) {
      existing.innerHTML = renderInnerHtml()
      return
    }

    const host = document.createElement('div')
    host.setAttribute(config.hostAttribute, '1')
    host.style.cssText = `position:fixed;inset:0;z-index:${config.zIndex};`
    host.innerHTML = renderInnerHtml()
    // Делегиран listener, закачен само веднъж при създаване — четем текущия
    // target при всеки click (никакъв closure към конкретен item).
    host.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return

      if (
        target.closest('[data-gift-picker-close="1"]') ||
        target.matches('[data-gift-picker-backdrop="1"]')
      ) {
        close()
        return
      }

      const pick = target.closest<HTMLElement>('[data-gift-picker-pick]')
      if (pick) {
        const giftItemId = pick.getAttribute('data-gift-picker-pick')
        if (giftItemId) submit(giftItemId)
      }
    })
    document.body.appendChild(host)
  }

  function renderInnerHtml(): string {
    if (modal === null) return ''

    const balance = config.getBalance()
    const balanceText = balance === null ? '—' : String(balance)

    const bodyHtml = modal.isLoading
      ? `<div style="padding:24px;text-align:center;color:#cbd5f5;font-size:14px;font-weight:700;">Зареждане…</div>`
      : modal.items.length === 0
        ? `<div style="padding:24px;text-align:center;color:#cbd5f5;font-size:14px;font-weight:700;">Няма налични подаръци.</div>`
        : `<div style="
              display:grid;
              grid-template-columns:repeat(auto-fill, minmax(104px, 1fr));
              gap:10px;
              padding:14px;
              max-height:min(52vh, 380px);
              overflow-y:auto;
            ">
            ${modal.items
              .map((item) => {
                const isSubmitting = modal!.submittingGiftItemId === item.giftItemId
                const isAnySubmitting = modal!.submittingGiftItemId !== null
                // Недостатъчен баланс — визуално disabled; сървърът пак
                // валидира авторитетно (client-side е само UX).
                const cannotAfford = balance !== null && balance < item.price
                const isDisabled = cannotAfford || isAnySubmitting
                return `
                  <div
                    ${isDisabled ? '' : `data-gift-picker-pick="${escapeHtml(item.giftItemId)}"`}
                    style="
                      border-radius:14px;
                      border:1px solid ${isSubmitting ? 'rgba(245,187,55,0.95)' : 'rgba(148,163,184,0.35)'};
                      background:rgba(15,23,42,0.85);
                      padding:8px;
                      text-align:center;
                      cursor:${isDisabled ? 'not-allowed' : 'pointer'};
                      opacity:${cannotAfford ? '0.42' : '1'};
                    "
                  >
                    <img
                      src="${escapeHtml(item.imageUrl)}"
                      alt="${escapeHtml(item.name)}"
                      style="width:100%;height:72px;object-fit:contain;display:block;"
                    />
                    <div style="margin-top:6px;font-size:12px;font-weight:800;color:#e2e8f0;overflow-wrap:anywhere;">${escapeHtml(item.name)}</div>
                    <div style="margin-top:2px;font-size:12px;font-weight:900;color:#fde68a;">${item.price} ж.</div>
                  </div>
                `
              })
              .join('')}
          </div>`

    const errorHtml = modal.errorText
      ? `<div style="padding:0 14px 12px;color:#fca5a5;font-size:13px;font-weight:800;">${escapeHtml(modal.errorText)}</div>`
      : ''

    return `
      <div
        data-gift-picker-backdrop="1"
        style="
          position:fixed;
          inset:0;
          background:rgba(3,7,18,0.72);
          display:flex;
          align-items:center;
          justify-content:center;
          padding:16px;
        "
      >
        <div style="
          width:min(94vw, 460px);
          border-radius:20px;
          border:1px solid rgba(245,187,55,0.6);
          background:linear-gradient(180deg, rgba(30,30,30,0.99) 0%, rgba(10,10,10,0.99) 100%);
          box-shadow:0 24px 60px rgba(0,0,0,0.6);
          overflow:hidden;
        ">
          <div style="
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:10px;
            padding:14px;
            border-bottom:1px solid rgba(148,163,184,0.22);
          ">
            <div style="font-size:15px;font-weight:900;color:#f8fafc;overflow-wrap:anywhere;">
              Подарък за ${escapeHtml(modal.recipientName)}
            </div>
            <div
              data-gift-picker-close="1"
              style="
                cursor:pointer;
                color:#cbd5f5;
                font-size:20px;
                font-weight:900;
                line-height:1;
                padding:2px 6px;
              "
            >×</div>
          </div>
          <div style="padding:10px 14px 0;font-size:13px;font-weight:800;color:#fde68a;">
            Твой баланс: ${escapeHtml(balanceText)} жълтици
          </div>
          ${bodyHtml}
          ${errorHtml}
        </div>
      </div>
    `
  }

  function open(recipientKey: string, recipientProfileId: string, recipientName: string): void {
    modal = {
      recipientKey,
      recipientProfileId,
      recipientName,
      items: [],
      isLoading: true,
      errorText: null,
      submittingGiftItemId: null,
      pendingRequestId: null,
    }
    syncModal()

    const requestToken = ++catalogRequestToken

    void (async () => {
      const result = await config.onCatalogLoad()
      // Stale response — модалът е затворен/презареден междувременно.
      if (requestToken !== catalogRequestToken || modal === null) return
      modal.isLoading = false
      if (result.ok) {
        modal.items = result.items
      } else {
        modal.errorText = result.message
      }
      syncModal()
    })()
  }

  function close(): void {
    const wasOpen = modal !== null
    catalogRequestToken += 1
    modal = null
    syncModal()
    if (wasOpen) config.onClose?.()
  }

  function submit(giftItemId: string): void {
    if (modal === null) return
    // Guard срещу repeat click.
    if (modal.submittingGiftItemId !== null) return

    if (!config.isConnected()) {
      modal.errorText = 'Няма връзка със сървъра.'
      syncModal()
      return
    }

    const requestId = crypto.randomUUID()
    modal.submittingGiftItemId = giftItemId
    modal.pendingRequestId = requestId
    modal.errorText = null
    syncModal()

    config.onSubmit(modal.recipientKey, modal.recipientProfileId, giftItemId, requestId)
  }

  function handleSendResult(requestId: string, result: GiftPickerSendResult): void {
    if (modal === null || modal.pendingRequestId !== requestId) return

    if (!result.ok) {
      modal.submittingGiftItemId = null
      modal.pendingRequestId = null
      modal.errorText = result.message ?? 'Подаръкът не беше изпратен.'
      syncModal()
      return
    }

    if (typeof result.senderBalanceAfter === 'number') {
      config.onBalanceUpdate?.(result.senderBalanceAfter)
    }

    // Селекторът се затваря САМО след success отговор от сървъра.
    close()
    showToast(
      typeof result.chargedPrice === 'number'
        ? `Подаръкът е изпратен. -${result.chargedPrice} жълтици`
        : 'Подаръкът е изпратен.',
    )
  }

  // Non-blocking toast — НЕ спира игрови таймери и не блокира input.
  function showToast(text: string): void {
    document.body.querySelector(`[${config.toastAttribute}="1"]`)?.remove()
    if (toastTimerId !== null) {
      window.clearTimeout(toastTimerId)
      toastTimerId = null
    }

    const toast = document.createElement('div')
    toast.setAttribute(config.toastAttribute, '1')
    toast.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:max(96px, env(safe-area-inset-bottom))',
      'transform:translateX(-50%)',
      `z-index:${config.zIndex + 5}`,
      'padding:10px 18px',
      'border-radius:999px',
      'background:linear-gradient(180deg, rgba(34,34,34,0.97) 0%, rgba(12,12,12,0.98) 100%)',
      'border:1px solid rgba(245,187,55,0.75)',
      'color:#fde68a',
      'font-size:14px',
      'font-weight:800',
      'box-shadow:0 12px 26px rgba(0,0,0,0.45)',
      'pointer-events:none',
    ].join(';')
    toast.textContent = text
    document.body.appendChild(toast)

    toastTimerId = window.setTimeout(() => {
      toastTimerId = null
      toast.remove()
    }, 3200)
  }

  function isOpenFor(recipientKey: string): boolean {
    return modal !== null && modal.recipientKey === recipientKey
  }

  function destroy(): void {
    catalogRequestToken += 1
    modal = null
    document.body.querySelector(`[${config.hostAttribute}="1"]`)?.remove()
    document.body.querySelector(`[${config.toastAttribute}="1"]`)?.remove()
    if (toastTimerId !== null) {
      window.clearTimeout(toastTimerId)
      toastTimerId = null
    }
  }

  return { open, close, handleSendResult, isOpenFor, showToast, destroy }
}
