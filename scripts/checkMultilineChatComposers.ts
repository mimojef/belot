/**
 * checkMultilineChatComposers.ts — многоредовите полета в реален Chromium:
 * личен чат, „Поддръжка“ (потребител) и „Поддръжка“ (администратор), на
 * компютър (1280×900) и телефон с докосване (390×844, isMobile + hasTouch).
 * Реалният контролер и рендериране (scripts/fixtures/chatDraftHarness.ts,
 * adminSupportHarness.ts) — само мрежата е подменена.
 *
 *   [B] празното поле е <textarea> със същата височина като досега
 *   [E] Enter: компютър — Shift+Enter нов ред, Enter изпраща; телефон — Enter
 *       нов ред, изпращане с бутона; изпратеният текст е многоредов
 *   [P] поставяне на многоредов текст (Ctrl+V) пази редовете и абзаците
 *   [G] автоматична височина до 132/120 px, после вътрешен скрол; празно -> начална
 *   [R] фоново прерисуване пази черновата, фокуса, маркирания текст, височината и скрола
 *   [L] над лимита на редовете (40/60): разбираемо съобщение, черновата и фокусът остават, без изпращане
 *   [D] задържан/двоен Enter -> едно изпращане; след успех полето е празно и с началната височина
 *   [V] балончето показва новите и празните редове (<br>), HTML се показва като текст
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkMultilineChatComposers.ts
 */

import { createServer as createNetServer } from 'node:net'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createViteServer, type ViteDevServer } from 'vite'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('no port'))
      server.close(() => resolve(address.port))
    })
  })
}

type Flow = {
  id: 'personal' | 'support' | 'admin'
  url: string
  ready: string
  open: (page: Page) => Promise<void>
  input: string
  button: string
  sent: (page: Page) => Promise<string[]>
  render: (page: Page) => Promise<void>
  bubble: string
  maxLines: number
  /** Височината на празното поле досега (null — естествената от rows/CSS). */
  baseHeight: (mobile: boolean) => number | null
}

const FLOWS: Flow[] = [
  {
    id: 'personal',
    url: '/scripts/fixtures/chatDraftHarness.html',
    ready: '() => window.__chatDraftHarness !== undefined',
    open: async (page) => { await page.evaluate(() => (window as any).__chatDraftHarness.openConversation('friendship-a')) },
    input: '[data-lobby-chat-form="friendship-a"] [data-lobby-chat-message-input="1"]',
    button: '[data-lobby-chat-form="friendship-a"] button[type="submit"]',
    sent: (page) => page.evaluate(() => [...(window as any).__chatDraftHarness.getPersonalSentBodies()]),
    render: (page) => page.evaluate(() => (window as any).__chatDraftHarness.triggerUnrelatedBackgroundRender()),
    bubble: '[data-chat-message]',
    maxLines: 40,
    baseHeight: (mobile) => (mobile ? 40 : 42),
  },
  {
    id: 'support',
    url: '/scripts/fixtures/chatDraftHarness.html',
    ready: '() => window.__chatDraftHarness !== undefined',
    open: async (page) => { await page.evaluate(async () => { await (window as any).__chatDraftHarness.openSupportPopup() }) },
    input: '[data-support-send-form="1"] textarea[name="body"]',
    button: '[data-support-send-form="1"] [data-support-composer-send="1"]',
    sent: (page) => page.evaluate(() => [...(window as any).__chatDraftHarness.getSupportSentBodies()]),
    render: (page) => page.evaluate(() => (window as any).__chatDraftHarness.triggerUnrelatedBackgroundRender()),
    bubble: '[data-support-message]',
    maxLines: 60,
    baseHeight: () => null,
  },
  {
    id: 'admin',
    url: '/scripts/fixtures/adminSupportHarness.html',
    ready: '() => window.__adminSupportHarness !== undefined',
    open: async (page) => {
      await page.evaluate(async () => {
        await (window as any).__adminSupportHarness.openInbox()
        await (window as any).__adminSupportHarness.openConversation('user-profile')
      })
    },
    input: '[data-admin-support-reply-form="user-profile"] textarea[name="body"]',
    button: '[data-admin-support-reply-form="user-profile"] [data-support-composer-send="1"]',
    sent: (page) => page.evaluate(() => [...(window as any).__adminSupportHarness.getSentBodies()]),
    render: (page) => page.evaluate(() => (window as any).__adminSupportHarness.controller.render()),
    bubble: '[data-support-message]',
    maxLines: 60,
    baseHeight: () => null,
  },
]

const VIEWPORTS = [
  { label: 'desktop', mobile: false, options: { viewport: { width: 1280, height: 900 } } },
  { label: 'mobile', mobile: true, options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
] as const

type FieldState = { tag: string; value: string; height: number; overflowY: string; scrollTop: number; scrollHeight: number; clientHeight: number; focused: boolean; start: number | null; end: number | null }
const field = (page: Page, selector: string) => page.evaluate((sel) => {
  const el = document.querySelector<HTMLTextAreaElement>(sel)
  if (el === null) throw new Error(`няма поле ${sel}`)
  return {
    tag: el.tagName, value: el.value, height: el.offsetHeight, overflowY: el.style.overflowY, scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd,
  }
}, selector) as Promise<FieldState>
const lines = (n: number) => Array.from({ length: n }, (_, i) => `ред ${i + 1}`).join('\n')

console.log('\ncheckMultilineChatComposers\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null
try {
  const port = await freePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}`
  browser = await chromium.launch()

  for (const vp of VIEWPORTS) {
    for (const flow of FLOWS) {
      const label = `${flow.id} ${vp.label}`
      const openPage = async (): Promise<Page> => {
        const context = await browser!.newContext(vp.options)
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl })
        // Fixture-ите нямат <meta name="viewport"> — без него мобилната емулация
        // рендира с ширина 980 px (desktop изгледът). Само за телефона.
        if (vp.mobile) {
          await context.addInitScript(`document.addEventListener('DOMContentLoaded', () => {
            const meta = document.createElement('meta'); meta.name = 'viewport'; meta.content = 'width=device-width, initial-scale=1'; document.head.prepend(meta)
          }, { once: true })`)
        }
        const page = await context.newPage()
        page.on('pageerror', (error) => console.error(`    pageerror: ${error.message}`))
        await page.goto(`${baseUrl}${flow.url}`)
        await page.waitForFunction(flow.ready)
        await flow.open(page)
        await page.waitForSelector(flow.input, { timeout: 10_000 })
        return page
      }
      const page = await openPage()
      const base = (await field(page, flow.input)).height
      const sendButton = async () => { await page.locator(flow.button).click() }
      try {
        await check(`${label} [B] <textarea>, празно поле със същата височина (${base}px)`, async () => {
          const state = await field(page, flow.input)
          assert(state.tag === 'TEXTAREA', `таг ${state.tag}`)
          const expected = flow.baseHeight(vp.mobile)
          if (expected !== null) assert(state.height === expected, `височина ${state.height}, очаквано ${expected}`)
          assert(state.value === '' && state.overflowY !== 'auto', 'празно, без скрол')
        })

        await check(`${label} [E] Enter / Shift+Enter според устройството; изпратеният текст е многоредов`, async () => {
          const before = (await flow.sent(page)).length
          await page.locator(flow.input).click()
          if (vp.mobile) {
            await page.keyboard.type('ред 1')
            await page.keyboard.press('Enter')
            await page.keyboard.type('ред 2')
            await page.keyboard.press('Enter')
            await page.keyboard.press('Enter')
            await page.keyboard.type('ред 4')
            assert((await flow.sent(page)).length === before, 'телефон: Enter не изпраща')
            assert((await field(page, flow.input)).value === 'ред 1\nред 2\n\nред 4', `телефон: стойност ${JSON.stringify((await field(page, flow.input)).value)}`)
            await sendButton()
          } else {
            await page.keyboard.type('ред 1')
            await page.keyboard.press('Shift+Enter')
            await page.keyboard.type('ред 2')
            await page.keyboard.press('Shift+Enter')
            await page.keyboard.press('Shift+Enter')
            await page.keyboard.type('ред 4')
            assert((await flow.sent(page)).length === before, 'компютър: Shift+Enter не изпраща')
            assert((await field(page, flow.input)).value === 'ред 1\nред 2\n\nред 4', `компютър: стойност ${JSON.stringify((await field(page, flow.input)).value)}`)
            await page.keyboard.press('Enter')
          }
          await page.waitForFunction(([sel]) => document.querySelector<HTMLTextAreaElement>(sel)?.value === '', [flow.input], { timeout: 5_000 })
          const sent = await flow.sent(page)
          assert(sent.length === before + 1 && sent[sent.length - 1] === 'ред 1\nред 2\n\nред 4', `изпратено: ${JSON.stringify(sent.slice(before))}`)
          const after = await field(page, flow.input)
          assert(after.value === '' && after.height === base, `след успех: празно и ${base}px (${after.height})`)
        })

        await check(`${label} [V] балончето: нови и празни редове (<br>), HTML като текст`, async () => {
          const body = '<b>удебелен</b>\n\nвтори абзац'
          await page.locator(flow.input).fill(body)
          if (vp.mobile) await sendButton()
          else await page.locator(flow.input).press('Enter')
          await page.waitForFunction(([sel]) => document.querySelector<HTMLTextAreaElement>(sel)?.value === '', [flow.input], { timeout: 5_000 })
          await page.waitForTimeout(150)
          const bubble = await page.evaluate((sel) => {
            const all = [...document.querySelectorAll<HTMLElement>(sel)]
            const last = all.reverse().find((el) => (el.textContent ?? '').includes('втори абзац'))
            return last === undefined ? null : { html: last.innerHTML, text: last.innerText, bold: last.querySelector('b') !== null }
          }, flow.bubble)
          assert(bubble !== null, 'балончето е показано')
          assert(/&lt;b&gt;удебелен&lt;\/b&gt;<br><br>втори абзац/.test(bubble!.html), `HTML: ${bubble!.html.slice(0, 200)}`)
          assert(!bubble!.bold, 'без <b> елемент')
        })

        await check(`${label} [P] поставяне (Ctrl+V) на многоредов текст пази редовете и абзаците`, async () => {
          const pasted = 'Абзац едно,\nвтори ред.\n\nАбзац две.'
          await page.evaluate((text) => navigator.clipboard.writeText(text), pasted)
          await page.locator(flow.input).click()
          await page.keyboard.press('Control+V')
          const state = await field(page, flow.input)
          assert(state.value === pasted, `поставено: ${JSON.stringify(state.value)}`)
          assert(state.height > base, `височината расте (${state.height})`)
          await page.locator(flow.input).fill('')
          await page.locator(flow.input).dispatchEvent('input')
        })

        await check(`${label} [G] автоматична височина до максимума, после вътрешен скрол; празно -> начална`, async () => {
          const max = vp.mobile ? 120 : 132
          await page.locator(flow.input).fill(lines(3))
          const three = await field(page, flow.input)
          assert(three.height > base && three.height < max && three.overflowY !== 'auto', `3 реда: ${three.height}px ${three.overflowY}`)
          await page.locator(flow.input).fill(lines(20))
          const twenty = await field(page, flow.input)
          assert(twenty.height === max && twenty.overflowY === 'auto' && twenty.scrollHeight > twenty.clientHeight, `20 реда: ${twenty.height}px ${twenty.overflowY}`)
          await page.locator(flow.input).fill('')
          const empty = await field(page, flow.input)
          assert(empty.height === base && empty.overflowY !== 'auto', `празно: ${empty.height}px`)
        })

        await check(`${label} [R] фоново прерисуване пази черновата, фокуса, маркирания текст, височината и скрола`, async () => {
          await page.locator(flow.input).fill(lines(15))
          await page.evaluate((sel) => {
            const el = document.querySelector<HTMLTextAreaElement>(sel)!
            el.focus()
            el.setSelectionRange(8, 30, 'forward')
            el.scrollTop = 40
          }, flow.input)
          const before = await field(page, flow.input)
          await flow.render(page)
          await page.waitForTimeout(100)
          const after = await field(page, flow.input)
          assert(after.value === before.value, 'черновата')
          assert(after.focused && after.start === 8 && after.end === 30, `фокус/маркиране: ${after.focused} ${after.start}-${after.end}`)
          assert(after.height === before.height, `височина ${before.height} -> ${after.height}`)
          assert(Math.abs(after.scrollTop - before.scrollTop) <= 1, `скрол ${before.scrollTop} -> ${after.scrollTop}`)
          await page.locator(flow.input).fill('')
        })

        await check(`${label} [L] над ${flow.maxLines} реда: съобщение, черновата и фокусът остават, без изпращане`, async () => {
          const before = (await flow.sent(page)).length
          const draft = lines(flow.maxLines + 1)
          await page.locator(flow.input).fill(draft)
          if (vp.mobile) await sendButton()
          else await page.locator(flow.input).press('Enter')
          await page.waitForTimeout(250)
          assert((await flow.sent(page)).length === before, 'не е изпратено')
          const text = await page.evaluate(() => document.body.innerText)
          assert(text.includes(`до ${flow.maxLines} реда`), 'разбираемо съобщение')
          const state = await field(page, flow.input)
          assert(state.value === draft, 'черновата остава')
          if (!vp.mobile) assert(state.focused, 'фокусът остава')
          await page.locator(flow.input).fill(lines(flow.maxLines))
          if (vp.mobile) await sendButton()
          else await page.locator(flow.input).press('Enter')
          await page.waitForFunction(([sel]) => document.querySelector<HTMLTextAreaElement>(sel)?.value === '', [flow.input], { timeout: 5_000 })
          assert((await flow.sent(page)).length === before + 1, `точно ${flow.maxLines} реда се изпращат`)
        })

        if (!vp.mobile) {
          await check(`${label} [D] задържан и двоен Enter -> едно изпращане`, async () => {
            const before = (await flow.sent(page)).length
            await page.locator(flow.input).fill('само веднъж')
            await page.locator(flow.input).focus()
            await page.keyboard.down('Enter')
            await page.keyboard.down('Enter') // repeat
            await page.keyboard.down('Enter') // repeat
            await page.keyboard.up('Enter')
            await page.keyboard.press('Enter')
            await page.waitForTimeout(300)
            const sent = await flow.sent(page)
            assert(sent.length === before + 1 && sent[sent.length - 1] === 'само веднъж', `изпратени: ${JSON.stringify(sent.slice(before))}`)
          })
        }
      } finally {
        await page.context().close()
      }
    }
  }
} finally {
  await browser?.close()
  await vite?.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
