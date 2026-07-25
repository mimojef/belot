// Единствената точка, която чете consent състоянието и решава дали да
// активира AdSense/Meta Pixel. UI слоят (consentUi.ts) не знае нищо за
// analytics — той само чете/записва consent; тази функция реагира на
// промените. Няма circular dependency: consent модулите не зависят от
// analytics модулите.
//
// AdSense и Meta Pixel се управляват ИЗКЛЮЧИТЕЛНО от marketing consent.
// analytics:true (без marketing:true) не задейства нищо тук — категорията
// "analytics" е запазена за бъдеща реална measurement интеграция, която все
// още не съществува в проекта.

import { getConsent, subscribeToConsentChanges } from '../consent/consentState'
import { enableAdSenseIfConsented } from './loadAdSense'
import { initMetaPixelIfConsented } from './metaPixel'

function applyCurrentConsent(): void {
  if (getConsent()?.marketing !== true) return
  enableAdSenseIfConsented()
  initMetaPixelIfConsented()
}

/**
 * Извиква се веднъж при bootstrap. Прилага текущия consent веднага (напр.
 * при reload с вече записано marketing: true) и се абонира за бъдещи
 * промени (accept-all, save-choice), за да реагира без reload.
 */
export function initializeAnalytics(): void {
  applyCurrentConsent()
  subscribeToConsentChanges(() => applyCurrentConsent())
}
