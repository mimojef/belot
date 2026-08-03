import { createServer as createNetServer } from 'node:net'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createViteServer, type ViteDevServer } from 'vite'

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

type FlowHarness = {
  url: string
  readyExpression: string
  open: (page: Page) => Promise<void>
  input: string
  button: string
  activeId: string
  getSentBodies: (page: Page) => Promise<string[]>
  failText: string
}

async function expectReadyForSecondMessage(page: Page, flow: FlowHarness, expectedSent: string[], label: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const inputIsEmpty = await page.evaluate((inputSelector) => {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector)
      return input !== null && input.value === ''
    }, flow.input)
    const sent = await flow.getSentBodies(page)
    if (inputIsEmpty && JSON.stringify(sent) === JSON.stringify(expectedSent)) break
    await page.waitForTimeout(50)
  }
  const sentAfterWait = await flow.getSentBodies(page)
  assert(JSON.stringify(sentAfterWait) === JSON.stringify(expectedSent), `${label}: sent bodies mismatch ${JSON.stringify(sentAfterWait)}`)
  const snapshot = await page.evaluate((inputSelector) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector)
    return {
      active: document.activeElement === input,
      value: input?.value ?? null,
      selectionStart: input?.selectionStart ?? null,
      selectionEnd: input?.selectionEnd ?? null,
      activeId: input?.closest('form')?.getAttribute('data-lobby-chat-form') ??
        input?.closest('form')?.getAttribute('data-admin-support-reply-form') ??
        (input?.closest('[data-support-send-form="1"]') ? 'user-support' : null),
    }
  }, flow.input)
  assert(snapshot.value === '', `${label}: input should be empty after success`)
  assert(snapshot.active, `${label}: composer should be focused after success`)
  assert(snapshot.selectionStart === 0 && snapshot.selectionEnd === 0, `${label}: caret should be at the beginning`)
  assert(snapshot.activeId === flow.activeId, `${label}: active conversation changed`)

  await page.keyboard.type('second message')
  const secondDraft = await page.locator(flow.input).inputValue()
  assert(secondDraft === 'second message', `${label}: second message did not type into the same focused composer`)
}

async function runSuccessScenario(browser: Browser, baseUrl: string, flow: FlowHarness, mode: 'enter' | 'button'): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  try {
    await page.goto(`${baseUrl}${flow.url}`)
    await page.waitForFunction(flow.readyExpression)
    await flow.open(page)
    await page.waitForSelector(flow.input)

    await page.locator(flow.input).fill('first message')
    if (mode === 'enter') {
      await page.locator(flow.input).press('Enter')
    } else {
      await page.locator(flow.button).click()
    }
    await expectReadyForSecondMessage(page, flow, ['first message'], `${flow.activeId} ${mode} first send`)

    if (mode === 'enter') {
      await page.locator(flow.input).press('Enter')
    } else {
      await page.locator(flow.button).click()
    }
    await expectReadyForSecondMessage(page, flow, ['first message', 'second message'], `${flow.activeId} ${mode} second send`)
  } finally {
    await page.close()
  }
}

async function runFailureScenario(browser: Browser, baseUrl: string, flow: FlowHarness): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  try {
    await page.goto(`${baseUrl}${flow.url}`)
    await page.waitForFunction(flow.readyExpression)
    await flow.open(page)
    await page.waitForSelector(flow.input)
    const before = await flow.getSentBodies(page)

    await page.locator(flow.input).fill(flow.failText)
    await page.evaluate((inputSelector) => {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector)
      if (!input) throw new Error('missing input for failure selection')
      input.focus()
      input.setSelectionRange(2, 7, 'forward')
    }, flow.input)
    await page.locator(flow.input).press('Enter')
    await page.waitForTimeout(150)

    const after = await flow.getSentBodies(page)
    const snapshot = await page.evaluate((inputSelector) => {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector)
      return {
        value: input?.value ?? '',
        active: document.activeElement === input,
        selectionStart: input?.selectionStart ?? null,
        selectionEnd: input?.selectionEnd ?? null,
      }
    }, flow.input)
    assert(JSON.stringify(after) === JSON.stringify(before), `${flow.activeId}: failure should not count as a successful send`)
    assert(snapshot.value === flow.failText, `${flow.activeId}: failure should preserve draft`)
    assert(snapshot.active, `${flow.activeId}: failure should preserve focus`)
    assert(snapshot.selectionStart === 2 && snapshot.selectionEnd === 7, `${flow.activeId}: failure should preserve selection`)
  } finally {
    await page.close()
  }
}

async function runPersonalStaleResponseScenario(browser: Browser, baseUrl: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  try {
    await page.goto(`${baseUrl}/scripts/fixtures/chatDraftHarness.html`)
    await page.waitForFunction(() => (window as any).__chatDraftHarness !== undefined)
    await page.evaluate(() => (window as any).__chatDraftHarness.openConversation('friendship-a'))
    await page.waitForSelector('[data-lobby-chat-message-input="1"]')
    await page.evaluate(() => (window as any).__chatDraftHarness.delayNextPersonalSend())
    await page.locator('[data-lobby-chat-message-input="1"]').fill('slow first')
    await page.locator('[data-lobby-chat-message-input="1"]').press('Enter')

    await page.evaluate(() => (window as any).__chatDraftHarness.openConversation('friendship-b'))
    await page.waitForSelector('[data-lobby-chat-form="friendship-b"] [data-lobby-chat-message-input="1"]')
    await page.locator('[data-lobby-chat-form="friendship-b"] [data-lobby-chat-message-input="1"]').fill('current b')
    await page.locator('[data-lobby-chat-form="friendship-b"] [data-lobby-chat-message-input="1"]').click()
    await page.evaluate(() => (window as any).__chatDraftHarness.resolveDelayedPersonalSend())
    await page.waitForTimeout(150)

    const snapshot = await page.evaluate(() => {
      const inputB = document.querySelector<HTMLInputElement>('[data-lobby-chat-form="friendship-b"] [data-lobby-chat-message-input="1"]')
      return {
        activeB: document.activeElement === inputB,
        valueB: inputB?.value ?? '',
        hasAInput: document.querySelector('[data-lobby-chat-form="friendship-a"] [data-lobby-chat-message-input="1"]') !== null,
      }
    })
    assert(snapshot.activeB, 'delayed personal response should not steal focus from current conversation')
    assert(snapshot.valueB === 'current b', 'delayed personal response should not overwrite current conversation draft')
    assert(!snapshot.hasAInput, 'old personal conversation should not become active again')
  } finally {
    await page.close()
  }
}

async function runAdminStaleResponseScenario(browser: Browser, baseUrl: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  try {
    await page.goto(`${baseUrl}/scripts/fixtures/adminSupportHarness.html`)
    await page.waitForFunction(() => (window as any).__adminSupportHarness !== undefined)
    await page.evaluate(async () => {
      await (window as any).__adminSupportHarness.openInbox()
      await (window as any).__adminSupportHarness.openConversation('user-profile')
    })
    await page.waitForSelector('[data-admin-support-reply-form="user-profile"] textarea[name="body"]')
    await page.evaluate(() => (window as any).__adminSupportHarness.delayNextReply())
    await page.locator('[data-admin-support-reply-form="user-profile"] textarea[name="body"]').fill('slow admin')
    await page.locator('[data-admin-support-reply-form="user-profile"] textarea[name="body"]').press('Enter')

    await page.evaluate(async () => {
      await (window as any).__adminSupportHarness.openConversation('other-profile')
    })
    await page.waitForSelector('[data-admin-support-reply-form="other-profile"] textarea[name="body"]')
    await page.locator('[data-admin-support-reply-form="other-profile"] textarea[name="body"]').fill('current other')
    await page.locator('[data-admin-support-reply-form="other-profile"] textarea[name="body"]').click()
    await page.evaluate(() => (window as any).__adminSupportHarness.resolveDelayedReply())
    await page.waitForTimeout(150)

    const snapshot = await page.evaluate(() => {
      const other = document.querySelector<HTMLTextAreaElement>('[data-admin-support-reply-form="other-profile"] textarea[name="body"]')
      return {
        activeOther: document.activeElement === other,
        valueOther: other?.value ?? '',
        hasOldForm: document.querySelector('[data-admin-support-reply-form="user-profile"]') !== null,
      }
    })
    assert(snapshot.activeOther, 'delayed admin response should not steal focus from current conversation')
    assert(snapshot.valueOther === 'current other', 'delayed admin response should not overwrite current draft')
    assert(!snapshot.hasOldForm, 'old admin support conversation should not become active again')
  } finally {
    await page.close()
  }
}

console.log('\ncheckChatSendRefocus\n')

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

  const personal: FlowHarness = {
    url: '/scripts/fixtures/chatDraftHarness.html',
    readyExpression: '() => window.__chatDraftHarness !== undefined',
    open: async (page) => {
      await page.evaluate(() => (window as any).__chatDraftHarness.openConversation('friendship-a'))
    },
    input: '[data-lobby-chat-form="friendship-a"] [data-lobby-chat-message-input="1"]',
    button: '[data-lobby-chat-form="friendship-a"] button[type="submit"]',
    activeId: 'friendship-a',
    getSentBodies: async (page) => await page.evaluate(() => (window as any).__chatDraftHarness.getPersonalSentBodies()),
    failText: '__FAIL_SEND__ keep draft',
  }

  const userSupport: FlowHarness = {
    url: '/scripts/fixtures/chatDraftHarness.html',
    readyExpression: '() => window.__chatDraftHarness !== undefined',
    open: async (page) => {
      await page.evaluate(async () => { await (window as any).__chatDraftHarness.openSupportPopup() })
    },
    input: '[data-support-send-form="1"] textarea[name="body"]',
    button: '[data-support-send-form="1"] [data-support-composer-send="1"]',
    activeId: 'user-support',
    getSentBodies: async (page) => await page.evaluate(() => (window as any).__chatDraftHarness.getSupportSentBodies()),
    failText: '__FAIL_SUPPORT__ keep draft',
  }

  const adminSupport: FlowHarness = {
    url: '/scripts/fixtures/adminSupportHarness.html',
    readyExpression: '() => window.__adminSupportHarness !== undefined',
    open: async (page) => {
      await page.evaluate(async () => {
        await (window as any).__adminSupportHarness.openInbox()
        await (window as any).__adminSupportHarness.openConversation('user-profile')
      })
    },
    input: '[data-admin-support-reply-form="user-profile"] textarea[name="body"]',
    button: '[data-admin-support-reply-form="user-profile"] [data-support-composer-send="1"]',
    activeId: 'user-profile',
    getSentBodies: async (page) => await page.evaluate(() => (window as any).__adminSupportHarness.getSentBodies()),
    failText: '__FAIL_ADMIN_SUPPORT__ keep draft',
  }

  for (const flow of [personal, userSupport, adminSupport]) {
    await check(`${flow.activeId}: Enter success refocus`, () => runSuccessScenario(browser!, baseUrl, flow, 'enter'))
    await check(`${flow.activeId}: send button success refocus`, () => runSuccessScenario(browser!, baseUrl, flow, 'button'))
    await check(`${flow.activeId}: failure preserves draft focus and selection`, () => runFailureScenario(browser!, baseUrl, flow))
  }
  await check('personal chat: delayed old response does not steal focus after conversation switch', () => runPersonalStaleResponseScenario(browser!, baseUrl))
  await check('admin support: delayed old response does not steal focus after conversation switch', () => runAdminStaleResponseScenario(browser!, baseUrl))
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\nChat send refocus checks: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
