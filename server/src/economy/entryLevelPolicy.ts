// Одобрена бизнес политика за входните нива (Етап 2 на общата финансова
// основа) и валидация за БЪДЕЩОТО админ управление.
//
// Модулът е чист — без DB, без HTTP, без портфейли. Засега НЕ е свързан с
// /api/admin/rooms: съществуващият админ интерфейс остава непроменен.
// Записът на комисионата и „деактивиране вместо изтриване“ в админ панела
// изискват миграция/промяна на endpoint-а → Етап 3.
//
// Одобрени ограничения:
//   вход          5 000 … 1 000 000 000, кратен на 100
//   комисиона     10% … 50%, точност 0,01% (= 1 базисна точка)
//
// Техническите граници от entryLevelCatalog.ts (100 … 10^12) остават
// валидни за ЧЕТЕНЕТО: съществуващи (legacy) нива извън бизнес политиката
// не се изхвърлят — само се отбелязват като несъответстващи.

import { MIN_LEVEL_TECHNICAL_MAX } from './entryLevelCatalog.js'

export const ENTRY_LEVEL_POLICY = Object.freeze({
  minEntryFee: 5_000,
  maxEntryFee: 1_000_000_000,
  entryFeeStep: 100,
  /** 10,00% */
  minCommissionBps: 1_000,
  /** 50,00% */
  maxCommissionBps: 5_000,
  /** 0,01% */
  commissionStepBps: 1,
  maxMinLevel: MIN_LEVEL_TECHNICAL_MAX,
})

export type EntryLevelPolicyViolationCode =
  | 'entry-fee-not-integer'
  | 'entry-fee-below-min'
  | 'entry-fee-above-max'
  | 'entry-fee-not-multiple'
  | 'min-level-invalid'
  | 'is-enabled-invalid'
  | 'commission-invalid-format'
  | 'commission-below-min'
  | 'commission-above-max'
  | 'commission-precision'

export type EntryLevelAdminErrorCode =
  | EntryLevelPolicyViolationCode
  | 'entry-fee-already-exists'
  | 'entry-level-not-found'
  | 'entry-fee-immutable'
  | 'last-enabled-level'
  | 'empty-update'

export type EntryLevelAdminError = {
  field: 'entryFee' | 'minLevel' | 'isEnabled' | 'commission' | 'level'
  code: EntryLevelAdminErrorCode
  message: string
}

const fmt = (value: number): string => value.toLocaleString('bg-BG').replace(/ /g, ' ')

/** Проверка на входа спрямо одобрената политика. Празен масив = съответства. */
export function checkEntryFeePolicy(entryFee: unknown): EntryLevelAdminError[] {
  const p = ENTRY_LEVEL_POLICY
  if (typeof entryFee !== 'number' || !Number.isSafeInteger(entryFee)) {
    return [{ field: 'entryFee', code: 'entry-fee-not-integer', message: 'Входът трябва да е цяло число.' }]
  }
  const errors: EntryLevelAdminError[] = []
  if (entryFee < p.minEntryFee) {
    errors.push({ field: 'entryFee', code: 'entry-fee-below-min', message: `Входът трябва да е поне ${fmt(p.minEntryFee)}.` })
  }
  if (entryFee > p.maxEntryFee) {
    errors.push({ field: 'entryFee', code: 'entry-fee-above-max', message: `Входът не може да надвишава ${fmt(p.maxEntryFee)}.` })
  }
  if (entryFee % p.entryFeeStep !== 0) {
    errors.push({ field: 'entryFee', code: 'entry-fee-not-multiple', message: `Входът трябва да е кратен на ${p.entryFeeStep}.` })
  }
  return errors
}

function checkMinLevel(minLevel: unknown): EntryLevelAdminError[] {
  if (typeof minLevel === 'number' && Number.isSafeInteger(minLevel) && minLevel >= 1 && minLevel <= ENTRY_LEVEL_POLICY.maxMinLevel) return []
  return [{ field: 'minLevel', code: 'min-level-invalid', message: `Минималното ниво трябва да е цяло число от 1 до ${ENTRY_LEVEL_POLICY.maxMinLevel}.` }]
}

function checkIsEnabled(isEnabled: unknown): EntryLevelAdminError[] {
  if (typeof isEnabled === 'boolean') return []
  return [{ field: 'isEnabled', code: 'is-enabled-invalid', message: 'Състоянието трябва да е true или false.' }]
}

export type CommissionParseResult =
  | { ok: true; bps: number }
  | { ok: false; error: EntryLevelAdminError }

const COMMISSION_PERCENT_PATTERN = /^(\d{1,3})(?:[.,](\d{1,2}))?$/

/**
 * Комисиона като процент: „12,5“, „12.50“, 12.5 → 1 250 bps.
 * Парсва се текстово (без float аритметика). Повече от 2 знака след
 * десетичния разделител → грешка за точност, а не закръгляне.
 */
export function parseCommissionPercent(input: unknown): CommissionParseResult {
  let text: string
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      return { ok: false, error: { field: 'commission', code: 'commission-invalid-format', message: 'Комисионата трябва да е положително число в проценти.' } }
    }
    text = String(input)
  } else if (typeof input === 'string') {
    text = input.trim()
  } else {
    return { ok: false, error: { field: 'commission', code: 'commission-invalid-format', message: 'Комисионата трябва да е число в проценти.' } }
  }
  if (/^\d{1,3}[.,]\d{3,}$/.test(text)) {
    return { ok: false, error: { field: 'commission', code: 'commission-precision', message: 'Комисионата се задава с точност до 0,01%.' } }
  }
  const match = COMMISSION_PERCENT_PATTERN.exec(text)
  if (!match) {
    return { ok: false, error: { field: 'commission', code: 'commission-invalid-format', message: 'Комисионата трябва да е число в проценти (напр. 20 или 12,50).' } }
  }
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  const rangeErrors = checkCommissionBpsPolicy(bps)
  return rangeErrors.length > 0 ? { ok: false, error: rangeErrors[0]! } : { ok: true, bps }
}

export function checkCommissionBpsPolicy(bps: unknown): EntryLevelAdminError[] {
  const p = ENTRY_LEVEL_POLICY
  if (typeof bps !== 'number' || !Number.isSafeInteger(bps)) {
    return [{ field: 'commission', code: 'commission-precision', message: 'Комисионата се задава с точност до 0,01%.' }]
  }
  if (bps < p.minCommissionBps) {
    return [{ field: 'commission', code: 'commission-below-min', message: `Комисионата трябва да е поне ${formatBpsAsPercent(p.minCommissionBps)}%.` }]
  }
  if (bps > p.maxCommissionBps) {
    return [{ field: 'commission', code: 'commission-above-max', message: `Комисионата не може да надвишава ${formatBpsAsPercent(p.maxCommissionBps)}%.` }]
  }
  return []
}

/** 1 250 → „12,50“ */
export function formatBpsAsPercent(bps: number): string {
  const whole = Math.trunc(bps / 100)
  const frac = String(bps % 100).padStart(2, '0')
  return `${whole},${frac}`
}

/** Минимално описание на съществуващо ниво — от каталога или от match_rooms. */
export type ExistingEntryLevel = { entryFee: number; isEnabled: boolean }

export type ValidatedEntryLevelCreate = {
  entryFee: number
  minLevel: number
  isEnabled: boolean
  /** null = не е зададена; комисионата още НЯМА колона в match_rooms (Етап 3). */
  siteCommissionBps: number | null
}

export type EntryLevelAdminResult<T> = { ok: true; value: T } | { ok: false; errors: EntryLevelAdminError[] }

/** Валидация за ДОБАВЯНЕ на ново ниво. Не пише нищо. */
export function validateEntryLevelCreate(
  draft: { entryFee: unknown; minLevel: unknown; isEnabled?: unknown; commissionPercent?: unknown },
  existing: readonly ExistingEntryLevel[],
): EntryLevelAdminResult<ValidatedEntryLevelCreate> {
  const errors: EntryLevelAdminError[] = [
    ...checkEntryFeePolicy(draft.entryFee),
    ...checkMinLevel(draft.minLevel),
    ...(draft.isEnabled === undefined ? [] : checkIsEnabled(draft.isEnabled)),
  ]
  let siteCommissionBps: number | null = null
  if (draft.commissionPercent !== undefined && draft.commissionPercent !== null) {
    const parsed = parseCommissionPercent(draft.commissionPercent)
    if (parsed.ok) siteCommissionBps = parsed.bps
    else errors.push(parsed.error)
  }
  if (typeof draft.entryFee === 'number' && existing.some((level) => level.entryFee === draft.entryFee)) {
    errors.push({ field: 'entryFee', code: 'entry-fee-already-exists', message: 'Ниво с този вход вече съществува — редактирай го или го активирай.' })
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      entryFee: draft.entryFee as number,
      minLevel: draft.minLevel as number,
      isEnabled: draft.isEnabled === undefined ? true : (draft.isEnabled as boolean),
      siteCommissionBps,
    },
  }
}

export type ValidatedEntryLevelUpdate = {
  entryFee: number
  changes: { minLevel?: number; isEnabled?: boolean; siteCommissionBps?: number }
}

/**
 * Валидация за РЕДАКТИРАНЕ. Входът е идентичността на нивото
 * (stake_amount е PRIMARY KEY и се ползва от опашки/маси) и не се променя —
 * друг вход = ново ниво. Бизнес политиката за входа НЕ се прилага при
 * редакция, за да могат legacy нива да се редактират/деактивират.
 */
export function validateEntryLevelUpdate(
  entryFee: unknown,
  patch: { entryFee?: unknown; minLevel?: unknown; isEnabled?: unknown; commissionPercent?: unknown },
  existing: readonly ExistingEntryLevel[],
): EntryLevelAdminResult<ValidatedEntryLevelUpdate> {
  const current = typeof entryFee === 'number' ? existing.find((level) => level.entryFee === entryFee) : undefined
  if (!current) {
    return { ok: false, errors: [{ field: 'level', code: 'entry-level-not-found', message: 'Нивото не беше намерено.' }] }
  }
  const errors: EntryLevelAdminError[] = []
  const changes: ValidatedEntryLevelUpdate['changes'] = {}
  if (patch.entryFee !== undefined && patch.entryFee !== current.entryFee) {
    errors.push({ field: 'entryFee', code: 'entry-fee-immutable', message: 'Входът на съществуващо ниво не може да се променя — създай ново ниво.' })
  }
  if (patch.minLevel !== undefined) {
    const minLevelErrors = checkMinLevel(patch.minLevel)
    if (minLevelErrors.length > 0) errors.push(...minLevelErrors)
    else changes.minLevel = patch.minLevel as number
  }
  if (patch.isEnabled !== undefined) {
    const enabledErrors = checkIsEnabled(patch.isEnabled)
    if (enabledErrors.length > 0) errors.push(...enabledErrors)
    else {
      changes.isEnabled = patch.isEnabled as boolean
      if (changes.isEnabled === false) errors.push(...lastEnabledGuard(current, existing))
    }
  }
  if (patch.commissionPercent !== undefined) {
    const parsed = parseCommissionPercent(patch.commissionPercent)
    if (parsed.ok) changes.siteCommissionBps = parsed.bps
    else errors.push(parsed.error)
  }
  if (errors.length === 0 && Object.keys(changes).length === 0) {
    errors.push({ field: 'level', code: 'empty-update', message: 'Няма промени за запис.' })
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { entryFee: current.entryFee, changes } }
}

function lastEnabledGuard(current: ExistingEntryLevel, existing: readonly ExistingEntryLevel[]): EntryLevelAdminError[] {
  if (!current.isEnabled) return []
  const othersEnabled = existing.some((level) => level.isEnabled && level.entryFee !== current.entryFee)
  return othersEnabled
    ? []
    : [{ field: 'isEnabled', code: 'last-enabled-level', message: 'Не може да се деактивира последното активно ниво.' }]
}

export type EntryLevelRemovalPlan =
  | { ok: true; action: 'deactivate'; entryFee: number }
  | { ok: true; action: 'none'; entryFee: number; reason: 'already-disabled' }
  | { ok: false; errors: EntryLevelAdminError[] }

/**
 * „Премахване“ на ниво = деактивиране (is_enabled = 0), никога DELETE:
 * историята, опашките и вече създадените маси пазят своя вход.
 * Влиза в действие в админ endpoint-а едва в Етап 3.
 */
export function planEntryLevelRemoval(entryFee: unknown, existing: readonly ExistingEntryLevel[]): EntryLevelRemovalPlan {
  const current = typeof entryFee === 'number' ? existing.find((level) => level.entryFee === entryFee) : undefined
  if (!current) {
    return { ok: false, errors: [{ field: 'level', code: 'entry-level-not-found', message: 'Нивото не беше намерено.' }] }
  }
  if (!current.isEnabled) return { ok: true, action: 'none', entryFee: current.entryFee, reason: 'already-disabled' }
  const guard = lastEnabledGuard(current, existing)
  return guard.length > 0 ? { ok: false, errors: guard } : { ok: true, action: 'deactivate', entryFee: current.entryFee }
}
