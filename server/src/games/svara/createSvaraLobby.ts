// Single-owner adapter: checks + synchronous runtime mutations never yield to another request.
// Deploy on one process; multi-process hosting requires affinity/shared coordination first.
import { randomUUID } from 'node:crypto'
import { evaluateSvaraAccess, type SvaraAccessSession } from './svaraAccess.js'
import { SvaraMatchError } from './engine/svaraMatch.js'
import { createSvaraMatchRuntime, SvaraRuntimeError, type SvaraMatchRuntime } from './runtime/svaraMatchRuntime.js'
import { createSvaraCommandExecutor } from './runtime/createSvaraCommandExecutor.js'
import { createSvaraLifecycle, createSvaraRealClock, type SvaraClock } from './runtime/createSvaraLifecycle.js'
import type { SvaraTestBotsFactory } from './testBots/createSvaraTestBots.js' // ВРЕМЕННО — тестови ботове
import { exitAndAbortTestBotMatch, isLastHumanLeavingTestBotMatch } from './testBots/abortSvaraTestBotMatch.js' // ВРЕМЕННО — тестови ботове
import { SvaraPersistenceError, type SvaraMatchPersistence } from './runtime/svaraPersistence.js'
import { isSvaraTestFeatureEnabled } from './svaraFeatureFlag.js'
import { parseSvaraLobbyMessage, type SvaraFinishedMatch, type SvaraLobbyClientMessage, type SvaraLobbyErrorCode, type SvaraLobbyServerMessage } from './protocol/svaraLobbyProtocol.js'
import { serializeSvaraSnapshotForClient, type SvaraPublicTable } from './protocol/svaraSnapshotProtocol.js'
import { participantsIfCommandStartsMatch, reconcileSvaraPaidMatches, type SvaraPaidEconomy } from './svaraPaidEconomy.js'
import { getSvaraProgressionParticipants, type SvaraProgression } from './svaraProgression.js'
import { activeEntryFees, pinGameMatchFinancialTerms, SVARA_DEFAULT_FINANCIAL_CONFIG, type GameFinancialConfig } from '../../economy/gameFinancialConfig.js'

type Transport = {
  /** Handshake identity used only to skip unrelated connections during broadcast. */
  profileId: string | null
  /** Live, validated WS session; re-evaluated before every request and delivery. */
  getSession: () => SvaraAccessSession
  send: (message: SvaraLobbyServerMessage | string) => void
}
export type SvaraRecoveryState = 'initialization' | 'ready' | 'failed' | 'disabled'
/** Най-дълго време за преглед на резултата на приключил мач в RAM (после само SQLite историята). */
export const SVARA_FINISHED_REVIEW_RETENTION_MS = 10 * 60_000

/** Като „Не се сърди човече“ (PRIVATE_ROOM_FINISHED_VISIBILITY_HOURS): приключилите се виждат 2 часа. */
export const SVARA_FINISHED_VISIBILITY_HOURS = 2

/** Повторен опит за записа на прогреса (ниво/ранг) след временна грешка в базата. */
export const SVARA_PROGRESSION_RETRY_MS = 60_000
/** При старт на сървъра: колко назад се търсят приключили мачове с недовършен запис на прогреса. */
export const SVARA_PROGRESSION_RECOVERY_HOURS = 24

export function createSvaraLobby(deps: {
  /** purpose 'recovery' — бариерата при рестарт (виж initializeRecovery). */
  hasOtherGameCommitment: (profileId: string, purpose?: 'admission' | 'recovery') => boolean
  getPublicProfile?: (profileId: string) => { displayName: string; avatarUrl: string | null; gender?: 'male' | 'female' | null } | null
  runtime?: SvaraMatchRuntime
  persistence?: SvaraMatchPersistence
  onError?: (error: unknown) => void
  onAdmission?: (profileId: string) => void
  /**
   * Ролята на профил по profileId (без сесия) — при старт на мач се проверява
   * достъпът на ВСИЧКИ човешки участници (напр. след изключване на публичния
   * достъп). Без нея (само тестове) участниците се приемат за допуснати.
   */
  getProfileRole?: (profileId: string) => string | null
  clock?: SvaraClock
  /** ВРЕМЕННО — тестови ботове (docs/svara-test-bots-local.md). Без него ботове няма. */
  testBots?: SvaraTestBotsFactory
  /**
   * Етап 3В.2 — платена „Свара“. Липсва → виртуален режим (както досега).
   * 'unavailable' → платеният режим е включен, но икономиката не е достъпна:
   * нови маси се отказват (fail closed).
   */
  paidEconomy?: SvaraPaidEconomy | 'unavailable'
  /**
   * Етап 4Б: интервалът за увеличаване на антето (ms) от админ настройката.
   * Чете се при създаване на маса и остава в мача. Липсва → фиксирано анте.
   */
  getAnteIncreaseIntervalMs?: () => number
  /**
   * Етап 4В: активната конфигурация на входовете от базата (водещ източник и
   * във виртуалния режим). Липсва → началната конфигурация (само тестове без
   * база); 'unavailable' → нови маси се отказват.
   */
  svaraConfig?: { getActiveConfig: () => { ok: true; config: GameFinancialConfig } | { ok: false; message: string } } | 'unavailable'
  /**
   * Нива и рангове (общата система, виж svaraProgression.ts). Липсва → без
   * запис (само тестове). Не участва във финансовото уреждане.
   */
  progression?: SvaraProgression
}) {
  // An injected runtime is a test/server-owned dependency. Production always supplies persistence.
  if (deps.runtime && deps.persistence) throw new Error('Provide persistence through the injected Svara runtime')
  if (!deps.runtime && !deps.persistence) throw new Error('Svara lobby requires durable persistence or an explicitly injected runtime')
  const runtime = deps.runtime ?? createSvaraMatchRuntime({ persistence: deps.persistence, now: deps.clock?.now })
  const commands = createSvaraCommandExecutor(runtime)
  const connections = new Map<string, Transport>()
  const subscribers = new Set<string>()
  // Presentation membership only. Never part of the immutable finished state.
  const finishedDismissals = new Map<string, Set<string>>()
  const currentViews = new WeakMap<Transport, string>()
  const lifecycle = createSvaraLifecycle(runtime, {
    clock: deps.clock, onError: deps.onError,
    onChange: (matchId, before) => publish(matchId, before.players.map((p) => p.playerId), JSON.stringify(before) !== JSON.stringify(runtime.getPublicTable(matchId))),
  })
  let stopped = false
  // ── Етап 3В.2: платена „Свара“ ────────────────────────────────────────────
  const paidMode = deps.paidEconomy !== undefined
  const paidEconomy = deps.paidEconomy === undefined || deps.paidEconomy === 'unavailable' ? null : deps.paidEconomy
  /** Сървърната награда за победителя; клиентът никога не я смята сам. */
  /** Етап 4В: текущата конфигурация (чете се при всяко ползване — промяна от админа важи веднага). */
  function currentConfig(): GameFinancialConfig | null {
    if (deps.svaraConfig === undefined) return SVARA_DEFAULT_FINANCIAL_CONFIG
    if (deps.svaraConfig === 'unavailable') return null
    try {
      const result = deps.svaraConfig.getActiveConfig()
      if (result.ok) return result.config
      deps.onError?.(new Error(`[svara-config] ${result.message}`))
    } catch (cause) { deps.onError?.(cause) }
    return null
  }
  /** Входовете за НОВИ маси (сортирани) — за формата „Създай игра“. */
  function creationEntryFees(): number[] {
    const config = currentConfig()
    return config ? activeEntryFees(config) : []
  }
  function prizeFor(entryFee: number, participants: number): number | null {
    if (!paidMode) {
      const config = currentConfig()
      if (!config) return null
      const terms = pinGameMatchFinancialTerms(config, { entryFee, paidEntries: participants, pinnedAt: 1 })
      return terms.ok ? terms.terms.prizes[0]! : null
    }
    try { return paidEconomy?.previewPrize(entryFee, participants) ?? null } catch (cause) { deps.onError?.(cause); return null }
  }
  /** Започнал платен мач — от фиксираните условия; иначе — от активната конфигурация. */
  function tablePrize(table: SvaraPublicTable): number | null {
    if (paidEconomy) {
      try {
        const finance = paidEconomy.getFinance(table.matchId)
        if (finance && finance.status !== 'refunded') return (JSON.parse(finance.termsJson) as { prizes: number[] }).prizes[0] ?? null
      } catch (cause) { deps.onError?.(cause); return null }
    }
    return prizeFor(table.entryFee, table.capacity)
  }
  /** Приключил платен мач → изплащане (или 'held' без победител). Идемпотентно. */
  function settlePaidIfFinished(matchId: string): void {
    if (!paidEconomy || !runtime.hasMatch(matchId) || runtime.getPublicTable(matchId).phase !== 'finished') return
    try {
      if (paidEconomy.getFinance(matchId)?.status !== 'collected') return
      const winnerId = runtime.exportInternalStateForServer(matchId).winnerId
      const result = paidEconomy.settleMatch(matchId, winnerId)
      if (!result.ok) deps.onError?.(new Error(`[svara-paid] settlement failed match=${matchId}: ${result.message}`))
      else if (result.status === 'held') deps.onError?.(new Error(`[svara-paid] match=${matchId} HELD for review: ${result.heldReason}`))
    } catch (cause) { deps.onError?.(cause) }
  }
  /**
   * Удържа входовете ПРЕДИ командата, която стартира мача. Връща null при
   * успех (или ако командата не стартира мач); иначе кода за отказ.
   */
  function collectBeforeStart(table: SvaraPublicTable, playerId: string, command: 'join-seat' | 'start-match'): SvaraLobbyErrorCode | { shortProfileId: string } | null {
    if (!paidMode) return null
    const participants = participantsIfCommandStartsMatch(table, playerId, command)
    if (participants === null) return null
    if (!paidEconomy) return 'paid_unavailable'
    if (participants.some((id) => testBots?.isBot(id))) return 'not_allowed' // платените маси са само с хора
    let result = paidEconomy.collectEntries({ matchId: table.matchId, entryFee: table.entryFee, participantIds: participants })
    if (!result.ok && result.code === 'already-finalized' && paidEconomy.getFinance(table.matchId)?.status === 'collected') {
      // Остатък от неуспешен старт с други участници (маса още в лобито) — връщане, после нов опит.
      const refund = paidEconomy.refundEntries(table.matchId)
      if (refund.ok) result = paidEconomy.collectEntries({ matchId: table.matchId, entryFee: table.entryFee, participantIds: participants })
    }
    if (result.ok) return null
    // Потвърден недостатъчен баланс на конкретен участник (удържането е върнато
    // изцяло — никой не е таксуван). Само тогава мястото му може да се освободи.
    if (result.code === 'insufficient-balance' && result.profileId !== undefined && participants.includes(result.profileId)) {
      return { shortProfileId: result.profileId }
    }
    if (result.code !== 'insufficient-balance') deps.onError?.(new Error(`[svara-paid] entry collection failed match=${table.matchId}: ${result.code} ${result.message}`))
    return result.code === 'insufficient-balance' ? 'insufficient_coins' : 'paid_unavailable'
  }
  /** Само четене при създаване/сядане (удържането остава при старта). Грешка в базата → отказ без място. */
  function entryBalanceRefusal(playerId: string, entryFee: number): SvaraLobbyErrorCode | null {
    if (!paidMode) return null
    if (!paidEconomy) return 'paid_unavailable'
    try {
      return paidEconomy.hasEnoughBalance(playerId, entryFee) ? null : 'insufficient_entry_balance'
    } catch (cause) {
      deps.onError?.(cause)
      return 'server_unavailable'
    }
  }
  function notifyProfile(profileId: string, code: SvaraLobbyErrorCode) {
    for (const transport of connections.values()) if (transport.profileId === profileId) error(transport, code)
  }
  /**
   * Чакащ участник без достатъчно жълтици при опит за старт: мястото му се
   * освобождава с обичайната команда за напускане (създател → масата се
   * закрива по случай №7). Останалите запазват местата си и биват уведомени.
   */
  function releaseShortSeat(matchId: string, profileId: string) {
    const before = runtime.getPublicTable(matchId)
    const seated = before.players.map((p) => p.playerId)
    runtime.executeParticipantCommand(matchId, { playerId: profileId }, `balance-release:${randomUUID()}`, { type: 'leave-seat' })
    lifecycle.refresh(matchId)
    publish(matchId, seated)
    notifyProfile(profileId, 'insufficient_entry_balance')
    const closed = before.creatorId === profileId
    for (const id of seated) if (id !== profileId) notifyProfile(id, closed ? 'table_closed_insufficient_balance' : 'seat_released_insufficient_balance')
  }
  /** Стартът не е станал (грешка/друго състояние) → входовете се връщат веднага. */
  function refundIfNotStarted(matchId: string): void {
    if (!paidEconomy) return
    try {
      if (runtime.hasMatch(matchId) && runtime.getPublicTable(matchId).phase !== 'lobby') return
      const refund = paidEconomy.refundEntries(matchId)
      if (!refund.ok) deps.onError?.(new Error(`[svara-paid] refund after failed start failed match=${matchId}: ${refund.message} — boot reconcile will retry`))
    } catch (cause) { deps.onError?.(cause) }
  }
  let recoveryState: SvaraRecoveryState = deps.persistence ? 'initialization' : 'ready'
  let recoveryAttempted = false
  const clock = deps.clock ?? createSvaraRealClock()

  // ── Освобождаване на приключили мачове от RAM ──────────────────────────────
  // Историята остава в SQLite (releaseMatch трие само записа в паметта).
  // Приключил мач остава в паметта само докато някой човек може още да
  // разгледа резултата (не е излязъл и не го е затворил) и най-много
  // SVARA_FINISHED_REVIEW_RETENTION_MS — иначе мач, чиито участници всички
  // отсъстват (all-absent) или никога не се връщат, би останал завинаги.
  const finishedReleases = new Map<string, () => void>()
  function hasPendingFinishedViewer(matchId: string): boolean {
    const dismissed = finishedDismissals.get(matchId)
    // ВРЕМЕННО — тестови ботове: ботът не може да затвори резултата, затова не се брои.
    return runtime.getPublicTable(matchId).players.some((p) => p.status !== 'exited' && !dismissed?.has(p.playerId) && !testBots?.isBot(p.playerId))
  }
  function releaseFinishedMatch(matchId: string): void {
    finishedReleases.get(matchId)?.()
    finishedReleases.delete(matchId)
    if (!deps.persistence || !runtime.hasMatch(matchId) || runtime.getPublicTable(matchId).phase !== 'finished') return
    runtime.releaseMatch(matchId)
    finishedDismissals.delete(matchId)
    progressionDone.delete(matchId)
  }
  function scheduleFinishedRelease(matchId: string): void {
    if (stopped || !deps.persistence || finishedReleases.has(matchId) || !runtime.hasMatch(matchId)) return
    if (runtime.getPublicTable(matchId).phase !== 'finished') return
    // Винаги асинхронно: publish() се вика и от lifecycle прехода, който
    // още чете този мач в същия синхронен цикъл.
    finishedReleases.set(matchId, clock.schedule(() => {
      finishedReleases.delete(matchId)
      if (stopped) return
      try { releaseFinishedMatch(matchId) } catch (cause) { deps.onError?.(cause) }
    }, hasPendingFinishedViewer(matchId) ? SVARA_FINISHED_REVIEW_RETENTION_MS : 0))
  }

  // ── Нива и рангове при приключен мач ───────────────────────────────────────
  // Отделно от финансовото уреждане: грешка тук не го спира и не се спира от
  // него. Двойно начисляване няма — ledger-ът в базата е защитата; паметта
  // (progressionDone) само спестява излишни транзакции при следващите publish.
  // Временна грешка → повторен опит със запазения състав (оцелява и след
  // освобождаването на мача от RAM); рестарт по време на чакането се покрива
  // от recoverRecentProgression() при старта.
  const progressionDone = new Set<string>()
  const progressionRetries = new Map<string, () => void>()
  function recordProgression(matchId: string, playerIds: readonly string[], winnerId: string | null): boolean {
    const progression = deps.progression
    if (!progression) return true
    let ok = true
    for (const playerId of playerIds) {
      if (testBots?.isBot(playerId)) continue // ВРЕМЕННО — тестови ботове: не са профили
      try {
        if (!progression.record(matchId, playerId, playerId === winnerId)) ok = false
      } catch (cause) { ok = false; deps.onError?.(cause) }
    }
    return ok
  }
  /** Клиентът презарежда профила (виж 'svara_progress_updated'). */
  function notifyProgressUpdated(matchId: string, profileIds: readonly string[]): void {
    if (profileIds.length === 0) return
    for (const transport of connections.values()) {
      if (transport.profileId !== null && profileIds.includes(transport.profileId)) deliver(transport, { type: 'svara_progress_updated', matchId })
    }
  }
  function scheduleProgressionRetry(matchId: string, playerIds: readonly string[], winnerId: string | null): void {
    if (stopped || progressionRetries.has(matchId)) return
    deps.onError?.(new Error(`[svara-progression] record failed match=${matchId}; retry in ${SVARA_PROGRESSION_RETRY_MS} ms`))
    progressionRetries.set(matchId, clock.schedule(() => {
      progressionRetries.delete(matchId)
      if (stopped) return
      // Финалното svara_table_updated вече е изпратено със стария профил → всички.
      recordProgressionOnce(matchId, playerIds, winnerId, playerIds)
    }, SVARA_PROGRESSION_RETRY_MS))
  }
  /** notifyIds — кои да бъдат уведомени след успешен запис (останалите получават финалния snapshot). */
  function recordProgressionOnce(matchId: string, playerIds: readonly string[], winnerId: string | null, notifyIds: readonly string[]): void {
    if (!deps.progression || progressionDone.has(matchId) || progressionRetries.has(matchId)) return
    if (!recordProgression(matchId, playerIds, winnerId)) { scheduleProgressionRetry(matchId, playerIds, winnerId); return }
    progressionDone.add(matchId)
    notifyProgressUpdated(matchId, notifyIds)
  }
  /** Вика се от publish() веднага след уреждането — преди изпращането на 'finished' към клиентите. */
  function recordProgressionIfFinished(matchId: string): void {
    if (!deps.progression || progressionDone.has(matchId) || progressionRetries.has(matchId) || !runtime.hasMatch(matchId)) return
    try {
      if (runtime.getPublicTable(matchId).phase !== 'finished') return
      const state = runtime.exportInternalStateForServer(matchId)
      const participants = getSvaraProgressionParticipants(state)
      // Напусналите преди края не получават финалното svara_table_updated.
      if (participants) recordProgressionOnce(matchId, participants.playerIds, participants.winnerId, participants.playerIds.filter((id) => state.status[id] === 'exited'))
    } catch (cause) { deps.onError?.(cause) }
  }
  /**
   * При старт: приключили през последните SVARA_PROGRESSION_RECOVERY_HOURS
   * мачове, чийто запис е недовършен (срив/рестарт между приключването и
   * записа или по време на повторния опит). Само мачове след първия запис за
   * „Свара“: мачовете отпреди интеграцията не се начисляват никога (няма
   * възстановяване със задна дата). Без нито един запис — нищо не се чете.
   */
  function recoverRecentProgression(): void {
    const progression = deps.progression
    const persistence = deps.persistence
    if (!progression || !persistence?.listRecentFinished) return
    try {
      const since = progression.liveSince()
      if (since === null) return
      for (const match of persistence.listRecentFinished(SVARA_PROGRESSION_RECOVERY_HOURS)) {
        if (match.finishedAt < since || progressionDone.has(match.matchId)) continue
        if (progression.recordedCount(match.matchId) >= match.playerIds.length) { progressionDone.add(match.matchId); continue }
        recordProgressionOnce(match.matchId, match.playerIds, match.winnerId, match.playerIds)
      }
    } catch (cause) { deps.onError?.(cause) }
  }

  // ВРЕМЕННО — тестови ботове. Ботовете ползват само защитения snapshot и
  // същия команден път като човек; системни команди и сурово състояние няма.
  const testBots = deps.testBots?.({
    hasMatch: (matchId) => runtime.hasMatch(matchId),
    getPublicTable: (matchId) => runtime.getPublicTable(matchId),
    getBotSnapshot: (matchId, botId) => runtime.getPlayerSnapshot(matchId, { playerId: botId }),
    submit(matchId, botId, command, expectedRevision) {
      if (stopped || recoveryState !== 'ready' || !testBots?.isBot(botId)) throw new SvaraRuntimeError('command-not-allowed', 'test bot command rejected')
      lifecycle.sync(matchId)
      const before = runtime.getPublicTable(matchId)
      runtime.executeParticipantCommand(matchId, { playerId: botId }, randomUUID(), command, expectedRevision)
      lifecycle.refresh(matchId)
      publish(matchId, before.players.map((p) => p.playerId), JSON.stringify(before) !== JSON.stringify(runtime.getPublicTable(matchId)), lookedEvent(matchId, botId, command))
      progress(matchId)
    },
  }, clock) ?? null

  /** ВРЕМЕННО — тестови ботове: profileId на получател с право да запълва (admin), иначе null. */
  function testBotFillViewer(transport: Transport): string | null {
    if (!testBots?.isEnabled() || paidMode) return null // платените маси са само с хора
    const session = transport.getSession()
    return session?.account.role === 'admin' ? session.profile.profileId : null
  }

  /** Публичното представяне на играч (име/аватар/пол) — само при доставка, никога не се записва. */
  function presentPlayer(playerId: string): { displayName: string | null; avatarUrl: string | null; gender?: 'male' | 'female'; isBot?: true } {
    // ВРЕМЕННО — тестови ботове: име/аватар от модула, никога от базата.
    const bot = testBots?.isBot(playerId) ? testBots.publicProfile(playerId) : null
    if (bot) return { displayName: bot.displayName, avatarUrl: bot.avatarUrl, ...(bot.gender ? { gender: bot.gender } : {}), isBot: true }
    let profile: ReturnType<NonNullable<typeof deps.getPublicProfile>> = null
    try { profile = deps.getPublicProfile?.(playerId) ?? null } catch (cause) { deps.onError?.(cause) }
    // Presentation only: never persist profile data or spread a full profile.
    // Полът на профила (както в Белот) — само за избора на глас; без пол полето липсва.
    const gender = profile?.gender === 'male' || profile?.gender === 'female' ? profile.gender : null
    return { displayName: profile?.displayName?.trim() || null, avatarUrl: profile?.avatarUrl?.trim() || null, ...(gender ? { gender } : {}) }
  }

  /**
   * Финансовият резултат на приключил платен мач — точно от svara_match_finance
   * (сумата при 'paid' е наградата от фиксираните условия, която settleMatch
   * изплаща). Без запис (неплатена маса) — няма поле; никакво клиентско смятане.
   */
  function tablePayout(table: SvaraPublicTable): SvaraPublicTable['payout'] | undefined {
    if (!paidEconomy || table.phase !== 'finished') return undefined
    try {
      const finance = paidEconomy.getFinance(table.matchId)
      if (!finance) return undefined
      if (finance.status !== 'paid') return { status: finance.status === 'collected' ? 'pending' : finance.status, winnerId: null, amount: null }
      const prize = (JSON.parse(finance.termsJson) as { prizes: number[] }).prizes[0]
      return { status: 'paid', winnerId: finance.winnerProfileId, amount: typeof prize === 'number' && Number.isSafeInteger(prize) && prize > 0 ? prize : null }
    } catch (cause) { deps.onError?.(cause); return undefined }
  }

  function tableWithProfiles(table: SvaraPublicTable, fillViewerId: string | null = null): SvaraPublicTable {
    const canFill = fillViewerId !== null && fillViewerId === table.creatorId && table.phase === 'lobby' && table.players.length < table.capacity
    const payout = tablePayout(table)
    return { ...table, ...(canFill ? { testBotFill: true } : {}), ...(payout ? { payout } : {}), prizeAmount: tablePrize(table), paid: paidMode, players: table.players.map(({ playerId, status, seat }) => ({ playerId, status, seat, ...presentPlayer(playerId) })) }
  }

  /** Раздел „Приключили“: завършените мачове от последните часове (от записаните snapshot-и). */
  function finishedList(): SvaraFinishedMatch[] {
    try {
      return (deps.persistence?.listRecentFinished?.(SVARA_FINISHED_VISIBILITY_HOURS) ?? []).map((match) => ({
        matchId: match.matchId, capacity: match.capacity, entryFee: match.entryFee, winnerId: match.winnerId, finishedAt: match.finishedAt,
        players: match.playerIds.map((playerId) => ({ playerId })),
      }))
    } catch (cause) { deps.onError?.(cause); return [] }
  }

  function deliver(transport: Transport, payload: SvaraLobbyServerMessage | string) {
    try {
      if (typeof payload !== 'string' && payload.type === 'svara_table_updated') payload = { ...payload, table: tableWithProfiles(payload.table, testBotFillViewer(transport)) }
      else if (typeof payload !== 'string' && payload.type === 'svara_tables_list') {
        const fillViewerId = testBotFillViewer(transport)
        payload = { ...payload, tables: payload.tables.map((table) => tableWithProfiles(table, fillViewerId)),
          ...(payload.finished ? { finished: payload.finished.map((match) => ({ ...match, players: match.players.map(({ playerId }) => {
            const { displayName, avatarUrl, isBot } = presentPlayer(playerId)
            return { playerId, displayName, avatarUrl, ...(isBot ? { isBot } : {}) }
          }) })) } : {}) }
      }
      transport.send(payload)
    } catch (cause) { deps.onError?.(cause) }
  }

  const publicTables = () => runtime.listMatchIds().map((id) => runtime.getPublicTable(id))
    .filter((table) => table.phase === 'lobby' || table.phase === 'in-progress')
  function findCommitment(profileId: string) {
    const current = publicTables().find((table) => table.players.some((p) => p.playerId === profileId && (p.status === 'active' || p.status === 'absent')))
    if (current) return current
    // No recovery yet: retain the durable commitment and never replace an orphaned active match.
    try {
      const matchId = deps.persistence?.findActiveMatchId(profileId)
      return matchId ? { matchId } : null
    } catch (cause) {
      deps.onError?.(cause)
      return { matchId: '' } // fail closed for cross-game admission if the store is unavailable
    }
  }
  function error(transport: Transport, code: SvaraLobbyErrorCode, requestId?: string, gameplay = false, commandId?: string) {
    // Fixed messages: never echo thrown engine errors, payloads, IDs or hidden state.
    const messages: Record<SvaraLobbyErrorCode, string> = {
      feature_disabled: 'Функцията не е достъпна.', unauthenticated: 'Трябва да влезеш в профила си.',
      forbidden_role: 'Нямаш достъп.', invalid_input: 'Невалидна заявка.',
      match_not_found: 'Масата не е намерена.', already_seated: 'Вече имаш място на масата.',
      table_full: 'Всички места са заети.', not_a_participant: 'Не участваш на тази маса.',
      not_allowed: 'Действието не е позволено.', wrong_phase: 'Действието не е позволено в този етап.',
      command_id_conflict: 'Идентификаторът вече е използван за друга команда.',
      other_game_commitment: 'Вече участваш в друга игра.', svara_commitment: 'Вече участваш на маса за Свара.',
      server_unavailable: 'Сървърът временно не е наличен.',
      stale_action: 'Играта вече е обновена. Поискай текущото състояние.',
      invalid_action: 'Невалидно игрово действие.', not_your_turn: 'Не е твоят ред.',
      insufficient_chips: 'Недостатъчно игрови чипове.', look_required: 'Първо погледни собствените си карти.',
      player_absent: 'Отсъстваш. Заяви връщане за следващото раздаване.',
      dealing_in_progress: 'Картите тепърва се раздават.',
      insufficient_coins: 'Някой от играчите няма достатъчно жълтици за входа. Мачът не започна.',
      paid_unavailable: 'Платените игри временно не са достъпни.',
      insufficient_entry_balance: 'Нямаш достатъчно жълтици за входа на тази маса.',
      seat_released_insufficient_balance: 'Мачът не започна: играч без достатъчно жълтици освободи мястото си.',
      table_closed_insufficient_balance: 'Масата беше закрита: създателят няма достатъчно жълтици за входа.',
      seat_taken: 'Мястото вече е заето. Избери друго свободно място.',
    }
    if (gameplay) deliver(transport, { type: 'svara_command_error', code, message: messages[code], ...(commandId ? { commandId } : {}) })
    else deliver(transport, { type: 'svara_lobby_error', code, message: messages[code], ...(requestId ? { requestId } : {}) })
  }
  function finishedView(playerId: string) {
    return runtime.listMatchIds().map((id) => runtime.getPublicTable(id)).find((table) => table.phase === 'finished'
      && table.players.some((p) => p.playerId === playerId && p.status !== 'exited')
      && !finishedDismissals.get(table.matchId)?.has(playerId))
  }
  /** Може ли профилът (по роля, без сесия) да влезе в НОВ мач сега. */
  function profileMayStartMatch(profileId: string): boolean {
    if (testBots?.isBot(profileId)) return true // ВРЕМЕННО — тестови ботове
    if (!deps.getProfileRole) return true
    try {
      const role = deps.getProfileRole(profileId)
      return role !== null && evaluateSvaraAccess({ account: { role }, profile: { profileId } }).allowed
    } catch (cause) { deps.onError?.(cause); return false }
  }
  /**
   * Профил без достъп (напр. публичният достъп е изключен), който вече е в мач:
   * може само да го довърши — игрови команди, състояние, напускане и преглед на
   * резултата за СОБСТВЕНИЯ си мач. Нови маси, присъединяване, старт и списъци — не.
   */
  function mayContinueOwnMatch(profileId: string, input: SvaraLobbyClientMessage): boolean {
    if (input.type !== 'submit_svara_command' && input.type !== 'request_svara_table_state' && input.type !== 'leave_svara_table') return false
    const matchId = 'matchId' in input && typeof input.matchId === 'string' ? input.matchId : null
    if (!matchId) return false
    const commitment = findCommitment(profileId)
    if (commitment && commitment.matchId === matchId) return true
    return finishedView(profileId)?.matchId === matchId
  }
  function isContinuingParticipant(profileId: string): boolean {
    const commitment = findCommitment(profileId)
    return (commitment !== null && commitment.matchId !== '') || finishedView(profileId) !== undefined
  }
  function tablesFor(playerId: string) {
    const tables = publicTables()
    // Only this authenticated participant may restore their unfinished review.
    const reviewing = !findCommitment(playerId) ? finishedView(playerId) : undefined
    return reviewing ? [...tables, reviewing] : tables
  }
  function finishedLeft(transport: Transport, matchId: string, playerId: string, requestId?: string) {
    const current = currentViews.get(transport)
    const commitment = findCommitment(playerId)
    // An old packet must not clear a newer table in the existing client.
    if ((!current || current === matchId) && (!commitment || commitment.matchId === matchId)) {
      currentViews.delete(transport)
      deliver(transport, { type: 'svara_table_left', matchId, ...(requestId ? { requestId } : {}) })
    }
    deliver(transport, { type: 'svara_tables_list', tables: tablesFor(playerId), finished: finishedList() })
  }
  function snapshot(transport: Transport, matchId: string, playerId: string) {
    if (finishedDismissals.get(matchId)?.has(playerId)) { finishedLeft(transport, matchId, playerId); return }
    currentViews.set(transport, matchId)
    // Only the branded 2Б.3.2 builder output may cross the socket boundary.
    deliver(transport, serializeSvaraSnapshotForClient(runtime.getPlayerSnapshot(matchId, { playerId })))
    deliver(transport, lifecycle.timing(matchId))
  }
  /** Събитието „Виж“ след успешна команда look (на човек или бот) — виж 'svara_player_looked'. */
  function lookedEvent(matchId: string, playerId: string, command: { type: string }): SvaraLobbyServerMessage | undefined {
    return command.type === 'look' ? { type: 'svara_player_looked', matchId, playerId, revision: runtime.getMatchRevision(matchId) } : undefined
  }
  function publish(matchId: string, previousPlayers: string[], publicChanged = true, event?: SvaraLobbyServerMessage) {
    // Етап 3В.2: уреждането е преди всичко останало (вкл. по време на
    // възстановяването) — всеки преход към 'finished' минава оттук.
    settlePaidIfFinished(matchId)
    // Нивото/рангът — преди изпращането на 'finished': клиентът презарежда
    // профила (/api/auth/me) точно при тази фаза.
    recordProgressionIfFinished(matchId)
    if (recoveryState !== 'ready') return
    const table = runtime.getPublicTable(matchId)
    const tables = publicChanged ? publicTables() : []
    const finished = publicChanged ? finishedList() : []
    const recipients = new Set([...previousPlayers, ...table.players.map((p) => p.playerId)])
    for (const [connectionId, transport] of connections) {
      if (!subscribers.has(connectionId) && (transport.profileId === null || !recipients.has(transport.profileId))) continue
      const session = transport.getSession()
      if (!session?.profile.profileId || session.profile.profileId !== transport.profileId) continue
      const access = evaluateSvaraAccess(session)
      const playerId = session.profile.profileId
      const player = table.players.find((p) => p.playerId === playerId)
      // Без достъп → само участник в СОБСТВЕНИЯ си мач (довършване), без списъци.
      if (!access.allowed && !(access.reason === 'forbidden_role' && player !== undefined)) continue
      if (player && player.status !== 'exited' && !finishedDismissals.get(matchId)?.has(playerId)) {
        if (publicChanged) deliver(transport, { type: 'svara_table_updated', table })
        snapshot(transport, matchId, playerId)
        if (event && !finishedDismissals.get(matchId)?.has(playerId)) deliver(transport, event)
      } else if (previousPlayers.includes(playerId)) {
        if (publicChanged) deliver(transport, { type: 'svara_table_left', matchId })
      }
      if (access.allowed && publicChanged && subscribers.has(connectionId)) deliver(transport, { type: 'svara_tables_list', tables, finished })
    }
    testBots?.onMatchChanged(matchId) // ВРЕМЕННО — тестови ботове: само планира таймер
    if (table.phase === 'finished') scheduleFinishedRelease(matchId)
  }

  function progress(matchId: string) {
    if (stopped) return
    try { lifecycle.sync(matchId) } catch (cause) {
      // A participant command already committed must never be reported rejected
      // because a subsequent system transition failed. Preserve state for audit.
      deps.onError?.(cause)
    }
  }

  return {
    /** Етап 3В.2: за формата „Създай игра“ (HTTP). */
    creationPrize: { paid: paidMode, prizeFor, entryFees: creationEntryFees },
    getRecoveryState: () => recoveryState,
    /** Synchronous startup barrier; call only after the other games' commitments are restored. */
    initializeRecovery(): SvaraRecoveryState {
      if (recoveryAttempted || recoveryState !== 'initialization' || stopped) return recoveryState
      recoveryAttempted = true
      try {
        const snapshots = deps.persistence!.loadActiveMatches()
        for (const snapshot of snapshots) for (const playerId of snapshot.state.seats) {
          if (['active', 'absent'].includes(snapshot.state.status[playerId]!) && deps.hasOtherGameCommitment(playerId, 'recovery')) {
            throw new SvaraPersistenceError('commitment-conflict')
          }
        }
        runtime.restoreMatchesForServer(snapshots)
        // Every state and admission guard is now installed. Real Node callbacks
        // cannot run during this synchronous barrier. A failed expiry stops all
        // schedules; committed preceding transitions remain durable for next boot.
        for (const matchId of runtime.listMatchIds()) lifecycle.sync(matchId)
        recoveryState = 'ready'
        // Етап 3В.2: удържани входове на мачове, които не са започнали /
        // приключили по време на престоя → връщане / уреждане (идемпотентно).
        if (paidEconomy && deps.persistence) {
          const persistence = deps.persistence
          const report = reconcileSvaraPaidMatches(paidEconomy, (matchId) => {
            try {
              const stored = persistence.load(matchId)
              return stored ? { kind: 'state', phase: stored.state.phase, winnerId: stored.state.winnerId } : { kind: 'missing' }
            } catch { return { kind: 'unreadable' } }
          })
          if (report.refunded.length + report.settled.length + report.unrecoverable.length + report.failed.length > 0) {
            deps.onError?.(new Error(`[svara-paid] boot reconcile ${JSON.stringify(report)}`))
          }
        }
        recoverRecentProgression()
        // ВРЕМЕННО — тестови ботове: възстановените мачове продължават след рестарт.
        for (const matchId of runtime.listMatchIds()) testBots?.onMatchChanged(matchId)
        // Мач, приключил още при възстановяването (напр. изтекло чакане → all-absent).
        for (const matchId of runtime.listMatchIds()) scheduleFinishedRelease(matchId)
      } catch (cause) {
        lifecycle.shutdown()
        const safe = cause instanceof SvaraPersistenceError ? cause : new SvaraPersistenceError('recovery-failed')
        recoveryState = safe.code === 'schema-missing' && !isSvaraTestFeatureEnabled() ? 'disabled' : 'failed'
        if (recoveryState === 'failed') deps.onError?.(safe)
      }
      return recoveryState
    },
    attachConnection(connectionId: string, transport: Transport) { connections.set(connectionId, transport) },
    reconnect(connectionId: string) {
      const transport = connections.get(connectionId)
      if (!transport || stopped || recoveryState !== 'ready') return
      const session = transport.getSession()
      const access = evaluateSvaraAccess(session)
      if (session?.profile.profileId !== transport.profileId || !transport.profileId) return
      if (!access.allowed && !(access.reason === 'forbidden_role' && isContinuingParticipant(transport.profileId))) return
      const table = findCommitment(transport.profileId) ?? finishedView(transport.profileId)
      if (!table || !runtime.hasMatch(table.matchId)) return
      progress(table.matchId)
      if (runtime.getPublicTable(table.matchId).players.some((p) => p.playerId === transport.profileId && p.status !== 'exited')) {
        snapshot(transport, table.matchId, transport.profileId)
      }
    },
    // Disconnect is NOT leave/exit: no runtime command and no membership change.
    disconnect(connectionId: string) { connections.delete(connectionId); subscribers.delete(connectionId) },
    shutdown() {
      stopped = true
      lifecycle.shutdown()
      testBots?.shutdown() // ВРЕМЕННО — тестови ботове
      for (const cancel of finishedReleases.values()) cancel()
      finishedReleases.clear()
      for (const cancel of progressionRetries.values()) cancel()
      progressionRetries.clear()
      finishedDismissals.clear()
    },
    findCommitment,
    isContinuingParticipant,
    handle(connectionId: string, input: SvaraLobbyClientMessage, shuttingDown = false) {
      const transport = connections.get(connectionId)
      if (!transport) return
      const session = transport.getSession()
      const decision = evaluateSvaraAccess(session)
      const requestId = 'requestId' in input && typeof input.requestId === 'string' && input.requestId.trim() && input.requestId.length <= 64 ? input.requestId : undefined
      const isGameplay = input.type === 'submit_svara_command'
      const commandId = isGameplay && typeof input.commandId === 'string' && input.commandId.trim() && input.commandId.length <= 64 ? input.commandId : undefined
      const reject = (code: SvaraLobbyErrorCode) => error(transport, code, requestId, isGameplay, commandId)
      const continuing = !decision.allowed && decision.reason === 'forbidden_role' && recoveryState === 'ready'
        && !!transport.profileId && session?.profile.profileId === transport.profileId && mayContinueOwnMatch(transport.profileId, input)
      if (!decision.allowed && !continuing) { reject(decision.reason); return }
      if (session?.profile.profileId !== transport.profileId) { reject('unauthenticated'); return }
      if (shuttingDown || stopped || recoveryState !== 'ready') { reject('server_unavailable'); return }
      // Defense in depth for direct callers as well as the network parser.
      const message = parseSvaraLobbyMessage(input)
      if (!message) { reject('invalid_input'); return }
      const playerId = session!.profile.profileId!
      try {
        // Expire due work before a command/read/reconnect, even if its Node
        // timer callback has not been dispatched. Admission stays synchronous.
        if ('matchId' in message && runtime.hasMatch(message.matchId)) lifecycle.sync(message.matchId)
        if (message.type === 'submit_svara_command') {
          if (!runtime.hasMatch(message.matchId)) { reject('match_not_found'); return }
          const before = runtime.getPublicTable(message.matchId)
          if (!before.players.some((p) => p.playerId === playerId)) { reject('not_a_participant'); return }
          // ВРЕМЕННО — тестови ботове: същото незабавно прекратяване и за изрична
          // игрова команда „exit“ (само при актуален revision; иначе нормален отказ).
          const abortBotMatch = message.command.type === 'exit' && !!testBots && runtime.getMatchRevision(message.matchId) === message.expectedRevision
            && isLastHumanLeavingTestBotMatch(runtime, message.matchId, playerId, testBots.isBot)
          if (abortBotMatch) exitAndAbortTestBotMatch(runtime, message.matchId, playerId, message.commandId, testBots!.isBot)
          const result = abortBotMatch
            ? { type: 'svara_command_result' as const, matchId: message.matchId, commandId: message.commandId, status: 'applied' as const,
                revision: runtime.getMatchRevision(message.matchId), phase: runtime.getPublicTable(message.matchId).phase }
            : commands.execute({ playerId }, message)
          lifecycle.refresh(message.matchId)
          deliver(transport, result)
          if (result.status === 'duplicate') {
            if (before.players.some((p) => p.playerId === playerId && p.status !== 'exited')) snapshot(transport, message.matchId, playerId)
            return
          }
          const after = runtime.getPublicTable(message.matchId)
          publish(message.matchId, before.players.map((p) => p.playerId), JSON.stringify(before) !== JSON.stringify(after),
            abortBotMatch ? undefined : lookedEvent(message.matchId, playerId, message.command))
          progress(message.matchId)
          return
        }
        if (message.type === 'request_svara_tables_list') {
          subscribers.add(connectionId)
          deliver(transport, { type: 'svara_tables_list', tables: tablesFor(playerId), finished: finishedList() })
          return
        }
        if (message.type === 'fill_svara_table_with_bots') {
          // ВРЕМЕННО — тестови ботове. Правото се проверява тук (флаг + admin +
          // създател + чакаща маса), не от видимостта на бутона.
          if (!testBots?.isEnabled()) { reject('feature_disabled'); return }
          if (paidMode) { reject('not_allowed'); return } // Етап 3В.2: платените маси са само с хора
          if (session!.account.role !== 'admin') { reject('forbidden_role'); return }
          if (!runtime.hasMatch(message.matchId)) { reject('match_not_found'); return }
          const before = runtime.getPublicTable(message.matchId)
          if (before.creatorId !== playerId || !before.players.some((p) => p.playerId === playerId)) { reject('not_allowed'); return }
          if (before.phase !== 'lobby') { reject('wrong_phase'); return }
          const free = before.capacity - before.players.length
          if (free <= 0) { reject('table_full'); return }
          // Същата участническа команда като при човек; при „При запълване“
          // последното сядане стартира мача от самия engine.
          for (const botId of testBots.createBotIds(before.players.map((p) => p.playerId), free)) {
            runtime.executeParticipantCommand(message.matchId, { playerId: botId }, message.requestId, { type: 'join-seat' })
          }
          lifecycle.refresh(message.matchId)
          deliver(transport, { type: 'svara_table_updated', table: runtime.getPublicTable(message.matchId), requestId })
          publish(message.matchId, before.players.map((p) => p.playerId))
          progress(message.matchId)
          return
        }
        if (message.type === 'create_svara_table' || message.type === 'join_svara_table') {
          if (deps.hasOtherGameCommitment(playerId)) { error(transport, 'other_game_commitment', requestId); return }
          const commitment = findCommitment(playerId)
          if (commitment) {
            error(transport, message.type === 'join_svara_table' && commitment.matchId === message.matchId ? 'already_seated' : 'svara_commitment', requestId)
            return
          }
        }
        if (message.type === 'create_svara_table') {
          // Етап 3В.2: платен режим → само вход от активната конфигурация с точна награда.
          if (paidMode && prizeFor(message.entryFee, message.capacity) === null) { error(transport, 'paid_unavailable', requestId); return }
          // Етап 4В: само активен вход от конфигурацията в базата (не твърдо зададен списък).
          if (!creationEntryFees().includes(message.entryFee)) { error(transport, deps.svaraConfig === 'unavailable' ? 'server_unavailable' : 'invalid_input', requestId); return }
          const balanceRefusal = entryBalanceRefusal(playerId, message.entryFee)
          if (balanceRefusal) { error(transport, balanceRefusal, requestId); return }
          const matchId = randomUUID()
          let anteIncreaseIntervalMs: number | undefined
          try { anteIncreaseIntervalMs = deps.getAnteIncreaseIntervalMs?.() } catch (cause) { deps.onError?.(cause) }
          runtime.registerMatch({ matchId, creator: { playerId }, capacity: message.capacity, entryFee: message.entryFee, entryPercent: message.entryPercent, startMode: message.startMode,
            ...(anteIncreaseIntervalMs !== undefined ? { anteIncreaseIntervalMs } : {}) })
          deps.onAdmission?.(playerId)
          currentViews.set(transport, matchId)
          deliver(transport, { type: 'svara_table_updated', table: runtime.getPublicTable(matchId), requestId })
          publish(matchId, [])
          return
        }
        if (!runtime.hasMatch(message.matchId)) {
          // A released finished match remains durable. Reads/retries cannot
          // resurrect its engine, mutate its archive or dismiss another view.
          if (message.type === 'leave_svara_table' || message.type === 'request_svara_table_state') {
            const archived = deps.persistence?.load(message.matchId)
            if (archived?.state.phase === 'finished') {
              if (!archived.state.seats.includes(playerId)) { reject('not_a_participant'); return }
              finishedLeft(transport, message.matchId, playerId, requestId)
              return
            }
          }
          error(transport, 'match_not_found', requestId); return
        }
        let before = runtime.getPublicTable(message.matchId)
        if (message.type === 'leave_svara_table' && before.phase === 'finished') {
          if (!before.players.some((p) => p.playerId === playerId)) { reject('not_a_participant'); return }
          const dismissed = finishedDismissals.get(message.matchId) ?? new Set<string>()
          dismissed.add(playerId)
          finishedDismissals.set(message.matchId, dismissed)
          lifecycle.refresh(message.matchId)
          // Последният човек, който може да разглежда резултата, го затвори →
          // веднага от RAM (само паметта; историята остава в SQLite).
          if (!hasPendingFinishedViewer(message.matchId)) releaseFinishedMatch(message.matchId)
          finishedLeft(transport, message.matchId, playerId, requestId)
          return
        }
        if (message.type === 'request_svara_table_state') {
          if (!before.players.some((p) => p.playerId === playerId && p.status !== 'exited')) {
            error(transport, 'not_a_participant'); return
          }
          snapshot(transport, message.matchId, playerId)
          return
        }
        if (message.type === 'join_svara_table' && before.phase === 'lobby' && before.players.length >= before.capacity) {
          error(transport, 'table_full', requestId); return
        }
        // Избрано място: проверка преди баланса и удържането (заето → без опит за старт).
        if (message.type === 'join_svara_table' && before.phase === 'lobby' && message.seat !== undefined) {
          if (message.seat >= before.capacity) { error(transport, 'invalid_input', requestId); return }
          if (before.players.some((p) => p.seat === message.seat)) { error(transport, 'seat_taken', requestId); return }
        }
        if (message.type === 'join_svara_table' && before.phase === 'lobby') {
          const balanceRefusal = entryBalanceRefusal(playerId, before.entryFee)
          if (balanceRefusal) { error(transport, balanceRefusal, requestId); return }
        }
        const type = message.type === 'join_svara_table' ? 'join-seat'
          : message.type === 'start_svara_table' ? 'start-match'
          : before.phase === 'lobby' ? 'leave-seat' : 'exit'
        // ВРЕМЕННО — тестови ботове: изричен изход на последния човек от маса с
        // ботове прекратява мача веднага, без победител. Маси само с хора — без промяна.
        if (type === 'exit' && testBots && isLastHumanLeavingTestBotMatch(runtime, message.matchId, playerId, testBots.isBot)) {
          exitAndAbortTestBotMatch(runtime, message.matchId, playerId, message.requestId, testBots.isBot)
        } else if (type === 'join-seat' || type === 'start-match') {
          // Нов мач само ако ВСИЧКИ човешки участници имат достъп в момента
          // (напр. публичният достъп е изключен, докато обикновен играч чака на масата).
          const starters = participantsIfCommandStartsMatch(before, playerId, type)
          if (starters && starters.some((id) => !profileMayStartMatch(id))) { error(transport, 'not_allowed', requestId); return }
          // Етап 3В.2: удържане на ВСИЧКИ входове преди командата, която стартира мача.
          const refusal = collectBeforeStart(before, playerId, type)
          if (typeof refusal === 'string') { error(transport, refusal, requestId); return }
          if (refusal) {
            // Новият участник сам няма достатъчно → само той не сяда.
            if (type === 'join-seat' && refusal.shortProfileId === playerId) { error(transport, 'insufficient_entry_balance', requestId); return }
            // Вече седнал участник (вкл. създателя) → освобождаване на мястото му;
            // мачът не започва и никой не е таксуван. Еднакво за авто и ръчен старт.
            releaseShortSeat(message.matchId, refusal.shortProfileId)
            if (type === 'start-match') { progress(message.matchId); return }
            // Създателят е освободен → масата е закрита; новият не сяда.
            if (runtime.getPublicTable(message.matchId).phase !== 'lobby') {
              error(transport, 'table_closed_insufficient_balance', requestId); progress(message.matchId); return
            }
            // Масата остава активна и вече не е пълна → новият сяда (без старт).
            before = runtime.getPublicTable(message.matchId)
          }
          const seat = message.type === 'join_svara_table' ? message.seat : undefined
          try {
            runtime.executeParticipantCommand(message.matchId, { playerId }, message.requestId, seat === undefined ? { type } : { type, seat })
          } finally {
            refundIfNotStarted(message.matchId) // no-op, ако мачът е започнал или няма удържане
          }
        } else runtime.executeParticipantCommand(message.matchId, { playerId }, message.requestId, { type })
        lifecycle.refresh(message.matchId)
        if (message.type === 'join_svara_table') deps.onAdmission?.(playerId)
        if (message.type === 'join_svara_table') currentViews.set(transport, message.matchId)
        if (message.type === 'leave_svara_table') currentViews.delete(transport)
        if (message.type === 'leave_svara_table') deliver(transport, { type: 'svara_table_left', matchId: message.matchId, requestId })
        else deliver(transport, { type: 'svara_table_updated', table: runtime.getPublicTable(message.matchId), requestId })
        publish(message.matchId, before.players.map((p) => p.playerId))
        progress(message.matchId)
      } catch (cause) {
        if (cause instanceof SvaraRuntimeError || cause instanceof SvaraMatchError) {
          const codes: Record<string, SvaraLobbyErrorCode> = {
            'invalid-input': 'invalid_input', 'invalid-command': 'invalid_input',
            'match-not-found': 'match_not_found', 'not-a-participant': 'not_a_participant',
            'not-allowed': 'not_allowed', 'command-not-allowed': 'not_allowed',
            'wrong-phase': 'wrong_phase', 'command-id-conflict': 'command_id_conflict',
            'stale-action': 'stale_action', 'betting:not-your-turn': 'not_your_turn',
            'betting:insufficient-chips': 'insufficient_chips', 'betting:look-required': 'look_required',
            'player-absent': 'player_absent', 'seat-taken': 'seat_taken', 'dealing-in-progress': 'dealing_in_progress',
          }
          reject(codes[cause.code] ?? (cause.code.startsWith('betting:') ? 'invalid_action' : 'server_unavailable'))
        } else {
          deps.onError?.(cause)
          reject('server_unavailable')
        }
      }
    },
  }
}
