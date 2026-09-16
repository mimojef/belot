// Mounts the REAL createActiveRoomFlowController() (production code,
// unmocked) WITHOUT a real WebSocket — synthetic messages are injected
// directly via controller.handleServerMessage(), mirroring the dispatch
// main.ts does for every incoming server message. Used to prove the
// partner_rating_result stale-message safety across a REAL room-switch,
// not just the isolated renderMatchEndedScreen() rendering path (which has
// no concept of roomId/matchEndedPartnerRatingState — that lifecycle lives
// entirely in the controller).
import { createActiveRoomFlowController } from '/src/app/activeRoom/createActiveRoomFlowController.ts'

const root = document.createElement('div')
document.body.appendChild(root)

class FakeAudio {
  constructor(_src?: string) {}
  preload = ''
  volume = 1
  play(): Promise<void> {
    return Promise.resolve()
  }
}
Object.defineProperty(window, 'Audio', { configurable: true, value: FakeAudio })

const sentFrames: any[] = []

function buildMatchEndedSnapshot(roomId: string, endedAt: number) {
  return {
    type: 'room_snapshot',
    roomId,
    roomStatus: 'active',
    yourSeat: 'bottom',
    reconnectToken: 'tok',
    seats: [
      { seat: 'bottom', profileId: 'p1', displayName: 'Me', isOccupied: true, isBot: false, isControlledByBot: false, isConnected: true, avatarUrl: null, level: 1, rankTitle: null, skillRating: 1000, gender: null },
      { seat: 'top', profileId: 'p2', displayName: 'Partner', isOccupied: true, isBot: false, isControlledByBot: false, isConnected: true, avatarUrl: null, level: 1, rankTitle: null, skillRating: 1000, gender: null },
      { seat: 'right', profileId: 'p3', displayName: 'Opp1', isOccupied: true, isBot: true, isControlledByBot: false, isConnected: true, avatarUrl: null, level: 1, rankTitle: null, skillRating: 1000, gender: null },
      { seat: 'left', profileId: 'p4', displayName: 'Opp2', isOccupied: true, isBot: true, isControlledByBot: false, isConnected: true, avatarUrl: null, level: 1, rankTitle: null, skillRating: 1000, gender: null },
    ],
    isGuestTrial: false,
    isPrivateTableOrigin: false,
    isTournamentMatchOrigin: false,
    tournamentId: null,
    tournamentMatchId: null,
    tournamentRoundType: null,
    tournamentAttendance: null,
    tournamentBotReplacements: [],
    tournamentBanners: [],
    activeTableGifts: [],
    stakeAmount: 1000,
    game: {
      phase: 'finished',
      authoritativePhase: 'match-ended',
      timerDeadlineAt: null,
      dealerSeat: 'left',
      firstDealSeat: 'bottom',
      cutting: null,
      bidding: null,
      playing: null,
      scoring: null,
      matchEnded: {
        winnerTeam: 'A',
        targetScore: 151,
        finalScore: { teamA: 160, teamB: 134 },
        endedAt,
        replayVotes: [],
        leaveVotes: [],
        awardedPrizeAmount: 13000,
      },
      declarations: [],
      score: { match: { teamA: 160, teamB: 134 } },
      handCounts: { bottom: 0, right: 0, top: 0, left: 0 },
      ownHand: [],
    },
  }
}

const controller = createActiveRoomFlowController({
  root: root as unknown as HTMLDivElement,
  isConnected: () => true,
  leaveActiveRoom: (roomId, acceptPenalty) => sentFrames.push({ type: 'leave_active_room', roomId, acceptPenalty }),
  submitCutIndex: (roomId, cutIndex) => sentFrames.push({ type: 'submit_cut_index', roomId, cutIndex }),
  submitBidAction: (roomId, action) => sentFrames.push({ type: 'submit_bid_action', roomId, action }),
  submitPlayCard: (roomId, cardId, declarationKeys) => sentFrames.push({ type: 'submit_play_card', roomId, cardId, declarationKeys }),
  resumeHumanControl: (roomId) => sentFrames.push({ type: 'resume_human_control', roomId }),
  submitPartnerRating: (roomId, ratingValue, requestId) => sentFrames.push({ type: 'submit_partner_rating', roomId, ratingValue, requestId }),
  sendReplayVote: (roomId) => sentFrames.push({ type: 'request_replay', roomId }),
  sendLeaveMatchVote: (roomId) => sentFrames.push({ type: 'request_leave_match', roomId }),
  sendEmojiReaction: (roomId, emojiId) => sentFrames.push({ type: 'send_emoji_reaction', roomId, emojiId }),
  sendPhraseReaction: (roomId, phraseId) => sentFrames.push({ type: 'send_phrase_reaction', roomId, phraseId }),
  requestPlayerProfile: (roomId, seat) => sentFrames.push({ type: 'request_player_profile', roomId, seat }),
  getFriendshipAction: () => null,
  onSendFriendRequest: async () => ({ ok: false, message: 'unused' }),
  onLikeProfile: async () => ({ ok: false }),
  onBlockProfile: async () => ({ message: 'unused' }),
  showLobby: () => {},
  startNewGame: () => {},
  onGuestTrialReplayRequested: () => {},
  fetchTournamentDetail: async () => null,
  onEnterWaitingForNextTournamentRound: () => {},
  requestBidResync: () => {},
  forceReconnectForZombieConnection: () => {},
} as any)

function enterRoom(roomId: string, endedAt: number): void {
  controller.enterActiveRoom(
    {
      type: 'match_found',
      roomId,
      seat: 'bottom',
      stake: 1000,
      humanPlayers: 4,
      botPlayers: 0,
      shouldStartImmediately: true,
    } as any,
    false,
  )
  controller.handleServerMessage(buildMatchEndedSnapshot(roomId, endedAt) as any)
}

function clickFirstRatingButton(): void {
  const btn = root.querySelector<HTMLButtonElement>('[data-partner-rating-value]')
  btn?.click()
}

function sendPartnerRatingResult(roomId: string, requestId: string, ok: boolean, alreadyRated: boolean): void {
  controller.handleServerMessage({
    type: 'partner_rating_result',
    roomId,
    requestId,
    ok,
    alreadyRated,
  } as any)
}

// Връща requestId-то от последния submit_partner_rating изпратен frame —
// симулира сървъра, echo-ващ ТОЧНОТО requestId, което controller-ът е
// генерирал за последния click (виж onPartnerRatingSubmitted в
// createActiveRoomFlowController.ts). Тестовете за "правилен резултат"
// (S5/S6/S7/X5-X7) използват това, за да не hardcode-ват crypto.randomUUID()
// изхода; тестовете за stale/wrong-match резултат (X1-X4) подават explicit
// друг requestId (от предишен submit frame), за да симулират delayed
// response за ПРЕДИШЕН submit.
function getLastSubmitRequestId(): string | null {
  for (let i = sentFrames.length - 1; i >= 0; i--) {
    const frame = sentFrames[i]
    if (frame.type === 'submit_partner_rating') {
      return frame.requestId
    }
  }
  return null
}

function getRatingButtonCount(): number {
  return root.querySelectorAll('[data-partner-rating-value]').length
}

function getRatingPanelText(): string | null {
  const el = root.querySelector('[data-partner-rating-panel="1"]')
  return el ? el.textContent : null
}

function reenterSameRoomNewMatch(roomId: string, endedAt: number): void {
  // Replay-in-same-room: NO enterActiveRoom call (that's a genuinely new
  // room/session) — just a fresh room_snapshot with a NEW matchEnded.endedAt
  // for the SAME roomId, exactly like a replay success transitioning the
  // room back into match-ended for a new round without ever leaving it.
  controller.handleServerMessage(buildMatchEndedSnapshot(roomId, endedAt) as any)
}

;(window as any).__partnerRatingStaleMessageHarness = {
  enterRoom,
  clickFirstRatingButton,
  sendPartnerRatingResult,
  getRatingButtonCount,
  getRatingPanelText,
  reenterSameRoomNewMatch,
  getSentFrames: () => sentFrames,
  getLastSubmitRequestId,
}
