import {
  renderProfileAccessBlockPopup,
  attachProfileAccessBlockPopupListeners,
} from '../src/ui/overlays/renderProfileAccessBlockPopup.ts'

// Mirrors the production caller state machine (blockFromAccessDenialPopup in
// createLobbyFlowController.ts / blockFromProfileAccessBlockPopup in
// createActiveRoomFlowController.ts) against the REAL shared render module,
// in a real DOM, with real setTimeout — proving the actual rendered HTML
// and actual browser timing, not just the source shape.
function createHarness(profileId, onBlockNetworkCall) {
  const host = document.createElement('div')
  document.body.appendChild(host)

  let popup = { profileId, code: 'profile_blocked_viewer' }
  let successTimeoutId = null

  function renderNow() {
    host.innerHTML = renderProfileAccessBlockPopup(popup)
    attachProfileAccessBlockPopupListeners(host, {
      onClose: () => {
        if (successTimeoutId !== null) {
          clearTimeout(successTimeoutId)
          successTimeoutId = null
        }
        popup = null
        renderNow()
      },
      onUnblock: () => {},
      onBlock: (clickedProfileId) => {
        void blockAction(clickedProfileId)
      },
    })
  }

  async function blockAction(clickedProfileId) {
    if (popup?.profileId !== clickedProfileId) return
    popup = { ...popup, blockSubmitting: true, blockErrorText: null }
    renderNow()

    const result = await onBlockNetworkCall(clickedProfileId)
    if (popup?.profileId !== clickedProfileId) return

    if ('ok' in result && !result.ok) {
      popup = { ...popup, blockSubmitting: false, blockErrorText: result.message }
      renderNow()
      return
    }

    if (successTimeoutId !== null) {
      clearTimeout(successTimeoutId)
      successTimeoutId = null
    }
    popup = { profileId, code: popup.code, blockSuccess: true }
    renderNow()

    successTimeoutId = setTimeout(() => {
      successTimeoutId = null
      if (popup?.profileId === profileId && popup.blockSuccess) {
        popup = null
        renderNow()
      }
    }, 900)
  }

  renderNow()
  return { host, getPopupState: () => popup }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const result = {}

  // ─── Success path ───────────────────────────────────────────────────────
  {
    const profileId = 'profile-B'
    let networkCalls = 0
    const harness = createHarness(profileId, async () => {
      networkCalls += 1
      return { blocked: true }
    })

    // There are TWO elements with data-profile-access-block-close="1" in the
    // normal (non-success) state: the fullscreen backdrop (click-outside-to-
    // dismiss, always present regardless of body content) and the visible
    // "Затвори" footer button (part of the action row, hidden on success).
    // We assert on the FOOTER button specifically via the dialog's action
    // row count, not the raw selector (which the backdrop also matches).
    function countCloseButtonsInsideDialog() {
      const dialog = harness.host.querySelector('[role="dialog"]')
      return dialog.querySelectorAll('[data-profile-access-block-close="1"]').length
    }

    result.initialShowsCloseAndBlock =
      countCloseButtonsInsideDialog() === 1 &&
      harness.host.querySelector(`[data-profile-access-block-block="${profileId}"]`) !== null
    result.initialShowsUnblock = harness.host.querySelector('[data-profile-access-block-unblock]') !== null

    const blockBtn = harness.host.querySelector(`[data-profile-access-block-block="${profileId}"]`)
    blockBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    // Popup must NOT close instantly — action-row buttons (Затвори footer
    // button + Блокирай) hidden, success text shown, backdrop-dismiss still
    // works (click-outside always closes, by design) while the (mock)
    // network call is in flight/just resolved.
    await sleep(30)
    result.successTextShownImmediately =
      harness.host.textContent.includes('Потребителят е блокиран.')
    result.buttonsHiddenOnSuccess =
      harness.host.querySelector(`[data-profile-access-block-block="${profileId}"]`) === null &&
      countCloseButtonsInsideDialog() === 0
    result.popupStillMountedRightAfterSuccess = harness.getPopupState() !== null
    result.networkCalledExactlyOnce = networkCalls === 1

    // Still open well before the 900ms mark.
    await sleep(500)
    result.popupStillOpenBefore900ms = harness.getPopupState() !== null

    // Auto-closed shortly after 900ms.
    await sleep(550)
    result.popupClosedAfter900ms = harness.getPopupState() === null
    result.domClearedAfterAutoClose = harness.host.innerHTML === ''
  }

  // ─── Failure path ───────────────────────────────────────────────────────
  {
    const profileId = 'profile-C'
    let networkCalls = 0
    const harness = createHarness(profileId, async () => {
      networkCalls += 1
      return { ok: false, message: 'Операцията не успя.' }
    })

    const blockBtn = harness.host.querySelector(`[data-profile-access-block-block="${profileId}"]`)
    blockBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(30)

    result.failureShowsNoSuccessText = !harness.host.textContent.includes('Потребителят е блокиран.')
    result.failureShowsErrorText = harness.host.textContent.includes('Операцията не успя.')
    result.failurePopupStillOpen = harness.getPopupState() !== null
    result.failureBlockButtonRetryable =
      harness.host.querySelector(`[data-profile-access-block-block="${profileId}"]`) !== null &&
      !harness.host.querySelector(`[data-profile-access-block-block="${profileId}"]`).disabled
    result.failureCloseButtonStillPresent =
      harness.host.querySelector('[data-profile-access-block-close="1"]') !== null

    // Well past 900ms — failure path must never auto-close.
    await sleep(1000)
    result.failurePopupStillOpenAfter900ms = harness.getPopupState() !== null
    result.failureNetworkCalledExactlyOnce = networkCalls === 1
  }

  // ─── Retry after failure succeeds (no fake success on the failed call) ──
  {
    const profileId = 'profile-D'
    let networkCalls = 0
    const harness = createHarness(profileId, async () => {
      networkCalls += 1
      return networkCalls === 1 ? { ok: false, message: 'Мрежова грешка.' } : { blocked: true }
    })

    harness.host.querySelector(`[data-profile-access-block-block="${profileId}"]`)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(30)
    result.retryFirstAttemptShowsError = harness.host.textContent.includes('Мрежова грешка.')
    result.retryFirstAttemptNoFakeSuccess = !harness.host.textContent.includes('Потребителят е блокиран.')

    harness.host.querySelector(`[data-profile-access-block-block="${profileId}"]`)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(30)
    result.retrySecondAttemptShowsSuccess = harness.host.textContent.includes('Потребителят е блокиран.')
    result.retryTotalNetworkCalls = networkCalls

    await sleep(1000)
    result.retryPopupClosedAfterSuccess = harness.getPopupState() === null
  }

  window.__profileAccessBlockPopupResult = result
}

main()
