// Етап 3В.2 — финансови операции на платената „Свара“ (изключена по
// подразбиране, виж svaraPaidFeatureFlag.ts). Портфейлите са общите
// profile_wallets; ledger-ът е отделен (svara_match_economy_ledger),
// по прецедента на ludo_match_economy_ledger.
//
// Гаранции:
//   - удържането на ВСИЧКИ входове + записът на условията са ЕДНА
//     транзакция (BEGIN IMMEDIATE): или всички платят, или никой;
//   - изплащането/връщането сменя статуса в СЪЩАТА транзакция и само от
//     'collected' → повторно извикване/рестарт не плаща втори път;
//   - UNIQUE(match, profile, type) в ledger-а — втора защита;
//   - невалидни условия / няма победител → 'held', без движение на жълтици.
//
// Наградата на „Свара“ трябва да е ТОЧНО (100% − комисиона) от фонда — без
// закръгляне, което променя съотношението; иначе мачът не започва.

import { randomUUID } from 'node:crypto'
import {
  activeEntryFees,
  resolveCommissionBps,
  pinGameMatchFinancialTerms,
  SVARA_DEFAULT_FINANCIAL_CONFIG,
  validateGameFinancialConfig,
  validateGameMatchFinancialTerms,
  type GameFinancialConfig,
  type GameMatchFinancialTerms,
} from '../economy/gameFinancialConfig.js'
import { BASIS_POINTS_SCALE } from '../economy/prizeFormula.js'
import { checkCommissionBpsPolicy, checkEntryFeePolicy, parseCommissionPercent } from '../economy/entryLevelPolicy.js'

// ── Етап 4В: администриране на входовете на „Свара“ ──────────────────────────
/** „Свара“: първоначалните чипове = вход/10, антето (1%) = чипове/100 → входът е кратен на 1 000. */
export const SVARA_ENTRY_FEE_STEP = 1_000
export const SVARA_ADMIN_CAPACITIES = [2, 3, 4] as const

export type SvaraAdminEntry = {
  entryFee: number
  isEnabled: boolean
  /** Ефективната комисиона (bps) и дали е по подразбиране или зададена за входа. */
  commissionBps: number
  commissionSource: 'default' | 'entry'
  /** Наградата за победителя при 2/3/4 играчи (null — неточно разпределение). */
  prizeByCapacity: Record<2 | 3 | 4, number | null>
}

export type SvaraAdminEntries = {
  configVersion: string
  defaultCommissionBps: number
  entries: SvaraAdminEntry[]
}

export type SvaraEntryUpsertInput = {
  entryFee: unknown
  isEnabled: unknown
  /** null/'' → комисионата по подразбиране; иначе процент (напр. „20“, „12,50“). */
  commissionPercent: unknown
}

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type SvaraFinanceStatus = 'collected' | 'paid' | 'refunded' | 'held'
export type SvaraHeldReason = 'no-winner' | 'invalid-terms' | 'winner-not-participant' | 'match-unrecoverable'

export type SvaraFinanceRow = {
  matchId: string
  attempt: number
  /** Ключът в ledger-а за текущия опит: `<matchId>:a<attempt>`. */
  ledgerScope: string
  status: SvaraFinanceStatus
  termsJson: string
  participants: string[]
  winnerProfileId: string | null
  heldReason: SvaraHeldReason | null
}

export type SvaraCollectErrorCode =
  | 'invalid-input'
  | 'config-unavailable'
  | 'entry-fee-not-allowed'
  | 'inexact-split'
  | 'insufficient-balance'
  | 'already-finalized'
  | 'db-error'

export type SvaraCollectResult =
  | { ok: true; terms: GameMatchFinancialTerms; alreadyCollected: boolean }
  | { ok: false; code: SvaraCollectErrorCode; message: string; profileId?: string }

export type SvaraSettleResult =
  | { ok: true; status: SvaraFinanceStatus; alreadySettled: boolean; heldReason: SvaraHeldReason | null; prize: number | null }
  | { ok: false; message: string }

export type SvaraEconomyStore = {
  /** Създава началната конфигурация, ако липсва. Никога не презаписва. */
  ensureDefaultConfig: () => void
  getActiveConfig: () => { ok: true; config: GameFinancialConfig } | { ok: false; message: string }
  /** Сървърната награда за победителя (null — недостъпна/неточна конфигурация). */
  previewPrize: (entryFee: number, participants: number) => number | null
  collectEntries: (input: { matchId: string; entryFee: number; participantIds: readonly string[] }) => SvaraCollectResult
  /** Само за мач, който НЕ е започнал. Идемпотентно. */
  refundEntries: (matchId: string) => { ok: true; refunded: boolean; status: SvaraFinanceStatus | null } | { ok: false; message: string }
  settleMatch: (matchId: string, winnerProfileId: string | null) => SvaraSettleResult
  markUnrecoverable: (matchId: string) => { ok: true; changed: boolean } | { ok: false; message: string }
  /** Етап 4В: входовете за админ интерфейса (вкл. изключените). */
  listSvaraEntries: () => { ok: true; value: SvaraAdminEntries } | { ok: false; message: string }
  /**
   * Етап 4В: добавя нов вход или редактира съществуващ (активност и
   * комисиона). Никога не трие; започнатите мачове пазят своите условия.
   */
  upsertSvaraEntry: (input: SvaraEntryUpsertInput) => { ok: true; value: SvaraAdminEntries } | { ok: false; message: string }
  getFinance: (matchId: string) => SvaraFinanceRow | null
  listCollectedMatchIds: () => string[]
  close: () => void
}

/** Точност 20/80: наградата × 10 000 = фонд × (10 000 − комисиона), с една позиция. */
export function isExactSvaraSplit(terms: GameMatchFinancialTerms): boolean {
  if (terms.prizes.length !== 1) return false
  return BigInt(terms.prizes[0]!) * BigInt(BASIS_POINTS_SCALE) === BigInt(terms.pot) * BigInt(BASIS_POINTS_SCALE - terms.commissionBps)
    && terms.prizes[0]! + terms.siteCommission === terms.pot
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function createSvaraEconomyStore(databaseFilePath: string): Promise<SvaraEconomyStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const ensureWallet = database.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 0) ON CONFLICT(profile_id) DO NOTHING;`)
  const selectBalance = database.prepare(`SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ? LIMIT 1;`)
  const debitWallet = database.prepare(`UPDATE profile_wallets SET yellow_coins_balance = yellow_coins_balance - ?, updated_at = CURRENT_TIMESTAMP WHERE profile_id = ? AND yellow_coins_balance >= ?;`)
  const creditWallet = database.prepare(`UPDATE profile_wallets SET yellow_coins_balance = yellow_coins_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE profile_id = ?;`)
  // Строг INSERT: дублиран ред хвърля и връща цялата транзакция.
  const insertLedger = database.prepare(`INSERT INTO svara_match_economy_ledger (ledger_id, match_id, profile_id, entry_type, amount, balance_after) VALUES (?, ?, ?, ?, ?, ?);`)
  const selectDebits = database.prepare(`SELECT profile_id, amount FROM svara_match_economy_ledger WHERE match_id = ? AND entry_type = 'svara_entry_debit' ORDER BY profile_id;`)
  const selectFinance = database.prepare(`SELECT match_id, attempt, ledger_scope, status, terms_json, participants_json, winner_profile_id, held_reason FROM svara_match_finance WHERE match_id = ? LIMIT 1;`)
  const insertFinance = database.prepare(`INSERT INTO svara_match_finance (match_id, attempt, ledger_scope, status, terms_json, participants_json) VALUES (?, 1, ?, 'collected', ?, ?);`)
  // Нов опит за старт след технически неуспешен (върнат) — само от 'refunded'.
  const reopenFinance = database.prepare(`
    UPDATE svara_match_finance SET attempt = ?, ledger_scope = ?, status = 'collected', terms_json = ?, participants_json = ?,
      winner_profile_id = NULL, held_reason = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE match_id = ? AND status = 'refunded' AND attempt = ?;
  `)
  const updateFinance = database.prepare(`
    UPDATE svara_match_finance SET status = ?, winner_profile_id = ?, held_reason = ?, updated_at = CURRENT_TIMESTAMP
    WHERE match_id = ? AND status = 'collected';
  `)

  const balanceOf = (profileId: string) => (selectBalance.get(profileId) as { b: number } | undefined)?.b ?? 0
  const rowOf = (matchId: string): SvaraFinanceRow | null => {
    const row = selectFinance.get(matchId) as { match_id: string; attempt: number; ledger_scope: string; status: SvaraFinanceStatus; terms_json: string; participants_json: string; winner_profile_id: string | null; held_reason: SvaraHeldReason | null } | undefined
    if (!row) return null
    return { matchId: row.match_id, attempt: row.attempt, ledgerScope: row.ledger_scope, status: row.status, termsJson: row.terms_json, participants: JSON.parse(row.participants_json) as string[], winnerProfileId: row.winner_profile_id, heldReason: row.held_reason }
  }
  function rollback(): void {
    try { database.exec('ROLLBACK;') } catch { /* already closed */ }
  }

  function ensureDefaultConfig(): void {
    database.prepare(`INSERT INTO game_financial_configs (game_key, config_json, config_version) VALUES ('svara', ?, ?) ON CONFLICT(game_key) DO NOTHING;`)
      .run(JSON.stringify(SVARA_DEFAULT_FINANCIAL_CONFIG), SVARA_DEFAULT_FINANCIAL_CONFIG.configVersion)
  }

  function getActiveConfig(): { ok: true; config: GameFinancialConfig } | { ok: false; message: string } {
    try {
      const row = database.prepare(`SELECT config_json FROM game_financial_configs WHERE game_key = 'svara' LIMIT 1;`).get() as { config_json: string } | undefined
      if (!row) return { ok: false, message: 'Липсва конфигурация за „Свара“.' }
      const validated = validateGameFinancialConfig(JSON.parse(row.config_json))
      if (!validated.ok) return { ok: false, message: `Невалидна конфигурация: ${validated.errors.map((e) => `${e.path}:${e.code}`).join(', ')}` }
      if (validated.config.gameKey !== 'svara') return { ok: false, message: 'Конфигурацията не е за „Свара“.' }
      return { ok: true, config: validated.config }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  function previewPrize(entryFee: number, participants: number): number | null {
    const active = getActiveConfig()
    if (!active.ok) return null
    const pinned = pinGameMatchFinancialTerms(active.config, { entryFee, paidEntries: participants, pinnedAt: 1 })
    return pinned.ok && isExactSvaraSplit(pinned.terms) ? pinned.terms.prizes[0]! : null
  }

  function collectEntries(input: { matchId: string; entryFee: number; participantIds: readonly string[] }): SvaraCollectResult {
    const ids = [...input.participantIds]
    if (typeof input.matchId !== 'string' || input.matchId.trim() === '' || ids.length < 2 || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || id.trim() === '')) {
      return { ok: false, code: 'invalid-input', message: 'Невалидни участници.' }
    }
    const active = getActiveConfig()
    if (!active.ok) return { ok: false, code: 'config-unavailable', message: active.message }
    // Условията се фиксират СЕГА — при действителния старт.
    const pinned = pinGameMatchFinancialTerms(active.config, { entryFee: input.entryFee, paidEntries: ids.length })
    if (!pinned.ok) return { ok: false, code: pinned.code === 'entry-fee-not-allowed' ? 'entry-fee-not-allowed' : 'inexact-split', message: pinned.message }
    if (!isExactSvaraSplit(pinned.terms)) return { ok: false, code: 'inexact-split', message: 'Наградата не е точно (100% − комисиона) от фонда.' }
    const terms = pinned.terms
    try {
      database.exec('BEGIN IMMEDIATE;')
      const existing = rowOf(input.matchId)
      if (existing && existing.status !== 'refunded') {
        rollback()
        const sameParticipants = JSON.stringify([...existing.participants].sort()) === JSON.stringify([...ids].sort())
        if (existing.status === 'collected' && sameParticipants) {
          return { ok: true, terms: JSON.parse(existing.termsJson) as GameMatchFinancialTerms, alreadyCollected: true }
        }
        return { ok: false, code: 'already-finalized', message: `Мачът вече има финансов запис (${existing.status}).` }
      }
      const attempt = existing ? existing.attempt + 1 : 1
      const ledgerScope = `${input.matchId}:a${attempt}`
      for (const profileId of ids) {
        ensureWallet.run(profileId)
        const debited = debitWallet.run(terms.entryFee, profileId, terms.entryFee) as { changes?: number }
        if ((debited.changes ?? 0) === 0) {
          rollback()
          return { ok: false, code: 'insufficient-balance', message: 'Недостатъчно жълтици.', profileId }
        }
        insertLedger.run(randomUUID(), ledgerScope, profileId, 'svara_entry_debit', terms.entryFee, balanceOf(profileId))
      }
      if (existing) {
        const reopened = reopenFinance.run(attempt, ledgerScope, JSON.stringify(terms), JSON.stringify(ids), input.matchId, existing.attempt) as { changes?: number }
        if ((reopened.changes ?? 0) !== 1) { rollback(); return { ok: false, code: 'db-error', message: 'Статусът се промени по време на удържането.' } }
      } else {
        insertFinance.run(input.matchId, ledgerScope, JSON.stringify(terms), JSON.stringify(ids))
      }
      database.exec('COMMIT;')
      return { ok: true, terms, alreadyCollected: false }
    } catch (error) {
      rollback()
      return { ok: false, code: 'db-error', message: messageOf(error) }
    }
  }

  function refundEntries(matchId: string): { ok: true; refunded: boolean; status: SvaraFinanceStatus | null } | { ok: false; message: string } {
    try {
      database.exec('BEGIN IMMEDIATE;')
      const row = rowOf(matchId)
      if (!row || row.status !== 'collected') {
        rollback()
        return { ok: true, refunded: false, status: row?.status ?? null }
      }
      for (const debit of selectDebits.all(row.ledgerScope) as Array<{ profile_id: string; amount: number }>) {
        ensureWallet.run(debit.profile_id)
        creditWallet.run(debit.amount, debit.profile_id)
        insertLedger.run(randomUUID(), row.ledgerScope, debit.profile_id, 'svara_entry_refund', debit.amount, balanceOf(debit.profile_id))
      }
      const updated = updateFinance.run('refunded', null, null, matchId) as { changes?: number }
      if ((updated.changes ?? 0) !== 1) { rollback(); return { ok: false, message: 'Статусът се промени по време на връщането.' } }
      database.exec('COMMIT;')
      return { ok: true, refunded: true, status: 'refunded' }
    } catch (error) {
      rollback()
      return { ok: false, message: messageOf(error) }
    }
  }

  function settleMatch(matchId: string, winnerProfileId: string | null): SvaraSettleResult {
    try {
      database.exec('BEGIN IMMEDIATE;')
      const row = rowOf(matchId)
      if (!row) { rollback(); return { ok: false, message: 'Няма финансов запис за мача.' } }
      if (row.status !== 'collected') {
        rollback()
        return { ok: true, status: row.status, alreadySettled: true, heldReason: row.heldReason, prize: null }
      }
      const hold = (reason: SvaraHeldReason): SvaraSettleResult => {
        const updated = updateFinance.run('held', null, reason, matchId) as { changes?: number }
        if ((updated.changes ?? 0) !== 1) { rollback(); return { ok: false, message: 'Статусът се промени по време на уреждането.' } }
        database.exec('COMMIT;')
        return { ok: true, status: 'held', alreadySettled: false, heldReason: reason, prize: null }
      }
      let parsed: unknown
      try { parsed = JSON.parse(row.termsJson) } catch { parsed = null }
      const valid = validateGameMatchFinancialTerms(parsed)
      if (!valid.ok || valid.terms.gameKey !== 'svara' || valid.terms.paidEntries !== row.participants.length || !isExactSvaraSplit(valid.terms)) {
        return hold('invalid-terms')
      }
      if (winnerProfileId === null) return hold('no-winner')
      if (!row.participants.includes(winnerProfileId)) return hold('winner-not-participant')
      const prize = valid.terms.prizes[0]!
      ensureWallet.run(winnerProfileId)
      creditWallet.run(prize, winnerProfileId)
      insertLedger.run(randomUUID(), row.ledgerScope, winnerProfileId, 'svara_winner_payout', prize, balanceOf(winnerProfileId))
      const updated = updateFinance.run('paid', winnerProfileId, null, matchId) as { changes?: number }
      if ((updated.changes ?? 0) !== 1) { rollback(); return { ok: false, message: 'Статусът се промени по време на изплащането.' } }
      database.exec('COMMIT;')
      return { ok: true, status: 'paid', alreadySettled: false, heldReason: null, prize }
    } catch (error) {
      rollback()
      return { ok: false, message: messageOf(error) }
    }
  }

  function describeEntries(config: GameFinancialConfig, configVersion: string): SvaraAdminEntries {
    const active = new Set(activeEntryFees(config))
    return {
      configVersion,
      defaultCommissionBps: config.defaultCommissionBps,
      entries: config.entryFees.map((entryFee) => {
        const prizeAt = (n: number) => {
          const pinned = pinGameMatchFinancialTerms(config, { entryFee, paidEntries: n, pinnedAt: 1 })
          return pinned.ok && isExactSvaraSplit(pinned.terms) ? pinned.terms.prizes[0]! : null
        }
        return {
          entryFee,
          isEnabled: active.has(entryFee),
          commissionBps: resolveCommissionBps(config, entryFee),
          commissionSource: config.commissionBpsByEntryFee[String(entryFee)] === undefined ? 'default' as const : 'entry' as const,
          prizeByCapacity: { 2: prizeAt(2), 3: prizeAt(3), 4: prizeAt(4) },
        }
      }),
    }
  }

  function listSvaraEntries(): { ok: true; value: SvaraAdminEntries } | { ok: false; message: string } {
    const active = getActiveConfig()
    if (!active.ok) return active
    return { ok: true, value: describeEntries(active.config, active.config.configVersion) }
  }

  function upsertSvaraEntry(input: SvaraEntryUpsertInput): { ok: true; value: SvaraAdminEntries } | { ok: false; message: string } {
    const feeErrors = checkEntryFeePolicy(input.entryFee)
    if (feeErrors.length > 0) return { ok: false, message: feeErrors[0]!.message }
    const entryFee = input.entryFee as number
    if (entryFee % SVARA_ENTRY_FEE_STEP !== 0) return { ok: false, message: `За „Свара“ входът трябва да е кратен на ${SVARA_ENTRY_FEE_STEP.toLocaleString('bg-BG')} (антето е 1% от чиповете).` }
    if (typeof input.isEnabled !== 'boolean') return { ok: false, message: 'Активността трябва да е „Да“ или „Не“.' }
    let commissionBps: number | null = null
    if (input.commissionPercent !== null && input.commissionPercent !== undefined && input.commissionPercent !== '') {
      const parsed = parseCommissionPercent(input.commissionPercent)
      if (!parsed.ok) return { ok: false, message: parsed.error.message }
      if (checkCommissionBpsPolicy(parsed.bps).length > 0) return { ok: false, message: 'Комисионата трябва да е между 10% и 50%.' }
      commissionBps = parsed.bps
    }
    try {
      ensureDefaultConfig()
      database.exec('BEGIN IMMEDIATE;')
      const current = getActiveConfig()
      if (!current.ok) { rollback(); return current }
      const config = current.config
      const entryFees = config.entryFees.includes(entryFee) ? [...config.entryFees] : [...config.entryFees, entryFee]
      const disabled = new Set(config.disabledEntryFees)
      if (input.isEnabled) disabled.delete(entryFee)
      else disabled.add(entryFee)
      const overrides: Record<string, number> = { ...config.commissionBpsByEntryFee }
      if (commissionBps === null) delete overrides[String(entryFee)]
      else overrides[String(entryFee)] = commissionBps
      if (entryFees.every((fee) => disabled.has(fee))) { rollback(); return { ok: false, message: 'Поне един вход трябва да остане активен.' } }
      const configVersion = `admin-${new Date().toISOString()}`
      const next = validateGameFinancialConfig({
        ...config,
        configVersion,
        entryFees,
        disabledEntryFees: [...disabled],
        commissionBpsByEntryFee: overrides,
      })
      if (!next.ok) { rollback(); return { ok: false, message: `Невалидна конфигурация: ${next.errors.map((e) => e.message).join(' ')}` } }
      // Точно разпределение при 2/3/4 играчи — иначе мачовете с този вход не биха започвали.
      for (const n of SVARA_ADMIN_CAPACITIES) {
        const pinned = pinGameMatchFinancialTerms(next.config, { entryFee, paidEntries: n, pinnedAt: 1 })
        if (!pinned.ok || !isExactSvaraSplit(pinned.terms)) {
          rollback()
          return { ok: false, message: `При ${n} играчи наградата не е точно (100% − комисиона) от фонда — избери друга комисиона или вход.` }
        }
      }
      database.prepare(`UPDATE game_financial_configs SET config_json = ?, config_version = ?, updated_at = CURRENT_TIMESTAMP WHERE game_key = 'svara';`)
        .run(JSON.stringify(next.config), configVersion)
      database.exec('COMMIT;')
      return { ok: true, value: describeEntries(next.config, configVersion) }
    } catch (error) {
      rollback()
      return { ok: false, message: messageOf(error) }
    }
  }

  function markUnrecoverable(matchId: string): { ok: true; changed: boolean } | { ok: false; message: string } {
    try {
      const updated = updateFinance.run('held', null, 'match-unrecoverable', matchId) as { changes?: number }
      return { ok: true, changed: (updated.changes ?? 0) === 1 }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  return {
    ensureDefaultConfig,
    getActiveConfig,
    previewPrize,
    collectEntries,
    refundEntries,
    settleMatch,
    markUnrecoverable,
    listSvaraEntries,
    upsertSvaraEntry,
    getFinance: rowOf,
    listCollectedMatchIds: () => (database.prepare(`SELECT match_id FROM svara_match_finance WHERE status = 'collected' ORDER BY created_at, match_id;`).all() as Array<{ match_id: string }>).map((r) => r.match_id),
    close: () => database.close(),
  }
}
