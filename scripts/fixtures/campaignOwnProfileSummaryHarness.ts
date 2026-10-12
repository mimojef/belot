// Real createLobbyFlowController() (not a mock), loaded through the Vite dev
// server — see checkCampaignOwnProfileSummary.ts. Regression for the active
// campaign card missing from the viewer's OWN profile popup.
//
// ROOT CAUSE: the own profile opens with state.profilePopupProfile=null and is
// rendered from createLocalProfilePreview(), but
// ensureProfilePopupCampaignSummaryLoaded() only read state.profilePopupProfile
// -> it returned early, so no campaign-summary request was ever sent for the
// own profile. The card only "appeared" after viewing another profile, because
// that profile's leftover summary was then rendered inside the own popup.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'

const OWN_ID = 'me'
const OTHER_ID = 'other-player'

const unitsByProfile: Record<string, number> = { [OWN_ID]: 0, [OTHER_ID]: 7 }
const summaryRequests: string[] = []

function summaryFor(profileId: string) {
  const tier = {
    tierId: 't2',
    thresholdUnits: 2,
    rewards: [{ tierRewardId: 'r2', reward: { rewardType: 'yellow_coins', amount: 1000 }, status: 'locked' }],
  }
  return {
    active: {
      campaignId: 'c1',
      campaignName: 'Хелуин',
      unitNameSingular: 'Тиква',
      unitNamePlural: 'Тикви',
      unitIconUrl: null,
      unitsTotal: unitsByProfile[profileId] ?? 0,
      tiers: [tier],
      nextIncompleteTier: tier,
    },
    lastFinished: null,
  }
}

function publicProfile(profileId: string, displayName: string) {
  return {
    profileId, displayName, avatarUrl: null, level: 3, rankTitle: 'Ранг 3', skillRating: null,
    completedGamesCount: 0, wonGamesCount: 0, currentRankGames: 0, nextRankGames: 10, gamesUntilNextRank: 10,
    rankProgressRatio: 0, averageRating: null, totalRatingsCount: null, yellowCoinsBalance: 0, galleryImages: [],
    gender: null, likesCount: 0, hasLikedByMe: false, isBlockedByMe: false,
  } as any
}

const root = document.createElement('div')
document.body.appendChild(root)

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: 'admin' },
    profile: publicProfile(OWN_ID, 'Mimojef'),
  }) as any,
  onProfilePopupCampaignSummaryLoad: async (profileId: string) => {
    summaryRequests.push(profileId)
    return { ok: true, summary: summaryFor(profileId) as any }
  },
  onProfileByIdLoad: async (profileId: string) => ({ ok: true, profile: publicProfile(profileId, 'Друг играч') }),
  onPlayersLoad: async () => ({
    ok: true, players: [publicProfile(OTHER_ID, 'Друг играч')], page: 1, pageSize: 50, totalCount: 1, totalPages: 1,
    snapshot: 'snap-1', snapshotReset: false,
  }),
} as any)

controller.render()

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0))
}

function cardText(): string | null {
  const card = document.querySelector('[data-player-profile-campaign-card="1"]')
  return card === null ? null : (card.textContent ?? '').replace(/\s+/g, ' ').trim()
}

;(window as any).__campaignOwnProfileSummaryHarness = {
  openOwnProfile: async (): Promise<void> => {
    root.querySelector<HTMLElement>('[data-lobby-profile-button="1"]')?.click()
    await flush()
  },
  openOtherProfileFromPlayers: async (): Promise<boolean> => {
    root.querySelector<HTMLElement>('[data-lobby-nav-players="1"]')?.click()
    await flush()
    const card = root.querySelector<HTMLElement>(`[data-lobby-player-card="${OTHER_ID}"]`)
    if (card === null) return false
    card.click()
    await flush()
    return true
  },
  closePopup: async (): Promise<void> => {
    (document.querySelector('[data-player-profile-popup-close="1"]') as HTMLElement | null)?.click()
    await flush()
  },
  goToLobby: async (): Promise<void> => {
    root.querySelector<HTMLElement>('[data-lobby-nav-lobby="1"]')?.click()
    await flush()
  },
  setUnits: (profileId: string, units: number): void => { unitsByProfile[profileId] = units },
  isPopupOpen: (): boolean => document.querySelector('[data-player-profile-popup-root="1"]') !== null,
  cardText,
  summaryRequests: (): string[] => [...summaryRequests],
}
