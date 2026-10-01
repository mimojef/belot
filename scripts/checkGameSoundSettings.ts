// checkGameSoundSettings.ts
//
// Проверки за Белот "Настройки" → "Звуци по време на игра" (C = desktop ⚙️):
//  A) Node (fake Audio/localStorage/document): централният gate в
//     createGameAudioController + gameSoundSettings блокира всички игрови
//     звуци при OFF, спира веднага звучащите, пази стойността в localStorage
//     и я чете при ново зареждане.
//  B/C) Playwright mobile (360/320/412px) и desktop: "Изход" + ⚙️ — ⚙️ е
//     само икона (без фон/рамка/сянка, вкл. при hover/active), с достатъчна
//     невидима tap зона, центрирана спрямо "Изход", без застъпване (вкл. с
//     фразите/емоджитата на mobile); panel-ът се побира във viewport-а.

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'

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

// ---------------------------------------------------------------- fakes
const storage = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)) },
  removeItem: (key: string) => { storage.delete(key) },
}

type FakeAudio = {
  src: string
  playing: boolean
  playCount: number
  pauseCount: number
}
const allAudio: FakeAudio[] = []

class FakeAudioElement {
  src: string
  preload = ''
  volume = 1
  muted = false
  currentTime = 0
  duration = 1
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  state: FakeAudio
  private listeners = new Map<string, Array<() => void>>()
  constructor(src: string) {
    this.src = src
    this.state = { src, playing: false, playCount: 0, pauseCount: 0 }
    allAudio.push(this.state)
  }
  load(): void {}
  play(): Promise<void> {
    if (!this.muted) {
      this.state.playing = true
      this.state.playCount++
    }
    return Promise.resolve()
  }
  pause(): void {
    if (this.state.playing) this.state.pauseCount++
    this.state.playing = false
  }
  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }
}
;(globalThis as any).Audio = FakeAudioElement
;(globalThis as any).document = {
  visibilityState: 'visible',
  hasFocus: () => true,
  addEventListener: () => {},
}
;(globalThis as any).window = {
  addEventListener: () => {},
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: any) => clearTimeout(id),
}

const playingCount = () => allAudio.filter((a) => a.playing && a.playCount > 0).length
const playsOf = (needle: string) =>
  allAudio.filter((a) => a.src.includes(needle)).reduce((sum, a) => sum + a.playCount, 0)

async function runLogicChecks(): Promise<void> {
  console.log('\nA) Sound gate / stop / persistence')

  const settings = await import('../src/app/audio/gameSoundSettings.ts')
  const { createGameAudioController } = await import('../src/app/audio/createGameAudioController.ts')
  const audio = createGameAudioController()

  await check('default е ВКЛ. при празен localStorage', () => {
    assert(settings.isGameSoundsEnabled() === true, 'expected enabled by default')
  })

  await check('при ВКЛ. звуците от контролера и playGameSound() се пускат', () => {
    audio.playCardOnTable()
    audio.playCardMove()
    audio.playBidBubble('Пика')
    audio.playMatchEnded()
    audio.syncReactionCountdownWarning(true)
    settings.playGameSound('/audio/game-sounds/sum.mp3', { volume: 0.5 })
    assert(playsOf('card-on-table') === 1, 'card-on-table not played')
    assert(playsOf('card-move') === 1, 'card-move not played')
    assert(playsOf('spades') === 1, 'bid speech not played')
    assert(playsOf('EndGame') === 1, 'EndGame not played')
    assert(playsOf('counter') >= 1, 'countdown warning not played')
    assert(playsOf('sum.mp3') === 1, 'playGameSound not played')
  })

  await check('изключване спира ВЕДНАГА всички звучащи игрови звуци', () => {
    assert(playingCount() >= 6, `expected >=6 playing before disable, got ${playingCount()}`)
    settings.setGameSoundsEnabled(false)
    assert(playingCount() === 0, `still playing after disable: ${allAudio.filter((a) => a.playing).map((a) => a.src).join(', ')}`)
  })

  await check('стойността се записва в localStorage', () => {
    assert(storage.get('pika.belotGameSoundsEnabled') === 'false', `stored=${storage.get('pika.belotGameSoundsEnabled')}`)
  })

  await check('при ИЗКЛ. нищо не се пуска (bid, декларации, card SFX, край, countdown, deal, scoring)', async () => {
    const before = allAudio.reduce((sum, a) => sum + a.playCount, 0)
    audio.playCardOnTable()
    audio.playCardMove()
    audio.playBidBubble('Пас')
    audio.playDeclarationBubble(['Белот'])
    audio.playMatchEnded()
    audio.syncReactionCountdownWarning(true)
    audio.scheduleDealPacketSounds('seq-off', { packetCount: 2, packetStartDelayMs: 0, packetDelayStepMs: 5, packetLiftOffsetMs: 0 })
    settings.playGameSound('/audio/game-sounds/coins.mp3')
    await new Promise((done) => setTimeout(done, 40))
    const after = allAudio.reduce((sum, a) => sum + a.playCount, 0)
    assert(after === before, `expected no new plays, got ${after - before}`)
  })

  await check('ново зареждане чете запазеното ИЗКЛ.', async () => {
    const fresh = await import(`../src/app/audio/gameSoundSettings.ts?reload=${Date.now()}`)
    assert(fresh.isGameSoundsEnabled() === false, 'fresh module should read false')
  })

  await check('повторно включване връща звуците и записва true', () => {
    settings.setGameSoundsEnabled(true)
    const before = playsOf('card-on-table')
    audio.playCardOnTable()
    assert(playsOf('card-on-table') === before + 1, 'card-on-table not played after re-enable')
    assert(storage.get('pika.belotGameSoundsEnabled') === 'true', 'expected stored true')
  })

  audio.reset()
}

async function runLayoutChecks(): Promise<void> {
  console.log('\nB) Mobile layout')

  const { renderActiveRoomDesktopActionBar, renderActiveRoomMobileActionBar, renderActiveRoomSettingsPanel } =
    await import('../src/app/activeRoom/renderActiveRoomActionBar.ts')

  type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number }
  type GearProbe = {
    hit: Box
    icon: Box
    backgroundColor: string
    backgroundImage: string
    borderWidths: string
    boxShadow: string
    iconTransform: string
    cornerHitsButton: boolean
  }

  // String script: tsx/esbuild keepNames иначе вкарва `__name(...)`
  // helper в сериализираната функция, който не съществува в браузъра.
  const GEAR_PROBE_SCRIPT = `(() => {
    function box(el) {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    }
    const button = document.querySelector('[data-active-room-settings-button="1"]')
    const icon = button.querySelector('svg')
    const cs = getComputedStyle(button)
    const hit = box(button)
    const corner = document.elementFromPoint(hit.left + 2, hit.top + 2)
    return {
      hit,
      icon: box(icon),
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      borderWidths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].join(' '),
      boxShadow: cs.boxShadow,
      iconTransform: getComputedStyle(icon).transform,
      cornerHitsButton: !!corner && !!corner.closest('[data-active-room-settings-button="1"]'),
    }
  })()`
  const probeGear = async (page: Page) => (await page.evaluate(GEAR_PROBE_SCRIPT)) as GearProbe
  const center = (b: Box) => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 })

  function assertIconOnly(gear: GearProbe, state: string): void {
    assert(gear.backgroundColor === 'rgba(0, 0, 0, 0)', `${state}: background-color=${gear.backgroundColor}`)
    assert(gear.backgroundImage === 'none', `${state}: background-image=${gear.backgroundImage}`)
    assert(gear.borderWidths === '0px 0px 0px 0px', `${state}: border=${gear.borderWidths}`)
    assert(gear.boxShadow === 'none', `${state}: box-shadow=${gear.boxShadow}`)
  }

  async function checkGearIconLayout(label: string, leave: Box, gear: GearProbe, minHitPx: number): Promise<void> {
    await check(`${label}: ⚙️ е само икона — без фон, рамка и сянка`, () => {
      assertIconOnly(gear, 'idle')
      assert(gear.icon.width >= 20 && gear.icon.width <= 36, `icon size=${gear.icon.width}`)
    })
    await check(`${label}: невидимата tap зона е ≥${minHitPx}px и ъгълът ѝ (извън иконата) отваря ⚙️`, () => {
      assert(gear.hit.width >= minHitPx && gear.hit.height >= minHitPx, `hit=${gear.hit.width}x${gear.hit.height}`)
      assert(gear.cornerHitsButton, 'corner of hit area does not hit the button')
    })
    await check(`${label}: иконата е центрирана спрямо Изход и вдясно от него без застъпване`, () => {
      const iconCenter = center(gear.icon)
      const hitCenter = center(gear.hit)
      assert(Math.abs(iconCenter.y - center(leave).y) < 1, `icon cy=${iconCenter.y}, leave cy=${center(leave).y}`)
      assert(Math.abs(iconCenter.x - hitCenter.x) < 1 && Math.abs(iconCenter.y - hitCenter.y) < 1, 'icon not centered in hit area')
      assert(gear.hit.left >= leave.right, `hit overlaps Изход by ${leave.right - gear.hit.left}px`)
      const visualGap = gear.icon.left - leave.right
      assert(visualGap >= 8 && visualGap <= 28, `visual gap Изход→icon=${visualGap}`)
    })
  }

  async function checkGearIconFeedback(label: string, page: Page, gear: GearProbe, withHover: boolean): Promise<void> {
    const c = center(gear.hit)
    await check(`${label}: ${withHover ? 'hover/' : ''}active feedback е само върху иконата`, async () => {
      assert(gear.iconTransform === 'none', `idle icon transform=${gear.iconTransform}`)
      if (withHover) {
        await page.mouse.move(c.x, c.y)
        await page.waitForTimeout(200)
        const hovered = await probeGear(page)
        assertIconOnly(hovered, 'hover')
        assert(hovered.iconTransform !== 'none', 'no hover feedback on icon')
      }
      await page.mouse.move(c.x, c.y)
      await page.mouse.down()
      await page.waitForTimeout(200)
      const pressed = await probeGear(page)
      await page.mouse.up()
      assertIconOnly(pressed, 'active')
      assert(pressed.iconTransform !== 'none', 'no active feedback on icon')
      await page.mouse.move(0, 0)
      await page.waitForTimeout(200)
      const after = await probeGear(page)
      assert(after.iconTransform === 'none', `feedback stuck: ${after.iconTransform}`)
    })
  }

  // Фразите/емоджитата на phone layout (виж syncReactionButtons в
  // createActiveRoomFlowController.ts): bottom:5px, 40×40, right:64px/18px.
  const reactionStubs = `
    <button data-phrase-toggle="1" style="position:fixed;bottom:5px;right:64px;width:40px;height:40px;z-index:9998;"></button>
    <button data-emoji-toggle="1" style="position:fixed;bottom:5px;right:18px;width:40px;height:40px;z-index:9998;"></button>
  `

  const browser = await chromium.launch()
  try {
    for (const width of [360, 320, 412]) {
      const page = await browser.newPage({ viewport: { width, height: 740 }, deviceScaleFactor: 2 })
      await page.setContent(`<!doctype html><html><body style="margin:0;font-family:system-ui;">${renderActiveRoomMobileActionBar()}${reactionStubs}</body></html>`)

      const boxes = await page.evaluate(`(() => {
        function box(sel) {
          const r = document.querySelector(sel).getBoundingClientRect()
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
        }
        const leave = document.querySelector('[data-active-room-leave-button="1"]')
        return {
          leave: box('[data-active-room-leave-button="1"]'),
          phrase: box('[data-phrase-toggle="1"]'),
          emoji: box('[data-emoji-toggle="1"]'),
          leaveTextOverflows: leave.scrollWidth > leave.clientWidth,
          docScrollWidth: document.documentElement.scrollWidth,
        }
      })()`) as { leave: Box; phrase: Box; emoji: Box; leaveTextOverflows: boolean; docScrollWidth: number }
      const gear = await probeGear(page)

      await check(`@${width}px: Изход е по-тесен от преди (104px) и текстът се побира`, () => {
        assert(boxes.leave.width < 104, `leave width=${boxes.leave.width}`)
        assert(!boxes.leaveTextOverflows, 'Изход text overflows')
      })
      await checkGearIconLayout(`@${width}px`, boxes.leave, gear, 40)
      await check(`@${width}px: без застъпване с фрази/емоджи и без хоризонтален scroll`, () => {
        assert(gear.hit.right + 8 <= boxes.phrase.left, `gear.right=${gear.hit.right}, phrase.left=${boxes.phrase.left}`)
        assert(boxes.phrase.right <= boxes.emoji.left, 'phrase/emoji overlap')
        assert(boxes.docScrollWidth <= width, `scrollWidth=${boxes.docScrollWidth}`)
      })
      await checkGearIconFeedback(`@${width}px`, page, gear, false)

      await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), renderActiveRoomSettingsPanel(true))
      const panel = await page.evaluate(`(() => {
        const r = document.querySelector('[data-active-room-settings-panel="1"]').getBoundingClientRect()
        const toggle = document.querySelector('[data-active-room-game-sounds-toggle="1"]')
        const bar = document.querySelector('[data-active-room-mobile-action-bar="1"]').getBoundingClientRect()
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, barTop: bar.top, label: toggle.textContent.trim(), checked: toggle.getAttribute('aria-checked') }
      })()`) as { left: number; right: number; top: number; bottom: number; barTop: number; label: string; checked: string }
      await check(`@${width}px: Настройки panel е във viewport-а, над лентата`, () => {
        assert(panel.left >= 0 && panel.right <= width && panel.top >= 0, JSON.stringify(panel))
        assert(panel.bottom <= panel.barTop, `panel.bottom=${panel.bottom}, bar.top=${panel.barTop}`)
        assert(panel.label === 'Вкл.' && panel.checked === 'true', `toggle=${panel.label}/${panel.checked}`)
      })

      if (width === 360) {
        await page.screenshot({ path: process.env.SCREENSHOT_PATH ?? join(tmpdir(), 'game-sound-settings-360.png'), clip: { x: 0, y: 740 - 200, width, height: 200 } })
      }
      await page.close()
    }

    console.log('\nC) Desktop layout')
    for (const [width, height] of [[1280, 720], [1920, 950]] as const) {
      const page = await browser.newPage({ viewport: { width, height } })
      // Arial = глобалният шрифт на приложението (src/style.css).
      await page.setContent(`<!doctype html><html><body style="margin:0;font-family:Arial, Helvetica, sans-serif;background:#141414;">${renderActiveRoomDesktopActionBar()}</body></html>`)
      const boxes = await page.evaluate(`(() => {
        const leave = document.querySelector('[data-active-room-leave-button="1"]')
        const r = leave.getBoundingClientRect()
        return {
          leave: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
          leaveTextOverflows: leave.scrollWidth > leave.clientWidth,
        }
      })()`) as { leave: Box; leaveTextOverflows: boolean }
      const gear = await probeGear(page)

      await check(`desktop ${width}px: Изход е на старото място (left 18, bottom 24) и текстът се побира`, () => {
        assert(Math.abs(boxes.leave.left - 18) < 0.5, `leave.left=${boxes.leave.left}`)
        assert(Math.abs(height - boxes.leave.bottom - 24) < 0.5, `leave bottom offset=${height - boxes.leave.bottom}`)
        assert(!boxes.leaveTextOverflows, 'Изход text overflows')
      })
      await checkGearIconLayout(`desktop ${width}px`, boxes.leave, gear, 44)
      await checkGearIconFeedback(`desktop ${width}px`, page, gear, true)

      await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), renderActiveRoomSettingsPanel(false, 'desktop'))
      const panel = await page.evaluate(`(() => {
        const r = document.querySelector('[data-active-room-settings-panel="1"]').getBoundingClientRect()
        const toggle = document.querySelector('[data-active-room-game-sounds-toggle="1"]')
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, label: toggle.textContent.trim(), checked: toggle.getAttribute('aria-checked') }
      })()`) as { left: number; right: number; top: number; bottom: number; label: string; checked: string }
      await check(`desktop ${width}px: Настройки panel е над бутоните и във viewport-а`, () => {
        assert(panel.left >= 0 && panel.right <= width && panel.top >= 0, JSON.stringify(panel))
        assert(panel.bottom <= boxes.leave.top, `panel.bottom=${panel.bottom}, buttons.top=${boxes.leave.top}`)
        assert(panel.label === 'Изкл.' && panel.checked === 'false', `toggle=${panel.label}/${panel.checked}`)
      })

      if (width === 1920) {
        await page.screenshot({ path: process.env.DESKTOP_SCREENSHOT_PATH ?? join(tmpdir(), 'game-sound-settings-desktop.png'), clip: { x: 0, y: height - 260, width: 420, height: 260 } })
      }
      await page.close()
    }
  } finally {
    await browser.close()
  }
}

await runLogicChecks()
await runLayoutChecks()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
