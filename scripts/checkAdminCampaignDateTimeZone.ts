/**
 * checkAdminCampaignDateTimeZone.ts
 *
 * Регресионен тест за production инцидент: клонирана кампания + ново
 * зададени начало/край в admin редактора се записват/показват с ИЗМЕСТЕНИ
 * стойности. Причина (виж src/app/adminCampaigns/campaignSofiaDateTime.ts
 * doc коментара за пълния отчет): `<input type="datetime-local">` носи
 * "wall clock" низ БЕЗ timezone — преди поправката показването ползваше
 * browser/OS timezone-а на оператора (`date.getTimezoneOffset()`), а
 * записът пращаше суровия низ directly към backend-а, където
 * `Date.parse()` го тълкуваше спрямо СИСТЕМНИЯ TZ на Node процеса
 * (production VPS: UTC), не Europe/Sofia — изместване с 2-3 часа (EEST/EET).
 *
 * Използва РЕАЛНИЯ production render код (renderAdminCampaignsPanel.ts +
 * attachAdminCampaignsHandlers) в реален браузър (Playwright), synthetic
 * state — mirror на established adminCampaignArchivePanelHarness.ts подход.
 *
 *   [1] Клонирана кампания (UTC стойности) се показва в редактора с
 *       КОРЕКТНИТЕ Europe/Sofia wall-clock стойности в datetime-local
 *       полетата (вкл. полунощ edge case и зимно/лятно часово време).
 *   [2] Въвеждане на НОВА начална/крайна дата (Sofia местно време, вкл.
 *       преминаване през полунощ) -> onSave извикан с коректния UTC ISO
 *       еквивалент — точно обратното на production бъга.
 *   [3] След "запис" (пресъздаден draft от onSave-натите стойности) ->
 *       повторен render показва ТОЧНО същите datetime-local стойности,
 *       които операторът въведе (round-trip stability).
 *   [4] DST есенен преход (лято EEST -> зима EET, 25.10.2026): начало преди
 *       прехода, край след прехода — и двата полета се конвертират с
 *       правилния, РАЗЛИЧЕН offset за всеки.
 *   [5] DST пролетен преход (зима EET -> лято EEST, 29.03.2026) — аналогично.
 *   [6] Клонирана кампания + редакция САМО на началната дата -> крайната
 *       остава непроменена (клонирането не презаписва въведените стойности).
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      const { port } = address
      srv.close(() => resolveFree(port))
    })
  })
}

type H = {
  render: (draft: unknown) => void
  baseDraft: (overrides?: Record<string, unknown>) => Record<string, unknown>
  getCalls: () => Array<{ name: string; args: unknown[] }>
  getStartsInputValue: () => string
  getEndsInputValue: () => string
  setStartsInputValue: (value: string) => void
  setEndsInputValue: (value: string) => void
  submitForm: () => void
}

async function call<T>(page: Page, fn: (h: H, arg: any) => T, arg: any = undefined): Promise<T> {
  return page.evaluate(
    ({ fn: fnStr, arg: a }) => {
      const h = (window as any).__adminCampaignsPanelDateHarness as H
      // eslint-disable-next-line no-eval
      const resolved = (0, eval)(fnStr) as (h: H, arg: any) => T
      return resolved(h, a)
    },
    { fn: fn.toString(), arg },
  )
}

console.log('\ncheckAdminCampaignDateTimeZone')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/adminCampaignsPanelDateHarness.html`

  browser = await chromium.launch()

  async function newPage(): Promise<Page> {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__adminCampaignsPanelDateHarness !== undefined, undefined, { timeout: 10_000 })
    if (pageErrors.length > 0) throw new Error(`page errors during setup: ${pageErrors.join(' | ')}`)
    ;(page as any).__pageErrors = pageErrors
    return page
  }
  function assertNoPageErrors(page: Page, label: string): void {
    const errors = (page as any).__pageErrors as string[]
    assert(errors.length === 0, `${label}: ${errors.join(' | ')}`)
  }

  const page = await newPage()

  await check('[1] Клонирана кампания (UTC) -> датите в редактора показват коректното Europe/Sofia местно време', async () => {
    // startsAt='2026-10-13T21:00:00.000Z' == Sofia 2026-10-14T00:00 (EEST,
    // UTC+3, точно полунощ — упражнява hour=24 Intl edge case-а).
    // endsAt='2026-11-07T04:00:00.000Z' == Sofia 2026-11-07T06:00 (EET,
    // UTC+2, след DST края на 25.10.2026).
    const draft = await call(page, (h: H) => h.baseDraft({ campaignId: 'camp-1' }))
    await call(page, (h: H, d: unknown) => h.render(d), draft)
    const starts = await call(page, (h: H) => h.getStartsInputValue())
    const ends = await call(page, (h: H) => h.getEndsInputValue())
    assert(starts === '2026-10-14T00:00', `starts: ${starts}`)
    assert(ends === '2026-11-07T06:00', `ends: ${ends}`)
    assertNoPageErrors(page, '[1]')
  })

  await check('[2] Нови начало/край (Sofia местно, през полунощ) -> onSave с коректния UTC ISO еквивалент', async () => {
    const draft = await call(page, (h: H) => h.baseDraft({ campaignId: 'camp-2' }))
    await call(page, (h: H, d: unknown) => h.render(d), draft)
    // Операторът въвежда Sofia местно "2026-10-20T23:30" (старт, малко преди
    // полунощ) и "2026-10-21T00:15" (край, веднага след полунощ — различен
    // календарен ден от началото). И двете в EEST (преди DST края).
    await call(page, (h: H, v: unknown) => h.setStartsInputValue(v as string), '2026-10-20T23:30')
    await call(page, (h: H, v: unknown) => h.setEndsInputValue(v as string), '2026-10-21T00:15')
    await call(page, (h: H) => h.submitForm())
    const calls = await call(page, (h: H) => h.getCalls())
    const saveCall = calls.find((c) => c.name === 'onSave')
    assert(saveCall !== undefined, `onSave не е извикан: ${JSON.stringify(calls)}`)
    const savedDraft = saveCall!.args[0] as { startsAt: string; endsAt: string }
    // Sofia 23:30 (EEST, UTC+3) 20.10 -> UTC 20:30 20.10.
    assert(savedDraft.startsAt === '2026-10-20T20:30:00.000Z', `startsAt: ${savedDraft.startsAt}`)
    // Sofia 00:15 (EEST, UTC+3) 21.10 -> UTC 21:15 20.10 (ПРЕДИШЕН UTC ден!).
    assert(savedDraft.endsAt === '2026-10-20T21:15:00.000Z', `endsAt: ${savedDraft.endsAt}`)
    assertNoPageErrors(page, '[2]')
  })

  await check('[3] След "запис" -> повторен render показва ТОЧНО въведените стойности (round-trip stability)', async () => {
    const draft = await call(page, (h: H) => h.baseDraft({ campaignId: 'camp-3' }))
    await call(page, (h: H, d: unknown) => h.render(d), draft)
    await call(page, (h: H, v: unknown) => h.setStartsInputValue(v as string), '2026-06-15T09:45')
    await call(page, (h: H, v: unknown) => h.setEndsInputValue(v as string), '2026-07-01T18:00')
    await call(page, (h: H) => h.submitForm())
    const calls = await call(page, (h: H) => h.getCalls())
    const saveCall = calls[calls.length - 1]!
    assert(saveCall.name === 'onSave', JSON.stringify(calls))
    const savedDraft = saveCall.args[0] as Record<string, unknown>
    // Симулира "презареждане на страницата" -> нов render със ЗАПИСАНИЯ draft.
    await call(page, (h: H, d: unknown) => h.render(d), savedDraft)
    const starts = await call(page, (h: H) => h.getStartsInputValue())
    const ends = await call(page, (h: H) => h.getEndsInputValue())
    assert(starts === '2026-06-15T09:45', `starts след reload: ${starts} (очаквах точно въведеното)`)
    assert(ends === '2026-07-01T18:00', `ends след reload: ${ends} (очаквах точно въведеното)`)
    assertNoPageErrors(page, '[3]')
  })

  await check('[4] DST есенен преход (25.10.2026): начало преди прехода (EEST), край след прехода (EET) -> различни, коректни offset-и', async () => {
    const draft = await call(page, (h: H) => h.baseDraft({ campaignId: 'camp-4' }))
    await call(page, (h: H, d: unknown) => h.render(d), draft)
    await call(page, (h: H, v: unknown) => h.setStartsInputValue(v as string), '2026-10-24T20:00')
    await call(page, (h: H, v: unknown) => h.setEndsInputValue(v as string), '2026-10-26T20:00')
    await call(page, (h: H) => h.submitForm())
    const calls = await call(page, (h: H) => h.getCalls())
    const savedDraft = calls[calls.length - 1]!.args[0] as { startsAt: string; endsAt: string }
    // 24.10 20:00 Sofia (EEST, +3, преди прехода) -> UTC 17:00.
    assert(savedDraft.startsAt === '2026-10-24T17:00:00.000Z', `startsAt: ${savedDraft.startsAt}`)
    // 26.10 20:00 Sofia (EET, +2, след прехода на 25.10) -> UTC 18:00.
    assert(savedDraft.endsAt === '2026-10-26T18:00:00.000Z', `endsAt: ${savedDraft.endsAt}`)
    assertNoPageErrors(page, '[4]')
  })

  await check('[5] DST пролетен преход (29.03.2026): начало преди прехода (EET), край след прехода (EEST)', async () => {
    const draft = await call(page, (h: H) => h.baseDraft({ campaignId: 'camp-5' }))
    await call(page, (h: H, d: unknown) => h.render(d), draft)
    await call(page, (h: H, v: unknown) => h.setStartsInputValue(v as string), '2026-03-28T10:00')
    await call(page, (h: H, v: unknown) => h.setEndsInputValue(v as string), '2026-03-30T10:00')
    await call(page, (h: H) => h.submitForm())
    const calls = await call(page, (h: H) => h.getCalls())
    const savedDraft = calls[calls.length - 1]!.args[0] as { startsAt: string; endsAt: string }
    // 28.03 10:00 Sofia (EET, +2, преди прехода) -> UTC 08:00.
    assert(savedDraft.startsAt === '2026-03-28T08:00:00.000Z', `startsAt: ${savedDraft.startsAt}`)
    // 30.03 10:00 Sofia (EEST, +3, след прехода на 29.03) -> UTC 07:00.
    assert(savedDraft.endsAt === '2026-03-30T07:00:00.000Z', `endsAt: ${savedDraft.endsAt}`)
    assertNoPageErrors(page, '[5]')
  })

  await check('[6] Клониране + редакция само на началната дата -> крайната остава непроменена (клонирането не презаписва)', async () => {
    const draft = await call(page, (h: H) => h.baseDraft({ campaignId: 'camp-6' }))
    await call(page, (h: H, d: unknown) => h.render(d), draft)
    const endsBeforeEdit = await call(page, (h: H) => h.getEndsInputValue())
    assert(endsBeforeEdit === '2026-11-07T06:00', `ends преди редакция: ${endsBeforeEdit}`)
    await call(page, (h: H, v: unknown) => h.setStartsInputValue(v as string), '2026-10-15T08:00')
    await call(page, (h: H) => h.submitForm())
    const calls = await call(page, (h: H) => h.getCalls())
    const savedDraft = calls[calls.length - 1]!.args[0] as { startsAt: string; endsAt: string }
    assert(savedDraft.startsAt === '2026-10-15T05:00:00.000Z', `startsAt (Sofia 08:00 EEST -> UTC 05:00): ${savedDraft.startsAt}`)
    // Крайната дата изобщо не е пипната във формата -> трябва да остане
    // точната клонирана UTC стойност от draft-а, не нулева/друга.
    assert(savedDraft.endsAt === '2026-11-07T04:00:00.000Z', `endsAt трябва да остане клонираната стойност: ${savedDraft.endsAt}`)
    assertNoPageErrors(page, '[6]')
  })
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
