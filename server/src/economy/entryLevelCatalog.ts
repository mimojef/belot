// Общ каталог на входните нива (Етап 1 на общата финансова основа).
// Чете САМО колоните stake_amount / min_level / is_enabled от match_rooms —
// prize_amount умишлено НЕ се чете: наградите идват от prizeFormula.ts.
// Засега модулът НЕ е свързан с действащите игри, админ панела или
// изплащанията; не пише в базата.
//
// Комисиона за всяко ниво: DB схемата засега няма колона за нея, затова
// индивидуалната комисиона се подава като override (entryFee -> bps) от
// извикващия; без override важи DEFAULT_SITE_COMMISSION_BPS (20%).
//
// Fail-closed: ред с невалидни данни (или дублиран вход) НЕ влиза в каталога
// и се докладва в `issues` — никога не се „поправя“ мълчаливо.

import {
  computePrizeBreakdown,
  DEFAULT_SITE_COMMISSION_BPS,
  isValidSiteCommissionBps,
  MAX_SITE_COMMISSION_BPS,
  type PrizeBreakdown,
  type PrizeFormulaErrorCode,
} from './prizeFormula.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

/** Технически минимум — под него наградата не може да се закръгли смислено до 100. */
export const ENTRY_FEE_TECHNICAL_MIN = 100
/**
 * Техническа горна граница на входа (10^12). Дори 64 платени входа остават
 * далеч под Number.MAX_SAFE_INTEGER. Бизнес таванът е решение на собственика.
 */
export const ENTRY_FEE_TECHNICAL_MAX = 1_000_000_000_000
export const MIN_LEVEL_TECHNICAL_MAX = 1_000

export type EntryLevel = {
  entryFee: number
  minLevel: number
  isEnabled: boolean
  siteCommissionBps: number
  commissionSource: 'default' | 'override'
}

export type EntryLevelRow = {
  stake_amount: unknown
  min_level: unknown
  is_enabled: unknown
}

export type EntryLevelIssueCode =
  | 'invalid-entry-fee'
  | 'invalid-min-level'
  | 'invalid-enabled-flag'
  | 'duplicate-entry-fee'
  | 'invalid-commission-override'
  | 'unknown-commission-override'

export type EntryLevelIssue = { entryFee: unknown; code: EntryLevelIssueCode; message: string }

export type EntryLevelValidationError = { field: 'entryFee' | 'minLevel' | 'siteCommissionBps'; message: string }

/** Валидация на едно ниво — за бъдещото админ управление и за четенето от DB. */
export function validateEntryLevelInput(input: { entryFee: unknown; minLevel: unknown; siteCommissionBps?: unknown }): EntryLevelValidationError[] {
  const errors: EntryLevelValidationError[] = []
  const { entryFee, minLevel, siteCommissionBps } = input
  if (typeof entryFee !== 'number' || !Number.isSafeInteger(entryFee) || entryFee < ENTRY_FEE_TECHNICAL_MIN || entryFee > ENTRY_FEE_TECHNICAL_MAX) {
    errors.push({ field: 'entryFee', message: `Входът трябва да е цяло число от ${ENTRY_FEE_TECHNICAL_MIN} до ${ENTRY_FEE_TECHNICAL_MAX}.` })
  }
  if (typeof minLevel !== 'number' || !Number.isSafeInteger(minLevel) || minLevel < 1 || minLevel > MIN_LEVEL_TECHNICAL_MAX) {
    errors.push({ field: 'minLevel', message: `Минималното ниво трябва да е цяло число от 1 до ${MIN_LEVEL_TECHNICAL_MAX}.` })
  }
  if (siteCommissionBps !== undefined && !isValidSiteCommissionBps(siteCommissionBps)) {
    errors.push({ field: 'siteCommissionBps', message: `Комисионата трябва да е цяло число базисни точки от 0 до ${MAX_SITE_COMMISSION_BPS}.` })
  }
  return errors
}

/** Формат на игра за преглед на наградите (не е игрово правило — само описание за изчислението). */
export type GamePrizeFormat = {
  gameKey: string
  label: string
  paidEntries: number
  winners: number
  /** Изискване на играта към входа (напр. Свара: начални чипове = вход ÷ 10). */
  requiredEntryFeeMultiple?: number
}

/**
 * Описания за преглед. Белот: 4 платени входа, 2 победители (отбор) —
 * основата на фонда (номинални 4 или реално платили) е отворено решение.
 */
export const GAME_PRIZE_FORMATS: readonly GamePrizeFormat[] = [
  { gameKey: 'belot', label: 'Белот (4 играчи, 2 победители)', paidEntries: 4, winners: 2 },
  { gameKey: 'svara', label: 'Свара — 2 играчи', paidEntries: 2, winners: 1, requiredEntryFeeMultiple: 10 },
  { gameKey: 'svara', label: 'Свара — 3 играчи', paidEntries: 3, winners: 1, requiredEntryFeeMultiple: 10 },
  { gameKey: 'svara', label: 'Свара — 4 играчи', paidEntries: 4, winners: 1, requiredEntryFeeMultiple: 10 },
  { gameKey: 'ludo', label: 'Не се сърди човече — 2 играчи', paidEntries: 2, winners: 1 },
  { gameKey: 'ludo', label: 'Не се сърди човече — 4 играчи', paidEntries: 4, winners: 1 },
]

export type PrizePreview =
  | { format: GamePrizeFormat; status: 'ok'; breakdown: PrizeBreakdown }
  | { format: GamePrizeFormat; status: 'incompatible'; reason: 'entry-fee-multiple'; message: string }
  | { format: GamePrizeFormat; status: 'error'; code: PrizeFormulaErrorCode; message: string }

export type EntryLevelCatalog = {
  /** Всички валидни нива (активни и изключени), подредени по вход. */
  levels: readonly EntryLevel[]
  /** Само активните нива, подредени по вход. */
  enabledLevels: readonly EntryLevel[]
  issues: readonly EntryLevelIssue[]
  getLevel: (entryFee: number) => EntryLevel | null
  isEnabled: (entryFee: number) => boolean
  previewPrizes: (entryFee: number, formats?: readonly GamePrizeFormat[]) => PrizePreview[] | null
}

export type EntryLevelCatalogOptions = {
  defaultSiteCommissionBps?: number
  commissionBpsByEntryFee?: ReadonlyMap<number, number>
}

export function buildEntryLevelCatalog(rows: readonly EntryLevelRow[], options: EntryLevelCatalogOptions = {}): EntryLevelCatalog {
  const defaultBps = options.defaultSiteCommissionBps ?? DEFAULT_SITE_COMMISSION_BPS
  if (!isValidSiteCommissionBps(defaultBps)) {
    throw new Error(`Невалидна комисиона по подразбиране: ${String(defaultBps)}`)
  }
  const overrides = options.commissionBpsByEntryFee ?? new Map<number, number>()
  const issues: EntryLevelIssue[] = []

  const counts = new Map<unknown, number>()
  for (const row of rows) counts.set(row.stake_amount, (counts.get(row.stake_amount) ?? 0) + 1)

  const levels: EntryLevel[] = []
  for (const row of rows) {
    const entryFee = row.stake_amount
    if ((counts.get(entryFee) ?? 0) > 1) {
      issues.push({ entryFee, code: 'duplicate-entry-fee', message: 'Дублиран вход — нивото е изключено от каталога.' })
      continue
    }
    const errors = validateEntryLevelInput({ entryFee, minLevel: row.min_level })
    if (errors.length > 0) {
      for (const error of errors) {
        issues.push({ entryFee, code: error.field === 'entryFee' ? 'invalid-entry-fee' : 'invalid-min-level', message: error.message })
      }
      continue
    }
    if (row.is_enabled !== 0 && row.is_enabled !== 1) {
      issues.push({ entryFee, code: 'invalid-enabled-flag', message: 'is_enabled трябва да е 0 или 1.' })
      continue
    }
    const fee = entryFee as number
    const override = overrides.get(fee)
    if (override !== undefined && !isValidSiteCommissionBps(override)) {
      issues.push({ entryFee, code: 'invalid-commission-override', message: 'Невалидна индивидуална комисиона — нивото е изключено от каталога.' })
      continue
    }
    levels.push({
      entryFee: fee,
      minLevel: row.min_level as number,
      isEnabled: row.is_enabled === 1,
      siteCommissionBps: override ?? defaultBps,
      commissionSource: override === undefined ? 'default' : 'override',
    })
  }

  const known = new Set(levels.map((level) => level.entryFee))
  for (const fee of overrides.keys()) {
    if (!known.has(fee) && !issues.some((issue) => issue.entryFee === fee)) {
      issues.push({ entryFee: fee, code: 'unknown-commission-override', message: 'Комисиона за несъществуващо ниво.' })
    }
  }

  levels.sort((a, b) => a.entryFee - b.entryFee)
  const enabledLevels = levels.filter((level) => level.isEnabled)
  const byFee = new Map(levels.map((level) => [level.entryFee, level]))

  function previewPrizes(entryFee: number, formats: readonly GamePrizeFormat[] = GAME_PRIZE_FORMATS): PrizePreview[] | null {
    const level = byFee.get(entryFee)
    if (!level) return null
    return formats.map((format): PrizePreview => {
      if (format.requiredEntryFeeMultiple !== undefined && level.entryFee % format.requiredEntryFeeMultiple !== 0) {
        return { format, status: 'incompatible', reason: 'entry-fee-multiple', message: `Входът трябва да е кратен на ${format.requiredEntryFeeMultiple}.` }
      }
      const result = computePrizeBreakdown({
        entryFee: level.entryFee,
        paidEntries: format.paidEntries,
        winners: format.winners,
        siteCommissionBps: level.siteCommissionBps,
      })
      return result.ok
        ? { format, status: 'ok', breakdown: result.breakdown }
        : { format, status: 'error', code: result.code, message: result.message }
    })
  }

  return {
    levels,
    enabledLevels,
    issues,
    getLevel: (entryFee) => byFee.get(entryFee) ?? null,
    isEnabled: (entryFee) => byFee.get(entryFee)?.isEnabled === true,
    previewPrizes,
  }
}

/** Само четене от match_rooms. prize_amount НЕ се чете. */
export function readEntryLevelRowsFromMatchRooms(database: SqliteDatabase): EntryLevelRow[] {
  return database.prepare(
    'SELECT stake_amount, min_level, is_enabled FROM match_rooms ORDER BY stake_amount ASC',
  ).all() as EntryLevelRow[]
}
