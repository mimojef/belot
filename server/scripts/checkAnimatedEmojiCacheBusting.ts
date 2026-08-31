/**
 * checkAnimatedEmojiCacheBusting.ts
 *
 * Проверява fix-а за production caching проблема с animated emoji assets:
 * nginx сервира /assets/animated-emoji/*.webp и preview/*.png с
 * Cache-Control: public, max-age=86400, а подмяна на файл със същото име
 * оставяше браузъра да продължава да показва стар кеширан asset.
 *
 * Fix: централизиран helper (src/app/animatedEmoji/animatedEmojiAssets.ts)
 * добавя ?v=<CURRENT_BUILD_ID> към всеки animated emoji и preview URL.
 * CURRENT_BUILD_ID идва от src/buildId.ts (__PWA_BUILD_ID__, дефиниран в
 * vite.config.ts от git SHA/VITE_BUILD_ID) — същият build-id механизъм,
 * ползван вече от PWA update flow-а, не нов паралелен механизъм.
 *
 * Изпълнява се в Node.js чрез tsx, без build/dev server.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const ASSETS_HELPER_PATH = join(REPO_ROOT, 'src', 'app', 'animatedEmoji', 'animatedEmojiAssets.ts')
const BUILD_ID_PATH = join(REPO_ROOT, 'src', 'buildId.ts')
const PWA_PATH = join(REPO_ROOT, 'src', 'pwa.ts')
const LOBBY_RENDER_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'renderLobbyScreen.ts')
const ACTIVE_ROOM_CONTROLLER_PATH = join(REPO_ROOT, 'src', 'app', 'activeRoom', 'createActiveRoomFlowController.ts')
const CUTTING_SEAT_PANELS_PATH = join(REPO_ROOT, 'src', 'app', 'activeRoom', 'cutting', 'renderCuttingSeatPanels.ts')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: string): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err))
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

console.log('\n=== Animated Emoji Cache Busting Checks ===\n')

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

const assetsHelperSrc = normalizeLineEndings(await readFile(ASSETS_HELPER_PATH, 'utf8'))
const buildIdSrc = normalizeLineEndings(await readFile(BUILD_ID_PATH, 'utf8'))
const pwaSrc = normalizeLineEndings(await readFile(PWA_PATH, 'utf8'))
const lobbyRenderSrc = normalizeLineEndings(await readFile(LOBBY_RENDER_PATH, 'utf8'))
const activeRoomControllerSrc = normalizeLineEndings(await readFile(ACTIVE_ROOM_CONTROLLER_PATH, 'utf8'))
const cuttingSeatPanelsSrc = normalizeLineEndings(await readFile(CUTTING_SEAT_PANELS_PATH, 'utf8'))

// ─── A) Real behavior of the helper functions ───────────────────────────────

;(globalThis as unknown as { __PWA_BUILD_ID__: string }).__PWA_BUILD_ID__ = 'test-build-abc123'

const { getAnimatedEmojiUrl, getAnimatedEmojiPreviewUrl } = await import(pathToFileURL(ASSETS_HELPER_PATH).href)

await check('[A1] getAnimatedEmojiUrl appends the current build id as a version query param', () => {
  const url = getAnimatedEmojiUrl('21')
  assert(url === '/assets/animated-emoji/emoji-21.webp?v=test-build-abc123', `unexpected url: ${url}`)
})

await check('[A2] getAnimatedEmojiPreviewUrl appends the current build id as a version query param', () => {
  const url = getAnimatedEmojiPreviewUrl('21')
  assert(
    url === '/assets/animated-emoji/preview/preview-emoji-21.png?v=test-build-abc123',
    `unexpected url: ${url}`,
  )
})

await check('[A3] no hardcoded special case for emoji 21 — works identically for any emoji id', () => {
  const url01 = getAnimatedEmojiUrl('01')
  const url24 = getAnimatedEmojiUrl('24')
  assert(url01 === '/assets/animated-emoji/emoji-01.webp?v=test-build-abc123', `unexpected url: ${url01}`)
  assert(url24 === '/assets/animated-emoji/emoji-24.webp?v=test-build-abc123', `unexpected url: ${url24}`)
})

await check('[A4] the version token changes between different build identifiers', () => {
  // CURRENT_BUILD_ID is Vite's build-time __PWA_BUILD_ID__ define (git SHA
  // or VITE_BUILD_ID), frozen into that specific build's JS output — a
  // running tab never "switches" build ids mid-session. What must hold is
  // that the helper's ?v= suffix is a direct, unconditional echo of
  // CURRENT_BUILD_ID (not a hardcoded literal), so that two different
  // deploys — each with their own frozen build id — necessarily produce two
  // different asset URLs. Assert that structural property directly against
  // the source, rather than against a single sampled runtime value.
  assert(
    /return `\/assets\/animated-emoji\/emoji-\$\{emojiId\}\.webp\?v=\$\{CURRENT_BUILD_ID\}`/.test(assetsHelperSrc),
    'getAnimatedEmojiUrl must interpolate CURRENT_BUILD_ID directly into the ?v= query param',
  )
  assert(
    /return `\/assets\/animated-emoji\/preview\/preview-emoji-\$\{emojiId\}\.png\?v=\$\{CURRENT_BUILD_ID\}`/.test(assetsHelperSrc),
    'getAnimatedEmojiPreviewUrl must interpolate CURRENT_BUILD_ID directly into the ?v= query param',
  )
  // Cross-check against the already-observed runtime values from A1/A2: for
  // the single build id loaded in this process (test-build-abc123), both
  // helpers must have echoed exactly that id.
  assert(getAnimatedEmojiUrl('21').includes('test-build-abc123'), 'runtime url did not carry the loaded build id')
  assert(getAnimatedEmojiPreviewUrl('21').includes('test-build-abc123'), 'runtime preview url did not carry the loaded build id')
})

// ─── B) Source-text checks: no leftover un-versioned URLs, single source of truth ──

await check('[B1] animatedEmojiAssets.ts is the single place constructing animated-emoji URLs with ?v=', () => {
  assert(assetsHelperSrc.includes('getAnimatedEmojiUrl'), 'must export getAnimatedEmojiUrl')
  assert(assetsHelperSrc.includes('getAnimatedEmojiPreviewUrl'), 'must export getAnimatedEmojiPreviewUrl')
  assert(assetsHelperSrc.includes('?v=${CURRENT_BUILD_ID}'), 'urls must be suffixed with ?v=${CURRENT_BUILD_ID}')
})

await check('[B2] build id reuses the existing PWA build-id mechanism, not a second one', () => {
  assert(buildIdSrc.includes('__PWA_BUILD_ID__'), 'buildId.ts must read the existing __PWA_BUILD_ID__ define')
  assert(assetsHelperSrc.includes("from '../../buildId'"), 'animatedEmojiAssets.ts must import CURRENT_BUILD_ID from buildId.ts')
  assert(pwaSrc.includes("from './buildId'"), 'pwa.ts must re-export CURRENT_BUILD_ID from buildId.ts, not redefine it')
})

await check('[B3] no remaining un-versioned animated-emoji URL literals in call sites', () => {
  const rawUrlPattern = /\/assets\/animated-emoji\/(?:preview\/)?(?:emoji-|preview-emoji-)\$?\{?[\w.]*\}?\.(?:webp|png)(?!\?)/
  for (const [label, src] of [
    ['renderLobbyScreen.ts', lobbyRenderSrc],
    ['createActiveRoomFlowController.ts', activeRoomControllerSrc],
    ['renderCuttingSeatPanels.ts', cuttingSeatPanelsSrc],
  ] as const) {
    const strippedOfHelperCalls = src
      .replace(/getAnimatedEmojiUrl\([^)]*\)/g, '')
      .replace(/getAnimatedEmojiPreviewUrl\([^)]*\)/g, '')
    assert(
      !rawUrlPattern.test(strippedOfHelperCalls),
      `${label} still constructs an animated-emoji URL without going through the shared helper`,
    )
  }
})

await check('[B4] all three call-site files import the shared helper instead of hand-building URLs', () => {
  assert(lobbyRenderSrc.includes('animatedEmojiAssets'), 'renderLobbyScreen.ts must import the shared helper')
  assert(activeRoomControllerSrc.includes('animatedEmojiAssets'), 'createActiveRoomFlowController.ts must import the shared helper')
  assert(cuttingSeatPanelsSrc.includes('animatedEmojiAssets'), 'renderCuttingSeatPanels.ts must import the shared helper')
})

await check('[B5] the game-reaction emoji bubble (played during a live game) uses the versioned helper', () => {
  assert(
    cuttingSeatPanelsSrc.includes('getAnimatedEmojiUrl(bubble.emojiId)'),
    'the in-game emoji reaction bubble must resolve its image src through getAnimatedEmojiUrl',
  )
})

console.log(`\nPassed: ${passed}, Failed: ${failed}`)
if (failed > 0) {
  process.exit(1)
}
