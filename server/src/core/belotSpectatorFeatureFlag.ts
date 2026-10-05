// Централен feature flag за Belot Spectator Mode ("Гледай"). ЕДИНСТВЕНОТО
// място, което чете BELOT_SPECTATOR_ENABLED — всички други модули минават
// през isBelotSpectatorFeatureEnabled() (mirror на
// localTournamentTest/localTournamentTestModeGuard.ts pattern-а: "не
// разпръсквай env проверки из много файлове").
//
// Изключен по подразбиране: функцията е активна САМО при точно "1". Phase 2A
// (server foundation) се push-ва преди готов frontend — unrelated deploy не
// трябва да направи незавършената функция production-достъпна. При OFF
// watch_belot_room винаги се отказва (feature_disabled), значи registry-то
// остава празно и нито един spectator път не се активира.
//
// Чете се при всяко извикване (не се кешира при startup), за да могат
// spawn-натите тестови сървъри да го включват чрез env.

const ENV_FLAG_NAME = 'BELOT_SPECTATOR_ENABLED'
const ENV_FLAG_ENABLED_VALUE = '1'

export function isBelotSpectatorFeatureEnabled(): boolean {
  return process.env[ENV_FLAG_NAME] === ENV_FLAG_ENABLED_VALUE
}
