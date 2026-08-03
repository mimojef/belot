/**
 * Targeted source guard for the mobile-only lobby live chat fullscreen mode.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const projectRootArg = process.argv.find((arg) => arg.startsWith('--project-root='))
const projectRoot = projectRootArg ? resolve(projectRootArg.slice('--project-root='.length)) : resolve('..')

const renderSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8')
const controllerSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/createLobbyFlowController.ts'), 'utf8')

let passed = 0
let failed = 0

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

console.log('\n=== Lobby live chat mobile fullscreen source check ===\n')

check('[1] fullscreen toggle exists only through compact mobile rendering', () => {
  const panelFn = renderSrc.match(/function renderLobbyChatPanel[\s\S]*?\n\}/)?.[0] ?? ''
  const mobileSectionFn = renderSrc.match(/function renderMobileLobbyChatSection[\s\S]*?\n\}/)?.[0] ?? ''
  const desktopHeroFn = renderSrc.match(/function renderLobbyHeroCardsAndChat[\s\S]*?\n\}/)?.[0] ?? ''

  assert(panelFn.includes('compact && opts.fullscreen === true'), 'panel fullscreen must be gated by compact mode')
  assert(panelFn.includes('const fullscreenToggle = compact'), 'fullscreen button must be created only for compact mode')
  assert(mobileSectionFn.includes('compact: true, fullscreen: isFullscreen'), 'mobile compact panel must receive fullscreen state')
  assert(desktopHeroFn.includes('compact: false'), 'desktop chat must remain non-compact')
  assert(!desktopHeroFn.includes('fullscreen:'), 'desktop chat must not receive fullscreen controls')
})

check('[2] toggle button is phone-friendly and accessible', () => {
  assert(renderSrc.includes('data-lobby-livechat-fullscreen-toggle="1"'), 'missing fullscreen toggle data hook')
  assert(renderSrc.includes('aria-label="${fullscreen ?'), 'missing state-specific aria-label')
  assert(renderSrc.includes('title="${fullscreen ?'), 'missing state-specific title')
  assert(renderSrc.includes('width:26px;height:26px'), 'compact toggle should stay small enough to preserve message rows')
  assert(renderSrc.includes('width="15" height="15"'), 'compact toggle icon should remain visually modest')
  assert(renderSrc.includes('renderLobbyChatFullscreenIcon(fullscreen)'), 'toggle must swap expand/collapse SVG paths')
})

check('[3] fullscreen overlay uses fixed viewport, dvh fallback and safe areas', () => {
  const mobileSectionFn = renderSrc.match(/function renderMobileLobbyChatSection[\s\S]*?\n\}/)?.[0] ?? ''
  assert(mobileSectionFn.includes('position:fixed;inset:0'), 'fullscreen section must be fixed and cover the viewport')
  assert(/z-index:\s*1[0-9]{4}/.test(mobileSectionFn), 'fullscreen section must be above normal UI with a high z-index')
  assert(mobileSectionFn.includes('height:100vh;height:100dvh'), 'fullscreen section must use 100dvh with 100vh fallback')
  assert(mobileSectionFn.includes('env(safe-area-inset-top') && mobileSectionFn.includes('env(safe-area-inset-bottom'), 'fullscreen section must respect safe-area insets')
  assert(mobileSectionFn.includes('height:190px'), 'normal mobile chat height should avoid clipping the top message row')
})

check('[4] body scroll lock is applied and released safely', () => {
  assert(renderSrc.includes('setLobbyChatBodyScrollLocked(shouldShowLobbyChatFullscreen)'), 'render must apply/release body scroll lock from fullscreen state')
  assert(renderSrc.includes("body.style.overflow = 'hidden'"), 'body overflow must be locked')
  assert(renderSrc.includes("body.style.touchAction = 'none'"), 'touch scrolling behind the chat must be blocked')
  assert(renderSrc.includes('export function releaseLobbyChatBodyScrollLock'), 'cleanup release function must be exported')
  assert(controllerSrc.includes('releaseLobbyChatBodyScrollLock()'), 'controller must release body scroll lock on teardown/exit')
})

check('[5] fullscreen state persists through rerender and is reset on exit', () => {
  assert(controllerSrc.includes('lobbyChatFullscreen: boolean'), 'controller state must include fullscreen flag')
  assert(controllerSrc.includes('lobbyChatFullscreen: false'), 'fullscreen state must initialize collapsed')
  assert(controllerSrc.includes('state.lobbyChatFullscreen = value') && controllerSrc.includes('render()'), 'toggle must update state and rerender')
  assert(controllerSrc.includes('state.lobbyChatFullscreen = false'), 'exit/suspend paths must reset fullscreen state')
  assert(renderSrc.includes('state.lobbyChatFullscreen') && renderSrc.includes('shouldShowLobbyChatFullscreen'), 'render must derive fullscreen from persistent state')
})

check('[6] existing live chat behavior remains wired', () => {
  assert(renderSrc.includes('wasLobbyChatNearBottom'), 'smart autoscroll guard must remain')
  assert(renderSrc.includes('savedLobbyChatInputSelectionStart'), 'focus/selection preservation must remain')
  assert(renderSrc.includes('savedLobbyChatInputSelectionEnd'), 'selection end preservation must remain')
  assert(renderSrc.includes('savedLobbyChatInputSelectionDirection'), 'selection direction preservation must remain')
  assert(renderSrc.includes('data-lobby-livechat-delete'), 'moderator delete wiring must remain')
  assert(controllerSrc.includes('reconcileLobbyChatSubscription()'), 'live subscription reconciliation must remain')
  assert(renderSrc.includes('font-size:16px;line-height:1.45'), 'message row font size must remain 16px with line-height 1.45')
})

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
