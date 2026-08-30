import type { AdCampaignDispatchClientDto } from '../network/createGameServerClient'

// Pure merge helper за pending ad-campaign опашката (извлечена от
// createLobbyFlowController.ts's `ad_campaign_pending_ads` handler, за да е
// unit-тестваема без DOM/WS харнес). Dedupe-ва входящите dispatch-и срещу
// (1) вече опашкуваните и (2) текущо показания popup — предпазва от duplicate
// копие на СЪЩИЯ dispatch в runtime session-а, ако сървърът го push-не пак
// (напр. Checkpoint A при reconnect + Checkpoint C при ново "Изпрати" почти
// едновременно, или repeated `ad_campaign_pending_ads` от cross-instance poll).
// НЕ премахва нищо съществуващо от опашката — само добавя генуинно нови.
export function mergeIncomingAdCampaignDispatches(
  existingQueue: readonly AdCampaignDispatchClientDto[],
  activePopup: AdCampaignDispatchClientDto | null,
  incoming: readonly AdCampaignDispatchClientDto[],
): AdCampaignDispatchClientDto[] {
  const newOnes: AdCampaignDispatchClientDto[] = []

  for (const d of incoming) {
    if (activePopup?.dispatchId === d.dispatchId) continue
    if (existingQueue.some((existing) => existing.dispatchId === d.dispatchId)) continue
    if (newOnes.some((added) => added.dispatchId === d.dispatchId)) continue
    newOnes.push(d)
  }

  if (newOnes.length === 0) {
    return existingQueue as AdCampaignDispatchClientDto[]
  }

  return [...existingQueue, ...newOnes]
}

export type DequeueNextAdCampaignPopupResult = {
  activePopup: AdCampaignDispatchClientDto | null
  queue: AdCampaignDispatchClientDto[]
}

// Pure "покажи следващия pending, ако няма вече отворен" helper (извлечена
// от showNextPendingAdCampaignIfAny). Никога не показва повече от ЕДИН popup
// едновременно — ако вече има activePopup, връща state-а непроменен (queue-то
// продължава да расте, но нищо ново не се "изважда" докато текущият не бъде
// dismiss-нат/click-нат). Multiple offline dispatches (Send#1/#2/#3) се
// показват един по един в реда, в който опашката ги пази (FIFO, sent_at ASC).
export function dequeueNextAdCampaignPopup(
  activePopup: AdCampaignDispatchClientDto | null,
  queue: readonly AdCampaignDispatchClientDto[],
): DequeueNextAdCampaignPopupResult {
  if (activePopup !== null) {
    return { activePopup, queue: queue as AdCampaignDispatchClientDto[] }
  }

  const next = queue[0] ?? null

  if (next === null) {
    return { activePopup: null, queue: queue as AdCampaignDispatchClientDto[] }
  }

  return { activePopup: next, queue: queue.slice(1) }
}
