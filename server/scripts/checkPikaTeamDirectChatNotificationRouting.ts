/**
 * checkPikaTeamDirectChatNotificationRouting.ts
 *
 * Source-check regression за production bug-а: pika_team-role служител
 * изпраща direct/private съобщение до non-friend играч (бутон "Чат" в
 * profile popup-а) → recipient-ът вижда popup notification "Виж" → преди
 * fix-а бутонът погрешно отваряше "Връзка с екипа" (openSupportInbox)
 * вместо "Чат" (normal chat panel).
 *
 * ДВЕ поправки в тази история:
 *
 * Първи опит (отхвърлен след deep-dive): въведе conversation-level
 * discriminator поле isOfficialSupportConversation, различаващо "истински
 * official support разговор" (initiator===officialPikaProfileId) от
 * "pika_team direct chat" (role-based initiator), route-вайки само
 * последното към normal chat.
 *
 * Deep-dive находка, която обезсили горния подход: "Връзка с екипа"
 * (openSupportInbox/supportPopupOpen) НЕ показва chatStore conversation
 * съдържание изобщо — тя зарежда от напълно ОТДЕЛЕН backend store
 * (supportStore, /api/support/messages), глобален per-потребител support
 * thread, несвързан с friendshipId. chatStore.ts никога не reference-ва
 * supportStore и обратно; supportStore никога не праща chat_message_received
 * WS notification (support unread е polling-базиран, виж
 * refreshSupportUnread в createLobbyFlowController.ts). Значи "Виж" от chat
 * notification popup-а НИКОГА не трябва да сочи towards openSupportInbox(),
 * независимо кой е initiator-ът на kind='pika_support' разговора — дори
 * "истинският" officialPikaProfileId случай е бил показван грешно
 * (supportStore съдържание вместо конкретния chatStore разговор) преди тази
 * поправка. Финално решение: kind='pika_support' И kind='friend' И двете
 * route-ват към нормалния Chat panel (openAsNormalChat), без нужда от
 * discriminator поле изобщо. "Връзка с екипа" остава достъпна само през
 * собствения си бутон "Поддръжка" (onSupportClick), напълно независимо от
 * chat notification routing-а.
 *
 * Server-side kind contract (POST create response и GET conversations
 * response — и двата initiator типа връщат еднакъв kind='pika_support', без
 * discriminator field) е покрит от checkPikaTeamSupportChatHttpAuthorization.ts
 * [F.1]-[F.3] — не се дублира тук. Този файл покрива само client-side
 * routing decision-а (source-check, без DOM/browser).
 *
 * [1]  ChatConversationSnapshot (server) НЕ декларира isOfficialSupportConversation — discriminator полето е премахнато (отхвърлен подход)
 * [2]  ChatConversationSnapshot (client) НЕ декларира isOfficialSupportConversation — client типът синхронизиран със server
 * [3]  createConversationSnapshot НЕ изчислява/reference-ва requester_profile_id === officialPikaProfileId за conversation kind сигнализация
 * [4]  routeByConversation: kind==='pika_support' → openAsNormalChat() безусловно (без initiator-based distinction)
 * [5]  routeByConversation НЕ съдържа openSupportInbox() извикване изобщо (support inbox route-ването е напълно премахнато от chat notification flow-а)
 * [6]  routeByConversation: kind==='friend' продължава да вика openAsNormalChat() (regression guard — normal friend chat непроменен)
 * [7]  routeByConversation НЕ разпознава target по display name ("PIKABG"/text match) — забранен workaround pattern
 * [8]  routeByConversation НЕ разпознава по hardcoded profileId literal в самата routing функция
 * [9]  openAsNormalChat извиква openChatConversation(friendshipId) — реалния conversation id, не hardcoded route
 * [10] openAsNormalChat извиква markChatConversationReadLocally + onChatMarkRead (unread reconciliation запазено за pika_support клона)
 * [11] Fallback клонът (непознат/незареден conversation) презарежда canonical списъка вместо да гадае kind по подразбиране (без regression в race guard-а)
 * [12] openChatWithFriend остава единствен caller на routeByConversation (без дублиран navigation subsystem)
 * [13] openSupportInbox() остава дефинирана и все още извикана от onSupportClick — бутонът "Поддръжка" продължава да работи, само chat-notification routing-ът вече не я вика
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

console.log('\ncheckPikaTeamDirectChatNotificationRouting')

const chatStoreSrc = readFileSync(resolve(PROJECT_ROOT, 'server/src/db/chatStore.ts'), 'utf8')
const clientTypesSrc = readFileSync(resolve(PROJECT_ROOT, 'src/app/network/createGameServerClient.ts'), 'utf8')
const controllerSrc = readFileSync(resolve(PROJECT_ROOT, 'src/app/lobby/createLobbyFlowController.ts'), 'utf8')

// [1]-[2] discriminator field отхвърлен и премахнат
check(
  '[1] server chatStore.ts: ChatConversationSnapshot НЕ декларира isOfficialSupportConversation (отхвърлен подход, премахнат)',
  !chatStoreSrc.includes('isOfficialSupportConversation'),
)
check(
  '[2] client createGameServerClient.ts: ChatConversationSnapshot НЕ декларира isOfficialSupportConversation',
  !clientTypesSrc.includes('isOfficialSupportConversation'),
)

// [3] createConversationSnapshot не изчислява initiator-based distinction
const snapshotStartIdx = chatStoreSrc.indexOf('function createConversationSnapshot(')
const snapshotSrc = snapshotStartIdx >= 0 ? chatStoreSrc.slice(snapshotStartIdx, snapshotStartIdx + 1500) : ''
check(
  '[3] createConversationSnapshot изолиран за проверка',
  snapshotSrc.length > 0,
)
check(
  '[3] createConversationSnapshot НЕ reference-ва requester_profile_id === officialPikaProfileId (initiator-identity distinction премахнат)',
  !snapshotSrc.includes('friendship.requester_profile_id === officialPikaProfileId'),
)

// [4]-[6] routeByConversation branches
const routeStartIdx = controllerSrc.indexOf('const routeByConversation = (conversation: ChatConversationSnapshot | undefined): void => {')
const routeSrc = routeStartIdx >= 0 ? controllerSrc.slice(routeStartIdx, routeStartIdx + 2600) : ''
check(
  '[4] routeByConversation изолиран за проверка',
  routeSrc.length > 0,
)
check(
  "[4] kind==='pika_support' route-ва към openAsNormalChat() безусловно (обединен с kind==='friend' branch)",
  /if \(conversation\?\.kind === 'pika_support' \|\| conversation\?\.kind === 'friend'\) \{[\s\S]{0,1600}openAsNormalChat\(\)/.test(routeSrc),
)
check(
  '[5] routeByConversation НЕ вика openSupportInbox() като реален код call (позволено само в explanatory коментар)',
  !/[^/]\r?\n\s*openSupportInbox\(\)\r?\n/.test(routeSrc.replace(/\/\/.*\r?\n/g, '')),
)
check(
  "[6] kind==='friend' е обединен в СЪЩИЯ branch като 'pika_support' (regression guard — normal friend chat поведение непроменено)",
  routeSrc.includes("conversation?.kind === 'pika_support' || conversation?.kind === 'friend'"),
)

// [7]-[8] Forbidden workaround patterns — НЕ трябва да съществуват в routeByConversation
check(
  '[7] routeByConversation НЕ съдържа display-name text match ("PIKABG") — забранен workaround',
  !routeSrc.includes('PIKABG'),
)
check(
  '[8] routeByConversation НЕ съдържа hardcoded UUID literal (profileId text match) — забранен workaround',
  !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(routeSrc),
)

// [9]-[10] openAsNormalChat: реален conversation id + unread reconciliation
const openAsNormalChatStartIdx = controllerSrc.indexOf('const openAsNormalChat = (): void => {')
const openAsNormalChatSrc = openAsNormalChatStartIdx >= 0
  ? controllerSrc.slice(openAsNormalChatStartIdx, openAsNormalChatStartIdx + 500)
  : ''
check(
  '[9] openAsNormalChat изолиран за проверка',
  openAsNormalChatSrc.length > 0,
)
check(
  '[9] openAsNormalChat вика openChatConversation(friendshipId) — реалния sender conversation id',
  openAsNormalChatSrc.includes('openChatConversation(friendshipId)'),
)
check(
  '[10] openAsNormalChat вика markChatConversationReadLocally + onChatMarkRead (unread reconciliation)',
  openAsNormalChatSrc.includes('markChatConversationReadLocally(friendshipId)') &&
    openAsNormalChatSrc.includes('options.onChatMarkRead?.(friendshipId)'),
)

// [11] Fallback клон — презарежда canonical списъка, не гадае kind
const fallbackWindowIdx = controllerSrc.indexOf('const routeByConversation =')
const fallbackSrc = fallbackWindowIdx >= 0 ? controllerSrc.slice(fallbackWindowIdx, fallbackWindowIdx + 3200) : ''
check(
  '[11] Fallback клонът вика loadChatConversations() и routeByConversation отново, вместо default kind',
  fallbackSrc.includes('void loadChatConversations().then(') &&
    fallbackSrc.includes('routeByConversation(refreshed)'),
)

// [12] Единствен caller на routeByConversation — без дублиран navigation subsystem
const routeByConversationCallCount = (controllerSrc.match(/routeByConversation\(/g) ?? []).length
check(
  '[12] routeByConversation се извиква точно 2 пъти в целия файл (дефиниция за инвокация + рекурсивен fallback повик) — без дублиран navigation subsystem другаде',
  routeByConversationCallCount === 2,
)

// [13] openSupportInbox() остава дефинирана и извикана от бутона "Поддръжка"
check(
  '[13] openSupportInbox() остава дефинирана (function openSupportInbox(): void)',
  controllerSrc.includes('function openSupportInbox(): void {'),
)
const onSupportClickStartIdx = controllerSrc.indexOf('onSupportClick: () => {')
const onSupportClickSrc = onSupportClickStartIdx >= 0
  ? controllerSrc.slice(onSupportClickStartIdx, onSupportClickStartIdx + 100)
  : ''
check(
  '[13] onSupportClick ("Поддръжка" бутон) продължава да вика openSupportInbox() — бутонът си работи, само chat-notification routing вече не я вика',
  onSupportClickSrc.includes('openSupportInbox()'),
)

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
