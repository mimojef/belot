/**
 * checkProductionShadowTraceReadiness.ts
 *
 * Deploy-READINESS gate for the production-safe shadow observation trace mode
 * (server/src/ai/localAiCardShadowTrace.ts, LOCAL_AI_CARD_SHADOW_TRACE_ENABLED).
 * This script does NOT deploy, does NOT SSH, does NOT touch production .env —
 * it only verifies local invariants and prints the recommended production env
 * values + disk-safety commands for a human operator to use during an actual
 * deploy (see docs/production-shadow-trace-runbook.md for the full procedure).
 *
 * Checks:
 *  1. .gitignore safety — training-output/, the shadow trace path, and the
 *     training-recorder-audit-*.tar.gz archive pattern are all git-ignored
 *     (verified via `git check-ignore`, not by hand-parsing glob patterns).
 *  2. Env/default behavior expectations — static source checks confirming
 *     LOCAL_AI_CARD_SHADOW_TRACE_ENABLED defaults to false/unset,
 *     LOCAL_AI_CARD_SHADOW_TRACE_PATH has a safe default, and the shadow
 *     early-return guard does not require LOCAL_AI_CARD_BETA_ENABLED — PLUS
 *     one live, executable proof (not just a text search) that shadow trace
 *     writes correctly with the beta flag completely unset.
 *  3.+4. Trace writer safety / behavior safety — delegated to
 *     `npm run check:local-ai-shadow-trace` (already covers this in depth:
 *     fail-safe writer, invalid suggestions=0, forced never fires, final
 *     card always conventional) rather than re-implementing it here.
 *  5.+6. Runbook completeness — docs/production-shadow-trace-runbook.md
 *     exists and mentions the right ON/OFF env flags and disk-safety
 *     commands; this script also prints the same operational notes to the
 *     console for a quick copy-paste reference.
 *
 * Не пипа production .env, не прави network/SSH/deploy.
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  pickServerBotPlayCardWithAiCandidate,
  resetLocalAiCardBetaModelCacheForTests,
  resetLocalAiCardBetaTraceStateForTests,
} from '../src/ai/localAiCardBeta.js'
import { resetLocalAiCardShadowTraceStateForTests } from '../src/ai/localAiCardShadowTrace.js'
import type {
  ServerAuthoritativeGameState,
  ServerCard,
  ServerPlayerState,
  ServerPlayingState,
  ServerTrickPlay,
  ServerWinningBid,
} from '../src/game/serverGameTypes.js'
import type { Seat, Team } from '../src/core/serverTypes.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SERVER_ROOT = join(import.meta.dirname, '..')
const RUNBOOK_PATH = join(REPO_ROOT, 'docs', 'production-shadow-trace-runbook.md')
const SHADOW_TRACE_MODULE_PATH = join(SERVER_ROOT, 'src', 'ai', 'localAiCardShadowTrace.ts')
const LOCAL_AI_CARD_BETA_MODULE_PATH = join(SERVER_ROOT, 'src', 'ai', 'localAiCardBeta.ts')

let passed = 0
let failed = 0

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ''}`)
  }
}

// ─── 1. .gitignore safety (real git, not hand-parsed globs) ─────────────────

function isGitIgnored(relativePath: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--quiet', relativePath], { cwd: REPO_ROOT })
  // exit 0 = ignored, 1 = not ignored, other = git error (e.g. not a repo) — treat as failure either way.
  return result.status === 0
}

// ─── Small local seat/state helpers for the one live proof check (item 2) ──
// Same minimal conventions as sibling check scripts (checkLocalAiShadowTrace.ts).

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']

function card(suit: string, rank: string): ServerCard {
  return { id: `${suit}-${rank}`, suit: suit as ServerCard['suit'], rank: rank as ServerCard['rank'] }
}
function emptyScoreObj() {
  return { teamA: 0, teamB: 0 }
}
function makePlayers(): Record<Seat, ServerPlayerState> {
  const teams: Team[] = ['A', 'B', 'A', 'B']
  return Object.fromEntries(
    SEATS.map((s, i) => [s, { seat: s, team: teams[i]!, mode: 'bot' as const, controlledByBot: true }]),
  ) as Record<Seat, ServerPlayerState>
}
function emptyWon(): Record<Seat, ServerCard[][]> {
  return { bottom: [], right: [], top: [], left: [] }
}
function baseState(hands: Record<Seat, ServerCard[]>, overrides: Partial<ServerAuthoritativeGameState> = {}): ServerAuthoritativeGameState {
  const es = emptyScoreObj()
  return {
    phase: 'playing',
    phaseEnteredAt: 0,
    targetScore: 151,
    players: makePlayers(),
    round: { dealerSeat: 'bottom', cutterSeat: null, firstBidderSeat: null, firstDealSeat: null, selectedCutIndex: null },
    deck: [],
    hands,
    bidding: { entries: [], currentSeat: null, winningBid: null, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    declarations: [],
    matchDeclarationMissionCounts: {
      announce_tersa: es, announce_50: es, announce_100: es, announce_kare: es, announce_belot: es,
    },
    matchDeclarationMissionCountsBySeat: {},
    currentTrick: { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 0 },
    wonTricks: { A: [], B: [] },
    playing: null,
    scoring: null,
    matchEnded: null,
    score: { round: { tricks: es, declarations: es, belote: es, lastTen: es, capot: es, total: es }, match: { teamA: 0, teamB: 0 }, carryOver: es },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
    ...overrides,
  }
}
function makePlaying(currentTrickPlays: ServerTrickPlay[], currentTurnSeat: Seat | null): ServerPlayingState {
  return {
    hasStarted: true,
    currentTurnSeat,
    currentTrick: { leaderSeat: currentTrickPlays[0]?.seat ?? null, currentSeat: currentTurnSeat, plays: currentTrickPlays, winnerSeat: null, trickIndex: 0 },
    completedTricks: [],
    lastCompletedTrickWinnerSeat: null,
    lastCompletedTrickWinnerTeam: null,
    wonTricksBySeat: emptyWon(),
    wonTricksByTeam: { A: [], B: [] },
  }
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) previous[key] = process.env[key]
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

// ─── Console sections (printed regardless of pass/fail — operational reference) ─

const PRODUCTION_ON_FLAGS = [
  'LOCAL_AI_CARD_SHADOW_TRACE_ENABLED=true',
  'LOCAL_AI_CARD_SHADOW_TRACE_PATH=/var/www/belot-v2/training-output/local-ai-shadow/card-decisions.jsonl',
]
const PRODUCTION_OFF_FLAGS = [
  'LOCAL_AI_CARD_BETA_ENABLED=true',
  'LOCAL_AI_CARD_BETA_TRACE_ENABLED=true',
  'LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED=true',
]
const DISK_SAFETY_COMMANDS = [
  'du -h /var/www/belot-v2/training-output/local-ai-shadow/card-decisions.jsonl',
  'wc -l /var/www/belot-v2/training-output/local-ai-shadow/card-decisions.jsonl',
  'tail -n 3 /var/www/belot-v2/training-output/local-ai-shadow/card-decisions.jsonl',
]

function printOperationalNotes(): void {
  console.log('\n─────────────────────────────────────────')
  console.log('  Production operational notes')
  console.log('─────────────────────────────────────────')
  console.log('\n⚠ Do NOT enable these in production shadow mode (must stay false/unset):\n')
  for (const line of PRODUCTION_OFF_FLAGS) console.log(`  ${line}`)
  console.log('\nRecommended production shadow env (the ONLY flags to set):\n')
  for (const line of PRODUCTION_ON_FLAGS) console.log(`  ${line}`)
  console.log('\n─────────────────────────────────────────')
  console.log('  Disk safety бележки')
  console.log('─────────────────────────────────────────')
  console.log('\n⚠ Trace файлът НЯМА автоматична ротация в тази задача — ще расте неограничено,')
  console.log('  докато shadow trace остане включен. Провери периодично размера:\n')
  for (const line of DISK_SAFETY_COMMANDS) console.log(`  ${line}`)
  console.log(`\nПълен deploy/rollback checklist: docs/production-shadow-trace-runbook.md\n`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\ncheckProductionShadowTraceReadiness\n')

  // ─── 1. .gitignore safety ──────────────────────────────────────────────────
  console.log('-- 1. .gitignore safety --')
  check('training-output/ directory is git-ignored', isGitIgnored('training-output/'))
  check(
    'training-output/local-ai-shadow/card-decisions.jsonl (shadow trace path) is git-ignored',
    isGitIgnored('training-output/local-ai-shadow/card-decisions.jsonl'),
  )
  check(
    'training-recorder-audit-*.tar.gz archive pattern is git-ignored (checked via example: training-recorder-audit-2026-01-01.tar.gz)',
    isGitIgnored('training-recorder-audit-2026-01-01.tar.gz'),
  )

  // ─── 2. Env/default behavior expectations ──────────────────────────────────
  console.log('\n-- 2. Env/default behavior expectations --')
  if (!existsSync(SHADOW_TRACE_MODULE_PATH)) {
    check('server/src/ai/localAiCardShadowTrace.ts exists', false, SHADOW_TRACE_MODULE_PATH)
  } else {
    const shadowSrc = await readFile(SHADOW_TRACE_MODULE_PATH, 'utf8')
    check(
      'LOCAL_AI_CARD_SHADOW_TRACE_ENABLED default е false (само точен literal "true" го включва)',
      /process\.env\[['"]LOCAL_AI_CARD_SHADOW_TRACE_ENABLED['"]\]\?\.trim\(\)\.toLowerCase\(\)\s*===\s*['"]true['"]/.test(shadowSrc),
    )
    check(
      'LOCAL_AI_CARD_SHADOW_TRACE_PATH има безопасен default (training-output/local-ai-shadow/card-decisions.jsonl)',
      /['"]training-output['"],\s*['"]local-ai-shadow['"],\s*['"]card-decisions\.jsonl['"]/.test(shadowSrc),
    )
  }

  if (!existsSync(LOCAL_AI_CARD_BETA_MODULE_PATH)) {
    check('server/src/ai/localAiCardBeta.ts exists', false, LOCAL_AI_CARD_BETA_MODULE_PATH)
  } else {
    const betaSrc = await readFile(LOCAL_AI_CARD_BETA_MODULE_PATH, 'utf8')
    check(
      'early-return guard включва shadowTraceEnabled наравно с aiEnabled/traceEnabled (структурно независим от beta флага)',
      /!aiEnabled\s*&&\s*!traceEnabled\s*&&\s*!shadowTraceEnabled/.test(betaSrc),
    )
  }

  // Live, executable proof (not just text search): shadow trace works with
  // LOCAL_AI_CARD_BETA_ENABLED completely unset. Uses a real OS temp
  // directory — never writes into the repo's own training-output/ tree.
  await (async () => {
    const seat: Seat = 'bottom'
    const hand: ServerCard[] = [card('hearts', 'K'), card('hearts', 'Q'), card('clubs', '7')]
    const state = baseState(
      { bottom: hand, right: [], top: [], left: [] },
      {
        bidding: { entries: [], currentSeat: null, winningBid: { seat: 'bottom', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false } as ServerWinningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
        playing: makePlaying([], seat),
      },
    )
    const tempDir = await mkdtemp(join(tmpdir(), 'production-shadow-trace-readiness-'))
    try {
      const tracePath = join(tempDir, 'card-decisions.jsonl')
      let result: ServerCard | null = null
      let threw = false
      withEnv(
        {
          LOCAL_AI_CARD_BETA_ENABLED: undefined,
          LOCAL_AI_CARD_BETA_TRACE_ENABLED: undefined,
          LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED: undefined,
          LOCAL_AI_CARD_SHADOW_TRACE_ENABLED: 'true',
          LOCAL_AI_CARD_SHADOW_TRACE_PATH: tracePath,
        },
        () => {
          resetLocalAiCardBetaModelCacheForTests()
          resetLocalAiCardBetaTraceStateForTests()
          resetLocalAiCardShadowTraceStateForTests()
          try {
            result = pickServerBotPlayCardWithAiCandidate(state, seat)
          } catch {
            threw = true
          }
        },
      )
      check('LOCAL_AI_CARD_BETA_ENABLED не е нужен за shadow trace (live proof: работи с напълно unset beta флагове)', !threw && result !== null)
      check('shadow trace файл реално се създава при shadow ON + beta напълно unset (live proof)', existsSync(tracePath))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })()

  // ─── 3.+4. Trace writer / behavior safety — delegated ──────────────────────
  console.log('\n-- 3.+4. Trace writer + behavior safety (delegated to check:local-ai-shadow-trace) --')
  // Single joined command string (no args array) + shell:true — avoids the
  // Node "args are not escaped with shell:true" deprecation warning, and
  // works cross-platform (npm vs npm.cmd resolution handled by the shell).
  const shadowCheckResult = spawnSync('npm run check:local-ai-shadow-trace --silent', {
    cwd: SERVER_ROOT,
    encoding: 'utf8',
    shell: true,
  })
  const shadowCheckPassed = shadowCheckResult.status === 0
  check('npm run check:local-ai-shadow-trace минава (fail-safe writer, invalid suggestions=0, forced never fires, final card always conventional)', shadowCheckPassed)
  if (!shadowCheckPassed) {
    console.error('  --- check:local-ai-shadow-trace output ---')
    console.error(shadowCheckResult.stdout)
    console.error(shadowCheckResult.stderr)
    console.error('  --- end output ---')
  }

  // ─── 5. Runbook completeness ────────────────────────────────────────────────
  console.log('\n-- 5. Runbook completeness --')
  check('docs/production-shadow-trace-runbook.md exists', existsSync(RUNBOOK_PATH), RUNBOOK_PATH)
  if (existsSync(RUNBOOK_PATH)) {
    const runbook = await readFile(RUNBOOK_PATH, 'utf8')
    for (const flag of PRODUCTION_ON_FLAGS) {
      check(`runbook mentions ON flag: ${flag}`, runbook.includes(flag))
    }
    for (const flag of PRODUCTION_OFF_FLAGS) {
      check(`runbook mentions OFF flag (as "do not include"): ${flag}`, runbook.includes(flag))
    }
    for (const cmd of DISK_SAFETY_COMMANDS) {
      check(`runbook mentions disk-safety command: ${cmd}`, runbook.includes(cmd))
    }
    check('runbook mentions SQLite backup step', /backup/i.test(runbook))
    check('runbook mentions rollback', /rollback/i.test(runbook))
    check('runbook mentions PM2', /pm2/i.test(runbook))
    check('runbook mentions /health check', /\/health/.test(runbook))
    check('runbook mentions PRAGMA integrity_check', /PRAGMA integrity_check/.test(runbook))
    // No raw assigned secrets should ever appear in a checked-in runbook doc.
    check('runbook does NOT contain an assigned secret-looking value', !/\b(secret|token|password|api[_-]?key)\b\s*[=:]\s*["']?[A-Za-z0-9+/_-]{20,}["']?/i.test(runbook))
  }

  // ─── 6. Print operational notes (always, regardless of pass/fail) ──────────
  printOperationalNotes()

  console.log(`${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
