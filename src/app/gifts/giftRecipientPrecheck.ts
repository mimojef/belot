// Client-side проверка за блокиране ПРЕДИ отваряне на gift picker-а (Белот
// играч/зрител, Ludo, профилен popup, "Подари и ти"). Reuse-ва съществуващия
// GET /api/profiles/:id (onProfileByIdLoad), който връща 403 + code при
// блокиране в която и да е посока (getProfileAccessDenial на сървъра).
// Само UX — authoritative отказът е в giftItemStore.sendGiftItem.

import type { ProfileAccessBlockCode } from '../../ui/overlays/renderProfileAccessBlockPopup'

export type GiftRecipientProfileLoader = (profileId: string) => Promise<
  | { ok: true; profile: { profileId: string | null } }
  | { ok: false; message: string; code?: ProfileAccessBlockCode }
>

export type GiftRecipientPrecheckResult =
  | { status: 'ok' }
  | { status: 'blocked'; code: ProfileAccessBlockCode }
  | { status: 'error'; message: string }

const PRECHECK_FAILED_MESSAGE = 'Проверката на получателя не успя. Опитайте отново.'

export function isProfileAccessBlockCode(code: unknown): code is ProfileAccessBlockCode {
  return code === 'profile_blocked_by_viewer' || code === 'profile_blocked_viewer'
}

// Picker-ът се отваря САМО при 'ok'. Мрежова/друга грешка → 'error' (без
// picker и без block popup — блокиране не е потвърдено).
export async function precheckGiftRecipient(
  loadProfile: GiftRecipientProfileLoader | undefined,
  profileId: string,
): Promise<GiftRecipientPrecheckResult> {
  if (!loadProfile) return { status: 'error', message: 'Подаряването временно не е налично.' }
  try {
    const result = await loadProfile(profileId)
    if (result.ok) {
      return result.profile.profileId === profileId
        ? { status: 'ok' }
        : { status: 'error', message: PRECHECK_FAILED_MESSAGE }
    }
    if (isProfileAccessBlockCode(result.code)) return { status: 'blocked', code: result.code }
    return { status: 'error', message: result.message || PRECHECK_FAILED_MESSAGE }
  } catch {
    return { status: 'error', message: 'Няма връзка със сървъра.' }
  }
}

// Дискретен loading индикатор върху бутона за подарък, докато проверката
// лети. Self-mounted <style> (по owner ключ), а не inline style на бутона —
// оцелява при re-render на панелите/popup-а. Само opacity + cursor: иконите
// ползват transform за позициониране.
const STYLE_ID = 'gift-recipient-precheck-pending-style'
const pendingSelectorsByOwner = new Map<string, string>()

export function setGiftPrecheckPending(owner: string, selector: string | null): void {
  if (selector === null) pendingSelectorsByOwner.delete(owner)
  else pendingSelectorsByOwner.set(owner, selector)

  let style = document.getElementById(STYLE_ID)
  if (pendingSelectorsByOwner.size === 0) {
    style?.remove()
    return
  }
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  const selectors = Array.from(pendingSelectorsByOwner.values()).join(',\n')
  style.textContent = `
    @keyframes giftRecipientPrecheckPulse { from { opacity: 1; } to { opacity: 0.45; } }
    ${selectors} {
      animation: giftRecipientPrecheckPulse 0.6s ease-in-out infinite alternate !important;
      cursor: progress !important;
    }
  `
}
