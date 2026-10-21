// Централен feature flag за "Теми → Лични" (kind='vip_dm' разговори) и
// бутоните "Лично" под публикациите в "Общи". Споделен между клиента
// (src/app/lobby/*) и сървъра (server/src/core/topicsPersonalFeatureGate.ts) —
// ЕДНА стойност за двете страни.
//
// Временно изключен: личната комуникация в "Теми" позволява писане между
// непознати (не-приятели). Основният "Чат" (kind='friend'/'pika_support') НЕ
// зависи от този flag.
//
// При false:
//  - клиентът не рендира "Лични"/"Лично" и пренасочва всеки опит за отваряне
//    към "Лафче";
//  - сървърът отказва създаване на нов vip_dm и нови съобщения във vip_dm
//    (code 'topics_personal_disabled'). Четенето и данните остават непокътнати.
//
// Възстановяване: смени на true — старите разговори са отново достъпни.
export const TOPICS_PERSONAL_ENABLED = false

export const TOPICS_PERSONAL_DISABLED_CODE = 'topics_personal_disabled'
export const TOPICS_PERSONAL_DISABLED_MESSAGE = 'Личните съобщения в Теми временно не са налични.'

let flagOverrideForTests: boolean | undefined

export function isTopicsPersonalEnabled(): boolean {
  return flagOverrideForTests ?? TOPICS_PERSONAL_ENABLED
}

export function __setTopicsPersonalEnabledOverrideForTests(value: boolean | undefined): void {
  flagOverrideForTests = value
}
