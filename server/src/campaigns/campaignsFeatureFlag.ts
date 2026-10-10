// Централен feature flag за универсалната система "Кампании". ЕДИНСТВЕНОТО
// място, което чете CAMPAIGNS_FEATURE_ENABLED — всички други модули минават
// през isCampaignsFeatureEnabled() (mirror на
// server/src/core/belotSpectatorFeatureFlag.ts pattern-а: "не разпръсквай
// env проверки из много файлове").
//
// Изключен по подразбиране: активен САМО при точно "1". Фаза 0 (DB схема +
// този флаг) се доставя преди всичките следващи фази (scheduler, admin UI,
// crediting hooks, End Game интеграция, визуална тема, профилна интеграция,
// архив) — merge/deploy на следващ код не трябва да направи непълната
// система production-достъпна. Докато флагът е OFF: кампании не могат да се
// активират, не се начисляват тематични единици, не се сменят изображения на
// масата/картите, End Game екраните и профилният popup остават напълно
// непроменени.
//
// Чете се при всяко извикване (не се кешира при startup), за да могат
// spawn-натите тестови сървъри/check-скриптове да го включват чрез env.

const ENV_FLAG_NAME = 'CAMPAIGNS_FEATURE_ENABLED'
const ENV_FLAG_ENABLED_VALUE = '1'

export function isCampaignsFeatureEnabled(): boolean {
  return process.env[ENV_FLAG_NAME] === ENV_FLAG_ENABLED_VALUE
}
