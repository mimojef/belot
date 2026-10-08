import {
  getLocalTournamentTestTimingOverrides,
  isLocalTournamentTestModeEnabled,
  pickLocalTournamentTestBotActionDelayMs,
} from '../localTournamentTest/localTournamentTestModeGuard.js'

const PLAY_CARD_ENTRY_ANIMATION_MS = 400
const COMPLETED_TRICK_PREVIEW_MS = 220
const TRICK_COLLECTION_GATHER_MS = 180
const TRICK_COLLECTION_FLY_MS = 420
const TRICK_COLLECTION_CARD_STAGGER_MS = 35
const TRICK_COLLECTION_CARD_COUNT = 4

const PLAY_AFTER_TRICK_COLLECTION_DELAY_MS =
  PLAY_CARD_ENTRY_ANIMATION_MS +
  COMPLETED_TRICK_PREVIEW_MS +
  TRICK_COLLECTION_GATHER_MS +
  TRICK_COLLECTION_FLY_MS +
  TRICK_COLLECTION_CARD_STAGGER_MS * (TRICK_COLLECTION_CARD_COUNT - 1)

// "Долу картите" — огледало на client-side animateSweepThrowDown.ts timeline-а:
// надпис + звук (1500ms) → ветрилото на заявилия се свива (180ms) и лети/се
// разперва в центъра (320ms) → стои само в центъра 1000ms → другите ветрила
// се свиват (180ms) и се разперват открити до местата си (320ms) → картите
// стоят открити (1500ms) → общ куп към заявилия (gather 180ms + fly 560ms) →
// финална пауза 50ms. Сървърът трябва да изчака поне толкова (+ малък буфер
// за мрежа/render), за да не отреже анимацията — виж
// getServerPhaseAutoAdvanceDelay.ts.
const SWEEP_CAPTION_MS = 1500
const SWEEP_REVEAL_MS = 2 * (180 + 320) + 1000
const SWEEP_REVEAL_HOLD_MS = 1500
const SWEEP_COLLECTION_MS = 180 + 560
const SWEEP_FINAL_PAUSE_MS = 50
const SWEEP_CLIENT_SLACK_MS = 500
const SWEEP_RESOLUTION_AUTO_ADVANCE_MS =
  SWEEP_CAPTION_MS +
  SWEEP_REVEAL_MS +
  SWEEP_REVEAL_HOLD_MS +
  SWEEP_COLLECTION_MS +
  SWEEP_FINAL_PAUSE_MS +
  SWEEP_CLIENT_SLACK_MS

// Само в strictly local tournament test mode (виж
// localTournamentTestModeGuard.ts) — заменя фиксираните 800ms bot delay-и с
// произволна стойност в BELOT_LOCAL_BOT_ACTION_MIN_MS/MAX_MS диапазона, за да
// може автоматизиран бот турнир да завърши за секунди вместо минути.
// Изчислено веднъж при module load (единствената точка, извикваща guard-а
// тук — виж "Не разпръсквай проверки на env из много файлове" в task spec-а).
// Без флага изразът по-долу е no-op и запазва точно production стойностите.
const localBotActionDelayMs = isLocalTournamentTestModeEnabled()
  ? pickLocalTournamentTestBotActionDelayMs(getLocalTournamentTestTimingOverrides())
  : null

// *HumanTimeoutMs = стандартното "Време за реакция" (15s) за всички маси без
// изричен override. Частна маса може да избере друга стойност от
// HUMAN_TURN_TIMEOUT_OPTIONS_MS (state.humanTurnTimeoutMs) — виж
// resolveServerHumanTurnTimeoutMs в serverTimerStateHelpers.ts. Bot delay-ите
// и sweepOfferHumanTimeoutMs НЕ зависят от него.
export const SERVER_TIMING_CONFIG = {
  cutHumanTimeoutMs: 15000,
  cutBotDelayMs: localBotActionDelayMs ?? 800,

  bidHumanTimeoutMs: 15000,
  bidBotDelayMs: localBotActionDelayMs ?? 800,

  playHumanTimeoutMs: 15000,
  playBotDelayMs: localBotActionDelayMs ?? 800,
  playAfterTrickCollectionDelayMs: PLAY_AFTER_TRICK_COLLECTION_DELAY_MS,

  // "Долу картите" — кратък timeout, за да не увисне мач заради
  // disconnected/afk claimant; auto-decline при изтичане (виж
  // advanceExpiredServerSweepOfferState.ts).
  sweepOfferHumanTimeoutMs: 15000,
  sweepOfferBotDelayMs: localBotActionDelayMs ?? 400,
  sweepResolutionAutoAdvanceMs: SWEEP_RESOLUTION_AUTO_ADVANCE_MS,

  summaryVisibleMs: 5000,
} as const

export type ServerTimingConfig = typeof SERVER_TIMING_CONFIG
