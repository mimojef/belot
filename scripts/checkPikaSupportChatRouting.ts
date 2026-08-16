/**
 * checkPikaSupportChatRouting.ts
 *
 * Permanent regression guard за production bug: PIKABG (официалният Pika.bg
 * профил) отваря чужд профил, натиска "ЧАТ", изпраща съобщение — но то се
 * доставя в СЪВСЕМ ДРУГ разговор, не при получателя, чийто профил е бил
 * отворен.
 *
 * ROOT CAUSE (потвърден чрез директно четене на кода, не предположение):
 * renderChatPanel (src/app/lobby/renderLobbyScreen.ts) филтрираше видимите
 * разговори с ALLOWLIST `.filter(c => c.kind === 'friend')` — въведено в
 * commit a6c1ba6 ("Add Topics personal chat integration", 2026-08-12), за да
 * изключи новоотделените 'vip_dm' разговори (вече имат собствен Topics
 * personal UI). Страничен ефект: 'pika_support' разговори (съществуващи и
 * работещи коректно от по-ранния commit 67c71aa, "Add official Pika team
 * support chats", 2026-08-04) СЪЩО отпадаха от този списък.
 *
 * activeConversation в renderChatPanel се търси ВЪТРЕ в този филтриран
 * списък по friendshipId === state.activeChatFriendshipId — щом
 * activeChatFriendshipId сочи pika_support разговор, lookup-ът никога не го
 * намира и МЪЛЧАЛИВО fallback-ва към sortedConversations[0] (първият
 * 'friend'-разговор, сортиран по updatedAt низходящо — т.е. "последният
 * разговор, с който PIKABG наскоро е чатил/приятел"). Composer формата
 * (data-lobby-chat-form) се bind-ва към ТОЗИ грешен friendshipId, не към
 * действително отворения профил — точно симптомът от production доклада.
 *
 * FIX: filter станa `kind === 'friend' || kind === 'pika_support'` (само
 * 'vip_dm' се изключва изрично, защото си има собствен dedicated UI).
 *
 * Вторичен defense-in-depth fix (state.activeChatRequestGeneration,
 * createLobbyFlowController.ts): openChatConversation вече bump-ва
 * monotonic generation token; entry points с pre-flight мрежов hop
 * (startPikaSupportChatAndOpen/showTopicsPersonalChat/openChatWithFriend)
 * проверяват го след await-а и се отказват тихо, ако друг по-нов chat-open
 * flow вече ги е superseded-нал — предпазва от СЪЩИЯ клас бъг дори при
 * реален network race (по-бавна по-РАНО кликната заявка, resolve-ваща СЛЕД
 * по-бърза по-КЪСНО кликната), огледално на вече съществуващия
 * topicMessagesRequestGeneration guard.
 *
 * Реален браузър (Playwright) + реален production код
 * (createLobbyFlowController + renderLobbyScreen), зареден през Vite dev
 * server. Ползва permanent-purpose topicsSwitchRaceHarness (разширен
 * additively с onPikaSupportChatStart/onChatConversationsLoad/
 * onChatMessagesLoad/onChatSend), reuse-вайки установения
 * "topic message author click → profile popup" механизъм за отваряне на
 * чужд профил (виж checkProfilePopupMobileResponsive.ts).
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

const OFFICIAL_PIKA_PROFILE_ID = '4c146064-85af-4e6e-b08f-08faa39b167e'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Не успях да намеря свободен порт.'))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

// ─── Тънки wrapper-и над window.__topicsSwitchRaceHarness (същия pattern
// като checkProfilePopupMobileResponsive.ts / checkTopicsSwitchRace.ts) ───
async function setOwnProfileOverrides(page: Page, overrides: Record<string, unknown>): Promise<void> {
  await page.evaluate((ov) => { (window as any).__topicsSwitchRaceHarness.setOwnProfileOverrides(ov) }, overrides)
}
async function openTopicsScreen(page: Page): Promise<void> {
  await page.evaluate(() => { (window as any).__topicsSwitchRaceHarness.openTopicsScreen() })
  await page.waitForSelector('[data-topics-screen="1"]', { state: 'attached' })
}
async function deliverNextResponse(page: Page, topicId: string): Promise<void> {
  await page.evaluate((id) => { (window as any).__topicsSwitchRaceHarness.deliverNextResponse(id) }, topicId)
}
async function deliverNextResponseWithAuthor(page: Page, topicId: string, body: string, senderProfileId: string, senderDisplayName: string): Promise<void> {
  await page.evaluate(
    ({ id, b, pid, name }) => { (window as any).__topicsSwitchRaceHarness.deliverNextResponseWithAuthor(id, b, pid, name) },
    { id: topicId, b: body, pid: senderProfileId, name: senderDisplayName },
  )
}
async function clickMessageAuthor(page: Page, profileId: string): Promise<void> {
  await page.evaluate((pid) => { (window as any).__topicsSwitchRaceHarness.clickMessageAuthor(pid) }, profileId)
}
async function deliverNextProfileResponse(page: Page, profileId: string): Promise<void> {
  await page.evaluate((pid) => { (window as any).__topicsSwitchRaceHarness.deliverNextProfileResponse(pid) }, profileId)
}
async function closeProfilePopup(page: Page): Promise<void> {
  await page.evaluate(() => { (window as any).__topicsSwitchRaceHarness.closeProfilePopup() })
}
async function setChatConversations(page: Page, conversations: unknown[]): Promise<void> {
  await page.evaluate((convs) => { (window as any).__topicsSwitchRaceHarness.setChatConversations(convs) }, conversations)
}
async function addChatConversation(page: Page, conversation: unknown): Promise<void> {
  await page.evaluate((conv) => { (window as any).__topicsSwitchRaceHarness.addChatConversation(conv) }, conversation)
}
async function clickPikaSupportChatButton(page: Page): Promise<void> {
  await page.evaluate(() => { (window as any).__topicsSwitchRaceHarness.clickPikaSupportChatButton() })
}
async function isPikaSupportChatButtonVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__topicsSwitchRaceHarness.isPikaSupportChatButtonVisible())
}
async function isPikaStartPending(page: Page, profileId: string): Promise<boolean> {
  return page.evaluate((pid) => (window as any).__topicsSwitchRaceHarness.isPikaStartPending(pid), profileId)
}
async function deliverNextPikaStartResponse(page: Page, profileId: string, friendshipId: string): Promise<void> {
  await page.evaluate(
    ({ pid, fid }) => { (window as any).__topicsSwitchRaceHarness.deliverNextPikaStartResponse(pid, fid) },
    { pid: profileId, fid: friendshipId },
  )
}
async function getChatFormFriendshipId(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getChatFormFriendshipId())
}
async function getActiveChatHeaderText(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getActiveChatHeaderText())
}
async function fillAndSubmitChatForm(page: Page, body: string): Promise<void> {
  await page.evaluate((b) => { (window as any).__topicsSwitchRaceHarness.fillAndSubmitChatForm(b) }, body)
}
async function getChatSentLog(page: Page): Promise<Array<{ friendshipId: string; body: string }>> {
  return page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getChatSentLog())
}
async function getChatMessageBodies(page: Page, friendshipId: string): Promise<string[]> {
  return page.evaluate((fid) => (window as any).__topicsSwitchRaceHarness.getChatMessageBodies(fid), friendshipId)
}
async function setChatSendBlocked(page: Page, friendshipId: string, blocked: boolean): Promise<void> {
  await page.evaluate(
    ({ fid, b }) => { (window as any).__topicsSwitchRaceHarness.setChatSendBlocked(fid, b) },
    { fid: friendshipId, b: blocked },
  )
}
async function seedChatMessage(page: Page, friendshipId: string, body: string): Promise<void> {
  await page.evaluate(
    ({ fid, b }) => {
      (window as any).__topicsSwitchRaceHarness.seedChatMessage(fid, {
        messageId: `seed-${fid}-${Date.now()}`,
        friendshipId: fid,
        senderProfileId: 'seed-sender',
        body: b,
        createdAt: new Date().toISOString(),
        isOwnMessage: true,
        attachment: null,
      })
    },
    { fid: friendshipId, b: body },
  )
}

async function openProfilePopupFor(page: Page, profileId: string, displayName: string): Promise<void> {
  await openTopicsScreen(page)
  await page.waitForTimeout(30)
  await deliverNextResponseWithAuthor(page, 'topic-general', `msg-from-${profileId}`, profileId, displayName)
  await page.waitForSelector(`[data-topic-message-author="${profileId}"]`, { state: 'attached', timeout: 3000 })
  await clickMessageAuthor(page, profileId)
  await page.waitForTimeout(20)
  await deliverNextProfileResponse(page, profileId)
  await page.waitForSelector('[data-player-profile-popup-root="1"]', { state: 'attached', timeout: 3000 })
  await page.waitForTimeout(20)
}

function pikaConversation(friendshipId: string, profileId: string, displayName: string) {
  return {
    friendshipId,
    kind: 'pika_support',
    friend: { profileId, displayName, avatarUrl: null, isOnline: true },
    lastMessage: null,
    updatedAt: new Date().toISOString(),
    unreadCount: 0,
    isArchived: false,
  }
}

console.log('\ncheckPikaSupportChatRouting\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({
    root: process.cwd(),
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
  })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/topicsSwitchRaceHarness.html`

  browser = await chromium.launch()

  // ─── A: Deterministic cross-delivery repro (matches production report exactly) ───
  await (async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })

    // PIKABG е "own profile" за viewer-а в тази сесия — самоличността, чрез
    // която shouldShowPikaSupportChatButton (createLobbyFlowController.ts)
    // разрешава бутона "ЧАТ" в profile popup-а на ЧУЖД профил.
    await setOwnProfileOverrides(page, { profileId: OFFICIAL_PIKA_PROFILE_ID, displayName: 'PIKABG' })

    await openTopicsScreen(page)
    await deliverNextResponse(page, 'topic-general')
    await page.waitForTimeout(20)

    // Frank — обикновен приятел на PIKABG, kind='friend', НАЙ-скоро обновен
    // разговор. Реалистичен setup (EC1 в checkOfficialPikaSupportChat.ts
    // изрично потвърждава, че PIKABG може едновременно да има kind='friend' И
    // kind='pika_support' разговор с различни хора) — точно този 'friend' ред
    // е "жертвата", в която старият filter bug мълчаливо пренасочваше съобщения.
    await setChatConversations(page, [
      {
        friendshipId: 'friendship-frank',
        kind: 'friend',
        friend: { profileId: 'frank', displayName: 'Frank', avatarUrl: null, isOnline: true },
        lastMessage: null,
        updatedAt: new Date().toISOString(),
        unreadCount: 0,
        isArchived: false,
      },
    ])

    await check('[A1] PIKABG отваря профила на Y и вижда "ЧАТ" бутона', async () => {
      await openProfilePopupFor(page, 'user-y', 'Yana')
      const visible = await isPikaSupportChatButtonVisible(page)
      assert(visible === true, '"ЧАТ" бутонът трябва да е видим за официалния PIKABG профил')
    })

    await check('[A2] Клик "ЧАТ" за Y стартира pika_support заявка (pending)', async () => {
      await clickPikaSupportChatButton(page)
      await page.waitForTimeout(20)
      const pending = await isPikaStartPending(page, 'user-y')
      assert(pending === true, 'onPikaSupportChatStart за user-y трябва да е pending')
    })

    await check('[A3] След resolve, composer формата е bind-ната към Y-ринг friendshipId, НЕ към Frank', async () => {
      await addChatConversation(page, pikaConversation('friendship-y', 'user-y', 'Yana'))
      await deliverNextPikaStartResponse(page, 'user-y', 'friendship-y')
      await page.waitForSelector('[data-lobby-chat-form]', { state: 'attached', timeout: 3000 })
      await page.waitForTimeout(20)
      const boundId = await getChatFormFriendshipId(page)
      assert(boundId === 'friendship-y', `composer формата трябва да сочи friendship-y, получих "${boundId}" (бъг: fallback към Frank/друг разговор)`)
      const headerText = await getActiveChatHeaderText(page)
      assert((headerText ?? '').includes('Yana'), `header трябва да показва "Yana", получих "${headerText}"`)
    })

    await check('[A4] Изпращане на Y1 отива в friendship-y; Frank не получава нищо', async () => {
      await fillAndSubmitChatForm(page, 'Y1')
      await page.waitForTimeout(30)
      const log = await getChatSentLog(page)
      const last = log[log.length - 1]
      assert(last?.friendshipId === 'friendship-y' && last?.body === 'Y1', `последното изпратено съобщение трябва да е {friendship-y, Y1}, получих ${JSON.stringify(last)}`)
      const frankMessages = await getChatMessageBodies(page, 'friendship-frank')
      assert(frankMessages.length === 0, `Frank НЕ трябва да получи съобщение, получих ${JSON.stringify(frankMessages)}`)
    })

    await check('[A5] Без reload: PIKABG отваря профила на X и вижда "ЧАТ" отново', async () => {
      await openProfilePopupFor(page, 'user-x', 'Xavier')
      const visible = await isPikaSupportChatButtonVisible(page)
      assert(visible === true, '"ЧАТ" бутонът трябва да е видим и за X')
    })

    await check('[A6] ПРЕДИ изпращане: visible target = X И composer формата сочи friendship-x (не friendship-y, не Frank)', async () => {
      await clickPikaSupportChatButton(page)
      await addChatConversation(page, pikaConversation('friendship-x', 'user-x', 'Xavier'))
      await deliverNextPikaStartResponse(page, 'user-x', 'friendship-x')
      await page.waitForTimeout(30)
      const boundId = await getChatFormFriendshipId(page)
      assert(boundId === 'friendship-x', `composer формата трябва да сочи friendship-x, получих "${boundId}"`)
      const headerText = await getActiveChatHeaderText(page)
      assert((headerText ?? '').includes('Xavier'), `header трябва да показва "Xavier", получих "${headerText}"`)
    })

    await check('[A7] Изпращане на X1 отива в friendship-x; friendship-y и Frank остават непроменени (нулево cross-delivery)', async () => {
      await fillAndSubmitChatForm(page, 'X1')
      await page.waitForTimeout(30)
      const log = await getChatSentLog(page)
      const last = log[log.length - 1]
      assert(last?.friendshipId === 'friendship-x' && last?.body === 'X1', `последното изпратено съобщение трябва да е {friendship-x, X1}, получих ${JSON.stringify(last)}`)
      const yMessages = await getChatMessageBodies(page, 'friendship-y')
      assert(JSON.stringify(yMessages) === JSON.stringify(['Y1']), `friendship-y трябва да съдържа само ['Y1'], получих ${JSON.stringify(yMessages)}`)
      const frankMessages = await getChatMessageBodies(page, 'friendship-frank')
      assert(frankMessages.length === 0, `Frank трябва да остане с 0 съобщения, получих ${JSON.stringify(frankMessages)}`)
    })

    await check('[A8] Повторение Y→X→Y→X: всяко отваряне свързва правилния friendshipId, без "дрейф" на активния разговор', async () => {
      await openProfilePopupFor(page, 'user-y', 'Yana')
      await clickPikaSupportChatButton(page)
      await deliverNextPikaStartResponse(page, 'user-y', 'friendship-y')
      await page.waitForTimeout(30)
      assert((await getChatFormFriendshipId(page)) === 'friendship-y', 'втори отвор на Y трябва пак да сочи friendship-y')

      await openProfilePopupFor(page, 'user-x', 'Xavier')
      await clickPikaSupportChatButton(page)
      await deliverNextPikaStartResponse(page, 'user-x', 'friendship-x')
      await page.waitForTimeout(30)
      assert((await getChatFormFriendshipId(page)) === 'friendship-x', 'втори отвор на X трябва пак да сочи friendship-x')
    })

    assert(errors.length === 0, `нямаше очаквани browser console грешки, получих: ${errors.join(', ')}`)
    await context.close()
  })()

  // ─── B: Async race guard (activeChatRequestGeneration defense-in-depth) ───
  await (async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })
    await setOwnProfileOverrides(page, { profileId: OFFICIAL_PIKA_PROFILE_ID, displayName: 'PIKABG' })
    await openTopicsScreen(page)
    await deliverNextResponse(page, 'topic-general')
    await page.waitForTimeout(20)
    await setChatConversations(page, [])

    await check('[B1] X кликнат ПЪРВИ (по-бавна заявка), после Y кликнат (по-бърза) — Y resolve-ва първи, X остава pending', async () => {
      await openProfilePopupFor(page, 'race-x', 'RaceX')
      await clickPikaSupportChatButton(page)
      await page.waitForTimeout(10)
      assert((await isPikaStartPending(page, 'race-x')) === true, 'race-x трябва да е pending')

      // Operator затваря popup-а, докато race-x заявката още чака (реален
      // production сценарий — не блокиращо чакане на бавна мрежа).
      await closeProfilePopup(page)

      await openProfilePopupFor(page, 'race-y', 'RaceY')
      await clickPikaSupportChatButton(page)
      await page.waitForTimeout(10)
      assert((await isPikaStartPending(page, 'race-y')) === true, 'race-y трябва да е pending')

      await addChatConversation(page, pikaConversation('friendship-race-y', 'race-y', 'RaceY'))
      await deliverNextPikaStartResponse(page, 'race-y', 'friendship-race-y')
      await page.waitForSelector('[data-lobby-chat-form]', { state: 'attached', timeout: 3000 })
      await page.waitForTimeout(30)
      const boundAfterY = await getChatFormFriendshipId(page)
      assert(boundAfterY === 'friendship-race-y', `след Y resolve, composer-ът трябва да сочи friendship-race-y, получих "${boundAfterY}"`)
    })

    await check('[B2] Закъснелият X отговор (по-рано кликнат) НЕ презаписва вече активния Y разговор', async () => {
      await addChatConversation(page, pikaConversation('friendship-race-x', 'race-x', 'RaceX'))
      await deliverNextPikaStartResponse(page, 'race-x', 'friendship-race-x')
      await page.waitForTimeout(60)
      const boundId = await getChatFormFriendshipId(page)
      assert(boundId === 'friendship-race-y', `закъснелият X отговор НЕ трябва да превземе активния разговор — очаквах friendship-race-y, получих "${boundId}" (race guard fail: activeChatRequestGeneration)`)
    })

    await context.close()
  })()

  // ─── C: X has blocked PIKABG — confirmed server policy (chatStore.ts):
  // blockChecker е проверен само на SEND (authorizeSendMessage/sendMessage),
  // НЕ на getOrCreatePikaSupportConversation — conversation start/find
  // success-ва независимо от block статус (виж checkOfficialPikaSupportChat.ts
  // "[extra] blocked recipients still cannot receive new messages...").
  // Очакване тук: start успява, SEND се отхвърля explicit, а Y (несвързан,
  // предварително съществуващ разговор) остава напълно недокоснат — 0 нови
  // съобщения, независимо от блокирания опит с X. ───
  await (async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })
    await setOwnProfileOverrides(page, { profileId: OFFICIAL_PIKA_PROFILE_ID, displayName: 'PIKABG' })
    await openTopicsScreen(page)
    await deliverNextResponse(page, 'topic-general')
    await page.waitForTimeout(20)

    // Y — несвързан, предварително съществуващ pika_support разговор с 1
    // seed съобщение, за да можем да потвърдим, че остава напълно недокоснат.
    await setChatConversations(page, [pikaConversation('friendship-y-block', 'user-y-block', 'YBlock')])
    await seedChatMessage(page, 'friendship-y-block', 'Y_SEED')

    await check('[C1] PIKABG отваря профила на X (X е блокирал PIKABG) — start на разговора УСПЯВА (потвърдена server policy: block се проверява само на SEND, не на start)', async () => {
      await openProfilePopupFor(page, 'user-x-block', 'XBlock')
      await clickPikaSupportChatButton(page)
      await addChatConversation(page, pikaConversation('friendship-x-block', 'user-x-block', 'XBlock'))
      await deliverNextPikaStartResponse(page, 'user-x-block', 'friendship-x-block')
      await page.waitForSelector('[data-lobby-chat-form]', { state: 'attached', timeout: 3000 })
      await page.waitForTimeout(20)
      const boundId = await getChatFormFriendshipId(page)
      assert(boundId === 'friendship-x-block', `composer формата трябва да сочи friendship-x-block (start не се гейтва от block), получих "${boundId}"`)
    })

    await check('[C2] Опит за SEND към X се отхвърля explicit (симулира сървърния blockChecker в authorizeSendMessage/sendMessage)', async () => {
      await setChatSendBlocked(page, 'friendship-x-block', true)
      const logBefore = await getChatSentLog(page)
      await fillAndSubmitChatForm(page, 'BLOCKED_ATTEMPT')
      await page.waitForTimeout(30)
      const logAfter = await getChatSentLog(page)
      assert(logAfter.length === logBefore.length, `блокираният SEND НЕ трябва да се появи в sent log-а, получих ${JSON.stringify(logAfter)}`)
      const headerText = await getActiveChatHeaderText(page)
      assert((headerText ?? '').includes('блокиране'), `трябва да се покаже съобщение за блокиране, получих "${headerText}"`)
      const xMessages = await getChatMessageBodies(page, 'friendship-x-block')
      assert(xMessages.length === 0, `отхвърленото съобщение НЕ трябва да се появи в friendship-x-block, получих ${JSON.stringify(xMessages)}`)
    })

    await check('[C3] Y (несвързан разговор) получава НУЛА нови съобщения от блокирания опит с X', async () => {
      const yMessages = await getChatMessageBodies(page, 'friendship-y-block')
      assert(JSON.stringify(yMessages) === JSON.stringify(['Y_SEED']), `friendship-y-block трябва да остане непроменен (само seed съобщението), получих ${JSON.stringify(yMessages)}`)
    })

    await context.close()
  })()
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\ncheckPikaSupportChatRouting: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
