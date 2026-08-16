// Real-WS variant of biddingBoardLifecycleHarness.ts — mounts the REAL
// createActiveRoomFlowController(), but wired to a genuine browser-native
// WebSocket connected to a real backend (mirrors main.ts's actual wiring),
// instead of manually-constructed synthetic room_snapshot messages. Used to
// prove (or disprove) the top-seat profile-popup bug across the FULL real
// wire: real click -> real request_player_profile send -> real server
// resolution -> real player_profile response -> real handleServerMessage.
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

let socket: WebSocket | null = null
const receivedFrames: any[] = []
const sentFrames: any[] = []
let autoDrive = false
const seenCutForRoom = new Set<string>()
const respondedForBidTurn = new Set<string>()

function send(message: Record<string, unknown>): void {
  sentFrames.push(message)
  socket?.send(JSON.stringify(message))
}

// Mirrors autoDriveCuttingAndBidding() in
// server/scripts/checkGameplayActionStaleConnectionGuard.ts — auto-answers
// cutting/bidding prompts for THIS connection so a single real-browser
// client can reach 'playing' without a human driving the UI. No-op once the
// game is past bidding (both canSubmitCut/canSubmitBid become false).
function maybeAutoDrive(frame: any): void {
  if (!autoDrive || frame.type !== 'room_snapshot' || !frame.game) return
  const roomId = frame.roomId as string

  const cutting = frame.game.cutting
  if (cutting?.canSubmitCut && !seenCutForRoom.has(roomId)) {
    seenCutForRoom.add(roomId)
    const cutIndex = Math.max(1, Math.min(cutting.deckCount - 1, Math.floor(cutting.deckCount / 2)))
    send({ type: 'submit_cut_index', roomId, cutIndex })
  }

  const bidding = frame.game.bidding
  if (bidding?.canSubmitBid) {
    const turnKey = `${roomId}:${bidding.currentBidderSeat}:${bidding.entries.length}`
    if (!respondedForBidTurn.has(turnKey)) {
      respondedForBidTurn.add(turnKey)
      const action = bidding.validActions?.suits?.clubs ? { type: 'suit', suit: 'clubs' } : { type: 'pass' }
      send({ type: 'submit_bid_action', roomId, action })
    }
  }
}

const controller = createActiveRoomFlowController({
  root: root as unknown as HTMLDivElement,
  isConnected: () => true,
  leaveActiveRoom: (roomId, acceptPenalty) => send({ type: 'leave_active_room', roomId, acceptPenalty }),
  submitCutIndex: (roomId, cutIndex) => send({ type: 'submit_cut_index', roomId, cutIndex }),
  submitBidAction: (roomId, action) => send({ type: 'submit_bid_action', roomId, action }),
  submitPlayCard: (roomId, cardId, declarationKeys) => send({ type: 'submit_play_card', roomId, cardId, declarationKeys }),
  resumeHumanControl: (roomId) => send({ type: 'resume_human_control', roomId }),
  submitPartnerRating: (roomId, rating) => send({ type: 'submit_partner_rating', roomId, rating }),
  sendReplayVote: (roomId, vote) => send({ type: 'request_replay', roomId, vote }),
  sendLeaveMatchVote: (roomId) => send({ type: 'request_leave_match', roomId }),
  sendEmojiReaction: (roomId, emojiId) => send({ type: 'send_emoji_reaction', roomId, emojiId }),
  sendPhraseReaction: (roomId, phraseId) => send({ type: 'send_phrase_reaction', roomId, phraseId }),
  requestPlayerProfile: (roomId, seat) => send({ type: 'request_player_profile', roomId, seat }),
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
})

;(window as any).__activeRoomRealWsHarness = {
  controller,
  connect: (url: string): Promise<void> => {
    return new Promise((resolveOpen, reject) => {
      socket = new WebSocket(url)
      socket.addEventListener('message', (ev) => {
        let msg: any
        try {
          msg = JSON.parse(ev.data as string)
        } catch {
          return
        }
        receivedFrames.push(msg)
        maybeAutoDrive(msg)
        // Mirrors main.ts's onMatchFound wiring: private_room_full is the
        // trigger that actually enters the active room (match_found-shaped
        // payload), everything else goes straight to handleServerMessage —
        // exactly the real production dispatch for the active-room domain.
        if (msg.type === 'private_room_full') {
          controller.enterActiveRoom({
            type: 'match_found',
            roomId: msg.roomId,
            seat: msg.seat,
            stake: msg.stake,
            humanPlayers: 4,
            botPlayers: 0,
            shouldStartImmediately: true,
          } as any, false)
          return
        }
        controller.handleServerMessage(msg)
      })
      socket.addEventListener('open', () => resolveOpen())
      socket.addEventListener('error', reject)
    })
  },
  send,
  setAutoDrive: (value: boolean) => { autoDrive = value },
  clickSeatProfile: (seat: string): boolean => {
    const btn = document.body.querySelector<HTMLElement>(`[data-profile-seat-btn="${seat}"]`)
    if (!btn) return false
    btn.click()
    return true
  },
  getPopupBodyText: (): string | null => {
    const popupRoot = document.body.querySelector<HTMLElement>('[data-player-profile-popup-root="1"]')
    return popupRoot ? (popupRoot.textContent ?? '') : null
  },
  getSeatProfileBtnAttrs: (): Array<string | null> =>
    Array.from(document.body.querySelectorAll('[data-profile-seat-btn]')).map((el) => el.getAttribute('data-profile-seat-btn')),
  getSentFrames: () => sentFrames,
  getReceivedFrames: () => receivedFrames,
}
