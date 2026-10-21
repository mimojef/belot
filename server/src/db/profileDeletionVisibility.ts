// Самоизтриване на профили — Етап 2: централен механизъм за публичната
// видимост на профили с активна заявка за изтриване.
//
// Източникът на истината е profile_deletion_requests (миграция
// 20261024_001). profiles.status НАРОЧНО не се променя: вътрешните операции
// (admin, финансови регистри, кредитиране след плащане, диагностика,
// retention задачи) продължават да четат профила през непроменения
// playerProgressStore.getPublicProfile(), а публичните пътища (видимост за
// ДРУГИ потребители) минават през този модул. Резервацията на имейла и името
// през 45-дневния период остава автоматична, защото редовете в
// accounts/profiles не се пипат.
//
// "Скрит" = има заявка в активен статус (pending/executing/blocked/failed) —
// точно статусите на partial unique индекса
// idx_profile_deletion_requests_active_profile, затова всяка проверка е
// индексирано търсене в малко множество. cancelled възстановява видимостта
// веднага; completed означава, че профилът вече не съществува.

import { PROFILE_DELETION_ACTIVE_REQUEST_STATUSES } from './profileDeletionSchedule.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export const PROFILE_DELETION_HIDDEN_STATUSES = PROFILE_DELETION_ACTIVE_REQUEST_STATUSES

const HIDDEN_STATUS_SQL_LIST = PROFILE_DELETION_HIDDEN_STATUSES.map((status) => `'${status}'`).join(', ')

const SQL_COLUMN_REFERENCE_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/

/**
 * SQL предикат "профилът в колона profileIdColumn НЕ е скрит" — за публични
 * списъчни заявки (търсене, класации, списък с играчи...). profileIdColumn е
 * идентификатор от кода (напр. 'p.profile_id'), никога потребителски вход.
 */
export function sqlProfileVisibleForDeletion(profileIdColumn: string): string {
  if (!SQL_COLUMN_REFERENCE_RE.test(profileIdColumn)) {
    throw new Error(`Невалидна SQL колона: ${profileIdColumn}`)
  }
  return `NOT EXISTS (
    SELECT 1 FROM profile_deletion_requests pdr_visibility
    WHERE pdr_visibility.profile_id = ${profileIdColumn}
      AND pdr_visibility.status IN (${HIDDEN_STATUS_SQL_LIST})
  )`
}

export type ProfileDeletionVisibilityReader = {
  isProfileHidden: (profileId: string) => boolean
  /** Всички скрити profileId-та — малко множество, за exclusion списъци (Теми, лоби чат). */
  listHiddenProfileIds: () => string[]
  /**
   * true, ако uploadPath (pathname под /uploads/) е снимка от галерията на
   * скрит профил. Аватарите НАРОЧНО не се крият (Етап 3): изрично
   * разрешените изключения — историята на завършени турнири и
   * "Приключили" частни маси (2 часа) — показват аватара на участника.
   * Самият профил (и галерията) остава недостъпен.
   */
  isUploadPathHidden: (uploadPathname: string) => boolean
}

export function createProfileDeletionVisibilityReader(database: SqliteDatabase): ProfileDeletionVisibilityReader {
  const selectHiddenStatement = database.prepare(`
    SELECT 1 FROM profile_deletion_requests
    WHERE profile_id = ?
      AND status IN (${HIDDEN_STATUS_SQL_LIST})
    LIMIT 1;
  `)

  const listHiddenStatement = database.prepare(`
    SELECT DISTINCT profile_id FROM profile_deletion_requests
    WHERE status IN (${HIDDEN_STATUS_SQL_LIST});
  `)

  function isProfileHidden(profileId: string): boolean {
    if (profileId.length === 0) return false
    return selectHiddenStatement.get(profileId) !== undefined
  }

  function listHiddenProfileIds(): string[] {
    return (listHiddenStatement.all() as Array<{ profile_id: string }>).map((row) => row.profile_id)
  }

  function isUploadPathHidden(uploadPathname: string): boolean {
    let decoded: string
    try {
      decoded = decodeURIComponent(uploadPathname)
    } catch {
      return false
    }

    const galleryMatch = /^\/uploads\/profile-gallery\/([^/]+)\//.exec(decoded)
    if (galleryMatch !== null) {
      return isProfileHidden(galleryMatch[1])
    }

    return false
  }

  return { isProfileHidden, listHiddenProfileIds, isUploadPathHidden }
}
