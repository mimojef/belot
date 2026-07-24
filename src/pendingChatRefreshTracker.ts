/**
 * Проследява дали chat conversation/unread state се е разминал с backend-а,
 * защото chat_message_received е пристигнало, докато сме били в активна
 * игра — chat GET заявките биха 403-нали тогава (isProfileInActiveGame на
 * сървъра). Дори след напускане на масата, сървърът може да продължи да
 * брои профила като "в игра" известно време (bot takeover довършва мача
 * вместо напусналия играч, без да го маркира като бот участник), затова
 * маркерът устоява на неуспешни опити — изчиства се само след реално
 * успешен refresh.
 *
 * Чист, DOM/network-независим state machine (виж chatNotificationQueue.ts
 * за същия принцип) — main.ts решава КОГА да вика attempt() (при връщане в
 * лоби, PWA resume и т.н.) и подава действителния async ефект.
 */

let pending = false
let inFlight = false

export function markPendingChatRefresh(): void {
  pending = true
}

export function isChatRefreshPending(): boolean {
  return pending
}

export function clearPendingChatRefresh(): void {
  pending = false
}

export type PendingChatRefreshAttemptResult = 'skipped' | 'blocked' | 'succeeded' | 'failed'

/**
 * @param canAttemptNow - извикващият код преценява дали заявка сега БИ
 *   могла да успее (напр. локално вече не сме в игра) — tracker-ът не
 *   познава игровия/auth state.
 * @param performRefresh - реалният async ефект (HTTP GET + прилагане на
 *   резултата); връща дали е бил успешен. Очаква се, при успех,
 *   performRefresh сам да извика clearPendingChatRefresh() (за да се
 *   изчисти маркерът и при други, независими успешни refresh-и — виж
 *   main.ts: syncLobbyChatConversations()).
 */
export async function attemptPendingChatRefresh(
  canAttemptNow: boolean,
  performRefresh: () => Promise<boolean>,
): Promise<PendingChatRefreshAttemptResult> {
  if (!pending || inFlight) {
    return 'skipped'
  }

  if (!canAttemptNow) {
    return 'blocked'
  }

  inFlight = true
  try {
    const ok = await performRefresh()
    return ok ? 'succeeded' : 'failed'
  } finally {
    inFlight = false
  }
}

/** За тестове/диагностика — снимка на текущото състояние. */
export function getPendingChatRefreshDebugState(): { pending: boolean; inFlight: boolean } {
  return { pending, inFlight }
}

/** За тестове — нулира module state между тестови случаи. */
export function resetPendingChatRefreshTrackerForTests(): void {
  pending = false
  inFlight = false
}
