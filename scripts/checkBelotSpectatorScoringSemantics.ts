/**
 * checkBelotSpectatorScoringSemantics.ts
 *
 * Phase 5A (D11) — spectator scoring / match-ended семантика. Real browser
 * (Playwright), real production код (createActiveRoomFlowController +
 * renderScoreHud / renderScoringPanel / renderMatchEndedScreen) през
 * activeRoomSpectatorHarness.ts, synthetic snapshots.
 *
 * Participant (controlledSeat !== null) — local-team семантика непроменена.
 * Spectator (controlledSeat === null) — няма local team: ОТБОР А / ОТБОР Б
 * (authoritative teamA/teamB), без НИЕ/ВИЕ/„ТИ“, без participant countdown.
 *
 *   [S1] participant HUD: НИЕ / ВИЕ остава (seated right -> НИЕ = teamB точки)
 *   [S2] spectator HUD: ОТБОР А / ОТБОР Б
 *   [S3] spectator HUD: без „ТИ“ (и при незает bid owner fallback)
 *   [S4] spectator HUD: teamA вляво, teamB вдясно — не се разменят
 *   [S5] participant scoring: НИЕ / ВИЕ и (НИЕ)/(ВИЕ) heading остават
 *   [S6] spectator round scoring: ОТБОР А / ОТБОР Б колони с teamA/teamB стойности
 *   [S7] contract heading: authoritative отбор на обявилия (A и B)
 *   [S8] spectator scoring HTML: без НИЕ / ВИЕ
 *   [M1] Team A печели -> ПОБЕДИТЕЛ: ОТБОР А
 *   [M2] Team B печели -> ПОБЕДИТЕЛ: ОТБОР Б
 *   [M3] spectator: без local win/loss (ГУБЕЩ / Ние / Вие)
 *   [M4] spectator: без „ТИ“
 *   [M5] spectator: без participant countdown; leave votes не armват auto-leave
 *   [M6] participant: countdown и ПОБЕДИТЕЛ/ГУБЕЩ остават
 *   [M7] spectator: без rating/replay/prize/leave controls
 *   [M8] mobile spectator match-ended: team-based label без overflow
 *   [R1] source review: spectator branch-овете не съдържат НИЕ/ВИЕ/ТИ; countdown-ът
 *        и auto-leave-ът са participant-only
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(150)
  }
  throw new Error('waitUntil: timed out')
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

type H = any

async function call<T>(page: Page, fn: (h: H, arg: any) => T, arg: any = undefined): Promise<T> {
  return page.evaluate(
    ({ fn: fnStr, arg: a }) => {
      const h = (window as any).__activeRoomSpectatorHarness
      // eslint-disable-next-line no-eval
      const resolved = (0, eval)(fnStr) as (h: H, arg: any) => T
      return resolved(h, a)
    },
    { fn: fn.toString(), arg },
  )
}

const LOCAL_TEAM_WORDS = /(^|[^А-Яа-я])(НИЕ|ВИЕ|Ние|Вие|ТИ|ГУБЕЩ)([^А-Яа-я]|$)/

console.log('\ncheckBelotSpectatorScoringSemantics\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/activeRoomSpectatorHarness.html`
  browser = await chromium.launch()

  async function newPage(viewport = { width: 1280, height: 900 }, mobile = false): Promise<Page> {
    const context = await browser!.newContext(mobile ? { viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__activeRoomSpectatorHarness !== undefined, undefined, { timeout: 10_000 })
    ;(page as any).__pageErrors = pageErrors
    return page
  }
  function assertNoPageErrors(page: Page, label: string): void {
    const errors = (page as any).__pageErrors as string[]
    assert(errors.length === 0, `${label}: unexpected page errors: ${errors.join(' | ')}`)
  }

  // Асиметрични точки, за да се хване всяка размяна A/B.
  const HUD_SCORE = { match: { teamA: 37, teamB: 12 } }

  // ── HUD ────────────────────────────────────────────────────────────────
  await check('[S1] participant HUD: НИЕ / ВИЕ stays (seated right -> НИЕ shows teamB)', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsParticipant('room-s1', 'right'))
    await call(page, (h: H, s: unknown) => h.applyParticipantSnapshot('room-s1', h.biddingGame({ score: s }), h.makeSeats(), 'right'), HUD_SCORE)
    await waitUntil(() => call(page, (h: H) => h.scoreHudColumns() !== null))
    const columns = await call(page, (h: H) => h.scoreHudColumns())
    assertEqual(JSON.stringify(columns), JSON.stringify([{ label: 'НИЕ', score: '12' }, { label: 'ВИЕ', score: '37' }]), 'participant columns')
    assertNoPageErrors(page, 'S1')
    await page.close()
  })

  {
    const page = await newPage()
    // Bid owner е НЕЗАЕТО място (fallback label) -> проверява и „ТИ“ fallback-а.
    const seats = await call(page, (h: H) => h.makeSeats().map((s: any) => (s.seat === 'bottom' ? { ...s, isOccupied: false, displayName: '' } : s)))
    const game = await call(page, (h: H, s: unknown) => h.playingGame({ score: s }), HUD_SCORE)
    await call(page, (h: H, a: [unknown, unknown]) => h.enterAsSpectator('room-s2', a[0], a[1]), [game, seats])
    await waitUntil(() => call(page, (h: H) => h.scoreHudColumns() !== null))

    await check('[S2] spectator HUD: ОТБОР А / ОТБОР Б', async () => {
      const columns = await call(page, (h: H) => h.scoreHudColumns())
      assertEqual(columns![0]!.label, 'ОТБОР А', 'left label')
      assertEqual(columns![1]!.label, 'ОТБОР Б', 'right label')
    })

    await check('[S3] spectator HUD: no „ТИ“ / НИЕ / ВИЕ (incl. unoccupied bid-owner fallback)', async () => {
      const text = await call(page, (h: H) => h.scoreHudText())
      assert(!LOCAL_TEAM_WORDS.test(text), `HUD text: ${text}`)
      assert(text.includes('ОТБОР А'), `bid owner fallback is team-based: ${text}`)
    })

    await check('[S4] spectator HUD: teamA left, teamB right (never swapped by perspective)', async () => {
      const columns = await call(page, (h: H) => h.scoreHudColumns())
      assertEqual(columns![0]!.score, '37', 'ОТБОР А = teamA')
      assertEqual(columns![1]!.score, '12', 'ОТБОР Б = teamB')
    })

    assertNoPageErrors(page, 'spectator HUD')
    await page.close()
  }

  // ── Round scoring ──────────────────────────────────────────────────────
  // rawHandPoints teamA=90/teamB=72; scoringGame winningBid.seat = bottom (Team A).
  await check('[S5] participant scoring (seated right): НИЕ/ВИЕ columns + (ВИЕ) heading for a Team A contract', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsParticipant('room-s5', 'right'))
    await call(page, (h: H) => h.applyParticipantSnapshot('room-s5', h.scoringGame(), h.makeSeats(), 'right'))
    await waitUntil(() => call(page, (h: H) => h.scoringPanelText().length > 0))
    const text = await call(page, (h: H) => h.scoringPanelText())
    assert(/ВСИЧКО КОЗ\s*\(ВИЕ\)/.test(text), `heading: ${text.split('\n')[0]}`)
    const header = text.split('\n').map((s) => s.trim()).filter(Boolean)
    const nie = header.indexOf('НИЕ')
    const vie = header.indexOf('ВИЕ', nie + 1)
    assert(nie !== -1 && vie > nie, `НИЕ before ВИЕ columns: ${header.slice(0, 6).join('|')}`)
    assertNoPageErrors(page, 'S5')
    await page.close()
  })

  for (const [label, bidSeat, expectedTeam] of [
    ['[S6/S7/S8] spectator scoring: ОТБОР А/ОТБОР Б columns, (ОТБОР А) heading for a Team A contract, no НИЕ/ВИЕ', 'bottom', 'ОТБОР А'],
    ['[S7b] spectator scoring: (ОТБОР Б) heading for a Team B contract', 'right', 'ОТБОР Б'],
  ] as const) {
    await check(label, async () => {
      const page = await newPage()
      const game = await call(page, (h: H, seat: string) => {
        const g = h.scoringGame()
        return { ...g, scoring: { ...g.scoring, winningBid: { ...g.scoring.winningBid, seat } } }
      }, bidSeat)
      await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-s6', g), game)
      await waitUntil(() => call(page, (h: H) => h.scoringPanelText().length > 0))
      const text = await call(page, (h: H) => h.scoringPanelText())
      assert(new RegExp(`ВСИЧКО КОЗ\\s*\\(${expectedTeam}\\)`).test(text), `heading: ${text.split('\n').slice(0, 2).join(' ')}`)
      assert(!LOCAL_TEAM_WORDS.test(text), `scoring text contains local-team words: ${text}`)
      const lines = text.split('\n').map((s) => s.trim()).filter(Boolean)
      const a = lines.indexOf('ОТБОР А')
      const b = lines.indexOf('ОТБОР Б', a + 1)
      assert(a !== -1 && b > a, `ОТБОР А before ОТБОР Б columns: ${lines.slice(0, 6).join('|')}`)
      // Ръце: teamA 90 вляво, teamB 72 вдясно.
      const hands = lines.findIndex((l) => l.toUpperCase() === 'РЪЦЕ')
      const after = lines.slice(hands + 1, hands + 5).join(' ')
      assert(hands !== -1 && after.indexOf('90') !== -1 && after.indexOf('90') < after.indexOf('72'), `Ръце row teamA then teamB: ${after}`)
      const hud = await call(page, (h: H) => h.scoreHudText())
      assert(!LOCAL_TEAM_WORDS.test(hud), `scoring HUD: ${hud}`)
      assertNoPageErrors(page, label)
      await page.close()
    })
  }

  // ── Match ended ────────────────────────────────────────────────────────
  for (const [label, winnerTeam, finalScore, expected] of [
    ['[M1/M3/M4/M5/M7] Team A wins: ПОБЕДИТЕЛ: ОТБОР А, team columns, no local words, no countdown, no participant controls', 'A', { teamA: 171, teamB: 167 }, 'ПОБЕДИТЕЛ: ОТБОР А'],
    ['[M2] Team B wins: ПОБЕДИТЕЛ: ОТБОР Б', 'B', { teamA: 140, teamB: 152 }, 'ПОБЕДИТЕЛ: ОТБОР Б'],
  ] as const) {
    await check(label, async () => {
      const page = await newPage()
      const game = await call(page, (h: H, a: [string, unknown]) => {
        const g = h.matchEndedGame()
        return { ...g, score: { match: a[1] }, matchEnded: { ...g.matchEnded, winnerTeam: a[0], finalScore: a[1], leaveVotes: ['right'] } }
      }, [winnerTeam, finalScore])
      await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-m', g), game)
      await waitUntil(() => call(page, (h: H) => h.matchEndedInfo().text.length > 0))
      const info = await call(page, (h: H) => h.matchEndedInfo())
      assert(info.text.includes(expected), `result: ${info.text.split('\n')[0]}`)
      assert(!LOCAL_TEAM_WORDS.test(info.text), `local win/loss words: ${info.text}`)
      assert(/ОТБОР А[\s\S]*ОТБОР Б/.test(info.text), 'Отбор А column before Отбор Б')
      const lines = info.text.split('\n').map((s) => s.trim())
      const aIdx = lines.findIndex((l) => l === 'ОТБОР А')
      assert(aIdx !== -1 && lines.slice(aIdx, aIdx + 3).includes(String(finalScore.teamA)), `ОТБОР А score ${finalScore.teamA}: ${lines.slice(aIdx, aIdx + 3)}`)
      assertEqual(info.hasCountdown, false, 'no participant countdown (even with leave votes)')
      assertEqual(await call(page, (h: H) => h.hasMatchEndedActionButtons()), false, 'no replay/lobby/new-game buttons')
      assertEqual(await call(page, (h: H) => h.hasPrizeCounter()), false, 'no prize counter')
      assertEqual(await page.locator('[data-partner-rating-star], [data-match-ended-partner-rating]').count(), 0, 'no partner rating')
      await sleep(1_200)
      const calls = await call(page, (h: H) => h.getCalls())
      assert(!calls.some((c: any) => c.name === 'leaveActiveRoom' || c.name === 'showLobby'), `no auto-leave: ${calls.map((c: any) => c.name).join(',')}`)
      assertEqual(await call(page, (h: H) => h.hasActiveRoomFn()), true, 'spectator view stays until the server ends it')
      assertNoPageErrors(page, label)
      await page.close()
    })
  }

  await check('[M6] participant match-ended: countdown + ПОБЕДИТЕЛ/ГУБЕЩ + Ние/Вие unchanged', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsParticipant('room-m6', 'bottom'))
    await call(page, (h: H) => {
      const g = h.matchEndedGame()
      return h.applyParticipantSnapshot('room-m6', { ...g, matchEnded: { ...g.matchEnded, winnerTeam: 'B', finalScore: { teamA: 140, teamB: 152 } } })
    })
    await waitUntil(() => call(page, (h: H) => h.matchEndedInfo().text.length > 0))
    const info = await call(page, (h: H) => h.matchEndedInfo())
    assert(info.text.includes('ГУБЕЩ'), `participant Team A loses -> ГУБЕЩ: ${info.text.split('\n')[0]}`)
    assert(/НИЕ[\s\S]*ВИЕ/i.test(info.text), 'Ние before Вие')
    assertEqual(info.hasCountdown, true, 'participant countdown still rendered')
    assert(/1[12]\dс/.test(info.text), `countdown ~120с: ${info.text}`)
    assertEqual(await call(page, (h: H) => h.hasMatchEndedActionButtons()), true, 'participant controls still rendered')
    assertNoPageErrors(page, 'M6')
    await page.close()
  })

  await check('[M8] mobile spectator match-ended: team-based label fits without overflow', async () => {
    const page = await newPage({ width: 390, height: 844 }, true)
    const game = await call(page, (h: H) => h.matchEndedGame())
    await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-m8', g), game)
    await waitUntil(() => call(page, (h: H) => h.matchEndedInfo().text.length > 0))
    const info = await call(page, (h: H) => h.matchEndedInfo())
    assert(info.text.includes('ПОБЕДИТЕЛ: ОТБОР А'), `mobile result: ${info.text.split('\n')[0]}`)
    assert(!LOCAL_TEAM_WORDS.test(info.text), `mobile local words: ${info.text}`)
    assertEqual(info.hasCountdown, false, 'no countdown on mobile')
    assertEqual(info.overflow, false, 'no horizontal overflow')
    assertNoPageErrors(page, 'M8')
    await page.close()
  })

  // ── Source review ──────────────────────────────────────────────────────
  await check('[R1] source review: spectator branches have no НИЕ/ВИЕ/ТИ; countdown + auto-leave are participant-only', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const read = async (rel: string) => (await readFile(join(here, '..', ...rel.split('/')), 'utf8')).replace(/\r\n/g, '\n')
    const between = (src: string, start: string, end: string) => {
      const a = src.indexOf(start)
      assert(a !== -1, `marker: ${start}`)
      const b = src.indexOf(end, a + start.length)
      assert(b !== -1, `end marker after ${start}: ${end}`)
      return src.slice(a, b)
    }
    const hud = await read('src/app/activeRoom/renderScoreHud.ts')
    const hudSpectator = between(hud, 'if (controlledSeat === null) {\n    return {', '}\n  }')
    assert(hudSpectator.includes("'ОТБОР А'") && hudSpectator.includes("'ОТБОР Б'") && !LOCAL_TEAM_WORDS.test(hudSpectator), 'HUD spectator columns')
    assert(/if \(controlledSeat === null\) return isTeamASeat\(seat\) \? 'ОТБОР А' : 'ОТБОР Б'\n  const visualSeat/.test(hud), 'HUD seat fallback returns before the „ТИ“ branch for spectator')

    const scoring = await read('src/app/activeRoom/renderScoringPanel.ts')
    const ownerSpectator = between(scoring, '  if (controlledSeat === null) {\n    return isTeamASeat(winningBid.seat)', '}\n')
    assert(!LOCAL_TEAM_WORDS.test(ownerSpectator), 'scoring bid owner spectator branch')
    assert(scoring.includes("? { left: 'ОТБОР А', right: 'ОТБОР Б' }\n    : { left: 'НИЕ', right: 'ВИЕ' }"), 'scoring column labels: spectator first, participant fallback')
    assert(scoring.includes("return controlledSeat === null ? 'bottom' : localSeat"), 'spectator columns anchored to Team A, not perspective')

    const ended = await read('src/app/activeRoom/renderMatchEndedScreen.ts')
    const endedSpectator = between(ended, '  if (controlledSeat === null) {\n    return {\n      resultLabel', '  }\n  const localTeam')
    assert(!LOCAL_TEAM_WORDS.test(endedSpectator), 'match-ended spectator branch')
    const countdownBlocks = ended.split('data-match-ended-countdown="1"').length - 1
    const guardedCountdowns = (ended.match(/\$\{controlledSeat !== null \? `\n        <div style="display:flex;justify-content:flex-end;(?:margin-top:14px;)?">\n          <div\n            data-match-ended-countdown="1"/g) ?? []).length
    assertEqual(guardedCountdowns, countdownBlocks, 'every countdown element is participant-only')

    const controller = await read('src/app/activeRoom/createActiveRoomFlowController.ts')
    assert(controller.includes('if (isParticipantMatchEnded) startMatchEndedCountdown()'), 'countdown armed only for participants')
    assert(controller.includes('if (isParticipantMatchEnded && matchEndedCountdownSeconds <= 0) {'), 'auto-leave only for participants')
    assert(controller.includes('if (isParticipantMatchEnded && leaveVotes.length > 0'), 'leave-vote shortening only for participants')
  })
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
process.exit(0)
