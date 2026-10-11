import { LUDO_MODAL_BACKDROP_LOCAL_Z_INDEX } from './ludoLayerHierarchy'
import type { CampaignMatchCreditSnapshot } from '../../network/createGameServerClient'

// prizeAmount: authoritative payout сума (от ludoEconomyStore.payoutLudoMatchWinner
// през LudoGameStateMessage.prizeAmount), НЕ клиентско изчисление — виж task
// spec §"END GAME UI / PRIZE": "UI числото трябва да идва от authoritative
// settlement/result, а НЕ клиентът сам да пресмята prize." Показва се само
// когато играчът реално е спечелил И award-ът вече е известен (може за кратко
// да е null между "status:finished" презентацията и пристигането на снимката
// със settlement резултата — следващият snapshot ще презареди popup текста).
//
// spectatorWinnerDisplayName (Ludo Spectator Mode Phase 2): undefined за
// participant view (established поведение, непроменено). За spectator view
// подавай explicit string (или null, ако winnerColor липсва) — показва
// неутрално "Играта приключи! Победител: X" вместо личното "Вие сте
// победител/Вие загубихте" (didLocalPlayerWin за spectator винаги е false
// заради borrowed find-first-non-bot localColor identity — истинско "Вие
// загубихте" текстово съобщение би било подвеждащо за някой, който изобщо
// не е играл). prizeLine никога не се показва в spectator view — spectator
// никога не залага/печели от match-а (LudoSpectatorGameStateMessage никога
// не носи prizeAmount, виж server/src/protocol/messageTypes.ts).
//
// Фаза 7 — campaignUnitCredit: реално потвърдените тематични единици за
// ТОЗИ конкретен мач (campaign_unit_ledger ред, НЕ натрупания профилен
// total — виж task spec §3). `null`/`undefined` означава "нищо за
// показване точно сега" — умишлено НЕ различава "никога няма да получи"
// (flag off/без кампания/губещ/spectator/без rule за залога) от "все още
// се обработва" (campaign hook все още не е потвърдил) — и двете визуално
// резолюират еднакво, mirror на Белот End Game-а (виж renderMatchEndedScreen.ts
// doc коментара за пълния rationale). Никога не се показва в spectator view
// (spectator никога не получава личен credit, виж createLudoFlowController.ts
// doc коментара при requestCampaignMatchCreditForThisMatch).
export function renderLudoGameEndPopup(
  didLocalPlayerWin: boolean,
  prizeAmount: number | null,
  spectatorWinnerDisplayName?: string | null,
  campaignUnitCredit?: CampaignMatchCreditSnapshot | null,
): string {
  const isSpectatorView = spectatorWinnerDisplayName !== undefined
  const prizeLine = !isSpectatorView && didLocalPlayerWin && prizeAmount !== null
    ? `<div data-ludo-prize-line="1" style="color:#f4c95b;font-size:16px;font-weight:900;line-height:1.4;margin-top:-10px;margin-bottom:6px;">Печелите ${prizeAmount.toLocaleString('bg-BG')} жълтици</div>`
    : ''
  // Defense-in-depth (mirror на Белот renderMatchEndedScreen.ts's
  // `winnerTeam === localTeam` gate) — НЕ разчитаме единствено на
  // сървърната profile-scoping (task spec §8 "губещият не трябва да вижда
  // кампанийна награда"): дори credit да е по някаква причина наличен
  // locally за губещ/spectator, никога не се render-ва тук.
  const campaignUnitLine = !isSpectatorView && didLocalPlayerWin
    ? renderLudoCampaignUnitLineHtml(campaignUnitCredit ?? null)
    : ''
  const bottomLine = prizeLine || campaignUnitLine
  const titleText = isSpectatorView
    ? (spectatorWinnerDisplayName !== null ? `Играта приключи! Победител: ${spectatorWinnerDisplayName}` : 'Играта приключи.')
    : (didLocalPlayerWin ? 'Вие сте победител в играта!' : 'Вие загубихте играта.')
  return `
    <div data-ludo-game-end-backdrop="1" style="
      position:fixed; inset:0; z-index:${LUDO_MODAL_BACKDROP_LOCAL_Z_INDEX};
      background:rgba(2,6,23,0.68);
      display:flex; align-items:center; justify-content:center;
      padding:16px; box-sizing:border-box;
    ">
      <div role="dialog" aria-modal="true" aria-labelledby="ludo-game-end-title" style="
        width:min(360px, 100%);
        background:rgba(15,23,42,0.98);
        border:1px solid rgba(212,165,32,0.4);
        border-radius:20px;
        padding:28px 24px 22px;
        text-align:center;
        box-shadow:0 20px 60px rgba(0,0,0,0.55);
      ">
        <div id="ludo-game-end-title" style="color:#f4f8ff;font-size:18px;font-weight:800;line-height:1.45;${bottomLine ? 'margin-bottom:10px;' : 'margin-bottom:22px;'}">
          ${titleText}
        </div>
        ${prizeLine}
        ${campaignUnitLine}
        ${bottomLine ? '<div style="height:12px;"></div>' : ''}
        <button type="button" data-ludo-game-end-dismiss="1" style="
          min-width:112px; padding:11px 28px;
          border:none; border-radius:10px;
          background:linear-gradient(135deg,#f4c95b 0%,#c98f13 100%);
          color:#000000; font-size:14px; font-weight:900;
          cursor:pointer;
        ">OK</button>
      </div>
    </div>
  `
}

// Фаза 7 — изолиран fragment generator за кампанийния unit ред, reuse-нат И
// от пълния render по-горе, И от targeted DOM patch-а в
// createLudoFlowController.ts (закъсняло начисление, пристигнало СЛЕД
// popup-ът вече е mount-нат — виж task spec §5 "обнови съществуващия
// popup, ако той все още е отворен"). `data-ludo-campaign-unit-line="1"`
// е стабилният anchor за тая patch логика. Връща '' (нищо за render) при
// null/0 units — mirror на "липсваща награда" случая, никога fabricate-ва
// placeholder/нула (task spec §10).
export function renderLudoCampaignUnitLineHtml(credit: CampaignMatchCreditSnapshot | null): string {
  if (!credit || credit.unitsAmount <= 0) return ''
  const unitLabel = credit.unitsAmount === 1 ? credit.unitNameSingular : credit.unitNamePlural
  const amountText = `+${credit.unitsAmount.toLocaleString('bg-BG')} ${unitLabel}`
  const iconHtml = credit.unitIconUrl
    ? `<img src="${escapeLudoHtml(credit.unitIconUrl)}" alt="" onerror="this.style.display='none'" style="width:18px;height:18px;object-fit:contain;vertical-align:middle;margin-right:4px;flex:0 0 auto;" />`
    : ''
  return `<div data-ludo-campaign-unit-line="1" style="display:flex;align-items:center;justify-content:center;gap:4px;color:#facc15;font-size:15px;font-weight:900;line-height:1.4;margin-bottom:6px;">${iconHtml}<span>${escapeLudoHtml(amountText)}</span></div>`
}

function escapeLudoHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
