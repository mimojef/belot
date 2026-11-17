/**
 * checkSupportOwnMessageDeleteE2E.ts — „Поддръжка“, кошчето на собственика
 * (PIKA_OWNER_ACCOUNT_ID) в реалния клиент (Vite + Chromium) срещу изолиран
 * сървър (giftBackTestHarness).
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkSupportOwnMessageDeleteE2E.ts
 *
 * Скрийншоти: <tmp>/belot-v2-support-own-delete/*.png
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Page } from 'playwright'
import { assert, check, finishAndExit, startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckSupportOwnMessageDeleteE2E\n')

const OUT = join(tmpdir(), 'belot-v2-support-own-delete')
await mkdir(OUT, { recursive: true })

const env: Record<string, string> = {}
const h = await startGiftBackHarness({ env })
const opened: Array<{ close: () => Promise<void> }> = []

try {
  let tag = 0
  async function register(): Promise<TestProfile> {
    h.db.prepare('DELETE FROM registration_rate_limit_events').run()
    tag += 1
    return h.register(`e${tag}`)
  }
  const accountOf = (profileId: string) => (h.db.prepare('SELECT account_id FROM profiles WHERE profile_id = ?').get(profileId) as { account_id: string }).account_id
  async function api(p: TestProfile, method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${h.backendOrigin}${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: `belot_session=${p.cookie}` }, body: body === undefined ? undefined : JSON.stringify(body) })
    return res.json()
  }

  const owner = await register()
  const admin2 = await register()
  const user = await register()
  h.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id IN (?, ?)`).run(accountOf(owner.profileId), accountOf(admin2.profileId))
  h.db.prepare(`UPDATE accounts SET created_at = '2020-01-01 00:00:00' WHERE account_id = ?`).run(accountOf(user.profileId))
  env.PIKA_OWNER_ACCOUNT_ID = accountOf(owner.profileId)
  await h.restartServer()

  await api(user, 'POST', '/api/support/messages', { body: 'Въпрос от потребителя' })
  const fromAdmin2 = (await api(admin2, 'POST', '/api/support/admin/reply', { profileId: user.profileId, body: 'Отговор на втория админ' })).message.messageId as string
  const first = (await api(owner, 'POST', '/api/support/admin/reply', { profileId: user.profileId, body: 'Първи отговор на собственика' })).message.messageId as string
  const second = (await api(owner, 'POST', '/api/support/admin/reply', { profileId: user.profileId, body: 'Втори отговор на собственика' })).message.messageId as string

  async function openPage(p: TestProfile, width: number, height: number): Promise<Page> {
    const mobile = width < 600
    const context = await h.browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
    await context.addCookies([{ name: 'belot_session', value: p.cookie, url: h.backendOrigin }])
    await context.addInitScript(() => {
      try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch { /* ignore */ }
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => console.error(`    pageerror: ${error.message}`))
    opened.push({ close: () => context.close() })
    await page.goto(`${h.appOrigin}/lobby`)
    await page.locator('[data-lobby-nav-support="1"]').first().waitFor({ state: 'attached', timeout: 30_000 })
    await page.waitForTimeout(800)
    return page
  }
  async function openSupport(page: Page): Promise<void> {
    await page.evaluate(() => (document.querySelector('[data-lobby-nav-support="1"]') as HTMLElement).click())
    await page.waitForTimeout(600)
  }
  async function openAdminConversation(page: Page): Promise<void> {
    // admin: пощенската иконка отваря меню → „Съобщения от потребители“
    // (мобилно: менюто → „Поддръжка“, което за admin отваря същия екран)
    await page.evaluate(() => ((document.querySelector('[data-lobby-nav-support-users="1"]') ?? document.querySelector('[data-lobby-nav-support="1"]')) as HTMLElement | null)?.click())
    await page.waitForTimeout(600)
    await page.locator(`[data-admin-support-conv="${user.profileId}"]`).first().click()
    await page.locator(`[data-support-message="${first}"]`).first().waitFor({ timeout: 10_000 })
  }
  const trashCount = (page: Page, id: string) => page.locator(`[data-support-message="${id}"] [data-admin-support-message-delete]`).count()

  for (const [label, width, height] of [['desktop', 1280, 850], ['mobile', 390, 844]] as const) {
    if (label === 'mobile') {
      // нов отговор за мобилния сценарий
      ;(globalThis as any).__second = (await api(owner, 'POST', '/api/support/admin/reply', { profileId: user.profileId, body: 'Мобилен отговор на собственика' })).message.messageId
    }
    const target = label === 'desktop' ? second : (globalThis as any).__second as string
    const ownerPage = await openPage(owner, width, height)
    const admin2Page = await openPage(admin2, width, height)
    const userPage = await openPage(user, width, height)
    await openAdminConversation(ownerPage)
    await openAdminConversation(admin2Page)
    await openSupport(userPage)
    await userPage.locator(`[data-support-message="${target}"]`).first().waitFor({ timeout: 10_000 })
    await ownerPage.screenshot({ path: join(OUT, `${label}-owner-before.png`) })

    await check(`${label}: собственикът вижда кошче само до своите съобщения`, async () => {
      assert(await trashCount(ownerPage, target) === 1 && await trashCount(ownerPage, fromAdmin2) === 0, 'trash visibility')
      const userMsgTrash = await ownerPage.locator('[data-support-message] [data-admin-support-message-delete]').count()
      const ownCount = (await ownerPage.locator('[data-support-message]').evaluateAll((nodes) => nodes.length))
      assert(userMsgTrash >= 1 && userMsgTrash < ownCount, `trash ${userMsgTrash} of ${ownCount}`)
    })
    await check(`${label}: другият admin и потребителят нямат кошче`, async () => {
      assert(await admin2Page.locator('[data-admin-support-message-delete]').count() === 0, 'admin2')
      assert(await userPage.locator('[data-admin-support-message-delete]').count() === 0, 'user')
      const userHtml = await userPage.content()
      assert(!userHtml.includes(accountOf(owner.profileId)), 'account id leaked to user DOM')
    })
    await check(`${label}: „Отказ“ в потвърждението не трие`, async () => {
      await ownerPage.locator(`[data-support-message="${target}"] [data-admin-support-message-delete]`).click({ force: true })
      await ownerPage.locator('[data-admin-support-message-delete-confirm="1"]').waitFor()
      await ownerPage.screenshot({ path: join(OUT, `${label}-owner-confirm.png`) })
      await ownerPage.locator('[data-admin-support-message-delete-cancel="1"]').click()
      await ownerPage.waitForTimeout(300)
      assert(await ownerPage.locator('[data-admin-support-message-delete-confirm="1"]').count() === 0, 'modal still open')
      assert(h.db.prepare('SELECT 1 FROM support_messages WHERE message_id = ?').get(target) !== undefined, 'deleted on cancel')
    })
    await check(`${label}: потвърждение → изтрито при собственика, при отворения прозорец на потребителя и при другия admin`, async () => {
      await ownerPage.locator(`[data-support-message="${target}"] [data-admin-support-message-delete]`).click({ force: true })
      await ownerPage.locator('[data-admin-support-message-delete-confirm="1"]').click()
      await ownerPage.locator(`[data-support-message="${target}"]`).waitFor({ state: 'detached', timeout: 10_000 })
      await userPage.locator(`[data-support-message="${target}"]`).waitFor({ state: 'detached', timeout: 10_000 })
      await admin2Page.locator(`[data-support-message="${target}"]`).waitFor({ state: 'detached', timeout: 10_000 })
      assert(h.db.prepare('SELECT 1 FROM support_messages WHERE message_id = ?').get(target) === undefined, 'row')
      assert(await userPage.locator(`[data-support-message="${first}"]`).count() === 1, 'other message disappeared')
      await ownerPage.screenshot({ path: join(OUT, `${label}-owner-after.png`) })
      await userPage.screenshot({ path: join(OUT, `${label}-user-after.png`) })
    })
    for (const o of opened.splice(0)) await o.close()
  }
} finally {
  for (const o of opened) await o.close()
  await h.close()
}

console.log(`\n  Скрийншоти: ${OUT}`)
finishAndExit()
