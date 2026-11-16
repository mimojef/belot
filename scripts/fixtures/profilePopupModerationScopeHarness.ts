// Реален createLobbyFlowController() (не mock), зареден през Vite dev
// сървъра — виж scripts/checkProfilePopupModerationScope.ts. Регресия за
// заглушаването на разгледан чужд профил, показвано върху собствения профил
// на администратора (desktop изглед). Заявката за mute статуса се резолва
// ръчно (опашка по profileId), за да се проверят закъснели отговори.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'

type MuteSnapshot = { isMuted: boolean; mutedUntil: string | null; mutedByAccountId: string | null; reason: string | null }

const root = document.createElement('div')
document.body.appendChild(root)

const OWN_ID = 'me-admin'
const MUTED_UNTIL = '2026-11-16T23:12:59.000Z'
const NOT_MUTED: MuteSnapshot = { isMuted: false, mutedUntil: null, mutedByAccountId: null, reason: null }

const profiles: Record<string, any> = {
  [OWN_ID]: { profileId: OWN_ID, displayName: 'Mimojef', avatarUrl: null, level: 9 },
  roberto: { profileId: 'roberto', displayName: 'Roberto', avatarUrl: null, level: 5 },
  clean: { profileId: 'clean', displayName: 'Чист', avatarUrl: null, level: 3 },
}

// „Сървърното“ състояние на mute-а (mutable — mute/unmute го променят).
const serverMutes: Record<string, MuteSnapshot> = {
  roberto: { isMuted: true, mutedUntil: MUTED_UNTIL, mutedByAccountId: null, reason: 'Неподходящо съдържание' },
  clean: { ...NOT_MUTED },
}

const pendingMuteLoads: Array<{ profileId: string; resolve: (r: { ok: true; mute: MuteSnapshot }) => void }> = []
const banLoads: string[] = []
const roleLoads: string[] = []
const unmuteCalls: string[] = []
const muteCalls: string[] = []

const authSession: any = {
  account: { role: 'admin' },
  profile: { profileId: OWN_ID, displayName: 'Mimojef', likesCount: 0 },
}

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => authSession,
  onGetOwnVipStatus: async () => ({ ok: true, activeUntil: null }),
  onPlayersLoad: async () => ({
    ok: true,
    players: Object.values(profiles),
    page: 1,
    pageSize: 50,
    totalCount: Object.keys(profiles).length,
    totalPages: 1,
    snapshot: 'snap',
  }) as any,
  onProfileByIdLoad: async (profileId: string) => {
    const profile = profiles[profileId]
    return profile ? { ok: true, profile } : { ok: false, message: 'няма' }
  },
  onProfileMuteStatusLoad: (profileId: string) =>
    new Promise((resolve) => {
      pendingMuteLoads.push({ profileId, resolve })
    }),
  onAdminGetActiveBan: async (profileId: string) => {
    banLoads.push(profileId)
    return { ok: true, activeBan: null }
  },
  onAdminGetTargetRole: async (profileId: string) => {
    roleLoads.push(profileId)
    return { ok: true, role: null }
  },
  onProfileUnmuteProfile: async (profileId: string) => {
    unmuteCalls.push(profileId)
    if (serverMutes[profileId]) serverMutes[profileId] = { ...NOT_MUTED }
    return { ok: true }
  },
  onProfileMuteProfile: async (profileId: string, reason: string, durationMs: number) => {
    muteCalls.push(profileId)
    const mute: MuteSnapshot = { isMuted: true, mutedUntil: new Date(Date.now() + durationMs).toISOString(), mutedByAccountId: null, reason }
    serverMutes[profileId] = mute
    return { ok: true, mute }
  },
} as any)

controller.render()

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0))
}

async function click(selector: string, scope: ParentNode = document): Promise<boolean> {
  const el = scope.querySelector<HTMLElement>(selector)
  if (!el) return false
  el.click()
  await flush()
  return true
}

function moderationPopupText(): string | null {
  const submit = document.querySelector('[data-topic-moderation-submit="1"]')
  if (!submit) return null
  let node: HTMLElement | null = submit as HTMLElement
  while (node && !(node.textContent ?? '').includes('Заглушен потребител') && !(node.textContent ?? '').includes('Продължителност')) {
    node = node.parentElement
  }
  return node?.textContent?.replace(/\s+/g, ' ').trim() ?? null
}

;(window as any).__profilePopupModerationScope = {
  OWN_ID,
  isPopupOpen: (): boolean => document.querySelector('[data-player-profile-popup-root="1"]') !== null,
  isOwnPopup: (): boolean => document.querySelector('[data-player-profile-own-summary="1"]') !== null
    || document.querySelector('[data-player-profile-own-hero="1"]') !== null,
  // Собствен профил от картата му в „Играчи“ (openProtectedProfileById, isOwn клон).
  openOwn: async (): Promise<boolean> => click(`[data-lobby-player-card="${OWN_ID}"]`, root),
  // Собствен профил от бутона в лобито (onProfileClick клон).
  goLobby: async (): Promise<boolean> => click('[data-lobby-nav-lobby="1"]', root),
  openOwnFromLobby: async (): Promise<boolean> => click('[data-lobby-profile-button="1"]', root),
  goPlayers: async (): Promise<boolean> => click('[data-lobby-nav-players="1"]', root),
  openPlayer: async (profileId: string): Promise<boolean> => click(`[data-lobby-player-card="${profileId}"]`, root),
  close: async (): Promise<boolean> => click('[data-player-profile-popup-close="1"]'),
  pendingMuteLoads: (): string[] => pendingMuteLoads.map((p) => p.profileId),
  // Резолва НАЙ-СТАРАТА чакаща заявка за profileId със „сървърното“ състояние
  // към момента на резолвването (или с подаден snapshot).
  resolveMute: async (profileId: string, override?: MuteSnapshot): Promise<boolean> => {
    const index = pendingMuteLoads.findIndex((p) => p.profileId === profileId)
    if (index < 0) return false
    const [pending] = pendingMuteLoads.splice(index, 1)
    pending!.resolve({ ok: true, mute: override ?? { ...serverMutes[profileId]! } })
    await flush()
    return true
  },
  overlayProfileId: (): string | null => {
    const el = document.querySelector<HTMLElement>('[data-player-profile-mute-overlay]')
    return el ? el.getAttribute('data-player-profile-mute-overlay') : null
  },
  muteActionProfileId: (): string | null => {
    const el = document.querySelector<HTMLElement>('[data-player-profile-mute-action]')
    return el ? el.getAttribute('data-player-profile-mute-action') : null
  },
  clickOverlay: async (): Promise<boolean> => click('[data-player-profile-mute-overlay]'),
  clickMuteAction: async (): Promise<boolean> => click('[data-player-profile-mute-action]'),
  moderationPopupText: (): string | null => moderationPopupText(),
  chooseDuration: async (): Promise<boolean> => click('[data-topic-moderation-duration]'),
  typeReason: async (text: string): Promise<boolean> => {
    const el = document.querySelector<HTMLTextAreaElement>('[data-topic-moderation-reason="1"]')
    if (!el) return false
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    return true
  },
  submitModeration: async (): Promise<boolean> => click('[data-topic-moderation-submit="1"]'),
  cancelModeration: async (): Promise<boolean> => click('[data-topic-moderation-cancel="1"]'),
  unmuteCalls: (): string[] => [...unmuteCalls],
  muteCalls: (): string[] => [...muteCalls],
  banLoads: (): string[] => [...banLoads],
  roleLoads: (): string[] => [...roleLoads],
  serverMute: (profileId: string): MuteSnapshot | null => serverMutes[profileId] ?? null,
}
