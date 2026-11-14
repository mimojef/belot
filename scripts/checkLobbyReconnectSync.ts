/**
 * checkLobbyReconnectSync.ts — синхронизацията на лобито при тихо
 * възстановяване на WS (createLobbyFlowController.beginReconnectSync), с
 * реалния production контролер в истински Chromium
 * (scripts/fixtures/privateRoomWaitingHarness.ts). Desktop и mobile.
 *
 *   [Y1] при загуба на връзката висящото изпращане в чата се освобождава
 *        (полето/бутонът отново активни), съобщението НЕ се изпраща повторно
 *        и черновата остава;
 *   [Y2] масата е изчезнала (липсва в авторитетния private_rooms_list след
 *        синхронизацията) -> изход от чакалнята към „Частни маси“ +
 *        „Масата вече не е налична.“; синхронизацията завършва успешно;
 *   [Y3] същото, но играта е започнала (session_in_game) -> без съобщението;
 *   [Y4] масата е налична и сме в нея -> оставаме; нов абонамент за чата
 *        (историята идва наново), без друго действие;
 *   [Y5] обикновен private_rooms_list без синхронизация не пипа членството.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkLobbyReconnectSync.ts
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

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
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createNetServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address === null || typeof address === 'string') return reject(new Error('no port'))
    server.close(() => resolve(address.port))
  })
})

const member = (profileId: string, displayName: string, isHost: boolean) => ({ profileId, displayName, avatarUrl: null, level: 5, rankTitle: null, isHost, isBot: false })
function makeRoom(id: string, members: unknown[]) {
  const defs = [{ team: 'A', slotIndex: 0 }, { team: 'B', slotIndex: 0 }, { team: 'A', slotIndex: 1 }, { team: 'B', slotIndex: 1 }]
  return { id, kind: 'open', stake: 5000, slots: defs.map((d, i) => ({ ...d, occupant: members[i] ?? null })), createdAt: Date.now(), expiresAt: Date.now() + 10 * 60_000, manualStart: false, canManualStart: false }
}
const ROOM = makeRoom('room-sync', [member('me', 'Аз', true), member('guest-1', 'Гост', false)])
const OTHER_ROOM = makeRoom('room-other', [member('host-2', 'Друг', true)])

// Скриптовете в браузъра са низове: tsx/esbuild добавя __name(...) към именуваните функции.
async function enterWaitingRoom(page: Page): Promise<void> {
  await page.goto('/scripts/fixtures/privateRoomWaitingHarness.html')
  await page.waitForFunction('window.__prwHarness !== undefined', null, { timeout: 15_000 })
  await page.evaluate(`(() => {
    const h = window.__prwHarness
    h.controller.setConnected(true)
    h.navigateToPrivateRooms()
    h.pushRoomUpdated(${JSON.stringify(ROOM)})
    h.pushChatHistory('room-sync', [])
  })()`)
  await page.waitForSelector('[data-private-room-waiting-screen="1"]', { state: 'attached' })
}
const callCount = (page: Page, name: string) => page.evaluate(`window.__prwHarness.getCalls().filter((c) => c.name === '${name}').length`) as Promise<number>
const beginSync = (page: Page) => page.evaluate(`(() => { window.__syncDone = []; window.__prwHarness.controller.beginReconnectSync((ok) => window.__syncDone.push(ok)) })()`)
const syncDone = (page: Page) => page.evaluate(`window.__syncDone`) as Promise<boolean[]>
const pushList = (page: Page, rooms: unknown[]) => page.evaluate(`window.__prwHarness.controller.handleServerMessage({ type: 'private_rooms_list', rooms: ${JSON.stringify(rooms)} })`)
const bodyHas = (page: Page, text: string) => page.evaluate(`document.body.textContent.includes(${JSON.stringify(text)})`) as Promise<boolean>
const GONE = 'Масата вече не е налична.'

let vite: ViteDevServer | null = null
let browser: Browser | null = null
console.log('\ncheckLobbyReconnectSync\n')
try {
  const port = await freePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()

  for (const vp of [
    { label: 'desktop 1280x850', width: 1280, height: 850, mobile: false },
    { label: 'mobile 390x844', width: 390, height: 844, mobile: true },
  ]) {
    const context = await browser.newContext(vp.mobile
      ? { viewport: { width: vp.width, height: vp.height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, baseURL: `http://127.0.0.1:${port}` }
      : { viewport: { width: vp.width, height: vp.height }, baseURL: `http://127.0.0.1:${port}` })
    const errors: string[] = []

    // ─── [Y1] + [Y2] ────────────────────────────────────────────────────
    let page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await enterWaitingRoom(page)
    await page.locator('[data-private-waiting-chat-input="1"]').fill('висящо съобщение')
    await page.locator('[data-private-waiting-chat-form="1"] button[type="submit"]').click()
    const sendsBefore = await callCount(page, 'onPrivateRoomChatSend')
    const disabledWhileSending = await page.locator('[data-private-waiting-chat-input="1"]').isDisabled()
    await page.evaluate('window.__prwHarness.controller.setConnected(false)')
    const inputAfter = page.locator('[data-private-waiting-chat-input="1"]')
    const y1 = { enabled: !(await inputAfter.isDisabled()), draft: await inputAfter.inputValue(), sends: await callCount(page, 'onPrivateRoomChatSend') }
    await check(`[${vp.label}] [Y1] Загуба на връзката освобождава висящото изпращане; без повторно изпращане; черновата остава`, async () => {
      assert(sendsBefore === 1 && disabledWhileSending, `изпращане: ${sendsBefore}, disabled=${disabledWhileSending}`)
      assert(y1.enabled && y1.sends === 1 && y1.draft === 'висящо съобщение', JSON.stringify(y1))
    })

    await page.evaluate('window.__prwHarness.controller.setConnected(true)')
    const listRequestsBefore = await callCount(page, 'onPrivateRoomsOpen')
    await beginSync(page)
    const listRequested = (await callCount(page, 'onPrivateRoomsOpen')) - listRequestsBefore
    await pushList(page, [OTHER_ROOM])
    await page.waitForTimeout(150)
    await check(`[${vp.label}] [Y2] Изчезнала маса в авторитетния списък -> изход към „Частни маси“ + „${GONE}“; синхронизацията успява`, async () => {
      assert(listRequested === 1, `заявки за списъка: ${listRequested}`)
      assert(JSON.stringify(await syncDone(page)) === '[true]', `done: ${JSON.stringify(await syncDone(page))}`)
      assert(await page.evaluate(`window.__prwHarness.getCurrentScreen()`) === 'private-rooms', `екран: ${await page.evaluate(`window.__prwHarness.getCurrentScreen()`)}`)
      assert(await page.evaluate(`window.__prwHarness.controller.getMyPrivateRoom() === null`), 'членството остана')
      assert(await bodyHas(page, GONE), 'съобщението липсва')
      assert((await callCount(page, 'onPrivateRoomChatSend')) === 1, 'повторно изпращане')
    })
    await page.close()

    // ─── [Y3] Играта е започнала ─────────────────────────────────────────
    page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await enterWaitingRoom(page)
    await beginSync(page)
    await page.evaluate('window.__prwHarness.controller.markReconnectSyncSessionInGame()')
    await pushList(page, [])
    await page.waitForTimeout(150)
    await check(`[${vp.label}] [Y3] Играта започна през прекъсването -> членството се изчиства без „${GONE}“`, async () => {
      assert(JSON.stringify(await syncDone(page)) === '[true]', 'done')
      assert(await page.evaluate(`window.__prwHarness.controller.getMyPrivateRoom() === null`), 'членството остана')
      assert(!(await bodyHas(page, GONE)), 'съобщение при започнала игра')
    })
    await page.close()

    // ─── [Y4] + [Y5] Масата е налична ───────────────────────────────────
    page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await enterWaitingRoom(page)
    const subsBefore = await callCount(page, 'onPrivateRoomChatSubscribe')
    await beginSync(page)
    await page.evaluate(`window.__prwHarness.controller.handleServerMessage({ type: 'private_room_updated', room: ${JSON.stringify(ROOM)} })`)
    await pushList(page, [ROOM, OTHER_ROOM])
    await page.waitForTimeout(150)
    const subsAfter = await callCount(page, 'onPrivateRoomChatSubscribe')
    await check(`[${vp.label}] [Y4] Масата е налична -> оставаме в чакалнята; нов абонамент за чата (история), без съобщение`, async () => {
      assert(JSON.stringify(await syncDone(page)) === '[true]', 'done')
      assert(await page.evaluate(`window.__prwHarness.getCurrentScreen()`) === 'private-room-waiting', 'екран')
      assert(subsAfter - subsBefore === 1, `абонаменти: ${subsBefore} -> ${subsAfter}`)
      assert(!(await bodyHas(page, GONE)), 'излишно съобщение')
    })
    await pushList(page, [OTHER_ROOM])
    await page.waitForTimeout(150)
    await check(`[${vp.label}] [Y5] Обикновен private_rooms_list (без синхронизация) не пипа членството; без грешки`, async () => {
      assert(await page.evaluate(`window.__prwHarness.controller.getMyPrivateRoom() !== null`), 'членството е изчистено')
      assert(await page.evaluate(`window.__prwHarness.getCurrentScreen()`) === 'private-room-waiting', 'екран')
      assert(errors.length === 0, errors.join(' | '))
    })
    await context.close()
  }
} finally {
  await browser?.close()
  await vite?.close()
}
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
