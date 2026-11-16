/**
 * checkProfilePopupModerationScope.ts
 *
 * Реален браузър (Playwright), реален createLobbyFlowController и реален
 * renderer (desktop, 1280×800) — регресия за заглушаване на разгледан ЧУЖД
 * профил, показвано върху СОБСТВЕНИЯ профил на администратора.
 *
 * ПЪРВОПРИЧИНА: state.profilePopupTargetMute не се нулираше при отваряне на
 * собствения профил / затваряне, подаваше се към renderer-а без проверка за
 * profileId, а desktop renderer-ът рисуваше иконата за заглушаване без
 * !isOwnProfile. Кликът върху иконата отваряше прозорец с името на
 * собствения профил и срока/причината на чуждия.
 *
 *  [T1] чужд заглушен профил → собствен профил (след затваряне и директно);
 *  [T2] чужд заглушен профил → друг незаглушен профил;
 *  [T3] закъснял отговор (след затваряне/собствен профил; след смяна на профил);
 *  [T4] повторно отваряне на същия профил (стара заявка в ход; свежи данни);
 *  [T5] профил с реално активно заглушаване (икона + прозорец с правилните данни);
 *  [T6] актуализиране след unmute / mute от профилния прозорец.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
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

type Mute = { isMuted: boolean; mutedUntil: string | null; mutedByAccountId: string | null; reason: string | null }
const NOT_MUTED: Mute = { isMuted: false, mutedUntil: null, mutedByAccountId: null, reason: null }

function harness(page: Page) {
  const call = <T>(fn: string, ...args: unknown[]): Promise<T> =>
    page.evaluate(([f, a]: any) => (window as any).__profilePopupModerationScope[f](...a), [fn, args] as any)
  return {
    isPopupOpen: () => call<boolean>('isPopupOpen'),
    isOwnPopup: () => call<boolean>('isOwnPopup'),
    openOwn: () => call<boolean>('openOwn'),
    goLobby: () => call<boolean>('goLobby'),
    openOwnFromLobby: () => call<boolean>('openOwnFromLobby'),
    goPlayers: () => call<boolean>('goPlayers'),
    openPlayer: (id: string) => call<boolean>('openPlayer', id),
    close: () => call<boolean>('close'),
    pendingMuteLoads: () => call<string[]>('pendingMuteLoads'),
    resolveMute: (id: string, override?: Mute) => call<boolean>('resolveMute', id, override),
    overlayProfileId: () => call<string | null>('overlayProfileId'),
    muteActionProfileId: () => call<string | null>('muteActionProfileId'),
    clickOverlay: () => call<boolean>('clickOverlay'),
    clickMuteAction: () => call<boolean>('clickMuteAction'),
    moderationPopupText: () => call<string | null>('moderationPopupText'),
    chooseDuration: () => call<boolean>('chooseDuration'),
    typeReason: (text: string) => call<boolean>('typeReason', text),
    submitModeration: () => call<boolean>('submitModeration'),
    unmuteCalls: () => call<string[]>('unmuteCalls'),
    muteCalls: () => call<string[]>('muteCalls'),
    banLoads: () => call<string[]>('banLoads'),
    roleLoads: () => call<string[]>('roleLoads'),
  }
}
type H = ReturnType<typeof harness>

console.log('\n═══ checkProfilePopupModerationScope ═══\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null
const errors: string[] = []

async function freshPage(context: BrowserContext): Promise<H> {
  const page = await context.newPage()
  page.on('pageerror', (err) => errors.push(err.message))
  await page.goto('/scripts/fixtures/profilePopupModerationScopeHarness.html')
  await page.waitForFunction(() => (window as any).__profilePopupModerationScope !== undefined)
  const h = harness(page)
  assert(await h.goPlayers(), 'няма бутон „Играчи“ в лобито')
  return h
}

async function openRobertoMuted(h: H): Promise<void> {
  assert(await h.openPlayer('roberto'), 'няма карта на Roberto')
  assert(await h.resolveMute('roberto'), 'няма чакаща заявка за mute статуса на Roberto')
  assert((await h.overlayProfileId()) === 'roberto', `иконата за заглушаване на Roberto липсва (overlay=${await h.overlayProfileId()})`)
}

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 800 } })

  // ─── [T1] чужд заглушен → собствен ───────────────────────────────────
  await check('[T1a] чужд заглушен профил → затваряне → собствен профил: без икона за заглушаване', async () => {
    const h = await freshPage(context)
    await openRobertoMuted(h)
    assert(await h.close(), 'няма бутон за затваряне')
    assert(await h.openOwn(), 'няма бутон за собствения профил')
    assert(await h.isPopupOpen(), 'собственият профил не се отвори')
    assert(await h.isOwnPopup(), 'отвореният прозорец не е собственият профил')
    assert((await h.overlayProfileId()) === null, `иконата за заглушаване е видима върху собствения профил (overlay=${await h.overlayProfileId()})`)
    assert((await h.clickOverlay()) === false, 'иконата е кликаема върху собствения профил')
    assert((await h.moderationPopupText()) === null, 'отворен е прозорец за заглушаване')
  })

  await check('[T1c] чужд заглушен профил → затваряне → лоби → бутон „Профил“: без икона за заглушаване', async () => {
    const h = await freshPage(context)
    await openRobertoMuted(h)
    assert(await h.close(), 'няма бутон за затваряне')
    assert(await h.goLobby(), 'няма навигация към лобито')
    assert(await h.openOwnFromLobby(), 'няма бутон за собствения профил в лобито')
    assert(await h.isOwnPopup(), 'отвореният прозорец не е собственият профил')
    assert((await h.overlayProfileId()) === null, `иконата е видима върху собствения профил (overlay=${await h.overlayProfileId()})`)
  })

  await check('[T1b] чужд заглушен профил → собствен профил без затваряне: без икона, без прозорец', async () => {
    const h = await freshPage(context)
    await openRobertoMuted(h)
    assert(await h.openOwn(), 'няма бутон за собствения профил')
    assert(await h.isOwnPopup(), 'отвореният прозорец не е собственият профил')
    assert((await h.overlayProfileId()) === null, `иконата е видима върху собствения профил (overlay=${await h.overlayProfileId()})`)
    assert((await h.unmuteCalls()).length === 0, 'изпратена е заявка за отглушаване')
  })

  // ─── [T2] чужд заглушен → друг незаглушен ─────────────────────────────
  await check('[T2] чужд заглушен профил → друг незаглушен профил: без икона, бутон „Мют“ за правилния профил', async () => {
    const h = await freshPage(context)
    await openRobertoMuted(h)
    assert(await h.openPlayer('clean'), 'няма карта на втория профил')
    assert((await h.overlayProfileId()) === null, 'иконата на Roberto остана върху друг профил докато се зарежда')
    assert((await h.muteActionProfileId()) === null, 'бутонът „Мют“ е видим преди статусът да е зареден')
    assert((await h.pendingMuteLoads()).includes('clean'), 'не е заявен mute статус за новия профил')
    assert(await h.resolveMute('clean'), 'няма заявка за новия профил')
    assert((await h.overlayProfileId()) === null, 'икона за заглушаване върху незаглушен профил')
    assert((await h.muteActionProfileId()) === 'clean', `бутонът „Мют“ сочи към ${await h.muteActionProfileId()}, а не към новия профил`)
  })

  // ─── [T3] закъснели отговори ──────────────────────────────────────────
  await check('[T3a] закъснял отговор за чужд профил след затваряне и отваряне на собствения: игнорира се', async () => {
    const h = await freshPage(context)
    assert(await h.openPlayer('roberto'), 'няма карта на Roberto')
    assert((await h.pendingMuteLoads()).includes('roberto'), 'няма чакаща заявка')
    assert(await h.close(), 'няма бутон за затваряне')
    assert(await h.openOwn(), 'няма бутон за собствения профил')
    assert(await h.resolveMute('roberto'), 'заявката не можа да се резолва')
    assert((await h.overlayProfileId()) === null, 'закъснелият отговор показа икона върху собствения профил')
    assert(await h.isOwnPopup(), 'прозорецът вече не е собственият профил')
  })

  await check('[T3b] закъснял отговор за чужд профил след смяна към друг профил: игнорира се', async () => {
    const h = await freshPage(context)
    assert(await h.openPlayer('roberto'), 'няма карта на Roberto')
    assert(await h.openPlayer('clean'), 'няма карта на втория профил')
    assert(await h.resolveMute('roberto'), 'заявката за Roberto не можа да се резолва')
    assert((await h.overlayProfileId()) === null, 'закъснелият отговор за Roberto показа икона върху друг профил')
    assert((await h.muteActionProfileId()) === null, 'закъснелият отговор за Roberto активира бутона „Мют“ на друг профил')
    assert(await h.resolveMute('clean'), 'няма заявка за новия профил')
    assert((await h.muteActionProfileId()) === 'clean', 'статусът на новия профил не се показа')
  })

  // ─── [T4] повторно отваряне на същия профил ──────────────────────────
  await check('[T4a] затваряне и повторно отваряне на същия профил, докато старата заявка е в ход: важи само новата', async () => {
    const h = await freshPage(context)
    assert(await h.openPlayer('roberto'), 'няма карта на Roberto')
    assert(await h.close(), 'няма бутон за затваряне')
    assert(await h.openPlayer('roberto'), 'повторното отваряне не стана')
    const pending = await h.pendingMuteLoads()
    assert(pending.filter((id) => id === 'roberto').length === 2, `очакват се 2 заявки за Roberto (стара + нова), има: ${JSON.stringify(pending)}`)
    // Старата заявка връща различно (остаряло) състояние — трябва да се игнорира.
    assert(await h.resolveMute('roberto', NOT_MUTED), 'старата заявка не можа да се резолва')
    assert((await h.muteActionProfileId()) === null, 'старият отговор е приложен (бутон „Мют“ при заглушен профил)')
    assert((await h.overlayProfileId()) === null, 'иконата е показана преди новия отговор')
    assert(await h.resolveMute('roberto'), 'новата заявка не можа да се резолва')
    assert((await h.overlayProfileId()) === 'roberto', 'новият отговор не е приложен')
    assert((await h.muteActionProfileId()) === null, 'бутон „Мют“ при активно заглушаване')
  })

  await check('[T4b] повторно отваряне зарежда актуалните административни данни (mute, бан, роля)', async () => {
    const h = await freshPage(context)
    await openRobertoMuted(h)
    const banBefore = (await h.banLoads()).filter((id) => id === 'roberto').length
    const roleBefore = (await h.roleLoads()).filter((id) => id === 'roberto').length
    assert(await h.close(), 'няма бутон за затваряне')
    assert(await h.openPlayer('roberto'), 'повторното отваряне не стана')
    assert((await h.pendingMuteLoads()).includes('roberto'), 'при повторно отваряне не е заявен нов mute статус')
    // Междувременно друг модератор е премахнал заглушаването.
    assert(await h.resolveMute('roberto', NOT_MUTED), 'новата заявка не можа да се резолва')
    assert((await h.overlayProfileId()) === null, 'показва се остаряло заглушаване')
    assert((await h.muteActionProfileId()) === 'roberto', 'актуалният статус (незаглушен) не е показан')
    assert((await h.banLoads()).filter((id) => id === 'roberto').length === banBefore + 1, 'бан статусът не е презареден')
    assert((await h.roleLoads()).filter((id) => id === 'roberto').length === roleBefore + 1, 'ролята не е презаредена')
  })

  // ─── [T5] реално активно заглушаване ─────────────────────────────────
  await check('[T5] профил с активно заглушаване: икона и прозорец с името, срока и причината на същия профил', async () => {
    const h = await freshPage(context)
    await openRobertoMuted(h)
    assert(await h.clickOverlay(), 'иконата не е кликаема')
    const text = (await h.moderationPopupText()) ?? ''
    assert(text.includes('Roberto'), `прозорецът не съдържа името на профила: "${text}"`)
    assert(text.includes('Неподходящо съдържание'), `прозорецът не съдържа причината: "${text}"`)
    assert(!text.includes('Mimojef'), `прозорецът съдържа името на администратора: "${text}"`)
  })

  // ─── [T6] актуализиране след unmute / mute ───────────────────────────
  await check('[T6] unmute и mute от профилния прозорец: заявките са за правилния профил и данните се обновяват', async () => {
    const h = await freshPage(context)
    await openRobertoMuted(h)
    assert(await h.clickOverlay(), 'иконата не е кликаема')
    assert(await h.submitModeration(), 'няма бутон „Премахни заглушаването“')
    assert(JSON.stringify(await h.unmuteCalls()) === JSON.stringify(['roberto']), `unmute заявки: ${JSON.stringify(await h.unmuteCalls())}`)
    assert((await h.overlayProfileId()) === null, 'иконата остана след успешно отглушаване')

    assert(await h.close(), 'няма бутон за затваряне')
    assert(await h.openPlayer('roberto'), 'повторното отваряне не стана')
    assert(await h.resolveMute('roberto'), 'няма заявка за mute статуса')
    assert((await h.muteActionProfileId()) === 'roberto', 'след отглушаване не е показан бутон „Мют“')

    assert(await h.clickMuteAction(), 'бутонът „Мют“ не е кликаем')
    assert(await h.chooseDuration(), 'няма избор на срок')
    assert(await h.typeReason('Тест причина'), 'няма поле за причина')
    assert(await h.submitModeration(), 'няма бутон за потвърждение')
    assert(JSON.stringify(await h.muteCalls()) === JSON.stringify(['roberto']), `mute заявки: ${JSON.stringify(await h.muteCalls())}`)
    assert((await h.overlayProfileId()) === 'roberto', 'иконата за заглушаване не се появи веднага след mute')

    assert(await h.openOwn(), 'няма бутон за собствения профил')
    assert((await h.overlayProfileId()) === null, 'след mute на Roberto иконата се показва върху собствения профил')
    const calls = [...(await h.unmuteCalls()), ...(await h.muteCalls())]
    assert(!calls.includes('me-admin'), 'изпратена е заявка за собствения профил')
  })

  await check('Няма JS грешки в конзолата', () => {
    assert(errors.length === 0, `грешки: ${errors.join('; ')}`)
  })

  await context.close()
  console.log('\n' + '═'.repeat(64))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}
