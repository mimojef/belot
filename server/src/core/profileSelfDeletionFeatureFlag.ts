// Централен feature flag за самоизтриване на профили. ЕДИНСТВЕНОТО място,
// което чете PROFILE_SELF_DELETION_ENABLED (mirror на
// belotSpectatorFeatureFlag.ts).
//
// Изключен по подразбиране: функцията е активна САМО при точно "1". НЕ се
// включва в продукция, докато всички етапи не са завършени и изрично
// разрешени.
//
// Семантика (Етап 3):
//   * Флагът контролира САМО създаването на НОВИ заявки
//     (POST /api/account/deletion-request) и в бъдеще — автоматичното
//     окончателно изтриване.
//   * Пътят за възстановяване НЕ зависи от флага: ако флагът бъде изключен
//     след като вече има pending заявки, засегнатите профили остават скрити
//     (данните се пазят), но собственикът продължава да може да влезе,
//     да получи токен за отмяна и да отмени заявката
//     (POST /api/account/deletion-request/cancel и /keep). Така нито един
//     профил не остава без път за възстановяване.
//
// Чете се при всяко извикване (не се кешира), за да могат spawn-натите
// тестови сървъри да го включват чрез env.

const ENV_FLAG_NAME = 'PROFILE_SELF_DELETION_ENABLED'
const ENV_FLAG_ENABLED_VALUE = '1'

export function isProfileSelfDeletionFeatureEnabled(): boolean {
  return process.env[ENV_FLAG_NAME] === ENV_FLAG_ENABLED_VALUE
}
