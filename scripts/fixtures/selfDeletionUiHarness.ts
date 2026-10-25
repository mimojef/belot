// Самоизтриване, Етап 4I — browser harness (checkProfileSelfDeletionUi.ts).
// Ползва ДИРЕКТНО реалния production код: syncProfilePopup (render + click
// wiring на профилния popup), showSelfDeletionDialog и showPendingDeletionPrompt.
// Сървърът е заместен от контролируем отговор — HTTP/auth слоят е покрит от
// checkProfileDeletionRequestHttp.ts и от e2e теста.
import { syncProfilePopup, type ProfilePopupCallbacks } from '/src/app/lobby/renderLobbyScreen.ts'
import type { PlayerPublicProfileSnapshot } from '/src/app/network/createGameServerClient.ts'
import { showSelfDeletionDialog, type SelfDeletionSubmitResult } from '/src/app/profileDeletion/showSelfDeletionDialog.ts'
import { showPendingDeletionPrompt, type PendingDeletionActionResult } from '/src/app/profileDeletion/showPendingDeletionPrompt.ts'
import { showAutoCancelledDeletionNotice } from '/src/app/profileDeletion/showAutoCancelledDeletionNotice.ts'

const calls: Array<{ name: string; args: unknown[] }> = []
const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }) }

function buildProfile(overrides: Partial<PlayerPublicProfileSnapshot> = {}): PlayerPublicProfileSnapshot {
  return {
    profileId: 'p-own',
    displayName: 'Тестов Играч',
    avatarUrl: null,
    level: 5,
    rankTitle: 'Ранг 5',
    skillRating: 1200,
    completedGamesCount: 40,
    wonGamesCount: 20,
    currentRankGames: 40,
    nextRankGames: 60,
    gamesUntilNextRank: 20,
    rankProgressRatio: 0.66,
    averageRating: 4.5,
    totalRatingsCount: 12,
    yellowCoinsBalance: 15000,
    galleryImages: [{ imageId: 'img-1', imageUrl: '/api/profiles/p-own/gallery/img-1', sortOrder: 0 }],
    gender: null,
    likesCount: 3,
    hasLikedByMe: null,
    isBlockedByMe: null,
    isVip: false,
    vipActiveUntil: null,
    ...overrides,
  }
}

// Всеки callback се записва — така проверяваме, че "Изтрий" вика САМО
// onSelfDeleteClick (не административното onDeleteOpen).
const callbacks = new Proxy({} as ProfilePopupCallbacks, {
  get: (_target, name: string) => record(name),
})

function renderPopup(input: { isOwnProfile: boolean; canSelfDelete: boolean; viewerIsFullAdmin?: boolean; profileId?: string }): void {
  syncProfilePopup(
    {
      isOpen: true,
      profile: buildProfile({ profileId: input.profileId ?? (input.isOwnProfile ? 'p-own' : 'p-other'), displayName: input.isOwnProfile ? 'Тестов Играч' : 'Друг Играч' }),
      canEdit: false,
      isAdmin: input.viewerIsFullAdmin ?? false,
      isOwnProfile: input.isOwnProfile,
      canSelfDelete: input.canSelfDelete,
      friendshipAction: null,
      viewerIsFullAdmin: input.viewerIsFullAdmin ?? false,
      ownVipActiveUntil: null,
      skipAnimation: true,
      activeBan: null,
    } as Parameters<typeof syncProfilePopup>[0],
    callbacks,
  )
}

function closePopup(): void {
  syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null } as Parameters<typeof syncProfilePopup>[0], callbacks)
}

// ─── Прозорецът за потвърждение с контролируем "сървър" ─────────────────
let pendingResolvers: Array<(result: SelfDeletionSubmitResult) => void> = []
const submittedPasswords: string[] = []

function openDialog(): void {
  showSelfDeletionDialog({
    submit: (password) => {
      submittedPasswords.push(password)
      calls.push({ name: 'submit', args: [] })
      return new Promise((resolveSubmit) => { pendingResolvers.push(resolveSubmit) })
    },
    onSubmitStart: record('onSubmitStart'),
    onSubmitFailed: record('onSubmitFailed'),
    onAccepted: record('onAccepted'),
    onAcceptedClose: record('onAcceptedClose'),
  })
}

function resolveSubmit(result: SelfDeletionSubmitResult): void {
  const next = pendingResolvers.shift()
  if (next) next(result)
}

// ─── Екранът от Етап 4H ─────────────────────────────────────────────────
let pendingActionResult: PendingDeletionActionResult = { ok: true }
function openPendingPrompt(response: Parameters<typeof showPendingDeletionPrompt>[0]): void {
  showPendingDeletionPrompt(response, {
    cancelRequest: async (token) => { calls.push({ name: 'cancelRequest', args: [token] }); return pendingActionResult },
    keepRequest: async (token) => { calls.push({ name: 'keepRequest', args: [token] }); return { ok: true } },
    onGoToLogin: record('onGoToLogin'),
  })
}

;(window as unknown as Record<string, unknown>).__selfDeletionUiHarness = {
  renderPopup,
  closePopup,
  openDialog,
  resolveSubmit,
  openPendingPrompt,
  openAutoCancelNotice: (message: string) => showAutoCancelledDeletionNotice(message),
  setPendingActionResult: (result: PendingDeletionActionResult) => { pendingActionResult = result },
  getCalls: () => calls.map((entry) => ({ name: entry.name, args: entry.args })),
  clearCalls: () => { calls.length = 0 },
  submittedPasswords: () => [...submittedPasswords],
  storageSnapshot: () => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  removeOverlays: () => {
    document.getElementById('self-deletion-dialog')?.remove()
    document.getElementById('pending-deletion-prompt')?.remove()
    document.getElementById('profile-deletion-auto-cancel-notice')?.remove()
    pendingResolvers = []
  },
}
