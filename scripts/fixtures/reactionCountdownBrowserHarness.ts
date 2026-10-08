// Браузърна тестова "сглобка" за checkReactionCountdownBrowser.ts — кара
// РЕАЛНИЯ createGameServerClient() (onmessage -> sharedServerClock sample ->
// onMessage) и РЕАЛНИЯ createActiveRoomFlowController() в истински Chromium.
// Единствената подмяна е транспортът: window.WebSocket е fake, през който
// Node страната "доставя" room_snapshot JSON, построен от реалния сървърен
// createRoomSnapshotMessage(). Production кодът не е пипан за теста.
//
// Клиентски часовник с изместване (clock skew) се симулира чрез override на
// Date.now() ПРЕДИ зареждане на клиента — CSS анимациите и performance.now()
// не зависят от него, така че тестът проверява, че лентата се позиционира
// по сървърното време, а не по (грешния) клиентски часовник.

const realDateNow = Date.now.bind(Date)
const skewParam = Number(new URLSearchParams(window.location.search).get('skewMs') ?? '0')
const clientClockSkewMs = Number.isFinite(skewParam) ? skewParam : 0
Date.now = () => realDateNow() + clientClockSkewMs

type Listener = (event: { data?: unknown }) => void

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static current: FakeWebSocket | null = null

  readyState = FakeWebSocket.CONNECTING
  private listeners = new Map<string, Listener[]>()

  constructor(_url: string) {
    FakeWebSocket.current = this
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN
      this.emit('open', {})
    }, 0)
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  removeEventListener(): void {}
  send(): void {}
  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

;(window as any).WebSocket = FakeWebSocket

const { createGameServerClient } = await import('/src/app/network/createGameServerClient.ts')
const { createActiveRoomFlowController } = await import('/src/app/activeRoom/createActiveRoomFlowController.ts')
const { sharedServerClock } = await import('/src/app/network/serverClock.ts')

const root = document.getElementById('app') as HTMLDivElement
const noop = () => {}
const pageErrors: string[] = []
window.addEventListener('error', (event) => pageErrors.push(String(event.message)))

// Записва всяко syncReactionCountdownWarning(shouldPlay) с реалното време.
const audioCalls: Array<{ at: number; shouldPlay: boolean }> = []
const gameAudio = new Proxy(
  {},
  {
    get: (_target, prop) => {
      if (prop === 'syncReactionCountdownWarning') {
        return (shouldPlay: boolean) => audioCalls.push({ at: realDateNow(), shouldPlay })
      }
      return () => undefined
    },
  },
) as any

let controller: any = null

const client = createGameServerClient({
  url: 'ws://fake-belot-test/ws',
  onMessage: (message: any) => controller?.handleServerMessage(message),
})
client.connect()

controller = createActiveRoomFlowController({
  root,
  gameAudio,
  isConnected: () => true,
  leaveActiveRoom: noop,
  submitCutIndex: noop,
  submitBidAction: noop,
  submitPlayCard: noop,
  submitSweepDecision: noop,
  resumeHumanControl: noop,
  submitPartnerRating: noop,
  sendReplayVote: noop,
  sendLeaveMatchVote: noop,
  sendEmojiReaction: noop,
  sendPhraseReaction: noop,
  requestPlayerProfile: noop,
  getFriendshipAction: () => null,
  onSendFriendRequest: async () => ({ ok: false, message: '' }),
  onLikeProfile: async () => ({ ok: false }),
  onBlockProfile: async () => ({ message: null }),
  onBlockProfileFull: async () => ({ ok: false, message: '' }),
  showLobby: noop,
  startNewGame: noop,
  onGuestTrialReplayRequested: noop,
  fetchTournamentDetail: async () => null,
  acknowledgeTournamentSemifinalResult: noop,
  onEnterWaitingForNextTournamentRound: noop,
  onTournamentFinalResultContinue: noop,
  requestBidResync: noop,
  forceReconnectForZombieConnection: noop,
  onSpectatorExitRequested: noop,
} as any)

function readScaleX(el: Element): number {
  const transform = getComputedStyle(el).transform
  if (!transform || transform === 'none') return 1
  const match = transform.match(/^matrix\(([^)]+)\)$/)
  if (!match) return NaN
  return Number(match[1].split(',')[0])
}

;(window as any).__reactionCountdownHarness = {
  ready: true,
  clientClockSkewMs,
  realNow: () => realDateNow(),
  mount(roomId: string, seat: string, stake: number) {
    controller.enterActiveRoomFromResume(roomId, seat, stake)
  },
  deliver(json: string) {
    FakeWebSocket.current?.emit('message', { data: json })
  },
  clockOffsetMs: () => sharedServerClock.getOffsetMs(),
  // Всички активни countdown ленти: seat, CSS timing, текущ scaleX и
  // кога (реално време) анимацията ще стигне 0.
  readFills() {
    const readAtRealMs = realDateNow()
    return Array.from(document.querySelectorAll<HTMLElement>('[data-seat-countdown-fill]')).map((el) => {
      const animation = el.getAnimations().find((a: any) => a.animationName === 'belot-active-room-cutting-countdown') as
        | CSSAnimation
        | undefined
      const timing = animation?.effect?.getTiming()
      const currentTime = animation ? Number(animation.currentTime ?? 0) : null
      const durationMs = timing ? Number(timing.duration) : null
      const delayMs = timing ? Number(timing.delay ?? 0) : null
      const msUntilEnd =
        durationMs !== null && delayMs !== null && currentTime !== null
          ? durationMs + delayMs - currentTime
          : null
      return {
        seat: el.getAttribute('data-seat-countdown-fill'),
        active: el.getAttribute('data-countdown-active') === '1',
        key: el.getAttribute('data-countdown-key'),
        inlineStyle: el.getAttribute('style') ?? '',
        durationMs,
        delayMs,
        currentTime,
        scaleX: readScaleX(el),
        endsAtRealMs: msUntilEnd === null ? null : readAtRealMs + msUntilEnd,
        readAtRealMs,
        visible: el.getBoundingClientRect().width > 0,
      }
    })
  },
  audioCalls: () => audioCalls.slice(),
  pageErrors: () => pageErrors.slice(),
}
