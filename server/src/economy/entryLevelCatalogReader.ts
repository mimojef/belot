// Общ интерфейс за четене на входните нива (Етап 2 на общата финансова
// основа) + информационния блок `entryCatalog` в GET /api/rooms.
//
// Източник: match_rooms, чрез кеша на matchRoomsStore (без втора връзка към
// базата и без запис). prize_amount НЕ участва — действащите изплащания на
// Белот продължават да идват от setMatchPrizeResolver(prize_amount).
//
// Наградите в `entryCatalog` са САМО ПРИМЕРНИ: индивидуална комисиона още не
// се съхранява в match_rooms, затова се ползва допускане от 20%, обозначено
// изрично като `assumed`, а `configuredCommissionBps` е null.

import {
  buildEntryLevelCatalog,
  GAME_PRIZE_FORMATS,
  type EntryLevel,
  type EntryLevelCatalog,
  type EntryLevelRow,
} from './entryLevelCatalog.js'
import { checkEntryFeePolicy, ENTRY_LEVEL_POLICY, type EntryLevelPolicyViolationCode } from './entryLevelPolicy.js'

/** Минималният договор към matchRoomsStore — само четене. */
export type MatchRoomsReadSource = {
  listRooms: () => readonly { stakeAmount: number; minLevel: number; isEnabled: boolean }[]
}

export type EntryLevelCatalogReader = {
  /** Пълният каталог (активни + изключени + issues). */
  getCatalog: () => EntryLevelCatalog
  /** Само активните нива, подредени по вход. */
  getActiveLevels: () => readonly EntryLevel[]
  /** Активно ниво по вход или null (изключено/несъществуващо/невалидно). */
  getActiveLevel: (entryFee: number) => EntryLevel | null
}

function toRows(rooms: readonly { stakeAmount: number; minLevel: number; isEnabled: boolean }[]): EntryLevelRow[] {
  return rooms.map((room) => ({
    stake_amount: room.stakeAmount,
    min_level: room.minLevel,
    is_enabled: room.isEnabled === true ? 1 : room.isEnabled === false ? 0 : room.isEnabled,
  }))
}

/**
 * Каталогът се преизчислява само когато matchRoomsStore подмени кеша си
 * (listRooms() връща нов масив след всеки запис/reload).
 */
export function createEntryLevelCatalogReader(source: MatchRoomsReadSource): EntryLevelCatalogReader {
  let cachedFor: unknown = null
  let cached: EntryLevelCatalog | null = null

  function getCatalog(): EntryLevelCatalog {
    const rooms = source.listRooms()
    if (cached === null || cachedFor !== rooms) {
      cached = buildEntryLevelCatalog(toRows(rooms))
      cachedFor = rooms
    }
    return cached
  }

  return {
    getCatalog,
    getActiveLevels: () => getCatalog().enabledLevels,
    getActiveLevel: (entryFee) => {
      const level = getCatalog().getLevel(entryFee)
      return level?.isEnabled ? level : null
    },
  }
}

// ─── Публичен информационен payload за GET /api/rooms ────────────────────

export const PUBLIC_ENTRY_CATALOG_VERSION = 1

export type PublicEntryPrizePreviewItem =
  | {
      gameKey: string
      label: string
      paidEntries: number
      winners: number
      status: 'ok'
      pot: number
      prizePerWinner: number
      totalPrize: number
      siteCommission: number
    }
  | { gameKey: string; label: string; paidEntries: number; winners: number; status: 'unavailable'; reason: string }

export type PublicEntryLevel = {
  entryFee: number
  minLevel: number
  /** Съответства ли на одобрената политика (5 000 … 1 000 000 000, кратно на 100). Legacy нива остават, само се отбелязват. */
  policyCompliant: boolean
  policyViolations: EntryLevelPolicyViolationCode[]
  /** Реално зададена комисиона от администратора — null, докато няма такава конфигурация. */
  configuredCommissionBps: null
  prizePreview: {
    /** Винаги true в Етап 2 — НЕ са действащите изплащания. */
    illustrative: true
    commissionBasis: 'assumed-default'
    assumedCommissionBps: number
    items: PublicEntryPrizePreviewItem[]
  }
}

export type PublicEntryCatalogPayload = {
  version: typeof PUBLIC_ENTRY_CATALOG_VERSION
  source: 'match_rooms'
  /** Информационно — действащите изплащания идват от rooms[].prizeAmount. */
  informationalOnly: true
  commissionConfigured: false
  policy: {
    minEntryFee: number
    maxEntryFee: number
    entryFeeStep: number
    minCommissionBps: number
    maxCommissionBps: number
    commissionStepBps: number
  }
  /** Само активните нива. */
  levels: PublicEntryLevel[]
  /** Брой редове от match_rooms, които не влизат в каталога (невалидни данни). */
  excludedRowCount: number
  notice: string
}

const ILLUSTRATIVE_NOTICE =
  'Примерни награди при допусната комисиона 20%. Индивидуалната комисиона още не е конфигурирана; действащите изплащания не се променят.'

export function buildPublicEntryCatalogPayload(catalog: EntryLevelCatalog): PublicEntryCatalogPayload {
  const levels = catalog.enabledLevels.map((level): PublicEntryLevel => {
    const violations = checkEntryFeePolicy(level.entryFee).map((error) => error.code as EntryLevelPolicyViolationCode)
    const previews = catalog.previewPrizes(level.entryFee, GAME_PRIZE_FORMATS) ?? []
    const items = previews.map((preview): PublicEntryPrizePreviewItem => {
      const base = {
        gameKey: preview.format.gameKey,
        label: preview.format.label,
        paidEntries: preview.format.paidEntries,
        winners: preview.format.winners,
      }
      if (preview.status === 'ok') {
        const b = preview.breakdown
        return { ...base, status: 'ok', pot: b.pot, prizePerWinner: b.prizePerWinner, totalPrize: b.totalPrize, siteCommission: b.siteCommission }
      }
      return { ...base, status: 'unavailable', reason: preview.status === 'incompatible' ? preview.reason : preview.code }
    })
    return {
      entryFee: level.entryFee,
      minLevel: level.minLevel,
      policyCompliant: violations.length === 0,
      policyViolations: violations,
      configuredCommissionBps: null,
      prizePreview: {
        illustrative: true,
        commissionBasis: 'assumed-default',
        assumedCommissionBps: level.siteCommissionBps,
        items,
      },
    }
  })

  return {
    version: PUBLIC_ENTRY_CATALOG_VERSION,
    source: 'match_rooms',
    informationalOnly: true,
    commissionConfigured: false,
    policy: {
      minEntryFee: ENTRY_LEVEL_POLICY.minEntryFee,
      maxEntryFee: ENTRY_LEVEL_POLICY.maxEntryFee,
      entryFeeStep: ENTRY_LEVEL_POLICY.entryFeeStep,
      minCommissionBps: ENTRY_LEVEL_POLICY.minCommissionBps,
      maxCommissionBps: ENTRY_LEVEL_POLICY.maxCommissionBps,
      commissionStepBps: ENTRY_LEVEL_POLICY.commissionStepBps,
    },
    levels,
    excludedRowCount: catalog.issues.length,
    notice: ILLUSTRATIVE_NOTICE,
  }
}

/**
 * Fail-safe вариант за HTTP: всяка грешка → null (и лог), за да не се
 * засегне съществуващото `rooms` поле на /api/rooms.
 */
export function tryBuildPublicEntryCatalogPayload(
  reader: EntryLevelCatalogReader,
  onError: (error: unknown) => void = () => {},
): PublicEntryCatalogPayload | null {
  try {
    return buildPublicEntryCatalogPayload(reader.getCatalog())
  } catch (error) {
    onError(error)
    return null
  }
}
