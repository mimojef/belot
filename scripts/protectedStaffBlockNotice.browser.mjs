import {
  PROTECTED_STAFF_PROFILE_BLOCK_MESSAGE,
  PROTECTED_STAFF_PROFILE_ERROR_CODE,
  showProtectedStaffBlockNotice,
  closeProtectedStaffBlockNotice,
} from '../src/app/social/protectedStaffBlockNotice.ts'
import {
  showSeatProfileOverlay,
  updateSeatProfileOverlay,
  removeSeatProfileOverlay,
} from '../src/app/activeRoom/renderSeatProfileOverlay.ts'
import {
  renderProfileAccessBlockPopup,
  attachProfileAccessBlockPopupListeners,
} from '../src/ui/overlays/renderProfileAccessBlockPopup.ts'

const EXPECTED_TEXT = 'Не можете да блокирате профил от екипа на Pika.bg.'
const NOTICE = '[data-protected-staff-block-notice="1"]'
const NOTICE_OK = '[data-protected-staff-block-notice-ok="1"]'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function click(element) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function noticeIsTopmostAtOk() {
  const ok = document.querySelector(NOTICE_OK)
  if (!ok) return false
  const rect = ok.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return hit === ok || ok.contains(hit)
}

// Огледало на main.ts submitProfileBlock при server отговор
// 403 { code: 'PROTECTED_STAFF_PROFILE', message }.
function simulateProtectedServerResponse() {
  const data = { ok: false, code: PROTECTED_STAFF_PROFILE_ERROR_CODE, message: EXPECTED_TEXT }
  if (data.code === PROTECTED_STAFF_PROFILE_ERROR_CODE) {
    showProtectedStaffBlockNotice(data.message ?? PROTECTED_STAFF_PROFILE_BLOCK_MESSAGE)
    return { ok: false, message: data.message, protectedStaffProfile: true }
  }
  return { blocked: true }
}

function makeProfile(profileId) {
  return {
    profileId,
    displayName: 'Pika Staff',
    avatarUrl: null,
    level: 1,
    rankTitle: 'Rank 1',
    skillRating: 1000,
    completedGamesCount: 0,
    wonGamesCount: 0,
    currentRankGames: 0,
    nextRankGames: 10,
    gamesUntilNextRank: 10,
    rankProgressRatio: 0,
    averageRating: null,
    totalRatingsCount: 0,
    yellowCoinsBalance: null,
    galleryImages: [],
    gender: 'male',
    isOnline: true,
    isBot: false,
    likesCount: 0,
    hasLikedByMe: false,
    isBlockedByMe: false,
    isVip: false,
    vipActiveUntil: null,
  }
}

async function main() {
  const result = {}

  // ─── Notice module ──────────────────────────────────────────────────────
  {
    result.constants =
      PROTECTED_STAFF_PROFILE_ERROR_CODE === 'PROTECTED_STAFF_PROFILE' &&
      PROTECTED_STAFF_PROFILE_BLOCK_MESSAGE === EXPECTED_TEXT
    showProtectedStaffBlockNotice()
    showProtectedStaffBlockNotice()
    const notices = document.querySelectorAll(NOTICE)
    const notice = notices[0]
    result.noticeSingleInstance = notices.length === 1
    result.noticeInBody = notice?.parentElement === document.body
    result.noticeText = notice?.querySelector('[data-protected-staff-block-notice-text="1"]')?.textContent ?? null
    result.noticeOkLabel = notice?.querySelector(NOTICE_OK)?.textContent?.trim() ?? null
    result.noticeButtonCount = notice?.querySelectorAll('button').length ?? 0
    result.noticeZIndex = Number(getComputedStyle(notice).zIndex)
    result.noticeNoModeratorWord = !notice?.textContent.includes('модератор')
    click(notice.querySelector(NOTICE_OK))
    result.noticeOkCloses = document.querySelector(NOTICE) === null
    showProtectedStaffBlockNotice()
    click(document.querySelector('[data-protected-staff-block-notice-backdrop="1"]'))
    result.noticeBackdropCloses = document.querySelector(NOTICE) === null
    showProtectedStaffBlockNotice('<b>x</b>')
    result.noticeEscapesHtml = document.querySelector(NOTICE)?.querySelector('b') === null
    closeProtectedStaffBlockNotice()
  }

  // ─── In-game seat profile overlay ("Блокирай" в профила на играч) ──────
  {
    const profileId = 'pika-staff-profile'
    const seat = { seat: 'top' }
    let calls = 0
    showSeatProfileOverlay(seat, () => removeSeatProfileOverlay(), false, () => null, null, null, async () => {
      calls += 1
      // Огледало на main.ts onBlockProfile wiring-а за защитен профил.
      const r = simulateProtectedServerResponse()
      return { message: r.protectedStaffProfile ? null : r.message }
    })
    updateSeatProfileOverlay(seat, makeProfile(profileId))
    const overlayHost = document.getElementById('active-room-profile-overlay-host')
    const blockButton = overlayHost?.querySelector(`[data-player-profile-block="${profileId}"]`)
    result.inGameBlockButtonVisible = !!blockButton && !blockButton.disabled
    click(blockButton)
    await sleep(50)
    result.inGameCalls = calls
    result.inGameNoticeShown = document.querySelector(NOTICE) !== null
    result.inGameNoticeOnTop = noticeIsTopmostAtOk()
    result.inGameNoticeAboveOverlay =
      Number(getComputedStyle(document.querySelector(NOTICE)).zIndex) > Number(getComputedStyle(overlayHost).zIndex)
    const hostAfter = document.getElementById('active-room-profile-overlay-host')
    result.inGameOverlayStillOpen = hostAfter !== null
    result.inGameNoInlineText = !hostAfter?.textContent.includes(EXPECTED_TEXT)
    const blockAfter = hostAfter?.querySelector(`[data-player-profile-block="${profileId}"]`)
    result.inGameBlockButtonReusable = !!blockAfter && !blockAfter.disabled
    click(document.querySelector(NOTICE_OK))
    result.inGameOkCloses = document.querySelector(NOTICE) === null && document.getElementById('active-room-profile-overlay-host') !== null
    removeSeatProfileOverlay()
  }

  // ─── Access-denial popup (shared lobby + in-game render module) ────────
  // Огледало на blockFromAccessDenialPopup (lobby) /
  // blockFromProfileAccessBlockPopup (activeRoom) с protected клона.
  {
    const profileId = 'pika-staff-denial'
    const host = document.createElement('div')
    document.body.appendChild(host)
    let popup = { profileId, code: 'profile_blocked_viewer' }
    let calls = 0
    const renderNow = () => {
      host.innerHTML = renderProfileAccessBlockPopup(popup)
      attachProfileAccessBlockPopupListeners(host, {
        onClose: () => { popup = null; renderNow() },
        onUnblock: () => {},
        onBlock: (id) => { void blockAction(id) },
      })
    }
    async function blockAction(id) {
      if (popup?.profileId !== id) return
      popup = { ...popup, blockSubmitting: true, blockErrorText: null }
      renderNow()
      calls += 1
      const r = simulateProtectedServerResponse()
      if (popup?.profileId !== id) return
      if ('ok' in r && !r.ok) {
        popup = { ...popup, blockSubmitting: false, blockErrorText: r.protectedStaffProfile ? null : r.message }
        renderNow()
      }
    }
    renderNow()
    click(host.querySelector(`[data-profile-access-block-block="${profileId}"]`))
    await sleep(50)
    result.denialCalls = calls
    result.denialNoticeShown = document.querySelector(NOTICE) !== null
    result.denialNoticeOnTop = noticeIsTopmostAtOk()
    result.denialPopupStillOpen = host.querySelector('[data-profile-access-block-popup-root]') !== null
    result.denialNoInlineText = !host.textContent.includes(EXPECTED_TEXT)
    const retry = host.querySelector(`[data-profile-access-block-block="${profileId}"]`)
    result.denialLoadingReleased = !!retry && !retry.disabled
    click(document.querySelector(NOTICE_OK))
    result.denialOkCloses = document.querySelector(NOTICE) === null
  }

  window.__protectedStaffBlockNoticeResult = result
}

main().catch((error) => {
  window.__protectedStaffBlockNoticeResult = { fatal: String(error && error.stack || error) }
})
