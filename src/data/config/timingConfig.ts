export const TIMING_CONFIG = {
  cutHumanTimeoutMs: 20000,
  cutBotDelayMs: 800,

  bidHumanTimeoutMs: 20000,
  bidBotDelayMs: 800,

  playHumanTimeoutMs: 20000,
  playBotDelayMs: 800,

  summaryVisibleMs: 5000,
} as const

export type TimingConfig = typeof TIMING_CONFIG
