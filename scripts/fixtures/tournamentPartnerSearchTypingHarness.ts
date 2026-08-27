// Браузърна тестова "сглобка" за checkTournamentPartnerSearchTyping.ts —
// кара РЕАЛНИЯ createLobbyFlowController() (не мокап), зареден през Vite
// dev server, в истински браузър (Playwright). Отваря "Избери партньор"
// modal-a чрез РЕАЛЕН DOM click (data-tournament-partner-picker-open), после
// пише в РЕАЛНИЯ <input data-tournament-partner-query="1"> буква по буква
// чрез page.type()-подобно взаимодействие (симулирано тук чрез dispatch на
// реални input events през exposed helper — виж checkTournamentPartnerSearchTyping.ts
// за точното driving), за да докаже DOM node identity/focus стабилност
// (§ "TARGETED REGRESSION TEST").
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import type { TournamentDetailSnapshot, TournamentPartnerCandidateSnapshot } from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

let searchResolvers: Array<{ query: string; resolve: (candidates: TournamentPartnerCandidateSnapshot[]) => void }> = []
let searchCallCount = 0
const friendsCandidates: TournamentPartnerCandidateSnapshot[] = [
  { profileId: 'friend-1', displayName: 'FriendOne', avatarUrl: null, online: true, eligible: true, unavailableReason: null },
  { profileId: 'friend-2', displayName: 'FriendTwo', avatarUrl: null, online: false, eligible: true, unavailableReason: null },
]

function baseDetail(overrides: Partial<TournamentDetailSnapshot>): TournamentDetailSnapshot {
  return {
    tournamentId: 'tour-typing-1',
    name: 'Typing Harness Tournament',
    creator: { profileId: 'creator-1', displayName: 'Creator', avatarUrl: null },
    visibility: 'public',
    requiresPassword: false,
    status: 'open',
    statusLabel: 'Отворен',
    championTeamId: null,
    runnerUpTeamId: null,
    settlementState: 'pending',
    settledAt: null,
    entryFee: 5000,
    playerCapacity: 8,
    confirmedEntriesCount: 1,
    reservedPlacesCount: 0,
    occupiedPlacesCount: 1,
    completedTeamsCount: 0,
    formingTeamsCount: 0,
    availablePlaces: 7,
    isFull: false,
    startMode: 'fill',
    scheduledStartAt: null,
    fillExpiresAt: null,
    createdAt: new Date().toISOString(),
    prizePreview: {
      totalEntryFees: 40000,
      systemFee: 8000,
      prizePool: 32000,
      firstTeamPrize: 20800,
      secondTeamPrize: 11200,
      firstPlayerPrize: 10400,
      secondPlayerPrize: 5600,
      systemFeePercent: 20,
      winnerSharePercent: 65,
      runnerUpSharePercent: 35,
      financialRulesVersion: 'v1',
      persisted: true,
    } as any,
    isMine: false,
    viewer: {
      isParticipant: false,
      entryStatus: null,
      joinedAs: null,
      canJoinSolo: true,
      canInvitePartner: true,
      canLeave: false,
      canCancel: false,
      myPlacement: null,
      myPrizeAmount: null,
    },
    cancelReason: null,
    startedAt: null,
    finishedAt: null,
    myTeam: null,
    teams: [],
    rounds: [],
    myActiveMatch: null,
    myInterRoundWaiting: null,
    incomingPartnerInvite: null,
    outgoingPartnerInvite: null,
    ...overrides,
  } as TournamentDetailSnapshot
}

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: 'player' },
    profile: { profileId: 'me', displayName: 'Me' } as any,
  }),
  onTournamentDetailLoad: async (_tournamentId: string) => ({ ok: true, tournament: baseDetail({}) }),
  onTournamentPartnerCandidatesLoad: async (_tournamentId: string) => ({ ok: true, candidates: friendsCandidates }),
  // Deferred, manually resolved from the test (see resolvePendingSearch
  // below) — lets the test control exactly when a search response "arrives"
  // relative to further typing, to prove stale-response protection.
  onTournamentPartnerCandidatesSearch: (_tournamentId, query, _signal) => {
    searchCallCount += 1
    return new Promise((resolve) => {
      searchResolvers.push({
        query,
        resolve: (candidates) => resolve({ ok: true, candidates }),
      })
    })
  },
  onTournamentPartnerInviteCreate: async (_tournamentId, inviteeProfileId, _password) => {
    lastInviteSubmittedProfileId = inviteeProfileId
    return {
      ok: true,
      invite: {
        inviteId: 'invite-1',
        tournamentId: 'tour-typing-1',
        teamId: 'team-1',
        inviterProfileId: 'me',
        inviteeProfileId,
        status: 'pending',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        popupDismissedAt: null,
        notificationReadAt: null,
        createdAt: new Date().toISOString(),
        respondedAt: null,
      } as any,
      walletBalance: 995000,
      tournament: baseDetail({}) as any,
    }
  },
})

let lastInviteSubmittedProfileId: string | null = null

controller.navigateToTournamentDetail('tour-typing-1')

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

// tournamentPartnerSearchRunner debounces 300ms before actually calling
// onTournamentPartnerCandidatesSearch — tests that need to observe/resolve
// the resulting pending search call must wait past that delay, not just
// flush microtasks.
async function flushPastDebounce(): Promise<void> {
  await new Promise((r) => setTimeout(r, 350))
  await flush()
}

function openPicker(): void {
  root.querySelector<HTMLButtonElement>('[data-tournament-partner-picker-open="1"]')?.click()
}

function getInputEl(): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>('[data-tournament-partner-query="1"]')
}

function typeChar(char: string): void {
  const input = getInputEl()
  if (input === null) throw new Error('search input not found')
  input.focus()
  input.value = input.value + char
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function backspace(): void {
  const input = getInputEl()
  if (input === null) throw new Error('search input not found')
  input.focus()
  input.value = input.value.slice(0, -1)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

// Resolves the OLDEST still-pending search call whose query matches (or the
// oldest overall if no query given) — lets the test simulate out-of-order
// async arrival for the stale-response test.
function resolvePendingSearch(query: string | null, candidates: TournamentPartnerCandidateSnapshot[]): boolean {
  const idx = query === null ? 0 : searchResolvers.findIndex((r) => r.query === query)
  if (idx === -1) return false
  const [entry] = searchResolvers.splice(idx, 1)
  entry.resolve(candidates)
  return true
}

;(window as any).__tournamentPartnerSearchTypingHarness = {
  openPicker,
  typeChar,
  backspace,
  flush,
  flushPastDebounce,
  getInputValue: () => getInputEl()?.value ?? null,
  getInputElementId: () => {
    const el = getInputEl()
    if (el === null) return null
    // Stamp a stable marker the first time we see this exact node, so later
    // reads can prove "same node" vs "different node after a rebuild".
    if (!el.dataset.harnessNodeId) {
      el.dataset.harnessNodeId = String(Math.random())
    }
    return el.dataset.harnessNodeId
  },
  isInputFocused: () => document.activeElement === getInputEl(),
  getSearchResultsHtml: () => root.querySelector('[data-tournament-partner-search-results="1"]')?.innerHTML ?? null,
  domHasFriendsSection: () => root.textContent?.includes('Приятели') === true,
  domHasFriendRow: (profileId: string) => root.querySelector(`[data-tournament-partner-invite="${profileId}"]`) !== null,
  getPendingSearchQueries: () => searchResolvers.map((r) => r.query),
  getSearchCallCount: () => searchCallCount,
  resolvePendingSearch,
  clickSearchResultInvite: (profileId: string) => {
    const btn = root.querySelector<HTMLButtonElement>(`[data-tournament-partner-search-results="1"] [data-tournament-partner-invite="${profileId}"]`)
    btn?.click()
  },
  getLastInviteSubmittedProfileId: () => lastInviteSubmittedProfileId,
  reset: () => {
    searchResolvers = []
    searchCallCount = 0
    lastInviteSubmittedProfileId = null
  },
}
