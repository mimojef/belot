// Централни feature flag-ове за самоизтриване на профили. ЕДИНСТВЕНОТО място,
// което чете PROFILE_SELF_DELETION_ENABLED и PROFILE_SELF_DELETION_WORKER_ENABLED
// (mirror на belotSpectatorFeatureFlag.ts).
//
// И двата са изключени по подразбиране: активни САМО при точно "1". НЕ се
// включват в продукция, докато не са изрично разрешени.
//
// Семантика:
//   * PROFILE_SELF_DELETION_ENABLED (Етап 3) контролира САМО създаването на
//     НОВИ заявки (POST /api/account/deletion-request).
//   * PROFILE_SELF_DELETION_WORKER_ENABLED (Етап 4) е НЕЗАВИСИМ и контролира
//     САМО автоматичното окончателно изтриване: без него worker-ът не се
//     стартира и не извършва никакво физическо изтриване.
//   * Пътят за възстановяване НЕ зависи от флаговете: ако флагът за подаване
//     бъде изключен след като вече има pending заявки, засегнатите профили
//     остават скрити (данните се пазят), но собственикът продължава да може
//     да влезе, да получи токен за отмяна и да отмени заявката
//     (POST /api/account/deletion-request/cancel и /keep). Така нито един
//     профил не остава без път за възстановяване.
//
// Четат се при всяко извикване (не се кешират), за да могат spawn-натите
// тестови сървъри да ги включват чрез env.

const ENV_FLAG_NAME = 'PROFILE_SELF_DELETION_ENABLED'
const WORKER_ENV_FLAG_NAME = 'PROFILE_SELF_DELETION_WORKER_ENABLED'
const ENV_FLAG_ENABLED_VALUE = '1'

export function isProfileSelfDeletionFeatureEnabled(): boolean {
  return process.env[ENV_FLAG_NAME] === ENV_FLAG_ENABLED_VALUE
}

export function isProfileSelfDeletionWorkerEnabled(): boolean {
  return process.env[WORKER_ENV_FLAG_NAME] === ENV_FLAG_ENABLED_VALUE
}
