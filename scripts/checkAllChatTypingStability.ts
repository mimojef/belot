import { createServer as createNetServer } from 'node:net'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import {
  renderAdminSupportPage,
  type LobbyScreenState,
} from '../src/app/lobby/renderLobbyScreen.js'

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
  } catch (error) {
    fail(label, error)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('could not allocate a free port'))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

type TextInputSelector = {
  input: string
  scroll: string
  activeId?: () => string
}

async function assertSequentialTyping(page: Page, selector: TextInputSelector, label: string): Promise<void> {
  const expectedText = 'hello world'
  await page.locator(selector.input).click()
  const expectedScrollTop = await page.evaluate(({ inputSelector, scrollSelector }) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector)
    const scroll = document.querySelector<HTMLElement>(scrollSelector)
    if (input) {
      ;(window as any).__firstChatComposer = input
      input.scrollTop = 11
    }
    if (scroll) scroll.scrollTop = 64
    return scroll?.scrollTop ?? null
  }, { inputSelector: selector.input, scrollSelector: selector.scroll })

  let expected = ''
  for (const char of expectedText) {
    expected += char
    await page.locator(selector.input).type(char)
    const snapshot = await page.evaluate(({ inputSelector, scrollSelector }) => {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector)
      const scroll = document.querySelector<HTMLElement>(scrollSelector)
      return {
        exists: input !== null,
        sameElement: input === (window as any).__firstChatComposer,
        value: input?.value ?? '',
        active: document.activeElement === input,
        selectionStart: input?.selectionStart ?? null,
        selectionEnd: input?.selectionEnd ?? null,
        scrollTop: scroll?.scrollTop ?? null,
      }
    }, { inputSelector: selector.input, scrollSelector: selector.scroll })

    assert(snapshot.exists, `${label}: composer disappeared while typing`)
    assert(snapshot.sameElement, `${label}: composer DOM element was replaced during normal input`)
    assert(snapshot.value === expected, `${label}: expected draft "${expected}", got "${snapshot.value}"`)
    assert(snapshot.active, `${label}: composer lost focus while typing`)
    assert(snapshot.selectionStart === expected.length && snapshot.selectionEnd === expected.length, `${label}: caret moved while typing`)
    assert(snapshot.scrollTop === expectedScrollTop, `${label}: message scroll reset while typing`)
  }
}

async function assertExternalRenderRestores(
  page: Page,
  selector: TextInputSelector,
  label: string,
  trigger: () => Promise<void>,
): Promise<void> {
  await page.locator(selector.input).fill('hello world')
  const expectedScrollTop = await page.evaluate(({ inputSelector, scrollSelector }) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector)
    const scroll = document.querySelector<HTMLElement>(scrollSelector)
    if (!input) throw new Error('missing input before external render')
    input.focus()
    input.setSelectionRange(5, 5, 'none')
    input.scrollTop = 9
    if (scroll) scroll.scrollTop = 41
    return scroll?.scrollTop ?? null
  }, { inputSelector: selector.input, scrollSelector: selector.scroll })

  await trigger()
  await page.waitForTimeout(80)

  const snapshot = await page.evaluate(({ inputSelector, scrollSelector }) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector)
    const scroll = document.querySelector<HTMLElement>(scrollSelector)
    return {
      exists: input !== null,
      value: input?.value ?? '',
      active: document.activeElement === input,
      selectionStart: input?.selectionStart ?? null,
      selectionEnd: input?.selectionEnd ?? null,
      inputScrollTop: input?.scrollTop ?? null,
      messageScrollTop: scroll?.scrollTop ?? null,
    }
  }, { inputSelector: selector.input, scrollSelector: selector.scroll })

  assert(snapshot.exists, `${label}: composer disappeared after external render`)
  assert(snapshot.value === 'hello world', `${label}: draft was lost after external render`)
  assert(snapshot.active, `${label}: focus was not restored after external render`)
  assert(snapshot.selectionStart === 5 && snapshot.selectionEnd === 5, `${label}: caret was not restored after external render`)
  assert(snapshot.messageScrollTop === expectedScrollTop, `${label}: message scroll was not restored after external render`)
}

async function assertSelectionRangeRestores(
  page: Page,
  selector: TextInputSelector,
  label: string,
  trigger: () => Promise<void>,
): Promise<void> {
  await page.locator(selector.input).fill('hello world')
  await page.evaluate((inputSelector) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector)
    if (!input) throw new Error('missing input before selection test')
    input.focus()
    input.setSelectionRange(2, 7, 'forward')
  }, selector.input)

  await trigger()
  await page.waitForTimeout(80)

  const snapshot = await page.evaluate((inputSelector) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector)
    return {
      active: document.activeElement === input,
      selectionStart: input?.selectionStart ?? null,
      selectionEnd: input?.selectionEnd ?? null,
    }
  }, selector.input)

  assert(snapshot.active, `${label}: focus was not restored for selected text`)
  assert(snapshot.selectionStart === 2 && snapshot.selectionEnd === 7, `${label}: selected range was not restored`)
}

async function runPersonalChat(baseUrl: string, browser: Browser, mobile: boolean): Promise<void> {
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 },
    isMobile: mobile,
    hasTouch: mobile,
  })
  try {
    await page.goto(`${baseUrl}/scripts/fixtures/chatDraftHarness.html`)
    await page.waitForFunction(() => (window as any).__chatDraftHarness !== undefined)
    await page.evaluate(() => (window as any).__chatDraftHarness.openConversation('friendship-a'))
    await page.waitForSelector('[data-lobby-chat-message-input="1"]')

    const selector = {
      input: '[data-lobby-chat-message-input="1"]',
      scroll: '[data-chat-messages-scroll="1"]',
    }
    await check(`personal chat ${mobile ? 'mobile' : 'desktop'}: sequential typing stability`, () => assertSequentialTyping(page, selector, 'personal chat'))
    await check(`personal chat ${mobile ? 'mobile' : 'desktop'}: incoming/background render restores draft focus caret scroll`, () => assertExternalRenderRestores(
      page,
      selector,
      'personal chat',
      async () => {
        await page.evaluate(() => (window as any).__chatDraftHarness.deliverIncomingMessage('friendship-a', 'incoming while typing'))
        await page.waitForFunction(() => (document.querySelector('[data-chat-messages-scroll="1"]')?.textContent ?? '').includes('incoming while typing'))
      },
    ))
    await check(`personal chat ${mobile ? 'mobile' : 'desktop'}: selected range survives external render`, () => assertSelectionRangeRestores(
      page,
      selector,
      'personal chat',
      async () => {
        await page.evaluate(() => (window as any).__chatDraftHarness.triggerUnrelatedBackgroundRender())
      },
    ))
  } finally {
    await page.close()
  }
}

async function runLobbyLiveChat(baseUrl: string, browser: Browser, mobile: boolean): Promise<void> {
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 },
    isMobile: mobile,
    hasTouch: mobile,
  })
  try {
    await page.goto(`${baseUrl}/scripts/fixtures/chatDraftHarness.html`)
    await page.waitForFunction(() => (window as any).__chatDraftHarness !== undefined)
    await page.evaluate(() => (window as any).__chatDraftHarness.openLobbyChat())
    await page.waitForSelector('[data-lobby-livechat-input="1"]')

    const selector = {
      input: '[data-lobby-livechat-input="1"]',
      scroll: '[data-lobby-livechat-messages-scroll="1"]',
    }
    const mode = mobile ? 'mobile' : 'desktop'
    await check(`lobby live chat ${mode}: sequential typing stability`, () => assertSequentialTyping(page, selector, 'lobby live chat'))
    await check(`lobby live chat ${mode}: incoming render restores draft focus caret scroll`, () => assertExternalRenderRestores(
      page,
      selector,
      'lobby live chat',
      async () => {
        await page.evaluate(() => (window as any).__chatDraftHarness.deliverLobbyChatMessage('live incoming while typing'))
        await page.waitForFunction(() => (document.querySelector('[data-lobby-livechat-messages-scroll="1"]')?.textContent ?? '').includes('live incoming while typing'))
      },
    ))
    await check(`lobby live chat ${mode}: selected range survives external render`, () => assertSelectionRangeRestores(
      page,
      selector,
      'lobby live chat',
      async () => {
        await page.evaluate(() => (window as any).__chatDraftHarness.triggerUnrelatedBackgroundRender())
      },
    ))
  } finally {
    await page.close()
  }
}

function makeRoom(memberCount = 2): any {
  const members = [
    { seat: 'south', profileId: 'me', displayName: 'Me', avatarUrl: null, isHost: true, isBot: false },
    { seat: 'west', profileId: 'friend-a', displayName: 'Friend A', avatarUrl: null, isHost: false, isBot: false },
  ]
  if (memberCount >= 3) members.push({ seat: 'north', profileId: 'friend-b', displayName: 'Friend B', avatarUrl: null, isHost: false, isBot: false })
  return {
    id: 'private-room-1',
    kind: 'open',
    stake: 1000,
    members,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 300_000,
  }
}

async function runPrivateRoomChat(baseUrl: string, browser: Browser, mobile: boolean): Promise<void> {
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 },
    isMobile: mobile,
    hasTouch: mobile,
  })
  try {
    await page.goto(`${baseUrl}/scripts/fixtures/privateRoomWaitingHarness.html`)
    await page.waitForFunction(() => (window as any).__prwHarness !== undefined)
    await page.evaluate((room) => (window as any).__prwHarness.pushRoomUpdated(room), makeRoom())
    await page.waitForSelector('[data-private-waiting-chat-input="1"]')

    const selector = {
      input: '[data-private-waiting-chat-input="1"]',
      scroll: '[data-private-waiting-chat-scroll="1"]',
    }
    await check(`private-room waiting chat ${mobile ? 'mobile' : 'desktop'}: sequential typing stability`, () => assertSequentialTyping(page, selector, 'private-room waiting chat'))
    await check(`private-room waiting chat ${mobile ? 'mobile' : 'desktop'}: room update render restores draft focus caret scroll`, () => assertExternalRenderRestores(
      page,
      selector,
      'private-room waiting chat',
      async () => {
        await page.evaluate((room) => (window as any).__prwHarness.pushRoomUpdated(room), makeRoom(3))
      },
    ))
    await check(`private-room waiting chat ${mobile ? 'mobile' : 'desktop'}: selected range survives room update`, () => assertSelectionRangeRestores(
      page,
      selector,
      'private-room waiting chat',
      async () => {
        await page.evaluate((room) => (window as any).__prwHarness.pushRoomUpdated(room), makeRoom(2))
      },
    ))
  } finally {
    await page.close()
  }
}

async function runUserSupportChat(baseUrl: string, browser: Browser, mobile: boolean): Promise<void> {
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 },
    isMobile: mobile,
    hasTouch: mobile,
  })
  try {
    await page.goto(`${baseUrl}/scripts/fixtures/chatDraftHarness.html`)
    await page.waitForFunction(() => (window as any).__chatDraftHarness !== undefined)
    await page.evaluate(() => (window as any).__chatDraftHarness.openSupportPopup())
    await page.waitForSelector('[data-support-send-form="1"] textarea[name="body"]')

    const selector = {
      input: '[data-support-send-form="1"] textarea[name="body"]',
      scroll: '#support-popup-messages-scroll',
    }
    await check(`user support chat ${mobile ? 'mobile' : 'desktop'}: sequential typing stability`, () => assertSequentialTyping(page, selector, 'user support chat'))
    await check(`user support chat ${mobile ? 'mobile' : 'desktop'}: background render restores draft focus caret scroll`, () => assertExternalRenderRestores(
      page,
      selector,
      'user support chat',
      async () => {
        await page.evaluate(() => (window as any).__chatDraftHarness.triggerUnrelatedBackgroundRender())
      },
    ))
    await check(`user support chat ${mobile ? 'mobile' : 'desktop'}: selected range survives background render`, () => assertSelectionRangeRestores(
      page,
      selector,
      'user support chat',
      async () => {
        await page.evaluate(() => (window as any).__chatDraftHarness.triggerUnrelatedBackgroundRender())
      },
    ))
  } finally {
    await page.close()
  }
}

// Production hotfix: Topics composers (root "Общ" + thread reply) бяха
// изпуснати от focus/caret preservation-а — несвързан badge/notification
// rerender (напр. chat_message_received за СЪВСЕМ друг разговор) крадеше
// focus-а от активно писане. Reuse-ва СЪЩИТЕ доказани helper-и
// (assertSequentialTyping/assertExternalRenderRestores/assertSelectionRangeRestores)
// като останалите composer-и по-горе — не е нов паралелен механизъм.
const UNRELATED_CHAT_NOTIFICATION = {
  type: 'chat_message_received' as const,
  friendshipId: 'unrelated-conversation-not-open',
  senderProfileId: 'someone-else',
  fromDisplayName: 'Someone Else',
  fromAvatarUrl: null,
  messageId: `unrelated-msg-${Date.now()}`,
  shouldNotify: true,
}

async function runTopicsRootComposer(baseUrl: string, browser: Browser, mobile: boolean): Promise<void> {
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 },
    isMobile: mobile,
    hasTouch: mobile,
  })
  try {
    await page.goto(`${baseUrl}/scripts/fixtures/topicsComposerVipGateHarness.html`)
    await page.waitForFunction(() => (window as any).__topicsComposerVipGateHarness !== undefined)
    await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.setVipGate(true, true))
    await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.setNextMessagesResult([]))
    await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.openTopicsScreen())
    await page.waitForSelector('[data-topics-composer-text="1"]', { state: 'attached' })

    const selector = {
      input: '[data-topics-composer-text="1"]',
      scroll: '[data-topic-messages-scroll="1"]',
    }
    const mode = mobile ? 'mobile' : 'desktop'
    await check(`Topics root composer ${mode}: sequential typing stability`, () => assertSequentialTyping(page, selector, 'Topics root composer'))
    await check(`Topics root composer ${mode}: unrelated notification/badge render restores draft focus caret scroll`, () => assertExternalRenderRestores(
      page,
      selector,
      'Topics root composer',
      async () => {
        await page.evaluate((message) => (window as any).__topicsComposerVipGateHarness.simulateServerMessage(message), UNRELATED_CHAT_NOTIFICATION)
      },
    ))
    await check(`Topics root composer ${mode}: selected range survives unrelated render`, () => assertSelectionRangeRestores(
      page,
      selector,
      'Topics root composer',
      async () => {
        await page.evaluate((message) => (window as any).__topicsComposerVipGateHarness.simulateServerMessage(message), { ...UNRELATED_CHAT_NOTIFICATION, messageId: `unrelated-msg-2-${Date.now()}` })
      },
    ))

    // Negative test [H]: потребителят explicit-но кликва извън composer-а
    // (blur) — следващ passive rerender НЕ трябва насила да върне focus-а
    // обратно в него (само защото беше последният focused елемент преди).
    await check(`Topics root composer ${mode}: explicit blur/click-outside is NOT overridden by a later unrelated render`, async () => {
      await page.locator(selector.input).fill('draft before clicking away')
      await page.evaluate((inputSelector) => {
        const input = document.querySelector<HTMLTextAreaElement>(inputSelector)
        input?.blur()
      }, selector.input)
      const blurredNow = await page.evaluate((inputSelector) => document.activeElement !== document.querySelector(inputSelector), selector.input)
      assert(blurredNow, 'composer must actually be blurred before the unrelated render fires')

      await page.evaluate((message) => (window as any).__topicsComposerVipGateHarness.simulateServerMessage(message), { ...UNRELATED_CHAT_NOTIFICATION, messageId: `unrelated-msg-blur-${Date.now()}` })
      await page.waitForTimeout(80)

      const stillBlurred = await page.evaluate((inputSelector) => document.activeElement !== document.querySelector(inputSelector), selector.input)
      assert(stillBlurred, 'explicit user blur must not be overridden — passive render must not force focus back into the composer')
    })
  } finally {
    await page.close()
  }
}

async function runTopicsReplyComposer(baseUrl: string, browser: Browser, mobile: boolean): Promise<void> {
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 },
    isMobile: mobile,
    hasTouch: mobile,
  })
  try {
    await page.goto(`${baseUrl}/scripts/fixtures/topicsComposerVipGateHarness.html`)
    await page.waitForFunction(() => (window as any).__topicsComposerVipGateHarness !== undefined)
    await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.setVipGate(true, true))
    const rootMessage = await page.evaluate(() =>
      (window as any).__topicsComposerVipGateHarness.makeMessage('topic-general', 1, 'RootMessageToReplyTo', 'someone', 'Someone'),
    )
    await page.evaluate((message) => (window as any).__topicsComposerVipGateHarness.setNextMessagesResult([message]), rootMessage)
    await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.openTopicsScreen())
    await page.waitForSelector('[data-topic-message-reply]', { state: 'attached' })
    await page.evaluate((id) => (window as any).__topicsComposerVipGateHarness.clickReplyButton(id), (rootMessage as any).messageId)
    await page.waitForSelector('[data-topics-reply-composer-text="1"]', { state: 'attached' })

    const selector = {
      input: '[data-topics-reply-composer-text="1"]',
      scroll: '[data-topic-messages-scroll="1"]',
    }
    const mode = mobile ? 'mobile' : 'desktop'
    await check(`Topics thread reply composer ${mode}: sequential typing stability`, () => assertSequentialTyping(page, selector, 'Topics reply composer'))
    await check(`Topics thread reply composer ${mode}: unrelated notification/badge render restores draft focus caret scroll`, () => assertExternalRenderRestores(
      page,
      selector,
      'Topics reply composer',
      async () => {
        await page.evaluate((message) => (window as any).__topicsComposerVipGateHarness.simulateServerMessage(message), UNRELATED_CHAT_NOTIFICATION)
      },
    ))
    await check(`Topics thread reply composer ${mode}: selected range survives unrelated render`, () => assertSelectionRangeRestores(
      page,
      selector,
      'Topics reply composer',
      async () => {
        await page.evaluate((message) => (window as any).__topicsComposerVipGateHarness.simulateServerMessage(message), { ...UNRELATED_CHAT_NOTIFICATION, messageId: `unrelated-msg-3-${Date.now()}` })
      },
    ))

    // Negative test [G]: explicit user navigation away от thread-а (Назад
    // към Общ) — passive re-render СЛЕД това НЕ трябва да върне focus в
    // вече несъществуващия/невидим reply composer.
    await check(`Topics thread reply composer ${mode}: navigating back to General then unrelated render does NOT refocus the old composer`, async () => {
      await page.locator(selector.input).fill('draft before navigating away')
      await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.clickThreadBack())
      await page.waitForSelector('[data-topics-reply-composer-text="1"]', { state: 'detached' })
      await page.evaluate((message) => (window as any).__topicsComposerVipGateHarness.simulateServerMessage(message), { ...UNRELATED_CHAT_NOTIFICATION, messageId: `unrelated-msg-4-${Date.now()}` })
      await page.waitForTimeout(80)
      const stillGone = await page.evaluate(() => document.querySelector('[data-topics-reply-composer-text="1"]') === null)
      assert(stillGone, 'reply composer must stay gone after navigating back to General — unrelated render must not reopen/refocus it')
    })
  } finally {
    await page.close()
  }
}

function makeAdminState(overrides: Partial<LobbyScreenState> = {}): LobbyScreenState {
  return {
    adminSupportConversations: [{
      profileId: 'user-profile',
      displayName: 'Support User',
      avatarUrl: null,
      lastMessageBody: 'Needs help',
      lastMessageIsFromAdmin: false,
      unreadByAdmin: 1,
      updatedAt: new Date('2026-08-03T10:00:00Z').toISOString(),
    }],
    adminSupportConversationsLoading: false,
    adminSupportSelectedProfileId: 'user-profile',
    adminSupportMessages: Array.from({ length: 18 }, (_, index) => ({
      messageId: `admin-message-${index + 1}`,
      profileId: 'user-profile',
      body: `Admin support history ${index + 1}`,
      isFromAdmin: index % 2 === 1,
      createdAt: new Date(2026, 7, 3, 10, index).toISOString(),
      attachment: null,
    })),
    adminSupportMessagesLoading: false,
    adminSupportReplyLoading: false,
    adminSupportReplyErrorText: null,
    adminSupportReplyDraftByProfileId: {},
    adminSupportPendingImageByProfileId: {},
    adminSupportDeleteConfirmProfileId: null,
    adminSupportDeleteLoading: false,
    adminSupportMobileConversationOpen: true,
    ...overrides,
  } as unknown as LobbyScreenState
}

async function runAdminSupportChat(browser: Browser, mobile: boolean): Promise<void> {
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 },
    isMobile: mobile,
    hasTouch: mobile,
  })
  try {
    const state = makeAdminState()
    await page.setContent(`
      <!doctype html>
      <html><body>
        <main id="root">${renderAdminSupportPage(state, mobile)}</main>
        <script>
          window.__adminSupportState = ${JSON.stringify(state)};
          window.__adminSupportRender = () => {
            const oldInput = document.querySelector('[data-admin-support-reply-form="user-profile"] textarea[name="body"]');
            const oldScroll = document.querySelector('#support-admin-messages-scroll');
            const focused = document.activeElement === oldInput;
            const selectionStart = focused ? oldInput.selectionStart : null;
            const selectionEnd = focused ? oldInput.selectionEnd : null;
            const selectionDirection = focused ? oldInput.selectionDirection : null;
            const inputScrollTop = focused ? oldInput.scrollTop : 0;
            const messageScrollTop = oldScroll ? oldScroll.scrollTop : 0;
            document.querySelector('#root').innerHTML = ${JSON.stringify(renderAdminSupportPage(state, mobile))};
            const nextInput = document.querySelector('[data-admin-support-reply-form="user-profile"] textarea[name="body"]');
            const nextScroll = document.querySelector('#support-admin-messages-scroll');
            if (nextInput) {
              nextInput.value = window.__adminSupportState.adminSupportReplyDraftByProfileId['user-profile'] || '';
              if (focused) {
                nextInput.focus();
                nextInput.scrollTop = inputScrollTop;
                nextInput.setSelectionRange(selectionStart, selectionEnd, selectionDirection || 'none');
              }
              nextInput.addEventListener('input', () => {
                window.__adminSupportState.adminSupportReplyDraftByProfileId['user-profile'] = nextInput.value;
              });
            }
            if (nextScroll) nextScroll.scrollTop = messageScrollTop;
          };
          window.__adminSupportRender();
        </script>
      </body></html>
    `)
    await page.waitForSelector('[data-admin-support-reply-form="user-profile"] textarea[name="body"]')

    const selector = {
      input: '[data-admin-support-reply-form="user-profile"] textarea[name="body"]',
      scroll: '#support-admin-messages-scroll',
    }
    await check(`admin support chat ${mobile ? 'mobile' : 'desktop'}: sequential typing stability`, () => assertSequentialTyping(page, selector, 'admin support chat'))
    await check(`admin support chat ${mobile ? 'mobile' : 'desktop'}: external render restores draft focus caret scroll`, () => assertExternalRenderRestores(
      page,
      selector,
      'admin support chat',
      async () => {
        await page.evaluate(() => (window as any).__adminSupportRender())
      },
    ))
  } finally {
    await page.close()
  }
}

console.log('\ncheckAllChatTypingStability\n')

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
  const baseUrl = `http://127.0.0.1:${port}`
  browser = await chromium.launch()

  for (const mobile of [false, true]) {
    await runPersonalChat(baseUrl, browser, mobile)
    await runLobbyLiveChat(baseUrl, browser, mobile)
    await runPrivateRoomChat(baseUrl, browser, mobile)
    await runUserSupportChat(baseUrl, browser, mobile)
    await runAdminSupportChat(browser, mobile)
    await runTopicsRootComposer(baseUrl, browser, mobile)
    await runTopicsReplyComposer(baseUrl, browser, mobile)
  }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\nAll chat typing stability checks: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

declare global {
  interface Window {
    __firstChatComposer: HTMLInputElement | HTMLTextAreaElement | null
  }
}
