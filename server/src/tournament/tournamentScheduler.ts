import type { TournamentId } from './tournamentTypes.js'
import type { TournamentEconomyStore } from '../db/tournamentEconomyStore.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type TournamentSchedulerHealth = {
  state: 'idle' | 'running' | 'stopped'
  inFlight: boolean
  lastTickAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  processedLastTick: number
  nextTickIntervalMs: number
}

export type TournamentScheduler = {
  start: () => void
  stop: () => void
  tickNow: () => void
  getHealth: () => TournamentSchedulerHealth
  close: () => void
}

type TournamentSchedulerDeps = {
  databaseFilePath: string
  economyStore: TournamentEconomyStore
  intervalMs?: number
  batchSize?: number
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>
  clearInterval?: (id: ReturnType<typeof globalThis.setInterval>) => void
  now?: () => Date
  logError?: (message: string, error: unknown) => void
  /** Server-authoritative refund известие (§4/§5 в task spec-а) — извиква се
   * само след реално committed auto-cancel refund, с per-profile сумите от
   * autoCancelScheduledTournamentAtomically. Няма достъп до WS слоя тук —
   * index.ts инжектира действителния push механизъм. reason различава
   * fill-mode timeout от scheduled-start underfilled (§"CANCELLATION
   * REASON" в допълнението — user-facing текстът е еднакъв, но internal
   * reason-ите остават различни); noticeId сочи към committed durable ред,
   * ползван за mark-delivered след успешен online push. */
  notifyEconomyRefunds?: (
    tournamentId: TournamentId,
    reason: 'fill_expired' | 'scheduled_underfilled',
    refundedProfiles: Array<{ profileId: string; amount: number; noticeId: string }>,
  ) => void
  // Monitoring-only, best-effort — извиква се веднъж на всеки runTick() с
  // измерената му продължителност (performance.now() около целия tick body,
  // виж diagnostic fix брифа §2). Никога не хвърля, никога не влияе на
  // scheduler логиката.
  onTickTiming?: (durationMs: number) => void
}

const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_BATCH_SIZE = 25
const SCHEDULED_START_NOT_READY = 'scheduled_start_not_ready'
const FILL_MODE_EXPIRED = 'fill_mode_expired'

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export async function createTournamentScheduler(
  deps: TournamentSchedulerDeps,
): Promise<TournamentScheduler> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(deps.databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE
  const now = deps.now ?? (() => new Date())
  const logError = deps.logError ?? ((message, error) => console.error(message, error))
  const setTimer = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms))
  const clearTimer = deps.clearInterval ?? ((id) => globalThis.clearInterval(id))

  const selectDueScheduledTournamentIdsStatement = database.prepare(`
    SELECT tournament_id
    FROM tournaments
    WHERE status = 'open'
      AND start_mode = 'scheduled'
      AND scheduled_start_at IS NOT NULL
      AND datetime(scheduled_start_at) <= datetime(?)
    ORDER BY scheduled_start_at ASC
    LIMIT ?;
  `)

  // ПРЕМАХНАТО (§1/§13 в "scheduled shuffle timing" task spec-а): T-15
  // shuffle due-queue-то за scheduled shuffle турнири. Окончателното
  // разбъркване вече не се случва предварително — то е inline вътре в
  // startTournamentAtomicallyLocal, извикано от due-scheduled loop-а по-долу
  // ТОЧНО на scheduled_start_at (T-0), не 15 минути преди него. Виж
  // performShuffleTeamsInCurrentTransaction в tournamentEconomyStore.ts.
  //
  // migration 20260904_002_add_tournament_shuffle_mode.sql остава непроменена
  // (миграционният runner следи applied migrations по filename, не
  // checksum/re-diff — редактиране на вече приложен .sql файл не презаписва
  // локалната DB) — партиалният ѝ idx_tournaments_shuffle_due индекс остава
  // в схемата като безвреден leftover (тесен partial index, вече неизползван
  // от никакъв query тук), вместо да рискуваме DROP INDEX миграция само за
  // почистване.

  const selectReadyFillTournamentIdsStatement = database.prepare(`
    SELECT t.tournament_id
    FROM tournaments t
    WHERE t.status = 'open'
      AND t.start_mode = 'fill'
      AND (
        SELECT COUNT(*)
        FROM tournament_entries te
        WHERE te.tournament_id = t.tournament_id AND te.status = 'confirmed'
      ) >= t.player_capacity
      AND NOT EXISTS (
        SELECT 1
        FROM tournament_partner_invites tpi
        WHERE tpi.tournament_id = t.tournament_id AND tpi.status = 'pending'
      )
    ORDER BY t.created_at ASC
    LIMIT ?;
  `)

  // Due-queue за неизпълнени fill турнири (виж migration 20260731_001).
  // Изпълнява се СЛЕД selectReadyFillTournamentIdsStatement loop-а в runTick,
  // за да може турнир, запълнил се точно в рамките на същия tick, да стартира
  // първо (startTournamentAtomically вече е сменил status-а извън 'open' —
  // затова тук вече не се вижда). Idle/underfilled турнирите с изтекъл срок
  // остават до следващия tick, ако вече не са ready.
  const selectExpiredFillTournamentIdsStatement = database.prepare(`
    SELECT tournament_id
    FROM tournaments
    WHERE status = 'open'
      AND start_mode = 'fill'
      AND fill_expires_at IS NOT NULL
      AND datetime(fill_expires_at) <= datetime(?)
    ORDER BY fill_expires_at ASC
    LIMIT ?;
  `)

  let intervalId: ReturnType<typeof globalThis.setInterval> | null = null
  let inFlight = false
  let stopped = false
  let lastTickAt: string | null = null
  let lastSuccessAt: string | null = null
  let lastError: string | null = null
  let processedLastTick = 0

  function runTick(): void {
    if (stopped || inFlight) return
    inFlight = true
    const tickStartedAtMs = performance.now()
    const tickNow = now()
    lastTickAt = tickNow.toISOString()
    processedLastTick = 0
    try {
      deps.economyStore.expireDuePartnerInvitesAtomically()

      // Shuffle mode scheduled tournaments (§2/§13 в "scheduled shuffle
      // timing" task spec-а): вече НЯМА отделен T-15 pre-shuffle стъпка тук —
      // shuffle-ът (за shuffle_enabled=1 турнири) става inline вътре в
      // startTournamentAtomically по-долу, ТОЧНО на scheduled_start_at, като
      // част от същата атомарна start транзакция.
      const dueScheduledIds = (
        selectDueScheduledTournamentIdsStatement.all(tickNow.toISOString(), batchSize) as {
          tournament_id: string
        }[]
      ).map((row) => row.tournament_id)
      for (const tournamentId of dueScheduledIds) {
        try {
          const startResult = deps.economyStore.startTournamentAtomically(tournamentId, tickNow)
          if (!startResult.ok) {
            const cancelResult = deps.economyStore.autoCancelScheduledTournamentAtomically(
              tournamentId,
              tickNow,
              SCHEDULED_START_NOT_READY,
            )
            if (cancelResult.ok && !cancelResult.alreadyCancelled && cancelResult.refundedProfiles.length > 0) {
              deps.notifyEconomyRefunds?.(tournamentId, 'scheduled_underfilled', cancelResult.refundedProfiles)
            }
          }
          processedLastTick += 1
        } catch (error) {
          lastError = sanitizeError(error)
          logError(`[tournament-scheduler] scheduled tournament failed: ${tournamentId}`, error)
        }
      }

      const readyFillIds = (
        selectReadyFillTournamentIdsStatement.all(batchSize) as { tournament_id: string }[]
      ).map((row) => row.tournament_id)
      for (const tournamentId of readyFillIds) {
        try {
          deps.economyStore.startTournamentAtomically(tournamentId, tickNow)
          processedLastTick += 1
        } catch (error) {
          lastError = sanitizeError(error)
          logError(`[tournament-scheduler] fill tournament failed: ${tournamentId}`, error)
        }
      }

      // Ready-before-expiry: изпълнява се СЛЕД readyFillIds по-горе, за да не
      // отменя турнир, който тъкмо стана 8/8 в рамките на СЪЩИЯ tick.
      // autoCancelScheduledTournamentAtomically(status='open') е no-op за
      // всеки tournamentId, който readyFillIds loop-ът вече е стартирал
      // (freshTournament.status вече не е 'open' вътре в неговата собствена
      // BEGIN IMMEDIATE транзакция).
      const expiredFillIds = (
        selectExpiredFillTournamentIdsStatement.all(tickNow.toISOString(), batchSize) as {
          tournament_id: string
        }[]
      ).map((row) => row.tournament_id)
      for (const tournamentId of expiredFillIds) {
        try {
          const cancelResult = deps.economyStore.autoCancelScheduledTournamentAtomically(
            tournamentId,
            tickNow,
            FILL_MODE_EXPIRED,
          )
          if (cancelResult.ok && !cancelResult.alreadyCancelled && cancelResult.refundedProfiles.length > 0) {
            deps.notifyEconomyRefunds?.(tournamentId, 'fill_expired', cancelResult.refundedProfiles)
          }
          processedLastTick += 1
        } catch (error) {
          lastError = sanitizeError(error)
          logError(`[tournament-scheduler] fill expiry cancel failed: ${tournamentId}`, error)
        }
      }

      lastSuccessAt = new Date().toISOString()
      if (lastError === null || processedLastTick > 0) lastError = null
    } catch (error) {
      lastError = sanitizeError(error)
      logError('[tournament-scheduler] tick failed', error)
    } finally {
      inFlight = false
      try {
        deps.onTickTiming?.(performance.now() - tickStartedAtMs)
      } catch {
        // monitoring hook — никога не влияе на scheduler логиката
      }
    }
  }

  function start(): void {
      if (intervalId !== null) return
      stopped = false
      runTick()
      intervalId = setTimer(runTick, intervalMs)
      if (typeof intervalId === 'object' && intervalId !== null && 'unref' in intervalId) {
        ;(intervalId as { unref: () => void }).unref()
      }
  }

  function stop(): void {
      stopped = true
      if (intervalId !== null) {
        clearTimer(intervalId)
        intervalId = null
      }
  }

  return {
    start,
    stop,
    tickNow(): void {
      runTick()
    },
    getHealth(): TournamentSchedulerHealth {
      return {
        state: stopped ? 'stopped' : intervalId === null ? 'idle' : 'running',
        inFlight,
        lastTickAt,
        lastSuccessAt,
        lastError,
        processedLastTick,
        nextTickIntervalMs: intervalMs,
      }
    },
    close(): void {
      stop()
      database.close()
    },
  }
}
