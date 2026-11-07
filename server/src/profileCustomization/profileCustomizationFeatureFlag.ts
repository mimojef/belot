// "Персонализация на профила" — env-ът е САМО авариен стоп на покупките.
// ЕДИНСТВЕНОТО място, което чете PROFILE_CUSTOMIZATION_ENABLED.
//
// Публичното активиране вече НЕ е env флаг: режимът се управлява от админ
// панела ("Активирай"/"Деактивирай") и се пази в SQLite
// (profile_customization_mode_changes; без записи -> 'admin_only'). Така
// deploy, рестарт или миграция никога не правят функцията публична.
//
//   * PROFILE_CUSTOMIZATION_ENABLED=0 -> авариен стоп: никой (вкл. admin) не
//     може да започне ново плащане и бутонът "Персонализация" не се показва.
//     Вече платените права остават и продължават да се показват; webhook-ът
//     продължава да кредитира вече платени поръчки.
//   * всяка друга стойност / липсваща -> нормална работа според режима.
//
// Чете се при всяко извикване (без кеш), за да може да се смени с рестарт на
// процеса без нов deploy, а тестовите сървъри да го подават през env.

const ENV_FLAG_NAME = 'PROFILE_CUSTOMIZATION_ENABLED'
const EMERGENCY_STOP_VALUE = '0'

export function isProfileCustomizationEmergencyStopActive(): boolean {
  return process.env[ENV_FLAG_NAME]?.trim() === EMERGENCY_STOP_VALUE
}
