// Самоизтриване на профили — чисти, детерминирани помощни функции за срока
// за отмяна и статусните преходи на profile_deletion_requests /
// profile_deletion_file_queue (виж миграции
// 20261024_001_create_profile_deletion_infrastructure.sql и
// 20261101_001_voluntary_deletion_30_day_grace_period.sql).
//
// Таблиците на преходите тук са огледало на тригерите в миграциите;
// scripts/checkProfileDeletionInfrastructure.ts сравнява двете за всички
// двойки статуси, за да не се разминат. Срокът се ползва от
// profileDeletionRequestStore при подаване на заявка.
//
// Всички времена са каноничен UTC ISO-8601 с милисекунди
// ('YYYY-MM-DDTHH:MM:SS.sssZ') — формата на Date.prototype.toISOString() и на
// strftime('%Y-%m-%dT%H:%M:%fZ', 'now') в SQLite. Часовата зона на процеса
// (TZ) не влияе на изчисленията.

// Етап 4G — срокът за отмяна на НОВА доброволна заявка: точно 30 × 24 часа
// (2 592 000 секунди). Единственият източник на стойността в кода; базата я
// налага чрез insert guard-а (grace_period_days = 30).
export const PROFILE_DELETION_GRACE_PERIOD_DAYS = 30
export const PROFILE_DELETION_GRACE_PERIOD_MS = PROFILE_DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000

// Заявки, подадени преди Етап 4G, пазят оригиналния си 45-дневен срок
// (grace_period_days = 45 в базата). Нов код НЕ създава такива заявки —
// стойността е само за разпознаване/диагностика на историческите редове.
export const PROFILE_DELETION_LEGACY_GRACE_PERIOD_DAYS = 45

export const PROFILE_DELETION_REQUEST_STATUSES = [
  'pending',
  'cancelled',
  'executing',
  'completed',
  'blocked',
  'failed',
] as const

export type ProfileDeletionRequestStatus = (typeof PROFILE_DELETION_REQUEST_STATUSES)[number]

/** Статусите, покрити от partial unique индекса (най-много една активна заявка на профил). */
export const PROFILE_DELETION_ACTIVE_REQUEST_STATUSES: readonly ProfileDeletionRequestStatus[] = [
  'pending',
  'executing',
  'blocked',
  'failed',
]

const ALLOWED_REQUEST_TRANSITIONS: Record<ProfileDeletionRequestStatus, readonly ProfileDeletionRequestStatus[]> = {
  pending: ['cancelled', 'executing'],
  executing: ['completed', 'pending', 'blocked', 'failed'],
  blocked: ['executing'],
  failed: ['executing'],
  cancelled: [],
  completed: [],
}

export function isAllowedProfileDeletionTransition(
  from: ProfileDeletionRequestStatus,
  to: ProfileDeletionRequestStatus,
): boolean {
  return from !== to && ALLOWED_REQUEST_TRANSITIONS[from].includes(to)
}

export const PROFILE_DELETION_FILE_STATUSES = [
  'pending',
  'processing',
  'done',
  'skipped_shared',
  'failed',
] as const

export type ProfileDeletionFileStatus = (typeof PROFILE_DELETION_FILE_STATUSES)[number]

const ALLOWED_FILE_TRANSITIONS: Record<ProfileDeletionFileStatus, readonly ProfileDeletionFileStatus[]> = {
  pending: ['processing'],
  processing: ['done', 'skipped_shared', 'failed', 'pending'],
  failed: ['processing'],
  done: [],
  skipped_shared: [],
}

export function isAllowedProfileDeletionFileTransition(
  from: ProfileDeletionFileStatus,
  to: ProfileDeletionFileStatus,
): boolean {
  return from !== to && ALLOWED_FILE_TRANSITIONS[from].includes(to)
}

const CANONICAL_UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function isCanonicalUtcIsoTimestamp(value: string): boolean {
  if (!CANONICAL_UTC_ISO_RE.test(value)) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function parseCanonicalUtcIso(value: string): number {
  if (!isCanonicalUtcIsoTimestamp(value)) {
    throw new Error(`Невалиден UTC timestamp: ${value}`)
  }
  return Date.parse(value)
}

/**
 * requested_at + точно PROFILE_DELETION_GRACE_PERIOD_DAYS × 24 часа в UTC
 * (реално изминало време, не "календарни дни" в локална зона — при смяна на
 * лятно/зимно време локалният час на изтичане се измества с 1 ч, но реалната
 * продължителност остава еднаква за всички).
 */
export function computeProfileDeletionSchedule(requestedAt: Date): { requestedAt: string; scheduledFor: string } {
  const requestedAtMs = requestedAt.getTime()
  if (!Number.isFinite(requestedAtMs)) {
    throw new Error('Невалидна дата на заявката.')
  }
  return {
    requestedAt: new Date(requestedAtMs).toISOString(),
    scheduledFor: new Date(requestedAtMs + PROFILE_DELETION_GRACE_PERIOD_MS).toISOString(),
  }
}

/** Окончателното изтриване може да започне от момента scheduled_for нататък (включително). */
export function isProfileDeletionDue(scheduledFor: string, now: Date): boolean {
  return now.getTime() >= parseCanonicalUtcIso(scheduledFor)
}

/** Отмяната е възможна строго преди scheduled_for — точно допълнение на isProfileDeletionDue. */
export function isProfileDeletionCancellable(scheduledFor: string, now: Date): boolean {
  return now.getTime() < parseCanonicalUtcIso(scheduledFor)
}

export function getProfileDeletionRemainingMs(scheduledFor: string, now: Date): number {
  return Math.max(0, parseCanonicalUtcIso(scheduledFor) - now.getTime())
}

export const PROFILE_DELETION_RETRY_BASE_DELAY_MS = 5 * 60 * 1000
export const PROFILE_DELETION_RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1000

/** Експоненциално изчакване след неуспешен опит №attemptCount (1, 2, 3...): 5 мин, 10 мин, 20 мин... до 6 ч. */
export function computeProfileDeletionRetryDelayMs(attemptCount: number): number {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new Error(`Невалиден брой опити: ${attemptCount}`)
  }
  const exponent = Math.min(attemptCount - 1, 30)
  return Math.min(PROFILE_DELETION_RETRY_BASE_DELAY_MS * 2 ** exponent, PROFILE_DELETION_RETRY_MAX_DELAY_MS)
}
