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

// "Долу картите" — client-side animateSweepThrowDown.ts budget: кратък
// "Долу картите" caption (~700ms, incl. fade) + 4 seats хвърлят ръцете си
// последователно (~550ms видима пауза на място) + кратка финална пауза
// преди auto-advance към scoring. Сървърът трябва да изчака поне толкова,
// за да не отреже анимацията — виж getServerPhaseAutoAdvanceDelay.ts.
const SWEEP_CAPTION_MS = 700
const SWEEP_PER_SEAT_THROW_MS = 550
const SWEEP_SEAT_COUNT = 4
const SWEEP_FINAL_PAUSE_MS = 500
const SWEEP_RESOLUTION_AUTO_ADVANCE_MS =
  SWEEP_CAPTION_MS + SWEEP_PER_SEAT_THROW_MS * SWEEP_SEAT_COUNT + SWEEP_FINAL_PAUSE_MS

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

export const SERVER_TIMING_CONFIG = {
  cutHumanTimeoutMs: 20000,
  cutBotDelayMs: localBotActionDelayMs ?? 800,

  bidHumanTimeoutMs: 20000,
  bidBotDelayMs: localBotActionDelayMs ?? 800,

  playHumanTimeoutMs: 20000,
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
