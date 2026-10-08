/**
 * humanTurnTimeoutOptions.ts
 *
 * "Време за реакция" — единственият canonical whitelist за човешкия timeout
 * (cutting/bidding/playing) преди поемане от бот. Ползва се от сървъра
 * (parseClientMessage validation + serverTimerStateHelpers) И от frontend-а
 * (формата за частна маса + клиентския countdown), за да не се разминат два
 * ръчно поддържани списъка. Живее в server/src/shared/ по същата причина като
 * bundlePackageVisualKeys.ts (server rootDir boundary) — без runtime imports.
 */

export const HUMAN_TURN_TIMEOUT_OPTIONS_MS = [5000, 10000, 15000] as const

export type HumanTurnTimeoutMs = (typeof HUMAN_TURN_TIMEOUT_OPTIONS_MS)[number]

// Стандартното време за реакция (случайни маси, турнири, guest trial и
// частни маси без изричен избор). Сървърът държи и собствено копие в
// SERVER_TIMING_CONFIG (*HumanTimeoutMs) — то остава authoritative за
// таймерите без override.
export const DEFAULT_HUMAN_TURN_TIMEOUT_MS: HumanTurnTimeoutMs = 15000

export function isHumanTurnTimeoutMs(value: unknown): value is HumanTurnTimeoutMs {
  return (
    typeof value === 'number' &&
    (HUMAN_TURN_TIMEOUT_OPTIONS_MS as readonly number[]).includes(value)
  )
}
