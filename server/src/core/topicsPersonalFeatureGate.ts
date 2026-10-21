// Server-side gate за "Теми → Лични" (vip_dm). Стойността идва от споделения
// TOPICS_PERSONAL_ENABLED (server/src/shared/topicsPersonalFeatureFlag.ts).
//
// Env TOPICS_PERSONAL_ENABLED ('1' / '0') е override САМО за spawn-нати
// тестови сървъри — чете се при всяко извикване (mirror на
// belotSpectatorFeatureFlag.ts). Клиентът не вижда env-а, затова реалното
// възстановяване е чрез споделената константа, не чрез env.

import {
  isTopicsPersonalEnabled,
  TOPICS_PERSONAL_DISABLED_CODE,
  TOPICS_PERSONAL_DISABLED_MESSAGE,
} from '../shared/topicsPersonalFeatureFlag.js'

const ENV_FLAG_NAME = 'TOPICS_PERSONAL_ENABLED'

export function isTopicsPersonalServerEnabled(): boolean {
  const raw = process.env[ENV_FLAG_NAME]
  if (raw === '1') return true
  if (raw === '0') return false
  return isTopicsPersonalEnabled()
}

export function createTopicsPersonalDisabledResponse(): { ok: false; code: string; message: string } {
  return { ok: false, code: TOPICS_PERSONAL_DISABLED_CODE, message: TOPICS_PERSONAL_DISABLED_MESSAGE }
}
