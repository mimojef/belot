// Централен feature flag за тестовата игра "Свара". ЕДИНСТВЕНОТО място,
// което чете SVARA_TEST_ENABLED — всички други модули минават през
// isSvaraTestFeatureEnabled() (mirror на campaignsFeatureFlag.ts /
// belotSpectatorFeatureFlag.ts pattern-а: "не разпръсквай env проверки из
// много файлове").
//
// Изключен по подразбиране: активен САМО при точно "1". При OFF достъпът до
// Свара се отказва на ВСИЧКИ, включително на служебните роли (виж
// evaluateSvaraAccess в svaraAccess.ts). Не включвай в production.
//
// Чете се при всяко извикване (не се кешира при startup), за да могат
// spawn-натите тестови сървъри/check-скриптове да го включват чрез env.

const ENV_FLAG_NAME = 'SVARA_TEST_ENABLED'
const ENV_FLAG_ENABLED_VALUE = '1'

export function isSvaraTestFeatureEnabled(): boolean {
  return process.env[ENV_FLAG_NAME] === ENV_FLAG_ENABLED_VALUE
}
