/**
 * checkPikaTeamProfileActionSet.ts
 *
 * Source-text проверки за bug fix-а на изчезналия "Чат" бутон в profile
 * popup-а за pika_team viewer-и: shouldShowPikaSupportChatButton
 * (createLobbyFlowController.ts) винаги е бил gated по ЕДИН hardcoded
 * OFFICIAL_PIKA_PROFILE_ID (client) / PIKA_OFFICIAL_PROFILE_ID (server env,
 * chatStore.getOrCreatePikaSupportConversation) — НЕ по role==='pika_team'.
 * Production-registered pika_team акаунт, различен от точно този profileId,
 * никога не е виждал "Чат" бутона; локален pika_team dev/test акаунт (друг
 * profileId) — също. Fix: shouldShowPikaSupportChatButton вече показва
 * бутона И за OFFICIAL_PIKA_PROFILE_ID (legacy), И за role==='pika_team'
 * (mirror на isPikaTeamGiftFriendshipBypassAuthSession pattern-а), без да
 * маха новия "Подари жълтици" бутон, добавен в по-ранен pika_team
 * friendship-gate bypass fix, и без backend chat authorization промяна
 * (server остава fail-closed на PIKA_OFFICIAL_PROFILE_ID единствено — виж
 * bug report §2).
 *
 * Този скрипт не рендира DOM (jsdom не е налична зависимост тук, виж
 * checkGiftNotificationModalFix.ts за established прецедент) — вместо това
 * чете реалния source на src/app/lobby/createLobbyFlowController.ts и
 * src/ui/overlays/renderPlayerProfilePopup.ts и потвърждава чрез
 * string/regex checks поведението.
 *
 * Покрива (bug report §5):
 *  [A] pika_team + non-friend: Chat, Gift, Invite, Like, Block всичките
 *      видими условия присъстват едновременно в render markup-а (никое не
 *      "замества" друго).
 *  [A.1] shouldShowPikaSupportChatButton() връща true и за
 *        role==='pika_team' (не само за OFFICIAL_PIKA_PROFILE_ID match).
 *  [B] normal player (role!=='pika_team', profileId!==OFFICIAL_PIKA_PROFILE_ID)
 *      + non-friend: нито unrestricted Chat, нито gift bypass — и двата
 *      predicate-а изискват role==='pika_team' explicit (не generic "logged
 *      in" условие).
 *  [C] accepted-friend клонът (giftFriendshipId) остава непроменен от Chat
 *      fix-а — giftFriendshipId branch-ът не реферира role/OFFICIAL_PIKA_PROFILE_ID.
 *  [D] mobile action container остава 2-колонен CSS grid без hardcoded
 *      item-count cap (няма nth-child/max-width ограничение до 4 бутона).
 *
 * Изпълнява се в Node.js чрез tsx, без build/dev server.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const CONTROLLER_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'createLobbyFlowController.ts')
const POPUP_PATH = join(REPO_ROOT, 'src', 'ui', 'overlays', 'renderPlayerProfilePopup.ts')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: string): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err))
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function extractNestedFunctionBody(src: string, signature: string, label: string): string {
  const startIdx = src.indexOf(signature)
  assert(startIdx !== -1, `${label}: сигнатура "${signature}" не е намерена`)
  const afterStart = src.slice(startIdx)
  const endIdx = afterStart.indexOf('\n  }')
  assert(endIdx !== -1, `${label}: край на функция не е намерен след "${signature}"`)
  return afterStart.slice(0, endIdx)
}

const controllerSrc = await readFile(CONTROLLER_PATH, 'utf8')
const popupSrc = await readFile(POPUP_PATH, 'utf8')

console.log('\n=== pika_team Profile Action Set Checks ===\n')

// [A] Всичките 5 action-и присъстват в render markup-а, независимо едно от друго
await check('[A] Chat, Like, Invite/Gift branches, Block всичките присъстват в profile popup markup-а (не се заместват)', () => {
  assert(popupSrc.includes('data-player-profile-pika-support-chat='), 'Chat бутонът (data-player-profile-pika-support-chat) трябва да съществува в markup-а')
  assert(popupSrc.includes('data-player-profile-like='), 'Like бутонът трябва да съществува')
  assert(popupSrc.includes('data-player-profile-friend-request='), 'Invite/friend-request бутонът трябва да съществува')
  assert(popupSrc.includes('data-player-profile-gift-coins='), 'Gift (friendship) бутонът трябва да съществува')
  assert(popupSrc.includes('data-player-profile-gift-coins-bypass='), 'Gift (pika_team bypass) бутонът трябва да съществува')
  assert(popupSrc.includes('data-player-profile-block='), 'Block бутонът трябва да съществува')
})

await check('[A.0] Всичките action бутони са в СЪЩИЯ container (никое условие не early-return-ва преди друго)', () => {
  const startIdx = popupSrc.indexOf('data-player-profile-actions="1"')
  assert(startIdx !== -1, 'data-player-profile-actions контейнерът не е намерен')
  const chatIdx = popupSrc.indexOf('data-player-profile-pika-support-chat=', startIdx)
  const likeIdx = popupSrc.indexOf('data-player-profile-like=', startIdx)
  const giftBypassIdx = popupSrc.indexOf('data-player-profile-gift-coins-bypass=', startIdx)
  const blockIdx = popupSrc.indexOf('data-player-profile-block=', startIdx)
  assert(
    chatIdx !== -1 && likeIdx !== -1 && giftBypassIdx !== -1 && blockIdx !== -1 &&
    chatIdx < likeIdx && likeIdx < giftBypassIdx && giftBypassIdx < blockIdx,
    `Очакван ред Chat < Like < GiftBypass < Block в единия action container, получени индекси: chat=${chatIdx} like=${likeIdx} giftBypass=${giftBypassIdx} block=${blockIdx}`,
  )
})

// [A.1] shouldShowPikaSupportChatButton вече включва role==='pika_team'
await check("[A.1] shouldShowPikaSupportChatButton() връща true и за role==='pika_team' (не само OFFICIAL_PIKA_PROFILE_ID)", () => {
  const fn = extractNestedFunctionBody(
    controllerSrc,
    'function shouldShowPikaSupportChatButton(authSession: LobbyAuthSession | null): boolean {',
    'shouldShowPikaSupportChatButton',
  )
  assert(fn.includes('authSession.profile.profileId === OFFICIAL_PIKA_PROFILE_ID'), 'Legacy OFFICIAL_PIKA_PROFILE_ID клонът трябва да остане')
  assert(
    /authSession\.profile\.profileId === OFFICIAL_PIKA_PROFILE_ID\s*\|\|\s*authSession\.account\.role === 'pika_team'/.test(fn),
    `shouldShowPikaSupportChatButton трябва да OR-не OFFICIAL_PIKA_PROFILE_ID match с role==='pika_team', получено тяло:\n${fn}`,
  )
})

// [B] Normal (non-pika_team) sender няма нито unrestricted Chat, нито gift bypass
await check("[B] normal player (role!=='pika_team') няма нито Chat bypass, нито gift friendship bypass — и двата predicate-а изискват explicit role==='pika_team'", () => {
  const chatFn = extractNestedFunctionBody(
    controllerSrc,
    'function shouldShowPikaSupportChatButton(authSession: LobbyAuthSession | null): boolean {',
    'shouldShowPikaSupportChatButton',
  )
  assert(chatFn.includes("role === 'pika_team'"), 'Chat predicate-ът трябва explicit да сравнява role с pika_team стринг литерал')

  const giftBypassFn = extractNestedFunctionBody(
    controllerSrc,
    'function isPikaTeamGiftFriendshipBypassAuthSession(session: LobbyAuthSession | null): boolean {',
    'isPikaTeamGiftFriendshipBypassAuthSession',
  )
  assert(giftBypassFn.includes("role === 'pika_team'"), 'Gift bypass predicate-ът трябва explicit да сравнява role с pika_team стринг литерал')
  // Никой от двата predicate-а не трябва да third-party role (admin/subadmin/
  // chat_admin/top_chat_admin/player) implicit through OR chain — единственото
  // разрешено сравнение е == 'pika_team' (плюс legacy OFFICIAL_PIKA_PROFILE_ID
  // за chat-а).
  for (const otherRole of ['admin', 'subadmin', 'chat_admin', 'top_chat_admin']) {
    assert(!chatFn.includes(`role === '${otherRole}'`), `Chat predicate-ът не трябва да разширява до role==='${otherRole}'`)
    assert(!giftBypassFn.includes(`role === '${otherRole}'`), `Gift bypass predicate-ът не трябва да разширява до role==='${otherRole}'`)
  }
})

// [C] accepted-friend gift клонът остава непроменен от Chat fix-а
await check('[C] accepted-friend gift клонът (giftFriendshipId) не реферира role/OFFICIAL_PIKA_PROFILE_ID — непроменено поведение', () => {
  const idx = controllerSrc.indexOf("relationship.status === 'accepted'")
  assert(idx !== -1, "relationship.status === 'accepted' branch-ът не е намерен")
  const block = controllerSrc.slice(idx, idx + 400)
  assert(!block.includes('OFFICIAL_PIKA_PROFILE_ID'), 'accepted-friend клонът не трябва да реферира OFFICIAL_PIKA_PROFILE_ID')
  assert(!block.includes("role === 'pika_team'"), 'accepted-friend клонът не трябва да реферира role===\'pika_team\' — приятелският gift path е непроменен')
})

// [D] Mobile action container остава 3-колонен grid (mobile polish: pika_team
// non-friend 5-бутонен сет подрежда се 3+2), без hardcoded item-count cap
await check('[D] Mobile action container: 3-column CSS grid, без nth-child/max-width item-count ограничение', () => {
  const gridIdx = popupSrc.indexOf('[data-player-profile-actions="1"] > div:first-child {')
  assert(gridIdx !== -1, 'Mobile action grid правилото не е намерено')
  const rule = popupSrc.slice(gridIdx, gridIdx + 300)
  assert(rule.includes('display:grid'), 'Mobile action container трябва да е CSS grid')
  assert(rule.includes('grid-template-columns:repeat(3, 1fr)'), 'Mobile action container трябва да е точно 3 колони (mobile polish fix)')
  assert(!rule.includes('nth-child'), 'Mobile action grid не трябва да съдържа nth-child item-count ограничение')
  assert(!rule.includes('flex-wrap:nowrap'), 'Mobile action grid не трябва да се връща към старото nowrap поведение')
})

// ─── Резултат ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
