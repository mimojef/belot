// Общ интерфейс за четене на входните нива (Етапи 2–3А на общата финансова
// основа) + информационния блок `entryCatalog` в GET /api/rooms.
//
// Източник: match_rooms, чрез кеша на matchRoomsStore (без втора връзка към
// базата и без запис). prize_amount НЕ участва — действащите изплащания на
// Белот продължават да идват от setMatchPrizeResolver(prize_amount).
//
// Комисиона (Етап 3А): match_rooms.site_commission_bps.
//   - зададена (1 000–5 000 bps) → примерните награди ползват реалния процент;
//   - NULL → процентът НЕ е конфигуриран; примерът ползва предполагаеми 20%,
//     обозначени изрично като `assumed-default`.
// Зададена стойност извън политиката (DB CHECK-ът не би я допуснал) →
// fail-closed: нивото не влиза в каталога и се брои в excludedRowCount.
// Наградите в `entryCatalog` винаги са САМО ПРИМЕРНИ.

import {
  buildEntryLevelCatalog,
  GAME_PRIZE_FORMATS,
  type EntryLevel,
  type EntryLevelCatalog,
  type EntryLevelRow,
} from './entryLevelCatalog.js'
import {
  checkCommissionBpsPolicy,
  checkEntryFeePolicy,
  ENTRY_LEVEL_POLICY,
  type EntryLevelPolicyViolationCode,
} from './entryLevelPolicy.js'

/** Минималният договор към matchRoomsStore — само четене. */
export type MatchRoomsReadSource = {
  listRooms: () => readonly { stakeAmount: number; minLevel: number; isEnabled: boolean }[]
  /** Сурови стойности на site_commission_bps; липсващ ключ = NULL. Незадължително (стари източници). */
  getSiteCommissionBpsByStake?: () => ReadonlyMap<number, unknown>
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
 * Само стойности в одобрения диапазон стават override. Всяка друга не-NULL
 * стойност се подава като NaN → каталогът я отчита като
 * `invalid-commission-override` и изключва нивото (никога тихо 20%).
 */
function toCommissionOverrides(raw: ReadonlyMap<number, unknown>): Map<number, number> {
  const overrides = new Map<number, number>()
  for (const [entryFee, value] of raw) {
    if (value === null || value === undefined) continue
    overrides.set(entryFee, checkCommissionBpsPolicy(value).length === 0 ? (value as number) : Number.NaN)
  }
  return overrides
}

const EMPTY_COMMISSIONS: ReadonlyMap<number, unknown> = new Map()

/**
 * Каталогът се преизчислява само когато matchRoomsStore подмени кеша си
 * (listRooms() и картата на комисионите са нови обекти след всеки reload).
 */
export function createEntryLevelCatalogReader(source: MatchRoomsReadSource): EntryLevelCatalogReader {
  let cachedRooms: unknown = null
  let cachedCommissions: unknown = null
  let cached: EntryLevelCatalog | null = null

  function getCatalog(): EntryLevelCatalog {
    const rooms = source.listRooms()
    const commissions = source.getSiteCommissionBpsByStake?.() ?? EMPTY_COMMISSIONS
    if (cached === null || cachedRooms !== rooms || cachedCommissions !== commissions) {
      cached = buildEntryLevelCatalog(toRows(rooms), { commissionBpsByEntryFee: toCommissionOverrides(commissions) })
      cachedRooms = rooms
      cachedCommissions = commissions
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
  /** true само ако site_commission_bps е зададена за това ниво. */
  commissionConfigured: boolean
  /** Реално зададена комисиона от администратора — null, докато не е конфигурирана. */
  configuredCommissionBps: number | null
  /** Само при NULL: обяснение, че процентът не е конфигуриран. */
  commissionNotice: string | null
  prizePreview: {
    /** Винаги true — НЕ са действащите изплащания. */
    illustrative: true
    commissionBasis: 'configured' | 'assumed-default'
    /** Процентът, с който е сметнат примерът (реален или предполагаем). */
    commissionBps: number
    /** Етап 2 поле: предполагаемият процент при NULL; null при зададен. */
    assumedCommissionBps: number | null
    items: PublicEntryPrizePreviewItem[]
  }
}

export type PublicEntryCatalogPayload = {
  version: typeof PUBLIC_ENTRY_CATALOG_VERSION
  source: 'match_rooms'
  /** Информационно — действащите изплащания идват от rooms[].prizeAmount. */
  informationalOnly: true
  /** true само ако ВСИЧКИ активни нива (поне едно) имат зададен процент. */
  commissionConfigured: boolean
  configuredLevelCount: number
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

const LEVEL_NOT_CONFIGURED_NOTICE = 'Процентът не е конфигуриран — примерът е при предполагаеми 20%.'
const NOTICE_ALL_CONFIGURED =
  'Примерни награди при зададената комисиона за всяко ниво. Действащите изплащания не се променят.'
const NOTICE_PARTIAL =
  'Примерни награди: при нива без конфигуриран процент се ползват предполагаеми 20%. Действащите изплащания не се променят.'

export function buildPublicEntryCatalogPayload(catalog: EntryLevelCatalog): PublicEntryCatalogPayload {
  const levels = catalog.enabledLevels.map((level): PublicEntryLevel => {
    const violations = checkEntryFeePolicy(level.entryFee).map((error) => error.code as EntryLevelPolicyViolationCode)
    const configured = level.commissionSource === 'override'
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
      commissionConfigured: configured,
      configuredCommissionBps: configured ? level.siteCommissionBps : null,
      commissionNotice: configured ? null : LEVEL_NOT_CONFIGURED_NOTICE,
      prizePreview: {
        illustrative: true,
        commissionBasis: configured ? 'configured' : 'assumed-default',
        commissionBps: level.siteCommissionBps,
        assumedCommissionBps: configured ? null : level.siteCommissionBps,
        items,
      },
    }
  })

  const configuredLevelCount = levels.filter((level) => level.commissionConfigured).length
  const allConfigured = levels.length > 0 && configuredLevelCount === levels.length

  return {
    version: PUBLIC_ENTRY_CATALOG_VERSION,
    source: 'match_rooms',
    informationalOnly: true,
    commissionConfigured: allConfigured,
    configuredLevelCount,
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
    notice: allConfigured ? NOTICE_ALL_CONFIGURED : NOTICE_PARTIAL,
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
