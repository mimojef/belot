// Real createLobbyFlowController() (not a mock), loaded through the Vite dev
// server — see checkDailyMissionsPopup.ts. Regression for the "Дневни мисии"
// modal (a) appearing to open with a delay and then never closing (X /
// backdrop both silently do nothing, only a full page refresh escapes it),
// and (b) a follow-up regression check specifically for successful mission
// claim: does the visible lobby yellow-coins balance / quick-action badge
// go stale after claiming a reward?
//
// ROOT CAUSE (a) (identical bug class to lobbyOwnProfilePopupHarness.ts's
// own-profile popup fix, just never applied here): the missions modal lives
// on document.body (outside root.innerHTML, via syncMissionsPopup), but
// openMissionsPopup()/claimMission()/onMissionsPopupClose all called the
// generic render(). render() -> renderLobbyScreen() has a skip-if-unchanged
// guard on root.innerHTML (introduced in commit 1915e7d, "Fix lobby render
// churn during tournament wait") — none of missionsPopupOpen/dailyMissions/
// dailyMissionsLoading/etc. affect that root string, so whenever a mission
// state change happens to produce a root string byte-identical to the
// previous one (the common case: same unclaimed count before/after, nothing
// else happening in an idle lobby), the guard's early return means
// syncMissionsPopup() (only called from inside renderLobbyScreen(), after
// the guard) is never reached.
//
// FIX (a): openMissionsPopup()/claimMission()/onMissionsPopupClose now call a
// dedicated renderMissionsPopupOnly() that invokes syncMissionsPopup()
// directly, mirroring the already-working renderPopupOnly() pattern for the
// profile popup.
//
// FOLLOW-UP CHECK (b): a naive renderMissionsPopupOnly()-everywhere fix would
// have introduced a NEW regression — successful claim (real app: main.ts's
// claimMissionReward) mutates currentAuthSession.profile.yellowCoinsBalance
// (read fresh by buildLobbyScreenState() via options.getAuthSession() on
// every render()) and dailyMissionsUnclaimedCount (feeds the root-rendered
// "Дневни мисии" quick-action card badge) — BOTH root-visible, NEITHER
// synced by renderMissionsPopupOnly() alone. This harness mirrors that exact
// external-mutation pattern (a mutable local authSession object, mutated by
// the mocked onMissionClaim BEFORE resolving, exactly like main.ts does) so
// the test can catch a stale hero-section balance for real.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'

const root = document.createElement('div')
document.body.appendChild(root)

const STARTING_BALANCE = 20000

let authSession: any = {
  account: { role: 'player' },
  profile: { profileId: 'me', displayName: 'Me', likesCount: 0, yellowCoinsBalance: STARTING_BALANCE },
}

const missions = [
  { missionId: 'm1', title: 'Изиграй 5 игри', missionType: 'play_games', targetCount: 5, progressCount: 5, rewardYellowCoins: 5000, isCompleted: true, isClaimed: false },
  { missionId: 'm2', title: 'Спечели 3 игри', missionType: 'win_games', targetCount: 3, progressCount: 1, rewardYellowCoins: 8000, isCompleted: false, isClaimed: false },
  { missionId: 'm3', title: 'Обяви 2 терци', missionType: 'announce_tersa', targetCount: 2, progressCount: 2, rewardYellowCoins: 3000, isCompleted: true, isClaimed: true },
] as any[]

function computeUnclaimedCount(): number {
  return missions.filter((m) => m.isCompleted && !m.isClaimed).length
}

let dailyMissionsLoadCallCount = 0
let claimCallCount = 0
const claimRequestedMissionIds: string[] = []
let forceNextClaimToFail = false

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  // Връща ТЕКУЩАТА стойност на authSession (fresh read всеки път, огледално
  // на main.ts's currentAuthSession module variable) — НЕ frozen snapshot.
  getAuthSession: () => authSession,
  onDailyMissionsLoad: async () => {
    dailyMissionsLoadCallCount += 1
    return { ok: true, missions: [...missions], unclaimedCount: computeUnclaimedCount(), date: '2026-01-01' }
  },
  onMissionClaim: async (missionId: string) => {
    claimCallCount += 1
    claimRequestedMissionIds.push(missionId)

    if (forceNextClaimToFail) {
      forceNextClaimToFail = false
      return { ok: false, message: 'Наградата не беше взета (тестова грешка).' }
    }

    const mission = missions.find((m) => m.missionId === missionId)
    if (!mission || !mission.isCompleted || mission.isClaimed) {
      return { ok: false, message: 'Мисията не е готова за вземане.' }
    }

    mission.isClaimed = true
    const rewardYellowCoins = mission.rewardYellowCoins as number

    // Огледално на main.ts's claimMissionReward: мутира authSession-a
    // ПРЕДИ да resolve-не промиса — точно механизмът, който
    // renderMissionsPopupOnly()-само НЕ би хванал.
    authSession = {
      ...authSession,
      profile: {
        ...authSession.profile,
        yellowCoinsBalance: (authSession.profile.yellowCoinsBalance ?? 0) + rewardYellowCoins,
      },
    }

    return {
      ok: true,
      rewardYellowCoins,
      missions: [...missions],
      unclaimedCount: computeUnclaimedCount(),
    }
  },
})

controller.render()

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function isPopupOpen(): boolean {
  return document.querySelector('[data-missions-popup-root="1"]') !== null
}

// Desktop (renderHeroSection) wraps the amount in a dedicated <span>; mobile
// (renderMobileProfileCard) has it as loose text next to an <img>, no <span>
// at all. Rather than special-case each markup shape, take the WHOLE
// "Баланс" label's container text (label text + amount, both layouts) and
// keep only digit characters — Intl.NumberFormat('bg-BG') thousands
// separators are never digits, and "жълтици"/label text contain none
// either, so this isolates the balance number regardless of layout or which
// exact whitespace character ICU used for grouping.
function getHeroBalanceText(): string {
  const balanceLabel = Array.from(document.querySelectorAll('div')).find(
    (d) => d.textContent?.trim() === 'Баланс' && d.children.length === 0,
  )
  const containerText = balanceLabel?.parentElement?.textContent ?? ''
  let digitsOnly = ''
  for (const ch of containerText) {
    const code = ch.charCodeAt(0)
    if (code >= 48 && code <= 57) digitsOnly += ch
  }
  return digitsOnly
}

;(window as any).__dailyMissionsPopupHarness = {
  isPopupOpen: (): boolean => isPopupOpen(),
  getPopupRootCount: (): number => document.querySelectorAll('[data-missions-popup-root="1"]').length,
  getDailyMissionsLoadCallCount: (): number => dailyMissionsLoadCallCount,
  getPopupText: (): string => document.querySelector('[data-missions-popup-root="1"]')?.textContent ?? '',
  getClaimButtonCount: (): number => document.querySelectorAll('[data-missions-popup-root="1"] [data-mission-claim]').length,
  getHeroBalanceText,
  getRawBalance: (): number => authSession.profile.yellowCoinsBalance,
  getClaimCallCount: (): number => claimCallCount,
  getClaimRequestedMissionIds: (): string[] => [...claimRequestedMissionIds],
  setForceNextClaimToFail: (value: boolean): void => { forceNextClaimToFail = value },
  clickMissionsCardAndFlush: async (): Promise<void> => {
    (root.querySelector('[data-lobby-missions-card="1"]') as HTMLElement | null)?.click()
    await flush()
  },
  closeViaXAndFlush: async (): Promise<void> => {
    (document.querySelector('[data-missions-popup-close="1"]') as HTMLElement | null)?.click()
    await flush()
  },
  closeViaBackdropAndFlush: async (): Promise<void> => {
    (document.querySelector('[data-missions-popup-backdrop="1"]') as HTMLElement | null)?.click()
    await flush()
  },
  clickClaimButtonAndFlush: async (missionId: string): Promise<void> => {
    (document.querySelector(`[data-mission-claim="${missionId}"]`) as HTMLElement | null)?.click()
    await flush()
  },
  clickBehindElementIsReachable: (): boolean => {
    // "Страницата отдолу е responsive" проверка: ако popup-ът наистина е
    // затворен (DOM-ът му премахнат), elementFromPoint в средата на viewport-а
    // не може да резолвира до missions-popup backdrop/root — независимо от
    // точния scroll/layout на lobby съдържанието зад него.
    const el = document.elementFromPoint(
      Math.floor(window.innerWidth / 2),
      Math.floor(window.innerHeight / 2),
    )
    if (el === null) return false
    return el.closest('[data-missions-popup-root="1"]') === null
      && el.closest('[data-missions-popup-backdrop="1"]') === null
  },
}
