export const SERVER_TIMING_CONFIG = {
  cutHumanTimeoutMs: 15000,
  cutBotDelayMs: 800,

  bidHumanTimeoutMs: 15000,
  bidBotDelayMs: 800,

  playHumanTimeoutMs: 15000,
  playBotDelayMs: 800,

  summaryVisibleMs: 5000,
} as const

export type ServerTimingConfig = typeof SERVER_TIMING_CONFIG
