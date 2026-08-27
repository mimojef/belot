/**
 * checkTournamentPartnerSearchTyping.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression for
 * a real browser bug: the "Търси във всички играчи" global partner search
 * input inside the "Избери партньор" modal lost focus after EVERY typed
 * character, making it impossible to type a name without re-clicking the
 * field after each keystroke.
 *
 * ROOT CAUSE (proven, not assumed): onTournamentPartnerInviteQueryChange
 * (createLobbyFlowController.ts) called the full render() on every 'input'
 * event. render() -> renderLobby() -> renderLobbyScreen(options.root, ...),
 * which unconditionally does `root.innerHTML = nextRootHtml`
 * (renderLobbyScreen.ts) — destroying and recreating the ENTIRE lobby DOM
 * subtree, including <input data-tournament-partner-query="1">, on every
 * keystroke. Unlike the two other inputs that survive this same full
 * rebuild (data-lobby-players-search, data-lobby-chat-message-input — both
 * have an explicit save-focus-before / restore-focus-after mechanism around
 * the innerHTML assignment), this new input had NO such save/restore, so
 * focus was simply lost with nothing to recover it.
 *
 * FIX (targeted patch, not a focus-restore hack): the query-change handler
 * and the debounced search's onResult no longer call render() at all.
 * renderTournamentPartnerSearchSection() was extracted out of
 * renderTournamentPartnerPickerPopup into its own pure function
 * (renderTournamentsScreen.ts), wrapped in a stable
 * <div data-tournament-partner-search-results="1"> container. A new
 * patchTournamentPartnerSearchSection() (createLobbyFlowController.ts)
 * updates ONLY that container's innerHTML and re-wires its own
 * [data-tournament-partner-invite] buttons — the <input> itself, the modal
 * chrome, the friends list, the nav bar, and the rest of the SPA are never
 * touched. Since the browser already reflects what the user typed in the
 * input's own value natively (no re-render needed to show it), and the
 * <input> DOM node is never replaced, focus/caret survive automatically —
 * no explicit save/restore, no setTimeout, no .focus() call anywhere in
 * the fix.
 *
 * This test drives the REAL createLobbyFlowController + REAL DOM through a
 * fixture harness (scripts/fixtures/tournamentPartnerSearchTypingHarness.ts):
 * opens the picker via a real button click, types character-by-character
 * via real 'input' event dispatches (mirroring what a real keystroke
 * produces), and asserts DOM node identity (a stamped per-node marker,
 * re-read after every keystroke) plus document.activeElement — not just
 * "the value looks right".
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

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

type H = {
  openPicker: () => Promise<void>
  typeChar: (char: string) => Promise<void>
  backspace: () => Promise<void>
  flush: () => Promise<void>
  flushPastDebounce: () => Promise<void>
  getInputValue: () => Promise<string | null>
  getInputElementId: () => Promise<string | null>
  isInputFocused: () => Promise<boolean>
  getSearchResultsHtml: () => Promise<string | null>
  domHasFriendsSection: () => Promise<boolean>
  domHasFriendRow: (profileId: string) => Promise<boolean>
  getPendingSearchQueries: () => Promise<string[]>
  getSearchCallCount: () => Promise<number>
  resolvePendingSearch: (query: string | null, candidates: unknown[]) => Promise<boolean>
  clickSearchResultInvite: (profileId: string) => Promise<void>
  getLastInviteSubmittedProfileId: () => Promise<string | null>
  reset: () => Promise<void>
}

async function harness(page: Page): Promise<H> {
  const w = '__tournamentPartnerSearchTypingHarness'
  return {
    openPicker: () => page.evaluate((k: any) => (window as any)[k].openPicker(), w),
    typeChar: (char) => page.evaluate(([k, c]: any) => (window as any)[k].typeChar(c), [w, char] as any),
    backspace: () => page.evaluate((k: any) => (window as any)[k].backspace(), w),
    flush: () => page.evaluate((k: any) => (window as any)[k].flush(), w),
    flushPastDebounce: () => page.evaluate((k: any) => (window as any)[k].flushPastDebounce(), w),
    getInputValue: () => page.evaluate((k: any) => (window as any)[k].getInputValue(), w),
    getInputElementId: () => page.evaluate((k: any) => (window as any)[k].getInputElementId(), w),
    isInputFocused: () => page.evaluate((k: any) => (window as any)[k].isInputFocused(), w),
    getSearchResultsHtml: () => page.evaluate((k: any) => (window as any)[k].getSearchResultsHtml(), w),
    domHasFriendsSection: () => page.evaluate((k: any) => (window as any)[k].domHasFriendsSection(), w),
    domHasFriendRow: (profileId) => page.evaluate(([k, p]: any) => (window as any)[k].domHasFriendRow(p), [w, profileId] as any),
    getPendingSearchQueries: () => page.evaluate((k: any) => (window as any)[k].getPendingSearchQueries(), w),
    getSearchCallCount: () => page.evaluate((k: any) => (window as any)[k].getSearchCallCount(), w),
    resolvePendingSearch: (query, candidates) => page.evaluate(([k, q, c]: any) => (window as any)[k].resolvePendingSearch(q, c), [w, query, candidates] as any),
    clickSearchResultInvite: (profileId) => page.evaluate(([k, p]: any) => (window as any)[k].clickSearchResultInvite(p), [w, profileId] as any),
    getLastInviteSubmittedProfileId: () => page.evaluate((k: any) => (window as any)[k].getLastInviteSubmittedProfileId(), w),
    reset: () => page.evaluate((k: any) => (window as any)[k].reset(), w),
  }
}

console.log('\n═══ checkTournamentPartnerSearchTyping ═══\n')

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

  browser = await chromium.launch()
  const baseUrl = `http://127.0.0.1:${port}`

  const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 480, height: 900 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/scripts/fixtures/tournamentPartnerSearchTypingHarness.html')
  const h = await harness(page)
  await h.openPicker()
  await h.flush()

  // --- A: Typing stability — DOM node identity + focus survive every keystroke ---
  let stableNodeId: string | null = null
  await check('[A] typing "M","i","m","o" one at a time never replaces the <input> DOM node or steals focus', async () => {
    stableNodeId = await h.getInputElementId()
    assert(stableNodeId !== null, 'input not found after opening picker')
    for (const char of ['M', 'i', 'm', 'o']) {
      await h.typeChar(char)
      const nodeId = await h.getInputElementId()
      assert(nodeId === stableNodeId, `input DOM node was replaced after typing "${char}" (node id changed: ${stableNodeId} -> ${nodeId})`)
      assert((await h.isInputFocused()) === true, `input lost focus after typing "${char}"`)
    }
    assert((await h.getInputValue()) === 'Mimo', `expected input value 'Mimo', got '${await h.getInputValue()}'`)
    // The debounce (300ms) coalesces the 4 keystrokes above into a SINGLE
    // scheduled search for the final value ("mimo") — only visible once we
    // wait past the debounce window, not immediately after the last keystroke.
    await h.flushPastDebounce()
    const pending = await h.getPendingSearchQueries()
    assert(pending.includes('Mimo'), `expected the debounced search to fire for 'Mimo', got ${JSON.stringify(pending)}`)
  })

  // --- B: search result arrival does not disturb the input ---
  await check('[B] async search result arriving mid-session does not replace the input node or steal focus', async () => {
    await h.resolvePendingSearch('Mimo', [
      { profileId: 'mimo-1', displayName: 'Mimo123', avatarUrl: null, online: true, eligible: true, unavailableReason: null },
    ])
    await h.flush()
    const nodeId = await h.getInputElementId()
    assert(nodeId === stableNodeId, 'input DOM node was replaced when the search result arrived')
    assert((await h.isInputFocused()) === true, 'input lost focus when the search result arrived')
    assert((await h.getInputValue()) === 'Mimo', 'input value changed unexpectedly when the search result arrived')
    const html = await h.getSearchResultsHtml()
    assert(html !== null && html.includes('Mimo123'), `search results region does not show the arrived result: ${html}`)
  })

  // --- C: no-results state renders without disturbing the input ---
  await check('[C] "Няма намерени играчи." renders without touching the input node/focus', async () => {
    await h.backspace()
    await h.typeChar('x')
    await h.flushPastDebounce()
    const pending = await h.getPendingSearchQueries()
    assert(pending.includes('Mimx'), `expected a debounced search for 'Mimx', got ${JSON.stringify(pending)}`)
    await h.resolvePendingSearch('Mimx', [])
    await h.flush()
    const nodeId = await h.getInputElementId()
    assert(nodeId === stableNodeId, 'input DOM node was replaced on the no-results response')
    assert((await h.isInputFocused()) === true, 'input lost focus on the no-results response')
    const html = await h.getSearchResultsHtml()
    assert(html !== null && html.includes('Няма намерени играчи.'), `expected the no-results message, got: ${html}`)
  })

  // --- D: rapid typing — stale response protection ---
  await check('[D] a stale ("Mi") response arriving after a newer ("Mimo") query does not overwrite the newer results', async () => {
    // Reset the query to a clean slate for this scenario.
    for (let i = 0; i < 10; i++) await h.backspace()
    await h.typeChar('M')
    await h.typeChar('i')
    // Let the "mi" search actually become IN-FLIGHT (past its own debounce)
    // before typing more — otherwise the debounce would simply cancel it
    // outright and only "mimo" would ever be scheduled, which would not
    // exercise the stale-response guard at all.
    await h.flushPastDebounce()
    const afterMi = await h.getPendingSearchQueries()
    assert(afterMi.includes('Mi'), `expected an in-flight search for 'Mi', got ${JSON.stringify(afterMi)}`)
    await h.typeChar('m')
    await h.typeChar('o')
    await h.flushPastDebounce()
    const afterMimo = await h.getPendingSearchQueries()
    assert(afterMimo.includes('Mimo'), `expected a second in-flight search for 'Mimo', got ${JSON.stringify(afterMimo)}`)
    assert(afterMimo.includes('Mi'), `the still-in-flight 'Mi' request should remain pending (not cancelled) until it resolves, got ${JSON.stringify(afterMimo)}`)

    // Resolve the NEWER query first (as if the older one is slow/in-flight).
    await h.resolvePendingSearch('Mimo', [
      { profileId: 'newer-result', displayName: 'NewerResult', avatarUrl: null, online: true, eligible: true, unavailableReason: null },
    ])
    await h.flush()
    // Now the STALE 'Mi' response arrives late.
    await h.resolvePendingSearch('Mi', [
      { profileId: 'stale-result', displayName: 'StaleResult', avatarUrl: null, online: true, eligible: true, unavailableReason: null },
    ])
    await h.flush()

    const html = await h.getSearchResultsHtml()
    assert(html !== null && html.includes('NewerResult'), `expected the newer result to remain visible, got: ${html}`)
    assert(html !== null && !html.includes('StaleResult'), `stale response overwrote the newer results: ${html}`)
  })

  // --- E: friends section stays present and stable throughout ---
  await check('[E] friends section remains present and unaffected by typing/search', async () => {
    assert((await h.domHasFriendsSection()) === true, 'Приятели section disappeared during search interaction')
    assert((await h.domHasFriendRow('friend-1')) === true, 'friend-1 row disappeared during search interaction')
    assert((await h.domHasFriendRow('friend-2')) === true, 'friend-2 row disappeared during search interaction')
  })

  // --- F: selecting a global search result still triggers the existing invite flow ---
  await check('[F] clicking a global search result invokes the same tournament partner invite flow', async () => {
    await h.clickSearchResultInvite('newer-result')
    await h.flush()
    assert((await h.getLastInviteSubmittedProfileId()) === 'newer-result', 'invite was not submitted for the clicked global search result')
  })

  await check('Няма JS грешки в конзолата през целия сценарий', () => {
    assert(errors.length === 0, `console errors: ${errors.join('; ')}`)
  })

  await context.close()

  console.log('\n' + '═'.repeat(64))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exit(1)
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}
