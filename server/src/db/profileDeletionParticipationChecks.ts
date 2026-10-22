// Самоизтриване на профили — проверки за активно участие, които четат САМО
// споделената SQLite база (видими от всички Node процеси). Ползват се от:
//   * profileDeletionRequestStore.createRequest — ВЪТРЕ в BEGIN IMMEDIATE
//     транзакцията на подаването (Етап 4: затваря race-а между процесите за
//     турнири и персистираните игри);
//   * profileDeletionExecutor — ВЪТРЕ в транзакцията на окончателното
//     изтриване (последна защита преди DELETE FROM profiles).
//
// In-memory състоянието на конкретен процес (чакащи маси, matchmaking) НЕ е
// тук — то се проверява от index.ts (hasProfileActiveGameCommitment) преди
// подаване, при realtime reconcile на всеки процес и от worker-а.
//
// Всички JSON проверки са fail-closed: нечетим snapshot = "има активна игра".

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

/** Mirror на ACTIVE_TOURNAMENT_STATUSES / ACTIVE_ENTRY_STATUSES в profileHardDeleteService.ts. */
const ACTIVE_TOURNAMENT_STATUS_SQL = `'open', 'starting', 'semifinal_in_progress', 'final_in_progress'`
const ACTIVE_ENTRY_STATUS_SQL = `'confirmed', 'finalist'`

export type ProfileDeletionParticipationChecks = {
  /** Белот (active_room_snapshots), Не се сърди човече (active_ludo_match_snapshots), Свара (svara_match_snapshots). */
  hasPersistedActiveGame: (profileId: string) => boolean
  /** Създател на незавършен турнир или активно участие в такъв. */
  hasActiveTournamentDependency: (profileId: string) => boolean
  /** Чакаща покана за турнирен партньор от/към профила (независимо от изтичането — системата я затваря). */
  hasPendingTournamentInvite: (profileId: string) => boolean
}

type BelotSnapshotRoom = {
  status?: string
  seats?: Record<string, {
    participant?: {
      kind?: string
      identity?: { profileId?: string | null }
      publicProfile?: { profileId?: string | null } | null
      permanentlyLeftAt?: number | null
    } | null
  }>
}

export function createProfileDeletionParticipationChecks(database: SqliteDatabase): ProfileDeletionParticipationChecks {
  // instr() е само груб предварителен филтър; истинската проверка е JSON
  // парсване по-долу (mirror на isProfileInActiveGame / ludo players).
  const selectBelotCandidatesStatement = database.prepare(`
    SELECT snapshot_json FROM active_room_snapshots
    WHERE is_active = 1 AND room_status = 'playing' AND instr(snapshot_json, ?) > 0;
  `)

  const selectLudoCandidatesStatement = database.prepare(`
    SELECT snapshot_json FROM active_ludo_match_snapshots
    WHERE is_active = 1 AND match_status = 'in_progress' AND instr(snapshot_json, ?) > 0;
  `)

  // Свара пази всеки мач (lobby и in-progress) — mirror на
  // svaraMatchSnapshotStore.findActiveMatchId (active/absent място = ангажимент).
  // Подготвя се отложено: svara_match_snapshots е схема на feature-а Свара и
  // липсата ѝ НЕ трябва да спира стартирането на платформата (виж
  // check:svara-restart-2b36c). Неуспешна подготовка не се кешира (таблицата
  // може да се появи по-късно) и проверката е fail-closed — виж hasSvaraGame.
  const SELECT_SVARA_CANDIDATES_SQL = `
    SELECT match_status, snapshot_json FROM svara_match_snapshots
    WHERE match_status IN ('lobby', 'in-progress') AND instr(snapshot_json, ?) > 0;
  `
  let selectSvaraCandidatesStatement: ReturnType<SqliteDatabase['prepare']> | null = null

  function getSvaraCandidatesStatement(): ReturnType<SqliteDatabase['prepare']> | null {
    if (selectSvaraCandidatesStatement === null) {
      try {
        selectSvaraCandidatesStatement = database.prepare(SELECT_SVARA_CANDIDATES_SQL)
      } catch {
        return null
      }
    }
    return selectSvaraCandidatesStatement
  }

  const selectActiveCreatorStatement = database.prepare(`
    SELECT 1 FROM tournaments
    WHERE creator_profile_id = ? AND status IN (${ACTIVE_TOURNAMENT_STATUS_SQL})
    LIMIT 1;
  `)

  const selectActiveEntryStatement = database.prepare(`
    SELECT 1
    FROM tournament_entries te
    JOIN tournaments t ON t.tournament_id = te.tournament_id
    WHERE te.profile_id = ?
      AND te.status IN (${ACTIVE_ENTRY_STATUS_SQL})
      AND t.status IN (${ACTIVE_TOURNAMENT_STATUS_SQL})
    LIMIT 1;
  `)

  const selectPendingInviteStatement = database.prepare(`
    SELECT 1 FROM tournament_partner_invites
    WHERE status = 'pending' AND (inviter_profile_id = ? OR invitee_profile_id = ?)
    LIMIT 1;
  `)

  function hasBelotGame(profileId: string): boolean {
    for (const { snapshot_json } of selectBelotCandidatesStatement.all(profileId) as Array<{ snapshot_json: string }>) {
      try {
        const room = JSON.parse(snapshot_json) as BelotSnapshotRoom
        if (room.status !== 'playing' || room.seats === undefined) continue
        for (const seat of Object.values(room.seats)) {
          const participant = seat?.participant
          const participantProfileId = participant?.identity?.profileId ?? participant?.publicProfile?.profileId ?? null
          if (participant?.kind === 'human' && participantProfileId === profileId && participant.permanentlyLeftAt == null) {
            return true
          }
        }
      } catch {
        return true
      }
    }
    return false
  }

  function hasLudoGame(profileId: string): boolean {
    for (const { snapshot_json } of selectLudoCandidatesStatement.all(profileId) as Array<{ snapshot_json: string }>) {
      try {
        const match = JSON.parse(snapshot_json) as { players?: Array<{ profileId?: string }> }
        if (!Array.isArray(match.players) || match.players.some((player) => player?.profileId === profileId)) return true
      } catch {
        return true
      }
    }
    return false
  }

  function hasSvaraGame(profileId: string): boolean {
    // Без проверима схема на Свара не може да се докаже липса на активна
    // игра — fail-closed ("има активна игра"): подаването се отказва, а
    // worker-ът блокира и опитва отново.
    const statement = getSvaraCandidatesStatement()
    if (statement === null) return true
    let rows: Array<{ match_status: string; snapshot_json: string }>
    try {
      rows = statement.all(profileId) as Array<{ match_status: string; snapshot_json: string }>
    } catch {
      return true
    }
    for (const { snapshot_json } of rows) {
      try {
        const snapshot = JSON.parse(snapshot_json) as { state?: { seats?: unknown; status?: Record<string, unknown> } }
        const seats = snapshot.state?.seats
        const status = snapshot.state?.status
        if (!Array.isArray(seats) || status === undefined || status === null || typeof status !== 'object') return true
        if (seats.includes(profileId) && (status[profileId] === 'active' || status[profileId] === 'absent')) return true
      } catch {
        return true
      }
    }
    return false
  }

  return {
    hasPersistedActiveGame: (profileId) => hasBelotGame(profileId) || hasLudoGame(profileId) || hasSvaraGame(profileId),
    hasActiveTournamentDependency: (profileId) =>
      selectActiveCreatorStatement.get(profileId) !== undefined || selectActiveEntryStatement.get(profileId) !== undefined,
    hasPendingTournamentInvite: (profileId) => selectPendingInviteStatement.get(profileId, profileId) !== undefined,
  }
}
