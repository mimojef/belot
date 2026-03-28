export const TIMING_CONFIG = {
  cutHumanTimeoutMs: 15000,
  cutBotDelayMs: 1500,

  bidHumanTimeoutMs: 15000,
  bidBotDelayMs: 1500,

  playHumanTimeoutMs: 15000,
  playBotDelayMs: 1500,

  summaryVisibleMs: 4000,
} as const

export type TimingConfig = typeof TIMING_CONFIG