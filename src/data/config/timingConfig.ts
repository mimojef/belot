export const TIMING_CONFIG = {
  cutHumanTimeoutMs: 15000,
  cutBotDelayMs: 1000,

  bidHumanTimeoutMs: 15000,
  bidBotDelayMs: 1000,

  playHumanTimeoutMs: 15000,
  playBotDelayMs: 1000,

  summaryVisibleMs: 5000,
} as const

export type TimingConfig = typeof TIMING_CONFIG