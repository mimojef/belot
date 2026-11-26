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
// Наградата на „Свара“ е по общата формула (закръгляне до 100, при 50 нагоре);
// комисионата на сайта е остатъкът от фонда (Етап 4В; до тогава — само точно 20/80).
//
// Етап 4В (корекция): входовете, активността и комисионите на „Свара“ идват
// САМО от общия каталог на масите (match_rooms) — същия, който ползват Белот
// и „Не се сърди човече“. „Свара“ прилага само собствените си правила:
// общите входове (кратни на 100; чипове = вход/10, антето се закръгля
// нагоре до цял чип); несъвместимите входове просто не се предлагат.

import { createHash, randomUUID } from 'node:crypto'
import {
  pinGameMatchFinancialTerms,
  validateGameFinancialConfig,
  validateGameMatchFinancialTerms,
  type GameFinancialConfig,
  type GameMatchFinancialTerms,
} from '../economy/gameFinancialConfig.js'
import { computePrizeBreakdown } from '../economy/prizeFormula.js'
import { checkCommissionBpsPolicy, checkEntryFeePolicy } from '../economy/entryLevelPolicy.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

/** „Свара“ приема общите входове (кратни на 100): чипове = вход/10, антето — нагоре до цял чип. */
export const SVARA_ENTRY_FEE_STEP = 100
export const SVARA_CAPACITIES = [2, 3, 4] as const

/** Ред от общия каталог (match_rooms). */
export type CommonEntryRow = { stake_amount: unknown; is_enabled: unknown; site_commission_bps?: unknown }

const SVARA_PRIZE_SCHEMES = [{ minParticipants: 2, sharesBps: [10_000] }]

/** Наградата на победителя в „Свара“ (null — входът не е в конфигурацията или разпределението не е точно). */
export function svaraPrizeFor(config: GameFinancialConfig, entryFee: number, participants: number): number | null {
  const pinned = pinGameMatchFinancialTerms(config, { entryFee, paidEntries: participants, pinnedAt: 1 })
  return pinned.ok && isExactSvaraSplit(pinned.terms) ? pinned.terms.prizes[0]! : null
}

/**
 * Конфигурацията на „Свара“, изведена от общия каталог. Не се съхранява
 * отделно. Fail-closed: ред с невалиден вход/комисиона не се предлага.
 */
export function buildSvaraConfigFromCommonEntries(rows: readonly CommonEntryRow[]): { ok: true; config: GameFinancialConfig } | { ok: false; message: string } {
  const candidates: Array<{ fee: number; enabled: boolean; bps: number | null }> = []
  for (const row of rows) {
    const fee = row.stake_amount
    if (typeof fee !== 'number' || checkEntryFeePolicy(fee).length > 0 || fee % SVARA_ENTRY_FEE_STEP !== 0) continue
    if (row.is_enabled !== 0 && row.is_enabled !== 1) continue
    const bps = row.site_commission_bps ?? null
    if (bps !== null && checkCommissionBpsPolicy(bps).length > 0) continue
    if (candidates.some((c) => c.fee === fee)) continue
    candidates.push({ fee, enabled: row.is_enabled === 1, bps: bps as number | null })
  }
  const make = (list: typeof candidates) => validateGameFinancialConfig({
    gameKey: 'svara',
    configVersion: `common-entries:${createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 12)}`,
    entryFees: list.map((c) => c.fee),
    defaultCommissionBps: 2_000,
    commissionBpsByEntryFee: Object.fromEntries(list.filter((c) => c.bps !== null).map((c) => [String(c.fee), c.bps])),
    prizeSchemes: SVARA_PRIZE_SCHEMES,
    disabledEntryFees: list.filter((c) => !c.enabled).map((c) => c.fee),
  })
  if (candidates.length === 0) return { ok: false, message: 'Няма входове, съвместими със „Свара“.' }
  const draft = make(candidates)
  if (!draft.ok) return { ok: false, message: `Невалидна конфигурация: ${draft.errors.map((e) => `${e.path}:${e.code}`).join(', ')}` }
  // Само входове с точно разпределение при 2, 3 и 4 играчи.
  const exact = candidates.filter((c) => SVARA_CAPACITIES.every((n) => svaraPrizeFor(draft.config, c.fee, n) !== null))
  if (exact.length === 0) return { ok: false, message: 'Няма входове, съвместими със „Свара“.' }
  if (exact.length === candidates.length) return { ok: true, config: draft.config }
  const final = make(exact)
  return final.ok ? { ok: true, config: final.config } : { ok: false, message: 'Невалидна конфигурация.' }
}

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

/** Задържан или ръчно уреден мач — за админ преглед (без карти/игрово състояние). */
export type SvaraHeldCase = {
  matchId: string
  status: SvaraFinanceStatus
  heldReason: SvaraHeldReason | null
  participants: string[]
  /** Удържаните входове (ledger). */
  debits: Array<{ profileId: string; amount: number }>
  /** От фиксираните условия; null — условията са невалидни (само връщане). */
  terms: { entryFee: number; pot: number; prize: number; commissionBps: number; siteCommission: number } | null
  winnerProfileId: string | null
  createdAt: string
  updatedAt: string
  resolution: { action: 'payout' | 'refund'; resolvedAt: string; resolvedBy: string; note: string; evidence: string | null; heldReason: string | null } | null
}

export type SvaraSettleHeldInput =
  | { matchId: string; action: 'payout'; winnerProfileId: string; resolvedBy: string; note: string; evidence: string }
  | { matchId: string; action: 'refund'; resolvedBy: string; note: string; evidence?: string }

export type SvaraSettleHeldErrorCode = 'invalid-input' | 'not-found' | 'not-held' | 'invalid-terms' | 'winner-not-participant' | 'ledger-mismatch' | 'already-settled' | 'db-error'

export type SvaraSettleHeldResult =
  | { ok: true; status: 'paid' | 'refunded'; movements: Array<{ profileId: string; amount: number; entryType: 'svara_winner_payout' | 'svara_entry_refund' }> }
  | { ok: false; code: SvaraSettleHeldErrorCode; message: string }

export type SvaraEconomyStore = {
  getActiveConfig: () => { ok: true; config: GameFinancialConfig } | { ok: false; message: string }
  /** Сървърната награда за победителя (null — недостъпна/неточна конфигурация). */
  previewPrize: (entryFee: number, participants: number) => number | null
  collectEntries: (input: { matchId: string; entryFee: number; participantIds: readonly string[] }) => SvaraCollectResult
  /** Само за мач, който НЕ е започнал. Идемпотентно. */
  refundEntries: (matchId: string) => { ok: true; refunded: boolean; status: SvaraFinanceStatus | null } | { ok: false; message: string }
  settleMatch: (matchId: string, winnerProfileId: string | null) => SvaraSettleResult
  markUnrecoverable: (matchId: string) => { ok: true; changed: boolean } | { ok: false; message: string }
  getFinance: (matchId: string) => SvaraFinanceRow | null
  listCollectedMatchIds: () => string[]
  /** Админ преглед: задържаните (status='held') и последните ръчно уредени. */
  listHeldCases: (input?: { resolvedLimit?: number }) => { held: SvaraHeldCase[]; resolved: SvaraHeldCase[] }
  /**
   * Ръчно уреждане на задържан мач от администратор: изплащане на победителя
   * САМО по фиксираните условия или връщане на входовете. Една транзакция, само
   * от 'held', с одит; повторно/паралелно уреждане не плаща втори път.
   */
  settleHeldCase: (input: SvaraSettleHeldInput) => SvaraSettleHeldResult
  close: () => void
}

/**
 * Етап 4В: един победител; наградата е ТОЧНО резултатът от общата формула
 * (prizeFormula.ts — закръгляне до 100, при 50 нагоре), а комисионата на сайта
 * е остатъкът: награда + комисиона = фонд. (Името е запазено от 3В.2.)
 */
export function isExactSvaraSplit(terms: GameMatchFinancialTerms): boolean {
  if (terms.prizes.length !== 1) return false
  const formula = computePrizeBreakdown({ entryFee: terms.entryFee, paidEntries: terms.paidEntries, winners: 1, siteCommissionBps: terms.commissionBps })
  return formula.ok
    && formula.breakdown.pot === terms.pot
    && terms.prizes[0] === formula.breakdown.prizePerWinner
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

  const hasResolutionColumns = (database.prepare('PRAGMA table_info(svara_match_finance)').all() as Array<{ name: string }>).some((c) => c.name === 'resolved_at')
  const caseColumns = `match_id, status, terms_json, participants_json, winner_profile_id, held_reason, ledger_scope, created_at, updated_at${hasResolutionColumns ? ', resolved_at, resolved_by, resolution_action, resolution_note, resolution_evidence, resolved_held_reason' : ''}`
  const countSettlements = database.prepare(`SELECT COUNT(*) AS n FROM svara_match_economy_ledger WHERE match_id = ? AND entry_type IN ('svara_winner_payout', 'svara_entry_refund');`)
  const resolveHeld = hasResolutionColumns ? database.prepare(`
    UPDATE svara_match_finance SET status = ?, winner_profile_id = ?, resolved_held_reason = held_reason, held_reason = NULL,
      resolved_at = CURRENT_TIMESTAMP, resolved_by = ?, resolution_action = ?, resolution_note = ?, resolution_evidence = ?, updated_at = CURRENT_TIMESTAMP
    WHERE match_id = ? AND status = 'held';
  `) : null

  const balanceOf = (profileId: string) => (selectBalance.get(profileId) as { b: number } | undefined)?.b ?? 0
  const rowOf = (matchId: string): SvaraFinanceRow | null => {
    const row = selectFinance.get(matchId) as { match_id: string; attempt: number; ledger_scope: string; status: SvaraFinanceStatus; terms_json: string; participants_json: string; winner_profile_id: string | null; held_reason: SvaraHeldReason | null } | undefined
    if (!row) return null
    return { matchId: row.match_id, attempt: row.attempt, ledgerScope: row.ledger_scope, status: row.status, termsJson: row.terms_json, participants: JSON.parse(row.participants_json) as string[], winnerProfileId: row.winner_profile_id, heldReason: row.held_reason }
  }
  function rollback(): void {
    try { database.exec('ROLLBACK;') } catch { /* already closed */ }
  }

  function getActiveConfig(): { ok: true; config: GameFinancialConfig } | { ok: false; message: string } {
    try {
      const hasCommission = (database.prepare('PRAGMA table_info(match_rooms)').all() as Array<{ name: string }>).some((c) => c.name === 'site_commission_bps')
      const rows = database.prepare(`SELECT stake_amount, is_enabled${hasCommission ? ', site_commission_bps' : ''} FROM match_rooms ORDER BY stake_amount ASC;`).all() as CommonEntryRow[]
      return buildSvaraConfigFromCommonEntries(rows)
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
    if (!isExactSvaraSplit(pinned.terms)) return { ok: false, code: 'inexact-split', message: 'Наградата не съответства на общата формула.' }
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

  function markUnrecoverable(matchId: string): { ok: true; changed: boolean } | { ok: false; message: string } {
    try {
      const updated = updateFinance.run('held', null, 'match-unrecoverable', matchId) as { changes?: number }
      return { ok: true, changed: (updated.changes ?? 0) === 1 }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  type CaseRow = { match_id: string; status: SvaraFinanceStatus; terms_json: string; participants_json: string; winner_profile_id: string | null; held_reason: SvaraHeldReason | null; ledger_scope: string; created_at: string; updated_at: string
    resolved_at?: string | null; resolved_by?: string | null; resolution_action?: 'payout' | 'refund' | null; resolution_note?: string | null; resolution_evidence?: string | null; resolved_held_reason?: string | null }

  /** Валидните фиксирани условия на мача (или null). */
  function termsOf(termsJson: string, participants: readonly string[]): GameMatchFinancialTerms | null {
    let parsed: unknown
    try { parsed = JSON.parse(termsJson) } catch { return null }
    const valid = validateGameMatchFinancialTerms(parsed)
    return valid.ok && valid.terms.gameKey === 'svara' && valid.terms.paidEntries === participants.length && isExactSvaraSplit(valid.terms) ? valid.terms : null
  }

  function caseOf(row: CaseRow): SvaraHeldCase {
    let participants: string[] = []
    try { participants = JSON.parse(row.participants_json) as string[] } catch { participants = [] }
    const terms = termsOf(row.terms_json, participants)
    return {
      matchId: row.match_id, status: row.status, heldReason: row.held_reason, participants,
      debits: (selectDebits.all(row.ledger_scope) as Array<{ profile_id: string; amount: number }>).map((d) => ({ profileId: d.profile_id, amount: d.amount })),
      terms: terms ? { entryFee: terms.entryFee, pot: terms.pot, prize: terms.prizes[0]!, commissionBps: terms.commissionBps, siteCommission: terms.siteCommission } : null,
      winnerProfileId: row.winner_profile_id, createdAt: row.created_at, updatedAt: row.updated_at,
      resolution: row.resolved_at && row.resolution_action && row.resolved_by
        ? { action: row.resolution_action, resolvedAt: row.resolved_at, resolvedBy: row.resolved_by, note: row.resolution_note ?? '', evidence: row.resolution_evidence ?? null, heldReason: row.resolved_held_reason ?? null }
        : null,
    }
  }

  function listHeldCases(input: { resolvedLimit?: number } = {}): { held: SvaraHeldCase[]; resolved: SvaraHeldCase[] } {
    const held = (database.prepare(`SELECT ${caseColumns} FROM svara_match_finance WHERE status = 'held' ORDER BY created_at, match_id;`).all() as CaseRow[]).map(caseOf)
    const limit = Math.max(0, Math.min(200, Math.trunc(input.resolvedLimit ?? 50)))
    const resolved = hasResolutionColumns
      ? (database.prepare(`SELECT ${caseColumns} FROM svara_match_finance WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC, match_id LIMIT ?;`).all(limit) as CaseRow[]).map(caseOf)
      : []
    return { held, resolved }
  }

  function settleHeldCase(input: SvaraSettleHeldInput): SvaraSettleHeldResult {
    const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() !== '' && value.length <= max
    if (!input || typeof input !== 'object' || !text(input.matchId, 128) || !text(input.resolvedBy, 128) || !text(input.note, 2000)) {
      return { ok: false, code: 'invalid-input', message: 'Мачът, администраторът и бележката са задължителни.' }
    }
    if (input.action !== 'payout' && input.action !== 'refund') return { ok: false, code: 'invalid-input', message: 'Действието трябва да е изплащане или връщане.' }
    if (input.action === 'payout' && (!text(input.winnerProfileId, 128) || !text(input.evidence, 2000))) {
      return { ok: false, code: 'invalid-input', message: 'Изплащането изисква победител и описание на доказателството.' }
    }
    if (input.evidence !== undefined && input.evidence !== '' && !text(input.evidence, 2000)) return { ok: false, code: 'invalid-input', message: 'Невалидно доказателство.' }
    if (!resolveHeld) return { ok: false, code: 'db-error', message: 'Липсва миграцията за одит на уреждането.' }
    const abort = (code: SvaraSettleHeldErrorCode, message: string): SvaraSettleHeldResult => { rollback(); return { ok: false, code, message } }
    try {
      database.exec('BEGIN IMMEDIATE;')
      const row = rowOf(input.matchId)
      if (!row) return abort('not-found', 'Няма финансов запис за мача.')
      if (row.status !== 'held') return abort('not-held', `Случаят не е задържан (status=${row.status}).`)
      if (((countSettlements.get(row.ledgerScope) as { n: number }).n) > 0) return abort('already-settled', 'За мача вече има изплащане или връщане в ledger-а.')
      const debits = selectDebits.all(row.ledgerScope) as Array<{ profile_id: string; amount: number }>
      const debitIds = debits.map((d) => d.profile_id).sort()
      if (debits.length === 0 || JSON.stringify(debitIds) !== JSON.stringify([...row.participants].sort())) {
        return abort('ledger-mismatch', 'Удържаните входове не съответстват на участниците — нужна е ръчна проверка в базата.')
      }
      const movements: Array<{ profileId: string; amount: number; entryType: 'svara_winner_payout' | 'svara_entry_refund' }> = []
      let winner: string | null = null
      if (input.action === 'payout') {
        const terms = termsOf(row.termsJson, row.participants)
        if (!terms) return abort('invalid-terms', 'Фиксираните условия са невалидни — допустимо е само връщане на входовете.')
        if (debits.some((d) => d.amount !== terms.entryFee) || debits.reduce((sum, d) => sum + d.amount, 0) !== terms.pot) {
          return abort('ledger-mismatch', 'Удържаните суми не съответстват на фиксираните условия.')
        }
        if (!row.participants.includes(input.winnerProfileId)) return abort('winner-not-participant', 'Победителят не е участник в мача.')
        winner = input.winnerProfileId
        const prize = terms.prizes[0]!
        ensureWallet.run(winner)
        creditWallet.run(prize, winner)
        insertLedger.run(randomUUID(), row.ledgerScope, winner, 'svara_winner_payout', prize, balanceOf(winner))
        movements.push({ profileId: winner, amount: prize, entryType: 'svara_winner_payout' })
      } else {
        for (const debit of debits) {
          ensureWallet.run(debit.profile_id)
          creditWallet.run(debit.amount, debit.profile_id)
          insertLedger.run(randomUUID(), row.ledgerScope, debit.profile_id, 'svara_entry_refund', debit.amount, balanceOf(debit.profile_id))
          movements.push({ profileId: debit.profile_id, amount: debit.amount, entryType: 'svara_entry_refund' })
        }
      }
      const status = input.action === 'payout' ? 'paid' : 'refunded'
      const evidence = typeof input.evidence === 'string' && input.evidence.trim() !== '' ? input.evidence.trim() : null
      const updated = resolveHeld.run(status, winner, input.resolvedBy.trim(), input.action, input.note.trim(), evidence, input.matchId) as { changes?: number }
      if ((updated.changes ?? 0) !== 1) return abort('not-held', 'Статусът се промени по време на уреждането.')
      database.exec('COMMIT;')
      return { ok: true, status, movements }
    } catch (error) {
      rollback()
      return { ok: false, code: 'db-error', message: messageOf(error) }
    }
  }

  return {
    listHeldCases,
    settleHeldCase,
    getActiveConfig,
    previewPrize,
    collectEntries,
    refundEntries,
    settleMatch,
    markUnrecoverable,
    getFinance: rowOf,
    listCollectedMatchIds: () => (database.prepare(`SELECT match_id FROM svara_match_finance WHERE status = 'collected' ORDER BY created_at, match_id;`).all() as Array<{ match_id: string }>).map((r) => r.match_id),
    close: () => database.close(),
  }
}
