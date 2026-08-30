/**
 * checkAdCampaignsFrontend.ts
 *
 * Static source-grep checks (mirror на checkAdminTournamentsFrontend.ts) —
 * потвърждава ключови архитектурни гаранции от "Рекламни кампании" плана,
 * които не се покриват от HTTP/WS E2E теста (checkAdCampaignsHttpAndRealtime.ts):
 *  - nav бутонът е достъпен и на pika_team (гейтнат isAdCampaignManager, не
 *    isAdminOrSubadmin), не само вътре в admin dropdown-а;
 *  - switchToLobby() съдържа Checkpoint B hook-а (requestPendingAdCampaigns);
 *  - popup markup-ът има stopPropagation/object-fit:contain/dvh (responsive +
 *    click-outside-to-dismiss guarantees);
 *  - нов, самостоятелен isAdCampaignManagerSession predicate на сървъра (не
 *    reuse на isPikaAnnouncementAuthorSession).
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label}`)
  }
}

async function readProjectFile(projectRoot: string, relativePath: string): Promise<string> {
  return readFile(join(projectRoot, relativePath), 'utf8')
}

const projectRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--project-root='))?.slice('--project-root='.length) ?? join(process.cwd(), '..'),
)

console.log('\ncheckAdCampaignsFrontend')
console.log(`Project root: ${projectRoot}`)

const renderLobbyScreen = await readProjectFile(projectRoot, 'src/app/lobby/renderLobbyScreen.ts')
const flowController = await readProjectFile(projectRoot, 'src/app/lobby/createLobbyFlowController.ts')
const main = await readProjectFile(projectRoot, 'src/main.ts')
const managementPanel = await readProjectFile(projectRoot, 'src/app/adCampaigns/renderAdCampaignManagementPanel.ts')
const popup = await readProjectFile(projectRoot, 'src/app/adCampaigns/renderAdCampaignPopup.ts')
const authStoreSource = await readFile(join(projectRoot, 'server/src/db/authStore.ts'), 'utf8')

check('lobby state/screen registers admin-ad-campaigns навсякъде', [
  "'admin-ad-campaigns'",
  'isAdCampaignManager',
  'adCampaignManagementRows',
  'activeAdCampaignPopup',
  'pendingAdCampaignQueue',
].every((needle) => renderLobbyScreen.includes(needle) && flowController.includes(needle)))

check('nav бутонът е гейтнат isAdCampaignManager (pika_team достъп), не само isAdminOrSubadmin dropdown-а', [
  'data-lobby-nav-ad-campaigns',
  'state.isAdCampaignManager',
].every((needle) => renderLobbyScreen.includes(needle)))

check('ad-campaigns бутонът е SIBLING на admin dropdown-а (затваря isAdminOrSubadmin тернарния клон ПРЕДИ да отвори своя isAdCampaignManager клон), не nested вътре в него', (() => {
  // Точната adjacency последователност, написана в renderNav — затварящото
  // `` ` : ''}`` на isAdminOrSubadmin dropdown-блока, директно последвано от
  // отварянето на самостоятелния isAdCampaignManager блок. Ако бутонът беше
  // nested ВЪТРЕ в dropdown-а, това затваряне би дошло СЛЕД него, не преди.
  const idx = renderLobbyScreen.indexOf("${state.isAdCampaignManager ? `")
  if (idx === -1) return false
  const before = renderLobbyScreen.slice(Math.max(0, idx - 40), idx)
  return before.includes("` : ''}")
})())

check('switchToLobby() съдържа Checkpoint B hook (requestPendingAdCampaigns при реален lobby entry)', (() => {
  const idx = flowController.indexOf('function switchToLobby(')
  if (idx === -1) return false
  const nextFnIdx = flowController.indexOf('\n  function ', idx + 10)
  const body = flowController.slice(idx, nextFnIdx === -1 ? idx + 2000 : nextFnIdx)
  return body.includes('wasOnDifferentScreen') && body.includes('requestPendingAdCampaigns')
})())

check('popup има stopPropagation (click вътре в рамката не dismiss-ва)', popup.includes('stopPropagation'))
check('popup image е responsive (object-fit:contain)', popup.includes('object-fit:contain'))
check('popup frame съобразява viewport height (dvh)', popup.includes('dvh'))
check('popup backdrop dismiss-ва само при target===currentTarget (click извън рамката)', popup.includes('event.target === event.currentTarget'))
check('popup mobile safe margin (calc(100vw - 20px))', popup.includes('calc(100vw - 20px)'))

check('management panel има create form + send/delete бутони + delete confirmation текст', [
  'data-ad-campaign-create-form',
  'data-ad-campaign-send',
  'data-ad-campaign-delete-request',
  'data-ad-campaign-delete-confirm',
  'Всички чакащи показвания ще бъдат отменени',
].every((needle) => managementPanel.includes(needle)))

check('main.ts използва ad-campaigns endpoint-ите', [
  '/api/admin/ad-campaigns',
  'loadAdCampaignManagement',
  'createAdCampaignSubmit',
  'sendAdCampaignSubmit',
  'deleteAdCampaignSubmit',
].every((needle) => main.includes(needle)))

check('main.ts wire-ва WS subscribe/dismiss/click ad-campaign методите', [
  'subscribeAdCampaignManagement',
  'unsubscribeAdCampaignManagement',
  'requestPendingAdCampaigns',
  'dismissAdCampaignDispatch',
  'clickAdCampaignDispatch',
].every((needle) => main.includes(needle)))

check('isAdCampaignManagerSession е НОВ, самостоятелен predicate на сървъра (не reuse на isPikaAnnouncementAuthorSession)', (() => {
  const hasOwnFunction = authStoreSource.includes('export function isAdCampaignManagerSession(')
  const distinctFromAnnouncement = authStoreSource.indexOf('export function isAdCampaignManagerSession(') !==
    authStoreSource.indexOf('export function isPikaAnnouncementAuthorSession(')
  return hasOwnFunction && distinctFromAnnouncement
})())

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exitCode = 1
}
