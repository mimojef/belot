/**
 * checkTournamentMatchesViewLayout.ts
 *
 * Кратък браузърен (Playwright/Chromium) layout тест на РЕАЛНИЯ компонент
 * renderTournamentMatchesView с контролирани данни — активни срещи + история
 * (победител, служебна победа, липсващ резултат, дълги имена). Покрива
 * визуалната част на историята без чакане на реални ботски мачове (реалният
 * поток е в server check:tournament-matches-view [I1]-[I8] и
 * checkTournamentMatchesBrowserE2E.ts).
 *
 * Usage: npx tsx scripts/checkTournamentMatchesViewLayout.ts [--screenshots=<dir>]
 */
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { renderTournamentMatchesView } from '../src/app/tournaments/renderTournamentMatchesView'

const screenshotsDir = resolve(process.argv.find((a) => a.startsWith('--screenshots='))?.slice('--screenshots='.length) ?? join(tmpdir(), 'tournament-matches-layout'))
let passed = 0
let failed = 0
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const LONG = 'МногоДългоИмеНаИграчКойтоНеБиваДаЧупиПодредбата_ПроверкаЗаМобилен'
const team = (teamId: string, names: string[]) => ({
  teamId, status: 'locked',
  members: names.map((displayName, index) => ({ entryId: `${teamId}-${index}`, profileId: `${teamId}-p${index}`, displayName, avatarUrl: null, joinedAt: '', joinedAs: 'solo' })),
})
const match = (matchId: string, teamAId: string, teamBId: string, extra: Record<string, unknown>) => ({
  matchId, roundId: `round-${matchId}`, roomId: `room-${matchId}`, teamAId, teamBId, status: 'completed', winnerTeamId: null,
  resultKind: 'played', roomReady: false, finalScoreTeamA: null, finalScoreTeamB: null, liveScoreTeamA: null, liveScoreTeamB: null,
  startedAt: null, completedAt: '2026-10-09T11:00:00.000Z', ...extra,
})
const detail: any = {
  tournamentId: 't', name: `Турнирът на Мишони — ${LONG}`, status: 'final_in_progress', viewer: { isParticipant: false },
  belotSpectatingEnabled: true, matchesLiveToken: 'x',
  teams: [
    team('a', ['Мимо', LONG]), team('b', ['Иван', 'Тодор']), team('c', ['Гошо', 'Пешо']), team('d', [LONG, 'Елена']),
    team('e', ['Алекс', 'Боби']), team('f', ['Ники', 'Стефи']), team('g', ['Влади', 'Дани']), team('h', ['Краси', 'Митко']),
  ],
  rounds: [
    { roundId: 'q1', roundType: 'quarterfinal', roundIndex: 1, matches: [match('q1', 'a', 'b', { winnerTeamId: 'a', finalScoreTeamA: 152, finalScoreTeamB: 98 })] },
    { roundId: 'q2', roundType: 'quarterfinal', roundIndex: 2, matches: [match('q2', 'c', 'd', { winnerTeamId: 'd', resultKind: 'walkover' })] },
    { roundId: 'q3', roundType: 'quarterfinal', roundIndex: 3, matches: [match('q3', 'e', 'f', { winnerTeamId: 'f' })] },
    { roundId: 'q4', roundType: 'quarterfinal', roundIndex: 4, matches: [match('q4', 'g', 'h', { winnerTeamId: 'g', resultKind: 'played_with_bots', finalScoreTeamA: 151, finalScoreTeamB: 140 })] },
    { roundId: 's1', roundType: 'semifinal', roundIndex: 1, matches: [match('s1', 'a', 'd', { winnerTeamId: 'd', finalScoreTeamA: 120, finalScoreTeamB: 163 })] },
    { roundId: 's2', roundType: 'semifinal', roundIndex: 2, matches: [match('s2', 'f', 'g', { winnerTeamId: 'f', finalScoreTeamA: 151, finalScoreTeamB: 77 })] },
    { roundId: 'f1', roundType: 'final', roundIndex: 1, matches: [match('f1', 'd', 'f', { status: 'in_progress', completedAt: null, roomReady: true, liveScoreTeamA: 82, liveScoreTeamB: 64 })] },
  ],
}

const html = `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:#050505;color:#fff;font-family:Arial,Helvetica,sans-serif;} main{padding:16px 12px;}</style>
</head><body><main>${renderTournamentMatchesView(detail)}</main></body></html>`

console.log('\n═══ checkTournamentMatchesViewLayout (Chromium) ═══')
await mkdir(screenshotsDir, { recursive: true })
const browser = await chromium.launch()
try {
  for (const viewport of [{ width: 1366, height: 900, mobile: false }, { width: 375, height: 812, mobile: true }, { width: 390, height: 844, mobile: true }]) {
    await check(`[${viewport.width}px] без хоризонтален overflow, без припокриване, четими редове`, async () => {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile, deviceScaleFactor: viewport.mobile ? 2 : 1 })
      const page = await context.newPage()
      try {
        await page.setContent(html)
        const result = await page.evaluate(() => {
          const problems: string[] = []
          const vw = window.innerWidth
          if (document.documentElement.scrollWidth > vw + 1) problems.push(`page scrollWidth ${document.documentElement.scrollWidth}>${vw}`)
          const cards = [...document.querySelectorAll<HTMLElement>('[data-tournament-live-match], [data-tournament-history-match]')]
          for (const card of cards) {
            const rect = card.getBoundingClientRect()
            if (rect.right > vw + 1) problems.push(`card beyond viewport ${rect.right}`)
            card.querySelectorAll<HTMLElement>('*').forEach((el) => {
              const r = el.getBoundingClientRect()
              if (r.width > 0 && (r.right > rect.right + 1 || r.left < rect.left - 1)) problems.push(`${el.tagName} overflows card`)
            })
            // Ред на отбор: буква | имена | резултат — не се застъпват.
            card.querySelectorAll<HTMLElement>('[aria-label^="Отбор"]').forEach((badge) => {
              const row = badge.parentElement!
              const [letter, names, score] = [...row.children].map((c) => (c as HTMLElement).getBoundingClientRect())
              if (letter!.right > names!.left + 1 || names!.right > score!.left + 1) problems.push('team row elements overlap')
              if (score!.width < 20) problems.push('score column collapsed')
            })
          }
          const columns = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().left))).size
          return {
            problems: problems.slice(0, 6), cards: cards.length, columns,
            badges: (document.body.innerText.match(/Приключила/g) ?? []).length,
            winners: (document.body.innerText.match(/Победител/gi) ?? []).length,
          }
        })
        assert(result.problems.length === 0, result.problems.join('; '))
        assert(result.cards === 7, `cards=${result.cards}`)
        assert(result.badges === 6, `Приключила badges=${result.badges}`)
        assert(result.winners === 6, `winner markers=${result.winners}`)
        if (viewport.mobile) assert(result.columns === 1, `mobile must be one column, got ${result.columns}`)
        else assert(result.columns >= 2, `desktop should use compact columns, got ${result.columns}`)
        await page.screenshot({ path: join(screenshotsDir, `layout-${viewport.width}-matches-history.png`), fullPage: true })
      } finally {
        await context.close()
      }
    })
  }
} finally {
  await browser.close()
}
console.log(`Screenshots: ${screenshotsDir}`)
if (failed > 0) {
  console.error(`checkTournamentMatchesViewLayout failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}
console.log(`checkTournamentMatchesViewLayout passed: ${passed} checks.`)
