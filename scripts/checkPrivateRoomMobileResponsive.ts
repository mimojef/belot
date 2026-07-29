/**
 * checkPrivateRoomMobileResponsive.ts
 *
 * Real browser (Playwright), real production code, real rendering — mobile
 * and responsive verification for the private-table waiting room, its chat,
 * the "Запълни с ботове" / leave confirmations, the end-game screen's
 * private-vs-public button gating, and the "private table created"
 * notification (all introduced/touched by bb0b636 and ca321c7).
 *
 * Uses the same established pattern as checkChatDraftPreserved.ts: a Vite
 * dev server serves small fixture harnesses (scripts/fixtures/*Harness.ts)
 * that boot the REAL production controllers/render functions with stubbed
 * network callbacks; this script drives them with a real Chromium instance
 * at fixed viewport sizes and asserts on the real DOM.
 *
 * Viewports: 320x568, 360x800, 390x844, 430x932 (mobile, touch), plus a
 * 1280x800 desktop regression pass.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
        reject(new Error('no free port'))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

// Project-local, machine-independent scratch location — no hardcoded
// absolute user-specific path, so the suite runs reliably on any machine/CI.
const SCREENSHOT_DIR = join(tmpdir(), 'belot-v2-private-room-mobile-screenshots')

async function settlePaint(page: Page): Promise<void> {
  // Guard against a Chromium headless "cold first paint" artifact observed
  // empirically in this environment: a screenshot taken shortly after a
  // fresh page's first big innerHTML render can capture an unpainted/
  // partially-composited frame, even though the DOM/CSSOM at that instant
  // is already fully correct (verified directly via getBoundingClientRect/
  // getComputedStyle during investigation — display/visibility/opacity/
  // position were all already correct while the screenshot still came out
  // blank). Neither extra wall-clock wait time, raw page.mouse.click(x,y),
  // page.mouse.wheel, nor a JS-triggered re-render reliably fixed it on
  // their own — only Playwright's own locator-based .click() (which
  // auto-waits for actionability: attached/visible/stable/receives-events)
  // does. Clicking a harmless corner of <html> triggers that machinery
  // without affecting any application state; documentary screenshots of
  // the very first render are additionally taken later in each scenario,
  // after the page has already gone through several interactions.
  await page.locator('html').click({ position: { x: 1, y: 1 } })
}

async function shot(page: Page, name: string): Promise<void> {
  await settlePaint(page)
  await page.waitForTimeout(150)
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`), fullPage: true })
}

async function hasHorizontalScroll(page: Page): Promise<{ overflow: boolean; scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
}

async function elementWithinViewport(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const rect = el.getBoundingClientRect()
    return rect.left >= -1 && rect.top >= -1 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 400
    // bottom is allowed to extend beyond viewport height (page can scroll
    // vertically by design — min-height:100dvh); only horizontal containment
    // and left/top are checked strictly, matching the "no horizontal
    // scroll / nothing off to the side" requirement.
  }, selector)
}

function makeMember(profileId: string, displayName: string, isHost: boolean, level = 5) {
  return { profileId, displayName, avatarUrl: null, level, rankTitle: isHost ? null : 'Играч', isHost }
}

function makeRoom(id: string, members: unknown[], kind: 'open' | 'locked' = 'open', stake = 5000, expiresAt?: number) {
  return { id, kind, stake, members, createdAt: Date.now(), expiresAt: expiresAt ?? Date.now() + 10 * 60_000 }
}

const LONG_CYRILLIC_NAME = 'Константин-Александър Величковски-Радославов'
const LONG_LATIN_NAME = 'Bartholomewsonovichuk Alexanderopoulos'
const LONG_CHAT_MESSAGE_BG =
  'Здравейте отборе, това е много дълго тестово съобщение с почти максималната позволена дължина от 300 символа, за да проверим пренасянето на текста, word-break-а и това дали чат панелът се чупи или излиза извън екрана при мобилни размери на дисплея сега.'

async function runWaitingRoomScenario(page: Page, label: string, viewportWidth: number): Promise<void> {
  await page.goto('/scripts/fixtures/privateRoomWaitingHarness.html')
  await page.waitForFunction(() => (window as any).__prwHarness !== undefined, undefined, { timeout: 10_000 })

  const h = () => (window as any).__prwHarness

  // ─── Enter waiting room with 2 humans (host = me) ───────────────────────
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.navigateToPrivateRooms()
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-1', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост Едно', false)]) })

  await page.waitForSelector('[data-private-room-waiting-screen="1"]', { state: 'attached' })

  await check(`${label} [1] Заглавието на чакалнята е видимо`, async () => {
    const text = await page.locator('.prw-title').textContent()
    assert((text ?? '').includes('Чакалня'), `Очаквах "Чакалня", получих "${text}"`)
  })

  await check(`${label} [2] Създателят е обозначен с "ДОМАКИН"`, async () => {
    const hostBadgeCount = await page.locator('.prw-host-badge', { hasText: 'ДОМАКИН' }).count()
    assert(hostBadgeCount === 1, `Очаквах точно 1 host badge, получих ${hostBadgeCount}`)
  })

  await check(`${label} [3] 2-ма човека: 2 заети + 2 свободни места`, async () => {
    const occupied = await page.locator('.prw-seat:not(.prw-seat-empty)').count()
    const empty = await page.locator('.prw-seat-empty').count()
    assert(occupied === 2, `occupied=${occupied}`)
    assert(empty === 2, `empty=${empty}`)
  })

  await check(`${label} [4] "Запълни с ботове" е видим и активен за домакина при 2-ма души`, async () => {
    const btn = page.locator('[data-private-waiting-fillbots-button="1"]')
    await assertVisibleEnabled(btn)
  })

  // ─── 3 humans ────────────────────────────────────────────────────────────
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, {
    room: makeRoom('room-1', [
      makeMember('me', 'Тестов Играч', true),
      makeMember('guest-1', 'Гост Едно', false),
      makeMember('guest-2', 'Гост Две', false),
    ]),
  })

  await check(`${label} [5] 3-ма души: 3 заети + 1 свободно място`, async () => {
    const occupied = await page.locator('.prw-seat:not(.prw-seat-empty)').count()
    const empty = await page.locator('.prw-seat-empty').count()
    assert(occupied === 3, `occupied=${occupied}`)
    assert(empty === 1, `empty=${empty}`)
  })

  await check(`${label} [6] "Запълни с ботове" остава активен при 3-ма души`, async () => {
    await assertVisibleEnabled(page.locator('[data-private-waiting-fillbots-button="1"]'))
  })

  // ─── Non-host view: button must not be visible at all ───────────────────
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, {
    room: makeRoom('room-1', [
      makeMember('guest-1', 'Гост Едно', true),
      makeMember('me', 'Тестов Играч', false),
    ]),
  })
  await check(`${label} [7] Не-домакинът НЕ вижда бутона "Запълни с ботове"`, async () => {
    const count = await page.locator('[data-private-waiting-fillbots-button="1"]').count()
    assert(count === 0, `не-домакин вижда бутона (count=${count})`)
  })

  // Restore host view with 4 members total not yet — go back to 2 humans, me=host.
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-1', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост Едно', false)]) })

  // ─── Long names: no horizontal overflow ──────────────────────────────────
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, {
    room: makeRoom('room-1', [
      makeMember('me', LONG_CYRILLIC_NAME, true),
      makeMember('guest-1', LONG_LATIN_NAME, false),
    ]),
  })

  await check(`${label} [8] Дълги имена (кирилица/латиница) не чупят layout-а хоризонтално`, async () => {
    const { overflow, scrollWidth, clientWidth } = await hasHorizontalScroll(page)
    assert(!overflow, `хоризонтален overflow: scrollWidth=${scrollWidth} clientWidth=${clientWidth}`)
  })

  await check(`${label} [8b] Дългите имена все пак се показват (текст не е празен)`, async () => {
    const text = await page.locator('.prw-seat-name').first().textContent()
    assert((text ?? '').trim().length > 0, 'името е празно')
  })

  // ─── Chat: subscribe call recorded, history push, send, autoscroll ───────
  await page.evaluate(() => (window as any).__prwHarness.clearCalls())
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-chat', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост Едно', false)]) })

  await check(`${label} [9] Влизането в чакалнята автоматично subscribe-ва за чата на точната стая`, async () => {
    const args = await page.evaluate(() => (window as any).__prwHarness.lastCallArgs('onPrivateRoomChatSubscribe'))
    assert(Array.isArray(args) && args[0] === 'room-chat', `subscribe args=${JSON.stringify(args)}`)
  })

  await page.evaluate(() => {
    ;(window as any).__prwHarness.pushChatHistory('room-chat', [])
  })

  const chatInput = page.locator('[data-private-waiting-chat-input="1"]')
  await chatInput.click()
  await chatInput.type(LONG_CHAT_MESSAGE_BG, { delay: 1 })

  await check(`${label} [10] Изпращане на дълго (близо до макс. дължина) съобщение вика onPrivateRoomChatSend с правилния roomId`, async () => {
    await page.locator('[data-private-waiting-chat-form="1"] button[type="submit"]').click()
    const args = await page.evaluate(() => (window as any).__prwHarness.lastCallArgs('onPrivateRoomChatSend'))
    assert(Array.isArray(args) && args[0] === 'room-chat' && args[1] === LONG_CHAT_MESSAGE_BG, `send args mismatch: ${JSON.stringify(args)}`)
  })

  await check(`${label} [10b] Полето е disabled, докато чака потвърждение (loading state)`, async () => {
    const disabled = await chatInput.isDisabled()
    assert(disabled, 'полето трябваше да е disabled по време на изпращане')
  })

  const requestId = await page.evaluate(() => {
    const args = (window as any).__prwHarness.lastCallArgs('onPrivateRoomChatSend')
    return args?.[2]
  })

  await page.evaluate(({ rid, body }) => {
    ;(window as any).__prwHarness.pushChatMessage('room-chat', {
      seq: 1, messageId: 'm1', senderProfileId: 'me', senderDisplayName: 'Тестов Играч', body, createdAt: Date.now(), requestId: rid,
    })
  }, { rid: requestId, body: LONG_CHAT_MESSAGE_BG })

  await check(`${label} [11] След потвърждение от сървъра, полето се изчиства и вече не е disabled`, async () => {
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-private-waiting-chat-input="1"]') as HTMLInputElement | null
      return el !== null && el.value === '' && !el.disabled
    }, undefined, { timeout: 3_000 })
  })

  await check(`${label} [11b] Дългото съобщение се вижда в чата, не е изрязано без пренасяне`, async () => {
    const text = await page.locator('.prw-chat-scroll').textContent()
    assert((text ?? '').includes(LONG_CHAT_MESSAGE_BG.slice(0, 40)), 'дългото съобщение не се вижда в чата')
    const { overflow } = await hasHorizontalScroll(page)
    assert(!overflow, 'дългото съобщение предизвика хоризонтален overflow')
  })

  await shot(page, `${viewportWidth}-waiting-chat-long`)

  // ─── Several consecutive messages + smart autoscroll ────────────────────
  for (let i = 0; i < 8; i++) {
    await page.evaluate((i) => {
      ;(window as any).__prwHarness.pushChatMessage('room-chat', {
        seq: 100 + i, messageId: `bulk-${i}`, senderProfileId: 'guest-1', senderDisplayName: 'Гост Едно', body: `Съобщение номер ${i}`, createdAt: Date.now(),
      })
    }, i)
  }

  await check(`${label} [12] Smart autoscroll: скролва до дъното, докато потребителят вече е бил близо до него`, async () => {
    const nearBottom = await page.evaluate(() => {
      const el = document.querySelector('[data-private-waiting-chat-scroll="1"]') as HTMLElement
      return el.scrollHeight - el.scrollTop - el.clientHeight < 48
    })
    assert(nearBottom, 'чатът не е скролнал до дъното след поредица нови съобщения')
  })

  await check(`${label} [12b] Smart autoscroll: НЕ скролва до дъното, ако потребителят вече е бил скролнал нагоре`, async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-private-waiting-chat-scroll="1"]') as HTMLElement
      el.scrollTop = 0
    })
    await page.evaluate(() => {
      ;(window as any).__prwHarness.pushChatMessage('room-chat', {
        seq: 999, messageId: 'after-scroll-up', senderProfileId: 'guest-1', senderDisplayName: 'Гост Едно', body: 'Ново съобщение докато си горе', createdAt: Date.now(),
      })
    })
    const stillNearTop = await page.evaluate(() => {
      const el = document.querySelector('[data-private-waiting-chat-scroll="1"]') as HTMLElement
      return el.scrollTop < 48
    })
    assert(stillNearTop, 'чатът неволно скролна потребителя надолу, докато четеше история нагоре')
  })

  // ─── Draft/focus/caret preserved across an incoming WS re-render ────────
  await page.evaluate(() => {
    const el = document.querySelector('[data-private-waiting-chat-scroll="1"]') as HTMLElement
    el.scrollTop = el.scrollHeight
  })
  await chatInput.click()
  const draftText = 'недовършена чернова...'
  await chatInput.type(draftText, { delay: 5 })

  await check(`${label} [13] Draft/focus/caret се пазят при входящо WebSocket обновяване (нов член)`, async () => {
    await page.evaluate(({ room }) => {
      ;(window as any).__prwHarness.pushRoomUpdated(room)
    }, {
      room: makeRoom('room-chat', [
        makeMember('me', 'Тестов Играч', true),
        makeMember('guest-1', 'Гост Едно', false),
        makeMember('guest-2', 'Нов Гост', false),
      ]),
    })
    const value = await chatInput.inputValue()
    assert(value === draftText, `черновата трябваше да остане "${draftText}", а е "${value}"`)
    const stillFocused = await page.evaluate(() => document.activeElement === document.querySelector('[data-private-waiting-chat-input="1"]'))
    assert(stillFocused, 'полето трябваше да остане фокусирано')
  })

  // ─── Fill-with-bots: confirmation, loading, error recovery ──────────────
  await page.evaluate(() => (window as any).__prwHarness.clearCalls())
  await page.locator('[data-private-waiting-fillbots-button="1"]').click()

  await check(`${label} [14] Клик на "Запълни с ботове" показва потвърждение с очаквания текст`, async () => {
    const text = await page.locator('.prw-confirm-text').first().textContent()
    assert((text ?? '').includes('Свободните места ще бъдат запълнени с ботове'), `текст: "${text}"`)
  })

  await shot(page, `${viewportWidth}-fillbots-confirm`)

  await page.locator('[data-private-waiting-fillbots-confirm-yes="1"]').click()

  await check(`${label} [14b] Потвърждаването вика onPrivateRoomFillWithBots и бутонът показва "Стартиране..." (disabled)`, async () => {
    const calls = await page.evaluate(() => (window as any).__prwHarness.getCalls())
    assert(calls.some((c: any) => c.name === 'onPrivateRoomFillWithBots'), 'onPrivateRoomFillWithBots не е извикан')
    const btn = page.locator('[data-private-waiting-fillbots-button="1"]')
    const text = await btn.textContent()
    const disabled = await btn.isDisabled()
    assert((text ?? '').includes('Стартиране'), `текст на бутона: "${text}"`)
    assert(disabled, 'бутонът трябваше да е disabled по време на loading')
  })

  await check(`${label} [15] Ако сървърът отхвърли (race condition), грешката се показва И бутонът спира да е "заклещен" в loading`, async () => {
    await page.evaluate(() => {
      ;(window as any).__prwHarness.pushGenericError('Запълването с ботове изисква 2 или 3 играчи в масата.')
    })
    await page.waitForFunction(() => document.body.textContent?.includes('Запълването с ботове изисква') ?? false, undefined, { timeout: 3_000 })
    const btn = page.locator('[data-private-waiting-fillbots-button="1"]')
    const disabled = await btn.isDisabled()
    assert(!disabled, 'бутонът остана заклещен в disabled/loading след отхвърлена команда')
  })

  // ─── Leave: confirmation cancel + confirm ────────────────────────────────
  await page.locator('[data-private-waiting-leave-button="1"]').click()
  await check(`${label} [16] Клик на "Напусни" показва потвърждение с очаквания текст`, async () => {
    const text = await page.locator('.prw-confirm-text').first().textContent()
    assert((text ?? '').includes('мястото ти ще бъде освободено'), `текст: "${text}"`)
  })
  await shot(page, `${viewportWidth}-leave-confirm`)

  await page.locator('[data-private-waiting-leave-confirm-cancel="1"]').click()
  await check(`${label} [16b] "Откажи" затваря диалога без да вика onPrivateRoomLeave`, async () => {
    const count = await page.locator('.prw-confirm-box', { hasText: 'мястото ти ще бъде освободено' }).count()
    assert(count === 0, 'диалогът не се затвори')
    const calls = await page.evaluate(() => (window as any).__prwHarness.getCalls())
    assert(!calls.some((c: any) => c.name === 'onPrivateRoomLeave'), 'onPrivateRoomLeave не трябваше да е извикан след Откажи')
  })

  await page.evaluate(() => (window as any).__prwHarness.clearCalls())
  await page.locator('[data-private-waiting-leave-button="1"]').click()
  await page.locator('[data-private-waiting-leave-confirm-yes="1"]').click()
  await check(`${label} [17] Потвърденото напускане вика onPrivateRoomLeave`, async () => {
    const calls = await page.evaluate(() => (window as any).__prwHarness.getCalls())
    assert(calls.some((c: any) => c.name === 'onPrivateRoomLeave'), 'onPrivateRoomLeave не е извикан')
  })

  await check(`${label} [17b] private_room_left връща контролера извън чакалнята`, async () => {
    await page.evaluate(() => (window as any).__prwHarness.pushRoomLeft('room-chat'))
    const screen = await page.evaluate(() => (window as any).__prwHarness.getCurrentScreen())
    assert(screen !== 'private-room-waiting', `очаквах да напусне екрана, currentScreen=${screen}`)
  })

  // ─── Closed/expired while waiting -> navigates away with info banner ────
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-closed-test', [makeMember('guest-1', 'Домакин', true), makeMember('me', 'Тестов Играч', false)]) })
  await page.evaluate(() => (window as any).__prwHarness.pushRoomClosed('room-closed-test'))
  await check(`${label} [18] private_room_closed връща извън чакалнята с разбираемо съобщение`, async () => {
    const screen = await page.evaluate(() => (window as any).__prwHarness.getCurrentScreen())
    assert(screen !== 'private-room-waiting', `currentScreen=${screen}`)
    const text = await page.textContent('body')
    assert((text ?? '').includes('затвори масата'), 'липсва разбираемо съобщение за закритата маса')
  })

  // ─── A NEW room after a closed one must not carry a stale banner ────────
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-fresh', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)]) })
  await check(`${label} [19] Нова стая не наследява стар банер ("Домакинът затвори масата") от предишна`, async () => {
    const text = await page.textContent('.prw-shell')
    assert(!(text ?? '').includes('затвори масата'), 'стар банер протече в новата чакалня')
  })

  // ─── Documentary screenshots of the 2-human / 3-human waiting states ────
  // (taken here, after the page has already gone through many interactions/
  // re-renders, rather than immediately after the very first render — see
  // the settlePaint()/shot() comment for why).
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('room-shot', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост Едно', false)]) })
  await shot(page, `${viewportWidth}-waiting-2-humans`)

  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, {
    room: makeRoom('room-shot', [
      makeMember('me', 'Тестов Играч', true),
      makeMember('guest-1', 'Гост Едно', false),
      makeMember('guest-2', 'Гост Две', false),
    ]),
  })
  await shot(page, `${viewportWidth}-waiting-3-humans`)

  // ─── Transition to a started game ────────────────────────────────────────
  await check(`${label} [20] private_room_full извежда контролера от чакалнята (преход към играта)`, async () => {
    await page.evaluate(() => {
      ;(window as any).__prwHarness.pushRoomFull('game-room-1', 'bottom', 5000)
    })
    const screen = await page.evaluate(() => (window as any).__prwHarness.getCurrentScreen())
    assert(screen !== 'private-room-waiting', `currentScreen=${screen}`)
  })

  await check(`${label} [21] Няма хоризонтален scroll никъде по време на целия сценарий (последна проверка)`, async () => {
    const { overflow } = await hasHorizontalScroll(page)
    assert(!overflow, 'хоризонтален overflow в крайното състояние')
  })
}

async function assertVisibleEnabled(locator: ReturnType<Page['locator']>): Promise<void> {
  const count = await locator.count()
  assert(count === 1, `очаквах точно 1 елемент, получих ${count}`)
  const disabled = await locator.isDisabled()
  assert(!disabled, 'елементът е disabled, а не трябваше')
  const box = await locator.boundingBox()
  assert(box !== null && box.width >= 30 && box.height >= 30, `touch target твърде малък: ${JSON.stringify(box)}`)
}

async function runKeyboardOpenScenario(page: Page, label: string, viewportWidth: number, viewportHeight: number): Promise<void> {
  await page.goto('/scripts/fixtures/privateRoomWaitingHarness.html')
  await page.waitForFunction(() => (window as any).__prwHarness !== undefined, undefined, { timeout: 10_000 })
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.navigateToPrivateRooms()
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('kb-room', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)]) })
  await page.waitForSelector('[data-private-room-waiting-screen="1"]', { state: 'attached' })

  const chatInput = page.locator('[data-private-waiting-chat-input="1"]')
  await chatInput.click()

  // Simulate the on-screen keyboard opening by shrinking the visual
  // viewport height (the standard technique for this, since Playwright
  // cannot render a real OS soft keyboard) — mirrors what mobile Safari/
  // Chrome do to the visual viewport when the keyboard appears.
  await page.setViewportSize({ width: viewportWidth, height: Math.round(viewportHeight * 0.55) })
  // The visualViewport 'resize' event (which our production scroll-into-view
  // fix listens on) fires asynchronously relative to setViewportSize resolving.
  await page.waitForTimeout(200)

  await check(`${label} [KB1] Полето за писане остава достижимо, докато клавиатурата е "отворена"`, async () => {
    const box = await chatInput.boundingBox()
    assert(box !== null, 'полето изчезна от DOM-а')
    const shrunkHeight = Math.round(viewportHeight * 0.55)
    assert(box!.y >= 0 && box!.y + box!.height <= shrunkHeight, `полето е извън намаления viewport (y=${box!.y}, height=${box!.height}, viewport=${shrunkHeight})`)
  })

  await check(`${label} [KB2] Може да се изпрати съобщение, докато клавиатурата е "отворена"`, async () => {
    await chatInput.type('съобщение с отворена клавиатура', { delay: 1 })
    await page.locator('[data-private-waiting-chat-form="1"] button[type="submit"]').click()
    const args = await page.evaluate(() => (window as any).__prwHarness.lastCallArgs('onPrivateRoomChatSend'))
    assert(Array.isArray(args) && args[1] === 'съобщение с отворена клавиатура', 'изпращането не мина докато "клавиатурата" е отворена')
  })

  await check(`${label} [KB3] Чатът не покрива бутона "Напусни" (все още видим и кликаем)`, async () => {
    await assertVisibleEnabled(page.locator('[data-private-waiting-leave-button="1"]'))
  })

  await shot(page, `${viewportWidth}-keyboard-open`)

  await page.setViewportSize({ width: viewportWidth, height: viewportHeight })
  await check(`${label} [KB4] Затварянето на "клавиатурата" възстановява нормална височина без счупен layout`, async () => {
    const { overflow } = await hasHorizontalScroll(page)
    assert(!overflow, 'layout счупен след затваряне на клавиатурата (хоризонтален overflow)')
    await assertVisibleEnabled(page.locator('[data-private-waiting-leave-button="1"]'))
  })
}

// Verifies the mobile "Чакалня — частна маса" rework: 2x2 seat grid, the
// compact host badge, chat reachability (composer never off-screen/covered),
// and chat-area-only scrolling (composer stays put while messages scroll).
async function runMobileWaitingRoomLayoutScenario(page: Page, label: string, viewportWidth: number): Promise<void> {
  await page.goto('/scripts/fixtures/privateRoomWaitingHarness.html')
  await page.waitForFunction(() => (window as any).__prwHarness !== undefined, undefined, { timeout: 10_000 })

  // ─── 1/4 players, open room ──────────────────────────────────────────────
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.navigateToPrivateRooms()
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('mobile-grid-room', [makeMember('me', 'Тестов Играч', true)], 'open') })
  await page.waitForSelector('[data-private-room-waiting-screen="1"]', { state: 'attached' })

  await check(`${label} [G1] Grid: exactly 2 columns at mobile width`, async () => {
    const columnCount = await page.evaluate(() => {
      const el = document.querySelector('.prw-seats')
      const cols = getComputedStyle(el!).gridTemplateColumns.trim().split(/\s+/)
      return cols.length
    })
    assert(columnCount === 2, `expected 2 grid-template-columns, got ${columnCount}`)
  })

  await check(`${label} [G2] Grid: the 4 seats form exactly 2 rows of 2 (2x2)`, async () => {
    const rects = await page.$$eval('.prw-seat', (els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), left: Math.round(r.left) })))
    assert(rects.length === 4, `expected 4 seat cards, got ${rects.length}`)
    const rowTops = [...new Set(rects.map((r) => r.top))]
    const colLefts = [...new Set(rects.map((r) => r.left))]
    assert(rowTops.length === 2, `expected 2 distinct row positions, got ${rowTops.length} (${JSON.stringify(rowTops)})`)
    assert(colLefts.length === 2, `expected 2 distinct column positions, got ${colLefts.length} (${JSON.stringify(colLefts)})`)
  })

  await check(`${label} [G3] Grid: all 4 seat cards have equal height`, async () => {
    const heights = await page.$$eval('.prw-seat', (els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
    const distinct = [...new Set(heights)]
    assert(distinct.length === 1, `expected equal heights across all 4 cards, got ${JSON.stringify(heights)}`)
  })

  await check(`${label} [G4] Grid: seat card height is in the 60-100px compact range`, async () => {
    const height = await page.$eval('.prw-seat', (el) => el.getBoundingClientRect().height)
    assert(height >= 60 && height <= 100, `seat card height ${height}px out of the expected compact range`)
  })

  await check(`${label} [G5] Grid: no horizontal overflow with the 2x2 layout`, async () => {
    const { overflow } = await hasHorizontalScroll(page)
    assert(!overflow, 'horizontal overflow with the mobile 2x2 seat grid')
  })

  // ─── Host badge: only on the host, correct text, survives long names ────
  await check(`${label} [H1] Host badge is visible only for the host`, async () => {
    const badgeCount = await page.locator('.prw-host-badge').count()
    assert(badgeCount === 1, `expected exactly 1 host badge, got ${badgeCount}`)
  })

  await check(`${label} [H2] Host badge text reads "ДОМАКИН"`, async () => {
    const text = await page.locator('.prw-host-badge').textContent()
    assert((text ?? '').trim() === 'ДОМАКИН', `unexpected host badge text "${text}"`)
  })

  // Long name: badge must stay visible and the card must not overflow.
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('mobile-grid-room', [makeMember('me', LONG_CYRILLIC_NAME, true), makeMember('guest-1', LONG_LATIN_NAME, false)], 'open') })

  await check(`${label} [H3] Long host name: the host badge remains visible (not clipped away)`, async () => {
    const box = await page.locator('.prw-host-badge').boundingBox()
    assert(box !== null && box.width > 0 && box.height > 0, 'host badge disappeared or collapsed with a long display name')
  })

  await check(`${label} [H4] Long host name: the name is ellipsized (does not force the card wider)`, async () => {
    const overflowsHidden = await page.evaluate(() => {
      const nameEl = document.querySelector('.prw-seat-name')
      if (!nameEl) return false
      const style = getComputedStyle(nameEl)
      return style.textOverflow === 'ellipsis' && style.overflow === 'hidden'
    })
    assert(overflowsHidden, 'seat name is not set up to ellipsize (text-overflow/overflow)')
  })

  await check(`${label} [H5] Long host name: the seat card does not overflow horizontally`, async () => {
    const { overflow } = await hasHorizontalScroll(page)
    assert(!overflow, 'long host name caused horizontal overflow')
  })

  await check(`${label} [H6] Host badge stays a readable, non-collapsed size even with a long name`, async () => {
    const box = await page.locator('.prw-host-badge').boundingBox()
    assert(box !== null && box.width >= 40 && box.height >= 10, `host badge shrank to an unreadable size: ${JSON.stringify(box)}`)
  })

  // ─── Empty seat stays the same height as occupied ones ───────────────────
  await check(`${label} [G6] Empty seat card has the same height as occupied cards`, async () => {
    const heights = await page.$$eval('.prw-seat', (els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
    const distinct = [...new Set(heights)]
    assert(distinct.length === 1, `empty and occupied seat heights differ: ${JSON.stringify(heights)}`)
  })

  // ─── 4/4 players still forms a clean 2x2, no overflow ────────────────────
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, {
    room: makeRoom('mobile-grid-full', [
      makeMember('me', 'Тестов Играч', true),
      makeMember('g1', 'Гост Едно', false),
      makeMember('g2', 'Гост Две', false),
      makeMember('g3', 'Гост Три', false),
    ], 'locked'),
  })

  await check(`${label} [G7] 4/4 players (locked room): still exactly 4 cards, 2x2, no overflow`, async () => {
    const rects = await page.$$eval('.prw-seat', (els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), left: Math.round(r.left) })))
    assert(rects.length === 4, `expected 4 seat cards at 4/4, got ${rects.length}`)
    const rowTops = [...new Set(rects.map((r) => r.top))]
    assert(rowTops.length === 2, `expected 2 rows at 4/4, got ${rowTops.length}`)
    const { overflow } = await hasHorizontalScroll(page)
    assert(!overflow, 'horizontal overflow at 4/4 players')
  })

  // ─── Chat reachability: composer is reachable/focusable, within viewport ─
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('mobile-chat-reach', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)], 'open') })

  await check(`${label} [CH1] Composer input+send are within the viewport horizontally (no horizontal scroll needed)`, async () => {
    const within = await page.evaluate(() => {
      const input = document.querySelector('[data-private-waiting-chat-input="1"]')
      const send = document.querySelector('[data-private-waiting-chat-form="1"] button[type="submit"]')
      if (!input || !send) return false
      const ir = input.getBoundingClientRect()
      const sr = send.getBoundingClientRect()
      return ir.left >= 0 && sr.right <= window.innerWidth + 1
    })
    assert(within, 'chat composer input/send extends outside the viewport width')
  })

  await check(`${label} [CH2] Composer input can be focused`, async () => {
    await page.locator('[data-private-waiting-chat-input="1"]').click()
    const focused = await page.evaluate(() => document.activeElement === document.querySelector('[data-private-waiting-chat-input="1"]'))
    assert(focused, 'chat input could not be focused')
  })

  await check(`${label} [CH3] Composer is reachable by scrolling the page at a very short viewport`, async () => {
    const originalSize = page.viewportSize()
    if (originalSize) {
      await page.setViewportSize({ width: originalSize.width, height: 420 })
    }
    const sendButton = page.locator('[data-private-waiting-chat-form="1"] button[type="submit"]')
    await sendButton.scrollIntoViewIfNeeded()
    const box = await sendButton.boundingBox()
    assert(box !== null, 'send button not found after scrolling into view at a short viewport')
    const vp = page.viewportSize()
    assert(
      box!.y >= 0 && box!.y + box!.height <= (vp?.height ?? 420) + 1,
      `send button not within the short viewport after scroll: ${JSON.stringify(box)}`,
    )
    if (originalSize) {
      await page.setViewportSize(originalSize)
    }
  })

  // ─── Chat scrolling: many messages scroll the message area, not the page;
  // composer stays fixed relative to the panel (does not travel with list).
  await page.evaluate(() => (window as any).__prwHarness.clearCalls())
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('mobile-chat-scroll', [makeMember('me', 'Тестов Играч', true), makeMember('guest-1', 'Гост', false)], 'open') })

  const composerYBefore = await page.evaluate(() => {
    const send = document.querySelector('[data-private-waiting-chat-form="1"] button[type="submit"]')
    return send?.getBoundingClientRect().y ?? null
  })

  for (let i = 0; i < 25; i++) {
    await page.evaluate((i) => {
      ;(window as any).__prwHarness.pushChatMessage('mobile-chat-scroll', {
        seq: i, messageId: `msg-${i}`, senderProfileId: 'guest-1', senderDisplayName: 'Гост', body: `Съобщение номер ${i} за проверка на скрола в чата`, createdAt: Date.now(),
      })
    }, i)
  }

  await check(`${label} [CS1] Many messages create scroll within the message area (scrollHeight > clientHeight)`, async () => {
    const { scrollHeight, clientHeight } = await page.evaluate(() => {
      const el = document.querySelector('[data-private-waiting-chat-scroll="1"]') as HTMLElement
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
    })
    assert(scrollHeight > clientHeight, `expected message list to overflow (scrollHeight=${scrollHeight}, clientHeight=${clientHeight})`)
  })

  await check(`${label} [CS2] The composer does not move when the message list scrolls`, async () => {
    const composerYAfter = await page.evaluate(() => {
      const send = document.querySelector('[data-private-waiting-chat-form="1"] button[type="submit"]')
      return send?.getBoundingClientRect().y ?? null
    })
    assert(composerYAfter === composerYBefore, `composer moved: before=${composerYBefore}, after=${composerYAfter}`)
  })

  await check(`${label} [CS3] Smart autoscroll still applies on mobile (scrolled near bottom after a burst of messages)`, async () => {
    const nearBottom = await page.evaluate(() => {
      const el = document.querySelector('[data-private-waiting-chat-scroll="1"]') as HTMLElement
      return el.scrollHeight - el.scrollTop - el.clientHeight < 48
    })
    assert(nearBottom, 'message list did not autoscroll to bottom on mobile after new messages')
  })

  await check(`${label} [CS4] No horizontal overflow after a long chat scroll session`, async () => {
    const { overflow } = await hasHorizontalScroll(page)
    assert(!overflow, 'horizontal overflow after populating many chat messages on mobile')
  })

  // ─── Countdown warning/critical states render on mobile without overflow ─
  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('mobile-countdown-warning', [makeMember('me', 'Тестов Играч', true)], 'open', 5000, Date.now() + 45_000) })

  await check(`${label} [CD1] Countdown warning state (<60s) renders on mobile without overflow`, async () => {
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-private-room-countdown="1"]')
      return el !== null && el.className.includes('warning')
    }, undefined, { timeout: 3_000 })
    const { overflow } = await hasHorizontalScroll(page)
    assert(!overflow, 'horizontal overflow with countdown in warning state')
  })

  await page.evaluate(({ room }) => {
    ;(window as any).__prwHarness.pushRoomUpdated(room)
  }, { room: makeRoom('mobile-countdown-critical', [makeMember('me', 'Тестов Играч', true)], 'open', 5000, Date.now() + 20_000) })

  await check(`${label} [CD2] Countdown critical state (<30s) renders on mobile without overflow`, async () => {
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-private-room-countdown="1"]')
      return el !== null && el.className.includes('critical')
    }, undefined, { timeout: 3_000 })
    const { overflow } = await hasHorizontalScroll(page)
    assert(!overflow, 'horizontal overflow with countdown in critical state')
  })

  await check(`${label} [CD3] Countdown badge and leave button remain on-screen together (no element pushed off-screen)`, async () => {
    const leaveBox = await page.locator('[data-private-waiting-leave-button="1"]').boundingBox()
    const countdownBox = await page.locator('[data-private-room-countdown="1"]').first().boundingBox()
    assert(leaveBox !== null && countdownBox !== null, 'countdown badge or leave button missing')
    const vp = page.viewportSize()
    assert(leaveBox!.x + leaveBox!.width <= (vp?.width ?? 0) + 1, 'leave button extends past the viewport width')
    assert(countdownBox!.x >= -1, 'countdown badge extends before the viewport left edge')
  })

  // ─── Very narrow viewport (≤340px, e.g. 320x568): the countdown label must
  // switch to the short, complete "Остава" instead of clipping "Оставащо
  // време" mid-word with an ellipsis. The remaining-time value itself must
  // always stay fully visible regardless of which label is shown. ─────────
  if (viewportWidth <= 340) {
    await page.evaluate(({ room }) => {
      ;(window as any).__prwHarness.pushRoomUpdated(room)
    }, { room: makeRoom('mobile-narrow-countdown', [makeMember('me', 'Тестов Играч', true)], 'open', 5000, Date.now() + (14 * 60_000 + 32_000)) })

    await check(`${label} [CD4] Narrow viewport: the short label "Остава" is shown, not the full "Оставащо време"`, async () => {
      const info = await page.evaluate(() => {
        const full = document.querySelector('.prw-countdown-label-full')
        const short = document.querySelector('.prw-countdown-label-short')
        return {
          fullVisible: full !== null && getComputedStyle(full).display !== 'none',
          shortVisible: short !== null && getComputedStyle(short).display !== 'none',
          shortText: short?.textContent?.trim(),
        }
      })
      assert(!info.fullVisible, 'the full "Оставащо време" label is still visible at a narrow viewport')
      assert(info.shortVisible, 'the short "Остава" label is not visible at a narrow viewport')
      assert(info.shortText === 'Остава', `expected short label text "Остава", got "${info.shortText}"`)
    })

    await check(`${label} [CD5] Narrow viewport: no ellipsis/clipped text in the countdown label`, async () => {
      const info = await page.evaluate(() => {
        const short = document.querySelector('.prw-countdown-label-short')
        if (short === null) return null
        const style = getComputedStyle(short)
        return { textOverflow: style.textOverflow, text: short.textContent }
      })
      assert(info !== null, 'short label not found')
      assert(!(info!.text ?? '').includes('…') && !(info!.text ?? '').includes('...'), `label text contains an ellipsis: "${info!.text}"`)
    })

    await check(`${label} [CD6] Narrow viewport: the remaining time value is fully visible (e.g. "14:32", not truncated)`, async () => {
      const text = await page.locator('[data-private-room-countdown-value="1"]').first().textContent()
      assert(/^14:3[0-3]$/.test((text ?? '').trim()), `expected a fully visible ~14:3x value, got "${text}"`)
      const box = await page.locator('[data-private-room-countdown-value="1"]').first().boundingBox()
      assert(box !== null && box.width > 0, 'countdown value is not visible/rendered')
    })

    await check(`${label} [CD7] Narrow viewport: countdown badge and "Напусни" both remain within the viewport (no horizontal overflow)`, async () => {
      const leaveBox = await page.locator('[data-private-waiting-leave-button="1"]').boundingBox()
      const countdownBox = await page.locator('[data-private-room-countdown="1"]').first().boundingBox()
      assert(leaveBox !== null && countdownBox !== null, 'countdown badge or leave button missing at narrow viewport')
      assert(countdownBox!.x >= -1 && countdownBox!.x + countdownBox!.width <= viewportWidth + 1, `countdown badge out of bounds: ${JSON.stringify(countdownBox)}`)
      assert(leaveBox!.x >= -1 && leaveBox!.x + leaveBox!.width <= viewportWidth + 1, `leave button out of bounds: ${JSON.stringify(leaveBox)}`)
      const { overflow } = await hasHorizontalScroll(page)
      assert(!overflow, 'horizontal overflow at narrow viewport with countdown + leave button')
    })
  }
}

async function runMatchEndedScenario(page: Page, label: string, viewportWidth: number): Promise<void> {
  await page.goto('/scripts/fixtures/matchEndedHarness.html')
  await page.waitForFunction(() => (window as any).__matchEndedHarness !== undefined, undefined, { timeout: 10_000 })

  // ─── Private table (including bot-filled) end-game: only Replay + Exit ──
  await page.evaluate(() => (window as any).__matchEndedHarness.paint(true, true))
  await page.waitForTimeout(50)

  await check(`${label} [E1] Частна игра: "Нова игра" НЕ се показва`, async () => {
    const count = await page.locator('[data-match-ended-new-game-button="1"]').count()
    assert(count === 0, `"Нова игра" е показан за частна игра (count=${count})`)
  })
  await check(`${label} [E2] Частна игра: "Преиграй" и "Към лобито" са видими и удобни за натискане`, async () => {
    await assertVisibleEnabled(page.locator('[data-match-ended-replay-button="1"]'))
    await assertVisibleEnabled(page.locator('[data-match-ended-lobby-button="1"]'))
  })
  await check(`${label} [E3] Крайното табло не излиза извън екрана (частна игра)`, async () => {
    const { overflow } = await hasHorizontalScroll(page)
    assert(!overflow, 'хоризонтален overflow на end-game таблото')
    const within = await elementWithinViewport(page, '[data-match-ended-replay-button="1"]')
    assert(within, 'бутонът "Преиграй" излиза извън viewport-а')
  })
  await shot(page, `${viewportWidth}-endgame-private`)

  // ─── Public game end-game: all 3 buttons remain, correctly laid out ─────
  await page.evaluate(() => (window as any).__matchEndedHarness.paint(false, false))
  await page.waitForTimeout(50)

  await check(`${label} [E4] Публична игра: и трите бутона присъстват`, async () => {
    await assertVisibleEnabled(page.locator('[data-match-ended-lobby-button="1"]'))
    await assertVisibleEnabled(page.locator('[data-match-ended-replay-button="1"]'))
    await assertVisibleEnabled(page.locator('[data-match-ended-new-game-button="1"]'))
  })
  await check(`${label} [E5] Публична игра: няма хоризонтален overflow`, async () => {
    const { overflow } = await hasHorizontalScroll(page)
    assert(!overflow, 'хоризонтален overflow (публична игра)')
  })
  await shot(page, `${viewportWidth}-endgame-public`)
}

async function runNotificationScenario(page: Page, label: string, viewportWidth: number): Promise<void> {
  await page.goto('/scripts/fixtures/privateRoomCreatedNotificationHarness.html')
  await page.waitForFunction(() => (window as any).__notifHarness !== undefined, undefined, { timeout: 10_000 })

  const longName = 'Константин-Александър Величковски-Радославов Йорданов'

  await page.evaluate((name) => {
    ;(window as any).__notifHarness.handleIncoming({
      notificationId: 'notif-1',
      creatorDisplayName: name,
      creatorAvatarUrl: null,
      recipientInActiveGame: false,
    })
  }, longName)

  await page.waitForSelector('#private-room-created-enter-btn', { state: 'attached' })

  await check(`${label} [N1] Дълго име на кирилица се пренася без да излиза извън viewport-а`, async () => {
    const { overflow } = await hasHorizontalScroll(page)
    assert(!overflow, 'известието предизвика хоризонтален overflow с дълго име')
  })
  await check(`${label} [N2] Бутонът "Влез" е видим и кликаем`, async () => {
    await assertVisibleEnabled(page.locator('#private-room-created-enter-btn'))
  })
  await check(`${label} [N3] Бутонът за затваряне (✕) е видим и кликаем`, async () => {
    await assertVisibleEnabled(page.locator('#private-room-created-close-btn'))
  })
  await shot(page, `${viewportWidth}-notification-long-name`)

  await check(`${label} [N4] Клик на "Влез" затваря известието и вика onEnterPrivateRooms`, async () => {
    await page.locator('#private-room-created-enter-btn').click()
    const count = await page.evaluate(() => (window as any).__notifHarness.getEnterCount())
    assert(count === 1, `enterCount=${count}`)
    const stillThere = await page.locator('#private-room-created-enter-btn').count()
    assert(stillThere === 0, 'известието не се затвори след клик на "Влез"')
  })

  // ─── Second, distinct notice while one is showing -> queued, not lost ──
  await page.evaluate(() => {
    ;(window as any).__notifHarness.handleIncoming({ notificationId: 'notif-2', creatorDisplayName: 'Играч Две', creatorAvatarUrl: null, recipientInActiveGame: false })
  })
  await page.waitForSelector('#private-room-created-close-btn', { state: 'attached' })
  await page.evaluate(() => {
    ;(window as any).__notifHarness.handleIncoming({ notificationId: 'notif-3', creatorDisplayName: 'Играч Три', creatorAvatarUrl: null, recipientInActiveGame: false })
  })
  await check(`${label} [N5] Второ близко известие не презаписва/чупи първото — остава показано едно наведнъж`, async () => {
    const closeBtnCount = await page.locator('#private-room-created-close-btn').count()
    assert(closeBtnCount === 1, `очаквах точно 1 видимо известие наведнъж, получих ${closeBtnCount}`)
  })
  await page.locator('#private-room-created-close-btn').click()
  await check(`${label} [N6] Затварянето на текущото известие показва следващото от опашката (не се губи)`, async () => {
    await page.waitForFunction(() => document.querySelector('#private-room-created-close-btn') !== null, undefined, { timeout: 3_000 })
    const bodyText = await page.textContent('body')
    assert((bodyText ?? '').includes('Играч Три'), 'опашката не показа следващото известие')
  })
}

console.log('\ncheckPrivateRoomMobileResponsive\n')

const VIEWPORTS: Array<{ width: number; height: number; label: string; mobile: boolean }> = [
  { width: 320, height: 568, label: '320x568', mobile: true },
  { width: 360, height: 640, label: '360x640', mobile: true },
  { width: 360, height: 800, label: '360x800', mobile: true },
  { width: 375, height: 667, label: '375x667', mobile: true },
  { width: 390, height: 844, label: '390x844', mobile: true },
  { width: 412, height: 915, label: '412x915', mobile: true },
  { width: 430, height: 932, label: '430x932', mobile: true },
  { width: 1280, height: 800, label: '1280x800 (desktop)', mobile: false },
]

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  await mkdir(SCREENSHOT_DIR, { recursive: true })

  const port = await findFreePort()
  vite = await createViteServer({
    root: process.cwd(),
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
  })
  await vite.listen()

  browser = await chromium.launch()
  const baseUrl = `http://127.0.0.1:${port}`

  for (const vp of VIEWPORTS) {
    console.log(`\n--- Viewport ${vp.label} ---`)
    const context: BrowserContext = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.mobile,
      isMobile: vp.mobile,
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    await runWaitingRoomScenario(page, `[${vp.label}]`, vp.width)
    if (vp.mobile) {
      await runKeyboardOpenScenario(page, `[${vp.label}]`, vp.width, vp.height)
      await runMobileWaitingRoomLayoutScenario(page, `[${vp.label}]`, vp.width)
    }
    await runMatchEndedScenario(page, `[${vp.label}]`, vp.width)
    await runNotificationScenario(page, `[${vp.label}]`, vp.width)

    await check(`[${vp.label}] Няма JS грешки в конзолата през целия сценарий`, () => {
      assert(errors.length === 0, `Конзолни грешки: ${errors.join(' | ')}`)
    })

    await context.close()
  }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
console.log(`Screenshots written to: ${SCREENSHOT_DIR}`)
if (failed > 0) process.exit(1)
