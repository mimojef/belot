// Етап 3В.1 — централизирана основа за финансовите условия на игрите
// (входове, комисиони, награди) + неизменими условия на конкретен мач.
//
// Чист модул: без DB, HTTP, портфейли или ledger-и. НЕ е свързан с
// действащите Белот / „Не се сърди човече“ / турнири и НЕ активира платена
// „Свара“ — само основа за следващите етапи.
//
// Преизползва:
//   - entryLevelPolicy.ts — одобрените граници (вход 5 000…1 000 000 000,
//     кратно на 100; комисиона 1 000…5 000 bps = 10%…50%, стъпка 1 bps = 0,01 п.п.);
//   - prizeFormula.ts — същото правило за закръгляне (до най-близките 100,
//     половината нагоре) и „комисиона = фонд − реално изплатено“.
//
// Аритметика: само цели числа през BigInt — без floating-point.

import { checkCommissionBpsPolicy, checkEntryFeePolicy } from './entryLevelPolicy.js'
import { BASIS_POINTS_SCALE, MAX_SAFE_FINANCIAL_AMOUNT, PRIZE_ROUNDING_UNIT } from './prizeFormula.js'
import { SVARA_TEST_ENTRY_FEES } from '../games/svara/svaraTableCreationOptions.js'

export type FinancialGameKey = 'belot' | 'ludo' | 'svara'

export const MAX_PRIZE_POSITIONS = 100
/** Техническа граница за праг на схема (не е продуктово ограничение на масите). */
export const MAX_SCHEME_PARTICIPANTS = 10_000
export const MAX_CONFIGURED_ENTRY_FEES = 500

/** Дял на позиция в базисни точки от наградния фонд (сума 10 000 = 100%). */
export type PrizeScheme = {
  /** Схемата важи при брой платени участници ≥ minParticipants (най-високият приложим праг печели). */
  minParticipants: number
  /** sharesBps[i] — дял на позиция i+1; положителни, ненарастващи, сума 10 000, до 100 позиции. */
  sharesBps: readonly number[]
}

export type GameFinancialConfig = {
  gameKey: FinancialGameKey
  /** Версия на конфигурацията — записва се в условията на всеки мач. */
  configVersion: string
  /** Разрешените входове (изрично изброени, не всички възможни стойности). */
  entryFees: readonly number[]
  defaultCommissionBps: number
  /** Комисиона по вход (ключ — входът като низ, за JSON). */
  commissionBpsByEntryFee: Readonly<Record<string, number>>
  prizeSchemes: readonly PrizeScheme[]
  /**
   * Етап 4В: изключени входове (подмножество на entryFees). Остават в
   * конфигурацията (с комисионата си) — нови маси с тях не се създават.
   * Липсващо в по-стар запис = няма изключени.
   */
  disabledEntryFees: readonly number[]
}

/** Входовете, с които може да се създаде НОВА маса. */
export function activeEntryFees(config: GameFinancialConfig): number[] {
  const disabled = new Set(config.disabledEntryFees)
  return config.entryFees.filter((fee) => !disabled.has(fee))
}

export type FinancialConfigError = { path: string; code: string; message: string }

export type ValidateConfigResult =
  | { ok: true; config: GameFinancialConfig }
  | { ok: false; errors: FinancialConfigError[] }

const GAME_KEYS: readonly FinancialGameKey[] = ['belot', 'ludo', 'svara']

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

/** Валидация на схема за награди (ползва се и от конфигурацията, и от условията на мача). */
export function validatePrizeScheme(scheme: unknown, path = 'prizeScheme'): FinancialConfigError[] {
  const errors: FinancialConfigError[] = []
  if (typeof scheme !== 'object' || scheme === null) return [{ path, code: 'invalid', message: 'Схемата трябва да е обект.' }]
  const { minParticipants, sharesBps } = scheme as Partial<PrizeScheme>
  if (!isSafeInt(minParticipants) || minParticipants < 2 || minParticipants > MAX_SCHEME_PARTICIPANTS) {
    errors.push({ path: `${path}.minParticipants`, code: 'invalid-min-participants', message: `Прагът трябва да е цяло число от 2 до ${MAX_SCHEME_PARTICIPANTS}.` })
  }
  if (!Array.isArray(sharesBps) || sharesBps.length === 0 || sharesBps.length > MAX_PRIZE_POSITIONS) {
    errors.push({ path: `${path}.sharesBps`, code: 'invalid-positions', message: `Наградните позиции трябва да са от 1 до ${MAX_PRIZE_POSITIONS}.` })
    return errors
  }
  let sum = 0
  for (let i = 0; i < sharesBps.length; i += 1) {
    const share = sharesBps[i]
    if (!isSafeInt(share) || share <= 0 || share > BASIS_POINTS_SCALE) {
      errors.push({ path: `${path}.sharesBps[${i}]`, code: 'invalid-share', message: 'Делът трябва да е цяло положително число базисни точки.' })
      continue
    }
    if (i > 0 && isSafeInt(sharesBps[i - 1]) && share > (sharesBps[i - 1] as number)) {
      errors.push({ path: `${path}.sharesBps[${i}]`, code: 'shares-increasing', message: 'По-ниска позиция не може да получава по-голям дял от по-висока.' })
    }
    sum += share
  }
  if (sum !== BASIS_POINTS_SCALE) {
    errors.push({ path: `${path}.sharesBps`, code: 'shares-sum', message: `Сумата на дяловете трябва да е ${BASIS_POINTS_SCALE} (100%), а е ${sum}.` })
  }
  if (isSafeInt(minParticipants) && sharesBps.length > minParticipants) {
    errors.push({ path: `${path}.sharesBps`, code: 'positions-exceed-participants', message: 'Наградните позиции не може да са повече от минималния брой участници.' })
  }
  return errors
}

/** Валидира и нормализира (сортирани входове и схеми, замразен обект). Никога не „поправя“ мълчаливо. */
export function validateGameFinancialConfig(input: unknown): ValidateConfigResult {
  const errors: FinancialConfigError[] = []
  if (typeof input !== 'object' || input === null) return { ok: false, errors: [{ path: '', code: 'invalid', message: 'Конфигурацията трябва да е обект.' }] }
  const raw = input as Partial<GameFinancialConfig>

  if (!GAME_KEYS.includes(raw.gameKey as FinancialGameKey)) errors.push({ path: 'gameKey', code: 'invalid-game', message: 'Непозната игра.' })
  if (typeof raw.configVersion !== 'string' || raw.configVersion.trim() === '' || raw.configVersion.length > 100) {
    errors.push({ path: 'configVersion', code: 'invalid-version', message: 'Версията е задължителна (до 100 знака).' })
  }

  const entryFees: number[] = []
  if (!Array.isArray(raw.entryFees) || raw.entryFees.length === 0 || raw.entryFees.length > MAX_CONFIGURED_ENTRY_FEES) {
    errors.push({ path: 'entryFees', code: 'invalid-entry-fees', message: `Нужни са от 1 до ${MAX_CONFIGURED_ENTRY_FEES} разрешени входа.` })
  } else {
    const seen = new Set<number>()
    raw.entryFees.forEach((fee, i) => {
      for (const error of checkEntryFeePolicy(fee)) errors.push({ path: `entryFees[${i}]`, code: error.code, message: error.message })
      if (isSafeInt(fee)) {
        if (seen.has(fee)) errors.push({ path: `entryFees[${i}]`, code: 'duplicate-entry-fee', message: 'Дублиран вход.' })
        seen.add(fee)
        entryFees.push(fee)
      }
    })
  }

  for (const error of checkCommissionBpsPolicy(raw.defaultCommissionBps)) errors.push({ path: 'defaultCommissionBps', code: error.code, message: error.message })

  const overrides: Record<string, number> = {}
  if (raw.commissionBpsByEntryFee !== undefined) {
    if (typeof raw.commissionBpsByEntryFee !== 'object' || raw.commissionBpsByEntryFee === null || Array.isArray(raw.commissionBpsByEntryFee)) {
      errors.push({ path: 'commissionBpsByEntryFee', code: 'invalid', message: 'Комисионите по вход трябва да са обект.' })
    } else {
      for (const [key, bps] of Object.entries(raw.commissionBpsByEntryFee)) {
        const fee = Number(key)
        if (!/^\d+$/.test(key) || !entryFees.includes(fee)) {
          errors.push({ path: `commissionBpsByEntryFee.${key}`, code: 'unknown-entry-fee', message: 'Комисиона за вход, който не е разрешен.' })
          continue
        }
        for (const error of checkCommissionBpsPolicy(bps)) errors.push({ path: `commissionBpsByEntryFee.${key}`, code: error.code, message: error.message })
        overrides[String(fee)] = bps as number
      }
    }
  }

  const disabled: number[] = []
  if (raw.disabledEntryFees !== undefined) {
    if (!Array.isArray(raw.disabledEntryFees)) {
      errors.push({ path: 'disabledEntryFees', code: 'invalid', message: 'Изключените входове трябва да са списък.' })
    } else {
      raw.disabledEntryFees.forEach((fee, i) => {
        if (!isSafeInt(fee) || !entryFees.includes(fee)) errors.push({ path: `disabledEntryFees[${i}]`, code: 'unknown-entry-fee', message: 'Изключен вход, който не е в списъка с входове.' })
        else if (disabled.includes(fee)) errors.push({ path: `disabledEntryFees[${i}]`, code: 'duplicate-entry-fee', message: 'Дублиран изключен вход.' })
        else disabled.push(fee)
      })
    }
  }

  const schemes: PrizeScheme[] = []
  if (!Array.isArray(raw.prizeSchemes) || raw.prizeSchemes.length === 0) {
    errors.push({ path: 'prizeSchemes', code: 'invalid-schemes', message: 'Нужна е поне една схема за награди.' })
  } else {
    const thresholds = new Set<number>()
    raw.prizeSchemes.forEach((scheme, i) => {
      const schemeErrors = validatePrizeScheme(scheme, `prizeSchemes[${i}]`)
      errors.push(...schemeErrors)
      if (schemeErrors.length === 0) {
        const threshold = (scheme as PrizeScheme).minParticipants
        if (thresholds.has(threshold)) errors.push({ path: `prizeSchemes[${i}].minParticipants`, code: 'duplicate-threshold', message: 'Дублиран праг.' })
        thresholds.add(threshold)
        schemes.push({ minParticipants: threshold, sharesBps: [...(scheme as PrizeScheme).sharesBps] })
      }
    })
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    config: deepFreeze({
      gameKey: raw.gameKey as FinancialGameKey,
      configVersion: (raw.configVersion as string).trim(),
      entryFees: [...entryFees].sort((a, b) => a - b),
      defaultCommissionBps: raw.defaultCommissionBps as number,
      commissionBpsByEntryFee: overrides,
      prizeSchemes: schemes.sort((a, b) => a.minParticipants - b.minParticipants),
      disabledEntryFees: [...disabled].sort((a, b) => a - b),
    }),
  }
}

export function resolveCommissionBps(config: GameFinancialConfig, entryFee: number): number {
  return config.commissionBpsByEntryFee[String(entryFee)] ?? config.defaultCommissionBps
}

/** Схемата с най-високия праг ≤ participants; null — няма приложима. */
export function selectPrizeScheme(config: GameFinancialConfig, participants: number): PrizeScheme | null {
  let selected: PrizeScheme | null = null
  for (const scheme of config.prizeSchemes) if (scheme.minParticipants <= participants) selected = scheme
  return selected
}

// ─── Точни изчисления ─────────────────────────────────────────────────────

export type PositionPrizesInput = { entryFee: number; paidEntries: number; commissionBps: number; sharesBps: readonly number[] }

export type PositionPrizes = {
  pot: number
  /** prizes[i] — наградата за позиция i+1 (закръглена до 100, половината нагоре). */
  prizes: number[]
  totalPrize: number
  /** Реална комисиона = фонд − всички реално изплатени награди. */
  siteCommission: number
}

export type PositionPrizesErrorCode =
  | 'invalid-entry-fee'
  | 'invalid-paid-entries'
  | 'invalid-commission'
  | 'invalid-scheme'
  | 'positions-exceed-paid-entries'
  | 'pot-exceeds-safe-range'
  | 'prize-rounds-to-zero'
  | 'prizes-exceed-pot'

export type PositionPrizesResult = { ok: true; value: PositionPrizes } | { ok: false; code: PositionPrizesErrorCode; message: string }

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator)
}

/**
 * награда(i) = закръглена до 100 от  фонд × (100% − комисиона) × дял(i)
 * Всичко в BigInt. Резултат, който не може да се изплати безопасно
 * (позиция 0, сума над фонда), е грешка — никога тихо коригиране.
 */
export function computePositionPrizes(input: PositionPrizesInput): PositionPrizesResult {
  const { entryFee, paidEntries, commissionBps, sharesBps } = input
  if (!isSafeInt(entryFee) || entryFee <= 0) return { ok: false, code: 'invalid-entry-fee', message: 'Невалиден вход.' }
  if (!isSafeInt(paidEntries) || paidEntries < 1) return { ok: false, code: 'invalid-paid-entries', message: 'Невалиден брой платени входове.' }
  if (!isSafeInt(commissionBps) || commissionBps < 0 || commissionBps >= BASIS_POINTS_SCALE) return { ok: false, code: 'invalid-commission', message: 'Невалидна комисиона.' }
  if (!Array.isArray(sharesBps) || sharesBps.length === 0 || sharesBps.length > MAX_PRIZE_POSITIONS
    || sharesBps.some((s) => !isSafeInt(s) || s <= 0) || sharesBps.reduce((a, b) => a + b, 0) !== BASIS_POINTS_SCALE) {
    return { ok: false, code: 'invalid-scheme', message: 'Невалидна схема за награди.' }
  }
  if (sharesBps.length > paidEntries) return { ok: false, code: 'positions-exceed-paid-entries', message: 'Наградните позиции са повече от участниците.' }

  const potBig = BigInt(entryFee) * BigInt(paidEntries)
  if (potBig > BigInt(MAX_SAFE_FINANCIAL_AMOUNT)) return { ok: false, code: 'pot-exceeds-safe-range', message: 'Фондът е извън безопасния диапазон.' }

  const scale = BigInt(BASIS_POINTS_SCALE)
  const unit = BigInt(PRIZE_ROUNDING_UNIT)
  const keep = scale - BigInt(commissionBps)
  const prizes: bigint[] = sharesBps.map((share) => roundHalfUp(potBig * keep * BigInt(share), scale * scale * unit) * unit)
  if (prizes.some((p) => p === 0n)) return { ok: false, code: 'prize-rounds-to-zero', message: 'Награда за позиция се закръглява до 0.' }
  const total = prizes.reduce((a, b) => a + b, 0n)
  if (total > potBig) return { ok: false, code: 'prizes-exceed-pot', message: 'Закръглените награди надхвърлят фонда.' }

  return {
    ok: true,
    value: { pot: Number(potBig), prizes: prizes.map(Number), totalPrize: Number(total), siteCommission: Number(potBig - total) },
  }
}

// ─── Неизменими условия на конкретен мач ──────────────────────────────────

export const GAME_MATCH_TERMS_VERSION = 'game-match-terms-v1' as const

export type GameMatchFinancialTerms = {
  termsVersion: typeof GAME_MATCH_TERMS_VERSION
  gameKey: FinancialGameKey
  configVersion: string
  entryFee: number
  paidEntries: number
  commissionBps: number
  prizeSchemeMinParticipants: number
  sharesBps: readonly number[]
  pot: number
  prizes: readonly number[]
  totalPrize: number
  siteCommission: number
  pinnedAt: number
}

export type PinTermsResult =
  | { ok: true; terms: GameMatchFinancialTerms }
  | { ok: false; code: 'entry-fee-not-allowed' | 'no-prize-scheme' | PositionPrizesErrorCode; message: string }

/**
 * Фиксира условията при започване на платения мач. Резултатът е дълбоко
 * копие + замразен — по-късна промяна на конфигурацията не го засяга.
 */
export function pinGameMatchFinancialTerms(
  config: GameFinancialConfig,
  input: { entryFee: number; paidEntries: number; pinnedAt?: number },
): PinTermsResult {
  if (!config.entryFees.includes(input.entryFee)) return { ok: false, code: 'entry-fee-not-allowed', message: 'Входът не е разрешен за тази игра.' }
  const scheme = selectPrizeScheme(config, input.paidEntries)
  if (scheme === null) return { ok: false, code: 'no-prize-scheme', message: 'Няма схема за награди за този брой участници.' }
  const commissionBps = resolveCommissionBps(config, input.entryFee)
  const result = computePositionPrizes({ entryFee: input.entryFee, paidEntries: input.paidEntries, commissionBps, sharesBps: scheme.sharesBps })
  if (!result.ok) return result
  return {
    ok: true,
    terms: deepFreeze({
      termsVersion: GAME_MATCH_TERMS_VERSION,
      gameKey: config.gameKey,
      configVersion: config.configVersion,
      entryFee: input.entryFee,
      paidEntries: input.paidEntries,
      commissionBps,
      prizeSchemeMinParticipants: scheme.minParticipants,
      sharesBps: [...scheme.sharesBps],
      pot: result.value.pot,
      prizes: [...result.value.prizes],
      totalPrize: result.value.totalPrize,
      siteCommission: result.value.siteCommission,
      pinnedAt: input.pinnedAt ?? Date.now(),
    }),
  }
}

/**
 * Проверка на записани условия (напр. след JSON/рестарт): структура + политика
 * + ПРЕИЗЧИСЛЕНИЕ. Несъответствие → невалидни (изплащане по тях не е допустимо).
 */
export function validateGameMatchFinancialTerms(value: unknown): { ok: true; terms: GameMatchFinancialTerms } | { ok: false; message: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, message: 'Условията не са обект.' }
  const t = value as Partial<GameMatchFinancialTerms>
  if (t.termsVersion !== GAME_MATCH_TERMS_VERSION) return { ok: false, message: 'Непозната версия на условията.' }
  if (!GAME_KEYS.includes(t.gameKey as FinancialGameKey)) return { ok: false, message: 'Непозната игра.' }
  if (typeof t.configVersion !== 'string' || t.configVersion.trim() === '') return { ok: false, message: 'Липсва версия на конфигурацията.' }
  if (checkEntryFeePolicy(t.entryFee).length > 0) return { ok: false, message: 'Входът е извън политиката.' }
  if (checkCommissionBpsPolicy(t.commissionBps).length > 0) return { ok: false, message: 'Комисионата е извън политиката.' }
  if (!isSafeInt(t.pinnedAt) || (t.pinnedAt as number) <= 0) return { ok: false, message: 'Невалидно време на фиксиране.' }
  if (validatePrizeScheme({ minParticipants: t.prizeSchemeMinParticipants, sharesBps: t.sharesBps }).length > 0) return { ok: false, message: 'Невалидна схема.' }
  if (!isSafeInt(t.paidEntries) || (t.paidEntries as number) < (t.prizeSchemeMinParticipants as number)) return { ok: false, message: 'Участниците не отговарят на схемата.' }
  const recomputed = computePositionPrizes({ entryFee: t.entryFee as number, paidEntries: t.paidEntries as number, commissionBps: t.commissionBps as number, sharesBps: t.sharesBps as number[] })
  if (!recomputed.ok) return { ok: false, message: recomputed.message }
  const r = recomputed.value
  const same = r.pot === t.pot && r.totalPrize === t.totalPrize && r.siteCommission === t.siteCommission
    && Array.isArray(t.prizes) && t.prizes.length === r.prizes.length && t.prizes.every((p, i) => p === r.prizes[i])
  if (!same) return { ok: false, message: 'Записаните суми не съвпадат с преизчислението.' }
  return { ok: true, terms: t as GameMatchFinancialTerms }
}

// ─── Начална конфигурация за „Свара“ (не е активирана за реални жълтици) ──

/**
 * 13-те вече одобрени входа (5 000–200 000), 20% комисиона за сайта, 80% за
 * единствения победител. Източникът на входовете е същият списък, който
 * ползва формата „Създай игра“ — без дублиране.
 */
export const SVARA_DEFAULT_FINANCIAL_CONFIG: GameFinancialConfig = (() => {
  const result = validateGameFinancialConfig({
    gameKey: 'svara',
    configVersion: 'svara-default-v1',
    entryFees: [...SVARA_TEST_ENTRY_FEES],
    defaultCommissionBps: 2_000,
    commissionBpsByEntryFee: {},
    prizeSchemes: [{ minParticipants: 2, sharesBps: [10_000] }],
  })
  if (!result.ok) throw new Error(`Невалидна начална конфигурация за Свара: ${JSON.stringify(result.errors)}`)
  return result.config
})()
