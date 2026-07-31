export type AdminTournamentIntegrityState = 'healthy' | 'warning' | 'error'

export type AdminTournamentIntegrityIssue = {
  code: string
  severity: 'warning' | 'error'
  recoverable: boolean
  summary: string
}

export type AdminTournamentSummaryRow = {
  tournamentId: string
  name: string
  creator: { profileId: string; displayName: string; avatarUrl: string | null }
  visibility: 'public' | 'password'
  entryFee: number
  participantsCount: number
  currentStage: string
  status: string
  settlementState: 'pending' | 'settled'
  createdAt: string
  scheduledStartAt: string | null
  finishedAt: string | null
  integrity: {
    state: AdminTournamentIntegrityState
    issues: AdminTournamentIntegrityIssue[]
  }
}

export type AdminTournamentDetailRow = AdminTournamentSummaryRow & {
  startedAt: string | null
  rulesVersion: string | null
  teams: Array<{
    teamId: string
    seedSlot: number | null
    status: string
    members: Array<{
      profileId: string
      displayName: string
      avatarUrl: string | null
      joinedAs: string
      entryStatus: string
      paidEntry: boolean
    }>
  }>
  bracket: Array<{
    matchId: string
    roundType: 'semifinal' | 'final'
    roundIndex: number
    teamAId: string
    teamBId: string
    status: string
    roomReady: boolean
    resultKind: string | null
    winnerTeamId: string | null
    loserTeamId: string | null
    played: boolean
    playedWithBots: boolean
    walkover: boolean
    attendanceResolution: string | null
    replacementCount: number
    takeoverCount: number
    roomSnapshotRecoverable: boolean
  }>
  finance: {
    totalEntry: number | null
    systemFee: number | null
    prizePool: number | null
    winnerTeamPrize: number | null
    winnerPlayerPrize: number | null
    runnerUpTeamPrize: number | null
    runnerUpPlayerPrize: number | null
    entryDebitCount: number
    entryDebitSum: number
    refundCount: number
    refundSum: number
    systemFeeLedgerPresent: boolean
    prizePayoutCount: number
    prizePayoutSum: number
    settlementIntegrity: AdminTournamentIntegrityState
  }
  events: {
    page: number
    limit: number
    totalCount: number
    rows: Array<{ eventType: string; summary: string; createdAt: string }>
  }
  operations: {
    coordinatorState: string | null
    schedulerState: string | null
    roomAssignmentsRecoverable: boolean
  }
  actions: {
    canReconcile: boolean
    canCancelOpen: boolean
    cancelRefundTotal: number
  }
}

export type AdminTournamentFilters = {
  page: number
  limit: number
  status: string
  settlementState: string
  visibility: string
  startMode: string
  integrityState: string
  search: string
}
