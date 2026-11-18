// ВРЕМЕННО — тестови ботове за Свара (само локално тестване).
// Целият каталог testBots/ се премахва при окончателното пускане на Свара —
// виж docs/svara-test-bots-local.md, раздел „Премахване“.
//
// ЕДИНСТВЕНОТО място, което чете SVARA_TEST_BOTS_ENABLED. Ботовете са
// активни само когато И ТРИТЕ условия са изпълнени:
//   • SVARA_TEST_BOTS_ENABLED е точно "1";
//   • самата тестова Свара е включена (SVARA_TEST_ENABLED=1);
//   • NODE_ENV не е "production".
// Чете се при всяко извикване (не се кешира), за да може spawn-нат тестов
// сървър да го включва чрез env.

import { isSvaraTestFeatureEnabled } from '../svaraFeatureFlag.js'

const ENV_FLAG_NAME = 'SVARA_TEST_BOTS_ENABLED'
const ENV_FLAG_ENABLED_VALUE = '1'

export function isSvaraTestBotsEnabled(): boolean {
  return process.env[ENV_FLAG_NAME] === ENV_FLAG_ENABLED_VALUE
    && isSvaraTestFeatureEnabled()
    && process.env.NODE_ENV !== 'production'
}
