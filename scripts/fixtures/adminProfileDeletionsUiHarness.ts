// Етап 4J — browser harness (checkAdminProfileDeletionsUi.ts). Ползва ДИРЕКТНО
// реалния production код (showAdminProfileDeletionsPanel); сървърът е заместен
// от контролируеми отговори — HTTP/правата са покрити от
// server/scripts/checkProfileDeletionAdminOversight.ts.
import {
  showAdminProfileDeletionsPanel,
  type AdminProfileDeletionFilters,
  type AdminProfileDeletionRow,
} from '/src/app/adminProfileDeletions/showAdminProfileDeletionsPanel.ts'

type CancelResult = { ok: true; state?: 'cancelled' | 'pending_confirmation' } | { ok: false; code: string | null; message: string }

const calls: Array<{ name: string; args: unknown[] }> = []
let rows: AdminProfileDeletionRow[] = []
let listFailure: string | null = null
let cancelMode: 'ok' | 'manual' | CancelResult = 'ok'
let pendingCancel: ((result: CancelResult) => void) | null = null
let panel: { close: () => void } | null = null

function base(overrides: Partial<AdminProfileDeletionRow>): AdminProfileDeletionRow {
  return {
    kind: 'voluntary',
    operationId: 'req-x',
    category: 'pending_cancellable',
    status: 'pending',
    profile: null,
    requestedAt: '2026-10-20T10:00:00.000Z',
    scheduledFor: '2026-11-19T10:00:00.000Z',
    gracePeriodDays: 30,
    cancelledAt: null,
    cancelledBy: null,
    completedAt: null,
    dbDeletedAt: null,
    lastErrorCode: null,
    nextAttemptAt: null,
    attemptCount: 0,
    filesPending: 0,
    filesFailed: 0,
    fileCleanupStatus: null,
    awaitingOffsite: false,
    adminCancellation: null,
    canCancel: false,
    cancelBlocker: null,
    ...overrides,
  }
}

function sampleRows(): AdminProfileDeletionRow[] {
  return [
    base({ operationId: 'req-window', profile: { profileId: 'p1', displayName: 'Иван Тестов', email: 'ivan@example.test' }, canCancel: true }),
    base({ operationId: 'req-legacy', profile: { profileId: 'p2', displayName: 'Стар Профил' }, gracePeriodDays: 45, scheduledFor: '2026-12-01T10:00:00.000Z', canCancel: true }),
    base({ operationId: 'req-overdue', category: 'pending_overdue', profile: { profileId: 'p3', displayName: 'Просрочен' }, canCancel: true }),
    base({ operationId: 'req-ban', category: 'blocked_ban', status: 'blocked', lastErrorCode: 'active_ban', attemptCount: 2, nextAttemptAt: '2026-10-25T10:00:00.000Z', profile: { profileId: 'p4', displayName: 'Баннат' }, canCancel: true }),
    base({ operationId: 'req-offsite', category: 'awaiting_offsite', status: 'blocked', lastErrorCode: 'ledger_offsite_pending', profile: { profileId: 'p5', displayName: 'Чака Офсайт' }, canCancel: true }),
    // Етап 4J1 — приета отмяна, чака offsite потвърждение.
    base({ operationId: 'req-pending-cancel', category: 'cancellation_pending', profile: { profileId: 'p11', displayName: 'Потвърждава Се' }, cancellation: { source: 'user', acceptedAt: '2026-10-23T09:00:00.000Z', stage: 'awaiting_offsite', recoveredFromLedger: false }, cancelBlocker: 'cancellation_pending' }),
    base({ operationId: 'req-game', category: 'blocked_participation', status: 'blocked', lastErrorCode: 'active_game_local', profile: { profileId: 'p6', displayName: 'В Игра' }, canCancel: true }),
    base({ operationId: 'req-exec', category: 'executing', status: 'executing', profile: { profileId: 'p7', displayName: 'Изпълнява' }, cancelBlocker: 'lease_held' }),
    base({ operationId: 'req-files', category: 'files_pending', status: 'failed', lastErrorCode: 'files_pending', dbDeletedAt: '2026-10-22T10:00:00.000Z', filesPending: 2, filesFailed: 1, cancelBlocker: 'irreversible' }),
    base({ operationId: 'req-done', category: 'completed', status: 'completed', completedAt: '2026-10-21T10:00:00.000Z', dbDeletedAt: '2026-10-21T10:00:00.000Z', cancelBlocker: 'irreversible' }),
    base({ operationId: 'req-cancelled', category: 'cancelled', status: 'cancelled', cancelledAt: '2026-10-21T12:00:00.000Z', cancelledBy: 'admin', profile: { profileId: 'p8', displayName: 'Запазен' }, adminCancellation: { reason: 'Потвърди по телефона', createdAt: '2026-10-21T12:00:00.000Z', actorDisplayName: 'Главен Админ' }, cancelBlocker: 'status_not_cancellable' }),
    base({ operationId: 'adm-pending', kind: 'admin', category: 'admin_scheduled', status: 'scheduled', scheduledFor: null, gracePeriodDays: null, attemptCount: null, profile: { profileId: 'p9', displayName: 'Административна Цел' }, awaitingOffsite: true, cancelBlocker: 'not_voluntary' }),
    base({ operationId: 'adm-done', kind: 'admin', category: 'completed', status: 'completed', requestedAt: null, scheduledFor: null, gracePeriodDays: null, attemptCount: null, completedAt: '2026-10-19T10:00:00.000Z', dbDeletedAt: '2026-10-19T10:00:00.000Z', fileCleanupStatus: 'done', cancelBlocker: 'not_voluntary' }),
    base({ operationId: 'req-xss', profile: { profileId: 'p10', displayName: '<img src=x onerror="window.__xss=1">', email: '<img src=x onerror="window.__xss=2">@example.test' }, canCancel: true }),
  ]
}

const fetchList = async (filters: AdminProfileDeletionFilters) => {
  calls.push({ name: 'fetchList', args: [filters] })
  if (listFailure !== null) return { ok: false as const, message: listFailure }
  // Емулира филтрите на сървъра.
  const filtered = rows.filter((row) => (filters.kind === '' || row.kind === filters.kind) && (filters.category === '' || row.category === filters.category))
  return { ok: true as const, rows: filtered, limit: 300 }
}

const cancelRequest = (requestId: string, reason: string): Promise<CancelResult> => {
  calls.push({ name: 'cancelRequest', args: [requestId, reason] })
  if (cancelMode === 'manual') return new Promise((resolve) => { pendingCancel = resolve })
  if (cancelMode === 'ok') {
    // Етап 4J1 — като сървъра: приета, окончателна след offsite потвърждение.
    rows = rows.map((row) => row.operationId === requestId ? { ...row, category: 'cancellation_pending', canCancel: false, cancelBlocker: 'cancellation_pending', cancellation: { source: 'admin', acceptedAt: new Date().toISOString(), stage: 'awaiting_offsite', recoveredFromLedger: false }, adminCancellation: { reason, createdAt: new Date().toISOString(), actorDisplayName: 'Главен Админ' } } : row)
    return Promise.resolve({ ok: true, state: 'pending_confirmation' })
  }
  return Promise.resolve(cancelMode)
}

;(window as any).__adminDeletionsHarness = {
  open: (input: { failList?: string } = {}) => {
    rows = sampleRows()
    listFailure = input.failList ?? null
    calls.length = 0
    panel = showAdminProfileDeletionsPanel({ fetchList, cancelRequest })
  },
  close: () => { panel?.close(); panel = null },
  setCancelMode: (mode: 'ok' | 'manual' | CancelResult) => { cancelMode = mode },
  resolveCancel: (result: CancelResult) => { pendingCancel?.(result); pendingCancel = null },
  getCalls: () => calls.map((call) => ({ name: call.name, args: call.args })),
  clearCalls: () => { calls.length = 0 },
}
