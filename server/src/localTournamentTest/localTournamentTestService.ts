// Оркестрация за strictly-local турнирния тестов режим (виж
// docs/local-tournament-test.md и localTournamentTestModeGuard.ts).
//
// НЕ дублира coordinator/gameplay логика — само:
//  - създава тестов турнир през РЕАЛНИЯ tournamentStore.createTournament
//    (същия код path като POST /api/tournaments);
//  - записва участници през РЕАЛНИЯ tournamentEconomyStore.joinTournamentSoloAtomically/
//    createPartnerInviteAtomically/acceptPartnerInviteAtomically (същите
//    функции, които реалният join/partner-invite HTTP flow ползва);
//  - оставя startMode:'fill' да задейства РЕАЛНИЯ tournamentScheduler, който
//    вика РЕАЛНИЯ tournamentCoordinator — bracket/attendance/gameplay/
//    settlement/cleanup минават изцяло през production кода.
//
// Bot участниците НЕ се създават тук — преизползват се съществуващите ~300
// catalog bot профила (profile_kind='bot'), които сървърът вече seed-ва при
// всеки старт (playerProgressStore.seedCatalogBotsIfNeeded, index.ts).
// Реалният no-show/bot-fill механизъм на coordinator-а (виж
// tournamentCoordinator.ts resolveAttendance) е този, който реално ги сяда
// да играят — тук само ги записваме като участници, никога не connect-ваме
// фалшив WS за тях.

import { DatabaseSync } from 'node:sqlite'
import type { ProfileId } from '../core/serverTypes.js'
import type { AuthStore } from '../db/authStore.js'
import type { TournamentStore } from '../db/tournamentStore.js'
import type { TournamentEconomyStore } from '../db/tournamentEconomyStore.js'
import type {
  TournamentEntryRecord,
  TournamentMatchRecord,
  TournamentRecord,
  TournamentRoundRecord,
  TournamentTeamRecord,
} from '../tournament/tournamentTypes.js'

export type LocalTournamentTestParticipantMode = 'one_human' | 'all_bots' | 'two_humans'
export type LocalTournamentTestTeamCapacity = 4 | 8 | 16

const TEST_TOURNAMENT_NAME_MARKER = '[local-test:'
/** IANA-reserved TLD (.invalid, RFC 2606) — гарантирано никога не е реален,
 * регистрируем домейн, затова е безопасен, еднозначен маркер за reset scope
 * (виж §12 в task spec-а: "Използвай marker/namespace"). */
const TEST_ACCOUNT_EMAIL_DOMAIN = 'local.belot-tournament-test.invalid'
const TEST_ENTRY_FEE = 5000

export type LocalTournamentTestCredential = {
  email: string
  password: string
  displayName: string
  profileId: ProfileId
}

export type CreateLocalTestTournamentInput = {
  teamCapacity: LocalTournamentTestTeamCapacity
  mode: LocalTournamentTestParticipantMode
  scenarioHint?: string
}

export type CreateLocalTestTournamentResult =
  | {
      ok: true
      runId: string
      tournamentId: string
      tournamentName: string
      playerCapacity: number
      humanCredentials: LocalTournamentTestCredential[]
      scenarioGuidance: string
    }
  | { ok: false; reason: string }

export type LocalTournamentTestTechnicalMatch = TournamentMatchRecord & {
  roundType: string
  roundIndex: number
}

export type LocalTournamentTestTechnicalState = {
  tournament: TournamentRecord
  teams: TournamentTeamRecord[]
  entries: TournamentEntryRecord[]
  rounds: TournamentRoundRecord[]
  matches: LocalTournamentTestTechnicalMatch[]
}

export type LocalTournamentTestResetResult = {
  tournamentsRemoved: number
  profilesRemoved: number
}

export type LocalTournamentTestServiceDeps = {
  databaseFilePath: string
  tournamentStore: TournamentStore
  tournamentEconomyStore: TournamentEconomyStore
  authStore: AuthStore
  refillCatalogBotWallets: () => void
  /** Ако мачът вече има runtime room (roomId), премахва я по същия детерминиран
   * път, който coordinator-ът ползва за completed турнирни стаи
   * (serverState/activeRoomRuntime/active_room_snapshots) — no-op, ако
   * стаята вече не съществува. Подадено от index.ts. */
  removeTournamentRoomIfPresent: (roomId: string) => void
}

export type LocalTournamentTestService = {
  createTournament: (input: CreateLocalTestTournamentInput) => CreateLocalTestTournamentResult
  getTechnicalState: (tournamentId: string) => LocalTournamentTestTechnicalState | null
  listTestTournaments: () => TournamentRecord[]
  reset: () => LocalTournamentTestResetResult
}

function randomRunId(): string {
  return Math.random().toString(36).slice(2, 8)
}

function scenarioGuidanceText(mode: LocalTournamentTestParticipantMode, scenarioHint: string | undefined): string {
  const base =
    mode === 'all_bots'
      ? 'Всички 8/16/32 места са запълнени с catalog ботове — никой не се свързва по WS. ' +
        'Реалният attendance/no-show механизъм ще запълни всеки мач с играещи ботове (bots_inserted), ' +
        'играта ще протече докрай сама, без ръчна намеса.'
      : mode === 'two_humans'
        ? 'Двамата тестови човешки профила са в един и същ отбор (реален partner-invite). ' +
          'Ако не влезеш и с двата профила в мача преди attendance deadline-а, отсрещният ' +
          '(изцяло бот) отбор ще отсъства изцяло и мачът ще приключи със служебна победа за твоя отбор — ' +
          'това е коректното текущо production поведение на no-show правилото, не бъг на харнеса.'
        : 'Тестовият човешки профил е в произволен отбор с останалите ботове. ' +
          'Влез през реалния клиент (Турнири екран → Влез в масата) преди attendance deadline-а, ' +
          'за да играеш реално рамо до рамо с бот партньор срещу бот противници.'
  if (scenarioHint === undefined || scenarioHint.trim() === '') return base
  return `${base} Сценарий: ${scenarioHint}`
}

export function createLocalTournamentTestService(
  deps: LocalTournamentTestServiceDeps,
): LocalTournamentTestService {
  function ensureTestHumanAccount(runId: string, suffix: string): LocalTournamentTestCredential {
    const email = `test-human-${runId}-${suffix}@${TEST_ACCOUNT_EMAIL_DOMAIN}`
    const password = `LocalTournamentTest-${runId}!`
    // displayName минава през реалната production валидация (само букви
    // кирилица/латиница, цифри и по един интервал между думите — виж
    // authStore.register) — без тире/interpunkt, затова runId+suffix се
    // слепват в едно "дума" вместо да се разделят с "-".
    const displayName = `Test Human ${runId}${suffix}`.slice(0, 24)
    const registerResult = deps.authStore.register({ email, password, displayName, gender: 'male' })
    if (!registerResult.ok) {
      throw new Error(`Failed to create local test human account "${email}": ${registerResult.message}`)
    }
    const profileId = registerResult.session.profile.profileId
    if (profileId === null) {
      throw new Error(`Local test human account "${email}" was created without a profile id.`)
    }
    return { email, password, displayName, profileId }
  }

  function pickAvailableCatalogBotProfileIds(count: number): ProfileId[] {
    const db = new DatabaseSync(deps.databaseFilePath, { open: true })
    try {
      db.exec('PRAGMA busy_timeout = 5000;')
      // Изключва ботове, вече записани в турнир, който все още не е
      // завършил/отменен — избягва "already_participating_elsewhere" при
      // повторни бързи create извиквания, без да пипа глобалната уникалност.
      const rows = db
        .prepare(
          `
          SELECT p.profile_id AS profile_id
          FROM profiles p
          WHERE p.profile_kind = 'bot'
            AND p.status = 'active'
            AND NOT EXISTS (
              SELECT 1
              FROM tournament_entries te
              JOIN tournaments t ON t.tournament_id = te.tournament_id
              WHERE te.profile_id = p.profile_id
                AND te.status = 'confirmed'
                AND t.status NOT IN ('finished', 'cancelled', 'admin_cancelled', 'auto_cancelled', 'failed')
            )
          ORDER BY RANDOM()
          LIMIT ?;
        `,
        )
        .all(count) as Array<{ profile_id: string }>
      return rows.map((row) => row.profile_id)
    } finally {
      db.close()
    }
  }

  function createTournament(input: CreateLocalTestTournamentInput): CreateLocalTestTournamentResult {
    const runId = randomRunId()
    const playerCapacity = input.teamCapacity * 2
    const humanSlotCount = input.mode === 'all_bots' ? 0 : input.mode === 'two_humans' ? 2 : 1
    const botSlotCount = playerCapacity - humanSlotCount

    try {
      const humanCredentials: LocalTournamentTestCredential[] = []
      for (let i = 0; i < humanSlotCount; i += 1) {
        humanCredentials.push(ensureTestHumanAccount(runId, String(i + 1)))
      }

      const botProfileIds = pickAvailableCatalogBotProfileIds(botSlotCount)
      if (botProfileIds.length < botSlotCount) {
        return {
          ok: false,
          reason: `Not enough free catalog bot profiles available (needed ${botSlotCount}, found ${botProfileIds.length}). ` +
            `Run reset (§12) to release bots held by a previous test run.`,
        }
      }

      const creatorProfileId = humanCredentials[0]?.profileId ?? botProfileIds[0]
      if (creatorProfileId === undefined) {
        return { ok: false, reason: 'Could not determine a creator profile for the test tournament.' }
      }

      const tournamentName = `${TEST_TOURNAMENT_NAME_MARKER}${runId}] ${input.teamCapacity}т/${input.mode}`
      const createResult = deps.tournamentStore.createTournament({
        kind: 'community',
        name: tournamentName,
        creatorProfileId,
        visibility: 'public',
        passwordHash: null,
        entryFee: TEST_ENTRY_FEE,
        playerCapacity,
        startMode: 'fill',
        scheduledStartAt: null,
      })
      if (!createResult.ok) {
        return { ok: false, reason: `tournamentStore.createTournament failed: ${createResult.reason}` }
      }
      const tournamentId = createResult.tournament.tournamentId

      deps.tournamentStore.appendTournamentEvent({
        tournamentId,
        eventType: 'tournament_created',
        actorProfileId: creatorProfileId,
        actorRole: 'system',
        payload: { source: 'local_tournament_test', runId, mode: input.mode },
      })

      if (input.mode === 'two_humans') {
        const [inviter, invitee] = humanCredentials
        if (inviter === undefined || invitee === undefined) {
          return { ok: false, reason: 'two_humans mode requires exactly two human credentials.' }
        }
        const inviteResult = deps.tournamentEconomyStore.createPartnerInviteAtomically(
          tournamentId,
          inviter.profileId,
          invitee.profileId,
        )
        if (!inviteResult.ok) {
          return { ok: false, reason: `createPartnerInviteAtomically failed: ${inviteResult.reason}` }
        }
        const acceptResult = deps.tournamentEconomyStore.acceptPartnerInviteAtomically(
          tournamentId,
          inviteResult.invite.inviteId,
          invitee.profileId,
        )
        if (!acceptResult.ok) {
          return { ok: false, reason: `acceptPartnerInviteAtomically failed: ${acceptResult.reason}` }
        }
      } else {
        for (const human of humanCredentials) {
          const joinResult = deps.tournamentEconomyStore.joinTournamentSoloAtomically(tournamentId, human.profileId)
          if (!joinResult.ok) {
            return { ok: false, reason: `human joinTournamentSoloAtomically failed: ${joinResult.reason}` }
          }
        }
      }

      for (const botProfileId of botProfileIds) {
        const joinResult = deps.tournamentEconomyStore.joinTournamentSoloAtomically(tournamentId, botProfileId)
        if (!joinResult.ok) {
          return { ok: false, reason: `bot joinTournamentSoloAtomically failed for ${botProfileId}: ${joinResult.reason}` }
        }
      }

      return {
        ok: true,
        runId,
        tournamentId,
        tournamentName,
        playerCapacity,
        humanCredentials,
        scenarioGuidance: scenarioGuidanceText(input.mode, input.scenarioHint),
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  function getTechnicalState(tournamentId: string): LocalTournamentTestTechnicalState | null {
    const tournament = deps.tournamentStore.getTournamentById(tournamentId)
    if (tournament === null) return null
    const rounds = deps.tournamentStore.getRoundsForTournament(tournamentId)
    const roundById = new Map(rounds.map((round) => [round.roundId, round]))
    const matches = deps.tournamentStore.getMatchesForTournament(tournamentId).map((match) => {
      const round = roundById.get(match.roundId)
      return { ...match, roundType: round?.roundType ?? 'unknown', roundIndex: round?.roundIndex ?? 0 }
    })
    return {
      tournament,
      teams: deps.tournamentStore.getTeamsForTournament(tournamentId),
      entries: deps.tournamentStore.getEntriesForTournament(tournamentId),
      rounds,
      matches,
    }
  }

  function listTestTournaments(): TournamentRecord[] {
    return deps.tournamentStore
      .listTournaments({ limit: 100, offset: 0, orderBy: 'created_desc' })
      .filter((tournament) => tournament.name.startsWith(TEST_TOURNAMENT_NAME_MARKER))
  }

  function reset(): LocalTournamentTestResetResult {
    const db = new DatabaseSync(deps.databaseFilePath, { open: true })
    let tournamentsRemoved = 0
    let profilesRemoved = 0
    try {
      db.exec('PRAGMA busy_timeout = 5000;')
      db.exec('PRAGMA foreign_keys = ON;')

      const testTournamentRows = db
        .prepare(`SELECT tournament_id FROM tournaments WHERE name LIKE ?;`)
        .all(`${TEST_TOURNAMENT_NAME_MARKER}%`) as Array<{ tournament_id: string }>

      const selectRoomsStatement = db.prepare(
        `SELECT room_id FROM tournament_matches WHERE tournament_id = ? AND room_id IS NOT NULL;`,
      )
      const deleteTournamentStatement = db.prepare(`DELETE FROM tournaments WHERE tournament_id = ?;`)

      for (const row of testTournamentRows) {
        const roomRows = selectRoomsStatement.all(row.tournament_id) as Array<{ room_id: string }>
        for (const roomRow of roomRows) {
          deps.removeTournamentRoomIfPresent(roomRow.room_id)
        }
        db.exec('BEGIN IMMEDIATE;')
        try {
          deleteTournamentStatement.run(row.tournament_id)
          db.exec('COMMIT;')
          tournamentsRemoved += 1
        } catch (error) {
          try {
            db.exec('ROLLBACK;')
          } catch {
            // ignore — surface the original error below
          }
          throw error
        }
      }

      const testAccountRows = db
        .prepare(`SELECT account_id FROM accounts WHERE email LIKE ?;`)
        .all(`%@${TEST_ACCOUNT_EMAIL_DOMAIN}`) as Array<{ account_id: string }>

      const selectProfilesForAccountStatement = db.prepare(
        `SELECT profile_id FROM profiles WHERE account_id = ?;`,
      )
      const deleteProfileStatement = db.prepare(`DELETE FROM profiles WHERE profile_id = ?;`)
      const deleteAccountStatement = db.prepare(`DELETE FROM accounts WHERE account_id = ?;`)

      for (const row of testAccountRows) {
        db.exec('BEGIN IMMEDIATE;')
        try {
          const profileRows = selectProfilesForAccountStatement.all(row.account_id) as Array<{ profile_id: string }>
          for (const profileRow of profileRows) {
            deleteProfileStatement.run(profileRow.profile_id)
            profilesRemoved += 1
          }
          deleteAccountStatement.run(row.account_id)
          db.exec('COMMIT;')
        } catch (error) {
          try {
            db.exec('ROLLBACK;')
          } catch {
            // ignore — surface the original error below
          }
          throw error
        }
      }
    } finally {
      db.close()
    }

    // Тестовите ботове са споделен catalog ресурс (използван и от обикновено
    // matchmaking fill) — връщаме им баланса към нормалната цел вместо да ги
    // оставим "изтощени" след няколко теста (реизползва production логиката,
    // не я дублира).
    deps.refillCatalogBotWallets()

    return { tournamentsRemoved, profilesRemoved }
  }

  return { createTournament, getTechnicalState, listTestTournaments, reset }
}
